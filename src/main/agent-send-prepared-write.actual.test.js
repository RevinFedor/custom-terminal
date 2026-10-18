'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, drainMicrotasks: tick } = require('./fixtures/send-preparation-write.cjs');

test('actual final pre-paste wait releases PTY lock and resumes the SAME staged write after 2.5s', async t => {
  const h = fixture(t); let settled = false;
  const pending = h.start().then(r => { settled = true; return r; }); await tick(100);
  assert.equal(h.stages, 1, h.logs.join('\n'));
  assert.equal(h.ctx.held(), false, 'waiting must leave the actual writer lock');
  h.clock.advance(3100); await tick(100); assert.equal(settled, false, h.logs.join('\n'));
  h.frame(); const r = await pending;
  assert.equal(r.submitted, true, JSON.stringify(r));
  assert.deepEqual(h.writes, ['\x1b[200~frozen\x1b[201~', '\r']);
  assert.equal(h.stages, 1); assert.equal(h.drains, 1); assert.equal(h.inputRevision, 2);
  assert.equal(h.store.get(h.identity.operationKey).attemptId, h.attempt.attemptId);
  assert.deepEqual(h.store.get(h.identity.operationKey).receipt.ownedAttachments, h.ownedAttachments);
});

test('actual immediate current frame sends without spending preparation ceiling', async t => {
  const h = fixture(t, { open: false }); const at = h.clock.now(); const r = await h.start();
  assert.equal(r.submitted, true, JSON.stringify(r)); assert.equal(h.clock.now(), at);
  assert.equal(h.writes.length, 2);
});

test('actual Main first Enter stores its timestamp; pre-Enter refusal never supplies one', async t => {
  const h = fixture(t, { open: false }); const at = h.clock.now();
  const result = await h.start(); await tick(10);
  assert.equal(result.submitted, true);
  assert.equal(h.store.get(h.identity.operationKey).receipt.enterAttemptAt, at);
});

for (const what of ['input', 'stop', 'owner', 'settings', 'cancel']) test('actual suspended prepared write revokes on ' + what, async t => {
  const h = fixture(t); const p = h.start(); await tick(100);
  h.clock.advance(3100); await tick(60); h.change(what); h.frame();
  const r = await p; assert.notEqual(r.submitted, true); assert.equal(h.writes.length, 0);
  assert.equal(h.stages, 1); assert.equal(h.ctx.held(), false);
});

test('actual suspended preparation expiry cannot paste on a later frame', async t => {
  const h = fixture(t); const p = h.start(); await tick(100);
  h.clock.advance(60000); await tick(100); const r = await p;
  assert.equal(r.submitted, false); h.frame(); await tick(60); assert.equal(h.writes.length, 0);
  assert.equal(h.stages, 1);
});

test('actual last await retains original cold deadline instead of a fresh warm60', async t => {
  const h = fixture(t, { deadlineOffset: 5000 }); const p = h.start(); await tick(100);
  h.clock.advance(5000); await tick(100); const r = await p;
  assert.equal(r.submitted, false); assert.equal(h.writes.length, 0);
  assert.equal(h.clock.now(), 6000); h.frame(); await tick(60); assert.equal(h.writes.length, 0);
});

test('actual possible Enter remains unknown, with no replay from preparation cleanup', async t => {
  const h = fixture(t, { throwEnter: true }); const p = h.start(); await tick(100); h.frame();
  const r = await p; assert.equal(r.deliveryUnknown, true, JSON.stringify(r)); assert.equal(r.submitted, null);
  h.clock.advance(60000); h.frame(); await tick(60); assert.equal(h.writes.length, 2);
  assert.equal(h.store.get(h.identity.operationKey).state, 'enter-armed');
});

test('actual prepared writer remains pending beyond 2.5s even without the lock-state assertion', async t => {
  const h = fixture(t); let done = false;
  const p = h.start().then(r => { done = true; return r; }); await tick(100);
  h.clock.advance(3100); await tick(100);
  assert.equal(done, false, 'short reader expiry must not finalize the accepted item');
  h.frame(); const r = await p; assert.equal(r.submitted, true);
  assert.equal(h.writes.length, 2); assert.equal(h.stages, 1);
});

test('actual final locked recheck rejects a frame that reopens while the original continuation waits for PTY', async t => {
  const h = fixture(t); let done = false, release, acquired;
  const p = h.start().then(r => { done = true; return r; }); await tick(100);
  assert.equal(h.ctx.held(), false, 'the baseline cannot reach this re-acquisition race while holding its old lock');
  const ready = new Promise(resolve => { acquired = resolve; }), held = new Promise(resolve => { release = resolve; });
  const control = h.ctx.withPtyWriteLock(h.term, async () => { acquired(); await held; }, { kind: 'controlled-no-input' });
  await ready; h.frame(); await tick(100); h.open(); release(); await control; await tick(100);
  assert.equal(done, false); assert.equal(h.writes.length, 0); assert.equal(h.stages, 1); assert.equal(h.ctx.held(), false);
  h.frame(); const r = await p; assert.equal(r.submitted, true); assert.equal(h.writes.length, 2);
  assert.equal(h.stages, 1); assert.equal(h.inputRevision, 2);
});

test('actual deadline crossing after paste but before Enter revokes only future input', async t => {
  const h = fixture(t, { open: false }), original = h.term.write;
  h.term.write = bytes => { original(bytes); if (bytes.includes('frozen')) h.clock.advance(60000); };
  const r = await h.start();
  assert.equal(r.submitted, false, JSON.stringify(r)); assert.equal(r.pasteWritten, true);
  assert.equal(h.writes.length, 1); h.frame(); await tick(60); assert.equal(h.writes.length, 1);
});
