const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-utility-migration-db-'));
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

test('legacy Utils positions migrate after the main list without losing deterministic order', (t) => {
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

  const project = manager.createEmptyProject('Utility migration');
  assert.deepEqual(manager.saveTabs(project.id, [
    { tabId: 'main-a', name: 'main-a', cwd: '/tmp' },
    { tabId: 'main-b', name: 'main-b', cwd: '/tmp' },
    { tabId: 'utility-a', name: 'utility-a', cwd: '/tmp' },
    { tabId: 'utility-b', name: 'utility-b', cwd: '/tmp' },
  ]), { success: true });
  manager.db.prepare(`
    UPDATE tabs
    SET is_utility = CASE WHEN tab_id LIKE 'utility-%' THEN 1 ELSE 0 END,
        position = CASE WHEN tab_id IN ('main-a', 'utility-a') THEN 0 ELSE 1 END
    WHERE project_id = ?
  `).run(project.id);

  const restored = manager.getProjectById(project.id);
  assert.deepEqual(restored.tabs.map(tab => tab.tabId), [
    'main-a',
    'main-b',
    'utility-a',
    'utility-b',
  ]);

  assert.deepEqual(manager.saveTabs(project.id, restored.tabs.map(tab => ({
    ...tab,
    isUtility: false,
  }))), { success: true });
  const rows = manager.db.prepare(`
    SELECT tab_id, position, is_utility
    FROM tabs
    WHERE project_id = ?
    ORDER BY position ASC, id ASC
  `).all(project.id);
  assert.deepEqual(rows.map(row => [row.tab_id, row.position, row.is_utility]), [
    ['main-a', 0, 0],
    ['main-b', 1, 0],
    ['utility-a', 2, 0],
    ['utility-b', 3, 0],
  ]);
});
