# ClipboardTool

Windows 剪贴板历史工具：后台记录复制过的文字与图片，`Ctrl+Shift+V` 呼出一个不抢焦点的置顶浮层，选中即把内容粘贴回你原来打字的输入框。

技术栈 **Tauri 2 + React 19 + Rust**。存档 schema 与键名是已经写在用户磁盘上的既成契约，改动必须兼容旧档（[ADR-0007](docs/adr/0007-storage-key-contract.md)）。

## 操作

界面是 ClipFlow HUD：无边框浮层，尺寸随屏自适应——**高 = 屏幕高的 7/8、宽 = 高的一半**（在 DIP 空间计算，任何 DPI 下占同样的屏幕比例；每次呼出按光标所在显示器重算）。内容 = 60px 搜索头 / 卡片列表 / 30px 快捷键页脚，窗口四缘带 2px 中灰描边（`--window-ring`，亮暗同值、对齐系统窗口边框）。呼出键默认 `Ctrl+Shift+V`，可在托盘里换。面板显示期间：

| 键 | 浏览态 | 搜索态 |
|---|---|---|
| `↑` `↓` | 选择（长按连续移动） | 在筛选结果里选择（长按连续移动） |
| `Enter` / 双击 | 复制并粘贴 | 同左 |
| `Esc` | 隐藏面板并归还焦点 | 先退回浏览态 |
| `空格` | 进入搜索 | 输入空格 |
| `Z` | 置顶 / 取消置顶 | 让位给输入框 |
| `Del` | 删除条目（延迟 6 秒真删，toast 内「撤销」可挽回） | 让位给输入框 |
| `B` | 编辑选中项备注（卡片底部 meta 行的内联输入框） | 让位给输入框 |

- 中文输入法组合期间面板导航键全部暂停，不会误跳选中项。
- 长按 `↑` / `↓` 时选中框与列表滚动即时跟随，不被输入重复速度甩开。
- 键盘导航把选中项滚到列表边缘时，顶部滚到的是 `scroll-padding` 留白内侧（渐隐遮罩已随 HUD 退役）；回到第一项时列表也回到呼出时的位置。
- 列表滚动条是自绘 4px 细条，住在右侧 16px 留白内、滚动后约 1 秒自动隐藏——原生条在真机占布局宽度，会把卡片右缘到边框的距离垫得比左缘宽，隐藏后左右对称。
- 卡片自上而下 = 内容 → meta 行。内容：文字卡正文 3 行 clamp；图片卡 150px 真实缩略图（棋盘格底）+ mono 文件名（磁盘真名 `<id>.png`）。meta 行 = 来源应用 · 时间 ·（可选）图钉 ·（可选）备注，单行省略号；文字/图片不设类型标识，由内容形态本身区分。右上角没有复制按钮（2026-09-11 随用户要求删除），鼠标复制走双击卡片。
- 页脚快捷键提示与搜索井右侧的键名 chip 由真实键位表在启动时生成（`keyboard.ts` 注册表，一组一枚 chip）；页脚只列面板可见时用上的键——搜索键住搜索井，呼出键的展示归托盘菜单与捕获覆盖层。「提示 = 行为」不漂移；渲染层镜像与 Rust `NAV_SHORTCUTS` 的一致性由单测跨语言对表钉住。
- 删除是延迟落盘的：Del 先把条目从可见列表摘除并起 6 秒撤销窗口，到点才调 `clipboard_remove` 持久化；撤销 = 摘除隐藏。面板停靠再呼出时计时继续；同一条目的重复请求沿用原窗口。命令返回失败或异常时恢复条目，并提示「删除失败，请重试」。6 秒内强退应用则该条不会被删（已确认的取舍）。
- 搜索匹配正文、备注与来源应用（应用名 / 窗口标题 / 可执行文件路径），空格分词多词 AND、大小写不敏感、命中片段高亮；结果保持原顺序，不做匹配度排序。
- 图片复制与文字一样进历史（含 PixPin、`Win+Shift+S` 这类截图工具产出的位图），条目身份按图片内容判定，见 [ADR-0009](docs/adr/0009-clipboard-image-decoded-in-house.md)。卡片外观见上一条。
- 点击面板外任意处即隐藏；置顶条目固定在最前的置顶块里，新复制插在置顶块之后；HUD 里置顶只以 meta 行的图钉图标呈现。
- 面板收起时停到当前显示器工作区右侧之外，并按实际高度竖直居中，不贴顶部或底部；居中范围扣除任务栏占用。
- 点击卡片 = 仅选中；复制并粘贴走 Enter / 双击（用户拍板保留原应用鼠标语义，未采用源 UI 的「点击即复制」）。

托盘菜单：显示剪贴板面板 / 更换快捷键 / 开机启动 / **主题 ▸（亮色、暗色、跟随系统）** / 清空历史 / 退出。「清空历史」由菜单回调直调存储层（标题栏随 HUD 退役，不走 IPC）。

常驻期间应用的图标**只在托盘**，任务栏不该有它的面板按钮。这件事没法只靠配置：`tauri.conf.json` 的 `skipTaskbar: true` 会被 tao 自己抵消——它对「无父窗口」的窗口一律置 `ON_TASKBAR`（→ `WS_EX_APPWINDOW`，强制上任务栏），并在 `set_visible` 里按内部 flags 整体重写 `GWL_EXSTYLE`（真机实测面板窗口 `ex=0x00040000|0x100|0x10|0x8`）。所以样式位由 `PanelWindow::show()` 在 `win.show()` **之后**改回来，并补一次框架的 `set_skip_taskbar`。开机启动最容易撞见：那一刻 explorer 还没建任务栏，它建好后会把当时已可见的窗口逐个登记一遍，而面板的「关闭」只是[停靠](CONTEXT.md)到屏外（窗口始终可见），于是任务栏上多一个点了没反应的按钮。机制与为什么不补 `DeleteTab` 就完事见 [pitfalls 第 3 节](docs/desktop-tool-pitfalls.md)。

搜索井右侧、空格提示左侧有主题按钮，点击按**亮色 → 暗色 → 跟随系统 → 亮色**循环；太阳 / 月亮 / 显示器图标表示当前主题偏好，悬停提示当前与下一态。搜索态下按钮仍可用，切换保留搜索文字与输入焦点；浏览态点击按钮不会进入搜索。按钮与托盘「主题」子菜单同步，偏好继续存入 `settings.json`，重启后保留。

「跟随系统」是默认值，也是唯一会被 Windows 亮暗设置带着走的一态；选了亮色或暗色，系统再翻也不影响面板，但**托盘图标仍跟任务栏**（判的是[任务栏主题](CONTEXT.md) `SystemUsesLightTheme`）。生效主题仍由网页的 `prefers-color-scheme` 决定，按钮读到的偏好仅用于展示；送达方式与理由见 [ADR-0012](docs/adr/0012-theme-preference-in-main-process.md)。

## 安装与构建

```bash
cd tauri
npm install
npm run dev        # vite + 调试 exe（asInvoker，不提权）
npm run build      # release：NSIS 安装包，默认嵌入 requireAdministrator
npm run test       # 全部单测
npm run typecheck  # tsc --noEmit
npm run gen:tray   # 重新生成托盘图标阶梯图（改过图标后必跑）
```

产物：

- 可执行文件 `tauri/src-tauri/target/release/clipboard-tool.exe`
- 安装包 `tauri/src-tauri/target/release/bundle/nsis/ClipboardTool_<version>_x64-setup.exe`（perMachine 安装）

托盘图标不是一张图缩放出来的：`src-tauri/icons/tray/` 下 16/20/24/28/32 五档 × 亮暗两套，加上两张 32px 基图共 12 张，主进程按主屏 `scaleFactor` 取恰好物理尺寸的那张交给 HICON；亮暗两套按**任务栏主题**挑，缩放或明暗变了才重设（同键不动，见 `tray.rs::icon_key`）。`gen:tray` 用参数化 SDF 在每个尺寸上各自解析求值直出，绝不做重采样；几何参数是拿 32px 基图坐标下降拟合出来的（`--fit` 可重跑），落盘后逐张回读自校。换图形的手顺写在 [scripts/gen-tray-icons.mjs](tauri/scripts/gen-tray-icons.mjs) 的文件头。

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
| `clipboard-history.json` | 历史条目（含置顶、备注、来源应用），schema 是持久化契约，改动须兼容旧档 |
| `images/` | 图片条目的 PNG，文件名是条目 id；内容哈希只用于判定条目身份，不进文件名 |
| `settings.json` | `autoStart` / `shortcut` / `theme`（`system`\|`light`\|`dark`，缺键与非法值回落 `system`），camelCase 键名不可改，见 [ADR-0007](docs/adr/0007-storage-key-contract.md) |
| `diag.log` / `diag.log.1` | 诊断日志：`vital` 行无条件写，逐事件行要开关；超过 512 KB 轮转一代，见下节 |
| `panic.log` | release 崩溃落点 |

## 诊断

`diag.log` 里有两档，同写一个文件（决策与理由见 [ADR-0013](docs/adr/0013-vital-readings-on-boot-path.md)）：

| 档 | 前缀 | 门禁 | 内容 |
|---|---|---|---|
| vital | `vital pid=<n> ` | **无条件写** | 呼出链路每一段的成败各一行：`start` / `renderer-first-call` / `hotkey_register` / `summon-req`（`src=hotkey\|tray-click\|tray-menu\|instance`；第二实例赶在启动期时带 `waited=<ms>`，始终没等到 `AppState` 就 `dropped`） / `summon-run`（含 `latency_ms=`、`renderer=`，无请求时刻时是 `n/a`） / `summon-landed`（含 `first=`/`final=`/`repair=`） / `summon-no-*` / `dispatch-failed\|recovered\|lost` / `*-missing-window` / `make-visible via ShowWindow\|failed` / `emit-failed` / `hide reason=` / `warmup` 与 `warmup-park` / `exit-requested` / `exit` |
| verbose | — | `CLIPBOARD_TOOL_DIAG=1` | 逐事件流水（`show_panel`/`hide_panel`/`dispatch_hotkey`/`park-offscreen`/`click_ignored`/`tray-icon`/`apply_startup_intent`…） |

前者是为「只在开机那一次出现」的问题准备的：现场只有一份，取不到就等于没有（2026-09-20 那轮把读数挂在环境变量上，结果 2026-09-27 那次开机一个字都没留下）。后者嘈杂，默认关。日志超过 512 KB 时旧文件挪成 `diag.log.1`，所以它不会无界增长。每行 vital 都带 `pid=`：探针要查「同时活着两份」，而两份的读数是交错写的，不按 pid 分组会把两条链读成自相矛盾的一条。

| 变量 | 时机 | 作用 |
|---|---|---|
| `CLIPBOARD_TOOL_DIAG=1` | 运行期 | 打开 verbose 那一档 |
| `CLIPBOARD_TOOL_POLL_TRACE=1` | 运行期 | 轮询各阶段追踪输出到 stderr |
| `CLIPBOARD_TOOL_ELEVATED=0\|1` | 构建期 | 强制 asInvoker / 强制提权清单；不设时 release 提权、debug 不提权 |

release 是 GUI 子系统，panic 默认看不见，因此统一落到数据目录的 `panic.log`，每次崩溃可追溯。

## 测试

```bash
cd tauri
npm run test        # = test:view + test:rust
npm run test:view   # node scripts/panel-view-unit.mjs —— 49 例
npm run test:rust   # cargo test —— 108 例（另有 2 例真机探针 #[ignore]）
npm run test:browser # Playwright UI 回归 —— 18 例（首次需 npx playwright install chromium）
```

157 例通过 module 的 interface 测判定与协议，零框架 mock：规则住在 module，效果经注入端口进来（[ADR-0008](docs/adr/0008-rules-in-modules-effects-in-main.md)）。分布为 history 15 / panel_modes 16 / paste_chain 9 / hotkeys 9 / poll_baseline 9 / dib 7 / settings 9 / startup 6 / panel_window 16 / tray 9 / clipboard 1 / webview_theme 1 / diag 1，加渲染层 49（panelView 32：过滤 7 / 高亮 4 / 选中项 3 / 圆角外穿透 6 / 相对时间 4 / 按键码 4 / 滚动条 3 / 主题按钮 1；keyboard 7：注册表 6 + 跨语言键位对表 1；pendingDeletion 5；themeSync 5）。另有 2 例 `#[ignore]` 的真机探针：`clipboard.rs` 的剪贴板图片探针（那一类要真机才有答案），与 `clipboard_probe.rs` 的剪贴板通知探针（量「轮询要不要换成系统监听」这个决策的三个未知项）。跑法都见「待真机验证」。

`test:browser` 使用 mock Tauri bridge（`tests/panel-harness.js`）驱动真实渲染层，18 例覆盖导航与滚动、窗口描边、备注编辑、延迟删除的撤销与跨呼出计时及两种失败恢复，以及主题按钮的三态循环、启动与外部同步、迟到读取、搜索焦点保留和失败重试；它不并入上述 157 例统计。真实 Win32 窗口落地、WebView2 换色与存档重启仍需真机验（见下）。

`cargo check --all-targets` 与 `tsc --noEmit` 必须零警告零报错；中文测试名所需的 `#![allow(non_snake_case)]` 已在各测试模块声明。

## 故障排查

| 现象 | 先查什么 |
|---|---|
| 管理员窗口里热键不响应、粘贴不进去 | 跑的是不是提权产物（`npm run dev` 必然不提权） |
| 普通窗口里呼出键也没反应 | `diag.log` 的 `vital hotkey_register` 那行：不是 `Registered` 就是没注册上（该键被别的程序占了，用托盘「更换快捷键」重设）。启动后 5 秒 / 20 秒各有一次自动重试（`vital hotkey-retry n= accel=`），瞬时占用会自愈；重试每次都现读存档里的键，所以它不会把用户刚换的键顶回去 |
| 三条呼出路径（热键 / 托盘左键 / 托盘菜单）都呼不出界面 | 先按 `pid=` 分组，再逐段看（逐段判据的权威出处是 [`tauri/scripts/panel-state.ps1`](tauri/scripts/panel-state.ps1) 的脚本头，别背）：有 `summon-req` 没有 `summon-run` = 执行线程没接手（后面应有 `executor-dead` / `executor-exit`）；`summon-no-*` = 已经到主线程、只是缺前提（`missing-window` / `no-cursor` / `no-monitor` / `no-primary`），它**不**等于主线程没跑；有 `summon-run` 没有 `summon-landed` = 那一次被判给更新的几何效果（丢弃只在 verbose 档留痕），也不是主线程没跑；`summon-landed final=Hidden\|Moved\|Offscreen` = 窗口没落地（`repair=` 说明补过哪一步，`final` 仍是失败才有问题）；`summon-run renderer=never` = 网页压根没起来，窗口落地也是白的；`emit-failed` = 窗口落地了但事件送不出去，看着就是「出来了却什么都没有」。五种处置不同，别混着猜 |
| 内容进了剪贴板但没粘贴进输入框 | 看 `diag.log` 的失败阶段：`restore` 是没找回原窗口，`paste` 是找回来了但注入失败；此时面板保持显示是刻意的（[ADR-0005](docs/adr/0005-focus-paste-order-contract.md)） |
| 粘贴后列表闪一下、同内容记成两条 | 轮询基线没同步，即 `paste_chain` 的落位一步没做到 |
| 开机启动开关重开就丢 | `settings.json` 键名契约，见 [ADR-0007](docs/adr/0007-storage-key-contract.md) |
| 任务栏（不是托盘）挂着一个图标，点了没反应 | 那是面板自己的按钮：窗口以「停靠到屏外」代替隐藏、始终可见，开机时 explorer 建任务栏会把它登记一遍。样式位在 `PanelWindow::show` 的 `win.show()` 之后改（`skipTaskbar` 配置会被 tao 的 `ON_TASKBAR` 抵消），读数见下一行 |
| 应用不见了 / 不知道它什么时候没的 | `vital exit-requested` / `vital exit` 是它自己走的（带退出码）；两行都没有 = 被外部结束的（任务管理器 / 崩溃），崩溃另有 `panic.log`。顺带 `vital start` 记着每次启动的通道与 exe 路径（pid 在 vital 行的统一前缀里） |
| 点托盘图标没反应，但右键菜单正常 | 外壳对一次左键点击发来 `Click(Down)` + `Click(Up)` 两条事件：两条都投呼出就是同一次点击开两次面板。更隐蔽的是全局鼠标钩子那条链是异步的，同一次点击的「按下」可能**晚于**呼出到达执行线程，于是面板刚显形就被判成「点了面板外」收起——机器忙（开机那一刻）就中，空闲时不中。现在只认左键抬起，且早于最近一次呼出的点击一律不收（`panel_modes::hides_on_click`）；vital 里 `summon-landed` 紧跟 `hide reason=outside` 就是这个竞态 |
| 深色任务栏上图标是深色的（看不清） | 托盘图标看的是**任务栏主题**（`SystemUsesLightTheme`，Windows 模式），不是应用模式（`AppsUseLightTheme`）——「个性化 → 颜色 = 自定义」下两者可以相反。探针的 `theme =` 那行同时打两个值，再对 `diag.log` 的 `tray-icon` 行看选了哪一套。运行中翻系统主题靠 `WM_SETTINGCHANGE` 广播刷新，广播收不到时悬停一次图标就会重核（`pointer_entered`） |
| 渲染层收不到任何事件但命令正常 | `src-tauri/capabilities/default.json` 缺 `core:default`：v2 的 ACL 默认拒绝 `plugin:event\|listen`，脚手架模板自带此文件，手工搭建容易漏 |
| 托盘图标发糊 | 非整数缩放下必须按主屏 `scaleFactor` 取恰好物理尺寸的图，见 [pitfalls 第 3 节](docs/desktop-tool-pitfalls.md) |

## 文档地图

| 文件 | 什么时候读 |
|---|---|
| [CONTEXT.md](CONTEXT.md) | 术语的唯一出处；改代码前先对齐说法 |
| [docs/architecture.md](docs/architecture.md) | 改主进程前必读：线程模型与死锁防线、module 清单、IPC 契约 |
| [docs/adr/](docs/adr/) | 12 条难回退的决策与被否决的方案；想推翻任何一条先看对应 ADR |
| [docs/changelog.md](docs/changelog.md) | 每次改动的动机、取舍与行数/例数变化 |
| [docs/design-system.md](docs/design-system.md) | 改视觉前必读：token、排版、圆角、动效与减少动态、组件映射、Do / Don't |
| [docs/desktop-tool-pitfalls.md](docs/desktop-tool-pitfalls.md) | Windows 桌面工具的通用坑，跨项目复用 |
| [docs/UIPI-research.md](docs/UIPI-research.md) | 提权结论的主源调研与未验证清单（一次性调研存档，保持原样不改写） |
| [AGENTS.md](AGENTS.md) | 给 agent 的仓库约定：语言、行尾、验证命令、红线 |

## 待真机验证

- 收起时竖直居中（2026-10-02）：在不同 DPI 与任务栏位置下呼出再收起，确认停靠位置按面板实际高度在工作区内竖直居中，重新呼出位置正常；纯几何回归已覆盖顶部任务栏、2 倍缩放及副屏原点，真实窗口移动仍需点验。

- 延迟删除（2026-10-02）：按「操作」节执行删除与撤销，并在撤销窗口内停靠再呼出，确认条目可见性与实际存档结果一致；浏览器回归已验证 IPC 接线与时序，真实 WebView2 到存储层仍需点验。
- 开机启动不再挂任务栏图标（2026-09-19 第二轮，第一轮已被实测证伪）：注销再登录（或直接重启）后，任务栏上**不该**有 ClipboardTool 图标，图标只剩托盘那一个；`Alt+Tab` 里也不该出现一个看不见的面板。读数用 [`tauri/scripts/panel-state.ps1`](tauri/scripts/panel-state.ps1)：`panel` 那行的 `ex` 应含 `TOOLWINDOW`、不含 `APPWINDOW`（改前实测是 `0x00040118(TOPMOST|APPWINDOW)`）。顺带确认这次改样式位没碰坏取焦点：呼出键与托盘「显示剪贴板面板」照常把面板居中唤出、进搜索态后键盘确实打进搜索框（工具窗口照样可前台、可 `SetFocus`，但只有真机能证明）。**同日另一条独立问题（开机启动后两路呼不出界面）已在下一轮动手改，见下一条与「故障排查」那三行。**
- 开机那一次不再「三路呼不出」（2026-09-20 首改、2026-09-27 加回读与无条件读数，**必须重启一次才有结论**）：登录后先别手动重开应用，直接按 `Ctrl+Shift+V` → 点托盘图标 → 托盘菜单「显示剪贴板面板」，三条都要能把面板叫出来。这次不管中不中，`diag.log` 都会有读数（vital 行无条件写、带 `pid=`，不需要设任何环境变量）：任一条不中就跑 [`tauri/scripts/panel-state.ps1`](tauri/scripts/panel-state.ps1) 两次（呼出前 / 后）并把输出贴回来，脚本头写着逐段分流（先按 `pid=` 分组）——`summon-req` 有而 `summon-run` 没有 = 执行线程没接手；`summon-no-*` = 到主线程了但缺前提（不等于主线程没跑）；`summon-run` 有而 `summon-landed` 没有 = 那一次被判给更新的几何效果（也不是主线程没跑）；`summon-landed final=` 不是 `Landed` = 窗口没落地（那行末尾有 `repair=`）；`summon-run renderer=never` = 网页没起来；`emit-failed` = 落地了但事件送不出去。呼出键注册成没成看 `vital hotkey_register ... Registered`；进程怎么没的看 `vital exit-requested` / `vital exit`；登录后 120ms 内的那次热身停靠若撞上呼出，会留 `vital warmup-park: summon already requested, park skipped`（有它说明让位逻辑生效，面板不该在屏外）。**热键不灵时先别急着下结论**：再启动一次应用（第二实例）走的是同一条 `show_on`——若这样能呼出、日志里出现 `summon-req src=instance`，说明卡的是热键注册那一段，而不是呼出链路（反过来也成立：`src=instance` 也不出来，才是链路本身的问题）。
- 托盘图标跟的是任务栏而不是面板皮肤（2026-09-20 改判）：把「个性化 → 颜色 → 选择默认模式」设成**自定义**、让「Windows 模式」与「应用模式」相反（例如 Windows 暗、应用亮），托盘图标该是**白色**那套（跟任务栏），面板皮肤该是**亮色**那套（跟主题偏好＝跟随系统时看应用模式）。再在运行中翻一次系统主题：图标应跟着换；若不动，把鼠标移到图标上悬停一下（那次 `Enter` 是广播收不到时的兜底），看 `diag.log` 有没有新的 `tray-icon` 行。
- 提权构建后的裸键热键对管理员前台窗口是否生效（若失效，回退方案是助手键盘钩子）。
- 面板内长按 `↑` / `↓` 连续移动选中框，松开后停止；浏览态与搜索态的首尾边界都应停住。
- 真机亮 / 暗主题下滚到列表首尾，选中卡片完整可见、顶部留在 scroll-padding 留白内（几何由 `test:browser` 守住，实际合成与 DPI 仍需眼看）。
- 面板主题按钮（2026-10-01）：按「操作」节切换三态，确认面板保持可见时即时换肤、搜索输入继续接收文字；与托盘互相切换后图标一致，重启后保留偏好。浏览器替身不能证明真实 WebView2 换色、全局热键与焦点快照均正常，需人工验证。
- HUD 迁移（2026-09-08）后：亮 / 暗两主题整体观感对照 `clipboard-app/` 源 UI（token 面为不透明实底，旧毛玻璃与「降低透明度」分支已退役）；OS 切亮暗应即时换肤、无刷新、无 FOUC（默认态就是跟随系统）；列表自绘滚动条细条的观感与「滚动后约 1 秒自动隐藏」的节奏一并确认（卡片左右缘到边框对称由浏览器探针守住，真机滚动条占位差异正是这次修复的动机）。
- 主题三态（2026-09-11，[ADR-0012](docs/adr/0012-theme-preference-in-main-process.md)）：托盘右键 → 「主题」子菜单，选「亮色」后面板应立刻变亮（把 Windows 本身设成暗色最能看出区别）；子菜单标题里的「当前: X」跟着变，三项中恰好一项打勾。选成手动亮之后在 Windows 设置里翻系统主题，**面板不该动、托盘图标该照旧跟任务栏**；再选回「跟随系统」，面板应立刻跟上系统色。重启应用确认偏好仍在（`settings.json` 里 `"theme":"light"`）。若切换后当下不变色、要重启才变，说明运行时那次 `put_PreferredColorScheme` 没触发页面重算（呼出时的重刷就是给这种情况兜底的）；连呼出重刷也不灵，就回 ADR-0012 重议送达方式。
- 应用边框描边（2026-09-08 返修 4–9）：亮 / 暗两主题下四缘中灰实线（#757575，2px，返修 9 由 1px 加粗换圆弧 AA 翼）应清晰可见、等宽，四角弧段与直边观感等宽一并确认；`.desktop` 一律留 1 CSS px 内边距（真机 175% 实证设备像素级「恰好」会被取整方向吃掉右缘描边，档位媒体查询阶梯已废）；页脚六组提示末组与右缘应留出可见空隙（真机字体比 headless 宽，组距已收进 8px）。100% / 125% / 150% / 175% / 200% 各档位一并确认。
- 三处圆角（2026-09-11）：窗口外壳 36px、复制项 12px、搜索井左右半圆（胶囊）。**已真机确认：36px 下圆角处的描边显示正常**——2026-09-08 返修 9 那条「弧比直边显窄」的混叠错觉（也正是把描边从 1px 加回 2px 的起因）没有复燃，这是本轮最初的风险点。仍未确认：亮 / 暗两主题对比，以及 100% / 125% / 150% / 175% / 200% 各缩放档。日后若真机报弧段显细，先量弧的 AA 翼（口径同 `window-ring` 用例），别直接动 `border-width`。
- 圆角穿透半径（自 2026-09-07 起由样式表 `--radius-window` 读出，现值 36px——改样式表即生效，无需改代码）：面板四角「看不见的圆弧外」点击应落到下层窗口，且穿透边界与看到的圆角重合。
- 删除撤销（HUD 迁移新增）：Del 后条目立即从列表消失、红色 toast 带「撤销」，6 秒内点撤销条目回到原位置；到点后重启应用确认该条确已删除。
- 换键与清空（HUD 迁移新增）：托盘「更换快捷键」的当前键文案与捕获覆盖层应显示新键；托盘「清空历史」应清空列表并落盘；页脚六组 chip 间距均匀、`Esc隐藏` 组完整可见不被窗口右缘裁掉。
- 置顶在 HUD 里的可见性：Z 置顶后卡片 meta 行应出现图钉图标，置顶块顺序规则不变。
- 卡片改版（2026-09-11）：卡片自上而下应是「复制内容 → 来源应用 · 时间（· 图钉）（· 备注）」，且**不再有文字/图片类型标识**（那枚小图标已删，两种卡靠内容形态本身区分）。亮 / 暗两主题各看一遍：卡片右上角**不应再有「复制」按钮**（2026-09-11 已删），但**双击卡片仍要能复制并粘贴**（已真机确认）——这是删掉胶囊后鼠标唯一的复制入口；文字卡长文本在 hover / 选中时首行右端应占满整行、不再收窄（68px 让位随胶囊退役）；图片卡「缩略图 → 文件名 → meta 行」两段间距都是 12px；按 `B` 编辑备注时输入框在最下一行。
- 截图进历史（2026-09-06 修复）：重新构建后用 PixPin / `Win+Shift+S` 截一张，历史里应出现一条图片条目，缩略图与详情正常；带透明背景的截图 alpha 应保留。断在哪一步由探针报：`cargo test --bin clipboard-tool -- 真机探针 --ignored --nocapture`（在 `tauri/src-tauri/` 下跑）。
- 剪贴板监听改走系统通知后（2026-09-10，[ADR-0011](docs/adr/0011-clipboard-watch-via-events.md)）：**刚复制完立刻按呼出键，列表里就该有这一条**（改前最多要等 600ms）；在很短时间里连着复制两段，两条都该进历史——这是换事件模型真正买到的收益，序列号短路买不到。断在哪一步看 `diag.log`：`clipboard-occupied` 表示那一轮剪贴板被别的程序占着、已排重试。**4K 全屏截图**（`Win+Shift+S` 拖满整屏）单独试一次：探针只量到普通截图的 13.8ms，大图写入更慢，若超过 80ms 预算，靠的就是这条重试路径，历史里仍应出现。
- 底层行为可用探针复验（2026-09-10 加，只读不写）：`cargo test --bin clipboard-tool -- 剪贴板通知探针 --ignored --nocapture`——**必须在管理员终端跑**，否则「提权进程能否收到通知」那一问无效；窗口期（默认 25 秒，`CLIPBOARD_PROBE_SECS` 可调）内复制若干次。**2026-09-10 已跑两轮（管理员终端：文本 8 条 + 截图 5 条）：** ① 提权进程收到全部通知（普通程序与管理员程序两种源都收到），UIPI 不拦，**事件模型可用**；② 通知到达时 `GetOpenClipboardWindow()` 恒为「无人持有」，「等到可读」分两条路径——文本最长 **0.7ms**（写入极快，通知到达时已经写完）、截图最长 **13.8ms**（位图写入慢，通知确实落在写入中段），两者都低于现状预算（图片 8×10ms、文字 arboard 5×5ms），事件模型**无需放宽重试**；③ **一次复制 = 一条通知、无半成品读取**——两轮的序列号增量恒等于「格式数 + 1」（文本 7 格式→+8，截图 6 格式→+7，与冒烟时 `clip.exe` 的 4 格式→+5 同律），故每条通知到达时都已是终态，debounce 亦非必需。**探针自报的「间隔 <300ms = 同一动作多段通知」是误报**：它拿时间间隔做代理指标，应以序列号增量为准。**未覆盖**：探针当时是唯一的剪贴板监听者（真实运行时要与本应用、Win+V、输入法同抢那把锁，两位数毫秒是最乐观的读法）。决策见 [ADR-0011](docs/adr/0011-clipboard-watch-via-events.md)，读数口径见 [changelog](docs/changelog.md)。
- 焦点恢复 + `Ctrl+V` 注入的实际时延。
- 快捷键捕获覆盖层（2026-09-07 输入态收口后）：捕获中改从托盘或渲染层进入搜索 / 备注时，覆盖层应随 `shortcut:capture-end` 收起，不再留在屏幕上。
- 热键记账并成一份（2026-09-07，第三轮深化候选 6）后：呼出键、面板导航键、托盘「更换快捷键」三条路都要照常生效；重点看「按住 `↑` / `↓` 连发、松开即停」——连发的武装与解除现在都走执行线程（登记住在 `modes.rs` 的宿主里，不再由主线程持有），松开事件排在长任务后面时停手会略晚一帧。
- 动态窗口尺寸（2026-09-08）：不同分辨率 / DPI 的显示器上呼出，面板高应为屏幕高约 7/8、宽为高一半且居中不压任务栏；拖到另一块不同缩放的屏再呼出，尺寸应跟着那块屏重算。窄屏（<400px 宽）下页脚应逐级收紧而非裁掉右边的组。
- 备注编辑态（2026-09-11）：按 `B` 时卡片与下方列表应**纹丝不动**（修前输入框比 meta 行高 6.8px，一按就撑高卡片、下方整列下跳），输入框与 meta 文本等高、里面的字上下不被裁；真机字体比 headless 宽，100%–200% 各缩放档一并看（几何由 `note-input-ring` 的编辑态用例守住）。
- 备注框焦点环（2026-09-08 返修）：按 `B` 进内联编辑，输入框应只有一圈柔光焦点环、上下完整不伸出 meta 行（修前被裁成左右两截「括号」）；100%–200% 各缩放档一并看（几何由 `note-input-ring` 两例守住，`overflow-clip-margin` 在分数缩放下的取整仍需眼看）。
- 托盘图标在 125% / 150% / 175% 各缩放档位的清晰度。判定半边已由 `tray` 3 例单测兜住（缩放取档、去重键、菜单文案），剩下的「最终 HICON 是否仍糊」只能眼看。
- NSIS 安装器全流程：perMachine 安装、开机启动开关、卸载后任务与存档残留。

自动化测不到的实现细节另见 [docs/architecture.md](docs/architecture.md) 末节「待真机复核」。
