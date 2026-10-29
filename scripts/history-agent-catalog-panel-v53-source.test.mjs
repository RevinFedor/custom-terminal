// Bounded actual TSX component/hook/callback frames. TypeScript5.9.3 compiles
// ONLY named source fragments; React hooks/elements, events and IPC are finite
// in-process frames. This is neither a whole-Panel AST nor Electron/DOM paint,
// real transcript/provider access, native latency, or Send/Stop/Input coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { agentRow, taskAction, catalogScope, fullNativeFixture } from './test-support/history-agent-catalog-fixtures.mjs';
import { isHistoryTaskChipLive } from '../src/renderer/utils/historyBackgroundLiveness.mjs';
import { isHistoryBackgroundTaskLive } from '../src/renderer/utils/historyProcessLiveness.mjs';
import { buildHistoryLivePresentation, reduceHistoryLiveProjection } from '../src/renderer/utils/historyLiveProjection.mjs';
import { createHistoryAgentCatalogCurrent } from '../src/renderer/utils/historyAgentCatalogCurrent.mjs';
import { historyPrimaryPromptAdoptionFingerprint } from '../src/renderer/utils/historyPrimaryPromptAdoption.mjs';
import { createHistoryPrimaryAgentCatalogOwner } from '../src/renderer/utils/historyPrimaryAgentCatalogOwner.mjs';
const require = createRequire(import.meta.url), ts = require(process.env.NOTED_TYPESCRIPT_PATH || 'typescript');
globalThis.window = { require };
assert.equal(ts.version, '5.9.3');
assert(getHeapStatistics().heap_size_limit <= 80 * 1024 ** 2, 'runtime64/2 source frame cap');
const { createHistoryAgentCatalogOracle } = require('./test-support/history-agent-catalog-oracle.cjs');
const oracle = createHistoryAgentCatalogOracle({ isHistoryTaskChipLive, isHistoryBackgroundTaskLive });
const panel = readFileSync(new URL('../src/renderer/components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const transcript = readFileSync(new URL('../src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx', import.meta.url), 'utf8');
const windowSource = readFileSync(new URL('../src/renderer/components/Workspace/HistoryAgentCatalogWindow.tsx', import.meta.url), 'utf8');
const livenessSource = readFileSync(new URL('../src/renderer/components/Workspace/HistoryAgentCatalogLiveness.tsx', import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const selected = [];
function between(source, first, last, maximum) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert(start >= 0 && end > start && source.indexOf(first, start + first.length) === -1, 'unique actual source boundary: ' + first);
  const text = source.slice(start, end);
  assert(Buffer.byteLength(text) <= maximum, 'finite source fragment');
  selected.push({ first, bytes: Buffer.byteLength(text), sha256: sha(text) });
  return text;
}
const cardSource = between(panel, 'const SubAgentBlock = memo(', '// Compact block', 7000);
const dockSource = between(panel, 'const HistoryBackgroundTasksBar = memo(', 'const historyEntryDetailsText =', 12000);
const rosterSource = between(panel, 'const HistoryAgentRoster = memo(', 'const HistoryBackgroundTasksBar = memo(', 7000);
const detailSource = between(panel, 'const HistoryBackgroundDetailPane = memo(', 'const HistoryAgentRoster = memo(', 19000);
const stepsSource = between(panel, 'function useSubagentSteps(', '// One docked inspector', 11500);
const helpersSource = between(transcript, 'export function mergeHistoryTranscriptSteps(', 'const transcriptStepsToEntries =', 4500);
const selectionAndResetSource = between(panel,
  '  useEffect(() => {\n    if (!expandedBackgroundChipKey || !chipsOwnerSettled) return;',
  '  const openHistoryAgent = useCallback(', 7000);
const resetStart = selectionAndResetSource.indexOf('  useEffect(() => {', 3);
assert(resetStart > 0, 'actual distinct owner-reset effect follows missing cleanup');
const selectionSource = selectionAndResetSource.slice(0, resetStart);
const ownerResetSource = selectionAndResetSource.slice(resetStart);
const eventsSource = between(panel, '  const openHistoryAgent = useCallback(', '  // Empty publications can themselves', 4500);
const currentFaceSource = between(panel, '  const primaryAgentCurrentFace = (',
  '  const primaryAgentCatalogCurrentSnapshot =', 5000);
const dockPublicationSource = between(panel, '  const requestAgentCatalogPage = useCallback(',
  '  useLayoutEffect(() => {\n    // One already selected native record', 4500);
const selectedCurrentCaptureSource = between(panel, '  useLayoutEffect(() => {\n    // One already selected native record',
  '  const primaryAgentCurrentChipsAtPublish =', 3000);
const liveCountsSource = between(panel, '  const primaryAgentCurrentChipsAtPublish =', '  useEffect(() => {', 2500);
const liveMembershipSource = between(panel, '  const primaryAgentLiveness = useMemo(', '  const availableDetailKeys = useMemo(', 1000);
const liveSource = between(panel, '  const backgroundHistoryChips = useMemo(', '  const historyAgentChips = useMemo(', 2200);
const dataCommitSource = between(panel, '  useLayoutEffect(() => {\n    primaryPresentationDataCommitRef.current = null;',
  '  useLayoutEffect(() => {\n    if (!primaryPhysicalCandidate) return;\n    const input = primaryAgentCatalogInputs;', 2500);
const admissionSource = between(panel,
  '  useLayoutEffect(() => {\n    if (!primaryPhysicalCandidate) return;\n    const input = primaryAgentCatalogInputs;',
  '  // `transcriptEntries` already committed', 4500);
function compile(source, names, { esm = false } = {}) {
  const input = esm ? source.replace(/^import[^;]+;\s*/gm, '')
    .replace(/^export\s+type\s+\{[^}]*\}\s+from\s+[^;]+;\s*/gm, '').replace(/\bexport\s+/g, '') : source;
  const result = ts.transpileModule(input, { fileName: 'v53-frame.tsx', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } });
  assert.deepEqual(result.diagnostics, []);
  return new Function('env', 'with(env){\n' + result.outputText + '\nreturn {' + names.join(',') + '};\n}');
}
const installCard = compile(cardSource, ['SubAgentBlock']);
const installDock = compile(dockSource, ['HistoryBackgroundTasksBar']);
const installRoster = compile(rosterSource, ['HistoryAgentRoster']);
const installDetail = compile(detailSource, ['HistoryBackgroundDetailPane']);
const installSteps = compile(stepsSource, ['useSubagentSteps']);
const installHelpers = compile(helpersSource, ['mergeHistoryTranscriptSteps', 'historyTurnsToTranscriptSteps'], { esm: true });
const installSelection = compile(selectionSource, []);
const installOwnerReset = compile(ownerResetSource, []);
const installEvents = compile(eventsSource, ['openHistoryAgent', 'toggleHistoryDetail', 'agentInspectorController']);
const installLive = compile(liveSource, ['backgroundHistoryChips']);
const installLiveCounts = compile(liveCountsSource, ['backgroundAgentChipCount', 'backgroundChipCount']);
const installLiveMembership = compile(liveMembershipSource, ['primaryAgentLiveness']);
const installCurrentFace = compile(currentFaceSource, ['primaryAgentCurrentFace']);
const installDockPublication = compile(dockPublicationSource, ['primaryAgentCatalogDock']);
const installSelectedCurrentCapture = compile(selectedCurrentCaptureSource, []);
const installDataCommit = compile(dataCommitSource, []);
const installAdmission = compile(admissionSource, []);
const installWindow = compile(windowSource, ['HistoryAgentCatalogWindow', 'historyAgentCatalogSections', 'historyAgentCatalogViewportDemand'], { esm: true });
const installLiveness = compile(livenessSource, ['createHistoryAgentCatalogMembershipDemand', 'HistoryAgentCatalogLivenessContext',
  'useHistoryAgentCatalogMember', 'useHistoryAgentCatalogGroupLive'], { esm: true });
console.log('V53_ACTUAL_PANEL_FRAMES ' + JSON.stringify({ panelBytes: Buffer.byteLength(panel), panelSHA256: sha(panel),
  fragments: selected, windowSHA256: sha(windowSource), livenessSHA256: sha(livenessSource), typescript: ts.version,
  node: process.version, heapLimit: getHeapStatistics().heap_size_limit,
  scope: 'bounded actual TSX/hook/callback frames; synthetic React elements/refs/events/IPC; no DOM/native acceptance' }));

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
function frame(extra = {}) {
  const slots = [], pending = [], intervals = new Map(), timers = new Map(), listeners = new Map(), sends = [], invocations = [], copies = [];
  let cursor = 0, timerId = 0, context = null, reducerCalls = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const state = initial => { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; };
  const effect = (callback, deps) => { const index = cursor++, old = slots[index];
    if (!old || !same(old.deps, deps)) { slots[index] = { deps, cleanup: old?.cleanup }; pending.push({ index, callback }); } };
  const memo = (callback, deps) => { const index = cursor++, old = slots[index];
    if (!old || !same(old.deps, deps)) slots[index] = { deps, value: callback() }; return slots[index].value; };
  const env = {
    memo: value => value, useState: state, useEffect: effect, useLayoutEffect: effect,
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: initial } }; return slots[index].value; },
    useMemo: memo, useCallback: (value, deps) => memo(() => value, deps), useContext: () => context,
    React: { Fragment: Symbol('fragment'), createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
      createContext: value => ({ defaultValue: value }), useContext: () => context,
      useReducer(reducer, initial) { const [value, set] = state(initial); return [value, () => { reducerCalls++; set(reducer); }]; } },
    window: { innerHeight: 900, setInterval(fn, ms) { const id = ++timerId; intervals.set(id, { fn, ms }); return id; },
      clearInterval(id) { intervals.delete(id); }, setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
      clearTimeout(id) { timers.delete(id); }, getSelection() { return null; },
      addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
      removeEventListener(name, callback) { listeners.get(name)?.delete(callback); } },
    ipcRenderer: { async invoke(channel, payload) { invocations.push({ channel, payload }); return { success: true, steps: [], offset: 0 }; },
      send(channel, payload) { sends.push({ channel, payload }); } },
    requestAnimationFrame: callback => callback(), usePointerGesture: () => ({ start() {} }),
    formatBackgroundElapsed: value => String(value), formatSubagentDuration: value => String(value),
    historyAgentKey: oracle.historyAgentKey, historyRecordTimeAttributes: () => ({}),
    useHistoryAgentCatalogMember: (_kind, _value, fallback) => fallback,
    primaryAgentSelectionEpochRef: { current: 0 }, primaryAgentCurrentSelectedRef: { current: null },
    EMPTY_HISTORY_CHIPS: Object.freeze([]), EMPTY_HISTORY_AGENTS: Object.freeze([]),
    buildHistoryLivePresentation, collectHistoryBackgroundChips: oracle.collectHistoryBackgroundChips,
    collectHistoryAgentChips: oracle.collectHistoryAgentChips, historyPrimaryPromptAdoptionFingerprint,
    HistoryAgentInspectorContext: {}, historySubagentScrollMemory: new Map(),
    writeHistoryClipboardText(value) { copies.push(value); }, ResizeObserver: undefined,
    ...extra,
  };
  for (const match of (cardSource + dockSource + rosterSource + detailSource).matchAll(/<([A-Z][A-Za-z0-9]*)\b/g))
    if (!(match[1] in env)) env[match[1]] = function placeholder() {};
  Object.assign(env, installHelpers(env));
  const f = { env, slots, intervals, timers, listeners, sends, invocations, copies,
    render(fn, props) { cursor = 0; return fn(props); },
    effects() { for (const { index, callback } of pending.splice(0)) { slots[index].cleanup?.(); slots[index].cleanup = callback(); } },
    setContext(value) { context = value; }, get reducerCalls() { return reducerCalls; },
    emit(name, detail) { for (const callback of listeners.get(name) || []) callback({ detail }); },
    close() { for (const slot of slots) slot?.cleanup?.(); pending.length = 0; },
  };
  return f;
}
function nodes(tree, predicate = () => true) {
  const out = [], work = [tree];
  while (work.length) { const value = work.shift(); if (Array.isArray(value)) { work.unshift(...value); continue; }
    if (!value || typeof value !== 'object' || !value.props) continue;
    if (predicate(value)) out.push(value); work.push(value.props.children); }
  return out;
}
function one(tree, predicate) { const found = nodes(tree, predicate); assert.equal(found.length, 1); return found[0]; }
const chip = (key, extra = {}) => ({ key, kind: 'subagent', label: key, startedAt: 1, status: 'completed', entryUuid: 'row-' + key, ...extra });
const counts = { total: 1000, roster: 1000, running: 5, completed: 700, interrupted: 295, background: 100, backgroundAgents: 90 };
const poison = label => new Proxy([], { get(_target, key) { throw Error(label + ':' + String(key)); } });

test('actual primary dock and roster bypass historical native registry and retain same-owner UNKNOWN detail', () => {
  const f = frame(), selected = chip('task:distant'), requests = [], toggles = [];
  const catalog = { status: 'pending', counts, rows: [chip('task:page')], pageStart: 500,
    backgroundRows: [], backgroundStart: 0, backgroundPageSize: 32,
    selected: { kind: 'unknown', key: selected.key, record: selected }, requestPage: value => requests.push(value) };
  const { HistoryBackgroundTasksBar } = installDock(f.env), { HistoryAgentRoster } = installRoster(f.env);
  const props = { chips: [], agents: poison('PRIMARY_HISTORICAL_ROSTER_READ'), catalog, selectedKey: selected.key,
    rosterOpen: false, onToggleDetail: value => toggles.push(value), onToggleRoster() {}, onSelectAgent() {}, onJumpToCard() {},
    tabId: 'tab', toolType: 'codex', cwd: '/finite', sessionId: 'parent' };
  const tree = f.render(HistoryBackgroundTasksBar, props); f.effects();
  const detail = one(tree, value => value.type === f.env.HistoryBackgroundDetailPane);
  assert.equal(detail.props.chip, selected); detail.props.onClose(); assert.deepEqual(toggles, [selected.key]);
  assert.equal(f.intervals.size, 1, 'only old elapsed-label interval');
  for (const value of f.intervals.values()) { assert.equal(value.ms, 1000); value.fn(); }
  assert.equal(f.reducerCalls, 1); assert.deepEqual(requests, [], 'elapsed label never scans/rebuilds the historical catalog');
  const roster = f.render(HistoryAgentRoster, { agents: props.agents, catalog: { ...catalog, status: 'ready' }, selectedKey: selected.key, onSelect: value => toggles.push(value), onClose() {} });
  const window = one(roster, value => value.type === f.env.HistoryAgentCatalogWindow);
  assert.equal(window.props.counts, counts); assert.equal(window.props.rows, catalog.rows);
  const row = window.props.renderRow(selected); one(row, value => value.type === 'button').props.onClick();
  assert.equal(toggles.at(-1), selected.key);
  f.close(); assert.equal(f.intervals.size, 0);
});

test('actual legacy roster remains positive full-array control, and empty/pending dock are distinct', () => {
  const f = frame(), { HistoryAgentRoster } = installRoster(f.env), selected = [];
  const agents = [chip('task:running', { status: 'running' }), chip('task:done'), chip('task:interrupted', { status: 'interrupted' })];
  const tree = f.render(HistoryAgentRoster, { agents, catalog: null, selectedKey: null, onSelect: key => selected.push(key), onClose() {} });
  const rows = nodes(tree, value => value.type === 'button' && !value.props['aria-label']);
  assert.equal(rows.length, 3); rows.forEach(row => row.props.onClick());
  assert.deepEqual(selected, agents.map(value => value.key));
  assert.throws(() => f.render(HistoryAgentRoster, { agents: poison('LEGACY_POSITIVE_POISON'), catalog: null }), /LEGACY_POSITIVE_POISON/);
  f.close();
  const d = frame(), { HistoryBackgroundTasksBar } = installDock(d.env);
  const base = { chips: [], agents: [], selectedKey: null, rosterOpen: false,
    onToggleDetail() {}, onToggleRoster() {}, onSelectAgent() {}, onJumpToCard() {},
    tabId: 'tab', toolType: 'codex', cwd: '/finite', sessionId: 'parent' };
  const catalog = { status: 'pending', counts: null, rows: [], pageStart: 0, backgroundRows: [],
    backgroundStart: 0, backgroundPageSize: 32, selected: { kind: 'unknown', key: null, record: null }, requestPage() {} };
  assert(d.render(HistoryBackgroundTasksBar, { ...base, catalog }), 'UNKNOWN cannot render as genuine no-agent dock');
  const empty = { ...catalog, status: 'ready', counts: { total: 0, roster: 0, running: 0, completed: 0, interrupted: 0, background: 0 } };
  assert.equal(d.render(HistoryBackgroundTasksBar, { ...base, catalog: empty }), null, 'proved zero can hide the empty closed dock');
  d.effects(); d.close();
});

test('actual ordinary roster scroll requests distant completed/interrupted page with exact section counts', () => {
  const requests = [], observed = [], disconnected = [], f = frame({ ResizeObserver: class {
    constructor(callback) { this.callback = callback; } observe(value) { observed.push(value); } disconnect() { disconnected.push(this); }
  } });
  const { HistoryAgentCatalogWindow, historyAgentCatalogSections } = installWindow(f.env);
  const sections = historyAgentCatalogSections(counts);
  assert.deepEqual(sections.map(value => [value.section, value.count, value.offset]), [['running', 5, 0], ['completed', 700, 5], ['interrupted', 295, 705]]);
  const props = { counts, rows: Array.from({ length: 64 }, (_, index) => chip('task:' + index)), pageStart: 0, status: 'ready',
    onRequestPage: value => requests.push(value), renderRow: row => row.key };
  let tree = f.render(HistoryAgentCatalogWindow, props);
  const element = { scrollTop: 980 * 28 + 66, clientHeight: 280 };
  tree.props.ref.current = element; f.effects();
  assert.equal(requests.length, 1); assert.equal(requests[0].section, 'roster'); assert.equal(requests[0].limit, 64);
  assert(requests[0].offset >= 900, 'ordinary scroll reaches distant interrupted records');
  tree.props.onScroll(); assert.equal(requests.length, 1, 'unchanged demand coalesces');
  const offset = requests[0].offset;
  tree = f.render(HistoryAgentCatalogWindow, { ...props, rows: Array.from({ length: 1000 - offset }, (_, index) => chip('task:' + (offset + index))), pageStart: offset });
  f.effects();
  const painted = nodes(tree, value => value.props['data-history-agent-catalog-rank'] !== undefined);
  assert(painted.some(value => value.props['data-history-agent-catalog-rank'] === 999));
  assert(painted.length <= 64); assert.equal(requests.length, 1);
  const canvas = nodes(tree, value => value.props.style?.height === 1000 * 28 + 3 * 22);
  assert.equal(canvas.length, 1);
  f.close(); assert.equal(disconnected.length, observed.length);
});

test('actual selection cleanup clears only current proved missing, with queued owner/key fences', () => {
  const selected = 'task:selected', input = { ownerKey: 'A', generation: 7 }, cleared = [];
  for (const [status, kind, subject, key, expected] of [
    ['pending', 'unknown', input, selected, false], ['error', 'unknown', input, selected, false],
    ['ready', 'missing', {}, selected, false], ['ready', 'missing', input, 'task:other', false],
    ['ready', 'found', input, selected, false], ['ready', 'missing', input, selected, true],
  ]) {
    const snapshot = { status, subject, selected: { kind, key } };
    const f = frame({ expandedBackgroundChipKey: selected, chipsOwnerSettled: true, primaryPhysicalCandidate: true,
      primaryAgentCatalogInputs: input, primaryAgentCatalogCurrentSnapshot: snapshot,
      primaryAgentCatalogInputsRef: { current: input }, primaryAgentCatalogModeRef: { current: true },
      historyOwnerKeyRef: { current: 'A' }, historyOwnerGenerationRef: { current: 7 },
      primaryAgentCatalogOwner: { isCurrent: value => value === snapshot },
      availableDetailKeys: null, setExpandedBackgroundChipKey(value) { cleared.push(typeof value === 'function' ? value(selected) : value); } });
    const before = cleared.length; f.render(() => installSelection(f.env)); f.effects();
    assert.equal(cleared.length > before, expected); f.close();
  }
  assert.deepEqual(cleared, [null]);
});

test('actual queued missing cleanup preserves a later selection, same-key ABA, publication and owner successor', () => {
  const outcomes = [];
  for (const lane of ['unchanged', 'new-key', 'same-key-ABA', 'publication-successor', 'owner-ABA', 'native-mutation', 'proof-reentry']) {
    const selected = 'task:selected', input = { ownerKey: 'A', generation: 7 }, pending = [];
    const proof = { status: 'ready', subject: input, selected: { kind: 'missing', key: selected } };
    let currentSnapshot = proof, currentKey = selected, enqueue = true, nativeCurrent = true, onProof = () => {};
    const f = frame({ expandedBackgroundChipKey: selected, chipsOwnerSettled: true, primaryPhysicalCandidate: true,
      primaryAgentCatalogInputs: input, primaryAgentCatalogCurrentSnapshot: proof, availableDetailKeys: null,
      primaryAgentCatalogInputsRef: { current: input }, primaryAgentCatalogModeRef: { current: true },
      primaryAgentSelectionEpochRef: { current: 0 },
    EMPTY_HISTORY_CHIPS: Object.freeze([]), EMPTY_HISTORY_AGENTS: Object.freeze([]),
    buildHistoryLivePresentation, collectHistoryBackgroundChips: oracle.collectHistoryBackgroundChips,
    collectHistoryAgentChips: oracle.collectHistoryAgentChips, historyPrimaryPromptAdoptionFingerprint, historyOwnerKey: 'A', historyOwnerKeyRef: { current: 'A' },
      historyOwnerGenerationRef: { current: 7 }, tabId: 'A',
      primaryAgentCatalogOwner: { snapshot() { return currentSnapshot; }, isCurrent(value) { onProof(); return value === currentSnapshot && nativeCurrent; } },
      setExpandedBackgroundChipKey(value) {
        if (enqueue) pending.push(value);
        else currentKey = typeof value === 'function' ? value(currentKey) : value;
      }, setAgentRosterOpen() {},
    });
    f.render(() => installSelection(f.env)); f.effects();
    assert.equal(pending.length, 1, lane + ' captured the actual cleanup setter');
    enqueue = false;
    const controls = f.render(() => installEvents(f.env)); f.effects();
    if (lane === 'new-key') controls.openHistoryAgent('task:later');
    if (lane === 'same-key-ABA') { controls.openHistoryAgent('task:other'); controls.openHistoryAgent(selected); }
    if (lane === 'publication-successor') currentSnapshot = { ...proof, selected: { kind: 'found', key: selected, record: chip(selected) } };
    if (lane === 'owner-ABA') { f.env.historyOwnerKeyRef.current = 'B'; f.env.historyOwnerGenerationRef.current++;
      f.env.historyOwnerKeyRef.current = 'A'; f.env.historyOwnerGenerationRef.current++; }
    if (lane === 'native-mutation') nativeCurrent = false;
    if (lane === 'proof-reentry') onProof = () => controls.openHistoryAgent(selected);
    const update = pending.shift(); currentKey = typeof update === 'function' ? update(currentKey) : update;
    outcomes.push([lane, currentKey]); f.close();
  }
  assert.deepEqual(outcomes, [
    ['unchanged', null], ['new-key', 'task:later'], ['same-key-ABA', 'task:selected'],
    ['publication-successor', 'task:selected'], ['owner-ABA', 'task:selected'], ['native-mutation', 'task:selected'], ['proof-reentry', 'task:selected'],
  ], 'queued missing receipt may close only the original still-current Inspector intent');
});

test('actual queued owner-reset cleanup cannot erase a later same-owner explicit open', () => {
  let selected = 'task:previous-owner', enqueue = true;
  const pending = [], f = frame({ historyOwnerKey: 'B', historyOwnerKeyRef: { current: 'B' },
    historyOwnerGenerationRef: { current: 9 }, primaryPhysicalCandidate: true, tabId: 'B',
    primaryAgentCatalogInputs: { ownerKey: 'B', generation: 9 },
    primaryAgentCatalogModeRef: { current: true }, expandedBackgroundChipKey: selected,
    setExpandedBackgroundChipKey(value) {
      if (enqueue) pending.push(value); else selected = typeof value === 'function' ? value(selected) : value;
    }, setAgentRosterOpen() {},
  });
  f.render(() => installOwnerReset(f.env)); f.effects();
  assert.equal(pending.length, 1);
  enqueue = false;
  const controls = f.render(() => installEvents(f.env)); f.effects();
  controls.openHistoryAgent('task:new-owner-selected');
  const update = pending.shift(); selected = typeof update === 'function' ? update(selected) : update;
  assert.equal(selected, 'task:new-owner-selected');
  f.close();
});

test('actual CURRENT strip pages all33 synchronously before catalog source and opens the last native detail', () => {
  const toggles = [], requests = [], f = frame(), { HistoryBackgroundTasksBar } = installDock(f.env);
  const chips = Array.from({ length: 33 }, (_, index) => chip('task:current-' + index,
    { label: 'CURRENT ' + index, status: 'running', taskPrompt: 'full-current-prompt-' + index }));
  const catalog = { status: 'pending', counts: null, rows: [], pageStart: 0, backgroundRows: [],
    backgroundStart: 0, backgroundPageSize: 32, selected: { kind: 'unknown', key: null, record: null },
    requestPage(value) { requests.push(value); throw Error('CURRENT pagination must not wait for or request historical catalog'); } };
  const props = { chips, agents: poison('PRIMARY_HISTORICAL_ROSTER_READ'), catalog, selectedKey: null,
    rosterOpen: false, onToggleDetail: key => toggles.push(key), onToggleRoster() {}, onSelectAgent() {},
    onJumpToCard() {}, tabId: 'A', toolType: 'codex', cwd: '/finite', sessionId: 'parent' };
  let tree = f.render(HistoryBackgroundTasksBar, props); f.effects();
  assert.equal(nodes(tree, value => value.type === 'button' && value.props.title?.startsWith('CURRENT ')).length, 32);
  one(tree, value => value.type === 'button' && value.props['aria-label'] === 'Следующие фоновые задачи').props.onClick();
  tree = f.render(HistoryBackgroundTasksBar, props); f.effects();
  const last = one(tree, value => value.type === 'button' && value.props.title === 'CURRENT 32');
  assert.equal(nodes(tree, value => value.type === 'button' && value.props.title?.startsWith('CURRENT ')).length, 1);
  last.props.onClick(); assert.deepEqual(toggles, ['task:current-32']);
  tree = f.render(HistoryBackgroundTasksBar, { ...props, selectedKey: chips[32].key,
    catalog: { ...catalog, selected: { kind: 'unknown', key: chips[32].key, record: null } } });
  assert.equal(one(tree, value => value.type === f.env.HistoryBackgroundDetailPane).props.chip, chips[32]);
  one(tree, value => value.type === 'button' && value.props['aria-label'] === 'Предыдущие фоновые задачи').props.onClick();
  tree = f.render(HistoryBackgroundTasksBar, props); f.effects();
  assert.equal(nodes(tree, value => value.type === 'button' && value.props.title?.startsWith('CURRENT ')).length, 32);
  one(tree, value => value.type === 'button' && value.props['aria-label'] === 'Следующие фоновые задачи').props.onClick();
  tree = f.render(HistoryBackgroundTasksBar, { ...props, chips: [chips[0]] }); f.effects();
  assert.equal(one(tree, value => value.type === 'button' && value.props.title === 'CURRENT 0').props.title, 'CURRENT 0',
    'CURRENT contraction cannot leave its old second page empty');
  assert.deepEqual(requests, [], 'no allocation/read/second catalog demand for synchronous CURRENT pages');
  f.close();
});

test('actual card/controller/external event open, toggle, tab filter and unsubscribe are connected callbacks', () => {
  const f = frame({ expandedBackgroundChipKey: null, tabId: 'A' });
  f.env.setExpandedBackgroundChipKey = value => { f.env.expandedBackgroundChipKey = typeof value === 'function' ? value(f.env.expandedBackgroundChipKey) : value; };
  f.env.setAgentRosterOpen = value => { f.env.rosterOpen = value; };
  const control = f.render(() => installEvents(f.env)); f.effects();
  f.setContext(control.agentInspectorController);
  const { SubAgentBlock } = installCard(f.env);
  const tree = f.render(SubAgentBlock, { action: taskAction('exact:canonical:3'), entryUuid: 'exact-row', live: false, callIdentity: 'exact' });
  one(tree, value => value.type === 'button').props.onClick();
  assert.equal(f.env.expandedBackgroundChipKey, 'task:exact:canonical:3');
  one(tree, value => value.type === 'button').props.onClick(); assert.equal(f.env.expandedBackgroundChipKey, null);
  f.emit('history-panel:open-agent', { tabId: 'B', agentKey: 'task:foreign' }); assert.equal(f.env.expandedBackgroundChipKey, null);
  f.emit('history-panel:open-agent', { tabId: 'A', agentKey: 'task:far' }); assert.equal(f.env.expandedBackgroundChipKey, 'task:far');
  f.emit('history-panel:open-agent', { tabId: 'A' }); assert.equal(f.env.rosterOpen, true);
  f.close(); assert.equal(f.listeners.get('history-panel:open-agent').size, 0);
});

test('actual CURRENT chip callback precedes any catalog/Root and keeps original native liveness facts', () => {
  const scope = catalogScope({ isTurnBusy: true, agentProcessAlive: true });
  const row = agentRow('raw-live', [taskAction('synchronous')]);
  const f = frame({ primaryPhysicalCandidate: true, currentChipSourceEntries: [row], chipSourceEntries: poison('NO_HISTORICAL_SCAN'),
    chipsOwnerSettled: true, isTurnBusy: scope.isTurnBusy, agentProcessAlive: scope.agentProcessAlive,
    sessionId: scope.currentSessionId, agentProcessGeneration: scope.currentProcessGeneration, toolType: scope.chipToolType,
    exactActiveSubagents: null, exactActiveBackgroundTasks: null, terminalBackgroundTaskCalls: null,
    EMPTY_HISTORY_CHIPS: [], collectHistoryBackgroundChips: oracle.collectHistoryBackgroundChips });
  Object.defineProperty(f.env, 'primaryRootRef', { get() { throw Error('NO_READY_ROOT_GATE'); } });
  const current = currentFaceFrame({ rows: [row], context: scope });
  f.env.primaryAgentCurrentFace = current.renderFace();
  const { backgroundHistoryChips } = f.render(() => installLive(f.env));
  assert.equal(backgroundHistoryChips.length, 1); assert.equal(backgroundHistoryChips[0].key, 'task:synchronous');
  current.close();
  f.close();
});

test('actual selected hook passes full fields to old IPC sink, completed is one read, cleanup ignores late reply', async () => {
  const fixture = fullNativeFixture(), response = deferred(), f = frame();
  const selected = chip('task:full', { agentSessionId: fixture.full, agentId: fixture.full,
    taskPrompt: fixture.full, taskResult: fixture.full, taskHistory: fixture.history });
  f.env.ipcRenderer.invoke = async (channel, payload) => { f.invocations.push({ channel, payload }); return response.promise; };
  const { useSubagentSteps } = installSteps(f.env);
  f.render(() => useSubagentSteps(selected, 'tab', 'codex', '/finite', 'parent')); f.effects();
  assert.equal(f.invocations.length, 1); assert.equal(f.invocations[0].channel, 'subagent:read-steps');
  assert.equal(f.invocations[0].payload.agentSessionId, fixture.full); assert.equal(f.invocations[0].payload.taskText, fixture.full);
  assert.equal(f.intervals.size, 0, 'completed transcript has no polling');
  const before = f.slots.map(value => value?.value);
  f.close(); response.resolve({ success: true, steps: [{ id: 'late', kind: 'message', text: 'must not retarget' }], offset: 4 }); await tick();
  assert.deepEqual(f.slots.map(value => value?.value), before);
  assert.equal(f.sends.filter(value => value.channel === 'subagent:release-reader').length, 1);
  assert.equal(f.sends[0].payload.readerId, f.invocations[0].payload.readerId);
});

test('actual detail receives complete selected payload, original UUID jump, copy and close callbacks', () => {
  const fixture = fullNativeFixture(), f = frame(), jumps = [], closes = [];
  const selected = chip('task:full', { entryUuid: fixture.row.uuid, taskResult: fixture.full, taskHistory: fixture.history });
  f.env.useSubagentSteps = () => ({ steps: [], pending: false, unavailable: false, launchSettings: null,
    launchServiceTier: null, requestServiceTier: null, launchMetadataPending: false });
  const { HistoryBackgroundDetailPane } = installDetail(f.env);
  const tree = f.render(HistoryBackgroundDetailPane, { chip: selected, onJumpToCard: uuid => jumps.push(uuid), onClose: () => closes.push(true),
    tabId: 'tab', toolType: 'codex', cwd: '/finite', sessionId: 'parent' });
  const presentation = one(tree, value => value.type === f.env.HistoryTranscriptPresentation);
  assert(presentation.props.steps.some(step => step.text === fixture.full));
  one(tree, value => value.type === 'button' && value.props.title === 'Копировать полный ответ агента').props.onClick();
  assert.equal(f.copies[0], fixture.full);
  one(tree, value => value.type === 'button' && value.props.disabled === false).props.onClick();
  assert.equal(jumps[0], fixture.row.uuid);
  one(tree, value => value.props['aria-label'] === 'Close agent pane').props.onClick(); assert.deepEqual(closes, [true]);
  f.effects(); f.close(); assert.equal(f.timers.size, 0);
});

test('actual mounted liveness demand coalesces and releases group iterator on unmount/close', async () => {
  const requests = [], f = frame(), api = installLiveness(f.env), owner = { requestMembership(value) { requests.push(value); } };
  const demand = api.createHistoryAgentCatalogMembershipDemand(owner);
  let iterated = 0;
  const group = { id: 'group', kind: 'entry', *values() { iterated++; yield 'far-row'; } };
  const offA = demand.register('A', { call: 'call' }), offB = demand.register('B', { entry: 'row', any: group });
  await tick(); assert.equal(requests.length, 1); assert.equal(iterated, 0, 'registration retains iterator only, no historical scan');
  assert.equal(requests[0].any[0], group); assert.deepEqual(requests[0].entries, ['row']);
  offB(); await tick(); assert.deepEqual(requests.at(-1).any, []);
  offA(); await tick(); assert.deepEqual(requests.at(-1).calls, []);
  demand.register('queued-close', { entry: 'late' }); demand.close(); const before = requests.length;
  await tick(); assert.equal(requests.length, before); f.close();
});

function admissionFrame({ prepared = null, rows = [], error = null } = {}) {
  const updates = [], entries = rows, publication = { ownerKey: 'A', generation: 1, entries: new WeakRef(entries) };
  const source = { prepared, segments: rows.map(row => ({ row })), rows, error };
  const rawLiveOwner = { ownerKey: 'A' };
  const input = { source, publication, ownerKey: 'A', generation: 1, rows, live: [], rawLiveOwner,
    context: catalogScope(), settled: true };
  const f = frame({ primaryPhysicalCandidate: true, presentedOwnerKey: 'A', historyOwnerKey: 'A',
    historyOwnerKeyRef: { current: 'A' }, historyOwnerGenerationRef: { current: 1 }, primaryReceiptGenerationAtRender: 1,
    entries, presentationEntriesRef: { current: entries }, primaryShownPublicationAtRender: publication,
    primaryPresentationDataCommitRef: { current: null }, primaryAgentCatalogModeRef: { current: true },
    primaryAgentCatalogInputs: input, primaryAgentCatalogInputsRef: { current: input }, liveProjectionRef: { current: rawLiveOwner },
    primarySparsePublicationOwner: { current: () => publication,
      matches: (candidate, value, scope) => candidate === publication && value === entries && scope.ownerKey === 'A' && scope.generation === 1 },
    primaryAgentSourceOwner: { current: () => source }, primaryAgentCatalogOwner: { update: value => updates.push(value) },
    createHistoryAgentCatalogCurrent, historyPrimaryPromptAdoptionFingerprint,
    isLocalPromptEntry: oracle.isLocalPromptEntry, isTaskAction: oracle.isTaskAction,
  });
  for (const name of ['primaryRootRef', 'primaryRoot', 'primaryReceiptHeaderAtRender', 'displayEntries', 'displayUnits', 'canonicalMetadataFact'])
    Object.defineProperty(f.env, name, { get() { throw Error('ADMISSION_MUST_NOT_USE_' + name); } });
  const install = () => f.render(() => { installDataCommit(f.env); installAdmission(f.env); });
  return { ...f, input, source, publication, updates, install };
}

test('actual DATA commit admits independently retained source without live Root/header or layout arrays', () => {
  const prepared = { closed: false }, f = admissionFrame({ prepared });
  f.install(); f.effects();
  assert.equal(f.env.primaryPresentationDataCommitRef.current.publication, f.publication);
  assert.equal(f.updates.length, 1); const candidate = f.updates[0];
  assert.equal(candidate.prepared, prepared); assert.equal(candidate.subject, f.input);
  assert.equal(candidate.current.isCurrent(), true); assert.equal(candidate.fullWitness(), true); assert.equal(candidate.ownerFence(), true);
  for (const mutate of [
    () => { f.env.historyOwnerGenerationRef.current = 2; },
    () => { f.env.primaryPresentationDataCommitRef.current = { publication: {} }; },
    () => { f.env.presentationEntriesRef.current = []; },
    () => { f.env.primaryAgentCatalogInputsRef.current = {}; },
    () => { f.env.liveProjectionRef.current = {}; },
  ]) {
    f.env.historyOwnerGenerationRef.current = 1;
    f.env.primaryPresentationDataCommitRef.current = { publication: f.publication };
    f.env.presentationEntriesRef.current = f.input.rows; f.env.primaryAgentCatalogInputsRef.current = f.input;
    f.env.liveProjectionRef.current = f.input.rawLiveOwner;
    mutate(); assert.equal(candidate.ownerFence(), false, 'original owner/sequence/publication/raw-live identity is retained');
  }
  f.close();
});

test('actual DATA commit refuses a queued stale publication and never admits its catalog', () => {
  const f = admissionFrame({ prepared: { closed: false } });
  f.install(); f.env.presentationEntriesRef.current = [];
  f.env.primaryPresentationDataCommitRef.current = { publication: f.publication };
  f.effects();
  assert.equal(f.env.primaryPresentationDataCommitRef.current, null);
  assert.equal(f.updates.length, 0); f.close();
});

test('actual admission keeps current-only history UNKNOWN and reports source/fingerprint failure distinctly', async () => {
  const f = admissionFrame(); f.install(); f.effects();
  assert.equal(f.updates.length, 1); assert.equal(f.updates[0].prepared, null);
  let published;
  const owner = createHistoryPrimaryAgentCatalogOwner({ onChange: update => { published = update(published); } });
  owner.update(f.updates[0]); await tick();
  assert.equal(published.status, 'pending'); assert.equal(published.counts, null);
  assert.equal(published.selected.kind, 'unknown'); owner.close(); f.close();
  const sourceError = Object.assign(Error('exact source unavailable'), { code: 'HISTORY_AGENT_CATALOG_SOURCE_IDENTITY' });
  const s = admissionFrame({ error: sourceError }); s.install(); s.effects();
  assert.equal(s.updates[0].sourceError, sourceError); s.close();
  const fingerprintError = Error('ORIGINAL_CURRENT_OWNKEYS');
  const proxy = new Proxy({}, { ownKeys() { throw fingerprintError; } });
  const e = admissionFrame({ rows: [proxy] }); e.install(); e.effects();
  assert.equal(e.updates[0].sourceError, fingerprintError);
  assert.equal(e.updates[0].fullWitness(), false); e.close();
});

test('actual original full CURRENT witness can reenter after replay; final owner fence prevents publication', async () => {
  let armed = false, f;
  const row = new Proxy({ uuid: 'local-prompt-current', role: 'queued', content: 'full original text' }, {
    ownKeys(target) { if (armed) { armed = false; f.env.historyOwnerKeyRef.current = 'B'; } return Reflect.ownKeys(target); },
  });
  let closes = 0, published;
  const reader = { closed: false, counts: { total: 0, roster: 0, running: 0, completed: 0, interrupted: 0, background: 0 },
    async readPage({ section, offset, owns }) { owns(); return { section, offset, rows: [] }; },
    async close() { closes++; this.closed = true; } };
  const prepared = { closed: false, retain() { return { async openAgentCatalog(_current, options) { options.owns(); return reader; }, async close() {} }; } };
  f = admissionFrame({ rows: [row], prepared }); f.install(); f.effects();
  const candidate = f.updates[0];
  assert.equal(candidate.current.isCurrent(), true, 'replay occurs before original full witness');
  const owner = createHistoryPrimaryAgentCatalogOwner({ onChange: update => { published = update(published); } });
  owner.update(candidate); armed = true;
  for (let index = 0; index < 30 && owner.state().running; index++) await tick();
  assert.equal(f.env.historyOwnerKeyRef.current, 'B');
  assert.equal(candidate.ownerFence(), false);
  assert.notEqual(published?.status, 'ready');
  owner.close(); await tick(); assert.equal(closes, 1); f.close();
});

test('actual missing cleanup calls actual publication proof and rejects same-object mutation after its last await', async () => {
  const nativeResult = { text: 'original' }, row = agentRow('local-prompt-current', [taskAction('native', { result: nativeResult })]);
  let reads = 0, closes = 0, published;
  const reader = { closed: false, counts: { total: 0, roster: 0, running: 0, completed: 0, interrupted: 0, background: 0 },
    async readPage({ section, offset, owns }) { owns(); reads++; return { section, offset, rows: [] }; },
    async lookup(key, { owns }) { owns(); reads++; return { kind: 'missing', key }; },
    async close() { closes++; this.closed = true; } };
  const prepared = { closed: false, retain() { return { async openAgentCatalog(_current, options) { options.owns(); return reader; }, async close() {} }; } };
  const f = admissionFrame({ rows: [row], prepared }); f.install(); f.effects();
  const candidate = f.updates[0], owner = createHistoryPrimaryAgentCatalogOwner({ onChange: update => { published = update(published); } });
  owner.update(candidate); owner.select('task:missing');
  for (let index = 0; index < 30 && owner.state().running; index++) await tick();
  assert.equal(published.status, 'ready'); assert.equal(published.selected.kind, 'missing');
  assert.equal(owner.isCurrent(published), true);
  const pending = [];
  Object.assign(f.env, { expandedBackgroundChipKey: 'task:missing', chipsOwnerSettled: true, availableDetailKeys: null,
    primaryAgentCatalogOwner: owner, primaryAgentCatalogCurrentSnapshot: published,
    setExpandedBackgroundChipKey: update => pending.push(update) });
  f.render(() => installSelection(f.env)); f.effects(); assert.equal(pending.length, 1);
  const before = reads; nativeResult.text = 'changed after queued cleanup';
  assert.equal(candidate.current.isCurrent(), true, 'no native operation log sees this unobserved field in the finite reader');
  assert.equal(candidate.fullWitness(), false, 'original FULL caller witness detects same-object payload mutation');
  assert.equal(pending.shift()('task:missing'), 'task:missing');
  assert.equal(reads, before, 'fresh cleanup proof does not cause reads, polling, reallocation or a second load cycle');
  owner.close(); await tick(); assert.equal(closes, 1); f.close();
});

// V53 preserving repair F1: the actual synchronous CURRENT caller, actual
// dock publication and actual components share original owner/ref boundaries.
// No Root/prepared read/model/DOM is supplied by these finite callback frames.
function currentFaceFrame({ rows = [], live = [], context = catalogScope(), prepared = null,
  sourceError = null, settled = true, selectedKey = null } = {}) {
  const entries = rows, publication = { ownerKey: 'A', generation: 1, entries: new WeakRef(entries) };
  const source = { prepared, rows, segments: rows.map(row => ({ row })), error: sourceError };
  const rawLiveOwner = { ownerKey: 'A' };
  const input = { source, publication, ownerKey: 'A', generation: 1, rows, live, rawLiveOwner, context, settled };
  const requests = [], proofs = [];
  const f = frame({ primaryPhysicalCandidate: true, primaryAgentCatalogModeRef: { current: true },
    primaryAgentCatalogInputs: input, primaryAgentCatalogInputsRef: { current: input },
    primaryAgentCurrentSelectionEpochAtRender: 0, primaryAgentSelectionEpochRef: { current: 0 },
    historyOwnerKeyRef: { current: 'A' }, historyOwnerGenerationRef: { current: 1 },
    liveProjectionRef: { current: rawLiveOwner }, presentationEntriesRef: { current: entries },
    primarySparsePublicationOwner: { current: () => publication }, primaryAgentSourceOwner: { current: () => source },
    primaryAgentCatalogCurrentSnapshot: null, expandedBackgroundChipKey: selectedKey,
    primaryAgentCatalogOwner: { requestPage: value => requests.push(value), isCurrent: snapshot => { proofs.push(snapshot); return false; } },
  });
  for (const name of ['primaryRootRef', 'primaryRoot', 'primaryReceiptHeaderAtRender', 'displayEntries', 'displayUnits', 'chipSourceEntries'])
    Object.defineProperty(f.env, name, { get() { throw Error('CURRENT_FACE_MUST_NOT_USE_' + name); } });
  const renderFace = () => f.render(() => installCurrentFace(f.env).primaryAgentCurrentFace);
  const renderDock = () => f.render(() => {
    f.env.primaryAgentCurrentFace = installCurrentFace(f.env).primaryAgentCurrentFace;
    return f.env.primaryAgentCatalogDock = installDockPublication(f.env).primaryAgentCatalogDock;
  });
  const renderWithCapture = () => f.render(() => {
    f.env.primaryAgentCurrentFace = installCurrentFace(f.env).primaryAgentCurrentFace;
    f.env.primaryAgentCatalogDock = installDockPublication(f.env).primaryAgentCatalogDock;
    installSelectedCurrentCapture(f.env);
    return f.env.primaryAgentCatalogDock;
  });
  return { ...f, input, publication, source, requests, proofs, renderFace, renderDock, renderWithCapture };
}
const currentOnlyDockProps = (f, catalog, chips, selectedKey, callbacks = {}) => ({
  chips, agents: poison('PRIMARY_HISTORICAL_ARRAY'), catalog, selectedKey, rosterOpen: false,
  onToggleDetail() {}, onToggleRoster() {}, onSelectAgent() {}, onJumpToCard() {},
  tabId: 'A', toolType: 'codex', cwd: '/finite', sessionId: 'session', ...callbacks,
});

test('F1 actual CURRENT caller and dock preserve running→completed/interrupted full detail before any historical success', () => {
  const full = 'full native payload\0\ud800\udfff' + 'z'.repeat(65537), history = [{ role: 'assistant', content: full }];
  const launchSettings = { model: full, nested: { alias: history } }, key = 'task:current-completion';
  for (const historicalStatus of ['pending', 'error']) for (const status of ['running', 'completed', 'interrupted']) {
    const action = taskAction('current-completion', { description: 'CURRENT task', startedAt: 7,
      taskPrompt: full, agentId: 'agent-' + full, agentSessionId: 'session-' + full,
      history, launchSettings, ...(status === 'running' ? {} : { subagentStatus: status, result: full }) });
    const row = agentRow('current-native-row', [action]);
    const live = reduceHistoryLiveProjection([row], { type: 'turn_boundary', boundary: 'turn_settled', sessionId: 'session' });
    assert.equal(live[0].actions[0], action, 'actual settled reducer retains full native Task action');
    const context = catalogScope({ isTurnBusy: status === 'running', agentProcessAlive: true,
      exactActiveSubagents: status === 'running' ? new Map([['current-completion', { provider: 'codex', startedAt: 7 }]]) : new Map(),
      terminalFacts: new Map(status === 'running' ? [] : [['current-completion', { status, completedAt: 17 }]]) });
    const sourceError = Object.assign(Error('HISTORICAL_SOURCE_UNAVAILABLE'), { code: 'HISTORY_AGENT_CATALOG_SOURCE_IDENTITY' });
    const current = currentFaceFrame({ live, context, sourceError, prepared: { closed: true }, selectedKey: key });
    const stale = chip(key, { status: 'running', taskResult: 'obsolete result' });
    current.env.primaryAgentCatalogCurrentSnapshot = { subject: current.input, status: historicalStatus,
      counts: null, rows: [], backgroundRows: [], selected: { kind: 'unknown', key, record: stale },
      error: historicalStatus === 'error' ? sourceError : null, errorStage: historicalStatus === 'error' ? 'source' : null };
    const catalog = current.renderDock(), face = current.env.primaryAgentCurrentFace;
    assert.equal(face.status, 'ready'); assert.equal(face.agents.length, 1);
    assert.equal(catalog.status, historicalStatus); assert.equal(catalog.counts, null, 'CURRENT existence never proves historical total');
    assert.equal(catalog.selected.kind, 'unknown'); assert.equal(catalog.currentAgents, face.agents);
    const expectedChips = oracle.collectHistoryBackgroundChips(buildHistoryLivePresentation([], live), context.isTurnBusy,
      context.agentProcessAlive, context.currentSessionId, context.currentProcessGeneration, context.chipToolType,
      context.exactActiveSubagents, context.exactActiveBackgroundTasks, context.terminalBackgroundTaskCalls);
    const expected = oracle.collectHistoryAgentChips(buildHistoryLivePresentation([], live), expectedChips, context.terminalFacts);
    assert.deepEqual(face.agents, expected, 'literal old native collector is the differential oracle');
    const dockFrame = frame(), Dock = installDock(dockFrame.env).HistoryBackgroundTasksBar;
    const tree = dockFrame.render(Dock, currentOnlyDockProps(dockFrame, catalog, face.chips, key));
    const detail = one(tree, value => value.type === dockFrame.env.HistoryBackgroundDetailPane).props.chip;
    assert.equal(detail, face.agents[0], 'fresh CURRENT record supersedes retained running clone during UNKNOWN');
    assert.equal(detail.status, status); assert.equal(detail.taskPrompt, full);
    assert.equal(detail.taskHistory, history); assert.equal(detail.launchSettings, launchSettings);
    assert.equal(detail.agentId, action.agentId); assert.equal(detail.agentSessionId, action.agentSessionId);
    if (status !== 'running') { assert.equal(face.chips.length, 0); assert.equal(detail.taskResult, full); }
    assert.equal(nodes(tree, value => value.props['data-history-agent-detail-pending']).length, 0);
    assert.deepEqual(current.requests, []); assert.deepEqual(current.proofs, []);
    current.close(); dockFrame.effects(); dockFrame.close();
  }
});

test('F1 first CURRENT-completed open is connected through actual card, external event and paged roster callbacks', () => {
  const full = 'completed before first open\0\udfff', key = 'task:first-completed';
  const action = taskAction('first-completed', { subagentStatus: 'completed', result: full, taskPrompt: full,
    history: [{ role: 'assistant', content: full }], agentSessionId: 'native-session' });
  const current = currentFaceFrame({ live: [agentRow('first-completed-row', [action])] });
  const catalog = current.renderDock(), face = current.env.primaryAgentCurrentFace;
  const controlsFrame = frame({ tabId: 'A', expandedBackgroundChipKey: null });
  controlsFrame.env.setExpandedBackgroundChipKey = update => { controlsFrame.env.expandedBackgroundChipKey =
    typeof update === 'function' ? update(controlsFrame.env.expandedBackgroundChipKey) : update; };
  controlsFrame.env.setAgentRosterOpen = value => { controlsFrame.env.rosterOpen = value; };
  const controls = controlsFrame.render(() => installEvents(controlsFrame.env)); controlsFrame.effects();
  const checkDetail = () => {
    const f = frame(), Dock = installDock(f.env).HistoryBackgroundTasksBar;
    const tree = f.render(Dock, currentOnlyDockProps(f, catalog, face.chips, controlsFrame.env.expandedBackgroundChipKey));
    assert.equal(one(tree, value => value.type === f.env.HistoryBackgroundDetailPane).props.chip.taskResult, full); f.close();
  };
  const cardFrame = frame(); cardFrame.setContext(controls.agentInspectorController);
  const Card = installCard(cardFrame.env).SubAgentBlock;
  one(cardFrame.render(Card, { action, entryUuid: 'first-completed-row', live: false, callIdentity: 'first-completed' }),
    value => value.type === 'button').props.onClick();
  assert.equal(controlsFrame.env.expandedBackgroundChipKey, key); checkDetail();
  controls.openHistoryAgent('task:other');
  controlsFrame.emit('history-panel:open-agent', { tabId: 'A', agentKey: key });
  assert.equal(controlsFrame.env.expandedBackgroundChipKey, key); checkDetail();
  const rosterFrame = frame(), Roster = installRoster(rosterFrame.env).HistoryAgentRoster;
  const tree = rosterFrame.render(Roster, { agents: poison('PRIMARY_HISTORICAL_ROSTER'), catalog,
    selectedKey: null, onSelect: controls.openHistoryAgent, onClose() {} });
  const window = one(tree, value => value.type === rosterFrame.env.HistoryAgentCatalogWindow);
  assert.equal(window.props.status, 'pending'); assert.equal(window.props.counts.total, 1);
  assert.equal(window.props.counts.completed, 1); assert.equal(window.props.rows.length, 1);
  assert.equal(nodes(tree, value => value.props['data-history-agent-current-roster']).length, 1);
  one(window.props.renderRow(window.props.rows[0]), value => value.type === 'button').props.onClick();
  assert.equal(controlsFrame.env.expandedBackgroundChipKey, key); checkDetail();
  assert.equal(catalog.counts, null, 'only CURRENT section counts are known');
  assert.deepEqual(current.requests, []); current.close(); controlsFrame.close(); cardFrame.close(); rosterFrame.close();
  assert.equal(controlsFrame.listeners.get('history-panel:open-agent').size, 0);
});

test('F1 actual CURRENT roster pages completed/interrupted records synchronously and keeps historical UNKNOWN', () => {
  const rows = Array.from({ length: 133 }, (_, index) => agentRow('current-' + index, [taskAction('current-' + index,
    { subagentStatus: index % 2 ? 'completed' : 'interrupted', startedAt: index + 1, result: 'full-' + index })]));
  const current = currentFaceFrame({ rows }); const catalog = current.renderDock();
  const f = frame(), Roster = installRoster(f.env).HistoryAgentRoster;
  const props = { agents: poison('HISTORICAL_ARRAY'), catalog, selectedKey: null, onSelect() {}, onClose() {} };
  let tree = f.render(Roster, props), window = one(tree, value => value.type === f.env.HistoryAgentCatalogWindow);
  assert.equal(window.props.rows.length, 64); assert.equal(window.props.counts.total, 133);
  assert.equal(window.props.counts.completed, 66); assert.equal(window.props.counts.interrupted, 67);
  const all = [...window.props.rows];
  window.props.onRequestPage({ section: 'roster', offset: 64, limit: 64 });
  tree = f.render(Roster, props); window = one(tree, value => value.type === f.env.HistoryAgentCatalogWindow);
  assert.equal(window.props.pageStart, 64); all.push(...window.props.rows);
  window.props.onRequestPage({ section: 'roster', offset: 128, limit: 64 });
  tree = f.render(Roster, props); window = one(tree, value => value.type === f.env.HistoryAgentCatalogWindow);
  assert.equal(window.props.rows.length, 64); assert.equal(window.props.pageStart, 69); all.push(...window.props.rows);
  assert.equal(new Set(all.map(row => row.key)).size, 133, 'ordinary local pages expose every CURRENT record');
  assert.equal(catalog.status, 'pending'); assert.equal(catalog.counts, null); assert.deepEqual(current.requests, []);
  current.close(); f.close();
});

test('F1 actual CURRENT face refuses original-owner/epoch and unchanged-object mutation reentry after native work', () => {
  const outcomes = [];
  for (const lane of ['original', 'owner-ABA', 'selection-ABA', 'same-object-payload', 'input-successor', 'raw-live-successor', 'getter-error']) {
    const action = taskAction('fence', { subagentStatus: 'completed', result: { value: 'original' } });
    const current = currentFaceFrame({ live: [agentRow('current-fence', [action])] });
    const original = current.env.collectHistoryAgentChips;
    current.env.collectHistoryAgentChips = (...args) => {
      const result = original(...args);
      if (lane === 'owner-ABA') { current.env.historyOwnerKeyRef.current = 'B'; current.env.historyOwnerGenerationRef.current++;
        current.env.historyOwnerKeyRef.current = 'A'; current.env.historyOwnerGenerationRef.current++; }
      if (lane === 'selection-ABA') current.env.primaryAgentSelectionEpochRef.current += 2;
      if (lane === 'same-object-payload') action.result.value = 'changed during collector';
      if (lane === 'input-successor') current.env.primaryAgentCatalogInputsRef.current = { ...current.input };
      if (lane === 'raw-live-successor') current.env.liveProjectionRef.current = { ownerKey: 'A' };
      if (lane === 'getter-error') throw Object.assign(Error('CURRENT_NATIVE_COERCION'), { code: 'CURRENT_NATIVE_COERCION' });
      return result;
    };
    const face = current.renderFace(); outcomes.push([lane, face.status, face.agents.length]);
    if (lane === 'getter-error') assert.equal(face.error.code, 'CURRENT_NATIVE_COERCION');
    current.close();
  }
  assert.deepEqual(outcomes, [['original', 'ready', 1], ['owner-ABA', 'pending', 0], ['selection-ABA', 'pending', 0],
    ['same-object-payload', 'pending', 0], ['input-successor', 'pending', 0], ['raw-live-successor', 'pending', 0], ['getter-error', 'error', 0]]);
});

test('F1 combined ready catalog supersedes CURRENT only after fresh original proof and final selection fence', () => {
  const outcomes = [];
  for (const lane of ['fresh', 'not-current', 'epoch-reentry', 'owner-reentry', 'input-reentry', 'native-mutation', 'new-key']) {
    const key = 'task:ready', current = currentFaceFrame({ live: [agentRow('current-ready', [taskAction('ready',
      { subagentStatus: 'completed', result: 'current result' })])], selectedKey: key });
    const record = chip(key, { taskResult: 'combined original result' });
    const snapshot = { subject: current.input, status: 'ready', counts, rows: [record], backgroundRows: [],
      selected: { kind: 'found', key, record } };
    current.env.primaryAgentCatalogCurrentSnapshot = snapshot;
    current.env.primaryAgentCatalogOwner.isCurrent = candidate => {
      assert.equal(candidate, snapshot); current.proofs.push(candidate);
      if (lane === 'epoch-reentry') current.env.primaryAgentSelectionEpochRef.current++;
      if (lane === 'owner-reentry') current.env.historyOwnerGenerationRef.current++;
      if (lane === 'input-reentry') current.env.primaryAgentCatalogInputsRef.current = { ...current.input };
      if (lane === 'native-mutation') current.input.live[0].actions[0].result = 'changed during final proof';
      return lane !== 'not-current' && lane !== 'native-mutation';
    };
    if (lane === 'new-key') current.env.expandedBackgroundChipKey = 'task:next';
    const catalog = current.renderDock();
    outcomes.push([lane, catalog.status]);
    const f = frame(), Dock = installDock(f.env).HistoryBackgroundTasksBar;
    const tree = f.render(Dock, currentOnlyDockProps(f, catalog, current.env.primaryAgentCurrentFace.chips,
      current.env.expandedBackgroundChipKey));
    if (lane === 'fresh') assert.equal(one(tree, value => value.type === f.env.HistoryBackgroundDetailPane).props.chip, record);
    if (lane === 'not-current') assert.equal(one(tree, value => value.type === f.env.HistoryBackgroundDetailPane).props.chip.taskResult, 'current result');
    if (lane === 'new-key') assert.equal(current.proofs.length, 0, 'old selected receipt cannot prove another key');
    if (['epoch-reentry', 'owner-reentry', 'input-reentry', 'native-mutation'].includes(lane)) {
      assert.equal(catalog.currentAgents.length, 0, 'a later native proof invalidated the original CURRENT face');
      assert.equal(catalog.currentChips.length, 0, 'empty explicit CURRENT chips block the stale chips prop fallback');
    }
    if (['epoch-reentry', 'owner-reentry', 'input-reentry'].includes(lane)) {
      assert.equal(catalog.selected.record, null, 'old owner/selection intent cannot retain a record after reentry');
      assert.equal(nodes(tree, value => value.type === f.env.HistoryBackgroundDetailPane).length, 0);
    }
    if (lane === 'native-mutation') assert.equal(catalog.selected.record, record,
      'UNKNOWN retains an older same-owner historical record but never recaptures changed CURRENT as proof');
    current.close(); f.close();
  }
  assert.deepEqual(outcomes, [['fresh', 'ready'], ['not-current', 'pending'], ['epoch-reentry', 'pending'], ['owner-reentry', 'pending'], ['input-reentry', 'pending'], ['native-mutation', 'pending'], ['new-key', 'pending']]);
});

test('F1 unchanged CURRENT objects update completion on a parent render without waiting for new input identity', () => {
  const action = taskAction('mutable-current', { description: 'mutable task', taskPrompt: 'original prompt', startedAt: 1 });
  const context = catalogScope({ isTurnBusy: true, agentProcessAlive: true,
    exactActiveSubagents: new Map([['mutable-current', { startedAt: 1, provider: 'codex' }]]), terminalFacts: new Map() });
  const current = currentFaceFrame({ live: [agentRow('mutable-row', [action])], context, selectedKey: 'task:mutable-current' });
  const first = current.renderDock(), firstFace = current.env.primaryAgentCurrentFace, input = current.input;
  assert.equal(firstFace.agents[0].status, 'running');
  const result = 'new synchronous complete result\0\ud800';
  action.subagentStatus = 'completed'; action.result = result;
  action.history = [{ role: 'assistant', content: result }];
  context.isTurnBusy = false; context.exactActiveSubagents.clear();
  const next = current.renderDock(), nextFace = current.env.primaryAgentCurrentFace;
  assert.equal(current.input, input); assert.equal(current.env.primaryAgentCatalogInputsRef.current, input);
  assert.notEqual(nextFace, firstFace); assert.notEqual(nextFace.agents[0], firstFace.agents[0]);
  assert.equal(nextFace.chips.length, 0); assert.equal(nextFace.agents[0].status, 'completed');
  assert.equal(nextFace.agents[0].taskResult, result); assert.equal(nextFace.agents[0].taskHistory, action.history);
  assert.equal(first.status, 'pending'); assert.equal(next.status, 'pending'); assert.equal(next.counts, null);
  const f = frame(), Dock = installDock(f.env).HistoryBackgroundTasksBar;
  const tree = f.render(Dock, currentOnlyDockProps(f, next, nextFace.chips, 'task:mutable-current'));
  assert.equal(one(tree, value => value.type === f.env.HistoryBackgroundDetailPane).props.chip.taskResult, result);
  assert.deepEqual(current.requests, []); current.close(); f.close();
});

test('F1 actual Proxy witness reentry after collection cannot publish the old CURRENT face', () => {
  let current, calls = 0;
  const row = new Proxy(agentRow('proxy-row', [taskAction('proxy', { subagentStatus: 'completed', result: 'original' })]), {
    ownKeys(target) { calls++; if (calls === 3) current.env.primaryAgentSelectionEpochRef.current += 2; return Reflect.ownKeys(target); },
  });
  current = currentFaceFrame({ live: [row], selectedKey: 'task:proxy' });
  const catalog = current.renderDock();
  assert.equal(current.env.primaryAgentCurrentFace.status, 'ready', 'collection before the final witness was valid');
  assert.equal(calls, 3, 'original full witnesses run before collection, after collection, then before dock fallback');
  assert.equal(catalog.currentAgents.length, 0); assert.equal(catalog.currentChips.length, 0);
  assert.equal(catalog.counts, null); assert.equal(catalog.selected.record, null); assert.equal(catalog.selected.kind, 'unknown');
  assert.deepEqual(current.requests, []); current.close();
});

test('F1 actual outer liveness counts and mounted membership cannot reuse a stale same-input combined proof', () => {
  const key = 'task:stale-live', action = taskAction('stale-live', { subagentStatus: 'completed', result: 'already complete' });
  const current = currentFaceFrame({ live: [agentRow('stale-row', [action])], selectedKey: key });
  const staleMembership = { entries: new Set(['stale-row']), calls: new Set(['stale-live']) };
  current.env.primaryAgentCatalogCurrentSnapshot = { subject: current.input, status: 'ready',
    counts: { total: 1, roster: 1, running: 1, completed: 0, interrupted: 0, background: 1, backgroundAgents: 1 },
    rows: [], backgroundRows: [], membership: staleMembership, selected: { kind: 'found', key, record: chip(key, { status: 'running' }) } };
  current.env.primaryAgentCatalogOwner.isCurrent = () => false;
  const dock = current.renderDock();
  assert.equal(dock.status, 'pending'); assert.equal(current.env.primaryAgentCurrentFace.chips.length, 0);
  const f = frame({ primaryPhysicalCandidate: true, primaryAgentCatalogCurrentSnapshot: current.env.primaryAgentCatalogCurrentSnapshot,
    primaryAgentCatalogInputs: current.input, primaryAgentCatalogDock: dock,
    primaryAgentMembershipDemand: {}, backgroundHistoryChips: current.env.primaryAgentCurrentFace.chips });
  const counts = f.render(() => installLiveCounts(f.env));
  assert.equal(counts.backgroundAgentChipCount, 0, 'actual loader counts use only a fresh combined receipt or CURRENT fallback');
  assert.equal(counts.backgroundChipCount, 0);
  const membership = f.render(() => installLiveMembership(f.env)).primaryAgentLiveness;
  assert.equal(membership.membership, null, 'mounted liveness cannot publish stale combined memberships');
  current.close(); f.close();
});

test('F1 selected CURRENT retirement keeps one exact same-owner detail during UNKNOWN and ready missing stays authoritative', () => {
  const key = 'task:retiring-current', result = 'retained full result\0\ud800', history = [{ role: 'assistant', content: result }];
  const current = currentFaceFrame({ live: [agentRow('retiring-row', [taskAction('retiring-current',
    { subagentStatus: 'completed', result, history, taskPrompt: 'prompt', agentSessionId: 'native-thread' })])], selectedKey: key });
  const before = current.renderWithCapture(); current.effects();
  const saved = current.env.primaryAgentCurrentSelectedRef.current;
  assert(saved); assert.equal(saved.record.taskResult, result); assert.equal(saved.record.taskHistory, history);
  assert.deepEqual(Object.keys(saved).sort(), ['epoch', 'generation', 'key', 'ownerKey', 'record'],
    'one selected record has no source/face/input/rows/proof closure');
  const rows = [], live = [], publication = { ownerKey: 'A', generation: 1, entries: new WeakRef(rows) };
  const source = { prepared: { closed: false }, rows, segments: [], error: Error('first historical open still pending') };
  const rawLiveOwner = { ownerKey: 'A' }, input = { ...current.input, source, publication, rows, live, rawLiveOwner };
  Object.assign(current.env, { primaryAgentCatalogInputs: input });
  current.env.primaryAgentCatalogInputsRef.current = input; current.env.liveProjectionRef.current = rawLiveOwner;
  current.env.presentationEntriesRef.current = rows;
  current.env.primarySparsePublicationOwner.current = () => publication; current.env.primaryAgentSourceOwner.current = () => source;
  const retired = current.renderWithCapture(); current.effects();
  assert.equal(before.status, 'pending'); assert.equal(retired.status, 'pending'); assert.equal(retired.counts, null);
  assert.equal(retired.currentAgents.length, 0); assert.equal(retired.currentChips.length, 0);
  assert.equal(retired.selected.kind, 'unknown'); assert.equal(retired.selected.record, saved.record);
  const f = frame(), Dock = installDock(f.env).HistoryBackgroundTasksBar;
  const tree = f.render(Dock, currentOnlyDockProps(f, retired, [], key));
  assert.equal(one(tree, value => value.type === f.env.HistoryBackgroundDetailPane).props.chip, saved.record);
  current.env.primaryAgentCatalogCurrentSnapshot = { subject: input, status: 'ready',
    counts: { total: 0, roster: 0, running: 0, completed: 0, interrupted: 0, background: 0, backgroundAgents: 0 },
    rows: [], backgroundRows: [], selected: { kind: 'missing', key } };
  current.env.primaryAgentCatalogOwner.isCurrent = () => true;
  const missing = current.renderWithCapture(); current.effects();
  assert.equal(missing.status, 'ready'); assert.equal(missing.selected.kind, 'missing'); assert.equal(missing.selected.record, null);
  assert.equal(nodes(f.render(Dock, currentOnlyDockProps(f, missing, [], key)),
    value => value.type === f.env.HistoryBackgroundDetailPane).length, 0, 'cache is not a missing-proof override');
  current.env.expandedBackgroundChipKey = null; current.env.primaryAgentSelectionEpochRef.current++;
  current.env.primaryAgentCurrentSelectionEpochAtRender = current.env.primaryAgentSelectionEpochRef.current;
  current.renderWithCapture(); current.effects(); assert.equal(current.env.primaryAgentCurrentSelectedRef.current, null);
  assert.deepEqual(current.requests, []); current.close(); f.close();
});

test('F1 queued selected CURRENT capture obeys original input/epoch/owner and final native witness without overwriting a successor', () => {
  const outcomes = [];
  for (const lane of ['unchanged', 'input-successor', 'selection-ABA', 'owner-ABA', 'native-mutation', 'final-witness-reentry']) {
    let armed = false, current;
    const action = taskAction('capture', { subagentStatus: 'completed', result: { text: 'original' } });
    const nextRecord = chip('task:capture', { taskResult: 'newer selected record' });
    const successor = { ownerKey: 'A', generation: 1, key: 'task:capture', epoch: 1, record: nextRecord };
    const row = new Proxy(agentRow('capture-row', [action]), { ownKeys(target) {
      if (armed) { armed = false; current.env.primaryAgentSelectionEpochRef.current++;
        current.env.primaryAgentCurrentSelectedRef.current = successor; }
      return Reflect.ownKeys(target);
    } });
    current = currentFaceFrame({ live: [row], selectedKey: 'task:capture' });
    const previous = { ownerKey: 'A', generation: 1, key: 'task:capture', epoch: 0, record: chip('task:capture', { taskResult: 'old selected' }) };
    current.env.primaryAgentCurrentSelectedRef.current = previous;
    current.renderWithCapture();
    if (lane === 'input-successor') current.env.primaryAgentCatalogInputsRef.current = { ...current.input };
    if (lane === 'selection-ABA') { current.env.primaryAgentSelectionEpochRef.current += 2;
      current.env.primaryAgentCurrentSelectedRef.current = successor; }
    if (lane === 'owner-ABA') { current.env.historyOwnerKeyRef.current = 'B'; current.env.historyOwnerGenerationRef.current++;
      current.env.historyOwnerKeyRef.current = 'A'; current.env.historyOwnerGenerationRef.current++; }
    if (lane === 'native-mutation') action.result.text = 'changed after render';
    if (lane === 'final-witness-reentry') armed = true;
    current.effects();
    const saved = current.env.primaryAgentCurrentSelectedRef.current;
    outcomes.push([lane, saved === previous ? 'previous' : saved === successor ? 'successor' : 'captured']);
    current.close();
  }
  assert.deepEqual(outcomes, [['unchanged', 'captured'], ['input-successor', 'previous'], ['selection-ABA', 'successor'],
    ['owner-ABA', 'previous'], ['native-mutation', 'previous'], ['final-witness-reentry', 'successor']]);
});

test('R3 actual Panel driver-construction failure is explicit source error, never a fake capability, missing proof or React throw', async () => {
  let retains = 0;
  const prepared = { closed: false, retain() { retains++; throw Error('must not allocate after constructor error'); } };
  const f = admissionFrame({ prepared });
  // Exact constructor/runtime negative: structural Map has no Main profile
  // provenance. No fixture replacement of createHistoryAgentCatalogCurrent.
  f.input.context.terminalFacts = new Map();
  f.install(); assert.doesNotThrow(() => f.effects());
  assert.equal(f.updates.length, 1);
  const rejected = f.updates[0];
  assert.equal(rejected.current, null); assert.equal(rejected.sourceError.code, 'HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE');
  assert.equal(rejected.fullWitness(), false); assert.equal(rejected.ownerFence(), true);
  let snapshot = null;
  const owner = createHistoryPrimaryAgentCatalogOwner({ onChange: update => { snapshot = update(snapshot); } });
  owner.update(rejected); owner.select('task:still-selected');
  for (let index = 0; index < 30 && (owner.state().running || owner.state().pending); index++) await tick();
  assert.equal(snapshot.status, 'error'); assert.equal(snapshot.errorStage, 'source'); assert.equal(snapshot.counts, null);
  assert.equal(snapshot.selected.kind, 'unknown'); assert.equal(retains, 0);
  owner.requestPage({ section: 'roster', offset: 0, limit: 64 }); owner.requestMembership({ entries: ['held-row'] });
  await tick(); assert.equal(retains, 0); assert.equal(owner.state().running, null);
  owner.close(); f.close();
  const late = admissionFrame({ prepared });
  late.env.createHistoryAgentCatalogCurrent = () => { late.env.historyOwnerGenerationRef.current++;
    throw Object.assign(Error('reentrant construction failure'), { code: 'HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE' }); };
  late.install(); assert.doesNotThrow(() => late.effects());
  assert.equal(late.updates.length, 0, 'late constructor error cannot retarget the next original owner'); late.close();
});
