// 面板模式状态机：浏览 / 搜索模式（含 IME 组合子态）/ 备注编辑 / 快捷键捕获。
// 纯逻辑 module：不依赖 tauri / Win32。模式状态、转换级联、全局热键集合的推导与差量应用
// 全部收在本 module 的 interface 之后；窗口焦点、渲染层通知、焦点快照等效果经 host 注入。
//
// 与 Electron 版（electron/panel-modes.js）的差异只有一处：JS 里 captureFocus 是到助手
// 进程的异步 JSON-RPC，Rust 里是进程内同步 Win32 调用（focus_paste::snapshot），
// 因此整个状态机从 async 变为同步，行为语义不变。
//
// 设计要点（沿用原版）：
// - 全局快捷键（呼出键 + 面板导航键）由「当前模式」唯一推导：desired_keys() 给出目标集合，
//   apply_hotkeys() 与已注册集合做差量同步。模式转换不再各自手写 register/unregister。
// - 焦点快照（FocusTarget）的生命周期归本 module：呼出/进入输入态前确保有快照，
//   退出输入态归还焦点（快照保留，同一次呼出内复用），隐藏面板时消费快照并清空。
// - 渲染层仍通过原有 panel:key / panel:shown / shortcut:capture-* 事件感知模式变化（协议不变）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusTarget {
    pub hwnd: i64,
    pub focus_hwnd: i64,
    pub pid: u64,
    pub tid: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavAction {
    Up,
    Down,
    Enter,
    Escape,
    Delete,
    Pin,
    Note,
    Search,
}

impl NavAction {
    pub fn as_str(self) -> &'static str {
        match self {
            NavAction::Up => "up",
            NavAction::Down => "down",
            NavAction::Enter => "enter",
            NavAction::Escape => "escape",
            NavAction::Delete => "delete",
            NavAction::Pin => "pin",
            NavAction::Note => "note",
            NavAction::Search => "search",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyAction {
    Toggle,
    Nav(NavAction),
}

// 面板导航键：[accelerator, action, 是否在搜索模式下继续拦截]。
// 搜索模式里 Space/Z/Del/B 让位给搜索输入框，↑↓/Enter/Esc 保持面板语义。
// accelerator 字符串沿用 Electron 版（测试与协议对齐），宿主负责转成插件可注册的 Shortcut。
pub const NAV_SHORTCUTS: [(&str, NavAction, bool); 8] = [
    ("Up", NavAction::Up, true),
    ("Down", NavAction::Down, true),
    ("Enter", NavAction::Enter, true),
    ("Esc", NavAction::Escape, true),
    ("Delete", NavAction::Delete, false),
    ("Z", NavAction::Pin, false),
    ("B", NavAction::Note, false),
    ("Space", NavAction::Search, false),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Browse,
    Search,
    NoteEdit,
    ShortcutCapture,
}

// 效果宿主：本 module 持有状态机锁期间调用这些方法，宿主实现不得回锁状态机。
pub trait ModesHost {
    // —— 全局热键 seam（register_key 返回是否成功）
    fn register_key(&mut self, accel: &str, action: HotkeyAction) -> bool;
    fn unregister_key(&mut self, accel: &str);
    // —— 面板窗口效果
    fn can_interact(&self) -> bool;
    fn focus_panel(&self);
    fn blur_panel_if_focused(&self);
    // —— 渲染层通知
    fn send_panel_key(&self, action: &str, note_entry_id: Option<&str>);
    fn send_panel_shown(&self);
    fn send_capture_end(&self);
    // —— 焦点快照通道（Rust 内为同步 Win32 调用）
    fn capture_focus(&self) -> Option<FocusTarget>;
    fn restore_focus(&self, target: &FocusTarget);
    fn report_no_focus_target(&self);
    // —— 领域查询（备注编辑目标校验，由 main.rs 用历史 store 回答）
    fn validate_note_target(&self, target_id: Option<&str>) -> bool;
    // —— 呼出快捷键被按下（main.rs 的分发器直接处理 Toggle，实现为协议完整性保留）
    #[allow(dead_code)]
    fn on_toggle_requested(&self);
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // state() 投影供测试与诊断使用
pub struct PanelModesState {
    pub visible: bool,
    pub mode: Mode,
    pub composing: bool,
    pub note_entry_id: Option<String>,
}

pub struct PanelModes {
    visible: bool,
    mode: Mode,
    composing: bool, // 搜索模式子态：中文输入法组合中
    note_entry_id: Option<String>,
    focus_target: Option<FocusTarget>, // 本次呼出期间的前台焦点快照（退出输入态复用，隐藏时消费）
    toggle_accel: Option<String>,      // 呼出快捷键（捕获期间临时注销，值不变）
    registered: HashMap<String, HotkeyAction>, // accel -> action（本 module 维护的已注册集合）
}

impl Default for PanelModes {
    fn default() -> Self {
        Self::new()
    }
}

impl PanelModes {
    pub fn new() -> Self {
        PanelModes {
            visible: false,
            mode: Mode::Browse,
            composing: false,
            note_entry_id: None,
            focus_target: None,
            toggle_accel: None,
            registered: HashMap::new(),
        }
    }
    // 由当前状态推导应当注册的全局快捷键集合
    fn desired_keys(&self) -> HashMap<String, HotkeyAction> {
        let mut desired = HashMap::new();
        if self.mode != Mode::ShortcutCapture {
            if let Some(accel) = &self.toggle_accel {
                desired.insert(accel.clone(), HotkeyAction::Toggle);
            }
        }
        if !self.visible {
            return desired;
        }
        match self.mode {
            Mode::Browse => {
                for (accel, action, _) in NAV_SHORTCUTS {
                    desired.insert(accel.to_string(), HotkeyAction::Nav(action));
                }
            }
            Mode::Search if !self.composing => {
                // IME 组合期间所有导航键暂停，交给输入法
                for (accel, action, enabled_in_search) in NAV_SHORTCUTS {
                    if enabled_in_search {
                        desired.insert(accel.to_string(), HotkeyAction::Nav(action));
                    }
                }
            }
            _ => {} // note-edit / shortcut-capture：导航键全部让位
        }
        desired
    }

    // 差量同步：只动需要动的键。替代原版散布 13 处的 register/unregister 舞步。
    fn apply_hotkeys(&mut self, host: &mut dyn ModesHost) {
        let desired = self.desired_keys();
        let stale: Vec<String> = self
            .registered
            .keys()
            .filter(|k| !desired.contains_key(*k))
            .cloned()
            .collect();
        for accel in stale {
            host.unregister_key(&accel);
            self.registered.remove(&accel);
        }
        for (accel, action) in desired {
            if !self.registered.contains_key(&accel) {
                if host.register_key(&accel, action) {
                    self.registered.insert(accel, action);
                }
            }
        }
    }

    // 焦点快照：呼出期间复用同一份。report_on_failure=false 用于呼出面板（失败静默，面板照常显示）。
    pub fn ensure_focus_target(&mut self, host: &mut dyn ModesHost, report_on_failure: bool) -> bool {
        if self.focus_target.is_some() {
            return true;
        }
        let target = host.capture_focus();
        let Some(target) = target else {
            if report_on_failure {
                host.report_no_focus_target();
            }
            return false;
        };
        self.focus_target = Some(target);
        true
    }

    // 归还焦点但保留快照（同一次呼出内，退出输入态后还能再进搜索/备注）
    fn restore_focus_keeping_snapshot(&self, host: &dyn ModesHost) {
        if let Some(target) = &self.focus_target {
            host.restore_focus(target);
        }
    }

    // —— 输入态之间的互斥退出（进入另一输入态前调用，不归还焦点）——

    fn exit_note_edit_internal(&mut self, host: &mut dyn ModesHost) {
        self.mode = Mode::Browse;
        self.note_entry_id = None;
        host.send_panel_key("note-edit-exit", None);
        host.blur_panel_if_focused();
        self.apply_hotkeys(host);
    }

    fn exit_search_internal(&mut self, host: &mut dyn ModesHost) {
        self.mode = Mode::Browse;
        self.composing = false;
        host.send_panel_key("search-exit", None);
        host.blur_panel_if_focused();
        self.apply_hotkeys(host);
    }

    #[allow(dead_code)] // 测试使用
    pub fn state(&self) -> PanelModesState {
        PanelModesState {
            visible: self.visible,
            mode: self.mode,
            composing: self.composing,
            note_entry_id: self.note_entry_id.clone(),
        }
    }

    pub fn is_panel_visible(&self) -> bool {
        self.visible
    }

    // 查询某个 accel 当前注册的动作（热键分发用：只读快照，不执行效果）
    pub fn registered_action_for(&self, accel: &str) -> Option<HotkeyAction> {
        self.registered.get(accel).copied()
    }

    // 输入态（搜索/备注/捕获）豁免「浏览态自动失焦」
    #[allow(dead_code)]
    pub fn is_input_active(&self) -> bool {
        self.visible && self.mode != Mode::Browse
    }

    // 启动/更换呼出快捷键（捕获确认也走这里）
    pub fn set_toggle_shortcut(&mut self, accel: &str, host: &mut dyn ModesHost) {
        self.toggle_accel = Some(accel.to_string());
        self.apply_hotkeys(host);
    }

    // 当前焦点快照（只读，不消费）。粘贴链路用它恢复原输入框；隐藏面板时才被消费清空。
    #[allow(dead_code)]
    pub fn focus_target_snapshot(&self) -> Option<&FocusTarget> {
        self.focus_target.as_ref()
    }

    pub fn focus_target_snapshot_cloned(&self) -> Option<FocusTarget> {
        self.focus_target.clone()
    }

    // 呼出面板：重置搜索/备注态；捕获进行中则保持捕获（热键集合由 apply_hotkeys 推导，不会误注册导航键）
    pub fn show(&mut self, host: &mut dyn ModesHost) {
        self.visible = true;
        if self.mode != Mode::ShortcutCapture {
            self.mode = Mode::Browse;
            self.composing = false;
            self.note_entry_id = None;
        }
        self.apply_hotkeys(host);
        host.send_panel_shown();
    }

    // 隐藏面板：按捕获→备注→搜索的顺序逐层退出（同一时刻最多一个输入态，逐层只为发对退出事件），
    // 然后注销导航键（呼出键保留）、消费焦点快照。
    // 返回被消费的焦点快照（restore_focus=true 时由调用方归还焦点）。
    pub fn hide(&mut self, host: &mut dyn ModesHost, restore_focus: bool) -> Option<FocusTarget> {
        let prev_mode = self.mode;
        let was_capturing = prev_mode == Mode::ShortcutCapture;
        self.visible = false;
        self.mode = Mode::Browse;
        self.composing = false;
        self.note_entry_id = None;
        if was_capturing {
            host.send_capture_end();
        }
        if prev_mode == Mode::NoteEdit {
            host.send_panel_key("note-edit-exit", None);
        }
        if prev_mode == Mode::Search {
            host.send_panel_key("search-exit", None);
        }
        self.apply_hotkeys(host);
        host.blur_panel_if_focused();
        let target = self.focus_target.take();
        if restore_focus {
            if let Some(target) = &target {
                host.restore_focus(target);
            }
        }
        target
    }

    // 全局热键导航动作的统一入口（原版 navHandler 闭包的移植）：
    // search/escape(搜索态)/note 三个动作在状态机内消化，其余转发渲染层。
    pub fn on_nav_action(&mut self, host: &mut dyn ModesHost, action: NavAction) {
        match action {
            NavAction::Search => {
                self.begin_search(host);
            }
            NavAction::Escape if self.mode == Mode::Search => {
                self.end_search(host, true);
            }
            NavAction::Note => {
                self.begin_note_edit(host, None);
            }
            other => {
                host.send_panel_key(other.as_str(), None);
            }
        }
    }

    // 进入搜索模式：先退出备注编辑；快照缺失先补拍（失败上报并放弃）；
    // 切换热键集合（Space/Z/Del/B 让位），聚焦面板，通知渲染层。
    pub fn begin_search(&mut self, host: &mut dyn ModesHost) -> bool {
        if !host.can_interact() || !self.visible || self.mode == Mode::Search {
            return false;
        }
        if self.mode == Mode::NoteEdit {
            self.exit_note_edit_internal(host);
        }
        if !self.ensure_focus_target(host, true) {
            return false;
        }
        self.mode = Mode::Search;
        self.composing = false;
        self.apply_hotkeys(host);
        host.focus_panel();
        host.send_panel_key("search-enter", None);
        true
    }

    // 退出搜索模式：恢复浏览态热键集合，归还焦点（快照保留）。
    pub fn end_search(&mut self, host: &mut dyn ModesHost, restore_focus: bool) {
        if self.mode != Mode::Search {
            return;
        }
        self.mode = Mode::Browse;
        self.composing = false;
        self.apply_hotkeys(host);
        host.blur_panel_if_focused();
        host.send_panel_key("search-exit", None);
        if restore_focus {
            self.restore_focus_keeping_snapshot(host);
        }
    }

    // 中文输入法组合开始/结束：组合期间暂停全部导航键
    pub fn set_composing(&mut self, host: &mut dyn ModesHost, value: bool) {
        if self.composing == value {
            return;
        }
        self.composing = value;
        if self.visible && self.mode == Mode::Search {
            self.apply_hotkeys(host);
        }
    }

    // 进入备注编辑：先退出搜索；补拍快照（失败上报并放弃）；校验目标条目；注销导航键，聚焦面板。
    pub fn begin_note_edit(&mut self, host: &mut dyn ModesHost, target_id: Option<&str>) -> bool {
        if !host.can_interact() || !self.visible || self.mode == Mode::NoteEdit {
            return false;
        }
        if self.mode == Mode::Search {
            self.exit_search_internal(host);
        }
        if !self.ensure_focus_target(host, true) {
            return false;
        }
        if !host.validate_note_target(target_id) {
            return false;
        }
        self.mode = Mode::NoteEdit;
        self.note_entry_id = target_id.map(|s| s.to_string());
        self.apply_hotkeys(host);
        host.focus_panel();
        host.send_panel_key("note-edit-enter", self.note_entry_id.as_deref());
        true
    }

    // 退出备注编辑：通知渲染层保存草稿，归还焦点，恢复浏览态热键（快照保留）。
    pub fn end_note_edit(&mut self, host: &mut dyn ModesHost, restore_focus: bool) {
        if self.mode != Mode::NoteEdit {
            return;
        }
        self.mode = Mode::Browse;
        self.note_entry_id = None;
        host.send_panel_key("note-edit-exit", None);
        host.blur_panel_if_focused();
        self.apply_hotkeys(host);
        if restore_focus {
            self.restore_focus_keeping_snapshot(host);
        }
    }

    // 开始快捷键捕获：先退出其它输入态，注销呼出键与全部导航键（按键让位给要捕获的组合键）。
    // 面板显示与 capture-start 事件由 main.rs 随后编排（show 保持捕获态）。
    pub fn begin_shortcut_capture(&mut self, host: &mut dyn ModesHost) -> bool {
        if !host.can_interact() || self.mode == Mode::ShortcutCapture {
            return false;
        }
        if self.mode == Mode::NoteEdit {
            self.exit_note_edit_internal(host);
        }
        if self.mode == Mode::Search {
            self.exit_search_internal(host);
        }
        if !self.ensure_focus_target(host, true) {
            return false;
        }
        self.mode = Mode::ShortcutCapture;
        self.apply_hotkeys(host);
        true
    }

    // 取消捕获：恢复原呼出键与（面板仍显示时的）导航键，通知渲染层收起覆盖层。
    pub fn cancel_shortcut_capture(&mut self, host: &mut dyn ModesHost, restore_focus: bool) {
        if self.mode != Mode::ShortcutCapture {
            return;
        }
        self.mode = Mode::Browse;
        self.apply_hotkeys(host);
        host.blur_panel_if_focused();
        host.send_capture_end();
        if restore_focus {
            self.restore_focus_keeping_snapshot(host);
        }
    }

    // 捕获确认：新呼出键注册成功才算成功；成功则退出捕获态（不发 capture-end，覆盖层由渲染层自行收起）。
    pub fn try_set_toggle_shortcut(&mut self, host: &mut dyn ModesHost, accel: &str) -> bool {
        if self.mode != Mode::ShortcutCapture {
            return false;
        }
        if !host.register_key(accel, HotkeyAction::Toggle) {
            return false;
        }
        self.registered.insert(accel.to_string(), HotkeyAction::Toggle);
        self.toggle_accel = Some(accel.to_string());
        self.mode = Mode::Browse;
        self.apply_hotkeys(host);
        host.blur_panel_if_focused();
        true
    }

    // 把焦点还回原程序（捕获确认路径使用；快照保留到 hidePanel 时消费）
    pub fn restore_original_focus(&self, host: &dyn ModesHost) {
        self.restore_focus_keeping_snapshot(host);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    struct MockHost {
        registered: Rc<RefCell<HashMap<String, HotkeyAction>>>,
        events: Rc<RefCell<Vec<(String, String, Option<String>)>>>, // (channel, action, noteEntryId)
        focus_snapshot: Rc<RefCell<Option<FocusTarget>>>,
        snapshot_requests: Rc<RefCell<usize>>,
        restored: Rc<RefCell<Vec<FocusTarget>>>,
        no_focus_errors: Rc<RefCell<usize>>,
        focused: Rc<RefCell<usize>>,
        blurred: Rc<RefCell<usize>>,
    }

    impl MockHost {
        fn new() -> Self {
            MockHost {
                registered: Rc::new(RefCell::new(HashMap::new())),
                events: Rc::new(RefCell::new(Vec::new())),
                focus_snapshot: Rc::new(RefCell::new(None)),
                snapshot_requests: Rc::new(RefCell::new(0)),
                restored: Rc::new(RefCell::new(Vec::new())),
                no_focus_errors: Rc::new(RefCell::new(0)),
                focused: Rc::new(RefCell::new(0)),
                blurred: Rc::new(RefCell::new(0)),
            }
        }
    }

    impl ModesHost for MockHost {
        fn register_key(&mut self, accel: &str, action: HotkeyAction) -> bool {
            let mut reg = self.registered.borrow_mut();
            if reg.contains_key(accel) {
                return false;
            }
            reg.insert(accel.to_string(), action);
            true
        }
        fn unregister_key(&mut self, accel: &str) {
            self.registered.borrow_mut().remove(accel);
        }
        fn can_interact(&self) -> bool {
            true
        }
        fn focus_panel(&self) {
            *self.focused.borrow_mut() += 1;
        }
        fn blur_panel_if_focused(&self) {
            *self.blurred.borrow_mut() += 1;
        }
        fn send_panel_key(&self, action: &str, note_entry_id: Option<&str>) {
            self.events.borrow_mut().push((
                "panel:key".to_string(),
                action.to_string(),
                note_entry_id.map(|s| s.to_string()),
            ));
        }
        fn send_panel_shown(&self) {
            self.events.borrow_mut().push(("panel:shown".to_string(), String::new(), None));
        }
        fn send_capture_end(&self) {
            self.events.borrow_mut().push(("shortcut:capture-end".to_string(), String::new(), None));
        }
        fn capture_focus(&self) -> Option<FocusTarget> {
            *self.snapshot_requests.borrow_mut() += 1;
            self.focus_snapshot.borrow().clone()
        }
        fn restore_focus(&self, target: &FocusTarget) {
            self.restored.borrow_mut().push(target.clone());
        }
        fn report_no_focus_target(&self) {
            *self.no_focus_errors.borrow_mut() += 1;
        }
        fn validate_note_target(&self, target_id: Option<&str>) -> bool {
            match target_id {
                None => true,
                Some(id) => id == "entry-1",
            }
        }
        fn on_toggle_requested(&self) {}
    }

    struct Harness {
        modes: PanelModes,
        host: MockHost,
    }

    impl Harness {
        fn set_snapshot(&self, target: FocusTarget) {
            *self.host.focus_snapshot.borrow_mut() = Some(target);
        }
    }

    fn make_machine() -> Harness {
        Harness { modes: PanelModes::new(), host: MockHost::new() }
    }

    fn nav_accels() -> Vec<&'static str> {
        NAV_SHORTCUTS.iter().map(|(a, _, _)| *a).collect()
    }

    fn events_with_action(h: &Harness, action: &str) -> usize {
        h.host
            .events
            .borrow()
            .iter()
            .filter(|(ch, a, _)| ch == "panel:key" && a == action)
            .count()
    }

    #[test]
    fn 启动后只注册呼出快捷键_show后注册全部导航键() {
        let mut h = make_machine();
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        assert_eq!(
            h.host.registered.borrow().keys().cloned().collect::<Vec<_>>(),
            vec!["Control+Shift+V".to_string()]
        );
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        assert!(h.host.registered.borrow().contains_key("Control+Shift+V"));
        for (accel, _, _) in NAV_SHORTCUTS {
            assert!(h.host.registered.borrow().contains_key(accel), "{accel}");
        }
        assert_eq!(
            h.host.events.borrow().iter().filter(|(ch, _, _)| ch == "panel:shown").count(),
            1
        );
    }

    #[test]
    fn 搜索模式部分键让位_IME组合中全部暂停() {
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        assert!(h.modes.begin_search(&mut h.host));
        let reg = h.host.registered.borrow();
        assert!(!reg.contains_key("Space"));
        assert!(!reg.contains_key("Z"));
        assert!(!reg.contains_key("Delete"));
        assert!(!reg.contains_key("B"));
        assert!(reg.contains_key("Up") && reg.contains_key("Down") && reg.contains_key("Enter") && reg.contains_key("Esc"));
        drop(reg);
        h.modes.set_composing(&mut h.host, true);
        assert!(!h.host.registered.borrow().contains_key("Up"), "IME 组合中导航键全部暂停");
        assert!(h.host.registered.borrow().contains_key("Control+Shift+V"));
        h.modes.set_composing(&mut h.host, false);
        assert!(h.host.registered.borrow().contains_key("Up"));
        // setComposing 同值幂等
        h.modes.set_composing(&mut h.host, false);
        assert!(h.host.registered.borrow().contains_key("Up"));
    }

    #[test]
    fn 搜索退出_恢复浏览态热键_归还焦点_发search_exit_快照保留() {
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        h.modes.begin_search(&mut h.host);
        let snapshots_before = *h.host.snapshot_requests.borrow();
        h.modes.end_search(&mut h.host, true);
        let mut reg: Vec<String> = h.host.registered.borrow().keys().cloned().collect();
        let mut expected: Vec<String> = vec!["Control+Shift+V".to_string()];
        expected.extend(nav_accels().into_iter().map(|s| s.to_string()));
        reg.sort();
        expected.sort();
        assert_eq!(reg, expected);
        assert_eq!(events_with_action(&h, "search-exit"), 1);
        assert_eq!(*h.host.restored.borrow(), vec![FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 }]);
        // 快照保留：再次进入搜索不再补拍
        h.modes.begin_search(&mut h.host);
        assert_eq!(*h.host.snapshot_requests.borrow(), snapshots_before);
    }

    #[test]
    fn 浏览态Esc转发渲染层_搜索态Esc退出搜索() {
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        let action = *h.host.registered.borrow().get("Esc").unwrap();
        if let HotkeyAction::Nav(a) = action {
            h.modes.on_nav_action(&mut h.host, a);
        }
        assert_eq!(events_with_action(&h, "escape"), 1);
        h.modes.begin_search(&mut h.host);
        let action = *h.host.registered.borrow().get("Esc").unwrap();
        if let HotkeyAction::Nav(a) = action {
            h.modes.on_nav_action(&mut h.host, a);
        }
        assert_eq!(events_with_action(&h, "search-exit"), 1);
    }

    #[test]
    fn 进入备注编辑先退出搜索_隐藏面板逐层退出并发对事件() {
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        h.modes.begin_search(&mut h.host);
        assert!(h.modes.begin_note_edit(&mut h.host, Some("entry-1")));
        assert_eq!(h.modes.state().mode, Mode::NoteEdit);
        assert!(!h.host.registered.borrow().contains_key("Enter"), "备注编辑中导航键全部让位");
        assert!(h.host.events.borrow().iter().any(|(ch, a, _)| ch == "panel:key" && a == "search-exit"));
        assert!(h.host.events.borrow().iter().any(|(ch, a, _)| ch == "panel:key" && a == "note-edit-enter"));

        h.modes.hide(&mut h.host, true);
        assert_eq!(h.modes.state().mode, Mode::Browse);
        let reg: Vec<String> = h.host.registered.borrow().keys().cloned().collect();
        assert_eq!(reg, vec!["Control+Shift+V".to_string()]);
        assert!(h.host.events.borrow().iter().any(|(ch, a, _)| ch == "panel:key" && a == "note-edit-exit"));
        // 搜索退出事件只在进入备注编辑的互斥退出时发过一次，hide 不再重复
        assert_eq!(events_with_action(&h, "search-exit"), 1);
    }

    #[test]
    fn hide消费焦点快照_restoreFocus_false只清不还() {
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        h.modes.hide(&mut h.host, true);
        assert_eq!(*h.host.restored.borrow(), vec![FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 }]);

        h.modes.ensure_focus_target(&mut h.host, true); // 快照已消费 → 重新补拍
        h.modes.show(&mut h.host);
        h.modes.hide(&mut h.host, false);
        assert_eq!(h.host.restored.borrow().len(), 1);
        assert!(h.modes.focus_target_snapshot().is_none());
    }

    #[test]
    fn 呼出时快照失败静默_进入输入态时快照失败上报并放弃() {
        let mut h = make_machine(); // focus_snapshot 为 None → captureFocus 返回 None
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, false);
        h.modes.show(&mut h.host);
        assert_eq!(*h.host.no_focus_errors.borrow(), 0);
        assert!(!h.modes.begin_search(&mut h.host));
        assert_eq!(*h.host.no_focus_errors.borrow(), 1);
        assert_eq!(h.modes.state().mode, Mode::Browse);
        assert!(!h.modes.begin_note_edit(&mut h.host, None));
        assert_eq!(*h.host.no_focus_errors.borrow(), 2);
    }

    #[test]
    fn 快捷键捕获_注销全部键_确认后换键退出捕获() {
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        assert!(h.modes.begin_shortcut_capture(&mut h.host));
        assert!(h.host.registered.borrow().is_empty(), "捕获中无任何全局键");
        assert!(h.modes.try_set_toggle_shortcut(&mut h.host, "Control+Alt+X"));
        assert!(h.host.registered.borrow().contains_key("Control+Alt+X"));
        for (accel, _, _) in NAV_SHORTCUTS {
            assert!(h.host.registered.borrow().contains_key(accel), "{accel}");
        }
        assert_eq!(h.modes.state().mode, Mode::Browse);
        // 确认路径不发 capture-end（覆盖层由渲染层自行收起）
        assert!(!h.host.events.borrow().iter().any(|(ch, _, _)| ch == "shortcut:capture-end"));
    }

    #[test]
    fn 快捷键捕获_新键注册失败保持捕获态_取消恢复原键并发capture_end() {
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        h.modes.begin_shortcut_capture(&mut h.host);
        // 模拟被占用：直接占用目标键
        h.host.registered.borrow_mut().insert("Control+Alt+X".to_string(), HotkeyAction::Toggle);
        assert!(!h.modes.try_set_toggle_shortcut(&mut h.host, "Control+Alt+X"));
        assert_eq!(h.modes.state().mode, Mode::ShortcutCapture);
        h.modes.cancel_shortcut_capture(&mut h.host, true);
        assert!(h.host.registered.borrow().contains_key("Control+Shift+V"));
        for (accel, _, _) in NAV_SHORTCUTS {
            assert!(h.host.registered.borrow().contains_key(accel), "{accel}");
        }
        assert!(h.host.events.borrow().iter().any(|(ch, _, _)| ch == "shortcut:capture-end"));
    }

    #[test]
    fn 捕获中呼出面板保持捕获态_导航键不误注册() {
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        assert!(h.modes.begin_shortcut_capture(&mut h.host));
        h.modes.show(&mut h.host); // startShortcutCapture 随后的 showPanel
        assert!(h.host.registered.borrow().is_empty(), "捕获中 show 不注册任何键");
        assert_eq!(h.modes.state().mode, Mode::ShortcutCapture);
        h.modes.cancel_shortcut_capture(&mut h.host, false);
        assert_eq!(h.modes.state().mode, Mode::Browse);
        assert!(h.host.registered.borrow().contains_key("Up")); // 面板仍显示 → 导航键恢复
    }

    #[test]
    fn 备注目标校验失败_不进入编辑() {
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        assert!(!h.modes.begin_note_edit(&mut h.host, Some("no-such-entry")));
        assert_eq!(h.modes.state().mode, Mode::Browse);
        for (accel, _, _) in NAV_SHORTCUTS {
            assert!(h.host.registered.borrow().contains_key(accel), "{accel}");
        }
    }
}
