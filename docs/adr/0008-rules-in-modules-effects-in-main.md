# 规则住在 module，效果留在 main.rs

主进程按一条线切开：**领域判定**（什么算同一条、算不算一次新复制、当前该注册哪些热键、面板该落在哪个坐标、粘贴链路的顺序与文案）各自收敛为一个 deep module，interface 尽量小；**效果**（读写剪贴板、落盘、emit 事件、Win32 调用、投递主线程）留在 `main.rs` 的编排里，或经注入端口从 module 外部进来。`main.rs` 因此不做任何领域判定，只把 module 的决策接起来跑。

## Consequences

- 每条规则只有一个可断言的地方，纯逻辑部分不碰 tauri / Win32，所以 58 例 Rust 单测与 14 例 node 单测全部零框架 mock 直跑。
- 端口用函数签名或 trait 注入（`history.rs` 的 `HistoryStoreBuilder`、`panel_modes.rs` 的 `ModesHost`、`paste_chain.rs` 的 `PastePort`、`startup.rs` 的 `decide(...register)`），生产 adapter 与测试 adapter 各一份；seam 不成立时宁可把端口加宽，也不要在 module 里直接调效果。
- 同类逻辑出现第三份复制粘贴就该收敛成 module，这是本仓库的既有做法，六个深化候选都源于此。
- 判断新代码该写在哪：先问「这是判定还是效果」。判定进 module 并配单测，效果进 `main.rs`。
