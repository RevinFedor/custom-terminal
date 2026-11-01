'use strict';
// Decision 01.11 (Fedor, Q3): the X on an UNCONFIRMED Send card always hides it,
// including while Main still owns an in-flight attempt. Incident 2026-10-31
// run-after-pq-mvwjv179: the scenario IPC had already answered delivery-unknown
// at its deadline, the receipt stayed `in-flight`, and every X click was refused
// as `unknown-presentation-changed`.
//
// Actual Main dismiss handler (from main.js) -> actual receipt store -> actual
// application FIFO -> private SQLite. No PTY/provider, no user tab.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const ts = require('typescript'), Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { hiddenSendPresentation } = require('../shared/agent-send-receipt-control.cjs');

const mainFile = process.env.DISMISS_MAIN_SOURCE || path.join(__dirname, 'main.js');
const main = fs.readFileSync(mainFile, 'utf8');
const mainAst = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const handlerNode = mainAst.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
  && n.expression.expression.getText(mainAst) === 'ipcMain.handle'
  && n.expression.arguments[0]?.text === 'agent:dismiss-send-receipt-presentation');
assert.ok(handlerNode, 'dismiss handler found in main.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
const quiet = { log() {}, warn() {}, error() {} };

async function fixture(t, { settle = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-inflight-dismiss-'));
  const db = new Database(path.join(root, 'private.sqlite'));
  const store = createAgentSendReceiptStore(db);
  const effects = { sends: 0, cancellations: 0, releaseCalls: 0 };
  const queue = new AgentSendQueue({ store, ready: () => false,
    execute: async () => { effects.sends++; assert.fail('physical Send forbidden'); },
    cancelAttempt: () => { effects.cancellations++; }, readInputSlot: async () => null });
  t.after(async () => { queue.dispose(); await tick(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const identity = { operationKey: 'history:T:H', tabId: 'T', handoffId: 'H', provider: 'claude',
    surface: 'desktop-history', sessionId: 'synthetic-session', requestFingerprint: 'immutable-request',
    promptHash: 'immutable-hash', promptLength: 31 };
  const images = [{ id: 1, path: '/synthetic/a.png', assetId: 'asset-a' }];
  const request = { tabId: 'T', handoffId: 'H', provider: 'claude', source: 'prompt-queue',
    prompt: 'synthetic run-after [Image #1]',
    presentationSnapshot: { version: 3, imagePaths: images, promptChips: [] },
    authoringSnapshot: { editorText: '[Image #1]', imagePaths: images, chips: [] } };
  assert.equal(queue.enqueue({ identity, request }).ok, true);
  db.prepare("UPDATE agent_send_queue SET state='awaiting-receipt' WHERE operation_key=?").run(identity.operationKey);
  const begun = store.beginAttempt(identity); assert.ok(begun.attemptId);
  if (settle) settle(store, identity, begun);
  await tick();
  const before = store.get(identity.operationKey), queueBefore = queue.item(identity.operationKey);
  const handlers = new Map();
  const web = { projectQueuedSendReceipt: record => queue.projectRecord(record),
    releaseQueuedSendPresentation: key => { effects.releaseCalls++; queue.releasePresentation(key); } };
  const ctx = vm.createContext({ console: quiet, path, srcMainDir: __dirname,
    agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptStore: store,
    DESKTOP_HISTORY_SEND_SURFACE: 'desktop-history',
    require: id => id === path.join(__dirname, 'web-server') ? web : require(id),
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) } });
  vm.runInContext(handlerNode.getText(mainAst), ctx);
  const dismiss = patch => handlers.get('agent:dismiss-send-receipt-presentation')({}, {
    tabId: 'T', handoffId: 'H', operationKey: identity.operationKey, attemptId: begun.attemptId,
    unknownOnly: true, ...patch });
  const audit = () => ({ success: true, ...identity, attemptId: begun.attemptId,
    expectedHash: identity.promptHash, entryUuid: 'canonical-user', sourceIdentity: 'synthetic-source-42',
    auditTimestamp: '2026-11-01T04:00:00.000Z', transcriptBoundary: { byteOffset: 42, line: 2 } });
  return { store, queue, db, identity, begun, before, queueBefore, effects, dismiss, audit };
}

test('X on an in-flight attempt hides the card; delivery, FIFO slot and assets are untouched', async t => {
  const h = await fixture(t);
  assert.equal(h.before.state, 'in-flight');
  const result = await h.dismiss();
  assert.equal(result.success, true, 'pre-fix this was unknown-presentation-changed');
  assert.equal(result.dismissed, true);
  const now = h.store.get(h.identity.operationKey);
  assert.equal(hiddenSendPresentation(now), true, 'History hydration will skip the card');
  for (const key of ['operationKey', 'attemptId', 'state', 'promptHash', 'requestFingerprint', 'deliveryControl'])
    assert.equal(JSON.stringify(now[key]), JSON.stringify(h.before[key]), key);
  const { presentationDismissedAt, presentationDismissedSurface, ...receipt } = now.receipt;
  // An in-flight attempt has no receipt yet; hiding adds only the mark.
  assert.deepEqual(receipt, h.before.receipt || {}, 'only the presentation mark is added');
  assert.equal(presentationDismissedSurface, 'desktop-history'); assert.ok(presentationDismissedAt > 0);
  for (const key of ['state', 'request_hash', 'request_json', 'slot_release_json', 'release_json', 'asset_ids_json'])
    assert.equal(h.queue.item(h.identity.operationKey)[key], h.queueBefore[key], 'queue ' + key);
  assert.deepEqual([...h.queue.referencedAssetIds()], ['asset-a'], 'attachment bytes stay owned');
  assert.equal(h.effects.sends, 0); assert.equal(h.effects.cancellations, 0, 'X is not a cancellation');
});

test('a late outcome still settles the same hidden attempt and the mark survives', async t => {
  const h = await fixture(t);
  assert.equal((await h.dismiss()).success, true);
  const settled = h.store.settleAttempt(h.identity.operationKey, h.begun.attemptId, { submitted: true,
    auditPending: true, promptText: 'synthetic run-after [Image #1]', status: 'audit-pending',
    code: 'agent_send_enter_written_audit_pending' });
  assert.equal(settled.ok, true);
  assert.equal(h.store.promoteFromAudit(h.audit()).promoted, true);
  const now = h.store.get(h.identity.operationKey);
  assert.equal(now.state, 'confirmed'); assert.equal(now.attemptId, h.begun.attemptId);
  assert.equal(hiddenSendPresentation(now), true, 'hidden card does not come back after settlement');
  assert.equal(h.effects.sends, 0);
});

test('repeated X is idempotent; a stale or foreign X is still refused', async t => {
  const h = await fixture(t);
  assert.equal((await h.dismiss({ attemptId: 'foreign' })).success, false);
  assert.equal((await h.dismiss({ operationKey: 'foreign' })).success, false);
  assert.equal(h.store.get(h.identity.operationKey).receipt?.presentationDismissedAt, undefined);
  assert.equal((await h.dismiss()).success, true);
  const again = await h.dismiss(); assert.equal(again.success, true); assert.equal(again.idempotent, true);
});

test('a live CONFIRMING (audit-pending) card without cancel/retire proof keeps its old refusal', async t => {
  const h = await fixture(t, { settle: (store, identity, begun) => store.settleAttempt(identity.operationKey,
    begun.attemptId, { submitted: true, auditPending: true, promptText: 'synthetic run-after [Image #1]',
      status: 'audit-pending', code: 'agent_send_enter_written_audit_pending' }) });
  assert.equal(h.before.state, 'audit-pending');
  const result = await h.dismiss();
  assert.equal(result.success, false); assert.equal(result.reason, 'unknown-presentation-changed');
});

test('a failed-card X still applies only to failed states', async t => {
  const h = await fixture(t);
  const result = await h.dismiss({ unknownOnly: undefined, failedOnly: true });
  assert.equal(result.success, false); assert.equal(result.reason, 'failed-presentation-changed');
});
