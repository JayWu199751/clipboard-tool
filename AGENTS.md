# ClipboardTool — 仓库约定

## 语言与文档同步

- 全程中文：对话、注释、提交信息、文档。术语以 [CONTEXT.md](CONTEXT.md) 为准，别造同义词。
- 每次改完同步文档：行为变了改 [README.md](README.md)，module 边界或 IPC 变了改 [docs/architecture.md](docs/architecture.md)，当次动机与例数/行数记进 [docs/changelog.md](docs/changelog.md)，难回退的决策进 [docs/adr/](docs/adr/)。同一个意思只留一处权威出处，其余用链接。
- 新会话或新需求开始前先看 `git status`，有未提交代码就先提交，让代码随时可回退。

## 红线

- 改主进程之前先读 [docs/architecture.md](docs/architecture.md) 的「线程模型」节。`global_shortcut` 的 register/unregister 内部会投递主线程并阻塞等待，持锁调用即死锁；这条防线是编译期的，不是注释。
- 新增模式操作只在 `modes.rs` 加具名方法，不要在调用方拼闭包投递；`PanelModes` 不出 module。
- 新代码先判「这是判定还是效果」：判定进 module 并配单测，效果进 `main.rs`（[ADR-0008](docs/adr/0008-rules-in-modules-effects-in-main.md)）。
- 粘贴链路的一步都不能换序（[ADR-0005](docs/adr/0005-focus-paste-order-contract.md)），改前先跑 `paste_chain` 那 9 例。
- 不碰 `%APPDATA%\ClipboardTool` 的存档键名契约（[ADR-0007](docs/adr/0007-reuse-electron-storage-contract.md)）。

## 完成的判据

`tauri/` 下三条全绿，且前两条零输出：

```bash
npm run test                  # 73 例：node 14 + cargo 59
npx tsc --noEmit              # 零报错
cargo check --all-targets     # 零警告（不是零错误——警告也算不过）
```

中文测试名会触发 `non_snake_case`，新测试模块照例加 `#![allow(non_snake_case)]` 以保持零警告。

GUI 行为（提权产物、真机热键与粘贴、托盘缩放清晰度、NSIS）跑不了自动化，需要用户手动验；没验过就直说，别声称验证过。清单在 README「待真机验证」。

## Windows 工具链的坑

这几条都实际踩过一次，会白花时间：

- `core.autocrlf=true`，工作树应为 CRLF，但 `apply_patch` 写入 LF，混合行尾之后它的上下文匹配会**神秘失败**（报错只说找不到行）。每次 `apply_patch` 之后、下一次 patch 之前归一化目标文件：

  ```powershell
  $t=[IO.File]::ReadAllText($p); $n=($t -replace "`r`n","`n") -replace "`n","`r`n"
  [IO.File]::WriteAllText($p,$n,(New-Object Text.UTF8Encoding($false)))
  ```

  批量归一化后 `git diff` 不出噪声（index 存 LF）。
- `apply_patch` 的 `Add File` 偶发报成功但文件没落盘。新建文件后先 `Test-Path` 再继续。
- 单个 patch 里 hunk 过多或过长容易失败，拆小段更稳。
- PowerShell 里 .NET API（`[IO.File]`）不认 `cd`，一律传绝对路径。
- 不要用 `powershell -File xxx.ps1`：本机执行策略禁用脚本文件，用 `-Command` 或内联。

## 跨项目复用

Windows 桌面工具的通用坑（提权与 UIPI、Win32 互操作、浮层窗口、DPI、持久化契约）提炼在 [docs/desktop-tool-pitfalls.md](docs/desktop-tool-pitfalls.md)，新立项时逐条对照设计。
