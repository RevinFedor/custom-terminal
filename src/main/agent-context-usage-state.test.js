'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAgentContextUsageState,
  normalizeAuthoritativeContextPct,
} = require('./agent-context-usage-state');

test('authoritative zero clears stale context while missing data stays unknown', () => {
  assert.equal(normalizeAuthoritativeContextPct(0), 0);
  assert.equal(normalizeAuthoritativeContextPct(0.8), 0.8);
  assert.equal(normalizeAuthoritativeContextPct(null), null);
  assert.equal(normalizeAuthoritativeContextPct(undefined), null);
  assert.equal(normalizeAuthoritativeContextPct(-1), null);
  assert.equal(normalizeAuthoritativeContextPct(Number.NaN), null);
});

test('main owner persists once per visible percent and keeps the freshest exact value', () => {
  const state = createAgentContextUsageState();
  const first = state.observe({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    contextPct: 72.5,
    observedAt: 1,
  });
  const compacted = state.observe({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    contextPct: 13.8,
    observedAt: 2,
  });
  const sameVisiblePercent = state.observe({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-a',
    contextPct: 14.1,
    observedAt: 3,
  });

  assert.equal(first.shouldPersist, true);
  assert.equal(compacted.shouldPersist, true, 'a compact decrease is a durable state change');
  assert.equal(sameVisiblePercent.shouldPersist, false, 'sub-percent streaming does not hammer SQLite');
  assert.equal(state.read('tab-a', { provider: 'codex', sessionId: 'session-a' }).contextPct, 14.1);
});

test('session identity prevents an old writer snapshot from being read as the new writer', () => {
  const state = createAgentContextUsageState();
  state.observe({
    tabId: 'tab-a',
    provider: 'claude',
    sessionId: 'old-session',
    contextPct: 55,
  });
  assert.equal(state.read('tab-a', { provider: 'claude', sessionId: 'new-session' }), null);

  const cleared = state.observe({
    tabId: 'tab-a',
    provider: 'claude',
    sessionId: 'new-session',
    contextPct: 0,
  });
  assert.equal(cleared.shouldPersist, true);
  assert.equal(state.read('tab-a', { provider: 'claude', sessionId: 'new-session' }).contextPct, 0);
});
