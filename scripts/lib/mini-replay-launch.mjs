// Fail closed on a missing independent Codex copy. A basic empty DEV must be
// explicit; it is never a substitute for the selected historical conversation.
export function miniReplayLaunchGate(manifest, { basic = false } = {}) {
  if (basic) return { allowLaunch: true, allowBasic: true, replayPrepared: false, mode: 'basic' };
  const profile = manifest?.privateProfile;
  if (manifest?.status === 'prepared' && manifest.clonePrepared === true && manifest.offlineCopy?.verified === true
    && typeof profile?.root === 'string' && profile.root.startsWith('/')
    && typeof profile.sessionFile === 'string' && profile.sessionFile.startsWith(profile.root + '/')
    && manifest.targetSessionId && manifest.targetSessionId !== manifest.sourceSessionId
    && profile.sessionId === manifest.targetSessionId && profile.tabId === manifest.targetTabId) {
    return { allowLaunch: true, allowBasic: false, replayPrepared: true, mode: 'replay',
      targetTabId: manifest.targetTabId, targetSessionId: manifest.targetSessionId };
  }
  return { allowLaunch: false, allowBasic: false, replayPrepared: false, code: manifest?.reason?.code || 'mini_replay_clone_unavailable',
    // Ordinary fork permission and exact-boundary availability are different:
    // a permitted latest-compact fork cannot rewind to an omitted earlier user.
    reason: manifest?.reason?.error || 'No independent exact-boundary Codex copy is prepared for this private DEV.',
    targetTabId: null, targetSessionId: null };
}
