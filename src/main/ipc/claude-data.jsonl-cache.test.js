'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadJsonlRecords,
  _api,
} = require('./claude-data');

let tempDir;

function record(sessionId, index) {
  return JSON.stringify({
    type: index % 7 === 0 ? 'assistant' : 'user',
    uuid: sessionId + '-uuid-' + index,
    parentUuid: index > 0 ? sessionId + '-uuid-' + (index - 1) : null,
    sessionId,
    message: {
      content: 'payload-' + index,
    },
  });
}

function writeRecords(filePath, sessionId, count) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(record(sessionId, index));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

test.beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jsonl-cache-'));
  _api.resetJsonlCacheForTests();
});

test.afterEach(() => {
  _api.resetJsonlCacheForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('large full parse yields to the event loop in bounded batches', async () => {
  const sessionId = 'yield-session';
  const filePath = path.join(tempDir, sessionId + '.jsonl');
  writeRecords(filePath, sessionId, 4_500);

  const result = await loadJsonlRecords(filePath);
  const stats = _api.getJsonlCacheStats();

  assert.equal(result.recordMap.size, 4_500);
  assert.ok(stats.parseYields >= 2);
  assert.equal(stats.files, 1);
  assert.equal(stats.rawBytes, fs.statSync(filePath).size);
});

test('parallel reads of one file join one in-flight parse', async () => {
  const sessionId = 'single-flight-session';
  const filePath = path.join(tempDir, sessionId + '.jsonl');
  writeRecords(filePath, sessionId, 4_500);

  const first = loadJsonlRecords(filePath);
  const second = loadJsonlRecords(filePath);
  const third = loadJsonlRecords(filePath);
  const results = await Promise.all([first, second, third]);
  const stats = _api.getJsonlCacheStats();

  assert.equal(stats.inflightJoins, 2);
  assert.equal(stats.inflight, 0);
  assert.equal(results[0].recordMap, results[1].recordMap);
  assert.equal(results[1].recordMap, results[2].recordMap);
});

test('incremental append preserves the existing Map and adds only new records', async () => {
  const sessionId = 'append-session';
  const filePath = path.join(tempDir, sessionId + '.jsonl');
  writeRecords(filePath, sessionId, 3);

  const first = await loadJsonlRecords(filePath);
  fs.appendFileSync(filePath, record(sessionId, 3) + '\n', 'utf8');
  const second = await loadJsonlRecords(filePath);

  assert.equal(second.recordMap, first.recordMap);
  assert.equal(second.recordMap.size, 4);
  assert.equal(second.lastRecord.uuid, sessionId + '-uuid-3');
  assert.equal(_api.getJsonlCacheStats().rawBytes, fs.statSync(filePath).size);
});

test('explicit invalidation during a yielded parse cannot republish stale data', async () => {
  const sessionId = 'invalidate-session';
  const filePath = path.join(tempDir, sessionId + '.jsonl');
  writeRecords(filePath, sessionId, 4_500);

  const pending = loadJsonlRecords(filePath);
  _api.invalidateJsonlCache(filePath);
  fs.appendFileSync(filePath, record(sessionId, 4_500) + '\n', 'utf8');

  const result = await pending;
  const stats = _api.getJsonlCacheStats();
  assert.equal(result.recordMap.size, 4_501);
  assert.equal(result.lastRecord.uuid, sessionId + '-uuid-4500');
  assert.equal(stats.files, 1);
  assert.equal(stats.inflight, 0);
});

test('LRU retains at most three parsed Claude files', async () => {
  const filePaths = [];
  for (let index = 0; index < 4; index += 1) {
    const sessionId = 'lru-session-' + index;
    const filePath = path.join(tempDir, sessionId + '.jsonl');
    writeRecords(filePath, sessionId, 2);
    filePaths.push(filePath);
    await loadJsonlRecords(filePath);
  }

  const stats = _api.getJsonlCacheStats();
  assert.equal(stats.files, 3);
  assert.deepEqual(stats.filePaths, filePaths.slice(1));
  assert.equal(
    stats.rawBytes,
    filePaths.slice(1).reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0),
  );
});
