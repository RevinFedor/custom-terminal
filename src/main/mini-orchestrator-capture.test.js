'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMiniOrchestratorCapture } = require('./mini-orchestrator-capture');

function setup() {
  const calls = []; let on = true, current = true, ready = true;
  const core = Object.fromEntries(['observeInput', 'beginTurn', 'complete', 'invalidate'].map(name => [name, (...args) => { calls.push([name, ...args]); }]));
  const capture = createMiniOrchestratorCapture({ core, isEnabled: () => on, isOwnerCurrent: () => current, isReady: () => ready });
  return { calls, capture, on: x => on = x, current: x => current = x, ready: x => ready = x };
}
const owner = { provider: 'codex', sessionId: 's', generation: 'g' };
const base = { tabId: 't', owner, sourceVerified: true, turnId: 'turn' };
const evt = (type, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
const final = { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer' }] } };
test('input on either side of start, typed final and duplicate carriers', () => {
  for (const before of [true, false]) {
    const { calls, capture } = setup();
    const input = () => capture.observeCodex({ ...base, record: evt('user_message'), inputId: 'i', inputText: 'prompt' });
    const start = () => capture.observeCodex({ ...base, record: evt('task_started') });
    if (before) { input(); start(); } else { start(); input(); }
    capture.observeCodex({ ...base, record: evt('agent_message', { phase: 'commentary', message: 'not answer' }), recordId: 'comment' });
    capture.observeCodex({ ...base, record: final, recordId: 'a' });
    capture.observeCodex({ ...base, record: evt('agent_message', { phase: 'final_answer', message: 'answer' }), recordId: 'b' });
    capture.observeCodex({ ...base, record: evt('task_complete'), completionProven: true });
    capture.observeCodex({ ...base, record: evt('task_complete'), completionProven: true });
    assert.equal(calls.filter(x => x[0] === 'complete').length, 1);
    assert.equal(calls.find(x => x[0] === 'complete')[1].answerId, 'a');
  }
});
test('no proof or no final does not complete; pending waits for event flush', () => {
  const { calls, capture, ready } = setup();
  capture.observeCodex({ ...base, record: evt('task_started') });
  capture.observeCodex({ ...base, record: evt('task_complete'), completionProven: true });
  capture.observeCodex({ ...base, record: final, recordId: 'a' });
  capture.observeCodex({ ...base, record: evt('task_complete'), completionProven: false });
  assert.equal(calls.filter(x => x[0] === 'complete').length, 0);
  ready(false); capture.observeCodex({ ...base, record: evt('task_complete'), completionProven: true });
  assert.equal(calls.filter(x => x[0] === 'complete').length, 0);
  ready(true); capture.flush('t'); capture.flush('t');
  assert.equal(calls.filter(x => x[0] === 'complete').length, 1);
});
test('stale, disabled and unverified observations are ignored; Claude truncation is unknown', () => {
  const { calls, capture, on, current } = setup();
  on(false); capture.observeCodex({ ...base, record: evt('task_started') });
  on(true); current(false); capture.observeCodex({ ...base, record: evt('task_started') });
  current(true); capture.observeCodex({ ...base, sourceVerified: false, record: evt('task_started') });
  assert.equal(calls.length, 0);
  const claude = { ...base, owner: { ...owner, provider: 'claude' } };
  capture.observeClaudeInput({ ...claude, inputId: 'i', text: 'p' });
  capture.observeClaudeCompletion({ ...claude, answerId: 'a', answer: 'partial', complete: true, truncated: true });
  assert.equal(calls.find(x => x[0] === 'complete')[1].complete, false);
});
test('canonical finals replace event alias, aggregate distinct records and deduplicate', () => {
  const { calls, capture } = setup();
  capture.observeCodex({ ...base, record: evt('task_started') });
  capture.observeCodex({ ...base, record: evt('agent_message', { phase: 'final_answer', message: 'alias' }), recordId: 'event' });
  capture.observeCodex({ ...base, record: final, recordId: 'a' });
  capture.observeCodex({ ...base, record: final, recordId: 'a' });
  capture.observeCodex({ ...base, record: { ...final, payload: { ...final.payload, content: [{ type: 'output_text', text: ' second' }] } }, recordId: 'b' });
  capture.observeCodex({ ...base, record: evt('agent_message', { phase: 'final_answer', message: 'alias' }), recordId: 'event2' });
  capture.observeCodex({ ...base, record: evt('task_complete', { last_agent_message: 'fallback' }), completionProven: true });
  const result = calls.find(x => x[0] === 'complete')[1];
  assert.equal(result.answer, 'answer second'); assert.equal(result.answerId, 'b'); assert.equal(result.complete, true);
});
test('aggregate overflow explicitly reports incomplete', () => {
  const { calls, capture } = setup();
  capture.observeCodex({ ...base, record: evt('task_started') });
  const item = text => ({ ...final, payload: { ...final.payload, content: [{ type: 'output_text', text }] } });
  capture.observeCodex({ ...base, record: item('x'.repeat(200000)), recordId: 'a' });
  capture.observeCodex({ ...base, record: item('y'.repeat(50001)), recordId: 'b' });
  capture.observeCodex({ ...base, record: evt('task_complete'), completionProven: true });
  const result = calls.find(x => x[0] === 'complete')[1];
  assert.equal(result.complete, false); assert.equal(result.answer.length, 250001);
});
