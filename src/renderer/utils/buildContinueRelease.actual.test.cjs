'use strict';
// Actual persisted queue flags + runner release/fire callbacks + SQL Send
// admission. The natural cause/runtime and final provider entry are controlled.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module');
const ts = require('typescript'), esbuild = require('esbuild');
const { NodeSqlite } = require('../../main/fixtures/build-install-posthook.cjs');
const { AgentSendQueue } = require('../../main/agent-send-queue');
const { createAgentSendReceiptStore } = require('../../main/agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('../../main/agent-send-receipt-registry');
const { promptAuditFingerprint } = require('../../main/prompt-audit-fingerprint');
const tree = ts.createSourceFile('runner.ts', fs.readFileSync(path.join(__dirname, '../hooks/usePromptQueueRunner.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
function selected(name) {
  const found = []; const visit = n => { if (ts.isVariableDeclaration(n) && n.name.getText(tree) === name) found.push(n); ts.forEachChild(n, visit); }; visit(tree);
  assert.equal(found.length, 1, name); return 'const ' + found[0].getText(tree) + ';';
}
let installCallback;
function visitInstall(n) { if (ts.isVariableDeclaration(n) && n.name.getText(tree) === 'unsubscribeBuildInstall') installCallback = n.initializer.arguments[0].getText(tree); ts.forEachChild(n, visitInstall); }
visitInstall(tree); assert(installCallback);
const callbacks = ts.transpileModule(selected('fireLoopOwner') + '\n' + selected('releaseBuildContinue')
  + '\nglobalThis.release = releaseBuildContinue; globalThis.installRelease = ' + installCallback + ';', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let bundle;
test.before(async () => { bundle = (await esbuild.build({ entryPoints: [path.join(__dirname, '../store/usePromptQueueStore.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })).outputFiles[0].text; });
async function fixture(t, mode) {
  const oldWindow = global.window, saved = new Map();
  global.window = { require: () => ({ ipcRenderer: { on() {}, removeListener() {},
    invoke: async (name, value) => name === 'app:getState' ? saved.get(value) : name === 'ai-prompts:get' ? { success: true, data: [] } : { success: true },
    sendSync() { return { success: true }; } } }) };
  const mod = new Module(path.join(__dirname, 'release.private.cjs'), module); mod.filename = path.join(__dirname, 'release.private.cjs');
  mod.paths = Module._nodeModulePaths(__dirname); mod._compile(bundle, mod.filename);
  const q = mod.exports; await q.hydratePromptQueueStore(); q.usePromptQueueStore.getState().setLoopPromptEnabled('worker', true, mode);
  const db = new NodeSqlite(), receipts = createAgentSendReceiptStore(db), queue = new AgentSendQueue({ store: receipts, ready: () => false });
  const controls = { blocked: false, hydrated: true }, sends = [];
  const ctx = vm.createContext({ usePromptQueueStore: q.usePromptQueueStore, queueShutdownPending: false,
    canProcessWorkflowOutcomes: () => controls.hydrated, prevBusyRef: new Map([['worker', false]]), deferredOwnerSends: new Map(),
    latestLoopCauseByOwner: new Map([['worker', 'native-final-cause']]), queueSendInflight: new Set(),
    getLoopPrompt: value => q.isLoopPromptActive(value) ? { text: value.loopPromptText } : null,
    isTabWorkflowBlocked: () => controls.blocked,
    retryDeferredOwnerSend: () => assert.fail('this fixture exercises the pinned natural cause'),
    beginValidatedQueueSend: (tabId, trigger, prompt, label, kind, cause) => {
      assert.equal(cause, 'native-final-cause'); assert.equal(kind, 'loop');
      ctx.queueSendInflight.add(tabId); // Controlled final scenario leaf, same existing owner contract.
      const H = 'loop:' + cause, request = { tabId, provider: 'codex', handoffId: H, source: 'prompt-loop',
        sendOperationKey: 'history:' + tabId + ':' + H, prompt: prompt.text };
      const result = queue.enqueue({ identity: { operationKey: request.sendOperationKey, tabId, provider: 'codex', sessionId: 'A',
        handoffId: H, surface: 'desktop-history', requestFingerprint: fingerprintAgentSendRequest(request),
        promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length }, request });
      assert.equal(result.ok, true); sends.push(result); return true;
    } });
  vm.runInContext(callbacks, ctx);
  t.after(() => { queue.dispose(); db.close(); q.flushPromptQueueStoreSync(); if (oldWindow === undefined) delete global.window; else global.window = oldWindow; });
  return { ctx, controls, sends, queue, receipts, flags: () => q.usePromptQueueStore.getState().getQueue('worker') };
}
const release = { version: 1, operationId: 'exact-stale-operation', tabId: 'worker', handoffId: 'old-build-H', state: 'superseded' };
for (const mode of ['all-work', 'own-turn']) test(mode + ': release retries one prior natural cause; duplicate IPC gives one SQL input and Loop remains ON', async t => {
  const h = await fixture(t, mode), before = JSON.stringify(h.flags());
  h.ctx.release(null, release); h.ctx.release(null, release);
  assert.equal(h.sends.length, 1); assert.equal(h.flags().loopPromptEnabled, true);
  assert.equal(JSON.stringify(h.flags()), before, 'release cannot change authored queue flags/arm');
  assert.equal(h.receipts.list({ tabId: 'worker' }).length, 1);
  assert.equal(h.receipts.list({ tabId: 'worker' })[0].attemptId, null, 'application admission is distinct from native Enter');
});
for (const kind of ['no-natural-cause', 'busy-parent', 'hydration', 'Goal-draft-FIFO-install', 'Loop-OFF']) test(kind + ' does not turn a release into input authority', async t => {
  const h = await fixture(t, 'all-work');
  if (kind === 'no-natural-cause') h.ctx.latestLoopCauseByOwner.clear();
  if (kind === 'busy-parent') h.ctx.prevBusyRef.set('worker', true);
  if (kind === 'hydration') h.controls.hydrated = false;
  if (kind === 'Goal-draft-FIFO-install') h.controls.blocked = true;
  if (kind === 'Loop-OFF') h.ctx.usePromptQueueStore.getState().setLoopPromptEnabled('worker', false);
  h.ctx.release(null, release); assert.equal(h.sends.length, 0);
});

test('X after a real final during install wait preserves that final and releases one deferred Loop step', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 }); t.after(() => t.mock.timers.reset());
  const h = await fixture(t, 'all-work'); t.mock.timers.setTime(1100);
  let saved;
  const owner = require('../../main/build-install-continuation').createBuildInstallContinuations({ read: () => saved,
    write: value => { saved = value; }, receipts: () => ({ list: () => [] }) });
  owner.reserve({ requestId: 'source-request', jobId: 'source-job', source: { tabId: 'worker', projectId: 'P', sessionId: 'A', toolType: 'codex' } });
  const final = { tabId: 'worker', reason: 'task_complete', turnId: 'native-later-final', outcomeTs: 1200 };
  h.ctx.buildInstallContinuationBlocks = id => owner.blocked(id);
  h.ctx.buildInstallContinuationFloor = () => owner.snapshot().entries[0].outcomeFloorAt || 0;
  h.ctx.isPromptQueueStoreHydrated = () => true;
  h.ctx.deferredOrchestrationNaturalOutcomes = new Map([['worker', { data: final, source: 'real-native', outcomeTs: 1200 }]]);
  h.ctx.getPromptQueueAgent = () => 'claude'; // no extra provider snapshot leaf in this fixture
  let processed = 0;
  h.ctx.processSuccessfulWorkflowOutcome = (data, source, at) => {
    assert.equal(data, final); assert.equal(at, 1200); assert(at >= h.ctx.buildInstallContinuationFloor()); processed++;
    h.ctx.release(null, release); // Existing normal outcome→Send leaf remains controlled.
  };
  t.mock.timers.setTime(1300); const cancelled = owner.cancelRequest({ requestId: 'source-request', id: 'source-job', tabId: 'worker' });
  assert.equal(cancelled.outcomeFloorAt, 1100, 'cancellation is not a new outcome timestamp');
  h.ctx.installRelease(cancelled); h.ctx.installRelease(cancelled);
  assert.equal(processed, 1); assert.equal(h.sends.length, 1); assert.equal(h.flags().loopPromptEnabled, true);
});
