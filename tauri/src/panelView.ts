// 面板视图规则：搜索过滤、命中高亮、选中项落位。
// 纯逻辑、不依赖 React 与 Tauri，可被 scripts/panel-view-unit.mjs 用 plain node 直测。
// 这里承载的是 CONTEXT.md「搜索功能」「条目显示」访谈定稿的三条决策：
//   匹配规则（大小写不敏感、空格分词多词 AND、正文+备注+来源应用五字段）
//   结果排序（保持原始顺序，不做匹配度排序）
//   选中项（每次查询变化重置到第一个匹配项；列表变短时拉回有效范围）
// 渲染层只负责把结果画出来，规则不再散落在组件里。

import type { ClipboardEntry } from './types';

export interface HighlightSpan {
  text: string;
  hit: boolean;
}

export type NavDirection = 'up' | 'down';

// 查询分词：去空白、大小写归一。空查询 = 不过滤。
export function queryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// 参与匹配的字段：正文（仅文字条目）、备注、来源应用名 / 窗口标题 / exe 路径。
function haystack(entry: ClipboardEntry): string {
  return [
    entry.type === 'text' ? entry.text ?? '' : '',
    entry.note ?? '',
    entry.sourceApp?.appName ?? '',
    entry.sourceApp?.windowTitle ?? '',
    entry.sourceApp?.exePath ?? '',
  ].join(' ').toLowerCase();
}

// 过滤：多词 AND；命中结果保持原始顺序（置顶块 → 最近使用）。
export function filterEntries(entries: ClipboardEntry[], query: string): ClipboardEntry[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const text = haystack(entry);
    return terms.every((term) => text.includes(term));
  });
}

// 高亮：逐词扫描，已命中的片段不再被后续词二次切分。
export function highlight(text: string, query: string): HighlightSpan[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [{ text, hit: false }];
  let parts: HighlightSpan[] = [{ text, hit: false }];
  for (const term of terms) {
    const next: HighlightSpan[] = [];
    for (const part of parts) {
      if (part.hit) {
        next.push(part);
        continue;
      }
      let rest = part.text;
      let lower = rest.toLowerCase();
      let found = lower.indexOf(term);
      while (found !== -1) {
        if (found > 0) next.push({ text: rest.slice(0, found), hit: false });
        next.push({ text: rest.slice(found, found + term.length), hit: true });
        rest = rest.slice(found + term.length);
        lower = rest.toLowerCase();
        found = lower.indexOf(term);
      }
      if (rest) next.push({ text: rest, hit: false });
    }
    parts = next;
  }
  return parts;
}

// 片段拼回原文：自检「高亮不丢字符」，调用方也可降级成纯文本渲染。
export function spansToText(spans: HighlightSpan[]): string {
  return spans.map((span) => span.text).join('');
}

// 选中项越界的唯一修正处。空列表返回 0（配合 entryAt 得到 null）。
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

// 上下移动：到首/尾后停住，不环绕。
export function moveIndex(index: number, length: number, direction: NavDirection): number {
  const current = clampIndex(index, length);
  return direction === 'up' ? clampIndex(current - 1, length) : clampIndex(current + 1, length);
}

// 按索引取条目：越界（含负数、空列表）返回 null，调用方不必自己防下标越界。
// 需要「越界即拉回有效范围」的调用方先过 clampIndex 再取。
export function entryAt(entries: ClipboardEntry[], index: number): ClipboardEntry | null {
  if (index < 0 || index >= entries.length) return null;
  return entries[index] ?? null;
}
