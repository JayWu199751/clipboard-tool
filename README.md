# ClipboardTool — Windows 剪贴板历史工具（Tauri 版）

> 基于 **Tauri 2 + React 19 + Rust** 的 Windows 桌面剪贴板工具：自动记录文字/图片历史，全局快捷键呼出，一键复制并粘贴回原输入框。原 Electron 实现已于 2026-08-31 删除，当前为纯 Tauri 实现；数据目录仍沿用 `%APPDATA%\ClipboardTool` 与旧版存档兼容（历史 JSON、图片、settings.json）。

> 渲染层 React 代码从 Electron 版原样复用，主进程由 JavaScript 重写为 Rust（下表为历史对比，Electron 代码已移除）。

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
| `electron/preload.js` contextBridge | `src/api.ts`（invoke/listen 适配层，`window.clipboardAPI` 接口面不变，App.tsx 零改动） |
| 600ms 轮询（无条件 readImage+toPNG） | 同 600ms 轮询 + `GetClipboardSequenceNumber` 短路（未变化时零剪贴板打开，减少与其它程序的争用） |

数据目录沿用 `%APPDATA%\ClipboardTool`，与 Electron 版共享历史 JSON、图片文件与 settings.json（两版不要同时运行）。

## 开发与构建

```bash
cd tauri
npm install
npm run dev        # tauri dev：vite 5173 + 调试 exe（asInvoker，非提权）
npm run test:rust  # cargo test（26 例：history 15 + panel-modes 11）
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
- **静默拉起**：计划任务 `ClipboardToolElevated`（`/rl highest`、交互式令牌、无触发器时仅作拉起通道）。首次提权启动（会弹一次 UAC）或安装器会创建它；后续正常启动若检测到未提权且任务已存在，则**静默经任务拉起提权实例并退出当前进程，不弹 UAC**；若任务尚不存在则走 `Start-Process -Verb RunAs` 兜底（会弹 UAC，但此次即会创建任务，下次静默）。
- **自检与提示**：启动时 `eprintln!` + `diag.log` 输出提权状态；渲染层通过 `elevation_check` 查询，未提权时面板顶部显示红色横幅“未提权 — 在管理员窗口中热键与粘贴可能失效”并提供“一键以管理员身份重启”按钮（优先任务静默，任务缺失则 UAC）；托盘菜单亦同步显示“已提权 ✅”/“以管理员身份重启 ⚠️”。
- **开机启动**：仍为该任务的 `AtLogOn` 触发器，开关时重建任务（带/不带触发器，本体保留供静默拉起）。

> 调试提示：`tauri dev` 始终是 `asInvoker`，在管理员窗口中复现“热键不响应”属预期；请用 `cargo build --release` 或 `CLIPBOARD_TOOL_ELEVATED=1 cargo run --release` 的提权 exe 验证管理员场景，或在已提权 shell 中执行 `cargo run --release`。

### 诊断

`CLIPBOARD_TOOL_POLL_TRACE=1` 启动可输出轮询各阶段追踪日志。

## 实测验证记录（2026-08-31）

- `cargo test` 26/26 通过；`tsc --noEmit`、`vite build` 干净。
- 冒烟（隔离 APPDATA）：文本/图片复制均被记录（来源应用 exePath/appName/windowTitle + 图标 dataUrl 提取正常），PNG 落盘 `images/`，历史 JSON schema 与 Electron 版兼容；二启唤出面板，暗色主题/列表/选中态/来源图标/快捷键条渲染正确。
- 真实点击/热键全流程：热键呼出、↑↓ 选择、Esc 隐藏、点击复制并粘贴（写剪贴板→焦点恢复→Ctrl+V 注入→隐藏面板，全程 <1ms）、点击面板外隐藏、剪贴板实时广播更新列表——全部通过，进程稳定。

### 已修复的两个关键坑（手工搭建 Tauri 工程必读）

1. **capabilities 缺失导致事件全断**：v2 的 ACL 权限系统默认拒绝 `plugin:event|listen`，必须提供
   `src-tauri/capabilities/default.json` 授予 `core:default`；否则自定义命令（invoke）正常而
   所有 Rust→渲染层事件静默丢失（脚手架模板自带此文件，手工搭建容易漏）。
2. **插件热键 API 的阻塞投递会造成跨线程死锁**：`global_shortcut().register/unregister` 内部是
   「投递主线程 + 阻塞 recv」。若从持有自建锁的线程调用，而主线程恰在等同一把锁（如点击面板
   触发的 Focused 事件任务），即互等卡死（表现为"点击复制并粘贴→无响应"）。解法：模式状态机
   由专用执行线程独占（ModesExecutor），所有模式操作单向投递，主线程只读无锁原子快照。

### 待真机验证（与 Electron 版同类的实证项）

- 提权构建后的裸键热键对管理员前台窗口、焦点恢复 + Ctrl+V 注入时延、托盘图标在各缩放档位的清晰度、NSIS 安装器全流程。

## 已知偏差（相对 Electron 版）

- 托盘图标 DPI：移植了按主屏 `scaleFactor` 选恰好物理尺寸图的方案，但 Tauri 的 tray-icon 生成 HICON 路径与 Electron 不同，清晰度需真机复核。
- 浏览态"不抢焦点"沿用 focusable + 焦点事件自动 `SetFocus(NULL)` 的模拟方案（Electron 同款），首帧激活次序需真机复核。
- 快捷键捕获的 accelerator 由渲染层以 Electron 格式上传（`Control+Shift+V` 等），Rust 侧经 global-hotkey 解析注册，行为一致但解析器不同。
