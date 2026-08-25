// ClipboardTool Focus Paste Helper
// Long-running native helper for focus snapshots, focus restoration and Ctrl+V injection.
// It inherits the parent process token, so no separate elevation or UAC prompt is used.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class FocusPasteHelper
{
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool AllowSetForegroundWindow(uint dwProcessId);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();

    const uint GA_ROOT = 2;
    const int SW_RESTORE = 9;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint ASFW_ANY = 0xFFFF;
    const uint INPUT_KEYBOARD = 1;
    const ushort VK_MENU = 0x12;
    const ushort VK_CONTROL = 0x11;
    const ushort VK_V = 0x56;
    const uint KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct GUITHREADINFO
    {
        public uint cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    static IntPtr ToHandle(object value)
    {
        try { return new IntPtr(Convert.ToInt64(value)); }
        catch { return IntPtr.Zero; }
    }

    static string GetString(Dictionary<string, object> obj, string key)
    {
        object value;
        if (obj.TryGetValue(key, out value) && value != null)
            return Convert.ToString(value);
        return "";
    }

    static long GetLong(Dictionary<string, object> obj, string key)
    {
        object value;
        if (obj.TryGetValue(key, out value) && value != null)
            return Convert.ToInt64(value);
        return 0;
    }

    static Dictionary<string, object> GetObject(Dictionary<string, object> obj, string key)
    {
        object value;
        if (obj.TryGetValue(key, out value) && value is Dictionary<string, object>)
            return (Dictionary<string, object>)value;
        return new Dictionary<string, object>();
    }

    static bool IsRootWindow(IntPtr hWnd, IntPtr root)
    {
        if (hWnd == IntPtr.Zero || root == IntPtr.Zero) return false;
        return hWnd == root || GetAncestor(hWnd, GA_ROOT) == root;
    }

    static bool GetFocusSnapshot(out IntPtr topWindow, out IntPtr focusWindow, out uint processId, out uint threadId, out string reason)
    {
        topWindow = IntPtr.Zero;
        focusWindow = IntPtr.Zero;
        processId = 0;
        threadId = 0;
        reason = "";

        topWindow = GetForegroundWindow();
        if (topWindow == IntPtr.Zero)
        {
            reason = "no_foreground_window";
            return false;
        }

        threadId = GetWindowThreadProcessId(topWindow, out processId);
        if (threadId == 0 || processId == 0)
        {
            reason = "no_window_process";
            return false;
        }

        GUITHREADINFO info = new GUITHREADINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(threadId, ref info))
            focusWindow = info.hwndFocus;

        if (focusWindow == IntPtr.Zero)
            focusWindow = topWindow;
        return true;
    }

    static Dictionary<string, object> Snapshot(string id)
    {
        IntPtr topWindow;
        IntPtr focusWindow;
        uint processId;
        uint threadId;
        string reason;
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["id"] = id;
        result["cmd"] = "snapshot";

        if (!GetFocusSnapshot(out topWindow, out focusWindow, out processId, out threadId, out reason))
        {
            result["ok"] = false;
            result["reason"] = reason;
            return result;
        }

        Dictionary<string, object> target = new Dictionary<string, object>();
        target["hwnd"] = topWindow.ToInt64();
        target["focusHwnd"] = focusWindow.ToInt64();
        target["pid"] = processId;
        target["tid"] = threadId;
        result["ok"] = true;
        result["target"] = target;
        return result;
    }

    static bool ValidateTarget(Dictionary<string, object> target)
    {
        IntPtr hwnd = ToHandle(GetLong(target, "hwnd"));
        long pid = GetLong(target, "pid");
        long tid = GetLong(target, "tid");
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;

        uint actualPid;
        uint actualTid = GetWindowThreadProcessId(hwnd, out actualPid);
        return actualPid == pid && actualTid == tid;
    }

    static bool IsForegroundTarget(IntPtr hwnd)
    {
        IntPtr foreground = GetForegroundWindow();
        return foreground == hwnd || IsRootWindow(foreground, hwnd);
    }

    static void SendAlt()
    {
        INPUT[] inputs = new INPUT[]
        {
            KeyInput(VK_MENU, 0),
            KeyInput(VK_MENU, KEYEVENTF_KEYUP)
        };
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static bool TryActivate(IntPtr hwnd)
    {
        SetForegroundWindow(hwnd);
        Thread.Sleep(30);
        return IsForegroundTarget(hwnd);
    }

    static bool RestoreTarget(Dictionary<string, object> target)
    {
        IntPtr hwnd = ToHandle(GetLong(target, "hwnd"));
        IntPtr focusHwnd = ToHandle(GetLong(target, "focusHwnd"));
        if (hwnd == IntPtr.Zero || !ValidateTarget(target)) return false;

        if (IsIconic(hwnd)) ShowWindowAsync(hwnd, SW_RESTORE);

        uint ignoredProcessId;
        uint targetThread = GetWindowThreadProcessId(hwnd, out ignoredProcessId);
        uint currentThread = GetCurrentThreadId();
        bool attached = targetThread != 0 && AttachThreadInput(currentThread, targetThread, true);

        // 搜索面板持有前台激活权时，Windows 会拒绝辅助进程直接调用
        // SetForegroundWindow。先尝试授权，再发送一次无害的 Alt 键事件，
        // 让辅助进程取得输入权，然后重试恢复原窗口。
        AllowSetForegroundWindow(ASFW_ANY);
        bool foregroundSet = TryActivate(hwnd);
        if (!foregroundSet)
        {
            SendAlt();
            Thread.Sleep(40);
            foregroundSet = TryActivate(hwnd);
        }
        if (!foregroundSet)
        {
            SwitchToThisWindow(hwnd, true);
            Thread.Sleep(40);
            foregroundSet = TryActivate(hwnd);
        }
        if (!foregroundSet)
        {
            ShowWindowAsync(hwnd, SW_RESTORE);
            SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            Thread.Sleep(40);
            foregroundSet = TryActivate(hwnd);
        }
        if (focusHwnd != IntPtr.Zero && IsWindow(focusHwnd))
            SetFocus(focusHwnd);
        else
            SetFocus(hwnd);

        if (attached)
            AttachThreadInput(currentThread, targetThread, false);

        return foregroundSet;
    }

    static INPUT KeyInput(ushort key, uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = key;
        input.U.ki.wScan = 0;
        input.U.ki.dwFlags = flags;
        input.U.ki.time = 0;
        input.U.ki.dwExtraInfo = IntPtr.Zero;
        return input;
    }

    static bool PasteClipboard()
    {
        INPUT[] inputs = new INPUT[]
        {
            KeyInput(VK_CONTROL, 0),
            KeyInput(VK_V, 0),
            KeyInput(VK_V, KEYEVENTF_KEYUP),
            KeyInput(VK_CONTROL, KEYEVENTF_KEYUP)
        };
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        return sent == (uint)inputs.Length;
    }

    static Dictionary<string, object> Restore(string id, Dictionary<string, object> target, bool paste)
    {
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["id"] = id;
        result["cmd"] = paste ? "paste" : "restore";

        bool restored = false;
        string reason = "";
        for (int attempt = 0; attempt < 2; attempt++)
        {
            if (RestoreTarget(target))
            {
                restored = true;
                break;
            }
            reason = "restore_failed";
            Thread.Sleep(60);
        }

        if (!restored)
        {
            result["ok"] = false;
            result["stage"] = "restore";
            result["reason"] = reason;
            return result;
        }

        if (paste && !PasteClipboard())
        {
            result["ok"] = false;
            result["stage"] = "paste";
            result["reason"] = "paste_send_failed";
            return result;
        }

        result["ok"] = true;
        return result;
    }

    static void WriteJson(Dictionary<string, object> value)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        Console.Out.WriteLine(serializer.Serialize(value));
        Console.Out.Flush();
    }

    static void HandleCommand(string line)
    {
        Dictionary<string, object> result;
        try
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            Dictionary<string, object> command = (Dictionary<string, object>)serializer.DeserializeObject(line);
            string id = GetString(command, "id");
            string cmd = GetString(command, "cmd");

            if (cmd == "snapshot")
                result = Snapshot(id);
            else if (cmd == "restore")
                result = Restore(id, GetObject(command, "target"), false);
            else if (cmd == "paste")
                result = Restore(id, GetObject(command, "target"), true);
            else
            {
                result = new Dictionary<string, object>();
                result["id"] = id;
                result["cmd"] = cmd;
                result["ok"] = false;
                result["reason"] = "unknown_command";
            }
        }
        catch (Exception ex)
        {
            result = new Dictionary<string, object>();
            result["ok"] = false;
            result["reason"] = "invalid_command";
            result["error"] = ex.Message;
        }
        WriteJson(result);
    }

    static int Main()
    {
        try { SetProcessDPIAware(); } catch { }
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            HandleCommand(line);
        }
        return 0;
    }
}
