// 全局低级鼠标钩子（WH_MOUSE_LL）：resources/click-watcher.cs 的进程内移植。
// 原实现是常驻 C# 助手进程（stdout 文本行 "click X Y"）；Rust 版在主进程内起
// 钩子线程 + 消息泵，点击坐标经 channel 交给回调。普通权限即可（LL 钩子无需提权）。
//
// 用途：面板不抢焦点（focusable + 浏览态自动失焦），收不到 blur，
// 点击面板外需要由全局钩子上报坐标、主进程判断后隐藏面板。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::OnceLock;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
    HOOKPROC, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_QUIT,
};

const WM_LBUTTONDOWN: usize = 0x201;
const WM_RBUTTONDOWN: usize = 0x204;
const WM_MBUTTONDOWN: usize = 0x207;
const WM_XBUTTONDOWN: usize = 0x20B;

static CLICK_TX: OnceLock<mpsc::Sender<(i32, i32)>> = OnceLock::new();
static WATCHER_THREAD_ID: AtomicU32 = AtomicU32::new(0);

unsafe extern "system" fn hook_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    if n_code >= 0 {
        let msg = w_param.0;
        if matches!(msg, WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN) {
            let info = &*(l_param.0 as *const MSLLHOOKSTRUCT);
            if let Some(tx) = CLICK_TX.get() {
                let _ = tx.send((info.pt.x, info.pt.y));
            }
        }
    }
    CallNextHookEx(None, n_code, w_param, l_param)
}

pub struct ClickWatcher {
    stop_tx: Option<mpsc::Sender<()>>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl ClickWatcher {
    // 启动钩子线程；on_click 在独立转发线程上被调用（参数为物理像素坐标）。
    pub fn start<F: Fn(i32, i32) + Send + 'static>(on_click: F) -> ClickWatcher {
        let (tx, rx) = mpsc::channel::<(i32, i32)>();
        let _ = CLICK_TX.set(tx);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        // 钩子回调线程：安装 LL 钩子 + 消息泵（钩子回调在该线程上执行）。
        // 该线程由 WM_QUIT 退出，句柄不保存（进程退出时随之消亡）。
        let _hook_thread = std::thread::spawn(move || {
            WATCHER_THREAD_ID.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
            unsafe {
                // LL 钩子的 hMod 参数传 None（钩子过程在本进程内）
                let proc: HOOKPROC = Some(hook_proc);
                match SetWindowsHookExW(WH_MOUSE_LL, proc, None, 0) {
                    Ok(hook) => {
                        let mut msg = MSG::default();
                        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
                        let _ = UnhookWindowsHookEx(hook);
                    }
                    Err(err) => eprintln!("安装全局鼠标钩子失败: {err}"),
                }
            }
        });

        // 点击转发线程：钩子线程只做 channel send，消费侧独立处理。
        // recv_timeout 让 stop 时 join 有界（长时间无点击也能退出）。
        let forward = std::thread::spawn(move || loop {
            match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok((x, y)) => on_click(x, y),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        });

        ClickWatcher { stop_tx: Some(stop_tx), join: Some(forward) }
    }

    // 停止：向钩子线程投递 WM_QUIT 退出消息泵并卸载钩子
    pub fn stop(&mut self) {
        let tid = WATCHER_THREAD_ID.load(Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for ClickWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}
