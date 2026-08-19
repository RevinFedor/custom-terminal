'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { indexSessionFile } = require('./semantic-search');

test('an unchanged indexed session costs metadata only, not a full SHA read', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-index-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.jsonl');
  const content = JSON.stringify({
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: 'hello' },
  }) + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');

  const db = {
    prepare(sql) {
      if (/SELECT file_hash/i.test(sql)) {
        return {
          get: () => ({
            file_hash: hash,
            file_size: stat.size,
            file_mtime_ms: stat.mtimeMs,
          }),
        };
      }
      if (/SELECT 1 FROM session_chunks/i.test(sql)) {
        return { get: () => ({ present: 1 }) };
      }
      throw new Error('unexpected SQL in unchanged path: ' + sql);
    },
  };

  const realReadFileSync = fs.readFileSync;
  let fullReads = 0;
  fs.readFileSync = function patched(target, ...rest) {
    if (target === filePath) fullReads += 1;
    return realReadFileSync.call(this, target, ...rest);
  };
  try {
    const result = await indexSessionFile(db, filePath, 'session', 'project');
    assert.equal(result.skipped, true);
    assert.equal(fullReads, 0, 'metadata equality must skip hashing the 111MB source');
  } finally {
    fs.readFileSync = realReadFileSync;
  }
});

test('a changed session is hashed and parsed without synchronous large-file reads', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-index-stream-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(filePath, JSON.stringify({ type: 'system', uuid: 's1' }) + '\n', 'utf8');

  const db = {
    prepare(sql) {
      if (/SELECT file_hash/i.test(sql)) return { get: () => null };
      if (/SELECT id FROM session_chunks/i.test(sql)) return { all: () => [] };
      if (/DELETE FROM session_chunks/i.test(sql)) return { run: () => ({ changes: 0 }) };
      throw new Error('unexpected SQL in changed path: ' + sql);
    },
  };

  const realReadFileSync = fs.readFileSync;
  let syncReads = 0;
  fs.readFileSync = function patched(target, ...rest) {
    if (target === filePath) syncReads += 1;
    return realReadFileSync.call(this, target, ...rest);
  };
  try {
    const result = await indexSessionFile(db, filePath, 'session', 'project');
    assert.equal(result.skipped, false);
    assert.equal(result.chunked, 0);
    assert.equal(syncReads, 0);
  } finally {
    fs.readFileSync = realReadFileSync;
  }
});
