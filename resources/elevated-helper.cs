// ClipboardTool Elevated Paste Helper
// Runs with administrator privileges and performs Ctrl+V via SendInput,
// so pasting works even into elevated (admin) target applications.
// Protocol over named pipe: "paste <token>" or "quit <token>".
// 主进程（普通权限）是管道服务端，助手以客户端身份连接进来：
// 高完整性（管理员）进程连接普通权限进程的管道是允许的，
// 反过来（普通权限连接管理员管道）会被拒绝，所以方向不能反。
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class ElevatedHelper
{
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        // 必须包含最大的联合成员（MOUSEINPUT，x64 下 32 字节），
        // 否则 INPUT 大小错误，SendInput 返回 ERROR_INVALID_PARAMETER (87)。
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
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

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const ushort VK_CONTROL = 0x11;
    const ushort VK_V = 0x56;
    const string PIPE_NAME = "ClipboardToolElevatedHelper"; // NamedPipeServerStream 只接受管道名，不需要 \\\\.\\pipe\\ 前缀

    static INPUT KeyInput(ushort vk, uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = vk;
        input.U.ki.dwFlags = flags;
        return input;
    }

    static void Log(string msg)
    {
        try
        {
            System.IO.File.AppendAllText(
                System.IO.Path.Combine(System.IO.Path.GetTempPath(), "clipboard-helper.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + Environment.NewLine);
        }
        catch { }
    }

    static void SendCtrlV()
    {
        INPUT[] inputs = new INPUT[4];
        inputs[0] = KeyInput(VK_CONTROL, 0);
        inputs[1] = KeyInput(VK_V, 0);
        inputs[2] = KeyInput(VK_V, KEYEVENTF_KEYUP);
        inputs[3] = KeyInput(VK_CONTROL, KEYEVENTF_KEYUP);
        uint r = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        Log("SendInput=" + r + " lastError=" + Marshal.GetLastWin32Error());
    }

    static int Main(string[] args)
    {
        string token = "";
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--token") token = args[i + 1];
        }

        int failCount = 0;
        while (true)
        {
            try
            {
                using (NamedPipeClientStream client = new NamedPipeClientStream(".", PIPE_NAME, PipeDirection.In, PipeOptions.None))
                {
                    client.Connect(5000);
                    failCount = 0;
                    using (StreamReader reader = new StreamReader(client, Encoding.UTF8))
                    {
                        string line;
                        while ((line = reader.ReadLine()) != null)
                        {
                            Log("cmd=" + line);
                            if (line == "quit " + token) return 0;
                            if (line == "paste " + token) SendCtrlV();
                        }
                    }
                }
            }
            catch (TimeoutException)
            {
                // 主进程还没就绪，稍后重试。
            }
            catch (Exception ex)
            {
                Log("connError=" + ex.Message);
            }

            failCount++;
            if (failCount >= 300) return 0; // 约 5 分钟连不上主进程则自动退出
            Thread.Sleep(1000);
        }
    }
}





