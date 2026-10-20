import { useState } from 'react';
import { api } from '../api';
import type { SessionDetail, UnpairedSpeaker } from '../types';

/** People who spoke without being on the campaign's roster: pair them, mark them guests, or ignore. */
export function UnpairedCard({ s, onSaved }: { s: SessionDetail; onSaved: (d: SessionDetail) => void }) {
  if (!s.unpaired.length) return null;
  return (
    <div className="card notice">
      <strong>New at the table</strong>
      <p className="muted small" style={{ margin: '4px 0 8px' }}>
        Not on this campaign's roster yet. Your choice is saved to the campaign, so you won't be asked again.
      </p>
      {s.unpaired.map((u) => (
        <UnpairedRow key={u.userId} sessionId={s.id} person={u} onSaved={onSaved} />
      ))}
    </div>
  );
}

function UnpairedRow({ sessionId, person, onSaved }: { sessionId: string; person: UnpairedSpeaker; onSaved: (d: SessionDetail) => void }) {
  const [character, setCharacter] = useState(person.character ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (body: object) => {
    setBusy(true);
    setError('');
    try {
      onSaved(await api<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}/unpaired/${person.userId}`, { method: 'POST', json: body }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const guess =
    person.role === 'new_player'
      ? `Probably a new player${person.character ? ` as ${person.character}` : ''}`
      : person.role === 'guest'
        ? 'Probably a guest (not playing)'
        : 'Not on the roster';
  return (
    <div className="unpaired-row">
      <div className="small">
        <strong>{person.name}</strong> · {guess}
        {person.time && <span className="muted"> [{person.time}]</span>}
      </div>
      <div className="row">
        <input value={character} placeholder="Character name" onChange={(e) => setCharacter(e.target.value)} style={{ flex: '1 1 140px', minWidth: 0 }} />
        <button className={person.role === 'guest' ? '' : 'primary'} disabled={busy || !character.trim()} onClick={() => decide({ action: 'pair', character })}>
          Pair
        </button>
        <button className={person.role === 'guest' ? 'primary' : ''} disabled={busy} onClick={() => decide({ action: 'guest' })}>
          Guest
        </button>
        <button className="link" disabled={busy} onClick={() => decide({ action: 'ignore' })}>
          Ignore
        </button>
      </div>
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}
