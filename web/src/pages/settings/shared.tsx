import { useState } from 'react';
import type { Config, Effort, Person } from '../../types';

/** Shared by the Settings sections. */
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const ID_RE = /^\d{15,22}$/;
export type SectionProps = { config: Config; update: (f: (c: Config) => void) => void; err: (path: string) => string | undefined };

export function personLabel(id: string, people: Person[], config: Config): string {
  const alias = config.speakers[id];
  const name = typeof alias === 'string' ? alias : alias?.name;
  const seen = people.find((p) => p.id === id)?.names.join(' / ');
  return name ?? seen ?? 'Unknown user';
}

export function PersonPicker({ people, exclude, onPick, placeholder }: { people: Person[]; exclude: string[]; onPick: (id: string) => void; placeholder: string }) {
  const [manual, setManual] = useState('');
  const options = people.filter((p) => !exclude.includes(p.id));
  return (
    <div className="row" style={{ alignItems: 'stretch' }}>
      {options.length > 0 && (
        <select value="" onChange={(e) => e.target.value && onPick(e.target.value)} style={{ flex: '1 1 200px' }}>
          <option value="">{placeholder}</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.names.join(' / ')} ({p.sessions} session{p.sessions === 1 ? '' : 's'})
            </option>
          ))}
        </select>
      )}
      <div className="row" style={{ flex: '1 1 240px', flexWrap: 'nowrap' }}>
        <input value={manual} inputMode="numeric" placeholder="…or paste a Discord user ID" onChange={(e) => setManual(e.target.value.trim())} />
        <button type="button" disabled={!ID_RE.test(manual) || exclude.includes(manual)} onClick={() => (onPick(manual), setManual(''))}>
          Add
        </button>
      </div>
    </div>
  );
}
