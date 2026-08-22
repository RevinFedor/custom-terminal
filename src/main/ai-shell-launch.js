'use strict';

const SHELL_INTERRUPT = '\x03';
const AGENT_SHELL_TOOLS = new Set(['claude', 'codex', 'gemini']);

function createClaudeBridgeProcessStartTracker() {
  const tabByPid = new Map();

  return {
    claim(pid, tabId) {
      const numericPid = Number(pid);
      const owner = String(tabId || '');
      if (!Number.isInteger(numericPid) || numericPid <= 0 || !owner) return false;
      if (tabByPid.get(numericPid) === owner) return false;
      tabByPid.set(numericPid, owner);
      return true;
    },
    clearPid(pid) {
      return tabByPid.delete(Number(pid));
    },
    clearTab(tabId) {
      let cleared = 0;
      for (const [pid, owner] of tabByPid) {
        if (owner !== tabId) continue;
        tabByPid.delete(pid);
        cleared += 1;
      }
      return cleared;
    },
  };
}

// Shared by the generated zsh/bash integration. It emits only an allow-listed
// tool name; the command text and its arguments never cross the OSC boundary.
// The regex recognises a direct command, `command claude`, an absolute binary
// path, and a command after a shell separator such as `cd repo && claude`.
const AGENT_SHELL_TOOL_CLASSIFIER = String.raw`
__ct_agent_tool() {
  local __ct_cmd="$1"
  local __ct_claude_re='(^|[;&|][[:space:]]*)[[:space:]]*(command[[:space:]]+)?([^[:space:];&|]+/)?claude([[:space:]]|$)'
  local __ct_codex_re='(^|[;&|][[:space:]]*)[[:space:]]*(command[[:space:]]+)?([^[:space:];&|]+/)?codex([[:space:]]|$)'
  local __ct_gemini_re='(^|[;&|][[:space:]]*)[[:space:]]*(command[[:space:]]+)?([^[:space:];&|]+/)?gemini([[:space:]]|$)'
  if [[ "$__ct_cmd" =~ $__ct_claude_re ]]; then
    printf "claude"
  elif [[ "$__ct_cmd" =~ $__ct_codex_re ]]; then
    printf "codex"
  elif [[ "$__ct_cmd" =~ $__ct_gemini_re ]]; then
    printf "gemini"
  fi
}
`.trim();

function buildAgentShellLaunchInput(command) {
  const commandText = String(command || '').replace(/[\r\n]+$/, '');
  if (!commandText.trim()) {
    throw new TypeError('Agent launch command is required');
  }
  return SHELL_INTERRUPT + commandText + '\r';
}

function decideAgentShellLaunchAdmission({
  processLookupStatus,
  commandRunning = false,
  lifecycleClaimed = false,
  stopping = false,
} = {}) {
  if (stopping) return { allowed: false, reason: 'agent_stopping' };
  if (commandRunning) return { allowed: false, reason: 'foreground_command_running' };
  if (lifecycleClaimed) return { allowed: false, reason: 'agent_lifecycle_claimed' };
  if (processLookupStatus === 'found') return { allowed: false, reason: 'ai_process_found' };
  if (processLookupStatus !== 'absent') return { allowed: false, reason: 'process_lookup_unknown' };
  return { allowed: true, reason: 'proven_idle_shell' };
}

function classifyTerminalForegroundSnapshot({ shellProcess = null, descendants = [] } = {}) {
  const shellPgid = Number(shellProcess?.pgid);
  const foregroundPgid = Number(shellProcess?.tpgid);
  if (!Number.isInteger(shellPgid) || shellPgid <= 1
    || !Number.isInteger(foregroundPgid) || foregroundPgid <= 1) {
    return { status: 'unknown', reason: 'foreground-pgid-unavailable', matches: [] };
  }
  if (shellPgid === foregroundPgid) {
    return { status: 'absent', reason: 'shell-is-foreground', matches: [] };
  }
  const matches = (Array.isArray(descendants) ? descendants : [])
    .filter((entry) => Number(entry?.pgid) === foregroundPgid);
  if (matches.length > 0) {
    return {
      status: 'found',
      reason: 'foreground-process-group-active',
      foregroundPgid,
      matches,
    };
  }
  // The shell says another process group owns the PTY, but the same complete
  // snapshot cannot find that group under this shell. It may have exited while
  // `ps` was being captured; that is unknown, not proof of an idle shell.
  return {
    status: 'unknown',
    reason: 'foreground-process-group-missing',
    foregroundPgid,
    matches: [],
  };
}

function isAgentShellLaunchInterruptPrelude({
  exitCode,
  expectsInterruptPrelude = false,
  sawOscCommandStart = false,
  sameTerminal = false,
} = {}) {
  return Number(exitCode) === 130
    && expectsInterruptPrelude === true
    && sawOscCommandStart !== true
    && sameTerminal === true;
}

function classifyAgentShellCommand(command) {
  const match = String(command || '').match(
    /(?:^|[;&|]\s*)\s*(?:command\s+)?(?:[^\s;&|]+\/)?(claude|codex|gemini)(?=\s|$)/i,
  );
  return match ? match[1].toLowerCase() : null;
}

function parseOsc133AgentTool(param) {
  const fields = String(param || '').split(';');
  for (const field of fields) {
    const match = field.match(/^tool=([a-z]+)$/i);
    if (!match) continue;
    const tool = match[1].toLowerCase();
    return AGENT_SHELL_TOOLS.has(tool) ? tool : null;
  }
  return null;
}

function shouldClaimManualClaudeShellLaunch({
  oscTool,
  hasMatchingStartupIntent = false,
} = {}) {
  if (oscTool !== 'claude') {
    return { claim: false, reason: 'not_claude_shell_command' };
  }
  if (hasMatchingStartupIntent) {
    return { claim: false, reason: 'launch_already_claimed' };
  }
  return { claim: true, reason: 'manual_shell_command' };
}

function shouldClearClaudeShellLaunchOnCommandFinished({
  hasClaudeState = false,
  hasPendingPrompt = false,
  startupIntentReason = null,
  sawOscCommandStart = false,
  sameTerminal = false,
  gracefulShutdownInProgress = false,
} = {}) {
  // before-quit has already persisted this live Claude tab as interrupted.
  // Clearing its ownership on the OSC D emitted by Ctrl+C would let will-quit
  // erase that fresh marker without being able to re-create it.
  if (gracefulShutdownInProgress) {
    return { clear: false, reason: 'graceful-shutdown-preserve-session' };
  }
  if (!hasClaudeState && !hasPendingPrompt) {
    return { clear: true, reason: 'unclaimed-shell-finish' };
  }
  if (
    startupIntentReason === 'claude-shell-osc'
    && sawOscCommandStart === true
    && sameTerminal === true
  ) {
    return { clear: true, reason: 'manual-shell-command-finished' };
  }
  return { clear: false, reason: 'claude-launch-still-owned' };
}

module.exports = {
  AGENT_SHELL_TOOL_CLASSIFIER,
  SHELL_INTERRUPT,
  buildAgentShellLaunchInput,
  classifyTerminalForegroundSnapshot,
  classifyAgentShellCommand,
  createClaudeBridgeProcessStartTracker,
  decideAgentShellLaunchAdmission,
  isAgentShellLaunchInterruptPrelude,
  parseOsc133AgentTool,
  shouldClaimManualClaudeShellLaunch,
  shouldClearClaudeShellLaunchOnCommandFinished,
};
