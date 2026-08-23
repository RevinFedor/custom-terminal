'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('codex-f captures source lineage and commits it only for the adopted child', () => {
  const runStart = source.indexOf('async function runCodexCommandFromPayloadInner');
  const runEnd = source.indexOf("ipcMain.on('codex:run-command'", runStart);
  const runBlock = source.slice(runStart, runEnd);
  assert.match(runBlock, /normalizedCommand === 'codex-f'/);
  assert.match(runBlock, /forkSourceHistorySnapshot = \{/);
  assert.match(runBlock, /entryUuids,/);
  assert.match(runBlock, /nextIterationIndex,/);
  assert.match(runBlock, /forkSourceHistorySnapshot,/);
  assert.match(runBlock, /rebaseCodexLaunchObservationAtWrite\(tabId, launchId, startedAt\);[\s\S]*writeAgentLaunchCommandToIdleShell/);

  const reconcileStart = source.indexOf('async function reconcileCodexWriterFromProcessInner');
  const reconcileEnd = source.indexOf('async function reconcileCodexWriterFromProcess(', reconcileStart);
  const reconcileBlock = source.slice(reconcileStart, reconcileEnd);
  assert.match(reconcileBlock, /intent\?\.sourceMode === 'fork'/);
  assert.match(reconcileBlock, /buildCodexLaunchForkEvent\(/);
  assert.match(reconcileBlock, /projectManager\.db\.saveSessionForkEvent\(forkEvent\)/);
});

test('read-only runtime projection does not replace destructive fresh proof', () => {
  const snapshotStart = source.indexOf('async function getCodexRuntimeSessionSnapshot');
  const snapshotEnd = source.indexOf('\nfunction getCodexSessionOwner', snapshotStart);
  const snapshotBlock = source.slice(snapshotStart, snapshotEnd);
  assert.match(snapshotBlock, /forceWriterReconcile = false/);
  assert.match(snapshotBlock, /projectCodexWriterInspectionFromProof\(/);
  assert.match(snapshotBlock, /resolveCodexWriterInspection\([\s\S]*reconcileCodexWriterFromProcess/);
  assert.match(source, /reason: 'archive-close',[\s\S]{0,180}forceWriterReconcile: true/);
  assert.match(source, /reason: 'codex-binding-point-write:' \+ reason,[\s\S]{0,180}forceWriterReconcile: true/);
});
