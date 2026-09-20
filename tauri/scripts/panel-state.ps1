# 面板状态探针（只读：不写样式、不发消息、不改任何状态）。
#
# 为什么要它：开机自启场景下「按了没反应」这类事跑不了自动化，肉眼又只看到一个现象。
# 这个探针把那个现象拆成几条能分别证伪的读数，跑两次（呼出前 / 呼出后）即可定位：
#   1) window 行 vis=True、ex 里没有 APPWINDOW     → 任务栏那个按钮的成因还在不在
#   2) 呼出后 rect 从屏外移到屏内、仍看不到东西    → 窗口没问题，是 WebView2 没画出东西（看 webview2 行）
#   3) 呼出后 rect 仍在屏外                        → 呼出这个动作没跑起来（对照 diag.log 的 show-at-cursor 行）
#   4) diag.log 里有 show-at-cursor 且写了拿不到显示器 / 光标 → 三级兜底也没落地，那行末尾就是原因
#   5) diag.log 里没有 hotkey_register ... Registered         → 呼出键压根没注册上（被别的程序占了）
#   6) instances 大于 1                            → 同时活着两份，呼出键只可能被一份注册上（看 elevated=）
#   respond=False                                  → 主线程卡住（托盘菜单能弹是外壳画的，点了不执行）
#   theme 行与图标不符                             → 图标配色看 SystemUsesLightTheme，不看 AppsUseLightTheme
#
# 本机执行策略禁跑 .ps1，所以这样调用（在仓库根目录）：
#   powershell -NoProfile -Command "iex (Get-Content -Raw 'tauri\scripts\panel-state.ps1')"
# 输出串一律 ASCII：PS 5.1 读无 BOM 的 .ps1 按 ANSI 解码，中文输出会变成乱码（注释不受影响）。
$ErrorActionPreference = 'Continue'
$sig = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class PS {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static List<string> Rows(uint pid) {
    List<string> o = new List<string>();
    EnumWindows((h, l) => {
      uint q; GetWindowThreadProcessId(h, out q);
      if (q != pid) return true;
      StringBuilder t = new StringBuilder(128); GetWindowText(h, t, 128);
      RECT r; GetWindowRect(h, out r);
      uint ex = (uint)GetWindowLong(h, -20);
      string[] names = { "TOPMOST", "TRANSPARENT", "TOOLWINDOW", "APPWINDOW", "LAYERED" };
      uint[] bits = { 0x8, 0x20, 0x80, 0x40000, 0x80000 };
      List<string> on = new List<string>();
      for (int i = 0; i < bits.Length; i++) if ((ex & bits[i]) != 0) on.Add(names[i]);
      o.Add(string.Format("hwnd=0x{0:X} title=[{1}] vis={2} fg={3} ex=0x{4:X8}({5}) rect={6},{7} {8}x{9}",
        h.ToInt64() & 0xFFFFFFFF, t, IsWindowVisible(h), h == GetForegroundWindow(), ex,
        string.Join("|", on), r.L, r.T, r.R - r.L, r.B - r.T));
      return true;
    }, IntPtr.Zero);
    return o;
  }
  public static string Cursor() { POINT p; GetCursorPos(out p); return p.X + "," + p.Y; }
  // Is this process high integrity (elevated)? Querying an elevated token from a plain
  // shell can be denied -- then we print "?", which is itself a reading.
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, uint pid);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr t, int cls, byte[] info, uint len, out uint ret);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Elevated(uint pid) {
    IntPtr h = OpenProcess(0x0400, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return "?";
    try {
      IntPtr tok;
      if (!OpenProcessToken(h, 0x0008, out tok)) return "?"; // TOKEN_QUERY
      try {
        uint ret; byte[] buf = new byte[8];
        if (!GetTokenInformation(tok, 20 /* TokenElevation */, buf, (uint)buf.Length, out ret)) return "?";
        return BitConverter.ToInt32(buf, 0) != 0 ? "True" : "False";
      } finally { CloseHandle(tok); }
    } finally { CloseHandle(h); }
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

# 逐个实例列：开机那次「热键与托盘都呼不出」有一个候选是同时活着两份，
# 而呼出键只可能被其中一份注册上——另一份按什么都没反应。只查一个 pid 会把这件事看漏。
$all = @(Get-Process clipboard-tool -ErrorAction SilentlyContinue)
if ($all.Count -eq 0) { 'instance: clipboard-tool NOT RUNNING'; exit }
"shell    : elevated=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
"instances: $($all.Count)   (>1 = more than one copy is alive)"
foreach ($p in $all) {
  "instance : pid={0} start={1} respond={2} threads={3} elevated={4}" -f `
    $p.Id, $p.StartTime.ToString('HH:mm:ss'), $p.Responding, $p.Threads.Count, [PS]::Elevated([uint32]$p.Id)
  foreach ($row in [PS]::Rows([uint32]$p.Id)) { "  window : $row" }
}
"cursor   : $([PS]::Cursor())  ; rects above are virtualized px when this shell is DPI-unaware"
# 托盘图标的亮暗读的是第一个键（Windows 模式 = 任务栏），不是第二个（应用模式 = 窗口内容）。
# 配色不对时先看这两个值，再对 diag.log 里 tray-icon 那行选了哪一套。
$pc = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$sys = (Get-ItemProperty $pc -Name SystemUsesLightTheme -ErrorAction SilentlyContinue).SystemUsesLightTheme
$app = (Get-ItemProperty $pc -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme
"theme    : SystemUsesLightTheme=$sys AppsUseLightTheme=$app   (0 = dark; tray icon follows the FIRST key)"
$wv = @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue)
"webview2 : msedgewebview2 count = $($wv.Count)   (0 => renderer never started, panel can only be blank)"
Add-Type -AssemblyName System.Windows.Forms
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  "monitor  : $($s.DeviceName) bounds=$($s.Bounds) work=$($s.WorkingArea) primary=$($s.Primary)"
}
$dl = Join-Path $env:APPDATA 'ClipboardTool\diag.log'
if (Test-Path $dl) {
  '--- diag.log tail 25 (needs user env CLIPBOARD_TOOL_DIAG=1 before the app started) ---'
  '    arrow-key repeat fills the tail on screen noise; Up/Down filtered out to keep the skeleton'
  Get-Content $dl -Tail 200 |
    Where-Object { $_ -notmatch 'dispatch_hotkey accel=(Up|Down)$' } |
    Select-Object -Last 25
} else {
  'diag.log : missing (CLIPBOARD_TOOL_DIAG not in effect for that instance)'
}
