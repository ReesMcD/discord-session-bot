// Preload of the hidden music capture window. It captures each browser tab's audio (Chromium's
// tab capture), gives each tab its own volume, mixes them, and sends the mix to the main process
// as 20 ms PCM frames for the bot. Capturing a tab silences it on this Mac, so the mix can also be
// played here ("monitor").
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

const ready = (async () => {
  const url = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const tap = new AudioWorkletNode(ctx, PCM_WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
  // The tap must reach the destination to be processed; a muted gain keeps it silent there.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  master.connect(tap).connect(sink).connect(ctx.destination);
  tap.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    if (sources.size) ipcRenderer.send('music:pcm', new Uint8Array(e.data));
  };
  await ctx.resume();
})();

ipcRenderer.on('music:add', async (_e, { id, mediaSourceId, gain }: { id: string; mediaSourceId: string; gain: number }) => {
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
    node.connect(g).connect(master);
    sources.set(id, { stream, node, gain: g });
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
});

ipcRenderer.on('music:gain', (_e, { id, value }: { id: string; value: number }) => {
  const s = sources.get(id);
  if (s) s.gain.gain.setTargetAtTime(value, ctx.currentTime, 0.05);
});
ipcRenderer.on('music:master', (_e, value: number) => master.gain.setTargetAtTime(value, ctx.currentTime, 0.05));
ipcRenderer.on('music:monitor', (_e, on: boolean) => monitor.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.05));
