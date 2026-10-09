'use strict';

// Actual parser/projector with synthetic protocol records only. No provider,
// process, installed app or user transcript is started/read/rewritten here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { serialize, deserialize } = require('node:v8');
const { _api } = require('./codex-data');

const sid = 'synthetic-async-cell-task';
const record = (line, payload) => ({ type: 'response_item', payload,
  __line: line, __byteOffset: line * 100, timestamp: '2026-10-09T10:00:00.000Z' });
const user = { type: 'event_msg', __line: 1, __byteOffset: 100,
  payload: { type: 'user_message', message: 'Preserve this synthetic conversation' } };
const source = 'const child=await tools.collaboration.spawn_agent({task_name:"child",message:"inspect"}); text(child);';
const call = (input = source) => record(2, { type: 'custom_tool_call', name: 'exec', call_id: 'async-exec', input });
const output = (id, parts = [], cell = null, line = 3) => record(line, {
  type: 'custom_tool_call_output', call_id: id,
  output: [{ type: 'input_text', text: cell
    ? `Script running with cell ID ${cell}\nWall time 1s\nOutput:\n`
    : 'Script completed\nWall time 1s\nOutput:\n' },
  ...parts.map(value => ({ type: 'input_text', text: typeof value === 'string' ? value : JSON.stringify(value) }))],
});
const wait = (cell = '42', line = 4) => record(line, { type: 'function_call', name: 'wait',
  call_id: 'wait-' + line, arguments: JSON.stringify({ cell_id: cell }) });
const receipt = { agent_id: 'synthetic-child-id', task_name: 'child', status: 'running' };
const actions = rows => rows.flatMap(row => row.actions || []);
const tasks = rows => actions(rows).filter(action => action.tool === 'Task');

test('ordinary async exec can finish a Task card without assuming rawTool', () => {
  const rows = _api.buildCodexFullHistory([user, call(), output('async-exec', [], '42'),
    wait(), output('wait-4', [receipt], null, 5)], sid);
  assert.equal(rows.filter(row => row.role === 'user').length, 1);
  assert.equal(tasks(rows).length, 1);
  assert.equal(tasks(rows)[0].agentSessionId, receipt.agent_id);
  assert.equal(tasks(rows)[0].subagentStatus, 'running');
  assert.equal(actions(rows).some(action => action.rawTool?.toolName === 'Wait'), false);
});

test('mixed Task and ordinary tool completion retains exact per-call output ownership', () => {
  const input = 'const child=await tools.collaboration.spawn_agent({task_name:"child",message:"inspect"}); '
    + 'const r=await tools.exec_command({cmd:"synthetic-command"}); text(child); text(r);';
  const rows = _api.buildCodexFullHistory([user, call(input), output('async-exec', [], '42'),
    wait(), output('wait-4', [receipt, 'command-output'], null, 5)], sid);
  assert.equal(tasks(rows)[0].agentSessionId, receipt.agent_id);
  const raw = actions(rows).filter(action => action.rawTool).map(action => action.rawTool);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].toolName, 'Bash');
  assert.equal(raw[0].result, 'command-output');
  assert.equal(raw[0].resultSourceLine, 5);
  assert.equal(raw[0].toolUseId, 'async-exec:canonical:1');
});

test('partial async receipts and a changed cell id continue the same conversation', () => {
  const input = 'text(await tools.collaboration.spawn_agent({task_name:"child",message:"inspect"})); '
    + 'text(await tools.exec_command({cmd:"synthetic-command"}));';
  const projector = _api.createCodexHistoryProjector(sid);
  for (const row of [user, call(input), output('async-exec', [receipt], '42'), wait(),
    output('wait-4', [], '43', 5)]) projector.feed(row);
  const before = projector.finalize();
  const childBefore = tasks(before)[0];
  for (const row of [wait('43', 6), output('wait-6', ['command-output'], null, 7)]) projector.feed(row);
  const after = projector.finalize();
  assert.equal(tasks(after).length, 1);
  assert.equal(tasks(after)[0], childBefore);
  assert.equal(tasks(after)[0].agentSessionId, receipt.agent_id);
  const raw = actions(after).find(action => action.rawTool?.toolName === 'Bash');
  assert.equal(raw.rawTool.result, 'command-output');
  assert.equal(raw.rawTool.resultSourceLine, 7);
});

test('async Task continuation survives a serialized projector checkpoint', () => {
  const projector = _api.createCodexHistoryProjector(sid);
  for (const row of [user, call(), output('async-exec', [], '42')]) projector.feed(row);
  const restored = _api.createCodexHistoryProjector(sid, deserialize(serialize(projector.exportState())));
  restored.feed(wait());
  restored.feed(output('wait-4', [receipt], null, 5));
  const rows = restored.finalize();
  assert.equal(tasks(rows).length, 1);
  assert.equal(tasks(rows)[0].agentSessionId, receipt.agent_id);
  assert.equal(rows[0].content, user.payload.message);
});
