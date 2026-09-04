// 托盘图标再生成：参数化 SDF 直出 16/20/24/28/32 五档 × 亮暗两套。
//
// 为什么不能从 32px 基图缩放：见 docs/desktop-tool-pitfalls.md 第 3 节「托盘图标按物理
// 像素直出」。Windows 托盘 HICON 是 1:1 渲染，非整数缩放下任何重采样都把 1px 笔画糊成
// 灰边，所以每个目标尺寸各自在像素中心上求值一次，笔画边缘只留一个像素的过渡。
//
// 几何不是手量出来的，是拿 32px 基图坐标下降拟合出来的，平均误差 1.567 / 255。换图形时
// 把新手感图放成 icons/tray-icon.png，跑 --fit 拿回参数表粘进 P，再直出全套。
//
//   npm run gen:tray              # 按参数表直出 12 张，落盘后回读自校
//   npm run gen:tray -- --verify  # 只比对不落盘：12 张是否与参数表同步（可进 CI）
//   npm run gen:tray -- --fit     # 重新拟合，打印参数表与误差，不落盘

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICONS = path.join(HERE, '..', 'src-tauri', 'icons');
const BASE_PX = 32;                       // 设计空间边长，所有参数以此为单位
const SIZES = [16, 20, 24, 28, 32];       // round(16 × 100%..200%) 的落点
const STROKE = { dark: [31, 34, 38], light: [255, 255, 255] };
const MEAN_ERROR_LIMIT = 3;               // /255，超过即认为图形走样
const COLOR_LIMIT = 8;                    // 有墨处描边色的最大允许偏差

// 以下参数由 --fit 从 32px 基图坐标下降拟合而来（平均误差 1.567 / 255）。
// 换图形时的流程：把新画的手感图放成 icons/tray-icon.png → npm run gen:tray -- --fit
// → 把打印出来的参数表粘回这里 → npm run gen:tray。
let P = {
  bodyCx: 16.531, bodyCy: 19.039, bodyHx: 13.016, bodyHy: 11.5, bodyR: 5.094,
  tabCx: 16.508, tabCy: 5.008, tabHx: 5.961, tabHy: 2.5, tabR: 2.039,
  wallW: 2.469, lineW: 2.445,
  l1y: 15.516, l1x0: 8.563, l1x1: 24.492,
  l2y: 21.516, l2x0: 8.563, l2x1: 18.492,
};

// ---------- 距离场 ----------

function sdRoundBox(x, y, cx, cy, hx, hy, r) {
  const qx = Math.abs(x - cx) - hx + r;
  const qy = Math.abs(y - cy) - hy + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function sdSegment(x, y, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
}

function glyphDist(x, y, p) {
  const body = Math.abs(sdRoundBox(x, y, p.bodyCx, p.bodyCy, p.bodyHx, p.bodyHy, p.bodyR)) - p.wallW / 2;
  const tab = Math.abs(sdRoundBox(x, y, p.tabCx, p.tabCy, p.tabHx, p.tabHy, p.tabR)) - p.wallW / 2;
  const l1 = sdSegment(x, y, p.l1x0, p.l1y, p.l1x1, p.l1y) - p.lineW / 2;
  const l2 = sdSegment(x, y, p.l2x0, p.l2y, p.l2x1, p.l2y) - p.lineW / 2;
  return Math.min(body, tab, l1, l2);
}

// 一个像素宽的光滑过渡：距离 -px/2 全盖、+px/2 全空，中间 smoothstep。
function coverage(d, px) {
  const t = Math.min(1, Math.max(0, (d + px / 2) / px));
  return 1 - t;
}

// 把设计参数按比例换算成目标尺寸下的设备几何。
//
// 两种栅格吸附都试过，都不如纯比例：
// - 吸边缘（把笔画外沿拉到整数栅格）：整套图形平移半个像素，32px 基图误差 1.57 → 33。
//   原作的笔画本来就压在像素中心上——32px 那堵 2px 宽的墙出的是 0.5/1.0/0.5 三列。
// - 只吸宽度（中心线保持比例）：32px 误差 1.57 → 13.6。round() 把目标函数切成台阶，
//   坐标下降带着参数往 2.5 那种临界点上漂，一跨就整档跳粗。
// 直出的收益来自「每个尺寸各自解析求值、绝不让系统重采样」，与硬边无关。
function toDevice(p, size) {
  const k = size / BASE_PX;
  const out = {};
  for (const key of Object.keys(p)) out[key] = p[key] * k;
  return out;
}

// 在 size×size 的像素中心上求值（设备空间，像素宽恒为 1），返回 0..1 的覆盖率网格。
function renderAlpha(size, p) {
  const g = toDevice(p, size);
  const out = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out[y * size + x] = coverage(glyphDist(x + 0.5, y + 0.5, g), 1);
    }
  }
  return out;
}

function toRGBA(alpha, rgb) {
  const n = alpha.length;
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    buf[i * 4] = rgb[0];
    buf[i * 4 + 1] = rgb[1];
    buf[i * 4 + 2] = rgb[2];
    buf[i * 4 + 3] = Math.round(alpha[i] * 255);
  }
  return buf;
}

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

export function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;                       // filter: None
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function decodePNG(buf) {
  let pos = 8;
  let width = 0, height = 0, colorType = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8) throw new Error('仅支持 8 位深度');
      colorType = body[9];
      if (body[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc((height + 1) * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const cur = out.subarray((y + 1) * stride, (y + 2) * stride);
    raw.copy(cur, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = out.subarray(y * stride, (y + 1) * stride);
    if (filter === 1) {
      for (let i = channels; i < stride; i++) cur[i] = (cur[i] + cur[i - channels]) & 0xff;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? cur[i - channels] : 0;
        cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? cur[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y + 1) * stride + x * channels;   // out 顶部多留一行占位，行号要 +1
      const d = (y * width + x) * 4;
      const r = out[s];
      rgba[d] = channels === 3 || channels === 4 ? out[s] : r;
      rgba[d + 1] = channels === 3 ? out[s + 1] : r;
      rgba[d + 2] = channels === 3 ? out[s + 2] : r;
      rgba[d + 3] = channels === 4 ? out[s + 3] : channels === 2 ? out[s + 1] : 255;
    }
  }
  return { width, height, data: rgba };
}

// ---------- 拟合与校验 ----------

function readAlphaFile(file, size) {
  const img = decodePNG(fs.readFileSync(file));
  if (img.width !== size || img.height !== size) {
    throw new Error(`${file} 应为 ${size}x${size}，实际 ${img.width}x${img.height}`);
  }
  const alpha = new Float64Array(size * size);
  for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3];
  return alpha;
}

// 拟合参照是 32px 基图：它是这套图形唯一的「原作」，其余尺寸都由它按比例推出来。
// 旧阶梯的小尺寸对不上纯比例缩放（16px 档差近 19/255），那是随旧脚本一起丢掉的处理细节，
// 一张参数表表达不了；联合五档去拟合也只能换到 0.4 的改善，却要把 32px 的准确度赔进去。
// 所以小尺寸的残差只当诊断信息打印，不进目标函数。
function readBase() {
  return [{ size: BASE_PX, ref: readAlphaFile(path.join(ICONS, 'tray-icon.png'), BASE_PX) }];
}

// 诊断参照：现有暗色阶梯五档，用来看直出的结果与上一次落盘差多少。
function readLadder() {
  return SIZES.map((s) => ({
    size: s,
    ref: readAlphaFile(path.join(ICONS, 'tray', `tray-icon-${s}.png`), s),
  }));
}

function perSizeError(refs, p) {
  return refs.map((r) => `${r.size}px ${refError([r], p).toFixed(2)}`).join('  ');
}

function refError(ref, p) {
  let sum = 0, n = 0;
  for (const item of ref) {
    const a = renderAlpha(item.size, p);
    for (let i = 0; i < item.ref.length; i++) sum += Math.abs(a[i] * 255 - item.ref[i]);
    n += item.ref.length;
  }
  return sum / n;
}

// 坐标下降：逐个参数试探 ±step，接受就推进，步长逐轮减半。
function fit(ref) {
  const keys = Object.keys(P);
  const score = () => refError(ref, P);
  let best = score();
  for (let step = 1.5; step > 0.02; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const k of keys) {
        // 每个方向都从「本参数当前最优值」出发试探，接受就推进，不接受才退回。
        let cur = P[k];
        for (const delta of [step, -step]) {
          P[k] = cur + delta;
          const e = score();
          if (e < best - 1e-9) { best = e; cur = P[k]; improved = true; }
        }
        P[k] = cur;
      }
    }
  }
  return best;
}

function targets() {
  const list = SIZES.map((s) => ({
    file: path.join(ICONS, 'tray', `tray-icon-${s}.png`),
    alpha: renderAlpha(s, P),
    rgb: STROKE.dark,
  }));
  const light = SIZES.map((s) => ({
    file: path.join(ICONS, 'tray', `tray-icon-light-${s}.png`),
    alpha: renderAlpha(s, P),
    rgb: STROKE.light,
  }));
  const base32 = list.find((t) => t.file.endsWith('-32.png'));
  const base32Light = light.find((t) => t.file.endsWith('-32.png'));
  return [
    ...list, ...light,
    { file: path.join(ICONS, 'tray-icon.png'), alpha: base32.alpha, rgb: STROKE.dark },
    { file: path.join(ICONS, 'tray-icon-light.png'), alpha: base32Light.alpha, rgb: STROKE.light },
  ];
}

// 逐张回读比对：尺寸、alpha、有墨处的描边色都要对得上参数表。
function verifyAll() {
  let ok = true;
  let worst = 0;
  for (const t of targets()) {
    const size = Math.round(Math.sqrt(t.alpha.length));
    const rel = path.relative(ICONS, t.file);
    if (!fs.existsSync(t.file)) {
      console.error(`缺失 ${rel}`);
      ok = false;
      continue;
    }
    const img = decodePNG(fs.readFileSync(t.file));
    if (img.width !== size || img.height !== size) {
      console.error(`${rel} 尺寸应为 ${size}x${size}，实际 ${img.width}x${img.height}`);
      ok = false;
      continue;
    }
    let sum = 0;
    let colorMax = 0;
    for (let i = 0; i < size * size; i++) {
      sum += Math.abs(img.data[i * 4 + 3] - t.alpha[i] * 255);
      if (t.alpha[i] > 0.5) {
        for (let c = 0; c < 3; c++) {
          colorMax = Math.max(colorMax, Math.abs(img.data[i * 4 + c] - t.rgb[c]));
        }
      }
    }
    const err = sum / (size * size);
    worst = Math.max(worst, err);
    if (err > MEAN_ERROR_LIMIT) {
      console.error(`${rel} alpha 平均误差 ${err.toFixed(3)} 超阈值 ${MEAN_ERROR_LIMIT}`);
      ok = false;
    }
    if (colorMax > COLOR_LIMIT) {
      console.error(`${rel} 描边色最大偏差 ${colorMax} 超阈值 ${COLOR_LIMIT}`);
      ok = false;
    }
  }
  console.log(`12 张回读比对：最差 alpha 平均误差 ${worst.toFixed(3)} / 255（阈值 ${MEAN_ERROR_LIMIT}）`);
  return ok;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--fit')) {
    const ladder = readLadder();
    const err = fit(readBase());
    console.log('拟合参数（设计空间 32 单位）：');
    console.log(JSON.stringify(P, (_k, v) => (typeof v === 'number' ? +v.toFixed(3) : v), 2));
    console.log(`32px 基图平均误差 ${err.toFixed(3)} / 255`);
    console.log(`对现有阶梯的逐档残差（仅诊断）：${perSizeError(ladder, P)}`);
    return err <= MEAN_ERROR_LIMIT;
  }

  if (args.includes('--verify')) return verifyAll();

  fs.mkdirSync(path.join(ICONS, 'tray'), { recursive: true });
  for (const t of targets()) {
    const size = Math.round(Math.sqrt(t.alpha.length));
    fs.writeFileSync(t.file, encodePNG(size, size, toRGBA(t.alpha, t.rgb)));
    console.log(`${path.relative(ICONS, t.file).padEnd(34)} ${size}x${size}`);
  }
  return verifyAll();
}

// 守卫：被 import 时只导出函数，不跑命令行流程。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main() ? 0 : 1;
}
