'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const SQLite = require('better-sqlite3');
const DatabaseManager = require('./database');
const { HistoryFreshness } = require('./history-freshness');
const { buildHistoryRevision } = require('./history-revision');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-freshness-'));
  const file = path.join(dir, 'source.jsonl'); await fs.writeFile(file, 'AAAA\n');
  const scope = { tabId: 'T', toolType: 'codex', sessionId: 'S', cwd: dir };
  const db = new DatabaseManager({ existingConnection: new SQLite(path.join(dir, 'metadata.db')) }); db.initTables();
  let runtime = 'runtime-1';
  const create = epoch => new HistoryFreshness({ epoch,
    readContext: (request, sourceSessionIds) => ({ metadata: db.getHistoryFreshnessMetadata({ ...request, sourceSessionIds }), runtime }) });
  const owner = create('epoch-1');
  const sources = async () => { const s = await fs.stat(file); return [{ filePath: file, sessionId: 'S', size: s.size,
    mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, fileIdentity: s.dev + ':' + s.ino }]; };
  const cover = async (instance = owner) => {
    const ticket = await instance.beginRead(scope), proof = await sources();
    return instance.completeRead(scope, { success: true, revision: buildHistoryRevision(scope, proof), freshnessReadSources: proof }, ticket);
  };
  t.after(async () => { db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, file, scope, db, owner, create, sources, cover, setRuntime: value => { runtime = value; } };
}

test('unobserved source stays unknown; a certified page enables stats-only foreground checks', async t => {
  const h = await fixture(t);
  assert.equal((await h.owner.probe(h.scope)).state, 'unknown');
  const applied = await h.cover(); assert.equal(applied.state, 'known');
  const checked = await h.owner.probe(h.scope);
  assert.equal(checked.token, applied.token); assert.ok(checked.sequence > applied.sequence);
  await fs.appendFile(h.file, 'new bytes while native absent\n');
  const dirty = await h.owner.probe(h.scope);
  assert.equal(dirty.state, 'known'); assert.notEqual(dirty.token, applied.token);
});

test('same-size atomic replacement and in-place rewrite with restored mtime both change freshness', async t => {
  const h = await fixture(t); const first = await h.cover(); const old = await fs.stat(h.file);
  await fs.writeFile(path.join(h.dir, 'replacement'), 'BBBB\n');
  await fs.utimes(path.join(h.dir, 'replacement'), old.atime, old.mtime);
  await fs.rename(path.join(h.dir, 'replacement'), h.file);
  const replaced = await h.owner.probe(h.scope); assert.notEqual(replaced.token, first.token);
  await fs.writeFile(h.file, 'CCCC\n'); await fs.utimes(h.file, old.atime, old.mtime);
  assert.notEqual((await h.owner.probe(h.scope)).token, replaced.token);
});

test('new bytes during a read do not acquire the later version as applied coverage', async t => {
  const h = await fixture(t); await h.cover();
  const ticket = await h.owner.beginRead(h.scope), sources = await h.sources();
  const dirty = h.owner.invalidate('T'); await fs.appendFile(h.file, 'later\n');
  const reply = await h.owner.completeRead(h.scope, { success: true, freshnessReadSources: sources }, ticket);
  assert.equal(reply.state, 'unknown'); assert.equal(reply.token, null);
  assert.ok(reply.sequence > dirty.sequence);
  assert.equal((await h.cover()).state, 'known');
});

test('a newer event cannot be cleared by the older page arriving later; epochs never share ordering', async t => {
  const h = await fixture(t); const oldReply = await h.cover();
  const newer = h.owner.invalidate('T');
  // Native conformance rule: publish rows, but adopt as current only if this
  // exact epoch/source version covers the newest known head/dirty observation.
  const mayClear = (reply, head) => reply.state === 'known' && reply.epoch === head.epoch
    && (head.state === 'known' ? reply.token === head.token : reply.sequence >= head.sequence);
  assert.equal(mayClear(oldReply, newer), false);
  assert.equal(mayClear(oldReply, h.create('epoch-2').envelope(h.scope, 'unknown')), false);
  assert.equal((await h.create('epoch-2').probe(h.scope)).state, 'unknown');
});

test('foreign SQLite timing and joined duration changes invalidate only relevant scope', async t => {
  const h = await fixture(t), conn = new SQLite(h.db.db.name);
  t.after(() => conn.close());
  conn.exec("INSERT INTO agent_activity_intervals(id,tab_id,engine,session_id,start_ts,end_ts,duration_ms) VALUES(1,'T','codex','S',1,2,1)");
  conn.exec("INSERT INTO history_response_timings(interval_id,tool_type,tab_id,session_id,entry_uuid) VALUES(1,'codex','T','S','A')");
  conn.exec("INSERT INTO history_response_timing_aliases(interval_id,tool_type,session_id,entry_uuid) VALUES(1,'codex','CHILD','C')");
  const first = await h.cover(), before = h.db.getHistoryResponseTimingRevision('codex', 'CHILD');
  conn.exec('UPDATE agent_activity_intervals SET duration_ms=3000 WHERE id=1');
  assert.notEqual((await h.owner.probe(h.scope)).token, first.token);
  assert.notEqual(h.db.getHistoryResponseTimingRevision('codex', 'CHILD'), before);
  const current = await h.owner.probe(h.scope);
  conn.exec('UPDATE history_response_timings SET entry_uuid=entry_uuid');
  conn.exec('UPDATE history_response_timing_aliases SET entry_uuid=entry_uuid');
  conn.exec('UPDATE agent_activity_intervals SET duration_ms=duration_ms');
  assert.equal((await h.owner.probe(h.scope)).token, current.token, 'no-op sidecar writes do not dirty a page');
  conn.exec("INSERT INTO agent_activity_intervals(id,tab_id,engine,session_id,start_ts,end_ts,duration_ms) VALUES(2,'OTHER','codex','OTHER',1,2,1)");
  conn.exec("INSERT INTO history_response_timings(interval_id,tool_type,tab_id,session_id,entry_uuid) VALUES(2,'codex','OTHER','OTHER','B')");
  assert.equal((await h.owner.probe(h.scope)).token, current.token);
});

test('topology change revokes the dependency certificate, not only a watcher counter', async t => {
  const h = await fixture(t); await h.cover();
  h.db.db.exec("INSERT INTO session_links(parent_session_id,child_session_id) VALUES('P','S')");
  const changed = await h.owner.probe(h.scope);
  assert.equal(changed.state, 'unknown'); assert.equal(changed.reason, 'source-topology-changed');
});

test('a missing source is unknown, never empty/fresh; runtime ownership is part of the metadata', async t => {
  const h = await fixture(t); const first = await h.cover();
  h.setRuntime('runtime-2'); assert.notEqual((await h.owner.probe(h.scope)).token, first.token);
  await fs.unlink(h.file);
  assert.equal((await h.owner.probe(h.scope)).reason, 'source-missing');
});

test('opaque window validator salts new receipts with their actual covered freshness', () => {
  const { PublicHistoryRevisions } = require('./public-history-read');
  const owner = new PublicHistoryRevisions(); const scope = { tabId: 'T', bounds: { last: 80 } };
  const revision = { token: 'same-internal-validator' };
  const a = owner.remember(revision, scope, { state: 'known', token: 'version-a' });
  const b = owner.remember(revision, scope, { state: 'known', token: 'version-b' });
  assert.notEqual(a, b);
  assert.equal(owner.lookupFreshness(a, scope).token, 'version-a');
  assert.equal(owner.lookupFreshness(a, { ...scope, bounds: { aroundUuid: 'U', radius: 10 } }), null);
});

test('a bounded probe times out visibly and shares the same in-flight observation', async t => {
  const h = await fixture(t); await h.cover();
  const readContext = h.owner.readContext;
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  h.owner.readContext = async (...args) => { calls++; entered(); await waiting; return readContext(...args); };
  const one = h.owner.probe(h.scope, 20); await started;
  const two = h.owner.probe(h.scope, 20);
  const [a,b] = await Promise.all([one,two]);
  assert.equal(a.reason, 'probe-budget-exceeded'); assert.equal(b.token, null); assert.equal(calls, 1);
  release(); await Promise.all(h.owner.probes.values());
  assert.equal(h.owner.probes.size, 0);
  assert.equal((await h.owner.probe(h.scope)).state, 'known');
});

test('SQLite close/reopen retains sidecar versions but cannot recycle the public epoch', async t => {
  const h = await fixture(t); const first = await h.cover();
  h.db.db.prepare(`INSERT INTO history_prompt_presentations(tool_type,session_id,audit_timestamp,transport_hash,chips_json)
    VALUES('codex','S','fixture','exact','[]')`).run();
  const version = h.db.getHistoryFreshnessMetadata(h.scope);
  const changed = await h.owner.probe(h.scope); assert.notEqual(changed.token, first.token);
  const file = h.db.db.name, reopened = new DatabaseManager({ existingConnection: new SQLite(file) });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getHistoryFreshnessMetadata(h.scope), version);
  const newOwner = new HistoryFreshness({ readContext: scope => ({ metadata: reopened.getHistoryFreshnessMetadata(scope) }) });
  assert.notEqual(newOwner.epoch, first.epoch); assert.equal((await newOwner.probe(h.scope)).state, 'unknown');
});
