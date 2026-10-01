import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export type JobStep = 'transcribe' | 'merge' | 'disambiguate' | 'summarize';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  sessionId: string;
  step: JobStep;
  force: boolean;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  logs: string[];
  error?: string;
}

export type StepRunner = (job: Job, log: (msg: string) => void) => Promise<void>;

/**
 * Runs pipeline steps one at a time (they call rate-limited APIs and write the same session files),
 * keeps recent jobs in memory with their logs, and emits "job" events for live progress.
 */
export class JobRunner extends EventEmitter {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = false;

  constructor(
    private readonly run: StepRunner,
    private readonly keep = 50,
  ) {
    super();
  }

  enqueue(sessionId: string, step: JobStep, force = false): Job {
    const existing = [...this.jobs.values()].find((j) => j.sessionId === sessionId && j.step === step && (j.status === 'queued' || j.status === 'running'));
    if (existing) return existing;
    const job: Job = { id: randomUUID(), sessionId, step, force, status: 'queued', createdAt: Date.now(), logs: [] };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.prune();
    this.emit('job', job);
    void this.drain();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(sessionId?: string): Job[] {
    return [...this.jobs.values()].filter((j) => !sessionId || j.sessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Resolves when the queue is empty (tests). */
  async idle(): Promise<void> {
    while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 5));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        job.status = 'running';
        job.startedAt = Date.now();
        this.emit('job', job);
        const log = (msg: string) => {
          for (const line of msg.split('\n')) job.logs.push(line);
          this.emit('job', job);
        };
        try {
          await this.run(job, log);
          job.status = 'done';
        } catch (err) {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
          log(`Error: ${job.error}`);
        }
        job.finishedAt = Date.now();
        this.emit('job', job);
      }
    } finally {
      this.running = false;
    }
  }

  private prune(): void {
    const done = this.list().filter((j) => j.status === 'done' || j.status === 'failed');
    for (const j of done.slice(this.keep)) this.jobs.delete(j.id);
  }
}
