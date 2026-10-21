import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, subscribe } from '../api';
import { hms, speakerHue } from '../format';
import type { LiveSnapshot } from '../types';

/**
 * Lines transcribed during the recording, newest at the bottom. It follows new lines unless you
 * scrolled up to read; a search narrows it down ("what was that NPC called?").
 */
export function LiveTranscript({ sessionId }: { sessionId: string }) {
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useEffect(() => {
    api<LiveSnapshot>('/bot/live').then(setLive, () => {});
    // Events carry only new lines; the first load (above) has everything before them.
    return subscribe({
      onLive: (u) =>
        u.sessionId === sessionId &&
        setLive((prev) => (prev?.sessionId === sessionId ? { sessionId, lines: [...prev.lines, ...u.added].sort((a, b) => a.startMs - b.startMs), ...(u.error ? { error: u.error } : {}) } : prev)),
    });
  }, [sessionId]);

  const q = query.trim().toLowerCase();
  const lines = (live?.sessionId === sessionId ? live.lines : []).filter(
    (l) => !q || l.text.toLowerCase().includes(q) || l.speaker.toLowerCase().includes(q) || !!l.player?.toLowerCase().includes(q),
  );

  useLayoutEffect(() => {
    const el = box.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <section className="card live-transcript" aria-label="Live transcript">
      <div className="row spread">
        <h2 className="eyebrow" style={{ margin: 0 }}>
          Live transcript
        </h2>
        <span className="muted small">a preview; the full transcript follows after Stop</span>
      </div>
      {live?.error && <p className="small bad-text">{live.error}</p>}
      <input type="search" placeholder="Search what's been said" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div
        className="transcript live-lines"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        role="log"
      >
        {lines.map((l, i) => (
          <div key={`${l.startMs}-${l.userId}-${i}`} className="line">
            <span className="line-time">{hms(l.offsetMs)}</span>
            <span>
              <span className="line-speaker" style={{ color: `hsl(${speakerHue(l.speaker)} 55% 50%)` }}>
                {l.speaker}
              </span>
              {l.text}
            </span>
          </div>
        ))}
        {lines.length === 0 && <p className="muted small">{q ? 'No lines match.' : 'Lines appear here a few seconds after they’re spoken.'}</p>}
      </div>
    </section>
  );
}
