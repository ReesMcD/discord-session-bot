import { useEffect, useState } from 'react';
import { api } from '../api';

export function RecordPage() {
  const [keys, setKeys] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    api<{ keys: Record<string, boolean> }>('/health').then((h) => setKeys(h.keys), () => setKeys({}));
  }, []);
  const status = (k: string, label: string) => (
    <li>
      {keys?.[k] ? '✓' : '✗'} {label} {keys && !keys[k] && <span className="muted">(not set in .env)</span>}
    </li>
  );
  return (
    <div className="stack">
      <h1>Record</h1>
      <div className="card">
        <strong>Joining a channel from here is coming next.</strong>
        <p className="muted">
          The next update turns the bot into an always-on process, so you'll be able to pick a voice channel, hit Join and Stop, and see who's being recorded, all from
          this page. Until then, record with <code>npm run spike:receive</code> or import a Craig recording, then open it under Sessions.
        </p>
      </div>
      <div className="card">
        <strong>Keys on this machine</strong>
        <ul>
          {status('discord', 'Discord bot token')}
          {status('transcription', 'Transcription API key')}
          {status('anthropic', 'Anthropic API key (summaries)')}
        </ul>
      </div>
    </div>
  );
}
