import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_AUTH_EXPIRED_CODE,
  describeClaudeStartupFailure,
  inferClaudeStartupFailureCode,
  unwrapClaudeLocalCommandFailure,
} from './claudeStartupFailure.mjs';

const productionFailure = '<local-command-stdout>Unable to validate model: OAuth refresh token is no longer valid; run /login to re-authenticate</local-command-stdout>';

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
  assert.equal(failure.subtitle, 'Claude login expired');
  assert.equal(
    failure.detail,
    'Run /login in the terminal, then retry /model claude-opus-5[1m].',
  );
  assert.doesNotMatch(failure.message, /<local-command-stdout>/);
});

test('ordinary startup rejection keeps its exact error and stable generic code', () => {
  const failure = describeClaudeStartupFailure({
    error: "Model 'missing' not found",
    failedCommand: '/model missing',
  });
  assert.equal(failure.code, 'claude_startup_setting_rejected');
  assert.equal(failure.subtitle, null);
  assert.equal(failure.detail, "Model 'missing' not found");
});
