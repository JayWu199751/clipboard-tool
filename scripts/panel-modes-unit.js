// 面板模式状态机单元测试：直接测 electron/panel-modes.js 的 interface，不需要 Electron mock。
// 覆盖：热键集合随模式推导、转换级联（互斥退出）、焦点快照生命周期、IME 子态、捕获确认/取消。
const assert = require('assert');
const { createPanelModes, NAV_SHORTCUTS } = require('../electron/panel-modes');

function makeMachine(overrides = {}) {
  const registered = new Map(); // accel -> handler
  const events = [];            // { channel, args }
  let focusSnapshot = null;
  let snapshotRequests = 0;
  let restored = [];
  let noFocusErrors = 0;
  let focused = 0;
  let blurred = 0;
  const modes = createPanelModes({
    registerKey: (accel, handler) => {
      if (registered.has(accel)) return false;
      registered.set(accel, handler);
      return true;
    },
    unregisterKey: (accel) => { registered.delete(accel); },
    send: (channel, ...args) => events.push({ channel, args }),
    captureFocus: async () => {
      snapshotRequests += 1;
      return focusSnapshot;
    },
    restoreFocus: (target) => restored.push(target),
    reportNoFocusTarget: () => { noFocusErrors += 1; },
    focusPanel: () => { focused += 1; },
    blurPanelIfFocused: () => { blurred += 1; },
    validateNoteTarget: (id) => (id === null ? true : id === 'entry-1'),
    ...overrides,
  });
  return { modes, registered, events, restored, counters: {
    get snapshotRequests() { return snapshotRequests; },
    get restored() { return restored; },
    get noFocusErrors() { return noFocusErrors; },
    get focused() { return focused; },
    get blurred() { return blurred; },
  }, setSnapshot(v) { focusSnapshot = v; } };
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('启动后只注册呼出快捷键；show 后注册全部导航键', async () => {
  const h = makeMachine();
  h.modes.setToggleShortcut('Control+Shift+V');
  assert.deepStrictEqual([...h.registered.keys()], ['Control+Shift+V']);
  await h.modes.ensureFocusTarget();
  h.modes.show();
  assert.ok(h.registered.has('Control+Shift+V'));
  for (const [accel] of NAV_SHORTCUTS) assert.ok(h.registered.has(accel), accel);
  assert.strictEqual(h.events.filter((e) => e.channel === 'panel:shown').length, 1);
});

test('搜索模式：Space/Z/Del/B 让位，↑↓/Enter/Esc 保留；IME 组合中全部暂停', async () => {
  const h = makeMachine();
  h.setSnapshot({ hwnd: 1 });
  h.modes.setToggleShortcut('Control+Shift+V');
  await h.modes.ensureFocusTarget();
  h.modes.show();
  assert.strictEqual(await h.modes.beginSearch(), true);
  assert.ok(!h.registered.has('Space'));
  assert.ok(!h.registered.has('Z'));
  assert.ok(!h.registered.has('Delete'));
  assert.ok(!h.registered.has('B'));
  assert.ok(h.registered.has('Up') && h.registered.has('Down') && h.registered.has('Enter') && h.registered.has('Esc'));
  h.modes.setComposing(true);
  assert.ok(!h.registered.has('Up'), 'IME 组合中导航键全部暂停');
  assert.ok(h.registered.has('Control+Shift+V'));
  h.modes.setComposing(false);
  assert.ok(h.registered.has('Up'));
  // setComposing 同值幂等
  h.modes.setComposing(false);
  assert.ok(h.registered.has('Up'));
});

test('搜索退出：恢复浏览态热键、归还焦点、发 search-exit；快照保留', async () => {
  const h = makeMachine();
  h.setSnapshot({ hwnd: 1 });
  h.modes.setToggleShortcut('Control+Shift+V');
  await h.modes.ensureFocusTarget();
  h.modes.show();
  await h.modes.beginSearch();
  const snapshotsBefore = h.counters.snapshotRequests;
  h.modes.endSearch();
  assert.deepStrictEqual([...h.registered.keys()].sort(), ['Control+Shift+V', ...NAV_SHORTCUTS.map(([a]) => a)].sort());
  assert.strictEqual(h.events.some((e) => e.channel === 'panel:key' && e.args[0] === 'search-exit'), true);
  assert.deepStrictEqual(h.counters.restored, [{ hwnd: 1 }]);
  // 快照保留：再次进入搜索不再补拍
  await h.modes.beginSearch();
  assert.strictEqual(h.counters.snapshotRequests, snapshotsBefore);
});

test('浏览态 Esc 转发渲染层；搜索态 Esc 退出搜索', async () => {
  const h = makeMachine();
  h.setSnapshot({ hwnd: 1 });
  h.modes.setToggleShortcut('Control+Shift+V');
  await h.modes.ensureFocusTarget();
  h.modes.show();
  h.registered.get('Esc')();
  assert.strictEqual(h.events.filter((e) => e.channel === 'panel:key' && e.args[0] === 'escape').length, 1);
  await h.modes.beginSearch();
  h.registered.get('Esc')();
  assert.strictEqual(h.events.filter((e) => e.channel === 'panel:key' && e.args[0] === 'search-exit').length, 1);
});

test('进入备注编辑先退出搜索；隐藏面板逐层退出并发对事件', async () => {
  const h = makeMachine();
  h.setSnapshot({ hwnd: 1 });
  h.modes.setToggleShortcut('Control+Shift+V');
  await h.modes.ensureFocusTarget();
  h.modes.show();
  await h.modes.beginSearch();
  assert.strictEqual(await h.modes.beginNoteEdit('entry-1'), true);
  assert.strictEqual(h.modes.state().mode, 'note-edit');
  assert.ok(!h.registered.has('Enter'), '备注编辑中导航键全部让位');
  assert.strictEqual(h.events.some((e) => e.channel === 'panel:key' && e.args[0] === 'search-exit'), true);
  assert.strictEqual(h.events.some((e) => e.channel === 'panel:key' && e.args[0] === 'note-edit-enter'), true);

  h.modes.hide();
  assert.strictEqual(h.modes.state().mode, 'browse');
  assert.deepStrictEqual([...h.registered.keys()], ['Control+Shift+V']);
  assert.strictEqual(h.events.some((e) => e.channel === 'panel:key' && e.args[0] === 'note-edit-exit'), true);
  // 搜索退出事件只在进入备注编辑的互斥退出时发过一次，hide 不再重复
  assert.strictEqual(h.events.filter((e) => e.channel === 'panel:key' && e.args[0] === 'search-exit').length, 1);
});

test('hide 消费焦点快照；hide({restoreFocus:false}) 只清不还', async () => {
  const h = makeMachine();
  h.setSnapshot({ hwnd: 1 });
  h.modes.setToggleShortcut('Control+Shift+V');
  await h.modes.ensureFocusTarget();
  h.modes.show();
  h.modes.hide();
  assert.deepStrictEqual(h.counters.restored, [{ hwnd: 1 }]);

  await h.modes.ensureFocusTarget(); // 快照已消费 → 重新补拍
  h.modes.show();
  h.modes.hide({ restoreFocus: false });
  assert.strictEqual(h.counters.restored.length, 1);
  assert.strictEqual(h.modes.focusTargetSnapshot(), null);
});

test('呼出时快照失败静默；进入输入态时快照失败上报并放弃', async () => {
  const h = makeMachine(); // focusSnapshot 为 null → captureFocus 返回 null
  h.modes.setToggleShortcut('Control+Shift+V');
  await h.modes.ensureFocusTarget({ reportOnFailure: false });
  h.modes.show();
  assert.strictEqual(h.counters.noFocusErrors, 0);
  assert.strictEqual(await h.modes.beginSearch(), false);
  assert.strictEqual(h.counters.noFocusErrors, 1);
  assert.strictEqual(h.modes.state().mode, 'browse');
  assert.strictEqual(await h.modes.beginNoteEdit(null), false);
  assert.strictEqual(h.counters.noFocusErrors, 2);
});

test('快捷键捕获：注销呼出键与全部导航键；确认后换键退出捕获', async () => {
  const h = makeMachine();
  h.setSnapshot({ hwnd: 1 });
  h.modes.setToggleShortcut('Control+Shift+V');
  await h.modes.ensureFocusTarget();
  h.modes.show();
  assert.strictEqual(await h.modes.beginShortcutCapture(), true);
  assert.deepStrictEqual([...h.registered.keys()], [], '捕获中无任何全局键');
  assert.strictEqual(h.modes.trySetToggleShortcut('Control+Alt+X'), true);
  assert.ok(h.registered.has('Control+Alt+X'));
  for (const [accel] of NAV_SHORTCUTS) assert.ok(h.registered.has(accel), accel);
  assert.strictEqual(h.modes.state().mode, 'browse');
  // 确认路径不发 capture-end（覆盖层由渲染层自行收起）
  assert.strictEqual(h.events.some((e) => e.channel === 'shortcut:capture-end'), false);
});

test('快捷键捕获：新键注册失败保持捕获态；取消恢复原键并发 capture-end', async () => {
  const h = makeMachine();
  h.setSnapshot({ hwnd: 1 });
  h.modes.setToggleShortcut('Control+Shift+V');
  await h.modes.ensureFocusTarget();
  h.modes.show();
  await h.modes.beginShortcutCapture();
  // 模拟被占用：直接占用目标键
  h.registered.set('Control+Alt+X', () => {});
  assert.strictEqual(h.modes.trySetToggleShortcut('Control+Alt+X'), false);
  assert.strictEqual(h.modes.state().mode, 'shortcut-capture');
  h.modes.cancelShortcutCapture();
  assert.ok(h.registered.has('Control+Shift+V'));
  for (const [accel] of NAV_SHORTCUTS) assert.ok(h.registered.has(accel), accel);
  assert.strictEqual(h.events.some((e) => e.channel === 'shortcut:capture-end'), true);
});

test('捕获中呼出面板保持捕获态（导航键不误注册）', async () => {
  const h = makeMachine();
  h.setSnapshot({ hwnd: 1 });
  h.modes.setToggleShortcut('Control+Shift+V');
  await h.modes.ensureFocusTarget();
  assert.strictEqual(await h.modes.beginShortcutCapture(), true);
  h.modes.show(); // startShortcutCapture 随后的 showPanel
  assert.deepStrictEqual([...h.registered.keys()], [], '捕获中 show 不注册任何键');
  assert.strictEqual(h.modes.state().mode, 'shortcut-capture');
  h.modes.cancelShortcutCapture({ restoreFocus: false });
  assert.strictEqual(h.modes.state().mode, 'browse');
  assert.ok(h.registered.has('Up')); // 面板仍显示 → 导航键恢复
});

test('备注目标校验失败：不进入编辑、不补拍快照之外的效果', async () => {
  const h = makeMachine();
  h.setSnapshot({ hwnd: 1 });
  h.modes.setToggleShortcut('Control+Shift+V');
  await h.modes.ensureFocusTarget();
  h.modes.show();
  assert.strictEqual(await h.modes.beginNoteEdit('no-such-entry'), false);
  assert.strictEqual(h.modes.state().mode, 'browse');
  for (const [accel] of NAV_SHORTCUTS) assert.ok(h.registered.has(accel), accel);
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
  console.log(`PASS: ${tests.length} panel-modes unit tests.`);
})();
