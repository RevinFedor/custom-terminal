// Execute callback expressions extracted from the CURRENT+patch Panel itself.
// No React/Mac app is launched. @babel/parser is the repository-pinned parser;
// the source-only runner uses Node 24's built-in TypeScript erasure.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { captureHistoryPrimaryPanelWitness, historyPrimaryPanelWitnessCurrent,
  historyPrimaryPanelInputFingerprint, readHistoryPrimaryPanelAddress,
  collectHistoryPrimaryMountedSearchSubjects } from '../../src/renderer/utils/historyPrimaryPanelBindings.mjs';
import { historyPrimaryToolClaimFingerprint } from '../../src/renderer/utils/historyPrimaryRootReadModel.mjs';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const source = fs.readFileSync(new URL('../../src/renderer/components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
const all = [];
function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type) all.push(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(visit); else visit(value);
  }
}
visit(ast);
const text = node => source.slice(node.start, node.end);
const only = values => { assert.equal(values.length, 1); return values[0]; };
const effect = marker => only(all.filter(node => node.type === 'CallExpression' && node.callee.name === 'useEffect'
  && text(node.arguments[0]).includes(marker))).arguments[0];
const layoutEffect = marker => only(all.filter(node => node.type === 'CallExpression' && node.callee.name === 'useLayoutEffect'
  && text(node.arguments[0]).includes(marker))).arguments[0];
const callback = name => only(all.filter(node => node.type === 'VariableDeclarator' && node.id.name === name)).init.arguments[0];
function evaluate(node, environment) {
  const erased = stripTypeScriptTypes('(' + text(node) + ')', { mode: 'strip' });
  return Function(...Object.keys(environment), 'return ' + erased)(...Object.values(environment));
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const poison = new Proxy({}, { get() { throw Error('all-N compatibility read'); } });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const ref = current => ({ current });
function rootRig() {
  const requests = [], root = { header: { leaseId: 'L1' }, totalCount: 9000, closed: false };
  root.resolvePresentationTarget = (identity, tool, options) => {
    const d = deferred(); requests.push({ identity, tool, options, method: 'target', ...d }); return d.promise;
  };
  root.resolveUuid = (identity, options) => {
    const d = deferred(); requests.push({ identity, options, method: 'uuid', ...d }); return d.promise;
  };
  root.resolveGroup = (identity, options) => {
    const d = deferred(); requests.push({ identity, options, ...d }); return d.promise;
  };
  root.resolveKey = root.resolveGroup;
  return { root, requests };
}
function initialRig(anchor = false) {
  const r = rootRig(), writes = [], errors = [], store = { historyScrollRequestGeneration: 6 };
  const identity = 'source:\u0000\ud800😀' + 'x'.repeat(9000);
  const env = {
    primaryPhysicalCandidate: true, primaryRoot: r.root, historyScrollToUuid: anchor ? null : identity,
    primaryInputsCurrent: () => true, historyOwnerKey: 'owner', historyOwnerKeyRef: ref('owner'),
    historyOwnerGenerationRef: ref(4), requestedHistoryScrollGeneration: 6, primaryRootRef: ref(r.root),
    useUIStore: { getState: () => store }, historyScrollToolTarget: { requestId: 'request', messageReference: { physicalSessionId: 'P' } },
    setPrimaryJumpResolution: value => writes.push(value), setPrimaryAnchorResolution: value => writes.push(value),
    setHistoryLoadError: value => errors.push(value), historyDiag() {}, AbortController,
    readHistoryPrimaryPanelAddress, displayEntries: poison, displayEntryIndexByUuid: poison,
    initialReadingAnchor: { uuid: identity, followBottom: false }, primaryInitialMountedRef: ref(''),
    primaryInitialMountKey: 'mount', primaryInitialMountKeyRef: ref('mount'),
  };
  return { ...r, env, writes, errors, store, identity };
}

test('actual initial UUID effect waits for a header and resolves exact tool/source identity without N metadata', async () => {
  const r = initialRig(), node = effect('setPrimaryJumpResolution({ ...result');
  r.root.header = null;
  assert.equal(evaluate(node, r.env)(), undefined);
  assert.equal(r.requests.length, 0); assert.equal(r.writes.length, 0);
  r.root.header = { leaseId: 'L2' };
  const cleanup = evaluate(node, r.env)();
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].identity, r.identity);
  assert.equal(r.requests[0].tool, r.env.historyScrollToolTarget);
  const address = { index: 7890, entryUuid: 'chosen', uuid: 'chosen', physicalKey: 'entry:chosen' };
  r.requests[0].resolve(address); await tick();
  assert.equal(r.writes.length, 1); assert.equal(r.writes[0].address, address);
  assert.equal(r.writes[0].request, 6); cleanup();
});
test('actual initial callbacks reject late owner/request/cut changes, abort and UNKNOWN without miss fallback', async () => {
  const node = effect('setPrimaryJumpResolution({ ...result');
  for (const mutate of [r => r.env.historyOwnerGenerationRef.current++, r => r.store.historyScrollRequestGeneration++,
    r => { r.root.header = { leaseId: 'new' }; }, r => { r.env.primaryInputsCurrent = () => false; }]) {
    const r = initialRig(); let current = true;
    // A mutable guard, like the Panel's ref-reading callback.
    r.env.primaryInputsCurrent = () => current;
    const cleanup = evaluate(node, r.env)();
    if (String(mutate).includes('primaryInputsCurrent')) current = false; else mutate(r);
    r.requests[0].resolve({ index: 1 }); await tick();
    assert.equal(r.writes.length, 0); assert.equal(r.errors.length, 0); cleanup();
  }
  const r = initialRig(), cleanup = evaluate(node, r.env)();
  r.requests[0].reject(Object.assign(Error('remote outcome UNKNOWN'), { code: 'UNKNOWN' })); await tick();
  assert.deepEqual(r.errors, ['UNKNOWN']); assert.equal(r.writes.length, 0); cleanup();
  const cancelled = initialRig(), stop = evaluate(node, cancelled.env)(); stop();
  assert.equal(cancelled.requests[0].options.signal.aborted, true);
  cancelled.requests[0].resolve(null); await tick(); assert.equal(cancelled.writes.length, 0);
});
test('actual initial anchor effect owns the physical mount and preserves proved absence separately from pending', async () => {
  const r = initialRig(true), node = effect('setPrimaryAnchorResolution({ ...result');
  r.env.initialReadingAnchor.uuid = ' \tcanonical\u0000\ud800😀\n ';
  const cleanup = evaluate(node, r.env)();
  assert.equal(r.requests.length, 1); assert.equal(r.writes.length, 0);
  assert.equal(r.requests[0].method, 'uuid'); assert.equal(r.requests[0].identity, ' \tcanonical\u0000\ud800😀\n ');
  r.requests[0].resolve(null); await tick();
  assert.equal(r.writes[0].address, null); assert.equal(r.writes[0].mount, 'mount'); cleanup();
  const moved = initialRig(true); const stop = evaluate(node, moved.env)();
  moved.env.primaryInitialMountKeyRef.current = 'other';
  moved.requests[0].resolve({ index: 20 }); await tick(); assert.equal(moved.writes.length, 0); stop();
  const mounted = initialRig(true); mounted.env.primaryInitialMountedRef.current = 'mount';
  evaluate(node, mounted.env)(); assert.equal(mounted.requests.length, 0);
});

function navigationRig(address) {
  const r = rootRig(), store = { historyScrollRequestGeneration: 7 }, frames = [], scrolls = [], events = [], consumed = [], expanded = [];
  const env = {
    historyScrollToUuid: 'source-exact', surfaceLoading: false, primaryPhysicalCandidate: true,
    primaryHeader: r.root.header, primaryRoot: r.root, primaryJumpReady: true, primaryInputsCurrent: () => true,
    primaryRootRef: ref(r.root), historyScrollToolTarget: null, useUIStore: { getState: () => store },
    setHistoryScrollToUuid: value => consumed.push(value), toolType: 'codex', sessionId: 'S',
    primaryJumpResolution: { address }, setExpandedGroupKeys: fn => expanded.push(fn(new Set())),
    displayEntries: poison, displayEntryIndexByUuid: poison, displayEntryIndexByUuidRef: ref(poison), entriesRef: ref(poison),
    resolveHistoryToolNavigationTarget() { throw Error('legacy target scan'); }, expandGroupForUuid() { throw Error('legacy group scan'); },
    historyDiag() {}, tabId: 'tab', panelDiagContextRef: ref(''),
    window: { dispatchEvent: event => events.push(event) }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    scrollGenRef: ref(0), sourceCallFlashRef: ref(null), performance: { now: () => 100 },
    historyScrollInFlightRef: ref(null), historyUserGestureGenerationRef: ref(3), historyOwnerKeyRef: ref('owner'),
    virtuosoScrollerRef: ref(null), visibleRangeRef: ref({ start: 0, end: 0 }), pendingInitialHistoryIndex: address?.index ?? -1,
    HISTORY_SCROLL_PIXEL_CAP_WARN_PX: 16000000, scrollMountedRef: ref(true), historyJumpHydrationActiveRef: ref(false),
    historyScrollSeekController: { stampMachineScrollCooldown() {} }, lastProgrammaticHistoryScrollRef: ref(null),
    setFlashUuid() {}, setTimeout() {}, requestAnimationFrame: fn => frames.push(fn),
    readHistoryPrimaryPanelAddress, JUMP_STUB_HYDRATION_WAIT_MS: 12000,
    setHistoryLoadError() {}, historyPresentationProofRef: ref({ presented: true }),
    virtuosoRef: ref({ scrollToIndex: value => scrolls.push(value) }), hydrationLastResultRef: ref(null),
    requestHistoryHydrationAt() { throw Error('second primary body demand'); }, CSS: { escape: value => value },
  };
  r.root.hasEntry = () => false;
  return { ...r, env, store, frames, scrolls, events, consumed, expanded };
}
test('actual UUID jump expands the directly resolved group, and only proved absence consumes a miss', () => {
  const node = effect('const navigationRoot = primaryPhysicalCandidate');
  const r = navigationRig({ index: 77, uuid: 'member', groupKey: 'g:\u0000\ud800', kind: 'group', expanded: false });
  evaluate(node, r.env)();
  assert.deepEqual([...r.expanded[0]], ['g:\u0000\ud800']); assert.deepEqual(r.consumed, []); assert.equal(r.frames.length, 0);
  const absent = navigationRig(null); evaluate(node, absent.env)();
  assert.deepEqual(absent.consumed, [null]); assert.equal(absent.events[0].detail.found, false);
  assert.equal(absent.events[0].detail.reason, 'identity-not-in-display');
});
test('actual UUID convergence writes the root rank and cancels a moved gesture after an awaited reproof', async () => {
  const node = effect('const navigationRoot = primaryPhysicalCandidate');
  const r = navigationRig({ index: 8111, uuid: 'exact', kind: 'entry' });
  evaluate(node, r.env)(); assert.equal(r.frames.length, 1);
  await r.frames.shift()(); assert.equal(r.scrolls[0].index, 8111);
  assert.equal(r.requests.length, 0); assert.equal(r.frames.length, 1);
  r.scrolls.length = 0; r.root.header = { leaseId: 'L2' };
  const pending = r.frames.shift()(); await tick(); assert.equal(r.requests.length, 1);
  r.env.historyUserGestureGenerationRef.current++;
  r.requests[0].resolve({ index: 1, uuid: 'exact', kind: 'entry' }); await pending;
  assert.deepEqual(r.scrolls, [], 'a resolved read capability cannot overwrite the newer gesture');
});

test('actual plain UUID loop yields immediately to a newer unresolved request, including after an awaited cut read', async () => {
  const node = effect('const navigationRoot = primaryPhysicalCandidate');
  for (const duringAwait of [false, true]) {
    const r = navigationRig({ index: 8111, uuid: 'A', kind: 'entry' });
    evaluate(node, r.env)();
    if (duringAwait) r.root.header = { leaseId: 'new' };
    else r.store.historyScrollRequestGeneration++;
    const pending = r.frames.shift()();
    if (duringAwait) {
      await tick(); assert.equal(r.requests.length, 1);
      r.store.historyScrollRequestGeneration++;
      r.requests[0].resolve({ index: 8122, uuid: 'A', kind: 'entry' });
    }
    await pending;
    assert.deepEqual(r.scrolls, []); assert.equal(r.frames.length, 0);
    assert.equal(r.env.historyScrollInFlightRef.current, null, 'cancelled A releases its flight');
    assert.equal(r.env.historyJumpHydrationActiveRef.current, false, 'cancelled A releases hydration');
    assert.equal(r.events.at(-1).detail.reason, 'source-jump-cancelled');
    assert.equal(r.env.historyUserGestureGenerationRef.current, 3,
      'the external request supersedes without a History wheel gesture');
  }
});

test('successful late address continuation finalizes only its cancelled generation', async () => {
  for (const startedB of [false, true]) {
    const r = navigationRig({ index: 8111, uuid: 'A', kind: 'entry' }), late = deferred();
    // Isolate the success continuation from the helper's earlier cancellation
    // check; a new request can arrive between promise reactions.
    r.env.readHistoryPrimaryPanelAddress = () => late.promise;
    evaluate(effect('const navigationRoot = primaryPhysicalCandidate'), r.env)();
    await r.frames.shift()();r.root.header = { leaseId: 'new' };
    const pending = r.frames.shift()();await tick();
    r.store.historyScrollRequestGeneration++;
    const next = { uuid: 'B', gen: r.env.scrollGenRef.current + 1 };
    if (startedB) {
      r.env.scrollGenRef.current = next.gen;
      r.env.historyScrollInFlightRef.current = next;
    }
    late.resolve({ header: r.root.header, address: { index: 8122, uuid: 'A' } });await pending;
    assert.equal(r.env.historyScrollInFlightRef.current, startedB ? next : null);
    assert.equal(r.env.historyJumpHydrationActiveRef.current, startedB);
    assert.equal(r.events.length, startedB ? 0 : 1);
    assert.equal(r.frames.length, 0);
  }
});

test('awaited cancelled A cannot finish or clear a newer started B', async () => {
  const r = navigationRig({ index: 8111, uuid: 'A', kind: 'entry' });
  evaluate(effect('const navigationRoot = primaryPhysicalCandidate'), r.env)();
  await r.frames.shift()();
  r.root.header = { leaseId: 'new' };
  const pending = r.frames.shift()(); await tick();
  r.store.historyScrollRequestGeneration++;
  const next = { uuid: 'B', gen: ++r.env.scrollGenRef.current };
  r.env.historyScrollInFlightRef.current = next;
  r.env.historyJumpHydrationActiveRef.current = true;
  r.requests[0].resolve({ index: 8122, uuid: 'A' }); await pending;
  assert.equal(r.env.historyScrollInFlightRef.current, next);
  assert.equal(r.env.historyJumpHydrationActiveRef.current, true);
  assert.equal(r.events.length, 0);
});

test('actual collapsed-group callback resolves the post-collapse cut and guards every later position write', async () => {
  const node = effect('const pending = pendingPrimaryGroupCollapseRef.current;');
  for (const move of [false, true]) {
    const r = rootRig(), frames = [], writes = [];
    const scroller = { isConnected: true, scrollTop: 0, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0 }) };
    const pending = { root: r.root, groupKey: 'group-key', scroller, owner: 'owner', generation: 2, gesture: 3, visit: 4 };
    const env = { pendingPrimaryGroupCollapseRef: ref(pending), expandedGroupKeys: new Set(), primaryInputsCurrent: () => true,
      primaryRootRef: ref(r.root), historyOwnerKeyRef: ref('owner'), historyOwnerGenerationRef: ref(2), historyUserGestureGenerationRef: ref(3),
      historyPresentationProofRef: ref({}), historyPresentationOwnsWrite: () => true,
      readHistoryPrimaryPanelAddress, AbortController, virtuosoRef: ref({ scrollToIndex: value => writes.push(value) }),
      requestAnimationFrame: fn => frames.push(fn), setHistoryLoadError() {}, displayUnits: poison };
    const cleanup = evaluate(node, env)(); assert.equal(r.requests[0].identity, 'group-key');
    if (move) env.historyOwnerGenerationRef.current++;
    r.requests[0].resolve({ index: 711 }); await tick();
    if (move) assert.equal(writes.length, 0);
    else { assert.equal(writes[0].index, 711); env.historyUserGestureGenerationRef.current++; frames.shift()(); assert.equal(writes.length, 1); }
    cleanup();
  }
});

test('current input witness detects same-reference authoring mutation and late ownership without walking compatibility arrays', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { require };
  try {
  const settings = new Proxy([], { get() { throw Error('historical settings scan'); } });
  const entries = poison, live = { ownerKey: 'owner', entries: [] },
    results = { ownerKey: 'owner', results: new Map([['tool', { text: 'answer' }]]) }, rewind = {}, root = { header: {}, closed: false };
  const presentation = { localEntries: [{ uuid: 'local', content: 'before' }], liveEntries: [],
    liveToolResults: results.results, rewindPreview: null,
    grouping: { enabled: true, threshold: 2, expandedKeys: [] }, captionSelections: [], settingsPresentationKeys: settings };
  const current = { root, header: root.header, ownerKey: 'owner', entries, live, results, rewind, presentation, suppressions: new Map(), captions: new Map() };
  const fingerprint = historyPrimaryPanelInputFingerprint(presentation, current.suppressions, current.captions, historyPrimaryToolClaimFingerprint);
  const witness = captureHistoryPrimaryPanelWitness({ ...current, fingerprint });
  assert.equal(historyPrimaryPanelWitnessCurrent(witness, current, historyPrimaryToolClaimFingerprint), true);
  presentation.localEntries[0].content = 'new\u0000\ud800';
  assert.equal(historyPrimaryPanelWitnessCurrent(witness, current, historyPrimaryToolClaimFingerprint), false);
  presentation.localEntries[0].content = 'before'; current.live = {};
  assert.equal(historyPrimaryPanelWitnessCurrent(witness, current, historyPrimaryToolClaimFingerprint), false);
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});

test('actual tool-coverage working-copy publication preserves equal input proof but current in-place changes revoke it', async () => {
  const previousWindow = globalThis.window; globalThis.window = { require };
  try {
    const root = { header: {}, closed: false }, input = { ownerKey: 'owner', results: new Map([['T', { result: 'before' }]]) };
    const resultRef = ref(input), result = deferred(); let calls = 0;
    root.reconcileCommittedToolResults = () => { calls++; return result.promise; };
    const presentation = { localEntries: [], liveEntries: [], liveToolResults: input.results,
      rewindPreview: null, grouping: { enabled: true, threshold: 2, expandedKeys: [] }, captionSelections: [], settingsPresentationKeys: [] };
    const current = { root, header: root.header, ownerKey: 'owner', entries: [], live: { ownerKey: 'owner', entries: [] },
      results: input, rewind: undefined, presentation, suppressions: new Map(), captions: new Map() };
    const witness = captureHistoryPrimaryPanelWitness({ ...current,
      fingerprint: historyPrimaryPanelInputFingerprint(presentation, current.suppressions, current.captions, historyPrimaryToolClaimFingerprint) });
    const env = { primaryRootRef: ref(root), primaryToolCoverageCutAtRender: root.header, historyOwnerKey: 'owner',
      historyOwnerGenerationRef: ref(5), primaryRequestVersionRef: ref(7), liveToolResultsRef: resultRef,
      historyOwnerKeyRef: ref('owner'), presentedOwnerKey: 'owner', primaryToolCoverageSettledRef: ref(null),
      liveToolResults: input.results, AbortController, setLiveToolResults() {}, tabId: 'tab' };
    const stop = evaluate(layoutEffect('let currentMap = new Map(inputMap);'), env)();
    assert.equal(calls, 1); assert.notEqual(resultRef.current, input); assert.notEqual(resultRef.current.results, input.results);
    current.results = resultRef.current;
    assert.equal(historyPrimaryPanelWitnessCurrent(witness, current, historyPrimaryToolClaimFingerprint), true,
      'equivalent retirement working Map is not a new presentation');
    current.results.results.get('T').result = 'new\u0000\ud800😀';
    assert.equal(historyPrimaryPanelWitnessCurrent(witness, current, historyPrimaryToolClaimFingerprint), false,
      'same-reference record edit must not borrow the old body proof');
    current.results.results.get('T').result = 'before';
    current.results = { ownerKey: 'owner', results: new Map([['new', { result: 'newer-than-React' }]]) };
    assert.equal(historyPrimaryPanelWitnessCurrent(witness, current, historyPrimaryToolClaimFingerprint), false,
      'an imperative result publication newer than primaryPresentation is detected immediately');
    result.resolve(); await tick(); assert.equal(resultRef.current, input); stop();
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});

test('actual Panel releases stale local composition before Surface mount, including empty and pending initial position', () => {
  const outcomes = [], root = { header: {}, finishPresentation: value => outcomes.push(value) };
  const env = { primaryPhysicalCandidate: true, primaryRootRef: ref(root), primaryRoot: root, primaryHeader: root.header,
    primaryInputsCurrent: () => false };
  const node = layoutEffect("reason: 'panel-composition-moved'");
  evaluate(node, env)();
  assert.deepEqual(outcomes, [{ status: 'superseded', requiredClass: 'semantic', reason: 'panel-composition-moved' }]);
  outcomes.length = 0; root.header = {};
  evaluate(node, env)(); assert.deepEqual(outcomes, [], 'stale render cannot supersede a newer adopted header');
  env.primaryHeader = root.header; env.primaryInputsCurrent = () => true;
  evaluate(node, env)(); assert.deepEqual(outcomes, [], 'an equal current composition is left to its actual Surface/empty commit');
  assert.match(source, /window\.requiredClass === 'semantic' \|\| window\.requiredClass === 'source' \? window\.requiredClass/);
});

test('actual caption callback wakes view composition even for a fully readable selected caption', () => {
  const captions = new Map(); let revisions = 0, commits = 0;
  const env = { historyOwnerKeyRef: ref('owner'), historyOwnerKey: 'owner', historyPresentationProofRef: ref({ presented: true }),
    groupCaptionSelectionsRef: ref(captions), rememberHistoryGroupCaption: (map, key, value) => map.set(key, value),
    historyGroupCaptionIdentity: entry => entry.uuid, applyHistoryRevealUpdate: (_anchor, _opening, commit) => commit(),
    uiPerformancePhase() {}, historyDiag() {}, tabId: 'tab', primaryRootRef: ref({}),
    setPrimaryCaptionRevision: fn => { revisions = fn(revisions); }, requestHistoryHydrationAt() { throw Error('legacy hydration'); } };
  evaluate(callback('cycleHistoryGroupCaption'), env)('G', { uuid: 'next', captionTextComplete: true }, { uuid: 'previous' }, null, () => commits++);
  assert.equal(captions.get('G'), 'next'); assert.equal(commits, 1); assert.equal(revisions, 1);
});

test('mounted-search caller resolves only exact admitted mounted subjects, including collapsed members and aliases', () => {
  const a = { uuid: 'A', sourceIdentity: 'source-A' }, b = { uuid: 'B', sourceIdentity: 'source-B' };
  const units = new Map([[8, { kind: 'entry', entry: a }], [20, { kind: 'group', entries: [b] }]]);
  const addresses = new Map([[8, { physicalKey: 'entry:A' }], [20, { physicalKey: 'group:G' }]]);
  const row = (uuid, index, key, owner = 'dom-owner') => ({ dataset: { uuid, historyRowOwner: owner },
    closest: () => ({ getAttribute: () => String(index) }), getAttribute: () => key });
  const rows = [row('A', 8, 'entry:A'), row('B', 20, 'group:G'), row('A', 8, 'entry:A'),
    row('C', 42, 'entry:C'), row('B', 20, 'group:old'), row('A', 8, 'entry:A', 'other')];
  const root = { header: {}, closed: false, renderSnapshot: () => ({ window: units }),
    addressAt: rank => addresses.get(rank), matchesSnapshotUnit: (_snapshot, rank, unit) => units.get(rank) === unit };
  const result = collectHistoryPrimaryMountedSearchSubjects({ querySelectorAll: () => rows }, 'dom-owner', root,
    entry => [entry.uuid, entry.sourceIdentity]);
  assert.deepEqual([...result.subjects], [['A', ['A', 'source-A']], ['B', ['B', 'source-B']]]);
  assert.deepEqual([...result.keys], ['A', 'source-A', 'B', 'source-B']);
  root.matchesSnapshotUnit = () => false;
  assert.equal(collectHistoryPrimaryMountedSearchSubjects({ querySelectorAll: () => rows }, 'dom-owner', root, () => []).keys.size, 0);
  const mountedEffect = text(effect('const client: HistoryPagedSearchClient | undefined = searchResult?.searchClient;'));
  assert.match(mountedEffect, /primaryInputsCurrent\(\)[\s\S]*collectHistoryPrimaryMountedSearchSubjects/);
  assert.match(mountedEffect, /else for \(const row/); // legacy map lives only in the non-root branch
});

test('actual search page callback preserves source constraints, resolves serially and skips only proved ambiguity', async () => {
  const r = rootRig(), writes = [], errors = [];
  const node = effect('setPrimarySearchPositions({ root, header, searchResult, positions })');
  const matches = [{ entryUuid: 'raw-1', sourceIdentity: 'exact-source-1', physicalSessionId: 'P',
    entryRef: { physicalSessionId: 'P', segmentId: 'segment', rawUuid: 'raw-1' }, matchIndex: 0 },
  { entryUuid: 'same-raw', sourceIdentity: 'ambiguous-source', physicalSessionId: 'P', matchIndex: 1 }];
  const env = { primaryPhysicalCandidate: true, primaryRoot: r.root, primaryRootRef: ref(r.root),
    primaryInputsCurrent: () => true, historyOwnerKey: 'owner', historyOwnerKeyRef: ref('owner'),
    historyOwnerGenerationRef: ref(5), searchResult: { matches }, AbortController,
    sessionId: 'S', toolType: 'codex', readHistoryPrimaryPanelAddress,
    setPrimarySearchPositions: value => writes.push(value), setSearchError: value => errors.push(value), historyDiag() {},
    displayEntries: poison, displayEntryIndexByUuid: poison };
  const cleanup = evaluate(node, env)();
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].identity, 'exact-source-1');
  assert.deepEqual(r.requests[0].tool.messageReference, { provider: 'codex', sessionId: 'S',
    physicalSessionId: 'P', transcriptSegmentId: 'segment', rawUuid: 'raw-1' });
  r.requests[0].resolve({ index: 8999, entryUuid: 'resolved-alias' }); await tick();
  assert.equal(r.requests.length, 2); assert.equal(writes.length, 0);
  r.requests[1].resolve(null); await tick();
  assert.equal(writes[0].positions.length, 1); assert.equal(writes[0].positions[0].entryIdx, 8999);
  assert.equal(writes[0].positions[0].entryUuid, 'resolved-alias'); assert.deepEqual(errors, []); cleanup();
});

test('actual central paint callback refuses stale DOM without exact measured root coverage and current inputs', () => {
  const node = callback('consumeHistoryViewportPaintProof'); let input = true, covered = false, resolverCalls = 0;
  const root = { totalCount: 10, hasCurrentPresentationCoverage: () => covered };
  const env = { historyResizeRef: ref(null), primaryPhysicalCandidate: true, primaryRootRef: ref(root), primaryInputsCurrent: () => input,
    historyOwnerKeyRef: ref('owner'), historyOwnerGenerationRef: ref(1), historyPresentationProofRef: ref({}), viewportReadyOwnerKeyRef: ref(''),
    resolveHistoryViewportPaintProof: () => { resolverCalls++; return { accepted: true, changed: false }; } };
  const consume = evaluate(node, env), proof = { ownerKey: 'owner', generation: 1, presentationVisit: 1, proof: 'mounted-painted-row', domRows: 1 };
  assert.equal(consume(proof), false); assert.equal(resolverCalls, 0);
  covered = true; input = false; assert.equal(consume(proof), false); assert.equal(resolverCalls, 0);
  input = true; assert.equal(consume(proof), true); assert.equal(resolverCalls, 1);
  assert.equal(consume({ ...proof, proof: 'painted-empty-state' }), false);
  root.totalCount = 0; assert.equal(consume(proof), false);
  assert.equal(consume({ ...proof, proof: 'painted-empty-state', domRows: 0 }), true);
});

test('actual shared restore loop awaits the position read, observes cancellation and never accepts UNKNOWN as success', async () => {
  const node = only(all.filter(node => node.type === 'FunctionDeclaration' && node.id.name === 'runHistoryScrollConvergence'));
  for (const result of ['cancel', 'unknown', 'absent']) {
    const frames = [], aborted = [], settled = [], read = deferred(); let cancelled = null;
    const run = evaluate(node, { performance: { now: () => 0 }, requestAnimationFrame: fn => frames.push(fn) });
    run({ measureDrift: () => null, jump: () => read.promise, cancelled: () => cancelled,
      onAborted: value => aborted.push(value), onSettled: value => settled.push(value) });
    const pending = frames.shift()(); assert.equal(frames.length, 0, 'pending Promise is not a successful jump');
    if (result === 'cancel') { cancelled = 'gesture'; read.resolve(true); }
    else if (result === 'unknown') read.reject(Object.assign(Error('UNKNOWN'), { code: 'UNKNOWN' }));
    else read.resolve(false);
    await pending;
    assert.equal(settled.length, 0); assert.equal(frames.length, 0);
    assert.equal(aborted[0].reason, result === 'cancel' ? 'gesture' : result === 'unknown' ? 'UNKNOWN' : 'target-lost');
  }
});

test('actual JSX and key callback wire synchronous admission/current inputs, pending first mount and bounded addresses', () => {
  const surface = only(all.filter(node => node.type === 'JSXOpeningElement' && node.name.name === 'HistoryPrimaryRootSurface'));
  const attributes = new Map(surface.attributes.filter(node => node.type === 'JSXAttribute').map(node => [node.name.name, text(node)]));
  assert.equal(attributes.get('inputsCurrent'), 'inputsCurrent={primaryInputsCurrent}');
  assert.equal(attributes.get('inputTransaction'), 'inputTransaction={primaryInputTransaction.run}');
  assert.match(attributes.get('unitMatches'), /primaryRoot\.addressAt\(index\)\?\.physicalKey/);
  const matcher = surface.attributes.find(node => node.type === 'JSXAttribute' && node.name.name === 'unitMatches').value.expression;
  assert.equal(evaluate(matcher, { primaryRoot: { addressAt: () => ({ physicalKey: '42' }) },
    primaryInputsCurrent: () => true, historyVirtuosoUnitKey: () => 42, displayUnitsRef: ref(poison) })(9, {}), true,
    'physical key uses the same exact string conversion as React, including a numeric presentation override');
  assert.equal(attributes.get('computeItemKey'), 'computeItemKey={primaryRoot ? undefined : (_idx) => displayUnitItemKeys[_idx]}');
  const seek = evaluate(callback('seekUnitKeyAt'), { primaryPhysicalCandidate: true,
    primaryRootRef: ref({ addressAt: index => index === 9 ? { physicalKey: 'exact:\u0000\ud800😀' } : null }), displayUnitItemKeysRef: ref(poison) });
  assert.equal(seek(9), 'exact:\u0000\ud800😀'); assert.equal(seek(10), '');
  assert.match(source, /surfaceLoading \|\| primaryHeaderPending \|\| primaryInitialPositionPending \|\|/);
  assert.match(source, /const primaryHeaderPending = primaryPhysicalCandidate && !primaryHeader/);
  assert.match(source, /const primaryPhysicalCandidate = primaryRootReadEnabled && toolType === 'codex' && !!sessionId/);
  assert.match(source, /primaryInitialMountedRef\.current !== primaryInitialMountKey[\s\S]*historyScrollToUuid \? !primaryJumpReady/);
  assert.match(text(callback('publishHistorySurfacePresented')), /consumeHistoryViewportPaintProof/);
});

test('actual physical-candidate/render branch preserves unbound UI and keeps bound UNKNOWN out of legacy Surface', () => {
  const value = name => only(all.filter(node => node.type === 'VariableDeclarator' && node.id.name === name)).init;
  const gate = only(all.filter(node => node.type === 'ConditionalExpression'
    && text(node.test).includes('primaryHeaderPending') && text(node.test).includes('ownerChangedBeforeLayoutHandoff'))).test;
  const env = { primaryRootReadEnabled: true, toolType: 'codex', sessionId: '', primaryCompositeOwnerRef: ref(''), historyOwnerKey: 'owner' };
  assert.equal(evaluate(value('primaryPhysicalCandidate'), env), false);
  env.sessionId = 'physical-session';
  const candidate = evaluate(value('primaryPhysicalCandidate'), env);
  assert.equal(candidate, true);
  const pending = evaluate(value('primaryHeaderPending'), { primaryPhysicalCandidate: candidate, primaryHeader: null });
  assert.equal(evaluate(gate, { surfaceLoading: false, primaryHeaderPending: pending, primaryInitialPositionPending: false,
    ownerChangedBeforeLayoutHandoff: false, retainedRewriteMount: null, historyOwnerVisit: 1 }), true,
    'a failed/UNKNOWN initial read with loading=false remains in the explicit pending/error branch');
  assert.equal(evaluate(gate, { surfaceLoading: false, primaryHeaderPending: false, primaryInitialPositionPending: false,
    ownerChangedBeforeLayoutHandoff: false, retainedRewriteMount: null, historyOwnerVisit: 1 }), false,
    'no-session follows the existing authoring/empty UI instead of waiting for an impossible root header');
  env.primaryCompositeOwnerRef.current = 'owner';
  assert.equal(evaluate(value('primaryPhysicalCandidate'), env), false, 'explicit legacy-composite capability keeps its existing route');
});

test('address callbacks add no IPC mutation authority; all existing direct Panel IPC arguments remain exact CURRENT', () => {
  const isIpc = node => node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
    && node.callee.object?.name === 'ipcRenderer' && ['invoke', 'send'].includes(node.callee.property?.name);
  const calls = all.filter(isIpc);
  // Baseline: full CURRENT Panel e660798cfb87da3781faa2a4a59e6d85f9d0795eb4141eb0dab4c23c417b33b2.
  // The 38 expressions include terminal input, cancel/send/recovery identities,
  // receipt acknowledgement and existing read calls, in original source order.
  assert.equal(calls.length, 38);
  assert.equal(createHash('sha256').update(JSON.stringify(calls.map(text))).digest('hex'),
    'ba729832db48193c29f2378ec34fc40589eb223582d7eee54305438e15296433');
  const controls = only(all.filter(node => node.type === 'FunctionDeclaration' && node.id.name === 'AgentHistoryControls'));
  assert.equal(createHash('sha256').update(text(controls)).digest('hex'),
    '470e5f84e82bbd2f56e57e7b9b3afae380688cf22ab2cf55f0d44e997cd5c4eb');
  const mutations = all.filter(node => node.type === 'CallExpression'
    && ['executeHistoryRewriteRewindScenario', 'executeHistoryDeleteIterationScenario'].includes(node.callee.name));
  assert.equal(mutations.length, 2);
  assert.equal(createHash('sha256').update(JSON.stringify(mutations.map(text))).digest('hex'),
    '22021b9f59ea8986805e58948ebcf06b3c372f9afc1c19187507ac4a1ed708a7');
  const boundaries = [effect('setPrimaryJumpResolution({ ...result'), effect('setPrimaryAnchorResolution({ ...result'),
    effect('const navigationRoot = primaryPhysicalCandidate'), effect('const pending = pendingPrimaryGroupCollapseRef.current;'),
    effect('setPrimarySearchPositions({ root, header, searchResult, positions })')];
  for (const boundary of boundaries) assert.equal(calls.filter(node => node.start >= boundary.start && node.end <= boundary.end).length, 0);
});
