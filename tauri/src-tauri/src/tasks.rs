// 静默提权启动（计划任务）：main.js 的 psRegisterTask / ensureElevatedTask / setAutoStart 移植。
// 应用清单 requireAdministrator（build.rs 的 CLIPBOARD_TOOL_ELEVATED）时每次启动都是
// 高完整性进程；正常入口经计划任务 ClipboardToolElevated（/rl highest）静默拉起不弹 UAC。
// 开机启动 = 该任务的 onlogon 触发器；开关重建任务（带/不带触发器，任务本体保留）。
//
// 用 PowerShell Register-ScheduledTask 注册/重建任务：
// schtasks /create 强制要求 /sc 触发器，无法表达"仅作静默拉起通道（无触发器）"，
// Register-ScheduledTask 支持无触发器注册；-Force 覆盖重建。
// 注意：这段注册脚本与 Electron 版 main.js 的 psRegisterTask 是同一件事的两种语言实现，
// 任务名 / Principal 变更需两处同步。

use base64::Engine as _;
use std::os::windows::process::CommandExt;

pub const ELEVATED_TASK_NAME: &str = "ClipboardToolElevated";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// -EncodedCommand 传参：UTF-16LE 字节的 base64，免去外壳引号转义
fn encode_ps_command(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

fn run_powershell(script: &str) -> bool {
    let encoded = encode_ps_command(script);
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn run_powershell_with_output(script: &str) -> Option<String> {
    let encoded = encode_ps_command(script);
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                Some(String::from_utf8_lossy(&out.stdout).to_string())
            } else {
                None
            }
        })
}

// ---------- 提权检测 ----------

pub fn is_elevated() -> bool {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut ret_len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut std::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        );
        let _ = windows::Win32::Foundation::CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    }
}

// 注册/重建计划任务：with_logon_trigger = 开机启动（AtLogOn 触发器）
pub fn ps_register_task(exe_path: &str, with_logon_trigger: bool) -> bool {
    let task_name = ELEVATED_TASK_NAME;
    let exe = exe_path.replace('\'', "''");
    let script = format!(
        "$action = New-ScheduledTaskAction -Execute '{exe}'; \
         $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest; \
         Register-ScheduledTask -TaskName '{task_name}' -Action $action -Principal $principal{} -Force | Out-Null",
        if with_logon_trigger { " -Trigger (New-ScheduledTaskTrigger -AtLogOn)" } else { "" }
    );
    run_powershell(&script)
}

// 静默拉起：任务存在则经 Schedule.Service COM 运行（PowerShell 一行式，免 COM 绑定）；
// 任务缺失返回 false，由调用方兜底（提权 shell 下直接创建；否则弹 UAC 直启）。
// 对应 Electron 版 task-launcher.exe 的运行通道；当前入口由安装器/快捷方式承担，保留备用。
pub fn run_elevated_task() -> bool {
    let task_name = ELEVATED_TASK_NAME;
    let script = format!(
        "$s = New-Object -ComObject Schedule.Service; \
         $s.Connect(); \
         $t = $s.GetFolder('\\').GetTask('{task_name}'); \
         $t.Run($null)"
    );
    run_powershell(&script)
}

// 任务是否存在（PowerShell 探测，供启动兜底判断）
pub fn task_exists() -> bool {
    let task_name = ELEVATED_TASK_NAME;
    run_powershell(&format!(
        "if (Get-ScheduledTask -TaskName '{task_name}' -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
    ))
}

// 尝试通过已注册的计划任务静默拉起提权实例，成功返回 true（调用方应退出当前非提权进程）
// 若任务不存在且当前已提权，则先创建任务再运行，实现首次静默通道自举
pub fn try_run_elevated_via_task(exe_path: &str) -> bool {
    if task_exists() {
        return run_elevated_task();
    }
    // 任务不存在：仅当当前已提权时可创建（需要管理员权限创建 Highest 任务）
    if is_elevated() {
        if ps_register_task(exe_path, false) {
            // 任务刚创建，稍作等待后运行
            std::thread::sleep(std::time::Duration::from_millis(300));
            return run_elevated_task();
        }
    }
    false
}

// UAC 直启兜底：以管理员身份重新拉起自身（会弹 UAC 同意对话框）
// 使用 PowerShell Start-Process -Verb RunAs，避免 ShellExecute 的 parent 窗口句柄限制
pub fn run_elevated_via_uac(exe_path: &str) -> bool {
    let exe = exe_path.replace('\'', "''");
    let script = format!("Start-Process -FilePath '{exe}' -Verb RunAs");
    run_powershell(&script)
}

// 获取任务当前是否带 AtLogOn 触发器（用于 UI 同步）
#[allow(dead_code)]
pub fn task_has_logon_trigger() -> Option<bool> {
    let task_name = ELEVATED_TASK_NAME;
    let script = format!(
        "$t = Get-ScheduledTask -TaskName '{task_name}' -ErrorAction SilentlyContinue; \
         if ($null -eq $t) {{ exit 2 }}; \
         $has = ($t.Triggers | Where-Object {{ $_.CimClass.CimClassName -like '*LogonTrigger*' }} | Measure-Object).Count -gt 0; \
         if ($has) {{ Write-Output '1' }} else {{ Write-Output '0' }}"
    );
    run_powershell_with_output(&script).map(|s| s.trim() == "1")
}