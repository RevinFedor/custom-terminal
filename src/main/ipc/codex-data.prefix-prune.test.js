const test = require('node:test');
const assert = require('node:assert/strict');
const { _api } = require('./codex-data');

const rec = (type, payload) => ({ type, payload });
const user = text => rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const developer = text => rec('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
const compact = () => rec('compacted', { replacement_history: [] });
const numbered = records => records.map((record, __line) => ({ ...record, __line }));
const rows = records => _api.buildCodexTimeline(records, 'synthetic-prune');
const contains = (output, record) => output.some(item => item.type === record.type && JSON.stringify(item.payload) === JSON.stringify(record.payload));

test('prefix pruning retains four compacts and the complete unowned tail of the retained compact', () => {
  const tail = [developer('additional instruction'), rec('turn_context', { model: 'gpt-6-sol', effort: 'high' }),
    rec('response_item', { type: 'function_call', call_id: 'tail-call', name: 'tool', arguments: '{}' }),
    rec('response_item', { type: 'function_call_output', call_id: 'tail-call', output: 'tail-result' }),
    rec('event_msg', { type: 'task_complete' })];
  const records = numbered([rec('session_meta', { id: 'synthetic-prune' }),
    ...Array.from({ length: 7 }, (_, index) => [user(`U${index}`), compact()]).flat(), ...tail]);
  const timeline = rows(records);
  const retainedUserIndex = timeline.findIndex(row => row.content === 'U3');
  const plan = _api.planCodexRangeRewrite(records, 'synthetic-prune', timeline[0].uuid, timeline[retainedUserIndex - 1].uuid);
  assert.equal(plan.success, true, JSON.stringify(plan));
  assert.equal(rows(numbered(plan.outputRecords)).filter(row => row.type === 'compact').length, 4);
  for (const record of tail) assert.ok(contains(plan.outputRecords, record), `retained ${record.type}/${record.payload.type || ''}`);
});

test('middle compact cleanup removes only its orphan preambles, not another retained compact tail', () => {
  const removed = [developer('deleted instruction'), rec('turn_context', { model: 'removed-model' })];
  const retained = [developer('retained instruction'), rec('turn_context', { model: 'retained-model' })];
  const records = numbered([user('before'), compact(), ...removed,
    rec('response_item', { type: 'function_call_output', call_id: 'old', output: 'boundary' }),
    compact(), ...retained]);
  const timeline = rows(records);
  const target = timeline.find(row => row.type === 'compact');
  const plan = _api.planCodexRangeRewrite(records, 'synthetic-prune', target.uuid, target.uuid);
  assert.equal(plan.success, true, JSON.stringify(plan));
  for (const record of removed) assert.equal(contains(plan.outputRecords, record), false);
  for (const record of retained) assert.ok(contains(plan.outputRecords, record));
  assert.equal(rows(numbered(plan.outputRecords)).filter(row => row.type === 'compact').length, 1);
});

test('default prefix expansion still removes consecutive compact snapshots before a response-only user', () => {
  const retained = developer('next user instruction');
  const records = numbered([user('delete'), compact(), compact(), retained, user('keep')]);
  const timeline = rows(records);
  const plan = _api.planCodexRangeRewrite(records, 'synthetic-prune', timeline[0].uuid, timeline[0].uuid);
  assert.equal(plan.success, true, JSON.stringify(plan));
  assert.deepEqual(rows(numbered(plan.outputRecords)).map(row => row.content), ['keep']);
  assert.ok(contains(plan.outputRecords, retained), 'owned preamble follows the retained response-only user');
});

test('new-root compact deletion removes root-only preambles while retaining the next compact tail', () => {
  const removed = developer('old root instruction');
  const retained = developer('new compact instruction');
  const records = numbered([rec('session_meta', { id: 'synthetic-prune' }), removed,
    compact(), user('keep'), compact(), retained]);
  const timeline = rows(records);
  const plan = _api.planCodexRangeRewrite(records, 'synthetic-prune', timeline[0].uuid, timeline[0].uuid);
  assert.equal(plan.success, true, JSON.stringify(plan));
  assert.equal(contains(plan.outputRecords, removed), false);
  assert.ok(contains(plan.outputRecords, retained));
});

test('orphan cleanup never crosses a composite physical-source boundary', () => {
  const removed = developer('source A instruction');
  const retained = developer('source B instruction');
  const segment = (id, records) => numbered(records).map(record => ({ ...record, __physicalSessionId: id }));
  const records = [...segment('source-A', [user('before'), compact(), removed]),
    ...segment('source-B', [rec('session_meta', { id: 'source-B' }), retained, compact()])];
  const target = rows(records).find(row => row.type === 'compact' && row.sessionId === 'source-A');
  assert.ok(target);
  const plan = _api.planCodexRangeRewrite(records, 'synthetic-prune', target.uuid, target.uuid);
  assert.equal(plan.success, true, JSON.stringify(plan));
  assert.equal(contains(plan.outputRecords, removed), false);
  assert.ok(contains(plan.outputRecords, retained));
});
