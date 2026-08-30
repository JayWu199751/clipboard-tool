// 助手进程 seam 单元测试：直接测 electron/native-helper.js 的 interface（spawnImpl/execImpl 注入）。
// 重点覆盖：行缓冲跨 chunk 还原（click-watcher 丢点击缺陷的回归）、JSON 请求 id 匹配、超时、退出清理。
const assert = require('assert');
const { createLineSplitter, spawnLineHelper, createJsonRpcHelper, readOneShotJson } = require('../electron/native-helper');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function makeFakeChild() {
  const listeners = { stdout: [], stderr: [], error: [], exit: [] };
  const child = {
    stdout: { setEncoding() {}, on(ev, cb) { listeners.stdout.push(cb); } },
    stderr: { setEncoding() {}, on(ev, cb) { listeners.stderr.push(cb); } },
    stdin: { writes: [], write(s) { child.stdin.writes.push(s); return true; }, end() { child.stdinEnded = true; } },
    kill() { child.killed = true; },
    on(ev, cb) { listeners[ev].push(cb); },
    __emit: { stdout: (chunk) => listeners.stdout.forEach((cb) => cb(chunk)), stderr: (c) => listeners.stderr.forEach((cb) => cb(c)), error: (e) => listeners.error.forEach((cb) => cb(e)), exit: () => listeners.exit.forEach((cb) => cb()) },
    stdinEnded: false,
    killed: false,
  };
  return child;
}

test('行缓冲：跨 chunk 边界的事件不丢失（click-watcher 缺陷回归）', () => {
  const lines = [];
  const splitter = createLineSplitter((l) => lines.push(l));
  splitter.push('click 10 2');
  assert.deepStrictEqual(lines, [], '不完整行不应回调');
  splitter.push('0\nclick 30 40\ncl');
  assert.deepStrictEqual(lines, ['click 10 20', 'click 30 40']);
  splitter.push('ick 50 60\n');
  assert.deepStrictEqual(lines, ['click 10 20', 'click 30 40', 'click 50 60']);
  splitter.push('\n\n'); // 空行忽略
  assert.strictEqual(lines.length, 3);
});

test('spawnLineHelper：stdout 按行分发、stderr 转发、stop 结束 stdin 并 kill', () => {
  let spawned = null;
  const child = makeFakeChild();
  const lines = [];
  const stderrChunks = [];
  const handle = spawnLineHelper({
    exePath: 'fake.exe',
    onLine: (l) => lines.push(l),
    onStderr: (c) => stderrChunks.push(c),
    spawnImpl: () => { spawned = child; return child; },
  });
  assert.ok(spawned);
  child.__emit.stdout('a\nb');
  child.__emit.stdout('c\n');
  assert.deepStrictEqual(lines, ['a', 'bc']);
  child.__emit.stderr('warn');
  assert.deepStrictEqual(stderrChunks, ['warn']);
  handle.stop();
  assert.ok(child.stdinEnded && child.killed);
});

test('spawnLineHelper：ignoreStderr 时不触碰 stderr 管道', () => {
  const child = makeFakeChild();
  child.stderr = null; // 模拟 stdio ignore
  const handle = spawnLineHelper({
    exePath: 'fake.exe',
    ignoreStderr: true,
    onLine: () => {},
    spawnImpl: () => child,
  });
  child.__emit.stdout('click 1 2\n');
  handle.stop();
  assert.ok(child.stdinEnded);
});

test('spawnLineHelper：spawn 抛错时安全降级为不可用句柄', () => {
  const handle = spawnLineHelper({ exePath: 'x.exe', onLine: () => {}, spawnImpl: () => { throw new Error('boom'); } });
  assert.strictEqual(handle.isRunning(), false);
  assert.strictEqual(handle.write('x'), false);
  handle.stop(); // 不应抛
});

test('JSON 通道：请求带 id 写入、响应按 id 匹配 resolve', async () => {
  const child = makeFakeChild();
  const helper = createJsonRpcHelper({ exePath: 'h.exe', timeoutMs: 500, spawnImpl: () => child });
  const p1 = helper.call('snapshot');
  const req1 = JSON.parse(child.stdin.writes[0]);
  assert.ok(req1.id && req1.cmd === 'snapshot' && req1.target === null);
  child.__emit.stdout(`${JSON.stringify({ id: req1.id, ok: true, target: { hwnd: 7 } })}\n`);
  const reply = await p1;
  assert.deepStrictEqual(reply.target, { hwnd: 7 });

  const p2 = helper.call('paste', { hwnd: 7 });
  const req2 = JSON.parse(child.stdin.writes[1]);
  assert.deepStrictEqual(req2, { id: req2.id, cmd: 'paste', target: { hwnd: 7 } });
  child.__emit.stdout(`${JSON.stringify({ id: req2.id, ok: true })}\n`);
  assert.strictEqual((await p2).ok, true);
});

test('JSON 通道：超时 reject；迟到响应被忽略', async () => {
  const child = makeFakeChild();
  const helper = createJsonRpcHelper({ exePath: 'h.exe', timeoutMs: 30, spawnImpl: () => child });
  const p = helper.call('restore', { hwnd: 1 });
  await assert.rejects(p, /timed out/);
  const req = JSON.parse(child.stdin.writes[0]);
  child.__emit.stdout(`${JSON.stringify({ id: req.id, ok: true })}\n`); // 迟到，不应抛未处理拒绝
  await new Promise((r) => setTimeout(r, 10));
});

test('JSON 通道：进程退出后挂起请求全部 reject，新请求立即失败', async () => {
  const child = makeFakeChild();
  const helper = createJsonRpcHelper({ exePath: 'h.exe', timeoutMs: 1000, spawnImpl: () => child });
  const p = helper.call('snapshot');
  child.__emit.exit();
  await assert.rejects(p, /exited/);
  await assert.rejects(helper.call('snapshot'), /not running/);
  helper.stop();
});

test('JSON 通道：非 JSON 输出与未知 id 静默忽略', async () => {
  const child = makeFakeChild();
  const helper = createJsonRpcHelper({ exePath: 'h.exe', timeoutMs: 100, spawnImpl: () => child });
  child.__emit.stdout('not-json\n');
  child.__emit.stdout(`${JSON.stringify({ id: 'nope', ok: true })}\n`);
  child.__emit.stdout(`\n`);
  const p = helper.call('snapshot');
  const req = JSON.parse(child.stdin.writes[0]);
  child.__emit.stdout(`${JSON.stringify({ id: req.id, ok: true })}\n`);
  assert.strictEqual((await p).ok, true);
  helper.stop();
});

test('readOneShotJson：取最后一行非空 JSON；出错/空输出返回 null', async () => {
  assert.deepStrictEqual(
    await readOneShotJson({ exePath: 'x', execImpl: (exe, args, opts, cb) => cb(null, 'noise\n{"a":1}\n') }),
    { a: 1 }
  );
  assert.strictEqual(
    await readOneShotJson({ exePath: 'x', execImpl: (exe, args, opts, cb) => cb(new Error('timeout'), '') }),
    null
  );
  assert.strictEqual(
    await readOneShotJson({ exePath: 'x', execImpl: (exe, args, opts, cb) => cb(null, '  \n') }),
    null
  );
  assert.strictEqual(
    await readOneShotJson({ exePath: 'x', execImpl: (exe, args, opts, cb) => cb(null, 'not json\n') }),
    null
  );
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
  console.log(`PASS: ${tests.length} native-helper unit tests.`);
})();
