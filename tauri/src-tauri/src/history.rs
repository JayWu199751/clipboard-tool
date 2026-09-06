// 「历史」领域核心：条目身份、去重提升、置顶块排序、上限裁剪、备注。
// 纯内存 module：不依赖 tauri / Win32，可按 interface 直接测试。
// 效果经注入端口进入：文件系统四条（Ports 的 save_image_png / hash_image_file /
// remove_image_file / image_file_exists，四条全部必供，缺一个编译不过）与时间 / id
// 两条（Clock，默认是真时钟与 uuid v4）；持久化与 broadcast 由调用方（main.rs）完成，不属于本 module。
// 领域规则出处：ADR-0003（条目身份只由内容决定）、ADR-0004（置顶块与普通块）、
// CONTEXT.md「备注」「落位」。

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::sync::Arc;

pub const DEFAULT_MAX_HISTORY: usize = 200;
pub const DEFAULT_MAX_NOTE_LENGTH: usize = 200;

pub fn sha1_hex(buf: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(buf);
    let out = h.finalize();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

pub type NowFn = Arc<dyn Fn() -> u64 + Send + Sync>;
pub type MakeIdFn = Arc<dyn Fn() -> String + Send + Sync>;
pub type SaveImagePngFn = Arc<dyn Fn(&[u8], &str) -> Option<String> + Send + Sync>;
pub type HashImageFileFn = Arc<dyn Fn(&str) -> String + Send + Sync>;
pub type RemoveImageFileFn = Arc<dyn Fn(&str) + Send + Sync>;
pub type ImageFileExistsFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceApp {
    #[serde(default)]
    pub exe_path: String,
    #[serde(default)]
    pub app_name: String,
    #[serde(default)]
    pub window_title: String,
    #[serde(default)]
    pub icon_data_url: Option<String>,
}

impl Default for SourceApp {
    fn default() -> Self {
        SourceApp { exe_path: String::new(), app_name: String::new(), window_title: String::new(), icon_data_url: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntryType {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "image")]
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    #[serde(rename = "type")]
    pub entry_type: EntryType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub source_app: Option<SourceApp>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub pinned_at: u64,
    #[serde(default)]
    pub note: String,
}

/// recordText / recordImage 的返回：entry 为 None 表示没有落库（空内容或写盘失败，
/// 调用方不应更新轮询基线，下次轮询重试）。hash 仅 recordImage 填写（deduped/hash 供
/// 测试与后续调用方使用）。
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RecordOutcome {
    pub entry: Option<Entry>,
    pub deduped: bool,
    pub hash: String,
}

pub struct HistoryStore {
    max: usize,
    now_fn: NowFn,
    make_id: MakeIdFn,
    ports: Ports,
    entries: Vec<Entry>,
    // 图片内容哈希缓存：entry.id -> sha1（图片文件创建后不会变化）
    image_hash_cache: HashMap<String, String>,
}

/// 文件系统端口：写图、取哈希、删图、判存在。四个全部必供。
/// 它们曾写成 `Option` 配八个 setter，于是「漏配一个」不报错、只是静默降级——
/// 漏 `hash_image_file` 会让哈希恒空、图片去重永不命中，而测试照样全绿。
/// 现在缺一个字段就编译不过。
pub struct Ports {
    pub save_image_png: SaveImagePngFn,
    pub hash_image_file: HashImageFileFn,
    pub remove_image_file: RemoveImageFileFn,
    pub image_file_exists: ImageFileExistsFn,
}

/// 时间与 id 端口：生产用真时钟与 uuid v4，测试按需替换。
/// 与 `Ports` 分开，是因为这两个确实有合理默认值；文件端口没有。
#[derive(Clone)]
pub struct Clock {
    pub now: NowFn,
    pub make_id: MakeIdFn,
}

impl Default for Clock {
    fn default() -> Self {
        Self { now: Arc::new(now_millis), make_id: Arc::new(|| uuid::Uuid::new_v4().to_string()) }
    }
}

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl HistoryStore {
    /// 唯一构造入口：上限 + 文件端口（必供）+ 时钟端口（有默认）。
    pub fn new(max: usize, ports: Ports, clock: Clock) -> Self {
        HistoryStore {
            max,
            now_fn: clock.now,
            make_id: clock.make_id,
            ports,
            entries: Vec::new(),
            image_hash_cache: HashMap::new(),
        }
    }

    pub fn normalize_note(&self, note: &str) -> String {
        let trimmed = note.trim();
        trimmed.chars().take(DEFAULT_MAX_NOTE_LENGTH).collect()
    }

    pub fn find(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }

    pub fn entries(&self) -> &Vec<Entry> {
        &self.entries
    }

    #[allow(dead_code)] // 测试使用
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn match_text(&self, text: &str) -> Option<usize> {
        self.entries
            .iter()
            .position(|e| e.entry_type == EntryType::Text && e.text.as_deref() == Some(text))
    }

    fn match_image_hash(&mut self, hash: &str) -> Option<usize> {
        if hash.is_empty() {
            return None;
        }
        // 先收集图片条目快照，避免迭代 entries 的不可变借用与缓存写入的可变借用冲突
        let candidates: Vec<(usize, String, String)> = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.entry_type == EntryType::Image)
            .filter_map(|(i, e)| e.image_path.clone().map(|p| (i, e.id.clone(), p)))
            .collect();
        for (i, id, path) in candidates {
            let h = match self.image_hash_cache.get(&id) {
                Some(h) => h.clone(),
                None => {
                    let h = (self.ports.hash_image_file)(&path);
                    if !h.is_empty() {
                        self.image_hash_cache.insert(id.clone(), h.clone());
                    }
                    h
                }
            };
            if h == hash {
                return Some(i);
            }
        }
        None
    }

    fn pinned_count(&self) -> usize {
        let mut n = 0;
        while n < self.entries.len() && self.entries[n].pinned {
            n += 1;
        }
        n
    }

    // 普通块最前 = 置顶块之后第一个位置
    fn insert_at_normal_front(&mut self, entry: Entry) {
        let at = self.pinned_count();
        self.entries.insert(at, entry);
    }

    // 排序规则：置顶条目固定在最前（按置顶时间新→旧），之后按原数组顺序（即最近使用新→旧）。
    fn sort(&mut self) {
        let mut pinned: Vec<Entry> = self
            .entries
            .iter()
            .filter(|e| e.pinned)
            .cloned()
            .collect();
        pinned.sort_by(|a, b| b.pinned_at.cmp(&a.pinned_at));
        let rest: Vec<Entry> = self.entries.iter().filter(|e| !e.pinned).cloned().collect();
        pinned.extend(rest);
        self.entries = pinned;
    }

    fn drop_image_file(&mut self, entry: &Entry) {
        self.image_hash_cache.remove(&entry.id);
        if entry.entry_type == EntryType::Image {
            if let Some(path) = &entry.image_path {
                (self.ports.remove_image_file)(path);
            }
        }
    }

    // 历史上限裁剪：置顶条目豁免，先裁普通块尾部；全部置顶时才裁最旧的置顶条目。
    fn trim(&mut self) {
        while self.entries.len() > self.max {
            let mut idx: isize = -1;
            for i in (0..self.entries.len()).rev() {
                if !self.entries[i].pinned {
                    idx = i as isize;
                    break;
                }
            }
            if idx == -1 {
                idx = self.entries.len() as isize - 1;
            }
            let removed = self.entries.remove(idx as usize);
            self.drop_image_file(&removed);
        }
    }

    // 把已有条目提升为"最近使用"：普通条目移到普通块最前；置顶条目刷新 pinnedAt 并移到置顶块最前。
    // 备注/来源/创建时间等属性保持不变。
    pub fn promote(&mut self, id: &str) -> bool {
        let Some(idx) = self.entries.iter().position(|e| e.id == id) else { return false };
        let mut entry = self.entries.remove(idx);
        if entry.pinned {
            entry.pinned_at = (self.now_fn)();
            self.entries.insert(0, entry);
        } else {
            self.insert_at_normal_front(entry);
        }
        true
    }

    fn insert_new(&mut self, entry: Entry) {
        // 新内容永远插在置顶块之后、普通块最前
        self.insert_at_normal_front(entry);
        self.trim();
    }

    // 从历史 JSON 载入：过滤无效/丢文件条目、归一化旧数据字段（pinned/pinnedAt/note 缺省）、排序、裁剪。
    // raw 为解析后的 JSON 数组（宽松处理：单条损坏只丢该条，不整体失败）。
    pub fn load(&mut self, raw: Option<Vec<serde_json::Value>>) {
        self.image_hash_cache.clear();
        let mut list: Vec<Entry> = Vec::new();
        for value in raw.unwrap_or_default() {
            let Some(id) = value.get("id").and_then(|v| v.as_str()) else { continue };
            if id.is_empty() {
                continue;
            }
            let Ok(mut entry) = serde_json::from_value::<Entry>(value) else { continue };
            match entry.entry_type {
                EntryType::Image => {
                    let Some(path) = entry.image_path.clone() else { continue };
                    if !(self.ports.image_file_exists)(&path) {
                        continue;
                    }
                }
                EntryType::Text => {
                    if entry.text.is_none() {
                        continue;
                    }
                }
            }
            entry.pinned = entry.pinned || false; // serde default 已归一，保留显式语义
            entry.note = self.normalize_note(&entry.note);
            list.push(entry);
        }
        self.entries = list;
        self.sort();
        self.trim();
    }

    // 文本复制进历史：身份命中（全文逐字符相等）→ 提升且属性不变；否则新建并裁剪
    pub fn record_text(&mut self, text: &str, source_app: Option<SourceApp>) -> RecordOutcome {
        if text.is_empty() {
            return RecordOutcome { entry: None, deduped: false, hash: String::new() };
        }
        if let Some(idx) = self.match_text(text) {
            let id = self.entries[idx].id.clone();
            self.promote(&id);
            let entry = self.find(&id).cloned();
            return RecordOutcome { entry, deduped: true, hash: String::new() };
        }
        let entry = Entry {
            id: (self.make_id)(),
            entry_type: EntryType::Text,
            text: Some(text.to_string()),
            image_path: None,
            created_at: (self.now_fn)(),
            source_app,
            pinned: false,
            pinned_at: 0,
            note: String::new(),
        };
        self.insert_new(entry.clone());
        RecordOutcome { entry: Some(entry), deduped: false, hash: String::new() }
    }

    // 图片复制进历史：身份按 PNG 内容 sha1。命中 → 提升且不写新文件；未命中 → 经 save_image_png 写盘后插入。
    // 写盘失败返回 entry: None，调用方不应更新轮询基线（下次轮询重试）。
    pub fn record_image(&mut self, png: &[u8], source_app: Option<SourceApp>) -> RecordOutcome {
        if png.is_empty() {
            return RecordOutcome { entry: None, deduped: false, hash: String::new() };
        }
        let hash = sha1_hex(png);
        if let Some(idx) = self.match_image_hash(&hash) {
            let id = self.entries[idx].id.clone();
            self.promote(&id);
            let entry = self.find(&id).cloned();
            return RecordOutcome { entry, deduped: true, hash };
        }
        let id = (self.make_id)();
        let image_path = (self.ports.save_image_png)(png, &id);
        let Some(image_path) = image_path else {
            return RecordOutcome { entry: None, deduped: false, hash };
        };
        let entry = Entry {
            id: id.clone(),
            entry_type: EntryType::Image,
            text: None,
            image_path: Some(image_path),
            created_at: (self.now_fn)(),
            source_app,
            pinned: false,
            pinned_at: 0,
            note: String::new(),
        };
        self.image_hash_cache.insert(id, hash.clone());
        self.insert_new(entry.clone());
        RecordOutcome { entry: Some(entry), deduped: false, hash }
    }

    // 置顶开关：置顶 → 刷新 pinnedAt 并移到置顶块最前；取消置顶 → 回到普通块最前（pinnedAt 保留）
    pub fn toggle_pin(&mut self, id: &str) -> bool {
        let Some(idx) = self.entries.iter().position(|e| e.id == id) else { return false };
        let mut entry = self.entries.remove(idx);
        if entry.pinned {
            entry.pinned = false;
            self.insert_at_normal_front(entry);
        } else {
            entry.pinned = true;
            entry.pinned_at = (self.now_fn)();
            self.entries.insert(0, entry);
        }
        true
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let Some(idx) = self.entries.iter().position(|e| e.id == id) else { return false };
        let removed = self.entries.remove(idx);
        self.drop_image_file(&removed);
        true
    }

    pub fn clear(&mut self) {
        let entries = std::mem::take(&mut self.entries);
        for entry in &entries {
            self.drop_image_file(entry);
        }
    }

    // 空字符串等同删除备注；保存时去首尾空白、截断到上限
    pub fn set_note(&mut self, id: &str, note: &str) -> bool {
        let normalized = self.normalize_note(note);
        let Some(entry) = self.entries.iter_mut().find(|e| e.id == id) else { return false };
        entry.note = normalized;
        true
    }

    // 持久化投影：entry 结构体的 serde 序列化即投影（text/imagePath 按类型互斥省略，
    // 与既有 clipboard-history.json 的 schema 兼容，键名契约见 ADR-0007）。
    pub fn to_json(&self) -> Vec<Entry> {
        self.entries.clone()
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用
    use super::*;
    use std::sync::Mutex;
    type RemovedLog = Arc<Mutex<Vec<String>>>;

    fn make_store(max: usize, overrides: StoreOverrides) -> (HistoryStore, RemovedLog) {
        let removed: RemovedLog = Arc::new(Mutex::new(Vec::new()));
        let ports = Ports::fake(&removed, overrides.save, overrides.hash, overrides.exists);
        (HistoryStore::new(max, ports, overrides.clock), removed)
    }

    #[derive(Default)]
    struct StoreOverrides {
        clock: Clock,
        save: Option<SaveImagePngFn>,
        hash: Option<HashImageFileFn>,
        exists: Option<ImageFileExistsFn>,
    }

    /// 测试 adapter 的缺省形状：写盘恒成功（路径 `/images/{id}.png`）、哈希恒空（图片去重因此
    /// 默认不命中）、文件恒存在、删文件记进日志。三个 `Option` 参数只是「把某一条换成别的形状」。
    impl Ports {
        fn fake(
            removed: &RemovedLog,
            save: Option<SaveImagePngFn>,
            hash: Option<HashImageFileFn>,
            exists: Option<ImageFileExistsFn>,
        ) -> Self {
            let removed = removed.clone();
            Self {
                save_image_png: save
                    .unwrap_or_else(|| Arc::new(|_png, id| Some(format!("/images/{id}.png")))),
                hash_image_file: hash.unwrap_or_else(|| Arc::new(|_p| String::new())),
                remove_image_file: Arc::new(move |p| removed.lock().unwrap().push(p.to_string())),
                image_file_exists: exists.unwrap_or_else(|| Arc::new(|_p| true)),
            }
        }
    }

    // 时间步进时钟：每次 now() 前进 10ms，让 pinnedAt/createdAt 严格可辨
    fn stepping_clock() -> Clock {
        let t = Arc::new(std::sync::atomic::AtomicU64::new(1000));
        Clock {
            now: Arc::new(move || t.fetch_add(10, std::sync::atomic::Ordering::SeqCst) + 10),
            ..Default::default()
        }
    }

    fn texts(store: &HistoryStore) -> Vec<String> {
        store
            .entries()
            .iter()
            .map(|e| match e.entry_type {
                EntryType::Text => e.text.clone().unwrap_or_default(),
                EntryType::Image => "<img>".to_string(),
            })
            .collect()
    }

    fn ids(store: &HistoryStore) -> Vec<String> {
        store.entries().iter().map(|e| e.id.clone()).collect()
    }

    fn record_text(store: &mut HistoryStore, text: &str) -> Entry {
        store.record_text(text, None).entry.unwrap()
    }

    #[test]
    fn 新文本条目插到最前() {
        let (mut store, _) = make_store(200, Default::default());
        record_text(&mut store, "a");
        record_text(&mut store, "b");
        assert_eq!(texts(&store), vec!["b", "a"]);
    }

    #[test]
    fn 同文本去重_提升已有条目且属性不变_不新建() {
        let (mut store, _) = make_store(200, Default::default());
        let first = store.record_text("hello", Some(SourceApp { app_name: "notes".into(), ..Default::default() })).entry.unwrap();
        store.set_note(&first.id, "备注1");
        record_text(&mut store, "world");
        record_text(&mut store, "other");
        let out = store.record_text("hello", None);
        assert!(out.deduped);
        assert_eq!(out.entry.as_ref().unwrap().id, first.id); // 同一条目，不是新建
        assert_eq!(store.len(), 3);
        assert_eq!(texts(&store), vec!["hello", "other", "world"]);
        assert_eq!(out.entry.as_ref().unwrap().note, "备注1"); // 备注/来源/创建时间保持不变
        assert_eq!(out.entry.as_ref().unwrap().created_at, first.created_at);
    }

    #[test]
    fn 新内容插在置顶块之后_普通块最前() {
        let (mut store, _) = make_store(200, Default::default());
        let a = record_text(&mut store, "a");
        record_text(&mut store, "b");
        store.toggle_pin(&a.id); // a 置顶
        record_text(&mut store, "c");
        assert_eq!(texts(&store), vec!["a", "c", "b"]);
        assert!(store.entries()[0].pinned);
    }

    #[test]
    fn 置顶条目去重命中_刷新pinnedAt并移到置顶块最前() {
        let (mut store, _) = make_store(200, StoreOverrides { clock: stepping_clock(), ..Default::default() });
        let a = record_text(&mut store, "a");
        let b = record_text(&mut store, "b");
        store.toggle_pin(&a.id);
        store.toggle_pin(&b.id);
        assert_eq!(texts(&store), vec!["b", "a"]); // b 后置顶在前
        let pinned_at_before = store.find(&a.id).unwrap().pinned_at;
        let out = store.record_text("a", None);
        assert!(out.deduped);
        assert_eq!(store.entries()[0].text.as_deref(), Some("a")); // 提到置顶块最前
        assert!(store.find(&a.id).unwrap().pinned_at > pinned_at_before); // pinnedAt 刷新
    }

    #[test]
    fn togglePin_置顶刷新pinnedAt移到块首_取消置顶回到普通块最前() {
        let (mut store, _) = make_store(200, StoreOverrides { clock: stepping_clock(), ..Default::default() });
        let a = record_text(&mut store, "a");
        record_text(&mut store, "b");
        record_text(&mut store, "c");
        assert!(store.toggle_pin(&a.id));
        assert_eq!(texts(&store), vec!["a", "c", "b"]);
        assert!(store.find(&a.id).unwrap().pinned);
        assert!(store.toggle_pin(&a.id)); // 取消置顶
        assert!(!store.find(&a.id).unwrap().pinned);
        assert_eq!(texts(&store), vec!["a", "c", "b"]); // 回到普通块最前
        assert!(!store.toggle_pin("missing"));
    }

    #[test]
    fn 裁剪_置顶豁免_先裁普通块尾部() {
        let (mut store, _) = make_store(3, Default::default());
        record_text(&mut store, "a");
        record_text(&mut store, "b");
        record_text(&mut store, "c");
        record_text(&mut store, "d"); // 裁掉普通块最旧 a → [d,c,b]
        assert_eq!(texts(&store), vec!["d", "c", "b"]);
        let front_id = store.entries()[0].id.clone();
        store.toggle_pin(&front_id); // 置顶 d → 置顶块 [d]
        record_text(&mut store, "e"); // [d,e,c,b] → 裁普通尾部 b → [d,e,c]
        assert_eq!(texts(&store), vec!["d", "e", "c"]);
    }

    #[test]
    fn 全部置顶时裁最旧置顶_经load触发() {
        let (mut store, _) = make_store(3, Default::default());
        store.load(Some(vec![
            serde_json::json!({ "id": "1", "type": "text", "text": "t1", "pinned": true, "pinnedAt": 100 }),
            serde_json::json!({ "id": "2", "type": "text", "text": "t2", "pinned": true, "pinnedAt": 400 }),
            serde_json::json!({ "id": "3", "type": "text", "text": "t3", "pinned": true, "pinnedAt": 300 }),
            serde_json::json!({ "id": "4", "type": "text", "text": "t4", "pinned": true, "pinnedAt": 200 }),
        ]));
        // 排序 [2,3,4,1] → 裁最旧置顶 1
        assert_eq!(ids(&store), vec!["2", "3", "4"]);
    }

    #[test]
    fn remove图片条目_删内存加删文件_clear清全部() {
        let (mut store, removed) = make_store(200, Default::default());
        let img = store.record_image(b"png1", None).entry.unwrap();
        record_text(&mut store, "t"); // 文本条目无文件
        let img_path = img.image_path.clone().unwrap();
        assert!(store.remove(&img.id));
        assert_eq!(*removed.lock().unwrap(), vec![img_path.clone()]);
        assert!(!store.remove(&img.id));
        store.clear();
        assert_eq!(*removed.lock().unwrap(), vec![img_path]);
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn recordImage身份按PNGsha1_命中提升_不写新文件() {
        let (mut store, _) = make_store(200, Default::default());
        let first = store.record_image(b"same-png", None).entry.unwrap();
        let out = store.record_image(b"same-png", None);
        assert!(out.deduped);
        assert_eq!(out.entry.as_ref().unwrap().id, first.id);
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn recordImage写盘失败_不插入条目() {
        let (mut store, _) = make_store(
            200,
            StoreOverrides { save: Some(Arc::new(|_png, _id| None)), ..Default::default() },
        );
        let out = store.record_image(b"x", None);
        assert!(out.entry.is_none());
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn matchImageHash用注入的hashImageFile识别历史里的图片() {
        let (mut store, _) = make_store(
            200,
            StoreOverrides { hash: Some(Arc::new(|_p| "abc123".to_string())), ..Default::default() },
        );
        store.load(Some(vec![serde_json::json!({ "id": "1", "type": "image", "imagePath": "/images/1.png" })]));
        let idx = store.match_image_hash("abc123");
        assert_eq!(idx.map(|i| store.entries()[i].id.clone()), Some("1".to_string()));
        assert!(store.match_image_hash("other").is_none());
        assert!(store.match_image_hash("").is_none());
    }

    #[test]
    fn 载入归一化_缺省字段_丢文件图片被过滤() {
        let (mut store, _) = make_store(
            200,
            StoreOverrides {
                exists: Some(Arc::new(|p| p != "/images/lost.png")),
                ..Default::default()
            },
        );
        store.load(Some(vec![
            serde_json::json!({ "id": "1", "type": "text", "text": "plain" }),
            serde_json::json!({ "id": "2", "type": "image", "imagePath": "/images/ok.png", "pinned": true, "pinnedAt": 100 }),
            serde_json::json!({ "id": "3", "type": "image", "imagePath": "/images/lost.png" }),
            serde_json::json!({ "id": "4", "type": "text", "text": "pinned", "pinned": true, "pinnedAt": 200 }),
            serde_json::json!({ "id": "5", "type": "weird" }),
            serde_json::Value::Null,
        ]));
        assert_eq!(ids(&store), vec!["4", "2", "1"]);
        let plain = store.find("1").unwrap();
        assert!(!plain.pinned);
        assert_eq!(plain.pinned_at, 0);
        assert_eq!(plain.note, "");
    }

    #[test]
    fn 载入时置顶块按pinnedAt新旧_与载入顺序无关() {
        let (mut store, _) = make_store(200, Default::default());
        store.load(Some(vec![
            serde_json::json!({ "id": "1", "type": "text", "text": "older-pin", "pinned": true, "pinnedAt": 100 }),
            serde_json::json!({ "id": "2", "type": "text", "text": "newer-pin", "pinned": true, "pinnedAt": 300 }),
            serde_json::json!({ "id": "3", "type": "text", "text": "mid-pin", "pinned": true, "pinnedAt": 200 }),
        ]));
        assert_eq!(ids(&store), vec!["2", "3", "1"]);
    }

    #[test]
    fn setNote_去首尾空白_截断200_空串等同删除() {
        let (mut store, _) = make_store(200, Default::default());
        let entry = record_text(&mut store, "t");
        assert!(store.set_note(&entry.id, "  你好  "));
        assert_eq!(store.find(&entry.id).unwrap().note, "你好");
        let long = format!("{} ", "x".repeat(250));
        store.set_note(&entry.id, &long);
        assert_eq!(store.find(&entry.id).unwrap().note, "x".repeat(200));
        assert!(store.set_note(&entry.id, "   "));
        assert_eq!(store.find(&entry.id).unwrap().note, "");
        assert!(!store.set_note("missing", "n"));
    }

    #[test]
    fn 序列化只投影已知字段() {
        // 存档对文本条目只投影 { id, type, text, createdAt, sourceApp, pinned,
        // pinnedAt, note }（imagePath 仅图片条目持有）；serde 的 skip_serializing_if 保证这一点。
        let (mut store, _) = make_store(200, Default::default());
        let entry = store.record_text("t", Some(SourceApp { app_name: "app".into(), ..Default::default() })).entry.unwrap();
        {
            let e = store.entries.iter_mut().find(|e| e.id == entry.id).unwrap();
            e.pinned = true;
            e.pinned_at = 5;
        }
        let json = serde_json::to_value(&store.to_json()[0]).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["createdAt", "id", "note", "pinned", "pinnedAt", "sourceApp", "text", "type"]);
        assert_eq!(json["pinned"], serde_json::json!(true));
    }
}
