'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { SessionTranscriptService } = require('./session-transcript-service');
const { HistoryReadClient } = require('./history-read-client');
const { _api: actual } = require('./ipc/codex-data');
const { createCausalContext } = require('./perf-causal-context');
const { beginHistoryReadDiagnostic } = require('./history-read-memory-diagnostics');
function preparedDiagnostic(callback = () => {}) {
  const diagnostic = beginHistoryReadDiagnostic('session-turns');
  return { ...diagnostic, prepared(fields) { diagnostic.prepared(fields); callback(); } };
}
const { hashFileSegment } = require('./codex-virtual-transcript');
const { buildCodexForkLineageManifest } = require('./session-history-events');

// Run the actual Main cache/loader and annotation join without starting Electron.
// Only resolver roots, annotation SQL and diagnostics transport are controlled;
// raw LRU, source generations/fences, service/lineage admission and projectors
// are real. All source files are private, small and tests run serially.
const main = fs.readFileSync(process.env.NOTED_CODEX_TURNS_MAIN_SOURCE || path.join(__dirname, 'main.js'), 'utf8');
function block(start, end) {
  const from = main.indexOf(start), to = main.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return main.slice(from, to);
}
const cacheAndLoader = block('const _overseerTurnsCache = new Map();', '\nasync function _loadSessionTurns(');
const annotations = block('function _loadSessionAnnotations(', '\n// Fetch the raw assistant blocks');
const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
function rowsFor(sid, cwd, answer = 'answer-A') {
  return [
    { type: 'session_meta', payload: { id: sid, cwd } },
    { type: 'event_msg', timestamp: '2026-10-12T00:00:00Z', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'event_msg', timestamp: '2026-10-12T00:00:01Z', payload: { type: 'user_message', message: 'private prompt' } },
    { type: 'response_item', timestamp: '2026-10-12T00:00:02Z', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'private thinking' }] } },
    { type: 'response_item', timestamp: '2026-10-12T00:00:03Z', payload: { type: 'function_call', name: 'exec_command', call_id: 'private-call', arguments: JSON.stringify({ cmd: 'rg private fixture' }) } },
    { type: 'response_item', timestamp: '2026-10-12T00:00:04Z', payload: { type: 'function_call_output', call_id: 'private-call', output: 'private result' } },
    { type: 'response_item', timestamp: '2026-10-12T00:00:05Z', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: answer } },
    { type: 'compacted', timestamp: '2026-10-12T00:00:06Z', payload: { message: 'private summary' } },
    { type: 'event_msg', timestamp: '2026-10-12T00:00:07Z', payload: { type: 'user_message', message: 'second private prompt' } },
    { type: 'response_item', timestamp: '2026-10-12T00:00:08Z', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'second answer' }] } },
  ];
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-turns-private-'));
  const sid = randomUUID();
  fs.mkdirSync(path.join(root, 'A')); fs.mkdirSync(path.join(root, 'B'));
  const fileA = path.join(root, 'A', `rollout-${sid}.jsonl`);
  const fileB = path.join(root, 'B', `rollout-${sid}.jsonl`);
  fs.writeFileSync(fileA, encode(rowsFor(sid, root)));
  fs.writeFileSync(fileB, encode(rowsFor(sid, root, 'answer-B')));
  // Same SID and equal source size/mtime still do not identify the source.
  const equalTime = new Date(1700000000000);
  fs.utimesSync(fileA, equalTime, equalTime); fs.utimesSync(fileB, equalTime, equalTime);
  assert.equal(fs.statSync(fileA).size, fs.statSync(fileB).size);
  assert.equal(fs.statSync(fileA).mtimeMs, fs.statSync(fileB).mtimeMs);
  assert.ok(fs.statSync(fileA).size < 16 * 1024, 'fixture stays small');
  const f = { root, sid, fileA, fileB, file: fileA, hooks: {}, notes: [], rewinds: [],
    counts: { loads: 0, full: 0, timeline: 0, operation: 0 }, files: [fileA, fileB] };
  const api = f.api = { ...actual,
    findCodexSessionFile: async (id, cwd) => {
      const value = id === sid ? { filePath: f.file } : null;
      await f.hooks.find?.(value, cwd);
      return value;
    },
    loadSessionRecords: async (id, cwd, options = {}) => {
      f.counts.loads++;
      const value = await actual.loadSessionRecords(id, cwd, { ...options, sessionsDir: path.dirname(f.file) });
      f.lastLoaded = value;
      await f.hooks.load?.(value);
      return value;
    },
    buildCodexFullHistory: (...args) => { f.counts.full++; const value = actual.buildCodexFullHistory(...args); f.hooks.full?.(); return value; },
    buildCodexTimeline: (...args) => { f.counts.timeline++; return actual.buildCodexTimeline(...args); },
    beginCodexSourceRead: async (...args) => {
      const value = await actual.beginCodexSourceRead(...args); await f.hooks.begin?.(value); return value;
    },
    assertCodexSourceRead: async read => { await actual.assertCodexSourceRead(read); await f.hooks.assert?.(read); },
    // This fixture intentionally substitutes mutable resolver routing. Assert
    // that routing's actual current binding as well as the real native fence.
    assertCodexSourceReadCurrent: (read, binding = null) => {
      actual.assertCodexSourceReadCurrent(read);
      if (binding && (binding.sessionId !== sid || binding.filePath !== f.file)) {
        throw Object.assign(new Error('Private resolver binding changed'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
      }
    },
    finishCodexSourceRead: read => { actual.finishCodexSourceRead(read); f.hooks.finish?.(); },
  };
  const service = f.service = new SessionTranscriptService({ codexData: { _api: api },
    sessionHistoryStore: { getSessionHistoryEvents: () => [] } });
  const client = f.client = new HistoryReadClient({ codexData: { _api: api } });
  // The real logical admission journal is used without starting a read worker.
  service.historyReader = client;
  const load = service.loadCodexOperationSource.bind(service);
  service.loadCodexOperationSource = args => { f.counts.operation++; return load(args); };
  const perf = f.perf = createCausalContext();
  const context = f.context = vm.createContext({ require: id => (
    process.env.NOTED_CODEX_TURNS_ADMISSION_SOURCE && id === path.join(__dirname, 'codex-turns-cache-admission')
      ? require(process.env.NOTED_CODEX_TURNS_ADMISSION_SOURCE) : require(id)
  ), path, fs, srcMainDir: __dirname,
    perfCausal: perf, perfCallerToken: () => 'private-test', codexDataModule: { _api: api }, transcriptService: service,
    projectManager: { db: { db: { prepare: sql => ({ all: id => {
      assert.equal(id, sid); f.hooks.annotations?.();
      if (sql.includes('timeline_notes')) return f.notes;
      assert.ok(sql.includes('timeline_rewind_markers')); return f.rewinds;
    } }) } } }, console,
  });
  vm.runInContext(cacheAndLoader + '\n' + annotations + '\n'
    + block('function _isNoisePrompt(', '\n// Extract user-prompt text') + '\n'
    + block('function _sessionProgressToolDetail(', '\n// Group the active branch'), context);
  f.run = (options, cwd = root) => context._loadCodexSessionTurns(sid, cwd, options);
  f.reset = () => { for (const key of Object.keys(f.counts)) f.counts[key] = 0; };
  f.evictRaw = async () => {
    for (let i = 0; i < 6; i++) {
      const file = path.join(root, `evict-${i}.jsonl`);
      fs.writeFileSync(file, encode([{ type: 'fixture_padding', payload: i }])); f.files.push(file);
      await actual.parseJsonlFile(file);
    }
    assert.ok(!actual.getCodexJsonlCacheStats().filePaths.includes(f.file), 'only the real raw LRU was evicted');
  };
  f.rewrite = () => {
    const before = fs.statSync(f.file);
    fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('answer-A', 'answer-C'));
    fs.utimesSync(f.file, before.atime, before.mtime);
  };
  t.after(async () => {
    actual.setCodexExternalReadVersion(null);
    await client.close();
    for (const file of f.files) actual.invalidateJsonlCache(file);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}
const plain = value => JSON.parse(JSON.stringify(value));
const body = result => [...result.recordMap.values()].flatMap(row => row.message.content)
  .map(row => typeof row === 'string' ? row : row.text || '').join('\n');
function sameGraph(a, b) {
  for (const key of ['turns', 'recordMap', 'timelineEntries', 'sessionMeta', 'sourceSnapshot']) assert.equal(a[key], b[key], key);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'no new public DTO fields');
  for (const key of ['engine', 'sessionId', 'composite', 'contentRevision', 'retainedSourceBytes', 'mtimeMs', 'size', 'branchLength', 'filePath']) assert.equal(a[key], b[key], key);
}

test('warm graph survives only-real-raw-LRU eviction with exact graph/DTO and fresh annotations, zero raw/full/timeline calls', async t => {
  const f = await fixture(t), first = await f.run();
  await f.evictRaw();
  assert.ok(actual.isCodexSourceSnapshotCurrent(first.sourceSnapshot));
  f.notes = [{ entry_uuid: first.turns[0].userUuid, content: 'fresh note', position: 'after', created_at: 1, updated_at: 2 }];
  f.rewinds = [{ entry_uuid: first.turns[0].userUuid, created_at: 3 }];
  f.reset(); const hit = await f.run();
  sameGraph(first, hit);
  assert.equal(hit.notesByTurn.get(0).content, 'fresh note'); assert.equal(hit.rewindByTurn.get(0).createdAt, 3);
  assert.deepEqual(f.counts, { loads: 0, full: 0, timeline: 0, operation: 0 });
  assert.ok(!actual.getCodexJsonlCacheStats().filePaths.includes(f.file), 'hit does not repopulate raw LRU');
});

for (const change of ['append', 'same-size-rewrite', 'inode-replacement', 'forceFresh', 'source-generation', 'exact-lineage', 'cwd']) {
  test(`warm graph rejects ${change} and takes the canonical read`, async t => {
    const f = await fixture(t), first = await f.run();
    await f.evictRaw();
    if (change === 'append') fs.appendFileSync(f.file, encode([{ type: 'event_msg', payload: { type: 'user_message', message: 'appended prompt' } }]));
    if (change === 'same-size-rewrite') f.rewrite();
    if (change === 'inode-replacement') {
      const before = fs.statSync(f.file); fs.copyFileSync(f.file, f.file + '.new');
      fs.utimesSync(f.file + '.new', before.atime, before.mtime); fs.renameSync(f.file + '.new', f.file);
    }
    if (change === 'source-generation') actual.invalidateJsonlCache(f.file);
    if (change === 'exact-lineage') f.service.notifyCodexLineageCommitted(f.sid);
    f.reset(); const next = await f.run(change === 'forceFresh' ? { forceFresh: true } : {}, change === 'cwd' ? rootCwd(f) : f.root);
    assert.notEqual(next.turns, first.turns, 'stale graph must not be reused');
    assert.equal(f.counts.loads, 1); assert.equal(f.counts.full, 1); assert.equal(f.counts.timeline, 1);
    if (change === 'same-size-rewrite') assert.match(body(next), /answer-C/);
    if (change === 'append') assert.ok(next.turns.length > first.turns.length);
  });
}
const rootCwd = f => path.join(f.root, 'other-cwd');

test('an unrelated lineage commit preserves the warm graph', async t => {
  const f = await fixture(t), first = await f.run(); await f.evictRaw();
  f.service.notifyCodexLineageCommitted('unrelated-owner'); f.reset();
  sameGraph(first, await f.run()); assert.equal(f.counts.loads, 0); assert.equal(f.counts.full, 0);
});

test('same SID resolver moves A to B with equal size/mtime and unchanged A: graph A is rejected', async t => {
  const f = await fixture(t), first = await f.run(); await f.evictRaw();
  const before = fs.statSync(f.fileA); f.file = f.fileB; f.reset(); const next = await f.run();
  assert.deepEqual(fs.statSync(f.fileA), before, 'A remains unchanged');
  assert.equal(next.filePath, f.fileB); assert.notEqual(first.turns, next.turns);
  assert.match(body(next), /answer-B/); assert.equal(f.counts.loads, 1); assert.equal(f.counts.full, 1);
});

for (const missing of ['owner-proof', 'fence', 'snapshot', 'generation', 'unknown-guard']) {
  test(`missing/unknown optional ${missing} keeps the canonical route`, async t => {
    const f = await fixture(t);
    if (missing === 'owner-proof') f.service.captureCodexTurnsLineageProof = undefined;
    if (missing === 'fence') f.api.assertCodexSourceReadCurrent = undefined;
    if (missing === 'snapshot') f.hooks.load = value => { value.sourceSnapshot = null; };
    if (missing === 'generation') f.hooks.load = value => { value.sourceSnapshot = { ...value.sourceSnapshot, sourceGeneration: '' }; };
    if (missing === 'unknown-guard') f.api.beginCodexSourceRead = async () => { throw Object.assign(new Error('private optional stat unknown'), { code: 'EACCES' }); };
    const first = await f.run(); await f.evictRaw(); f.reset(); const next = await f.run();
    assert.equal(f.counts.loads, 1); assert.equal(f.counts.operation, 1); assert.deepEqual(plain(next.turns), plain(first.turns));
  });
}

test('virtual view without full ancestry proof never gets an early child-stat hit', async t => {
  const f = await fixture(t);
  f.service.loadCodexOperationSource = async args => {
    f.counts.operation++;
    const loaded = await f.api.loadSessionRecords(args.sessionId, args.cwd);
    return { ...loaded, composite: true, contentRevision: 'private-virtual-v1',
      historyEntries: actual.buildCodexFullHistory(loaded.records, f.sid),
      timelineEntries: actual.buildCodexTimeline(loaded.records, f.sid) };
  };
  const first = await f.run(); await f.evictRaw(); f.reset(); const next = await f.run();
  assert.equal(next.composite, true); assert.equal(f.counts.operation, 1); assert.equal(f.counts.loads, 1);
  assert.deepEqual(plain(next.turns), plain(first.turns));
});

for (const phase of ['annotations', 'projection-diagnostic', 'outer-diagnostic', 'last-async-stat', 'finish']) {
  for (const mutation of ['physical', 'logical']) test(`no stale success after ${phase} reenters with ${mutation} revocation`, async t => {
    const f = await fixture(t); await f.run(); await f.evictRaw();
    const revoke = () => { if (mutation === 'physical') { f.rewrite(); actual.invalidateJsonlCache(f.file); }
      else f.service.notifyCodexLineageCommitted(f.sid); };
    const once = name => () => { delete f.hooks[name]; revoke(); };
    if (phase === 'annotations') f.hooks.annotations = once('annotations');
    if (phase === 'finish') f.hooks.finish = once('finish');
    if (phase === 'last-async-stat') f.hooks.assert = once('assert');
    if (phase.includes('diagnostic')) f.perf.configure({ enabled: true, sink: event => {
      const target = phase === 'outer-diagnostic' ? 'history.codex-session-turns' : 'history.codex-turn-projection';
      if (event.name === target && event.phase === 'settle') { f.perf.configure({ enabled: false }); revoke(); }
      return true;
    } });
    // An admitted hit still goes through projection diagnostics.
    await assert.rejects(f.run(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
    delete f.hooks.annotations; delete f.hooks.finish; delete f.hooks.assert; f.perf.configure({ enabled: false });
    const fresh = await f.run(); if (mutation === 'physical') assert.match(body(fresh), /answer-C/);
  });
}

test('a late fresh stat cannot certify old records returned by the canonical source', async t => {
  const f = await fixture(t);
  f.hooks.load = () => { delete f.hooks.load; f.rewrite(); actual.invalidateJsonlCache(f.file); };
  await assert.rejects(f.run(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.match(body(await f.run()), /answer-C/);
});

test('canonical projection reentrancy cannot publish an obsolete graph or certificate', async t => {
  const f = await fixture(t);
  f.hooks.full = () => { delete f.hooks.full; f.service.notifyCodexLineageCommitted(f.sid); };
  await assert.rejects(f.run(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  f.reset(); await f.run(); assert.equal(f.counts.full, 1, 'failed graph was not admitted into cache');
});

for (const phase of ['find', 'begin']) test(`exact-owner commit during early ${phase} await falls back to canonical`, async t => {
  const f = await fixture(t), first = await f.run(); await f.evictRaw(); f.reset();
  f.hooks[phase] = async () => { delete f.hooks[phase]; await Promise.resolve(); f.service.notifyCodexLineageCommitted(f.sid); };
  const current = await f.run(); assert.notEqual(current.turns, first.turns); assert.equal(f.counts.loads, 1);
});

for (const phase of ['annotations', 'outer-diagnostic', 'last-async-stat']) test(`resolver A to B during ${phase} is checked at final admission`, async t => {
  const f = await fixture(t); await f.run(); await f.evictRaw();
  const move = () => { f.file = f.fileB; };
  if (phase === 'annotations') f.hooks.annotations = () => { delete f.hooks.annotations; move(); };
  if (phase === 'last-async-stat') f.hooks.assert = async () => { delete f.hooks.assert; await Promise.resolve(); move(); };
  if (phase === 'outer-diagnostic') f.perf.configure({ enabled: true, sink: event => {
    if (event.name === 'history.codex-session-turns' && event.phase === 'settle') { f.perf.configure({ enabled: false }); move(); }
    return true;
  } });
  await assert.rejects(f.run(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.match(body(await f.run()), /answer-B/);
});

test('the actual read fence checks external-version revocation after an annotation callback', async t => {
  const f = await fixture(t); let epoch = 0; actual.setCodexExternalReadVersion(() => epoch);
  await f.run(); await f.evictRaw();
  f.hooks.annotations = () => { delete f.hooks.annotations; epoch++; };
  await assert.rejects(f.run(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  await f.run();
});

for (const phase of ['session-wrapper-diagnostic', 'session-wrapper-settle']) test(`public Main wrapper rejects lineage revoked by ${phase}`, async t => {
  const f = await fixture(t); await f.run(); await f.evictRaw();
  vm.runInContext(block('async function _loadSessionTurns(', '\nfunction _historyReadBindings('), f.context);
  f.context._resolveHistoryReadSession = async () => ({ provider: 'codex', diagnostics: {} });
  let once = true;
  f.context.beginHistoryReadDiagnostic = () => preparedDiagnostic(() => {
    if (phase === 'session-wrapper-diagnostic' && once) { once = false; f.service.notifyCodexLineageCommitted(f.sid); }
  });
  if (phase === 'session-wrapper-settle') f.perf.configure({ enabled: true, sink: event => {
    if (event.name === 'history.session-turns' && event.phase === 'settle' && once) {
      once = false; f.service.notifyCodexLineageCommitted(f.sid);
    }
    return true;
  } });
  await assert.rejects(f.context._loadSessionTurns(f.sid, f.root, { provider: 'codex' }), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
});

test('actual virtual ancestry keeps canonical validation and rejects changed parent with unchanged child', async t => {
  const f = await fixture(t), parent = randomUUID(), parentFile = path.join(f.root, `rollout-${parent}.jsonl`);
  const parentRows = rowsFor(parent, f.root); fs.writeFileSync(parentFile, encode(parentRows)); f.files.push(parentFile);
  const prelude = [{ type: 'session_meta', payload: { id: f.sid, cwd: f.root, forked_from_id: parent } }];
  fs.writeFileSync(f.file, encode(prelude)); const childSize = fs.statSync(f.file).size;
  const parentSize = fs.statSync(parentFile).size;
  const parentHash = (await hashFileSegment(parentFile, 0, parentSize)).sha256;
  const childHash = (await hashFileSegment(f.file, 0, childSize)).sha256;
  const manifest = buildCodexForkLineageManifest({ sourceSessionId: parent, childSessionId: f.sid,
    sourceSegments: [{ physicalSessionId: parent, fromByte: 0, toByte: parentSize, startLine: 0,
      endLine: parentRows.length, prefixDigest: parentHash }],
    childTailStart: { byteOffset: childSize, line: prelude.length, prefixDigest: childHash } });
  const event = { eventKey: `fork:codex:${parent}:${f.sid}`, eventType: 'fork', provider: 'codex',
    sourceSessionId: parent, childSessionId: f.sid, snapshotComplete: true, lineageManifest: manifest };
  f.service.sessionHistoryStore.getSessionHistoryEvents = id => id === f.sid ? [event] : [];
  const find = f.api.findCodexSessionFile;
  f.api.findCodexSessionFile = (id, cwd) => id === parent ? Promise.resolve({ filePath: parentFile }) : find(id, cwd);
  const first = await f.run(); assert.equal(first.composite, true); assert.match(body(first), /answer-A/);
  f.reset(); const next = await f.run(); assert.equal(f.counts.operation, 1);
  assert.deepEqual(plain(first.turns), plain(next.turns));
  const childBefore = fs.statSync(f.file), parentBefore = fs.statSync(parentFile);
  fs.writeFileSync(parentFile, fs.readFileSync(parentFile, 'utf8').replace('answer-A', 'answer-C'));
  fs.utimesSync(parentFile, parentBefore.atime, parentBefore.mtime); f.reset();
  await assert.rejects(f.run(), error => error.message === 'lineage_unresolved' && error.status === 409);
  assert.equal(f.counts.operation, 1); assert.deepEqual(fs.statSync(f.file), childBefore);
});

for (const legacy of [false, true]) for (const outer of [false, true]) {
  test(`one warm hit metadata counts: ${legacy ? 'legacy-event' : 'plain'} / ${outer ? 'public-wrapper' : 'direct'}`, async t => {
    const f = await fixture(t);
    const counts = { lineage: 0, historyEvents: 0, legacySerializations: 0, asyncStat: 0,
      syncStat: 0, resolver: 0, providerResolution: 0, annotationReads: 0 };
    if (legacy) {
      const event = { eventType: 'fork', provider: 'codex', childSessionId: f.sid, sourceSessionId: 'private-parent',
        eventKey: 'private-legacy-event', forkMode: 'legacy-control', origin: 'app', entryUuids: ['private-entry'] };
      Object.defineProperty(event, 'toJSON', { value: () => { counts.legacySerializations++; return { ...event }; } });
      f.service.sessionHistoryStore.getSessionHistoryEvents = () => [event];
    }
    const first = await f.run(); await f.evictRaw(); f.reset();
    const fixtureBytes = fs.statSync(f.file).size;
    if (outer) {
      vm.runInContext(block('async function _loadSessionTurns(', '\nfunction _historyReadBindings('), f.context);
      f.context._resolveHistoryReadSession = async () => { counts.providerResolution++; return { provider: 'codex', diagnostics: {} }; };
      f.context.beginHistoryReadDiagnostic = () => preparedDiagnostic();
    }
    const resolve = f.service._resolveCodexLineage, events = f.service.sessionHistoryStore.getSessionHistoryEvents;
    f.service._resolveCodexLineage = function (...args) { counts.lineage++; return resolve.apply(this, args); };
    f.service.sessionHistoryStore.getSessionHistoryEvents = (...args) => { counts.historyEvents++; return events(...args); };
    f.hooks.find = () => { counts.resolver++; }; f.hooks.annotations = () => { counts.annotationReads++; };
    const asyncStat = fs.promises.stat, syncStat = fs.statSync;
    fs.promises.stat = function (file, ...args) { if (file === f.file) counts.asyncStat++; return asyncStat.call(this, file, ...args); };
    fs.statSync = function (file, ...args) { if (file === f.file) counts.syncStat++; return syncStat.call(this, file, ...args); };
    for (const key of Object.keys(counts)) counts[key] = 0;
    let hit;
    try { hit = outer ? await f.context._loadSessionTurns(f.sid, f.root, { provider: 'codex' }) : await f.run(); }
    finally { fs.promises.stat = asyncStat; fs.statSync = syncStat; }
    sameGraph(first, hit); assert.deepEqual(f.counts, { loads: 0, full: 0, timeline: 0, operation: 0 });
    assert.equal(counts.lineage, counts.historyEvents);
    assert.equal(counts.legacySerializations, legacy ? counts.lineage : 0);
    assert.ok(counts.lineage <= (outer ? 3 : 2), 'interim guards must not repeat DB/hash reads');
    assert.ok(counts.syncStat <= (outer ? 4 : 2), 'redundant pre-final sync stats must not return');
    const measurement = { case: `${legacy ? 'legacy-event' : 'plain'}-${outer ? 'public-wrapper' : 'direct'}`,
      fixtureBytes, counts, heavyCalls: { ...f.counts }, substitutions: 'private resolver routing; in-memory events/annotation SQL; provider resolution stub counts separately; source stats/fences/service/projectors real' };
    t.diagnostic('metadata-counts ' + JSON.stringify(measurement));
    if (process.env.NOTED_CODEX_TURNS_METADATA_FILE) {
      const file = process.env.NOTED_CODEX_TURNS_METADATA_FILE;
      const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      rows.push(measurement); fs.writeFileSync(file, JSON.stringify(rows, null, 2) + '\n');
    }
  });
}

test('standalone client invalidation is not Main source/writer proof; actual codex-data invalidation revokes the graph', async t => {
  const f = await fixture(t), first = await f.run(); await f.evictRaw(); f.reset();
  const nativeRead = await actual.beginCodexSourceRead(f.file, f.sid);
  f.client.invalidate({ filePath: f.file });
  assert.ok(actual.isCodexSourceSnapshotCurrent(first.sourceSnapshot));
  assert.doesNotThrow(() => actual.assertCodexSourceReadCurrent(nativeRead));
  sameGraph(first, await f.run()); assert.equal(f.counts.loads, 0);
  const sequence = f.client.invalidationSequence;
  actual.invalidateJsonlCache(f.file);
  assert.equal(f.client.invalidationSequence, sequence + 1, 'real subscription routes native invalidation into Main client');
  assert.equal(actual.isCodexSourceSnapshotCurrent(first.sourceSnapshot), false);
  assert.throws(() => actual.assertCodexSourceReadCurrent(nativeRead), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  actual.finishCodexSourceRead(nativeRead); f.reset();
  assert.notEqual((await f.run()).turns, first.turns); assert.equal(f.counts.loads, 1);
});

test('observed physical generation rewrite revokes Main fence without manufacturing a client notification', async t => {
  const f = await fixture(t), first = await f.run(); await f.evictRaw();
  const read = await actual.beginCodexSourceRead(f.file, f.sid), sequence = f.client.invalidationSequence;
  f.rewrite(); actual.getCodexPayloadGeneration(f.file, fs.statSync(f.file), f.sid);
  assert.equal(f.client.invalidationSequence, sequence, 'generation observation has its own direct fence route');
  assert.equal(actual.isCodexSourceSnapshotCurrent(first.sourceSnapshot), false);
  assert.throws(() => actual.assertCodexSourceReadCurrent(read), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  actual.finishCodexSourceRead(read); f.reset();
  const next = await f.run(); assert.match(body(next), /answer-C/); assert.equal(f.counts.loads, 1);
});

for (const phase of ['annotations', 'last-async-stat', 'session-wrapper-diagnostic', 'session-wrapper-settle']) {
  test(`final logical comparison catches legacy mutation without a commit at ${phase}`, async t => {
    const f = await fixture(t);
    const event = { eventType: 'fork', provider: 'codex', childSessionId: f.sid, sourceSessionId: 'private-parent',
      eventKey: 'private-legacy-event', forkMode: 'legacy-control', origin: 'app', entryUuids: ['old'] };
    f.service.sessionHistoryStore.getSessionHistoryEvents = () => [event];
    await f.run(); await f.evictRaw();
    const mutate = () => { event.entryUuids[0] = 'new'; };
    if (phase === 'annotations') f.hooks.annotations = () => { delete f.hooks.annotations; mutate(); };
    if (phase === 'last-async-stat') f.hooks.assert = async () => { delete f.hooks.assert; await Promise.resolve(); mutate(); };
    const outer = phase.startsWith('session-wrapper');
    if (outer) {
      vm.runInContext(block('async function _loadSessionTurns(', '\nfunction _historyReadBindings('), f.context);
      f.context._resolveHistoryReadSession = async () => ({ provider: 'codex', diagnostics: {} });
      let once = true;
      f.context.beginHistoryReadDiagnostic = () => preparedDiagnostic(() => {
        if (phase === 'session-wrapper-diagnostic' && once) { once = false; mutate(); }
      });
      if (phase === 'session-wrapper-settle') f.perf.configure({ enabled: true, sink: record => {
        if (record.name === 'history.session-turns' && record.phase === 'settle' && once) { once = false; mutate(); }
        return true;
      } });
    }
    const sequence = f.client.invalidationSequence;
    await assert.rejects(outer ? f.context._loadSessionTurns(f.sid, f.root, { provider: 'codex' }) : f.run(),
      { code: 'CODEX_SOURCE_READ_INVALIDATED' });
    assert.equal(f.client.invalidationSequence, sequence, 'a cheap journal check alone cannot replace final logical comparison');
  });
}

test('initial full comparison preserves canonical fallback for an already-changed legacy event', async t => {
  const f = await fixture(t);
  const event = { eventType: 'fork', provider: 'codex', childSessionId: f.sid, sourceSessionId: 'private-parent',
    eventKey: 'private-legacy-event', forkMode: 'legacy-control', origin: 'app', entryUuids: ['old'] };
  f.service.sessionHistoryStore.getSessionHistoryEvents = () => [event];
  const first = await f.run(); await f.evictRaw(); event.entryUuids[0] = 'new'; f.reset();
  const next = await f.run(); assert.notEqual(first.turns, next.turns); assert.equal(f.counts.loads, 1);
});

test('final stat catches an external rewrite after async assertion with no invalidation notification', async t => {
  const f = await fixture(t); await f.run(); await f.evictRaw(); const sequence = f.client.invalidationSequence;
  f.hooks.assert = async () => { delete f.hooks.assert; await Promise.resolve(); f.rewrite(); };
  await assert.rejects(f.run(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.equal(f.client.invalidationSequence, sequence); assert.match(body(await f.run()), /answer-C/);
});

test('final physical check follows a reentrant final logical lookup', async t => {
  const f = await fixture(t); await f.run(); await f.evictRaw();
  let afterAnnotations = false, once = true;
  f.hooks.annotations = () => { afterAnnotations = true; };
  f.service.sessionHistoryStore.getSessionHistoryEvents = () => {
    if (afterAnnotations && once) { once = false; f.rewrite(); } return [];
  };
  await assert.rejects(f.run(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
});

for (const outer of [false, true]) test(`last resolver captured A then mutable routing moves to B: ${outer ? 'public' : 'direct'}`, async t => {
  const f = await fixture(t); await f.run(); await f.evictRaw(); f.reset();
  if (outer) {
    vm.runInContext(block('async function _loadSessionTurns(', '\nfunction _historyReadBindings('), f.context);
    f.context._resolveHistoryReadSession = async () => ({ provider: 'codex', diagnostics: {} });
    f.context.beginHistoryReadDiagnostic = () => preparedDiagnostic();
  }
  const before = fs.statSync(f.fileA); let finds = 0;
  f.hooks.find = async captured => {
    if (++finds === (outer ? 4 : 2)) { assert.equal(captured.filePath, f.fileA); f.file = f.fileB; }
  };
  let value, error;
  try { value = outer ? await f.context._loadSessionTurns(f.sid, f.root, { provider: 'codex' }) : await f.run(); }
  catch (caught) { error = caught; }
  t.diagnostic('final-binding ' + JSON.stringify({ mode: outer ? 'public' : 'direct', finds,
    returned: value?.filePath === f.fileA ? 'A' : value?.filePath, currentRoute: f.file === f.fileB ? 'B' : 'A',
    error: error?.code || null, unchangedA: fs.statSync(f.fileA).ctimeMs === before.ctimeMs, heavyCalls: f.counts }));
  assert.deepEqual(fs.statSync(f.fileA), before);
  assert.equal(error?.code, 'CODEX_SOURCE_READ_INVALIDATED', 'A cannot be returned after the final resolver changed its binding to B');
});

test('last resolver captured A while a real delayed cold scan installs B in its memo', async t => {
  const f = await fixture(t), root = f.root;
  // The cold scan snapshots only B. A is restored before graph warming and
  // remains physically unchanged throughout the final-admission race.
  fs.renameSync(f.fileA, f.fileA + '.seed');
  const readdir = fs.promises.readdir, access = fs.promises.access;
  let releaseScan, scanReady;
  const release = new Promise(resolve => { releaseScan = resolve; });
  const ready = new Promise(resolve => { scanReady = resolve; });
  let gateScan = true, armed = false, accessCalls = 0, lateScan;
  fs.promises.readdir = async function (dir, ...args) {
    const result = await readdir.call(this, dir, ...args);
    if (dir === path.dirname(f.fileB) && gateScan) { gateScan = false; scanReady(); await release; }
    return result;
  };
  let first, error, value, current, standaloneRead;
  try {
    lateScan = actual.findCodexSessionFile(f.sid, root, { sessionsDir: root });
    await ready;
    fs.renameSync(f.fileA + '.seed', f.fileA);
    f.api.findCodexSessionFile = (sid, cwd) => actual.findCodexSessionFile(sid, cwd, { sessionsDir: root });
    // Namespace substitution only; comparison uses the real private memo.
    f.api.assertCodexSourceReadCurrent = (read, binding = null) => actual.assertCodexSourceReadCurrent(read,
      binding ? { ...binding, sessionsDir: root } : null);
    f.api.loadSessionRecords = async (sid, cwd, options = {}) => {
      f.counts.loads++; return actual.loadSessionRecords(sid, cwd, { ...options, sessionsDir: root });
    };
    first = await f.run(); assert.equal(first.filePath, f.fileA);
    await f.evictRaw(); f.reset(); const before = fs.statSync(f.fileA);
    vm.runInContext(block('async function _loadSessionTurns(', '\nfunction _historyReadBindings('), f.context);
    f.context._resolveHistoryReadSession = async () => ({ provider: 'codex', diagnostics: {} });
    f.context.beginHistoryReadDiagnostic = () => preparedDiagnostic();
    sameGraph(first, await f.context._loadSessionTurns(f.sid, root, { provider: 'codex' }));
    assert.deepEqual(f.counts, { loads: 0, full: 0, timeline: 0, operation: 0 }, 'stable native binding retains the warm hit');
    standaloneRead = await actual.beginCodexSourceRead(f.fileA, f.sid);
    fs.promises.access = async function (file, ...args) {
      const result = await access.call(this, file, ...args);
      if (armed && file === f.fileA && ++accessCalls === 4) {
        releaseScan(); const installed = await lateScan; assert.equal(installed.filePath, f.fileB);
      }
      return result;
    };
    armed = true;
    try { value = await f.context._loadSessionTurns(f.sid, root, { provider: 'codex' }); }
    catch (caught) { error = caught; }
    armed = false;
    current = await actual.findCodexSessionFile(f.sid, root, { sessionsDir: root });
    t.diagnostic('native-final-binding ' + JSON.stringify({ accessCalls, returned: value?.filePath === f.fileA ? 'A' : value?.filePath,
      current: current?.filePath === f.fileB ? 'B' : current?.filePath, error: error?.code || null,
      unchangedA: fs.statSync(f.fileA).ctimeMs === before.ctimeMs, heavyCalls: f.counts }));
    assert.deepEqual(fs.statSync(f.fileA), before); assert.equal(current.filePath, f.fileB);
    assert.equal(error?.code, 'CODEX_SOURCE_READ_INVALIDATED', 'actual memo retarget can invalidate the final result without changing source A');
    assert.ok(actual.isCodexSourceSnapshotCurrent(first.sourceSnapshot));
    assert.doesNotThrow(() => actual.assertCodexSourceReadCurrent(standaloneRead), 'physical-only callers retain the original fence contract');
    assert.throws(() => actual.assertCodexSourceReadCurrent(standaloneRead,
      { sessionId: f.sid, filePath: f.fileA, sessionsDir: root }), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
    // Another resolver namespace for the same SID must not inherit this move.
    const other = await actual.findCodexSessionFile(f.sid, root, { sessionsDir: path.dirname(f.fileA) });
    assert.equal(other.filePath, f.fileA);
    assert.doesNotThrow(() => actual.assertCodexSourceReadCurrent(standaloneRead,
      { sessionId: f.sid, filePath: f.fileA, sessionsDir: path.dirname(f.fileA) }));
    assert.throws(() => actual.assertCodexSourceReadCurrent(standaloneRead,
      { sessionId: f.sid, filePath: f.fileA, sessionsDir: root + '/unknown' }), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
    f.reset();
    const repaired = await f.context._loadSessionTurns(f.sid, root, { provider: 'codex' });
    assert.equal(repaired.filePath, f.fileB); assert.match(body(repaired), /answer-B/);
    assert.deepEqual(f.counts, { loads: 1, full: 1, timeline: 1, operation: 1 }, 'next request uses the canonical B source');
    assert.deepEqual(fs.statSync(f.fileA), before);
  } finally {
    releaseScan(); if (lateScan) await lateScan.catch(() => {});
    if (standaloneRead) actual.finishCodexSourceRead(standaloneRead);
    fs.promises.readdir = readdir; fs.promises.access = access;
  }
});
