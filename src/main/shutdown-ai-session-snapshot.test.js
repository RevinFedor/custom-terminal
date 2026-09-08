'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isCodexShutdownScopeCurrent,
  reconcileCodexShutdownTarget,
  resolveAcceptedClaudeResumeShutdownTarget,
  resolveCodexShutdownTarget,
  resolveExactShutdownTarget,
} = require('./shutdown-ai-session-snapshot');
const { resolveCodexReadIdentity } = require('./codex-runtime-contract');
const { classifyCodexWriterAdoption } = require('./codex-writer-ownership');
const { createShutdownInterruptedSnapshot, resolveStartupInterruptedSnapshot } = require('./build-install-continue');

test('exact runtime sources agree or shutdown refuses to choose', () => {
  assert.deepEqual(resolveExactShutdownTarget([
    { engine: 'claude', sessionId: 'session-a', source: 'bridge' },
    { engine: 'claude', sessionId: 'session-a', source: 'active-turn' },
  ]).target, { engine: 'claude', sessionId: 'session-a' });

  assert.equal(resolveExactShutdownTarget([
    { engine: 'claude', sessionId: 'session-a' },
    { engine: 'claude', sessionId: 'session-b' },
  ]).target, null);
  assert.equal(resolveExactShutdownTarget([
    { engine: 'claude', sessionId: 'session-a' },
    { engine: 'codex', sessionId: 'session-x' },
  ]).target, null);
});

test('process found plus an old saved id is never enough', () => {
  assert.equal(resolveAcceptedClaudeResumeShutdownTarget({
    provider: 'claude',
    processFound: true,
    persistedSessionId: 'old-session',
  }), null);
});

test('bridge-less Claude Resume requires the same accepted causal identity', () => {
  const complete = {
    provider: 'claude',
    processFound: true,
    intentSessionId: 'resume-session',
    intentFresh: true,
    intentTerminalMatches: true,
    launchMode: 'resume',
    launchSessionId: 'resume-session',
    generationMatches: true,
    runGenerationMatches: true,
    persistedSessionId: 'resume-session',
  };
  assert.deepEqual(resolveAcceptedClaudeResumeShutdownTarget(complete), {
    engine: 'claude',
    sessionId: 'resume-session',
  });
  for (const patch of [
    { provider: 'codex' },
    { processFound: false },
    { intentFresh: false },
    { intentTerminalMatches: false },
    { launchMode: 'fresh' },
    { launchSessionId: 'other' },
    { generationMatches: false },
    { runGenerationMatches: false },
    { persistedSessionId: 'old-session' },
  ]) {
    assert.equal(resolveAcceptedClaudeResumeShutdownTarget({ ...complete, ...patch }), null);
  }
});

function codexRecoveryFixture() {
  const terminalToken = {};
  const scope = {
    terminalToken, projectId: 'project-a', runSeq: 7,
    lifecycleGeneration: 'terminal-a:7', launchId: 'launch-a', inputRevision: 12,
    writerObservationGeneration: 2, exitObserverGeneration: 3,
  };
  const readArguments = {
    tabId: 'root-tab-3314', liveLifecycle: true, persistedSessionId: 'source-a',
    writerStatus: 'provisional-source', observedWriterSessionId: 'source-a',
    resumeSourceSessionId: 'source-a',
    resumeReadLease: {
      command: 'codex-c', tabId: 'root-tab-3314', sessionId: 'source-a', launchId: 'launch-a',
      terminalToken, runSeq: 7, lifecycleGeneration: 'terminal-a:7', materializedFresh: false,
    },
    intent: {
      sourceMode: 'resume', sourceSessionId: 'source-a', launchId: 'launch-a',
      sourceRunSeq: 7, sourceLifecycleGeneration: 'terminal-a:7',
    },
    resumeLease: { sourceSessionId: 'source-a', tabId: 'root-tab-3314', launchId: 'launch-a' },
    sourceTurn: {
      sessionId: 'source-a', sourceObservationLaunchId: 'launch-a', processGeneration: 'terminal-a:7',
    },
    terminalToken, terminalRunSeq: 7, terminalLifecycleGeneration: 'terminal-a:7',
    processRunning: true, processPids: [60629], promptOrTurnInFlight: false,
  };
  const inspection = { status: 'provisional-source', sessionId: 'source-a', pids: [60629] };
  const evidence = () => ({
    writerSessionId: null, exactCandidates: [], allowIdleResume: true,
    readIdentity: resolveCodexReadIdentity(readArguments),
  });
  return { scope, readArguments, inspection, evidence };
}

test('shutdown scope rejects replacement, movement, input and every generation boundary', () => {
  const { scope } = codexRecoveryFixture();
  assert.equal(isCodexShutdownScopeCurrent(scope, { ...scope }), true);
  for (const key of Object.keys(scope)) {
    assert.equal(isCodexShutdownScopeCurrent(scope, { ...scope, [key]: null }), false, key);
  }
  assert.equal(isCodexShutdownScopeCurrent({ ...scope, runSeq: 0 }, { ...scope, runSeq: 0 }), false);
});

test('found idle provisional Resume gets recovery authority without acquiring writer authority', async () => {
  const fixture = codexRecoveryFixture();
  let calls = 0;
  const result = await reconcileCodexShutdownTarget({
    processFound: true, isCurrent: () => true, timeoutMs: 100,
    reconcileWriter: async () => { calls += 1; return fixture.inspection; },
    readCurrentEvidence: fixture.evidence,
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.target, { engine: 'codex', sessionId: 'source-a' });
  assert.equal(result.source, 'accepted-idle-resume-source');
  assert.equal(fixture.evidence().writerSessionId, null);
  assert.equal(fixture.evidence().readIdentity.mutationSafe, false);

  const snapshot = createShutdownInterruptedSnapshot(new Map([['root-tab-3314', result.target]]));
  const startup = resolveStartupInterruptedSnapshot({
    persistedSnapshot: snapshot,
    projects: [{ id: 'project-a', tabs: [{
      tabId: 'root-tab-3314', wasInterrupted: true, codexSessionId: 'source-a',
    }] }],
  });
  assert.equal(startup.targets[0].sessionId, 'source-a');
});

test('root shape: source post-user proof recovers the writer but never confirms the older unknown send', async () => {
  const fixture = codexRecoveryFixture();
  const oldReceipt = { handoffId: 'old-a', status: 'delivery-unknown', submitted: true };
  const before = { ...oldReceipt };
  let writerSessionId = null;
  const result = await reconcileCodexShutdownTarget({
    processFound: true, isCurrent: () => true, timeoutMs: 100,
    reconcileWriter: async () => {
      const adoption = classifyCodexWriterAdoption({
        sourceMode: 'resume', sourceMatch: 'source-in-place',
        resumeSubmitAuditPending: true, candidateSubmitAuditProven: false,
        sourceUserMessageProven: true,
      });
      assert.equal(adoption.status, 'commit');
      writerSessionId = 'source-a';
      return { status: 'adopted', sessionId: writerSessionId };
    },
    readCurrentEvidence: () => ({
      writerSessionId,
      exactCandidates: [{ engine: 'codex', sessionId: writerSessionId }],
    }),
  });
  assert.equal(result.source, 'writer-reconciled');
  assert.equal(result.target.sessionId, 'source-a');
  assert.deepEqual(oldReceipt, before);
  assert.equal(fixture.evidence().writerSessionId, null, 'the idle lease was never promoted');
});

test('the first unresolved Enter is not recovered from its old Resume source', async () => {
  const fixture = codexRecoveryFixture();
  fixture.readArguments.submitResolutionPending = {
    tabId: 'root-tab-3314', sourceSessionId: 'source-a', launchId: 'launch-a',
    terminalToken: fixture.scope.terminalToken, runSeq: 7, lifecycleGeneration: 'terminal-a:7', enterWritten: true,
  };
  const adoption = classifyCodexWriterAdoption({
    sourceMode: 'resume', sourceMatch: 'source-in-place',
    resumeSubmitAuditPending: true, sourceUserMessageProven: false,
  });
  assert.equal(adoption.status, 'provisional-source');
  const result = await reconcileCodexShutdownTarget({
    processFound: true, isCurrent: () => true, timeoutMs: 100,
    reconcileWriter: async () => fixture.inspection,
    readCurrentEvidence: fixture.evidence,
  });
  assert.equal(result.target, null);
  assert.equal(result.reason, 'submit-resolution-pending');
});

test('fresh, Fork parent, busy, reserved, foreign lease and changed source cannot get idle recovery', () => {
  const fixture = codexRecoveryFixture();
  const base = fixture.readArguments;
  for (const patch of [
    { resumeReadLease: { ...base.resumeReadLease, command: 'codex' } },
    { resumeReadLease: { ...base.resumeReadLease, command: 'codex-f' } },
    { intent: { ...base.intent, sourceMode: 'fork' } },
    { intent: { ...base.intent, sourceMode: 'writer-handoff' } },
    { promptOrTurnInFlight: true },
    { provisionalSubmitReserved: true },
    { resumeLease: { ...base.resumeLease, tabId: 'other-tab' } },
    { persistedSessionId: 'other-session' },
    { observedWriterSessionId: 'child-b' },
    { processPids: [] },
  ]) {
    const result = resolveCodexShutdownTarget({
      inspection: fixture.inspection, allowIdleResume: true,
      readIdentity: resolveCodexReadIdentity({ ...base, ...patch }),
    });
    assert.equal(result.target, null, JSON.stringify(patch));
  }
  assert.equal(resolveCodexShutdownTarget({
    inspection: fixture.inspection, ...fixture.evidence(), allowIdleResume: false,
  }).target, null, 'materialized Fresh still is not a Resume recovery lease');
});

test('only the re-read adopted writer wins; source/child and dual-provider conflicts stay unresolved', () => {
  const fixture = codexRecoveryFixture();
  for (const status of ['owned', 'unknown', 'absent', 'ambiguous', 'pending']) {
    assert.equal(resolveCodexShutdownTarget({
      inspection: { status, sessionId: 'source-a' }, ...fixture.evidence(),
    }).target, null, status);
  }
  assert.equal(resolveCodexShutdownTarget({
    inspection: { status: 'adopted', sessionId: 'child-b' }, writerSessionId: 'source-a',
  }).target, null);
  assert.deepEqual(resolveCodexShutdownTarget({
    inspection: { status: 'adopted', sessionId: 'child-b' }, writerSessionId: 'child-b',
  }).target, { engine: 'codex', sessionId: 'child-b' });
  for (const conflict of [
    { engine: 'codex', sessionId: 'child-b' },
    { engine: 'claude', sessionId: 'claude-a' },
  ]) {
    assert.equal(resolveCodexShutdownTarget({
      inspection: fixture.inspection, ...fixture.evidence(), exactCandidates: [conflict],
    }).reason, 'exact-identity-conflict');
  }
});

test('shutdown never reconciles an unproven process or an exhausted budget', async () => {
  let calls = 0;
  for (const patch of [{ processFound: false }, { timeoutMs: 0 }, { isCurrent: () => false }]) {
    const result = await reconcileCodexShutdownTarget({
      processFound: true, timeoutMs: 100, isCurrent: () => true,
      reconcileWriter: async () => { calls += 1; }, ...patch,
    });
    assert.equal(result.target, null);
  }
  assert.equal(calls, 0);
});

test('generation change during proof and late timeout completion never receive recovery authority', async () => {
  const fixture = codexRecoveryFixture();
  let current = true;
  const replaced = await reconcileCodexShutdownTarget({
    processFound: true, timeoutMs: 100, isCurrent: () => current,
    reconcileWriter: async () => { current = false; return fixture.inspection; },
    readCurrentEvidence: () => assert.fail('stale proof must not read a new generation'),
  });
  assert.equal(replaced.reason, 'shutdown-generation-changed');

  let finish;
  const timedOut = await reconcileCodexShutdownTarget({
    processFound: true, timeoutMs: 1, isCurrent: () => true,
    reconcileWriter: () => new Promise((resolve) => { finish = resolve; }),
    readCurrentEvidence: () => assert.fail('a deadline never authorizes source fallback'),
  });
  assert.equal(timedOut.reason, 'shutdown-proof-timeout');
  finish(fixture.inspection);
  await Promise.resolve();
  assert.equal(timedOut.target, null);
});
