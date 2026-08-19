'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const runtime = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'utils', 'historyAgentRuntimes.ts'),
  'utf8',
);
const preparation = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'utils', 'agentRecordContextPreparation.ts'),
  'utf8',
);

test('record-context Stop captures committed Codex footer before the first signal', () => {
  const stopStart = main.indexOf('async function stopAiProcessInTab(tabId, options = {})');
  const stopEnd = main.indexOf("ipcMain.handle('terminal:stop-ai-process'", stopStart);
  const stop = main.slice(stopStart, stopEnd);
  const captureAt = stop.indexOf('history-context-pre-stop-settings');
  const ctrlCAt = stop.indexOf("term.write('\\x03')");
  assert.ok(captureAt >= 0 && ctrlCAt > captureAt);
  assert.match(stop, /parseCodexVerifiedComposerFooter\(currentScreen\.currentFrameText/);
  assert.match(stop, /destructiveProofAvailable:\s*currentScreen\?\.destructiveProofAvailable === true/);
  assert.match(stop, /liveSynchronizedOutputOpen:\s*currentScreen\?\.liveSynchronizedOutputOpen === true/);
  assert.match(stop, /committedFrameReplay:\s*currentScreen\?\.committedFrameReplay === true/);
  assert.match(stop, /getHeadlessCodexDraftState\(tabId, 'history-context-pre-stop-draft'\)/);
  assert.match(stop, /draftHasDraft:\s*draftState\?\.hasDraft/);
  assert.match(stop, /history-context-pre-signal-settings/);
  assert.match(stop, /classifyCodexStopSettingsCapture\(\{/);
  assert.match(stop, /revalidatedScreen\?\.mirrorGeneration/);
  assert.match(stop, /revalidatedScreen\?\.committedFrameGeneration/);
  assert.match(stop, /revalidatedScreen\?\.writeSeq/);
  assert.match(stop, /validateCodexStopCapturedSettingsAuthority/);
  assert.match(stop, /restartSettingsProof:\s*capturedCodexRestartSettings\.proof/);
});

test('renderer requests capture only for Codex history recording and consumes main proof', () => {
  assert.match(runtime, /captureCodexRestartSettings\?: boolean/);
  assert.match(runtime, /captureCodexRestartSettings \? \{ captureCodexRestartSettings: true \}/);
  assert.match(preparation, /captureCodexRestartSettings: runtime\.toolType === 'codex'/);
  assert.match(preparation, /isCodexStopCapturedSettingsProof\(stopped\?\.restartSettingsProof\)/);
  assert.match(preparation, /effectiveHistoryRestartSettings = stopped\.restartSettingsProof/);
});
