import { oggCrc } from '../../src/audio/OggOpusWriter.js';

export interface OggPage {
  flags: number;
  granule: bigint;
  serial: number;
  sequence: number;
  crcOk: boolean;
  packets: Buffer[];
}

/** Test-only Ogg demuxer: splits a file into pages and packets, verifying CRCs. */
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
