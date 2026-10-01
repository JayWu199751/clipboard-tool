// 面板视图规则：搜索过滤、命中高亮、选中项落位，外加四条原先住在组件里的判定
// （圆角外穿透、相对时间、按键码映射、滚动条 thumb 几何）。HUD 迁移后来源配色退役；
// 自绘滚动条因「原生条在真机占布局宽度、把卡片右缘垫得比左缘远」而回归（见 styles.css）。
// 纯逻辑、不依赖 React 与 Tauri，可被 scripts/panel-view-unit.mjs 用 plain node 直测。
// 这里承载 README「操作」与 ADR-0004 定下的三条规则：
//   匹配规则（大小写不敏感、空格分词多词 AND、正文+备注+来源应用五字段）
//   结果排序（保持原始顺序，不做匹配度排序）
//   选中项（每次查询变化重置到第一个匹配项；列表变短时拉回有效范围）
// 以及 ADR-0008 的一条判据：能脱离 DOM 与 React 断言的，都是判定，都住在这里。
// 渲染层只负责读 DOM、调判定、把结果画出来。

import type { ClipboardEntry, ThemePreference } from './types';

export interface HighlightSpan {
  text: string;
  hit: boolean;
}

export type NavDirection = 'up' | 'down';

// 查询分词：去空白、大小写归一。空查询 = 不过滤。（filterEntries / highlight 共用，不外抛）
function queryTerms(query: string): string[] {
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
// 需要「越界即拉回有效范围」的调用方先过 clampIndex 再取。泛型：ClipItem 视图同样适用。
export function entryAt<T>(entries: T[], index: number): T | null {
  if (index < 0 || index >= entries.length) return null;
  return entries[index] ?? null;
}

// ---------- 以下五条同样与 React / DOM 无关，只是原先住在 App.tsx 里 ----------

// 面板窗口矩形（CSS 像素，来自 getBoundingClientRect）。
export interface WindowRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// 圆角外穿透：矩形之外、或落在四角圆弧之外，鼠标都应穿透到下层窗口。
// radius 由调用方从样式表读出后传入 —— 圆角的单一真源是 --radius-window，
// 这里再写一个数就是第四份复制（上一轮深化点名的正是这条漂移）。
export function shouldIgnoreMouse(
  x: number,
  y: number,
  rect: WindowRect,
  radius: number,
): boolean {
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return true;
  // 浏览器把 border-radius 收敛到不超过短边一半，这里同口径，半径抄大了也不会把整窗判成穿透
  const r = Math.max(0, Math.min(radius, (rect.right - rect.left) / 2, (rect.bottom - rect.top) / 2));
  // 只有横纵同时落进某个角才需要判弧；落在直边带上的点一律算窗口内
  const cx = x < rect.left + r ? rect.left + r : x > rect.right - r ? rect.right - r : null;
  const cy = y < rect.top + r ? rect.top + r : y > rect.bottom - r ? rect.bottom - r : null;
  if (cx === null || cy === null) return false;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy > r * r;
}

// 相对时间五档（HUD 迁移：阈值词表照搬源 UI clipboard.js timeAgo——
// 刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前，界面全中文）。
// now 由调用方传入（渲染层用 Date.now()），阈值边界因此可以直接单测。
export function formatTime(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 2 * 86_400_000) return '昨天';
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

// DOM 按键 code（KeyV / Digit1 / F5 / ArrowUp 等）→ accelerator 主键，无法映射返回 null。
export function accelKeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); // 字母 A-Z
  if (/^Digit[0-9]$/.test(code)) return code.slice(5); // 数字 0-9
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code; // F1-F24
  const map: Record<string, string> = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  };
  return map[code] ?? null;
}

// 自绘滚动条 thumb 的几何：高度按可视比例、不小于 MIN_THUMB_HEIGHT，位置线性映射到滚动进度。
export interface ScrollbarThumb {
  visible: boolean;
  top: number;
  height: number;
}

// 按钮只展示主进程的主题偏好；生效主题仍由 prefers-color-scheme 决定。
export function themeControl(preference: ThemePreference) {
  const controls = {
    light: { label: '亮色', icon: 'i-sun', next: 'dark' },
    dark: { label: '暗色', icon: 'i-moon', next: 'system' },
    system: { label: '跟随系统', icon: 'i-monitor', next: 'light' },
  } as const;
  return controls[preference];
}

export const MIN_THUMB_HEIGHT = 28;

export function scrollbarThumb(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): ScrollbarThumb {
  if (scrollHeight <= clientHeight) {
    return { visible: false, top: 0, height: MIN_THUMB_HEIGHT };
  }
  const height = Math.max(MIN_THUMB_HEIGHT, clientHeight * (clientHeight / scrollHeight));
  const maxTop = clientHeight - height;
  const maxScroll = scrollHeight - clientHeight;
  const top = maxScroll > 0 ? (scrollTop / maxScroll) * maxTop : 0;
  return { visible: true, top, height };
}
