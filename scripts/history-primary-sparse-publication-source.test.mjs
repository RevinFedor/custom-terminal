// SOURCE controls for the actual V52 CURRENT-local publication owner. These
// tests use native rows and synthetic retained handles solely to control
// lifecycle/reentry. They make no producer, IPC, layout, paint or native claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { createHistoryPrimarySparsePublicationOwner } from '../src/renderer/utils/historyPrimarySparsePublication.mjs';

assert(getHeapStatistics().heap_size_limit <= 70 * 1024 ** 2, '64MiB old/2MiB semi runtime cap required');
const filename = new URL('../src/renderer/utils/historyPrimarySparsePublication.mjs', import.meta.url);
const source = fs.readFileSync(filename);
console.log('V52_SPARSE_PUBLICATION_SOURCE ' + JSON.stringify({
  sha256: createHash('sha256').update(source).digest('hex'), bytes: source.length,
  node: process.version, heapLimit: getHeapStatistics().heap_size_limit,
  electron: process.versions.electron || null,
}));
const scope = Object.freeze({ ownerKey: 'A', generation: 1 });
const turn = () => new Promise(resolve => setImmediate(resolve));
const cancelled = error => error?.code === 'HISTORY_READ_CANCELLED';
const local = (id, extra = {}) => ({ uuid: 'local-prompt-' + id, role: 'queued', content: 'full native text ' + id, ...extra });
const isLocal = row => row.role === 'queued';
function candidate({ current = () => true, onRetain = () => {}, closeError = null } = {}) {
  const header = Object.freeze({}), receiptDataSubject = Object.freeze({}), handles = [];
  let retains = 0, parentCloses = 0;
  const prepared = {
    header, receiptDataSubject, closed: false,
    retain() {
      retains++;
      const held = { header, receiptDataSubject, closed: false, closes: 0,
        close() { this.closes++; this.closed = true; if (closeError) return Promise.reject(closeError); } };
      handles.push(held); onRetain(); return held;
    },
    close() { parentCloses++; },
  };
  const proof = { prepared, publication: Object.freeze({ header, dataSubject: receiptDataSubject }), isCurrent: current };
  return { proof, handles, get retains() { return retains; }, get parentCloses() { return parentCloses; } };
}

test('CURRENT-only publication is synchronous, preserves native identity/full values and never reads historical payloads', () => {
  let contentReads = 0;
  const historical = { uuid: 'history', role: 'user', get content() { contentReads++; throw Error('HISTORICAL_PAYLOAD_READ'); } };
  const chips = [{ id: 9n, kind: 'prompt', text: 'untruncated\n' + 'x'.repeat(4096) }];
  const image = { path: '/synthetic/full image.png', size: 2n ** 63n, marker: Symbol('native') };
  const first = local('one', { promptChips: chips, imagePaths: [image] }), second = local('two');
  const entries = [historical, first, second];
  const owner = createHistoryPrimarySparsePublicationOwner({ isLocal });
  const publication = owner.publishCompatibility(entries, scope);
  assert.equal(publication.kind, 'current-local-only');
  assert.equal(publication.prepared, null); assert.equal(publication.sparse, null);
  assert.equal(publication.entries.deref(), entries); assert.equal(contentReads, 0);
  assert.equal(publication.rows.length, 2); assert.equal(publication.rows[0], first);
  assert.equal(publication.rows[1], second); assert.equal(publication.rows[0].promptChips, chips);
  assert.equal(publication.rows[0].imagePaths[0], image); assert(Object.isFrozen(publication.rows));
  assert.equal(owner.localRows(scope), publication.rows);
  assert.equal(owner.matches(publication, entries, scope), true);
  assert.equal(owner.matches(publication, [...entries], scope), false);
  assert.equal(owner.localRows({ ...scope, generation: 2 }), null);
  owner.close(); assert.equal(owner.current(), null);
});

test('same-array return replays the caller witness without rescanning immutable row membership', () => {
  let classifications = 0, checks = 0;
  const owner = createHistoryPrimarySparsePublicationOwner({ isLocal: row => { classifications++; return isLocal(row); } });
  const entries = [local('one')], first = owner.publishCompatibility(entries, scope);
  assert.throws(() => owner.publishCompatibility(entries, scope, { owns() { checks++; return false; } }), cancelled);
  assert.equal(owner.current(), first); assert.equal(classifications, 1); assert.equal(checks, 1);
  assert.equal(owner.publishCompatibility(entries, scope, { owns() { checks++; return true; } }), first);
  assert.equal(classifications, 1); assert.equal(checks, 2); owner.close();
});

test('initial null publication cannot survive reentrant clear or close during native classification', () => {
  for (const action of ['clear', 'close']) {
    let owner;
    owner = createHistoryPrimarySparsePublicationOwner({ isLocal(row) { owner[action](); return isLocal(row); } });
    assert.throws(() => owner.publishCompatibility([local(action)], scope), cancelled);
    assert.equal(owner.current(), null); owner.close();
  }
});

test('same-array original owner cannot survive clear/close in its final full witness', () => {
  for (const action of ['clear', 'close']) {
    const owner = createHistoryPrimarySparsePublicationOwner({ isLocal }), entries = [local(action)];
    owner.publishCompatibility(entries, scope);
    assert.throws(() => owner.publishCompatibility(entries, scope, { owns() { owner[action](); return true; } }), cancelled);
    assert.equal(owner.current(), null); owner.close();
  }
});

test('nested publication wins and the interrupted outer classification cannot replace it', () => {
  let owner, nested, entered = false;
  const winner = local('winner'), outer = local('outer');
  owner = createHistoryPrimarySparsePublicationOwner({ isLocal(row) {
    if (row === outer && !entered) { entered = true; nested = owner.publishCompatibility([winner], scope); }
    return isLocal(row);
  } });
  assert.throws(() => owner.publishCompatibility([outer], scope), cancelled);
  assert.equal(owner.current(), nested); assert.equal(owner.localRows(scope)[0], winner); owner.close();
});

test('classification must precede the original full caller witness even when cheap ownership is unchanged', () => {
  const handoff = { text: 'original' }, previous = [local('prior')], next = [local('next')];
  const order = [];
  const owner = createHistoryPrimarySparsePublicationOwner({ isLocal(row) {
    order.push('classify:' + row.uuid);
    if (row === next[0]) handoff.text = 'replacement';
    return isLocal(row);
  } });
  const before = owner.publishCompatibility(previous, scope); order.length = 0;
  assert.throws(() => owner.publishCompatibility(next, scope, { owns() { order.push('original-witness'); return handoff.text === 'original'; } }), cancelled);
  assert.deepEqual(order, ['classify:local-prompt-next', 'original-witness']);
  assert.equal(owner.current(), before); assert.equal(owner.localRows(scope)[0], previous[0]); owner.close();
});

test('prepared adoption retains independently, same-owner locals reuse it, handoff releases it exactly once', async () => {
  const owner = createHistoryPrimarySparsePublicationOwner({ isLocal }), proof = candidate();
  const first = owner.adopt(proof.proof, [local('one')], scope), held = proof.handles[0];
  assert.equal(proof.retains, 1); assert.equal(first.prepared, held);
  assert.equal(first.sparse, proof.proof.publication); assert.equal(first.kind, 'prepared-with-current-locals');
  const next = owner.publishCompatibility([local('two')], scope);
  assert.equal(next.prepared, held); assert.equal(next.sparse, first.sparse); assert.equal(held.closes, 0);
  const changedOwner = owner.publishCompatibility([local('B')], { ownerKey: 'B', generation: 2 });
  assert.equal(changedOwner.prepared, null); assert.equal(changedOwner.sparse, null);
  await turn(); assert.equal(held.closes, 1); assert.equal(proof.parentCloses, 0);
  owner.clear(); owner.close(); owner.close(); await turn(); assert.equal(held.closes, 1);
});

test('failed adoption after retaining closes only the newly held child and preserves the prior publication', async () => {
  let armed = false;
  const thrown = Error('native classifier failure');
  const owner = createHistoryPrimarySparsePublicationOwner({ isLocal(row) { if (armed) throw thrown; return isLocal(row); } });
  const first = candidate(), before = owner.adopt(first.proof, [local('old')], scope);
  const second = candidate(); armed = true;
  assert.throws(() => owner.adopt(second.proof, [local('new')], scope), error => error === thrown);
  await turn(); assert.equal(owner.current(), before); assert.equal(first.handles[0].closes, 0);
  assert.equal(second.handles[0].closes, 1); assert.equal(second.parentCloses, 0);
  owner.close(); await turn(); assert.equal(first.handles[0].closes, 1);
});

test('reentrant initial proof validation and retain cannot publish after clear or close', async () => {
  for (const action of ['clear', 'close']) {
    let owner = createHistoryPrimarySparsePublicationOwner({ isLocal });
    const beforeRetain = candidate({ current() { owner[action](); return true; } });
    assert.throws(() => owner.adopt(beforeRetain.proof, [local(action)], scope), cancelled);
    assert.equal(beforeRetain.retains, 0); assert.equal(owner.current(), null); owner.close();
    owner = createHistoryPrimarySparsePublicationOwner({ isLocal });
    const afterRetain = candidate({ onRetain() { owner[action](); } });
    assert.throws(() => owner.adopt(afterRetain.proof, [local(action)], scope), cancelled);
    await turn(); assert.equal(afterRetain.handles[0].closes, 1); assert.equal(owner.current(), null); owner.close();
  }
});

test('clear/close during adopted row classification or the final proof releases the new child', async () => {
  for (const stage of ['classify', 'proof']) for (const action of ['clear', 'close']) {
    let owner, checks = 0;
    owner = createHistoryPrimarySparsePublicationOwner({ isLocal(row) {
      if (stage === 'classify') owner[action](); return isLocal(row);
    } });
    const proof = candidate({ current() { checks++; if (stage === 'proof' && checks === 2) owner[action](); return true; } });
    assert.throws(() => owner.adopt(proof.proof, [local(stage + action)], scope), cancelled);
    await turn(); assert.equal(owner.current(), null); assert.equal(proof.handles[0].closes, 1);
    assert.equal(proof.parentCloses, 0); owner.close();
  }
});

test('a closed retained child cannot certify a same-array publication', async () => {
  const owner = createHistoryPrimarySparsePublicationOwner({ isLocal }), proof = candidate(), entries = [local('one')];
  const before = owner.adopt(proof.proof, entries, scope);
  proof.handles[0].closed = true;
  assert.throws(() => owner.publishCompatibility(entries, scope), cancelled);
  assert.equal(owner.current(), before); assert.equal(owner.matches(before, entries, scope), false);
  owner.close(); await turn(); assert.equal(proof.handles[0].closes, 1);
});

test('failed release remains diagnostic UNKNOWN and a throwing diagnostic cannot cause a secondary rejection', async () => {
  const error = Error('RAW_CLOSE_RECEIPT_LOST'), reports = [], unhandled = [];
  const listener = value => unhandled.push(value); process.on('unhandledRejection', listener);
  const owner = createHistoryPrimarySparsePublicationOwner({ isLocal, onReleaseError(value) { reports.push(value); throw Error('DIAGNOSTIC_FAILED'); } });
  const proof = candidate({ closeError: error });
  try {
    owner.adopt(proof.proof, [local('one')], scope); owner.clear();
    await turn(); await turn();
    assert.equal(owner.current(), null); assert.equal(proof.handles[0].closes, 1);
    assert.deepEqual(reports, [error]); assert.deepEqual(unhandled, []);
    owner.close(); await turn(); assert.equal(proof.handles[0].closes, 1);
  } finally { process.off('unhandledRejection', listener); owner.close(); }
});
