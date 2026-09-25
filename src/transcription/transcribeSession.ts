import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Config } from '../config/schema.js';
import { oggOpusDurationSec } from '../audio/oggReader.js';
import { listUtterances, paths, readJson, writeJson } from '../session/layout.js';
import { mapLimit } from '../util/retry.js';
import { encodeFlac, planBatches, renderBatchPcm, type BatchPlan, type Clip } from './batching.js';
import { dropReason, type DropReason } from './filter.js';
import { remapToUtterances, type SpeakerSegment } from './remap.js';
import type { Transcriber, TranscriptionResult } from './types.js';

export interface SpeakerTranscript {
  userId: string;
  transcriber: string;
  segments: SpeakerSegment[];
  dropped: { reason: DropReason; text: string; startMs: number }[];
}

interface RawCache {
  planHash: string;
  transcriber: string;
  result: TranscriptionResult;
}

export interface TranscribeStats {
  speakers: number;
  utterances: number;
  skippedShort: number;
  batches: number;
  batchesFromCache: number;
  segments: number;
  dropped: number;
}

function planHash(plan: BatchPlan, sessionDir: string, prompt: string | undefined, language: string | undefined): string {
  const key = plan.clips.map((c) => `${relative(sessionDir, c.file)}@${c.offsetSec}+${c.durationSec}`).join('|');
  return createHash('sha256').update(`${key}#${language ?? ''}#${prompt ?? ''}`).digest('hex');
}

/**
 * Transcribes every speaker in a session folder and writes transcripts/<userId>.json.
 * Safe to re-run: batches already transcribed with the same inputs and transcriber are reused.
 */
export async function transcribeSession(
  sessionDir: string,
  config: Config['transcription'],
  transcriber: Transcriber,
  log: (msg: string) => void = console.log,
): Promise<TranscribeStats> {
  const utterances = listUtterances(sessionDir);
  const byUser = new Map<string, Clip[]>();
  let skippedShort = 0;
  for (const u of utterances) {
    const durationSec = oggOpusDurationSec(readFileSync(u.path));
    if (durationSec * 1000 < config.min_utterance_ms) {
      skippedShort++;
      continue;
    }
    const list = byUser.get(u.userId) ?? [];
    list.push({ file: u.path, startMs: u.startMs, durationSec });
    byUser.set(u.userId, list);
  }

  const plans = [...byUser].flatMap(([userId, clips]) => planBatches(userId, clips, config.batch_minutes * 60));
  mkdirSync(paths.batchesDir(sessionDir), { recursive: true });
  mkdirSync(paths.rawDir(sessionDir), { recursive: true });
  log(`${utterances.length} utterances from ${byUser.size} speakers → ${plans.length} batches (${skippedShort} too short, skipped)`);

  let fromCache = 0;
  const results = await mapLimit(plans, config.concurrency, async (plan) => {
    const name = `${plan.userId}-${String(plan.index).padStart(3, '0')}`;
    const hash = planHash(plan, sessionDir, config.prompt, config.language);
    const rawFile = join(paths.rawDir(sessionDir), `${name}.json`);
    const cached = readJson<RawCache>(rawFile);
    if (cached && cached.planHash === hash && cached.transcriber === transcriber.id) {
      fromCache++;
      return { plan, result: cached.result };
    }
    const audioFile = join(paths.batchesDir(sessionDir), `${name}.flac`);
    const pcm = await renderBatchPcm(plan);
    await encodeFlac(pcm, audioFile);
    writeJson(join(paths.batchesDir(sessionDir), `${name}.json`), { ...plan, clips: plan.clips.map((c) => ({ ...c, file: relative(sessionDir, c.file) })) });
    const started = Date.now();
    const result = await transcriber.transcribe(audioFile, {
      ...(config.language ? { language: config.language } : {}),
      ...(config.prompt ? { prompt: config.prompt } : {}),
    });
    writeJson(rawFile, { planHash: hash, transcriber: transcriber.id, result } satisfies RawCache);
    log(`  ${name}: ${plan.durationSec.toFixed(0)}s audio, ${plan.clips.length} utterances → ${result.segments.length} segments in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return { plan, result };
  });

  const perUser = new Map<string, SpeakerTranscript>();
  for (const { plan, result } of results) {
    const t = perUser.get(plan.userId) ?? { userId: plan.userId, transcriber: transcriber.id, segments: [], dropped: [] };
    const keep = result.segments.filter((s) => {
      const reason = dropReason(s);
      if (reason) t.dropped.push({ reason, text: s.text, startMs: remapToUtterances({ words: [], segments: [s] }, plan.clips)[0]!.startMs });
      return !reason;
    });
    t.segments.push(...remapToUtterances({ words: result.words, segments: keep }, plan.clips));
    perUser.set(plan.userId, t);
  }

  let segments = 0;
  let dropped = 0;
  for (const t of perUser.values()) {
    t.segments.sort((a, b) => a.startMs - b.startMs);
    segments += t.segments.length;
    dropped += t.dropped.length;
    writeJson(paths.speakerTranscript(sessionDir, t.userId), t);
  }
  return { speakers: perUser.size, utterances: utterances.length, skippedShort, batches: plans.length, batchesFromCache: fromCache, segments, dropped };
}

