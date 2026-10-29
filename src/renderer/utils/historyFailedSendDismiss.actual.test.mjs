// Actual footer/callback/Main handler + private real SQL/handoff/sparse owners.
// React scheduling, IPC transport and queue execution are finite adapters only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { X, RotateCcw } from 'lucide-react';
import { createRequire } from 'node:module';
import { historySendReturnEnabled, historySendPresentationAction as currentPresentationAction } from './historySendReturn.mjs';
import { planHistoryPromptPresentationDismissal } from './historyPromptPresentationDismissal.mjs';
import { readHistorySendRecovery, saveHistorySendRecovery } from './historySendRecovery.mjs';
import { installHistoryPromptPanelRows, privateHistoryPromptHandoffs } from './test-helpers/historyPromptPanelFixture.mjs';

const require = createRequire(import.meta.url);
const { DirectorySqlite } = require('../../main/fixtures/workflow-directory-sqlite.cjs');
const { createAgentSendReceiptStore } = require('../../main/agent-send-receipt-store');
const { AgentSendQueue } = require('../../main/agent-send-queue');
const { fingerprintAgentSendRequest } = require('../../main/agent-send-receipt-registry');
const preimage = process.env.HISTORY_UNKNOWN_PREIMAGE;
const panel = fs.readFileSync(preimage ? path.join(preimage, 'PRE-HistoryPanel.tsx')
  : new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const main = fs.readFileSync(preimage ? path.join(preimage, 'PRE-main.js') : new URL('../../main/main.js', import.meta.url), 'utf8');
const historySendPresentationAction = preimage ? vm.runInNewContext('(' + fs.readFileSync(path.join(preimage,
  'PRE-historySendReturn.mjs'), 'utf8').split('export function historySendPresentationAction')[1]
  .replace(/^\(entry\)/, 'function(entry)') + ')', { historySendReturnEnabled }) : currentPresentationAction;
const ast = ts.createSourceFile('HistoryPanel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback, button, removeCallback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'dismissPromptPresentation'
    && node.initializer?.expression?.getText(ast) === 'useCallback') callback = node.getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'removeLocalPromptEntry') removeCallback = node.getText(ast);
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'button'
    && node.openingElement.attributes.properties.some(p => p.name?.getText(ast) === 'data-history-send-dismiss')) button = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
const compile = source => ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;

test('actual failed/unknown footer uses X, pending footer keeps return/disabled, with no animation', () => {
  assert.ok(button, 'failed-card X must be wired in the actual footer');
  for (const [queueStatus, state] of [['failed', 'writing'], ['cancelled', 'available'], ['delivery-unknown', 'writing'], ['preparing', 'available'], ['sending', 'writing']]) {
    const entry = { queueStatus, historyReturn: { token: 'H', state } };
    const action = historySendPresentationAction(entry);
    assert.equal(action.kind, ['failed', 'cancelled', 'delivery-unknown'].includes(queueStatus) ? 'dismiss' : 'return');
    const context = vm.createContext({ React, X, RotateCcw, promptPresentationAction: action, returnEnabled: action.enabled,
      stopActionPropagation() {}, dismissPromptPresentation() {} });
    vm.runInContext(compile('globalThis.renderButton = () => (' + button + ');'), context);
    const html = renderToStaticMarkup(context.renderButton());
    assert.equal(html.includes('data-history-send-dismiss="true"'), action.kind === 'dismiss');
    assert.equal(html.includes('lucide-x'), action.kind === 'dismiss');
    assert.equal(html.includes('lucide-rotate-ccw'), action.kind === 'return');
    assert.equal(html.includes('disabled=""'), !action.enabled);
    assert.equal(html.includes('Вернуть сообщение в input'), action.kind === 'return');
    assert.doesNotMatch(html, /animate|shimmer/);
  }
});

function harness(t, { durable = true, attempt = true, reason = 'send-proven-not-submitted', providerRefusal = false, unknown = false } = {}) {
  assert.ok(callback);
  const db = new DirectorySqlite(), store = createAgentSendReceiptStore(db);
  t.after(() => db.close());
  const identity = { operationKey: 'history:T:H', tabId: 'T', handoffId: 'H', provider: 'codex',
    surface: 'desktop-history', requestFingerprint: 'private', promptHash: 'private', promptLength: 6 };
  let record;
  if (durable) {
    if (attempt) {
      const begun = store.beginAttempt(identity);
      store.settleAttempt(identity.operationKey, begun.attemptId, unknown ? {
        success: null, submitted: null, deliveryUnknown: true, status: 'delivery-unknown',
        promptText: 'frozen', enterWritten: null,
      } : providerRefusal ? {
        success: false, submitted: true, pasteWritten: true, enterWritten: true,
        semanticStatus: 'not-submitted', providerAccepted: false, providerTurnCreated: false,
        composerDraftState: 'exact-original', exactDraftRemained: true, draftPreserved: true,
        lateReconciliationPending: false,
      } : { success: false, submitted: false, pasteWritten: false, enterWritten: false,
        promptText: 'frozen', code: 'agent_send_preparation_expired' });
    } else {
      store.reserveOrGet(identity);
      store.settleQueuedNoWrite(identity.operationKey, { promptText: 'frozen', code: 'agent_send_preparation_expired' });
    }
    record = store.get(identity.operationKey);
  }
  const calls = [], removed = [], consumed = [], notices = [], handlers = new Map(), released = [];
  const handoffs = privateHistoryPromptHandoffs();
  const input = { tabId: 'T', handoffId: 'H', toolType: 'codex', text: 'original', sessionIdHint: 'private-SID',
    ...(record ? { sendOperationKey: record.operationKey, sendAttemptId: record.attemptId } : {}),
    historyReturn: { token: 'H', state: 'available' }, authoringText: 'original', authoringImagePaths: [{ path: '/private/image.png' }] };
  const owner = handoffs.beginHistoryPromptHandoff(input);
  assert.ok(owner && Object.isFrozen(owner), 'actual immutable handoff owner');
  handoffs.settleHistoryPromptHandoff('T', 'H', { queueStatus: unknown ? 'delivery-unknown' : 'failed', reason });
  // The stale click row is distinct from the actual immutable store owner.
  const handoff = { ...handoffs.getHistoryPromptHandoffsSnapshot('T')[0], role: 'queued', content: 'original' };
  const metadata = { text: handoff.content, submittedAt: handoff.submittedAt,
    sendOperationKey: handoff.sendOperationKey, sendAttemptId: handoff.sendAttemptId };
  const persisted = [];
  const scope = {
    ...handoffs,
    tabId: 'T', toolType: 'codex', sessionId: 'private-SID', useCallback: fn => fn, returnPromptInflight: { current: new Set() },
    historyOwnerKeyRef: { current: 'private-owner' }, historyOwnerGenerationRef: { current: 1 },
    historySnapshotOwner: { tabId: 'T', sessionId: 'private-SID' },
    promptHandoffMetaRef: { current: new Map([['H', metadata]]) }, suppressedPromptsRef: { current: new Map() },
    historyDiag() {}, setPrimarySuppressionRevision() {},
    persistVolatileOverlay: (_owner, rows) => persisted.push(rows),
    historySendReturnEnabled, historySendPresentationAction, planHistoryPromptPresentationDismissal,
    showHistoryIncidentToast: (...args) => notices.push(args),
    agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptStore: store,
    DESKTOP_HISTORY_SEND_SURFACE: 'desktop-history', path: require('node:path'), srcMainDir: '/private/source',
    console: { warn() {}, log() {} },
    require: () => ({ releaseQueuedSendPresentation: key => released.push(key) }),
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    ipcRenderer: { invoke: async (name, input) => { calls.push({ name, input }); assert.ok(handlers.has(name), name);
      return handlers.get(name)({}, input); } },
    // Any return/restore/Stop/Send path is deliberately absent: actual callback
    // must not touch it, even when a failed card has a valid return token.
  };
  const context = vm.createContext(scope);
  const presentation = installHistoryPromptPanelRows(context, panel, {
    initialRows: [{ uuid: 'local-prompt-T-H', role: 'queued', ...handoff }],
  });
  t.after(presentation.close);
  const remove = context.removeLocalPromptEntry, consume = context.consumeLocalPromptEntry;
  context.removeLocalPromptEntry = (...args) => { removed.push(args); return remove(...args); };
  context.consumeLocalPromptEntry = (...args) => { consumed.push(args); return consume(...args); };
  const start = main.indexOf("ipcMain.handle('agent:dismiss-send-receipt-presentation'");
  const end = main.indexOf("ipcMain.handle('agent:record-history-context'", start);
  vm.runInContext(main.slice(start, end), context);
  vm.runInContext(compile('const ' + callback + '; globalThis.dismiss = dismissPromptPresentation;'), context);
  return { db, store, identity, record, handoffs, handoff, calls, removed, consumed, notices, released, persisted,
    rows: presentation.rows, sparseOwner: presentation.owner,
    current: () => handoffs.getHistoryPromptHandoffsSnapshot('T'),
    advancePending() {
      const next = handoffs.beginHistoryPromptHandoff({ ...input, sendAttemptId: 'new-pending-attempt', initialStatus: 'application-queued' });
      assert.equal(next.queueStatus, 'application-queued');
      return next;
    },
    bindIdentity(fields) { assert.equal(handoffs.bindHistoryPromptHandoffSendIdentity('T', 'H', fields).ok, true); },
    replaceLocalIdentity(fields) {
      assert.equal(handoffs.consumeHistoryPromptHandoffIfCurrent('T', 'H', handoffs.getHistoryPromptHandoffsSnapshot('T')[0]), true);
      const next = handoffs.beginHistoryPromptHandoff({ ...input, ...fields,
        initialReceipt: { queueStatus: unknown ? 'delivery-unknown' : 'failed', reason } });
      assert.ok(next && Object.isFrozen(next));
      Object.assign(handoff, next);
      return next;
    },
    dismiss: () => context.dismiss({ uuid: 'local-prompt-T-H', ...handoff }), context };
}

function assertRetired(h) {
  assert.equal(h.rows().length, 0);
  assert.equal(h.context.promptHandoffMetaRef.current.has('H'), false);
  assert.equal(h.current().length, 0);
  assert.equal(h.sparseOwner.current().rows.length, 0);
  assert.equal(h.sparseOwner.current().entries.deref(), h.rows());
}

function assertRetained(h) {
  assert.equal(h.rows().length, 1);
  assert.equal(h.context.promptHandoffMetaRef.current.has('H'), true);
  assert.equal(h.current().length, 1);
  assert.equal(h.sparseOwner.current().rows[0], h.rows()[0]);
  assert.equal(h.sparseOwner.current().entries.deref(), h.rows());
}

for (const attempt of [false, true]) test('actual callback → Main → private real SQL only dismisses failed presentation; attempt=' + attempt, async t => {
  const h = harness(t, { attempt });
  await h.dismiss(); await h.dismiss();
  assert.deepEqual(h.notices, []);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(c => c.name === 'agent:dismiss-send-receipt-presentation' && c.input.failedOnly === true));
  const after = h.store.get(h.identity.operationKey);
  assert.equal(after.state, h.record.state); assert.equal(after.attemptId, h.record.attemptId);
  assert.equal(after.settledAt, h.record.settledAt);
  assert.deepEqual({ ...after.receipt, presentationDismissedAt: undefined, presentationDismissedSurface: undefined },
    { ...h.record.receipt, presentationDismissedAt: undefined, presentationDismissedSurface: undefined });
  assert.ok(after.receipt.presentationDismissedAt);
  const hydration = h.handoffs.hydrateHistoryPromptHandoffFromDurableReceipt({ ...after,
    applicationQueue: { version: 1, state: 'failed' } });
  assert.equal(hydration.hydrated, false); assert.equal(hydration.reason, 'durable-history-presentation-dismissed');
  assert.equal(h.removed.length, 2); assert.equal(h.consumed.length, 2);
  assertRetired(h);
});

test('an exact provider refusal dismisses presentation without clearing its actual terminal draft', async t => {
  const h = harness(t, { providerRefusal: true });
  assert.equal(h.record.state, 'provider-not-accepted');
  await h.dismiss();
  assert.deepEqual(h.notices, []); assert.equal(h.removed.length, 1);
  const after = h.store.get(h.identity.operationKey);
  assert.equal(after.state, 'provider-not-accepted'); assert.equal(after.receipt.enterWritten, true);
  assert.equal(after.receipt.draftPreserved, true);
  assertRetired(h);
});

test('lost dismiss ACK retains the card; a later explicit click joins the same durable dismissal', async t => {
  const h = harness(t), invoke = h.context.ipcRenderer.invoke;
  let lose = true;
  h.context.ipcRenderer.invoke = async (...args) => { const result = await invoke(...args);
    if (lose) { lose = false; throw Error('controlled ACK loss'); } return result; };
  await h.dismiss();
  assert.equal(h.removed.length, 0); assert.equal(h.consumed.length, 0); assert.equal(h.calls.length, 1);
  assert.ok(h.store.get(h.identity.operationKey).receipt.presentationDismissedAt);
  assertRetained(h);
  await h.dismiss();
  assert.equal(h.removed.length, 1); assert.equal(h.consumed.length, 1); assert.equal(h.calls.length, 2);
  assertRetired(h);
});

test('proved receiptless failure removes only the local presentation', async t => {
  const h = harness(t, { durable: false }); await h.dismiss();
  assert.deepEqual(h.calls, []); assert.equal(h.removed.length, 1); assert.equal(h.consumed.length, 1);
  assertRetired(h);
});

test('unknown receipt failure retains card and data rather than pretending dismissal succeeded', async t => {
  const h = harness(t, { durable: false, reason: 'send-refused-before-submit' }); await h.dismiss();
  assert.equal(h.calls.length, 1); assert.equal(h.notices.length, 1);
  assert.deepEqual(h.removed, []); assert.deepEqual(h.consumed, []);
  assertRetained(h);
});

test('Main rejects a stale failed card after a new attempt, without dismiss/release', async t => {
  const h = harness(t); h.store.beginAttempt(h.identity);
  await h.dismiss();
  assert.equal(h.notices.length, 1); assert.deepEqual(h.removed, []); assert.deepEqual(h.released, []);
  assert.equal(h.store.get(h.identity.operationKey).receipt?.presentationDismissedAt, undefined);
  assertRetained(h);
});

test('a locally advanced pending handoff cannot be hidden by its stale failed row', async t => {
  const h = harness(t); const entry = { uuid: 'local-prompt-H', ...h.handoff };
  h.advancePending();
  await h.context.dismiss(entry);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.removed, []); assert.deepEqual(h.consumed, []);
  assertRetained(h);
  assert.equal(h.current()[0].queueStatus, 'application-queued');
});

test('actual unknown X only hides its exact durable presentation, retaining delivery and slot authority', async t => {
  const h = harness(t, { unknown: true });
  await h.dismiss();
  assert.equal(h.calls.length, 1, 'the unknown footer must reach the existing presentation owner');
  assert.equal(h.calls[0].name, 'agent:dismiss-send-receipt-presentation');
  assert.equal(h.calls[0].input.unknownOnly, true);
  assert.deepEqual(h.notices, []);
  const after = h.store.get(h.identity.operationKey);
  assert.equal(after.state, 'delivery-unknown');
  assert.equal(after.attemptId, h.record.attemptId);
  assert.equal(after.settledAt, h.record.settledAt);
  assert.equal(after.receipt.submitted, null);
  assert.equal(after.receipt.enterWritten, null);
  assert.deepEqual(after.deliveryControl, h.record.deliveryControl);
  assert.deepEqual(after.inputSlot, h.record.inputSlot);
  assert.ok(after.receipt.presentationDismissedAt);
  assert.equal(h.removed.length, 1);
  assert.equal(h.consumed.length, 1);
  const reopened = createAgentSendReceiptStore(h.db).get(h.identity.operationKey);
  assert.equal(reopened.state, 'delivery-unknown');
  assert.equal(h.handoffs.hydrateHistoryPromptHandoffFromDurableReceipt(reopened).reason, 'durable-history-presentation-dismissed');
  assertRetired(h);
});

test('unknown X refuses a stale attempt rather than hiding the newer owner', async t => {
  const h = harness(t, { unknown: true });
  h.replaceLocalIdentity({ sendAttemptId: 'stale-attempt' });
  await h.dismiss();
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.released, []);
  assert.equal(h.store.get(h.identity.operationKey).receipt?.presentationDismissedAt, undefined);
  assertRetained(h);
});

const storageFor = t => {
  const previous = globalThis.localStorage, data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  globalThis.localStorage = storage;
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  return storage;
};

test('receiptless unknown X preserves its recovery snapshot, and reload/late hydration cannot reintroduce the card', async t => {
  const storage = storageFor(t), h = harness(t, { unknown: true, durable: false });
  const frozen = { tabId: 'T', handoffId: 'H', toolType: 'codex', text: 'original',
    authoringText: 'raw [Image #1]', imagePaths: [{ path: '/private/image.png', assetId: 'original' }],
    authoringChips: [{ id: 'source', kind: 'prompt', text: 'original chip' }] };
  saveHistorySendRecovery(frozen, 'dispatched', storage);
  await h.dismiss();
  assert.equal(h.calls.length, 1);
  assert.equal(h.removed.length, 1);
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.consumed, [], 'ordinary consume would discard the only recovery copy');
  const saved = readHistorySendRecovery(storage)[0];
  assert.deepEqual(saved.input, frozen);
  assert.equal(saved.phase, 'dispatched');
  assert.ok(saved.presentationDismissedAt);
  const reloaded = privateHistoryPromptHandoffs();
  assert.equal(reloaded.getHistoryPromptHandoffsSnapshot('T').length, 0);
  const late = { ...h.identity, attemptId: 'late-owned-attempt', state: 'delivery-unknown', receipt: { promptText: 'original' },
    historyReturn: { token: 'H', state: 'writing' } };
  assert.equal(reloaded.hydrateHistoryPromptHandoffFromDurableReceipt(late).reason, 'local-history-presentation-dismissed');
  assert.deepEqual(readHistorySendRecovery(storage)[0].input.imagePaths, frozen.imagePaths);
  assert.equal(reloaded.hydrateHistoryPromptHandoffFromDurableReceipt({ ...late,
    historyReturn: { token: 'different-return-owner', state: 'writing' } }).hydrated, true,
  'receiptless presentation marker must not hide an unrelated/newly proven owner');
  assert.equal(h.rows().length, 0);
  assert.equal(h.context.promptHandoffMetaRef.current.has('H'), false);
});

test('receiptless hide requires a successful Main absence read, not a lost IPC or ambiguous receipt', async t => {
  storageFor(t);
  for (const refusal of ['transport', 'receipt-ambiguous']) {
    const h = harness(t, { unknown: true, durable: false });
    h.context.ipcRenderer.invoke = async () => { if (refusal === 'transport') throw Error('controlled IPC failure');
      return { success: false, dismissed: false, reason: refusal, receiptAbsent: false }; };
    await h.dismiss();
    assert.equal(h.notices.length, 1);
    assert.deepEqual(h.removed, []);
    assert.deepEqual(readHistorySendRecovery(), []);
    assertRetained(h);
  }
});

test('failed recovery persistence keeps the receiptless unknown card and original bytes', async t => {
  const storage = storageFor(t), h = harness(t, { unknown: true, durable: false });
  saveHistorySendRecovery({ tabId: 'T', handoffId: 'H', text: 'original' }, 'dispatched', storage);
  storage.setItem = () => { throw Error('controlled quota'); };
  await h.dismiss();
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.removed, []);
  assert.equal(readHistorySendRecovery(storage)[0].input.text, 'original');
  assert.equal(readHistorySendRecovery(storage)[0].presentationDismissedAt, undefined);
  assertRetained(h);
});

test('actual Main X keeps unknown FIFO barrier/assets; only late exact audit releases the original follower', async t => {
  const db = new DirectorySqlite(), store = createAgentSendReceiptStore(db), sends = [], handlers = new Map();
  const identity = request => ({ operationKey: request.sendOperationKey, tabId: request.tabId, handoffId: request.handoffId,
    provider: 'codex', surface: 'desktop-history', sessionId: 'S', requestFingerprint: fingerprintAgentSendRequest(request),
    promptHash: fingerprintAgentSendRequest(request.prompt), promptLength: request.prompt.length });
  const queue = new AgentSendQueue({ store, execute: async request => {
    sends.push(request.handoffId);
    const started = store.beginAttempt(identity(request));
    store.markAttemptState(request.sendOperationKey, started.attemptId, 'enter-armed');
    store.settleAttempt(request.sendOperationKey, started.attemptId,
      { submitted: true, success: null, status: 'delivery-unknown', deliveryUnknown: true });
    return store.get(request.sendOperationKey).receipt;
  } });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  t.after(async () => { queue.dispose(); await tick(); db.close(); });
  const add = handoffId => {
    const request = { tabId: 'T', handoffId, provider: 'codex', sendOperationKey: 'history:T:' + handoffId,
      source: 'history-panel', prompt: 'same text',
      authoringSnapshot: { editorText: 'same text', imagePaths: [{ assetId: 'asset-' + handoffId, path: '/private/' + handoffId + '.png' }] } };
    assert.equal(queue.enqueue({ identity: identity(request), request }).ok, true);
  };
  add('unknown-head'); add('original-follower'); await tick();
  assert.deepEqual(sends, ['unknown-head']);
  const before = store.get('history:T:unknown-head'), followerBefore = queue.item('history:T:original-follower');
  const context = vm.createContext({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptStore: store, DESKTOP_HISTORY_SEND_SURFACE: 'desktop-history',
    path, srcMainDir: '/source', console: { warn() {} }, require: () => ({ releaseQueuedSendPresentation: key => queue.releasePresentation(key) }) });
  const start = main.indexOf("ipcMain.handle('agent:dismiss-send-receipt-presentation'");
  vm.runInContext(main.slice(start, main.indexOf("ipcMain.handle('agent:record-history-context'", start)), context);
  const hide = () => handlers.get('agent:dismiss-send-receipt-presentation')({}, { tabId: 'T', handoffId: 'unknown-head',
    operationKey: before.operationKey, attemptId: before.attemptId, unknownOnly: true });
  assert.equal((await hide()).dismissed, true);
  assert.equal((await hide()).idempotent, true);
  await tick(); queue.wake('T'); await tick();
  assert.deepEqual(sends, ['unknown-head'], 'hiding is not cancel, release, replay, or follower admission');
  assert.deepEqual(queue.item('history:T:original-follower'), followerBefore);
  assert.equal(queue.referencedAssetIds().has('asset-unknown-head'), true);
  const hidden = store.get(before.operationKey);
  assert.equal(hidden.state, before.state);
  assert.deepEqual(hidden.deliveryControl, before.deliveryControl);
  assert.equal(hidden.receipt.submitted, true);
  const promoted = store.promoteFromAudit({ success: true, operationKey: before.operationKey, attemptId: before.attemptId,
    provider: 'codex', sessionId: 'S', promptHash: before.promptHash, actualHash: before.promptHash, expectedHash: before.promptHash,
    entryUuid: 'exact-user', sourceIdentity: 'codex-user-source-owned', auditTimestamp: new Date().toISOString(),
    transcriptBoundary: { byteOffset: 100 } });
  assert.equal(promoted.promoted, true);
  await tick();
  assert.deepEqual(sends, ['unknown-head', 'original-follower']);
  assert.equal(store.get(before.operationKey).state, 'confirmed');
  assert.equal(store.get(before.operationKey).receipt.presentationDismissedAt, hidden.receipt.presentationDismissedAt);
  assert.equal((await hide()).idempotent, true, 'a lost ACK may be recovered after the same attempt is confirmed');
});

test('unknown X rejects a foreign operation even with the matching tab/handoff/attempt', async t => {
  const h = harness(t, { unknown: true }); h.replaceLocalIdentity({ sendOperationKey: 'foreign-operation' });
  await h.dismiss();
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.released, []);
  assert.equal(h.store.get(h.identity.operationKey).receipt.presentationDismissedAt, undefined);
  assertRetained(h);
});

test('newly bound identity during an absence read keeps the unknown card, without a local hide marker', async t => {
  storageFor(t);
  const h = harness(t, { unknown: true, durable: false });
  let ready; h.context.agentSendReceiptStartupReady = new Promise(resolve => { ready = resolve; });
  const waiting = h.dismiss();
  await Promise.resolve();
  h.bindIdentity({ sendOperationKey: 'late-operation', sendAttemptId: 'late-attempt' });
  ready(); await waiting;
  assert.deepEqual(h.removed, []);
  assert.deepEqual(readHistorySendRecovery(), []);
  assertRetained(h);
});

test('actual local-row removal preserves canonical equal-text and other handoffs', t => {
  assert.ok(removeCallback);
  const rows = [{ uuid: 'local-prompt-H', role: 'queued', handoffId: 'H', content: 'same text' },
    { uuid: 'canonical-user', role: 'user', handoffId: 'H', content: 'same text' },
    { uuid: 'local-prompt-other', role: 'queued', handoffId: 'other', content: 'same text' }];
  const handoffs = privateHistoryPromptHandoffs();
  const owner = handoffs.beginHistoryPromptHandoff({ tabId: 'T', handoffId: 'H', toolType: 'codex', text: 'same text' });
  const metadata = { text: 'same text' };
  const context = vm.createContext({ ...handoffs, tabId: 'T', historySnapshotOwner: 'owner', useCallback: fn => fn,
    historyOwnerKeyRef: { current: 'owner' }, historyOwnerGenerationRef: { current: 1 },
    promptHandoffMetaRef: { current: new Map([['H', metadata]]) }, suppressedPromptsRef: { current: new Map() },
    persistVolatileOverlay() {}, historyDiag() {}, setPrimarySuppressionRevision() {} });
  const presentation = installHistoryPromptPanelRows(context, panel, { initialRows: rows });
  t.after(presentation.close);
  const removal = context.captureLocalPromptRemoval('H', owner);
  assert.ok(removal);
  context.removeLocalPromptEntry('H', 'unknown-presentation-dismissed', removal);
  assert.deepEqual(presentation.rows().map(row => row.uuid), ['canonical-user', 'local-prompt-other']);
  assert.equal(context.promptHandoffMetaRef.current.has('H'), false);
  assert.equal(presentation.owner.current().entries.deref(), presentation.rows());
  assert.deepEqual(presentation.owner.current().rows.map(row => row.handoffId), ['other']);
  assert.equal(handoffs.getHistoryPromptHandoffsSnapshot('T')[0], owner, 'row removal is not handoff consumption');
});
