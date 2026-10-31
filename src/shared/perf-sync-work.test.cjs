'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSyncWorkRing } = require('./perf-sync-work.cjs');
function setup(extra = {}) { let t = 10; const r = createSyncWorkRing({ now: () => t, capacity: 8, ...extra });
  r.configure({ enabled: true }); return { r, tick: ms => { t += ms; } }; }
test('sync boundary retains returned Promise identity and does not touch then/getters', () => {
  const { r, tick } = setup(); const value = { get then() { throw Error('then read'); } };
  assert.equal(r.run('test.decode', { get owner() { throw Error('owner read'); } }, () => { tick(200); return value; }), value);
  const p = Promise.resolve(1); assert.equal(r.run('test.asyncPrefix', {}, () => p), p);
  const rows = r.snapshot().rows; assert.equal(rows[0].wallMs, 200); assert.equal(rows[0].owner, null);
  assert.equal(rows[1].wallMs, 0); assert.equal(rows[0].threadCpuMs, null);
});
test('nested calls, exact thrown value, origin and ownership survive without reading body', () => {
  const { r, tick } = setup(); const error = {};
  assert.throws(() => r.run('outer', { owner: 'tab-1', visit: 5, presented: false }, () => {
    tick(10); r.run('inner', { origin: 'observer', readId: 'r1', body: 'PRIVATE' }, () => tick(20)); throw error;
  }), x => x === error);
  const x = r.snapshot(); assert.equal(x.rows[0].outcome, 'threw'); assert.equal(x.rows[1].parentWork, x.rows[0].sequence);
  assert.equal(x.rows[0].presented, false); assert.equal(x.rows[1].origin, 'observer'); assert.doesNotMatch(JSON.stringify(x), /PRIVATE/);
});
test('bounded overwrite/freeze and late close cannot silently replace frozen identity', () => {
  const { r, tick } = setup(); for (let i = 0; i < 12; i++) r.run('site', {}, () => tick(1));
  assert.equal(r.snapshot().health.evictions[0], 4); const id = r.freeze(); assert.equal(r.freeze(), null);
  for (let i = 0; i < 12; i++) r.run('new', {}, () => tick(2));
  assert.equal(r.snapshot().rows.length, 8); assert(r.snapshot().rows.every(x => x.site === 'site'));
  assert.equal(r.release(id + 1), false); assert.equal(r.release(id), true);
  assert(r.snapshot().rows.every(x => x.site === 'new')); assert(r.health().typedBufferBytes <= 524288);
});
test('disabled recording, dictionary exhaustion, clock failure and open overwrite are explicit', () => {
  const { r, tick } = setup(); for (let i = 0; i < 150; i++) r.run('site'+i, {}, () => tick(1));
  assert(r.health().losses.ids > 0); r.configure({ enabled: false }); const before = r.health().sequence;
  assert.equal(r.run('ignored', {}, () => 8), 8); assert.equal(r.health().sequence, before);
  const bad = createSyncWorkRing({ now: () => { throw Error('clock'); } }); bad.configure({ enabled: true });
  assert.equal(bad.run('site', {}, () => 9), 9); assert.equal(bad.health().losses.clock, 1);
  r.configure({ enabled: true }); r.run('outer', {}, () => { for (let i = 0; i < 10; i++) r.run('inner', {}, () => tick(1)); });
  assert(r.health().losses.overwrittenOpen > 0);
});
test('selection is actual temporal overlap, omitted work is counted and nested durations not summed', () => {
  const { r, tick } = setup(); r.run('before', {}, () => tick(10)); r.run('during', {}, () => tick(200)); r.run('after', {}, () => tick(5));
  const s = r.snapshot({ from: 25, to: 100, limit: 1 }); assert.equal(s.rows.length, 1); assert.equal(s.rows[0].site, 'during');
  assert.match(s.coverage, /not-exclusive-cpu/);
});
