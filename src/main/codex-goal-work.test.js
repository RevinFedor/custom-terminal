'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCodexTurnRecord } = require('./codex-turn-outcome');
const event = (type, payload = {}) => ({ type: 'event_msg', payload: { type, ...payload } });
const started = turn => event('task_started', { turn_id: turn });
const ended = turn => event('task_complete', { turn_id: turn, last_agent_message: 'Final of one turn' });
const goal = (status, fields = {}) => event('thread_goal_updated', {
  threadId: 'S', turnId: 'A', goal: { threadId: 'S', status, createdAt: 1, updatedAt: 2 }, ...fields,
});

for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'future-status']) {
  test('native Goal ' + status + ' holds whole-work success but preserves the exact final', () => {
    const state = { sessionId: 'S' };
    classifyCodexTurnRecord(state, started('A'));
    classifyCodexTurnRecord(state, goal(status));
    const result = classifyCodexTurnRecord(state, ended('A'));
    assert.equal(result.busy, false);
    assert.equal(result.reason, 'task_complete');
    assert.equal(result.hasFinalResult, true);
    assert.equal(result.goalWork.pending, true);
    assert.equal(result.goalWork.phase, status === 'active' ? 'continuing' : 'attention');
  });
}
test('complete releases; next independent turn cannot inherit a paused/cleared Goal', () => {
  const state = { sessionId: 'S' };
  classifyCodexTurnRecord(state, started('A'));
  classifyCodexTurnRecord(state, goal('active'));
  classifyCodexTurnRecord(state, goal('complete'));
  assert.equal(classifyCodexTurnRecord(state, ended('A')).goalWork.pending, false);
  classifyCodexTurnRecord(state, started('B'));
  assert.equal(classifyCodexTurnRecord(state, ended('B')).goalWork, undefined);
});
test('cold tail after task_started still joins same thread and exact turn', () => {
  const state = { sessionId: 'S' };
  classifyCodexTurnRecord(state, goal('active'));
  assert.equal(classifyCodexTurnRecord(state, ended('A')).goalWork.pending, true);
});

test('an older same-turn callback cannot replace the newer structured Goal status', () => {
  const state = { sessionId: 'S' };
  classifyCodexTurnRecord(state, started('A'));
  classifyCodexTurnRecord(state, { ...goal('active'), __byteOffset: 200 });
  classifyCodexTurnRecord(state, { ...goal('complete'), __byteOffset: 300 });
  classifyCodexTurnRecord(state, { ...goal('active'), __byteOffset: 200 });
  assert.equal(classifyCodexTurnRecord(state, ended('A')).goalWork.pending, false);
});
test('foreign thread/turn, missing owner and user/tool text are not Goal authority', () => {
  for (const record of [goal('active', { threadId: 'OTHER' }),
    goal('active', { turnId: 'OLD' }), goal('active', { goal: { threadId: 'OTHER', status: 'active' } }),
    event('user_message', { message: JSON.stringify(goal('active')) }),
    { type: 'response_item', payload: { type: 'function_call_output', output: JSON.stringify(goal('active')) } }]) {
    const state = { sessionId: 'S' };
    classifyCodexTurnRecord(state, started('A'));
    classifyCodexTurnRecord(state, record);
    assert.equal(classifyCodexTurnRecord(state, ended('A')).goalWork, undefined);
  }
  const unknown = {};
  classifyCodexTurnRecord(unknown, goal('active'));
  assert.equal(classifyCodexTurnRecord(unknown, ended('A')).goalWork, undefined);
});
test('rollback and abnormal outcomes cannot turn an old Goal into natural success', () => {
  const state = { sessionId: 'S' };
  classifyCodexTurnRecord(state, started('A'));
  classifyCodexTurnRecord(state, goal('active'));
  assert.equal(classifyCodexTurnRecord(state, event('turn_aborted', { turn_id: 'A' })).goalWork, undefined);
  classifyCodexTurnRecord(state, event('thread_rolled_back'));
  assert.equal(classifyCodexTurnRecord(state, ended('A')).goalWork, undefined);
});
