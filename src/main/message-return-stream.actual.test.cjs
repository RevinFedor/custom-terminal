'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { _api } = require('./ipc/codex-data');
const { classifyCodexTurnRecord } = require('./codex-turn-outcome');
const { MessageLoopWaits } = require('./message-loop-waits');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const event = (type, fields = {}) => ({ type: 'event_msg', timestamp: '2026-10-25T01:00:00Z', payload: { type, ...fields } });
const immediate = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let Owner = require('./message-return-proofs').MessageReturnProofs;
if (process.env.MESSAGE_RETURN_PROOF_TARGET) {
  const Module = require('node:module'), compiled = new Module(__filename, module);
  compiled.filename = require.resolve('./message-return-proofs'); compiled.paths = Module._nodeModulePaths(__dirname);
  compiled._compile(fs.readFileSync(process.env.MESSAGE_RETURN_PROOF_TARGET, 'utf8'), compiled.filename);
  Owner = compiled.exports.MessageReturnProofs;
}

// Fixture generation never builds a large body string, JSON tree or record.
// Only the three small admitted records enter the real proof owner/resolver.
function fixture(t, { bodyBytes = 3 * 1024 * 1024, before = false, prefixBytes = 0, preStart = false,
  verifierOptions = {}, maxRecords = 128, missingStart = false, arrayBody = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-return-stream-')), file = path.join(root, 'own.jsonl');
  const db = new Database(':memory:'), fd = fs.openSync(file, 'wx');
  let offset = 0, line = 0;
  const rows = [], metrics = [], phases = [], piece = arrayBody ? Buffer.from(',0'.repeat(4096)) : Buffer.alloc(8192, 120);
  const write = value => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); fs.writeSync(fd, bytes); offset += bytes.length; };
  const repeated = length => { for (let left = length; left; ) { const size = Math.min(piece.length, left); write(piece.subarray(0, size)); left -= size; } };
  const record = (value, admitted = true) => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n'), start = offset, physicalLine = line++;
    write(bytes);
    if (admitted) rows.push({ record: { ...value, __line: physicalLine, __byteOffset: start, __eventSequence: physicalLine + 1 },
      span: { start, length: bytes.length, digest: hash(bytes) } });
    return { start, physicalLine };
  };
  let body;
  try {
    if (prefixBytes) { write('{"type":"event_msg","payload":{"type":"token_count","padding":"'); repeated(prefixBytes); write('"}}\n'); line++; }
    if (preStart) {
      record(event('task_started', { turn_id: 'P' }));
      record(event('task_complete', { turn_id: 'P', last_agent_message: 'previous' }));
    }
    if (!preStart) record(event('task_started', { turn_id: 'T' }));
    const tools = () => {
      record({ type: 'response_item', payload: { type: 'function_call', call_id: 'C', name: 'read_file', arguments: '{}' } }, false);
      write('{"type":"response_item","payload":{"type":"function_call_output","call_id":"C","output":' + (arrayBody ? '[0' : '"'));
      body = { from: offset, length: bodyBytes }; repeated(bodyBytes); write(arrayBody ? ']}}\n' : '"}}\n'); line++;
    };
    if (before && !preStart) tools();
    const carrier = record(event('user_message', { message: 'addressed return' }));
    if (preStart) record(event('task_started', { turn_id: 'T' }));
    if (!before || preStart) tools();
    record(event('task_complete', { turn_id: 'T', last_agent_message: 'natural final' }));
    const receipt = { state: 'confirmed', operationKey: 'O', attemptId: 'A', handoffId: 'H', provider: 'codex', sessionId: 'S',
      userUuid: 'codex-user-S-' + carrier.physicalLine, sourceIdentity: 'codex-user-source-S-' + carrier.start };
    const source = { known: true, tabId: 'A', projectId: 'P', provider: 'codex', sessionId: 'S' };
    let references = [receipt], referenceReader = () => references;
    const args = { db, findExecutionContext: _api.findCodexPromptExecutionContext, readRevision: () => 'R', maxRecords,
      readReferences: () => referenceReader(), verifierOptions: { log: () => {}, ...verifierOptions,
        onMetrics(value) { metrics.push(value); verifierOptions.onMetrics?.(value); },
        onPhase(value) { phases.push(value); verifierOptions.onPhase?.(value); } } };
    let owner = new Owner(args), tracker = {};
    for (const row of rows) {
      if (missingStart && row.record.payload.type === 'task_started') continue;
      owner.observeCodex({ tabId: 'A', sessionId: 'S', record: row.record, recordSpan: row.span,
      outcome: classifyCodexTurnRecord(tracker, row.record), source: { filePath: file, stat: fs.statSync(file), revision: 'R' },
      currentWatcher: true, currentTerminal: true, lifecycleGeneration: 'G', watcherGeneration: 'G', runSeq: 1, watcherRunSeq: 1,
      boundaryOffset: 0, liveAfterOffset: 0, suppressed: false, deferred: false, sourceObservation: false, manualConflict: false });
    }
    const cleanup = () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); };
    t?.after(cleanup);
    return { root, file, db, rows, body, source, receipt, metrics, phases, cleanup,
      sourceBytes: offset, get owner() { return owner; },
      refs(value) { references = value; }, referenceReader(value) { referenceReader = value; },
      reopen() { owner = new Owner(args); },
      read(options) { return owner.read(source, receipt, options); },
      append() { fs.appendFileSync(file, '{}\n'); },
      write(position, bytes) { const handle = fs.openSync(file, 'r+'); try { fs.writeSync(handle, bytes, 0, bytes.length, position); } finally { fs.closeSync(handle); } },
    };
  } catch (error) { db.close(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
  finally { fs.closeSync(fd); }
}

async function memoryChild() {
  const mib = Number(process.argv[3]), kind = process.argv[4] || 'string';
  const h = fixture(null, { bodyBytes: mib * 1024 * 1024, arrayBody: kind === 'array',
    verifierOptions: { schedule: async () => { sample(); await immediate(); } } });
  let baseline, peak, samples = 0;
  function sample() {
    const next = process.memoryUsage(); samples++;
    for (const key of Object.keys(next)) peak[key] = Math.max(peak[key], next[key]);
  }
  try {
    global.gc(); baseline = process.memoryUsage(); peak = { ...baseline };
    const nativeBaseline = process.resourceUsage().maxRSS;
    const result = await h.read(); sample(); global.gc();
    assert.equal(result.known, true); assert.equal(result.executionContext.turnId, 'T');
    const report = { node: process.versions.node, electron: process.versions.electron, abi: process.versions.modules,
      root: h.root, kind, fixtureBodyBytes: mib * 1024 * 1024, fixtureBytes: h.sourceBytes,
      fixtureConstruction: '8192-byte repeated writes, no full body value; finished before baseline GC',
      baseline, sampledPeak: peak, afterGc: process.memoryUsage(), samples,
      platform: process.platform, nativeMaxRSSRaw: process.resourceUsage().maxRSS, nativeBaselineMaxRSSRaw: nativeBaseline,
      nativeMaxRSSUnits: 'platform raw, not normalized; memoryUsage RSS above is bytes',
      verification: h.metrics, result };
    h.cleanup(); report.fixtureRemoved = !fs.existsSync(h.root);
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch (error) { h.cleanup(); throw error; }
}

function waitFixture(t, h, { readDelivery = () => ({ ...h.receipt, messageId: 'R', tabId: 'A',
  promptHash: 'verified', requestHash: 'verified-request' }), readSource = () => h.source } = {}) {
  const changes = [];
  const question = { messageId: 'Q', source: { tabId: 'A', projectId: 'P', provider: 'codex', sessionId: 'S' },
    targetTabId: 'B', deliveryState: 'sent', waitRequiredAt: Date.now(),
    reply: { messageId: 'R', operationKey: 'O', handoffId: 'H', deliveryState: 'sent' } };
  const wait = new MessageLoopWaits({ db: h.db, messages: { questionWaitReference: () => question }, readSource,
    readDelivery, readCompletion: (source, receipt) => h.owner.read(source, receipt),
    sendNotice: () => { throw Error('no new notice permitted'); }, changed: value => changes.push(value),
    setDeadline: () => 1, clearDeadline() {} });
  wait.observe({ kind: 'question', messageId: 'Q' });
  h.referenceReader(() => wait.observing('A') ? [h.receipt] : []);
  t.after(() => wait.dispose());
  return { wait, question, changes };
}

if (process.argv[2] === '--memory-child') {
  memoryChild().catch(error => { console.error(error.stack); process.exitCode = 1; });
} else {
  for (const before of [false, true]) test('one large tool-output record ' + (before ? 'before' : 'after') + ' Return is streamed, not materialized', async t => {
    const h = fixture(t, { before });
    const result = await h.read();
    assert.equal(result.known, true); assert.equal(result.executionContext.turnId, 'T');
    const m = h.metrics.at(-1);
    assert.ok(m.readBytes > h.body.length && m.readBytes < h.sourceBytes + 1000);
    assert.equal(m.maxReadBytes, 16384); assert.equal(m.bufferBytes, 16384);
    assert.ok(m.maxLatin1Bytes <= 16384 && m.maxTokenBytes <= 1026 && m.maxParserFrames <= 256);
    assert.ok(m.metadataBytes < 4096); assert.ok(m.yields > 100);
    t.diagnostic(JSON.stringify(m));
  });
  test('one scan coalesces concurrent readers; unchanged wakes and a stable malformed miss do not rescan', async t => {
    const h = fixture(t);
    const results = await Promise.all([h.read(), h.read(), h.read()]);
    assert.equal(results.every(value => value.known), true);
    assert.equal(h.metrics.length, 1);
    for (let i = 0; i < 3; i++) assert.equal((await h.read()).known, true);
    assert.equal(h.metrics.slice(1).every(value => value.cache === 'hit' && value.readBytes === 0), true);
    h.append(); assert.equal((await h.read()).known, true);
    const scans = h.metrics.filter(value => value.cache === 'miss'); assert.equal(scans.length, 2);
    assert.equal((await h.read()).known, true); assert.equal(h.metrics.at(-1).readBytes, 0);
    h.write(h.body.from + 20, Buffer.from('\\q'));
    assert.equal((await h.read()).reason, 'return_structural_gap');
    assert.equal((await h.read()).reason, 'return_structural_gap'); assert.equal(h.metrics.at(-1).readBytes, 0);
  });
  test('late canonical receipt and journal reopen keep the exact long-turn association', async t => {
    const h = fixture(t, { preStart: true });
    h.refs([]); assert.equal((await h.read()).known, false);
    h.refs([h.receipt]); assert.equal((await h.read()).executionContext.turnId, 'T');
    h.reopen(); assert.equal((await h.read()).executionContext.turnId, 'T');
    const stored = h.db.prepare('SELECT value FROM tab_message_return_facts').get().value;
    assert.ok(Buffer.byteLength(stored) < 8192); assert.doesNotMatch(stored, /xxxx/);
  });
  test('a large unrelated prefix is excluded from the streaming interval', async t => {
    const h = fixture(t, { prefixBytes: 5 * 1024 * 1024 });
    assert.equal((await h.read()).known, true);
    const m = h.metrics.at(-1); assert.ok(m.readBytes < h.sourceBytes - 5 * 1024 * 1024 + 1000);
    assert.equal(m.intervalBytes, h.rows.at(-1).span.start + h.rows.at(-1).span.length - h.rows[0].span.start);
  });
  test('missing admitted boundaries never trigger a search of the giant prefix', async t => {
    const h = fixture(t, { prefixBytes: 5 * 1024 * 1024, missingStart: true });
    const open = fs.promises.open; let calls = 0;
    fs.promises.open = async function (file, ...args) { if (file === h.file) calls++; return open.call(this, file, ...args); };
    try { assert.equal((await h.read()).known, false); }
    finally { fs.promises.open = open; }
    assert.equal(calls, 0); assert.equal(h.metrics.length, 0);
  });
  test('ordinary event-loop callbacks continue while the exact long interval is verified', async t => {
    const h = fixture(t); let pulses = 0, handle, done = false;
    const pulse = () => {
      if (done) return;
      if (h.phases.some(value => value.phase === 'admission') && !h.metrics.length) pulses++;
      handle = setImmediate(pulse);
    };
    handle = setImmediate(pulse);
    try { assert.equal((await h.read()).known, true); }
    finally { done = true; clearImmediate(handle); }
    assert.ok(pulses > 2); t.diagnostic(JSON.stringify({ overlappingEventLoopCallbacks: pulses, chunks: h.metrics[0].chunks }));
  });
  test('structural insertion inside a large tool body is rejected even when selected spans are unchanged', async t => {
    const h = fixture(t, { before: true }); assert.equal((await h.read()).known, true);
    const injected = '"}}\n' + JSON.stringify(event('task_started', { turn_id: 'injected' }))
      + '\n{"type":"response_item","payload":{"type":"function_call_output","call_id":"C","output":"';
    h.write(h.body.from + 2048, Buffer.from(injected)); h.append();
    assert.equal((await h.read()).reason, 'return_structural_gap');
  });
  test('actual selected-byte rewrite, truncate/regrow and inode replacement revoke a cached proof', async t => {
    const h = fixture(t); assert.equal((await h.read()).known, true);
    const user = h.rows.find(value => value.record.payload.type === 'user_message');
    h.write(user.span.start + JSON.stringify(user.record).indexOf('addressed return'), Buffer.from('different return'));
    assert.equal((await h.read()).known, false);
    fs.truncateSync(h.file, user.span.start); h.append(); assert.equal((await h.read()).known, false);
    const replacement = h.file + '.new'; fs.writeFileSync(replacement, '{}\n'); fs.renameSync(replacement, h.file);
    assert.equal((await h.read()).known, false);
  });
  test('one borrower cancellation does not revoke a concurrent borrower of the same proof', async t => {
    const reached = deferred(), resume = deferred(); let first = true;
    const h = fixture(t, { verifierOptions: { schedule: async () => {
      if (first) { first = false; reached.resolve(); await resume.promise; } else await immediate();
    } } });
    const controller = new AbortController(), a = h.read({ signal: controller.signal }), b = h.read();
    await reached.promise; controller.abort(); assert.equal((await a).known, false); resume.resolve();
    assert.equal((await b).known, true); assert.equal(h.metrics.length, 1);
  });
  test('different exact receipt identities do not share a cancellation owner even for the same physical carrier', async t => {
    const reached = deferred(), resume = deferred(); let first = true;
    const h = fixture(t, { verifierOptions: { schedule: async () => {
      if (first) { first = false; reached.resolve(); await resume.promise; } else await immediate();
    } } });
    const other = { ...h.receipt, operationKey: 'O2', attemptId: 'A2', handoffId: 'H2' };
    h.refs([h.receipt, other]);
    const controller = new AbortController(), a = h.read({ signal: controller.signal }); await reached.promise;
    const b = h.owner.read(h.source, other); await immediate(); controller.abort();
    assert.equal((await a).known, false); resume.resolve(); assert.equal((await b).known, true);
    assert.equal(h.metrics.length, 2); assert.notEqual(h.metrics[0].proof, h.metrics[1].proof);
  });
  test('cancellation during an actual pending FD read returns no proof and accounts the completed bytes', async t => {
    const entered = deferred(), resume = deferred(), finished = deferred(); let blocked = false;
    const h = fixture(t, { verifierOptions: { onMetrics: () => finished.resolve() } });
    const open = fs.promises.open;
    fs.promises.open = async function (file, ...args) {
      const fd = await open.call(this, file, ...args);
      if (file === h.file) {
        const read = fd.read.bind(fd);
        fd.read = async (...values) => {
          const result = await read(...values);
          if (!blocked && values[2] === 16384) { blocked = true; entered.resolve(); await resume.promise; }
          return result;
        };
      }
      return fd;
    };
    try {
      const controller = new AbortController(), reading = h.read({ signal: controller.signal });
      await entered.promise; controller.abort(); assert.equal((await reading).reason, 'return_verification_cancelled');
      resume.resolve(); await finished.promise;
      assert.equal(h.metrics[0].readBytes, 16384); assert.equal(h.metrics[0].reason, 'return_verification_cancelled');
    } finally { resume.resolve(); fs.promises.open = open; }
  });
  test('cancellation while queued removes the waiter without reading the second source', async t => {
    const reached = deferred(), resume = deferred(), queued = deferred(); let first = true;
    const a = fixture(t, { verifierOptions: { schedule: async () => {
      if (first) { first = false; reached.resolve(); await resume.promise; } else await immediate();
    } } });
    const active = a.read(); await reached.promise;
    const b = fixture(t, { verifierOptions: { onPhase: value => { if (value.phase === 'admission') queued.resolve(); } } });
    const controller = new AbortController(), waiting = b.read({ signal: controller.signal });
    await queued.promise; controller.abort(); assert.equal((await waiting).known, false);
    resume.resolve(); assert.equal((await active).known, true); await immediate();
    assert.equal(b.metrics.at(-1).readBytes, 0);
  });
  for (const change of ['cancel', 'owner', 'receipt']) test(change + ' during a streaming checkpoint never publishes a positive proof', async t => {
    const reached = deferred(), resume = deferred(), finished = deferred(); let first = true;
    const h = fixture(t, { verifierOptions: { schedule: async () => {
      if (first) { first = false; reached.resolve(); await resume.promise; } else await immediate();
    }, onMetrics: () => finished.resolve() } });
    const reading = h.read(); await reached.promise;
    if (change === 'owner') {
      const row = h.owner.get('A'); row.basis.sessionId = 'replacement';
      h.db.prepare('UPDATE tab_message_return_facts SET value=? WHERE tabId=?').run(JSON.stringify(row), 'A');
    } else h.refs(change === 'receipt' ? [{ ...h.receipt, attemptId: 'new-attempt' }] : []);
    resume.resolve(); assert.equal((await reading).known, false); await finished.promise;
  });
  test('deadline is finite and its same-snapshot attention miss is not scanned on every wake', async t => {
    const reached = deferred(), resume = deferred(), finished = deferred(); let first = true;
    const h = fixture(t, { verifierOptions: { timeoutMs: 30, schedule: async () => {
      if (first) { first = false; reached.resolve(); await resume.promise; } else await immediate();
    }, onMetrics: () => finished.resolve() } });
    const reading = h.read(); await reached.promise;
    assert.equal((await reading).reason, 'return_verification_deadline'); resume.resolve(); await finished.promise;
    assert.equal((await h.read()).reason, 'return_verification_deadline'); assert.equal(h.metrics.at(-1).readBytes, 0);
  });
  test('addressed delivery completes without entering the historical streaming verifier', async t => {
    const h = fixture(t), { wait, question, changes } = waitFixture(t, h);
    wait.readCompletion = () => { throw Error('ordinary Send/Reply must not scan a processing interval'); };
    assert.equal(wait.blocks('A'), true); await wait.settle('Q');
    assert.equal(wait.blocks('A'), false); assert.equal(wait.entries.get('Q').replyProcessed, undefined);
    assert.equal(wait.entries.get('Q').settlement.messageId, question.reply.messageId);
    await wait.settle('Q'); assert.equal(changes.filter(value => value.state === 'settled').length, 1);
    assert.equal(h.metrics.length, 0); assert.equal(wait.observing('A'), false);
  });
  test('delivery receipt race refuses settlement without starting a historical scan', async t => {
    const h = fixture(t); let reads = 0;
    const base = { ...h.receipt, messageId: 'R', tabId: 'A', promptHash: 'verified', requestHash: 'verified-request' };
    const { wait } = waitFixture(t, h, { readDelivery: () => ++reads === 1
      ? base : { ...base, attemptId: 'different-attempt' } });
    assert.equal(await wait.settle('Q'), false); assert.equal(wait.blocks('A'), true);
    assert.equal(wait.entries.get('Q').replyProcessed, undefined); assert.equal(h.metrics.length, 0);
  });
  test('streaming projection validates malformed ignored JSON and bounds adversarial parser depth', async t => {
    const h = fixture(t, { bodyBytes: 16384 });
    h.write(h.body.from + 200, Buffer.from('\\q'));
    assert.equal((await h.read()).reason, 'return_structural_gap');
    const deep = fixture(t, { bodyBytes: 16384 });
    const prefix = '"}}\n' + '['.repeat(300) + '0' + ']'.repeat(300) + '\n'
      + '{"type":"response_item","payload":{"type":"function_call_output","output":"';
    deep.write(deep.body.from + 200, Buffer.from(prefix));
    assert.equal((await deep.read()).reason, 'return_proof_parser_limit');
    assert.equal(deep.metrics.at(-1).maxParserFrames, 256);
  });
  for (const [mib, kind] of [[64, 'string'], [8, 'array']]) test('isolated ' + mib + 'MiB ' + kind
    + ' record has bounded working memory, not a whole value allocation', t => {
    const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=96', __filename, '--memory-child', String(mib), kind], {
      encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MESSAGE_RETURN_PROOF_TARGET: '' },
    });
    assert.equal(child.status, 0, child.error?.message || child.stderr);
    const result = JSON.parse(child.stdout); t.diagnostic(JSON.stringify(result));
    assert.equal(result.fixtureRemoved, true); assert.equal(fs.existsSync(result.root), false);
    assert.ok(result.sampledPeak.heapUsed - result.baseline.heapUsed < 24 * 1024 * 1024);
    assert.ok(result.sampledPeak.external - result.baseline.external < 2 * 1024 * 1024);
    assert.ok(result.sampledPeak.arrayBuffers - result.baseline.arrayBuffers < 2 * 1024 * 1024);
    assert.equal(result.verification.at(-1).maxReadBytes, 16384);
  });
}
