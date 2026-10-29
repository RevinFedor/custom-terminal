import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryPresentationPositionOwner, createHistoryPresentationPositionQuery } from './historyPresentationPosition.mjs';

// This boundary uses the actual owner/lane implementation, with a finite
// independently-held selected-source fixture. Producer, SQLite and IPC are
// covered by the integration suite; these controls do not claim their proof.
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture({ beforeRead, cleanup } = {}) {
  const selected = new WeakSet(), releases = [], opens = [], queries = [];
  let current = {}, parentClosed = false;
  const row = { uuid: 'full\0\ud800😀\udc00'.repeat(180), sourceIdentityAliases: ['selected-full-alias'] };
  const local = { uuid: 7n, content: 'CURRENT local remains the native object', isLocal: true };
  const source = Object.freeze({ unitCount: 3, async open(input) {
    opens.push(input); let closed = false;
    const client = {
      async resolve(uuid, options) {
        assert(input.owns()); assert(options.owns()); queries.push({ uuid, options });
        await beforeRead?.({ uuid, options });
        assert.equal(closed, false);
        if (uuid !== row.uuid && uuid !== local.uuid) return { kind: 'missing' };
        // Last physical unit, first matching member belongs to the concrete
        // source, not to Root.navigate or a native array inspected by the lane.
        const point = Object.freeze({ kind: 'found', index: uuid === row.uuid ? 2 : 0,
          memberIndex: uuid === row.uuid ? 0 : -1, memberCount: uuid === row.uuid ? 2 : 1,
          physicalKey: uuid === row.uuid ? 'work:original-full\0\ud800' : 'uuid:current-local',
          entry: uuid === row.uuid ? row : local });
        selected.add(point); return point;
      },
      entryAt(point) { return !closed && selected.has(point) ? point.entry : null; },
      close() { closed = true; releases.push(client); return cleanup?.promise || Promise.resolve(); },
      retirement() { return { promise: cleanup?.promise || Promise.resolve(), status: 'pending' }; },
    }; return client;
  } });
  const owner = createHistoryPresentationPositionOwner({ invoke: async () => { throw Error('selected source does not register native arrays'); } });
  const publish = (frame = current) => {
    current = frame;
    return owner.publish({ source, frame, witness: frame, owns: () => current === frame,
      get units() { throw Error('native units touched'); }, get itemKeys() { throw Error('native keys touched'); } });
  };
  return { source, owner, row, local, opens, queries, releases, publish, setCurrent: value => { current = value; },
    closeModel() { parentClosed = true; }, get parentClosed() { return parentClosed; } };
}

test('V52 selected publication reads no native N getters and retains exact local identity', async () => {
  const f = fixture(), publication = f.publish(); await publication.promise;
  const lane = createHistoryPresentationPositionQuery(f.owner);
  try {
    f.closeModel();
    assert(f.parentClosed);
    const historical = await lane.resolve(publication, f.row.uuid);
    assert.equal(historical.status, 'ready'); assert.equal(historical.address.index, 2);
    assert.equal(historical.address.memberIndex, 0); assert.equal(historical.address.memberCount, 2);
    assert.equal(historical.address.physicalKey, 'work:original-full\0\ud800');
    assert.equal(f.owner.entryAt(historical.address), f.row);
    const local = await lane.resolve(publication, 7n);
    assert.equal(local.status, 'ready'); assert.equal(f.owner.entryAt(local.address), f.local);
    assert.equal((await lane.resolve(publication, '7')).status, 'absent');
    assert.equal(f.owner.stats().unitVisits, 0); assert.equal(f.owner.stats().memberVisits, 0);
    assert.equal(f.owner.stats().nativeCoordinateMaps, 0); assert.equal(f.opens.length, 1);
  } finally { lane.dispose(); await f.owner.dispose(); }
  assert.equal(f.releases.length, 1);
});

test('V52 pending intent survives unrelated held new open and old model close, but actual frame replacement cancels', async () => {
  const entered = gate(), release = gate();
  const f = fixture({ beforeRead: async () => { entered.resolve(); await release.promise; } });
  const frame = {}, publication = f.publish(frame); await publication.promise;
  const lane = createHistoryPresentationPositionQuery(f.owner);
  const originalIntent = { visit: {}, resize: {}, attempts: 0 };
  const original = lane.read(publication, f.row.uuid, { owns: () => originalIntent.attempts < 240 });
  await entered.promise;
  f.closeModel();
  const newOpen = gate(); // Deliberately not a publication or data-commit proof.
  assert.equal(f.owner.publish({ source: f.source, frame, witness: frame, owns: () => true }), publication);
  release.resolve();
  assert.equal(await original.promise, original); assert.equal(original.status, 'ready');
  assert.equal(original.address.publication, publication); assert.equal(f.opens.length, 1);
  const replacement = f.publish({ rewrite: true });
  await replacement.promise;
  assert.equal(original.status, 'superseded'); assert.equal(original.address, null);
  assert.equal(f.owner.owns(publication), false); assert.equal(f.releases.length, 1);
  newOpen.resolve(); lane.dispose(); await f.owner.dispose();
});

test('V52 selected source stale point and source callback ABA cannot be promoted', async () => {
  const f = fixture(), publication = f.publish(); await publication.promise;
  const lane = createHistoryPresentationPositionQuery(f.owner);
  const ready = await lane.resolve(publication, f.row.uuid);
  f.row.uuid = 'changed';
  assert.equal((await lane.resolve(publication, ready.uuid)).status, 'failed');
  assert.equal(f.queries.length, 1);
  lane.dispose(); await f.owner.dispose();

  let owner, publication2, action;
  const point = Object.freeze({ kind: 'found', index: 0, memberIndex: -1, memberCount: 1, physicalKey: 'key', entry: { uuid: 'a' } });
  const source = { unitCount: 1, async open() { return {
    async resolve() { return point; }, entryAt(value) { const run = action; action = null; run?.(); return value.entry; },
    async close() {},
  }; } };
  owner = createHistoryPresentationPositionOwner({ invoke: async () => ({}) });
  const frame = {};
  publication2 = owner.publish({ source, frame, witness: {}, owns: () => true }); await publication2.promise;
  action = () => { owner.clear(); owner.publish({ source, frame, witness: {}, owns: () => true }); };
  await assert.rejects(owner.query(publication2, 'a'), error => ['HISTORY_POSITION_INPUT_CHANGED', 'HISTORY_READ_CANCELLED'].includes(error.code));
  await owner.dispose();
});

test('V52 raw selected child retirement stays bounded and does not block a visible successor query forever', async () => {
  const cleanup = gate(), f = fixture({ cleanup });
  const first = f.publish(); await first.promise;
  const next = f.publish({ changed: true });
  assert.equal(next.status, 'pending'); assert.equal(f.owner.stats().retiring, 1);
  await assert.rejects(f.owner.query(next, f.local.uuid), error => error.code === 'HISTORY_READER_TRANSPORT_UNKNOWN' && error.positionRegistrationPending);
  assert.equal(f.opens.length, 1); cleanup.resolve();
  await next.promise; assert.equal(next.status, 'ready'); assert.equal(f.opens.length, 2);
  await f.owner.dispose(); await tick();
});
