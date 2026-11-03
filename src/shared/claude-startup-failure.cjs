'use strict';

const text = (value) => typeof value === 'string' ? value.trim() : '';

const CLAUDE_AUTH_EXPIRED_CODE = 'claude_auth_expired';

function unwrapClaudeLocalCommandFailure(value) {
  const raw = text(value);
  const wrapped = raw.match(/^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>$/i);
  return text(wrapped?.[2] ?? raw);
}

function inferClaudeStartupFailureCode(value, explicitCode = null) {
  const supplied = text(explicitCode);
  const message = unwrapClaudeLocalCommandFailure(value);
  if (/^API error:\s*403\b/i.test(message)) return 'claude_access_denied';
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

function describeClaudeStartupFailure({
  error,
  errorCode = null,
  failedCommand = null,
} = {}) {
  const message = unwrapClaudeLocalCommandFailure(error?.message || error)
    || 'Claude startup setting was not applied';
  const code = inferClaudeStartupFailureCode(message, errorCode || error?.code);
  const command = text(failedCommand);
  const title = /^API error\b/i.test(message) || code === CLAUDE_AUTH_EXPIRED_CODE
    || code === 'claude_rate_limit' ? 'API error' : 'Settings error';
  if (code === 'claude_access_denied') return {
    code, message, title, userMessage: 'Claude: доступ запрещён', subtitle: 'Claude: доступ запрещён',
    detail: 'Провайдер отклонил текущую авторизацию. Повтор настройки не меняет доступ аккаунта.',
  };
  if (code === 'claude_rate_limit') return {
    code, message, title, userMessage: 'Claude: достигнут лимит запросов', subtitle: 'Claude: достигнут лимит запросов',
    detail: 'Выберите доступную модель или повторите позже. Перезапуск не сбрасывает лимит.',
  };
  if (code === CLAUDE_AUTH_EXPIRED_CODE) {
    return {
      code,
      message,
      title,
      userMessage: 'Claude: нужно войти в аккаунт заново',
      subtitle: 'Claude: нужно войти в аккаунт заново',
      detail: 'Выполните /login в терминале, затем повторите настройку.',
    };
  }
  // An unresolved read deadline is NOT a provider rejection. Claude writes the
  // `/model` or `/effort` wrapper record and its result into the transcript on
  // its own schedule: observed 0.3s on a quiet tab, but 30.6s while Main was
  // busy (2026-10-31, tab 6d6fd1718b66 — the command did apply, at
  // 07:38:43.083, under the same commandId). Saying "не удалось применить"
  // there tells the user the opposite of what happened, and a late proof may
  // still arrive and settle it. Keep it a distinct pending state so callers can
  // present waiting instead of failure; `pending:true` marks exactly that.
  // The terminal belongs to another operation right now — a Rewind rewriting
  // this very session is the usual case. Nothing was rejected and nothing is
  // broken; the setting simply has not been written yet. Showing it in the
  // red "Settings error" colour read as a failure of the Rewind that had just
  // succeeded (02.11). Same pending channel as an unconfirmed outcome.
  // Matched on the message because that is what actually arrives: the gate
  // publishes `error=history_input_mutation_pending` with no errorCode
  // (observed 02.11 13:43:40 and 13:56:27), while the refusal built in
  // sendClaudeCommandInternal carries its reason as `claude_setting_write_refused`.
  if (/history_input_mutation_pending|setting-history-input-held/.test(message)) {
    return {
      code, message, title: 'Settings pending', pending: true,
      userMessage: 'Claude: настройки ждут освобождения ввода',
      subtitle: 'Терминал занят другой операцией',
      detail: 'Вводом владеет другая операция этой вкладки — обычно Rewind, который'
        + ' перезапускает сессию. Это не отказ: настройка применится, как только ввод освободится.',
    };
  }
  // Claude answered, but applied something else. The usual cause is the
  // ANTHROPIC_MODEL environment variable, which overrides the picker and is
  // named right in Claude's own stdout ("… ANTHROPIC_MODEL is set to `Opus
  // 5.5`"). Saying only "не удалось применить" hid the single fact the user
  // needs: the choice lost to an env var, so repeating it changes nothing.
  if (code === 'claude_setting_applied_different') {
    const env = /ANTHROPIC_MODEL\s+is\s+set\s+to\s+`?([^`\n]+)`?/i.exec(message)?.[1]?.trim() || null;
    const actual = /Set model to\s+`?([^`\n]+?)`?(?:\s+and saved|\s*$)/im.exec(message)?.[1]?.trim()
      || /Set effort level to\s+([a-z-]+)/i.exec(message)?.[1] || null;
    const target = command.startsWith('/effort') ? 'уровень усилий' : 'модель';
    return {
      code, message, title: 'Settings error',
      userMessage: 'Claude: применил другую ' + (target === 'модель' ? 'модель' : 'настройку')
        + (actual ? ' — ' + actual : ''),
      subtitle: env ? 'Выбор перекрыт переменной ANTHROPIC_MODEL' : 'Claude применил не то, что выбрано',
      detail: env
        ? 'Переменная окружения ANTHROPIC_MODEL = ' + env + ' сильнее выбора в меню:'
          + ' Claude ставит её значение и так и записывает в историю. Повтор выбора ничего не изменит —'
          + ' снимите или смените переменную.'
        : 'Claude подтвердил другое значение' + (actual ? ' (' + actual + ')' : '')
          + '. Это не потеря команды: она дошла и была обработана.',
    };
  }
  if (code === 'claude_setting_outcome_unknown') {
    const target = command.startsWith('/model') ? 'модель'
      : command.startsWith('/effort') ? 'уровень усилий' : 'настройку';
    return {
      code, message, title: 'Settings pending', pending: true,
      userMessage: 'Claude: ' + target + ' ещё не подтверждена',
      subtitle: 'Claude пока не подтвердил настройку',
      detail: 'Команда отправлена, подтверждение из истории Claude ещё не получено.'
        + ' Это не отказ: настройка могла примениться, и поздний результат обновит состояние.',
    };
  }
  return {
    code,
    message,
    title,
    userMessage: command.startsWith('/model') ? 'Claude: не удалось применить модель'
      : command.startsWith('/effort') ? 'Claude: не удалось применить уровень усилий'
        : 'Claude: не удалось применить настройки',
    subtitle: 'Настройки Claude не применены',
    detail: 'Выберите другую настройку или повторите позже. Подробности доступны через копирование ошибки.',
  };
}

// Two different things are both called "a failed startup setting":
//
//   1. The provider answered — rate limit, expired login, access denied, an
//      unknown model. A real request was spent and the user must act first.
//   2. Nothing was ever delivered. Our own helper (the Ctrl+G external editor)
//      timed out, so the Enter guard correctly withheld submission. The command
//      never reached Claude, there is no verdict, and the only consequence is
//      that the setting is not applied.
//
// Withholding Enter is right, and auto-retry after an unresolved delivery stays
// forbidden. But case 2 must not make a live tab refuse every later Send:
// incident 2026-10-31, tab 718f438d — `external_editor_timeout` at 08:27:50
// left pid 15603 alive and the user's 08:28:16 Send was refused anyway.
//
// One owner for that distinction, used by Main's presence projection and by the
// Send guard. Returns true only for a proven-undelivered local failure.
const STARTUP_NOT_DELIVERED_MARKERS = [
  'external_editor_timeout',
  'claude_startup_exact_input_failed',
  'claude_startup_editor_return_unresolved',
  'claude_startup_exact_empty_unresolved',
  'claude-startup-command-not-proven-at-enter',
  'enter-withheld',
];

function isClaudeStartupSettingUndelivered(gate = {}) {
  if (!gate || gate.status !== 'failed') return false;
  // A found proof means Claude did record the command's result; whatever that
  // result says, it is not an undelivered command.
  if (gate.proofOutcome === 'found') return false;
  return STARTUP_NOT_DELIVERED_MARKERS.some((marker) => text(gate.error).includes(marker)
    || text(gate.errorCode) === marker
    || text(gate.reason).includes(marker));
}

// The short UI text is not the incident record. Keep the full provider reason,
// including a trailing request_id, with the exact launch/attempt for Copy.
function formatClaudeStartupFailureReport({
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

function describeClaudeRestoreFailure(result = {}) {
  const error = result.detail || result.error;
  const failure = describeClaudeStartupFailure({ error,
    errorCode: result.runtime?.startupErrorCode, failedCommand: result.runtime?.startupFailedCommand });
  if (result.error === 'agent_startup_defaults_failed' || result.runtime?.startupFailed
    || ['claude_rate_limit', CLAUDE_AUTH_EXPIRED_CODE].includes(failure.code)) return failure.userMessage;
  if (result.error === 'agent_ready_timeout') return 'Claude не завершил подготовку. Подробности — в отчёте ошибки.';
  return 'Не удалось запустить Claude. Подробности — в отчёте ошибки.';
}

module.exports = { CLAUDE_AUTH_EXPIRED_CODE, STARTUP_NOT_DELIVERED_MARKERS, unwrapClaudeLocalCommandFailure, inferClaudeStartupFailureCode, isClaudeStartupSettingUndelivered, describeClaudeStartupFailure, formatClaudeStartupFailureReport, describeClaudeRestoreFailure };
