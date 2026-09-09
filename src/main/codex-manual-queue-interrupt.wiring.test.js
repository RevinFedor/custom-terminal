'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, startMarker);
  return source.slice(start, end);
}

test('actual manual Escape captures the exact queued prompt before the PTY write', () => {
  const input = between('async function handleTerminalInput(', "\nipcMain.on('terminal:input'");
  const captureAt = input.indexOf('captureManualCodexQueueInterrupt({');
  const writeAt = input.lastIndexOf('term.write(data)');
  assert.ok(captureAt >= 0 && writeAt > captureAt);
  assert.match(input, /turnBusy: codexTurnState\?\.busy === true/);
  assert.match(input, /pendingPrompt: codexTurnState\?\.terminalHistoryPreviewPendingPrompt/);
  assert.match(input, /inputRevision: getTerminalInputRevision\(tabId\)/);
});

test('turn_aborted publishes the queue bridge and task_started consumes its transient token', () => {
  const process = between('function processCodexTurnLine(', '\nfunction inferCodexBusyFromText');
  const claimAt = process.indexOf('classifyManualCodexQueueInterruptOutcome(');
  const abortAt = process.indexOf("event === 'turn_aborted'");
  const taskStartClearAt = process.indexOf("event === 'task_started'", abortAt);
  const emitAt = process.indexOf('manualQueueContinuationExpected:', claimAt);
  assert.ok(abortAt >= 0 && claimAt > abortAt && taskStartClearAt > claimAt && emitAt > claimAt);
  assert.match(process, /lastAbnormalOutcomeHasQueuedContinuation/);
  assert.match(process, /lastAbnormalOutcomeContinuationTs = state\.lastAbnormalOutcomeTs/);
});

test('turn-state snapshots retain only the timestamp-bound abnormal continuation proof', () => {
  const snapshot = between('function codexTurnStateSnapshot(', '\nfunction emitCodexTurnStateResolved');
  assert.match(snapshot, /lastAbnormalOutcomeHasQueuedContinuation/);
  assert.match(snapshot, /lastAbnormalOutcomeContinuationTs/);
  const busy = between('function emitCodexBusy(', '\nfunction emitCodexContextPct');
  assert.match(busy, /manualQueueContinuationExpected:\s*outcomeDetails\?\.manualQueueContinuationExpected === true/);
});
