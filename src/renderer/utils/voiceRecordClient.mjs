// Renderer-side entry for asking Voice Record to re-run transcription of a
// dictation chip's take. The actual HTTP call lives in main
// (`dictation-chip:retry`): the renderer CSP allows only 'self', and main is
// where the shared bearer token and the ~/.noted-terminal discovery live.
// VR answers quickly (accepted / not-found) and later reports the outcome
// through its normal /api/dictation-chip/resolve callback, which lands as
// the `history-panel:resolve-dictation-chip` event.

const { ipcRenderer } = window.require('electron');

export async function retryVoiceRecordDictation(chipId) {
  try {
    const result = await ipcRenderer.invoke('dictation-chip:retry', { chipId: String(chipId || '') });
    if (!result || result.ok !== true) {
      return { ok: false, error: (result && result.error) || 'retry failed' };
    }
    return result;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
