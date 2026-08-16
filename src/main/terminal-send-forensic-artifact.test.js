'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  persistTerminalSendForensicArtifact,
  removeTerminalSendForensicArtifact,
} = require('./terminal-send-forensic-artifact');

async function createTempDir(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-send-forensics-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('persists one private atomic artifact per exact send attempt', async (t) => {
  const logsDir = await createTempDir(t);
  const base = {
    logsDir,
    tabId: 'project-tab-a',
    provider: 'claude',
    attempt: {
      enterInputId: 7,
      sendAttemptId: 'attempt-a',
      sendOperationKey: 'operation-a',
      sentAt: 100,
    },
    incident: { error: 'claude_user_message_audit_timeout' },
    trace: { window: { anchorFound: true }, transitions: [], inputs: [] },
    capturedAt: 200,
  };

  const firstPath = await persistTerminalSendForensicArtifact(base);
  const secondPath = await persistTerminalSendForensicArtifact({
    ...base,
    capturedAt: 201,
  });

  assert.equal(secondPath, firstPath);
  assert.equal((await fs.promises.stat(firstPath)).mode & 0o777, 0o600);
  const artifact = JSON.parse(await fs.promises.readFile(firstPath, 'utf8'));
  assert.equal(artifact.kind, 'terminal-send-post-enter-forensics');
  assert.equal(artifact.capturedAt, 201);
  assert.equal(artifact.attempt.sendAttemptId, 'attempt-a');
  assert.deepEqual(await fs.promises.readdir(logsDir), [path.basename(firstPath)]);
});

test('different attempts never overwrite each other and can be removed after late success', async (t) => {
  const logsDir = await createTempDir(t);
  const common = {
    logsDir,
    tabId: 'project-tab-a',
    provider: 'claude',
    incident: { semanticStatus: 'unknown' },
    trace: { window: { anchorFound: true }, transitions: [], inputs: [] },
  };
  const firstPath = await persistTerminalSendForensicArtifact({
    ...common,
    attempt: { enterInputId: 1, sendAttemptId: 'attempt-a', sentAt: 100 },
  });
  const secondPath = await persistTerminalSendForensicArtifact({
    ...common,
    attempt: { enterInputId: 2, sendAttemptId: 'attempt-b', sentAt: 101 },
  });

  assert.notEqual(firstPath, secondPath);
  assert.equal((await fs.promises.readdir(logsDir)).length, 2);
  assert.equal(await removeTerminalSendForensicArtifact(firstPath), true);
  assert.equal(await removeTerminalSendForensicArtifact(firstPath), false);
  assert.deepEqual(await fs.promises.readdir(logsDir), [path.basename(secondPath)]);
});
