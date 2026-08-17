'use strict';

const CLAUDE_SESSION_ID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLAUDE_RESUME_SHELL_COMMAND_RE = new RegExp(
  '^\\s*(?:command\\s+)?claude\\b[^\\r\\n]*?(?:^|[^\\w-])--resume(?:=|\\s+)(' + CLAUDE_SESSION_ID_RE + ')\\s*$',
  'i',
);

function completedShellCommandFromInput(pendingLine, data) {
  if (typeof data !== 'string' || !/[\r\n]$/.test(data)) return null;
  const withoutTerminator = data.replace(/[\r\n]+$/, '');
  if (/[\r\n]/.test(withoutTerminator)) return null;
  return String(pendingLine || '') + withoutTerminator;
}

function classifyClaudeResumeShellInput({
  pendingLine = '',
  data = '',
  commandRunning = false,
  liveRuntimeOwners = 0,
} = {}) {
  if (commandRunning === true) return { matched: false, reason: 'foreground-command-running' };
  if (Number(liveRuntimeOwners) !== 0) return { matched: false, reason: 'live-runtime-owner' };
  const command = completedShellCommandFromInput(pendingLine, data);
  if (command === null) return { matched: false, reason: 'command-incomplete' };
  const match = command.match(CLAUDE_RESUME_SHELL_COMMAND_RE);
  return match
    ? { matched: true, reason: 'exact-claude-resume-command', command, sessionId: match[1] }
    : { matched: false, reason: 'not-exact-claude-resume-command', command };
}

module.exports = {
  classifyClaudeResumeShellInput,
  completedShellCommandFromInput,
};
