'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { createHistoryPreparationActivity } = require('./history-preparation-activity');

function fixture(t, prepare) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-history-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const activity = createHistoryPreparationActivity({ minBytes: 1, progressIntervalMs: 0 });
  const filename = path.join(__dirname, 'ipc/codex-data.js');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = function (id) {
    if (id === '../history-preparation-activity') return { historyPreparationActivity: activity };
    if (id === '../history-entry-window' && prepare) return { prepareHistoryRowWindow: prepare };
    return Module.prototype.require.call(this, id);
  };
  mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return { dir, activity, api: mod.exports._api };
}

test('paired projector reports real processed bytes and retains the lease through row preparation', async t => {
  let release, entered;
  t.after(() => release?.());
  const atPrepare = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  const sid = randomUUID();
  const file = path.join(f.dir, `rollout-2026-09-24T00-00-00-${sid}.jsonl`);
  const records = [{ type: 'session_meta', payload: { id: sid, cwd: '/fixture' } }];
  // More than two production read chunks, without inflating rendered text.
  for (let i = 0; i < 520; i++) records.push({ type: 'event_msg', fixturePadding: 'x'.repeat(20000), timestamp: '2026-09-24T00:00:00Z', payload: { type: 'user_message', message: 'текст ' + i } });
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const snapshots = []; f.activity.subscribe(s => snapshots.push(s));
  const request = f.api.projectCodexFullHistoryFromFile(sid, '/fixture', { sessionsDir: f.dir });
  await atPrepare;
  const operation = f.activity.snapshot().operations[0];
  assert.equal(operation.phase, 'preparing');
  assert.equal(operation.completedBytes, fs.statSync(file).size);
  assert.equal(operation.totalBytes, operation.completedBytes);
  assert.equal(operation.source.cwd, '/fixture');
  const progress = snapshots.flatMap(s => s.operations).filter(o => o.phase === 'reading').map(o => o.completedBytes);
  assert.ok(progress.length > 2);
  assert.deepEqual([...progress].sort((a, b) => a - b), progress);
  release();
  const result = await request;
  assert.equal(result.success, true);
  assert.equal(result.fedRecords, records.length);
  assert.equal(f.activity.snapshot().operations.length, 0);
  const parsed = await f.api.readJsonlRange(file, 0, fs.statSync(file).size - 1);
  assert.deepEqual(result.entries, f.api.buildCodexFullHistory(parsed.records, sid), 'progress does not alter rows/UUIDs/offsets');
  const events = snapshots.length;
  const timeline = await f.api.projectCodexTimelineFromFile(sid, '/fixture', { sessionsDir: f.dir });
  assert.equal(timeline.mode, 'unchanged');
  assert.equal(snapshots.length, events, 'warm reads do not relight loading');
});

test('metadata failure clears its exact lease and preserves a concurrent operation', async t => {
  const f = fixture(t, async () => { throw Error('controlled preparation error'); });
  const sid = randomUUID();
  const file = path.join(f.dir, `rollout-2026-09-24T00-00-00-${sid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: sid, cwd: '/fixture' } }) + '\n');
  const other = f.activity.begin({ sessionId: 'other' });
  await assert.rejects(f.api.projectCodexFullHistoryFromFile(sid, '/fixture', { sessionsDir: f.dir }), /controlled preparation error/);
  assert.deepEqual(f.activity.snapshot().operations.map(o => o.sessionId), ['other']);
  other();
});

test('reader never announces a chunk before its async consumer and propagates errors', async t => {
  const f = fixture(t);
  const file = path.join(f.dir, 'utf8.jsonl');
  const text = JSON.stringify({ text: 'Юникод\n' + 'x'.repeat(500) }) + '\n';
  fs.writeFileSync(file, text + '{"pending":');
  let release, entered;
  const atConsumer = new Promise(resolve => { entered = resolve; });
  const progress = [];
  const read = f.api.readJsonlRange(file, 0, fs.statSync(file).size - 1, {
    highWaterMark: 64, collectRecords: false,
    onProgress: bytes => progress.push(bytes),
    onRecord: async () => { entered(); await new Promise(resolve => { release = resolve; }); },
  });
  await atConsumer;
  assert.ok(progress.at(-1) < Buffer.byteLength(text), 'read-ahead is not reported as processed');
  release(); const result = await read;
  assert.equal(result.parsed, 1);
  assert.equal(progress.at(-1), fs.statSync(file).size);
  assert.equal(result.leftover, '{"pending":');
  await assert.rejects(f.api.readJsonlRange(file, 0, fs.statSync(file).size - 1, {
    onRecord: async () => { throw Error('consumer failed'); },
  }), /consumer failed/);
});
