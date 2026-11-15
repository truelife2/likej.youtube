// 產生擴充功能圖示（紅底白十字），輸出 icons/ 下的 PNG。
// 不依賴任何套件：自己畫像素、自己壓 PNG（zlib）。
//
//   node tools/make-icons.cjs
//
// 設計：圓角方塊 + 垂直漸層紅底 + 置中白色十字（膠囊端點，縮到 16px 也不會糊）。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 32, 48, 128];
const SS = 4; // 超取樣倍率（先畫 4 倍大再縮，等於抗鋸齒）

const OUT_DIR = path.join(__dirname, '..', 'icons');

const TOP = [226, 62, 62]; // #E23E3E
const BOTTOM = [150, 16, 16]; // #961010
const WHITE = [255, 255, 255];

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 點到線段的距離（用來畫膠囊形狀）
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = clamp01(t);
  const qx = x1 + dx * t;
  const qy = y1 + dy * t;
  return Math.hypot(px - qx, py - qy);
}

function inRoundedRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

function render(size) {
  const W = size * SS;
  const r = W * 0.235; // 圓角半徑
  const cx = W / 2;
  const cy = W / 2;
  const arm = W * 0.29; // 十字臂長（中心到端點）
  const thick = W * 0.185; // 十字粗細
  const half = thick / 2;

  // 高解析度 RGBA
  const hi = new Float32Array(W * W * 4);
  for (let y = 0; y < W; y++) {
    const t = y / (W - 1);
    const base = [
      TOP[0] + (BOTTOM[0] - TOP[0]) * t,
      TOP[1] + (BOTTOM[1] - TOP[1]) * t,
      TOP[2] + (BOTTOM[2] - TOP[2]) * t,
    ];
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inside = inRoundedRect(x + 0.5, y + 0.5, W, W, r);
      if (!inside) continue; // 透明

      const inV = segDist(x + 0.5, y + 0.5, cx, cy - arm, cx, cy + arm) <= half;
      const inH = segDist(x + 0.5, y + 0.5, cx - arm, cy, cx + arm, cy) <= half;
      const col = inV || inH ? WHITE : base;
      hi[i] = col[0] / 255;
      hi[i + 1] = col[1] / 255;
      hi[i + 2] = col[2] / 255;
      hi[i + 3] = 1;
    }
  }

  // 縮小（box filter）：同時處理邊緣的半透明
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r0 = 0;
      let g0 = 0;
      let b0 = 0;
      let a0 = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const a = hi[i + 3];
          r0 += hi[i] * a;
          g0 += hi[i + 1] * a;
          b0 += hi[i + 2] * a;
          a0 += a;
        }
      }
      const n = SS * SS;
      const a = a0 / n;
      const o = (y * size + x) * 4;
      out[o] = a > 0 ? Math.round((r0 / a0) * 255) : 0;
      out[o + 1] = a > 0 ? Math.round((g0 / a0) * 255) : 0;
      out[o + 2] = a > 0 ? Math.round((b0 / a0) * 255) : 0;
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

/* ---------------- PNG 輸出（truecolor + alpha，無交錯） ---------------- */

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(render(size), size);
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`${path.relative(process.cwd(), file)}  ${png.length} bytes`);
}
