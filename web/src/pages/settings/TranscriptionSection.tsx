import type { Config } from '../../types';
import { Field, NumberInput, Segmented, Toggle } from '../../ui';
import type { SectionProps } from './shared';

export function TranscriptionSection({ config, update, err }: SectionProps) {
  const t = config.transcription;
  const set = <K extends keyof Config['transcription']>(k: K, v: Config['transcription'][K]) => update((c) => void (c.transcription[k] = v));
  const opt = (v: string) => (v.trim() ? v : undefined);
  return (
    <div>
      <div className="card">
        <Field label="Provider" hint="The API key lives in .env on the Mac (GROQ_API_KEY or OPENAI_API_KEY).">
          <Segmented value={t.provider} options={[{ value: 'groq', label: 'Groq' }, { value: 'openai', label: 'OpenAI' }]} onChange={(v) => set('provider', v)} />
        </Field>
        <div className="grid2">
          <Field label="Model" hint={t.provider === 'groq' ? 'Default: whisper-large-v3-turbo' : 'Default: whisper-1 (needed for timestamps)'} error={err('transcription.model')}>
            <input value={t.model ?? ''} placeholder="default" onChange={(e) => set('model', opt(e.target.value))} />
          </Field>
          <Field label="Language" hint="Two-letter code, e.g. en. Blank = auto-detect." error={err('transcription.language')}>
            <input value={t.language ?? ''} maxLength={2} placeholder="auto" onChange={(e) => set('language', opt(e.target.value.toLowerCase()))} />
          </Field>
        </div>
        <Field label="Vocabulary hint" hint="Names and terms Whisper should spell correctly. Changing it re-transcribes next time." error={err('transcription.prompt')}>
          <textarea value={t.prompt ?? ''} placeholder="Names and terms: Rees, Sam, Waterdeep, Strahd." onChange={(e) => set('prompt', opt(e.target.value))} />
        </Field>
        <Toggle
          checked={t.live}
          onChange={(v) => set('live', v)}
          label="Live transcript while recording"
          hint="Lines appear on the Record page a few seconds after they're spoken, on the Mac and your phone. It's a preview: everything is transcribed again after Stop, so it at least doubles the transcription cost."
        />
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Transcript</h2>
        <div className="grid2">
          <Field label="Join a speaker's lines if they paused at most (s)" error={err('transcript.merge_gap_seconds')}>
            <NumberInput value={config.transcript.merge_gap_seconds} min={0} max={30} step={0.5} onChange={(v) => update((c) => void (c.transcript.merge_gap_seconds = v))} />
          </Field>
          <Field label="…up to a line of (s)" error={err('transcript.max_line_seconds')}>
            <NumberInput value={config.transcript.max_line_seconds} min={5} max={600} onChange={(v) => update((c) => void (c.transcript.max_line_seconds = v))} />
          </Field>
          <Field label="Time zone" hint="e.g. America/New_York. Blank = the Mac's." error={err('transcript.timezone')}>
            <input value={config.transcript.timezone ?? ''} placeholder="machine default" onChange={(e) => update((c) => void (c.transcript.timezone = opt(e.target.value)))} />
          </Field>
        </div>
      </div>
      <details className="card">
        <summary>
          <strong>Advanced</strong>
        </summary>
        <div className="grid2" style={{ marginTop: 12 }}>
          <Field label="API base URL" hint="Any OpenAI-compatible server" error={err('transcription.base_url')}>
            <input value={t.base_url ?? ''} placeholder="provider default" onChange={(e) => set('base_url', opt(e.target.value))} />
          </Field>
          <Field label="Batch length (minutes)" error={err('transcription.batch_minutes')}>
            <NumberInput value={t.batch_minutes} min={1} max={20} onChange={(v) => set('batch_minutes', v)} />
          </Field>
          <Field label="Parallel uploads" error={err('transcription.concurrency')}>
            <NumberInput value={t.concurrency} min={1} max={8} onChange={(v) => set('concurrency', v)} />
          </Field>
          <Field label="Skip sounds shorter than (ms)" error={err('transcription.min_utterance_ms')}>
            <NumberInput value={t.min_utterance_ms} min={0} step={50} onChange={(v) => set('min_utterance_ms', v)} />
          </Field>
        </div>
      </details>
    </div>
  );
}
