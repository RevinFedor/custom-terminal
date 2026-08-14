import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesHistoryPromptAdoption,
  matchesHistoryPromptSuppression,
  resolveHistoryPromptHandoffPresentationSession,
} from './historyPromptPresentation.mjs';

test('audit proof routes a handoff only to its proven writer session', () => {
  assert.deepEqual(resolveHistoryPromptHandoffPresentationSession({
    auditSessionId: 'child-session',
    sessionIdHint: 'source-session',
    currentSessionId: 'child-session',
  }), {
    exactSessionId: 'child-session',
    presentationSessionId: 'child-session',
    belongsToCurrent: true,
  });
  assert.equal(resolveHistoryPromptHandoffPresentationSession({
    auditSessionId: 'child-session',
    sessionIdHint: 'source-session',
    currentSessionId: 'source-session',
  }).belongsToCurrent, false);
});

test('pre-submit failure without audit proof cannot hide an older identical prompt', () => {
  assert.equal(matchesHistoryPromptSuppression({
    role: 'user',
    isLocal: false,
    normalizedText: 'same prompt',
    timestamp: '2026-07-24T11:00:00.000Z',
    sessionId: 'session-a',
  }, {
    normalizedText: 'same prompt',
    requiresAuditIdentity: true,
    auditTimestamp: undefined,
    auditSessionId: undefined,
    since: Date.parse('2026-07-24T10:59:55.000Z'),
    until: Date.parse('2026-07-24T11:00:10.000Z'),
  }), false);
});

test('exact suppression requires both audit timestamp and proven session', () => {
  const suppression = {
    normalizedText: 'same prompt',
    requiresAuditIdentity: true,
    auditTimestamp: '2026-07-24T11:00:00.000Z',
    auditSessionId: 'session-b',
    since: 0,
    until: Number.MAX_SAFE_INTEGER,
  };
  assert.equal(matchesHistoryPromptSuppression({
    role: 'user',
    isLocal: false,
    normalizedText: 'same prompt',
    timestamp: '2026-07-24T11:00:00.000Z',
    sessionId: 'session-a',
  }, suppression), false);
  assert.equal(matchesHistoryPromptSuppression({
    role: 'user',
    isLocal: false,
    normalizedText: 'same prompt',
    timestamp: '2026-07-24T11:00:00.000Z',
    sessionId: 'session-b',
  }, suppression), true);
});

test('an identical older durable prompt cannot adopt a new local send before exact audit', () => {
  assert.equal(matchesHistoryPromptAdoption({
    role: 'user',
    normalizedText: 'same prompt',
    timestamp: '2026-07-24T11:00:00.000Z',
    sessionId: 'session-a',
  }, {
    normalizedText: 'same prompt',
    localAt: Date.parse('2026-07-24T11:00:04.000Z'),
    requiresAuditIdentity: true,
    auditTimestamp: undefined,
    auditSessionId: undefined,
  }), false);
});

test('exact audit adopts only the proven duplicate prompt', () => {
  const localPrompt = {
    normalizedText: 'same prompt',
    localAt: Date.parse('2026-07-24T11:00:04.000Z'),
    requiresAuditIdentity: true,
    auditTimestamp: '2026-07-24T11:00:04.250Z',
    auditSessionId: 'session-a',
  };
  assert.equal(matchesHistoryPromptAdoption({
    role: 'user',
    normalizedText: 'same prompt',
    timestamp: '2026-07-24T11:00:00.000Z',
    sessionId: 'session-a',
  }, localPrompt), false);
  assert.equal(matchesHistoryPromptAdoption({
    role: 'user',
    normalizedText: 'same prompt',
    timestamp: '2026-07-24T11:00:04.250Z',
    sessionId: 'session-a',
  }, localPrompt), true);
});

test('source identity is the strongest exact adoption proof', () => {
  assert.equal(matchesHistoryPromptAdoption({
    role: 'user',
    normalizedText: 'same prompt',
    timestamp: '2026-07-24T11:00:00.000Z',
    sessionId: 'session-a',
    sourceIdentity: 'codex-user-source-session-a-2048',
  }, {
    normalizedText: 'same prompt',
    requiresAuditIdentity: true,
    sourceIdentity: 'codex-user-source-session-a-2048',
  }), true);

  assert.equal(matchesHistoryPromptAdoption({
    role: 'user',
    normalizedText: 'same prompt',
    timestamp: '2026-07-24T11:00:00.000Z',
    sessionId: 'session-a',
    sourceIdentity: 'codex-user-source-session-a-1024',
  }, {
    normalizedText: 'same prompt',
    requiresAuditIdentity: true,
    sourceIdentity: 'codex-user-source-session-a-2048',
  }), false);
});

test('exact source identity adopts and suppresses the same record despite provider text normalization', () => {
  const entry = {
    role: 'user',
    isLocal: false,
    normalizedText: 'line one\n\nline two',
    timestamp: '2026-08-14T12:00:00.000Z',
    sessionId: 'session-a',
    sourceIdentity: 'codex-user-source-session-a-4096',
  };
  const exactIdentity = {
    normalizedText: 'line one\nline two',
    requiresAuditIdentity: true,
    sourceIdentity: 'codex-user-source-session-a-4096',
  };

  assert.equal(matchesHistoryPromptAdoption(entry, {
    ...exactIdentity,
    localAt: Date.parse(entry.timestamp),
  }), true);
  assert.equal(matchesHistoryPromptSuppression(entry, {
    ...exactIdentity,
    since: 0,
    until: Number.MAX_SAFE_INTEGER,
  }), true);
});
