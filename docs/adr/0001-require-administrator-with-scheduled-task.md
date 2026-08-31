# 整工具常驻提权，经计划任务静默启动

全局热键（底层是 RegisterHotKey）与 `SendInput` 粘贴在目标窗口以管理员运行时会被 UIPI 掐断，而失败时 `GetLastError` 不指认 UIPI，表现为「莫名失效」。我们让**整个应用常驻高完整性**：release 清单 `requireAdministrator`，日常入口一律走计划任务 `ClipboardToolElevated`（`/rl highest`）创建进程，UAC 同意只发生在任务创建那一刻，之后零弹窗。

## Considered Options

- **按需提权**（Ditto 模式，粘贴到提权窗口时弹 UAC 自提权）：每次都要用户点同意，与「后台常驻工具」的体验冲突。
- **`uiAccess=true`**：微软官方限定辅助技术用途，且需 Authenticode 签名 + Program Files 等安全位置。KeePass 官方点名拒绝这条路。
- **不提权 + 降级提示**：PowerToys / espanso / AHK / Greenshot 的用户在提权前台面前都会遇到同样的失效。

## Consequences

- 直接双击 exe 会弹一次 UAC——这是提权的代价，正常路径（快捷方式、开机启动、托盘）不出现。
- `debug` 构建用 `asInvoker`，所以 `tauri dev` 在管理员窗口里复现「热键不响应」属预期，验证管理员场景必须用 release 产物。
- 开机启动不再是独立机制，就是同一个任务的 `AtLogOn` 触发器；开关时带/不带触发器重建任务。
- 清单替换必须保留 Common-Controls 6 依赖与 PerMonitorV2 DPI 感知，否则启动即报 `TaskDialogIndirect` 输入点缺失、或坐标换算全失准（见 [desktop-tool-pitfalls.md](../desktop-tool-pitfalls.md) 第 1 节）。

调研出处与主源引用见 [UIPI-research.md](../UIPI-research.md)。
