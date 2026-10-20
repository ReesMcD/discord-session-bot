import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { PromptInfo } from '../../types';
import { Badge } from '../../ui';

export function PromptsSection() {
  const [data, setData] = useState<{ dir: string | null; prompts: PromptInfo[] } | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  useEffect(() => {
    api<{ dir: string | null; prompts: PromptInfo[] }>('/prompts').then(setData);
  }, []);
  if (!data) return <p className="muted">Loading…</p>;

  const LABEL: Record<PromptInfo['name'], string> = {
    disambiguate: 'Labelling shared-account speakers',
    cleanup: 'Cleaning up the transcript',
    extract: 'Taking notes from each chunk',
    synthesize: 'Writing the recap (its format)',
    audit: 'Checking the recap is complete',
    revise: 'Adding what the check found',
  };
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
