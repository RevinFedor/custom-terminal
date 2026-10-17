'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _api } = require('./ipc/codex-data');
const { createCodexResultReader } = require('./codex-result-reader');
const { projectResultText, summarizeResultText } = require('./codex-result-text');

const event = (type, extra = {}) => ({ type: 'event_msg', timestamp: '2026-09-14T02:00:00Z', payload: { type, ...extra } });
const message = (role, text, extra = {}) => ({ type: 'response_item', timestamp: '2026-09-14T02:00:00Z',
  payload: { type: 'message', role, content: [{ type: 'output_text', text }], ...extra } });
const encode = records => records.map(record => JSON.stringify(record) + '\n').join('');
const context = { provider: 'codex', sessionId: 'S', turnId: 'T', generation: 3 };
function makeReader(options = {}) {
  return createCodexResultReader({ readJsonlRange: _api.readJsonlRange,
    createTimelineProjector: _api.createCodexTimelineProjector,
    buildResult: _api.buildCodexProviderTurnAssistantResult, extractText: _api.extractTextContent,
    userIdentity: _api.getCodexUserRecordIdentity,
    isCompactPayload: _api.isCompactPayload, extractReasoning: _api.extractReasoning,
    findExecutionContext: _api.findCodexPromptExecutionContext,
    collectLegacy: _api.collectCodexTurnAssistantBlocks,
    log: { log() {} }, ...options });
}
function fixture(t, records, { sessionId = 'S', reader = makeReader() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-result-reader-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const file = path.join(dir, 'rollout.jsonl'); fs.writeFileSync(file, encode(records));
  const resolveSource = async () => {
    const stat = await fs.promises.stat(file);
    return { success: true, sessionId, revisionKey: file, sourceSnapshot: { filePath: file, size: stat.size,
      mtimeMs: stat.mtimeMs, sessionId }, segments: [{ filePath: file, physicalSessionId: sessionId,
        fromByte: 0, toByte: stat.size, startLine: 0, frozen: false }] };
  };
  const load = (proof, options = {}) => reader.load({ sessionId, cwd: dir, proof, maxChars: 100000, resolveSource, ...options });
  return { file, reader, load, resolveSource,
    append: records => fs.appendFileSync(file, encode(records)),
    batch: async (proof, maxChars = 100000, options = {}) => {
      const data = await _api.readJsonlRange(file, 0, fs.statSync(file).size - 1);
      return _api.buildCodexProviderTurnAssistantResult(data.records, sessionId, proof, maxChars, options);
    } };
}
const pure = result => { const { sourceSnapshot, sourceVerified, ...value } = result; return value; };
const proofAt = index => ({ targetExecutionContext: context, promptUserUuid: 'codex-user-S-' + index });

test('passive completed reader uses verified structural/text caches only and marks stale/cold evidence', async t => {
  const rows = [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }),
    message('assistant', 'answer'.repeat(500)), event('task_complete', { turn_id: 'T', last_agent_message: 'answer'.repeat(500) })];
  const f = fixture(t, rows);
  const request = { sessionId: 'S', cwd: path.dirname(f.file), readSourceRevision: () => f.file };
  assert.equal((await f.reader.readCachedCompleted(request)).reason, 'result_cache_cold');
  await f.load(proofAt(1));
  const before = f.reader.stats();
  let result = await f.reader.readCachedCompleted(request);
  assert.equal(result.known, true); assert.equal(result.complete, true);
  assert.equal(result.ref.targetExecutionContext.turnId, 'T'); assert.ok(result.assistantText.length <= 2000);
  assert.equal(f.reader.stats().bytesRead, before.bytesRead); assert.equal(f.reader.stats().bodyBytesRead, before.bodyBytesRead);
  assert.equal(f.reader.stats().verificationBytes, before.verificationBytes);
  f.append([event('task_started', { turn_id: 'B' }), event('user_message', { message: 'next' })]);
  assert.equal((await f.reader.readCachedCompleted(request)).reason, 'result_cache_stale');
  await f.reader.loadLatestObservedExecution({ sessionId: 'S', cwd: request.cwd, resolveSource: f.resolveSource });
  result = await f.reader.readCachedCompleted(request);
  assert.equal(result.known, true); assert.equal(result.ref.targetExecutionContext.turnId, 'T');
  assert.equal((await f.reader.readCachedCompleted({ ...request, readSourceRevision: () => 'changed' })).reason, 'result_lineage_unverified');
  f.reader.invalidate(f.file);
  assert.equal((await f.reader.readCachedCompleted(request)).reason, 'result_cache_cold');
});

test('passive final does not cross rollback, same-size rewrite, or missing cached text', async t => {
  const rows = [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }),
    message('assistant', 'answer'), event('task_complete', { turn_id: 'T', last_agent_message: 'answer' })];
  for (const change of ['rollback', 'rewrite', 'evicted']) {
    const f = fixture(t, rows, { reader: makeReader(change === 'evicted' ? { maxTextBytes: 0 } : {}) });
    await f.load(proofAt(1));
    if (change === 'rollback') {
      f.append([event('thread_rolled_back', { num_turns: 1 })]);
      await f.reader.loadLatestObservedExecution({ sessionId: 'S', cwd: path.dirname(f.file), resolveSource: f.resolveSource });
    }
    if (change === 'rewrite') fs.writeFileSync(f.file, encode(rows).replaceAll('answer', 'change'));
    const result = await f.reader.readCachedCompleted({ sessionId: 'S', cwd: path.dirname(f.file), readSourceRevision: () => f.file });
    assert.equal(result.known, false, change); assert.equal(result.assistantText, undefined);
  }
});

for (const warm of [false, true]) for (const replacementKind of ['inode', 'same-inode']) {
test('final source resolution rejects a physical replacement after I/O, warm=' + warm + ', ' + replacementKind, async t => {
  const rows = [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }),
    message('assistant', 'first'), event('task_complete', { turn_id: 'T', last_agent_message: 'first' })];
  const f = fixture(t, rows), proof = proofAt(1);
  if (warm) assert.equal((await f.load(proof)).assistantText, 'first');
  let calls = 0;
  const resolveSource = async () => {
    if (++calls === 2) {
      if (replacementKind === 'inode') {
        const replacement = f.file + '.replacement';
        fs.writeFileSync(replacement, encode(rows).replaceAll('first', 'other'));
        fs.renameSync(replacement, f.file);
      } else {
        const stat = fs.statSync(f.file);
        fs.writeFileSync(f.file, encode(rows).replaceAll('first', 'other'));
        fs.utimesSync(f.file, stat.atime, stat.mtime);
      }
    }
    return f.resolveSource();
  };
  const result = await f.load(proof, { resolveSource });
  assert.equal(result.assistantText, 'other');
  assert.deepEqual(pure(result), await f.batch(proof));
});
}

test('an explicitly unverified source descriptor cannot authorize a final result', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }),
    message('assistant', 'answer'), event('task_complete', { turn_id: 'T', last_agent_message: 'answer' })]);
  const result = await f.load(proofAt(1), { resolveSource: async () => ({ ...await f.resolveSource(), digestsVerified: false }) });
  assert.equal(result.success, false);
  assert.equal(result.sourceVerified, false);
  assert.equal(result.error, 'result-source-digests-unverified');
});

for (const [name, terminal] of [
  ['abort', event('turn_aborted', { turn_id: 'T' })],
  ['empty final', event('task_complete', { turn_id: 'T', last_agent_message: '' })],
  ['provider error', event('task_complete', { turn_id: 'T', error: { codex_error_info: 'server_overloaded', message: 'model at capacity' } })],
]) test('rewrite plus growth cannot fabricate a terminal decision: ' + name, async t => {
  const rows = [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'working')];
  const f = fixture(t, rows), proof = proofAt(1);
  await f.load(proof);
  fs.writeFileSync(f.file, encode(rows).replace('"turn_id":"T"', '"turn_id":"U"') + encode([terminal]));
  assert.deepEqual(pure(await f.load(proof)), await f.batch(proof));
});

test('observing completed A during 1000 appends of B has no historical SHA cost and grants no authority', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }),
    message('assistant', 'answer'), event('task_complete', { turn_id: 'T', last_agent_message: 'answer' })]);
  const proof = proofAt(1); await f.load(proof);
  f.append([event('task_started', { turn_id: 'B' }), event('user_message', { message: 'another task' })]);
  const before = f.reader.stats();
  for (let i = 0; i < 1000; i++) {
    f.append([{ type: 'response_item', payload: { type: 'function_call_output', call_id: String(i), output: 'x'.repeat(128) } }]);
    const candidate = await f.load(proof, { resultReadMode: 'observe' });
    assert.equal(candidate.complete, true);
    assert.equal(candidate.sourceVerified, false);
  }
  assert.equal(f.reader.stats().verificationBytes, before.verificationBytes);
  assert.equal(f.reader.stats().bootstraps, before.bootstraps);
  const authoritative = await f.load(proof);
  assert.equal(authoritative.complete, true);
  assert.equal(authoritative.sourceVerified, true);
  assert.ok(f.reader.stats().verificationBytes > before.verificationBytes);
});

test('source handoff can verify an open prompt without waiting for terminal completion', async t => {
  const rows = [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'notification' }), message('assistant', 'processing')];
  const f = fixture(t, rows), proof = proofAt(1);
  const observed = await f.load(proof);
  assert.equal(observed.complete, false);
  assert.equal(observed.sourceVerified, false);
  assert.equal(f.reader.stats().verificationBytes, 0);
  const handoff = await f.load(proof, { resultReadMode: 'prompt-proof' });
  assert.equal(handoff.success, true);
  assert.equal(handoff.complete, false);
  assert.equal(handoff.sourceVerified, true);
  assert.ok(f.reader.stats().verificationBytes > 0);
  fs.writeFileSync(f.file, encode(rows).replace('"turn_id":"T"', '"turn_id":"U"')
    + encode([{ type: 'response_item', payload: { type: 'function_call_output', output: 'next' } }]));
  const rewritten = await f.load(proof, { resultReadMode: 'prompt-proof' });
  assert.equal(rewritten.success, false);
  assert.equal(rewritten.sourceVerified, false);
});

test('a rewrite retry reports all SHA work in the request, including its rejected attempt', async t => {
  const logs = [], reader = makeReader({ log: { log: text => logs.push(text) } });
  const rows = [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'first')];
  const f = fixture(t, rows, { reader }), proof = proofAt(1);
  await f.load(proof);
  const before = reader.stats();
  fs.writeFileSync(f.file, encode(rows).replaceAll('first', 'other')
    + encode([event('task_complete', { turn_id: 'T', last_agent_message: 'other' })]));
  assert.equal((await f.load(proof)).assistantText, 'other');
  assert.equal(Number(/verifyBytes=(\d+)/.exec(logs.at(-1))[1]), reader.stats().verificationBytes - before.verificationBytes);
  assert.equal(Number(/readBytes=(\d+)/.exec(logs.at(-1))[1]), reader.stats().bytesRead - before.bytesRead);
});

test('explicit final read proves absence too, so prefix rewrite cannot hide an existing result', async t => {
  const rows = [event('task_started', { turn_id: 'U' }), event('user_message', { message: 'go' }),
    message('assistant', 'answer'), event('task_complete', { turn_id: 'U', last_agent_message: 'answer' })];
  const f = fixture(t, rows), proof = proofAt(1);
  assert.equal((await f.load(proof)).success, false);
  fs.writeFileSync(f.file, encode(rows).replaceAll('"turn_id":"U"', '"turn_id":"T"')
    + encode([{ type: 'response_item', payload: { type: 'function_call_output', output: 'append' } }]));
  const result = await f.load(proof, { resultReadMode: 'source-proof' });
  assert.equal(result.complete, true);
  assert.equal(result.sourceVerified, true);
});

for (const [name, rows, index] of [
  ['ordinary completion', [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'answer'), event('task_complete', { turn_id: 'T', last_agent_message: 'answer' })], 1],
  ['pre-start response carrier', [message('user', 'go'), event('task_started', { turn_id: 'T' }), message('assistant', 'one'), event('user_message', { message: 'go' }), message('assistant', 'two'), event('task_complete', { turn_id: 'T', last_agent_message: 'two' })], 0],
  ['abort keeps partial text but never success', [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'partial'), event('turn_aborted', { turn_id: 'T' })], 1],
  ['empty final is not success', [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), event('task_complete', { turn_id: 'T', last_agent_message: '' })], 1],
  ['typed provider error wins over prior answer', [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'partial'), event('task_complete', { turn_id: 'T', last_agent_message: 'partial', error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity. Please try a different model.' } })], 1],
  ['compact and subagent service stay in same result', [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'before'), { type: 'compacted', payload: { replacement_history: ['private raw payload'] } }, event('user_message', { message: '<subagent_notification>done</subagent_notification>' }), message('assistant', 'after'), event('task_complete', { turn_id: 'T', last_agent_message: 'after' })], 1],
  ['new turn closes unproven old one', [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'old'), event('task_started', { turn_id: 'other' }), event('user_message', { message: 'next' }), message('assistant', 'not ours')], 1],
  ['duplicate provider id anywhere is ambiguous', [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'old'), event('task_complete', { turn_id: 'T', last_agent_message: 'old' }), event('task_started', { turn_id: 'T' })], 1],
]) test('stream/batch parity: ' + name, async t => {
  const f = fixture(t, rows), proof = proofAt(index);
  assert.deepEqual(pure(await f.load(proof)), await f.batch(proof));
});

test('1000 ordinary busy tool appends read only new bytes and never touch raw/projector caches', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'working')]);
  const proof = proofAt(1), initial = pure(await f.load(proof));
  const before = f.reader.stats();
  let bytes = 0;
  for (let i = 0; i < 1000; i++) {
    const text = encode([{ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c' + i, output: 'x'.repeat(8192) } }]);
    fs.appendFileSync(f.file, text); bytes += Buffer.byteLength(text);
    assert.deepEqual(pure(await f.load(proof)), initial);
  }
  const after = f.reader.stats();
  assert.equal(after.bootstraps, 1); assert.equal(after.bytesRead - before.bytesRead, bytes);
  assert.equal(after.records, before.records); assert.equal(after.verificationBytes, 0);
  assert.equal(_api.getCodexJsonlCacheStats().files, 0);
  f.append([message('assistant', 'final'), event('task_complete', { turn_id: 'T', last_agent_message: 'final' })]);
  assert.deepEqual(pure(await f.load(proof, { forceFresh: true })), await f.batch(proof));
  const final = f.reader.stats(); await f.load(proof, { forceFresh: true });
  assert.equal(f.reader.stats().bytesRead, final.bytesRead);
  assert.equal(f.reader.stats().verificationBytes, final.verificationBytes);
});

test('late alias/UTF-8 partial line and terminal append are adopted exactly once', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), message('user', 'привет'), message('assistant', 'начало')]);
  const proof = proofAt(1); await f.load(proof);
  const appended = Buffer.from(encode([event('user_message', { message: 'привет' }), message('assistant', 'конец'), event('task_complete', { turn_id: 'T', last_agent_message: 'конец' })]));
  const split = appended.indexOf(Buffer.from('привет')) + 1;
  fs.appendFileSync(f.file, appended.subarray(0, split));
  assert.equal((await f.load(proof)).complete, false);
  fs.appendFileSync(f.file, appended.subarray(split));
  assert.deepEqual(pure(await f.load(proof)), await f.batch(proof));
});

test('source replacement/same-size restored-mtime rewrite discards old body samples and proof', async t => {
  const rows = [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'first'), event('task_complete', { turn_id: 'T', last_agent_message: 'first' })];
  const f = fixture(t, rows), proof = proofAt(1); assert.equal((await f.load(proof)).assistantText, 'first');
  const stat = fs.statSync(f.file); fs.writeFileSync(f.file, encode(rows).replaceAll('first', 'other'));
  fs.utimesSync(f.file, stat.atime, stat.mtime);
  assert.deepEqual(pure(await f.load(proof, { forceFresh: true })), await f.batch(proof));
  assert.equal((await f.load(proof)).assistantText, 'other');
});

test('rewrite plus growth cannot publish a definitive result from an unchanged prefix assumption', async t => {
  const rows = [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'first')];
  const f = fixture(t, rows), proof = proofAt(1); await f.load(proof);
  fs.writeFileSync(f.file, encode(rows).replaceAll('first', 'other') + encode([event('task_complete', { turn_id: 'T', last_agent_message: 'other' })]));
  assert.deepEqual(pure(await f.load(proof)), await f.batch(proof));
  assert.equal((await f.load(proof)).assistantText, 'other');
});

test('time-only recovery stays on the named provider turn', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'resumed' }), message('assistant', 'ours'), event('task_complete', { turn_id: 'T', last_agent_message: 'ours' }), event('task_started', { turn_id: 'B' }), event('user_message', { message: 'later' }), message('assistant', 'not ours')]);
  const proof = { targetExecutionContext: context, resultAfterAt: Date.parse('2026-09-14T01:59:59Z') };
  assert.deepEqual(pure(await f.load(proof)), await f.batch(proof, 100000, { allowTimeOnly: true }));
  assert.equal((await f.load(proof)).assistantText, 'ours');
});

test('large result projection preserves first/final excerpts and full length', async t => {
  const blocks = ['first '.repeat(60000), 'middle '.repeat(80000), 'last '.repeat(70000)];
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), ...blocks.map(text => message('assistant', text)), event('task_complete', { turn_id: 'T', last_agent_message: 'done' })], { reader: makeReader({ maxTextBytes: 600000 }) });
  for (const maxChars of [500, 10000, 250000]) assert.deepEqual(pure(await f.load(proofAt(1), { maxChars })), await f.batch(proofAt(1), maxChars));
  assert.ok(f.reader.stats().textBytes <= 600000);
  assert.deepEqual(projectResultText(blocks.map(summarizeResultText), 500, 250000),
    { assistantText: 'first '.repeat(60000).trim().slice(0, 175).trimEnd() + '\n…\n' + 'last '.repeat(70000).trim().slice(-322).trimStart(),
      assistantChars: blocks.reduce((sum, value) => sum + value.trim().length, 0) + 4, truncated: true });
});

test('time-only recovery does not adopt later provider-owned context/goal carriers', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'resumed' }),
    message('user', '<environment_context>service</environment_context>'),
    message('user', '<codex_internal_context source="goal">continue</codex_internal_context>'),
    message('assistant', 'ours'), event('task_complete', { turn_id: 'T', last_agent_message: 'ours' })]);
  const result = await f.load({ targetExecutionContext: context, resultAfterAt: Date.parse('2026-09-14T01:59:59Z') });
  assert.equal(result.success, true); assert.equal(result.userUuid, 'codex-user-S-1');
  assert.equal(result.assistantText, 'ours'); assert.equal(result.complete, true);
});

test('record-consumer failure propagates, never becomes a swallowed JSON parse error', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' })]);
  await assert.rejects(_api.readJsonlRange(f.file, 0, fs.statSync(f.file).size - 1,
    { collectRecords: false, onRecord() { throw new Error('consumer failed'); } }), /consumer failed/);
});

test('lineage identity changed during I/O cannot commit the old view', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'ours'), event('task_complete', { turn_id: 'T', last_agent_message: 'ours' })]);
  let calls = 0;
  const resolveSource = async () => ({ ...await f.resolveSource(), revisionKey: ++calls === 1 ? 'old-lineage' : 'current-lineage' });
  const result = await f.load(proofAt(1), { resolveSource });
  assert.equal(result.complete, true); assert.equal(f.reader.stats().bootstraps, 2);
  assert.equal(calls, 4);
});

test('source resolver cannot substitute another session', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' })]);
  const result = await f.load(proofAt(0), { resolveSource: async () => ({ ...await f.resolveSource(), viewOwnerSessionId: 'other' }) });
  assert.equal(result.success, false); assert.equal(result.error, 'result-source-session-mismatch');
  assert.equal(f.reader.stats().bytesRead, 0);
});

test('bounded text copies preserve UTF-16 code units, including a surrogate at the excerpt boundary', () => {
  const text = 'answer ' + String.fromCharCode(0xd800) + ' tail';
  const sample = summarizeResultText(text);
  assert.equal(sample.head, text); assert.equal(sample.tail, text);
  assert.equal(projectResultText([sample], 500, 250000).assistantText, text);
});

test('writer invalidation during a read cannot publish its staged cursor; retry adopts once', async t => {
  let signal, release;
  const started = new Promise(resolve => { signal = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let paused = false;
  const reader = makeReader({ readJsonlRange: (file, start, end, options = {}) => _api.readJsonlRange(file, start, end, {
    ...options, onRecord: options.onRecord && (async (record, locator) => {
      await options.onRecord(record, locator);
      if (!paused) { paused = true; signal(); await held; }
    }),
  }) });
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'ours'), event('task_complete', { turn_id: 'T', last_agent_message: 'ours' })], { reader });
  const pending = f.load(proofAt(1)); await started; reader.invalidate(f.file); release();
  assert.equal((await pending).success, false); assert.equal(reader.stats().views, 0);
  const result = await f.load(proofAt(1));
  assert.equal(result.complete, true); assert.equal(result.assistantText, 'ours');
  assert.equal(result.assistantBlockCount, 1);
});

test('recovery preserves legacy timestamp aliases instead of assigning present time to an old prompt', async t => {
  for (const key of ['time', 'created_at']) {
    const user = event('user_message', { message: 'old prompt' });
    delete user.timestamp; user[key] = '2020-01-01T00:00:00Z';
    const f = fixture(t, [event('task_started', { turn_id: 'T' }), user, message('assistant', 'old result'), event('task_complete', { turn_id: 'T', last_agent_message: 'old result' })]);
    const proof = { targetExecutionContext: context, resultAfterAt: Date.parse('2026-09-14T01:59:59Z') };
    const result = await f.load(proof);
    assert.deepEqual(pure(result), await f.batch(proof, 100000, { allowTimeOnly: true }));
    assert.equal(result.success, false);
  }
});

test('forceFresh while a turn is open does not hash its prefix on each status/wake', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'working')]);
  const proof = proofAt(1); await f.load(proof, { forceFresh: true });
  for (let i = 0; i < 100; i++) {
    f.append([{ type: 'response_item', payload: { type: 'function_call_output', output: 'step ' + i } }]);
    assert.equal((await f.load(proof, { forceFresh: true })).complete, false);
  }
  assert.equal(f.reader.stats().bootstraps, 1);
  assert.equal(f.reader.stats().verificationBytes, 0);
});

test('historical bootstrap can prove a physical result without inventing live generation', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'ours'), event('task_complete', { turn_id: 'T', last_agent_message: 'ours' })]);
  const proof = { ...proofAt(1), targetExecutionContext: { ...context, generation: null } };
  assert.equal((await f.batch(proof)).success, false, 'known-execution reader stays strict');
  const historical = await f.batch(proof, 100000, { allowHistoricalGenerationUnknown: true });
  assert.equal(historical.complete, true); assert.equal(historical.providerGeneration, null);
  assert.equal(historical.proofMode, 'historical-provider-turn');
  assert.equal((await f.batch({ targetExecutionContext: proof.targetExecutionContext, promptHash: 'unknown' }, 100000,
    { allowHistoricalGenerationUnknown: true })).success, false, 'historical mode requires the recovered physical prompt identity');
});

test('unbound Retry/restart bootstraps the actual turn and stays incremental without binding live generation', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'working')]);
  const proof = { promptUserUuid: 'codex-user-S-1' };
  const initial = await f.load(proof);
  assert.equal(initial.success, true); assert.equal(initial.complete, false);
  assert.equal(initial.executionContext.turnId, 'T'); assert.equal(initial.executionContext.generation, null);
  const before = f.reader.stats(); let bytes = 0;
  for (let i = 0; i < 100; i++) {
    const text = encode([{ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(4096) } }]);
    fs.appendFileSync(f.file, text); bytes += Buffer.byteLength(text);
    assert.equal((await f.load(proof, { forceFresh: true })).complete, false);
  }
  assert.equal(f.reader.stats().bootstraps, 1);
  assert.equal(f.reader.stats().bytesRead - before.bytesRead, bytes);
  f.append([event('task_complete', { turn_id: 'T', last_agent_message: 'working' })]);
  assert.equal((await f.load(proof)).complete, true);
});

test('unbound time-only recovery sees newer tool/thinking work and cannot take an older finished answer', async t => {
  for (const evidence of [
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call', name: 'exec', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] } },
  ]) {
    const f = fixture(t, [event('task_started', { turn_id: 'old' }), event('user_message', { message: 'older' }), message('assistant', 'old answer'), event('task_complete', { turn_id: 'old', last_agent_message: 'old answer' }),
      event('task_started', { turn_id: 'new' }), event('user_message', { message: 'newer' }), evidence]);
    const proof = { resultAfterAt: Date.parse('2026-09-14T01:59:59Z') };
    const pending = await f.load(proof);
    assert.notEqual(pending.complete, true); assert.equal(pending.executionContext.turnId, 'new');
    f.append([message('assistant', 'new answer'), event('task_complete', { turn_id: 'new', last_agent_message: 'new answer' })]);
    const completed = await f.load(proof);
    assert.equal(completed.complete, true); assert.equal(completed.assistantText, 'new answer');
  }
});

test('rollback after a cached result updates canonical coordinates and unbound selection', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'answer'), event('task_complete', { turn_id: 'T', last_agent_message: 'answer' })]);
  await f.load(proofAt(1)); await f.load({ promptUserUuid: 'codex-user-S-1' });
  f.append([event('thread_rolled_back', { num_turns: 1 })]);
  assert.deepEqual(pure(await f.load(proofAt(1))), await f.batch(proofAt(1)));
  assert.equal((await f.load({ promptUserUuid: 'codex-user-S-1' })).success, false);
});

test('unrelated malformed prefix preserves shared parser behavior and physical line identity', async t => {
  const f = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), message('assistant', 'answer'), event('task_complete', { turn_id: 'T', last_agent_message: 'answer' })]);
  fs.writeFileSync(f.file, '{malformed unrelated old line}\n' + fs.readFileSync(f.file, 'utf8'));
  const result = await f.load(proofAt(2));
  assert.deepEqual(pure(result), await f.batch(proofAt(2)));
  assert.equal(result.complete, true); assert.equal(f.reader.stats().parseErrors, 1);
});

test('a modern pre-start carrier stays pending, then adopts the real start and late canonical alias', async t => {
  const f = fixture(t, [message('user', 'go')]);
  const proof = { promptUserUuid: 'codex-user-S-0' };
  assert.notEqual((await f.load(proof)).complete, true);
  f.append([event('task_started', { turn_id: 'T' }), message('assistant', 'answer'), event('user_message', { message: 'go' }), event('task_complete', { turn_id: 'T', last_agent_message: 'answer' })]);
  const result = await f.load(proof);
  assert.equal(result.complete, true); assert.equal(result.assistantText, 'answer');
  assert.equal(result.executionContext.turnId, 'T'); assert.equal(result.executionContext.generation, null);
  assert.equal(f.reader.stats().bootstraps, 1);
});

test('modern terminal ID without its task_started cannot fall through ID-less compatibility', async t => {
  const f = fixture(t, [event('user_message', { message: 'go' }), message('assistant', 'answer'), event('task_complete', { turn_id: 'T', last_agent_message: 'answer' })]);
  const result = await f.load({ promptUserUuid: 'codex-user-S-0' });
  assert.equal(result.complete, false); assert.equal(result.pending, true);
});

test('ID-less late canonical alias cannot hide its terminal error beyond another user boundary', async t => {
  const f = fixture(t, [message('user', 'A'), message('assistant', 'partial A'),
    event('user_message', { message: 'B' }), event('user_message', { message: 'A' }),
    event('task_complete', { error: { codex_error_info: 'quota', message: 'quota exhausted' } })]);
  const result = await f.load({ promptUserUuid: 'codex-user-S-0' });
  assert.equal(result.complete, false); assert.equal(result.terminalEvent, 'provider_error');
});
