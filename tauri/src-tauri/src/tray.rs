// 托盘：图标尺寸阶梯、去重键、菜单文案三条判定，加上图标与菜单落地的效果入口。
//
// 为什么要收成 module：docs/architecture.md 早就把「托盘」写进 main.rs 的职责清单，
// 但它一直没有 module —— 八个自由函数摊在编排里，调用方得自己记住「算 key → 比 key →
// setImage → 换窗口图标」，而「同主题同尺寸不重复 setImage」这条去重规则在仓库里有两种
// 写法（AppState::tray_icon_key 用 round(16×scale)，选图用阶梯里最近的一档）。
// 现在三条判定都是纯函数、可表驱动直测，效果只剩 create / sync_icon / rebuild_menu。
//
// 图标不是一张图缩放出来的：src-tauri/icons/tray/ 下 16/20/24/28/32 五档 × 亮暗两套，
// 由 npm run gen:tray 解析直出；这里按主屏 scaleFactor 取「恰好物理尺寸」的那张交给
// HICON，零重采样（非整数缩放下 1:1 才不糊，见 pitfalls 第 3 节）。

use crate::panel_window::PanelWindow;
use crate::settings::{Settings, Theme};
use crate::hotkeys::format_shortcut;
use crate::{commit, set_auto_start, set_theme, AppState};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

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

/// 判定三：菜单里三条随状态变化的文案（其余是常量）
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
        let icon = self.icon_image().ok_or_else(|| std::io::Error::other("tray icon missing"))?;
        let menu = self.build_menu()?;
        let _tray = TrayIconBuilder::with_id(TRAY_ID)
            .icon(icon)
            .tooltip("剪贴板工具")
            .menu(&menu)
            // 左键点击呼出面板，菜单走右键
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                "show" => {
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
                if matches!(event, TrayIconEvent::Click { .. } | TrayIconEvent::DoubleClick { .. }) {
                    tray.app_handle().state::<AppState>().modes.show();
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
        let dark = self.is_dark();
        let key = icon_key(dark, self.scale());
        {
            let mut last = LAST_ICON_KEY.lock().unwrap();
            if *last == key {
                return;
            }
            let Some(icon) = self.icon_image() else { return };
            *last = key;
            let _ = tray.set_icon(Some(icon));
        }
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
        PanelWindow::new(&self.app).is_dark_theme()
    }

    fn icon_image(&self) -> Option<tauri::image::Image<'static>> {
        // 深色任务栏用白色图标，浅色用黑色图标；缺分尺寸图时回退 32px 基图
        let bytes: &[u8] = match (self.is_dark(), size_for_scale(self.scale())) {
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

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用
    use super::{
        icon_key, menu_labels, size_for_scale, theme_items, theme_of_menu_id, MenuLabels,
    };
    use crate::settings::{Settings, Theme};

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
}
