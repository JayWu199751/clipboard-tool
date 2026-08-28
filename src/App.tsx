import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ClipboardEntry } from './types';

type Theme = 'light' | 'dark' | 'system';
type FocusError = { stage: string; reason: string; message: string };

const THEME_KEY = 'clipboard-tool:theme';
const MAX_NOTE_LENGTH = 200;
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


function IconSearch(){return(<svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx={11} cy={11} r={7}/><path d="m20 20-3.8-3.8"/></svg>);}
function IconTrash(){return(<svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>);}
function IconCopy(){return(<svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><rect width={14} height={14} x={8} y={8} rx={2} ry={2}/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>);}
function IconPin({filled}: {filled?: boolean}){return(<svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill={filled?"currentColor":"none"}><path d="M12 17v5" stroke="currentColor"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" stroke="currentColor"/></svg>);}
function IconNote({filled}: {filled?: boolean}){return(<svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-4 3V7a3 3 0 0 1 3-3h10a4 4 0 0 1 4 4Z" stroke="currentColor"/><path d="M8 9h8M8 13h5" stroke="currentColor" fill={filled?"currentColor":"none"}/></svg>);}
function IconImage(){return(<svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><rect width={18} height={18} x={3} y={3} rx={2} ry={2}/><circle cx={9} cy={9} r={2}/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>);}
function IconX(){return(<svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>);}
function IconClipboard(){return(<svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h6a1 1 0 0 1 1 1v1H8V6a1 1 0 0 1 1-1Z"/><rect x={6} y={8} width={12} height={12} rx={2}/></svg>);}

function IconSun(){return(<svg className="icon" style={{width:15,height:15}} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx={12} cy={12} r={4}/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>);}
function IconMoon(){return(<svg className="icon" style={{width:15,height:15}} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>);}
function IconAuto(){return(<svg className="icon" style={{width:15,height:15}} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx={12} cy={12} r={9}/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" opacity={0.35}/></svg>);}
function getSourceTone(appName?: string){const n=(appName||"").toLowerCase();if(n.includes("备忘录")||n.includes("便签")||n.includes("notes"))return"source-notes";if(n.includes("figma"))return"source-figma";if(n.includes("safari")||n.includes("浏览器")||n.includes("browser")||n.includes("chrome")||n.includes("edge"))return"source-safari";if(n.includes("pages"))return"source-pages";if(n.includes("访达")||n.includes("finder")||n.includes("explorer"))return"source-finder";if(n.includes("预览")||n.includes("preview"))return"source-preview";if(n.includes("文本编辑")||n.includes("textedit")||n.includes("notepad"))return"source-textedit";if(n.includes("终端")||n.includes("terminal")||n.includes("powershell")||n.includes("cmd"))return"source-terminal";if(n.includes("截图")||n.includes("screenshot")||n.includes("snip"))return"source-screenshot";if(n.includes("代码")||n.includes("code")||n.includes("vscode")||n.includes("xcode"))return"source-code";return"source-icon";}

// MOCK_CLIPBOARD_API for preview (when running outside Electron)
if (typeof window !== "undefined" && !(window as any).clipboardAPI) {
  (window as any).clipboardAPI = {
    getHistory: async () => {
      // Mock data for preview
      const now = Date.now();
      return [
        { id: "1", type: "text", text: "v2.4.0\n- 支持新的 Fluid Search\n- 提升窗口缩放时的帧率...", createdAt: now - 2*60*1000, sourceApp: { appName: "备忘录", windowTitle: "", exePath: "", iconDataUrl: null }, pinned: false, pinnedAt: 0, note: "" },
        { id: "2", type: "image", dataUrl: "https://picsum.photos/seed/clip1/200/120", createdAt: now - 18*60*1000, sourceApp: { appName: "Figma", windowTitle: "", exePath: "", iconDataUrl: null }, pinned: false, pinnedAt: 0, note: "" },
        { id: "3", type: "text", text: "developer.apple.com\nhttps://developer.apple.com/design/human-interface-guidelines/", createdAt: now - 42*60*1000, sourceApp: { appName: "Safari", windowTitle: "", exePath: "", iconDataUrl: null }, pinned: false, pinnedAt: 0, note: "" },
        { id: "4", type: "text", text: "主题：桌面剪切板轻评审\n结论：保留主操作卡、减少弹窗，用视频情绪承载高信息。", createdAt: now - 60*60*1000, sourceApp: { appName: "备忘录", windowTitle: "", exePath: "", iconDataUrl: null }, pinned: false, pinnedAt: 0, note: "" },
        { id: "5", type: "text", text: "fig Design-Specs.fig", createdAt: now - 2*60*60*1000, sourceApp: { appName: "Figma", windowTitle: "", exePath: "", iconDataUrl: null }, pinned: false, pinnedAt: 0, note: "" },
        { id: "6", type: "image", dataUrl: "https://picsum.photos/seed/clip2/200/120", createdAt: now - 4*60*60*1000, sourceApp: { appName: "预览", windowTitle: "", exePath: "", iconDataUrl: null }, pinned: false, pinnedAt: 0, note: "" },
      ];
    },
    onUpdated: (_cb: any) => {},
    onPanelKey: (_cb: any) => {},
    onPanelShown: (_cb: any) => {},
    onFocusError: (_cb: any) => {},
    copy: async () => true,
    remove: async () => true,
    pin: async () => true,
    clear: async () => true,
    setNote: async () => true,
    beginNoteEdit: async () => true,
    endNoteEdit: async () => {},
    onShortcutCaptureStart: () => {},
    onShortcutCaptureEnd: () => {},
    tryShortcut: async () => ({ok: false, formatted: ""}),
    cancelShortcut: async () => {},
    hide: async () => {},
    setIgnoreMouse: async () => {},
    activateSearch: async () => {},
    setSearchComposing: async () => {},
  };
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
  const [focusError, setFocusError] = useState<FocusError | null>(null);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchActiveRef = useRef(searchActive);
  searchActiveRef.current = searchActive;
  const filteredEntriesRef = useRef<ClipboardEntry[]>([]);

  const [noteEdit, setNoteEdit] = useState<{ id: string; draft: string } | null>(null);
  const noteEditRef = useRef<{ id: string; draft: string } | null>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  const detailNoteRef = useRef<HTMLInputElement>(null);
  const noteSavePendingRef = useRef(false);
  const cancelNoteBlurRef = useRef(false);

  // 搜索过滤：大小写不敏感，空格分词后多词 AND；正文、备注和来源应用都参与匹配。
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    const terms = q.split(/\s+/).filter(Boolean);
    return entries.filter((entry) => {
      const haystack = [
        entry.type === 'text' ? entry.text ?? '' : '',
        entry.note ?? '',
        entry.sourceApp?.appName ?? '',
        entry.sourceApp?.windowTitle ?? '',
        entry.sourceApp?.exePath ?? '',
      ].join(' ').toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [entries, query]);
  filteredEntriesRef.current = filteredEntries;

  const openNoteEditor = useCallback((targetId: string | null) => {
    const list = filteredEntriesRef.current;
    const target = targetId
      ? list.find((entry) => entry.id === targetId)
      : list[Math.min(selectedIndexRef.current, Math.max(list.length - 1, 0))];
    if (!target) return;
    const next = { id: target.id, draft: target.note ?? '' };
    noteEditRef.current = next;
    setNoteEdit(next);
    // 红框在列表 item-meta 位置，优先聚焦列表输入框，详情为兜底
    const doFocus = () => {
      const listEl = noteInputRef.current;
      const detailEl = detailNoteRef.current;
      // 若列表输入框存在但 detail 也存在，优先让列表获得焦点（符合截图红框）
      if (listEl) { listEl.focus(); try{ listEl.select(); }catch{} return; }
      if (detailEl) { detailEl.focus(); try{ detailEl.select(); }catch{} }
    };
    requestAnimationFrame(() => requestAnimationFrame(doFocus));
    setTimeout(doFocus, 60);
    setTimeout(doFocus, 150);
  }, []);

  const saveNoteDraft = useCallback((id: string, draft: string) => {
    noteSavePendingRef.current = true;
    return window.clipboardAPI.setNote(id, draft)
      .catch(() => false)
      .finally(() => {
        noteSavePendingRef.current = false;
      });
  }, []);

  const finishNoteEditing = useCallback((cancel = false) => {
    const edit = noteEditRef.current;
    if (!edit || noteSavePendingRef.current) return;
    noteEditRef.current = null;
    setNoteEdit(null);
    if (cancel) {
      cancelNoteBlurRef.current = true;
      window.setTimeout(() => {
        cancelNoteBlurRef.current = false;
      }, 0);
      void window.clipboardAPI.endNoteEdit();
      return;
    }
    void saveNoteDraft(edit.id, edit.draft).then(() => window.clipboardAPI.endNoteEdit());
  }, [saveNoteDraft]);

  const handleNoteEditExit = useCallback(() => {
    const edit = noteEditRef.current;
    if (edit && !noteSavePendingRef.current) {
      noteEditRef.current = null;
      setNoteEdit(null);
      void saveNoteDraft(edit.id, edit.draft);
    } else {
      noteEditRef.current = null;
      setNoteEdit(null);
    }
    cancelNoteBlurRef.current = false;
  }, [saveNoteDraft]);

  const handleBeginNoteEdit = useCallback((index: number, id: string) => {
    setSelectedIndex(index);
    const current = noteEditRef.current;
    if (!current) {
      void window.clipboardAPI.beginNoteEdit(id);
      return;
    }
    if (current.id === id) {
      finishNoteEditing(false);
      return;
    }
    noteEditRef.current = null;
    setNoteEdit(null);
    void saveNoteDraft(current.id, current.draft).then(async () => {
      await window.clipboardAPI.endNoteEdit();
      await window.clipboardAPI.beginNoteEdit(id);
    });
  }, [finishNoteEditing, saveNoteDraft]);
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
    window.clipboardAPI.onPanelKey((action, noteEntryId) => {
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
      } else if (action === 'note-edit-enter') {
        openNoteEditor(noteEntryId ?? null);
      } else if (action === 'note-edit-exit') {
        handleNoteEditExit();
      }
    });


    // 每次呼出面板重置选中项 & 搜索态，不重新拉列表：
    // 历史由主进程 600ms 轮询实时推送，这里再 getHistory 会导致整列表重绘闪烁。
    window.clipboardAPI.onPanelShown(() => {
      setSelectedIndex(0);
      setSearchActive(false);
      setQuery('');
      setFocusError(null);
      noteEditRef.current = null;
      setNoteEdit(null);
      noteSavePendingRef.current = false;
      cancelNoteBlurRef.current = false;
      searchInputRef.current?.blur();
    });
    window.clipboardAPI.onFocusError(setFocusError);
  }, [handleNoteEditExit, openNoteEditor]);

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

  // 透明窗口点击穿透：0 距离（窗口即卡片） + 12px 圆角外应穿透到下层窗口
  useEffect(() => {
    const desktop = document.querySelector('.desktop') as HTMLElement | null;
    const appWindow = document.querySelector('.app-window') as HTMLElement | null;
    if (!desktop || !appWindow) return;
    let lastIgnore: boolean | null = null;
    const R = 12; // --radius-window
    const update = (e: MouseEvent) => {
      const rect = appWindow.getBoundingClientRect();
      const x = e.clientX;
      const y = e.clientY;
      let shouldIgnore = x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
      if (!shouldIgnore) {
        const inTopLeft = x < rect.left + R && y < rect.top + R;
        const inTopRight = x > rect.right - R && y < rect.top + R;
        const inBottomLeft = x < rect.left + R && y > rect.bottom - R;
        const inBottomRight = x > rect.right - R && y > rect.bottom - R;
        if (inTopLeft) {
          const dx = x - (rect.left + R);
          const dy = y - (rect.top + R);
          if (dx * dx + dy * dy > R * R) shouldIgnore = true;
        } else if (inTopRight) {
          const dx = x - (rect.right - R);
          const dy = y - (rect.top + R);
          if (dx * dx + dy * dy > R * R) shouldIgnore = true;
        } else if (inBottomLeft) {
          const dx = x - (rect.left + R);
          const dy = y - (rect.bottom - R);
          if (dx * dx + dy * dy > R * R) shouldIgnore = true;
        } else if (inBottomRight) {
          const dx = x - (rect.right - R);
          const dy = y - (rect.bottom - R);
          if (dx * dx + dy * dy > R * R) shouldIgnore = true;
        }
      }
      if (shouldIgnore !== lastIgnore) {
        lastIgnore = shouldIgnore;
        // @ts-ignore
        (window as any).clipboardAPI?.setIgnoreMouse?.(shouldIgnore, true);
      }
    };
    const onLeave = () => {
      if (lastIgnore !== true) {
        lastIgnore = true;
        (window as any).clipboardAPI?.setIgnoreMouse?.(true, true);
      }
    };
    const onEnter = (e: MouseEvent) => update(e);
    desktop.addEventListener('mousemove', update);
    desktop.addEventListener('mouseenter', onEnter);
    desktop.addEventListener('mouseleave', onLeave);
    // 初始状态设为不忽略，确保面板内可点击
    (window as any).clipboardAPI?.setIgnoreMouse?.(false, true);
    return () => {
      desktop.removeEventListener('mousemove', update);
      desktop.removeEventListener('mouseenter', onEnter);
      desktop.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  // 保持选中项可见。
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, filteredEntries]);

  ;

    const selectedEntry = filteredEntries[selectedIndex] ?? null;
  const themeTip = theme === "light" ? "切换到深色模式" : theme === "dark" ? "切换到跟随系统" : "切换到浅色模式";
  const [detailOpen, setDetailOpen] = useState(false);
  const [toast, setToast] = useState<{text: string; actionLabel?: string; onAction?: () => void} | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [scrollState, setScrollState] = useState({ visible: false, top: 0, height: 28 });
  const showToast = useCallback((text: string, actionLabel?: string, onAction?: () => void) => {
    setToast({ text, actionLabel, onAction });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400);
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let hideTimer: number | null = null;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight <= clientHeight) { setScrollState({ visible: false, top: 0, height: 28 }); return; }
      const visibleRatio = clientHeight / scrollHeight;
      const thumbH = Math.max(28, clientHeight * visibleRatio);
      const maxTop = clientHeight - thumbH;
      const maxScroll = scrollHeight - clientHeight;
      const top = maxScroll > 0 ? (scrollTop / maxScroll) * maxTop : 0;
      setScrollState({ visible: true, top, height: thumbH });
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setScrollState((s) => ({ ...s, visible: false })), 900);
    };
    const onScroll = () => update();
    el.addEventListener("scroll", onScroll, { passive: true });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", onScroll); ro.disconnect(); if (hideTimer) window.clearTimeout(hideTimer); };
  }, [filteredEntries.length]);
  const handleCopy = useCallback((id: string) => { void window.clipboardAPI.copy(id); showToast("已复制并粘贴"); }, [showToast]);
  const handleRemove = useCallback((id: string) => { void window.clipboardAPI.remove(id); showToast("已删除"); }, [showToast]);
  const handlePin = useCallback((id: string) => { void window.clipboardAPI.pin(id); }, []);
  const handleClear = useCallback(() => { void window.clipboardAPI.clear(); showToast("历史已清空"); }, [showToast]);
  const handleToggleTheme = useCallback(() => { setTheme((t) => (t === "light" ? "dark" : t === "dark" ? "system" : "light")); }, []);
  const openDetail = useCallback((idx: number) => { setSelectedIndex(idx); setDetailOpen(true); }, []);
  return (
    <div className="desktop">
      <div className="app-window" lang="zh-CN">
        <header className="titlebar">
          <div className="titlebar-center"><span>剪切板</span><span>{filteredEntries.length ? `${filteredEntries.length} 项 · ${entries.length} 总数` : `${entries.length} 项`}</span></div>
          <div className="titlebar-actions">
            <button type="button" className="icon-button" data-tooltip={themeTip} aria-label={themeTip} onClick={handleToggleTheme}>{theme === "light" ? <IconMoon/> : theme === "dark" ? <IconAuto/> : <IconSun/>}</button>
            <button type="button" className="icon-button" data-tooltip="清空历史" aria-label="清空历史" disabled={entries.length===0} onClick={handleClear}><IconTrash/></button>
          </div>
        </header>
        <div className="app-body">
          <section className="content">
            <div className="card-top">
              <div className="card-search">
                <label className={`search-field ${searchActive?"":"is-disabled"}`} onClick={()=>{if(!searchActive) void window.clipboardAPI.activateSearch();}}>
                  <IconSearch/>
                  <input ref={searchInputRef} type="text" placeholder={searchActive?"搜索文字、备注或来源应用…":"搜索剪切板…"} value={query} readOnly={!searchActive} onChange={(e)=>setQuery(e.target.value)} onCompositionStart={()=>void window.clipboardAPI.setSearchComposing(true)} onCompositionEnd={()=>void window.clipboardAPI.setSearchComposing(false)} spellCheck={false} aria-label="搜索历史"/>
                  {searchActive && query.length>0 && (<button type="button" className="icon-button" style={{width:22,height:22}} aria-label="清空搜索" onClick={(e)=>{e.preventDefault();e.stopPropagation();setQuery("");searchInputRef.current?.focus();}}><IconX/></button>)}
                </label>
              </div>
            </div>
            <div className="content-layout">
              <section className="history-panel" aria-label="剪切记录">
                <div className="history-heading"><span>{searchActive && query.trim() ? "搜索结果" : "复制项列表"}</span><span>{filteredEntries.length} 项</span></div>
                <div className="history-list" ref={listRef} role="listbox" aria-label="剪切记录列表">
                  {filteredEntries.length===0 ? (
                    <div className="empty-state" role="status">
                      <div className="empty-icon" aria-hidden="true">{entries.length===0?"📋":"🔍"}</div>
                      <div className="empty-title">{entries.length===0?"还没有剪切板内容":`没有找到匹配"${query.trim()}"的结果`}</div>
                      <div className="empty-subtitle">{entries.length===0?"去复制一些文字或图片吧，它们会自动出现在这里":"试试换个关键词或清空搜索条件"}</div>
                    </div>
                  ) : (
                    filteredEntries.map((entry,i)=>{
                      const isSelected=i===selectedIndex;
                      const sourceTone=getSourceTone(entry.sourceApp?.appName);
                      const previewText=(entry.text??"").trim();
                      return(
                        <div key={entry.id} role="option" aria-selected={isSelected} data-selected={isSelected?"true":"false"} className={`history-item${isSelected?" is-selected":""}`} onClick={()=>setSelectedIndex(i)} onDoubleClick={()=>handleCopy(entry.id)}>
                          <div className={`item-icon source-icon ${sourceTone} type-${entry.type}`} title={entry.sourceApp? `${entry.sourceApp.appName} — ${entry.sourceApp.windowTitle || entry.sourceApp.exePath}`:undefined} onClick={(e)=>{e.stopPropagation();openDetail(i);}} role="button" tabIndex={0} aria-label="查看详情">
                            {entry.sourceApp?.iconDataUrl ? (<img src={entry.sourceApp.iconDataUrl} alt={entry.sourceApp.appName} style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:10}} draggable={false}/>) : entry.type==="image" ? (<IconImage/>) : (<span style={{fontSize:11,fontWeight:700}}><IconClipboard/></span>)}
                          </div>
                          <div className="item-main" onClick={(e)=>{e.stopPropagation();openDetail(i);}}>
                            {entry.type==="text" ? (<div className={`item-preview ${!previewText?"is-empty":""}`} title={entry.text}>{previewText ? (searchActive? highlightText(previewText,query):previewText) : "（空内容）"}</div>) : (<div className="item-preview is-image"><div className="image-wrap"><img src={entry.dataUrl} alt="剪贴板图片" draggable={false} style={{width:"100%",height:"100%",objectFit:"cover",display:"block",borderRadius:8}}/></div></div>)}
                            <div className="item-meta"><span className="item-time" style={{fontVariantNumeric:"tabular-nums"}}>{formatTime(entry.createdAt)}</span>{entry.pinned && <><span className="meta-separator">·</span><span style={{color:"var(--accent)",fontWeight:600}}>已置顶</span></>}{noteEdit?.id===entry.id ? (<><span className="meta-separator">·</span><input ref={noteEdit?.id===entry.id ? (noteInputRef as any) : undefined} className="note-input" value={noteEdit.draft} maxLength={MAX_NOTE_LENGTH} placeholder="添加备注" spellCheck={false} onChange={(e)=>{if(!noteEdit) return; const next={...noteEdit,draft:e.target.value}; noteEditRef.current=next; setNoteEdit(next);}} onKeyDown={(e)=>{if(e.key==="Escape"){e.preventDefault(); finishNoteEditing(true);} else if(e.key==="Enter" && !e.nativeEvent.isComposing){e.preventDefault(); finishNoteEditing(false);}}} onBlur={()=>{ if(!cancelNoteBlurRef.current) finishNoteEditing(false); }} onClick={(e)=>e.stopPropagation()} aria-label="备注输入框" /></>) : entry.note ? (<><span className="meta-separator">·</span><span className="item-note" title={entry.note} onClick={(e)=>{e.stopPropagation(); handleBeginNoteEdit(i,entry.id);}} style={{cursor:"pointer"}}>{searchActive? highlightText(entry.note,query):entry.note}</span></>) : null}</div>
                          </div>
                          <div className="item-actions">
                            <button type="button" className="icon-button" data-tooltip={entry.pinned?"取消置顶":"置顶"} data-action="pin" aria-label={entry.pinned?"取消置顶":"置顶"} onClick={(e)=>{e.stopPropagation();handlePin(entry.id);}}><IconPin filled={entry.pinned}/></button>
                            <button type="button" className="icon-button" data-tooltip={entry.note?"编辑备注":"添加备注"} data-action="note" aria-label={entry.note?"编辑备注":"添加备注"} onClick={(e)=>{e.stopPropagation();handleBeginNoteEdit(i,entry.id);}}><IconNote filled={Boolean(entry.note)}/></button>
                            <button type="button" className="icon-button" data-tooltip="复制并粘贴" data-action="copy" aria-label="复制并粘贴" onClick={(e)=>{e.stopPropagation();handleCopy(entry.id);}}><IconCopy/></button>
                            <button type="button" className="icon-button is-danger" data-tooltip="删除" data-action="trash" aria-label="删除" onClick={(e)=>{e.stopPropagation();handleRemove(entry.id);}}><IconTrash/></button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <div className={`history-scrollbar ${scrollState.visible?"is-visible":""}`} aria-hidden="true"><span className="history-scrollbar-thumb" style={{height:scrollState.height,transform:`translateY(${scrollState.top}px)`}}/></div>
              </section>
              <aside className={`detail-panel ${detailOpen?"mobile-open":""}`} aria-label="详情" aria-hidden={!detailOpen}>
                <header className="detail-header">
                  <button type="button" className="icon-button detail-back is-visible" aria-label="返回列表" data-tooltip="返回列表" onClick={()=>setDetailOpen(false)}><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18 9 12l6-6"/></svg></button>
                  <h2 style={{margin:0,fontSize:13,fontWeight:700}}>详情</h2>
                  <span className="type-badge">{selectedEntry ? (selectedEntry.type==="image"?"图片":"文本") : "—"}</span>
                </header>
                {selectedEntry ? (
                  <>
                    <div className="detail-actions">
                      <button type="button" className="soft-button" style={{flex:1}} onClick={()=>handleCopy(selectedEntry.id)}><IconCopy/> 复制</button>
                      <button type="button" className="tool-button" onClick={()=>handlePin(selectedEntry.id)}><IconPin filled={selectedEntry.pinned}/> {selectedEntry.pinned?"取消置顶":"置顶"}</button>
                      <button type="button" className="tool-button" onClick={()=>handleRemove(selectedEntry.id)}><IconTrash/> 删除</button>
                    </div>
                    <div className="detail-scroll">
                      {selectedEntry.type==="text" ? (<div className="preview-surface"><div className="text-preview">{selectedEntry.text || "（空内容）"}</div></div>) : (<div className="preview-surface" style={{borderRadius:10,overflow:"hidden",border:"1px solid var(--line)",background:"rgba(255,255,255,0.72)"}}><img src={selectedEntry.dataUrl} alt="剪贴板图片" style={{width:"100%",display:"block"}} draggable={false}/></div>)}
                      {selectedEntry.sourceApp && (<div className="file-detail source-block"><div className="source-label">来源</div><div className="source-row">{selectedEntry.sourceApp.iconDataUrl ? <img src={selectedEntry.sourceApp.iconDataUrl} alt="" className="source-icon-img" draggable={false}/> : <span className="item-icon source-icon source-icon--sm"><IconClipboard/></span>}<div className="source-meta"><div className="source-appname">{selectedEntry.sourceApp.appName}</div><div className="source-subtitle">{selectedEntry.sourceApp.windowTitle || selectedEntry.sourceApp.exePath}</div></div></div></div>)}
                      <div className="note-section"><div className="note-label">备注</div>{noteEdit?.id===selectedEntry.id ? (<input ref={detailNoteRef as any} className="note-input note-input--detail" value={noteEdit.draft} maxLength={MAX_NOTE_LENGTH} placeholder="添加备注，回车保存 · Esc 取消" spellCheck={false} onChange={(e)=>{const next={...noteEdit,draft:e.target.value};noteEditRef.current=next;setNoteEdit(next);}} onKeyDown={(e)=>{if(e.key==="Escape"){e.preventDefault();finishNoteEditing(true);} else if(e.key==="Enter" && !e.nativeEvent.isComposing){e.preventDefault(); finishNoteEditing(false);}}} onBlur={()=>{ if(!cancelNoteBlurRef.current) finishNoteEditing(false); }} aria-label="备注输入框" autoFocus />) : (<div onClick={()=>handleBeginNoteEdit(selectedIndex,selectedEntry.id)} className={`note-card ${selectedEntry.note ? "has-note" : ""}`}>{selectedEntry.note || "点击添加备注…"}</div>)}
                      </div>
                      <div className="detail-meta">{formatTime(selectedEntry.createdAt)} · {new Date(selectedEntry.createdAt).toLocaleString("zh-CN")}</div>
                    </div>
                  </>
                ) : (<div className="detail-empty"><div className="empty-icon">◎</div><div className="empty-text">未选择条目</div></div>)}
              </aside>
            </div>
          </section>
        </div>
        <footer className="shortcut-bar" aria-label="快捷键提示">
          {focusError ? (<span className="footer-error" role="status">{focusError.message}</span>) : noteEdit ? (<span>回车 保存 · Esc 取消 · {noteEdit ? `${noteEdit.draft.length}/{MAX_NOTE_LENGTH}` : "0/{MAX_NOTE_LENGTH}"}</span>) : searchActive ? (<><span className="shortcut"><kbd>ESC</kbd><span>退出搜索</span></span><span className="shortcut"><kbd>↑↓</kbd><span>选择</span></span><span className="shortcut"><kbd>回车</kbd><span>复制</span></span></>) : (<><span className="shortcut"><kbd>Z</kbd><span>置顶</span></span><span className="shortcut"><kbd>DEL</kbd><span>删除</span></span><span className="shortcut"><kbd>回车</kbd><span>复制</span></span><span className="shortcut"><kbd>B</kbd><span>备注</span></span><span className="shortcut"><kbd>ESC</kbd><span>隐藏界面</span></span><span className="shortcut"><kbd>空格</kbd><span>搜索</span></span></>)}
        </footer>
      </div>

      <div className={`toast ${toast?"is-visible":""}`} role="status" aria-live="polite" aria-atomic="true"><span>{toast?.text}</span>{toast?.actionLabel && toast.onAction && (<button type="button" className="toast-action" onClick={()=>{toast.onAction?.();setToast(null); if(toastTimerRef.current) window.clearTimeout(toastTimerRef.current);}}>{toast.actionLabel}</button>)}</div>
      {shortcutCapture && (<div className="shortcut-overlay" role="dialog" aria-modal="true" aria-label="更换快捷键"><div className="shortcut-card"><h2 className="shortcut-title">更换快捷键</h2><p className="shortcut-current">当前：<span className="kbd">{shortcutCapture.current}</span></p><p className="shortcut-hint">请按下新的快捷键组合，例如 <span className="kbd">Ctrl</span> + <span className="kbd">Shift</span> + <span className="kbd">V</span></p>{shortcutCapture.status && <p className={`shortcut-status ${shortcutCapture.status.ok?"ok":"err"}`}>{shortcutCapture.status.text}</p>}<button type="button" className="tool-button shortcut-cancel" onClick={()=>{void window.clipboardAPI.cancelShortcut(); setShortcutCapture(null);}}>取消（Esc）</button></div></div>)}
    </div>
  );
}

export default App;
