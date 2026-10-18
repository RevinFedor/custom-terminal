'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { reconcileAgentSendStartupRecords } = require('./agent-send-startup-reconcile');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const startup = ast.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(d => d.name.getText(ast) === 'agentSendReceiptStartupReady'));
assert.ok(startup);
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const begin = web.indexOf('  const startupQueue = agentSendQueue;');
const end = web.indexOf('  if (agentSendReceiptStore && !agentSendReceiptStartupReadyFn)', begin);
assert.ok(begin >= 0 && end > begin);
const tick = () => new Promise(resolve => setImmediate(resolve));

function identity(tabId, handoffId) {
  const prompt = 'fixture ' + handoffId;
  return { operationKey: 'history:' + tabId + ':' + handoffId, surface: 'desktop-history',
    tabId, handoffId, requestFingerprint: handoffId, provider: 'codex', sessionId: 'S',
    promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-startup-gate-busy-'));
  const file = path.join(root, 'own.sqlite');
  const db = new Database(file, { timeout: 0 });
  db.pragma('journal_mode = WAL');
  const other = new Database(file, { timeout: 0 });
  const store = createAgentSendReceiptStore(db);
  const writes = [], logs = [];
  const context = { agentSendReceiptStore: store, AGENT_SEND_DURABLE_STATES: STORE_STATES,
    sendQueueRendererReady: true, sendQueueRecoveryReady: false,
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) } };
  const queue = new AgentSendQueue({ store,
    ready: () => context.sendQueueRendererReady && context.sendQueueRecoveryReady,
    // This endpoint deliberately does NOT simulate provider success or PTY input.
    execute: async request => { writes.push(request.handoffId);
      return { success: false, submitted: false, pasteWritten: false, enterWritten: false,
        code: 'controlled-no-pty-endpoint' }; },
  });
  context.agentSendQueue = queue;
  const enqueue = (tab, handoff) => queue.enqueue({ identity: identity(tab, handoff),
    request: { tabId: tab, handoffId: handoff, prompt: 'fixture ' + handoff, provider: 'codex' } });
  const old = identity('old-owner', 'old');
  enqueue('old-owner', 'old');
  const attempt = store.beginAttempt(old);
  store.markAttemptState(old.operationKey, attempt.attemptId, 'enter-armed');
  context.agentSendReceiptStartupReconcile = store.reconcileStartup();
  assert.equal(store.get(old.operationKey).state, 'delivery-unknown');
  context.reconcileAgentSendStartupRecords = async (...args) => {
    const decisions = await reconcileAgentSendStartupRecords(...args);
    other.exec('BEGIN IMMEDIATE'); // Actual competing SQLite writer, after conservative restart fencing.
    return decisions;
  };
  vm.createContext(context);
  vm.runInContext(startup.getText(ast) + '\nglobalThis.startupResult = agentSendReceiptStartupReady;', context);
  vm.runInContext(web.slice(begin, end), context);
  const outcome = await context.startupResult;
  other.exec('ROLLBACK');
  await tick();
  t.after(async () => {
    queue.dispose(); await tick(); other.close(); db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { queue, store, old, attempt, enqueue, writes, logs, context, outcome };
}

test('optional transcript refinement SQLite BUSY cannot permanently close every unrelated send lane', async t => {
  const h = await fixture(t);
  assert.ok(h.logs.some(line => line.includes('database is locked')), 'actual SQLite failure reached Main catch');
  const fresh = h.enqueue('new-owner', 'fresh');
  assert.equal(fresh.ok, true);
  h.queue.resume();
  await tick(); await tick();
  assert.deepEqual(h.writes, ['fresh'], 'new independent head reaches the existing executor, not a global permanent wait');
});

test('failed refinement never replays old possible Enter or releases its same-owner follower', async t => {
  const h = await fixture(t);
  h.enqueue('old-owner', 'follower');
  h.queue.resume();
  await tick(); await tick();
  assert.deepEqual(h.writes, []);
  assert.equal(h.store.get(h.old.operationKey).state, 'delivery-unknown');
  assert.equal(h.store.get(h.old.operationKey).attemptId, h.attempt.attemptId);
  assert.equal(h.queue.item('history:old-owner:follower').state, 'waiting');
  assert.equal(h.queue.receipt('history:old-owner:follower').attemptId, null);
});
