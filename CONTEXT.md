# ClipboardTool 项目上下文

> 本文档是工程的「共享词汇 + 决策档案」。项目本身见 [README.md](README.md)。

## 项目概述

Windows 剪贴板历史工具（Tauri 2 + React 19 + Rust，原 Electron 实现已于 2026-08-31 删除）。主进程轮询剪贴板（600ms），把文字/图片历史存入 `%APPDATA%\ClipboardTool\clipboard-history.json`；渲染进程只负责面板 UI 与键盘导航。全局快捷键 `Ctrl+Shift+V` 呼出不可激活（WS_EX_NOACTIVATE）的置顶浮层面板，不抢占输入框焦点。


## 设计系统 — Apple (Espana) Cathedral

> Cathedral of white space with whispered headlines. A vast pale hall where massive weight-700 type hangs in the air, tethered only by pastel product colors and a single blue thread.

本项目 UI 采用 Apple (Espana) 产品页语言的桌面化移植：

**Tokens（已落地到 src/styles.css :root）**
| 语义 | 值 | 用途 |
|------|-----|------|
| Primary Ink | #1d1d1f | 主文本、标题、强对比前景 |
| Mid Gray | #707070 | 次要文本、禁用占位 |
| Deep Gray | #474747 | 导航、工具按钮默认 |
| Hairline | #d6d6d6 | 唯一允许的边框（毛细线，分区不用实线） |
| Canvas | #f5f5f7 | 窗口画布灰带，与 Paper 交替形成节奏 |
| Paper | #ffffff | 卡片、白底、输入框 |
| Cool Wash | #e8e8ed | 悬浮洗色、hover 底 |
| Faded Surface | #fafafc | 抬升面板、导航毛玻璃 |
| Quiet Dot | #777779 | 分页点、微弱指示 |
| Electric Blue | #0071e3 | 唯一彩色 CTA 实心胶囊按钮 |
| Link Blue | #0066cc | 行内链接/高亮 |
| Ember | #b64400 | 新品/警示点缀 |
|  pastel finishes | Sky #c8d8e0 / Citrus #dddc8c / Starlight #f0e4d3 / Silver #e3e4e5 / Blush #e8d0d0 / Indigo #596680 / Midnight #2e3642 | 图标与插画的唯一彩色来源（来源应用色板） |

**排版**
- SF Pro Display 600/700 作标题（tracking -1.44px at 96px, -0.28px at 56px, +0.007em at 28px）
- SF Pro Text 400 作正文 13px（tracking -0.08px）、微文案 11-12px（tracking -0.04em~0.04em），`font-feature-settings: "numr" 1` 保持数位等宽
- 行高：Display 1.04–1.07 正本 1.45 形成层次，无需字号跳变

**间距与圆角**
- 基准 4px，密度 comfortable；卡片 16px（小密度）/ 28px（大卡），按钮 980px/999px 胶囊，输入 12px，窗口 20px
- Section 间距由 Canvas/Paper 交替完成，不用分割线或阴影

**组件映射（clipboard-tool 落地）**
- 全局窗：Canvas 半透明毛玻璃（blur 28px saturate 180%），Paper 卡片无边无影，靠画布交替区分
- 标题栏：44px 导航条，Faded Surface 毛玻璃（blur 20px）
- 搜索框：Paper 底 + Hairline，聚焦时 Electric Blue 0.14 4px 环
- 列表卡：Paper 底，默认 transparent 边，悬停 Faded Surface，选中 Electric Blue 6% + 1px 18% 内描边，深色模式对应 #2c2c2e/#3a3a3c
- 来源图标：按 appName 映射 pastel finish（notes/figma/safari 等），作唯一彩色载体，UI 其余保持单色
- 底部快捷条：Canvas 毛玻璃 + kbd 白底 Hairline 胶囊，Quiet Dot 标注
- 按钮：实心胶囊仅 Electric Blue 一处，其余 Ghost 胶囊（transparent + Hairline），Do: 单区最多一枚实心 CTA

**Do / DonDont 执行**
- Do: 交替 #ffffff/#f5f5f7 形成节奏、28px/16px 圆角、980px 胶囊、17px 级跟踪 -0.022em、numr 数字
- Dont: 无阴影（仅选中 1px 内描边）、无彩色点缀（除 Electric/Link Blue 与产品图）、标题不小于 12px 感知、不用实线分割、圆角不小于 8px、UI 面无渐变、字重不低于 400/600、链接无底盒、段落不居中

## 领域词汇

| 术语 | 含义 |
| --- | --- |
| 历史条目（ClipboardEntry） | 一条剪贴板记录，`text` 或 `image` 类型；主进程内存中额外持有 `imagePath`，渲染层收到的是 `dataUrl` |
| 条目身份（entry identity） | "是否同一项"只由内容决定：文字按文本逐字符相等、图片按 PNG 内容哈希相等；备注/来源应用/置顶/创建时间均为属性，不参与同一性判定 |
| 历史（history） | 主进程内存数组，顺序即面板显示顺序；最新使用在最前 |
| 置顶（pinned） | 条目上的布尔标记；置顶条目固定排在列表最前，重启后保留 |
| 置顶时间（pinnedAt） | 最近一次置顶的时间戳（毫秒）；未置顶为 0，多个置顶条目按它新→旧排序 |
| 置顶块 | 列表头部所有置顶条目形成的连续块；新复制内容永远插在它之后 |
| 普通块 | 置顶块之后的普通条目，按最近使用（复制/新建）新→旧排列 |
| 来源应用（SourceApp） | 复制时前台应用（exePath / appName / windowTitle / iconDataUrl），轮询 A 版方案 |
| 备注（note） | 用户附加到历史条目的可选单行文本；独立于剪贴板正文和来源应用（不参与条目身份判定），空字符串表示没有备注，随条目持久化 |
| 常驻提权 | 应用始终以高完整性运行（exe 清单 requireAdministrator）；UIPI 不拦截其热键与输入注入，管理员目标窗口照常工作 |
| 静默启动通道（计划任务） | `ClipboardToolElevated`（/rl highest）：快捷方式经 `tasks::run_elevated_task` 拉起时直接以管理员令牌创建进程，不弹 UAC；开机启动 = 其 onlogon 触发器 |
| 开机启动意图（autoStart） | settings.json 持久化的用户意图；运行时事实（任务触发器是否存在）每次由开关操作重建 |
| 焦点快照（focusTarget） | 呼出面板前记录的前台窗口/焦点控件/进程/线程组合，用于搜索或备注编辑结束后恢复原输入框 |
| 焦点粘贴（focus_paste） | 进程内 Win32 调用（GetForegroundWindow / SetForegroundWindow / SetFocus / SendInput），无辅助进程；`snapshot()` 记快照，`restore_and_paste(target, paste)` 恢复并注入 Ctrl+V，失败带 `RestoreFailure{stage,reason}` |
| 面板键捕获通道 | 面板显示期间拦截 ↑↓/Enter/Esc/Del/Z/空格 的机制：主进程 globalShortcut（RegisterHotKey），提权后对所有完整性窗口生效 |
| 搜索模式（searchActive） | 面板的输入态：常驻搜索框由灰色禁用变为可编辑，窗口临时可聚焦以支持文字输入（含中文 IME）；Space/Z/Del 让位给输入框，↑↓/Enter/Esc 保持面板语义 |
| 历史核心（history） | 纯内存模块 `src-tauri/src/history.rs`：条目身份、去重提升、置顶块插入、裁剪豁免、备注归一化的唯一实现；文件系统效果（写图 / 哈希 / 删图 / 时间 / 生成 id）经 `HistoryStoreBuilder` 的注入端口进入，持久化与 broadcast 留在 `main.rs` |
| 面板模式状态机（panel_modes） | 纯逻辑模块 `src-tauri/src/panel_modes.rs`：浏览/搜索（含 IME 组合子态）/备注编辑/快捷键捕获四态；呼出键与导航键的全局热键集合由当前模式推导并差量注册；焦点快照生命周期归它管理。效果经 `ModesHost` trait 注入，不依赖 tauri / Win32 |
| 模式入口（Modes） | `src-tauri/src/modes.rs`：状态机的唯一入口。独占一条 `modes-executor` 线程持有 `PanelModes`，外部只能投递 15 个具名操作（`show` / `hide` / `hide_after_paste` / `dispatch_accel` / `hide_if_clicked_outside` / …），拿不到 `&mut PanelModes`；效果宿主 `Host` 为 module 私有 |
| 无锁快照（modes_visible / modes_input_active） | 执行线程每次模式操作后刷新的两个 `AtomicBool`，供主线程（鼠标钩子回调、窗口事件）只读判断「面板是否可见 / 是否处于输入态」，绝不阻塞在模式上 |
| 面板窗口（PanelWindow） | `src-tauri/src/panel_window.rs`：浮层面板几何、焦点、鼠标穿透的唯一归属。`show_at_cursor` / `park_offscreen` / `focus` / `release_focus` / `set_mouse_passthrough` / `hit_test`；「必须投递主线程」与「物理像素 vs DIP」全在实现内部 |
| 轮询基线（PollBaseline） | `src-tauri/src/poll_baseline.rs`：「这次剪贴板内容算不算一次新复制」的唯一实现。`observe`→`Change` 判定与暂存分离，`confirm(ok)` 决定基线是否推进并置重试标志，`sync_now` 用于自己刚写入后的认账 |
| 复制并粘贴链路（paste_chain） | `src-tauri/src/paste_chain.rs`：「取内容 → 写剪贴板 → 落位 → 取焦点快照 → 恢复并注入 → 隐藏面板」这条顺序与 `CopyResult` 文案的唯一归属；六个效果经 `PastePort` trait 注入（生产 `Win32PastePort` / 测试假实现） |
| 复制粘贴结果契约（CopyResult） | `clipboard:copy` 返回 `{ ok, message }`：键盘 Enter / 双击 / 复制按钮三入口共用；`message: &'static str` 由 `paste_chain` 给出，错误文案与 `panel:focus-error` 事件同源（两处都只经 `paste_chain::focus_error_message`） |
| 开机启动通道（startup） | `src-tauri/src/startup.rs`：`Channel`（dev / 未提权 / 已提权三态）、`apply_intent` 与 `set_auto_start` 共用的 `sync_fact`、「拉起→退出」舞步的唯一实现；注册计划任务经注入进入，决策表可测 |
| 设置契约（settings） | `src-tauri/src/settings.rs`：`settings.json` 的读写、camelCase 键名契约（兼容旧 snake_case 残留）与坏档兜底的唯一实现 |
| 面板视图规则（panelView） | `tauri/src/panelView.ts`：搜索过滤、命中高亮片段、选中项落位（`clampIndex` / `moveIndex` / `entryAt`）的纯函数唯一实现；`App.tsx` 只负责把命中片段画成 `<mark>` |

## 架构脉络

Rust 主进程（`tauri/src-tauri/src/`）按「规则在 module，效果在 main.rs」分层：

- `main.rs`：效果编排——剪贴板读写、持久化与广播、托盘、全局热键分发、IPC 命令注册、`AppState`。规则一律在 module interface 之后，本文件不做任何领域判定。
- `history.rs`：历史核心（纯内存，15 例单测）。`HistoryStore` 的小 interface：`record_text / record_image / promote / toggle_pin / remove / clear / set_note / load / to_json / find / entries`；排序 / 去重 / 置顶块 / 裁剪豁免 / 备注归一化只存在于这里。写图、哈希、删图、时间、id 经 `HistoryStoreBuilder` 的函数端口注入。
- `panel_modes.rs`：面板模式状态机（纯逻辑，11 例单测，不依赖 tauri / Win32）。`PanelModes` 的 interface：`show / hide / on_nav_action / begin_search / end_search / set_composing / begin_note_edit / end_note_edit / begin_shortcut_capture / cancel_shortcut_capture / try_set_toggle_shortcut / set_toggle_shortcut / registered_action_for`；热键集合由当前模式推导并差量注册，窗口焦点 / 渲染层通知 / 焦点快照经 `ModesHost` trait 注入。
- `modes.rs`：状态机的唯一入口。`Modes::spawn` 起一条 `modes-executor` 线程独占 `PanelModes`，外部只有 15 个具名操作可投递；`Host`（`ModesHost` 的实现）与 `show_on` / `hide_on` / `toggle_on` 全为 module 私有。死锁防线（插件 register 内部投递主线程并阻塞等待）的说明在此文件顶部。
- `panel_window.rs`：面板窗口（4 例纯几何单测）。`PanelWindow` 的 interface：`show_at_cursor / park_offscreen / focus / release_focus / set_mouse_passthrough / hit_test / exists / is_dark_theme / set_icon / set_position / show`；`centered` / `parked` / `contains_point` 是纯函数，主线程投递与 DIP 换算在实现内部。
- `poll_baseline.rs`：轮询基线（7 例单测）。`observe / confirm / skip_unchanged / note_seq / sync_now`，「算不算一次新复制」与写盘失败重试标志的唯一实现。
- `paste_chain.rs`：复制并粘贴链路（9 例单测）。`run(&mut port, id)` 是唯一入口，六个效果经 `PastePort` 注入；`focus_error_message` 是失败文案的唯一映射处。
- `startup.rs` / `settings.rs` / `tasks.rs`：开机启动的意图与事实分离（通道判定 + 「拉起→退出」舞步，6 例单测）、`settings.json` 键名契约与坏档兜底（6 例单测）、计划任务注册与提权事实查询。
- `focus_paste.rs` / `source_app.rs` / `click_watcher.rs`：进程内 Win32 的焦点快照与 Ctrl+V 注入、前台应用信息与图标提取、`WH_MOUSE_LL` 全局点击钩子。原 Electron 版的 4 个 C# 助手进程全部退役，因此不再有 `native-helper` 这条 seam。

渲染层（`tauri/src/`）：

- `api.ts`：`window.clipboardAPI` 的 invoke / listen 适配层（替代 `electron/preload.js` 的 contextBridge），接口面与 Electron 版一致。
- `panelView.ts`：面板视图规则（纯函数，14 例 node 单测）。`filterEntries / highlight / spansToText / clampIndex / moveIndex / entryAt`。
- `App.tsx`：面板 UI、主题、键盘逻辑（主进程面板键经 `panel:key` 转发）、快捷更换覆盖层；只把命中片段画成 `<mark>`，不再自己算过滤与选中项。

数据流向：Rust 侧维护唯一真相，`commit()` = `persist()` + `broadcast()`，广播经 `emit_panel` 推 `clipboard:updated` 给渲染层；渲染层不直接改数组。

测试：`npm run test` = `test:view`（`node scripts/panel-view-unit.mjs`，14 例，零框架 mock）+ `test:rust`（`cargo test`，58 例），全部是纯模块 interface 直测。GUI 行为（提权 exe、热键、真机粘贴、托盘清晰度、NSIS）仍需人工，清单见 README「待真机验证」。

## 关键决策（设计树档案）

以下为 `/grill-with-docs` 访谈确认的置顶功能决策：

1. **排序语义**：置顶条目形成「置顶块」固定在最前；新复制内容插入置顶块之后、普通块最前。
2. **置顶块内部排序**：按置顶时间 `pinnedAt` 新→旧（最近置顶在最前），多次重排由刷新 `pinnedAt` 实现。
3. **复制置顶条目**（Enter / 双击）：保持置顶，刷新 `pinnedAt` 并移到置顶块最前，行为与复制普通条目一致。
4. **复制普通条目**：插入置顶块之后、普通块最前。
5. **删除/清空**：不豁免置顶条目 —— 置顶只是排序优先级，不是保护锁。
6. **历史上限裁剪**（`MAX_HISTORY = 200`）：置顶条目**豁免**，先裁普通块尾部；全部都是置顶时才裁最旧置顶。
7. **键盘快捷键**：面板显示期间 `Z` 置顶/取消置顶选中项（加入 `NAV_SHORTCUTS`，随面板显示/隐藏注册/注销）。
8. **视觉状态**：置顶图标与复制/删除同风格（15×15、stroke 2、round、currentColor）；置顶时图标实心填充，未置顶为描边。tooltip 随状态显示「置顶 / 取消置顶」。
9. **图标布局**：置顶按钮放在复制图标左侧；`.item-actions` 统一 `gap: 2px`，保证「置顶↔复制」与「复制↔删除」距离相等。
10. **持久化**：`pinned` / `pinnedAt` 随历史 JSON 持久化；旧数据加载时归一化（缺省为 `false` / `0`）。

## 关键决策（搜索功能，grill-with-docs 已确认）

1. **搜索范围**：匹配文本条目的 `text` + 备注 `note` + 来源应用 `appName` / `windowTitle` / `exePath`（图片可经来源应用或备注搜到）。
2. **输入方式**：按空格进入搜索时窗口临时 `setFocusable(true)` + focus 聚焦输入框，正常输入（含中文输入法）；退出搜索时 `setFocusable(false)` + blur 归还焦点；中文 IME 组合期间暂停全部导航键。
3. **按键语义**：浏览模式空格=进入搜索；搜索模式空格=输入空格（主进程注销 Space 拦截）；Esc 两层（搜索→浏览→关面板）；搜索模式下 Z/Del 让位给输入框，↑↓/Enter 仍操作面板（针对筛选结果）。
4. **结果排序**：保持原始顺序（置顶块 + 最近使用），不做匹配度排序；每次查询变化选中项重置到第一个匹配项。
5. **匹配规则**：大小写不敏感；空格分词多词 AND；正文和备注命中片段用 `<mark class="highlight">` 高亮（accent 底色）。
6. **显示与生命周期**：搜索框常驻顶栏下方、未激活灰色禁用态（点击整条也可进入搜索）；每次面板呼出和退出搜索清空查询；空查询显示完整历史列表。

## 关键决策（搜索后回焦粘贴，访谈已确认）

1. **呼出时序**：全局快捷键触发后先异步记录前台窗口与焦点控件，再显示面板；面板默认仍不可激活，避免搜索前就改变原输入位置。
2. **临时聚焦**：搜索、备注编辑和快捷键捕获让面板短暂获得焦点；退出这些状态时统一通过原生助手恢复 `focusTarget`，不再依赖 PowerShell `SendKeys` 或假设焦点从未变化。
3. **粘贴语义**：普通浏览模式（Enter / 双击 / 复制按钮）与搜索模式统一由 `clipboard:copy` 调用助手同时执行“恢复原窗口/焦点 + `Ctrl+V`”；助手成功才隐藏面板，失败则保留面板并发送错误事件，绝不向错误窗口注入内容。
4. **权限模型**：助手直接继承主程序的管理员令牌，不单独提权；聚焦和输入注入对普通及管理员窗口使用同一套逻辑。
5. **协议与生命周期**：助手常驻并通过 stdin/stdout JSON 处理 `snapshot` / `restore` / `paste`；主进程维护请求队列与超时，应用退出时清理。

## 关键决策（备注功能，grill-with-docs 已确认）

1. **备注模型**：每条历史条目最多一条备注；文字和图片都支持；备注为空字符串表示无备注；保存时去除首尾空格，最长 200 字符；旧数据加载时补为空字符串。
2. **编辑入口**：浏览模式下按 `B` 编辑选中项，或点击条目右侧备注图标；已有备注预填并在输入框内编辑，没有备注时显示空输入框；搜索模式按 `B` 让位给搜索输入框。
3. **输入状态**：备注编辑与搜索互斥；备注编辑时窗口临时可聚焦并注销面板导航键，输入框支持正常输入和中文输入法；`Enter` 保存，`Esc` 取消，失焦保存。
4. **显示规则**：备注显示在时间之后，使用 ` · ` 分隔；与时间同字号；单行显示，超出部分用省略号隐藏；编辑时备注展示文字替换为同字号输入框。
5. **图标布局**：备注图标与置顶、复制、删除图标同风格；右侧操作区按 2×2 两行两列展示，第一行「置顶、备注」，第二行「复制、删除」。
6. **搜索集成**：备注参与搜索过滤和高亮；搜索结果保持原有排序，不根据匹配度重排。
7. **数据与操作**：备注随历史 JSON 持久化；空备注保存等同删除备注；复制、删除、置顶、清空等现有操作不会改变或复制备注内容。

## 关键决策（条目身份与去重，grill-with-docs 已确认）

1. **身份规则**：条目身份只由内容决定——文字按文本逐字符精确相等、图片按 PNG 内容 sha1 相等；备注、来源应用、置顶（pinned/pinnedAt）、创建时间均为属性，不参与"是否同一项"判定。
2. **去重范围**：全历史按内容查找（不再只比对最近一条）；复制已在历史中的内容时不新建条目。
3. **命中行为**：把命中的已有条目提升为"最近使用"——普通条目移到普通块最前，置顶条目刷新 `pinnedAt` 并移到置顶块最前；备注/来源/创建时间保持不变（与 Enter 复制该条目的落位规则一致）。
4. **图片统一**：图片同样按内容（PNG sha1）去重，与文字规则一致；条目图片文件创建后不变，主进程用内存哈希缓存（entry.id → sha1）避免重复读盘。
5. **不自动清理旧重复**：修复前历史中已存在的同内容多条不自动合并（避免丢弃备注），仅阻止未来产生新重复；已有重复由用户手动删除。
6. **命中多条重复**：按当前列表顺序命中第一条（置顶块→普通块、最近使用在前），只提升该条，不合并其余。

## 访谈决策（grill-with-docs，2026-08-23 已确认）

1. **术语三分**（Round 1 Q2 选 c）：偏好可持久化；助手连接、进程完整性均为运行时事实，启动时重测、绝不持久化。
2. **已知复现**：管理员终端（PowerShell 7）前台、光标在命令行内时，普通权限启动的工具 Ctrl+Shift+V 可呼出面板，但面板键（↑↓/Enter/Esc/Del/Z）全部无效、按键落入 PowerShell 7；工具本体无提权。
3. **不持久化提权状态**（Round 2 Q4，覆盖 Q3-b 的“记忆意图”）：elevatedPaste 不再持久化；复选框=会话内实测的助手连接状态（提权了才打勾）；重启后恢复未勾选。
4. **呼出时提醒**（Round 2 Q4）：每次在管理员前台窗口呼出面板时提醒提权（弹层+常驻横幅）；取消 UAC → 本次呼出不再自动提醒；隐藏后再呼出会再次提醒；用户主动点按钮可随时再弹 UAC。
5. **提醒内容**（Round 2 Q7）：未提权时面板键（含 Enter）全部无响应、只能鼠标操作——弹层明确告知。
6. **横幅形态**（Round 2 Q8 选 a）：呼出期间常驻顶部横幅，含「启用提权」按钮；“不再继续提醒”=不再弹新警报，横幅原位保留。
7. **状态机**（Round 2 Q9 确认）：呼出 → 前台管理员 && 助手未连 → 弹层一次 + 常驻横幅；同意 UAC → 勾选、横幅消失、面板键恢复；取消 → 不勾、横幅保留、本呼出不再自动弹；隐藏→呼出 → 重新提醒。

## 访谈决策（终版，2026-08-23 定稿）

**终态设计：整个应用常驻管理员权限，无任何提权提示。**

1. **启动方式**：exe 清单 `requireAdministrator`，保证每次启动都是高完整性进程；UIPI 不再拦截工具的裸键热键与 SendKeys 粘贴，管理员目标窗口照常工作。
2. **静默启动**：所有正常入口（桌面/开始菜单快捷方式、托盘重启）走计划任务 `ClipboardToolElevated`（`/rl highest`）；任务以管理员令牌直接创建进程，**不经过 UAC 同意对话框**（同意只发生在任务创建时一次，由提权后的安装/首次启动完成）。直接双击 exe 会弹一次 UAC（保证提权的代价，正常路径不出现）。
3. **开机启动**：即该计划任务的 onlogon 触发器（静默、提权）；托盘开关改为管理该任务。
4. **删除**：提权助手（elevated-helper.cs/exe、管道、SendInput、`settings.elevatedPaste` 字段、UI 开关、startHelperElevated / waitForHelperThenEnable / schedulePaste 的提权分支）全部退役；无横幅/无提醒/无状态机（工具无"未提权"状态）。
5. **实施期验证**：提权后裸键热键在管理员前台确实生效（若意外失效 → 回退助手键盘钩子方案）；单实例锁不冲突。

## 变更日志

- **复制并粘贴链路深化（2026-09-01，候选 2）**：新增 `src-tauri/src/paste_chain.rs`，「回车→粘贴」这条五步链路第一次有了唯一归属与自动化覆盖。原先 `clipboard_copy` 命令函数 59 行，把「取条目内容 → 写剪贴板 → 落位（提升 + 落盘广播 + 同步轮询基线）→ 取焦点快照 → 恢复焦点并注入 Ctrl+V → 成功后隐藏面板」六步连同三份 `CopyResult` 文案一起摊在编排文件里；Electron 版用 `scripts/focus-paste-regression.js` 整模块回归守住这条链，脚本随 Electron 一起删除后无等价物，而顺序错一步就是「粘贴进错误窗口」或「列表闪一下」这类只有真机才暴露的缺陷。现在链路是 `paste_chain::run(&mut port, id)`，效果全部经 `PastePort` trait 注入：生产 adapter `Win32PastePort`（`main.rs`）落地真 arboard / Win32 / 模式执行线程，测试 adapter 记录调用顺序并返回脚本化结果，`clipboard_copy` 只剩一次转发。`CopyResult` / `CopyContent` / `focus_error_message` 一并搬进 `paste_chain`，`send_focus_error` 留在 `main.rs`（`modes.rs` 的失败回报也要用）但改调 `paste_chain::focus_error_message`——`panel:focus-error` 事件与 `CopyResult.message` 仍出自同一个函数，同源关系由 1 例专门单测钉住。`CopyResult.message` 从 `String` 收窄为 `&'static str`（三处文案全是字面量，JSON 形状不变）。9 例单测覆盖：成功链路的完整顺序、图片条目走文件路径分支、条目缺失与写剪贴板失败各自止步于第几步、落位必须先于注入、无焦点快照时中止注入且不隐藏面板、restore 与 paste 两种失败各自的文案、失败文案与事件同源。`main.rs` 1027 → 1008 行，`cargo test` 49 → 58 例。

- **模式执行线程深化（2026-09-01，候选 4）**：新增 `src-tauri/src/modes.rs`，把「模式状态机的入口」从散在 `main.rs` 的投递舞步收成一个具名 interface。原先 `main.rs` 同时持有 `ModesExecutor`（通道 + 执行线程）、`ModesHostImpl`（效果宿主）、4 个 `*_panel_on` 任务函数、`dispatch_hotkey`、`handle_global_click`、`start_shortcut_capture`，共 18 处 `exec` / `exec_now` 闭包投递点，每处各自 clone `AppHandle`、各自决定 `restore_focus` 传 true 还是 false；「绝不从主线程碰模式」这条死锁防线只写在 `main.rs` 顶部注释里，编译器不认。现在 `AppState::modes_exec` 更名 `modes`，`Modes` 成为唯一入口：15 个方法（`show` / `hide` / `hide_after_paste` / `dispatch_accel` / `hide_if_clicked_outside` / `set_toggle_shortcut` / `begin_search` / `set_composing` / `begin_note_edit` / `end_note_edit` / `begin_shortcut_capture` / `cancel_shortcut_capture` / `try_set_toggle_shortcut` / `restore_original_focus` / `focus_target`）承接全部 18 处投递点，「粘贴成功后不再重复恢复焦点」从注释里的 `// restoreFocus: false` 变成方法名 `hide_after_paste`；`ModesExecutor`、`Host`（原 `ModesHostImpl`）、`show_on`/`hide_on`/`toggle_on` 与闭包通道降为 module 私有，外部拿不到 `&mut PanelModes`，死锁防线由注释变成编译期事实。`Modes::toggle()`/`nav()` 因无调用方删除（`dispatch_accel` 内部已覆盖呼出键与导航键两条路径）。死锁成因的说明从 `main.rs` 顶部搬进 `modes.rs` 顶部，`main.rs` 只留一句指路。`main.rs` 1302 → 1027 行，闭包投递点 18 → 0。纯搬迁不改行为，`cargo test` 49/49、`cargo check --all-targets` 零警告。

- **面板窗口深化（2026-09-01，候选 1）**：新增 `src-tauri/src/panel_window.rs`，把浮层面板的几何、焦点与鼠标穿透收成一个 module。原先「面板窗口」没有 module，只有一组自由函数：`main.rs` 里 8 处 `run_on_main_thread`、22 处取窗口、17 处 monitor/scale 换算，同一套「物理像素 vs DIP」的算式在 `position_panel_on_main`、`move_panel_offscreen_on_main`、`handle_global_click` 各写一遍（第 4 遍是 `App.tsx` 的圆角穿透判定）。现在 interface 只剩 `show_at_cursor` / `park_offscreen` / `focus` / `release_focus` / `set_mouse_passthrough` / `hit_test` / `exists` / `is_dark_theme` / `set_icon` / `set_position` / `show`，「必须投递主线程」「用哪个显示器」「点该除几倍缩放」全部进实现。居中、离屏停靠、命中测试是纯函数（`centered` / `parked` / `contains_point`），4 例单测不碰窗口与 AppHandle。`hit_test` 返回 `Option<bool>`：窗口缺失或几何读不到时交 `None`，调用方不据此隐藏（保住原行为「判不出来就不动作」）。顺带：`emit_panel` 成为面板事件的唯一出口（原 5 处各自取窗口再 emit），`primary_scale` 合并托盘两处主屏缩放查询；`main.rs` 1499 → 1302 行，`run_on_main_thread` 只剩注释里一处提及，`get_webview_window` 22 → 1。`cargo test` 45 → 49 例。

- **轮询基线深化（2026-09-01，候选 5）**：新增 `src-tauri/src/poll_baseline.rs`，把「这次剪贴板内容算不算一次新复制」收敛为唯一实现。`AppState` 原先用 `last_text` / `last_image_hash` / `last_seq` / `poll_retry` 四把独立锁承载这条规则，判定散在 `sync_baseline`、`poll_once`（图片分支与文字分支各写一遍基线更新与重试标志）、`poll_loop` 三处，且要求调用方记得在写剪贴板后补 `sync_baseline`（忘了就是粘贴后列表闪一下，历史上真付过）。现在的 interface 只有 `observe` → `Change`、`confirm(ok)`、`skip_unchanged(seq)` / `note_seq(seq)`、`sync_now(png, text)`：判定与暂存分离，写盘失败时基线不动并置重试标志，全部在 module 内部。剪贴板读取仍由 `main.rs` 负责，因此 7 例单测纯数据驱动、不碰 arboard。顺带把 `startup.rs` 的通道决策改成 `decide(channel, exe, intent, register)`：注册计划任务经注入进入，三条通道的取舍（含「dev 与未提权一次都不碰 PowerShell」）全部可测，退役只服务于测试的 `can_manage_task`。`cargo test` 35 → 45 例，并给 5 个测试模块加 `#![allow(non_snake_case)]`、清掉 `history.rs` 一处未使用变量，使 `cargo test` 输出零警告。

- **面板视图规则深化（2026-09-01，候选 6）**：搜索过滤、命中高亮、选中项落位从 `App.tsx` 抽成纯 module `tauri/src/panelView.ts`（`filterEntries` / `highlight` / `spansToText` / `clampIndex` / `moveIndex` / `entryAt`），返回结果不产生效果；`App.tsx` 只把命中片段画成 `<mark>`。原先「选中项越界」的同一份算式在组件里复制了 4 处（`openNoteEditor` 与 enter/delete/pin 三个按键分支），另有两处 `Math.max/Math.min` 变体，现全部走 `clampIndex`/`moveIndex`/`entryAt`。新增 `tauri/scripts/panel-view-unit.mjs`（plain node 直测 14 例，零框架 mock，Node ≥ 22.18 原生剥离类型），`package.json` 加 `test:view` 与聚合 `test`。同时删除 `App.tsx` 里为浏览器预览内联的 `MOCK_CLIPBOARD_API`（6 条 picsum 假历史）：它在真实 bridge 缺失时会静默顶替数据面，且被打进生产包；`vite build` 产物已验证不含该数据。`tauri/README.md` 原与根 README 全文重复（提权横幅退役时漏更），改为指向根 README 的短页。

- **开机启动通道深化（2026-09-01，$improve-codebase-architecture 候选 3）**：把「意图 vs 事实」从词汇变成代码。新增 `src-tauri/src/startup.rs`（`Channel`＝dev/未提权/已提权三态判定、`apply_intent` 与 `set_auto_start` 共用的 `sync_fact`、「拉起→退出」舞步的唯一实现，单测 3 例）与 `src-tauri/src/settings.rs`（`Settings` 读写、camelCase 键名契约、坏档手缝兜底，单测 6 例含往返）。`main.rs` 原先在 `ensure_elevated_task` 与 `set_auto_start` 各写一遍的分支判定、以及三处不一致的「拉起后 sleep 400/800 再退出」全部收敛。同时按终版决策第 4 条（常驻提权、无任何提权提示）退役遗留的提权 UI：渲染层红色横幅与 `elevated` 状态、`api.ts` 的 `isElevated`/`restartElevated`、`elevation_check`/`elevation_restart` 两个命令（它们本就未注册进 `invoke_handler`，横幅因此从未显示过）、托盘 `restart-elevated` 分支（菜单里从未生成该项）、`tasks.rs` 的 `run_elevated_via_uac`/`try_run_elevated_via_task`/`task_has_logon_trigger`。README 三条相关声明同步为实际行为。`cargo test` 35/35。

- **移除 Electron 实现（2026-08-31）**：按用户要求删除全部 Electron 相关代码：`electron/`（5 文件）、根 `src/`（5 文件）、`scripts/`（9 文件）、`resources/`（C# 助手源码与编译产物、托盘图标）、根 `package.json`/`package-lock.json`/`vite.config.mts`/`tsconfig.json`/`index.html`/`installer.nsh`/`electron-final2.log`。Tauri 实现（`tauri/` 目录，含 `src-tauri/` Rust 主进程与 `src/` React 渲染层）为当前唯一实现；`README.md` 已重写为 Tauri 版，`CONTEXT.md` 项目概述已更新。`cargo test` 26/26、`cargo check`、`tsc --noEmit` 仍通过。

- **Tauri 版开机启动持久化修复（2026-08-31）**：修复安装后开启「开机启动」后退出重开仍显示关闭的回归。根因：`Settings` 结构体 `#[derive(Serialize)]` 默认按 `auto_start`（snake_case）序列化为 `auto_start`，而 `load_settings_struct` 与 Electron 共用的 `settings.json` 约定 `autoStart`（camelCase），导致保存后重载时找不到键回退为 false，并使 `ensure_elevated_task` 每次启动都重建无触发器任务。修复：`Settings` 加 `#[serde(rename_all = "camelCase")]` 与 `alias = "auto_start"` 兼容旧存档；`save_settings` 现落盘 `autoStart`；`load_settings_struct` 优先走 `serde` 整体解析（兼顾两种键），兜底手缝逻辑额外兼容 `auto_start` 残留并归一化空 `shortcut`；`cargo test` 26/26 与序列化往返（camel/snake 互通）验证通过。

- **粘贴延迟优化（2026-08-30）**：「回车→粘贴」实测从 ~1s 降到 <50ms。三处根因，分段实测定位（新增诊断脚本 `scripts/helper-timing.js` 量助手、`scripts/latency-bench.js` 量主进程各段）：
  1. **broadcast 图片重编码（主因，实测 614ms）**：每次 broadcast 对历史里每个图片条目做 读盘+解码+PNG 重编码+base64，全程阻塞主进程，且发生在助手注入之前（copyEntry 的 commit 先广播）。修复：`imageDataUrlCache` 按 imagePath 缓存 dataUrl（图片文件创建后内容不变），裁剪/删除/清空经 removeImageFile 端口同步失效、载入时清空；实测命中缓存后 0ms。顺带消除每次新复制后 600ms 轮询广播的同类 614ms 阻塞（回车若排在其后也被拖住）。
  2. **助手固定 Sleep（实测 31–47ms）**：RestoreTarget 的激活级联每步写死 Sleep(30/40)，即使原窗口一直是前台（浏览模式常态）也要等满。修复：前台+焦点控件已在原位时零操作直返；激活改 4ms 步进轮询（`WaitForForeground`，预算 48ms）成功即刻返回；失败级联去掉段间 Sleep（轮询本身覆盖等待）。实测 restore 31–47ms → 0–2ms。响应新增 `ms` 字段便于回归观察（mock 不带此字段，main.js 忽略未知字段）。
  3. **粘贴内容被轮询重复处理**：copyEntry 写剪贴板后未同步轮询基线，下一个 600ms 轮询把粘贴内容当"新复制"再次提升+广播（多余全列表重绘/闪烁）。修复：copyEntry 末尾 `syncBaseline()`。
  - 助手 exe 已重新编译（build:helper 全套 + INPUT 尺寸断言通过）；发现并清理了两个残留的孤儿助手进程（主程序未运行却占着 exe 文件锁）。

- **架构深化四项（2026-08-30，$improve-codebase-architecture）**：按「deep module」原则重排主进程——
  1. **历史核心**：`electron/history.js` 新建；条目身份/去重提升/置顶块插入（原 4 处复制粘贴）/persist+broadcast 成对调用（原 8 处）/图片清理（原 3 处）收敛为 store 的小 interface，文件效果经注入端口；main.js 相应收缩。新增 `test:history` 15 例直测领域规则（此前零覆盖）。
  2. **面板模式状态机**：`electron/panel-modes.js` 新建；浏览/搜索（含 IME）/备注/捕获四态 + 焦点快照生命周期归一；全局热键集合由模式推导并差量注册（替代原先散布 13 处的 register/unregister 舞步与 5 个松散布尔）；渲染层协议（panel:key/panel:shown/shortcut:capture-*）不变，App.tsx 无需改动。新增 `test:panel-modes` 11 例。顺带删除 main.js 中已失效的 `codeToKey` 副本（渲染层才是真源）。
  3. **助手进程 seam**：`electron/native-helper.js` 新建；focus-paste-helper（JSON 请求 id+超时）、app-icon-helper（一次性 execFile+末行 JSON）、click-watcher（文本行）统一走 `spawnLineHelper / createJsonRpcHelper / readOneShotJson`；协议 schema 在模块顶部命名，focus-paste-helper.cs 加同步注记。**修复 click-watcher 事件跨 chunk 边界被静默丢弃的缺陷**（原 `chunk.split('\n')` 无缓冲）。新增 `test:native-helper` 9 例。task-launcher.cs 与 main.js 的计划任务注册脚本仍为两种语言各一份（安装期启动器无法复用 JS；统一需重编译原生 exe 并重新实证提权链路，暂缓），已在两处加同步注记。
  4. **复制粘贴结果契约**：`clipboard:copy` 返回 `{ ok, message }`（CopyResult），错误文案由 main.js 的 `focusErrorMessage` 统一给出并与 `panel:focus-error` 事件同源；鼠标路径不再在粘贴失败时假报「已复制并粘贴」；键盘路径行为不变。focus-paste 回归同步改为断言契约。
  - 回归基建修复：`scripts/focus-paste-regression.js` 的 BrowserWindow mock 的 `setContentBounds/setBounds` 此前是静默 no-op，面板隐藏断言只能靠 try/catch 回退分支碰运气（commit 0282497 起即为红）；现 mock 忠实模拟窗口移动，断言回到主路径。
  - 校验：`npm test` 五套件全绿（15+11+9 例单测 + 两条整模块回归）、`typecheck` 通过。

- **托盘图标高清化（2026-08-29）**：修复 175% 等非整数缩放下托盘图标发糊。根因：Electron 43 Windows 托盘 `Tray::SetImage → NativeImage::GetHICON(SM_CXSMICON)` 用 1x 位图原样生成 HICON（`CreateHICONFromSkBitmap(AsBitmap())`，不带尺寸参数、不认 @2x 阶梯），单一 32px 基图被系统重采样到 28 物理像素。修复：`scripts/gen-tray-icons.mjs` 用参数化 SDF（坐标下降拟合 32px 原图，平均误差 1.47/255）按目标尺寸直出 `tray-icon{,-light}-{16,20,24,28,32}.png`（`npm run gen:tray` 可再生）；`electron/main.js` 按主屏 `scaleFactor` 取 `round(16×sf)` 对应单尺寸图 1:1 渲染，`display-metrics-changed` 时重选。实测（物理分辨率截屏模板匹配）：峰值白度 211→255，笔画边缘 1px 硬边，1:1 对齐偏差 12.8（重采样时 40+）。32px 原图保留作窗口图标与回退。

- **Apple 风格精修（2026-08-27，$apple-style）**：按 Cathedral 规范重做 `src/styles.css` — :root 注入全套 Apple Tokens（Primary Ink #1d1d1f / Hairline #d6d6d6 / Canvas #f5f5f7 / Paper #ffffff / Cool Wash #e8e8ed / Electric Blue #0071e3 唯一 CTA / Link Blue #0066cc 等）、SF Pro Display/Text 字族与 numr、毛玻璃画布（Canvas 半透明 28px blur）+ Paper 无边卡（16px 圆角，悬停 Faded Surface，选中 Electric 6%）、来源图标 pastel 唯一彩色、44px 导航、12px 胶囊搜索（Hairline + Electric 环）、11px 微文案 whispered 标题、无阴影无分割线节奏；深色映射 #1d1d1f/#2c2c2e；`docs/screenshots` 同步新亮/暗/详情截图；校验：`typecheck` 通过、亮/暗/搜索/详情四态截图已验收。

- **修复焦点粘贴回归**（2026-08-25）：恢复 `focus-paste-helper` 中 `INPUT` 联合体的 `MOUSEINPUT` 结构；它是 Win32 `SendInput` 结构定义的一部分，删除后 64 位下 `INPUT` 从 40 字节缩为 32 字节，`SendInput` 报 `ERROR_INVALID_PARAMETER(87)`，表现为“复制已写入剪贴板，但无法粘贴回原输入框”。构建脚本新增 `INPUT` 尺寸断言防止再次误删。
- **清理旧粘贴残留**（2026-08-25）：移除普通复制旧实现遗留的 `autoPaste` 设置、`SHADOW_MARGIN` 常量、助手 `paste-current` 命令与 `strategy` / `allowed` 空字段；粘贴只保留 `snapshot` / `restore` / `paste` 单一链路。
- **搜索后回焦粘贴**（2026-08-25）：新增 `focusTarget`、`focus-paste-helper.exe` 和 `clipboard:copy` 的“快照→恢复→注入”流程；普通浏览与搜索模式的粘贴统一走该链路，搜索/备注/快捷键捕获/关闭面板也统一走原生恢复，粘贴失败不隐藏面板；新增 `test:focus-paste` 普通/搜索双路径回归和 `test:autostart` 开机启动回归；README/CONTEXT 同步。
- **条目身份与去重修复**（2026-08-25，grill-with-docs 定稿）：同内容（文字逐字符/图片 PNG sha1）不再视为不同复制项——去重从"只比最近一条"改为全历史查找；复制已存在内容时把原条目提升到最近使用（置顶条目刷新 `pinnedAt`），备注/来源/创建时间保持不变；不自动清理历史中已有的重复项；图片内容哈希走内存缓存。README/CONTEXT 同步。
- **备注功能**（2026-08-25，grill-with-docs 定稿）：主进程新增 `note` 字段与旧数据归一化、`note:set` IPC、`B` 面板键、`note-edit-enter/exit` 状态机；preload 新增 `setNote` / `beginNoteEdit` / `endNoteEdit`；渲染层新增备注展示、内联输入、备注图标与 2×2 操作区，备注参与搜索和高亮；README/CONTEXT 同步。
- **搜索功能**（2026-08-25，grill-with-docs 定稿）：主进程 `Space` 面板键 + `searchActive`/`searchComposing` 状态机（按搜索模式切换注册的快捷键集合：Space/Z/Del 让位、IME 组合暂停导航）；preload 新增 `activateSearch` / `setSearchComposing`；渲染层常驻搜索框（灰色禁用态↔激活态）、text+来源应用过滤（空格分词 AND、大小写不敏感）、`<mark>` 命中高亮、空查询/无匹配空状态、动态底部提示；README/CONTEXT 同步。
- **常驻提权改造**（2026-08-23，grill-with-docs 定稿）：`requireAdministrator` 清单 + 计划任务静默启动；退役提权助手（elevated-helper/管道/SendInput/开关 UI/`elevatedPaste`/`helperToken`）；开机启动改由计划任务 onlogon 触发器管理（意图存 `autoStart`）；新增 `task-launcher.cs` / `installer.nsh` / `ensureElevatedTask` / `setAutoStart`；README 与本文档同步。
  - **实施细节**：任务注册用 PowerShell `Register-ScheduledTask`（schtasks `/create` 强制要求 `/sc`；COM `RegisterTaskDefinition` 本机稳定报 (38,4)）——无触发器版本仅作静默拉起通道，开机启动=带 `AtLogOn` 触发器重建；启动器传参用 `-EncodedCommand` 免引号转义；任务 Run 用 COM 晚绑定（`Run((object)null)` 防参数计数错）。
  - **已实证**：打包产物 exe 清单含 `requireAdministrator`；端到端 `task-launcher.exe → 创建任务(exit=0) → 任务 Running → 主程序提权启动` 全部通过（本机提权 shell 下验证）。待用户桌面验证：非提权 explorer 经任务静默拉起无 UAC；提权后裸键热键对管理员前台生效（失效则回退助手键盘钩子方案）。
- 置顶功能：新增 `clipboard:pin` IPC、`Z` 面板键、`PinIcon`、置顶块排序/插入/裁剪豁免逻辑，README 与本文档同步。
- （访谈）不持久化提权状态、呼出时提醒、助手接管面板键通道：见「访谈决策」。
