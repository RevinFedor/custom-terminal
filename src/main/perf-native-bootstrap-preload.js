'use strict';

// Register before Electron's loaded event, without importing application code.
// This receipt proves Node bootstrap, not DOM readiness or inspector safety.
if (process.isMainFrame) {
  const { ipcRenderer } = require('electron');
  const bootNonce = require('node:crypto').randomBytes(16).toString('hex');
  let loaded = false, challenge = null, replied = null;
  const clockReplies = new Map();
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
  // Scalar clock synchronization only. A timestamp is not DOM/input readiness
  // and does not replace the original bootstrap challenge or owner nonce.
  ipcRenderer.on('perf:input-clock-challenge', (_event, value) => {
    if (!loaded || !challenge || value?.bootNonce !== bootNonce
      || typeof value.clockId !== 'string' || !/^[a-f0-9]{32}$/.test(value.clockId)
      || !['wcId', 'rendererPid', 'frameProcessId', 'frameRoutingId', 'documentGeneration']
        .every(key => value[key] === challenge[key])) return;
    const previous = clockReplies.get(value.clockId);
    if (previous) { ipcRenderer.send('perf:input-clock-ack', previous); return; }
    let rendererEpochMs = null, rendererTimeOriginMs = null, rendererNowMs = null;
    try {
      const p = window.performance;
      const origin = p.timeOrigin, tick = p.now(), value = origin + tick;
      if (Number.isFinite(origin) && origin >= 0 && Number.isFinite(tick) && tick >= 0 && Number.isFinite(value)) {
        rendererEpochMs = value; rendererTimeOriginMs = origin; rendererNowMs = tick;
      }
    } catch { /* Missing clock is explicit; never substitute Date.now(). */ }
    const response = { ...challenge, bootNonce, clockId: value.clockId,
      rendererEpochMs, rendererTimeOriginMs, rendererNowMs };
    clockReplies.set(value.clockId, response);
    if (clockReplies.size > 4) clockReplies.delete(clockReplies.keys().next().value);
    ipcRenderer.send('perf:input-clock-ack', response);
  });
  process.once('loaded', () => {
    loaded = true;
    ipcRenderer.send('perf:native-bootstrap-available');
    answer();
  });
}
