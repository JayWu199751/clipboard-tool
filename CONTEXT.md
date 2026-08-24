# ClipboardTool 项目上下文

> 本文档是工程的「共享词汇 + 决策档案」。项目本身见 [README.md](README.md)。

## 项目概述

Windows 剪贴板历史工具（Electron + React + Vite）。主进程轮询剪贴板（600ms），把文字/图片历史存入 `%APPDATA%\ClipboardTool\clipboard-history.json`；渲染进程只负责面板 UI 与键盘导航。全局快捷键 `Ctrl+Shift+V` 呼出不可激活（WS_EX_NOACTIVATE）的置顶浮层面板，不抢占输入框焦点。

## 领域词汇

| 术语 | 含义 |
| --- | --- |
| 历史条目（ClipboardEntry） | 一条剪贴板记录，`text` 或 `image` 类型；主进程内存中额外持有 `imagePath`，渲染层收到的是 `dataUrl` |
| 历史（history） | 主进程内存数组，顺序即面板显示顺序；最新使用在最前 |
| 置顶（pinned） | 条目上的布尔标记；置顶条目固定排在列表最前，重启后保留 |
| 置顶时间（pinnedAt） | 最近一次置顶的时间戳（毫秒）；未置顶为 0，多个置顶条目按它新→旧排序 |
| 置顶块 | 列表头部所有置顶条目形成的连续块；新复制内容永远插在它之后 |
| 普通块 | 置顶块之后的普通条目，按最近使用（复制/新建）新→旧排列 |
| 来源应用（SourceApp） | 复制时前台应用（exePath / appName / windowTitle / iconDataUrl），轮询 A 版方案 |
| 常驻提权 | 应用始终以高完整性运行（exe 清单 requireAdministrator）；UIPI 不拦截其热键与输入注入，管理员目标窗口照常工作 |
| 静默启动通道（计划任务） | `ClipboardToolElevated`（/rl highest）：快捷方式经 task-launcher.exe 运行时直接以管理员令牌创建进程，不弹 UAC；开机启动 = 其 onlogon 触发器 |
| 开机启动意图（autoStart） | settings.json 持久化的用户意图；运行时事实（任务触发器是否存在）每次由开关操作重建 |
| 面板键捕获通道 | 面板显示期间拦截 ↑↓/Enter/Esc/Del/Z/空格 的机制：主进程 globalShortcut（RegisterHotKey），提权后对所有完整性窗口生效 |
| 搜索模式（searchActive） | 面板的输入态：常驻搜索框由灰色禁用变为可编辑，窗口临时可聚焦以支持文字输入（含中文 IME）；Space/Z/Del 让位给输入框，↑↓/Enter/Esc 保持面板语义 |

## 架构脉络

- `electron/main.js`：剪贴板轮询、去重、历史持久化、全局快捷键（呼出 + 面板导航 `↑/↓/Enter/Esc/Del/Z/空格` + 搜索模式切换）、自动粘贴、托盘、计划任务管理（静默提权启动/开机启动）。
- `electron/preload.js`：`contextBridge` 暴露 `window.clipboardAPI`（getHistory / onUpdated / copy / remove / pin / clear / 快捷键）。
- `src/App.tsx`：面板 UI、主题、键盘逻辑（主进程面板键经 `panel:key` 转发）、快捷更换覆盖层。
- 数据流向：主进程维护唯一真相，`broadcast()` 推 `clipboard:updated` 给渲染层；渲染层不直接改数组。

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

1. **搜索范围**：匹配文本条目的 `text` + 来源应用 `appName` / `windowTitle` / `exePath`（图片可经来源应用搜到）。
2. **输入方式**：按空格进入搜索时窗口临时 `setFocusable(true)` + focus 聚焦输入框，正常输入（含中文输入法）；退出搜索时 `setFocusable(false)` + blur 归还焦点；中文 IME 组合期间暂停全部导航键。
3. **按键语义**：浏览模式空格=进入搜索；搜索模式空格=输入空格（主进程注销 Space 拦截）；Esc 两层（搜索→浏览→关面板）；搜索模式下 Z/Del 让位给输入框，↑↓/Enter 仍操作面板（针对筛选结果）。
4. **结果排序**：保持原始顺序（置顶块 + 最近使用），不做匹配度排序；每次查询变化选中项重置到第一个匹配项。
5. **匹配规则**：大小写不敏感；空格分词多词 AND；文本条目命中片段用 `<mark class="highlight">` 高亮（accent 底色）。
6. **显示与生命周期**：搜索框常驻顶栏下方、未激活灰色禁用态（点击整条也可进入搜索）；每次面板呼出和退出搜索清空查询；空查询显示完整历史列表。

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

- **搜索功能**（2026-08-25，grill-with-docs 定稿）：主进程 `Space` 面板键 + `searchActive`/`searchComposing` 状态机（按搜索模式切换注册的快捷键集合：Space/Z/Del 让位、IME 组合暂停导航）；preload 新增 `activateSearch` / `setSearchComposing`；渲染层常驻搜索框（灰色禁用态↔激活态）、text+来源应用过滤（空格分词 AND、大小写不敏感）、`<mark>` 命中高亮、空查询/无匹配空状态、动态底部提示；README/CONTEXT 同步。
- **常驻提权改造**（2026-08-23，grill-with-docs 定稿）：`requireAdministrator` 清单 + 计划任务静默启动；退役提权助手（elevated-helper/管道/SendInput/开关 UI/`elevatedPaste`/`helperToken`）；开机启动改由计划任务 onlogon 触发器管理（意图存 `autoStart`）；新增 `task-launcher.cs` / `installer.nsh` / `ensureElevatedTask` / `setAutoStart`；README 与本文档同步。
  - **实施细节**：任务注册用 PowerShell `Register-ScheduledTask`（schtasks `/create` 强制要求 `/sc`；COM `RegisterTaskDefinition` 本机稳定报 (38,4)）——无触发器版本仅作静默拉起通道，开机启动=带 `AtLogOn` 触发器重建；启动器传参用 `-EncodedCommand` 免引号转义；任务 Run 用 COM 晚绑定（`Run((object)null)` 防参数计数错）。
  - **已实证**：打包产物 exe 清单含 `requireAdministrator`；端到端 `task-launcher.exe → 创建任务(exit=0) → 任务 Running → 主程序提权启动` 全部通过（本机提权 shell 下验证）。待用户桌面验证：非提权 explorer 经任务静默拉起无 UAC；提权后裸键热键对管理员前台生效（失效则回退助手键盘钩子方案）。
- 置顶功能：新增 `clipboard:pin` IPC、`Z` 面板键、`PinIcon`、置顶块排序/插入/裁剪豁免逻辑，README 与本文档同步。
- （访谈）不持久化提权状态、呼出时提醒、助手接管面板键通道：见「访谈决策」。