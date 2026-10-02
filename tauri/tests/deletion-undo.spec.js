import { test, expect } from '@playwright/test';
import { installPanelHarness, makeEntries } from './panel-harness.js';

async function openPanel(page) {
  await page.clock.install();
  await installPanelHarness(page, makeEntries(2));
  await page.goto('/');
  await expect(page.locator('.card')).toHaveCount(2);
  await page.waitForFunction(() => window.__panelKeyReady && window.__panelShownReady);
}

test('撤销恢复条目，原删除截止时间到达也不调用持久化', async ({ page }) => {
  await openPanel(page);
  await page.evaluate(() => window.__emitPanelKey('delete'));
  await expect(page.locator('.card')).toHaveCount(1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.card')).toHaveCount(2);
  await page.clock.runFor(6100);
  expect(await page.evaluate(() => window.__removeCalls)).toEqual([]);
});

test('重新呼出不重置撤销窗口，到原截止时间只提交一次', async ({ page }) => {
  await openPanel(page);
  await page.evaluate(() => window.__emitPanelKey('delete'));
  await expect(page.locator('.card')).toHaveCount(1);
  await page.clock.runFor(3000);
  await page.evaluate(() => window.__emitPanelShown());
  await page.clock.runFor(3100);
  expect(await page.evaluate(() => window.__removeCalls)).toEqual(['entry-0']);
  await expect(page.locator('.card')).toHaveCount(1);
});

for (const failure of ['返回失败', '命令异常']) {
  test(`删除${failure}时恢复条目并提示错误`, async ({ page }) => {
    await openPanel(page);
    await page.evaluate((mode) => {
      window.__removeResult = mode !== '返回失败';
      window.__rejectRemove = mode === '命令异常';
      window.__emitPanelKey('delete');
    }, failure);
    await expect(page.locator('.card')).toHaveCount(1);
    await page.clock.runFor(6100);
    await expect(page.locator('.card')).toHaveCount(2);
    await expect(page.getByText('删除失败，请重试')).toBeVisible();
    expect(await page.evaluate(() => window.__removeCalls)).toEqual(['entry-0']);
  });
}
