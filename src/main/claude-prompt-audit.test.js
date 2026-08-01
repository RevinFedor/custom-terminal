'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildClaudeLivePromptAuditConfirmation,
  captureClaudePromptAuditBoundary,
  classifyClaudeAuditRecordAfterBoundary,
  readClaudeUserRecords,
  readLastClaudeUserRecord,
  selectClaudeLivePromptOwner,
  selectClaudePendingPromptAudit,
  selectUniqueClaudePromptSubmitAudit,
  shouldStageClaudeUserPromptAudit,
} = require('./claude-prompt-audit');

function userRecord(uuid, text, timestamp = '2026-07-24T10:00:00.000Z') {
  return {
    type: 'user',
    uuid,
    timestamp,
    message: { role: 'user', content: text },
  };
}

function queuedCommandRecord(uuid, text, timestamp = '2026-07-24T10:00:00.000Z') {
  return {
    type: 'attachment',
    uuid,
    timestamp,
    attachment: {
      type: 'queued_command',
      prompt: [{ type: 'text', text }],
    },
  };
}

test('only ordinary submitted Claude prompts enter the user-message audit', () => {
  const base = {
    broadcastTabId: 'tab-a',
    submit: true,
    submitSequence: '\r',
    content: 'ordinary prompt',
  };

  assert.equal(shouldStageClaudeUserPromptAudit(base), true);
  assert.equal(shouldStageClaudeUserPromptAudit({
    ...base,
    content: '/model haiku',
  }), false);
  assert.equal(shouldStageClaudeUserPromptAudit({
    ...base,
    content: '   /effort medium',
  }), false);
  assert.equal(shouldStageClaudeUserPromptAudit({
    ...base,
    submit: false,
  }), false);
  assert.equal(shouldStageClaudeUserPromptAudit({
    ...base,
    submitSequence: '\t',
  }), false);
  assert.equal(shouldStageClaudeUserPromptAudit({
    ...base,
    fast: true,
  }), false);
  assert.equal(shouldStageClaudeUserPromptAudit({
    ...base,
    isCodexPasteSource: true,
  }), false);
  assert.equal(shouldStageClaudeUserPromptAudit({
    ...base,
    broadcastTabId: null,
  }), false);
});

test('an identical pre-submit Claude record cannot satisfy the next audit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify(userRecord('old-uuid', 'same prompt')) + '\n',
  );

  const boundary = await captureClaudePromptAuditBoundary(transcriptPath);
  const stale = await readLastClaudeUserRecord(transcriptPath, boundary);
  assert.equal(stale, null, 'same-file audit reads only bytes after the boundary');

  fs.appendFileSync(
    transcriptPath,
    JSON.stringify(userRecord('new-uuid', 'same prompt')) + '\n',
  );
  const appended = await readLastClaudeUserRecord(transcriptPath, boundary);
  assert.deepEqual(classifyClaudeAuditRecordAfterBoundary(appended, boundary), {
    causal: true,
    reason: 'record-after-byte-boundary',
  });
});

test('a Claude queued_command is exact live delivery proof after the submit boundary', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-queued-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify(userRecord('old-uuid', 'manual turn')) + '\n');
  const boundary = await captureClaudePromptAuditBoundary(transcriptPath);
  const text = '[Оркестрация] Запрос завершён. runId: exact-run';
  fs.appendFileSync(
    transcriptPath,
    JSON.stringify(queuedCommandRecord('queued-uuid', text)) + '\n',
  );

  const candidates = await readClaudeUserRecords(transcriptPath, boundary);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].record.uuid, 'queued-uuid');
  assert.equal(candidates[0].text, text);
  assert.equal(candidates[0].promptCarrierKind, 'queued_command');
  const selection = selectClaudePendingPromptAudit([
    makeAudit(text, boundary, { handoffId: 'orchestration-complete:exact-run' }),
  ], candidates, { hashText: sha16 });
  assert.equal(selection?.candidate?.record?.uuid, 'queued-uuid');
  assert.equal(selection?.causality?.reason, 'record-after-byte-boundary');
});

test('resume child rejects a copied identical tail and accepts only a new UUID', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-child-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.jsonl');
  const childPath = path.join(dir, 'child.jsonl');
  const copied = JSON.stringify(userRecord('source-tail-uuid', 'same prompt')) + '\n';
  fs.writeFileSync(sourcePath, copied);
  const boundary = await captureClaudePromptAuditBoundary(sourcePath);

  fs.writeFileSync(childPath, copied);
  const staleChild = await readLastClaudeUserRecord(childPath, boundary);
  assert.deepEqual(classifyClaudeAuditRecordAfterBoundary(staleChild, boundary), {
    causal: false,
    reason: 'copied-source-tail',
  });

  fs.appendFileSync(
    childPath,
    JSON.stringify(userRecord('child-new-uuid', 'same prompt')) + '\n',
  );
  const newChild = await readLastClaudeUserRecord(childPath, boundary);
  assert.deepEqual(classifyClaudeAuditRecordAfterBoundary(newChild, boundary), {
    causal: true,
    reason: 'new-child-record-uuid',
  });
});

test('large JSONL prefixes and partial appended lines use bounded tail/offset reads', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-bounded-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'large-session.jsonl');
  const maxReadBytes = 4096;
  const largeAssistant = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: 'x'.repeat(maxReadBytes * 4),
    },
  });
  fs.writeFileSync(
    transcriptPath,
    largeAssistant + '\n' + JSON.stringify(userRecord('old-uuid', 'same prompt')) + '\n',
  );

  const boundary = await captureClaudePromptAuditBoundary(transcriptPath, {
    maxReadBytes,
  });
  assert.equal(boundary.lastUserUuid, 'old-uuid');
  assert.ok(
    boundary.bytesRead <= maxReadBytes + 1,
    `pre-boundary read ${boundary.bytesRead} bytes`,
  );

  const nextLine = JSON.stringify(userRecord('new-uuid', 'same prompt'));
  const splitAt = Math.floor(nextLine.length / 2);
  fs.appendFileSync(transcriptPath, nextLine.slice(0, splitAt));
  const partial = await readLastClaudeUserRecord(transcriptPath, boundary, {
    maxReadBytes,
  });
  assert.equal(partial, null, 'a partial post-boundary JSON line is not proof');

  fs.appendFileSync(transcriptPath, nextLine.slice(splitAt) + '\n');
  const complete = await readLastClaudeUserRecord(transcriptPath, boundary, {
    maxReadBytes,
  });
  assert.equal(complete.record.uuid, 'new-uuid');
  assert.equal(complete.readMode, 'post-boundary-offset');
  assert.ok(
    complete.bytesRead <= maxReadBytes,
    `post-boundary read ${complete.bytesRead} bytes`,
  );
  assert.deepEqual(classifyClaudeAuditRecordAfterBoundary(complete, boundary), {
    causal: true,
    reason: 'record-after-byte-boundary',
  });
});

function sha16(text) {
  return require('node:crypto').createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

function makeAudit(text, boundary, extra = {}) {
  return {
    expectedLen: text.length,
    expectedHash: sha16(text),
    preSubmitBoundary: boundary,
    finished: false,
    sentAt: Date.now(),
    ...extra,
  };
}

test('UserPromptSubmit binds execution context only to one eligible exact audit', () => {
  const text = 'same nested delegation prompt';
  const auditA = makeAudit(text, null, { handoffId: 'A', submitWritten: true });
  const auditB = makeAudit(text, null, { handoffId: 'B', submitWritten: true });

  const unique = selectUniqueClaudePromptSubmitAudit([auditA], text, { hashText: sha16 });
  assert.equal(unique.audit, auditA);
  assert.equal(unique.reason, 'unique-exact-pending-audit');
  assert.equal(unique.matchingAudits.length, 1);

  const ambiguous = selectUniqueClaudePromptSubmitAudit([auditA, auditB], text, {
    hashText: sha16,
  });
  assert.equal(ambiguous.audit, null);
  assert.equal(ambiguous.reason, 'ambiguous-identical-pending-audits');
  assert.deepEqual(ambiguous.matchingAudits, [auditA, auditB]);

  const notSubmitted = selectUniqueClaudePromptSubmitAudit([
    makeAudit(text, null, { handoffId: 'not-submitted', submitWritten: false }),
  ], text, { hashText: sha16 });
  assert.equal(notSubmitted.audit, null);
  assert.equal(notSubmitted.reason, 'no-exact-pending-audit');

  const missingPrompt = selectUniqueClaudePromptSubmitAudit([auditA], undefined, {
    hashText: sha16,
  });
  assert.equal(missingPrompt.audit, null);
  assert.equal(missingPrompt.reason, 'hook-prompt-unavailable');
});

test('live queue claim and its canonical record keep one exact handoff owner', () => {
  const text = 'same prompt';
  const boundary = { available: true, transcriptPath: '/tmp/live.jsonl', fileSize: 80 };
  const auditA = makeAudit(text, boundary, { handoffId: 'A' });
  const auditB = makeAudit(text, boundary, { handoffId: 'B' });
  const queueCandidate = {
    record: {
      type: 'queue-operation',
      operation: 'enqueue',
      content: text,
      timestamp: '2026-07-28T10:00:00.000Z',
      sessionId: 'session-a',
    },
    text,
    promptCarrierKind: 'queue-operation',
    byteOffset: 100,
    transcriptPath: '/tmp/live.jsonl',
  };

  const claimed = selectClaudeLivePromptOwner([auditA, auditB], queueCandidate, { hashText: sha16 });
  assert.equal(claimed?.audit?.handoffId, 'A');
  assert.equal(claimed?.reason, 'causal-queue-claim');

  const replay = selectClaudeLivePromptOwner([auditA, auditB], queueCandidate, { hashText: sha16 });
  assert.equal(replay?.audit?.handoffId, 'A');
  assert.equal(replay?.reason, 'queue-replay');

  const canonical = selectClaudeLivePromptOwner([auditA, auditB], {
    record: userRecord('canonical-a', text),
    text,
    promptCarrierKind: 'user',
    byteOffset: 140,
    transcriptPath: '/tmp/live.jsonl',
  }, { hashText: sha16 });
  assert.equal(canonical?.audit?.handoffId, 'A');
  assert.equal(canonical?.reason, 'canonical-after-exact-queue-claim');

  const canonicalReplay = selectClaudeLivePromptOwner([auditA, auditB], {
    record: userRecord('canonical-a', text),
    text,
    promptCarrierKind: 'user',
    byteOffset: 140,
    transcriptPath: '/tmp/live.jsonl',
  }, { hashText: sha16 });
  assert.equal(canonicalReplay?.audit?.handoffId, 'A');
  assert.equal(canonicalReplay?.reason, 'canonical-replay');
});

test('an identical later queue carrier cannot steal an already claimed handoff', () => {
  const text = 'same prompt';
  const boundary = { available: true, transcriptPath: '/tmp/live.jsonl', fileSize: 80 };
  const auditA = makeAudit(text, boundary, { handoffId: 'A' });
  const auditB = makeAudit(text, boundary, { handoffId: 'B' });
  const first = selectClaudeLivePromptOwner([auditA, auditB], {
    record: { type: 'queue-operation', operation: 'enqueue', content: text, timestamp: 't1' },
    text,
    promptCarrierKind: 'queue-operation',
    byteOffset: 100,
    transcriptPath: '/tmp/live.jsonl',
  }, { hashText: sha16 });
  const second = selectClaudeLivePromptOwner([auditA, auditB], {
    record: { type: 'queue-operation', operation: 'enqueue', content: text, timestamp: 't2' },
    text,
    promptCarrierKind: 'queue-operation',
    byteOffset: 120,
    transcriptPath: '/tmp/live.jsonl',
  }, { hashText: sha16 });

  assert.equal(first?.audit?.handoffId, 'A');
  assert.equal(second?.audit?.handoffId, 'B');
  assert.notEqual(auditA.liveQueuePromptClaim.byteOffset, auditB.liveQueuePromptClaim.byteOffset);
});

test('a live queued_command completes only its exact claimed History audit', () => {
  const text = 'same prompt';
  const boundary = { available: true, transcriptPath: '/tmp/live.jsonl', fileSize: 80 };
  const historyAudit = makeAudit(text, boundary, { handoffId: 'history-A' });

  const enqueue = {
    record: {
      type: 'queue-operation',
      operation: 'enqueue',
      content: text,
      timestamp: '2026-07-24T10:00:00.100Z',
    },
    text,
    promptCarrierKind: 'queue-operation',
    byteOffset: 100,
    transcriptPath: '/tmp/live.jsonl',
  };
  const queueSelection = selectClaudeLivePromptOwner([historyAudit], enqueue, { hashText: sha16 });
  assert.equal(queueSelection?.audit?.handoffId, 'history-A');
  assert.equal(
    buildClaudeLivePromptAuditConfirmation(queueSelection, enqueue, { hashText: sha16 }),
    null,
    'enqueue establishes FIFO ownership but is not yet canonical UUID proof',
  );

  const nativeDuplicate = {
    ...enqueue,
    record: { ...enqueue.record, timestamp: '2026-07-24T10:00:00.200Z' },
    byteOffset: 120,
  };
  assert.equal(
    selectClaudeLivePromptOwner([historyAudit], nativeDuplicate, { hashText: sha16 }),
    null,
    'an identical native xterm enqueue has no app handoff to claim',
  );

  const canonical = {
    record: queuedCommandRecord('queued-history-a', text, '2026-07-24T10:00:00.100Z'),
    text,
    promptCarrierKind: 'queued_command',
    byteOffset: 140,
    transcriptPath: '/tmp/live.jsonl',
  };
  const canonicalSelection = selectClaudeLivePromptOwner([historyAudit], canonical, { hashText: sha16 });
  const confirmation = buildClaudeLivePromptAuditConfirmation(
    canonicalSelection,
    canonical,
    { sessionId: 'session-live', hashText: sha16 },
  );
  assert.equal(confirmation?.audit?.handoffId, 'history-A');
  assert.deepEqual(confirmation?.result, {
    success: true,
    actualLen: text.length,
    actualHash: sha16(text),
    sessionId: 'session-live',
    entryUuid: 'queued-history-a',
    auditTimestamp: '2026-07-24T10:00:00.100Z',
    expectedLen: text.length,
    expectedHash: sha16(text),
    canonicalized: true,
    canonicalReason: 'canonical-after-exact-queue-claim',
  });
  assert.equal(confirmation?.recordByteOffset, 140);
});

test('an ordinary live user carrier completes its exact History audit without a queue claim', () => {
  const text = 'ordinary prompt';
  const boundary = { available: true, transcriptPath: '/tmp/live.jsonl', fileSize: 80 };
  const historyAudit = makeAudit(text, boundary, { handoffId: 'history-direct' });
  const canonical = {
    record: userRecord('direct-user-uuid', text),
    text,
    promptCarrierKind: 'user',
    byteOffset: 100,
    transcriptPath: '/tmp/live.jsonl',
  };

  const selection = selectClaudeLivePromptOwner([historyAudit], canonical, { hashText: sha16 });
  assert.equal(selection?.audit?.handoffId, 'history-direct');
  assert.equal(selection?.reason, 'causal-canonical-claim');

  const confirmation = buildClaudeLivePromptAuditConfirmation(
    selection,
    canonical,
    { sessionId: 'session-live', hashText: sha16 },
  );
  assert.equal(confirmation?.result?.entryUuid, 'direct-user-uuid');
  assert.equal(confirmation?.result?.canonicalReason, 'causal-canonical-claim');
  assert.equal(confirmation?.result?.success, true);
});

test('two same-text audits are confirmed by two causal records, not one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-multi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcriptPath, '');

  const boundaryA = await captureClaudePromptAuditBoundary(transcriptPath);
  fs.appendFileSync(transcriptPath, JSON.stringify(userRecord('uuid-a', 'same prompt')) + '\n');
  const boundaryB = await captureClaudePromptAuditBoundary(transcriptPath);
  fs.appendFileSync(transcriptPath, JSON.stringify(userRecord('uuid-b', 'same prompt')) + '\n');

  const auditA = makeAudit('same prompt', boundaryA, { handoffId: 'A' });
  const auditB = makeAudit('same prompt', boundaryB, { handoffId: 'B' });
  const candidates = await readClaudeUserRecords(transcriptPath, boundaryA);
  assert.equal(candidates.length, 2);

  const claimed = new Set();
  const first = selectClaudePendingPromptAudit([auditA, auditB], candidates, {
    hashText: sha16,
    claimedByteOffsets: claimed,
  });
  assert.equal(first.audit.handoffId, 'A');
  claimed.add(first.candidate.byteOffset);
  first.audit.finished = true;

  const second = selectClaudePendingPromptAudit([auditA, auditB], candidates, {
    hashText: sha16,
    claimedByteOffsets: claimed,
  });
  assert.equal(second.audit.handoffId, 'B');
  assert.notEqual(second.candidate.byteOffset, first.candidate.byteOffset);
  claimed.add(second.candidate.byteOffset);
  second.audit.finished = true;

  const third = selectClaudePendingPromptAudit([auditA, auditB], candidates, {
    hashText: sha16,
    claimedByteOffsets: claimed,
  });
  assert.equal(third, null, 'no live audits remain');
});

test('a mismatching record confirms nothing and fails no neighbor', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-mismatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcriptPath, '');
  const boundary = await captureClaudePromptAuditBoundary(transcriptPath);
  fs.appendFileSync(transcriptPath, JSON.stringify(userRecord('uuid-x', 'manual terminal submit')) + '\n');

  const audit = makeAudit('expected prompt', boundary, { handoffId: 'P' });
  const candidates = await readClaudeUserRecords(transcriptPath, boundary);
  const selection = selectClaudePendingPromptAudit([audit], candidates, { hashText: sha16 });
  assert.equal(selection, null, 'text mismatch leaves the audit pending (unknown)');
  assert.equal(audit.finished, false);
});

test('a pre-boundary identical record cannot confirm the later audit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-precausal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify(userRecord('uuid-old', 'same prompt')) + '\n');
  const boundary = await captureClaudePromptAuditBoundary(transcriptPath);
  const audit = makeAudit('same prompt', boundary, { handoffId: 'L' });

  // Read WITHOUT the boundary (bounded tail) so the stale record is visible
  // to the selector — causality classification must still reject it.
  const candidates = await readClaudeUserRecords(transcriptPath, null);
  assert.equal(candidates.length, 1);
  const selection = selectClaudePendingPromptAudit([audit], candidates, { hashText: sha16 });
  assert.equal(selection, null, 'stale identical tail is not causal proof');
});

test('the first prompt of a fresh Claude transcript uses its staged send time as causal proof', () => {
  const text = 'fresh first prompt';
  const sentAt = Date.parse('2026-07-26T03:48:08.259Z');
  const boundary = {
    available: false,
    reason: 'transcript-unresolved',
    transcriptPath: null,
  };
  const audit = makeAudit(text, boundary, { handoffId: 'fresh', sentAt });
  const candidate = {
    record: userRecord(
      'fresh-uuid',
      text,
      '2026-07-26T03:48:08.321Z',
    ),
    text,
    byteOffset: 0,
  };

  const selection = selectClaudePendingPromptAudit([audit], [candidate], {
    hashText: sha16,
  });

  assert.equal(selection?.audit, audit);
  assert.equal(selection?.candidate, candidate);
  assert.equal(
    selection?.causality?.reason,
    'record-after-send-with-unresolved-transcript',
  );
});

test('an old identical prompt cannot satisfy an unresolved fresh-transcript audit', () => {
  const text = 'same prompt';
  const sentAt = Date.parse('2026-07-26T03:48:08.259Z');
  const boundary = {
    available: false,
    reason: 'transcript-unresolved',
    transcriptPath: null,
  };
  const audit = makeAudit(text, boundary, { handoffId: 'fresh', sentAt });
  const staleCandidate = {
    record: userRecord(
      'old-uuid',
      text,
      '2026-07-26T03:48:08.258Z',
    ),
    text,
    byteOffset: 0,
  };

  const selection = selectClaudePendingPromptAudit([audit], [staleCandidate], {
    hashText: sha16,
  });

  assert.equal(selection, null);
});

test('a known-transcript read failure never falls back to timestamp causality', () => {
  const text = 'same prompt';
  const sentAt = Date.parse('2026-07-26T03:48:08.259Z');
  const boundary = {
    available: false,
    reason: 'EACCES',
    transcriptPath: '/tmp/existing-session.jsonl',
  };
  const audit = makeAudit(text, boundary, { handoffId: 'read-failed', sentAt });
  const candidate = {
    record: userRecord(
      'new-uuid',
      text,
      '2026-07-26T03:48:08.321Z',
    ),
    text,
    byteOffset: 0,
  };

  const selection = selectClaudePendingPromptAudit([audit], [candidate], {
    hashText: sha16,
  });

  assert.equal(selection, null);
});
