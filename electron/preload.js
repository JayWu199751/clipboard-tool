const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipboardAPI', {
  getHistory: () => ipcRenderer.invoke('clipboard:get'),
  onUpdated: (callback) => {
    ipcRenderer.removeAllListeners('clipboard:updated');
    ipcRenderer.on('clipboard:updated', (_event, entries) => callback(entries));
  },
  // 面板显示期间由主进程全局拦截的按键动作：up / down / enter / escape / delete / pin /
  // search-enter / search-exit / note-edit-enter / note-edit-exit
  onPanelKey: (callback) => {
    ipcRenderer.removeAllListeners('panel:key');
    ipcRenderer.on('panel:key', (_event, action, noteEntryId) => callback(action, noteEntryId));
  },
  onPanelShown: (callback) => {
    ipcRenderer.removeAllListeners('panel:shown');
    ipcRenderer.on('panel:shown', () => callback());
  },
  onFocusError: (callback) => {
    ipcRenderer.removeAllListeners('panel:focus-error');
    ipcRenderer.on('panel:focus-error', (_event, error) => callback(error));
  },
  // 返回结果契约 { ok, message }：键盘 Enter / 双击 / 复制按钮共用
  copy: (id) => ipcRenderer.invoke('clipboard:copy', id),
  remove: (id) => ipcRenderer.invoke('clipboard:remove', id),
  pin: (id) => ipcRenderer.invoke('clipboard:pin', id),
  clear: () => ipcRenderer.invoke('clipboard:clear'),
  setNote: (id, note) => ipcRenderer.invoke('note:set', id, note),
  beginNoteEdit: (id) => ipcRenderer.invoke('note:begin-edit', id),
  endNoteEdit: () => ipcRenderer.invoke('note:end-edit'),

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
  setIgnoreMouse: (ignore, forward) => ipcRenderer.invoke('window:set-ignore-mouse', ignore, forward),
  // 搜索：进入搜索模式（按空格由主进程直接触发，点击常驻搜索框走这里）
  activateSearch: () => ipcRenderer.invoke('search:activate'),
  // 搜索：中文输入法组合状态同步（组合期间主进程暂停面板导航键）
  setSearchComposing: (composing) => ipcRenderer.invoke('search:set-composing', composing),
});



