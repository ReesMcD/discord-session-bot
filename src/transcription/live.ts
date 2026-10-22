import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { campaignFor, charactersByAccount, sharedAccounts, speakerNames } from '../config/roster.js';
import type { Config } from '../config/schema.js';
import type { UtteranceRecord } from '../recording/UtteranceRecorder.js';
import { paths, readParticipants, readSessionInfo } from '../session/layout.js';
import type { LiveTranscript, TranscriptLine } from '../shared/types.js';
import { mergeSegments } from '../transcript/merge.js';
import { encodeFlac, planBatches, renderBatchPcm, type BatchPlan, type Clip } from './batching.js';
import { dropReason } from './filter.js';
import { remapToUtterances, type SpeakerSegment } from './remap.js';
import type { Transcriber } from './types.js';

/** A batch never holds more than this, so one flush's wait stays short. */
const MAX_BATCH_SEC = 120;

export interface LiveTranscriberOptions {
  sessionDir: string;
  config: Config;
  transcriber: Transcriber;
  /** How often finished utterances are sent. */
  intervalMs?: number;
  /** Turns a batch into an audio file to upload (tests skip ffmpeg). */
  renderBatch?: (plan: BatchPlan, dir: string) => Promise<string>;
  log?: (msg: string) => void;
}

async function renderFlac(plan: BatchPlan, dir: string): Promise<string> {
  const file = join(dir, `${plan.userId}-${Date.now()}-${plan.index}.flac`);
  await encodeFlac(await renderBatchPcm(plan), file);
  return file;
}

/**
 * Transcribes a recording while it happens: finished utterances are collected and, every few
 * seconds, sent per speaker in small batches. Lines are named as in the final transcript and
 * appended to live.jsonl. The transcript made after Stop is unaffected and stays the reference.
 */
export class LiveTranscriber extends EventEmitter {
  private readonly pending: UtteranceRecord[] = [];
  private readonly lines: TranscriptLine[] = [];
  private readonly workDir = mkdtempSync(join(tmpdir(), 'live-'));
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private error: string | undefined;
  private stopped = false;

  constructor(private readonly opts: LiveTranscriberOptions) {
    super();
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.opts.intervalMs ?? 10_000);
  }

  /** Queues a finished utterance (too short or broken ones are skipped, as in the final pass). */
  add(rec: UtteranceRecord): void {
    if (this.stopped || rec.error || rec.durationMs < this.opts.config.transcription.min_utterance_ms) return;
    this.pending.push(rec);
  }

  snapshot(): LiveTranscript {
    return { lines: [...this.lines], ...(this.error ? { error: this.error } : {}) };
  }

  /** Sends what's queued; one flush at a time (a slow one just delays the next). */
  flush(): Promise<void> {
    if (this.flushing || !this.pending.length) return this.flushing ?? Promise.resolve();
    const batch = this.pending.splice(0);
    this.flushing = this.transcribe(batch).finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  /** Stops sending; what's still queued is left to the final transcript. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.flushing;
    rmSync(this.workDir, { recursive: true, force: true });
  }

  private async transcribe(utterances: UtteranceRecord[]): Promise<void> {
    const { sessionDir, config, transcriber } = this.opts;
    const byUser = new Map<string, Clip[]>();
    for (const u of utterances) {
      const clips = byUser.get(u.userId) ?? [];
      clips.push({ file: join(sessionDir, u.file), startMs: u.startMs, durationSec: u.durationMs / 1000 });
      byUser.set(u.userId, clips);
    }
    const bySpeaker = new Map<string, SpeakerSegment[]>();
    try {
      for (const [userId, clips] of byUser) {
        for (const plan of planBatches(userId, clips, MAX_BATCH_SEC)) {
          const audio = await (this.opts.renderBatch ?? renderFlac)(plan, this.workDir);
          const result = await transcriber.transcribe(audio, {
            ...(config.transcription.language ? { language: config.transcription.language } : {}),
            ...(config.transcription.prompt ? { prompt: config.transcription.prompt } : {}),
          });
          rmSync(audio, { force: true });
          const keep = result.segments.filter((s) => !dropReason(s));
          bySpeaker.set(userId, [...(bySpeaker.get(userId) ?? []), ...remapToUtterances({ words: result.words, segments: keep }, plan.clips)]);
        }
      }
      this.error = undefined;
    } catch (err) {
      this.error = `Some live lines were skipped: ${(err as Error).message}`;
      this.opts.log?.(this.error);
    }
    const added = this.name(bySpeaker);
    if (!added.length && !this.error) return;
    this.lines.push(...added);
    this.lines.sort((a, b) => a.startMs - b.startMs);
    if (added.length) appendFileSync(paths.live(sessionDir), added.map((l) => JSON.stringify(l)).join('\n') + '\n');
    this.emit('lines', added, this.snapshot());
  }

  /** Names lines like the final transcript: characters in campaign sessions, real names otherwise. */
  private name(bySpeaker: Map<string, SpeakerSegment[]>): TranscriptLine[] {
    if (!bySpeaker.size) return [];
    const { sessionDir, config } = this.opts;
    const session = readSessionInfo(sessionDir);
    const campaign = campaignFor(config, session);
    return mergeSegments(bySpeaker, {
      sessionStartMs: session.startedAt,
      aliases: speakerNames(config),
      participants: readParticipants(sessionDir),
      ...(campaign ? { characters: charactersByAccount(config, campaign) } : {}),
      mergeGapMs: config.transcript.merge_gap_seconds * 1000,
      maxLineMs: config.transcript.max_line_seconds * 1000,
      noJoin: new Set(sharedAccounts(config).keys()),
    });
  }
}
