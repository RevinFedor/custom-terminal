'use strict';

// Implementation handoff (2026-10-11): query-local reader and opt-in canonical
// projector hooks only; parent owns Main/service/worker/client integration.
// Focused Node controls use private files <=16MiB, 512MiB old-space.
// Actual buildCodexFullHistory + extracted Main grouping/scorer is the oracle;
// no provider, production transcript, app, DEV or external research is used.
// No fixed heap claim: metadata scales with retained rows/calls; one selected
// structural payload, one exec cell's accumulated output, an open patch/exec
// invocation batch, or one final searchable pair can be large transiently.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createCodexCatalogSearchReader } = require('./codex-catalog-search');
const codexData = require('./ipc/codex-data');
const api = codexData._api;
const { scoreSessionTurnMatch } = require('./session-catalog-search');

// Execute the ACTUAL Main grouping, eligibility and scoring source without
// loading main.js/Electron or launching an app. Timeline metadata is empty:
// it does not contribute any of the public catalog fields being compared.
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const functionText = name => {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return main.slice(start, main.indexOf('\n}', start) + 2);
};
const isNoise = Function(`return (${functionText('_isNoisePrompt')})`)();
const promptText = Function('extractClaudePromptCarrier', `return (${functionText('_extractTurnPromptText')})`)(
  require('./claude-prompt-carriers').extractClaudePromptCarrier);
const collect = Function(`return (${functionText('_collectAssistantBlocks')})`)();
const groupStart = main.indexOf('  const codexTimelineUsersByUuid =', main.indexOf('async function _loadCodexSessionTurns'));
const groupEnd = main.indexOf('\n  const annotations =', groupStart);
assert.ok(groupStart > 0 && groupEnd > groupStart);
const group = Function('historyEntries', 'timelineEntries', 'sessionId', '_isNoisePrompt', '_sessionProgressToolDetail',
  main.slice(groupStart, groupEnd) + '\nreturn {turns, recordMap};');
const searchStart = main.indexOf('    const iterations = [];', main.indexOf('async function searchSessionCatalog'));
const searchEnd = main.indexOf('    if (sessionMatches.length === 0)', searchStart);
assert.ok(searchStart > 0 && searchEnd > searchStart);
const oldSearch = Function('data', 'query', 'candidate', '_extractTurnPromptText', '_collectAssistantBlocks', 'scoreSessionTurnMatch', 'diagnostic',
  main.slice(searchStart, searchEnd).replace('    sessions.push({ ...candidate, totalIterations });', '')
    .replace('    if (!query) continue;', '    if (!query) return {totalIterations,bestMatches:[]};')
  + '\nreturn {totalIterations,bestMatches:sessionMatches};');

const event = (type, extra = {}) => ({ type: 'event_msg', timestamp: '2026-10-11T12:00:00.000Z', payload: { type, ...extra } });
const user = message => event('user_message', { message });
const response = (type, extra = {}) => ({ type: 'response_item', timestamp: '2026-10-11T12:00:01.000Z', payload: { type, ...extra } });
const answer = (text, extra = {}) => response('message', { role: 'assistant', content: [{ type: 'output_text', text }], ...extra });
const responseUser = text => response('message', { role: 'user', content: [{ type: 'input_text', text }] });
const call = (id, name, args = {}, extra = {}) => response('function_call', { call_id: id, name, arguments: JSON.stringify(args), ...extra });
const output = (id, body) => response('function_call_output', { call_id: id, output: body });
const lines = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const key = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
const snap = (filePath, sessionId) => {
  const stat = fs.statSync(filePath);
  return { filePath, sessionId, dev: stat.dev, ino: stat.ino, fileIdentity: `${stat.dev}:${stat.ino}`,
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
};

function fixture(t, recordsOrText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, typeof recordsOrText === 'string' ? recordsOrText : lines(recordsOrText));
  assert.ok(fs.statSync(file).size <= 16 * 1024 * 1024, 'private fixture <=16MiB');
  return file;
}
function resolved(file, revisionKey = 'physical-v1') {
  const sourceSnapshot = snap(file, 'fixture');
  return { success: true, kind: 'physical', digestsVerified: true, revisionKey,
    viewOwnerSessionId: 'fixture', sourceSnapshot, segments: [{ segmentId: 'physical-fixture',
      filePath: file, physicalSessionId: 'fixture', fromByte: 0, toByte: sourceSnapshot.size,
      startLine: 0, endLine: null, frozen: false, sourceSnapshot }] };
}
function fencedApi(extra = {}) {
  const active = new Set(), begun = [], finished = [];
  return { ...api,
    async beginCodexSourceRead(filePath, sid) {
      const read = { snapshot: snap(filePath, sid), signature: key(fs.statSync(filePath)) };
      active.add(read); begun.push({ filePath, sid }); return read;
    },
    async assertCodexSourceRead(read) {
      if (read.revoked || read.signature !== key(fs.statSync(read.snapshot.filePath))) {
        throw Object.assign(Error('changed fixture'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
      }
    },
    finishCodexSourceRead(read) { active.delete(read); finished.push(read); },
    isCodexSourceSnapshotCurrent: () => true,
    active, begun, finished, ...extra,
  };
}
async function expected(file, query, limit = 3, recordsOverride) {
  const records = recordsOverride || (await api.readJsonlRange(file, 0, fs.statSync(file).size - 1)).records;
  // The ordinary builder's rollback preview logging is unrelated to the
  // oracle; synthetic prompt/body text must not enter diagnostic output.
  const log = console.log;
  let entries;
  console.log = (...args) => { if (!String(args[0]).startsWith('[CodexRollback]')) log(...args); };
  try { entries = api.buildCodexFullHistory(records, 'fixture'); }
  finally { console.log = log; }
  const data = group(entries, [], 'fixture', isNoise, () => '');
  const result = oldSearch(data, query, {}, promptText, collect, scoreSessionTurnMatch, { end() {} });
  result.bestMatches.sort((a, b) => b.score - a.score || a.iterationIndex - b.iterationIndex);
  result.bestMatches = result.bestMatches.slice(0, limit).map(({ totalIterations, ...row }) => row);
  return result;
}
async function parity(t, recordsOrText, query, limit = 3) {
  const file = fixture(t, recordsOrText), codexApi = fencedApi();
  const result = await createCodexCatalogSearchReader({ codexApi }).search({
    sessionId: 'fixture', query, matchesPerSession: limit, resolveSource: () => resolved(file) });
  assert.deepEqual({ totalIterations: result.totalIterations, bestMatches: result.bestMatches }, await expected(file, query, limit));
  assert.equal(codexApi.active.size, 0);
  assert.equal(codexApi.begun.length, 1);
  assert.equal(codexApi.finished.length, 1);
  return result;
}

test('final pair scorer: AND across prompt/answer, full body beyond500 and joined Unicode/whitespace', async t => {
  await parity(t, [user('alpha '+ 'x'.repeat(600)), answer('z'.repeat(1000) + ' beta'),
    user('alpha'), answer('missing'), user('other'), answer('beta')], 'alpha beta');
  await parity(t, [user('prompt'), answer('ＦＯＯ'), answer('  B\u0041R'),
    answer('e\u0301 and 日🙂'), user('foo bar'), answer('')], 'foo bar');
  await parity(t, [user('e'), answer('e\u0301')], 'é');
  await parity(t, [user('target'), response('message', { role: 'assistant', content: [
    'alpha', { type: 'image', image_url: 'data:image/png;base64,private' }, { text: 'beta' },
    null, 2, { value: 'gamma' }, { type: 'input_text', text: '' }, 'omega' ] })], 'target');
});

test('largest searchable pair remains complete and previews preserve500UTF16 including split surrogate', async t => {
  const prompt = 'p'.repeat(499) + '🙂' + ' far-user-needle ' + 'x'.repeat(1024 * 1024);
  const text = 'a'.repeat(499) + '🙂' + 'z'.repeat(1024 * 1024) + ' far-answer-needle';
  const result = await parity(t, [user(prompt), answer(text)], 'far-user-needle far-answer-needle');
  assert.equal(result.bestMatches[0].userPreview.length, 500);
  assert.equal(result.bestMatches[0].userPreview.charCodeAt(499), 0xd83d);
  assert.equal(result.bestMatches[0].assistantPreview.charCodeAt(499), 0xd83d);
  assert.ok(result.diagnostics.maxPairChars > 2 * 1024 * 1024);
});

test('both carrier orders, response-only, identical separate sends, task boundaries and image aliases', async t => {
  await parity(t, [responseUser('same'), user('same'), answer('first'), event('task_complete'),
    user('same'), responseUser('same'), answer('second'), event('task_complete'),
    responseUser('only response'), answer('third')], 'same', 10);
  await parity(t, [user('same'), event('task_started'), responseUser('same'), answer('second')], 'same', 10);
  await parity(t, [responseUser('image [Image #1] question'),
    user('<image name="[Image #1]" path="/private/fixture.png"><<ImageDisplayed>></image>image [Image #1] question'),
    answer('image answer')], 'image question');
});

test('rollback removes topK leader and restores an older canonical alias without retaining bodies', async t => {
  await parity(t, [user('alpha'), responseUser('alpha'), answer('base'), event('task_complete'),
    user('alpha beta'), answer('alpha beta'), event('thread_rolled_back', { num_turns: 1 }),
    responseUser('alpha'), answer('beta'), user('alpha beta'), answer('later')], 'alpha beta', 1);
});

test('compact plus a tool-only anonymous placeholder contributes to turnIndex, not iterationIndex', async t => {
  const result = await parity(t, [user('first'), answer('first answer'),
    { type: 'compacted', payload: { message: 'summary' } }, event('compact_completed'),
    call('tool-only', 'exec_command', { command: 'echo invisible' }), output('tool-only', 'not searchable'),
    user('target'), answer('target answer')], 'target');
  assert.equal(result.bestMatches[0].turnIndex, 3);
  assert.equal(result.bestMatches[0].iterationIndex, 1);
});

test('pending tool anchors belong to the original slot and discarded late outputs cannot adopt reused indices', async t => {
  await parity(t, [user('old'), call('lost', 'exec_command', { command: 'old body' }),
    user('target'), answer('target answer')], 'target');
  await parity(t, [user('old'), call('lost', 'exec_command'), event('thread_rolled_back', { num_turns: 1 }),
    user('target'), output('lost', 'must stay discarded'), answer('target answer')], 'target');
});

test('pending decoder obeys canonical rollback, exec-cell and subagent suppression before hydration', async t => {
  const fixtures = [
    [user('old'), call('dead', 'exec_command', {}, { namespace: { bad: true } }),
      event('thread_rolled_back', { num_turns: 1 }), user('target'), answer('ok')],
    [user('target'), call('spawn', 'spawn_agent', { task_name: 'child' }, { namespace: 'collaboration' }),
      call('wait-child', 'wait_agent', {}, { namespace: 'collaboration' }), answer('ok')],
    [user('target'), response('custom_tool_call', { call_id: 'exec', name: 'exec', input: 'text(1)' }),
      output('exec', 'Script running with cell ID 42\nOutput:\n'),
      call('wait-cell', 'wait', { cell_id: '42' }), answer('ok')],
  ];
  for (const records of fixtures) {
    const file = fixture(t, records), decoded = [];
    const codexApi = fencedApi({ codexHistoryActionsForCall: (...args) => {
      decoded.push(args[0].callId); return api.codexHistoryActionsForCall(...args);
    } });
    const result = await createCodexCatalogSearchReader({ codexApi }).search({
      sessionId: 'fixture', query: 'target', resolveSource: () => resolved(file) });
    assert.deepEqual({ totalIterations: result.totalIterations, bestMatches: result.bestMatches }, await expected(file, 'target'));
    assert.deepEqual(decoded, [], 'no predecode of calls suppressed by canonical finalization');
    assert.equal(codexApi.active.size, 0);
  }
  // Tolerance belongs to discarded calls; a retained decoder error must not
  // silently turn into a missing row or a successful empty search.
  const file = fixture(t, [user('target'), call('retained', 'exec_command', {}, { namespace: { bad: true } })]);
  await assert.rejects(expected(file, 'target'), /namespace\.startsWith/);
  await assert.rejects(createCodexCatalogSearchReader({ codexApi: fencedApi() }).search({
    sessionId: 'fixture', query: 'target', resolveSource: () => resolved(file) }), /namespace\.startsWith/);
});

test('catalog pending preparation reuses one canonical plan for seeded wait-before-spawn order', () => {
  for (const reverse of [false, true]) {
    const makeSeed = () => {
      const owner = { uuid: 'target', role: 'user', content: 'target', turnIndex: 1, sessionId: 'fixture' };
      const makeCall = (id, name, anchor, line) => ({ callId: id, toolName: name, namespace: 'collaboration',
        args: {}, patchApplyEvents: [], userOwner: owner, turnIndexAtCall: 1, entryIndexAtCall: anchor,
        line, timestamp: '2026-10-11T12:00:00.000Z', record: { __line: line, timestamp: '2026-10-11T12:00:00.000Z' } });
      const calls = [makeCall('wait', 'wait_agent', 0, 10), makeCall('spawn', 'spawn_agent', 1, 20)];
      if (reverse) calls.reverse();
      return { entries: [{ uuid: 'compact', role: 'compact', content: 'summary', turnIndex: 0 }, owner],
        pendingCalls: new Map(calls.map(c => [c.callId, c])), currentTurnIndex: 1 };
    };
    const canonical = api.createCodexHistoryProjector('fixture', makeSeed()).finalize();
    const pending = new Map();
    const projected = api.createCodexHistoryProjector('fixture', makeSeed(), {
      catalogSink: { pendingActionsForCall: call => pending.get(call) },
    });
    for (const call of projected.pendingCallsForDecode()) pending.set(call, api.codexHistoryActionsForCall(call, undefined, false));
    const rows = projected.finalize();
    assert.deepEqual(rows.map(row => [row.uuid, row.role]), canonical.map(row => [row.uuid, row.role]));
    const actualTurns = group(rows, [], 'fixture', isNoise, () => '').turns;
    const oldTurns = group(canonical, [], 'fixture', isNoise, () => '').turns;
    assert.equal(actualTurns.findIndex(turn => turn.userUuid === 'target'), oldTurns.findIndex(turn => turn.userUuid === 'target'));
    assert.equal(actualTurns.findIndex(turn => turn.userUuid === 'target'), reverse ? 2 : 3);
  }
});

test('unresolved response-only carriers have linear hydration while final DTO keeps canonical coordinates', async t => {
  for (const n of [8, 16, 32]) {
    const file = fixture(t, Array.from({ length: n }, (_, i) => responseUser('target-' + String(i).padStart(3, '0'))));
    const reads = [];
    const result = await createCodexCatalogSearchReader({ codexApi: fencedApi(), onRead: event => reads.push(event) }).search({
      sessionId: 'fixture', query: 'target', matchesPerSession: 10, resolveSource: () => resolved(file) });
    assert.deepEqual({ totalIterations: result.totalIterations, bestMatches: result.bestMatches }, await expected(file, 'target', 10));
    assert.equal(reads.filter(event => event.phase === 'hydrate').length, 2 * n,
      'one carrier read and one final-pair read, no comparison with unrelated pending response users');
    assert.ok(result.diagnostics.hydrateBytes < 2 * fs.statSync(file).size);
    t.diagnostic(JSON.stringify({ responseUsers: n, sourceBytes: fs.statSync(file).size,
      readEvents: reads.length, scanBytes: result.diagnostics.scanBytes, hydrateBytes: result.diagnostics.hydrateBytes }));
  }
});

for (const initial of ['invalidated-once', 'stable-missing']) test('initial lineage bootstrap preserves retry classification: ' + initial, async t => {
  const { SessionTranscriptService } = require('./session-transcript-service');
  const { HistoryReadClient } = require('./history-read-client');
  const file = fixture(t, [user('target'), answer('ok')]);
  const codexApi = fencedApi({ findCodexSessionFile: async () => ({ filePath: file }) });
  const service = new SessionTranscriptService({ codexData: { _api: codexApi } });
  service._resolveCodexLineage = () => ({ kind: 'physical' });
  let bootstraps = 0, requests = 0;
  service.ensureCodexProviderForkLineage = async () => {
    bootstraps++;
    if (initial === 'stable-missing') return { required: true, success: false, reason: 'fixture-source-missing' };
    if (bootstraps === 1) throw Object.assign(Error('source revoked in compact bootstrap'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
    return { required: false, success: true };
  };
  // Real resolver, reader and client retry; only producer/transport are
  // controlled. No worker or app is started by this deterministic race test.
  const client = new HistoryReadClient({});
  t.after(() => client.close());
  client.request = async (_method, payload) => {
    requests++;
    return { value: await service.searchCatalogCandidate(payload), readProof: [] };
  };
  const pending = client.call('searchCatalogCandidate', { toolType: 'codex', sessionId: 'fixture', query: 'target' });
  if (initial === 'stable-missing') {
    await assert.rejects(pending, { code: 'history_lineage_unresolved', lineageReason: 'fixture-source-missing' });
    assert.equal(requests, 1); assert.equal(client.diagnosticCounters.retries, 0);
  } else {
    assert.equal((await pending).bestMatches.length, 1);
    assert.equal(requests, 2); assert.equal(client.diagnosticCounters.retries, 1);
  }
  assert.equal(codexApi.active.size, 0);
});

test('exec cell continuation/wait and subagent controls retain structural rows but never search tool bodies', async t => {
  await parity(t, [user('start'), response('custom_tool_call', { call_id: 'exec', name: 'exec',
    input: 'const a = await tools.exec_command({cmd:"echo secret"}); text(a);' }),
    output('exec', [{ type: 'input_text', text: 'Script running with cell ID 42\nOutput:\n' },
      { type: 'input_text', text: 'secret early' }]),
    { type: 'compacted', payload: {} }, call('wait1', 'wait', { cell_id: '42' }),
    output('wait1', 'Script running with cell ID 43\nOutput:\nsecret middle'),
    call('wait2', 'wait', { cell_id: '43' }), user('target'), answer('target answer')], 'target');
  await parity(t, [user('start'), call('spawn', 'spawn_agent', { task_name: 'private_child' }, { namespace: 'collaboration' }),
    output('spawn', JSON.stringify({ task_name: '/root/private_child' })),
    { type: 'compacted', payload: {} }, call('wait', 'wait_agent', {}, { namespace: 'collaboration' }),
    user('target'), answer('target answer')], 'target');
  await parity(t, [user('start'), call('spawn', 'spawn_agent', {}, { namespace: 'multi_agent_v1' }),
    output('spawn', '{}'), user('secret'), answer('public')], 'invisible tool result');
});

test('noise, empty prompts, goal/context/instruction carriers, reasoning-only rows and blank totals', async t => {
  const records = [responseUser(''), user(''), user('<system-reminder>noise</system-reminder>'),
    responseUser('<environment_context>private</environment_context>'),
    responseUser('# AGENTS.md instructions for /private\n<instructions>context</instructions>'),
    user('# AGENTS.md instructions for /private\n<instructions>context</instructions>'),
    user('real prompt'), response('reasoning', { summary: [{ text: 'reasoning only' }] }),
    call('pending', 'exec_command'), user('<codex_internal_context source="goal">next</codex_internal_context>'),
    user('other real prompt'), answer('visible')];
  await parity(t, records, 'prompt', 10);
  await parity(t, records, '');
});

test('settings rows before rollback preserve the canonical rollback turn set', async t => {
  await parity(t, [user('retained'), answer('retained answer'),
    { type: 'turn_context', payload: { model: 'fixture-model', effort: 'high' } },
    event('thread_rolled_back', { num_turns: 1 }), responseUser('retained'), answer('extra')], 'retained', 10);
});

test('patch routing rehydrates exact invocation candidates and only retains the canonical attached locators', async t => {
  await parity(t, [user('first'), response('custom_tool_call', { name: 'exec', call_id: 'patch-exec',
    input: 'const file = "a.txt"; const patch = "*** Begin Patch\\n" + file; text(await tools.apply_patch(patch));' }),
    event('patch_apply_end', { call_id: 'different-event-id', changes: { 'a.txt': { type: 'add', content: 'created' } } }),
    { type: 'compacted', payload: {} }, user('target'), answer('target answer')], 'target');
  await parity(t, [user('target'), response('function_call', { call_id: 'empty-args', name: 'exec',
    arguments: 'null', input: 'text(await tools.exec_command({cmd:"unused"}));' }),
    output('empty-args', 'tool only'), answer('target answer')], 'target');
  await parity(t, [user('first'), { type: 'compacted', payload: {} }, response('reasoning', { summary: [
    { summary: 'legacy reasoning' }, { content: ['nonstandard but canonical'] } ] }),
    call('think', 'exec_command'), user('target'), answer('target answer')], 'target');
});

test('partial UTF8 tail and malformed ignored subtrees match actual JSONL tolerance', async t => {
  const text = lines([user('target'), answer('target answer')])
    + '{"type":"event_msg","payload":{"type":"mcp_tool_call_end","result":[1,]}}\n'
    + '\ufeff\u3000' + JSON.stringify(user('last')) + '\u00a0\r\n'
    + '{"type":"event_msg","payload":{"type":"user_message","message":"unfinished🙂';
  const result = await parity(t, text, 'target');
  assert.equal(result.diagnostics.parseErrors, 1);
  assert.ok(result.diagnostics.partialBytes > 0);
  await parity(t, [null, 2, true, {}, { type: 'turn_context' },
    { type: 'session_meta', payload: null }, { type: 'response_item', payload: null },
    { type: 'event_msg', payload: null }, { type: 'compacted', payload: null },
    user('target'), answer('target answer')], 'target');
});

test('duplicate/escaped JSON keys obey last-key-wins, including type after giant irrelevant field', async t => {
  await parity(t, '{"timestamp":"2026-10-11T12:00:00.000Z","payload":{"type":"user_message","message":"wrong","mess\\u0061ge":"target"},"type":"other","t\\u0079pe":"event_msg"}\n'
    + lines([answer('target answer')]), 'target');
});

test('ignored tool payload scales2→16MiB with identical DTO and bounded parser/retention/transport', async t => {
  const baseline = await parity(t, [user('target'), event('mcp_tool_call_end', { result: 'tiny' }), answer('target answer')], 'target');
  const dtos = [], measures = [], proof = [];
  for (const size of [2, 16]) {
    const text = JSON.stringify(user('target')) + '\n'
      + '{"type":"event_msg","payload":{"result":"' + 'x'.repeat(size * 1024 * 1024 - 2048)
      + '","type":"mcp_tool_call_end"}}\n' + lines([answer('target answer')]);
    const file = fixture(t, text), events = [], diagnostics = [];
    let maxParseInput = 0, result, maxRetainedStringBytes = 0, maxRetainedStringsBytes = 0;
    const observedApi = fencedApi();
    const createProjector = observedApi.createCodexHistoryProjector;
    observedApi.createCodexHistoryProjector = (id, seed, options) => {
      let projector;
      const afterFeed = options.catalogSink.afterFeed;
      const sink = { ...options.catalogSink, afterFeed(state) {
        afterFeed(state);
        // Test-only graph inspection, never a production heap walk. Traverse
        // Map/Set too: JSON.stringify would silently omit their retained data.
        const pending = [projector.exportState()], seen = new Set();
        let stringBytes = 0;
        while (pending.length) {
          const value = pending.pop();
          if (typeof value === 'string') {
            const bytes = Buffer.byteLength(value); stringBytes += bytes;
            maxRetainedStringBytes = Math.max(maxRetainedStringBytes, bytes);
          } else if (value && typeof value === 'object' && !seen.has(value)) {
            seen.add(value);
            if (value instanceof Map) for (const [key, item] of value) pending.push(key, item);
            else if (value instanceof Set) for (const item of value) pending.push(item);
            else for (const item of Object.values(value)) pending.push(item);
          }
        }
        maxRetainedStringsBytes = Math.max(maxRetainedStringsBytes, stringBytes);
      } };
      projector = createProjector(id, seed, { ...options, catalogSink: sink });
      return projector;
    };
    const nativeParse = JSON.parse;
    JSON.parse = (text, ...args) => { maxParseInput = Math.max(maxParseInput, Buffer.byteLength(String(text)));
      return nativeParse(text, ...args); };
    try {
      result = await createCodexCatalogSearchReader({ codexApi: observedApi,
        onRead: value => events.push(value), onDiagnostic: value => diagnostics.push(value) }).search({
        sessionId: 'fixture', query: 'target', resolveSource: () => resolved(file) });
    } finally { JSON.parse = nativeParse; }
    dtos.push({ totalIterations: result.totalIterations, bestMatches: result.bestMatches });
    measures.push(result.diagnostics);
    assert.ok(result.diagnostics.maxBufferedBytes <= 256 * 1024 + 1024);
    assert.ok(result.diagnostics.maxParsedValueBytes < 1024);
    assert.ok(maxParseInput < 1024, 'actual JSON.parse inputs cannot scale with ignored tool body');
    assert.ok(maxRetainedStringBytes < 1024, 'actual projection graph cannot retain the ignored body');
    assert.ok(maxRetainedStringsBytes < 32768);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
    assert.ok(events.every(value => Object.keys(value).sort().join(',') === 'bytes,phase'));
    assert.equal(diagnostics.length, 1);
    assert.ok(Object.values(diagnostics[0]).every(value => typeof value === 'number'));
    proof.push({ paddingMiB: size, diagnostics: result.diagnostics, maxParseInput,
      maxRetainedStringBytes, maxRetainedStringsBytes,
      transportBytes: Buffer.byteLength(JSON.stringify(result)), dto: dtos.at(-1),
      coverage: 'private fixture; projection graph strings, not whole-isolate heap' });
  }
  assert.deepEqual(dtos[0], { totalIterations: baseline.totalIterations, bestMatches: baseline.bestMatches });
  assert.deepEqual(dtos[1], dtos[0]);
  assert.equal(measures[0].maxParsedValueBytes, measures[1].maxParsedValueBytes);
  assert.equal(measures[0].maxBufferedBytes, measures[1].maxBufferedBytes);
  assert.equal(proof[0].maxRetainedStringBytes, proof[1].maxRetainedStringBytes);
  // Physical byte offsets gain a digit when padding grows; they are retained
  // identity metadata, not copies of that padding.
  assert.ok(Math.abs(proof[0].maxRetainedStringsBytes - proof[1].maxRetainedStringsBytes) <= 64);
  if (process.env.NOTED_CATALOG_PROOF_FILE) fs.writeFileSync(process.env.NOTED_CATALOG_PROOF_FILE, JSON.stringify(proof, null, 2));
});

test('actual source fence accepts the fixture and revokes an in-flight scan', async t => {
  const file = fixture(t, [user('target'), answer('target answer')]);
  const result = await createCodexCatalogSearchReader({ codexApi: api }).search({ sessionId: 'fixture',
    query: 'target', resolveSource: () => resolved(file) });
  assert.equal(result.bestMatches.length, 1);
  let revoked = false;
  await assert.rejects(createCodexCatalogSearchReader({ codexApi: api, onRead({ phase }) {
    if (phase === 'scan' && !revoked) { revoked = true; codexData.invalidateCodexJsonlCache(file); }
  } }).search({ sessionId: 'fixture', query: 'target', resolveSource: () => resolved(file) }),
  { code: 'CODEX_SOURCE_READ_INVALIDATED' });
});

test('large selected tool values are transient; control graph retains no invocation/result bodies', async t => {
  const marker = 'BODY-FOR-EVICTION';
  const file = fixture(t, [user('target'), call('pending', 'exec_command', { command: marker.repeat(10000) }),
    call('closed', 'exec_command', { command: marker.repeat(10000) }), output('closed', marker.repeat(10000)),
    answer('target answer')]);
  let observations = 0;
  const codexApi = fencedApi({ createCodexHistoryProjector(sid, seed, { catalogSink }) {
    const afterFeed = catalogSink.afterFeed;
    catalogSink.afterFeed = state => {
      afterFeed(state); observations++;
      const seen = new Set();
      function inspect(value) {
        if (typeof value === 'string') assert.ok(!value.includes(marker), 'detached control graph contains a tool body');
        else if (value && typeof value === 'object' && !seen.has(value)) {
          seen.add(value);
          if (value instanceof Map) for (const [key, child] of value) { inspect(key); inspect(child); }
          else for (const child of Object.values(value)) inspect(child);
        }
      }
      inspect(state);
    };
    return api.createCodexHistoryProjector(sid, seed, { catalogSink });
  } });
  const result = await createCodexCatalogSearchReader({ codexApi }).search({ sessionId: 'fixture',
    query: 'target', resolveSource: () => resolved(file) });
  assert.equal(observations, 5);
  assert.ok(result.diagnostics.maxStructuralValueBytes > 100000, 'honestly reports one full structural value');
  assert.deepEqual({ totalIterations: result.totalIterations, bestMatches: result.bestMatches }, await expected(file, 'target'));
});

test('source rewrite/replacement/generation/lineage changes reject publication and release every read', async t => {
  for (const mode of ['rewrite', 'replacement', 'generation', 'lineage', 'final-resolve-error']) {
    const file = fixture(t, [user('target'), answer('target answer')]);
    const codexApi = fencedApi(); let resolverCalls = 0, changed = false;
    const reader = createCodexCatalogSearchReader({ codexApi, onRead({ phase }) {
      if (changed || phase !== 'scan') return;
      changed = true;
      if (mode === 'rewrite') {
        const stat = fs.statSync(file), text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, text.replaceAll('target', 'change'));
        fs.utimesSync(file, stat.atime, stat.mtime);
      } else if (mode === 'replacement') {
        const text = fs.readFileSync(file); fs.renameSync(file, file + '.old'); fs.writeFileSync(file, text);
      } else if (mode === 'generation') for (const read of codexApi.active) read.revoked = true;
    } });
    await assert.rejects(reader.search({ sessionId: 'fixture', query: 'target', resolveSource() {
      resolverCalls++;
      if (mode === 'final-resolve-error' && resolverCalls > 1) throw Error('lineage unavailable');
      return resolved(file, mode === 'lineage' && resolverCalls > 1 ? 'new-lineage' : 'physical-v1');
    } }), { code: 'CODEX_SOURCE_READ_INVALIDATED' }, mode);
    assert.equal(codexApi.active.size, 0, mode);
    assert.equal(codexApi.begun.length, codexApi.finished.length, mode);
  }
});

test('frozen ancestor matches, exact physical IDs and unique-source fencing survive a thin child', async t => {
  const ancestor = fixture(t, [user('inherited needle'), answer('ancestor answer')]);
  const child = fixture(t, [user('child prompt'), answer('child answer')]);
  const prefix = fs.readFileSync(ancestor), sourceSnapshot = snap(child, 'fixture');
  const ancestorSnapshot = snap(ancestor, 'ancestor-fixture');
  const source = { ...resolved(child), kind: 'virtual', manifestDigest: 'fixture-manifest',
    segments: [{ segmentId: 'frozen', filePath: ancestor, physicalSessionId: 'ancestor-fixture',
      fromByte: 0, toByte: prefix.length, startLine: 0, endLine: 2, frozen: true,
      digest: createHash('sha256').update(prefix).digest('hex'), sourceSnapshot: ancestorSnapshot },
    { segmentId: 'tail', filePath: child, physicalSessionId: 'fixture', fromByte: 0,
      toByte: sourceSnapshot.size, startLine: 0, frozen: false, sourceSnapshot }] };
  const codexApi = fencedApi();
  const result = await createCodexCatalogSearchReader({ codexApi }).search({ sessionId: 'fixture',
    query: 'inherited needle', resolveSource: () => source });
  const rawAncestor = (await api.readJsonlRange(ancestor, 0, prefix.length - 1)).records
    .map(record => ({ ...record, __physicalSessionId: 'ancestor-fixture' }));
  const rawChild = (await api.readJsonlRange(child, 0, sourceSnapshot.size - 1)).records;
  assert.deepEqual({ totalIterations: result.totalIterations, bestMatches: result.bestMatches },
    await expected(child, 'inherited needle', 3, [...rawAncestor, ...rawChild]));
  assert.deepEqual(codexApi.begun.map(value => value.sid), ['ancestor-fixture', 'fixture']);
  assert.equal(codexApi.finished.length, 2);
});

test('frozen digest and exclusive line boundaries cannot silently become partial/malformed hits', async t => {
  for (const mode of ['digest', 'line', 'partial']) {
    const file = fixture(t, lines([user('target'), answer('target answer')]) + (mode === 'partial' ? '{"unfinished":' : ''));
    const source = resolved(file), segment = source.segments[0];
    segment.frozen = true; segment.endLine = mode === 'line' ? 1 : 2;
    segment.digest = mode === 'digest' ? 'wrong' : createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const codexApi = fencedApi();
    await assert.rejects(createCodexCatalogSearchReader({ codexApi }).search({ sessionId: 'fixture',
      query: 'target', resolveSource: () => source }), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
    assert.equal(codexApi.active.size, 0);
  }
});

test('final admission rejects first-source revocation during second assert and closes before checking every ticket', async t => {
  for (const mode of ['second-assert', 'close-revocation', 'close-lineage', 'stat-lineage', 'success']) {
    const first = fixture(t, [user('target'), answer('first answer')]);
    const second = fixture(t, [user('second'), answer('second answer')]);
    const source = resolved(second);
    source.kind = 'virtual';
    source.segments.unshift({ ...resolved(first).segments[0], segmentId: 'ancestor', physicalSessionId: 'ancestor' });
    let logicalKey = source.revisionKey, closes = 0, finalLogicalCalls = 0;
    const order = [], codexApi = fencedApi();
    const baseAssert = codexApi.assertCodexSourceRead, baseFinish = codexApi.finishCodexSourceRead;
    let secondAssertions = 0;
    codexApi.assertCodexSourceRead = async read => {
      await baseAssert(read);
      if (read.snapshot.filePath === second && ++secondAssertions === 2 && mode === 'second-assert') {
        [...codexApi.active].find(item => item.snapshot.filePath === first).revoked = true;
      }
    };
    codexApi.isCodexSourceSnapshotCurrent = snapshot => {
      order.push('admit-physical');
      assert.equal(closes, 2, 'async handles closed before physical admission');
      assert.equal(codexApi.active.size, 2, 'tickets stay pinned during admission');
      return ![...codexApi.active].find(read => read.snapshot === snapshot)?.revoked;
    };
    codexApi.finishCodexSourceRead = read => { order.push('finish'); baseFinish(read); };
    const originalOpen = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      let stats = 0;
      return { async stat() {
        const result = await handle.stat();
        if (++stats === 2 && mode === 'stat-lineage' && args[0] === second) logicalKey = 'new-lineage';
        return result;
      }, async close() {
        await handle.close(); closes++; order.push('close');
        if (args[0] === second && mode === 'close-revocation') {
          [...codexApi.active].find(read => read.snapshot.filePath === first).revoked = true;
        }
        if (args[0] === second && mode === 'close-lineage') logicalKey = 'new-lineage';
      } };
    };
    try {
      const promise = createCodexCatalogSearchReader({ codexApi }).search({ sessionId: 'fixture', query: 'target',
        resolveSource: () => source,
        assertLogicalCurrent(resolvedSource) {
          order.push('admit-logical'); finalLogicalCalls++;
          assert.equal(closes, 2); assert.equal(codexApi.active.size, 2);
          return resolvedSource.revisionKey === logicalKey;
        } });
      if (mode === 'success') assert.equal((await promise).bestMatches.length, 1);
      else await assert.rejects(promise, { code: 'CODEX_SOURCE_READ_INVALIDATED' }, mode);
    } finally { fs.promises.open = originalOpen; }
    assert.equal(codexApi.active.size, 0, mode);
    assert.equal(closes, 2, mode);
    if (mode.includes('lineage') || mode === 'success') assert.equal(finalLogicalCalls, 1, mode);
    const firstFinish = order.indexOf('finish');
    assert.ok(firstFinish > order.lastIndexOf('close'), mode);
    assert.ok(firstFinish > order.lastIndexOf('admit-logical'), mode);
  }
});

test('deep valid selected arguments do not incur a diagnostic graph walk or become invalidated', async t => {
  // Native parsing can handle this valid nested value; recursive diagnostics
  // cannot. Keep the fixture tiny and the canonical tool decoder ordinary.
  const argumentsText = '{"input":"text(1)","unused":' + '['.repeat(12000) + '0' + ']'.repeat(12000) + '}';
  const file = fixture(t, [user('target'), response('function_call', {
    call_id: 'deep', name: 'exec', arguments: argumentsText }),
    event('patch_apply_end', { call_id: 'different-event-id', changes: {} }), answer('target answer')]);
  const result = await createCodexCatalogSearchReader({ codexApi: fencedApi() }).search({
    sessionId: 'fixture', query: 'target', resolveSource: () => resolved(file) });
  assert.equal(result.success, true);
  assert.equal(result.bestMatches.length, 1);
  assert.ok(result.diagnostics.maxStructuralValueBytes > 24000);
});

test('throwing read/diagnostic observers count observation failures without failing the query', async t => {
  const file = fixture(t, [user('target'), answer('target answer')]);
  let reads = 0, diagnostics = 0;
  const result = await createCodexCatalogSearchReader({ codexApi: fencedApi(),
    onRead() { reads++; throw Error('observation unavailable'); },
    onDiagnostic() { diagnostics++; throw Error('observation unavailable'); },
  }).search({ sessionId: 'fixture', query: 'target', resolveSource: () => resolved(file) });
  assert.equal(result.success, true);
  assert.equal(result.diagnostics.observationFailures, reads + diagnostics);
  assert.equal(diagnostics, 1);
  assert.deepEqual({ totalIterations: result.totalIterations, bestMatches: result.bestMatches }, await expected(file, 'target'));
});
