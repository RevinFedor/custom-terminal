'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const controlBar = fs.readFileSync(
  path.join(__dirname, '../renderer/components/Workspace/ClaudeControlBar.tsx'),
  'utf8',
);
const app = fs.readFileSync(path.join(__dirname, '../renderer/App.tsx'), 'utf8');
const database = fs.readFileSync(path.join(__dirname, 'database.js'), 'utf8');

test('desktop and mobile persist Fast intent without requiring a live Codex process', async () => {
  const controlStart = controlBar.indexOf('const sendCodexFast = async');
  const controlEnd = controlBar.indexOf('\n  const pickProvider', controlStart);
  const control = controlBar.slice(controlStart, controlEnd);
  assert.match(control, /codex:toggle-fast-intent/);
  assert.doesNotMatch(control, /!isCommandRunning|codex:send-live-slash-command|getCodexDraftStateForPicker/);
  const adoptStart = controlBar.indexOf('const adoptProviderState');
  const adoptEnd = controlBar.indexOf('\n  const ', adoptStart + 24);
  assert.ok(adoptStart >= 0 && adoptEnd > adoptStart);
  assert.match(
    controlBar.slice(adoptStart, adoptEnd),
    /mergeTabProviderSnapshot\(previous, tabId, next\)/,
  );
  assert.match(controlBar, /const codexFastDisabled = false/);
  assert.doesNotMatch(controlBar, /const fastBlocked = isBusyBlocked\('fast'\)/);

  const bridgeStart = app.indexOf("if (action === 'sendCodexFast')");
  const bridgeEnd = app.indexOf("if (action === 'setSDKParams')", bridgeStart);
  const bridge = app.slice(bridgeStart, bridgeEnd);
  assert.match(bridge, /codex:toggle-fast-intent/);
  assert.doesNotMatch(bridge, /requires a live Codex process|codex:get-draft-state/);
  const paramsStart = app.indexOf("if (action === 'getSDKParams')");
  const paramsEnd = app.indexOf("if (action === 'sendCodexFast')", paramsStart);
  assert.ok(paramsStart >= 0 && paramsEnd > paramsStart);
  assert.match(app.slice(paramsStart, paramsEnd), /agent:get-current-params/);
  assert.doesNotMatch(app.slice(paramsStart, paramsEnd), /provider:get-status|claude:get-confirmed-settings/);
  const { createAgentCurrentParamsReader } = require('./agent-current-params');
  const params = createAgentCurrentParamsReader({
    capture: () => ({ provider: 'codex', sessionId: 'S' }), isCurrent: () => true,
    readRuntime: () => ({ processStatus: 'absent' }), readClaudeSettings: () => null,
    readClaudeThinking: () => null, readCodexSettings: () => ({}),
    readProviderState: () => ({ codexFastIntent: true }), readContext: () => null,
    readStoredChoices: () => ({}),
  });
  const dto = await params.read('T');
  assert.equal(dto.fast, true); assert.equal(dto.fastPending, true); assert.equal(dto.fastKnown, false);
});

test('main stores one revisioned intent and reconciles it from exact service-tier proof', () => {
  assert.match(main, /function persistNextCodexFastIntent[\s\S]{0,900}codexFastIntentRevision/);
  assert.match(main, /updateTabProviderState\(tabId, next\)[\s\S]{0,120}broadcastProviderState/);
  const reconcileStart = main.indexOf('function scheduleCodexFastIntentReconcile');
  const reconcileEnd = main.indexOf("ipcMain.handle('codex:toggle-fast-intent'", reconcileStart);
  const reconcile = main.slice(reconcileStart, reconcileEnd);
  assert.match(reconcile, /planCodexFastIntentReconcile/);
  assert.match(reconcile, /executeCodexLiveSlashCommandRequest\(\{[\s\S]{0,180}command: '\/fast'/);
  assert.match(reconcile, /for \(let pass = 0; pass < 4; pass \+= 1\)/);
  assert.match(main, /service-tier-proof-reused/);
  assert.match(main, /service-tier-proof/);
  assert.match(main, /external-fast-feedback[\s\S]{0,120}persistCodexFastIntentValue|persistCodexFastIntentValue\([\s\S]{0,180}external-fast-feedback/);
});

test('provider-state persistence retains an explicit false Fast intent', () => {
  assert.match(database, /typeof tab\.providerState\.codexFastIntent === 'boolean'/);
  assert.match(database, /codexFastIntentRevision/);
});
