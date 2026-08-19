const {
  app, BrowserWindow, globalShortcut, clipboard, nativeImage,
  ipcMain, screen, Menu, Tray, nativeTheme
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const net = require('net');

const MAX_HISTORY = 200;
const POLL_INTERVAL = 600;
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 560;
const SHADOW_MARGIN = 20; // 透明边距，给 CSS 投影留空间

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let win = null;
let panelVisible = false; // 面板是否处于呼出状态（离屏隐藏时不依赖 win.isVisible()）
let history = [];
let lastText = '';
let lastImageHash = '';
let settings = { autoPaste: true, elevatedPaste: false, helperToken: '', shortcut: 'Control+Shift+V' };
let isQuitting = false;
let pollTimer = null;
let pasteTimer = null;
let helperSocket = null;
let helperServer = null;
let helperWaitTimer = null;
let tray = null;
let trayMenu = null;
let clickWatcher = null;
let shortcutCapturing = false; // 是否正在等待用户按下新快捷键
let shortcutOldAccel = null; // 捕获前的旧快捷键（取消时恢复）

// ---------- persistence helpers ----------

function imagesDir() {
  const dir = path.join(app.getPath('userData'), 'images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function historyFile() {
  return path.join(app.getPath('userData'), 'clipboard-history.json');
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function toRendererEntry(entry) {
  if (entry.type === 'image') {
    let dataUrl = '';
    try {
      if (entry.imagePath && fs.existsSync(entry.imagePath)) {
        dataUrl = nativeImage.createFromPath(entry.imagePath).toDataURL();
      }
    } catch (_) { /* ignore */ }
    if (!dataUrl) return null;
    return { id: entry.id, type: 'image', dataUrl, createdAt: entry.createdAt };
  }
  return { id: entry.id, type: 'text', text: entry.text ?? '', createdAt: entry.createdAt };
}

function persist() {
  try {
    const data = history.map(({ id, type, text, imagePath, createdAt }) => ({
      id, type, text, imagePath, createdAt
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
  history = history.slice(0, MAX_HISTORY);
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

function trimHistory() {
  if (history.length <= MAX_HISTORY) return;
  const removed = history.splice(MAX_HISTORY);
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

function addTextEntry(text) {
  if (!text) return;
  if (history[0] && history[0].type === 'text' && history[0].text === text) return;
  history.unshift({ id: crypto.randomUUID(), type: 'text', text, createdAt: Date.now() });
  trimHistory();
  persist();
  broadcast();
}

function addImageEntry(image) {
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
  history.unshift({ id, type: 'image', imagePath, createdAt: Date.now() });
  lastImageHash = hash;
  trimHistory();
  persist();
  broadcast();
}

function pollClipboard() {
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const png = image.toPNG();
    const hash = png && png.length ? sha1(png) : '';
    if (hash && hash !== lastImageHash) addImageEntry(image);
    lastText = clipboard.readText() || '';
    return;
  }
  const text = clipboard.readText();
  if (text && text !== lastText) addTextEntry(text);
  lastText = text;
  lastImageHash = '';
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
  history.unshift(entry);
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
    settings = { ...settings, ...parsed };
  } catch (_) { /* first run */ }
  if (!settings.helperToken) {
    settings.helperToken = crypto.randomBytes(16).toString('hex');
    saveSettings();
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings));
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

// ---------- elevated paste helper ----------
// 提权助手以管理员权限运行，通过命名管道接收粘贴指令，
// 用 SendInput 发送 Ctrl+V，从而可以粘贴进管理员权限的目标程序。

const HELPER_PIPE = '\\\\.\\pipe\\ClipboardToolElevatedHelper';

function helperExePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', 'elevated-helper.exe');
  }
  return path.join(app.getAppPath(), 'resources', 'elevated-helper.exe');
}

// 管道方向：主进程（普通权限）是服务端，提权助手（管理员权限）作为客户端连进来。
// 高完整性进程连接低完整性进程的管道是被允许的，反向则会被拒绝。
function startHelperPipeServer() {
  helperServer = net.createServer((socket) => {
    if (helperSocket && helperSocket !== socket) helperSocket.destroy();
    helperSocket = socket;
    console.log('提权助手已连接');
    socket.on('close', () => {
      if (helperSocket === socket) helperSocket = null;
    });
    socket.on('error', () => {});
  });
  helperServer.on('error', (err) => {
    console.error('Helper pipe server error:', err.message);
  });
  helperServer.listen(HELPER_PIPE);
}

function helperRunning() {
  return !!helperSocket && !helperSocket.destroyed;
}

function startHelperElevated() {
  return new Promise((resolve) => {
    const exe = helperExePath();
    if (!fs.existsSync(exe)) {
      console.error('Elevated helper not found:', exe);
      resolve({ started: false, canceled: false });
      return;
    }
    const script =
      "Start-Process -FilePath '" + exe.replace(/'/g, "''") +
      "' -ArgumentList '--token','" + settings.helperToken +
      "' -Verb RunAs -WindowStyle Hidden";
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true }, (err) => {
      if (err) {
        // UAC 被取消或启动失败
        console.error('Failed to start elevated helper:', err.message);
        resolve({ started: false, canceled: true });
        return;
      }
      // UAC 已确认，等待助手连上管道（用户可能点得慢，多等一会）
      let tries = 0;
      const poll = () => {
        tries += 1;
        if (helperRunning()) {
          resolve({ started: true, canceled: false });
          return;
        }
        if (tries >= 120) {
          resolve({ started: false, canceled: false });
          return;
        }
        setTimeout(poll, 500);
      };
      setTimeout(poll, 300);
    });
  });
}

// 启动后一直没连上（例如 UAC 响应很慢）：后台继续等，连上后自动启用并通知界面。
function waitForHelperThenEnable() {
  if (helperWaitTimer) return;
  let tries = 0;
  helperWaitTimer = setInterval(() => {
    tries += 1;
    if (helperRunning()) {
      clearInterval(helperWaitTimer);
      helperWaitTimer = null;
      settings.elevatedPaste = true;
      saveSettings();
      if (win && !win.isDestroyed()) {
        win.webContents.send('elevated:status', { enabled: true, running: true });
      }
      return;
    }
    if (tries >= 180) {
      clearInterval(helperWaitTimer);
      helperWaitTimer = null;
    }
  }, 1000);
}

function sendHelperCommand(command) {
  return new Promise((resolve, reject) => {
    if (!helperRunning()) {
      reject(new Error('elevated helper not connected'));
      return;
    }
    helperSocket.write(`${command} ${settings.helperToken}\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
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

function setOpenAtLogin(enabled) {
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } else {
    // 开发模式：开机启动 electron.exe 并带上项目目录参数
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: [app.getAppPath()],
    });
  }
  buildTrayMenu();
  if (tray) tray.setContextMenu(trayMenu);
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
  // 恢复窗口不抢焦点
  if (win && !win.isDestroyed()) {
    try { win.setFocusable(false); } catch (_) { /* ignore */ }
    win.webContents.send('shortcut:capture-end');
  }
  // 面板仍显示时恢复导航快捷键
  if (panelVisible) registerNavShortcuts();
}


function buildTrayMenu() {
  // 开发模式用 `electron .` 启动，注册表里存的是绝对路径参数，
  // 必须用相同的 path+args 去查，否则 openAtLogin 会一直是 false。
  let openAtLogin = false;
  if (app.isPackaged) {
    openAtLogin = app.getLoginItemSettings().openAtLogin;
  } else {
    openAtLogin = app.getLoginItemSettings({ path: process.execPath, args: [app.getAppPath()] }).openAtLogin;
  }
  console.log('开机启动状态:', openAtLogin ? '✅' : '❌');
  trayMenu = Menu.buildFromTemplate([
    { label: '显示剪贴板面板', click: () => showPanel() },
    { label: `更换快捷键(当前: ${formatShortcut(settings.shortcut)})`, click: () => startShortcutCapture() },
    { type: 'separator' },
    {
      label: '开机启动 ' + (openAtLogin ? '✅' : '❌'),
      type: 'checkbox',
      checked: openAtLogin,
      click: (item) => setOpenAtLogin(item.checked),
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
    width: PANEL_WIDTH + SHADOW_MARGIN * 2,
    height: PANEL_HEIGHT + SHADOW_MARGIN * 2,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // 不可激活：呼出面板时输入框焦点保持不变
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: false, // 关闭系统原生阴影/圆角，避免透明圆角外出现阴影块
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

// 面板显示期间，全局拦截 ↑/↓/Enter/Esc，只作用于剪贴板面板，不进入输入框。
const NAV_SHORTCUTS = [
  ['Up', 'up'],
  ['Down', 'down'],
  ['Enter', 'enter'],
  ['Esc', 'escape'],
  ['Delete', 'delete'],
];

function registerNavShortcuts() {
  for (const [accelerator, action] of NAV_SHORTCUTS) {
    try {
      const ok = globalShortcut.register(accelerator, () => sendPanelKey(action));
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

function showPanel() {
  if (!win || win.isDestroyed()) return;
  positionPanel();
  panelVisible = true;
  registerNavShortcuts();
  if (!win.isDestroyed()) win.webContents.send('panel:shown');
  // 不在这里 broadcast()：历史由 600ms 轮询实时推送，呼出时强制刷新反而导致列表重绘闪烁
}

function hidePanel() {
  if (!win || win.isDestroyed()) return;
  // 捕获快捷键过程中隐藏面板：先结束捕获（恢复旧快捷键）
  if (shortcutCapturing) cancelShortcutCapture();
  panelVisible = false;
  unregisterNavShortcuts();
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
  // 普通粘贴：SendKeys 模拟 Ctrl+V（无法进入管理员权限程序）。
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
    if (settings.elevatedPaste) {
      sendHelperCommand('paste')
        .catch(() =>
          startHelperElevated().then((res) => {
            if (!res.started) {
              console.error('提权助手不可用，回退到普通 SendKeys 粘贴');
              localPaste();
              return;
            }
            return sendHelperCommand('paste').catch((err) => {
              console.error('提权粘贴失败:', err.message);
              localPaste();
            });
          })
        );
    } else {
      localPaste();
    }
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

  ipcMain.handle('clipboard:get-elevated-paste', () => ({
    enabled: settings.elevatedPaste,
    running: helperRunning(),
  }));
  ipcMain.handle('clipboard:set-elevated-paste', async (_e, value) => {
    if (value) {
      if (helperRunning()) {
        settings.elevatedPaste = true;
        saveSettings();
        return { enabled: true, running: true, canceled: false, waiting: false };
      }
      const res = await startHelperElevated();
      if (res.started) {
        settings.elevatedPaste = true;
        saveSettings();
        return { enabled: true, running: true, canceled: false, waiting: false };
      }
      if (res.canceled) {
        settings.elevatedPaste = false;
        saveSettings();
        return { enabled: false, running: false, canceled: true, waiting: false };
      }
      // 启动后暂时没连上（UAC 响应慢）：后台继续等，连上后自动启用。
      waitForHelperThenEnable();
      return { enabled: false, running: false, canceled: false, waiting: true };
    }
    settings.elevatedPaste = false;
    saveSettings();
    return { enabled: false, running: helperRunning(), canceled: false, waiting: false };
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
    startHelperPipeServer();
    registerIpc();
    createWindow();
    createTray();
    startClickWatcher();
    loadHistory();
    loadSettings();
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
    if (helperRunning()) {
      helperSocket.write(`quit ${settings.helperToken}\n`, () => {
        try { helperSocket.end(); } catch (_) { /* ignore */ }
      });
    }
  });

  app.on('will-quit', () => {
    if (clickWatcher) {
      try { clickWatcher.stdin.end(); } catch (_) { /* ignore */ }
      try { clickWatcher.kill(); } catch (_) { /* ignore */ }
      clickWatcher = null;
    }
    if (tray) { tray.destroy(); tray = null; }
    if (helperServer) {
      try { helperServer.close(); } catch (_) { /* ignore */ }
    }
  });

  app.on('window-all-closed', () => {
    // Keep running in background for the global shortcut; the panel window
    // is only hidden, never really closed unless the app quits.
  });
}












