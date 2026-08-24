'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { StorageCleanupService } = require('./storage-cleanup-service');

function inventory(items, generation = 'generation-1') {
  return {
    success: true,
    generation,
    scannedAt: Date.now(),
    settings: { enabled: true, retentionDays: {} },
    summary: {},
    items,
  };
}

test('delete requires the exact scan generation and refuses protected rows', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const protectedPath = path.join(root, 'protected.jsonl');
  fs.writeFileSync(protectedPath, 'x');
  const item = {
    id: 'protected', section: 'sessions', group: 'open', provider: 'claude',
    sessionId: 'open', path: protectedPath, sizeBytes: 1, protected: true,
    protectedReason: 'Open in Noted Terminal', deletable: false,
  };
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    scanInventory: async () => inventory([item]),
  });
  assert.equal((await service.deleteItems({ itemIds: ['protected'], generation: 'stale' })).error, 'storage_scan_stale');
  const result = await service.deleteItems({ itemIds: ['protected'], generation: 'generation-1' });
  assert.equal(result.success, false);
  assert.equal(result.failures[0].error, 'storage_item_protected');
  assert.equal(fs.existsSync(protectedPath), true);
});

test('exact Claude row is unlinked and Codex deletion goes through injected provider command', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-provider-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudePath = path.join(root, 'projects', 'claude.jsonl');
  const codexPath = path.join(root, 'sessions', 'codex.jsonl');
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(claudePath, 'c');
  fs.writeFileSync(codexPath, 'x');
  const items = [
    { id: 'claude', section: 'sessions', group: 'outside', provider: 'claude', sessionId: 'c', path: claudePath, sizeBytes: 1, protected: false, deletable: true },
    { id: 'codex', section: 'sessions', group: 'outside', provider: 'codex', sessionId: 'x', path: codexPath, sizeBytes: 1, protected: false, deletable: true },
  ];
  const deletedCodex = [];
  const progress = [];
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    scanInventory: async () => inventory(items),
    deleteCodexSession: async (sessionId, item) => {
      deletedCodex.push(sessionId);
      fs.unlinkSync(item.path);
    },
  });
  const result = await service.deleteItems({ itemIds: ['claude', 'codex'], generation: 'generation-1', onProgress: (entry) => progress.push(entry) });
  assert.equal(result.success, true);
  assert.deepEqual(deletedCodex, ['x']);
  assert.equal(fs.existsSync(claudePath), false);
  assert.equal(fs.existsSync(codexPath), false);
  assert.equal(progress.length, 2);
  assert.equal(progress.at(-1).completed, 2);
  assert.equal(progress.at(-1).removed, 2);
});

test('automatic retention skips a Codex parent whose delete closure has descendants', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentPath = path.join(root, 'sessions', 'parent.jsonl');
  const leafPath = path.join(root, 'sessions', 'leaf.jsonl');
  fs.mkdirSync(path.dirname(parentPath), { recursive: true });
  fs.writeFileSync(parentPath, 'p');
  fs.writeFileSync(leafPath, 'l');
  const items = [
    { id: 'parent', section: 'sessions', group: 'fork', provider: 'codex', sessionId: 'parent', path: parentPath, sizeBytes: 1, protected: false, deletable: true, eligible: true, deleteAfter: 1, affectedItems: 2 },
    { id: 'leaf', section: 'sessions', group: 'fork', provider: 'codex', sessionId: 'leaf', path: leafPath, sizeBytes: 1, protected: false, deletable: true, eligible: true, deleteAfter: 1, affectedItems: 1 },
  ];
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    dbManager: { getAppState: () => ({ enabled: true }), setAppState() {} },
    scanInventory: async () => inventory(items),
    deleteCodexSession: async (_sessionId, item) => fs.unlinkSync(item.path),
  });
  const result = await service.runRetentionSweep({ maxItems: 10, maxBytes: 100 });
  assert.equal(result.success, true);
  assert.deepEqual(result.removed, ['leaf']);
  assert.equal(fs.existsSync(parentPath), true);
  assert.equal(fs.existsSync(leafPath), false);
});
