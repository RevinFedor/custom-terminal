'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('isolated userData keeps canonical production authority and cannot own automatic retention', () => {
  const captureIndex = mainSource.indexOf("const canonicalNotedUserDataDir = app.getPath('userData')");
  const overrideIndex = mainSource.indexOf("app.setPath('userData', userDataDir)");
  assert.ok(captureIndex >= 0 && overrideIndex > captureIndex, 'canonical userData must be captured before an override');
  assert.match(mainSource, /currentUserDataDir !== canonicalUserDataDir[\s\S]*addCandidate\('production', 'noted-terminal\.db'\)/);
  assert.match(mainSource, /getStorageMutationAuthority[\s\S]*canonical-production-db-unavailable/);
  assert.match(mainSource, /getStorageMutationAuthority[\s\S]*e2e-storage-mutation-disabled/);
  assert.match(mainSource, /function scheduleStorageRetentionSweep[\s\S]*canOwnAutomaticStorageRetention/);
  assert.match(mainSource, /auditPath: path\.join\(ownsIsolatedStorageProfile\(\) \? app\.getPath\('userData'\) : canonicalNotedUserDataDir, 'storage-deletion-audit\.jsonl'\)/);
  assert.match(mainSource, /isolatedTest: ownsIsolatedStorageProfile\(\)/);
  assert.match(mainSource, /mutationRoot: ownsIsolatedStorageProfile\(\) \? isolatedStorageProfile\.root : null/);
});

test('dashboard deletion passes one operation id into main-owned audit and progress', () => {
  assert.match(mainSource, /ipcMain\.handle\('storage:prepare-delete'[\s\S]*prepareDeleteItems/);
  assert.match(mainSource, /ipcMain\.handle\('storage:delete-items'[\s\S]*source: 'dashboard',[\s\S]*operationId,[\s\S]*confirmationToken: request\?\.confirmationToken,[\s\S]*onProgress:/);
});
