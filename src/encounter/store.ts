import { randomBytes, randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EncounterAction, EncounterOutcome, EncounterState } from '../shared/types.js';
import { applyAction, EncounterError, newEncounter, outcomeOf, type RuleDeps } from './rules.js';

/** Writes JSON so a crash mid-write never leaves a half file (#38). */
function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}

/**
 * The encounter being run, one at a time, kept in <data>/encounters/current.json so it survives
 * an app restart. Ended encounters move to <data>/encounters/history/. Emits "encounter" with
 * the new state (or null when none) after every change.
 */
export class EncounterStore extends EventEmitter {
  private state: EncounterState | null;
  private readonly file: string;

  constructor(
    private readonly dataDir: string,
    private readonly deps: RuleDeps = { now: Date.now, d20: () => randomInt(1, 21) },
    private readonly log: (msg: string) => void = console.log,
  ) {
    super();
    this.file = join(dataDir, 'encounters', 'current.json');
    this.state = this.load();
  }

  private load(): EncounterState | null {
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as EncounterState;
    } catch (err) {
      // A damaged file must not stop the app starting: keep it aside for a look, start fresh.
      const aside = `${this.file}.damaged-${this.deps.now()}`;
      renameSync(this.file, aside);
      this.log(`The saved encounter couldn't be read (${(err as Error).message}); moved it to ${aside}`);
      return null;
    }
  }

  current(): EncounterState | null {
    return this.state;
  }

  private save(next: EncounterState | null) {
    this.state = next;
    if (next) writeJsonAtomic(this.file, next);
    else rmSync(this.file, { force: true });
    this.emit('encounter', next);
  }

  /** Starts a new encounter: a prepared one, or a blank one with this title. Refused while one is running. */
  start(prepared: EncounterState | { title: string }): EncounterState {
    if (this.state && this.state.status !== 'ended') throw new EncounterError(`"${this.state.title}" is still running: end it first`);
    const state = 'combatants' in prepared ? prepared : newEncounter(this.newId(), prepared.title.trim().slice(0, 80) || 'Encounter', this.deps.now());
    this.save(state);
    return state;
  }

  newId(): string {
    return `${new Date(this.deps.now()).toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
  }

  act(action: EncounterAction): EncounterState {
    if (!this.state) throw new EncounterError('No encounter is running');
    const next = applyAction(this.state, action, this.deps);
    this.save(next);
    return next;
  }

  /** Ends the encounter: its summary is kept in history and returned. */
  end(): EncounterOutcome {
    if (!this.state || this.state.status === 'ended') throw new EncounterError('No encounter is running');
    const endedAt = this.deps.now();
    const outcome = outcomeOf(this.state, endedAt);
    const ended: EncounterState = { ...this.state, status: 'ended', endedAt, log: [...this.state.log, { at: endedAt, round: this.state.round, text: 'Encounter ended' }] };
    writeJsonAtomic(join(this.dataDir, 'encounters', 'history', `${ended.id}.json`), { state: ended, outcome });
    this.save(null);
    this.emit('ended', outcome);
    return outcome;
  }
}
