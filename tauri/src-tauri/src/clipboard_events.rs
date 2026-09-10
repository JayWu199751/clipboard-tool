// 剪贴板变化的事件源：一个 message-only 窗口 + 系统通知 + 阻塞等的消息循环。
//
// 为什么替掉 600ms 轮询（真机读数见 README「待真机验证」与 changelog 同日条目）：
//   - 延迟从「复制后 0–600ms 的某个随机点」变成「复制刚发生」；
//   - 一个轮询间隔内的连续复制不再丢前一条——序列号只知道「变了」，不知道变了几次；
//   - 空闲时线程阻塞在 GetMessageW 上，0 空转 0 唤醒。
// 读取为什么不必加 debounce、不必放宽重试预算：探针实测（管理员终端，文本 8 条 + 截图 5 条）
// 通知到达时 GetOpenClipboardWindow() 恒为「无人持有」，等到可读文本最长 0.7ms、截图最长
// 13.8ms，都远低于两端各自的重试预算（图片 8x10ms、文字 arboard 5x5ms）。
//
// 重试为什么必须显式安排：纯事件模型下没有「下一轮」可等——读了没拿到、或者写盘失败，
// 系统不会因为我们失败而再发一次通知。所以每轮返回 false 就用 SetTimer 排一次重试，
// 成功即 KillTimer；周期定时器到点会持续重试，直到某一轮成功。

use std::time::Duration;

use windows::core::w;
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, RemoveClipboardFormatListener,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetMessageW, KillTimer, SetTimer, HWND_MESSAGE, MSG,
    WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLIPBOARDUPDATE, WM_TIMER,
};

/// 没搞定一轮之后的重试间隔。实测「等到可读」最长 13.8ms（截图），留约 3 倍余量；
/// 没成功就一直由这个周期定时器重试——剪贴板被占用是瞬时状态，等它放手即可。
const RETRY_INTERVAL: Duration = Duration::from_millis(50);
const RETRY_TIMER_ID: usize = 1;

/// 跑剪贴板事件循环。`on_change` 每收到一次变化通知（或重试定时器到点）调用一次：
/// 返回 true 表示这一轮已尘埃落定、不必再试；返回 false 表示这次没读到（剪贴板被别的
/// 程序占着）或写盘失败，需要安排重试。
///
/// 只有「消息窗建不起来 / 格式监听注册不上」才返回 Err——调用方据此退回 600ms 轮询兜底，
/// 免得最坏情况从「慢」变成「静默全哑」。
pub fn run(mut on_change: impl FnMut() -> bool) -> Result<(), String> {
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("clipboard-tool-watch"),
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
    .map_err(|err| format!("建消息窗失败：{err}"))?;

    unsafe { AddClipboardFormatListener(hwnd) }
        .map_err(|err| format!("注册剪贴板格式监听失败：{err}"))?;

    let mut msg = MSG::default();
    loop {
        // 阻塞等消息：空闲时 0 唤醒、0 空转，这就是替掉定时轮询换来的东西
        let ret = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if ret.0 <= 0 {
            break; // 0 = WM_QUIT，-1 = 出错
        }
        let settled = match msg.message {
            WM_CLIPBOARDUPDATE => Some(on_change()),
            WM_TIMER if msg.wParam.0 == RETRY_TIMER_ID => Some(on_change()),
            _ => None,
        };
        if let Some(settled) = settled {
            // 同一个 ID 的 SetTimer 是重置而不是叠加，所以反复排重试不会堆出多个定时器
            unsafe {
                if settled {
                    let _ = KillTimer(Some(hwnd), RETRY_TIMER_ID);
                } else {
                    SetTimer(Some(hwnd), RETRY_TIMER_ID, RETRY_INTERVAL.as_millis() as u32, None);
                }
            }
        }
    }

    unsafe {
        let _ = RemoveClipboardFormatListener(hwnd);
        let _ = DestroyWindow(hwnd);
    }
    Ok(())
}
