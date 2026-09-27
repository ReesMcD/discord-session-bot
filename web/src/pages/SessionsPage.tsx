import { useEffect, useState } from 'react';
import { api } from '../api';
import { duration, when } from '../format';
import { href } from '../router';
import type { SessionSummary } from '../types';
import { Badge, Empty } from '../ui';

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<SessionSummary[]>('/sessions').then(setSessions, (e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="error-box">{error}</div>;
  if (!sessions) return <p className="muted">Loading…</p>;
  return (
    <div>
      <h1>Sessions</h1>
      <p className="muted small">Recordings on this machine, newest first.</p>
      {sessions.length === 0 && (
        <Empty title="No sessions yet">
          Record one with <code>npm run spike:receive</code>, or import a Craig recording with <code>npm run import:craig</code>.
        </Empty>
      )}
      {sessions.map((s) => (
        <a key={s.id} className="card card-link" href={href('sessions', s.id)}>
          <div className="row spread">
            <strong>{s.channelName ? `#${s.channelName}` : s.id}</strong>
            <span className="muted small">{when(s.startedAt)}</span>
          </div>
          <div className="muted small" style={{ margin: '4px 0 8px' }}>
            {s.stoppedAt ? duration(s.stoppedAt - s.startedAt) : 'duration unknown'}
            {s.speakers.length > 0 && ` · ${s.speakers.join(', ')}`}
          </div>
          <div className="row">
            {s.source === 'craig' && <Badge>Craig import</Badge>}
            <Badge tone={s.has.transcript ? 'good' : 'neutral'}>{s.has.transcript ? 'Transcript' : s.has.audio ? `${s.utterances} clips, not transcribed` : 'No audio'}</Badge>
            {s.has.speakerLabels && <Badge tone="accent">Speakers labelled</Badge>}
            {s.has.summary && <Badge tone="good">Summary</Badge>}
          </div>
        </a>
      ))}
    </div>
  );
}
