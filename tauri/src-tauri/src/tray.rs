// 托盘：图标尺寸阶梯、明暗来源、去重键、菜单文案与「哪一发事件算呼出」这几条判定，
// 加上图标与菜单落地的效果入口。
//
// 为什么要收成 module：docs/architecture.md 早就把「托盘」写进 main.rs 的职责清单，
// 但它一直没有 module —— 八个自由函数摊在编排里，调用方得自己记住「算 key → 比 key →
// setImage → 换窗口图标」，而「同主题同尺寸不重复 setImage」这条去重规则在仓库里有两种
// 写法（AppState::tray_icon_key 用 round(16×scale)，选图用阶梯里最近的一档）。
// 现在这些判定都是纯函数、可表驱动直测，效果只剩 create / sync_icon / rebuild_menu。
//
// 图标不是一张图缩放出来的：src-tauri/icons/tray/ 下 16/20/24/28/32 五档 × 亮暗两套，
// 由 npm run gen:tray 解析直出；这里按主屏 scaleFactor 取「恰好物理尺寸」的那张交给
// HICON，零重采样（非整数缩放下 1:1 才不糊，见 pitfalls 第 3 节）。
//
// 亮暗判的是**任务栏**那块面板的颜色，直读注册表，不经窗口主题缓存（成因见 taskbar_is_dark）。

use crate::panel_window::PanelWindow;
use crate::settings::{Settings, Theme};
use crate::hotkeys::format_shortcut;
use crate::{commit, diag_log, diag_vital, set_auto_start, set_theme, AppState};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use windows::core::PCWSTR;
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD,
};

pub const TRAY_ID: &str = "main-tray";

/// 阶梯档位（物理像素），与 npm run gen:tray 生成的文件名一一对应
const SIZES: [u32; 5] = [16, 20, 24, 28, 32];
/// 任务栏图标的逻辑尺寸：目标物理尺寸 = round(16 × scale)
const LOGICAL_SIZE: f64 = 16.0;

/// 判定一：主屏缩放 → 阶梯里离目标物理尺寸最近的一档（同距取较小档位，与生成顺序一致）
pub fn size_for_scale(scale: f64) -> u32 {
    let target = (LOGICAL_SIZE * scale).round() as i32;
    *SIZES
        .iter()
        .min_by_key(|&&s| (s as i32 - target).abs())
        .unwrap_or(&32)
}

/// 判定二：图标去重键。display-metrics 变化会高频触发重设，同键不动。
/// 键取「实际选中的档位」而不是目标像素：两档之间的缩放变化不改变图标，也就不该重设。
/// 深色任务栏用浅色（白色）图标，故 dark 对应 light 资产。
pub fn icon_key(dark: bool, scale: f64) -> String {
    format!("{}@{}", if dark { "light" } else { "dark" }, size_for_scale(scale))
}

/// 判定三：任务栏那块面板是不是深色（是 → 该用浅色描边那套图）。
///
/// 读的是 Windows 模式的 `SystemUsesLightTheme`（任务栏、开始菜单跟它走），不是应用模式的
/// `AppsUseLightTheme`（管窗口内容与标题栏）：「个性化 → 颜色 → 选择默认模式 = 自定义」时
/// 两者可以相反，而托盘图标是画在任务栏上的。原先这里取的是 `window.theme()`——那份缓存
/// 既是应用模式（键就不对），又只在窗口建起来时算一次、之后靠 WM_SETTINGCHANGE 广播刷新
/// （广播可能收不到），开机启动那次读到的就是建窗那一刻的旧值。
/// 两个键都没写（精简过的系统 / GPO 管过）就退回浅色任务栏。
pub fn taskbar_is_dark(system_uses_light: Option<u32>, apps_use_light: Option<u32>) -> bool {
    match system_uses_light.or(apps_use_light) {
        Some(light) => light == 0,
        None => false,
    }
}

/// 判定四：哪一发托盘事件算「把面板呼出来」。
///
/// 外壳对一次左键点击发来 Click(Down) + Click(Up) 两条，只认抬起那条：两条都认就是同一次
/// 点击投两次呼出（真机 diag.log 里那对相隔 41µs 的 show_panel 就是这么来的）。
/// 右键与中键都不算——右键那一下是要弹菜单的，顺带呼出面板等于把菜单压到面板底下。
/// 双击时外壳额外发一条 DoubleClick，认（一次双击的最后一发是抬起，落在呼出上才收得住）。
pub fn opens_panel(event: &TrayIconEvent) -> bool {
    match event {
        TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
            true
        }
        TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => true,
        _ => false,
    }
}

/// 判定五：指针进到了图标上——正是核一遍配色的时机（见 create 里那条的说明）
pub fn pointer_entered(event: &TrayIconEvent) -> bool {
    matches!(event, TrayIconEvent::Enter { .. })
}

/// 判定六：菜单里三条随状态变化的文案（其余是常量）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuLabels {
    pub shortcut: String,
    pub autostart: String,
    /// 主题子菜单的标题。当前态写进标题是刻意的：多数人不看子菜单里勾在哪一项
    pub theme: String,
}

pub fn menu_labels(settings: &Settings) -> MenuLabels {
    MenuLabels {
        shortcut: format!("更换快捷键(当前: {})", format_shortcut(&settings.shortcut)),
        autostart: format!("开机启动 {}", if settings.auto_start { "✅" } else { "❌" }),
        theme: format!("主题(当前: {})", settings.theme.label()),
    }
}

/// 主题子菜单的三条项（菜单 id ↔ 偏好）。顺序即菜单顺序，勾选唯一由 theme_items 保证。
pub const THEME_MENU_ITEMS: [(&str, Theme); 3] = [
    ("theme-system", Theme::System),
    ("theme-light", Theme::Light),
    ("theme-dark", Theme::Dark),
];

/// 判定：给定当前偏好，三条项各自的 (菜单 id, 文案, 是否打勾)
pub fn theme_items(selected: Theme) -> [(&'static str, &'static str, bool); 3] {
    THEME_MENU_ITEMS.map(|(id, theme)| (id, theme.label(), theme == selected))
}

/// 判定：菜单 id → 偏好。不是主题项的 id 返回 None，调用方据此决定要不要改设置
pub fn theme_of_menu_id(id: &str) -> Option<Theme> {
    THEME_MENU_ITEMS
        .iter()
        .find(|(item_id, _)| *item_id == id)
        .map(|(_, theme)| *theme)
}

/// 上一次落地的图标键。整个进程只有一个托盘（单实例插件保证），所以这把锁住在
/// module 内部，不再占 AppState 一个字段。
static LAST_ICON_KEY: Mutex<String> = Mutex::new(String::new());

/// 托盘效果入口。与 PanelWindow 同形状：只持 AppHandle，几何与状态在实现内部。
pub struct Tray {
    app: AppHandle,
}

impl Tray {
    pub fn new(app: &AppHandle) -> Self {
        Tray { app: app.clone() }
    }

    /// 创建托盘（左键呼出、右键菜单），并落地初始图标与菜单
    pub fn create(&self) -> tauri::Result<()> {
        let (dark, scale) = (self.is_dark(), self.scale());
        let icon = icon_image(dark, scale).ok_or_else(|| std::io::Error::other("tray icon missing"))?;
        let menu = self.build_menu()?;
        let _tray = TrayIconBuilder::with_id(TRAY_ID)
            .icon(icon)
            .tooltip("剪贴板工具")
            .menu(&menu)
            // 左键点击呼出面板，菜单走右键
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                "show" => {
                    // 呼出请求的调用方读数：它进了回调 ≠ 面板会出来（执行线程那侧还有一段），
                    // 两行分开写才能指认卡在哪一段
                    diag_vital("summon-req src=tray-menu");
                    app.state::<AppState>().modes.show();
                }
                "change-shortcut" => {
                    app.state::<AppState>().modes.begin_shortcut_capture();
                }
                "autostart" => {
                    let enabled = !app.state::<AppState>().settings.lock().unwrap().auto_start;
                    set_auto_start(app, enabled);
                }
                // HUD 迁移：标题栏随旧版界面退役，清空历史入口搬进托盘菜单。
                // store 锁短暂持有、不碰模式状态（线程模型红线），commit = 落盘 + 广播。
                "clear-history" => {
                    let state = app.state::<AppState>();
                    {
                        state.store.lock().unwrap().clear();
                    }
                    commit(app, &state);
                }
                "quit" => {
                    app.exit(0);
                }
                // 主题子菜单的三条项共用一个分支：id → 偏好 是纯判定（theme_of_menu_id），
                // 认不出来的 id 什么都不做（菜单以后加项不会误改设置）
                id => {
                    if let Some(theme) = theme_of_menu_id(id) {
                        set_theme(app, theme);
                    }
                }
            })
            .on_tray_icon_event(|tray, event| {
                if opens_panel(&event) {
                    diag_vital("summon-req src=tray-click");
                    tray.app_handle().state::<AppState>().modes.show();
                } else if pointer_entered(&event) {
                    // 指针进图标就核一遍配色：常规的刷新入口是面板窗口的 ThemeChanged
                    // （tao 靠 WM_SETTINGCHANGE 广播），广播可能收不到——开机那次就是。
                    // 悬停正是用户即将看这个图标的瞬间，同键时 sync_icon 自己会跳过。
                    Tray::new(tray.app_handle()).sync_icon();
                }
            })
            .build(&self.app)?;
        self.sync_icon();
        Ok(())
    }

    /// 主题或缩放变了就换托盘图标，同键直接跳过；窗口图标跟着一起换（两者同源，
    /// 分开同步就会漂移）。
    pub fn sync_icon(&self) {
        let Some(tray) = self.app.tray_by_id(TRAY_ID) else { return };
        let (dark, scale) = (self.is_dark(), self.scale());
        let key = icon_key(dark, scale);
        {
            let mut last = LAST_ICON_KEY.lock().unwrap();
            if *last == key {
                return;
            }
            let Some(icon) = icon_image(dark, scale) else { return };
            *last = key.clone();
            let _ = tray.set_icon(Some(icon));
        }
        diag_log(&format!("tray-icon {key}"));
        self.sync_window_icon(dark);
    }

    /// 菜单文案变了就整份重建（托盘菜单没有「就地改一条文案」的 seam）
    pub fn rebuild_menu(&self) {
        let Some(tray) = self.app.tray_by_id(TRAY_ID) else { return };
        match self.build_menu() {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(err) => eprintln!("重建托盘菜单失败: {err}"),
        }
    }

    // —— 以下都是效果：取缩放、取主题、读设置、交给 tauri ——

    /// 托盘图标按主屏缩放取「恰好物理尺寸」的图，取不到缩放时按 1x 处理
    fn scale(&self) -> f64 {
        self.app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(1.0)
    }

    fn is_dark(&self) -> bool {
        taskbar_is_dark(
            light_flag("SystemUsesLightTheme"),
            light_flag("AppsUseLightTheme"),
        )
    }

    fn sync_window_icon(&self, dark: bool) {
        // 窗口图标走 32px 基图：窗口图标路径由系统多尺寸缩放，无托盘 HICON 的问题
        let bytes: &[u8] = if dark {
            include_bytes!("../icons/tray-icon-light.png")
        } else {
            include_bytes!("../icons/tray-icon.png")
        };
        let Ok(icon) = tauri::image::Image::from_bytes(bytes) else { return };
        PanelWindow::new(&self.app).set_icon(icon);
    }

    fn build_menu(&self) -> tauri::Result<Menu<Wry>> {
        let app = &self.app;
        let state = app.state::<AppState>();
        let (labels, auto_start) = {
            let settings = state.settings.lock().unwrap();
            (menu_labels(&settings), settings.auto_start)
        };
        let theme = state.settings.lock().unwrap().theme;
        let show_item = MenuItem::with_id(app, "show", "显示剪贴板面板", true, None::<&str>)?;
        let shortcut_item = MenuItem::with_id(app, "change-shortcut", labels.shortcut, true, None::<&str>)?;
        let sep1 = PredefinedMenuItem::separator(app)?;
        let autostart_item =
            CheckMenuItem::with_id(app, "autostart", labels.autostart, true, auto_start, None::<&str>)?;
        let clear_item = MenuItem::with_id(app, "clear-history", "清空历史", true, None::<&str>)?;
        let sep2 = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
        // 主题做成子菜单：三态在一条菜单项里选不出，摊开成三项才看得见「还有跟随系统这个选项」
        let items = theme_items(theme);
        let theme_system = CheckMenuItem::with_id(app, items[0].0, items[0].1, true, items[0].2, None::<&str>)?;
        let theme_light = CheckMenuItem::with_id(app, items[1].0, items[1].1, true, items[1].2, None::<&str>)?;
        let theme_dark = CheckMenuItem::with_id(app, items[2].0, items[2].1, true, items[2].2, None::<&str>)?;
        let theme_submenu =
            Submenu::with_id_and_items(app, "theme", labels.theme.clone(), true, &[&theme_system, &theme_light, &theme_dark])?;
        Menu::with_items(
            app,
            &[&show_item, &shortcut_item, &sep1, &autostart_item, &theme_submenu, &clear_item, &sep2, &quit],
        )
    }
}

// —— 效果：把「明暗 + 缩放」这两个判定落成一张图 / 一次注册表读取 ——

/// 深色任务栏用白色图，浅色用黑色图；缺对应尺寸的图时回退 32px 基图。
/// 档位与 icon_key 走同一个 size_for_scale，两处不会各算一份而漂开。
fn icon_image(dark: bool, scale: f64) -> Option<tauri::image::Image<'static>> {
    let bytes: &[u8] = match (dark, size_for_scale(scale)) {
        (true, 16) => include_bytes!("../icons/tray/tray-icon-light-16.png"),
        (true, 20) => include_bytes!("../icons/tray/tray-icon-light-20.png"),
        (true, 24) => include_bytes!("../icons/tray/tray-icon-light-24.png"),
        (true, 28) => include_bytes!("../icons/tray/tray-icon-light-28.png"),
        (true, 32) => include_bytes!("../icons/tray/tray-icon-light-32.png"),
        (false, 16) => include_bytes!("../icons/tray/tray-icon-16.png"),
        (false, 20) => include_bytes!("../icons/tray/tray-icon-20.png"),
        (false, 24) => include_bytes!("../icons/tray/tray-icon-24.png"),
        (false, 28) => include_bytes!("../icons/tray/tray-icon-28.png"),
        (false, 32) => include_bytes!("../icons/tray/tray-icon-32.png"),
        _ => include_bytes!("../icons/tray-icon.png"),
    };
    tauri::image::Image::from_bytes(bytes).ok()
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 读 HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize 下的一个 DWORD。
/// 键不存在或类型不对返回 None——那是「这台机器没写过这个键」，不是「值为 0」。
fn light_flag(name: &str) -> Option<u32> {
    const SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    let subkey = wide(SUBKEY);
    let value_name = wide(name);
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(value_name.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut _ as *mut std::ffi::c_void),
            Some(&mut size),
        )
    };
    status.is_ok().then_some(data)
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用
    use super::{
        icon_key, menu_labels, opens_panel, pointer_entered, size_for_scale, taskbar_is_dark,
        theme_items, theme_of_menu_id, MenuLabels, TRAY_ID,
    };
    use crate::settings::{Settings, Theme};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent, TrayIconId};
    use tauri::{PhysicalPosition, Rect};

    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: TrayIconId::new(TRAY_ID),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
            button,
            button_state,
        }
    }

    fn double(button: MouseButton) -> TrayIconEvent {
        TrayIconEvent::DoubleClick {
            id: TrayIconId::new(TRAY_ID),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
            button,
        }
    }

    fn settings(accel: &str, auto_start: bool) -> Settings {
        // 主题走默认值（跟随系统），要测手动态的文案在各自用例里改
        Settings { shortcut: accel.to_string(), auto_start, ..Settings::default() }
    }

    #[test]
    fn 缩放取最近档位_整数缩放恰好命中_同距取较小档() {
        assert_eq!(size_for_scale(1.0), 16);
        assert_eq!(size_for_scale(1.25), 20);
        assert_eq!(size_for_scale(1.5), 24);
        assert_eq!(size_for_scale(1.75), 28);
        assert_eq!(size_for_scale(2.0), 32);
        // 目标 18px 与 16/20 等距 → 取较小档；低于最小档与高于最大档都夹在两端
        assert_eq!(size_for_scale(1.1), 16);
        assert_eq!(size_for_scale(1.4), 20);
        assert_eq!(size_for_scale(0.5), 16);
        assert_eq!(size_for_scale(10.0), 32);
    }

    #[test]
    fn 去重键_同档位不重设_跨档位或换主题才变() {
        // 1.0 与 1.1 都落在 16 档：图标没变，键也不该变（旧写法拿目标像素当键，会白重设）
        assert_eq!(icon_key(false, 1.0), icon_key(false, 1.1));
        assert_ne!(icon_key(false, 1.0), icon_key(false, 1.25));
        assert_ne!(icon_key(false, 1.0), icon_key(true, 1.0));
        // 键里带的是选中的档位，不是 round(16×scale)
        assert_eq!(icon_key(true, 1.5), "light@24");
        assert_eq!(icon_key(false, 2.0), "dark@32");
    }

    #[test]
    fn 菜单文案_快捷键走展示格式_开机启动带状态符号() {
        let MenuLabels { shortcut, autostart, .. } = menu_labels(&settings("Control+Shift+V", true));
        assert_eq!(shortcut, "更换快捷键(当前: Ctrl + Shift + V)");
        assert_eq!(autostart, "开机启动 ✅");
        let off = menu_labels(&settings("Alt+X", false));
        assert_eq!(off.shortcut, "更换快捷键(当前: Alt + X)");
        assert_eq!(off.autostart, "开机启动 ❌");
        // 空快捷键归一为默认键，与存档契约同一口径
        assert_eq!(menu_labels(&settings("", true)).shortcut, "更换快捷键(当前: Ctrl + Shift + V)");
    }

    #[test]
    fn 主题子菜单恰好一项打勾_且能映射回当前偏好() {
        for selected in [Theme::System, Theme::Light, Theme::Dark] {
            let items = theme_items(selected);
            let checked: Vec<&str> =
                items.iter().filter(|(_, _, on)| *on).map(|(id, _, _)| *id).collect();
            assert_eq!(checked.len(), 1, "{selected:?} 应有且只有一项打勾");
            assert_eq!(theme_of_menu_id(checked[0]), Some(selected), "打勾项必须映射回当前偏好");
            let labels: Vec<&str> = items.iter().map(|(_, label, _)| *label).collect();
            assert!(labels.iter().all(|label| !label.is_empty()), "三项文案不能空");
            assert_eq!(
                labels.iter().collect::<std::collections::HashSet<_>>().len(),
                3,
                "三项文案必须互不相同"
            );
        }
    }

    #[test]
    fn 主题菜单id只认三条_其余一律不改设置() {
        assert_eq!(theme_of_menu_id("theme-system"), Some(Theme::System));
        assert_eq!(theme_of_menu_id("theme-light"), Some(Theme::Light));
        assert_eq!(theme_of_menu_id("theme-dark"), Some(Theme::Dark));
        // 子菜单本身的 id、其余菜单项 id、大小写与近似拼写都不算
        for id in ["", "theme", "autostart", "clear-history", "theme-bright", "Theme-Light"] {
            assert_eq!(theme_of_menu_id(id), None, "{id} 不该被当成主题项");
        }
    }

    #[test]
    fn 主题子菜单标题带当前态() {
        let mut dark = settings("Control+Shift+V", true);
        dark.theme = Theme::Dark;
        assert_eq!(menu_labels(&dark).theme, "主题(当前: 暗色)");
        assert_eq!(menu_labels(&settings("Control+Shift+V", true)).theme, "主题(当前: 跟随系统)");
    }

    #[test]
    fn 任务栏明暗看_windows_模式键_缺键才退应用模式() {
        // 「自定义」下两个键相反：图标跟任务栏（Windows 模式），不跟应用模式
        assert!(!taskbar_is_dark(Some(1), Some(0)), "亮任务栏 + 暗应用：该用深色描边的图");
        assert!(taskbar_is_dark(Some(0), Some(1)), "暗任务栏 + 亮应用：该用白色描边的图");
        assert!(taskbar_is_dark(None, Some(0)));
        assert!(!taskbar_is_dark(None, Some(1)));
        // 两个键都没写：按浅色任务栏处理（宁可深描边，也别把白图贴到可能亮的条上）
        assert!(!taskbar_is_dark(None, None));
    }

    #[test]
    fn 一次左键点击只投一次呼出_右键与按下都不算() {
        assert!(opens_panel(&click(MouseButton::Left, MouseButtonState::Up)));
        assert!(
            !opens_panel(&click(MouseButton::Left, MouseButtonState::Down)),
            "外壳对一次左键点击发来 Down + Up 两条，两条都认就是一次点击两次呼出"
        );
        assert!(!opens_panel(&click(MouseButton::Right, MouseButtonState::Up)), "右键那一下是弹菜单的");
        assert!(!opens_panel(&click(MouseButton::Middle, MouseButtonState::Up)));
        assert!(opens_panel(&double(MouseButton::Left)));
        assert!(!opens_panel(&double(MouseButton::Right)));
    }

    #[test]
    fn 指针进图标算核配色的时机_不算呼出() {
        let enter = TrayIconEvent::Enter {
            id: TrayIconId::new(TRAY_ID),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
        };
        assert!(pointer_entered(&enter));
        assert!(!opens_panel(&enter));
        assert!(!pointer_entered(&click(MouseButton::Left, MouseButtonState::Up)));
    }
}
