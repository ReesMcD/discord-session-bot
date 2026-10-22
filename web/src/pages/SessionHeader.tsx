import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { duration, when } from '../format';
import { href } from '../router';
import type { ConfigState, SessionDetail } from '../types';

/** The session's name and campaign, both changeable after the fact, and Delete. */
export function SessionHeader({ s, onChange, onError }: { s: SessionDetail; onChange: (d: SessionDetail) => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [campaigns, setCampaigns] = useState<Array<{ key: string; name: string }>>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    api<ConfigState>('/config').then(
      (c) => setCampaigns(Object.entries(c.config?.campaigns ?? {}).map(([key, k]) => ({ key, name: k.name ?? `Unnamed campaign (${key})` }))),
      () => {},
    );
  }, []);

  const patch = async (change: { title?: string | null; campaign?: string | null }) => {
    try {
      onChange(await api<SessionDetail>(`/sessions/${encodeURIComponent(s.id)}`, { method: 'PATCH', json: change }));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void patch({ title: title.trim() || null }).then(() => setEditing(false));
  };
  const remove = async () => {
    try {
      await api(`/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      window.location.hash = href('sessions');
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="session-header">
      {editing ? (
        <form className="row" onSubmit={save} style={{ margin: '6px 0' }}>
          <label htmlFor="session-title" className="visually-hidden">
            Session name
          </label>
          <input id="session-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <button className="primary">Save</button>
          {s.customTitle && (
            <button type="button" onClick={() => void patch({ title: null }).then(() => setEditing(false))} title="Name it from the template again (Settings → Campaigns)">
              Use default
            </button>
          )}
          <button type="button" onClick={() => (setTitle(s.title), setEditing(false))}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="row" style={{ alignItems: 'baseline' }}>
          <h1 style={{ marginTop: 6 }}>{s.title}</h1>
          <button className="link" onClick={() => (setTitle(s.title), setEditing(true))}>
            Rename
          </button>
        </div>
      )}
      <div className="muted small">
        {when(s.startedAt)}
        {s.stoppedAt && ` · ${duration(s.stoppedAt - s.startedAt)}`}
        {s.channelName && ` · #${s.channelName}`}
        {s.guildName && ` · ${s.guildName}`} · <code>{s.id}</code>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <label htmlFor="session-campaign" className="small muted">
          Campaign
        </label>
        <select
          id="session-campaign"
          style={{ width: 'auto', minWidth: 180 }}
          value={s.campaign?.picked ? s.campaign.key : ''}
          onChange={(e) => void patch({ campaign: e.target.value || null })}
        >
          <option value="">{s.campaign && !s.campaign.picked ? `${s.campaign.name ?? 'Its channel’s'} (from its voice channel)` : 'None (from its voice channel)'}</option>
          {campaigns.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
        <button className="danger" onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))} onBlur={() => setConfirmDelete(false)} style={{ marginLeft: 'auto' }}>
          {confirmDelete ? 'Tap again: move to trash' : 'Delete'}
        </button>
      </div>
      {confirmDelete && <p className="small muted">It’s kept in the trash for 30 days (the data folder’s trash/), then deleted.</p>}
    </div>
  );
}
