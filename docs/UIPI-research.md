# Windows UIPI 与全局输入拦截研究（Electron 剪贴板工具场景）

> **适用范围**：本文件是一次性调研记录，保持原样不改写。调研发生在 Electron 时期，但结论与框架无关——Electron 的 `globalShortcut` 与 Tauri 的 `tauri-plugin-global-shortcut` 底层同为 `RegisterHotKey`，`SendInput` 侧更是同一套 Win32。项目已于 2026-08-31 删除 Electron 实现，本文的落地结论是 [ADR-0001](adr/0001-require-administrator-with-scheduled-task.md)（整工具常驻提权 + 计划任务静默启动）与 [ADR-0002](adr/0002-no-elevation-ui.md)（界面上不提提权）。文中「Electron 主进程」「Electron 生态」等说法按调研当时的语境读。
>
> 场景：Electron 主进程以 normal integrity 运行，globalShortcut（底层是 RegisterHotKey）与 SendInput 自动粘贴在"目标应用以 Administrator 运行并处于前台"时失效。
> 调研日期：2026-04；方法：直接抓取 Microsoft Learn / 官方文档原文、GitHub 源码、StackExchange API（superuser/SO）、GitHub issue、DDG 检索；由于搜索桥(web_search/read_page)故障，全部内容经由 curl 直取并做了原文核对。**凡未能从主源验证的结论均已显式标注。**

---

## Q1. RegisterHotKey：非提权进程注册的热键，在前台窗口属于提权进程时会触发吗？

**官方文档（documented/authoritative）**
- [RegisterHotKey function (winuser.h) | Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey) —— **全文没有任何 UIPI / integrity 限制的表述**。官方文档只说热键按下时 "the system posts the WM_HOTKEY message to the message queue of the window/thread with which the hot key is associated"。RegisterHotKey 对提权前台窗口的行为属于**官方文档空白**。
- UIPI 的官方定义只落在"消息过滤"上：[ChangeWindowMessageFilterEx | Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-changewindowmessagefilterex)："UIPI is a security feature that prevents messages from being received from a lower-integrity-level sender." 低完整性进程发给高完整性窗口的消息被宿主过滤。
- 结论：没有一行官方文档说"低完整性进程的热键在提权窗口聚焦时不触发"，但也没有任何官方表态说它会触发——这是文档空白，只能靠社区/厂商证据补全。

**社区共识（community consensus）**
- [superuser.com/questions/1286491 "On Windows 10 global hotkeys of nonelevated apps do not work from elevated apps"](https://superuser.com/questions/1286491)（score 5）——被采纳答案（Greenshot 团队成员）明确：*"That's by design in Windows' User Account Control: it would be a potential security issue if any application were able to spy on key presses in applications with elevated permissions... you can configure it to always run with administrator privileges"*——即：**默认不触发，方案是把注册热键的程序也以管理员运行**。
- [superuser.com/questions/1894844 "AutoHotkey keyboard shortcut not captured when a software ran as administrator has the focus"](https://superuser.com/questions/1894844)（score 3，被采纳答案 score 4）：AHK 热键在管理员程序聚焦时不触发；被采纳答案总结："Lower elevation programs have much harder time interacting with higher elevation ones"，方案 = 脚本自提权重启（Run *RunAs）+ AHK 的 "Run with UI Access" 变体。
- [Stack Overflow "AutoHotkey commands with Windows key stopped working in elevated programs"](https://stackoverflow.com/questions/54810085)（score 2）：未以管理员运行的 AHK，Win 组合热键在部分管理员窗口失效（#v、#t 等）。
- [PowerToys 官方文档（Keyboard Manager）](https://learn.microsoft.com/en-us/windows/powertoys/keyboard-manager)：*"Remapping won't work on an app or window if that window is running in administrator (elevated) mode and PowerToys is not running as administrator."*

**冲突说法与调和**
- superuser/1286491 的未采纳回答（1 分）：称在 Win10 实测"hook keyboard 的程序仍能收到按键"，热键仍工作。这并不矛盾——它描述的是**低层键盘钩子（LL hook）路径**，而不是 RegisterHotKey 路径（见 Q2）。只要区分"RegisterHotKey 投递被 UIPI 掐断"与"LL hook 回调仍到达但注入被掐断"，两类说法可以同时成立。**Electron globalShortcut 走的是 RegisterHotKey 路径（见 Q5 源码证据），因此属于"会失效"的一类。**

---

## Q2. WH_KEYBOARD_LL：非提权进程安装的低层键盘钩子，能收到"投给提权前台窗口"的按键吗？

**官方文档（documented/authoritative）**
- [SetWindowsHookEx | Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowshookexw) 与 [Hooks Overview | Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/winmsg/hooks)：**全文没有任何 UIPI / integrity 字样**（已全文检索确认）。与注入型全局钩子（WH_GETMESSAGE 等需要把 DLL 注入目标进程、受位宽/安全边界影响）不同，LL 钩子的回调在安装者进程的线程上下文里执行——文档只强调 "hooking application must continue to pump messages"。
- 官方 UIPI 的适用范围（SendInput 文档、ChangeWindowMessageFilterEx 备注）都是"消息"与"输入注入"，**没有任何官方文档声明 UIPI 会过滤 LL 钩子回调本身**。因此"低完整性 LL 钩子收不到提权窗口的按键"这个命题**在主源中不可证实**。
- 反向（提权进程装 LL 钩子、非提权窗口前台）：方向上 UIPI 完全不构成限制（UIPI 只拦低→高）；文档无专门表述，社区无异议。

**社区共识（community consensus）**
- superuser/1286491 未采纳回答：winamp/Greenshot 类 "hooking" 工具在 Win10 上实测对提权窗口仍能收到按键（1 分、未采纳、与采纳答案相反——正说明社区分歧）。
- 但**行业工具文档的净结论是"仍然要管理员"**：PowerToys Keyboard Manager（低层拦截）官方文档要求"以管理员运行才能作用于提权窗口"；espanso（[issue #2388](https://github.com/espanso/espanso/issues/2388)，2025-07，open）文本展开在管理员 VS Code/Windows Terminal 中失效，workaround 是把 espansod.exe 设为常以管理员运行；AHK 社区结论同样是"脚本需管理员"。
- 合理解释（与 Q1 一致）：LL 钩子回调通常仍会到达（它不跨进程发消息，UIPI 不拦截回调），但回调之后**任何把输入注入/消息送入提权窗口的动作都被掐断**（SendInput 被 UIPI 拒、PostMessage/SendMessage 被过滤），所以工具表现为"在提权窗口面前失效"。**这一解释属于社区技术共识，无法从微软主源直接验证。**

---

## Q3. SendInput / keybd_event：非提权进程向提权前台窗口注入输入，被 UIPI 拦吗？

**官方文档（documented/authoritative）——五个问题中唯一完全"写死"的**
- [SendInput | Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) 原文两处：
  - *"This function is subject to UIPI. **Applications are permitted to inject input only into applications that are at an equal or lesser integrity level.**"*
  - *"This function fails when it is blocked by UIPI. **Note that neither GetLastError nor the return value will indicate the failure was caused by UIPI blocking.**"*
- [keybd_event | Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-keybd_event)：文档**未提及 UIPI**（已全文检索确认），但官方把 keybd_event 标为 superseded-by-SendInput，走同一输入流——社区一致按"同样受 UIPI 约束"处理（文档层面无明说）。

**社区共识**
- [SO "SendInput fail because of UIPI"](https://stackoverflow.com/questions/17645204)（score 11）：Windows Input Simulator 等库在 UIPI 下失败，异常文案即引用 UIPI。
- [SO "SendInput fails on UAC prompt"](https://stackoverflow.com/questions/56595640)（score 5）：SendInput 打不进 UAC 提升提示；提问者展示的 workaround 是复制 winlogon 的 SYSTEM token 提权注入——即"提权是唯一正路"的社区共识。

---

## Q4. 主流剪贴板/热键工具如何处理"向提权窗口粘贴/快捷键"？有没有"非提权主程序 + 提权 helper"？

**有文档可查的官方做法（全部是"整工具提权"或"按需提权"，没有默认常驻的静默提权 helper）：**
- **PowerToys（微软官方文档）**：[Keyboard Manager](https://learn.microsoft.com/en-us/windows/powertoys/keyboard-manager) —— "Try running PowerToys as an administrator" 是官方唯一的解法。
- **KeePass（官方 Help）**：[Auto-Type | KeePass Help](https://keepass.info/help/base/autotype.html) —— 向提权窗口/Windows Security 对话框 autotype 需 "run KeePass as administrator"；且官方**明确拒绝 UIAccess**："KeePass intentionally does not support UIAccess, because ... this would be a security vulnerability"。
- **espanso（官方 GitHub issue）**：[#2388](https://github.com/espanso/espanso/issues/2388) —— 管理员窗口中失效；用户 workaround = 属性里 "Run this program as an administrator"。
- **AHK（官方文档经社区转述 + 官方自带 UIA 变体）**：[superuser/1894844 被采纳答案](https://superuser.com/a/1894765) 引用 AHK 文档与安装器选项："Add 'Run with UI Access' to context menus"，即 **AutoHotkeyU32_UIA.exe / AutoHotkeyU64_UIA.exe**（uiAccess=true 变体，无需 UAC 弹窗）；[Daniel Schroeder 的工程博客](https://blog.danskingdom.com/Prevent-Admin-apps-from-blocking-AutoHotkey-by-using-UI-Access/) 详述了把默认打开方式换成 UIA 可执行文件的注册表做法；常规做法是脚本 Run *RunAs 自提权或编译时 requireAdministrator。
- **Ditto（剪贴板管理器）——最接近"按需提权 helper"模式**：[superuser "How to prevent admin login popup when using Ditto"](https://superuser.com/questions/1640199)：Ditto Options → Advanced → **"Elevated privileges"（默认 True）**，向提权窗口粘贴时 Ditto 会弹 UAC 自己提权来执行粘贴；官方论坛也有 "raising the administrator level" 讨论线程：[sourceforge 讨论 #287511](https://sourceforge.net/p/ditto-cp/discussion/287511/thread/25c4a766/)（页面被 Cloudflare 拦截，仅凭标题核实）。即 Ditto 的"提权"是 **UAC 弹窗触发的按需自提权，不是无感的常驻提权 helper**。
- **Greenshot**：[superuser/1286491 被采纳答案](https://superuser.com/a/1286651)（Greenshot 团队成员）：官方 workaround 就是 "run as administrator"。

**elevated helper（主程序不提权、仅注入子进程提权）在主流产品中未发现默认使用**；社区层面最常见的"静默提权"路径是**任务计划程序（Task Scheduler，登录时以最高权限启动 helper）**——[superuser/1894844 提问者自述](https://superuser.com/questions/1894844)即是该模式（"the only method I know is using Task scheduler"）。"everything"（voidtools）未找到任何关于提权前台窗口/热键的官方文档，未验证，不作结论。

**uiAccess=true 路线（官方条件很苛刻）**：[UI Automation Security Overview | Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview) 原文："To use UIAccess ... needs to: Be signed using an Authenticode code signing certificate. Be trusted by the system. The application must be installed in a secure location that requires a UAC prompt for access. For example, the Program Files folder. Be built with a manifest file that includes the uiAccess flag"，且明确 "UIAccess should not be used by applications that are not assistive technologies"。[Raymond Chen（2012-12-13）](https://devblogs.microsoft.com/oldnewthing/20121213-00/?p=5843)：UI Access 是 UIPI 的官方豁免通道，"bypasses User Interface Privilege Isolation (UIPI) security measures"，但需要签名 + 安全安装位置。

---

## Q5. Electron 特定情况：globalShortcut 与提权窗口；uiAccess / 计划任务是否是常见 workaround

**Electron 侧（可主源验证的事实）**
- [Electron 官方文档 globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)：只说明"注册/注销系统级全局快捷键，应用无焦点也可用"，**没有任何 UIPI / 提权窗口 / 管理员的专门说明或特殊处理**。
- [electron_api_global_shortcut.cc（Electron 主分支源码，已抓取核对）](https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_global_shortcut.cc)：实现走 ui::GlobalAcceleratorListener（Windows 上即 RegisterHotKey），**源码中没有任何 UIPI/完整性等级分支**——Electron 没有、也不可能绕过 UIPI。
- **未验证项（诚实声明）**：未能找到可核实的 electron/electron 仓库 issue 专门讨论"globalShortcut 在提权窗口聚焦时不触发"（GitHub 检索 API 该时段被限流、issue 搜索页为 JS 渲染、DDG 限流；搜索词 globalShortcut+elevated/administrator/UIPI 均无命中）。同类工具链中最接近的可核实 issue 是 espanso#2388（见 Q4）。**因此"存在某条著名 Electron issue"这一说法在本轮调研中无法从主源证实。**

**社区共识 / workaround 现状**
- uiAccess=true：真实存在且被 shipped（AHK 的 AutoHotkeyU*_UIA.exe、微软辅助技术工具），但官方约束 = Authenticode 签名 + Program Files 等安全位置 + 仅限辅助技术场景（微软原文），对普通 Electron 剪贴板工具是重方案；KeePass 官方出于安全拒绝用它。
- requireAdministrator manifest / 启动自提权 + "Run as administrator"：绝大多数工具（本文 Q4 全部案例）选择它——简单、无签名要求，代价是每次 UAC 弹窗或计划任务/清单静默提权。
- 计划任务（schtasks /RL HIGHEST 登录启动提权 helper）：社区常用"静默提权"手法（superuser/1894844 提问者模式），无官方文档背书，属社区实践。

---

## Bottom line（5 行，针对本文开头场景）

1. **globalShortcut（=RegisterHotKey）必失效**：低完整性进程注册的热键，在提权前台窗口聚焦时系统不投递（官方文档空白，但 Greenshot 团队成员采纳答案、PowerToys 官方文档、AHK/espanso 生态一致确认）；Electron 源码无任何特判，无法绕过。
2. **LL 键盘钩子回调通常仍收得到按键**（微软从未声明 UIPI 过滤回调），但任何"把按键注入提权窗口"的动作被 UIPI 掐断（SendInput 官方明文："equal or lesser integrity level"，且失败时 GetLastError 不报 UIPI），故工具仍是"要管理员"。
3. **主流答案 = 整个工具以管理员运行**：KeePass/PowerToys/espanso/AHK/Greenshot 官方均如此；Ditto 是唯一常见的"按需自提权（UAC 弹窗）"；主流产品没有默认的静默提权 helper，社区静默方案 = 计划任务。
4. **uiAccess=true 是官方唯一"非提权跨完整性注入"通道**，但需 Authenticode 签名 + Program Files 等安全位置 + 被官方限定为辅助技术用途——对剪贴板工具不现实（KeePass 官方点名拒绝）。
5. **对 Electron 剪贴板工具的落地建议**：要么接受"提权窗口聚焦时快捷键/自动粘贴工作不正常"并做降级提示，要么 requireAdministrator 整体提权，要么做"提权的注入 helper 进程"（如利用登录时计划任务启动）——后两者均为主流工具的社区验证路径；Electron 生态内没有官方捷径。

## 未验证 / 不确定性清单

- RegisterHotKey 在 UIPI 下的投递细节（失败点在内核/系统层），无任何微软主源白纸黑字；"RegisterHotKey 返回 TRUE 但不触发"与"返回 FALSE"两种社区说法并存（本调研只证实了"不触发"这一行为）。
- LL 钩子回调对提权窗口是否真的到达：仅 superuser 1 分未采纳回答 + 行业工具的间接行为可佐证；微软文档沉默。
- electron/electron 仓库中是否存在专门 issue：未能核实（限流）。
- AHK 官方 FAQ 正文（autohotkey.com 受 Cloudflare 保护）未能抓取原文；其内容经 superuser 被采纳答案与 Dan's Kingdom 博客转述引用。
- Ditto sourceforge 官方 FAQ/讨论页正文被 Cloudflare 拦截，仅经 superuser 问答 + 讨论标题核实其 "Elevated privileges" 行为。
- keybd_event 文档无 UIPI 字样，其受 UIPI 约束属推断（与 SendInput 同一输入流）。
