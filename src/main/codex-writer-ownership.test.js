'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  classifyManualCodexSubmitAfterWriteQueue,
  classifyCodexBranchWriterHandoffSettlement,
  classifyCodexNativeRewindReplacementProjection,
  reconcileCodexNativeRewindReplacementProof,
  classifyCodexWriterAdoption,
  classifyCodexProvisionalActionAuthorization,
  classifyCodexWriterHandoffSettlement,
  claimExclusiveActionReservation,
  claimCodexResumeSourceLease,
  isRetryableCodexDescriptorProbeTimeout,
  parseLsofFieldRecords,
  releaseExclusiveActionReservation,
  releaseCodexResumeSourceLeases,
  runCodexDescriptorProbeWithSingleRetry,
  resolveCompleteCodexWriterProof,
  resolveCodexUserWriterProof,
  resolveCodexWriterProof,
  isCommittedCodexNativeRewindReplay,
  classifyCodexWriterHandoffObserverAdoption,
  resolveCodexRewindCompletionProof,
  classifyCodexRewindCommitReceiptRuntime,
  shouldCloseCodexRewindProtocolUi,
  classifyCodexWriterObservationScope,
  deriveCodexSettledWriterProofScope,
  projectCodexWriterProofKind,
  hasCodexWriterHandoffActionBoundary,
  normalizeCodexPositiveRunSeq,
  shouldUseSettledCodexRewindWriterProof,
  selectCodexDelayedStableSourceWriter,
  selectCodexDelayedWriterWatchTargets,
  selectCodexResumedSubmitWriter,
  selectCodexNativeRewindWriter,
  selectCodexNativeRewindSourceIncumbent,
  selectCodexSettledRewindWriter,
  isCodexWriterProofOwnershipQuarantined,
  isCodexResumeSourceAuditPending,
  runKeyedExclusive,
  runKeyedSingleFlight,
  shouldRetryCodexDescriptorProbePass,
  writableCodexRolloutsFromLsof,
} = require('./codex-writer-ownership');

test('Rewind failure cleanup closes only a proven pre-commit protocol UI', () => {
  assert.equal(shouldCloseCodexRewindProtocolUi({
    protocolUiOpen: false,
    handoffMutationStarted: false,
  }), false, 'idle composer must never receive a blind Escape cleanup');
  assert.equal(shouldCloseCodexRewindProtocolUi({
    protocolUiOpen: true,
    handoffMutationStarted: false,
  }), true);
  assert.equal(shouldCloseCodexRewindProtocolUi({
    protocolUiOpen: true,
    handoffMutationStarted: true,
  }), false, 'after Enter no cleanup key may guess the current TUI state');
});

test('manual Codex Enter loses only to an active first write or pre-Enter reservation', () => {
  assert.deepEqual(classifyManualCodexSubmitAfterWriteQueue({
    activeOperation: { kind: 'codex-model-effort-picker' },
  }), {
    suppress: false,
    bypassQueue: true,
    reason: 'manual-input-takes-picker',
  });
  assert.deepEqual(classifyManualCodexSubmitAfterWriteQueue({
    activeOperation: {
      kind: 'codex-live-slash-command',
      manualInputYields: true,
    },
  }), {
    suppress: false,
    bypassQueue: true,
    reason: 'manual-input-takes-picker',
  });

  const queuedFirstSubmit = { identityPending: true, submitted: false };
  assert.equal(classifyManualCodexSubmitAfterWriteQueue({
    precedingOperation: queuedFirstSubmit,
  }).suppress, false);

  queuedFirstSubmit.submitted = true;
  assert.deepEqual(classifyManualCodexSubmitAfterWriteQueue({
    precedingOperation: queuedFirstSubmit,
  }), {
    suppress: true,
    bypassQueue: false,
    reason: 'preceding-first-submit-won',
  });

  assert.equal(classifyManualCodexSubmitAfterWriteQueue({
    precedingOperation: { identityPending: false, submitted: true },
  }).suppress, false);
  assert.equal(classifyManualCodexSubmitAfterWriteQueue({
    precedingOperation: {
      kind: 'safe-paste',
      identityPending: false,
      submitted: true,
    },
  }).reason, 'preceding-first-submit-won');

  const ownReservation = { launchId: 'launch-a' };
  assert.equal(classifyManualCodexSubmitAfterWriteQueue({
    competingReservation: ownReservation,
    ownReservation,
  }).suppress, false);
  assert.equal(classifyManualCodexSubmitAfterWriteQueue({
    competingReservation: { launchId: 'launch-b' },
    ownReservation,
  }).reason, 'provisional-submit-reserved-by-other');
  assert.deepEqual(classifyManualCodexSubmitAfterWriteQueue({
    competingReservation: {
      launchId: 'launch-b',
      submitted: true,
      enterWritten: true,
    },
    ownReservation,
  }), {
    suppress: false,
    bypassQueue: false,
    reason: 'manual-submit-after-reserved-enter',
  });
  assert.equal(classifyManualCodexSubmitAfterWriteQueue({
    competingReservation: {
      launchId: 'launch-b',
      submitted: true,
      enterWritten: false,
    },
    ownReservation,
  }).suppress, true, 'a programmatic Enter that has not crossed PTY still owns the boundary');
});

test('parses lsof field records and keeps only writable rollout files', () => {
  const output = [
    'p71060',
    'f30',
    'ar',
    'n/Users/fedor/.codex/sessions/2026/07/22/read-only.jsonl',
    'f31',
    'au',
    'n/Users/fedor/.codex/sessions/2026/07/22/current.jsonl',
    'f32',
    'au',
    'n/Users/fedor/Desktop/unrelated.jsonl',
  ].join('\n');

  assert.equal(parseLsofFieldRecords(output).length, 3);
  assert.deepEqual(
    writableCodexRolloutsFromLsof(output, '/Users/fedor/.codex/sessions')
      .map((record) => record.name),
    ['/Users/fedor/.codex/sessions/2026/07/22/current.jsonl'],
  );
});

test('one writable rollout is authoritative even when wrapper and child share it', () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const filePath = sessionsDir + '/2026/07/22/current.jsonl';
  const proof = resolveCodexWriterProof([
    { pid: 100, output: `p100\nf20\nau\nn${filePath}\n` },
    { pid: 101, output: `p101\nf21\nau\nn${filePath}\n` },
  ], sessionsDir);

  assert.equal(proof.status, 'owned');
  assert.equal(proof.filePath, filePath);
  assert.deepEqual(proof.pids, [100, 101]);
});

test('writer ownership treats symlink aliases as the same sessions directory', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-writer-path-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const realRoot = path.join(tempRoot, 'real-codex-home');
  const aliasRoot = path.join(tempRoot, 'alias-codex-home');
  const realSessionsDir = path.join(realRoot, 'sessions');
  const realRolloutDir = path.join(realSessionsDir, '2026', '07', '23');
  fs.mkdirSync(realRolloutDir, { recursive: true });
  fs.symlinkSync(realRoot, aliasRoot, 'dir');
  const realRollout = path.join(realRolloutDir, 'current.jsonl');
  fs.writeFileSync(realRollout, '{"type":"session_meta"}\n');

  const proof = resolveCodexWriterProof([{
    pid: 83435,
    output: `p83435\nf24\nau\nn${realRollout}\n`,
  }], path.join(aliasRoot, 'sessions'));

  assert.equal(proof.status, 'owned');
  assert.equal(proof.filePath, fs.realpathSync.native(realRollout));
  assert.deepEqual(proof.pids, [83435]);
});

test('multiple writable rollouts are ambiguous and cannot become a binding', () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const proof = resolveCodexWriterProof([
    { pid: 100, output: `p100\nf20\nau\nn${sessionsDir}/a.jsonl\n` },
    { pid: 101, output: `p101\nf21\naw\nn${sessionsDir}/b.jsonl\n` },
  ], sessionsDir);

  assert.equal(proof.status, 'ambiguous');
  assert.deepEqual(proof.candidates.map((candidate) => candidate.filePath).sort(), [
    sessionsDir + '/a.jsonl',
    sessionsDir + '/b.jsonl',
  ]);
});

test('one candidate plus one failed process inspection is unknown, not owned', () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const filePath = sessionsDir + '/2026/07/22/current.jsonl';
  const proof = resolveCompleteCodexWriterProof([
    { pid: 100, output: `p100\nf20\nau\nn${filePath}\n` },
  ], [
    { pid: 101, error: 'lsof timeout' },
  ], sessionsDir);

  assert.equal(proof.status, 'unknown');
  assert.equal(proof.partialProofStatus, 'owned');
  assert.deepEqual(proof.candidates.map((candidate) => candidate.filePath), [filePath]);
});

test('descriptor retry classification accepts only timeout-shaped observer failures', () => {
  assert.equal(isRetryableCodexDescriptorProbeTimeout({
    killed: true,
    signal: 'SIGTERM',
  }), true);
  assert.equal(isRetryableCodexDescriptorProbeTimeout({
    killed: true,
    signal: 'SIGKILL',
  }), true);
  assert.equal(isRetryableCodexDescriptorProbeTimeout({ code: 'ETIMEDOUT' }), true);
  assert.equal(isRetryableCodexDescriptorProbeTimeout({ code: 1 }), false);
  assert.equal(isRetryableCodexDescriptorProbeTimeout({ code: 'EACCES' }), false);

  assert.equal(shouldRetryCodexDescriptorProbePass({
    status: 'unknown',
    failures: [{ retryableTimeout: true }, { retryableTimeout: true }],
  }), true);
  assert.equal(shouldRetryCodexDescriptorProbePass({
    status: 'unknown',
    failures: [{ retryableTimeout: true }, { retryableTimeout: false }],
  }), false);
  assert.equal(shouldRetryCodexDescriptorProbePass({
    status: 'unknown',
    failures: [],
  }), false);
  assert.equal(shouldRetryCodexDescriptorProbePass({
    status: 'owned',
    failures: [{ retryableTimeout: true }],
  }), false);
});

test('descriptor proof retries one complete timeout pass and never weakens unknown', async () => {
  const attempts = [];
  const recovered = await runCodexDescriptorProbeWithSingleRetry(async (attempt) => {
    attempts.push(attempt);
    if (attempt === 1) {
      return {
        status: 'unknown',
        error: '101:lsof timeout',
        failures: [{ pid: 101, retryableTimeout: true }],
      };
    }
    return { status: 'owned', sessionId: 'writer-a', failures: [] };
  });
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(recovered.status, 'owned');
  assert.equal(recovered.descriptorRetry.attempted, true);
  assert.equal(recovered.descriptorRetry.recovered, true);

  let persistentAttempts = 0;
  const persistent = await runCodexDescriptorProbeWithSingleRetry(async () => {
    persistentAttempts += 1;
    return {
      status: 'unknown',
      error: '101:lsof timeout',
      failures: [{ pid: 101, retryableTimeout: true }],
    };
  });
  assert.equal(persistentAttempts, 2);
  assert.equal(persistent.status, 'unknown');
  assert.equal(persistent.descriptorRetry.recovered, false);

  let nonTimeoutAttempts = 0;
  const nonTimeout = await runCodexDescriptorProbeWithSingleRetry(async () => {
    nonTimeoutAttempts += 1;
    return {
      status: 'unknown',
      error: '101:EACCES',
      failures: [{ pid: 101, retryableTimeout: false }],
    };
  });
  assert.equal(nonTimeoutAttempts, 1);
  assert.equal(nonTimeout.status, 'unknown');
  assert.equal(nonTimeout.descriptorRetry, undefined);
});

test('descriptor proof retry fails closed when launch generation changes', async () => {
  let current = true;
  let attempts = 0;
  const changedBefore = await runCodexDescriptorProbeWithSingleRetry(async () => {
    attempts += 1;
    current = false;
    return {
      status: 'unknown',
      error: '101:lsof timeout',
      failures: [{ pid: 101, retryableTimeout: true }],
    };
  }, {
    isGenerationCurrent: () => current,
  });
  assert.equal(attempts, 1);
  assert.equal(changedBefore.status, 'unknown');
  assert.equal(
    changedBefore.error,
    'writer_process_generation_changed_before_descriptor_retry',
  );

  current = true;
  attempts = 0;
  const changedAfter = await runCodexDescriptorProbeWithSingleRetry(async (attempt) => {
    attempts += 1;
    if (attempt === 2) current = false;
    return attempt === 1
      ? {
        status: 'unknown',
        error: '101:lsof timeout',
        failures: [{ pid: 101, retryableTimeout: true }],
      }
      : { status: 'owned', sessionId: 'writer-a', failures: [] };
  }, {
    isGenerationCurrent: () => current,
  });
  assert.equal(attempts, 2);
  assert.equal(changedAfter.status, 'unknown');
  assert.equal(
    changedAfter.error,
    'writer_process_generation_changed_after_descriptor_retry',
  );
});

test('user TUI writer stays authoritative while collaboration subagents are writable', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const paths = {
    parent: sessionsDir + '/rollout-parent.jsonl',
    childA: sessionsDir + '/rollout-child-a.jsonl',
    childB: sessionsDir + '/rollout-child-b.jsonl',
  };
  const descriptorProof = resolveCodexWriterProof([{
    pid: 100,
    output: `p100\nf20\nau\nn${paths.parent}\nf21\nau\nn${paths.childA}\nf22\nau\nn${paths.childB}\n`,
  }], sessionsDir);
  const metadata = new Map([
    [paths.parent, { meta: { id: 'parent', source: 'cli' } }],
    [paths.childA, { meta: { id: 'child-a', source: 'subagent' } }],
    [paths.childB, { meta: { id: 'child-b', source: 'subagent' } }],
  ]);
  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async (filePath) => metadata.get(filePath),
    isUserSession: (meta) => meta.source === 'cli',
  });
  assert.equal(proof.status, 'owned');
  assert.equal(proof.filePath, paths.parent);
  assert.equal(proof.ignoredCandidates.length, 2);
});

test('two user TUI writable rollouts remain ambiguous after subagent filtering', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const first = sessionsDir + '/rollout-user-a.jsonl';
  const second = sessionsDir + '/rollout-user-b.jsonl';
  const descriptorProof = resolveCodexWriterProof([{
    pid: 100,
    output: `p100\nf20\nau\nn${first}\nf21\nau\nn${second}\n`,
  }], sessionsDir);
  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async (filePath) => ({ meta: { id: filePath.includes('user-a') ? 'user-a' : 'user-b', source: 'cli' } }),
    isUserSession: () => true,
  });
  assert.equal(proof.status, 'ambiguous');
  assert.equal(proof.candidates.length, 2);
});

test('explicit native Rewind selects the one direct child with exact-generation live proof', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const source = sessionsDir + '/rollout-source.jsonl';
  const child = sessionsDir + '/rollout-child.jsonl';
  const descriptorProof = resolveCodexWriterProof([{
    pid: 100,
    output: `p100\nf20\nau\nn${source}\nf21\nau\nn${child}\n`,
  }], sessionsDir);
  const metadata = new Map([
    [source, { meta: { id: 'source', source: 'cli' } }],
    [child, { meta: { id: 'child', forked_from_id: 'source', source: 'cli' } }],
  ]);
  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async (filePath) => metadata.get(filePath),
    isUserSession: () => true,
    handoff: {
      kind: 'native-rewind',
      sourceSessionId: 'source',
      actionGeneration: 'rewind-7',
      observerGeneration: 'rewind-7',
      actionStartedAtMs: 7000,
      liveProofs: [{
        sessionId: 'child',
        actionGeneration: 'rewind-7',
        kind: 'rollout-created',
        boundaryAtMs: 7001,
        observedAtMs: 7002,
      }],
    },
  });

  assert.equal(proof.status, 'owned');
  assert.equal(proof.filePath, child);
  assert.equal(proof.handoffProof.sessionId, 'child');
  assert.equal(proof.handoffProof.lineageRelation, 'direct-child');
  assert.equal(proof.handoffProof.lineageDepth, 1);
});

test('explicit native Rewind does not accept a sole still-open source rollout', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const source = sessionsDir + '/rollout-source.jsonl';
  const descriptorProof = resolveCodexWriterProof([{
    pid: 100,
    output: `p100\nf20\nau\nn${source}\n`,
  }], sessionsDir);
  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async () => ({ meta: { id: 'source', source: 'cli' } }),
    isUserSession: () => true,
    handoff: {
      kind: 'native-rewind',
      sourceSessionId: 'source',
      actionGeneration: 'rewind-source-only',
      observerGeneration: 'rewind-source-only',
      actionStartedAtMs: 7100,
      liveProofs: [],
    },
  });

  assert.equal(proof.status, 'ambiguous');
  assert.equal(proof.reason, 'handoff-branch-unresolved');
  assert.equal(proof.handoffProof.reason, 'no-proven-descendant');
});

test('log fixture: exact durable Rewind may keep the sole source rollout on the same PTY generation', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const sourceSessionId = '019f8f94-993d-7011-ad76-a29419fcd523';
  const source = sessionsDir + '/2026/07/23/rollout-2026-07-23T18-25-08-'
    + sourceSessionId + '.jsonl';
  const actionGeneration = 'codex-writer-handoff-1784896350953-4';
  const descriptorProof = resolveCodexWriterProof([{
    pid: 8928,
    output: `p8928\nf20\nau\nn${source}\n`,
  }], sessionsDir);
  const stableSourceProof = {
    kind: 'native-rewind-stable-source',
    sessionId: sourceSessionId,
    actionGeneration,
    journalPhase: 'rollback-applied',
    rollbackDurable: true,
    terminalGenerationMatches: true,
    runSeqMatches: true,
    boundSessionMatches: true,
    appliedAtMs: 1784896352330,
  };
  const handoff = {
    kind: 'native-rewind',
    sourceSessionId,
    actionGeneration,
    observerGeneration: actionGeneration,
    actionStartedAtMs: 1784896351138,
    liveProofs: [],
    stableSourceProof,
  };
  const metadata = new Map([
    [source, { meta: { id: sourceSessionId, source: 'cli' } }],
  ]);

  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async (filePath) => metadata.get(filePath),
    isUserSession: () => true,
    handoff,
  });

  assert.equal(proof.status, 'owned');
  assert.equal(proof.filePath, source);
  assert.equal(proof.handoffProof.lineageRelation, 'stable-source');
  assert.equal(proof.handoffProof.stableSourceProof.rollbackDurable, true);

  const sibling = sessionsDir + '/rollout-unrelated.jsonl';
  const ambiguousDescriptor = resolveCodexWriterProof([{
    pid: 8928,
    output: `p8928\nf20\nau\nn${source}\nf21\nau\nn${sibling}\n`,
  }], sessionsDir);
  metadata.set(sibling, { meta: { id: 'unrelated', source: 'cli' } });
  const ambiguous = await resolveCodexUserWriterProof(ambiguousDescriptor, {
    readMetadata: async (filePath) => metadata.get(filePath),
    isUserSession: () => true,
    handoff,
  });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.handoffProof.reason, 'no-proven-descendant');
});

test('explicit native Rewind accepts a sole child only with exact live proof', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const child = sessionsDir + '/rollout-child.jsonl';
  const descriptorProof = resolveCodexWriterProof([{
    pid: 100,
    output: `p100\nf20\nau\nn${child}\n`,
  }], sessionsDir);
  const common = {
    readMetadata: async () => ({
      meta: { id: 'child', forked_from_id: 'source', source: 'cli' },
    }),
    isUserSession: () => true,
  };
  const withoutProof = await resolveCodexUserWriterProof(descriptorProof, {
    ...common,
    handoff: {
      kind: 'native-rewind',
      sourceSessionId: 'source',
      actionGeneration: 'rewind-child-only',
      observerGeneration: 'rewind-child-only',
      actionStartedAtMs: 7200,
      liveProofs: [],
    },
  });
  assert.equal(withoutProof.status, 'ambiguous');

  const withProof = await resolveCodexUserWriterProof(descriptorProof, {
    ...common,
    handoff: {
      kind: 'native-rewind',
      sourceSessionId: 'source',
      actionGeneration: 'rewind-child-only',
      observerGeneration: 'rewind-child-only',
      actionStartedAtMs: 7200,
      liveProofs: [{
        sessionId: 'child',
        actionGeneration: 'rewind-child-only',
        kind: 'rollout-created',
        boundaryAtMs: 7201,
        observedAtMs: 7202,
      }],
    },
  });
  assert.equal(withProof.status, 'owned');
  assert.equal(withProof.filePath, child);
  assert.equal(withProof.handoffProof.sessionId, 'child');
});

test('native Rewind can select a proven descendant through a supplied lineage chain', () => {
  const sourceCandidate = {
    filePath: '/sessions/source.jsonl',
    meta: { id: 'source' },
  };
  const descendantCandidate = {
    filePath: '/sessions/grandchild.jsonl',
    meta: { id: 'grandchild', forked_from_id: 'child' },
  };
  const selection = selectCodexNativeRewindWriter(
    [sourceCandidate, descendantCandidate],
    {
      kind: 'native-rewind',
      sourceSessionId: 'source',
      actionGeneration: 'rewind-8',
      observerGeneration: 'rewind-8',
      actionStartedAtMs: 8000,
      lineage: [{ sessionId: 'child', forkedFromId: 'source' }],
      liveProofs: [{
        sessionId: 'grandchild',
        actionGeneration: 'rewind-8',
        kind: 'task-started',
        boundaryAtMs: 8010,
        observedAtMs: 8011,
      }],
    },
  );

  assert.equal(selection.status, 'selected');
  assert.equal(selection.sessionId, 'grandchild');
  assert.equal(selection.lineageRelation, 'descendant');
  assert.equal(selection.lineageDepth, 2);
});

test('native Rewind never chooses a child from lineage or recency alone', () => {
  const candidates = [
    { filePath: '/sessions/source.jsonl', meta: { id: 'source' } },
    {
      filePath: '/sessions/child.jsonl',
      meta: { id: 'child', forked_from_id: 'source', timestamp: '2099-01-01T00:00:00.000Z' },
    },
  ];
  const base = {
    kind: 'native-rewind',
    sourceSessionId: 'source',
    actionGeneration: 'rewind-9',
    observerGeneration: 'rewind-9',
    actionStartedAtMs: 9000,
  };

  const withoutLiveProof = selectCodexNativeRewindWriter(candidates, base);
  assert.equal(withoutLiveProof.status, 'unresolved');
  assert.equal(withoutLiveProof.reason, 'no-proven-descendant');
  assert.equal(withoutLiveProof.rejected.find((item) => item.sessionId === 'child')?.reason,
    'post-action-live-proof-missing');

  const copiedPreActionEvent = selectCodexNativeRewindWriter(candidates, {
    ...base,
    liveProofs: [{
      sessionId: 'child',
      actionGeneration: 'rewind-9',
      kind: 'task-started',
      boundaryAtMs: 8999,
      observedAtMs: 9001,
    }],
  });
  assert.equal(copiedPreActionEvent.status, 'unresolved');
});

test('native Rewind rejects stale generations, unrelated writers, and multiple proven descendants', () => {
  const candidates = [
    { filePath: '/sessions/source.jsonl', meta: { id: 'source' } },
    { filePath: '/sessions/child-a.jsonl', meta: { id: 'child-a', forked_from_id: 'source' } },
    { filePath: '/sessions/child-b.jsonl', meta: { id: 'child-b', forked_from_id: 'source' } },
    { filePath: '/sessions/unrelated.jsonl', meta: { id: 'unrelated', forked_from_id: 'other' } },
  ];
  const proofFor = (sessionId) => ({
    sessionId,
    actionGeneration: 'rewind-10',
    kind: 'rollout-live-append',
    boundaryAtMs: 10001,
    observedAtMs: 10002,
  });

  const stale = selectCodexNativeRewindWriter(candidates, {
    kind: 'native-rewind',
    sourceSessionId: 'source',
    actionGeneration: 'rewind-10',
    observerGeneration: 'rewind-11',
    actionStartedAtMs: 10000,
    liveProofs: [proofFor('child-a')],
  });
  assert.equal(stale.reason, 'stale-action-generation');

  const unrelatedOnly = selectCodexNativeRewindWriter(candidates, {
    kind: 'native-rewind',
    sourceSessionId: 'source',
    actionGeneration: 'rewind-10',
    observerGeneration: 'rewind-10',
    actionStartedAtMs: 10000,
    liveProofs: [proofFor('unrelated')],
  });
  assert.equal(unrelatedOnly.reason, 'no-proven-descendant');

  const multiple = selectCodexNativeRewindWriter(candidates, {
    kind: 'native-rewind',
    sourceSessionId: 'source',
    actionGeneration: 'rewind-10',
    observerGeneration: 'rewind-10',
    actionStartedAtMs: 10000,
    liveProofs: [proofFor('child-a'), proofFor('child-b')],
  });
  assert.equal(multiple.reason, 'multiple-proven-descendants');
});

test('native Rewind accepts a root replacement only with exact target-prefix and live action proof', () => {
  const actionGeneration = 'rewind-root-replacement';
  const actionStartedAtMs = 12_000;
  const targetTextHash = 'a'.repeat(64);
  const sourceMessages = [
    { uuid: 'source-1', sourceLine: 10, textHash: 'b'.repeat(64), signature: 'sig-1', timestampMs: 10_000 },
    { uuid: 'source-2', sourceLine: 20, textHash: targetTextHash, signature: 'sig-2', timestampMs: 11_000 },
  ];
  const replacement = {
    filePath: '/sessions/replacement.jsonl',
    meta: { id: 'replacement', timestamp: new Date(12_001).toISOString() },
  };
  const replacementProof = classifyCodexNativeRewindReplacementProjection({
    sourceSessionId: 'source',
    candidateSessionId: 'replacement',
    actionGeneration,
    actionStartedAtMs,
    candidateCreatedAtMs: 12_001,
    targetUuid: 'source-2',
    targetSourceLine: 20,
    targetTextHash,
    rollbackTurns: 1,
    sourceMessages,
    candidateMessages: [
      sourceMessages[0],
      { uuid: 'replacement-new', sourceLine: 30, signature: 'new', timestampMs: 12_010 },
    ],
  });
  assert.equal(replacementProof.proven, true);

  const selected = selectCodexNativeRewindWriter([replacement], {
    kind: 'native-rewind',
    sourceSessionId: 'source',
    actionGeneration,
    observerGeneration: actionGeneration,
    actionStartedAtMs,
    targetUuid: 'source-2',
    targetSourceLine: 20,
    targetTextHash,
    rollbackTurns: 1,
    replacementProofs: [replacementProof],
    liveProofs: [{
      sessionId: 'replacement',
      actionGeneration,
      kind: 'rollout-created',
      boundaryAtMs: 12_001,
      observedAtMs: 12_002,
    }],
  });
  assert.equal(selected.status, 'selected');
  assert.equal(selected.lineageRelation, 'rewind-replacement');
  assert.equal(selected.replacementProof.reason, 'exact-target-prefix');
});

test('Codex 0.145 root replacement with an empty retained prefix resolves through the full writer filter', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const sourcePath = sessionsDir + '/rollout-source-c1.jsonl';
  const replacementPath = sessionsDir + '/rollout-replacement-c2.jsonl';
  const descriptorProof = resolveCodexWriterProof([{
    pid: 410,
    output: `p410\nf20\nau\nn${sourcePath}\nf21\nau\nn${replacementPath}\n`,
  }], sessionsDir);
  const actionGeneration = 'rewind-codex-0145';
  const actionStartedAtMs = 50_000;
  const targetTextHash = '1'.repeat(64);
  const replacementProof = classifyCodexNativeRewindReplacementProjection({
    sourceSessionId: 'c1',
    candidateSessionId: 'c2',
    actionGeneration,
    actionStartedAtMs,
    candidateCreatedAtMs: 50_001,
    targetUuid: 'codex-user-c1-9',
    targetSourceLine: 9,
    targetTextHash,
    rollbackTurns: 1,
    sourceMessages: [{
      uuid: 'codex-user-c1-9',
      sourceLine: 9,
      textHash: targetTextHash,
      signature: 'original-target',
      timestampMs: 49_000,
    }],
    candidateMessages: [{
      uuid: 'codex-user-c2-10',
      sourceLine: 10,
      textHash: '2'.repeat(64),
      signature: 'edited-restored-prompt',
      timestampMs: 50_020,
    }],
  });
  const metadata = new Map([
    [sourcePath, { meta: { id: 'c1', source: 'cli' } }],
    [replacementPath, {
      meta: {
        id: 'c2',
        source: 'cli',
        timestamp: new Date(50_001).toISOString(),
        forked_from_id: null,
      },
    }],
  ]);
  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async filePath => metadata.get(filePath),
    isUserSession: () => true,
    handoff: {
      kind: 'native-rewind',
      sourceSessionId: 'c1',
      actionGeneration,
      observerGeneration: actionGeneration,
      actionStartedAtMs,
      targetUuid: 'codex-user-c1-9',
      targetSourceLine: 9,
      targetTextHash,
      rollbackTurns: 1,
      replacementProofs: [replacementProof],
      liveProofs: [{
        sessionId: 'c2',
        actionGeneration,
        kind: 'rollout-created',
        boundaryAtMs: 50_001,
        observedAtMs: 50_002,
      }],
    },
  });
  assert.equal(proof.status, 'owned');
  assert.equal(proof.filePath, replacementPath);
  assert.equal(proof.handoffProof.lineageRelation, 'rewind-replacement');
});

test('root replacement proof rejects wrong prefix, stale suffix, and declared fork lineage', () => {
  const base = {
    sourceSessionId: 'source',
    candidateSessionId: 'replacement',
    actionGeneration: 'rewind-root-reject',
    actionStartedAtMs: 20_000,
    candidateCreatedAtMs: 20_001,
    targetUuid: 'source-2',
    targetSourceLine: 20,
    targetTextHash: 'c'.repeat(64),
    rollbackTurns: 1,
    sourceMessages: [
      { uuid: 'source-1', sourceLine: 10, textHash: 'd'.repeat(64), signature: 'sig-1', timestampMs: 18_000 },
      { uuid: 'source-2', sourceLine: 20, textHash: 'c'.repeat(64), signature: 'sig-2', timestampMs: 19_000 },
    ],
  };
  assert.equal(classifyCodexNativeRewindReplacementProjection({
    ...base,
    candidateMessages: [{ signature: 'wrong', timestampMs: 18_000 }],
  }).reason, 'replacement-prefix-content-mismatch');
  assert.equal(classifyCodexNativeRewindReplacementProjection({
    ...base,
    candidateMessages: [base.sourceMessages[0], { signature: 'old', timestampMs: 19_999 }],
  }).reason, 'replacement-suffix-outside-action-epoch');
  assert.equal(classifyCodexNativeRewindReplacementProjection({
    ...base,
    candidateForkedFromId: 'other',
    candidateMessages: [base.sourceMessages[0]],
  }).reason, 'replacement-declared-lineage-present');
});

test('two exact root replacements remain ambiguous instead of choosing by recency', () => {
  const actionGeneration = 'rewind-root-ambiguous';
  const targetTextHash = 'e'.repeat(64);
  const sourceMessages = [{
    uuid: 'target', sourceLine: 4, textHash: targetTextHash, signature: 'target', timestampMs: 29_000,
  }];
  const proofFor = (sessionId, createdAtMs) => classifyCodexNativeRewindReplacementProjection({
    sourceSessionId: 'source',
    candidateSessionId: sessionId,
    actionGeneration,
    actionStartedAtMs: 30_000,
    candidateCreatedAtMs: createdAtMs,
    targetUuid: 'target',
    targetSourceLine: 4,
    targetTextHash,
    rollbackTurns: 1,
    sourceMessages,
    candidateMessages: [],
  });
  const candidates = ['replacement-a', 'replacement-b'].map(id => ({
    filePath: '/sessions/' + id + '.jsonl',
    meta: { id },
  }));
  const selection = selectCodexNativeRewindWriter(candidates, {
    kind: 'native-rewind',
    sourceSessionId: 'source',
    actionGeneration,
    observerGeneration: actionGeneration,
    actionStartedAtMs: 30_000,
    targetUuid: 'target',
    targetSourceLine: 4,
    targetTextHash,
    rollbackTurns: 1,
    replacementProofs: [proofFor('replacement-a', 30_001), proofFor('replacement-b', 30_002)],
    liveProofs: ['replacement-a', 'replacement-b'].map((sessionId, index) => ({
      sessionId,
      actionGeneration,
      kind: 'rollout-created',
      boundaryAtMs: 30_001 + index,
      observedAtMs: 30_003,
    })),
  });
  assert.equal(selection.status, 'unresolved');
  assert.equal(selection.reason, 'multiple-proven-rewind-writers');
});

test('restart reconcile accepts only the recorded root replacement and tolerates later turns', () => {
  const computed = {
    proven: true,
    kind: 'rewind-replacement',
    sessionId: 'replacement',
    sourceSessionId: 'source',
    actionGeneration: 'rewind-restart',
    candidateCreatedAtMs: 40_001,
    targetUuid: 'target',
    targetSourceLine: 9,
    targetTextHash: 'f'.repeat(64),
    rollbackTurns: 2,
    retainedPrefixLength: 3,
    postActionMessageCount: 4,
  };
  const recorded = {
    version: 1,
    kind: 'rewind-replacement',
    sessionId: 'replacement',
    sourceSessionId: 'source',
    actionGeneration: 'rewind-restart',
    candidateCreatedAtMs: 40_001,
    targetUuid: 'target',
    targetSourceLine: 9,
    targetTextHash: 'f'.repeat(64),
    rollbackTurns: 2,
    retainedPrefixLength: 3,
    postActionMessageCount: 1,
  };
  const reconciled = reconcileCodexNativeRewindReplacementProof(computed, recorded);
  assert.equal(reconciled.proven, true);
  assert.equal(reconciled.reason, 'exact-recorded-replacement');
  assert.equal(reconcileCodexNativeRewindReplacementProof(computed, {
    ...recorded,
    sessionId: 'unrelated',
  }).reason, 'replacement-durable-proof-identity-mismatch');
  assert.equal(reconcileCodexNativeRewindReplacementProof({
    ...computed,
    postActionMessageCount: 0,
  }, recorded).reason, 'replacement-durable-proof-regressed');
});

test('settled native Rewind proof resolves source plus exact child only while every scope still matches', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const source = sessionsDir + '/rollout-source.jsonl';
  const child = sessionsDir + '/rollout-child.jsonl';
  const terminalToken = {};
  const descriptorProof = resolveCodexWriterProof([{
    pid: 100,
    output: `p100\nf20\nau\nn${source}\nf21\nau\nn${child}\n`,
  }], sessionsDir);
  const metadata = new Map([
    [source, { meta: { id: 'source', source: 'cli' } }],
    [child, { meta: { id: 'child', forked_from_id: 'source', source: 'cli' } }],
  ]);
  const settledWriter = {
    kind: 'native-rewind-settled-writer',
    valid: true,
    sessionId: 'child',
    filePath: child,
    sourceSessionId: 'source',
    actionGeneration: 'rewind-settled-1',
    observerGeneration: 'rewind-settled-1',
    terminalToken,
    observerTerminalToken: terminalToken,
    runSeq: 12,
    observerRunSeq: 12,
    boundSessionId: 'child',
  };
  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async (filePath) => metadata.get(filePath),
    isUserSession: () => true,
    settledWriter,
  });

  assert.equal(proof.status, 'owned');
  assert.equal(proof.filePath, child);
  assert.equal(proof.settledWriterProof.sessionId, 'child');
  assert.deepEqual(proof.settledWriterProof.ancestors, [{
    sessionId: 'source',
    lineageDepth: 1,
  }]);
});

test('settled Rewind writer remains authoritative only before the next durable handoff boundary', () => {
  for (const empty of [null, undefined, '', 0, -1, Number.NaN]) {
    assert.equal(
      hasCodexWriterHandoffActionBoundary(empty),
      false,
      String(empty),
    );
  }
  assert.equal(hasCodexWriterHandoffActionBoundary(1_724_000_000_000), true);
  assert.equal(shouldUseSettledCodexRewindWriterProof({
    sourceMode: 'writer-handoff',
    handoffActionStartedAtMs: null,
  }), true);
  assert.equal(shouldUseSettledCodexRewindWriterProof({
    sourceMode: 'writer-handoff',
    handoffActionStartedAtMs: undefined,
  }), true);
  assert.equal(shouldUseSettledCodexRewindWriterProof({
    sourceMode: 'writer-handoff',
    handoffActionStartedAtMs: '',
  }), true);
  assert.equal(shouldUseSettledCodexRewindWriterProof({
    sourceMode: 'writer-handoff',
    handoffActionStartedAtMs: 0,
  }), true, 'zero is an unset/invalid timestamp, not a durable action boundary');
  assert.equal(shouldUseSettledCodexRewindWriterProof({
    sourceMode: 'writer-handoff',
    handoffActionStartedAtMs: 1_724_000_000_000,
  }), false);
  assert.equal(shouldUseSettledCodexRewindWriterProof({
    sourceMode: 'resume',
    handoffActionStartedAtMs: 1_724_000_000_000,
  }), true);
});

test('settled Rewind proof fails closed for stale scope, wrong identity, or non-ancestor writers', () => {
  const terminalToken = {};
  const candidates = [
    { filePath: '/sessions/source.jsonl', meta: { id: 'source' } },
    {
      filePath: '/sessions/child.jsonl',
      meta: { id: 'child', forked_from_id: 'source' },
    },
  ];
  const base = {
    kind: 'native-rewind-settled-writer',
    valid: true,
    sessionId: 'child',
    filePath: '/sessions/child.jsonl',
    sourceSessionId: 'source',
    actionGeneration: 'rewind-settled-2',
    observerGeneration: 'rewind-settled-2',
    terminalToken,
    observerTerminalToken: terminalToken,
    runSeq: 22,
    observerRunSeq: 22,
    boundSessionId: 'child',
  };
  assert.equal(selectCodexSettledRewindWriter(candidates, {
    ...base,
    observerGeneration: 'rewind-settled-newer',
  }).reason, 'stale-settled-writer-generation');
  assert.equal(selectCodexSettledRewindWriter(candidates, {
    ...base,
    observerTerminalToken: {},
  }).reason, 'stale-settled-writer-terminal');
  assert.equal(selectCodexSettledRewindWriter(candidates, {
    ...base,
    observerRunSeq: 23,
  }).reason, 'stale-settled-writer-run');
  assert.equal(selectCodexSettledRewindWriter(candidates, {
    ...base,
    boundSessionId: 'source',
  }).reason, 'settled-writer-binding-mismatch');
  assert.equal(selectCodexSettledRewindWriter(candidates, {
    ...base,
    filePath: '/sessions/not-child.jsonl',
  }).reason, 'settled-writer-candidate-missing');
  assert.equal(selectCodexSettledRewindWriter(candidates, {
    ...base,
    sessionId: 'other-child',
    boundSessionId: 'other-child',
  }).reason, 'settled-writer-candidate-missing');

  const sibling = {
    filePath: '/sessions/sibling.jsonl',
    meta: { id: 'sibling', forked_from_id: 'source' },
  };
  const withSibling = selectCodexSettledRewindWriter(
    [...candidates, sibling],
    base,
  );
  assert.equal(withSibling.reason, 'settled-writer-competitor-not-ancestor');
  assert.equal(withSibling.rejectedSessionId, 'sibling');

  const descendant = {
    filePath: '/sessions/grandchild.jsonl',
    meta: { id: 'grandchild', forked_from_id: 'child' },
  };
  const withDescendant = selectCodexSettledRewindWriter(
    [...candidates, descendant],
    base,
  );
  assert.equal(withDescendant.reason, 'settled-writer-competitor-not-ancestor');
  assert.equal(withDescendant.rejectedSessionId, 'grandchild');
});

test('settled stable-source proof survives an ordinary sole-source revalidation', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const source = sessionsDir + '/rollout-source-stable.jsonl';
  const terminalToken = {};
  const descriptorProof = resolveCodexWriterProof([{
    pid: 101,
    output: `p101\nf20\nau\nn${source}\n`,
  }], sessionsDir);
  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async () => ({
      meta: { id: 'source-stable', source: 'cli', cwd: '/work' },
    }),
    isUserSession: () => true,
    settledWriter: {
      kind: 'native-rewind-settled-writer',
      valid: true,
      sessionId: 'source-stable',
      filePath: source,
      sourceSessionId: 'source-stable',
      actionGeneration: 'rewind-stable',
      observerGeneration: 'rewind-stable',
      terminalToken,
      observerTerminalToken: terminalToken,
      runSeq: 8,
      observerRunSeq: 8,
      boundSessionId: 'source-stable',
    },
  });

  assert.equal(proof.status, 'owned');
  assert.equal(proof.filePath, source);
  assert.equal(proof.settledWriterProof.lineageRelation, 'stable-source');
});

test('delayed stable-source writer requires one exact post-Enter audit on the current PTY scope', () => {
  const terminalToken = {};
  const source = {
    filePath: '/sessions/source-delayed.jsonl',
    meta: { id: 'source-delayed', source: 'cli', cwd: '/work' },
  };
  const child = {
    filePath: '/sessions/child-delayed.jsonl',
    meta: {
      id: 'child-delayed',
      source: 'cli',
      cwd: '/work',
      forked_from_id: null,
    },
  };
  const base = {
    kind: 'native-rewind-delayed-stable-source',
    valid: true,
    sourceSessionId: 'source-delayed',
    sourceFilePath: source.filePath,
    actionGeneration: 'rewind-delayed-1',
    observerGeneration: 'rewind-delayed-1',
    actionStartedAtMs: 1000,
    stableSourceSettledAtMs: 1100,
    journalPhase: 'stable-source-submit-written',
    terminalToken,
    observerTerminalToken: terminalToken,
    runSeq: 9,
    observerRunSeq: 9,
    boundSessionId: 'source-delayed',
    cwd: '/work',
    submitProof: {
      submitId: 'submit-1',
      sourceSessionId: 'source-delayed',
      actionGeneration: 'rewind-delayed-1',
      expectedLen: 12,
      expectedHash: '0123456789abcdef',
      sentAtMs: 1200,
      submitWrittenAtMs: 1210,
    },
    liveProofs: [{
      kind: 'user-message-audit',
      sessionId: 'child-delayed',
      sourceSessionId: 'source-delayed',
      actionGeneration: 'rewind-delayed-1',
      submitId: 'submit-1',
      expectedLen: 12,
      expectedHash: '0123456789abcdef',
      auditSentAtMs: 1200,
      candidateCreatedAtMs: 1215,
      recordTimestampMs: 1220,
      observedAtMs: 1230,
    }],
  };

  const selected = selectCodexDelayedStableSourceWriter([source, child], base);
  assert.equal(selected.status, 'selected');
  assert.equal(selected.sessionId, 'child-delayed');
  assert.equal(selected.lineageRelation, 'delayed-stable-source-child');
  const sourceDescriptorClosed = selectCodexDelayedStableSourceWriter([child], base);
  assert.equal(sourceDescriptorClosed.status, 'selected');
  assert.equal(sourceDescriptorClosed.sessionId, 'child-delayed');

  const cases = [
    ['no audit', { liveProofs: [] }, 'delayed-audit-writer-missing'],
    ['wrong hash', {
      liveProofs: [{ ...base.liveProofs[0], expectedHash: 'fedcba9876543210' }],
    }, 'delayed-audit-writer-missing'],
    ['record before Enter', {
      liveProofs: [{ ...base.liveProofs[0], recordTimestampMs: 1199 }],
    }, 'delayed-audit-writer-missing'],
    ['candidate before Enter', {
      liveProofs: [{ ...base.liveProofs[0], candidateCreatedAtMs: 1199 }],
    }, 'delayed-audit-writer-missing'],
    ['submit not written', {
      journalPhase: 'stable-source-submit-armed',
    }, 'delayed-submit-not-written'],
    ['stale terminal', {
      observerTerminalToken: {},
    }, 'stale-delayed-terminal'],
    ['stale run', {
      observerRunSeq: 10,
    }, 'stale-delayed-run'],
    ['stale action', {
      observerGeneration: 'rewind-delayed-2',
    }, 'stale-delayed-action-generation'],
    ['binding changed', {
      boundSessionId: 'unrelated',
    }, 'delayed-source-binding-mismatch'],
  ];
  for (const [label, override, expectedReason] of cases) {
    const result = selectCodexDelayedStableSourceWriter(
      [source, child],
      { ...base, ...override },
    );
    assert.equal(result.status, 'unresolved', label);
    assert.equal(result.reason, expectedReason, label);
  }

  const wrongCwd = {
    ...child,
    meta: { ...child.meta, cwd: '/other' },
  };
  assert.equal(
    selectCodexDelayedStableSourceWriter([source, wrongCwd], base).reason,
    'delayed-candidate-cwd-mismatch',
  );

  const secondChild = {
    filePath: '/sessions/child-delayed-2.jsonl',
    meta: { id: 'child-delayed-2', source: 'cli', cwd: '/work' },
  };
  const twoMatches = selectCodexDelayedStableSourceWriter(
    [source, child, secondChild],
    {
      ...base,
      liveProofs: [
        base.liveProofs[0],
        { ...base.liveProofs[0], sessionId: 'child-delayed-2' },
      ],
    },
  );
  assert.equal(twoMatches.status, 'unresolved');
  assert.equal(twoMatches.reason, 'multiple-delayed-audit-writers');
});

test('delayed stable-source watch targets stay inside the exact sessions root and cwd', () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-delayed-watch-'));
  const cwd = path.join(sessionsDir, 'workspace');
  const sourcePath = path.join(sessionsDir, 'source.jsonl');
  const childPath = path.join(sessionsDir, 'child.jsonl');
  const outsidePath = path.join(os.tmpdir(), 'outside-delayed-child.jsonl');
  fs.writeFileSync(sourcePath, '');
  fs.writeFileSync(childPath, '');
  const candidates = [
    { filePath: sourcePath, meta: { id: 'source', cwd } },
    { filePath: childPath, meta: { id: 'child', cwd } },
    { filePath: childPath, meta: { id: 'child-duplicate', cwd } },
    {
      filePath: path.join(sessionsDir, 'wrong-cwd.jsonl'),
      meta: { id: 'wrong-cwd', cwd: '/other' },
    },
    { filePath: outsidePath, meta: { id: 'outside', cwd } },
    {
      filePath: path.join(sessionsDir, 'not-jsonl.txt'),
      meta: { id: 'wrong-extension', cwd },
    },
  ];
  assert.deepEqual(selectCodexDelayedWriterWatchTargets(candidates, {
    sourceSessionId: 'source',
    cwd,
    sessionsDir,
  }), [{ sessionId: 'child', filePath: fs.realpathSync(childPath) }]);
  assert.deepEqual(selectCodexDelayedWriterWatchTargets(candidates, {
    sourceSessionId: null,
    cwd,
    sessionsDir,
  }), []);
});

test('a queued observer accepts only the exact already-committed native Rewind transaction', () => {
  const terminalToken = {};
  const intent = {
    sourceMode: 'writer-handoff',
    sourceSessionId: 'source-a',
    launchId: 'rewind-a-b',
  };
  const proof = {
    kind: 'native-rewind-settled-writer',
    valid: true,
    sessionId: 'child-b',
    sourceSessionId: 'source-a',
    actionGeneration: 'rewind-a-b',
    terminalToken,
    runSeq: 41,
  };
  const base = {
    intent,
    candidateSessionId: 'child-b',
    proof,
    boundSessionId: 'child-b',
    terminalToken,
    runSeq: 41,
    currentIntentGeneration: 'rewind-a-b',
    observerCurrent: true,
  };
  assert.equal(isCommittedCodexNativeRewindReplay(base), true);
  assert.equal(isCommittedCodexNativeRewindReplay({
    ...base,
    proof: { ...proof, kind: 'native-rewind-replacement' },
  }), true, 'an exact root replacement uses the same idempotent commit boundary');
  assert.equal(isCommittedCodexNativeRewindReplay({
    ...base,
    intent: { ...intent, launchId: 'rewind-b-c' },
  }), false, 'a newer Rewind generation cannot borrow the previous commit');
  assert.equal(isCommittedCodexNativeRewindReplay({
    ...base,
    proof: { ...proof, valid: false },
  }), false);
  assert.equal(isCommittedCodexNativeRewindReplay({
    ...base,
    boundSessionId: 'source-a',
  }), false);
  assert.equal(isCommittedCodexNativeRewindReplay({
    ...base,
    candidateSessionId: 'source-a',
    proof: { ...proof, sessionId: 'source-a' },
    boundSessionId: 'source-a',
  }), false, 'stable source cannot impersonate an already-committed child');
  assert.equal(isCommittedCodexNativeRewindReplay({
    ...base,
    terminalToken: {},
  }), false);
  assert.equal(isCommittedCodexNativeRewindReplay({
    ...base,
    runSeq: 42,
  }), false);
  assert.equal(isCommittedCodexNativeRewindReplay({
    ...base,
    currentIntentGeneration: 'rewind-b-c',
  }), false, 'a queued A→B replay cannot finish after B→C is armed');
  assert.equal(isCommittedCodexNativeRewindReplay({
    ...base,
    observerCurrent: false,
  }), false, 'a replaced observer cannot replay a completed handoff');
});

test('an exact post-action writer consumes its handoff observer, while a quarantined manual writer does not', () => {
  const selection = {
    status: 'selected',
    sessionId: 'replacement-c2',
    actionGeneration: 'rewind-c1-c2',
  };
  assert.deepEqual(classifyCodexWriterHandoffObserverAdoption({
    actionBoundarySet: true,
    selection,
    actionGeneration: 'rewind-c1-c2',
    adoptedSessionId: 'replacement-c2',
    baselineSessionId: 'manual-c1',
  }), {
    accepted: true,
    exactActionWriter: true,
    manualWriterChange: false,
    finalizeObserver: true,
  });

  assert.deepEqual(classifyCodexWriterHandoffObserverAdoption({
    actionBoundarySet: false,
    selection: null,
    actionGeneration: null,
    adoptedSessionId: 'manual-c1',
    baselineSessionId: 'persisted-a',
  }), {
    accepted: true,
    exactActionWriter: false,
    manualWriterChange: true,
    finalizeObserver: false,
  }, 'manual C1 must remain quarantined so the same observer can own later Rewind');

  assert.equal(classifyCodexWriterHandoffObserverAdoption({
    actionBoundarySet: true,
    selection: { ...selection, sessionId: 'other' },
    actionGeneration: 'rewind-c1-c2',
    adoptedSessionId: 'replacement-c2',
    baselineSessionId: 'manual-c1',
  }).accepted, false);
});

test('a committed root replacement stays authoritative while its exact runtime source is still writable', () => {
  const terminalToken = {};
  const source = {
    filePath: '/sessions/manual-c1.jsonl',
    meta: { id: 'manual-c1', forked_from_id: 'unrelated-b' },
  };
  const replacement = {
    filePath: '/sessions/replacement-c2.jsonl',
    meta: { id: 'replacement-c2', forked_from_id: null },
  };
  const base = {
    kind: 'native-rewind-replacement',
    valid: true,
    sessionId: 'replacement-c2',
    filePath: replacement.filePath,
    sourceSessionId: 'manual-c1',
    actionGeneration: 'rewind-c1-c2',
    observerGeneration: 'rewind-c1-c2',
    terminalToken,
    observerTerminalToken: terminalToken,
    runSeq: 44,
    observerRunSeq: 44,
    boundSessionId: 'replacement-c2',
  };
  const selected = selectCodexSettledRewindWriter([source, replacement], base);
  assert.equal(selected.status, 'selected');
  assert.equal(selected.sessionId, 'replacement-c2');
  assert.equal(selected.lineageRelation, 'rewind-replacement');

  const unrelated = {
    filePath: '/sessions/unrelated-d.jsonl',
    meta: { id: 'unrelated-d', forked_from_id: null },
  };
  const held = selectCodexSettledRewindWriter([source, replacement, unrelated], base);
  assert.equal(held.status, 'unresolved');
  assert.equal(held.reason, 'replacement-settled-writer-unrelated-competitor');
});

test('the full public writer filter revalidates a committed root replacement after its handoff closes', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const source = sessionsDir + '/rollout-manual-c1.jsonl';
  const replacement = sessionsDir + '/rollout-replacement-c2.jsonl';
  const terminalToken = {};
  const descriptorProof = resolveCodexWriterProof([{
    pid: 100,
    output: `p100\nf20\nau\nn${source}\nf21\nau\nn${replacement}\n`,
  }], sessionsDir);
  const metadata = new Map([
    [source, { meta: { id: 'manual-c1', forked_from_id: 'unrelated-b', source: 'cli' } }],
    [replacement, { meta: { id: 'replacement-c2', forked_from_id: null, source: 'cli' } }],
  ]);
  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async filePath => metadata.get(filePath),
    isUserSession: () => true,
    settledWriter: {
      kind: 'native-rewind-replacement',
      valid: true,
      sessionId: 'replacement-c2',
      filePath: replacement,
      sourceSessionId: 'manual-c1',
      actionGeneration: 'rewind-c1-c2',
      observerGeneration: 'rewind-c1-c2',
      terminalToken,
      observerTerminalToken: terminalToken,
      runSeq: 44,
      observerRunSeq: 44,
      boundSessionId: 'replacement-c2',
    },
  });
  assert.equal(proof.status, 'owned');
  assert.equal(proof.filePath, replacement);
  assert.equal(proof.settledWriterProof.lineageRelation, 'rewind-replacement');
});

test('Rewind completion accepts either stable source or the exact child commit that consumed its journal', () => {
  assert.deepEqual(resolveCodexRewindCompletionProof({
    committedChildBeforeStableProof: true,
  }), {
    success: true,
    proofMode: 'committed-child',
    racedWithStableSourceProof: false,
  });
  assert.deepEqual(resolveCodexRewindCompletionProof({
    stableSourceProof: { success: true },
  }), {
    success: true,
    proofMode: 'stable-source',
    racedWithStableSourceProof: false,
  });
  assert.deepEqual(resolveCodexRewindCompletionProof({
    stableSourceProof: {
      success: false,
      error: 'codex_rewind_stable_source_proof_invalid',
    },
    committedChildAfterStableProof: true,
  }), {
    success: true,
    proofMode: 'committed-child',
    racedWithStableSourceProof: true,
  }, 'an exact child commit may win while the stable-source CAS is in flight');
  assert.deepEqual(resolveCodexRewindCompletionProof({
    stableSourceProof: {
      success: false,
      error: 'codex_rewind_stable_source_proof_invalid',
    },
  }), {
    success: false,
    proofMode: 'unresolved',
    error: 'codex_rewind_stable_source_proof_invalid',
  }, 'missing journal without an exact child proof remains a hard failure');
});

test('a durable Rewind receipt survives transient handoff cleanup but not a foreign runtime scope', () => {
  const terminalToken = {};
  const receipt = {
    receiptId: 'receipt-a-b',
    sourceSessionId: 'source-a',
    childSessionId: 'child-b',
    actionGeneration: 'rewind-a-b',
  };
  const base = {
    receipt,
    expectedTerminalToken: terminalToken,
    currentTerminalToken: terminalToken,
    expectedLifecycleGeneration: 'pty-generation:41',
    currentLifecycleGeneration: 'pty-generation:41',
    expectedRunSeq: 41,
    currentRunSeq: 41,
    pendingActionGeneration: null,
    knownSessionId: 'child-b',
    liveProof: null,
  };
  assert.deepEqual(classifyCodexRewindCommitReceiptRuntime(base), {
    accepted: true,
    reason: 'exact-committed-rewind-child',
    sourceSessionId: 'source-a',
    childSessionId: 'child-b',
    actionGeneration: 'rewind-a-b',
    receiptId: 'receipt-a-b',
  }, 'no watcher or discovery intent is needed after the exact commit');
  assert.equal(classifyCodexRewindCommitReceiptRuntime({
    ...base,
    currentTerminalToken: {},
  }).accepted, false);
  assert.equal(classifyCodexRewindCommitReceiptRuntime({
    ...base,
    currentLifecycleGeneration: 'pty-generation:42',
  }).accepted, false);
  assert.equal(classifyCodexRewindCommitReceiptRuntime({
    ...base,
    currentRunSeq: 42,
  }).accepted, false);
  assert.equal(classifyCodexRewindCommitReceiptRuntime({
    ...base,
    pendingActionGeneration: 'rewind-b-c',
  }).reason, 'commit-receipt-superseded');
  assert.equal(classifyCodexRewindCommitReceiptRuntime({
    ...base,
    knownSessionId: 'foreign-child',
  }).reason, 'commit-receipt-known-writer-changed');
  assert.equal(classifyCodexRewindCommitReceiptRuntime({
    ...base,
    liveProof: {
      valid: true,
      sessionId: 'foreign-child',
      sourceSessionId: 'source-a',
      actionGeneration: 'rewind-a-b',
      terminalToken,
      runSeq: 41,
    },
  }).reason, 'commit-receipt-live-writer-changed');
});

test('writer observation becomes stale before it may invalidate a newer proof', () => {
  const observer = {};
  assert.deepEqual(classifyCodexWriterObservationScope({
    capturedIntentGeneration: null,
    currentIntentGeneration: null,
    capturedObservationGeneration: 7,
    currentObservationGeneration: 9,
    expectedObserver: null,
    currentObserver: null,
  }), {
    status: 'stale-observation-generation',
    expectedObservationGeneration: 7,
    currentObservationGeneration: 9,
  }, 'null → Rewind → null is still stale after the monotonic ownership generation advances');

  assert.deepEqual(classifyCodexWriterObservationScope({
    capturedIntentGeneration: null,
    currentIntentGeneration: 'rewind-b-c',
    capturedObservationGeneration: 9,
    currentObservationGeneration: 9,
    expectedObserver: null,
    currentObserver: null,
  }), {
    status: 'stale-generation',
    expectedLaunchId: null,
    currentLaunchId: 'rewind-b-c',
  }, 'a public lookup started before Rewind must not invalidate its proof');

  assert.deepEqual(classifyCodexWriterObservationScope({
    capturedIntentGeneration: 'rewind-a-b',
    currentIntentGeneration: 'rewind-b-c',
    capturedObservationGeneration: 9,
    currentObservationGeneration: 9,
    expectedObserver: observer,
    currentObserver: observer,
  }), {
    status: 'stale-generation',
    expectedLaunchId: 'rewind-a-b',
    currentLaunchId: 'rewind-b-c',
  }, 'a queued A→B observer is stale once B→C starts');

  assert.deepEqual(classifyCodexWriterObservationScope({
    capturedIntentGeneration: 'rewind-b-c',
    currentIntentGeneration: 'rewind-b-c',
    capturedObservationGeneration: 9,
    currentObservationGeneration: 9,
    expectedObserver: observer,
    currentObserver: {},
  }), {
    status: 'stale-observer',
  });

  assert.deepEqual(classifyCodexWriterObservationScope({
    capturedIntentGeneration: 'rewind-b-c',
    currentIntentGeneration: 'rewind-b-c',
    capturedObservationGeneration: 9,
    currentObservationGeneration: 9,
    expectedObserver: observer,
    currentObserver: observer,
  }), {
    status: 'current',
  });
});

test('a public reconciliation preserves the settled Rewind source lineage', () => {
  assert.deepEqual(deriveCodexSettledWriterProofScope({
    nativeRewindHandoffProven: true,
    intent: {
      launchId: 'rewind-a-b',
      sourceSessionId: 'source-a',
    },
  }), {
    actionGeneration: 'rewind-a-b',
    sourceSessionId: 'source-a',
  });

  assert.deepEqual(deriveCodexSettledWriterProofScope({
    settledRewindWriterProven: true,
    settledWriterProof: {
      actionGeneration: 'rewind-a-b',
      sourceSessionId: 'source-a',
      sessionId: 'child-b',
    },
  }), {
    actionGeneration: 'rewind-a-b',
    sourceSessionId: 'source-a',
  }, 'revalidating child B without an active intent must not erase source A');

  assert.deepEqual(deriveCodexSettledWriterProofScope({}), {
    actionGeneration: null,
    sourceSessionId: null,
  });
});

test('public revalidation preserves the distinct no-lineage Rewind proof kinds', () => {
  assert.equal(projectCodexWriterProofKind({
    nativeRewindReplacementProven: true,
  }), 'native-rewind-replacement');
  assert.equal(projectCodexWriterProofKind({
    settledReplacementWriterProven: true,
    settledRewindWriterProven: true,
  }), 'native-rewind-replacement');
  assert.equal(projectCodexWriterProofKind({
    settledDelayedRewindWriterProven: true,
    settledRewindWriterProven: true,
  }), 'native-rewind-delayed-child');
  assert.equal(projectCodexWriterProofKind({
    settledRewindWriterProven: true,
  }), 'native-rewind-settled-writer');
  assert.equal(projectCodexWriterProofKind({}), 'process-open-rollout');
});

test('writer proof run sequence keeps only explicit positive generations', () => {
  assert.equal(normalizeCodexPositiveRunSeq(null), null);
  assert.equal(normalizeCodexPositiveRunSeq(undefined), null);
  assert.equal(normalizeCodexPositiveRunSeq(''), null);
  assert.equal(normalizeCodexPositiveRunSeq(0), null);
  assert.equal(normalizeCodexPositiveRunSeq(-1), null);
  assert.equal(normalizeCodexPositiveRunSeq(1), 1);
  assert.equal(normalizeCodexPositiveRunSeq('7'), 7);
});

test('first native Rewind preserves only the exact source as a read-only incumbent', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const sourceA = sessionsDir + '/rollout-a.jsonl';
  const siblingD = sessionsDir + '/rollout-d.jsonl';
  const terminalToken = {};
  const sourceIncumbent = {
    kind: 'native-rewind-source-incumbent',
    valid: true,
    sessionId: 'a',
    filePath: sourceA,
    actionGeneration: 'rewind-a-b',
    observerGeneration: 'rewind-a-b',
    terminalToken,
    observerTerminalToken: terminalToken,
    lifecycleGeneration: 'pty-g1',
    observerLifecycleGeneration: 'pty-g1',
    runSeq: 1,
    observerRunSeq: 1,
    expectedBindingSessionId: 'a',
    boundSessionId: 'a',
    actionAuthorityId: 'authority-a-b',
    incumbentOnly: true,
  };
  const candidateA = {
    filePath: sourceA,
    metadata: { meta: { id: 'a', source: 'cli' } },
  };
  assert.equal(
    selectCodexNativeRewindSourceIncumbent([candidateA], sourceIncumbent).status,
    'selected',
  );
  for (const [field, value, reason] of [
    ['observerTerminalToken', {}, 'stale-source-incumbent-terminal'],
    ['observerLifecycleGeneration', 'pty-g2', 'stale-source-incumbent-lifecycle'],
    ['observerRunSeq', 2, 'stale-source-incumbent-run'],
    ['boundSessionId', 'foreign', 'source-incumbent-binding-mismatch'],
    ['filePath', sessionsDir + '/other-a.jsonl', 'source-incumbent-candidate-missing'],
  ]) {
    assert.equal(
      selectCodexNativeRewindSourceIncumbent(
        [candidateA],
        { ...sourceIncumbent, [field]: value },
      ).reason,
      reason,
      field,
    );
  }

  const handoff = {
    kind: 'native-rewind',
    sourceSessionId: 'a',
    actionGeneration: 'rewind-a-b',
    observerGeneration: 'rewind-a-b',
    actionStartedAtMs: 32_000,
    liveProofs: [],
  };
  const metadata = new Map([
    [sourceA, { meta: { id: 'a', source: 'cli' } }],
    [siblingD, { meta: { id: 'd', forked_from_id: 'a', source: 'cli' } }],
  ]);
  const resolve = async (output) => resolveCodexUserWriterProof(
    resolveCodexWriterProof([{ pid: 100, output }], sessionsDir),
    {
      readMetadata: async (filePath) => metadata.get(filePath),
      isUserSession: () => true,
      handoff,
      sourceIncumbent,
    },
  );
  const sourceOnly = await resolve(`p100\nf20\nau\nn${sourceA}\n`);
  assert.equal(sourceOnly.status, 'incumbent-overlap-pending');
  assert.equal(sourceOnly.incumbentWriterProof.lineageRelation, 'source-incumbent');
  assert.equal(sourceOnly.handoffProof.reason, 'no-proven-descendant');

  const withSibling = await resolve(
    `p100\nf20\nau\nn${sourceA}\nf21\nau\nn${siblingD}\n`,
  );
  assert.equal(withSibling.status, 'ambiguous');
  assert.equal(withSibling.incumbentWriterProof, undefined);
});

test('active native Rewind B to C ignores settled B and selects exact live child C', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const sourceA = sessionsDir + '/rollout-a.jsonl';
  const settledB = sessionsDir + '/rollout-b.jsonl';
  const childC = sessionsDir + '/rollout-c.jsonl';
  const terminalToken = {};
  const descriptorProof = resolveCodexWriterProof([{
    pid: 100,
    output: `p100\nf20\nau\nn${sourceA}\nf21\nau\nn${settledB}\nf22\nau\nn${childC}\n`,
  }], sessionsDir);
  const metadata = new Map([
    [sourceA, { meta: { id: 'a', source: 'cli' } }],
    [settledB, { meta: { id: 'b', forked_from_id: 'a', source: 'cli' } }],
    [childC, { meta: { id: 'c', forked_from_id: 'b', source: 'cli' } }],
  ]);
  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async (filePath) => metadata.get(filePath),
    isUserSession: () => true,
    settledWriter: {
      kind: 'native-rewind-settled-writer',
      valid: true,
      sessionId: 'b',
      filePath: settledB,
      sourceSessionId: 'a',
      actionGeneration: 'rewind-a-b',
      observerGeneration: 'rewind-a-b',
      terminalToken,
      observerTerminalToken: terminalToken,
      runSeq: 31,
      observerRunSeq: 31,
      boundSessionId: 'b',
    },
    handoff: {
      kind: 'native-rewind',
      sourceSessionId: 'b',
      actionGeneration: 'rewind-b-c',
      observerGeneration: 'rewind-b-c',
      actionStartedAtMs: 32000,
      liveProofs: [{
        sessionId: 'c',
        actionGeneration: 'rewind-b-c',
        kind: 'rollout-created',
        boundaryAtMs: 32001,
        observedAtMs: 32002,
      }],
    },
  });

  assert.equal(proof.status, 'owned');
  assert.equal(proof.filePath, childC);
  assert.equal(proof.handoffProof.sessionId, 'c');
  assert.equal(proof.settledWriterProof, undefined);
});

test('active native Rewind preserves the exact incumbent read-only while its successor is pending', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const sourceA = sessionsDir + '/rollout-a.jsonl';
  const settledB = sessionsDir + '/rollout-b.jsonl';
  const terminalToken = {};
  const metadata = new Map([
    [sourceA, { meta: { id: 'a', source: 'cli' } }],
    [settledB, { meta: { id: 'b', forked_from_id: 'a', source: 'cli' } }],
  ]);
  const settledWriter = {
    kind: 'native-rewind-settled-writer',
    valid: true,
    sessionId: 'b',
    filePath: settledB,
    sourceSessionId: 'a',
    actionGeneration: 'rewind-a-b',
    observerGeneration: 'rewind-a-b',
    terminalToken,
    observerTerminalToken: terminalToken,
    runSeq: 31,
    observerRunSeq: 31,
    boundSessionId: 'b',
    incumbentOnly: true,
  };
  const handoff = {
    kind: 'native-rewind',
    sourceSessionId: 'b',
    actionGeneration: 'rewind-b-c',
    observerGeneration: 'rewind-b-c',
    actionStartedAtMs: 32_000,
    liveProofs: [],
  };
  const resolve = async (output) => resolveCodexUserWriterProof(
    resolveCodexWriterProof([{ pid: 100, output }], sessionsDir),
    {
      readMetadata: async (filePath) => metadata.get(filePath),
      isUserSession: () => true,
      settledWriter,
      handoff,
    },
  );

  const withAncestor = await resolve(
    `p100\nf20\nau\nn${sourceA}\nf21\nau\nn${settledB}\n`,
  );
  assert.equal(withAncestor.status, 'incumbent-overlap-pending');
  assert.equal(withAncestor.reason, 'active-handoff-awaiting-successor');
  assert.equal(withAncestor.incumbentWriterProof.sessionId, 'b');
  assert.equal(withAncestor.handoffProof.reason, 'no-proven-descendant');

  const incumbentOnly = await resolve(`p100\nf21\nau\nn${settledB}\n`);
  assert.equal(incumbentOnly.status, 'incumbent-overlap-pending');
  assert.equal(incumbentOnly.incumbentWriterProof.sessionId, 'b');
});

test('active native Rewind does not preserve an incumbent across a sibling writer', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const sourceA = sessionsDir + '/rollout-a.jsonl';
  const settledB = sessionsDir + '/rollout-b.jsonl';
  const siblingD = sessionsDir + '/rollout-d.jsonl';
  const terminalToken = {};
  const descriptorProof = resolveCodexWriterProof([{
    pid: 100,
    output: `p100\nf20\nau\nn${sourceA}\nf21\nau\nn${settledB}\nf22\nau\nn${siblingD}\n`,
  }], sessionsDir);
  const metadata = new Map([
    [sourceA, { meta: { id: 'a', source: 'cli' } }],
    [settledB, { meta: { id: 'b', forked_from_id: 'a', source: 'cli' } }],
    [siblingD, { meta: { id: 'd', forked_from_id: 'a', source: 'cli' } }],
  ]);
  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async (filePath) => metadata.get(filePath),
    isUserSession: () => true,
    settledWriter: {
      kind: 'native-rewind-settled-writer',
      valid: true,
      sessionId: 'b',
      filePath: settledB,
      sourceSessionId: 'a',
      actionGeneration: 'rewind-a-b',
      observerGeneration: 'rewind-a-b',
      terminalToken,
      observerTerminalToken: terminalToken,
      runSeq: 31,
      observerRunSeq: 31,
      boundSessionId: 'b',
      incumbentOnly: true,
    },
    handoff: {
      kind: 'native-rewind',
      sourceSessionId: 'b',
      actionGeneration: 'rewind-b-c',
      observerGeneration: 'rewind-b-c',
      actionStartedAtMs: 32_000,
      liveProofs: [],
    },
  });

  assert.equal(proof.status, 'ambiguous');
  assert.equal(proof.incumbentWriterProof, undefined);
});

test('branch handoff settles only when the adopted writer matches the exact proven generation', () => {
  const selection = {
    status: 'selected',
    sessionId: 'child',
    actionGeneration: 'rewind-12',
  };
  const base = {
    selection,
    actionGeneration: 'rewind-12',
    observerGeneration: 'rewind-12',
    adoptedSessionId: 'child',
    adoptionStatus: 'adopted',
    processRunning: true,
    tuiReady: true,
  };
  assert.deepEqual(classifyCodexBranchWriterHandoffSettlement(base), {
    sessionStatus: 'active',
    busy: false,
    inputReady: true,
    settled: true,
    absent: false,
    branchWriterProven: true,
    stableWriterProven: false,
    writerHandoffProven: true,
    handoffReason: 'proven-descendant',
  });
  assert.equal(classifyCodexBranchWriterHandoffSettlement({
    ...base,
    turnBusy: true,
  }).sessionStatus, 'busy');

  const stale = classifyCodexBranchWriterHandoffSettlement({
    ...base,
    observerGeneration: 'rewind-13',
  });
  assert.equal(stale.sessionStatus, 'starting');
  assert.equal(stale.settled, false);
  assert.equal(stale.handoffReason, 'stale-action-generation');

  const wrongWriter = classifyCodexBranchWriterHandoffSettlement({
    ...base,
    adoptedSessionId: 'source',
  });
  assert.equal(wrongWriter.sessionStatus, 'starting');
  assert.equal(wrongWriter.handoffReason, 'adopted-session-mismatch');
});

test('stable source settlement requires the exact durable same-generation Rewind proof', () => {
  const selection = {
    status: 'selected',
    sessionId: 'source',
    actionGeneration: 'rewind-source',
    lineageRelation: 'stable-source',
    stableSourceProof: { rollbackDurable: true },
  };
  const settled = classifyCodexBranchWriterHandoffSettlement({
    selection,
    actionGeneration: 'rewind-source',
    observerGeneration: 'rewind-source',
    adoptedSessionId: 'source',
    adoptionStatus: 'adopted',
    processRunning: true,
    tuiReady: true,
  });
  assert.equal(settled.settled, true);
  assert.equal(settled.branchWriterProven, false);
  assert.equal(settled.stableWriterProven, true);
  assert.equal(settled.writerHandoffProven, true);
  assert.equal(settled.handoffReason, 'proven-stable-source');

  const stale = classifyCodexBranchWriterHandoffSettlement({
    selection,
    actionGeneration: 'rewind-source',
    observerGeneration: 'other-generation',
    adoptedSessionId: 'source',
    adoptionStatus: 'adopted',
    processRunning: true,
    tuiReady: true,
  });
  assert.equal(stale.settled, false);
  assert.equal(stale.stableWriterProven, false);
});

test('unreadable writable candidate makes the complete writer proof unknown', async () => {
  const sessionsDir = '/Users/fedor/.codex/sessions';
  const parent = sessionsDir + '/rollout-parent.jsonl';
  const unreadable = sessionsDir + '/rollout-unreadable.jsonl';
  const descriptorProof = resolveCodexWriterProof([{
    pid: 100,
    output: `p100\nf20\nau\nn${parent}\nf21\nau\nn${unreadable}\n`,
  }], sessionsDir);
  const proof = await resolveCodexUserWriterProof(descriptorProof, {
    readMetadata: async (filePath) => {
      if (filePath === unreadable) throw new Error('permission denied');
      return { meta: { id: 'parent', source: 'cli' } };
    },
    isUserSession: (meta) => meta.source === 'cli',
  });
  assert.equal(proof.status, 'unknown');
  assert.match(proof.error, /metadata_read_failed/);
});

test('resume source stays provisional through TUI ready until append or linked writer proof', () => {
  assert.equal(classifyCodexWriterAdoption({
    sourceMode: 'resume',
    sourceMatch: 'source-in-place',
  }).status, 'provisional-source');
  assert.equal(classifyCodexWriterAdoption({
    sourceMode: 'resume',
    sourceMatch: 'source-in-place',
    sourceAppendObserved: true,
  }).status, 'commit');
  assert.equal(classifyCodexWriterAdoption({
    sourceMode: 'resume',
    sourceMatch: 'source-in-place',
    tuiReady: true,
  }).status, 'provisional-source');
  assert.equal(classifyCodexWriterAdoption({
    sourceMode: 'resume',
    sourceMatch: 'source-in-place',
    linkedBoundaryFound: true,
    tuiReady: true,
  }).status, 'commit');
  assert.equal(classifyCodexWriterAdoption({
    sourceMode: 'resume',
    sourceMatch: 'direct-fork',
  }).status, 'commit');
});

test('automated Resume source waits for exact user_message audit before adoption', () => {
  const pending = classifyCodexWriterAdoption({
    sourceMode: 'resume',
    sourceMatch: 'source-in-place',
    linkedBoundaryFound: true,
    sourceAppendObserved: true,
    sourceSubmitAuditPending: true,
  });
  assert.equal(pending.status, 'provisional-source');
  assert.equal(pending.reason, 'awaiting-user-message-audit');

  assert.equal(classifyCodexWriterAdoption({
    sourceMode: 'resume',
    sourceMatch: 'source-in-place',
    linkedBoundaryFound: true,
    sourceAppendObserved: true,
    sourceSubmitAuditPending: false,
  }).status, 'commit');

  assert.equal(classifyCodexWriterAdoption({
    sourceMode: 'resume',
    sourceMatch: 'direct-fork',
    sourceSubmitAuditPending: true,
  }).status, 'provisional-source');

  assert.equal(classifyCodexWriterAdoption({
    sourceMode: 'resume',
    sourceMatch: 'direct-fork',
    resumeSubmitAuditPending: true,
    candidateSubmitAuditProven: true,
  }).status, 'commit');
});

test('production Resume send selects only the exact causal child and rejects ambiguity', () => {
  const sourceSessionId = '019fc1f7-3c5c-76a1-99af-49b919b412dd';
  const childSessionId = '019fc276-a21a-71f3-98d0-01d2236e0e45';
  const launchId = 'resume-launch-production';
  const authorityId = 'resumed-active-submit-production';
  const submitId = '6c6d344a-8d7a-4422-8c8b-dbe3495570f0';
  const causal = {
    candidate: { filePath: '/rollout-child.jsonl' },
    proof: {
      sessionId: childSessionId,
      sourceSessionId,
      forkedFromId: sourceSessionId,
      launchId,
      authorityId,
      submitId,
    },
  };
  const selected = selectCodexResumedSubmitWriter([causal], {
    sourceSessionId,
    launchId,
    authorityId,
    submitId,
  });
  assert.equal(selected.status, 'selected');
  assert.equal(selected.proof.sessionId, childSessionId);

  assert.equal(selectCodexResumedSubmitWriter([{
    ...causal,
    proof: { ...causal.proof, forkedFromId: 'foreign-source' },
  }], {
    sourceSessionId,
    launchId,
    authorityId,
    submitId,
  }).status, 'pending');
  assert.equal(selectCodexResumedSubmitWriter([causal, {
    ...causal,
    candidate: { filePath: '/rollout-second-child.jsonl' },
    proof: { ...causal.proof, sessionId: 'second-causal-child' },
  }], {
    sourceSessionId,
    launchId,
    authorityId,
    submitId,
  }).status, 'ambiguous');
  assert.equal(selectCodexResumedSubmitWriter([{
    ...causal,
    proof: { ...causal.proof, launchId: 'stale-launch' },
  }], {
    sourceSessionId,
    launchId,
    authorityId,
    submitId,
  }).status, 'pending');
});

test('Resume source audit gate belongs to one exact source and launch', () => {
  const discovery = {
    sourceMode: 'resume',
    sourceSessionId: 'source-a',
    launchId: 'launch-1',
    provisionalSubmitReservation: {
      sourceSessionId: 'source-a',
      launchId: 'launch-1',
      requiresUserMessageAudit: true,
      auditMatched: false,
    },
  };
  assert.equal(isCodexResumeSourceAuditPending({
    sourceMode: 'resume',
    sourceSessionId: 'source-a',
    launchId: 'launch-1',
    discovery,
  }), true);
  assert.equal(isCodexResumeSourceAuditPending({
    sourceMode: 'resume',
    sourceSessionId: 'source-a',
    launchId: 'launch-2',
    discovery,
  }), false);
  discovery.provisionalSubmitReservation.auditMatched = true;
  assert.equal(isCodexResumeSourceAuditPending({
    sourceMode: 'resume',
    sourceSessionId: 'source-a',
    launchId: 'launch-1',
    discovery,
  }), false);
});

test('provisional first action requires one exact launch-scoped source proof chain', () => {
  const base = {
    sourceMode: 'resume',
    writerStatus: 'provisional-source',
    writerSessionId: 'source',
    sourceSessionId: 'source',
    launchId: 'launch-1',
    tabId: 'tab-a',
    discovery: { sourceMode: 'resume', sourceSessionId: 'source', launchId: 'launch-1' },
    sourceTurn: { sessionId: 'source', sourceObservationLaunchId: 'launch-1' },
    lease: { sourceSessionId: 'source', tabId: 'tab-a', launchId: 'launch-1' },
    tuiReady: true,
    processRunning: true,
    processPids: [101],
    hasInflight: false,
  };
  assert.deepEqual(classifyCodexProvisionalActionAuthorization(base), {
    authorized: true,
    reason: 'launch-scoped-source-observers',
  });
  assert.equal(classifyCodexProvisionalActionAuthorization({
    ...base,
    sourceTurn: { ...base.sourceTurn, sourceObservationLaunchId: 'launch-old' },
  }).authorized, false);
  assert.equal(classifyCodexProvisionalActionAuthorization({
    ...base,
    discovery: { ...base.discovery, provisionalSubmitReservation: { at: 1 } },
  }).reason, 'provisional-submit-already-reserved');
  assert.equal(classifyCodexProvisionalActionAuthorization({
    ...base,
    hasInflight: true,
  }).reason, 'action-inflight');
});

test('handoff unknown never becomes active and only proven absence becomes inactive', () => {
  assert.deepEqual(classifyCodexWriterHandoffSettlement({
    adoptionStatus: 'unknown',
    processRunning: true,
    tuiReady: true,
  }), {
    sessionStatus: 'starting',
    busy: false,
    inputReady: false,
    settled: false,
    absent: false,
  });
  assert.equal(classifyCodexWriterHandoffSettlement({
    adoptionStatus: 'pending',
    processRunning: false,
  }).sessionStatus, 'starting');
  assert.equal(classifyCodexWriterHandoffSettlement({
    adoptionStatus: 'absent',
    processRunning: false,
  }).sessionStatus, 'inactive');
  assert.equal(classifyCodexWriterHandoffSettlement({
    adoptionStatus: 'absent',
    processRunning: true,
  }).sessionStatus, 'starting');
  assert.equal(classifyCodexWriterHandoffSettlement({
    adoptionStatus: 'adopted',
    processRunning: true,
    tuiReady: true,
    writerChanged: false,
  }).sessionStatus, 'starting');
  assert.equal(classifyCodexWriterHandoffSettlement({
    adoptionStatus: 'adopted',
    processRunning: true,
    tuiReady: true,
    writerChanged: true,
  }).sessionStatus, 'active');
  assert.equal(classifyCodexWriterHandoffSettlement({
    adoptionStatus: 'adopted',
    processRunning: true,
    tuiReady: true,
    stableWriterProven: true,
  }).settled, true);
});

test('resume source lease stays exclusive until explicit release', () => {
  const leases = new Map();
  const liveTabs = new Set(['tab-a']);
  assert.equal(claimCodexResumeSourceLease(leases, {
    sourceSessionId: 'source',
    tabId: 'tab-a',
    launchId: 'launch-a',
    isTabLive: (tabId) => liveTabs.has(tabId),
  }).success, true);

  const blocked = claimCodexResumeSourceLease(leases, {
    sourceSessionId: 'source',
    tabId: 'tab-b',
    launchId: 'launch-b',
    isTabLive: (tabId) => liveTabs.has(tabId),
  });
  assert.equal(blocked.success, false);
  assert.equal(blocked.owner.tabId, 'tab-a');

  liveTabs.delete('tab-a');
  const stillBlocked = claimCodexResumeSourceLease(leases, {
    sourceSessionId: 'source',
    tabId: 'tab-b',
    launchId: 'launch-b',
    isTabLive: (tabId) => liveTabs.has(tabId),
  });
  assert.equal(stillBlocked.success, false);
  assert.equal(leases.get('source').tabId, 'tab-a');

  releaseCodexResumeSourceLeases(leases, { tabId: 'tab-a', launchId: 'launch-a' });
  const claimedAfterRelease = claimCodexResumeSourceLease(leases, {
    sourceSessionId: 'source',
    tabId: 'tab-b',
    launchId: 'launch-b',
  });
  assert.equal(claimedAfterRelease.success, true);
  assert.equal(leases.get('source').tabId, 'tab-b');
});

test('resume source lease respects a proven writer and releases by tab', () => {
  const leases = new Map();
  const blocked = claimCodexResumeSourceLease(leases, {
    sourceSessionId: 'source',
    tabId: 'tab-b',
    provenOwner: { tabId: 'tab-a', source: 'memory' },
  });
  assert.equal(blocked.success, false);
  assert.equal(leases.size, 0);

  claimCodexResumeSourceLease(leases, { sourceSessionId: 'source-1', tabId: 'tab-b' });
  claimCodexResumeSourceLease(leases, { sourceSessionId: 'source-2', tabId: 'tab-b' });
  assert.deepEqual(releaseCodexResumeSourceLeases(leases, {
    tabId: 'tab-b',
    sourceSessionId: 'source-1',
  }), ['source-1']);
  assert.equal(leases.has('source-2'), true);
  assert.deepEqual(releaseCodexResumeSourceLeases(leases, { tabId: 'tab-b' }), ['source-2']);
  assert.equal(leases.size, 0);
});

test('stale launch cleanup cannot release a newer lease generation', () => {
  const leases = new Map();
  claimCodexResumeSourceLease(leases, {
    sourceSessionId: 'source',
    tabId: 'tab-a',
    launchId: 'launch-new',
  });

  assert.deepEqual(releaseCodexResumeSourceLeases(leases, {
    tabId: 'tab-a',
    sourceSessionId: 'source',
    launchId: 'launch-old',
  }), []);
  assert.equal(leases.get('source')?.launchId, 'launch-new');

  assert.deepEqual(releaseCodexResumeSourceLeases(leases, {
    tabId: 'tab-a',
    sourceSessionId: 'source',
    launchId: 'launch-new',
  }), ['source']);
  assert.equal(leases.size, 0);
});

test('same-rollout ownership transactions cannot overlap across tabs', async () => {
  const registry = new Map();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = runKeyedExclusive(registry, 'rollout', async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
    return 'first';
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = runKeyedExclusive(registry, 'rollout', async () => {
    events.push('second:start');
    events.push('second:end');
    return 'second';
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.equal(registry.size, 0);
});

test('parallel read-only proofs join one single-flight task instead of queueing duplicates', async () => {
  const registry = new Map();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const first = runKeyedSingleFlight(registry, 'tab-a', async () => {
    calls += 1;
    await gate;
    return { status: 'owned' };
  });
  const second = runKeyedSingleFlight(registry, 'tab-a', async () => {
    calls += 1;
    return { status: 'duplicate' };
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { status: 'owned' },
    { status: 'owned' },
  ]);
  assert.equal(registry.size, 0);
});

test('unknown writer proof keeps ownership quarantined until absence or another cause is proven', () => {
  assert.equal(isCodexWriterProofOwnershipQuarantined({
    sessionId: 'session-a',
    valid: true,
  }), true);
  assert.equal(isCodexWriterProofOwnershipQuarantined({
    sessionId: 'session-a',
    valid: false,
    invalidatedReason: 'runtime-process-unknown',
  }), true);
  assert.equal(isCodexWriterProofOwnershipQuarantined({
    sessionId: 'session-a',
    valid: false,
    invalidatedReason: 'runtime-process-absent',
  }), false);
});

test('parallel destructive actions cannot both reserve one tab', () => {
  const registry = new Map();
  const first = claimExclusiveActionReservation(registry, {
    key: 'tab-a',
    requestId: 'rewind-1',
    action: 'codex-rewind',
  });
  assert.equal(first.success, true);

  const second = claimExclusiveActionReservation(registry, {
    key: 'tab-a',
    requestId: 'rewind-2',
    action: 'codex-rewind',
  });
  assert.equal(second.success, false);
  assert.equal(second.reason, 'already-reserved');
  assert.equal(second.active, first.reservation);

  assert.equal(releaseExclusiveActionReservation(registry, {
    key: 'tab-a',
    requestId: 'stale-owner',
  }), false);
  assert.equal(registry.get('tab-a'), first.reservation);
  assert.equal(releaseExclusiveActionReservation(registry, first.reservation), true);

  const retry = claimExclusiveActionReservation(registry, {
    key: 'tab-a',
    requestId: 'rewind-3',
    action: 'codex-rewind',
  });
  assert.equal(retry.success, true);
  assert.equal(releaseExclusiveActionReservation(registry, retry.reservation), true);
  assert.equal(registry.size, 0);
});
