import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { href } from '../router';
import type { Config, ConfigState, FieldError, Person } from '../types';
import { PeopleSection } from './settings/PeopleSection';
import { CampaignsSection } from './settings/CampaignsSection';
import { TranscriptionSection } from './settings/TranscriptionSection';
import { RecapSection } from './settings/RecapSection';
import { PromptsSection } from './settings/PromptsSection';
import { YamlSection } from './settings/YamlSection';
import { KeysSection } from './settings/KeysSection';

type Section = 'keys' | 'people' | 'campaigns' | 'transcription' | 'summary' | 'prompts' | 'yaml';
const SECTIONS: { key: Section; label: string }[] = [
  ...(window.sessionBot ? [{ key: 'keys' as Section, label: 'Keys & phone' }] : []),
  { key: 'people', label: 'Recording & people' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'summary', label: 'Recap' },
  { key: 'transcription', label: 'Transcription' },
  { key: 'prompts', label: 'Prompts' },
  { key: 'yaml', label: 'YAML' },
];


export function SettingsPage({ initial }: { initial?: string | undefined }) {
  const [state, setState] = useState<ConfigState | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [section, setSection] = useState<Section>(SECTIONS.some((s) => s.key === initial) ? (initial as Section) : 'people');
  // The URL picks the tab (the sidebar links straight to Campaigns), and a tab click updates the URL.
  useEffect(() => {
    if (SECTIONS.some((s) => s.key === initial)) setSection(initial as Section);
  }, [initial]);
  const openSection = (key: Section) => {
    setSection(key);
    window.location.hash = href('settings', key);
  };
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
          <button key={s.key} role="tab" aria-selected={section === s.key} className={section === s.key ? 'on' : ''} onClick={() => openSection(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      {state.error && section !== 'yaml' && <div className="error-box">{state.error}</div>}

      {section === 'keys' && <KeysSection />}
      {draft && section === 'people' && <PeopleSection config={draft} update={update} people={people} err={err} />}
      {draft && section === 'campaigns' && <CampaignsSection config={draft} update={update} people={people} err={err} />}
      {draft && section === 'transcription' && <TranscriptionSection config={draft} update={update} err={err} />}
      {draft && section === 'summary' && <RecapSection config={draft} update={update} err={err} />}
      {section === 'prompts' && <PromptsSection />}
      {section === 'yaml' && <YamlSection state={state} onSaved={load} />}

      {draft && section !== 'prompts' && section !== 'yaml' && section !== 'keys' && (
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
