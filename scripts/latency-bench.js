// 主进程粘贴链路分段基准：用真实 userData 数据量化 persist / broadcast 图片重编码 / clipboard.writeText。
// 运行：npx electron scripts/latency-bench.js
const { app, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  try {
    // 基准跑在裸 electron 下（userData 指向 Electron 目录），直接读真实应用数据
    const dataDir = path.join(process.env.APPDATA || app.getPath('userData'), 'ClipboardTool');
    const historyFile = path.join(dataDir, 'clipboard-history.json');
    const raw = fs.readFileSync(historyFile, 'utf8');
    console.log('history bytes:', raw.length);

    let t = Date.now();
    const data = JSON.parse(raw);
    console.log(`JSON.parse: ${Date.now() - t}ms`);

    t = Date.now();
    fs.writeFileSync(path.join(app.getPath('temp'), 'clipboardtool-bench.json'), raw);
    console.log(`persist(writeFileSync ${raw.length} bytes): ${Date.now() - t}ms`);

    // broadcast 的真实成本：对每个图片条目 createFromPath + toDataURL（当前实现每次 broadcast 都重做）
    t = Date.now();
    let imgCount = 0;
    for (const e of data) {
      if (e.type === 'image' && e.imagePath && fs.existsSync(e.imagePath)) {
        nativeImage.createFromPath(e.imagePath).toDataURL();
        imgCount++;
      }
    }
    console.log(`broadcast image re-encode x${imgCount}: ${Date.now() - t}ms`);

    // 文本条目映射成本（对照）
    t = Date.now();
    for (const e of data) {
      if (e.type === 'text') {
        JSON.stringify({ id: e.id, text: e.text });
      }
    }
    console.log(`text entries map: ${Date.now() - t}ms`);

    // clipboard.writeText 本身
    t = Date.now();
    clipboard.writeText('benchmark-paste-latency');
    console.log(`clipboard.writeText: ${Date.now() - t}ms`);

    // 缓存后的 dataUrl 成本（修复后 broadcast 的样子）
    const cache = new Map();
    t = Date.now();
    for (const e of data) {
      if (e.type === 'image' && e.imagePath && fs.existsSync(e.imagePath)) {
        if (!cache.has(e.id)) cache.set(e.id, nativeImage.createFromPath(e.imagePath).toDataURL());
        void cache.get(e.id);
      }
    }
    console.log(`broadcast image re-encode x${imgCount} (cold, with cache write): ${Date.now() - t}ms`);
    t = Date.now();
    for (let i = 0; i < 10; i++) {
      for (const [id, v] of cache) void v;
    }
    console.log(`broadcast images (warm cache) x10 rounds: ${Date.now() - t}ms`);
  } catch (err) {
    console.error('bench failed:', err.message);
  }
  app.exit(0);
});
