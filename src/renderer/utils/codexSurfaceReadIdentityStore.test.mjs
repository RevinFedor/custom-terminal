import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearCodexSurfaceReadIdentity,
  getCodexSurfaceReadSessionId,
  publishCodexSurfaceReadIdentity,
  resetCodexSurfaceReadIdentityStoreForTests,
  subscribeCodexSurfaceReadIdentity,
} from './codexSurfaceReadIdentityStore.mjs';

const resumeSource = (sessionId = 'resume-source') => ({
  canCopySessionId: true,
  liveLifecycle: true,
  readIdentitySource: 'resume-source',
  readSessionId: sessionId,
});

test.beforeEach(() => resetCodexSurfaceReadIdentityStoreForTests());

test('exact Resume read identity is visible without becoming a writer binding', () => {
  let changes = 0;
  const unsubscribe = subscribeCodexSurfaceReadIdentity('tab-a', () => { changes += 1; });
  assert.equal(publishCodexSurfaceReadIdentity('tab-a', resumeSource()), 'resume-source');
  assert.equal(getCodexSurfaceReadSessionId('tab-a'), 'resume-source');
  assert.equal(changes, 1);
  unsubscribe();
});

test('first-submit unresolved window preserves the exact surface until adoption', () => {
  publishCodexSurfaceReadIdentity('tab-a', resumeSource());
  assert.equal(publishCodexSurfaceReadIdentity('tab-a', {
    canCopySessionId: false,
    liveLifecycle: true,
    readIdentitySource: 'resume-source',
    readSessionId: 'resume-source',
  }), 'resume-source');
  assert.equal(getCodexSurfaceReadSessionId('tab-a'), 'resume-source');
  assert.equal(publishCodexSurfaceReadIdentity('tab-a', {
    canCopySessionId: true,
    liveLifecycle: true,
    readIdentitySource: 'live-writer',
    readSessionId: 'writer-child',
  }), 'writer-child');
  assert.equal(getCodexSurfaceReadSessionId('tab-a'), 'writer-child');
});

test('explicit clear is tab-scoped', () => {
  publishCodexSurfaceReadIdentity('tab-a', resumeSource('a'));
  publishCodexSurfaceReadIdentity('tab-b', resumeSource('b'));
  assert.equal(clearCodexSurfaceReadIdentity('tab-a'), true);
  assert.equal(getCodexSurfaceReadSessionId('tab-a'), null);
  assert.equal(getCodexSurfaceReadSessionId('tab-b'), 'b');
});
