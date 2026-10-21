import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
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
import { MAX_SOUND_BYTES, MusicLibrary, type MusicLibraryState } from '../src/music/library.js';

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
    return { available: true, inChannel: false, master: this.master, monitor: this.monitor, tabs: this.tabs, playingSounds: [] };
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
  scenes: { tabs: { url: string; volume: number }[]; fadeMs: number }[] = [];
  playScene(tabs: { url: string; volume: number }[], fadeMs: number) {
    this.scenes.push({ tabs, fadeMs });
  }
  sounds: { id: string; bytes: number; volume: number }[] = [];
  playSound(id: string, audio: Uint8Array, volume: number) {
    this.sounds.push({ id, bytes: audio.byteLength, volume });
  }
  stopped = 0;
  stopSounds() {
    this.stopped++;
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
  assert.deepEqual(await (await call(none, 'GET', '/music')).json(), { available: false, inChannel: false, master: 1, monitor: true, tabs: [], playingSounds: [] });
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

// --- Scenes and soundboard ---------------------------------------------------------------------

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]); // stands in for audio: the server stores bytes as given

function musicApi(music?: MusicControl) {
  const root = mkdtempSync(join(tmpdir(), 'music-'));
  const api = createApi({ password: 'pw-12345678', dataDir: root, configStore: new ConfigStore(join(root, 'c.yaml')), jobs: new JobRunner(async () => {}), ...(music ? { music } : {}) });
  const call = async (method: string, path: string, body?: object | Uint8Array, type = 'application/json') => {
    const res = await api.request(path, {
      method,
      headers: { Authorization: 'Bearer pw-12345678', 'Content-Type': type },
      ...(body ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { root, call };
}

test('scenes: save the open tabs, rename, play with a crossfade, delete', async () => {
  const fake = new FakeMusic();
  const { call } = musicApi(fake);
  assert.equal((await call('POST', '/music/scenes', { name: 'Tavern' })).status, 400, 'nothing open to save');
  fake.openTab('https://tabletopaudio.com/tavern');
  fake.openTab('https://youtube.com/watch?v=rain');
  fake.updateTab('2', { volume: 0.3 });
  fake.openTab('https://youtube.com/watch?v=muted');
  fake.updateTab('3', { muted: true });

  const saved = await call('POST', '/music/scenes', { name: '  Tavern  ' });
  const scene = (saved.json.scenes as MusicLibraryState['scenes'])[0]!;
  assert.equal(scene.name, 'Tavern');
  assert.deepEqual(scene.tabs, [
    { url: 'https://tabletopaudio.com/tavern', volume: 1 },
    { url: 'https://youtube.com/watch?v=rain', volume: 0.3 },
  ], 'muted tabs are left out');

  await call('PATCH', `/music/scenes/${scene.id}`, { name: 'Inn' });
  assert.equal((await call('POST', `/music/scenes/${scene.id}/play`, { fadeSeconds: 5 })).status, 200);
  assert.deepEqual(fake.scenes[0], { tabs: scene.tabs, fadeMs: 5000 });
  await call('POST', `/music/scenes/${scene.id}/play`, {});
  assert.equal(fake.scenes[1]!.fadeMs, 3000, 'default fade');
  assert.equal((await call('POST', '/music/scenes/nope/play', {})).status, 404);

  const library = await call('GET', '/music/library');
  assert.equal((library.json.scenes as { name: string }[])[0]!.name, 'Inn');
  assert.deepEqual((await call('DELETE', `/music/scenes/${scene.id}`)).json.scenes, []);
});

test('soundboard: upload a file, set its volume, play it into the mix, delete it with its file', async () => {
  const fake = new FakeMusic();
  const { root, call } = musicApi(fake);
  assert.equal((await call('POST', '/music/sounds?name=Door', MP3, 'text/plain')).status, 400, 'not audio');
  const added = await call('POST', '/music/sounds?name=Door%20slam&file=door.mp3', MP3, 'audio/mpeg');
  const sound = (added.json.sounds as MusicLibraryState['sounds'])[0]!;
  assert.equal(sound.name, 'Door slam');
  assert.match(sound.file, /^[0-9a-f]{8}\.mp3$/);
  assert.ok(existsSync(join(root, 'music', 'sounds', sound.file)));

  assert.equal((await call('PATCH', `/music/sounds/${sound.id}`, { volume: 3 })).status, 400);
  await call('PATCH', `/music/sounds/${sound.id}`, { volume: 0.5 });
  assert.equal((await call('POST', `/music/sounds/${sound.id}/play`)).status, 200);
  assert.deepEqual(fake.sounds, [{ id: sound.id, bytes: MP3.byteLength, volume: 0.5 }]);
  await call('POST', '/music/sounds/stop');
  assert.equal(fake.stopped, 1);

  await call('DELETE', `/music/sounds/${sound.id}`);
  assert.ok(!existsSync(join(root, 'music', 'sounds', sound.file)));
  assert.equal((await call('POST', `/music/sounds/${sound.id}/play`)).status, 404);
});

test('a sound from a link is downloaded once; too big or not audio is refused', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/roar.ogg') return (res.setHeader('content-type', 'audio/ogg'), res.end(Buffer.from(MP3)));
    if (req.url === '/page') return (res.setHeader('content-type', 'text/html'), res.end('<html>'));
    res.setHeader('content-type', 'audio/mpeg');
    res.end(Buffer.alloc(MAX_SOUND_BYTES + 1)); // no content-length check can catch a chunked body: the stream count does
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const library = new MusicLibrary(mkdtempSync(join(tmpdir(), 'lib-')));
    const roar = await library.addSoundFromUrl('Roar', `${base}/roar.ogg`);
    assert.equal(roar.file.endsWith('.ogg'), true);
    assert.equal(library.soundAudio(roar.id).audio.byteLength, MP3.byteLength);
    await assert.rejects(library.addSoundFromUrl('Page', `${base}/page`), /isn’t an audio file/);
    await assert.rejects(library.addSoundFromUrl('Huge', `${base}/huge.mp3`), /up to 10 MB/);
    assert.equal(library.read().sounds.length, 1);
  } finally {
    server.close();
  }
});

test('without the Mac app the library can be edited but nothing plays', async () => {
  const { call } = musicApi();
  const added = await call('POST', '/music/scenes', { name: 'Combat', tabs: [{ url: 'tabletopaudio.com/combat', volume: 0.7 }] });
  const scene = (added.json.scenes as MusicLibraryState['scenes'])[0]!;
  assert.deepEqual(scene.tabs, [{ url: 'https://tabletopaudio.com/combat', volume: 0.7 }]);
  assert.equal((await call('POST', `/music/scenes/${scene.id}/play`, {})).status, 409);
  assert.equal((await call('POST', '/music/sounds/stop')).status, 409);
});
