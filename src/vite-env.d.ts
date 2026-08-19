/// <reference types="vite/client" />

import type { ClipboardEntry } from './types';

type PanelKeyAction = 'up' | 'down' | 'enter' | 'delete' | 'escape';

interface ShortcutTryResult {
  ok: boolean;
  formatted: string;
}

interface ElevatedStatus {
  enabled: boolean;
  running: boolean;
  canceled?: boolean;
  waiting?: boolean;
}

interface ClipboardAPI {
  getHistory(): Promise<ClipboardEntry[]>;
  onUpdated(callback: (entries: ClipboardEntry[]) => void): void;
  onPanelKey(callback: (action: PanelKeyAction) => void): void;
  onPanelShown(callback: () => void): void;
  copy(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  clear(): Promise<boolean>;

  getElevatedPaste(): Promise<ElevatedStatus>;
  setElevatedPaste(value: boolean): Promise<ElevatedStatus>;
  onElevatedStatus(callback: (status: ElevatedStatus) => void): void;
  onShortcutCaptureStart(callback: (info: { current: string }) => void): void;
  onShortcutCaptureEnd(callback: () => void): void;
  tryShortcut(accel: string): Promise<ShortcutTryResult>;
  cancelShortcut(): Promise<void>;
    hide(): Promise<void>;
}

declare global {
  interface Window {
    clipboardAPI: ClipboardAPI;
  }
}

export {};




