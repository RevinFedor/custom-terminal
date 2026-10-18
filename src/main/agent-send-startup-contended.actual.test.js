'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module'), ts = require('typescript'), Database = require('better-sqlite3');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { reconcileAgentSendStartupRecords } = require('./agent-send-startup-reconcile');
const root = process.env.ACTUAL_SOURCE_DIR || __dirname;
const source = fs.readFileSync(path.join(root, 'agent-send-queue.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8'), web = fs.readFileSync(path.join(root, 'web-server.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const startup = ast.statements.find(n => ts.isVariableStatement(n)
  && n.declarationList.declarations.some(d => d.name.getText(ast) === 'agentSendReceiptStartupReady')).getText(ast);
const gateStart = web.indexOf('  const startupQueue = agentSendQueue;');
const gateEnd = web.indexOf('  if (agentSendReceiptStore && !agentSendReceiptStartupReadyFn)', gateStart);
const tick = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
const identity = (tabId, handoffId) => ({ tabId, handoffId, operationKey: 'history:' + tabId + ':' + handoffId,
  surface: 'desktop-history', requestFingerprint: handoffId, provider: 'codex', promptHash: 'hash', promptLength: 6 });

test('actual degraded-ready + continuing real SQLite writer parks only its unwritten HEAD, without microtask spin or replay', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'send-continued-busy-')), file = path.join(directory, 'db.sqlite');
  const db = new Database(file, { timeout: 0 }); db.pragma('journal_mode = WAL');
  const other = new Database(file, { timeout: 0 }), store = createAgentSendReceiptStore(db);
  const scheduled = [], logs = [], executions = [];
  const context = vm.createContext({ module: { exports: {} }, exports: {},
    require: createRequire(path.join(__dirname, 'agent-send-queue.js')),
    queueMicrotask: callback => scheduled.push(callback),
    console: { log() {}, warn: (...a) => logs.push(a.join(' ')) },
  });
  vm.runInContext(source, context);
  const queue = new context.module.exports.AgentSendQueue({ store,
    ready: () => context.sendQueueRendererReady && context.sendQueueRecoveryReady,
    execute: async request => {
      executions.push(request.handoffId);
      const id = identity(request.tabId, request.handoffId), attempt = store.beginAttempt(id);
      store.markAttemptState(id.operationKey, attempt.attemptId, 'enter-armed');
      store.settleAttempt(id.operationKey, attempt.attemptId, {
        success: null, accepted: true, submitted: null, deliveryUnknown: true, status: 'delivery-unknown',
      });
      return { success: null, accepted: true, submitted: null, deliveryUnknown: true, status: 'delivery-unknown' };
    },
  });
  let locked = false;
  t.after(async () => { queue.dispose(); if (locked) other.exec('ROLLBACK'); await tick(); other.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const enqueue = (tab, handoff, execute) => queue.enqueue({ identity: identity(tab, handoff),
    request: { tabId: tab, handoffId: handoff, provider: 'codex', prompt: 'frozen' }, execute });
  enqueue('old', 'old'); const oldAttempt = store.beginAttempt(identity('old', 'old'));
  store.markAttemptState('history:old:old', oldAttempt.attemptId, 'enter-armed');
  const conservative = store.reconcileStartup(); enqueue('old', 'old-follower');
  const exactExecutor = scope => queue.execute({ tabId: 'new', handoffId: 'fresh', provider: 'codex' }, scope);
  enqueue('new', 'fresh', exactExecutor); enqueue('new', 'fresh-follower'); enqueue('independent', 'independent');
  const original = queue.item('history:new:fresh');
  Object.assign(context, { agentSendQueue: queue, agentSendReceiptStore: store, AGENT_SEND_DURABLE_STATES: STORE_STATES,
    sendQueueRendererReady: true, sendQueueRecoveryReady: false,
    agentSendReceiptStartupReconcile: conservative,
    reconcileAgentSendStartupRecords: async (...args) => { const decisions = await reconcileAgentSendStartupRecords(...args);
      other.exec('BEGIN IMMEDIATE'); locked = true; return decisions; },
  });
  vm.runInContext(startup + '\nglobalThis.startupResult = agentSendReceiptStartupReady;', context);
  vm.runInContext(web.slice(gateStart, gateEnd), context); await context.startupResult; await tick();
  assert.equal(context.sendQueueRecoveryReady, true); assert.ok(logs.some(x => x.includes('database is locked')));
  const drainWave = async () => { const wave = scheduled.splice(0); for (const callback of wave) callback(); await tick(); };
  await drainWave(); await drainWave();
  assert.equal(scheduled.length, 0, 'a still-held SQLite writer must not schedule its own busy pump repeatedly');
  assert.deepEqual(executions, []);
  assert.equal(queue.executors.get('history:new:fresh'), exactExecutor, 'same unwritten executor must remain owned');
  assert.equal(queue.item('history:new:fresh').state, 'waiting');
  assert.equal(queue.item('history:new:fresh').request_json, original.request_json);
  assert.equal(store.get('history:new:fresh').attemptId, null);
  other.exec('ROLLBACK'); locked = false;
  queue.notifyRuntime('new'); queue.notifyRuntime('independent'); await drainWave(); await drainWave();
  assert.deepEqual(executions.sort(), ['fresh', 'independent']);
  assert.equal(store.get('history:old:old').attemptId, oldAttempt.attemptId);
  assert.equal(store.get('history:old:old').state, 'delivery-unknown');
  assert.equal(store.get('history:old:old-follower').attemptId, null);
  assert.equal(store.get('history:new:fresh-follower').attemptId, null);
  assert.equal(store.get('history:new:fresh').state, 'delivery-unknown');
  queue.resume(); await drainWave(); await drainWave();
  assert.equal(executions.length, 2, 'runtime wake cannot replay an uncertain entered head');
});
