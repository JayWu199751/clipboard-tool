/// <reference types="vite/client" />

import type { ClipboardEntry } from './types';

type PanelKeyAction = 'up' | 'down' | 'enter' | 'delete' | 'escape' | 'pin' | 'search-enter' | 'search-exit' | 'note-edit-enter' | 'note-edit-exit';

interface ShortcutTryResult {
  ok: boolean;
  formatted: string;
}

interface FocusErrorInfo {
  stage: string;
  reason: string;
  message: string;
}

interface ClipboardAPI {
  getHistory(): Promise<ClipboardEntry[]>;
  onUpdated(callback: (entries: ClipboardEntry[]) => void): void;
  onPanelKey(callback: (action: PanelKeyAction, noteEntryId?: string | null) => void): void;
  onPanelShown(callback: () => void): void;
  onFocusError(callback: (error: FocusErrorInfo) => void): void;
  copy(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  pin(id: string): Promise<boolean>;
  clear(): Promise<boolean>;
  setNote(id: string, note: string): Promise<boolean>;
  beginNoteEdit(id?: string): Promise<boolean>;
  endNoteEdit(): Promise<void>;

  onShortcutCaptureStart(callback: (info: { current: string }) => void): void;
  onShortcutCaptureEnd(callback: () => void): void;
  tryShortcut(accel: string): Promise<ShortcutTryResult>;
  cancelShortcut(): Promise<void>;
  hide(): Promise<void>;
  activateSearch(): Promise<void>;
  setSearchComposing(composing: boolean): Promise<void>;
}

declare global {
  interface Window {
    clipboardAPI: ClipboardAPI;
  }
}

export {};



