import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { ConfigState } from '../../types';

export function YamlSection({ state, onSaved }: { state: ConfigState; onSaved: () => void }) {
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
