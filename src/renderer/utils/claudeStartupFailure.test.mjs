import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_AUTH_EXPIRED_CODE,
  describeClaudeStartupFailure,
  inferClaudeStartupFailureCode,
  unwrapClaudeLocalCommandFailure,
  formatClaudeStartupFailureReport,
} from './claudeStartupFailure.mjs';

const productionFailure = '<local-command-stdout>Unable to validate model: OAuth refresh token is no longer valid; run /login to re-authenticate</local-command-stdout>';

test('model 429 is a settings failure in a running process, not a failed launch', () => {
  const failure = describeClaudeStartupFailure({ error: 'API error: 429 {"error":{"type":"rate_limit_error"}}',
    failedCommand: '/model claude-fable-5[1m]' });
  assert.equal(failure.code, 'claude_rate_limit');
  assert.doesNotMatch(failure.detail, /Процесс запущен/, 'an error formatter has no current process proof');
  assert.match(failure.detail, /Перезапуск не сбрасывает лимит/);
});

test('Claude startup auth failure loses the JSONL envelope but keeps the exact reason', () => {
  assert.equal(
    unwrapClaudeLocalCommandFailure(productionFailure),
    'Unable to validate model: OAuth refresh token is no longer valid; run /login to re-authenticate',
  );
  assert.equal(inferClaudeStartupFailureCode(productionFailure), CLAUDE_AUTH_EXPIRED_CODE);
});

test('Claude startup auth failure tells the user to login before retrying the exact command', () => {
  const failure = describeClaudeStartupFailure({
    error: productionFailure,
    failedCommand: '/model claude-opus-5[1m]',
  });
  assert.equal(failure.code, CLAUDE_AUTH_EXPIRED_CODE);
  assert.equal(failure.subtitle, 'Claude: нужно войти в аккаунт заново');
  assert.equal(
    failure.detail,
    'Выполните /login в терминале, затем повторите настройку.',
  );
  assert.doesNotMatch(failure.message, /<local-command-stdout>/);
});

test('ordinary startup rejection keeps its exact error and stable generic code', () => {
  const failure = describeClaudeStartupFailure({
    error: "Model 'missing' not found",
    failedCommand: '/model missing',
  });
  assert.equal(failure.code, 'claude_startup_setting_rejected');
  assert.equal(failure.subtitle, 'Настройки Claude не применены');
  assert.equal(failure.message, "Model 'missing' not found");
  assert.doesNotMatch(failure.detail, /not found/);
});

test('short Russian UI keeps full 429 and request identity in Copy, including generic outer failure codes', () => {
  const raw = 'API error: 429 ' + JSON.stringify({ error: { type: 'rate_limit_error', message: 'reason '.repeat(100) }, request_id: 'request-late' });
  const fields = { error: raw, errorCode: 'agent_startup_defaults_failed', tabId: 'T', generation: 'L', attemptId: 'A' };
  const failure = describeClaudeStartupFailure(fields);
  assert.equal(failure.code, 'claude_rate_limit');
  assert.ok(failure.userMessage.length < 80);
  assert.doesNotMatch(failure.userMessage + failure.detail, /API error|request-late|reason/);
  assert.match(formatClaudeStartupFailureReport(fields), /request-late/);
  assert.match(formatClaudeStartupFailureReport(fields), /Settings attempt: A/);
});
