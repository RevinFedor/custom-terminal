'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHistoryPreparationActivity, installHistoryPreparationIpc,
  MIN_HEAVY_HISTORY_BYTES } = require('./history-preparation-activity');

test('real progress is monotonic, globally bounded and cannot revive a finished owner', () => {
  let clock = 0;
  const activity = createHistoryPreparationActivity({ now: () => clock, minBytes: 1 });
  const seen = []; activity.subscribe(s => seen.push(s));
  const a = activity.begin({ sessionId: 'A', bytes: 1000, source: { toolType: 'codex', cwd: '/A' } });
  const b = activity.begin({ sessionId: 'B', bytes: 1000, source: { toolType: 'codex', cwd: '/B' } });
  a.update({ completedBytes: 100 }); b.update({ completedBytes: 200 });
  assert.equal(seen.length, 2, 'no per-record IPC');
  clock = 250; a.update({ completedBytes: 400 }); b.update({ completedBytes: 500 });
  assert.equal(seen.length, 3, 'one shared progress edge');
  assert.equal(seen[2].operations[0].completedBytes, 400);
  assert.equal(seen[0].operations[0].completedBytes, 0, 'old snapshots immutable');
  clock = 500; a.update({ completedBytes: 20 });
  assert.equal(seen.length, 3, 'backward progress ignored');
  a.update({ completedBytes: 2000, phase: 'preparing' });
  assert.equal(seen.at(-1).operations[0].completedBytes, 1000);
  assert.equal(seen.at(-1).operations[0].phase, 'preparing');
  a.update({ phase: 'reading' });
  assert.equal(seen.at(-1).operations[0].phase, 'preparing', 'late reader cannot regress phase');
  a(); const rev = activity.snapshot().revision; a.update({ completedBytes: 1000 });
  assert.equal(activity.snapshot().revision, rev);
  assert.equal(activity.snapshot().operations[0].sessionId, 'B');
  b();
});

test('concurrent large loads have exact leases; small reads do not publish', () => {
  const activity = createHistoryPreparationActivity({ epoch: 'fixture' });
  const seen = []; activity.subscribe(snapshot => seen.push(snapshot));
  activity.begin({ bytes: 1024 })();
  assert.equal(seen.length, 0);
  const first = activity.begin({ kind: 'resume', tabId: 'A', bytes: MIN_HEAVY_HISTORY_BYTES });
  const second = activity.begin({ kind: 'history', sessionId: 'B', bytes: 60e6 });
  first(); first();
  assert.equal(activity.snapshot().operations.length, 1);
  assert.equal(activity.snapshot().operations[0].sessionId, 'B');
  second();
  assert.equal(activity.snapshot().operations.length, 0);
  assert.deepEqual(seen.map(s => s.revision), [1, 2, 3, 4]);
  assert.equal(seen[0].operations.length, 1, 'published snapshots remain immutable');
});

test('failure cleanup removes only its lease and a bad subscriber cannot stop cleanup', async () => {
  const activity = createHistoryPreparationActivity();
  activity.subscribe(() => { throw Error('renderer failed'); });
  const other = activity.begin({ kind: 'resume' });
  await assert.rejects(async () => {
    const done = activity.begin();
    try { throw Error('reader failed'); } finally { done(); }
  }, /reader failed/);
  assert.equal(activity.snapshot().operations.length, 1);
  other(); assert.equal(activity.snapshot().operations.length, 0);
});

test('IPC hydrates mid-operation, sends only transitions and releases destroyed subscribers', () => {
  const activity = createHistoryPreparationActivity();
  const handlers = new Map();
  const ipcMain = { handle: (n, fn) => handlers.set(n, fn), removeHandler: n => handlers.delete(n) };
  const uninstall = installHistoryPreparationIpc({ ipcMain, activity });
  const sender = new EventEmitter(), messages = [];
  sender.isDestroyed = () => false;
  sender.send = (channel, payload) => messages.push({ channel, payload });
  const finish = activity.begin({ kind: 'resume', bytes: 60e6 });
  const snapshot = handlers.get('history-preparation:subscribe')({ sender });
  handlers.get('history-preparation:subscribe')({ sender });
  assert.equal(snapshot.operations.length, 1);
  assert.equal(sender.listenerCount('destroyed'), 1);
  finish();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.operations.length, 0);
  sender.emit('destroyed');
  activity.begin({ bytes: 60e6 })();
  assert.equal(messages.length, 1);
  uninstall(); assert.equal(handlers.size, 0);
});

test('actual Claude cold parser reports large work once; warm reads stay neutral', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { loadJsonlRecords, _api } = require('./ipc/claude-data');
  const { historyPreparationActivity: activity } = require('./history-preparation-activity');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-preparation-claude-'));
  t.after(() => { _api.resetJsonlCacheForTests(); fs.rmSync(dir, { recursive: true, force: true }); });
  _api.resetJsonlCacheForTests();
  const file = path.join(dir, 'fixture-session.jsonl');
  const line = JSON.stringify({ type: 'assistant', uuid: 'fixture', message: { content: 'x'.repeat(65536) } }) + '\n';
  fs.writeFileSync(file, line.repeat(130));
  const seen = [], unsubscribe = activity.subscribe(s => seen.push(s.operations.length));
  t.after(unsubscribe);
  await loadJsonlRecords(file);
  assert.deepEqual(seen, [1, 0]);
  await loadJsonlRecords(file);
  assert.deepEqual(seen, [1, 0]);
  assert.equal(activity.snapshot().operations.length, 0);
});

test('remaining full Codex source readers such as Fork also report known-heavy work', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { _api } = require('./ipc/codex-data');
  const { historyPreparationActivity: activity } = require('./history-preparation-activity');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-preparation-codex-'));
  const file = path.join(dir, 'fixture.jsonl');
  t.after(() => { _api.invalidateJsonlCache(file); fs.rmSync(dir, { recursive: true, force: true }); });
  const line = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(65536) } }) + '\n';
  fs.writeFileSync(file, line.repeat(130));
  const seen = [], unsubscribe = activity.subscribe(s => seen.push(s.operations.length));
  t.after(unsubscribe);
  await _api.parseJsonlFile(file);
  assert.deepEqual(seen, [1, 0]);
  await _api.parseJsonlFile(file);
  assert.deepEqual(seen, [1, 0]);
});
