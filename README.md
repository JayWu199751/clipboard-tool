# ClipboardTool

Windows 剪贴板历史工具：后台记录复制过的文字与图片，`Ctrl+Shift+V` 呼出一个不抢焦点的置顶浮层，选中即把内容粘贴回你原来打字的输入框。

技术栈 **Tauri 2 + React 19 + Rust**。原 Electron 实现已于 2026-08-31 删除，当前是唯一实现；存档沿用 Electron 版契约，老用户换实现不丢历史（两版不要同时运行）。

## 操作

呼出键默认 `Ctrl+Shift+V`，可在托盘里换。面板显示期间：

| 键 | 浏览态 | 搜索态 |
|---|---|---|
| `↑` `↓` | 选择（长按连续移动） | 在筛选结果里选择（长按连续移动） |
| `Enter` / 双击 / 复制按钮 | 复制并粘贴 | 同左 |
| `Esc` | 隐藏面板并归还焦点 | 先退回浏览态 |
| `空格` | 进入搜索 | 输入空格 |
| `Z` | 置顶 / 取消置顶 | 让位给输入框 |
| `Del` | 删除条目 | 让位给输入框 |
| `B` | 编辑选中项备注 | 让位给输入框 |

- 中文输入法组合期间面板导航键全部暂停，不会误跳选中项。
- 长按 `↑` / `↓` 时选中框与列表滚动即时跟随，不被输入重复速度甩开。
- 搜索匹配正文、备注与来源应用（应用名 / 窗口标题 / 可执行文件路径），空格分词多词 AND、大小写不敏感、命中片段高亮；结果保持原顺序，不做匹配度排序。
- 点击面板外任意处即隐藏；置顶条目固定在最前的置顶块里，新复制插在置顶块之后。

托盘菜单：显示剪贴板面板 / 更换快捷键 / 开机启动 / 退出。

## 安装与构建

```bash
cd tauri
npm install
npm run dev        # vite + 调试 exe（asInvoker，不提权）
npm run build      # release：NSIS 安装包，默认嵌入 requireAdministrator
npm run test       # 全部单测
npm run typecheck  # tsc --noEmit
```

产物：

- 可执行文件 `tauri/src-tauri/target/release/clipboard-tool.exe`
- 安装包 `tauri/src-tauri/target/release/bundle/nsis/ClipboardTool_<version>_x64-setup.exe`（perMachine 安装）

## 提权与管理员窗口

Windows 的 UIPI 会拦截非提权进程对高完整性（管理员）前台窗口的热键投递与 `SendInput` 注入，而且失败时 `GetLastError` 不指认 UIPI，表现为「莫名失效」。本工具的答案是**整个应用常驻提权，界面上不做任何提权提示**：

- release 清单 `requireAdministrator`（由 `build.rs` 注入，保留 PerMonitorV2 DPI 感知与 Common-Controls 6 依赖）；debug 用 `asInvoker`。
- 日常入口（快捷方式、开机启动、托盘）走计划任务 `ClipboardToolElevated`（`/rl highest`）静默拉起，UAC 同意只发生在任务创建那一刻。直接双击 exe 会弹一次 UAC，这是提权的代价，正常路径不出现。
- 开机启动就是该任务的 `AtLogOn` 触发器；意图（`settings.autoStart`）与事实（任务及其触发器是否存在）分离，未提权时先落盘意图、等下次提权启动补建。

理由与被否决的方案见 [ADR-0001](docs/adr/0001-require-administrator-with-scheduled-task.md)、[ADR-0002](docs/adr/0002-no-elevation-ui.md)；主源调研见 [docs/UIPI-research.md](docs/UIPI-research.md)。

> `npm run dev` 始终不提权，在管理员窗口里「热键呼不出来」属预期。验证管理员场景请用 release 产物，或在已提权的 shell 里 `cargo run --release`。

## 数据与存档

`%APPDATA%\ClipboardTool\`：

| 文件 | 内容 |
|---|---|
| `clipboard-history.json` | 历史条目（含置顶、备注、来源应用），schema 与 Electron 版共享 |
| `images/` | 图片条目的 PNG，文件名是条目 id；内容哈希只用于判定条目身份，不进文件名 |
| `settings.json` | `autoStart` / `shortcut`，camelCase 键名（与 Electron 版共享同一份） |
| `diag.log` / `panic.log` | 诊断日志 / release 崩溃落点，见下节 |

## 诊断

| 变量 | 时机 | 作用 |
|---|---|---|
| `CLIPBOARD_TOOL_DIAG=1` | 运行期 | 把呼出 / 复制 / 粘贴各阶段追加写 `%APPDATA%\ClipboardTool\diag.log` |
| `CLIPBOARD_TOOL_POLL_TRACE=1` | 运行期 | 轮询各阶段追踪输出到 stderr |
| `CLIPBOARD_TOOL_ELEVATED=0\|1` | 构建期 | 强制 asInvoker / 强制提权清单；不设时 release 提权、debug 不提权 |

release 是 GUI 子系统，panic 默认看不见，因此统一落到数据目录的 `panic.log`，每次崩溃可追溯。

## 测试

```bash
cd tauri
npm run test        # = test:view + test:rust
npm run test:view   # node scripts/panel-view-unit.mjs —— 14 例
npm run test:rust   # cargo test —— 59 例
npm run test:browser # Playwright UI 回归 —— 1 例（首次需 npx playwright install chromium）
```

73 例全部是纯模块的 interface 直测，零框架 mock：规则住在 module，效果经注入端口进来（[ADR-0008](docs/adr/0008-rules-in-modules-effects-in-main.md)）。分布为 history 15 / panel_modes 12 / paste_chain 9 / poll_baseline 7 / settings 6 / startup 6 / panel_window 4，加渲染层 panelView 14。

`test:browser` 使用 mock Tauri bridge 驱动真实渲染层，覆盖高频上下导航时选中框与列表滚动保持同步；它不并入纯模块测试的 73 例统计。

`cargo check --all-targets` 与 `tsc --noEmit` 必须零警告零报错；中文测试名所需的 `#![allow(non_snake_case)]` 已在各测试模块声明。

## 故障排查

| 现象 | 先查什么 |
|---|---|
| 管理员窗口里热键不响应、粘贴不进去 | 跑的是不是提权产物（`npm run dev` 必然不提权） |
| 普通窗口里呼出键也没反应 | 该键被其它程序占用；用托盘「更换快捷键」重设，注册失败会写 stderr |
| 内容进了剪贴板但没粘贴进输入框 | 看 `diag.log` 的失败阶段：`restore` 是没找回原窗口，`paste` 是找回来了但注入失败；此时面板保持显示是刻意的（[ADR-0005](docs/adr/0005-focus-paste-order-contract.md)） |
| 粘贴后列表闪一下、同内容记成两条 | 轮询基线没同步，即 `paste_chain` 的落位一步没做到 |
| 开机启动开关重开就丢 | `settings.json` 键名契约，见 [ADR-0007](docs/adr/0007-reuse-electron-storage-contract.md) |
| 渲染层收不到任何事件但命令正常 | `src-tauri/capabilities/default.json` 缺 `core:default`：v2 的 ACL 默认拒绝 `plugin:event\|listen`，脚手架模板自带此文件，手工搭建容易漏 |
| 托盘图标发糊 | 非整数缩放下必须按主屏 `scaleFactor` 取恰好物理尺寸的图，见 [pitfalls 第 3 节](docs/desktop-tool-pitfalls.md) |

## 文档地图

| 文件 | 什么时候读 |
|---|---|
| [CONTEXT.md](CONTEXT.md) | 术语的唯一出处；改代码前先对齐说法 |
| [docs/architecture.md](docs/architecture.md) | 改主进程前必读：线程模型与死锁防线、module 清单、IPC 契约 |
| [docs/adr/](docs/adr/) | 8 条难回退的决策与被否决的方案；想推翻任何一条先看对应 ADR |
| [docs/changelog.md](docs/changelog.md) | 每次改动的动机、取舍与行数/例数变化 |
| [docs/design-system.md](docs/design-system.md) | 改视觉前必读：token、排版、圆角、Do / Dont |
| [docs/desktop-tool-pitfalls.md](docs/desktop-tool-pitfalls.md) | Windows 桌面工具的通用坑，跨项目复用 |
| [docs/UIPI-research.md](docs/UIPI-research.md) | 提权结论的主源调研与未验证清单 |
| [AGENTS.md](AGENTS.md) | 给 agent 的仓库约定：语言、行尾、验证命令、红线 |

## 待真机验证

- 提权构建后的裸键热键对管理员前台窗口是否生效（若失效，回退方案是助手键盘钩子）。
- 面板内长按 `↑` / `↓` 连续移动选中框，松开后停止；浏览态与搜索态的首尾边界都应停住。
- 焦点恢复 + `Ctrl+V` 注入的实际时延。
- 托盘图标在 125% / 150% / 175% 各缩放档位的清晰度。
- NSIS 安装器全流程：perMachine 安装、开机启动开关、卸载后任务与存档残留。

相对 Electron 版的已知偏差记在 [docs/architecture.md](docs/architecture.md) 末节。
