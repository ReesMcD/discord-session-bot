import { oggCrc } from './OggOpusWriter.js';

export interface OggPage {
  flags: number;
  granule: bigint;
  serial: number;
  sequence: number;
  crcOk: boolean;
  packets: Buffer[];
}

/** Minimal Ogg demuxer: splits a file into pages and packets, verifying CRCs. */
export function readOgg(data: Buffer): OggPage[] {
  const pages: OggPage[] = [];
  let offset = 0;
  let carry: Buffer[] = [];
  while (offset + 27 <= data.length) {
    if (data.toString('ascii', offset, offset + 4) !== 'OggS') throw new Error(`bad capture pattern at ${offset}`);
    const nSegs = data[offset + 26]!;
    const lacing = data.subarray(offset + 27, offset + 27 + nSegs);
    const bodyLen = lacing.reduce((n, v) => n + v, 0);
    const pageLen = 27 + nSegs + bodyLen;
    const page = Buffer.from(data.subarray(offset, offset + pageLen));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    const packets: Buffer[] = [];
    let pos = 27 + nSegs;
    for (const len of lacing) {
      carry.push(page.subarray(pos, pos + len));
      pos += len;
      if (len < 255) {
        packets.push(Buffer.concat(carry));
        carry = [];
      }
    }
    pages.push({
      flags: page[5]!,
      granule: page.readBigUInt64LE(6),
      serial: page.readUInt32LE(14),
      sequence: page.readUInt32LE(18),
      crcOk: oggCrc(page) === crc,
      packets,
    });
    offset += pageLen;
  }
  return pages;
}

/**
 * Duration of an Ogg Opus file in seconds, from the granule position of its last complete page.
 * Tolerates a truncated final page (e.g. after a crash) by ignoring it.
 */
export function oggOpusDurationSec(data: Buffer): number {
  let offset = 0;
  let granule = 0n;
  while (offset + 27 <= data.length && data.toString('ascii', offset, offset + 4) === 'OggS') {
    const nSegs = data[offset + 26]!;
    if (offset + 27 + nSegs > data.length) break;
    let bodyLen = 0;
    for (let i = 0; i < nSegs; i++) bodyLen += data[offset + 27 + i]!;
    const end = offset + 27 + nSegs + bodyLen;
    if (end > data.length) break;
    const g = data.readBigUInt64LE(offset + 6);
    if (g !== 0xffffffffffffffffn && g > granule) granule = g;
    offset = end;
  }
  return Number(granule) / 48_000;
}
