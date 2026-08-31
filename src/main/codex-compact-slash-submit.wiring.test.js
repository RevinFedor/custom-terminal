'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = mainSource.indexOf(startMarker);
  const end = mainSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, 'missing start marker: ' + startMarker);
  assert.ok(end > start, 'missing end marker: ' + endMarker);
  return mainSource.slice(start, end);
}

test('programmatic compact passes its exact pending operation into the PTY submit proof', () => {
  const request = sourceBetween(
    'async function executeCodexLiveSlashCommandRequest',
    "ipcMain.handle('codex:send-live-slash-command'",
  );
  assert.match(request, /compactOperationId:\s*compactPendingOperation\?\.operationId \|\| null/);
  assert.match(request, /result\.compactStartConfirmed === true[\s\S]{0,120}codex-compact-causal-task-started/);
  assert.match(
    request,
    /result\?\.success !== true[\s\S]{0,100}result\?\.compactStartConfirmed !== true[\s\S]{0,180}cancelCodexManualCompactPending/,
  );
});

test('second compact Enter is behind exact post-frame ownership and is never a blind double Enter', () => {
  const submit = sourceBetween(
    'async function submitCodexCompactSlashCommandWithProof',
    'async function sendCodexSlashCommand',
  );
  assert.match(submit, /observeCodexCompactPostEnter\([\s\S]{0,420}trigger:\s*\(\) => writeOwnedEnter\(1\)/);
  assert.match(submit, /planCodexCompactPostEnterAction\([\s\S]{0,300}first\.kind === 'owned-draft'/);
  assert.match(submit, /if \(!plan\.writeSecondEnter\)[\s\S]{0,320}buildCodexCompactUnconfirmedResult/);
  assert.match(submit, /readCodexPickerWriteRefusal\([\s\S]{0,120}'slash-command-second-enter'/);
  assert.match(submit, /observeCodexCompactPostEnter\([\s\S]{0,420}allowOwnedDraft:\s*false[\s\S]{0,180}trigger:\s*\(\) => writeOwnedEnter\(2\)/);
  assert.doesNotMatch(submit, /term\.write\('\r'\)\s*;\s*term\.write\('\r'\)/);
});

test('compact task_started and manual takeover are observed on the same exact ownership boundary', () => {
  const observer = sourceBetween(
    'function observeCodexCompactPostEnter',
    'async function submitCodexCompactSlashCommandWithProof',
  );
  assert.match(observer, /subscribeCompactOperationChanges\(onOperation\)/);
  assert.match(observer, /operation\.causalStartConfirmed === true/);
  assert.match(observer, /validateCodexOwnedSlashDraftIdentity|readCodexCompactSubmitOwnership/);
  assert.match(observer, /pendingCurrent/);
  assert.match(observer, /getHeadlessVisibleBufferSnapshot/);
  assert.match(observer, /getHeadlessCodexDraftState/);
  assert.match(observer, /inspectCodexCompactPostEnterFrame/);
});
