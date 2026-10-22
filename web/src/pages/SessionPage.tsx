import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, downloadFile, subscribeJobs } from '../api';
import { hms, speakerHue, when } from '../format';
import { href } from '../router';
import type { Job, JobStep, SessionDetail, TranscriptLine } from '../types';
import { Badge, Empty, Toggle } from '../ui';
import { RecapCard } from './RecapCard';
import { UnpairedCard } from './UnpairedCard';
import { SessionHeader } from './SessionHeader';

type Tab = 'transcript' | 'speakers' | 'summary';

const STEP_LABEL: Record<JobStep, string> = {
  transcribe: 'Transcribe',
  merge: 'Rebuild transcript',
  disambiguate: 'Label speakers',
  summarize: 'Write recap',
  upload: 'Upload to wiki',
};

export function SessionPage({ id }: { id: string }) {
  const [s, setS] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [force, setForce] = useState(false);

  const load = useCallback(() => {
    api<SessionDetail>(`/sessions/${encodeURIComponent(id)}`).then(
      (d) => {
        setS(d);
        setJobs(d.jobs);
      },
      (e: Error) => setError(e.message),
    );
  }, [id]);
  useEffect(load, [load]);

  // Live job progress; reload the session when one of its jobs finishes.
  useEffect(
    () =>
      subscribeJobs((job) => {
        if (job.sessionId !== id) return;
        setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)].sort((a, b) => b.createdAt - a.createdAt));
        if (job.status === 'done' || job.status === 'failed') load();
      }),
    [id, load],
  );

  const run = async (step: JobStep) => {
    if (step === 'summarize' && s?.recapState === 'edited' && !confirm('Write a new recap? Your edited version is kept in the session folder (summary/edited-…md), but the new recap replaces it here.')) return;
    try {
      const job = await api<Job>(`/sessions/${encodeURIComponent(id)}/jobs`, { method: 'POST', json: { step, force } });
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !s) return <div className="error-box">{error}</div>;
  if (!s) return <p className="muted">Loading…</p>;

  const active = jobs.find((j) => j.status === 'running' || j.status === 'queued');
  const latest = jobs[0];
  const current: Tab = tab ?? (s.summary ? 'summary' : s.speakerLines ? 'speakers' : 'transcript');
  const hasSpeakers = s.speakerLines !== null;

  return (
    <div>
      <a href={href('sessions')} className="small">
        ← Sessions
      </a>
      <SessionHeader
        s={s}
        onChange={(d) => {
          setS(d);
          setJobs(d.jobs);
        }}
        onError={setError}
      />
      {error && <div className="error-box">{error}</div>}

      <div className="card" style={{ marginTop: 14 }}>
        <div className="row">
          {s.has.audio && (
            <button className={s.has.transcript ? '' : 'primary'} disabled={!!active} onClick={() => run('transcribe')}>
              {STEP_LABEL.transcribe}
            </button>
          )}
          {s.has.transcript && (
            <>
              <button disabled={!!active} onClick={() => run('merge')} title="Re-apply speaker names and line joining without calling any API">
                {STEP_LABEL.merge}
              </button>
              <button disabled={!!active} onClick={() => run('disambiguate')} title="Label who's speaking on shared accounts">
                {STEP_LABEL.disambiguate}
              </button>
              <button className={s.has.summary ? '' : 'primary'} disabled={!!active} onClick={() => run('summarize')}>
                {s.has.summary ? 'Rewrite recap' : STEP_LABEL.summarize}
              </button>
            </>
          )}
        </div>
        {s.has.transcript && (
          <div style={{ marginTop: 10 }}>
            <Toggle checked={force} onChange={setForce} label="Redo from scratch" hint="Ignore saved results for labelling, clean-up and the recap (costs API calls again)." />
          </div>
        )}
        {latest && (
          <div>
            <div className="row small">
              <strong>{STEP_LABEL[latest.step]}</strong>
              <Badge tone={latest.status === 'done' ? 'good' : latest.status === 'failed' ? 'bad' : 'accent'}>{latest.status}</Badge>
              {latest.finishedAt && latest.startedAt && <span className="muted">{Math.round((latest.finishedAt - latest.startedAt) / 1000)}s</span>}
            </div>
            {latest.logs.length > 0 && <div className="log">{latest.logs.slice(-40).join('\n')}</div>}
          </div>
        )}
      </div>

      <UnpairedCard s={s} onSaved={(d) => (setS(d), setJobs(d.jobs))} />

      <div className="tabs" role="tablist">
        {(['summary', 'speakers', 'transcript'] as Tab[])
          .filter((t) => t !== 'speakers' || hasSpeakers)
          .map((t) => (
            <button key={t} role="tab" aria-selected={current === t} className={current === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'summary' ? 'Recap' : t === 'speakers' ? 'Speakers labelled' : 'Transcript'}
            </button>
          ))}
      </div>

      {current === 'summary' &&
        (s.summary ? (
          <RecapCard s={{ ...s, summary: s.summary }} busy={active?.step === 'summarize'} uploading={active?.step === 'upload'} onUpload={() => void run('upload')} onSaved={(d) => (setS(d), setJobs(d.jobs))} />
        ) : (
          <Empty title="No recap yet">{s.has.transcript ? 'Press Write recap above.' : 'Transcribe the session first.'}</Empty>
        ))}

      {current === 'speakers' && s.speakerLines && <Transcript lines={s.speakerLines} onDownload={() => downloadFile(s.id, 'transcript.speakers.md')} />}

      {current === 'transcript' &&
        (s.lines.length ? (
          <Transcript lines={s.lines} onDownload={() => downloadFile(s.id, 'transcript.md')} />
        ) : (
          <Empty title="No transcript yet">{s.has.audio ? `${s.utterances} audio clips recorded. Press Transcribe above.` : s.audioDeletedAt ? `The audio was deleted on ${when(s.audioDeletedAt)}.` : 'This session has no audio.'}</Empty>
        ))}
    </div>
  );
}

function Transcript({ lines, onDownload }: { lines: TranscriptLine[]; onDownload: () => void }) {
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const speakers = useMemo(() => [...new Set(lines.map((l) => l.speaker))], [lines]);
  // In campaign sessions lines are named by character; show who plays them.
  const playerOf = useMemo(() => new Map(lines.filter((l) => l.player).map((l) => [l.speaker, l.player!])), [lines]);
  const q = query.trim().toLowerCase();
  const shown = lines.filter((l) => !hidden.has(l.speaker) && (!q || l.text.toLowerCase().includes(q) || l.speaker.toLowerCase().includes(q) || !!l.player?.toLowerCase().includes(q)));
  const labelled = lines.filter((l) => l.inferred);

  return (
    <div className="card">
      <div className="row spread">
        <input type="search" placeholder="Search the transcript" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <button className="link" onClick={onDownload}>
          Download
        </button>
      </div>
      <div className="chips">
        {speakers.map((sp) => (
          <button
            key={sp}
            className={`chip${hidden.has(sp) ? ' off' : ''}`}
            style={{ borderColor: `hsl(${speakerHue(sp)} 55% 55%)` }}
            onClick={() => setHidden((h) => (h.has(sp) ? new Set([...h].filter((x) => x !== sp)) : new Set([...h, sp])))}
          >
            {sp}
            {playerOf.get(sp) && <span className="muted"> ({playerOf.get(sp)})</span>}
          </button>
        ))}
      </div>
      {labelled.length > 0 && (
        <p className="muted small">
          {labelled.length} lines on shared accounts were labelled by Claude: {labelled.filter((l) => l.inferred?.confidence === 'low').length} are guesses (marked ?),{' '}
          {labelled.filter((l) => l.inferred?.confidence === 'unclear').length} unclear.
        </p>
      )}
      <div className="transcript">
        {shown.map((l, i) => (
          <div key={i} className={`line ${l.inferred?.confidence ?? ''}`}>
            <span className="line-time">{hms(l.offsetMs)}</span>
            <span>
              <span className="line-speaker" style={{ color: `hsl(${speakerHue(l.speaker)} 55% 50%)` }}>
                {l.speaker}
              </span>
              {l.inferred?.confidence === 'unclear' && <span className="muted small">(unclear) </span>}
              {l.text}
            </span>
          </div>
        ))}
        {shown.length === 0 && <p className="muted">No lines match.</p>}
      </div>
    </div>
  );
}
