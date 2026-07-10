const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_DIR = path.join(os.homedir(), '.noted-terminal', 'shared');
const DB_PATH = path.join(DB_DIR, 'file-layout.db');

function createSharedFileLayoutStore({ Database, dbPath = DB_PATH }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_layouts (
      root_path TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  const read = db.prepare('SELECT revision, payload, updated_at FROM file_layouts WHERE root_path = ?');
  const insert = db.prepare(`
    INSERT INTO file_layouts (root_path, revision, payload, updated_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(root_path) DO NOTHING
  `);
  const compareAndSwap = db.prepare(`
    UPDATE file_layouts
    SET revision = revision + 1, payload = ?, updated_at = ?
    WHERE root_path = ? AND revision = ?
  `);

  const get = (rootPath) => {
    const row = read.get(String(rootPath || ''));
    if (!row) return { revision: 0, layout: { orderByParent: {}, visualParentByPath: {} }, updatedAt: 0 };
    let layout = { orderByParent: {}, visualParentByPath: {} };
    try { layout = JSON.parse(row.payload); } catch {}
    return { revision: row.revision, layout, updatedAt: row.updated_at };
  };

  const put = (rootPath, layout, expectedRevision = null) => {
    const key = String(rootPath || '');
    if (!key) throw new Error('rootPath is required');
    const payload = JSON.stringify(layout || { orderByParent: {}, visualParentByPath: {} });
    const now = Date.now();
    const current = get(key);
    if (current.revision === 0) {
      insert.run(key, payload, now);
      const created = get(key);
      if (created.revision > 0) return { ok: true, ...created };
    }
    const expected = expectedRevision == null ? current.revision : Number(expectedRevision);
    const result = compareAndSwap.run(payload, now, key, expected);
    if (result.changes !== 1) return { ok: false, conflict: true, ...get(key) };
    return { ok: true, ...get(key) };
  };

  return { path: dbPath, get, put, close: () => db.close() };
}

function registerSharedFileLayoutIpc({ ipcMain, Database, channelPrefix = 'shared-file-layout' }) {
  const store = createSharedFileLayoutStore({ Database });
  ipcMain.handle(`${channelPrefix}:get`, (_event, rootPath) => store.get(rootPath));
  ipcMain.handle(`${channelPrefix}:put`, (_event, rootPath, layout, expectedRevision) => store.put(rootPath, layout, expectedRevision));
  return store;
}

module.exports = { DB_PATH, createSharedFileLayoutStore, registerSharedFileLayoutIpc };
