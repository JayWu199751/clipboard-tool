// 渲染层规则单测：直测视图、键盘、延迟删除与主题同步的 module interface，零框架、零 mock。
// 运行：npm run test:view（Node >= 22.18 原生剥离 TS 类型）
// 末尾的跨语言对表把 keyboard.ts 的 NAV_KEYS 钉在 Rust panel_modes.rs 的 NAV_SHORTCUTS 上——
// HUD 迁移后页脚 chip「由真实键位表生成」的约束靠这条测试在 CI 里成立，不靠自觉。

import { readFileSync } from 'node:fs';
import {
  accelKeyFromCode,
  clampIndex,
  entryAt,
  filterEntries,
  formatTime,
  highlight,
  moveIndex,
  scrollbarThumb,
  shouldIgnoreMouse,
  spansToText,
  themeControl,
} from '../src/panelView.ts';
import { NAV_KEYS, accelToKeyId, buildBindings, chipLabel, combo, footerChips } from '../src/keyboard.ts';
import { transitionDeletion } from '../src/pendingDeletion.ts';
import { ThemeSynchronizer } from '../src/themeSync.ts';

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

// ---------- 圆角外穿透 ----------

// 面板窗口的实际尺寸（418×823 CSS 像素）；圆角由调用方从样式表读出传入（现值 28px），
// 这里取 20 只测几何判定本身与半径参数化的形状
const PANEL = { left: 0, top: 0, right: 418, bottom: 823 };
const R = 20;

test('穿透_矩形四边之外一律穿透', () => {
  assert(shouldIgnoreMouse(-1, 400, PANEL, R));
  assert(shouldIgnoreMouse(419, 400, PANEL, R));
  assert(shouldIgnoreMouse(200, -1, PANEL, R));
  assert(shouldIgnoreMouse(200, 824, PANEL, R));
});

test('穿透_直边带内不穿透_贴边点算窗口内', () => {
  assert(!shouldIgnoreMouse(209, 1, PANEL, R));
  assert(!shouldIgnoreMouse(1, 400, PANEL, R));
  assert(!shouldIgnoreMouse(417, 400, PANEL, R));
  assert(!shouldIgnoreMouse(209, 823, PANEL, R));
});

test('穿透_四角弧内保留_弧外穿透', () => {
  // 左上圆心 (20,20)：(6,6) 距心 ≈19.8 保留，(5,5) 距心 ≈21.2 穿透
  assert(!shouldIgnoreMouse(6, 6, PANEL, R));
  assert(shouldIgnoreMouse(5, 5, PANEL, R));
  // 右上圆心 (398,20)
  assert(!shouldIgnoreMouse(410, 5, PANEL, R));
  assert(shouldIgnoreMouse(413, 5, PANEL, R));
  // 左下圆心 (20,803)
  assert(!shouldIgnoreMouse(6, 817, PANEL, R));
  assert(shouldIgnoreMouse(5, 818, PANEL, R));
  // 右下圆心 (398,803)
  assert(!shouldIgnoreMouse(412, 817, PANEL, R));
  assert(shouldIgnoreMouse(413, 818, PANEL, R));
});

test('穿透_只有单轴进角带时不判弧', () => {
  assert(!shouldIgnoreMouse(5, 400, PANEL, R)); // 靠左缘但纵向居中
  assert(!shouldIgnoreMouse(200, 5, PANEL, R)); // 靠顶缘但横向居中
});

test('穿透_半径为零时只按矩形判定', () => {
  assert(!shouldIgnoreMouse(1, 1, PANEL, 0));
  assert(!shouldIgnoreMouse(0, 0, PANEL, 0));
  assert(shouldIgnoreMouse(-1, -1, PANEL, 0));
});

test('穿透_半径超过短边一半时按浏览器口径收敛', () => {
  const small = { left: 0, top: 0, right: 10, bottom: 10 };
  // 收敛成 r=5 的内切圆：圆心 (5,5) 保留，角点 (0,0) 穿透
  assert(!shouldIgnoreMouse(5, 5, small, 20));
  assert(shouldIgnoreMouse(0, 0, small, 20));
  // 负半径同样收敛为 0，不改变矩形判定
  assert(!shouldIgnoreMouse(1, 1, small, -8));
});

// ---------- 相对时间 ----------

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

test('相对时间_一分钟内为刚刚_未来时间戳同档', () => {
  eq(formatTime(1000, 1000), '刚刚');
  eq(formatTime(0, MINUTE - 1), '刚刚');
  eq(formatTime(5000, 1000), '刚刚');
});

test('相对时间_分钟档与小时档的阈值边界', () => {
  eq(formatTime(0, MINUTE), '1 分钟前');
  eq(formatTime(0, HOUR - 1), '59 分钟前');
  eq(formatTime(0, HOUR), '1 小时前');
  eq(formatTime(0, DAY - 1), '23 小时前');
});

test('相对时间_跨天首日为昨天_边界含等于', () => {
  const ts = Date.parse('2026-09-05T08:09:00');
  eq(formatTime(ts, ts + DAY), '昨天');
  eq(formatTime(ts, ts + 2 * DAY - 1), '昨天');
});

test('相对时间_两天起按天前取整', () => {
  const ts = Date.parse('2026-01-02T03:04:00');
  eq(formatTime(ts, ts + 2 * DAY), '2 天前');
  eq(formatTime(ts, ts + 11 * DAY - 1), '10 天前');
});

// ---------- 按键码映射 ----------

test('按键码_字母与数字取本体_越界形态不映射', () => {
  eq(accelKeyFromCode('KeyV'), 'V');
  eq(accelKeyFromCode('Digit1'), '1');
  eq(accelKeyFromCode('KeyAA'), null);
  eq(accelKeyFromCode('Digit10'), null);
});

test('按键码_F1到F24原样返回_F0与F25不映射', () => {
  eq(accelKeyFromCode('F1'), 'F1');
  eq(accelKeyFromCode('F9'), 'F9');
  eq(accelKeyFromCode('F10'), 'F10');
  eq(accelKeyFromCode('F24'), 'F24');
  eq(accelKeyFromCode('F25'), null);
  eq(accelKeyFromCode('F0'), null);
});

test('按键码_功能键与方向键按表转换', () => {
  eq(accelKeyFromCode('ArrowUp'), 'Up');
  eq(accelKeyFromCode('ArrowDown'), 'Down');
  eq(accelKeyFromCode('ArrowLeft'), 'Left');
  eq(accelKeyFromCode('ArrowRight'), 'Right');
  eq(accelKeyFromCode('Space'), 'Space');
  eq(accelKeyFromCode('Delete'), 'Delete');
  eq(accelKeyFromCode('PageDown'), 'PageDown');
});

test('按键码_裸修饰键与未知码返回null', () => {
  eq(accelKeyFromCode('ControlLeft'), null);
  eq(accelKeyFromCode('ShiftRight'), null);
  eq(accelKeyFromCode(''), null);
});

// ---------- 键盘注册表（keyboard.ts） ----------

test('accel归一_修饰键与别名收成keyId形', () => {
  eq(accelToKeyId('Control+Shift+V'), 'ctrl+shift+v');
  eq(accelToKeyId('CommandOrControl+D'), 'ctrl+d');
  eq(accelToKeyId('Alt+X'), 'alt+x');
  eq(accelToKeyId('Super+Space'), 'meta+ ');
  eq(accelToKeyId('Up'), 'arrowup');
  eq(accelToKeyId('Down'), 'arrowdown');
  eq(accelToKeyId('Esc'), 'escape');
  eq(accelToKeyId('Space'), ' ');
  eq(accelToKeyId('Delete'), 'delete');
  eq(accelToKeyId('Enter'), 'enter');
  eq(accelToKeyId('B'), 'b');
});

test('combo平台化显示_中文键名_修饰缩写', () => {
  const THIN = '\u2009';
  eq(combo('ctrl+shift+v'), ['Ctrl', '\u21e7', 'V'].join(THIN));
  eq(combo(' '), '空格');
  eq(combo('arrowup'), '↑');
  eq(combo('arrowdown'), '↓');
  eq(combo('enter'), '⏎');
  eq(combo('escape'), 'Esc');
  eq(combo('delete'), 'Del');
  eq(combo('alt+x'), ['Alt', 'X'].join(THIN));
});

test('chipLabel把accel一步转成展示文案', () => {
  const THIN = '\u2009';
  eq(chipLabel('Control+Shift+V'), ['Ctrl', '\u21e7', 'V'].join(THIN));
  eq(chipLabel('Space'), '空格');
  eq(chipLabel('Z'), 'Z');
});

test('注册表九条_呼出键取真实值_描述全中文', () => {
  const bindings = buildBindings('Alt+J');
  eq(bindings.length, 9);
  const toggle = bindings.find((binding) => binding.action === 'toggle');
  eq(toggle.keys, ['Alt+J']);
  assert(bindings.every((binding) => binding.desc.length > 0 && !/[a-zA-Z]{4,}/.test(binding.desc.replace(/Ctrl|Alt|Esc|Del|Tab|Home|End/g, ''))), '描述应为中文');
});

test('页脚chip由注册表同一份键值生成_一组一枚_顺序稳定', () => {
  const chips = footerChips();
  eq(chips.map((chip) => chip.label), ['选择', '复制', '置顶', '备注', '删除', '隐藏']);
  // ↑↓ 并排写进同一枚 chip（源 UI 同形）；两枚会把这组撑出第三次 5px 间隙，节奏断裂
  eq(chips[0].chips, ['↑↓']);
  eq(chips.map((chip) => chip.chips.length).every((n) => n === 1), true);
});

test('页脚只列面板可见时用上的键_搜索住井里_呼出住托盘与覆盖层', () => {
  const labels = footerChips().map((chip) => chip.label);
  assert(!labels.includes('搜索'), '空格 chip 归搜索井');
  assert(!labels.includes('唤起'), '呼出键在面板隐藏时才有效，页脚看不见它');
});

// ---------- 跨语言对表：NAV_KEYS 镜像 vs Rust NAV_SHORTCUTS ----------

test('渲染层键位镜像与Rust表逐条一致_一条不多一条不少', () => {
  const rust = readFileSync(new URL('../src-tauri/src/panel_modes.rs', import.meta.url), 'utf8');
  const rows = [...rust.matchAll(/\("(.+?)",\s*NavAction::(\w+),\s*(true|false)\)/g)];
  assert(rows.length === 8, `Rust NAV_SHORTCUTS 应为 8 条，实为 ${rows.length}`);
  const byAction = new Map(rows.map(([, accel, action]) => [action.toLowerCase(), accel]));
  for (const [key, accel] of Object.entries(NAV_KEYS)) {
    eq(byAction.get(key), accel, `导航键 ${key} 漂移：`);
  }
  eq(byAction.size, Object.keys(NAV_KEYS).length, '两侧键数必须相等');
});

// ---------- 滚动条几何 ----------

test('滚动条_内容不超高时不可见', () => {
  eq(scrollbarThumb(0, 600, 600), { visible: false, top: 0, height: 28 });
  eq(scrollbarThumb(0, 600, 100), { visible: false, top: 0, height: 28 });
});

test('滚动条_thumb高度按可视比例_且不破下限', () => {
  eq(scrollbarThumb(0, 600, 1200).height, 300);
  eq(scrollbarThumb(0, 600, 60000).height, 28);
});

test('滚动条_top随滚动进度线性到最大位', () => {
  eq(scrollbarThumb(0, 600, 1200).top, 0);
  eq(scrollbarThumb(300, 600, 1200).top, 150);
  eq(scrollbarThumb(600, 600, 1200).top, 300);
  eq(scrollbarThumb(0, 600, 60000).visible, true);
});

test('主题按钮_亮暗系统循环_文案与图标展示偏好', () => {
  eq(themeControl('light'), { label: '亮色', icon: 'i-sun', next: 'dark' });
  eq(themeControl('dark'), { label: '暗色', icon: 'i-moon', next: 'system' });
  eq(themeControl('system'), { label: '跟随系统', icon: 'i-monitor', next: 'light' });
});

// ---------- 撤销窗口与主题同步 ----------

test('延迟删除_首次请求隐藏并启动计时_重复请求保持原窗口', () => {
  const first = transitionDeletion(new Map(), { type: 'request', id: 'a' });
  eq(first.state.get('a'), 'undoable');
  eq(first.effects.map(({ type }) => type), ['hide', 'start-timer', 'show-undo']);
  const duplicate = transitionDeletion(first.state, { type: 'request', id: 'a' });
  assert(duplicate.state === first.state, '重复请求不改状态');
  eq(duplicate.effects, []);
});

test('延迟删除_撤销取消计时并恢复_迟到截止事件无效', () => {
  const pending = transitionDeletion(new Map(), { type: 'request', id: 'a' });
  const undone = transitionDeletion(pending.state, { type: 'undo', id: 'a' });
  eq(undone.state.has('a'), false);
  eq(undone.effects.map(({ type }) => type), ['cancel-timer', 'restore']);
  const late = transitionDeletion(undone.state, { type: 'deadline', id: 'a' });
  eq(late.effects, []);
});

test('延迟删除_截止后只提交一次且不再接受撤销', () => {
  const pending = transitionDeletion(new Map(), { type: 'request', id: 'a' });
  const due = transitionDeletion(pending.state, { type: 'deadline', id: 'a' });
  eq(due.state.get('a'), 'removing');
  eq(due.effects, [{ type: 'remove', id: 'a' }]);
  eq(transitionDeletion(due.state, { type: 'deadline', id: 'a' }).effects, []);
  eq(transitionDeletion(due.state, { type: 'undo', id: 'a' }).effects, []);
});

test('延迟删除_提交失败恢复条目并提示_成功只清理判定状态', () => {
  const pending = transitionDeletion(new Map(), { type: 'request', id: 'a' });
  const due = transitionDeletion(pending.state, { type: 'deadline', id: 'a' });
  const failed = transitionDeletion(due.state, { type: 'remove-failed', id: 'a' });
  eq(failed.state.has('a'), false);
  eq(failed.effects.map(({ type }) => type), ['restore', 'show-error']);
  const retry = transitionDeletion(failed.state, { type: 'request', id: 'a' });
  const retryDue = transitionDeletion(retry.state, { type: 'deadline', id: 'a' });
  const succeeded = transitionDeletion(retryDue.state, { type: 'remove-succeeded', id: 'a' });
  eq(succeeded.state.has('a'), false);
  eq(succeeded.effects, []);
});

test('主题同步_外部变更使未完成的读取失效', () => {
  const sync = new ThemeSynchronizer();
  const initialRead = sync.beginRead();
  sync.receiveChange('dark');
  eq(sync.acceptRead(initialRead, 'light'), false);
  eq(sync.snapshot(), { preference: 'dark', pending: false });
});

test('主题同步_较新的读取先返回后迟到旧读不能覆盖', () => {
  const sync = new ThemeSynchronizer();
  const oldRead = sync.beginRead();
  const newRead = sync.beginRead();
  eq(sync.acceptRead(newRead, 'system'), true);
  eq(sync.acceptRead(oldRead, 'light'), false);
  eq(sync.snapshot(), { preference: 'system', pending: false });
});

test('主题同步_切换互斥_失败后保留偏好并允许重试', () => {
  const sync = new ThemeSynchronizer();
  const read = sync.beginRead();
  sync.acceptRead(read, 'light');
  eq(sync.beginToggle(), 'dark');
  eq(sync.beginToggle(), null);
  sync.finishToggle();
  eq(sync.snapshot(), { preference: 'light', pending: false });
  eq(sync.beginToggle(), 'dark');
  sync.finishToggle();
});

test('延迟删除_条目各自计时_撤销一条不影响另一条提交', () => {
  const a = transitionDeletion(new Map(), { type: 'request', id: 'a' });
  const b = transitionDeletion(a.state, { type: 'request', id: 'b' });
  const undone = transitionDeletion(b.state, { type: 'undo', id: 'a' });
  const due = transitionDeletion(undone.state, { type: 'deadline', id: 'b' });
  eq([...due.state], [['b', 'removing']]);
  eq(due.effects, [{ type: 'remove', id: 'b' }]);
});

test('主题同步_退出使读取失效_重新读取仍可接收', () => {
  const sync = new ThemeSynchronizer();
  eq(sync.beginToggle(), null);
  const oldRead = sync.beginRead();
  sync.invalidateReads();
  eq(sync.acceptRead(oldRead, 'light'), false);
  const newRead = sync.beginRead();
  eq(sync.acceptRead(newRead, 'dark'), true);
  eq(sync.snapshot(), { preference: 'dark', pending: false });
});

test('主题同步_切换中外部变更保留互斥_结束后不回退偏好', () => {
  const sync = new ThemeSynchronizer();
  sync.receiveChange('light');
  eq(sync.beginToggle(), 'dark');
  sync.receiveChange('system');
  eq(sync.snapshot(), { preference: 'system', pending: true });
  sync.finishToggle();
  eq(sync.snapshot(), { preference: 'system', pending: false });
});

console.log(`\n渲染层规则：${passed} 例通过，${failures.length} 例失败`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
