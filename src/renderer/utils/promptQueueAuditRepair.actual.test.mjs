import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import * as esbuild from 'esbuild';
import ts from 'typescript';
import { createAutoCompactCoordinator } from './autoCompactCoordinator.mjs';
import { autoCompactIncludesTarget } from './autoCompactPolicy.mjs';
import { selectPromptQueuePreparationProgress } from './promptQueueReceiptIdentity.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerPath = path.join(root, 'hooks/usePromptQueueRunner.ts');
const overlay = fs.readFileSync(path.join(root, 'components/Workspace/PromptQueueOverlay.tsx'), 'utf8');
const overlayTree = ts.createSourceFile('overlay.tsx', overlay, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const quiet = { log() {}, warn() {}, error() {} };
function actualRunnerDeclaration(source, name) {
  const tree = ts.createSourceFile('runner.ts', source, ts.ScriptTarget.Latest, true);
  let found;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) found = 'const ' + node.getText(tree) + ';';
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(found, name); return found;
}
const barrier = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = async () => { for (let i = 0; i < 90; i++) await Promise.resolve(); };
const modules = {
  useWorkspaceStore: 'export const useWorkspaceStore={getState:()=>globalThis.ports.workspace,subscribe:()=>()=>{}};',
  useUIStore: 'export const useUIStore={getState:()=>globalThis.ports.ui};',
  useOrchestrationStore: `export const useOrchestrationStore={getState:()=>({hydrated:true,initialized:true,inheritedBusyTabIds:new Set(),runs:new Map()}),subscribe:()=>()=>{}};
    export const initializeOrchestrationStore=async()=>{};
    export const isOrchestrationCompletionBlocked=()=>false;
    export const subscribeOrchestrationRunChanges=()=>()=>{};`,
  historyAgentRuntimes: `export const getHistoryAgentRuntime=()=>globalThis.ports.runtime;`,
  agentSendPreparation: `export const prepareAgentRuntimeForSend=(...a)=>globalThis.ports.prepareRuntime(...a);
    export const createAgentReadyWait=()=>({wait:async()=>{}});
    export const proveAgentComposerForSend=async()=>({complete:false});
    export const prepareAgentRecordContext=async()=>({restartPerformed:false,historyContextResult:null});`,
  tabWorkContext: `export const prepareTabWorkContext=(...a)=>globalThis.ports.workContext(...a);
    export const settleTabWorkContext=(...a)=>globalThis.ports.settleContext(...a);
    export const activateTabWorkContext=async()=>{};`,
  historyRewriteRewind: `export const executeHistoryRewriteRewindScenario=(...a)=>globalThis.ports.rewind(...a);
    export class HistoryRewriteRewindError extends Error {}`,
  claudePtyActions: 'export const applyClaudePtySettings=async()=>({success:true});',
};
let bundle;
test.before(async () => {
  const build = await esbuild.build({ stdin: { contents: `
    export * from './store/usePromptQueueStore';
    export * from './hooks/usePromptQueueRunner';
    export { shouldArmQueueForTrigger } from './utils/promptTriggerArm.mjs';
  `, resolveDir: root, loader: 'ts' }, platform: 'node', bundle: true, write: false,
    format: 'cjs', target: 'node18', logLevel: 'silent', plugins: [{ name: 'controlled-runtime-ports', setup(build) {
      build.onLoad({ filter: /\.(ts|tsx)$/ }, args => {
        const name = path.basename(args.path).replace(/\.tsx?$/, '');
        if (modules[name]) return { contents: modules[name], loader: 'ts' };
        if (args.path === runnerPath) {
          const source = fs.readFileSync(args.path, 'utf8');
          return { contents: source + `
          export { beginConditionAwareQueueSend, beginValidatedQueueSend, beginValidatedQueueMetaAction,
            applyAbnormalQueueOutcome, signalQueueOwnerReadiness, handleQueueAgentStopping };
          export const testAwait=()=>queueSendInflight.size===0&&queueConditionChecks.size===0;
          export const testAttempt=tab=>deferredOwnerSends.get(tab);
          export const testCoordinator=value=>autoCompactCoordinator=value;
          export const testAppInstance=(id, at)=>{queueAppRuntimeInstanceId=id;queueAppRuntimeStartedAt=at;};
          export function testLiveHandler(channel = 'codex') {
            workflowRestoreReconciled = true;
            const coordinator = { intercept: () => false, wake() {}, cancel() {} };
            ${['findOwnersWaitingOn', 'fireQueueOwner', 'fireLoopOwner', 'getReadyTriggerForOwner'].map(name => actualRunnerDeclaration(source, name)).join('\n')}
            ${actualRunnerDeclaration(source, 'processSuccessfulWorkflowOutcome')}
            ${actualRunnerDeclaration(source, 'handleBusyState')}
            return handleBusyState(channel);
          }
          export function testColdScheduler() {
            workflowRestoreReconciled = true;
            let firing = false;
            const pendingTimers = new Map();
            ${['clearTimer', 'fireHead', 'scheduleFirstDelayTimer', 'startFirstDelayCountdown',
              'verifyCodexTriggerIdleThenFire', 'evaluateQueues'].map(name => actualRunnerDeclaration(source, name)).join('\n')}
            return Object.assign(() => {const s=usePromptQueueStore.getState();evaluateQueues(s,s,{forceRuntimeArms:true,forceAppRestartTriggers:true});}, {deadline: scheduleFirstDelayTimer});
          }
        `, loader: 'ts' };
        }
      });
    } }] });
  bundle = build.outputFiles[0].text;
});

async function fixture(t, initialQueue = null) {
  const events = new EventEmitter(), timers = new Map(), saved = [], sends = [], reads = [], cancelled = [], contextSettles = [], rewinds = [], stops = [], toasts = [], preparations = [];
  let n = 0, sid = 'A', contextPct = 90, receipt = null, sendResult = { success: true, submitted: true }, hold = null;
  const tab = { id: 'T', tabType: 'terminal', commandType: 'codex', codexSessionId: sid, cwd: '/private-fixture' };
  const ports = {
    workspace: { isRestoring: false, openProjects: new Map([['P', { projectPath: '/private-fixture', tabs: new Map([['T', tab]]) }]]) },
    ui: { showToast: (...args) => toasts.push(args), codexSettings: { models: [] }, claudeCodeSettings: { models: [] } },
    runtime: { toolType: 'codex', getPresence: async () => {
      if (hold?.kind === 'readiness') { hold.entered.resolve(); await hold.release.promise; }
      return { status: 'active', inputReady: true, isBusy: false, sessionId: sid };
    } },
    prepareRuntime: async input => {
      preparations.push(input);
      if (hold?.kind === 'prepare-runtime') {
        hold.entered.resolve();
        await Promise.race([hold.release.promise, new Promise((_, reject) => {
          input.admissionSignal.addEventListener('abort', () => reject(new Error('controlled preparation aborted')), { once: true });
        })]);
      }
      return { status: 'active', submitCapability: 'direct', presence: { inputReady: true } };
    },
    workContext: async (_tab, _id, prompt) => {
      if (hold?.kind === 'work-context') { hold.entered.resolve(); await hold.release.promise; }
      return { prompt, prefix: '' };
    },
    settleContext: async (...a) => contextSettles.push(a),
    rewind: async value => { rewinds.push(value); return value; },
  };
  const ipc = { on: (...a) => events.on(...a), removeListener: (...a) => events.removeListener(...a), sendSync() {},
    invoke: async (channel, input) => {
      if (channel === 'app:getState') return input === 'promptQueueByTab' && initialQueue
        ? JSON.stringify({ T: initialQueue }) : null;
      if (channel === 'app:setState') {
        saved.push(JSON.parse(input.value));
        if (hold?.kind === 'persistence') { hold.entered.resolve(); await hold.release.promise; }
        return { success: true };
      }
      if (channel === 'ai-prompts:get') return { success: true, data: [] };
      if (channel === 'tab:get-context-pct') {
        if (hold?.kind === 'context') { hold.entered.resolve(); await hold.release.promise; }
        reads.push({ ...input });
        return { exact: true, provider: input.provider, sessionId: input.sessionId, pct: input.sessionId === sid ? contextPct : null };
      }
      if (channel === 'agent:join-automatic-send') return { found: false };
      if (channel === 'agent:enqueue-prompt') { sends.push(input); if (sendResult instanceof Error) throw sendResult; return sendResult; }
      if (channel === 'agent:list-send-receipts') return { success: true, records: receipt ? [receipt] : [] };
      if (channel === 'agent:cancel-send') { cancelled.push(input); return { cancelled: false }; }
      if (channel === 'codex:get-turn-state') return { busy: false, outcomeKnown: true };
      if (channel === 'terminal:stop-ai-process') {
        stops.push(input); ports.stopEvent?.(input);
        if (hold?.kind === 'stop') { hold.entered.resolve(); await hold.release.promise; }
        return { success: true };
      }
      if (channel === 'prompt-queue:materialize-image-refs') return { refs: input.refs };
      throw new Error('unexpected controlled IPC ' + channel);
    } };
  const module = { exports: {} }, window = { require: () => ({ ipcRenderer: ipc }), addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ module, exports: module.exports, require, console: quiet, process, ports,
    window, document: {}, Buffer, AbortController, crypto: { randomUUID: () => 'private-' + (++n) },
    setTimeout: fn => { const id = Symbol(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(bundle, context);
  const actual = module.exports;
  await actual.hydratePromptQueueStore();
  const state = () => actual.usePromptQueueStore.getState();
  const id = initialQueue ? state().getQueue('T').items[0]?.id : state().addPrompt('T', 'FIRST', 0);
  const item = () => state().getQueue('T').items.find(i => i.id === id);
  if (!initialQueue) state().setAutoRun('T', true);
  t.after(() => timers.clear());
  return { actual, context, ports, state, id, item, sends, reads, saved, cancelled, contextSettles, rewinds, stops, toasts, preparations,
    fire: () => actual.beginConditionAwareQueueSend('T', 'T', item(), 'cold-start'),
    setResult: value => sendResult = value,
    setReceipt: value => receipt = value,
    owner: (value, pct) => { sid = value; tab.codexSessionId = value; contextPct = pct; },
    hold: kind => { hold = { kind, entered: barrier(), release: barrier() }; return hold; },
    async settle() { await turn(); assert.equal(actual.testAwait(), true, 'all selected async boundaries settled'); },
  };
}

function findArrow(property, predicate) {
  let arrow;
  const visit = node => {
    if (ts.isJsxAttribute(node) && node.name.text === property && node.initializer
      && ts.isJsxExpression(node.initializer) && ts.isArrowFunction(node.initializer.expression)
      && predicate(node.initializer.expression.getText(overlayTree))) arrow = node.initializer.expression.getText(overlayTree);
    ts.forEachChild(node, visit);
  };
  visit(overlayTree); assert.ok(arrow, property); return arrow;
}

test('actual Run After preparation publishes exact item progress before the first readiness await and retires it on completion', async t => {
  const f = await fixture(t), hold = f.hold('readiness'), events = [];
  const unsubscribe = f.actual.subscribePromptQueueRuntime((tab, reason) => events.push({ tab, reason,
    snapshot: f.actual.getPromptQueueRuntimeSnapshot(tab) }));
  f.fire(); await hold.entered.promise;
  const pending = f.actual.getPromptQueueRuntimeSnapshot('T');
  assert.equal(pending.preparingItemId, f.id); assert.equal(pending.pending, true);
  assert.equal(f.sends.length, 0, 'no admission or provider input during held preparation');
  assert.ok(events.some(x => x.reason === 'preparing-send' && x.snapshot.preparingItemId === f.id));
  assert.deepEqual(selectPromptQueuePreparationProgress(pending, [f.id]), { itemId: f.id, queueStatus: 'preparing' });
  assert.equal(selectPromptQueuePreparationProgress(pending, ['other']), null);
  hold.release.resolve(); await f.settle();
  assert.equal(f.actual.getPromptQueueRuntimeSnapshot('T').preparingItemId, null);
  assert.ok(events.some(x => x.reason === 'send-settled' && x.snapshot.preparingItemId === null));
  unsubscribe();
});

test('context-gated item shows bounded preparation while its actual context read is held, not while merely armed', async t => {
  const f = await fixture(t), hold = f.hold('context');
  f.state().setPromptCondition('T', f.id, { kind: 'context-used', operator: 'gte', percent: 50 });
  assert.equal(f.actual.getPromptQueueRuntimeSnapshot('T').preparingItemId, null);
  f.fire(); await hold.entered.promise;
  const active = f.actual.getPromptQueueRuntimeSnapshot('T');
  assert.equal(active.phase, 'checking-condition'); assert.equal(active.preparingItemId, f.id);
  assert.deepEqual(selectPromptQueuePreparationProgress(active, [f.id]), { itemId: f.id, queueStatus: 'preparing' });
  f.state().setAutoRun('T', false); hold.release.resolve(); await f.settle();
  assert.equal(f.actual.getPromptQueueRuntimeSnapshot('T').preparingItemId, null);
  assert.equal(f.sends.length, 0, 'Pause during preparation cannot send late');
});

test('late live completion runs the actual Stop head once, consumes it after confirmed Stop and preserves later cards on Pause', async t => {
  const f = await fixture(t), receive = f.actual.testLiveHandler(), s = f.state();
  s.removePrompt('T', f.id);
  receive(null, { tabId: 'T', busy: true, reason: 'task_started', timestamp: Date.now() - 120_000 });
  const stopId = s.addMetaAction('T', { kind: 'stop' });
  const laterId = s.addPrompt('T', '/compact', 0);
  s.setAutoRun('T', true);
  const arm = f.state().getQueue('T').workflowArmedAt, hold = f.hold('stop');
  f.ports.stopEvent = () => receive(null, { tabId: 'T', busy: false, reason: 'manual-stop', outcomeTs: Date.now() });
  receive(null, { tabId: 'T', busy: false, reason: 'task_complete', outcomeTs: arm - 60_000 });
  await turn();
  assert.equal(f.stops.length, 1, 'late publication must reach the real queued Stop executor');
  assert.equal(f.stops[0].reason, 'prompt-queue-stop-action');
  assert.equal(f.state().getQueue('T').items[0].id, stopId, 'command dispatch alone does not consume the row');
  assert.equal(f.state().getQueue('T').autoRun, true, 'its own stop edge cannot disarm the in-flight action');
  hold.release.resolve(); await f.settle();
  assert.deepEqual(Array.from(f.state().getQueue('T').items, item => item.id), [laterId]);
  assert.equal(f.state().getQueue('T').autoRun, false);
  assert.equal(f.sends.length, 0, 'the /compact after Stop is not sent or auto-resumed');
  assert.equal(f.stops.length, 1);
  assert.ok(f.toasts.some(([, kind]) => kind === 'success'));
  assert.equal(f.toasts.some(([, kind]) => kind === 'warning' || kind === 'error'), false);
});

test('manual process Stop preserves own queue, Loop, timers and pivoted owners without a toast or Send', async t => {
  for (const mode of ['ordinary', 'timer', 'restart', 'pivot', 'loop']) {
    const f = await fixture(t), s = f.state(), receive = f.actual.testLiveHandler();
    if (mode === 'timer') { s.setFirstDelaySeconds('T', 60); s.startFirstDelayCountdown('T'); }
    if (mode === 'restart') s.setPromptTrigger('T', f.id, { kind: 'app-restart', armedInstanceId: 'main-A' });
    if (mode === 'loop') s.setLoopPromptEnabled('T', true);
    if (mode === 'pivot') {
      f.ports.workspace.openProjects.get('P').tabs.set('U', { id: 'U', commandType: 'codex', codexSessionId: 'U-session' });
      s.addPrompt('U', 'FOLLOW T', 0); s.setRunAfterTab('U', 'T');
    }
    const before = JSON.stringify(Array.from(f.state().queues));
    receive(null, { tabId: 'T', busy: true, reason: 'task_started' });
    receive(null, { tabId: 'T', busy: false, reason: 'manual-stop', outcomeTs: Date.now() + 10 });
    await f.settle();
    assert.equal(JSON.stringify(Array.from(f.state().queues)), before, mode + ': Stop is not queue Pause');
    assert.equal(f.toasts.length, 0, mode + ': no informational toast either');
    assert.equal(f.sends.length, 0, mode + ': Stop is not successful completion');
  }
});

test('manual-stop snapshots and hydration do not cancel a restored queue or fabricate a warning', async t => {
  for (const source of ['codex-state-resolved-abnormal', 'hydration-buffer-abnormal', 'cold-start-codex-state']) {
    const f = await fixture(t), before = JSON.stringify(f.state().getQueue('T'));
    f.actual.applyAbnormalQueueOutcome({ tabId: 'T', busy: false, reason: 'manual-stop', outcomeTs: Date.now() + 10 }, source);
    assert.equal(JSON.stringify(f.state().getQueue('T')), before, source);
    assert.equal(f.toasts.length, 0);
  }
});

test('after manual Stop a later real natural completion still sends the retained head once', async t => {
  const f = await fixture(t), receive = f.actual.testLiveHandler();
  receive(null, { tabId: 'T', busy: true, reason: 'task_started' });
  receive(null, { tabId: 'T', busy: false, reason: 'manual-stop', outcomeTs: Date.now() });
  receive(null, { tabId: 'T', busy: true, reason: 'task_started' });
  receive(null, { tabId: 'T', busy: false, reason: 'task_complete', outcomeTs: Date.now() + 100 });
  await f.settle();
  assert.equal(f.sends.length, 1); assert.equal(f.item(), undefined);
  assert.equal(f.toasts.length, 0);
});

test('Stop during preparation revokes only the old attempt and preserves the armed head for the next trigger', async t => {
  for (const boundary of ['readiness', 'context', 'work-context']) {
    const f = await fixture(t), receive = f.actual.testLiveHandler(), hold = f.hold(boundary);
    if (boundary === 'context') f.state().setPromptCondition('T', f.id, { kind: 'context-used', operator: 'gte', percent: 50 });
    f.fire(); await hold.entered.promise;
    receive(null, { tabId: 'T', busy: false, reason: 'manual-stop', outcomeTs: Date.now() + 10 });
    hold.release.resolve(); await f.settle();
    f.actual.signalQueueOwnerReadiness('T', 'old-ready-after-Stop'); await f.settle();
    assert.equal(f.sends.length, 0, boundary + ': late preparation cannot undo Stop');
    assert.equal(f.state().getQueue('T').autoRun, true, boundary);
    assert.equal(f.state().getQueue('T').items[0].id, f.id);
    assert.equal(f.toasts.length, 0);
    receive(null, { tabId: 'T', busy: true, reason: 'task_started' });
    receive(null, { tabId: 'T', busy: false, reason: 'task_complete', outcomeTs: Date.now() + 100 });
    await f.settle(); assert.equal(f.sends.length, 1, boundary + ': later genuine trigger remains usable');
  }
});

test('an actual provider failure still pauses the queue and reports the error', async t => {
  const f = await fixture(t), receive = f.actual.testLiveHandler();
  receive(null, { tabId: 'T', busy: false, reason: 'codex-no-final-result', outcomeTs: Date.now() + 10 });
  assert.equal(f.state().getQueue('T').autoRun, false);
  assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0][1], 'warning');
  assert.ok(f.item()); assert.equal(f.sends.length, 0);
});

test('Main Stop-start aborts a held Resume preparation before the final idle event without changing queue policy', async t => {
  const f = await fixture(t), hold = f.hold('prepare-runtime');
  f.ports.runtime.getPresence = async () => ({ status: 'inactive', inputReady: false, sessionId: 'A' });
  f.fire(); await hold.entered.promise;
  const before = JSON.stringify(f.state().getQueue('T'));
  f.actual.handleQueueAgentStopping(null, { tabId: 'T', toolType: 'claude', stopping: true, reason: 'manual-stop' });
  assert.equal(f.preparations[0].admissionSignal.aborted, false, 'foreign owner cannot revoke this preparation');
  f.actual.handleQueueAgentStopping(null, { tabId: 'T', toolType: 'codex', stopping: true, reason: 'manual-stop' });
  await f.settle();
  assert.equal(f.preparations[0].admissionSignal.aborted, true);
  assert.equal(JSON.stringify(f.state().getQueue('T')), before);
  assert.equal(f.sends.length, 0); assert.equal(f.toasts.length, 0);
});

test('intermediate abort or late completion during an accepted manual Stop cannot pause or advance Run After', async t => {
  for (const reason of ['turn_aborted', 'error', 'task_complete']) {
    const f = await fixture(t), receive = f.actual.testLiveHandler(), before = JSON.stringify(f.state().getQueue('T'));
    receive(null, { tabId: 'T', busy: true, reason: 'task_started' });
    f.actual.handleQueueAgentStopping(null, { tabId: 'T', toolType: 'codex', stopping: true, reason: 'manual-stop' });
    receive(null, { tabId: 'T', busy: false, reason, outcomeTs: Date.now() + 10 });
    await f.settle();
    assert.equal(JSON.stringify(f.state().getQueue('T')), before, reason);
    assert.equal(f.sends.length, 0); assert.equal(f.toasts.length, 0);
    f.actual.handleQueueAgentStopping(null, { tabId: 'T', toolType: 'codex', stopping: false, reason: 'manual-stop' });
    receive(null, { tabId: 'T', busy: false, reason: 'manual-stop', outcomeTs: Date.now() + 10 });
    receive(null, { tabId: 'T', busy: true, reason: 'task_started' });
    receive(null, { tabId: 'T', busy: false, reason: 'task_complete', outcomeTs: Date.now() + 100 });
    await f.settle(); assert.equal(f.sends.length, 1);
  }
});

test('after-restart still enters the actual common Resume/send path after manual Stop, not before the next Main', async t => {
  const f = await fixture(t), receive = f.actual.testLiveHandler(), evaluate = f.actual.testColdScheduler();
  f.actual.testAppInstance('main-A', Date.now() - 100);
  f.state().setPromptTrigger('T', f.id, { kind: 'app-restart', armedInstanceId: 'main-A' });
  receive(null, { tabId: 'T', busy: false, reason: 'manual-stop', outcomeTs: Date.now() });
  evaluate(); await f.settle(); assert.equal(f.sends.length, 0);
  f.ports.runtime.getPresence = async () => ({ status: 'inactive', inputReady: false, sessionId: 'A' });
  f.actual.testAppInstance('main-B', Date.now()); evaluate(); await f.settle();
  assert.equal(f.preparations.length, 1, 'stopped owner uses the existing common lifecycle preparer');
  assert.equal(f.preparations[0].sessionId, 'A');
  assert.equal(f.sends.length, 1); assert.equal(f.item(), undefined); assert.equal(f.toasts.length, 0);
});

test('manual Stop is quiet for Claude and Gemini too; native onTab dependency survives and fires only on success', async t => {
  for (const provider of ['claude', 'gemini']) {
    const f = await fixture(t), tab = f.ports.workspace.openProjects.get('P').tabs.get('T');
    tab.commandType = provider; tab.claudeSessionId = 'A';
    const receive = f.actual.testLiveHandler(provider), before = JSON.stringify(f.state().getQueue('T'));
    receive(null, { tabId: 'T', busy: false, reason: 'manual-stop', outcomeTs: Date.now() + 10 });
    assert.equal(JSON.stringify(f.state().getQueue('T')), before); assert.equal(f.toasts.length, 0);
  }
  const f = await fixture(t), receive = f.actual.testLiveHandler(), s = f.state();
  s.setAutoRun('T', false);
  f.ports.workspace.openProjects.get('P').tabs.set('U', { id: 'U', commandType: 'codex', codexSessionId: 'A' });
  const item = s.addPrompt('U', 'AFTER T', 0); s.setRunAfterTab('U', 'T');
  receive(null, { tabId: 'T', busy: false, reason: 'manual-stop', outcomeTs: Date.now() });
  await f.settle(); assert.equal(f.sends.length, 0); assert.equal(f.state().getQueue('U').autoRun, true);
  receive(null, { tabId: 'T', busy: true, reason: 'task_started' });
  receive(null, { tabId: 'T', busy: false, reason: 'task_complete', outcomeTs: Date.now() + 100 });
  await f.settle(); assert.equal(f.sends.length, 1);
  assert.equal(f.state().getQueue('U').items.some(x => x.id === item), false);
});

test('a stale Stop snapshot cannot revoke a newly prepared send', async t => {
  const f = await fixture(t), hold = f.hold('readiness');
  f.fire(); await hold.entered.promise;
  f.actual.applyAbnormalQueueOutcome({ tabId: 'T', busy: false, reason: 'manual-stop', outcomeTs: 1 }, 'codex-state-resolved-abnormal');
  hold.release.resolve(); await f.settle(); assert.equal(f.sends.length, 1);
});

test('the original timer deadline survives Stop and then resumes the stopped owner once', async t => {
  for (const kind of ['legacy', 'item']) {
    const f = await fixture(t), receive = f.actual.testLiveHandler(), scheduler = f.actual.testColdScheduler();
    if (kind === 'item') f.state().setPromptTrigger('T', f.id, { kind: 'timer', seconds: 60 });
    else f.state().setFirstDelaySeconds('T', 60);
    f.state().startFirstDelayCountdown('T');
    const startedAt = f.state().getQueue('T').firstDelayCountdownAt;
    receive(null, { tabId: 'T', busy: false, reason: 'manual-stop', outcomeTs: Date.now() });
    assert.equal(f.state().getQueue('T').firstDelayCountdownAt, startedAt);
    f.ports.runtime.getPresence = async () => ({ status: 'inactive', inputReady: false, sessionId: 'A' });
    vm.runInContext('Date.now = () => ' + (startedAt + 60_001), f.context);
    scheduler.deadline('T'); await f.settle();
    assert.equal(f.preparations.length, 1, kind); assert.equal(f.sends.length, 1, kind);
    assert.equal(f.item(), undefined); assert.equal(f.toasts.length, 0);
  }
});

test('actual Main Stop-start handler retires an AutoCompact observer without pausing the retained queue', async t => {
  const f = await fixture(t), failed = [], hold = barrier();
  const coordinator = createAutoCompactCoordinator({
    startedAt: 0, policy: () => ({ enabled: true, armedAt: 1, workflowIds: ['W'], excludedTabIds: [], percent: 50 }),
    target: () => ({ tabId: 'T', sessionId: 'A', provider: 'codex', workflowId: 'W' }), blocked: () => false,
    readiness: async () => ({ ready: true, status: 'active' }),
    context: async () => ({ exact: true, sessionId: 'A', pct: 70, observedAt: 100 }),
    compact: () => hold.promise, activity() {}, trace() {},
    failure: () => { failed.push('failed'); f.state().setAutoRun('T', false); },
    release: () => failed.push('released'),
  });
  f.actual.testCoordinator(coordinator);
  coordinator.intercept('T', { at: 100, turnStartedAt: 10, live: true, natural: true }, () => failed.push('continued'));
  await turn(); assert.equal(coordinator.has('T'), true);
  f.actual.handleQueueAgentStopping(null, { tabId: 'T', toolType: 'codex', stopping: true, reason: 'manual-stop' });
  assert.equal(coordinator.has('T'), false);
  hold.resolve(); await turn(); assert.deepEqual(failed, []);
  assert.equal(f.state().getQueue('T').autoRun, true); assert.equal(f.sends.length, 0);
  const source = fs.readFileSync(runnerPath, 'utf8');
  assert.match(source, /ipcRenderer\.on\('agent:stopping-state', handleQueueAgentStopping\)/);
  assert.match(source, /ipcRenderer\.removeListener\('agent:stopping-state', handleQueueAgentStopping\)/);
});

test('F2 actual onTab callback/store arms only the current enabled head, not disabled/later cards', async t => {
  for (const position of ['head', 'later', 'disabled']) {
    const f = await fixture(t), state = f.state();
    const second = state.addPrompt('T', 'SECOND', 0);
    state.setAutoRun('T', false);
    const edited = position === 'head' ? f.id : second;
    if (position === 'disabled') state.updatePrompt('T', edited, { enabled: false });
    const helperStart = overlay.indexOf('const armRunAfterForSchedulingIfBusy =');
    const helperEnd = overlay.indexOf('\n\n', helperStart);
    const source = overlay.slice(helperStart, helperEnd) + '\nglobalThis.pick=' + findArrow('setRunAfterTab', s => s.includes('armRunAfterForSchedulingIfBusy')) + ';';
    const context = vm.createContext({ useCallback: fn => fn, tabId: 'T', agentBusy: false,
      usePromptQueueStore: f.actual.usePromptQueueStore, isQueuedPromptEnabled: f.actual.isQueuedPromptEnabled,
      shouldArmQueueForTrigger: f.actual.shouldArmQueueForTrigger,
      setAutoRun: state.setAutoRun, setPromptTrigger: state.setPromptTrigger, it: { id: edited },
      legacyDependency: false, triggerKind: 'onTab', setOnTabTriggerDraftIds() {} });
    vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    context.pick('T', 'dependency');
    assert.equal(state.getQueue('T').autoRun, position === 'head', position);
    assert.equal(state.getQueue('T').items.length, 2);
  }
});

test('F2 actual timer commit callback does not arm a paused queue', async t => {
  const f = await fixture(t); f.state().setAutoRun('T', false);
  const source = 'globalThis.commit=' + findArrow('onCommit', s => s.includes('setTimerTriggerDraftIds')) + ';';
  const context = vm.createContext({ it: { id: f.id }, setTimerTriggerDraftIds: fn => fn(new Set([f.id])),
    armRunAfterForSchedulingIfBusy: () => assert.fail('timer edit is not Play') });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.commit(); assert.equal(f.state().getQueue('T').autoRun, false);
});

for (const boundary of ['readiness', 'work-context', 'persistence']) test('F3 A90→B20 at ' + boundary + ' rereads B and retains the item without enqueue', async t => {
  const f = await fixture(t);
  f.state().setPromptCondition('T', f.id, { kind: 'context-used', operator: 'gte', percent: 50 });
  const h = f.hold(boundary); assert.equal(f.fire(), true);
  await h.entered.promise; f.owner('B', 20); h.release.resolve(); await f.settle();
  assert.equal(f.sends.length, 0);
  assert.equal(f.state().getQueue('T').items.length, 1);
  assert.ok(f.reads.some(r => r.sessionId === 'A') && f.reads.some(r => r.sessionId === 'B'));
  assert.equal(f.state().getQueue('T').pendingDelivery, null);
});

test('F3 A90→B80 uses B proof in the actual agentScenarios enqueue request', async t => {
  const f = await fixture(t);
  f.state().setPromptCondition('T', f.id, { kind: 'context-used', operator: 'gte', percent: 50 });
  const h = f.hold('readiness'); f.fire(); await h.entered.promise;
  f.owner('B', 80); h.release.resolve(); await f.settle();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].sessionId, 'B');
  assert.equal(f.sends[0].promptQueueIntent.contextProof.sessionId, 'B');
  assert.equal(f.sends[0].promptQueueIntent.contextProof.pct, 80);
  assert.equal(f.state().getQueue('T').items.length, 0);
});

for (const result of [{}, { success: null, submitted: null, deliveryUnknown: true },
  { success: false, submitted: false, pasteWritten: true }]) test('F4 actual unknown result retains same item/pointer, Pause/Play cannot re-enqueue: ' + JSON.stringify(result), async t => {
  const f = await fixture(t); f.setResult(result); f.fire(); await f.settle();
  const q = f.state().getQueue('T'), pointer = q.pendingDelivery;
  assert.ok(pointer); assert.equal(q.items.length, 1); assert.equal(q.autoRun, false);
  assert.equal(f.cancelled.length, 0); assert.equal(f.contextSettles.length, 0);
  assert.equal(f.saved[0].T.pendingDelivery.handoffId, f.sends[0].handoffId, 'pointer ACK precedes enqueue');
  f.state().setAutoRun('T', true); assert.equal(f.fire(), false); await f.settle();
  assert.equal(f.sends.length, 1); assert.equal(q.pendingDelivery.handoffId, pointer.handoffId);
  f.setReceipt({ tabId: 'T', handoffId: pointer.handoffId, operationKey: pointer.operationKey,
    state: 'confirmed', attemptId: 'original-attempt', receipt: { success: true, submitted: true } });
  assert.equal(await f.actual.reconcilePromptQueuePendingDelivery('T'), true);
  assert.equal(f.state().getQueue('T').items.length, 0); assert.equal(f.state().getQueue('T').pendingDelivery, null);
  assert.equal(f.sends.length, 1);
});

test('F4 proven refusal keeps card without an unknown pointer; submitted audit timeout consumes once', async t => {
  for (const [value, remaining] of [[{ success: false, submitted: false, pasteWritten: false }, 1],
    [{ success: false, submitted: true, deliveryUnknown: true, status: 'delivery-unknown' }, 0]]) {
    const f = await fixture(t); f.setResult(value); f.fire(); await f.settle();
    assert.equal(f.state().getQueue('T').items.length, remaining); assert.equal(f.state().getQueue('T').pendingDelivery, null);
  }
});

test('a retained never-entered /compact does not create an unknown Send pointer that has no receipt', async t => {
  const f = await fixture(t);
  f.state().updatePrompt('T', f.id, { text: '/compact' });
  let localCalls = 0;
  f.ports.runtime.sendPrompt = async () => { localCalls++; return {
    localSlashCommand: true, success: false, submitted: false, pasteWritten: true, enterWritten: false,
    slashInserted: true, slashRollback: { serviceInputPending: true }, error: 'input frame timeout',
  }; };
  f.fire(); await f.settle();
  assert.equal(localCalls, 1);
  const q = f.state().getQueue('T');
  assert.equal(q.items.length, 1); assert.equal(q.autoRun, false); assert.equal(q.pendingDelivery, null);
});

test('F4 actual agentScenarios lost admission ACK normalizes to unknown, not a failed/not-submitted card', async t => {
  const f = await fixture(t); f.setResult(new Error('private lost admission ACK'));
  f.fire(); await f.settle();
  const queue = f.state().getQueue('T');
  assert.equal(queue.items.length, 1); assert.equal(queue.autoRun, false);
  assert.equal(queue.pendingDelivery.handoffId, f.sends[0].handoffId);
  assert.equal(queue.pendingDelivery.operationKey, 'history:T:' + f.sends[0].handoffId);
  assert.equal(f.cancelled.length, 0); assert.equal(f.contextSettles.length, 0);
});

test('F4 same-operation receipt does not remove a newer edited card', async t => {
  const f = await fixture(t); f.setResult({}); f.fire(); await f.settle();
  const pointer = f.state().getQueue('T').pendingDelivery;
  f.state().updatePrompt('T', f.id, { text: 'NEWER' });
  f.setReceipt({ tabId: 'T', handoffId: pointer.handoffId, operationKey: pointer.operationKey,
    state: 'confirmed', attemptId: 'original', receipt: { submitted: true } });
  await f.actual.reconcilePromptQueuePendingDelivery('T');
  assert.equal(f.state().getQueue('T').items[0].text, 'NEWER'); assert.equal(f.sends.length, 1);
});

test('F4 actual store persists/restores unknown pointer with original IDs and no automatic arm', async t => {
  const f = await fixture(t); f.setResult({}); f.fire(); await f.settle();
  await f.actual.persistPromptQueueDeliveryPointer();
  const saved = f.saved.at(-1).T;
  assert.equal(saved.autoRun, false); assert.equal(saved.pendingDelivery.handoffId, f.sends[0].handoffId);
  const restored = await fixture(t, { ...saved, autoRun: true });
  assert.equal(restored.state().getQueue('T').autoRun, false);
  assert.equal(restored.state().getQueue('T').pendingDelivery.handoffId, saved.pendingDelivery.handoffId);
  assert.equal(restored.fire(), false); await restored.settle(); assert.equal(restored.sends.length, 0);
  f.state().clearQueue('T'); assert.equal(f.state().getQueue('T').pendingDelivery.handoffId, saved.pendingDelivery.handoffId);
  assert.equal(f.state().getQueue('T').items.length, 0, 'explicit clear removes authoring, not unknown receipt identity');
});

test('context null/string stay unavailable; numeric zero is valid exact context, not coercion', async t => {
  for (const pct of [null, '0', 0]) {
    const f = await fixture(t); f.owner('A', pct);
    f.state().setPromptCondition('T', f.id, { kind: 'context-used', operator: 'lte', percent: 1 });
    f.fire(); await f.settle(); assert.equal(f.sends.length, pct === 0 ? 1 : 0);
  }
});

test('metaAction readiness lease rejects Restart→Stop replacement of the same card', async t => {
  const f = await fixture(t); f.state().clearQueue('T');
  const id = f.state().addMetaAction('T', { kind: 'restart' }); f.state().setAutoRun('T', true);
  const h = f.hold('readiness'); f.actual.beginConditionAwareQueueSend('T', 'T', f.state().getQueue('T').items[0], 'cold-start');
  await h.entered.promise;
  f.state().updateMetaAction('T', id, { kind: 'stop' }); h.release.resolve(); await f.settle();
  assert.equal(f.state().getQueue('T').items[0].metaAction.kind, 'stop');
  assert.equal(f.sends.length, 0); assert.equal(f.rewinds.length, 0);
});

test('queued Rewind uses the current view/session executor port; stored source is provenance, not a stale execution target', async t => {
  const f = await fixture(t); f.owner('B', 70);
  f.state().clearQueue('T'); f.state().addMetaAction('T', { kind: 'rewind', toolType: 'codex',
    targetUuid: 'selected-uuid', targetText: 'original', sourceSessionId: 'A', targetIteration: 12 });
  f.state().setAutoRun('T', true);
  f.actual.beginConditionAwareQueueSend('T', 'T', f.state().getQueue('T').items[0], 'cold-start'); await f.settle();
  assert.equal(f.rewinds[0].sessionId, 'B'); assert.equal(f.rewinds[0].target.uuid, 'selected-uuid');
  assert.equal(f.state().getQueue('T').items.length, 0);
});

test('AutoCompact Root target follows Main membership, never project aliases or selected workflow', async t => {
  const f = await fixture(t);
  f.ports.workspace.organizationReady = true;
  f.ports.workspace.spaces = [{ id: 'old-project-workflow', projectIds: ['P'] }];
  f.ports.workspace.tabWorkflowMembership = { T: { tabId: 'T', workflowId: 'exact-new-workflow', revision: 8 } };
  assert.equal(f.actual.getAutoCompactTarget('T').workflowId, 'exact-new-workflow');
  const imported = { allWorkflows: true, excludedTabIds: [], workflowIds: [], includeUnplaced: true,
    migrationEligibility: { T: { workflowId: 'exact-new-workflow', membershipRevision: 8, included: false } } };
  assert.equal(f.actual.getAutoCompactTarget('T').membershipRevision, 8);
  assert.equal(autoCompactIncludesTarget(imported, f.actual.getAutoCompactTarget('T')), false,
    'canonical target must preserve the exact imported exclusion, not broaden automation at cutover');
  f.ports.workspace.tabWorkflowMembership = {};
  assert.equal(f.actual.getAutoCompactTarget('T').workflowId, '__unplaced__');
});

test('actual Root cancellation reaches the same coordinator task ID and refuses a replacement/submitting task', async t => {
  const f = await fixture(t), activities = [], policy = { enabled: true, armedAt: 1, scopeInitialized: true,
    allWorkflows: true, workflowIds: [], includeUnplaced: true, excludedTabIds: [], percent: 50 };
  let blocked = true, compactGate = null;
  const coordinator = createAutoCompactCoordinator({ startedAt: 0, policy: () => policy,
    target: () => ({ tabId: 'T', provider: 'codex', sessionId: 'A', workflowId: 'W' }),
    blocked: () => blocked, readiness: async () => ({ ready: true, status: 'active' }),
    context: async () => ({ exact: true, sessionId: 'A', pct: 80, observedAt: Date.now() }),
    compact: async () => { if (compactGate) { compactGate.entered.resolve(); await compactGate.release.promise; } },
    failure() {}, activity: (_tab, value) => { if (value) activities.push(value); } });
  f.actual.testCoordinator(coordinator); t.after(() => coordinator.dispose());
  const a = coordinator.request('T'); const idA = activities.at(-1).handoffId;
  assert.equal(f.actual.cancelPendingAutoCompact('T', 'foreign'), false);
  assert.equal(f.actual.cancelPendingAutoCompact('T', idA), true); await a;
  const b = coordinator.request('T'); const idB = activities.at(-1).handoffId;
  assert.notEqual(idA, idB); assert.equal(f.actual.cancelPendingAutoCompact('T', idA), false);
  assert.equal(f.actual.cancelPendingAutoCompact('T', idB), true); await b;
  blocked = false; compactGate = { entered: barrier(), release: barrier() };
  const c = coordinator.request('T'); await compactGate.entered.promise;
  assert.equal(f.actual.cancelPendingAutoCompact('T', activities.at(-1).handoffId), false);
  compactGate.release.resolve(); await c;
});
