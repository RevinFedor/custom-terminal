'use strict';

const { CODEX_MAX_MESSAGE_SCALARS, codexProviderScalarCount } = require('./agent-provider-input-limit');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const KIND = 'codex-message-length';
function inputRejectionOccurrences(snapshot) {
  const rows = [...(snapshot?.preViewportLines || []), ...(snapshot?.lines || [])]
    .map(row => typeof row === 'string' ? row : row?.text || '');
  const result = [];
  for (let i = 0; i < rows.length; i++) {
    if (!/^\s*\u25a0\s*Message exceeds the maximum length of\b/.test(rows[i])) continue;
    let message = rows[i];
    for (let j = i; j < Math.min(i + 4, rows.length); j++) {
      if (j > i) {
        if (!rows[j].trim() || /^\s*\u25a0/.test(rows[j])) break;
        message += '\n' + rows[j];
      }
      const match = /^\s*\u25a0\s*Message exceeds the maximum length of\s*(\d+)\s+characters\s*\(\s*(\d+)\s+provided\)\.\s*$/.exec(message);
      if (match) {
        const max = Number(match[1]), actual = Number(match[2]);
        if (max === CODEX_MAX_MESSAGE_SCALARS && Number.isSafeInteger(actual) && actual > max) result.push({ max, actual });
        break;
      }
    }
  }
  return result;
}
function captureCodexInputRejectionBaseline(snapshot, audit) {
  if (snapshot?.success !== true || snapshot.authoritativeFrameCommitted !== true || snapshot.committedFrameReplay
    || !snapshot.mirrorGeneration || !Number.isSafeInteger(snapshot.committedFrameGeneration)
    || typeof audit?.expectedText !== 'string' || !audit.expectedHash) return { usable: false };
  const actual = Number.isSafeInteger(audit.inputScalarCount) ? audit.inputScalarCount
    : audit.expectedText.length > CODEX_MAX_MESSAGE_SCALARS ? codexProviderScalarCount(audit.expectedText) : audit.expectedText.length;
  if (actual <= CODEX_MAX_MESSAGE_SCALARS) return { usable: false };
  return Object.freeze({ usable: true, actual, transportHash: audit.expectedHash, expectedLen: audit.expectedLen,
    mirrorGeneration: snapshot.mirrorGeneration, frame: snapshot.committedFrameGeneration, writeSeq: snapshot.writeSeq,
    matchingCount: inputRejectionOccurrences(snapshot).filter(row => row.actual === actual).length });
}
function classifyCodexInputRejectionFrame({ baseline, snapshot, audit, record, identity } = {}) {
  const refuse = reason => ({ rejected: false, reason });
  if (!baseline?.usable || audit?.submitWritten !== true || audit.finished || audit.providerQueueAcceptedResult
    || baseline.transportHash !== audit.expectedHash || baseline.expectedLen !== audit.expectedLen) return refuse('audit-not-current');
  if (!record || !['enter-armed', 'audit-pending'].includes(record.state) || record.auditIdentity
    || record.deliveryControl?.cancelledAt || record.receipt?.providerQueue?.accepted || record.receipt?.providerQueueAccepted
    || record.provider !== 'codex' || record.operationKey !== audit.sendOperationKey || record.attemptId !== audit.sendAttemptId
    || record.handoffId !== audit.handoffId || record.tabId !== identity?.tabId
    || record.sessionId && record.sessionId !== identity.sessionId) return refuse('receipt-not-current');
  if (snapshot?.success !== true || snapshot.authoritativeFrameCommitted !== true || snapshot.committedFrameReplay
    || snapshot.synchronizedOutputOpen || snapshot.liveSynchronizedOutputOpen
    || snapshot.mirrorGeneration !== baseline.mirrorGeneration || identity?.mirrorGeneration !== baseline.mirrorGeneration
    || !(snapshot.committedFrameGeneration > baseline.frame) || !(snapshot.writeSeq > baseline.writeSeq)) return refuse('frame-not-fresh');
  if (identity.sameTerminal !== true || identity.writeQueueOwned !== true || identity.turnBusy !== false
    || identity.runSeq !== audit.enterRunSeq || identity.lifecycleGeneration !== audit.enterLifecycleGeneration
    || identity.inputRevision !== audit.enterInputRevision) return refuse('input-owner-changed');
  const matchingCount = inputRejectionOccurrences(snapshot).filter(row => row.actual === baseline.actual).length;
  if (!(matchingCount > baseline.matchingCount)) return refuse('no-new-exact-rejection');
  return { rejected: true, proof: { version: 1, kind: KIND, provider: 'codex',
    tabId: record.tabId, sessionId: record.sessionId || null,
    operationKey: record.operationKey, attemptId: record.attemptId, handoffId: record.handoffId,
    promptHash: record.promptHash, transportHash: baseline.transportHash, actual: baseline.actual,
    max: CODEX_MAX_MESSAGE_SCALARS, unit: 'unicode-scalars', mirrorGeneration: baseline.mirrorGeneration,
    baselineFrame: baseline.frame, committedFrameGeneration: snapshot.committedFrameGeneration,
    baselineWriteSeq: baseline.writeSeq, writeSeq: snapshot.writeSeq,
    baselineMatchingCount: baseline.matchingCount, matchingCount,
    runSeq: identity.runSeq, lifecycleGeneration: identity.lifecycleGeneration, inputRevision: identity.inputRevision } };
}
function isExactCodexInputRejectionReceipt(receipt) {
  const p = receipt?.providerInputRejection, limit = receipt?.inputLimit;
  return receipt?.code === 'codex_message_too_large' && receipt.provider === 'codex'
    && receipt.success === false && receipt.submitted === true && receipt.pasteWritten === true && receipt.enterWritten === true
    && receipt.semanticStatus === 'not-submitted' && receipt.providerAccepted === false && receipt.providerTurnCreated === false
    && receipt.composerDraftState === 'exact-provider-length-rejection' && receipt.lateReconciliationPending === false
    && p?.version === 1 && p.kind === KIND && p.provider === 'codex'
    && ['tabId', 'operationKey', 'attemptId', 'handoffId', 'promptHash'].every(key => typeof p[key] === 'string' && p[key] && p[key] === receipt[key])
    && p.sessionId === (receipt.sessionId || null)
    && typeof p.transportHash === 'string' && p.transportHash && p.transportHash === receipt.expectedHash
    && Number.isSafeInteger(p.actual) && p.actual > p.max && p.max === CODEX_MAX_MESSAGE_SCALARS
    && limit?.actual === p.actual && limit.max === p.max && limit.unit === p.unit && limit.provider === 'codex'
    && p.unit === 'unicode-scalars' && !!p.mirrorGeneration && !!p.lifecycleGeneration
    && Number.isSafeInteger(p.runSeq) && p.runSeq > 0 && Number.isSafeInteger(p.inputRevision)
    && ['baselineFrame', 'committedFrameGeneration', 'baselineWriteSeq', 'writeSeq', 'baselineMatchingCount', 'matchingCount']
      .every(key => Number.isSafeInteger(p[key]) && p[key] >= 0)
    && p.committedFrameGeneration > p.baselineFrame && p.writeSeq > p.baselineWriteSeq
    && p.matchingCount > p.baselineMatchingCount;
}
function codexInputRejectionMatchesRecord(record, receipt) {
  return isExactCodexInputRejectionReceipt(receipt) && record?.provider === 'codex'
    && ['enter-armed', 'audit-pending'].includes(record.state) && !record.auditIdentity
    && !record.deliveryControl?.cancelledAt && !record.receipt?.providerQueue?.accepted && !record.receipt?.providerQueueAccepted
    && ['tabId', 'operationKey', 'attemptId', 'handoffId', 'promptHash'].every(key => record[key] === receipt[key])
    && (record.sessionId || null) === (receipt.sessionId || null)
    && typeof record.receipt?.transportText === 'string'
    && promptAuditFingerprint(record.receipt.transportText) === receipt.providerInputRejection.transportHash;
}
module.exports = { inputRejectionOccurrences, captureCodexInputRejectionBaseline, classifyCodexInputRejectionFrame,
  isExactCodexInputRejectionReceipt, codexInputRejectionMatchesRecord };
