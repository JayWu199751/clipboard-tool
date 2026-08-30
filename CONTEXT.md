# ClipboardTool 项目上下文

> 本文档是工程的「共享词汇 + 决策档案」。项目本身见 [README.md](README.md)。

## 项目概述

Windows 剪贴板历史工具（Electron + React + Vite）。主进程轮询剪贴板（600ms），把文字/图片历史存入 `%APPDATA%\ClipboardTool\clipboard-history.json`；渲染进程只负责面板 UI 与键盘导航。全局快捷键 `Ctrl+Shift+V` 呼出不可激活（WS_EX_NOACTIVATE）的置顶浮层面板，不抢占输入框焦点。


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
| 静默启动通道（计划任务） | `ClipboardToolElevated`（/rl highest）：快捷方式经 task-launcher.exe 运行时直接以管理员令牌创建进程，不弹 UAC；开机启动 = 其 onlogon 触发器 |
| 开机启动意图（autoStart） | settings.json 持久化的用户意图；运行时事实（任务触发器是否存在）每次由开关操作重建 |
| 焦点快照（focusTarget） | 呼出面板前记录的前台窗口/焦点控件/进程/线程组合，用于搜索或备注编辑结束后恢复原输入框 |
| 焦点粘贴助手（focus-paste-helper.exe） | 常驻原生辅助进程，通过 stdin/stdout JSON 提供 snapshot/restore/paste；直接继承主进程令牌，不额外提权 |
| 面板键捕获通道 | 面板显示期间拦截 ↑↓/Enter/Esc/Del/Z/空格 的机制：主进程 globalShortcut（RegisterHotKey），提权后对所有完整性窗口生效 |
| 搜索模式（searchActive） | 面板的输入态：常驻搜索框由灰色禁用变为可编辑，窗口临时可聚焦以支持文字输入（含中文 IME）；Space/Z/Del 让位给输入框，↑↓/Enter/Esc 保持面板语义 |

## 架构脉络

- `electron/main.js`：剪贴板轮询、去重、历史持久化、全局快捷键（呼出 + 面板导航 `↑/↓/Enter/Esc/Del/Z/B/空格` + 搜索/备注编辑模式切换）、焦点快照/恢复/粘贴、托盘、计划任务管理（静默提权启动/开机启动）。
- `electron/preload.js`：`contextBridge` 暴露 `window.clipboardAPI`（getHistory / onUpdated / copy / remove / pin / clear / setNote / 快捷键 / 焦点错误事件）。
- `src/App.tsx`：面板 UI、主题、键盘逻辑（主进程面板键经 `panel:key` 转发）、快捷更换覆盖层。
- 数据流向：主进程维护唯一真相，`broadcast()` 推 `clipboard:updated` 给渲染层；渲染层不直接改数组。
- `resources/focus-paste-helper.cs`：`focus-paste-helper.exe` 的原生实现，负责窗口/焦点快照、恢复和 `Ctrl+V` 注入。

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
