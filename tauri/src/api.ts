// Tauri IPC 适配层：实现 window.clipboardAPI（与 Electron preload.js 同一接口面）。
// 渲染层 App.tsx 无需改动；invoke 参数名用 camelCase，与 Rust 命令的 serde rename 对齐。
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ClipboardEntry } from './types';

type AnyCb = (...args: any[]) => void;

// 与 preload.js 的 removeAllListeners 语义对齐：同一事件重复注册时先解绑旧的。
const unlisteners = new Map<string, UnlistenFn[]>();

function onEvent(channel: string, cb: AnyCb, map?: (payload: any) => any[]): void {
  void (async () => {
    for (const un of unlisteners.get(channel) ?? []) un();
    unlisteners.set(channel, []);
    const un = await listen<any>(channel, (event) => {
      cb(...(map ? map(event.payload) : [event.payload]));
    });
    if (!unlisteners.has(channel)) {
      un();
      return;
    }
    unlisteners.get(channel)!.push(un);
  })();
}

window.clipboardAPI = {
  getHistory: () => invoke<ClipboardEntry[]>('clipboard_get'),
  onUpdated: (cb) => onEvent('clipboard:updated', cb),
  // 面板显示期间由主进程全局拦截的按键动作：up / down / enter / escape / delete / pin /
  // search-enter / search-exit / note-edit-enter / note-edit-exit
  onPanelKey: (cb) => onEvent('panel:key', cb, (p) => [p.action, p.noteEntryId ?? null]),
  onPanelShown: (cb) => onEvent('panel:shown', cb),
  onFocusError: (cb) => onEvent('panel:focus-error', cb),
  // 返回结果契约 { ok, message }：键盘 Enter / 双击 / 复制按钮共用
  copy: (id) => invoke('clipboard_copy', { id }),
  remove: (id) => invoke('clipboard_remove', { id }),
  pin: (id) => invoke('clipboard_pin', { id }),
  clear: () => invoke('clipboard_clear'),
  setNote: (id, note) => invoke('note_set', { id, note }),
  beginNoteEdit: (id) => invoke('note_begin_edit', { id }),
  endNoteEdit: () => invoke('note_end_edit'),

  // 更换快捷键
  onShortcutCaptureStart: (cb) => onEvent('shortcut:capture-start', cb),
  onShortcutCaptureEnd: (cb) => onEvent('shortcut:capture-end', cb),
  tryShortcut: (accel) => invoke('shortcut_try', { accel }),
  cancelShortcut: () => invoke('shortcut_cancel'),
  hide: () => invoke('window_hide'),
  setIgnoreMouse: (ignore, forward) => invoke('window_set_ignore_mouse', { ignore, forward }),
  // 搜索：进入搜索模式（按空格由主进程直接触发，点击常驻搜索框走这里）
  activateSearch: () => invoke('search_activate'),
  // 搜索：中文输入法组合状态同步（组合期间主进程暂停面板导航键）
  setSearchComposing: (composing) => invoke('search_set_composing', { composing }),
  // 提权：查询是否已提权 / 请求以管理员身份重启（任务静默优先，UAC 兜底）
  isElevated: () => invoke<boolean>('elevation_check'),
  restartElevated: () => invoke<boolean>('elevation_restart'),
};