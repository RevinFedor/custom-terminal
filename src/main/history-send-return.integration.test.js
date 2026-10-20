'use strict';
// Actual History callback/Main handlers/SQLite. App-state mirror is a controlled
// transport into a real private SQLite row; no provider or mounted React here.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const ts = require('typescript'), Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { historySendReturnControl } = require('./history-send-return');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const panel = fs.readFileSync(path.join(__dirname, '../renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
const handoffsPath = path.join(__dirname, '../renderer/utils/historyPromptHandoffs.ts');
const handoffsSource = fs.readFileSync(handoffsPath, 'utf8');
const modules = new Map(); let restore, coordinator;
test.before(async () => {
  for (const match of handoffsSource.matchAll(/from\s+['"]([^'"]+\.mjs)['"]/g)) modules.set(match[1],
    await import(pathToFileURL(path.resolve(path.dirname(handoffsPath), match[1])).href));
  restore = await import('../renderer/utils/historySendReturn.mjs');
  coordinator = await import('../renderer/utils/agentActionCoordinator.mjs');
});
function declaration(source, name) {
  const ast = ts.createSourceFile('actual.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let text;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(ast);
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) text = 'const ' + node.getText(ast) + ';';
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(text, name); return text;
}
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
async function harness(t, { provider = 'codex', active = false, failSave = false, failAck = false, staleRendererAssets = false } = {}) {
  const db = new Database(':memory:'), store = createAgentSendReceiptStore(db);
  db.exec('CREATE TABLE test_draft(value TEXT)');
  const controls = historySendReturnControl(store);
  const control = { tabId: 'T', handoffId: 'H', token: 'return-H', provider }; controls.register(control);
  const sends = [], calls = [], errors = [], writes = [];
  const queue = new AgentSendQueue({ store, ready: () => false, execute: async r => { sends.push(r); } });
  const identity = { operationKey: 'history:T:H', surface: 'desktop-history', tabId: 'T', handoffId: 'H', provider,
    requestFingerprint: 'frozen', promptHash: 'hash', promptLength: 14 };
  const request = { tabId: 'T', handoffId: 'H', provider, source: 'history-panel', prompt: 'old [Image #1]',
    authoringSnapshot: { editorText: 'old [Image #1]', imagePaths: [{ id: 1, path: '/old.png', assetId: 'asset-old' }],
      chips: [{ id: 'old', kind: 'prompt', text: 'old chip', label: 'Chip' }] } };
  queue.enqueue({ identity, request });
  if (active) { db.prepare("UPDATE agent_send_queue SET state='dispatching' WHERE operation_key=?").run(identity.operationKey); store.beginAttempt(identity); }
  const hs = {};
  vm.runInNewContext(compile(handoffsSource), { exports: hs, setTimeout, clearTimeout, console,
    require: id => modules.get(id) || require(path.resolve(path.dirname(handoffsPath), id)) });
  hs.beginHistoryPromptHandoff({ ...control, toolType: provider, text: request.prompt,
    authoringText: request.authoringSnapshot.editorText,
    authoringImagePaths: staleRendererAssets ? [{ id: 1, path: '/temporary-source.png' }] : request.authoringSnapshot.imagePaths,
    authoringChips: request.authoringSnapshot.chips, historyReturn: controls.read('T', 'H'),
    initialStatus: active ? 'preparing' : 'application-queued' });
  let draft = { historyPromptDrafts: { T: 'next' }, historyPromptDraftImages: {}, historyPromptDraftChips: {},
    historyPromptDraftPendingImages: {}, historyPromptDraftUpdatedAt: {}, historyPromptReturnedSends: {} };
  const ui = { restoreHistorySendDraft(input) {
    const r = restore.restoreHistorySendDraft(draft, input, bytes => {
      if (failSave) throw Error('controlled quota'); db.prepare('INSERT INTO test_draft(value) VALUES(?)').run(bytes);
    }); if (r.patch) draft = { ...draft, ...r.patch };
  }, acknowledgeHistorySendDraftReturn() {}, showToast(message) { errors.push(message); } };
  let row = { uuid: 'local-prompt-H', role: 'queued', handoffId: 'H', content: request.prompt,
    queueStatus: active ? 'preparing' : 'application-queued', historyReturn: controls.read('T', 'H') };
  const handlers = new Map();
  const web = { cancelQueuedAgentSends: (tab, h, options) => queue.cancelWaiting(tab, h, options),
    readQueuedSendAuthoring: (tab, h) => queue.authoringSnapshot(tab, h),
    releaseQueuedSendPresentation: key => queue.releasePresentation(key) };
  const context = vm.createContext({ ...hs, ...restore, ...coordinator, useRef: value => ({ current: value }),
    useCallback: fn => fn, tabId: 'T', toolType: provider, console, path, srcMainDir: __dirname,
    historySendReturnControl, agentSendReceiptStore: store,
    LOCAL_PROMPT_PREFIX: 'local-prompt-',
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, control) => {
      if (channel === 'agent:history-send-return') hs.recordHistorySendReturnControl(control);
    } } },
    projectManager: { db: { getAppState: () => db.prepare('SELECT value FROM test_draft ORDER BY rowid DESC LIMIT 1').get()?.value } },
    DESKTOP_HISTORY_SEND_SURFACE: 'desktop-history', agentSendReceiptStartupReady: Promise.resolve(),
    useUIStore: { getState: () => ui }, removeHistorySendRecovery() {},
    removeLocalPromptEntry() { row = null; }, showHistoryIncidentToast: (_t, e) => errors.push(e.message),
    require: id => { assert.equal(id, path.join(__dirname, 'web-server')); return web; },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    ipcRenderer: { invoke: async (name, input) => {
      calls.push(name); if (failAck === true && name === 'agent:ack-history-send-return') throw Error('controlled lost ACK');
      assert.ok(handlers.has(name), name);
      const result = await handlers.get(name)({}, input);
      if (failAck === 'after' && name === 'agent:ack-history-send-return') throw Error('controlled reply lost after commit/event');
      return result;
    } },
  });
  for (const name of ['agent:register-history-send-return', 'agent:return-history-send', 'agent:ack-history-send-return']) {
    const start = main.indexOf("ipcMain.handle('" + name + "'");
    const end = main.indexOf('\nipcMain.handle(', start + 1); assert.ok(start >= 0 && end > start);
    vm.runInContext(main.slice(start, end), context);
  }
  vm.runInContext(declaration(main, 'publishHistorySendReturn') + '\n' + declaration(main, 'writeHistorySendPayload'), context);
  vm.runInContext(compile(declaration(panel, 'isLocalPromptEntry') + '\n'
    + declaration(panel, 'returnPromptInflight') + '\n' + declaration(panel, 'dismissPromptPresentation'))
    + '\nglobalThis.returnMessage=dismissPromptPresentation;', context);
  t.after(() => { queue.dispose(); coordinator.resetCoordinatedAgentActionsForTests(); db.close(); });
  return { context, hs, db, store, queue, controls, control, identity, calls, errors, sends, writes,
    click: () => context.returnMessage(row), row: () => row, draft: () => draft,
    write: () => context.writeHistorySendPayload({ write: x => writes.push(x) }, 'original', 'T', 'H'),
    setFailAck(value) { failAck = value; }, setFailSave(value) { failSave = value; } };
}
for (const provider of ['codex', 'claude']) test(provider + ': actual return adopts all authoring before next draft; no Send/Stop/reload', async t => {
  const h = await harness(t, { provider }); await h.click();
  assert.equal(h.row(), null); assert.equal(h.errors.length, 0);
  assert.equal(h.draft().historyPromptDrafts.T, 'old [Image #1]\n\nnext');
  assert.equal(h.draft().historyPromptDraftImages.T[0].assetId, 'asset-old');
  assert.equal(h.draft().historyPromptDraftChips.T[0].text, 'old chip');
  assert.equal(h.controls.read('T', 'H').state, 'restored');
  assert.equal(h.queue.referencedAssetIds().has('asset-old'), false);
  assert.equal(h.sends.length, 0); assert.equal(h.writes.length, 0);
  assert.deepEqual(h.calls, ['agent:register-history-send-return', 'agent:return-history-send', 'agent:ack-history-send-return']);
});
test('active preparation keeps launch/receipt alive; later payload is refused', async t => {
  const h = await harness(t, { active: true }); await h.click();
  assert.equal(h.store.get(h.identity.operationKey).state, 'in-flight');
  assert.equal(h.store.isDeliveryCancelled(h.identity.operationKey), false);
  assert.throws(h.write, { code: 'history_send_returned' }); assert.equal(h.writes.length, 0);
});
test('write winning click race keeps card/draft and does not cancel Enter', async t => {
  const h = await harness(t, { active: true }); h.write(); await h.click();
  assert.equal(h.writes.length, 1); assert.ok(h.row());
  assert.equal(h.draft().historyPromptDrafts.T, 'next');
  assert.equal(h.store.isDeliveryCancelled(h.identity.operationKey), false);
});
test('failed save keeps card and assets; retry adopts once', async t => {
  const h = await harness(t, { failSave: true }); await h.click();
  assert.ok(h.row()); assert.equal(h.controls.read('T', 'H').state, 'returned');
  assert.equal(h.queue.referencedAssetIds().has('asset-old'), true);
  h.setFailSave(false); await h.click(); assert.equal(h.row(), null);
  assert.equal(h.draft().historyPromptDrafts.T, 'old [Image #1]\n\nnext');
});
test('lost adoption ACK keeps same return; retry cannot prepend twice', async t => {
  const h = await harness(t, { failAck: true }); await h.click();
  assert.ok(h.row()); assert.equal(h.queue.referencedAssetIds().has('asset-old'), true);
  h.setFailAck(false); await h.click(); assert.equal(h.row(), null);
  assert.equal(h.draft().historyPromptDrafts.T, 'old [Image #1]\n\nnext');
});
test('durable adoption event before lost reply retires card without duplicate restore/error', async t => {
  const h = await harness(t, { failAck: 'after' }); await h.click();
  assert.equal(h.controls.read('T', 'H').state, 'restored');
  assert.equal(h.row(), null); assert.equal(h.errors.length, 0);
  assert.equal(h.draft().historyPromptDrafts.T, 'old [Image #1]\n\nnext');
});
test('Main frozen authoring wins over pre-materialization renderer image refs', async t => {
  const h = await harness(t, { staleRendererAssets: true }); await h.click();
  assert.equal(h.row(), null); assert.equal(h.errors.length, 0);
  assert.equal(h.draft().historyPromptDraftImages.T[0].assetId, 'asset-old');
  assert.equal(h.draft().historyPromptDraftImages.T[0].path, '/old.png');
});
