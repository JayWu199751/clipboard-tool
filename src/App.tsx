import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ClipboardEntry } from './types';

type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'clipboard-tool:theme';
const darkModeMedia = window.matchMedia('(prefers-color-scheme: dark)');

function getInitialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return darkModeMedia.matches ? 'dark' : 'light';
  return theme;
}

// 把 DOM 按键 code（KeyV / Digit1 / F5 / ArrowUp 等）转成 accelerator 主键，无法映射返回 null
function codeToKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);       // 字母 A-Z
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);     // 数字 0-9
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;  // F1-F24
  const map: Record<string, string> = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  };
  return map[code] ?? null;
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 把命中片段用 <mark> 包起来高亮（大小写不敏感、空格分词 AND 匹配）
function highlightText(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const terms = q.split(/\s+/).filter(Boolean);
  let parts: { text: string; hit: boolean }[] = [{ text, hit: false }];
  for (const term of terms) {
    const next: { text: string; hit: boolean }[] = [];
    for (const part of parts) {
      if (part.hit) {
        next.push(part);
        continue;
      }
      let lower = part.text.toLowerCase();
      let rest = part.text;
      let found = lower.indexOf(term);
      while (found !== -1) {
        if (found > 0) next.push({ text: rest.slice(0, found), hit: false });
        next.push({ text: rest.slice(found, found + term.length), hit: true });
        rest = rest.slice(found + term.length);
        lower = lower.slice(found + term.length);
        found = lower.indexOf(term);
      }
      if (rest) next.push({ text: rest, hit: false });
    }
    parts = next;
  }
  return parts.map((part, i) =>
    part.hit ? <mark key={i} className="highlight">{part.text}</mark> : part.text
  );
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function AutoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" opacity="0.35" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" x2="12" y1="17" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}

function App() {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  // 更换快捷键捕获状态（覆盖层）
  const [shortcutCapture, setShortcutCapture] = useState<{
    current: string;
    status: { text: string; ok: boolean } | null;
  } | null>(null);
  const shortcutCaptureRef = useRef(shortcutCapture);
  shortcutCaptureRef.current = shortcutCapture;

  const listRef = useRef<HTMLDivElement>(null);
  // Refs keep the global-shortcut callback free of stale closures.
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  const [searchActive, setSearchActive] = useState(false);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchActiveRef = useRef(searchActive);
  searchActiveRef.current = searchActive;
  const filteredEntriesRef = useRef<ClipboardEntry[]>([]);

  // 搜索过滤：大小写不敏感，空格分词后多词 AND；来源应用（名称/窗口标题/exe 路径）也参与匹配。
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    const terms = q.split(/\s+/).filter(Boolean);
    return entries.filter((entry) => {
      const haystack = [
        entry.type === 'text' ? entry.text ?? '' : '',
        entry.sourceApp?.appName ?? '',
        entry.sourceApp?.windowTitle ?? '',
        entry.sourceApp?.exePath ?? '',
      ].join(' ').toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [entries, query]);
  filteredEntriesRef.current = filteredEntries;

  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
    if (theme === 'system') {
      const onChange = () => {
        document.documentElement.dataset.theme = resolveTheme('system');
      };
      darkModeMedia.addEventListener('change', onChange);
      return () => darkModeMedia.removeEventListener('change', onChange);
    }
  }, [theme]);

  useEffect(() => {
    void window.clipboardAPI.getHistory().then(setEntries);
    window.clipboardAPI.onUpdated(setEntries);

    // 主进程在面板显示期间全局拦截 ↑/↓/Enter/Esc，这里只更新 UI / 触发复制。
    window.clipboardAPI.onPanelKey((action) => {
      const list = filteredEntriesRef.current;
      if (action === 'up') {
        // 在第一个时按上键不跳转，保持在第一个
        setSelectedIndex((i) => Math.max(0, i - 1));
      } else if (action === 'down') {
        // 在最后一个时按下键不跳转，保持在最后一个
        setSelectedIndex((i) => Math.min(Math.max(list.length - 1, 0), i + 1));
      } else if (action === 'enter') {
        const item = list[Math.min(selectedIndexRef.current, Math.max(list.length - 1, 0))];
        if (item) void window.clipboardAPI.copy(item.id);
      } else if (action === 'delete') {
        // 搜索模式下 Del 让位给搜索输入框（编辑文字），不删除条目
        if (searchActiveRef.current) return;
        const item = list[Math.min(selectedIndexRef.current, Math.max(list.length - 1, 0))];
        if (item) void window.clipboardAPI.remove(item.id);
      } else if (action === 'pin') {
        // 搜索模式下 Z 让位给搜索输入框（打字），不置顶
        if (searchActiveRef.current) return;
        const item = list[Math.min(selectedIndexRef.current, Math.max(list.length - 1, 0))];
        if (item) void window.clipboardAPI.pin(item.id);
      } else if (action === 'escape') {
        // 捕获快捷键时 Esc 由覆盖层处理，这里忽略；搜索模式下 Esc 由主进程先退出搜索
        if (!shortcutCaptureRef.current) void window.clipboardAPI.hide();
      } else if (action === 'search-enter') {
        setSearchActive(true);
        setQuery('');
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else if (action === 'search-exit') {
        setSearchActive(false);
        setQuery('');
        searchInputRef.current?.blur();
      }
    });


    // 每次呼出面板重置选中项 & 搜索态，不重新拉列表：
    // 历史由主进程 600ms 轮询实时推送，这里再 getHistory 会导致整列表重绘闪烁。
    window.clipboardAPI.onPanelShown(() => {
      setSelectedIndex(0);
      setSearchActive(false);
      setQuery('');
      searchInputRef.current?.blur();
    });
  }, []);

  // 更换快捷键：主进程进入捕获模式后显示覆盖层
  useEffect(() => {
    window.clipboardAPI.onShortcutCaptureStart((info) => {
      setShortcutCapture({ current: info.current, status: null });
    });
    window.clipboardAPI.onShortcutCaptureEnd(() => {
      setShortcutCapture(null);
    });
  }, []);

  // 更换快捷键捕获模式：窗口聚焦后在此监听键盘组合键
  useEffect(() => {
    if (!shortcutCapture) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        void window.clipboardAPI.cancelShortcut();
        setShortcutCapture(null);
        return;
      }
      const mods: string[] = [];
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      const mainKey = codeToKey(e.code);
      if (!mainKey) return; // 忽略无法映射的按键（如单独按修饰键）
      // 全局快捷键必须至少包含 Ctrl / Alt / Win 之一，避免误设
      if (!mods.some((m) => m !== 'Shift')) {
        setShortcutCapture((s) => (s ? { ...s, status: { text: '请包含 Ctrl / Alt / Win 修饰键', ok: false } } : s));
        return;
      }
      const accel = [...mods, mainKey].join('+');
      void window.clipboardAPI.tryShortcut(accel).then((res) => {
        if (!res.ok) {
          setShortcutCapture((s) => (s ? { ...s, status: { text: `${res.formatted} 已被占用或无效，请换一个`, ok: false } } : s));
          return;
        }
        setShortcutCapture((s) => (s ? { ...s, status: { text: `已设置为 ${res.formatted}`, ok: true } } : s));
        setTimeout(() => setShortcutCapture(null), 1200);
      });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [shortcutCapture]);

  // 列表/搜索结果变化时保持选中项在有效范围内（搜索时针对过滤后的结果）。
  useEffect(() => {
    setSelectedIndex((i) => Math.max(0, Math.min(i, Math.max(filteredEntries.length - 1, 0))));
  }, [filteredEntries.length]);

  // 搜索模式下每次查询变化，选中项重置到第一个匹配项。
  useEffect(() => {
    if (searchActiveRef.current) setSelectedIndex(0);
  }, [query]);

  // 保持选中项可见。
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, filteredEntries]);

  const handleCopy = useCallback((id: string) => {
    void window.clipboardAPI.copy(id);
  }, []);

  const handleRemove = useCallback((id: string) => {
    void window.clipboardAPI.remove(id);
  }, []);

  const handlePin = useCallback((id: string) => {
    void window.clipboardAPI.pin(id);
  }, []);

  const handleClear = useCallback(() => {
    void window.clipboardAPI.clear();
  }, []);

  const handleToggleTheme = useCallback(() => {
    setTheme((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'));
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-title">剪贴板</span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-btn"
            data-tip={theme === 'light'
                ? '切换到深色模式'
                : theme === 'dark'
                  ? '切换到跟随系统'
                  : '切换到浅色模式'}
            data-tip-pos="below"
            onClick={handleToggleTheme}
          >
            {theme === 'light' ? <MoonIcon /> : theme === 'dark' ? <SunIcon /> : <AutoIcon />}
          </button>
          <button
            type="button"
            className="icon-btn"
            data-tip="清空历史" data-tip-pos="below"
            disabled={entries.length === 0}
            onClick={handleClear}
          >
            <TrashIcon />
          </button>
        </div>
      </header>

      <div
        className={`search-wrap${searchActive ? ' active' : ' disabled'}`}
        data-tip={searchActive ? undefined : '按 空格 搜索'}
        data-tip-pos="below"
        onClick={() => { if (!searchActive) void window.clipboardAPI.activateSearch(); }}
      >
        <SearchIcon />
        <input
          ref={searchInputRef}
          className="search"
          type="text"
          placeholder={searchActive ? '搜索文字或来源应用…' : ''}
          value={query}
          readOnly={!searchActive}
          onChange={(e) => setQuery(e.target.value)}
          onCompositionStart={() => void window.clipboardAPI.setSearchComposing(true)}
          onCompositionEnd={() => void window.clipboardAPI.setSearchComposing(false)}
          spellCheck={false}
          aria-label="搜索历史"
        />
        {searchActive && query.length > 0 && (
          <button type="button" className="clear-query" data-tip="清空" onClick={() => setQuery('')}>
            ×
          </button>
        )}
      </div>

      <div className="list" ref={listRef}>
        {filteredEntries.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">{entries.length === 0 ? '📋' : '🔍'}</div>
            <p>
              {entries.length === 0
                ? '还没有剪贴板内容，去复制一些文字或图片吧'
                : `没有找到匹配 “${query.trim()}” 的结果`}
            </p>
          </div>
        ) : (
          filteredEntries.map((entry, i) => (
            <div
              key={entry.id}
              className={`item${i === selectedIndex ? ' selected' : ''}`}
              data-selected={i === selectedIndex}
              // 鼠标悬浮不改变选中框（选择框只跟随键盘 ↑↓）
              onClick={() => setSelectedIndex(i)}
              onDoubleClick={() => handleCopy(entry.id)}
            >
              <div className="item-icon" title={entry.sourceApp ? `${entry.sourceApp.appName} — ${entry.sourceApp.windowTitle || entry.sourceApp.exePath}` : undefined}>
                {entry.sourceApp?.iconDataUrl ? (
                  <img src={entry.sourceApp.iconDataUrl} alt={entry.sourceApp.appName} className="source-app-icon" draggable={false} />
                ) : entry.type === 'image' ? (
                  <ImageIcon />
                ) : (
                  <span className="text-badge">T</span>
                )}
              </div>
              <div className="item-body">
                {entry.type === 'text' ? (
                  <p className="item-text">{searchActive ? highlightText(entry.text ?? '', query) : entry.text}</p>
                ) : (
                  <div className="item-image">
                    <img src={entry.dataUrl} alt="剪贴板图片" draggable={false} />
                  </div>
                )}
                <div className="item-meta">
                  <span>{formatTime(entry.createdAt)}</span>
                </div>
              </div>
              <div className="item-actions">
                <button type="button" className="icon-btn small" data-tip={entry.pinned ? '取消置顶' : '置顶'} onClick={(e) => { e.stopPropagation(); handlePin(entry.id); }}>
                  <PinIcon filled={entry.pinned} />
                </button>
                <button type="button" className="icon-btn small" data-tip="复制并粘贴" onClick={(e) => { e.stopPropagation(); handleCopy(entry.id); }}>
                  <CopyIcon />
                </button>
                <button type="button" className="icon-btn small danger" data-tip="删除" onClick={(e) => { e.stopPropagation(); handleRemove(entry.id); }}>
                  <TrashIcon />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <footer className="footer">
        <span className="hint">
          {searchActive
            ? 'Esc 退出搜索 · ↑↓ 选择 · Enter 复制粘贴'
            : '空格 搜索 · ↑↓ 选择 · Enter 复制粘贴 · Del 删除 · Z 置顶 · Esc 关闭'}
        </span>

      </footer>

      {shortcutCapture && (
        <div className="shortcut-overlay">
          <div className="shortcut-card">
            <h2 className="shortcut-title">更换快捷键</h2>
            <p className="shortcut-current">
              当前：<span className="kbd">{shortcutCapture.current}</span>
            </p>
            <p className="shortcut-hint">
              请按下新的快捷键组合，例如
              <span className="kbd">Ctrl</span> + <span className="kbd">Shift</span> + <span className="kbd">V</span>
            </p>
            {shortcutCapture.status && (
              <p className={`shortcut-status ${shortcutCapture.status.ok ? 'ok' : 'err'}`}>
                {shortcutCapture.status.text}
              </p>
            )}
            <div className="shortcut-actions">
              <button
                type="button"
                className="shortcut-cancel"
                onClick={() => {
                  void window.clipboardAPI.cancelShortcut();
                  setShortcutCapture(null);
                }}
              >
                取消（Esc）
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;



