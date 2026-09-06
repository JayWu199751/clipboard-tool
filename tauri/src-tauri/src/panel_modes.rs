// 面板模式状态机：浏览 / 搜索模式（含 IME 组合子态）/ 备注编辑 / 快捷键捕获。
// 纯逻辑 module：不依赖 tauri / Win32。模式状态、转换级联、全局热键集合的推导与差量应用
// 全部收在本 module 的 interface 之后；窗口焦点、渲染层通知、焦点快照等效果经 host 注入。
//
// 三个输入态共用一对 enter_input / exit_input：五步顺序（退他态 → 补快照 → 改 mode →
// 热键差量 → 聚焦或失焦 + 发事件）只写一遍，各态的差异全部提成 Mode 上的纯判定
// （enter_event / exit_event / needs_focus / requires_visible_panel）。hide 也复用同一份
// 判定，不再自己表述一遍「逐层退出、发对退出事件」。
//
// 焦点快照走进程内同步 Win32 调用（focus_paste::snapshot），状态机因此没有异步等待点，
// 四态转换与热键差量全部可以直接单测。
//
// 设计要点：
// - 全局快捷键（呼出键 + 面板导航键）由「当前模式」唯一推导：desired_keys() 给出目标集合，
//   apply_hotkeys() 与已注册集合做差量同步。模式转换不再各自手写 register/unregister。
// - 焦点快照（FocusTarget）的生命周期归本 module：呼出/进入输入态前确保有快照，
//   退出输入态归还焦点（快照保留，同一次呼出内复用），隐藏面板时消费快照并清空。
// - 渲染层经 panel:key / panel:shown / shortcut:capture-* 事件感知模式变化。

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
// accelerator 字符串是渲染层与主进程共用的协议格式（Control+Shift+V 等），宿主负责转成插件可注册的 Shortcut。
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

// Windows 全局热键关闭了系统自动重复，只有上下方向键需要由应用自行重复投递。
pub fn is_repeatable_navigation(accel: &str) -> bool {
    matches!(accel, "Up" | "Down")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Browse,
    Search,
    NoteEdit,
    ShortcutCapture,
}

/// 状态机要发给渲染层的事件。渲染层协议有两条通道：`panel:key`（带动作名与可选的
/// 备注条目 id）与 `shortcut:capture-end`。「哪个态进 / 出各发哪条」是 Mode 上的纯判定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RendererEvent {
    PanelKey { action: &'static str, note_entry_id: Option<String> },
    CaptureEnd,
}

impl Mode {
    /// 进入该输入态要发的事件。捕获态没有进入事件：覆盖层由 main.rs 在呼出面板之后编排。
    pub fn enter_event(self, note_entry_id: Option<&str>) -> Option<RendererEvent> {
        match self {
            Mode::Search => Some(RendererEvent::PanelKey { action: "search-enter", note_entry_id: None }),
            Mode::NoteEdit => Some(RendererEvent::PanelKey {
                action: "note-edit-enter",
                note_entry_id: note_entry_id.map(|s| s.to_string()),
            }),
            Mode::Browse | Mode::ShortcutCapture => None,
        }
    }

    /// 退出该输入态要发的事件。浏览态不是输入态，没有退出事件。
    pub fn exit_event(self) -> Option<RendererEvent> {
        match self {
            Mode::Search => Some(RendererEvent::PanelKey { action: "search-exit", note_entry_id: None }),
            Mode::NoteEdit => Some(RendererEvent::PanelKey { action: "note-edit-exit", note_entry_id: None }),
            Mode::ShortcutCapture => Some(RendererEvent::CaptureEnd),
            Mode::Browse => None,
        }
    }

    /// 进入该态是否要把面板聚焦起来（捕获态不要：它此刻只负责注销全局键，
    /// 面板还没呼出，聚焦由 main.rs 在 show 之后做）。
    pub fn needs_focus(self) -> bool {
        matches!(self, Mode::Search | Mode::NoteEdit)
    }

    /// 进入该态是否要求面板已经显示。捕获态不要求：托盘「更换快捷键」是在面板收起时
    /// 进入的，随后才呼出面板。
    pub fn requires_visible_panel(self) -> bool {
        self != Mode::ShortcutCapture
    }
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
}

#[derive(Debug, Clone)]
pub struct PanelModesState {
    pub visible: bool,
    pub mode: Mode,
}

impl PanelModesState {
    /// 输入态（搜索 / 备注 / 捕获）豁免「浏览态自动失焦」——主线程只读这条判定的原子快照。
    pub fn input_active(&self) -> bool {
        self.visible && self.mode != Mode::Browse
    }
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

    // 把 Mode 判出来的事件投递出去：两条渲染层通道在此收口
    fn announce(host: &mut dyn ModesHost, event: Option<RendererEvent>) {
        match event {
            Some(RendererEvent::PanelKey { action, note_entry_id }) => {
                host.send_panel_key(action, note_entry_id.as_deref());
            }
            Some(RendererEvent::CaptureEnd) => host.send_capture_end(),
            None => {}
        }
    }

    // 退出当前输入态回到浏览态：改 mode → 清子态 → 热键差量 → 交还面板焦点 → 发退出事件。
    // `announce_exit` = false 用于捕获确认（覆盖层由渲染层自行收起，不发 capture-end）。
    // 不归还原程序焦点——那是 exit_input 的 restore_focus 参数的事。
    // 已是浏览态则整段跳过并返回 false，让调用方知道热键与焦点还没同步过。
    fn exit_input_internal(&mut self, host: &mut dyn ModesHost, announce_exit: bool) -> bool {
        let prev = self.mode;
        if prev == Mode::Browse {
            return false;
        }
        self.mode = Mode::Browse;
        self.composing = false;
        self.note_entry_id = None;
        self.apply_hotkeys(host);
        host.blur_panel_if_focused();
        if announce_exit {
            Self::announce(host, prev.exit_event());
        }
        true
    }

    pub fn state(&self) -> PanelModesState {
        PanelModesState {
            visible: self.visible,
            mode: self.mode,
        }
    }

    pub fn is_panel_visible(&self) -> bool {
        self.visible
    }

    // 查询某个 accel 当前注册的动作（热键分发用：只读快照，不执行效果）
    pub fn registered_action_for(&self, accel: &str) -> Option<HotkeyAction> {
        self.registered.get(accel).copied()
    }

    // 启动/更换呼出快捷键
    pub fn set_toggle_shortcut(&mut self, accel: &str, host: &mut dyn ModesHost) {
        self.toggle_accel = Some(accel.to_string());
        self.apply_hotkeys(host);
    }

    // 当前焦点快照（只读，不消费）。粘贴链路用它恢复原输入框；隐藏面板时才被消费清空。
    pub fn focus_target_snapshot(&self) -> Option<FocusTarget> {
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

    // 隐藏面板：退出当前输入态（发对退出事件，判定与 exit_input 共用 Mode::exit_event）、
    // 注销导航键（呼出键保留）、消费焦点快照。
    // 返回被消费的焦点快照（restore_focus=true 时由调用方归还焦点）。
    pub fn hide(&mut self, host: &mut dyn ModesHost, restore_focus: bool) -> Option<FocusTarget> {
        let prev = self.mode;
        self.visible = false;
        self.mode = Mode::Browse;
        self.composing = false;
        self.note_entry_id = None;
        Self::announce(host, prev.exit_event());
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
                self.enter_input(host, Mode::Search, None);
            }
            NavAction::Escape if self.mode == Mode::Search => {
                self.exit_input(host, Mode::Search, true);
            }
            NavAction::Note => {
                self.enter_input(host, Mode::NoteEdit, None);
            }
            other => {
                host.send_panel_key(other.as_str(), None);
            }
        }
    }

    // 进入一个输入态。五步固定顺序，三个输入态共用：
    //   1) 退出当前输入态（同一时刻最多一个；互斥退出要发对退出事件，但不归还程序焦点——
    //      紧接着就要把面板聚焦起来）
    //   2) 确保焦点快照：缺失先补拍，拍不到就上报并放弃，面板留在浏览态
    //   3) 该态独有的准入：备注编辑要校验目标条目
    //   4) 改 mode 并清子态（composing 只属于搜索、note_entry_id 只属于备注编辑）
    //   5) 热键差量 → 需要焦点的态聚焦面板 → 发进入事件
    // 捕获态是这条序列的例外：不要求面板已显示、也不聚焦（面板由 main.rs 随后呼出）。
    pub fn enter_input(
        &mut self,
        host: &mut dyn ModesHost,
        target: Mode,
        note_target_id: Option<&str>,
    ) -> bool {
        if !host.can_interact() || self.mode == target {
            return false;
        }
        if target.requires_visible_panel() && !self.visible {
            return false;
        }
        self.exit_input_internal(host, true);
        if !self.ensure_focus_target(host, true) {
            return false;
        }
        if target == Mode::NoteEdit && !host.validate_note_target(note_target_id) {
            return false;
        }
        self.mode = target;
        self.composing = false;
        self.note_entry_id =
            if target == Mode::NoteEdit { note_target_id.map(|s| s.to_string()) } else { None };
        self.apply_hotkeys(host);
        if target.needs_focus() {
            host.focus_panel();
        }
        Self::announce(host, target.enter_event(self.note_entry_id.as_deref()));
        true
    }

    // 退出一个输入态（只有当前正处于该态才退）：五步同 exit_input_internal，外加按需把焦点
    // 还给原程序（快照保留，同一次呼出内还能再进搜索 / 备注）。
    pub fn exit_input(&mut self, host: &mut dyn ModesHost, from: Mode, restore_focus: bool) {
        if self.mode != from {
            return;
        }
        self.exit_input_internal(host, true);
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

    // 捕获确认：新呼出键注册成功才算成功；成功则退出捕获态，但不发 capture-end
    // （覆盖层由渲染层自行收起）。这是 exit_input 唯一的变体：只差那一条事件。
    pub fn try_set_toggle_shortcut(&mut self, host: &mut dyn ModesHost, accel: &str) -> bool {
        if self.mode != Mode::ShortcutCapture {
            return false;
        }
        if !host.register_key(accel, HotkeyAction::Toggle) {
            return false;
        }
        self.registered.insert(accel.to_string(), HotkeyAction::Toggle);
        self.toggle_accel = Some(accel.to_string());
        self.exit_input_internal(host, false);
        true
    }

    // 把焦点还回原程序（捕获确认路径使用；快照保留到 hidePanel 时消费）
    pub fn restore_original_focus(&self, host: &dyn ModesHost) {
        self.restore_focus_keeping_snapshot(host);
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用
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
        assert!(h.modes.enter_input(&mut h.host, Mode::Search, None));
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
        h.modes.enter_input(&mut h.host, Mode::Search, None);
        let snapshots_before = *h.host.snapshot_requests.borrow();
        h.modes.exit_input(&mut h.host, Mode::Search, true);
        let mut reg: Vec<String> = h.host.registered.borrow().keys().cloned().collect();
        let mut expected: Vec<String> = vec!["Control+Shift+V".to_string()];
        expected.extend(nav_accels().into_iter().map(|s| s.to_string()));
        reg.sort();
        expected.sort();
        assert_eq!(reg, expected);
        assert_eq!(events_with_action(&h, "search-exit"), 1);
        assert_eq!(*h.host.restored.borrow(), vec![FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 }]);
        // 快照保留：再次进入搜索不再补拍
        h.modes.enter_input(&mut h.host, Mode::Search, None);
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
        h.modes.enter_input(&mut h.host, Mode::Search, None);
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
        h.modes.enter_input(&mut h.host, Mode::Search, None);
        assert!(h.modes.enter_input(&mut h.host, Mode::NoteEdit, Some("entry-1")));
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
        assert!(!h.modes.enter_input(&mut h.host, Mode::Search, None));
        assert_eq!(*h.host.no_focus_errors.borrow(), 1);
        assert_eq!(h.modes.state().mode, Mode::Browse);
        assert!(!h.modes.enter_input(&mut h.host, Mode::NoteEdit, None));
        assert_eq!(*h.host.no_focus_errors.borrow(), 2);
    }

    #[test]
    fn 快捷键捕获_注销全部键_确认后换键退出捕获() {
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        assert!(h.modes.enter_input(&mut h.host, Mode::ShortcutCapture, None));
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
        h.modes.enter_input(&mut h.host, Mode::ShortcutCapture, None);
        // 模拟被占用：直接占用目标键
        h.host.registered.borrow_mut().insert("Control+Alt+X".to_string(), HotkeyAction::Toggle);
        assert!(!h.modes.try_set_toggle_shortcut(&mut h.host, "Control+Alt+X"));
        assert_eq!(h.modes.state().mode, Mode::ShortcutCapture);
        h.modes.exit_input(&mut h.host, Mode::ShortcutCapture, true);
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
        assert!(h.modes.enter_input(&mut h.host, Mode::ShortcutCapture, None));
        h.modes.show(&mut h.host); // startShortcutCapture 随后的 showPanel
        assert!(h.host.registered.borrow().is_empty(), "捕获中 show 不注册任何键");
        assert_eq!(h.modes.state().mode, Mode::ShortcutCapture);
        h.modes.exit_input(&mut h.host, Mode::ShortcutCapture, false);
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
        assert!(!h.modes.enter_input(&mut h.host, Mode::NoteEdit, Some("no-such-entry")));
        assert_eq!(h.modes.state().mode, Mode::Browse);
        for (accel, _, _) in NAV_SHORTCUTS {
            assert!(h.host.registered.borrow().contains_key(accel), "{accel}");
        }
    }

    #[test]
    fn 只有上下方向键进入按住重复_其他动作保持一次触发() {
        assert!(is_repeatable_navigation("Up"));
        assert!(is_repeatable_navigation("Down"));
        assert!(!is_repeatable_navigation("Enter"));
        assert!(!is_repeatable_navigation("Esc"));
        assert!(!is_repeatable_navigation("Control+Up"));
    }

    #[test]
    fn 输入态的四条判定_进入与退出事件_是否聚焦_是否要求面板已显示() {
        // 进入事件：搜索与备注各一条；捕获态没有（覆盖层由 main.rs 在呼出面板之后编排），
        // 浏览态不是输入态。备注那条要带上目标条目 id，渲染层据此决定草稿从哪来。
        assert_eq!(
            Mode::Search.enter_event(None),
            Some(RendererEvent::PanelKey { action: "search-enter", note_entry_id: None })
        );
        assert_eq!(
            Mode::NoteEdit.enter_event(Some("e1")),
            Some(RendererEvent::PanelKey {
                action: "note-edit-enter",
                note_entry_id: Some("e1".to_string()),
            })
        );
        assert_eq!(Mode::ShortcutCapture.enter_event(None), None);
        assert_eq!(Mode::Browse.enter_event(None), None);
        // 退出事件：三个输入态各一条，捕获态走 shortcut:capture-end 这条独立通道
        assert_eq!(
            Mode::Search.exit_event(),
            Some(RendererEvent::PanelKey { action: "search-exit", note_entry_id: None })
        );
        assert_eq!(
            Mode::NoteEdit.exit_event(),
            Some(RendererEvent::PanelKey { action: "note-edit-exit", note_entry_id: None })
        );
        assert_eq!(Mode::ShortcutCapture.exit_event(), Some(RendererEvent::CaptureEnd));
        assert_eq!(Mode::Browse.exit_event(), None);
        // 聚焦：搜索与备注要把面板聚焦起来，捕获态此刻还不要求（由 main.rs 呼出后再聚焦）
        assert!(Mode::Search.needs_focus() && Mode::NoteEdit.needs_focus());
        assert!(!Mode::ShortcutCapture.needs_focus() && !Mode::Browse.needs_focus());
        // 准入：托盘「更换快捷键」在面板收起时进入捕获，所以只有捕获态不要求面板已显示
        assert!(Mode::Search.requires_visible_panel() && Mode::NoteEdit.requires_visible_panel());
        assert!(!Mode::ShortcutCapture.requires_visible_panel());
    }

    #[test]
    fn 从捕获态进入搜索_先发capture_end再发进入事件() {
        // 三个输入态共用 enter_input 之后，「退掉他态」不再只针对某一个态：从捕获态直接
        // 进搜索也要发对 capture-end，否则渲染层的覆盖层会留在屏幕上（旧写法会静默盖过去）。
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        assert!(h.modes.enter_input(&mut h.host, Mode::ShortcutCapture, None));
        assert!(h.modes.enter_input(&mut h.host, Mode::Search, None));
        let seq: Vec<String> = h
            .host
            .events
            .borrow()
            .iter()
            .filter(|(ch, a, _)| ch == "shortcut:capture-end" || a == "search-enter")
            .map(|(ch, a, _)| if ch == "panel:key" { a.clone() } else { ch.clone() })
            .collect();
        assert_eq!(seq, vec!["shortcut:capture-end".to_string(), "search-enter".to_string()]);
        assert_eq!(h.modes.state().mode, Mode::Search);
    }

    #[test]
    fn exit_input只退指定那个态_同态重复进入幂等拒绝() {
        let mut h = make_machine();
        h.set_snapshot(FocusTarget { hwnd: 1, focus_hwnd: 1, pid: 1, tid: 1 });
        h.modes.set_toggle_shortcut("Control+Shift+V", &mut h.host);
        h.modes.ensure_focus_target(&mut h.host, true);
        h.modes.show(&mut h.host);
        assert!(h.modes.enter_input(&mut h.host, Mode::Search, None));
        let events_before = h.host.events.borrow().len();
        let blurred_before = *h.host.blurred.borrow();
        // 已在搜索态：再进一次幂等拒绝，不重复发进入事件
        assert!(!h.modes.enter_input(&mut h.host, Mode::Search, None));
        assert_eq!(h.host.events.borrow().len(), events_before);
        // 备注态没开：exit_input(NoteEdit) 整段跳过，搜索态、事件、焦点都不该动
        h.modes.exit_input(&mut h.host, Mode::NoteEdit, true);
        assert_eq!(h.modes.state().mode, Mode::Search);
        assert_eq!(h.host.events.borrow().len(), events_before);
        assert_eq!(*h.host.blurred.borrow(), blurred_before);
        assert!(h.host.restored.borrow().is_empty());
    }
}
