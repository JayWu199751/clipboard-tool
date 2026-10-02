// 主题偏好的异步同步规则。IPC 与媒体查询效果由 App 执行；本 module 管偏好、读取代次与切换互斥。

import { themeControl } from './panelView.ts';
import type { ThemePreference } from './types';

export interface ThemeSyncSnapshot {
  preference: ThemePreference | null;
  pending: boolean;
}

export class ThemeSynchronizer {
  private preference: ThemePreference | null = null;
  private pending = false;
  private readGeneration = 0;

  snapshot(): ThemeSyncSnapshot {
    return { preference: this.preference, pending: this.pending };
  }

  beginRead(): number {
    this.readGeneration += 1;
    return this.readGeneration;
  }

  acceptRead(generation: number, preference: ThemePreference): boolean {
    if (generation !== this.readGeneration) return false;
    this.preference = preference;
    return true;
  }

  receiveChange(preference: ThemePreference): void {
    this.readGeneration += 1;
    this.preference = preference;
  }

  beginToggle(): ThemePreference | null {
    if (this.preference === null || this.pending) return null;
    this.pending = true;
    return themeControl(this.preference).next;
  }

  finishToggle(): void {
    this.pending = false;
  }

  invalidateReads(): void {
    this.readGeneration += 1;
  }
}
