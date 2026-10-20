import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, auth, subscribe } from './api';
import { CampaignsIcon, EyeMark, RecordIcon, SessionsIcon, SettingsIcon } from './icons';
import type { BotStatus } from './types';
import { href, useRoute } from './router';
import { SessionsPage } from './pages/SessionsPage';
import { SessionPage } from './pages/SessionPage';
import { SettingsPage } from './pages/SettingsPage';
import { RecordPage } from './pages/RecordPage';

export function App() {
  const [authed, setAuthed] = useState(auth.isSet);
  const route = useRoute();
  useEffect(() => auth.onLogout(() => setAuthed(false)) as () => void, []);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Shell route={route} />;
}

const NAV = [
  { key: 'record', label: 'Record', Icon: RecordIcon },
  { key: 'sessions', label: 'Sessions', Icon: SessionsIcon },
  { key: 'settings', label: 'Settings', Icon: SettingsIcon },
];

function Shell({ route }: { route: string[] }) {
  const [page = 'sessions', id] = route;
  const bot = useBotStatus();
  const campaignsOpen = page === 'settings' && id === 'campaigns';
  const recording = bot?.recording;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href={href('sessions')}>
          <EyeMark /> Scrying Eye
        </a>
        <nav className="side-nav" aria-label="Main">
          {NAV.slice(0, 2).map(({ key, label, Icon }) => (
            <a key={key} href={href(key)} className={page === key ? 'on' : ''} aria-current={page === key ? 'page' : undefined}>
              <Icon /> {label}
            </a>
          ))}
          <a href={href('settings', 'campaigns')} className={campaignsOpen ? 'on' : ''} aria-current={campaignsOpen ? 'page' : undefined}>
            <CampaignsIcon /> Campaigns
          </a>
          <a href={href('settings')} className={page === 'settings' && !campaignsOpen ? 'on' : ''} aria-current={page === 'settings' && !campaignsOpen ? 'page' : undefined}>
            <SettingsIcon /> Settings
          </a>
        </nav>
        <div className="bot-status" role="status">
          <span className={`status-dot ${recording ? 'recording' : bot?.state === 'ready' ? 'ready' : ''}`} />
          {recording ? `Recording #${recording.channelName}` : bot?.state === 'ready' ? 'Bot online · idle' : bot?.state === 'connecting' ? 'Bot connecting…' : 'Bot off'}
        </div>
      </aside>
      <div className="main">
        <header className="mobile-top">
          <a className="brand" href={href('sessions')}>
            <EyeMark size={24} /> Scrying Eye
          </a>
          {recording && (
            <a className="rec-pill" href={href('record')}>
              REC
            </a>
          )}
        </header>
        <main className="content">
          {page === 'sessions' && !id && <SessionsPage />}
          {page === 'sessions' && id && <SessionPage id={id} />}
          {page === 'settings' && <SettingsPage initial={id} />}
          {page === 'record' && <RecordPage />}
          {!['sessions', 'settings', 'record'].includes(page) && <SessionsPage />}
        </main>
        <nav className="tabbar" aria-label="Main">
          {NAV.map(({ key, label, Icon }) => (
            <a key={key} href={href(key)} className={page === key ? 'on' : ''} aria-current={page === key ? 'page' : undefined}>
              <Icon />
              {label}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

/** The bot's live state, for the sidebar and the phone's REC pill. */
function useBotStatus(): BotStatus | null {
  const [bot, setBot] = useState<BotStatus | null>(null);
  useEffect(() => {
    api<BotStatus>('/bot').then(setBot, () => {});
    return subscribe({ onBot: setBot });
  }, []);
  return bot;
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    auth.set(password);
    try {
      await api('/health');
      onDone();
    } catch (err) {
      auth.clear();
      setError(err instanceof ApiError && err.status === 401 ? 'Wrong password' : `Can't reach the app: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-wrap">
    <form className="card login" onSubmit={submit}>
      <div className="brand" style={{ marginBottom: 16 }}>
        <EyeMark /> Scrying Eye
      </div>
      <label className="field">
        <span className="field-label">Password</span>
        <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <span className="field-hint">Shown in the Mac app under Settings → Keys &amp; phone (or APP_PASSWORD in .env).</span>
      </label>
      {error && <div className="error-box">{error}</div>}
      <button className="primary" disabled={!password || busy} style={{ width: '100%' }}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
    </form>
    </div>
  );
}
