'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function safeFilePart(value, fallback = 'unknown') {
  const normalized = String(value || '')
    .replace(/[^a-z0-9_-]/gi, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function buildAttemptIdentity({ tabId, provider, attempt = {} }) {
  return {
    tabId: String(tabId || ''),
    provider: String(provider || 'unknown'),
    enterInputId: Number.isFinite(Number(attempt.enterInputId))
      ? Number(attempt.enterInputId)
      : null,
    handoffId: attempt.handoffId || null,
    sendAttemptId: attempt.sendAttemptId || null,
    sendOperationKey: attempt.sendOperationKey || null,
    sentAt: Number.isFinite(Number(attempt.sentAt)) ? Number(attempt.sentAt) : null,
  };
}

function buildTerminalSendForensicArtifactPath({ logsDir, tabId, provider, attempt = {} }) {
  const identity = buildAttemptIdentity({ tabId, provider, attempt });
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(identity), 'utf8')
    .digest('hex')
    .slice(0, 16);
  const safeTab = safeFilePart(String(tabId || '').slice(-24), 'tab');
  const safeProvider = safeFilePart(provider, 'agent');
  const timestamp = Number.isFinite(Number(attempt.sentAt))
    ? Number(attempt.sentAt)
    : 0;
  return path.join(
    logsDir,
    `terminal-send-forensics-${safeProvider}-${safeTab}-${timestamp}-${digest}.json`,
  );
}

async function persistTerminalSendForensicArtifact({
  logsDir,
  tabId,
  provider = 'unknown',
  attempt = {},
  incident = {},
  trace,
  capturedAt = Date.now(),
}) {
  if (!logsDir || !tabId || !trace) return null;
  const artifactPath = buildTerminalSendForensicArtifactPath({
    logsDir,
    tabId,
    provider,
    attempt,
  });
  await fs.promises.mkdir(logsDir, { recursive: true });
  const temporaryPath = artifactPath + '.tmp-' + process.pid + '-' + crypto.randomUUID();
  try {
    await fs.promises.writeFile(
      temporaryPath,
      JSON.stringify({
        kind: 'terminal-send-post-enter-forensics',
        version: 1,
        capturedAt,
        tabId,
        provider,
        attempt: buildAttemptIdentity({ tabId, provider, attempt }),
        incident,
        trace,
      }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
    await fs.promises.rename(temporaryPath, artifactPath);
    return artifactPath;
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function removeTerminalSendForensicArtifact(artifactPath) {
  if (!artifactPath) return false;
  try {
    await fs.promises.unlink(artifactPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = {
  buildTerminalSendForensicArtifactPath,
  persistTerminalSendForensicArtifact,
  removeTerminalSendForensicArtifact,
};
