'use strict';

// REQUIRED acceptance gates, intentionally not inverted into "negative test
// PASS". Run against the exact candidate and keep failures in its receipts.
// Finite own records only; no application/provider/user transcript or OOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('./ipc/codex-data')._api;
const { isSourceLeaf } = require('./history-source-leaf');
const isHistoryLeafRef = value => !!value && value.$historyLeaf === 'v1';

const user = (id, line) => ({ type: 'event_msg', timestamp: '2026-10-22T00:00:00Z',
  __line: line, __byteOffset: line * 100, payload: { type: 'user_message', message: id } });
const answer = (line, text = 'answer') => ({ type: 'response_item', timestamp: '2026-10-22T00:00:01Z',
  __line: line, __byteOffset: line * 100, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });

for (const count of [1, 10, 100]) {
  test('REQUIRED-CANONICAL-ROWS-' + count + ': resident row ownership <=3 after feed', t => {
    const projector = api.createCodexHistoryProjector('owned-synthetic');
    for (let index = 0; index < count; index++) { projector.feed(user('u-' + index, 2 * index)); projector.feed(answer(2 * index + 1)); }
    const state = projector.exportState();
    // An immutable root+iterator is acceptable; a retained entries[] is the
    // concrete old owner. Disk state must still enumerate all rows separately.
    const resident = Array.isArray(state.entries) ? state.entries.length : 0;
    t.diagnostic(JSON.stringify({ requiredResidentRows: 3, actualResidentRows: resident,
      source: 'actual createCodexHistoryProjector/exportState', inputTurns: count }));
    assert.ok(resident <= 3, 'canonical entries array still owns ' + resident + ' rows; immutable roots are not routed');
  });
}

for (const count of [1, 10, 100]) {
  test('REQUIRED-PENDING-' + count + ': resident raw pending-call ownership <=3', t => {
    const projector = api.createCodexHistoryProjector('owned-synthetic'); projector.feed(user('owner', 0));
    for (let index = 0; index < count; index++) projector.feed({ type: 'response_item', __line: index + 1,
      __byteOffset: (index + 1) * 100, payload: { type: 'function_call', call_id: 'call-' + index,
        name: 'read_file', arguments: '{"path":"own-synthetic"}' } });
    const state = projector.exportState(); let rawOwners = 0;
    for (const call of state.pendingCalls?.values?.() || []) if (call.record || call.args?.path) rawOwners++;
    t.diagnostic(JSON.stringify({ requiredResidentPending: 3, actualRawPendingOwners: rawOwners, inputPending: count }));
    assert.ok(rawOwners <= 3, 'canonical pendingCalls still owns ' + rawOwners + ' raw records/args');
  });
}

test('REQUIRED-LIVE-LEAF-256KiB: canonical selected field is a verified ref, not a retained whole string', t => {
  const projector = api.createCodexHistoryProjector('owned-synthetic'); projector.feed(user('owner', 0));
  // Exactly one bounded own leaf; the test does not construct a second oracle
  // graph. This asks whether the current canonical state releases that owner.
  projector.feed(answer(1, 'x'.repeat(256 * 1024)));
  const state = projector.exportState(), row = state.entries.find(item => item.role === 'assistant');
  const retainedChars = typeof row?.content === 'string' ? row.content.length : 0;
  t.diagnostic(JSON.stringify({ retainedChars, requiredSelectedTokenBytes: 64, inputLeafChars: 256 * 1024 }));
  assert.ok(isSourceLeaf(row?.content) || isHistoryLeafRef(row?.content),
    'current canonical reducer retains the complete selected field; parser LEAF opt-in is not whole-route adoption');
});
