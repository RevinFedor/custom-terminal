'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Exercise both active parser implementations, not a copied ownership algorithm.
const readers = [
  ['standard', require('./codex-data')._api],
  ['configured reader', require('../history-root-engine/main/ipc/codex-data')._api],
];
const instructions = version => '# AGENTS.md instructions for /fixture\n\n'
  + '<INSTRUCTIONS>\nrules ' + version + '\n</INSTRUCTIONS>';

function fixture({ carrier = 'paired', sameRules = false, compact = false } = {}) {
  const records = [];
  const add = (type, payload, tag) => {
    const index = records.length;
    const record = { type, payload, fixtureTag: tag || 'record-' + index,
      timestamp: new Date(Date.UTC(2026, 9, 31, 0, 0, index)).toISOString(),
      __line: index, __byteOffset: index * 100 };
    records.push(record);
    return record;
  };
  const message = (text, role = 'user', tag) => add('response_item', {
    type: 'message', role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  }, tag);
  const checkpoint = (version, full, tag) => add('world_state', {
    full, state: { agents_md: { directory: '/fixture', text: 'rules ' + version } },
  }, tag);
  const input = (text, kind = 'paired') => {
    if (kind !== 'event-only' && kind !== 'event-first') message(text);
    if (kind !== 'response-only') add('event_msg', { type: 'user_message', message: text });
    if (kind === 'event-first') message(text);
    message('answer:' + text, 'assistant');
    add('event_msg', { type: 'task_complete' });
  };

  add('session_meta', { id: 'checkpoint-fixture', cwd: '/fixture' });
  add('event_msg', { type: 'task_started' });
  message(instructions('A'), 'user', 'kept-instructions');
  checkpoint('A', true, 'kept-initial-state');
  add('turn_context', { model: 'gpt-6.1-sol', effort: 'high' });
  input('keep');
  // A checkpoint after a completed real input is NOT the next turn's preamble.
  checkpoint('A', false, 'kept-post-turn-state');
  if (compact) {
    add('compacted', { replacement_history: [] }, 'kept-compact');
    checkpoint('A', true, 'kept-compact-state');
    add('turn_context', { model: 'gpt-6.1-sol', effort: 'high' });
    add('event_msg', { type: 'context_compacted' });
  }
  const retained = records.slice();
  message('<permissions instructions>target only</permissions instructions>', 'developer');
  const version = sameRules ? 'A' : 'B';
  message(instructions(version), 'user', 'removed-instructions');
  checkpoint(version, true, 'removed-full-state');
  checkpoint(version, false, 'removed-patch-state');
  add('turn_context', { model: 'gpt-6.1-terra', effort: 'max' });
  add('event_msg', { type: 'task_started' });
  input('remove', carrier);
  const futureStart = records.length;
  add('event_msg', { type: 'task_started' });
  message(instructions('C'), 'user', 'future-instructions');
  checkpoint('C', false, 'future-state');
  input('future');
  return { records, retained, future: records.slice(futureStart), add, message, checkpoint };
}

for (const [name, api] of readers) {
  test(name + ': rewinding the first real input removes its instructions and checkpoints without deleting session metadata', () => {
    const { records } = fixture();
    const target = api.buildCodexTimeline(records, 'checkpoint-fixture').find(entry => entry.content === 'keep');
    const plan = api.planCodexRangeRewrite(records, 'checkpoint-fixture',
      target.uuid, target.uuid, null, { toPhysicalEnd: true });
    assert.equal(plan.success, true, plan.error);
    assert.deepEqual(plan.outputRecords.map(record => record.type), ['session_meta']);
    assert.deepEqual(plan.outputRecords[0].payload, records[0].payload);
  });

  for (const carrier of ['paired', 'event-only', 'response-only', 'event-first']) {
    for (const sameRules of [false, true]) {
      test(name + ': Rewind removes exact preamble/full+patch for ' + carrier
        + (sameRules ? ' with unchanged rules' : ' with changed rules'), () => {
        const { records, retained } = fixture({ carrier, sameRules });
        const before = JSON.stringify(records);
        const target = api.buildCodexTimeline(records, 'checkpoint-fixture')
          .find(entry => entry.type === 'user' && entry.content === 'remove');
        assert.ok(target?.uuid);
        const plan = api.planCodexRangeRewrite(records, 'checkpoint-fixture',
          target.uuid, target.uuid, null, { toPhysicalEnd: true });
        assert.equal(plan.success, true, plan.error);
        assert.deepEqual(plan.outputRecords.map(record => record.fixtureTag),
          retained.map(record => record.fixtureTag));
        assert.equal(plan.removedUsers, 2);
        assert.deepEqual(api.buildCodexTimeline(plan.outputRecords, 'checkpoint-fixture')
          .filter(entry => entry.type === 'user').map(entry => entry.content), ['keep']);
        assert.equal(JSON.stringify(records), before, 'the source stays immutable');
        const output = plan.outputRecords.find(record => record.fixtureTag === 'kept-initial-state');
        assert.deepEqual(output.payload, retained.find(record => record.fixtureTag === 'kept-initial-state').payload);
      });
    }
  }

  test(name + ': middle Delete removes only selected instructions/state, retaining future version and completed-turn state', () => {
    const { records, retained, future } = fixture();
    const target = api.buildCodexTimeline(records, 'checkpoint-fixture').find(entry => entry.content === 'remove');
    const plan = api.planCodexRangeRewrite(records, 'checkpoint-fixture', target.uuid, target.uuid);
    assert.equal(plan.success, true, plan.error);
    assert.deepEqual(plan.outputRecords.map(record => record.fixtureTag),
      [...retained, ...future].map(record => record.fixtureTag));
    assert.deepEqual(api.buildCodexTimeline(plan.outputRecords, 'checkpoint-fixture')
      .filter(entry => entry.type === 'user').map(entry => entry.content), ['keep', 'future']);
  });

  test(name + ': a retained compact baseline is not taken by the next instruction update', () => {
    const { records, retained } = fixture({ compact: true });
    const target = api.buildCodexTimeline(records, 'checkpoint-fixture').find(entry => entry.content === 'remove');
    const plan = api.planCodexRangeRewrite(records, 'checkpoint-fixture',
      target.uuid, target.uuid, null, { toPhysicalEnd: true });
    assert.equal(plan.success, true, plan.error);
    assert.deepEqual(plan.outputRecords.map(record => record.fixtureTag), retained.map(record => record.fixtureTag));
    assert.ok(plan.outputRecords.some(record => record.fixtureTag === 'kept-compact-state'));
  });

  test(name + ': a native rollback also drops the removed instructions/checkpoint before a new input', () => {
    const f = fixture();
    f.records.splice(f.records.findIndex(record => record.fixtureTag === 'future-instructions') - 1);
    f.add('event_msg', { type: 'thread_rolled_back', num_turns: 1 });
    f.add('event_msg', { type: 'task_started' });
    f.message('new input');
    f.add('event_msg', { type: 'user_message', message: 'new input' });
    f.message('new answer', 'assistant');
    const wrappers = api.buildCodexVisibleRecordWrappers(f.records, 'checkpoint-fixture');
    assert.equal(wrappers.some(row => row.record.fixtureTag === 'removed-instructions'), false);
    assert.equal(wrappers.some(row => row.record.fixtureTag === 'removed-full-state'), false);
    assert.equal(wrappers.some(row => row.record.fixtureTag === 'kept-post-turn-state'), true);
  });

  test(name + ': a late companion of a kept input cannot turn its checkpoint into the next preamble', () => {
    const f = fixture();
    const point = f.records.findIndex(record => record.fixtureTag === 'kept-post-turn-state');
    const late = { type: 'response_item', fixtureTag: 'kept-late-companion',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep' }] } };
    f.records.splice(point, 0, late);
    f.records.forEach((record, index) => { record.__line = index; });
    const target = api.buildCodexTimeline(f.records, 'checkpoint-fixture').find(entry => entry.content === 'remove');
    const plan = api.planCodexRangeRewrite(f.records, 'checkpoint-fixture',
      target.uuid, target.uuid, null, { toPhysicalEnd: true });
    assert.equal(plan.success, true, plan.error);
    assert.ok(plan.outputRecords.some(record => record.fixtureTag === 'kept-post-turn-state'));
    assert.ok(plan.outputRecords.some(record => record.fixtureTag === 'kept-late-companion'));
    assert.equal(plan.outputRecords.some(record => record.fixtureTag === 'removed-patch-state'), false);
  });

  test(name + ': a bare checkpoint before a new task is retained when no contextual preamble precedes it', () => {
    const f = fixture();
    const cut = f.records.findIndex(record => record.fixtureTag === 'removed-instructions') - 1;
    f.records.splice(cut, 4); // No new instructions or state; the next task has only its settings.
    f.records.forEach((record, index) => { record.__line = index; });
    const target = api.buildCodexTimeline(f.records, 'checkpoint-fixture').find(entry => entry.content === 'remove');
    const plan = api.planCodexRangeRewrite(f.records, 'checkpoint-fixture',
      target.uuid, target.uuid, null, { toPhysicalEnd: true });
    assert.equal(plan.success, true, plan.error);
    assert.deepEqual(plan.outputRecords.map(record => record.fixtureTag), f.retained.map(record => record.fixtureTag));
  });

  test(name + ': exact composite source ownership survives identical instructions and physical line numbers', () => {
    const a = fixture({ sameRules: true });
    const b = fixture({ sameRules: true });
    const physical = (records, id) => records.map(record => ({ ...record, __physicalSessionId: id }));
    const records = [...physical(a.records, 'physical-A'), ...physical(b.records, 'physical-B')];
    const target = api.buildCodexTimeline(records, 'composite-view').find(entry =>
      entry.type === 'user' && entry.content === 'remove' && entry.sessionId === 'physical-B');
    assert.ok(target?.uuid);
    const plan = api.planCodexRangeRewrite(records, 'composite-view',
      target.uuid, target.uuid, null, { toPhysicalEnd: true });
    assert.equal(plan.success, true, plan.error);
    assert.equal(plan.outputRecords.length, a.records.length + b.retained.length);
    assert.deepEqual(plan.outputRecords.map(record => [record.type, record.payload]),
      [...a.records, ...b.retained].map(record => [record.type, record.payload]));
  });
}
