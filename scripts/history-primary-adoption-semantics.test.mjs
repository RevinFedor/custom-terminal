// V49 finite SOURCE controls. Actual producer, SQLite paging, signed-text
// children, shared IPC client, model, and verbatim bounded native predicates.
// Boundaries: synthetic canonical rows; private temporary NodeSQLite database;
// in-process IPC; synthetic window.require. No Electron/provider/input/paint.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import v8 from 'node:v8';
import { HistoryPrimaryRootReadModel, adoptHistoryPrimaryMetadata } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { normalizePromptImageIdentity } from '../src/renderer/utils/promptImageAttachments.mjs';
import { matchesHistoryPromptExactProof, matchesHistoryPromptAdoption } from '../src/renderer/utils/historyPromptPresentation.mjs';
import { buildHistoryLivePresentation } from '../src/renderer/utils/historyLiveProjection.mjs';

const require = createRequire(import.meta.url);
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
globalThis.window = { require };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
assert(v8.getHeapStatistics().heap_size_limit <= 256 * 1024 ** 2, 'finite source heap required');

const panel = fs.readFileSync(new URL('../src/renderer/components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const handoffs = fs.readFileSync(new URL('../src/renderer/utils/historyPromptHandoffs.ts', import.meta.url), 'utf8');
function cut(text, first, last) {
  const from = text.indexOf(first), to = text.indexOf(last, from + first.length);
  assert(from >= 0 && to > from, first);
  assert.equal(text.indexOf(first, from + first.length), -1, 'source marker must be unique');
  const result = text.slice(from, to);
  assert(Buffer.byteLength(result) < 16 * 1024, 'bounded exact source extraction only');
  return result;
}
const nativeSource = [
  "const LOCAL_PROMPT_PREFIX = 'local-prompt-'; const LOCAL_REWIND_PREFIX = 'local-rewind-'; const LOCAL_COMPACT_ERROR_PREFIX = 'local-compact-error-'; const LOCAL_PROMPT_FAILURE_TTL_MS=15000;",
  "const ORCHESTRATION_COMPLETION_HANDOFF_PREFIX='orchestration-complete:';const ORCHESTRATION_COMPLETION_SOURCE_PREFIX='orchestration-completion:';",
  cut(panel, 'const normalizeHistoryPromptText =', '\nconst promptPreview ='),
  cut(handoffs, 'export function legacyOrchestrationCompletionMatchesCanonicalEntry(', '\nexport function durableHistorySendReceiptMatchesCanonicalEntry(').replace('export function', 'function'),
  cut(handoffs, 'export function historyPromptFailureHasRecoveryOwner(', '\nexport function historyPromptHandoffRecoveryFields(').replace('export function', 'function'),
  cut(panel, 'const isLocalPromptEntry =', '\nconst historyActionPresentationEqual ='),
  'return {findServerPromptEntry,mergeServerAndLocalEntries,legacyOrchestrationCompletionMatchesCanonicalEntry,isLocalPromptEntry};',
].join('\n');
const native = new Function('normalizePromptImageIdentity', 'matchesHistoryPromptExactProof',
  'matchesHistoryPromptAdoption', 'buildHistoryLivePresentation', 'historyDiag',
  stripTypeScriptTypes('function extractedNativePredicates(){\n' + nativeSource + '\n}', { mode: 'strip' }) + '\nreturn extractedNativePredicates();')(
  normalizePromptImageIdentity, matchesHistoryPromptExactProof, matchesHistoryPromptAdoption,
  buildHistoryLivePresentation, () => {});

const TIME = Date.parse('2025-01-01T00:00:00.000Z');
const row = (uuid, content = 'prompt', extra = {}) => ({ role: 'user', uuid, sessionId: 's', timestamp: new Date(TIME).toISOString(), content, ...extra });
const local = (extra = {}) => ({ role: 'queued', uuid: 'local-prompt-t-h', content: 'prompt', timestamp: new Date(TIME).toISOString(), optimisticAt: TIME,
  handoffId: 'h', queueStatus: 'sent', ...extra });
const presentation = extra => ({ localEntries: [], liveEntries: [], liveToolResults: [],
  grouping: { enabled: false, threshold: 2, responseWork: true, expandedKeys: [] },
  captionSelections: [], settingsPresentationKeys: [], ...extra });

async function withModel(entries, run, options = {}) {
  const fixture = await createPrimaryAddressFixture(null, { entries });
  let intercept = options.intercept;
  const requests = [];
  const invoke = async (channel, payload) => {
    if (channel === 'agent-transcript:cancel-read') return { success: true };
    const reply = intercept ? await intercept(channel, payload, () => fixture.invoke(channel, payload))
      : await fixture.invoke(channel, payload);
    requests.push({ channel, payload, reply });
    return reply;
  };
  const model = new HistoryPrimaryRootReadModel(invoke, fixture.transport);
  model.windowDiagnostic = () => {};
  try {
    await model.open({ ...fixture.payload, primaryPresentation: presentation(options.presentation) });
    assert(model.header, 'real primary root positive control');
    await run({ fixture, model, requests, setIntercept(fn) { intercept = fn; } });
  } finally { await model.close(); fixture.close(); }
}

function nativeSelection(entries, prompt, options = {}) {
  const source = options.committed ? entries.filter(e => !native.isLocalPromptEntry(e) && !e.liveProjection) : entries;
  const excluded = options.excludedUuids || new Set();
  if (options.legacyHandoff) {
    const legacy = source.find(e => !excluded.has(e.uuid)
      && native.legacyOrchestrationCompletionMatchesCanonicalEntry(options.legacyHandoff, e));
    if (legacy) return { entry: legacy, legacy: true };
  }
  const entry = native.findServerPromptEntry(source, prompt, excluded);
  return entry ? { entry, legacy: false } : null;
}

async function compare(entries, prompt, options = {}) {
  const expected = nativeSelection(entries, prompt, options);
  await withModel(entries, async ({ model, requests }) => {
    const start = requests.length;
    Object.defineProperty(model, 'metadata', { configurable: true, get() { throw new Error('POISON_N_METADATA'); } });
    Object.defineProperty(model.view, 'metadata', { configurable: true, get() { throw new Error('POISON_VIEW_N_METADATA'); } });
    Object.defineProperty(model.view, 'serverMetadata', { configurable: true, get() { throw new Error('POISON_VIEW_N_SERVER_METADATA'); } });
    const actual = await model.readPromptAdoption(prompt, { scope: 'canonical', ...options });
    assert.equal(actual?.entry.uuid ?? null, expected?.entry.uuid ?? null);
    if (options.legacyHandoff) assert.equal(actual?.legacy ?? false, expected?.legacy ?? false);
    assert(requests.length > start, 'real selected read positive control');
    for (const request of requests.slice(start)) {
      if (request.channel === 'agent-transcript:read-page') {
        assert((request.payload.limit ?? 1) <= (request.payload.kind === 'leaf' ? 1024 : 3), 'bounded page items or signed UTF16 chunk');
        assert(Buffer.byteLength(JSON.stringify(request.reply)) <= 65536, 'bounded page wire');
      }
    }
  });
}

const cases = [
  ['empty canonical dedicated proof is absence', [], local()],
  ['first source row wins over a later direct uuid', [row('alias-first', '', { sourceIdentityAliases: ['exact'] }), row('exact')], local({ auditEntryUuid: 'exact' })],
  ['sourceUuidAliases are exact identities', [row('carrier', '', { sourceUuidAliases: ['audited'] })], local({ sourceIdentity: 'audited' })],
  ['typed selector trims but durable identity does not', [row(' spaced ')], local({ auditEntryUuid: ' spaced ' })],
  ['truthy malformed audit id closes fallback', [row('server')], local({ auditEntryUuid: {} })],
  ['truthy blank selector closes fallback', [row('server')], local({ sourceIdentity: ' \t ' })],
  ['malformed truthy first selector keeps typed second selector', [row('server', '', { sourceIdentity: 'source' })], local({ auditEntryUuid: 7, sourceIdentity: 'source' })],
  ['exact identity has no role or session gate', [row('server', '', { role: 'assistant', sessionId: 'other' })], local({ auditEntryUuid: 'server' })],
  ['fallback role gate rejects matching assistant', [row('assistant', 'prompt', { role: 'assistant' }), row('user')], local()],
  ['fallback invalid durable time is permitted', [row('invalid-date', 'prompt', { timestamp: 'not-a-date' })], local()],
  ['fallback lower time boundary is inclusive', [row('too-old', 'prompt', { timestamp: new Date(TIME - 5001).toISOString() }), row('edge', 'prompt', { timestamp: new Date(TIME - 5000).toISOString() })], local()],
  ['fallback has no upper timestamp bound or session gate', [row('future', 'prompt', { timestamp: new Date(TIME + 999999).toISOString(), sessionId: 'another' })], local()],
  ['no-ID audited recovery requires timestamp', [row('server')], local({ requiresAuditIdentity: true })],
  ['no-ID audited recovery preserves exact timestamp session', [row('wrong', 'prompt', { sessionId: 'other' }), row('right')], local({ requiresAuditIdentity: true, auditTimestamp: new Date(TIME).toISOString(), auditSessionId: 's' })],
  ['audit timestamp and session use strict primitive equality without coercion', [row('numeric', 'prompt', { timestamp: 7, sessionId: 8 })], local({ requiresAuditIdentity: true, auditTimestamp: 7, auditSessionId: 8 })],
  ['unused malformed alias elements do not invalidate direct UUID success', [row('server', 'prompt', { sourceIdentityAliases: [{ unused: true }, 9, 'alias'] })], local({ auditEntryUuid: 'server' })],
  ['whole normalized text keeps reminders paste whitespace and image identities', [row('normalized', ' \n <system-reminder>internal\ntext</system-reminder> [200~hello~]  [imagePath: /tmp/a.png]  world ')], local({ content: 'hello [Image #7] world' })],
  ['consumed uuid exclusion applies across every duplicate occurrence', [row('same'), row('same'), row('next')], local(), { excludedUuids: new Set(['same']) }],
  ['raw lookup includes local-like canonical source rows', [row('local-prompt-native', 'prompt', { role: 'queued' }), row('canonical')], local()],
  ['committed lookup excludes local and live before ordered predicate', [row('local-prompt-native', 'prompt', { role: 'queued' }), row('live', 'prompt', { liveProjection: true }), row('canonical')], local(), { committed: true }],
];
for (const [name, entries, prompt, options] of cases) test(name, () => compare(entries, prompt, options));

test('inline legacy keeps row order; shared legacy searches all rows before fallback', async () => {
  const entries = [row('earlier-fallback'), row('later-legacy', 'different', { role: 'assistant', semanticTags: [{ kind: 'orchestration', runId: 'run', phase: 'completion' }] })];
  const prompt = local({ handoffId: 'orchestration-complete: run ' });
  assert.equal(nativeSelection(entries, prompt).entry.uuid, 'earlier-fallback');
  await compare(entries, prompt);
  const handoff = { handoffId: 'orchestration-complete: run ', queueStatus: 'sent', source: 'orchestration-completion:run', sendOperationKey: null, sendAttemptId: null };
  assert.equal(nativeSelection(entries, prompt, { legacyHandoff: handoff }).entry.uuid, 'later-legacy');
  await compare(entries, prompt, { legacyHandoff: handoff });
  await compare(entries, prompt, { legacyHandoff: { ...handoff, sendAttemptId: 'attempt' } });
  await compare(entries, prompt, { legacyHandoff: handoff, excludedUuids: new Set(['later-legacy']) });
});

test('outer legacy match skips finder content coercion exactly as native consume', async () => {
  const content = [];
  Object.defineProperty(content, 'toString', { value() { throw new Error('FINDER_MUST_NOT_RUN'); } });
  const prompt = local({ content, handoffId: 'orchestration-complete:run' });
  const entries = [row('legacy', 'different', { semanticTags: [{ kind: 'orchestration', runId: 'run', phase: 'failure' }] })];
  const handoff = { handoffId: 'orchestration-complete:run', queueStatus: 'sent', source: '', sendOperationKey: null, sendAttemptId: null };
  assert.equal(nativeSelection(entries, prompt, { legacyHandoff: handoff }).entry.uuid, 'legacy');
  await compare(entries, prompt, { legacyHandoff: handoff });
});

test('ordinary finder coerces local content even for an exact match or empty rows', async () => {
  for (const entries of [[], [row('exact')]]) await withModel(entries, async ({ model }) => {
    const content = [];
    Object.defineProperty(content, 'toString', { value() { throw new Error('LOCAL_NATIVE_COERCION'); } });
    const prompt = local({ content, auditEntryUuid: 'exact' });
    assert.throws(() => native.findServerPromptEntry(entries, prompt), /LOCAL_NATIVE_COERCION/);
    await assert.rejects(model.readPromptAdoption(prompt, { scope: 'canonical' }), /LOCAL_NATIVE_COERCION/);
  });
});

test('empty finder never reads unused audit selectors after its eager normalization', async () => {
  const prompt = local();
  Object.defineProperty(prompt, 'auditEntryUuid', { get() { throw new Error('UNUSED_AUDIT_SELECTOR'); } });
  assert.equal(native.findServerPromptEntry([], prompt), undefined);
  await compare([], prompt);
});

test('inline legacy winner does not read poisoned exact selectors', async () => {
  const prompt = local({ handoffId: 'orchestration-complete:run' });
  Object.defineProperty(prompt, 'auditEntryUuid', { get() { throw new Error('LEGACY_MUST_SHORT_CIRCUIT_AUDIT'); } });
  const entries = [row('legacy', 'different', { semanticTags: [{ kind: 'orchestration', runId: 'run', phase: 'completion' }] })];
  assert.equal(native.findServerPromptEntry(entries, prompt).uuid, 'legacy');
  await compare(entries, prompt);
});

test('exact winner does not read fallback-only audit timestamp or requirement getters', async () => {
  const prompt = local({ auditEntryUuid: 'exact' });
  for (const key of ['requiresAuditIdentity', 'auditTimestamp', 'auditSessionId']) {
    Object.defineProperty(prompt, key, { get() { throw new Error('UNUSED_FALLBACK_' + key); } });
  }
  assert.equal(native.findServerPromptEntry([row('exact')], prompt).uuid, 'exact');
  await compare([row('exact')], prompt);
});

test('truthy optimisticAt remains uncoerced in exact and invalid-time fallback arms', async () => {
  await compare([row('exact')], local({ auditEntryUuid: 'exact', optimisticAt: 1n }));
  await compare([row('invalid', 'prompt', { timestamp: 'invalid-date' })], local({ optimisticAt: 1n }));
  await withModel([row('finite-date')], async ({ model }) => {
    const prompt = local({ optimisticAt: 1n });
    assert.throws(() => native.findServerPromptEntry([row('finite-date')], prompt), TypeError);
    await assert.rejects(model.readPromptAdoption(prompt, { scope: 'canonical' }), TypeError);
  });
});

test('long escaped aliases and full UTF16 content use signed children without truncation', async () => {
  const selector = ('\\"\u0000\ud83d\ude42\ud800').repeat(1400) + 'tail';
  await compare([row('first', '', { sourceUuidAliases: [selector.slice(0, -1) + 'x'] }), row('selected', '', { sourceIdentityAliases: ['unused', selector] })], local({ auditEntryUuid: selector }));
  const body = ('a\ud83d\ude42\ud800 \t\n').repeat(1500) + ' END';
  await compare([row('prefix-only', body.slice(0, -3) + 'BAD'), row('complete', body)], local({ content: body }));
});

test('per-pass exclusions survive async reads and reserve duplicate uuid before downstream failure', async () => {
  await withModel([row('same'), row('same'), row('second')], async ({ model }) => {
    const exclusions = new Set();
    const first = await model.readPromptAdoption(local(), { scope: 'canonical', excludedUuids: exclusions });
    assert.equal(first.entry.uuid, 'same'); exclusions.add(first.entry.uuid);
    // A synthetic failed enrichment deliberately does not release reservation.
    try { throw new Error('ENRICHMENT_FAILED'); } catch {}
    const second = await model.readPromptAdoption(local({ handoffId: 'h2' }), { scope: 'canonical', excludedUuids: exclusions });
    assert.equal(second.entry.uuid, 'second');
  });
});

test('selected alias graph and native attachment length truth survive matched-only projection', async () => {
  const aliases = [{ unused: true }, , 'audit'];
  const entry = row('selected', 'body', { role: 'assistant', sourceIdentityAliases: aliases,
    sourceUuidAliases: ['uuid-alias', undefined], promptChips: 'present', imagePaths: { length: 2 } });
  await withModel([entry], async ({ model }) => {
    const proof = await model.readPromptAdoption(local({ auditEntryUuid: 'selected' }), { scope: 'canonical' });
    assert.equal(proof.entry.uuid, 'selected');
    assert.deepEqual(proof.entry.sourceIdentityAliases, aliases);
    assert.equal(1 in proof.entry.sourceIdentityAliases, false, 'sparse alias stays sparse');
    assert.deepEqual(proof.entry.sourceUuidAliases, entry.sourceUuidAliases);
    assert.equal(proof.hasPromptChips, true, 'native truthy .length, not Array.isArray');
    assert.equal(proof.hasImagePaths, true, 'native object .length, not Array.isArray');
  });
});

test('rejected selected read stays UNKNOWN and cannot become false or fallback', async () => {
  await withModel([row('server')], async ({ model, setIntercept }) => {
    setIntercept((channel, payload, next) => channel === 'agent-transcript:read-page' && payload.kind === 'primary-canonical-consumers'
      ? { success: false, error: 'SYNTHETIC_SELECTED_READ_UNKNOWN' } : next());
    await assert.rejects(model.readPromptAdoption(local(), { scope: 'canonical' }));
    assert.equal(model.closed, false, 'query does not own parent lease');
  });
});

test('public canonical query rejects caller-supplied prepared substitution authority', async () => {
  await withModel([row('unrelated', 'different')], async ({ model }) => {
    await assert.rejects(model.readPromptAdoption(local(), {
      scope: 'canonical', preparedRow: () => row('forged', 'prompt'),
    }), { code: 'HISTORY_PRIMARY_PROMPT_QUERY_INVALID' });
  });
});

test('stale current owner during await cannot publish a selected match', async () => {
  await withModel([row('server')], async ({ model, setIntercept }) => {
    let owns = true;
    setIntercept(async (channel, payload, next) => {
      const reply = await next();
      if (channel === 'agent-transcript:read-page' && payload.kind === 'primary-canonical-consumers') owns = false;
      return reply;
    });
    await assert.rejects(model.readPromptAdoption(local(), { scope: 'canonical', owns: () => owns }), { code: 'HISTORY_READ_CANCELLED' });
  });
});

test('in-place local content mutation during await is stale, including cyclic graphs', async () => {
  await withModel([row('server')], async ({ model, setIntercept }) => {
    const prompt = local(); prompt.self = prompt;
    setIntercept(async (channel, payload, next) => {
      const reply = await next();
      if (channel === 'agent-transcript:read-page' && payload.kind === 'primary-canonical-consumers') prompt.content = 'NEW LOCAL';
      return reply;
    });
    await assert.rejects(model.readPromptAdoption(prompt, { scope: 'canonical' }), { code: 'HISTORY_READ_CANCELLED' });
  });
});

test('final inherited native coercion cannot return a proof after reentrant disposal', async () => {
  let cleanup;
  await withModel([row('server')], async ({ model }) => {
    let coercions = 0;
    const content = [], proto = Object.create(Array.prototype);
    Object.defineProperty(proto, 'join', { value() {
      coercions++;
      if (coercions === 2) cleanup = model.close();
      return 'prompt';
    } });
    Object.setPrototypeOf(content, proto);
    const prompt = local({ content, auditEntryUuid: 'server' }); prompt.self = prompt;
    await assert.rejects(model.readPromptAdoption(prompt, { scope: 'canonical' }), { code: 'HISTORY_READ_CANCELLED' });
    assert.equal(coercions, 2, 'dispatch and final native grammar witnesses');
    assert.equal(model.closed, true);
  });
  await cleanup;
});

test('public proof-current witness catches inherited grammar changes after query return', async () => {
  await withModel([row('server')], async ({ model }) => {
    let text = 'prompt', isCurrent;
    const content = [], proto = Object.create(Array.prototype);
    Object.defineProperty(proto, 'join', { value() { return text; } });
    Object.setPrototypeOf(content, proto);
    const proof = await model.readPromptAdoption(local({ content }), { scope: 'canonical', onProof: check => { isCurrent = check; } });
    assert.equal(proof.entry.uuid, 'server');
    assert.equal(typeof isCurrent, 'function'); assert.equal(isCurrent(), true);
    text = 'new authoring without graph mutation';
    assert.equal(isCurrent(), false);
  });
});

test('current long-selector normalization work does not grow with historical row count', async () => {
  const selector = ' '.repeat(2048) + 'never-present-selector' + '\t'.repeat(2048);
  const originalTrim = String.prototype.trim, results = [];
  let visits = 0;
  String.prototype.trim = function () {
    if (String(this) === selector) visits++;
    return originalTrim.call(this);
  };
  try {
    for (const count of [0, 1, 4, 8]) {
      await withModel(Array.from({ length: count }, (_, i) => row('canonical-' + i, 'unrelated')), async ({ model }) => {
        visits = 0;
        const proof = await model.readPromptAdoption(local({ auditEntryUuid: selector }), { scope: 'canonical' });
        assert.equal(proof, null);
        results.push({ historicalRows: count, currentSelectorUTF16: selector.length, currentSelectorTrimVisits: visits });
      });
    }
  } finally { String.prototype.trim = originalTrim; }
  console.log('V49_CURRENT_SELECTOR_WORK ' + JSON.stringify({ results, claim: 'work counts only; not CPU/latency/RSS' }));
  assert.equal(results[0].currentSelectorTrimVisits, 0, 'empty ordinary find never enters exact selector branch');
  assert(results[1].currentSelectorTrimVisits > 0, 'instrumentation positive control');
  assert(results.slice(1).every(value => value.currentSelectorTrimVisits === results[1].currentSelectorTrimVisits),
    'current full selector trim work must be independent of historical row count');
});

test('onProof callback cannot dispose the model and still return a public result', async () => {
  let cleanup;
  await withModel([row('server')], async ({ model }) => {
    await assert.rejects(model.readPromptAdoption(local(), { scope: 'canonical', onProof() { cleanup = model.close(); } }), { code: 'HISTORY_READ_CANCELLED' });
  });
  await cleanup;
});

test('abort after selected text child allocation closes only independent query leases', async () => {
  await withModel([row('server', 'x'.repeat(7000))], async ({ model, fixture, setIntercept }) => {
    const abort = new AbortController();
    const held = model.header.leaseId;
    setIntercept(async (channel, payload, next) => {
      const reply = await next();
      if (channel === 'agent-transcript:fork-read-leaf') abort.abort();
      return reply;
    });
    await assert.rejects(model.readPromptAdoption(local({ content: 'x'.repeat(7000) }), { scope: 'canonical', signal: abort.signal }), { code: 'HISTORY_READ_CANCELLED' });
    assert.equal(model.header.leaseId, held);
    assert(fixture.calls.some(c => c.channel === 'agent-transcript:release-read-root' && c.leaseId !== held), 'independent child cleanup positive control');
  });
});

test('native compatibility positive control still performs the real array finder', () => {
  const rows = [row('server')]; let reads = 0;
  Object.defineProperty(rows, 'find', { value(...args) { reads++; return Array.prototype.find.apply(this, args); } });
  assert.equal(native.findServerPromptEntry(rows, local()).uuid, 'server'); assert.equal(reads, 1);
});

test('legacy metadata adopter retains its mixed prepared domain and missing-only duplicate decoration', () => {
  const early = local({ uuid: 'local-prompt-early', handoffId: 'early', content: 'changed' });
  const late = local({ uuid: 'local-prompt-late', handoffId: 'late', content: 'changed', promptChips: [{ type: 'text', value: 'author' }] });
  const current = [early, late];
  const prepared = [{ ...early, content: 'old', rowStub: true }, row('unrelated', 'other')];
  const result = adoptHistoryPrimaryMetadata(prepared, current, [early], { isLocal: native.isLocalPromptEntry, mergeLate: native.mergeServerAndLocalEntries });
  assert(result.some(e => e.uuid === early.uuid)); assert(!result.some(e => e.uuid === late.uuid));
  const duplicate = native.mergeServerAndLocalEntries([row('duplicate'), row('duplicate')], [local({ promptChips: late.promptChips })]);
  assert.equal(duplicate[0].promptChips, late.promptChips); assert.equal(duplicate[1].promptChips, late.promptChips);
});

test('actual provisional late adoption searches current replacement inside mixed prepared domain', async () => {
  const captured = local({ uuid: 'local-prompt-captured', handoffId: 'captured', content: 'original' });
  const current = { ...captured, content: 'changed after dispatch', promptChips: [{ kind: 'prompt', text: 'current chip' }] };
  const late = local({ uuid: 'local-prompt-late', handoffId: 'late', content: current.content });
  await withModel([row('canonical-other', 'different')], async ({ model, fixture }) => {
    let committed, selected;
    const result = await model.open({ ...fixture.payload, primaryPresentation: presentation({ localEntries: [captured] }) }, {
      prepareAdopt: async candidate => {
        selected = await candidate.preparePromptAdoption(candidate.metadata.entries, [current, late], [captured], { isLocal: native.isLocalPromptEntry });
        return selected;
      },
      adopt: (_root, proof) => { assert.equal(proof, selected); assert(proof.isCurrent()); committed = proof.entries; },
    });
    assert.equal(result.kind, 'root');
    assert(committed.some(e => e === current), 'complete current captured local owner survives');
    assert(!committed.some(e => e.uuid === late.uuid), 'late local matches current mixed prepared local');
    assert.equal(current.promptChips[0].text, 'current chip');
  });
});

test('removed captured local cannot satisfy late prepared query or be resurrected', async () => {
  const captured = local({ uuid: 'local-prompt-removed', handoffId: 'removed', content: 'same text' });
  const late = local({ uuid: 'local-prompt-late', handoffId: 'late', content: 'same text' });
  await withModel([row('canonical-other', 'different')], async ({ model, fixture }) => {
    let committed;
    await model.open({ ...fixture.payload, primaryPresentation: presentation({ localEntries: [captured] }) }, {
      prepareAdopt: candidate => candidate.preparePromptAdoption(candidate.metadata.entries, [late], [captured], { isLocal: native.isLocalPromptEntry }),
      adopt: (_root, proof) => { committed = proof.entries; },
    });
    assert(!committed.some(e => e.uuid === captured.uuid));
    assert(committed.some(e => e === late));
  });
});

test('late native replacement coercion is revalidated before provisional publication', async () => {
  const captured = local({ uuid: 'local-prompt-captured', handoffId: 'captured', content: 'original' });
  const late = local({ uuid: 'local-prompt-late', handoffId: 'late', content: 'same' });
  let cleanup;
  await withModel([row('canonical-other', 'different')], async ({ model, fixture }) => {
    let coercions = 0, publications = 0;
    const content = [], proto = Object.create(Array.prototype);
    Object.defineProperty(proto, 'join', { value() {
      coercions++;
      if (coercions === 2) cleanup = model.close();
      return 'same';
    } });
    Object.setPrototypeOf(content, proto);
    const current = { ...captured, content };
    await assert.rejects(model.open({ ...fixture.payload, primaryPresentation: presentation({ localEntries: [captured] }) }, {
      prepareAdopt: candidate => candidate.preparePromptAdoption(candidate.metadata.entries, [current, late], [captured], { isLocal: native.isLocalPromptEntry }),
      adopt: () => { publications++; },
    }), { code: 'HISTORY_READ_CANCELLED' });
    assert.equal(coercions, 2); assert.equal(publications, 0);
  });
  await cleanup;
});

test('late prepared pass keeps one UUID reservation for the entire current-local group', async () => {
  const captured = local({ uuid: 'local-prompt-captured', handoffId: 'captured', content: 'same' });
  const first = local({ uuid: 'local-prompt-first', handoffId: 'first', content: 'same' });
  const second = local({ uuid: 'local-prompt-second', handoffId: 'second', content: 'same' });
  await withModel([row('canonical-other', 'different')], async ({ model, fixture }) => {
    let committed;
    await model.open({ ...fixture.payload, primaryPresentation: presentation({ localEntries: [captured] }) }, {
      prepareAdopt: candidate => candidate.preparePromptAdoption(candidate.metadata.entries, [captured, first, second], [captured], { isLocal: native.isLocalPromptEntry }),
      adopt: (_root, proof) => { committed = proof.entries; },
    });
    assert(committed.some(e => e === captured));
    assert(!committed.some(e => e.uuid === first.uuid));
    assert(committed.some(e => e === second), 'reservation survives first async read');
  });
});

test('same-array local membership mutation during late selection cancels provisional publication', async () => {
  const captured = local({ uuid: 'local-prompt-captured', handoffId: 'captured', content: 'captured' });
  const late = local({ uuid: 'local-prompt-late', handoffId: 'late', content: 'late' });
  const current = [captured, late];
  await withModel([row('canonical-other', 'different')], async ({ model, fixture, setIntercept }) => {
    const oldHeader = model.header;
    let selecting = false, mutations = 0, publications = 0;
    setIntercept(async (channel, payload, next) => {
      const reply = await next();
      if (selecting && !mutations && channel === 'agent-transcript:read-page' && payload.kind === 'primary-canonical-consumers') {
        mutations++; current.push(local({ uuid: 'local-prompt-newest', handoffId: 'newest', content: 'newest' }));
      }
      return reply;
    });
    await assert.rejects(model.open({ ...fixture.payload, primaryPresentation: presentation({ localEntries: [captured] }) }, {
      prepareAdopt: candidate => { selecting = true; return candidate.preparePromptAdoption(candidate.metadata.entries, current, [captured], { isLocal: native.isLocalPromptEntry }); },
      adopt: () => { publications++; },
    }), { code: 'HISTORY_READ_CANCELLED' });
    assert.equal(mutations, 1, 'actual await mutation control');
    assert.equal(publications, 0); assert.equal(model.header, oldHeader);
    assert.equal(current.at(-1).handoffId, 'newest', 'new authoring data retained');
  });
});

test('model revalidates prepared proof after finishPresentation reentrant cleanup', async () => {
  await withModel([row('canonical')], async ({ model, fixture }) => {
    let current = true, published = 0;
    const finish = model.finishPresentation.bind(model);
    model.finishPresentation = (...args) => { finish(...args); current = false; };
    await assert.rejects(model.open({ ...fixture.payload, primaryPresentation: presentation() }, {
      prepareAdopt: async () => ({ entries: [], isCurrent: () => current }),
      adopt: () => { published++; },
    }), { code: 'HISTORY_READ_CANCELLED' });
    assert.equal(published, 0);
  });
});

console.log('V49_SEMANTIC_BOUNDARIES ' + JSON.stringify({ nativeSourceBytes: Buffer.byteLength(nativeSource),
  heapLimit: v8.getHeapStatistics().heap_size_limit,
  boundaries: ['synthetic canonical rows', 'private NodeSQLite database', 'in-process IPC', 'window.require'],
  notAttested: ['native', 'Electron', 'provider', 'paint', 'CPU', 'latency', 'RSS'] }));
