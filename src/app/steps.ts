import { loadConfig } from '../config/load.js';
import { createTranscriber } from '../transcription/factory.js';
import { transcribeSession } from '../transcription/transcribeSession.js';
import type { Transcriber } from '../transcription/types.js';
import { mergeSession } from '../transcript/merge.js';
import { AnthropicSummaryModel, type SummaryModel } from '../summary/model.js';
import { disambiguateSession } from '../summary/disambiguate.js';
import { summarizeSession } from '../summary/summarizeSession.js';
import { sharedAccounts, type Config } from '../config/schema.js';
import type { StepRunner } from './jobs.js';
import { sessionDirFor } from './sessions.js';

export interface StepDeps {
  dataDir: string;
  configPath?: string;
  transcriber?: (config: Config['transcription']) => Transcriber;
  summaryModel?: (config: Config) => SummaryModel;
}

/** Connects job steps to the pipeline. Config is re-read for every job, so edits apply immediately. */
export function pipelineRunner(deps: StepDeps): StepRunner {
  const makeTranscriber = deps.transcriber ?? ((c) => createTranscriber(c));
  const makeModel =
    deps.summaryModel ??
    ((c: Config) => {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env on the machine running the app');
      return new AnthropicSummaryModel({ fallbacks: c.summary.fallbacks });
    });

  return async (job, log) => {
    const dir = sessionDirFor(deps.dataDir, job.sessionId);
    if (!dir) throw new Error(`Session ${job.sessionId} not found`);
    const { config, hash } = loadConfig(deps.configPath);

    switch (job.step) {
      case 'transcribe': {
        const stats = await transcribeSession(dir, config.transcription, makeTranscriber(config.transcription), log);
        log(`Transcribed: ${stats.segments} segments from ${stats.speakers} speakers (${stats.batchesFromCache}/${stats.batches} batches cached, ${stats.dropped} dropped)`);
        const merged = mergeSession(dir, config);
        log(`Transcript: ${merged.lines} lines`);
        return;
      }
      case 'merge': {
        const merged = mergeSession(dir, config);
        log(`Transcript rebuilt: ${merged.lines} lines, ${merged.speakers} speakers`);
        return;
      }
      case 'disambiguate': {
        if (sharedAccounts(config).size === 0) throw new Error('No shared accounts configured (Settings → Speakers → "Shared account")');
        const r = await disambiguateSession(dir, config, makeModel(config), { force: job.force, log });
        if (!r.file) throw new Error('None of the configured shared accounts speak in this session');
        log(`${r.stats.labelled} lines labelled: ${r.stats.confident} confident, ${r.stats.guessed} guessed, ${r.stats.unclear} unclear`);
        return;
      }
      case 'summarize': {
        const { meta } = await summarizeSession(dir, config, hash, makeModel(config), { force: job.force, log });
        const u = meta.usage;
        log(`Summary written: ${meta.items} items from ${meta.chunks} chunks; tokens in/out extract ${u.extract.inputTokens}/${u.extract.outputTokens}, summary ${u.synthesize.inputTokens}/${u.synthesize.outputTokens}`);
        return;
      }
    }
  };
}
