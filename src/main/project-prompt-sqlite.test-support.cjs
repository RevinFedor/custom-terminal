'use strict';
// Explicit Node builtin SQLite substitute for the Electron/better-sqlite3 ABI.
// Real SQL/transactions on PRIVATE fixtures, not production/native acceptance.
const { DatabaseSync } = require('node:sqlite');
class NodeSqliteAdapter {
  constructor(filename) { this.raw = new DatabaseSync(filename); this.open = true; this.depth = 0; }
  get inTransaction() { return this.depth > 0; }
  exec(sql) { return this.raw.exec(sql); }
  prepare(sql) {
    const q = this.raw.prepare(sql);
    return { get: (...a) => q.get(...a), all: (...a) => q.all(...a), run: (...a) => q.run(...a),
      iterate: (...a) => q.iterate(...a) };
  }
  pragma(text, options = {}) {
    const row = this.raw.prepare('PRAGMA ' + text).all(); return options.simple ? Object.values(row[0] || {})[0] : row;
  }
  transaction(fn) {
    const run = (...args) => {
      const name = 'fixture_' + this.depth, nested = this.depth > 0;
      this.exec(nested ? 'SAVEPOINT ' + name : 'BEGIN IMMEDIATE'); this.depth++;
      try { const v = fn(...args); this.exec(nested ? 'RELEASE ' + name : 'COMMIT'); return v; }
      catch (e) { this.exec(nested ? 'ROLLBACK TO ' + name : 'ROLLBACK'); if (nested) this.exec('RELEASE ' + name); throw e; }
      finally { this.depth--; }
    };
    run.immediate = run; run.deferred = run; run.exclusive = run; return run;
  }
  function(name, options, fn) { return this.raw.function(name, typeof options === 'function' ? options : fn); }
  close() { this.raw.close(); this.open = false; }
}
module.exports = { NodeSqliteAdapter };
