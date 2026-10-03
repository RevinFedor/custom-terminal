'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./codex-provider-wrapper-receipt.fixture.cjs');

test('message source traverses the actual Codex wrapper and native queue matcher once', async t => {
  const h = harness(t, { source: 'tab-message:question-1' });
  if (!h) return;
  const target = { toolType: 'codex', sessionId: 'session-a' };
  const first = await h.send({ expectedTarget: target });
  assert.equal(first.status, 'queued');
  assert.equal(h.store.list().length, 1);
  assert.equal(h.store.list()[0].receipt.source, 'codex-tab-message:question-1');
  const enterCount = h.writes.filter(write => write.text === '\r').length;
  assert.equal(enterCount, 1);
  await h.send({ expectedTarget: target });
  assert.equal(h.writes.filter(write => write.text === '\r').length, enterCount);
  assert.equal(h.attempts(), 1);
});

test('message reply cannot cross into a replacement session during physical preparation', async t => {
  const h = harness(t, { source: 'tab-message:reply-1',
    beforeDrain: setWriter => setWriter('other-session') });
  if (!h) return;
  const result = await h.send({ expectedTarget: { toolType: 'codex', sessionId: 'session-a' } });
  assert.equal(result.code, 'agent_send_target_changed');
  assert.equal(result.submitted, false);
  assert.equal(h.writes.length, 0);
});

test('an old queue frame does not confirm a newly sent message', async t => {
  const h = harness(t, { source: 'tab-message:question-2', frameFault: 'no-growth' });
  if (!h) return;
  const result = await h.send({ expectedTarget: { toolType: 'codex', sessionId: 'session-a' } });
  assert.notEqual(result.status, 'queued');
  assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
  assert.notEqual(h.store.list()[0].state, 'confirmed');
});
