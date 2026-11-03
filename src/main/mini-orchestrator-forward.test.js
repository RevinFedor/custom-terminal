'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMiniOrchestrator } = require('./mini-orchestrator');
const { createMiniOrchestratorForward, buildForwardPrompt } = require('./mini-orchestrator-forward');
const owner = { provider: 'codex', sessionId: 'sid', generation: 'gen' };

function setup(overrides = {}) {
  let n = 0; const sends = [];
  const forward = createMiniOrchestratorForward(overrides.forwardOptions || {});
  const c = createMiniOrchestrator({ uuid: () => String(++n), isCurrent: () => true,
    loadInstruction: async () => ({ id: 'i', text: 'RULES', mode: 'forward',
      reviewerTabId: 'reviewer-tab', sourceTabId: 'work-tab', revision: 'forward:1:reviewer-tab' }),
    review: forward,
    sendCorrection: async request => { sends.push(request); return { status: 'queued', handoffId: request.handoffId }; },
    ...overrides });
  return { c, sends };
}
function run(c, { text = 'original question', answer = 'incomplete answer' } = {}) {
  c.setEnabled('work-tab', true);
  c.observeInput({ tabId: 'work-tab', owner, inputId: 'in1', text });
  c.beginTurn({ tabId: 'work-tab', owner, turnId: 'turn1' });
  return c.complete({ tabId: 'work-tab', owner, turnId: 'turn1', answerId: 'a1', answer, complete: true, sourceVerified: true });
}

test('completed answer is forwarded to the chosen reviewer tab, not to the reviewed tab itself', async () => {
  const { c, sends } = setup();
  assert.equal(await run(c), true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].targetTabId, 'reviewer-tab', 'recipient is the reviewer');
  assert.equal(sends[0].tabId, 'work-tab', 'calling identity stays the reviewed tab');
  assert.match(sends[0].prompt, /RULES/);
  assert.match(sends[0].prompt, /original question/);
  assert.match(sends[0].prompt, /incomplete answer/);
  assert.match(sends[0].prompt, /tabId:"work-tab"/, 'reviewer is told to answer the reviewed tab');
  c.dispose();
});

test('forward sends exactly once per completed answer and never replays the same answer', async () => {
  const { c, sends } = setup();
  await run(c);
  assert.equal(await run(c), false, 'same identity is refused by the ledger');
  assert.equal(sends.length, 1);
  c.dispose();
});

test('a new completed answer in the same chat forwards again as its own round', async () => {
  const { c, sends } = setup();
  await run(c);
  c.observeInput({ tabId: 'work-tab', owner, inputId: 'in2', text: 'second question' });
  c.beginTurn({ tabId: 'work-tab', owner, turnId: 'turn2' });
  await c.complete({ tabId: 'work-tab', owner, turnId: 'turn2', answerId: 'a2', answer: 'another answer', complete: true, sourceVerified: true });
  assert.equal(sends.length, 2);
  assert.notEqual(sends[0].handoffId, sends[1].handoffId);
  const rounds = new Set(c.snapshot('work-tab').entries.map(e => e.round));
  assert.equal(rounds.size, 2, 'both rounds stay visible');
  c.dispose();
});

test('missing reviewer target is an error, never a silent send to the reviewed tab', async () => {
  const { c, sends } = setup({ loadInstruction: async () => ({ id: 'i', text: 'RULES', mode: 'forward' }) });
  assert.equal(await run(c), false);
  assert.equal(sends.length, 0);
  assert.equal(c.snapshot('work-tab').phase, 'error');
  c.dispose();
});

test('Off or a new user input before delivery revokes the forward', async () => {
  let resolveSend; const gate = new Promise(r => { resolveSend = r; });
  let entered; const started = new Promise(r => { entered = r; });
  const { c, sends } = setup({ sendCorrection: async request => { sends.push(request); entered(); await gate; return { status: 'sent' }; } });
  c.setEnabled('work-tab', true);
  c.observeInput({ tabId: 'work-tab', owner, inputId: 'in1', text: 'q' });
  c.beginTurn({ tabId: 'work-tab', owner, turnId: 'turn1' });
  const done = c.complete({ tabId: 'work-tab', owner, turnId: 'turn1', answerId: 'a1', answer: 'answer', complete: true, sourceVerified: true });
  await started;
  c.setEnabled('work-tab', false);
  resolveSend();
  await done;
  assert.equal(sends.length, 1, 'the already-attempted handoff is not replayed');
  assert.equal(c.validateSend({ tabId: 'work-tab', handoffId: sends[0].handoffId }), false);
  c.dispose();
});

test('prompt carries bounded sections and marks application truncation', () => {
  const prompt = buildForwardPrompt({ instruction: { text: 'I' }, inputs: [{ inputId: 'q', text: 'Q' }],
    answer: 'x'.repeat(250001), owner, turnId: 'turn', jobId: 'job', source: { tabId: 'work-tab', name: 'Работа' } });
  assert.match(prompt, /обрезано приложением/);
  assert.match(prompt, /Работа \(work-tab\)/);
  assert.match(prompt, /не повышение твоих/);
});

test('the guard accepts the controller send even though the recipient tab owns no review', async () => {
  // The Main guard runs against the RECIPIENT tab while the review lives on the
  // reviewed tab, so it must still recognise the controller's own handoff.
  let guarded = null, seen = 0, controller;
  const captured = [];
  controller = createMiniOrchestrator({ uuid: () => String(++seen), isCurrent: () => true,
    loadInstruction: async () => ({ id: 'i', text: 'RULES', mode: 'forward',
      reviewerTabId: 'reviewer-tab', sourceTabId: 'work-tab', revision: 'forward:1:reviewer-tab' }),
    review: createMiniOrchestratorForward(),
    sendCorrection: async request => {
      captured.push(request);
      guarded = controller.validateSend({ tabId: request.targetTabId, handoffId: request.handoffId });
      return { status: 'sent' };
    } });
  await run(controller);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].targetTabId, 'reviewer-tab');
  assert.equal(guarded, true, 'forward send must not be rejected as a stale foreign handoff');
  controller.dispose();
});

test('an unrelated handoff is still rejected on every tab', async () => {
  const { c } = setup();
  await run(c);
  assert.equal(c.validateSend({ tabId: 'reviewer-tab', handoffId: 'mini-orchestrator:not-a-real-job' }), false);
  assert.equal(c.validateSend({ tabId: 'work-tab', handoffId: 'mini-orchestrator:not-a-real-job' }), false);
  c.dispose();
});
