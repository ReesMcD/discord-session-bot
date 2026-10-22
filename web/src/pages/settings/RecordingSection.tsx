import { Field, NumberInput, Segmented, Toggle } from '../../ui';
import { AccountPicker, accountLabel, type AccountProps } from './shared';

/** What gets recorded, and what happens when a recording stops. */
export function RecordingSection({ config, update, err, accounts }: AccountProps) {
  return (
    <div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Never record</h2>
        <Toggle checked={config.recording.ignore_bots} onChange={(v) => update((c) => void (c.recording.ignore_bots = v))} label="Ignore all bots" hint="Music bots and other bot accounts are never recorded." />
        {config.recording.ignore_users.map((id) => (
          <div key={id} className="row spread list-row" style={{ marginBottom: 6 }}>
            <span>
              <strong>{accountLabel(id, accounts, config)}</strong> <span className="muted small">{id}</span>
            </span>
            <button className="danger" onClick={() => update((c) => void (c.recording.ignore_users = c.recording.ignore_users.filter((x) => x !== id)))}>
              Remove
            </button>
          </div>
        ))}
        <AccountPicker accounts={accounts} exclude={config.recording.ignore_users} placeholder="Add someone to ignore…" onPick={(id) => update((c) => void c.recording.ignore_users.push(id))} />
        {err('recording.ignore_users') && <div className="field-error">{err('recording.ignore_users')}</div>}
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
