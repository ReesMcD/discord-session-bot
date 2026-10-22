import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, subscribe } from '../api';
import type { MusicLibraryState, MusicStatus, MusicTab, SpotifyStatus } from '../types';
import { ScenesCard, SoundboardCard } from './MusicLibrary';
import { Empty, Toggle } from '../ui';

const QUICK = [
  { label: 'YouTube', url: 'https://www.youtube.com' },
  { label: 'Tabletop Audio', url: 'https://tabletopaudio.com' },
];

/**
 * Music like Kenku FM: web pages in tabs, their sound played into the voice channel by the bot.
 * The browser itself lives in the Mac app; on a phone this page is the remote.
 */
export function MusicPage() {
  const [status, setStatus] = useState<MusicStatus | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [library, setLibrary] = useState<MusicLibraryState>({ scenes: [], sounds: [] });
  useEffect(() => {
    api<MusicStatus>('/music').then(setStatus, (e: Error) => setError(e.message));
    api<MusicLibraryState>('/music/library').then(setLibrary, () => {});
    return subscribe({ onMusic: setStatus });
  }, []);

  const call = async (method: string, path: string, json?: object) => {
    setError('');
    try {
      setStatus(await api<MusicStatus>(path, { method, ...(json ? { json } : {}) }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const open = (target: string) => call('POST', '/music/tabs', { url: target });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) void open(url).then(() => setUrl(''));
  };

  if (!status) return error ? <div className="error-box">{error}</div> : <p className="muted">Loading…</p>;
  if (!status.available)
    return (
      <div>
        <h1>Music</h1>
        <Empty title="Music needs the Mac app">Its built-in browser plays web pages (YouTube, ambience sites…) into the voice channel. Open this page in the Mac app, or from your phone while the Mac app runs.</Empty>
      </div>
    );

  const active = status.tabs.find((t) => t.active);
  return (
    <div>
      <h1>Music</h1>
      <p className="muted small" style={{ marginTop: 0 }}>
        {status.inChannel
          ? 'Playing into the voice channel. Players hear every tab below, mixed.'
          : 'The bot plays music while it’s in a voice channel: start a recording to be heard.'}
      </p>
      {error && <div className="error-box">{error}</div>}

      <div className="music-library">
        <ScenesCard library={library} status={status} onLibrary={setLibrary} onStatus={setStatus} onError={setError} />
        <SoundboardCard library={library} status={status} onLibrary={setLibrary} onStatus={setStatus} onError={setError} />
      </div>

      {status.spotify && <SpotifyCard spotify={status.spotify} onChange={(patch) => call('PATCH', '/music/spotify', patch)} />}

      <form className="card music-open" onSubmit={submit}>
        <label htmlFor="music-url" className="visually-hidden">
          Web address
        </label>
        <input id="music-url" value={url} placeholder="Paste a link: a YouTube video, a playlist, an ambience page…" onChange={(e) => setUrl(e.target.value)} />
        <button className="primary" disabled={!url.trim()}>
          Open
        </button>
        <div className="music-quick">
          {QUICK.map((q) => (
            <button type="button" key={q.url} className="chip" onClick={() => void open(q.url)}>
              {q.label}
            </button>
          ))}
        </div>
      </form>

      {status.tabs.length === 0 ? (
        <Empty title="Nothing playing">Open a page above. Each tab keeps playing in the background, and you can mix them like Kenku FM.</Empty>
      ) : (
        <section className="card">
          <h2 className="eyebrow" style={{ margin: '0 0 8px' }}>
            Tabs
          </h2>
          {status.tabs.map((t) => (
            <TabRow key={t.id} tab={t} onChange={(patch) => call('PATCH', `/music/tabs/${t.id}`, patch)} onClose={() => call('DELETE', `/music/tabs/${t.id}`)} />
          ))}
          <div className="music-master">
            <label className="music-slider">
              <span className="field-label">Master volume</span>
              <input type="range" min={0} max={1} step={0.01} value={status.master} onChange={(e) => void call('PATCH', '/music', { master: e.target.valueAsNumber })} />
            </label>
            <Toggle checked={status.monitor} onChange={(v) => void call('PATCH', '/music', { monitor: v })} label="Also play on this Mac" hint="Capturing a tab silences it here; this plays the mix on the Mac too." />
          </div>
        </section>
      )}

      {window.sessionBot && active && <BrowserArea key={active.id} title={active.title} />}
    </div>
  );
}

/** Spotify Connect: play from the Spotify app to this Mac's speaker and it's mixed in like a tab. */
function SpotifyCard({ spotify, onChange }: { spotify: SpotifyStatus; onChange: (patch: { enabled?: boolean; volume?: number; muted?: boolean }) => void }) {
  const on = spotify.state !== 'off' && spotify.state !== 'missing';
  return (
    <section className="card">
      <div className="row spread">
        <h2 className="eyebrow" style={{ margin: 0 }}>
          Spotify
        </h2>
        {spotify.state !== 'missing' && (
          <button type="button" className="link" onClick={() => onChange({ enabled: !on })}>
            {on ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>
      {spotify.state === 'missing' ? (
        <p className="small" style={{ marginBottom: 0 }}>
          Spotify's web player won't play in the app's browser (it needs DRM), so Scrying Eye plays Spotify as a <strong>Spotify Connect</strong> speaker instead. It
          needs Spotify Premium and one install, in Terminal: <code>brew install librespot</code>. Then reopen this page.
        </p>
      ) : spotify.state === 'off' ? (
        <p className="muted small" style={{ marginBottom: 0 }}>
          Off: “{spotify.device}” doesn't show up in Spotify.
        </p>
      ) : (
        <>
          <p className="small" style={{ margin: '6px 0' }}>
            {spotify.state === 'playing' ? (
              <>
                <span className="eq on" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>{' '}
                Playing{spotify.track ? `: ${spotify.track}` : ''}
              </>
            ) : spotify.state === 'error' ? (
              <span className="bad-text">{spotify.error ?? 'Spotify Connect stopped; it restarts by itself.'}</span>
            ) : (
              <>
                In the Spotify app, tap the devices icon and pick <strong>{spotify.device}</strong>. Play anything: it's mixed in here like a tab.
              </>
            )}
          </p>
          <div className="music-tab">
            <span className="music-tab-text">
              <strong>{spotify.device}</strong>
              <span className="muted small">Spotify Connect</span>
            </span>
            <label className="music-slider">
              <span className="visually-hidden">Spotify volume</span>
              <input type="range" min={0} max={1} step={0.01} value={spotify.volume} disabled={spotify.muted} onChange={(e) => onChange({ volume: e.target.valueAsNumber })} />
            </label>
            <button type="button" onClick={() => onChange({ muted: !spotify.muted })} aria-pressed={spotify.muted}>
              {spotify.muted ? 'Unmute' : 'Mute'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function TabRow({ tab, onChange, onClose }: { tab: MusicTab; onChange: (patch: Partial<MusicTab>) => void; onClose: () => void }) {
  return (
    <div className={`music-tab${tab.active ? ' active' : ''}`}>
      <button type="button" className="music-tab-title" onClick={() => onChange({ active: true })} title="Show this tab">
        <span className={`eq${tab.audible && !tab.muted ? ' on' : ''}`} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="music-tab-text">
          <strong>{tab.title || tab.url}</strong>
          <span className="muted small">{new URL(tab.url).hostname}</span>
        </span>
      </button>
      <label className="music-slider">
        <span className="visually-hidden">Volume for {tab.title}</span>
        <input type="range" min={0} max={1} step={0.01} value={tab.volume} disabled={tab.muted} onChange={(e) => onChange({ volume: e.target.valueAsNumber })} />
      </label>
      <button type="button" onClick={() => onChange({ muted: !tab.muted })} aria-pressed={tab.muted}>
        {tab.muted ? 'Unmute' : 'Mute'}
      </button>
      <button type="button" className="icon danger" onClick={onClose} aria-label={`Close ${tab.title}`}>
        ✕
      </button>
    </div>
  );
}

/** In the Mac app: the active tab's page is drawn by the app over this box, kept in place as it moves. */
function BrowserArea({ title }: { title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const bridge = window.sessionBot;
    if (!el || !bridge) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      const visible = r.bottom > 0 && r.top < window.innerHeight;
      bridge.showMusicTab(visible ? { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: Math.min(r.height, window.innerHeight - Math.max(0, r.top)) } : null);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('scroll', report, { passive: true });
    window.addEventListener('resize', report);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', report);
      window.removeEventListener('resize', report);
      bridge.showMusicTab(null);
    };
  }, []);
  return (
    <section className="music-browser" ref={ref} aria-label={`Browser: ${title}`}>
      <span className="muted small">Loading {title}…</span>
    </section>
  );
}
