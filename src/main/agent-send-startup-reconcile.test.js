'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  captureClaudePromptAuditBoundary,
} = require('./claude-prompt-audit');
const {
  classifyAgentPromptAuditIdentity,
} = require('./agent-prompt-audit-identity');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const {
  reconcileAgentSendStartupRecord,
  reconcileAgentSendStartupRecords,
} = require('./agent-send-startup-reconcile');

function claudeUser(uuid, text, sessionId = 'claude-session') {
  return {
    type: 'user',
    uuid,
    sessionId,
    timestamp: '2026-08-06T10:00:01.000Z',
    message: { role: 'user', content: text },
  };
}

function codexUser(text, timestamp = '2026-08-06T10:00:01.000Z') {
  return {
    type: 'event_msg',
    timestamp,
    payload: { type: 'user_message', message: text },
  };
}

function unresolvedRecord(provider, transcriptBoundary, promptText, overrides = {}) {
  return {
    operationKey: `history:tab-a:handoff-${provider}`,
    attemptId: `attempt-${provider}`,
    provider,
    sessionId: `${provider}-session`,
    promptHash: promptAuditFingerprint(promptText),
    promptLength: promptText.length,
    state: 'audit-pending',
    receipt: { transportText: promptText },
    transcriptBoundary,
    updatedAt: Date.parse('2026-08-06T10:00:00.000Z'),
    ...overrides,
  };
}

async function tempDir(t, prefix) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function codexBoundary(filePath, sessionId = 'codex-session') {
  const stat = await fs.promises.stat(filePath);
  return {
    capturedAt: Date.parse('2026-08-06T10:00:00.000Z'),
    sessionId,
    filePath,
    fileSize: stat.size,
  };
}

test('a pre-boundary identical Claude record is absent, not delivery proof', async (t) => {
  const dir = await tempDir(t, 'agent-startup-claude-old-');
  const transcriptPath = path.join(dir, 'claude.jsonl');
  const prompt = 'same prompt';
  await fs.promises.writeFile(
    transcriptPath,
    JSON.stringify(claudeUser('old-uuid', prompt)) + '\n',
  );
  const boundary = await captureClaudePromptAuditBoundary(transcriptPath);
  await fs.promises.appendFile(
    transcriptPath,
    JSON.stringify(claudeUser('other-uuid', 'different prompt')) + '\n',
  );

  const result = await reconcileAgentSendStartupRecord(
    unresolvedRecord('claude', boundary, prompt),
  );
  assert.equal(result.decision, 'absent');
  assert.equal(result.reason, 'no-exact-post-boundary-candidate');
  assert.equal(result.evidence.candidateCount, 1);
  assert.equal(result.evidence.matchCount, 0);
});

test('one exact post-boundary Claude record produces promotable audit data', async (t) => {
  const dir = await tempDir(t, 'agent-startup-claude-found-');
  const transcriptPath = path.join(dir, 'claude.jsonl');
  const prompt = 'deliver this once';
  await fs.promises.writeFile(
    transcriptPath,
    JSON.stringify(claudeUser('old-uuid', prompt)) + '\n',
  );
  const boundary = await captureClaudePromptAuditBoundary(transcriptPath);
  await fs.promises.appendFile(
    transcriptPath,
    JSON.stringify(claudeUser('new-uuid', prompt)) + '\n',
  );

  const source = unresolvedRecord('claude', boundary, prompt);
  const result = await reconcileAgentSendStartupRecord(source);
  assert.equal(result.decision, 'found');
  assert.equal(result.audit.operationKey, source.operationKey);
  assert.equal(result.audit.attemptId, source.attemptId);
  assert.equal(result.audit.entryUuid, 'new-uuid');
  assert.equal(result.audit.recordByteOffset, boundary.fileSize);
  assert.equal(result.audit.expectedHash, source.promptHash);
  assert.equal(result.audit.actualHash, source.promptHash);
  assert.equal(classifyAgentPromptAuditIdentity(result.audit).accepted, true);
});

test('one allowlisted canonical Codex record produces promotable audit data', async (t) => {
  const dir = await tempDir(t, 'agent-startup-codex-canonical-');
  const transcriptPath = path.join(dir, 'codex.jsonl');
  const expected = ' \ncanonical prompt\n ';
  await fs.promises.writeFile(transcriptPath, '');
  const boundary = await codexBoundary(transcriptPath);
  await fs.promises.appendFile(
    transcriptPath,
    JSON.stringify(codexUser('canonical prompt')) + '\n',
  );

  const source = unresolvedRecord('codex', boundary, expected);
  const result = await reconcileAgentSendStartupRecord(source);
  assert.equal(result.decision, 'found');
  assert.equal(result.reason, 'codex_trimmed_boundary_whitespace');
  assert.equal(result.audit.canonicalized, true);
  assert.equal(result.audit.canonicalReason, 'codex_trimmed_boundary_whitespace');
  assert.equal(result.audit.sourceIdentity, 'codex-user-source-codex-session-0');
  assert.equal(result.audit.recordByteOffset, 0);
  assert.notEqual(result.audit.actualHash, result.audit.expectedHash);
  assert.equal(classifyAgentPromptAuditIdentity(result.audit).accepted, true);
});

test('startup reconciliation accepts only the declared Codex CRLF to double-LF materialization', async (t) => {
  const dir = await tempDir(t, 'agent-startup-codex-crlf-');
  const transcriptPath = path.join(dir, 'codex.jsonl');
  const expected = 'first line\r\nsecond line';
  const materialized = 'first line\n\nsecond line';
  await fs.promises.writeFile(transcriptPath, '');
  const boundary = await codexBoundary(transcriptPath);
  await fs.promises.appendFile(
    transcriptPath,
    JSON.stringify(codexUser(materialized)) + '\n',
  );

  const source = unresolvedRecord('codex', boundary, expected);
  const result = await reconcileAgentSendStartupRecord(source);
  assert.equal(result.decision, 'found');
  assert.equal(result.reason, 'codex_pty_crlf_materialized_as_double_lf');
  assert.equal(result.audit.expectedHash, source.promptHash);
  assert.notEqual(result.audit.actualHash, source.promptHash);
  assert.equal(result.audit.canonicalReason, 'codex_pty_crlf_materialized_as_double_lf');
  assert.equal(classifyAgentPromptAuditIdentity(result.audit).accepted, true);
});

test('legacy Codex receipt recovers its exact writer session from its own pre-Enter boundary', async (t) => {
  const dir = await tempDir(t, 'agent-startup-codex-legacy-session-');
  const transcriptPath = path.join(dir, 'codex.jsonl');
  const expected = 'legacy first line\r\nlegacy second line';
  await fs.promises.writeFile(transcriptPath, '');
  const boundary = await codexBoundary(transcriptPath, 'legacy-writer-session');
  await fs.promises.appendFile(
    transcriptPath,
    JSON.stringify(codexUser('legacy first line\n\nlegacy second line')) + '\n',
  );

  const source = unresolvedRecord('codex', boundary, expected, { sessionId: null });
  const result = await reconcileAgentSendStartupRecord(source);
  assert.equal(result.decision, 'found');
  assert.equal(result.reason, 'codex_pty_crlf_materialized_as_double_lf');
  assert.equal(result.audit.sessionId, 'legacy-writer-session');
  assert.equal(result.audit.operationKey, source.operationKey);
  assert.equal(result.audit.attemptId, source.attemptId);
});

test('legacy session recovery uses only the exact provider boundary and conflicts fail closed', async (t) => {
  const dir = await tempDir(t, 'agent-startup-session-conflict-');
  const transcriptPath = path.join(dir, 'codex.jsonl');
  const prompt = 'exact session only';
  await fs.promises.writeFile(transcriptPath, '');
  const boundary = await codexBoundary(transcriptPath, 'boundary-session');
  await fs.promises.appendFile(transcriptPath, JSON.stringify(codexUser(prompt)) + '\n');

  const conflict = await reconcileAgentSendStartupRecord(
    unresolvedRecord('codex', boundary, prompt, { sessionId: 'foreign-session' }),
  );
  assert.equal(conflict.decision, 'unknown');
  assert.equal(conflict.reason, 'transcript-boundary-foreign-session');

  const claudeSessionId = '2531a2eb-c6c4-49b2-911f-760d7b39801e';
  const claudePath = path.join(dir, `${claudeSessionId}.jsonl`);
  await fs.promises.writeFile(
    claudePath,
    JSON.stringify(claudeUser('claude-legacy-user', prompt, claudeSessionId)) + '\n',
  );
  const claudeBoundary = {
    available: true,
    transcriptPath: claudePath,
    fileSize: 0,
    endedWithNewline: true,
  };
  const claudeWithoutStoredSession = await reconcileAgentSendStartupRecord(
    unresolvedRecord('claude', claudeBoundary, prompt, { sessionId: null }),
  );
  assert.equal(claudeWithoutStoredSession.decision, 'found');
  assert.equal(claudeWithoutStoredSession.audit.sessionId, claudeSessionId);

  const claudeConflict = await reconcileAgentSendStartupRecord(
    unresolvedRecord('claude', claudeBoundary, prompt, { sessionId: 'foreign-session' }),
  );
  assert.equal(claudeConflict.decision, 'unknown');
  assert.equal(claudeConflict.reason, 'transcript-boundary-foreign-session');
});

test('multiple exact post-boundary candidates remain unknown', async (t) => {
  const dir = await tempDir(t, 'agent-startup-ambiguous-');
  const transcriptPath = path.join(dir, 'claude.jsonl');
  const prompt = 'ambiguous prompt';
  await fs.promises.writeFile(transcriptPath, '');
  const boundary = await captureClaudePromptAuditBoundary(transcriptPath);
  await fs.promises.appendFile(
    transcriptPath,
    JSON.stringify(claudeUser('uuid-a', prompt)) + '\n'
      + JSON.stringify(claudeUser('uuid-b', prompt)) + '\n',
  );

  const result = await reconcileAgentSendStartupRecord(
    unresolvedRecord('claude', boundary, prompt),
  );
  assert.equal(result.decision, 'unknown');
  assert.equal(result.reason, 'multiple-exact-post-boundary-candidates');
  assert.equal(result.evidence.matchCount, 2);
});

test('missing transcript boundary remains unknown without reading a file', async () => {
  const prompt = 'missing boundary';
  const result = await reconcileAgentSendStartupRecord(
    unresolvedRecord('claude', null, prompt),
  );
  assert.equal(result.decision, 'unknown');
  assert.equal(result.reason, 'transcript-boundary-missing');
});

test('a partial post-boundary JSONL line remains unknown', async (t) => {
  const dir = await tempDir(t, 'agent-startup-partial-');
  const transcriptPath = path.join(dir, 'codex.jsonl');
  const prompt = 'partial prompt';
  await fs.promises.writeFile(transcriptPath, '');
  const boundary = await codexBoundary(transcriptPath);
  await fs.promises.appendFile(transcriptPath, JSON.stringify(codexUser(prompt)));

  const result = await reconcileAgentSendStartupRecord(
    unresolvedRecord('codex', boundary, prompt),
  );
  assert.equal(result.decision, 'unknown');
  assert.equal(result.reason, 'transcript-post-boundary-partial-line');
});

test('Codex startup accepts the nearest exact user message without reading hours of later tail', async (t) => {
  const dir = await tempDir(t, 'agent-startup-bounded-');
  const transcriptPath = path.join(dir, 'codex.jsonl');
  const prompt = 'bounded prompt';
  await fs.promises.writeFile(transcriptPath, '');
  const boundary = await codexBoundary(transcriptPath);
  await fs.promises.appendFile(
    transcriptPath,
    JSON.stringify(codexUser(prompt)) + '\n'
      + Array.from({ length: 8 }, (_, index) => JSON.stringify({
        type: 'event_msg',
        timestamp: `2026-08-06T10:01:${String(index).padStart(2, '0')}.000Z`,
        payload: { type: 'agent_message', message: 'x'.repeat(256) },
      })).join('\n')
      + '\n',
  );

  const result = await reconcileAgentSendStartupRecord(
    unresolvedRecord('codex', boundary, prompt),
    { maxReadBytes: 256 },
  );
  assert.equal(result.decision, 'found');
  assert.equal(result.reason, 'exact-post-boundary-candidate');
  assert.equal(result.evidence.rangeComplete, false);
  assert.ok(result.evidence.postBoundaryBytes > result.evidence.bytesRead);
});

test('Codex startup never uses a later identical prompt when the nearest user message differs', async (t) => {
  const dir = await tempDir(t, 'agent-startup-causal-first-');
  const transcriptPath = path.join(dir, 'codex.jsonl');
  const prompt = 'do not steal a later prompt';
  await fs.promises.writeFile(transcriptPath, '');
  const boundary = await codexBoundary(transcriptPath);
  await fs.promises.appendFile(
    transcriptPath,
    JSON.stringify(codexUser('different earlier operation')) + '\n'
      + JSON.stringify(codexUser(prompt)) + '\n',
  );

  const result = await reconcileAgentSendStartupRecord(
    unresolvedRecord('codex', boundary, prompt),
  );
  assert.equal(result.decision, 'unknown');
  assert.equal(result.reason, 'first-post-boundary-user-message-mismatch');
});

test('a later durable send boundary closes the exact causal range for an older Codex receipt', async (t) => {
  const dir = await tempDir(t, 'agent-startup-causal-upper-');
  const transcriptPath = path.join(dir, 'codex.jsonl');
  const firstPrompt = 'first durable operation';
  const secondPrompt = 'second durable operation';
  await fs.promises.writeFile(transcriptPath, '');
  const firstBoundary = await codexBoundary(transcriptPath);
  await fs.promises.appendFile(
    transcriptPath,
    JSON.stringify(codexUser('late record from an earlier operation')) + '\n'
      + JSON.stringify(codexUser(firstPrompt)) + '\n',
  );
  const secondBoundary = await codexBoundary(transcriptPath);
  await fs.promises.appendFile(
    transcriptPath,
    JSON.stringify(codexUser(secondPrompt)) + '\n',
  );

  const first = unresolvedRecord('codex', firstBoundary, firstPrompt, {
    operationKey: 'history:tab-a:first',
    attemptId: 'attempt-first',
  });
  const second = unresolvedRecord('codex', secondBoundary, secondPrompt, {
    operationKey: 'history:tab-a:second',
    attemptId: 'attempt-second',
    state: 'confirmed',
  });
  const [result] = await reconcileAgentSendStartupRecords([first], {
    allRecords: [first, second],
  });
  assert.equal(result.decision, 'found');
  assert.equal(result.reason, 'exact-post-boundary-candidate');
  assert.equal(result.evidence.causalUpperBoundaryOffset, secondBoundary.fileSize);
  assert.equal(result.evidence.rangeComplete, true);
  assert.equal(result.evidence.candidateCount, 2);
  assert.equal(result.evidence.matchCount, 1);
});

test('Codex startup stays unknown when no complete causal record fits the read ceiling', async (t) => {
  const dir = await tempDir(t, 'agent-startup-bounded-no-line-');
  const transcriptPath = path.join(dir, 'codex.jsonl');
  const prompt = 'bounded prompt';
  await fs.promises.writeFile(transcriptPath, '');
  const boundary = await codexBoundary(transcriptPath);
  await fs.promises.appendFile(
    transcriptPath,
    JSON.stringify(codexUser('x'.repeat(256))) + '\n'
      + JSON.stringify(codexUser(prompt)) + '\n',
  );

  const result = await reconcileAgentSendStartupRecord(
    unresolvedRecord('codex', boundary, prompt),
    { maxReadBytes: 64 },
  );
  assert.equal(result.decision, 'unknown');
  assert.equal(result.reason, 'no-user-message-in-bounded-causal-prefix');
  assert.equal(result.evidence.rangeComplete, false);
});

test('an unreadable exact transcript remains unknown', async (t) => {
  const dir = await tempDir(t, 'agent-startup-unreadable-');
  const transcriptPath = path.join(dir, 'missing.jsonl');
  const prompt = 'cannot read this';
  const boundary = {
    available: true,
    transcriptPath,
    fileSize: 0,
    endedWithNewline: true,
  };

  const result = await reconcileAgentSendStartupRecord(
    unresolvedRecord('claude', boundary, prompt),
  );
  assert.equal(result.decision, 'unknown');
  assert.equal(result.reason, 'transcript-unreadable');
  assert.equal(result.errorCode, 'ENOENT');
});

test('foreign session and linked-child file hints remain unknown', async (t) => {
  const dir = await tempDir(t, 'agent-startup-foreign-');
  const transcriptPath = path.join(dir, 'source.jsonl');
  const childPath = path.join(dir, 'child.jsonl');
  const prompt = 'foreign prompt';
  await fs.promises.writeFile(transcriptPath, '');
  await fs.promises.writeFile(childPath, JSON.stringify(codexUser(prompt)) + '\n');
  const boundary = await codexBoundary(transcriptPath, 'different-session');

  const foreignSession = await reconcileAgentSendStartupRecord(
    unresolvedRecord('codex', boundary, prompt),
  );
  assert.equal(foreignSession.decision, 'unknown');
  assert.equal(foreignSession.reason, 'transcript-boundary-foreign-session');

  const exactBoundary = await codexBoundary(transcriptPath);
  const linkedHint = await reconcileAgentSendStartupRecord(
    unresolvedRecord('codex', exactBoundary, prompt, {
      receipt: { transportText: prompt, linkedFilePath: childPath },
    }),
  );
  assert.equal(linkedHint.decision, 'unknown');
  assert.equal(linkedHint.reason, 'transcript-boundary-foreign-file');
});
