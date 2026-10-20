import type { Config, Effort } from '../../types';
import { Field, ListEditor, NumberInput, Segmented, Toggle } from '../../ui';
import { EFFORTS, type SectionProps } from './shared';

/** The defaults before the recap format; configs saved back then still carry them. */
const OLD_MEETING_SECTIONS = ['Main topics discussed', 'Decisions made', 'Action items and who owns them', 'Open questions and unresolved issues'];
const RECAP_SECTIONS = ['Loot, rewards and purchases', 'Quests, hooks and open threads'];

export function RecapSection({ config, update, err }: SectionProps) {
  const s = config.summary;
  const set = <K extends keyof Config['summary']>(k: K, v: Config['summary'][K]) => update((c) => void (c.summary[k] = v));
  const oldSections = JSON.stringify(s.include) === JSON.stringify(OLD_MEETING_SECTIONS);
  return (
    <div>
      {oldSections && (
        <div className="card notice">
          <strong>Your extra sections are the old meeting ones</strong>
          <p className="small" style={{ margin: '6px 0 10px' }}>
            "Main topics, Decisions, Action items, Open questions" were the defaults before the recap format, and would now be added after Combat in every recap.
          </p>
          <button onClick={() => set('include', [...RECAP_SECTIONS])}>Use loot and quests instead</button>
        </div>
      )}
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>
          The recap always has <strong>NPCs</strong>, <strong>Locations</strong>, <strong>What happened</strong> and <strong>Combat</strong> (with a kill count). The
          extra sections below come after those. To change the format itself, edit the prompts.
        </p>
        <Field label="What these calls are" hint="Background for Claude for every campaign. Party members and per-campaign background go under Campaigns." error={err('summary.context')}>
          <textarea value={s.context ?? ''} placeholder="Weekly D&D game. Rees is the DM." onChange={(e) => set('context', e.target.value.trim() ? e.target.value : undefined)} />
        </Field>
        <Field label="Extra sections" hint="Each becomes a section after Combat, in this order." error={err('summary.include')}>
          <ListEditor items={s.include} onChange={(v) => set('include', v)} placeholder="e.g. Loot and rewards the party received" />
        </Field>
        <Field label="Exclude" hint="Left out even if it matches an include rule." error={err('summary.exclude')}>
          <ListEditor items={s.exclude} onChange={(v) => set('exclude', v)} placeholder="e.g. Rules arguments and out-of-game chat" />
        </Field>
        <Field label="Detail">
          <Segmented
            value={s.detail}
            options={[
              { value: 'low', label: 'Highlights' },
              { value: 'medium', label: 'Notes' },
              { value: 'high', label: 'Thorough' },
            ]}
            onChange={(v) => set('detail', v)}
          />
        </Field>
        <Toggle checked={s.cite_timestamps} onChange={(v) => set('cite_timestamps', v)} label="Cite timestamps" hint='Adds "[01:23:45]" after each point.' />
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Steps</h2>
        <p className="muted small">Raw transcript → clean-up → audit → recap → audit. Each Claude step costs another pass over the transcript.</p>
        <Toggle checked={s.cleanup} onChange={(v) => set('cleanup', v)} label="Clean up the transcript" hint="Claude fixes misheard names and words and drops filler before the recap is written." />
        <Toggle
          checked={s.cleanup_audit}
          onChange={(v) => set('cleanup_audit', v)}
          label="Check the clean-up"
          hint="Reverts any clean-up edit that rewrote a line instead of correcting it, and restores dropped lines that said something. Free: no API calls."
        />
        <Toggle checked={s.recap_audit} onChange={(v) => set('recap_audit', v)} label="Check the recap is complete" hint="Claude re-reads the transcript against the recap and adds anything it missed." />
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Model</h2>
        <Field label="Claude model" hint="claude-opus-5 (default) or claude-sonnet-5 (cheaper)." error={err('summary.model')}>
          <input value={s.model} list="models" onChange={(e) => set('model', e.target.value)} />
          <datalist id="models">
            <option value="claude-opus-5" />
            <option value="claude-sonnet-5" />
            <option value="claude-haiku-4-5" />
          </datalist>
        </Field>
        <div className="grid2">
          <Field label="Effort: reading chunks (labels, clean-up, notes, checks)">
            <select value={s.extract_effort} onChange={(e) => set('extract_effort', e.target.value as Effort)}>
              {EFFORTS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Field label="Effort: writing the recap">
            <select value={s.synthesize_effort} onChange={(e) => set('synthesize_effort', e.target.value as Effort)}>
              {EFFORTS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Field label="Chunk length (minutes)" error={err('summary.chunk_minutes')}>
            <NumberInput value={s.chunk_minutes} min={5} max={60} onChange={(v) => set('chunk_minutes', v)} />
          </Field>
        </div>
        <Toggle checked={s.fallbacks} onChange={(v) => set('fallbacks', v)} label="Fallback model" hint="If Claude declines a request, retry it on Anthropic's recommended fallback model." />
      </div>
    </div>
  );
}
