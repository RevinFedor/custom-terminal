import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import {
  historyLivePresentationIdentities,
  reconcileCommittedHistoryLiveProjection,
} from './historyLiveProjection.mjs';

// Source-level work/semantics control, not a mounted React or timing test.
// Execute the actual HPL blocks with one persistent ref slot and explicit
// layout effects; import the production reconciler above without copying it.
// Optional differential target requires its SHA; the default is this checkout.
const override = process.env.NOTED_HISTORY_IDENTITY_SOURCE;
const expectedSHA = process.env.NOTED_HISTORY_IDENTITY_SHA256;
assert.equal(Boolean(override), Boolean(expectedSHA), 'source override and SHA must be paired');
const target = override || new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url);
assert(fs.statSync(target).size <= 2 * 1024 * 1024, 'HPL source exceeds the 2 MiB control bound');
const source = fs.readFileSync(target, 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
if (override) assert.equal(sha(source), expectedSHA, 'differential source pin');

// Only these two historical TS blocks are fixtures (1,233 bytes total), pinned
// from HPL 178f8519e62902ed32f425d5e67a6b0e74e698881f3af5296ea903d66133d5d4.
// No full old HPL, copied production helper or private-directory dependency.
const baseline = {
  seed: `  const durableSourceIdentitiesRef = useRef<Set<string>>(new Set(
    (
      (firstRenderSnapshot?.entries as unknown as FullHistoryEntry[] | undefined)
      || []
    )
      .flatMap((entry) => historyLivePresentationIdentities(entry)),
  ));
`,
  commit: '  // `transcriptEntries` already committed the durable version into the same\n'
    + `  // virtualized slot before this layout effect runs. Now it is safe to retire
  // the redundant live state; the next render keeps the same row and key.
  useLayoutEffect(() => {
    if (
      presentedOwnerKey !== historyOwnerKey
      || historyOwnerKeyRef.current !== historyOwnerKey
    ) return;
    durableSourceIdentitiesRef.current = new Set(
      entries
        .flatMap((entry) => historyLivePresentationIdentities(entry)),
    );
    reconcileLiveProjectionAgainstDurable(entries, historyOwnerKey);
    const committed = entries.filter(entry => !isLocalPromptEntry(entry) && !entry.liveProjection);
    committedHistoryEntriesRef.current = { ownerKey: historyOwnerKey, entries: committed };
    consumeMaterializedPromptHandoffs(committed);
  }, [
    entries,
    historyOwnerKey,
    presentedOwnerKey,
    reconcileLiveProjectionAgainstDurable,
    consumeMaterializedPromptHandoffs,
  ]);

`,
};

function between(text, start, end) {
  const a = text.indexOf(start);
  assert(a >= 0, 'missing extraction start: ' + start);
  assert.equal(text.indexOf(start, a + start.length), -1, 'ambiguous extraction: ' + start);
  const b = text.indexOf(end, a + start.length);
  assert(b > a, 'missing extraction end: ' + end);
  assert(b - a < 16 * 1024, 'extracted block exceeds 16 KiB');
  return text.slice(a, b);
}

const current = {
  seed: between(source, '  const durableSourceIdentitiesRef = ', '  const presentationEntriesRef = '),
  commit: between(source, '  // `transcriptEntries` already committed', '  // Restore the reading position once per owner'),
};
const reconcileBlock = between(source, '  const reconcileLiveProjectionAgainstDurable = ',
  '  const reconcileLiveToolResultsAgainstDurable = ');
const predicateBlock = between(source, 'const isLocalPromptEntry = ', 'const isLocalRewindEntry = ');
const prefix = source.match(/const LOCAL_PROMPT_PREFIX = ([^;]+);/);
assert(prefix, 'local prompt prefix');
// Extract the actual reset statement from its owner-reset context, not a
// simulated replacement lifecycle. The rest of the owner effect is not run.
const resetContext = between(source,
  '    liveProjectionRef.current = { ownerKey: historyOwnerKey, entries: [] };\n    liveToolResultsRef.current = ',
  "    committedHistoryEntriesRef.current = { ownerKey: '', entries: [] };");
const resetStatement = resetContext.match(/^    durableSourceIdentitiesRef\.current = new Set\(\);$/m)?.[0];
assert(resetStatement, 'actual owner reset statement');

function compile(block, result = '') {
  const compiled = ts.transpileModule(block, {
    fileName: 'HistoryPanel.extracted.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  assert.deepEqual(compiled.diagnostics || [], [], 'extracted TS syntax diagnostics');
  return new Function('env', 'with (env) {\n' + compiled.outputText + '\n' + result + '\n}');
}

const variants = { baseline, current };
const seedFn = Object.fromEntries(Object.entries(variants).map(([name, b]) =>
  [name, compile(b.seed, 'return durableSourceIdentitiesRef;')]));
const commitFn = Object.fromEntries(Object.entries(variants).map(([name, b]) => [name, compile(b.commit)]));
const reconcileFn = compile(reconcileBlock, 'return reconcileLiveProjectionAgainstDurable;');
const resetFn = compile(resetStatement);
const predicate = compile('const LOCAL_PROMPT_PREFIX = ' + prefix[1] + ';\n' + predicateBlock,
  'return { isLocalPromptEntry, prefix: LOCAL_PROMPT_PREFIX };')({});

console.log('SOURCE_CERTIFICATE ' + JSON.stringify({
  sourceSHA256: sha(source), sourceBytes: Buffer.byteLength(source),
  seedSHA256: sha(current.seed), commitSHA256: sha(current.commit),
  reconcileSHA256: sha(reconcileBlock), typescript: ts.version,
  node: process.version, electron: process.versions.electron || null,
}));

function measuredRows(rows) {
  const list = [...rows], stats = { passes: 0, rows: 0 };
  Object.defineProperty(list, 'flatMap', { value(fn, thisArg) {
    stats.passes++;
    stats.rows += this.length;
    return Array.prototype.flatMap.call(this, fn, thisArg);
  } });
  return { list, stats, clear() { stats.passes = 0; stats.rows = 0; } };
}

function owner(name, snapshot, live = []) {
  let slot;
  const calls = { live: [], liveIdentitySets: [], handoffs: [], diagnostics: [] };
  const env = {
    firstRenderSnapshot: snapshot,
    useRef(initial) { if (!slot) slot = { current: initial }; return slot; },
    useCallback(fn) { return fn; },
    useLayoutEffect(fn) { fn(); },
    historyLivePresentationIdentities, reconcileCommittedHistoryLiveProjection,
    historyOwnerKeyRef: { current: 'owner-a' }, historyOwnerKey: 'owner-a',
    presentedOwnerKey: 'owner-a', tabId: 'test-tab-a',
    liveProjectionRef: { current: { ownerKey: 'owner-a', entries: live } },
    isTurnBusyRef: { current: true }, liveOrphanDigestRef: { current: '' },
    setLiveEntries(rows) {
      calls.live.push(rows);
      calls.liveIdentitySets.push(env.durableSourceIdentitiesRef.current);
    },
    historyDiag(value) { calls.diagnostics.push(value); },
    committedHistoryEntriesRef: { current: { ownerKey: '', entries: [] } },
    isLocalPromptEntry: predicate.isLocalPromptEntry,
    consumeMaterializedPromptHandoffs(rows) { calls.handoffs.push(rows); },
  };
  const render = snapshot => {
    env.firstRenderSnapshot = snapshot;
    env.durableSourceIdentitiesRef = seedFn[name](env);
    return env.durableSourceIdentitiesRef.current;
  };
  render(snapshot);
  env.reconcileLiveProjectionAgainstDurable = reconcileFn(env);
  return { env, calls, render,
    commit(rows) { env.entries = rows; commitFn[name](env); },
    reset(nextOwner) {
      resetFn(env);
      env.historyOwnerKeyRef.current = nextOwner;
      env.historyOwnerKey = nextOwner;
      env.presentedOwnerKey = nextOwner;
      env.liveProjectionRef.current = { ownerKey: nextOwner, entries: [] };
    },
  };
}

const ids = value => [...value].sort();
const row = (id, extra = {}) => ({ uuid: id, role: 'assistant', sourceIdentity: 'src:' + id, ...extra });

test('warm seed: same aliases and persistent set; repeated renders no longer scan snapshot', () => {
  const rows = measuredRows([row('a', { sourceIdentityAliases: ['alias:a', 'alias:a'] }), row('b')]);
  const snapshot = { entries: rows.list };
  const pre = owner('baseline', snapshot), seed = pre.env.durableSourceIdentitiesRef.current;
  for (let i = 0; i < 8; i++) assert.equal(pre.render(snapshot), seed);
  assert.equal(rows.stats.passes, 9);
  rows.clear();
  const post = owner('current', snapshot), postSeed = post.env.durableSourceIdentitiesRef.current;
  for (let i = 0; i < 8; i++) assert.equal(post.render(snapshot), postSeed);
  assert.deepEqual(ids(postSeed), ids(seed));
  assert(postSeed.has('alias:a'));
  assert.equal(rows.stats.passes, 1);
});

test('cold miss and late cache arrival cannot seed an already mounted owner', () => {
  for (const name of Object.keys(variants)) {
    const h = owner(name, undefined), empty = h.env.durableSourceIdentitiesRef.current;
    assert.deepEqual(ids(empty), []);
    const late = [row('late')];
    assert.equal(h.render({ entries: late }), empty);
    assert.deepEqual(ids(empty), []);
    h.commit(late);
    assert(h.env.durableSourceIdentitiesRef.current.has('src:late'));
  }
});

test('canonical commit without live rows publishes exact set: two passes become one', () => {
  const rows = measuredRows([row('a'), row('b'), row('c')]);
  const pre = owner('baseline', undefined); pre.commit(rows.list);
  assert.equal(rows.stats.passes, 2); rows.clear();
  const post = owner('current', undefined); post.commit(rows.list);
  assert.deepEqual(ids(post.env.durableSourceIdentitiesRef.current), ids(pre.env.durableSourceIdentitiesRef.current));
  assert.equal(post.calls.live.length, 0);
  assert.deepEqual(post.calls.handoffs, pre.calls.handoffs);
  assert.equal(rows.stats.passes, 1);
});

test('fetched snapshot cannot retire live; committed alias publishes identities before retirement', () => {
  for (const name of Object.keys(variants)) {
    const live = [row('live', { sourceIdentity: 'alias:covered' }), row('remaining')];
    const h = owner(name, undefined, live);
    const durable = [row('durable', { sourceIdentityAliases: ['alias:covered'] })];
    h.render({ entries: durable });
    assert.equal(h.env.liveProjectionRef.current.entries, live);
    assert.deepEqual(ids(h.env.durableSourceIdentitiesRef.current), []);
    assert.equal(h.calls.live.length, 0);
    h.commit(durable);
    assert.deepEqual(h.env.liveProjectionRef.current.entries, [live[1]]);
    assert.equal(h.calls.live.length, 1);
    assert.equal(h.calls.liveIdentitySets[0], h.env.durableSourceIdentitiesRef.current);
    assert(h.calls.liveIdentitySets[0].has('alias:covered'));
  }
});

test('same-length owner switch resets; subsequent render cannot resurrect previous seed', () => {
  for (const name of Object.keys(variants)) {
    const h = owner(name, { entries: [row('a')] });
    h.reset('owner-b');
    const empty = h.env.durableSourceIdentitiesRef.current;
    assert.deepEqual(ids(empty), []);
    assert.equal(h.render({ entries: [row('b')] }), empty);
    h.commit([row('b')]);
    assert.deepEqual(ids(h.env.durableSourceIdentitiesRef.current), ['assistant-uuid:b', 'src:b']);
    const current = h.env.durableSourceIdentitiesRef.current;
    assert.equal(h.render({ entries: [row('a')] }), current);
    assert.deepEqual(ids(current), ['assistant-uuid:b', 'src:b']);
  }
});

test('stale owner guards and empty replacement keep their previous semantics', () => {
  for (const name of Object.keys(variants)) {
    const h = owner(name, { entries: [row('a')] }), seed = h.env.durableSourceIdentitiesRef.current;
    h.env.presentedOwnerKey = 'foreign'; h.commit([row('foreign')]);
    assert.equal(h.env.durableSourceIdentitiesRef.current, seed);
    assert.equal(h.calls.handoffs.length, 0);
    h.env.presentedOwnerKey = 'owner-a'; h.env.historyOwnerKeyRef.current = 'foreign';
    h.commit([row('foreign')]);
    assert.equal(h.env.durableSourceIdentitiesRef.current, seed);
    assert.equal(h.calls.handoffs.length, 0);
    h.env.historyOwnerKeyRef.current = 'owner-a'; h.commit([]);
    assert.deepEqual(ids(h.env.durableSourceIdentitiesRef.current), []);
    assert.deepEqual(h.env.committedHistoryEntriesRef.current.entries, []);
    assert.deepEqual(h.calls.handoffs, [[]]);
  }
});

test('foreign live owner remains untouched while current durable identities advance', () => {
  for (const name of Object.keys(variants)) {
    const h = owner(name, undefined), foreign = { ownerKey: 'foreign', entries: [row('a')] };
    h.env.liveProjectionRef.current = foreign; h.commit([row('a')]);
    assert.equal(h.env.liveProjectionRef.current, foreign);
    assert(h.env.durableSourceIdentitiesRef.current.has('src:a'));
    assert.equal(h.calls.live.length, 0);
  }
});

test('same source identity with contradictory Codex settings stays visible until reconciled', () => {
  const setting = value => ({ role: 'slash', uuid: 'setting', sourceIdentity: 'same-record', sessionId: 's',
    settingsFact: { version: 1, provider: 'codex', kind: 'model', value } });
  for (const name of Object.keys(variants)) {
    const live = [setting('first')], h = owner(name, undefined, live);
    h.commit([setting('second')]);
    assert.equal(h.env.liveProjectionRef.current.entries, live);
    assert.equal(h.calls.live.length, 0);
    h.commit([setting('first')]);
    assert.deepEqual(h.env.liveProjectionRef.current.entries, []);
    assert.equal(h.calls.live.length, 1);
  }
});

test('committed handoff rows still exclude local prompts and volatile live rows', () => {
  for (const name of Object.keys(variants)) {
    const rows = [{ role: 'queued', uuid: predicate.prefix + 'own-send' },
      row('volatile', { liveProjection: true }), row('durable')];
    const h = owner(name, undefined); h.commit(rows);
    assert.deepEqual(h.calls.handoffs, [[rows[2]]]);
    assert.deepEqual(h.env.committedHistoryEntriesRef.current.entries, [rows[2]]);
  }
});

test('four owners: bounded work reduction without throttling commits or live publication', () => {
  const totals = {};
  for (const name of Object.keys(variants)) {
    let passes = 0, visits = 0;
    for (let n = 0; n < 4; n++) {
      const rows = measuredRows(Array.from({ length: 2048 }, (_, i) => row(`${n}:${i}`)));
      const h = owner(name, { entries: rows.list });
      for (let i = 0; i < 12; i++) h.render({ entries: rows.list });
      h.commit(rows.list);
      assert.equal(h.calls.handoffs.length, 1);
      assert.equal(h.env.committedHistoryEntriesRef.current.entries.length, 2048);
      passes += rows.stats.passes; visits += rows.stats.rows;
    }
    totals[name] = { passes, visits };
  }
  console.log('MECHANISM_COUNTS ' + JSON.stringify(totals));
  assert.deepEqual(totals, { baseline: { passes: 60, visits: 122880 }, current: { passes: 8, visits: 16384 } });
});

test('pinned blocks limit changes to seed and overwritten commit assignment; reconciler stays exact', () => {
  const baselinePins = {
    seed: '9e5b52140439195420b0c1524d917a0cd8b449618c3fbd2ecfee031e6d0b3e15',
    commit: 'db7e7a6580a06b021b77df149799c9c4e8584f8e95c431d973046af227a81ed0',
  };
  const candidatePins = {
    seed: '55fd8caa1607e7771d2a3f7931a75f4e26444736f890f21c4993366652230649',
    commit: '016d17eae9ba1fcd9f03cad34a5b07cfe9d09075369338d3ee07963e1bdbc1cb',
  };
  for (const key of ['seed', 'commit']) assert.equal(sha(baseline[key]), baselinePins[key], 'baseline ' + key);
  const currentPins = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, sha(value)]));
  assert([baselinePins, candidatePins].some(pins => JSON.stringify(pins) === JSON.stringify(currentPins)),
    'expected a coherent original or candidate block pair');
  assert.equal(sha(reconcileBlock), '6d599c8f66f63073545ce7549b578142220b77f0327cd8dc2670f1359b60a302');
  assert.equal(sha(predicateBlock), '1e410229aca9f0352c7666d961b482298f1c8dcc3d6898aa17c4ecd81d4976ed');
  assert.equal(sha(resetContext), '59f67bf89855c5be4c2efb20f9fb13845f5757e55c5a65d979b194f40c936576');
  assert.equal(prefix[1], "'local-prompt-'");
});
