// 「历史」领域核心：条目身份、去重提升、置顶块排序、上限裁剪、备注。
// 纯内存 module：不依赖 electron，可在 plain node 下按 interface 直接测试。
// 文件系统效果经注入端口进入（saveImagePng / hashImageFile / removeImageFile / imageFileExists）；
// 持久化与 broadcast 由调用方（main.js）完成，不属于本 module。
// 领域规则出处：CONTEXT.md「条目身份与去重」「置顶功能」「备注功能」决策档案。

const crypto = require('crypto');

const DEFAULT_MAX_HISTORY = 200;
const DEFAULT_MAX_NOTE_LENGTH = 200;

function sha1Hex(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function createHistoryStore({
  max = DEFAULT_MAX_HISTORY,
  maxNoteLength = DEFAULT_MAX_NOTE_LENGTH,
  now = () => Date.now(),
  makeId = () => crypto.randomUUID(),
  // (png: Buffer, id: string) => imagePath | null：把新图片写盘，失败返回 null
  saveImagePng = null,
  // (imagePath: string) => sha1hex | ''：读盘计算内容哈希（缺失/损坏返回 ''）
  hashImageFile = null,
  // (imagePath: string) => void：删除图片文件
  removeImageFile = null,
  // (imagePath: string) => boolean：载入时过滤已丢失文件的图片条目；未注入则视为都存在
  imageFileExists = null,
} = {}) {
  let entries = [];
  // 图片内容哈希缓存：entry.id -> sha1（图片文件创建后不会变化）
  const imageHashCache = new Map();

  function normalizeNote(note) {
    return typeof note === 'string' ? note.trim().slice(0, maxNoteLength) : '';
  }

  function find(id) {
    return entries.find((e) => e.id === id);
  }

  function matchText(text) {
    return entries.find((e) => e.type === 'text' && e.text === text) || null;
  }

  function imageHashFor(entry) {
    if (!entry || entry.type !== 'image' || !entry.imagePath) return '';
    let hash = imageHashCache.get(entry.id);
    if (hash === undefined) {
      hash = hashImageFile ? hashImageFile(entry.imagePath) : '';
      imageHashCache.set(entry.id, hash);
    }
    return hash;
  }

  function matchImageHash(hash) {
    if (!hash) return null;
    return entries.find((e) => e.type === 'image' && imageHashFor(e) === hash) || null;
  }

  function pinnedCount() {
    let n = 0;
    while (n < entries.length && entries[n].pinned) n += 1;
    return n;
  }

  // 普通块最前 = 置顶块之后第一个位置
  function insertAtNormalFront(entry) {
    entries.splice(pinnedCount(), 0, entry);
  }

  // 排序规则：置顶条目固定在最前（按置顶时间新→旧），之后按原数组顺序（即最近使用新→旧）。
  function sort() {
    const pinned = entries.filter((e) => e.pinned).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
    entries = pinned.concat(entries.filter((e) => !e.pinned));
  }

  function dropImageFile(entry) {
    imageHashCache.delete(entry.id);
    if (entry.type === 'image' && entry.imagePath && removeImageFile) removeImageFile(entry.imagePath);
  }

  // 历史上限裁剪：置顶条目豁免，先裁普通块尾部；全部置顶时才裁最旧的置顶条目。
  function trim() {
    while (entries.length > max) {
      let idx = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (!entries[i].pinned) { idx = i; break; }
      }
      if (idx === -1) idx = entries.length - 1;
      const [removed] = entries.splice(idx, 1);
      dropImageFile(removed);
    }
  }

  // 把已有条目提升为"最近使用"：普通条目移到普通块最前；置顶条目刷新 pinnedAt 并移到置顶块最前。
  // 备注/来源/创建时间等属性保持不变。
  function promote(entry) {
    const idx = entries.indexOf(entry);
    if (idx !== -1) entries.splice(idx, 1);
    if (entry.pinned) {
      entry.pinnedAt = now();
      entries.unshift(entry);
    } else {
      insertAtNormalFront(entry);
    }
  }

  function insertNew(entry) {
    // 新内容永远插在置顶块之后、普通块最前
    insertAtNormalFront(entry);
    trim();
  }

  return {
    // 从历史 JSON 载入：过滤无效/丢文件条目、归一化旧数据字段（pinned/pinnedAt/note 缺省）、排序、裁剪
    load(rawEntries) {
      imageHashCache.clear();
      let list = Array.isArray(rawEntries) ? rawEntries.filter((e) => e && e.id) : [];
      list = list.filter((e) => {
        if (e.type === 'image') return !!e.imagePath && (!imageFileExists || imageFileExists(e.imagePath));
        return e.type === 'text';
      });
      entries = list.map((e) => ({
        ...e,
        pinned: !!e.pinned,
        pinnedAt: e.pinnedAt || 0,
        note: normalizeNote(e.note),
      }));
      sort();
      trim();
    },

    entries() {
      return entries;
    },

    find,

    matchText,
    matchImageHash,

    normalizeNote,

    // 文本复制进历史：身份命中（全文逐字符相等）→ 提升且属性不变；否则新建并裁剪
    recordText(text, sourceApp) {
      if (!text) return { entry: null, deduped: false };
      const existing = matchText(text);
      if (existing) {
        promote(existing);
        return { entry: existing, deduped: true };
      }
      const entry = { id: makeId(), type: 'text', text, createdAt: now(), sourceApp: sourceApp || null, pinned: false, pinnedAt: 0, note: '' };
      insertNew(entry);
      return { entry, deduped: false };
    },

    // 图片复制进历史：身份按 PNG 内容 sha1。命中 → 提升且不写新文件；未命中 → 经 saveImagePng 写盘后插入。
    // 写盘失败返回 { entry: null }，调用方不应更新轮询基线（下次轮询重试）。
    recordImage(png, sourceApp) {
      if (!png || png.length === 0) return { entry: null, deduped: false };
      const hash = sha1Hex(png);
      const existing = matchImageHash(hash);
      if (existing) {
        promote(existing);
        return { entry: existing, deduped: true, hash };
      }
      const id = makeId();
      const imagePath = saveImagePng ? saveImagePng(png, id) : null;
      if (!imagePath) return { entry: null, deduped: false, hash };
      const entry = { id, type: 'image', imagePath, createdAt: now(), sourceApp: sourceApp || null, pinned: false, pinnedAt: 0, note: '' };
      imageHashCache.set(id, hash);
      insertNew(entry);
      return { entry, deduped: false, hash };
    },

    // 复制已有条目后的落位（与去重提升同一规则）
    promote,

    // 置顶开关：置顶 → 刷新 pinnedAt 并移到置顶块最前；取消置顶 → 回到普通块最前（pinnedAt 保留）
    togglePin(id) {
      const entry = find(id);
      if (!entry) return false;
      const idx = entries.indexOf(entry);
      entries.splice(idx, 1);
      if (entry.pinned) {
        entry.pinned = false;
        insertAtNormalFront(entry);
      } else {
        entry.pinned = true;
        entry.pinnedAt = now();
        entries.unshift(entry);
      }
      return true;
    },

    remove(id) {
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) return false;
      const [removed] = entries.splice(idx, 1);
      dropImageFile(removed);
      return true;
    },

    clear() {
      for (const entry of entries) dropImageFile(entry);
      entries = [];
    },

    // 空字符串等同删除备注；保存时去首尾空白、截断到上限
    setNote(id, note) {
      const entry = find(id);
      if (!entry) return false;
      entry.note = normalizeNote(note);
      return true;
    },

    // 持久化投影：只保留已知字段并归一化（废弃字段不写回）
    toJSON() {
      return entries.map(({ id, type, text, imagePath, createdAt, sourceApp, pinned, pinnedAt, note }) => ({
        id, type, text, imagePath, createdAt, sourceApp, pinned: !!pinned, pinnedAt: pinnedAt || 0, note: normalizeNote(note),
      }));
    },
  };
}

module.exports = { createHistoryStore, sha1Hex, DEFAULT_MAX_HISTORY, DEFAULT_MAX_NOTE_LENGTH };
