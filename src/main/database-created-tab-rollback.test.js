'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-created-tab-rollback-'));
const electronModulePath = require.resolve('electron');
const previousElectronModule = require.cache[electronModulePath];
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: { app: { isPackaged: false, getPath: () => tempRoot } },
};
const DatabaseManager = require('./database');
if (previousElectronModule) require.cache[electronModulePath] = previousElectronModule;
else delete require.cache[electronModulePath];
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('creation rollback deletes only an unmaterialized exact tab row', (t) => {
  let manager;
  try {
    manager = new DatabaseManager();
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return;
    }
    throw error;
  }
  t.after(() => manager.close());

  const project = manager.createEmptyProject('Rollback');
  manager.saveTabs(project.id, [
    { tabId: 'keep', name: 'keep', cwd: tempRoot },
    { tabId: 'rollback', name: 'rollback', cwd: tempRoot },
  ], true);
  assert.deepEqual(manager.rollbackUnmaterializedCreatedTab(project.id, 'rollback'), {
    success: true,
    deleted: true,
  });
  assert.deepEqual(manager.getProjectTabIds(project.id), ['keep']);

  manager.saveTabs(project.id, [
    { tabId: 'keep', name: 'keep', cwd: tempRoot },
    { tabId: 'materialized', name: 'materialized', cwd: tempRoot, codexSessionId: 'session' },
  ], true);
  assert.equal(
    manager.rollbackUnmaterializedCreatedTab(project.id, 'materialized').error,
    'created_tab_already_materialized',
  );
  assert.deepEqual(manager.getProjectTabIds(project.id), ['keep', 'materialized']);
});
