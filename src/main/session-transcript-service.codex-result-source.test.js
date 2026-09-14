'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SessionTranscriptService } = require('./session-transcript-service');
const { buildCodexForkLineageManifest } = require('./session-history-events');
const { hashFileSegment } = require('./codex-virtual-transcript');
const { createCodexResultSourceResolver } = require('./codex-result-source');
const { createCodexResultReader } = require('./codex-result-reader');
const { _api: codexApi } = require('./ipc/codex-data');

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonl = (records) => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const user = (text) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } });

async function fixture(t, maxVerifiedSegments) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-result-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new Map();
  const events = new Map();
  const calls = { hashes: [], metadata: 0, heavy: 0, commits: 0 };
  const unexpectedRead = () => { calls.heavy += 1; throw new Error('unexpected full/projection read'); };
  const codexApi = {
    findCodexSessionFile: async (id) => files.has(id) ? { filePath: files.get(id).filePath } : null,
    readCodexSessionMetadata: async (filePath) => {
      calls.metadata += 1;
      return { meta: [...files.values()].find(file => file.filePath === filePath)?.meta || null };
    },
    loadSessionRecords: unexpectedRead,
    readJsonlRange: unexpectedRead,
    buildCodexTimeline: unexpectedRead,
    createCodexTimelineProjector: unexpectedRead,
    createCodexHistoryProjector: unexpectedRead,
    projectCodexTimelineFromFile: unexpectedRead,
    projectCodexFullHistoryFromFile: unexpectedRead,
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    codexData: { _api: codexApi },
    sessionHistoryStore: {
      getSessionHistoryEvents: (id) => events.get(id) || [],
      saveSessionForkEvent: (event) => {
        const saved = { ...event, eventType: 'fork', sessionId: event.childSessionId,
          eventKey: `fork:codex:${event.sourceSessionId}:${event.childSessionId}` };
        events.set(event.childSessionId, [saved]);
        calls.commits += 1;
        return saved;
      },
    },
  });
  service._projectCodexVirtual = unexpectedRead;
  service.captureCodexForkSourceSnapshot = unexpectedRead;
  const f = { root, service, files, events, calls, hashSegment: hashFileSegment };
  service.codexResultSourceResolver = createCodexResultSourceResolver({
    codexApi,
    maxVerifiedSegments,
    hashSegment: async (...args) => {
      calls.hashes.push(args);
      return f.hashSegment(...args);
    },
  });
  f.addFile = async (id, records = [], extraMeta = {}) => {
    const meta = { id, cwd: root, ...extraMeta };
    const header = Buffer.from(jsonl([{ type: 'session_meta', payload: meta }]));
    const bytes = Buffer.concat([header, Buffer.from(records.length ? jsonl(records) : '')]);
    const file = { id, filePath: path.join(root, id + '.jsonl'), header, bytes, meta,
      lineCount: records.length + 1 };
    await fs.writeFile(file.filePath, bytes);
    files.set(id, file);
    return file;
  };
  f.resolve = (id) => service.resolveCodexResultSource({ sessionId: id, cwd: root });
  return f;
}

function frozen(file, fromByte = 0, startLine = 0) {
  return { physicalSessionId: file.id, fromByte, toByte: file.bytes.length,
    startLine, endLine: file.lineCount, prefixDigest: digest(file.bytes.subarray(fromByte)) };
}

function forkEvent(child, sources, eventKey = 'fixture-fork') {
  const sourceSessionId = sources.at(-1).physicalSessionId;
  const manifest = buildCodexForkLineageManifest({
    sourceSessionId,
    childSessionId: child.id,
    sourceSegments: sources,
    childTailStart: { byteOffset: child.header.length, line: 1, prefixDigest: digest(child.header) },
  });
  assert.ok(manifest);
  return { eventKey, eventType: 'fork', provider: 'codex', sessionId: child.id,
    sourceSessionId, childSessionId: child.id, snapshotComplete: true,
    isDirect: true, origin: 'app', lineageManifest: manifest };
}

async function virtualFixture(t, maxVerifiedSegments) {
  const f = await fixture(t, maxVerifiedSegments);
  f.parent = await f.addFile('parent', [user('frozen')]);
  f.child = await f.addFile('child', [user('live')], { forked_from_id: f.parent.id });
  f.event = forkEvent(f.child, [frozen(f.parent)]);
  f.events.set(f.child.id, [f.event]);
  return f;
}

test('physical descriptors stat the file without a generic read, projection or digest', async t => {
  const f = await fixture(t);
  f.service.codexResultSourceResolver = null; // Exercise the service's lazy production wiring.
  const file = await f.addFile('physical', [user('hello')]);
  // A partial provider record belongs to the reader's carry buffer, not a
  // reason for source resolution to fail or try a whole-file projection.
  await fs.appendFile(file.filePath, Buffer.from([0x7b, 0x22, 0xd0]));
  const result = await f.resolve(file.id);
  assert.equal(result.success, true, result.lineageReason);
  assert.equal(result.kind, 'physical');
  assert.equal(result.viewOwnerSessionId, file.id);
  assert.equal(result.manifestDigest, null);
  assert.equal(result.childPrefix, null);
  assert.equal(result.segments.length, 1);
  assert.deepEqual(result.segments[0], {
    segmentId: 'physical-' + file.id,
    filePath: file.filePath,
    physicalSessionId: file.id,
    fromByte: 0,
    toByte: file.bytes.length + 3,
    startLine: 0,
    endLine: null,
    frozen: false,
    sourceSnapshot: result.sourceSnapshot,
  });
  const stat = await fs.stat(file.filePath);
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
    assert.equal(result.sourceSnapshot[field], stat[field]);
  }
  assert.equal(result.sourceSnapshot.sessionId, file.id);
  assert.equal(result.sourceSnapshot.fileIdentity, stat.dev + ':' + stat.ino);
  assert.equal(f.calls.hashes.length, 0);
  assert.equal(f.calls.metadata, 1);
  assert.equal(f.calls.heavy, 0);
  assert.equal('records' in result, false);
});

test('physical append, replacement and empty files keep topology separate from file snapshots', async t => {
  const f = await fixture(t);
  const file = await f.addFile('physical', [user('before')]);
  const before = await f.resolve(file.id);
  await fs.appendFile(file.filePath, jsonl([user('after')]));
  const appended = await f.resolve(file.id);
  assert.equal(appended.revisionKey, before.revisionKey);
  assert.ok(appended.sourceSnapshot.size > before.sourceSnapshot.size);
  const replacement = path.join(f.root, 'replacement.tmp');
  await fs.writeFile(replacement, file.bytes);
  await fs.rename(replacement, file.filePath);
  const replaced = await f.resolve(file.id);
  assert.equal(replaced.success, true);
  assert.equal(replaced.revisionKey, before.revisionKey);
  assert.notEqual(replaced.sourceSnapshot.ino, before.sourceSnapshot.ino);
  await fs.writeFile(file.filePath, '');
  const empty = await f.resolve(file.id);
  assert.equal(empty.success, true);
  assert.equal(empty.segments[0].toByte, 0);
  assert.equal(f.calls.heavy, 0);
  assert.equal(f.calls.hashes.length, 0);
});

test('virtual descriptor preserves frozen cuts, child prefix and every physical coordinate', async t => {
  const f = await virtualFixture(t);
  const result = await f.resolve(f.child.id);
  assert.equal(result.success, true, result.lineageReason);
  assert.equal(result.kind, 'virtual');
  assert.equal(result.viewOwnerSessionId, f.child.id);
  assert.equal(result.eventKey, f.event.eventKey);
  assert.equal(result.manifestDigest, f.event.lineageManifest.manifestDigest);
  const [source, child] = result.segments;
  assert.deepEqual({ fromByte: source.fromByte, toByte: source.toByte,
    startLine: source.startLine, endLine: source.endLine, frozen: source.frozen,
    physicalSessionId: source.physicalSessionId, digest: source.digest }, {
    fromByte: 0, toByte: f.parent.bytes.length, startLine: 0, endLine: f.parent.lineCount,
    frozen: true, physicalSessionId: f.parent.id, digest: digest(f.parent.bytes),
  });
  assert.equal(child.fromByte, f.child.header.length);
  assert.equal(child.startLine, 1);
  assert.equal(child.endLine, null);
  assert.equal(child.toByte, f.child.bytes.length);
  assert.equal(child.physicalSessionId, f.child.id);
  assert.equal(child.segmentId, 'tail-' + result.manifestDigest.slice(0, 24));
  assert.deepEqual(result.childPrefix, { fromByte: 0, toByte: f.child.header.length,
    startLine: 0, endLine: 1, digest: digest(f.child.header) });
  assert.equal(f.calls.hashes.length, 2);
  assert.equal(f.calls.metadata, 0, 'persisted lineage does not inspect provider payloads');
  assert.equal(f.calls.heavy, 0);
});

test('warm signatures skip hashing; ancestor append never expands the frozen view', async t => {
  const f = await virtualFixture(t);
  const first = await f.resolve(f.child.id);
  const second = await f.resolve(f.child.id);
  assert.deepEqual(second, first);
  assert.equal(f.calls.hashes.length, 2);
  // Caller mutations cannot poison the cached signature or the next ranges.
  first.segments[0].toByte = -1;
  first.sourceSnapshot.size = -1;
  await fs.appendFile(f.child.filePath, jsonl([user('child append')]));
  const childGrew = await f.resolve(f.child.id);
  assert.equal(childGrew.success, true);
  assert.equal(childGrew.revisionKey, second.revisionKey);
  assert.equal(f.calls.hashes.length, 3, 'only the changed child prefix is reverified');
  assert.equal(childGrew.segments[0].toByte, f.parent.bytes.length);
  assert.ok(childGrew.sourceSnapshot.size > second.sourceSnapshot.size);
  await fs.appendFile(f.parent.filePath, jsonl([user('future parent turn')]));
  const sourceGrew = await f.resolve(f.child.id);
  assert.equal(sourceGrew.success, true);
  assert.equal(sourceGrew.revisionKey, second.revisionKey);
  assert.equal(sourceGrew.segments[0].toByte, f.parent.bytes.length);
  assert.ok(sourceGrew.segments[0].sourceSnapshot.size > sourceGrew.segments[0].toByte);
  assert.equal(f.calls.hashes.length, 4);
});

test('multi-hop descriptors retain nonzero source offsets and distinguish manifest and event changes', async t => {
  const f = await virtualFixture(t);
  const grand = await f.addFile('grand', [], { forked_from_id: f.child.id });
  const event = forkEvent(grand, [frozen(f.parent), frozen(f.child, f.child.header.length, 1)]);
  f.events.set(grand.id, [event]);
  const first = await f.resolve(grand.id);
  assert.equal(first.success, true, first.lineageReason);
  assert.deepEqual(first.segments.map(s => [s.physicalSessionId, s.fromByte, s.startLine, s.frozen]), [
    [f.parent.id, 0, 0, true], [f.child.id, f.child.header.length, 1, true],
    [grand.id, grand.header.length, 1, false],
  ]);
  f.events.set(grand.id, [{ ...event, eventKey: 'different-event' }]);
  const changedEvent = await f.resolve(grand.id);
  assert.notEqual(changedEvent.revisionKey, first.revisionKey);
  const changedManifest = forkEvent(grand, [frozen(f.parent), frozen(f.child)], 'different-event');
  f.events.set(grand.id, [changedManifest]);
  const changed = await f.resolve(grand.id);
  assert.equal(changed.success, true);
  assert.notEqual(changed.revisionKey, changedEvent.revisionKey);
});

test('restoring size and mtime cannot conceal a frozen ancestor or child-prefix rewrite', async t => {
  for (const target of ['parent', 'child']) await t.test(target, async t => {
    const f = await virtualFixture(t);
    const file = f[target];
    const fixedTime = new Date('2026-09-01T12:00:00Z');
    await fs.utimes(file.filePath, fixedTime, fixedTime);
    assert.equal((await f.resolve(f.child.id)).success, true);
    const before = await fs.stat(file.filePath);
    const changed = Buffer.from(file.bytes);
    changed[0] = 0x5b;
    await fs.writeFile(file.filePath, changed);
    await fs.utimes(file.filePath, fixedTime, fixedTime);
    const after = await fs.stat(file.filePath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.notEqual(after.ctimeMs, before.ctimeMs);
    const rejected = await f.resolve(f.child.id);
    assert.equal(rejected.success, false);
    assert.equal(rejected.lineageReason, target === 'parent'
      ? 'source-segment-digest-mismatch' : 'child-prefix-digest-mismatch');
    await fs.writeFile(file.filePath, file.bytes);
    await fs.utimes(file.filePath, fixedTime, fixedTime);
    assert.equal((await f.resolve(f.child.id)).success, true, 'failed verification is not cached');
  });
});

test('same-size same-mtime inode replacement revalidates even identical bytes', async t => {
  const f = await virtualFixture(t);
  const fixedTime = new Date('2026-09-01T12:00:00Z');
  await fs.utimes(f.parent.filePath, fixedTime, fixedTime);
  const before = await f.resolve(f.child.id);
  const replacement = path.join(f.root, 'replacement.tmp');
  await fs.writeFile(replacement, f.parent.bytes);
  await fs.utimes(replacement, fixedTime, fixedTime);
  await fs.rename(replacement, f.parent.filePath);
  const after = await f.resolve(f.child.id);
  assert.equal(after.success, true);
  assert.equal(after.segments[0].sourceSnapshot.mtimeMs, before.segments[0].sourceSnapshot.mtimeMs);
  assert.notEqual(after.segments[0].sourceSnapshot.ino, before.segments[0].sourceSnapshot.ino);
  assert.equal(f.calls.hashes.length, 3);
});

test('a hash read racing a file change is retryable and cannot seed a verified signature', async t => {
  const f = await virtualFixture(t);
  let mutate = true;
  f.hashSegment = async (...args) => {
    const result = await hashFileSegment(...args);
    if (mutate && args[0] === f.parent.filePath) {
      mutate = false;
      await fs.appendFile(f.parent.filePath, jsonl([user('concurrent append')]));
    }
    return result;
  };
  const raced = await f.resolve(f.child.id);
  assert.deepEqual(raced, { success: false, error: 'lineage_unresolved',
    lineageReason: 'source-changed-during-verification', retryable: true });
  const retried = await f.resolve(f.child.id);
  assert.equal(retried.success, true);
  assert.equal(f.calls.hashes.filter(call => call[0] === f.parent.filePath).length, 2);
});

test('concurrent descriptors share verification and failed hash I/O is retried', { timeout: 5000 }, async t => {
  const f = await virtualFixture(t);
  let releaseHash;
  let hashGate = new Promise(resolve => { releaseHash = resolve; });
  let parentStats = 0;
  const statFile = fs.stat;
  t.mock.method(fs, 'stat', async (...args) => {
    const result = await statFile(...args);
    // Hold the first hash until both callers have resolved the same physical
    // snapshot. Merely yielding once in the hash depends on OS I/O timing and
    // can legitimately produce two sequential failed reads instead.
    if (args[0] === f.parent.filePath && ++parentStats === 2) setImmediate(releaseHash);
    return result;
  });
  let fail = true;
  f.hashSegment = async (...args) => {
    if (args[0] === f.parent.filePath) await hashGate;
    if (fail) throw new Error('fixture hash I/O failure');
    return hashFileSegment(...args);
  };
  const failures = await Promise.all([f.resolve(f.child.id), f.resolve(f.child.id)]);
  assert.equal(failures.every(result => result.success === false), true);
  assert.equal(f.calls.hashes.length, 1);
  fail = false;
  parentStats = 0;
  hashGate = new Promise(resolve => { releaseHash = resolve; });
  const successes = await Promise.all([f.resolve(f.child.id), f.resolve(f.child.id)]);
  assert.equal(successes.every(result => result.success === true), true);
  assert.deepEqual(successes[0], successes[1]);
  assert.equal(f.calls.hashes.length, 3);
});

test('verification cache eviction preserves correctness without retaining transcript payloads', async t => {
  const f = await virtualFixture(t, 1);
  const first = await f.resolve(f.child.id);
  assert.deepEqual(await f.resolve(f.child.id), first);
  assert.equal(f.calls.hashes.length, 4, 'the one-signature budget cannot hold both ranges');
});

test('missing/shrunk files and existing unresolved-lineage gates never fall back to projection', async t => {
  const f = await virtualFixture(t);
  assert.equal((await f.resolve('missing')).success, false);
  await fs.writeFile(f.parent.filePath, '');
  assert.equal((await f.resolve(f.child.id)).lineageReason, 'source-segment-shrunk');
  await fs.writeFile(f.parent.filePath, f.parent.bytes);
  await fs.writeFile(f.child.filePath, '');
  assert.equal((await f.resolve(f.child.id)).lineageReason, 'child-tail-shrunk-before-start');
  const invalid = await f.addFile('invalid', [], { history_mode: 'paginated',
    forked_from_id: f.parent.id,
    history_base: { thread_id: 'wrong-parent', end_byte_offset: 1, end_ordinal_exclusive: 1 } });
  assert.equal((await f.resolve(invalid.id)).lineageReason, 'provider-history-base-invalid');
  const other = await f.addFile('other', [user('other')]);
  f.events.set(f.child.id, [f.event, forkEvent(f.child, [frozen(other)], 'other-parent')]);
  assert.equal((await f.resolve(f.child.id)).lineageReason, 'multiple-exact-parent-events');
  assert.equal((await f.service.resolveCodexResultSource()).success, false);
  assert.equal(f.calls.heavy, 0);
});

test('existing provider recovery commits lineage once before the descriptor path', async t => {
  const f = await fixture(t);
  const parent = await f.addFile('parent', [user('retained')]);
  const child = await f.addFile('child', [], { forked_from_id: parent.id, history_mode: 'paginated',
    history_base: { thread_id: parent.id, end_byte_offset: parent.bytes.length, end_ordinal_exclusive: 2 } });
  let bootstraps = 0;
  f.service.captureCodexForkSourceSnapshot = async request => {
    bootstraps += 1;
    assert.equal(request.sessionId, parent.id);
    assert.equal(request.endByteOffset, parent.bytes.length);
    return { sourceSessionId: parent.id, sourceSegments: [frozen(parent)],
      entryUuids: ['codex-user-parent-1'], boundaryEntryUuid: 'codex-user-parent-1',
      nextIterationIndex: 1, capturedAt: Date.now(), snapshotComplete: true };
  };
  f.service.captureCodexForkChildTailStart = async () => ({ byteOffset: child.header.length,
    line: 1, prefixDigest: digest(child.header) });
  const first = await f.resolve(child.id);
  assert.equal(first.success, true, first.lineageReason);
  assert.equal(first.kind, 'virtual');
  assert.equal(f.calls.commits, 1);
  assert.equal(bootstraps, 1);
  assert.deepEqual(await f.resolve(child.id), first);
  assert.equal(bootstraps, 1);
  assert.equal(f.calls.heavy, 0);
});

test('a lineage change during verification cannot return the obsolete view', async t => {
  const f = await virtualFixture(t);
  f.hashSegment = async (...args) => {
    const result = await hashFileSegment(...args);
    f.events.set(f.child.id, [{ ...f.event, eventKey: 'new-event-during-hash' }]);
    return result;
  };
  const changed = await f.resolve(f.child.id);
  assert.deepEqual(changed, { success: false, error: 'lineage_unresolved',
    lineageReason: 'lineage-changed-during-source-resolution', retryable: true });
  const settled = await f.resolve(f.child.id);
  assert.equal(settled.success, true);
  assert.equal(settled.eventKey, 'new-event-during-hash');
});

// Descriptor -> production streaming reader integration. The batch oracle
// consumes the same frozen ranges with the same physical decorations, using
// the canonical public builder without the reader's coordinate/text hooks.
const providerEvent = (type, extra = {}) => ({ type: 'event_msg',
  timestamp: '2026-09-14T02:00:00Z', payload: { type, ...extra } });
const providerAssistant = (text, phase = 'final_answer') => ({ type: 'response_item',
  timestamp: '2026-09-14T02:00:01Z', payload: { type: 'message', role: 'assistant', phase,
    content: [{ type: 'output_text', text }] } });
const providerTurn = (turnId, prompt, answer, complete = true) => [
  providerEvent('task_started', { turn_id: turnId }),
  providerEvent('user_message', { message: prompt }),
  providerAssistant(answer, complete ? 'final_answer' : 'commentary'),
  ...(complete ? [providerEvent('task_complete', { turn_id: turnId, last_agent_message: answer })] : []),
];
const exactProof = (sessionId, turnId, physicalSessionId = sessionId, line = 2) => ({
  targetExecutionContext: { provider: 'codex', sessionId, turnId, generation: 3 },
  promptUserUuid: `codex-user-${physicalSessionId}-${line}`,
});
const resultWithoutSnapshot = ({ sourceSnapshot, ...result }) => result;

function integratedReader(f) {
  const reads = [];
  const reader = createCodexResultReader({
    readJsonlRange: async (filePath, fromByte, endByte, options = {}) => {
      reads.push({ filePath, fromByte, toByte: endByte + 1,
        collectRecords: options.collectRecords !== false });
      return codexApi.readJsonlRange(filePath, fromByte, endByte, options);
    },
    createTimelineProjector: codexApi.createCodexTimelineProjector,
    buildResult: codexApi.buildCodexProviderTurnAssistantResult,
    userIdentity: codexApi.getCodexUserRecordIdentity,
    isCompactPayload: codexApi.isCompactPayload, extractReasoning: codexApi.extractReasoning,
    findExecutionContext: codexApi.findCodexPromptExecutionContext,
    collectLegacy: codexApi.collectCodexTurnAssistantBlocks,
    extractText: codexApi.extractTextContent,
    log: { log() {} },
  });
  const load = (sessionId, proof, options = {}) => reader.load({ sessionId, cwd: f.root,
    proof, maxChars: 100000, resolveSource: request => f.service.resolveCodexResultSource(request),
    ...options });
  const batch = async (sessionId, proof) => {
    const descriptor = await f.resolve(sessionId);
    assert.equal(descriptor.success, true, descriptor.lineageReason);
    const records = [];
    for (const [index, segment] of descriptor.segments.entries()) {
      const read = await codexApi.readJsonlRange(segment.filePath, segment.fromByte, segment.toByte - 1,
        { lineCount: segment.startLine });
      assert.equal(read.errors, 0);
      if (segment.frozen) {
        assert.equal(read.leftoverBuffer.length, 0);
        assert.equal(read.lineCount, segment.endLine);
      }
      for (const record of read.records) records.push({ ...record,
        __physicalSessionId: segment.physicalSessionId,
        __segmentId: segment.segmentId, __segmentIndex: index });
    }
    return codexApi.buildCodexProviderTurnAssistantResult(records, sessionId, proof, 100000);
  };
  const expectBatch = async (sessionId, proof, options) => {
    const result = await load(sessionId, proof, options);
    assert.deepEqual(resultWithoutSnapshot(result), await batch(sessionId, proof));
    return result;
  };
  return { reader, reads, load, batch, expectBatch };
}

async function integratedVirtualFixture(t, complete = true) {
  const f = await fixture(t);
  f.parent = await f.addFile('parent', providerTurn('ANCESTOR', 'identical prompt', 'ancestor answer'));
  f.child = await f.addFile('child', providerTurn('CHILD', 'identical prompt', 'child answer', complete),
    { forked_from_id: f.parent.id });
  f.event = forkEvent(f.child, [frozen(f.parent)]);
  f.events.set(f.child.id, [f.event]);
  return { ...f, ...integratedReader(f), proof: exactProof(f.child.id, 'CHILD') };
}

test('descriptor/reader: multi-hop frozen ancestors and child match batch result and rollback coordinates', async t => {
  const f = await fixture(t);
  const parent = await f.addFile('ancestor', [
    ...providerTurn('KEPT', 'kept ancestor', 'kept answer'),
    ...providerTurn('REMOVED', 'rolled back ancestor', 'removed answer'),
    providerEvent('thread_rolled_back', { num_turns: 1 }),
  ]);
  const middle = await f.addFile('middle', providerTurn('MIDDLE', 'middle prompt', 'middle answer'),
    { forked_from_id: parent.id });
  const child = await f.addFile('child', providerTurn('CHILD', 'child prompt', 'own final result'),
    { forked_from_id: middle.id });
  const event = forkEvent(child, [frozen(parent), frozen(middle, middle.header.length, 1)]);
  f.events.set(child.id, [event]);
  const integrated = integratedReader(f);
  const result = await integrated.expectBatch(child.id, exactProof(child.id, 'CHILD'));
  assert.equal(result.complete, true);
  assert.equal(result.assistantText, 'own final result');
  assert.equal(result.turnIndex, 2, 'the ancestor rollback removes one inherited user coordinate');
  assert.equal(result.userUuid, 'codex-user-child-2');
  assert.equal(integrated.reader.stats().bootstraps, 1);
  assert.deepEqual(integrated.reads.filter(read => !read.collectRecords).map(read => [read.filePath, read.fromByte]), [
    [parent.filePath, 0], [middle.filePath, middle.header.length], [child.filePath, child.header.length],
  ]);
  assert.equal(f.calls.heavy, 0);
});

test('descriptor/reader: equal physical line numbers and identical prompts retain separate source identities', async t => {
  const f = await integratedVirtualFixture(t);
  const ancestor = await f.expectBatch(f.parent.id, exactProof(f.parent.id, 'ANCESTOR'));
  const child = await f.expectBatch(f.child.id, f.proof);
  assert.equal(ancestor.assistantText, 'ancestor answer');
  assert.equal(child.assistantText, 'child answer');
  assert.equal(ancestor.userUuid, 'codex-user-parent-2');
  assert.equal(child.userUuid, 'codex-user-child-2');
  assert.notEqual(ancestor.sourceIdentity, child.sourceIdentity);
  assert.match(ancestor.sourceIdentity, /^codex-user-source-parent-/);
  assert.match(child.sourceIdentity, /^codex-user-source-child-/);
  const wrongPhysicalOwner = exactProof(f.child.id, 'CHILD', f.parent.id);
  const rejected = await f.expectBatch(f.child.id, wrongPhysicalOwner);
  assert.equal(rejected.success, false);
  assert.equal(rejected.errorCode, 'prompt_outside_turn');
  assert.equal(f.reader.stats().bootstraps, 2, 'one independent cursor per physical/virtual view');
});

test('descriptor/reader: child append advances only its tail without replaying inherited records', async t => {
  const f = await integratedVirtualFixture(t, false);
  const initial = await f.expectBatch(f.child.id, f.proof);
  assert.equal(initial.complete, false);
  const before = f.reader.stats();
  const readCount = f.reads.length;
  const appended = Buffer.from(jsonl([
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool', output: 'tool output' } },
    providerAssistant('completed child'),
    providerEvent('task_complete', { turn_id: 'CHILD', last_agent_message: 'completed child' }),
  ]));
  await fs.appendFile(f.child.filePath, appended);
  const result = await f.expectBatch(f.child.id, f.proof);
  assert.equal(result.complete, true);
  assert.equal(result.assistantText, 'child answer\n\ncompleted child');
  const after = f.reader.stats();
  assert.equal(after.bootstraps, before.bootstraps);
  assert.equal(after.bytesRead - before.bytesRead, appended.length);
  assert.equal(after.appendReads - before.appendReads, 1);
  assert.deepEqual(f.reads.slice(readCount).filter(read => !read.collectRecords), [{
    filePath: f.child.filePath, fromByte: f.child.bytes.length,
    toByte: f.child.bytes.length + appended.length, collectRecords: false,
  }]);
  assert.equal(f.calls.heavy, 0);
});

test('descriptor/reader: ancestor growth beyond the frozen cut preserves result and warmed cursor', async t => {
  const f = await integratedVirtualFixture(t);
  const original = await f.expectBatch(f.child.id, f.proof);
  const before = f.reader.stats();
  const readsBefore = f.reads.length;
  await fs.appendFile(f.parent.filePath, jsonl(providerTurn('FUTURE', 'future ancestor', 'must stay outside child')));
  const result = await f.expectBatch(f.child.id, f.proof);
  assert.deepEqual(result, original);
  const after = f.reader.stats();
  for (const field of ['bootstraps', 'bytesRead', 'appendReads', 'records']) {
    assert.equal(after[field], before[field], field + ' must not advance for bytes outside the frozen cut');
  }
  assert.equal(f.reads.length, readsBefore);
  const descriptor = await f.resolve(f.child.id);
  assert.equal(descriptor.segments[0].toByte, f.parent.bytes.length);
  assert.ok(descriptor.segments[0].sourceSnapshot.size > descriptor.segments[0].toByte);
  assert.equal(f.calls.heavy, 0);
});

test('descriptor/reader: changed frozen bytes reject a cached final, including restored mtime', async t => {
  for (const restoreMtime of [false, true]) await t.test(restoreMtime ? 'mtime restored' : 'ordinary rewrite', async t => {
    const f = await integratedVirtualFixture(t);
    const fixedTime = new Date('2026-09-01T12:00:00Z');
    await fs.utimes(f.parent.filePath, fixedTime, fixedTime);
    const original = await f.expectBatch(f.child.id, f.proof);
    assert.equal(original.complete, true);
    const previous = await fs.stat(f.parent.filePath);
    const changed = Buffer.from(f.parent.bytes);
    const textOffset = changed.indexOf(Buffer.from('ancestor answer'));
    assert.ok(textOffset > 0);
    changed[textOffset] = 'A'.charCodeAt(0);
    await fs.writeFile(f.parent.filePath, changed);
    if (restoreMtime) await fs.utimes(f.parent.filePath, fixedTime, fixedTime);
    const current = await fs.stat(f.parent.filePath);
    assert.equal(current.size, previous.size);
    if (restoreMtime) assert.equal(current.mtimeMs, previous.mtimeMs);
    const rejected = await f.load(f.child.id, f.proof);
    assert.deepEqual(rejected, { success: false, error: 'lineage_unresolved',
      lineageReason: 'source-segment-digest-mismatch' });
    await fs.writeFile(f.parent.filePath, f.parent.bytes);
    const repaired = await f.expectBatch(f.child.id, f.proof);
    assert.deepEqual(resultWithoutSnapshot(repaired), resultWithoutSnapshot(original));
  });
});

test('descriptor/reader: a partial UTF-8 child terminal remains pending and completes once after append', async t => {
  const f = await integratedVirtualFixture(t, false);
  const initial = await f.expectBatch(f.child.id, f.proof);
  assert.equal(initial.complete, false);
  const before = f.reader.stats();
  const answer = Buffer.from(jsonl([providerAssistant('готово')]));
  const terminal = Buffer.from(jsonl([
    providerEvent('task_complete', { turn_id: 'CHILD', last_agent_message: 'готово' }),
  ]));
  const split = terminal.indexOf(Buffer.from('готово')) + 1;
  assert.ok(split > 1 && split < terminal.length);
  await fs.appendFile(f.child.filePath, Buffer.concat([answer, terminal.subarray(0, split)]));
  const pending = await f.expectBatch(f.child.id, f.proof);
  assert.equal(pending.complete, false);
  assert.equal(pending.proofDefinitive, false);
  assert.equal(pending.assistantText, 'child answer\n\nготово');
  await fs.appendFile(f.child.filePath, terminal.subarray(split));
  const completed = await f.expectBatch(f.child.id, f.proof);
  assert.equal(completed.complete, true);
  assert.equal(completed.assistantBlockCount, 2);
  const after = f.reader.stats();
  assert.equal(after.bootstraps, before.bootstraps);
  assert.equal(after.bytesRead - before.bytesRead, answer.length + terminal.length);
  const unchanged = await f.expectBatch(f.child.id, f.proof);
  assert.deepEqual(unchanged, completed);
  assert.equal(f.reader.stats().bytesRead, after.bytesRead);
  assert.equal(f.reader.stats().records, after.records);
});
