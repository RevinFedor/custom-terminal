const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSharedFileIconStore, createSharedFileLayoutStore } = require('../main/shared-layout-store.cjs');

class FakeDatabase {
  constructor() { this.rows = new Map(); }
  pragma() {}
  exec() {}
  close() {}
  prepare(sql) {
    if (sql.startsWith('SELECT')) return { get: (key) => this.rows.get(key) };
    if (sql.includes('ON CONFLICT')) return { run: (key, payload, updatedAt) => {
      if (this.rows.has(key)) return { changes: 0 };
      this.rows.set(key, { revision: 1, payload, updated_at: updatedAt });
      return { changes: 1 };
    } };
    return { run: (payload, updatedAt, key, expected) => {
      const row = this.rows.get(key);
      if (!row || row.revision !== expected) return { changes: 0 };
      this.rows.set(key, { revision: row.revision + 1, payload, updated_at: updatedAt });
      return { changes: 1 };
    } };
  }
}

test('layout writes use compare-and-swap revisions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-layout-test-'));
  const store = createSharedFileLayoutStore({ Database: FakeDatabase, dbPath: path.join(dir, 'layout.db') });
  const first = store.put('/tmp/project', { orderByParent: { __root__: ['a'] }, visualParentByPath: {} }, 0);
  assert.equal(first.ok, true);
  assert.equal(first.revision, 1);
  const stale = store.put('/tmp/project', { orderByParent: { __root__: ['b'] }, visualParentByPath: {} }, 0);
  assert.equal(stale.conflict, true);
  assert.deepEqual(stale.layout.orderByParent.__root__, ['a']);
  const second = store.put('/tmp/project', { orderByParent: { __root__: ['b'] }, visualParentByPath: {} }, 1);
  assert.equal(second.revision, 2);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('icon profile writes use compare-and-swap revisions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-icon-profile-test-'));
  const store = createSharedFileIconStore({ Database: FakeDatabase, dbPath: path.join(dir, 'icons.db') });
  const firstProfile = {
    schemaVersion: 2,
    iconTheme: 'vscode',
    customIconRules: [{ type: 'extension', patterns: ['.prompt.md'], image: 'data:image/png;base64,one' }],
    nameOverrides: {},
    legacyImports: {
      gtEditorDevelopment: false,
      gtEditorProduction: true,
      customTerminalDevelopment: false,
      customTerminalProduction: false,
    },
  };
  const first = store.put(firstProfile, 0);
  assert.equal(first.ok, true);
  assert.equal(first.revision, 1);
  assert.equal(first.profile.customIconRules[0].patterns[0], '.prompt.md');

  const stale = store.put({ ...firstProfile, iconTheme: 'emoji' }, 0);
  assert.equal(stale.conflict, true);
  assert.equal(stale.profile.iconTheme, 'vscode');

  const second = store.put({ ...firstProfile, iconTheme: 'emoji' }, 1);
  assert.equal(second.ok, true);
  assert.equal(second.revision, 2);
  assert.equal(second.profile.iconTheme, 'emoji');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
