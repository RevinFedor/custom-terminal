'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, tick } = require('./fixtures/model-preparation.cjs');

test('actual selector forwards the SAME accepted preparation to /model, not a new scope', async t => {
  const h = fixture(t), slash = h.ctx.sendCodexSlashCommand; let seen;
  h.ctx.sendCodexSlashCommand = (...args) => { seen = args[3]?.preparation; return slash(...args); };
  const p = h.start(); await tick(160);
  assert.equal(seen, h.prep); assert.equal(seen.scope.id, h.prep.scope.id);
  h.frame('/model'); assert.equal((await p).success, true);
});

test('actual settings→Main→selector waits beyond 2.5s outside BOTH serializers, then continues once', async t => {
  const h = fixture(t); let done = false;
  const p = h.start().then(result => { done = true; return result; }); await tick(160);
  assert.equal(h.queue.pending, 0, h.logs.join('\n')); assert.equal(h.ctx.held(), false);
  assert.equal(h.captures.length, 0, 'model menu observation must not expire before its Enter');
  assert.equal(h.events.filter(e => e.kind === 'activity-end').length, 0);
  const independent = await h.otherSettingsJob(); assert.equal(independent.submitted, true);
  assert.equal(h.events.filter(e => e.kind === 'other-prompt').length, 1);
  h.clock.advance(7100); await tick(100); assert.equal(done, false);
  assert.equal(h.serviceEnters, 0); assert.equal(h.writes.length, 1);
  assert.equal(h.events.filter(e => e.kind === 'publication').length, 0);
  h.frame('/model'); const r = await p;
  assert.equal(r.success, true, JSON.stringify(r)); assert.equal(h.serviceEnters, 1);
  assert.equal(h.writes.filter(w => w.includes('/model')).length, 1);
  assert.equal(h.promptCalls, 1); assert.equal(h.events.filter(e => e.kind === 'publication').length, 1);
  assert.equal(h.events.filter(e => e.kind === 'activity-end').length, 1);
  assert.equal(h.events.find(e => e.kind === 'config').held, true);
  assert.ok(h.events.find(e => e.kind === 'config').queuePending > 0);
});

test('actual private Main selector continuation is join-once', async t => {
  const h = fixture(t); const first = await h.select();
  assert.equal(typeof first.continuePreparation, 'function');
  assert.equal(h.queue.pending, 0); assert.equal(h.ctx.held(), false);
  const a = first.continuePreparation(), b = first.continuePreparation(); assert.equal(a, b);
  await tick(120); h.clock.advance(3100); await tick(80); h.frame('/model');
  const [ra, rb] = await Promise.all([a, b]); assert.equal(ra, rb);
  assert.equal(ra.success, true, JSON.stringify(ra)); assert.equal(h.serviceEnters, 1);
  assert.equal(h.promptCalls, 0); assert.equal(h.events.filter(e => e.kind === 'activity-end').length, 1);
});

for (const what of ['input', 'stop', 'owner', 'writer', 'target', 'cancel', 'settings']) {
  test('actual deferred /model refuses ' + what + ' before Enter, never sends original prompt', async t => {
    const h = fixture(t); const p = h.start(); await tick(160);
    h.clock.advance(3100); await tick(80); h.change(what); h.frame('/model');
    await tick(160); h.clock.advance(1800); await tick(160); const r = await p;
    assert.equal(r.submitted, false, JSON.stringify(r)); assert.equal(h.serviceEnters, 0);
    assert.equal(h.promptCalls, 0); assert.equal(h.writes.filter(w => w.includes('/model')).length, 1);
  });
}

test('actual original cold deadline expires without /model Enter; late echo cannot replay', async t => {
  const h = fixture(t, { deadlineOffset: 5000 }); const p = h.start(); await tick(160);
  h.clock.advance(5000); await tick(160); h.clock.advance(1800); await tick(160);
  const r = await p; assert.equal(r.submitted, false, JSON.stringify(r));
  assert.equal(r.settingsResult?.code, 'agent_send_preparation_expired');
  h.frame('/model'); await tick(160); assert.equal(h.serviceEnters, 0); assert.equal(h.promptCalls, 0);
  assert.equal(h.writes.filter(w => w.includes('/model')).length, 1);
});

test('actual immediate /model echo keeps the original fast path without fixed delay', async t => {
  const h = fixture(t, { immediate: true }); const at = h.clock.now(); const r = await h.start();
  assert.equal(r.success, true, JSON.stringify(r)); assert.equal(h.clock.now(), at);
  assert.equal(h.serviceEnters, 1); assert.equal(h.promptCalls, 1);
});

test('actual same pair does not open /model', async t => {
  const h = fixture(t, { samePair: true }); const r = await h.start();
  assert.equal(r.success, true); assert.equal(h.writes.length, 0); assert.equal(h.promptCalls, 1);
});

test('actual model application/config failure never sends the original prompt', async t => {
  const h = fixture(t, { configFailure: true }); const p = h.start(); await tick(160);
  h.frame('/model'); const r = await p; assert.equal(r.submitted, false);
  assert.equal(h.serviceEnters, 1); assert.equal(h.promptCalls, 0);
});

test('actual model Enter throw remains unknown, no draft restoration or blind cleanup', async t => {
  const h = fixture(t, { capturedDraft: true, throwServiceEnter: true }); const p = h.start(); await tick(160);
  assert.equal(h.restores, 0); h.frame('/model'); const r = await p;
  assert.equal(r.settingsResult?.enterWriteUnknown, true, JSON.stringify(r));
  assert.equal(r.settingsResult?.enterWritten, null); assert.deepEqual(r.settingsResult?.draftTransfer, h.captured);
  assert.equal(h.serviceEnters, 1); assert.equal(h.restores, 0); assert.equal(h.promptCalls, 0);
  assert.equal(h.events.filter(e => e.kind === 'close-picker').length, 0);
});

test('actual prompt Enter throw stays delivery-unknown without restarting model selection', async t => {
  const h = fixture(t, { throwPromptEnter: true }); const p = h.start(); await tick(160);
  h.frame('/model'); const r = await p; assert.equal(r.deliveryUnknown, true, JSON.stringify(r));
  assert.equal(r.submitted, null); assert.equal(h.serviceEnters, 1); assert.equal(h.promptCalls, 1);
});

test('actual deferred selector retains and restores one captured text/image snapshot', async t => {
  const h = fixture(t, { capturedDraft: true }); const p = h.start(); await tick(160);
  assert.equal(h.restores, 0); assert.equal(h.queue.pending, 0);
  h.clock.advance(3100); await tick(80); h.frame('/model'); const r = await p;
  assert.equal(r.success, true, JSON.stringify(r)); assert.equal(h.restores, 1); assert.equal(h.serviceEnters, 1);
});

test('actual echo at3100ms before the original deadline submits one /model and one original prompt', async t => {
  const h = fixture(t); const p = h.start(); await tick(160);
  h.clock.advance(3100); await tick(80); h.frame('/model'); const r = await p;
  assert.equal(r.success, true, JSON.stringify(r)); assert.equal(h.serviceEnters, 1); assert.equal(h.promptCalls, 1);
});

test('actual arbitrary redraw/empty frame cannot acknowledge the owned /model insertion', async t => {
  const h = fixture(t); let done = false;
  const p = h.start().then(r => { done = true; return r; }); await tick(160);
  h.frame(''); h.clock.advance(3100); await tick(120);
  assert.equal(done, false); assert.equal(h.serviceEnters, 0);
  h.frame('/model'); const r = await p; assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(h.serviceEnters, 1);
});

test('actual expiry while reacquiring settings queue cannot renew the original preparation', async t => {
  const h = fixture(t, { deadlineOffset: 5000 }); const p = h.start(); await tick(160);
  let release;
  const blocker = h.queue.run(() => new Promise(resolve => { release = resolve; })); await tick(60);
  h.frame('/model'); await tick(100); h.clock.advance(5000); release(); await blocker;
  await tick(160); h.clock.advance(1800); await tick(160); const r = await p;
  assert.equal(r.submitted, false); assert.equal(r.settingsResult?.code, 'agent_send_preparation_expired');
  assert.equal(h.serviceEnters, 0); assert.equal(h.promptCalls, 0);
});

test('actual config proof after original expiry is historical only, never permission for prompt Enter', async t => {
  const h = fixture(t, { deadlineOffset: 5000, configTime: 2000 }); const p = h.start(); await tick(160);
  h.clock.advance(3100); await tick(80); h.frame('/model'); const r = await p;
  assert.equal(r.submitted, false, JSON.stringify(r)); assert.equal(h.serviceEnters, 1); assert.equal(h.promptCalls, 0);
});
