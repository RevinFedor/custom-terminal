'use strict';
// Actual JSON store and production startup owner. Only file faults/delays and
// startup leaf callbacks/timers are controlled; no Mac or provider operations.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const { OrchestrationRunStore: Store } = require('./orchestration-runs');
const { hasBirth } = require('./external-research-completion-delivery');
const waitTurn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const unavailable = { code: 'orchestration_store_unavailable', statusCode: 503, retryable: true };
function row(id = 'R', status = 'creating') {
  return { runId: id, runKind: 'external-research', status, createdAt: Date.now(), completedAt: Date.now(),
    sourceTabId: 'source', sourceProjectId: 'P', sourceSendTarget: { toolType: 'codex', sessionId: 'original-S' },
    requestFingerprint: 'exact-' + id, externalResearchJobId: 'noted_' + id,
    externalResearchIntent: { provider: 'chatgpt', prompt: 'original', options: { effort: 'xhigh' }, files: [] },
    notificationStatus: 'pending', notifySource: true, targetCreatedByOrchestration: false };
}
function agent(id) { return { runId: id, runKind: 'agent', targetTabId: 'target-' + id,
  sourceTabId: 'source', requestFingerprint: 'exact-' + id, notifySource: false }; }
function fixture(t, rows = [row()]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-runstore-authority-'));
  const file = path.join(root, 'runs.json');
  fs.writeFileSync(file, JSON.stringify({ version: 4, runs: rows, createdTargetTabIds: ['old-owned-target'],
    targetActivityByTab: { 'old-owned-target': { revision: 7, busy: true, at: 12, source: 'owned' } },
    settings: { failureGraceMs: 1234 } }));
  const store = new Store(file);
  t.after(async () => { await store.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  return { file, store, bytes: fs.readFileSync(file), disk: () => JSON.parse(fs.readFileSync(file)),
    reopen: () => new Store(file) };
}
function failReads(t, file, count = Infinity, code = 'EIO') {
  const original = fs.promises.readFile; let left = count, reads = 0;
  fs.promises.readFile = async (...args) => {
    if (args[0] === file) { reads++; if (left-- > 0) throw Object.assign(Error('owned read ' + code), { code }); }
    return original(...args);
  };
  t.after(() => { fs.promises.readFile = original; });
  return { recover: () => { left = 0; }, count: () => reads };
}

for (const mode of ['create', 'settings', 'lifecycle']) test('one-shot EIO then scheduled ' + mode + ' preserves old cohort and bindings', async t => {
  const states = ['creating', 'running', 'failed', 'completed', 'cancelled'];
  const rows = states.map(s => row(s, s)); rows[4].notificationSuppressed = true;
  rows[3].externalResearchDeliveryUnknown = true;
  const h = fixture(t, rows), reads = failReads(t, h.file, 1);
  await h.store.initialize(); assert.equal(h.store.readInheritedActivity().known, false);
  assert.deepEqual(fs.readFileSync(h.file), h.bytes);
  if (mode === 'create') await h.store.create(agent('unrelated'));
  if (mode === 'settings') await h.store.updateSettings({ successAutoStopMs: 4567 });
  if (mode === 'lifecycle') await h.store.applyLifecycle('unrelated-target', { type: 'busy', busy: true });
  await h.store.flush(); assert.equal(reads.count(), 2);
  const restored = h.reopen(); await restored.initialize({ requireAuthority: true });
  for (const before of rows) {
    const after = await restored.getInternal(before.runId);
    assert.equal(after.status, before.status); assert.equal(hasBirth(after), false);
    assert.deepEqual(after.externalResearchIntent, before.externalResearchIntent);
    assert.deepEqual(after.sourceSendTarget, before.sourceSendTarget);
    assert.equal(after.externalResearchJobId, before.externalResearchJobId);
    assert.equal(after.notificationSuppressed, before.notificationSuppressed);
    assert.equal(after.externalResearchDeliveryUnknown, before.externalResearchDeliveryUnknown);
  }
  assert(restored.createdTargetTabIds.has('old-owned-target'));
  assert.equal(restored.targetActivityByTab.get('old-owned-target').revision, 7);
  assert.equal((await restored.getSettings()).failureGraceMs, 1234);
  await restored.flush();
});

const mutations = {
  create: s => s.create(agent('new'), { persistStrict: true }),
  reserve: s => s.reserveOrGet(agent('new')),
  patch: s => s.patch('R', { notifySource: false }),
  settings: s => s.updateSettings({ failureGraceMs: 42 }),
  cancel: s => s.cancel('R', { suppressNotification: false }),
  suppression: s => s.markNotification('R', 'suppressed'),
  dismiss: s => s.dismissAttention('R', 'source'),
  acknowledge: s => s.acknowledge('R', 'source'),
  sourceClosed: s => s.handleSourceClosed('source'),
  recovery: s => s.beginRecovery('R'),
  recoveryDeadlines: s => s.expireRecoveryDeadlines(),
  lifecycle: s => s.applyLifecycle('old-owned-target', { type: 'busy', busy: true }),
  launch: s => s.admitAgentLaunch('old-owned-target'),
  policy: s => s.cancelAutoStop('R'),
  continuation: s => s.beginRequestContinuation('R', {}),
  observation: s => s.setResponseObservationWait('R', {}),
  snapshot: s => s.applyExternalResearchSnapshot('R', { id: 'noted_R', status: 'done', result: { text: 'old final' } }),
};
for (const [name, mutate] of Object.entries(mutations)) test('unreadable authority refuses ' + name + ' before RAM mutation or false ACK', async t => {
  const h = fixture(t), reads = failReads(t, h.file);
  await h.store.initialize(); await assert.rejects(mutate(h.store), unavailable);
  assert.equal(h.store.runs.size, 0); assert.equal(h.store.createdTargetTabIds.size, 0);
  await h.store.flush(); assert.deepEqual(fs.readFileSync(h.file), h.bytes);
  reads.recover(); await h.store.initialize({ requireAuthority: true });
  assert.equal((await h.store.getInternal('R')).status, 'creating');
  assert.equal(hasBirth(await h.store.getInternal('R')), false);
});

for (const invalid of ['{broken', '{}', 'null', '{"runs":{}}', '{"runs":[null]}',
  JSON.stringify({ runs: [row(), row()] }), JSON.stringify({ runs: [{ runId: 'lost-agent' }] })]) {
  test('corrupt bytes remain untouched and are never empty-store authority: ' + invalid.slice(0, 45), async t => {
    const h = fixture(t); fs.writeFileSync(h.file, invalid);
    await h.store.initialize();
    await assert.rejects(h.store.create(agent('unrelated')), unavailable);
    assert.equal(h.store._schedulePersist(), undefined); await h.store.flush();
    await assert.rejects(h.store.persistStrict(), unavailable); await h.store.flush();
    await assert.rejects(h.store.listAll(), unavailable);
    assert.equal(fs.readFileSync(h.file, 'utf8'), invalid);
    // Only the private fixture operator restores the exact saved bytes.
    fs.writeFileSync(h.file, h.bytes);
    const accepted = await h.store.reserveOrGet(row());
    assert.equal(accepted.created, false); assert.equal(accepted.conflict, false);
    assert.equal(hasBirth(await h.store.getInternal('R')), false);
  });
}

test('rejected scheduled snapshot cannot gain authority from a later successful reread', async t => {
  const h = fixture(t), fault = failReads(t, h.file, 1), held = gate();
  await h.store.initialize(); h.store.persistChain = held.promise;
  assert.equal(h.store._schedulePersist(), undefined);
  const strict = h.store._enqueuePersist(true); const rejected = assert.rejects(strict, unavailable);
  // Loading is independent of the held write queue, but cannot rehabilitate
  // its earlier empty snapshot. New writes serialize after both rejections.
  const creating = h.store.create(agent('unrelated'), { persistStrict: true });
  await waitTurn(); assert.equal(fault.count(), 2);
  assert.deepEqual(fs.readFileSync(h.file), h.bytes);
  held.release(); await rejected; await creating; await h.store.flush();
  assert.deepEqual(h.disk().runs.map(r => r.runId), ['R', 'unrelated']);
});

test('one shared delayed reread serializes same-ID reservations and preserves concurrent cancels/settings/intents', async t => {
  const h = fixture(t, [row('R'), row('C')]), fault = failReads(t, h.file, 1);
  await h.store.initialize(); const original = fs.promises.readFile, held = gate(), entered = gate();
  fs.promises.readFile = async (...args) => { if (args[0] === h.file) { entered.release(); await held.promise; } return original(...args); };
  let ack = false;
  const one = h.store.reserveOrGet(row()); const two = h.store.reserveOrGet(row());
  const create = h.store.create(agent('new'), { persistStrict: true }).then(r => { ack = true; return r; });
  const cancel = h.store.cancel('C', { suppressNotification: false });
  const suppression = h.store.markNotification('R', 'suppressed');
  const settings = h.store.updateSettings({ successAutoStopMs: 9876 });
  await entered.promise; await waitTurn(); assert.equal(ack, false);
  assert.deepEqual(fs.readFileSync(h.file), h.bytes); assert.equal(h.store.runs.size, 0);
  held.release();
  try {
    const [a, b] = await Promise.all([one, two, create, cancel, suppression, settings]);
    assert.equal(a.created, false); assert.equal(b.created, false); assert.equal(fault.count(), 2);
  } finally { fs.promises.readFile = original; }
  await h.store.persistStrict(); const restored = h.reopen();
  assert.equal((await restored.get('C')).status, 'cancelled');
  assert.notEqual((await restored.get('C')).notificationSuppressed, true);
  assert.equal((await restored.get('R')).notificationSuppressed, true);
  assert.equal(hasBirth(await restored.getInternal('R')), false);
  assert(await restored.get('new')); assert.equal((await restored.getSettings()).successAutoStopMs, 9876);
  await restored.flush();
});

for (const action of ['cancel', 'cancel-without-suppression', 'suppress']) test('strict ' + action + ' failed ACK and retry retain RAM authority without rereading old disk', async t => {
  const h = fixture(t); await h.store.initialize(); await h.store.flush();
  const run = await h.store.getInternal('R'), read = fs.promises.readFile, rename = fs.promises.rename;
  let failing = true, reads = 0;
  fs.promises.readFile = async (...args) => { if (args[0] === h.file) reads++; return read(...args); };
  fs.promises.rename = async (from, to) => { if (to === h.file && failing) throw Object.assign(Error('owned write failure'), { code: 'EIO' }); return rename(from, to); };
  const mutate = () => action === 'suppress' ? h.store.markNotification('R', 'suppressed')
    : h.store.cancel('R', { suppressNotification: action !== 'cancel-without-suppression' });
  try {
    await assert.rejects(mutate(), /owned write failure/); await h.store.flush();
    assert.equal(await h.store.getInternal('R'), run);
    await h.store.updateSettings({ failureGraceMs: 7654 }); await h.store.flush();
    assert.equal(h.disk().runs[0].status, 'creating');
    failing = false; await mutate(); assert.equal(reads, 0);
    assert.equal(h.disk().settings.failureGraceMs, 7654);
    assert.equal(h.disk().runs[0].status, action === 'suppress' ? 'creating' : 'cancelled');
    assert.equal(h.disk().runs[0].notificationSuppressed === true, action !== 'cancel-without-suppression');
    await h.store.applyExternalResearchSnapshot('R', { id: 'noted_R', status: 'done', result: { text: 'late' } });
    const after = await h.store.getInternal('R');
    assert.equal(action === 'suppress' ? after.notificationSuppressed : after.status, action === 'suppress' ? true : 'cancelled');
    assert.equal(hasBirth(after), false);
  } finally { fs.promises.readFile = read; fs.promises.rename = rename; }
});

test('disappearance after EIO is unknown; genuinely initial ENOENT still admits fresh runs', async t => {
  const h = fixture(t), fault = failReads(t, h.file, 1); await h.store.initialize();
  fs.unlinkSync(h.file); await assert.rejects(h.store.create(agent('lost')), unavailable);
  assert.equal(fs.existsSync(h.file), false); assert.equal(fault.count(), 2);
  fs.writeFileSync(h.file, h.bytes); assert.equal((await h.store.reserveOrGet(row())).created, false);
  const fresh = new Store(h.file + '.new'); await fresh.reserveOrGet(row('fresh'));
  assert.equal(hasBirth(await fresh.getInternal('fresh')), true); await fresh.flush();
});

const webFile = path.join(__dirname, 'web-server.js'), tree = ts.createSourceFile(webFile, fs.readFileSync(webFile, 'utf8'), ts.ScriptTarget.Latest, true);
const functions = ['startOrchestrationStartupRecovery', 'stopOrchestrationStartupRecovery'].map(name => {
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name); assert(node, name); return node.getText(tree);
}).join('\n');
function startup(store) {
  const timers = [], calls = [], warnings = [];
  const context = vm.createContext({ orchestrationStartupRecovery: null, agentSendQueue: null, getOrchestrationRunStore: () => store,
    getAgentResponseState: true, readAgentObservedResponse: true,
    getResponseObservationService: () => ({ restore: async () => { calls.push('observations'); } }),
    reconcileActiveOrchestrations: async () => { calls.push((await store.listAll()).map(r => r.runId)); },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { timer.cancelled = true; }, console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(functions, context); return { context, timers, calls, warnings };
}
test('actual startup owner retries only unread storage then resumes original inventory without another user action', async t => {
  const h = fixture(t), fault = failReads(t, h.file), boot = startup(h.store);
  await boot.context.startOrchestrationStartupRecovery();
  assert.equal(boot.calls.length, 0); assert.equal(boot.warnings.length, 1);
  assert.equal(boot.timers[0].ms, 500); fault.recover(); boot.timers[0].fn();
  for (let i = 0; i < 100 && boot.calls.length < 2; i++) await new Promise(r => setTimeout(r, 2));
  assert.deepEqual(boot.calls, ['observations', ['R']]); assert.equal(boot.timers.length, 1);
  assert.equal(hasBirth(await h.store.getInternal('R')), false);
  boot.context.stopOrchestrationStartupRecovery();
});
for (const replacement of [false, true]) test('startup ' + (replacement ? 'replacement' : 'stop') + ' fences an old load callback', async t => {
  const h = fixture(t), held = gate(), entered = gate(), read = fs.promises.readFile;
  fs.promises.readFile = async (...args) => { if (args[0] === h.file) { entered.release(); await held.promise; } return read(...args); };
  const boot = startup(h.store), old = boot.context.startOrchestrationStartupRecovery();
  await entered.promise; boot.context.stopOrchestrationStartupRecovery();
  const next = replacement ? boot.context.startOrchestrationStartupRecovery() : null;
  held.release();
  try { await old; await next; } finally { fs.promises.readFile = read; }
  assert.equal(boot.calls.length, replacement ? 2 : 0); assert.equal(boot.timers.length, 0);
  boot.context.stopOrchestrationStartupRecovery();
});
test('startup timer backoff is bounded and stop clears retry; non-load failures do not retry effects', async t => {
  const h = fixture(t), fault = failReads(t, h.file), boot = startup(h.store);
  await boot.context.startOrchestrationStartupRecovery();
  for (let i = 0; i < 8; i++) { boot.timers.at(-1).fn(); await waitTurn(); }
  assert.deepEqual(boot.timers.map(t => t.ms), [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000]);
  assert.equal(boot.calls.length, 0); assert.deepEqual(fs.readFileSync(h.file), h.bytes);
  boot.context.stopOrchestrationStartupRecovery(); assert.equal(boot.timers.at(-1).cancelled, true);
  fault.recover(); boot.context.reconcileActiveOrchestrations = async () => { throw Error('owned non-load failure'); };
  await boot.context.startOrchestrationStartupRecovery(); assert.equal(boot.timers.length, 9);
  assert.equal(boot.context.orchestrationStartupRecovery, null);
});
test('actual web start/stop wire the same recovery owner', () => {
  const calledBy = (name, needle) => {
    const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name); assert(fn, name);
    const hits = []; function walk(n) { if (ts.isCallExpression(n) && n.expression.getText(tree) === needle) hits.push(n); ts.forEachChild(n, walk); }
    walk(fn); return hits.length;
  };
  assert.equal(calledBy('start', 'startOrchestrationStartupRecovery'), 1);
  assert.equal(calledBy('stop', 'stopOrchestrationStartupRecovery'), 1);
});
