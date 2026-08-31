// 面板浮层窗口：几何、焦点与鼠标穿透的唯一归属。
//
// 为什么要收成 module：面板是 WS_EX_LAYERED + 默认不可激活的透明浮层，任何一次
// 几何 / 焦点 / 窗口样式改动都必须发生在主线程（跨线程直接调用会向主线程发同步消息，
// 主线程若正在等我们手里的锁就互等死锁，表现为窗口「无响应」）。原先这条约束散在
// 8 处 run_on_main_thread、22 处取窗口、17 处 monitor/scale 换算里，调用方必须自己
// 记住「要投递主线程」「物理像素 vs DIP」「该用哪个显示器」—— interface 与
// implementation 一样宽。现在这些都进了实现，interface 只剩下面这几个动作。
//
// 几何判定（居中 / 离屏停靠 / 命中测试）是纯函数，不碰 tauri，可表驱动直测。

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TRANSPARENT,
};
use tauri::{AppHandle, LogicalPosition, Manager, Position, Wry};

pub const PANEL_LABEL: &str = "panel";
pub const PANEL_WIDTH: f64 = 418.0;
pub const PANEL_HEIGHT: f64 = 823.0;
/// 离屏停靠时超出当前显示器工作区右缘的距离（留在同屏内，避免跨屏 DPI 漂移改尺寸）
pub const OFFSCREEN_GAP: f64 = 20.0;
/// 取不到显示器时的兜底停靠点
pub const FALLBACK_PARK: (f64, f64) = (-10000.0, 0.0);

/// 显示器工作区（物理像素，已扣除任务栏）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// DIP 空间里的矩形
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RectDip {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 纯几何：面板在工作区内居中（物理工作区先除以缩放换成 DIP，再按固定面板尺寸居中）
pub fn centered(work: WorkArea, scale: f64, width: f64, height: f64) -> (f64, f64) {
    let area_x = work.x as f64 / scale;
    let area_y = work.y as f64 / scale;
    let area_w = work.width as f64 / scale;
    let area_h = work.height as f64 / scale;
    (
        (area_x + (area_w - width) / 2.0).round(),
        (area_y + (area_h - height) / 2.0).round(),
    )
}

/// 纯几何：停靠到工作区右缘之外（y 仍贴工作区顶部，保持同屏 DPI）
pub fn parked(work: WorkArea, scale: f64, gap: f64) -> (f64, f64) {
    (
        (work.x as f64 + work.width as f64) / scale + gap,
        work.y as f64 / scale,
    )
}

/// 纯几何：物理像素点击是否落在窗口矩形内。
/// 点按所在显示器的缩放换算，窗口边界按其自身缩放换算（多屏混缩放时两者不同）。
pub fn contains_point(
    point: (i32, i32),
    point_scale: f64,
    bounds: RectDip,
) -> bool {
    let px = point.0 as f64 / point_scale;
    let py = point.1 as f64 / point_scale;
    px >= bounds.x && px <= bounds.x + bounds.width && py >= bounds.y && py <= bounds.y + bounds.height
}

/// 面板窗口。克隆廉价，每个调用点按 AppHandle 现取即可。
#[derive(Clone)]
pub struct PanelWindow {
    app: AppHandle,
}

impl PanelWindow {
    pub fn new(app: &AppHandle) -> Self {
        PanelWindow { app: app.clone() }
    }

    fn window(&self) -> Option<tauri::WebviewWindow<Wry>> {
        self.app.get_webview_window(PANEL_LABEL)
    }

    pub fn exists(&self) -> bool {
        self.window().is_some()
    }

    pub fn is_dark_theme(&self) -> bool {
        self.window()
            .and_then(|w| w.theme().ok())
            .map(|t| t == tauri::Theme::Dark)
            .unwrap_or(false)
    }

    /// 物理像素点所在显示器的缩放比（找不到返回 None）
    pub fn scale_at(&self, x: i32, y: i32) -> Option<f64> {
        self.monitor_at(x, y).map(|m| m.scale_factor())
    }

    fn monitor_at(&self, x: i32, y: i32) -> Option<tauri::Monitor> {
        let monitors = self.app.available_monitors().ok()?;
        monitors.into_iter().find(|m| {
            let p = m.position();
            let s = m.size();
            x >= p.x && x < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32
        })
    }

    /// 物理像素点击是否落在面板内（矩形判定；圆角外的透明区穿透由渲染层
    /// 的 set_mouse_passthrough 负责，不参与这里的隐藏决策）。
    /// 返回 None = 窗口缺失或几何读不到，调用方不应据此隐藏面板（沿用原行为：
    /// 判不出来就不动作，免得面板莫名收起）。
    pub fn hit_test(&self, x: i32, y: i32) -> Option<bool> {
        let win = self.window()?;
        let pos = win.outer_position().ok()?;
        let size = win.outer_size().ok()?;
        let scale = self
            .scale_at(x, y)
            .or_else(|| win.scale_factor().ok())
            .unwrap_or(1.0);
        let win_scale = win.scale_factor().unwrap_or(scale);
        let bounds = RectDip {
            x: pos.x as f64 / win_scale,
            y: pos.y as f64 / win_scale,
            width: size.width as f64 / win_scale,
            height: size.height as f64 / win_scale,
        };
        Some(contains_point((x, y), scale, bounds))
    }

    /// 呼出：移到光标所在显示器的工作区居中。投递主线程执行。
    pub fn show_at_cursor(&self) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            let panel = PanelWindow::new(&app);
            let Some(win) = panel.window() else { return };
            let Ok(cursor) = app.cursor_position() else { return };
            let (cx, cy) = (cursor.x as i32, cursor.y as i32);
            // 光标所在显示器优先，取不到时退回窗口自己的显示器
            let monitor = panel
                .monitor_at(cx, cy)
                .or_else(|| win.current_monitor().ok().flatten());
            let Some(monitor) = monitor else { return };
            let (x, y) = centered(
                work_area(&monitor),
                monitor.scale_factor(),
                PANEL_WIDTH,
                PANEL_HEIGHT,
            );
            let _ = win.set_position(Position::Logical(LogicalPosition::new(x, y)));
        });
    }

    /// 隐藏：停到当前显示器工作区右侧之外。投递主线程执行。
    pub fn park_offscreen(&self) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            let panel = PanelWindow::new(&app);
            let Some(win) = panel.window() else { return };
            let (x, y) = match win.current_monitor().ok().flatten() {
                Some(m) => parked(work_area(&m), m.scale_factor(), OFFSCREEN_GAP),
                None => FALLBACK_PARK,
            };
            let _ = win.set_position(Position::Logical(LogicalPosition::new(x, y)));
        });
    }

    /// 让面板获得焦点（输入态：搜索 / 备注编辑 / 快捷键捕获）。投递主线程执行。
    pub fn focus(&self) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            let panel = PanelWindow::new(&app);
            if let Some(win) = panel.window() {
                let _ = win.set_focus();
            }
        });
    }

    /// 把焦点还给原程序（仅当面板当前持有焦点时）。
    /// Electron 的 win.blur() 等价于 SetFocus(NULL)，且必须在窗口归属线程调用。
    pub fn release_focus(&self) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            let panel = PanelWindow::new(&app);
            let Some(win) = panel.window() else { return };
            if win.is_focused().unwrap_or(false) {
                unsafe {
                    // SetFocus(NULL) 失败（无持有焦点的窗口）可安全忽略
                    let _ = SetFocus(None);
                }
            }
        });
    }

    /// 透明窗口点击穿透：圆角外区域穿透到下层窗口（Windows 实现 = 切 WS_EX_TRANSPARENT）。
    /// 样式切换必须在主线程（跨线程改窗口样式同样是同步消息）。
    pub fn set_mouse_passthrough(&self, ignore: bool) {
        let Some(win) = self.window() else { return };
        let Ok(hwnd) = win.hwnd() else { return };
        let hwnd_raw = hwnd.0 as isize; // HWND 含裸指针非 Send，取值后主线程重建
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            let _ = app;
            unsafe {
                let hwnd = HWND(hwnd_raw as *mut _);
                let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
                let new_style = if ignore {
                    style | WS_EX_TRANSPARENT.0
                } else {
                    style & !WS_EX_TRANSPARENT.0
                };
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style as isize);
            }
        });
    }

    /// 直接设位置（ready-to-show 热身用：先在 (0,0) 显示让 WebView 出首帧）
    pub fn set_position(&self, x: f64, y: f64) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            let panel = PanelWindow::new(&app);
            if let Some(win) = panel.window() {
                let _ = win.set_position(Position::Logical(LogicalPosition::new(x, y)));
            }
        });
    }

    /// 显示窗口（ready-to-show 热身用）。投递主线程执行。
    pub fn show(&self) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            let panel = PanelWindow::new(&app);
            if let Some(win) = panel.window() {
                let _ = win.show();
            }
        });
    }

    /// 换窗口图标（跟随系统主题）。投递主线程执行。
    pub fn set_icon(&self, icon: tauri::image::Image<'static>) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            let panel = PanelWindow::new(&app);
            if let Some(win) = panel.window() {
                let _ = win.set_icon(icon);
            }
        });
    }
}

fn work_area(m: &tauri::Monitor) -> WorkArea {
    let wa = m.work_area();
    WorkArea { x: wa.position.x, y: wa.position.y, width: wa.size.width as i32, height: wa.size.height as i32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_HD: WorkArea = WorkArea { x: 0, y: 0, width: 1920, height: 1080 };

    #[test]
    fn 居中按缩放换算后取整() {
        // 1x：x=(1920-418)/2=751，y=(1080-823)/2=128.5 -> 129（round 远离零）
        assert_eq!(centered(FULL_HD, 1.0, PANEL_WIDTH, PANEL_HEIGHT), (751.0, 129.0));
        // 2x：工作区先换算成 960x540 DIP 再居中；面板比工作区还高时 y 为负（沿用既有行为）
        assert_eq!(centered(FULL_HD, 2.0, PANEL_WIDTH, PANEL_HEIGHT), (271.0, -142.0));
    }

    #[test]
    fn 居中结果不随显示器原点丢失() {
        let work = WorkArea { x: 1920, y: 0, width: 2560, height: 1440 };
        assert_eq!(centered(work, 1.0, PANEL_WIDTH, PANEL_HEIGHT), (2991.0, 309.0));
    }

    #[test]
    fn 停靠点在工作区右缘之外且贴顶() {
        let (x, y) = parked(FULL_HD, 1.0, OFFSCREEN_GAP);
        assert_eq!((x, y), (1940.0, 0.0));
        // 有任务栏时 y 跟随工作区原点，而不是屏幕原点
        let work = WorkArea { x: 0, y: 40, width: 1920, height: 1040 };
        assert_eq!(parked(work, 1.0, OFFSCREEN_GAP), (1940.0, 40.0));
    }

    #[test]
    fn 命中测试含边界且区分点与窗口的缩放() {
        let bounds = RectDip { x: 100.0, y: 50.0, width: 400.0, height: 800.0 };
        assert!(contains_point((100, 50), 1.0, bounds), "左上边界算命中");
        assert!(contains_point((500, 850), 1.0, bounds), "右下边界算命中");
        assert!(!contains_point((501, 850), 1.0, bounds));
        assert!(!contains_point((99, 500), 1.0, bounds));
        // 2x 屏上的物理点 (400,400) -> DIP (200,200)，落在矩形内
        assert!(contains_point((400, 400), 2.0, bounds));
    }
}
