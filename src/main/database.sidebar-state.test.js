const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-sidebar-db-'));
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

test('sidebar viewport state persists independently for each project', (t) => {
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

  const first = manager.createEmptyProject('Sidebar first');
  const second = manager.createEmptyProject('Sidebar second');
  manager.updateProjectSidebarState(first.id, true, '/tmp/first.md');
  manager.updateProjectSidebarExpandedDirs(first.id, {
    '/tmp/project/src': true,
    '/tmp/project/docs': false,
  });
  manager.updateProjectSidebarScrollTop(first.id, 412.5);

  manager.updateProjectSidebarState(second.id, false, null);
  manager.updateProjectSidebarExpandedDirs(second.id, { '/tmp/project/tests': true });
  manager.updateProjectSidebarScrollTop(second.id, 37);
  manager.close();

  manager = new DatabaseManager();
  t.after(() => {
    manager.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const restoredFirst = manager.getProjectById(first.id);
  const restoredSecond = manager.getProjectById(second.id);
  assert.equal(restoredFirst.sidebarOpen, true);
  assert.equal(restoredFirst.openFilePath, '/tmp/first.md');
  assert.deepEqual(restoredFirst.sidebarExpandedDirs, {
    '/tmp/project/src': true,
    '/tmp/project/docs': false,
  });
  assert.equal(restoredFirst.sidebarScrollTop, 412.5);

  assert.equal(restoredSecond.sidebarOpen, false);
  assert.equal(restoredSecond.openFilePath, null);
  assert.deepEqual(restoredSecond.sidebarExpandedDirs, { '/tmp/project/tests': true });
  assert.equal(restoredSecond.sidebarScrollTop, 37);
});
