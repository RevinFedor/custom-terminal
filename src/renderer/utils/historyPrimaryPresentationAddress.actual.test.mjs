import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { HistoryPrimaryRootReadModel, adoptHistoryPrimaryMetadata } from './historyPrimaryRootReadModel.mjs';
import { createHistoryPrimaryItemAdmission } from './historyPrimaryItemAdmission.mjs';
import { readHistoryPrimaryPanelAddress, collectHistoryPrimaryMountedSearchSubjects } from './historyPrimaryPanelBindings.mjs';
import { historyLivePresentationKey, historyLivePresentationIdentities } from './historyLiveProjection.mjs';

const require = createRequire(import.meta.url);
globalThis.window = { require };
const { createPrimaryAddressFixture } = require('../../../scripts/test-support/history-primary-address-fixture.cjs');
const cancelled = error => error?.code === 'HISTORY_READ_CANCELLED';
const tick = () => new Promise(resolve => setImmediate(resolve));
const scope = { ownerKey: 'panel-owner', generation: 4, visit: 2, presented: true };
const presentation = extra => ({ localEntries: [], liveEntries: [], liveToolResults: [],
  grouping: { enabled: false, threshold: 2, expandedKeys: [] },
  captionSelections: [], settingsPresentationKeys: [], ...extra });
const row = (uuid, index, extra = {}) => ({ uuid, role: index % 2 ? 'assistant' : 'user',
  sessionId: 's', timestamp: '2026-10-27T00:' + String(index).padStart(2, '0') + ':00.000Z',
  content: 'Exact ' + uuid + '\nsecond line\0tail\ud800😀\udc00', ...extra });
function domRow(index, address, uuid = address.entryUuid, owner = 'dom-owner') {
  return { dataset: { uuid, historyRowOwner: owner },
    closest: () => ({ getAttribute: name => name === 'data-item-index' ? String(index) : null }),
    getAttribute: name => name === 'data-history-unit-key' ? address.physicalKey : null };
}
function track(f, intercept = async () => null) {
  const records = [];
  const invoke = async (channel, payload) => {
    const overridden = await intercept(channel, payload);
    const result = overridden ?? await f.invoke(channel, payload);
    records.push({ channel, kind: payload?.kind, mode: payload?.mode, profile: payload?.profile,
      nodeToken: payload?.nodeToken, offset: payload?.offset, limit: payload?.limit,
      requestBytes: Buffer.byteLength(JSON.stringify(payload)), replyBytes: Buffer.byteLength(JSON.stringify(result)),
      credit: payload?.creditBytes, count: result?.items?.length, status: result?.status });
    return result;
  };
  return { invoke, records };
}

test('finite actual producer/client/model/Panel subjects: complete values first, bounded pure-scroll owners afterwards', async () => {
  const shared = { exact: 'provenance\0\ud800😀', absent: undefined };
  const cycle = { shared }; cycle.self = cycle;
  const longId = 'long\0\ud800😀:' + 'ж\udc00'.repeat(2100);
  // This finite native array exists only in this test. Production never
  // decodes it to implement addresses, keys, membership or mounted search.
  const reference = [
    row('u0', 0, { provenance: cycle, secondReference: shared, ownUndefined: undefined, notes: ['note\0😀'] }),
    row('a1', 1, { sourceIdentity: 'physical\0\ud800-1', sourceIdentityAliases: ['alias\0😀'],
      sourceUuidAliases: ['raw-alias'], entryRef: { physicalSessionId: 's', rawUuid: 'raw1', segmentId: 'seg1' },
      actions: [{ tool: '__raw__', rawTool: { toolUseId: 'call-1', toolName: 'Read', family: 'read',
        args: { file_path: '/finite/файл\0.txt' }, result: 'full-result\0\ud800😀', extra: undefined } }] }),
    row(longId, 2),
    ...Array.from({ length: 8 }, (_, i) => row('off-' + i, i + 3)),
    row('ambiguous-a', 11, { actions: [{ tool: '__raw__', rawTool: { toolUseId: 'same-call', toolName: 'Read', args: {}, result: 'A' } }] }),
    row('ambiguous-b', 13, { actions: [{ tool: '__raw__', rawTool: { toolUseId: 'same-call', toolName: 'Read', args: {}, result: 'B' } }] }),
    row(' \t saved-anchor\0😀 \n', 14),
  ];
  const f = await createPrimaryAddressFixture(null, { entries: reference }), observed = track(f);
  const model = new HistoryPrimaryRootReadModel(observed.invoke, f.transport);
  model.windowDiagnostic = () => {};
  try {
    await model.open({ ...f.payload, primaryPresentation: presentation() }, { presentationScope: scope });
    assert.equal(model.totalCount, reference.length);
    assert.equal(model.metadata.entries.length, reference.length, 'OPEN compatibility metadata is deliberately preserved');
    assert.equal(model.metadata.canonicalMetadataFact.kind, 'validated-canonical-metadata');
    assert.equal(model.metadata.canonicalMetadataFact.canonicalEntryCount, reference.length);
    assert.equal(Object.hasOwn(model.metadata, 'durableEntries'), false, 'canonical inventory is retired');
    assert.equal(model.window.size, 0);
    const connector = model.attachSurface(scope);
    assert.equal(model.hasCurrentPresentationCoverage(scope), false);
    assert.equal(createHistoryPrimaryItemAdmission(model, model.renderSnapshot(), () => true).admit(0), false);
    assert.equal((await connector.bootstrapWindow(model.renderSnapshot(), 0, () => true)).status, 'data-ready');
    assert.equal(model.hasCurrentPresentationCoverage(scope), false, 'readiness cannot manufacture paint');
    const full = model.unitAt(0).entry;
    assert.deepEqual(full, reference[0]);
    assert.equal(full.provenance.self, full.provenance);
    assert.equal(full.provenance.shared, full.secondReference);
    assert(Object.hasOwn(full, 'ownUndefined')); assert.equal(full.ownUndefined, undefined);
    let snapshot = model.renderSnapshot();
    const match = (i, unit) => model.addressAt(i).physicalKey === historyLivePresentationKey(unit.entry);
    const range = { totalCount: model.totalCount, startIndex: 0, endIndex: 0, itemCount: 1, admittedCount: 1, stable: true };
    assert.equal(connector.commit(snapshot, { ...range, itemCount: 0, admittedCount: 0 }, match).status, 'awaiting-commit');
    assert.equal(connector.commit(snapshot, { ...range, admittedCount: 0 }, match).status, 'awaiting-commit');
    assert.equal(connector.commit(snapshot, { ...range, stable: false }, match).status, 'awaiting-layout');
    assert.equal(connector.commit(snapshot, { ...range, stable: Promise.resolve(true) }, match).status, 'awaiting-layout');
    assert.equal(connector.commit(snapshot, range, match).status, 'covered');
    assert.equal(model.hasCurrentPresentationCoverage(scope), true);
    assert.equal(model.hasCurrentPresentationCoverage({ ...scope, visit: 3 }), false);

    const alias = await readHistoryPrimaryPanelAddress(model, 'uuid', 'alias\0😀');
    assert.equal(alias.address.entryUuid, 'a1'); assert.equal(alias.address.index, 1);
    const physical = await readHistoryPrimaryPanelAddress(model, 'uuid', 'unrelated', { tool: {
      messageReference: { provider: 'codex', physicalSessionId: 's', transcriptSegmentId: 'seg1', rawUuid: 'raw1' },
    } });
    assert.equal(physical.address.entryUuid, 'a1');
    assert.equal((await readHistoryPrimaryPanelAddress(model, 'uuid', 'a1', { tool: {
      messageReference: { physicalSessionId: 'wrong', rawUuid: 'raw1' },
    } })).address, null);
    assert.equal((await readHistoryPrimaryPanelAddress(model, 'uuid', 'a1', { tool: { toolUseId: 'same-call' } })).address, null);
    assert.equal(await model.resolveUuid('absent'), null);
    assert.equal((await model.resolveUuid(longId)).entryUuid, longId, 'long exact ID follows signed scan/chunks');
    assert.equal((await readHistoryPrimaryPanelAddress(model, 'entry', ' \t saved-anchor\0😀 \n')).address.entryUuid,
      ' \t saved-anchor\0😀 \n', 'stored UUID anchors preserve whitespace as well as all UTF16 code units');
    assert.equal((await model.resolveKey('uuid:' + longId)).entryUuid, longId);
    const escaped = '\0'.repeat(2048), beforeEscaped = observed.records.length;
    assert.equal(await model.resolvePresentationTarget(escaped, { toolUseId: escaped,
      messageReference: { physicalSessionId: escaped, sessionId: escaped, rawUuid: escaped,
        transcriptSegmentId: escaped } }), null);
    assert(observed.records.slice(beforeEscaped).some(call => call.mode === 'scan'),
      'combined individually-short escaped literals use bounded signed scan');
    assert(observed.records.slice(beforeEscaped).every(call => call.requestBytes <= 65536));
    assert.equal(model.window.size, 1, 'off-window point subjects do not populate body windows');

    const metadata = model.metadata, sourceMetadataToken = model.header.sourceMetadata.nodeToken,
      durableMetadataToken = model.header.durableMetadata.nodeToken, beforeScroll = observed.records.length;
    // Visit every row, including both off-window ends, with a small corridor.
    for (let start = reference.length - 1; start >= 0; start--) {
      const end = Math.min(reference.length - 1, start + 1);
      await model.readWindow(start, end);
      for (let rank = start; rank <= end; rank++) {
        const unit = model.unitAt(rank), address = model.addressAt(rank);
        assert.deepEqual(unit.entry, reference[rank]);
        assert.equal(address.physicalKey, historyLivePresentationKey(reference[rank]));
        const selected = await model.resolveUuid(reference[rank].uuid);
        assert.equal(selected.index, rank); assert.equal(selected.physicalKey, address.physicalKey);
        assert.equal((await model.resolveKey(address.physicalKey)).index, rank);
      }
      assert(model.window.size <= 2); assert.equal(model.addresses.size, model.window.size);
      assert.equal(model.metadata, metadata);
    }
    assert.equal(createHistoryPrimaryItemAdmission(model, snapshot, () => true).admit(0), false,
      'an evicted/reloaded body cannot revive the old committed snapshot');
    assert.equal(model.hasCurrentPresentationCoverage(scope), false, 'range changes revoke prior paint');

    snapshot = model.renderSnapshot();
    const a0 = model.addressAt(0), a1 = model.addressAt(1);
    const rows = [domRow(0, a0), domRow(1, a1), domRow(1, a1, 'forged-uuid'),
      domRow(0, a0, a0.entryUuid, 'foreign-owner')];
    const mounted = collectHistoryPrimaryMountedSearchSubjects({ querySelectorAll: () => rows },
      'dom-owner', model, historyLivePresentationIdentities);
    assert.deepEqual([...mounted.subjects.keys()], ['u0', 'a1']);
    assert(mounted.keys.has('alias\0😀')); assert(!mounted.keys.has('forged-uuid'));
    assert.equal(collectHistoryPrimaryMountedSearchSubjects({ querySelectorAll: () => [domRow(10, a1)] },
      'dom-owner', model, historyLivePresentationIdentities).subjects.size, 0);

    // Bounds are checked AFTER the differential correctness assertions.
    const scroll = observed.records.slice(beforeScroll);
    assert(!scroll.some(call => call.channel === 'agent-transcript:get-history'));
    assert(!scroll.some(call => call.nodeToken === sourceMetadataToken || call.nodeToken === durableMetadataToken),
      'address/body scrolling never enters the OPEN metadata decoder');
    for (const call of observed.records) {
      if (call.channel === 'agent-transcript:read-page') {
        assert(call.replyBytes <= 65536); assert(call.count == null || call.count <= 3);
        assert(call.credit <= 65536);
      }
      assert(!/delete|remove|send|stop|rewind|update/.test(call.channel), 'new read capability issues no mutation');
    }
    assert(observed.records.some(call => call.kind === 'primary-presentation-address' && call.mode === 'scan'));
    assert(observed.records.every(call => call.requestBytes < 65536));
    assert.equal(model.pendingWindow, null); assert.equal(model.activeWindow, null);
    assert(f.plane.stats().maxPacketBytes <= 65536);
    assert(f.store.stats().peakCachedPages <= 3);
    connector.dispose();
    assert.equal(model.hasCurrentPresentationCoverage(scope), false);
  } finally { await model.close(); assert.equal(model.window.size, 0); assert.equal(model.addresses.size, 0);
    assert.equal(model.presentation, null); f.close(); }
});

test('actual model rebind, append, stale owner/composition, cancellation/UNKNOWN, and independent child lease', async () => {
  const reference = Array.from({ length: 10 }, (_, i) => row('r' + i, i));
  const f = await createPrimaryAddressFixture(null, { entries: reference });
  let hold = null, signalUnknown = false;
  const observed = track(f, async (channel, payload) => {
    if (channel === 'agent-transcript:read-page' && payload.kind === 'primary-presentation-address') {
      if (signalUnknown && payload.mode === 'uuid') {
        signalUnknown = false;
        throw Object.assign(new Error('finite transport outcome unknown'), { code: 'HISTORY_TEST_OUTCOME_UNKNOWN' });
      }
      if (hold && payload.mode === 'range' && payload.offset === 2) { const gate = hold; hold = null; await gate; }
    }
    return null;
  });
  const model = new HistoryPrimaryRootReadModel(observed.invoke, f.transport);
  model.windowDiagnostic = () => {};
  let child;
  try {
    const options = presentation(), payload = { ...f.payload, primaryPresentation: options };
    await model.open(payload, { presentationScope: scope }); await model.readWindow(0, 1);
    const old = model.renderSnapshot(), oldBody = model.unitAt(0), oldKey = model.addressAt(0).physicalKey;
    child = await model.view.reader.forkViewUnit(model.addressAt(0).header);
    const metadata = model.metadata.entries, before = observed.records.length;
    await model.open({ ...payload, primaryRequestClass: 'view', primaryViewOptions: options }, { presentationScope: scope });
    assert.notEqual(model.header.leaseId, old.header.leaseId);
    assert.equal(model.metadata.entries, metadata, 'metadata-only rebind retains existing qualified metadata owner');
    assert.equal(model.unitAt(0), oldBody);
    assert.equal(model.addressAt(0).physicalKey, oldKey, 'new lease does not remount identical physical row');
    assert.equal(createHistoryPrimaryItemAdmission(model, old, () => true).admit(0), false);
    assert(!observed.records.slice(before).some(call => call.profile === 'primary-metadata-fields-v1'));
    const stable = model.renderSnapshot(), connector = model.attachSurface(scope);
    assert.equal(createHistoryPrimaryItemAdmission(model, stable, () => Promise.resolve(true)).admit(0), false);
    assert.equal(connector.commit(stable, { totalCount: model.totalCount, startIndex: 0, endIndex: 1,
      itemCount: 2, admittedCount: 2, stable: true }, () => true, () => false).status, 'superseded');
    assert.equal(model.hasCurrentPresentationCoverage(scope), false);
    assert.equal(connector.commit(stable, { totalCount: model.totalCount, startIndex: 0, endIndex: 1,
      itemCount: 2, admittedCount: 2, stable: true }, () => true, () => true).status, 'superseded',
    'a terminated adoption cannot emit a contradictory covered callback');
    assert.equal(model.hasCurrentPresentationCoverage(scope), false);

    let release;
    hold = new Promise(resolve => { release = resolve; });
    const first = model.readWindow(2, 2).catch(error => error);
    await tick();
    const superseded = [];
    for (let i = 3; i < 8; i++) superseded.push(model.readWindow(i, i).catch(error => error));
    assert(model.activeWindow); assert.equal(model.pendingWindow.start, 7);
    assert(model.window.size <= 1); assert(model.addresses.size <= 1);
    release();
    const outcomes = await Promise.all([first, ...superseded]);
    for (const result of outcomes.slice(0, -1)) assert(cancelled(result));
    assert.equal(outcomes.at(-1), undefined); assert.equal(model.unitAt(7).entry.uuid, 'r7');
    assert.equal(model.activeWindow, null); assert.equal(model.pendingWindow, null);
    const rangeOffsets = observed.records.filter(call => call.kind === 'primary-presentation-address'
      && call.mode === 'range').map(call => call.offset);
    for (const skipped of [3, 4, 5, 6]) assert(!rangeOffsets.includes(skipped), 'superseded corridor never starts IPC');

    signalUnknown = true;
    const beforeUnknown = f.calls.length;
    await assert.rejects(model.resolveUuid('r1'), error => error.code === 'HISTORY_TEST_OUTCOME_UNKNOWN');
    assert.equal(f.calls.length, beforeUnknown, 'no retry or fallback after UNKNOWN');
    assert.equal((await model.resolveUuid('r1')).entryUuid, 'r1', 'independent next explicit demand uses retained parent');
    const abort = new AbortController(); abort.abort();
    await assert.rejects(model.resolveUuid('r1', { signal: abort.signal }), cancelled);
    await assert.rejects(readHistoryPrimaryPanelAddress(model, 'uuid', 'r1', { owns: () => false }), cancelled);
    const beforeRejectedOwnership = f.calls.length;
    await assert.rejects(model.resolveKey('uuid:r1', { owns: () => Promise.resolve(false) }), cancelled);
    await assert.rejects(model.readWindow(1, 1, { owns: () => Promise.resolve(true) }), cancelled);
    await assert.rejects(model.resolveKey(null), error => error.code === 'HISTORY_PRIMARY_ADDRESS_QUERY_INVALID');
    assert.equal(f.calls.length, beforeRejectedOwnership, 'non-boolean owner and invalid selector do not issue IPC');
    assert.equal(model.closed, false);

    // Changing the held physical source requires fresh canonical preparation.
    f.setEntries([...reference, row('appended', 10)]);
    await model.open({ ...payload, primaryRequestClass: 'source' }, { presentationScope: scope });
    assert.equal(model.totalCount, reference.length + 1);
    assert.equal((await model.resolveUuid('appended')).index, reference.length);
    assert.equal(createHistoryPrimaryItemAdmission(model, stable, () => true).admit(0), false);
    await model.readWindow(0, 0); assert.equal(model.addressAt(0).physicalKey, oldKey);
    const other = new HistoryPrimaryRootReadModel(f.invoke, f.transport);
    other.windowDiagnostic = () => {};
    await other.open({ ...payload, tabId: 'other-owner' }, { presentationScope: { ...scope, ownerKey: 'other' } });
    assert.notEqual(other.header.ownerKey, model.header.ownerKey);
    assert.equal(createHistoryPrimaryItemAdmission(other, model.renderSnapshot(), () => true).admit(0), false);
    await other.close();
    await model.close();
    const firstChunk = await child.read(0, Math.min(96, child.length));
    assert(firstChunk.text.length > 0, 'background/menu document survives presentation close');
    await child.close(); child = null;
    assert.equal(f.plane.stats().roots, 0);
  } finally { await child?.close(); await model.close(); f.close(); }
});

test('metadata-only rebind proves the current corridor when scrolling replaces its window during await', async () => {
  const f = await createPrimaryAddressFixture(null, { entries: Array.from({ length: 8 }, (_, i) => row('move-' + i, i)) });
  let model, arm = false, release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const observed = track(f, async (channel, payload) => {
    if (arm && channel === 'agent-transcript:read-page' && payload.kind === 'primary-presentation-address'
      && payload.mode === 'range' && payload.offset === 0 && payload.leaseId !== model.header.leaseId) {
      arm = false; entered(); await blocked;
    }
    return null;
  });
  model = new HistoryPrimaryRootReadModel(observed.invoke, f.transport); model.windowDiagnostic = () => {};
  try {
    const options = presentation(), payload = { ...f.payload, primaryPresentation: options };
    await model.open(payload); await model.readWindow(0, 1);
    const initial = model.renderSnapshot(); arm = true;
    const refreshing = model.open({ ...payload, primaryRequestClass: 'view', primaryViewOptions: options });
    await waiting;
    const moving = model.readWindow(6, 6).then(() => ({ unit: model.unitAt(6) }), error => ({ error }));
    release();
    await refreshing;
    const moved = await moving;
    if (moved.error) assert(cancelled(moved.error), 'only adoption may cancel the old surface demand');
    assert.deepEqual(model.requestedWindow, { start: 6, end: 6 });
    assert.equal(model.window.has(0), false, 'old ready corridor is never revived under a new cut');
    await model.readWindow(6, 6);
    assert.equal(model.unitAt(6).entry.uuid, 'move-6');
    if (moved.unit) assert.equal(model.unitAt(6), moved.unit, 'ready body retains its object and physical identity');
    assert.equal(model.addressAt(6).physicalKey, 'uuid:move-6');
    assert.equal(createHistoryPrimaryItemAdmission(model, initial, () => true).admit(0), false);
    assert.equal(model.window.size, 1); assert.equal(model.addresses.size, 1);
  } finally { release(); await model.close(); f.close(); }
});

test('actual prepared local rows preserve exact authoring ownership and canonical retirement', async () => {
  const local = { uuid: 'local-prompt-own', role: 'queued', content: 'draft\0😀', sessionId: 's',
    handoffId: 'owned-handoff', sendOperationKey: 'operation', sendAttemptId: 'attempt',
    queueStatus: 'queued', optimisticAt: 1, timestamp: '2000-01-01T00:00:00.000Z',
    promptChips: [{ id: 'chip', kind: 'prompt', text: 'whole-chip\0\ud800' }], imagePaths: ['/finite/own.png'] };
  const f = await createPrimaryAddressFixture(null, { entries: [row('start', 0)] });
  const model = new HistoryPrimaryRootReadModel(f.invoke, f.transport); model.windowDiagnostic = () => {};
  try {
    const options = presentation({ localEntries: [local] });
    await model.open({ ...f.payload, primaryPresentation: options });
    const selected = await model.resolveUuid(local.uuid); assert(selected, 'unconfirmed old local has no new TTL');
    await model.readWindow(selected.index, selected.index);
    assert.deepEqual(model.unitAt(selected.index).entry.promptChips, local.promptChips);
    assert.deepEqual(model.unitAt(selected.index).entry.imagePaths, local.imagePaths);
    assert.equal(model.unitAt(selected.index).entry.content, local.content);
    const newer = { ...local, content: 'newer current draft', queueStatus: 'not-submitted' };
    const owned = adoptHistoryPrimaryMetadata(model.metadata.entries, [newer], [local], {
      isLocal: entry => entry.uuid.startsWith('local-prompt-'), mergeLate: (a, b) => a.concat(b),
    });
    assert.equal(owned.find(entry => entry.uuid === local.uuid), newer);
    const dismissed = adoptHistoryPrimaryMetadata(model.metadata.entries, [], [local], {
      isLocal: entry => entry.uuid.startsWith('local-prompt-'), mergeLate: (a, b) => a.concat(b),
    });
    assert(!dismissed.some(entry => entry.uuid === local.uuid), 'read cannot resurrect dismissed current owner');
    const canonical = row('canonical-prompt', 1, { role: 'user', content: local.content,
      sourceIdentity: 'exact-audit', sourceIdentityAliases: ['owned-handoff'] });
    const exactLocal = { ...local, auditEntryUuid: canonical.uuid, sourceIdentity: canonical.sourceIdentity };
    f.setEntries([row('start', 0), canonical]);
    await model.open({ ...f.payload, primaryRequestClass: 'source',
      primaryPresentation: presentation({ localEntries: [exactLocal] }) });
    assert.equal(await model.resolveUuid(local.uuid), null, 'canonical exact adoption retires presentation local');
    const canonicalAddress = await model.resolveUuid(canonical.uuid);
    await model.readWindow(canonicalAddress.index, canonicalAddress.index);
    assert.deepEqual(model.unitAt(canonicalAddress.index).entry.promptChips, local.promptChips);
    assert.deepEqual(model.unitAt(canonicalAddress.index).entry.imagePaths, local.imagePaths);
    assert.equal(exactLocal.content, local.content); assert.equal(exactLocal.queueStatus, 'queued');
  } finally { await model.close(); f.close(); }
});
