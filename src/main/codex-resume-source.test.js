'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexResumeSourceReader } = require('./codex-resume-source');
const { resolveCodexSourceSettingsProof } = require('./codex-source-settings');
const { createHistoryPreparationActivity } = require('./history-preparation-activity');
const api = require('./ipc/codex-data')._api;

const SID = '11111111-2222-4333-8444-555555555555';
const meta = (patch = {}) => ({ type: 'session_meta', payload: { id: SID, ...patch } });
const settings = (model = 'gpt-5.6-luna', effort = 'max') => ({ type: 'turn_context', payload: { model, effort } });
const event = (type, patch = {}) => ({ type: 'event_msg', payload: { type, ...patch } });
const user = message => event('user_message', { message });
const response = text => ({ type: 'response_item', payload: { type: 'message', role: 'user',
  content: [{ type: 'input_text', text }] } });
const jsonl = records => records.map(record => JSON.stringify(record) + '\n').join('');
const quiet = { log() {}, warn() {} };

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-resume-source-'));
  const filePath = path.join(root, 'rollout-' + SID + '.jsonl');
  fs.writeFileSync(filePath, '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let currentPath = filePath;
  const activity = createHistoryPreparationActivity({ minBytes: 1 });
  const reader = createCodexResumeSourceReader({
    findSessionFile: async () => ({ filePath: currentPath }),
    readJsonlRange: api.readJsonlRange, createTimelineProjector: api.createCodexTimelineProjector,
    activity, log: quiet, ...options,
  });
  return { root, filePath, reader, activity, setPath: next => { currentPath = next; },
    write: records => fs.writeFileSync(filePath, jsonl(records)),
    load: opts => reader.load(SID, root, { forceProjection: true, ...opts }) };
}

async function parity(h, opts) {
  const actual = await h.load(opts);
  assert.equal(actual.success, true, actual.error);
  const stat = fs.statSync(h.filePath);
  const raw = await api.readJsonlRange(h.filePath, 0, stat.size - 1);
  assert.deepEqual(actual.sourceSettingsProof, resolveCodexSourceSettingsProof(raw.records, SID));
  assert.deepEqual(actual.sourceMaterialization, api.inspectConversationMaterialization(raw.records, SID));
  assert.equal(actual.parsedRecords, raw.parsed);
  assert.equal(actual.parseErrors, raw.errors);
  assert.equal(actual.partialBytes, raw.leftoverBuffer.length);
  assert.equal(Object.hasOwn(actual, 'records'), false);
  return actual;
}

test('projected and small shared-reader paths retain batch settings/materialization semantics', async t => {
  const cases = [
    [], [meta()], [meta(), settings(), user('ordinary')],
    [meta(), meta({ id: 'copied-ancestor' }), settings()],
    [meta({ id: 'wrong' }), meta(), settings(), user('foreign')],
    [meta({ session_id: 'wrong' }), settings(), user('id still matches materialization')],
    [{ type: 'session_meta', payload: null }, meta(), settings()],
    [meta(), settings(), settings('new', null)],
    [meta(), settings(), event('thread_settings_applied', { thread_settings: { model: 'new', effort: 'low', reasoning_effort: 'high' } })],
    [meta(), settings(), event('thread_settings_applied', { thread_settings: { model: 'new', reasoning_effort: ' ULTRA ' } })],
    [meta(), settings(), response('same'), user('same'), event('task_complete'), user('next')],
    [meta(), response('before-start'), event('task_started'), user('before-start'), event('task_complete')],
    [meta(), user('<environment_context>\nsource\n</environment_context>'),
      response('# AGENTS.md instructions for /fixture\n<INSTRUCTIONS>local</INSTRUCTIONS>'),
      user('<subagent_notification>done</subagent_notification>'), user('<turn_aborted>\ninterrupted')],
    [meta(), user('<codex_internal_context source="goal">continue</codex_internal_context>')],
    [meta(), settings(), user('first'), event('task_complete'), user('second'), event('task_complete'),
      user('third'), event('thread_rolled_back', { num_turns: 2 }), response('first')],
    [meta(), response('first'), response('pending'), event('thread_rolled_back', { num_turns: 1 }), user('first')],
    [meta(), settings(), { type: 'compacted', payload: { replacement_history: [response('not a new user')] } }],
    [meta(), settings(), user('a'), { type: 'compacted', payload: { replacement_history: [response('a')] } },
      event('context_compacted'), user('b'), event('thread_rolled_back', { num_turns: 2 })],
    [meta({ forked_from_id: 'ancestor', timestamp: '2026-09-19T00:00:00Z', history_base: { session_id: 'ancestor' } }),
      meta({ id: 'ancestor' }), response('copied source'), user('copied source'),
      { type: 'compacted', payload: { message: 'compact' } },
      user('<environment_context>service</environment_context>'),
      event('compact_completed'), event('task_started', { started_at: 1789776001 }),
      response('live'), user('live'), event('thread_rolled_back', { num_turns: 1 }), response('copied source')],
    [meta(), { type: 'compacted', payload: {} }, event('compact_started'),
      event('service', { name: 'compacted' }), user('a'), event('thread_rolled_back', { num_turns: 2 })],
    [meta(), settings(), response('Русский 🙂 日'), user('Русский 🙂 日')],
    [meta(), { type: 'response_item', payload: { role: 'user', type: 'message', content: [
      { type: 'input_image', image_url: 'data:image/png;base64,XXXX' },
      { text: 'caption' }, { imageUrl: 'data:image/png;base64,YY' }, ' end', { value: ' value' },
    ] } }],
  ];
  for (let index = 0; index < cases.length; index++) await t.test('case ' + index, async t => {
    const h = fixture(t); h.write(cases[index]);
    await parity(h, { highWaterMark: 7 });
    h.reader.clear();
    await parity(h, { forceProjection: false, highWaterMark: 11 });
  });
});

test('validates ignored JSON, reordered/escaped/duplicate keys and does not recognize fake nested settings', async t => {
  const h = fixture(t);
  fs.writeFileSync(h.filePath, jsonl([meta(), settings()]) + [
    '{"payload":{"output":"\\\"type\\\":\\\"turn_context\\\"", "type":"function_call_output"},"type":"response_item"}',
    '{"payload":{"model":"new","effort":"medium"},"type":"ignored","type":"turn_context"}',
    '{"t\\u0079pe":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"unicode🙂","effort":"max"}}}',
    '{"type":"turn_context","payload":{"model":"invalid","effort":"high"},"ignored":{"trailing":true,}}',
    '{"type":"turn_context","payload":{"model":"invalid","effort":"high"},"ignored":"bad\\q"}',
    '{"type":"turn_context","payload":{"model":"invalid","effort":"high"},"ignored":[1,]}',
    '{"type":"turn_context","payload":{"model":"invalid","effort":"high"},"ignored":tru}',
    '{"type":"turn_context","payload":{"model":"invalid","effort":"high"},"ignored":"unclosed}',
    'null', '42', '"string"', '[]', '   ', '',
    '\ufeff' + JSON.stringify(settings('trimmed', 'low')) + '\u00a0\v\f\u3000',
    '\u2001 42\u202f', '\ufeff\u3000',
    '{"ignored":\u00a042}',
  ].join('\n') + '\n');
  const result = await parity(h, { highWaterMark: 3 });
  assert.equal(result.sourceSettingsProof.model, 'trimmed');
  assert.equal(result.parseErrors, 6);
});

test('randomized nested/duplicate/prototype/escaped JSON corpus matches batch across byte splits', async t => {
  let seed = 0x91c0de;
  const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const strings = ['🙂 Русский 日', 'a\\b\"c\n\t', '__proto__', 'constructor', 'type', 'payload', '', '\u0000'];
  const nested = depth => {
    if (depth <= 0) return [null, false, true, rand(99), strings[rand(strings.length)]][rand(5)];
    return rand(2) ? [nested(depth - 1), nested(depth - 1)]
      : Object.fromEntries([[strings[rand(strings.length)], nested(depth - 1)], ['other', nested(depth - 1)]]);
  };
  const key = text => JSON.stringify(text).replace(/[a-z]/g, char => rand(2)
    ? '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0') : char);
  const corpus = [JSON.stringify(meta())];
  for (let index = 0; index < 55; index++) {
    const record = [settings('m-' + index, ['low', '', 'max'][rand(3)]),
      user(strings[rand(strings.length)]), response('response-' + index),
      event('thread_settings_applied', { thread_settings: { model: 'last-' + index, reasoning_effort: 'ultra' } }),
      { type: 'compacted', payload: { replacement_history: [nested(2)] } }][rand(5)];
    const ignored = JSON.stringify(nested(2));
    const pairs = [key('type') + ':' + JSON.stringify(record.type),
      key('payload') + ':' + JSON.stringify(record.payload),
      key('__proto__') + ':' + ignored, key('constructor') + ':' + ignored];
    if (rand(3) === 0) pairs.unshift('"type":"old","payload":{"model":"old","effort":"high"}');
    if (rand(3) === 0) pairs.reverse();
    if (rand(4) === 0) pairs.push('"ignored":' + ['[1,]', '{"x":false,}', '01', '1e+', '"bad\\uQQQQ"'][rand(5)]);
    corpus.push('{' + pairs.join(',') + '}');
  }
  const h = fixture(t);
  fs.writeFileSync(h.filePath, corpus.join('\n') + '\n');
  for (let split = 1; split <= 32; split++) {
    h.reader.clear(); await parity(h, { highWaterMark: split });
  }
});

test('huge ignored atoms validate without retaining them; malformed suffix invalidates the whole line', async t => {
  const h = fixture(t);
  const atom = '9'.repeat(2 * 1024 * 1024);
  fs.writeFileSync(h.filePath, jsonl([meta(), settings('original', 'low')])
    + '{"type":"turn_context","payload":{"model":"valid","effort":"max"},"ignored":' + atom + '}\n'
    + '{"type":"turn_context","payload":{"model":"invalid","effort":"max"},"ignored":' + atom + 'x}\n');
  const result = await parity(h, { highWaterMark: 32768 });
  assert.equal(result.sourceSettingsProof.model, 'valid');
  assert.equal(result.parseErrors, 1);
});

test('a partial Unicode/settings line is uncommitted until appended; later invalid settings replace older proof', async t => {
  const h = fixture(t);
  h.write([meta(), settings()]);
  const line = Buffer.from(jsonl([settings('новая🙂', 'medium')]));
  const cut = line.indexOf(Buffer.from('🙂')) + 2;
  fs.appendFileSync(h.filePath, line.subarray(0, cut));
  const before = await parity(h, { highWaterMark: 5 });
  assert.equal(before.sourceSettingsProof.effort, 'max');
  fs.appendFileSync(h.filePath, line.subarray(cut));
  const after = await parity(h, { highWaterMark: 5 });
  assert.equal(after.sourceSettingsProof.model, 'новая🙂');
  fs.appendFileSync(h.filePath, jsonl([settings('incomplete', '')]));
  assert.equal((await parity(h)).sourceSettingsProof.status, 'invalid');
});

test('only exact physical version is cached: unchanged, append, rewrite+growth, inode and path', async t => {
  const h = fixture(t); h.write([meta(), settings('old', 'max'), user('old')]);
  const observed = [];
  h.activity.subscribe(state => observed.push(state.operations.length));
  await parity(h);
  const bytes = h.reader.stats().bytesRead;
  assert.equal((await h.load()).mode, 'unchanged');
  assert.equal(h.reader.stats().bytesRead, bytes);
  assert.deepEqual(observed, [1, 0], 'unchanged does not flash preparation');
  fs.appendFileSync(h.filePath, jsonl([settings('appended', 'high')]));
  assert.equal((await parity(h)).sourceSettingsProof.model, 'appended');
  h.write([meta(), settings('rewritten-growing', 'low'), user('longer'.repeat(1000))]);
  assert.equal((await parity(h)).sourceSettingsProof.model, 'rewritten-growing');
  const originalStat = fs.statSync(h.filePath);
  const replaced = path.join(h.root, 'replacement');
  fs.writeFileSync(replaced, jsonl([meta(), settings('replacement', 'ultra')]));
  fs.renameSync(replaced, h.filePath);
  fs.utimesSync(h.filePath, originalStat.atime, originalStat.mtime);
  assert.equal((await parity(h)).sourceSettingsProof.model, 'replacement');
  const moved = path.join(h.root, 'other.jsonl');
  fs.writeFileSync(moved, jsonl([meta(), settings('new-path', 'medium')]));
  h.setPath(moved);
  assert.equal((await h.load()).sourceSettingsProof.model, 'new-path');
  assert.equal(h.activity.snapshot().operations.length, 0);
});

test('rewrite during scan is retried, and failure always finishes preparation', async t => {
  let rewritten = false;
  const h = fixture(t, { readJsonlRange: async (...args) => {
    const result = await api.readJsonlRange(...args);
    if (!rewritten) { rewritten = true; h.write([meta(), settings('current', 'low')]); }
    return result;
  } });
  h.write([meta(), settings('stale', 'max')]);
  assert.equal((await h.load({ forceProjection: false })).sourceSettingsProof.model, 'current');
  assert.equal(h.activity.snapshot().operations.length, 0);
  const failing = fixture(t, { readJsonlRange: async () => { throw Error('fixture read failure'); } });
  failing.write([meta()]);
  assert.equal((await failing.load({ forceProjection: false })).error, 'fixture read failure');
  assert.equal(failing.activity.snapshot().operations.length, 0);
});

test('small to heavy retry opens activity, and subsequent callers recover after failed flights', async t => {
  let calls = 0;
  const activity = createHistoryPreparationActivity();
  const states = [];
  activity.subscribe(state => states.push(state.operations.length));
  const h = fixture(t, { activity, readJsonlRange: async (...args) => {
    const result = await api.readJsonlRange(...args);
    if (++calls === 1) h.write([meta(), settings('grew', 'high'),
      { type: 'compacted', payload: { ignored: 'z'.repeat(8 * 1024 * 1024) } }]);
    return result;
  } });
  h.write([meta(), settings('small', 'low')]);
  assert.equal((await h.load({ forceProjection: false })).sourceSettingsProof.model, 'grew');
  assert.deepEqual(states, [1, 0]);
  fs.unlinkSync(h.filePath);
  assert.equal((await h.load()).success, false);
  h.write([meta(), settings('recovered', 'max')]);
  const before = h.reader.stats().reads;
  const results = await Promise.all([h.load(), h.load()]);
  assert.equal(h.reader.stats().reads - before, 1);
  assert.equal(results[0].sourceSettingsProof.model, 'recovered');
  assert.equal(results[1].mode, 'unchanged');
  results[0].sourceSettingsProof.model = 'caller-mutated';
  assert.equal((await h.load()).sourceSettingsProof.model, 'recovered');
});

test('source rediscovery cannot publish a proof made stale during its own async lookup', async t => {
  let lookups = 0;
  const h = fixture(t, { findSessionFile: async () => {
    if (++lookups === 2) h.write([meta(), settings('rewritten-at-discovery', 'low')]);
    return { filePath: h.filePath };
  } });
  h.write([meta(), settings('old', 'max')]);
  const result = await h.load();
  assert.equal(result.sourceSettingsProof.model, 'rewritten-at-discovery');
  assert.equal(h.reader.stats().reads, 2);
});

test('large irrelevant fields skip bodies even with key order reversed and settings outside any tail cut', async t => {
  const h = fixture(t, { readJsonlRange: () => { throw Error('no generic/full reader for heavy Resume'); } });
  const padding = 'Z'.repeat(2 * 1024 * 1024);
  h.write([meta(), settings('outside-tail', 'ultra'), user('real'),
    { payload: { replacement_history: [{ type: 'message', content: padding }] }, type: 'compacted' },
    { payload: { content: [{ text: padding }], role: 'assistant', type: 'message' }, type: 'response_item' },
    { payload: { output: padding, type: 'function_call_output' }, type: 'response_item' }]);
  const result = await h.load();
  assert.equal(result.success, true, result.error);
  assert.equal(result.sourceSettingsProof.model, 'outside-tail');
  assert.equal(result.sourceMaterialization.userTurns, 1);
  assert.ok(h.reader.stats().bytesRead < fs.statSync(h.filePath).size + 1024,
    'only one scan plus exact small user fields');
});
