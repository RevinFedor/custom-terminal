'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Sqlite = require('better-sqlite3');
const Database = require('./database');
const policy = require('./claude-access-failure-stop');
const { scanClaudeStartupSlashRecords } = require('./claude-startup-slash-proof');
const { compareAiLifecycleIdentity, normalizeAgentLaunchSource } = require('./ai-lifecycle-authority');
const { resolveStartupInterruptedSnapshot, SHUTDOWN_INTERRUPTED_SESSIONS_KEY } = require('./build-install-continue');
const { createClaudeSettingEvidence } = require('./claude-setting-evidence');

const ERROR = 'API error: 403 OAuth authentication is currently not allowed for this organization · model not changed';
const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const functions = ['claudeAccessFailureStateKey', 'isClaudeAccessAutoResumeBlocked',
  'observeClaudeSettingAccessOutcome', 'observeClaudeAccessOutcome',
  'admitAiLifecycleLaunch', 'markInterruptedAiSessionEntries', 'captureStartupInterruptedAgentSnapshot'];
const extracted = functions.map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}).join('\n');

function fixture(t, filename = ':memory:') {
  const db = Object.create(Database.prototype);
  db.db = new Sqlite(filename);
  db.db.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);'
    + 'CREATE TABLE IF NOT EXISTS tabs (tab_id TEXT PRIMARY KEY, was_interrupted INTEGER, overlay_dismissed INTEGER);'
    + "INSERT OR IGNORE INTO tabs VALUES ('T',1,0),('U',0,0);");
  t.after(() => { if (db.db.open) db.db.close(); });
  const terminal = {}, jobs = [], stops = [], persisted = [], logs = [];
  const runtime = { generation: 'G', input: 2, pid: 100, run: 1, session: 'S', stopFails: false };
  db.getAllProjects = () => [{ id: 'P', tabs: [{ tabId: 'T', wasInterrupted: true,
    commandType: 'claude', claudeSessionId: runtime.session }] }];
  const identity = () => ({ terminalLifecycleGeneration: runtime.generation, terminalRunSeq: runtime.run,
    inputRevision: runtime.input, processStatus: 'found', processPid: runtime.pid,
    processName: 'claude', sessionId: runtime.session });
  const ctx = vm.createContext({ ...policy, compareAiLifecycleIdentity, normalizeAgentLaunchSource,
    resolveStartupInterruptedSnapshot, SHUTDOWN_INTERRUPTED_SESSIONS_KEY,
    projectManager: { db }, terminals: new Map([['T', terminal]]),
    claudeLaunchGenerationByTab: new Map([['T', { generation: 'L', sessionIdHint: 'S' }]]),
    bridgeKnownSessions: new Map([['T', 'S']]), aiStoppingTabs: new Map(),
    terminalCommandState: new Map([['T', { runSeq: 1, isRunning: true }]]),
    getTerminalLifecycleGeneration: () => runtime.generation,
    getTerminalInputRevision: () => runtime.input,
    findClaudePidByTab: () => runtime.pid,
    currentAiLifecycleIdentity: identity,
    setImmediate: fn => jobs.push(fn),
    console: { log: (...v) => logs.push(v), warn: (...v) => logs.push(v), error: (...v) => logs.push(v) },
    srcMainDir: __dirname, path,
    require: () => ({ admitAgentLifecycleLaunch: async (_tabId, { launchSource }) => (
      { allowed: true, source: launchSource }
    ) }),
    persistShutdownInterruptedAgentSnapshot: (entries, reason) => persisted.push({ entries: [...entries], reason }),
    startupInterruptedAgentSnapshot: {},
    stopAiProcessInTabSerialized: async (tabId, options) => {
      const guard = options.preSignalGuard(identity());
      stops.push({ tabId, options, allowed: guard.allowed });
      return { success: guard.allowed && !runtime.stopFails, error: runtime.stopFails ? 'process_lookup_unknown' : null };
    },
  });
  vm.runInContext(extracted, ctx);
  return { db, ctx, runtime, jobs, stops, persisted, logs,
    state: () => db.getAppState('claude-access-failure:T'),
    async drain() { while (jobs.length) jobs.shift()(); await new Promise(setImmediate); },
  };
}

function setting(uuid, message = ERROR) {
  const proof = scanClaudeStartupSlashRecords([
    { type: 'user', uuid: uuid + '-wrapper', sessionId: 'S', message: {
      role: 'user', content: '<command-name>/model</command-name><command-args>opus</command-args>' } },
    { type: 'system', subtype: 'local_command', uuid, parentUuid: uuid + '-wrapper', sessionId: 'S',
      content: '<local-command-stdout>' + message + '</local-command-stdout>' },
  ], '/model opus', { sessionId: 'S' });
  proof.evidence = { owner: { launchId: 'L', lifecycleGeneration: 'G', runSeq: 1, processId: 100 },
    checkpoint: { wrapperUuid: uuid + '-wrapper', lineageVerified: true },
    binding: { sessionId: 'S' }, write: { enterWritten: true, enterInputRevision: 2 } };
  return proof;
}

test('actual parser → main: two distinct exact 403s persist a stop, rereading one does not', async t => {
  const h = fixture(t);
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('a'));
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('a'));
  assert.equal(h.state().count, 1);
  assert.equal(h.jobs.length, 0);
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('b'));
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('b'));
  assert.equal(h.state().blocked, true);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.db.db.prepare('SELECT was_interrupted FROM tabs WHERE tab_id=?').get('T').was_interrupted, 0);
  await h.drain();
  assert.equal(h.stops.length, 1);
  assert.equal(h.stops[0].allowed, true);
  assert.equal(h.stops[0].options.reason, 'claude-repeated-access-denied');
});

test('real SQLite close/reopen preserves first failure and blocks only automatic launch after second', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-access-stop-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'state.sqlite');
  const a = fixture(t, filename);
  a.ctx.observeClaudeSettingAccessOutcome('T', setting('a'));
  a.db.db.close();
  const b = fixture(t, filename);
  b.ctx.observeClaudeSettingAccessOutcome('T', setting('b'));
  await b.drain();
  b.db.db.close();
  const c = fixture(t, filename);
  const auto = await c.ctx.admitAiLifecycleLaunch('T', { command: 'claude-c', sessionId: 'S', launchSource: 'auto-resume' });
  assert.equal(auto.allowed, false);
  assert.equal(auto.suppressed, true);
  assert.equal((await c.ctx.admitAiLifecycleLaunch('T', { command: 'claude-c', sessionId: 'S' })).allowed, true);
  assert.equal((await c.ctx.admitAiLifecycleLaunch('T', { command: 'claude-c', sessionId: 'child', launchSource: 'auto-resume' })).allowed, true);
  assert.equal((await c.ctx.admitAiLifecycleLaunch('T', { command: 'codex', sessionId: 'S', launchSource: 'auto-resume' })).allowed, true);
});

for (const [label, edit] of Object.entries({
  session: proof => { proof.sessionId = 'other'; },
  lineage: proof => { proof.evidence.checkpoint.lineageVerified = false; },
  wrapper: proof => { proof.wrapperUuid = 'other'; },
  unsubmitted: proof => { proof.evidence.write.enterWritten = false; },
  generation: proof => { proof.evidence.owner.launchId = 'old'; },
  lifecycle: proof => { proof.evidence.owner.lifecycleGeneration = 'old'; },
  run: proof => { proof.evidence.owner.runSeq = 0; },
  pid: proof => { proof.evidence.owner.processId = 99; },
  input: proof => { proof.evidence.write.enterInputRevision = 1; },
  unknown: proof => { proof.terminal = false; },
})) test('actual main ignores unowned or non-final proof: ' + label, t => {
  const h = fixture(t), proof = setting('bad'); edit(proof);
  h.ctx.observeClaudeSettingAccessOutcome('T', proof);
  assert.equal(h.state(), null);
});

for (const [label, edit] of Object.entries({
  terminal: h => h.ctx.terminals.set('T', {}),
  launch: h => h.ctx.claudeLaunchGenerationByTab.set('T', { generation: 'new' }),
  input: h => h.runtime.input++,
  lifecycle: h => { h.runtime.generation = 'new'; },
  pid: h => h.runtime.pid++,
  session: h => { h.runtime.session = 'new'; },
  run: h => h.runtime.run++,
  success: h => h.ctx.observeClaudeSettingAccessOutcome('T', setting('success', 'Set model to opus')),
})) test('actual shared Stop guard rejects a changed owner before any signal: ' + label, async t => {
  const h = fixture(t);
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('a'));
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('b'));
  edit(h); await h.drain();
  assert.equal(h.stops[0].allowed, false);
});

test('different error and successful settings reset the consecutive streak; late duplicate cannot revive it', t => {
  const h = fixture(t);
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('a'));
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('rate', 'API error: 429 rate limited'));
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('b'));
  assert.equal(h.state().count, 1);
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('other', 'API error: 403 other denial'));
  assert.equal(h.state().count, 1);
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('good', 'Set model to opus'));
  assert.equal(h.state().count, 0);
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('a'));
  assert.equal(h.state().count, 0);
  assert.equal(h.jobs.length, 0);
});

test('a new session does not inherit a denial and a confirmed success releases auto-resume', async t => {
  const h = fixture(t);
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('a'));
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('b'));
  assert.equal(h.ctx.isClaudeAccessAutoResumeBlocked('T', 'other'), false);
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('good', 'Set model to opus'));
  assert.equal((await h.ctx.admitAiLifecycleLaunch('T', { command: 'claude-c', sessionId: 'S', launchSource: 'auto-resume' })).allowed, true);
});

test('unknown process stop keeps durable restore suppression; shutdown and cold snapshot cannot resurrect it', async t => {
  const h = fixture(t); h.runtime.stopFails = true;
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('a'));
  h.ctx.observeClaudeSettingAccessOutcome('T', setting('b'));
  await h.drain();
  assert.equal(h.state().blocked, true);
  const marked = h.ctx.markInterruptedAiSessionEntries(new Map([
    ['T', { engine: 'claude', sessionId: 'S' }], ['U', { engine: 'codex', sessionId: 'C' }],
  ]), 'test-shutdown');
  assert.equal(marked, 1);
  assert.equal(h.persisted[0].entries[0][0], 'U');
  h.db.setAppState(SHUTDOWN_INTERRUPTED_SESSIONS_KEY, { version: 1, targets: [{ tabId: 'T', provider: 'claude', sessionId: 'S' }] });
  assert.equal(h.ctx.captureStartupInterruptedAgentSnapshot().targets.length, 0);
});

test('actual setting evidence owner admits the production-shaped stdout and the main observer receives it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-access-proof-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'S.jsonl'); fs.writeFileSync(file, '');
  const h = fixture(t), owner = { terminal: h.ctx.terminals.get('T'), terminalInstanceId: 'I',
    lifecycleGeneration: 'G', runSeq: 1, launchId: 'L', processId: 100, inputRevision: 2, freshLaunch: true };
  const evidence = createClaudeSettingEvidence({ captureOwner: () => owner,
    isOwnerCurrent: () => true, resolveBinding: () => ({ sessionId: 'S', filePath: file, verified: true }) });
  for (const id of ['one', 'two']) {
    const token = evidence.admit({ tabId: 'T', command: '/model opus', operationId: id });
    assert.equal(evidence.prepareWrite(token, 'paste').allowed, true); evidence.markWritten(token, 'paste');
    assert.equal(evidence.prepareWrite(token, 'enter').allowed, true); evidence.markWritten(token, 'enter');
    fs.appendFileSync(file, [
      { type: 'user', uuid: id + '-wrapper', sessionId: 'S', message: { role: 'user', content: '<command-name>/model</command-name><command-args>opus</command-args>' } },
      { type: 'system', subtype: 'local_command', uuid: id, parentUuid: id + '-wrapper', sessionId: 'S', content: '<local-command-stdout>' + ERROR + '</local-command-stdout>' },
    ].map(x => JSON.stringify(x) + '\n').join(''));
    const proof = await evidence.read({ tabId: 'T', command: '/model opus', commandId: token.commandId });
    assert.equal(proof.terminal, true);
    h.ctx.observeClaudeSettingAccessOutcome('T', proof);
  }
  await h.drain(); assert.equal(h.stops[0].allowed, true);
});
