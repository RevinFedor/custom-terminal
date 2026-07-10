const test = require('node:test');
const assert = require('node:assert/strict');

const { _api } = require('./codex-data');

function compactFixture() {
  return [
    { __line: 10, type: 'compacted', timestamp: '2026-07-10T10:00:00Z', payload: { replacement_history: [] } },
    { __line: 11, type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { __line: 12, type: 'response_item', payload: { type: 'message', role: 'developer', content: [] } },
    { __line: 13, type: 'turn_context', payload: { model: 'gpt-5' } },
    { __line: 14, type: 'event_msg', payload: { type: 'task_started' } },
    { __line: 20, type: 'event_msg', timestamp: '2026-07-10T10:00:01Z', payload: { type: 'context_compacted' } },
    { __line: 21, type: 'event_msg', timestamp: '2026-07-10T10:00:02Z', payload: { type: 'user_message', message: 'continue' } },
    { __line: 30, type: 'event_msg', timestamp: '2026-07-10T10:00:03Z', payload: { type: 'context_compacted' } },
  ];
}

test('pairs a compact telemetry companion across an arbitrary technical gap', () => {
  const records = compactFixture();
  assert.deepEqual([..._api.codexCompactCompanionLines(records)], [20]);

  const timeline = _api.buildCodexTimeline(records, 'session');
  assert.equal(timeline.filter((entry) => entry.type === 'compact').length, 2);

  const history = _api.buildCodexFullHistory(records, 'session');
  assert.equal(history.filter((entry) => entry.role === 'compact').length, 2);

  const clean = _api.buildCodexCleanEntries(records, 'session');
  assert.equal(clean.filter((entry) => entry.kind === 'compact').length, 2);
});

test('a real user turn ends pending companion pairing', () => {
  const records = [
    { __line: 1, type: 'compacted', payload: {} },
    { __line: 2, type: 'event_msg', payload: { type: 'user_message', message: 'new work' } },
    { __line: 3, type: 'event_msg', payload: { type: 'context_compacted' } },
  ];
  assert.equal(_api.codexCompactCompanionLines(records).size, 0);
  assert.equal(_api.buildCodexTimeline(records, 'session').filter((entry) => entry.type === 'compact').length, 2);
});
