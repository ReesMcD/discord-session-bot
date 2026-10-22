import { useState } from 'react';
import type { Config, DiscordAccount, Effort } from '../../types';

/** Shared by the Settings sections. */
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const ID_RE = /^\d{15,22}$/;
export type SectionProps = { config: Config; update: (f: (c: Config) => void) => void; err: (path: string) => string | undefined };
/** Sections that pick Discord accounts. */
export type AccountProps = SectionProps & { accounts: DiscordAccount[] };

/** How a Discord account reads in Settings: its speakers' names, else the names Discord gave it. */
export function accountLabel(id: string, accounts: DiscordAccount[], config: Config): string {
  const speakers = Object.values(config.speakers)
    .filter((s) => s.discord.includes(id))
    .map((s) => s.name);
  if (speakers.length) return speakers.join(' / ');
  return accounts.find((a) => a.id === id)?.names.join(' / ') ?? 'Discord account';
}

/** The Discord names an account has had, for telling accounts apart. */
export const discordNames = (id: string, accounts: DiscordAccount[]) => accounts.find((a) => a.id === id)?.names.join(' / ') ?? 'Discord account';

/** Pick a Discord account the app has seen (in a recording or a voice channel now), or paste an ID. */
export function AccountPicker({ accounts, exclude, onPick, placeholder }: { accounts: DiscordAccount[]; exclude: string[]; onPick: (id: string) => void; placeholder: string }) {
  const [manual, setManual] = useState('');
  const options = accounts.filter((a) => !exclude.includes(a.id) && !a.bot);
  return (
    <div className="row" style={{ alignItems: 'stretch' }}>
      {options.length > 0 && (
        <select value="" onChange={(e) => e.target.value && onPick(e.target.value)} style={{ flex: '1 1 200px' }}>
          <option value="">{placeholder}</option>
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {a.names.join(' / ')} {a.sessions ? `(${a.sessions} session${a.sessions === 1 ? '' : 's'})` : '(in a voice channel now)'}
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

/** A name box with an Add button, for creating a speaker, campaign or character. */
export function AddByName({ placeholder, onAdd, label = 'Add' }: { placeholder: string; onAdd: (name: string) => void; label?: string }) {
  const [name, setName] = useState('');
  const add = () => {
    if (!name.trim()) return;
    onAdd(name.trim());
    setName('');
  };
  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <input value={name} placeholder={placeholder} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
      <button type="button" className="primary" disabled={!name.trim()} onClick={add}>
        {label}
      </button>
    </div>
  );
}
