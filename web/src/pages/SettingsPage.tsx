import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import type { Config, ConfigState, Effort, FieldError, Person, PromptInfo, SharedSpeaker } from '../types';
import { Badge, Field, ListEditor, NumberInput, Segmented, Toggle } from '../ui';

type Section = 'people' | 'transcription' | 'summary' | 'prompts' | 'yaml';
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'people', label: 'Recording & people' },
  { key: 'summary', label: 'Summary' },
  { key: 'transcription', label: 'Transcription' },
  { key: 'prompts', label: 'Prompts' },
  { key: 'yaml', label: 'YAML' },
];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const ID_RE = /^\d{15,22}$/;

export function SettingsPage() {
  const [state, setState] = useState<ConfigState | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [section, setSection] = useState<Section>('people');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () =>
    api<ConfigState>('/config').then((s) => {
      setState(s);
      setDraft(s.config ? structuredClone(s.config) : null);
      if (!s.config) setSection('yaml');
    });
  useEffect(() => {
    void load();
    api<Person[]>('/people').then(setPeople, () => {});
  }, []);

  const dirty = useMemo(() => !!draft && !!state?.config && JSON.stringify(draft) !== JSON.stringify(state.config), [draft, state]);
  const err = (path: string) => errors.find((e) => e.path === path)?.message;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setErrors([]);
    try {
      const next = await api<ConfigState>('/config', { method: 'PUT', json: { config: draft } });
      setState(next);
      setDraft(next.config ? structuredClone(next.config) : null);
      setStatus('Saved');
      setTimeout(() => setStatus(''), 2500);
    } catch (e) {
      if (e instanceof ApiError && e.body?.errors) setErrors(e.body.errors);
      setStatus('Not saved: fix the highlighted fields');
    } finally {
      setSaving(false);
    }
  };

  if (!state) return <p className="muted">Loading…</p>;
  const update = (f: (c: Config) => void) => setDraft((d) => (d ? (f(d), structuredClone(d)) : d));

  return (
    <div>
      <h1>Settings</h1>
      <p className="muted small">
        Saved to <code>{state.path}</code>
        {!state.exists && ' (will be created)'}. Comments in the file are kept. Changes apply to the next recording or pipeline run.
      </p>
      <div className="tabs" role="tablist">
        {SECTIONS.map((s) => (
          <button key={s.key} role="tab" aria-selected={section === s.key} className={section === s.key ? 'on' : ''} onClick={() => setSection(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      {state.error && section !== 'yaml' && <div className="error-box">{state.error}</div>}

      {draft && section === 'people' && <PeopleSection config={draft} update={update} people={people} err={err} />}
      {draft && section === 'transcription' && <TranscriptionSection config={draft} update={update} err={err} />}
      {draft && section === 'summary' && <SummarySection config={draft} update={update} err={err} />}
      {section === 'prompts' && <PromptsSection />}
      {section === 'yaml' && <YamlSection state={state} onSaved={load} />}

      {draft && section !== 'prompts' && section !== 'yaml' && (
        <div className="sticky-save">
          <span className={errors.length ? 'field-error' : 'muted small'}>{status || (dirty ? 'Unsaved changes' : 'No changes')}</span>
          <div className="row">
            {dirty && (
              <button onClick={() => (setDraft(structuredClone(state.config!)), setErrors([]))} disabled={saving}>
                Discard
              </button>
            )}
            <button className="primary" onClick={save} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
      {errors.length > 0 && (
        <div className="error-box">
          {errors.map((e) => (
            <div key={e.path + e.message}>
              <code>{e.path || 'config'}</code>: {e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type SectionProps = { config: Config; update: (f: (c: Config) => void) => void; err: (path: string) => string | undefined };

function personLabel(id: string, people: Person[], config: Config): string {
  const alias = config.speakers[id];
  const name = typeof alias === 'string' ? alias : alias?.name;
  const seen = people.find((p) => p.id === id)?.names.join(' / ');
  return name ?? seen ?? 'Unknown user';
}

function PersonPicker({ people, exclude, onPick, placeholder }: { people: Person[]; exclude: string[]; onPick: (id: string) => void; placeholder: string }) {
  const [manual, setManual] = useState('');
  const options = people.filter((p) => !exclude.includes(p.id));
  return (
    <div className="row" style={{ alignItems: 'stretch' }}>
      {options.length > 0 && (
        <select value="" onChange={(e) => e.target.value && onPick(e.target.value)} style={{ flex: '1 1 200px' }}>
          <option value="">{placeholder}</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.names.join(' / ')} ({p.sessions} session{p.sessions === 1 ? '' : 's'})
            </option>
          ))}
        </select>
      )}
      <div className="row" style={{ flex: '1 1 240px', flexWrap: 'nowrap' }}>
        <input value={manual} inputMode="numeric" placeholder="…or paste a Discord user ID" onChange={(e) => setManual(e.target.value.trim())} />
        <button type="button" disabled={!ID_RE.test(manual) || exclude.includes(manual)} onClick={() => (onPick(manual), setManual(''))}>
          Add
        </button>
      </div>
    </div>
  );
}

function PeopleSection({ config, update, err, people }: SectionProps & { people: Person[] }) {
  const speakerIds = Object.keys(config.speakers);
  return (
    <div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Never record</h2>
        <Toggle checked={config.recording.ignore_bots} onChange={(v) => update((c) => void (c.recording.ignore_bots = v))} label="Ignore all bots" hint="Music bots and other bot accounts are never recorded." />
        {config.recording.ignore_users.map((id) => (
          <div key={id} className="row spread list-row" style={{ marginBottom: 6 }}>
            <span>
              <strong>{personLabel(id, people, config)}</strong> <span className="muted small">{id}</span>
            </span>
            <button className="danger" onClick={() => update((c) => void (c.recording.ignore_users = c.recording.ignore_users.filter((x) => x !== id)))}>
              Remove
            </button>
          </div>
        ))}
        <PersonPicker people={people} exclude={config.recording.ignore_users} placeholder="Add someone to ignore…" onPick={(id) => update((c) => void c.recording.ignore_users.push(id))} />
        {err('recording.ignore_users') && <div className="field-error">{err('recording.ignore_users')}</div>}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Speakers</h2>
        <p className="muted small">
          The name each person gets in transcripts. Turn on <strong>Shared account</strong> when several people talk through one Discord account (or one person plays
          several roles), and list who. Claude will label each line before summarizing.
        </p>
        {speakerIds.length === 0 && <p className="muted small">No names set: transcripts use Discord display names.</p>}
        {speakerIds.map((id) => {
          const v = config.speakers[id]!;
          const shared = typeof v !== 'string' && !!v.disambiguate;
          const name = typeof v === 'string' ? v : (v.name ?? '');
          const setValue = (next: string | SharedSpeaker) => update((c) => void (c.speakers[id] = next));
          return (
            <div key={id} className="card" style={{ background: 'var(--surface-2)' }}>
              <div className="row spread">
                <span className="muted small">
                  {people.find((p) => p.id === id)?.names.join(' / ') ?? 'Discord user'} · {id}
                </span>
                <button className="link danger" onClick={() => update((c) => void delete c.speakers[id])}>
                  Remove
                </button>
              </div>
              <Field label="Name in transcripts" error={err(`speakers.${id}`)}>
                <input value={name} onChange={(e) => setValue(shared ? { ...(v as SharedSpeaker), name: e.target.value } : e.target.value)} />
              </Field>
              <Toggle
                checked={shared}
                onChange={(on) => setValue(on ? { name: name || undefined, disambiguate: ['DM — narrates the world and voices NPCs', 'Player character — a character this person plays'] } : name)}
                label="Shared account"
                hint="Several people or roles on this one account."
              />
              {shared && (
                <Field label="Who talks on this account" hint='One per line: "Label — description". The label is used in transcripts; the description helps Claude tell them apart.' error={err(`speakers.${id}.disambiguate`)}>
                  <ListEditor items={(v as SharedSpeaker).disambiguate ?? []} onChange={(list) => setValue({ ...(v as SharedSpeaker), disambiguate: list })} placeholder="e.g. Hamqueef — a half-orc bard played by Rees" />
                </Field>
              )}
            </div>
          );
        })}
        <PersonPicker people={people} exclude={speakerIds} placeholder="Add a speaker…" onPick={(id) => update((c) => void (c.speakers[id] = people.find((p) => p.id === id)?.names[0] ?? 'Name'))} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Recording</h2>
        <div className="grid2">
          <Field label="End an utterance after (ms of silence)" error={err('recording.silence_ms')}>
            <NumberInput value={config.recording.silence_ms} min={200} max={10000} step={100} onChange={(v) => update((c) => void (c.recording.silence_ms = v))} />
          </Field>
          <Field label="Keep audio for (days)" hint="0 = forever" error={err('recording.audio_retention_days')}>
            <NumberInput value={config.recording.audio_retention_days} min={0} onChange={(v) => update((c) => void (c.recording.audio_retention_days = v))} />
          </Field>
        </div>
      </div>
    </div>
  );
}

function TranscriptionSection({ config, update, err }: SectionProps) {
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

function SummarySection({ config, update, err }: SectionProps) {
  const s = config.summary;
  const set = <K extends keyof Config['summary']>(k: K, v: Config['summary'][K]) => update((c) => void (c.summary[k] = v));
  return (
    <div>
      <div className="card">
        <Field label="What these calls are" hint="Background for Claude: the game or meeting, who's who, recurring names." error={err('summary.context')}>
          <textarea value={s.context ?? ''} placeholder="Weekly D&D campaign. Rees is the DM; Sam plays Thorin." onChange={(e) => set('context', e.target.value.trim() ? e.target.value : undefined)} />
        </Field>
        <Field label="Include" hint="What the summary captures. Each becomes a section, in this order." error={err('summary.include')}>
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
          <Field label="Effort: reading chunks & labelling speakers">
            <select value={s.extract_effort} onChange={(e) => set('extract_effort', e.target.value as Effort)}>
              {EFFORTS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Field label="Effort: writing the summary">
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

function PromptsSection() {
  const [data, setData] = useState<{ dir: string | null; prompts: PromptInfo[] } | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  useEffect(() => {
    api<{ dir: string | null; prompts: PromptInfo[] }>('/prompts').then(setData);
  }, []);
  if (!data) return <p className="muted">Loading…</p>;

  const LABEL = { extract: 'Reading each chunk', synthesize: 'Writing the summary', disambiguate: 'Labelling shared-account speakers' };
  const act = async (name: string, method: 'PUT' | 'DELETE') => {
    try {
      const next = await api<{ dir: string | null; prompts: PromptInfo[] }>(`/prompts/${name}`, { method, ...(method === 'PUT' ? { json: { text: edits[name] } } : {}) });
      setData(next);
      setEdits((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== name)));
      setMsg((m) => ({ ...m, [name]: method === 'PUT' ? 'Saved: used from the next run' : 'Back to the built-in prompt' }));
    } catch (e) {
      setMsg((m) => ({ ...m, [name]: (e as Error).message }));
    }
  };
  return (
    <div>
      <p className="muted small">
        Edit the instructions Claude gets. Custom versions are saved in <code>{data.dir ?? 'prompts.local/'}</code>; the built-in ones stay untouched so you can always
        revert.
      </p>
      {data.prompts.map((p) => {
        const text = edits[p.name] ?? p.custom ?? p.builtIn;
        return (
          <div className="card" key={p.name}>
            <div className="row spread">
              <strong>{LABEL[p.name]}</strong>
              <Badge tone={p.custom ? 'accent' : 'neutral'}>{p.custom ? 'Custom' : 'Built-in'}</Badge>
            </div>
            <p className="muted small">
              Placeholders filled in automatically:{' '}
              {p.placeholders.map((x) => (
                <code key={x} style={{ marginRight: 4 }}>{`{{${x}}}`}</code>
              ))}
            </p>
            <textarea className="code" value={text} onChange={(e) => setEdits((ed) => ({ ...ed, [p.name]: e.target.value }))} />
            <div className="row spread" style={{ marginTop: 8 }}>
              <span className="small muted">{msg[p.name]}</span>
              <div className="row">
                {p.custom && <button onClick={() => act(p.name, 'DELETE')}>Revert to built-in</button>}
                <button className="primary" disabled={edits[p.name] === undefined} onClick={() => act(p.name, 'PUT')}>
                  Save
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function YamlSection({ state, onSaved }: { state: ConfigState; onSaved: () => void }) {
  const [text, setText] = useState(state.yaml);
  const [msg, setMsg] = useState('');
  useEffect(() => setText(state.yaml), [state.yaml]);
  const save = async () => {
    try {
      await api('/config', { method: 'PUT', json: { yaml: text } });
      setMsg('Saved');
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="card">
      <p className="muted small">The raw config.yaml, for anything the forms don't cover. It's checked before saving.</p>
      {state.error && <div className="error-box">{state.error}</div>}
      <textarea className="code" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} style={{ minHeight: 400 }} />
      <div className="row spread" style={{ marginTop: 8 }}>
        <span className="small muted" style={{ whiteSpace: 'pre-wrap' }}>
          {msg}
        </span>
        <button className="primary" disabled={text === state.yaml} onClick={save}>
          Save YAML
        </button>
      </div>
    </div>
  );
}
