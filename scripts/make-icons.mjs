// make-icons.mjs - generates public/icon-192.png / icon-512.png with no
// dependencies (hand-rolled PNG encoder on top of node:zlib).
// Motif: the product's identity — a status lamp on the cockpit dark.
// Usage: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public');

// ---- tiny PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- motif, supersampled 4x ----
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const BG = hex('#1F1E1D'), LINE = hex('#3D3A36'), LIVE = hex('#D97757');
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function render(size) {
  const S = 4, W = size * S;
  const px = new Float64Array(W * W * 4);
  const rr = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r; // signed dist circle
  const rbox = (x, y, cx, cy, hw, hh, rad) => {
    const dx = Math.abs(x - cx) - (hw - rad), dy = Math.abs(y - cy) - (hh - rad);
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - rad;
  };
  const c = W / 2, lamp = W * 0.30;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let col = BG, a = 1;
      const plate = rbox(x + .5, y + .5, c, c, W * .5, W * .5, W * .18);
      if (plate > 0) { a = 0; }                      // transparent rounded corners
      else if (plate > -W * 0.012) col = LINE;       // rim
      const ring = Math.abs(rr(x + .5, y + .5, c, c, lamp * 1.55));
      if (plate < 0 && ring < W * 0.010) col = mix(LIVE, BG, 0.55); // halo ring
      const d = rr(x + .5, y + .5, c, c, lamp);
      if (d < 0) col = LIVE;                          // the lamp
      const i = (y * W + x) * 4;
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = a * 255;
    }
  }
  // downsample (colors were accumulated premultiplied by alpha)
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, aa = 0, n = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const i = ((y * S + sy) * W + (x * S + sx)) * 4;
      const w = px[i + 3] / 255;
      r += px[i] * w; g += px[i + 1] * w; b += px[i + 2] * w; aa += px[i + 3]; n++;
    }
    const A = aa / n;               // avg alpha, 0..255
    const aw = Math.max(1e-6, A / 255 * n); // total alpha weight
    const o = (y * size + x) * 4;
    out[o] = Math.round(r / aw);
    out[o + 1] = Math.round(g / aw);
    out[o + 2] = Math.round(b / aw);
    out[o + 3] = Math.round(A);
  }
  return out;
}

for (const size of [192, 512]) {
  const png = encodePng(size, size, render(size));
  const p = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(p, png);
  console.log('wrote', p, png.length, 'bytes');
}
