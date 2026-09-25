import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { OggOpusWriter } from '../audio/OggOpusWriter.js';
import { OPUS_SAMPLE_RATE, SILENCE_FRAME, opusPacketSamples } from '../audio/opus.js';

export interface UtteranceRecord {
  userId: string;
  /** Wall-clock time (epoch ms) of the first received packet. */
  startMs: number;
  /** Wall-clock time (epoch ms) of the last received packet. */
  endMs: number;
  /** Audio duration in the file, including gap filler. */
  durationMs: number;
  packets: number;
  /** 20 ms silence frames inserted to keep the file aligned with wall-clock time. */
  fillerFrames: number;
  bytes: number;
  /** Path relative to the session directory. */
  file: string;
  error?: string;
}

export interface UtteranceRecorderOptions {
  sessionDir: string;
  userId: string;
  /** Only fill gaps longer than this (absorbs network jitter). */
  gapToleranceMs?: number;
  /** Never fill more than this in one gap (bounded by the end-of-utterance silence timeout). */
  maxFillMs?: number;
  now?: () => number;
}

const FRAME_MS = 20;

/**
 * Consumes one Opus receive stream (a single utterance from one speaker) and writes it to
 * `audio/<userId>/<startEpochMs>.ogg`. Discord clients stop sending during short pauses, so gaps
 * are filled with silence frames to keep in-file offsets aligned with real time.
 */
export class UtteranceRecorder {
  private writer: OggOpusWriter | undefined;
  private startMs = 0;
  private lastPacketMs = 0;
  private packets = 0;
  private fillerFrames = 0;
  private relativeFile = '';
  private readonly gapToleranceMs: number;
  private readonly maxFillMs: number;
  private readonly now: () => number;

  constructor(private readonly options: UtteranceRecorderOptions) {
    this.gapToleranceMs = options.gapToleranceMs ?? 100;
    this.maxFillMs = options.maxFillMs ?? 2_000;
    this.now = options.now ?? Date.now;
  }

  /** Resolves when the stream ends (silence timeout, error, or destroy). Never rejects. */
  record(stream: Readable): Promise<UtteranceRecord | undefined> {
    return new Promise((resolve) => {
      let error: string | undefined;
      stream.on('data', (packet: Buffer) => {
        try {
          this.onPacket(packet);
        } catch (err) {
          error = String(err);
          stream.destroy();
        }
      });
      stream.once('error', (err) => {
        error = err instanceof Error ? err.message : String(err);
      });
      stream.once('close', () => resolve(this.finish(error)));
    });
  }

  private onPacket(packet: Buffer): void {
    const t = this.now();
    if (!this.writer) {
      this.startMs = t;
      const dir = join(this.options.sessionDir, 'audio', this.options.userId);
      mkdirSync(dir, { recursive: true });
      this.relativeFile = join('audio', this.options.userId, `${t}.ogg`);
      this.writer = new OggOpusWriter(join(this.options.sessionDir, this.relativeFile));
    } else {
      const expectedMs = this.startMs + (this.writer.samples / OPUS_SAMPLE_RATE) * 1000;
      const behindMs = Math.min(t - expectedMs, this.maxFillMs);
      if (behindMs > this.gapToleranceMs) {
        const frames = Math.floor(behindMs / FRAME_MS);
        for (let i = 0; i < frames; i++) this.writer.write(SILENCE_FRAME);
        this.fillerFrames += frames;
      }
    }
    if (opusPacketSamples(packet) === 0) return;
    this.writer.write(packet);
    this.packets++;
    this.lastPacketMs = t;
  }

  private finish(error: string | undefined): UtteranceRecord | undefined {
    const writer = this.writer;
    if (!writer) return undefined;
    writer.close();
    return {
      userId: this.options.userId,
      startMs: this.startMs,
      endMs: this.lastPacketMs,
      durationMs: Math.round((writer.samples / OPUS_SAMPLE_RATE) * 1000),
      packets: this.packets,
      fillerFrames: this.fillerFrames,
      bytes: writer.bytes,
      file: this.relativeFile,
      ...(error ? { error } : {}),
    };
  }
}
