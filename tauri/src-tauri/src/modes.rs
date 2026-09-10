// 面板模式状态的唯一入口：一条专用执行线程独占 PanelModes，外部只能投递具名操作。
//
// 为什么需要这条 seam：tauri-plugin-global-shortcut 的 register/unregister 内部是
// 「投递主线程 + 阻塞等待」（run_main_thread! 宏）。任何线程在持有 PanelModes 时调用它，
// 而主线程恰好在等这把锁（点击面板后的 Focused 事件任务就是这种路径），即互等死锁
// —— 历史上表现为「点击复制并粘贴 → 无响应卡死」。
//
// 解法是把状态机锁进一条线程：调用方拿不到 &mut PanelModes，只能说出「要做什么」。
// 于是「绝不从主线程碰模式」不再靠注释维系，而是编译期就没那个类型可拿。
//
// 方法分两类用法，同一组签名：
//   - 回调线程（热键分发 / 全局点击 / 托盘 / 单实例 / 窗口事件）：直接调用、忽略返回值，
//     回调必须立即返回；
//   - async 命令线程：`.await` 拿结果（需要回报渲染层成败时用）。
// 忽略返回值不影响任务投递：send 已经完成，只是没人收结果。
//
// 每次任务结束后刷新主线程用的无锁原子快照（AppState::modes_visible /
// modes_input_active），主线程只读快照、绝不阻塞在模式上。

use crate::focus_paste;
use crate::hotkeys::{format_shortcut, Hotkeys};
use crate::panel_modes::{is_repeatable_navigation, FocusTarget, HotkeyAction, Mode, ModesHost, PanelModes};
use crate::{
    diag_log, emit_panel, panel, send_focus_error, AppState,
    ShortcutCaptureStartPayload, PanelKeyPayload,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

type ModesJob = Box<dyn FnOnce(&mut PanelModes, &mut Host) + Send>;
type Reply<R> = tokio::sync::oneshot::Receiver<R>;

// Windows 的全局热键关闭了系统自动重复，↑/↓ 这两档由本 module 自行重复投递。
const NAV_REPEAT_INITIAL_DELAY: Duration = Duration::from_millis(300);
const NAV_REPEAT_INTERVAL: Duration = Duration::from_millis(50);

// ---------- 效果宿主（私有：只有执行线程能构造，只有本 module 能用） ----------

struct Host {
    app: AppHandle,
    // 「现在哪些全局键生效」的唯一真源（双向表 + 插件端口），见 hotkeys.rs。
    // 由执行线程独占，所以「查重 → 调插件 → 记账」三步天然原子，也不需要锁。
    hotkeys: Hotkeys,
    // 按住 ↑/↓ 的连发登记。标志置位 = 该连发线程已结束，下一次按下换上新标志；
    // 可连发的键只有上下方向键，表里最多留两条已停的登记，不会无限增长。
    repeating: HashMap<Shortcut, Arc<AtomicBool>>,
}

impl Host {
    fn new(app: &AppHandle) -> Self {
        Host {
            app: app.clone(),
            hotkeys: Hotkeys::new(),
            repeating: HashMap::new(),
        }
    }

    /// 武装连发：先判这个键该不该连发，再判是不是已经有活的线程在发它。
    fn arm_repeat(&mut self, shortcut: Shortcut, accel: &str) {
        if !is_repeatable_navigation(accel) {
            return;
        }
        if let Some(stopped) = self.repeating.get(&shortcut) {
            if !stopped.load(Ordering::Relaxed) {
                return;
            }
        }
        let stopped = Arc::new(AtomicBool::new(false));
        self.repeating.insert(shortcut, stopped.clone());
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(NAV_REPEAT_INITIAL_DELAY);
            while !stopped.load(Ordering::Relaxed) {
                let state = app.state::<AppState>();
                // 面板收起（连发中途粘贴成功也会收）就停手，不等那次松键事件了
                if !state.modes_visible.load(Ordering::Relaxed) {
                    break;
                }
                state.modes.on_hotkey_repeated(shortcut);
                std::thread::sleep(NAV_REPEAT_INTERVAL);
            }
            // 线程收尾：立起标志，让执行线程知道这条登记已经死了
            stopped.store(true, Ordering::Relaxed);
        });
    }

    /// 松开即解除：置位并摘掉登记，连发线程下一轮自己退出。
    fn disarm_repeat(&mut self, shortcut: Shortcut) {
        if let Some(stopped) = self.repeating.remove(&shortcut) {
            stopped.store(true, Ordering::Relaxed);
        }
    }
}

impl ModesHost for Host {
    fn register_key(&mut self, accel: &str, action: HotkeyAction) -> bool {
        // 插件内部会投递主线程并阻塞等待——本方法只在执行线程上调用，主线程永远空闲可处理。
        // 表由执行线程独占，查重与记账之间没有别人插得进来，所以这里不需要任何锁。
        let app = self.app.clone();
        let outcome =
            self.hotkeys.register(accel, action, &mut |s| app.global_shortcut().register(s).is_ok());
        if let Some(message) = outcome.diagnostic(accel) {
            eprintln!("{message}");
        }
        outcome.is_ok()
    }

    fn unregister_key(&mut self, accel: &str) {
        let app = self.app.clone();
        self.hotkeys.unregister(accel, &mut |s| app.global_shortcut().unregister(s).is_ok());
    }

    fn current_keys(&self) -> HashMap<String, HotkeyAction> {
        self.hotkeys.bindings()
    }

    fn can_interact(&self) -> bool {
        panel(&self.app).exists()
    }

    fn focus_panel(&self) {
        panel(&self.app).focus()
    }

    fn blur_panel_if_focused(&self) {
        panel(&self.app).release_focus()
    }

    fn send_panel_key(&self, action: &str, note_entry_id: Option<&str>) {
        emit_panel(
            &self.app,
            "panel:key",
            PanelKeyPayload {
                action: action.to_string(),
                note_entry_id: note_entry_id.map(|s| s.to_string()),
            },
        );
    }

    fn send_panel_shown(&self) {
        emit_panel(&self.app, "panel:shown", ());
    }

    fn send_capture_end(&self) {
        emit_panel(&self.app, "shortcut:capture-end", ());
    }

    fn capture_focus(&self) -> Option<FocusTarget> {
        focus_paste::snapshot().ok()
    }

    fn restore_focus(&self, target: &FocusTarget) {
        if let Err(failure) = focus_paste::restore_and_paste(target, false) {
            send_focus_error(&self.app, failure.stage, failure.reason);
        }
    }

    fn report_no_focus_target(&self) {
        send_focus_error(&self.app, "restore", "no_focus_target");
    }

    fn validate_note_target(&self, target_id: Option<&str>) -> bool {
        let state = self.app.state::<AppState>();
        let store = state.store.lock().unwrap();
        match target_id {
            None => !store.is_empty(),
            Some(id) => store.find(id).is_some(),
        }
    }

}

// ---------- 具名操作（以下私有函数只在执行线程的任务闭包内调用） ----------

fn show_on(app: &AppHandle, modes: &mut PanelModes, host: &mut Host, capture: bool) {
    diag_log(&format!("show_panel capture={capture}"));
    if capture {
        // 呼出时序：先记录前台窗口与焦点控件，再显示面板（失败静默，面板照常显示）
        modes.ensure_focus_target(host, false);
    }
    panel(app).show_at_cursor();
    // 状态机负责：重置搜索/备注态、推导注册导航键、通知渲染层（panel:shown）
    modes.show(host);
    // 不在这里 broadcast()：历史由 600ms 轮询实时推送，呼出时强制刷新反而导致列表重绘闪烁
}

fn hide_on(app: &AppHandle, modes: &mut PanelModes, host: &mut Host, restore_focus: bool) {
    diag_log(&format!("hide_panel restore_focus={restore_focus}"));
    // 状态机负责：逐层退出捕获/备注/搜索（发对退出事件）、注销导航键、消费焦点快照
    modes.hide(host, restore_focus);
    panel(app).park_offscreen();
}

fn toggle_on(app: &AppHandle, modes: &mut PanelModes, host: &mut Host) {
    if modes.is_panel_visible() {
        hide_on(app, modes, host, true);
    } else {
        show_on(app, modes, host, true);
    }
}

// 热键动作的统一执行：动作查 hotkeys 那张表，效果在这里串联。
// `arm_repeat` = 只有真实按下才武装连发；连发线程自投递的那一路不再武装。
fn perform_hotkey(
    app: &AppHandle,
    modes: &mut PanelModes,
    host: &mut Host,
    shortcut: Shortcut,
    arm_repeat: bool,
) {
    let Some(accel) = host.hotkeys.accel_of(shortcut).map(str::to_string) else {
        return; // 表里没有 = 不是我们注册的键，忽略
    };
    let Some(action) = host.hotkeys.action_of(shortcut) else {
        return;
    };
    diag_log(&format!("dispatch_hotkey accel={accel}"));
    match action {
        HotkeyAction::Toggle => toggle_on(app, modes, host),
        HotkeyAction::Nav(nav) => {
            modes.on_nav_action(host, nav);
            if arm_repeat {
                host.arm_repeat(shortcut, &accel);
            }
        }
    }
}

// ---------- 入口 ----------

#[derive(Clone)]
pub struct Modes {
    tx: std_mpsc::Sender<ModesJob>,
    app: AppHandle,
}

impl Modes {
    /// 启动执行线程并返回入口句柄。必须在 AppState 已 manage 之后调用
    /// （任务收尾要写无锁快照）。
    pub fn spawn(app: &AppHandle) -> Modes {
        let (tx, rx) = std_mpsc::channel::<ModesJob>();
        let app_handle = app.clone();
        let _ = std::thread::Builder::new()
            .name("modes-executor".into())
            .spawn(move || {
                let mut modes = PanelModes::new();
                let mut host = Host::new(&app_handle);
                while let Ok(job) = rx.recv() {
                    job(&mut modes, &mut host);
                    let st = modes.state();
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        state.modes_visible.store(st.visible, Ordering::Relaxed);
                        state.modes_input_active.store(st.input_active(), Ordering::Relaxed);
                    }
                }
            });
        Modes { tx, app: app.clone() }
    }

    fn submit<R>(&self, f: impl FnOnce(&mut PanelModes, &mut Host) -> R + Send + 'static) -> Reply<R>
    where
        R: Send + 'static,
    {
        let (rtx, rrx) = tokio::sync::oneshot::channel();
        let _ = self.tx.send(Box::new(move |modes, host| {
            let _ = rtx.send(f(modes, host));
        }));
        rrx
    }

    // —— 呼出 / 隐藏 ——

    pub fn show(&self) -> Reply<()> {
        let app = self.app.clone();
        self.submit(move |modes, host| {
            show_on(&app, modes, host, true);
        })
    }

    /// 隐藏并归还焦点（Esc、点击面板外、关闭窗口、点 X 都走这里）
    pub fn hide(&self) -> Reply<()> {
        let app = self.app.clone();
        self.submit(move |modes, host| {
            hide_on(&app, modes, host, true);
        })
    }

    /// 粘贴成功后隐藏：焦点已经由粘贴链路归还，不再重复恢复
    pub fn hide_after_paste(&self) -> Reply<()> {
        let app = self.app.clone();
        self.submit(move |modes, host| {
            hide_on(&app, modes, host, false);
        })
    }

    // —— 全局输入事件 ——

    /// 热键按下：回调线程只交出 Shortcut、立即返回；「这是哪个动作」由 hotkeys 那张表在
    /// 执行线程上判（分发不再按 accel 查状态机，两份真源就此并成一份）。
    pub fn on_hotkey_pressed(&self, shortcut: Shortcut) -> Reply<()> {
        let app = self.app.clone();
        self.submit(move |modes, host| perform_hotkey(&app, modes, host, shortcut, true))
    }

    /// 连发线程自投递：只执行、不武装。
    pub fn on_hotkey_repeated(&self, shortcut: Shortcut) -> Reply<()> {
        let app = self.app.clone();
        self.submit(move |modes, host| perform_hotkey(&app, modes, host, shortcut, false))
    }

    /// 热键松开：解除连发登记。
    pub fn on_hotkey_released(&self, shortcut: Shortcut) -> Reply<()> {
        self.submit(move |_modes, host| host.disarm_repeat(shortcut))
    }

    /// 全局鼠标钩子回调：点击面板外即隐藏。
    /// 命中判定（含按显示器缩放换算 DIP）在 PanelWindow 内部；判不出来时不隐藏。
    pub fn hide_if_clicked_outside(&self, x: i32, y: i32) -> Reply<()> {
        let app = self.app.clone();
        self.submit(move |modes, host| {
            if !modes.is_panel_visible() {
                return;
            }
            if !matches!(panel(&app).hit_test(x, y), Some(false)) {
                return;
            }
            hide_on(&app, modes, host, true);
        })
    }

    // —— 输入态 ——

    pub fn set_toggle_shortcut(&self, accel: &str) -> Reply<()> {
        let accel = accel.to_string();
        self.submit(move |modes, host| modes.set_toggle_shortcut(&accel, host))
    }

    pub fn begin_search(&self) -> Reply<bool> {
        self.submit(|modes, host| modes.enter_input(host, Mode::Search, None))
    }

    pub fn set_composing(&self, composing: bool) -> Reply<()> {
        self.submit(move |modes, host| modes.set_composing(host, composing))
    }

    pub fn end_note_edit(&self) -> Reply<()> {
        self.submit(|modes, host| modes.exit_input(host, Mode::NoteEdit, true))
    }

    /// 托盘「更换快捷键」：进入捕获态、呼出并聚焦面板、通知渲染层显示覆盖层
    pub fn begin_shortcut_capture(&self) -> Reply<()> {
        let app = self.app.clone();
        self.submit(move |modes, host| {
            if !modes.enter_input(host, Mode::ShortcutCapture, None) {
                return;
            }
            show_on(&app, modes, host, false);
            // 捕获按键前聚焦面板（基线 focusable:true，直接 focus 即可）
            host.focus_panel();
            let current = format_shortcut(&app.state::<AppState>().settings.lock().unwrap().shortcut);
            emit_panel(
                &app,
                "shortcut:capture-start",
                ShortcutCaptureStartPayload { current },
            );
        })
    }

    pub fn cancel_shortcut_capture(&self) -> Reply<()> {
        self.submit(|modes, host| modes.exit_input(host, Mode::ShortcutCapture, true))
    }

    pub fn try_set_toggle_shortcut(&self, accel: &str) -> Reply<bool> {
        let accel = accel.to_string();
        self.submit(move |modes, host| modes.try_set_toggle_shortcut(host, &accel))
    }

    pub fn restore_original_focus(&self) -> Reply<()> {
        self.submit(|modes, host| modes.restore_original_focus(host))
    }

    /// 粘贴链路取当前焦点快照（无快照时命令侧按 no_focus_target 报错）
    pub fn focus_target(&self) -> Reply<Option<FocusTarget>> {
        self.submit(|modes, _host| modes.focus_target_snapshot())
    }
}
