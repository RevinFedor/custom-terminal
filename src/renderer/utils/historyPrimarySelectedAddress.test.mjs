import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryPrimarySelectedAddress } from './historyPrimarySelectedAddress.mjs';
import { historyPrimaryAddressCut } from './historyPrimaryPresentationAddress.mjs';

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function rig() {
  const headers = n => ({ leaseId: 'L' + n, ownerKey: 'owner', revision: 'R' + n, generation: 'G',
    semanticIdentity: 'S' + n, metadataIdentity: 'M' + n, semanticRevisionToken: 'SR' + n, viewRevisionToken: 'VR' + n });
  const window = new Map(), root = { header: headers(1), totalCount: 10000, closed: false, addressAt: index => window.get(index) };
  const address = (key, index = 70) => ({ physicalKey: key, index, header: root.header, cut: historyPrimaryAddressCut(root.header) });
  const requests = [], errors = [];
  const selected = createHistoryPrimarySelectedAddress({
    onError: error => errors.push(error),
    read: (owner, kind, key, options) => new Promise((resolve, reject) => requests.push({ owner, kind, key, options, resolve, reject })),
  });
  return { root, headers, address, window, requests, errors, selected };
}
test('one selected UUID fallback retains the exact absent-key proof and does not query on every convergence frame', async () => {
  const r = rig(), pending = r.selected.resolveKeyOrTarget(r.root, 'removed-key', 'u');
  await tick(); assert.equal(r.requests.length, 1); assert.equal(r.requests[0].kind, 'key');
  r.requests[0].resolve({ root: r.root, header: r.root.header, address: null });
  await tick(); assert.equal(r.requests.length, 2); assert.equal(r.requests[1].kind, 'entry');
  const address = r.address('new-key', 9);
  r.requests[1].resolve({ root: r.root, header: r.root.header, address });
  assert.equal((await pending).address, address);
  for (let i = 0; i < 40; i++) {
    assert.equal((await r.selected.resolveKeyOrTarget(r.root, 'removed-key', 'u')).address, address);
  }
  assert.equal(r.requests.length, 2); assert.equal(r.selected.stats().selected, 1);
  const changed = r.selected.resolveKeyOrTarget(r.root, 'different-key', 'u');
  await tick(); assert.equal(r.requests.length, 3); assert.equal(r.requests[2].kind, 'key');
  r.requests[2].resolve({ root: r.root, header: r.root.header, address: r.address('different-key', 10) });
  assert.equal((await changed).address.index, 10, 'a new exact key keeps priority over the old UUID fallback');
  r.selected.dispose();
});
test('one active exact key survives body eviction and rebinds only with a new-cut proof', async () => {
  const r = rig(), key = 'entry:\u0000\ud800😀' + 'x'.repeat(9000), a = r.address(key);
  r.window.set(70, a);
  assert.equal(r.selected.seed(r.root, 'key', key, a).status, 'ready');
  r.window.clear();
  assert.equal(r.selected.read(r.root, 'key', key).address, a);
  assert.equal(r.requests.length, 0);
  r.root.header = r.headers(2);
  const newAddress = r.address(key); r.window.set(70, newAddress);
  assert.equal(r.selected.read(r.root, 'key', key).address, newAddress);
  assert.equal(r.requests.length, 0, 'an already admitted bounded address proves the same key');
  r.root.header = r.headers(3); r.window.clear();
  const pending = r.selected.read(r.root, 'key', key);
  assert.equal(pending.status, 'pending'); await tick();
  assert.equal(r.requests.length, 1);
  assert.equal(r.selected.peek(r.root, 'key', key).status, 'pending');
  const moved = r.address(key, 12);
  r.requests[0].resolve({ root: r.root, header: r.root.header, address: moved });
  assert.equal((await pending.promise).address, moved);
  await tick(); assert.deepEqual(r.selected.stats(), { selected: 1, running: 0, pending: 0 });
});
test('rapid unseen targets keep one running request and one replaceable pending demand', async () => {
  const r = rig(), old = r.selected.read(r.root, 'key', 'A'); await tick();
  let last;
  for (let i = 0; i < 100; i++) last = r.selected.read(r.root, 'key', 'K' + i);
  assert.equal(r.requests.length, 1);
  assert.deepEqual(r.selected.stats(), { selected: 1, running: 1, pending: 1 });
  assert.equal((await old.promise).status, 'superseded');
  assert.equal(r.requests[0].options.signal.aborted, true);
  r.requests[0].resolve({ root: r.root, header: r.root.header, address: r.address('A') });
  await tick(); assert.equal(r.requests.length, 2); assert.equal(r.requests[1].key, 'K99');
  const a = r.address('K99');r.requests[1].resolve({ root: r.root, header: r.root.header, address: a });
  assert.equal((await last.promise).address, a);await tick();
  assert.deepEqual(r.selected.stats(), { selected: 1, running: 0, pending: 0 });
});
test('stale owner, cancellation and UNKNOWN never become an absent result or replay', async () => {
  const r = rig(), signal = new AbortController();
  const first = r.selected.read(r.root, 'key', 'A', { signal: signal.signal });await tick();
  signal.abort(); assert.equal((await first.promise).status, 'superseded');
  assert.equal(r.requests[0].options.signal.aborted, true);
  r.requests[0].reject(Object.assign(Error('cancelled'), { code: 'HISTORY_READ_CANCELLED' }));await tick();
  const second = r.selected.read(r.root, 'key', 'B');await tick();
  const unknown = Object.assign(Error('UNKNOWN'), { code: 'UNKNOWN' });r.requests[1].reject(unknown);
  assert.equal((await second.promise).status, 'failed');assert.equal(second.error, unknown);await tick();
  for (let i = 0; i < 50; i++) assert.equal(r.selected.read(r.root, 'key', 'B'), second);
  assert.equal(r.requests.length, 2, 'same-cut failure is not an automatic retry');
  assert.deepEqual(r.errors, [unknown]);
  let owns = true;const third = r.selected.read(r.root, 'key', 'C', { owns: () => owns });await tick();
  owns = false;r.requests[2].resolve({ root: r.root, header: r.root.header, address: r.address('C') });
  assert.equal((await third.promise).status, 'superseded');assert.equal(r.selected.peek(r.root, 'key', 'C'), null);
});
test('malformed or wrong-cut address is refused and close releases the selected owner', async () => {
  const r = rig(), state = r.selected.read(r.root, 'key', 'A');await tick();
  const wrong = r.address('B');r.requests[0].resolve({ root: r.root, header: r.root.header, address: wrong });
  assert.equal((await state.promise).status, 'failed');assert.match(state.error.message, /ADDRESS_INVALID/);await tick();
  const next = r.selected.read(r.root, 'key', 'C');await tick();r.selected.dispose();
  assert.equal((await next.promise).status, 'superseded');
  r.requests[1].resolve({ root: r.root, header: r.root.header, address: r.address('C') });await tick();
  assert.deepEqual(r.selected.stats(), { selected: 0, running: 0, pending: 0 });
  assert.equal(r.selected.read(r.root, 'key', 'D').status, 'superseded');assert.equal(r.requests.length, 2);
});
