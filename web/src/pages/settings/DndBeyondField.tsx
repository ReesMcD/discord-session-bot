import { useEffect, useState } from 'react';
import { parseDndBeyondId } from '../../dndbeyond';

/** A D&D Beyond link or ID: stored as the ID, shown as a link once set. */
export function DndBeyondField({ label, value, url, onChange, error, compact }: { label: string; value: number | undefined; url: (id: number) => string; onChange: (id: number | undefined) => void; error?: string | undefined; compact?: boolean }) {
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => setText(value ? String(value) : ''), [value]);
  const invalid = text.trim() !== '' && parseDndBeyondId(text) === undefined;
  return (
    <label className={compact ? 'roster-field' : `field${error || invalid ? ' has-error' : ''}`}>
      <span className="field-label">
        {label}
        {value ? (
          <>
            {' '}
            <a href={url(value)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              open
            </a>
          </>
        ) : null}
      </span>
      <input
        value={text}
        placeholder="link or ID"
        onChange={(e) => {
          setText(e.target.value);
          const id = parseDndBeyondId(e.target.value);
          if (id !== undefined || !e.target.value.trim()) onChange(id);
        }}
      />
      {!compact && <span className="field-hint">Paste the D&D Beyond link.</span>}
      {(error || invalid) && <span className="field-error">{error ?? 'Not a D&D Beyond link or ID'}</span>}
    </label>
  );
}
