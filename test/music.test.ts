import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import prism from 'prism-media';
import { createApi } from '../src/app/api.js';
import { ConfigStore } from '../src/app/configStore.js';
import { JobRunner } from '../src/app/jobs.js';
import { normalizeUrl, type MusicControl, type MusicStatus, type MusicTab } from '../src/music/control.js';
import { opusPacketSamples } from '../src/audio/opus.js';
import { FRAME_BYTES, FRAME_SAMPLES, MusicBroadcast } from '../src/music/broadcast.js';
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from '../src/music/pcmWorklet.js';

function sine(frames: number): Buffer {
  const pcm = Buffer.alloc(FRAME_BYTES * frames);
  for (let i = 0; i < FRAME_SAMPLES * frames; i++) {
    const v = Math.round(Math.sin((i / 48_000) * 2 * Math.PI * 440) * 8000);
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  return pcm;
}

test('the encoder turns 20 ms PCM frames into Discord-sized Opus packets', async () => {
  const encoder = new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: FRAME_SAMPLES });
  const packets: Buffer[] = [];
  encoder.on('data', (p: Buffer) => packets.push(p));
  encoder.write(sine(5));
  await new Promise((r) => setImmediate(r));
  assert.equal(packets.length, 5);
  for (const p of packets) assert.equal(opusPacketSamples(p), FRAME_SAMPLES, 'each packet is 20 ms at 48 kHz');
});

test('the broadcast starts playing on the first frame, rejects partial frames, and stops cleanly', () => {
  const music = new MusicBroadcast();
  assert.equal(music.playing, false);
  assert.throws(() => music.write(Buffer.alloc(FRAME_BYTES - 2)), /whole 20 ms frames/);
  music.write(sine(2));
  assert.equal(music.playing, true);
  music.stop();
  assert.equal(music.playing, false);
});

class FakeMusic extends EventEmitter implements MusicControl {
  tabs: MusicTab[] = [];
  master = 1;
  monitor = true;
  status(): MusicStatus {
    return { available: true, inChannel: false, master: this.master, monitor: this.monitor, tabs: this.tabs };
  }
  openTab(url: string) {
    const id = String(this.tabs.length + 1);
    this.tabs.push({ id, title: url, url, volume: 1, muted: false, audible: false, active: true });
    return id;
  }
  closeTab(id: string) {
    this.tabs = this.tabs.filter((t) => t.id !== id);
  }
  updateTab(id: string, patch: Partial<MusicTab>) {
    Object.assign(this.tabs.find((t) => t.id === id)!, patch);
  }
  update(patch: { master?: number; monitor?: boolean }) {
    Object.assign(this, patch);
  }
}

test('addresses: bare hosts get https, other schemes are refused', () => {
  assert.equal(normalizeUrl(' tabletopaudio.com '), 'https://tabletopaudio.com/');
  assert.equal(normalizeUrl('https://www.youtube.com/watch?v=x'), 'https://www.youtube.com/watch?v=x');
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /Only web pages/);
  assert.throws(() => normalizeUrl('javascript:alert(1)'), /Only web pages/);
  assert.throws(() => normalizeUrl('  '), /Type a web address/);
});

test('music API: open, adjust and close tabs, set the mix; unavailable without the Mac app', async () => {
  const root = mkdtempSync(join(tmpdir(), 'music-'));
  const make = (music?: MusicControl) =>
    createApi({ password: 'pw-12345678', dataDir: root, configStore: new ConfigStore(join(root, 'c.yaml')), jobs: new JobRunner(async () => {}), ...(music ? { music } : {}) });
  const call = (api: ReturnType<typeof make>, method: string, path: string, body?: object) =>
    api.request(path, { method, headers: { Authorization: 'Bearer pw-12345678', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

  const none = make();
  assert.deepEqual(await (await call(none, 'GET', '/music')).json(), { available: false, inChannel: false, master: 1, monitor: true, tabs: [] });
  assert.equal((await call(none, 'POST', '/music/tabs', { url: 'x.com' })).status, 409);

  const fake = new FakeMusic();
  const api = make(fake);
  assert.equal((await call(api, 'POST', '/music/tabs', { url: 'ftp://x' })).status, 400);
  const opened = (await (await call(api, 'POST', '/music/tabs', { url: 'tabletopaudio.com' })).json()) as MusicStatus;
  assert.equal(opened.tabs[0]!.url, 'https://tabletopaudio.com/');
  assert.equal((await call(api, 'PATCH', '/music/tabs/1', { volume: 2 })).status, 400);
  assert.equal((await call(api, 'PATCH', '/music/tabs/9', { muted: true })).status, 404);
  const changed = (await (await call(api, 'PATCH', '/music/tabs/1', { volume: 0.4, muted: true })).json()) as MusicStatus;
  assert.deepEqual([changed.tabs[0]!.volume, changed.tabs[0]!.muted], [0.4, true]);
  const mix = (await (await call(api, 'PATCH', '/music', { master: 0.5, monitor: false })).json()) as MusicStatus;
  assert.deepEqual([mix.master, mix.monitor], [0.5, false]);
  assert.deepEqual(((await (await call(api, 'DELETE', '/music/tabs/1')).json()) as MusicStatus).tabs, []);
});

test('the worklet turns 128-sample Web Audio blocks into whole 20 ms frames, clipped to 16 bits', () => {
  // Run the worklet's exact source with stand-ins for the browser's worklet globals.
  const posted: ArrayBuffer[] = [];
  let Processor: (new () => { process(inputs: Float32Array[][]): boolean }) | undefined;
  class AudioWorkletProcessor {
    port = { postMessage: (buffer: ArrayBuffer) => posted.push(buffer) };
  }
  const registerProcessor = (name: string, cls: typeof Processor) => {
    assert.equal(name, PCM_WORKLET_NAME);
    Processor = cls;
  };
  new Function('AudioWorkletProcessor', 'registerProcessor', PCM_WORKLET_SOURCE)(AudioWorkletProcessor, registerProcessor);
  const tap = new Processor!();

  const left = new Float32Array(128).fill(0.5);
  const right = new Float32Array(128).fill(-2); // out of range: clipped
  for (let block = 0; block < 15; block++) assert.equal(tap.process([[left, right]]), true); // 1920 samples = 2 frames
  assert.equal(posted.length, 2);
  assert.equal(posted[0]!.byteLength, FRAME_BYTES);
  const first = new Int16Array(posted[0]!);
  assert.deepEqual([first[0], first[1]], [Math.trunc(0.5 * 0x7fff), -0x8000]);
  tap.process([[left, right]]);
  assert.equal(posted.length, 2, '128 more samples is not a whole frame yet');
  tap.process([[]]);
  tap.process([[new Float32Array(960 * 2)]]); // mono input is used for both channels; with the 128 left over: 2 more frames
  assert.equal(posted.length, 4);
});
