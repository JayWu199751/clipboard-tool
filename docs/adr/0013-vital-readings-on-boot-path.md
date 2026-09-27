# 开机关键路径无条件留读数（vital 日志）

`%APPDATA%\ClipboardTool\diag.log` 从此有两档，写在同一个文件里：

- **vital**（前缀 `vital `）——**无条件写**。呼出链路每一段的成败各留一行：进程起来走哪条通道（`start`）、渲染层露没露过面（`renderer-first-call`）、呼出键注册结果（`hotkey_register`）、三路呼出各自的请求侧（`summon-req src=hotkey|tray-click|tray-menu|instance`）、执行线程接手（`summon-run latency_ms=`）、主线程投递成败（`dispatch-failed|recovered|lost`）、窗口真值（`warmup` / `summon-landed first= final= repair= intent= actual=`）、框架与 OS 对可见性分家时的兜底（`make-visible via ShowWindow` / `make-visible failed`）、收起（`hide reason=`）、退出（`exit-requested` / `exit`）。
- **verbose**——`CLIPBOARD_TOOL_DIAG=1` 门禁后的逐事件流水（`CLIPBOARD_TOOL_POLL_TRACE` 仍管轮询到 stderr）。嘈杂、默认关，与从前一致。

## Considered Options

- **继续全部门禁**（2026-09-20 那轮的做法）：实证被否。那轮把「呼出必落地」的三条静默路径换成了读数，读数挂在 `CLIPBOARD_TOOL_DIAG=1` 上；而 2026-09-27 用户报「重启后快捷键呼不出」时，`diag.log` **文件根本不存在**——环境变量在 2026-09-19 验证完就按清单清掉了，开机自启的计划任务里没有它。「开机那一次」的现场只有一份，取不到就等于没有。
- **把开关写进计划任务的进程环境**：Tasks Scheduler 的任务定义没有环境变量字段，只能改成一个 `cmd /c set … && exe` 的动作包一层——把提权入口换成 shell 是无谓的风险面，而且 `apply_startup_intent` 每次启动都会按意图重建任务，包法会被自己覆写掉。
- **改投 Windows 事件日志**：几万次呼出会淹没应用日志，读的人也拿不到「按了那一下之后发生了什么」的顺序；而且要拿管理员权限才方便读。
- **让用户复现时手动开一次再重启**：诊断成本全压在用户身上，且一轮只能收一次数据（重启即会话结束）。

## Consequences

- **多了一份常驻写入**：一次呼出约 5 行，重度使用一天几百行。所以 `diag.log` 有 512 KB 上限，超了把旧文件挪成 `diag.log.1`（判定在 `diag.rs::should_rotate`，覆盖到「正好等于上限不轮转」）。落盘失败一律吞掉：诊断不许把主流程带下水。
- **`cargo test` 跑的就是这个 bin**，假事件绝不许混进真实现场：`diag_vital` 与 `diag_log` 都带 `cfg!(test)` 早退（2026-09-20 实测过一次测试把假事件冲满真日志）。
- **读数要能自己证伪**，所以每段都留了「另一侧」：请求侧与执行侧分开写、`summon-run` 带排队时延、`summon-landed` 回读 OS 真值（不是「调用返回 Ok」）。缺哪一行就说明卡在哪一段——「没有输出」从此也是一种结论。
- **`vital` 不是「重要日志」的泛称**：往里加行要过一条门槛——这一段的成败决定整个会话能不能用（呼出键注册、三路呼出、窗口落地、渲染层是否活过、进程怎么没的）。逐事件的、只在排查时想看的，仍然走 verbose。
- 呼出链路的静默失败一并收紧：八处 `run_on_main_thread` 的 `let _ =` 换成 `dispatch(...)`（失败记读数 + 重投，任务都是幂等的「置成某个状态」），`Modes::submit` 的通道发送失败不再吞掉（`executor-dead` / `executor-exit`），`make_visible` 自己回读 `IsWindowVisible` 并用 `ShowWindow(SW_SHOWNOACTIVATE)` 兜第二次。这些是同一决策的另一面：**要么做到，要么留下做不到的证据**。
