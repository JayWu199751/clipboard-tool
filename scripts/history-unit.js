// 「历史」领域核心单元测试：直接测 electron/history.js 的 interface，不需要 Electron mock。
// 覆盖 CONTEXT.md「条目身份与去重」「置顶功能」「备注功能」的全部领域规则。
const assert = require('assert');
const { createHistoryStore } = require('../electron/history');

let removedFiles = [];
function makeStore(overrides = {}) {
  removedFiles = [];
  return createHistoryStore({
    max: 200,
    saveImagePng: (png, id) => `/images/${id}.png`,
    hashImageFile: () => '',
    removeImageFile: (p) => removedFiles.push(p),
    ...overrides,
  });
}

// 时间步进时钟：每次 now() 前进 10ms，让 pinnedAt/createdAt 严格可辨
function steppingClock(start = 1000) {
  let t = start;
  return () => (t += 10);
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('新文本条目插到最前', () => {
  const store = makeStore();
  store.recordText('a');
  store.recordText('b');
  assert.deepStrictEqual(store.entries().map((e) => e.text), ['b', 'a']);
});

test('同文本去重：提升已有条目且属性不变，不新建', () => {
  const store = makeStore();
  const first = store.recordText('hello', { appName: 'notes' }).entry;
  store.setNote(first.id, '备注1');
  store.recordText('world');
  store.recordText('other');
  const { entry, deduped } = store.recordText('hello');
  assert.strictEqual(deduped, true);
  assert.strictEqual(entry, first); // 同一条目对象，不是新建
  assert.strictEqual(store.entries().length, 3);
  assert.deepStrictEqual(store.entries().map((e) => e.text), ['hello', 'other', 'world']);
  assert.strictEqual(entry.note, '备注1'); // 备注/来源/创建时间保持不变
  assert.strictEqual(entry.createdAt, first.createdAt);
});

test('新内容插在置顶块之后、普通块最前', () => {
  const store = makeStore();
  const a = store.recordText('a').entry;
  store.recordText('b');
  store.togglePin(a.id); // a 置顶
  store.recordText('c');
  assert.deepStrictEqual(store.entries().map((e) => e.text), ['a', 'c', 'b']);
  assert.strictEqual(store.entries()[0].pinned, true);
});

test('置顶条目去重命中：刷新 pinnedAt 并移到置顶块最前', () => {
  const store = makeStore({ now: steppingClock() });
  const a = store.recordText('a').entry;
  const b = store.recordText('b').entry;
  store.togglePin(a.id);
  store.togglePin(b.id);
  assert.deepStrictEqual(store.entries().map((e) => e.text), ['b', 'a']); // b 后置顶在前
  const pinnedAtBefore = a.pinnedAt;
  const { deduped } = store.recordText('a');
  assert.strictEqual(deduped, true);
  assert.strictEqual(store.entries()[0].text, 'a'); // 提到置顶块最前
  assert.ok(a.pinnedAt > pinnedAtBefore); // pinnedAt 刷新
});

test('togglePin：置顶刷新 pinnedAt 移到块首；取消置顶回到普通块最前', () => {
  const store = makeStore({ now: steppingClock() });
  const a = store.recordText('a').entry;
  store.recordText('b');
  store.recordText('c');
  assert.ok(store.togglePin(a.id));
  assert.deepStrictEqual(store.entries().map((e) => e.text), ['a', 'c', 'b']);
  assert.strictEqual(a.pinned, true);
  assert.ok(store.togglePin(a.id)); // 取消置顶
  assert.strictEqual(a.pinned, false);
  assert.deepStrictEqual(store.entries().map((e) => e.text), ['a', 'c', 'b']); // 回到普通块最前
  assert.strictEqual(store.togglePin('missing'), false);
});

test('裁剪：置顶豁免，先裁普通块尾部', () => {
  const store = makeStore({ max: 3 });
  store.recordText('a');
  store.recordText('b');
  store.recordText('c');
  store.recordText('d'); // 裁掉普通块最旧 a → [d,c,b]
  assert.deepStrictEqual(store.entries().map((e) => e.text), ['d', 'c', 'b']);
  store.togglePin(store.entries()[0].id); // 置顶 d → 置顶块 [d]
  store.recordText('e'); // [d,e,c,b] → 裁普通尾部 b → [d,e,c]
  assert.deepStrictEqual(store.entries().map((e) => e.text), ['d', 'e', 'c']);
});

test('全部置顶时裁最旧置顶（经 load 触发）', () => {
  const store = makeStore({ max: 3 });
  store.load([
    { id: '1', type: 'text', text: 't1', pinned: true, pinnedAt: 100 },
    { id: '2', type: 'text', text: 't2', pinned: true, pinnedAt: 400 },
    { id: '3', type: 'text', text: 't3', pinned: true, pinnedAt: 300 },
    { id: '4', type: 'text', text: 't4', pinned: true, pinnedAt: 200 },
  ]);
  // 排序 [2,3,4,1] → 裁最旧置顶 1
  assert.deepStrictEqual(store.entries().map((e) => e.id), ['2', '3', '4']);
});

test('remove 图片条目：删内存 + 删文件；clear 清全部', () => {
  const store = makeStore();
  const img = store.recordImage(Buffer.from('png1')).entry;
  store.recordText('t'); // 文本条目无文件
  assert.ok(store.remove(img.id));
  assert.deepStrictEqual(removedFiles, [img.imagePath]);
  assert.strictEqual(store.remove(img.id), false);
  store.clear();
  assert.deepStrictEqual(removedFiles, [img.imagePath]);
  assert.strictEqual(store.entries().length, 0);
});

test('recordImage 身份按 PNG sha1：命中提升，不写新文件', () => {
  const store = makeStore();
  const first = store.recordImage(Buffer.from('same-png')).entry;
  const { entry, deduped } = store.recordImage(Buffer.from('same-png'));
  assert.strictEqual(deduped, true);
  assert.strictEqual(entry, first);
  assert.strictEqual(store.entries().length, 1);
});

test('recordImage 写盘失败：不插入条目（调用方保持轮询基线，下次重试）', () => {
  const store = makeStore({ saveImagePng: () => null });
  const { entry } = store.recordImage(Buffer.from('x'));
  assert.strictEqual(entry, null);
  assert.strictEqual(store.entries().length, 0);
});

test('matchImageHash 用注入的 hashImageFile 识别历史里的图片', () => {
  const store = makeStore({ hashImageFile: () => 'abc123' });
  store.load([{ id: '1', type: 'image', imagePath: '/images/1.png' }]);
  assert.strictEqual(store.matchImageHash('abc123'), store.find('1'));
  assert.strictEqual(store.matchImageHash('other'), null);
  assert.strictEqual(store.matchImageHash(''), null);
});

test('载入归一化：缺省 pinned/pinnedAt/note、丢文件图片被过滤', () => {
  const store = makeStore({ imageFileExists: (p) => p !== '/images/lost.png' });
  store.load([
    { id: '1', type: 'text', text: 'plain' },
    { id: '2', type: 'image', imagePath: '/images/ok.png', pinned: true, pinnedAt: 100 },
    { id: '3', type: 'image', imagePath: '/images/lost.png' },
    { id: '4', type: 'text', text: 'pinned', pinned: true, pinnedAt: 200 },
    { id: '5', type: 'weird' },
    null,
  ]);
  assert.deepStrictEqual(store.entries().map((e) => e.id), ['4', '2', '1']);
  const plain = store.find('1');
  assert.strictEqual(plain.pinned, false);
  assert.strictEqual(plain.pinnedAt, 0);
  assert.strictEqual(plain.note, '');
});

test('载入时置顶块按 pinnedAt 新→旧（与载入顺序无关）', () => {
  const store = makeStore();
  store.load([
    { id: '1', type: 'text', text: 'older-pin', pinned: true, pinnedAt: 100 },
    { id: '2', type: 'text', text: 'newer-pin', pinned: true, pinnedAt: 300 },
    { id: '3', type: 'text', text: 'mid-pin', pinned: true, pinnedAt: 200 },
  ]);
  assert.deepStrictEqual(store.entries().map((e) => e.id), ['2', '3', '1']);
});

test('setNote：去首尾空白、截断 200、空串等同删除', () => {
  const store = makeStore();
  const { entry } = store.recordText('t');
  assert.strictEqual(store.setNote(entry.id, '  你好  '), true);
  assert.strictEqual(entry.note, '你好');
  store.setNote(entry.id, `${'x'.repeat(250)} `);
  assert.strictEqual(entry.note, 'x'.repeat(200));
  assert.strictEqual(store.setNote(entry.id, '   '), true);
  assert.strictEqual(entry.note, '');
  assert.strictEqual(store.setNote('missing', 'n'), false);
});

test('toJSON 只投影已知字段并归一化', () => {
  const store = makeStore();
  const { entry } = store.recordText('t', { appName: 'app' });
  entry.pinned = true;
  entry.pinnedAt = 5;
  const [json] = store.toJSON();
  assert.deepStrictEqual(
    Object.keys(json).sort(),
    ['createdAt', 'id', 'imagePath', 'note', 'pinned', 'pinnedAt', 'sourceApp', 'text', 'type']
  );
  assert.strictEqual(json.pinned, true);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok - ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL: ${name}`);
      console.error(`  ${err.message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log(`PASS: ${tests.length} history-core unit tests.`);
})();
