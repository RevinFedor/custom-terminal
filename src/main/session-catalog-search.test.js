'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  resolveSearchDateWindow,
  scoreSessionTurnMatch,
  sessionMatchesDate,
} = require('./session-catalog-search');

test('plain keyword matching requires every meaningful token and reports the matching field', () => {
  const match = scoreSessionTurnMatch({
    query: 'remote image',
    title: 'Desktop support',
    userText: 'Move image processing to a remote worker',
    assistantText: 'Implemented an upload endpoint',
  });
  assert.equal(match.matched, true);
  assert.deepEqual(match.matchedIn, ['user']);
  assert.equal(scoreSessionTurnMatch({
    query: 'remote linux',
    userText: 'remote worker',
    assistantText: '',
  }).matched, false);
});

test('today and yesterday use local half-open day windows', () => {
  const now = new Date('2026-08-17T12:00:00+03:00');
  const today = resolveSearchDateWindow({ period: 'today', now });
  const yesterday = resolveSearchDateWindow({ period: 'yesterday', now });
  assert.equal(today.toMs - today.fromMs, 24 * 60 * 60 * 1000);
  assert.equal(today.fromMs - yesterday.fromMs, 24 * 60 * 60 * 1000);
});

test('closed and created date filters address their own persisted timestamps', () => {
  const candidate = { createdAt: 100, closedAt: 200 };
  assert.equal(sessionMatchesDate(candidate, { dateField: 'created', fromMs: 99_000, toMs: 101_000 }), true);
  assert.equal(sessionMatchesDate(candidate, { dateField: 'closed', fromMs: 199_000, toMs: 201_000 }), true);
  assert.equal(sessionMatchesDate({ createdAt: 100, closedAt: null }, { dateField: 'closed', fromMs: 1 }), false);
});
