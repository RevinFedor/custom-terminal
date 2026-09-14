const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OrchestrationRunStore, orchestrationInstallBlockers } = require('./orchestration-runs');
const { ExternalResearchCoordinator } = require('./external-research-coordinator');
const { ScExternalResearchHttpError } = require('./sc-external-research-client');

async function fixture() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'external-research-coordinator-'));
  const file = path.join(dir, 'runs.json');
  const store = new OrchestrationRunStore(file);
  await store.reserveOrGet({
    runId: 'run-1',
    runKind: 'external-research',
    requestFingerprint: 'fingerprint-1',
    sourceTabId: 'source-tab',
    sourceProjectId: 'project-1',
    sourceProjectName: 'Project',
    sourceProjectPath: '/tmp/project',
    targetTabId: null,
    targetTabName: 'ChatGPT · 5.6-sol',
    targetProjectId: null,
    targetProjectName: 'SC Desktop',
    notifySource: false,
    waitForDescendants: true,
    externalResearchJobId: 'noted_run-1',
    externalResearchProvider: 'chatgpt',
    externalResearchIntent: {
      provider: 'chatgpt',
      prompt: 'review',
      options: { mode: 'chat', model: '5.6-sol', effort: 'medium', temporaryChat: false },
      files: [{ path: '/tmp/a.md' }],
      conversationUrl: '',
    },
  });
  return { dir, file, store };
}

test('404 recovery starts one deterministic job, waits, and settles from SC done', async (t) => {
  const h = await fixture();
  t.after(async () => { await h.store.flush(); await fs.promises.rm(h.dir, { recursive: true, force: true }); });
  const calls = [];
  let statusCall = 0;
  const client = {
    async status(jobId) {
      calls.push(['status', jobId]);
      statusCall += 1;
      if (statusCall === 1) throw new ScExternalResearchHttpError('missing', { status: 404 });
      return {
        id: jobId, provider: 'chatgpt', status: 'done', stage: 'done',
        url: 'https://chatgpt.com/c/conversation-1',
        conversationUrl: 'https://chatgpt.com/c/conversation-1',
        conversationId: 'conversation-1',
        result: { text: 'review complete', url: 'https://chatgpt.com/c/conversation-1' },
      };
    },
    async start(request) {
      calls.push(['start', request.jobId, request.files]);
      return { id: request.jobId, provider: 'chatgpt', status: 'running', stage: 'running' };
    },
  };
  const settled = [];
  const coordinator = new ExternalResearchCoordinator({
    store: h.store, client, longPollMs: 0,
    finalizeSettled: async (run) => settled.push(run.runId),
  });
  await coordinator.watch('run-1', 'test');
  const run = await h.store.get('run-1');
  assert.equal(run.status, 'completed');
  assert.equal(run.resultComplete, true);
  assert.equal(run.externalResearchConversationUrl, 'https://chatgpt.com/c/conversation-1');
  assert.equal(run.externalResearchConversationId, 'conversation-1');
  assert.deepEqual(calls.filter(([kind]) => kind === 'start').map((call) => call[1]), ['noted_run-1']);
  assert.deepEqual(settled, ['run-1']);
});

test('ambiguous transport retry reuses the same jobId instead of creating a new identity', async (t) => {
  const h = await fixture();
  t.after(async () => { await h.store.flush(); await fs.promises.rm(h.dir, { recursive: true, force: true }); });
  const startedIds = [];
  let starts = 0;
  let terminal = false;
  const client = {
    async status(jobId) {
      if (terminal) return { id: jobId, status: 'done', result: { text: 'same job recovered' } };
      throw new ScExternalResearchHttpError('missing', { status: 404 });
    },
    async start(request) {
      starts += 1;
      startedIds.push(request.jobId);
      if (starts === 1) throw new ScExternalResearchHttpError('ACK unavailable', { status: 503 });
      terminal = true;
      return { id: request.jobId, status: 'running' };
    },
  };
  const coordinator = new ExternalResearchCoordinator({
    store: h.store, client, longPollMs: 0, retryBaseMs: 1, retryMaxMs: 1,
  });
  await coordinator.watch('run-1', 'retry-test');
  assert.deepEqual(startedIds, ['noted_run-1', 'noted_run-1']);
  assert.equal((await h.store.get('run-1')).status, 'completed');
});

test('a lost status channel is static waiting until a fresh SC snapshot restores running', async (t) => {
  const h = await fixture();
  t.after(async () => { await h.store.flush(); await fs.promises.rm(h.dir, { recursive: true, force: true }); });
  let statusCalls = 0;
  const observed = [];
  const coordinator = new ExternalResearchCoordinator({
    store: h.store,
    client: {
      async status(jobId, options) {
        statusCalls += 1;
        if (statusCalls === 1) throw new ScExternalResearchHttpError('missing', { status: 404 });
        if (statusCalls === 2) throw new Error('connection lost');
        assert.equal(options.waitMs, 0, 'reconnect check must not hide behind another long-poll');
        return { id: jobId, status: 'done', result: { text: 'restored' } };
      },
      async start(request) { return { id: request.jobId, status: 'running' }; },
    },
    retryBaseMs: 1,
    retryMaxMs: 1,
    longPollMs: 60_000,
    emitChanges: (runs) => observed.push(...runs),
  });
  await coordinator.watch('run-1', 'status-loss');
  const waiting = observed.find((run) => (
    run.status === 'queued' && run.deliveryDeferredReason === 'external-research-transport'
  ));
  assert.ok(waiting);
  assert.ok(waiting.deliveryAcceptedAt);
  assert.equal((await h.store.get('run-1')).status, 'completed');
});

test('restart restores a targetless external run and observes the existing job before start', async (t) => {
  const h = await fixture();
  let restored = null;
  t.after(async () => { await h.store.flush(); await restored?.flush(); await fs.promises.rm(h.dir, { recursive: true, force: true }); });
  await h.store.patch('run-1', { externalResearchStartAttemptedAt: Date.now() });
  await h.store.persistStrict();
  const persisted = JSON.parse(await fs.promises.readFile(h.file, 'utf8'));
  assert.equal(persisted.runs[0].externalResearchIntent.prompt, 'review');
  assert.deepEqual(persisted.runs[0].externalResearchIntent.files, [{ path: '/tmp/a.md' }]);
  assert.equal(Object.hasOwn(await h.store.get('run-1'), 'externalResearchIntent'), false);
  restored = new OrchestrationRunStore(h.file);
  let statusCalls = 0;
  let startCalls = 0;
  const client = {
    async status(jobId) {
      statusCalls += 1;
      return statusCalls === 1
        ? { id: jobId, status: 'running' }
        : { id: jobId, status: 'done', result: { text: 'restored' } };
    },
    async start() { startCalls += 1; throw new Error('must not start'); },
  };
  const coordinator = new ExternalResearchCoordinator({ store: restored, client, longPollMs: 0 });
  await coordinator.watch('run-1', 'restart');
  assert.equal(startCalls, 0);
  assert.equal((await restored.get('run-1')).status, 'completed');
});

test('authoritative SC delivery-unknown error is terminal and finalizes once without a new start', async (t) => {
  const h = await fixture();
  t.after(async () => { await h.store.flush(); await fs.promises.rm(h.dir, { recursive: true, force: true }); });
  const settled = [];
  const coordinator = new ExternalResearchCoordinator({
    store: h.store,
    client: {
      async status(jobId) {
        return {
          id: jobId,
          status: 'error',
          stage: 'delivery_unknown',
          deliveryUnknown: true,
          error: 'The previous browser request cannot be located',
        };
      },
      async start() { throw new Error('must not start'); },
    },
    finalizeSettled: async (run) => settled.push(run.runId),
  });
  await coordinator.watch('run-1', 'error');
  const run = await h.store.get('run-1');
  assert.equal(run.status, 'failed');
  assert.equal(run.externalResearchStage, 'delivery_unknown');
  assert.equal(run.externalResearchDeliveryUnknown, true);
  assert.equal(run.error, 'The previous browser request cannot be located');
  assert.equal(run.resultComplete, true);
  assert.deepEqual(settled, ['run-1']);
});

test('external research is an exact descendant and releases its parent only through source handoff proof', async (t) => {
  const h = await fixture();
  t.after(async () => { await h.store.flush(); await fs.promises.rm(h.dir, { recursive: true, force: true }); });
  const firstTurn = {
    provider: 'claude', sessionId: 'source-session', turnId: 'turn-1', processId: '42',
  };
  await h.store.reserveOrGet({
    runId: 'parent-run', requestFingerprint: 'parent-fingerprint',
    sourceTabId: 'root-tab', sourceProjectId: 'project-1',
    targetTabId: 'source-tab', targetProjectId: 'project-1', targetToolType: 'claude',
    notifySource: true, waitForDescendants: true, requiresTargetPromptProof: false,
  });
  await h.store.patch('parent-run', {
    status: 'running', deliveryAcceptedAt: Date.now(), targetBusySeen: true,
    targetExecutionContext: firstTurn,
  });

  const child = await h.store.reserveOrGet({
    runId: 'child-browser-run', runKind: 'external-research',
    requestFingerprint: 'child-fingerprint',
    sourceTabId: 'source-tab', sourceProjectId: 'project-1',
    targetTabId: null, targetProjectId: null,
    sourceExecutionContext: firstTurn,
    notifySource: true, waitForDescendants: true,
    externalResearchJobId: 'noted_child-browser-run',
    externalResearchIntent: { provider: 'chatgpt', prompt: 'review', options: {}, files: [], conversationUrl: '' },
  });
  assert.equal(child.run.parentRunId, 'parent-run');

  await h.store.applyExternalResearchSnapshot('child-browser-run', {
    id: 'noted_child-browser-run', status: 'done', result: { text: 'reviewed' },
  });
  await h.store.applyLifecycle('source-tab', {
    type: 'done', reason: 'task_complete', sessionId: 'source-session', executionContext: firstTurn,
  });
  assert.equal((await h.store.get('parent-run')).status, 'waiting_descendants');

  await h.store.markNotification('child-browser-run', 'sent', {
    notificationPromptHash: 'completion-hash',
    notificationHandoffId: 'orchestration-complete:child-browser-run',
  });
  const proof = await h.store.confirmSourceFollowup('child-browser-run', {
    kind: 'transcript', sourceTabId: 'source-tab', notificationPromptHash: 'completion-hash',
    sessionId: 'source-session', toolType: 'claude',
    executionContext: { ...firstTurn, turnId: 'turn-2' },
  });
  assert.equal(proof.confirmed, true);
  assert.equal(proof.contextBound, true);
  assert.equal((await h.store.get('child-browser-run')).parentConsumedAt > 0, true);
  assert.equal((await h.store.get('parent-run')).status, 'running');
});

test('targetless browser work blocks the source only and never invents a target loader', () => {
  const blockers = orchestrationInstallBlockers({
    runId: 'browser-run', runKind: 'external-research',
    sourceTabId: 'source-tab', sourceProjectId: 'project-1', sourceProjectName: 'Project',
    targetTabId: null, targetProjectId: null, targetProjectName: 'SC Desktop',
    status: 'running', notificationStatus: 'pending', deliveryAcceptedAt: Date.now(),
  });
  assert.deepEqual(blockers.map((item) => ({ tabId: item.tabId, role: item.role, status: item.status })), [
    { tabId: 'source-tab', role: 'source', status: 'inherited-busy' },
  ]);
});
