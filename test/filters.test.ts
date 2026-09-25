import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipReason } from '../src/recording/filters.js';

const config = { ignoreUserIds: new Set(['music']), ignoreBots: true, selfId: 'me' };

test('skips self, ignored users and bots; records humans', () => {
  assert.equal(skipReason({ id: 'me', bot: true }, config), 'self');
  assert.equal(skipReason({ id: 'music', bot: false }, config), 'ignored_user');
  assert.equal(skipReason({ id: 'other-bot', bot: true }, config), 'bot');
  assert.equal(skipReason({ id: 'alice', bot: false }, config), undefined);
});

test('bots are recorded when ignoreBots is off (unless explicitly ignored)', () => {
  const c = { ...config, ignoreBots: false };
  assert.equal(skipReason({ id: 'other-bot', bot: true }, c), undefined);
  assert.equal(skipReason({ id: 'music', bot: true }, c), 'ignored_user');
});
