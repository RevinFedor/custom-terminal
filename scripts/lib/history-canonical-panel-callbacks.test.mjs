// SOURCE only: execute the actual Panel callbacks and actual draft writer
// expressions, with a controlled IPC boundary. No Electron or native session.
// Node 24 and the repository @babel/parser are used only to erase/extract TS.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { captureHistoryComposerDraftOwner, noteHistoryComposerDraftWrite }
  from '../../src/renderer/utils/historyComposerDraftOwner.mjs';
import { normalizeComposerChips, upsertComposerChip, removeComposerChip }
  from '../../src/renderer/utils/composerChips.mjs';
import { normalizeHistoryPendingImageImports, createHistoryImageImportOperation,
  HISTORY_IMAGE_PENDING_MARKER } from '../../src/renderer/utils/historyImageImportOwnership.mjs';
import { restoreHistorySendDraft } from '../../src/renderer/utils/historySendReturn.mjs';
import * as preview from '../../src/renderer/utils/historyTerminalPreviewHandoff.mjs';
import * as handoffs from '../../src/renderer/utils/historyPromptHandoffs.ts';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
function sourceTree(relative, range = null) {
  let source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  if (range) {
    const first = source.indexOf(range[0]), last = source.indexOf(range[1], first + range[0].length);
    assert(first >= 0 && last > first); assert.equal(source.indexOf(range[0], first + 1), -1);
    source = source.slice(first, last);
  }
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }), all = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type) all.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit); else visit(value);
    }
  };
  visit(ast);
  const text = node => source.slice(node.start, node.end);
  const only = nodes => { assert.equal(nodes.length, 1); return nodes[0]; };
  return { source, text, all,
    expression: name => only(all.filter(n => n.type === 'VariableDeclarator' && n.id.name === name)).init,
    callback: name => only(all.filter(n => n.type === 'VariableDeclarator' && n.id.name === name)).init.arguments[0],
    effect: (marker, hook = 'useEffect') => only(all.filter(n => n.type === 'CallExpression'
      && n.callee.name === hook && text(n.arguments[0]).includes(marker))).arguments[0],
    property: name => only(all.filter(n => n.type === 'ObjectProperty' && n.key.name === name
      && n.value.type === 'ArrowFunctionExpression')).value,
    evaluate(node, environment) {
      return Function(...Object.keys(environment), 'return ' + stripTypeScriptTypes('(' + text(node) + ')', { mode: 'strip' }))
        (...Object.values(environment));
    },
  };
}
const panel = sourceTree('../../src/renderer/components/Workspace/HistoryPanel.tsx');
const ui = sourceTree('../../src/renderer/store/useUIStore.ts');
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const ref = current => ({ current });
const poison = new Proxy({}, { get() { throw Error('forbidden all-N metadata caller'); } });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const storageData = new Map();
const storage = { getItem: key => storageData.get(key) ?? null, setItem: (key, value) => storageData.set(key, value),
  removeItem: key => storageData.delete(key) };
globalThis.localStorage = storage;
let nextTab = 0;
function makeStore(initial = {}) {
  let state = { historyPromptDrafts: {}, historyPromptDraftImages: {}, historyPromptDraftChips: {},
    historyPromptDraftPendingImages: {}, historyPromptDraftUpdatedAt: {}, historyPromptReturnedSends: {},
    promptQueueInputSurfaceTabs: {}, historyRewindPreviews: {}, historyComposerAvailability: {}, promptPickerOpen: false,
    ...initial };
  const listeners = new Set(), writes = [], persisted = [];
  const store = { getState: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(value) { const patch = typeof value === 'function' ? value(state) : value;
      state = { ...state, ...patch }; for (const fn of [...listeners]) fn(state); },
    get readerCount() { return listeners.size; } };
  const env = { set: store.set, get: store.getState, useUIStore: store, noteHistoryComposerDraftWrite,
    normalizeHistoryPendingImageImports, normalizeComposerChips, upsertComposerChip, removeComposerChip,
    restoreHistorySendDraft, localStorage: { ...storage, setItem: (_key, value) => persisted.push(value) },
    HISTORY_COMPOSER_DRAFTS_STORAGE_KEY: 'finite-drafts', Date: { now: () => 500 } };
  for (const name of ['setHistoryPromptDraft', 'setHistoryPromptDraftChips', 'addHistoryPromptDraftChip',
    'removeHistoryPromptDraftChip', 'appendHistoryPromptDraft', 'restoreHistorySendDraft']) {
    const action = ui.evaluate(ui.property(name), env);
    store[name] = (...args) => { writes.push([name, ...args]); return action(...args); };
  }
  return { store, writes, persisted };
}

test('actual UIStore writers invalidate only active matching composer owners, including equal-value same-ms writes', () => {
  const r = makeStore({ historyPromptDrafts: { a: 'same', b: 'same' }, historyPromptDraftUpdatedAt: { a: 500, b: 500 } });
  const first = captureHistoryComposerDraftOwner({ store: r.store, tabId: 'a' });
  const second = captureHistoryComposerDraftOwner({ store: r.store, tabId: 'a' });
  r.store.setHistoryPromptDraft('b', 'same', { preserveImages: true, preserveChips: true });
  assert(first.isCurrent()); assert(second.isCurrent());
  first.dispose(); assert.equal(r.store.readerCount, 1);
  r.store.setHistoryPromptDraft('a', 'same', { preserveImages: true, preserveChips: true });
  assert.equal(r.store.getState().historyPromptDraftUpdatedAt.a, 500);
  assert.equal(second.isCurrent(), false, 'same text and clock are a newer real writer');
  second.dispose(); second.dispose(); assert.equal(r.store.readerCount, 0);
  for (const [name, args] of [
    ['setHistoryPromptDraftChips', ['a', []]], ['addHistoryPromptDraftChip', ['a', { id: 'chip', kind: 'prompt', text: 'full chip' }]],
    ['removeHistoryPromptDraftChip', ['a', 'absent']], ['appendHistoryPromptDraft', ['a', 'more']],
    ['restoreHistorySendDraft', [{ tabId: 'a', token: 'return-token', handoffId: 'return-handoff', text: 'return text' }]],
  ]) {
    const owner = captureHistoryComposerDraftOwner({ store: r.store, tabId: 'a' });
    r.store[name](...args); assert.equal(owner.isCurrent(), false, name); owner.dispose();
  }
  assert.equal(r.persisted.length, 1);
  const noOp = captureHistoryComposerDraftOwner({ store: r.store, tabId: 'a' });
  r.store.appendHistoryPromptDraft('a', ''); assert(noOp.isCurrent()); noOp.dispose();
  const aba = captureHistoryComposerDraftOwner({ store: r.store, tabId: 'a' });
  const text = r.store.getState().historyPromptDrafts.a;
  r.store.setHistoryPromptDraft('a', ''); r.store.setHistoryPromptDraft('a', text);
  assert.equal(aba.isCurrent(), false); aba.dispose(); assert.equal(r.store.readerCount, 0);
});

test('current composition witness retains full chips/images and fences pending imports, picker, input surface and rewind ABA', () => {
  for (const field of ['historyPromptDraftImages', 'historyPromptDraftChips', 'historyPromptDraftPendingImages',
    'historyPromptReturnedSends', 'promptQueueInputSurfaceTabs', 'historyRewindPreviews', 'historyComposerAvailability']) {
    const r = makeStore(), owner = captureHistoryComposerDraftOwner({ store: r.store, tabId: 'a' });
    const before = r.store.getState()[field];
    r.store.set({ [field]: { ...before, a: { full: '\0\ud800😀' + 'body'.repeat(3000) } } });
    r.store.set({ [field]: before });
    assert.equal(owner.isCurrent(), false, field + ' ABA'); owner.dispose();
  }
  const r = makeStore(), owner = captureHistoryComposerDraftOwner({ store: r.store, tabId: 'a' });
  r.store.set({ promptPickerOpen: true }); r.store.set({ promptPickerOpen: false });
  assert.equal(owner.isCurrent(), false); owner.dispose();
});

function receipt(tabId, changes = {}) {
  return { tabId, handoffId: 'h-' + tabId, operationKey: 'op-' + tabId, attemptId: 'attempt-' + tabId,
    provider: 'codex', sessionId: 's', surface: 'desktop-history', state: 'not-submitted', updatedAt: 20,
    transcriptBoundary: { available: true, sessionId: 's', fileSize: 100 },
    receipt: { promptText: 'same\r\nfull \0\ud800😀 text' }, ...changes };
}
const dismissedControl = record => ({ tabId: record.tabId, handoffId: record.handoffId,
  operationKey: record.operationKey, attemptId: record.attemptId ?? null, provider: record.provider,
  state: record.state, surface: 'desktop-history',
  receipt: { presentationDismissedAt: 7, presentationDismissedSurface: 'desktop-history' } });
function begin(record, changes = {}) {
  return handoffs.beginHistoryPromptHandoff({ tabId: record.tabId, handoffId: record.handoffId,
    sendOperationKey: record.operationKey, sendAttemptId: record.attemptId, toolType: record.provider,
    text: record.receipt.promptText, sessionIdHint: record.sessionId, submittedAt: 1, ...changes });
}
test('actual receipt recovery owner fences attempt/new handoff, hide/cancel/return and absence ABA; sibling owner is independent', () => {
  const record = receipt('owner-' + ++nextTab);
  const first = handoffs.captureHistoryReceiptRecoveryOwner(record), second = handoffs.captureHistoryReceiptRecoveryOwner(record);
  assert(first.isCurrent()); assert(second.isCurrent()); first.dispose();
  const unrelated = receipt('owner-' + ++nextTab); begin(unrelated); assert(second.isCurrent());
  handoffs.consumeHistoryPromptHandoff(unrelated.tabId, unrelated.handoffId);
  begin(record); handoffs.consumeHistoryPromptHandoff(record.tabId, record.handoffId);
  assert.equal(second.isCurrent(), false, 'captured absence cannot survive begin/consume ABA'); second.dispose();
  for (const kind of ['attempt', 'hide', 'cancel', 'return']) {
    const next = receipt('owner-' + ++nextTab); begin(next);
    let invalidations = 0;
    const owner = handoffs.captureHistoryReceiptRecoveryOwner(next, { onInvalidated: () => invalidations++ });
    if (kind === 'attempt') begin(next, { sendAttemptId: 'new-attempt' });
    else if (kind === 'return') handoffs.recordHistorySendReturnControl({ version: 1, tabId: next.tabId,
      handoffId: next.handoffId, token: 'token', state: 'returned', returnedAt: 2 });
    else handoffs.hydrateHistoryPromptHandoffFromDurableReceipt({ ...next,
      deliveryControl: { version: 1, cancelledAt: 5, presentationDismissed: kind === 'hide' } });
    assert.equal(owner.isCurrent(), false, kind);
    if (kind !== 'cancel') assert(invalidations > 0, kind + ' revoked the awaited signal');
    owner.dispose(); handoffs.consumeHistoryPromptHandoff(next.tabId, next.handoffId);
  }
  for (const change of [{ toolType: 'claude' }, { sessionIdHint: 'foreign-session' }, { sendOperationKey: 'foreign-operation' }]) {
    const next = receipt('owner-' + ++nextTab); begin(next, change);
    const owner = handoffs.captureHistoryReceiptRecoveryOwner(next);
    assert.equal(owner.isCurrent(), false); owner.dispose(); handoffs.consumeHistoryPromptHandoff(next.tabId, next.handoffId);
  }
});

function receiptRig({ draft = undefined, primary = true, cold = false, query, root: suppliedRoot, records: suppliedRecords, beforeEffect = () => {} } = {}) {
  const tabId = 'recovery-' + ++nextTab, record = receipt(tabId);
  const r = makeStore({ historyPromptDrafts: draft === undefined ? {} : { [tabId]: draft },
    historyPromptDraftUpdatedAt: draft ? { [tabId]: 500 } : {} });
  const records = suppliedRecords?.(record) || [record], requests = [], invocations = [], removals = [], diagnostics = [];
  const list = deferred(), root = cold ? null : suppliedRoot || { header: Object.freeze({ leaseId: 'held-' + tabId }), closed: false };
  if (!suppliedRoot && !cold) root.hasLaterCanonicalReceipt = async (value, options) => {
    const d = deferred(); requests.push({ record: value, options, ...d });
    return query ? query(value, options) : d.promise;
  };
  let dismiss = async () => ({ success: true, dismissed: true, presentationControl: dismissedControl(records[0]) });
  let receiptRevision = 0;
  const env = { ...handoffs, captureHistoryComposerDraftOwner, primaryPhysicalCandidate: primary,
    setReceiptPresentationRevision: update => { receiptRevision = update(receiptRevision); },
    historyOwnerKey: 'owner', historyOwnerKeyRef: ref('owner'), historyOwnerGenerationRef: ref(2),
    primaryRootRef: ref(root), useUIStore: r.store, tabId, toolType: 'codex', historyDiag: value => diagnostics.push(value),
    ipcRenderer: { invoke: async (channel, payload) => { invocations.push([channel, payload]);
      if (channel === 'agent:list-send-receipts') return list.promise;
      if (channel === 'agent:dismiss-send-receipt-presentation') return dismiss(payload);
      throw Error('unexpected IPC ' + channel); } },
    setHistoryPromptDraft: r.store.setHistoryPromptDraft, flushHistoryComposerDrafts: () => invocations.push(['flush']),
    presentedOwnerKey: 'owner', chipsFreshOwnerKey: 'owner', rawServerEntriesRef: ref(poison),
    committedHistoryEntriesRef: ref({ ownerKey: 'owner', entries: poison }),
    acknowledgeMaterializedHistoryReceipt: async () => { throw Error('unmigrated confirmed receipt scan'); },
    removeLocalPromptEntry: (...args) => removals.push(args), AbortController,
    console: { warn: (...args) => diagnostics.push(args.join(' ')) },
  };
  beforeEffect(record);
  const cleanup = panel.evaluate(panel.effect("'agent:list-send-receipts'"), env)();
  return { ...r, env, root, record, records, requests, invocations, removals, diagnostics, cleanup,
    get receiptRevision() { return receiptRevision; },
    setDismiss: fn => { dismiss = fn; }, resolveList: () => list.resolve({ success: true, records }) };
}

test('actual recovery effect awaits canonical proof, never scans root metadata, and dismisses only the original presentation', async () => {
  const r = receiptRig({ draft: 'same\nfull \0\ud800😀 text' });
  r.resolveList(); await tick(); assert.equal(r.requests.length, 1); assert.equal(r.writes.length, 0);
  assert.equal(r.requests[0].record, r.record); assert(r.requests[0].options.owns());
  r.requests[0].resolve(true); await tick();
  assert.equal(r.store.getState().historyPromptDrafts[r.record.tabId], undefined);
  assert.deepEqual(r.invocations.filter(x => x[0].startsWith('agent:')).map(x => x[0]),
    ['agent:list-send-receipts', 'agent:dismiss-send-receipt-presentation']);
  assert.deepEqual(r.invocations.find(x => x[0] === 'agent:dismiss-send-receipt-presentation')[1],
    { tabId: r.record.tabId, handoffId: r.record.handoffId, failedOnly: true,
      operationKey: r.record.operationKey, attemptId: r.record.attemptId });
  assert.equal(r.removals[0][0], r.record.handoffId); assert.equal(r.store.readerCount, 0); r.cleanup();
});

test('actual recovery effect preserves newer equal text, clear/retype, chips/images/pending/picker across every await', async () => {
  for (const when of ['list', 'canonical']) for (const change of ['equal', 'aba', 'chips', 'images', 'pending', 'picker']) {
    const r = receiptRig({ draft: 'same\nfull \0\ud800😀 text' }), tab = r.record.tabId;
    if (when === 'canonical') { r.resolveList(); await tick(); }
    if (change === 'equal') r.store.setHistoryPromptDraft(tab, r.record.receipt.promptText,
      { preserveImages: true, preserveChips: true });
    if (change === 'aba') { r.store.setHistoryPromptDraft(tab, ''); r.store.setHistoryPromptDraft(tab, r.record.receipt.promptText); }
    if (change === 'chips') r.store.addHistoryPromptDraftChip(tab, { id: 'full', kind: 'prompt', text: 'body'.repeat(5000) + '\ud800' });
    if (change === 'images') r.store.setHistoryPromptDraft(tab, r.record.receipt.promptText,
      { images: [{ id: 1, path: '/synthetic/full image.png', assetId: 'asset' }] });
    if (change === 'pending') r.store.set({ historyPromptDraftPendingImages: { [tab]: [{ operation: { id: 'pending' } }] } });
    if (change === 'picker') r.store.set({ promptPickerOpen: true });
    const newer = r.store.getState(), writes = r.writes.length;
    if (when === 'list') { r.resolveList(); await tick(); }
    r.requests[0].resolve(true); await tick();
    assert.equal(r.writes.length, writes, when + '/' + change);
    assert.equal(r.store.getState(), newer, 'no full authoring value was replaced');
    assert.equal(r.invocations.filter(x => x[0] === 'agent:dismiss-send-receipt-presentation').length, 1,
      'later canonical fact still retires the old recovery source without asserting Send');
    r.cleanup(); assert.equal(r.store.readerCount, 0);
  }
});

test('actual absence restores only the still-owned empty composer; UNKNOWN and nonboolean results never mean absence', async () => {
  for (const result of [false, 'UNKNOWN', undefined, null, {}]) {
    const r = receiptRig(); r.resolveList(); await tick();
    if (result === 'UNKNOWN') r.requests[0].reject(Object.assign(Error('unknown'), { code: 'UNKNOWN' }));
    else r.requests[0].resolve(result);
    await tick();
    if (result === false) {
      assert.equal(r.store.getState().historyPromptDrafts[r.record.tabId], r.record.receipt.promptText);
      assert.equal(r.invocations.filter(x => x[0] === 'agent:dismiss-send-receipt-presentation').length, 1);
    } else { assert.equal(r.writes.length, 0); assert.equal(r.removals.length, 0);
      assert.equal(r.invocations.filter(x => x[0] === 'agent:dismiss-send-receipt-presentation').length, 0); }
    r.cleanup(); assert.equal(r.store.readerCount, 0);
  }
  for (const change of [r => r.store.setHistoryPromptDraft(r.record.tabId, ''),
    r => r.store.setHistoryPromptDraftChips(r.record.tabId, [{ id: 'c', kind: 'prompt', text: 'new' }])]) {
    const r = receiptRig(); r.resolveList(); await tick(); change(r);
    const writes = r.writes.length; r.requests[0].resolve(false); await tick();
    assert.equal(r.writes.length, writes); assert.equal(r.invocations.filter(x => x[0].startsWith('agent:dismiss')).length, 0); r.cleanup();
  }
});

test('actual receipt effect rejects stale root/owner/generation/handoff and does not consume a new attempt after dismissal await', async () => {
  for (const mutate of [r => { r.root.header = { leaseId: 'new' }; },
    r => { r.env.historyOwnerKeyRef.current = 'new'; }, r => r.env.historyOwnerGenerationRef.current++,
    r => { begin(r.record); handoffs.consumeHistoryPromptHandoff(r.record.tabId, r.record.handoffId); },
    r => r.cleanup()]) {
    const r = receiptRig(); r.resolveList(); await tick(); mutate(r); r.requests[0].resolve(false); await tick();
    assert.equal(r.writes.length, 0); assert.equal(r.removals.length, 0); r.cleanup(); assert.equal(r.store.readerCount, 0);
  }
  const r = receiptRig(), dismissed = deferred(); r.setDismiss(() => dismissed.promise);
  r.resolveList(); await tick(); r.requests[0].resolve(true); await tick();
  begin(r.record, { sendAttemptId: 'new-attempt' }); dismissed.resolve({ success: true, dismissed: true }); await tick();
  assert.equal(r.removals.length, 0); assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(r.record.tabId)[0]?.sendAttemptId, 'new-attempt');
  handoffs.consumeHistoryPromptHandoff(r.record.tabId, r.record.handoffId); r.cleanup();
});

test('already-hidden durable presentation uses existing exact cleanup without canonical query or draft restoration', async () => {
  const r = receiptRig({ beforeEffect: record => begin(record), records: record => [{ ...record,
    receipt: { ...record.receipt, presentationDismissedAt: 1, presentationDismissedSurface: 'desktop-history' } }] });
  r.resolveList(); await tick();
  assert.equal(r.requests.length, 0); assert.equal(r.writes.length, 0);
  assert.equal(r.removals[0]?.[0], r.record.handoffId);
  assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(r.record.tabId).length, 0); r.cleanup();
  const foreign = receiptRig({ records: record => [{ ...record, tabId: 'foreign-tab' }] });
  foreign.resolveList(); await tick(); assert.equal(foreign.requests.length, 0);
  assert.equal(foreign.writes.length, 0); assert.equal(foreign.removals.length, 0); foreign.cleanup();
});

test('actual coauthor read lease rejects pre-list and in-flight explicit X, including hidden-control eviction', async () => {
  for (const when of ['list', 'canonical']) {
    const r = receiptRig();
    if (when === 'canonical') { r.resolveList(); await tick(); }
    assert.equal(handoffs.recordHistorySendPresentationDismissal(dismissedControl(r.record)), true);
    if (when === 'list') { r.resolveList(); await tick(); assert.equal(r.requests.length, 0); }
    else { assert(r.requests[0].options.signal.aborted); r.requests[0].resolve(false); await tick(); }
    assert.equal(r.writes.length, 0); assert.equal(r.removals.length, 0); r.cleanup();
  }
  const local = new handoffs.HistoryPromptHandoffStore({ maxTabs: 1, maxHandoffs: 1, maxBytes: 1024 }),
    read = local.beginReceiptRead('eviction');
  const originalWarn = console.warn; console.warn = () => {};
  try {
    for (let i = 0; i < 258; i++) local.recordPresentationDismissal(dismissedControl(receipt('eviction',
      { handoffId: 'h' + i, operationKey: 'op' + i })));
    assert.equal(read.isCurrent(), false, 'eviction cannot resurrect an already invalidated active read');
  } finally { read.close(); console.warn = originalWarn; }
});

test('pending actual receipt list rejects pre-capture handoff begin/consume ABA and wakes a fresh read', async () => {
  for (const mode of ['new-attempt', 'same-attempt', 'return', 'retract']) {
    const r = receiptRig();
    begin(r.record, mode === 'new-attempt' ? { sendAttemptId: 'new-attempt', text: 'new full text' } : {});
    if (mode === 'return') handoffs.recordHistorySendReturnControl({ version: 1, tabId: r.record.tabId,
      handoffId: r.record.handoffId, token: 'new-return', state: 'returned', returnedAt: 5 });
    if (mode === 'retract') handoffs.retractHistoryPromptHandoff(r.record.tabId, r.record.handoffId, 'new intent ended');
    else handoffs.consumeHistoryPromptHandoff(r.record.tabId, r.record.handoffId);
    r.setDismiss(async () => ({ success: false, reason: 'attempt-changed' }));
    r.resolveList(); await tick();
    assert.equal(r.requests.length, 0, mode + ': stale list gets no canonical read');
    assert.equal(r.writes.length, 0, mode + ': no stale composer restore');
    assert.equal(r.invocations.filter(x => x[0].startsWith('agent:dismiss')).length, 0);
    assert.equal(r.receiptRevision, 1, 'one event wake, no poll or permanent ID inventory');
    r.cleanup(); assert.equal(r.store.readerCount, 0);
  }
});

test('list adoption transfers to original per-record ownership; foreign-tab lifecycle is unrelated', async () => {
  const r = receiptRig(), other = receipt('unrelated-' + ++nextTab);
  begin(other); handoffs.consumeHistoryPromptHandoff(other.tabId, other.handoffId);
  assert.equal(r.receiptRevision, 0);
  r.resolveList(); await tick(); assert.equal(r.requests.length, 1);
  r.requests[0].resolve(false); await tick();
  assert.equal(r.store.getState().historyPromptDrafts[r.record.tabId], r.record.receipt.promptText);
  r.cleanup(); assert.equal(r.store.readerCount, 0);
});

test('own successful dismissal permits only the original cleanup and stops the rest of its old list', async () => {
  const r = receiptRig({ records: first => [first, { ...first, handoffId: first.handoffId + '-next',
    operationKey: first.operationKey + '-next' }] });
  r.resolveList(); await tick(); r.requests[0].resolve(true); await tick();
  assert.equal(r.requests.length, 1, 'own dismissal invalidates the pre-control list lease');
  assert.deepEqual(r.removals.map(row => row[0]), [r.record.handoffId]); r.cleanup();
  for (const mode of ['new', 'aba']) {
    const next = receiptRig();
    const unsubscribe = handoffs.subscribeHistoryPromptHandoffs(next.record.tabId, (_snapshot, change) => {
      if (change.type !== 'presentation-control') return;
      begin(next.record);
      if (mode === 'aba') handoffs.consumeHistoryPromptHandoff(next.record.tabId, next.record.handoffId);
    });
    next.resolveList(); await tick(); next.requests[0].resolve(true); await tick();
    assert.equal(next.removals.length, 0, 'a fresh post-dismiss capture must not adopt reentrant ' + mode);
    if (mode === 'new') assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(next.record.tabId)[0]?.sendAttemptId,
      next.record.attemptId, 'same-attempt new handoff survives');
    unsubscribe(); handoffs.consumeHistoryPromptHandoff(next.record.tabId, next.record.handoffId); next.cleanup();
  }
  const wrong = receiptRig();
  wrong.setDismiss(async () => ({ success: true, dismissed: true,
    presentationControl: dismissedControl({ ...wrong.record, attemptId: 'foreign-attempt' }) }));
  wrong.resolveList(); await tick(); wrong.requests[0].resolve(true); await tick();
  assert.equal(wrong.removals.length, 0); wrong.cleanup();
});

test('cold application-queue refusal still hydrates its full failed presentation before canonical projection', async () => {
  const r = receiptRig({ cold: true, records: record => [{ ...record, attemptId: null,
    applicationQueue: { version: 1, id: 42, position: 9, state: 'cancelled' },
    createdAt: 10, updatedAt: 11, receipt: { ...record.receipt, source: 'history-panel',
      authoringSnapshot: { editorText: 'full original \0\ud800😀', chips: [], imagePaths: [] },
      presentationSnapshot: { imagePaths: [], promptChips: [], historySessionId: 's' } } }] });
  r.resolveList(); await tick();
  assert.equal(r.requests.length, 0); assert.equal(r.writes.length, 0);
  const value = handoffs.getHistoryPromptHandoffsSnapshot(r.record.tabId)[0];
  assert.equal(value?.queueStatus, 'cancelled'); assert.equal(value?.applicationQueueId, 42);
  assert.equal(value?.applicationQueuePosition, 9); assert.equal(value?.authoringText, 'full original \0\ud800😀');
  assert.equal(value?.text, r.record.receipt.promptText); assert.equal(value?.sessionIdHint, 's');
  r.cleanup(); handoffs.consumeHistoryPromptHandoff(r.record.tabId, r.record.handoffId);
});

test('actual Main failed-only handler rejects a new attempt after the Panel sent its old exact CAS identity', async () => {
  const main = sourceTree('../../src/main/main.js', ["ipcMain.handle('agent:dismiss-send-receipt-presentation'",
    "ipcMain.handle('agent:record-history-context'"]);
  const call = main.all.find(node => node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression' && node.callee.object.name === 'ipcMain'
    && node.callee.property.name === 'handle' && node.arguments[0]?.value === 'agent:dismiss-send-receipt-presentation');
  assert(call);
  const ready = deferred(), r = receiptRig(), operations = [];
  let current = r.record;
  const handler = main.evaluate(call.arguments[1], { agentSendReceiptStartupReady: ready.promise,
    DESKTOP_HISTORY_SEND_SURFACE: 'desktop-history',
    agentSendReceiptStore: { list: () => [current], dismissPresentation: input => { operations.push(input);
      return { ok: true, applied: true, record: { ...current, receipt: dismissedControl(current).receipt } }; } },
    path: { join: (...parts) => parts.join('/') }, srcMainDir: '/finite/main',
    require: name => { assert.equal(name, '/finite/main/web-server'); return { releaseQueuedSendPresentation() {} }; },
    console: { warn() {} },
  });
  r.setDismiss(payload => handler({}, payload));
  r.resolveList(); await tick(); r.requests[0].resolve(true); await tick();
  current = { ...r.record, attemptId: 'new-attempt' }; ready.resolve(); await tick();
  assert.equal(operations.length, 0); assert.equal(r.removals.length, 0);
  const payload = r.invocations.find(row => row[0] === 'agent:dismiss-send-receipt-presentation')[1];
  assert.equal(payload.failedOnly, true); assert.equal(payload.attemptId, r.record.attemptId);
  current = r.record; const success = await handler({}, payload);
  assert.equal(success.success, true); assert.equal(success.presentationControl.attemptId, r.record.attemptId);
  assert.equal(operations.length, 1); r.cleanup();
});

function previewRig() {
  const result = { header: Object.freeze({ leaseId: 'preview' }), canonicalPresent: true, preparedPresent: true,
    preparedTextHash: createHash('sha256').update('full body').digest('hex'), target: null };
  const handoff = { previewId: 'preview-id', canonicalIdentity: 'source-exact\0\ud800😀', canonicalTextHash: result.preparedTextHash.slice(0, 16),
    ownerKey: 'owner', ownerGeneration: 2, presentationVisit: 3, phase: 'waiting-row', anchorKind: 'tail',
    scrollOwnerToken: null, anchorOffsetPx: null, followBottom: true, gestureGeneration: 1, gestureAt: 0, requestedAt: 0 };
  const root = { header: result.header, totalCount: 50000, closed: false, hasCurrentPresentationCoverage: () => true,
    addressAt: () => null }, publications = [], requests = [], removals = [], frames = [], logs = [];
  root.readTerminalPreviewMembership = (identity, options) => { const d = deferred(); requests.push({ identity, options, ...d }); return d.promise; };
  let inputs = true;
  const scroller = { isConnected: true, scrollTop: 10, scrollHeight: 1000, clientHeight: 100, querySelector: () => null,
    getBoundingClientRect: () => ({ top: 0 }), addEventListener() {}, removeEventListener() {} };
  const env = { ...preview, primaryPhysicalCandidate: true, primaryRoot: root, primaryRootRef: ref(root), primaryHeader: result.header,
    primaryTerminalPreviewMembership: null, primaryTerminalPreviewMembershipRef: ref(null),
    primaryInputsCurrent: () => inputs, historyOwnerKey: 'owner', historyOwnerKeyRef: ref('owner'), historyOwnerGenerationRef: ref(2),
    historyOwnerDomId: 'owner-dom', terminalPreviewClearHandoff: handoff, terminalPreviewClearHandoffRef: ref(handoff),
    terminalPreviewCanonicalIdentity: handoff.canonicalIdentity, terminalPreviewRef: ref({ previewId: handoff.previewId }),
    historyPresentationProofRef: ref({ visit: 3, presented: true }), primaryPresentation: {},
    historyUserGestureGenerationRef: ref(1), historyUserGestureAtRef: ref(0), historyPointerScrollActiveRef: ref(false),
    isAtBottomRef: ref(true), virtuosoScrollerRef: ref(scroller), panelRef: ref({ querySelector: () => null }),
    terminalPreviewHandoffGuardDigestRef: ref(''), terminalPreviewAnchorSettleCancelRef: ref(null),
    terminalPreviewAnchorSettleSignalRef: ref(null), historyRestoreTokenRef: ref(0), historyRestoreInFlightRef: ref(0),
    historyScrollSeekController: { stampMachineScrollCooldown() {} },
    displayEntries: poison, displayEntriesRef: ref(poison), displayUnitsRef: ref(poison), unitIndexByUuidRef: ref(poison), renderEntries: poison,
    historyLivePresentationIdentities: () => { throw Error('legacy live predicate'); },
    historyServicePromptFingerprint: () => { throw Error('legacy full body'); },
    setTerminalPreview: value => removals.push(value),
    publishTerminalPreviewClearHandoff: value => { publications.push(value); env.terminalPreviewClearHandoffRef.current = value; },
    publishPrimaryTerminalPreviewMembership: value => { env.primaryTerminalPreviewMembershipRef.current = value;
      env.primaryTerminalPreviewMembership = value; },
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    stabilizeHistoryRevealAnchor: () => { throw Error('unexpected geometry writer'); },
    CSS: { escape: x => x }, AbortController, tabId: 'tab', toolType: 'codex',
    HISTORY_TERMINAL_PREVIEW_DOM_PROBE_FRAMES: 3, historyDiag: line => logs.push(line), performance: { now: () => 1 },
  };
  env.readCurrentPrimaryTerminalPreviewMembership = panel.evaluate(panel.callback('readCurrentPrimaryTerminalPreviewMembership'), env);
  env.resolveTerminalPreviewCanonicalTarget = panel.evaluate(panel.callback('resolveTerminalPreviewCanonicalTarget'), env);
  env.readTerminalPreviewCanonicalNode = panel.evaluate(panel.callback('readTerminalPreviewCanonicalNode'), env);
  const prove = () => env.publishPrimaryTerminalPreviewMembership({ root, ownerKey: 'owner', generation: 2,
    previewId: handoff.previewId, identity: handoff.canonicalIdentity, expectedHash: handoff.canonicalTextHash, result });
  return { env, root, result, handoff, requests, publications, removals, frames, scroller, logs, prove, setInputs: value => { inputs = value; } };
}

test('actual terminal membership effect awaits one current proof and aborts stale owner/header/composition/preview', async () => {
  const node = panel.effect('root.readTerminalPreviewMembership(identity');
  const r = previewRig(), stop = panel.evaluate(node, r.env)();
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].identity, r.handoff.canonicalIdentity);
  assert.equal(r.env.readCurrentPrimaryTerminalPreviewMembership(r.handoff.canonicalIdentity), null);
  r.requests[0].resolve(r.result); await tick();
  assert.equal(r.env.readCurrentPrimaryTerminalPreviewMembership(r.handoff.canonicalIdentity), r.result);
  assert.equal(panel.evaluate(node, r.env)(), undefined); assert.equal(r.requests.length, 1); stop();
  for (const mutate of [r => { r.root.header = {}; }, r => r.env.historyOwnerGenerationRef.current++,
    r => { r.env.historyOwnerKeyRef.current = 'other'; }, r => r.setInputs(false),
    r => { r.env.terminalPreviewClearHandoffRef.current = { ...r.handoff, previewId: 'other' }; },
    r => { r.env.terminalPreviewClearHandoffRef.current = { ...r.handoff, canonicalTextHash: 'other' }; }]) {
    const next = previewRig(), cancel = panel.evaluate(node, next.env)(); mutate(next);
    next.requests[0].resolve(next.result); await tick();
    assert.equal(next.env.primaryTerminalPreviewMembershipRef.current, null); cancel(); assert(next.requests[0].options.signal.aborted);
  }
  const unknown = previewRig(), cancel = panel.evaluate(node, unknown.env)();
  unknown.requests[0].reject(Object.assign(Error('unknown'), { code: 'UNKNOWN' })); await tick();
  assert.equal(unknown.env.primaryTerminalPreviewMembershipRef.current, null); assert.equal(unknown.removals.length, 0); cancel();
});

test('canonical source presence never substitutes for current prepared membership; tail clears before target mounts', () => {
  const node = panel.effect('const requested = terminalPreviewClearHandoff;', 'useLayoutEffect');
  const r = previewRig(); r.prove(); r.setInputs(false);
  assert.equal(panel.evaluate(panel.expression('terminalPreviewCanonicalInDurableProjection'), r.env), true,
    'canonical-only duplicate filter can retain its exact source fact while local inputs move');
  assert.equal(r.env.readCurrentPrimaryTerminalPreviewMembership(r.handoff.canonicalIdentity), null);
  panel.evaluate(node, r.env)(); assert.equal(r.removals.length, 0, 'a fresh prepared proof is still required');
  r.setInputs(true); r.result.preparedPresent = false;
  panel.evaluate(node, r.env)(); assert.equal(r.removals.length, 0);
  r.result.preparedPresent = true;
  // No address, body, mounted row or coverage is needed merely to remove the
  // duplicate Footer. A tall Footer used to make that dependency deadlock.
  r.root.hasCurrentPresentationCoverage = () => false;
  panel.evaluate(node, r.env)(); assert.deepEqual(r.removals, [null]);
  assert.equal(r.env.terminalPreviewClearHandoffRef.current.phase, 'clearing-preview');
  assert.equal(r.scroller.scrollTop, 10, 'no geometry write against duplicate layout');
});

test('actual canonical DOM callback requires exact current physical key/rank and current painted coverage', () => {
  const r = previewRig(), target = { canonicalUuid: 'u', domUuid: 'group-first', unitIndex: 47,
    groupKey: 'g', physicalKey: 'group:\0\ud800😀', presentationKind: 'group' };
  const wrapper = { getAttribute: () => '47' };
  const node = { getAttribute: () => target.physicalKey, closest: () => wrapper };
  r.scroller.querySelector = () => node; r.root.addressAt = index => index === 47 ? { physicalKey: target.physicalKey } : null;
  assert.equal(r.env.readTerminalPreviewCanonicalNode(r.scroller, target), node);
  for (const mutate of [() => { r.root.addressAt = () => ({ physicalKey: 'foreign' }); },
    () => { node.getAttribute = () => 'foreign'; }, () => { wrapper.getAttribute = () => '48'; },
    () => { r.root.hasCurrentPresentationCoverage = () => false; }, () => r.setInputs(false)]) {
    r.root.addressAt = () => ({ physicalKey: target.physicalKey }); node.getAttribute = () => target.physicalKey;
    wrapper.getAttribute = () => '47'; r.root.hasCurrentPresentationCoverage = () => true; r.setInputs(true); mutate();
    assert.equal(r.env.readTerminalPreviewCanonicalNode(r.scroller, target), null);
  }
});

test('duplicate UUID DOM rows cannot hide or authorize the exact selected physical rank', () => {
  const r = previewRig(), target = { domUuid: 'same-uuid', unitIndex: 47, physicalKey: 'last-physical-key' };
  const earlier = { getAttribute: () => 'earlier-physical-key',
    closest: () => ({ getAttribute: () => '3' }) };
  const exact = { getAttribute: () => target.physicalKey, closest: () => ({ getAttribute: () => '47' }) };
  let mounted = true;
  r.root.addressAt = index => index === 47 ? { physicalKey: target.physicalKey } : null;
  r.scroller.querySelector = selector => selector.startsWith('[data-item-index="47"] ')
    ? mounted ? exact : null : earlier;
  assert.equal(r.env.readTerminalPreviewCanonicalNode(r.scroller, target), exact,
    'the earlier UUID match must not hide the addressed last physical unit');
  mounted = false; assert.equal(r.env.readTerminalPreviewCanonicalNode(r.scroller, target), null);
  mounted = true; exact.getAttribute = () => 'earlier-physical-key';
  assert.equal(r.env.readTerminalPreviewCanonicalNode(r.scroller, target), null);
});

test('actual JSX row attributes bridge full presentation owner to DOM digest independently of the physical item key', () => {
  const r = previewRig(), fullOwner = 'history-snapshot-v1:5:codex8:tab-test9:session-x15:/finite/project';
  const historyOwnerDigest = panel.evaluate(panel.expression('historyOwnerDigest'), {});
  const domOwner = panel.evaluate(panel.expression('historyOwnerDomId').arguments[0], {
    historyOwnerKey: fullOwner, historyOwnerDigest,
  })();
  assert.match(domOwner, /^[a-f0-9]{8}$/); assert.notEqual(domOwner, fullOwner);
  r.env.historyOwnerDomId = domOwner; r.env.historyOwnerKeyRef.current = fullOwner;
  const target = { canonicalUuid: 'actual-uuid', domUuid: 'actual-uuid', unitIndex: 47,
    physicalKey: 'assistant-source:full-physical-key', groupKey: null, presentationKind: 'entry' };
  r.root.addressAt = index => index === 47 ? { physicalKey: target.physicalKey } : null;
  r.root.hasCurrentPresentationCoverage = scope => scope.ownerKey === fullOwner && scope.generation === 2
    && scope.visit === 3 && scope.presented === true;
  const historyPhysicalItemKeyAt = panel.evaluate(panel.callback('historyPhysicalItemKeyAt'), r.env);
  const opening = panel.all.filter(node => node.type === 'JSXOpeningElement'
    && panel.text(node).includes('data-uuid={presentedEntry.uuid}')
    && panel.text(node).includes('data-history-row-real="1"')
    && panel.text(node).includes('data-history-unit-key={historyPhysicalItemKeyAt(_idx)}'));
  assert(opening.length > 0);
  const renderedAttributes = opening.map(row => Object.fromEntries(row.attributes.filter(attr =>
    attr.type === 'JSXAttribute' && ['data-uuid', 'data-history-row-owner', 'data-history-row-real', 'data-history-unit-key'].includes(attr.name.name))
    .map(attr => [attr.name.name, attr.value.type === 'StringLiteral' ? attr.value.value
      : panel.evaluate(attr.value.expression, { presentedEntry: { uuid: target.domUuid },
        historyOwnerDomId: domOwner, historyPhysicalItemKeyAt, _idx: 47 })])));
  const attributes = renderedAttributes[0];
  for (const candidate of renderedAttributes) assert.deepEqual(candidate, attributes);
  assert.equal(attributes['data-history-row-owner'], domOwner);
  assert.equal(attributes['data-history-unit-key'], target.physicalKey);
  const wrapper = { getAttribute: name => name === 'data-item-index' ? '47' : null };
  const node = { getAttribute: name => attributes[name] ?? null, closest: () => wrapper };
  const selectorFor = owner => `[data-item-index="47"] [data-history-row-real][data-history-row-owner="${owner}"][data-uuid="actual-uuid"]`;
  r.scroller.querySelector = selector => selector === selectorFor(attributes['data-history-row-owner']) ? node : null;
  const read = () => panel.evaluate(panel.callback('readTerminalPreviewCanonicalNode'), r.env)(r.scroller, target);
  assert.equal(read(), node);
  r.env.historyOwnerDomId = fullOwner;
  assert.equal(read(), null, 'original wrong namespace comparison is rejected');
  r.env.historyOwnerDomId = domOwner; r.env.historyOwnerKeyRef.current = 'foreign-full-owner';
  assert.equal(read(), null, 'matching DOM digest alone cannot grant full-owner coverage');
  r.env.historyOwnerKeyRef.current = fullOwner; attributes['data-history-unit-key'] = domOwner;
  assert.equal(read(), null, 'an owner digest cannot substitute for a physical item key');
});

test('actual handoff rebase retains full-text integrity and preview reading requires the exact mounted replacement', () => {
  const node = panel.effect('const requested = terminalPreviewClearHandoff;', 'useLayoutEffect');
  const r = previewRig(); r.prove(); r.handoff.ownerGeneration = 1;
  r.result.preparedTextHash = '0'.repeat(64); panel.evaluate(node, r.env)(); assert.equal(r.removals.length, 0);
  assert(r.logs.some(line => line.includes('waiting-canonical-integrity')));
  r.handoff.ownerGeneration = 2; r.handoff.anchorKind = 'preview';
  r.result.target = { canonicalUuid: 'u', domUuid: 'u', unitIndex: 1, physicalKey: 'entry:u', groupKey: null, presentationKind: 'entry' };
  panel.evaluate(node, r.env)(); assert.equal(r.removals.length, 0); assert.equal(r.frames.length, 1);
  r.root.addressAt = () => ({ physicalKey: 'entry:u' });
  r.scroller.querySelector = () => ({ getAttribute: () => 'entry:u', closest: () => ({ getAttribute: () => '1' }) });
  r.frames.shift()(); assert.deepEqual(r.removals, [null]);
});

test('legacy receipt branch still evaluates the current native predicate with full values and does not use async truthiness', async () => {
  const r = receiptRig({ primary: false });
  r.env.rawServerEntriesRef.current = [{ role: 'user', uuid: 'later', sessionId: 's', recordByteOffset: 100,
    content: r.record.receipt.promptText }];
  r.resolveList(); await tick(); assert.equal(r.requests.length, 0); assert.equal(r.removals.length, 1); r.cleanup();
});

test('connected producer/client/model/Panel recovery claims the later complete USER value without any metadata lookup', async t => {
  const { HistoryPrimaryRootReadModel } = await import('../../src/renderer/utils/historyPrimaryRootReadModel.mjs');
  const { createPrimaryAddressFixture } = require('../test-support/history-primary-address-fixture.cjs');
  const full = 'same\r\nfull \0\ud800😀 text';
  const f = await createPrimaryAddressFixture(t, { entries: [
    { role: 'user', uuid: 'old', sessionId: 's', recordByteOffset: 99, content: full },
    { role: 'assistant', uuid: 'not-user', sessionId: 's', recordByteOffset: 101, content: full },
    { role: 'user', uuid: 'later', sessionId: 's', recordByteOffset: 100, content: full },
  ] });
  const model = new HistoryPrimaryRootReadModel(f.invoke, f.transport);
  assert.equal((await model.open(f.payload)).kind, 'root');
  const before = f.calls.length, parent = model.view.reader, r = receiptRig({ root: model, draft: full });
  try {
    r.resolveList();
    for (let index = 0; index < 10000 && r.store.readerCount; index++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(r.store.readerCount, 0, 'finite connected receipt callback completed');
    assert.equal(r.store.getState().historyPromptDrafts[r.record.tabId], undefined);
    assert.equal(r.removals.length, 1); assert.equal(parent.closed, false);
    const calls = f.calls.slice(before);
    assert(calls.some(call => call.kind === 'primary-canonical-consumers'));
    assert(!calls.some(call => call.kind === 'primary-metadata-fields' || call.kind === 'primary-durable-metadata-fields'));
    assert(f.plane.stats().maxPacketBytes <= 65536);
  } finally { r.cleanup(); await model.close(); }
});

test('connected producer/client/model/Panel keeps live-only prepared presence separate from canonical source and can clear tail', async t => {
  const { HistoryPrimaryRootReadModel } = await import('../../src/renderer/utils/historyPrimaryRootReadModel.mjs');
  const { createPrimaryAddressFixture } = require('../test-support/history-primary-address-fixture.cjs');
  const f = await createPrimaryAddressFixture(t), model = new HistoryPrimaryRootReadModel(f.invoke, f.transport);
  const r = previewRig();
  const entry = { role: 'assistant', uuid: 'live-only', sourceIdentity: r.handoff.canonicalIdentity, content: 'full body', sessionId: 's' };
  assert.equal((await model.open({ ...f.payload, primaryPresentation: { liveEntries: [entry] } })).kind, 'root');
  r.env.primaryRoot = model; r.env.primaryRootRef.current = model; r.env.primaryHeader = model.header;
  // Recreate actual ref-reading closures with the changed caller environment.
  r.env.readCurrentPrimaryTerminalPreviewMembership = panel.evaluate(panel.callback('readCurrentPrimaryTerminalPreviewMembership'), r.env);
  r.env.resolveTerminalPreviewCanonicalTarget = panel.evaluate(panel.callback('resolveTerminalPreviewCanonicalTarget'), r.env);
  r.env.readTerminalPreviewCanonicalNode = panel.evaluate(panel.callback('readTerminalPreviewCanonicalNode'), r.env);
  const before = f.calls.length;
  const cancel = panel.evaluate(panel.effect('root.readTerminalPreviewMembership(identity'), r.env)();
  try {
    for (let index = 0; index < 10000 && !r.env.primaryTerminalPreviewMembershipRef.current; index++) await new Promise(resolve => setImmediate(resolve));
    const proof = r.env.readCurrentPrimaryTerminalPreviewMembership(r.handoff.canonicalIdentity);
    assert(proof, 'finite connected terminal callback completed');
    assert.equal(proof.canonicalPresent, false); assert.equal(proof.preparedPresent, true);
    assert.equal(proof.preparedTextHash, r.result.preparedTextHash);
    assert.equal(panel.evaluate(panel.expression('terminalPreviewCanonicalInDurableProjection'), r.env), false);
    assert.equal(model.window.size, 0, 'membership does not fetch an off-screen native body');
    panel.evaluate(panel.effect('const requested = terminalPreviewClearHandoff;', 'useLayoutEffect'), r.env)();
    assert.deepEqual(r.removals, [null]); assert.equal(r.scroller.scrollTop, 10);
    assert(f.calls.slice(before).some(call => call.kind === 'primary-canonical-consumers'));
    assert.equal(model.view.reader.closed, false);
  } finally { cancel?.(); await model.close(); }
});
