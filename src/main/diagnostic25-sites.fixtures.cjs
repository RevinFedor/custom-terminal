'use strict';

// PlainNode-only test adapter, explicitly NOT the installed better-sqlite3 ABI.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

class PrivateSQLite {
  constructor(filename = ':memory:') {
    this.raw = new DatabaseSync(filename);
    this.open = true;
    this.depth = 0;
    this.calls = [];
  }
  get inTransaction() { return this.depth > 0; }
  exec(sql) { this.raw.exec(sql); return this; }
  function(name, ...args) { this.raw.function(name, ...args); return this; }
  pragma(sql, options = {}) {
    const rows = this.raw.prepare('PRAGMA ' + sql).all().map(row => ({ ...row }));
    return options.simple ? Object.values(rows[0] || {})[0] : rows;
  }
  prepare(sql) {
    this.calls.push({ operation: 'prepare', sql });
    const statement = this.raw.prepare(sql);
    const wrap = operation => (...args) => {
      this.calls.push({ operation, sql, args });
      const result = statement[operation](...args);
      return operation === 'all' ? result.map(row => ({ ...row }))
        : operation === 'get' && result ? { ...result } : result;
    };
    return { get: wrap('get'), all: wrap('all'), run: wrap('run') };
  }
  transaction(callback) {
    const run = (mode, args) => {
      const depth = this.depth++, savepoint = 'diagnostic25_' + depth;
      this.raw.exec(depth ? 'SAVEPOINT ' + savepoint : 'BEGIN ' + mode);
      try {
        const result = callback(...args);
        this.raw.exec(depth ? 'RELEASE ' + savepoint : 'COMMIT');
        return result;
      } catch (error) {
        this.raw.exec(depth ? 'ROLLBACK TO ' + savepoint : 'ROLLBACK');
        if (depth) this.raw.exec('RELEASE ' + savepoint);
        throw error;
      } finally { this.depth--; }
    };
    const fn = (...args) => run('DEFERRED', args);
    for (const mode of ['deferred', 'immediate', 'exclusive']) fn[mode] = (...args) => run(mode.toUpperCase(), args);
    return fn;
  }
  close() { this.raw.close(); this.open = false; }
}

function load(name, overrides = {}, globals = {}) {
  const filename = path.join(__dirname, name), module = { exports: {} };
  const realRequire = createRequire(filename);
  const requireLocal = id => Object.hasOwn(overrides, id) ? overrides[id] : realRequire(id);
  const names = ['require', 'module', 'exports', '__filename', '__dirname', ...Object.keys(globals)];
  const execute = new Function(...names, fs.readFileSync(filename, 'utf8'));
  execute(requireLocal, module, module.exports, filename, __dirname, ...Object.values(globals));
  return module.exports;
}

module.exports = { PrivateSQLite, load };

// Existing inert suites can run against the same disclosed substitute without
// modifying their sources or treating their native-ABI skip branch as a pass.
if (process.env.DIAGNOSTIC25_SQLITE_SUBSTITUTE === '1') {
  const filename = require.resolve('better-sqlite3');
  require.cache[filename] = { id: filename, filename, loaded: true, exports: PrivateSQLite };
}
