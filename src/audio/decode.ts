import { spawn } from 'node:child_process';

export const PCM_RATE = 16_000;

/**
 * Decodes any audio file ffmpeg understands to 16 kHz mono signed 16-bit PCM
 * (the format Whisper-family models expect).
 */
export function decodeToPcm16k(file: string, ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg'): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.once('error', reject);
    proc.once('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code} for ${file}: ${stderr.trim()}`));
      const buf = Buffer.concat(chunks);
      resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
  });
}

/** Wraps 16 kHz mono PCM in a WAV container. */
export function pcmToWav(pcm: Int16Array, sampleRate = PCM_RATE): Buffer {
  const header = Buffer.alloc(44);
  const dataBytes = pcm.length * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes)]);
}
