'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { issue, settled } = require('./perf-profile-lifetime');

test('deadline does not cancel the original operation or renew its wait', async () => {
  let complete, waits = 0, sends = 0, changes = 0, now = 1;
  const op = issue('Tracing.start', () => { sends++; return new Promise(resolve => { complete = resolve; }); },
    { now: () => now, onSettle: () => changes++ });
  const options = { now: () => now, until: 100,
    commandDeadline: async () => { waits++; throw Error('timeout'); } };
  assert.equal(await settled(op, options), false);
  assert.equal(await settled(op, options), false); assert.equal(waits, 1); assert.equal(sends, 1);
  now = 101; complete({}); await op.promise;
  assert.equal(await settled(op, options), true); assert.equal(changes, 1);
  assert.equal(op.issuedMonoMs, 1); assert.equal(op.settledMonoMs, 101);
});

test('revoked cleanup authority prevents transport invocation even with deferred dispatch', async () => {
  let own = true, sends = 0;
  const op = issue('Tracing.end', () => { sends++; }, { now: () => 1, allowed: () => own });
  own = false; await op.promise;
  assert.equal(op.state, 'refused'); assert.equal(op.sent, false); assert.equal(sends, 0);
});

test('transport rejection remains unknown, exact trace busy rejection alone is no-effect proof', async () => {
  for (const [method, error, expected] of [
    ['Tracing.start', Error('timeout'), 'unknown'],
    ['Profiler.stop', Error('not running maybe'), 'unknown'],
    ['Tracing.start', Error('Tracing is already started'), 'refused'],
    ['Tracing.start', Object.assign(Error('preflight'), { notSent: true }), 'refused'],
  ]) {
    const op = issue(method, () => Promise.reject(error), { now: () => 1 });
    await op.promise; assert.equal(op.state, expected);
  }
});

test('throwing diagnostic settle hook cannot discard the successful raw proof', async () => {
  const op = issue('Profiler.stop', () => ({ profile: {} }), {
    now: () => 1, onSettle: () => { throw Error('observer'); },
  });
  await op.promise; assert.equal(op.state, 'ok'); assert.ok(op.value.profile);
});
