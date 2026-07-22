const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-tab-history-db-'));
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

test('tab-history restore reads non-destructively and deletes only the committed row', (t) => {
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

  const firstProject = manager.createEmptyProject('History first');
  const secondProject = manager.createEmptyProject('History second');
  const olderId = Number(manager.archiveTab(firstProject.id, {
    name: 'older',
    cwd: '/tmp',
    commandType: 'codex',
    codexSessionId: 'session-older',
  }));
  const latestId = Number(manager.archiveTab(firstProject.id, {
    name: 'latest',
    cwd: '/tmp',
    commandType: 'codex',
    codexSessionId: 'session-latest',
  }));
  const otherProjectId = Number(manager.archiveTab(secondProject.id, {
    name: 'other',
    cwd: '/tmp',
  }));

  assert.equal(manager.getLatestTabHistory(firstProject.id).id, latestId);
  assert.equal(manager.getLatestTabHistory(firstProject.id).id, latestId, 'read must not consume the row');
  assert.equal(manager.getTabHistoryEntry(latestId, secondProject.id), undefined, 'lookup must stay project-scoped');
  assert.equal(manager.getLatestTabHistory(secondProject.id).id, otherProjectId);

  assert.equal(manager.deleteTabHistoryEntry(latestId), true);
  assert.equal(manager.getLatestTabHistory(firstProject.id).id, olderId);
  assert.equal(manager.deleteTabHistoryEntry(latestId), false);

  manager.saveTabs(firstProject.id, [{
    tabId: 'cwd-proof-tab',
    name: 'cwd proof',
    cwd: '/before',
  }]);
  assert.equal(manager.updateTabCwd('cwd-proof-tab', '/after'), true);
  const cwdTab = manager.getProjectById(firstProject.id).tabs.find(tab => tab.tabId === 'cwd-proof-tab');
  assert.equal(cwdTab.cwd, '/after', 'accepted CWD must be durable before renderer follow-up');
  assert.equal(manager.updateTabCwd('missing-tab', '/after'), false);
});
