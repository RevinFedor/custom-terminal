// A failed startup setting must not refuse a later Send. The gate failure is
// terminal and sticky until the process restarts, so refusing sends turned one
// refused `/model` into a tab that could not receive anything.
//
// Incident (production.log, 2026-10-31, tab-20e4793e / "hh-tool"):
//   10:45:33.990  gate failed  code=claude_rate_limit
//                 "API error: 429 ... · model not changed"
//   10:45:43.920  manual retry -> the same 429
//   13:06:34.793  send refused agent_send_startup_failed, submitted=false
//   13:06:42 / 13:06:59  two more sends refused the same way
//   13:07:02.660  a restart cleared the gate -> sends work again
//   13:07:11.852  the same `/model` finally applied (jsonl-stdout, found)
// Dismissing the error did not unblock it: dismissal is presentation only.
//
// The earlier repair exempted only a proven-undelivered local failure
// (external_editor_timeout / withheld Enter, incident tab 718f438d). That was
// too narrow: the 429 above is a real provider verdict and still left the tab
// dead. So the setting is simply not applied; the control bar shows the model
// actually in effect and the settings card names the failure. `startupNotDelivered`
// remains for presentation and diagnostics, and the separate repeated-403 stop
// policy is untouched.
//
// Still blocking, and asserted below: a stopping tab, and a Codex manual-action
// verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { createAgentLaunchAdmission } from './agentLaunchAdmission.mjs';
import { createLaunchFixture } from './agentLaunchFixture.mjs';

const require = createRequire(import.meta.url);
// Preparation now reaches the launch-admission helper (it used to throw before
// it). That helper is imported here, OUTSIDE the vm context, and mints its
// renderer nonce from `globalThis.crypto` — which Electron's --test runner does
// not expose. Give both scopes the real WebCrypto implementation.
const { webcrypto } = require('node:crypto');
globalThis.crypto ??= webcrypto;
const target = require('../../shared/agent-send-target-precondition.cjs');
const source = fs.readFileSync(new URL('./agentSendPreparation.ts', import.meta.url), 'utf8');
const start = source.indexOf('export async function prepareAgentRuntimeForSend(');
const end = source.indexOf('\nexport ', start + 7);
assert.ok(start >= 0 && end > start, 'prepareAgentRuntimeForSend must be extractable');
const compiled = transformSync(source.slice(start, end).replace(/^export /, ''), { loader: 'ts' }).code;

// The exact gate shape Main publishes for the incident, from
// main.js::startupNotDelivered.
const INCIDENT_ERROR = '/model claude-opus-5[1m] was not confirmed'
  + ' (unresolved/enter-withheld)';

function runPreparation({ presence, onSendPrompt }) {
  const { ipcRenderer } = createLaunchFixture();
  const context = vm.createContext({
    ipcRenderer, AbortController, createAgentLaunchAdmission, performance,
    crypto: webcrypto,
    ...target, Date: { now: () => 1000 }, console: { log() {}, warn() {} },
    manualActionContract: require('../../shared/agent-manual-action.cjs'),
    agentSendReadTiming: require('../../shared/agent-send-read-timing.cjs'),
    isCoordinatedAgentSendCancellationRequested: () => false,
    createAgentReadyWait() {
      return { promise: Promise.resolve(), cancel() {} };
    },
  });
  vm.runInContext(compiled, context);
  return context.prepareAgentRuntimeForSend({
    tabId: 'T',
    providerContract: {
      classifySubmitCapability: () => 'direct',
      startupGateOwnsComposer: () => false,
      waitForStartupGate: async () => {},
    },
    runtime: {
      toolType: 'claude', label: 'Claude',
      getPresence: async () => presence,
      resume() { assert.fail('an alive tab must not be relaunched by a Send'); },
      sendPrompt: onSendPrompt,
    },
  });
}

const alivePresence = extra => ({
  status: 'active', inputReady: true, hasTerm: true, hasBridge: true,
  startupFailed: true,
  startupError: INCIDENT_ERROR,
  startupFailedCommand: '/model claude-opus-5[1m]',
  ...extra,
});

test('a failed startup setting no longer blocks a later Send', async () => {
  // Every shape the product actually produces: the undelivered local failure,
  // real provider verdicts, and an unmarked/legacy failure.
  for (const [label, extra] of [
    ['undelivered local failure', { startupNotDelivered: true }],
    ['rate limit', { startupNotDelivered: false,
      startupError: "API error: 429 This request would exceed your account's rate limit."
        + ' Please try again later · model not changed' }],
    ['expired login', { startupNotDelivered: false,
      startupError: 'OAuth refresh token is no longer valid. Run /login to re-authenticate.' }],
    ['access denied', { startupNotDelivered: false, startupError: 'API error: 403 forbidden' }],
    ['unknown model', { startupNotDelivered: false, startupError: 'Unknown model: claude-opus-9' }],
    ['unmarked/legacy failure', {}],
  ]) {
    const resolved = await runPreparation({
      presence: alivePresence(extra),
      onSendPrompt: async () => assert.fail('preparation itself must not paste'),
    }).catch(error => {
      assert.fail(label + ': a failed setting must not refuse the Send: '
        + (error?.code || error?.message));
    });
    // Preparation reaches its normal conclusion for a live, input-ready tab.
    assert.equal(resolved.status, 'active', label);
    assert.equal(resolved.submitCapability, 'direct', label);
    assert.equal(resolved.presence.startupFailed, true,
      label + ': the failure itself is still reported, just not enforced');
  }
});

test('a stopping tab still refuses the Send', async () => {
  await assert.rejects(runPreparation({
    presence: alivePresence({ status: 'stopping', startupNotDelivered: true }),
    onSendPrompt: async () => assert.fail('a stopping tab must not be pasted into'),
  }), error => {
    assert.equal(error.code, 'agent_send_cancelled');
    assert.equal(error.submitted, false);
    assert.equal(error.pasteWritten, false);
    return true;
  });
});

test('the Send guard no longer carries a startup-failure refusal at all', () => {
  // Main still publishes both the failure and its delivery classification; the
  // Send path simply does not refuse over them any more. If this assertion is
  // ever reverted, the two layers disagree again and one refused `/model`
  // disables the tab until a restart.
  assert.equal(source.includes("code: 'agent_send_startup_failed'"), false,
    'no Send refusal for a failed startup setting');
  const main = fs.readFileSync(new URL('../../main/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes('isClaudeStartupSettingUndelivered(startupGate)'),
    'Main still classifies undelivered vs. provider verdict for presentation');
  assert.ok(main.includes('startupNotDelivered,'),
    'presence still publishes that classification');
});
