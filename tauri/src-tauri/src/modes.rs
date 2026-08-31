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
use crate::panel_modes::{FocusTarget, HotkeyAction, Mode, ModesHost, PanelModes};
use crate::{
    diag_log, emit_panel, format_shortcut, panel, send_focus_error, AppState,
    ShortcutCaptureStartPayload, PanelKeyPayload,
};
use std::sync::mpsc as std_mpsc;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

type ModesJob = Box<dyn FnOnce(&mut PanelModes, &mut Host) + Send>;
type Reply<R> = tokio::sync::oneshot::Receiver<R>;

// ---------- 效果宿主（私有：只有执行线程能构造，只有本 module 能用） ----------

struct Host {
    app: AppHandle,
}

impl Host {
    fn new(app: &AppHandle) -> Self {
        Host { app: app.clone() }
    }
}

impl ModesHost for Host {
    fn register_key(&mut self, accel: &str, _action: HotkeyAction) -> bool {
        use tauri_plugin_global_shortcut::Shortcut;
        let Ok(shortcut) = accel.to_string().parse::<Shortcut>() else {
            eprintln!("注册全局快捷键 {accel} 失败：无法解析");
            return false;
        };
        let state = self.app.state::<AppState>();
        {
            let hotkeys = state.hotkeys.lock().unwrap();
            if hotkeys.contains_key(&shortcut) {
                return false;
            }
        }
        // 插件内部会投递主线程并阻塞等待——本方法只在执行线程上调用，主线程永远空闲可处理
        let ok = self.app.global_shortcut().register(shortcut).is_ok();
        if ok {
            state.hotkeys.lock().unwrap().insert(shortcut, accel.to_string());
        } else {
            eprintln!("注册全局快捷键 {accel} 失败（可能被其他程序占用）");
        }
        ok
    }

    fn unregister_key(&mut self, accel: &str) {
        let state = self.app.state::<AppState>();
        let shortcut = {
            let hotkeys = state.hotkeys.lock().unwrap();
            hotkeys
                .iter()
                .find(|(_, a)| a.as_str() == accel)
                .map(|(s, _)| *s)
        };
        if let Some(shortcut) = shortcut {
            let _ = self.app.global_shortcut().unregister(shortcut);
            state.hotkeys.lock().unwrap().remove(&shortcut);
        }
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

    fn on_toggle_requested(&self) {
        // Toggle 统一由 dispatch_accel 在执行线程上处理（&self 拿不到 &mut PanelModes）；
        // 本方法为 trait 完整性保留
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
                        state
                            .modes_input_active
                            .store(st.visible && st.mode != Mode::Browse, Ordering::Relaxed);
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

    /// 热键回调：按 accel 找到动作并分发（呼出键与导航键的集合由状态机推导）
    pub fn dispatch_accel(&self, accel: &str) -> Reply<()> {
        let app = self.app.clone();
        let accel = accel.to_string();
        self.submit(move |modes, host| {
            diag_log(&format!("dispatch_hotkey accel={accel}"));
            match modes.registered_action_for(&accel) {
                Some(HotkeyAction::Toggle) => toggle_on(&app, modes, host),
                Some(HotkeyAction::Nav(nav)) => modes.on_nav_action(host, nav),
                None => {}
            }
        })
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
        self.submit(|modes, host| modes.begin_search(host))
    }

    pub fn set_composing(&self, composing: bool) -> Reply<()> {
        self.submit(move |modes, host| modes.set_composing(host, composing))
    }

    pub fn begin_note_edit(&self, id: Option<String>) -> Reply<bool> {
        self.submit(move |modes, host| modes.begin_note_edit(host, id.as_deref()))
    }

    pub fn end_note_edit(&self) -> Reply<()> {
        self.submit(|modes, host| modes.end_note_edit(host, true))
    }

    /// 托盘「更换快捷键」：进入捕获态、呼出并聚焦面板、通知渲染层显示覆盖层
    pub fn begin_shortcut_capture(&self) -> Reply<()> {
        let app = self.app.clone();
        self.submit(move |modes, host| {
            if !modes.begin_shortcut_capture(host) {
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
        self.submit(|modes, host| modes.cancel_shortcut_capture(host, true))
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
        self.submit(|modes, _host| modes.focus_target_snapshot_cloned())
    }
}
