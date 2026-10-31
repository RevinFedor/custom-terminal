'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const ts = require('typescript');
const { createCausalJournal } = require('./perf-causal-journal');
const { createArtifactStore, createFlightRecorder } = require('./perf-flight-recorder');

// Read the actual watchdog adapter without starting its watchdog/sampler loops.
function adapter(target) {
  const file = path.join(__dirname, 'perf-watchdog.js');
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = [];
  function walk(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onPersisted') matches.push(node.initializer);
    ts.forEachChild(node, walk);
  }
  walk(ast); assert.equal(matches.length, 1, 'one actual journal ACK adapter');
  return vm.runInNewContext('(() => { let causalAckPending = 0; return { onPersisted: '
    + matches[0].getText(ast) + ', pending: () => causalAckPending }; })()', { process: target });
}
function fixture(t, target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-causal-ack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const artifacts = createArtifactStore(dir);
  const tx = adapter(target);
  const at = Date.UTC(2026, 9, 31);
  const origin = { pid: process.pid, kind: 'main' };
  const journal = createCausalJournal({ artifacts, now: () => at, onPersisted: tx.onPersisted });
  const record = id => journal.record({ kind: 'work-summary', sourcePid: process.pid,
    sourceBoot: 'private-ack', sourceSeq: 1, emittedAbs: at + 10, summaryId: id, revision: 1,
    workSummary: { summaryId: id, revision: 1, siteId: 'private.read', parentSpanId: null,
      startAbs: at, endAbs: at + 10, threadCpuMs: 1, outcome: 'success',
      counts: [1, 0, 0, 0], sqlMs: [1, 0, 0, 0], sqlMaxMs: 1, sqlErrors: 0,
      sites: [], counters: {}, overflow: { operations: 0, ms: 0, maxMs: 0 } },
  }, origin);
  const rows = () => artifacts.entries().filter(e => e.name.startsWith('causal-'))
    .flatMap(e => fs.readFileSync(artifacts.file(e.name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  return { dir, journal, record, rows, tx };
}

test('actual watchdog ACK adapter counts a real asynchronous IPC failure after durable append', { timeout: 10000 }, async t => {
  let child, callbackDone, callbackResult;
  const done = new Promise(resolve => { callbackDone = resolve; });
  const target = {
    get connected() { return child.connected; },
    send(packet, callback) {
      // Controlled disconnect at the admission/write boundary; the actual Node
      // IPC implementation supplies the asynchronous ERR_IPC_CHANNEL_CLOSED.
      child.disconnect();
      return child.send(packet, error => { callbackResult = error; callback(error); callbackDone(); });
    },
  };
  const f = fixture(t, target);
  const peer = path.join(f.dir, 'peer.cjs');
  fs.writeFileSync(peer, 'process.on("message", () => {}); process.send({ready:true});\n');
  child = fork(peer, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  const [ready] = await once(child, 'message'); assert.equal(ready.ready, true);
  assert.equal(f.record('work-real-ipc'), true);
  f.journal.flush(true);
  assert.equal(f.rows().length, 1, 'ACK failure must not erase or repeat the fsynced record');
  assert.equal(f.journal.snapshot().counts.written, 1);
  assert.equal(f.tx.pending(), 1, 'return from send is admission, not callback completion');
  assert.equal(f.journal.snapshot().counts.ackErrors, 0);
  let captures = 0;
  const flight = createFlightRecorder({ directory: f.dir, mainPid: process.pid, log() {},
    requestCapture() { captures++; }, context: () => ({ causal: f.journal.snapshot() }),
    snapshot: () => ({ ok: false, reason: 'fixture-no-native-snapshot' }),
    pressure: async () => ({ available: false, reason: 'fixture-no-os-query' }) });
  t.after(() => flight.stop());
  flight.incident('heartbeat-silence', { pid: process.pid });
  await done;
  assert.equal(callbackResult?.code, 'ERR_IPC_CHANNEL_CLOSED');
  assert.equal(f.tx.pending(), 0);
  assert.equal(f.journal.snapshot().counts.ackErrors, 1);
  assert.equal(f.journal.snapshot().counts.diskErrors, 0);
  assert.equal(f.rows().length, 1);
  flight.stop();
  const incidents = flight.artifacts.entries().filter(e => /^incident-\d+-\d+\.json$/.test(e.name));
  assert.equal(incidents.length, 1);
  const saved = JSON.parse(flight.artifacts.read(incidents[0].name));
  assert.equal(saved.context.causal.counts.ackErrors, 1, 'late IPC failure survives actual incident readback');
  assert.equal(saved.context.causal.counts.written, 1);
  assert.equal(saved.complete, false, 'failure accounting does not invent a complete capture');
  assert.equal(captures, 0, 'this regression never starts a heavyweight capture');
  await exited;
});

test('watchdog ACK cap and backpressure preserve append and exact duplicate re-ACK', t => {
  const callbacks = [];
  const f = fixture(t, { connected: true, send(_packet, callback) { callbacks.push(callback); return false; } });
  for (let i = 0; i < 9; i++) assert.equal(f.record('work-' + i), true);
  f.journal.flush(true);
  assert.equal(f.rows().length, 9); assert.equal(f.tx.pending(), 8);
  assert.equal(f.journal.snapshot().counts.ackErrors, 1, 'ninth ACK rejected by the existing cap');
  callbacks.splice(0).forEach(callback => callback());
  assert.equal(f.tx.pending(), 0);
  assert.equal(f.journal.snapshot().counts.ackErrors, 1, 'send(false) alone is only backpressure');
  assert.equal(f.record('work-8'), true);
  assert.equal(f.rows().length, 9, 'same persisted summary is not appended twice');
  callbacks.shift()();
  assert.equal(f.tx.pending(), 0); assert.equal(f.journal.snapshot().counts.ackErrors, 1);
});

test('synchronous throw and repeated callback error are each counted only once', t => {
  const f = fixture(t, { connected: true, send() { throw new Error('fixture-send-error'); } });
  assert.equal(f.record('throw'), true); f.journal.flush(true);
  assert.equal(f.journal.snapshot().counts.ackErrors, 1); assert.equal(f.tx.pending(), 0);
  let callback;
  const g = fixture(t, { connected: true, send(_packet, done) { callback = done; return true; } });
  assert.equal(g.record('callback'), true); g.journal.flush(true);
  callback(new Error('fixture-late-error')); callback(new Error('fixture-duplicate-error'));
  assert.equal(g.journal.snapshot().counts.ackErrors, 1); assert.equal(g.tx.pending(), 0);
  assert.equal(g.rows().length, 1);
});
