// Finite SOURCE control of the actual tracker/hook, with fake IPC and timers.
// Counts listener calls and useSyncExternalStore snapshot changes, not DOM commits.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const filename = new URL('./sessionAvailabilityTracker.ts', import.meta.url);
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const descriptor = index => ({ tabId: `tab-${index}`, provider: 'codex', sessionId: `session-${index}`, cwd: '/fixture' });
const verdict = (owner, checkedAt, patch = {}) => ({
  tabId: owner.tabId, provider: owner.provider, sessionId: owner.sessionId,
  state: 'available', historyState: 'complete', reason: 'session-file-present', checkedAt,
  archived: false, missingDependencies: [], deletedAt: null, deletionSource: null, deletionOperationId: null,
  ...patch,
});
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const ipc = new EventEmitter(), windowEvents = new EventEmitter(), documentEvents = new EventEmitter();
  const timeouts = new Map(), intervals = new Map(), pending = [], observers = new Set();
  let timerId = 0, mounting = null;
  ipc.invoke = (channel, request) => {
    assert.equal(channel, 'agent-session:get-availability-batch');
    return new Promise((resolve, reject) => pending.push({ request, resolve, reject }));
  };
  const react = {
    useEffect(effect) { mounting.effects.push(effect); },
    useSyncExternalStore(subscribe, read) {
      const observer = mounting;
      observer.read = read;
      observer.current = read();
      observer.unsubscribe = subscribe(() => {
        observer.notifications++;
        const next = read();
        if (!Object.is(observer.current, next)) observer.changedSnapshots++;
        observer.current = next;
      });
      return observer.current;
    },
  };
  const module = { exports: {} };
  const document = { visibilityState: 'visible', addEventListener: documentEvents.on.bind(documentEvents),
    removeEventListener: documentEvents.off.bind(documentEvents) };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require(name) { assert.equal(name, 'react'); return react; },
    document,
    window: {
      require(name) { assert.equal(name, 'electron'); return { ipcRenderer: ipc }; },
      setTimeout(fn, ms) { assert.equal(ms, 0); timeouts.set(++timerId, fn); return timerId; },
      clearTimeout(id) { timeouts.delete(id); },
      setInterval(fn, ms) { assert.equal(ms, 30_000); intervals.set(++timerId, fn); return timerId; },
      clearInterval(id) { intervals.delete(id); },
      addEventListener: windowEvents.on.bind(windowEvents), removeEventListener: windowEvents.off.bind(windowEvents),
    },
  }, { filename: filename.pathname });
  const api = module.exports;
  return {
    api, ipc, document, intervals, pending,
    mount(owner) {
      const observer = { effects: [], notifications: 0, changedSnapshots: 0 };
      mounting = observer;
      const value = api.useSessionAvailability(owner);
      mounting = null;
      assert.equal(value, observer.read());
      const cleanup = observer.effects.map(effect => effect());
      observer.unmount = () => { observer.unsubscribe(); cleanup.forEach(fn => fn?.()); observers.delete(observer); };
      observers.add(observer);
      return observer;
    },
    flush() {
      for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn(); }
    },
    poll() { assert.equal(intervals.size, 1); [...intervals.values()][0](); },
    async answer(makeVerdict, { success = true, reject = false } = {}) {
      assert.equal(pending.length, 1, 'one actual batch is in flight');
      const call = pending.shift();
      if (reject) call.reject(new Error('fixture read failure'));
      else call.resolve({ success, results: success ? call.request.sessions.map(makeVerdict) : undefined });
      await settle();
      return call.request;
    },
    reset() { for (const observer of observers) { observer.notifications = 0; observer.changedSnapshots = 0; } },
    counts() { return [...observers].reduce((sum, observer) => ({
      notifications: sum.notifications + observer.notifications,
      changedSnapshots: sum.changedSnapshots + observer.changedSnapshots,
    }), { notifications: 0, changedSnapshots: 0 }); },
    close() { for (const observer of [...observers]) observer.unmount(); },
  };
}

test('64 owners / 2 extra History subscribers: checkedAt-only polls keep UI snapshots while raw time advances', async t => {
  const f = fixture(); t.after(() => f.close());
  const owners = Array.from({ length: 64 }, (_, index) => descriptor(index));
  const rows = owners.map(owner => f.mount(owner));
  const histories = owners.slice(0, 2).map(owner => f.mount(owner));
  f.flush();
  const request = await f.answer(owner => verdict(owner, 1000));
  assert.equal(request.sessions.length, 64, 'duplicate consumers do not duplicate Main descriptors');
  const before = [...rows, ...histories].map(observer => observer.read());
  const previousRaw = owners.map(owner => f.api.getSessionAvailabilitySnapshot(owner));

  f.reset(); f.poll();
  await f.answer(owner => verdict(owner, 31_000));
  const timestampOnly = f.counts();
  const stableSnapshots = [...rows, ...histories].filter((observer, index) => observer.read() === before[index]).length;
  for (const [index, owner] of owners.entries()) {
    const raw = f.api.getSessionAvailabilitySnapshot(owner);
    assert.equal(raw.checkedAt, 31_000);
    assert.notEqual(raw, previousRaw[index]);
    assert.equal(previousRaw[index].checkedAt, 1000, 'do not mutate prior raw snapshots');
    assert.equal(f.api.getTabSessionAvailabilitySnapshot({ id: owner.tabId, codexSessionId: owner.sessionId }).checkedAt, 31_000);
  }

  // Same timestamp isolates semantic changes from the already measured time-only batch.
  f.reset(); f.poll();
  await f.answer(owner => verdict(owner, 31_000,
    owner.tabId === 'tab-0' ? { state: 'missing' } : owner.tabId === 'tab-1' ? { state: 'archived' } : {}));
  const twoChangedOwners = f.counts();
  t.diagnostic(JSON.stringify({ timestampOnly, stableSnapshots, rawFresh: 64, twoChangedOwners }));
  assert.deepEqual(timestampOnly, { notifications: 0, changedSnapshots: 0 });
  assert.equal(stableSnapshots, 66);
  assert.deepEqual(twoChangedOwners, { notifications: 4, changedSnapshots: 4 });
  assert.equal(Object.hasOwn(rows[0].read(), 'checkedAt'), false, 'UI projection must not expose an old probe time');
  assert.equal(histories[0].read().state, 'missing');
  assert.equal(histories[1].read().state, 'archived');
  for (const observer of rows.slice(2)) assert.equal(observer.notifications, 0);
});

test('two owners retain state, reason, identity, metadata, nested values and field absence changes', async t => {
  const f = fixture(); t.after(() => f.close());
  const owner = descriptor(0), neighbor = descriptor(1);
  const row = f.mount(owner), other = f.mount(neighbor);
  let current = verdict(owner, 1000);
  f.flush(); await f.answer(item => item.tabId === owner.tabId ? structuredClone(current) : verdict(item, 1000));
  const changes = [
    ...['checking', 'unknown', 'missing', 'partial', 'archived', 'available'].map(state => ({ state })),
    { historyState: 'partial' }, { reason: 'lineage-source-file-missing' },
    { archived: true }, { missingDependencies: ['source-a'] }, { missingDependencies: ['source-a', 'source-b'] },
    { deletedAt: 2000 }, { deletionSource: 'retention' }, { deletionOperationId: 'deletion-2' },
    { representation: 'compressed' }, { status: 'confirmed' }, { owner: 'owner-2' }, { generation: 2 }, { source: 'source-b' }, { count: 0 },
    { sessionId: owner.sessionId.toUpperCase() },
    { source: { id: 'source-b', checkedAt: 1 } }, { source: { id: 'source-b', checkedAt: 2 } },
  ];
  for (const patch of changes) {
    current = { ...current, ...patch };
    f.reset(); f.poll();
    await f.answer(item => item.tabId === owner.tabId ? structuredClone(current) : verdict(item, 1000));
    assert.equal(row.notifications, 1, JSON.stringify(patch));
    assert.equal(row.changedSnapshots, 1, JSON.stringify(patch));
    assert.equal(other.notifications, 0);
  }
  f.reset(); f.poll();
  await f.answer(item => item.tabId === owner.tabId
    ? { ...structuredClone(current), checkedAt: 31_000, source: { checkedAt: 2, id: 'source-b' } }
    : verdict(item, 31_000));
  assert.deepEqual(f.counts(), { notifications: 0, changedSnapshots: 0 }, 'cloned/reordered nested metadata is still equal');
  for (const remove of ['count', 'source', 'generation', 'owner', 'representation', 'missingDependencies']) {
    delete current[remove]; f.reset(); f.poll();
    await f.answer(item => item.tabId === owner.tabId ? structuredClone(current) : verdict(item, 1000));
    assert.equal(row.changedSnapshots, 1, 'field removed: ' + remove);
    assert.equal(Object.hasOwn(row.read(), remove), false);
    assert.equal(other.notifications, 0);
  }
  for (const patch of [{ missingDependencies: [] }, { count: undefined }, {}]) {
    f.reset(); f.poll();
    await f.answer(item => item.tabId === owner.tabId ? { ...structuredClone(current), ...patch } : verdict(item, 1000));
    assert.equal(row.changedSnapshots, 1, 'empty/undefined and absent fields remain distinct');
    assert.equal(other.notifications, 0);
  }
});

test('two owners preserve exact invalidation, registration counts, unknown reads and owner switches', async t => {
  const f = fixture(); t.after(() => f.close());
  const a = descriptor(0), b = descriptor(1);
  const row = f.mount(a), history = f.mount(a), other = f.mount(b);
  f.flush(); await f.answer(item => verdict(item, 1000));
  row.unmount(); f.reset(); f.poll();
  const retained = await f.answer(item => verdict(item, 31_000));
  assert.equal(retained.sessions.length, 2, 'remaining History subscriber keeps its registration');
  f.reset();
  f.ipc.emit('agent-session:availability-invalidated', null, { sessionIds: [a.sessionId] });
  assert.equal(history.notifications, 1);
  assert.equal(history.read().state, 'checking');
  assert.equal(f.api.getSessionAvailabilitySnapshot(a).checkedAt, null);
  assert.equal(other.notifications, 0);
  f.flush();
  const forced = await f.answer(item => verdict(item, 32_000, item.tabId === a.tabId ? { state: 'missing' } : {}));
  assert.equal(forced.force, true);
  assert.equal(history.read().state, 'missing');
  const cached = f.api.getSessionAvailabilitySnapshot(a);
  f.reset(); f.poll(); await f.answer(null, { reject: true });
  assert.equal(f.api.getSessionAvailabilitySnapshot(a), cached, 'failed read keeps last authoritative verdict');
  assert.deepEqual(f.counts(), { notifications: 0, changedSnapshots: 0 });

  history.unmount();
  const replacement = { ...a, provider: 'claude', sessionId: 'new-session' };
  const switched = f.mount(replacement);
  assert.equal(switched.read().state, 'checking');
  assert.equal(switched.read().provider, 'claude');
  f.flush(); await f.answer(null, { success: false });
  assert.equal(switched.read().state, 'unknown');
  assert.equal(switched.read().reason, 'availability-read-failed');
  f.poll(); const switchedBatch = await f.answer(item => verdict(item, 33_000));
  assert.equal(switchedBatch.sessions.length, 2);
  assert.equal(switchedBatch.sessions.some(item => item.sessionId === a.sessionId), false);
  assert.equal(switched.read().sessionId, replacement.sessionId);
  assert.equal(switched.read().state, 'available');
  const none = f.mount(null);
  assert.equal(none.read().state, 'none');
  f.close(); assert.equal(f.intervals.size, 0);
  assert.equal(f.ipc.listenerCount('agent-session:availability-invalidated'), 0);
});
