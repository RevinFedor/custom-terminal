'use strict';

const {
  fingerprintAgentSendRequest,
} = require('./agent-send-receipt-registry');

const DESKTOP_HISTORY_SEND_SURFACE = 'desktop-history';
const DESKTOP_HISTORY_SEND_VERSION = 1;
const DESKTOP_HISTORY_SEND_SOURCES = new Set([
  'history-panel',
  'codex-history-panel',
  'prompt-queue',
  'prompt-loop',
]);

const DESKTOP_AUTOMATION_SEND_SOURCES = new Set([
  'prompt-queue',
  'prompt-loop',
]);

const ORCHESTRATION_COMPLETION_SEND_SOURCE_PREFIX = 'orchestration-completion:';

function isOwnedDesktopHistorySendSource(source) {
  const normalized = String(source || '');
  if (DESKTOP_HISTORY_SEND_SOURCES.has(normalized)) return true;
  // Codex's physical writer adds one provider prefix to the scenario origin.
  // Recognize only known automation/completion origins under that wrapper;
  // keep the raw source unchanged in fingerprints and persisted attempt data.
  const origin = normalized.startsWith('codex-') ? normalized.slice('codex-'.length) : normalized;
  return DESKTOP_AUTOMATION_SEND_SOURCES.has(origin)
    || (
      origin.startsWith(ORCHESTRATION_COMPLETION_SEND_SOURCE_PREFIX)
      && origin.slice(ORCHESTRATION_COMPLETION_SEND_SOURCE_PREFIX.length).trim().length > 0
    );
}

function requiredString(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new TypeError(label + ' must be a non-empty string');
  return normalized;
}

function optionalString(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

/**
 * Локальная slash-команда: у неё нет обычной записи ответа, поэтому и обычной
 * расписки об отправке быть не должно.
 *
 * Ведущие пробелы отбрасываются, как и в остальных проверках slash по проекту:
 * пользователь мог начать строку с пробела, команда от этого локальной быть не
 * перестала.
 */
function isLocalSlashCommandPrompt(rawPrompt) {
  if (typeof rawPrompt !== 'string') return false;
  const normalized = rawPrompt.trim();
  return !!normalized
    && !normalized.includes('\n')
    && !normalized.includes('\r')
    && /^\/[^\s/]+(?:[ \t].*)?$/.test(normalized);
}

function isDesktopHistorySendReceiptEligible(input = {}) {
  const source = String(input.source || '');
  const rawPrompt = typeof input.rawPrompt === 'string' ? input.rawPrompt : null;
  const presentation = input.presentationSnapshot && typeof input.presentationSnapshot === 'object'
    ? input.presentationSnapshot
    : {};
  const hasStructuredPayload = (Array.isArray(presentation.imagePaths) && presentation.imagePaths.length > 0)
    || (Array.isArray(presentation.promptChips) && presentation.promptChips.length > 0);
  return input.submit === true
    && !!optionalString(input.tabId)
    && !!optionalString(input.handoffId)
    && isOwnedDesktopHistorySendSource(source)
    // Local slash commands have a command-specific completion proof rather than
    // a user_message audit. Their local History row remains handoff-owned (and
    // can be dismissed locally); do not leave a generic prompt receipt
    // permanently pending for them.
    //
    // Applies to EVERY History send source, not just automation. The exception
    // used to be limited to the queue because a slash command could not be sent
    // from the composer at all — the renderer refused it before this point. Now
    // that the composer sends them, the same rule has to cover it: otherwise a
    // manual `/compact` mints a receipt that waits forever for an audit record
    // the command never produces, and the message stays UNCONFIRMED.
    && !(isLocalSlashCommandPrompt(rawPrompt) && !hasStructuredPayload)
    && !optionalString(input.sendOperationKey)
    && !optionalString(input.sendAttemptId);
}

function buildDesktopHistorySendIdentity(input = {}) {
  const tabId = requiredString(input.tabId, 'tabId');
  const handoffId = requiredString(input.handoffId, 'handoffId');
  const provider = requiredString(input.provider, 'provider');
  const source = requiredString(input.source, 'source');
  const rawPrompt = typeof input.rawPrompt === 'string'
    ? input.rawPrompt
    : (() => { throw new TypeError('rawPrompt must be a string'); })();
  const promptHash = requiredString(input.promptHash, 'promptHash');
  const promptLength = Number(input.promptLength);
  if (!Number.isSafeInteger(promptLength) || promptLength < 0) {
    throw new TypeError('promptLength must be a non-negative safe integer');
  }
  if (!isOwnedDesktopHistorySendSource(source)) {
    throw new TypeError('source must be an owned desktop History surface');
  }

  return Object.freeze({
    operationKey: `history:${tabId}:${handoffId}`,
    surface: DESKTOP_HISTORY_SEND_SURFACE,
    runId: null,
    tabId,
    handoffId,
    requestFingerprint: fingerprintAgentSendRequest({
      version: DESKTOP_HISTORY_SEND_VERSION,
      surface: DESKTOP_HISTORY_SEND_SURFACE,
      tabId,
      handoffId,
      provider,
      source,
      rawPrompt,
      // Conversation is request identity; the ready process generation is
      // attempt evidence. A reconnect/restart must still replay the original
      // operation rather than changing its fingerprint to a new process.
      ...(input.expectedTarget ? { expectedTarget: {
        toolType: input.expectedTarget.toolType || provider,
        sessionId: input.expectedTarget.sessionId || null,
      } } : {}),
    }),
    provider,
    sessionId: optionalString(input.sessionId),
    promptHash,
    promptLength,
  });
}

function desktopHistorySendReplayResult(record) {
  if (!record || typeof record !== 'object') {
    return {
      success: false,
      submitted: false,
      replayed: true,
      error: 'agent_send_receipt_missing',
    };
  }
  const base = {
    operationKey: record.operationKey || null,
    sendOperationKey: record.operationKey || null,
    attemptId: record.attemptId || null,
    sendAttemptId: record.attemptId || null,
    handoffId: record.handoffId || null,
    status: record.state || null,
    replayed: true,
  };
  const providerQueue = record.receipt?.providerQueue;
  const providerQueueAccepted = providerQueue?.accepted === true
    && providerQueue.provider === record.provider
    && providerQueue.operationKey === record.operationKey
    && providerQueue.attemptId === record.attemptId;
  if (providerQueueAccepted
    && (record.state === 'enter-armed'
      || record.state === 'audit-pending'
      || record.state === 'delivery-unknown')) {
    return {
      ...(record.receipt || {}),
      ...base,
      success: true,
      accepted: true,
      submitted: true,
      queued: true,
      status: 'queued',
      receiptState: record.state,
      providerQueueAccepted: true,
      auditPending: false,
      deliveryUnknown: false,
    };
  }
  if (record.receipt && typeof record.receipt === 'object') {
    return { ...record.receipt, ...base };
  }
  if (record.state === 'confirmed') {
    return { success: true, submitted: true, exactAuditConfirmed: true, ...base };
  }
  if (record.state === 'audit-pending') {
    return {
      success: null,
      submitted: true,
      accepted: true,
      auditPending: true,
      ...base,
    };
  }
  return {
    success: null,
    submitted: null,
    accepted: true,
    deliveryUnknown: true,
    ...base,
  };
}

module.exports = {
  DESKTOP_HISTORY_SEND_SOURCES,
  DESKTOP_AUTOMATION_SEND_SOURCES,
  ORCHESTRATION_COMPLETION_SEND_SOURCE_PREFIX,
  DESKTOP_HISTORY_SEND_SURFACE,
  DESKTOP_HISTORY_SEND_VERSION,
  buildDesktopHistorySendIdentity,
  desktopHistorySendReplayResult,
  isDesktopHistorySendReceiptEligible,
  isOwnedDesktopHistorySendSource,
};
