'use strict';

// Finite Source-only FILE producer + actual paged store. Explicit Node 22
// node:sqlite TEST adapter; never Electron, a profile, provider or a GUI.
process.env.NOTED_HISTORY_READER_PROCESS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const crypto = require('node:crypto');
const evidence = process.env.NOTED_TIMELINE_TEST_EVIDENCE;
assert(evidence && path.isAbsolute(evidence), 'explicit owned evidence directory required');
const SQLite = require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER);
const { HistoryPagedStore, materializeHistoryCursorSync: mat } = require('./history-paged-store');
const { CodexRootProjectionOwner } = require('./codex-root-projection-owner');
function originalApi() {
  const filename = path.join(__dirname, 'ipc/codex-data.js');
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(fs.readFileSync(path.join(evidence, 'codex-data.js.BEFORE'), 'utf8'), filename); return m.exports._api;
}
const api = process.env.NOTED_TIMELINE_TEST_ORIGINAL_RED === '1' ? originalApi() : require('./ipc/codex-data')._api;
const stamp = '2026-10-25T00:00:00Z';
const rec = (type, payload) => ({ type, payload, timestamp: stamp });
const user = message => rec('event_msg', { type: 'user_message', message });
const responseUser = text => rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const answer = (text, phase = 'final_answer') => rec('response_item', { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] });
const call = (call_id, name, args) => rec('response_item', { type: 'function_call', call_id, name, ...(name === 'spawn_agent' ? { namespace: 'multi_agent_v1' } : {}), arguments: JSON.stringify(args) });
const output = (call_id, value) => rec('response_item', { type: 'function_call_output', call_id, output: JSON.stringify(value) });
const special = 'Ω🙂\ud800\udfff\0\r\n';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
function orderedKeys(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.keys(value).map(key => [key, orderedKeys(value[key])]);
}
function same(actual, expected) { assert.deepEqual(actual, expected); assert.deepEqual(orderedKeys(actual), orderedKeys(expected)); }
function pins(store) { return { leases: store.stats().leases, builders: store.stats().activeBuilders,
  pins: store.db.prepare('SELECT count(*) n FROM hp_pins WHERE durable=0').get().n }; }
function fixture(t, { alternateName = false, header = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(evidence, 'fixture-'));
  const sessionId = crypto.randomUUID(), filePath = path.join(dir, alternateName ? 'rollout-owned.jsonl' : 'rollout-' + sessionId + '.jsonl');
  const store = new HistoryPagedStore({ filename: path.join(dir, 'pages.sqlite'), Database: SQLite, diskBytes: 64 * 1024 ** 2 });
  const owner = new CodexRootProjectionOwner(store, { namespace: 'codex-timeline-v1', checkpointEvery: 2 });
  const historyOwner = new CodexRootProjectionOwner(store, { checkpointEvery: 2 });
  let offset = 0, line = 0; const located = [];
  fs.writeFileSync(filePath, '');
  function append(record, newline = '\n') {
    const raw = JSON.stringify(record) + newline;
    located.push({ ...record, __line: line++, __byteOffset: offset });
    fs.appendFileSync(filePath, raw); offset += Buffer.byteLength(raw);
  }
  append(rec('session_meta', { id: sessionId, cwd: dir, ...header }));
  const options = { rootedOwner: owner, sessionsDir: dir, highWaterMark: 64 };
  const read = extra => api.projectCodexRootTimelineFromFile(sessionId, dir, { ...options, ...extra });
  const oracle = () => { const p = api.createCodexTimelineProjector(sessionId); located.forEach(p.feed); return { entries: p.finalize(), sessionMeta: p.getSessionMeta() }; };
  const history = extra => api.projectCodexFullHistoryFromFile(sessionId, dir, { ...options, rootedOwner: historyOwner, ...extra });
  const live = new Set();
  const hold = r => { live.add(r); return r; };
  t.after(() => {
    for (const r of live) r.release();
    api.invalidateJsonlCache(filePath); owner.close(); historyOwner.close();
    try {
      const finalPins = pins(store); t.diagnostic(JSON.stringify({ scope: 'post-release', ...finalPins }));
      assert.deepEqual(finalPins, { leases: 0, builders: 0, pins: 0 });
    }
    finally { store.close(); fs.rmSync(dir, { recursive: true }); }
    assert(!fs.existsSync(dir));
  });
  return { dir, sessionId, filePath, store, owner, historyOwner, append, read, history, oracle, hold, located };
}
function check(r, expected) {
  assert(r.success); assert.equal(r.representation, 'codex-timeline-root-v1');
  assert.equal(r.readMetrics.timelineRows, expected.entries.length); assert.equal(r.readMetrics.canonicalRows, 0);
  same(mat(r.entries), expected.entries); same(mat(r.sessionMeta), expected.sessionMeta);
  for (const value of [r, r.entries, r.sessionMeta, r.root, r.checkpoint, r.sourceSnapshot]) assert(Object.isFrozen(value)); assert.equal(r.rootStats.store.legacyCaptureValues, 0);
  assert.equal(r.rootStats.ownership.nativeRows, 0); assert.equal(r.rootStats.ownership.nativeMapEntries, 0);
  assert.equal(r.readMetrics.maxCollectedRecords, 0); assert.equal(r.readMetrics.wholeLineStrings, 0); assert.equal(r.readMetrics.wholeRecordGraphs, 0);
}
const scenarios = [
  ['Unicode/full long user, response model/effort/preview, usage', [
    rec('turn_context', { model: 'gpt-5', effort: 'high' }), user(special.repeat(800)),
    rec('response_item', { type: 'reasoning', summary: [{ text: special.repeat(90) }] }), answer(special.repeat(400)),
    rec('event_msg', { type: 'token_count', info: { model_context_window: 1000, last_token_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 35, reasoning_output_tokens: 10 }, total_token_usage: { total_tokens: 175 } } }),
    rec('event_msg', { type: 'task_complete' }),
  ]],
  ['CRLF + response-before-event carrier alias + images', [responseUser('a\r\nb'), user('a\n\nb'),
    rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'photo' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }),
    rec('event_msg', { type: 'user_message', message: 'photo', local_images: ['/owned/p.png'] }), answer('paired'),
  ]],
  ['compact companion + token baseline + postcompact owner', [user('before'), rec('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 300 } } }),
    rec('compacted', { message: 'own compact', replacement_history: [{ role: 'assistant', content: [{ text: special.repeat(20) }] }] }),
    rec('event_msg', { type: 'context_compacted' }), user('after'), answer('new'),
  ]],
  ['subagent launch/settlement and semantic docs edits', [user('implement'),
    call('spawn', 'spawn_agent', { agent_type: 'explorer', message: 'inspect owned source', nickname: 'helper' }),
    output('spawn', { agent_id: 'a0000000-0000-0000-0000-000000000001', nickname: 'Own helper' }),
    rec('response_item', { type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: docs/owned.md\n+owned\n*** End Patch' }),
    call('search', 'mcp__knowledge__docs_search', { query: 'owned finite query' }),
    rec('event_msg', { type: 'patch_apply_end', call_id: 'patch', success: true, changes: { 'docs/owned.md': { type: 'add', diff: '+owned' } } }),
    output('patch', 'done'), answer('finished'),
  ]],
  ['native question definition and exact reply proof', [user('ask'), call('question', 'request_user_input_async', { questions: [{ title: 'Choose Ω🙂', options: ['A', 'B'] }] }),
    user('<send_user_message_question_reply>\n' + JSON.stringify([{ answer: special, question: 'Choose Ω🙂', questionItemId: JSON.stringify(['request_user_input_async', 'question', 0]) }]) + '\n</send_user_message_question_reply>'), answer('ack'),
  ]],
  ['service envelopes/rollback/interrupted/untyped preview', [user('<environment_context>env</environment_context>'), user('discard'), answer('discarded'),
    rec('event_msg', { type: 'thread_rolled_back', num_turns: 1 }), user('keep'), answer('pending', undefined), rec('event_msg', { type: 'task_complete' }),
    user('<TURN_ABORTED> interrupted'),
  ]],
];
for (const [name, source] of scenarios) test('rooted Timeline actual FILE differential: ' + name, async t => {
  const f = fixture(t); for (const r of source) f.append(r, '\r\n');
  const expected = f.oracle(); same(api.buildCodexTimeline(f.located, f.sessionId), expected.entries);
  if (name.startsWith('native question')) assert(expected.entries[1].questionReplyProof, 'actual native reply certificate');
  if (name.startsWith('subagent')) { assert(expected.entries[0].subAgents?.length); assert(expected.entries[0].docsEdited?.length); }
  if (name.startsWith('compact')) assert.equal(expected.entries.filter(e => e.type === 'compact').length, 1);
  if (name.startsWith('Unicode')) { assert.equal(expected.entries[0].content, special.repeat(800)); assert(expected.entries[0].responsePreview.truncated); }
  const stats = api.getCodexHistoryProjectorStats();
  const r = f.hold(await f.read()); check(r, expected); assert.equal(r.mode, 'rebuild');
  const afterStats = api.getCodexHistoryProjectorStats();
  assert.equal(afterStats.sessions, stats.sessions); assert.equal(afterStats.approxBytes, stats.approxBytes);
  const bytes = digest(mat(r.entries));
  const warm = f.hold(await f.read()); check(warm, expected); assert.equal(warm.mode, 'unchanged'); assert.equal(warm.fedRecords, 0);
  same(mat(r.entries), expected.entries); assert.equal(digest(mat(r.entries)), bytes);
  t.diagnostic(JSON.stringify({ rows: r.entries.length, digest: bytes, readMetrics: r.readMetrics, pins: pins(f.store) }));
});

test('append/pending late settlement: old roots/metadata/checkpoint frozen; checkpoint and owner restart remain rooted', async t => {
  const f = fixture(t, { header: { forked_from_id: 'ancestor', forked_from_ordinal_exclusive: 3, history_mode: 'fork', history_base: { sessionId: 'ancestor', ordinal: 3 } } });
  f.append(responseUser(special)); f.append(call('spawn', 'spawn_agent', { message: 'inspect', nickname: 'pending' }));
  const old = f.hold(await f.read()), before = { rows: mat(old.entries), meta: mat(old.sessionMeta), checkpoint: mat(old.checkpoint.cursor()) };
  const retained = f.owner.read(f.sessionId, f.dir, 0); assert(retained);
  try {
    f.append(user(special)); f.append(output('spawn', { agent_id: 'a0000000-0000-0000-0000-000000000001', nickname: 'Settled helper' })); f.append(answer('late answer')); f.append(rec('event_msg', { type: 'task_complete' }));
    const next = f.hold(await f.read()); check(next, f.oracle()); assert.equal(next.mode, 'append'); assert.equal(next.fedRecords, 4);
    const restored = new CodexRootProjectionOwner(f.store, { namespace: 'codex-timeline-v1', checkpointEvery: 2 });
    try { const from = f.hold(await f.read({ rootedOwner: restored, rootCheckpoint: retained })); check(from, f.oracle()); assert(from.reusedRecords > 0); }
    finally { restored.close(); }
    same(mat(old.entries), before.rows); same(mat(old.sessionMeta), before.meta); same(mat(old.checkpoint.cursor()), before.checkpoint);
    assert.equal(before.checkpoint.file.projectionFlavor, 'timeline'); assert(!before.checkpoint.history);
    assert(before.checkpoint.timeline.pendingSubagentCalls instanceof Map);
    assert.equal(mat(next.entries)[0].subAgents[0].label, 'inspect — Settled helper');
    assert.notEqual(before.rows[0].subAgents[0].label, mat(next.entries)[0].subAgents[0].label);
  } finally { retained.release(); }
});

test('History remains metadata-only, separate namespace, cross-flavor checkpoint never reused', async t => {
  const f = fixture(t); f.append(user('history baseline')); f.append(answer('answer'));
  const native = api.createCodexHistoryProjector(f.sessionId, {}, { canonicalStore: f.store }); f.located.forEach(native.feed);
  let expected; try { expected = native.finalize(); } finally { native.close(); }
  const h = f.hold(await f.history()); same(mat(h.entries), expected); assert.equal(h.readMetrics.timelineRows, 0);
  assert.equal(mat(h.checkpoint.cursor()).file.timeline.entries.length, 0);
  assert.throws(() => f.read({ rootedOwner: f.historyOwner }), /namespace/);
  const r = f.hold(await f.read({ rootCheckpoint: h.checkpoint })); check(r, f.oracle()); assert.equal(r.mode, 'rebuild'); assert.equal(r.reusedRecords, 0);
  const rPin = f.owner.read(f.sessionId, f.dir), hPin = f.historyOwner.read(f.sessionId, f.dir);
  try { assert.notEqual(rPin.descriptor.page, hPin.descriptor.page); } finally { rPin.release(); hPin.release(); }
  const hAgain = f.hold(await f.history({ rootCheckpoint: r.checkpoint })); same(mat(hAgain.entries), expected); assert.equal(hAgain.mode, 'rebuild');
  const warmH = f.hold(await f.history()); assert.equal(warmH.mode, 'unchanged'); same(mat(warmH.entries), expected);
});

test('partial replay/same-size rewrite/prefix rewrite+growth/truncate/inode replacement and frozen old view', async t => {
  const f = fixture(t); f.append(user('AAAA')); f.append(answer('first'));
  const old = f.hold(await f.read()), before = mat(old.entries);
  const tail = JSON.stringify(user('partial ' + special));
  fs.appendFileSync(f.filePath, tail.slice(0, 37));
  const partial = f.hold(await f.read()); assert.equal(partial.fedRecords, 0); same(mat(partial.entries), before);
  fs.appendFileSync(f.filePath, tail.slice(37) + '\n');
  const complete = f.hold(await f.read()); assert.equal(complete.fedRecords, 1); assert(complete.readMetrics.replayedPartialBytes > 0);
  for (const kind of ['same-size', 'rewrite-growth', 'truncate', 'inode']) {
    let body = fs.readFileSync(f.filePath, 'utf8');
    if (kind === 'same-size') body = body.replace('AAAA', 'BBBB');
    if (kind === 'rewrite-growth') body = body.replace('BBBB', 'CCCC') + JSON.stringify(answer('appended')) + '\n';
    if (kind === 'truncate') body = body.slice(0, body.indexOf('\n') + 1);
    if (kind === 'inode') { fs.renameSync(f.filePath, f.filePath + '.old'); body += JSON.stringify(user('new inode')) + '\n'; }
    fs.writeFileSync(f.filePath, body);
    const rebuilt = f.hold(await f.read()); assert.equal(rebuilt.mode, 'rebuild', kind);
    const located = []; let at = 0, line = 0; for (const raw of body.split(/(?<=\n)/)) { if (raw.trim()) located.push({ ...JSON.parse(raw), __byteOffset: at, __line: line++ }); at += Buffer.byteLength(raw); }
    const p = api.createCodexTimelineProjector(f.sessionId); located.forEach(p.feed); same(mat(rebuilt.entries), p.finalize()); same(mat(old.entries), before);
  }
});

test('rooted header locator uses the same store and full fork provenance remains exact', async t => {
  const f = fixture(t, { alternateName: true, header: { originator: 'x'.repeat(6000), forked_from_id: 'parent', history_base: { sessionId: 'parent', ordinal: 7 } } });
  f.append(user('owned')); const r = f.hold(await f.read()); check(r, f.oracle());
  const oldMeta = mat(r.sessionMeta); f.append(rec('session_meta', { id: 'copied-ancestor', cwd: '/ancestor' })); f.append(answer('continued'));
  const next = f.hold(await f.read()); check(next, f.oracle()); same(mat(r.sessionMeta), oldMeta);
});

test('cancel/typed invalidation/late failure release staging and preserve the prior committed root', async t => {
  const f = fixture(t); f.append(user('retained')); const old = f.hold(await f.read()), before = mat(old.entries);
  const saved = f.owner.read(f.sessionId, f.dir); const page = saved.descriptor.page; saved.release();
  f.append(answer('staged'));
  const baseline = pins(f.store);
  for (const [phase, code] of [['feed', 'HISTORY_READ_CANCELLED'], ['finalization', 'HISTORY_READ_CANCELLED'], ['publication', 'OWN_LATE_FAILURE'], ['publication', 'CODEX_SOURCE_READ_INVALIDATED']]) {
    let failed = false;
    const error = Object.assign(Error(phase + ':' + code), { code });
    await assert.rejects(f.read({ observeRoot: s => { if (s.phase === phase) { failed = true; throw error; } } }), e => e === error);
    assert(failed); assert.deepEqual(pins(f.store), baseline);
    const retained = f.owner.read(f.sessionId, f.dir); try { assert.equal(retained.descriptor.page, page); } finally { retained.release(); }
    same(mat(old.entries), before);
  }
  const cancelled = Object.assign(Error('demand cancelled'), { code: 'HISTORY_READ_CONSUMER_REVOKED' });
  let checkpoints = 0;
  await assert.rejects(f.read({ _readControl: { assertCurrent() {}, async checkpoint() { if (++checkpoints === 3) throw cancelled; } } }), e => e === cancelled);
  assert.deepEqual(pins(f.store), baseline);
  const commit = f.owner.commit;
  const late = Object.assign(Error('commit rollback'), { code: 'OWN_COMMIT_FAILURE' });
  f.owner.commit = function (id, cwd, lease, expected, checkpoints, current) {
    let n = 0; return commit.call(this, id, cwd, lease, expected, checkpoints, () => { current(); if (++n === 2) throw late; });
  };
  try { await assert.rejects(f.read(), e => e === late); } finally { f.owner.commit = commit; }
  assert.deepEqual(pins(f.store), baseline);
  const prior = f.owner.read(f.sessionId, f.dir); try { assert.equal(prior.descriptor.page, page); } finally { prior.release(); }
  let version = 0, invalidations = 0;
  api.setCodexExternalReadVersion(() => version);
  try { await assert.rejects(f.read({ observeRoot(s) { if (s.phase === 'publication') { version++; invalidations++; } } }), { code: 'CODEX_SOURCE_READ_INVALIDATED' }); }
  finally { api.setCodexExternalReadVersion(null); }
  assert.equal(invalidations, 3); assert.deepEqual(pins(f.store), baseline);
  const next = f.hold(await f.read()); check(next, f.oracle()); assert.equal(next.mode, 'append'); assert.equal(next.fedRecords, 1);
  next.release(); next.release();
  const extra = old.root.fork(); try { f.owner.evict(f.sessionId, f.dir); same(mat(extra.cursor()), before); } finally { extra.release(); }
});


test('narrow History BEFORE comparator: old unflavored continuation, metadata-only cost, append/full rows unchanged', async t => {
  const f = fixture(t), before = originalApi();
  const owner = new CodexRootProjectionOwner(f.store, { namespace: 'own-history-before-test', checkpointEvery: 2 });
  f.append(user('baseline')); f.append(call('read', 'read_file', { path: 'own.txt' })); f.append(output('read', 'result')); f.append(answer('done'));
  try {
    const options = { rootedOwner: owner, sessionsDir: f.dir, highWaterMark: 64 };
    const old = f.hold(await before.projectCodexFullHistoryFromFile(f.sessionId, f.dir, options));
    const oldCheckpoint = mat(old.checkpoint.cursor()); assert.equal(oldCheckpoint.file.projectionFlavor, undefined);
    assert.equal(oldCheckpoint.file.timeline.entries.length, 0);
    const current = f.hold(await f.history({ rootedOwner: owner })); assert.equal(current.mode, 'unchanged'); assert.equal(current.fedRecords, 0);
    same(mat(current.entries), mat(old.entries)); same(mat(current.sessionMeta), mat(old.sessionMeta));
    f.append(user('next')); f.append(answer('next answer'));
    const expected = f.hold(await before.projectCodexFullHistoryFromFile(f.sessionId, f.dir, options));
    const appended = f.hold(await f.history({ rootedOwner: owner, rootCheckpoint: current.checkpoint }));
    assert.equal(appended.mode, 'append'); assert.equal(appended.fedRecords, 2);
    same(mat(appended.entries), mat(expected.entries)); same(mat(appended.sessionMeta), mat(expected.sessionMeta));
    assert.equal(appended.readMetrics.timelineRows, 0); assert.equal(mat(appended.checkpoint.cursor()).file.timeline.entries.length, 0);
  } finally { before.invalidateJsonlCache(f.filePath); owner.close(); }
});
