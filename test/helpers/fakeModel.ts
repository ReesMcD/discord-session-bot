import type { AuditFindings, CallOptions, Cleanup, Extraction, Labels, SummaryModel } from '../../src/summary/model.js';

type Step = 'disambiguate' | 'cleanup' | 'extract' | 'audit' | 'synthesize';

export interface Replies {
  disambiguate?: (opts: CallOptions) => Labels;
  cleanup?: (opts: CallOptions) => Cleanup;
  extract?: (opts: CallOptions) => Extraction;
  audit?: (opts: CallOptions) => AuditFindings;
  synthesize?: (opts: CallOptions) => string;
}

export const emptyNotes = (): Extraction => ({ npcs: [], locations: [], events: [], combats: [], items: [] });

/** A SummaryModel that records every call and answers from `replies` (empty answers by default). */
export class FakeModel implements SummaryModel {
  readonly calls: Record<Step, CallOptions[]> = { disambiguate: [], cleanup: [], extract: [], audit: [], synthesize: [] };

  constructor(private readonly replies: Replies = {}) {}

  private answer<T>(step: Step, opts: CallOptions, value: T) {
    this.calls[step].push(opts);
    return Promise.resolve({ value, model: 'claude-test', usage: { inputTokens: 100, outputTokens: 20 } });
  }

  disambiguate(opts: CallOptions) {
    return this.answer('disambiguate', opts, this.replies.disambiguate?.(opts) ?? { labels: [] });
  }
  cleanup(opts: CallOptions) {
    return this.answer('cleanup', opts, this.replies.cleanup?.(opts) ?? { edits: [], drops: [] });
  }
  extract(opts: CallOptions) {
    return this.answer('extract', opts, this.replies.extract?.(opts) ?? emptyNotes());
  }
  audit(opts: CallOptions) {
    return this.answer('audit', opts, this.replies.audit?.(opts) ?? { missing: [] });
  }
  synthesize(opts: CallOptions) {
    return this.answer('synthesize', opts, this.replies.synthesize?.(opts) ?? '## What happened\n\n- Something.');
  }
}
