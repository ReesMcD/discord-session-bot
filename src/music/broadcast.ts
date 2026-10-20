import { EventEmitter } from 'node:events';
import { AudioPlayerStatus, NoSubscriberBehavior, StreamType, createAudioPlayer, createAudioResource, type AudioPlayer } from '@discordjs/voice';
import prism from 'prism-media';

/** What the music mixer sends: 20 ms of 48 kHz stereo 16-bit PCM per frame (Discord's format). */
export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const FRAME_SAMPLES = 960;
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;

/**
 * Plays mixed PCM into the voice channel: frames are Opus-encoded and fed to an AudioPlayer that
 * the recording's voice connection subscribes to, so one bot both records and plays. The mixer
 * sends frames continuously (silence included) while music is on, so playback never stalls.
 */
export class MusicBroadcast extends EventEmitter {
  /** Keeps playing (and discarding) when not in a channel, so the stream never backs up. */
  readonly player: AudioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  private encoder: prism.opus.Encoder | undefined;

  constructor() {
    super();
    this.player.on('error', (err) => this.emit('error', err));
    this.player.on(AudioPlayerStatus.Idle, () => (this.encoder = undefined));
  }

  get playing(): boolean {
    return !!this.encoder;
  }

  /** Queues one or more whole PCM frames, starting playback on the first. */
  write(pcm: Buffer): void {
    if (pcm.length % FRAME_BYTES !== 0) throw new Error(`PCM must be whole 20 ms frames (${FRAME_BYTES} bytes each), got ${pcm.length}`);
    if (!this.encoder) this.start();
    this.encoder!.write(pcm);
  }

  stop(): void {
    this.encoder?.end();
    this.encoder = undefined;
    this.player.stop(true);
  }

  private start(): void {
    const encoder = new prism.opus.Encoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: FRAME_SAMPLES });
    this.encoder = encoder;
    this.player.play(createAudioResource(encoder, { inputType: StreamType.Opus }));
  }
}
