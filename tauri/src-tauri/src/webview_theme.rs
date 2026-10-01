// 主题偏好的落地出口：把三态写进 WebView2 的 preferred color scheme，
// 于是网页里的 `prefers-color-scheme` 跟着变，渲染层现有的内联脚本与 matchMedia
// 监听照常工作，它自己不参与生效主题判定（决策见 ADR-0012）。
//
// 为什么不用 tauri 的 `set_theme`：在 Windows 上它只落到 tao 的窗口属性
// （tauri-runtime-wry 的 `WindowMessage::SetTheme` → tao `window.set_theme` →
// `SendMessageW(CHANGE_THEME_MSG)`，改的是标题栏 DWM 明暗），而 wry 里真正动
// `ICoreWebView2Profile::SetPreferredColorScheme` 的那一句只在建窗时执行一次。
// 用它，窗口边框变色、面板皮肤不动。
//
// 这里也不顺带改 tauri 的窗口主题：托盘图标该配任务栏而不是面板皮肤（见 tray.rs
// `is_dark` 与 `icon_key` 的注释），两者故意不同源。

use crate::panel_window::PANEL_LABEL;
use crate::settings::Theme;
use tauri::{AppHandle, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2_13, COREWEBVIEW2_PREFERRED_COLOR_SCHEME,
    COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO, COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
    COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
};
use windows::core::Interface;

/// 判定：三态 → WebView2 常量。System 映射成 AUTO（继续跟系统），不是「不设置」
pub fn scheme_of(theme: Theme) -> COREWEBVIEW2_PREFERRED_COLOR_SCHEME {
    match theme {
        Theme::Light => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
        Theme::Dark => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
        Theme::System => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO,
    }
}

/// 效果：把偏好投递给面板 webview。主线程调用时 `with_webview` 就地执行，不阻塞等待；
/// 任何一步失败都只是「面板继续跟随系统」，绝不 panic——老运行时（< 109）拿不到
/// `ICoreWebView2_13` 是这条路上唯一会常态发生的失败。
pub fn apply(app: &AppHandle, theme: Theme) {
    let Some(panel) = app.get_webview_window(PANEL_LABEL) else {
        eprintln!("webview-theme: 面板窗口尚未就绪，主题「{}」等下次变更", theme.label());
        return;
    };
    if let Err(err) = panel.with_webview(move |platform| unsafe {
        if let Err(err) = apply_to(platform.controller(), theme) {
            eprintln!("webview-theme: 应用「{}」失败（{err}），面板继续跟随系统", theme.label());
        }
    }) {
        eprintln!("webview-theme: 投递 webview 失败 {err}");
    }
}

unsafe fn apply_to(
    controller: ICoreWebView2Controller,
    theme: Theme,
) -> windows::core::Result<()> {
    let webview = controller.CoreWebView2()?;
    let webview: ICoreWebView2_13 = webview.cast()?;
    webview.Profile()?.SetPreferredColorScheme(scheme_of(theme))
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用
    use super::scheme_of;
    use crate::settings::Theme;

    #[test]
    fn 三态各映射一枚常量_跟随系统映射成自动而非不设置() {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO, COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
            COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
        };
        // 常量是 0/1/2 的枚举值，0 是 AUTO：跟随系统必须落在 AUTO 上，不能落 0 以外的「未设置」
        assert_eq!(scheme_of(Theme::System), COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO);
        assert_eq!(scheme_of(Theme::Light), COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT);
        assert_eq!(scheme_of(Theme::Dark), COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK);
        // 常量包装类型没有 Hash/Eq 之外的便利，两两比就够：撞在一起就是两态映射到同一色
        let (system, light, dark) = (scheme_of(Theme::System), scheme_of(Theme::Light), scheme_of(Theme::Dark));
        assert_ne!(system, light, "跟随系统与亮色撞了");
        assert_ne!(system, dark, "跟随系统与暗色撞了");
        assert_ne!(light, dark, "亮色与暗色撞了");
    }
}
