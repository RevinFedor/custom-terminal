'use strict';
// Production admission/runner functions; runtime, UI store and PTY are leaves.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const ts = require('typescript');
const policy = require('../shared/loop-dependencies.cjs');
function functionText(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  return ts.transpileModule(node.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function backend() {
  const q = { loopPromptEnabled: true, loopPromptMode: 'all-work', loopPromptEpoch: 'E', pendingDelivery: {
    kind: 'loop', loopPromptMode: 'all-work', loopEpoch: 'E', handoffId: 'H',
    loopCause: { provider: 'codex', sessionId: 'S', turnId: 'T', inputBoundary: 'input-A' } } };
  const inspection = { known: true, busy: false, transitioning: false, revision: 'R', sessionId: 'S',
    toolType: 'codex', loopInputBoundary: 'input-A', backgroundWorkCount: 0, turn: { status: 'completed', turnId: 'T' } };
  const control = { blocked: true, afterRuntime: null };
  const service = { reconcile: async () => {}, blocks: () => control.blocked,
    admission: () => !control.blocked, revision: () => 1 };
  const c = vm.createContext({ ...policy, loopNaturalEvidence: new Map(),
    acceptedReplyInputPending: () => false, // This baseline has no accepted return reservation; real SQL case is in message-outcome-fifo.
    readPersistedLoopQueue: () => q, captureTabInspection: () => ({ ...inspection }),
    getLoopDependencies: () => ({ reconcile: async () => {}, blocks: () => false, readyWake: () => null }),
    getMessageLoopWaits: () => service, messageLoopAdmission: () => !control.blocked,
    getOrchestrationRunStore: () => ({ listForTab: async () => [] }),
    coherentPublicRuntimeSnapshot: async () => { control.afterRuntime?.(); return { status: 'active', inputReady: true }; },
    readAutomaticSendFrame: () => ({ ready: true }), agentSendQueue: { notifyRuntime() {} } });
  vm.runInContext(functionText(path.join(__dirname, 'web-server.js'), 'loopSendAdmission') + '\nglobalThis.admit=loopSendAdmission;', c);
  return { q, inspection, control, admit: () => c.admit({ tabId: 'P', handoffId: 'H', provider: 'codex' }) };
}
function renderer() {
  const q = { loopPromptEnabled: true, loopPromptMode: 'all-work' };
  const control = { blocked: true };
  const c = vm.createContext({ ...policy, hasPriorWorkflowInput: () => false,
    capacityWorkflowBlocked: () => false, // independent capacity owner has no fact here
    promptTabTriggerReady: () => false, queueShutdownPending: false, queueManualStopping: new Set(),
    autoCompactCoordinator: null, prevBusyRef: new Map(), isOrchestrationCompletionBlocked: () => false,
    isLoopOrchestrationBlocked: () => false, loopDependenciesBlock: () => false,
    messageLoopWaitsBlock: () => control.blocked, loopNaturalCausesByOwner: new Map(),
    usePromptQueueStore: { getState: () => ({ getQueue: () => q }) },
    useWorkspaceStore: { getState: () => ({ openProjects: new Map() }) }, hasPendingAgentGoalWork: () => false });
  vm.runInContext(functionText(path.join(__dirname, '../renderer/hooks/usePromptQueueRunner.ts'), 'isTabWorkflowBlocked')
    + '\nglobalThis.blocked=isTabWorkflowBlocked;', c);
  return { q, control, blocked: kind => c.blocked('P', null, kind) };
}
test('actual ordinary Main admission waits for own question even without runs or a purple loader', async () => {
  const h = backend(); assert.equal(await h.admit(), false, 'Q-only hold waits without permanently cancelling H/O');
  assert.equal(h.q.loopPromptEnabled, true);
  h.control.blocked = false; assert.equal(await h.admit(), true);
});
test('actual App runner blocks ordinary Loop for an outgoing question, not manual queue or own-turn mode', () => {
  const h = renderer(); assert.equal(h.blocked('loop'), true);
  assert.equal(h.blocked('queue'), false);
  h.q.loopPromptMode = 'own-turn'; assert.equal(h.blocked('loop'), false);
  h.q.loopPromptMode = 'all-work'; h.control.blocked = false; assert.equal(h.blocked('loop'), false);
});
test('new question accepted during readiness await still closes the final Main admission', async () => {
  const h = backend(); h.control.blocked = false;
  h.control.afterRuntime = () => { h.control.blocked = true; };
  assert.notEqual(await h.admit(), true);
});
test('delivery-contract: completed exchange cannot reuse a natural cause predating another canonical input', async () => {
  const h = backend(); h.control.blocked = false; h.inspection.loopInputBoundary = 'input-B';
  const result = await h.admit(); assert.equal(result.cancel, true); assert.equal(result.reason, 'loop-input-changed');
});
test('delivery-contract: canonical input during HEAD await invalidates the old cause even without a busy edge', async () => {
  const h = backend(); h.control.blocked = false;
  h.control.afterRuntime = () => { h.inspection.loopInputBoundary = 'input-B'; };
  const result = await h.admit(); assert.equal(result.cancel, true);
});
test('delivery-contract: unknown cause boundary is not current input authority', async () => {
  const h = backend(); h.control.blocked = false; delete h.q.pendingDelivery.loopCause.inputBoundary;
  assert.notEqual(await h.admit(), true);
});
test('actual pre-paste Main refusal retires only the stale Root cause without Loop OFF, replay or unknown clearance', () => {
  function findIf(file, needle) {
    const text = fs.readFileSync(file, 'utf8'), tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let found;
    function visit(node) {
      if (ts.isIfStatement(node) && node.expression.getText(tree).includes(needle)) found = node.getText(tree);
      ts.forEachChild(node, visit);
    }
    visit(tree); assert.ok(found, needle); return found;
  }
  const beforePaste = findIf(path.join(__dirname, 'main.js'), "admission.reason === 'loop-input-changed'");
  const main = vm.createContext({});
  vm.runInContext('globalThis.refuse = admission => { ' + beforePaste + ' };', main);
  const refused = main.refuse({ cancel: true, reason: 'loop-input-changed' });
  assert.equal(refused.submitted, false); assert.equal(refused.pasteWritten, false); assert.equal(refused.enterWritten, false);
  assert.equal(refused.deferred, true); assert.equal(refused.causeInvalidated, true);
  const branch = findIf(path.join(__dirname, '../renderer/hooks/usePromptQueueRunner.ts'), "res?.deferred === true");
  for (const unknown of [false, true]) {
    const causes = new Map([['P', 'natural:parent']]), actions = [];
    const c = vm.createContext({ res: unknown ? { ...refused, submitted: null, enterWritten: null } : refused,
      ownerTabId: 'P', handoffId: 'H', kind: 'loop', label: 'Loop', attempt: { causeKey: 'natural:parent' },
      latestLoopCauseByOwner: causes, console: { log() {} },
      retractHistoryPromptHandoff: (...args) => actions.push(['retract', ...args]),
      clearDeferredOwnerAttempt: (...args) => actions.push(['clear', ...args]) });
    vm.runInContext('(function () { ' + branch + ' })()', c);
    assert.equal(causes.has('P'), unknown);
    assert.equal(actions.filter(row => row[0] === 'clear').length, unknown ? 0 : 1);
    assert.equal(actions.some(row => /OFF|send|stop/.test(String(row[0]))), false);
  }
});
module.exports = { functionText };
