# 架构

> ClipboardTool 的实现地图：分层原则、线程模型、module 清单、IPC 契约。术语见 [CONTEXT.md](../CONTEXT.md)，为什么这么切见 [adr/](adr/)。

## 分层原则

**规则住在 module，效果留在 `main.rs`**（[ADR-0008](adr/0008-rules-in-modules-effects-in-main.md)）。领域判定各自收敛为一个 deep module，interface 尽量小；读写剪贴板、落盘、emit、Win32、投递主线程这些效果留在编排里，或经注入端口从 module 外部进来。加代码前先问「这是判定还是效果」。

## 线程模型（改动前必读）

死锁的成因只有一条：`tauri-plugin-global-shortcut` 的 `register`/`unregister` 内部是「投递主线程 + 阻塞等待」。谁在持有模式状态时调用它、而主线程恰好在等这把锁，就互等卡死（历史上表现为「点击复制并粘贴 → 无响应」）。防线是把状态机锁进一条线程（[ADR-0006](adr/0006-modes-on-dedicated-thread.md)）：

| 线程 | 能做什么 | 绝不能做 |
|---|---|---|
| 主线程（tauri 事件循环） | 窗口几何/样式、托盘、插件投递的落地端；读 `modes_visible` / `modes_input_active` 两个原子快照 | 阻塞等待模式状态 |
| 同步主题命令（主线程） | 读取主题偏好，或与托盘共用 `set_theme`：落盘 → WebView2 就地应用 → 重建菜单 → 广播偏好；不等待模式回执 | 调热键 register/unregister、阻塞等待模式状态 |
| `modes-executor` | 唯一持有 `PanelModes`、效果宿主 `Host` 与热键双向表 `Hotkeys`；唯一允许调用热键 register/unregister | 把 `&mut PanelModes` 或 `&mut Hotkeys` 交出去（前者类型私有、后者只经 `Modes` 具名操作间接使用） |
| 命令线程（tokio worker，`async #[tauri::command]`） | 向 `Modes` 投递具名操作并 `.await` 回执；跑慢的 Win32 粘贴注入 | 持有 store 锁的同时 await 模式回执 |
| 回调线程（热键 / 鼠标钩子 / 托盘 / 单实例 / 窗口事件） | 向 `Modes` 投递具名操作，**不等待**（忽略返回值不影响投递） | 阻塞：回调必须立即返回 |
| 单实例迟到线程（一次性，最多等 5 秒） | 第二实例若赶在 `setup` 的 `manage(AppState)` **之前**到，等状态挂上再呼出（`summon-req src=instance waited=<ms>`） | 直接 `app.state::<AppState>()`——那一刻它还不存在，会 panic 把进程带走（真机复现过，见 pitfalls 第 6 节） |
| 方向键重复线程 | `Up` / `Down` 按住期间按定时器重复投递 `on_hotkey_repeated`；只读 `modes_visible`，面板隐藏后停止 | 持有模式状态、等待模式回执 |
| 热身停靠线程（一次性，睡 120ms） | 到点投递 `park_after_warmup`，由执行线程判「这 120ms 里有没有人呼出过」再决定停不停靠、并按序留一条 `warmup` 读数 | 自己直接动窗口（几何一律经 `panel_window` 投主线程，且要与呼出排同一个序） |
| 投递重投线程（`panel_window::dispatch` 失败时起，短命） | 主线程队列满导致投递失败后，每 50ms 重投同一个效果，最多 10 次；成功/用尽各留一条 vital 读数 | 重放会盖掉新意图的旧效果（判定交给几何效果代数：重投进主线程后仍要过 `superseded`） |
| 剪贴板监听线程 | 等系统通知（`GetMessageW` 阻塞，收到 `WM_CLIPBOARDUPDATE` 才读）、判定新复制、写盘广播；单次异常经 `catch_unwind` 只跳过本轮；事件源起不来时退回 600ms 轮询 | 被任何模式锁拖住 |

两条附带约束：窗口几何与样式变更必须投递主线程执行（这条现在由 `panel_window.rs` 的实现内部承担，调用方只管动作）；`store` 锁与模式状态绝不交叉持有。

第三条：**几何效果有先后**。窗口几何/可见性这四类效果（`show_at_cursor` / `park_offscreen` / `set_position` / `show`）各自带一个递增序号，落地前发现已有更新的同类效果就丢弃自己——重投让旧效果可能晚到，而「迟到的旧意图盖掉新意图」的伤害正是最难收拾的那种（呼出重投迟到 → 状态机已收起、面板却显形，那块孤儿面板连「点外面收起」都不生效）。

## Rust module 地图

`tauri/src-tauri/src/`。单测例数与 `cargo test --list` 对齐。

| module | 职责（唯一归属） | interface | 单测 |
|---|---|---|---|
| `main.rs` | 效果编排：持久化与广播、IPC 注册、`AppState`、诊断的两档出口（`diag_vital` 无条件写 / `diag_log` 门禁后写，同写 `diag.log`，见 [ADR-0013](adr/0013-vital-readings-on-boot-path.md)） | — | — |
| `history.rs` | 条目身份、去重提升、置顶块插入、裁剪豁免、备注归一化 | `new(max, Ports, Clock)` + `record_text` `record_image` `promote` `toggle_pin` `remove` `clear` `set_note` `load` `to_json` `find` `entries` | 15 |
| `panel_modes.rs` | 面板四态状态机 + 该注册哪些键的推导与差量指令（纯逻辑，不依赖 tauri / Win32）。三个输入态共用一对 `enter_input` / `exit_input`，各态差异是 `Mode` 上的四条纯判定（`enter_event` `exit_event` `needs_focus` `requires_visible_panel`）；已生效集合不在本 module，差量的另一侧读 `host.current_keys()` | `show` `hide` `on_nav_action` `enter_input` `exit_input` `set_composing` `try_set_toggle_shortcut` `set_toggle_shortcut` `ensure_focus_target` `restore_original_focus` `focus_target_snapshot` `state` `is_panel_visible`；纯判定 `is_repeatable_navigation` `hides_on_click`（点击早于最近一次呼出就不算「点了面板外」）；seam `ModesHost`（`register_key` `unregister_key` `current_keys` + 面板/渲染层/焦点/领域查询） | 16 |
| `hotkeys.rs` | 「现在哪些全局键生效」的唯一真源：accel ↔ Shortcut 双向表 + 动作，两个方向都是 O(1)；注册三步（查重 / 调插件 / 记账）原子，插件拒绝一分不记；accel → 展示文案 | `register` `unregister` `action_of` `accel_of` `bindings`；纯函数 `format_shortcut`；插件调用经端口传入 | 9 |
| `modes.rs` | 状态机的唯一入口：独占执行线程 + 具名操作 + 效果宿主（持有 `Hotkeys`、方向键连发登记与**最近一次呼出的时刻**——这个时刻有三处用途：与点击时刻比出「把面板开出来那一下」、给 `summon-run latency_ms=` 当基准、以及让热身停靠给已经发生的呼出让位） | `spawn` + 17 个具名操作（见下） | — |
| `diag.rs` | 诊断日志的轮转判定：`diag.log` 超过上限就把旧文件挪成 `diag.log.1`（vital 行是常驻写入，不封顶即无界增长） | 纯判定 `should_rotate` | 1 |
| `panel_window.rs` | 面板几何、焦点、鼠标穿透与「上不上任务栏」；呼出修复协议经私有 `LandingPort` 执行（说明见下）；主线程投递、DIP 换算与**几何效果代数**（`GEOM_SEQ`：迟到的旧效果自己作废）。尺寸非常量：每次呼出按光标所在显示器算（`sized`：高 = 屏幕 DIP 高的 7/8、宽 = 高的一半——DPI 无关性由 DIP 空间公式保证，4K@2x 与 1080p@1x 同尺寸）。**改窗口之前先过 `dispatch`**：投递主线程失败不再静默（记 vital 读数 + 重投），从前八处 `let _ = run_on_main_thread(..)` 是「按了没反应」的无声出口；取不到窗口一律经 `window_or_log` 留痕 | `show_at_cursor`（按「光标所在 → 窗口所在 → 主屏」三级取显示器，重算 `set_size` + `set_position`，**再回读 OS 真值判落位**：不可见由 `make_visible` 自己兜底、没生效就重设、意图本身在屏外就按**主屏自己的工作区与缩放**重算并据新值重判，结论写 vital 行 `summon-landed first= final= repair= scale= intent= actual=`；三级都取不到时留 `summon-no-monitor` / `summon-no-primary`）、`park_offscreen` `log_geometry` `focus` `release_focus` `set_mouse_passthrough` `hit_test` `exists` `set_icon` `set_position` `show`（热身用，与 `show_at_cursor` 共用 module 内的 `make_visible`：`win.show()` **之后**清掉 tao 强加的 `WS_EX_APPWINDOW`、挂 `WS_EX_TOOLWINDOW` 并补一次 `set_skip_taskbar`，幂等，手顺理由见 pitfalls 第 3 节；**自己读回 `IsWindowVisible` 确认**，没生效就退回 Win32 `ShowWindow(SW_SHOWNOACTIVATE)`，两层都不成留 `make-visible failed`）；纯判定 `sized` `centered` `parked` `contains_point` `landing_verdict` `superseded` | 15 |
| `poll_baseline.rs` | 「这次剪贴板内容算不算一次新复制」+ 欠着的一轮（读不可信 / 写盘失败）的标记 | `observe` `confirm` `skip_unchanged` `note_seq` `note_untrusted` `retry_pending` `sync_now` | 9 |
| `dib.rs` | 剪贴板 DIB 字节 → PNG 的解码判定：32/24bpp、位域掩码、行序、`BI_PNG` 透传 | `to_png` | 7 |
| `clipboard.rs` | 剪贴板独占窗口的唯一归属：`OpenClipboard` 小步重试、`CF_DIBV5`→`CF_DIB` 退让、`Drop` 必关、取字节即释放守卫（解码在剪贴板之外）、arboard 文字读写、序列号；「读不到」与「剪贴板里就是没内容」在这里分开 | `read()` → `ReadOutcome{Known(Snapshot), Occupied}`、`write_text`、`write_image_file`、`sequence`；纯判定 `occupied`（`ClipboardGuard`、`DibBytes` / `ImageRead` 与格式常量在 module 内部） | 1 |
| `clipboard_events.rs` | 剪贴板变化的事件源：建 `HWND_MESSAGE` 消息窗、注册格式监听、阻塞等 `WM_CLIPBOARDUPDATE`；没搞定的一轮用 `SetTimer` 显式排重试（纯事件下没有「下一轮」可等） | `run(on_change)`（消息窗建不起来 / 注册不上时返回 Err，调用方据此退回轮询兜底） | — |
| `paste_chain.rs` | 复制并粘贴链路的顺序与结果文案；失败文案的唯一映射处 | `run(&mut port, id)` + `PastePort`（7 个效果）+ `focus_error_message` | 9 |
| `startup.rs` | 静默启动通道的三态判定、意图/事实分离、「拉起→退出」舞步 | `channel` `apply_intent` `set_auto_start` `relaunch_via_task` `relaunch_if_not_elevated` `current_exe_path`（通道决策 `decide` 与 `sync_fact` 在 module 内部，任务注册经参数注入） | 6 |
| `settings.rs` | `settings.json` 的读写与 camelCase 键名契约、坏档兜底。`Theme` 三态枚举（`system`/`light`/`dark`）也住这里：默认 System，缺键与非法值统一回落，中文名 `label()` | `load` `save` `parse` `Settings::default`；`Theme` 与纯判定 `parse_theme` | 9 |
| `focus_paste.rs` | 进程内 Win32 的焦点快照与恢复 + `Ctrl+V` 注入 | `snapshot` `restore_and_paste`（失败带 `RestoreFailure{stage,reason}`） | — |
| `source_app.rs` | 前台应用信息与图标提取（`SHGetFileInfo` / `ExtractAssociatedIconW`） | `get_foreground_app_info` | — |
| `click_watcher.rs` | `WH_MOUSE_LL` 全局点击钩子：上报坐标**与该次按下的时刻**（时刻必须在钩子里取，见 `hides_on_click` 的成因） | `ClickWatcher::start` `stop` | — |
| `tasks.rs` | 计划任务注册脚本与提权事实查询 | `ps_register_task` `run_elevated_task` `task_exists` `is_elevated` | — |
| `tray.rs` | 托盘：图标尺寸阶梯、明暗来源、去重键、菜单文案、「哪一发事件算呼出」的判定 + 图标与菜单落地（HUD 迁移后菜单含「清空历史」——直调 `store.clear()` + `commit()`，不走 IPC；主题子菜单三项走 `CheckMenuItem`，当前态写进子菜单标题。图标亮暗判的是**任务栏主题**：直读注册表 `SystemUsesLightTheme`（缺键才退 `AppsUseLightTheme`），与面板的主题偏好、也与 tao 那份窗口主题缓存都不同源——后者只在建窗时算一次，之后靠 `WM_SETTINGCHANGE` 广播刷新，开机那次读到的是旧值） | `Tray::create` `Tray::sync_icon` `Tray::rebuild_menu`；纯判定 `size_for_scale` `icon_key` `taskbar_is_dark` `opens_panel` `pointer_entered` `menu_labels` `theme_items` `theme_of_menu_id` | 9 |
| `webview_theme.rs` | 主题偏好的落地出口：三态 → WebView2 常量，并经 `ICoreWebView2_13::Profile` 写进去——改的是**网页的 `prefers-color-scheme`**，不是窗口边框（tauri 的 `set_theme` 在 Windows 上只到 tao 的 DWM 属性，用它面板皮肤不动）。cast 失败（Runtime < 109）只写 stderr，后果是继续跟随系统 | 纯判定 `scheme_of`；效果 `apply` | 1 |

`clipboard_probe.rs` 不在上表：它只在 `#[cfg(test)]` 下编译、没有对外 interface、也不被任何生产代码调用。它是「600ms 轮询要不要换成 `AddClipboardFormatListener`」那个决策的真机量具（结论见 [ADR-0011](adr/0011-clipboard-watch-via-events.md)）——只读不写，量三件事：提权进程收不收得到 `WM_CLIPBOARDUPDATE`、通知到「能打开剪贴板」的等待、一次复制产生几条通知（判据是**序列号增量**而非时间间隔：一次完整复制让序列号前进「格式数 + 1」次）。跑法见 README「待真机验证」。

`history.rs` 的写图 / 哈希 / 删图 / 判存在（`Ports`，四条全部必供，缺一个编译不过）与时间 / 生成 id（`Clock`，有默认值）、`panel_modes.rs` 的全部效果、`paste_chain.rs` 的全部效果、`startup.rs` 的任务注册、`hotkeys.rs` 的插件调用都是注入端口，所以生产实现与测试假实现各一份，seam 才成立。端口一律不做成 `Option`：可选端口等于把「漏配」变成一条静默降级的路径，而不是编译错误。

`panel_window` 的 `land_panel` 与私有 `LandingPort` 构成内部 seam：生产 adapter 只在 `dispatch` 的主线程闭包里构造，执行几何写入、显形、OS 真值回读、主屏查询与 vital 读数；测试 adapter 回放整条修复协议。首次与最终各回读一次，最终判定和日志的 `actual` 共用同一份快照；公开动作 interface 保持由 `PanelWindow` 提供。

**模式操作**（`modes.rs` 的 17 个具名方法）：`show` `hide` `park_after_warmup` `hide_after_paste` `on_hotkey_pressed` `on_hotkey_repeated` `on_hotkey_released` `hide_if_clicked_outside` `set_toggle_shortcut` `begin_search` `set_composing` `end_note_edit` `begin_shortcut_capture` `cancel_shortcut_capture` `try_set_toggle_shortcut` `restore_original_focus` `focus_target`。新增模式操作在这里加方法，不要在调用方拼闭包。热键回调交出的是插件的 `Shortcut`，不是 accel 字符串——「这是哪个动作」由执行线程查 `Hotkeys` 判，主线程不再持有那份表。备注编辑态没有自己的具名操作：它是 `NavAction::Note` 落进 `PanelModes::on_nav_action` 后调 `enter_input(NoteEdit)`，调用方仍是 `on_hotkey_pressed` 那一条。

## 渲染层地图

`tauri/src/` 与 `tauri/tests/`。HUD 迁移（2026-09-08）后界面是 ClipFlow 单列表形态：搜索头 / 卡片列表 / 快捷键页脚，标题栏与详情面板退役。

| 文件 | 职责 | 测试 |
|---|---|---|
| `panelView.ts` | 渲染层视图判定：搜索过滤、命中高亮片段、选中项落位、圆角外穿透几何、相对时间五档（刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前）、按键码映射、滚动条 thumb 几何、主题按钮的三态循环与展示。来源配色档位随旧界面退役；滚动条几何因「原生条在真机占布局宽度、破坏卡片左右对称」回归 | `filterEntries` `highlight` `spansToText` `clampIndex` `moveIndex` `entryAt` `shouldIgnoreMouse` `formatTime` `accelKeyFromCode` `scrollbarThumb` `themeControl`；32 例 plain node |
| `keyboard.ts` | 键盘注册表的判定侧：`NAV_KEYS`（Rust `NAV_SHORTCUTS` 的渲染层镜像）、accel ↔ keyId 归一、`combo()` 平台化显示、`buildBindings` / `footerChips`（页脚 chip 的唯一数据源）。分发住在 `useKeyboard`，键值一致性由跨语言对表钉住 | accel 归一 / combo / chipLabel / 注册表 / 页脚 6 例 + 对表 1 例 |
| `pendingDeletion.ts` | 延迟删除的生命周期判定：条目各自处于可撤销或提交中；输入删除、撤销、截止与提交回执，输出新状态与效果指令。timer、toast 与 IPC 仍由 App 执行，行为契约见 [README「操作」](../README.md#操作) | `transitionDeletion`；5 例 plain node |
| `themeSync.ts` | 主题偏好的同步状态：当前偏好、读取代次与切换互斥；较新的读取、变更事件或退出使旧读取失效。生效主题由 App 按媒体查询落地，监听注册竞态仍归 `api.ts` | `ThemeSynchronizer` 的快照、读取接收、变更接收与切换操作；5 例 plain node |
| `useKeyboard.ts` | 渲染层唯一按键入口：`panel:key` 动作名 → 注册表处理函数的单点分发（ref 转发，不重订阅）。面板导航键由 Rust 全局拦截（浏览态窗口不持焦点），渲染层没有 keydown 监听——快捷键捕获覆盖层是唯一的例外，那是录入键值的编辑器行为 | — |
| `clipStore.ts` | ClipStore 契约适配层：`RendererEntry` → `ClipItem` 投影 + `createClipStore`（query / total / getNote 只读视图）。组件不碰 invoke；copy / remove 等效果留在 App 接线（ADR-0008） | — |
| `api.ts` | `window.clipboardAPI` 的 invoke / listen 适配层；同一 channel 重复注册时先解绑旧的（generation 计数防 useEffect 竞态） | — |
| `App.tsx` | 视图状态与效果接线：主题读取 / 订阅 / 切换交给 `themeSync` 判定，延迟删除按 `pendingDeletion` 的效果指令接 timer / toast / IPC；读事件 → 调规则 module → 画出来或 `invoke`。生效主题仍只认媒体查询；穿透半径由 `getComputedStyle` 从 `.desktop` 读出后作参数传入 | 由导航、主题与删除的 Playwright 回归守 |
| `SearchHeader.tsx` / `ClipCard.tsx` / `ToastStack.tsx` / `icons.tsx` | HUD 组件：60px 搜索头（焦点环在井上）、text/image 两态卡片（内容在上、meta 行在下，2026-09-11 改版；类型标识已删）+ meta 行内联备注、aria-live toast 栈（含撤销动作）、SVG 图标精灵（outline 系、24-grid、stroke 1.75，主题按钮补太阳 / 月亮 / 显示器同族图标，其余源 UI 搬运；i-text/i-image 随类型标识退役，i-copy 随卡片右上角的「复制」胶囊退役） | — |
| `theme.css` | ClipFlow 设计 token 的唯一落地（`:root` 暗色 + `html[data-theme="light"]` 覆盖块，源样式的 token 块原样搬运），见 [design-system.md](design-system.md) | — |
| `styles.css` | HUD 组件样式（选择器语义与数值照搬源 UI；例外是卡片内部次序——meta 行由内容上方移到下方，2026-09-11）+ 透明窗口壳层（`.desktop` 圆角裁切与 1 CSS px 一律留边、`.app-window` 2px 中灰实线描边 `--window-ring`——壳层机制原样保留，描边强度与留边契约 2026-09-08 两次返修）。列表顶部 `scroll-padding` 与内边距同源；渐隐遮罩退役，滚动条为自绘 4px 细条（原生条隐藏——它在真机占布局宽度，会把卡片右缘到边框垫得比左缘宽）。窗口圆角单一真源 `--radius-window` = 36px；内部圆角按面点名不共用——复制项 `--radius-card` 12px、搜索井 `--radius-pill`（36px 高钳成 18px 的胶囊）、空态图标与覆盖层卡片仍 `--radius-md` 10px | — |
| `tests/panel-harness.js` | 浏览器用例共用的 mock Tauri bridge（可控主题读取回执、变更事件与删除命令结果）与 `FADE_INSET` 常量（现值 12 = 列表 scroll-padding） | — |
| `tests/navigation-visual-regression.spec.js` | 驱动真实渲染层，回归高频方向键导航的选中框跟随（几何类动画计数口径） | 1 例 Playwright |
| `tests/theme-toggle.spec.js` | 回归主题按钮三态循环不进入搜索、已存偏好与外部同步、迟到初读与逆序呼出补读、生效主题仍认媒体查询、搜索焦点保留与失败重试（真实 WebView2 与重启存档仍需人工验证） | 5 例 Playwright |
| `tests/deletion-undo.spec.js` | 驱动真实渲染层与可控时钟，回归撤销阻止提交、跨呼出继续计时、命令返回失败与异常时的恢复和错误提示 | 4 例 Playwright |
| `tests/first-item-top-clip.spec.js` | 回归滚到列表首尾时选中项不被裁掉（顶部 scroll-padding 留白、底部对齐滚动口为设计内） | 2 例 Playwright |
| `tests/window-ring-width.spec.js` | 截图解码后纯像素扫描量窗口描边四边的表观宽度（预乘红积分，`getBoundingClientRect` 给不出来的信息） | 3 例 Playwright |
| `tests/note-input-ring.spec.js` | 回归备注内联编辑：按 B 前后卡片几何逐条相等（输入框与 meta 行等高，2026-09-11 返修「按 B 复制项大小会改变」）、焦点环只有一圈（全局 `:focus-visible` outline 让位）、环完整不被 meta 行裁断且不出卡片边框（meta 行 2026-09-11 搬到内容下方，裁切契约不变） | 3 例 Playwright |

## IPC 契约

命令（`invoke`，参数 camelCase）：

| 命令 | 作用 | 返回 |
|---|---|---|
| `clipboard_get` | 全量历史 | `RendererEntry[]` |
| `clipboard_copy` | 复制并粘贴（键盘 Enter / 双击卡片共用；卡片右上角的「复制」按钮 2026-09-11 已删） | `{ ok, message }` |
| `clipboard_remove` / `clipboard_pin` | 删除 / 置顶切换 | `bool` |
| `note_set` / `note_end_edit` | 写备注 / 退出备注编辑态 | `bool` |
| `shortcut_try` / `shortcut_cancel` | 试设呼出键 / 取消捕获 | `{ ok, formatted }` / `bool` |
| `search_activate` / `search_set_composing` | 进入搜索态 / 同步 IME 组合状态 | `bool` |
| `theme_get` / `theme_set` | 读取 / 设置主题偏好；设置参数 `{ theme }` 只认 `light` / `dark` / `system`，与托盘共用落地入口 | 三态字符串 / — |
| `window_hide` / `window_set_ignore_mouse` | 隐藏面板 / 切换鼠标穿透 | `bool` |

> 「清空历史」与「进入备注编辑态」**没有命令**，各自只有一个入口：前者由托盘菜单回调直调 `store.clear()` + `commit()`，后者由面板 `B` 键在 `panel_modes.rs` 状态机内消化、转投 `note-edit-enter` 事件。两条都曾有过同名命令（`clipboard_clear` / `note_begin_edit`），因零调用方在 2026-09-10 的冗余清理中删除——别照旧文档再把命令加回来。
>
> 主题按钮展示主进程偏好，`theme_get` 取初值、`theme:changed` 同步托盘变更；渲染层先等监听就绪再读取，用递增读序号丢弃迟到的旧读取。生效主题仍只认媒体查询，见 [ADR-0012 的面板入口补充](adr/0012-theme-preference-in-main-process.md)。

事件（Rust → 渲染层，全部经 `emit_panel` 这一个出口，窗口不存在时静默丢弃）：

| 事件 | 载荷 | 作用 |
|---|---|---|
| `clipboard:updated` | `RendererEntry[]` | 历史变更广播 |
| `theme:changed` | `light` / `dark` / `system` | 两个入口共用 `set_theme`，WebView2 就地应用后广播；刷新按钮偏好并按媒体查询重刷生效主题 |
| `panel:key` | `{ action, noteEntryId }` | 面板显示期间被全局拦截的按键动作 |
| `panel:shown` | — | 呼出完成，渲染层重置搜索与选中态 |
| `panel:focus-error` | `{ stage, reason, message }` | 焦点恢复或注入失败；`message` 与 `CopyResult.message` 同源 |
| `shortcut:capture-start` / `shortcut:capture-end` | `{ current }` / — | 快捷键捕获覆盖层的开关 |

## 数据流

Rust 侧是唯一真相。一次变更 = `store` 方法 + `commit()`，而 `commit()` = `persist()`（写 `clipboard-history.json`）+ `broadcast()`（图片条目转 dataUrl 后 emit `clipboard:updated`）。渲染层不直接改数组，只发命令、听事件。图片落盘 `images/`，dataUrl 按 `imagePath` 永久缓存（文件创建后内容不变），删除/裁剪时经注入端口同步失效。

剪贴板监听线程阻塞在 `GetMessageW` 上等系统通知，收到 `WM_CLIPBOARDUPDATE` 才跑一轮（[ADR-0011](adr/0011-clipboard-watch-via-events.md)）；每轮仍先用 `GetClipboardSequenceNumber` 短路——序列号没动就不打开剪贴板，也就不必先读图片再编码 PNG，顺带挡住「同一内容收到两次通知」。事件源起不来时退回 600ms 轮询（`poll_fallback`），最坏情况只是慢。

图片不走 arboard 的 `get_image`：那条路在「`BI_BITFIELDS` + V4/V5 头」上必挂（[ADR-0009](adr/0009-clipboard-image-decoded-in-house.md)）。轮询先用 Win32 自己取 `CF_DIBV5`（退回 `CF_DIB`）的原始字节交给 `dib` 解，文字仍用 arboard；两者各自独占剪贴板，先后取、不重叠持有；取字节一结束就释放守卫（`CloseClipboard`），解码在剪贴板之外进行——独占窗口若拉长到几十毫秒，正好会撞上用户刚按下 `Ctrl+C` 的时刻。这一整段时序住在 `clipboard.rs::read()` 一处：启动基线与轮询过去各写一遍、对 arboard 打开失败的处理还不一致（一处 trace + return、一处静默 return），现在两条链路共用同一个 `read()`。它返回 `ReadOutcome`：`Known` 是「剪贴板状态已知」（可以既没有位图也没有文字），`Occupied` 是「剪贴板被别的程序占着、这次读取不可信」——后者基线一律不动、序列号不推进，靠重试再来一次；把两者混为一谈会让「打不开」被当成「剪贴板是空的」，那次复制就此永久消失（[ADR-0011](adr/0011-clipboard-watch-via-events.md)）。

## 待真机复核

五条结论只能靠真机拿到，读代码不算验证（完整清单见 [README.md](../README.md) 「待真机验证」）：

- **托盘图标清晰度**：按主屏 `scaleFactor` 取恰好物理尺寸的图 1:1 渲染，但最终 HICON 由 tray-icon 的生成路径决定，非整数缩放下是否仍糊必须眼看。
- **开机那一次的三路呼出**：`Ctrl+Shift+V`、托盘菜单「显示剪贴板面板」、托盘图标左键——只有开机自启那次全哑，退出重开就好（2026-09-20 用户口径；2026-09-27 复现一次仍是三路全哑、进程健康、托盘正常，详见 [changelog](changelog.md)）。2026-09-20 那轮把「静默 return」换成兜底与日志，2026-09-27 那轮把读数改成**无条件写**（`vital pid=` 行，[ADR-0013](adr/0013-vital-readings-on-boot-path.md)）并给呼出加了回读验证：登录后先别重开应用，按顺序看 `diag.log`（先按 `pid=` 分组，两份实例的读数是交错写的）——`summon-req` 有而 `summon-run` 没有 = 执行线程没接手；`summon-no-*` = 已经到主线程、只是缺前提（`missing-window` / `no-cursor` / `no-monitor` / `no-primary`），**不**等于主线程没跑；`summon-run` 有而 `summon-landed` 没有 = 那一次被判给更新的几何效果（丢弃只进 verbose 档），也不是主线程没跑；`summon-landed final=Hidden/Moved/Offscreen` = 窗口没落地（后面跟着 `repair=`）；`renderer=never` = 网页没起来（窗口落地了也是白的）；`emit-failed` = 窗口落地了但事件送不出去。六条各是一种处置，**别跳过读数去猜**；探针 `tauri/scripts/panel-state.ps1` 的头里写着同一套分流。
- **托盘图标的明暗**：判定改成直读任务栏主题（`SystemUsesLightTheme`）后，要在「个性化 → 颜色 → 选择默认模式 = 自定义」下把 Windows 与应用两套设成相反色，看图标跟的是前者；再在运行中翻系统主题，看悬停一次图标（`Enter` 那次核配色）能不能补上——那条就是为「广播收不到」准备的兜底。
- **浏览态不抢焦点**：靠 `focusable: true` 加焦点事件自动 `SetFocus(NULL)` 模拟，首帧激活次序需眼看。
- **截图进历史**：`dib` 的解码覆盖面全部有单测钉住，但「某个截图工具到底写哪种 DIB 形状」只能真机看；断点定位用 `真机探针` 那条 `#[ignore]` 测试。
