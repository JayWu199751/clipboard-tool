# 主题偏好住在渲染层 localStorage，不进 settings.json

面板皮肤是三态偏好（亮 / 暗 / 跟随系统，默认跟随），存在 WebView2 自己的 `localStorage` 里：键 `clipflow.theme`，值 `light` / `dark` / `system`，**默认值不落盘**（跟随系统 = 空档）。不新增 IPC 命令，也不写进 `%APPDATA%\ClipboardTool\settings.json`。

理由有两条，第二条是硬约束：

1. **皮肤是纯渲染层事实。** 换肤的全部动作就是改 `html[data-theme]`，两套 token 块住在 `theme.css`，主进程一行都不参与。它唯一沾「亮暗」的地方是托盘图标（`tray.rs::icon_image`），而那里跟的是**任务栏 / 系统**主题——用户把面板设成亮色时，托盘该不该跟着变白底黑图？不该，任务栏没变。所以这两件事本来就该分家，让主进程持有偏好反而会把它们错误地绑在一起。
2. **防 FOUC 要求「在打包产物之前、同步地」拿到偏好。** 首帧定色靠 `index.html` 的 `<head>` 内联脚本（迁移期就为这件事存在）。`localStorage` 能在里面同步 `getItem`；换成 `settings.json` 就得 `invoke` 一次异步往返，要么先画一帧错的色（闪一下），要么再引一套 `initialization_script` 由主进程注入——为一份只有渲染层读的设置付这个代价不值。

## Consequences

- **偏好不在「存档」里**：清 WebView2 用户数据会丢偏好（历史、备注、快捷键、开机启动都不受影响，它们在 `%APPDATA%\ClipboardTool`）。备份/重置存档的用户要单独知道这一点，README「数据与存档」已注明。
- **dev 与打包产物各存一份**：两者 origin 不同（`http://localhost:1420` 与 `http://tauri.localhost`），`localStorage` 天然隔离。这是预期，不是 bug——别为了「同步两边」把偏好搬去主进程。
- **`clipflow.theme` 与三个合法值即刻起是既成事实**，与 [ADR-0007](0007-storage-key-contract.md) 同性质（虽然破坏的后果轻得多：读不到就是回落跟随系统）。写第二份实现的地方是 `<head>` 内联脚本，改 `theme.ts` 的判定必改它——这条同源约束由 `panel-view-unit.mjs` 里**真跑一遍内联脚本**的对表测钉住（16 个组合逐一比 `resolveTheme`，含读档抛异常），文本比对只防得住改字面量，防不住改逻辑。
- **内联脚本额外留一条 `window.__themeTrace`**（`'inline:<theme>'`，App 的换肤效果往后追加 `'app:<theme>'`）。它只为把「首帧那次颜色是内联脚本定的」变成可断言的事实——否则浏览器用例只能抢 React 挂载时序赌运气。别当装饰删。
- 将来若主进程真的需要知道皮肤（例如要求托盘跟随手动主题），再加命令与 `settings.json` 键，并保留读 `localStorage` 旧值的迁移路径；届时 `<head>` 那段仍应留在原地，除非注入方案能保证同步。
