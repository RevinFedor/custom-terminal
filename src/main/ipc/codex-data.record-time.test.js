const test = require('node:test');
const assert = require('node:assert/strict');
const { _api: api } = require('./codex-data');

const callAt = '2026-10-07T07:46:18.647Z';
const resultAt = '2026-10-07T07:46:23.699Z';
const record = (line, type, timestamp, payload) => ({ __line: line, __byteOffset: line * 100, type, timestamp, payload });
const user = record(1, 'event_msg', '2026-10-07T07:43:15.599Z', { type: 'user_message', message: 'inspect' });
const call = (name = 'exec_command', timestamp = callAt) => record(2, 'response_item', timestamp,
  { type: 'function_call', call_id: 'exact-call', name, arguments: JSON.stringify(name === 'exec'
    ? { code: 'const a = await tools.exec_command({cmd:"pwd"}); text(a);' } : { cmd: 'pwd' }) });
const output = record(3, 'response_item', resultAt, { type: 'function_call_output', call_id: 'exact-call', output: 'done' });
const time = (timestamp, kind, scope = 'record') => ({ version: 1, timestamp, kind, scope });

test('Codex call time stays 07:46:18 while the existing completed row timestamp is 07:46:23', () => {
  const entries = api.buildCodexFullHistory([user, call(), output], 'record-time');
  const tool = entries.find(e => e.actions?.length);
  assert.equal(tool.timestamp, resultAt, 'existing timestamp/sort contract is unchanged');
  assert.deepEqual(tool.actions[0].rawTool.recordTime, time(callAt, 'tool-call'));
});

test('pending and completed cards retain the same call time and source identity', () => {
  const pending = api.buildCodexFullHistory([user, call()], 'record-time').find(e => e.actions?.length);
  const done = api.buildCodexFullHistory([user, call(), output], 'record-time').find(e => e.actions?.length);
  assert.equal(pending.sourceIdentity, done.sourceIdentity);
  assert.deepEqual(pending.actions[0].rawTool.recordTime, time(callAt, 'tool-call'));
  assert.deepEqual(done.actions[0].rawTool.recordTime, pending.actions[0].rawTool.recordTime);
});

test('nested exec actions honestly carry shared container time', () => {
  const entry = api.buildCodexFullHistory([user, call('exec'), output], 'record-time').find(e => e.actions?.length);
  assert.ok(entry.actions.length);
  for (const action of entry.actions) assert.deepEqual(action.rawTool.recordTime, time(callAt, 'tool-call', 'container'));
});

test('canonical user and assistant text carry their own record time', () => {
  const textAt = '2026-10-07T07:47:01.000Z';
  const entries = api.buildCodexFullHistory([user, record(4, 'response_item', textAt,
    { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'a text block' }] })], 'record-time');
  assert.deepEqual(entries[0].recordTime, time(user.timestamp, 'message'));
  assert.deepEqual(entries[1].recordTime, time(textAt, 'message'));
});

test('missing call or missing/invalid source timestamp never borrows output time or Date.now', () => {
  for (const records of [[user, output], [user, call('exec_command', undefined), output], [user, call('exec_command', 'invalid'), output]]) {
    // Do not let the default parameter turn an absent field into the known fixture date.
    if (records.length === 3 && records[1].timestamp === callAt) delete records[1].timestamp;
    const entry = api.buildCodexFullHistory(records, 'record-time').find(e => e.actions?.length);
    assert.ok(entry);
    assert.equal(entry.actions[0].rawTool.recordTime, undefined);
  }
});
