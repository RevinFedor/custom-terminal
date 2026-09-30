'use strict';

const { normalizeClaudeLocalCommandText } = require('./claude-startup-slash-proof');

// This is a reduction of already-proven outcomes, not another transcript
// observer or lifecycle owner. Persistence belongs to main's existing app_state.
function reduceClaudeAccessFailure(previous, event) {
  if (!event?.sessionId || !event?.eventId || event.verified !== true) return null;
  const prior = previous?.version === 1 && previous.sessionId === event.sessionId ? previous : null;
  if (prior?.seen?.includes(event.eventId)) return null;
  const message = normalizeClaudeLocalCommandText(event.message);
  const forbidden = event.success !== true && event.status === 403 && !!message;
  const signature = forbidden ? '403:' + message : null;
  const count = forbidden ? (prior?.signature === signature ? prior.count + 1 : 1) : 0;
  return {
    version: 1,
    sessionId: event.sessionId,
    signature,
    count: Math.min(count, 2),
    blocked: count >= 2,
    message: forbidden ? message : null,
    lastEventId: event.eventId,
    // Keep dedupe witnesses across a successful result too: a late repeat of
    // the old rejection is not a new failure after that success.
    seen: [...(prior?.seen || []), event.eventId].slice(-64),
  };
}

function isClaudeAccessFailureBlocked(state, sessionId) {
  return !!sessionId && state?.version === 1 && state.sessionId === sessionId
    && state.blocked === true && state.count === 2;
}

function claudeSettingAccessOutcome(proof) {
  const evidence = proof?.evidence;
  if (!proof?.sessionId || !proof.stdoutUuid || !proof.wrapperUuid
    || evidence?.checkpoint?.wrapperUuid !== proof.wrapperUuid
    || evidence?.binding?.sessionId !== proof.sessionId
    || evidence?.checkpoint?.lineageVerified !== true
    || evidence?.write?.enterWritten !== true
    || (proof.success !== true && proof.terminal !== true)) return null;
  const message = normalizeClaudeLocalCommandText(proof.outputText);
  const status = message.match(/^API error:\s*(\d{3})\b/i);
  return { verified: true, sessionId: proof.sessionId,
    eventId: 'setting:' + proof.stdoutUuid, success: proof.success === true,
    status: status ? Number(status[1]) : null, message };
}

module.exports = { reduceClaudeAccessFailure, isClaudeAccessFailureBlocked, claudeSettingAccessOutcome };
