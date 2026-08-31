// 静默启动通道的「事实层」：只管计划任务 ClipboardToolElevated 的注册/探测/拉起。
// 意图（settings.autoStart）与通道判定（dev / 未提权 / 已提权）都在 startup module，不在这里。
// 应用清单 requireAdministrator（build.rs 的 CLIPBOARD_TOOL_ELEVATED）时每次启动都是高完整性
// 进程；正常入口经该任务（/rl highest）静默拉起不弹 UAC。开机启动 = 任务的 onlogon 触发器。
//
// 用 PowerShell Register-ScheduledTask 注册/重建任务：
// schtasks /create 强制要求 /sc 触发器，无法表达"仅作静默拉起通道（无触发器）"，
// Register-ScheduledTask 支持无触发器注册；-Force 覆盖重建。
// 注意：这段注册脚本与已删除的 Electron 版 main.js psRegisterTask 同源，任务名 / Principal
// 变更需与安装器（快捷方式指向）一起核对。

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
// 使用 -ErrorAction Stop + try/catch 确保失败时进程以非 0 退出，run_powershell 才能正确判 false
pub fn ps_register_task(exe_path: &str, with_logon_trigger: bool) -> bool {
    let task_name = ELEVATED_TASK_NAME;
    let exe = exe_path.replace('\'', "''");
    let trigger = if with_logon_trigger { " -Trigger (New-ScheduledTaskTrigger -AtLogOn)" } else { "" };
    let script = format!(
        "try {{ $action = New-ScheduledTaskAction -Execute '{exe}'; $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest; Register-ScheduledTask -TaskName '{task_name}' -Action $action -Principal $principal{trigger} -Force -ErrorAction Stop | Out-Null; exit 0 }} catch {{ Write-Error $_.Exception.Message; exit 1 }}"
    );
    run_powershell(&script)
}

// 静默拉起：任务存在则经 Schedule.Service COM 运行（PowerShell 一行式，免 COM 绑定）；
// 任务缺失返回 false，由调用方兜底（提权 shell 下直接创建；否则弹 UAC 直启）。
// 对应 Electron 版 task-launcher.exe 的运行通道；当前入口由安装器/快捷方式承担，保留备用。
pub fn run_elevated_task() -> bool {
    let task_name = ELEVATED_TASK_NAME;
    let script = format!(
        "try {{ $s = New-Object -ComObject Schedule.Service; $s.Connect(); $t = $s.GetFolder('\\').GetTask('{task_name}'); $t.Run($null); exit 0 }} catch {{ Write-Error $_.Exception.Message; exit 1 }}"
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
