const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-quick-actions-db-'));
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
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function openManagerOrSkip(t) {
  try {
    return new DatabaseManager();
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run this test with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }
}

test('legacy project quick actions migrate once without overwriting global commands', (t) => {
  const manager = openManagerOrSkip(t);
  if (!manager) return;
  t.after(() => manager.close());

  const projectA = manager.createEmptyProject('Legacy actions A');
  const projectB = manager.createEmptyProject('Legacy actions B');
  const insertLegacy = manager.db.prepare(`
    INSERT INTO quick_actions (project_id, name, command, position)
    VALUES (?, ?, ?, ?)
  `);
  insertLegacy.run(projectA.id, 'Build', 'npm run build', 1);
  insertLegacy.run(projectB.id, 'Test', 'npm test', 0);
  insertLegacy.run(projectB.id, 'Build', 'npm run build', 2);

  assert.deepEqual(manager.migrateQuickActionsToGlobal(), {
    migrated: true,
    count: 2,
  });
  assert.deepEqual(
    manager.getGlobalCommands().map(({ name, command, position }) => ({ name, command, position })),
    [
      { name: 'Test', command: 'npm test', position: 0 },
      { name: 'Build', command: 'npm run build', position: 1 },
    ],
  );

  insertLegacy.run(projectA.id, 'Must not replace settings', 'echo legacy', 0);
  assert.deepEqual(manager.migrateQuickActionsToGlobal(), {
    migrated: false,
    count: 0,
    message: 'Global commands already exist',
  });
  assert.deepEqual(
    manager.getGlobalCommands().map(({ name, command }) => ({ name, command })),
    [
      { name: 'Test', command: 'npm test' },
      { name: 'Build', command: 'npm run build' },
    ],
  );
});

test('empty legacy storage is a clean no-op', (t) => {
  const manager = openManagerOrSkip(t);
  if (!manager) return;
  t.after(() => manager.close());

  manager.db.prepare('DELETE FROM global_commands').run();
  manager.db.prepare('DELETE FROM quick_actions').run();
  assert.deepEqual(manager.migrateQuickActionsToGlobal(), {
    migrated: false,
    count: 0,
    message: 'No legacy quick actions',
  });
  assert.deepEqual(manager.getGlobalCommands(), []);
});
