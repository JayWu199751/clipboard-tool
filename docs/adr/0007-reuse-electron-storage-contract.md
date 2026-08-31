# Tauri 版沿用 Electron 版的存档契约

数据目录仍是 `%APPDATA%\ClipboardTool`，历史 JSON 的 schema、图片落盘在 `images/`、`settings.json` 的 camelCase 键名全部沿用 Electron 版，好让老用户换实现时不丢历史。代价是两套实现共享同一份存档，**不能同时运行**。

## Consequences

- `Settings` 必须显式 `#[serde(rename_all = "camelCase")]`：derive 默认写 snake_case，而共享存档的既有约定是 `autoStart`，键名一错就是「开关保存后重开即丢」这种静默失效。读取端额外兼容 `auto_start` 残留并归一化空 `shortcut`，往返序列化有单测钉住。
- 存档 schema 是跨实现的持久化契约，改动要同时考虑旧档读取；`settings.rs` 是这条契约的唯一实现。
- 迁移期真正翻过车的地方就是这份共享存档，不是代码（见 [desktop-tool-pitfalls.md](../desktop-tool-pitfalls.md) 第 5 节）。
