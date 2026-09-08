'use strict';

// Diagnostic capture is an observer, never an admission/retry mechanism.
// Capture starts synchronously at the incident, before disk/renderer awaits.
function createTerminalIncidentReporter({ capture, notify, limit = 256 }) {
  const incidents = new Map();
  return function report(key, payload) {
    if (incidents.has(key)) return incidents.get(key);
    let captured;
    try { captured = capture(payload); } catch (error) { captured = Promise.reject(error); }
    const pending = Promise.resolve(captured).then(
      result => ({ ...payload, ...result, success: true }),
      error => ({ ...payload, success: false, error: String(error?.message || error) }),
    ).then(result => {
      try { notify(result); } catch (error) { console.warn('[TerminalIncident] notify failed', error?.message); }
      return result;
    });
    incidents.set(key, pending);
    while (incidents.size > limit) incidents.delete(incidents.keys().next().value);
    return pending;
  };
}

module.exports = { createTerminalIncidentReporter };
