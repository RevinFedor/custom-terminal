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
import { hydrateHistoryPromptHandoffFromDurableReceipt, dismissReceiptlessHistoryPromptPresentation,
  HistoryPromptHandoffStore } from './historyPromptHandoffs.ts';
import { readHistorySendRecovery, saveHistorySendRecovery } from './historySendRecovery.mjs';

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
  const handoff = { tabId: 'T', handoffId: 'H', queueStatus: unknown ? 'delivery-unknown' : 'failed', statusReason: reason,
    ...(record ? { sendOperationKey: record.operationKey, sendAttemptId: record.attemptId } : {}),
    historyReturn: { token: 'H', state: 'available' }, authoringText: 'original', authoringImagePaths: [{ path: '/private/image.png' }] };
  const current = [handoff];
  const scope = {
    tabId: 'T', toolType: 'codex', useCallback: fn => fn, returnPromptInflight: { current: new Set() },
    getHistoryPromptHandoffsSnapshot: () => current, isLocalPromptEntry: e => e.uuid?.startsWith('local-prompt-'),
    historySendReturnEnabled, historySendPresentationAction, planHistoryPromptPresentationDismissal, dismissReceiptlessHistoryPromptPresentation,
    consumeHistoryPromptHandoff: (...args) => consumed.push(args), removeLocalPromptEntry: (...args) => removed.push(args),
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
  const start = main.indexOf("ipcMain.handle('agent:dismiss-send-receipt-presentation'");
  const end = main.indexOf("ipcMain.handle('agent:record-history-context'", start);
  vm.runInContext(main.slice(start, end), context);
  vm.runInContext(compile('const ' + callback + '; globalThis.dismiss = dismissPromptPresentation;'), context);
  return { db, store, identity, record, current, handoff, calls, removed, consumed, notices, released,
    dismiss: () => context.dismiss({ uuid: 'local-prompt-T-H', ...handoff }), context };
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
  const hydration = hydrateHistoryPromptHandoffFromDurableReceipt({ ...after,
    applicationQueue: { version: 1, state: 'failed' } });
  assert.equal(hydration.hydrated, false); assert.equal(hydration.reason, 'durable-history-presentation-dismissed');
  assert.equal(h.removed.length, 2); assert.equal(h.consumed.length, 2);
});

test('an exact provider refusal dismisses presentation without clearing its actual terminal draft', async t => {
  const h = harness(t, { providerRefusal: true });
  assert.equal(h.record.state, 'provider-not-accepted');
  await h.dismiss();
  assert.deepEqual(h.notices, []); assert.equal(h.removed.length, 1);
  const after = h.store.get(h.identity.operationKey);
  assert.equal(after.state, 'provider-not-accepted'); assert.equal(after.receipt.enterWritten, true);
  assert.equal(after.receipt.draftPreserved, true);
});

test('lost dismiss ACK retains the card; a later explicit click joins the same durable dismissal', async t => {
  const h = harness(t), invoke = h.context.ipcRenderer.invoke;
  let lose = true;
  h.context.ipcRenderer.invoke = async (...args) => { const result = await invoke(...args);
    if (lose) { lose = false; throw Error('controlled ACK loss'); } return result; };
  await h.dismiss();
  assert.equal(h.removed.length, 0); assert.equal(h.consumed.length, 0); assert.equal(h.calls.length, 1);
  assert.ok(h.store.get(h.identity.operationKey).receipt.presentationDismissedAt);
  await h.dismiss();
  assert.equal(h.removed.length, 1); assert.equal(h.consumed.length, 1); assert.equal(h.calls.length, 2);
});

test('proved receiptless failure removes only the local presentation', async t => {
  const h = harness(t, { durable: false }); await h.dismiss();
  assert.deepEqual(h.calls, []); assert.equal(h.removed.length, 1); assert.equal(h.consumed.length, 1);
});

test('unknown receipt failure retains card and data rather than pretending dismissal succeeded', async t => {
  const h = harness(t, { durable: false, reason: 'send-refused-before-submit' }); await h.dismiss();
  assert.equal(h.calls.length, 1); assert.equal(h.notices.length, 1);
  assert.deepEqual(h.removed, []); assert.deepEqual(h.consumed, []);
});

test('Main rejects a stale failed card after a new attempt, without dismiss/release', async t => {
  const h = harness(t); h.store.beginAttempt(h.identity);
  await h.dismiss();
  assert.equal(h.notices.length, 1); assert.deepEqual(h.removed, []); assert.deepEqual(h.released, []);
  assert.equal(h.store.get(h.identity.operationKey).receipt?.presentationDismissedAt, undefined);
});

test('a locally advanced pending handoff cannot be hidden by its stale failed row', async t => {
  const h = harness(t); const entry = { uuid: 'local-prompt-H', ...h.handoff };
  h.current[0] = { ...h.handoff, queueStatus: 'application-queued' };
  await h.context.dismiss(entry);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.removed, []); assert.deepEqual(h.consumed, []);
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
  assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt(reopened).reason, 'durable-history-presentation-dismissed');
});

test('unknown X refuses a stale attempt rather than hiding the newer owner', async t => {
  const h = harness(t, { unknown: true });
  h.handoff.sendAttemptId = 'stale-attempt';
  await h.dismiss();
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.released, []);
  assert.equal(h.store.get(h.identity.operationKey).receipt?.presentationDismissedAt, undefined);
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
  const handoffs = fs.readFileSync(new URL('./historyPromptHandoffs.ts', import.meta.url), 'utf8');
  const start = handoffs.indexOf('try {\n  for (const { input, phase, presentationDismissedAt, presentationDismissedReturnToken }');
  const end = handoffs.indexOf('export const hydrateHistoryPromptHandoffImages', start);
  assert.ok(start > 0 && end > start);
  const reloaded = new HistoryPromptHandoffStore();
  vm.runInNewContext(compile(handoffs.slice(start, end)), { historyPromptHandoffStore: reloaded,
    receiptlessPresentationDismissals: new Map(), readHistorySendRecovery: () => readHistorySendRecovery(storage), console });
  assert.equal(reloaded.getSnapshot('T').length, 0);
  const late = { ...h.identity, attemptId: 'late-owned-attempt', state: 'delivery-unknown', receipt: { promptText: 'original' },
    historyReturn: { token: 'H', state: 'writing' } };
  assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt(late).reason, 'local-history-presentation-dismissed');
  assert.deepEqual(readHistorySendRecovery(storage)[0].input.imagePaths, frozen.imagePaths);
  assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt({ ...late,
    historyReturn: { token: 'different-return-owner', state: 'writing' } }).hydrated, true,
  'receiptless presentation marker must not hide an unrelated/newly proven owner');
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
  const h = harness(t, { unknown: true }); h.handoff.sendOperationKey = 'foreign-operation';
  await h.dismiss();
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.released, []);
  assert.equal(h.store.get(h.identity.operationKey).receipt.presentationDismissedAt, undefined);
});

test('newly bound identity during an absence read keeps the unknown card, without a local hide marker', async t => {
  storageFor(t);
  const h = harness(t, { unknown: true, durable: false });
  let ready; h.context.agentSendReceiptStartupReady = new Promise(resolve => { ready = resolve; });
  const waiting = h.dismiss();
  await Promise.resolve();
  h.current[0] = { ...h.handoff, sendOperationKey: 'late-operation', sendAttemptId: 'late-attempt' };
  ready(); await waiting;
  assert.deepEqual(h.removed, []);
  assert.deepEqual(readHistorySendRecovery(), []);
});

test('actual local-row removal preserves canonical equal-text and other handoffs', () => {
  assert.ok(removeCallback);
  let rows = [{ uuid: 'local-prompt-H', role: 'queued', handoffId: 'H', content: 'same text' },
    { uuid: 'canonical-user', role: 'user', handoffId: 'H', content: 'same text' },
    { uuid: 'local-prompt-other', role: 'queued', handoffId: 'other', content: 'same text' }];
  const context = vm.createContext({ tabId: 'T', historySnapshotOwner: 'owner', useCallback: fn => fn,
    promptHandoffMetaRef: { current: new Map() }, suppressedPromptsRef: { current: new Map() },
    presentationEntriesRef: { current: rows }, persistVolatileOverlay() {}, historyDiag() {},
    isLocalPromptEntry: row => row.role === 'queued' && row.uuid.startsWith('local-prompt-'),
    setEntries: update => { rows = update(rows); } });
  vm.runInContext(compile('const ' + removeCallback + '; globalThis.remove = removeLocalPromptEntry;'), context);
  context.remove('H', 'unknown-presentation-dismissed');
  assert.deepEqual(rows.map(row => row.uuid), ['canonical-user', 'local-prompt-other']);
});
