import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ConfigState, SessionDetail, UnpairedSpeaker } from '../types';

/** Discord accounts heard in this session that no speaker is linked to: add a speaker, link one you have, or ignore. */
export function UnpairedCard({ s, onSaved }: { s: SessionDetail; onSaved: (d: SessionDetail) => void }) {
  const [speakers, setSpeakers] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (!s.unpaired.length) return;
    api<ConfigState>('/config').then((c) => setSpeakers(Object.entries(c.config?.speakers ?? {}).map(([id, sp]) => ({ id, name: sp.name }))), () => {});
  }, [s.unpaired.length]);
  if (!s.unpaired.length) return null;
  return (
    <div className="card notice">
      <strong>New at the table</strong>
      <p className="muted small" style={{ margin: '4px 0 8px' }}>
        Nobody is linked to these Discord accounts yet. Your choice is saved under Settings → Speakers, so you won't be asked again.
      </p>
      {s.unpaired.map((u) => (
        <UnpairedRow key={u.userId} sessionId={s.id} account={u} speakers={speakers} hasCampaign={!!s.campaign} onSaved={onSaved} />
      ))}
    </div>
  );
}

function UnpairedRow({
  sessionId,
  account,
  speakers,
  hasCampaign,
  onSaved,
}: {
  sessionId: string;
  account: UnpairedSpeaker;
  speakers: Array<{ id: string; name: string }>;
  hasCampaign: boolean;
  onSaved: (d: SessionDetail) => void;
}) {
  const [name, setName] = useState(account.name);
  const [character, setCharacter] = useState(account.role === 'guest' ? '' : (account.character ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (body: object) => {
    setBusy(true);
    setError('');
    try {
      onSaved(await api<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}/unpaired/${account.userId}`, { method: 'POST', json: body }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const guess =
    account.role === 'new_player'
      ? `Probably a new player${account.character ? ` as ${account.character}` : ''}`
      : account.role === 'guest'
        ? 'Probably a guest (not playing)'
        : 'Not linked to a speaker';
  return (
    <div className="unpaired-row">
      <div className="small">
        <strong>{account.name}</strong> · {guess}
        {account.time && <span className="muted"> [{account.time}]</span>}
      </div>
      <div className="row">
        <input value={name} aria-label="Speaker name" placeholder="Their name" onChange={(e) => setName(e.target.value)} style={{ flex: '1 1 120px', minWidth: 0 }} />
        {hasCampaign && (
          <input value={character} aria-label="Character" placeholder="Character (optional)" onChange={(e) => setCharacter(e.target.value)} style={{ flex: '1 1 120px', minWidth: 0 }} />
        )}
        <button className="primary" disabled={busy || !name.trim()} onClick={() => decide({ action: 'new', name, ...(character.trim() ? { character } : {}) })}>
          Add speaker
        </button>
      </div>
      <div className="row">
        {speakers.length > 0 && (
          <select value="" disabled={busy} aria-label="Link to a speaker you have" onChange={(e) => e.target.value && decide({ action: 'link', speaker: e.target.value })} style={{ flex: '1 1 160px' }}>
            <option value="">…or it's someone you have (on another mic)</option>
            {speakers.map((sp) => (
              <option key={sp.id} value={sp.id}>
                {sp.name}
              </option>
            ))}
          </select>
        )}
        <button className="link" disabled={busy} onClick={() => decide({ action: 'ignore' })}>
          Ignore
        </button>
      </div>
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}
