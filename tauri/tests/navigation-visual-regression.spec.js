import { test, expect } from '@playwright/test';

const entries = Array.from({ length: 60 }, (_, index) => ({
  id: `entry-${index}`,
  type: 'text',
  text: `entry ${index}`,
  createdAt: index,
  sourceApp: null,
  pinned: false,
  pinnedAt: 0,
  note: '',
}));

test.beforeEach(async ({ page }) => {
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
    window.__emitPanelKey = (action) => {
      for (const id of [...(listeners.get('panel:key') ?? [])]) {
        callbacks.get(id)?.({ payload: { action, noteEntryId: null } });
      }
    };
  }, entries);
});

test('长按上下方向键期间选中框与快速移动保持同步', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 60);
  await page.waitForFunction(() => window.__panelKeyReady === true);

  const result = await page.evaluate(async () => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const list = document.querySelector('.history-list');
    list.scrollTo({ top: 0, behavior: 'auto' });

    const sample = () => {
      const selected = document.querySelector('.history-item.is-selected');
      const listRect = list.getBoundingClientRect();
      const selectedRect = selected?.getBoundingClientRect();
      const runningAnimations = [...document.querySelectorAll('.history-item')]
        .reduce((count, item) => count + item.getAnimations().filter((animation) => animation.playState === 'running').length, 0);
      const visible = selectedRect
        ? selectedRect.top >= listRect.top - 1 && selectedRect.bottom <= listRect.bottom + 1
        : false;
      return {
        index: [...document.querySelectorAll('.history-item')].indexOf(selected),
        visible,
        selectedTop: selectedRect?.top,
        selectedBottom: selectedRect?.bottom,
        listTop: listRect.top,
        listBottom: listRect.bottom,
        scrollBehavior: getComputedStyle(list).scrollBehavior,
        runningAnimations,
      };
    };
    const move = async (action) => {
      const samples = [];
      for (let index = 0; index < 18; index += 1) {
        window.__emitPanelKey(action);
        await wait(50);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        samples.push(sample());
      }
      return { samples, final: sample() };
    };

    return { down: await move('down'), up: await move('up') };
  });

  for (const direction of ['down', 'up']) {
    const samples = result[direction].samples;
    expect(samples).toHaveLength(18);
    samples.forEach((sample, index) => {
      expect(sample.index).toBe(direction === 'down' ? index + 1 : 17 - index);
      expect(sample.visible).toBe(true);
      expect(sample.scrollBehavior).toBe('auto');
      expect(sample.runningAnimations).toBe(0);
    });
    expect(result[direction].final.index).toBe(direction === 'down' ? 18 : 0);
    expect(result[direction].final.visible).toBe(true);
    expect(result[direction].final.runningAnimations).toBe(0);
  }
});
