// Finite SOURCE control: actual Main app-state handlers and DatabaseManager
// methods on an owned temporary SQLite file. Does not boot Electron/production.
// Prefer the checkout's native driver; node:sqlite is a disclosed harness fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createPaneStripInterfacePreferences, initialPaneStripInterfacePreferences,
  PANE_STRIP_INTERFACE_PREFERENCE_KEYS as keys } from './paneStripInterfacePreferences.mjs';

const require = createRequire(import.meta.url);
let Database, driver;
try { Database = require('better-sqlite3'); driver = 'better-sqlite3'; }
catch { Database = require('node:sqlite').DatabaseSync; driver = 'node:sqlite'; }
const sourceRoot = process.env.NOTED_PREFS_OWNER_ROOT || fileURLToPath(new URL('../../../', import.meta.url));
const dbSource = fs.readFileSync(path.join(sourceRoot, 'src/main/database.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(sourceRoot, 'src/main/main.js'), 'utf8');
const { writeAppStateWithDiagnostics } = require(path.join(sourceRoot, 'src/main/app-state-write-diagnostics.js'));
const between = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'actual source boundaries exist: ' + start);
  return source.slice(a, b);
};
const methods = vm.runInNewContext('({' + [
  between(dbSource, '  getAppState(key) {', '\n  _runAppStateRevisionTransaction('),
  between(dbSource, '  setAppState(key, value, metadata = undefined) {', '\n  compareAndSetAppState('),
].join(',') + '})', { WORKSPACE_SESSION_APP_STATE_KEY: 'workspace-session' });
const schema = between(dbSource, '    // App state table', '    // Durable, bounded recovery history')
  .match(/this\.db\.exec\(`([\s\S]*?)`\)/)?.[1];
assert.ok(schema, 'use the actual app_state schema');

function owner(sql) {
  const database = { db: sql, ...methods }, handlers = new Map(), notifications = [];
  const context = { projectManager: { db: database },
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    writeAppStateWithDiagnostics, console,
    noteCardSignalSettingsChanged: key => notifications.push(key),
    schedulePromptQueueAssetGc: () => assert.fail('prefs cannot call queue GC') };
  for (const channel of ['app:getState', 'app:setState']) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    const end = mainSource.indexOf('\n});', start);
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(mainSource.slice(start, end + '\n});'.length), context);
  }
  return { database, notifications,
    invoke: async (channel, value) => {
      assert.ok(handlers.has(channel), 'existing app-state handlers only');
      return handlers.get(channel)({ sender: { id: 101 } }, value);
    } };
}
function ui(invoke) {
  let state = initialPaneStripInterfacePreferences();
  return { io: createPaneStripInterfacePreferences({ getState: () => state,
    setState: patch => { state = { ...state, ...patch(state) }; }, invoke }), get state() { return state; } };
}

test('actual app:get/set owner persists all three independent modes in private SQLite and survives close/reopen', async t => {
  t.diagnostic('SQL driver: ' + driver + '; actual source handlers/methods; controlled Electron sender and card-signal notifier');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-interface-prefs-'));
  const file = path.join(folder, 'own-test.db'); let sql;
  try {
    sql = new Database(file); sql.exec(schema);
    let app = owner(sql);
    app.database.setAppState('defaultCodexModel', 'coauthor-fixture');
    const first = ui(app.invoke); await first.io.hydrate();
    assert.equal(sql.prepare('SELECT count(*) AS count FROM app_state').get().count, 1,
      'hydrating defaults does not write either key');
    for (const key of keys) assert.equal(await first.io.write(key, true), true);
    assert.equal(first.state.paneStripPreferenceStatus[keys[0]], 'ready');
    assert.deepEqual(app.notifications, keys);
    sql.close(); sql = new Database(file); app = owner(sql);
    const reopened = ui(app.invoke); await reopened.io.hydrate();
    for (const key of keys) assert.equal(reopened.state[key], true);
    assert.equal(app.database.getAppState('defaultCodexModel'), 'coauthor-fixture');
    for (const key of keys) assert.equal(await reopened.io.write(key, false), true);
    sql.close(); sql = new Database(file); app = owner(sql);
    const third = ui(app.invoke); await third.io.hydrate();
    for (const key of keys) assert.equal(third.state[key], false);
    assert.equal(sql.prepare('SELECT count(*) AS count FROM app_state').get().count, keys.length+1);
  } finally { try { sql?.close(); } catch {} fs.rmSync(folder, { recursive: true, force: true }); }
});

test('actual SQLite write error rejects Main ACK; local edit is explicitly unconfirmed', async () => {
  const sql = new Database(':memory:');
  try {
    sql.exec(schema); const app = owner(sql), client = ui(app.invoke); await client.io.hydrate();
    sql.exec("CREATE TRIGGER deny_test_preference BEFORE INSERT ON app_state BEGIN SELECT RAISE(FAIL, 'own fixture write failure'); END");
    assert.equal(await client.io.write(keys[0], true), false);
    assert.equal(client.state[keys[0]], true);
    assert.equal(client.state.paneStripPreferenceStatus[keys[0]], 'save-unknown');
    assert.equal(app.database.getAppState(keys[0]), null);
    assert.equal(app.notifications.length, 0);
  } finally { sql.close(); }
});
