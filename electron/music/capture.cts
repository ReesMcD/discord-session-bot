// Preload of the hidden music capture window. It captures each browser tab's audio (Chromium's
// tab capture), gives each tab its own volume, mixes them, and sends the mix to the main process
// as 20 ms PCM frames for the bot. Capturing a tab silences it on this Mac, so the mix can also be
// played here ("monitor"). Soundboard effects are decoded here and mixed in the same way.
import { ipcRenderer } from 'electron';
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from '../../src/music/pcmWorklet.js';

interface Source {
  stream: MediaStream;
  node: MediaStreamAudioSourceNode;
  gain: GainNode;
}

const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'playback' });
const master = ctx.createGain();
const monitor = ctx.createGain();
master.connect(monitor).connect(ctx.destination);
const sources = new Map<string, Source>();
/** Soundboard effects playing now, by sound ID (the same sound can overlap itself). */
const effects = new Map<string, Set<AudioBufferSourceNode>>();
/** Decoded effects, by sound ID and size, so a replay starts at once. */
const decoded = new Map<string, AudioBuffer>();

// Spotify Connect: chunks of 44.1 kHz float stereo from librespot, scheduled back to back (Web
// Audio resamples them to the mix's 48 kHz).
const feedGain = ctx.createGain();
feedGain.connect(master);
let feedAt = 0;
let feeding = false;
let feedTimer: ReturnType<typeof setTimeout> | undefined;

const busy = () => sources.size > 0 || effects.size > 0 || feeding;
/** Tells the main process when the mix goes quiet (no tabs, no effects), so the bot stops playing. */
let wasBusy = false;
function reportActivity(): void {
  if (busy() === wasBusy) return;
  wasBusy = busy();
  ipcRenderer.send(wasBusy ? 'music:busy' : 'music:idle');
}
const playingSounds = () => ipcRenderer.send('music:sounds', [...effects.keys()]);

const ready = (async () => {
  const url = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const tap = new AudioWorkletNode(ctx, PCM_WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
  // The tap must reach the destination to be processed; a muted gain keeps it silent there.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  master.connect(tap).connect(sink).connect(ctx.destination);
  tap.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    if (busy()) ipcRenderer.send('music:pcm', new Uint8Array(e.data));
  };
  await ctx.resume();
})();

ipcRenderer.on('music:add', async (_e, { id, mediaSourceId, gain, fadeTo }: { id: string; mediaSourceId: string; gain: number; fadeTo?: { value: number; ms: number } }) => {
  try {
    await ready;
    const stream = await navigator.mediaDevices.getUserMedia({
      // Chromium's tab capture; the standard typings don't know these constraints.
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: mediaSourceId } } as unknown as MediaTrackConstraints,
      video: false,
    });
    const node = ctx.createMediaStreamSource(stream);
    const g = ctx.createGain();
    g.gain.value = gain;
    // A scene's new tab starts silent and fades in once its audio is captured.
    if (fadeTo) g.gain.linearRampToValueAtTime(fadeTo.value, ctx.currentTime + Math.max(0.01, fadeTo.ms / 1000));
    node.connect(g).connect(master);
    sources.set(id, { stream, node, gain: g });
    reportActivity();
    ipcRenderer.send('music:added', id);
  } catch (err) {
    ipcRenderer.send('music:error', id, (err as Error).message);
  }
});

ipcRenderer.on('music:remove', (_e, id: string) => {
  const s = sources.get(id);
  if (!s) return;
  s.node.disconnect();
  s.gain.disconnect();
  for (const track of s.stream.getTracks()) track.stop();
  sources.delete(id);
  reportActivity();
});

ipcRenderer.on('music:gain', (_e, { id, value }: { id: string; value: number }) => {
  const s = sources.get(id);
  if (s) s.gain.gain.setTargetAtTime(value, ctx.currentTime, 0.05);
});
ipcRenderer.on('music:master', (_e, value: number) => master.gain.setTargetAtTime(value, ctx.currentTime, 0.05));
ipcRenderer.on('music:monitor', (_e, on: boolean) => monitor.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.05));

/** Fades a tab to `value` over `ms` (scenes crossfade this way). */
ipcRenderer.on('music:fade', (_e, { id, value, ms }: { id: string; value: number; ms: number }) => {
  const s = sources.get(id);
  if (!s) return;
  const g = s.gain.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setValueAtTime(g.value, ctx.currentTime);
  g.linearRampToValueAtTime(value, ctx.currentTime + Math.max(0.01, ms / 1000));
});

ipcRenderer.on('music:sfx', async (_e, { id, audio, gain }: { id: string; audio: Uint8Array; gain: number }) => {
  try {
    await ready;
    const key = `${id}:${audio.byteLength}`;
    let buffer = decoded.get(key);
    if (!buffer) {
      buffer = await ctx.decodeAudioData(audio.slice().buffer);
      decoded.set(key, buffer);
    }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    node.connect(g).connect(master);
    const playing = effects.get(id) ?? new Set();
    playing.add(node);
    effects.set(id, playing);
    node.onended = () => {
      g.disconnect();
      playing.delete(node);
      if (!playing.size) effects.delete(id);
      playingSounds();
      reportActivity();
    };
    node.start();
    playingSounds();
    reportActivity();
  } catch (err) {
    ipcRenderer.send('music:error', id, `couldn't play this sound: ${(err as Error).message}`);
  }
});

ipcRenderer.on('music:feed', async (_e, data: Uint8Array) => {
  await ready;
  const samples = new Float32Array(data.slice().buffer);
  const frames = samples.length / 2;
  if (!frames) return;
  const buffer = ctx.createBuffer(2, frames, 44_100);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let i = 0; i < frames; i++) {
    left[i] = samples[i * 2]!;
    right[i] = samples[i * 2 + 1]!;
  }
  const now = ctx.currentTime;
  // Starting (or after a pause): a small cushion. Far ahead means a backlog: drop rather than pile up.
  if (feedAt < now + 0.02) feedAt = now + 0.15;
  if (feedAt > now + 3) return;
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(feedGain);
  node.start(feedAt);
  feedAt += buffer.duration;
  feeding = true;
  reportActivity();
  clearTimeout(feedTimer);
  feedTimer = setTimeout(() => {
    feeding = false;
    reportActivity();
  }, Math.max(0, (feedAt - now) * 1000) + 1500);
});
ipcRenderer.on('music:feed-gain', (_e, value: number) => feedGain.gain.setTargetAtTime(value, ctx.currentTime, 0.05));

ipcRenderer.on('music:sfx-stop', () => {
  for (const playing of effects.values()) for (const node of playing) node.stop();
});
