const {
  app, BrowserWindow, globalShortcut, clipboard, nativeImage,
  ipcMain, screen, Menu, Tray, nativeTheme
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const MAX_HISTORY = 200;
const POLL_INTERVAL = 600;
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 560;
const SHADOW_MARGIN = 20; // 已废弃：改不透明窗口 + 系统阴影后不再需要预留透明边距（保留常量避免误用）

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let win = null;
let panelVisible = false; // 面板是否处于呼出状态（离屏隐藏时不依赖 win.isVisible()）
let history = [];
let lastText = '';
let lastImageHash = '';
let settings = { autoPaste: true, autoStart: false, shortcut: 'Control+Shift+V' };
let isQuitting = false;
let pollTimer = null;
let pasteTimer = null;
let tray = null;
let trayMenu = null;
let clickWatcher = null;
let shortcutCapturing = false; // 是否正在等待用户按下新快捷键
let shortcutOldAccel = null; // 捕获前的旧快捷键（取消时恢复）
let searchActive = false; // 面板是否处于搜索模式（搜索框可输入）
let searchComposing = false; // 搜索模式下中文输入法组合中：暂停面板导航键，全部让给输入框

// ---------- persistence helpers ----------

function imagesDir() {
  const dir = path.join(app.getPath('userData'), 'images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 图标缓存：exePath -> dataUrl，避免重复提取
const iconCache = new Map();

// 获取 app-icon-helper.exe 路径
function appIconHelperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', 'app-icon-helper.exe');
  }
  return path.join(app.getAppPath(), 'resources', 'app-icon-helper.exe');
}

// 异步获取前台应用信息（方案A：轮询时抓取）
async function getForegroundAppInfo() {
  const helper = appIconHelperPath();
  if (!fs.existsSync(helper)) return null;
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(helper, { timeout: 1500, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
    // helper 输出单行JSON，可能带换行，取最后一行非空
    const lines = stdout.trim().split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const info = JSON.parse(lines[lines.length - 1]);
    if (info.error) return null;
    let iconDataUrl = null;
    if (info.iconBase64) {
      iconDataUrl = `data:image/png;base64,${info.iconBase64}`;
      if (info.exePath) iconCache.set(info.exePath, iconDataUrl);
    } else if (info.exePath && iconCache.has(info.exePath)) {
      iconDataUrl = iconCache.get(info.exePath);
    }
    return {
      exePath: info.exePath || '',
      appName: info.appName || '',
      windowTitle: info.windowTitle || '',
      iconDataUrl,
    };
  } catch (e) {
    // 超时或解析失败，静默降级为无来源
    return null;
  }
}

function historyFile() {
  return path.join(app.getPath('userData'), 'clipboard-history.json');
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function toRendererEntry(entry) {
  // 来源应用信息透传给渲染进程（若无则为null，UI会fallback）
  const sourceApp = entry.sourceApp || null;
  if (entry.type === 'image') {
    let dataUrl = '';
    try {
      if (entry.imagePath && fs.existsSync(entry.imagePath)) {
        dataUrl = nativeImage.createFromPath(entry.imagePath).toDataURL();
      }
    } catch (_) { /* ignore */ }
    if (!dataUrl) return null;
    return { id: entry.id, type: 'image', dataUrl, createdAt: entry.createdAt, sourceApp, pinned: !!entry.pinned, pinnedAt: entry.pinnedAt || 0 };
  }
  return { id: entry.id, type: 'text', text: entry.text ?? '', createdAt: entry.createdAt, sourceApp, pinned: !!entry.pinned, pinnedAt: entry.pinnedAt || 0 };
}

function persist() {
  try {
    const data = history.map(({ id, type, text, imagePath, createdAt, sourceApp, pinned, pinnedAt }) => ({
      id, type, text, imagePath, createdAt, sourceApp, pinned: !!pinned, pinnedAt: pinnedAt || 0
    }));
    fs.writeFileSync(historyFile(), JSON.stringify(data));
  } catch (err) {
    console.error('Failed to persist history:', err);
  }
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(historyFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) history = parsed.filter((e) => e && e.id);
  } catch (_) {
    history = [];
  }
  history = history.filter((e) => {
    if (e.type === 'image') return !!e.imagePath && fs.existsSync(e.imagePath);
    return e.type === 'text';
  });
  // 归一化置顶标记（旧版本持久化数据可能没有这两个字段）
  for (const e of history) {
    e.pinned = !!e.pinned;
    e.pinnedAt = e.pinnedAt || 0;
  }
  sortHistory();
  trimHistory();
  // 预热图标缓存：从历史中已有的 sourceApp 恢复，避免重复提取
  try {
    for (const e of history) {
      if (e.sourceApp && e.sourceApp.exePath && e.sourceApp.iconDataUrl) {
        iconCache.set(e.sourceApp.exePath, e.sourceApp.iconDataUrl);
      }
    }
  } catch (_) { /* ignore */ }
}

// Align dedupe baselines with the current clipboard content, so the first
// poll after startup does not re-add what is already in the clipboard.
function syncBaseline() {
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const png = image.toPNG();
    lastImageHash = png && png.length ? sha1(png) : '';
    lastText = clipboard.readText() || '';
  } else {
    lastText = clipboard.readText() || '';
    lastImageHash = '';
  }
}

// ---------- history operations ----------

// 排序规则：置顶条目固定在最前（按置顶时间新→旧），之后按原数组顺序（即最近使用新→旧）。
function sortHistory() {
  const pinned = history.filter((e) => e.pinned).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
  const rest = history.filter((e) => !e.pinned);
  history = pinned.concat(rest);
}

function insertNewEntry(entry) {
  // 新条目插到置顶块之后、普通块最前
  let pinnedCount = 0;
  while (pinnedCount < history.length && history[pinnedCount].pinned) pinnedCount += 1;
  history.splice(pinnedCount, 0, entry);
}

function trimHistory() {
  if (history.length <= MAX_HISTORY) return;
  const removed = [];
  // 置顶条目优先保留：先裁掉尾部未置顶的条目；全部置顶时才裁掉最旧的置顶条目
  while (history.length > MAX_HISTORY) {
    let idx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (!history[i].pinned) { idx = i; break; }
    }
    if (idx === -1) idx = history.length - 1;
    removed.push(...history.splice(idx, 1));
  }
  for (const entry of removed) {
    if (entry.type === 'image' && entry.imagePath) {
      try { fs.unlinkSync(entry.imagePath); } catch (_) { /* ignore */ }
    }
  }
}

function broadcast() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('clipboard:updated', history.map(toRendererEntry).filter(Boolean));
  }
}

function addTextEntry(text, sourceApp) {
  if (!text) return;
  if (history[0] && history[0].type === 'text' && history[0].text === text) return;
  insertNewEntry({ id: crypto.randomUUID(), type: 'text', text, createdAt: Date.now(), sourceApp: sourceApp || null, pinned: false, pinnedAt: 0 });
  trimHistory();
  persist();
  broadcast();
}

function addImageEntry(image, sourceApp) {
  const png = image.toPNG();
  if (!png || png.length === 0) return;
  const hash = sha1(png);
  if (hash === lastImageHash) return;
  if (history[0] && history[0].type === 'image' && history[0].imagePath) {
    try {
      if (sha1(fs.readFileSync(history[0].imagePath)) === hash) return;
    } catch (_) { /* ignore */ }
  }
  const id = crypto.randomUUID();
  const imagePath = path.join(imagesDir(), `${id}.png`);
  try {
    fs.writeFileSync(imagePath, png);
  } catch (err) {
    console.error('Failed to save clipboard image:', err);
    return;
  }
  insertNewEntry({ id, type: 'image', imagePath, createdAt: Date.now(), sourceApp: sourceApp || null, pinned: false, pinnedAt: 0 });
  lastImageHash = hash;
  trimHistory();
  persist();
  broadcast();
}

let isPolling = false; // 防止异步重叠
async function pollClipboard() {
  if (isPolling) return;
  isPolling = true;
  try {
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const png = image.toPNG();
      const hash = png && png.length ? sha1(png) : '';
      if (hash && hash !== lastImageHash) {
        // 轮询方案A：检测到新图片时抓取前台应用作为来源
        const sourceApp = await getForegroundAppInfo();
        addImageEntry(image, sourceApp);
      }
      lastText = clipboard.readText() || '';
      return;
    }
    const text = clipboard.readText();
    if (text && text !== lastText) {
      const sourceApp = await getForegroundAppInfo();
      addTextEntry(text, sourceApp);
    }
    lastText = text;
    lastImageHash = '';
  } finally {
    isPolling = false;
  }
}

function copyEntry(id) {
  const idx = history.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const entry = history[idx];
  if (entry.type === 'text') {
    clipboard.writeText(entry.text || '');
  } else if (entry.type === 'image' && entry.imagePath && fs.existsSync(entry.imagePath)) {
    clipboard.writeImage(nativeImage.createFromPath(entry.imagePath));
  } else {
    return false;
  }
  history.splice(idx, 1);
  if (entry.pinned) {
    // 置顶条目复制后仍置顶，并刷新置顶时间，排到置顶块最前
    entry.pinnedAt = Date.now();
    history.unshift(entry);
  } else {
    // 普通条目复制后插到置顶块之后、普通块最前
    let pinnedCount = 0;
    while (pinnedCount < history.length && history[pinnedCount].pinned) pinnedCount += 1;
    history.splice(pinnedCount, 0, entry);
  }
  persist();
  broadcast();
  return true;
}

// ---------- settings ----------

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    // 只吸收已知键：旧版本遗留的 helperToken 等废弃字段不进入内存、不再写回
    for (const key of ['autoPaste', 'autoStart', 'shortcut']) {
      if (typeof parsed[key] !== 'undefined') settings[key] = parsed[key];
    }
  } catch (_) { /* first run */ }
  if (typeof settings.autoStart !== 'boolean') settings.autoStart = false;
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings));
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

// ---------- 静默提权启动（计划任务） ----------
// 应用清单 requireAdministrator：每次启动都是高完整性进程，
// UIPI 不再拦截面板键（globalShortcut）与 SendKeys 粘贴，管理员目标窗口照常工作。
// 正常入口（安装创建的快捷方式）经 task-launcher.exe + 计划任务 ClipboardToolElevated
// （/rl highest）静默拉起：任务以管理员令牌直接创建进程，不弹 UAC。
// 开机启动 = 该任务的 onlogon 触发器；开关重建任务（带/不带触发器，任务本体保留，
// 供快捷方式静默拉起），用户意图持久化在 settings.autoStart。

const ELEVATED_TASK_NAME = 'ClipboardToolElevated';

// 用 PowerShell Register-ScheduledTask 注册/重建任务：
// schtasks /create 强制要求 /sc 触发器，无法表达"仅作静默拉起通道（无触发器）"，
// Register-ScheduledTask 支持无触发器注册；-Force 覆盖重建。
// 本进程以管理员运行（requireAdministrator），注册不会弹 UAC。
function psRegisterTask(withLogonTrigger) {
  const action =
    "$action = New-ScheduledTaskAction -Execute '" + process.execPath.replace(/'/g, "''") + "'; " +
    "$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest; " +
    "Register-ScheduledTask -TaskName '" + ELEVATED_TASK_NAME + "' -Action $action -Principal $principal" +
    (withLogonTrigger ? " -Trigger (New-ScheduledTaskTrigger -AtLogOn)" : "") +
    " -Force | Out-Null";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', action], { windowsHide: true }, (err) => resolve(err ? false : true));
  });
}

// 确保任务存在（无触发器版本，仅作静默拉起通道）；自身提权时调用。失败只记日志。
async function ensureElevatedTask() {
  if (isDev) return; // 开发模式跑 electron.exe，无提权清单，不需要任务
  const ok = await psRegisterTask(false);
  if (!ok) console.error('创建计划任务失败：快捷方式将退回直接启动（会弹 UAC）');
}

// 开机启动开关：true = 任务带 onlogon 触发器；false = 重建为无触发器任务（静默拉起通道保留）
async function setAutoStart(enabled) {
  if (isDev) {
    // 开发模式退回登录项方式
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [app.getAppPath()] });
    settings.autoStart = enabled;
    saveSettings();
    buildTrayMenu();
    if (tray) tray.setContextMenu(trayMenu);
    return;
  }
  const ok = await psRegisterTask(enabled);
  settings.autoStart = !!ok && enabled;
  saveSettings();
  buildTrayMenu();
  if (tray) tray.setContextMenu(trayMenu);
  console.log('开机启动状态:', settings.autoStart ? '✅' : '❌');
}

// ---------- system tray ----------

function trayIconPath(name = 'tray-icon.png') {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', name);
  }
  return path.join(app.getAppPath(), 'resources', name);
}

// 按系统亮暗主题切换托盘图标（深色任务栏用白色图标，浅色用黑色图标）
function updateTrayIcon() {
  if (!tray) return;
  const name = nativeTheme.shouldUseDarkColors ? 'tray-icon-light.png' : 'tray-icon.png';
  const icon = nativeImage.createFromPath(trayIconPath(name));
  if (!icon.isEmpty()) tray.setImage(icon);
}

// 窗口图标跟随系统主题切换（与托盘图标一致：深色主题用白色，浅色用黑色）
function updateWindowIcon() {
  if (!win || win.isDestroyed()) return;
  const name = nativeTheme.shouldUseDarkColors ? 'tray-icon-light.png' : 'tray-icon.png';
  const icon = nativeImage.createFromPath(trayIconPath(name));
  if (!icon.isEmpty()) win.setIcon(icon);
}

// ---------- 全局快捷键 ----------
const DEFAULT_SHORTCUT = 'Control+Shift+V';

// 把 Electron accelerator 转成友好显示格式：Control+Shift+V -> Ctrl + Shift + V
function formatShortcut(accel) {
  return (accel || DEFAULT_SHORTCUT).split('+').map((part) => {
    const names = {
      Control: 'Ctrl',
      CommandOrControl: 'Ctrl',
      Super: 'Win',
      Meta: 'Win',
      Alt: 'Alt',
      Shift: 'Shift',
    };
    return names[part] || part;
  }).join(' + ');
}

// 注册/重注册全局呼出快捷键，返回是否成功
function registerToggleShortcut() {
  const accel = settings.shortcut || DEFAULT_SHORTCUT;
  try { globalShortcut.unregister(accel); } catch (_) { /* ignore */ }
  let ok = false;
  try {
    ok = globalShortcut.register(accel, togglePanel);
  } catch (err) {
    console.error('注册全局快捷键 ' + formatShortcut(accel) + ' 失败:', err.message);
  }
  if (!ok) console.error('注册全局快捷键 ' + formatShortcut(accel) + ' 失败（可能已被其他程序占用）');
  return ok;
}

// 把 DOM 按键 code（KeyV / Digit1 / F5 / ArrowUp 等）转成 accelerator 主键，无法映射返回 null
function codeToKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);       // 字母 A-Z
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);     // 数字 0-9
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;  // F1-F24
  const map = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  };
  return map[code] || null;
}

// 弹出窗口，让用户按下新的快捷键组合（Esc 取消）
// 开始更换快捷键：显示面板并进入捕获模式（面板临时获得焦点，按键由渲染进程捕获）
function startShortcutCapture() {
  if (shortcutCapturing) return; // 已在捕获中
  if (!win || win.isDestroyed()) return;
  // 若正处于搜索模式，先退回浏览模式，避免两个输入态叠加
  if (searchActive) exitSearchMode();
  const oldAccel = settings.shortcut || DEFAULT_SHORTCUT;
  shortcutCapturing = true;
  shortcutOldAccel = oldAccel;

  // 先注销旧全局快捷键，避免捕获期间按下它触发面板
  try { globalShortcut.unregister(oldAccel); } catch (_) { /* ignore */ }
  // 注销导航快捷键，让按键正常进入渲染进程
  unregisterNavShortcuts();

  // 显示面板（若已显示则原地不动）
  positionPanel();
  if (!panelVisible) {
    panelVisible = true;
    if (!win.isDestroyed()) win.webContents.send('panel:shown');
  }
  // 面板默认不抢焦点，捕获按键前临时改为可聚焦并聚焦
  try { win.setFocusable(true); } catch (_) { /* ignore */ }
  win.focus();
  if (!win.isDestroyed()) win.webContents.send('shortcut:capture-start', { current: formatShortcut(oldAccel) });
}

// 结束捕获并恢复旧快捷键（取消时调用）
function cancelShortcutCapture() {
  if (!shortcutCapturing) return;
  shortcutCapturing = false;
  if (shortcutOldAccel) {
    try { globalShortcut.register(shortcutOldAccel, togglePanel); } catch (_) { /* ignore */ }
  }
  shortcutOldAccel = null;
  // 恢复窗口不抢焦点，把焦点还回原程序
  if (win && !win.isDestroyed()) {
    try { win.setFocusable(false); } catch (_) { /* ignore */ }
    releasePanelFocus();
    win.webContents.send('shortcut:capture-end');
  }
  // 面板仍显示时恢复导航快捷键
  if (panelVisible) registerNavShortcuts();
}


function buildTrayMenu() {
  console.log('开机启动状态:', settings.autoStart ? '✅' : '❌');
  trayMenu = Menu.buildFromTemplate([
    { label: '显示剪贴板面板', click: () => showPanel() },
    { label: `更换快捷键(当前: ${formatShortcut(settings.shortcut)})`, click: () => startShortcutCapture() },
    { type: 'separator' },
    {
      label: '开机启动 ' + (settings.autoStart ? '✅' : '❌'),
      type: 'checkbox',
      checked: settings.autoStart,
      click: (item) => { void setAutoStart(item.checked); },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function createTray() {
  const iconPath = trayIconPath();
  if (!fs.existsSync(iconPath)) {
    console.error('Tray icon not found:', iconPath);
    return;
  }
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('剪贴板工具');
  updateTrayIcon();
  updateWindowIcon();
  nativeTheme.on('updated', () => {
    updateTrayIcon();
    updateWindowIcon();
  });
  buildTrayMenu();
  tray.setContextMenu(trayMenu);
  tray.on('click', () => showPanel());
  tray.on('double-click', () => showPanel());
}

// ---------- global click watcher ----------
// 点击界面外关闭面板：面板不抢焦点（WS_EX_NOACTIVATE），收不到 blur，
// 所以用一个全局低级鼠标钩子上报点击坐标，由主进程判断是否在面板外。

function clickWatcherPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', 'click-watcher.exe');
  }
  return path.join(app.getAppPath(), 'resources', 'click-watcher.exe');
}

function startClickWatcher() {
  const exe = clickWatcherPath();
  if (!fs.existsSync(exe)) {
    console.error('Click watcher not found:', exe);
    return;
  }
  clickWatcher = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  console.log('点击监听器已启动');
  clickWatcher.stdout.setEncoding('utf8');
  clickWatcher.stdout.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      const m = /^click (-?\d+) (-?\d+)/.exec(line.trim());
      if (m) handleGlobalClick(parseInt(m[1], 10), parseInt(m[2], 10));
    }
  });
  clickWatcher.on('exit', () => { clickWatcher = null; });
  clickWatcher.on('error', (err) => console.error('Click watcher error:', err.message));
}

function handleGlobalClick(x, y) {
  if (!win || win.isDestroyed() || !panelVisible) return;
  // 钩子坐标是物理像素，转成 DIP 再和窗口边界（DIP）比较。
  const dip = screen.screenToDipPoint({ x, y });
  const b = win.getBounds();
  if (dip.x >= b.x && dip.x <= b.x + b.width && dip.y >= b.y && dip.y <= b.y + b.height) return;
  hidePanel();
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    show: false,
    frame: false,
    transparent: false, // 修复：透明窗口(WS_EX_LAYERED)下真实鼠标点击无法进入渲染进程；改不透明窗口后点击恢复
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // 不可激活：呼出面板时输入框焦点保持不变
    alwaysOnTop: true,
    hasShadow: true, // 系统原生阴影（透明窗口时被迫关闭，不透明窗口可用）
    roundedCorners: true, // Windows 11 系统圆角
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 离屏驻留时也保持渲染，避免移回屏幕时内容先空白再重绘而闪烁
      backgroundThrottling: false,
    },
  });

  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));


  win.once('ready-to-show', () => {
    // 离屏方案：窗口只显示一次，之后“隐藏/呼出”只移动位置，避免透明窗口 show/hide 闪烁。
    // 关键：先在屏幕内显示一帧，让 DWM 完成透明窗口表面合成，再移到屏幕外；
    // 否则每次从屏幕外移入都要重新合成，呼出就会闪一下。
    win.setPosition(0, 0);
    win.showInactive(); // focusable:false，不会抢走输入框焦点
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.setPosition(-10000, 0);
      // Debug helper: `electron . --show-on-start` opens the panel at launch.
      if (process.argv.includes('--show-on-start')) showPanel();
    }, 120);
  });

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      hidePanel();
    }
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function positionPanel() {
  if (!win) return;
  // 固定在鼠标所在显示器的工作区正中间
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const [w, h] = win.getSize();
  const nx = Math.round(area.x + (area.width - w) / 2);
  const ny = Math.round(area.y + (area.height - h) / 2);
  // 位置没变就不移动，避免无谓的 DWM 重绘
  const [cx, cy] = win.getPosition();
  if (cx !== nx || cy !== ny) win.setPosition(nx, ny);
}

// 面板显示期间，全局拦截 ↑/↓/Enter/Esc/Space/Z/Del，只作用于剪贴板面板，不进入输入框。
// 第三项 = 是否在搜索模式下依然拦截：搜索模式里 Space/Z/Del 让位给搜索输入框
// （Space 需要在输入框内打出空格，Z/Del 需要用作文本编辑），↑↓/Enter/Esc 保持面板语义。
const NAV_SHORTCUTS = [
  ['Up', 'up', true],
  ['Down', 'down', true],
  ['Enter', 'enter', true],
  ['Esc', 'escape', true],
  ['Delete', 'delete', false],
  ['Z', 'pin', false],
  ['Space', 'search', false],
];

function registerNavShortcuts() {
  for (const [accelerator, action, enabledInSearch] of NAV_SHORTCUTS) {
    // 搜索模式下被让位的键不注册；IME 组合期间所有导航键暂停，交给输入法
    if ((!enabledInSearch && searchActive) || (searchActive && searchComposing)) continue;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (action === 'search') {
          enterSearchMode();
          return;
        }
        if (action === 'escape' && searchActive) {
          exitSearchMode();
          return;
        }
        sendPanelKey(action);
      });
      if (!ok) console.error(`注册导航快捷键 ${accelerator} 失败（可能被其他程序占用）`);
    } catch (err) {
      console.error(`注册导航快捷键 ${accelerator} 失败:`, err.message);
    }
  }
}

function unregisterNavShortcuts() {
  for (const [accelerator] of NAV_SHORTCUTS) {
    try { globalShortcut.unregister(accelerator); } catch (_) { /* ignore */ }
  }
}

function sendPanelKey(action) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('panel:key', action);
  }
}

// 把焦点还给原程序（仅当面板当前持有焦点时，避免影响其他前台窗口）
function releasePanelFocus() {
  if (win && !win.isDestroyed() && win.isFocused()) {
    try { win.blur(); } catch (_) { /* ignore */ }
  }
}

// 进入搜索模式：临时把面板窗口变为可聚焦并聚焦搜索输入框（支持正常输入/中文输入法），
// 同时切换导航快捷键集合（Space/Z/Del 让位给输入框）。
function enterSearchMode() {
  if (!win || win.isDestroyed() || !panelVisible || searchActive) return;
  searchActive = true;
  unregisterNavShortcuts();
  registerNavShortcuts();
  try { win.setFocusable(true); } catch (_) { /* ignore */ }
  win.focus();
  if (!win.isDestroyed()) win.webContents.send('panel:key', 'search-enter');
}

// 退出搜索模式：归还焦点给原程序，恢复浏览模式的导航快捷键集合。
function exitSearchMode() {
  if (!win || win.isDestroyed()) { searchActive = false; searchComposing = false; return; }
  if (!searchActive) return;
  searchActive = false;
  searchComposing = false;
  if (panelVisible) {
    unregisterNavShortcuts();
    registerNavShortcuts();
  }
  try { win.setFocusable(false); } catch (_) { /* ignore */ }
  releasePanelFocus();
  if (!win.isDestroyed()) win.webContents.send('panel:key', 'search-exit');
}

// 中文输入法组合期间：暂停搜索模式的导航键，让 ↑↓/Enter 等全部进入输入框
function setSearchComposing(composing) {
  if (searchComposing === !!composing) return;
  searchComposing = !!composing;
  if (searchActive && panelVisible) {
    unregisterNavShortcuts();
    registerNavShortcuts();
  }
}

function showPanel() {
  if (!win || win.isDestroyed()) return;
  positionPanel();
  panelVisible = true;
  // 每次呼出都重置搜索模式（渲染层在 panel:shown 里清空查询词）
  searchActive = false;
  searchComposing = false;
  try { win.setFocusable(false); } catch (_) { /* ignore */ }
  registerNavShortcuts();
  if (!win.isDestroyed()) win.webContents.send('panel:shown');
  // 不在这里 broadcast()：历史由 600ms 轮询实时推送，呼出时强制刷新反而导致列表重绘闪烁
}

function hidePanel() {
  if (!win || win.isDestroyed()) return;
  // 捕获快捷键过程中隐藏面板：先结束捕获（恢复旧快捷键）
  if (shortcutCapturing) cancelShortcutCapture();
  panelVisible = false;
  searchActive = false;
  searchComposing = false;
  unregisterNavShortcuts();
  // 若正处于搜索模式，把焦点还给原程序
  try { win.setFocusable(false); } catch (_) { /* ignore */ }
  releasePanelFocus();
  // 移到屏幕外而不是 hide()：避免透明窗口 show/hide 造成的闪烁
  win.setPosition(-10000, 0);
}

function togglePanel() {
  if (!win || win.isDestroyed()) return;
  if (panelVisible) hidePanel();
  else showPanel();
}

// ---------- paste back to the previously focused app ----------

function localPaste() {
  // SendKeys 模拟 Ctrl+V；应用整体提权运行，可穿透管理员目标窗口。
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; " +
    "[System.Windows.Forms.SendKeys]::SendWait('^v')";
  execFile(
    'powershell.exe',
    ['-NoProfile', '-STA', '-Command', script],
    { windowsHide: true },
    (err) => {
      if (err) console.error('Simulate paste (Ctrl+V) failed:', err.message);
    }
  );
}

function schedulePaste() {
  clearTimeout(pasteTimer);
  pasteTimer = setTimeout(() => {
    pasteTimer = null;
    // 等面板隐藏、焦点回到原输入框后再粘贴。
    // 应用整体提权运行，SendKeys 可穿透管理员目标窗口。
    localPaste();
  }, 180);
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('clipboard:get', () => history.map(toRendererEntry).filter(Boolean));
  ipcMain.handle('clipboard:copy', (_e, id) => {
    if (copyEntry(id)) {
      hidePanel();
      schedulePaste(); // Enter/双击复制后总是自动粘贴
      return true;
    }
    return false;
  });
  ipcMain.handle('clipboard:remove', (_e, id) => {
    const idx = history.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const [removed] = history.splice(idx, 1);
    if (removed.type === 'image' && removed.imagePath) {
      try { fs.unlinkSync(removed.imagePath); } catch (_) { /* ignore */ }
    }
    persist();
    broadcast();
    return true;
  });
  ipcMain.handle('clipboard:pin', (_e, id) => {
    const idx = history.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const [entry] = history.splice(idx, 1);
    if (entry.pinned) {
      // 取消置顶：回到普通块最前
      entry.pinned = false;
      let pinnedCount = 0;
      while (pinnedCount < history.length && history[pinnedCount].pinned) pinnedCount += 1;
      history.splice(pinnedCount, 0, entry);
    } else {
      // 置顶：标记并移动到置顶块最前
      entry.pinned = true;
      entry.pinnedAt = Date.now();
      history.unshift(entry);
    }
    persist();
    broadcast();
    return true;
  });
  ipcMain.handle('clipboard:clear', () => {
    for (const entry of history) {
      if (entry.type === 'image' && entry.imagePath) {
        try { fs.unlinkSync(entry.imagePath); } catch (_) { /* ignore */ }
      }
    }
    history = [];
    persist();
    broadcast();
    return true;
  });

  // 更换快捷键：渲染进程按下组合键后请求注册
  ipcMain.handle('shortcut:try', (_e, accel) => {
    if (typeof accel !== 'string' || !shortcutCapturing) {
      return { ok: false, formatted: formatShortcut(accel) };
    }
    const formatted = formatShortcut(accel);
    let ok = false;
    try {
      ok = globalShortcut.register(accel, togglePanel);
    } catch (err) {
      ok = false;
    }
    if (!ok) return { ok: false, formatted };
    // 成功：保存设置并更新托盘菜单
    shortcutCapturing = false;
    shortcutOldAccel = null;
    settings.shortcut = accel;
    saveSettings();
    buildTrayMenu();
    if (tray) tray.setContextMenu(trayMenu);
    console.log('全局快捷键已更换为:', formatted);
    // 恢复窗口不抢焦点
    if (win && !win.isDestroyed()) {
      try { win.setFocusable(false); } catch (_) { /* ignore */ }
    }
    // 面板仍显示时恢复导航快捷键
    if (panelVisible) registerNavShortcuts();
    return { ok: true, formatted };
  });
  ipcMain.handle('shortcut:cancel', () => {
    if (shortcutCapturing) cancelShortcutCapture();
    return true;
  });
  // 搜索：渲染层点击常驻搜索框时进入搜索模式（与按空格等效）
  ipcMain.handle('search:activate', () => {
    enterSearchMode();
    return true;
  });
  // 搜索：中文输入法组合中暂停面板导航键（↑↓/Enter 让给 IME 候选），组合结束恢复
  ipcMain.handle('search:set-composing', (_e, composing) => {
    setSearchComposing(!!composing);
    return true;
  });
  ipcMain.handle('window:hide', () => hidePanel());
}

// ---------- app lifecycle ----------

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showPanel());

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    createTray();
    startClickWatcher();
    loadHistory();
    loadSettings();
    ensureElevatedTask();
    syncBaseline();
    broadcast();

    registerToggleShortcut();

    pollTimer = setInterval(pollClipboard, POLL_INTERVAL);
  });

  app.on('before-quit', () => {
    isQuitting = true;
    clearInterval(pollTimer);
    clearTimeout(pasteTimer);
    globalShortcut.unregisterAll();
  });

  app.on('will-quit', () => {
    if (clickWatcher) {
      try { clickWatcher.stdin.end(); } catch (_) { /* ignore */ }
      try { clickWatcher.kill(); } catch (_) { /* ignore */ }
      clickWatcher = null;
    }
    if (tray) { tray.destroy(); tray = null; }
  });

  app.on('window-all-closed', () => {
    // Keep running in background for the global shortcut; the panel window
    // is only hidden, never really closed unless the app quits.
  });
}