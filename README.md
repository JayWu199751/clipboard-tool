# ClipboardTool — Windows 剪贴板历史工具（Tauri 版）

> 基于 **Tauri 2 + React 19 + Rust** 的 Windows 桌面剪贴板工具：自动记录文字/图片历史，全局快捷键呼出，一键复制并粘贴回原输入框。原 Electron 实现已于 2026-08-31 删除，当前为纯 Tauri 实现；数据目录仍沿用 `%APPDATA%\ClipboardTool` 与旧版存档兼容（历史 JSON、图片、settings.json）。

> 主进程由 JavaScript 重写为 Rust，渲染层 React 代码沿用 Electron 版结构（下表为历史对比，Electron 代码已移除）。
> 渲染层的搜索/选中规则与主进程的历史、模式规则一样收敛为纯 module（`src/panelView.ts`），可脱离框架直测。

## 与 Electron 版的架构差异

| Electron 版 | Tauri 版 |
|---|---|
| `electron/main.js`（948 行编排） | `src-tauri/src/main.rs` |
| `electron/history.js` 历史核心（纯逻辑） | `src-tauri/src/history.rs`（单测 15 例移植） |
| `electron/panel-modes.js` 模式状态机（纯逻辑） | `src-tauri/src/panel_modes.rs`（单测 11 例移植；焦点快照从异步 JSON-RPC 变为同步 Win32 调用） |
| `electron/native-helper.js` + **focus-paste-helper.exe** | `src-tauri/src/focus_paste.rs`（进程内 Win32，助手进程退役） |
| **app-icon-helper.exe** | `src-tauri/src/source_app.rs`（SHGetFileInfo/ExtractAssociatedIconW） |
| **click-watcher.exe** | `src-tauri/src/click_watcher.rs`（进程内 WH_MOUSE_LL 钩子） |
| **task-launcher.exe** | `src-tauri/src/tasks.rs`（PowerShell Register-ScheduledTask 同款脚本） |
| `main.js` 内的提权/开机启动分支 | `src-tauri/src/startup.rs`（通道判定 + 意图/事实分离，单测 3 例） |
| `main.js` 的 settings 读写 | `src-tauri/src/settings.rs`（键名契约与坏档兜底，单测 6 例） |
| `main.js` 内的轮询基线（lastText / lastImageHash / 重试标志） | `src-tauri/src/poll_baseline.rs`（唯一实现「算不算一次新复制」，单测 7 例） |
| `main.js` 的面板窗口管理（呼出/离屏驻留/失焦/穿透） | `src-tauri/src/panel_window.rs`（几何与主线程投递的唯一归属，单测 4 例纯几何） |
| `main.js` 里散布各处的 `webContents.send` / 直接持锁改模式 | `src-tauri/src/modes.rs`（模式状态机唯一入口：具名操作 + 独占执行线程 + 效果宿主） |
| `main.js` 的 `clipboard:copy` 五步链路（含 `focus-paste-regression.js` 整模块回归） | `src-tauri/src/paste_chain.rs`（链路顺序与结果文案唯一归属；效果经 `PastePort` 注入，单测 9 例断言顺序与文案同源） |
| `electron/preload.js` contextBridge | `src/api.ts`（invoke/listen 适配层，`window.clipboardAPI` 接口面不变，App.tsx 零改动） |
| `App.tsx` 内的搜索过滤 / 高亮 / 选中项算式 | `src/panelView.ts`（纯逻辑，单测 14 例；App.tsx 只画 `<mark>`） |
| 600ms 轮询（无条件 readImage+toPNG） | 同 600ms 轮询 + `GetClipboardSequenceNumber` 短路（未变化时零剪贴板打开，减少与其它程序的争用） |

数据目录沿用 `%APPDATA%\ClipboardTool`，与 Electron 版共享历史 JSON、图片文件与 settings.json（两版不要同时运行）。

## 开发与构建

```bash
cd tauri
npm install
npm run dev        # tauri dev：vite 5173 + 调试 exe（asInvoker，非提权）
npm run test       # 全部单测：test:view（node 14 例）+ test:rust（cargo 58 例）
npm run test:view  # node scripts/panel-view-unit.mjs（面板视图规则，零框架）
npm run test:rust  # cargo test（58 例：history 15 + panel-modes 11 + paste_chain 9 + poll_baseline 7 + settings 6 + startup 6 + panel_window 4）
npm run typecheck  # tsc --noEmit
npm run build      # tauri build（NSIS）
```

### 常驻提权（requireAdministrator）与管理员窗口兼容

Windows 的 UIPI 会拦截非提权进程对高完整性（管理员）前台窗口的热键投递与 `SendInput` 粘贴，导致“在管理员运行的应用中热键呼不出来 / 粘贴不进去”。Tauri 版与 Electron 版采用同一套提权方案：

- **清单**：`build.rs` 在 `release`  profile 时默认嵌入 `requireAdministrator`（保留 PerMonitorV2 DPI 感知），无需手动设环境变量；`debug` 默认 `asInvoker` 便于开发。显式覆盖：`CLIPBOARD_TOOL_ELEVATED=0` 强制不提权 / `=1` 强制提权。
  ```bash
  cd tauri
  npm run build        # release 默认提权（= 旧版 set CLIPBOARD_TOOL_ELEVATED=1 + tauri build）
  CLIPBOARD_TOOL_ELEVATED=0 npm run build  # 强制 asInvoker（调试用）
  ```
- **静默拉起**：计划任务 `ClipboardToolElevated`（`/rl highest`、交互式令牌、无触发器时仅作拉起通道）。首次提权启动（会弹一次 UAC）或安装器会创建它；后续正常启动若检测到未提权且任务已存在，则**静默经任务拉起提权实例并退出当前进程，不弹 UAC**。任务不存在时不做任何兜底：release 清单已保证提权，走到这一支说明清单被改写过（见下条覆盖开关）。
- **自检与诊断**：提权状态只写 `stderr` 与 `diag.log`（开发构建不输出，避免污染 `npm run dev`）。**渲染层没有任何提权提示**：按定稿决策「整个应用常驻管理员权限，无任何提权提示」，早前的红色横幅、`elevation_check` / `elevation_restart` 命令与托盘「以管理员身份重启」项已全部退役。
- **开机启动**：仍为该任务的 `AtLogOn` 触发器，开关时重建任务（带/不带触发器，本体保留供静默拉起）。意图（`settings.autoStart`）与事实（任务及其触发器）分离：未提权时建不出 Highest 任务，先落盘意图、等下次提权启动补建，判定集中在 `src-tauri/src/startup.rs`。

> 调试提示：`tauri dev` 始终是 `asInvoker`，在管理员窗口中复现“热键不响应”属预期；请用 `cargo build --release` 或 `CLIPBOARD_TOOL_ELEVATED=1 cargo run --release` 的提权 exe 验证管理员场景，或在已提权 shell 中执行 `cargo run --release`。

### 诊断

`CLIPBOARD_TOOL_POLL_TRACE=1` 启动可输出轮询各阶段追踪日志。

## 实测验证记录（2026-08-31）

- `npm run test` 全绿：`cargo test` 58/58、`node scripts/panel-view-unit.mjs` 14/14；`tsc --noEmit`、`vite build` 干净（产物内已无预览用假数据）。
- 冒烟（隔离 APPDATA）：文本/图片复制均被记录（来源应用 exePath/appName/windowTitle + 图标 dataUrl 提取正常），PNG 落盘 `images/`，历史 JSON schema 与 Electron 版兼容；二启唤出面板，暗色主题/列表/选中态/来源图标/快捷键条渲染正确。
- 真实点击/热键全流程：热键呼出、↑↓ 选择、Esc 隐藏、点击复制并粘贴（写剪贴板→焦点恢复→Ctrl+V 注入→隐藏面板，全程 <1ms）、点击面板外隐藏、剪贴板实时广播更新列表——全部通过，进程稳定。

### 已修复的两个关键坑（手工搭建 Tauri 工程必读）

1. **capabilities 缺失导致事件全断**：v2 的 ACL 权限系统默认拒绝 `plugin:event|listen`，必须提供
   `src-tauri/capabilities/default.json` 授予 `core:default`；否则自定义命令（invoke）正常而
   所有 Rust→渲染层事件静默丢失（脚手架模板自带此文件，手工搭建容易漏）。
2. **插件热键 API 的阻塞投递会造成跨线程死锁**：`global_shortcut().register/unregister` 内部是
   「投递主线程 + 阻塞 recv」。若从持有自建锁的线程调用，而主线程恰在等同一把锁（如点击面板
   触发的 Focused 事件任务），即互等卡死（表现为"点击复制并粘贴→无响应"）。解法：模式状态机
   由专用执行线程独占（`modes::Modes`），外部只能投递具名操作、拿不到状态机本身，
   主线程只读无锁原子快照。

### 待真机验证（与 Electron 版同类的实证项）

- 提权构建后的裸键热键对管理员前台窗口、焦点恢复 + Ctrl+V 注入时延、托盘图标在各缩放档位的清晰度、NSIS 安装器全流程。

## 已知偏差（相对 Electron 版）

- 托盘图标 DPI：移植了按主屏 `scaleFactor` 选恰好物理尺寸图的方案，但 Tauri 的 tray-icon 生成 HICON 路径与 Electron 不同，清晰度需真机复核。
- 浏览态"不抢焦点"沿用 focusable + 焦点事件自动 `SetFocus(NULL)` 的模拟方案（Electron 同款），首帧激活次序需真机复核。
- 快捷键捕获的 accelerator 由渲染层以 Electron 格式上传（`Control+Shift+V` 等），Rust 侧经 global-hotkey 解析注册，行为一致但解析器不同。
