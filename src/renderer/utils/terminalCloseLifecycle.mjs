export async function stopAiBeforeTerminalKill({
  shouldStopAiProcess = false,
  stopAiProcess,
  killTerminal,
} = {}) {
  if (typeof killTerminal !== 'function') {
    throw new TypeError('killTerminal is required');
  }

  let stopResult = null;
  let stopError = null;
  if (shouldStopAiProcess) {
    if (typeof stopAiProcess !== 'function') {
      throw new TypeError('stopAiProcess is required when an AI process is live');
    }
    try {
      stopResult = await stopAiProcess();
    } catch (error) {
      stopError = error;
    }
  }

  if (
    shouldStopAiProcess
    && (stopError || !stopResult || stopResult.success !== true)
  ) {
    return { stopResult, stopError, terminalKilled: false };
  }

  killTerminal();
  return { stopResult, stopError, terminalKilled: true };
}
