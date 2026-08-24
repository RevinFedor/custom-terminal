'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-context-session-db-'));
const electronModulePath = require.resolve('electron');
const previousElectronModule = require.cache[electronModulePath];
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath: () => tempRoot,
    },
  },
};
const DatabaseManager = require('./database');
if (previousElectronModule) require.cache[electronModulePath] = previousElectronModule;
else delete require.cache[electronModulePath];

test('Codex context update and compact clear are exact to the current session binding', (t) => {
  let manager;
  try {
    manager = new DatabaseManager();
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      t.skip('better-sqlite3 uses the Electron ABI; run this test with ELECTRON_RUN_AS_NODE=1');
      return;
    }
    throw error;
  }
  t.after(() => {
    manager.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const project = manager.createEmptyProject('Context owner test');
  const tabId = 'context-tab';
  manager.saveTabs(project.id, [{
    tabId,
    name: 'Context',
    cwd: tempRoot,
    commandType: 'codex',
    codexSessionId: 'session-new',
  }], true);

  assert.equal(manager.updateCodexTabContextPctForSession(tabId, 'session-new', 83), true);
  assert.equal(manager.getTabContextPct(tabId), 83);
  assert.equal(manager.clearCodexTabContextPctForSession(tabId, 'session-old'), false);
  assert.equal(manager.getTabContextPct(tabId), 83, 'foreign compact cannot clear the current writer');
  assert.equal(manager.updateCodexTabContextPctForSession(tabId, 'session-old', 12), false);
  assert.equal(manager.getTabContextPct(tabId), 83, 'foreign token_count cannot overwrite the current writer');
  assert.equal(manager.clearCodexTabContextPctForSession(tabId, 'session-new'), true);
  assert.equal(manager.getTabContextPct(tabId), null);
  assert.equal(manager.updateCodexTabContextPctForSession(tabId, 'session-new', 10.157), true);
  assert.equal(manager.getTabContextPct(tabId), 10.157);
});
