import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { OPUS_SAMPLE_RATE, opusPacketSamples } from './opus.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32 (polynomial 0x04c11db7, no reflection, init 0). */
export function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc >>> 0;
}

const HEADER_BOS = 0x02;
const HEADER_EOS = 0x04;
const MAX_SEGMENTS = 255;

export interface OggOpusWriterOptions {
  channels?: number;
  /** Flush a page to disk after this many packets (50 × 20 ms = 1 s of audio at risk on a crash). */
  packetsPerPage?: number;
  vendor?: string;
}

/**
 * Minimal streaming Ogg Opus muxer (RFC 7845). Writes pages synchronously so that
 * everything up to the last flushed page survives a process crash, and a file cut
 * off mid-recording is still decodable.
 */
export class OggOpusWriter {
  private readonly fd: number;
  private readonly serial = randomInt(0, 0xffffffff);
  private readonly packetsPerPage: number;
  private pageSequence = 0;
  private granule = 0n;
  private pending: Buffer[] = [];
  private closed = false;
  private bytesWritten = 0;

  constructor(
    readonly path: string,
    options: OggOpusWriterOptions = {},
  ) {
    const channels = options.channels ?? 2;
    this.packetsPerPage = options.packetsPerPage ?? 50;
    this.fd = openSync(path, 'wx');

    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head.writeUInt8(1, 8); // version
    head.writeUInt8(channels, 9);
    head.writeUInt16LE(0, 10); // pre-skip: unknown for Discord's encoder; 0 keeps timing exact
    head.writeUInt32LE(OPUS_SAMPLE_RATE, 12);
    head.writeInt16LE(0, 16); // output gain
    head.writeUInt8(0, 18); // channel mapping family 0 (mono/stereo)
    this.writePage([head], 0n, HEADER_BOS);

    const vendor = Buffer.from(options.vendor ?? 'discord-session-bot', 'utf8');
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write('OpusTags', 0, 'ascii');
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length); // no user comments
    this.writePage([tags], 0n, 0);
  }

  /** Total audio written so far, in 48 kHz samples (including packets not yet flushed). */
  get samples(): number {
    let total = Number(this.granule);
    for (const p of this.pending) total += opusPacketSamples(p);
    return total;
  }

  get bytes(): number {
    return this.bytesWritten;
  }

  write(packet: Buffer): void {
    if (this.closed) throw new Error(`OggOpusWriter for ${this.path} is closed`);
    if (packet.length === 0) return;
    this.pending.push(packet);
    const segments = this.pending.reduce((n, p) => n + Math.floor(p.length / 255) + 1, 0);
    if (this.pending.length >= this.packetsPerPage || segments >= MAX_SEGMENTS - 8) this.flush(0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush(HEADER_EOS, true);
    fsyncSync(this.fd);
    closeSync(this.fd);
  }

  private flush(flags: number, force = false): void {
    if (this.pending.length === 0 && !force) return;
    for (const p of this.pending) this.granule += BigInt(opusPacketSamples(p));
    const packets = this.pending;
    this.pending = [];
    this.writePage(packets, this.granule, flags);
  }

  private writePage(packets: Buffer[], granule: bigint, flags: number): void {
    const lacing: number[] = [];
    for (const p of packets) {
      let len = p.length;
      while (len >= 255) {
        lacing.push(255);
        len -= 255;
      }
      lacing.push(len);
    }
    if (lacing.length > MAX_SEGMENTS) throw new Error('Ogg page overflow');

    const bodyLength = packets.reduce((n, p) => n + p.length, 0);
    const page = Buffer.alloc(27 + lacing.length + bodyLength);
    page.write('OggS', 0, 'ascii');
    page.writeUInt8(0, 4); // stream structure version
    page.writeUInt8(flags, 5);
    page.writeBigUInt64LE(granule, 6);
    page.writeUInt32LE(this.serial, 14);
    page.writeUInt32LE(this.pageSequence++, 18);
    page.writeUInt32LE(0, 22); // CRC placeholder
    page.writeUInt8(lacing.length, 26);
    Buffer.from(lacing).copy(page, 27);
    let offset = 27 + lacing.length;
    for (const p of packets) {
      p.copy(page, offset);
      offset += p.length;
    }
    page.writeUInt32LE(oggCrc(page), 22);

    writeSync(this.fd, page);
    this.bytesWritten += page.length;
  }
}
