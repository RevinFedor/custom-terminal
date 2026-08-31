'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('Codex settings picker joins only the exact launch-to-writer handoff', () => {
  const start = main.indexOf('async function executeCodexSelectModelEffortRequest');
  const end = main.indexOf("ipcMain.handle('codex:get-persistent-model-effort-proof'", start);
  const body = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /classifyCodexSettingsWriterTransition\(\{/);
  const provenAt = body.indexOf('if (provenWriterSessionId) return provenWriterSessionId');
  const launchOwnerAt = body.indexOf('const provisionalLaunchOwner = getCodexProvisionalSettingsSnapshot');
  const resumeSourceAt = body.indexOf('resolveCodexPickerCurrentWriterSessionId({');
  assert.ok(provenAt >= 0 && launchOwnerAt > provenAt && resumeSourceAt > launchOwnerAt,
    'proven writer wins, then launch settings owner, then provisional Resume read identity');
  assert.match(body, /currentWriterProof\?\.launchId/);
  assert.match(body, /currentWriterProof\.terminalToken === term/);
  assert.match(body, /currentWriterProof\.lifecycleGeneration === expectedLifecycleGeneration/);
  assert.match(body, /waitForCodexSettingsWriterTransition\(\{/);
  assert.match(body, /eventBus: ipcMain/);
  assert.match(body, /timeoutMs: CODEX_PASTE_AUDIT_TIMEOUT_MS/);
  assert.match(body, /waiting-writer-adoption/);
});

test('writer adoption publishes the internal event only after durable proof is installed', () => {
  const start = main.indexOf('function setCodexKnownSession(');
  const end = main.indexOf('function getCodexWriterProofSnapshot(', start);
  const body = main.slice(start, end);
  const proofAt = body.indexOf('codexWriterProofs.set(tabId, proofRecord)');
  const eventAt = body.indexOf('ipcMain.emit(CODEX_SETTINGS_WRITER_ADOPTED_EVENT');
  assert.ok(proofAt >= 0 && eventAt > proofAt);
  assert.match(body.slice(eventAt), /launchId: proofRecord\.launchId/);
  assert.match(body.slice(eventAt), /lifecycleGeneration: proofRecord\.lifecycleGeneration/);
});
