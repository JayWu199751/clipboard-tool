import { test, expect } from '@playwright/test';
import { installPanelHarness, makeEntries } from './panel-harness.js';
import { decodePNG } from '../scripts/gen-tray-icons.mjs';

// 暗色模式下 .app-window 的高亮描边是 inset box-shadow 1px（styles.css「窗口框架」权威定义）。
// 用户真机反馈：四边的视觉宽度不一样。根因在 .desktop 的 padding：描边压在窗口物理边缘的
// 那条边会被透明窗口的 per-pixel alpha 裁淡（原 padding「上/左 0、右/下 1px」时上/左不可见），
// 收敛后的契约 2 要求四边各留 1px 让描边完全落在窗口内。
// 本用例截图解码后纯图像扫描：先用 alpha 通道找卡片包围盒，再沿每条边把「亮度高出背景的
// 覆盖量」积分成表观宽度（设备像素），断言四边极差足够小。量前把 .app-window 的子元素整体
// 隐藏——标题栏/内容区/快捷条的背景透明度各不相同，会把描边按边不同程度地盖暗，不隐藏就
// 量出的是「子元素透出程度」而非描边几何。覆盖率之和把抗锯齿半像素如实计入，这是
// getBoundingClientRect 给不出的信息，所以判定留在浏览器里（ADR-0008：执行者是浏览器且能
// 被端到端断言）。截图必须 omitBackground——默认白垫会把半透明边缘垫亮成假描边。

const ITEMS = 8;
const RING_ALPHA = 0.08; // rgba(255,255,255,0.08) 的名义 alpha
const ALPHA_ON = 16;     // alpha 高于此值视为卡片内容（窗口外是透明的）

test.use({ viewport: { width: 418, height: 823 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('clipboard-tool:theme', 'dark');
  });
  await installPanelHarness(page, makeEntries(ITEMS));
  await page.goto('/');
  await page.waitForFunction(
    (count) => document.querySelectorAll('.history-item').length === count,
    ITEMS,
  );
  // 隐藏卡片子元素，让描边裸露在均匀的卡片背景上（见文件头说明）
  await page.addStyleTag({
    content: '.app-window > * { visibility: hidden !important; }',
  });
  await page.waitForTimeout(100);
});

// 卡片内容的不透明包围盒（设备像素，[x0,y0) 半开区间）。圆角外是透明像素，用 alpha 阈值扫。
function cardBounds(png) {
  const alphaAt = (x, y) => png.data[(y * png.width + x) * 4 + 3];
  let x0 = png.width, x1 = 0, y0 = png.height, y1 = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (alphaAt(x, y) > ALPHA_ON) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// 沿一条边把垂直剖面的覆盖率积分成表观宽度（设备像素），取中位数。
// segment 限定采样线段，取边线中段 40% 避开圆角；剖面从边线外侧 3px 扫到内侧 6px，
// 界外或透明像素按亮度 0 计，对背景归一后贡献为 0，不会像钳位重采样那样重复计数。
function edgeWidth(png, card, edge, segment) {
  const horizontal = edge === 'top' || edge === 'bottom';
  const inwardSign = edge === 'top' || edge === 'left' ? 1 : -1;
  const redAt = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return 0;
    return png.data[(y * png.width + x) * 4];
  };
  const vAt = (u, offset) => {
    const pos = edge === 'top' ? card.y0 + offset
      : edge === 'bottom' ? card.y1 - 1 + offset
      : edge === 'left' ? card.x0 + offset
      : card.x1 - 1 + offset;
    return horizontal ? redAt(u, pos) : redAt(pos, u);
  };
  const widths = [];
  for (let u = segment.from; u < segment.to; u += 2) {
    const bg = Math.min(...[6, 7, 8].map((d) => vAt(u, inwardSign * d)));
    const peak = bg + RING_ALPHA * (255 - bg); // 名义 1px 描边在背景上的期望亮度
    let sum = 0;
    for (let d = -3; d <= 6; d += 1) {
      const v = vAt(u, inwardSign * d);
      sum += Math.max(0, Math.min(1.5, (v - bg) / Math.max(1, peak - bg)));
    }
    widths.push(sum);
  }
  widths.sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)];
}

async function measure(page) {
  const png = decodePNG(
    Buffer.from(await page.screenshot({ scale: 'device', omitBackground: true })),
  );
  const card = cardBounds(png);
  const dpr = png.width / 418;
  // 采样段：各边中段 40%（设备像素），避开圆角弧段
  const seg = (a0, a1) => {
    const len = a1 - a0;
    return { from: a0 + len * 0.3, to: a0 + len * 0.7 };
  };
  const widths = {
    top: edgeWidth(png, card, 'top', seg(card.x0, card.x1)),
    bottom: edgeWidth(png, card, 'bottom', seg(card.x0, card.x1)),
    left: edgeWidth(png, card, 'left', seg(card.y0, card.y1)),
    right: edgeWidth(png, card, 'right', seg(card.y0, card.y1)),
  };
  const spread = Math.max(...Object.values(widths)) - Math.min(...Object.values(widths));
  return { dpr, pngSize: { w: png.width, h: png.height }, card, ...widths, spread };
}

for (const dpr of [1, 1.25, 1.5]) {
  test.describe(`dpr=${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test('暗色高亮描边四边表观宽度一致', async ({ page }) => {
      const m = await measure(page);
      console.log(`[ring dpr=${m.dpr}] png=${m.pngSize.w}x${m.pngSize.h} ` +
        `top=${m.top.toFixed(2)} bottom=${m.bottom.toFixed(2)} ` +
        `left=${m.left.toFixed(2)} right=${m.right.toFixed(2)} ` +
        `spread=${m.spread.toFixed(2)}`);
      // 1 CSS px 在分数 DPR 下本就该是 dpr 个设备像素；四边只要彼此一致即算等宽。
      // 容差按设备像素计：半像素以上的肉眼可辨差异才算不齐。
      expect(m.spread).toBeLessThanOrEqual(Math.max(0.4, 0.4 * dpr));
    });
  });
}
