import test from 'node:test';
import assert from 'node:assert/strict';
import { getHeapStatistics } from 'node:v8';
import { createRequire } from 'node:module';
import { createHistoryPrimaryLiveCoverageOwner } from './historyPrimaryLiveCoverageOwner.mjs';
import { historyPrimaryLiveClaimFingerprint as fingerprint } from './historyPrimaryRootReadModel.mjs';
import { historyLivePresentationIdentities, reconcileCommittedHistoryLiveProjection } from './historyLiveProjection.mjs';
import { flushHistoryDurableWithRetry } from './historyDurableFlush.mjs';


test('reentrant full witness revocation after real query cannot publish or resurrect proof', async () => {
  const require = createRequire(import.meta.url);
  const { HistoryPrimaryRootReadModel } = await import('./historyPrimaryRootReadModel.mjs');
  const { readHistoryThroughIpc } = await import('./historyReadTransport.mjs');
  const { createPrimaryAddressFixture } = require('../../../scripts/test-support/history-primary-address-fixture.cjs');
  for (const action of ['dispose', 'invalidate', 'cancel-owner', 'replacement', 'after-publication', 'during-observed-install']) {
    const covered = !['after-publication', 'during-observed-install'].includes(action);
    const f = await createPrimaryAddressFixture(null, { entries: [{
      role: 'assistant', uuid: 'canonical', sourceIdentity: 'covered', sessionId: 's', content: 'canonical',
    }] });
    const model = new HistoryPrimaryRootReadModel((channel, payload) => channel === 'agent-transcript:cancel-read'
      ? { success: true } : f.invoke(channel, payload), { ...f.transport, readHistoryThroughIpc });
    model.windowDiagnostic = () => {};
    let owner, afterQuery = false, afterPublication = false, publishedWitnesses = 0, revoked = false, publications = 0, queries = 0;
    try {
      await model.open({ ...f.payload, primaryPresentation: { localEntries: [], liveEntries: [], liveToolResults: [],
        grouping: { enabled: false, responseWork: true, threshold: 2, expandedKeys: [] },
        captionSelections: [], settingsPresentationKeys: [] } });
      const actualQuery = model.readLiveIdentityCoverage.bind(model);
      model.readLiveIdentityCoverage = async (...args) => {
        queries++; const answer = await actualQuery(...args); afterQuery = true; return answer;
      };
      const identity = [], prototype = Object.create(Array.prototype);
      let fold;
      Object.defineProperty(prototype, 'join', { value() {
        if (afterPublication) publishedWitnesses++;
        const atBoundary = action === 'during-observed-install' ? publishedWitnesses === 2
          : action !== 'after-publication' || afterPublication;
        if (afterQuery && !revoked && atBoundary) {
          revoked = true;
          if (['dispose', 'after-publication', 'during-observed-install'].includes(action)) owner.dispose();
          else if (action === 'invalidate') owner.invalidate();
          else if (action === 'cancel-owner') owner.cancelOwner(model, 'A', 1);
          else {
            fold = { ownerKey: 'A', entries: [entry] };
            owner.wake('subject');
          }
        }
        return covered ? 'covered' : 'missing';
      } });
      Object.setPrototypeOf(identity, prototype);
      const entry = { role: 'assistant', uuid: 'live', sourceIdentity: identity, sessionId: 's', content: 'current' };
      entry.self = entry;
      fold = { ownerKey: 'A', entries: action === 'during-observed-install'
        ? [row('retired', { sourceIdentity: 'covered' }), entry] : [entry] };
      const commit = { root: model, dataSubject: model.getReceiptDataSubject(), ownerKey: 'A', generation: 1 };
      const liveCommit = { ...commit, live: fold, entries: fold.entries, fingerprints: fold.entries.map(fingerprint) };
      const errors = [];
      owner = createHistoryPrimaryLiveCoverageOwner({
        readCurrent: () => ({ root: model, live: fold, ownerKey: 'A', generation: 1, commit, liveCommit }),
        fingerprint,
        publish(remaining) {
          assert.equal(revoked, false, 'no publication may start after revocation');
          publications++; afterPublication = true;
          if (remaining !== fold.entries) fold = { ownerKey: 'A', entries: remaining };
          return fold;
        },
        onError: error => errors.push(error.code),
      });
      assert.equal(await owner.readUnmatched('A'), null, action);
      await tick(); assert(revoked, action);
      if (action === 'replacement') {
        // The independent new fold may prepare coverage, but has no live commit.
        assert.equal(await owner.readUnmatched('A'), false);
        assert.equal(queries, 2);
      }
      assert.equal(publications, ['after-publication', 'during-observed-install'].includes(action) ? 1 : 0, action);
      assert.equal(fold.entries.length, 1, action);
      assert.deepEqual(errors, []);
      owner.activate();
      if (action !== 'replacement') assert.equal(owner.peekUnmatched('A'), null, 'revoked proof cannot revive on activate');
    } finally { owner?.dispose(); await model.close(); f.close(); }
  }
});

// This control substitutes only the asynchronous query boundary so every
// replacement/late-result order is finite and deterministic. The integrated
// Panel control separately executes the actual producer/client/model chain.
assert(getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'run with --max-old-space-size=64 --max-semi-space-size=8');
globalThis.window = { require: createRequire(import.meta.url) };
const row = (id, extra = {}) => ({ uuid: id, role: 'assistant', sourceIdentity: 'src:' + id, sessionId: 's', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function fixture(entries, durable = [], { committed = true, intercept = async () => {} } = {}) {
  let dataSubject = {}, active = 0, peak = 0;
  const calls = [], publications = [], errors = [];
  const root = { header: { canonicalEntryCount: durable.length }, closed: false,
    getReceiptDataSubject: () => dataSubject,
    async readLiveIdentityCoverage(claims, options) {
      assert(claims.length <= 3); assert.equal(typeof options.owns(), 'boolean');
      active++; peak = Math.max(peak, active);
      const call = { claims, options, header: root.header, dataSubject, fingerprints: claims.map(fingerprint) };
      calls.push(call);
      try {
        const replacement = await intercept(call, calls.length);
        if (replacement) return replacement;
        // The unchanged pure native implementation is the differential oracle.
        // Deliberately allow a late reply after cancellation: the real owner
        // must reject it independently of a cooperative query implementation.
        const native = reconcileCommittedHistoryLiveProjection(claims, durable);
        return { header: call.header, dataSubject: call.dataSubject,
          claims: claims.map((entry, index) => {
            const coveredIdentity = historyLivePresentationIdentities(entry).some(id => native.durableIdentities.has(id));
            return { entry, fingerprint: call.fingerprints[index], coveredIdentity,
              settingsConflict: coveredIdentity && native.entries.includes(entry) };
          }) };
      } finally { active--; }
    } };
  const state = { root, ownerKey: 'A', generation: 1, live: { ownerKey: 'A', entries }, commit: null, liveCommit: null };
  const commit = () => { state.commit = { root, dataSubject, ownerKey: state.ownerKey, generation: state.generation };
    state.liveCommit = { ...state.commit, live: state.live, entries: state.live.entries, fingerprints: state.live.entries.map(fingerprint) }; };
  if (committed) commit();
  const owner = createHistoryPrimaryLiveCoverageOwner({ readCurrent: () => state, fingerprint,
    publish(remaining, previous, proof) {
      assert.equal(state.live, previous);
      publications.push({ remaining, previous, rows: proof.rows });
      if (remaining !== previous.entries) {
        state.live = { ownerKey: state.ownerKey, entries: remaining };
        state.liveCommit = { ...state.commit, live: state.live, entries: remaining, fingerprints: remaining.map(fingerprint) };
      }
      return state.live;
    }, onError: error => errors.push(error) });
  return { owner, state, root, calls, publications, errors,
    get peak() { return peak; }, get active() { return active; },
    commit() { commit(); owner.wake('commit'); },
    change(entries) { state.live = { ownerKey: state.ownerKey, entries }; state.liveCommit = null; owner.wake('subject'); },
    newCut() { dataSubject = {}; root.header = { canonicalEntryCount: durable.length }; owner.wake('metadata'); },
    headerOnly() { root.header = { canonicalEntryCount: durable.length }; owner.wake('metadata'); },
  };
}

test('all current claims are batched at three and published once after the final batch', async () => {
  const entries = Array.from({ length: 8 }, (_, i) => row(String(i)));
  const final = deferred();
  const f = fixture(entries, entries.slice(0, 7), { intercept: async (_call, n) => { if (n === 3) await final.promise; } });
  const observation = f.owner.readUnmatched('A'); await tick();
  assert.deepEqual(f.calls.map(call => call.claims.length), [3, 3, 2]);
  assert.equal(f.publications.length, 0); assert.equal(f.state.live.entries, entries);
  final.resolve(); assert.equal(await observation, true);
  assert.deepEqual(f.state.live.entries, [entries[7]]); assert.equal(f.publications.length, 1);
  assert.equal(f.publications[0].rows.length, 8); assert.equal(f.peak, 1);
  assert.equal(await f.owner.readUnmatched('A'), true); assert.equal(f.calls.length, 3);
  f.owner.dispose();
});

test('a later batch failure cannot publish early retirements; query UNKNOWN never retries itself', async () => {
  const entries = Array.from({ length: 4 }, (_, i) => row(String(i)));
  let fail = true;
  const f = fixture(entries, entries, { intercept: async (_call, n) => { if (n === 2 && fail) throw Error('late coercion'); } });
  assert.equal(await f.owner.readUnmatched('A'), null);
  assert.equal(f.state.live.entries, entries); assert.equal(f.publications.length, 0); assert.equal(f.calls.length, 2);
  f.owner.wake('commit'); f.owner.wake('subject');
  assert.equal(await f.owner.readUnmatched('A'), null); await tick(); assert.equal(f.calls.length, 2);
  fail = false; f.owner.wake('external-open');
  assert.equal(await f.owner.readUnmatched('A'), false); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.state.live.entries, []); f.owner.dispose();
});

test('settings conflict keeps the row while plain unmatched ignores conflict; no-ID remains unmatched', async () => {
  const setting = value => ({ uuid: 'setting', role: 'slash', sourceIdentity: 'same', sessionId: 's',
    settingsFact: { version: 1, provider: 'codex', kind: 'model', value } });
  const live = setting('wanted'), f = fixture([live], [setting('other')]);
  assert.equal(await f.owner.readUnmatched('A'), false);
  assert.deepEqual(f.state.live.entries, [live]);
  assert.equal(f.publications[0].rows[0].settingsConflict, true);
  f.change([live, { content: 'no identity' }]);
  assert.equal(await f.owner.readUnmatched('A'), true); assert.equal(f.state.live.entries.length, 2);
  f.owner.dispose();
});

test('data commit after load releases the same retained observation without paint or polling', async () => {
  const entry = row('covered'), f = fixture([entry], [entry], { committed: false });
  let loads = 0, settled = false;
  const flush = flushHistoryDurableWithRetry({ load: async () => { loads++; return true; }, isCurrent: () => true,
    hasUnmatchedLive: () => f.owner.readUnmatched('A') }).then(value => { settled = true; return value; });
  await tick(); assert.equal(loads, 1); assert.equal(f.calls.length, 0); assert.equal(settled, false);
  f.commit(); assert.equal((await flush).settled, true); assert.equal(loads, 1); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.state.live.entries, []); f.owner.dispose();
});

test('checked same-data header rebind reuses current proof without a new Panel render', async () => {
  const live = row('missing'), f = fixture([live], []);
  assert.equal(await f.owner.readUnmatched('A'), true);
  const oldHeader = f.root.header; f.headerOnly();
  assert.notEqual(f.root.header, oldHeader); assert.equal(await f.owner.readUnmatched('A'), true);
  assert.equal(f.calls.length, 1); assert.equal(f.state.live.entries[0], live); f.owner.dispose();
});

test('an existing streaming update survives old coverage until its real data commit; prepared proof then applies without reread', async () => {
  const live = row('stream', { content: 'initial' }), durable = row('stream', { content: 'old durable' });
  const f = fixture([live], [durable], { committed: false });
  // The canonical cut had committed earlier, before this new live revision.
  f.state.commit = { root: f.root, dataSubject: f.root.getReceiptDataSubject(), ownerKey: 'A', generation: 1 };
  assert.equal(await f.owner.readUnmatched('A'), false);
  assert.equal(f.state.live.entries[0], live); assert.equal(f.publications.length, 0);
  const updated = { ...live, content: 'latest streaming body' };
  f.change([updated]); assert.equal(await f.owner.readUnmatched('A'), false);
  assert.equal(f.state.live.entries[0], updated); assert.equal(f.publications.length, 0);
  assert.equal(f.calls.length, 2);
  f.commit(); await tick();
  assert.deepEqual(f.state.live.entries, []); assert.equal(f.publications.length, 1);
  assert.equal(f.calls.length, 2, 'real commit reuses only the prepared current-fold/current-cut proof');
  f.owner.dispose();
});

test('a new canonical cut invalidates proof and waits for its actual data commit', async () => {
  const live = row('missing'), f = fixture([live], []);
  assert.equal(await f.owner.readUnmatched('A'), true); f.newCut();
  let settled = false; const next = f.owner.readUnmatched('A').then(value => { settled = true; return value; });
  await tick(); assert.equal(f.owner.peekUnmatched('A'), null); assert.equal(settled, false); assert.equal(f.calls.length, 1);
  f.commit(); assert.equal(await next, true); assert.equal(f.calls.length, 2); f.owner.dispose();
});

test('running plus one replaceable pending demand drops no current claim and rejects the old late result', async () => {
  const gate = deferred(), a = row('A'), b = row('B'), c = row('C');
  const f = fixture([a], [a, b], { intercept: async (_call, n) => { if (n === 1) await gate.promise; } });
  const old = f.owner.readUnmatched('A'); await tick();
  f.change([b]); const replaced = f.owner.readUnmatched('A');
  f.change([c]); f.commit(); const current = f.owner.readUnmatched('A');
  assert.equal(await old, null); assert.equal(await replaced, null); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.calls[0].options.owns(), false);
  gate.resolve(); assert.equal(await current, true);
  assert.deepEqual(f.calls.map(call => call.claims), [[a], [c]]);
  assert.equal(f.peak, 1); assert.deepEqual(f.state.live.entries, [c]); assert.equal(f.publications.length, 1); f.owner.dispose();
});

test('imperative A→B→A live ownership witness rejects the first A even before React renders', async () => {
  const gate = deferred(), entry = row('a');
  const f = fixture([entry], [entry], { intercept: async (_call, n) => { if (n === 1) await gate.promise; } });
  const original = f.state.live, old = f.owner.readUnmatched('A'); await tick();
  f.change([row('b')]); f.state.live = original; f.owner.wake('subject'); f.commit();
  const latest = f.owner.readUnmatched('A'); assert.equal(await old, null);
  gate.resolve(); assert.equal(await latest, false); assert.equal(f.calls.length, 2);
  assert.equal(f.publications.length, 1); f.owner.dispose();
});

test('in-place alias and cyclic field mutations use fresh actual fingerprints after await', async () => {
  const gate = deferred(), entry = row('live', { sourceIdentityAliases: ['covered'] }); entry.self = entry;
  const durable = row('durable', { sourceIdentity: 'covered' });
  const f = fixture([entry], [durable], { intercept: async (_call, n) => { if (n === 1) await gate.promise; } });
  const old = f.owner.readUnmatched('A'); await tick();
  entry.sourceIdentityAliases[0] = 'missing'; entry.self.newField = 'revision';
  f.owner.wake('subject'); f.commit(); const current = f.owner.readUnmatched('A');
  assert.equal(await old, null); gate.resolve(); assert.equal(await current, true);
  assert.equal(f.state.live.entries[0], entry); assert.equal(f.publications.length, 1); assert.equal(f.calls.length, 2);
  f.owner.dispose();
});

test('header replacement during a query aborts old work; same data only reuses completed proof', async () => {
  const gate = deferred(), entry = row('a');
  const f = fixture([entry], [], { intercept: async (_call, n) => { if (n === 1) await gate.promise; } });
  const old = f.owner.readUnmatched('A'); await tick(); f.headerOnly();
  const current = f.owner.readUnmatched('A'); assert.equal(await old, null);
  gate.resolve(); assert.equal(await current, true); assert.equal(f.calls.length, 2); assert.equal(f.publications.length, 1);
  f.owner.dispose();
});

test('same-header external-open settlement is retained when it precedes the obsolete query rejection', async () => {
  const gate = deferred(), entry = row('a');
  const f = fixture([entry], [], { intercept: async (_call, n) => { if (n === 1) await gate.promise; } });
  const old = f.owner.readUnmatched('A'); await tick();
  const header = f.root.header, cut = f.root.getReceiptDataSubject();
  f.owner.wake('external-open'); const replacement = f.owner.readUnmatched('A');
  assert.equal(await old, null); assert.equal(f.calls[0].options.signal.aborted, true);
  gate.reject(Object.assign(Error('HISTORY_READ_CANCELLED'), { code: 'HISTORY_READ_CANCELLED' }));
  assert.equal(await replacement, true); assert.equal(f.calls.length, 2); assert.equal(f.peak, 1);
  assert.equal(f.root.header, header); assert.equal(f.root.getReceiptDataSubject(), cut);
  assert.equal(await f.owner.readUnmatched('A'), true); assert.equal(f.calls.length, 2); f.owner.dispose();
});

test('no root, stale generation, owner cancellation and disposed return guards preserve UNKNOWN', async () => {
  const gate = deferred(), entry = row('a');
  const f = fixture([entry], [entry], { intercept: async () => { await gate.promise; } });
  const old = f.owner.readUnmatched('A'); await tick(); f.state.generation++;
  gate.resolve(); assert.equal(await old, null); assert.equal(f.publications.length, 0);
  f.state.root = null; assert.equal(await f.owner.readUnmatched('A'), null);
  f.state.root = f.root; f.state.generation--; f.commit();
  const current = f.owner.readUnmatched('A'); f.owner.cancelOwner(f.root, 'A', 1);
  assert.equal(await current, null); assert.equal(f.publications.length, 0);
  f.owner.dispose(); assert.equal(await f.owner.readUnmatched('A'), null);
  f.owner.activate(); f.owner.wake('subject'); assert.equal(await f.owner.readUnmatched('A'), false);
  f.owner.dispose();
});

test('synchronous admission retains unknown subjects, existing streams and Codex settings exceptions', async () => {
  const live = { uuid: 'setting', role: 'slash', sourceIdentity: 'same', sessionId: 's',
    settingsFact: { version: 1, provider: 'codex', kind: 'model', value: 'live' } };
  const f = fixture([live], [{ ...live, settingsFact: { ...live.settingsFact, value: 'durable' } }]);
  assert.equal(f.owner.admits(live, historyLivePresentationIdentities(live), new Set()), true);
  assert.equal(await f.owner.readUnmatched('A'), false);
  assert.equal(f.owner.admits(live, historyLivePresentationIdentities(live), new Set()), true);
  const streamed = { ...live, content: 'new stream body' };
  assert.equal(f.owner.admits(streamed, historyLivePresentationIdentities(streamed), new Set(['same'])), true);
  assert.equal(f.owner.admits({ content: 'no ID' }, [], new Set()), true);
  assert.equal(f.owner.admits(row('new'), ['src:new'], new Set()), true); f.owner.dispose();
});

test('UNKNOWN/rejected flush observations stop after one load; known unmatched retains the original three-attempt budget', async () => {
  for (const result of [null, undefined, 'false', () => { throw Error('unknown'); }]) {
    let loads = 0, observations = 0;
    const outcome = await flushHistoryDurableWithRetry({ load: async () => { loads++; return true; }, isCurrent: () => true,
      hasUnmatchedLive: async () => { observations++; return typeof result === 'function' ? result() : result; } });
    assert.equal(outcome.unknown, true); assert.equal(outcome.settled, false); assert.equal(loads, 1); assert.equal(observations, 1);
  }
  let loads = 0;
  const known = await flushHistoryDurableWithRetry({ load: async () => { loads++; return true; }, isCurrent: () => true,
    hasUnmatchedLive: async () => true });
  assert.equal(loads, 3); assert.equal(known.settled, false); assert.equal(known.unknown, undefined);
  const gate = deferred(); let current = true;
  const stale = flushHistoryDurableWithRetry({ load: async () => true, isCurrent: () => current, hasUnmatchedLive: () => gate.promise });
  await tick(); current = false; gate.resolve(false); assert.equal((await stale).stale, true);
  let observations = 0;
  const asyncOwnership = await flushHistoryDurableWithRetry({ load: async () => true, isCurrent: () => Promise.resolve(true),
    hasUnmatchedLive: () => { observations++; return false; } });
  assert.equal(asyncOwnership.stale, true); assert.equal(observations, 0, 'a Promise is not synchronous owner authority');
});
