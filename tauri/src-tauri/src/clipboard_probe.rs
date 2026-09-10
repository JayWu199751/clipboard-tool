// 剪贴板通知探针（真机专用，不进常规测试面，也不参与 release 构建）。
//
// 它回答三个只能实测、无法推理的问题——它们是「要不要把 600ms 轮询换成
// AddClipboardFormatListener」这个决策的全部未知项：
//
//   ① 提权进程收不收得到系统投递的 WM_CLIPBOARDUPDATE（UIPI 会不会拦）。
//      本工具是提权运行的，这一条决定事件模型到底能不能用。
//   ② 从通知到达、到剪贴板真的能被 OpenClipboard 打开，中间隔多久。
//      这就是事件模型必须留出的重试预算（现状：图片 8x10ms、文字走 arboard 5x5ms）。
//   ③ 一次「复制」会来几条通知、每条到达时剪贴板里已有哪些格式。
//      判据是**序列号增量**而不是时间间隔：一次完整复制让序列号前进「格式数 + 1」次
//      （EmptyClipboard 一次 + 每个 SetClipboardData 各一次）；增量小于它，说明这条
//      与上一条属于同一次复制（上一条到达时写入还没收手，即「读到半成品」的风险）。
//
// 跑法（**必须用管理员终端**，否则第 ① 问的结论无意义）：
//   cargo test --bin clipboard-tool -- 剪贴板通知探针 --ignored --nocapture
// 窗口期内做两次复制：① 从记事本复制一段文字；② 从管理员程序复制一段
// （管理员 cmd 里选中文字按回车）。两次都收到 = ① 的答案是「收得到」。
// 窗口期默认 25 秒，可用环境变量 CLIPBOARD_PROBE_SECS 调整。
//
// 注意：本探针自己就是一个剪贴板格式监听者，所以它的读数天然包含
// 「监听者之间互相抢锁」这一项——这正是要量的东西（见 LibreOffice bug #116983）。
//
// 只读不写：探针绝不修改剪贴板内容，也绝不释放 GetClipboardData 返回的句柄。

#![allow(non_snake_case)]

use std::time::{Duration, Instant};

use windows::core::{w, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, LPARAM, WPARAM};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, CountClipboardFormats, EnumClipboardFormats,
    GetClipboardSequenceNumber, GetOpenClipboardWindow, OpenClipboard, RemoveClipboardFormatListener,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetMessageW, GetWindowThreadProcessId, PostThreadMessageW,
    HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLIPBOARDUPDATE, WM_QUIT,
};

// 关心的格式号（Windows 定死，不随版本变）：文本 / 位图 / 带色彩空间的位图
const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;

// 通知到可读之间的等待上限：超过就认定为「这一轮拿不到」，别把探针卡死
const OPEN_WAIT_CAP: Duration = Duration::from_millis(1500);

// 当前进程是否以管理员（高完整性）身份运行
fn is_elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

// 此刻谁把剪贴板开着（尽力解析成 exe 名）。返回空串 = 没人在开。
// 这是「撞车对手是谁」的直接证据：撞上源程序、还是撞上另一个监听者。
fn clipboard_holder() -> String {
    unsafe {
        let Ok(hwnd) = GetOpenClipboardWindow() else {
            return String::new();
        };
        if hwnd.is_invalid() {
            return String::new();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return "<未知窗口>".to_string();
        }
        // 未提权时对高完整性进程会失败，这本身也是读数
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return format!("pid={pid}（无权查询）");
        };
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let path = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .ok()
        .map(|_| {
            let len = buf.iter().position(|&c| c == 0).unwrap_or(size as usize);
            String::from_utf16_lossy(&buf[..len])
        })
        .unwrap_or_default();
        let _ = CloseHandle(process);
        if path.is_empty() {
            return format!("pid={pid}");
        }
        let name = match std::path::Path::new(&path).file_name() {
            Some(s) => s.to_string_lossy().to_string(),
            None => path.clone(),
        };
        format!("{name}(pid={pid})")
    }
}

// 此刻剪贴板上关心的格式有哪些、一共几个格式。必须在剪贴板已打开时调用。
// 返回 (格式总数, 展示串)：总数是判断「一次复制几条通知」的原料——
// 一次完整复制会让序列号前进「格式数 + 1」次。
fn available_formats() -> (usize, String) {
    unsafe {
        let total = CountClipboardFormats();
        let mut list = Vec::new();
        let mut format = 0u32;
        // EnumClipboardFormats 必须按序迭代，返回 0 表示到头
        while list.len() < 64 {
            format = EnumClipboardFormats(format);
            if format == 0 {
                break;
            }
            list.push(format);
        }
        let mut marks = Vec::new();
        if list.contains(&CF_UNICODETEXT) {
            marks.push("文本");
        }
        if list.contains(&CF_DIBV5) {
            marks.push("DIBV5");
        }
        if list.contains(&CF_DIB) {
            marks.push("DIB");
        }
        if marks.is_empty() {
            marks.push("无文本/无位图");
        }
        (total.max(0) as usize, format!("{total}个格式[{}]", marks.join("+")))
    }
}

#[test]
#[ignore = "真机探针：需要人工在窗口期内复制两次内容"]
fn 剪贴板通知探针() {
    let secs: u64 = std::env::var("CLIPBOARD_PROBE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(25);

    let elevated = is_elevated();
    eprintln!("=== 剪贴板通知探针 ===");
    eprintln!(
        "本进程提权状态：{}",
        if elevated { "已提权（管理员）" } else { "未提权" }
    );
    if !elevated {
        eprintln!("警告：未提权运行。第 ① 问（提权进程能否收到通知）的结论无效，只能读 ② ③。");
        eprintln!("      请改用管理员终端重跑。");
    }

    // 消息窗：HWND_MESSAGE 不进 z-order、不可见，只用来收系统投递的通知
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("clipboard-tool-probe"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        )
    }
    .expect("创建消息窗失败");
    unsafe { AddClipboardFormatListener(hwnd) }.expect("AddClipboardFormatListener 失败");
    eprintln!("已注册剪贴板格式监听。");
    eprintln!();
    eprintln!("窗口期 {secs} 秒，请在此期间做两次复制：");
    eprintln!("  ① 从记事本（普通进程）复制一段文字");
    eprintln!("  ② 从管理员程序复制一段（例：管理员 cmd 里选中文字按回车）");
    eprintln!();

    // 看门狗：到点往本线程队列投 WM_QUIT，让阻塞的 GetMessageW 返回
    let tid = unsafe { GetCurrentThreadId() };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(secs));
        let _ = unsafe { PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0)) };
    });

    let mut count = 0usize;
    let mut same_copy = 0usize;
    let mut stall = 0usize;
    let mut max_wait_ms = 0.0f64;
    let mut last: Option<Instant> = None;
    let mut last_seq: Option<u32> = None;
    let mut msg = MSG::default();

    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
        if msg.message != WM_CLIPBOARDUPDATE {
            continue;
        }
        count += 1;
        let now = Instant::now();
        let gap_ms = last.map(|t| t.elapsed().as_secs_f64() * 1000.0);
        last = Some(now);

        let seq = unsafe { GetClipboardSequenceNumber() };
        // 时间间隔只当参考打印，不用它判定「一次复制几条通知」——那会误报：
        // 实测两条通知间隔只有 151ms，序列号却各 +8，其实是两次独立的复制。
        let seq_delta = last_seq.map(|prev| seq.wrapping_sub(prev));
        last_seq = Some(seq);
        // 通知到达那一瞬，锁在谁手上 —— 撞车对手的实锤
        let holder = clipboard_holder();
        let holder = if holder.is_empty() {
            "无人持有".to_string()
        } else {
            holder
        };

        // 死等到剪贴板真能打开，记下等了多久；前半段自旋保精度，超 50ms 后退化成小睡省 CPU
        let t0 = Instant::now();
        let mut opened = false;
        loop {
            if unsafe { OpenClipboard(None) }.is_ok() {
                opened = true;
                break;
            }
            if t0.elapsed() >= OPEN_WAIT_CAP {
                break;
            }
            if t0.elapsed() > Duration::from_millis(50) {
                std::thread::sleep(Duration::from_millis(1));
            } else {
                std::thread::yield_now();
            }
        }
        let waited_ms = t0.elapsed().as_secs_f64() * 1000.0;
        if opened {
            max_wait_ms = max_wait_ms.max(waited_ms);
        } else {
            stall += 1;
        }

        let (formats_total, formats) = if opened {
            let (total, text) = available_formats();
            let _ = unsafe { CloseClipboard() };
            (Some(total), text)
        } else {
            (None, "（始终打不开）".to_string())
        };

        // 判据：一次完整复制让序列号前进「格式数 + 1」次。增量小于它 = 与上一条同属一次复制。
        if let (Some(delta), Some(total)) = (seq_delta, formats_total) {
            if delta < total as u32 + 1 {
                same_copy += 1;
            }
        }

        let gap_text = match gap_ms {
            Some(g) => format!("{g:.0}ms"),
            None => "-".to_string(),
        };
        let delta_text = match seq_delta {
            Some(d) => format!("+{d}"),
            None => "-".to_string(),
        };
        eprintln!(
            "#{count}  距上一条 {gap_text}  seq={seq}(增量{delta_text})  通知到达时持锁者={holder}  等到可读 {waited_ms:.1}ms  内容={formats}"
        );
    }

    let _ = unsafe { RemoveClipboardFormatListener(hwnd) };
    let _ = unsafe { DestroyWindow(hwnd) };

    eprintln!();
    eprintln!("=== 读数 ===");
    eprintln!("收到通知 {count} 条；其中 {same_copy} 条与上一条同属一次复制");
    eprintln!("（判据是序列号增量而非时间间隔：一次完整复制让序列号前进「格式数 + 1」次）");
    eprintln!("通知 -> 可读 最长等待 {max_wait_ms:.1}ms；彻底打不开 {stall} 次");
    eprintln!();
    eprintln!("=== 结论 ===");

    if count == 0 {
        if elevated {
            eprintln!("① 提权进程 {secs} 秒内一条都没收到。");
            eprintln!("   若确认窗口期内确实复制过，这就是答案：系统通知被挡住，事件模型不可用，轮询不能删。");
        } else {
            eprintln!("未收到通知，且本次未提权 —— 请用管理员终端重跑后再下结论。");
        }
    } else if elevated {
        eprintln!("① 已提权仍收到 {count} 条通知：UIPI 不拦，事件模型在本工具上可用。");
    } else {
        eprintln!("① 未提权收到 {count} 条 —— 这一条不能外推到提权进程，请用管理员终端重跑。");
    }

    if count > 0 {
        eprintln!(
            "② 重试预算下限：最长等待 {max_wait_ms:.1}ms（现状图片 8x10ms、文字 arboard 5x5ms）。"
        );
        if same_copy > 0 {
            eprintln!("③ 有 {same_copy} 条的序列号增量小于「本条格式数 + 1」= 与上一条同属一次复制，");
            eprintln!("   即一次复制会发多条通知、前面几条到达时内容还没写完（存在读到半成品的风险）。");
        } else {
            eprintln!("③ 每条通知的序列号增量都等于「本条格式数 + 1」= 每条都对应一次独立的复制：");
            eprintln!("   一次复制 = 一条通知，且到达时已是终态。");
        }
    }

    assert!(
        count > 0,
        "窗口期内没有收到任何通知：要么没复制，要么通知被拦（提权与否见上方读数）"
    );
}
