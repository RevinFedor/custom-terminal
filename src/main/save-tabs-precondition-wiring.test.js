'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('async and sync destructive snapshots validate exact DB tab ids before save', () => {
  for (const marker of [
    "ipcMain.handle('project:save-tabs'",
    "ipcMain.on('project:save-tabs-sync'",
  ]) {
    const start = source.indexOf(marker);
    const end = source.indexOf('\n});', start);
    assert.ok(start >= 0 && end > start, `handler missing: ${marker}`);
    const block = source.slice(start, end);
    const validateAt = block.indexOf('validateForceCleanupTabIds({');
    const saveAt = block.indexOf('projectManager.saveProjectTabs(');
    assert.match(block, /expectedTabIds/);
    assert.match(block, /projectManager\.db\.getProjectTabIds\(projectId\)/);
    assert.ok(validateAt >= 0 && saveAt > validateAt, 'precondition must run before saveTabs');
  }
});

test('creation rollback and close preflight are exact point operations', () => {
  assert.match(source, /ipcMain\.handle\('tab:rollback-unmaterialized-create'/);
  assert.match(source, /rollbackUnmaterializedCreatedTab\(projectId, tabId\)/);
  assert.match(source, /ipcMain\.handle\('project:validate-tab-snapshot'/);
});
