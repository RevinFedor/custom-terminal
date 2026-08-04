'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyCodexManualBindingPromotion,
  classifyCodexNativeRewindBindingCommit,
  classifyCodexNativeRewindSource,
  classifyCodexWriterBindingAdmission,
  persistCodexWriterBinding,
  resolveCodexNativeRewindActionGeneration,
} = require('./codex-writer-binding');

test('writer binding becomes publishable only after scoped durable commit', () => {
  let durable = 'resume-source';
  const committed = persistCodexWriterBinding({
    projectId: 'project-a',
    tabId: 'tab-a',
    sessionId: 'writer-child',
    readBinding: () => durable,
    writeBinding: (_projectId, _tabId, next) => {
      durable = next;
      return true;
    },
  });
  assert.deepEqual(committed, {
    success: true,
    updated: true,
    currentSessionId: 'resume-source',
  });
  assert.equal(durable, 'writer-child');
});

test('missing row and write failure remain retryable non-durable states', () => {
  assert.deepEqual(persistCodexWriterBinding({
    projectId: 'project-a',
    tabId: 'tab-a',
    sessionId: 'writer-child',
    readBinding: () => undefined,
    writeBinding: () => true,
  }), {
    success: false,
    error: 'codex_tab_row_missing',
    retryable: true,
  });

  const failed = persistCodexWriterBinding({
    projectId: 'project-a',
    tabId: 'tab-a',
    sessionId: 'writer-child',
    readBinding: () => 'resume-source',
    writeBinding: () => false,
  });
  assert.equal(failed.success, false);
  assert.equal(failed.error, 'codex_writer_binding_not_committed');
  assert.equal(failed.retryable, true);
});

test('manual unrelated writer cannot replace an existing stopped binding from process proof alone', () => {
  assert.deepEqual(classifyCodexWriterBindingAdmission({
    persistedSessionId: 'session-a',
    candidateSessionId: 'session-c',
    candidateForkedFromId: 'session-b',
    explicitLaunchGenerationCurrent: false,
  }), {
    allowed: false,
    status: 'await-user-message',
    reason: 'manual-writer-unrelated-to-bound-session',
    persistedSessionId: 'session-a',
    candidateSessionId: 'session-c',
  });
});

test('same writer, direct manual child, empty tab, and exact app launch may commit', () => {
  assert.equal(classifyCodexWriterBindingAdmission({
    persistedSessionId: 'session-a',
    candidateSessionId: 'session-a',
  }).reason, 'same-session');
  assert.equal(classifyCodexWriterBindingAdmission({
    persistedSessionId: 'session-a',
    candidateSessionId: 'session-c',
    candidateForkedFromId: 'session-a',
  }).reason, 'direct-child-of-bound-session');
  assert.equal(classifyCodexWriterBindingAdmission({
    persistedSessionId: null,
    candidateSessionId: 'session-c',
  }).reason, 'tab-binding-empty');
  assert.equal(classifyCodexWriterBindingAdmission({
    persistedSessionId: 'session-a',
    candidateSessionId: 'session-b',
    explicitLaunchGenerationCurrent: true,
  }).reason, 'explicit-launch-generation');
});

test('manual binding promotion requires a new user message in the same terminal generation', () => {
  assert.deepEqual(classifyCodexManualBindingPromotion({
    sameTerminal: true,
    sameRunSeq: true,
    sameWriter: true,
    recordByteOffset: 140,
    observationByteOffset: 120,
    persistedBindingMatches: true,
  }), {
    allowed: true,
    reason: 'exact-post-observation-user-message',
  });
  assert.equal(classifyCodexManualBindingPromotion({
    sameTerminal: true,
    sameRunSeq: false,
    sameWriter: true,
    recordByteOffset: 140,
    observationByteOffset: 120,
    persistedBindingMatches: true,
  }).reason, 'command-generation-changed');
  assert.equal(classifyCodexManualBindingPromotion({
    sameTerminal: true,
    sameRunSeq: true,
    sameWriter: true,
    recordByteOffset: 100,
    observationByteOffset: 120,
    persistedBindingMatches: true,
  }).reason, 'user-message-precedes-observation');
  assert.equal(classifyCodexManualBindingPromotion({
    sameTerminal: true,
    sameRunSeq: true,
    sameWriter: true,
    recordByteOffset: 140,
    observationByteOffset: 120,
    persistedBindingMatches: false,
  }).reason, 'persisted-binding-changed');
});

test('confirmed native Rewind derives authority from the exact live run after launch proof is gone', () => {
  assert.equal(resolveCodexNativeRewindActionGeneration({
    writerActionGeneration: 'rewind-a-b',
    writerLaunchId: 'launch-old',
    lifecycleGeneration: 'lifecycle-4',
    runSeq: 4,
    allowLiveRunFallback: true,
  }), 'rewind-a-b');
  assert.equal(resolveCodexNativeRewindActionGeneration({
    writerLaunchId: 'launch-4',
    lifecycleGeneration: 'lifecycle-4',
    runSeq: 4,
    allowLiveRunFallback: true,
  }), 'launch-4');
  assert.equal(resolveCodexNativeRewindActionGeneration({
    lifecycleGeneration: 'lifecycle-4',
    runSeq: 4,
    allowLiveRunFallback: true,
  }), 'live-run:lifecycle-4:run:4');
});

test('native Rewind never invents a generation without a complete main-owned live run', () => {
  assert.equal(resolveCodexNativeRewindActionGeneration({
    lifecycleGeneration: 'lifecycle-4',
    runSeq: 4,
  }), null, 'provisional Resume must keep requiring its exact launch lease');
  assert.equal(resolveCodexNativeRewindActionGeneration({
    lifecycleGeneration: 'lifecycle-4',
    runSeq: 0,
    allowLiveRunFallback: true,
  }), null);
  assert.equal(resolveCodexNativeRewindActionGeneration({
    runSeq: 4,
    allowLiveRunFallback: true,
  }), null);
});

test('native Rewind keeps quarantined runtime C1 separate from durable binding A', () => {
  assert.deepEqual(classifyCodexNativeRewindSource({
    persistedSessionId: 'A',
    quarantinedCandidateSessionId: 'C1',
    quarantinedPersistedSessionId: 'A',
    quarantinedSameTerminal: true,
    quarantinedSameRunSeq: true,
    quarantinedSameWriter: true,
  }), {
    allowed: true,
    mode: 'quarantined-manual-writer',
    runtimeSourceSessionId: 'C1',
    expectedPersistedSessionId: 'A',
  });

  assert.equal(classifyCodexNativeRewindSource({
    persistedSessionId: 'A-changed',
    quarantinedCandidateSessionId: 'C1',
    quarantinedPersistedSessionId: 'A',
    quarantinedSameTerminal: true,
    quarantinedSameRunSeq: true,
    quarantinedSameWriter: true,
  }).reason, 'persisted-binding-changed');

  assert.deepEqual(classifyCodexNativeRewindSource({
    persistedSessionId: 'A',
    provenWriterSessionId: 'A',
    quarantinedCandidateSessionId: 'C1',
    quarantinedPersistedSessionId: 'A',
    quarantinedSameTerminal: true,
    quarantinedSameRunSeq: true,
    quarantinedSameWriter: true,
  }), {
    allowed: true,
    mode: 'quarantined-manual-writer',
    runtimeSourceSessionId: 'C1',
    expectedPersistedSessionId: 'A',
  });
});

test('exact same-generation C1 to C2 Rewind may replace A without a C1 user-message promotion', () => {
  assert.deepEqual(classifyCodexNativeRewindBindingCommit({
    runtimeSourceSessionId: 'C1',
    expectedPersistedSessionId: 'A',
    candidateSessionId: 'C2',
    currentPersistedSessionId: 'A',
    lineageRelation: 'direct-child',
    exactActionProof: true,
    sameTerminal: true,
    sameRunSeq: true,
  }), {
    allowed: true,
    mode: 'quarantined-source-child',
    reason: 'exact-runtime-source-child',
  });

  assert.equal(classifyCodexNativeRewindBindingCommit({
    runtimeSourceSessionId: 'C1',
    expectedPersistedSessionId: 'A',
    candidateSessionId: 'C1',
    currentPersistedSessionId: 'A',
    lineageRelation: 'stable-source',
    exactActionProof: true,
    sameTerminal: true,
    sameRunSeq: true,
  }).reason, 'quarantined-stable-source-not-publishable');
});

test('exact same-generation root replacement may commit only through the Rewind gate', () => {
  assert.deepEqual(classifyCodexNativeRewindBindingCommit({
    runtimeSourceSessionId: 'C1',
    expectedPersistedSessionId: 'A',
    candidateSessionId: 'C2-root',
    currentPersistedSessionId: 'A',
    lineageRelation: 'rewind-replacement',
    exactActionProof: true,
    sameTerminal: true,
    sameRunSeq: true,
  }), {
    allowed: true,
    mode: 'quarantined-source-replacement',
    reason: 'exact-runtime-source-replacement',
  });
  assert.equal(classifyCodexNativeRewindBindingCommit({
    runtimeSourceSessionId: 'C1',
    expectedPersistedSessionId: 'A',
    candidateSessionId: 'C2-root',
    currentPersistedSessionId: 'A',
    lineageRelation: 'rewind-replacement',
    exactActionProof: false,
    sameTerminal: true,
    sameRunSeq: true,
  }).reason, 'exact-rewind-action-proof-missing');
});

test('stale generation, ambiguous lineage, or changed A cannot commit a quarantined Rewind', () => {
  const base = {
    runtimeSourceSessionId: 'C1',
    expectedPersistedSessionId: 'A',
    candidateSessionId: 'C2',
    currentPersistedSessionId: 'A',
    lineageRelation: 'descendant',
    exactActionProof: true,
    sameTerminal: true,
    sameRunSeq: true,
  };
  assert.equal(classifyCodexNativeRewindBindingCommit({
    ...base,
    sameTerminal: false,
  }).reason, 'terminal-generation-changed');
  assert.equal(classifyCodexNativeRewindBindingCommit({
    ...base,
    sameRunSeq: false,
  }).reason, 'command-generation-changed');
  assert.equal(classifyCodexNativeRewindBindingCommit({
    ...base,
    lineageRelation: null,
  }).reason, 'runtime-source-lineage-unproven');
  assert.equal(classifyCodexNativeRewindBindingCommit({
    ...base,
    currentPersistedSessionId: 'D',
  }).reason, 'persisted-binding-changed');
});
