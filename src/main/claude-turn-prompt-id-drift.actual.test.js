'use strict';
// A Claude tab showed the WORKING loader for nine minutes after Claude had
// already finished answering. It only cleared when the user sent an unrelated
// new message. Production 01.11.2026, tab 95c379a4fb0f, session 9e688393:
//
//   15:49:47  UserPromptSubmit  → turn opened, prompt_id = e04bc4b2…
//   15:52:39  a prompt typed mid-turn → dropped (duplicate-prompt-start)
//   15:56:12  Stop from Claude  → prompt_id = f13bd3eb…
//             [ClaudeHookScope] ignored reason=prompt-owner-mismatch
//             …turn=1 spin=1 for the next 9 ClaudeSnapshot samples…
//   15:59:20  user sends a new message → new turn
//   16:00:38  Stop accepted     → loader finally cleared
//
// Claude closed the turn under a DIFFERENT prompt_id than it opened it with.
// The guard "a foreign Stop must not settle my turn" is necessary — a nested
// subagent's Stop must never end the parent — but it compared prompt ids as
// if they were stable for a turn's lifetime. They are not: main.js already
// carries a scar for this (the queue-continuation replay deliberately sends
// prompt_id:null because "Claude runs the dequeued message under a NEW prompt
// id"). Here the id drifted on its own, with no replay involved.
//
// Fix: a prompt-id mismatch alone no longer rejects a terminal event. Session
// and process must still match exactly — those are what separate one tab's
// conversation and one CLI process from another, and a subagent is already
// excluded earlier by agent_id. These tests drive the REAL admission function.
const assert = require('node:assert/strict');
const test = require('node:test');
const { admitClaudeMainHook } = require('./claude-hook-routing');

const OPENED_WITH = 'e04bc4b2-5e76-4c39-9d2b-ada2d8967d64';
const CLOSED_WITH = 'f13bd3eb-01df-406a-ad34-e31800394e72';
const SESSION = '9e688393-eaf8-4c84-a4e1-5ff273d517d6';
const PID = 76874;

const liveTurn = (patch = {}) => ({
  provider: 'claude', active: true, sessionId: SESSION,
  processId: String(PID), providerPromptId: OPENED_WITH, ...patch,
});

test('a Stop whose prompt id drifted still ends the turn', () => {
  const verdict = admitClaudeMainHook({
    message: { event: 'Stop', session_id: SESSION, ppid: PID, prompt_id: CLOSED_WITH },
    currentTurn: liveTurn(), currentProcessId: PID,
  });
  // Pre-fix: { accepted: false, reason: 'prompt-owner-mismatch' } — the loader
  // kept spinning while Claude was already idle.
  assert.equal(verdict.accepted, true, 'the real completion must be admitted');
});

test('StopFailure with a drifted id is admitted too', () => {
  const verdict = admitClaudeMainHook({
    message: { event: 'StopFailure', session_id: SESSION, ppid: PID, prompt_id: CLOSED_WITH },
    currentTurn: liveTurn(), currentProcessId: PID,
  });
  assert.equal(verdict.accepted, true);
});

test('a matching prompt id is still admitted, unchanged', () => {
  const verdict = admitClaudeMainHook({
    message: { event: 'Stop', session_id: SESSION, ppid: PID, prompt_id: OPENED_WITH },
    currentTurn: liveTurn(), currentProcessId: PID,
  });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.reason, 'main-hook');
});

test('another conversation cannot end this turn', () => {
  const verdict = admitClaudeMainHook({
    message: { event: 'Stop', session_id: 'a-different-session', ppid: PID, prompt_id: CLOSED_WITH },
    currentTurn: liveTurn(), currentProcessId: PID,
  });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'turn-session-mismatch');
});

test('another CLI process cannot end this turn', () => {
  // Rejected by the process-owner guard before the turn comparison.
  const foreignProcess = admitClaudeMainHook({
    message: { event: 'Stop', session_id: SESSION, ppid: 999001, prompt_id: CLOSED_WITH },
    currentTurn: liveTurn(), currentProcessId: PID,
  });
  assert.equal(foreignProcess.accepted, false);
  assert.equal(foreignProcess.reason, 'process-owner-mismatch');

  // And by the turn's own recorded process when the launch owner is unknown.
  const foreignTurnProcess = admitClaudeMainHook({
    message: { event: 'Stop', session_id: SESSION, ppid: 999002, prompt_id: CLOSED_WITH },
    currentTurn: liveTurn(), currentProcessId: null,
  });
  assert.equal(foreignTurnProcess.accepted, false);
  assert.equal(foreignTurnProcess.reason, 'turn-process-mismatch');
});

test('a subagent Stop still cannot settle the parent turn', () => {
  for (const marker of [{ agent_id: 'sub-1' }, { agent_transcript_path: '/tmp/sub.jsonl' }]) {
    const verdict = admitClaudeMainHook({
      message: { event: 'Stop', session_id: SESSION, ppid: PID, prompt_id: CLOSED_WITH, ...marker },
      currentTurn: liveTurn(), currentProcessId: PID,
    });
    assert.equal(verdict.accepted, false);
    assert.equal(verdict.reason, 'subagent-hook');
  }
});

test('a prompt queued mid-turn is still recognised as a duplicate start', () => {
  // UserPromptSubmit keeps the exact-id rule: that is how a queued prompt is
  // told apart from a genuinely new turn, and the queue-continuation path
  // depends on it.
  const duplicate = admitClaudeMainHook({
    message: { event: 'UserPromptSubmit', session_id: SESSION, ppid: PID, prompt_id: OPENED_WITH },
    currentTurn: liveTurn(), currentProcessId: PID,
  });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'duplicate-prompt-start');

  const freshTurn = admitClaudeMainHook({
    message: { event: 'UserPromptSubmit', session_id: SESSION, ppid: PID, prompt_id: CLOSED_WITH },
    currentTurn: liveTurn(), currentProcessId: PID,
  });
  assert.equal(freshTurn.accepted, true, 'a new prompt id opens a new turn');
});

test('tool hooks keep their own ownership path', () => {
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    const verdict = admitClaudeMainHook({
      message: { event, session_id: SESSION, ppid: PID, prompt_id: CLOSED_WITH },
      currentTurn: liveTurn(), currentProcessId: PID,
    });
    assert.equal(verdict.accepted, true);
    assert.equal(verdict.reason, 'tool-hook');
  }
});
