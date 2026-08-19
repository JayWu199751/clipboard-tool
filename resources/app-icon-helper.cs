// ClipboardTool App Icon Helper
// 获取当前前台窗口的进程路径与图标，输出JSON到stdout
// 用法：app-icon-helper.exe  (无参数，直接输出一行JSON)
// 输出示例：{"exePath":"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","appName":"chrome","windowTitle":"...","iconBase64":"iVBOR..."}
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class AppIconHelper
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr hProcess, int dwFlags, StringBuilder lpExeName, ref int lpdwSize);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr hObject);

    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    static string EscapeJson(string s) {
        if (s == null) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");
    }

    static string GetExePath(uint pid) {
        // 优先用 Process.MainModule（对普通进程最准）
        try {
            var proc = Process.GetProcessById((int)pid);
            try { if (!string.IsNullOrEmpty(proc.MainModule.FileName)) return proc.MainModule.FileName; } catch {}
            // 备用：OpenProcess + QueryFullProcessImageName（可处理部分受保护进程）
            IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h != IntPtr.Zero) {
                try {
                    var sb = new StringBuilder(1024);
                    int sz = sb.Capacity;
                    if (QueryFullProcessImageName(h, 0, sb, ref sz)) return sb.ToString();
                } finally { CloseHandle(h); }
            }
        } catch {}
        return "";
    }

    static int Main() {
        try { Console.OutputEncoding = Encoding.UTF8; } catch {}
        try { SetProcessDPIAware(); } catch {}
        try {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) {
                Console.WriteLine("{\"error\":\"no foreground window\"}");
                return 0;
            }
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0) {
                Console.WriteLine("{\"error\":\"no pid\"}");
                return 0;
            }
            string exePath = GetExePath(pid);
            // 窗口标题（辅助识别，如浏览器标签）
            var titleSb = new StringBuilder(512);
            try { GetWindowText(hwnd, titleSb, titleSb.Capacity); } catch {}
            string windowTitle = titleSb.ToString();
            string appName = "";
            try { if (!string.IsNullOrEmpty(exePath)) appName = Path.GetFileNameWithoutExtension(exePath); } catch {}
            if (string.IsNullOrEmpty(appName)) {
                try { appName = Process.GetProcessById((int)pid).ProcessName; } catch {}
            }

            string iconBase64 = "";
            if (!string.IsNullOrEmpty(exePath) && File.Exists(exePath)) {
                try {
                    // 尝试提取关联图标（对Win32 exe最稳，UWP会拿到壳图标但也可用作fallback）
                    using (Icon icon = Icon.ExtractAssociatedIcon(exePath)) {
                        if (icon != null) {
                            using (Bitmap bmp = icon.ToBitmap()) {
                                using (MemoryStream ms = new MemoryStream()) {
                                    bmp.Save(ms, ImageFormat.Png);
                                    iconBase64 = Convert.ToBase64String(ms.ToArray());
                                }
                            }
                        }
                    }
                } catch (Exception ex) {
                    // 图标提取失败不影响主流程，仅记录
                    Console.Error.WriteLine("icon extract failed: " + ex.Message);
                }
            }

            // 输出单行JSON（紧凑，避免换行干扰解析）
            string json = "{\"exePath\":\"" + EscapeJson(exePath) + "\",\"appName\":\"" + EscapeJson(appName) + "\",\"windowTitle\":\"" + EscapeJson(windowTitle) + "\",\"iconBase64\":\"" + iconBase64 + "\"}";
            Console.WriteLine(json);
            return 0;
        } catch (Exception ex) {
            try { Console.WriteLine("{\"error\":\"" + EscapeJson(ex.Message) + "\"}"); } catch {}
            return 1;
        }
    }
}
