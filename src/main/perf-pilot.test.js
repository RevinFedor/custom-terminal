'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { installPerfPilot } = require('./perf-pilot');
test('private capture gate is absent in production and owns one start; stale/foreign/no-key denied', async () => {
  let h, calls = 0, releases = 0, retire;
  const frame = {}, wc = { isDestroyed: () => false, mainFrame: frame }, event = { sender: wc, senderFrame: frame };
  const ipcMain = { handle: (name, fn) => { assert.equal(name, 'perf:pilot'); h = fn; } };
  assert.equal(installPerfPilot({ ipcMain, allowed: false }), false); assert.equal(h, undefined);
  const key = 'bounded-private-pilot'; let current = true;
  installPerfPilot({ ipcMain, allowed: true, key, pin: () => ({ webContents: wc, isCurrent: () => current, dispose() {} }),
    suspend: () => { const r = () => releases++; r.ready = Promise.resolve(); return r; }, causal: { syncSnapshot: () => ({}) },
    log() {}, capture: async options => { calls++; options.onReady({ plannedStopMonoMs: performance.now() + 40000 });
      return { leaseId: 'a', whenRetired: new Promise(r => { retire = r; }), retirementState: { confirmed: false } }; } });
  assert.throws(() => h(event, { key: 'foreign', op: 'start' }), /mismatch/);
  assert.throws(() => h({ ...event, senderFrame: {} }, { key, op: 'start' }), /unavailable/);
  assert.equal(h(event, { key, op: 'start' }).accepted, true); assert.throws(() => h(event, { key, op: 'start' }), /already-attempted/);
  await new Promise(r => setImmediate(r)); assert.equal(calls, 1); assert.equal(releases, 0);
  retire({ confirmed: true, leaseId: 'foreign' }); await new Promise(r => setImmediate(r)); assert.equal(releases, 0);
  current = false; assert.throws(() => h(event, { key, op: 'status' }), /mismatch/);
});

test('baseline order is finite and cannot overlap capture or restore another owner', async () => {
  const key = 'bounded-private-baseline'; let h; const frame = {}, flags = [], timers = [];
  const wc = { isDestroyed: () => false, mainFrame: frame }, event = { sender: wc, senderFrame: frame };
  installPerfPilot({ ipcMain: { handle(_n, fn) { h = fn; } }, allowed: true, key,
    causal: { setSyncRingEnabled: flag => flags.push(flag), syncSnapshot: () => ({}) },
    schedule: (fn, ms) => { assert.equal(ms, 2000); timers.push(fn); }, log() {} });
  const first = h(event, { key, op: 'baseline', sequence: 0, enabled: false });
  assert.throws(() => h(event, { key, op: 'start' }), /already-attempted/);
  assert.throws(() => h(event, { key, op: 'baseline', sequence: 0, enabled: false }), /order/);
  timers.shift()(); assert.equal((await first).enabled, false);
  for (let sequence = 1; sequence < 4; sequence++) {
    const next = h(event, { key, op: 'baseline', sequence, enabled: sequence % 2 === 1 });
    timers.shift()(); await next;
  }
  assert.throws(() => h(event, { key, op: 'baseline', sequence: 4, enabled: false }), /order/);
  assert.deepEqual(flags, [false,true,true,true,false,true,true,true]);
});
