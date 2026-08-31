// 焦点快照 / 焦点恢复 / Ctrl+V 注入：resources/focus-paste-helper.cs 的进程内移植。
// 原实现是常驻 C# 助手进程（stdin/stdout JSON 协议）；Rust 版直接在主进程调用 Win32，
// 助手进程、JSON-RPC seam（electron/native-helper.js）与其超时/生命周期管理整体退役。
// 行为语义与 C# 版逐段对齐（含 4ms 步进轮询、两级激活级联、AttachThreadInput）。

use crate::panel_modes::FocusTarget;
use std::thread;
use std::time::Duration;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, SetFocus, INPUT, INPUT_0, KEYBDINPUT, INPUT_KEYBOARD,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, GetAncestor, GetForegroundWindow, GetGUIThreadInfo,
    GetWindowThreadProcessId, GUITHREADINFO, IsIconic, IsWindow, SetForegroundWindow,
    SetWindowPos, ShowWindowAsync, SwitchToThisWindow, GA_ROOT, SW_RESTORE, SWP_NOMOVE,
    SWP_NOSIZE, SWP_SHOWWINDOW,
};

// VK_V 不在 windows 常量表里（0x30-0x5A 与 ASCII 同值）
const VK_V: u16 = 0x56;
const ASFW_ANY: u32 = 0xFFFF_FFFF;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;
const KEYEVENTF_KEYUP: u32 = 0x0002;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestoreFailure {
    pub stage: &'static str,
    pub reason: &'static str,
}

pub fn snapshot() -> Result<FocusTarget, &'static str> {
    unsafe {
        let top = GetForegroundWindow();
        if top.is_invalid() {
            return Err("no_foreground_window");
        }
        let mut pid = 0u32;
        let tid = GetWindowThreadProcessId(top, Some(&mut pid));
        if tid == 0 || pid == 0 {
            return Err("no_window_process");
        }
        let mut info = GUITHREADINFO::default();
        info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        let mut focus = top;
        if GetGUIThreadInfo(tid, &mut info).is_ok() && !info.hwndFocus.is_invalid() {
            focus = info.hwndFocus;
        }
        Ok(FocusTarget {
            hwnd: top.0 as i64,
            focus_hwnd: focus.0 as i64,
            pid: pid as u64,
            tid: tid as u64,
        })
    }
}

fn hwnd_from_i64(v: i64) -> HWND {
    HWND(v as *mut _)
}

fn is_root_window(hwnd: HWND, root: HWND) -> bool {
    if hwnd.is_invalid() || root.is_invalid() {
        return false;
    }
    unsafe { hwnd == root || GetAncestor(hwnd, GA_ROOT) == root }
}

fn validate_target(target: &FocusTarget) -> bool {
    let hwnd = hwnd_from_i64(target.hwnd);
    unsafe {
        if hwnd.is_invalid() || !IsWindow(Some(hwnd)).as_bool() {
            return false;
        }
        let mut actual_pid = 0u32;
        let actual_tid = GetWindowThreadProcessId(hwnd, Some(&mut actual_pid));
        actual_pid as u64 == target.pid && actual_tid as u64 == target.tid
    }
}

fn is_foreground_target(hwnd: HWND) -> bool {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_invalid() {
        return false;
    }
    foreground == hwnd || is_root_window(foreground, hwnd)
}

// 以 4ms 步进轮询前台状态，窗口一切过去立即返回（替代写死 Sleep：成功路径不等满额延迟）
fn wait_for_foreground(hwnd: HWND, budget_ms: u32) -> bool {
    let mut waited = 0u32;
    while waited < budget_ms {
        if is_foreground_target(hwnd) {
            return true;
        }
        thread::sleep(Duration::from_millis(4));
        waited += 4;
    }
    is_foreground_target(hwnd)
}

fn send_alt() {
    send_key_inputs(&[(VK_MENU, 0), (VK_MENU, KEYEVENTF_KEYUP)]);
}

fn try_activate(hwnd: HWND) -> bool {
    unsafe {
        let _ = SetForegroundWindow(hwnd);
    }
    wait_for_foreground(hwnd, 48)
}

fn restore_target(target: &FocusTarget) -> bool {
    unsafe {
        let hwnd = hwnd_from_i64(target.hwnd);
        let focus_hwnd = hwnd_from_i64(target.focus_hwnd);
        if hwnd.is_invalid() || !validate_target(target) {
            return false;
        }

        // 浏览模式常态：面板从未拿走焦点，原窗口仍是前台、原控件仍持有焦点 → 零操作直接返回。
        // 这是「回车→粘贴」的主路径（原版在此省掉 TryActivate 的激活级联）。
        if is_foreground_target(hwnd) {
            let mut current = GUITHREADINFO::default();
            current.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
            let mut probe_pid = 0u32;
            let probe_thread = GetWindowThreadProcessId(hwnd, Some(&mut probe_pid));
            let current_focus = if probe_thread != 0 && GetGUIThreadInfo(probe_thread, &mut current).is_ok() {
                current.hwndFocus
            } else {
                HWND::default()
            };
            if focus_hwnd.is_invalid() || !IsWindow(Some(focus_hwnd)).as_bool() || current_focus == focus_hwnd {
                return true;
            }
        }

        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindowAsync(hwnd, SW_RESTORE);
        }

        let mut ignored_pid = 0u32;
        let target_thread = GetWindowThreadProcessId(hwnd, Some(&mut ignored_pid));
        let current_thread = GetCurrentThreadId();
        let attached = target_thread != 0 && AttachThreadInput(current_thread, target_thread, true).as_bool();

        // 面板持有前台激活权时，Windows 会拒绝直接调用 SetForegroundWindow。
        // 先尝试授权，再发送一次无害的 Alt 键事件取得输入权，然后重试恢复原窗口。
        // 每步激活都走轮询（成功即刻返回），失败级联不再需要段间固定 Sleep。
        let _ = AllowSetForegroundWindow(ASFW_ANY);
        let mut foreground_set = try_activate(hwnd);
        if !foreground_set {
            send_alt();
            foreground_set = try_activate(hwnd);
        }
        if !foreground_set {
            SwitchToThisWindow(hwnd, true);
            foreground_set = try_activate(hwnd);
        }
        if !foreground_set {
            let _ = ShowWindowAsync(hwnd, SW_RESTORE);
            let _ = SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            foreground_set = try_activate(hwnd);
        }
        if !focus_hwnd.is_invalid() && IsWindow(Some(focus_hwnd)).as_bool() {
            let _ = SetFocus(Some(focus_hwnd));
        } else {
            let _ = SetFocus(Some(hwnd));
        }

        if attached {
            let _ = AttachThreadInput(current_thread, target_thread, false);
        }

        foreground_set
    }
}

fn key_input(vk: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(flags),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send_key_inputs(inputs: &[(u16, u32)]) {
    let arr: Vec<INPUT> = inputs.iter().map(|(vk, f)| key_input(*vk, *f)).collect();
    unsafe {
        let _ = SendInput(&arr, std::mem::size_of::<INPUT>() as i32);
    }
}

// 注入 Ctrl+V
fn paste_clipboard() -> bool {
    let inputs = [
        key_input(VK_CONTROL, 0),
        key_input(VK_V, 0),
        key_input(VK_V, KEYEVENTF_KEYUP),
        key_input(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) == inputs.len() as u32
    }
}

// 恢复原窗口焦点并注入 Ctrl+V（paste=false 时仅恢复）。
// 失败重试一次（原版 Restore 两轮尝试 + 60ms 间隔）。
pub fn restore_and_paste(target: &FocusTarget, paste: bool) -> Result<(), RestoreFailure> {
    let mut restored = false;
    let mut reason = "";
    for _attempt in 0..2 {
        if restore_target(target) {
            restored = true;
            break;
        }
        reason = "restore_failed";
        thread::sleep(Duration::from_millis(60));
    }
    if !restored {
        return Err(RestoreFailure { stage: "restore", reason });
    }
    if paste && !paste_clipboard() {
        return Err(RestoreFailure { stage: "paste", reason: "paste_send_failed" });
    }
    Ok(())
}
