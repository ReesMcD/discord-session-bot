import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { MusicLibraryState, MusicScene, MusicSound, MusicStatus } from '../types';
import { Segmented } from '../ui';

const FADES = [
  { value: '0', label: 'Cut' },
  { value: '3', label: '3 s' },
  { value: '8', label: '8 s' },
] as const;
type Fade = (typeof FADES)[number]['value'];

function savedFade(): Fade {
  try {
    const v = localStorage.getItem('music-fade');
    return FADES.some((f) => f.value === v) ? (v as Fade) : '3';
  } catch {
    return '3';
  }
}

interface Props {
  library: MusicLibraryState;
  status: MusicStatus;
  onLibrary: (l: MusicLibraryState) => void;
  onStatus: (s: MusicStatus) => void;
  onError: (message: string) => void;
}

/** Runs a request, passing its result on and any error up. */
async function attempt<T>(request: Promise<T>, then: (value: T) => void, onError: (m: string) => void): Promise<boolean> {
  try {
    then(await request);
    return true;
  } catch (e) {
    onError((e as Error).message);
    return false;
  }
}

/** Whether the open tabs are exactly this scene's pages. */
function isCurrent(scene: MusicScene, status: MusicStatus): boolean {
  const open = status.tabs.map((t) => t.url).sort();
  const wanted = scene.tabs.map((t) => t.url).sort();
  return open.length > 0 && JSON.stringify(open) === JSON.stringify(wanted);
}

/** Saved sets of tabs: one tap crossfades to a scene. */
export function ScenesCard({ library, status, onLibrary, onStatus, onError }: Props) {
  const [fade, setFade] = useState<Fade>(savedFade);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const changeFade = (v: Fade) => {
    setFade(v);
    try {
      localStorage.setItem('music-fade', v);
    } catch {
      /* private mode: not remembered */
    }
  };
  const play = (scene: MusicScene) => void attempt(api<MusicStatus>(`/music/scenes/${scene.id}/play`, { method: 'POST', json: { fadeSeconds: Number(fade) } }), onStatus, onError);
  const change = (path: string, method: string, json?: object) => attempt(api<MusicLibraryState>(path, { method, ...(json ? { json } : {}) }), onLibrary, onError);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await change('/music/scenes', 'POST', { name })) setName('');
  };

  return (
    <section className="card">
      <div className="row spread">
        <h2 className="eyebrow" style={{ margin: 0 }}>
          Scenes
        </h2>
        <div className="row">
          <span className="muted small">Fade</span>
          <Segmented value={fade} options={FADES.map((f) => ({ ...f }))} onChange={changeFade} />
          {library.scenes.length > 0 && (
            <button type="button" className="link" onClick={() => setEditing((v) => !v)} aria-pressed={editing}>
              {editing ? 'Done' : 'Edit'}
            </button>
          )}
        </div>
      </div>
      {library.scenes.length === 0 ? (
        <p className="muted small">Open the pages for a mood (tavern noise, a combat playlist…), set their volumes, then save them as a scene. Switching scenes crossfades.</p>
      ) : (
        <div className="pad-grid">
          {library.scenes.map((scene) =>
            editing ? (
              <div key={scene.id} className="pad editing">
                <strong>{scene.name}</strong>
                <span className="muted small">
                  {scene.tabs.length} tab{scene.tabs.length === 1 ? '' : 's'}
                </span>
                <div className="row">
                  <button type="button" onClick={() => {
                    const next = window.prompt('Scene name', scene.name);
                    if (next?.trim()) void change(`/music/scenes/${scene.id}`, 'PATCH', { name: next });
                  }}>
                    Rename
                  </button>
                  <button type="button" disabled={!status.tabs.length} title="Replace its tabs with the ones open now" onClick={() => void change(`/music/scenes/${scene.id}`, 'PATCH', { fromCurrent: true })}>
                    Use open tabs
                  </button>
                  <button type="button" className="danger" onClick={() => window.confirm(`Delete the scene "${scene.name}"?`) && void change(`/music/scenes/${scene.id}`, 'DELETE')}>
                    Delete
                  </button>
                </div>
              </div>
            ) : (
              <button key={scene.id} type="button" className={`pad${isCurrent(scene, status) ? ' on' : ''}`} onClick={() => play(scene)}>
                <strong>{scene.name}</strong>
                <span className="small">
                  {scene.tabs.length} tab{scene.tabs.length === 1 ? '' : 's'}
                </span>
              </button>
            ),
          )}
        </div>
      )}
      <form className="row add-row" onSubmit={save}>
        <label htmlFor="scene-name" className="visually-hidden">
          Scene name
        </label>
        <input id="scene-name" value={name} placeholder={status.tabs.length ? 'Name the open tabs as a scene, e.g. Tavern' : 'Open some tabs to save a scene'} disabled={!status.tabs.length} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name.trim() || !status.tabs.length}>Save scene</button>
      </form>
    </section>
  );
}

/** One-shot sound effects played over the music. */
export function SoundboardCard({ library, status, onLibrary, onStatus, onError }: Props) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const playing = new Set(status.playingSounds);
  const change = (path: string, method: string, json?: object) => attempt(api<MusicLibraryState>(path, { method, ...(json ? { json } : {}) }), onLibrary, onError);
  const play = (sound: MusicSound) => void attempt(api<MusicStatus>(`/music/sounds/${sound.id}/play`, { method: 'POST' }), onStatus, onError);

  return (
    <section className="card">
      <div className="row spread">
        <h2 className="eyebrow" style={{ margin: 0 }}>
          Soundboard
        </h2>
        <div className="row">
          {playing.size > 0 && (
            <button type="button" onClick={() => void attempt(api<MusicStatus>('/music/sounds/stop', { method: 'POST' }), onStatus, onError)}>
              Stop sounds
            </button>
          )}
          {library.sounds.length > 0 && (
            <button type="button" className="link" onClick={() => setEditing((v) => !v)} aria-pressed={editing}>
              {editing ? 'Done' : 'Edit'}
            </button>
          )}
        </div>
      </div>
      {library.sounds.length === 0 && !adding && <p className="muted small">Short effects (a door slam, a dragon's roar) that play once over the music. Add an audio file or a link to one.</p>}
      {library.sounds.length > 0 && (
        <div className="pad-grid">
          {library.sounds.map((sound) =>
            editing ? (
              <div key={sound.id} className="pad editing">
                <strong>{sound.name}</strong>
                <label className="music-slider">
                  <span className="visually-hidden">Volume for {sound.name}</span>
                  <input type="range" min={0} max={1} step={0.01} defaultValue={sound.volume} onChange={(e) => void change(`/music/sounds/${sound.id}`, 'PATCH', { volume: e.target.valueAsNumber })} />
                </label>
                <div className="row">
                  <button type="button" onClick={() => play(sound)}>
                    Try
                  </button>
                  <button type="button" onClick={() => {
                    const next = window.prompt('Sound name', sound.name);
                    if (next?.trim()) void change(`/music/sounds/${sound.id}`, 'PATCH', { name: next });
                  }}>
                    Rename
                  </button>
                  <button type="button" className="danger" onClick={() => window.confirm(`Delete "${sound.name}"?`) && void change(`/music/sounds/${sound.id}`, 'DELETE')}>
                    Delete
                  </button>
                </div>
              </div>
            ) : (
              <button key={sound.id} type="button" className={`pad sound${playing.has(sound.id) ? ' on' : ''}`} onClick={() => play(sound)}>
                <strong>{sound.name}</strong>
              </button>
            ),
          )}
        </div>
      )}
      {adding ? (
        <AddSound onAdded={(l) => (onLibrary(l), setAdding(false))} onCancel={() => setAdding(false)} onError={onError} />
      ) : (
        <button type="button" className="add-row" onClick={() => setAdding(true)}>
          Add a sound
        </button>
      )}
    </section>
  );
}

function AddSound({ onAdded, onCancel, onError }: { onAdded: (l: MusicLibraryState) => void; onCancel: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const request = file
      ? api<MusicLibraryState>(`/music/sounds?name=${encodeURIComponent(name)}&file=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          body: file,
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
        })
      : api<MusicLibraryState>('/music/sounds', { method: 'POST', json: { name, url: link } });
    await attempt(request, onAdded, onError);
    setBusy(false);
  };
  return (
    <form className="add-sound" onSubmit={submit}>
      <label className="field-label" htmlFor="sound-name">
        Name
      </label>
      <input id="sound-name" value={name} placeholder="e.g. Door slam" onChange={(e) => setName(e.target.value)} />
      <label className="field-label" htmlFor="sound-file">
        Audio file
      </label>
      <input id="sound-file" type="file" accept="audio/*" onChange={(e) => (setFile(e.target.files?.[0] ?? null), setLink(''))} />
      <label className="field-label" htmlFor="sound-link">
        …or a link to one
      </label>
      <input id="sound-link" type="url" inputMode="url" value={link} disabled={!!file} placeholder="https://…/roar.mp3" onChange={(e) => setLink(e.target.value)} />
      <div className="row">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={busy || !name.trim() || (!file && !link.trim())}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </form>
  );
}
