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

// Presentation only. A system api_error may describe a retry that is still
// running; a local-command rejection is not the outcome of a model turn.
// Do not use these rows as Stop/Send/orchestration completion evidence.
function claudeHistoryFailureFromRecord(record) {
  if (!record || record.isSidechain) return null;
  const assistantFailure = claudeProviderFailureFromRecord(record);
  if (assistantFailure) return assistantFailure;
  if (record.type !== 'system') return null;
  if (record.subtype === 'api_error') {
    const error = record.error;
    const message = failureText(error) || failureText(error?.error)
      || failureText(record.content) || failureText(record.cause);
    return {
      ...classifyClaudeProviderFailure({ error: error?.error || error, message,
        details: record.errorDetails, status: error?.status || record.apiErrorStatus }),
      source: 'api-retry',
      ...(Number.isFinite(record.retryInMs) ? { retryInMs: record.retryInMs } : {}),
      ...(Number.isFinite(record.retryAttempt) ? { retryAttempt: record.retryAttempt } : {}),
      ...(Number.isFinite(record.maxRetries) ? { maxRetries: record.maxRetries } : {}),
    };
  }
  if (record.subtype !== 'local_command' || typeof record.content !== 'string') return null;
  const match = record.content.trim().match(/^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>$/i);
  if (!match) return null;
  const message = match[2].trim();
  // stdout also carries successful settings, help and status output. Only
  // explicit failures of this typed service carrier belong in the error lane.
  if (!message || (match[1].toLowerCase() !== 'stderr'
    && !/^(?:API error\s*:|Error\s*:|Unable to validate model\b|(?:Failed|Unable) to\b|Invalid (?:model|effort)\b|Model\b[^\n]*\bnot found\b)/i.test(message))) return null;
  const status = message.match(/^API error:\s*(\d{3})\b/i);
  return { ...classifyClaudeProviderFailure({ message, status: status ? Number(status[1]) : undefined }),
    source: 'local-command' };
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

module.exports = { classifyClaudeProviderFailure, claudeProviderFailureFromRecord, claudeHistoryFailureFromRecord, claudeProviderFailureFromHook };
