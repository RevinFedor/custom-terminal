'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { createHash } = require('node:crypto');
const { _api } = require('./ipc/codex-data');
const { classifyCodexTurnRecord } = require('./codex-turn-outcome');
const { MessageReturnProofs } = require('./message-return-proofs');
const { exactMessageReturn } = require('../shared/message-loop-waits.cjs');
const vm = require('node:vm'), ts = require('typescript');
const mainText = fs.readFileSync(require.resolve('./main'), 'utf8');
const mainTree = ts.createSourceFile('main.js', mainText, ts.ScriptTarget.Latest, true);
const producer = method => {
  let found;
  function visit(node) {
    if (ts.isTryStatement(node) && node.tryBlock.getText(mainTree).includes('getMessageReturnProofs().' + method)) found = node.getText(mainTree);
    ts.forEachChild(node, visit);
  }
  visit(mainTree); assert.ok(found, method); return found;
};
const event = (type, fields = {}) => ({ type: 'event_msg', timestamp: '2026-10-23T01:00:00Z', payload: { type, ...fields } });
function fixture(t, records, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-return-proof-')), file = path.join(dir, 'own.jsonl');
  const db = new Database(':memory:'); let revision = 'R';
  const bytes = records.map(record => JSON.stringify(record) + '\n'); fs.writeFileSync(file, bytes.join(''));
  let offset = 0;
  const rows = records.map((record, line) => { const row = { ...record, __line: line, __byteOffset: offset, __eventSequence: line + 1 };
    offset += Buffer.byteLength(bytes[line]); return row; });
  let references = null;
  const { Owner = MessageReturnProofs, ...ports } = options;
  const args = { db, findExecutionContext: _api.findCodexPromptExecutionContext, readRevision: () => revision,
    readReferences: () => references, ...ports };
  let owner = new Owner(args);
  const source = { known: true, tabId: 'A', sessionId: 'S', provider: 'codex' };
  const receipt = index => ({ state: 'confirmed', operationKey: 'O', attemptId: 'A', handoffId: 'H', provider: 'codex',
    sessionId: 'S', userUuid: 'codex-user-S-' + index, sourceIdentity: 'codex-user-source-S-' + rows[index].__byteOffset });
  const feed = (extra = {}) => {
    const tracker = {};
    for (const record of rows) owner.observeCodex({ tabId: 'A', sessionId: 'S', record,
      recordSpan: { start: record.__byteOffset, length: Buffer.byteLength(bytes[record.__line]),
        digest: createHash('sha256').update(bytes[record.__line]).digest('hex') },
      outcome: classifyCodexTurnRecord(tracker, record), source: { filePath: file, stat: fs.statSync(file), revision: 'R' },
      currentWatcher: true, currentTerminal: true, lifecycleGeneration: 'G', watcherGeneration: 'G',
      runSeq: 2, watcherRunSeq: 2, boundaryOffset: 0, liveAfterOffset: 0, suppressed: false,
      deferred: false, sourceObservation: false, manualConflict: false,
      ...(typeof extra === 'function' ? extra(record) : extra) });
  };
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, rows, file, source, receipt, feed, get owner() { return owner; },
    references: value => { references = value; },
    append: records => {
      for (const record of records) {
        const text = JSON.stringify(record) + '\n';
        rows.push({ ...record, __line: rows.length, __byteOffset: offset, __eventSequence: rows.length + 1 });
        bytes.push(text); offset += Buffer.byteLength(text); fs.appendFileSync(file, text);
      }
    },
    revise: () => { revision = 'new'; }, reopen: () => { owner = new Owner(args); } };
}
const run = id => [event('task_started', { turn_id: id }), event('user_message', { message: 'private prompt body' }),
  event('task_complete', { turn_id: id, last_agent_message: 'private final body' })];

test('real canonical resolver joins the exact user to its natural final, survives reopen, retains no prompt/final bodies', async t => {
  const h = fixture(t, run('T')); h.feed();
  let result = await h.owner.read(h.source, h.receipt(1));
  assert.equal(result.known, true); assert.equal(result.executionContext.turnId, 'T');
  assert.equal(exactMessageReturn(result, h.receipt(1)), true);
  const stored = h.db.prepare('SELECT value FROM tab_message_return_facts').get().value;
  assert.doesNotMatch(stored, /private prompt|private final/);
  h.reopen(); result = await h.owner.read(h.source, h.receipt(1)); assert.equal(result.known, true);
  assert.equal(result.executionContext.generation, null, 'historical fact is not a current writer generation');
});
test('innocent append after a completed return does not invalidate its exact retained spans', async t => {
  const h = fixture(t, run('T')); h.feed();
  fs.appendFileSync(h.file, JSON.stringify(event('token_count', { info: { total: 1 } })) + '\n');
  assert.equal((await h.owner.read(h.source, h.receipt(1))).known, true);
});
const longToolPairs = () => Array.from({ length: 96 }, (_, i) => [
  { type: 'response_item', timestamp: '2026-10-25T01:00:00Z', payload: {
    type: 'function_call', call_id: 'owned-call-' + i, name: 'read_file', arguments: '{"path":"owned-fixture.txt"}' } },
  { type: 'response_item', timestamp: '2026-10-25T01:00:00Z', payload: {
    type: 'function_call_output', call_id: 'owned-call-' + i, output: 'x'.repeat(32768) } },
]).flat();
for (const position of ['short', 'after', 'before']) test((position === 'short' ? 'short' : 'long')
  + ' ordinary processing turn: paired tools ' + position + ' Return remain provable', async t => {
  const pairs = longToolPairs(), user = event('user_message', { message: 'owned synthetic addressed reply' });
  const records = [event('task_started', { turn_id: 'T' }), ...(position === 'before' ? pairs : []), user,
    ...(position === 'after' ? pairs : []), event('task_complete', { turn_id: 'T', last_agent_message: 'owned completed reply' })];
  const classes = [];
  if (process.env.MESSAGE_RETURN_PREVIOUS_HELPER) {
    const beforeFile = path.resolve(process.env.MESSAGE_RETURN_PREVIOUS_HELPER);
    const Module = require('node:module'), compiled = new Module(beforeFile, module);
    compiled.filename = require.resolve('./message-return-proofs');
    compiled.paths = Module._nodeModulePaths(__dirname);
    compiled._compile(fs.readFileSync(beforeFile, 'utf8'), compiled.filename);
    classes.push(['pre-five-guards', compiled.exports.MessageReturnProofs]);
  }
  const results = [];
  for (const [version, Owner] of [...classes, ['current', MessageReturnProofs]]) {
    const verification = [];
    const h = fixture(t, records, { Owner, verifierOptions: { log: () => {}, onMetrics: value => verification.push(value) } });
    const index = h.rows.findIndex(row => row.payload.type === 'user_message');
    h.references([h.receipt(index)]); h.feed();
    const open = fs.promises.open; let readBytes = 0, maxReadBytes = 0;
    fs.promises.open = async function (file, ...args) {
      const fd = await open.call(this, file, ...args);
      if (file === h.file) {
        const read = fd.read.bind(fd);
        fd.read = async (...params) => {
          maxReadBytes = Math.max(maxReadBytes, params[2]);
          const result = await read(...params); readBytes += result.bytesRead; return result;
        };
      }
      return fd;
    };
    let result;
    try { result = await h.owner.read(h.source, h.receipt(index)); }
    finally { fs.promises.open = open; }
    results.push({ version, sourceBytes: fs.statSync(h.file).size, records: records.length, readBytes, maxReadBytes,
      journalBytes: Buffer.byteLength(h.db.prepare('SELECT value FROM tab_message_return_facts').get().value), verification, result });
  }
  t.diagnostic(JSON.stringify({ position, results }));
  if (classes.length) assert.equal(results[0].result.known, true, 'PRE supported this ordinary processing turn');
  assert.equal(results.at(-1).result.known, true, 'CURRENT must preserve a long natural turn, not substitute a byte-limit miss');
  assert.equal(results.at(-1).result.executionContext.turnId, 'T');
  assert.ok(results.at(-1).maxReadBytes <= 16 * 1024, 'the approved total-IO change does not enlarge a read buffer');
  assert.ok(results.at(-1).readBytes <= results.at(-1).sourceBytes + records.length * 256,
    'one exact interval plus bounded literal reads, not repeated scans or History');
  assert.ok(results.at(-1).journalBytes <= 2 * 1024 * 1024, 'the proof journal does not retain tool output bodies');
});
test('authority boundary: real rewrite plus growth is not revoked by source generations or a read fence alone', async t => {
  const { CodexSourceGenerations } = require('./codex-source-generations');
  const { CodexReadFence } = require('./codex-read-fence');
  const h = fixture(t, [event('task_started', { turn_id: 'T' }),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'one', name: 'read_file', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'one', output: 'x'.repeat(1000) } },
    event('user_message', { message: 'return' }), event('task_complete', { turn_id: 'T', last_agent_message: 'done' })]);
  h.references([h.receipt(3)]); h.feed();
  const generations = new CodexSourceGenerations(), fence = new CodexReadFence();
  const before = fs.readFileSync(h.file), generation = generations.observe(h.file, fs.statSync(h.file), 'S').generation;
  fence.externalVersion = file => generations.get(file)?.generation;
  const ticket = fence.begin(h.file, 'return');
  try {
    const start = h.rows[2].__byteOffset, end = h.rows[3].__byteOffset;
    const injected = JSON.stringify(event('task_started', { turn_id: 'injected' }));
    const changed = Buffer.from(injected + ' '.repeat(end - start - Buffer.byteLength(injected) - 1) + '\n');
    fs.writeFileSync(h.file, Buffer.concat([before.subarray(0, start), changed, before.subarray(end), Buffer.from('{}\n')]));
    const observed = generations.observe(h.file, fs.statSync(h.file), 'S');
    assert.equal(observed.rewritten, false, 'growth alone is not a prefix rewrite classifier');
    assert.equal(observed.generation, generation);
    assert.doesNotThrow(() => fence.assertCurrent(ticket), 'the cooperative fence has no independent external-write signal');
    const actual = await _api.readJsonlRange(h.file, 0, fs.statSync(h.file).size - 1);
    assert.equal(_api.findCodexPromptExecutionContext(actual.records, 'S', 'codex-user-S-3').turnId, 'injected');
    assert.equal((await h.owner.read(h.source, h.receipt(3))).known, false,
      'CURRENT physical/structural proof still rejects the rewritten small interval; do not replace it with this generation');
    t.diagnostic(JSON.stringify({ sourceBytes: fs.statSync(h.file).size, rewriteObserved: observed.rewritten,
      generationPreserved: observed.generation === generation, canonicalTurnChanged: true, currentReturnRejected: true }));
  } finally { fence.finish(ticket); }
});
test('authority boundary: an explicit application invalidation revokes readers but is not a physical write lock', t => {
  const { CodexSourceGenerations } = require('./codex-source-generations');
  const { CodexReadFence } = require('./codex-read-fence');
  const h = fixture(t, run('T')), generations = new CodexSourceGenerations(), fence = new CodexReadFence();
  const previous = generations.observe(h.file, fs.statSync(h.file), 'S').generation;
  fence.externalVersion = file => generations.get(file)?.generation;
  const ticket = fence.begin(h.file, 'return');
  try {
    generations.invalidate(h.file); fence.invalidate(h.file);
    assert.throws(() => fence.assertCurrent(ticket), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
    fs.appendFileSync(h.file, '{}\n');
    const current = generations.observe(h.file, fs.statSync(h.file), 'S');
    assert.equal(current.rewritten, true); assert.notEqual(current.generation, previous);
    assert.equal(fence.active.get(h.file).has(ticket), true, 'the old reader remains registered, yet the OS permits the write');
  } finally { fence.finish(ticket); }
});
test('guard race: a rewrite between point verifiers is rejected by whole-operation physical bookends', async t => {
  const h = fixture(t, run('T')); h.references([h.receipt(1)]); h.feed();
  const originalOpen = fs.promises.open; let changed = false;
  const userStart = h.rows[1].__byteOffset, userEnd = h.rows[2].__byteOffset;
  fs.promises.open = async function (file, ...args) {
    const fd = await originalOpen.call(this, file, ...args);
    if (file !== h.file) return fd;
    const read = fd.read.bind(fd), close = fd.close.bind(fd); let coveredUser = false;
    fd.read = async (...params) => {
      const result = await read(...params), position = params[3];
      coveredUser ||= Number.isFinite(position) && position <= userStart && position + result.bytesRead >= userEnd;
      return result;
    };
    fd.close = async () => {
      await close();
      if (coveredUser && !changed) {
        changed = true;
        fs.writeFileSync(h.file, fs.readFileSync(h.file, 'utf8').replace('private prompt body', 'altered prompt body') + '{}\n');
      }
    };
    return fd;
  };
  let result;
  try { result = await h.owner.read(h.source, h.receipt(1)); }
  finally { fs.promises.open = originalOpen; }
  assert.equal(changed, true, 'the distinguishing file mutation actually occurred');
  assert.equal(result.known, false);
});
test('guard witness: rewriting the predecessor boundary cannot turn legal pre-start B into open A unnoticed', async t => {
  const h = fixture(t, [...run('A'), event('user_message', { message: 'prestart' }),
    event('task_started', { turn_id: 'B' }), event('task_complete', { turn_id: 'B', last_agent_message: 'done' })]);
  h.references([h.receipt(3)]); h.feed();
  fs.writeFileSync(h.file, fs.readFileSync(h.file, 'utf8').replace('"type":"task_complete"', '"type":"token_counter"') + '{}\n');
  const actual = await _api.readJsonlRange(h.file, 0, fs.statSync(h.file).size - 1);
  assert.equal(_api.findCodexPromptExecutionContext(actual.records, 'S', 'codex-user-S-3').turnId, 'A');
  assert.equal((await h.owner.read(h.source, h.receipt(3))).known, false);
});
test('guard witness: a new boundary in an unwitnessed byte gap is not missed by checking only retained headers', async t => {
  const h = fixture(t, [...run('A'), event('token_count', { padding: 'x'.repeat(250) }),
    event('user_message', { message: 'prestart' }), event('task_started', { turn_id: 'B' }),
    event('task_complete', { turn_id: 'B', last_agent_message: 'done' })]);
  h.references([h.receipt(4)]); h.feed();
  const original = fs.readFileSync(h.file), start = h.rows[3].__byteOffset, end = h.rows[4].__byteOffset;
  const replacement = JSON.stringify(event('task_started', { turn_id: 'injected-C' }));
  const line = Buffer.from(replacement + ' '.repeat(end - start - Buffer.byteLength(replacement) - 1) + '\n');
  fs.writeFileSync(h.file, Buffer.concat([original.subarray(0, start), line, original.subarray(end), Buffer.from('{}\n')]));
  const actual = await _api.readJsonlRange(h.file, 0, fs.statSync(h.file).size - 1);
  assert.equal(_api.findCodexPromptExecutionContext(actual.records, 'S', 'codex-user-S-4').turnId, 'injected-C');
  assert.equal((await h.owner.read(h.source, h.receipt(4))).known, false);
});
test('a pre-start carrier without an admitted predecessor is an explicit miss, never a search from zero', async t => {
  const h = fixture(t, [{ type: 'session_meta', payload: { id: 'S' } }, event('user_message', { message: 'cold-first-input' }),
    event('task_started', { turn_id: 'B' }), event('task_complete', { turn_id: 'B', last_agent_message: 'done' })]);
  h.references([h.receipt(1)]); h.feed();
  assert.equal((await h.owner.read(h.source, h.receipt(1))).reason, 'return_structural_boundary_unproven');
});
test('a rollback witness cannot hide the earlier canonical terminal predecessor from verification', async t => {
  const h = fixture(t, [...run('A'), event('thread_rolled_back', { num_turns: 0 }), event('user_message', { message: 'prestart' }),
    event('task_started', { turn_id: 'B' }), event('task_complete', { turn_id: 'B', last_agent_message: 'done' })]);
  h.references([h.receipt(4)]); h.feed();
  fs.writeFileSync(h.file, fs.readFileSync(h.file, 'utf8').replace('"type":"task_complete"', '"type":"token_counter"') + '{}\n');
  assert.equal((await h.owner.read(h.source, h.receipt(4))).known, false);
});
test('an exact causal interval can stream one large ignored record without the old total-byte refusal', async t => {
  const h = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'return' }),
    event('token_count', { padding: 'x'.repeat(2 * 1024 * 1024 + 100) }),
    event('task_complete', { turn_id: 'T', last_agent_message: 'done' })]);
  h.references([h.receipt(1)]); h.feed();
  const open = fs.promises.open; let reads = 0;
  fs.promises.open = async function (file, ...args) { if (file === h.file) reads++; return open.call(this, file, ...args); };
  let result; try { result = await h.owner.read(h.source, h.receipt(1)); } finally { fs.promises.open = open; }
  assert.equal(result.known, true); assert.equal(reads, 1);
});
test('a large unrelated prefix is not read when the exact causal interval is small', async t => {
  const h = fixture(t, [event('token_count', { padding: 'x'.repeat(3 * 1024 * 1024) }), ...run('T')]);
  h.references([h.receipt(2)]); h.feed();
  const open = fs.promises.open; let bytes = 0;
  fs.promises.open = async function (file, ...args) {
    const fd = await open.call(this, file, ...args);
    if (file === h.file) { const read = fd.read.bind(fd); fd.read = async (...params) => { const result = await read(...params); bytes += result.bytesRead; return result; }; }
    return fd;
  };
  let result; try { result = await h.owner.read(h.source, h.receipt(2)); } finally { fs.promises.open = open; }
  assert.equal(result.known, true); assert.ok(bytes > 0 && bytes < 2000);
});
test('active exact return survives later turns, the rolling window limit and journal reopen', async t => {
  const h = fixture(t, [...run('T'), ...Array.from({ length: 20 }, (_, i) => run('later-' + i)).flat()], { maxRecords: 8 });
  h.references([h.receipt(1)]); h.feed(); h.reopen();
  const result = await h.owner.read(h.source, h.receipt(1));
  assert.equal(result.known, true); assert.equal(result.executionContext.turnId, 'T');
  assert.equal(h.owner.get('A').records.length <= 8, true, 'the rolling window itself stays bounded');
});
test('retained completed facts reject selected-byte rewrite even with a later append and new stat', async t => {
  const h = fixture(t, run('T')); h.references([h.receipt(1)]); h.feed();
  fs.writeFileSync(h.file, fs.readFileSync(h.file, 'utf8').replace('private prompt body', 'altered prompt body') + '{}\n');
  assert.equal((await h.owner.read(h.source, h.receipt(1))).known, false);
});
test('retained completed facts do not survive inode replacement, revision change or a changed SID/attempt', async t => {
  const h = fixture(t, run('T')); h.references([h.receipt(1)]); h.feed();
  assert.equal((await h.owner.read({ ...h.source, sessionId: 'new' }, h.receipt(1))).known, false);
  assert.equal((await h.owner.read(h.source, { ...h.receipt(1), attemptId: 'wrong' })).known, false);
  const renamed = h.file + '.old'; fs.renameSync(h.file, renamed); fs.copyFileSync(renamed, h.file);
  assert.equal((await h.owner.read(h.source, h.receipt(1))).known, false);
  h.revise(); assert.equal((await h.owner.read(h.source, h.receipt(1))).known, false);
});
test('the active-reference pin is pruned by its own owner, not kept for all later users', async t => {
  const h = fixture(t, run('T')); h.references([h.receipt(1)]); h.feed();
  assert.equal(h.owner.get('A').retained.length, 1);
  h.references([]); h.append(run('later')); h.feed();
  assert.equal(h.owner.get('A').retained.length, 0);
});
test('a pinned carrier remains available when many following users evict its rolling-window start before completion', async t => {
  const h = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'return' })], { maxRecords: 4 });
  h.references([h.receipt(1)]); h.feed();
  h.append([...Array.from({ length: 12 }, (_, i) => event('user_message', { message: 'later-' + i })),
    event('task_complete', { turn_id: 'T', last_agent_message: 'done' })]); h.feed(); h.reopen();
  assert.equal((await h.owner.read(h.source, h.receipt(1))).executionContext.turnId, 'T');
});
test('pre-start queued return is pinned to its next legal task, not the preceding completed task', async t => {
  const h = fixture(t, [...run('A'), event('user_message', { message: 'prestart' })], { maxRecords: 4 });
  h.references([h.receipt(3)]); h.feed();
  h.append([event('task_started', { turn_id: 'B' }), event('task_complete', { turn_id: 'B', last_agent_message: 'done' }), ...run('C')]);
  h.feed(); h.reopen();
  assert.equal((await h.owner.read(h.source, h.receipt(3))).executionContext.turnId, 'B');
});
test('legal pre-start reply maps to B, never old auditExecutionContext=A or latest C', async t => {
  const rows = [...run('A'), event('user_message', { message: 'queued reply' }),
    event('task_started', { turn_id: 'B' }), event('task_complete', { turn_id: 'B', last_agent_message: 'handled' }), ...run('C')];
  const h = fixture(t, rows); h.feed();
  const receipt = { ...h.receipt(3), executionContext: { provider: 'codex', sessionId: 'S', turnId: 'A' } };
  const result = await h.owner.read(h.source, receipt);
  assert.equal(result.known, true); assert.equal(result.executionContext.turnId, 'B');
});
test('a steering user in an already open turn keeps the canonical existing turn', async t => {
  const h = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'start' }),
    event('user_message', { message: 'steering' }), event('task_complete', { turn_id: 'T', last_agent_message: 'done' })]);
  h.feed(); assert.equal((await h.owner.read(h.source, h.receipt(2))).executionContext.turnId, 'T');
});
test('already-running turn keeps only a bounded RAM boundary before a return exists; unrelated tabs write no journal rows', async t => {
  const h = fixture(t, run('T'));
  h.feed(record => ({ observing: record.payload.type !== 'task_started' }));
  assert.equal((await h.owner.read(h.source, h.receipt(1))).executionContext.turnId, 'T');
  h.db.exec('DELETE FROM tab_message_return_facts');
  h.feed({ observing: false });
  assert.equal(h.db.prepare('SELECT count(*) n FROM tab_message_return_facts').get().n, 0);
});
test('canonical aliases crossing provider turns are unavailable, not nearest-final success', async t => {
  const h = fixture(t, [...run('A'), ...run('B')]); h.feed();
  const receipt = { ...h.receipt(4), userUuidAliases: [h.receipt(1).userUuid] };
  assert.equal((await h.owner.read(h.source, receipt)).known, false);
});
for (const [name, extra] of [
  ['old watcher', { currentWatcher: false }], ['old terminal', { currentTerminal: false }],
  ['old lifecycle', { watcherGeneration: 'old' }], ['old run', { watcherRunSeq: 1 }],
  ['suppressed catchup', { suppressed: true }], ['deferred composer', { deferred: true }],
  ['source observation', { sourceObservation: true }], ['manual conflict', { manualConflict: true }],
  ['pre-boundary', { boundaryOffset: 999999 }], ['old sequence', { liveAfterOffset: 999999 }],
]) test(name + ' cannot publish a positive return fact', async t => {
  const h = fixture(t, run('T')); h.feed(extra); assert.equal((await h.owner.read(h.source, h.receipt(1))).known, false);
});
for (const [name, end] of [
  ['provider error', event('task_complete', { turn_id: 'T', last_agent_message: 'partial', error: { message: 'refused' } })],
  ['no final', event('task_complete', { turn_id: 'T', last_agent_message: '' })],
  ['abort', event('turn_aborted', { turn_id: 'T' })],
  ['wrong turn', event('task_complete', { turn_id: 'other', last_agent_message: 'not ours' })],
]) test(name + ' is not a processed return', async t => {
  const h = fixture(t, [event('task_started', { turn_id: 'T' }), event('user_message', { message: 'go' }), end]);
  h.feed(); assert.equal((await h.owner.read(h.source, h.receipt(1))).known, false);
});
test('source rewrite/revision/owner replacement invalidates facts; it never warms a cold reader', async t => {
  const h = fixture(t, run('T')); h.feed();
  assert.equal((await h.owner.read({ ...h.source, sessionId: 'other' }, h.receipt(1))).known, false);
  h.revise(); assert.equal((await h.owner.read(h.source, h.receipt(1))).known, false);
  fs.writeFileSync(h.file, 'replacement\n');
  assert.equal((await h.owner.read(h.source, h.receipt(1))).known, false);
});
test('exact point digests reject changed bytes even if a coarse saved stat has advanced to the replacement snapshot', async t => {
  const h = fixture(t, run('T')); h.feed();
  fs.writeFileSync(h.file, fs.readFileSync(h.file, 'utf8').replace('private prompt body', 'altered prompt body'));
  const stored = h.owner.get('A'), stat = fs.statSync(h.file);
  stored.statKey = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  h.db.prepare('UPDATE tab_message_return_facts SET value=? WHERE tabId=?').run(JSON.stringify(stored), 'A');
  const result = await h.owner.read(h.source, h.receipt(1));
  assert.equal(result.known, false); assert.equal(result.reason, 'return_record_changed');
});
test('Claude unique staged audit -> exact hook turn joins a later canonical receipt, not another Stop/attempt', async t => {
  const h = fixture(t, []), context = { provider: 'claude', sessionId: 'S', turnId: 'claude:1', generation: 1, processId: 42 };
  const receipt = { operationKey: 'O', attemptId: 'A', handoffId: 'H', provider: 'claude', sessionId: 'S', userUuid: 'native-user' };
  const source = { ...h.source, provider: 'claude' };
  h.owner.observeClaude({ tabId: 'A', sessionId: 'S', transcriptPath: h.file, event: 'UserPromptSubmit', admitted: true,
    context, audit: { handoffId: 'H', sendOperationKey: 'O', sendAttemptId: 'A' }, promptId: 'native-prompt' });
  assert.equal((await h.owner.read(source, receipt)).known, false);
  await h.owner.observeClaude({ tabId: 'A', sessionId: 'S', event: 'Stop', admitted: true, matched: true,
    context: { ...context, processId: 43 }, promptId: 'native-prompt', outcomeTs: 500, hasFinalResult: true });
  assert.equal((await h.owner.read(source, receipt)).known, false);
  await h.owner.observeClaude({ tabId: 'A', sessionId: 'S', event: 'Stop', admitted: true, matched: true,
    context, promptId: 'native-prompt', outcomeTs: 500, hasFinalResult: true });
  assert.equal((await h.owner.read(source, { ...receipt, attemptId: 'wrong' })).known, false);
  assert.equal((await h.owner.read(source, receipt)).natural, true);
});
test('actual Main Codex producer call feeds the existing classifier/resolver and a preserved app database; no new lifecycle input', async t => {
  const h = fixture(t, run('T')), terminal = {}, tracker = {}, state = { tabId: 'A', sessionId: 'S',
    sourceObservationTerminal: terminal, processGeneration: 'G', sourceObservationRunSeq: 2,
    processGenerationBoundaryOffset: 0, capacityRetryLiveAfterOffset: 0,
    messageReturnSource: { filePath: h.file, stat: fs.statSync(h.file), revision: 'R' } };
  const context = vm.createContext({ state, path, crypto: { createHash }, Buffer,
    srcMainDir: __dirname, require: name => name.endsWith('web-server') ? { needsMessageReturnProof: () => true } : require(name),
    getMessageReturnProofs: () => h.owner, codexTurnWatchers: new Map([['A', state]]), terminals: new Map([['A', terminal]]),
    terminalCommandState: new Map([['A', { runSeq: 2 }]]), getTerminalLifecycleGeneration: () => 'G',
    suppressPublications: false, console: { warn: message => assert.fail(message) } });
  for (const record of h.rows) {
    context.record = record; context.event = record.payload.type;
    context.line = JSON.stringify({ type: record.type, timestamp: record.timestamp, payload: record.payload });
    context.turnOutcome = classifyCodexTurnRecord(tracker, record);
    vm.runInContext(producer('observeCodex'), context);
  }
  assert.equal((await h.owner.read(h.source, h.receipt(1))).natural, true);
  assert.equal(context.terminals.get('A'), terminal);
});
test('actual Main factory binds the exact readonly active-return port, not a boolean or a History reader', t => {
  const h = fixture(t, run('T')), references = [h.receipt(1)], requests = [];
  const getter = mainTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getMessageReturnProofs').getText(mainTree);
  const c = vm.createContext({ messageReturnProofs: null, path, srcMainDir: __dirname,
    projectManager: { db: { db: h.db } }, codexDataModule: { _api },
    transcriptService: { readCodexResultSourceRevision: () => 'R' },
    require: name => name.endsWith('web-server') ? {
      readMessageReturnReferences: tabId => { requests.push(tabId); return references; }, wakeMessageLoopWaits() {},
    } : require(name) });
  const owner = vm.runInContext(getter + '\ngetMessageReturnProofs()', c);
  assert.equal(owner.readReferences('A'), references); assert.deepEqual(requests, ['A']);
});

if (process.env.MESSAGE_RETURN_LEGACY_RECOVERY_REPRO === '1') {
  test('legacy C gap: completed carrier evicted before active-reference pin requires a separate bounded recovery', async t => {
    const h = fixture(t, [...run('old-return'), ...Array.from({ length: 12 }, (_, i) => run('later-' + i)).flat()], { maxRecords: 8 });
    h.feed(); h.reopen(); h.references([h.receipt(1)]);
    const result = await h.owner.read(h.source, h.receipt(1));
    assert.equal(result.known, true, 'remaining legacy acceptance, not satisfied by the forward active-reference pin');
  });
}
