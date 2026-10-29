// Actual catalog presentation owner under finite callback/queued React frames.
// Prepared readers below are synthetic; connected IPC/model tests are separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getHeapStatistics } from 'node:v8';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createHistoryPrimaryAgentCatalogOwner } from '../src/renderer/utils/historyPrimaryAgentCatalogOwner.mjs';
assert(getHeapStatistics().heap_size_limit <= 80 * 1024 ** 2, 'runtime64/2 SOURCE budget');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const counts = Object.freeze({ total: 1, running: 0, completed: 1, interrupted: 0, background: 0 });
const record = key => ({ key, kind: 'subagent', status: 'completed', label: key, entryUuid: 'row-' + key, startedAt: 1 });

function frame({ queued = false } = {}) {
  let rendered = null;
  const updates = [], log = [], readers = [], releases = [];
  const owner = createHistoryPrimaryAgentCatalogOwner({
    onChange(update) { if (queued) updates.push(update); else rendered = update(rendered); },
    onReleaseError(error) { releases.push(error); },
  });
  const flush = () => { const queue = updates.splice(0); for (const update of queue) rendered = update(rendered); };
  const settle = async () => {
    for (let index = 0; index < 30; index++) {
      await tick();
      if (owner.state().running === null && !owner.state().pending) return;
    }
    throw Error('FIXTURE_OWNER_DID_NOT_SETTLE');
  };
  const input = ({ name = 'A', generation = 1, key = 'task:one', gate, missing = false,
    onReplay, onFull, valid = () => true, readGate } = {}) => {
    const reader = {
      counts, closed: false, closeCalls: 0, pages: [], lookups: [], memberships: [],
      async readPage(request) {
        reader.pages.push(request);
        if (readGate) await readGate.promise;
        request.owns();
        return { section: request.section, offset: request.offset,
          nextOffset: request.section === 'background' ? 0 : 1,
          done: true, rows: request.section === 'background' ? [] : [record(key)] };
      },
      async lookup(wanted, options) {
        reader.lookups.push(wanted); options.owns();
        return missing || wanted !== key ? { kind: 'missing', key: wanted }
          : { kind: 'found', key: wanted, record: record(key) };
      },
      async membership(kind, values, options) {
        options.owns(); reader.memberships.push({ kind, values });
        return values.map(value => ({ value, found: value === 'hit' }));
      },
      async close() { reader.closeCalls++; reader.closed = true; },
    };
    readers.push(reader);
    const source = {
      closeCalls: 0, openCalls: 0,
      retain() { return source; },
      async openAgentCatalog(_current, options) {
        source.openCalls++;
        if (gate) {
          const cancelled = new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('CANCELLED')), { once: true }));
          await Promise.race([gate.promise, cancelled]);
        }
        options.owns(); return reader;
      },
      async close() { source.closeCalls++; },
    };
    const candidate = {
      ownerKey: name, generation, prepared: source,
      current: { isCurrent() { log.push(name + ':replay'); onReplay?.(); return valid(); } },
      fullWitness() { log.push(name + ':full'); onFull?.(); return valid(); },
      ownerFence() { log.push(name + ':fence'); return valid(); },
    };
    return { candidate, source, reader };
  };
  return { owner, input, flush, settle, log, readers, releases, updates,
    rendered: () => rendered, close() { owner.close(); } };
}

test('actual owner publishes bounded pages and selected detail through original proof order', async () => {
  const f = frame(); const a = f.input();
  try {
    f.owner.update(a.candidate); f.owner.select('task:one'); await f.settle();
    assert.equal(f.rendered().status, 'ready');
    assert.equal(f.rendered().selected.kind, 'found');
    assert.equal(f.rendered().counts, counts);
    assert.equal(a.source.closeCalls, 1);
    const full = f.log.lastIndexOf('A:full');
    assert(full > 0); assert.equal(f.log[full - 1], 'A:replay');
    assert(f.log.slice(full + 1).every(value => value === 'A:fence'));
    assert.equal(a.reader.pages.length, 2, 'build consumes pending selection once');
  } finally { f.close(); await tick(); }
  assert.equal(a.reader.closeCalls, 1);
});

test('same-owner pending and error preserve old selected detail; proven missing is distinct', async () => {
  const f = frame(); const a = f.input(); const gate = deferred();
  try {
    f.owner.update(a.candidate); f.owner.select('task:one'); await f.settle();
    const old = f.rendered().selected.record;
    const next = f.input({ gate, missing: true });
    f.owner.update(next.candidate);
    assert.equal(f.rendered().status, 'pending');
    assert.equal(f.rendered().selected.kind, 'unknown');
    assert.equal(f.rendered().selected.record, old);
    gate.resolve(); await f.settle();
    assert.equal(f.rendered().status, 'ready');
    assert.equal(f.rendered().selected.kind, 'missing');
    assert.equal(f.rendered().selected.key, 'task:one');
    await tick(); assert.equal(a.reader.closeCalls, 1);
  } finally { f.close(); await tick(); }
});

test('a queued A publication cannot overwrite B after native full-witness reentry', async () => {
  const f = frame({ queued: true });
  let reenter = false;
  let snapshotAtReentry;
  const bGate = deferred(), b = f.input({ name: 'B', gate: bGate });
  const a = f.input({ onFull() { if (reenter) { reenter = false; snapshotAtReentry = f.owner.snapshot(); f.owner.update(b.candidate); } } });
  try {
    f.owner.update(a.candidate); await f.settle();
    // waiting and ready callbacks are queued. Reentry occurs only while the
    // actual ready updater executes, after its outer original-input check.
    reenter = true;
    f.flush();
    assert.equal(f.owner.snapshot(), snapshotAtReentry,
      'late A updater must return its previous snapshot, never publish a new A error after B update');
    f.flush();
    assert.equal(f.rendered().ownerKey, 'B');
    bGate.resolve(); await f.settle(); f.flush();
    assert.equal(f.rendered().ownerKey, 'B');
  } finally { f.close(); bGate.resolve(); await tick(); }
});

test('failed proof retires never-published candidate while preserving previous held detail', async () => {
  const f = frame(); const a = f.input();
  try {
    f.owner.update(a.candidate); f.owner.select('task:one'); await f.settle();
    const previous = f.rendered().selected.record;
    let checked = false;
    const invalid = f.input({ onFull() { checked = true; }, valid: () => !checked });
    f.owner.update(invalid.candidate); await f.settle(); await tick();
    assert.equal(f.rendered().selected.record, previous);
    assert.equal(f.rendered().selected.kind, 'unknown');
    assert.equal(invalid.reader.closeCalls, 1, 'unpublishable candidate must not remain held until a future user action');
    assert.equal(a.reader.closeCalls, 0, 'same-owner previous detail keeps its original held subject');
  } finally { f.close(); await tick(); }
});

test('reentrant selection cannot retire old reader before the replacement demand publishes', async () => {
  const f = frame({ queued: true }); const old = f.input();
  let reenter = false;
  const next = f.input({ onFull() { if (reenter) { reenter = false; f.owner.select('task:new-selection'); } } });
  try {
    f.owner.update(old.candidate); await f.settle(); f.flush();
    assert.equal(old.reader.closeCalls, 0);
    f.owner.update(next.candidate); await f.settle();
    reenter = true; f.flush();
    await f.settle();
    assert.equal(old.reader.closeCalls, 0, 'rejected old-demand updater may not retire the previously published reader');
    f.flush(); await tick();
    assert.equal(old.reader.closeCalls, 1);
    assert.equal(f.rendered().selected.key, 'task:new-selection');
  } finally { f.close(); await tick(); }
});

test('one running query and replaceable pending demand coalesce selected-key changes', async () => {
  const f = frame(); const a = f.input();
  try {
    f.owner.update(a.candidate); await f.settle();
    f.owner.select('task:first'); f.owner.select('task:second'); f.owner.select('task:one');
    await f.settle();
    assert.equal(f.rendered().selected.key, 'task:one');
    assert.equal(f.rendered().selected.kind, 'found');
    assert.equal(a.reader.lookups.filter(value => value === 'task:second').length, 0);
    assert.equal(f.owner.state().pending, false);
  } finally { f.close(); await tick(); }
});

test('owner A to B to A uses generation, and late queued callbacks cannot retarget', async () => {
  const f = frame({ queued: true });
  const a1 = f.input({ name: 'A', generation: 1 }), b = f.input({ name: 'B', generation: 2 });
  const a3 = f.input({ name: 'A', generation: 3 });
  try {
    f.owner.update(a1.candidate); await f.settle();
    f.owner.update(b.candidate); await f.settle();
    f.owner.update(a3.candidate); await f.settle();
    f.flush();
    assert.equal(f.rendered().ownerKey, 'A'); assert.equal(f.rendered().generation, 3);
    assert.equal(f.rendered().status, 'ready');
  } finally { f.close(); await tick(); }
});

test('close releases held subject and invalidates all queued publication callbacks', async () => {
  const f = frame({ queued: true }); const a = f.input();
  f.owner.update(a.candidate); await f.settle();
  f.close(); f.flush(); await tick();
  assert.equal(f.rendered(), null); assert.equal(f.owner.snapshot(), null);
  assert.equal(a.reader.closeCalls, 1);
});

test('expired original deadline refuses allocation and caller demand cannot renew it', async () => {
  const f = frame(), a = f.input();
  a.candidate.deadlineAt = Date.now() - 1;
  try {
    f.owner.update(a.candidate); await f.settle();
    assert.equal(f.rendered().status, 'error');
    assert.equal(f.rendered().error.code, 'HISTORY_AGENT_CATALOG_DEADLINE');
    assert.equal(a.source.closeCalls, 0, 'no prepared retain/allocation after original deadline');
    assert.equal(a.reader.pages.length, 0);
    f.owner.select('task:one'); await f.settle();
    assert.equal(f.rendered().error.code, 'HISTORY_AGENT_CATALOG_DEADLINE');
    assert.equal(a.reader.pages.length, 0, 'new demand cannot extend the original source deadline');
    assert.equal(f.owner.state().pending, false);
  } finally { f.close(); await tick(); }
});

test('queued publication rechecks absolute deadline and keeps old same-owner detail', async () => {
  const f = frame({ queued: true }), a = f.input(), b = f.input();
  try {
    f.owner.update(a.candidate); f.owner.select('task:one'); await f.settle(); f.flush();
    const old = f.rendered().selected.record;
    b.candidate.deadlineAt = Date.now() + 1000;
    f.owner.update(b.candidate); await f.settle();
    const originalNow = Date.now;
    try { Date.now = () => b.candidate.deadlineAt + 1; f.flush(); }
    finally { Date.now = originalNow; }
    await tick();
    assert.equal(f.rendered().status, 'error');
    assert.equal(f.rendered().error.code, 'HISTORY_AGENT_CATALOG_DEADLINE');
    assert.equal(f.rendered().selected.kind, 'unknown');
    assert.equal(f.rendered().selected.record, old);
    assert.equal(b.reader.closeCalls, 1, 'unpublished expired child retires once');
    assert.equal(a.reader.closeCalls, 0, 'old same-owner detail retains its original subject');
  } finally { f.close(); await tick(); }
});

test('mounted exact membership batches stay bounded, early-hit closes iterator and queries reuse one catalog', async () => {
  const f = frame(), a = f.input();
  let yielded = 0, closed = 0;
  const any = { id: 'actual-mounted-group', kind: 'entry', *values() {
    try { for (const value of ['one', 'two', 'three', 'hit', 'five', 'six', 'NEVER-READ']) { yielded++; yield value; } }
    finally { closed++; }
  } };
  const request = { entries: ['a', 'b', 'c', 'hit', 'e', 'f', 'g'], calls: ['one', 'hit', 'three', 'four'], any: [any] };
  try {
    f.owner.update(a.candidate); await f.settle();
    f.owner.requestMembership(request); await f.settle();
    assert.equal(a.source.openCalls, 1, 'membership is a selected read, not another allocation/load cycle');
    assert(a.reader.memberships.every(call => call.values.length <= 3));
    assert.equal(yielded, 6); assert.equal(closed, 1);
    assert.deepEqual(f.rendered().membership.entries.map(value => value.found), [false, false, false, true, false, false, false]);
    assert.deepEqual(f.rendered().membership.any, [{ id: any.id, found: true }]);
    const before = a.reader.memberships.length;
    f.owner.requestMembership({ entries: [...request.entries], calls: [...request.calls], any: [any] }); await f.settle();
    assert.equal(a.reader.memberships.length, before, 'unchanged original demand does not schedule a duplicate query');
    f.owner.select('task:one'); await f.settle();
    assert.equal(a.source.openCalls, 1);
  } finally { f.close(); await tick(); }
});

test('source errors publish explicit subject/stage and keep old same-owner Inspector unknown', async () => {
  const f = frame(), a = f.input(), b = f.input();
  a.candidate.subject = {}; b.candidate.subject = {};
  b.candidate.sourceError = Object.assign(Error('source proof unavailable'), { code: 'HISTORY_AGENT_CATALOG_SOURCE_IDENTITY' });
  try {
    f.owner.update(a.candidate); f.owner.select('task:one'); await f.settle();
    const previous = f.rendered().selected.record;
    assert.equal(f.rendered().subject, a.candidate.subject);
    f.owner.update(b.candidate); await f.settle();
    assert.equal(f.rendered().subject, b.candidate.subject);
    assert.equal(f.rendered().status, 'error'); assert.equal(f.rendered().errorStage, 'source');
    assert.equal(f.rendered().error, b.candidate.sourceError);
    assert.equal(f.rendered().selected.kind, 'unknown'); assert.equal(f.rendered().selected.record, previous);
    assert.equal(b.source.openCalls, 0, 'a failed source proof is not replaced by empty or nearest Root');
  } finally { f.close(); await tick(); }
});

test('failed allocation settles replaceable pending selection without retry or a second load cycle', async () => {
  const f = frame(), gate = deferred(), a = f.input({ gate });
  const error = Object.assign(Error('original source read failure'), { code: 'ORIGINAL_BUILD_FAILURE' });
  try {
    f.owner.update(a.candidate);
    f.owner.select('task:one');
    gate.reject(error); await f.settle(); await tick();
    assert.equal(a.source.openCalls, 1);
    assert.equal(f.owner.state().pending, false);
    assert.equal(f.rendered().status, 'error'); assert.equal(f.rendered().errorStage, 'model');
    assert.equal(f.rendered().error, error); assert.equal(f.rendered().selected.kind, 'unknown');
    f.owner.select('task:another');
    f.owner.requestPage({ section: 'roster', offset: 100, limit: 8 });
    f.owner.requestMembership({ entries: ['mounted'], calls: [], any: [] });
    await f.settle();
    assert.equal(a.source.openCalls, 1, 'same failed source revision cannot get a renewed load deadline');
    assert.equal(a.source.closeCalls, 1);
    const next = f.input(); f.owner.update(next.candidate); await f.settle();
    assert.equal(next.source.openCalls, 1, 'real new source input permits its own one allocation');
    assert.equal(f.rendered().status, 'ready');
  } finally { f.close(); await tick(); }
});

test('CURRENT construction error has an explicit null capability, preserves same-owner detail and never retries', async () => {
  const f = frame({ queued: true }), good = f.input();
  const failure = Object.assign(new Error('Main profile changed before layout admission'), {code:'HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE'});
  try {
    f.owner.update(good.candidate); f.owner.select('task:one'); await f.settle(); f.flush();
    const old = f.rendered().selected.record;
    const bad = f.input();
    const candidate = {...bad.candidate,current:null,sourceError:failure};
    f.owner.update(candidate); await f.settle(); f.flush();
    assert.equal(f.rendered().status,'error');assert.equal(f.rendered().errorStage,'source');assert.equal(f.rendered().error,failure);
    assert.equal(f.rendered().selected.kind,'unknown');assert.equal(f.rendered().selected.record,old);
    assert.equal(bad.source.openCalls,0);assert.equal(bad.source.closeCalls,0);
    f.owner.requestPage({offset:64});f.owner.requestMembership({entries:['mounted']});
    await f.settle();f.flush();assert.equal(bad.source.openCalls,0,'error input cannot gain a load or deadline renewal');
    assert.equal(f.owner.state().running,null);assert.equal(f.owner.state().pending,false);
    assert.throws(()=>f.owner.update({...bad.candidate,current:null}),{code:'HISTORY_AGENT_CATALOG_PUBLICATION'});
    assert.throws(()=>f.owner.update({...bad.candidate,current:null,sourceError:null}),{code:'HISTORY_AGENT_CATALOG_PUBLICATION'});
    assert.throws(()=>f.owner.update({...bad.candidate,current:undefined,sourceError:failure}),{code:'HISTORY_AGENT_CATALOG_PUBLICATION'});
    assert.equal(f.rendered().selected.record,old);
  } finally {f.close();await tick();}
});

console.log('V53_OWNER_SOURCE_BOUNDARIES ' + JSON.stringify({ node: process.version,
  heapLimit: getHeapStatistics().heap_size_limit,
  ownerSHA256: createHash('sha256').update(fs.readFileSync(new URL('../src/renderer/utils/historyPrimaryAgentCatalogOwner.mjs', import.meta.url))).digest('hex'),
  scope: 'actual presentation owner; synthetic prepared reader; immediate and queued callback frames',
  notProven: ['actual IPC/model producer', 'React DOM mounting/paint', 'native acceptance'] }));
