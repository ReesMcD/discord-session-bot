import { rosterId } from '../../../../src/shared/ids';
import { href } from '../../router';
import type { Config } from '../../types';
import { Field } from '../../ui';
import { AccountPicker, AddByName, discordNames, type AccountProps } from './shared';

type Speaker = Config['speakers'][string];

/** Rebuilt in a fixed key order so config.yaml reads name, discord, description. */
const tidy = (s: Speaker): Speaker => ({ name: s.name, discord: s.discord, ...(s.description ? { description: s.description } : {}) });

/** The people who talk in sessions, each with the Discord accounts they talk on. */
export function SpeakersSection({ config, update, err, accounts }: AccountProps) {
  const ids = Object.keys(config.speakers);
  const set = (id: string, f: (s: Speaker) => void) =>
    update((c) => {
      const s = c.speakers[id]!;
      f(s);
      c.speakers[id] = tidy(s);
    });
  const remove = (id: string) =>
    update((c) => {
      delete c.speakers[id];
      for (const ch of Object.values(c.characters)) if (ch.speaker === id) delete ch.speaker;
    });
  /** The other speakers on an account: a shared mic. */
  const sharedWith = (id: string, account: string) =>
    Object.entries(config.speakers)
      .filter(([other, s]) => other !== id && s.discord.includes(account))
      .map(([, s]) => s.name);

  return (
    <div>
      <p className="muted small">
        A speaker is someone who talks in your sessions, named as they should appear in transcripts. Link each one to the Discord accounts they talk on. If someone
        sometimes plays from another person's mic, link that account to them too: Claude then works out who said each line on it.
      </p>
      {ids.length === 0 && <p className="muted small">No speakers yet: transcripts use Discord display names.</p>}
      {ids.map((id) => {
        const s = config.speakers[id]!;
        const plays = Object.values(config.characters).filter((ch) => ch.speaker === id);
        return (
          <div className="card" key={id}>
            <div className="grid2">
              <Field label="Name" error={err(`speakers.${id}.name`)}>
                <input value={s.name} onChange={(e) => set(id, (x) => void (x.name = e.target.value))} />
              </Field>
              <Field label="Notes for Claude" hint="Their role or how they talk, e.g. DM, narrates and voices NPCs. Helps on a shared mic." error={err(`speakers.${id}.description`)}>
                <input value={s.description ?? ''} placeholder="e.g. DM" onChange={(e) => set(id, (x) => void (x.description = e.target.value.trim() ? e.target.value : undefined))} />
              </Field>
            </div>
            <span className="field-label">Discord accounts</span>
            {err(`speakers.${id}.discord`) && <div className="field-error">{err(`speakers.${id}.discord`)}</div>}
            {s.discord.length === 0 && <p className="muted small">None yet: link the account (or accounts) they talk on.</p>}
            {s.discord.map((account) => {
              const shared = sharedWith(id, account);
              return (
                <div key={account} className="row spread list-row" style={{ marginBottom: 6 }}>
                  <span>
                    <strong>{discordNames(account, accounts)}</strong> <span className="muted small">{account}</span>
                    {shared.length > 0 && <span className="muted small"> · shared mic with {shared.join(', ')}</span>}
                  </span>
                  <button type="button" className="link danger" onClick={() => set(id, (x) => void (x.discord = x.discord.filter((a) => a !== account)))}>
                    Unlink
                  </button>
                </div>
              );
            })}
            <AccountPicker accounts={accounts} exclude={s.discord} placeholder="Link a Discord account…" onPick={(account) => set(id, (x) => void x.discord.push(account))} />
            <div className="row spread" style={{ marginTop: 10 }}>
              <span className="muted small">
                {plays.length ? `Plays ${plays.map((ch) => ch.name + (ch.campaign && config.campaigns[ch.campaign] ? ` (${config.campaigns[ch.campaign]!.name})` : '')).join(', ')}` : 'Plays no character'} ·{' '}
                <a href={href('settings', 'characters')}>Characters</a>
              </span>
              <button type="button" className="link danger" onClick={() => remove(id)}>
                Remove speaker
              </button>
            </div>
          </div>
        );
      })}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Add a speaker</h2>
        <AddByName placeholder="Their name, e.g. Sam" onAdd={(name) => update((c) => void (c.speakers[rosterId(name, (x) => x in c.speakers)] = { name, discord: [] }))} />
      </div>
    </div>
  );
}
