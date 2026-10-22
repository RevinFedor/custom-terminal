'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const http = require('node:http');
const { WorkingDirectoryOperations } = require('./working-directory-operation');
const { createHistoryMutationInputGate } = require('./history-mutation-input');
const { handleWorkingDirectoryOperationApi, WORKING_DIRECTORY_CAPABILITY } = require('./working-directory-operation-api');
const quiet = { log() {}, warn() {}, error() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = { operationId: 'move-1', expectedSessionId: 'source', targetCwd: '/b' };

function fixture(t, options = {}) {
  const sql = new Database(':memory:');
  sql.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  t.after(() => sql.close());
  const state = { terminalToken: {}, projectId: 'project', cwd: '/a', toolType: 'codex',
    subjectId: 'subject', sessionId: 'source', runSeq: 4, lifecycleGeneration: 'T:4', inputRevision: 2,
    isRunning: false, processLookupUnknown: false, stopping: false, ...options.state };
  let current = { coherent: true, status: 'inactive', processStatus: 'absent', inputReady: false,
    writerConfirmed: true, ...options.current };
  const calls = [], changes = [], waiters = [];
  const db = { db: sql, getAppState(key) { const row = sql.prepare('SELECT value FROM app_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; },
    setAppState(key, value) {
      if (options.failWrite?.(value)) throw Error('fixture EIO');
      sql.prepare('INSERT OR REPLACE INTO app_state VALUES (?,?)').run(key, JSON.stringify(value));
    } };
  const capture = () => ({ ...state });
  const gate = createHistoryMutationInputGate({ capture, log: quiet,
    readSendBusy: () => options.sendBusy === true,
    readInputBoundary: async () => ({ known: true, ownerStable: true, isCurrent: () => true,
      processStatus: current.processStatus, status: current.status, inputReady: current.inputReady }) });
  const runtime = {
    capture,
    reserveInput: args => gate.reserve(args),
    assertInput: proof => gate.assert('tab', proof, { action: 'mutation', toolType: 'codex' }),
    finishInput: proof => gate.finish(proof),
    resolveTarget: async target => { calls.push('resolve'); return options.resolveTarget ? options.resolveTarget(target, state) : target; },
    readCurrent: async () => ({ ...current, cwd: state.cwd, sessionId: state.sessionId }),
    inspectDraft: async () => options.draft || { success: true, hasDraft: false },
    stop: async (_tab, proof, guard) => gate.run(proof, async () => {
      calls.push('stop'); state.stopping = true; guard(); state.stopping = false;
      if (options.stopError) return { success: false, error: options.stopError };
      state.isRunning = false; current = { ...current, status: 'inactive', processStatus: 'absent' };
      return { success: true };
    }),
    changeCwd: async input => gate.run(input.historyInput, async () => {
      calls.push('cd');
      gate.beginDirectoryWrite(input.historyInput, { operationId: 'physical-cd', targetCwd: input.targetCwd });
      gate.claimDirectoryWrite(input.historyInput, 'physical-cd');
      if (options.cdError) return { success: false, error: options.cdError };
      Object.assign(state, { cwd: input.targetCwd, runSeq: state.runSeq + 1 });
      state.lifecycleGeneration = 'T:' + state.runSeq;
      const result = { success: true, accepted: true, persisted: true, cwd: state.cwd,
        operationId: 'physical-cd', proof: 'live-process-osc7' };
      gate.commitDirectoryWrite(input.historyInput, result);
      return result;
    }),
    resume: async input => {
      calls.push('resume');
      if (options.resumeError) return { success: false, launchWritten: false, error: options.resumeError };
      gate.authorizeResume(input.historyInput, { command: 'codex-c', sessionId: 'source' });
      state.runSeq++; state.lifecycleGeneration = 'T:' + state.runSeq;
      state.inputOwnerLaunchId = 'OWN';
      gate.claimLaunch(input.historyInput, 'OWN', state.runSeq);
      current = { coherent: true, status: 'active', processStatus: 'found', inputReady: true,
        writerConfirmed: true, launchId: 'OWN' };
      return { success: true, accepted: true, launchWritten: true, launchId: 'OWN' };
    },
    waitReady: async () => {
      if (options.waitReady) await options.waitReady(gate);
      return { ...current, cwd: state.cwd, sessionId: state.sessionId };
    },
    verifyExistingCwd: async () => options.existingNative || { known: true, cwd: state.cwd, sessionId: state.sessionId },
    verifyNativeCwd: async () => {
      if (options.afterNative) options.afterNative(current, state);
      return options.native || { known: true, cwd: state.cwd, sessionId: state.sessionId };
    },
  };
  const broadcast = (_id, packet) => {
    changes.push(packet.operation);
    for (const waiter of [...waiters]) if (waiter.predicate(packet.operation)) {
      waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(packet.operation);
    }
  };
  const service = new WorkingDirectoryOperations({ db, runtime, broadcast, log: quiet });
  const until = predicate => {
    const existing = changes.findLast ? changes.findLast(predicate) : [...changes].reverse().find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => waiters.push({ predicate, resolve }));
  };
  return { state, db, gate, service, runtime, calls, changes, until,
    current: () => current, setCurrent: patch => { current = { ...current, ...patch }; } };
}

test('stopped same-source transfer persists receipt, uses one cd/Resume and never replays same ID', async t => {
  const f = fixture(t);
  const initial = f.service.accept('tab', request);
  assert.equal(initial.pending, true);
  const done = await f.until(op => op.phase === 'completed');
  assert.equal(done.cwdChanged, true); assert.equal(done.inputReady, true); assert.equal(done.sessionId, 'source');
  assert.deepEqual(f.calls, ['resolve', 'cd', 'resume']);
  assert.equal(f.service.accept('tab', request).idempotent, true);
  const restarted = new WorkingDirectoryOperations({ db: f.db, runtime: f.runtime, log: quiet });
  assert.equal(restarted.accept('tab', request).state, 'completed');
  assert.equal(f.calls.filter(call => call === 'resume').length, 1);
  assert.throws(() => restarted.accept('tab', { ...request, targetCwd: '/c' }), /request_mismatch/);
});

test('busy transfer waits on event, then own Stop; FIFO remains held through delayed readiness', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { state: { isRunning: true }, current: { status: 'busy', processStatus: 'found', busy: true },
    waitReady: async gate => { assert.equal(gate.claimSend('tab'), null); await barrier; } });
  f.service.accept('tab', request);
  await f.until(op => op.phase === 'waiting-for-idle');
  assert.deepEqual(f.calls, ['resolve']); assert.equal(f.gate.claimSend('tab'), null);
  f.setCurrent({ busy: false, status: 'active' }); f.service.notify('tab');
  await f.until(op => op.phase === 'awaiting-input');
  assert.equal(f.gate.claimSend('tab'), null); release();
  const done = await f.until(op => op.phase === 'completed');
  assert.equal(done.processStopped, true); assert.deepEqual(f.calls, ['resolve', 'stop', 'cd', 'resume']);
  await tick(); assert.equal(f.gate.held('tab'), false);
});

for (const [label, options, code] of [
  ['unknown process', { current: { processStatus: 'unknown' } }, 'runtime_unknown'],
  ['draft', { state: { isRunning: true }, current: { processStatus: 'found', status: 'active' }, draft: { success: true, hasDraft: true } }, 'draft_present'],
  ['unknown draft', { state: { isRunning: true }, current: { processStatus: 'found', status: 'active' }, draft: { success: true, hasDraft: null } }, 'draft_unknown'],
  ['native queued work', { state: { isRunning: true }, current: { processStatus: 'found', status: 'active' }, draft: { success: false, hasDraft: false, code: 'cwd_operation_native_queue_pending' } }, 'native_queue_pending'],
]) test(label + ' fails before Stop/cd/Resume and keeps source', async t => {
  const f = fixture(t, options); f.service.accept('tab', request);
  const done = await f.until(op => op.phase === 'failed');
  assert.match(done.error, new RegExp(code)); assert.equal(done.partial, false);
  assert.equal(f.state.cwd, '/a'); assert.deepEqual(f.calls, ['resolve']);
});

test('unknown Send blocks operation acceptance without changing its delivery', t => {
  const f = fixture(t, { sendBusy: true });
  assert.throws(() => f.service.accept('tab', request), /history_input_send_pending/);
  assert.deepEqual(f.calls, []);
});

test('foreign input/Close during directory lookup cancels before writes', async t => {
  const f = fixture(t, { resolveTarget: async (_target, state) => { state.inputRevision++; return '/b'; } });
  f.service.accept('tab', request);
  const done = await f.until(op => op.phase === 'failed');
  assert.match(done.error, /owner_changed/); assert.deepEqual(f.calls, ['resolve']);
});

test('owned Stop does not cancel native work when Stop fails; no cd follows', async t => {
  const f = fixture(t, { state: { isRunning: true }, current: { status: 'active', processStatus: 'found' }, stopError: 'stop-unknown' });
  f.service.accept('tab', request); const done = await f.until(op => op.phase === 'failed');
  assert.equal(done.processStopped, null); assert.equal(done.cwdChanged, false);
  assert.deepEqual(f.calls, ['resolve', 'stop']);
});

test('Resume failure reports committed cwd and never auto-Resumes source', async t => {
  const f = fixture(t, { resumeError: 'launch-refused' }); f.service.accept('tab', request);
  const done = await f.until(op => op.phase === 'failed');
  assert.equal(done.cwdChanged, true); assert.equal(done.partial, true); assert.equal(done.launchWritten, false);
  assert.equal(f.state.cwd, '/b'); f.service.accept('tab', request);
  assert.deepEqual(f.calls, ['resolve', 'cd', 'resume']);
});

test('missing native cwd or readiness changed after proof never becomes completed', async t => {
  for (const options of [{ native: { known: false, reason: 'native-unknown' } },
    { native: { known: true, cwd: '/b', sessionId: 'unrelated' } },
    { afterNative: current => { current.inputReady = false; } }]) {
    const f = fixture(t, options); f.service.accept('tab', request);
    const done = await f.until(op => op.phase === 'failed');
    assert.equal(done.cwdChanged, true); assert.equal(done.launchWritten, true); assert.equal(done.inputReady, false);
  }
});

test('restart reads interrupted receipt without old authority or redispatch', async t => {
  const f = fixture(t, { state: { isRunning: true }, current: { status: 'busy', processStatus: 'found', busy: true } });
  f.service.accept('tab', request); await f.until(op => op.phase === 'waiting-for-idle');
  const restarted = new WorkingDirectoryOperations({ db: f.db, runtime: f.runtime, log: quiet });
  assert.equal(restarted.accept('tab', request).state, 'interrupted'); assert.deepEqual(f.calls, ['resolve']);
});

test('resume:false changes cwd without starting process or sending anything', async t => {
  const f = fixture(t); f.service.accept('tab', { ...request, resume: false });
  const done = await f.until(op => op.phase === 'completed');
  assert.equal(done.cwdChanged, true); assert.equal(done.launchWritten, false); assert.equal(done.inputReady, false);
  assert.deepEqual(f.calls, ['resolve', 'cd']);
});

for (const [label, pending, clear] of [
  ['Goal between turns', { goalWork: { pending: true } }, { goalWork: { pending: false } }],
  ['background work', { backgroundWorkCount: 1 }, { backgroundWorkCount: 0 }],
]) test(label + ' waits for an existing event without stopping work', async t => {
  const f = fixture(t, { state: { isRunning: true }, current: { status: 'active', processStatus: 'found', ...pending } });
  f.service.accept('tab', request);
  await f.until(op => op.phase === 'waiting-for-idle');
  assert.deepEqual(f.calls, ['resolve']);
  f.setCurrent(clear); f.service.notify('tab');
  const done = await f.until(op => op.phase === 'completed');
  assert.equal(done.processStopped, true);
});

test('manual Stop while waiting revokes operation, not a later Resume', async t => {
  const f = fixture(t, { state: { isRunning: true }, current: { status: 'busy', processStatus: 'found', busy: true } });
  f.service.accept('tab', request); await f.until(op => op.phase === 'waiting-for-idle');
  f.gate.cancel('tab'); f.service.notify('tab');
  const done = await f.until(op => op.phase === 'failed');
  assert.equal(done.partial, false); assert.deepEqual(f.calls, ['resolve']);
  f.setCurrent({ busy: false, status: 'active' }); f.service.notify('tab'); await tick();
  assert.deepEqual(f.calls, ['resolve']);
});

test('same-directory native proof is required for a read-only ready no-op', async t => {
  for (const known of [true, false]) {
    const f = fixture(t, { state: { isRunning: true }, current: { status: 'active', processStatus: 'found', inputReady: true },
      existingNative: { known, cwd: '/a', sessionId: 'source' } });
    f.service.accept('tab', { ...request, targetCwd: '/a' });
    const done = await f.until(op => op.phase === 'completed');
    assert.equal(done.cwdChanged, false);
    assert.deepEqual(f.calls, known ? ['resolve'] : ['resolve', 'stop', 'resume']);
    assert.equal(done.unchanged === true, known);
  }
});

test('post-launch receipt failure retains the known one launch and never replays', async t => {
  const f = fixture(t, { failWrite: value => value?.phase === 'awaiting-input' });
  f.service.accept('tab', request); const done = await f.until(op => op.phase === 'failed');
  assert.equal(done.cwdChanged, true); assert.equal(done.launchWritten, true); assert.equal(done.partial, true);
  f.service.accept('tab', request);
  assert.deepEqual(f.calls, ['resolve', 'cd', 'resume']);
});

test('post-cwd receipt failure preserves physical effect and never launches blindly', async t => {
  const f = fixture(t, { failWrite: value => value?.phase === 'cwd-committed' }); f.service.accept('tab', request);
  const done = await f.until(op => op.phase === 'failed');
  assert.equal(done.cwdChanged, true); assert.equal(done.partial, true); assert.deepEqual(f.calls, ['resolve', 'cd']);
});

test('actual MCP helper → private HTTP API → operation/real SQLite preserves same identity and failed GET', async t => {
  const f = fixture(t, { resumeError: 'fixture launch failure' });
  const sendJson = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture') return sendJson(res, 403, { ok: false });
    if (req.url === '/api/me') return sendJson(res, 200, { capabilities: { workingDirectory: WORKING_DIRECTORY_CAPABILITY } });
    await handleWorkingDirectoryOperationApi({ req, res, parsed: new URL(req.url, 'http://fixture'), service: f.service,
      sendJson, readBody: async incoming => { let body = ''; for await (const part of incoming) body += part; return JSON.parse(body); } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (target, route, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: target, path: route, method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' } }, res => {
      let value = ''; res.on('data', chunk => { value += chunk; }); res.on('end', () => {
        const parsed = JSON.parse(value);
        if (res.statusCode >= 400) reject(Object.assign(Error('HTTP ' + res.statusCode), { toolDetails: parsed }));
        else resolve(parsed);
      });
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const { callWorkingDirectoryOperation } = await import('../../mcp/working-directory-operation.mjs');
  const ports = { target: server.address().port, get: call, post: call };
  const accepted = await callWorkingDirectoryOperation('change_working_directory', { tabId: 'tab', ...request }, ports);
  assert.equal(accepted.operation.operationId, request.operationId);
  await f.until(op => op.phase === 'failed');
  const got = await callWorkingDirectoryOperation('get_working_directory_operation', { tabId: 'tab', operationId: request.operationId }, ports);
  assert.equal(got.operation.success, false); assert.equal(got.operation.cwdChanged, true);
  assert.equal(got.operation.launchWritten, false); assert.equal(f.calls.filter(item => item === 'resume').length, 1);
});

test('old app / malformed request / lost ACK never fall back or retry', async () => {
  const { callWorkingDirectoryOperation } = await import('../../mcp/working-directory-operation.mjs');
  let posts = 0;
  const ports = { target: {}, get: async () => ({ capabilities: {} }), post: async () => { posts++; } };
  await assert.rejects(callWorkingDirectoryOperation('change_working_directory', { tabId: 'tab', ...request }, ports),
    error => error.toolDetails.code === 'app_update_required' && !error.toolDetails.mutationAttempted);
  assert.equal(posts, 0);
  ports.get = async () => ({ capabilities: { workingDirectory: WORKING_DIRECTORY_CAPABILITY } });
  ports.post = async () => { posts++; throw Error('lost ACK'); };
  await assert.rejects(callWorkingDirectoryOperation('change_working_directory', { tabId: 'tab', ...request }, ports),
    error => error.toolDetails.mutationAttempted && error.toolDetails.receiptRead.operationId === request.operationId);
  assert.equal(posts, 1);
  await assert.rejects(callWorkingDirectoryOperation('change_working_directory', { tabId: 'tab', ...request, targetCwd: 'relative' }, ports));
  assert.equal(posts, 1);
});
