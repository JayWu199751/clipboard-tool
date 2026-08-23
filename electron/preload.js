const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipboardAPI', {
  getHistory: () => ipcRenderer.invoke('clipboard:get'),
  onUpdated: (callback) => {
    ipcRenderer.removeAllListeners('clipboard:updated');
    ipcRenderer.on('clipboard:updated', (_event, entries) => callback(entries));
  },
  // 面板显示期间由主进程全局拦截的按键：up / down / enter / escape
  onPanelKey: (callback) => {
    ipcRenderer.removeAllListeners('panel:key');
    ipcRenderer.on('panel:key', (_event, action) => callback(action));
  },
  onPanelShown: (callback) => {
    ipcRenderer.removeAllListeners('panel:shown');
    ipcRenderer.on('panel:shown', () => callback());
  },
  copy: (id) => ipcRenderer.invoke('clipboard:copy', id),
  remove: (id) => ipcRenderer.invoke('clipboard:remove', id),
  pin: (id) => ipcRenderer.invoke('clipboard:pin', id),
  clear: () => ipcRenderer.invoke('clipboard:clear'),

  getElevatedPaste: () => ipcRenderer.invoke('clipboard:get-elevated-paste'),
  setElevatedPaste: (value) => ipcRenderer.invoke('clipboard:set-elevated-paste', value),
  onElevatedStatus: (callback) => {
    ipcRenderer.removeAllListeners('elevated:status');
    ipcRenderer.on('elevated:status', (_event, status) => callback(status));
  },
  // 更换快捷键
  onShortcutCaptureStart: (callback) => {
    ipcRenderer.removeAllListeners('shortcut:capture-start');
    ipcRenderer.on('shortcut:capture-start', (_event, info) => callback(info));
  },
  onShortcutCaptureEnd: (callback) => {
    ipcRenderer.removeAllListeners('shortcut:capture-end');
    ipcRenderer.on('shortcut:capture-end', () => callback());
  },
  tryShortcut: (accel) => ipcRenderer.invoke('shortcut:try', accel),
  cancelShortcut: () => ipcRenderer.invoke('shortcut:cancel'),
    hide: () => ipcRenderer.invoke('window:hide'),
});




