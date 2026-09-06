# 全局热键的记账由执行线程独占一张表

「此刻哪些全局热键真的生效」曾经有两份记录：`PanelModes::registered`（accel → action）与 `AppState::hotkeys`（`Mutex<Shortcut → accel>`）。两份各自漂移没人拦得住，反向查询只能按值线性扫，注册侧「查重 → 调插件 → 记账」三步也不原子。现在并成 `hotkeys.rs` 的一张 accel ↔ Shortcut 双向表，由 `modes.rs` 的执行线程独占（`&mut Hotkeys`），插件调用作为端口注入进来。原子性来自所有权，不来自锁。

## Considered Options

- **表留在 `AppState`，用 `Mutex` 保护**：主线程能直接读到 accel，方向键连发不必绕执行线程。但「三步原子」就只能靠持锁跨越插件调用做到，而 `register`/`unregister` 内部投递主线程并阻塞等待（[ADR-0006](0006-modes-on-dedicated-thread.md)）——持锁调用即死锁；不持锁则三步之间的窗口还在，只是多了一把跨线程锁把它藏起来。放弃：拿主线程的便利换死锁风险。
- **两份记录都留着，加一个同步点**：漂移照样可能发生，只是多一处「记得调用」。放弃：真源数量没解决，而这正是问题本身。
- **双向表直接住进 `PanelModes`**：状态机本来就在那条线程上，看起来更近。但 `panel_modes.rs` 因此要依赖插件的 `Shortcut` 类型，纯逻辑 module 不再纯，15 例单测得连着插件一起跑。放弃：状态机只推导「该注册什么」，「已经生效的是什么」一直是宿主的事。

## Consequences

- 主线程拿不到 accel：热键回调只交出 `Shortcut`，「这是哪个动作、该不该连发」由执行线程判。方向键连发的登记因此一并搬进宿主，`AppState::navigation_repeat` 退役。
- 新增「想知道当前注册了哪些键」的需求（例如托盘要显示全部生效键）应当走 `Modes` 具名操作，不要给这张表加锁——加锁的那一刻就回到了 ADR-0006 的成因。
- `ModesHost` 多一个查询 `current_keys()`：差量同步的「已生效」一侧永远来自宿主，`PanelModes` 不再自己存集合。
- 展示文案 `format_shortcut`（accel → `Ctrl + Shift + V`）住在同一个 module：它和这张表读的是同一种字符串，三处调用方（托盘菜单、捕获覆盖层、更换快捷键的回报）就此共用一个出处。
