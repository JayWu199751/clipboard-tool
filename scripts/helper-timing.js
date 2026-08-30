// 助手进程耗时测量：spawn 真实 focus-paste-helper.exe，
// 各发 5 次 snapshot 与 restore（restore 目标=当前前台，等价于无操作重聚焦，不注入按键）。
const { spawn } = require('child_process');
const path = require('path');

const exe = path.join(__dirname, '..', 'resources', 'focus-paste-helper.exe');
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
child.stdout.setEncoding('utf8');

let buffer = '';
const pending = new Map();
let nextId = 0;
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const p = pending.get(String(msg.id));
    if (p) { pending.delete(String(msg.id)); p(msg); }
  }
});

function call(cmd, target = null) {
  const id = String(++nextId);
  const started = Date.now();
  return new Promise((resolve) => {
    pending.set(id, (reply) => resolve({ reply, ms: Date.now() - started }));
    child.stdin.write(`${JSON.stringify({ id, cmd, target })}\n`);
  });
}

(async () => {
  // 预热（JavaScriptSerializer 首次加载程序集较慢）
  const warm = await call('snapshot');
  console.log(`warmup snapshot: ${warm.ms}ms ok=${warm.reply.ok}`);

  const snapTimes = [];
  let target = null;
  for (let i = 0; i < 5; i++) {
    const r = await call('snapshot');
    snapTimes.push(r.ms);
    if (r.reply.ok) target = r.reply.target;
  }
  console.log(`snapshot x5: ${snapTimes.join(', ')} ms (target=${target ? 'captured' : 'none'})`);

  if (target) {
    const resTimes = [];
    for (let i = 0; i < 5; i++) {
      const r = await call('restore', target);
      resTimes.push(r.ms);
      if (!r.reply.ok) console.log(`  restore reply: ${JSON.stringify(r.reply)}`);
    }
    console.log(`restore  x5: ${resTimes.join(', ')} ms`);
  }

  // 空闲间隔后单次（模拟面板呼出后隔几秒按回车）
  await new Promise((r) => setTimeout(r, 2000));
  const r2 = await call('restore', target);
  console.log(`restore after 2s idle: ${r2.ms} ms ok=${r2.reply.ok}`);

  child.stdin.end();
  child.kill();
  process.exit(0);
})();
