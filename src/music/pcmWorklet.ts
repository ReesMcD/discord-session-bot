/**
 * The audio worklet that taps the music mix: it packs the float stereo samples Web Audio delivers
 * (128 at a time) into 20 ms frames of interleaved 16-bit PCM, the format MusicBroadcast takes,
 * and posts each frame's buffer to the page. Kept as plain JavaScript source because a worklet is
 * loaded from text (a Blob URL) and can't import from the app; test/music.test.ts runs this text.
 */
export const PCM_WORKLET_NAME = 'pcm-tap';

export const PCM_WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(960 * 2);
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    const right = input[1] || input[0];
    for (let i = 0; i < left.length; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      this.frame[this.filled * 2] = l < 0 ? l * 0x8000 : l * 0x7fff;
      this.frame[this.filled * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
      this.filled++;
      if (this.filled === 960) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(960 * 2);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('${PCM_WORKLET_NAME}', PcmTap);
`;
