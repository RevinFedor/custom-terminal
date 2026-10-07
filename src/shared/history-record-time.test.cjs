const test = require('node:test');
const assert = require('node:assert/strict');
const { historyRecordTimeFromRecord, normalizeHistoryRecordTime, historyRecordTimeEqual } = require('./history-record-time.cjs');
const { makeHistoryRowStub } = require('../main/history-entry-window');
const { projectHistoryOnDemand, HistoryPayloadStash } = require('../main/history-payload-dehydrate');
const { fingerprintHistoryEntry } = require('../main/history-delta');
const at = '2026-10-07T07:46:18.647Z';
const time = historyRecordTimeFromRecord({ timestamp: at }, 'tool-call');

test('unknown, arrival-only, malformed and epoch fallback timestamps stay unknown', () => {
  for (const record of [null, {}, { receivedAt: at }, { timestamp: 'bad' }, { timestamp: '1970-01-01T00:00:00.000Z' }, { timestamp: Date.now() }]) {
    assert.equal(historyRecordTimeFromRecord(record), undefined);
  }
  assert.equal(normalizeHistoryRecordTime({ ...time, scope: 'arrival' }), undefined);
  assert.equal(normalizeHistoryRecordTime({ ...time, version: 2 }), undefined);
  assert.ok(historyRecordTimeEqual(time, { ...time }));
  assert.equal(historyRecordTimeEqual(time, { ...time, scope: 'container' }), false);
});

test('row stubs and on-demand action headers retain time without a payload read', () => {
  const entry = { uuid: 'A', role: 'assistant', timestamp: '2026-10-07T07:46:23.699Z', recordTime: { ...time, kind: 'message' },
    content: 'text', actions: [{ tool: '__raw__', rawTool: { toolUseId: 'call', toolName: 'Bash', args: { command: 'pwd' }, result: 'done', recordTime: time } }] };
  const before = JSON.stringify(entry);
  const stub = makeHistoryRowStub(entry);
  assert.deepEqual(stub.recordTime, entry.recordTime);
  assert.deepEqual(stub.actionSummary[0].recordTime, time);
  const headers = projectHistoryOnDemand({ toolType: 'codex', sessionId: 'S', entries: [entry], stash: new HistoryPayloadStash() });
  assert.deepEqual(headers[0].actions[0].rawTool.recordTime, time);
  assert.deepEqual(headers[0].actionSummary[0].recordTime, time);
  assert.equal(JSON.stringify(entry), before, 'presentation metadata never rewrites its source');
});

test('timestamp metadata-only changes invalidate delta fingerprints for text, raw actions and Task', () => {
  const entry = { uuid: 'A', role: 'assistant', content: 'same', timestamp: at };
  const first = fingerprintHistoryEntry(entry);
  entry.recordTime = { ...time, kind: 'message' };
  assert.notEqual(fingerprintHistoryEntry(entry), first);
  for (const action of [{ tool: '__raw__', rawTool: { toolUseId: 'call', toolName: 'Bash', recordTime: time } }, { tool: 'Task', toolUseId: 'task', recordTime: time }]) {
    const row = { ...entry, actions: [action] };
    const previous = fingerprintHistoryEntry(row);
    const data = action.rawTool || action;
    data.recordTime = { ...time, scope: 'container' };
    assert.notEqual(fingerprintHistoryEntry(row), previous);
  }
});
