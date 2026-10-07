const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const ts = require('typescript');
let source;
test.before(async () => {
  const build = await esbuild.build({ entryPoints: [path.join(__dirname, 'usePromptQueueStore.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' });
  source = build.outputFiles[0].text;
});
async function fixture(persisted = new Map()) {
  let now = 1000, nextTimer = 0;
  const timers = new Map(), writes = [];
  class Clock extends Date { static now() { return now; } }
  const module = { exports: {} };
  const ipcRenderer = {
    on() {}, removeListener() {},
    async invoke(channel, value) {
      if (channel === 'ai-prompts:get') return { success: true, data: [{ id: 'run-after-loop', content: 'fixture loop' }] };
      if (channel === 'app:getState') return persisted.get(value);
      if (channel === 'ai-prompts:save-content') return { success: true };
      if (channel === 'app:setState') { writes.push(value); persisted.set(value.key, value.value); return { success: true }; }
      throw Error('unexpected IPC: ' + channel);
    },
    sendSync(channel, value) { writes.push(value); persisted.set(value.key, value.value); return { success: true }; },
  };
  const context = vm.createContext({ module, exports: module.exports, require, process, console,
    window: { require: () => ({ ipcRenderer }) }, Date: Clock,
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source, context);
  await module.exports.hydratePromptQueueStore();
  return { ...module.exports, persisted, writes, context,
    now: value => { now = value; }, store: () => module.exports.usePromptQueueStore.getState() };
}

test('unknown context never satisfies <=50 or >=0; actual numeric zero remains exact zero', async () => {
  const f = await fixture(), condition = percent => ({ kind: 'context-used', operator: 'gte', percent });
  for (const unknown of [null, undefined, NaN, '', '0', false, {}, Infinity]) {
    assert.equal(f.queuedPromptContextConditionMatches(condition(0), unknown), false, String(unknown));
    assert.equal(f.queuedPromptContextConditionMatches({ ...condition(50), operator: 'lte' }, unknown), false, String(unknown));
  }
  assert.equal(f.queuedPromptContextConditionMatches(condition(0), 0), true);
  assert.equal(f.queuedPromptContextConditionMatches({ ...condition(50), operator: 'lte' }, 0), true);
  assert.equal(f.queuedPromptContextConditionMatches(undefined, null), true);
});

test('actual exact-context runner reader rejects null even with a malformed exact=true response', async () => {
  const text = fs.readFileSync(path.join(__dirname, '../hooks/usePromptQueueRunner.ts'), 'utf8');
  const tree = ts.createSourceFile('runner.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'readExactQueueContextUsedPct');
  let result = { exact: true, pct: null, provider: 'codex', sessionId: 'S' }, sessionId = 'S'; const calls = [];
  const context = vm.createContext({ getPromptQueueAgent: () => 'codex', getPromptQueueSessionId: () => sessionId,
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return result; } } });
  vm.runInContext(ts.transpileModule(node.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.equal((await context.readExactQueueContextUsedPct('T')).pct, null);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['tab:get-context-pct', { tabId: 'T', provider: 'codex', sessionId: 'S', requireExact: true }]);
  result = { ...result, pct: 0 }; assert.equal((await context.readExactQueueContextUsedPct('T')).pct, 0);
  result = { ...result, provider: 'claude' }; assert.equal((await context.readExactQueueContextUsedPct('T')).pct, null);
  result = { ...result, provider: 'codex', sessionId: 'old' }; assert.equal((await context.readExactQueueContextUsedPct('T')).pct, null);
  result = { ...result, sessionId: 'S', exact: false, pct: 95 }; assert.equal((await context.readExactQueueContextUsedPct('T')).pct, null);
  result = { ...result, exact: true };
  context.ipcRenderer.invoke = async () => { sessionId = 'new'; return result; };
  assert.equal((await context.readExactQueueContextUsedPct('T')).reason, 'context-owner-changed');
});

test('remote setAutoRun(false) freezes the existing legacy countdown and survives a new store', async () => {
  const f = await fixture(), s = f.store();
  s.addPrompt('T', 'next'); s.setFirstDelaySeconds('T', 100); s.setAutoRun('T', true); s.startFirstDelayCountdown('T');
  f.now(41000); s.setAutoRun('T', false);
  assert.equal(s.getQueue('T').firstDelaySeconds, 60); assert.equal(s.getQueue('T').firstDelayCountdownAt, null);
  f.flushPromptQueueStoreSync();
  const restored = await fixture(f.persisted), q = restored.store().getQueue('T');
  assert.equal(q.autoRun, false); assert.equal(q.firstDelayCountdownAt, null);
  assert.equal(q.items[0].trigger?.seconds ?? q.firstDelaySeconds, 60);
});

test('pause freezes enabled-head item timer, not unrelated legacy delay or disabled/later timers', async () => {
  const f = await fixture(), s = f.store();
  const disabled = s.addPrompt('T', 'skip'), head = s.addPrompt('T', 'next'), later = s.addPrompt('T', 'later');
  s.setPromptTrigger('T', disabled, { kind: 'timer', seconds: 900 }); s.updatePrompt('T', disabled, { enabled: false });
  s.setPromptTrigger('T', head, { kind: 'timer', seconds: 100 }); s.setPromptTrigger('T', later, { kind: 'timer', seconds: 8000 });
  s.setFirstDelaySeconds('T', 33); s.setAutoRun('T', true); s.startFirstDelayCountdown('T');
  f.now(41000); s.setAutoRun('T', false);
  let q = s.getQueue('T');
  assert.equal(q.items.find(x => x.id === head).trigger.seconds, 60);
  assert.equal(q.items.find(x => x.id === disabled).trigger.seconds, 900);
  assert.equal(q.items.find(x => x.id === later).trigger.seconds, 8000);
  assert.equal(q.firstDelaySeconds, 33); assert.equal(q.firstDelayCountdownAt, null);
  s.cancelFirstDelayCountdown('T'); assert.equal(s.getQueue('T').items[1].trigger.seconds, 60, 'same pause cannot consume time twice');
  f.now(91000); s.setAutoRun('T', true); s.startFirstDelayCountdown('T');
  assert.equal(s.getQueue('T').firstDelayCountdownAt, 91000);
  f.now(101000); s.cancelFirstDelayCountdown('T'); s.setAutoRun('T', false);
  assert.equal(s.getQueue('T').items[1].trigger.seconds, 50, 'existing desktop cancellation uses same owner');
});

test('expired countdown stays an unconsumed card on pause; later edits do not change head deadline', async () => {
  const f = await fixture(), s = f.store();
  const head = s.addPrompt('T', 'next'), later = s.addPrompt('T', 'later');
  s.setPromptTrigger('T', head, { kind: 'timer', seconds: 100 }); s.setAutoRun('T', true); s.startFirstDelayCountdown('T');
  s.setPromptTrigger('T', later, { kind: 'timer', seconds: 7200 });
  assert.equal(s.getQueue('T').firstDelayCountdownAt, 1000);
  f.now(201000); s.setAutoRun('T', false);
  assert.equal(s.getQueue('T').items.length, 2); assert.equal(s.getQueue('T').items[0].trigger.seconds, 0);
  assert.equal(s.getQueue('T').autoRun, false);
});

test('own Resume advances outcome freshness without changing the pending user arm identity',async()=>{
  const f=await fixture(),s=f.store();s.addPrompt('T','continue');s.setAutoRun('T',true);
  const armed=s.getQueue('T').workflowArmedAt;s.suspendWorkflowsForRestart();
  f.now(2000);s.resumeWorkflowsForTrigger('T',2000);
  const q=s.getQueue('T');assert.equal(q.autoRun,true);assert.equal(q.workflowArmedAt,armed);
  assert.equal(q.workflowOutcomeFloorAt,2000);assert.equal(q.workflowRestartPending,false);
  s.disarmQueuesForTrigger('T',1500,{runtimeStartedAt:2000});assert.equal(s.getQueue('T').autoRun,true,'old failure cannot cancel resumed intent');
  f.flushPromptQueueStoreSync();const reopened=await fixture(f.persisted);
  assert.equal(reopened.store().getQueue('T').workflowArmedAt,armed);
  assert.equal(reopened.store().getQueue('T').workflowOutcomeFloorAt,2000);
  s.disarmQueuesForTrigger('T',2500,{runtimeStartedAt:2000});assert.equal(s.getQueue('T').autoRun,false,'new failure still cancels');
});

test('explicit Pause/rearm remains a new intent, not an internal Resume promotion',async()=>{
  const f=await fixture(),s=f.store();s.addPrompt('T','continue');s.setAutoRun('T',true);
  const armed=s.getQueue('T').workflowArmedAt;s.suspendWorkflowsForRestart();s.resumeWorkflowsForTrigger('T',2000);
  f.now(3000);s.setAutoRun('T',false);s.setAutoRun('T',true);
  assert.notEqual(s.getQueue('T').workflowArmedAt,armed);assert.equal(s.getQueue('T').workflowArmedAt,3000);
});
