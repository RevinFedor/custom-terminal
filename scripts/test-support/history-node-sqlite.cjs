'use strict';

// Node 24+ test adapter only. Production continues to inject its existing
// better-sqlite3/Electron ABI adapter. The SQL, transactions and page store
// exercised by the finite source controls are otherwise the actual modules.
const { DatabaseSync } = require('node:sqlite');
class HistoryNodeSqlite {
  constructor(filename) { this.database = new DatabaseSync(filename); this.depth = 0; }
  get inTransaction() { return this.depth > 0; }
  prepare(sql) { return this.database.prepare(sql); }
  exec(sql) { return this.database.exec(sql); }
  pragma(sql, { simple = false } = {}) {
    const rows = this.database.prepare('PRAGMA ' + sql).all();
    return simple ? rows.length ? Object.values(rows[0])[0] : undefined : rows;
  }
  transaction(fn) {
    return (...args) => {
      const nested = this.depth > 0, savepoint = 'history_test_' + this.depth;
      this.database.exec(nested ? 'SAVEPOINT ' + savepoint : 'BEGIN'); this.depth++;
      try {
        const result = fn(...args);
        this.database.exec(nested ? 'RELEASE ' + savepoint : 'COMMIT');
        return result;
      } catch (error) {
        try { this.database.exec(nested ? 'ROLLBACK TO ' + savepoint + '; RELEASE ' + savepoint : 'ROLLBACK'); } catch {}
        throw error;
      } finally { this.depth--; }
    };
  }
  close() { this.database.close(); }
}
module.exports = HistoryNodeSqlite;
