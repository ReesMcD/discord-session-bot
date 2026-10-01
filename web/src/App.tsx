import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, auth } from './api';
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

  const [page = 'sessions', id] = route;
  const nav = [
    { key: 'record', label: 'Record' },
    { key: 'sessions', label: 'Sessions' },
    { key: 'settings', label: 'Settings' },
  ];
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href('sessions')} style={{ color: 'inherit' }}>
          <span className="brand-dot" /> Session Bot
        </a>
        <nav className="nav">
          {nav.map((n) => (
            <a key={n.key} href={href(n.key)} className={page === n.key ? 'on' : ''}>
              {n.label}
            </a>
          ))}
        </nav>
      </header>
      {page === 'sessions' && !id && <SessionsPage />}
      {page === 'sessions' && id && <SessionPage id={id} />}
      {page === 'settings' && <SettingsPage initial={id} />}
      {page === 'record' && <RecordPage />}
      {!['sessions', 'settings', 'record'].includes(page) && <SessionsPage />}
    </div>
  );
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
    <form className="card login" onSubmit={submit}>
      <div className="brand" style={{ marginBottom: 12 }}>
        <span className="brand-dot" /> Session Bot
      </div>
      <label className="field">
        <span className="field-label">Password</span>
        <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <span className="field-hint">APP_PASSWORD from the .env file on the Mac.</span>
      </label>
      {error && <div className="error-box">{error}</div>}
      <button className="primary" disabled={!password || busy} style={{ width: '100%' }}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
    </form>
  );
}
