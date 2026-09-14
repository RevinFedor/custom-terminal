'use strict';

function failureText(value) {
  if (typeof value === 'string') return value.trim();
  return typeof value?.message === 'string' ? value.message.trim() : '';
}

function classifyClaudeProviderFailure({ error, message, details, status } = {}) {
  const rawCode = typeof error === 'string' ? error : error?.type || '';
  const rateLimited = status === 429 || /^(?:rate_limit|rate_limit_error)$/.test(rawCode)
    || /(?:^API error:\s*429\b|"type"\s*:\s*"rate_limit_error")/i.test(details || message || '');
  return {
    code: rateLimited ? 'claude_rate_limit' : 'claude_provider_error',
    kind: rateLimited ? 'usage-limit' : 'provider-error',
    message: failureText(message) || failureText(error) || (rateLimited
      ? 'Claude: достигнут лимит запросов. Дождитесь восстановления лимита или выберите доступную модель.'
      : 'Claude завершил запрос с ошибкой.'),
    details: failureText(details) || null,
    status: Number.isInteger(status) ? status : (rateLimited ? 429 : null),
  };
}

// A quoted limit in an ordinary answer, user prompt or tool result is NOT an
// error. Claude supplies an explicit synthetic API-error record in its JSONL.
function claudeProviderFailureFromRecord(record) {
  if (record?.type !== 'assistant' || record.isApiErrorMessage !== true) return null;
  const content = record.message?.content;
  const message = typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
    .filter(block => block?.type === 'text').map(block => block.text || '').join('\n');
  return classifyClaudeProviderFailure({ error: record.error, message,
    details: record.errorDetails, status: record.apiErrorStatus });
}

function claudeProviderFailureFromHook(envelope) {
  if (envelope?.event !== 'StopFailure') return null;
  const failure = classifyClaudeProviderFailure({ error: envelope.error,
    details: failureText(envelope.error_details), status: envelope.apiErrorStatus });
  // Hook error is commonly just an enum (rate_limit), not user-facing prose.
  if (!envelope.error?.message && /^(?:\w+)?$/.test(failure.message)) {
    failure.message = failure.kind === 'usage-limit'
      ? 'Claude: достигнут лимит запросов. Дождитесь восстановления лимита или выберите доступную модель.'
      : 'Claude завершил запрос с ошибкой: ' + (failure.message || 'ошибка провайдера');
  }
  return failure;
}

module.exports = { classifyClaudeProviderFailure, claudeProviderFailureFromRecord, claudeProviderFailureFromHook };
