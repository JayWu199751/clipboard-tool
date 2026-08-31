// 轮询基线：判断「这次剪贴板内容算不算一次新复制」的唯一实现。
//
// 规则（原先摊在 4 把独立 Mutex、3 个函数、2 个调用点上）：
//   1. 序列号未变且没有待重试的写盘失败 -> 本轮不必打开剪贴板（省 CPU，也少与他人争用）；
//   2. 图片优先：图片非空即按 PNG 内容哈希判定，文字基线跟上但不清空图片基线；
//   3. 无图片时按文字判定：空文字不算新复制；文字分支清空图片基线（图片->文字是真实切换）；
//   4. 图片写盘失败 -> 基线一律不动、置重试标志，下一轮即使序列号未变也再试一次；
//   5. 自己刚写入剪贴板（复制并粘贴）-> 立刻把当前内容认作基线，否则 600ms 后会被当成
//      「新复制」再提升+广播一次，表现为粘贴后列表闪一下。
//
// 本 module 不碰剪贴板、不碰窗口、不碰 store：调用方把读到的 (png, text) 递进来，
// 拿回一个 Change，落库后再用 confirm 回报成败。因此可以纯数据表驱动直测。

use crate::history::sha1_hex;

/// 本轮需要落库的新内容
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Image { png: Vec<u8>, hash: String },
    Text(String),
}

/// observe 判定后暂存的基线更新，confirm(ok) 才真正接受
#[derive(Debug, Default)]
struct Pending {
    text: Option<String>,
    image_hash: Option<String>,
}

#[derive(Debug, Default)]
pub struct PollBaseline {
    text: String,
    image_hash: String,
    seq: u32,
    retry: bool,
    pending: Option<Pending>,
}

impl PollBaseline {
    pub fn new() -> Self {
        Self::default()
    }

    /// 序列号未变且无待重试 -> 本轮可跳过（seq 为 0 表示取不到序列号，保守地照常轮询）
    pub fn skip_unchanged(&self, seq: u32) -> bool {
        seq != 0 && !self.retry && seq == self.seq
    }

    /// 记录本轮结束时的序列号
    pub fn note_seq(&mut self, seq: u32) {
        self.seq = seq;
    }

    /// 与基线比对本轮所见。返回 Some(Change) 时基线只是暂存，
    /// 必须再调用 confirm 才生效（图片写盘可能失败）。
    pub fn observe(&mut self, png: Option<Vec<u8>>, text: String) -> Option<Change> {
        if let Some(png) = png.filter(|bytes| !bytes.is_empty()) {
            let hash = sha1_hex(&png);
            if hash != self.image_hash {
                let change = Some(Change::Image { png, hash: hash.clone() });
                self.pending = Some(Pending { text: Some(text), image_hash: Some(hash) });
                return change;
            }
            self.pending = Some(Pending { text: Some(text), image_hash: None });
            return None;
        }
        let changed = !text.is_empty() && text != self.text;
        self.pending = Some(Pending { text: Some(text.clone()), image_hash: Some(String::new()) });
        if changed {
            Some(Change::Text(text))
        } else {
            None
        }
    }

    /// 回报本轮落库结果：成功接受基线，失败则基线不动并置重试标志
    pub fn confirm(&mut self, ok: bool) {
        let pending = match self.pending.take() {
            Some(pending) => pending,
            None => return,
        };
        if !ok {
            self.retry = true;
            return;
        }
        if let Some(text) = pending.text {
            self.text = text;
        }
        if let Some(hash) = pending.image_hash {
            self.image_hash = hash;
        }
        self.retry = false;
    }

    /// 直接把当前内容认作基线（启动基线、自己写入后的同步），不产生 Change
    pub fn sync_now(&mut self, png: Option<Vec<u8>>, text: String) {
        self.pending = None;
        self.retry = false;
        match png.filter(|bytes| !bytes.is_empty()) {
            Some(png) => {
                self.image_hash = sha1_hex(&png);
                self.text = text;
            }
            None => {
                self.text = text;
                self.image_hash = String::new();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用
    use super::*;

    fn png(tag: &str) -> Vec<u8> {
        tag.as_bytes().to_vec()
    }

    /// observe + confirm(ok)：一次完整轮询
    fn round(b: &mut PollBaseline, image: Option<Vec<u8>>, text: &str) -> Option<Change> {
        let change = b.observe(image, text.to_string());
        b.confirm(true);
        change
    }

    #[test]
    fn 新文字算一次复制_同文字与空文字不算() {
        let mut b = PollBaseline::new();
        assert_eq!(round(&mut b, None, "abc"), Some(Change::Text("abc".into())));
        assert_eq!(round(&mut b, None, "abc"), None);
        assert_eq!(round(&mut b, None, ""), None);
        assert_eq!(round(&mut b, None, "abd"), Some(Change::Text("abd".into())));
    }

    #[test]
    fn 图片按内容哈希判定_同图不重复报_换图才报() {
        let mut b = PollBaseline::new();
        let first = round(&mut b, Some(png("img1")), "");
        assert!(matches!(first, Some(Change::Image { hash, .. }) if hash == sha1_hex(&png("img1"))));
        assert_eq!(round(&mut b, Some(png("img1")), ""), None);
        assert!(matches!(round(&mut b, Some(png("img2")), ""), Some(Change::Image { .. })));
    }

    #[test]
    fn 图片未变时文字基线仍跟上_但不清图片基线() {
        let mut b = PollBaseline::new();
        round(&mut b, Some(png("img1")), "旧文字");
        // 同一张图 + 新文字：不报新复制（图片优先），但文字基线要跟上
        assert_eq!(round(&mut b, Some(png("img1")), "新文字"), None);
        assert_eq!(b.text, "新文字");
        assert_eq!(b.image_hash, sha1_hex(&png("img1")));
    }

    #[test]
    fn 图片写盘失败_基线不动并置重试_下一轮仍判定为新() {
        let mut b = PollBaseline::new();
        b.note_seq(1);
        let change = b.observe(Some(png("img1")), String::new());
        assert!(matches!(change, Some(Change::Image { .. })));
        b.confirm(false);
        assert!(!b.skip_unchanged(1), "有待重试的写盘失败时不能短路");
        // 基线没动，所以同一张图仍会被再次尝试
        assert!(matches!(b.observe(Some(png("img1")), String::new()), Some(Change::Image { .. })));
        b.confirm(true);
        assert!(b.skip_unchanged(1), "重试已落地，序列号未变即可短路");
        assert_eq!(b.observe(Some(png("img1")), String::new()), None);
    }

    #[test]
    fn 图片切回文字算新复制_并清空图片基线() {
        let mut b = PollBaseline::new();
        round(&mut b, Some(png("img1")), "");
        assert_eq!(round(&mut b, None, "文字"), Some(Change::Text("文字".into())));
        assert!(b.image_hash.is_empty());
        // 图片基线清空后，同一张图再来仍算新复制
        assert!(matches!(round(&mut b, Some(png("img1")), ""), Some(Change::Image { .. })));
    }

    #[test]
    fn 序列号短路_待重试与取不到序列号时不短路() {
        let mut b = PollBaseline::new();
        b.note_seq(7);
        assert!(b.skip_unchanged(7));
        assert!(!b.skip_unchanged(8));
        assert!(!b.skip_unchanged(0), "取不到序列号时保守照常轮询");
        b.observe(Some(png("img")), String::new());
        b.confirm(false);
        assert!(!b.skip_unchanged(7), "有待重试的写盘失败时不能短路");
    }

    #[test]
    fn sync_now把自己写入的内容认作基线() {
        let mut b = PollBaseline::new();
        b.sync_now(None, "我刚复制的".into());
        assert_eq!(round(&mut b, None, "我刚复制的"), None);
        b.sync_now(Some(png("img1")), "残留文字".into());
        assert_eq!(round(&mut b, Some(png("img1")), "残留文字"), None);
        // sync_now 同时清掉待重试标志：自己刚写入的内容就是新基线，旧的一次写盘不必再补
        b.observe(Some(png("img2")), String::new());
        b.confirm(false);
        b.note_seq(9);
        assert!(!b.skip_unchanged(9), "置了重试标志后不能短路");
        b.sync_now(Some(png("img1")), "残留文字".into());
        assert!(b.skip_unchanged(9), "sync_now 应清掉重试标志");
    }
}
