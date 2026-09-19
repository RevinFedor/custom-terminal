'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolveClaudeWatcherRuntime } = require('./claude-watcher-runtime');
const publicRuntime = require('./web-server').__testPublicRuntimeSnapshots;

const rendererStarting = {
  toolType: 'claude',
  commandType: 'claude',
  status: 'starting',
  sessionStatus: 'starting',
  inputReady: true,
  sessionId: 'S1',
  launchId: 'L1',
  cwd: '/fixture',
};

test('ready main snapshot wins over a stale renderer starting frame for the same launch', async () => {
  const result = await resolveClaudeWatcherRuntime({
    tabId: 'T1',
    readRendererStatus: async () => rendererStarting,
    readMainRuntime: async () => ({
      coherent: true,
      toolType: 'claude',
      commandType: 'claude',
      status: 'active',
      sessionStatus: 'active',
      inputReady: true,
      writerSessionId: 'S1',
      launchId: 'L1',
      lifecycleGeneration: 'G1',
    }),
  });

  assert.equal(result.watcherStatus.status, 'active');
  assert.equal(result.publicSnapshot.sessionStatus, 'active');
  assert.equal(result.publicSnapshot.sessionId, 'S1');
  assert.equal(result.publicSnapshot.lifecycleGeneration, 'G1');
  assert.equal(result.publicSnapshot.cwd, '/fixture');
});

test('actual public revision store cannot observe active to starting from watcher subscribe', async () => {
  publicRuntime.reset();
  const committed = publicRuntime.stamp('T-revision', {
    coherent: true,
    type: 'snapshot',
    toolType: 'claude',
    commandType: 'claude',
    status: 'active',
    sessionStatus: 'active',
    inputReady: true,
    writerSessionId: 'S1',
    sessionId: 'S1',
    launchId: 'L1',
    lifecycleGeneration: 'G1',
  });
  const resolved = await resolveClaudeWatcherRuntime({
    tabId: 'T-revision',
    readRendererStatus: async () => rendererStarting,
    readMainRuntime: async () => ({
      coherent: true,
      toolType: 'claude',
      commandType: 'claude',
      status: 'active',
      sessionStatus: 'active',
      inputReady: true,
      writerSessionId: 'S1',
      sessionId: 'S1',
      launchId: 'L1',
      lifecycleGeneration: 'G1',
    }),
  });
  const afterWatcher = publicRuntime.stamp('T-revision', resolved.publicSnapshot);

  assert.equal(afterWatcher.sessionStatus, 'active');
  assert.equal(afterWatcher.runtimeRevision, committed.runtimeRevision,
    'equivalent watcher publication must not mint a newer regressive revision');
});

test('legitimate main-owned starting plus inputReady remains starting', async () => {
  const result = await resolveClaudeWatcherRuntime({
    tabId: 'T1',
    readRendererStatus: async () => ({ ...rendererStarting, status: 'active', sessionStatus: 'active' }),
    readMainRuntime: async () => ({
      coherent: true,
      toolType: 'claude',
      status: 'starting',
      sessionStatus: 'starting',
      inputReady: true,
      writerSessionId: 'S1',
      launchId: 'L1',
      lifecycleGeneration: 'G1',
    }),
  });

  assert.equal(result.publicSnapshot.sessionStatus, 'starting');
  assert.equal(result.publicSnapshot.inputReady, true);
});

test('main reader failure preserves file watching but emits no renderer lifecycle snapshot', async () => {
  const result = await resolveClaudeWatcherRuntime({
    tabId: 'T1',
    readRendererStatus: async () => rendererStarting,
    readMainRuntime: async () => { throw new Error('unstable'); },
  });

  assert.equal(result.watcherStatus, rendererStarting);
  assert.equal(result.publicSnapshot, null);
  assert.equal(result.reason, 'main-runtime-unavailable');
  assert.match(result.mainError.message, /unstable/);
});

test('explicit no-writer main snapshot never resurrects a stale renderer session', async () => {
  const result = await resolveClaudeWatcherRuntime({
    tabId: 'T1',
    readRendererStatus: async () => rendererStarting,
    readMainRuntime: async () => ({
      coherent: true,
      toolType: 'claude',
      status: 'starting',
      writerSessionId: null,
      launchId: 'L2',
    }),
  });

  assert.equal(result.watcherStatus.sessionId, null);
  assert.equal(result.publicSnapshot.sessionId, null);
});

test('subscription closed during either async read cancels publication and watcher setup', async () => {
  let current = true;
  const result = await resolveClaudeWatcherRuntime({
    tabId: 'T1',
    readRendererStatus: async () => rendererStarting,
    readMainRuntime: async () => { current = false; return { toolType: 'claude', status: 'active' }; },
    isCurrent: () => current,
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.watcherStatus, null);
  assert.equal(result.publicSnapshot, null);
});

test('web watcher publishes the resolved main snapshot rather than raw renderer status', () => {
  const source = fs.readFileSync(require.resolve('./web-server'), 'utf8');
  const start = source.indexOf('async function startClaudeTabWatcher');
  const end = source.indexOf('\nfunction stopClaudeTabWatcher', start);
  const block = source.slice(start, end);
  assert.match(block, /resolveClaudeWatcherRuntime\(/);
  assert.match(block, /if \(resolved\.publicSnapshot\) webBroadcast\(tabId, resolved\.publicSnapshot\)/);
  assert.doesNotMatch(block, /sessionStatus:\s*status\.status/);
});
