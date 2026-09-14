const text = (value) => typeof value === 'string' ? value.trim() : '';

export const CLAUDE_AUTH_EXPIRED_CODE = 'claude_auth_expired';

export function unwrapClaudeLocalCommandFailure(value) {
  const raw = text(value);
  const wrapped = raw.match(/^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>$/i);
  return text(wrapped?.[2] ?? raw);
}

export function inferClaudeStartupFailureCode(value, explicitCode = null) {
  const supplied = text(explicitCode);
  const message = unwrapClaudeLocalCommandFailure(value);
  if (/^API error:\s*429\b/i.test(message) || /"type"\s*:\s*"rate_limit_error"/.test(message)) return 'claude_rate_limit';
  if (
    /oauth refresh token is no longer valid/i.test(message)
    || /login expired/i.test(message)
    || /run \/login to re-authenticate/i.test(message)
  ) {
    return CLAUDE_AUTH_EXPIRED_CODE;
  }
  return supplied || 'claude_startup_setting_rejected';
}

export function describeClaudeStartupFailure({
  error,
  errorCode = null,
  failedCommand = null,
} = {}) {
  const message = unwrapClaudeLocalCommandFailure(error?.message || error)
    || 'Claude startup setting was not applied';
  const code = inferClaudeStartupFailureCode(message, errorCode || error?.code);
  const command = text(failedCommand);
  if (code === 'claude_rate_limit') return {
    code, message, userMessage: 'Claude: достигнут лимит запросов', subtitle: 'Claude: достигнут лимит запросов',
    detail: 'Выберите доступную модель или повторите позже. Перезапуск не сбрасывает лимит.',
  };
  if (code === CLAUDE_AUTH_EXPIRED_CODE) {
    return {
      code,
      message,
      userMessage: 'Claude: нужно войти в аккаунт заново',
      subtitle: 'Claude: нужно войти в аккаунт заново',
      detail: 'Выполните /login в терминале, затем повторите настройку.',
    };
  }
  return {
    code,
    message,
    userMessage: command.startsWith('/model') ? 'Claude: не удалось применить модель'
      : command.startsWith('/effort') ? 'Claude: не удалось применить уровень усилий'
        : 'Claude: не удалось применить настройки',
    subtitle: 'Настройки Claude не применены',
    detail: 'Выберите другую настройку или повторите позже. Подробности доступны через копирование ошибки.',
  };
}

// The short UI text is not the incident record. Keep the full provider reason,
// including a trailing request_id, with the exact launch/attempt for Copy.
export function formatClaudeStartupFailureReport({
  tabId, sessionId, generation, attemptId, failedCommand, error, errorCode, proofOutcome,
} = {}) {
  const failure = describeClaudeStartupFailure({ error, errorCode, failedCommand });
  return [
    'Noted Terminal Claude settings incident',
    'Error: ' + failure.message,
    'Error code: ' + failure.code,
    'Tab ID: ' + (tabId || '-'), 'Session ID: ' + (sessionId || '-'),
    'Launch: ' + (generation || '-'), 'Settings attempt: ' + (attemptId || '-'),
    'Command: ' + (failedCommand || '-'), 'Proof: ' + (proofOutcome || '-'),
  ].join('\n');
}

export function describeClaudeRestoreFailure(result = {}) {
  const error = result.detail || result.error;
  const failure = describeClaudeStartupFailure({ error,
    errorCode: result.runtime?.startupErrorCode, failedCommand: result.runtime?.startupFailedCommand });
  if (result.error === 'agent_startup_defaults_failed' || result.runtime?.startupFailed
    || ['claude_rate_limit', CLAUDE_AUTH_EXPIRED_CODE].includes(failure.code)) return failure.userMessage;
  if (result.error === 'agent_ready_timeout') return 'Claude не завершил подготовку. Подробности — в отчёте ошибки.';
  return 'Не удалось запустить Claude. Подробности — в отчёте ошибки.';
}
