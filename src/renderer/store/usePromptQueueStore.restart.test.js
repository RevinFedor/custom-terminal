const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
const vm = require('node:vm');

test('restart preserves deadlines and dependency promises; old shutdown outcomes cannot consume them', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-queue-restart-'));
  const outfile = path.join(dir, 'store.cjs');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'usePromptQueueStore.ts')], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' });
  const persisted = new Map();
  const ipcRenderer = {
    invoke: async (channel, value) => {
      if (channel === 'ai-prompts:get') return { success: true, data: [{ id: 'run-after-loop', content: require('../../shared/prompt-loop.cjs').DEFAULT_LOOP_PROMPT }] };
      if (channel === 'ai-prompts:save-content') return { success: true };
      if (channel === 'app:getState') return persisted.get(value);
      if (channel === 'app:setState') { persisted.set(value.key, value.value); return { success: true }; }
      throw Error('unexpected IPC: ' + channel);
    },
    sendSync: (_channel, value) => { persisted.set(value.key, value.value); return { success: true }; },
  };
  global.window = { require: () => ({ ipcRenderer }) };
  const realNow = Date.now;
  t.after(async () => { Date.now = realNow; delete global.window; await fs.rm(dir, { recursive: true, force: true }); });
  Date.now = () => 1000;
  let module = require(outfile);
  await module.hydratePromptQueueStore();
  let store = module.usePromptQueueStore.getState();
  store.addPrompt('A', 'own continuation');
  store.setAutoRun('A', true);
  store.setFirstDelaySeconds('A', 7200);
  store.startFirstDelayCountdown('A');
  store.addPrompt('B', 'only after all of A');
  store.setRunAfterTab('B', 'A');
  store.setLoopPromptEnabled('B', true);
  const restartItemId = store.addPrompt('R', 'run after application restart');
  store.setPromptTrigger('R', restartItemId, { kind: 'app-restart', armedInstanceId: 'main-instance-A' });
  store.setAutoRun('R', true);
  assert.deepEqual(store.disarmQueuesForTrigger('R', 1500, {
    runtimeInstanceId: 'main-instance-A', runtimeStartedAt: 1000,
  }), [],
    'an outcome in the arming process cannot consume a future-restart condition');
  store.suspendWorkflowsForRestart();
  assert.deepEqual(store.disarmQueuesForTrigger('A', 2000), [], 'shutdown is not a failed dependency');
  module.flushPromptQueueStoreSync();

  delete require.cache[require.resolve(outfile)];
  Date.now = () => 3601000;
  module = require(outfile);
  await module.hydratePromptQueueStore();
  store = module.usePromptQueueStore.getState();
  const timer = store.getQueue('A');
  assert.equal(timer.autoRun, true);
  assert.equal(timer.firstDelayCountdownAt, 1000);
  assert.equal(timer.items[0].trigger.seconds * 1000 + timer.firstDelayCountdownAt - Date.now(), 3600000);
  assert.equal(store.getQueue('B').items[0].trigger.tabId, 'A');
  assert.equal(store.getQueue('B').workflowRestartPending, true);
  assert.equal(store.getQueue('B').loopRestartPending, true);
  assert.deepEqual(store.getQueue('R').items[0].trigger, {
    kind: 'app-restart',
    armedInstanceId: 'main-instance-A',
  });
  assert.equal(store.getQueue('R').autoRun, true);
  assert.deepEqual(store.disarmQueuesForTrigger('A', 2000), []);

  store.resumeWorkflowsForTrigger('A', 3601000);
  assert.equal(store.getQueue('A').firstDelayCountdownAt, 1000, 'fresh work does not restart the clock');
  assert.equal(store.getQueue('B').workflowRestartPending, false);
  assert.equal(store.getQueue('B').loopRestartPending, true, 'B Loop and dependency on A have different owners');
  assert.deepEqual(store.disarmQueuesForTrigger('A', 2000), [], 'late replay of the old abort is stale');
  store.resumeWorkflowsForTrigger('B', 3601000);
  assert.equal(store.getQueue('B').loopRestartPending, false);
  assert.deepEqual(store.disarmQueuesForTrigger('A', 3602000), ['A', 'B'], 'a genuinely new failure still stops dependencies');
  store.resumeWorkflowsForTrigger('R', 3601000);
  assert.deepEqual(store.disarmQueuesForTrigger('R', 2000, {
    runtimeInstanceId: 'main-instance-B', runtimeStartedAt: 3601000,
  }), [], 'an old outcome restored after boot cannot cancel the restart-triggered item');
  assert.deepEqual(store.disarmQueuesForTrigger('R', 3602000, {
    runtimeInstanceId: 'main-instance-B', runtimeStartedAt: 3601000,
  }), ['R'],
    'after restart, a genuinely new failure may stop the now-satisfied workflow');

  // Exercise the actual runner callback, not just the arithmetic above. An
  // absolute timer is allowed to start fresh work after restart; it must not
  // wait for a natural completion of the pre-restart process.
  Date.now = () => 1000;
  store.addPrompt('T', 'timer continuation');
  store.setAutoRun('T', true);
  store.setFirstDelaySeconds('T', 7200);
  store.startFirstDelayCountdown('T');
  store.suspendWorkflowsForRestart();
  module.flushPromptQueueStoreSync();
  delete require.cache[require.resolve(outfile)];
  Date.now = () => 3601000;
  module = require(outfile);
  await module.hydratePromptQueueStore();
  store = module.usePromptQueueStore.getState();

  const runnerSource = await fs.readFile(path.join(__dirname, '../hooks/usePromptQueueRunner.ts'), 'utf8');
  const helpersStart = runnerSource.indexOf('function enabledQueueHead(');
  const helpersEnd = runnerSource.indexOf('type ContinuationKind', helpersStart);
  const callbackStart = runnerSource.indexOf('const scheduleFirstDelayTimer =');
  const callbackEnd = runnerSource.indexOf('const startFirstDelayCountdown =', callbackStart);
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart && callbackStart >= 0 && callbackEnd > callbackStart);
  const delaySource = await fs.readFile(path.join(__dirname, '../utils/promptQueueDelay.ts'), 'utf8');
  const delayModule = { exports: {} };
  vm.runInNewContext(esbuild.transformSync(delaySource, { loader: 'ts', format: 'cjs' }).code,
    { module: delayModule, exports: delayModule.exports, Date });
  const pendingTimers = new Map();
  let scheduled;
  let blocked = false;
  const fired = [];
  const callbacks = runnerSource.slice(helpersStart, helpersEnd)
    + runnerSource.slice(callbackStart, callbackEnd) + '\nglobalThis.schedule = scheduleFirstDelayTimer;';
  const context = {
    Date, usePromptQueueStore: module.usePromptQueueStore,
    countEnabledQueuedPrompts: module.countEnabledQueuedPrompts,
    isQueuedPromptEnabled: module.isQueuedPromptEnabled,
    ...delayModule.exports, pendingTimers,
    canProcessWorkflowOutcomes: () => true,
    isTabWorkflowBlocked: () => blocked,
    isPromptQueueEditorLocked: () => false,
    setTimeout: (callback, ms) => { scheduled = { callback, ms }; return 1; },
    fireHead: (ownerTabId, triggerTabId) => {
      assert.equal(store.getQueue(ownerTabId).firstDelayCountdownAt, null);
      assert.equal(store.getQueue(ownerTabId).items[0].trigger.seconds, 0);
      fired.push([ownerTabId, triggerTabId]);
    },
  };
  vm.runInNewContext(esbuild.transformSync(callbacks, { loader: 'ts' }).code, context);
  context.schedule('T');
  assert.equal(scheduled.ms, 3600000, 'the actual runner schedules only the remaining hour');
  Date.now = () => 7201000;
  blocked = true;
  scheduled.callback();
  assert.equal(store.getQueue('T').firstDelayCountdownAt, 1000, 'busy/orchestration does not consume an overdue deadline');
  assert.equal(fired.length, 0);
  blocked = false;
  context.schedule('T');
  context.schedule('T');
  assert.deepEqual(fired, [['T', 'T']], 'readiness wake consumes the overdue timer exactly once');
});
