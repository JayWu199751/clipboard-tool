# 主题偏好住 settings.json，经 WebView2 profile 送达

主题偏好（亮 / 暗 / 跟随系统，默认跟随）由**主进程**持有：存 `settings.json` 的 `theme` 键（camelCase 契约同 [ADR-0007](0007-storage-key-contract.md)，缺键与非法值一律回落 `system`）。落地方式是调 WebView2 的 `ICoreWebView2Profile::put_PreferredColorScheme`，让**网页里的 `prefers-color-scheme` 本身**跟着变（官方原文：该属性「sets the media feature `prefers-color-scheme` for websites to respond to」，默认 `AUTO` 跟随 OS）。于是渲染层不持有任何主题状态：它继续只跟着媒体查询走，用的还是 HUD 迁移前那套 `index.html` 内联脚本 + `matchMedia` 监听。

入口在托盘右键菜单的「主题」子菜单，面板里没有开关。

为什么不用看起来更省事的 `window.set_theme()`：在 Windows 上它只落到 tao 的窗口属性（`tauri-runtime-wry` 的 `WindowMessage::SetTheme` → tao `window.set_theme` → `SendMessageW(CHANGE_THEME_MSG)`，改的是标题栏 DWM 明暗），而 wry 里真正动 `put_PreferredColorScheme` 的那一句**只在建窗时执行一次**。用它，窗口边框变色、面板皮肤不动。

## Considered Options

- **事件推给渲染层，渲染层自己判定**（新增 `theme` 事件 + `theme_get` 命令）：否决。它把「首帧前同步读到偏好」这个老问题请回来——媒体查询能同步读，IPC 不能——于是要么容忍闪一下，要么在 `localStorage` 再缓存一份、变成两处记录。而它想换来的东西 `profile` 这条路免费给：一份事实、零渲染层代码。
- **面板窗口从 `tauri.conf.json` 改成代码创建 + `initialization_script` 注入**：能同步、也不碰 COM，但窗口声明、capabilities、warmup 都要跟着搬，改动面比现在这条路大，收益相同。
- **偏好继续住 `localStorage`（渲染层）**：否决。开关在托盘，主进程写不动渲染层的存储（只能 `eval` 进去，且窗口未就绪时没处写）；主题也就此脱离 `%APPDATA%\ClipboardTool` 这个统一备份面。

## Consequences

- **托盘图标不跟着手动主题走**：它继续读系统色，因为图标该配任务栏。用户把面板设成亮色、系统是暗色任务栏时，托盘仍是深色任务栏那套白图。这条是刻意的不同源，别「顺手统一」（`tray.rs` 注释里也写了）。**读的是哪一份系统色于 2026-09-20 更正过一次**：原先取的 `panel_window.rs::is_dark_theme`（现已删）其实是 tao 那份**建窗时算好、之后靠 `WM_SETTINGCHANGE` 广播刷新**的窗口主题缓存，而它读的键是**应用模式**（`AppsUseLightTheme`）——任务栏那块面板跟的是 **Windows 模式**（`SystemUsesLightTheme`），「自定义」下两者可以相反。现在 `tray.rs::taskbar_is_dark` 直读这两个键（缺前者才退后者）。「不同源」这条决策本身不变，变的是「系统色」的权威出处，见 [CONTEXT.md](../../CONTEXT.md)「任务栏主题」与 pitfalls 第 7 节。
- **要求 WebView2 Runtime ≥ 109**（`ICoreWebView2_13`）。cast 失败只写 stderr，后果是「面板继续跟随系统」，不崩、不锁死。
- **运行时改这一下会不会触发页面的 `change` 事件，文档没承诺**。所以 `App.tsx` 在每次 `panel:shown` 里用同一个 `applyTheme()` 重刷一次 `data-theme`：面板显示前是离屏的，这次重刷用户看不见，但它兜住「事件没来」那种情况。
- **启动顺序有先后**：`setup` 里必须在 ready-to-show 热身的 `show()` **之前** apply。热身会把窗口在 (0,0) 真显示 120ms，晚一步就可能让人看见带旧配色的一帧。
- 新增直接依赖 `webview2-com`（版本必须咬住 tauri/wry 用的那份，当前 0.38.2），只为 `ICoreWebView2_13` 与三个常量。
- **存档兼容**：老档没有 `theme` 键 → 回落跟随系统，升级后行为与从前逐字一致；写坏的 `theme` 值不连带吃掉 `autoStart` / `shortcut`（`settings.rs::parse` 的手缝分支也认 `theme`）。往返、缺键、非法值、手缝四条都有单测。
