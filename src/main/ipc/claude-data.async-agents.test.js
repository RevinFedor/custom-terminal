const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _api } = require('./claude-data');

const {
  deriveClaudeAsyncAgentStatus,
  extractClaudeTaskNotificationTexts,
  buildClaudeTaskNotificationIndex,
  readClaudeStoppedAgentToolUseIds,
} = _api;

// Claude backgrounded ("async") Agent liveness. Shapes verified against real
// session files in ~/.claude/projects: the acceptance record carries
// toolUseResult.isAsync=true + status "async_launched"; the outcome arrives
// later as a <task-notification>; a user-stopped agent never notifies at all
// and is only provable through its sidecar meta file.

// ── status derivation ──────────────────────────────────────────────────────

test('no notification yet → the agent is running', () => {
  assert.equal(deriveClaudeAsyncAgentStatus(undefined), 'running');
  assert.equal(deriveClaudeAsyncAgentStatus(null), 'running');
  assert.equal(deriveClaudeAsyncAgentStatus({}), 'running');
});

test('mid-run progress notification keeps the agent running', () => {
  // Real corpus: 21 notifications carry <status>running</status> with a
  // truncated <output> body — a progress ping, NOT a terminal state.
  assert.equal(deriveClaudeAsyncAgentStatus({ status: 'running' }), 'running');
  assert.equal(deriveClaudeAsyncAgentStatus({ status: ' Running ' }), 'running');
});

test('completed is the only success terminal', () => {
  assert.equal(deriveClaudeAsyncAgentStatus({ status: 'completed' }), 'completed');
  assert.equal(deriveClaudeAsyncAgentStatus({ status: 'COMPLETED' }), 'completed');
});

test('every other terminal status resolves to interrupted, never running', () => {
  // failed/killed/stopped all appear in the real corpus. "stopped" is what the
  // CLI writes for agents orphaned by a restart — it MUST clear the chip.
  for (const status of ['failed', 'killed', 'stopped', 'cancelled', 'timed_out']) {
    assert.equal(deriveClaudeAsyncAgentStatus({ status }), 'interrupted', status);
  }
});

test('unknown future status is terminal, not a resurrected zombie', () => {
  // Format drift must never re-create the eternal-chip bug: an unrecognised
  // word means "the CLI told us something ended", so the chip dies.
  assert.equal(deriveClaudeAsyncAgentStatus({ status: 'quantum_collapsed' }), 'interrupted');
  assert.equal(deriveClaudeAsyncAgentStatus({ status: '???' }), 'interrupted');
});

// ── notification carriers ──────────────────────────────────────────────────

const NOTIFICATION_TEXT = [
  '<task-notification>',
  '<task-id>a157c9ad73f056ed4</task-id>',
  '<tool-use-id>toolu_stand_alone</tool-use-id>',
  '<status>completed</status>',
  '<summary>Agent "Verify claims" finished</summary>',
  '</task-notification>',
].join('\n');

test('carrier 1: standalone user record (string and block content)', () => {
  assert.deepEqual(
    extractClaudeTaskNotificationTexts({ type: 'user', message: { content: NOTIFICATION_TEXT } }),
    [NOTIFICATION_TEXT],
  );
  assert.deepEqual(
    extractClaudeTaskNotificationTexts({
      type: 'user',
      message: { content: [{ type: 'text', text: NOTIFICATION_TEXT }] },
    }),
    [NOTIFICATION_TEXT],
  );
});

test('carrier 2: attachment riding on the next prompt', () => {
  // Real shape: {type:'attachment', attachment:{type:'queued_command',
  // commandMode:'task-notification', prompt:'<task-notification>…'}}.
  // 8 of 16 async agents in the live corpus notified ONLY this way; reading
  // just carrier 1 left every one of them "running" forever.
  const rec = {
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: NOTIFICATION_TEXT,
    },
  };
  assert.deepEqual(extractClaudeTaskNotificationTexts(rec), [NOTIFICATION_TEXT]);
});

test('records without a notification contribute nothing', () => {
  assert.deepEqual(extractClaudeTaskNotificationTexts({ type: 'user', message: { content: 'hi' } }), []);
  assert.deepEqual(extractClaudeTaskNotificationTexts({ type: 'assistant', message: { content: [] } }), []);
  assert.deepEqual(extractClaudeTaskNotificationTexts(null), []);
});

test('index keys by tool-use id and lets the latest notification win', () => {
  const running = NOTIFICATION_TEXT
    .replace('toolu_stand_alone', 'toolu_x')
    .replace('<status>completed</status>', '<status>running</status>');
  const done = NOTIFICATION_TEXT.replace('toolu_stand_alone', 'toolu_x');
  const index = buildClaudeTaskNotificationIndex(new Map([
    ['a', { type: 'user', timestamp: 't1', message: { content: running } }],
    ['b', { type: 'attachment', timestamp: 't2', attachment: { prompt: done } }],
  ]));
  assert.equal(index.size, 1);
  assert.equal(index.get('toolu_x').status, 'completed');
  assert.equal(deriveClaudeAsyncAgentStatus(index.get('toolu_x')), 'completed');
});

// ── resume (SendMessage) reopens a finished agent ──────────────────────────

const AGENT_ID = 'a93f7dd8b7c284d2a';
const notificationRecord = (status) => ({
  type: 'user',
  message: {
    content: [
      '<task-notification>',
      `<task-id>${AGENT_ID}</task-id>`,
      '<tool-use-id>toolu_resumable</tool-use-id>',
      `<status>${status}</status>`,
      '<summary>Agent finished</summary>',
      // The CLI states the resume contract in every notification:
      '<note>The user can send it another message and resume it, so the same'
        + ' task-id may notify more than once.</note>',
      '</task-notification>',
    ].join('\n'),
  },
});

const resumeRecord = () => ({
  type: 'assistant',
  message: {
    content: [{
      type: 'tool_use',
      id: 'toolu_send',
      name: 'SendMessage',
      // Resume addresses the AGENT id, never the spawn call id — which is why
      // a tool_use_id-keyed index alone cannot see it.
      input: { to: AGENT_ID, message: 'ещё одна задача' },
    }],
  },
});

const statusAfter = (records) => {
  const index = buildClaudeTaskNotificationIndex(
    new Map(records.map((rec, i) => ['k' + i, rec])),
  );
  return deriveClaudeAsyncAgentStatus(index.get('toolu_resumable'));
};

test('a resume after the last notification puts the agent back to running', () => {
  // Without this the chip stays dark for the whole resumed run: the newest
  // notification still says "completed" while the agent is actually working.
  assert.equal(statusAfter([notificationRecord('completed')]), 'completed');
  assert.equal(statusAfter([notificationRecord('completed'), resumeRecord()]), 'running');
});

test('the notification that follows a resume wins again', () => {
  assert.equal(
    statusAfter([notificationRecord('completed'), resumeRecord(), notificationRecord('completed')]),
    'completed',
  );
  assert.equal(
    statusAfter([notificationRecord('completed'), resumeRecord(), notificationRecord('failed')]),
    'interrupted',
  );
});

test('a resume older than the last notification does not reopen the agent', () => {
  assert.equal(statusAfter([resumeRecord(), notificationRecord('completed')]), 'completed');
});

test('messages to non-agent targets never reopen a card', () => {
  const toMain = {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 't', name: 'SendMessage', input: { to: 'main', message: 'x' } }],
    },
  };
  assert.equal(statusAfter([notificationRecord('completed'), toMain]), 'completed');
});

// ── sidecar proof for user-stopped agents ──────────────────────────────────

test('sidecar meta marks user-stopped agents across the whole project dir', () => {
  // Ownership cannot come from the spawn record: resume/fork copy spawn rows
  // into the new session file with rewritten sessionIds while the sidecar
  // stays under the session that really spawned the agent. Scanning the whole
  // project dir is what clears those INHERITED cards.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-subagent-meta-'));
  try {
    const owner = path.join(projectDir, 'session-owner', 'subagents');
    fs.mkdirSync(owner, { recursive: true });
    fs.writeFileSync(path.join(owner, 'agent-a1.meta.json'), JSON.stringify({
      agentType: 'e2e', description: 'stopped one', toolUseId: 'toolu_stopped', stoppedByUser: true,
    }));
    fs.writeFileSync(path.join(owner, 'agent-a2.meta.json'), JSON.stringify({
      agentType: 'e2e', description: 'still going', toolUseId: 'toolu_live',
    }));
    // Unreadable sidecar must not throw and must not invent a state.
    fs.writeFileSync(path.join(owner, 'agent-a3.meta.json'), '{ broken json');

    const stopped = readClaudeStoppedAgentToolUseIds(projectDir);
    assert.equal(stopped.has('toolu_stopped'), true);
    assert.equal(stopped.has('toolu_live'), false);
    assert.equal(stopped.size, 1);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('missing project dir yields no proof instead of throwing', () => {
  assert.equal(readClaudeStoppedAgentToolUseIds('/nonexistent/path/xyz').size, 0);
  assert.equal(readClaudeStoppedAgentToolUseIds(undefined).size, 0);
});

// ── the three layers combined ──────────────────────────────────────────────

// Exactly how the projection decides, kept in one place so the "came back two
// hours later" cases stay pinned: an agent stays live across later turns, and
// only real terminal proof (notification OR sidecar) can clear it.
const resolveAsyncAgentState = (notification, userStopped) => {
  const status = deriveClaudeAsyncAgentStatus(notification);
  return userStopped && status === 'running' ? 'interrupted' : status;
};

test('a backgrounded agent stays live across later turns until proof arrives', () => {
  // The user sends more prompts while the agent works — no notification yet,
  // no sidecar stop mark. This is the case that must NOT go dark.
  assert.equal(resolveAsyncAgentState(undefined, false), 'running');
  assert.equal(resolveAsyncAgentState({ status: 'running' }, false), 'running');
});

test('terminal proof from either source clears the live state', () => {
  assert.equal(resolveAsyncAgentState({ status: 'completed' }, false), 'completed');
  assert.equal(resolveAsyncAgentState({ status: 'failed' }, false), 'interrupted');
  // Sidecar-only proof: user-stopped agents never send a notification.
  assert.equal(resolveAsyncAgentState(undefined, true), 'interrupted');
});

test('a real notification outranks the sidecar mark', () => {
  // Stop requested, but the agent still managed to finish: the notification
  // is the richer truth and keeps its own outcome.
  assert.equal(resolveAsyncAgentState({ status: 'completed' }, true), 'completed');
});
