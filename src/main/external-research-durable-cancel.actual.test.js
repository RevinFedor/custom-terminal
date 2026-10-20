'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), runs = require('./orchestration-runs');
const { isResponseObservation } = require('./orchestration-response-observation');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-external-durable-')), file = path.join(root, 'runs.json');
  const store = new runs.OrchestrationRunStore(file);
  await store.reserveOrGet({ runId: 'own-R', runKind: 'external-research', requestFingerprint: 'immutable', sourceTabId: 'source',
    sourceSessionId: 'S', notifySource: true, externalResearchJobId: 'noted_own-R',
    externalResearchIntent: { provider: 'chatgpt', prompt: 'own fixture', options: {}, files: [] } });
  await store.persistStrict();
  t.after(async () => { await store.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, file, reopened: () => new runs.OrchestrationRunStore(file) };
}
function failWrites(t, file) {
  const rename = fs.promises.rename; let failing = true, writes = 0;
  fs.promises.rename = async (a, b) => { if (b === file) { writes++; if (failing) throw Object.assign(Error('owned ENOSPC'), { code: 'ENOSPC' }); } return rename(a, b); };
  t.after(() => { fs.promises.rename = rename; });
  return { recover: () => { failing = false; }, count: () => writes };
}
test('real external cancel rejects failed write, keeps RAM suppression; identical retry strictly commits before ACK and late done stays cancelled', async t => {
  const h = await fixture(t), disk = failWrites(t, h.file);
  await assert.rejects(h.store.cancel('own-R'), /owned ENOSPC/);
  assert.equal((await h.store.get('own-R')).status, 'cancelled');
  assert.equal((await h.store.get('own-R')).notificationSuppressed, true);
  await assert.rejects(h.store.cancel('own-R'), /owned ENOSPC/);
  assert(disk.count() >= 2, 'idempotent cancelled branch must retry raw write');
  disk.recover(); await h.store.cancel('own-R');
  const restored = h.reopened(); assert.equal((await restored.get('own-R')).status, 'cancelled');
  await restored.applyExternalResearchSnapshot('own-R', { id: 'noted_own-R', status: 'done', result: { text: 'late' } });
  assert.equal((await restored.get('own-R')).status, 'cancelled'); await restored.flush();
});
for (const action of ['mark', 'dismiss']) test('completed external ' + action + ' suppression is strict and retryable without changing result', async t => {
  const h = await fixture(t);
  await h.store.patch('own-R', { status: 'completed', resultComplete: true, notificationStatus: 'unconfirmed' }); await h.store.persistStrict();
  const disk = failWrites(t, h.file);
  const suppress = () => action === 'mark' ? h.store.markNotification('own-R', 'suppressed') : h.store.dismissAttention('own-R', 'source');
  await assert.rejects(suppress(), /owned ENOSPC/);
  assert.equal((await h.store.get('own-R')).notificationSuppressed, true);
  disk.recover(); await suppress(); const restored = await h.reopened().get('own-R');
  assert.equal(restored.status, 'completed'); assert.equal(restored.resultComplete, true); assert.equal(restored.notificationSuppressed, true);
});
test('external pre-submit cancel preserves suppressNotification false caller contract', async t => {
  const h = await fixture(t); await h.store.cancel('own-R', { suppressNotification: false });
  const restored = await h.reopened().get('own-R'); assert.equal(restored.status, 'cancelled'); assert.notEqual(restored.notificationSuppressed, true);
});
test('actual completion preparation held across durable suppression never invokes new input', async t => {
  const h = await fixture(t); await h.store.patch('own-R', { status: 'completed', resultComplete: true }); await h.store.persistStrict();
  const source = fs.readFileSync(require.resolve('./web-server'), 'utf8'), ast = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'sendOrchestrationCompletionNotification');
  let enter, release, sent = 0; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  const ctx = vm.createContext({ ...runs, isResponseObservation, console, Date, require, path, srcMainDir: __dirname,
    orchestrationNotificationInflight: new Set(), getOrchestrationRunStore: () => h.store,
    orchestrationNotificationText: () => 'own immutable answer', prepareOrchestrationCompletionContent: async () => { enter(); await held; return null; },
    resolveAgentSessionInfo: async () => ({ toolType: 'codex', sessionId: 'S' }), resolveOrchestrationSourceNotificationSendOptions: () => ({}),
    tabWorkContext: null, promptFingerprint: () => 'own-hash', promptAuditFingerprint: () => 'own-audit', emitOrchestrationChanges() {},
    armOrchestrationSourceProof: async () => ({ success: true }), releaseOrchestrationSourceProof: async () => {},
    agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptStore: null,
    runAgentSendScenario: async () => { sent++; throw Error('input forbidden'); }, scheduleOrchestrationPolicyTimer() {},
  });
  vm.runInContext(fn.getText(ast), ctx);
  const sending = ctx.sendOrchestrationCompletionNotification(await h.store.getInternal('own-R')); await entered;
  await h.store.markNotification('own-R', 'suppressed'); release(); await sending;
  assert.equal(sent, 0); assert.equal((await h.reopened().get('own-R')).notificationSuppressed, true);
});
