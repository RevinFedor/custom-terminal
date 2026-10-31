'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMiniOrchestrator } = require('./mini-orchestrator');
const owner = { provider: 'codex', sessionId: 's', generation: 'g' };
test('shared canonical carrier aliases merge one input, not equal text from two real inputs', async () => {
  const captured = [];
  const { c } = setup({ review: async data => { captured.push(data); return { text: 'OK' }; } });
  c.setEnabled('t', true); c.beginTurn({ tabId: 't', owner, turnId: 'turn' });
  c.observeInput({ tabId: 't', owner, inputId: 'response', text: 'same', turnId: 'turn' });
  c.observeInput({ tabId: 't', owner, inputId: 'event', inputAliases: ['response'], text: 'same', turnId: 'turn' });
  await finish(c);
  assert.equal(captured[0].inputs.length, 1); assert.equal(captured[0].inputs[0].inputId, 'event');
  c.beginTurn({ tabId: 't', owner, turnId: 'second' });
  for (const inputId of ['real-send-A', 'real-send-B']) c.observeInput({ tabId: 't', owner, inputId, text: 'same', turnId: 'second' });
  await c.complete({ tabId: 't', owner, turnId: 'second', answerId: 'a2', answer: 'answer', complete: true, sourceVerified: true });
  assert.equal(captured[1].inputs.length, 2); c.dispose();
});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function setup(overrides = {}) {
  let n = 0; const writes = [], sends = [];
  const c = createMiniOrchestrator({ uuid: () => String(++n), isCurrent: () => true, persist: (...x) => writes.push(x), loadInstruction: async () => ({ id: 'i', text: 'rules' }), review: async () => ({ text: 'ok' }), sendCorrection: async x => { sends.push(x); return { status: 'sent' }; }, ...overrides });
  return { c, writes, sends };
}
function start(c) { c.setEnabled('t', true); c.observeInput({ tabId: 't', owner, inputId: 'in', text: 'request' }); c.beginTurn({ tabId: 't', owner, turnId: 'turn' }); }
function finish(c) { return c.complete({ tabId: 't', owner, turnId: 'turn', answerId: 'a', answer: 'answer', complete: true, sourceVerified: true }); }
test('default off, input before turn, duplicate completion', async () => {
  const { c } = setup(); assert.equal(c.observeInput({ tabId: 't', owner, inputId: 'x', text: 'x' }), false);
  start(c); assert.equal(await finish(c), true); assert.equal(await finish(c), false); assert.equal(c.snapshot('t').phase, 'complete');
  const snap = c.snapshot('t'); snap.entries.length = 0; assert.notEqual(c.snapshot('t').entries.length, 0);
});
test('start before input and missing proof never reviews', async () => {
  let count = 0; const { c } = setup({ review: async () => { count++; return { text: 'ok' }; } });
  c.setEnabled('t', true); c.beginTurn({ tabId: 't', owner, turnId: 'turn' });
  assert.equal(await finish(c), false); assert.equal(count, 0);
  c.observeInput({ tabId: 't', owner, inputId: 'in', text: 'x' }); assert.equal(await finish(c), true); assert.equal(count, 1);
});
test('one handoff, durable attempt before send, second refused', async () => {
  let calls = 0, writes = [];
  const { c } = setup({ persist: (tab, ledger) => writes.push(ledger), sendCorrection: async x => { calls++; assert.equal(writes.at(-1)[0].attempted, true); assert.equal(x.handoffId, 'mini-orchestrator:' + x.jobId); return { status: 'sent' }; }, review: async ({ onSendPrompt }) => { assert.equal((await onSendPrompt('fix')).status, 'sent'); assert.equal((await onSendPrompt('again')).status, 'refused'); return { text: 'done' }; } });
  start(c); await finish(c); assert.equal(calls, 1);
});
test('persist failure prevents send', async () => {
  let calls = 0; const { c } = setup({ persist: () => { throw Error('disk'); }, sendCorrection: async () => { calls++; }, review: async ({ onSendPrompt }) => { await onSendPrompt('fix'); return { text: 'done' }; } });
  start(c); await finish(c); assert.equal(calls, 0);
});
test('off during send preserves actual late receipt', async () => {
  const gate = deferred(), entered = deferred();
  const { c } = setup({ sendCorrection: async () => { entered.resolve(); return gate.promise; }, review: async ({ onSendPrompt }) => { await onSendPrompt('fix'); return { text: 'done' }; } });
  start(c); const p = finish(c); await entered.promise; c.setEnabled('t', false); gate.resolve({ status: 'sent', token: 'actual' }); await p;
  assert.equal(c.snapshot('t').phase, 'off'); assert.equal(c.snapshot('t').entries.find(x => x.type === 'tool').receipt.token, 'actual');
});
test('oversize and new turn cannot inherit old request', async () => {
  const { c } = setup(); start(c); c.beginTurn({ tabId: 't', owner, turnId: 'next' });
  assert.equal(await c.complete({ tabId: 't', owner, turnId: 'next', answerId: 'x', answer: 'a', complete: true, sourceVerified: true }), false);
  c.observeInput({ tabId: 't', owner, inputId: 'big', text: 'x'.repeat(250001) }); assert.equal(c.snapshot('t').phase, 'unknown');
});
test('rehydrated ledger refuses same completed identity without restoring enabled', async () => {
  let saved = []; const a = setup({ persist: (_tab, ledger) => { saved = ledger; } }); start(a.c); await finish(a.c);
  let reviews = 0; const b = setup({ loadLedger: () => saved, review: async () => { reviews++; return { text: 'bad' }; } });
  assert.equal(b.c.snapshot('t').enabled, false); start(b.c); assert.equal(await finish(b.c), false); assert.equal(reviews, 0);
});
test('writer guard requires persisted current attempt and revokes on invalidate', async () => {
  const gate = deferred(), entered = deferred(); let handoff;
  const { c } = setup({ sendCorrection: async x => { handoff = x.handoffId; entered.resolve(); return gate.promise; }, review: async ({ onSendPrompt }) => { await onSendPrompt('fix'); return { text: 'done' }; } });
  start(c); const p = finish(c); await entered.promise; assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), true);
  c.invalidate('t', 'own correction observed'); assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), false); gate.resolve({ status: 'sent' }); await p;
  assert.equal(c.snapshot('t').entries.find(x => x.type === 'tool').receipt.status, 'sent');
});
test('settled ledger eviction is persisted, unknown attempt is retained', async () => {
  const ledger = Array.from({ length: 64 }, (_, i) => ({ identity: 'old' + i, jobId: 'j' + i, attempted: i === 0, settled: true, ...(i === 0 ? { receipt: { status: 'unknown' } } : {}) }));
  let saved; const { c } = setup({ loadLedger: () => ledger, persist: (_tab, x) => { saved = x; } }); start(c); assert.equal(await finish(c), true);
  assert.equal(saved.length, 64); assert.ok(saved.some(x => x.identity === 'old0')); assert.ok(!saved.some(x => x.identity === 'old1'));
});
test('feedback carries latest sent corrections and notices stay bounded', async () => {
  let feedback; const ledger = Array.from({ length: 6 }, (_, i) => ({ identity: 'old' + i, jobId: 'j' + i, attempted: true, settled: true, feedback: 'f' + i, receipt: { status: 'sent' } }));
  const { c } = setup({ loadLedger: () => ledger, review: async x => { feedback = x.previousFeedback; return { text: 'ok' }; } });
  start(c); await finish(c); assert.deepEqual(feedback, ['f2', 'f3', 'f4', 'f5']);
  for (let i = 0; i < 100; i++) c.invalidate('t', 'notice'); assert.equal(c.snapshot('t').entries.filter(x => x.type === 'notice').length, 1);
});
test('queued correction remains guarded after review, late receipt after off', async () => {
  let handoff, saved; const { c } = setup({ persist: (_t, l) => { saved = l; }, sendCorrection: async x => { handoff = x.handoffId; return { status: 'queued' }; }, review: async ({ onSendPrompt }) => { await onSendPrompt('fix'); return { text: 'done' }; } });
  start(c); await finish(c); assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), true);
  c.setEnabled('t', false); assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), false);
  assert.equal(c.observeSendReceipt({ tabId: 't', handoffId: handoff, receipt: { status: 'sent', proof: 'native' } }), true);
  assert.equal(saved.find(x => x.handoffId === handoff).receipt.proof, 'native'); assert.equal(c.snapshot('t').entries.find(x => x.type === 'tool').receipt.proof, 'native');
});
test('new input revokes queued guard; exact correction handoff carries root and prevents repeated feedback', async () => {
  let handoff, seen, second; let round = 0;
  const { c } = setup({ sendCorrection: async x => { handoff = x.handoffId; return { status: 'queued' }; }, review: async ({ onSendPrompt, inputs, previousFeedback }) => { round++; if (round === 1) await onSendPrompt('fix'); else { seen = { inputs, previousFeedback }; second = await onSendPrompt('fix'); } return { text: 'done' }; } });
  start(c); await finish(c); c.observeSendReceipt({ tabId: 't', handoffId: handoff, receipt: { status: 'sent' } });
  c.observeInput({ tabId: 't', owner, inputId: 'correction', text: 'fix', correctionHandoffId: handoff });
  assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), false);
  c.beginTurn({ tabId: 't', owner, turnId: 'next' }); await c.complete({ tabId: 't', owner, turnId: 'next', answerId: 'a2', answer: 'answer', complete: true, sourceVerified: true });
  assert.deepEqual(seen.inputs.map(x => x.text), ['request', 'fix']); assert.deepEqual(seen.previousFeedback, ['fix']); assert.equal(second.error, 'no_review_progress');
});
test('unchanged answer cannot cause another correction even if feedback is rephrased', async () => {
  let handoff, sends = 0, refusal, round = 0;
  const { c } = setup({ sendCorrection: async x => { sends++; handoff = x.handoffId; return { status: 'sent' }; }, review: async ({ onSendPrompt }) => { round++; const r = await onSendPrompt(round === 1 ? 'fix this' : 'please correct it'); if (round === 2) refusal = r; return { text: 'review' }; } });
  start(c); await finish(c);
  c.observeInput({ tabId: 't', owner, inputId: 'correction', text: 'fix this', correctionHandoffId: handoff });
  c.beginTurn({ tabId: 't', owner, turnId: 'next' });
  await c.complete({ tabId: 't', owner, turnId: 'next', answerId: 'a2', answer: 'answer', complete: true, sourceVerified: true });
  assert.equal(sends, 1); assert.equal(refusal.error, 'no_review_progress');
});
test('new input intent preserves collected root and revokes active review', async () => {
  let inputs, handoff;
  const { c } = setup({ sendCorrection: async x => { handoff = x.handoffId; return { status: 'queued' }; }, review: async x => { inputs = x.inputs; await x.onSendPrompt('fix'); return { text: 'done' }; } });
  start(c); const before = c.snapshot('t').revision; assert.equal(c.invalidateReview('t', 'typing'), false); assert.equal(c.snapshot('t').revision, before);
  c.observeInput({ tabId: 't', owner, inputId: 'clarification', text: 'more', turnId: 'turn' }); await finish(c);
  assert.deepEqual(inputs.map(x => x.text), ['request', 'more']); assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), true);
  assert.equal(c.invalidateReview('t', 'new input'), true); assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), false);
});
test('canonical queued survives later RPC unknown until terminal receipt', async () => {
  let c, handoff;
  ({ c } = setup({ sendCorrection: async x => { handoff = x.handoffId; c.observeSendReceipt({ tabId: 't', handoffId: handoff, receipt: { status: 'queued', proof: 'main' } }); return { status: 'unknown' }; }, review: async ({ onSendPrompt }) => { assert.equal((await onSendPrompt('fix')).status, 'queued'); return { text: 'done' }; } }));
  start(c); await finish(c); assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), true);
  assert.equal(c.snapshot('t').entries.find(x => x.type === 'tool').receipt.proof, 'main');
  c.observeSendReceipt({ tabId: 't', handoffId: handoff, receipt: { status: 'no-input' } });
  assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), false);
  c.observeSendReceipt({ tabId: 't', handoffId: handoff, receipt: { status: 'unknown' } });
  assert.equal(c.snapshot('t').entries.find(x => x.type === 'tool').receipt.status, 'no-input');
});
test('RPC unknown retains original pending guard until later canonical queue receipt', async () => {
  let handoff;
  const { c } = setup({ sendCorrection: async x => { handoff = x.handoffId; return { status: 'unknown' }; }, review: async ({ onSendPrompt }) => { await onSendPrompt('fix'); return { text: 'done' }; } });
  start(c); await finish(c);
  assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), true);
  assert.equal(c.validateSend({ tabId: 't', handoffId: handoff + '-other' }), false);
  c.observeSendReceipt({ tabId: 't', handoffId: handoff, receipt: { status: 'queued' } });
  assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), true);
  c.observeSendReceipt({ tabId: 't', handoffId: handoff, receipt: { status: 'unknown' } });
  assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), true);
  c.observeSendReceipt({ tabId: 't', handoffId: handoff, receipt: { status: 'refused' } });
  assert.equal(c.validateSend({ tabId: 't', handoffId: handoff }), false);
});
