// 面板浮层窗口：几何、焦点、鼠标穿透与「上不上任务栏」的唯一归属。
//
// 为什么要收成 module：面板是 WS_EX_LAYERED + 默认不可激活的透明浮层，任何一次
// 几何 / 焦点 / 窗口样式改动都必须发生在主线程（跨线程直接调用会向主线程发同步消息，
// 主线程若正在等我们手里的锁就互等死锁，表现为窗口「无响应」）。原先这条约束散在
// 8 处 run_on_main_thread、22 处取窗口、17 处 monitor/scale 换算里，调用方必须自己
// 记住「要投递主线程」「物理像素 vs DIP」「该用哪个显示器」—— interface 与
// implementation 一样宽。现在这些都进了实现，interface 只剩下面这几个动作。
//
// 几何判定（居中 / 离屏停靠 / 命中测试）是纯函数，不碰 tauri，可表驱动直测。

use crate::{diag_log, diag_vital};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, ShowWindow, GWL_EXSTYLE, SW_SHOWNOACTIVATE,
    WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, Wry};

pub const PANEL_LABEL: &str = "panel";
// 面板尺寸不再是常量：每次呼出按显示器算（sized：高=屏幕 7/8、宽=高一半，DIP 空间）。
/// 离屏停靠时超出当前显示器工作区右缘的距离（留在同屏内，避免跨屏 DPI 漂移改尺寸）
pub const OFFSCREEN_GAP: f64 = 20.0;
/// 取不到显示器时的兜底停靠点
pub const FALLBACK_PARK: (f64, f64) = (-10000.0, 0.0);
/// 投递主线程失败后的重投次数与间隔（10 × 50ms = 最坏 0.5 秒追上一条排队满的主线程）
const DISPATCH_RETRIES: u32 = 10;
const DISPATCH_RETRY_DELAY: Duration = Duration::from_millis(50);
/// 落位判定的容差（DIP）：分数缩放下 SetWindowPos 的取整会差一两个像素，那不算没落地
pub const LANDING_TOLERANCE: f64 = 2.0;

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

/// 纯几何：面板尺寸（DIP）——高 = 屏幕高的 7/8，宽 = 高的一半。
/// （2026-09-08：初版 2/3 用户嫌小，同日改 7/8；宽 = 高一半不变。）
/// 比值在 DIP 空间算（物理像素 ÷ 缩放），所以同一物理屏无论 DPI 都占同样的屏幕比例；
/// 同 DPI 密度（如 4K@2x 与 1080p@1x 的 DIP 高相同）给出完全相同的尺寸——DPI 无关性由公式保证。
pub fn sized(screen_height: f64, scale: f64) -> (f64, f64) {
    let height = (screen_height / scale * 7.0 / 8.0).round();
    ((height / 2.0).round(), height)
}

/// 纯几何：面板在工作区内居中（物理工作区先除以缩放换成 DIP，再按给定面板尺寸居中）
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

/// 窗口现状：OS 真值（`IsWindowVisible` + 实际矩形），不是框架缓存。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowTruth {
    pub visible: bool,
    pub rect: RectDip,
}

/// 一次呼出的落位判定。三种失败分开，因为处置完全不同：
///   `Hidden`    窗口压根不可见 → 整条链上唯一那次「不可见 → 可见」没办成，要强制显形；
///   `Moved`     投递到了、位置/尺寸没生效（还是停在屏外）→ 重设一次；
///   `Offscreen` 位置与意图相符，但那个意图本身就在工作区外（工作区读歪了）→ 得重算。
/// 「可见」与「落位」分开判：窗口可见却在屏外，肉眼看就是「按了没反应」，与不可见等价。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Landing {
    Landed,
    Hidden,
    Moved,
    Offscreen,
}

/// 判定：这次呼出落地了吗。容差按 DIP 给（分数缩放的取整不算失败）。
pub fn landing_verdict(
    intent: RectDip,
    actual: WindowTruth,
    work: WorkArea,
    scale: f64,
) -> Landing {
    if !actual.visible {
        return Landing::Hidden;
    }
    let moved = (actual.rect.x - intent.x).abs() > LANDING_TOLERANCE
        || (actual.rect.y - intent.y).abs() > LANDING_TOLERANCE
        || (actual.rect.width - intent.width).abs() > LANDING_TOLERANCE
        || (actual.rect.height - intent.height).abs() > LANDING_TOLERANCE;
    if moved {
        return Landing::Moved;
    }
    // 与工作区有交集才算看得见（贴边算交集）
    let (wx, wy) = (work.x as f64 / scale, work.y as f64 / scale);
    let (ww, wh) = (work.width as f64 / scale, work.height as f64 / scale);
    let disjoint = actual.rect.x + actual.rect.width <= wx
        || actual.rect.x >= wx + ww
        || actual.rect.y + actual.rect.height <= wy
        || actual.rect.y >= wy + wh;
    if disjoint {
        return Landing::Offscreen;
    }
    Landing::Landed
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

    /// 呼出：移到光标所在显示器的工作区居中，并**确认它真的落地了**（不可见就强制显形、
    /// 位置没生效就重设、算出来的位置本身在屏幕外就按主屏重算），整个过程写进 vital 读数。
    /// 投递主线程执行。
    ///
    /// 为什么要回读验证：`set_position` / `show` 都只是「请求」，返回 Ok 不等于生效，
    /// 而这条链上任何一步没生效，对外都是同一件事——三路呼出都没反应。2026-09-20 那轮
    /// 把三个静默 `return` 换成了兜底与日志，但**没有一处回读**，所以「必落地」当时只是
    /// 一个愿望；2026-09-27 开机那次三路全哑且现场无读数，就是这条缝。
    ///
    /// 显示器按「光标所在 → 窗口所在 → 主屏」三级兜底；任何一级拿不到都留读数。
    pub fn show_at_cursor(&self) {
        let seq = next_geom_seq();
        dispatch(&self.app, "show-at-cursor", move |app| {
            if superseded(seq, GEOM_SEQ.load(Ordering::Relaxed)) {
                diag_log("show-at-cursor: 已被更新的几何效果取代，丢弃");
                return;
            }
            let panel = PanelWindow::new(app);
            let Some(win) = panel.window() else {
                diag_vital("summon-missing-window");
                return;
            };
            let Ok(cursor) = app.cursor_position() else {
                diag_vital("summon-no-cursor");
                return;
            };
            let (cx, cy) = (cursor.x as i32, cursor.y as i32);
            let monitor = panel
                .monitor_at(cx, cy)
                .or_else(|| win.current_monitor().ok().flatten())
                .or_else(|| app.primary_monitor().ok().flatten());
            let Some(monitor) = monitor else {
                diag_vital(&format!("summon-no-monitor cursor={cx},{cy}"));
                return;
            };
            // 每次呼出按当前显示器重算尺寸与位置：换屏 / 改缩放后第一下就跟上。
            // set_size 在 resizable:false 下依然可编程调用（resizable 只管用户拖拽）。
            land_panel(
                &mut WindowLandingPort { app, win: &win },
                display_geometry(&monitor),
            );
        });
    }

    /// 隐藏：停到当前显示器工作区右侧之外。投递主线程执行。
    pub fn park_offscreen(&self) {
        let seq = next_geom_seq();
        dispatch(&self.app, "park-offscreen", move |app| {
            if superseded(seq, GEOM_SEQ.load(Ordering::Relaxed)) {
                diag_log("park-offscreen: 已被更新的几何效果取代，丢弃");
                return;
            }
            let Some(win) = window_or_log(app, "park-offscreen") else { return };
            let (x, y) = match win.current_monitor().ok().flatten() {
                Some(m) => parked(work_area(&m), m.scale_factor(), OFFSCREEN_GAP),
                None => FALLBACK_PARK,
            };
            diag_log(&format!("park-offscreen: x={x}"));
            let _ = win.set_position(Position::Logical(LogicalPosition::new(x, y)));
        });
    }

    /// 留一条窗口现状的读数（OS 真值）：可见性与实际矩形。投递主线程执行。
    /// 热身之后、以及需要确认「窗口到底在哪儿」时用它——探针与 vital 日志都读这一条。
    pub fn log_geometry(&self, tag: &'static str) {
        dispatch(&self.app, "log-geometry", move |app| {
            let Some(win) = PanelWindow::new(app).window() else {
                diag_vital(&format!("{tag} window=missing"));
                return;
            };
            match read_truth(&win) {
                Some(t) => diag_vital(&format!(
                    "{tag} vis={} rect={} scale={:.2}",
                    t.visible,
                    fmt_rect(t.rect),
                    win.scale_factor().unwrap_or(1.0)
                )),
                None => diag_vital(&format!("{tag} window=unreadable")),
            }
        });
    }

    /// 让面板获得焦点（输入态：搜索 / 备注编辑 / 快捷键捕获）。投递主线程执行。
    pub fn focus(&self) {
        dispatch(&self.app, "focus", move |app| {
            if let Some(win) = window_or_log(app, "focus") {
                let _ = win.set_focus();
            }
        });
    }

    /// 把焦点还给原程序（仅当面板当前持有焦点时）。
    /// 归还焦点即 SetFocus(NULL)，且必须在窗口归属线程调用。
    pub fn release_focus(&self) {
        dispatch(&self.app, "release-focus", move |app| {
            let Some(win) = window_or_log(app, "release-focus") else { return };
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
        let Some(hwnd) = self.window().and_then(|w| w.hwnd().ok()) else {
            // 窗口没了就没人需要穿透；留痕以免与「命令没生效」混为一谈
            diag_vital("mouse-passthrough missing-window");
            return;
        };
        let hwnd_raw = hwnd.0 as isize; // HWND 含裸指针非 Send，取值后主线程重建
        dispatch(&self.app, "mouse-passthrough", move |_app| {
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
        let seq = next_geom_seq();
        dispatch(&self.app, "set-position", move |app| {
            if superseded(seq, GEOM_SEQ.load(Ordering::Relaxed)) {
                diag_log("set-position: 已被更新的几何效果取代，丢弃");
                return;
            }
            if let Some(win) = window_or_log(app, "set-position") {
                let _ = win.set_position(Position::Logical(LogicalPosition::new(x, y)));
            }
        });
    }

    /// 显示窗口（ready-to-show 热身用）。投递主线程执行。
    ///
    /// 热身不是唯一一次显形：`show_at_cursor` 每次都补一遍，谁先到算谁（见那里的说明）。
    pub fn show(&self) {
        let seq = next_geom_seq();
        dispatch(&self.app, "show", move |app| {
            if superseded(seq, GEOM_SEQ.load(Ordering::Relaxed)) {
                diag_log("show: 已被更新的几何效果取代，丢弃");
                return;
            }
            if let Some(win) = window_or_log(app, "show") {
                make_visible(&win);
            }
        });
    }

    /// 换窗口图标（跟随系统主题）。投递主线程执行。
    pub fn set_icon(&self, icon: tauri::image::Image<'static>) {
        // 重投要能重放同一个效果，所以图标按引用共享（Image 是 Clone 的）
        let icon = Arc::new(icon);
        dispatch(&self.app, "set-icon", move |app| {
            if let Some(win) = window_or_log(app, "set-icon") {
                let _ = win.set_icon((*icon).clone());
            }
        });
    }
}

/// 把一个效果投给主线程。**投不出去不是「算了」**：窗口几何、样式、焦点、图标这四类变更
/// 都必须落在主线程，而 `run_on_main_thread` 会失败（主线程消息队列满、事件循环已退），
/// 从前八处调用一律 `let _ =`，失败就等于这一步无声无息地没做——对外只看到「面板没出来」。
/// 现在失败先记一条 vital 读数，再起一条短命线程重投；重投成功/用尽各记一条，
/// 「投递失败过」与「一切正常」从此可分辨（任务本身都是幂等的「置成某个状态」）。
fn dispatch<F>(app: &AppHandle, action: &'static str, task: F)
where
    F: Fn(&AppHandle) + Send + Sync + 'static,
{
    let task = Arc::new(task);
    let for_first = task.clone();
    let app_for_first = app.clone();
    if app.run_on_main_thread(move || for_first(&app_for_first)).is_ok() {
        return;
    }
    diag_vital(&format!("dispatch-failed action={action}"));
    let app = app.clone();
    std::thread::spawn(move || {
        for attempt in 1..=DISPATCH_RETRIES {
            std::thread::sleep(DISPATCH_RETRY_DELAY);
            let for_retry = task.clone();
            let app_for_retry = app.clone();
            if app.run_on_main_thread(move || for_retry(&app_for_retry)).is_ok() {
                diag_vital(&format!("dispatch-recovered action={action} attempt={attempt}"));
                return;
            }
        }
        diag_vital(&format!("dispatch-lost action={action} attempts={DISPATCH_RETRIES}"));
    });
}

/// 窗口几何/可见性这类效果的投递代数。**幂等不等于可重放**：重复执行同一效果是安全的，
/// 但迟到的旧效果盖掉新意图就是错的（典型伤害：呼出重投迟到 → 模式状态已收起、面板却显形，
/// 那块孤儿面板连「点外面收起」都不生效，因为那个判定先看模式状态）。所以这几类效果各带
/// 一个序号，落地前发现已有更新的同类效果就丢弃自己。焦点/穿透/图标不参与：它们不互相覆盖。
static GEOM_SEQ: AtomicU64 = AtomicU64::new(0);

/// 取一个新的几何效果序号（严格递增）
fn next_geom_seq() -> u64 {
    GEOM_SEQ.fetch_add(1, Ordering::Relaxed) + 1
}

/// 判定：这次投递是否已被更新的同类效果取代（是则丢弃）。
pub fn superseded(mine: u64, latest: u64) -> bool {
    mine != latest
}

/// 取面板窗口；拿不到就留一条读数。「窗口不存在」是呼出链路里最彻底的静默：
/// 从前它只表现为「按了没反应」，连一条记录都没有（2026-09-27 那轮把这条补上）。
fn window_or_log(app: &AppHandle, action: &'static str) -> Option<tauri::WebviewWindow<Wry>> {
    let win = PanelWindow::new(app).window();
    if win.is_none() {
        diag_vital(&format!("{action} missing-window"));
    }
    win
}

/// 呼出协议只需要这份显示器几何，不让测试依赖 tauri 的 Monitor。
#[derive(Clone, Copy)]
struct DisplayGeometry {
    work: WorkArea,
    scale: f64,
    screen_height: f64,
}

fn display_geometry(monitor: &tauri::Monitor) -> DisplayGeometry {
    DisplayGeometry {
        work: work_area(monitor),
        scale: monitor.scale_factor(),
        screen_height: monitor.size().height as f64,
    }
}

fn intended_rect(display: DisplayGeometry) -> RectDip {
    let (width, height) = sized(display.screen_height, display.scale);
    let (x, y) = centered(display.work, display.scale, width, height);
    RectDip { x, y, width, height }
}

/// 内部 seam：生产 adapter 只在主线程投递内构造，测试 adapter 回放 OS 真值与效果顺序。
trait LandingPort {
    fn apply_rect(&mut self, rect: RectDip);
    fn make_visible(&mut self);
    fn read_truth(&mut self) -> Option<WindowTruth>;
    fn primary_monitor(&mut self) -> Option<DisplayGeometry>;
    fn vital(&mut self, message: &str);
}

struct WindowLandingPort<'a> {
    app: &'a AppHandle,
    win: &'a tauri::WebviewWindow<Wry>,
}

impl LandingPort for WindowLandingPort<'_> {
    fn apply_rect(&mut self, rect: RectDip) { apply_rect(self.win, rect); }
    fn make_visible(&mut self) { make_visible(self.win); }
    fn read_truth(&mut self) -> Option<WindowTruth> { read_truth(self.win) }
    fn primary_monitor(&mut self) -> Option<DisplayGeometry> {
        self.app.primary_monitor().ok().flatten().map(|m| display_geometry(&m))
    }
    fn vital(&mut self, message: &str) { diag_vital(message); }
}

/// 读不到窗口现状时按「不可见」记，日志里的 actual 保留 unreadable。
fn verdict_from(intent: RectDip, truth: Option<WindowTruth>, display: DisplayGeometry) -> Landing {
    truth.map(|t| landing_verdict(intent, t, display.work, display.scale)).unwrap_or(Landing::Hidden)
}

/// 呼出落地协议：首次设置与回读 → 按失败种类修复 → 最终回读与读数。
fn land_panel(port: &mut impl LandingPort, mut display: DisplayGeometry) {
    let mut intent = intended_rect(display);
    port.apply_rect(intent);
    port.make_visible();
    let first = verdict_from(intent, port.read_truth(), display);
    let mut repair = "-";
    match first {
        Landing::Landed => {}
        // make_visible 已试过框架 show 与 Win32 兜底；再显形一次会留下误导的 repair=show。
        Landing::Hidden => {}
        Landing::Moved => {
            port.apply_rect(intent);
            repair = "reposition";
        }
        Landing::Offscreen => match port.primary_monitor() {
            Some(primary) => {
                // 主屏的工作区、缩放与意图必须一起换，最终判定也用这份上下文。
                display = primary;
                intent = intended_rect(display);
                port.apply_rect(intent);
                port.make_visible();
                repair = "refit";
            }
            None => port.vital("summon-no-primary"),
        },
    }
    // 判定与 actual 共用一次最终回读，避免两次回读之间的变化把日志拼成矛盾读数。
    let truth = port.read_truth();
    let final_verdict = verdict_from(intent, truth, display);
    port.vital(&format!(
        "summon-landed first={first:?} final={final_verdict:?} repair={repair} scale={} intent={} actual={}",
        display.scale,
        fmt_rect(intent),
        truth.map(|t| fmt_rect(t.rect)).unwrap_or_else(|| "unreadable".to_string()),
    ));
}

/// 窗口现状（OS 真值）。读不到返回 None（窗口没了 / 句柄不可读）。
fn read_truth(win: &tauri::WebviewWindow<Wry>) -> Option<WindowTruth> {
    let scale = win.scale_factor().unwrap_or(1.0);
    let visible = win.is_visible().unwrap_or(false);
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    Some(WindowTruth {
        visible,
        rect: RectDip {
            x: pos.x as f64 / scale,
            y: pos.y as f64 / scale,
            width: size.width as f64 / scale,
            height: size.height as f64 / scale,
        },
    })
}

/// 按 DIP 矩形落尺寸与位置。先落位再显形：反过来会在新位置之外闪一帧。
/// 两个调用都走 Logical：缩放由框架按窗口所在显示器换算，这里不再自己乘。
fn apply_rect(win: &tauri::WebviewWindow<Wry>, rect: RectDip) {
    let _ = win.set_size(Size::Logical(LogicalSize::new(rect.width, rect.height)));
    let _ = win.set_position(Position::Logical(LogicalPosition::new(rect.x, rect.y)));
}

fn fmt_rect(r: RectDip) -> String {
    format!("{:.0},{:.0} {:.0}x{:.0}", r.x, r.y, r.width, r.height)
}

/// 从不可见变可见那一步，连同「别上任务栏」的三个动作。必须在主线程上调用。
/// 幂等：窗口已经可见就直接返回（面板平时只是停到屏外，从不 `hide()`，所以常态下是空转）。
///
/// **自己确认自己**：`win.show()` 只是请求，读回 `IsWindowVisible` 才算数；没生效就用
/// Win32 `ShowWindow(SW_SHOWNOACTIVATE)` 再办一次（不再经 tao 的 flags），两次都不成就留读数。
/// 这一步是整条呼出链路上唯一真正的「不可见 → 可见」，赌不起。
///
/// 「别上任务栏」必须办在 `win.show()` **之后**：
/// - 配置里的 `skipTaskbar` 只让 tao 在建窗那一刻调一次 `ITaskbarList::DeleteTab`，
///   那时窗口还不可见、任务栏上没有按钮可删，等于空操作；
/// - 更关键的是 tao 对「无父窗口」的窗口一律置 `ON_TASKBAR`（`window.rs:1164`，
///   与 skip_taskbar 无关），并在 `set_visible` 里按内部 flags **整体重写** `GWL_EXSTYLE`
///   （`window_state.rs:440`）→ 窗口带着 `WS_EX_APPWINDOW`（强制上按钮）显形，
///   挂在 show 之前的样式位会被它抹掉（真机实测：ex=0x00040118，只有 APPWINDOW 没有 TOOLWINDOW）。
/// 外壳在窗口变可见时补按钮、开机时又会把已存在的可见窗口逐个登记一遍，所以事后
/// `DeleteTab` 在自启场景下也不可靠（那一刻 explorer 可能还不存在，没人记下这次删除）。
/// 于是补两步：样式位改对（让外壳在评估阶段就排除它），再调一次框架的 `set_skip_taskbar`
/// 把已建的按钮删掉——tao 会记住这个状态，explorer 重启时（`TaskbarCreated`）它自己会再删一次。
/// 顺带：`WS_EX_TOOLWINDOW` 也把它从 Alt+Tab 里摘掉——从 Alt+Tab 切进一个屏外窗口
/// 是同一个问题的另一半。
fn make_visible(win: &tauri::WebviewWindow<Wry>) {
    if win.is_visible().unwrap_or(false) {
        return;
    }
    let _ = win.show();
    if !win.is_visible().unwrap_or(false) {
        // 框架那一步没落地。真机实测过这条：tao 的内部 flags 会与 OS 真值分家——它以为窗口
        // 可见时 `set_window_flags` 发现「新 flags 与旧的一样」就早退、根本不发 `ShowWindow`，
        // 于是从外部把窗口隐藏掉之后，`win.show()` 是个空操作。这里直接问 Win32 要。
        if let Ok(hwnd) = win.hwnd() {
            unsafe {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
        }
        // 兜底成没成都留痕：这条正是「框架说可见、OS 说不可见」这种分家的证据
        if win.is_visible().unwrap_or(false) {
            diag_vital("make-visible via ShowWindow");
        } else {
            diag_vital("make-visible failed");
        }
    }
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let style = (style & !WS_EX_APPWINDOW.0) | WS_EX_TOOLWINDOW.0;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style as isize);
        }
    }
    let _ = win.set_skip_taskbar(true);
}

fn work_area(m: &tauri::Monitor) -> WorkArea {
    let wa = m.work_area();
    WorkArea { x: wa.position.x, y: wa.position.y, width: wa.size.width as i32, height: wa.size.height as i32 }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则（含 DIP 这类大写缩写），snake_case 检查不适用
    use super::*;

    const FULL_HD: WorkArea = WorkArea { x: 0, y: 0, width: 1920, height: 1080 };

    #[derive(Debug, PartialEq)]
    enum LandingCall {
        Apply(RectDip),
        Visible,
        Read,
        Primary,
        Vital(String),
    }

    struct FakeLandingPort {
        truths: std::collections::VecDeque<Option<WindowTruth>>,
        primary: Option<DisplayGeometry>,
        calls: Vec<LandingCall>,
    }

    impl FakeLandingPort {
        fn new(truths: Vec<Option<WindowTruth>>, primary: Option<DisplayGeometry>) -> Self {
            Self { truths: truths.into(), primary, calls: Vec::new() }
        }
    }

    impl LandingPort for FakeLandingPort {
        fn apply_rect(&mut self, rect: RectDip) { self.calls.push(LandingCall::Apply(rect)); }
        fn make_visible(&mut self) { self.calls.push(LandingCall::Visible); }
        fn read_truth(&mut self) -> Option<WindowTruth> {
            self.calls.push(LandingCall::Read);
            self.truths.pop_front().expect("协议回读次数超出脚本")
        }
        fn primary_monitor(&mut self) -> Option<DisplayGeometry> {
            self.calls.push(LandingCall::Primary);
            self.primary
        }
        fn vital(&mut self, message: &str) { self.calls.push(LandingCall::Vital(message.to_string())); }
    }

    fn full_hd_display() -> DisplayGeometry {
        DisplayGeometry { work: FULL_HD, scale: 1.0, screen_height: 1080.0 }
    }

    fn broken_display() -> DisplayGeometry {
        // 回放工作区读数损坏；负宽会让算出的意图与工作区不相交，触发 Offscreen 修复。
        DisplayGeometry {
            work: WorkArea { width: -4000, ..FULL_HD },
            ..full_hd_display()
        }
    }

    const INTENDED: RectDip = RectDip { x: 724.0, y: 68.0, width: 473.0, height: 945.0 };
    const PARKED: RectDip = RectDip { x: 1940.0, y: 0.0, ..INTENDED };
    const OFFSCREEN_INTENT: RectDip = RectDip { x: -2237.0, ..INTENDED };

    #[test]
    fn 面板尺寸高八分之七宽为高之半() {
        // 1080p @1x：h=round(1080×7/8)=945，w=round(472.5)=473（round 远离零）
        assert_eq!(sized(1080.0, 1.0), (473.0, 945.0));
        // 1440 物理 @2x：DIP 高 720 → h=630，w=315——比值在 DIP 空间算
        assert_eq!(sized(1440.0, 2.0), (315.0, 630.0));
        // 1440 物理 @1.75：DIP 高 822.857 → h=round(720.0)=720，w=360
        assert_eq!(sized(1440.0, 1.75), (360.0, 720.0));
    }

    #[test]
    fn 同DIP密度不同分辨率给出同尺寸() {
        // 4K@2x 与 1080p@1x 的 DIP 屏幕高都是 1080 → 面板尺寸完全相同：
        // 「适应任何 DPI」不是运行时补偿，而是公式在 DIP 空间的直接推论
        assert_eq!(sized(2160.0, 2.0), sized(1080.0, 1.0));
        // 2560 物理 @1.25 与 2048 物理 @1.0 的 DIP 高同为 2048 → 同尺寸
        assert_eq!(sized(2560.0, 1.25), sized(2048.0, 1.0));
    }

    #[test]
    fn 居中按缩放换算后取整() {
        // 1x：x=(1920-418)/2=751，y=(1080-823)/2=128.5 -> 129（round 远离零）
        assert_eq!(centered(FULL_HD, 1.0, 418.0, 823.0), (751.0, 129.0));
        // 2x：工作区先换算成 960x540 DIP 再居中；面板比工作区还高时 y 为负（沿用既有行为）
        assert_eq!(centered(FULL_HD, 2.0, 418.0, 823.0), (271.0, -142.0));
    }

    #[test]
    fn 居中结果不随显示器原点丢失() {
        let work = WorkArea { x: 1920, y: 0, width: 2560, height: 1440 };
        assert_eq!(centered(work, 1.0, 418.0, 823.0), (2991.0, 309.0));
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

    // —— 呼出落位：可见 + 与意图相符 + 在工作区内，三条合成一个「落地」 ——

    fn truth(x: f64, y: f64, w: f64, h: f64, visible: bool) -> WindowTruth {
        WindowTruth { visible, rect: RectDip { x, y, width: w, height: h } }
    }

    #[test]
    fn 落位判定_可见相符才算落地_取整偏差不算失败() {
        let intent = RectDip { x: 751.0, y: 129.0, width: 418.0, height: 823.0 };
        assert_eq!(
            landing_verdict(intent, truth(751.0, 129.0, 418.0, 823.0, true), FULL_HD, 1.0),
            Landing::Landed
        );
        // 分数缩放下 SetWindowPos 的取整会差一两个像素：仍在容差内，不算没落地
        assert_eq!(
            landing_verdict(intent, truth(752.5, 127.5, 419.5, 824.5, true), FULL_HD, 1.0),
            Landing::Landed
        );
    }

    #[test]
    fn 落位判定_不可见与没挪动与意图本身在屏外分成三种() {
        let intent = RectDip { x: 751.0, y: 129.0, width: 418.0, height: 823.0 };
        // 不可见：位置对不对都不算落地（整条链唯一那次「不可见 → 可见」没办成）
        assert_eq!(
            landing_verdict(intent, truth(751.0, 129.0, 418.0, 823.0, false), FULL_HD, 1.0),
            Landing::Hidden
        );
        // 还停在屏外（工作区右缘之外就是停靠位）：投递到了，但没生效
        assert_eq!(
            landing_verdict(intent, truth(1940.0, 0.0, 418.0, 823.0, true), FULL_HD, 1.0),
            Landing::Moved
        );
        // 位置对了、尺寸没跟上：同属「没生效」
        assert_eq!(
            landing_verdict(intent, truth(751.0, 129.0, 473.0, 945.0, true), FULL_HD, 1.0),
            Landing::Moved
        );
        // 位置与意图相符，但那个意图本身在工作区之外（工作区读歪了）→ 得重算
        let bogus = RectDip { x: 3000.0, y: 0.0, width: 418.0, height: 823.0 };
        assert_eq!(
            landing_verdict(bogus, truth(3000.0, 0.0, 418.0, 823.0, true), FULL_HD, 1.0),
            Landing::Offscreen
        );
    }

    #[test]
    fn 落位判定_工作区按缩放换算_两个缩放给出不同结论() {
        // 2x 下 1920x1080 物理 = 960x540 DIP：DIP x=1000 已在工作区之外
        let right = RectDip { x: 1000.0, y: 0.0, width: 418.0, height: 200.0 };
        assert_eq!(
            landing_verdict(right, truth(1000.0, 0.0, 418.0, 200.0, true), FULL_HD, 2.0),
            Landing::Offscreen,
            "缩放没被当成 1.0"
        );
        // 同一组数按 1x 换算就落在区内（工作区 1920 宽）
        assert_eq!(
            landing_verdict(right, truth(1000.0, 0.0, 418.0, 200.0, true), FULL_HD, 1.0),
            Landing::Landed
        );
        // 面板比工作区还高（居中会给负 y）仍有交集：竖直方向不是「不相交」
        let tall = RectDip { x: 271.0, y: -142.0, width: 418.0, height: 823.0 };
        assert_eq!(
            landing_verdict(tall, truth(271.0, -142.0, 418.0, 823.0, true), FULL_HD, 2.0),
            Landing::Landed
        );
    }

    #[test]
    fn 呼出协议_最终判定与日志矩形共用一次回读() {
        let mut port = FakeLandingPort::new(vec![
            Some(WindowTruth { visible: true, rect: INTENDED }),
            Some(WindowTruth { visible: true, rect: PARKED }),
        ], None);
        land_panel(&mut port, full_hd_display());
        assert_eq!(port.calls, vec![
            LandingCall::Apply(INTENDED), LandingCall::Visible, LandingCall::Read, LandingCall::Read,
            LandingCall::Vital("summon-landed first=Landed final=Moved repair=- scale=1 intent=724,68 473x945 actual=1940,0 473x945".to_string()),
        ]);
    }

    #[test]
    fn 呼出协议_不可见不重复显形_读不到也保留最终读数() {
        let mut port = FakeLandingPort::new(vec![
            Some(WindowTruth { visible: false, rect: INTENDED }), None,
        ], None);
        land_panel(&mut port, full_hd_display());
        assert_eq!(port.calls, vec![
            LandingCall::Apply(INTENDED), LandingCall::Visible, LandingCall::Read, LandingCall::Read,
            LandingCall::Vital("summon-landed first=Hidden final=Hidden repair=- scale=1 intent=724,68 473x945 actual=unreadable".to_string()),
        ]);
    }

    #[test]
    fn 呼出协议_位置未生效只重设几何后回读() {
        let mut port = FakeLandingPort::new(vec![
            Some(WindowTruth { visible: true, rect: PARKED }),
            Some(WindowTruth { visible: true, rect: INTENDED }),
        ], None);
        land_panel(&mut port, full_hd_display());
        assert_eq!(port.calls, vec![
            LandingCall::Apply(INTENDED), LandingCall::Visible, LandingCall::Read,
            LandingCall::Apply(INTENDED), LandingCall::Read,
            LandingCall::Vital("summon-landed first=Moved final=Landed repair=reposition scale=1 intent=724,68 473x945 actual=724,68 473x945".to_string()),
        ]);
    }

    #[test]
    fn 呼出协议_意图屏外时按主屏自己的工作区与缩放重算() {
        let primary = DisplayGeometry {
            work: WorkArea { x: 1920, y: 0, width: 3840, height: 2160 },
            scale: 2.0,
            screen_height: 2160.0,
        };
        let primary_intent = RectDip { x: 1684.0, ..INTENDED };
        let mut port = FakeLandingPort::new(vec![
            Some(WindowTruth { visible: true, rect: OFFSCREEN_INTENT }),
            Some(WindowTruth { visible: true, rect: primary_intent }),
        ], Some(primary));
        land_panel(&mut port, broken_display());
        assert_eq!(port.calls, vec![
            LandingCall::Apply(OFFSCREEN_INTENT), LandingCall::Visible, LandingCall::Read,
            LandingCall::Primary, LandingCall::Apply(primary_intent), LandingCall::Visible,
            LandingCall::Read,
            LandingCall::Vital("summon-landed first=Offscreen final=Landed repair=refit scale=2 intent=1684,68 473x945 actual=1684,68 473x945".to_string()),
        ]);
    }

    #[test]
    fn 呼出协议_缺主屏留分流读数并继续回读最终状态() {
        let snapshot = Some(WindowTruth { visible: true, rect: OFFSCREEN_INTENT });
        let mut port = FakeLandingPort::new(vec![snapshot, snapshot], None);
        land_panel(&mut port, broken_display());
        assert_eq!(port.calls, vec![
            LandingCall::Apply(OFFSCREEN_INTENT), LandingCall::Visible, LandingCall::Read,
            LandingCall::Primary, LandingCall::Vital("summon-no-primary".to_string()),
            LandingCall::Read,
            LandingCall::Vital("summon-landed first=Offscreen final=Offscreen repair=- scale=1 intent=-2237,68 473x945 actual=-2237,68 473x945".to_string()),
        ]);
    }

    #[test]
    fn 迟到的旧几何效果作废_只有最新一次能落地() {
        // 投递代数：晚发的效果作废早发的（哪怕它先被投出去、重投更晚才到）
        assert!(!superseded(7, 7), "自己就是最新的一次，照常落地");
        assert!(superseded(6, 7), "已经有第 7 次几何效果了，第 6 次的重投必须丢弃");
        assert!(!superseded(8, 8));
        assert!(superseded(8, 9));
    }
}
