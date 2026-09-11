import { test, expect } from '@playwright/test';
import { installPanelHarness, makeEntries } from './panel-harness.js';
import { decodePNG } from '../scripts/gen-tray-icons.mjs';

// 备注内联输入框的两条契约。
// 契约 A（2026-09-11 用户报「按下 B 复制项大小会改变」）：输入框与 meta 行等高，
//   进入/退出编辑态不改卡片与列表几何。修前 22px 的输入框把 15.2px 的 meta 行撑到 22px，
//   卡片 89.5 → 96.28、下方每条各跳 6.8px；现在两边都是 16px（meta 显式 line-height、
//   输入框 height 与之一致），判定就是「按 B 前后几何逐条相等」。
// 契约 B（用户报「蓝色边框超出界面」）。两条现场事实：
//   1) 全局 :focus-visible 的 2px --accent outline 叠在 .note-input 自带的
//      1px --border-selected + 3px --ring-soft 环上——一个输入框两圈蓝环；
//   2) .card__meta 的单行裁切（overflow:hidden）把环的上、下两边拦腰切掉，
//      只剩左右两截「括号」伸出输入框——就是用户看到的「边框超出界面」。
// 口径与搜索井一致：环只有一圈（井的注释：the focus ring lives here, the bare
// input suppresses its own outline），且环必须完整画在卡片内——被裁成两截即回归。
// 判定留在浏览器里（ADR-0008：执行者是浏览器，getBoundingClientRect 给不出「有没有被裁」）。

const ITEMS = 8;
const RING_SPREAD = 3;   // .note-input 的 box-shadow 扩散
const DPR = 2;

test.use({ viewport: { width: 418, height: 823 }, colorScheme: 'dark', deviceScaleFactor: DPR });

// 环色 --ring-soft = rgba(123,119,224,.12)：蓝通道抬升明显，用 b−r 差当「有环」判据。
function blueness(png, x, y) {
  const i = (Math.round(y) * png.width + Math.round(x)) * 4;
  return png.data[i + 2] - png.data[i];
}

async function openNoteEditor(page) {
  await installPanelHarness(page, makeEntries(ITEMS));
  await page.goto('/');
  await page.waitForFunction((c) => document.querySelectorAll('.card').length === c, ITEMS);
  await page.evaluate(() => window.__emitPanelKey('note-edit-enter'));
  await page.waitForSelector('.note-input');
  await page.waitForTimeout(150);
}

test('备注框只有一圈焦点环（全局 outline 让位）', async ({ page }) => {
  await openNoteEditor(page);
  const style = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.note-input'));
    return { outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow, focusedClass: document.activeElement?.className };
  });
  expect(style.focusedClass).toBe('note-input');      // 前提：环是焦点态的环
  expect(style.outlineStyle).toBe('none');            // 第二圈 outline 必须抑制
  expect(style.boxShadow).toContain('3px');           // 保留的那一圈还在
});

// 卡片几何快照：高度/顶边/列表滚动高度。编辑态一进来就把行撑高的话，这三样全变。
const cardGeometry = (page) =>
  page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card')];
    return {
      heights: cards.map((card) => +card.getBoundingClientRect().height.toFixed(2)),
      tops: cards.map((card) => +card.getBoundingClientRect().top.toFixed(2)),
      scrollHeight: document.querySelector('.cards').scrollHeight,
    };
  });

test('按下 B 进备注编辑不改卡片几何（输入框与 meta 行等高）', async ({ page }) => {
  await installPanelHarness(page, makeEntries(ITEMS));
  await page.goto('/');
  await page.waitForFunction((count) => document.querySelectorAll('.card').length === count, ITEMS);
  await page.evaluate(() => window.__emitPanelKey('down'));
  await page.waitForTimeout(100);
  const before = await cardGeometry(page);

  await page.evaluate(() => window.__emitPanelKey('note-edit-enter'));
  await page.waitForSelector('.note-input');
  await page.waitForTimeout(150);
  const after = await cardGeometry(page);
  console.log('[note-size] before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
  expect(after).toEqual(before);

  // 输入框本身也不该高过它所替代的那行文本
  const sizes = await page.evaluate(() => ({
    input: document.querySelector('.note-input').getBoundingClientRect().height,
    meta: document.querySelector('.note-input').closest('.card__meta').getBoundingClientRect().height,
  }));
  expect(sizes.input).toBeCloseTo(sizes.meta, 1);
});

test('焦点环完整落在卡片内，上下不被 meta 行裁成两截', async ({ page }) => {
  await openNoteEditor(page);
  const geo = await page.evaluate((spread) => {
    const r = (el) => el.getBoundingClientRect();
    const input = document.querySelector('.note-input');
    const meta = input.closest('.card__meta');
    const card = input.closest('.card');
    const ir = r(input), cr = r(card);
    return {
      // 环的外沿（box-shadow 不占布局，矩形 = border box 外扩 spread）
      ring: { left: ir.left - spread, right: ir.right + spread, top: ir.top - spread, bottom: ir.bottom + spread },
      meta: { top: r(meta).top, bottom: r(meta).bottom },
      card: { left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom },
      sampleX: (ir.left + ir.right) / 2,
    };
  }, RING_SPREAD);

  // ① 环的外沿不出卡片边框（「超出界面」的字面口径）
  expect(geo.ring.left).toBeGreaterThanOrEqual(geo.card.left);
  expect(geo.ring.right).toBeLessThanOrEqual(geo.card.right);
  expect(geo.ring.top).toBeGreaterThanOrEqual(geo.card.top);
  expect(geo.ring.bottom).toBeLessThanOrEqual(geo.card.bottom);

  // ② 环在 meta 行的上/下边界之外仍有像素——被裁时那里只剩卡片底色
  const png = decodePNG(Buffer.from(await page.screenshot({ omitBackground: true })));
  const at = (cssX, cssY) => blueness(png, cssX * DPR, cssY * DPR);
  const above = at(geo.sampleX, geo.meta.top - RING_SPREAD / 2);
  const below = at(geo.sampleX, geo.meta.bottom + RING_SPREAD / 2);
  const control = at(geo.card.left + 6, geo.meta.top - RING_SPREAD / 2); // 同高度的卡片留白，无环
  console.log('[note-ring] above=' + above + ' below=' + below + ' control=' + control);
  expect(above).toBeGreaterThan(control + 4);
  expect(below).toBeGreaterThan(control + 4);
});
