// 全局热键记账的唯一真源：accel（协议字符串）↔ Shortcut（插件句柄）双向表，加动作与展示文案。
//
// 为什么需要这个 module：「现在哪些全局键生效」原来记在两处 ——
// PanelModes::registered（accel -> action）与 AppState::hotkeys（Shortcut -> accel）。
// 两份表可以各自漂移，于是反向查询（注销、分发）只能按值线性扫，
// 注册侧的「查重 → 调插件 → 记账」三步也不原子。现在收成一张表：
// 两个方向各一份索引，同生同灭，插件调用作为端口注入进来。
//
// 原子性靠所有权，不靠锁：这张表由 modes.rs 的执行线程独占（&mut Hotkeys），
// 所以「查重 → 调插件 → 记账」中间没有别人能看见半成品。这条约束不能改成
// Mutex 放进 AppState —— global_shortcut 的 register/unregister 内部会投递主线程
// 并阻塞等待（ADR-0006），持锁调用即死锁。
//
// 判定与效果的分界（ADR-0008）：本 module 是判定侧 —— 解析、查重、双向记账、
// 展示文案、失败原因的说法；插件调用由调用方以端口传入，日志由宿主打印。

use crate::panel_modes::HotkeyAction;
use crate::settings::DEFAULT_SHORTCUT;
use std::collections::HashMap;
use tauri_plugin_global_shortcut::Shortcut;

/// 插件调用端口：把解析好的 Shortcut 交给系统，返回插件是否接受。
/// 真实实现是 global_shortcut 的 register / unregister（内部投递主线程并阻塞等待），
/// 所以本表的调用方必须处在执行线程上，且不持有任何跨线程锁。
pub type PluginCall<'a> = &'a mut dyn FnMut(Shortcut) -> bool;

/// 一条生效绑定。accel 是协议字符串（唯一键），shortcut 是插件句柄（分发只认它）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Binding {
    shortcut: Shortcut,
    action: HotkeyAction,
}

/// 注册结果。三种失败原因分开，宿主据此决定打印哪条诊断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterOutcome {
    Registered,
    /// 已在表里（含「另一种写法解析到同一个组合键」）
    Duplicate,
    /// 字符串不是插件能解析的组合键
    Unparsable,
    /// 插件拒绝（通常是被其他程序占用）
    Rejected,
}

impl RegisterOutcome {
    pub fn is_ok(self) -> bool {
        matches!(self, RegisterOutcome::Registered)
    }

    /// 失败的用户可读文案，成功时为 None。措辞在此收口，宿主只管照打。
    pub fn diagnostic(self, accel: &str) -> Option<String> {
        match self {
            RegisterOutcome::Registered => None,
            RegisterOutcome::Duplicate => Some(format!("全局快捷键 {accel} 已在注册表中，跳过")),
            RegisterOutcome::Unparsable => Some(format!("注册全局快捷键 {accel} 失败：无法解析")),
            RegisterOutcome::Rejected => {
                Some(format!("注册全局快捷键 {accel} 失败（可能被其他程序占用）"))
            }
        }
    }
}

#[derive(Default)]
pub struct Hotkeys {
    by_accel: HashMap<String, Binding>,
    by_shortcut: HashMap<Shortcut, String>,
}

impl Hotkeys {
    pub fn new() -> Self {
        Self::default()
    }

    /// 三步原子：解析 → 双向查重 → 调插件 → 记账。插件拒绝则一分不记。
    pub fn register(
        &mut self,
        accel: &str,
        action: HotkeyAction,
        plugin: PluginCall,
    ) -> RegisterOutcome {
        let Ok(shortcut) = accel.parse::<Shortcut>() else {
            return RegisterOutcome::Unparsable;
        };
        // 两个方向都要查：只查 accel 的话，"Control+X" 与 "Ctrl+X" 会挤同一个 Shortcut，
        // 反向索引被后者覆盖，前者就成了查不回来的幽灵键（注销不掉，分发也认不出）。
        if self.by_accel.contains_key(accel) || self.by_shortcut.contains_key(&shortcut) {
            return RegisterOutcome::Duplicate;
        }
        if !plugin(shortcut) {
            return RegisterOutcome::Rejected;
        }
        self.by_accel.insert(accel.to_string(), Binding { shortcut, action });
        self.by_shortcut.insert(shortcut, accel.to_string());
        RegisterOutcome::Registered
    }

    /// 按 accel 注销（O(1)，不再按值线性扫反向索引）。
    /// 插件报错也照样从表里删：这张表记的是「我们以为生效的键」，系统侧残留随进程退出消失。
    pub fn unregister(&mut self, accel: &str, plugin: PluginCall) -> bool {
        let Some(binding) = self.by_accel.remove(accel) else {
            return false;
        };
        self.by_shortcut.remove(&binding.shortcut);
        let _ = plugin(binding.shortcut);
        true
    }

    /// 热键回调的分发入口：插件只把 Shortcut 交回来，动作由这张表判。
    pub fn action_of(&self, shortcut: Shortcut) -> Option<HotkeyAction> {
        let accel = self.by_shortcut.get(&shortcut)?;
        self.by_accel.get(accel).map(|b| b.action)
    }

    /// 反查协议字符串：日志与「该键是否可连发」的判定都要它。
    pub fn accel_of(&self, shortcut: Shortcut) -> Option<&str> {
        self.by_shortcut.get(&shortcut).map(String::as_str)
    }

    /// 当前生效集合（accel -> action）。状态机做差量同步时，这就是「已注册」那一侧。
    pub fn bindings(&self) -> HashMap<String, HotkeyAction> {
        self.by_accel
            .iter()
            .map(|(accel, binding)| (accel.clone(), binding.action))
            .collect()
    }

}

/// accel → 展示文案（Control+Shift+V → Ctrl + Shift + V）。
/// 托盘菜单、捕获覆盖层、更换快捷键的回报三处共用，所以住在这张表的 module 里。
pub fn format_shortcut(accel: &str) -> String {
    let accel = if accel.is_empty() { DEFAULT_SHORTCUT } else { accel };
    accel
        .split('+')
        .map(|part| match part {
            "Control" | "CommandOrControl" => "Ctrl",
            "Super" | "Meta" => "Win",
            "Alt" => "Alt",
            "Shift" => "Shift",
            other => other,
        })
        .collect::<Vec<_>>()
        .join(" + ")
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用
    use super::*;
    use crate::panel_modes::NavAction;

    fn parse(accel: &str) -> Shortcut {
        accel.parse::<Shortcut>().expect("测试里的组合键应当可解析")
    }

    #[test]
    fn 注册成功后两个方向都查得到() {
        let mut h = Hotkeys::new();
        let mut calls = Vec::new();
        let outcome =
            h.register("Control+Shift+V", HotkeyAction::Toggle, &mut |s| {
                calls.push(s);
                true
            });
        assert!(outcome.is_ok());
        assert_eq!(calls, vec![parse("Control+Shift+V")]);
        assert_eq!(h.bindings().len(), 1);
        assert_eq!(h.accel_of(parse("Control+Shift+V")), Some("Control+Shift+V"));
        assert_eq!(h.action_of(parse("Control+Shift+V")), Some(HotkeyAction::Toggle));
        assert_eq!(h.bindings().get("Control+Shift+V").copied(), Some(HotkeyAction::Toggle));
    }

    #[test]
    fn 插件拒绝时一分不记() {
        let mut h = Hotkeys::new();
        let mut calls = Vec::new();
        let outcome =
            h.register("Control+Alt+X", HotkeyAction::Toggle, &mut |s| {
                calls.push(s);
                false
            });
        assert_eq!(outcome, RegisterOutcome::Rejected);
        assert_eq!(calls.len(), 1, "拒绝是插件给的，说明确实调过");
        assert!(h.bindings().is_empty(), "插件没接受就不该记账");
        assert_eq!(h.action_of(parse("Control+Alt+X")), None);
        assert_eq!(h.bindings().len(), 0);
    }

    #[test]
    fn 无法解析的组合键不碰插件() {
        let mut h = Hotkeys::new();
        let mut calls = Vec::new();
        let outcome = h.register("Control+Shift", HotkeyAction::Toggle, &mut |s| {
            calls.push(s);
            true
        });
        assert_eq!(outcome, RegisterOutcome::Unparsable);
        assert!(calls.is_empty());
        assert!(h.bindings().is_empty());
        assert_eq!(
            outcome.diagnostic("Control+Shift"),
            Some("注册全局快捷键 Control+Shift 失败：无法解析".to_string())
        );
    }

    #[test]
    fn 同一组合键换种写法也算重复_不覆盖原动作也不碰插件() {
        // 插件解析对大小写与 CTRL/CONTROL 别名不敏感，两个写法在系统侧是同一个键。
        // 只按 accel 查重的话，第二个写法会把反向索引盖掉，第一个键从此注销不掉。
        assert_eq!(parse("Control+Shift+V"), parse("Ctrl+Shift+V"));
        let mut h = Hotkeys::new();
        let mut calls = Vec::new();
        assert!(h
            .register("Control+Shift+V", HotkeyAction::Toggle, &mut |s| {
                calls.push(s);
                true
            })
            .is_ok());
        let outcome = h.register("Ctrl+Shift+V", HotkeyAction::Nav(NavAction::Up), &mut |s| {
            calls.push(s);
            true
        });
        assert_eq!(outcome, RegisterOutcome::Duplicate);
        assert_eq!(calls.len(), 1, "查重在调插件之前");
        assert_eq!(h.bindings().len(), 1, "第二个写法没挤进表里");
        assert_eq!(h.action_of(parse("Ctrl+Shift+V")), Some(HotkeyAction::Toggle));
        assert_eq!(h.accel_of(parse("Control+Shift+V")), Some("Control+Shift+V"));
    }

    #[test]
    fn 注销按accel命中并清掉两个方向() {
        let mut h = Hotkeys::new();
        assert!(h
            .register("Up", HotkeyAction::Nav(NavAction::Up), &mut |_| true)
            .is_ok());
        let shortcut = parse("Up");
        assert!(h.unregister("Up", &mut |s| {
            assert_eq!(s, shortcut);
            true
        }));
        assert!(h.bindings().is_empty());
        assert_eq!(h.accel_of(shortcut), None);
        assert_eq!(h.action_of(shortcut), None);
        // 注销之后同一个 accel 可以再注册（差量同步靠这一点复用键位）
        assert!(h.register("Up", HotkeyAction::Nav(NavAction::Up), &mut |_| true).is_ok());
        assert_eq!(h.bindings().len(), 1);
    }

    #[test]
    fn 注销未注册的键返回false且不碰插件() {
        let mut h = Hotkeys::new();
        let mut calls = Vec::new();
        assert!(!h.unregister("Esc", &mut |s| {
            calls.push(s);
            true
        }));
        assert!(calls.is_empty());
    }

    #[test]
    fn 反复注册注销之后双向索引仍然一致() {
        let mut h = Hotkeys::new();
        let accels = ["Control+Shift+V", "Up", "Down", "Esc", "Space"];
        for (i, accel) in accels.iter().enumerate() {
            let action = if i == 0 {
                HotkeyAction::Toggle
            } else {
                HotkeyAction::Nav(NavAction::Down)
            };
            assert!(h.register(accel, action, &mut |_| true).is_ok(), "{accel}");
        }
        for accel in &accels[1..] {
            assert!(h.unregister(accel, &mut |_| true), "{accel}");
        }
        assert_eq!(h.bindings().len(), 1, "差量视图里只剩呼出键");
        assert_eq!(
            h.bindings().get("Control+Shift+V").copied(),
            Some(HotkeyAction::Toggle)
        );
        assert_eq!(h.accel_of(parse("Up")), None, "已注销的查不回来");
        assert_eq!(h.action_of(parse("Control+Shift+V")), Some(HotkeyAction::Toggle));
        assert_eq!(
            h.accel_of(parse("Control+Shift+V")),
            Some("Control+Shift+V"),
            "剩下的那条两个方向都指得通"
        );
        // 注销过的键要能再注册上：换键路径靠这一步（捕获期间注销旧键，确认后注册新键）
        assert!(h.register("Up", HotkeyAction::Nav(NavAction::Up), &mut |_| true).is_ok());
    }

    #[test]
    fn 展示文案把修饰键收成缩写_空串退回默认键() {
        assert_eq!(format_shortcut("Control+Shift+V"), "Ctrl + Shift + V");
        assert_eq!(format_shortcut("CommandOrControl+D"), "Ctrl + D");
        assert_eq!(format_shortcut("Super+Space"), "Win + Space");
        assert_eq!(format_shortcut("Meta+Enter"), "Win + Enter");
        assert_eq!(format_shortcut("Alt+Shift+Delete"), "Alt + Shift + Delete");
        // 设置里存空串时按默认键展示，不能显示成空白
        assert_eq!(format_shortcut(""), format_shortcut(DEFAULT_SHORTCUT));
    }

    #[test]
    fn 展示文案对单键与普通键原样保留() {
        // 面板导航键里有一批无修饰键：Esc / Up / Space 直接就是文案，不该被改坏
        assert_eq!(format_shortcut("Esc"), "Esc");
        assert_eq!(format_shortcut("Up"), "Up");
        assert_eq!(format_shortcut("Space"), "Space");
        assert_eq!(format_shortcut("F5"), "F5");
    }
}
