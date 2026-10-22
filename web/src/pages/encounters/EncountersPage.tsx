import { useEffect, useState } from 'react';
import { api, subscribe } from '../../api';
import type { EncounterAction, EncounterOutcome, EncounterState } from '../../types';
import { Prepare } from './Prepare';
import { Tracker } from './Tracker';

/** Run a fight: pick one prepared in the wiki (or start blank), then the tracker. Live on every open view. */
export function EncountersPage() {
  const [state, setState] = useState<EncounterState | null | undefined>(undefined);
  const [outcome, setOutcome] = useState<EncounterOutcome | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<EncounterState | null>('/encounter').then(setState, (e: Error) => setError(e.message));
    return subscribe({ onEncounter: setState });
  }, []);

  /** Sends one change; the answer (and the live event) carry the new state. */
  const act = async (action: EncounterAction) => {
    setError('');
    try {
      setState(await api<EncounterState>('/encounter/actions', { method: 'POST', json: action }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const end = async () => {
    setError('');
    try {
      setOutcome(await api<EncounterOutcome>('/encounter/end', { method: 'POST', json: {} }));
      setState(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (state === undefined) return error ? <div className="error-box">{error}</div> : <p className="muted">Loading…</p>;
  return (
    <div className="encounters">
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {state ? (
        <Tracker state={state} act={act} onEnd={end} />
      ) : (
        <Prepare
          outcome={outcome}
          onStarted={(s) => {
            setOutcome(null);
            setState(s);
          }}
        />
      )}
    </div>
  );
}
