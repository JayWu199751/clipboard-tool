// ClipFlow HUD 视图状态机（迁移自 clipboard-app/js/app.js，逐条对照；
// 键位全部落在原应用现有绑定上——导航键由 Rust 主进程拦截后经 panel:key 转发，
// 本文件只做效果接线：读事件 → 调 clipStore/panelView 判定 → 画出来或 invoke）。
//
// 与源 app.js 的已确认差异（迁移方案）：
//   - 点击卡片 = 仅选中，复制走 Enter / 双击（用户拍板「按原应用」；右上角的复制胶囊 2026-09-11 已删）；
//   - 复制 = 原应用粘贴链（clipboard_copy：写剪贴板 + 归还焦点 + 粘贴 + 收面板）；
//   - 删除 = 渲染层延迟删除：先隐藏 + 6s 撤销 toast，到点才 clipboard_remove；
//   - Home/End、Ctrl+F、Backspace 原应用无对应键 → 不加键（提示词第 4 条），只留鼠标路径；
//   - 置顶（Z）是原应用既有键，ClipFlow 无此概念 → 保留行为，meta 行加图标态。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEntry, PanelKeyAction } from './types';
import { clampIndex, entryAt, formatTime, moveIndex, scrollbarThumb, shouldIgnoreMouse, accelKeyFromCode, MIN_THUMB_HEIGHT, type ScrollbarThumb } from './panelView';
import { createClipStore, type ClipItem } from './clipStore';
import { useKeyboard } from './useKeyboard';
import { NAV_KEYS, chipLabel, footerChips } from './keyboard';
import { Icon, IconSprite } from './icons';
import { SearchHeader } from './SearchHeader';
import { ClipCard } from './ClipCard';
import { ToastStack, type ToastSpec } from './ToastStack';

const MAX_NOTE_LENGTH = 200;
const DELETE_UNDO_MS = 6000;
const COPY_FLASH_MS = 520;
const SEARCH_DEBOUNCE_MS = 120;
const darkModeMedia = window.matchMedia('(prefers-color-scheme: dark)');

// 生效皮肤只由媒体查询决定：主进程改的是网页的 prefers-color-scheme（托盘「主题」子菜单，
// 见 ADR-0012），渲染层自己不存偏好。定色这一处只此一份，呼出时的保险也复用它。
function applyTheme() {
  document.documentElement.dataset.theme = darkModeMedia.matches ? 'dark' : 'light';
}

interface FocusError { stage: string; reason: string; message: string }

let toastSeq = 1;

function App() {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  // 延迟删除的可见性遮罩：条目仍在主进程 store 里，到点才真删（见文件头）
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const deleteTimersRef = useRef(new Map<string, number>());

  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [noteEdit, setNoteEdit] = useState<{ id: string; draft: string } | null>(null);
  const noteEditRef = useRef(noteEdit);
  noteEditRef.current = noteEdit;
  const noteSavePendingRef = useRef(false);
  const cancelNoteBlurRef = useRef(false);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  // 自绘滚动条（原生条在真机占布局宽度、破坏卡片左右对称，见 styles.css）
  const listRef = useRef<HTMLUListElement>(null);
  const [scrollState, setScrollState] = useState<ScrollbarThumb>({ visible: false, top: 0, height: MIN_THUMB_HEIGHT });
  const [toasts, setToasts] = useState<ToastSpec[]>([]);
  const toastActionsRef = useRef(new Map<number, () => void>());
  const [focusError, setFocusError] = useState<FocusError | null>(null);

  const [shortcutCapture, setShortcutCapture] = useState<{ current: string; status: { text: string; ok: boolean } | null } | null>(null);
  const shortcutCaptureRef = useRef(shortcutCapture);
  shortcutCaptureRef.current = shortcutCapture;

  // —— ClipStore 契约视图（组件只认 ClipItem，不碰 invoke） ——
  const store = useMemo(() => createClipStore(entries, hiddenIds), [entries, hiddenIds]);
  const items = useMemo(() => store.query({ search: debouncedQuery }), [store, debouncedQuery]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const total = store.total();

  // —— toast ——
  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 160);
  }, []);
  const pushToast = useCallback((msg: string, opts: { dim?: string; kind?: 'success' | 'error'; actionLabel?: string; onAction?: () => void } = {}) => {
    const id = toastSeq++;
    const spec: ToastSpec = { id, msg, dim: opts.dim, kind: opts.kind ?? 'success', actionLabel: opts.actionLabel };
    setToasts((list) => [...list, spec]);
    if (opts.onAction) toastActionsRef.current.set(id, opts.onAction);
    const life = opts.actionLabel ? DELETE_UNDO_MS : 2600;
    window.setTimeout(() => {
      toastActionsRef.current.delete(id);
      dismissToast(id); // 已被动作点击收掉时是无操作
    }, life);
    return id;
  }, [dismissToast]);
  const handleToastAction = useCallback((id: number) => {
    toastActionsRef.current.get(id)?.();
    toastActionsRef.current.delete(id);
    dismissToast(id);
  }, [dismissToast]);

  // —— 复制（原应用粘贴链契约 { ok, message }） ——
  const copyItem = useCallback((item: ClipItem) => {
    setCopiedId(item.id);
    window.setTimeout(() => setCopiedId((cur) => (cur === item.id ? null : cur)), COPY_FLASH_MS);
    void window.clipboardAPI.copy(item.id).then((result) => {
      if (result?.ok) pushToast('已复制并粘贴', { dim: item.source + ' · ' + formatTime(item.ts, Date.now()) });
      else if (result?.message) pushToast(result.message, { kind: 'error' });
      else pushToast('复制失败', { kind: 'error' });
    });
  }, [pushToast]);

  // —— 删除（延迟删除 + 撤销） ——
  const unhide = useCallback((id: string) => {
    setHiddenIds((set) => {
      if (!set.has(id)) return set;
      const next = new Set(set);
      next.delete(id);
      return next;
    });
  }, []);
  const deleteItem = useCallback((item: ClipItem) => {
    const id = item.id;
    if (noteEditRef.current?.id === id) {
      noteEditRef.current = null;
      setNoteEdit(null);
      void window.clipboardAPI.endNoteEdit();
    }
    setHiddenIds((set) => (set.has(id) ? set : new Set(set).add(id)));
    pushToast('已删除', {
      dim: item.type === 'image' ? item.content : item.content.replace(/\s+/g, ' ').slice(0, 18),
      kind: 'error',
      actionLabel: '撤销',
      onAction: () => {
        const timer = deleteTimersRef.current.get(id);
        if (timer) window.clearTimeout(timer);
        deleteTimersRef.current.delete(id);
        unhide(id);
      },
    });
    deleteTimersRef.current.set(id, window.setTimeout(() => {
      deleteTimersRef.current.delete(id);
      void window.clipboardAPI.remove(id).then((ok) => {
        // 删除失败（条目已不在等）→ 撤销隐藏，条目回到列表，不留幽灵
        if (!ok) unhide(id);
      });
    }, DELETE_UNDO_MS));
  }, [pushToast, unhide]);

  // —— 备注编辑（B → note-edit-enter；Enter 保存 / Esc 取消 / 失焦保存） ——
  const openNoteEditor = useCallback((targetId: string | null) => {
    const list = itemsRef.current;
    const target = targetId
      ? list.find((item) => item.id === targetId)
      : entryAt(list, clampIndex(selectedRef.current, list.length));
    if (!target) return;
    const next = { id: target.id, draft: target.note };
    noteEditRef.current = next;
    setNoteEdit(next);
    requestAnimationFrame(() => {
      const el = searchInputRef.current?.closest('.app-window')?.querySelector<HTMLInputElement>('.note-input');
      el?.focus();
      if (el && el.value) el.select();
    });
  }, []);

  const finishNoteEditing = useCallback((cancel: boolean) => {
    const edit = noteEditRef.current;
    if (!edit || noteSavePendingRef.current) return;
    noteEditRef.current = null;
    setNoteEdit(null);
    if (cancel) {
      cancelNoteBlurRef.current = true;
      window.setTimeout(() => { cancelNoteBlurRef.current = false; }, 0);
      void window.clipboardAPI.endNoteEdit();
      return;
    }
    const prev = store.getNote(edit.id);
    const text = edit.draft.trim();
    noteSavePendingRef.current = true;
    const done = () => {
      noteSavePendingRef.current = false;
      void window.clipboardAPI.endNoteEdit();
    };
    if (text === prev) { done(); return; }
    void window.clipboardAPI.setNote(edit.id, text).then(() => {
      if (text) pushToast('备注已保存', { dim: text.slice(0, 18) });
      else pushToast('备注已移除');
    }).finally(done);
  }, [store, pushToast]);

  const handleNoteEditExit = useCallback(() => {
    const edit = noteEditRef.current;
    if (edit && !noteSavePendingRef.current) {
      noteEditRef.current = null;
      setNoteEdit(null);
      const prev = store.getNote(edit.id);
      const text = edit.draft.trim();
      if (text !== prev) void window.clipboardAPI.setNote(edit.id, text);
    } else {
      noteEditRef.current = null;
      setNoteEdit(null);
    }
    cancelNoteBlurRef.current = false;
  }, [store]);

  // —— 注册表分发（useKeyboard：panel:key → 动作 → 处理函数） ——
  const navMove = useCallback((direction: 'up' | 'down') => {
    setSelected((index) => moveIndex(index, itemsRef.current.length, direction));
  }, []);
  useKeyboard(useMemo<Partial<Record<PanelKeyAction, (noteEntryId: string | null) => void>>>(() => ({
    up: () => navMove('up'),
    down: () => navMove('down'),
    enter: () => { const item = entryAt(itemsRef.current, clampIndex(selectedRef.current, itemsRef.current.length)); if (item) copyItem(item); },
    delete: () => { const item = entryAt(itemsRef.current, clampIndex(selectedRef.current, itemsRef.current.length)); if (item) deleteItem(item); },
    pin: () => { const item = entryAt(itemsRef.current, clampIndex(selectedRef.current, itemsRef.current.length)); if (item) void window.clipboardAPI.pin(item.id); },
    escape: () => { if (!shortcutCaptureRef.current) void window.clipboardAPI.hide(); },
    'search-enter': () => {
      setSearchActive(true);
      setQuery('');
      setDebouncedQuery('');
      requestAnimationFrame(() => searchInputRef.current?.focus());
    },
    'search-exit': () => {
      setSearchActive(false);
      setQuery('');
      setDebouncedQuery('');
      searchInputRef.current?.blur();
    },
    'note-edit-enter': (noteEntryId) => openNoteEditor(noteEntryId ?? null),
    'note-edit-exit': () => handleNoteEditExit(),
  }), [navMove, copyItem, deleteItem, openNoteEditor, handleNoteEditExit]));

  // —— 数据源与事件接线 ——
  useEffect(() => {
    void window.clipboardAPI.getHistory().then(setEntries);
    window.clipboardAPI.onUpdated(setEntries);
    window.clipboardAPI.onFocusError(setFocusError);
    // 每次呼出重置选中/搜索/备注态；延迟删除的计时器跨隐藏继续（撤销窗口是秒表语义）
    window.clipboardAPI.onPanelShown(() => {
      setSelected(0);
      setSearchActive(false);
      setQuery('');
      setDebouncedQuery('');
      setFocusError(null);
      noteEditRef.current = null;
      setNoteEdit(null);
      noteSavePendingRef.current = false;
      cancelNoteBlurRef.current = false;
      searchInputRef.current?.blur();
      // 保险：主进程改网页配色走的是 WebView2 的 SetPreferredColorScheme，万一那一下没触发
      // change 事件，呼出时按媒体查询重刷一次（面板显示前是离屏的，这里不闪给用户看）
      applyTheme();
    });
    window.clipboardAPI.onShortcutCaptureStart((info) => setShortcutCapture({ current: info.current, status: null }));
    window.clipboardAPI.onShortcutCaptureEnd(() => setShortcutCapture(null));
    return () => {
      for (const timer of deleteTimersRef.current.values()) window.clearTimeout(timer);
      deleteTimersRef.current.clear();
    };
  }, []);

  // —— 搜索防抖（源 app.js 120ms） ——
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // —— 主题：跟着网页的 prefers-color-scheme 走（head 内联脚本已防 FOUC，这里做运行期同步）。
  // 这个媒体查询默认就是系统色，但也可被主进程的托盘「主题」子菜单覆盖成手动亮/暗 ——
  // 覆盖发生在 WebView2 的 profile 上，渲染层不需要知道有偏好这回事（ADR-0012）。
  useEffect(() => {
    const sync = () => applyTheme();
    sync();
    darkModeMedia.addEventListener('change', sync);
    return () => darkModeMedia.removeEventListener('change', sync);
  }, []);

  // —— 滚动条 thumb 跟随：接线与到点自动隐藏，几何判定在 panelView.scrollbarThumb ——
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let hideTimer: number | null = null;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight <= clientHeight) {
        setScrollState({ visible: false, top: 0, height: MIN_THUMB_HEIGHT });
        return;
      }
      setScrollState(scrollbarThumb(scrollTop, clientHeight, scrollHeight));
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setScrollState((s) => ({ ...s, visible: false })), 900);
    };
    el.addEventListener('scroll', update, { passive: true });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
      if (hideTimer) window.clearTimeout(hideTimer);
    };
  }, [items.length]);

  // —— 列表变化时选中项拉回有效范围；选中项滚进可视区 ——
  useEffect(() => { setSelected((index) => clampIndex(index, items.length)); }, [items.length]);
  useEffect(() => {
    document.querySelector('.cards')
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [selected, items]);

  // —— 更换快捷键捕获：渲染层临时 capture 监听（录入新键值的编辑器行为，非面板导航键） ——
  useEffect(() => {
    if (!shortcutCapture) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        void window.clipboardAPI.cancelShortcut();
        setShortcutCapture(null);
        return;
      }
      const mods: string[] = [];
      if (event.ctrlKey) mods.push('Control');
      if (event.altKey) mods.push('Alt');
      if (event.shiftKey) mods.push('Shift');
      if (event.metaKey) mods.push('Super');
      const mainKey = accelKeyFromCode(event.code);
      if (!mainKey) return;
      if (!mods.some((m) => m !== 'Shift')) {
        setShortcutCapture((s) => (s ? { ...s, status: { text: '请包含 Ctrl / Alt / Win 修饰键', ok: false } } : s));
        return;
      }
      const accel = [...mods, mainKey].join('+');
      void window.clipboardAPI.tryShortcut(accel).then((result) => {
        if (!result.ok) {
          setShortcutCapture((s) => (s ? { ...s, status: { text: result.formatted + ' 已被占用或无效，请换一个', ok: false } } : s));
          return;
        }
        setShortcutCapture((s) => (s ? { ...s, status: { text: '已设置为 ' + result.formatted, ok: true } } : s));
        window.setTimeout(() => setShortcutCapture(null), 1200);
      });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [shortcutCapture]);

  // —— 透明窗口圆角外鼠标穿透（原应用机制原样保留） ——
  useEffect(() => {
    const desktop = document.querySelector('.desktop') as HTMLElement | null;
    if (!desktop) return;
    let lastIgnore: boolean | null = null;
    let radius = 0;
    const readRadius = () => {
      const value = Number.parseFloat(getComputedStyle(desktop).borderTopLeftRadius);
      radius = Number.isFinite(value) ? value : 0;
    };
    const update = (event: MouseEvent) => {
      const shouldIgnore = shouldIgnoreMouse(event.clientX, event.clientY, desktop.getBoundingClientRect(), radius);
      if (shouldIgnore === lastIgnore) return;
      lastIgnore = shouldIgnore;
      void window.clipboardAPI.setIgnoreMouse(shouldIgnore, true);
    };
    const onLeave = () => {
      if (lastIgnore !== true) { lastIgnore = true; void window.clipboardAPI.setIgnoreMouse(true, true); }
    };
    readRadius();
    window.addEventListener('resize', readRadius);
    desktop.addEventListener('mousemove', update);
    desktop.addEventListener('mouseenter', update);
    desktop.addEventListener('mouseleave', onLeave);
    void window.clipboardAPI.setIgnoreMouse(false, true);
    return () => {
      window.removeEventListener('resize', readRadius);
      desktop.removeEventListener('mousemove', update);
      desktop.removeEventListener('mouseenter', update);
      desktop.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  const chips = footerChips();

  return (
    <div className="desktop">
      <IconSprite />
      <div className="app-window" lang="zh-CN" role="application" aria-label="剪贴板">
        <SearchHeader
          searchActive={searchActive}
          query={query}
          inputRef={searchInputRef}
          onQueryChange={setQuery}
          onActivate={() => void window.clipboardAPI.activateSearch()}
          onComposition={(active) => void window.clipboardAPI.setSearchComposing(active)}
        />
        <main className="cards-wrap">
          {items.length > 0 ? (
            <>
            <ul className="cards" ref={listRef} role="listbox" aria-label="剪贴板条目" tabIndex={0}>
              {items.map((item, index) => (
                <ClipCard
                  key={item.id}
                  item={item}
                  selected={index === selected}
                  copied={copiedId === item.id}
                  query={debouncedQuery}
                  noteDraft={noteEdit?.id === item.id ? noteEdit.draft : null}
                  onSelect={() => setSelected(index)}
                  onCopy={() => copyItem(item)}
                  onNoteDraft={(draft) => {
                    const edit = noteEditRef.current;
                    if (!edit) return;
                    const next = { ...edit, draft };
                    noteEditRef.current = next;
                    setNoteEdit(next);
                  }}
                  onNoteSave={() => { if (!cancelNoteBlurRef.current) finishNoteEditing(false); }}
                  onNoteCancel={() => finishNoteEditing(true)}
                />
              ))}
            </ul>
            <div className={'hud-scrollbar' + (scrollState.visible ? ' is-visible' : '')} aria-hidden="true">
              <span className="hud-scrollbar-thumb" style={{ height: scrollState.height, transform: `translateY(${scrollState.top}px)` }} />
            </div>
            </>
          ) : (
            <div className="empty-state" role="status">
              <div className="empty-state__icon"><Icon id={total === 0 ? 'i-layers' : 'i-search'} size={20} /></div>
              <p className="empty-state__title">{total === 0 ? '还没有剪切板内容' : '无匹配结果'}</p>
              <p className="empty-state__hint">{total === 0 ? '去复制一些文字或图片吧，它们会自动出现在这里' : '点击 ✕ 按钮可清除搜索。'}</p>
            </div>
          )}
        </main>
        <footer className="hud-footer" aria-label="快捷键提示">
          <span id="status-count">{total} 条</span>
          {focusError ? (
            <span className="footer-error" role="status">{focusError.message}</span>
          ) : noteEdit ? (
            <span className="hints" aria-hidden="true">
              <span><kbd className="kbd">{chipLabel(NAV_KEYS.enter)}</kbd>保存</span>
              <span><kbd className="kbd">{chipLabel(NAV_KEYS.escape)}</kbd>取消</span>
              <span>{noteEdit.draft.length}/{MAX_NOTE_LENGTH}</span>
            </span>
          ) : (
            <span className="hints" aria-hidden="true">
              {chips.map((chip) => (
                <span key={chip.label}>
                  <kbd className="kbd">{chip.chips.join('')}</kbd>
                  {chip.label}
                </span>
              ))}
            </span>
          )}
        </footer>

        {shortcutCapture && (
          <div className="shortcut-overlay" role="dialog" aria-modal="true" aria-label="更换快捷键">
            <div className="shortcut-card">
              <h2 className="shortcut-title">更换快捷键</h2>
              <p className="shortcut-current">当前：<span className="kbd">{shortcutCapture.current}</span></p>
              <p className="shortcut-hint">请按下新的快捷键组合，例如 Ctrl + Shift + V</p>
              {shortcutCapture.status && <p className={'shortcut-status ' + (shortcutCapture.status.ok ? 'ok' : 'err')}>{shortcutCapture.status.text}</p>}
              <button type="button" className="shortcut-cancel" onClick={() => { void window.clipboardAPI.cancelShortcut(); setShortcutCapture(null); }}>
                取消（{chipLabel(NAV_KEYS.escape)}）
              </button>
            </div>
          </div>
        )}
      </div>
      <ToastStack toasts={toasts} onAction={handleToastAction} />
    </div>
  );
}

export default App;
