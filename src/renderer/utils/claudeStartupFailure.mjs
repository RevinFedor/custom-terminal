const text = (value) => typeof value === 'string' ? value.trim() : '';

export const CLAUDE_AUTH_EXPIRED_CODE = 'claude_auth_expired';

export function unwrapClaudeLocalCommandFailure(value) {
  const raw = text(value);
  const wrapped = raw.match(/^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>$/i);
  return text(wrapped?.[2] ?? raw);
}

export function inferClaudeStartupFailureCode(value, explicitCode = null) {
  const supplied = text(explicitCode);
  if (supplied) return supplied;
  const message = unwrapClaudeLocalCommandFailure(value);
  if (
    /oauth refresh token is no longer valid/i.test(message)
    || /login expired/i.test(message)
    || /run \/login to re-authenticate/i.test(message)
  ) {
    return CLAUDE_AUTH_EXPIRED_CODE;
  }
  return 'claude_startup_setting_rejected';
}

export function describeClaudeStartupFailure({
  error,
  errorCode = null,
  failedCommand = null,
} = {}) {
  const message = unwrapClaudeLocalCommandFailure(error)
    || 'Claude startup setting was not applied';
  const code = inferClaudeStartupFailureCode(message, errorCode);
  const command = text(failedCommand);
  if (code === CLAUDE_AUTH_EXPIRED_CODE) {
    return {
      code,
      message,
      subtitle: 'Claude login expired',
      detail: 'Run /login in the terminal, then retry '
        + (command || 'the startup settings') + '.',
    };
  }
  return {
    code,
    message,
    subtitle: null,
    detail: message,
  };
}
