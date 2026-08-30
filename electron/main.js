const {
  app, BrowserWindow, globalShortcut, clipboard, nativeImage,
  ipcMain, screen, Menu, Tray, nativeTheme
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createHistoryStore } = require('./history');
const { createPanelModes } = require('./panel-modes');
const { createJsonRpcHelper, spawnLineHelper, readOneShotJson } = require('./native-helper');
// transparent 窗口已接管圆角与阴影，无需 DWM acrylic 回退

const MAX_HISTORY = 200;
const MAX_NOTE_LENGTH = 200;
const POLL_INTERVAL = 600;
const PANEL_WIDTH = 418;
const PANEL_HEIGHT = 823;
// Hide just outside current display to keep DPI same (avoid -10000 cross-display drift)
function getHidePosition() {
  try {
    if (!win || win.isDestroyed()) return [-10000, 0];
    const b = win.getBounds();
    const d = screen.getDisplayMatching(b);
    const a = d.workArea;
    return [a.x + a.width + 20, a.y];
  } catch(e){ return [-10000, 0]; }
}

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let win = null;
let lastText = '';
let lastImageHash = '';
// 图片 dataUrl 缓存：broadcast 时对每个图片条目做 读盘+解码+PNG 重编码+base64，
// 实测 25 张图约 614ms 且全程阻塞主进程——这是「回车→粘贴」延迟的主因
// （粘贴前 copyEntry 的 commit() 会先触发一次 broadcast）。
// 图片文件创建后内容不变（条目身份规则），按 imagePath 永久缓存；
// 条目被裁剪/删除/清空时经 removeImageFile 端口同步失效，载入时整体清空。
const imageDataUrlCache = new Map();

// 「历史」领域核心：条目身份/去重/置顶块/裁剪/备注全部收在 store 的 interface 之后（electron/history.js），
// 这里注入文件系统效果端口；persist/broadcast 由本文件的 commit() 编排。
const store = createHistoryStore({
  max: MAX_HISTORY,
  maxNoteLength: MAX_NOTE_LENGTH,
  saveImagePng: (png, id) => {
    const imagePath = path.join(imagesDir(), `${id}.png`);
    try {
      fs.writeFileSync(imagePath, png);
      return imagePath;
    } catch (err) {
      console.error('Failed to save clipboard image:', err);
      return null;
    }
  },
  hashImageFile: (imagePath) => {
    try { return sha1(fs.readFileSync(imagePath)); } catch (_) { return ''; }
  },
  removeImageFile: (imagePath) => {
    imageDataUrlCache.delete(imagePath);
    try { fs.unlinkSync(imagePath); } catch (_) { /* ignore */ }
  },
  imageFileExists: (imagePath) => {
    try { return fs.existsSync(imagePath); } catch (_) { return false; }
  },
});
let settings = { autoStart: false, shortcut: 'Control+Shift+V' };
let isQuitting = false;
let pollTimer = null;
let tray = null;
let trayMenu = null;
let clickWatcher = null; // click-watcher.exe 的行通道句柄（助手 seam 返回）
let focusHelper = null; // focus-paste-helper.exe 的 JSON 请求通道（助手 seam 返回）
let showPanelPromise = null;

// 面板模式状态机（electron/panel-modes.js）：浏览/搜索/备注编辑/快捷键捕获的模式状态、
// 转换级联、全局热键集合推导全部在其 interface 之后；这里只注入窗口/通知/快照效果端口。
const modes = createPanelModes({
  registerKey: (accel, handler) => {
    try {
      const ok = globalShortcut.register(accel, handler);
      if (!ok) console.error(`注册全局快捷键 ${accel} 失败（可能被其他程序占用）`);
      return ok;
    } catch (err) {
      console.error(`注册全局快捷键 ${accel} 失败:`, err.message);
      return false;
    }
  },
  unregisterKey: (accel) => {
    try { globalShortcut.unregister(accel); } catch (_) { /* ignore */ }
  },
  canInteract: () => !!win && !win.isDestroyed(),
  focusPanel: () => {
    if (win && !win.isDestroyed()) win.focus();
  },
  blurPanelIfFocused: () => releasePanelFocus(),
  send: (channel, ...args) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  },
  captureFocus: async () => captureFocusTarget(),
  restoreFocus: (target) => {
    void restoreFocusOnly(target);
  },
  reportNoFocusTarget: () => sendFocusError({ stage: 'restore', reason: 'no_focus_target' }),
  validateNoteTarget: (targetId) => {
    if (targetId === null) return store.entries().length > 0;
    return typeof targetId === 'string' && !!store.find(targetId);
  },
  onToggleRequested: () => {
    void togglePanel();
  },
});

// ---------- persistence helpers ----------

function imagesDir() {
  const dir = path.join(app.getPath('userData'), 'images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 图标缓存：exePath -> dataUrl，避免重复提取
const iconCache = new Map();

function focusPasteHelperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', 'focus-paste-helper.exe');
  }
  return path.join(app.getAppPath(), 'resources', 'focus-paste-helper.exe');
}

// 焦点粘贴助手：常驻 JSON 行协议进程（snapshot/restore/paste）。
// spawn、行缓冲、请求 id、超时全部在助手 seam（electron/native-helper.js）里。
function startFocusPasteHelper() {
  const helper = focusPasteHelperPath();
  if (!fs.existsSync(helper)) {
    console.error('Focus paste helper not found:', helper);
    return;
  }
  focusHelper = createJsonRpcHelper({
    exePath: helper,
    timeoutMs: 2500,
    onStderr: (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error('Focus paste helper:', text);
    },
  });
}

function requestFocusHelper(command, target = null, timeout = 2500) {
  if (!focusHelper) {
    return Promise.reject(new Error('focus-paste-helper not running'));
  }
  return focusHelper.call(command, target, timeout);
}

// 获取 app-icon-helper.exe 路径
function appIconHelperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', 'app-icon-helper.exe');
  }
  return path.join(app.getAppPath(), 'resources', 'app-icon-helper.exe');
}

// 异步获取前台应用信息（方案A：轮询时抓取；一次性助手经 seam 运行并解析末行 JSON）
async function getForegroundAppInfo() {
  const helper = appIconHelperPath();
  if (!fs.existsSync(helper)) return null;
  try {
    const info = await readOneShotJson({ exePath: helper, timeoutMs: 1500 });
    if (!info || info.error) return null;
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
  const note = store.normalizeNote(entry.note);
  if (entry.type === 'image') {
    let dataUrl = '';
    if (entry.imagePath) {
      dataUrl = imageDataUrlCache.get(entry.imagePath) || '';
      if (!dataUrl) {
        try {
          if (fs.existsSync(entry.imagePath)) {
            dataUrl = nativeImage.createFromPath(entry.imagePath).toDataURL();
            if (dataUrl) imageDataUrlCache.set(entry.imagePath, dataUrl);
          }
        } catch (_) { /* ignore */ }
      }
    }
    if (!dataUrl) return null;
    return { id: entry.id, type: 'image', dataUrl, createdAt: entry.createdAt, sourceApp, pinned: !!entry.pinned, pinnedAt: entry.pinnedAt || 0, note };
  }
  return { id: entry.id, type: 'text', text: entry.text ?? '', createdAt: entry.createdAt, sourceApp, pinned: !!entry.pinned, pinnedAt: entry.pinnedAt || 0, note };
}

function persist() {
  try {
    fs.writeFileSync(historyFile(), JSON.stringify(store.toJSON()));
  } catch (err) {
    console.error('Failed to persist history:', err);
  }
}

function loadHistory() {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
  } catch (_) { /* first run or unreadable file */ }
  imageDataUrlCache.clear();
  store.load(parsed);
  // 预热图标缓存：从历史中已有的 sourceApp 恢复，避免重复提取
  try {
    for (const e of store.entries()) {
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
// 排序/去重/置顶块/裁剪的全部规则都在 store（electron/history.js）的 interface 之后；
// 本节只做效果编排：一次变更 = store 方法 + commit()（persist + broadcast）。

function commit() {
  persist();
  broadcast();
}

function addTextEntry(text, sourceApp) {
  const { entry } = store.recordText(text, sourceApp);
  if (entry) commit();
}

function addImageEntry(image, sourceApp) {
  const png = image.toPNG();
  if (!png || png.length === 0) return;
  const hash = sha1(png);
  if (hash === lastImageHash) return;
  const { entry } = store.recordImage(png, sourceApp);
  if (!entry) return; // 写盘失败：不动轮询基线，下次轮询重试
  lastImageHash = hash;
  commit();
}

function broadcast() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('clipboard:updated', store.entries().map(toRendererEntry).filter(Boolean));
  }
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
  const entry = store.find(id);
  if (!entry) return false;
  if (entry.type === 'text') {
    clipboard.writeText(entry.text || '');
  } else if (entry.type === 'image' && entry.imagePath && fs.existsSync(entry.imagePath)) {
    clipboard.writeImage(nativeImage.createFromPath(entry.imagePath));
  } else {
    return false;
  }
  // 复制后的落位与去重提升是同一规则（置顶刷新 pinnedAt 移块首；普通移普通块最前）
  store.promote(entry);
  commit();
  // 同步轮询基线：刚写进剪贴板的内容不应在下一个 600ms 轮询里被当成"新复制"
  // 再次提升+广播（一次多余的全列表重绘，也是粘贴后闪烁的来源）
  syncBaseline();
  return true;
}

// ---------- settings ----------

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    // 只吸收已知键：旧版本遗留的 autoPaste / helperToken 等废弃字段不进入内存、不再写回
    for (const key of ['autoStart', 'shortcut']) {
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
// 注意：这段注册脚本与 resources/task-launcher.cs 的 CreateTask 是同一件事的两种语言实现
// （安装期启动器无法复用本文件的 JS），差异仅在触发器：本文件按 autoStart 开关带/不带
// AtLogOn 触发器，task-launcher 只创建无触发器版本。改动任务名/Principal 需两处同步。
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

// 确保静默拉起通道存在，并按持久化设置保留/移除开机启动触发器。
async function ensureElevatedTask() {
  if (isDev) return; // 开发模式跑 electron.exe，无提权清单，不需要任务
  const ok = await psRegisterTask(settings.autoStart);
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

// Windows 托盘 HICON 由 Electron 直接用 NativeImage 的 1x 位图生成
// （GetHICON -> IconUtil::CreateHICONFromSkBitmap(AsBitmap())，不带尺寸参数），
// 系统再把它画到 SM_CXSMICON 物理像素上：位图不是恰好目标尺寸就会被重采样发糊，
// PNG 的 @2x 式 DPI 阶梯在该路径完全不被使用。因此按主屏 scaleFactor 选一张
// 「恰好 round(16*scale) 物理像素」的单一尺寸图（scripts/gen-tray-icons.mjs 生成），
// HICON 1:1 渲染零重采样。
const TRAY_ICON_SIZES = [16, 20, 24, 28, 32]; // 100%..200% 缩放档位

function trayTargetSize() {
  let sf = 1;
  try { sf = screen.getPrimaryDisplay().scaleFactor || 1; } catch (_) { /* ignore */ }
  const target = Math.round(16 * sf);
  return TRAY_ICON_SIZES.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), TRAY_ICON_SIZES[0]);
}

// 按系统亮暗主题与 DPI 选托盘图（深色任务栏用白色图标，浅色用黑色图标）
function loadTrayIcon() {
  const base = nativeTheme.shouldUseDarkColors ? 'tray-icon-light' : 'tray-icon';
  const sized = nativeImage.createFromPath(trayIconPath(`${base}-${trayTargetSize()}.png`));
  if (!sized.isEmpty()) return sized;
  return nativeImage.createFromPath(trayIconPath(`${base}.png`)); // 缺分尺寸图时回退 32px 基图
}

let trayIconKey = '';
function updateTrayIcon() {
  if (!tray) return;
  // 同主题同尺寸时跳过，display-metrics-changed 高频触发也不重复 setImage
  const key = `${nativeTheme.shouldUseDarkColors ? 'light' : 'dark'}@${trayTargetSize()}`;
  if (key === trayIconKey) return;
  const icon = loadTrayIcon();
  if (icon.isEmpty()) return;
  trayIconKey = key;
  tray.setImage(icon);
}

// 窗口图标跟随系统主题切换（走 32px 基图：窗口图标路径由系统多尺寸缩放，无托盘 HICON 问题）
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

// 弹出窗口，让用户按下新的快捷键组合（Esc 取消）
// 开始更换快捷键：进入捕获模式（模式机先退出其它输入态并注销全部全局键），
// 随后显示面板并聚焦，让渲染进程捕获按键。
async function startShortcutCapture() {
  if (!win || win.isDestroyed()) return;
  if (!(await modes.beginShortcutCapture())) return;
  await showPanel({ capture: false });
  if (!win || win.isDestroyed()) return;
  // 捕获按键前聚焦面板（基线 focusable:true，直接 focus 即可）
  win.focus();
  win.webContents.send('shortcut:capture-start', { current: formatShortcut(settings.shortcut) });
}


function buildTrayMenu() {
  console.log('开机启动状态:', settings.autoStart ? '✅' : '❌');
  trayMenu = Menu.buildFromTemplate([
    { label: '显示剪贴板面板', click: () => { void showPanel({ capture: true }); } },
    { label: `更换快捷键(当前: ${formatShortcut(settings.shortcut)})`, click: () => { void startShortcutCapture(); } },
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
  if (!fs.existsSync(trayIconPath())) {
    console.error('Tray icon not found:', trayIconPath());
    return;
  }
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('剪贴板工具');
  updateTrayIcon();
  updateWindowIcon();
  nativeTheme.on('updated', () => {
    updateTrayIcon();
    updateWindowIcon();
  });
  // 修改缩放比或拖到不同 DPI 显示器时 SM_CXSMICON 随之变化，重选对应物理尺寸
  try { screen.on('display-metrics-changed', () => { updateTrayIcon(); }); } catch (_) { /* ignore */ }
  buildTrayMenu();
  tray.setContextMenu(trayMenu);
  tray.on('click', () => { void showPanel({ capture: true }); });
  tray.on('double-click', () => { void showPanel({ capture: true }); });
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
  // 行缓冲由助手 seam 统一提供：此前 chunk.split('\n') 在事件跨 chunk 边界时会静默丢点击
  clickWatcher = spawnLineHelper({
    exePath: exe,
    ignoreStderr: true,
    onLine: (line) => {
      const m = /^click (-?\d+) (-?\d+)/.exec(line);
      if (m) handleGlobalClick(parseInt(m[1], 10), parseInt(m[2], 10));
    },
    onExit: () => { clickWatcher = null; },
    onError: (err) => console.error('Click watcher error:', err.message),
  });
  console.log('点击监听器已启动');
}

function handleGlobalClick(x, y) {
  if (!win || win.isDestroyed() || !modes.isPanelVisible()) return;
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
    // 圆角方案：关闭系统圆角，改由 CSS 完全接管。
    // transparent:true 赋予 per-pixel alpha，CSS 的 --radius-window (12px) 才能裁出真实窗口外形（非仅内裁 DWM 形状）。
    // focusable:true 保持可激活以保证点击可交付；呼出时用 showInactive + blur 模拟“不抢焦点”（hook 方案在 Electron 43 仅观察无效）。
    transparent: true,
    backgroundColor: '#00000000',
    backgroundMaterial: undefined,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true, // 保持可激活以接收点击，靠 showInactive + blur 模拟不抢焦点
    alwaysOnTop: true,
    hasShadow: false, // 透明窗口无 DWM 阴影，改由 CSS --shadow-window 绘制，贴合 CSS 圆角
    roundedCorners: false, // 关闭系统 8px，用 CSS --radius-window 统一控制
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 离屏驻留时也保持渲染，避免移回屏幕时内容先空白再重绘而闪烁
      backgroundThrottling: false,
    },
  });

  // 浏览态自动失焦：focusable:true 下点击会激活窗口，浏览态下立即 blur 将焦点还回原程序，
  // 输入态（搜索/备注编辑/快捷键捕获）则保留焦点以便输入。输入态判断由模式状态机给出。
  win.on('focus', () => {
    if (modes.isInputActive()) return;
    // 延迟一帧再 blur，让点击事件先进入渲染进程，避免在 mousedown 前就失焦吃掉点击
    setTimeout(() => {
      if (!win || win.isDestroyed() || !modes.isPanelVisible()) return;
      if (modes.isInputActive()) return;
      if (!win.isFocused()) return;
      try { win.blur(); } catch (_) { /* ignore */ }
    }, 0);
  });

  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));


  win.once('ready-to-show', () => {
    try { win.setContentBounds({ x: 0, y: 0, width: PANEL_WIDTH, height: PANEL_HEIGHT }); } catch(e){ win.setBounds({ x: 0, y: 0, width: PANEL_WIDTH, height: PANEL_HEIGHT }); }
    win.showInactive();
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [hx, hy] = getHidePosition();
      try { win.setBounds({ x: hx, y: hy, width: PANEL_WIDTH, height: PANEL_HEIGHT }); } catch(e){ try{ win.setPosition(hx, hy); }catch(_){} }
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

  // 透明窗口：无需 DWM acrylic 回退，保持 '#00000000' 让 CSS 材质与圆角完全自洽
}


function positionPanel() {
  try {
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    if (!cursor || typeof cursor.x !== "number" || typeof cursor.y !== "number" || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) {
      console.error("positionPanel: invalid cursor", cursor);
      return;
    }
    const display = screen.getDisplayNearestPoint(cursor);
    if (!display || !display.workArea) {
      console.error("positionPanel: invalid display", display);
      return;
    }
    const area = display.workArea;
    // Use fixed panel size to avoid DPI drift when window is off-screen
    let w = PANEL_WIDTH, h = PANEL_HEIGHT;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      console.error("positionPanel: invalid size", w, h);
      return;
    }
    if (!Number.isFinite(area.x) || !Number.isFinite(area.y) || !Number.isFinite(area.width) || !Number.isFinite(area.height)) {
      console.error("positionPanel: invalid workArea", area);
      return;
    }
    const nx = Math.round(area.x + (area.width - w) / 2);
    const ny = Math.round(area.y + (area.height - h) / 2);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      console.error("positionPanel: invalid target", nx, ny, { area, w, h });
      return;
    }
    let cx, cy;
    try { [cx, cy] = win.getPosition(); } catch (e) { cx = null; cy = null; }
    // Use setBounds with fixed size to prevent DPI drift
    try {
      const curBounds = win.getBounds();
      if (curBounds.x !== nx || curBounds.y !== ny || curBounds.width !== PANEL_WIDTH || curBounds.height !== PANEL_HEIGHT) {
        win.setBounds({ x: nx, y: ny, width: PANEL_WIDTH, height: PANEL_HEIGHT });
      }
    } catch (e) {
      try { win.setPosition(nx, ny); } catch(_){}
    }
  } catch (e) {
    console.error("positionPanel: unexpected error", e);
  }
}

// 把焦点还给原程序（仅当面板当前持有焦点时，避免影响其他前台窗口）
function releasePanelFocus() {
  if (win && !win.isDestroyed() && win.isFocused()) {
    try { win.blur(); } catch (_) { /* ignore */ }
  }
}

async function showPanel({ capture = false } = {}) {
  if (!win || win.isDestroyed()) return;
  if (showPanelPromise) return showPanelPromise;
  showPanelPromise = (async () => {
    if (capture) await modes.ensureFocusTarget({ reportOnFailure: false });
    if (!win || win.isDestroyed()) return;
    positionPanel();
    // 模式状态机负责：重置搜索/备注态、推导注册导航键、通知渲染层（panel:shown）
    modes.show();
    // 不在这里 broadcast()：历史由 600ms 轮询实时推送，呼出时强制刷新反而导致列表重绘闪烁
  })().finally(() => {
    showPanelPromise = null;
  });
  return showPanelPromise;
}

function hidePanel({ restoreFocus = true } = {}) {
  if (!win || win.isDestroyed()) return;
  // 模式状态机负责：逐层退出捕获/备注/搜索（发对退出事件）、注销导航键、消费焦点快照
  modes.hide({ restoreFocus });
  // 移到同显示器屏幕外（保持 DPI 一致）
  try {
    const [hx, hy] = getHidePosition();
    try { win.setContentBounds({ x: hx, y: hy, width: PANEL_WIDTH, height: PANEL_HEIGHT }); } catch(e){ win.setBounds({ x: hx, y: hy, width: PANEL_WIDTH, height: PANEL_HEIGHT }); }
  } catch(e){ try{ win.setPosition(-10000, 0); }catch(_){} }
}

function togglePanel() {
  if (!win || win.isDestroyed()) return;
  if (modes.isPanelVisible()) hidePanel();
  else void showPanel({ capture: true });
}

// ---------- focus snapshot, restore and paste ----------

// 焦点恢复/粘贴失败的用户文案（唯一映射处）：panel:focus-error 事件与
// clipboard:copy 的结果契约共用同一份文本。
function focusErrorMessage(stage) {
  return stage === 'paste'
    ? '复制已写入剪贴板，但无法粘贴回原输入框，请重试。'
    : '无法恢复原输入框，已取消本次粘贴，避免写入错误窗口。';
}

function sendFocusError(result = {}) {
  if (!win || win.isDestroyed()) return;
  const stage = result.stage || 'restore';
  const reason = result.reason || (stage === 'paste' ? 'paste_send_failed' : 'restore_failed');
  win.webContents.send('panel:focus-error', { stage, reason, message: focusErrorMessage(stage) });
}

async function captureFocusTarget() {
  try {
    const result = await requestFocusHelper('snapshot');
    if (!result || result.ok !== true || !result.target) return null;
    return result.target;
  } catch (_) {
    return null;
  }
}

async function restoreFocusOnly(target) {
  if (!target) return true;
  try {
    const result = await requestFocusHelper('restore', target);
    if (result && result.ok) return true;
    sendFocusError(result || { stage: 'restore', reason: 'restore_failed' });
    return false;
  } catch (_) {
    sendFocusError({ stage: 'restore', reason: 'helper_not_available' });
    return false;
  }
}

// 恢复原窗口焦点并注入 Ctrl+V。返回结果契约 { ok, stage, reason }：
// 失败时仍会通过 panel:focus-error 推送同样的错误详情（键盘路径依赖该事件）。
async function restoreFocusAndPaste(target = modes.focusTargetSnapshot()) {
  if (!target) {
    sendFocusError({ stage: 'restore', reason: 'no_focus_target' });
    return { ok: false, stage: 'restore', reason: 'no_focus_target' };
  }
  try {
    const result = await requestFocusHelper('paste', target);
    if (result && result.ok) return { ok: true, stage: 'paste', reason: '' };
    const stage = (result && result.stage) || 'paste';
    const reason = (result && result.reason) || 'paste_send_failed';
    sendFocusError(result || { stage, reason });
    return { ok: false, stage, reason };
  } catch (_) {
    sendFocusError({ stage: 'paste', reason: 'helper_not_available' });
    return { ok: false, stage: 'paste', reason: 'helper_not_available' };
  }
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('clipboard:get', () => store.entries().map(toRendererEntry).filter(Boolean));
  // 复制并粘贴：三个入口（键盘 Enter / 双击 / 复制按钮）共用同一个结果契约
  // { ok, message }，渲染层按契约渲染，错误文案与 panel:focus-error 事件同源。
  ipcMain.handle('clipboard:copy', async (_e, id) => {
    if (!copyEntry(id)) {
      return { ok: false, message: '条目不存在或内容已不可用。' };
    }
    const pasteResult = await restoreFocusAndPaste();
    if (!pasteResult.ok) {
      return { ok: false, message: focusErrorMessage(pasteResult.stage) };
    }
    hidePanel({ restoreFocus: false });
    return { ok: true, message: '已复制并粘贴' };
  });
  ipcMain.handle('clipboard:remove', (_e, id) => {
    if (!store.remove(id)) return false;
    commit();
    return true;
  });
  ipcMain.handle('clipboard:pin', (_e, id) => {
    if (!store.togglePin(id)) return false;
    commit();
    return true;
  });
  ipcMain.handle('clipboard:clear', () => {
    store.clear();
    commit();
    return true;
  });

  // 备注：保存、进入编辑、退出编辑
  ipcMain.handle('note:set', (_e, id, note) => {
    if (typeof id !== 'string') return false;
    if (!store.setNote(id, note)) return false;
    commit();
    return true;
  });
  ipcMain.handle('note:begin-edit', (_e, id) => {
    if (!win || win.isDestroyed()) return false;
    return modes.beginNoteEdit(id);
  });
  ipcMain.handle('note:end-edit', () => {
    modes.endNoteEdit();
    return true;
  });

  // 更换快捷键：渲染进程按下组合键后请求注册
  ipcMain.handle('shortcut:try', (_e, accel) => {
    const formatted = formatShortcut(accel);
    if (!modes.trySetToggleShortcut(accel)) {
      return { ok: false, formatted };
    }
    // 成功：保存设置并更新托盘菜单
    settings.shortcut = accel;
    saveSettings();
    buildTrayMenu();
    if (tray) tray.setContextMenu(trayMenu);
    console.log('全局快捷键已更换为:', formatted);
    // 恢复焦点给原程序（导航键恢复已由模式状态机完成）
    if (win && !win.isDestroyed()) modes.restoreOriginalFocus();
    return { ok: true, formatted };
  });
  ipcMain.handle('shortcut:cancel', () => {
    modes.cancelShortcutCapture();
    return true;
  });
  // 搜索：渲染层点击常驻搜索框时进入搜索模式（与按空格等效）
  ipcMain.handle('search:activate', async () => {
    if (win && !win.isDestroyed()) await modes.beginSearch();
    return true;
  });
  // 搜索：中文输入法组合中暂停面板导航键（↑↓/Enter 让给 IME 候选），组合结束恢复
  ipcMain.handle('search:set-composing', (_e, composing) => {
    modes.setComposing(!!composing);
    return true;
  });
  ipcMain.handle('window:hide', () => hidePanel());
  ipcMain.handle('window:set-ignore-mouse', (_e, ignore, forward) => {
    if (!win || win.isDestroyed()) return false;
    try { win.setIgnoreMouseEvents(!!ignore, forward ? { forward: true } : undefined); } catch (_) { /* ignore */ }
    return true;
  });
}

// ---------- app lifecycle ----------

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    void showPanel({ capture: true });
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    startFocusPasteHelper();
    // 托盘状态和计划任务都由持久化设置决定，先加载再创建菜单。
    loadSettings();
    createWindow();
    createTray();
    startClickWatcher();
    loadHistory();
    ensureElevatedTask();
    syncBaseline();
    broadcast();

    // 呼出快捷键也归模式状态机的差量注册管理（捕获/恢复都由它推导）
    modes.setToggleShortcut(settings.shortcut || DEFAULT_SHORTCUT);

    pollTimer = setInterval(pollClipboard, POLL_INTERVAL);
  });

  app.on('before-quit', () => {
    isQuitting = true;
    clearInterval(pollTimer);
    globalShortcut.unregisterAll();
  });

  app.on('will-quit', () => {
    if (focusHelper) {
      focusHelper.stop();
      focusHelper = null;
    }
    if (clickWatcher) {
      clickWatcher.stop();
      clickWatcher = null;
    }
    if (tray) { tray.destroy(); tray = null; }
  });

  app.on('window-all-closed', () => {
    // Keep running in background for the global shortcut; the panel window
    // is only hidden, never really closed unless the app quits.
  });
}



