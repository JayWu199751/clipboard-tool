// 静默提权启动通道：计划任务 ClipboardToolElevated 是唯一的提权入口。
//
// 领域契约（见 CONTEXT.md「开机启动意图」）：
//   意图 = settings.json 的 autoStart，用户设定，持久化；
//   事实 = 计划任务及其 onlogon 触发器是否存在，不持久化，每次启动按意图实测重建。
// 之所以要分开：未提权进程建不出 RunLevel=Highest 的任务，此时只能先落盘意图、
// 等下一次提权启动补建 —— 否则开关会「打开 → 重启 → 变回关闭」。
//
// dev / 未提权 / 已提权 三条分支的判定，以及「拉起 → 延时退出」的舞步，只在本 module 内各写一次。

use crate::tasks;

/// 当前进程的启动通道：决定「事实」能不能真的落地。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// debug 构建（清单 asInvoker）：不提权也不该提权，只记录意图
    Development,
    /// release 但非高完整性（清单被改写 / 强制 CLIPBOARD_TOOL_ELEVATED=0）：建不出 Highest 任务
    NotElevated,
    /// release 且已提权：意图与事实一致
    Elevated,
}

pub fn channel() -> Channel {
    if cfg!(debug_assertions) {
        Channel::Development
    } else if tasks::is_elevated() {
        Channel::Elevated
    } else {
        Channel::NotElevated
    }
}

impl Channel {
    pub fn status_line(self) -> String {
        match self {
            Channel::Development => "开发构建（asInvoker）：跳过计划任务通道".to_string(),
            Channel::Elevated => "已提权 — 管理员窗口热键与粘贴正常".to_string(),
            Channel::NotElevated => {
                "未提权 — 管理员窗口中的热键与粘贴可能被 UIPI 拦截".to_string()
            }
        }
    }
}

/// 供入口打印的诊断行：开发模式返回 None，避免污染 npm run dev 输出。
pub fn status_line() -> Option<String> {
    match channel() {
        Channel::Development => None,
        other => Some(other.status_line()),
    }
}

/// 一次通道操作的结论：effective 是应落盘的意图值，message 可直接展示或写日志。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub effective: bool,
    /// 意图已记下但事实没建成，等下次提权启动补建
    pub deferred: bool,
    pub message: String,
}

/// 决策表：给定通道、exe 路径与意图，得出「事实要不要建、意图是否推迟」。
/// register 是「重建计划任务」这个效果的注入点：生产传 tasks::ps_register_task，
/// 测试传假实现，于是三条通道的取舍都能脱离 PowerShell 与提权状态直测。
fn decide(
    channel: Channel,
    exe: &str,
    intent: bool,
    register: &dyn Fn(&str, bool) -> bool,
) -> Outcome {
    let label = if intent { "开" } else { "关" };
    match channel {
        Channel::Development => Outcome {
            effective: intent,
            deferred: false,
            message: format!("开发模式：仅记录开机启动意图（{label}），不注册计划任务"),
        },
        Channel::NotElevated => Outcome {
            effective: intent,
            deferred: true,
            message: format!("未提权：已保存开机启动意图（{label}），任务将在下次提权启动时补建"),
        },
        Channel::Elevated => {
            if exe.is_empty() {
                return Outcome {
                    effective: false,
                    deferred: false,
                    message: "取不到当前 exe 路径，计划任务未重建".to_string(),
                };
            }
            if register(exe, intent) {
                Outcome {
                    effective: intent,
                    deferred: false,
                    message: format!("计划任务已按意图（{label}）重建"),
                }
            } else {
                Outcome {
                    effective: false,
                    deferred: false,
                    message: "创建计划任务失败：开机启动开关回退".to_string(),
                }
            }
        }
    }
}

/// 按当前通道把意图同步成事实（任务带/不带 onlogon 触发器）。
fn sync_fact(intent: bool) -> Outcome {
    decide(
        channel(),
        &current_exe_path(),
        intent,
        &|exe, with_trigger| tasks::ps_register_task(exe, with_trigger),
    )
}

/// 启动时调用：用持久化意图重建运行时事实（dev / 未提权时按通道自动跳过或推迟）。
pub fn apply_intent(intent: bool) -> Outcome {
    sync_fact(intent)
}

/// 开机启动开关调用：want = 用户新意图。返回的 effective 即应落盘的新值。
pub fn set_auto_start(want: bool) -> Outcome {
    sync_fact(want)
}

/// 经已存在的计划任务静默拉起提权实例（不弹 UAC）。返回 true 表示新实例已在启动，
/// 调用方应尽快退出，让提权实例接管。
pub fn relaunch_via_task() -> bool {
    tasks::task_exists() && tasks::run_elevated_task()
}

pub fn relaunch_if_not_elevated() -> bool {
    if channel() != Channel::NotElevated {
        return false;
    }
    relaunch_via_task()
}

pub fn current_exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    // 假注册器：记录每次调用并返回固定结果。只有提权通道会走到这里，
    // 所以 dev / 未提权的断言里 calls 必须为空（一次都不该碰 PowerShell）。
    fn make_register(ok: bool, calls: Rc<RefCell<Vec<(String, bool)>>>) -> impl Fn(&str, bool) -> bool {
        move |exe, trigger| {
            calls.borrow_mut().push((exe.to_string(), trigger));
            ok
        }
    }

    #[test]
    fn 开发通道只记意图_绝不注册任务() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        for intent in [true, false] {
            let out = decide(Channel::Development, "C:\\x.exe", intent, &make_register(true, calls.clone()));
            assert_eq!((out.effective, out.deferred), (intent, false));
        }
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn 未提权通道保留意图并标记推迟_同样不注册任务() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let out = decide(Channel::NotElevated, "C:\\x.exe", true, &make_register(true, calls.clone()));
        assert_eq!((out.effective, out.deferred), (true, true));
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn 提权通道按意图注册_触发器位与意图一致() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let on = decide(Channel::Elevated, "C:\\x.exe", true, &make_register(true, calls.clone()));
        assert_eq!((on.effective, on.deferred), (true, false));
        let off = decide(Channel::Elevated, "C:\\x.exe", false, &make_register(true, calls.clone()));
        assert_eq!((off.effective, off.deferred), (false, false));
        assert_eq!(
            calls.borrow().clone(),
            vec![("C:\\x.exe".to_string(), true), ("C:\\x.exe".to_string(), false)]
        );
    }

    #[test]
    fn 提权通道注册失败时开关回退_取不到exe路径时不注册() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let failed = decide(Channel::Elevated, "C:\\x.exe", true, &make_register(false, calls.clone()));
        assert_eq!((failed.effective, failed.deferred), (false, false));
        assert_eq!(calls.borrow().len(), 1);

        let calls2 = Rc::new(RefCell::new(Vec::new()));
        let no_exe = decide(Channel::Elevated, "", true, &make_register(true, calls2.clone()));
        assert!(!no_exe.effective);
        assert!(!no_exe.deferred);
        assert!(calls2.borrow().is_empty());
    }

    #[test]
    fn 当前构建通道为开发() {
        assert_eq!(channel(), Channel::Development);
        // 决策表与真实通道一致：dev 下 apply_intent 不推迟
        let out = apply_intent(true);
        assert_eq!((out.effective, out.deferred), (true, false));
    }

    #[test]
    fn 通道文案各自唯一且非空() {
        let lines = [
            Channel::Development.status_line(),
            Channel::NotElevated.status_line(),
            Channel::Elevated.status_line(),
        ];
        assert!(lines.iter().all(|l| !l.is_empty()));
        assert_eq!(lines.iter().collect::<std::collections::HashSet<_>>().len(), 3);
    }
}
