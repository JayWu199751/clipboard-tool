const {
  app, BrowserWindow, globalShortcut, clipboard, nativeImage,
  ipcMain, screen, Menu, Tray, nativeTheme
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
// transparent 窗口已接管圆角与阴影，无需 DWM acrylic 回退

const MAX_HISTORY = 200;
const MAX_NOTE_LENGTH = 200;
const POLL_INTERVAL = 600;
const PANEL_WIDTH = 418;
const PANEL_HEIGHT = 823;

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let win = null;
let panelVisible = false; // 面板是否处于呼出状态（离屏隐藏时不依赖 win.isVisible()）
let history = [];
let lastText = '';
let lastImageHash = '';
// 图片内容哈希缓存：entry.id -> sha1，用于全历史按内容判定同一条目（图片文件创建后不会变化）
const imageHashCache = new Map();
let settings = { autoStart: false, shortcut: 'Control+Shift+V' };
let isQuitting = false;
let pollTimer = null;
let tray = null;
let trayMenu = null;
let clickWatcher = null;
let shortcutCapturing = false; // 是否正在等待用户按下新快捷键
let shortcutOldAccel = null; // 捕获前的旧快捷键（取消时恢复）
let searchActive = false; // 面板是否处于搜索模式（搜索框可输入）
let searchComposing = false; // 搜索模式下中文输入法组合中：暂停面板导航键，全部让给输入框
let noteEditing = false; // 面板是否正在编辑选中条目的备注
let noteEditEntryId = null; // 鼠标点击备注图标时传入的目标条目 id
let focusTarget = null; // 本次呼出面板前的前台窗口/焦点控件快照
let focusPasteHelper = null; // 常驻原生焦点恢复 + Ctrl+V 注入进程
let focusHelperLineBuffer = '';
let focusHelperRequestId = 0;
let showPanelPromise = null;
const focusHelperPending = new Map();

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

function clearFocusHelperPending(error) {
  for (const [id, pending] of focusHelperPending) {
    clearTimeout(pending.timer);
    pending.reject(error);
    focusHelperPending.delete(id);
  }
}

function startFocusPasteHelper() {
  const helper = focusPasteHelperPath();
  if (!fs.existsSync(helper)) {
    console.error('Focus paste helper not found:', helper);
    return;
  }

  try {
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    focusPasteHelper = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      focusHelperLineBuffer += chunk;
      let newlineIndex = focusHelperLineBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = focusHelperLineBuffer.slice(0, newlineIndex).trim();
        focusHelperLineBuffer = focusHelperLineBuffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const response = JSON.parse(line);
            const pending = focusHelperPending.get(String(response.id));
            if (pending) {
              clearTimeout(pending.timer);
              focusHelperPending.delete(String(response.id));
              pending.resolve(response);
            }
          } catch (_) { /* 忽略辅助进程的异常输出 */ }
        }
        newlineIndex = focusHelperLineBuffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error('Focus paste helper:', text);
    });
    child.on('error', (err) => {
      clearFocusHelperPending(new Error(err.message));
      if (focusPasteHelper === child) focusPasteHelper = null;
    });
    child.on('exit', () => {
      clearFocusHelperPending(new Error('focus-paste-helper exited'));
      if (focusPasteHelper === child) focusPasteHelper = null;
    });
  } catch (err) {
    console.error('Failed to start focus paste helper:', err.message);
    focusPasteHelper = null;
  }
}

function requestFocusHelper(command, target = null, timeout = 2500) {
  if (!focusPasteHelper || !focusPasteHelper.stdin) {
    return Promise.reject(new Error('focus-paste-helper not running'));
  }
  const id = String(++focusHelperRequestId);
  return new Promise((resolve, reject) => {
    const pending = {
      timer: null,
      resolve,
      reject,
    };
    pending.timer = setTimeout(() => {
      focusHelperPending.delete(id);
      reject(new Error(`focus-paste-helper ${command} timed out`));
    }, timeout);
    focusHelperPending.set(id, pending);
    try {
      focusPasteHelper.stdin.write(`${JSON.stringify({ id, cmd: command, target })}\n`);
    } catch (err) {
      clearTimeout(pending.timer);
      focusHelperPending.delete(id);
      reject(err);
    }
  });
}

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

// 返回图片条目的内容 sha1（带缓存）；非图片或文件缺失返回 ''
function getImageHash(entry) {
  if (!entry || entry.type !== 'image' || !entry.imagePath) return '';
  let hash = imageHashCache.get(entry.id);
  if (hash === undefined) {
    try {
      hash = sha1(fs.readFileSync(entry.imagePath));
    } catch (_) {
      hash = '';
    }
    imageHashCache.set(entry.id, hash);
  }
  return hash;
}

function toRendererEntry(entry) {
  // 来源应用信息透传给渲染进程（若无则为null，UI会fallback）
  const sourceApp = entry.sourceApp || null;
  const note = normalizeNote(entry.note);
  if (entry.type === 'image') {
    let dataUrl = '';
    try {
      if (entry.imagePath && fs.existsSync(entry.imagePath)) {
        dataUrl = nativeImage.createFromPath(entry.imagePath).toDataURL();
      }
    } catch (_) { /* ignore */ }
    if (!dataUrl) return null;
    return { id: entry.id, type: 'image', dataUrl, createdAt: entry.createdAt, sourceApp, pinned: !!entry.pinned, pinnedAt: entry.pinnedAt || 0, note };
  }
  return { id: entry.id, type: 'text', text: entry.text ?? '', createdAt: entry.createdAt, sourceApp, pinned: !!entry.pinned, pinnedAt: entry.pinnedAt || 0, note };
}

function normalizeNote(note) {
  return typeof note === 'string' ? note.trim().slice(0, MAX_NOTE_LENGTH) : '';
}

function persist() {
  try {
    const data = history.map(({ id, type, text, imagePath, createdAt, sourceApp, pinned, pinnedAt, note }) => ({
      id, type, text, imagePath, createdAt, sourceApp, pinned: !!pinned, pinnedAt: pinnedAt || 0, note: normalizeNote(note)
    }));
    fs.writeFileSync(historyFile(), JSON.stringify(data));
  } catch (err) {
    console.error('Failed to persist history:', err);
  }
}

function loadHistory() {
  imageHashCache.clear();
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
  // 归一化旧数据字段（旧版本可能没有置顶标记或备注）
  for (const e of history) {
    e.pinned = !!e.pinned;
    e.pinnedAt = e.pinnedAt || 0;
    e.note = normalizeNote(e.note);
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

// 把已有条目提升为"最近使用"：普通条目移到普通块最前；置顶条目刷新 pinnedAt 并移到置顶块最前。
// 落位规则与 copyEntry 一致；备注/来源/创建时间等属性保持不变。
function promoteEntry(entry) {
  const idx = history.indexOf(entry);
  if (idx !== -1) history.splice(idx, 1);
  if (entry.pinned) {
    entry.pinnedAt = Date.now();
    history.unshift(entry);
  } else {
    let pinnedCount = 0;
    while (pinnedCount < history.length && history[pinnedCount].pinned) pinnedCount += 1;
    history.splice(pinnedCount, 0, entry);
  }
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
    imageHashCache.delete(entry.id);
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
  // 条目身份只看内容：全历史查找同文本（无论备注/来源/置顶），命中则提升为最近使用而非新建。
  const existing = history.find((e) => e.type === 'text' && e.text === text);
  if (existing) {
    promoteEntry(existing);
    persist();
    broadcast();
    return;
  }
  insertNewEntry({ id: crypto.randomUUID(), type: 'text', text, createdAt: Date.now(), sourceApp: sourceApp || null, pinned: false, pinnedAt: 0, note: '' });
  trimHistory();
  persist();
  broadcast();
}

function addImageEntry(image, sourceApp) {
  const png = image.toPNG();
  if (!png || png.length === 0) return;
  const hash = sha1(png);
  if (hash === lastImageHash) return;
  // 条目身份只看内容：全历史查找相同图片（PNG sha1），命中则提升为最近使用而非新建。
  const existing = history.find((e) => e.type === 'image' && getImageHash(e) === hash);
  if (existing) {
    promoteEntry(existing);
    lastImageHash = hash;
    persist();
    broadcast();
    return;
  }
  const id = crypto.randomUUID();
  const imagePath = path.join(imagesDir(), `${id}.png`);
  try {
    fs.writeFileSync(imagePath, png);
  } catch (err) {
    console.error('Failed to save clipboard image:', err);
    return;
  }
  imageHashCache.set(id, hash);
  insertNewEntry({ id, type: 'image', imagePath, createdAt: Date.now(), sourceApp: sourceApp || null, pinned: false, pinnedAt: 0, note: '' });
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
    ok = globalShortcut.register(accel, () => {
      void togglePanel();
    });
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
async function startShortcutCapture() {
  if (shortcutCapturing) return; // 已在捕获中
  if (!win || win.isDestroyed()) return;
  // 若正处于备注编辑，先保存并退出，避免两个输入态叠加
  if (noteEditing) endNoteEdit({ restoreFocus: false });
  // 若正处于搜索模式，先退回浏览模式，避免两个输入态叠加
  if (searchActive) exitSearchMode({ restoreFocus: false });
  if (!focusTarget) await captureFocusTarget();
  if (!focusTarget) {
    sendFocusError({ stage: 'restore', reason: 'no_focus_target' });
    return;
  }
  const oldAccel = settings.shortcut || DEFAULT_SHORTCUT;
  shortcutCapturing = true;
  shortcutOldAccel = oldAccel;

  // 先注销旧全局快捷键，避免捕获期间按下它触发面板
  try { globalShortcut.unregister(oldAccel); } catch (_) { /* ignore */ }
  // 注销导航快捷键，让按键正常进入渲染进程
  unregisterNavShortcuts();

  // 显示面板（若已显示则原地不动）
  await showPanel({ capture: false });
  // 捕获快捷键期间，导航快捷键要全部让位给要按下的组合键。
  unregisterNavShortcuts();
  // 捕获按键前聚焦面板（基线 focusable:true，直接 focus 即可）
  win.focus();
  if (!win.isDestroyed()) win.webContents.send('shortcut:capture-start', { current: formatShortcut(oldAccel) });
}

// 结束捕获并恢复旧快捷键（取消时调用）
function cancelShortcutCapture({ restoreFocus = true } = {}) {
  if (!shortcutCapturing) return;
  shortcutCapturing = false;
  if (shortcutOldAccel) {
    try {
      globalShortcut.register(shortcutOldAccel, () => {
        void togglePanel();
      });
    } catch (_) { /* ignore */ }
  }
  shortcutOldAccel = null;
  // 把焦点还回原程序（基线 focusable:true，直接 blur 即可）
  if (win && !win.isDestroyed()) {
    releasePanelFocus();
    win.webContents.send('shortcut:capture-end');
    if (restoreFocus) void restoreFocusOnly();
  }
  // 面板仍显示时恢复导航快捷键
  if (panelVisible) registerNavShortcuts();
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
  // 输入态（searchActive/noteEditing/shortcutCapturing）则保留焦点以便输入。
  win.on('focus', () => {
    if (searchActive || noteEditing || shortcutCapturing) return;
    // 延迟一帧再 blur，让点击事件先进入渲染进程，避免在 mousedown 前就失焦吃掉点击
    setTimeout(() => {
      if (!win || win.isDestroyed() || !panelVisible) return;
      if (searchActive || noteEditing || shortcutCapturing) return;
      if (!win.isFocused()) return;
      try { win.blur(); } catch (_) { /* ignore */ }
    }, 0);
  });

  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));


  win.once('ready-to-show', () => {
    // 离屏方案：窗口只显示一次，之后“隐藏/呼出”只移动位置，避免窗口 show/hide 闪烁（acrylic 材质也需首帧合成）。
    // 关键：先在屏幕内显示一帧，让 DWM 完成窗口表面/acrylic 材质合成，再移到屏幕外；
    // 否则每次从屏幕外移入都要重新合成，呼出就会闪一下。
    win.setPosition(0, 0);
    win.showInactive(); // focusable:true 下 showInactive 仍不激活，保持原输入框焦点
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.setPosition(-10000, 0);
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

// 面板显示期间，全局拦截 ↑/↓/Enter/Esc/Space/Z/Del/B，只作用于剪贴板面板，不进入输入框。
// 第三项 = 是否在搜索模式下依然拦截：搜索模式里 Space/Z/Del/B 让位给搜索输入框
// （Space/Z/Del/B 需要用于文本编辑），↑↓/Enter/Esc 保持面板语义。
const NAV_SHORTCUTS = [
  ['Up', 'up', true],
  ['Down', 'down', true],
  ['Enter', 'enter', true],
  ['Esc', 'escape', true],
  ['Delete', 'delete', false],
  ['Z', 'pin', false],
  ['B', 'note', false],
  ['Space', 'search', false],
];

function registerNavShortcuts() {
  for (const [accelerator, action, enabledInSearch] of NAV_SHORTCUTS) {
    // 搜索模式下被让位的键不注册；IME 组合期间所有导航键暂停，交给输入法
    if ((!enabledInSearch && searchActive) || (searchActive && searchComposing)) continue;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (action === 'search') {
          void enterSearchMode();
          return;
        }
        if (action === 'escape' && searchActive) {
          void exitSearchMode();
          return;
        }
        if (action === 'note') {
          void beginNoteEdit();
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

// 进入备注编辑：临时让面板可聚焦，并注销导航键，使输入框能正常接收字母、空格和删除键。
async function beginNoteEdit(targetId = null) {
  if (!win || win.isDestroyed() || !panelVisible || noteEditing) return false;
  if (searchActive) exitSearchMode({ restoreFocus: false });
  if (!focusTarget) {
    const target = await captureFocusTarget();
    if (!target) {
      sendFocusError({ stage: 'restore', reason: 'no_focus_target' });
      return false;
    }
  }
  if (targetId !== null && typeof targetId !== 'string') return false;
  if (targetId === null && history.length === 0) return false;
  if (targetId && !history.some((entry) => entry.id === targetId)) return false;

  noteEditEntryId = targetId || null;
  noteEditing = true;
  unregisterNavShortcuts();
  win.focus();
  if (!win.isDestroyed()) win.webContents.send('panel:key', 'note-edit-enter', noteEditEntryId);
  return true;
}

// 退出备注编辑：先让渲染层根据草稿保存，再归还焦点并恢复浏览模式导航键。
function endNoteEdit({ restoreFocus = true } = {}) {
  if (!noteEditing) return;
  noteEditing = false;
  noteEditEntryId = null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('panel:key', 'note-edit-exit');
    releasePanelFocus();
    if (restoreFocus) void restoreFocusOnly();
  }
  if (panelVisible) registerNavShortcuts();
}

// 把焦点还给原程序（仅当面板当前持有焦点时，避免影响其他前台窗口）
function releasePanelFocus() {
  if (win && !win.isDestroyed() && win.isFocused()) {
    try { win.blur(); } catch (_) { /* ignore */ }
  }
}

// 进入搜索模式：临时把面板窗口变为可聚焦并聚焦搜索输入框（支持正常输入/中文输入法），
// 同时切换导航快捷键集合（Space/Z/Del 让位给输入框）。
async function enterSearchMode() {
  if (!win || win.isDestroyed() || !panelVisible || searchActive) return false;
  if (noteEditing) endNoteEdit({ restoreFocus: false });
  if (!focusTarget) {
    const target = await captureFocusTarget();
    if (!target) {
      sendFocusError({ stage: 'restore', reason: 'no_focus_target' });
      return false;
    }
  }
  searchActive = true;
  unregisterNavShortcuts();
  registerNavShortcuts();
  win.focus();
  if (!win.isDestroyed()) win.webContents.send('panel:key', 'search-enter');
  return true;
}

// 退出搜索模式：归还焦点给原程序，恢复浏览模式的导航快捷键集合。
function exitSearchMode({ restoreFocus = true } = {}) {
  if (!win || win.isDestroyed()) { searchActive = false; searchComposing = false; return; }
  if (!searchActive) return;
  searchActive = false;
  searchComposing = false;
  if (panelVisible) {
    unregisterNavShortcuts();
    registerNavShortcuts();
  }
  releasePanelFocus();
  if (!win.isDestroyed()) win.webContents.send('panel:key', 'search-exit');
  if (restoreFocus) void restoreFocusOnly();
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

async function showPanel({ capture = false } = {}) {
  if (!win || win.isDestroyed()) return;
  if (showPanelPromise) return showPanelPromise;
  showPanelPromise = (async () => {
    if (capture && !focusTarget) {
      await captureFocusTarget();
      if (!win || win.isDestroyed()) return;
    }
    positionPanel();
    panelVisible = true;
    noteEditing = false;
    noteEditEntryId = null;
    // 每次呼出都重置搜索模式（渲染层在 panel:shown 里清空查询词）
    searchActive = false;
    searchComposing = false;
    registerNavShortcuts();
    if (!win.isDestroyed()) win.webContents.send('panel:shown');
    // 不在这里 broadcast()：历史由 600ms 轮询实时推送，呼出时强制刷新反而导致列表重绘闪烁
  })().finally(() => {
    showPanelPromise = null;
  });
  return showPanelPromise;
}

function hidePanel({ restoreFocus = true } = {}) {
  if (!win || win.isDestroyed()) return;
  // 捕获快捷键过程中隐藏面板：先结束捕获（恢复旧快捷键）
  if (shortcutCapturing) cancelShortcutCapture({ restoreFocus: false });
  // 备注编辑中隐藏面板：先让渲染层保存草稿
  if (noteEditing) endNoteEdit({ restoreFocus: false });
  // 搜索模式中隐藏面板：先让渲染层退出搜索，再统一归还焦点
  if (searchActive) exitSearchMode({ restoreFocus: false });
  panelVisible = false;
  searchActive = false;
  searchComposing = false;
  noteEditing = false;
  noteEditEntryId = null;
  unregisterNavShortcuts();
  releasePanelFocus();
  const targetToRestore = focusTarget;
  focusTarget = null;
  if (restoreFocus && targetToRestore) void restoreFocusOnly(targetToRestore);
  // 移到屏幕外而不是 hide()：避免透明窗口 show/hide 造成的闪烁
  win.setPosition(-10000, 0);
}

function togglePanel() {
  if (!win || win.isDestroyed()) return;
  if (panelVisible) hidePanel();
  else void showPanel({ capture: true });
}

// ---------- focus snapshot, restore and paste ----------

function sendFocusError(result = {}) {
  if (!win || win.isDestroyed()) return;
  const stage = result.stage || 'restore';
  const reason = result.reason || (stage === 'paste' ? 'paste_send_failed' : 'restore_failed');
  const message = stage === 'paste'
    ? '复制已写入剪贴板，但无法粘贴回原输入框，请重试。'
    : '无法恢复原输入框，已取消本次粘贴，避免写入错误窗口。';
  win.webContents.send('panel:focus-error', { stage, reason, message });
}

async function captureFocusTarget() {
  if (focusTarget) return focusTarget;
  try {
    const result = await requestFocusHelper('snapshot');
    if (!result || result.ok !== true || !result.target) return null;
    focusTarget = result.target;
    return focusTarget;
  } catch (_) {
    return null;
  }
}

async function restoreFocusOnly(target = focusTarget) {
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

async function restoreFocusAndPaste(target = focusTarget) {
  if (!target) {
    sendFocusError({ stage: 'restore', reason: 'no_focus_target' });
    return false;
  }
  try {
    const result = await requestFocusHelper('paste', target);
    if (result && result.ok) return true;
    sendFocusError(result || { stage: 'paste', reason: 'paste_send_failed' });
    return false;
  } catch (_) {
    sendFocusError({ stage: 'paste', reason: 'helper_not_available' });
    return false;
  }
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('clipboard:get', () => history.map(toRendererEntry).filter(Boolean));
  ipcMain.handle('clipboard:copy', async (_e, id) => {
    if (!copyEntry(id)) return false;
    const pasted = await restoreFocusAndPaste();
    if (!pasted) return false;
    hidePanel({ restoreFocus: false });
    return true;
  });
  ipcMain.handle('clipboard:remove', (_e, id) => {
    const idx = history.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const [removed] = history.splice(idx, 1);
    imageHashCache.delete(removed.id);
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
    imageHashCache.clear();
    persist();
    broadcast();
    return true;
  });

  // 备注：保存、进入编辑、退出编辑
  ipcMain.handle('note:set', (_e, id, note) => {
    if (typeof id !== 'string') return false;
    const entry = history.find((item) => item.id === id);
    if (!entry) return false;
    entry.note = normalizeNote(note);
    persist();
    broadcast();
    return true;
  });
  ipcMain.handle('note:begin-edit', (_e, id) => beginNoteEdit(id));
  ipcMain.handle('note:end-edit', () => {
    endNoteEdit();
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
      ok = globalShortcut.register(accel, () => {
        void togglePanel();
      });
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
    // 恢复焦点给原程序
    if (win && !win.isDestroyed()) {
      releasePanelFocus();
      void restoreFocusOnly();
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
  ipcMain.handle('search:activate', async () => {
    await enterSearchMode();
    return true;
  });
  // 搜索：中文输入法组合中暂停面板导航键（↑↓/Enter 让给 IME 候选），组合结束恢复
  ipcMain.handle('search:set-composing', (_e, composing) => {
    setSearchComposing(!!composing);
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

    registerToggleShortcut();

    pollTimer = setInterval(pollClipboard, POLL_INTERVAL);
  });

  app.on('before-quit', () => {
    isQuitting = true;
    clearInterval(pollTimer);
    globalShortcut.unregisterAll();
  });

  app.on('will-quit', () => {
    if (focusPasteHelper) {
      clearFocusHelperPending(new Error('app is quitting'));
      try { focusPasteHelper.stdin.end(); } catch (_) { /* ignore */ }
      try { focusPasteHelper.kill(); } catch (_) { /* ignore */ }
      focusPasteHelper = null;
    }
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



