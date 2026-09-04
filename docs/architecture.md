# 架构

> ClipboardTool 的实现地图：分层原则、线程模型、module 清单、IPC 契约。术语见 [CONTEXT.md](../CONTEXT.md)，为什么这么切见 [adr/](adr/)。

## 分层原则

**规则住在 module，效果留在 `main.rs`**（[ADR-0008](adr/0008-rules-in-modules-effects-in-main.md)）。领域判定各自收敛为一个 deep module，interface 尽量小；读写剪贴板、落盘、emit、Win32、投递主线程这些效果留在编排里，或经注入端口从 module 外部进来。加代码前先问「这是判定还是效果」。

## 线程模型（改动前必读）

死锁的成因只有一条：`tauri-plugin-global-shortcut` 的 `register`/`unregister` 内部是「投递主线程 + 阻塞等待」。谁在持有模式状态时调用它、而主线程恰好在等这把锁，就互等卡死（历史上表现为「点击复制并粘贴 → 无响应」）。防线是把状态机锁进一条线程（[ADR-0006](adr/0006-modes-on-dedicated-thread.md)）：

| 线程 | 能做什么 | 绝不能做 |
|---|---|---|
| 主线程（tauri 事件循环） | 窗口几何/样式、托盘、插件投递的落地端；读 `modes_visible` / `modes_input_active` 两个原子快照 | 阻塞等待模式状态 |
| `modes-executor` | 唯一持有 `PanelModes` 与效果宿主 `Host`；唯一允许调用热键 register/unregister | 把 `&mut PanelModes` 交出去（类型是 module 私有） |
| 命令线程（tokio worker，`async #[tauri::command]`） | 向 `Modes` 投递具名操作并 `.await` 回执；跑慢的 Win32 粘贴注入 | 持有 store 锁的同时 await 模式回执 |
| 回调线程（热键 / 鼠标钩子 / 托盘 / 单实例 / 窗口事件） | 向 `Modes` 投递具名操作，**不等待**（忽略返回值不影响投递） | 阻塞：回调必须立即返回 |
| 方向键重复线程 | `Up` / `Down` 按住期间按定时器重复投递 `dispatch_accel`；只读 `modes_visible`，面板隐藏后停止 | 持有模式状态、等待模式回执 |
| 轮询线程（600ms） | 读剪贴板、判定新复制、写盘广播；单次异常经 `catch_unwind` 只跳过本轮 | 被任何模式锁拖住 |

两条附带约束：窗口几何与样式变更必须投递主线程执行（这条现在由 `panel_window.rs` 的实现内部承担，调用方只管动作）；`store` 锁与模式状态绝不交叉持有。

## Rust module 地图

`tauri/src-tauri/src/`。单测例数与 `cargo test --list` 对齐。

| module | 职责（唯一归属） | interface | 单测 |
|---|---|---|---|
| `main.rs` | 效果编排：剪贴板读写、持久化与广播、托盘、热键分发与方向键重复、IPC 注册、`AppState` | — | — |
| `history.rs` | 条目身份、去重提升、置顶块插入、裁剪豁免、备注归一化 | `record_text` `record_image` `promote` `toggle_pin` `remove` `clear` `set_note` `load` `to_json` `find` `entries` | 15 |
| `panel_modes.rs` | 面板四态状态机 + 热键集合推导与差量注册（纯逻辑，不依赖 tauri / Win32） | `show` `hide` `on_nav_action` `begin_search` `end_search` `set_composing` `begin_note_edit` `end_note_edit` `begin_shortcut_capture` `cancel_shortcut_capture` `try_set_toggle_shortcut` `set_toggle_shortcut` `registered_action_for` `ensure_focus_target` `restore_original_focus` `is_repeatable_navigation` | 12 |
| `modes.rs` | 状态机的唯一入口：独占执行线程 + 具名操作 + 效果宿主 | `spawn` + 15 个具名操作（见下） | — |
| `panel_window.rs` | 面板几何、焦点、鼠标穿透；主线程投递与 DIP 换算 | `show_at_cursor` `park_offscreen` `focus` `release_focus` `set_mouse_passthrough` `hit_test` `exists` `is_dark_theme` `set_icon` `set_position` `show`；纯函数 `centered` `parked` `contains_point` | 4 |
| `poll_baseline.rs` | 「这次剪贴板内容算不算一次新复制」+ 写盘失败重试标志 | `observe` `confirm` `skip_unchanged` `note_seq` `sync_now` | 7 |
| `paste_chain.rs` | 复制并粘贴链路的顺序与结果文案；失败文案的唯一映射处 | `run(&mut port, id)` + `PastePort`（7 个效果）+ `focus_error_message` | 9 |
| `startup.rs` | 静默启动通道的三态判定、意图/事实分离、「拉起→退出」舞步 | `channel` `apply_intent` `set_auto_start` `relaunch_via_task` `relaunch_if_not_elevated` `current_exe_path`（通道决策 `decide` 与 `sync_fact` 在 module 内部，任务注册经参数注入） | 6 |
| `settings.rs` | `settings.json` 的读写与 camelCase 键名契约、坏档兜底 | `load` `save` `parse` `Settings::default` | 6 |
| `focus_paste.rs` | 进程内 Win32 的焦点快照与恢复 + `Ctrl+V` 注入 | `snapshot` `restore_and_paste`（失败带 `RestoreFailure{stage,reason}`） | — |
| `source_app.rs` | 前台应用信息与图标提取（`SHGetFileInfo` / `ExtractAssociatedIconW`） | `get_foreground_app_info` | — |
| `click_watcher.rs` | `WH_MOUSE_LL` 全局点击钩子 | `ClickWatcher::start` `stop` | — |
| `tasks.rs` | 计划任务注册脚本与提权事实查询 | `ps_register_task` `run_elevated_task` `task_exists` `is_elevated` | — |

`history.rs` 的写图 / 哈希 / 删图 / 时间 / 生成 id、`panel_modes.rs` 的全部效果、`paste_chain.rs` 的全部效果、`startup.rs` 的任务注册都是注入端口，所以生产实现与测试假实现各一份，seam 才成立。

**模式操作**（`modes.rs` 的 15 个具名方法）：`show` `hide` `hide_after_paste` `dispatch_accel` `hide_if_clicked_outside` `set_toggle_shortcut` `begin_search` `set_composing` `begin_note_edit` `end_note_edit` `begin_shortcut_capture` `cancel_shortcut_capture` `try_set_toggle_shortcut` `restore_original_focus` `focus_target`。新增模式操作在这里加方法，不要在调用方拼闭包。

## 渲染层地图

`tauri/src/` 与 `tauri/tests/`。

| 文件 | 职责 | 测试 |
|---|---|---|
| `panelView.ts` | 搜索过滤、命中高亮片段、选中项落位的纯函数 | `filterEntries` `highlight` `spansToText` `clampIndex` `moveIndex` `entryAt`；14 例 plain node |
| `api.ts` | `window.clipboardAPI` 的 invoke / listen 适配层；同一 channel 重复注册时先解绑旧的（generation 计数防 useEffect 竞态） | — |
| `App.tsx` | 面板 UI、主题、键盘逻辑、快捷更换覆盖层；只把命中片段画成 `<mark>`。「保持选中项可见」只负责滚，判定交给 `styles.css` 的 `scroll-padding` | 由 `first-item-top-clip.spec.js` 守 |
| `styles.css` | Apple (Espana) Cathedral 设计语言的 token 落地，见 [design-system.md](design-system.md)；列表滚动边缘的「可视区」也由它定义：`padding` 让开 10px 渐隐遮罩，`scroll-padding` 把同一段留白声明成 `scrollIntoView` 的可视区，两者同源 | — |
| `tests/panel-harness.js` | 浏览器用例共用的 mock Tauri bridge 与 `FADE_INSET` 常量 | — |
| `tests/navigation-visual-regression.spec.js` | 驱动真实渲染层，回归高频方向键导航的选中框跟随 | 1 例 Playwright |
| `tests/first-item-top-clip.spec.js` | 回归滚到列表首尾时选中项不被渐隐遮罩盖住 | 2 例 Playwright |

## IPC 契约

命令（`invoke`，参数 camelCase）：

| 命令 | 作用 | 返回 |
|---|---|---|
| `clipboard_get` | 全量历史 | `RendererEntry[]` |
| `clipboard_copy` | 复制并粘贴（三入口共用） | `{ ok, message }` |
| `clipboard_remove` / `clipboard_pin` / `clipboard_clear` | 删除 / 置顶切换 / 清空 | `bool` |
| `note_set` / `note_begin_edit` / `note_end_edit` | 写备注 / 进入备注编辑态 / 退出 | `bool` |
| `shortcut_try` / `shortcut_cancel` | 试设呼出键 / 取消捕获 | `{ ok, formatted }` / `bool` |
| `search_activate` / `search_set_composing` | 进入搜索态 / 同步 IME 组合状态 | `bool` |
| `window_hide` / `window_set_ignore_mouse` | 隐藏面板 / 切换鼠标穿透 | `bool` |

事件（Rust → 渲染层，全部经 `emit_panel` 这一个出口，窗口不存在时静默丢弃）：

| 事件 | 载荷 | 作用 |
|---|---|---|
| `clipboard:updated` | `RendererEntry[]` | 历史变更广播 |
| `panel:key` | `{ action, noteEntryId }` | 面板显示期间被全局拦截的按键动作 |
| `panel:shown` | — | 呼出完成，渲染层重置搜索与选中态 |
| `panel:focus-error` | `{ stage, reason, message }` | 焦点恢复或注入失败；`message` 与 `CopyResult.message` 同源 |
| `shortcut:capture-start` / `shortcut:capture-end` | `{ current }` / — | 快捷键捕获覆盖层的开关 |

## 数据流

Rust 侧是唯一真相。一次变更 = `store` 方法 + `commit()`，而 `commit()` = `persist()`（写 `clipboard-history.json`）+ `broadcast()`（图片条目转 dataUrl 后 emit `clipboard:updated`）。渲染层不直接改数组，只发命令、听事件。图片落盘 `images/`，dataUrl 按 `imagePath` 永久缓存（文件创建后内容不变），删除/裁剪时经注入端口同步失效。

轮询线程每 600ms 跑一次，先用 `GetClipboardSequenceNumber` 短路未变化的轮次——序列号没动就不打开剪贴板，也就不必先读图片再编码 PNG。

## 待真机复核

两条结论只能靠真机拿到，读代码不算验证（完整清单见 [README.md](../README.md) 「待真机验证」）：

- **托盘图标清晰度**：按主屏 `scaleFactor` 取恰好物理尺寸的图 1:1 渲染，但最终 HICON 由 tray-icon 的生成路径决定，非整数缩放下是否仍糊必须眼看。
- **浏览态不抢焦点**：靠 `focusable: true` 加焦点事件自动 `SetFocus(NULL)` 模拟，首帧激活次序需眼看。
