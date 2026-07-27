export function planAgentSettingsAvailability({
  supportsKnobs = false,
  isSDKTab = false,
  hasAnySession = false,
  isCommandRunning = false,
  commandType = null,
} = {}) {
  const typedPtyAgent = commandType === 'claude' || commandType === 'codex';
  const showRightCluster = supportsKnobs === true
    && (
      isSDKTab === true
      || typedPtyAgent
      || hasAnySession === true
      || isCommandRunning === true
    );
  return {
    showRightCluster,
    // Model/effort are a future-launch choice while a PTY agent is stopped.
    // Controls which require a live TUI (Think, /fast) keep their own guard.
    modelEffortInteractive: showRightCluster,
    liveOnlyControlsDisabled: isSDKTab !== true && isCommandRunning !== true,
  };
}
