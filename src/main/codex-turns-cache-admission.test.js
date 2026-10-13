'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexTurnsCacheAdmission } = require('./codex-turns-cache-admission');
const { CodexReadFence } = require('./codex-read-fence');
const { CodexSourceGenerations } = require('./codex-source-generations');
const { HistoryReadClient } = require('./history-read-client');
const { SessionTranscriptService } = require('./session-transcript-service');

// The helper's unit adapter substitutes the API transport, not the stat/fence/
// generation algorithms. Main integration tests separately use actual codex-data.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-turns-helper-'));
  const file = path.join(root, 'S.jsonl'); fs.writeFileSync(file, 'private\n');
  const fence = new CodexReadFence(), generations = new CodexSourceGenerations();
  const client = new HistoryReadClient({});
  const service = new SessionTranscriptService({ sessionHistoryStore: { getSessionHistoryEvents: () => [] } });
  service.historyReader = client;
  const snapshot = stat => ({ filePath: file, sessionId: 'S', fileIdentity: stat.dev + ':' + stat.ino,
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    sourceGeneration: generations.observe(file, stat, 'S').generation });
  const source = snapshot(fs.statSync(file));
  const api = {
    findCodexSessionFile: async () => ({ filePath: file }),
    isCodexSourceSnapshotCurrent: value => generations.get(value.filePath)?.generation === value.sourceGeneration,
    beginCodexSourceRead: async () => ({ ticket: fence.begin(file, 'composite'), snapshot: snapshot(await fs.promises.stat(file)) }),
    assertCodexSourceReadCurrent: read => { fence.assertCurrent(read.ticket);
      if (!api.isCodexSourceSnapshotCurrent(read.snapshot)) throw Object.assign(Error('invalidated'), { code: 'CODEX_SOURCE_READ_INVALIDATED' }); },
    assertCodexSourceRead: async read => { await fs.promises.stat(file); api.assertCodexSourceReadCurrent(read); },
    finishCodexSourceRead: read => fence.finish(read.ticket),
  };
  const admission = new CodexTurnsCacheAdmission(api, service);
  t.after(async () => { await client.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { file, root, fence, generations, client, service, api, admission, source,
    capture: (loaded = { filePath: file, sourceSnapshot: source }) => admission.captureSource(loaded, 'S', root, admission.captureLineage('S', root)) };
}

test('certificate copies the records source witness and binds graph identity, exact SID and cwd', t => {
  const f = fixture(t), proof = f.capture(), graph = {};
  assert.ok(Object.isFrozen(proof.snapshot)); const size = proof.snapshot.size;
  f.source.size = 999; assert.equal(proof.snapshot.size, size, 'returned snapshot mutation cannot stamp a different graph source');
  f.admission.remember(graph, proof);
  assert.equal(f.admission.get(graph, 'S', f.root), proof);
  assert.equal(f.admission.get({ ...graph }, 'S', f.root), null);
  assert.equal(f.admission.get(graph, 'other', f.root), null);
  assert.equal(f.admission.get(graph, 'S', f.root + '/other'), null);
  assert.deepEqual(Object.keys(graph), [], 'internal evidence never becomes a DTO field');
});

for (const field of ['sourceGeneration', 'fileIdentity', 'ctimeMs', 'mtimeMs', 'size', 'sessionId', 'filePath']) {
  test(`missing records provenance ${field} is not manufactured from a later stat`, t => {
    const f = fixture(t), sourceSnapshot = { ...f.source }; delete sourceSnapshot[field];
    assert.equal(f.capture({ filePath: f.file, sourceSnapshot }), null);
  });
}

test('optional methods are checked before a certificate is granted or looked up', t => {
  const f = fixture(t), proof = f.capture(), graph = {};
  f.admission.remember(graph, proof); f.api.assertCodexSourceReadCurrent = null;
  assert.equal(f.admission.captureLineage('S', f.root), null);
  assert.equal(f.capture(), null); assert.equal(f.admission.get(graph, 'S', f.root), null);
});

test('failed/unknown admission finishes its actual source ticket and retains no active reader', async t => {
  const f = fixture(t), proof = f.capture();
  const begin = f.api.beginCodexSourceRead;
  f.api.beginCodexSourceRead = async () => { const read = await begin(); read.snapshot.sourceGeneration = 'unknown'; return read; };
  await assert.rejects(f.admission.open(proof), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.equal(f.fence.active.size, 0);
  f.api.beginCodexSourceRead = async () => { const read = await begin(); read.snapshot.ctimeMs = undefined; return read; };
  assert.equal(await f.admission.open(proof), null); assert.equal(f.fence.active.size, 0);
});

test('logical read proof uses the existing exact-owner journal, reader identity and bounded overflow', async t => {
  const f = fixture(t), proof = f.client.captureCodexLineageReadProof('S');
  f.client.lineageCommitted('unrelated'); assert.ok(f.client.isCodexLineageReadProofCurrent(proof, 'S'));
  f.client.lineageCommitted('S'); assert.equal(f.client.isCodexLineageReadProofCurrent(proof, 'S'), false);
  const recent = f.client.captureCodexLineageReadProof('S');
  assert.equal(f.client.isCodexLineageReadProofCurrent(recent, 'other'), false);
  assert.equal(f.client.isCodexLineageReadProofCurrent({ ...recent, clientId: 'foreign-reader' }, 'S'), false);
  // Bounded journal rollover means unknown proof, hence canonical fallback;
  // it does not manufacture "unchanged owner" from the latest sequence.
  const log = console.log; console.log = () => {};
  try { for (let i = 0; i < 2049; i++) f.client.lineageCommitted('unrelated-' + i); }
  finally { console.log = log; }
  assert.equal(f.client.invalidations.length, 2048);
  assert.equal(f.client.isCodexLineageReadProofCurrent(recent, 'S'), false);
});

test('logical capture/check rejects reentrant commits during lineage lookup', t => {
  const f = fixture(t), proof = f.admission.captureLineage('S', f.root);
  let once = true;
  f.service.sessionHistoryStore.getSessionHistoryEvents = () => {
    if (once) { once = false; f.client.lineageCommitted('S'); } return [];
  };
  assert.equal(f.service.isCodexTurnsLineageProofCurrent(proof, 'S', f.root), false);
  once = true; assert.equal(f.admission.captureLineage('S', f.root), null);
});

test('same-key legacy event mutation revokes lineage without a byte rewrite', t => {
  const f = fixture(t);
  const event = { eventType: 'fork', provider: 'codex', childSessionId: 'S', sourceSessionId: 'parent',
    eventKey: 'private-fork', snapshotComplete: true, entryUuids: ['old'] };
  f.service.sessionHistoryStore.getSessionHistoryEvents = () => [event];
  const proof = f.admission.captureLineage('S', f.root); assert.ok(proof);
  event.entryUuids[0] = 'new';
  assert.equal(f.service.isCodexTurnsLineageProofCurrent(proof, 'S', f.root), false);
});

test('interim journal guard is cheap and does not become full lineage authority', t => {
  const f = fixture(t);
  const event = { eventType: 'fork', provider: 'codex', childSessionId: 'S', sourceSessionId: 'parent',
    eventKey: 'private-fork', entryUuids: ['old'] };
  let reads = 0;
  f.service.sessionHistoryStore.getSessionHistoryEvents = () => { reads++; return [event]; };
  const proof = f.admission.captureLineage('S', f.root); reads = 0;
  event.entryUuids[0] = 'new';
  assert.equal(f.service.isCodexTurnsLineageProofAdmitted(proof, 'S', f.root), true);
  assert.equal(reads, 0);
  assert.equal(f.service.isCodexTurnsLineageProofCurrent(proof, 'S', f.root), false);
  f.client.lineageCommitted('S');
  assert.equal(f.service.isCodexTurnsLineageProofAdmitted(proof, 'S', f.root), false);
});

test('older optional proof services keep full interim validation', t => {
  const f = fixture(t), proof = f.capture(); let reads = 0;
  f.service.isCodexTurnsLineageProofAdmitted = undefined;
  const full = f.service.isCodexTurnsLineageProofCurrent;
  f.service.isCodexTurnsLineageProofCurrent = function () { reads++; return true; };
  assert.doesNotThrow(() => f.admission.assertOwner(proof)); assert.equal(reads, 1);
  f.service.isCodexTurnsLineageProofCurrent = full;
});
