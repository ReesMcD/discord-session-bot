/** Times are seconds from the start of the audio file that was transcribed. */
export interface Word {
  word: string;
  start: number;
  end: number;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  /** Whisper's probability that the segment is not speech. */
  noSpeechProb?: number;
  avgLogprob?: number;
  compressionRatio?: number;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  segments: Segment[];
  /** Word timestamps across the whole file; empty if the provider doesn't return them. */
  words: Word[];
}

export interface TranscribeOptions {
  language?: string;
  prompt?: string;
}

/** A speech-to-text backend. Hosted and local implementations are chosen by config. */
export interface Transcriber {
  /** e.g. "groq:whisper-large-v3-turbo", recorded in session metadata. */
  readonly id: string;
  transcribe(file: string, options?: TranscribeOptions): Promise<TranscriptionResult>;
}
