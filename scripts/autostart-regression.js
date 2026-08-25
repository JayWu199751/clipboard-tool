const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

const projectRoot = path.resolve(__dirname, '..');
const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboardtool-autostart-'));
const settingsFile = path.join(testUserData, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ autoPaste: true, autoStart: true, shortcut: 'Control+Shift+V' }));

const execCalls = [];
const menuTemplates = [];
const electronMock = {
  app: {
    getPath: () => testUserData,
    getAppPath: () => projectRoot,
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    quit: () => {},
    on: () => {},
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = {
        send: () => {},
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
    setPosition() {}
    showInactive() {}
    setFocusable() {}
    focus() {}
    blur() {}
    isFocused() {
      return false;
    }
    getSize() {
      return [400, 560];
    }
    getPosition() {
      return [0, 0];
    }
    getBounds() {
      return { x: 0, y: 0, width: 400, height: 560 };
    }
  },
  globalShortcut: {
    register: () => true,
    unregister: () => {},
    unregisterAll: () => {},
  },
  clipboard: {
    readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    readText: () => '',
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true, toDataURL: () => '' }),
  },
  ipcMain: {
    handle: () => {},
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    screenToDipPoint: (point) => point,
  },
  Menu: {
    setApplicationMenu: () => {},
    buildFromTemplate: (template) => {
      menuTemplates.push(template);
      return {};
    },
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
  spawn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = {
      write: () => {},
      end: () => {},
    };
    child.kill = () => {};
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
  if (resolved.startsWith(tempRoot) && path.basename(testUserData).startsWith('clipboardtool-autostart-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

require(path.join(projectRoot, 'electron', 'main.js'));

const deadline = Date.now() + 5000;
const timer = setInterval(() => {
  if (execCalls.length > 0 || Date.now() >= deadline) {
    clearInterval(timer);
    const taskCalls = execCalls.filter((call) =>
      call.command === 'powershell.exe' &&
      call.args.join(' ').includes("Register-ScheduledTask -TaskName 'ClipboardToolElevated'")
    );

    const failures = [];
    if (taskCalls.length !== 1) {
      failures.push(`Expected one scheduled-task registration during startup, got ${taskCalls.length}.`);
    } else {
      const command = taskCalls[0].args.join(' ');
      if (!command.includes('-Trigger (New-ScheduledTaskTrigger -AtLogOn)')) {
        failures.push('Startup did not preserve the AtLogOn trigger while settings.autoStart is true.');
      }
    }

    const trayMenu = menuTemplates.find((template) =>
      template.some((item) => item.label && item.label.startsWith('开机启动'))
    );
    const autoStartItem = trayMenu && trayMenu.find((item) => item.label && item.label.startsWith('开机启动'));
    if (!autoStartItem || autoStartItem.checked !== true) {
      failures.push('Tray auto-start checkbox was not restored from settings.autoStart=true after startup.');
    }

    if (failures.length > 0) {
      for (const failure of failures) console.error(failure);
      process.exit(1);
    }

    console.log('PASS: startup preserved the task trigger and tray checkbox for settings.autoStart=true.');
    process.exit(0);
  }
}, 10);
