'use strict';

// A failed startup setting is REPORTED, not enforced. Two layers used to block
// a later Send, and they disagreed about which failures counted:
//
//   1. `projectClaudePtyPresence` withheld `inputReady`, so
//      `classifySubmitCapability` returned 'blocked' and the Send did not fail
//      fast — it waited out its 30s readiness budget and then reported
//      `agent_send_readiness_timeout`.
//   2. the renderer Send guard threw `agent_send_startup_failed` outright.
//
// A failed gate is terminal and sticky until the process restarts, so one
// refused `/model` disabled the whole tab. Measured on the real projection:
//     presence = {"status":"active","isBusy":false,"inputReady":false}
//     submitCapability = blocked
//
// Incident 2026-10-31, tab 2efc9b9b7a35 (production.log):
//   10:45:33.990  gate failed  code=claude_rate_limit
//                 "API error: 429 ... · model not changed"
//   10:45:43.920  manual retry -> the same 429
//   13:06:34 / 13:06:42 / 13:06:59  three sends refused, submitted=false
//   13:07:02.660  gate cleared by a restart -> sends work again
//   13:07:11.852  the same `/model` finally applied (jsonl-stdout, found)
// Dismissing the error never unblocked it: dismissal is presentation only.
//
// So the setting simply is not applied. The control bar shows the model
// actually in effect and the settings card names the failure. Main still marks
// a never-delivered local failure apart from a real provider verdict
// (`startupNotDelivered`) for presentation and diagnostics, and the separate
// repeated-403 stop policy is untouched. A PENDING transaction still owns the
// composer, because `/model` and `/effort` must land before the first prompt.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { projectClaudePtyPresence } = require('./claude-pty-presence');
const {
  isClaudeStartupSettingUndelivered,
  STARTUP_NOT_DELIVERED_MARKERS,
} = require('../shared/claude-startup-failure.cjs');

// The incident tab: process alive, composer painted, no turn running, and a
// startup gate that failed locally before Enter.
const INCIDENT_TAB = Object.freeze({
  hasTerm: true,
  hasBridge: true,
  promptReady: true,
  cliActive: true,
  processAlive: true,
  turnBusy: false,
  localCommandActive: false,
  stopping: false,
  startupIntentFresh: false,
  startupGatePending: false,
  startupGateFailed: true,
});

const INCIDENT_GATE = Object.freeze({
  status: 'failed',
  reason: 'claude-startup-command-not-proven-at-enter',
  error: '/model claude-opus-5[1m] was not confirmed by Claude'
    + '; reason=external_editor_timeout',
  errorCode: 'claude_startup_setting_rejected',
  proofOutcome: 'unresolved',
  failedCommand: '/model claude-opus-5[1m]',
});

// Mirror of the renderer contract (agentSendProviderContract.ts::CLAUDE).
// Kept in step by the source assertion at the end of this file.
function claudeSubmitCapability(presence) {
  if (!presence || presence.status === 'unknown') return 'unknown';
  if (presence.status === 'busy') return 'queue';
  if (presence.status === 'active' && presence.inputReady === true) return 'direct';
  return 'blocked';
}

test('the incident gate is classified as undelivered, and a verdict is not', () => {
  assert.equal(isClaudeStartupSettingUndelivered(INCIDENT_GATE), true,
    'enter-withheld + unresolved delivery is a local, undelivered failure');

  // Every marker this project proved for the undelivered class.
  for (const marker of STARTUP_NOT_DELIVERED_MARKERS) {
    assert.equal(isClaudeStartupSettingUndelivered({
      status: 'failed', proofOutcome: 'unresolved', errorCode: marker,
    }), true, marker + ' (as errorCode)');
    assert.equal(isClaudeStartupSettingUndelivered({
      status: 'failed', proofOutcome: null, error: 'wrapped: ' + marker + ' at enter',
    }), true, marker + ' (inside the message)');
  }

  // A provider verdict: a real request was answered. Must keep blocking.
  for (const verdict of [
    { errorCode: 'claude_rate_limit', error: 'API error: 429 rate limit exceeded' },
    { errorCode: 'claude_auth_expired', error: 'OAuth refresh token is no longer valid.' },
    { errorCode: 'claude_access_denied', error: 'API error: 403 forbidden' },
    { errorCode: 'claude_startup_setting_rejected', error: 'Unknown model: claude-opus-9' },
  ]) {
    assert.equal(isClaudeStartupSettingUndelivered({
      status: 'failed', proofOutcome: 'found', ...verdict,
    }), false, verdict.errorCode);
  }

  // A found proof means Claude recorded the command's own result; whatever that
  // result says, the command was delivered.
  assert.equal(isClaudeStartupSettingUndelivered({
    ...INCIDENT_GATE, proofOutcome: 'found',
  }), false, 'a found proof is never an undelivered command');

  // Only a failed gate is classified at all.
  for (const status of ['pending', 'ready', 'cleared', undefined]) {
    assert.equal(isClaudeStartupSettingUndelivered({ ...INCIDENT_GATE, status }), false,
      'status=' + String(status));
  }
  assert.equal(isClaudeStartupSettingUndelivered(null), false);
  assert.equal(isClaudeStartupSettingUndelivered(undefined), false);
});

test('a failed setting leaves the live composer usable for a Send', () => {
  // Both the undelivered local failure and the real 429 verdict: neither takes
  // the composer away, because the failure is terminal and sticky and the tab
  // would stay unusable until a restart.
  for (const [label, gate] of [
    ['undelivered (external_editor_timeout)', INCIDENT_GATE],
    ['provider verdict (429)', { status: 'failed', proofOutcome: 'found',
      errorCode: 'claude_rate_limit', error: 'API error: 429 rate limit exceeded' }],
  ]) {
    const presence = projectClaudePtyPresence({
      ...INCIDENT_TAB,
      startupGateNotDelivered: isClaudeStartupSettingUndelivered(gate),
    });
    assert.equal(presence.status, 'active', label + ': the process is alive and the prompt is proven');
    assert.equal(presence.inputReady, true, label + ': the setting is not applied, the composer still works');
    assert.equal(presence.isBusy, false, label);
    // Otherwise the Send does not fail fast — it waits out its readiness budget
    // and reports agent_send_readiness_timeout instead.
    assert.equal(claudeSubmitCapability(presence), 'direct', label);
  }
});

test('the undelivered exemption does not weaken any other startup rule', () => {
  // A pending gate still owns the composer: the startup transaction is mid-flight.
  const pending = projectClaudePtyPresence({
    ...INCIDENT_TAB, startupGateFailed: false,
    startupGatePending: true, startupGateNotDelivered: true,
  });
  assert.equal(pending.status, 'starting');
  assert.equal(pending.inputReady, false, 'pending is not unblocked by this flag');

  // An accepted turn keeps its queued input, exactly as before.
  const busy = projectClaudePtyPresence({
    ...INCIDENT_TAB, turnBusy: true, startupGateNotDelivered: false,
  });
  assert.equal(busy.status, 'busy');
  assert.equal(busy.inputReady, true);

  // No composer proof, no readiness — the flag cannot invent one.
  const noPrompt = projectClaudePtyPresence({
    ...INCIDENT_TAB, promptReady: false, cliActive: false,
    startupGateNotDelivered: true,
  });
  assert.equal(noPrompt.status, 'starting');
  assert.equal(noPrompt.inputReady, false);

  // A stopping tab is never input-ready.
  const stopping = projectClaudePtyPresence({
    ...INCIDENT_TAB, stopping: true, startupGateNotDelivered: true,
  });
  assert.equal(stopping.status, 'stopping');
  assert.equal(stopping.inputReady, false);

  // Unknown process lookup stays unknown; it must not be read as readiness.
  const unknown = projectClaudePtyPresence({
    hasTerm: true, processLookupUnknown: true, startupGateFailed: true,
    startupGateNotDelivered: true,
  });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.inputReady, false);

  // The classification is for presentation/diagnostics; a caller that passes no
  // flag at all still gets a usable composer for a failed (not pending) gate.
  const unmarked = projectClaudePtyPresence(INCIDENT_TAB);
  assert.equal(unmarked.inputReady, true,
    'the composer does not depend on the delivery classification');
});

test('both layers read one owner, and the presence projection publishes it', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main/main.js'), 'utf8');
  // Main must classify through the shared owner, not a second local copy of
  // the marker list, and must hand the result to the composer projection.
  assert.ok(main.includes('isClaudeStartupSettingUndelivered(startupGate)'),
    'Main classifies the gate through the shared owner');
  assert.ok(main.includes('startupGateNotDelivered: startupNotDelivered'),
    'the composer projection receives the classification');
  assert.ok(main.includes('startupNotDelivered,'),
    'presence still publishes the marker for the renderer Send guard');
  // main.js legitimately PRODUCES these errors (the editor timeout, the
  // withheld Enter). What it must not own is a second copy of the decision:
  // one classifier, or the two layers drift apart again.
  assert.equal(main.includes("proofOutcome !== 'found'\n      && ["), false,
    'main.js must not re-implement the undelivered marker list');
  const classifierUses = main.split('isClaudeStartupSettingUndelivered').length - 1;
  assert.ok(classifierUses >= 2,
    'main.js imports and calls the shared classifier (require + call)');

  // The renderer must no longer refuse a Send over a failed startup setting;
  // otherwise the two layers disagree again and the tab stays dead.
  const guard = fs.readFileSync(path.join(root, 'renderer/utils/agentSendPreparation.ts'), 'utf8');
  assert.equal(guard.includes("code: 'agent_send_startup_failed'"), false,
    'a failed startup setting must not refuse a later Send');
  // The provider verdicts that DO stop a send keep their own guards.
  assert.ok(guard.includes("describeAgentManualAction(presence)"),
    'Codex manual-action verdicts still block');
  assert.ok(guard.includes("presence?.status === 'stopping'"),
    'a stopping tab still blocks');

  const contract = fs.readFileSync(path.join(root, 'renderer/utils/agentSendProviderContract.ts'), 'utf8');
  assert.ok(contract.includes("if (presence.status === 'active' && presence.inputReady === true) return 'direct';"),
    'the mirrored Claude submit contract in this test still matches the product');
});
