'use strict';

// Presentation only. Observe the real call, including a possible write followed
// by throw. Never mark ENTER_ARMED as a write, or let telemetry alter transport.
function writeWithSendEnterTiming(write, publish, now = Date.now) {
  const enterAttemptAt = now();
  try { return write(); }
  finally {
    try { publish(enterAttemptAt); }
    catch (error) { console.warn('[AgentSendTiming] publication failed:', error?.message || error); }
  }
}

module.exports = { writeWithSendEnterTiming };
