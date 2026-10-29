'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const esbuild = require('esbuild'), ts = require('typescript');
const { messageWaitBlocks } = require('../../shared/message-loop-waits.cjs');
const { loopPromptMode } = require('../../shared/loop-dependencies.cjs');
const file = path.resolve(__dirname, '../hooks/usePromptQueueRunner.ts');
const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
function named(name) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast);
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = 'const ' + node.getText(ast) + ';';
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(found, name);
  return ts.transpileModule(found, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const entry = (id = 'Q', state = 'waiting') => ({ id, source: { tabId: 'P' }, state });
const queue = () => ({ loopPromptEnabled: true, loopPromptMode: 'all-work' });

test('actual hydration keeps newer message events, restores unrelated dependencies, and unknown never means an empty inventory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-wait-ui-')), out = path.join(root, 'client.cjs');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'messageLoopWaits.mjs')], outfile: out,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  let resolve, reject, changed;
  global.window = { require: () => ({ ipcRenderer: { on: (_channel, cb) => { changed = cb; },
    invoke: () => new Promise((yes, no) => { resolve = yes; reject = no; }) } }) };
  t.after(() => { delete global.window; fs.rmSync(root, { force: true, recursive: true }); });
  const client = require(out), q = queue();
  assert.equal(client.messageLoopWaitsBlock('P', q), true);
  assert.equal(client.messageLoopWaitsBlock('P', { ...q, loopPromptMode: 'own-turn' }), false);
  let init = client.initializeMessageLoopWaits(); reject(Error('snapshot unavailable')); await assert.rejects(init);
  assert.equal(client.messageLoopWaitsBlock('P', q), true);
  init = client.initializeMessageLoopWaits(); changed(null, { entry: entry('Q', 'settled'), revision: 3 });
  resolve({ version: 1, known: true, revision: 2, entries: [entry('Q'), { ...entry('other'), source: { tabId: 'other' } }] });
  await init; assert.equal(client.messageLoopWaitsBlock('P', q), false);
  assert.equal(client.messageLoopWaitsBlock('other', q), true);
  changed(null, { entry: entry('Q'), revision: 1 }); assert.equal(client.messageLoopWaitsBlock('P', q), false);
});

function runner() {
  const q = queue(), waits = [entry()], causes = new Map([['P', { provider: 'codex', sessionId: 'S', turnId: 'parent', outcomeTs: 10 }]]);
  const calls = [], latest = new Map([['P', 'natural:parent']]);
  const c = vm.createContext({ loopPromptMode, isLoopPromptActive: queue => queue.loopPromptEnabled,
    usePromptQueueStore: { getState: () => ({ getQueue: () => q }) }, getLoopPrompt: () => q.loopPromptEnabled ? { id: 'loop' } : null,
    messageLoopWaitsBlock: (id, _q, cause) => waits.some(entry => messageWaitBlocks(entry, id, cause)),
    hasPriorWorkflowInput: () => c.fifoHeld, promptTabTriggerReady: () => false,
    capacityWorkflowBlocked: () => false, // no capacity outcome in the question-owner fixture
    queueShutdownPending: false, queueManualStopping: new Set(), autoCompactCoordinator: null,
    prevBusyRef: new Map([['P', false]]), isOrchestrationCompletionBlocked: () => c.installHeld,
    isLoopOrchestrationBlocked: () => false, loopDependenciesBlock: () => false,
    loopNaturalCausesByOwner: causes, latestLoopCauseByOwner: latest, queueSendInflight: new Set(),
    useWorkspaceStore: { getState: () => ({ openProjects: new Map([['P', { tabs: new Map([['P', {}]]) }]]) }) },
    hasPendingAgentGoalWork: () => c.goalHeld,
    canProcessWorkflowOutcomes: () => true,
    // Existing sender remains a controlled leaf. Its synchronous inflight
    // admission and consumed cause are the signals this new listener uses.
    beginValidatedQueueSend: (...args) => { c.queueSendInflight.add('P'); calls.push(args); return true; } });
  vm.runInContext(named('isTabWorkflowBlocked') + named('fireLoopOwner') + named('releaseMessageLoop')
    + '\nglobalThis.release=releaseMessageLoop;', c);
  return { q, c, waits, causes, calls, latest, release: () => c.release({ source: { tabId: 'P' } }),
    processed: () => { waits[0] = { ...entry('Q', 'settled'), settlement: { kind: 'reply-delivered' } }; } };
}
test('actual message listener synthesizes no natural cause on delivery; existing inflight/consumed guards admit once', () => {
  const h = runner(); h.release(); assert.equal(h.calls.length, 0);
  h.waits[0].state = 'returning'; h.release(); assert.equal(h.calls.length, 0);
  h.processed(); h.latest.delete('P'); h.release(); assert.equal(h.calls.length, 0, 'delivery does not invent a natural cause');
  h.causes.set('P', { provider: 'codex', sessionId: 'S', turnId: 'reply', outcomeTs: 20 }); h.latest.set('P', 'natural:reply');
  h.release(); h.release(); assert.equal(h.calls.length, 1, 'duplicate changed/hydration cannot prepare twice while inflight');
  h.c.queueSendInflight.clear(); h.latest.delete('P'); h.release(); assert.equal(h.calls.length, 1, 'consumed natural cause cannot wake again');
});
for (const guard of ['queueShutdownPending', 'manual-stop', 'fifoHeld', 'installHeld', 'goalHeld', 'busy', 'pause', 'own-turn']) {
  test('new release retains ' + guard + ' admission', () => {
    const h = runner(); h.processed(); h.causes.set('P', { provider: 'codex', sessionId: 'S', turnId: 'reply', outcomeTs: 20 });
    if (guard === 'manual-stop') h.c.queueManualStopping.add('P');
    else if (guard === 'busy') h.c.prevBusyRef.set('P', true);
    else if (guard === 'pause') h.q.loopPromptEnabled = false;
    else if (guard === 'own-turn') h.q.loopPromptMode = 'own-turn';
    else h.c[guard] = true;
    h.release(); assert.equal(h.calls.length, 0);
  });
}
