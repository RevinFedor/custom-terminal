const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AI_PROCESS_LOOKUP_STATUS,
  buildAiStopScope,
  decideCodexExitProbe,
  inspectProcessLookup,
  inspectProcessLookupCached,
  isRetryableProcessTreeSnapshotTimeout,
  requireKnownProcessLookup,
  resolveClaudeRuntimeAfterFailedStop,
  resolveProcessPresence,
  selectAiProcessForStop,
} = require('./ai-process-liveness');

test('distinguishes a failed process observation from proven absence', async () => {
  const failed = await inspectProcessLookup(async () => {
    throw new Error('ps timed out');
  }, { tabId: 'tab-1', expectedName: 'codex' });
  const absent = await inspectProcessLookup(async () => []);

  assert.equal(failed.status, AI_PROCESS_LOOKUP_STATUS.UNKNOWN);
  assert.equal(failed.error.code, 'AI_PROCESS_LOOKUP_FAILED');
  assert.equal(absent.status, AI_PROCESS_LOOKUP_STATUS.ABSENT);
  assert.throws(() => requireKnownProcessLookup(failed), /ps timed out/);
  assert.deepEqual(requireKnownProcessLookup(absent), []);
});

test('only a timed out full process-tree snapshot allows a fresh Rewind observation', async () => {
  const timeout = new Error('Command failed: ps -eo pid=,ppid=,pgid=,tpgid=,command=');
  Object.assign(timeout, { killed: true, signal: 'SIGTERM' });
  const failed = await inspectProcessLookup(async () => { throw timeout; });
  assert.equal(isRetryableProcessTreeSnapshotTimeout(failed), true);
  assert.equal(isRetryableProcessTreeSnapshotTimeout({ status: 'found', error: failed.error }), false);
  for (const error of [
    Object.assign(new Error('Command failed: ps -eo pid=,ppid=,pgid=,tpgid=,command='), { code: 'EACCES' }),
    Object.assign(new Error('lsof timed out'), { killed: true, signal: 'SIGTERM' }),
    new Error('process_scope_changed'),
  ]) {
    const unknown = await inspectProcessLookup(async () => { throw error; });
    assert.equal(isRetryableProcessTreeSnapshotTimeout(unknown), false);
  }
});

test('does not cache unknown as an empty process list', async () => {
  const cache = new Map();
  let now = 100;
  let attempts = 0;
  const query = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary ps failure');
    return [{ pid: 42 }];
  };

  const first = await inspectProcessLookupCached({
    cache,
    key: 'tab-1:codex',
    maxAgeMs: 2000,
    now: () => now,
    query,
  });
  now += 1;
  const second = await inspectProcessLookupCached({
    cache,
    key: 'tab-1:codex',
    maxAgeMs: 2000,
    now: () => now,
    query,
  });
  const third = await inspectProcessLookupCached({
    cache,
    key: 'tab-1:codex',
    maxAgeMs: 2000,
    now: () => now,
    query,
  });

  assert.equal(first.status, AI_PROCESS_LOOKUP_STATUS.UNKNOWN);
  assert.equal(second.status, AI_PROCESS_LOOKUP_STATUS.FOUND);
  assert.equal(third.status, AI_PROCESS_LOOKUP_STATUS.FOUND);
  assert.equal(third.source, 'cache');
  assert.equal(attempts, 2);
});

test('only a successful empty lookup authorizes Codex exit finalization', async () => {
  const unknown = await inspectProcessLookup(async () => { throw new Error('ps unavailable'); });
  const found = await inspectProcessLookup(async () => [{ pid: 9 }]);
  const absent = await inspectProcessLookup(async () => []);

  assert.equal(decideCodexExitProbe(unknown), 'retry');
  assert.equal(decideCodexExitProbe(found), 'keep-alive');
  assert.equal(decideCodexExitProbe(absent), 'finalize');
});

test('observer failure preserves established readiness but cannot invent a new process', async () => {
  const unknown = await inspectProcessLookup(async () => { throw new Error('ps unavailable'); });
  const absent = await inspectProcessLookup(async () => []);

  const preserved = resolveProcessPresence(unknown, { established: true });
  assert.equal(preserved.present, true);
  assert.equal(preserved.lookupUnknown, true);
  assert.match(preserved.error.message, /ps unavailable/);
  assert.equal(resolveProcessPresence(unknown, { established: false }).present, false);
  assert.equal(resolveProcessPresence(absent, { established: true }).present, false);
});

test('failed Claude Stop ignores stale spinner when authoritative turn is idle', () => {
  const runtime = resolveClaudeRuntimeAfterFailedStop({
    claudeTurnBusy: false,
    claudeSpinnerBusy: true,
    claudePromptReady: true,
    failure: 'process_lookup_failed',
  });

  assert.deepEqual(runtime, {
    sessionStatus: 'active',
    busy: false,
    inputReady: true,
  });
});

test('failed Claude Stop preserves input availability for a real busy turn', () => {
  assert.deepEqual(resolveClaudeRuntimeAfterFailedStop({
    claudeTurnBusy: true,
    claudePromptReady: true,
  }), {
    sessionStatus: 'busy',
    busy: true,
    inputReady: true,
  });
});

test('Stop selection prefers a direct AI child over nested candidates', () => {
  const direct = { pid: 31, depth: 1, processName: 'claude', cmd: 'claude' };
  const selected = selectAiProcessForStop([
    { pid: 10, depth: 2, processName: 'codex', cmd: 'codex' },
    direct,
  ]);

  assert.equal(selected, direct);
});

test('Stop selection preserves ps order among direct AI children', () => {
  const selected = selectAiProcessForStop([
    { pid: 99, depth: 1, processName: 'gemini', cmd: 'gemini' },
    { pid: 41, depth: 1, processName: 'claude', cmd: 'claude' },
  ]);

  assert.equal(selected.pid, 41);
  assert.equal(selected.processName, 'claude');
});

test('Stop selection uses the shallowest nested Codex fallback', () => {
  const selected = selectAiProcessForStop([
    { pid: 90, depth: 4, processName: 'codex', cmd: 'vendor codex' },
    { pid: 80, depth: 2, processName: 'codex', cmd: 'node codex' },
    { pid: 70, depth: 2, processName: 'codex', cmd: 'node codex' },
  ]);

  assert.equal(selected.pid, 70);
  assert.equal(selected.depth, 2);
});

test('Stop selection does not invent a nested fallback for Claude', () => {
  assert.equal(selectAiProcessForStop([
    { pid: 50, depth: 2, processName: 'claude', cmd: 'wrapper → claude' },
  ]), null);
});

test('Stop selection rejects malformed or non-AI candidates', () => {
  assert.equal(selectAiProcessForStop(null), null);
  assert.equal(selectAiProcessForStop([
    { pid: 0, depth: 1, processName: 'codex' },
    { pid: 9, depth: 0, processName: 'claude' },
    { pid: 10, depth: 1, processName: 'shell' },
  ]), null);
});

test('Stop scope covers the selected AI process and every proven descendant', () => {
  const children = new Map([
    [20, [
      { pid: 30, ppid: 20, pgid: 20, cmd: 'tool-wrapper' },
      { pid: 31, ppid: 20, pgid: 31, cmd: 'tool-shell' },
    ]],
    [30, [{ pid: 40, ppid: 30, pgid: 20, cmd: 'sleep 90' }]],
    [31, [{ pid: 41, ppid: 31, pgid: 31, cmd: 'language-server' }]],
    [999, [{ pid: 1000, ppid: 999, pgid: 999, cmd: 'unrelated' }]],
  ]);

  assert.deepEqual(buildAiStopScope({
    candidate: { pid: 20, ppid: 10, pgid: 20 },
    children,
    shellPid: 10,
  }), {
    rootPid: 20,
    processGroups: [31, 20],
    signalPids: [],
    trackedPids: [41, 40, 31, 30, 20],
  });
});

test('Stop scope falls back to explicit descendant PIDs for unsafe or missing process groups', () => {
  const children = new Map([
    [20, [
      { pid: 30, ppid: 20, pgid: 10, cmd: 'inherits shell group' },
      { pid: 31, ppid: 20, cmd: 'missing pgid' },
    ]],
  ]);

  assert.deepEqual(buildAiStopScope({
    candidate: { pid: 20, ppid: 10, pgid: 10 },
    children,
    shellPid: 10,
  }), {
    rootPid: 20,
    processGroups: [],
    signalPids: [31, 30, 20],
    trackedPids: [31, 30, 20],
  });
});

test('Stop scope rejects an invalid selected process', () => {
  assert.equal(buildAiStopScope({ candidate: { pid: 0 }, children: new Map() }), null);
  assert.equal(buildAiStopScope({ candidate: null, children: new Map() }), null);
});
