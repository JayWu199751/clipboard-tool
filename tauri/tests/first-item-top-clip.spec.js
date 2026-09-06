import { test, expect } from '@playwright/test';
import { FADE_INSET, installPanelHarness, makeEntries } from './panel-harness.js';

// 呼出面板后按下键把列表滚走，再按上键回到第一项：首项必须回到呼出时的位置，
// 不能贴进窗口顶部的圆角带（scroll-padding-top 与列表内边距同源）。
// 复现路径：scrollIntoView({block:'nearest'}) 会把容器顶部预留的留白当成多余空间滚掉。
// HUD 迁移注：滚动边缘的渐隐遮罩已随旧设计退役，底部口径从「不被淡出」放宽为「不被裁掉」。

const ITEMS = 20;
const press = async (page, action, times) => {
  await page.evaluate(async ([name, count]) => {
    const settle = () => new Promise((resolve) => requestAnimationFrame(resolve));
    for (let index = 0; index < count; index += 1) {
      window.__emitPanelKey(name);
      await new Promise((resolve) => setTimeout(resolve, 8));
      await settle();
    }
  }, [action, times]);
};

const geometry = (page) =>
  page.evaluate(() => {
    const list = document.querySelector('.cards');
    const selected = document.querySelector('.card.is-selected');
    const items = [...document.querySelectorAll('.card')];
    const listRect = list.getBoundingClientRect();
    const rect = selected.getBoundingClientRect();
    return {
      index: items.indexOf(selected),
      scrollTop: list.scrollTop,
      // 选中项顶边距列表顶边的空隙
      topGap: rect.top - listRect.top,
      // 选中项底边距列表底边的空隙
      bottomGap: listRect.bottom - rect.bottom,
    };
  });

test.beforeEach(async ({ page }) => {
  await installPanelHarness(page, makeEntries(ITEMS));
  await page.goto('/');
  await page.waitForFunction(
    (count) => document.querySelectorAll('.card').length === count,
    ITEMS,
  );
  await page.waitForFunction(() => window.__panelKeyReady === true);
});

test('回到第一项时首项回到scroll-padding留白内', async ({ page }) => {
  const fresh = await geometry(page);
  expect(fresh.scrollTop).toBe(0);
  expect(fresh.topGap).toBeGreaterThanOrEqual(FADE_INSET);

  await press(page, 'down', 8);
  const scrolled = await geometry(page);
  expect(scrolled.scrollTop).toBeGreaterThan(0);

  await press(page, 'up', 8);
  const backToFirst = await geometry(page);
  expect(backToFirst.index).toBe(0);
  expect(backToFirst.scrollTop).toBe(fresh.scrollTop);
  expect(backToFirst.topGap).toBeCloseTo(fresh.topGap, 0.5);

  // 已在首项继续按上键：停住不动，但位置必须仍是干净的
  await press(page, 'up', 3);
  const extraUp = await geometry(page);
  expect(extraUp.scrollTop).toBe(fresh.scrollTop);
  expect(extraUp.topGap).toBeGreaterThanOrEqual(FADE_INSET);
});

test('到最后一项时末项不被滚动口下缘裁掉', async ({ page }) => {
  await press(page, 'down', ITEMS * 2);
  const last = await geometry(page);
  expect(last.index).toBe(ITEMS - 1);
  // HUD 列表的下缘是页脚分隔线（不是窗口圆角带），nearest 把末项底边对齐到滚动口
  // 下缘是设计内行为；Chromium 把 scrollTop 取整到整数设备像素，分数行高下允许
  // 半像素的过冲，所以口径是「不被裁掉」：bottomGap ≥ -0.5。
  expect(last.bottomGap).toBeGreaterThanOrEqual(-0.5);
});