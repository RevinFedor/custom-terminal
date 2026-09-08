'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { commitPreparedFork } = require('./fork-commit');

test('fork event and annotations commit together before the prepared file becomes usable', async (t) => {
  const Database = require('better-sqlite3');
  let db;
  try { db = new Database(':memory:'); } catch (error) {
    if (error.code === 'ERR_DLOPEN_FAILED') return t.skip('run with Electron ABI');
    throw error;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-fork-commit-'));
  t.after(async () => { db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE events (id TEXT); CREATE TABLE notes (id TEXT);');
  for (const fail of [true, false]) {
    const newSessionId = crypto.randomUUID();
    const filePath = path.join(dir, newSessionId + '.jsonl');
    await fs.writeFile(filePath, 'preserved clone bytes\n', { flag: 'wx' });
    const execute = () => commitPreparedFork({ filePath, newSessionId, store: { db }, commit: () => {
      db.prepare('INSERT INTO events VALUES (?)').run(newSessionId);
      if (fail) throw new Error('injected note failure');
      db.prepare('INSERT INTO notes VALUES (?)').run(newSessionId);
      return { eventKey: newSessionId };
    } });
    if (fail) {
      await assert.rejects(execute, (error) => error.code === 'fork_metadata_commit_failed' && error.artifactQuarantined);
      assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
      assert.equal(await fs.readFile(filePath + '.uncommitted', 'utf8'), 'preserved clone bytes\n');
      await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
    } else {
      assert.equal((await execute()).eventKey, newSessionId);
      assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM notes').get().n, 1);
      assert.equal(await fs.readFile(filePath, 'utf8'), 'preserved clone bytes\n');
    }
  }
});

test('artifact quarantine never accepts an unrelated path', async () => {
  await assert.rejects(commitPreparedFork({ filePath: '/', newSessionId: crypto.randomUUID() }), /fork_artifact_identity_invalid/);
});
