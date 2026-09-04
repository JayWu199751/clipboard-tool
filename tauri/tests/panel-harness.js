// 面板渲染层的测试替身：伪造 Tauri IPC，喂给 App 一份历史与一条 panel:key 事件通道。
// 三条浏览器用例共用，避免各自复制一份假 API 而漂移。

// styles.css 里 .history-list 的滚动边缘渐隐遮罩宽度。
// 首尾卡片与滚动口边缘的空隙必须大于它，否则卡片顶部会被淡出成一道阴影。
export const FADE_INSET = 10;

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

export async function installPanelHarness(page, entries) {
  await page.addInitScript((history) => {
    const callbacks = new Map();
    const listeners = new Map();
    let nextId = 1;

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
      for (const id of [...(listeners.get('panel:key') ?? [])]) {
        callbacks.get(id)?.({ payload: { action, noteEntryId: null } });
      }
    };
  }, entries);
}
