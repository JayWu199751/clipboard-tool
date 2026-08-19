import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [elevated, setElevated] = useState<{ enabled: boolean; running: boolean }>({ enabled: false, running: false });
  const [notice, setNotice] = useState('');
  // 更换快捷键捕获状态（覆盖层）
  const [shortcutCapture, setShortcutCapture] = useState<{
    current: string;
    status: { text: string; ok: boolean } | null;
  } | null>(null);
  const shortcutCaptureRef = useRef(shortcutCapture);
  shortcutCaptureRef.current = shortcutCapture;
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  // Refs keep the global-shortcut callback free of stale closures.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;


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
    void window.clipboardAPI.getElevatedPaste().then(setElevated);
    window.clipboardAPI.onUpdated(setEntries);

    // 主进程在面板显示期间全局拦截 ↑/↓/Enter/Esc，这里只更新 UI / 触发复制。
    window.clipboardAPI.onPanelKey((action) => {
      const list = entriesRef.current;
      if (action === 'up') {
        setSelectedIndex((i) => (list.length === 0 ? 0 : (i - 1 + list.length) % list.length));
      } else if (action === 'down') {
        setSelectedIndex((i) => (list.length === 0 ? 0 : (i + 1) % list.length));
      } else if (action === 'enter') {
        const item = list[Math.min(selectedIndexRef.current, Math.max(list.length - 1, 0))];
        if (item) void window.clipboardAPI.copy(item.id);
      } else if (action === 'delete') {
        const item = list[Math.min(selectedIndexRef.current, Math.max(list.length - 1, 0))];
        if (item) void window.clipboardAPI.remove(item.id);
      } else if (action === 'escape') {
        // 捕获快捷键时 Esc 由覆盖层处理，这里忽略
        if (!shortcutCaptureRef.current) void window.clipboardAPI.hide();
      }
    });

    // UAC 响应慢时，助手连上后主进程会推送状态，自动勾选并提示。
    window.clipboardAPI.onElevatedStatus((status) => {
      setElevated(status);
      showNotice('提权粘贴已启用（助手已连接）');
    });

    // 每次呼出面板只重置选中项，不重新拉列表：
    // 历史由主进程 600ms 轮询实时推送，这里再 getHistory 会导致整列表重绘闪烁。
    window.clipboardAPI.onPanelShown(() => {
      setSelectedIndex(0);
    });
  }, []);

    // 更换快捷键：主进程进入捕获模式后显示覆盖层
    window.clipboardAPI.onShortcutCaptureStart((info) => {
      setShortcutCapture({ current: info.current, status: null });
    });
    window.clipboardAPI.onShortcutCaptureEnd(() => {
      setShortcutCapture(null);
    });

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

  // 列表变化时保持选中项在有效范围内。
  useEffect(() => {
    setSelectedIndex((i) => Math.max(0, Math.min(i, Math.max(entries.length - 1, 0))));
  }, [entries.length]);

  // 保持选中项可见。
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, entries]);

  const handleCopy = useCallback((id: string) => {
    void window.clipboardAPI.copy(id);
  }, []);

  const handleRemove = useCallback((id: string) => {
    void window.clipboardAPI.remove(id);
  }, []);

  const handleClear = useCallback(() => {
    void window.clipboardAPI.clear();
  }, []);

  const handleToggleTheme = useCallback(() => {
    setTheme((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'));
  }, []);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(''), 4000);
  }, []);

  const handleToggleElevated = useCallback(async () => {
    const next = !elevated.enabled;
    const res = await window.clipboardAPI.setElevatedPaste(next);
    setElevated(res);
    if (next && res.enabled) showNotice('提权粘贴已启用（助手已运行，可粘贴到管理员程序）');
    else if (next && res.canceled) showNotice('提权助手启动失败：UAC 授权被取消');
    else if (next && res.waiting) showNotice('等待 UAC 授权…同意后会自动启用');
    else if (!next) showNotice('提权粘贴已关闭');
  }, [elevated.enabled, showNotice]);

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

      <div className="list" ref={listRef}>
        {entries.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">📋</div>
            <p>还没有剪贴板内容，去复制一些文字或图片吧</p>
          </div>
        ) : (
          entries.map((entry, i) => (
            <div
              key={entry.id}
              className={`item${i === selectedIndex ? ' selected' : ''}`}
              data-selected={i === selectedIndex}
              // 鼠标悬浮不改变选中框（选择框只跟随键盘 ↑↓）
              onClick={() => setSelectedIndex(i)}
              onDoubleClick={() => handleCopy(entry.id)}
            >
              <div className="item-icon">
                {entry.type === 'image' ? <ImageIcon /> : <span className="text-badge">T</span>}
              </div>
              <div className="item-body">
                {entry.type === 'text' ? (
                  <p className="item-text">{entry.text}</p>
                ) : (
                  <div className="item-image">
                    <img src={entry.dataUrl} alt="剪贴板图片" draggable={false} />
                  </div>
                )}
                <div className="item-meta">
                  <span>{formatTime(entry.createdAt)}</span>
                  {entry.type === 'text' && (
                    <span className="item-snippet">{entry.text?.replace(/\s+/g, ' ').slice(0, 60)}</span>
                  )}
                </div>
              </div>
              <div className="item-actions">
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
        <span className="hint">↑↓ 选择 · Enter 复制粘贴 · Del 删除 · Esc 关闭</span>
        <div className="footer-controls">
          <label
            className="auto-paste"
            data-tip="以管理员权限运行助手，可粘贴进管理员程序（首次启用会弹 UAC 授权）" data-tip-multiline
          >
            <input type="checkbox" checked={elevated.enabled} onChange={handleToggleElevated} />
            <span>提权粘贴</span>
          </label>
        </div>
        {notice && <span className="notice">{notice}</span>}
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





