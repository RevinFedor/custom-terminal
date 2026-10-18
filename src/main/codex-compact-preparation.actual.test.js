'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, tick } = require('./fixtures/compact-preparation.cjs');

test('actual standalone Compact keeps its original pending operation and ONE insertion beyond 2.5s', async t => {
  const h = fixture(t, { capturedDraft: true }); let done = false;
  const p = h.start().then(r => { done = true; return r; }); await tick(120);
  const receipt = h.settingsQueue.getUnsubmittedInput(h.term), pending = h.registry.getPending('T');
  assert.ok(receipt, h.logs.join('\n')); assert.ok(pending); assert.equal(h.ctx.held(), false);
  h.clock.advance(3100); await tick(100); assert.equal(done, false);
  assert.equal(h.settingsQueue.getUnsubmittedInput(h.term), receipt); assert.equal(receipt.recoveryPending, false);
  assert.equal(h.registry.getPending('T').operationId, pending.operationId);
  assert.equal(h.restores, 0); assert.equal(h.writes.length, 1);
  h.frame(); const r = await p;
  assert.equal(r.success, true, JSON.stringify(r)); assert.equal(r.compactStartConfirmed, true);
  assert.equal(h.writes.filter(w => w.includes('/compact')).length, 1);
  assert.equal(h.writes.filter(w => w === '\r').length, 1); assert.equal(h.restores, 1);
  assert.equal(h.registry.getActive('T').operationId, pending.operationId);
});

test('actual Compact immediate exact post-paste proof has no fixed preparation delay', async t => {
  const h = fixture(t, { immediate: true }); const at = h.clock.now(); const r = await h.start();
  assert.equal(r.success, true, JSON.stringify(r)); assert.equal(h.clock.now(), at);
  assert.equal(h.writes.length, 2);
});

for (const what of ['input', 'stop', 'owner', 'cancel']) test('actual preparing Compact revokes on ' + what, async t => {
  const h = fixture(t, { capturedDraft: true }); const p = h.start(); await tick(120);
  h.clock.advance(3100); await tick(60); h.change(what); h.frame(); const r = await p;
  assert.notEqual(r.submitted, true, JSON.stringify(r)); assert.equal(h.writes.filter(w => w === '\r').length, 0);
  assert.deepEqual(r.draftTransfer, h.captured); assert.equal(h.registry.getPending('T'), null);
});

test('actual Compact expiry preserves captured authoring and cannot execute from late cleanup', async t => {
  const h = fixture(t, { capturedDraft: true }); const p = h.start(); await tick(120);
  h.clock.advance(60000); await tick(120); // Original deadline, no post-2.5s rearm.
  // Existing bounded owned-draft recovery may still observe for 1.8s before returning.
  h.clock.advance(1800); await tick(120); const r = await p;
  assert.equal(r.submitted, false); assert.deepEqual(r.draftTransfer, h.captured);
  assert.equal(h.registry.getPending('T'), null); h.frame(); await tick(120);
  assert.equal(h.writes.filter(w => w === '\r').length, 0);
  assert.equal(h.writes.filter(w => w.includes('/compact')).length, 1);
});

test('actual Compact late exact frame then Enter throw keeps SAME unknown operation for causal outcome', async t => {
  const h = fixture(t, { capturedDraft: true, throwEnter: true }); const p = h.start(); await tick(120);
  h.clock.advance(3100); await tick(80); h.frame(); const r = await p;
  assert.equal(r.deliveryUnknown, true, JSON.stringify(r)); assert.equal(r.enterWritten, null);
  assert.equal(h.restores, 0); assert.deepEqual(r.draftTransfer, h.captured);
  assert.ok(h.registry.getPending('T')); h.lateStart(); await tick(60);
  assert.equal(h.registry.getActive('T').operationId, 'codex:api:H');
  assert.equal(h.writes.length, 2);
});

test('actual Compact holds the SAME preparation before first insertion, then awaits its one owned paste', async t => {
  const h = fixture(t); h.open(); let done = false;
  const p = h.start().then(result => { done = true; return result; }); await tick(120);
  assert.equal(h.ctx.held(), false); assert.equal(h.writes.length, 0);
  h.clock.advance(3100); await tick(120); assert.equal(done, false);
  h.frame(''); await tick(120);
  const pending = h.registry.getPending('T'); assert.ok(pending);
  assert.equal(h.writes.length, 1); assert.equal(h.ctx.held(), false);
  h.clock.advance(3100); await tick(100); assert.equal(done, false);
  h.frame(); const r = await p; assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(h.writes.filter(w => w.includes('/compact')).length, 1);
  assert.equal(h.writes.filter(w => w === '\r').length, 1);
  assert.equal(h.registry.getActive('T').operationId, pending.operationId);
});

test('actual Compact first-insert preparation does not restart the clock for its exact-owned frame', async t => {
  const h = fixture(t); h.open(); const p = h.start(); await tick(120);
  h.clock.advance(57000); await tick(120); h.frame(''); await tick(120);
  assert.equal(h.writes.length, 1);
  h.clock.advance(3000); await tick(120); h.clock.advance(1800); await tick(120);
  const r = await p; assert.equal(r.submitted, false);
  h.frame(); await tick(80); assert.equal(h.writes.filter(w => w === '\r').length, 0);
});
