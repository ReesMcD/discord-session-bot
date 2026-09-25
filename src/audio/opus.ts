/** Opus always runs at 48 kHz internally; Ogg Opus granule positions count 48 kHz samples. */
export const OPUS_SAMPLE_RATE = 48_000;

/**
 * The 20 ms stereo CELT silence frame Discord clients send at the end of speech.
 * Also used to fill gaps so an utterance file's timeline matches wall-clock time.
 */
export const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

/** Samples per frame (at 48 kHz) for each TOC config value 0..31 (RFC 6716 §3.1). */
const FRAME_SAMPLES: readonly number[] = (() => {
  const table: number[] = [];
  for (let config = 0; config < 32; config++) {
    let ms: number;
    if (config < 12) ms = [10, 20, 40, 60][config % 4]!; // SILK
    else if (config < 16) ms = [10, 20][config % 2]!; // Hybrid
    else ms = [2.5, 5, 10, 20][config % 4]!; // CELT
    table.push((ms * OPUS_SAMPLE_RATE) / 1000);
  }
  return table;
})();

/**
 * Number of 48 kHz samples encoded in an Opus packet, derived from its TOC byte.
 * Returns 0 for a malformed packet.
 */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length < 1) return 0;
  const toc = packet[0]!;
  const perFrame = FRAME_SAMPLES[toc >> 3]!;
  let frames: number;
  switch (toc & 0x03) {
    case 0:
      frames = 1;
      break;
    case 1:
    case 2:
      frames = 2;
      break;
    default:
      if (packet.length < 2) return 0;
      frames = packet[1]! & 0x3f;
  }
  return perFrame * frames;
}
