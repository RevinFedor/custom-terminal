const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AI_PROCESS_LOOKUP_STATUS,
  decideCodexExitProbe,
  inspectProcessLookup,
  inspectProcessLookupCached,
  requireKnownProcessLookup,
  resolveClaudeRuntimeAfterFailedStop,
  resolveProcessPresence,
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
