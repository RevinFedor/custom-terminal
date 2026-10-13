'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { capacityProjection, readCacheDiskBytes, readFreeDiskBytes, createDiskCapacityService,
  installDiskCapacityIpc } = require('./disk-capacity-service');
const GiB = 1024 ** 3;
const projection = (free, used) => capacityProjection(free * GiB, used * GiB, 20 * GiB, 6 * GiB);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('RAM counters ride the existing sample and remain independent of disk scan failure', async () => {
  let calls = 0;
  const service = createDiskCapacityService({ cacheDirectory: '/cache', budgetBytes: 32 * GiB,
    readUsage: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    getRamUsage: () => { calls++; return { status: 'ready', approxBytes: GiB, budgetBytes: 2 * GiB }; } });
  const value = await service.sample();
  assert.equal(value.status, 'error'); assert.equal(value.cacheBytes, null);
  assert.equal(value.ram.approxBytes, GiB); assert.equal(value.ram.budgetBytes, 2 * GiB);
  assert.equal(value.budgetBytes, 32 * GiB); assert.equal(calls, 1); service.destroy();
});
function timers() {
  let i = 0; const pending = new Map();
  return { pending, setTimeoutFn(fn, ms) { pending.set(++i, { fn, ms }); return i; },
    clearTimeoutFn(id) { pending.delete(id); } };
}

test('user examples and exact reserve use remaining growth, not full limit or RAM', () => {
  assert.equal(projection(5, 14).warning, true);
  assert.equal(projection(10, 12).projectedFreeBytes, 2 * GiB);
  assert.equal(projection(10, 12).warning, true);
  assert.equal(projection(12, 14).warning, false);
  assert.equal(projection(12, 14).projectedFreeBytes, 6 * GiB);
  assert.equal(capacityProjection(12 * GiB - 1, 14 * GiB, 20 * GiB, 6 * GiB).warning, true);
});
test('over-budget cache never invents future free bytes; zero disk is real warning', () => {
  assert.equal(projection(5, 24).remainingGrowthBytes, 0);
  assert.equal(projection(5, 24).warning, true);
  assert.equal(projection(7, 24).warning, false);
  assert.equal(projection(0, 0).projectedFreeBytes, -20 * GiB);
  for (const value of [null, undefined, NaN, -1, Infinity]) assert.throws(() => capacityProjection(value, 0, 20 * GiB, 6 * GiB));
});
test('async inventory includes old/new schema, sidecars and root files but no unrelated files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'disk-capacity-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'cache');
  await fs.mkdir(path.join(root, 'v1'), { recursive: true }); await fs.mkdir(path.join(root, 'v2'));
  for (const [name, size] of [['v1/a.sqlite', 11], ['v1/a.sqlite-wal', 13], ['v2/b.sqlite-shm', 17], ['v2/x.tmp', 19], ['loose', 23], ['v2/b.state.sqlite', 29], ['v2/b.timeline.sqlite', 31]])
    await fs.writeFile(path.join(root, name), Buffer.alloc(size));
  await fs.writeFile(path.join(dir, 'unrelated'), Buffer.alloc(333));
  assert.equal(await readCacheDiskBytes(root), 143);
  assert.equal(await readCacheDiskBytes(path.join(dir, 'not-created')), 0);
  const free = await readFreeDiskBytes(path.join(dir, 'not-created', 'v1'));
  assert.ok(Number.isSafeInteger(free) && free > 0);
  await assert.rejects(readCacheDiskBytes(root, { maxEntries: 2 }), /scan-limit/);
  await fs.symlink(path.join(dir, 'unrelated'), path.join(root, 'link'));
  await assert.rejects(readCacheDiskBytes(root), /cache-symlink/);
});
test('permission failures do not masquerade as empty cache or search another volume', async () => {
  const error = Object.assign(new Error('denied'), { code: 'EACCES' }); let statCalls = 0;
  await assert.rejects(readCacheDiskBytes('/private/cache', { fsApi: { lstat: async () => { throw error; } } }), /denied/);
  await assert.rejects(readFreeDiskBytes('/private/cache', { fsApi: { statfs: async () => { statCalls++; throw error; } } }), /denied/);
  assert.equal(statCalls, 1);
});

test('scan limits identify elapsed time versus entry count without changing unknown to healthy', async () => {
  const stat = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, size: 1 };
  const fsApi = { lstat: async () => stat };
  let elapsed = 0;
  const delayedFs = { ...fsApi, lstat: async () => { elapsed = 5001; return { ...stat, isDirectory: () => true }; },
    opendir: async () => ({ async *[Symbol.asyncIterator]() { yield { name: 'one' }; } }) };
  let freeCalls = 0;
  const lines = [];
  const service = createDiskCapacityService({ cacheDirectory: '/private/do-not-log', now: () => elapsed,
    fsApi: delayedFs, readFree: async () => { freeCalls++; return 1; }, log: { warn: line => lines.push(line) } });
  const result = await service.sample();
  assert.equal(result.status, 'error');
  assert.equal(result.warning, null);
  assert.equal(result.scanDiagnostic.limit, 'duration');
  assert.equal(result.scanDiagnostic.scannedEntries, 1);
  assert.equal(freeCalls, 0);
  assert.ok(!lines.join('').includes('/private'));
  service.destroy();
  await assert.rejects(readCacheDiskBytes('/cache', { fsApi, maxEntries: 0 }), error =>
    error.code === 'scan-limit' && error.scanDiagnostic.limit === 'entries');
});
test('available blocks, not all free blocks, define writable space', async () => {
  assert.equal(await readFreeDiskBytes('/cache', { fsApi: { statfs: async () => ({ bavail: 9n, bfree: 40n, bsize: 4096n }) } }), 9 * 4096);
});
test('coalesced subscribers share one slow sample, one timer and fresh reuse', async () => {
  const clock = timers(), delay = deferred(); let reads = 0, now = 100; const seen = [];
  const service = createDiskCapacityService({ cacheDirectory: '/cache', ...clock, now: () => now,
    readUsage: async () => { reads++; await delay.promise; return 14 * GiB; }, readFree: async () => 5 * GiB });
  const a = service.subscribe('a', v => seen.push(['a', v])); const b = service.subscribe('b', v => seen.push(['b', v]));
  assert.equal(a, b); assert.equal(reads, 1); delay.resolve(); await a;
  assert.equal(seen.length, 2); assert.equal(clock.pending.size, 1);
  assert.equal([...clock.pending.values()][0].ms, 30000);
  assert.equal(service.snapshot().warning, true); assert.equal(service.snapshot().expiresAt, 60100);
  await service.subscribe('c', () => {}); assert.equal(reads, 1);
  service.unsubscribe('a'); service.unsubscribe('b'); assert.equal(clock.pending.size, 1);
  service.unsubscribe('c'); assert.equal(clock.pending.size, 0);
  now += 31000; await service.subscribe('d', () => {}); assert.equal(reads, 2);
  service.destroy(); assert.equal(clock.pending.size, 0);
});
test('measurement failure clears current assurance and can recover next sample', async () => {
  let fail = false;
  const service = createDiskCapacityService({ cacheDirectory: '/cache',
    readUsage: async () => { if (fail) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return 0; }, readFree: async () => 40 * GiB });
  assert.equal((await service.sample()).warning, false); fail = true;
  const failed = await service.sample(); assert.equal(failed.status, 'error'); assert.equal(failed.freeBytes, null); assert.equal(failed.warning, null);
  fail = false; assert.equal((await service.sample()).status, 'ready'); service.destroy();
});
test('destroy during scan cannot publish, read free space or restart a timer', async () => {
  const delay = deferred(), clock = timers(); let publishes = 0, freeReads = 0;
  const service = createDiskCapacityService({ cacheDirectory: '/cache', ...clock,
    readUsage: () => delay.promise, readFree: async () => { freeReads++; return 40 * GiB; } });
  const pending = service.subscribe('a', () => publishes++); service.destroy(); delay.resolve(0); await pending;
  assert.equal(publishes, 0); assert.equal(freeReads, 0); assert.equal(clock.pending.size, 0);
  assert.equal(service.snapshot().status, 'unknown');
});
test('IPC replaces leases, rejects late unsubscribe and cleans navigation/destroy listeners', async () => {
  const handlers = new Map(), clock = timers(); let scans = 0;
  const service = createDiskCapacityService({ cacheDirectory: '/cache', ...clock,
    readUsage: async () => { scans++; return 0; }, readFree: async () => 40 * GiB });
  const ipcMain = { handle: (k, v) => handlers.set(k, v), removeHandler: k => handlers.delete(k) };
  const sender = new EventEmitter(); Object.assign(sender, { id: 1, isDestroyed: () => false, send() {} });
  const dispose = installDiskCapacityIpc({ ipcMain, service }); const event = { sender };
  const sub = token => handlers.get('system:disk-capacity-subscribe')(event, token);
  const unsub = token => handlers.get('system:disk-capacity-unsubscribe')(event, token);
  await sub('a'); await sub('a'); await sub('b'); assert.equal(scans, 1); assert.equal(sender.listenerCount('destroyed'), 1);
  unsub('a'); assert.equal(clock.pending.size, 1);
  sender.emit('did-start-navigation', {}, '/new', false, false); assert.equal(clock.pending.size, 1);
  sender.emit('did-start-navigation', {}, '/new', false, true); assert.equal(clock.pending.size, 0);
  await sub('c'); sender.emit('destroyed'); assert.equal(clock.pending.size, 0);
  assert.equal(sender.listenerCount('did-start-navigation'), 0);
  dispose(); assert.equal(handlers.size, 0);
});
test('logs state/error transitions and slow samples, not every healthy or unchanged error tick', async () => {
  let clock = 100, duration = 0, free = 40 * GiB, error = null;
  const lines = []; const log = { log: line => lines.push(line), warn: line => lines.push(line) };
  const service = createDiskCapacityService({ cacheDirectory: '/private/never-log-this-path', log, now: () => clock,
    readUsage: async () => { clock += duration; if (error) throw error; return 14 * GiB; }, readFree: async () => free });
  await service.sample(); await service.sample(); assert.equal(lines.length, 1);
  free = 5 * GiB; await service.sample(); await service.sample(); assert.equal(lines.length, 2);
  duration = 251; await service.sample(); assert.equal(lines.length, 3);
  duration = 0; error = Object.assign(Error('secret path /never-leak'), { code: 'EACCES' });
  await service.sample(); await service.sample(); assert.equal(lines.length, 4);
  error = Object.assign(Error('another secret'), { code: '/secret-code' });
  assert.equal((await service.sample()).errorCode, 'measure-failed'); assert.equal(lines.length, 5);
  error = null; free = 40 * GiB; await service.sample(); assert.equal(lines.length, 6);
  assert.ok(lines.every(line => line.startsWith('[DiskCapacity] ') && !/secret|never-log|never-leak/.test(line)));
  const records = lines.map(line => JSON.parse(line.slice('[DiskCapacity] '.length)));
  assert.deepEqual(records.map(r => r.state), ['ready-healthy','ready-warning','ready-warning','error','error','ready-healthy']);
  assert.equal(records[2].slow, true); assert.equal(records[2].transition, false); assert.equal(records[2].durMs, 251);
  assert.equal(records[1].source, 'statfs+cache-file-metadata');
  assert.equal(records[1].remainingGrowthBytes, 6 * GiB); assert.equal(records[1].projectedFreeBytes, -GiB);
  assert.equal(records[3].errorCode, 'EACCES'); assert.equal(records[3].freeBytes, null);
  service.destroy();
});
test('owned errors use codes; arbitrary messages/codes never cross IPC', async () => {
  const { diskCapacityErrorCode } = require('./disk-capacity-service');
  for (const code of ['EACCES','ENOENT','ENOSPC','EPERM','scan-limit','cache-symlink','cancelled','invalid-measurement'])
    assert.equal(diskCapacityErrorCode({ code, message: '/private/secret' }), code);
  for (const error of [Error('/private/secret'), Error('scan-limit'), { code: 'ERR_/private/secret' }, null])
    assert.equal(diskCapacityErrorCode(error), 'measure-failed');
  const logs=[];
  const service = createDiskCapacityService({ cacheDirectory: '/cache', log: { log() {}, warn: value => logs.push(value) },
    readUsage: async () => { throw Error('path=/Users/example/private body'); } });
  const value = await service.sample(); assert.equal(value.errorCode,'measure-failed');
  assert.ok(!/Users|private body/.test(JSON.stringify(value))); assert.ok(!/Users|private body/.test(logs.join(''))); service.destroy();
});
