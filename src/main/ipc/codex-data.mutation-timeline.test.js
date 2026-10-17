'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _api: api } = require('./codex-data');

const row = (type, payload) => ({ type, payload, timestamp: '2026-10-15T08:24:00Z' });
function fixture() {
  let toolReads = 0;
  const tool = row('response_item', { type: 'function_call', name: 'exec', call_id: 'large-tool' });
  Object.defineProperty(tool.payload, 'arguments', { enumerable: true, get() {
    toolReads++;
    return JSON.stringify({ code: 'const r = await tools.exec_command({cmd:"pwd"}); text(r);' });
  } });
  const records = [row('session_meta', { id: 'mutation-source', cwd: '/private-fixture' }),
    row('event_msg', { type: 'task_started' }),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retained' }] }),
    row('event_msg', { type: 'user_message', message: 'retained' }), tool,
    row('response_item', { type: 'function_call_output', call_id: 'large-tool', output: 'unchanged output' }),
    row('event_msg', { type: 'task_complete' }), row('event_msg', { type: 'task_started' }),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'remove last' }] }),
    row('event_msg', { type: 'user_message', message: 'remove last' }),
    row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'future' }] }),
  ].map((record, index) => ({ ...record, __line: index, __byteOffset: index * 100 }));
  return { records, tool: records[4], reads: () => toolReads, reset: () => { toolReads = 0; } };
}

test('actual tail planner never decodes retained tool bodies, while rich Timeline still enriches them', () => {
  const f = fixture();
  const before = api.buildCodexTimeline(f.records, 'mutation-source');
  assert.ok(f.reads() > 0, 'rich default still owns tool enrichment');
  const target = before.find(entry => entry.content === 'remove last');
  f.reset();
  const result = api.planCodexRangeRewrite(f.records, 'mutation-source', target.uuid, target.uuid, null, { toPhysicalEnd: true });
  assert.equal(result.success, true, result.error);
  assert.equal(f.reads(), 0, 'admission and retained semantic validation must not scan exec code');
  assert.equal(result.removedUsers, 1);
  assert.equal(result.outputRecords.some(r => r.payload === f.tool.payload), true,
    'rewrite bookkeeping may copy the envelope, never the retained payload');
  assert.equal(result.outputRecords.some(r => r.payload?.message === 'remove last'), false);
});

for (const kind of ['middle-delete', 'middle-edit']) test(kind + ': lean proof keeps the same canonical coordinates and guards', () => {
  const f = fixture(), before = api.buildCodexTimeline(f.records, 'mutation-source');
  f.reset();
  const result = api.planCodexRangeRewrite(f.records, 'mutation-source', before[0].uuid, before[0].uuid,
    kind === 'middle-edit' ? 'replacement' : null);
  assert.equal(result.success, true, result.error);assert.equal(f.reads(), 0);
  const output = api.buildCodexTimeline(result.outputRecords.map((r, __line) => ({ ...r, __line })), 'result');
  assert.deepEqual(output.filter(e => e.type === 'user').map(e => e.content),
    kind === 'middle-edit' ? ['replacement', 'remove last'] : ['remove last']);
  assert.equal(api.planCodexRangeRewrite(f.records, 'mutation-source', 'wrong-exact-id', before[0].uuid).success, false);
});

test('mutation-only mode preserves user/compact/rollback identities without changing default presentation', () => {
  const f = fixture();
  f.records.push(row('compacted', { message: 'retained compact' }),
    row('event_msg', { type: 'context_compacted' }),
    row('event_msg', { type: 'user_message', message: 'after compact' }),
    row('event_msg', { type: 'thread_rolled_back', num_turns: 1 }));
  f.records = f.records.map((r, __line) => ({ ...r, __line }));
  const rich = api.createCodexTimelineProjector('mutation-source');
  const lean = api.createCodexTimelineProjector('mutation-source', {}, { mutationOnly: true });
  for (const r of f.records) rich.feed(r);
  f.reset();for (const r of f.records) lean.feed(r);
  assert.equal(f.reads(), 0);
  const semantic = entries => entries.map(({ type, uuid, sourceIdentity, sourceLine, sessionId, turnIndex,
    content, compactSummary, hasImage, imagePaths }) => ({ type, uuid, sourceIdentity, sourceLine,
    sessionId, turnIndex, content, compactSummary, hasImage, imagePaths }));
  assert.deepEqual(semantic(lean.finalize()), semantic(rich.finalize()));
});
