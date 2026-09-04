# 存档 schema 与键名是不可变更的持久化契约

数据目录固定在 `%APPDATA%\ClipboardTool`：历史 JSON 的 schema、图片落盘在 `images/`、`settings.json` 的 camelCase 键名。这些不是内部细节，而是已经写在用户磁盘上的既成事实——新写入必须能读老档，否则用户升级即丢历史与设置。因此存档 schema 是**持久化契约**：改动要同时提供旧档读取路径，不能只改写出端。

## Consequences

- `Settings` 必须显式 `#[serde(rename_all = "camelCase")]`：derive 默认写 snake_case，而存档的既有约定是 `autoStart`，键名一错就是「开关保存后重开即丢」这种静默失效。读取端额外兼容 `auto_start` 残留并归一化空 `shortcut`，往返序列化有单测钉住。
- `settings.rs` 是这条契约的唯一实现；存档 schema 变更一律先加读取端兼容，再改写出端。
- 这条契约上真正翻过车，翻车的不是代码而是存档（见 [desktop-tool-pitfalls.md](../desktop-tool-pitfalls.md) 第 5 节）。
