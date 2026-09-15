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
  const latest = state.read('tab-a', { provider: 'codex', sessionId: 'session-a' });
  assert.equal(latest.contextPct, 14.1);
  assert.ok(latest.semanticRevision > compacted.snapshot.semanticRevision,
    'exact value movement is visible to coherent readers even inside one persisted bucket');
});

test('context semantic revision detects ABA but ignores timestamp-only heartbeats', () => {
  const state = createAgentContextUsageState();
  const a = state.observe({ tabId: 'T', provider: 'claude', sessionId: 'S', contextPct: 20, observedAt: 1 });
  const heartbeat = state.observe({ tabId: 'T', provider: 'claude', sessionId: 'S', contextPct: 20, observedAt: 2 });
  const b = state.observe({ tabId: 'T', provider: 'claude', sessionId: 'S', contextPct: 50, observedAt: 3 });
  const a2 = state.observe({ tabId: 'T', provider: 'claude', sessionId: 'S', contextPct: 20, observedAt: 4 });
  assert.equal(heartbeat.snapshot.semanticRevision, a.snapshot.semanticRevision);
  assert.ok(b.snapshot.semanticRevision > a.snapshot.semanticRevision);
  assert.ok(a2.snapshot.semanticRevision > b.snapshot.semanticRevision);
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

test('compact invalidation is exact to provider and session ownership', () => {
  const state = createAgentContextUsageState();
  state.observe({
    tabId: 'tab-a',
    provider: 'codex',
    sessionId: 'session-new',
    contextPct: 12,
  });

  assert.equal(state.invalidate('tab-a', {
    provider: 'codex',
    sessionId: 'session-old',
  }).accepted, false);
  assert.equal(state.read('tab-a', {
    provider: 'codex',
    sessionId: 'session-new',
  }).contextPct, 12);

  assert.equal(state.invalidate('tab-a', {
    provider: 'codex',
    sessionId: 'session-new',
  }).accepted, true);
  assert.equal(state.read('tab-a'), null);
});
