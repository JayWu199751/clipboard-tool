// 剪贴板独占窗口的唯一归属：怎么打开、取哪些格式、什么时候必须关掉。
//
// 为什么需要这条 seam：OpenClipboard 小步重试、CF_DIBV5 → CF_DIB 退让、Drop 必关、
// arboard 文字读写，这四件事原先散在 main.rs 的六个自由函数里，「读一次剪贴板」在
// sync_baseline 与 poll_once 各写一遍，两处对 arboard 打开失败的处理还不一致（一处
// trace + return，一处静默 return）。现在独占窗口只有一处定义，两条链路共用 read()。
//
// 必须守住的时序（ADR-0009 之后补的约束，别再改回去）：取完字节立刻释放守卫，PNG 解码
// 在剪贴板之外做。抱着 CloseClipboard 解一张大图要几十毫秒，那段时间别的程序
// OpenClipboard 会失败——而它正是用户刚按下 Ctrl+C 的时刻。这条约束由 dib_bytes() 的
// 作用域保证，调用方拿到的已经是拷贝出来的字节。
//
// 本 module 不做领域判定：解码形状归 dib，「算不算一次新复制」归 poll_baseline，
// 链路顺序归 paste_chain。这里只管独占与搬运。

use std::time::Duration;

/// 标准剪贴板格式号，Windows 定死的两个数，不随版本变
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;

/// 一次读取的结果。png 为 None 表示剪贴板里没有可解的位图；text 为空串表示没有文字。
pub struct Snapshot {
    pub png: Option<Vec<u8>>,
    pub text: String,
}

/// 打开剪贴板的 RAII 守卫：OpenClipboard 之后必须 CloseClipboard，否则别的程序（包括我们
/// 自己的下一轮轮询）会一直拿不到剪贴板。放在 Drop 里关，任何提前返回都漏不掉。
struct ClipboardGuard;

impl ClipboardGuard {
    // 剪贴板随时可能被别的程序短暂占用：小步重试，实在拿不到就放弃本轮，600ms 后还会再来
    fn open() -> Option<Self> {
        for attempt in 0..8 {
            if unsafe { windows::Win32::System::DataExchange::OpenClipboard(None) }.is_ok() {
                return Some(Self);
            }
            if attempt + 1 < 8 {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        None
    }

    // 取某个格式的原始字节。返回的内存句柄归剪贴板所有，只读不动、绝不释放。
    fn bytes(&self, format: u32) -> Option<Vec<u8>> {
        let handle =
            unsafe { windows::Win32::System::DataExchange::GetClipboardData(format) }.ok()?;
        let global = windows::Win32::Foundation::HGLOBAL(handle.0);
        let size = unsafe { windows::Win32::System::Memory::GlobalSize(global) };
        if size == 0 {
            return None;
        }
        let ptr = unsafe { windows::Win32::System::Memory::GlobalLock(global) };
        if ptr.is_null() {
            return None;
        }
        let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, size) }.to_vec();
        unsafe {
            let _ = windows::Win32::System::Memory::GlobalUnlock(global);
        }
        (!bytes.is_empty()).then_some(bytes)
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::System::DataExchange::CloseClipboard();
        }
    }
}

// 取剪贴板里的 DIB 原始字节：优先 CF_DIBV5，退回 CF_DIB。守卫只活到这行结束，
// 返回的是拷贝。失败原因用 &'static str 带出来，真机探针靠它分步定位。
fn dib_bytes() -> Result<Vec<u8>, &'static str> {
    let Some(clip) = ClipboardGuard::open() else {
        return Err("断在 OpenClipboard：剪贴板打不开");
    };
    let Some(bytes) = clip.bytes(CF_DIBV5).or_else(|| clip.bytes(CF_DIB)) else {
        return Err("断在取字节：剪贴板里没有 CF_DIBV5 / CF_DIB，先截一张图再跑");
    };
    Ok(bytes)
}

// 读剪贴板图片并编码为 PNG。不走 arboard::get_image：它把 CF_DIBV5 直接交给 image 的
// BMP 解码器，那条路在「BI_BITFIELDS + V4/V5 头」上会把像素起点算多 12 字节，于是截图
// 全部解失败（原因与复现见 dib module 顶部注释）。解码发生在剪贴板之外。
fn read_image_png() -> Option<Vec<u8>> {
    let raw = dib_bytes().ok()?;
    crate::dib::to_png(&raw)
}

/// 读一次剪贴板：图片走自己的 Win32 守卫，文字走 arboard，顺序固定为先图后字。
///
/// 返回 None 表示文字端口打不开，这次读取整体作废。启动基线与轮询此前各写一遍、
/// 对这个失败的处理还不一致，现在共用同一个判断。
pub fn read() -> Option<Snapshot> {
    let png = read_image_png().filter(|bytes| !bytes.is_empty());
    let mut clip = arboard::Clipboard::new().ok()?;
    Some(Snapshot { png, text: clip.get_text().unwrap_or_default() })
}

/// 写文字进剪贴板。
pub fn write_text(text: &str) -> bool {
    let Ok(mut clip) = arboard::Clipboard::new() else { return false };
    clip.set_text(text.to_string()).is_ok()
}

/// 按 PNG 文件路径写位图：读文件 → 解码为 RGBA → 交给 arboard。
pub fn write_image_file(path: &str) -> bool {
    let Ok(bytes) = std::fs::read(path) else { return false };
    let Ok(decoded) = image::load_from_memory(&bytes) else { return false };
    let rgba = decoded.to_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    let data = arboard::ImageData {
        width: w,
        height: h,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    };
    let Ok(mut clip) = arboard::Clipboard::new() else { return false };
    clip.set_image(data).is_ok()
}

/// 剪贴板序列号：Win32 全局计数器，任何写剪贴板操作都会 +1。
/// 读取不需要打开剪贴板——用它短路未变化的轮询，既省 CPU 又减少与其他程序的争用；
/// 否则每 600ms 都要无条件读一次剪贴板图片并编码 PNG。
pub fn sequence() -> u32 {
    unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

#[cfg(test)]
mod 真机探针 {
    #![allow(non_snake_case)]

    use super::{dib_bytes, read_image_png};

    // 依赖真机剪贴板内容，不进常规测试面。跑法：先截一张图（PixPin、Win+Shift+S 都行），然后
    //   cargo test --bin clipboard-tool -- 真机探针 --ignored --nocapture
    #[test]
    #[ignore = "需要真机剪贴板里正躺着一张截图"]
    fn 剪贴板里的截图必须读出PNG并判定为新复制() {
        // 对照组：arboard 的 get_image 走 image 的 BMP 解码器，截图在这条路上必挂（见 dib）
        match arboard::Clipboard::new().map(|mut c| c.get_image()) {
            Ok(Ok(img)) => eprintln!("arboard get_image Ok: {}x{}", img.width, img.height),
            Ok(Err(err)) => eprintln!("arboard get_image Err: {err:?}"),
            Err(err) => eprintln!("arboard Clipboard::new Err: {err:?}"),
        }

        // 逐步报：打开剪贴板 + 取 DIB 字节 → 解码 → 端到端，哪一步断掉一眼看见
        let raw = dib_bytes().unwrap_or_else(|why| panic!("{why}"));
        eprintln!("第一步 OK：DIB {} 字节", raw.len());
        let decoded = crate::dib::to_png(&raw).expect("断在解码：dib::to_png 认不出这个 DIB");
        eprintln!("第二步 OK：解出 PNG {} 字节", decoded.len());

        let png = read_image_png().expect("断在端到端：read_image_png 返回 None");
        eprintln!("第三步 OK：read_image_png -> {} 字节", png.len());

        // 读出之后还要过基线判定，否则仍然不会进历史
        let mut baseline = crate::poll_baseline::PollBaseline::new();
        let change = baseline.observe(Some(png), String::new());
        assert!(
            matches!(change, Some(crate::poll_baseline::Change::Image { .. })),
            "读出了 PNG 但基线没判定为新复制"
        );
    }
}
