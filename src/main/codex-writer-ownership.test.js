'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  classifyManualCodexSubmitAfterWriteQueue,
  classifyCodexBranchWriterHandoffSettlement,
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
  resolveCodexRewindCompletionProof,
  shouldCloseCodexRewindProtocolUi,
  classifyCodexWriterObservationScope,
  deriveCodexSettledWriterProofScope,
  shouldUseSettledCodexRewindWriterProof,
  selectCodexDelayedStableSourceWriter,
  selectCodexNativeRewindWriter,
  selectCodexSettledRewindWriter,
  isCodexWriterProofOwnershipQuarantined,
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

test('manual Codex Enter loses only to an already-submitted first write or foreign reservation', () => {
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
  }), false);
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
