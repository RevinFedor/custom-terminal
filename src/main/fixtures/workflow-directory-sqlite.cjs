'use strict';

// Actual project DatabaseManager/API on PRIVATE real SQLite. The only DB port
// substitute is node:sqlite instead of the incompatible better-sqlite3 ABI.
// Electron app is an unused JS stub, never an Electron process.
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
class DirectorySqlite {
  constructor() { this.raw = new DatabaseSync(':memory:'); this.depth = 0; this.name = ':memory:'; this.open = true; }
  get inTransaction() { return this.depth > 0; }
  exec(sql) { return this.raw.exec(sql); }
  prepare(sql) { this.onSql?.(sql); const q = this.raw.prepare(sql);
    return { get: (...a) => q.get(...a), all: (...a) => q.all(...a), run: (...a) => q.run(...a), iterate: (...a) => q.iterate(...a) }; }
  pragma(text, options = {}) { const rows = this.raw.prepare('PRAGMA ' + text).all(); return options.simple ? Object.values(rows[0] || {})[0] : rows; }
  function(name, options, fn) { return this.raw.function(name, typeof options === 'function' ? options : fn); }
  transaction(fn) {
    const mode = type => (...args) => {
      const nested = this.depth > 0, key = 'directory_' + this.depth;
      this.exec(nested ? 'SAVEPOINT ' + key : 'BEGIN ' + type); this.depth++;
      try { const result = fn(...args); if (result?.then) throw Error('fixture async SQL transaction');
        this.exec(nested ? 'RELEASE ' + key : 'COMMIT'); return result; }
      catch (error) { this.exec(nested ? 'ROLLBACK TO ' + key : 'ROLLBACK'); if (nested) this.exec('RELEASE ' + key); throw error; }
      finally { this.depth--; }
    };
    const run = mode('DEFERRED'); run.immediate = mode('IMMEDIATE'); run.deferred = run; run.exclusive = mode('EXCLUSIVE'); return run;
  }
  close() { this.raw.close(); this.open = false; }
}
function databaseClass() {
  const file = path.resolve(__dirname, '../database.js'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const original = loaded.require.bind(loaded);
  loaded.require = name => name === 'electron' ? { app: {} } : name === 'better-sqlite3'
    ? class ForbiddenBinding { constructor() { throw Error('native binding forbidden in directory host fixture'); } } : original(name);
  loaded._compile(fs.readFileSync(file, 'utf8'), file); return loaded.exports;
}
async function directoryFixture(t, options = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'noted-directory-v2-'));
  const db = new DirectorySqlite(), DatabaseManager = databaseClass(), database = new DatabaseManager({ existingConnection: db });
  database.initTables();
  const { createWorkflowOrganizationApi } = require('../workflow-organization-api');
  const { executionRefForInput } = require('../../shared/workflow-directory-catalog.cjs');
  const { projectDirectoryRuntime } = require('../workflow-directory-runtime');
  const runtime = entries => ({ epoch: 'fixture-runtime', tabs: entries.map(entry => projectDirectoryRuntime(entry,
    { terminalPresent: false, sdkPresent: false, liveOwnerCount: 0, provider: null, commandRunning: null, ownBusy: false,
      inheritedKnown: true, inheritedBusy: false, pending: false, notification: null, runSeq: 0 }, 'fixture-conversation')),
    isCurrent: () => true });
  const cards = entries => ({ epoch: 'fixture-cards', revision: 1, tabs: entries.map(entry => ({ tabId: entry.tabId,
    executionScope: executionRefForInput(entry).subject, fast: { known: false, enabled: null },
    plan: { known: true, revision: 0, items: [] }, pendingContext: { known: true, revision: 0, count: 0 } })),
    taskStatuses: [], taskStatusMarker: { shape: 'dot', sizePx: 8 }, isCurrent: () => true });
  const api = createWorkflowOrganizationApi({ database, readDirectoryRuntime: options.readRuntime || runtime,
    readDirectoryCards: options.readCards || cards, directoryOptions: options.directoryOptions || {} });
  api.bootstrap({ migrationId: 'fixture-migration', mutationId: 'fixture-activate', workspace: { activeSpaceId: 'main',
    spaces: [{ id: 'main', name: 'Main', projectIds: [], layout: {} }, { id: 'other', name: 'Other', projectIds: [], layout: {} }] } });
  const add = (id, record = {}, workflowId = 'main') => api.createTab({ mutationId: 'fixture-create:' + id,
    tabId: id, cwd: directory, workflowId, record: { name: id, commandType: 'codex', ...record } });
  const cleanup = async () => { db.close(); await fsp.rm(directory, { recursive: true }); };
  if (t) t.after(cleanup);
  return { directory, db, database, api, add, runtime, cards, cleanup };
}
module.exports = { DirectorySqlite, databaseClass, directoryFixture };
