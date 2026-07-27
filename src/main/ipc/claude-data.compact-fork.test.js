'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _api } = require('./claude-data');

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

test('Claude compact fork retains the latest boundary and tail while leaving source untouched', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-compact-fork-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.jsonl');
  const destPath = path.join(dir, 'child.jsonl');
  const records = [
    { type: 'user', uuid: 'u0', parentUuid: null, sessionId: 'source', message: { content: 'before first compact' } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, sessionId: 'source' },
    { type: 'user', isCompactSummary: true, uuid: 's1', parentUuid: 'c1', sessionId: 'source', message: { content: 'first summary' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 's1', sessionId: 'source', message: { content: 'between compacts' } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'c2', parentUuid: null, logicalParentUuid: 'a1', sessionId: 'source' },
    { type: 'user', isCompactSummary: true, uuid: 's2', parentUuid: 'c2', sessionId: 'source', message: { content: 'latest summary' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 's2', sessionId: 'source', message: { content: 'retained answer' } },
  ];
  const original = jsonl(records);
  await fs.promises.writeFile(sourcePath, original, 'utf8');

  const inspection = await _api.inspectClaudeForkSource(sourcePath);
  assert.equal(inspection.lastCompactLineIndex, 4);
  const written = await _api.writeClaudeForkJsonlExclusive({
    sourcePath,
    destPath,
    newSessionId: 'child',
    startLine: inspection.lastCompactLineIndex,
  });

  const child = (await fs.promises.readFile(destPath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(child.map((record) => record.uuid), ['c2', 's2', 'a2']);
  assert.equal(child[0].parentUuid, null);
  assert.equal(child[0].logicalParentUuid, null,
    'the retained compact boundary is a real child root, not a pointer into the removed prefix');
  assert.equal(child[1].parentUuid, 'c2');
  assert.equal(child[2].parentUuid, 's2');
  assert.deepEqual(child.map((record) => record.sessionId), ['child', 'child', 'child']);
  assert.equal(written.retainedRecordCount, 3);
  assert.equal(written.compactRootRelinked, true);
  assert.equal(await fs.promises.readFile(sourcePath, 'utf8'), original);
});

test('ordinary Claude fork preserves an existing compact logical parent', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-ordinary-fork-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.jsonl');
  const destPath = path.join(dir, 'child.jsonl');
  await fs.promises.writeFile(sourcePath, jsonl([
    { type: 'user', uuid: 'u0', parentUuid: null, sessionId: 'source' },
    { type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'u0', sessionId: 'source' },
  ]), 'utf8');

  const written = await _api.writeClaudeForkJsonlExclusive({
    sourcePath,
    destPath,
    newSessionId: 'child',
    startLine: 0,
  });
  const child = (await fs.promises.readFile(destPath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(child[1].logicalParentUuid, 'u0');
  assert.equal(written.compactRootRelinked, false);
});

test('Claude compact inspection reports absence instead of treating an arbitrary row as a boundary', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-no-compact-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.jsonl');
  await fs.promises.writeFile(sourcePath, jsonl([
    { type: 'user', uuid: 'u0', sessionId: 'source' },
    { type: 'summary', uuid: 'looks-close-but-is-not-a-boundary', sessionId: 'source' },
  ]), 'utf8');

  const inspection = await _api.inspectClaudeForkSource(sourcePath);
  assert.equal(inspection.lastCompactLineIndex, -1);
  assert.equal(inspection.nonEmptyLineCount, 2);
});
