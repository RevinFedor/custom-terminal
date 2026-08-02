'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeClaudeForkJsonlExclusive } = require('./claude-data');

test('relocated Claude fork rewrites session and cwd while preserving history', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-cwd-fork-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const sourcePath = path.join(tempDir, 'source.jsonl');
  const destPath = path.join(tempDir, 'child.jsonl');
  const sourceRecords = [
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId: 'source-session',
      cwd: '/old/project',
      message: { content: 'keep me' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: 'source-session',
      cwd: '/old/project',
      message: { content: 'kept response' },
    },
  ];
  fs.writeFileSync(sourcePath, `${sourceRecords.map(JSON.stringify).join('\n')}\n`, 'utf8');

  const result = await writeClaudeForkJsonlExclusive({
    sourcePath,
    destPath,
    newSessionId: 'child-session',
    rewriteCwd: '/new/project',
  });
  const childRecords = fs.readFileSync(destPath, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);

  assert.equal(result.retainedRecordCount, 2);
  assert.deepEqual(result.retainedUuids, ['u1', 'a1']);
  assert.deepEqual(childRecords.map((record) => record.sessionId), [
    'child-session',
    'child-session',
  ]);
  assert.deepEqual(childRecords.map((record) => record.cwd), [
    '/new/project',
    '/new/project',
  ]);
  assert.equal(childRecords[0].message.content, 'keep me');
  assert.equal(childRecords[1].parentUuid, 'u1');
});
