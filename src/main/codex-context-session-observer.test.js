'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCodexContextSessionObserver } = require('./codex-context-session-observer');

test('stopped bound tab clears stale context at compact and receives the next exact value', () => {
  let persisted = 83;
  let state = { contextPct: 83 };
  const frames = [];
  const observer = createCodexContextSessionObserver({
    transcriptService: { subscribe: async () => ({ success: true }) },
    listBoundTabs: (sessionId) => sessionId === 'session-a' ? [{ tabId: 'tab-a' }] : [],
    readContextState: () => state,
    commitContextValue: ({ contextPct }) => {
      persisted = contextPct;
      state = { contextPct, persistenceAccepted: true };
      return state;
    },
    invalidateContextState: () => { state = null; },
    clearPersistedContext: () => { persisted = null; return true; },
    publishContextFrame: (...args) => frames.push(args),
    log: { log() {}, warn() {} },
  });

  observer.observe({
    toolType: 'codex',
    sessionId: 'session-a',
    source: 'append',
    observation: { kind: 'invalidated', reason: 'compacted' },
  });
  assert.equal(persisted, null);
  assert.equal(state, null);
  assert.equal(frames.at(-1)[3].invalidated, true);

  observer.observe({
    toolType: 'codex',
    sessionId: 'session-a',
    source: 'append',
    observation: { kind: 'value', reason: 'token_count', contextPct: 12 },
  });
  assert.equal(persisted, 12);
  assert.equal(state.contextPct, 12);
  assert.equal(frames.at(-1)[2], 12);
});

test('foreign or rebound session cannot clear or publish through a failed exact DB guard', () => {
  const frames = [];
  const observer = createCodexContextSessionObserver({
    transcriptService: { subscribe: async () => ({ success: true }) },
    listBoundTabs: () => [{ tabId: 'tab-a' }],
    readContextState: () => ({ contextPct: 7 }),
    commitContextValue: () => ({ contextPct: 9, persistenceAccepted: false }),
    invalidateContextState: () => { throw new Error('must not invalidate'); },
    clearPersistedContext: () => false,
    publishContextFrame: (...args) => frames.push(args),
    log: { log() {}, warn() {} },
  });

  observer.observe({
    toolType: 'codex', sessionId: 'old-session',
    observation: { kind: 'invalidated', reason: 'compacted' },
  });
  observer.observe({
    toolType: 'codex', sessionId: 'old-session',
    observation: { kind: 'value', contextPct: 9 },
  });
  assert.deepEqual(frames, []);
});

test('one durable observer is shared per session and hydration is sequential', async () => {
  const subscriptions = [];
  const observer = createCodexContextSessionObserver({
    transcriptService: {
      subscribe: async (payload) => {
        subscriptions.push(payload);
        return { success: true };
      },
    },
    listBoundTabs: () => [],
    listCachedSessions: () => [
      { sessionId: 'session-a', cwd: '/a' },
      { sessionId: 'session-b', cwd: '/b' },
    ],
    log: { log() {}, warn() {} },
  });

  assert.equal(await observer.ensure('session-a', '/a'), true);
  assert.equal(await observer.ensure('session-a', '/other'), true);
  const hydrated = await observer.hydrate();
  assert.deepEqual(hydrated, { attached: 2, total: 2 });
  assert.equal(subscriptions.length, 2);
  assert.equal(observer.bindingCount(), 2);
});
