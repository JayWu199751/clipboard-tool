// ClipboardTool 静默提权启动器
// 经计划任务 ClipboardToolElevated（RunLevel=Highest）拉起主程序：
// 计划任务以管理员令牌直接创建进程，不经过 UAC 同意对话框（同意发生在任务创建时）。
// 若任务缺失且当前进程已提权 → 先创建（无触发器、交互式令牌）再运行；
// 任务不存在或无法运行 → 直接启动主程序（此时会弹 UAC，作为兜底）。
// 全程无控制台窗口。
using System;
using System.IO;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Diagnostics;

static class TaskLauncher
{
    const string TASK_NAME = "ClipboardToolElevated";

    // ---------- Task Scheduler 2.0 晚绑定（避免外部 COM 引用） ----------

    static object Invoke(object obj, string name, params object[] args)
    {
        return obj.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, obj, args);
    }

    static object GetProp(object obj, string name)
    {
        return obj.GetType().InvokeMember(name, BindingFlags.GetProperty, null, obj, null);
    }

    static void SetProp(object obj, string name, object value)
    {
        obj.GetType().InvokeMember(name, BindingFlags.SetProperty, null, obj, new object[] { value });
    }

    static bool TaskExists(object folder)
    {
        try
        {
            Invoke(folder, "GetTask", TASK_NAME);
            return true;
        }
        catch
        {
            return false;
        }
    }

    static bool CreateTask(string exePath)
    {
        // 用 PowerShell Register-ScheduledTask 创建：
        // （COM RegisterTaskDefinition 在本机环境稳定报 (38,4) 错误；PowerShell CIM 通道验证可用）
        // 无触发器、最高权限、交互式令牌，仅作静默拉起通道。
        try
        {
            string script =
                "$a = New-ScheduledTaskAction -Execute '" + exePath.Replace("'", "''") + "'; " +
                "$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest; " +
                "Register-ScheduledTask -TaskName '" + TASK_NAME + "' -Action $a -Principal $p -Force | Out-Null";
            // -EncodedCommand 传参：免去外壳引号转义
            string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
                "-NoProfile -NonInteractive -EncodedCommand " + encoded);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process proc = Process.Start(psi))
            {
                if (proc == null) { Log("createTaskNoProc"); return false; }
                proc.WaitForExit(15000);
                Log("createTaskExit=" + proc.ExitCode);
                return proc.ExitCode == 0;
            }
        }
        catch (Exception ex)
        {
            Log("createTaskError=" + ex.Message);
            return false;
        }
    }

    static bool RunTask()
    {
        try
        {
            object service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
            Invoke(service, "Connect");
            object root = Invoke(service, "GetFolder", "\\");
            if (!TaskExists(root)) return false;
            Invoke(Invoke(root, "GetTask", TASK_NAME), "Run", (object)null);
            return true;
        }
        catch (Exception ex)
        {
            Log("runTaskError=" + ex.Message + " | " + (ex.InnerException != null ? ex.InnerException.Message : ""));
            return false;
        }
    }

    static bool IsElevated()
    {
        try
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
            }
        }
        catch
        {
            return false;
        }
    }

    static void Log(string msg)
    {
        try
        {
            System.IO.File.AppendAllText(
                System.IO.Path.Combine(System.IO.Path.GetTempPath(), "clipboard-launcher.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + Environment.NewLine);
        }
        catch { }
    }

    static string AppExePath()
    {
        // 布局：<安装目录>/ClipboardTool.exe 与 resources/resources/task-launcher.exe 同级目录结构
        string launcherDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string dir = launcherDir;
        for (int i = 0; i < 2 && dir != null; i++) dir = Path.GetDirectoryName(dir);
        if (dir != null)
        {
            string candidate = Path.Combine(dir, "ClipboardTool.exe");
            if (File.Exists(candidate)) return candidate;
        }
        // 仅打包后的安装布局使用本启动器；找不到主程序则返回空（Main 中记录并退出）
        return "";
    }

    static int Main(string[] args)
    {
        string exe = AppExePath();
        if (exe.Length == 0) { Log("appExeNotFound"); return 2; }

        bool elevated = IsElevated();
        bool taskOk = RunTask();
        if (!taskOk && elevated)
        {
            // 任务缺失（首次运行）→ 当前已提权，直接创建并再试
            Log("taskMissing, creating");
            if (CreateTask(exe) && RunTask()) return 0;
        }
        if (taskOk) return 0;

        // 兜底：直接启动主程序（其清单 requireAdministrator，会弹一次 UAC）
        Log("fallback direct start");
        try
        {
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
            return 0;
        }
        catch (Exception ex)
        {
            Log("directStartError=" + ex.Message);
            return 3;
        }
    }
}