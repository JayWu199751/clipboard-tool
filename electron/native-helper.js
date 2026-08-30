// 助手进程 seam：main.js 与各原生 helper（focus-paste-helper / app-icon-helper / click-watcher）
// 之间唯一的集成点。spawn、stdio 行缓冲、JSON 请求/响应（请求 id + 超时）、一次性运行、
// 生命周期清理全部收在本 module 的 interface 之后；每个 helper 只是一个薄 adapter。
//
// focus-paste-helper 的 JSON 行协议（唯一命名处；C# 实现见 resources/focus-paste-helper.cs 的
// HandleCommand，回归 mock 见 scripts/focus-paste-regression.js 的 parseHelperCommand——
// 三处共同实现同一 schema，改动需三处同步）：
//   请求行：{ id: string, cmd: 'snapshot' | 'restore' | 'paste', target?: FocusTarget }
//   响应行：{ id: string, ok: boolean, target?: FocusTarget,
//             stage?: 'restore' | 'paste', reason?: string }
//   FocusTarget = { hwnd, focusHwnd, pid, tid, ... }（由 helper 快照生成，main.js 原样回传）
// click-watcher 的文本行协议：每行 "click X Y"（物理像素坐标）。

const { spawn, execFile } = require('child_process');

// 行缓冲：把任意切分到达的 chunk 流还原成完整行再回调。
// 此前 click-watcher 直接 chunk.split('\n')，事件跨 chunk 边界会被静默丢弃；统一走这里修复。
function createLineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) onLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    },
  };
}

// 常驻助手进程：spawn + stdout 行分发 + stderr 转发 + 退出/错误清理。
// spawnImpl 参数用于测试注入；生产默认 child_process.spawn。
// ignoreStderr: true 时不创建 stderr 管道（如 click-watcher，stderr 直接丢弃）。
function spawnLineHelper({ exePath, args = [], onLine, onExit, onError, onStderr, ignoreStderr = false, spawnImpl = spawn }) {
  let child = null;
  let stopped = false;
  let exited = false;
  try {
    child = spawnImpl(exePath, args, {
      stdio: ['pipe', 'pipe', ignoreStderr ? 'ignore' : 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    if (onError) onError(err);
    child = null;
  }
  if (!child) {
    return { write: () => false, stop: () => {}, isRunning: () => false };
  }
  child.stdout.setEncoding('utf8');
  const splitter = createLineSplitter(onLine);
  child.stdout.on('data', (chunk) => splitter.push(chunk));
  if (!ignoreStderr && onStderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => onStderr(chunk));
  }
  if (onError) {
    child.on('error', (err) => onError(err));
  }
  if (onExit) {
    child.on('exit', () => {
      exited = true;
      onExit();
    });
  }
  return {
    write(str) {
      if (stopped || exited) return false;
      try {
        child.stdin.write(str);
        return true;
      } catch (_) {
        return false;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try { child.stdin.end(); } catch (_) { /* ignore */ }
      try { child.kill(); } catch (_) { /* ignore */ }
    },
    isRunning: () => !stopped && !exited,
  };
}

// JSON 请求/响应通道：每次 call 写入一行带 id 的请求，stdout 按行收到同 id 响应则 resolve；
// 超时或进程退出/出错则 reject 所有挂起请求。不自动重启（与既有行为一致：helper 挂掉后
// 请求失败，直到应用重启）。
function createJsonRpcHelper({ exePath, args = [], timeoutMs = 2500, onStderr, spawnImpl = spawn }) {
  let nextId = 0;
  const pending = new Map(); // id -> { timer, resolve, reject }
  let stopped = false;

  function failAll(error) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  }

  const handle = spawnLineHelper({
    exePath,
    args,
    spawnImpl,
    onStderr,
    onLine: (line) => {
      let response = null;
      try {
        response = JSON.parse(line);
      } catch (_) {
        return; // 忽略 helper 的异常输出
      }
      const entry = pending.get(String(response.id));
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(String(response.id));
      entry.resolve(response);
    },
    onError: (err) => failAll(err instanceof Error ? err : new Error(String(err))),
    onExit: () => failAll(new Error('focus-paste-helper exited')),
  });

  return {
    // call('snapshot') / call('restore', target) / call('paste', target)
    call(command, payload = null, timeout = timeoutMs) {
      if (stopped || !handle.isRunning()) {
        return Promise.reject(new Error('focus-paste-helper not running'));
      }
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        const entry = { timer: null, resolve, reject };
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`focus-paste-helper ${command} timed out`));
        }, timeout);
        pending.set(id, entry);
        const line = `${JSON.stringify({ id, cmd: command, target: payload })}\n`;
        if (!handle.write(line)) {
          clearTimeout(entry.timer);
          pending.delete(id);
          reject(new Error('focus-paste-helper stdin unavailable'));
        }
      });
    },
    stop() {
      stopped = true;
      failAll(new Error('app is quitting'));
      handle.stop();
    },
  };
}

// 一次性助手：运行到退出，取 stdout 最后一个非空行解析 JSON；任何失败返回 null。
// execImpl 参数用于测试注入；生产默认 child_process.execFile。
function readOneShotJson({ exePath, args = [], timeoutMs = 1500, execImpl = execFile }) {
  return new Promise((resolve) => {
    execImpl(exePath, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const lines = String(stdout).trim().split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (_) {
        resolve(null);
      }
    });
  });
}

module.exports = { createLineSplitter, spawnLineHelper, createJsonRpcHelper, readOneShotJson };
