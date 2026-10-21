import { useState } from 'react';
import { api, downloadFile } from '../api';
import { copyText } from '../clipboard';
import { when } from '../format';
import { Markdown } from '../Markdown';
import { appendToSection, sectionsOf, splitHeader, splitSections, takeKillCount } from '../recap';
import type { SessionDetail } from '../types';
import { Badge } from '../ui';

const DEFAULT_SECTIONS = ['NPCs', 'Locations', 'What happened', 'Combat'];

/** The recap: read, copy, add a note to a section, or edit the Markdown. */
export function RecapCard({
  s,
  onSaved,
  busy,
  uploading,
  onUpload,
}: {
  s: SessionDetail & { summary: string };
  onSaved: (d: SessionDetail) => void;
  busy: boolean;
  uploading: boolean;
  onUpload: () => void;
}) {
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState(false);
  const [note, setNote] = useState('');
  const [section, setSection] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmUpload, setConfirmUpload] = useState(false);

  const { body } = splitHeader(s.summary);
  const sections = [...new Set([...sectionsOf(s.summary), ...DEFAULT_SECTIONS])];
  const target = section || sections[0]!;
  const flash = (msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus(''), 2500);
  };

  const save = async (markdown: string) => {
    setSaving(true);
    setError('');
    try {
      onSaved(await api<SessionDetail>(`/sessions/${encodeURIComponent(s.id)}/summary`, { method: 'PUT', json: { markdown } }));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await copyText(body);
      flash('Copied');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addNote = async () => {
    if (await save(appendToSection(s.summary, target, note))) {
      setNote('');
      flash(`Added to ${target}`);
    }
  };

  const meta = s.summaryMeta;
  const n = meta?.notes;
  return (
    <div>
      <div className="row spread recap-toolbar">
        <span className="muted small">
          {s.recapState === 'edited' ? <Badge tone="accent">edited{s.editedAt ? ` ${when(Date.parse(s.editedAt))}` : ''}</Badge> : <Badge>generated</Badge>}{' '}
          {n && `${n.npcs} NPC · ${n.locations} location · ${n.combats} fight notes`}
          {meta?.cleanup && ` · clean-up: ${meta.cleanup.edited} fixed${meta.cleanup.reverted ? `, ${meta.cleanup.reverted} reverted` : ''}`}
          {meta?.recapAudit && meta.recapAudit.missing > 0 && ` · check added ${meta.recapAudit.missing}`}
        </span>
        <div className="row">
          {status && <span className="small" role="status">{status}</span>}
          {mode === 'read' && (
            <>
              <button onClick={copy}>Copy</button>
              <button onClick={() => (setDraft(s.summary), setPreview(false), setMode('edit'))} disabled={busy}>
                Edit
              </button>
              <button className="link" onClick={() => downloadFile(s.id, 'summary.md')}>
                Download
              </button>
              {s.uploadTo && (
                <button className={s.upload && !s.upload.changedSince ? '' : 'primary'} disabled={busy || uploading} onClick={() => setConfirmUpload(true)}>
                  {uploading ? 'Uploading…' : s.upload ? 'Upload again' : 'Upload to wiki'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {error && <div className="error-box">{error}</div>}
      {s.upload && mode === 'read' && <UploadLine upload={s.upload} />}
      {confirmUpload && mode === 'read' && (
        <div className="card upload-confirm" role="dialog" aria-label="Upload the recap">
          <span>
            Send this recap{s.recapState === 'edited' ? ', with your edits,' : ''} to <strong>{s.uploadTo}</strong>?
            {s.upload && !s.upload.changedSince && <span className="muted"> It hasn't changed since the last upload.</span>}
          </span>
          <div className="row">
            <button onClick={() => setConfirmUpload(false)}>Cancel</button>
            <button className="primary" onClick={() => (setConfirmUpload(false), onUpload())}>
              Upload
            </button>
          </div>
        </div>
      )}

      {mode === 'edit' ? (
        <div className="card">
          <div className="row spread" style={{ marginBottom: 8 }}>
            <div className="segmented" role="radiogroup">
              <button type="button" role="radio" aria-checked={!preview} className={preview ? '' : 'on'} onClick={() => setPreview(false)}>
                Markdown
              </button>
              <button type="button" role="radio" aria-checked={preview} className={preview ? 'on' : ''} onClick={() => setPreview(true)}>
                Preview
              </button>
            </div>
            <div className="row">
              <button onClick={() => setMode('read')} disabled={saving}>
                Discard
              </button>
              <button className="primary" disabled={saving || draft === s.summary || !draft.trim()} onClick={async () => (await save(draft)) && (setMode('read'), flash('Saved'))}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
          {preview ? <Markdown source={splitHeader(draft).body} /> : <textarea className="recap-editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck />}
        </div>
      ) : (
        <>
          {splitSections(body).map((section, i) => (
            <RecapSectionCard key={`${section.title}-${i}`} title={section.title} body={section.body} />
          ))}
          <div className="add-note card">
            <select value={target} onChange={(e) => setSection(e.target.value)} aria-label="Section">
              {sections.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <input
              value={note}
              placeholder="Add a note to this section…"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && note.trim() && !saving && (e.preventDefault(), void addNote())}
            />
            <button onClick={addNote} disabled={!note.trim() || saving || busy}>
              Add
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** "Uploaded 5 min ago · Open page", flagged when the recap changed since. */
function UploadLine({ upload }: { upload: NonNullable<SessionDetail['upload']> }) {
  return (
    <div className="row small upload-line">
      <span className="muted">Uploaded {when(Date.parse(upload.uploadedAt))}</span>
      {upload.changedSince && <Badge tone="warn">edited since</Badge>}
      {upload.url && (
        <a href={upload.url} target="_blank" rel="noreferrer">
          Open page ↗
        </a>
      )}
    </div>
  );
}

/** One recap section as a card; Combat's kill count becomes pills. */
function RecapSectionCard({ title, body }: { title: string; body: string }) {
  const { rest, kills } = takeKillCount(body);
  return (
    <section className="card recap-section">
      {title && <h2 className="recap-heading">{title}</h2>}
      {rest && <Markdown source={rest} />}
      {kills.length > 0 && (
        <div className="kill-pills" aria-label="Kill count">
          <span className="eyebrow">Kills</span>
          {kills.map(([name, n]) => (
            <span key={name} className="badge gold">
              {name} · {n}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
