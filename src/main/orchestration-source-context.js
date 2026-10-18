'use strict';

const { createHash } = require('node:crypto');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

// A dismissed attention badge is not evidence that the source model received
// its completion prompt. This is a small read projection of the SAME durable
// run, not another notification, result read, queue item or retry.
function sourceCompletionFacts(runs, { tabId, sessionId, toolType } = {}) {
  if (!tabId || !sessionId || !['claude', 'codex'].includes(toolType)) return [];
  return runs.filter(run => run.sourceTabId === tabId
    && run.notifySource !== false
    && run.notificationSuppressed === true
    && !!run.sourceAttentionDismissedAt
    && !run.sourceFollowupStartedAt
    && ['completed', 'failed', 'cancelled'].includes(run.status)
    && (run.status !== 'completed' || run.resultComplete === true)
    && (run.notificationSourceSessionId || run.sourceExecutionContext?.sessionId) === sessionId
    && (run.sourceToolType || run.sourceExecutionContext?.provider) === toolType)
    .sort((a, b) => (a.completedAt || a.updatedAt) - (b.completedAt || b.updatedAt))
    .map(run => ({
      id: JSON.stringify(['orchestration-completion-v1', run.runId, run.completedAt, toolType, sessionId]),
      // No labels, prompts, provider payloads or answer bodies in this channel.
      text: JSON.stringify({ runId: run.runId, status: run.status, outcome: run.outcome || run.status,
        resultComplete: run.resultComplete === true, completedAt: run.completedAt || null }).replace(/</g, '\\u003c'),
    }));
}

function completionContextText(facts) {
  if (!facts.length) return '';
  return [
    '<orchestration_state source="noted-terminal" version="1">',
    'Сохранённый факт для продолжения текущего разговора: эти запросы уже завершены, не running.',
    'Пользователь скрыл предупреждение об уведомлении; это не отменяет результат и не доказывает его прочтение.',
    ...facts.map(fact => fact.text),
    'Это только контекст к настоящему сообщению ниже, не повтор уведомления и не поручение начать новый run.',
    'Повтор этой справки с тем же runId при ручном Retry — тот же факт, не новый результат и не новая задача.',
    'Если результат уже прочитан, повторно его не запрашивай. Если он нужен и ещё не прочитан — один get_delegation_result по точному runId. Не полли и не создавай замену.',
    '</orchestration_state>',
  ].join('\n');
}

// The prefix is read from the app's frozen handoff, never discovered in user
// text. Only its exact confirmed carrier can acquire this display projection.
function completionContextPresentation(handoff, record) {
  const receipt = record?.receipt, audit = record?.auditIdentity;
  if (!handoff || record?.state !== 'confirmed' || !['claude', 'codex'].includes(record.provider)
    || handoff.tab_id !== record.tabId || handoff.handoff_id !== record.handoffId
    || !audit || audit.attemptId !== record.attemptId || audit.provider !== record.provider
    || !record.operationKey || !audit.sessionId || audit.sessionId !== record.sessionId
    || receipt?.sessionId !== audit.sessionId || receipt.exactAuditConfirmed !== true
    || !audit.auditTimestamp || !Number.isFinite(Date.parse(audit.auditTimestamp))
    || receipt.auditTimestamp !== audit.auditTimestamp
    || !audit.entryUuid && !audit.sourceIdentity
    || !handoff.prepared_prompt || receipt.transportText !== handoff.prepared_prompt
    || handoff.payload_hash !== promptAuditFingerprint(handoff.prepared_prompt)
    || audit.promptHash !== handoff.payload_hash || receipt.actualHash !== handoff.payload_hash) return null;
  let facts;
  try { facts = JSON.parse(handoff.continuation_facts || '[]').map(value => JSON.parse(value)); } catch { return null; }
  if (!facts.length || facts.length > 8 || facts.some(fact => !Array.isArray(fact) || fact.length !== 5
    || fact[0] !== 'orchestration-completion-v1' || typeof fact[1] !== 'string' || !fact[1]
    || fact[3] !== record.provider || fact[4] !== audit.sessionId)) return null;
  const prefix = handoff.prefix, open = '<orchestration_state source="noted-terminal" version="1">\n';
  const close = '\n</orchestration_state>\n\n';
  if (typeof prefix !== 'string' || !prefix.startsWith(open) || !handoff.prepared_prompt.startsWith(prefix)) return null;
  const boundary = prefix.indexOf(close);
  const bodyStart = boundary < 0 ? -1 : boundary + close.length;
  if (bodyStart < 0 || bodyStart > 16000 || bodyStart >= handoff.prepared_prompt.length) return null;
  return { id: 'orchestration-context:' + record.handoffId, kind: 'context-prefix', contextKind: 'orchestration-state',
    envelopeStart: 0, envelopeText: handoff.prepared_prompt.slice(0, bodyStart), bodyStart,
    bodyEnd: handoff.prepared_prompt.length,
    bodyProjectionHash: createHash('sha256').update(handoff.prepared_prompt).digest('hex') };
}

module.exports = { sourceCompletionFacts, completionContextText, completionContextPresentation };
