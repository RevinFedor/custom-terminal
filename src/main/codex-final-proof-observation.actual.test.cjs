'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { classifyCodexTurnRecord } = require('./codex-turn-outcome');
const event = (type, extra = {}) => ({ type: 'event_msg', timestamp: '2026-10-27T03:52:54.183Z',
  __byteOffset: 10, __eventSequence: 1, payload: { type, turn_id: 'own-turn', ...extra } });
const final = (extra = {}) => ({ type: 'response_item', timestamp: '2026-10-27T03:52:54.074Z',
  __byteOffset: 20, __eventSequence: 2, payload: { type: 'message', role: 'assistant', phase: 'final_answer',
    turn_id: 'own-turn', content: [{ type: 'output_text', text: 'PRIVATE_BODY_NOT_FOR_LOG' }], ...extra } });
for (const [kind, records, expected] of [
  ['same final', [event('task_started'), final(), event('task_complete')], 'task_complete'],
  ['inline', [event('task_started'), event('task_complete', { last_agent_message: 'private inline' })], 'task_complete'],
  ['commentary', [event('task_started'), final({ phase: 'commentary' }), event('task_complete')], 'codex-no-final-result'],
  ['empty', [event('task_started'), final({ content: [] }), event('task_complete')], 'codex-no-final-result'],
  ['foreign', [event('task_started'), final({ turn_id: 'foreign' }), event('task_complete')], 'codex-no-final-result'],
  ['missing explicit ID', [event('task_started'), final({ turn_id: null }), event('task_complete')], 'codex-no-final-result'],
  ['new start resets', [event('task_started'), final(), event('task_started'), event('task_complete')], 'codex-no-final-result'],
  ['provider error wins', [event('task_started'), final(), event('task_complete', { error: { message: 'failed' } })], 'provider_error'],
  ['abort', [event('task_started'), final(), event('turn_aborted')], 'turn_aborted'],
]) test('final-proof telemetry is bounded/private and behavior-equivalent: ' + kind, async () => {
  const run = observer => { const tracker = {}, packets = [], outcomes = [];
    for (const record of records) outcomes.push(classifyCodexTurnRecord(tracker, record,
      observer ? { onFinalProofObservation: packet => { packets.push(packet); return observer(packet); } } : null));
    return { tracker, outcomes, packets }; };
  const base = run(null), observed = run(() => {});
  assert.equal(base.outcomes.at(-1).reason, expected);
  for (const next of [observed, run(() => { throw Error('diagnostic throw'); }), run(() => Promise.reject(Error('diagnostic rejected')))]) {
    assert.deepEqual(next.tracker, base.tracker); assert.deepEqual(next.outcomes, base.outcomes);
    assert.equal(JSON.stringify(next.packets).includes('PRIVATE_BODY_NOT_FOR_LOG'), false);
    assert.equal(JSON.stringify(next.packets).includes('private inline'), false);
    assert.ok(JSON.stringify(next.packets).length < 14000);
  }
  await new Promise(resolve => setImmediate(resolve));
});
test('top-level turn ID is described but never guessed into existing final authority', () => {
  const packets = [], state = {};
  classifyCodexTurnRecord(state, event('task_started'));
  const record = final({ turn_id: undefined }); record.turn_id = 'own-turn';
  classifyCodexTurnRecord(state, record, { onFinalProofObservation: packet => packets.push(packet) });
  assert.equal(packets[0].reason, 'explicit-turn-id-missing');
  assert.equal(packets[0].record.turnIdFields[3].value, 'own-turn');
  assert.equal(classifyCodexTurnRecord(state, event('task_complete')).reason, 'codex-no-final-result');
});
