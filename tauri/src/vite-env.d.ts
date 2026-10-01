/// <reference types="vite/client" />

import type { ClipboardEntry, PanelKeyAction, ThemePreference } from './types';

interface ShortcutTryResult {
  ok: boolean;
  formatted: string;
}

// clipboard:copy 的结果契约：两个入口（键盘 Enter / 双击）共用——卡片右上角的「复制」按钮 2026-09-11 已删，
// message 为主进程给出的可展示文案（错误文案与 panel:focus-error 事件同源）。
interface CopyResult {
  ok: boolean;
  message: string;
}

interface FocusErrorInfo {
  stage: string;
  reason: string;
  message: string;
}

interface ClipboardAPI {
  getHistory(): Promise<ClipboardEntry[]>;
  getTheme(): Promise<ThemePreference>;
  setTheme(theme: ThemePreference): Promise<void>;
  onThemeChanged(callback: (theme: ThemePreference) => void): Promise<void>;
  onUpdated(callback: (entries: ClipboardEntry[]) => void): void;
  onPanelKey(callback: (action: PanelKeyAction, noteEntryId?: string | null) => void): void;
  onPanelShown(callback: () => void): void;
  onFocusError(callback: (error: FocusErrorInfo) => void): void;
  copy(id: string): Promise<CopyResult>;
  remove(id: string): Promise<boolean>;
  pin(id: string): Promise<boolean>;
  setNote(id: string, note: string): Promise<boolean>;
  endNoteEdit(): Promise<void>;

  onShortcutCaptureStart(callback: (info: { current: string }) => void): void;
  onShortcutCaptureEnd(callback: () => void): void;
  tryShortcut(accel: string): Promise<ShortcutTryResult>;
  cancelShortcut(): Promise<void>;
  hide(): Promise<void>;
  setIgnoreMouse(ignore: boolean, forward?: boolean): Promise<void>;
  activateSearch(): Promise<void>;
  setSearchComposing(composing: boolean): Promise<void>;
}

declare global {
  interface Window {
    clipboardAPI: ClipboardAPI;
  }
}

export {};

