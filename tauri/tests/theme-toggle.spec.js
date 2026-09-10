import { test, expect } from '@playwright/test';
import { installPanelHarness, makeEntries } from './panel-harness.js';

// 主题三态（亮 / 暗 / 跟随系统）与悬停提示框的浏览器回归。
// 判定本身（theme.ts：偏好 → 生效皮肤 / 后继态 / 文案 / 存档值）另有 9 例 node 单测，
// 这里只钉只有浏览器能给的答案：点下去真的换肤、提示框真的跟色、几何真的没越界（ADR-0008）。
// 提示框刻意自绘：原生 title 由系统绘制、不跟应用换肤（用户 2026-09-11 的硬要求），
// 所以它的底面与文字是本仓库的 CSS，两套主题各自实算一遍 WCAG 对比度，不靠「各看一眼」。

const ITEMS = 6;
const KEY = 'clipflow.theme';
const VIEWPORT = { width: 418, height: 823 };
// 出现延迟 90ms + 淡入 100ms（--dur-fast）；等足再量，别抢过渡的中间帧
const TIP_SETTLE_MS = 260;

test.use({ viewport: VIEWPORT, colorScheme: 'dark', deviceScaleFactor: 2 });

async function open(page) {
  await installPanelHarness(page, makeEntries(ITEMS));
  await page.goto('/');
  await page.waitForFunction((count) => document.querySelectorAll('.card').length === count, ITEMS);
}

async function state(page) {
  return page.evaluate((key) => {
    const button = document.querySelector('#search-theme');
    return {
      theme: document.documentElement.dataset.theme,
      stored: window.localStorage.getItem(key),
      icon: document.querySelector('#search-theme use')?.getAttribute('href'),
      aria: button?.getAttribute('aria-label'),
      nativeTitle: button?.getAttribute('title'),
      tip: document.querySelector('.hud-search__tip')?.textContent,
      trace: window.__themeTrace,
    };
  }, KEY);
}

// 提示框是样式表算出来的真节点（不是 CSS content）：颜色、几何、可见性都量得到，
// 而「不被窗口右缘裁掉」「不吃列表点击」正是要量的东西。
async function tipStyle(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.hud-search__tip');
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      color: cs.color,
      background: cs.backgroundColor,
      border: cs.borderTopColor,
      opacity: cs.opacity,
      visibility: cs.visibility,
      pointerEvents: cs.pointerEvents,
      ariaHidden: el.getAttribute('aria-hidden'),
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      // 提示框压着的两种底：窗口画布与卡片，两种都要读出来分别算对比度
      canvas: getComputedStyle(document.querySelector('.app-window')).backgroundColor,
      card: getComputedStyle(document.querySelector('.card')).backgroundColor,
    };
  });
}

async function hoverTip(page) {
  await page.hover('#search-theme');
  await page.waitForTimeout(TIP_SETTLE_MS);
  return tipStyle(page);
}

function rgb(value) {
  const nums = (String(value).match(/-?[\d.]+/g) ?? []).map(Number);
  expect(nums.length, `不是 rgb(a) 值：${value}`).toBeGreaterThanOrEqual(3);
  return { r: nums[0], g: nums[1], b: nums[2], a: nums.length > 3 ? nums[3] : 1 };
}

// --pop-bg 自带 alpha（暗 95% / 亮 96%），叠在真实底上才是眼睛看到的颜色
function over(fore, back) {
  const a = fore.a;
  return { r: fore.r * a + back.r * (1 - a), g: fore.g * a + back.g * (1 - a), b: fore.b * a + back.b * (1 - a), a: 1 };
}

function luminance(color) {
  const chan = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * chan(color.r) + 0.7152 * chan(color.g) + 0.0722 * chan(color.b);
}

function contrast(foreground, background) {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

test('三态循环_皮肤存档与图标同步走一格', async ({ page }) => {
  await open(page);
  // 暗环境 + 默认跟随系统：显示器图标、不落盘
  await expect.poll(() => state(page)).toMatchObject({ theme: 'dark', stored: null, icon: '#i-display' });
  await page.click('#search-theme');
  await expect.poll(() => state(page)).toMatchObject({ theme: 'light', stored: 'light', icon: '#i-sun' });
  await page.click('#search-theme');
  await expect.poll(() => state(page)).toMatchObject({ theme: 'dark', stored: 'dark', icon: '#i-moon' });
  await page.click('#search-theme');
  // 第三下回到跟随系统：清档（stored 归 null）且仍落在暗——默认态不留存档值
  await expect.poll(() => state(page)).toMatchObject({ theme: 'dark', stored: null, icon: '#i-display' });
});

test('提示框不用原生title_文案报当前态与下一态', async ({ page }) => {
  await open(page);
  const before = await state(page);
  expect(before.nativeTitle, '原生 title 会叠一层系统绘制、不跟应用换肤的提示框').toBe(null);
  expect(before.tip).toContain('跟随系统');
  expect(before.tip).toContain('当前：暗');                       // 跟随系统必须报当下落到哪套
  expect(before.tip).toContain('亮');                             // 并预告点下去的去处
  expect(before.aria).toContain('跟随系统');
  expect(before.aria).toContain('点击');
  await page.click('#search-theme');
  const light = await state(page);
  expect(light.tip).toContain('亮');
  expect(light.tip).not.toContain('当前：');                       // 手动两态没有歧义，不补
  expect(light.aria).toContain('亮');
});

test('提示框适应亮暗_两套底面不同且对比度各自达标', async ({ page }) => {
  await open(page);
  await page.click('#search-theme');                               // 跟随系统 → 亮
  const light = await hoverTip(page);
  await page.click('#search-theme');                               // 亮 → 暗（悬停中换态，tip 不关）
  const dark = await hoverTip(page);

  expect(light.visibility).toBe('visible');
  expect(dark.visibility).toBe('visible');
  // 换肤必须真的换到提示框身上：底面、文字、描边三条都得跟着变
  expect(light.background).not.toBe(dark.background);
  expect(light.color).not.toBe(dark.color);
  expect(light.border).not.toBe(dark.border);

  for (const [name, style] of [['亮', light], ['暗', dark]]) {
    const text = rgb(style.color);
    const surface = rgb(style.background);
    for (const [backName, backValue] of [['画布', style.canvas], ['卡片', style.card]]) {
      const ratio = contrast(text, over(surface, rgb(backValue)));
      console.log(`[tip-contrast] ${name}主题 / ${backName}底 = ${ratio.toFixed(2)}:1`);
      expect(ratio, `${name}主题提示框压在${backName}上`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('提示框完整落在窗口内_主题钮不在圆角外死区', async ({ page }) => {
  await open(page);
  const tip = await hoverTip(page);
  expect(tip.rect.width, '提示框没量到宽度').toBeGreaterThan(40);
  console.log(`[tip-rect] ${JSON.stringify(tip.rect)}`);
  expect(tip.rect.left).toBeGreaterThanOrEqual(0);
  expect(tip.rect.right).toBeLessThanOrEqual(VIEWPORT.width);
  expect(tip.rect.top).toBeGreaterThanOrEqual(0);
  expect(tip.rect.bottom).toBeLessThanOrEqual(VIEWPORT.height);

  const corner = await page.evaluate(() => {
    const desktop = document.querySelector('.desktop');
    const desk = desktop.getBoundingClientRect();
    const radius = Number.parseFloat(getComputedStyle(desktop).borderTopLeftRadius);
    const button = document.querySelector('#search-theme').getBoundingClientRect();
    // 与 panelView.shouldIgnoreMouse 同一几何口径：右上角方内、弧外的点被判成穿透（点不到）
    const center = { x: desk.right - radius, y: desk.top + radius };
    const outside = [[button.left, button.top], [button.right, button.top], [button.left, button.bottom], [button.right, button.bottom]]
      .filter(([x, y]) => x > center.x && y < center.y)
      .map(([x, y]) => Math.hypot(x - center.x, y - center.y) - radius);
    return { radius, overflow: outside.length ? Math.max(...outside) : 0 };
  });
  expect(corner.overflow, `主题钮有角点越出 ${corner.radius}px 圆角 ${corner.overflow}px，那里鼠标会穿透`).toBeLessThanOrEqual(0);
});

test('手动两态盖过系统_跟随系统才跟着翻', async ({ page }) => {
  await open(page);
  expect((await state(page)).theme).toBe('dark');                  // 暗环境 + 跟随系统
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => state(page)).toMatchObject({ theme: 'light' });    // 跟随：系统翻亮即跟

  await page.click('#search-theme');                               // → 手动亮
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => state(page)).toMatchObject({ theme: 'light', stored: 'light' });  // 手动态不受系统翻转影响

  await page.click('#search-theme');                               // → 手动暗
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => state(page)).toMatchObject({ theme: 'dark', stored: 'dark' });

  await page.click('#search-theme');                               // → 回跟随系统，立刻跟上当前系统值
  await expect.poll(() => state(page)).toMatchObject({ theme: 'light', stored: null });
});

test('悬停才出提示_离开即收_且不吃列表点击', async ({ page }) => {
  await open(page);
  const idle = await tipStyle(page);
  expect(idle.visibility).toBe('hidden');
  expect(Number(idle.opacity)).toBe(0);
  expect(idle.pointerEvents, 'tip 悬在列表上方，吃了点击就点不到卡片').toBe('none');
  expect(idle.ariaHidden, '同一份文案已由 aria-label 给出，读屏不该听两遍').toBe('true');

  const tip = await hoverTip(page);
  expect(tip.visibility).toBe('visible');
  expect(Number(tip.opacity)).toBe(1);
  // elementFromPoint 认 pointer-events：tip 若吃点击，这里会命中它自己
  const under = await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.className ?? null, {
    x: tip.rect.left + tip.rect.width / 2,
    y: tip.rect.top + tip.rect.height / 2,
  });
  expect(under, '提示框挡住了列表').not.toContain('hud-search__tip');

  await page.mouse.move(VIEWPORT.width / 2, 500);                  // 移到列表中部
  await page.waitForTimeout(TIP_SETTLE_MS);
  expect((await tipStyle(page)).visibility).toBe('hidden');
});

test('首帧定色者是内联脚本_React 挂载前已按存档着色', async ({ page }) => {
  await installPanelHarness(page, makeEntries(ITEMS));
  await page.addInitScript((key) => window.localStorage.setItem(key, 'light'), KEY);
  await page.goto('/');
  await page.waitForFunction((count) => document.querySelectorAll('.card').length === count, ITEMS);
  const first = await page.evaluate(() => window.__themeTrace ?? []);
  // trace[0] 由 <head> 内联脚本写下：暗环境下存档写着亮，首帧就得是亮，闪一下即回归
  expect(first[0]).toBe('inline:light');
  expect(first).toContain('app:light');                            // React 的换肤效果与它同值
});
