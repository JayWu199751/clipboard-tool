// ClipStore 契约适配层（迁移提示词「数据契约」）：把主进程真实数据源
// （RendererEntry[] + clipboard:updated 广播）投影成组件只认的 ClipItem 视图。
// 组件不碰 invoke；copy/remove/restore 这些效果留在 App 接线（ADR-0008）。
// 与 mock 契约的两处已确认偏差：
//   - copy = 原应用的「复制并粘贴」链路（clipboard_copy），不是裸 writeText；
//   - remove = 渲染层延迟删除（hiddenIds 集合 + 6s 定时器），撤销 = 摘除隐藏，
//     到点才真正调 clipboard_remove 持久化。存储层键名契约（ADR-0007）零改动。

import type { ClipboardEntry } from './types';
import { filterEntries } from './panelView';

export type ClipItem =
  | { id: string; type: 'text'; content: string; source: string; ts: number; note: string; pinned: boolean }
  | { id: string; type: 'image'; content: string; src: string; source: string; ts: number; note: string; pinned: boolean };

/** 图片条目在磁盘上就叫 <id>.png（%APPDATA%\ClipboardTool\images），mono 文件名行用真名。 */
function toClipItem(entry: ClipboardEntry): ClipItem | null {
  const source = entry.sourceApp?.appName?.trim() || '未知来源';
  const base = {
    id: entry.id,
    source,
    ts: entry.createdAt,
    note: entry.note ?? '',
    pinned: entry.pinned,
  };
  if (entry.type === 'image') {
    if (!entry.dataUrl) return null; // 图片文件丢失的条目不投影（与主进程 filter_map 同口径）
    return { ...base, type: 'image', content: entry.id + '.png', src: entry.dataUrl };
  }
  return { ...base, type: 'text', content: entry.text ?? '' };
}

export interface ClipStoreView {
  /** 已按 ts 倒序（原应用为置顶块 → 最近使用，顺序由主进程保证）+ 子串过滤（正文+备注+来源五字段） */
  query(opts: { search?: string }): ClipItem[];
  total(): number;
  getNote(id: string): string;
}

export function createClipStore(
  entries: ClipboardEntry[],
  hiddenIds: ReadonlySet<string>,
): ClipStoreView {
  const visible = (list: ClipboardEntry[]): ClipItem[] =>
    list.map(toClipItem).filter((item): item is ClipItem => item !== null && !hiddenIds.has(item.id));
  return {
    query: (opts) => visible(filterEntries(entries, opts.search ?? '')),
    total: () => visible(entries).length,
    getNote: (id) => entries.find((entry) => entry.id === id)?.note ?? '',
  };
}
