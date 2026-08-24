'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  CODEX_SETTINGS_WRITER_ADOPTED_EVENT,
  classifyCodexSettingsWriterTransition,
  waitForCodexSettingsWriterTransition,
} = require('./codex-settings-writer-transition');

const stable = {
  sameTerminal: true,
  sameRunSeq: true,
  sameLifecycleGeneration: true,
  processRunning: true,
  hasLiveCodexEvidence: true,
};

test('the same writer remains a strict CAS match', () => {
  assert.deepEqual(classifyCodexSettingsWriterTransition({
    ...stable,
    expectedOwnerId: 'writer-a',
    currentOwnerId: 'writer-a',
  }), {
    allowed: true,
    pending: false,
    rebased: false,
    effectiveExpectedOwnerId: 'writer-a',
    reason: 'writer-owner-unchanged',
  });
});

test('one exact launch owner may rebase to its adopted writer', () => {
  assert.deepEqual(classifyCodexSettingsWriterTransition({
    ...stable,
    expectedOwnerId: 'launch:launch-a',
    currentOwnerId: 'writer-a',
    currentWriterLaunchId: 'launch-a',
  }), {
    allowed: true,
    pending: false,
    rebased: true,
    effectiveExpectedOwnerId: 'writer-a',
    reason: 'exact-launch-writer-adoption',
  });
});

test('foreign launch, process generation, or second writer stays rejected', () => {
  assert.equal(classifyCodexSettingsWriterTransition({
    ...stable,
    expectedOwnerId: 'launch:launch-a',
    currentOwnerId: 'writer-b',
    currentWriterLaunchId: 'launch-b',
  }).reason, 'codex_settings_writer_changed');
  assert.equal(classifyCodexSettingsWriterTransition({
    ...stable,
    sameRunSeq: false,
    expectedOwnerId: 'launch:launch-a',
    currentOwnerId: 'writer-a',
    currentWriterLaunchId: 'launch-a',
  }).reason, 'codex_settings_writer_changed');
  assert.equal(classifyCodexSettingsWriterTransition({
    ...stable,
    expectedOwnerId: 'writer-a',
    currentOwnerId: 'writer-b',
    currentWriterLaunchId: 'launch-a',
  }).reason, 'codex_settings_writer_changed');
});

test('a stable live launch without a writer waits for adoption', () => {
  const result = classifyCodexSettingsWriterTransition({
    ...stable,
    expectedOwnerId: 'launch:launch-a',
    currentOwnerId: null,
  });
  assert.equal(result.pending, true);
  assert.equal(result.reason, 'codex_settings_writer_adoption_pending');
});

test('a temporarily invalidated established writer also waits for the same proof', () => {
  const result = classifyCodexSettingsWriterTransition({
    ...stable,
    expectedOwnerId: 'writer-a',
    currentOwnerId: null,
  });
  assert.equal(result.pending, true);
  assert.equal(result.effectiveExpectedOwnerId, 'writer-a');
});

test('pending picker resumes on the exact writer-adoption event', async () => {
  const eventBus = new EventEmitter();
  let current = null;
  const waiting = waitForCodexSettingsWriterTransition({
    tabId: 'tab-a',
    eventBus,
    timeoutMs: 1000,
    readTransition: () => classifyCodexSettingsWriterTransition({
      ...stable,
      expectedOwnerId: 'launch:launch-a',
      currentOwnerId: current?.sessionId || null,
      currentWriterLaunchId: current?.launchId || null,
    }),
  });

  eventBus.emit(CODEX_SETTINGS_WRITER_ADOPTED_EVENT, null, {
    tabId: 'other-tab',
    sessionId: 'foreign',
    launchId: 'launch-a',
  });
  current = { sessionId: 'writer-a', launchId: 'launch-a' };
  eventBus.emit(CODEX_SETTINGS_WRITER_ADOPTED_EVENT, null, {
    tabId: 'tab-a',
    sessionId: 'writer-a',
    launchId: 'launch-a',
  });

  const result = await waiting;
  assert.equal(result.allowed, true);
  assert.equal(result.rebased, true);
  assert.equal(result.effectiveExpectedOwnerId, 'writer-a');
  assert.equal(eventBus.listenerCount(CODEX_SETTINGS_WRITER_ADOPTED_EVENT), 0);
});

test('an established writer wait accepts only the same session proof', async () => {
  const eventBus = new EventEmitter();
  let current = null;
  const waiting = waitForCodexSettingsWriterTransition({
    tabId: 'tab-a',
    eventBus,
    timeoutMs: 1000,
    readTransition: () => classifyCodexSettingsWriterTransition({
      ...stable,
      expectedOwnerId: 'writer-a',
      currentOwnerId: current,
    }),
  });
  current = 'writer-a';
  eventBus.emit(CODEX_SETTINGS_WRITER_ADOPTED_EVENT, null, {
    tabId: 'tab-a',
    sessionId: 'writer-a',
  });
  const result = await waiting;
  assert.equal(result.allowed, true);
  assert.equal(result.rebased, false);
  assert.equal(result.effectiveExpectedOwnerId, 'writer-a');
});
