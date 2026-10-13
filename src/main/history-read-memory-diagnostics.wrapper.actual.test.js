'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { createHook } = require('node:async_hooks');
const { beginHistoryReadDiagnostic } = require('./history-read-memory-diagnostics');
const { CodexTurnsCacheAdmission } = require('./codex-turns-cache-admission');
const { _api: actual } = require('./ipc/codex-data');

// Actual Main wrapper, diagnostic, admission helper and physical source fences.
// The inner graph loader and logical lineage owner are controlled: this tests
// the outer diagnostic boundary, not projection, SQL, workers or the application.
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = main.indexOf('async function _loadSessionTurns(');
const end = main.indexOf('\nfunction _historyReadBindings(', start);
assert.ok(start >= 0 && end > start);
const wrapper = main.slice(start, end);
const prefix = '[HistoryReadMemory] ';

async function fixture(t, { certified = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrm-wrapper-private-'));
  const sid = randomUUID();
  const file = path.join(root, `rollout-${sid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: sid, cwd: root } }) + '\n');
  assert.ok(fs.statSync(file).size <= 16 * 1024, 'bounded private fixture');
  t.after(() => {
    actual.invalidateJsonlCache(file);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = { root, sid, file, records: [], events: [], finalChecked: false, hooks: {}, lineage: 0 };
  const api = {
    ...actual,
    findCodexSessionFile: (id, cwd) => actual.findCodexSessionFile(id, cwd, { sessionsDir: root }),
    assertCodexSourceReadCurrent: (read, binding) => actual.assertCodexSourceReadCurrent(read,
      binding ? { ...binding, sessionsDir: root } : null),
  };
  const service = {
    captureCodexTurnsLineageProof: () => f.lineage,
    isCodexTurnsLineageProofAdmitted: proof => proof.version === f.lineage,
    isCodexTurnsLineageProofCurrent: proof => {
      const current = proof.version === f.lineage;
      f.finalChecked = true;
      f.events.push('final-check');
      f.hooks.finalCheck?.();
      return current;
    },
  };
  assert.equal((await api.findCodexSessionFile(sid, root)).filePath, file);
  const read = await actual.beginCodexSourceRead(file, sid);
  const graph = f.graph = { engine: 'codex', size: read.snapshot.size, retainedSourceBytes: read.snapshot.size,
    sourceSnapshot: read.snapshot, filePath: file, turns: [{ userUuid: 'private-row' }], recordMap: new Map([['private-row', {}]]) };
  try {
    if (certified) {
      const admission = new CodexTurnsCacheAdmission(api, service);
      admission.remember(graph, admission.captureSource(graph, sid, root, { version: f.lineage }));
    }
  } finally { actual.finishCodexSourceRead(read); }
  f.finalChecked = false;
  f.events.length = 0;
  const context = vm.createContext({ require, path, srcMainDir: __dirname, console,
    beginHistoryReadDiagnostic, codexDataModule: { _api: api }, transcriptService: service,
    perfCausal: { current: () => null, run: (_name, _fields, run) => run() },
    perfCallerToken: () => 'private-wrapper-test',
    _resolveHistoryReadSession: async () => ({ provider: 'codex', diagnostics: {} }),
    _loadCodexSessionTurns: async () => {
      if (f.hooks.load) return f.hooks.load();
      return graph;
    },
  });
  vm.runInContext(wrapper, context, { filename: 'main._loadSessionTurns.actual.js' });
  f.run = () => context._loadSessionTurns(sid, root, { provider: 'codex' });
  f.revoke = mutation => {
    if (mutation === 'source') actual.invalidateJsonlCache(file);
    else f.lineage++;
  };
  f.capture = async run => {
    const original = console.log;
    console.log = value => {
      if (typeof value !== 'string' || !value.startsWith(prefix)) return;
      const record = JSON.parse(value.slice(prefix.length));
      f.records.push(record);
      f.events.push(record.phase);
      f.hooks.record?.(record);
    };
    try { return await run(); }
    finally { console.log = original; }
  };
  return f;
}

function terminal(f, phase) {
  const outcomes = f.records.filter(record => record.phase === 'complete' || record.phase === 'error');
  assert.equal(outcomes.length, 1, 'exactly one terminal outcome');
  assert.equal(outcomes[0].phase, phase, 'terminal outcome agrees with the wrapper promise');
  assert.ok(f.records.every(record => record.readId === f.records[0].readId), 'one readId throughout');
  return outcomes[0];
}

for (const mutation of ['source', 'lineage']) {
  test(`actual prepared diagnostic observer revokes ${mutation}: rejection has one terminal error`, { concurrency: false }, async t => {
    const f = await fixture(t);
    let revoked = false;
    f.hooks.record = record => {
      // On RED the legacy "complete" is the pre-admission snapshot. Never
      // inject a console mutation after the final guard on the success path.
      if (!revoked && !f.finalChecked && ['prepared', 'complete'].includes(record.phase)) {
        revoked = true;
        f.revoke(mutation);
      }
    };
    await f.capture(async () => { await assert.rejects(f.run(), { code: 'CODEX_SOURCE_READ_INVALIDATED' }); });
    assert.ok(revoked);
    assert.equal(terminal(f, 'error').errorCode, 'CODEX_SOURCE_READ_INVALIDATED');
    assert.deepEqual(f.records.map(record => record.phase), ['start', 'prepared', 'error']);
  });

  test(`actual final-check observer revokes ${mutation}: rejection has one terminal error`, { concurrency: false }, async t => {
    const f = await fixture(t);
    f.hooks.finalCheck = () => { delete f.hooks.finalCheck; f.revoke(mutation); };
    await f.capture(async () => { await assert.rejects(f.run(), { code: 'CODEX_SOURCE_READ_INVALIDATED' }); });
    assert.ok(f.finalChecked);
    assert.equal(terminal(f, 'error').errorCode, 'CODEX_SOURCE_READ_INVALIDATED');
    assert.deepEqual(f.records.map(record => record.phase), ['start', 'prepared', 'error']);
  });
}

test('actual success returns the same DTO and emits only after the final synchronous frame', { concurrency: false }, async t => {
  const f = await fixture(t);
  let completedStack;
  f.hooks.record = record => { if (record.phase === 'complete') completedStack = new Error().stack; };
  const result = await f.capture(f.run);
  assert.equal(result, f.graph, 'diagnostics must not wrap or change the public graph');
  const completed = terminal(f, 'complete');
  assert.deepEqual(f.events, ['start', 'prepared', 'final-check', 'complete']);
  assert.doesNotMatch(completedStack, /main\._loadSessionTurns\.actual\.js/, 'the actual wrapper frame has returned before emission');
  assert.equal(completed.preparedRows, 1);
  assert.equal(completed.records, 1);
  assert.equal(completed.sourceBytes, f.graph.size);
  assert.ok(Number.isFinite(completed.decisionAbs));
  assert.ok(completed.emittedAbs >= completed.decisionAbs);
  assert.ok(completed.elapsedMs >= completed.decisionElapsedMs);
});

test('a synchronous native microtask scheduling observer cannot invalidate after the final guard', { concurrency: false }, async t => {
  const f = await fixture(t);
  let prepared = false, revoked = false;
  f.hooks.record = record => { if (record.phase === 'prepared') prepared = true; };
  const hook = createHook({ init(_id, type) {
    if (type === 'Microtask' && prepared && !revoked) {
      revoked = true;
      f.revoke('source');
    }
  } });
  hook.enable();
  try {
    await f.capture(async () => { await assert.rejects(f.run(), { code: 'CODEX_SOURCE_READ_INVALIDATED' }); });
  } finally { hook.disable(); }
  assert.ok(revoked, 'the real native microtask scheduling observer ran');
  assert.equal(terminal(f, 'error').errorCode, 'CODEX_SOURCE_READ_INVALIDATED');
  assert.deepEqual(f.records.map(record => record.phase), ['start', 'prepared', 'error']);
});

test('a Codex graph without the optional admission proof still completes once', { concurrency: false }, async t => {
  const f = await fixture(t, { certified: false });
  assert.equal(await f.capture(f.run), f.graph);
  terminal(f, 'complete');
  assert.deepEqual(f.records.map(record => record.phase), ['start', 'prepared', 'complete']);
});

test('failure before preparation records the original error exactly once', { concurrency: false }, async t => {
  const f = await fixture(t);
  const failure = Object.assign(new Error('private controlled loader failure'), { code: 'PRIVATE_LOAD_FAILED' });
  f.hooks.load = () => { throw failure; };
  await f.capture(async () => { await assert.rejects(f.run(), error => error === failure); });
  assert.equal(terminal(f, 'error').errorCode, 'PRIVATE_LOAD_FAILED');
  assert.deepEqual(f.records.map(record => record.phase), ['start', 'error']);
});
