import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiskCapacityStore } from './diskCapacityStore.mjs';
import { diskCapacityPresentation, diskCapacityBytes } from '../utils/diskCapacityPresentation.mjs';
const ready = (overrides = {}) => ({ status: 'ready', epoch: 'e', revision: 1, measuredAt: 100, expiresAt: 60100,
  freeBytes: 12, cacheBytes: 14, budgetBytes: 20, reserveBytes: 6, remainingGrowthBytes: 6, projectedFreeBytes: 6, warning: false, ...overrides });
function fixture() {
  const events = new Map(), timers = new Map(), calls = []; let time = 100, nextTimer = 0, resolve;
  const reply = new Promise(r => { resolve = r; });
  const ipc = { on: (c, fn) => events.set(c, fn), removeListener: c => events.delete(c),
    invoke: (c, token) => { calls.push([c, token]); return c.endsWith('unsubscribe') ? Promise.resolve() : reply; } };
  const store = createDiskCapacityStore({ ipc, now: () => time, setTimeoutFn: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeoutFn: n => timers.delete(n) });
  return { store, calls, events, timers, resolve, emit: value => events.get('system:disk-capacity')?.({}, value), advance: ms => { time += ms; } };
}
test('ready/healthy/warning/unknown/failure/stale stay distinct, including zero and negative projection', () => {
  assert.equal(diskCapacityPresentation(ready(), 100), 'healthy');
  assert.equal(diskCapacityPresentation(ready({ freeBytes: 0, projectedFreeBytes: -6, warning: true }), 100), 'warning');
  assert.equal(diskCapacityPresentation(ready(), 60100), 'stale');
  assert.equal(diskCapacityPresentation({ status: 'error' }), 'error');
  assert.equal(diskCapacityPresentation(null), 'unknown');
  assert.equal(diskCapacityPresentation(ready({ cacheBytes: null }), 100), 'error');
  assert.equal(diskCapacityBytes(null), '—'); assert.equal(diskCapacityBytes(0), '0 ГиБ');
});
test('two components share one subscription; newer event wins over old subscribe ACK', async () => {
  const f = fixture(); const a = f.store.subscribe(() => {}), b = f.store.subscribe(() => {});
  assert.equal(f.calls.length, 1); assert.equal(f.events.size, 1);
  f.emit(ready({ revision: 2, warning: true })); f.resolve(ready()); await Promise.resolve();
  assert.equal(f.store.getSnapshot().warning, true); assert.equal(f.store.getSnapshot().revision, 2);
  a(); assert.equal(f.calls.length, 1); b(); assert.equal(f.calls.length, 2); assert.equal(f.events.size, 0); assert.equal(f.timers.size, 0);
});
test('a silent channel loses safe assurance when freshness expires', () => {
  const f = fixture(); const stop = f.store.subscribe(() => {}); f.emit(ready());
  assert.equal(f.timers.size, 1); f.advance(60000); [...f.timers.values()][0].fn();
  assert.equal(f.store.getSnapshot().status, 'stale'); assert.equal(f.store.getSnapshot().warning, null); stop();
});
test('unmount rejects late response; remount marks old retained snapshot stale', async () => {
  const f = fixture(); const stop = f.store.subscribe(() => {}); f.emit(ready()); stop();
  f.advance(70000); const stopAgain = f.store.subscribe(() => {});
  assert.equal(f.store.getSnapshot().status, 'stale'); stopAgain();
  f.resolve(ready({ revision: 3 })); await Promise.resolve(); assert.equal(f.store.getSnapshot().status, 'stale');
  assert.equal(f.calls[1][1], f.calls[0][1]); assert.notEqual(f.calls[0][1], f.calls[2][1]);
});
test('IPC error is visible and listeners/timers still clean up', async () => {
  const store = createDiskCapacityStore({ ipc: { on() {}, removeListener() {}, invoke() { return Promise.reject(Error('down')); } } });
  const stop = store.subscribe(() => {}); await Promise.resolve(); assert.equal(store.getSnapshot().status, 'error'); stop();
});
test('a failed old subscribe ACK cannot replace a newer push measurement', async () => {
  let reject, receive; const pending = new Promise((_resolve, fail) => { reject = fail; });
  const store = createDiskCapacityStore({ now: () => 100, ipc: { on(_name, cb) { receive = cb; }, removeListener() {},
    invoke(name) { return name.endsWith('unsubscribe') ? Promise.resolve() : pending; } } });
  const stop = store.subscribe(() => {}); receive({}, ready({ revision: 4 })); reject(Error('late failure'));
  await Promise.resolve(); assert.equal(store.getSnapshot().status, 'ready'); assert.equal(store.getSnapshot().revision, 4); stop();
});
