// Generate per-DPI tray icons at exact physical pixel sizes.
//
// Why: Electron's Windows tray path (shell/browser/api/electron_api_tray.cc) calls
// NativeImage::GetHICON(SM_CXSMICON), which builds the HICON from the NativeImage's
// 1x bitmap AS-IS (IconUtil::CreateHICONFromSkBitmap(image_.AsBitmap()) - no size
// argument). Windows then draws that HICON at the tray's physical size. Any base
// bitmap that is not exactly SM_CXSMICON pixels gets resampled by the system and
// turns blurry (worst at fractional scales like 175%). @2x-style DPI ladders are
// ignored on this path.
//
// Fix: ship one PNG per physical size (round(16 * scale) for 100%..200%), each
// rendered directly at that pixel size (SDF rasterization => crisp AA by
// construction), and pick the file at runtime by the primary display's
// scaleFactor (see electron/main.js).
//
// The glyph is re-fitted against the 32px masters (resources/tray-icon.png /
// tray-icon-light.png) with coordinate descent, so regenerating stays faithful to
// the committed artwork.
//
// Usage: node scripts/gen-tray-icons.mjs [--check]
//   --check  fit only, report error, write nothing (used by review/tests)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'resources');
const SIZES = [16, 20, 24, 28, 32];

// ---------- minimal PNG codec (8-bit RGBA, non-interlaced) ----------

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('unsupported PNG');
  const channels = { 6: 4, 2: 3, 0: 1, 4: 2 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    const filter = raw[off];
    raw.copy(line, 0, off + 1, off + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
      }
      line[x] = v;
    }
    prev.set(line);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, s = x * channels;
      out[i] = colorType === 6 || colorType === 2 ? line[s] : line[s];
      out[i + 1] = channels >= 3 ? line[s + 1] : line[s];
      out[i + 2] = channels >= 3 ? line[s + 2] : line[s];
      out[i + 3] = channels === 4 ? line[s + 3] : channels === 2 ? line[s + 1] : 255;
    }
  }
  return { width, height, data: out };
}

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
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunks = [];
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
    chunks.push(head, data, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  chunk('IHDR', ihdr);
  chunk('IDAT', idat);
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

// ---------- glyph model ----------
//
// All geometry lives in the 32px master coordinate space and is scaled by
// size/32 when rendering, so every size is the same mark, rasterized natively.
//
// p = [bx0, by0, bx1, by1, rb, w, tx0, ty0, tx1, rt, l1x0, l1y, l1x1, l1r, l2x0, l2y, l2x1, l2r, wl]
//   body outline : rounded-rect stroke, centerline box (bx0..bx1, by0..by1), radius rb, width w
//   clip tab     : rounded-rect stroke, box (tx0..tx1, ty0..by0) - bottom edge merges into the
//                  body's top stroke, radius rt, width w
//   line 1 / 2   : filled rounded bars (l*x0..l*x1 at l*y), corner radius l*r, thickness wl

function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function glyphSDF(px, py, p) {
  const [bx0, by0, bx1, by1, rb, w, tx0, ty0, tx1, rt, l1x0, l1y, l1x1, l1r, l2x0, l2y, l2x1, l2r, wl] = p;
  const body = Math.abs(sdRoundRect(px, py, bx0, by0, bx1, by1, rb)) - w / 2;
  const tab = Math.abs(sdRoundRect(px, py, tx0, ty0, tx1, by0, rt)) - w / 2;
  const l1 = sdRoundRect(px, py, l1x0, l1y - wl / 2, l1x1, l1y + wl / 2, l1r);
  const l2 = sdRoundRect(px, py, l2x0, l2y - wl / 2, l2x1, l2y + wl / 2, l2r);
  return Math.min(body, tab, l1, l2);
}

// Rasterize the glyph at `size` px (master space = 32). color = [r,g,b].
function renderGlyph(size, color, p) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / 32;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = glyphSDF((x + 0.5) / scale, (y + 0.5) / scale, p);
      const a = Math.min(1, Math.max(0, 0.5 - d));
      const i = (y * size + x) * 4;
      rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2];
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

// ---------- fit glyph parameters against the 32px master alpha ----------

const PARAM_NAMES = ['bx0', 'by0', 'bx1', 'by1', 'rb', 'w', 'tx0', 'ty0', 'tx1', 'rt', 'l1x0', 'l1y', 'l1x1', 'l1r', 'l2x0', 'l2y', 'l2x1', 'l2r', 'wl'];
const INIT = [3.5, 7.5, 29.5, 30.5, 4.5, 2.6, 10.9, 2.5, 22.1, 1.8, 6.9, 15.5, 25.1, 1.3, 6.9, 21.5, 19.1, 1.3, 2.6];

function fitParams(targetAlpha) {
  const p = [...INIT];
  const loss = (params) => {
    let s = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const d = glyphSDF(x + 0.5, y + 0.5, params);
        const a = Math.min(1, Math.max(0, 0.5 - d)) - targetAlpha[y * 32 + x];
        s += a * a;
      }
    }
    return s;
  };
  let cur = loss(p);
  for (const step of [0.5, 0.25, 0.1, 0.05, 0.02]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < p.length; i++) {
        for (const d of [step, -step]) {
          const q = [...p];
          q[i] += d;
          const l = loss(q);
          if (l < cur - 1e-9) { cur = l; p[i] = q[i]; improved = true; }
        }
      }
    }
  }
  return { params: p, loss: cur };
}

function masterAlpha(file) {
  const { data } = decodePNG(fs.readFileSync(file));
  const alpha = new Float64Array(32 * 32);
  for (let i = 0; i < 32 * 32; i++) alpha[i] = data[i * 4 + 3] / 255;
  return alpha;
}

// ---------- main ----------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const checkOnly = isMain && process.argv.includes('--check');
if (isMain) {
const light = masterAlpha(path.join(RES, 'tray-icon-light.png'));
const fit = fitParams(light);

{
  const rgba = renderGlyph(32, [255, 255, 255], fit.params);
  let maxErr = 0, bad = 0, sum = 0;
  for (let i = 0; i < 32 * 32; i++) {
    const err = Math.abs(rgba[i * 4 + 3] / 255 - light[i]);
    sum += err;
    if (err > maxErr) maxErr = err;
    if (err > 0.34) bad++;
  }
  console.log(`fit loss=${fit.loss.toFixed(3)} avgErr=${((sum / (32 * 32)) * 255).toFixed(2)}/255 maxErr=${(maxErr * 255).toFixed(0)}/255 px>87err=${bad}`);
  console.log(PARAM_NAMES.map((n, i) => `${n}=${fit.params[i].toFixed(2)}`).join(' '));
}

if (!checkOnly) {
  const colors = {
    '': [31, 34, 38],       // tray-icon-* : dark strokes for light taskbars
    '-light': [255, 255, 255], // tray-icon-light-* : white strokes for dark taskbars
  };
  for (const [suffix, color] of Object.entries(colors)) {
    for (const size of SIZES) {
      const file = path.join(RES, `tray-icon${suffix}-${size}.png`);
      fs.writeFileSync(file, encodePNG(size, size, renderGlyph(size, color, fit.params)));
      console.log(`wrote ${path.relative(ROOT, file)}`);
    }
  }
}
}
