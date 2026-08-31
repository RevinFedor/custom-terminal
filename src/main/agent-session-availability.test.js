'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentSessionAvailabilityService } = require('./agent-session-availability');

const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_ID = '22222222-2222-4222-8222-222222222222';
const ARCHIVED_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_ID = '44444444-4444-4444-8444-444444444444';
const SOURCE_ID = '55555555-5555-4555-8555-555555555555';
const GEMINI_ID = '66666666-6666-4666-8666-666666666666';

async function fixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-session-availability-'));
  const claudeProjectsDir = path.join(root, 'claude-projects');
  const codexHome = path.join(root, 'codex');
  const geminiChats = path.join(root, 'gemini-chats');
  await fs.promises.mkdir(path.join(claudeProjectsDir, '-tmp-project'), { recursive: true });
  await fs.promises.mkdir(path.join(codexHome, 'sessions', '2026', '08', '30'), { recursive: true });
  await fs.promises.mkdir(path.join(codexHome, 'archived_sessions'), { recursive: true });
  await fs.promises.mkdir(geminiChats, { recursive: true });
  return {
    root,
    claudeProjectsDir,
    codexHome,
    geminiChats,
    cleanup: () => fs.promises.rm(root, { recursive: true, force: true }),
  };
}

function resultFor(response, sessionId) {
  return response.results.find((result) => result.sessionId === sessionId);
}

test('batch probe distinguishes active, archived, missing, and exact Gemini files', async () => {
  const f = await fixture();
  try {
    await fs.promises.writeFile(path.join(f.claudeProjectsDir, '-tmp-project', `${CLAUDE_ID}.jsonl`), '{}\n');
    await fs.promises.writeFile(
      path.join(f.codexHome, 'sessions', '2026', '08', '30', `rollout-2026-08-30T00-00-00-${CODEX_ID}.jsonl`),
      '{}\n',
    );
    await fs.promises.writeFile(
      path.join(f.codexHome, 'archived_sessions', `rollout-archived-${ARCHIVED_ID}.jsonl`),
      '{}\n',
    );
    await fs.promises.writeFile(
      path.join(f.geminiChats, `session-2026-08-30-${GEMINI_ID.slice(-8)}.json`),
      JSON.stringify({ sessionId: GEMINI_ID, messages: [] }),
    );
    const service = new AgentSessionAvailabilityService({
      claudeProjectsDir: f.claudeProjectsDir,
      codexHome: f.codexHome,
      resolveGeminiProjectDir: () => ({ chatsDir: f.geminiChats }),
    });
    const response = await service.probeBatch({ sessions: [
      { tabId: 'claude-tab', provider: 'claude', sessionId: CLAUDE_ID },
      { tabId: 'codex-tab', provider: 'codex', sessionId: CODEX_ID },
      { tabId: 'archive-tab', provider: 'codex', sessionId: ARCHIVED_ID },
      { tabId: 'gemini-tab', provider: 'gemini', sessionId: GEMINI_ID, cwd: '/tmp/project' },
      { tabId: 'missing-tab', provider: 'claude', sessionId: SOURCE_ID },
    ] });
    assert.equal(response.success, true);
    assert.equal(resultFor(response, CLAUDE_ID).state, 'available');
    assert.equal(resultFor(response, CODEX_ID).state, 'available');
    assert.equal(resultFor(response, ARCHIVED_ID).state, 'archived');
    assert.equal(resultFor(response, GEMINI_ID).state, 'available');
    assert.equal(resultFor(response, SOURCE_ID).state, 'missing');
  } finally {
    await f.cleanup();
  }
});

test('thin Codex child becomes partial when an exact manifest source is absent', async () => {
  const f = await fixture();
  try {
    await fs.promises.writeFile(
      path.join(f.codexHome, 'sessions', '2026', '08', '30', `rollout-${CHILD_ID}.jsonl`),
      '{}\n',
    );
    const service = new AgentSessionAvailabilityService({
      claudeProjectsDir: f.claudeProjectsDir,
      codexHome: f.codexHome,
      getCodexLineageManifest: (sessionId) => sessionId === CHILD_ID ? {
        sourceSegments: [{ physicalSessionId: SOURCE_ID }],
      } : null,
    });
    const response = await service.probeBatch({ sessions: [
      { tabId: 'child-tab', provider: 'codex', sessionId: CHILD_ID },
    ] });
    assert.equal(resultFor(response, CHILD_ID).state, 'partial');
    assert.equal(resultFor(response, CHILD_ID).reason, 'lineage-source-file-missing');
    assert.deepEqual(resultFor(response, CHILD_ID).missingDependencies, [SOURCE_ID]);
  } finally {
    await f.cleanup();
  }
});

test('a new live binding gets a bounded materialization grace, then becomes missing', async () => {
  const f = await fixture();
  let now = 1_000;
  try {
    const service = new AgentSessionAvailabilityService({
      claudeProjectsDir: f.claudeProjectsDir,
      codexHome: f.codexHome,
      isRuntimeActive: () => true,
      materializationGraceMs: 15_000,
      now: () => now,
    });
    const descriptor = { tabId: 'live-tab', provider: 'codex', sessionId: CODEX_ID };
    const first = await service.probeBatch({ sessions: [descriptor], force: true });
    assert.equal(resultFor(first, CODEX_ID).state, 'checking');
    now += 15_001;
    const afterGrace = await service.probeBatch({ sessions: [descriptor], force: true });
    assert.equal(resultFor(afterGrace, CODEX_ID).state, 'missing');
    assert.equal(resultFor(afterGrace, CODEX_ID).reason, 'session-file-not-found');
  } finally {
    await f.cleanup();
  }
});

test('a file that disappears after being observed is missing even while runtime stays alive', async () => {
  const f = await fixture();
  const filePath = path.join(f.codexHome, 'sessions', '2026', '08', '30', `rollout-${CODEX_ID}.jsonl`);
  try {
    await fs.promises.writeFile(filePath, '{}\n');
    const service = new AgentSessionAvailabilityService({
      claudeProjectsDir: f.claudeProjectsDir,
      codexHome: f.codexHome,
      isRuntimeActive: () => true,
    });
    const descriptor = { tabId: 'live-tab', provider: 'codex', sessionId: CODEX_ID };
    assert.equal(resultFor(await service.probeBatch({ sessions: [descriptor], force: true }), CODEX_ID).state, 'available');
    await fs.promises.unlink(filePath);
    const missing = resultFor(await service.probeBatch({ sessions: [descriptor], force: true }), CODEX_ID);
    assert.equal(missing.state, 'missing');
    assert.equal(missing.reason, 'session-file-disappeared');
  } finally {
    await f.cleanup();
  }
});

test('an audited Noted deletion bypasses launch grace and carries forensic metadata', async () => {
  const f = await fixture();
  try {
    const service = new AgentSessionAvailabilityService({
      claudeProjectsDir: f.claudeProjectsDir,
      codexHome: f.codexHome,
      isRuntimeActive: () => true,
    });
    service.noteDeletedSessions([CLAUDE_ID], {
      source: 'dashboard',
      operationId: 'delete-op',
      deletedAt: 1234,
    });
    const response = await service.probeBatch({ sessions: [
      { tabId: 'deleted-tab', provider: 'claude', sessionId: CLAUDE_ID },
    ], force: true });
    const deleted = resultFor(response, CLAUDE_ID);
    assert.equal(deleted.state, 'missing');
    assert.equal(deleted.reason, 'deleted-by-noted-terminal');
    assert.equal(deleted.deletedAt, 1234);
    assert.equal(deleted.deletionSource, 'dashboard');
    assert.equal(deleted.deletionOperationId, 'delete-op');
  } finally {
    await f.cleanup();
  }
});

test('restoring the exact file clears the derived missing state and deletion tombstone', async () => {
  const f = await fixture();
  const filePath = path.join(f.claudeProjectsDir, '-tmp-project', `${CLAUDE_ID}.jsonl`);
  try {
    const service = new AgentSessionAvailabilityService({
      claudeProjectsDir: f.claudeProjectsDir,
      codexHome: f.codexHome,
    });
    const descriptor = { tabId: 'restored-tab', provider: 'claude', sessionId: CLAUDE_ID };
    service.noteDeletedSessions([CLAUDE_ID], { source: 'dashboard', deletedAt: 1234 });
    assert.equal(resultFor(await service.probeBatch({ sessions: [descriptor], force: true }), CLAUDE_ID).state, 'missing');
    await fs.promises.writeFile(filePath, '{}\n');
    const restored = resultFor(await service.probeBatch({ sessions: [descriptor], force: true }), CLAUDE_ID);
    assert.equal(restored.state, 'available');
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.deletionSource, null);
  } finally {
    await f.cleanup();
  }
});
