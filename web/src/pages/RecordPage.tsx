import { useEffect, useState } from 'react';
import { api, subscribe } from '../api';
import { hms, speakerHue } from '../format';
import { href } from '../router';
import { campaignFor, campaignForChannel, charactersByAccount } from '../../../src/config/roster';
import type { BotStatus, Config, ConfigState, GuildInfo, RecordingStatus, SessionSummary } from '../types';
import { Badge, Empty } from '../ui';
import { LiveTranscript } from './LiveTranscript';

const SKIP_REASON: Record<string, string> = { bot: 'bot', ignored_user: 'on the ignore list', self: 'this bot' };

export function RecordPage() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [guilds, setGuilds] = useState<GuildInfo[]>([]);
  const [guildId, setGuildId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [lastStopped, setLastStopped] = useState('');
  const [config, setConfig] = useState<Config | null>(null);
  /** The campaign picked for the next recording; '' = each channel's usual one. */
  const [campaign, setCampaign] = useState('');

  const loadGuilds = () => api<GuildInfo[]>('/bot/guilds').then(setGuilds, () => {});
  useEffect(() => {
    api<BotStatus>('/bot').then(setStatus, (e: Error) => setError(e.message));
    void loadGuilds();
    api<ConfigState>('/config').then((c) => setConfig(c.config), () => {});
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
      await api<RecordingStatus>('/bot/join', { method: 'POST', json: { channelId, ...(campaign ? { campaign } : {}) } });
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
          Saved as <a href={href('sessions', lastStopped)}>{lastStopped}</a>. It'll be transcribed automatically (Settings → Recording → after stopping).
        </div>
      )}
      {rec ? <Recording rec={rec} config={config} onStop={stop} stopping={busy === 'stop'} /> : status.state === 'ready' && (
        <>
          {config && Object.keys(config.campaigns).length > 0 && (
            <label className="field">
              <span className="field-label">Campaign</span>
              <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
                <option value="">Each channel’s usual campaign (or none)</option>
                {Object.entries(config.campaigns).map(([id, k]) => (
                  <option key={id} value={id}>
                    {k.name}
                  </option>
                ))}
              </select>
              <span className="field-hint">You can change it afterwards on the session’s page.</span>
            </label>
          )}
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
                      <strong className="row" style={{ gap: 6 }}>
                        <SpeakerIcon /> {c.name}
                      </strong>
                      <div className="muted small">{c.members.length ? c.members.map((m) => whoIs(config, campaign || campaignForChannel(config ?? EMPTY, c.id), m)).join(', ') : 'Nobody here'}</div>
                      {config && (campaign || campaignForChannel(config, c.id)) && (
                        <div className="muted small">Campaign: {config.campaigns[campaign || campaignForChannel(config, c.id)!]?.name}</div>
                      )}
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

const EMPTY = { speakers: {}, campaigns: {}, characters: {} };

/** "Sam as Thorin", "Rees", or the Discord name with a note when no speaker is linked to the account. */
function whoIs(config: Config | null, campaignId: string | undefined, m: { id: string; name: string; bot: boolean }): string {
  if (m.bot) return `${m.name} (bot)`;
  if (!config) return m.name;
  const speakers = Object.values(config.speakers).filter((s) => s.discord.includes(m.id));
  if (!speakers.length) return `${m.name} (not a speaker yet)`;
  if (speakers.length > 1) return `${speakers.map((s) => s.name).join(' / ')} (shared mic)`;
  const campaign = campaignFor(config, { campaign: campaignId });
  const character = campaign ? charactersByAccount(config, campaign)[m.id] : undefined;
  return character ? `${speakers[0]!.name} as ${character}` : speakers[0]!.name;
}

function SpeakerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--accent)' }}>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
    </svg>
  );
}

function BotBanner({ status }: { status: BotStatus }) {
  if (status.state === 'ready')
    return (
      <>
        <p className="muted small">
          Connected to Discord as {status.user}.{status.commands === 'ready' && ' In Discord: /record, /stop and /status.'}
        </p>
        {status.commands === 'needs-invite' && status.inviteUrl && (
          <div className="card notice">
            <strong>One step for slash commands</strong>
            <p className="small" style={{ margin: '6px 0 10px' }}>
              The bot was added to your server without permission for slash commands (or to speak, which music needs). Open this link and add it again: nothing is lost,
              and /record, /stop and /status appear in Discord.
            </p>
            <a className="button primary" href={status.inviteUrl} target="_blank" rel="noreferrer">
              Re-add the bot ↗
            </a>
          </div>
        )}
      </>
    );
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

function Recording({ rec, config, onStop, stopping }: { rec: RecordingStatus; config: Config | null; onStop: () => void; stopping: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const label = rec.state === 'recording' ? 'recording' : rec.state === 'reconnecting' ? 'reconnecting…' : rec.state === 'connecting' ? 'connecting…' : 'stopping…';
  return (
    <div className="recording-view">
      <section className="orb-wrap" aria-label="Recording">
        <div className={`orb ${rec.state}`}>
          <span className="orb-ring outer" />
          <span className="orb-ring middle" />
          <span className="orb-core" />
          <div className="orb-text">
            <span className="orb-time">{hms(now - rec.startedAt)}</span>
            <span className="orb-label">{label}</span>
          </div>
        </div>
        <div className="orb-caption">
          <span className="display orb-title">#{rec.channelName}</span>
          <span className="muted small">
            {rec.guildName}
            {rec.reconnects > 0 && ` · ${rec.reconnects} reconnect${rec.reconnects === 1 ? '' : 's'}`}
          </span>
        </div>
      </section>

      {config && Object.keys(config.campaigns).length > 0 && <RecordingCampaign sessionId={rec.sessionId} config={config} />}

      <section className="card">
        <h2 className="eyebrow" style={{ margin: '0 0 6px' }}>At the table</h2>
        {rec.participants.length === 0 && <p className="muted small">Nobody has spoken yet.</p>}
        {rec.participants.map((p) => (
          <div key={p.id} className="person">
            <span className={`avatar${p.speaking ? ' speaking' : ''}`} style={{ ['--hue' as string]: speakerHue(p.name) }}>
              {p.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="person-name">
              <strong>{p.name}</strong>
              <span className="muted small">{p.speaking ? 'speaking' : `${Math.round(p.audioMs / 60000)} min`}</span>
            </span>
            <span className="muted small tabular">{p.utterances} clips</span>
          </div>
        ))}
        {rec.skipped.map((p) => (
          <div key={p.id} className="person skipped">
            <span className="avatar">{p.name.slice(0, 1).toUpperCase()}</span>
            <span className="person-name">
              <strong>{p.name}</strong>
              <span className="muted small">{SKIP_REASON[p.reason] ?? p.reason} · not recorded</span>
            </span>
          </div>
        ))}
      </section>

      <button className="stop" disabled={stopping} onClick={onStop}>
        <span className="stop-square" aria-hidden="true" />
        {stopping ? 'Stopping…' : 'Stop recording'}
      </button>

      {rec.live && <LiveTranscript sessionId={rec.sessionId} />}
    </div>
  );
}

/** The campaign of the recording in progress, changeable while it records. */
function RecordingCampaign({ sessionId, config }: { sessionId: string; config: Config }) {
  const [current, setCurrent] = useState<SessionSummary['campaign'] | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    api<SessionSummary>(`/sessions/${encodeURIComponent(sessionId)}`).then((s) => setCurrent(s.campaign), () => {});
  }, [sessionId]);
  const pick = async (campaign: string) => {
    setError('');
    try {
      setCurrent((await api<SessionSummary>(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', json: { campaign: campaign || null } })).campaign);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (current === undefined) return null;
  return (
    <label className="field">
      <span className="field-label">Campaign</span>
      <select value={current?.picked ? current.key : ''} onChange={(e) => void pick(e.target.value)}>
        <option value="">{current && !current.picked ? `${current.name} (the channel’s usual)` : 'None'}</option>
        {Object.entries(config.campaigns).map(([id, k]) => (
          <option key={id} value={id}>
            {k.name}
          </option>
        ))}
      </select>
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
