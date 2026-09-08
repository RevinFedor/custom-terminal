'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_ARTIFACTS = 50;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const ARTIFACT_DIRECTORY = 'terminal-history-preview-diagnostics';
const ARTIFACT_PREFIX = 'terminal-history-preview-';

function safeFilePart(value, fallback = 'unknown') {
  const normalized = String(value || '')
    .replace(/[^a-z0-9_-]/gi, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function normalizeIncidentId(value) {
  return safeFilePart(value || crypto.randomUUID(), 'incident');
}

function buildTerminalHistoryPreviewDiagnosticPath({
  logsDir,
  tabId,
  toolType,
  incidentId,
  capturedAt,
}) {
  const safeTab = safeFilePart(String(tabId || '').slice(-24), 'tab');
  const safeTool = safeFilePart(toolType, 'agent');
  const safeIncident = normalizeIncidentId(incidentId).slice(0, 64);
  const timestamp = Number.isFinite(Number(capturedAt)) ? Number(capturedAt) : Date.now();
  return path.join(
    logsDir,
    ARTIFACT_DIRECTORY,
    `${ARTIFACT_PREFIX}${safeTool}-${safeTab}-${timestamp}-${safeIncident}.json`,
  );
}

async function pruneTerminalHistoryPreviewDiagnostics({
  directory,
  keepPath = null,
  now = Date.now(),
  maxArtifacts = DEFAULT_MAX_ARTIFACTS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  if (!directory) return { removed: 0 };
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const artifacts = [];
  for (const entry of entries) {
    if (!entry.isFile()
      || !entry.name.startsWith(ARTIFACT_PREFIX)
      || !entry.name.endsWith('.json')) continue;
    const artifactPath = path.join(directory, entry.name);
    const stat = await fs.promises.stat(artifactPath).catch(() => null);
    if (!stat) continue;
    artifacts.push({ artifactPath, mtimeMs: Number(stat.mtimeMs || 0) });
  }
  artifacts.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const keepCount = Math.max(1, Number(maxArtifacts) || DEFAULT_MAX_ARTIFACTS);
  const cutoff = Number(now) - Math.max(60_000, Number(maxAgeMs) || DEFAULT_MAX_AGE_MS);
  let removed = 0;
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    if (artifact.artifactPath === keepPath) continue;
    if (index < keepCount && artifact.mtimeMs >= cutoff) continue;
    const didRemove = await fs.promises.unlink(artifact.artifactPath)
      .then(() => true)
      .catch((error) => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      });
    if (didRemove) removed += 1;
  }
  return { removed };
}

async function persistTerminalHistoryPreviewDiagnostic({
  logsDir,
  tabId,
  toolType,
  incidentId = crypto.randomUUID(),
  capturedAt = Date.now(),
  diagnostic,
  maxArtifacts = DEFAULT_MAX_ARTIFACTS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
}) {
  if (!logsDir || !tabId || !diagnostic) {
    throw new TypeError('logsDir, tabId and diagnostic are required');
  }
  const normalizedIncidentId = normalizeIncidentId(incidentId);
  const artifactPath = buildTerminalHistoryPreviewDiagnosticPath({
    logsDir,
    tabId,
    toolType,
    incidentId: normalizedIncidentId,
    capturedAt,
  });
  const directory = path.dirname(artifactPath);
  await fs.promises.mkdir(directory, { recursive: true });
  const temporaryPath = artifactPath + '.tmp-' + process.pid + '-' + crypto.randomUUID();
  try {
    await fs.promises.writeFile(
      temporaryPath,
      JSON.stringify({
        kind: 'terminal-history-preview-diagnostic',
        version: 1,
        incidentId: normalizedIncidentId,
        capturedAt,
        tabId,
        toolType,
        diagnostic,
      }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
    await fs.promises.rename(temporaryPath, artifactPath);
    await pruneTerminalHistoryPreviewDiagnostics({
      directory,
      keepPath: artifactPath,
      now: capturedAt,
      maxArtifacts,
      maxAgeMs,
    });
    return {
      incidentId: normalizedIncidentId,
      capturedAt,
      artifactPath,
    };
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function buildTerminalHistoryPreviewDiagnosticReference({
  incidentId,
  capturedAt,
  artifactPath,
  tabId,
  toolType,
  sessionId = null,
  turnId = null,
  previewId = null,
  kind = 'preview',
  messageId = null,
  handoffId = null,
  queueStatus = null,
}) {
  return [
    kind === 'send' ? 'Terminal send diagnostic' : 'Terminal History preview diagnostic',
    `incidentId: ${incidentId || '-'}`,
    `capturedAt: ${Number.isFinite(Number(capturedAt))
      ? new Date(Number(capturedAt)).toISOString()
      : '-'}`,
    `tabId: ${tabId || '-'}`,
    `toolType: ${toolType || '-'}`,
    `sessionId: ${sessionId || '-'}`,
    `turnId: ${turnId || '-'}`,
    `previewId: ${previewId || '-'}`,
    ...(kind === 'send' ? [
      `messageId: ${messageId || '-'}`,
      `handoffId: ${handoffId || '-'}`,
      `queueStatusAtMenu: ${queueStatus || '-'}`,
    ] : []),
    `artifactPath: ${artifactPath || '-'}`,
  ].join('\n');
}

module.exports = {
  ARTIFACT_DIRECTORY,
  ARTIFACT_PREFIX,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_ARTIFACTS,
  buildTerminalHistoryPreviewDiagnosticPath,
  buildTerminalHistoryPreviewDiagnosticReference,
  persistTerminalHistoryPreviewDiagnostic,
  pruneTerminalHistoryPreviewDiagnostics,
};
