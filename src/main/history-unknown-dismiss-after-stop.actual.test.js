'use strict';
// Actual receipt/FIFO -> actual History hydrate/X callback -> actual Main
// dismiss handler -> private SQLite. No PTY/provider or user-tab mutation.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const ts = require('typescript'), Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const mainFile = process.env.DISMISS_MAIN_SOURCE || path.join(__dirname, 'main.js');
const main = fs.readFileSync(mainFile, 'utf8');
const panel = fs.readFileSync(path.join(__dirname, '../renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
const handoffsPath = path.join(__dirname, '../renderer/utils/historyPromptHandoffs.ts');
const handoffs = fs.readFileSync(handoffsPath, 'utf8');
const mainAst = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const handlerNode = mainAst.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
  && n.expression.expression.getText(mainAst) === 'ipcMain.handle'
  && n.expression.arguments[0]?.text === 'agent:dismiss-send-receipt-presentation');
assert.ok(handlerNode);
const panelAst = ts.createSourceFile('panel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(n) {
  if (ts.isVariableDeclaration(n) && ['isLocalPromptEntry', 'removeLocalPromptEntry', 'dismissPromptPresentation'].includes(n.name.getText(panelAst)))
    declarations.set(n.name.getText(panelAst), 'const ' + n.getText(panelAst) + ';');
  ts.forEachChild(n, visit);
}
visit(panelAst); assert.equal(declarations.size, 3);
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const modules = new Map(); let dismissal, actions;
test.before(async () => {
  for (const m of handoffs.matchAll(/from\s+['"]([^'"]+\.mjs)['"]/g)) modules.set(m[1],
    await import(pathToFileURL(path.resolve(path.dirname(handoffsPath), m[1])).href));
  dismissal = await import('../renderer/utils/historyPromptPresentationDismissal.mjs');
  actions = await import('../renderer/utils/historySendReturn.mjs');
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const quiet = { log() {}, warn() {}, error() {} };
function hydrateModule() {
  const exports = {};
  vm.runInNewContext(compile(handoffs), { exports, console: quiet, setTimeout, clearTimeout,
    require: id => modules.get(id) || require(path.resolve(path.dirname(handoffsPath), id)) });
  return exports;
}

async function fixture(t, { state = 'audit-pending', control = 'stop', provider = 'codex', surface = 'desktop-history' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-unknown-dismiss-'));
  const filename = path.join(root, 'private.sqlite');
  let db = new Database(filename), store = createAgentSendReceiptStore(db), queue;
  const effects = { sends: 0, cancellations: 0, releaseCalls: 0 }, calls = [], errors = [];
  const physical = control === 'absent' ? { version: 1, kind: 'main-input-slot', tabId: 'T', known: true,
    ownerStable: true, processStatus: 'absent', isCurrent: () => true } : null;
  const openQueue = () => new AgentSendQueue({ store, ready: () => false,
    execute: async () => { effects.sends++; assert.fail('physical Send forbidden'); },
    cancelAttempt: () => { effects.cancellations++; }, readInputSlot: async () => physical });
  queue = openQueue();
  t.after(async () => { queue.dispose(); await tick(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const identity = { operationKey: 'history:T:H', tabId: 'T', handoffId: 'H', provider, surface,
    sessionId: 'synthetic-session', requestFingerprint: 'immutable-request', promptHash: 'immutable-hash', promptLength: 41 };
  const images = [{ id: 1, path: '/synthetic/a.png', assetId: 'asset-a' },
    { id: 2, path: '/synthetic/b.png', assetId: 'asset-b' }];
  const request = { tabId: 'T', handoffId: 'H', provider, source: 'history-panel', prompt: 'synthetic [Image #1] [Image #2]',
    presentationSnapshot: { version: 3, imagePaths: images, promptChips: [] },
    authoringSnapshot: { editorText: '[Image #1] [Image #2]', imagePaths: images, chips: [] } };
  assert.equal(queue.enqueue({ identity, request }).ok, true);
  db.prepare("UPDATE agent_send_queue SET state='awaiting-receipt' WHERE operation_key=?").run(identity.operationKey);
  const begun = store.beginAttempt(identity); assert.ok(begun.attemptId);
  if (state === 'enter-armed') {
    store.stageAttemptContext(identity.operationKey, begun.attemptId, { promptText: request.prompt, submitted: null });
    store.markAttemptState(identity.operationKey, begun.attemptId, state);
  } else {
    store.settleAttempt(identity.operationKey, begun.attemptId, { submitted: true, auditPending: true,
      promptText: request.prompt, transportText: '/synthetic/staged-a.png /synthetic/staged-b.png',
      status: state, code: 'agent_send_enter_written_audit_pending', presentationSnapshot: request.presentationSnapshot });
    if (state === 'confirmed') store.promoteFromAudit(audit());
  }
  function audit() { return { success: true, ...identity, attemptId: begun.attemptId,
    expectedHash: identity.promptHash, entryUuid: 'canonical-user', sourceIdentity: 'synthetic-source-42',
    auditTimestamp: '2026-10-26T04:00:00.000Z', transcriptBoundary: { byteOffset: 42, line: 2 } }; }
  if (control === 'stop' || control === 'lost-renderer') {
    const result = queue.cancelDelivery('T', 'H', { dismiss: false,
      reason: control === 'stop' ? 'manual-stop' : 'send-renderer-owner-lost' });
    assert.equal(result.cancelled, true);
  }
  if (control === 'stop' || control === 'absent') await queue.retireObsoleteInputSlot('T');
  await tick();
  const before = store.get(identity.operationKey), queueBefore = queue.item(identity.operationKey);
  const initialEffects = { ...effects };
  const hs = hydrateModule();
  const hydrated = hs.hydrateHistoryPromptHandoffFromDurableReceipt(queue.projectRecord(before));
  assert.equal(hydrated.hydrated, true, hydrated.reason);
  let current = hs.getHistoryPromptHandoffsSnapshot('T')[0]; assert.ok(current);
  let rows = [{ uuid: 'local-prompt-H', role: 'queued', handoffId: 'H', content: request.prompt, ...current },
    { uuid: 'canonical-other', role: 'user', content: request.prompt }];
  const handlers = new Map();
  const web = { projectQueuedSendReceipt: record => queue.projectRecord(record),
    applicationQueueInfo: key => queue.queueInfo(key),
    releaseQueuedSendPresentation: key => { effects.releaseCalls++; queue.releasePresentation(key); } };
  const ctx = vm.createContext({ ...hs, ...dismissal, ...actions, useCallback: fn => fn,
    console: quiet, path, srcMainDir: __dirname, tabId: 'T', sessionId: 'synthetic-session', toolType: provider,
    LOCAL_PROMPT_PREFIX: 'local-prompt-', historySnapshotOwner: 'fixture',
    presentationEntriesRef: { current: rows }, promptHandoffMetaRef: { current: new Map() },
    suppressedPromptsRef: { current: new Map() }, returnPromptInflight: { current: new Set() },
    setPrimarySuppressionRevision() {}, persistVolatileOverlay() {}, historyDiag() {},
    setEntries: update => { rows = update(rows); ctx.presentationEntriesRef.current = rows; },
    showHistoryIncidentToast: (_tab, error) => errors.push(error.message),
    agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptStore: store, DESKTOP_HISTORY_SEND_SURFACE: 'desktop-history',
    require: id => id === path.join(__dirname, 'web-server') ? web : require(id),
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    ipcRenderer: { invoke: async (name, input) => { calls.push({ name, input });
      assert.equal(name, 'agent:dismiss-send-receipt-presentation'); return handlers.get(name)({}, input); } },
  });
  vm.runInContext(handlerNode.getText(mainAst), ctx);
  vm.runInContext(compile(['isLocalPromptEntry', 'removeLocalPromptEntry', 'dismissPromptPresentation']
    .map(name => declarations.get(name)).join('\n')) + '\nglobalThis.actualDismiss = dismissPromptPresentation;', ctx);
  return { identity, begun, before, queueBefore, initialEffects, effects, calls, errors, current, web,
    get store() { return store; }, get queue() { return queue; }, rows: () => rows,
    click: () => ctx.actualDismiss(rows.find(row => row.uuid === 'local-prompt-H')),
    rawDismiss: patch => handlers.get('agent:dismiss-send-receipt-presentation')({}, {
      tabId: 'T', handoffId: 'H', operationKey: identity.operationKey, attemptId: begun.attemptId, unknownOnly: true, ...patch }),
    lateAudit: () => store.promoteFromAudit(audit()),
    async reopen() { queue.dispose(); await tick(); db.close(); db = new Database(filename);
      store = createAgentSendReceiptStore(db); queue = openQueue(); ctx.agentSendReceiptStore = store;
      const fresh = hydrateModule(); return { record: store.get(identity.operationKey),
        hydration: fresh.hydrateHistoryPromptHandoffFromDurableReceipt(queue.projectRecord(store.get(identity.operationKey))) }; },
  };
}

function unchangedDelivery(h) {
  const now = h.store.get(h.identity.operationKey);
  for (const key of ['operationKey', 'attemptId', 'state', 'promptHash', 'requestFingerprint', 'settledAt', 'deliveryControl'])
    assert.equal(JSON.stringify(now[key]), JSON.stringify(h.before[key]), key);
  const { presentationDismissedAt, presentationDismissedSurface, ...receipt } = now.receipt;
  assert.deepEqual(receipt, h.before.receipt);
  assert.equal(presentationDismissedSurface, 'desktop-history'); assert.ok(presentationDismissedAt > 0);
  for (const key of ['state', 'request_hash', 'request_json', 'slot_release_json', 'release_json', 'asset_ids_json'])
    assert.equal(h.queue.item(h.identity.operationKey)[key], h.queueBefore[key], key);
  assert.equal(h.effects.sends, 0); assert.equal(h.effects.cancellations, h.initialEffects.cancellations);
  assert.deepEqual([...h.queue.referencedAssetIds()].sort(), ['asset-a', 'asset-b']);
}

for (const provider of ['codex', 'claude']) for (const surface of ['desktop-history', 'project-api']) {
  test(provider + '/' + surface + ': actual Stop -> UNKNOWN card -> actual X -> durable hide; receipt/slot/assets unchanged', async t => {
    const h = await fixture(t, { provider, surface });
    assert.equal(h.before.state, 'audit-pending'); assert.equal(h.current.queueStatus, 'delivery-unknown');
    assert.equal(h.current.sendAttemptId, h.begun.attemptId);
    await h.click(); assert.deepEqual(h.errors, []);
    assert.deepEqual(h.rows().map(row => row.uuid), ['canonical-other']);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].input.unknownOnly, true);
    unchangedDelivery(h);
    const cold = await h.reopen(); assert.equal(cold.hydration.hydrated, false);
    assert.equal(cold.hydration.reason, 'durable-history-presentation-dismissed');
    assert.equal(cold.record.state, 'audit-pending'); assert.equal(cold.record.receipt.submitted, true);
  });
}

for (const control of ['absent', 'lost-renderer']) test('projected UNKNOWN via ' + control + ' hides only presentation without new slot release', async t => {
  const h = await fixture(t, { control });
  assert.equal(h.current.queueStatus, 'delivery-unknown'); await h.click(); assert.deepEqual(h.errors, []);
  unchangedDelivery(h);
});

test('post-Stop entered-unknown arm remains unknown after X, not not-submitted or a retry', async t => {
  const h = await fixture(t, { state: 'enter-armed' });
  assert.equal(h.current.queueStatus, 'delivery-unknown'); await h.click(); assert.deepEqual(h.errors, []);
  unchangedDelivery(h); assert.equal(h.store.get(h.identity.operationKey).state, 'enter-armed');
});

test('lost hide ACK is idempotent; late exact audit still promotes original attempt and canonical row remains', async t => {
  const h = await fixture(t); await h.click(); assert.deepEqual(h.errors, []); unchangedDelivery(h);
  const first = h.store.get(h.identity.operationKey).receipt.presentationDismissedAt;
  const again = await h.rawDismiss(); assert.equal(again.success, true); assert.equal(again.idempotent, true);
  assert.equal(h.store.get(h.identity.operationKey).receipt.presentationDismissedAt, first);
  assert.equal(h.lateAudit().promoted, true);
  assert.equal(h.store.get(h.identity.operationKey).state, 'confirmed');
  assert.equal(h.store.get(h.identity.operationKey).attemptId, h.begun.attemptId);
  assert.equal(h.rows()[0].role, 'user'); assert.equal(h.effects.sends, 0);
});

for (const patch of [{ attemptId: null }, { attemptId: 'foreign' }, { operationKey: 'foreign' }, { handoffId: 'foreign' }]) {
  test('stale/foreign exact dismissal remains rejected: ' + JSON.stringify(patch), async t => {
    const h = await fixture(t); const result = await h.rawDismiss(patch);
    assert.equal(result.success, false); assert.equal(h.store.get(h.identity.operationKey).receipt.presentationDismissedAt, undefined);
    assert.equal(h.rows().length, 2); assert.equal(h.effects.sends, 0);
  });
}

test('live CONFIRMING without cancelled/retired proof is not aliased to UNKNOWN for X', async t => {
  const h = await fixture(t, { control: 'none' }); assert.equal(h.current.queueStatus, 'audit-pending');
  const result = await h.rawDismiss(); assert.equal(result.success, false);
  assert.equal(result.reason, 'unknown-presentation-changed'); assert.equal(h.effects.sends, 0);
});

test('new canonical confirmation cannot be hidden by an old UNKNOWN click that was not previously accepted', async t => {
  const h = await fixture(t); assert.equal(h.lateAudit().promoted, true);
  const result = await h.rawDismiss(); assert.equal(result.success, false);
  assert.equal(h.store.get(h.identity.operationKey).receipt.presentationDismissedAt, undefined);
  assert.equal(h.store.get(h.identity.operationKey).state, 'confirmed');
});

test('durable user cancellation needs no extra queue metadata read to hide its existing UNKNOWN card', async t => {
  const h = await fixture(t);
  h.web.projectQueuedSendReceipt = () => assert.fail('unnecessary metadata read');
  await h.click(); assert.deepEqual(h.errors, []); unchangedDelivery(h);
});

test('failed retirement metadata read does not hide or reclassify an uncancelled attempt', async t => {
  const h = await fixture(t, { control: 'absent' });
  h.web.projectQueuedSendReceipt = () => { throw Error('controlled-metadata-read-EIO'); };
  await h.click(); assert.deepEqual(h.errors, ['controlled-metadata-read-EIO']);
  assert.equal(h.rows().length, 2); assert.equal(h.effects.sends, 0);
  assert.equal(h.store.get(h.identity.operationKey).receipt.presentationDismissedAt, undefined);
  assert.equal(h.store.get(h.identity.operationKey).state, 'audit-pending');
});
