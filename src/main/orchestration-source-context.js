'use strict';

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

module.exports = { sourceCompletionFacts, completionContextText };
