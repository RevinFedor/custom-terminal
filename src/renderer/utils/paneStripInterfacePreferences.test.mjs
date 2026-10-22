import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaneStripInterfacePreferences, initialPaneStripInterfacePreferences,
  PANE_STRIP_INTERFACE_PREFERENCE_KEYS as keys } from './paneStripInterfacePreferences.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject }; };
function fixture(invoke) {
  let state = initialPaneStripInterfacePreferences();
  const reports = [];
  const io = createPaneStripInterfacePreferences({ getState: () => state,
    setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; },
    invoke, reportError: (...args) => reports.push(args) });
  return { io, reports, get state() { return state; } };
}

test('new modes default OFF; a missing SQL row hydrates without an implicit write', async () => {
  const calls = [], h = fixture(async (...args) => { calls.push(args); return null; });
  assert.equal(h.state.paneStripSelectedFirst, false); assert.equal(h.state.paneStripCloseOnClick, false);
  assert.equal(h.state.paneStripInstantHover,false);
  await h.io.hydrate();
  assert.deepEqual(calls, keys.map(key => ['app:getState', key]));
  assert.deepEqual(h.state.paneStripPreferenceStatus, Object.fromEntries(keys.map(key => [key, 'ready'])));
});

test('both true and false survive a fresh preference owner without localStorage', async () => {
  const db = new Map();
  const invoke = async (channel, arg) => {
    if (channel === 'app:getState') return db.get(arg) ?? null;
    assert.equal(channel, 'app:setState'); db.set(arg.key, arg.value); return { success: true };
  };
  for (const value of [true, false]) {
    const h = fixture(invoke); await h.io.hydrate();
    await Promise.all(keys.map(key => h.io.write(key, value)));
    const reopened = fixture(invoke); await reopened.io.hydrate();
    for (const key of keys) assert.equal(reopened.state[key], value);
  }
});

test('late hydrate cannot overwrite even a same-value explicit local edit', async () => {
  const read = deferred(), write = deferred();
  const h = fixture((channel, arg) => channel === 'app:setState' ? write.promise
    : arg === 'paneStripSelectedFirst' ? read.promise : Promise.resolve(true));
  const hydrate = h.io.hydrate(), save = h.io.write('paneStripSelectedFirst', false);
  read.resolve(true); await hydrate;
  assert.equal(h.state.paneStripSelectedFirst, false);
  assert.equal(h.state.paneStripPreferenceStatus.paneStripSelectedFirst, 'saving');
  assert.equal(h.state.paneStripCloseOnClick, true, 'untouched sibling still hydrates');
  write.resolve({ success: true }); assert.equal(await save, true);
});

test('late successful hydrate is discarded after an explicit edit whose write failed', async () => {
  const read = deferred();
  const h = fixture(channel => channel === 'app:getState' ? read.promise : Promise.resolve({ success: false }));
  const hydrate = h.io.hydrate(); await h.io.write('paneStripCloseOnClick', true);
  read.resolve(false); await hydrate;
  assert.equal(h.state.paneStripCloseOnClick, true);
  assert.equal(h.state.paneStripPreferenceStatus.paneStripCloseOnClick, 'save-error');
});

test('old ACK and old failure cannot settle a newer click; writes use only existing app:setState', async () => {
  const pending = [], calls = [], h = fixture((channel, payload) => {
    assert.equal(channel, 'app:setState'); calls.push(payload); const d = deferred(); pending.push(d); return d.promise;
  });
  const first = h.io.write(keys[0], true), second = h.io.write(keys[0], false), third = h.io.write(keys[0], true);
  assert.deepEqual(calls.map(call => [call.key, call.value]), [[keys[0], true], [keys[0], false], [keys[0], true]]);
  pending[0].resolve({ success: true }); pending[1].reject(new Error('old ACK lost'));
  assert.equal(await first, true); assert.equal(await second, false);
  assert.equal(h.state[keys[0]], true); assert.equal(h.state.paneStripPreferenceStatus[keys[0]], 'saving');
  assert.equal(h.reports.length, 0);
  pending[2].resolve({ success: true }); assert.equal(await third, true);
  assert.equal(h.state.paneStripPreferenceStatus[keys[0]], 'ready');
});

test('success:false is not saved; user can retry the same local choice', async () => {
  let succeed = false; const calls = [], h = fixture(async (channel, value) => {
    calls.push([channel, value]); return { success: succeed };
  });
  assert.equal(await h.io.write(keys[1], true), false);
  assert.equal(h.state[keys[1]], true); assert.equal(h.state.paneStripPreferenceStatus[keys[1]], 'save-error');
  succeed = true; assert.equal(await h.io.retry(keys[1]), true);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
});

test('throw or missing ACK stays unknown without rollback or automatic replay', async () => {
  for (const result of ['throw', undefined, {}]) {
    let writes = 0; const h = fixture(async () => { writes++; if (result === 'throw') throw new Error('transport'); return result; });
    assert.equal(await h.io.write(keys[0], true), false);
    assert.equal(h.state[keys[0]], true); assert.equal(h.state.paneStripPreferenceStatus[keys[0]], 'save-unknown');
    assert.equal(writes, 1);
  }
});

test('failed load retries read-only; it never seeds a false default over unknown SQL', async () => {
  let attempts = 0; const calls = [], h = fixture(async (channel, payload) => {
    calls.push([channel, payload]); if (++attempts <= 2) throw new Error('read unavailable'); return true;
  });
  await h.io.hydrate(); assert.equal(h.state.paneStripPreferenceStatus[keys[1]], 'load-error');
  await h.io.retry(keys[1]); assert.equal(h.state[keys[1]], true);
  assert.ok(calls.every(([channel]) => channel === 'app:getState'));
});

test('invalid stored data is not silently promoted to an enabled mode', async () => {
  const h = fixture(async () => 'true'); await h.io.hydrate();
  for (const key of keys) { assert.equal(h.state[key], false); assert.equal(h.state.paneStripPreferenceStatus[key], 'load-error'); }
});

test('a slow earlier hydrate cannot replace a newer read; reads after edits are inert', async () => {
  const pending = [], h = fixture(() => { const d = deferred(); pending.push(d); return d.promise; });
  const a = h.io.hydrate(), b = h.io.hydrate();
  for(const read of pending.slice(keys.length,2*keys.length))read.resolve(true);await b;
  for(const read of pending.slice(0,keys.length))read.resolve(false);await a;
  for (const key of keys) assert.equal(h.state[key], true);
  const edit = h.io.write(keys[0], false); pending[2*keys.length].resolve({ success: true }); await edit;
  const c = h.io.hydrate(); assert.equal(pending.length, 3*keys.length, 'only unedited keys read again');
  for(const read of pending.slice(2*keys.length+1))read.resolve(false);await c;assert.equal(h.state[keys[0]],false);
});

test('diagnostic callback failure cannot replace a known rejection with an unknown write', async () => {
  let state = initialPaneStripInterfacePreferences();
  const io = createPaneStripInterfacePreferences({ getState: () => state,
    setState: patch => { state = { ...state, ...patch(state) }; }, invoke: async () => ({ success: false }),
    reportError: () => { throw new Error('diagnostic'); } });
  assert.equal(await io.write(keys[0], true), false);
  assert.equal(state.paneStripPreferenceStatus[keys[0]], 'save-error');
});
