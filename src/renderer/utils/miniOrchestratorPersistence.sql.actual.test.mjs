// Real app_state schema, DatabaseManager methods and Main handlers; only IPC
// transport/sender and notifications are mocked. No app or production profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createMiniPanelPersistence } from './miniOrchestratorGeometry.mjs';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dbSource = fs.readFileSync(path.join(root, 'src/main/database.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const { writeAppStateWithDiagnostics } = require(path.join(root, 'src/main/app-state-write-diagnostics.js'));
const between = (source, start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a); return source.slice(a, b); };
const methods = vm.runInNewContext('({' + [between(dbSource, '  getAppState(key) {', '\n  _runAppStateRevisionTransaction('),
  between(dbSource, '  setAppState(key, value, metadata = undefined) {', '\n  compareAndSetAppState(')].join(',') + '})', { WORKSPACE_SESSION_APP_STATE_KEY: 'workspace-session' });
const schema = between(dbSource, '    // App state table', '    // Durable, bounded recovery history').match(/this\.db\.exec\(`([\s\S]*?)`\)/)?.[1];
assert.ok(schema);
function owner(sql) {
  const db = { db: sql, ...methods }, handlers = new Map();
  const context = { projectManager: { db }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, writeAppStateWithDiagnostics,
    console, noteCardSignalSettingsChanged() {}, schedulePromptQueueAssetGc() { assert.fail('unexpected queue GC'); } };
  for (const channel of ['app:getState', 'app:setState']) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`), end = mainSource.indexOf('\n});', start);
    assert.ok(start >= 0 && end > start); vm.runInNewContext(mainSource.slice(start, end + 4), context);
  }
  return { db, invoke: async (channel, value) => handlers.get(channel)({ sender: { id: 1 } }, value) };
}
test('actual app state SQLite roundtrip preserves independent state', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-panel-sql-'));
  const file = path.join(folder, 'owned.db'); let sql;
  try {
    sql = new Database(file); sql.exec(schema); let app = owner(sql);
    app.db.setAppState('other-fixture', { preserved: true });
    const first = createMiniPanelPersistence(app.invoke);
    const frame = { left: 31, top: 42, width: 500, height: 350 };
    await first.write('tab', { frame, detached: true });
    sql.close(); sql = new Database(file); app = owner(sql);
    const reopened = createMiniPanelPersistence(app.invoke);
    assert.deepEqual(await reopened.read('tab'), { frame, detached: true });
    assert.equal(app.db.getAppState('other-fixture').preserved, true);
  } finally { try { sql?.close(); } catch {} fs.rmSync(folder, { recursive: true, force: true }); }
});
