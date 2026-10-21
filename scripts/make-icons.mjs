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
const clear = [0, 0, 0, 0];

/*
 * The Scrying Eye mark: a crystal orb on a stand, drawn in the 32-unit space of the web UI's
 * OrbMark SVG (web/src/icons.tsx), so the PNGs and the SVGs match. Orb: centre (16, 13.5), radius
 * 10.5. Stand: a cradle from the orb's sides, (9.5, 21.5) → (8, 27.5) → (24, 27.5) → (22.5, 21.5).
 * Inside the full mark, an eye; the small mark has a glint of light instead, because a dot in the
 * middle makes it read as a webcam.
 */
const ORB = { x: 16, y: 13.5, r: 10.5 };
const STAND = [[9.5, 21.5], [8, 27.5], [24, 27.5], [22.5, 21.5]];
const MARK_CENTRE_Y = 15.25; // halfway between the orb's top (3) and the stand's foot (27.5)

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay));
}
const onStand = (gx, gy, line) => STAND.slice(1).some((p, k) => segmentDistance(gx, gy, STAND[k], p) < line / 2);
const toOrb = (gx, gy) => Math.hypot(gx - ORB.x, gy - ORB.y);

/**
 * Signed distance to an almond (negative inside): the overlap of two circles, so its corners
 * come to a point. hw/hh are its half-width and half-height.
 */
function almond(gx, gy, cx, cy, hw, hh) {
  const c = (hw * hw - hh * hh) / (2 * hh);
  const r = hh + c;
  return Math.max(Math.hypot(gx - cx, gy - cy - c) - r, Math.hypot(gx - cx, gy - cy + c) - r);
}

/** Maps a pixel (0–1) to mark units, with the mark filling `scale` of the image. */
const toMark = (x, y, scale) => [16 + ((x - 0.5) * 32) / scale, MARK_CENTRE_Y + ((y - 0.5) * 32) / scale];

// Full mark (app icon): orb outline and stand, an eye inside, a solid pupil.
const fullMark = (gx, gy, line) =>
  Math.abs(toOrb(gx, gy) - ORB.r) < line / 2 ||
  onStand(gx, gy, line) ||
  Math.abs(almond(gx, gy, ORB.x, ORB.y, 6, 4)) < line / 2 ||
  toOrb(gx, gy) < 1.7;

// The glint: an arc of radius 6 inside the orb, upper left (200° to 245°, y pointing down).
const GLINT = { r: 6, from: 200, to: 245 };
const polar = (deg, r) => [ORB.x + r * Math.cos((deg * Math.PI) / 180), ORB.y + r * Math.sin((deg * Math.PI) / 180)];
function onGlint(gx, gy, line) {
  const angle = ((Math.atan2(gy - ORB.y, gx - ORB.x) * 180) / Math.PI + 360) % 360;
  if (angle >= GLINT.from && angle <= GLINT.to && Math.abs(toOrb(gx, gy) - GLINT.r) < line / 2) return true;
  return [GLINT.from, GLINT.to].some((deg) => {
    const [ex, ey] = polar(deg, GLINT.r);
    return Math.hypot(gx - ex, gy - ey) < line / 2; // round caps
  });
}

// Menu bar (template: black + alpha; macOS tints it). At 16 px the inner eye blurs, so the small
// mark is the orb, the stand and the glint.
const SMALL = { scale: 0.98, line: 2.6 };
const smallOutline = (gx, gy) => Math.abs(toOrb(gx, gy) - ORB.r) < SMALL.line / 2 || onStand(gx, gy, SMALL.line);
const tray = (x, y) => {
  const [gx, gy] = toMark(x, y, SMALL.scale);
  return smallOutline(gx, gy) || onGlint(gx, gy, SMALL.line) ? [0, 0, 0, 1] : clear;
};
// Recording: the orb in red, glowing (not a template, so it stays red on light and dark menu bars).
const trayRec = (x, y) => {
  const [gx, gy] = toMark(x, y, SMALL.scale);
  if (smallOutline(gx, gy) || onGlint(gx, gy, SMALL.line)) return [230, 57, 70, 1];
  return toOrb(gx, gy) < ORB.r ? [230, 57, 70, 0.4] : clear;
};
// App icon: an ink-blue rounded square, the orb in pale teal with a faint glow inside the glass.
const app = (x, y) => {
  const m = 0.09, rad = 0.2;
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - m - rad), 0), qy = Math.max(Math.abs(y - 0.5) - (0.5 - m - rad), 0);
  if (Math.hypot(qx, qy) > rad) return clear;
  const [gx, gy] = toMark(x, y, 0.66);
  if (fullMark(gx, gy, 1.45)) return [127, 231, 212, 1];
  const glow = toOrb(gx, gy) < ORB.r ? Math.max(0, 1 - Math.hypot(gx - 14, gy - 11) / 11) * 0.24 : 0;
  const base = [13 + 8 * y, 15 + 10 * y, 21 + 16 * y];
  return [base[0] + (127 - base[0]) * glow, base[1] + (231 - base[1]) * glow, base[2] + (212 - base[2]) * glow, 1].map((v, k) => (k < 3 ? Math.round(v) : v));
};

writeFileSync('electron/assets/trayTemplate.png', png(16, tray));
writeFileSync('electron/assets/trayTemplate@2x.png', png(32, tray));
writeFileSync('electron/assets/trayRecording.png', png(16, trayRec));
writeFileSync('electron/assets/trayRecording@2x.png', png(32, trayRec));
writeFileSync('electron/assets/icon.png', png(1024, app));
console.log('icons written to electron/assets/');
