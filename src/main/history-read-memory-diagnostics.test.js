'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { beginHistoryReadDiagnostic } = require('./history-read-memory-diagnostics');

test('memory phases carry isolate/limit evidence without reading payloads or duplicating completion', () => {
  const records = [], original = console.log;
  console.log = value => records.push(JSON.parse(value.slice('[HistoryReadMemory] '.length)));
  try {
    const identity = { sessionId: 'fixture-sid', provider: 'codex', get body() { throw Error('body read'); } };
    const diagnostic = beginHistoryReadDiagnostic('catalog-candidate', identity);
    diagnostic.end('success', { totalIterations: 9, get payload() { throw Error('payload serialized'); } });
    diagnostic.end('error');
  } finally { console.log = original; }
  assert.equal(records.length, 2);
  assert.equal(records[0].phase, 'start');
  assert.equal(records[1].phase, 'complete');
  assert.equal(records[1].readId, records[0].readId);
  assert.equal(records[1].totalIterations, 9);
  assert.ok(records[1].heapLimitBytes > 0);
  assert.ok(records[1].processRssBytes > 0);
  assert.equal(records[1].isolate, 'main');
  assert.match(records[1].coverage, /not-peak/);
  assert.ok(!Object.hasOwn(records[1], 'body'));
});

test('a failed diagnostic sink cannot fail a read', () => {
  const original = console.log;
  console.log = () => { throw Error('sink'); };
  try { assert.doesNotThrow(() => beginHistoryReadDiagnostic('catalog-candidate').end('error', { errorCode: 'INVALIDATED' })); }
  finally { console.log = original; }
});

test('prepared is provisional and a later error owns the one terminal outcome', () => {
  const records = [], original = console.log;
  console.log = value => records.push(JSON.parse(value.slice('[HistoryReadMemory] '.length)));
  try {
    const diagnostic = beginHistoryReadDiagnostic('session-turns', { readId: 'private-error-read' });
    diagnostic.prepared({ sourceBytes: 256, preparedRows: 1 });
    diagnostic.prepared({ preparedRows: 2 });
    diagnostic.end('error', { errorCode: 'CODEX_SOURCE_READ_INVALIDATED' });
    diagnostic.deferSuccess()();
    diagnostic.prepared({ preparedRows: 3 });
  } finally { console.log = original; }
  assert.deepEqual(records.map(record => record.phase), ['start', 'prepared', 'error']);
  assert.ok(records.every(record => record.readId === 'private-error-read'));
  assert.equal(records[2].errorCode, 'CODEX_SOURCE_READ_INVALIDATED');
  assert.equal(records[2].preparedRows, 1);
  assert.equal(records[2].sourceBytes, 256);
});

test('prepared success defers all sink/memory work and preserves snapshot and decision clocks', async () => {
  const records = [], originalLog = console.log, originalMemory = process.memoryUsage;
  let samples = 0;
  console.log = value => records.push(JSON.parse(value.slice('[HistoryReadMemory] '.length)));
  process.memoryUsage = () => { samples++; return originalMemory(); };
  try {
    const fields = { preparedRows: 1, sourceBytes: 256, get payload() { throw Error('payload read'); } };
    const diagnostic = beginHistoryReadDiagnostic('session-turns', { readId: 'private-success-read' });
    diagnostic.prepared(fields);
    fields.preparedRows = 99;
    const commit = diagnostic.deferSuccess();
    const before = samples;
    commit();
    diagnostic.end('error', { errorCode: 'TOO_LATE' });
    assert.equal(samples, before, 'no synchronous memory callback at success commit');
    assert.deepEqual(records.map(record => record.phase), ['start', 'prepared']);
    await Promise.resolve();
    assert.deepEqual(records.map(record => record.phase), ['start', 'prepared', 'complete']);
    const completed = records[2];
    assert.equal(completed.readId, records[0].readId);
    assert.equal(completed.preparedRows, 1);
    assert.equal(completed.sourceBytes, 256);
    assert.equal(completed.errorCode, undefined);
    assert.ok(completed.decisionAbs >= records[1].emittedAbs);
    assert.ok(completed.emittedAbs >= completed.decisionAbs);
    assert.ok(completed.elapsedMs >= completed.decisionElapsedMs);
    assert.equal(samples, before + 1);
  } finally { console.log = originalLog; process.memoryUsage = originalMemory; }
});

test('throwing provisional and deferred sinks do not affect success', async () => {
  const original = console.log;
  let calls = 0;
  console.log = () => { calls++; throw Error('sink'); };
  try {
    const diagnostic = beginHistoryReadDiagnostic('session-turns');
    assert.doesNotThrow(() => diagnostic.prepared({ preparedRows: 1 }));
    assert.doesNotThrow(() => diagnostic.deferSuccess()());
    assert.equal(calls, 2);
    await Promise.resolve();
    assert.equal(calls, 3);
  } finally { console.log = original; }
});
