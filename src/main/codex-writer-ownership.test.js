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
  parseLsofFieldRecords,
  releaseExclusiveActionReservation,
  releaseCodexResumeSourceLeases,
  resolveCompleteCodexWriterProof,
  resolveCodexUserWriterProof,
  resolveCodexWriterProof,
  selectCodexNativeRewindWriter,
  isCodexWriterProofOwnershipQuarantined,
  runKeyedExclusive,
  runKeyedSingleFlight,
  writableCodexRolloutsFromLsof,
} = require('./codex-writer-ownership');

test('manual Codex Enter loses only to a submitted identity-pending operation or foreign reservation', () => {
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
