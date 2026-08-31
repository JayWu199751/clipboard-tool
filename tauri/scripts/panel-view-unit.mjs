// 面板视图规则单测：直测 src/panelView.ts 的 interface，零框架、零 mock。
// 运行：npm run test:view（Node >= 22.18 原生剥离 TS 类型）

import {
  filterEntries,
  highlight,
  spansToText,
  clampIndex,
  moveIndex,
  entryAt,
} from '../src/panelView.ts';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, message: err?.message ?? String(err) });
    console.log(`  FAIL ${name}`);
  }
}

function assert(cond, hint) {
  if (!cond) throw new Error(hint ?? 'assertion failed');
}

function eq(actual, expected, hint = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${hint} expected ${e}, got ${a}`);
}

function entry(id, over = {}) {
  return {
    id,
    type: 'text',
    text: '',
    createdAt: 0,
    sourceApp: null,
    pinned: false,
    pinnedAt: 0,
    note: '',
    ...over,
  };
}

const ids = (list) => list.map((e) => e.id);
const hits = (spans) => spans.filter((s) => s.hit).map((s) => s.text);

// ---------- 过滤 ----------

test('空查询与全空白查询返回完整列表_顺序不变', () => {
  const list = [entry('a'), entry('b'), entry('c')];
  eq(ids(filterEntries(list, '')), ['a', 'b', 'c']);
  eq(ids(filterEntries(list, '   ')), ['a', 'b', 'c']);
});

test('大小写不敏感匹配正文', () => {
  const list = [entry('a', { text: 'Hello World' }), entry('b', { text: 'other' })];
  eq(ids(filterEntries(list, 'hello')), ['a']);
  eq(ids(filterEntries(list, 'WORLD')), ['a']);
});

test('空格分词多词 AND_顺序无关', () => {
  const list = [entry('a', { text: 'alpha beta' }), entry('b', { text: 'alpha gamma' })];
  eq(ids(filterEntries(list, 'beta alpha')), ['a']);
  eq(ids(filterEntries(list, 'alpha')), ['a', 'b']);
});

test('备注与来源应用三字段都参与匹配', () => {
  const list = [
    entry('note', { note: '季度复盘' }),
    entry('app', { sourceApp: { exePath: 'C:\\x\\chrome.exe', appName: 'chrome', windowTitle: 'T', iconDataUrl: null } }),
    entry('title', { sourceApp: { exePath: 'C:\\y\\e.exe', appName: 'e', windowTitle: '需求评审', iconDataUrl: null } }),
    entry('exe', { sourceApp: { exePath: 'C:\\z\\figma.exe', appName: 'figma', windowTitle: '', iconDataUrl: null } }),
  ];
  eq(ids(filterEntries(list, '季度复盘')), ['note']);
  eq(ids(filterEntries(list, 'chrome')), ['app']);
  eq(ids(filterEntries(list, '需求评审')), ['title']);
  eq(ids(filterEntries(list, 'figma.exe')), ['exe']);
});

test('图片条目无正文_可靠备注与来源命中', () => {
  const list = [
    entry('img', { type: 'image', dataUrl: 'data:image/png;base64,AAA', text: undefined }),
    entry('txt', { text: '截图' }),
  ];
  eq(ids(filterEntries(list, '截图')), ['txt']);
  const withNote = [entry('img', { type: 'image', note: '设计稿截图', dataUrl: 'x' })];
  eq(ids(filterEntries(withNote, '设计稿')), ['img']);
});

test('结果保持原始顺序_不做匹配度排序', () => {
  const list = [entry('a', { text: 'x y' }), entry('b', { text: 'y' }), entry('c', { text: 'y x' })];
  eq(ids(filterEntries(list, 'y')), ['a', 'b', 'c']);
});

test('无匹配返回空列表', () => {
  eq(ids(filterEntries([entry('a', { text: 'abc' })], 'zzz')), []);
});

// ---------- 高亮 ----------

test('空查询不产生任何命中片段', () => {
  const spans = highlight('Hello', '  ');
  eq(hits(spans), []);
  eq(spansToText(spans), 'Hello');
});

test('命中片段被标记且拼接后与原文完全一致', () => {
  const text = 'aBc-def-aBc';
  const spans = highlight(text, 'abc');
  eq(hits(spans), ['aBc', 'aBc']);
  eq(spansToText(spans), text);
});

test('多词分别高亮_已命中片段不被后续词二次切分', () => {
  const text = 'alpha beta alpha';
  const spans = highlight(text, 'alpha beta');
  eq(hits(spans), ['alpha', 'beta', 'alpha']);
  eq(spansToText(spans), text);
});

test('无匹配时整段作为未命中返回', () => {
  const spans = highlight('hello', 'zz');
  eq(hits(spans), []);
  eq(spansToText(spans), 'hello');
});

// ---------- 选中项 ----------

test('clampIndex_空列表归零_越界与负值拉回有效范围', () => {
  eq(clampIndex(3, 0), 0);
  eq(clampIndex(5, 3), 2);
  eq(clampIndex(-2, 3), 0);
  eq(clampIndex(1, 3), 1);
});

test('moveIndex_首尾按方向不越界', () => {
  eq(moveIndex(0, 3, 'up'), 0);
  eq(moveIndex(2, 3, 'down'), 2);
  eq(moveIndex(1, 3, 'up'), 0);
  eq(moveIndex(1, 3, 'down'), 2);
  eq(moveIndex(0, 0, 'down'), 0);
});

test('entryAt_越界与空列表返回 null_不抛异常', () => {
  const list = [entry('a'), entry('b')];
  eq(entryAt(list, 0)?.id, 'a');
  eq(entryAt(list, 9), null);
  eq(entryAt(list, -1), null);
  eq(entryAt([], 0), null);
});

console.log(`\npanelView: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
