import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryPresentationPositionOwner, createHistoryPresentationPositionQuery } from './historyPresentationPosition.mjs';
import { buildHistoryDisplayUnits, isGroupUnit } from './historyDisplayUnits.mjs';
import { historyLivePresentationKey } from './historyLiveProjection.mjs';

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sameValue = (a, b) => a === b || Number.isNaN(a) && Number.isNaN(b);
const entry = uuid => ({ kind: 'entry', entry: { uuid } });

// Finite test boundary only: the real native Map is the PRE contract oracle.
// Production helper registration/query/ownership runs unchanged. Backend,
// SQLite, IPC credits and native DOM are not claimed by these unit controls.
function oracle(units) {
  const map = new Map();
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (unit.kind === 'entry') { if (unit.entry?.uuid) map.set(unit.entry.uuid, index); }
    else for (const member of unit.entries) if (member?.uuid) map.set(member.uuid, index);
  }
  return uuid => {
    const index = map.get(uuid);
    if (index === undefined) return { kind: 'missing' };
    const unit = units[index];
    return { kind: 'found', index, memberIndex: unit.kind === 'entry' ? -1
      : unit.entries.findIndex(item => sameValue(item?.uuid, uuid)) };
  };
}
function fixture({ beforeOpen, beforeRead, readResult } = {}) {
  const registrations = [], queries = [], clients = [], errors = [], settlements = [];
  const owner = createHistoryPresentationPositionOwner({ invoke: async () => { throw Error('no IPC in helper boundary'); },
    onError: error => errors.push(error), onSettled: pub => settlements.push(pub.status),
    open: async (_invoke, input) => {
      const registration = { input, records: [] }; registrations.push(registration);
      await beforeOpen?.(registration);
      for (const record of input.records) registration.records.push(record);
      assert(input.owns());
      const client = { closed: 0,
        async resolve(uuid, options) {
          const query = { uuid, options, registration }; queries.push(query);
          await beforeRead?.(query);
          if (readResult) return readResult(query);
          let found = null;
          for (const record of registration.records) if (record.uuid && sameValue(record.uuid, uuid)
            && (!found || record.index > found.index)) found = record;
          return found ? { kind: 'found', index: found.index, memberIndex: found.memberIndex } : { kind: 'missing' };
        },
        async close() { client.closed++; },
      }; clients.push(client); return client;
    } });
  let frame = null;
  const publish = (units, input = {}) => {
    const captured = frame = input.frame || {};
    const witness = input.witness || captured;
    const itemKeys = input.itemKeys || units.map((_unit, i) => 'actual-key:' + i);
    const publication = owner.publish({ units, itemKeys, frame: captured, witness,
      owns: input.owns || (() => frame === captured) });
    return { publication, frame: captured, witness, itemKeys, units };
  };
  return { owner, publish, registrations, queries, clients, errors, settlements,
    setFrame: value => { frame = value; } };
}

test('exact full UTF16, current locals, hidden groups, typed UUIDs and last-unit/first-member semantics', async () => {
  const id = 'hidden \0\ud800😀 ' + 'ж\udc00'.repeat(2100);
  const first = { uuid: id, sourceIdentityAliases: ['first-alias'] };
  const second = { uuid: id, sourceIdentityAliases: ['later-alias'] };
  const units = [entry('local-current'), entry('duplicate'), { kind: 'group', entries: [first, second] },
    { kind: 'group', entries: [{ uuid: 'duplicate' }] }, entry(1), entry('1'), entry(true), entry('true'),
    entry(7n), entry('7'), entry(' \t\0\ud800😀\udc00\n '), entry(0), entry(false), entry(''), entry(NaN),
    { kind: 'group', entries: [] }, entry(Symbol('unqueryable')), entry({ uuid: 'object-key' })];
  const f = fixture(), current = f.publish(units), query = createHistoryPresentationPositionQuery(f.owner);
  try {
    assert.equal((await current.publication.promise).status, 'ready');
    const legacy = oracle(units);
    for (const uuid of ['local-current', id, 'duplicate', 1, '1', true, 'true', 7n, '7',
      ' \t\0\ud800😀\udc00\n ', 0, false, '', NaN, null, undefined, 'first-alias', 'absent']) {
      const expected = legacy(uuid), actual = await query.resolve(current.publication, uuid);
      assert.equal(actual.status, expected.kind === 'found' ? 'ready' : 'absent');
      if (actual.address) {
        assert.equal(actual.address.index, expected.index); assert.equal(actual.address.memberIndex, expected.memberIndex);
        assert.equal(actual.address.physicalKey, current.itemKeys[expected.index]);
        assert.equal(f.owner.entryAt(actual.address).uuid, uuid);
      }
    }
    const hidden = await query.resolve(current.publication, id);
    assert.equal(hidden.address.index, 2); assert.equal(hidden.address.memberIndex, 0);
    assert.equal(f.owner.entryAt(hidden.address), first);
    assert.deepEqual(f.owner.entryAt(hidden.address).sourceIdentityAliases, ['first-alias']);
    assert.equal(id.length, 4212); assert.equal(hidden.address.uuid, id);
    assert.equal(f.owner.stats().memberVisits, 18);
    assert.equal(f.owner.stats().unitVisits, units.length);
    assert.equal(f.owner.stats().unqueryableUUIDs, 2);
    assert.equal(f.owner.stats().nativeCoordinateMaps, 0);
    assert.equal(f.registrations[0].records.length, 19, 'every falsy/empty/unqueryable row still yields bounded work');
    assert.throws(() => query.read(current.publication, {}), { code: 'HISTORY_POSITION_QUERY_INVALID' });
    assert.throws(() => query.read(current.publication, Symbol()), { code: 'HISTORY_POSITION_QUERY_INVALID' });
  } finally { query.dispose(); await f.owner.dispose(); }
  assert(f.clients.every(client => client.closed === 1));
});

test('publication is independent of canonical Root lifetime and ready witness rebind does not reopen or renew', async () => {
  const f = fixture(), units = [entry('owned')], frame = {}, witness = {};
  let owns = true, root = { header: null };
  const current = f.publish(units, { frame, witness, owns: () => owns });
  await current.publication.promise;
  const query = createHistoryPresentationPositionQuery(f.owner);
  try {
    root = null;
    assert.equal(root, null);
    assert.equal((await query.resolve(current.publication, 'owned')).status, 'ready');
    owns = false;
    const refreshed = f.owner.publish({ units, itemKeys: current.itemKeys, frame, witness: {}, owns: () => true });
    assert.notEqual(refreshed, current.publication);
    assert.equal(refreshed.projectionId, current.publication.projectionId);
    assert.equal(refreshed.status, 'ready');
    assert.equal(f.owner.owns(current.publication), false);
    assert.equal((await query.resolve(refreshed, 'owned')).status, 'ready');
    assert.equal(f.registrations.length, 1); assert.equal(f.clients[0].closed, 0);
    assert.equal(f.owner.stats().reused, 1);
  } finally { query.dispose(); await f.owner.dispose(); }
});

test('one original upload and one replaceable pending frame; no queued N enumeration', async () => {
  const block = gate(), entered = gate();
  const f = fixture({ beforeOpen: async () => { entered.resolve(); await block.promise; } });
  const first = f.publish([entry('first')]); await entered.promise;
  let last;
  for (let i = 0; i < 100; i++) last = f.publish([entry('latest-' + i)]);
  assert.equal(first.publication.status, 'superseded');
  assert.equal(f.registrations.length, 1); assert.equal(f.owner.stats().pending, 1);
  assert.equal(f.owner.stats().unitVisits, 0);
  block.resolve();
  assert.equal((await last.publication.promise).status, 'ready');
  assert.equal(f.registrations.length, 2);
  assert.equal(f.owner.stats().unitVisits, 1, 'cancelled first and superseded queued frames never enumerate');
  assert.equal(f.registrations[1].records[0].uuid, 'latest-99');
  await f.owner.dispose();
});

test('query lanes are independent; one lane keeps only running and latest pending target', async () => {
  const block = gate(), entered = gate(); let armed = true;
  const f = fixture({ beforeRead: async query => {
    if (armed && query.uuid === 'A') { armed = false; entered.resolve(); await block.promise; }
  } });
  const current = f.publish([entry('A'), entry('B'), entry('K99')]); await current.publication.promise;
  const resize = createHistoryPresentationPositionQuery(f.owner), search = createHistoryPresentationPositionQuery(f.owner);
  try {
    const a = resize.read(current.publication, 'A'); await entered.promise;
    let latest;
    for (let i = 0; i < 100; i++) latest = resize.read(current.publication, 'K' + i);
    assert.equal((await a.promise).status, 'superseded');
    assert.equal(resize.stats().pending, 1); assert.equal(resize.stats().running, 1);
    assert.equal((await search.resolve(current.publication, 'B')).address.index, 1);
    assert.equal(f.clients[0].closed, 0, 'point supersession cannot release parent publication');
    block.resolve();
    assert.equal((await latest.promise).address.index, 2); await tick();
    assert.deepEqual(f.queries.map(query => query.uuid), ['A', 'B', 'K99']);
    assert.deepEqual(resize.stats(), { selected: 1, running: 0, pending: 0 });
  } finally { block.resolve(); resize.dispose(); search.dispose(); await f.owner.dispose(); }
});

test('original caller ownership is never replaced after await, including same-target reentrancy', async () => {
  const firstGate = gate(), entered = gate(); let first = true;
  const f = fixture({ beforeRead: async () => { if (first) { first = false; entered.resolve(); await firstGate.promise; } } });
  const current = f.publish([entry('A')]); await current.publication.promise;
  const query = createHistoryPresentationPositionQuery(f.owner); let original = true;
  try {
    const before = query.read(current.publication, 'A', { owns: () => original }); await entered.promise;
    original = false;
    const after = query.read(current.publication, 'A', { owns: () => true });
    assert.notEqual(after, before); assert.equal((await before.promise).status, 'superseded');
    firstGate.resolve();
    assert.equal((await after.promise).status, 'ready');
    assert.equal(f.queries.length, 2, 'a new witness performs its own exact query; old result is not relabelled');
    assert.equal((await query.resolve(current.publication, 'A', { owns: () => Promise.resolve(true) })).status, 'superseded');
  } finally { firstGate.resolve(); query.dispose(); await f.owner.dispose(); }
});

test('UNKNOWN and registration refusal are retained failures without own-notification retry', async () => {
  const unknown = Object.assign(Error('unknown finite outcome'), { code: 'FINITE_UNKNOWN' });
  let failures = 0;
  const f = fixture({ readResult: () => { failures++; throw unknown; } });
  const current = f.publish([entry('A')]); await current.publication.promise;
  const query = createHistoryPresentationPositionQuery(f.owner);
  try {
    const failed = await query.resolve(current.publication, 'A');
    assert.equal(failed.status, 'failed'); assert.equal(failed.error, unknown);
    for (let i = 0; i < 50; i++) assert.equal(await query.resolve(current.publication, 'A'), failed);
    assert.equal(failures, 1); assert.equal(f.clients[0].closed, 0);
  } finally { query.dispose(); await f.owner.dispose(); }
  const refused = fixture({ beforeOpen: () => { throw unknown; } });
  const one = refused.publish([entry('A')]); await one.publication.promise;
  assert.equal(one.publication.status, 'failed');
  const rebind = refused.owner.publish({ ...one, witness: {}, owns: () => true });
  assert.equal(rebind.status, 'failed'); assert.equal(rebind.error, unknown);
  assert.equal(refused.registrations.length, 1);
  await refused.owner.dispose();
});

test('source/frame replacement during await discards address; selected integrity and abort are checked', async () => {
  const block = gate(), entered = gate();
  const f = fixture({ beforeRead: async () => { entered.resolve(); await block.promise; } });
  const old = f.publish([entry('A')]); await old.publication.promise;
  const query = createHistoryPresentationPositionQuery(f.owner);
  const pending = query.read(old.publication, 'A'); await entered.promise;
  const newer = f.publish([entry('new-local')]); await newer.publication.promise;
  block.resolve();
  assert.equal((await pending.promise).status, 'superseded');
  assert.equal(f.owner.owns(old.publication), false); assert.equal(f.clients[0].closed, 1);
  query.dispose(); await f.owner.dispose();

  const wrong = fixture({ readResult: () => ({ kind: 'found', index: 0, memberIndex: -1 }) });
  const current = wrong.publish([entry('different')]); await current.publication.promise;
  const selected = createHistoryPresentationPositionQuery(wrong.owner);
  const rejected = await selected.resolve(current.publication, 'asked');
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.error.code, 'HISTORY_POSITION_RESULT_INVALID');
  const abort = new AbortController(); abort.abort();
  assert.equal((await selected.resolve(current.publication, 'different', { signal: abort.signal })).status, 'superseded');
  assert.equal(wrong.queries.length, 1);
  selected.dispose(); await wrong.owner.dispose();
});

test('effect clear is reversible and disposes exact parent leases without capturing another owner', async () => {
  const f = fixture(), current = f.publish([entry('A')]); await current.publication.promise;
  const query = createHistoryPresentationPositionQuery(f.owner);
  const result = await query.resolve(current.publication, 'A');
  assert.equal(f.owner.entryAt(result.address).uuid, 'A');
  query.clear(); await f.owner.clear(); f.owner.activate();
  assert.equal(f.owner.capture(), null); assert.equal(f.owner.entryAt(result.address), null);
  const next = f.publish([entry('B')]); await next.publication.promise;
  assert.equal((await query.resolve(next.publication, 'B')).status, 'ready');
  query.dispose(); await f.owner.dispose();
  assert(f.clients.every(client => client.closed === 1));
  assert.throws(() => f.owner.activate(), { code: 'HISTORY_POSITION_OWNER_DISPOSED' });
});

test('real current grouping preserves work/grp/sub physical keys and deepest duplicate coordinates', async () => {
  const action = (uuid, id) => ({ uuid, role: 'assistant', actionSummary: [{ toolUseId: id,
    toolName: 'Read', family: 'read', aggregateKey: 'read:regular' }] });
  const rows = [{ uuid: 'local-current', role: 'queued', queueStatus: 'queued' },
    { uuid: 'caption', role: 'assistant', content: 'commentary', textPhase: 'commentary',
      rewriteRenderKey: 'rewrite:exact-current', sourceIdentity: 'source-alias' },
    action('a', 'call-a'), action('b', 'call-b'), { uuid: 'thinking', role: 'assistant', thinking: 'reason' },
    action('c', 'call-c'), action('d', 'call-d'),
    { uuid: 'final', role: 'assistant', content: 'final', textPhase: 'final_answer' }];
  const cases = [
    { responseWork: true },
    { responseWork: true, expandedKeys: new Set(['work:rewrite:exact-current']) },
    { responseWork: true, expandedKeys: new Set(['work:rewrite:exact-current', 'grp:call-a']) },
    { responseWork: false },
    { responseWork: false, expandedKeys: new Set(['grp:call-a']) },
    { responseWork: false, expandedKeys: new Set(['grp:call-a', 'sub:call-a', 'sub:call-c']) },
  ];
  const f = fixture(), query = createHistoryPresentationPositionQuery(f.owner);
  const allKeys = new Set();
  try {
    for (const options of cases) {
      const units = buildHistoryDisplayUnits(rows, options);
      const itemKeys = units.map(unit => isGroupUnit(unit) ? String(unit.key || '') : historyLivePresentationKey(unit.entry));
      itemKeys.forEach(key => allKeys.add(key));
      const current = f.publish(units, { itemKeys }); await current.publication.promise;
      const legacy = oracle(units);
      for (const row of rows) {
        const selected = await query.resolve(current.publication, row.uuid), expected = legacy(row.uuid);
        assert.equal(selected.status, 'ready'); assert.equal(selected.address.index, expected.index);
        assert.equal(selected.address.memberIndex, expected.memberIndex);
        assert.equal(selected.address.physicalKey, itemKeys[expected.index]);
        assert.equal(f.owner.entryAt(selected.address), row);
      }
      assert.equal((await query.resolve(current.publication, 'source-alias')).status, 'absent');
      if (options.expandedKeys?.has('sub:call-a')) {
        const visible = await query.resolve(current.publication, 'a');
        assert.equal(visible.address.kind, 'entry');
        assert.equal(visible.address.physicalKey, 'uuid:a');
      }
    }
    assert(allKeys.has('work:rewrite:exact-current'));
    assert(allKeys.has('grp:call-a')); assert(allKeys.has('sub:call-a')); assert(allKeys.has('sub:call-c'));
  } finally { query.dispose(); await f.owner.dispose(); }
});

test('publication invalidation releases old frame/witness and every bounded selected consumer', async () => {
  const f = fixture(), current = f.publish([entry('A')]); await current.publication.promise;
  // Discarded React render factories do not register anything.
  for (let i = 0; i < 30; i++) createHistoryPresentationPositionQuery(f.owner);
  const lanes = Array.from({ length: 4 }, () => createHistoryPresentationPositionQuery(f.owner));
  for (const lane of lanes) assert.equal((await lane.resolve(current.publication, 'A')).status, 'ready');
  const next = f.publish([entry('B')]); await next.publication.promise;
  assert.equal(current.publication.status, 'superseded');
  assert.equal(current.publication.frame, null); assert.equal(current.publication.witness, null);
  for (const lane of lanes) assert.deepEqual(lane.stats(), { selected: 0, running: 0, pending: 0 });
  lanes.forEach(lane => lane.dispose()); await f.owner.dispose();
});

test('settled selected membership is revalidated before reuse without an N replay', async () => {
  const row = { uuid: 'A' }, f = fixture(), current = f.publish([{ kind: 'entry', entry: row }]);
  await current.publication.promise;
  const query = createHistoryPresentationPositionQuery(f.owner);
  const selected = await query.resolve(current.publication, 'A');
  assert.equal(selected.status, 'ready');
  row.uuid = 'B'; // Deliberate negative: violates immutable producer contract.
  const rejected = await query.resolve(current.publication, 'A');
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.error.code, 'HISTORY_POSITION_INPUT_CHANGED');
  assert.equal(f.queries.length, 1); assert.equal(f.owner.stats().unitVisits, 1);
  query.dispose(); await f.owner.dispose();
});

// New equivalent r3 lifecycle controls. The supplied file named counter24 is
// a SQLite path adapter; its absent lifecycle body is not claimed executed.
test('r3 publish callback cannot revive dispose/clear or overwrite a reentrant replacement including ABA', async () => {
  for (const action of ['dispose', 'clear', 'replace', 'clear-republish-ABA']) {
    const f = fixture(), units = [entry('outer')], itemKeys = ['actual:outer'], frame = {}, witness = {};
    let inner = null;
    const outer = f.owner.publish({ units, itemKeys, frame, witness, owns() {
      if (action === 'dispose') f.owner.dispose();
      else if (action === 'clear') f.owner.clear();
      else {
        f.owner.clear();
        inner = f.owner.publish({ units: action.endsWith('ABA') ? units : [entry('inner')],
          itemKeys, frame: action.endsWith('ABA') ? frame : {}, witness, owns: () => true });
      }
      return true;
    } });
    assert.equal(outer, null, action + ': original call must not publish after its native callback mutates lifetime');
    if (inner) { await inner.promise; assert.equal(inner.status, 'ready'); assert.equal(f.owner.capture(), inner); assert.equal(f.registrations.length, 1); }
    else { await tick(); assert.equal(f.owner.capture(), null); assert.equal(f.registrations.length, 0); }
    await f.owner.dispose();
  }
});

test('r3 registration guard clear/dispose after admission rejects the original operation before opening', async () => {
  for (const action of ['clear', 'dispose']) {
    const f = fixture(); let armed = false;
    const current = f.publish([entry('A')], { owns: () => {
      if (armed) { armed = false; f.owner[action](); } return true;
    } });
    armed = true;
    assert.equal((await current.publication.promise).status, 'superseded'); await tick();
    assert.equal(f.registrations.length, 0); assert.equal(f.owner.capture(), null);
    assert.equal(current.publication.frame, null); assert.equal(current.publication.witness, null);
    await f.owner.dispose();
  }
});

test('r3 owner guard and entryAt cannot return an old selected proof after clear/replacement reentry', async () => {
  const f = fixture(); let action = null, replacement;
  const current = f.publish([entry('A')], { owns: () => { const run = action; action = null; run?.(); return true; } });
  await current.publication.promise;
  const query = createHistoryPresentationPositionQuery(f.owner);
  const selected = await query.resolve(current.publication, 'A'), address = selected.address;
  action = () => { f.owner.clear(); replacement = f.publish([entry('B')]); };
  assert.equal(f.owner.entryAt(address), null); assert.equal(f.owner.owns(current.publication), false);
  assert.equal(selected.status, 'superseded'); assert.equal(selected.address, null);
  await replacement.publication.promise; assert.equal(replacement.publication.status, 'ready');
  query.dispose(); await f.owner.dispose();
});

test('r3 caller owns clearing and republishing the same frame after point await cannot relabel the old result', async () => {
  const block = gate(), entered = gate(); let arm = false, next;
  const f = fixture({ beforeRead: async () => { entered.resolve(); await block.promise; } });
  const current = f.publish([entry('A')]); await current.publication.promise;
  const pending = f.owner.query(current.publication, 'A', { owns: () => {
    if (arm) { arm = false; f.owner.clear(); next = f.owner.publish({ ...current, owns: () => true }); } return true;
  } });
  await entered.promise; arm = true; block.resolve();
  await assert.rejects(pending, { code: 'HISTORY_READ_CANCELLED' });
  await next.promise; assert.equal(f.owner.capture(), next); assert.notEqual(next, current.publication);
  assert.equal(current.publication.frame, null); await f.owner.dispose();
});

test('r3 incoming selected callback clear/dispose or nested read cannot overwrite its successor', async () => {
  for (const action of ['clear', 'dispose', 'read']) {
    const f = fixture(), current = f.publish([entry('A'), entry('B')]); await current.publication.promise;
    const query = createHistoryPresentationPositionQuery(f.owner); let successor;
    const selected = query.read(current.publication, 'A', { owns: () => {
      if (action === 'read') successor = query.read(current.publication, 'B'); else query[action]();
      return true;
    } });
    assert.equal((await selected.promise).status, 'superseded');
    if (successor) { assert.equal((await successor.promise).status, 'ready'); assert.equal(successor.address.index, 1); }
    else { await tick(); assert.equal(f.queries.length, 0); assert.equal(query.stats().selected, 0); }
    query.dispose(); await f.owner.dispose();
  }
});

test('r3 selected cancellation installs the new demand before abort listeners may reenter', async () => {
  const block = gate(), entered = gate(); let first = true, nested;
  const f = fixture({ beforeRead: async ({ options }) => {
    if (first) { first = false; options.signal.addEventListener('abort', () => { nested = query.read(current.publication, 'C'); }, { once: true });
      entered.resolve(); await block.promise; }
  } });
  const current = f.publish([entry('A'), entry('B'), entry('C')]); await current.publication.promise;
  const query = createHistoryPresentationPositionQuery(f.owner), a = query.read(current.publication, 'A'); await entered.promise;
  const b = query.read(current.publication, 'B');
  assert.equal(b.status, 'superseded'); assert(nested); block.resolve();
  assert.equal((await a.promise).status, 'superseded'); assert.equal((await nested.promise).address.index, 2);
  assert.deepEqual(f.queries.map(item => item.uuid), ['A', 'C']);
  query.dispose(); await f.owner.dispose();
});

test('r3 settled cache and cancel release old guard/signal closures; cached proof checks a fresh caller', async () => {
  const f = fixture(), current = f.publish([entry('A')]); await current.publication.promise;
  const query = createHistoryPresentationPositionQuery(f.owner), abort = new AbortController(); let owned = true;
  const guard = () => owned, result = await query.resolve(current.publication, 'A', { owns: guard, signal: abort.signal });
  assert.equal(result.status, 'ready'); assert.notEqual(result.owns, guard); assert.equal(result.signal, null);
  owned = false; abort.abort();
  assert.equal((await query.resolve(current.publication, 'A', { owns: () => true })).status, 'ready');
  assert.equal(f.queries.length, 1); query.clear();
  assert.equal(result.status, 'superseded'); assert.equal(result.address, null); assert.equal(result.signal, null);
  query.dispose(); await f.owner.dispose();
});

test('r3 settled proof revalidation cannot mutate or return a selection replaced inside owner guard', async () => {
  const f = fixture(); let action = null, fresh;
  const current = f.publish([entry('A')], { owns: () => { const run = action; action = null; run?.(); return true; } });
  await current.publication.promise; const query = createHistoryPresentationPositionQuery(f.owner);
  const first = await query.resolve(current.publication, 'A');
  // First incoming owns call is ordinary; the subsequent entryAt guard reenters.
  let checks = 0;
  action = function arm() { if (++checks === 1) action = () => { query.clear(); fresh = query.read(current.publication, 'A'); }; };
  const old = query.read(current.publication, 'A');
  assert.equal(old.status, 'superseded'); assert.equal(first.status, 'superseded');
  assert(fresh); assert.equal((await fresh.promise).status, 'ready');
  query.dispose(); await f.owner.dispose();
});

test('r3 cancellation of a registration waiter does not wait for shared registration or renew its witness', async () => {
  const block = gate(), entered = gate(), f = fixture({ beforeOpen: async () => { entered.resolve(); await block.promise; } });
  const current = f.publish([entry('A')]); await entered.promise;
  const query = createHistoryPresentationPositionQuery(f.owner), abort = new AbortController();
  const state = query.read(current.publication, 'A', { signal: abort.signal }); abort.abort();
  assert.equal((await state.promise).status, 'superseded'); await tick();
  assert.equal(query.stats().running, 0); assert.equal(f.registrations.length, 1);
  block.resolve(); await current.publication.promise;
  assert.equal((await query.resolve(current.publication, 'A')).status, 'ready');
  query.dispose(); await f.owner.dispose();
});
