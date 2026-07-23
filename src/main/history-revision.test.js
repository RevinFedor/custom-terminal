const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  buildHistoryRevision,
  validateHistoryRevision,
} = require('./history-revision');

async function sourceFor(filePath, extra = {}) {
  const stat = await fs.promises.stat(filePath);
  return { filePath, size: stat.size, mtimeMs: stat.mtimeMs, ...extra };
}

test('history revision is deterministic and survives without process state', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'history-revision-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.jsonl');
  await fs.promises.writeFile(filePath, '{"type":"one"}\n');
  const identity = { toolType: 'codex', sessionId: 'session-a', cwd: dir };
  const source = await sourceFor(filePath, { sessionId: 'session-a' });

  const first = buildHistoryRevision(identity, [source]);
  const second = buildHistoryRevision(identity, [source]);
  assert.deepEqual(second, first);

  const result = await validateHistoryRevision(first, identity, {
    resolvePrimaryFile: async () => filePath,
  });
  assert.equal(result.unchanged, true);
});

test('history revision detects rewritten source before history projection', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'history-revision-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.jsonl');
  await fs.promises.writeFile(filePath, 'old\n');
  const identity = { toolType: 'claude', sessionId: 'session-a', cwd: dir };
  const revision = buildHistoryRevision(identity, [
    await sourceFor(filePath, { sessionId: 'session-a' }),
  ]);

  await fs.promises.appendFile(filePath, 'new\n');
  const result = await validateHistoryRevision(revision, identity, {
    resolvePrimaryFile: async () => filePath,
  });
  assert.equal(result.unchanged, false);
  assert.equal(result.reason, 'source-changed');
});

test('history revision checks primary identity and Claude chain topology', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'history-revision-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const childPath = path.join(dir, 'child.jsonl');
  const parentPath = path.join(dir, 'parent.jsonl');
  await fs.promises.writeFile(childPath, 'child\n');
  await fs.promises.writeFile(parentPath, 'parent\n');
  const identity = { toolType: 'claude', sessionId: 'child', cwd: dir };
  const revision = buildHistoryRevision(identity, [
    await sourceFor(childPath, {
      sessionId: 'child',
      parentSessionId: 'parent',
      linkKind: 'sqlite',
    }),
    await sourceFor(parentPath, { sessionId: 'parent', linkKind: 'end' }),
  ]);

  const wrongPrimary = await validateHistoryRevision(revision, identity, {
    resolvePrimaryFile: async () => parentPath,
  });
  assert.equal(wrongPrimary.reason, 'primary-file-changed');

  const wrongTopology = await validateHistoryRevision(revision, identity, {
    resolvePrimaryFile: async () => childPath,
    validateTopology: async () => false,
  });
  assert.equal(wrongTopology.reason, 'topology-changed');
});

test('history revision rejects a tampered token or owner', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'history-revision-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.jsonl');
  await fs.promises.writeFile(filePath, 'content\n');
  const identity = { toolType: 'codex', sessionId: 'session-a', cwd: dir };
  const revision = buildHistoryRevision(identity, [await sourceFor(filePath)]);

  const tampered = { ...revision, token: 'bad' };
  assert.equal((await validateHistoryRevision(tampered, identity)).reason, 'invalid-revision');
  assert.equal((await validateHistoryRevision(revision, {
    ...identity,
    sessionId: 'session-b',
  })).reason, 'invalid-revision');
});

test('history revision invalidates when non-file presentation or discovery context changes', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'history-revision-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.jsonl');
  await fs.promises.writeFile(filePath, 'content\n');
  const identity = { toolType: 'claude', sessionId: 'session-a', cwd: dir };
  const revision = buildHistoryRevision(
    identity,
    [await sourceFor(filePath)],
    { context: 'directory-generation-a' }
  );

  const result = await validateHistoryRevision(revision, identity, {
    context: 'directory-generation-b',
  });
  assert.equal(result.unchanged, false);
  assert.equal(result.reason, 'context-changed');
});
