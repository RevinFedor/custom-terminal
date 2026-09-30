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

  manager.saveTimelineNote('entry-2', 'session-1', 'tab-1', 'occupied', 'before');
  assert.equal(manager.moveTimelineNote({ previousEntryUuid: 'entry-1', entryUuid: 'entry-2',
    sessionId: 'session-1', tabId: 'tab-1', expectedPreviousContent: 'note', content: 'edited', position: 'before' }).error,
  'timeline_note_target_occupied');
  assert.equal(manager.moveTimelineNote({ previousEntryUuid: 'entry-1', entryUuid: 'entry-3',
    sessionId: 'session-1', tabId: 'tab-1', expectedPreviousContent: 'stale', content: 'edited' }).error,
  'timeline_note_changed');
  assert.equal(manager.getTimelineNotes('session-1').length, 2);
  assert.equal(manager.moveTimelineNote({ previousEntryUuid: 'entry-1', entryUuid: 'entry-3',
    sessionId: 'session-1', tabId: 'tab-1', expectedPreviousContent: 'note', content: 'edited', position: 'before' }).success, true);
  assert.equal(manager.getTimelineNotes('session-1').find(row => row.entry_uuid === 'entry-3').content, 'edited');
  manager.copyTimelineMetadataForMappedFork('child-session', [{ sourceUuid: 'entry-3', childUuid: 'child-entry' }], 'child-tab');
  assert.deepEqual(manager.getTimelineNotes('child-session'), [{ entry_uuid: 'child-entry', content: 'edited', position: 'before' }]);
});
