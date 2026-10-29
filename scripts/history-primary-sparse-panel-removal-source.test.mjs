// SOURCE controls: bounded verbatim Panel removal/capture/publication callbacks,
// actual native predicates and audit-identity grammar, actual sparse owner.
// The handoff inventory, React refs/updater and diagnostic/storage hooks are
// synthetic finite surfaces. No provider/native/Input/layout/paint claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { createHistoryPrimarySparsePublicationOwner } from '../src/renderer/utils/historyPrimarySparsePublication.mjs';

assert(getHeapStatistics().heap_size_limit <= 70 * 1024 ** 2, '64MiB old/2MiB semi runtime cap required');
const require = createRequire(import.meta.url), ts = require(process.env.NOTED_TYPESCRIPT_PATH || 'typescript');
assert.equal(ts.version, '5.9.3');
const panel = fs.readFileSync(new URL('../src/renderer/components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const handoffs = fs.readFileSync(new URL('../src/renderer/utils/historyPromptHandoffs.ts', import.meta.url), 'utf8');
function between(source, first, last, cap = 8192) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert(start >= 0 && end > start && source.indexOf(first, start + first.length) === -1, first);
  const fragment = source.slice(start, end); assert(Buffer.byteLength(fragment) < cap, 'bounded actual fragment');
  return fragment;
}
const fragments = {
  local: between(panel, 'const isLocalPromptEntry =', 'const findServerPromptEntry ='),
  meta: between(panel, '  const localPromptMetaOwnersRef =', '  // CURRENT publication fields are read afresh'),
  publish: between(panel, '  const publishHistoryRows = useCallback(', '  const primaryLocalPublicationAtRender ='),
  removal: between(panel, '  const captureLocalPromptRemoval =', '  const consumeLocalPromptEntry =', 12 * 1024),
  identity: between(handoffs, 'export function historyPromptHandoffAcceptsAuditIdentity(', '/** Exact provider evidence'),
};
const returns = {
  local: 'isLocalPromptEntry,isLocalRewindEntry,isLocalCompactErrorEntry', meta: 'getLocalPromptMetaOwner',
  publish: 'publishHistoryRows', removal: 'captureLocalPromptRemoval,removeLocalPromptEntry',
  identity: 'historyPromptHandoffAcceptsAuditIdentity',
};
const install = Object.fromEntries(Object.entries(fragments).map(([name, fragment]) => {
  // Removing only the export wrapper permits the actual pure function to run
  // in the same bounded lexical fixture as the literal Panel callbacks.
  const result = ts.transpileModule(fragment.replace(/^export /, ''), { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  assert.deepEqual(result.diagnostics, []);
  return [name, new Function('env', 'with(env){\n' + result.outputText + '\nreturn {' + returns[name] + '};\n}')];
}));
const sha = value => createHash('sha256').update(value).digest('hex');
console.log('V52_PANEL_SPARSE_REMOVAL_SOURCE ' + JSON.stringify({ panelSHA256: sha(panel), handoffsSHA256: sha(handoffs),
  fragments: Object.fromEntries(Object.entries(fragments).map(([name, value]) => [name, { sha256: sha(value), bytes: Buffer.byteLength(value) }])),
  node: process.version, typescript: ts.version, heapLimit: getHeapStatistics().heap_size_limit, electron: process.versions.electron || null,
}));
function rig({ onClassify = () => {}, rows = true } = {}) {
  const originalHandoff = { handoffId: 'h', sendOperationKey: 'operation', sendAttemptId: 'attempt' };
  const metadata = { text: 'full native author', sendOperationKey: 'operation', sendAttemptId: 'attempt' };
  const row = { uuid: 'local-prompt-one', role: 'queued', handoffId: 'h', sendOperationKey: 'operation', sendAttemptId: 'attempt' };
  const historical = { uuid: 'history', role: 'user', get content() { throw Error('NO_HISTORICAL_PAYLOAD'); } };
  const suppression = { text: 'original suppression' }, initial = rows ? [row, historical] : [historical];
  let active = originalHandoff, state = initial, armed = false, persisted = 0, revisions = 0;
  const env = { LOCAL_PROMPT_PREFIX: 'local-prompt-', LOCAL_REWIND_PREFIX: 'local-rewind-', LOCAL_COMPACT_ERROR_PREFIX: 'local-compact-error-',
    tabId: 'synthetic-tab', useCallback: fn => fn, useRef: current => ({ current }),
    presentationEntriesRef: { current: initial }, historyOwnerKeyRef: { current: 'A' }, historyOwnerGenerationRef: { current: 1 },
    promptHandoffMetaRef: { current: new Map([['h', metadata]]) }, suppressedPromptsRef: { current: new Map([['h', suppression]]) },
    getHistoryPromptHandoffsSnapshot: () => active ? [active] : [],
    setEntries: updater => { state = updater(state); }, historyDiag() {},
    historySnapshotOwner: {}, persistVolatileOverlay() { persisted++; }, setPrimarySuppressionRevision() { revisions++; },
  };
  for (const name of ['local', 'meta', 'identity']) Object.assign(env, install[name](env));
  const owner = createHistoryPrimarySparsePublicationOwner({ isLocal(value) {
    if (armed) onClassify(value, env);
    return env.isLocalPromptEntry(value) || env.isLocalRewindEntry(value) || env.isLocalCompactErrorEntry(value);
  } });
  env.primarySparsePublicationOwner = owner;
  const publication = owner.publishCompatibility(initial, { ownerKey: 'A', generation: 1 });
  for (const name of ['publish', 'removal']) Object.assign(env, install[name](env));
  const removal = env.captureLocalPromptRemoval('h'); assert(removal);
  return { env, owner, initial, row, historical, metadata, suppression, publication, removal,
    get state() { return state; }, get persisted() { return persisted; }, get revisions() { return revisions; },
    replaceHandoff(value) { active = value; }, get handoff() { return active; },
    remove() { armed = true; env.removeLocalPromptEntry('h', 'finite-source-control', removal); }, close() { owner.close(); } };
}
function unchanged(h) {
  assert.equal(h.state, h.initial); assert.equal(h.env.presentationEntriesRef.current, h.initial);
  assert.equal(h.owner.current(), h.publication); assert.equal(h.persisted, 0); assert.equal(h.revisions, 0);
  assert.equal(h.env.suppressedPromptsRef.current.get('h'), h.suppression);
}

test('actual removal commits its captured native row and retires only its original metadata/suppression', () => {
  const h = rig();
  try {
    h.remove(); assert.deepEqual(h.state, [h.historical]);
    assert.equal(h.env.presentationEntriesRef.current, h.state); assert.equal(h.owner.current().entries.deref(), h.state);
    assert.equal(h.owner.current().rows.length, 0); assert.equal(h.env.promptHandoffMetaRef.current.has('h'), false);
    assert.equal(h.env.suppressedPromptsRef.current.has('h'), false); assert.equal(h.persisted, 1); assert.equal(h.revisions, 1);
  } finally { h.close(); }
});

test('actual removal does not delete replacement same-H metadata created by the new classifier', () => {
  const replacement = { text: 'same-H replacement', sendOperationKey: 'operation', sendAttemptId: 'attempt' };
  const h = rig({ onClassify(_row, env) { env.promptHandoffMetaRef.current.set('h', replacement); } });
  try { h.remove(); unchanged(h); assert.equal(h.env.promptHandoffMetaRef.current.get('h'), replacement); }
  finally { h.close(); }
});

test('actual removal refuses a changed original removed H/O/A tuple after native classification', () => {
  let h;
  h = rig({ onClassify() { h.row.sendAttemptId = 'replacement-attempt'; } });
  try { h.remove(); unchanged(h); assert.equal(h.env.promptHandoffMetaRef.current.get('h'), h.metadata); }
  finally { h.close(); }
});

test('actual removal final cheap fence observes meta/H replacement caused by original row replay', () => {
  for (const kind of ['meta', 'handoff']) {
    const h = rig(); let reads = 0, replaced = false;
    const replacement = { handoffId: 'h', text: 'replacement', sendOperationKey: 'operation', sendAttemptId: 'attempt' };
    Object.defineProperty(h.row, 'sendOperationKey', { configurable: true, enumerable: true, get() {
      if (++reads === 2) {
        replaced = true;
        if (kind === 'meta') h.env.promptHandoffMetaRef.current.set('h', replacement);
        else h.replaceHandoff(replacement);
      }
      return 'operation';
    } });
    try { h.remove(); assert(replaced, 'positive native getter reentry'); unchanged(h); }
    finally { h.close(); }
  }
});

test('actual removal preserves ownerless same-length metadata cleanup without claiming a publication', () => {
  const h = rig({ rows: false });
  try {
    h.replaceHandoff(null); h.remove();
    assert.equal(h.state, h.initial); assert.equal(h.owner.current(), h.publication);
    assert.equal(h.env.promptHandoffMetaRef.current.has('h'), false); assert.equal(h.env.suppressedPromptsRef.current.has('h'), false);
    assert.equal(h.persisted, 0); assert.equal(h.revisions, 1);
  } finally { h.close(); }
});
