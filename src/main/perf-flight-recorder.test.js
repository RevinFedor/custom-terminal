'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cpuFrame, systemCpu, summarizeFrames, createArtifactStore } = require('./perf-flight-recorder');

const proc = (pid, cpuNs, extra = {}) => ({ pid, ppid: 1, startedAtTicks: '10', cpuNs,
  name: 'process', footprintBytes: 1048576, ...extra });
test('same interval distinguishes app, PTY descendant and external CPU; omits raw arguments', () => {
  const before = { processes: [proc(10, 0), proc(20, 0), proc(21, 0), proc(30, 0)] };
  const after = { processes: [proc(10, 1e9), proc(20, 1e8, { ppid: 10 }),
    proc(21, 2e8, { ppid: 20, commandLine: 'SECRET', execPath: '/private/SECRET' }), proc(30, 6e9, { name: 'OrbStack' })] };
  const frame = cpuFrame(before, after, 2000, [{ pid: 10, type: 'Browser' }], [{ pid: 20, tabId: 'tab-1' }], 10);
  assert.equal(frame.appCpu, 50); assert.equal(frame.tabCpu, 15);
  assert.equal(frame.rows.find(p => p.pid === 30).cpu, 300);
  assert.equal(frame.rows.find(p => p.pid === 21).tabId, 'tab-1');
  assert.ok(!JSON.stringify(frame).includes('SECRET'));
});
test('first sample and PID reuse with a LARGER counter are unknown, not 0 or false CPU', () => {
  const before = { processes: [proc(10, 1e9), proc(11, 1e9)] };
  const after = { processes: [proc(10, 2e9, { startedAtTicks: '11' }), proc(11, 0), proc(12, 9e9)] };
  assert.deepEqual(cpuFrame(before, after, 1000, [], [], 100).rows, []);
  assert.deepEqual(cpuFrame(null, after, 1000, [], [], 100).rows, []);
});
test('normalized CPU keeps its provenance in frames/checkpoints without scaling twice', () => {
  const normalization = { sourceUnit: 'mach-ticks', outputUnit: 'nanoseconds', numer: 125, denom: 3 };
  const before = { processes: [proc(10, 0)] };
  const after = { processes: [proc(10, 1e9)], cpuTimeNormalization: normalization };
  const frame = { ...cpuFrame(before, after, 1000, [], [], 10), wallMs: 1000, elapsedMs: 1000,
    systemBusy: 10, probeMs: 1, observerGapMs: 0 };
  assert.equal(frame.appCpu, 100);
  assert.deepEqual(frame.cpuTimeNormalization, normalization);
  const summary = summarizeFrames([frame]);
  assert.equal(summary.appPeak, 100);
  assert.deepEqual(summary.cpuTimeNormalization, normalization);
});
test('system busy uses all-core delta and rejects a reset/topology change', () => {
  const cpu = (user, idle) => ({ times: { user, idle, sys: 0, nice: 0, irq: 0 } });
  assert.equal(systemCpu([cpu(0, 0), cpu(0, 0)], [cpu(100, 0), cpu(0, 100)]), 50);
  assert.equal(systemCpu([cpu(100, 0)], [cpu(0, 100)]), null);
  assert.equal(systemCpu([], [cpu(0, 0)]), null);
});
test('checkpoint preserves burst BETWEEN flushes and observed identity coverage', () => {
  const frames = [10, 300, 20].map((cpu, i) => ({ wallMs: 2000 * (i + 1), elapsedMs: 2000,
    systemBusy: 50, appCpu: cpu, probeMs: 4, observerGapMs: 0,
    rows: [{ pid: 10, identity: 'a', cpu, owner: 'app' }] }));
  const result = summarizeFrames(frames);
  assert.equal(result.rows[0].peakCpu, 300); assert.equal(result.rows[0].meanCpu, 110);
  assert.equal(result.rows[0].observedMs, 6000); assert.equal(result.from, 0); assert.equal(result.to, 6000);
});
test('capture quota is rolling and survives a new recorder; retention touches only owned regular files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-flight-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createArtifactStore(dir), now = Date.now();
  for (let i = 0; i < 4; i++) {
    const name = 'incident-' + (now - 7200000 + i * 700000) + '-1.capture.json';
    store.write(name, {});
    fs.utimesSync(store.file(name), new Date(now - 7200000 + i * 700000), new Date(now - 7200000 + i * 700000));
  }
  const reloaded = createArtifactStore(dir);
  assert.equal(reloaded.reserveCapture('incident-' + now + '-1', now), false);
  assert.equal(reloaded.reserveCapture('incident-' + (now + 86400000) + '-1', now + 86400000), true);
  assert.throws(() => store.file('../secret'));
  fs.writeFileSync(path.join(dir, 'user-notes.txt'), 'keep');
  store.write('incident-1-1.main.cpuprofile', {});
  store.write('incident-1-1.ui.json', { animations: [] });
  const old = new Date(now - 8 * 86400000);
  fs.utimesSync(store.file('incident-1-1.main.cpuprofile'), old, old);
  fs.utimesSync(store.file('incident-1-1.ui.json'), old, old);
  fs.symlinkSync(path.join(dir, 'user-notes.txt'), store.file('incident-2-1.json'));
  store.prune(now);
  assert.equal(fs.existsSync(store.file('incident-1-1.main.cpuprofile')), false);
  assert.equal(fs.existsSync(store.file('incident-1-1.ui.json')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'user-notes.txt'), 'utf8'), 'keep');
  assert.throws(() => store.write('incident-2-1.json', {}));
});
test('passive renderer diagnostics never hit-test, read computed style or scan the hover tree', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/utils/perfFreezeProbe.ts'), 'utf8');
  assert.doesNotMatch(source, /document\.elementFromPoint\s*\(|window\.getComputedStyle\s*\(|querySelectorAll\(['"]:hover/);
  assert.match(source, /targetEvidence=event/);
  assert.match(source, /writableLength > 16384/);
});
