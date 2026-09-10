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
    );
  return {
    showRightCluster,
    // Model/effort and Codex Fast can be future-launch intent while stopped.
    // Claude Think still requires a live TUI and uses this separate guard.
    modelEffortInteractive: showRightCluster,
    liveOnlyControlsDisabled: isSDKTab !== true && isCommandRunning !== true,
  };
}
