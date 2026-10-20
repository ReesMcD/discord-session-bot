import type { Person, SharedSpeaker } from '../../types';
import { Field, ListEditor, NumberInput, Segmented, Toggle } from '../../ui';
import { personLabel, PersonPicker, type SectionProps } from './shared';

export function PeopleSection({ config, update, err, people }: SectionProps & { people: Person[] }) {
  const speakerIds = Object.keys(config.speakers);
  return (
    <div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Never record</h2>
        <Toggle checked={config.recording.ignore_bots} onChange={(v) => update((c) => void (c.recording.ignore_bots = v))} label="Ignore all bots" hint="Music bots and other bot accounts are never recorded." />
        {config.recording.ignore_users.map((id) => (
          <div key={id} className="row spread list-row" style={{ marginBottom: 6 }}>
            <span>
              <strong>{personLabel(id, people, config)}</strong> <span className="muted small">{id}</span>
            </span>
            <button className="danger" onClick={() => update((c) => void (c.recording.ignore_users = c.recording.ignore_users.filter((x) => x !== id)))}>
              Remove
            </button>
          </div>
        ))}
        <PersonPicker people={people} exclude={config.recording.ignore_users} placeholder="Add someone to ignore…" onPick={(id) => update((c) => void c.recording.ignore_users.push(id))} />
        {err('recording.ignore_users') && <div className="field-error">{err('recording.ignore_users')}</div>}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Speakers</h2>
        <p className="muted small">
          The name each person gets in transcripts. Turn on <strong>Shared account</strong> when several people talk through one Discord account (or one person plays
          several roles), and list who. Claude will label each line before writing the recap.
        </p>
        {speakerIds.length === 0 && <p className="muted small">No names set: transcripts use Discord display names.</p>}
        {speakerIds.map((id) => {
          const v = config.speakers[id]!;
          const shared = typeof v !== 'string' && !!v.disambiguate;
          const name = typeof v === 'string' ? v : (v.name ?? '');
          const setValue = (next: string | SharedSpeaker) => update((c) => void (c.speakers[id] = next));
          return (
            <div key={id} className="card" style={{ background: 'var(--surface-2)' }}>
              <div className="row spread">
                <span className="muted small">
                  {people.find((p) => p.id === id)?.names.join(' / ') ?? 'Discord user'} · {id}
                </span>
                <button className="link danger" onClick={() => update((c) => void delete c.speakers[id])}>
                  Remove
                </button>
              </div>
              <Field label="Name in transcripts" error={err(`speakers.${id}`)}>
                <input value={name} onChange={(e) => setValue(shared ? { ...(v as SharedSpeaker), name: e.target.value } : e.target.value)} />
              </Field>
              <Toggle
                checked={shared}
                onChange={(on) => setValue(on ? { name: name || undefined, disambiguate: ['DM — narrates the world and voices NPCs', 'Player character — a character this person plays'] } : name)}
                label="Shared account"
                hint="Several people or roles on this one account."
              />
              {shared && (
                <Field label="Who talks on this account" hint='One per line: "Label — description". The label is used in transcripts; the description helps Claude tell them apart.' error={err(`speakers.${id}.disambiguate`)}>
                  <ListEditor items={(v as SharedSpeaker).disambiguate ?? []} onChange={(list) => setValue({ ...(v as SharedSpeaker), disambiguate: list })} placeholder="e.g. Hamqueef — a half-orc bard played by Rees" />
                </Field>
              )}
            </div>
          );
        })}
        <PersonPicker people={people} exclude={speakerIds} placeholder="Add a speaker…" onPick={(id) => update((c) => void (c.speakers[id] = people.find((p) => p.id === id)?.names[0] ?? 'Name'))} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Recording</h2>
        <Field label="When a recording stops">
          <Segmented
            value={config.recording.after_stop}
            options={[
              { value: 'nothing', label: 'Do nothing' },
              { value: 'transcribe', label: 'Transcribe' },
              { value: 'summarize', label: 'Transcribe + recap' },
            ]}
            onChange={(v) => update((c) => void (c.recording.after_stop = v))}
          />
        </Field>
        <Toggle
          checked={config.recording.announce}
          onChange={(v) => update((c) => void (c.recording.announce = v))}
          label="Announce in the channel"
          hint="Posts “Recording started/stopped” in the voice channel's chat so everyone knows."
        />
        <div className="grid2">
          <Field label="End an utterance after (ms of silence)" error={err('recording.silence_ms')}>
            <NumberInput value={config.recording.silence_ms} min={200} max={10000} step={100} onChange={(v) => update((c) => void (c.recording.silence_ms = v))} />
          </Field>
          <Field label="Keep audio for (days)" hint="Then the audio of transcribed sessions is deleted; transcripts and recaps stay. 0 = forever." error={err('recording.audio_retention_days')}>
            <NumberInput value={config.recording.audio_retention_days} min={0} onChange={(v) => update((c) => void (c.recording.audio_retention_days = v))} />
          </Field>
        </div>
      </div>
    </div>
  );
}
