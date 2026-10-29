// Finite SOURCE differential controls. Node 24 SQLite adapter/in-process IPC
// and already parsed canonical input are the fixture boundaries. No Electron,
// Mac runtime, user transcript, native acceptance or process-memory claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { HistoryPrimaryRootReadModel } from './historyPrimaryRootReadModel.mjs';
import { historyLivePresentationIdentities } from './historyLiveProjection.mjs';
import { historyTerminalPreviewHasCanonicalIdentity, resolveHistoryTerminalPreviewCanonicalTarget } from './historyTerminalPreviewHandoff.mjs';
import { readHistoryThroughIpc } from './historyReadTransport.mjs';

const require = createRequire(import.meta.url);
globalThis.window = { require };
const { createPrimaryAddressFixture } = require('../../../scripts/test-support/history-primary-address-fixture.cjs');
const { materializeHistoryCursorSync: materialize } = require('../../main/history-root-engine/main/history-paged-store.js');
const cancelled = error => error?.code === 'HISTORY_READ_CANCELLED';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const presentation = extra => ({ localEntries: [], liveEntries: [], liveToolResults: [],
  grouping: { enabled: false, threshold: 2, expandedKeys: [] }, captionSelections: [], settingsPresentationKeys: [], ...extra });
const row = (uuid, role, content, extra = {}) => ({ uuid, role, content, sessionId: 's',
  timestamp: '2026-10-27T00:00:00.000Z', ...extra });
const receipt = (promptText, fileSize = 10, extra = {}) => ({ state: 'not-submitted', surface: 'desktop-history',
  sessionId: 's', receipt: { promptText }, transcriptBoundary: { available: true, sessionId: 's', fileSize }, ...extra });

// Execute the actual current TS predicate, with only type erasure. This is
// deliberately not a handwritten equivalent of the implementation under test.
const source = readFileSync(new URL('./historyPromptHandoffs.ts', import.meta.url), 'utf8');
const start = source.indexOf('const normalizeDurableDraftText =');
const end = source.indexOf('export function applyHistoryQueuedMessageMerge', start);
assert(start >= 0 && end > start);
const oracleSource = stripTypeScriptTypes(source.slice(start, end), { mode: 'strip' });
const receiptOracle = Function(oracleSource.replace('export function ', 'function ')
  + '\nreturn durableHistoryNotSubmittedReceiptMatchesLaterCanonicalEntry;')();
const matches = (entry, identity) => historyTerminalPreviewHasCanonicalIdentity(entry, identity, historyLivePresentationIdentities);

async function setup(entries, { inputs = {}, open = {}, intercept = async () => undefined, actualTransport = false, proofOnlyHeldView = false } = {}) {
  const f = await createPrimaryAddressFixture(null, { entries });
  const calls = [];
  const invoke = async (channel, payload) => {
    let result = await intercept(channel, payload, f);
    if (result === undefined) result = channel === 'agent-transcript:cancel-read' ? { success: true } : await f.invoke(channel, payload);
    calls.push({ channel, kind: payload?.kind, mode: payload?.mode, scope: payload?.scope,
      nodeToken: payload?.nodeToken, leaseId: payload?.leaseId, operation: payload?.operation, field: payload?.field,
      offset: payload?.offset, limit: payload?.limit, count: result?.items?.length, done: result?.done,
      child: result?.payloadDocument?.leaseId, demand: payload?.readDemandId,
      requestBytes: Buffer.byteLength(JSON.stringify(payload)), replyBytes: Buffer.byteLength(JSON.stringify(result)) });
    return result;
  };
  const model = new HistoryPrimaryRootReadModel(invoke,
    actualTransport ? { ...f.transport, readHistoryThroughIpc } : f.transport);
  model.windowDiagnostic = () => {};
  try {
    if (proofOnlyHeldView) {
      // Explicit layer control only: the current N metadata decoder refuses
      // some giant scalars before production model.open can adopt this root.
      // This held-view substitution is NOT connected-path acceptance.
      const opened = await f.transport.openHistoryRootThroughIpc(invoke, 'agent-transcript:get-history',
        { ...f.payload, primaryPresentation: presentation(inputs), ...open }, { pageBytes: 65536, pageItems: 3 });
      assert.equal(opened.kind, 'root');
      model.view = { header: opened.header, root: opened.root, reader: opened.reader, metadata: Object.freeze({ fixtureOnly: true }) };
    } else await model.open({ ...f.payload, primaryPresentation: presentation(inputs), ...open });
  }
  catch (error) { await model.close(); f.close(); throw error; }
  const p = f.plane.state(model.view.root, f.consumerKey).primaryPresentation;
  const canonical = materialize(p.toolCoverageInputs().entries), prepared = materialize(p.presentationSource());
  const units = Array.from({ length: model.totalCount }, (_, rank) => materialize(p.unitAt(rank)));
  const unitIndexByUuid = new Map();
  for (let index = 0; index < units.length; index++) {
    const entries = units[index].kind === 'group' ? units[index].entries : [units[index].entry];
    for (const member of entries) if (member?.uuid) unitIndexByUuid.set(member.uuid, index);
  }
  const before = calls.length, metadata = model.metadata;
  Object.defineProperty(model, 'metadata', { configurable: true, get() { throw new Error('NEW_CONSUMER_TOUCHED_N_METADATA'); } });
  const membershipOracle = identity => {
    const selected = prepared.find(entry => matches(entry, identity));
    const target = resolveHistoryTerminalPreviewCanonicalTarget({ canonicalIdentity: identity, displayEntries: prepared,
      displayUnits: units, unitIndexByUuid, identitiesForEntry: historyLivePresentationIdentities });
    return { canonicalPresent: canonical.some(entry => matches(entry, identity)), preparedPresent: !!selected,
      preparedTextHash: selected ? createHash('sha256').update(String(selected.content || '').trim(), 'utf8').digest('hex') : null,
      target: target ? { ...target, physicalKey: materialize(p.headerAt(target.unitIndex).field('physicalKey')) } : null };
  };
  const verifyBounds = () => {
    const reads = calls.slice(before), metadataTokens = [model.header.sourceMetadata.nodeToken, model.header.durableMetadata.nodeToken];
    assert.equal(model.view.metadata, metadata, 'old metadata owner preserved');
    assert.equal(model.window.size, 0, 'selected proofs do not hydrate body windows');
    assert(!reads.some(call => metadataTokens.includes(call.nodeToken) && call.kind !== 'primary-canonical-consumers'));
    assert(!reads.some(call => call.channel === 'agent-transcript:get-history'), 'no fresh fetch or legacy fallback');
    for (const call of reads) {
      assert(call.requestBytes <= 65536); assert(call.replyBytes <= 65536);
      assert(call.count == null || call.count <= 3);
      if (call.kind === 'leaf') assert(call.limit <= 1024);
      assert(!/delete|remove|send|stop|rewind|update/.test(call.channel), 'no mutation capability');
    }
    assert(f.store.stats().peakCachedPages <= 3); assert(f.plane.stats().maxPacketBytes <= 65536);
  };
  return { f, model, calls, before, canonical, prepared, units, membershipOracle, verifyBounds,
    async close() { delete model.metadata; await model.close(); f.close(); } };
}

test('actual receipt oracle: full UTF16 normalization, exact boundary/session/role and no metadata reads', async () => {
  // Three leading trim code units put CR at1023 and LF at1024.
  const text = 'x'.repeat(1020) + '\r\n' + '😀\0\ud800\udc00\ud800' + '\uFEFF middle\t end';
  const long = '\0\ud800Ω'.repeat(12000) + 'END';
  const x = await setup([
    row('earlier', 'user', 'older same', { recordByteOffset: 9 }),
    row('wrong-role', 'assistant', 'wanted', { recordByteOffset: 99 }),
    row('wrong-session', 'user', 'wanted', { sessionId: 'other', recordByteOffset: 99 }),
    row('actual', 'user', '\uFEFF \t' + text + '\r\n \u2000', { recordByteOffset: 10 }),
    row('long', 'user', long, { recordByteOffset: '0000000000000000000000000000010', timestamp: 'past' }),
    row('array-content', 'user', ['first', null, ['inner', 'tail']], { recordByteOffset: false }),
    row('number-content', 'user', 42, { recordByteOffset: '' }),
    row('absent-offset', 'user', 'absent offset'),
  ]);
  try {
    const cases = [receipt(text), receipt(text.replace(/\r\n/g, '\n')), receipt(text + 'x'), receipt(long),
      receipt(long.slice(0, -1) + 'X'), receipt('older same'), receipt('wanted'), receipt('absent offset', 0),
      receipt('first,,inner,tail', 0), receipt('42', 0), receipt('42', null), receipt('42', false),
      receipt('42', ''), receipt('42', 10, { transcriptBoundary: {} }), receipt(' \uFEFF \r\n '), receipt(text, 11),
      receipt(text, 10, { sessionId: ' s' }), receipt(text, 10, { sessionId: 7 }),
      receipt(text, 10, { state: 'confirmed' }), receipt(text, 10, { surface: 'terminal' }),
      receipt(text, 10, { transcriptBoundary: { available: false, fileSize: 10 } }),
      receipt(text, 10, { transcriptBoundary: { fileSize: 10, sessionId: 'wrong' } }),
      receipt(text, 10, { transcriptBoundary: { fileSize: 10, sessionId: 1 } }),
      receipt(text, 10, { transcriptBoundary: { fileSize: -1 } }), receipt(text, NaN), receipt(text, Infinity)];
    for (const record of cases) assert.equal(await x.model.hasLaterCanonicalReceipt(record),
      x.canonical.some(entry => receiptOracle(record, entry)));
    assert(x.calls.slice(x.before).some(call => call.scope === 'canonical' && call.done === true));
    x.verifyBounds();
  } finally { await x.close(); }
});

test('N metadata giant scalar remains OPEN; isolated actual held-view query preserves complete selected BigInt coercion', async () => {
  const rows = [
    row('huge-offset', 'user', 'offset text', { recordByteOffset: BigInt('9'.repeat(80)) }),
    row('later-valid', 'user', 'offset text', { recordByteOffset: 10 }),
    row('aliases', 'assistant', 'content', { sourceIdentityAliases: [false, 0, NaN, 17n, BigInt('7'.repeat(80)), ['nested', null], {}] }),
  ];
  await assert.rejects(setup(rows), error => error?.code === 'HISTORY_ROOT_VALUE_INVALID',
    'recorded pre-existing full model.open metadata decoder gap, not whole-path acceptance');
  const x = await setup(rows, { proofOnlyHeldView: true });
  try {
    const record = receipt('offset text');
    assert.equal(await x.model.hasLaterCanonicalReceipt(record), x.canonical.some(entry => receiptOracle(record, entry)));
    for (const identity of ['17', '7'.repeat(80), 'nested,', '[object Object]', 'false', 'NaN', '0']) {
      const { header, ...proof } = await x.model.readTerminalPreviewMembership(identity);
      assert.deepEqual(proof, x.membershipOracle(identity));
    }
    x.verifyBounds();
  } finally { await x.close(); }
});

test('actual live oracle: aliases, assistant fallback, queue identity, full hash and selected target', async () => {
  const longIdentity = '\0\ud800'.repeat(9000) + 'tail';
  const hashText = '\uFEFF \n' + 'a'.repeat(1023) + '😀\ud800\0\udc00' + ' z '.repeat(800) + '\u3000';
  const x = await setup([
    row('raw-assistant', 'assistant', hashText, { sourceIdentity: 'source',
      sourceIdentityAliases: ['assistant-uuid:alias-raw', ' exact ', 17, ['A', null, ['B']], {}, longIdentity], sourceUuidAliases: ['not-semantic'] }),
    row('ordinary-user', 'user', 'authored', { sourceIdentity: 'user-source' }),
    row('slash-id', 'slash', '/model m'), row('error-id', 'provider-error', 'fault'), row('limit-id', 'usage-limit', 'limit'),
    row('queue-id', 'queued', [' [200~one', { type: 'text', text: '\n<system-reminder>hidden\nline</system-reminder> two~] ' }]),
    row('same-text', 'assistant', hashText),
  ]);
  try {
    const queue = x.canonical.flatMap(historyLivePresentationIdentities).find(value => value.startsWith('claude-queue:'));
    const ids = ['source', 'raw-assistant', 'assistant-uuid:raw-assistant', 'alias-raw', 'assistant-uuid:alias-raw',
      ' exact ', 'exact', '17', 'A,,B', '[object Object]', longIdentity, longIdentity + 'x', 'not-semantic',
      'user-uuid:ordinary-user', 'ordinary-user', 'slash-uuid:s:slash-id', 'provider-error-uuid:s:error-id',
      'usage-limit-uuid:s:limit-id', queue, hashText, 'missing'];
    for (const identity of ids) {
      assert.equal(typeof identity, 'string');
      const actual = await x.model.readTerminalPreviewMembership(identity);
      assert.equal(actual.header, x.model.header);
      const { header, ...proof } = actual;
      assert.deepEqual(proof, x.membershipOracle(identity), identity.slice(0, 40));
    }
    assert.equal(x.membershipOracle('alias-raw').canonicalPresent, true, 'assistant prefixed source alias fallback');
    x.verifyBounds();
  } finally { await x.close(); }
});

test('actual canonical versus prepared sources, collapsed/expanded groups and duplicate UUID last Map write', async () => {
  const call = (uuid, tool, extra) => row(uuid, 'assistant', '', { actions: [{ tool: '__raw__', rawTool: {
    toolUseId: tool, toolName: 'Read', family: 'read', args: { file_path: '/finite' }, result: 'full' } }], ...extra });
  const rows = [row('first', 'assistant', 'early', { sourceIdentity: 'same-identity' }),
    call('duplicate', 'call-1', { sourceIdentity: 'hidden' }), call('group-end', 'call-2'),
    row('boundary', 'user', 'stop group'), row('duplicate', 'assistant', 'late', { sourceIdentity: 'other' }),
    row('first', 'assistant', 'last same UUID', { sourceIdentityAliases: ['same-identity'] })];
  let groupKey;
  for (const expanded of [false, true]) {
    const expandedKeys = expanded ? [groupKey] : [];
    const x = await setup(rows, { inputs: { grouping: { enabled: true, threshold: 2, expandedKeys },
      liveEntries: [row('live-only', 'assistant', 'live full text', { sourceIdentity: 'only-prepared', liveProjection: true })] } });
    try {
      const group = x.units.find(unit => unit.kind === 'group');
      assert(group, 'finite real grouped unit exists');
      if (!expanded) groupKey = group.key;
      else assert.equal(group.expanded, true, 'second case actually expanded the exact current group key');
      for (const identity of ['same-identity', 'hidden', 'duplicate', 'group-end', 'only-prepared', 'missing']) {
        const { header, ...proof } = await x.model.readTerminalPreviewMembership(identity);
        assert.deepEqual(proof, x.membershipOracle(identity));
      }
      assert.equal(x.membershipOracle('only-prepared').canonicalPresent, false);
      assert.equal(x.membershipOracle('only-prepared').preparedPresent, true);
      assert.equal(x.membershipOracle('hidden').target, null, 'last duplicate UUID unit lacks selected identity');
      x.verifyBounds();
    } finally { await x.close(); }
  }
});

test('actual target Map preserves cross-type UUID collision and nonstring group DOM UUID', async () => {
  const call = (uuid, tool, extra) => row(uuid, 'assistant', '', { actions: [{ tool: '__raw__', rawTool: {
    toolUseId: tool, toolName: 'Read', family: 'read', args: {}, result: 'full' } }], ...extra });
  const x = await setup([
    row(17, 'assistant', 'first numeric', { sourceIdentity: 'cross-type' }),
    row('17', 'assistant', 'last string', { sourceIdentityAliases: ['cross-type'] }),
    row('boundary', 'user', 'boundary'),
    call(29, 'numeric-dom'), call('second-member', 'text-dom', { sourceIdentity: 'group-member' }),
  ], { inputs: { grouping: { enabled: true, threshold: 2, expandedKeys: [] } } });
  try {
    for (const identity of ['cross-type', '17', 'group-member']) {
      const { header, ...proof } = await x.model.readTerminalPreviewMembership(identity);
      assert.deepEqual(proof, x.membershipOracle(identity));
    }
    assert.equal(x.membershipOracle('cross-type').target.canonicalUuid, '17');
    assert.equal(x.membershipOracle('group-member').target.domUuid, '29');
    x.verifyBounds();
  } finally { await x.close(); }
});

test('pre-existing full preparation refusal for array UUID remains an explicit OPEN control', async () => {
  await assert.rejects(setup([row([], 'assistant', 'empty-array-uuid')]),
    error => error?.code === 'history_cursor_not_scalar');
});

test('actual receipt evaluation order: wrong text/role does not coerce an unavailable boundary', async () => {
  const bad = Object.create(null);
  const x = await setup([row('u', 'user', 'different', { recordByteOffset: 10 }), row('a', 'assistant', 'wanted')]);
  try {
    for (const record of [receipt('wanted', bad), receipt('wanted', 0, { sessionId: 'wrong' }),
      receipt('', bad), receipt('different', bad, { sessionId: 'wrong' })]) {
      assert.equal(x.canonical.some(entry => receiptOracle(record, entry)), false);
      assert.equal(await x.model.hasLaterCanonicalReceipt(record), false);
    }
    const record = receipt('different', bad);
    assert.throws(() => x.canonical.some(entry => receiptOracle(record, entry)), TypeError);
    await assert.rejects(x.model.hasLaterCanonicalReceipt(record), TypeError);
    x.model.view.reader.assertOpen(); x.verifyBounds();
  } finally { await x.close(); }
});

test('dedicated complete zero proof; corrupt/UNKNOWN response never becomes canonical absence', async () => {
  let tamper = null;
  const x = await setup([], { intercept: async (channel, payload, f) => {
    if (payload?.kind !== 'primary-canonical-consumers' || !tamper) return;
    const mode = tamper; tamper = null;
    if (mode === 'unknown') throw Object.assign(new Error('finite UNKNOWN'), { code: 'FINITE_OUTCOME_UNKNOWN' });
    const reply = await f.invoke(channel, payload);
    if (mode === 'generic') return { ...reply, kind: 'range' };
    if (mode === 'done') return { ...reply, done: false };
    if (mode === 'cut') return { ...reply, semanticIdentity: 'wrong-cut' };
  } });
  try {
    assert.equal(await x.model.hasLaterCanonicalReceipt(receipt('text')), false);
    const proof = await x.model.readTerminalPreviewMembership('empty');
    assert.equal(proof.canonicalPresent, false); assert.equal(proof.preparedPresent, false);
    assert(x.calls.slice(x.before).filter(call => call.kind === 'primary-canonical-consumers').length >= 3);
    for (const mode of ['generic', 'done', 'cut', 'unknown']) {
      tamper = mode; const before = x.calls.length;
      await assert.rejects(x.model.hasLaterCanonicalReceipt(receipt('text')));
      assert(x.calls.length - before <= 1, 'no retry after corrupt or UNKNOWN proof');
      x.model.view.reader.assertOpen();
    }
    x.verifyBounds();
  } finally { await x.close(); }
});

test('corrupted later mismatch chunk rejects instead of turning unverified text into canonical absence', async () => {
  let corrupted = false, armed = true; const targets = new Set();
  const x = await setup([row('u', 'user', 'b' + 'x'.repeat(2100), { recordByteOffset: 10 })], {
    intercept: async (channel, payload, f) => {
      if (payload?.encoding === 'history-canonical-consumer-text-v1' && payload.field === 'content') {
        const result = await f.invoke(channel, payload); targets.add(result.payloadDocument.leaseId); return result;
      }
      if (armed && payload?.kind === 'leaf' && targets.has(payload.leaseId) && payload.offset === 1024) {
        armed = false; corrupted = true;
        const result = await f.invoke(channel, payload); return { ...result, text: 'Y' + result.text.slice(1) };
      }
    } });
  try {
    const record = receipt('a' + 'x'.repeat(2100));
    assert.equal(x.canonical.some(entry => receiptOracle(record, entry)), false);
    await assert.rejects(x.model.hasLaterCanonicalReceipt(record), error => error?.code === 'HISTORY_PRIMARY_DOCUMENT_DIGEST');
    assert.equal(corrupted, true, 'a prior mismatch still verifies later source bytes');
    x.model.view.reader.assertOpen();
    assert.equal(await x.model.hasLaterCanonicalReceipt(record), false);
    x.verifyBounds();
  } finally { await x.close(); }
});

test('configured one-item producer cap preserves actual canonical proof and selected unit target', async () => {
  const x = await setup([row('a', 'assistant', 'full exact', { sourceIdentity: 'identity' })]);
  try {
    x.f.plane.maxItems = 1;
    const { header, ...proof } = await x.model.readTerminalPreviewMembership('identity');
    assert.deepEqual(proof, x.membershipOracle('identity'));
    assert(x.calls.slice(x.before).some(call => call.kind === 'projection' && call.count === 1 && call.done === false));
    assert(x.calls.slice(x.before).every(call => call.count == null || call.count <= 1));
    x.verifyBounds();
  } finally { await x.close(); }
});

test('giant local expected trim yields to cancellation before historical content demand', async () => {
  let armed = false; const controller = new AbortController();
  const x = await setup([row('u', 'user', 'body', { recordByteOffset: 10 })], {
    intercept: async (channel, payload, f) => {
      if (armed && payload?.encoding === 'history-canonical-consumer-text-v1' && payload.field === 'role') {
        armed = false; const result = await f.invoke(channel, payload);
        setTimeout(() => controller.abort(), 0); return result;
      }
    } });
  try {
    const record = receipt(' '.repeat(128 * 64 * 4) + 'body' + '\uFEFF'.repeat(128 * 64 * 4));
    armed = true; const before = x.calls.length;
    await assert.rejects(x.model.hasLaterCanonicalReceipt(record, { signal: controller.signal }), cancelled);
    assert(!x.calls.slice(before).some(call => call.field === 'content'), 'cancelled local trim issues no historical body coercion');
    x.model.view.reader.assertOpen();
    assert.equal(await x.model.hasLaterCanonicalReceipt(record), true);
    x.verifyBounds();
  } finally { await x.close(); }
});

test('owner/sequence/abort after await cancel only the proof and release a late independent value fork once', async () => {
  let gate = null, entered = null, captured = null;
  const x = await setup([row('u', 'user', 'text', { recordByteOffset: 10 })], { actualTransport: true,
    intercept: async (channel, payload, f) => {
      if (gate && payload?.encoding === 'history-canonical-consumer-text-v1') {
        const hold = gate; gate = null; const result = await f.invoke(channel, payload);
        captured = result.payloadDocument.leaseId; entered.resolve(); await hold.promise; return result;
      }
    } });
  try {
    const parentLease = x.model.header.leaseId;
    const page = await x.model.view.reader.primaryCanonicalConsumers(x.model.header.durableMetadata,
      { header: x.model.header, scope: 'canonical', offset: 0, limit: 1 });
    const independent = await x.model.view.reader.forkCanonicalConsumerValue(page.items[0].row,
      { operation: 'string-falsy', field: 'content' });
    await assert.rejects(x.model.hasLaterCanonicalReceipt(receipt('text'), { owns: () => Promise.resolve(true) }), cancelled);
    let owner = true; gate = deferred(); entered = deferred(); const hold = gate;
    const stale = x.model.hasLaterCanonicalReceipt(receipt('text'), { owns: () => owner });
    await entered.promise; owner = false; hold.resolve(); await assert.rejects(stale, cancelled);
    assert.equal(x.calls.filter(call => call.channel.endsWith('release-read-root') && call.leaseId === captured).length, 1);
    x.model.view.reader.assertOpen();

    gate = deferred(); entered = deferred(); const delayed = gate, controller = new AbortController();
    const aborted = x.model.hasLaterCanonicalReceipt(receipt('text'), { signal: controller.signal });
    await entered.promise; const child = captured; controller.abort(); await assert.rejects(aborted, cancelled);
    delayed.resolve(); for (let index = 0; index < 8; index++) await tick();
    assert.equal(x.calls.filter(call => call.channel.endsWith('release-read-root') && call.leaseId === child).length, 1);
    assert.equal(x.calls.filter(call => call.channel.endsWith('release-read-root') && call.leaseId === parentLease).length, 0);
    assert(x.calls.some(call => call.channel === 'agent-transcript:cancel-read'));
    x.model.view.reader.assertOpen();
    assert.equal(await x.model.hasLaterCanonicalReceipt(receipt('text')), true);

    gate = deferred(); entered = deferred(); const sequenceGate = gate;
    const priorCut = x.model.readTerminalPreviewMembership('user-uuid:u');
    await entered.promise; x.model.sequence++; sequenceGate.resolve(); await assert.rejects(priorCut, cancelled);
    x.model.view.reader.assertOpen();
    x.verifyBounds();
    await x.model.close();
    assert.equal((await independent.read(0, 4)).text, 'text', 'independent doc survives proof retirement and parent close');
    await independent.close();
  } finally { await x.close(); }
});
