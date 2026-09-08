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

test('ControlBar stores one durable model/effort intent in every lifecycle state', () => {
  const start = controlBar.indexOf('const applyCodexModelAndEffort = async');
  const end = controlBar.indexOf('\n  const pickModel = async', start);
  const body = controlBar.slice(start, end);
  assert.match(body, /codex:set-model-effort-intent/);
  assert.doesNotMatch(body, /codex:select-model-effort/);
  assert.match(body, /result\?\.queued === true/);
  assert.doesNotMatch(body, /updateCodexState\(/,
    'saving an intent must not mutate or erase the current applied proof');
  assert.doesNotMatch(body, /if \(!isCommandRunning\)/,
    'stopped and starting selections must use the same durable intent as live selections');
  assert.doesNotMatch(body, /Ultra применяется только к уже запущенной/,
    'conversation-only Ultra queues until a launch is ready instead of disabling the choice');
  assert.doesNotMatch(body, /effective-settings-unknown/,
    'a complete desired pair stays queueable before the first writer proof');
  assert.match(body, /setLocalBusy\(true/,
    'the click has immediate feedback before the main operation event arrives');
  assert.match(controlBar, /pointerEvents:\s*isPasteBusy && !isCodex/);
  for (const name of ['modelBlocked', 'effortBlocked']) {
    const expression = controlBar.match(new RegExp('const ' + name + ' = ([\\s\\S]*?);'))?.[1];
    assert.ok(expression, name + ' expression must exist');
    const blocked = new Function('isCodex', 'canQueueClaudeSettings', 'isBusyBlocked', 'settingsWriteBusy', 'return (' + expression + ');');
    for (const canQueueClaudeSettings of [true, false]) {
      assert.equal(blocked(true, canQueueClaudeSettings, () => true, false), false,
        'a busy reply or paste alone does not forbid choosing settings');
      assert.equal(blocked(true, canQueueClaudeSettings, () => false, true), true,
        'an outstanding setting selection disables another UI choice until proof or failure');
    }
  }
  assert.doesNotMatch(controlBar, /stoppedCodexUltra|const stoppedUltra = isCodex/,
    'Ultra is a queueable conversation intent while stopped/starting');
});

test('main reconciles the last revision against an exact launch or writer owner', () => {
  assert.match(main, /function persistCodexModelEffortIntent[\s\S]{0,1000}codexSettingsIntentRevision/);
  const start = main.indexOf('function scheduleCodexModelEffortIntentReconcile');
  const end = main.indexOf("ipcMain.handle('codex:set-model-effort-intent'", start);
  const body = main.slice(start, end);
  assert.match(body, /planCodexModelEffortIntentReconcile/);
  assert.match(body, /getCodexWriterProofSnapshot\(tabId\)/);
  assert.match(body, /getCodexProvisionalSettingsSnapshot\(tabId\)/);
  assert.match(body, /writerProof\?\.sessionId[\s\S]{0,160}codexProvisionalSettingsOwnerId/);
  assert.match(body, /executeCodexSelectModelEffortRequest\(/);
  assert.match(body, /for \(let pass = 0; pass < 4; pass \+= 1\)/);
  assert.match(main, /scheduleCodexModelEffortIntentReconcile\(tabId, 'writer-adopted'\)/);
  assert.match(main, /scheduleCodexModelEffortIntentReconcile\(payload\.tabId, 'tui-ready'\)/);
  assert.match(main, /scheduleCodexModelEffortIntentReconcile\([\s\S]{0,100}'verified-launch-settings'/);
  assert.doesNotMatch(body, /waitForCodexSettingsWriterTransition/,
    'the durable intent waits outside the one-shot live picker timeout');
});

test('intent save returns immediately and launch-owner application transfers to the first writer', () => {
  const handlerStart = main.indexOf("ipcMain.handle('codex:set-model-effort-intent'");
  const handlerEnd = main.indexOf('\nfunction getCodexFastIntentRecord', handlerStart);
  const handler = main.slice(handlerStart, handlerEnd);
  assert.match(handler, /const reconciliation = scheduleCodexModelEffortIntentReconcile/);
  assert.doesNotMatch(handler, /await scheduleCodexModelEffortIntentReconcile/);
  assert.match(handler, /intentPending:\s*true/);
  assert.match(main, /planCodexModelEffortIntentOwnerHandoff\(\{/);
  assert.match(main, /writer-adoption-owner-handoff/);
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
