import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../../api';
import { href } from '../../router';
import type { EncounterOutcome, EncounterState, WikiEncounter, WikiEncounterSummary } from '../../types';
import { Badge, Empty } from '../../ui';

/** Before a fight: the wiki's prepared encounters, or a blank one; and how the last one ended. */
export function Prepare({ outcome, onStarted }: { outcome: EncounterOutcome | null; onStarted: (s: EncounterState) => void }) {
  const [list, setList] = useState<WikiEncounterSummary[] | null>(null);
  const [listError, setListError] = useState<{ message: string; setup: boolean } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<WikiEncounterSummary[]>('/encounters/wiki').then(setList, (e: Error) => setListError({ message: e.message, setup: e instanceof ApiError && e.status === 409 }));
  }, []);

  const start = async (body: { wikiId: string; campaign: string } | { title: string }) => {
    setBusy(true);
    setError('');
    try {
      onStarted(await api<EncounterState>('/encounter', { method: 'POST', json: body }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const startBlank = (e: FormEvent) => {
    e.preventDefault();
    void start({ title: title.trim() || 'Encounter' });
  };

  const waiting = (list ?? []).filter((e) => !e.run);
  const played = (list ?? []).filter((e) => e.run);
  return (
    <div>
      <h1>Encounters</h1>
      {outcome && (
        <div className="card notice" role="status">
          <strong>Encounter ended.</strong> {outcome.text}
        </div>
      )}
      {error && <div className="error-box">{error}</div>}

      <h2>Prepared in the wiki</h2>
      {!list && !listError && <p className="muted">Loading the wiki’s encounters…</p>}
      {listError &&
        (listError.setup ? (
          <Empty title="Connect your wiki">
            {listError.message}. <a href={href('settings', 'upload')}>Open Settings → Upload</a>
          </Empty>
        ) : (
          <div className="error-box">{listError.message}</div>
        ))}
      {list && !list.length && <Empty title="Nothing prepared yet">In a Claude chat with your wiki, ask for one: “generate me an encounter for the Alorn South Road”.</Empty>}
      {waiting.map((e) => (
        <WikiEncounterCard key={`${e.campaign}/${e.id}`} summary={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} onStart={() => void start({ wikiId: e.id, campaign: e.campaign })} busy={busy} />
      ))}
      {played.length > 0 && (
        <details className="played">
          <summary className="muted small">Already run ({played.length})</summary>
          {played.map((e) => (
            <WikiEncounterCard key={`${e.campaign}/${e.id}`} summary={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} onStart={() => void start({ wikiId: e.id, campaign: e.campaign })} busy={busy} />
          ))}
        </details>
      )}

      <h2>Or start a blank one</h2>
      <form className="card row" onSubmit={startBlank}>
        <label htmlFor="blank-title" className="visually-hidden">
          Encounter name
        </label>
        <input id="blank-title" style={{ flex: 1, minWidth: 180 }} value={title} placeholder="Name it: Tavern brawl" onChange={(e) => setTitle(e.target.value)} />
        <button className="primary" disabled={busy}>
          Start
        </button>
      </form>
    </div>
  );
}

function WikiEncounterCard({ summary, open, onToggle, onStart, busy }: { summary: WikiEncounterSummary; open: boolean; onToggle: () => void; onStart: () => void; busy: boolean }) {
  const [detail, setDetail] = useState<WikiEncounter | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || detail) return;
    api<WikiEncounter>(`/encounters/wiki/${encodeURIComponent(summary.id)}?campaign=${encodeURIComponent(summary.campaign)}`).then(setDetail, (e: Error) => setError(e.message));
  }, [open, detail, summary.id, summary.campaign]);

  return (
    <div className="card encounter-card">
      <div className="row spread">
        <button type="button" className="link encounter-title" aria-expanded={open} onClick={onToggle}>
          {summary.title}
        </button>
        <div className="row">
          {summary.difficulty && <Badge tone={summary.difficulty === 'high' ? 'warn' : 'neutral'}>{summary.difficulty}</Badge>}
          <button className="primary" onClick={onStart} disabled={busy}>
            Start
          </button>
        </div>
      </div>
      <div className="muted small">{[summary.place, summary.campaign, summary.xp ? `${summary.xp} XP` : null, summary.party_level ? `level ${summary.party_level}` : null].filter(Boolean).join(' · ')}</div>
      {open && (
        <div className="encounter-preview">
          {error && <div className="error-box">{error}</div>}
          {!detail && !error && <p className="muted small">Loading…</p>}
          {detail && (
            <>
              {detail.summary && <p>{detail.summary}</p>}
              {detail.read_aloud && <blockquote className="read-aloud">{detail.read_aloud}</blockquote>}
              <p className="small">
                <strong>Creatures:</strong> {detail.creatures.map((c) => `${c.count} × ${c.name}${c.cr ? ` (CR ${c.cr})` : ''}`).join(', ') || 'none'}
              </p>
              {detail.party.length > 0 && (
                <p className="small">
                  <strong>Party:</strong> {detail.party.map((p) => p.name).join(', ')}
                </p>
              )}
              {detail.map_error && <p className="small bad-text">The battle map has a problem: {detail.map_error}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
