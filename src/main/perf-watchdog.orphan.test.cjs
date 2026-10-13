const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { fork } = require('node:child_process');

const filename = path.join(__dirname, 'perf-watchdog.js');
const source = fs.readFileSync(filename, 'utf8');
const MAIN_PID = 98765; // A port identity only; never queried or signalled on the host.
const LOG = '/private/tmp/noted-watchdog-control/watchdog.log';
const SOCKET = '/private/tmp/noted-watchdog-control/renderer.sock';

function load({ ipc, identityKnown = true, deferInitial = false } = {}) {
  let now = 1, logBytes = 0, snapshots = 0, forcedFlushes = 0;
  const epoch = 1791820300000;
  const timers = new Set(), periods = [], exits = [], logs = [], sends = [];
  const incidents = [], samples = [], resumes = [], records = [], cleanup = [], violations = [];
  const proc = new EventEmitter();
  proc.argv = ['node', filename, String(MAIN_PID), LOG, SOCKET];
  proc.platform = 'controlled';
  proc.connected = true;
  proc.channel = {};
  if (ipc) proc.on = ipc.on.bind(ipc);
  proc.send = m => { sends.push(m); if (ipc) ipc.send(m); };
  proc.exit = code => { exits.push(code); cleanup.push('exit:' + code); timers.clear(); if (ipc) ipc.exit(code); };
  const checkPath = (actual, expected) => {
    if (actual !== expected) { violations.push(actual); throw new Error('unexpected port path'); }
  };
  const fsPort = {
    appendFileSync(p, line) {
      checkPath(p, LOG);
      logBytes += Buffer.byteLength(line);
      if (logBytes > 64 * 1024) { violations.push('log budget'); throw new Error('log budget'); }
      logs.push(line);
    },
    unlinkSync(p) { checkPath(p, SOCKET); cleanup.push('unlink'); },
    chmodSync(p, mode) { checkPath(p, SOCKET); assert.equal(mode, 0o600); },
  };
  const server = new EventEmitter();
  server.listen = (p, ready) => { checkPath(p, SOCKET); ready(); };
  let onConnection;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [epoch + now])); }
    static now() { return epoch + now; }
  }
  const context = vm.createContext({
    process: proc, Date: ClockDate,
    setInterval(fn, ms) { periods.push(ms); const timer = { fn, ms, next: now + ms }; timers.add(timer); return timer; },
    require(name) {
      if (name === 'fs') return fsPort;
      if (name === 'path') return path;
      if (name === 'net') return { createServer(fn) { onConnection = fn; return server; } };
      if (name === 'perf_hooks') return { performance: { timeOrigin: epoch, now: () => now } };
      if (name === './child-process-env') return { buildChildProcessEnv: () => ({}) };
      if (name === './process-metrics-source') return { captureNativeSnapshot() {
        snapshots += 1;
        return identityKnown ? { ok: true, processes: [{ pid: MAIN_PID, startedAtTicks: 'private-start' }] } : { ok: false };
      } };
      if (name === './perf-flight-recorder') return { createFlightRecorder: () => ({
        artifacts: {}, incident: (kind, detail) => incidents.push({ kind, ...detail }),
        stop: () => cleanup.push('flight.stop'),
      }) };
      if (name === './perf-causal-journal') return { createCausalJournal: () => ({
        record: (record, origin) => records.push({ ...record, origin }),
        flush(force) { if (force) { forcedFlushes += 1; cleanup.push('journal.flush'); } },
        snapshot: () => ({ counts: {}, limits: {}, queued: 0, flushLagMs: 0 }),
        reconcile() {}, observeSequence() {},
      }) };
      if (name === './perf-stall-sampler') return { createNativeStallSampler: () => ({
        request(meta) {
          samples.push(meta);
          return { reason: deferInitial && meta.stalledMs < 1000
            ? 'native-reserved-for-critical-stall' : 'native-day-quota-exhausted' };
        },
        resumed: meta => resumes.push(meta), stop: () => cleanup.push('sampler.stop'),
      }) };
      throw new Error('Unexpected dependency: ' + name);
    },
  });
  vm.runInContext(source, context, { filename });
  const summary = () => ({ exits, logBytes, logLines: logs.length, snapshots, forcedFlushes,
    timerPeriods: periods, incidents: incidents.length, samples: samples.length, resumes: resumes.length,
    stalls: records.filter(r => r.kind === 'stall').length, liveTimers: timers.size, cleanup, violations });
  return {
    proc, logs, sends, records, samples, summary,
    heartbeat: () => proc.emit('message', { t: 'hb', proc: 'main' }),
    rendererHeartbeat() {
      const socket = new EventEmitter(); socket.destroy = () => socket.emit('close');
      onConnection(socket);
      socket.emit('data', Buffer.from(JSON.stringify({ t: 'hb', proc: 'renderer', pid: MAIN_PID, vis: 'hidden' }) + '\n'));
      socket.emit('close');
    },
    advance(ms) {
      const end = now + ms;
      let ticks = 0;
      while (!exits.length) {
        const timer = [...timers].sort((a, b) => a.next - b.next)[0];
        if (!timer || timer.next > end) break;
        assert.ok(++ticks <= 10000, 'bounded controlled-clock steps');
        now = timer.next; timer.next += timer.ms; timer.fn();
      }
      if (!exits.length) now = end;
    },
    disconnect() { proc.connected = false; proc.channel = null; proc.emit('disconnect'); },
  };
}

function fixture(t, options) {
  const h = load(options);
  t.after(() => {
    if (!h.summary().exits.length) h.proc.emit('SIGTERM');
    assert.deepEqual(h.summary().violations, []);
    assert.equal(h.summary().liveTimers, 0);
    t.diagnostic(JSON.stringify(h.summary()));
  });
  return h;
}

if (process.argv[2] === '--watchdog-ipc-child') {
  const h = load({ ipc: process });
  process.on('message', m => {
    if (m?.t !== 'control-advance') return;
    h.advance(m.ms);
    process.send({ t: 'control-result', summary: h.summary() });
  });
  process.send({ t: 'control-ready' });
} else {
  test('ten-minute Main silence stays a stall; probes stay bounded and late resume still works', t => {
    const h = fixture(t, { deferInitial: true });
    h.heartbeat();
    h.advance(600000); // 100ms observer ticks, not a suspended observer/clock jump.
    assert.deepEqual(h.summary().exits, [], 'heartbeat silence must not retire an IPC owner');
    assert.equal(h.summary().stalls, 1);
    assert.equal(h.summary().incidents, 1, 'one incident for one continuous stall');
    assert.equal(h.summary().samples, 2, 'only existing initial + critical deferred admission, even with exhausted quota');
    assert.equal(h.summary().snapshots, 1, 'silence must not add native liveness polling');
    assert.equal(h.samples[0].stallId, h.samples[1].stallId);
    assert.ok(h.samples[1].stalledMs >= 1000);
    h.rendererHeartbeat();
    assert.match(h.logs.join(''), /renderer-detached/);
    h.heartbeat();
    assert.equal(h.summary().resumes, 1);
    assert.equal(h.records.find(r => r.kind === 'resume').durationMs, 600000);
    h.advance(700);
    assert.equal(h.summary().stalls, 2, 'a later distinct freeze remains observable');
    assert.deepEqual(h.summary().timerPeriods, [100], 'no orphan polling timer or expanded threshold');
  });

  test('startup before first Main heartbeat does not prove orphanhood', t => {
    const h = fixture(t);
    h.advance(240000);
    assert.deepEqual(h.summary().exits, []);
    assert.equal(h.summary().snapshots, 0);
    assert.equal(h.summary().samples, 0);
    h.heartbeat();
    assert.equal(h.sends.filter(m => m.t === 'watchdog-observed').length, 1);
  });

  test('unavailable process identity does not turn long Main silence into death', t => {
    const h = fixture(t, { identityKnown: false });
    h.heartbeat(); h.advance(240000);
    assert.deepEqual(h.summary().exits, []);
    assert.equal(h.summary().snapshots, 1);
    assert.equal(h.summary().stalls, 1);
    assert.equal(h.samples[0].processIdentity, null);
  });

  test('disconnect cleans up immediately before heartbeat, during a stall, and after bye', t => {
    for (const phase of ['startup', 'stalled', 'bye']) {
      const h = fixture(t);
      if (phase !== 'startup') { h.heartbeat(); h.advance(700); }
      if (phase === 'bye') h.proc.emit('message', { t: 'bye' });
      h.disconnect();
      assert.deepEqual(h.summary().exits, [0], phase);
      assert.deepEqual(h.summary().cleanup.slice(-5), ['sampler.stop', 'journal.flush', 'flight.stop', 'unlink', 'exit:0']);
    }
  });

  test('bye suppresses alarms while shutdown is pending; both termination signals still clean up', t => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const h = fixture(t);
      h.heartbeat(); h.proc.emit('message', { t: 'bye' }); h.advance(600000);
      assert.deepEqual(h.summary().exits, []);
      assert.equal(h.summary().stalls, 0);
      assert.equal(h.summary().samples, 0);
      h.proc.emit(signal);
      assert.deepEqual(h.summary().exits, [0]);
      assert.deepEqual(h.summary().cleanup.slice(-5), ['sampler.stop', 'journal.flush', 'flight.stop', 'unlink', 'exit:0']);
    }
  });

  test('actual fork IPC stays owned across silence and channel closure exits the watchdog', { timeout: 5000 }, async t => {
    const child = fork(__filename, ['--watchdog-ipc-child'], {
      execArgv: ['--max-old-space-size=128'], env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const stopped = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await stopped;
    });
    const message = type => new Promise((resolve, reject) => {
      const done = () => { child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); };
      const onMessage = m => { if (m?.t === type) { done(); resolve(m); } };
      const onExit = (code, signal) => { done(); reject(new Error(`watchdog exited before ${type}: ${code}/${signal} ${stderr}`)); };
      const onError = error => { done(); reject(error); };
      child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
    });
    await message('control-ready');
    const observed = message('watchdog-observed');
    child.send({ t: 'hb', proc: 'main' }); await observed;
    const advanced = message('control-result');
    child.send({ t: 'control-advance', ms: 240000 });
    const { summary } = await advanced;
    assert.deepEqual(summary.exits, []); assert.equal(summary.stalls, 1); assert.equal(summary.samples, 1);
    child.disconnect();
    assert.deepEqual(await stopped, { code: 0, signal: null });
    assert.equal(stderr, '');
    t.diagnostic(JSON.stringify({ realIpc: true, childHeapMiB: 128, summary, channelClosureExit: 0 }));
  });
}
