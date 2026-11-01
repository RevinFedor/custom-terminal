'use strict';
// Own finite fixtures only. No application, production profile or provider.
process.env.NOTED_HISTORY_READER_PROCESS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { materializeStandalone } = require('./prepare-mini-ready-dev.cjs');
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const id = '6e7d60b9-e17d-4815-84b7-da6a84d07ef1', parent = 'a6c39b4f-5506-40a4-ad3e-3d7c546fe797';
const line = value => JSON.stringify(value) + '\n';
function source(cwd) {
  return Buffer.from(line({ type: 'session_meta', payload: { id, session_id: id, cwd, forked_from_id: parent, history_mode: 'legacy' } })
    + line({ type: 'event_msg', timestamp: '2026-10-30T00:00:00Z', payload: { type: 'user_message', message: 'actual question' } })
    + line({ type: 'response_item', timestamp: '2026-10-30T00:00:01Z', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'actual answer' }] } }));
}
function metadata(bytes) {
  return { sessionId: id, sessionFile: 'owned-source', completed: true, historicalCopiedCompleted: true,
    sourceProof: { sourceArchiveSessionId: parent }, copyProof: { bytes: bytes.length, sha256: digest(bytes), recordCount: 3,
      standaloneHistoryMode: 'legacy', originalNativeTurnAndMessageIdsPreserved: true } };
}

test('only proven completed materialized files change header and preserve body exactly', () => {
  const bytes = source('/owned'), c = metadata(bytes), proof = { sha256: digest(bytes) };
  const { bytes: copy, audit } = materializeStandalone(bytes, c, proof);
  const before = bytes.indexOf(10), after = copy.indexOf(10);
  assert.deepEqual(copy.subarray(after + 1), bytes.subarray(before + 1));
  assert.equal(JSON.parse(copy.subarray(0, after)).payload.forked_from_id, undefined);
  assert.equal(JSON.parse(bytes.subarray(0, before)).payload.forked_from_id, parent, 'source not edited');
  assert.equal(audit.sourceSha256, digest(bytes)); assert.equal(audit.outputSha256, digest(copy));
  assert.equal(audit.unchangedBodySha256, digest(bytes.subarray(before + 1)));
  assert.equal(audit.providerForkParent, parent);
  assert.throws(() => materializeStandalone(bytes, { ...c, copyProof: { ...c.copyProof, recordCount: 2 } }, proof), /unproven/);
  assert.throws(() => materializeStandalone(bytes, { ...c, sourceProof: { sourceArchiveSessionId: 'wrong' } }, proof), /unproven/);
  assert.throws(() => materializeStandalone(bytes, c, { sha256: 'wrong' }), /hash_mismatch/);
});

test('continuation requires the exact completed prefix and its original materialized parent', () => {
  const bytes = source('/owned'), proof = { sha256: digest(bytes) };
  const initialBytes = bytes.indexOf(10, bytes.indexOf(10) + 1) + 1;
  const parentHash = digest('materialized-parent');
  const c = { sessionId: id, sessionFile: 'owned-continuation', completed: true, initialBytes,
    initialSHA256: digest(bytes.subarray(0, initialBytes)), sourceA: { sessionId: parent, sha256: parentHash },
    sourceProof: { historicalCopiedCompleted: true, actualCorrectionGenerated: true, originalArchiveA: { sha256: parentHash } } };
  const result = materializeStandalone(bytes, c, proof);
  assert.equal(result.audit.proofKind, 'completed-correction-prefix');
  assert.throws(() => materializeStandalone(bytes, { ...c, initialSHA256: 'wrong' }, proof), /unproven/);
  assert.throws(() => materializeStandalone(bytes, { ...c, sourceA: { ...c.sourceA, sessionId: 'wrong' } }, proof), /unproven/);
  assert.throws(() => materializeStandalone(bytes, { ...c, initialBytes: initialBytes - 1 }, proof), /unproven/);
});

class SQLite {
  constructor(file, options = {}) { this.name = file; this.native = new DatabaseSync(file, { readOnly: options.readonly === true }); this.depth = 0; }
  get inTransaction() { return this.native.isTransaction; }
  exec(sql) { return this.native.exec(sql); }
  prepare(sql) {
    const s = this.native.prepare(sql), convert = row => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v) : v]));
    return { get: (...args) => convert(s.get(...args)), all: (...args) => s.all(...args).map(convert), run: (...args) => s.run(...args),
      *iterate(...args) { for (const row of s.iterate(...args)) yield convert(row); } };
  }
  pragma(sql, options = {}) { const rows = this.prepare('PRAGMA ' + sql).all(); return options.simple ? Object.values(rows[0])[0] : rows; }
  transaction(fn) { return (...args) => { if (this.depth) return fn(...args); this.native.exec('BEGIN'); this.depth++;
    try { const result = fn(...args); this.native.exec('COMMIT'); return result; }
    catch (error) { this.native.exec('ROLLBACK'); throw error; } finally { this.depth--; } }; }
  close() { this.native.close(); }
}
const load = Module._load;
Module._load = function(name, parentModule, main) { return name === 'better-sqlite3' ? SQLite : load.call(this, name, parentModule, main); };
const Manager = require('../src/main/history-root-engine/main/database');
const { SessionTranscriptService } = require('../src/main/history-root-engine/main/session-transcript-service');
const api = require('../src/main/history-root-engine/main/ipc/codex-data')._api;
const { HistoryPagedStore } = require('../src/main/history-root-engine/main/history-paged-store');
const { readCodexRootPhysicalScope } = require('../src/main/history-root-engine/main/codex-root-physical-scope');
const { deriveCodexForkSnapshot } = require('../src/main/history-root-engine/main/session-history-events');

async function checkTimelineAndPhysicalRoot(t, standalone, actualCase = null, rootOnly = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-owned-root-'));
  const file = path.join(dir, 'rollout-' + id + '.jsonl');
  const db = new SQLite(path.join(dir, 'events.sqlite')), manager = new Manager({ existingConnection: db }); manager.initTables();
  const store = new HistoryPagedStore({ filename: path.join(dir, 'pages.sqlite'), Database: SQLite, diskBytes: 16 * 1024 * 1024 });
  const realApi = { ...api,
    findCodexSessionFile: (sid, cwd, options) => api.findCodexSessionFile(sid, cwd, { ...options, sessionsDir: dir }),
    loadSessionRecords: (sid, cwd, options) => api.loadSessionRecords(sid, cwd, { ...options, sessionsDir: dir }),
    projectCodexTimelineFromFile: (sid, cwd, options) => api.projectCodexTimelineFromFile(sid, cwd, { ...options, sessionsDir: dir }) };
  const service = new SessionTranscriptService({ codexData: { _api: realApi }, sessionHistoryStore: manager });
  t.after(() => { api.invalidateJsonlCache(file); store.close(); db.close(); fs.rmSync(dir, { recursive: true }); });
  const original = actualCase ? fs.readFileSync(actualCase.c.sessionFile) : source(dir);
  const c = actualCase ? actualCase.c : metadata(original);
  const proof = actualCase ? actualCase.proof : { sha256: digest(original) };
  fs.writeFileSync(file, standalone ? materializeStandalone(original, c, proof).bytes : original);
  for (let pass = 0; pass < 2; pass++) {
    const timeline = rootOnly ? null : await service.getTimeline({ toolType: 'codex', sessionId: id, cwd: dir });
    if (pass === 0 && timeline) assert.equal(timeline.success, true);
    if (actualCase && timeline?.success) assert.equal(timeline.entries.filter(entry => entry.uuid === proof.user.id).length, 1);
    const scope = await readCodexRootPhysicalScope({ store, manager, api: realApi, sessionId: id, cwd: dir, sourceOptions: { sessionsDir: dir } });
    if (standalone) { if (timeline) assert.equal(timeline.success, true); assert.equal(scope.success, true, scope.reason); assert.equal(scope.requiredRecovery, false); scope.release(); }
    else { assert.equal(scope.success, false); assert.equal(scope.reason, 'provider-history-base-absent'); assert.equal(scope.requiredRecovery, true); }
  }
  const forks = manager.getSessionHistoryEvents(id).filter(e => e.eventType === 'fork');
  assert.equal(forks.length, standalone ? 0 : 1);
}

test('actual Timeline creates an unresolved fork for the old header', async t => {
  await checkTimelineAndPhysicalRoot(t, false);
});
test('actual Timeline then physical root read repeatedly accepts the standalone copy', async t => {
  await checkTimelineAndPhysicalRoot(t, true);
});
test('actual archived header produces no fork event and its physical root opens twice', async t => {
  const root = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay');
  const caseFile = path.join(root, 'logs-original-first-20261031/CASE.json');
  const proofFile = path.join(root, 'reviews-logs-first-scope-rule-20261031/NATIVE-PROOF.json');
  if (!fs.existsSync(caseFile) || !fs.existsSync(proofFile)) return t.skip('local owned case unavailable');
  const c = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
  if (!fs.existsSync(c.sessionFile)) return t.skip('local owned rollout unavailable');
  const original = fs.readFileSync(c.sessionFile), proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  const standalone = materializeStandalone(original, c, proof).bytes;
  const before = JSON.parse(original.subarray(0, original.indexOf(10))).payload;
  const after = JSON.parse(standalone.subarray(0, standalone.indexOf(10))).payload;
  assert.ok(deriveCodexForkSnapshot([], before));
  assert.equal(deriveCodexForkSnapshot([], after), null);
  await checkTimelineAndPhysicalRoot(t, true, { c, proof }, true);
});
test('actual archived case: exact question survives repeated Timeline and physical root reads', async t => {
  if (process.env.NOTED_MINI_SLOW_ROOT_EVIDENCE !== '1') return t.skip('explicit opt-in: actual full archived Timeline projection is expensive');
  const root = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay');
  const caseFile = path.join(root, 'logs-original-first-20261031/CASE.json');
  const proofFile = path.join(root, 'reviews-logs-first-scope-rule-20261031/NATIVE-PROOF.json');
  if (!fs.existsSync(caseFile) || !fs.existsSync(proofFile)) return t.skip('local owned case unavailable');
  const c = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
  if (!fs.existsSync(c.sessionFile)) return t.skip('local owned rollout unavailable');
  assert.equal(c.sessionId, id);
  await checkTimelineAndPhysicalRoot(t, true, { c, proof: JSON.parse(fs.readFileSync(proofFile, 'utf8')) });
});
