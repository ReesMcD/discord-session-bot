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

/**
 * Signed distance to the eye's almond (negative inside): the overlap of two circles, so its
 * corners come to a point. hw/hh are the almond's half-width and half-height.
 */
function eye(x, y, hw, hh) {
  const c = (hw * hw - hh * hh) / (2 * hh);
  const r = hh + c;
  return Math.max(Math.hypot(x - 0.5, y - 0.5 - c) - r, Math.hypot(x - 0.5, y - 0.5 + c) - r);
}
const stroke = (sd, w) => Math.abs(sd) < w / 2;

// The Scrying Eye mark: an almond outline, a ring for the iris, a solid pupil.
const mark = (x, y, { hw, hh, line, iris, pupil }) => {
  const d = dist(x, y);
  return stroke(eye(x, y, hw, hh), line) || Math.abs(d - iris) < line / 2 || d < pupil;
};

// Menu bar (template: black + alpha; macOS tints it). At 16 px the iris ring would blur into the
// outline, so the menu bar version is the outline and a solid iris.
const TRAY = { hw: 0.47, hh: 0.28, line: 0.07, iris: 0.15 };
const tray = (x, y) => (stroke(eye(x, y, TRAY.hw, TRAY.hh), TRAY.line) || dist(x, y) < TRAY.iris ? [0, 0, 0, 1] : clear);
// Recording: the same eye with a red iris (not a template, so it stays red).
const trayRec = (x, y) => {
  if (dist(x, y) < TRAY.iris) return [230, 57, 70, 1];
  return stroke(eye(x, y, TRAY.hw, TRAY.hh), TRAY.line) ? [0, 0, 0, 1] : clear;
};
// App icon: an ink-blue rounded square, the eye in pale teal with a faint glow behind the iris.
const app = (x, y) => {
  const m = 0.09, rad = 0.2;
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - m - rad), 0), qy = Math.max(Math.abs(y - 0.5) - (0.5 - m - rad), 0);
  if (Math.hypot(qx, qy) > rad) return clear;
  const teal = [127, 231, 212, 1];
  if (mark(x, y, { hw: 0.33, hh: 0.19, line: 0.03, iris: 0.115, pupil: 0.05 })) return teal;
  const glow = Math.max(0, 1 - dist(x, y) / 0.17) * 0.22;
  const base = [13 + 8 * y, 15 + 10 * y, 21 + 16 * y];
  return [base[0] + (127 - base[0]) * glow, base[1] + (231 - base[1]) * glow, base[2] + (212 - base[2]) * glow, 1].map((v, k) => (k < 3 ? Math.round(v) : v));
};

writeFileSync('electron/assets/trayTemplate.png', png(16, tray));
writeFileSync('electron/assets/trayTemplate@2x.png', png(32, tray));
writeFileSync('electron/assets/trayRecording.png', png(16, trayRec));
writeFileSync('electron/assets/trayRecording@2x.png', png(32, trayRec));
writeFileSync('electron/assets/icon.png', png(1024, app));
console.log('icons written to electron/assets/');
