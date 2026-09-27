// Generates the app's PNG icons (no image tools needed): node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for smooth edges
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / 16) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dist = (x, y) => Math.hypot(x - 0.5, y - 0.5);
const clear = [0, 0, 0, 0];

// Menu bar (template: black + alpha; macOS tints it): a ring with a dot, like a record button.
const tray = (x, y) => {
  const d = dist(x, y);
  return (d < 0.42 && d > 0.32) || d < 0.18 ? [0, 0, 0, 1] : clear;
};
// Recording: same shape, filled red dot (not a template, so it stays red).
const trayRec = (x, y) => {
  const d = dist(x, y);
  if (d < 0.2) return [230, 57, 70, 1];
  return d < 0.42 && d > 0.32 ? [0, 0, 0, 1] : clear;
};
// App icon: rounded indigo square, white ring and dot.
const app = (x, y) => {
  const m = 0.09, rad = 0.2;
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - m - rad), 0), qy = Math.max(Math.abs(y - 0.5) - (0.5 - m - rad), 0);
  if (Math.hypot(qx, qy) > rad) return clear;
  const d = dist(x, y);
  if ((d < 0.27 && d > 0.2) || d < 0.12) return [255, 255, 255, 1];
  const t = y;
  return [Math.round(88 + (72 - 88) * t), Math.round(101 + (80 - 101) * t), Math.round(242 + (220 - 242) * t), 1];
};

writeFileSync('electron/assets/trayTemplate.png', png(16, tray));
writeFileSync('electron/assets/trayTemplate@2x.png', png(32, tray));
writeFileSync('electron/assets/trayRecording.png', png(16, trayRec));
writeFileSync('electron/assets/trayRecording@2x.png', png(32, trayRec));
writeFileSync('electron/assets/icon.png', png(1024, app));
console.log('icons written to electron/assets/');
