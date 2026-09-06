import { test, expect } from '@playwright/test';
import { FADE_INSET, installPanelHarness, makeEntries } from './panel-harness.js';

test.beforeEach(async ({ page }) => {
  await installPanelHarness(page, makeEntries(60));
});

test('长按上下方向键期间选中框与快速移动保持同步', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 60);
  await page.waitForFunction(() => window.__panelKeyReady === true);

  // page.evaluate 在浏览器里执行，Node 侧的常量要靠参数传进去。
  const result = await page.evaluate(async (fadeInset) => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const list = document.querySelector('.cards');
    list.scrollTo({ top: 0, behavior: 'auto' });

    const sample = () => {
      const selected = document.querySelector('.card.is-selected');
      const listRect = list.getBoundingClientRect();
      const selectedRect = selected?.getBoundingClientRect();
      // HUD 的选中态过渡的是背景/描边颜色（transition: background 实际驱动 background-color，
      // 100ms token 动效），不影响「选中框与滚动同步」；会甩开同步的只有几何类动画，只数它们。
      const runningAnimations = [...document.querySelectorAll('.card')]
        .reduce((count, item) => count + item.getAnimations().filter((animation) => animation.playState === 'running' && (animation.transitionProperty === 'transform' || animation.transitionProperty === 'opacity')).length, 0);
      // HUD 口径：顶部要留在 scroll-padding（fadeInset）之内——贴顶等于撞窗口圆角带；
      // 底部对齐滚动口下缘（页脚分隔线）是 nearest 的设计内结果，只按「不裁过半个像素」判。
      const visible = selectedRect
        ? selectedRect.top >= listRect.top + fadeInset - 1
          && selectedRect.bottom <= listRect.bottom + 0.5
        : false;
      return {
        index: [...document.querySelectorAll('.card')].indexOf(selected),
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