'use strict';

// Register before Electron's loaded event, without importing application code.
// This receipt proves Node bootstrap, not DOM readiness or inspector safety.
if (process.isMainFrame) {
  const { ipcRenderer } = require('electron');
  const bootNonce = require('node:crypto').randomBytes(16).toString('hex');
  let loaded = false, challenge = null, replied = null;
  const answer = () => {
    if (!loaded || !challenge || replied === challenge.challenge) return;
    replied = challenge.challenge;
    ipcRenderer.send('perf:native-bootstrap-ack', { ...challenge, bootNonce });
  };
  ipcRenderer.on('perf:native-bootstrap-challenge', (_event, value) => {
    if (!value || typeof value.challenge !== 'string' || !/^[a-f0-9]{32}$/.test(value.challenge)
      || !['wcId', 'rendererPid', 'frameProcessId', 'frameRoutingId', 'documentGeneration']
        .every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return;
    if (challenge && value.documentGeneration <= challenge.documentGeneration
      && value.challenge !== challenge.challenge) return;
    // Copy only the bounded protocol fields; keep an early challenge until loaded.
    challenge = { challenge: value.challenge, wcId: value.wcId, rendererPid: value.rendererPid,
      frameProcessId: value.frameProcessId, frameRoutingId: value.frameRoutingId,
      documentGeneration: value.documentGeneration };
    answer();
  });
  process.once('loaded', () => {
    loaded = true;
    ipcRenderer.send('perf:native-bootstrap-available');
    answer();
  });
}
