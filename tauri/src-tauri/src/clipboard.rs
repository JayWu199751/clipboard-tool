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

// 取剪贴板里的 DIB 原始字节：优先 CF_DIBV5，退回 CF_DIB。守卫只活到这行结束，返回的是拷贝。
// 三态而不是 Result：调用方要能区分「打不开剪贴板」（不可信，值得重试）与
// 「打开了但没有位图」（可信，剪贴板里就是没有图片）。
enum DibBytes {
    Bytes(Vec<u8>),
    NoImage,
    Occupied,
}

fn dib_bytes() -> DibBytes {
    let Some(clip) = ClipboardGuard::open() else {
        return DibBytes::Occupied;
    };
    match clip.bytes(CF_DIBV5).or_else(|| clip.bytes(CF_DIB)) {
        Some(bytes) => DibBytes::Bytes(bytes),
        None => DibBytes::NoImage,
    }
}

// 图片路径的三态。有 DIB 但解不出来（比如内容是别的位图变体）仍算「可信地没有可用图片」：
// 剪贴板状态是已知的，只是我们解不了它，重试也不会变。
enum ImageRead {
    Png(Vec<u8>),
    NoImage,
    Occupied,
}

// 读剪贴板图片并编码为 PNG。不走 arboard::get_image：它把 CF_DIBV5 直接交给 image 的
// BMP 解码器，那条路在「BI_BITFIELDS + V4/V5 头」上会把像素起点算多 12 字节，于是截图
// 全部解失败（原因与复现见 dib module 顶部注释）。解码发生在剪贴板之外。
fn read_image_png() -> ImageRead {
    match dib_bytes() {
        DibBytes::Bytes(raw) => match crate::dib::to_png(&raw) {
            Some(png) if !png.is_empty() => ImageRead::Png(png),
            _ => ImageRead::NoImage,
        },
        DibBytes::NoImage => ImageRead::NoImage,
        DibBytes::Occupied => ImageRead::Occupied,
    }
}

/// 一次读取的结果。「读不到」与「剪贴板里就是没有内容」是两件事，必须分开。
///
/// 混为一谈的代价不是丢掉一次重试机会，而是**永久丢内容**：剪贴板被占用的那一刻往往
/// 正是用户刚按下 Ctrl+C（源程序还在往剪贴板里写），此时若把「打不开」当成「剪贴板是空的」
/// 接受下来，基线就被记成空、序列号照旧推进，下一轮序列号短路命中再也不回来读——
/// 这次复制从历史里彻底消失，连补救的机会都没有。真机读数见 README「待真机验证」。
pub enum ReadOutcome {
    /// 剪贴板打开了，内容为 Snapshot（可以既没有位图也没有文字，那是可信的空）
    Known(Snapshot),
    /// 剪贴板被别的程序占着，这次读取不可信：调用方不要推进基线，稍后重试
    Occupied,
}

/// arboard 的读取错误里，只有「剪贴板被别的程序占用」是不确定的——它可能正是我们要的那次
/// 复制，只是这一刻拿不到，值得重试。其余（没有该格式 / 转换失败 / 平台不支持）都是确定的
/// 答案：剪贴板里就是没有可读的文字，接受它、照常推进基线、不必重试。
fn occupied(err: &arboard::Error) -> bool {
    matches!(err, arboard::Error::ClipboardOccupied)
}

/// 读一次剪贴板：图片走自己的 Win32 守卫，文字走 arboard，顺序固定为先图后字。
pub fn read() -> ReadOutcome {
    let png = match read_image_png() {
        ImageRead::Png(png) => Some(png),
        ImageRead::NoImage => None,
        ImageRead::Occupied => return ReadOutcome::Occupied,
    };
    // arboard 3.6 的 Clipboard::new() 是 Ok(Self(()))、实际不会失败；真会失败的是 get_text()
    let Ok(mut clip) = arboard::Clipboard::new() else {
        return ReadOutcome::Occupied;
    };
    match clip.get_text() {
        Ok(text) => ReadOutcome::Known(Snapshot { png, text }),
        Err(err) if occupied(&err) => ReadOutcome::Occupied,
        // 没有文字 / 格式读不出来：这是确定的答案，不是「拿不到剪贴板」
        Err(_) => ReadOutcome::Known(Snapshot { png, text: String::new() }),
    }
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

    use super::{dib_bytes, read_image_png, DibBytes, ImageRead};

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
        let raw = match dib_bytes() {
            DibBytes::Bytes(bytes) => bytes,
            DibBytes::NoImage => panic!("断在取字节：剪贴板里没有 CF_DIBV5 / CF_DIB，先截一张图再跑"),
            DibBytes::Occupied => panic!("断在 OpenClipboard：剪贴板打不开"),
        };
        eprintln!("第一步 OK：DIB {} 字节", raw.len());
        let decoded = crate::dib::to_png(&raw).expect("断在解码：dib::to_png 认不出这个 DIB");
        eprintln!("第二步 OK：解出 PNG {} 字节", decoded.len());

        let png = match read_image_png() {
            ImageRead::Png(png) => png,
            ImageRead::NoImage => panic!("断在端到端：剪贴板里没有可用的位图"),
            ImageRead::Occupied => panic!("断在端到端：剪贴板打不开"),
        };
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

// 判定侧单测：哪个读取错误算「不可信」。不碰剪贴板——只喂 arboard 的错误值，断的是
// 「把哪种失败当成值得重试」这条判定；真机行为由上面的 `真机探针` 与 README 的真机清单兜。
#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]
    use super::occupied;

    #[test]
    fn 只有剪贴板被占用算不可信_其余错误都是确定的答案() {
        assert!(occupied(&arboard::Error::ClipboardOccupied));
        assert!(!occupied(&arboard::Error::ContentNotAvailable));
        assert!(!occupied(&arboard::Error::ConversionFailure));
        assert!(!occupied(&arboard::Error::ClipboardNotSupported));
        assert!(!occupied(&arboard::Error::Unknown { description: "别的".into() }));
    }
}
