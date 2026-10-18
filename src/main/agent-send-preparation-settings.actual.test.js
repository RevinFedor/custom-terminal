'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, drainMicrotasks: tick } = require('./fixtures/send-preparation-write.cjs');
const { createCodexSettingsMutationQueue } = require('./codex-settings-mutation-queue');
const { createCodexSettingsSendRuntime } = require(path.join(process.env.ACTUAL_SOURCE_DIR || __dirname, 'codex-settings-send'));
const { readAgentSendPreparation } = require('./agent-send-preparation');

function settings(h, { readTime = 0 } = {}) {
  const queue = createCodexSettingsMutationQueue(); h.ctx.codexSettingsMutationQueue = queue;
  const scope = () => ({ terminal: h.term, lifecycleGeneration: 'L1', runSeq: 1, live: true,
    ownerId: 'S', inputRevision: h.inputRevision, settingsObservationKey: '["S","gpt-6","high"]' });
  const runtime = createCodexSettingsSendRuntime({ readScope: scope,
    readSettings: async () => { h.clock.advance(readTime); return { ownerId: 'S', model: 'gpt-6', effort: 'high' }; },
    withSettingsQueue: operation => queue.run(operation),
    withWriteLock: (term, operation, input) => h.ctx.withPtyWriteLock(term, operation, input),
    selectSettings: () => assert.fail('the exact already-applied pair needs no settings mutation'),
    paste: h.ctx.safePasteAndSubmit,
  });
  return { queue, start: () => runtime.sendPrompt({ tabId: 'T', content: 'frozen', model: 'gpt-6', effort: 'high',
    preparation: readAgentSendPreparation(h.store, 'T', h.opts, h.opts.codexStartupFrameWait, h.clock.now),
    pasteOptions: h.opts }) };
}

test('actual settings runtime releases global queue and actual PTY before the SAME final composer wait', async t => {
  const h = fixture(t), s = settings(h); let done = false;
  const p = s.start().then(r => { done = true; return r; }); await tick(160);
  assert.equal(s.queue.pending, 0, 'a preserved preparation cannot occupy the global settings queue');
  assert.equal(h.ctx.held(), false); assert.equal(h.stages, 1);
  let independent = 0; await s.queue.run(() => { independent++; }); assert.equal(independent, 1);
  h.clock.advance(3100); await tick(100); assert.equal(done, false);
  h.frame(); const r = await p; assert.equal(r.submitted, true, JSON.stringify(r));
  assert.equal(h.stages, 1); assert.equal(h.inputRevision, 2); assert.equal(h.writes.length, 2);
});

test('actual settings + Main writer keep original cold deadline after settings work and lock release', async t => {
  const h = fixture(t, { deadlineOffset: 5000 }), s = settings(h, { readTime: 3000 });
  const p = s.start(); await tick(160);
  assert.equal(h.clock.now(), 4000); assert.equal(s.queue.pending, 0); assert.equal(h.ctx.held(), false);
  h.clock.advance(2000); await tick(160); const r = await p;
  assert.equal(r.submitted, false, JSON.stringify(r));
  h.frame(); await tick(80); assert.equal(h.writes.length, 0); assert.equal(h.stages, 1);
});

test('actual settings read which exhausts active HEAD lifetime never invokes prompt preparation', async t => {
  const h = fixture(t, { open: false }), s = settings(h, { readTime: 60000 });
  const r = await s.start(); assert.equal(r.submitted, false);
  assert.equal(h.writes.length, 0); assert.equal(h.stages, 0); assert.equal(s.queue.pending, 0);
});
