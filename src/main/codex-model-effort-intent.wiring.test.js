'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const controlBar = fs.readFileSync(
  path.join(__dirname, '../renderer/components/Workspace/ClaudeControlBar.tsx'),
  'utf8',
);
const app = fs.readFileSync(path.join(__dirname, '../renderer/App.tsx'), 'utf8');
const database = fs.readFileSync(path.join(__dirname, 'database.js'), 'utf8');

test('ControlBar stores one durable model/effort intent instead of awaiting starting writer timeout', () => {
  const start = controlBar.indexOf('const applyCodexModelAndEffort = async');
  const end = controlBar.indexOf('\n  const pickModel = async', start);
  const body = controlBar.slice(start, end);
  assert.match(body, /codex:set-model-effort-intent/);
  assert.doesNotMatch(body, /codex:select-model-effort/);
  assert.match(body, /result\?\.queued === true/);
  assert.match(body, /codexSettingsProofSessionId:\s*undefined/);
  assert.doesNotMatch(body, /effective-settings-unknown/,
    'a complete desired pair stays queueable before the first writer proof');
});

test('main reconciles the last revision only after exact writer and TUI readiness', () => {
  assert.match(main, /function persistCodexModelEffortIntent[\s\S]{0,1000}codexSettingsIntentRevision/);
  const start = main.indexOf('function scheduleCodexModelEffortIntentReconcile');
  const end = main.indexOf("ipcMain.handle('codex:set-model-effort-intent'", start);
  const body = main.slice(start, end);
  assert.match(body, /planCodexModelEffortIntentReconcile/);
  assert.match(body, /getCodexWriterProofSnapshot\(tabId\)/);
  assert.match(body, /executeCodexSelectModelEffortRequest\(/);
  assert.match(body, /for \(let pass = 0; pass < 4; pass \+= 1\)/);
  assert.match(main, /scheduleCodexModelEffortIntentReconcile\(tabId, 'writer-adopted'\)/);
  assert.match(main, /scheduleCodexModelEffortIntentReconcile\(payload\.tabId, 'tui-ready'\)/);
  assert.doesNotMatch(body, /waitForCodexSettingsWriterTransition/,
    'the durable intent waits outside the one-shot live picker timeout');
});

test('background apply updates renderer proof and provider_state stays durable', () => {
  assert.match(main, /codex:model-effort-intent-applied/);
  assert.match(app, /handleCodexModelEffortIntentApplied/);
  assert.match(app, /codex:set-model-effort-intent/);
  assert.match(app, /planCodexPickerStateApplication\(\{/);
  assert.match(controlBar, /codexSettingsIntentRevision/);
  assert.match(database, /codexSettingsIntentModel/);
  assert.match(database, /codexSettingsIntentAppliedOwnerId/);
});
