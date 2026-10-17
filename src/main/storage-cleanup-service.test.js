'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  StorageCleanupService,
  canOwnAutomaticStorageRetention,
} = require('./storage-cleanup-service');

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

test('automatic retention defaults to canonical packaged production; private tests require proof', () => {
  assert.equal(canOwnAutomaticStorageRetention({ isPackaged: true, e2e: false }), true);
  assert.equal(canOwnAutomaticStorageRetention({ isPackaged: false, e2e: false }), false);
  assert.equal(canOwnAutomaticStorageRetention({ isPackaged: true, e2e: true }), false);
  assert.equal(canOwnAutomaticStorageRetention({ isPackaged: true, e2e: false, canonicalProduction: false }), false);
  assert.equal(canOwnAutomaticStorageRetention({ isPackaged: false, e2e: true, isolatedTest: true }), true);
});

test('shared storage mutation refuses dev without canonical production authority', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'projects', 'outside.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'x');
  let scans = 0;
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    currentEnvironment: 'development',
    getMutationAuthority: () => ({ allowed: false, reason: 'canonical-production-db-unavailable' }),
    scanInventory: async () => {
      scans += 1;
      return inventory([]);
    },
  });
  const result = await service.deleteItems({ itemIds: ['outside'], generation: 'generation-1' });
  assert.equal(result.success, false);
  assert.equal(result.error, 'storage_production_authority_unavailable');
  assert.equal(result.reason, 'canonical-production-db-unavailable');
  assert.equal(scans, 0);
  assert.equal(fs.existsSync(target), true);
});

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
  let nowMs = Date.now();
  const items = [
    { id: 'parent', section: 'sessions', group: 'fork', provider: 'codex', sessionId: 'parent', path: parentPath, modifiedAt: fs.statSync(parentPath).mtimeMs, sizeBytes: 1, protected: false, deletable: true, eligible: true, deleteAfter: 1, affectedItems: 2 },
    { id: 'leaf', section: 'sessions', group: 'fork', provider: 'codex', sessionId: 'leaf', path: leafPath, modifiedAt: fs.statSync(leafPath).mtimeMs, sizeBytes: 1, protected: false, deletable: true, eligible: true, deleteAfter: 1, affectedItems: 1 },
  ];
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    dbManager: { getAppState: () => ({ enabled: true }), setAppState() {} },
    scanInventory: async () => inventory(items),
    deleteCodexSession: async (_sessionId, item) => fs.unlinkSync(item.path),
    now: () => nowMs,
  });
  await service.scan();
  nowMs += 24 * 60 * 60 * 1000 + 1000;
  const result = await service.runRetentionSweep({ maxItems: 10, maxBytes: 100 });
  assert.equal(result.success, true);
  assert.deepEqual(result.removed, ['leaf']);
  assert.equal(fs.existsSync(parentPath), true);
  assert.equal(fs.existsSync(leafPath), false);
});

test('provider-authoritative Codex closure blocks a protected descendant before delete', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-descendant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentPath = path.join(root, 'sessions', 'parent.jsonl');
  const childPath = path.join(root, 'sessions', 'child.jsonl');
  fs.mkdirSync(path.dirname(parentPath), { recursive: true });
  fs.writeFileSync(parentPath, 'p');
  fs.writeFileSync(childPath, 'c');
  const items = [
    { id: 'parent', section: 'sessions', group: 'outside', provider: 'codex', sessionId: 'parent', path: parentPath, sizeBytes: 1, protected: false, deletable: true },
    { id: 'child', section: 'sessions', group: 'open', provider: 'codex', sessionId: 'child', path: childPath, sizeBytes: 1, protected: true, protectedReason: 'Open in production', deletable: false },
  ];
  let deleteCalls = 0;
  const auditRows = [];
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    scanInventory: async () => inventory(items),
    audit: { record: async (row) => auditRows.push(row) },
    createCodexDeletionProvider: () => ({
      inspectDeleteClosure: async () => ['parent', 'child'],
      deleteSession: async () => { deleteCalls += 1; },
      close() {},
    }),
  });
  const result = await service.deleteItems({ itemIds: ['parent'], generation: 'generation-1', operationId: 'op-protected' });
  assert.equal(result.success, false);
  assert.equal(result.failures[0].error, 'storage_codex_descendant_protected');
  assert.equal(result.failures[0].protectedSessionId, 'child');
  assert.equal(deleteCalls, 0);
  assert.equal(fs.existsSync(parentPath), true);
  assert.equal(auditRows.at(-1).status, 'failed');
  assert.deepEqual(auditRows.at(-1).closureSessionIds, ['parent', 'child']);
});

test('manual Codex delete refuses provider descendants absent from the confirmation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-expanded-closure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentPath = path.join(root, 'sessions', 'parent.jsonl');
  fs.mkdirSync(path.dirname(parentPath), { recursive: true });
  fs.writeFileSync(parentPath, 'p');
  const item = { id: 'parent', section: 'sessions', group: 'outside', provider: 'codex', sessionId: 'parent', path: parentPath, sizeBytes: 1, protected: false, deletable: true, affectedSessionIds: ['parent'] };
  let deleteCalls = 0;
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    scanInventory: async () => inventory([item]),
    audit: { record: async () => {} },
    createCodexDeletionProvider: () => ({
      inspectDeleteClosure: async () => ['parent', 'unconfirmed-child'],
      deleteSession: async () => { deleteCalls += 1; },
      close() {},
    }),
  });
  const result = await service.deleteItems({ itemIds: ['parent'], generation: 'generation-1' });
  assert.equal(result.success, false);
  assert.equal(result.failures[0].error, 'storage_codex_delete_closure_expanded');
  assert.deepEqual(result.failures[0].unexpectedDescendantSessionIds, ['unconfirmed-child']);
  assert.equal(deleteCalls, 0);
  assert.equal(fs.existsSync(parentPath), true);
});

test('automatic retention only deletes a provider-proven Codex leaf', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-provider-leaf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentPath = path.join(root, 'sessions', 'parent.jsonl');
  fs.mkdirSync(path.dirname(parentPath), { recursive: true });
  fs.writeFileSync(parentPath, 'p');
  let nowMs = Date.now();
  const item = { id: 'parent', section: 'sessions', group: 'outside', provider: 'codex', sessionId: 'parent', path: parentPath, modifiedAt: fs.statSync(parentPath).mtimeMs, sizeBytes: 1, protected: false, deletable: true, eligible: true, deleteAfter: 1, affectedItems: 1, affectedSessionIds: ['parent'] };
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    dbManager: { getAppState: () => ({ enabled: true }), setAppState() {} },
    scanInventory: async () => inventory([item]),
    audit: { record: async () => {} },
    createCodexDeletionProvider: () => ({
      inspectDeleteClosure: async () => ['parent', 'provider-child'],
      deleteSession: async () => { throw new Error('must not delete'); },
      close() {},
    }),
    now: () => nowMs,
  });
  await service.scan();
  nowMs += 24 * 60 * 60 * 1000 + 1000;
  const result = await service.runRetentionSweep({ maxItems: 10, maxBytes: 100 });
  assert.equal(result.success, false);
  assert.equal(result.failures[0].error, 'storage_codex_retention_requires_provider_leaf');
  assert.equal(fs.existsSync(parentPath), true);
});

test('dev rechecks canonical production tabs against provider descendants immediately before delete', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-prod-recheck-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentPath = path.join(root, 'sessions', 'parent.jsonl');
  fs.mkdirSync(path.dirname(parentPath), { recursive: true });
  fs.writeFileSync(parentPath, 'p');
  const production = {
    prepare(sql) {
      return {
        get(...values) {
          if (sql.includes('FROM tabs') && values.includes('production-child')) {
            return { codex_session_id: 'production-child', claude_session_id: null };
          }
          return undefined;
        },
      };
    },
  };
  const item = { id: 'parent', section: 'sessions', group: 'outside', provider: 'codex', sessionId: 'parent', path: parentPath, sizeBytes: 1, protected: false, deletable: true, affectedItems: 2, affectedSessionIds: ['parent', 'production-child'] };
  let deleteCalls = 0;
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    currentEnvironment: 'development',
    relationDatabases: [{ environment: 'production', sqlite: production }],
    getMutationAuthority: () => ({ allowed: true, reason: 'canonical-production-db-readonly' }),
    scanInventory: async () => inventory([item]),
    audit: { record: async () => {} },
    createCodexDeletionProvider: () => ({
      inspectDeleteClosure: async () => ['parent', 'production-child'],
      deleteSession: async () => { deleteCalls += 1; },
      close() {},
    }),
  });
  const result = await service.deleteItems({ itemIds: ['parent'], generation: 'generation-1' });
  assert.equal(result.success, false);
  assert.equal(result.failures[0].error, 'storage_session_became_protected');
  assert.equal(result.failures[0].protectedSessionId, 'production-child');
  assert.equal(deleteCalls, 0);
  assert.equal(fs.existsSync(parentPath), true);
});

test('successful deletion audit records root and actual provider-deleted session ids', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentPath = path.join(root, 'sessions', 'parent.jsonl');
  fs.mkdirSync(path.dirname(parentPath), { recursive: true });
  fs.writeFileSync(parentPath, 'p');
  const item = { id: 'parent', section: 'sessions', group: 'outside', provider: 'codex', sessionId: 'parent', path: parentPath, sizeBytes: 1, protected: false, deletable: true, affectedItems: 2, affectedSessionIds: ['parent', 'child'] };
  const auditRows = [];
  const logs = [];
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    scanInventory: async () => inventory([item]),
    audit: { record: async (row) => auditRows.push(row) },
    logger: { log: (line) => logs.push(line), error() {} },
    createCodexDeletionProvider: () => ({
      inspectDeleteClosure: async () => ['parent', 'child'],
      deleteSession: async () => {
        fs.unlinkSync(parentPath);
        return { deletedSessionIds: ['child', 'parent'], notificationsComplete: true };
      },
      close() {},
    }),
  });
  const result = await service.deleteItems({
    itemIds: ['parent'],
    generation: 'generation-1',
    source: 'manual',
    operationId: 'op-audit',
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.removedSessions, ['child', 'parent']);
  assert.deepEqual(auditRows.map((row) => row.status), ['attempt', 'removed']);
  assert.deepEqual(auditRows[1].deletedSessionIds, ['child', 'parent']);
  assert.equal(auditRows[1].operationId, 'op-audit');
  assert.equal(logs.some((line) => line.includes('"sessionId":"parent"') && line.includes('"deletedSessionIds":["child","parent"]')), true);
});

test('dashboard confirmation token carries exact provider scope into the second destructive click', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-confirmation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentPath = path.join(root, 'sessions', 'parent.jsonl');
  const childPath = path.join(root, 'sessions', 'child.jsonl');
  fs.mkdirSync(path.dirname(parentPath), { recursive: true });
  fs.writeFileSync(parentPath, 'parent');
  fs.writeFileSync(childPath, 'child');
  const parent = { id: 'parent', section: 'sessions', group: 'outside', provider: 'codex', sessionId: 'parent', path: parentPath, sizeBytes: 6, protected: false, deletable: true, affectedItems: 1, affectedSessionIds: ['parent'] };
  const child = { id: 'child', section: 'sessions', group: 'outside', provider: 'codex', sessionId: 'child', path: childPath, sizeBytes: 5, protected: false, deletable: true };
  const auditRows = [];
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    scanInventory: async () => inventory([parent, child]),
    audit: { record: async (row) => auditRows.push(row) },
    confirmationSecret: Buffer.from('test-confirmation-secret'),
    createCodexDeletionProvider: () => ({
      inspectDeleteClosure: async (sessionId) => sessionId === 'parent' ? ['parent', 'child'] : [sessionId],
      deleteSession: async (_sessionId, closure) => {
        fs.unlinkSync(parentPath);
        fs.unlinkSync(childPath);
        return { deletedSessionIds: [...closure], notificationsComplete: true };
      },
      close() {},
    }),
  });
  const prepared = await service.prepareDeleteItems({ itemIds: ['parent'], generation: 'generation-1' });
  assert.equal(prepared.success, true);
  assert.equal(prepared.affectedItems, 2);
  assert.equal(prepared.affectedBytes, 11);
  assert.ok(prepared.confirmationToken);
  const deleted = await service.deleteItems({
    itemIds: ['parent'],
    generation: 'generation-1',
    source: 'dashboard',
    confirmationToken: prepared.confirmationToken,
  });
  assert.equal(deleted.success, true);
  assert.deepEqual(deleted.removedSessions, ['parent', 'child']);
  assert.deepEqual(auditRows.at(-1).closureSessionIds, ['parent', 'child']);
});

test('dashboard delete without a signed scope is rejected before mutation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-confirmation-required-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'projects', 'claude.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'x');
  const item = { id: 'claude', section: 'sessions', group: 'outside', provider: 'claude', sessionId: 'claude', path: target, sizeBytes: 1, protected: false, deletable: true };
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    scanInventory: async () => inventory([item]),
  });
  const result = await service.deleteItems({ itemIds: ['claude'], generation: 'generation-1', source: 'dashboard' });
  assert.equal(result.success, false);
  assert.equal(result.error, 'storage_delete_confirmation_required');
  assert.equal(fs.existsSync(target), true);
});

test('dashboard confirmation becomes stale when provider descendants change before delete', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-confirmation-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'sessions', 'parent.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'x');
  const item = { id: 'parent', section: 'sessions', group: 'outside', provider: 'codex', sessionId: 'parent', path: target, sizeBytes: 1, protected: false, deletable: true };
  let inspections = 0;
  let deleteCalls = 0;
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    scanInventory: async () => inventory([item]),
    audit: { record: async () => {} },
    confirmationSecret: Buffer.from('test-stale-secret'),
    createCodexDeletionProvider: () => ({
      inspectDeleteClosure: async () => (++inspections === 1 ? ['parent'] : ['parent', 'new-child']),
      deleteSession: async () => { deleteCalls += 1; },
      close() {},
    }),
  });
  const prepared = await service.prepareDeleteItems({ itemIds: ['parent'], generation: 'generation-1' });
  assert.equal(prepared.success, true);
  const result = await service.deleteItems({
    itemIds: ['parent'],
    generation: 'generation-1',
    source: 'dashboard',
    confirmationToken: prepared.confirmationToken,
  });
  assert.equal(result.success, false);
  assert.equal(result.failures[0].error, 'storage_delete_confirmation_stale');
  assert.equal(deleteCalls, 0);
  assert.equal(fs.existsSync(target), true);
});

test('unwritable audit fails before destructive provider call', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-audit-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'projects', 'claude.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'x');
  const item = { id: 'claude', section: 'sessions', group: 'outside', provider: 'claude', sessionId: 'claude', path: target, sizeBytes: 1, protected: false, deletable: true };
  const service = new StorageCleanupService({
    claudeHome: root,
    codexHome: root,
    appDataDir: root,
    scanInventory: async () => inventory([item]),
    audit: { record: async () => { throw new Error('disk read-only'); } },
    logger: { log() {}, error() {} },
  });
  const result = await service.deleteItems({ itemIds: ['claude'], generation: 'generation-1' });
  assert.equal(result.success, false);
  assert.equal(result.failures[0].error, 'storage_deletion_audit_unavailable');
  assert.equal(fs.existsSync(target), true);
});
