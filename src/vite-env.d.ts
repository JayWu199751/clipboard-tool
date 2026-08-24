/// <reference types="vite/client" />

import type { ClipboardEntry } from './types';

type PanelKeyAction = 'up' | 'down' | 'enter' | 'delete' | 'escape' | 'pin' | 'search-enter' | 'search-exit';

interface ShortcutTryResult {
  ok: boolean;
  formatted: string;
}

interface ClipboardAPI {
  getHistory(): Promise<ClipboardEntry[]>;
  onUpdated(callback: (entries: ClipboardEntry[]) => void): void;
  onPanelKey(callback: (action: PanelKeyAction) => void): void;
  onPanelShown(callback: () => void): void;
  copy(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  pin(id: string): Promise<boolean>;
  clear(): Promise<boolean>;

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



