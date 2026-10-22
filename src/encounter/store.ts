import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EncounterAction, EncounterOutcome, EncounterState, JoinedPlayer, PlayerRequest } from '../shared/types.js';
import { playerAction } from '../play/view.js';
import { applyAction, EncounterError, newEncounter, outcomeOf, type RuleDeps } from './rules.js';

/** A secret for a link or a device: 128 random bits, URL-safe. */
const secret = () => randomBytes(16).toString('base64url');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

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
    const base = 'combatants' in prepared ? prepared : newEncounter(this.newId(), prepared.title.trim().slice(0, 80) || 'Encounter', this.deps.now());
    const state: EncounterState = { ...base, join: { code: secret(), players: [] } };
    this.save(state);
    return state;
  }

  // --- Players (the public join link, #47) ------------------------------------------------------

  /** The running encounter, if `code` is its join code (compared in constant time). */
  private byCode(code: string): EncounterState | null {
    const s = this.state;
    return s?.join && s.status !== 'ended' && sameSecret(s.join.code, code) ? s : null;
  }

  /** Whether `code` opens the encounter running now. */
  isOpen(code: string): boolean {
    return !!this.byCode(code);
  }

  /** A device joins, as a PC (one device each) or as a guest; it gets a token only it knows. */
  join(code: string, combatantId: string | null): { token: string; state: EncounterState } {
    const s = this.byCode(code);
    if (!s?.join) throw new EncounterError('This link has expired');
    if (combatantId !== null) {
      if (!s.combatants.some((c) => c.id === combatantId && c.kind === 'pc')) throw new EncounterError('No such character');
      if (s.join.players.some((p) => p.combatantId === combatantId)) throw new EncounterError('Someone already plays that character: ask the DM for a new link if that was you on another device');
    }
    const token = secret();
    const player: JoinedPlayer = { tokenHash: hash(token), combatantId, joinedAt: this.deps.now() };
    const next = { ...s, join: { ...s.join, players: [...s.join.players, player] } };
    this.save(next);
    return { token, state: next };
  }

  /** The player a device token belongs to, if the code is still open. */
  player(code: string, token: string): { state: EncounterState; player: JoinedPlayer } | null {
    const s = this.byCode(code);
    const tokenHash = hash(token);
    const player = s?.join?.players.find((p) => sameSecret(p.tokenHash, tokenHash));
    return s && player ? { state: s, player } : null;
  }

  /** A player's change to their own PC. */
  playerAct(code: string, token: string, request: PlayerRequest): EncounterState {
    const found = this.player(code, token);
    if (!found) throw new EncounterError('This link has expired');
    return this.act(playerAction(found.state, found.player.combatantId, request));
  }

  /** A fresh link: the old one stops working and everyone joins again. */
  newJoinLink(): EncounterState {
    if (!this.state || this.state.status === 'ended') throw new EncounterError('No encounter is running');
    const next = { ...this.state, join: { code: secret(), players: [] } };
    this.save(next);
    return next;
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
