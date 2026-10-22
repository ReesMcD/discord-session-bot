import type { MusicStatus } from '../shared/types.js';

export type { MusicStatus, MusicTab, SpotifyStatus } from '../shared/types.js';

/** What the API needs from the Mac app's music browser (a fake implements it in tests). */
export interface MusicControl {
  status(): MusicStatus;
  openTab(url: string): string;
  closeTab(id: string): void;
  updateTab(id: string, patch: { volume?: number; muted?: boolean; active?: boolean }): void;
  update(patch: { master?: number; monitor?: boolean }): void;
  /**
   * Switches to a scene: its tabs fade in over `fadeMs` while the other tabs fade out and close. A
   * tab already open on the same page stays and fades to its scene volume.
   */
  playScene(tabs: { url: string; volume: number }[], fadeMs: number): void;
  /** Plays an audio file once over the music. */
  playSound(id: string, audio: Uint8Array, volume: number): void;
  stopSounds(): void;
  /** Spotify Connect: turn the speaker on or off, and its volume in the mix. */
  updateSpotify(patch: { enabled?: boolean; volume?: number; muted?: boolean }): void;
  on(event: 'status', listener: (s: MusicStatus) => void): unknown;
  off(event: 'status', listener: (s: MusicStatus) => void): unknown;
}

/** A page address from what someone typed: "tabletopaudio.com" → "https://tabletopaudio.com". */
export function normalizeUrl(input: string): string {
  const text = input.trim();
  if (!text) throw new Error('Type a web address');
  const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only web pages (http or https) can be opened');
  return url.toString();
}
