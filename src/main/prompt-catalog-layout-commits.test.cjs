'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { observeCommittedPromptLayouts } = require('./prompt-catalog-layout-commits');

test('committed layout result is returned unchanged after one synchronous notification', () => {
  const result = { ok: true, revision: 4, layout: { orderByParent: {} } };
  const calls = [], notifications = [];
  const store = { put(...args) { assert.equal(this, store); calls.push(args); return result; } };
  const layout = { visualParentByPath: {} };
  const original = store.put;
  const observer = observeCommittedPromptLayouts(store, (...args) => notifications.push(args));
  assert.equal(store.put('/configured-root', layout, 3), result);
  assert.deepEqual(calls, [['/configured-root', layout, 3]]);
  assert.deepEqual(notifications, [['/configured-root', 4]]);
  observer.close();
  assert.equal(store.put, original);
});

test('conflict and original failure neither notify nor replay the mutation', () => {
  let calls = 0, notifications = 0;
  const conflict = { ok: false, conflict: true, revision: 9 };
  const failure = new Error('original layout failure');
  const store = { put(root) { calls++; if (root === 'bad') throw failure; return conflict; } };
  observeCommittedPromptLayouts(store, () => notifications++);
  assert.equal(store.put('root', {}, 8), conflict);
  assert.throws(() => store.put('bad', {}, 8), error => error === failure);
  assert.equal(calls, 2);
  assert.equal(notifications, 0);
});

test('observer failures preserve successful CAS receipt and report a separate loss', () => {
  const result = { ok: true, revision: 2 };
  const failure = new Error('notification failure');
  const losses = [];
  const store = { put: () => result };
  observeCommittedPromptLayouts(store, () => { throw failure; }, error => { losses.push(error); throw Error('logger failure'); });
  assert.equal(store.put('root', {}, 1), result);
  assert.deepEqual(losses, [failure]);
});

test('replacement observer is single and old disposal cannot restore a coauthor writer', () => {
  const calls = [], result = { ok: true, revision: 5 };
  const store = { put: () => result };
  const first = observeCommittedPromptLayouts(store, () => calls.push('old'));
  const second = observeCommittedPromptLayouts(store, () => calls.push('new'));
  first.close();
  assert.equal(store.put('root', {}), result);
  assert.deepEqual(calls, ['new']);
  const other = () => ({ ok: true, revision: 6 });
  store.put = other;
  second.close();
  assert.equal(store.put, other);
});

test('actual shared IPC and public store writes use the observer after committed CAS, without a new handler', () => {
  const rows = new Map(), handlers = new Map(), notifications = [];
  class DatabasePort {
    pragma() {} exec() {} close() {}
    prepare(sql) {
      if (sql.startsWith('SELECT')) return { get: root => rows.get(root) };
      if (sql.includes('INSERT INTO')) return { run(root, payload, time) {
        if (!rows.has(root)) rows.set(root, { revision: 1, payload, updated_at: time });
      } };
      return { run(payload, time, root, expected) {
        const old = rows.get(root);
        if (old?.revision !== expected) return { changes: 0 };
        rows.set(root, { revision: old.revision + 1, payload, updated_at: time });
        return { changes: 1 };
      } };
    }
  }
  const source = fs.readFileSync(path.join(__dirname,
    '../../../noted-shared/packages/file-explorer/main/shared-layout-store.cjs'), 'utf8');
  const modulePort = { exports: {} };
  const context = { module: modulePort, exports: modulePort.exports, process: { env: {} },
    require(name) {
      if (name === 'fs') return { mkdirSync() {} };
      if (name === 'os') return { homedir: () => '/controlled-no-storage' };
      if (name === 'path') return path;
      throw Error('unexpected module');
    } };
  vm.runInNewContext(source, context);
  const store = modulePort.exports.registerSharedFileLayoutIpc({
    ipcMain: { handle(channel, fn) { assert.equal(handlers.has(channel), false); handlers.set(channel, fn); } },
    Database: DatabasePort,
  });
  const observer = observeCommittedPromptLayouts(store, (root, revision) => {
    assert.equal(rows.get(root).revision, revision);
    notifications.push([root, revision]);
  });
  const root = '/configured-alias', layout = { orderByParent: {}, visualParentByPath: {} };
  const created = handlers.get('shared-file-layout:put')({}, root, layout, 0);
  assert.equal(created.ok, true);
  assert.equal(store.put(root, layout, 99).conflict, true);
  assert.equal(store.put(root, layout, 1).ok, true);
  assert.deepEqual(notifications, [[root, 1], [root, 2]]);
  assert.equal(handlers.size, 2);
  observer.close();
});
