'use strict';

const SHELL_INTERRUPT = '\x03';

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

module.exports = {
  SHELL_INTERRUPT,
  buildAgentShellLaunchInput,
  decideAgentShellLaunchAdmission,
  isAgentShellLaunchInterruptPrelude,
};
