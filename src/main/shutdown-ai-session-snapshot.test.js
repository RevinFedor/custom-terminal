'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  resolveAcceptedClaudeResumeShutdownTarget,
  resolveExactShutdownTarget,
} = require('./shutdown-ai-session-snapshot');

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
