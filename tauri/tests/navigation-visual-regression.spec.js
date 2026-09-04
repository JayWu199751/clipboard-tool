import { test, expect } from '@playwright/test';
import { FADE_INSET, installPanelHarness, makeEntries } from './panel-harness.js';

test.beforeEach(async ({ page }) => {
  await installPanelHarness(page, makeEntries(60));
});

test('长按上下方向键期间选中框与快速移动保持同步', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 60);
  await page.waitForFunction(() => window.__panelKeyReady === true);

  // page.evaluate 在浏览器里执行，Node 侧的常量要靠参数传进去。
  const result = await page.evaluate(async (fadeInset) => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const list = document.querySelector('.history-list');
    list.scrollTo({ top: 0, behavior: 'auto' });

    const sample = () => {
      const selected = document.querySelector('.history-item.is-selected');
      const listRect = list.getBoundingClientRect();
      const selectedRect = selected?.getBoundingClientRect();
      const runningAnimations = [...document.querySelectorAll('.history-item')]
        .reduce((count, item) => count + item.getAnimations().filter((animation) => animation.playState === 'running').length, 0);
      // 可视区要再让开上下各 fadeInset：贴到滚动口边缘等于被渐隐遮罩盖住，
      // 按原始盒子判定会把这种「贴边」误判成可见。
      const visible = selectedRect
        ? selectedRect.top >= listRect.top + fadeInset - 1
          && selectedRect.bottom <= listRect.bottom - fadeInset + 1
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
  }, FADE_INSET);

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
