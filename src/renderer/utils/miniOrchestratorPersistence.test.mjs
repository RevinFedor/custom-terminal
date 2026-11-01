import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiniPanelPersistence, miniReviewTarget, navigateMiniReview, fitMiniPanel } from './miniOrchestratorGeometry.mjs';

test('iteration navigation uses only the exact recorded request, never turn fallback', () => {
  const source = { provider: 'codex', sessionId: 'session', turnId: 'turn', requestIds: ['codex-user-session-7'] };
  assert.deepEqual(miniReviewTarget('tab', source), { tabId: 'tab', provider: 'codex', sessionId: 'session', messageId: 'codex-user-session-7' });
  assert.equal(miniReviewTarget('tab', { ...source, requestIds: [] }), null);
  assert.equal(miniReviewTarget('tab', { ...source, requestIds: ['turn'] }), null);
  assert.equal(miniReviewTarget('tab', { ...source, provider: 'unknown' }), null);
  assert.deepEqual(miniReviewTarget('tab', { ...source, requestIds: ['old-root', 'current'], navigationRequestId: 'current' }),
    { tabId: 'tab', provider: 'codex', sessionId: 'session', messageId: 'current' });
  assert.equal(miniReviewTarget('tab', { ...source, navigationRequestId: 'foreign' }), null);
  assert.equal(miniReviewTarget('tab', { ...source, navigationRequestId: '' }), null);
});

test('only successful exact navigation closes the popup; cancellation is silent', async () => {
  const events = [], target = { messageId: 'q' };
  const done = () => events.push('close'), error = () => events.push('error');
  await navigateMiniReview(target, async () => false, done, error);
  assert.deepEqual(events, []);
  await navigateMiniReview(target, async () => true, done, error);
  await navigateMiniReview(target, async () => { throw Error('unavailable'); }, done, error);
  await navigateMiniReview(null, async () => assert.fail('must not jump'), done, error);
  assert.deepEqual(events, ['close', 'error', 'error']);
});

test('geometry survives restart and an edit during hydration wins', async () => {
  let stored = [['other', { frame: { left: 4, top: 5, width: 300, height: 200 }, detached: true }], ['tab', { frame: { left: 10, top: 10, width: 400, height: 300 }, detached: true }]];
  let resolveRead; const gate = new Promise(resolve => { resolveRead = resolve; });
  const invoke = async (channel, arg) => { if (channel === 'app:getState') { await gate; return stored; } stored = arg.value; return { success: true }; };
  const first = createMiniPanelPersistence(invoke);
  const read = first.read('tab');
  const edited = { frame: { left: 20, top: 30, width: 500, height: 350 }, detached: true };
  first.write('tab', edited); resolveRead();
  assert.deepEqual(await read, edited);
  // Drain the queued write through the IPC mock.
  await new Promise(resolve => setImmediate(resolve));
  const reopened = createMiniPanelPersistence(invoke);
  assert.deepEqual(await reopened.read('tab'), edited);
  assert.ok(await reopened.read('other'));
  assert.deepEqual(fitMiniPanel(edited.frame, { width: 320, height: 240 }), { left: 8, top: 8, width: 304, height: 224 });
});

test('more than 60 edits before hydration keep the latest 60 without resurrecting old entries', async () => {
  let resolveRead; const gate = new Promise(resolve => { resolveRead = resolve; });
  let stored = [['old', { frame: { left: 0, top: 0, width: 1, height: 1 }, detached: false }]];
  const invoke = async (channel, arg) => { if (channel === 'app:getState') { await gate; return stored; } stored = arg.value; return { success: true }; };
  const client = createMiniPanelPersistence(invoke);
  let last;
  for (let i = 0; i < 70; i++) last = client.write('tab' + i, { frame: { left: i, top: 0, width: 300, height: 200 }, detached: true });
  resolveRead(); await last;
  assert.equal(stored.length, 60);
  assert.equal(stored[0][0], 'tab10'); assert.equal(stored.at(-1)[0], 'tab69');
  assert.equal(await client.read('old'), null);
});
