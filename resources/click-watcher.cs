// ClipboardTool Click Watcher
// 全局低级鼠标钩子（WH_MOUSE_LL）：把鼠标按下事件坐标输出到 stdout，
// 由主进程判断是否点击在面板外并关闭面板。普通权限，无需 UAC。
using System;
using System.Runtime.InteropServices;
using System.Threading;

static class ClickWatcher
{
    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandle(string lpModuleName);

    const int WH_MOUSE_LL = 14;
    const int WM_LBUTTONDOWN = 0x201;
    const int WM_RBUTTONDOWN = 0x204;
    const int WM_MBUTTONDOWN = 0x207;
    const int WM_XBUTTONDOWN = 0x20B;
    const uint WM_QUIT = 0x0012;

    static LowLevelMouseProc hookProc;
    static uint mainThreadId;

    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = wParam.ToInt32();
            if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN || msg == WM_XBUTTONDOWN)
            {
                MSLLHOOKSTRUCT info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                try
                {
                    Console.WriteLine("click " + info.pt.x + " " + info.pt.y);
                    Console.Out.Flush();
                }
                catch { }
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    static void StdinReader()
    {
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (line.Trim() == "quit") break;
            }
        }
        catch { }
        PostThreadMessage(mainThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
    }

    static int Main()
    {
        SetProcessDPIAware();
        mainThreadId = GetCurrentThreadId();

        Thread reader = new Thread(StdinReader);
        reader.IsBackground = true;
        reader.Start();

        hookProc = HookCallback;
        IntPtr hook = SetWindowsHookEx(WH_MOUSE_LL, hookProc, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) return 1;

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0)) { }

        UnhookWindowsHookEx(hook);
        return 0;
    }
}
