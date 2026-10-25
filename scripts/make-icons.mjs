// 生成 icons/icon{16,48,128}.png：紫色渐变圆角方块 + 白色「N」。无第三方依赖。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 在单位坐标 (0..1) 中判断点是否落在字母 N 上
function onN(u, v) {
  const t = 0.13; // 笔画宽度
  if (v < 0.24 || v > 0.76) return false;
  if (u > 0.26 && u < 0.26 + t) return true;
  if (u > 0.74 - t && u < 0.74) return true;
  const k = (v - 0.24) / 0.52;
  const cx = 0.26 + t / 2 + k * (0.48 - t);
  return Math.abs(u - cx) < t * 0.62;
}

function render(size) {
  const ss = 4; // 超采样抗锯齿
  const radius = 0.22;
  return png(size, (x, y) => {
    let inside = 0;
    let letter = 0;
    for (let i = 0; i < ss; i++) {
      for (let j = 0; j < ss; j++) {
        const u = (x + (i + 0.5) / ss) / size;
        const v = (y + (j + 0.5) / ss) / size;
        const dx = Math.max(radius - u, 0, u - (1 - radius));
        const dy = Math.max(radius - v, 0, v - (1 - radius));
        if (dx * dx + dy * dy <= radius * radius) {
          inside++;
          if (onN(u, v)) letter++;
        }
      }
    }
    const n = ss * ss;
    if (!inside) return [0, 0, 0, 0];
    const t = (x + y) / (2 * size);
    const bg = [Math.round(124 + (219 - 124) * t), Math.round(58 + (39 - 58) * t), Math.round(237 + (119 - 237) * t)];
    const f = letter / inside;
    const col = bg.map((c) => Math.round(c * (1 - f) + 255 * f));
    return [...col, Math.round((255 * inside) / n)];
  });
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(new URL(`../icons/icon${s}.png`, import.meta.url), render(s));
console.log('icons written');
