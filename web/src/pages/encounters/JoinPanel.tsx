import { useEffect, useState } from 'react';
import { api } from '../../api';
import { copyText } from '../../clipboard';
import { href } from '../../router';
import type { EncounterState, JoinLink } from '../../types';

/** The players' link for this encounter: copy it, replace it, and who has joined. */
export function JoinPanel({ state }: { state: EncounterState }) {
  const [link, setLink] = useState<JoinLink | null>(null);
  const [note, setNote] = useState('');
  const [confirmNew, setConfirmNew] = useState(false);
  const code = state.join?.code;
  useEffect(() => {
    api<JoinLink>('/encounter/link').then(setLink, (e: Error) => setNote(e.message));
  }, [code]);

  const players = state.join?.players ?? [];
  const names = players.map((p) => state.combatants.find((c) => c.id === p.combatantId)?.name ?? 'a guest');
  const pcs = state.combatants.filter((c) => c.kind === 'pc');
  const joinedPcs = pcs.filter((c) => players.some((p) => p.combatantId === c.id));
  const shown = link?.url ?? link?.local ?? null;
  const copy = async () => {
    if (!shown) return;
    try {
      await copyText(shown);
      setNote('Copied');
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const replace = async () => {
    setConfirmNew(false);
    try {
      setLink(await api<JoinLink>('/encounter/link', { method: 'POST', json: {} }));
      setNote('New link made: the old one no longer works');
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  return (
    <details className="card join-panel" open={players.length === 0}>
      <summary>
        <strong>Players’ link</strong>{' '}
        <span className="muted small">
          {pcs.length ? `${joinedPcs.length} of ${pcs.length} joined` : `${players.length} joined`}
          {names.length > 0 && ` · ${names.join(', ')}`}
        </span>
      </summary>
      {shown && <code className="join-url">{shown}</code>}
      {link && !link.publicUrlSet && (
        <p className="small muted">
          This link only works on this Mac. For players’ phones, turn on Tailscale Funnel and add its address in <a href={href('settings', 'players')}>Settings → Players</a>.
        </p>
      )}
      <div className="row">
        <button onClick={() => void copy()} disabled={!shown}>
          Copy link
        </button>
        <button onClick={() => (confirmNew ? void replace() : setConfirmNew(true))} onBlur={() => setConfirmNew(false)}>
          {confirmNew ? 'Tap again: everyone rejoins' : 'New link'}
        </button>
        {note && (
          <span className="small muted" role="status">
            {note}
          </span>
        )}
      </div>
    </details>
  );
}
