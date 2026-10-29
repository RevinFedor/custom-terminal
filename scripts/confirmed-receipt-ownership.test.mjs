// Bounded actual callback controls for partial binds, queued projections and
// certified own canonical promotion. React scheduling/IPC and storage are adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as identity from '../src/renderer/utils/historyPromptPresentation.mjs';
const require = createRequire(import.meta.url), ts = require('typescript');
assert.equal(process.execPath, '/Users/fedor/.hermes/node/bin/node');
assert(require('node:v8').getHeapStatistics().heap_size_limit <= 256 * 1024 ** 2);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panel = fs.readFileSync(path.join(ROOT, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
globalThis.window = { require };
const handoffs = await import('../src/renderer/utils/historyPromptHandoffs.ts');
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/test-support/confirmed-receipt-before.json'), 'utf8'));
const ref = current => ({ current });
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function cut(a, b) {
  const start = panel.indexOf(a), end = panel.indexOf(b, start + a.length);
  assert(start >= 0 && end > start, a);
  const text = panel.slice(start, end); assert(Buffer.byteLength(text) < 40 * 1024); return text;
}
function evaluate(text, env, tail = '') {
  assert(Buffer.byteLength(text + tail) < 40 * 1024);
  const result = ts.transpileModule(text + tail, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual(result.diagnostics, []);
  return Function(...Object.keys(env), result.outputText)(...Object.values(env));
}
const parts = {
  owners: cut('  const localPromptMetaOwnersRef =', '\n  const appendLocalPromptEntry ='),
  cleanup: cut('  const captureLocalPromptRemoval =', '\n  const queueMergeIntents ='),
  append: cut('  const appendLocalPromptEntry =', '\n  const updateLocalPromptEntry ='),
  status: cut('  const updateLocalPromptEntry =', '\n  const captureLocalPromptRemoval ='),
  find: cut('const findServerPromptEntry =', '\nconst serverHasPromptEntry ='),
  subscriber: cut("  useEffect(() => subscribeHistoryPromptHandoffs(tabId, (snapshot, change) => {\n    if (change.type === 'presentation-control')", '\n  const appendCompactErrorEntry ='),
  shared: cut('  const consumeMaterializedPromptHandoffs =', '\n  // Load full history'),
  ack: cut('  const acknowledgeMaterializedHistoryReceipt =', '\n  useEffect(() => {'),
};
let sequence = 0;
function subject() {
  const key = 'ownership-' + ++sequence;
  return { tabId: key, handoffId: key + '-H', operationKey: key + '-O', attemptId: key + '-A' };
}
const canonical = () => ({ uuid: 'canonical-user', role: 'user', content: 'authored',
  timestamp: '2026-10-27T00:00:00.000Z', sessionId: 's', sourceIdentity: 'canonical-source',
  sourceIdentityAliases: ['audit-old', 'source-old'] });
function begin(s, fields = {}, audit = false) {
  return handoffs.beginHistoryPromptHandoff({ tabId: s.tabId, handoffId: s.handoffId, toolType: 'codex',
    text: 'authored', submittedAt: 1, sessionIdHint: 's', requiresAuditIdentity: audit, ...fields,
    ...(audit ? { initialReceipt: { queueStatus: 'sent', proof: { entryUuid: 'audit-old', sourceIdentity: 'source-old',
      sessionId: 's', auditTimestamp: '2026-10-27T00:00:00.000Z', actualHash: 'hash' } } } : {}) });
}
function local(s, { rows: initial = [], meta, immediate = false, acknowledge = async () => ({ success: true }) } = {}) {
  let rows = initial, subscription = () => {}, queued = !immediate;
  const updates = [], calls = [];
  function flush(reverse = false) {
    const pending = updates.splice(0); if (reverse) pending.reverse();
    for (const update of pending) rows = update(rows);
  }
  const env = { ...handoffs, ...identity, tabId: s.tabId, toolType: 'codex', sessionId: 's', LOCAL_PROMPT_PREFIX: 'local-prompt-',
    historyOwnerKey: 'owner', historyOwnerKeyRef: ref('owner'), historyOwnerGenerationRef: ref(2), historySnapshotOwner: {},
    promptHandoffMetaRef: ref(new Map(meta ? [[s.handoffId, meta]] : [])), suppressedPromptsRef: ref(new Map()),
    presentationEntriesRef: ref(rows), committedHistoryEntriesRef: ref({ ownerKey: 'owner', entries: [] }),
    rawServerEntriesRef: ref([]), liveProjectionRef: ref({ ownerKey: 'owner', entries: [] }),
    useCallback: fn => fn, useRef: ref, useEffect: fn => { subscription = fn(); },
    isLocalPromptEntry: row => row.role === 'queued' && row.uuid.startsWith('local-prompt-'),
    normalizeHistoryPromptText: value => String(value || '').trim(),
    normalizeHistoryPromptIdentityText: value => String(value || '').trim(),
    normalizeComposerChips: value => value, retainHistoryDraftImages: (_text, value) => value,
    promptPreview: value => value.slice(0, 32), resolveHistoryPromptHandoffSemanticTags: () => [],
    matchesHistoryPromptAdoption() { throw Error('exact identity control must not enter text/time fallback'); },
    retireHistoryLivePromptByExactProof: value => value, setLiveEntries() {}, serverHasPromptEntry: () => false,
    entryMatchesSuppressedPrompt: () => false, setEntries(update) { updates.push(update); if (!queued) flush(); },
    setPrimarySuppressionRevision() {}, setReceiptPresentationRevision() {}, keepHistoryTailPinnedAfterMutation() {},
    persistVolatileOverlay() {}, historyDiag() {}, console,
    ipcRenderer: { invoke: async (channel, payload) => {
      assert.equal(channel, 'agent:acknowledge-send-receipt-presentation'); calls.push(payload); return acknowledge(payload);
    } },
  };
  Object.assign(env, evaluate(parts.owners, env, '\nreturn {localPromptMetaOwnersRef,getLocalPromptMetaOwner};'));
  Object.assign(env, evaluate(parts.cleanup, env, '\nreturn {captureLocalPromptRemoval,removeLocalPromptEntry,consumeLocalPromptEntry};'));
  env.findServerPromptEntry = evaluate(parts.find, env, '\nreturn findServerPromptEntry;');
  env.appendLocalPromptEntry = evaluate(parts.append, env, '\nreturn appendLocalPromptEntry;');
  env.updateLocalPromptEntry = evaluate(parts.status, env, '\nreturn updateLocalPromptEntry;');
  env.acknowledgeMaterializedHistoryReceipt = evaluate(parts.ack, env, '\nreturn acknowledgeMaterializedHistoryReceipt;');
  env.consumeMaterializedPromptHandoffs = evaluate(parts.shared, env, '\nreturn consumeMaterializedPromptHandoffs;');
  return { env, calls, rows: () => rows, flush, queue(value) { queued = value; },
    subscribe() { evaluate(parts.subscriber, env); },
    commit(value) { rows = value; env.presentationEntriesRef.current = rows;
      env.committedHistoryEntriesRef.current = { ownerKey: 'owner', entries: value }; env.rawServerEntriesRef.current = value; },
    close() { subscription(); handoffs.consumeHistoryPromptHandoff(s.tabId, s.handoffId); },
  };
}

test('partial binding parity: existing recovery/ACK accepts all native legacy owners and optional expected fields stay optional', async () => {
  assert.equal(parts.ack, baseline.acknowledgeMaterializedHistoryReceipt);
  for (const fields of ['', 'O', 'A', 'OA']) {
    const s = subject(), owner = begin(s, { ...(fields.includes('O') ? { sendOperationKey: s.operationKey } : {}),
      ...(fields.includes('A') ? { sendAttemptId: s.attemptId } : {}) });
    const oldRow = { uuid: 'local-prompt-' + s.handoffId, role: 'queued', content: 'authored', handoffId: s.handoffId,
      sendOperationKey: owner.sendOperationKey, sendAttemptId: owner.sendAttemptId };
    const x = local(s, { rows: [oldRow], meta: { text: 'authored', sendOperationKey: owner.sendOperationKey, sendAttemptId: owner.sendAttemptId }, immediate: true });
    const record = { ...s, provider: 'codex', state: 'confirmed', surface: 'desktop-history', sessionId: 's' };
    const recovery = handoffs.captureHistoryReceiptRecoveryOwner(record);
    try {
      assert(recovery.recoveryAllowed && recovery.isCurrent());
      assert(handoffs.historyPromptHandoffAcceptsAuditIdentity(owner, { sendOperationKey: s.operationKey, sendAttemptId: s.attemptId }));
      const ack = await x.env.acknowledgeMaterializedHistoryReceipt({ ...s, provider: 'codex', sessionId: 's',
        auditEntryUuid: 'audit-old', auditSourceIdentity: 'source-old' }, canonical());
      assert.equal(ack, true); assert.equal(x.calls.length, 1);
      assert(x.env.captureLocalPromptRemoval(s.handoffId, undefined, s), fields || 'unbound capture');
      assert.equal(x.env.consumeLocalPromptEntry(s.handoffId, 'partial-old-allowed-cleanup', s, () => recovery.isCurrent()), true);
      assert.equal(x.rows().length, 0); assert(!x.env.promptHandoffMetaRef.current.has(s.handoffId));
      assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(s.tabId).length, 0);
    } finally { recovery.dispose(); x.close(); }
  }
  for (const shape of ['owner-only', 'only-O', 'only-A', 'no-expected', 'owner-and-tuple', 'conflict-O', 'conflict-A']) {
    const s = subject(), owner = begin(s, { sendOperationKey: s.operationKey, sendAttemptId: s.attemptId });
    const oldRow = { uuid: 'local-prompt-' + s.handoffId, role: 'queued', content: 'authored', handoffId: s.handoffId,
      sendOperationKey: s.operationKey, sendAttemptId: s.attemptId };
    const x = local(s, { rows: [oldRow], meta: { text: 'authored', sendOperationKey: s.operationKey, sendAttemptId: s.attemptId }, immediate: true });
    const expected = shape === 'owner-only' ? { owner } : shape === 'only-O' ? { operationKey: s.operationKey }
      : shape === 'only-A' ? { attemptId: s.attemptId } : shape === 'no-expected' ? undefined
      : { owner, operationKey: shape === 'conflict-O' ? 'different-O' : s.operationKey,
        attemptId: shape === 'conflict-A' ? 'different-A' : s.attemptId };
    try {
      const accepted = x.env.consumeLocalPromptEntry(s.handoffId, 'optional-or-conflict', expected);
      const conflict = shape.startsWith('conflict-');
      assert.equal(accepted, !conflict, shape); assert.equal(x.rows().length, conflict ? 1 : 0, shape);
      if (conflict) assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(s.tabId)[0], owner);
    } finally { x.close(); }
  }
});

test('real bind/canonical-enrichment keeps partial metadata owner; queued row cleanup uses that metadata projection tuple in both orders', () => {
  for (const fields of ['', 'O', 'A']) for (const reverse of [false, true]) for (const statusClone of [false, true]) {
    const s = subject();
    begin(s, { ...(fields.includes('O') ? { sendOperationKey: s.operationKey } : {}),
      ...(fields.includes('A') ? { sendAttemptId: s.attemptId } : {}) }, true);
    const x = local(s);
    try {
      x.subscribe();
      const originalMeta = x.env.promptHandoffMetaRef.current.get(s.handoffId), token = x.env.getLocalPromptMetaOwner(originalMeta);
      assert(originalMeta); assert.equal(x.rows().length, 0);
      x.commit([canonical()]);
      assert(handoffs.bindHistoryPromptHandoffSendIdentity(s.tabId, s.handoffId, { sendOperationKey: s.operationKey, sendAttemptId: s.attemptId }).ok);
      assert.equal(x.env.promptHandoffMetaRef.current.get(s.handoffId), originalMeta, 'real bind takes canonical enrichment before creating local metadata');
      if (statusClone) x.env.updateLocalPromptEntry(s.handoffId, 'sent', 'same-owner-status', { auditEntryUuid: 'audit-old', auditSessionId: 's' });
      assert.equal(x.env.getLocalPromptMetaOwner(x.env.promptHandoffMetaRef.current.get(s.handoffId)), token);
      const removal = x.env.captureLocalPromptRemoval(s.handoffId, undefined, s);
      assert(removal); assert.equal(removal.rows.length, 0);
      assert.equal(removal.metaOperationKey, fields.includes('O') ? s.operationKey : null);
      assert.equal(removal.metaAttemptId, fields.includes('A') ? s.attemptId : null);
      assert.equal(x.env.consumeLocalPromptEntry(s.handoffId, 'known-ack-cleanup', s), true);
      x.flush(reverse);
      assert(!x.rows().some(row => row.handoffId === s.handoffId), 'old queued partial row remains');
      assert.equal(x.rows().filter(row => row.uuid === 'canonical-user').length, 1);
      assert(!x.env.promptHandoffMetaRef.current.has(s.handoffId)); assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(s.tabId).length, 0);
    } finally { x.close(); }
  }
});

test('shared own canonical promotion retires its certified result and preserves replacements during adoption, ACK and consume', async () => {
  for (const mode of ['already-canonical', 'own-promotion', 'replace-during-adoption', 'replace-during-ACK', 'replace-same-HOA-during-ACK', 'replace-on-consume-before', 'replace-on-consume-after']) {
    const s = subject(), bound = { sendOperationKey: s.operationKey, sendAttemptId: s.attemptId };
    let old = begin(s, bound, true), replacement, releaseACK, ackEntered;
    if (mode === 'already-canonical') old = handoffs.adoptHistoryPromptHandoffCanonicalEntry(s.tabId, s.handoffId,
      { entryUuid: 'canonical-user', sessionId: 's', sourceIdentityAliases: ['audit-old'] });
    const gate = new Promise(resolve => { releaseACK = resolve; }), entered = new Promise(resolve => { ackEntered = resolve; });
    const x = local(s, { immediate: true, acknowledge: async () => { ackEntered(); await gate; return { success: true }; } });
    const replace = () => {
      handoffs.consumeHistoryPromptHandoff(s.tabId, s.handoffId);
      replacement = begin(s, { ...bound, sendAttemptId: mode === 'replace-during-ACK' ? 'new-attempt' : s.attemptId, text: 'replacement' });
      assert.notEqual(replacement, old, 'the control must create a new handoff object');
    };
    const listener = (_snapshot, change) => {
      if (!replacement && ((mode === 'replace-during-adoption' && change.type === 'canonical-adopt')
        || (mode.startsWith('replace-on-consume') && change.type === 'consume'))) replace();
    };
    let unsubscribe = () => {};
    try {
      if (mode === 'replace-on-consume-before' || mode === 'replace-during-adoption') unsubscribe = handoffs.subscribeHistoryPromptHandoffs(s.tabId, listener);
      x.subscribe(); x.commit([...x.rows(), canonical()]);
      if (mode === 'replace-on-consume-after') unsubscribe = handoffs.subscribeHistoryPromptHandoffs(s.tabId, listener);
      x.env.consumeMaterializedPromptHandoffs([canonical()]); await entered;
      if (mode === 'own-promotion') {
        const own = handoffs.getHistoryPromptHandoffsSnapshot(s.tabId)[0];
        assert.notEqual(own, old); assert.equal(own.auditProof.entryUuid, 'canonical-user');
      }
      if (mode === 'replace-during-ACK' || mode === 'replace-same-HOA-during-ACK') replace();
      assert.equal(x.calls.length, 1); assert.equal(x.calls[0].entryUuid, old.auditProof.entryUuid, 'ACK retains audited pre-promotion UUID');
      assert.equal(x.calls[0].sourceIdentity, old.auditProof.sourceIdentity, 'ACK retains audited pre-promotion source identity');
      releaseACK(); await tick();
      const current = handoffs.getHistoryPromptHandoffsSnapshot(s.tabId)[0];
      if (mode.startsWith('replace-')) {
        assert(replacement); assert.equal(current, replacement, mode);
        assert(x.env.promptHandoffMetaRef.current.has(s.handoffId), mode + ': replacement metadata');
        assert(x.rows().some(row => row.handoffId === s.handoffId && row.content === 'replacement'), mode + ': replacement row');
      } else {
        assert.equal(current, undefined, mode);
        assert(!x.env.promptHandoffMetaRef.current.has(s.handoffId), mode);
        assert(!x.rows().some(row => row.handoffId === s.handoffId), mode);
      }
    } finally { releaseACK(); unsubscribe(); x.close(); }
  }
});

test('explicit retired null rejects known owner/meta attempt and known operation conflicts', () => {
  for (const mode of ['owner-attempt', 'meta-attempt', 'meta-operation']) {
    const s = subject();
    s.operationKey = `history:${s.tabId}:${s.handoffId}`;
    const tuple = { sendOperationKey: mode === 'meta-operation' ? 'different-operation' : s.operationKey,
      sendAttemptId: mode === 'meta-operation' ? null : 'known-attempt-B' };
    if (mode === 'owner-attempt') begin(s, tuple);
    const retiredRow = { uuid: 'local-prompt-retired', role: 'queued', handoffId: s.handoffId,
      sendOperationKey: s.operationKey, sendAttemptId: null, content: 'old retired projection' };
    const currentRow = { uuid: 'local-prompt-current', role: 'queued', handoffId: s.handoffId, ...tuple, content: 'current projection' };
    const x = local(s, { rows: [retiredRow, currentRow], meta: { ...tuple, text: 'current projection' }, immediate: true });
    const expected = { owner: mode === 'owner-attempt' ? handoffs.getHistoryPromptHandoffsSnapshot(s.tabId)[0] : null,
      operationKey: s.operationKey, attemptId: null };
    try {
      const meta = x.env.promptHandoffMetaRef.current.get(s.handoffId);
      assert.equal(x.env.captureLocalPromptRemoval(s.handoffId, expected.owner, expected), null, mode);
      assert.equal(x.env.consumeLocalPromptEntry(s.handoffId, 'retired-known-no-attempt', expected), false, mode);
      assert.equal(x.env.promptHandoffMetaRef.current.get(s.handoffId), meta, mode);
      assert.deepEqual(x.rows(), [retiredRow, currentRow], mode);
      if (mode !== 'owner-attempt') {
        x.subscribe();
        const other = s.handoffId + '-other';
        assert.equal(handoffs.applyHistoryQueuedMessageMerge({ success: true, version: 1, tabId: s.tabId,
          receiptRetired: true, record: null, sourceHandoffIds: [s.handoffId, other],
          sourceOperationKeys: [s.operationKey, `history:${s.tabId}:${other}`] }), true);
        assert.equal(x.env.promptHandoffMetaRef.current.get(s.handoffId), meta, mode + ': real retired-source event');
        assert.deepEqual(x.rows(), [retiredRow, currentRow], mode + ': real retired-source event');
      }
    } finally { x.close(); }
  }
});

test('conditional promotion refuses a stale pre-owner and never certifies a reentrant replacement', () => {
  const s = subject(), bound = { sendOperationKey: s.operationKey, sendAttemptId: s.attemptId };
  const input = { entryUuid: 'canonical-user', sessionId: 's', sourceIdentityAliases: ['audit-old'] };
  const old = begin(s, bound, true);
  handoffs.consumeHistoryPromptHandoff(s.tabId, s.handoffId);
  const replacement = begin(s, bound, true);
  try {
    assert.equal(handoffs.adoptHistoryPromptHandoffCanonicalEntryIfCurrent(s.tabId, s.handoffId, old, input), undefined);
    assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(s.tabId)[0], replacement);
    assert.equal(replacement.auditProof.entryUuid, 'audit-old');
  } finally { handoffs.consumeHistoryPromptHandoff(s.tabId, s.handoffId); }
  const preOwner = begin(s, bound, true); let reentrant;
  const unsubscribe = handoffs.subscribeHistoryPromptHandoffs(s.tabId, (_snapshot, change) => {
    if (change.type === 'canonical-adopt') {
      handoffs.consumeHistoryPromptHandoff(s.tabId, s.handoffId); reentrant = begin(s, bound);
    }
  });
  try {
    const own = handoffs.adoptHistoryPromptHandoffCanonicalEntryIfCurrent(s.tabId, s.handoffId, preOwner, input);
    assert(own); assert.notEqual(own, preOwner); assert.equal(own.auditProof.entryUuid, 'canonical-user');
    assert.notEqual(own, reentrant); assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(s.tabId)[0], reentrant);
    assert.equal(handoffs.consumeHistoryPromptHandoffIfCurrent(s.tabId, s.handoffId, own), false);
  } finally { unsubscribe(); handoffs.consumeHistoryPromptHandoff(s.tabId, s.handoffId); }
  const unpromoted = begin(s, bound);
  try {
    assert.equal(handoffs.adoptHistoryPromptHandoffCanonicalEntryIfCurrent(s.tabId, s.handoffId, unpromoted, input), unpromoted);
    assert.equal(handoffs.consumeHistoryPromptHandoffIfCurrent(s.tabId, s.handoffId, unpromoted), true);
  } finally { handoffs.consumeHistoryPromptHandoff(s.tabId, s.handoffId); }
});

