// 面板渲染层的测试替身：伪造 Tauri IPC，喂给 App 一份历史与一条 panel:key 事件通道。
// 浏览器用例共用，避免各自复制一份假 API 而漂移。

// styles.css 里 .cards 的列表内边距与 scroll-padding-top（var(--space-3) = 12px）。
// HUD 迁移后滚动边缘不再有渐隐遮罩；首尾选中项与滚动口边缘的空隙仍须不小于它，
// 否则「贴边」就等于被裁在窗口圆角带里。
export const FADE_INSET = 12;

export function makeEntries(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`,
    type: 'text',
    text: `entry ${index}`,
    createdAt: index,
    sourceApp: null,
    pinned: false,
    pinnedAt: 0,
    note: '',
  }));
}

export async function installPanelHarness(page, entries, theme = 'system') {
  await page.addInitScript(({ history, initialTheme }) => {
    const callbacks = new Map();
    const listeners = new Map();
    let nextId = 1;
    let themePreference = initialTheme;
    window.__themeWrites = [];
    window.__searchActivations = 0;
    const emit = (event, payload) => {
      for (const id of [...(listeners.get(event) ?? [])]) {
        callbacks.get(id)?.({ payload });
      }
    };
    window.__setThemePreference = (theme) => {
      themePreference = theme;
      emit('theme:changed', theme);
    };

    const removeListener = (event, id) => {
      const registered = listeners.get(event) ?? [];
      const index = registered.indexOf(id);
      if (index >= 0) registered.splice(index, 1);
    };

    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(event, id) {
        removeListener(event, id);
      },
    };
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      invoke(command, args) {
        if (command === 'clipboard_get') return Promise.resolve(history);
        if (command === 'theme_get') return Promise.resolve(themePreference);
        if (command === 'theme_set') {
          if (window.__rejectThemeSet) return Promise.reject(new Error('主题切换失败'));
          window.__themeWrites.push(args.theme);
          window.__setThemePreference(args.theme);
          return Promise.resolve();
        }
        if (command === 'search_activate') {
          ++window.__searchActivations;
          emit('panel:key', { action: 'search-enter', noteEntryId: null });
          return Promise.resolve(true);
        }
        if (command === 'plugin:event|listen') {
          const registered = listeners.get(args.event) ?? [];
          registered.push(args.handler);
          listeners.set(args.event, registered);
          if (args.event === 'panel:key') window.__panelKeyReady = true;
          return Promise.resolve(args.handler);
        }
        if (command === 'plugin:event|unlisten') {
          removeListener(args.event, args.eventId);
          callbacks.delete(args.eventId);
          return Promise.resolve();
        }
        return Promise.resolve(true);
      },
    };
    // 主进程在面板显示期间全局拦截 ↑/↓，这里直接回放它推给渲染层的事件。
    window.__emitPanelKey = (action) => {
      emit('panel:key', { action, noteEntryId: null });
    };
  }, { history: entries, initialTheme: theme });
}
