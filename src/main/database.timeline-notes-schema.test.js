const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-timeline-notes-schema-'));
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

test('fresh database creates timeline_notes with its current position column', (t) => {
  let manager;
  try {
    manager = new DatabaseManager();
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run this test with ELECTRON_RUN_AS_NODE=1');
      return;
    }
    throw error;
  }

  t.after(() => manager.close());

  const columns = manager.db.prepare('PRAGMA table_info(timeline_notes)').all();
  assert.ok(columns.some((column) => column.name === 'position'));

  manager.saveTimelineNote('entry-1', 'session-1', 'tab-1', 'note', 'after');
  assert.deepEqual(manager.getTimelineNotes('session-1'), [{
    entry_uuid: 'entry-1',
    content: 'note',
    position: 'after',
  }]);
});
