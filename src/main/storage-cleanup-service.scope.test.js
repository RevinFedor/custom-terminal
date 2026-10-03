'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { StorageCleanupService } = require('./storage-cleanup-service');
const { inventoryGeneration } = require('./storage-inventory');

async function fixture(t, { codex = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-storage-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const build = path.join(root, 'target', 'release');
  await fs.mkdir(build, { recursive: true });
  await fs.mkdir(path.join(root, 'sessions'));
  const selectedPath = codex ? path.join(root, 'sessions', 'parent.jsonl') : build;
  const selectedPayload = codex ? selectedPath : path.join(build, 'output.bin');
  const otherPath = path.join(root, 'sessions', 'unrelated.jsonl');
  await fs.writeFile(selectedPayload, 'old-build');
  await fs.writeFile(otherPath, 'other');
  const specs = [
    { id: 'selected', title: codex ? 'Codex fork' : 'Codex release build', path: selectedPath, payloadPath: selectedPayload, section: codex ? 'sessions' : 'builds', group: codex ? 'fork' : 'build', provider: codex ? 'codex' : null, sessionId: codex ? 'parent' : null },
    { id: 'other', title: 'Another session', path: otherPath, payloadPath: otherPath, section: 'sessions', group: 'outside', provider: 'claude', sessionId: 'other' },
  ];
  const audit = [];
  const runtimeIds = [];
  let closure = ['parent'];
  let mutations = 0;
  const service = new StorageCleanupService({
    projectRoot: root, codexHome: root, claudeHome: root, appDataDir: root,
    audit: { record: async (row) => audit.push(row) },
    logger: { log() {}, error() {} },
    getRuntimeProtectedSessionIds: () => runtimeIds,
    scanInventory: async () => {
      const items = [];
      for (const spec of specs) {
        const stat = await fs.stat(spec.path).catch(() => null);
        if (!stat) continue;
        const payload = await fs.stat(spec.payloadPath);
        items.push({ ...spec, sizeBytes: payload.size, modifiedAt: payload.mtimeMs,
          createdAt: stat.birthtimeMs, fileIdentity: `${stat.dev}:${stat.ino}`,
          protected: !!spec.protected, deletable: !spec.protected });
      }
      return { success: true, items, generation: inventoryGeneration(items, {}), scannedAt: Date.now(), settings: {}, summary: {} };
    },
    createCodexDeletionProvider: () => ({
      inspectDeleteClosure: async () => [...closure],
      deleteSession: async () => { mutations += 1; await fs.unlink(selectedPath); return { deletedSessionIds: [...closure] }; },
      close() {},
    }),
  });
  const shown = await service.scan({ force: true });
  const prepare = () => service.prepareDeleteItems({ itemIds: ['selected'], generation: shown.generation, itemRevisions: { selected: shown.items.find((item) => item.id === 'selected').deletionRevision } });
  const confirm = (prepared, extra = {}) => service.deleteItems({ itemIds: ['selected'], generation: prepared.generation, source: 'dashboard', confirmationToken: prepared.confirmationToken, ...extra });
  return { root, service, specs, audit, shown, prepare, confirm, selectedPath, selectedPayload, otherPath, runtimeIds,
    setClosure: (value) => { closure = value; }, mutations: () => mutations };
}

test('unchanged build can be confirmed and removed despite unrelated file changes before both clicks', async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.otherPath, 'growing-before-prepare');
  const prepared = await f.prepare();
  assert.equal(prepared.success, true);
  assert.notEqual(prepared.generation, f.shown.generation);
  await fs.appendFile(f.otherPath, 'growing-before-confirm');
  const removed = await f.confirm(prepared);
  assert.equal(removed.success, true);
  assert.deepEqual(removed.removed, ['selected']);
  await assert.rejects(fs.stat(f.selectedPath), { code: 'ENOENT' });
  assert.equal((await fs.readFile(f.otherPath, 'utf8')).includes('growing-before-confirm'), true);
  assert.deepEqual(f.audit.map((row) => row.status), ['attempt', 'removed']);
});

test('changed selected file is rejected before confirmation without deleting it', async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.selectedPayload, 'changed');
  const result = await f.prepare();
  assert.equal(result.error, 'storage_scan_stale');
  assert.equal(result.scope, 'selected-items');
  assert.deepEqual(result.changedItems.map((item) => item.itemId), ['selected']);
  assert.equal(f.audit.length, 0);
  await fs.stat(f.selectedPath);
});

test('confirmed target that changes or becomes protected cannot be removed', async (t) => {
  for (const change of ['content', 'protection']) {
    const f = await fixture(t);
    const prepared = await f.prepare();
    if (change === 'content') await fs.appendFile(f.selectedPayload, 'changed');
    else f.specs[0].protected = true;
    const result = await f.confirm(prepared);
    assert.equal(result.error, 'storage_scan_stale');
    assert.equal(result.changedItems[0].reason, change === 'protection' ? 'item-protected' : 'item-changed');
    assert.equal(f.audit.length, 0);
    await fs.stat(f.selectedPath);
  }
});

test('a known provider descendant belongs to the signed scope even if only its parent was selected', async (t) => {
  const f = await fixture(t, { codex: true });
  const childPath = path.join(f.root, 'sessions', 'child.jsonl');
  await fs.writeFile(childPath, 'child');
  f.specs.push({ id: 'child', path: childPath, payloadPath: childPath, section: 'sessions', group: 'fork', provider: 'codex', sessionId: 'child' });
  f.setClosure(['parent', 'child']);
  const prepared = await f.prepare();
  assert.equal(prepared.success, true);
  assert.equal(prepared.affectedItems, 2);
  await fs.appendFile(childPath, 'new child data');
  const result = await f.confirm(prepared);
  assert.equal(result.error, 'storage_scan_stale');
  assert.equal(result.changedItems[0].itemId, 'child');
  assert.equal(f.mutations(), 0);
});

test('new provider descendant and newly live writer still block the selected root immediately before mutation', async (t) => {
  for (const change of ['descendant', 'runtime']) {
    const f = await fixture(t, { codex: true });
    const prepared = await f.prepare();
    assert.equal(prepared.success, true);
    if (change === 'descendant') f.setClosure(['parent', 'new-child']);
    else f.runtimeIds.push('parent');
    const result = await f.confirm(prepared);
    assert.equal(result.success, false);
    assert.equal(result.failures[0].error, change === 'descendant' ? 'storage_delete_confirmation_stale' : 'storage_session_became_protected');
    assert.equal(f.mutations(), 0);
    await fs.stat(f.selectedPath);
  }
});

test('scope signature and exact selected ids remain mandatory', async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const wrongIds = await f.confirm(prepared, { itemIds: ['other'] });
  assert.equal(wrongIds.error, 'storage_delete_confirmation_invalid');
  const badSignature = await f.confirm(prepared, { confirmationToken: prepared.confirmationToken + 'invalid' });
  assert.equal(badSignature.error, 'storage_delete_confirmation_invalid');
  assert.equal(f.audit.length, 0);
  await fs.stat(f.selectedPath);
});
