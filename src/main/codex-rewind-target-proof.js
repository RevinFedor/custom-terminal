'use strict';

const crypto = require('node:crypto');

function normalizeCodexRewindTargetText(text) {
  return String(text || '').trim();
}

function hashCodexRewindTargetText(text) {
  return crypto
    .createHash('sha256')
    .update(normalizeCodexRewindTargetText(text))
    .digest('hex');
}

function buildCodexRewindMessageProof({
  text = '',
  images = [],
  textElements = [],
} = {}) {
  const normalizedText = normalizeCodexRewindTargetText(text);
  return {
    textHash: hashCodexRewindTargetText(normalizedText),
    signature: crypto
      .createHash('sha256')
      .update(JSON.stringify({
        text: normalizedText,
        images: Array.isArray(images) ? images.map(String) : [],
        textElements: Array.isArray(textElements) ? textElements : [],
      }))
      .digest('hex'),
  };
}

function classifyCodexStableSourceTranscriptRecovery({
  journal,
  currentSessionId = null,
  discoveryComplete = false,
  descendants = [],
  sourceMessages = [],
  sourceLifecycleEvents = [],
} = {}) {
  if (discoveryComplete !== true) {
    return { proven: false, reason: 'descendant-discovery-incomplete' };
  }
  if (Array.isArray(descendants) && descendants.length > 0) {
    return { proven: false, reason: 'descendant-present' };
  }
  if (!journal
    || journal.version !== 2
    || journal.phase !== 'confirm-enter-boundary'
    || !journal.sourceSessionId
    || !journal.actionGeneration
    || !Number.isFinite(Number(journal.actionStartedAtMs))
    || !Number.isInteger(Number(journal.targetSourceLine))
    || !journal.targetUuid
    || !journal.targetTextHash) {
    return { proven: false, reason: 'journal-boundary-incomplete' };
  }
  const expectedBinding = journal.expectedBindingSessionId || journal.sourceSessionId;
  if (expectedBinding !== journal.sourceSessionId
    || currentSessionId !== journal.sourceSessionId) {
    return { proven: false, reason: 'source-binding-not-stable' };
  }

  const messages = (Array.isArray(sourceMessages) ? sourceMessages : [])
    .filter((message) => Number.isInteger(Number(message?.sourceLine)))
    .sort((a, b) => Number(a.sourceLine) - Number(b.sourceLine));
  const target = messages.find((message) => (
    Number(message.sourceLine) === Number(journal.targetSourceLine)
    && message.uuid === journal.targetUuid
  ));
  if (!target || target.textHash !== journal.targetTextHash) {
    return { proven: false, reason: 'source-target-proof-mismatch' };
  }

  const startedAt = Number(journal.actionStartedAtMs);
  const firstPostActionMessage = messages.find((message) => (
    Number(message.sourceLine) > Number(journal.targetSourceLine)
    && Number.isFinite(Number(message.timestampMs))
    && Number(message.timestampMs) >= startedAt
  ));
  if (!firstPostActionMessage) {
    return { proven: false, reason: 'post-action-source-message-missing' };
  }
  const taskStarted = (Array.isArray(sourceLifecycleEvents) ? sourceLifecycleEvents : [])
    .filter((event) => (
      event?.type === 'task_started'
      && Number.isInteger(Number(event.sourceLine))
      && Number(event.sourceLine) > Number(journal.targetSourceLine)
      && Number(event.sourceLine) < Number(firstPostActionMessage.sourceLine)
      && Number.isFinite(Number(event.timestampMs))
      && Number(event.timestampMs) >= startedAt
      && Number(event.timestampMs) <= Number(firstPostActionMessage.timestampMs)
    ))
    .sort((a, b) => Number(a.sourceLine) - Number(b.sourceLine))[0] || null;
  if (!taskStarted) {
    return { proven: false, reason: 'post-action-source-task-start-missing' };
  }

  return {
    proven: true,
    reason: 'stable-source-task-and-user-message',
    sourceSessionId: journal.sourceSessionId,
    actionGeneration: journal.actionGeneration,
    targetSourceLine: Number(journal.targetSourceLine),
    taskStartedSourceLine: Number(taskStarted.sourceLine),
    userMessageSourceLine: Number(firstPostActionMessage.sourceLine),
    userMessageTimestampMs: Number(firstPostActionMessage.timestampMs),
  };
}

module.exports = {
  buildCodexRewindMessageProof,
  classifyCodexStableSourceTranscriptRecovery,
  hashCodexRewindTargetText,
  normalizeCodexRewindTargetText,
};
