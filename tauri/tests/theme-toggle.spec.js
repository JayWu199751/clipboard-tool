import { test, expect } from '@playwright/test';
import { installPanelHarness, makeEntries } from './panel-harness.js';

test('搜索井内主题按钮紧邻空格提示，三态循环不进入搜索', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await installPanelHarness(page, makeEntries(5));
  await page.goto('/');
  const button = page.locator('#theme-toggle');
  await expect(button).toHaveAttribute('aria-label', '主题：跟随系统，点击切换为亮色');
  await expect(page.locator('#theme-toggle + .hud-search__kbd')).toHaveText('空格');
  for (const label of ['亮色', '暗色', '跟随系统']) {
    await button.click();
    await expect(button).toHaveAttribute('title', new RegExp(`主题：${label}，`));
    await expect(button).toBeEnabled();
    await expect(page.locator('#search-input')).toHaveAttribute('readonly', '');
  }
  expect(await page.evaluate(() => window.__themeWrites)).toEqual(['light', 'dark', 'system']);
  expect(await page.evaluate(() => window.__searchActivations)).toBe(0);
});

test('启动读取已存偏好，外部变更同步按钮，生效主题仍跟媒体查询', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await installPanelHarness(page, makeEntries(5), 'dark');
  await page.goto('/');
  const button = page.locator('#theme-toggle');
  await expect(button).toHaveAttribute('title', '主题：暗色，点击切换为跟随系统');
  await page.evaluate(() => window.__setThemePreference('system'));
  await expect(button).toHaveAttribute('title', '主题：跟随系统，点击切换为亮色');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(button).toHaveAttribute('title', '主题：跟随系统，点击切换为亮色');
});

test('搜索中切换保留文字与焦点，失败保持原偏好并允许重试', async ({ page }) => {
  await installPanelHarness(page, makeEntries(5));
  await page.goto('/');
  const button = page.locator('#theme-toggle');
  await expect(button).toBeEnabled();
  const input = page.locator('#search-input');
  await input.click();
  await input.fill('entry');
  await button.click();
  await expect(button).toHaveAttribute('title', '主题：亮色，点击切换为暗色');
  await expect(button).toBeEnabled();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('entry');
  await page.evaluate(() => { window.__rejectThemeSet = true; });
  await button.click();
  await expect(page.getByText('切换主题失败，请重试')).toBeVisible();
  await expect(button).toHaveAttribute('title', '主题：亮色，点击切换为暗色');
  await expect(button).toBeEnabled();
  await expect(input).toBeFocused();
  await page.evaluate(() => { window.__rejectThemeSet = false; });
  await button.click();
  await expect(button).toHaveAttribute('title', '主题：暗色，点击切换为跟随系统');
});

test('主题事件到达后，迟到的初始读取不能覆盖按钮偏好', async ({ page }) => {
  await installPanelHarness(page, makeEntries(5), 'system', true);
  await page.goto('/');
  await page.waitForFunction(() => window.__themeReadCount === 1);
  await page.evaluate(() => window.__setThemePreference('dark'));
  const button = page.locator('#theme-toggle');
  await expect(button).toHaveAttribute('title', '主题：暗色，点击切换为跟随系统');
  await page.evaluate(() => window.__resolveThemeRead(0, 'light'));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(button).toHaveAttribute('title', '主题：暗色，点击切换为跟随系统');
});

test('呼出补读先返回后，迟到的旧读取不能覆盖按钮偏好', async ({ page }) => {
  await installPanelHarness(page, makeEntries(5), 'system', true);
  await page.goto('/');
  await page.waitForFunction(() => window.__themeReadCount === 1 && window.__panelShownReady);
  await page.evaluate(() => window.__emitPanelShown());
  await page.waitForFunction(() => window.__themeReadCount === 2);
  await page.evaluate(() => window.__resolveThemeRead(1, 'dark'));
  const button = page.locator('#theme-toggle');
  await expect(button).toHaveAttribute('title', '主题：暗色，点击切换为跟随系统');
  await page.evaluate(() => window.__resolveThemeRead(0, 'light'));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(button).toHaveAttribute('title', '主题：暗色，点击切换为跟随系统');
});
