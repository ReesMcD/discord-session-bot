import { useEffect, useState } from 'react';
import { api, subscribe } from '../api';
import { hms } from '../format';
import { href } from '../router';
import type { BotStatus, GuildInfo, RecordingStatus } from '../types';
import { Badge, Empty } from '../ui';

const SKIP_REASON: Record<string, string> = { bot: 'bot', ignored_user: 'on the ignore list', self: 'this bot' };

export function RecordPage() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [guilds, setGuilds] = useState<GuildInfo[]>([]);
  const [guildId, setGuildId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [lastStopped, setLastStopped] = useState('');

  const loadGuilds = () => api<GuildInfo[]>('/bot/guilds').then(setGuilds, () => {});
  useEffect(() => {
    api<BotStatus>('/bot').then(setStatus, (e: Error) => setError(e.message));
    void loadGuilds();
    return subscribe({
      onBot: (s) => {
        setStatus(s);
        void loadGuilds(); // voice channel membership changes arrive as status events
      },
    });
  }, []);

  const join = async (channelId: string) => {
    setBusy(channelId);
    setError('');
    try {
      await api<RecordingStatus>('/bot/join', { method: 'POST', json: { channelId } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const stop = async () => {
    if (!window.confirm('Stop recording?')) return;
    setBusy('stop');
    try {
      const { sessionId } = await api<{ sessionId: string }>('/bot/stop', { method: 'POST' });
      setLastStopped(sessionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  if (!status) return error ? <div className="error-box">{error}</div> : <p className="muted">Loading…</p>;
  const rec = status.recording;
  const guild = guilds.find((g) => g.id === guildId) ?? guilds[0];

  return (
    <div>
      <h1>Record</h1>
      <BotBanner status={status} />
      {error && <div className="error-box">{error}</div>}
      {lastStopped && !rec && (
        <div className="card">
          Saved as <a href={href('sessions', lastStopped)}>{lastStopped}</a>. It'll be transcribed automatically (Settings → Recording & people → after stopping).
        </div>
      )}
      {rec ? <Recording rec={rec} onStop={stop} stopping={busy === 'stop'} /> : status.state === 'ready' && (
        <>
          {guilds.length > 1 && (
            <select value={guild?.id ?? ''} onChange={(e) => setGuildId(e.target.value)} style={{ marginBottom: 12 }}>
              {guilds.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          {!guild && <Empty title="The bot isn't in any server yet">Invite it with the OAuth2 URL from the Discord Developer Portal (README step 4).</Empty>}
          {guild &&
            [...guild.channels]
              .sort((a, b) => b.members.length - a.members.length)
              .map((c) => (
                <div className="card" key={c.id}>
                  <div className="row spread">
                    <div>
                      <strong>🔊 {c.name}</strong>
                      <div className="muted small">{c.members.length ? c.members.map((m) => m.name + (m.bot ? ' (bot)' : '')).join(', ') : 'Nobody here'}</div>
                    </div>
                    <button className={c.members.length ? 'primary' : ''} disabled={!!busy} onClick={() => join(c.id)}>
                      {busy === c.id ? 'Joining…' : 'Join & record'}
                    </button>
                  </div>
                </div>
              ))}
        </>
      )}
    </div>
  );
}

function BotBanner({ status }: { status: BotStatus }) {
  if (status.state === 'ready') return <p className="muted small">Connected to Discord as {status.user}.</p>;
  if (status.state === 'connecting') return <div className="card">Connecting to Discord…</div>;
  const desktop = !!window.sessionBot;
  return (
    <div className="card">
      <strong>{status.state === 'error' ? `Discord: ${status.error}` : 'The Discord bot is off'}</strong>
      <p className="muted small">
        {desktop ? (
          <>
            Add your bot token under <a href={href('settings', 'keys')}>Settings → Keys & phone</a>.
          </>
        ) : (
          <>
            Set <code>DISCORD_TOKEN</code> in <code>.env</code> on the Mac and restart the app.
          </>
        )}{' '}
        Sessions and settings work without it.
      </p>
    </div>
  );
}

function Recording({ rec, onStop, stopping }: { rec: RecordingStatus; onStop: () => void; stopping: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="card recording">
      <div className="row spread">
        <div>
          <div className="row">
            <span className="rec-dot" /> <strong>{rec.state === 'recording' ? 'Recording' : rec.state === 'reconnecting' ? 'Reconnecting…' : rec.state === 'connecting' ? 'Connecting…' : 'Stopping…'}</strong>
            {rec.reconnects > 0 && <Badge tone="warn">{rec.reconnects} reconnect{rec.reconnects === 1 ? '' : 's'}</Badge>}
          </div>
          <div className="muted small">
            #{rec.channelName} · {rec.guildName}
          </div>
        </div>
        <div className="elapsed">{hms(now - rec.startedAt)}</div>
      </div>
      <h3>Being recorded</h3>
      {rec.participants.length === 0 && <p className="muted small">Nobody has spoken yet.</p>}
      {rec.participants.map((p) => (
        <div key={p.id} className="row spread participant">
          <span className="row">
            <span className={`speak-dot${p.speaking ? ' on' : ''}`} />
            {p.name}
          </span>
          <span className="muted small">
            {p.utterances} clips · {Math.round(p.audioMs / 60000)} min
          </span>
        </div>
      ))}
      {rec.skipped.length > 0 && (
        <p className="muted small">Not recorded: {rec.skipped.map((s) => `${s.name} (${SKIP_REASON[s.reason] ?? s.reason})`).join(', ')}</p>
      )}
      <button className="danger stop" disabled={stopping} onClick={onStop}>
        {stopping ? 'Stopping…' : '■ Stop recording'}
      </button>
    </div>
  );
}
