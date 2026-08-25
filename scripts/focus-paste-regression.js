const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

const projectRoot = path.resolve(__dirname, '..');
const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboardtool-focus-paste-'));
const settingsFile = path.join(testUserData, 'settings.json');
const historyFile = path.join(testUserData, 'clipboard-history.json');
fs.writeFileSync(settingsFile, JSON.stringify({ autoStart: false, shortcut: 'Control+Shift+V' }));
fs.writeFileSync(historyFile, JSON.stringify([
  {
    id: 'item-1',
    type: 'text',
    text: 'PASTE_ME',
    createdAt: 1,
    sourceApp: null,
    pinned: false,
    pinnedAt: 0,
    note: '',
  },
]));

const shortcutCallbacks = new Map();
const ipcHandlers = new Map();
const helperWrites = [];
const execCalls = [];
const webEvents = [];
const focusErrorEvents = [];
let appReadyResolve = null;
let panelShownCount = 0;
let clipboardText = '';
let panelPosition = [0, 0];
let failNextPaste = false;
let helperProcess = null;

function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error('Timed out waiting for regression condition.'));
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function parseHelperCommand(line) {
  const command = JSON.parse(line);
  helperWrites.push(command);

  const response = { id: command.id, cmd: command.cmd, ok: true };
  if (command.cmd === 'snapshot') {
    response.target = {
      hwnd: 0x10010,
      focusHwnd: 0x10020,
      pid: 4242,
      tid: 4343,
    };
  } else if (command.cmd === 'paste' && failNextPaste) {
    failNextPaste = false;
    response.ok = false;
    response.stage = 'paste';
    response.reason = 'paste_send_failed';
  }

  setImmediate(() => {
    helperProcess.stdout.emit('data', `${JSON.stringify(response)}\n`);
  });
}

function makeNativeProcess(exe) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = {
    write: (line) => {
      if (path.basename(exe) === 'focus-paste-helper.exe') parseHelperCommand(line);
    },
    end: () => {},
  };
  child.kill = () => {};
  return child;
}

const electronMock = {
  app: {
    getPath: () => testUserData,
    getAppPath: () => projectRoot,
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    quit: () => {},
    on: () => {},
    whenReady: () => new Promise((resolve) => {
      appReadyResolve = resolve;
    }),
  },
  BrowserWindow: class {
    constructor() {
      this.focused = false;
      this.focusable = false;
      this.webContents = {
        send: (channel, ...args) => {
          webEvents.push({ channel, args });
          if (channel === 'panel:shown') panelShownCount += 1;
          if (channel === 'panel:focus-error') focusErrorEvents.push(args[0]);
        },
        setWindowOpenHandler: () => {},
      };
    }
    once(event, callback) {
      if (event === 'ready-to-show') setImmediate(callback);
    }
    on() {}
    isDestroyed() {
      return false;
    }
    setMenu() {}
    loadFile() {}
    setPosition(x, y) {
      panelPosition = [x, y];
    }
    showInactive() {}
    setFocusable(value) {
      this.focusable = value;
    }
    focus() {
      this.focused = true;
    }
    blur() {
      this.focused = false;
    }
    isFocused() {
      return this.focused;
    }
    getSize() {
      return [400, 560];
    }
    getPosition() {
      return panelPosition;
    }
    getBounds() {
      return { x: panelPosition[0], y: panelPosition[1], width: 400, height: 560 };
    }
  },
  globalShortcut: {
    register: (accelerator, callback) => {
      shortcutCallbacks.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator) => shortcutCallbacks.delete(accelerator),
    unregisterAll: () => shortcutCallbacks.clear(),
  },
  clipboard: {
    readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    readText: () => '',
    writeText: (text) => {
      clipboardText = text;
    },
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true, toDataURL: () => '' }),
  },
  ipcMain: {
    handle: (channel, handler) => ipcHandlers.set(channel, handler),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    screenToDipPoint: (point) => point,
  },
  Menu: {
    setApplicationMenu: () => {},
    buildFromTemplate: () => ({}),
  },
  Tray: class {
    setToolTip() {}
    setImage() {}
    setContextMenu() {}
    on() {}
    destroy() {}
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    on: () => {},
  },
};

const childProcessMock = {
  execFile(command, args, options, callback) {
    execCalls.push({ command, args, options });
    setImmediate(callback, null, '', '');
  },
  spawn(exe) {
    const child = makeNativeProcess(exe);
    if (path.basename(exe) === 'focus-paste-helper.exe') helperProcess = child;
    return child;
  },
};

const originalLoad = Module._load;
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === 'electron') return electronMock;
  if (request === 'child_process') return childProcessMock;
  return originalLoad.call(this, request, parent, isMain);
};

process.on('exit', () => {
  Module._load = originalLoad;
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  const resolved = path.resolve(testUserData);
  if (resolved.startsWith(tempRoot) && path.basename(testUserData).startsWith('clipboardtool-focus-paste-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

require(path.join(projectRoot, 'electron', 'main.js'));
appReadyResolve();

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

(async () => {
  await waitFor(() => shortcutCallbacks.has('Control+Shift+V'));

  shortcutCallbacks.get('Control+Shift+V')();
  await waitFor(() => panelShownCount === 1 && helperWrites.length >= 1);
  const snapshotIndex = helperWrites.findIndex((command) => command.cmd === 'snapshot');
  const shownIndex = webEvents.findIndex((event) => event.channel === 'panel:shown');
  if (snapshotIndex === -1 || shownIndex === -1 || snapshotIndex > shownIndex) {
    fail('Global shortcut did not snapshot the original window before showing the panel.');
  }

  const normalCopied = await ipcHandlers.get('clipboard:copy')(null, 'item-1');
  await waitFor(() => helperWrites.some((command) => command.cmd === 'paste'));

  const normalPaste = helperWrites.find((command) => command.cmd === 'paste');
  if (!normalCopied) fail('Normal browser-mode copy was reported as failed.');
  if (clipboardText !== 'PASTE_ME') fail('Clipboard did not receive the selected text entry.');
  if (!normalPaste || !normalPaste.target || normalPaste.target.focusHwnd !== 0x10020) {
    fail('Normal browser-mode paste did not use the original focused control snapshot.');
  }
  if (execCalls.some((call) => call.command === 'powershell.exe' && call.args.join(' ').includes("SendKeys"))) {
    fail('Implementation still falls back to the old PowerShell SendKeys path.');
  }
  if (panelPosition[0] >= -1000) fail('Panel remained visible after a normal browser-mode restore-and-paste.');

  shortcutCallbacks.get('Control+Shift+V')();
  await waitFor(() => panelShownCount === 2 && helperWrites.filter((command) => command.cmd === 'snapshot').length >= 2);

  shortcutCallbacks.get('Space')();
  await waitFor(() => webEvents.some((event) => event.channel === 'panel:key' && event.args[0] === 'search-enter'));
  shortcutCallbacks.get('Esc')();
  await waitFor(() => helperWrites.some((command) => command.cmd === 'restore'));

  shortcutCallbacks.get('Space')();
  await waitFor(() => webEvents.filter((event) => event.channel === 'panel:key' && event.args[0] === 'search-enter').length >= 2);
  shortcutCallbacks.get('Enter')();
  const searchCopied = await ipcHandlers.get('clipboard:copy')(null, 'item-1');
  await waitFor(() => helperWrites.filter((command) => command.cmd === 'paste').length >= 2);

  const searchPastPastes = helperWrites.filter((command) => command.cmd === 'paste');
  const searchPaste = searchPastPastes[searchPastPastes.length - 1];
  if (!searchCopied) fail('Search-mode copy was reported as failed.');
  if (clipboardText !== 'PASTE_ME') fail('Clipboard did not receive the selected text entry.');
  if (!searchPaste || !searchPaste.target || searchPaste.target.focusHwnd !== 0x10020) {
    fail('Search-mode paste did not use the original focused control snapshot.');
  }
  if (execCalls.some((call) => call.command === 'powershell.exe' && call.args.join(' ').includes("SendKeys"))) {
    fail('Implementation still falls back to the old PowerShell SendKeys path.');
  }
  if (panelPosition[0] >= -1000) fail('Panel remained visible after a search-mode restore-and-paste.');

  shortcutCallbacks.get('Control+Shift+V')();
  await waitFor(() => panelShownCount === 3 && helperWrites.filter((command) => command.cmd === 'snapshot').length >= 3);
  shortcutCallbacks.get('Space')();
  await waitFor(() => webEvents.filter((event) => event.channel === 'panel:key' && event.args[0] === 'search-enter').length >= 3);
  shortcutCallbacks.get('Enter')();
  failNextPaste = true;
  const failed = await ipcHandlers.get('clipboard:copy')(null, 'item-1');
  await waitFor(() => focusErrorEvents.length === 1);

  if (failed) fail('Failed restore-and-paste was reported as successful.');
  if (panelPosition[0] < -1000) fail('Panel was hidden despite the paste failure.');
  if (focusErrorEvents[0]?.reason !== 'paste_send_failed') {
    fail('Renderer did not receive the paste failure reason.');
  }

  console.log('PASS: normal and search paste share the focus restore flow, with failure handling intact.');
  process.exit(0);
})().catch((error) => {
  fail(error.message);
});
