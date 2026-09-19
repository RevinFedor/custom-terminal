'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const http = require('node:http');
const url = require('node:url');
const os = require('node:os');
const { ConversationOwners } = require('./conversation-owner');
const { SavedHistoryOperations } = require('./saved-history-operation');
const clone = value => JSON.parse(JSON.stringify(value));
const quiet = { log() {}, warn() {}, error() {} };
function functions(file, names) {
  const tree = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, file), 'utf8'), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name); return node.getText(tree);
  }).join('\n');
}
const captureCode = functions('main.js', ['captureArchivedConversationOwner', 'captureConversationOwner']);
const webCode = functions('web-server.js', ['checkAuth', 'handleApi', 'normalizePublicRuntimeStatus',
  'stampPublicRuntimeSnapshot', 'finishConversationOwnerRead']);

function fixture(provider = 'codex', cleared = false) {
  const rows = new Map(), events = [];
  const state = { row: { project_id: 'P', command_type: provider, cwd: '/fixture',
    [provider + '_session_id']: cleared ? null : 'child' }, archives: [], project: { id: 'P', path: '/fixture' },
    launchId: 'own-L', runSeq: 2, liveOwners: [], openRows: [] };
  const term = {};
  const db = { getAppState: key => rows.has(key) ? clone(rows.get(key)) : null,
    setAppState: (key, value) => rows.set(key, clone(value)),
    getTabHistoryEntriesByTabId: (tabId, limit) => { assert.equal(tabId, 'T'); assert.equal(limit, 2); return state.archives; },
    getProjectById: projectId => projectId === 'P' ? state.project : null,
    db: { prepare: () => ({ get: () => state.row, all: () => state.row ? [state.row] : state.openRows }), transaction: fn => fn } };
  const ctx = vm.createContext({ path, srcMainDir: __dirname, require, console: quiet,
    projectManager: { db }, terminals: new Map([['T', term]]), sdkSessions: new Map(),
    terminalProjects: new Map(), terminalCommandState: new Map([['T', { runSeq: 2 }]]),
    resolveAuthoritativeTabProjectId: () => state.row ? 'P' : null,
    getLiveAiRuntimeOwners: () => state.liveOwners,
    resolveAiToolOwner: require('./ai-tool-owner').resolveAiToolOwner,
    readAgentSendDestinationAtWriteBoundary: () => ({ terminalInstanceId: 'pty', launchId: state.launchId }),
  });
  const owner = new ConversationOwners({ db, capture: tabId => ctx.captureConversationOwner(tabId),
    instanceId: 'main-1', publish: (_tab, proof) => events.push(proof) });
  ctx.conversationOwners = owner;
  vm.runInContext(captureCode, ctx);
  const operation = { tabId: 'T', operationId: 'O', toolType: provider, revision: 12, state: 'completed', pending: false,
    success: true, historyMutated: true, bindingCommitted: true, activeSessionId: cleared ? null : 'child', fileDeleted: cleared,
    ...(cleared ? { binding: { applied: true, mode: 'cleared', sessionId: null } } : {}) };
  operation.ownerCheckpoint = owner.checkpoint('T', operation, owner.observation('T'));
  const registry = new SavedHistoryOperations({ db, runtime: { owner } });
  db.setAppState(registry.key('T', 'O'), operation);
  const archive = () => {
    state.archives = [{ ...state.row, id: 31, tab_id: 'T', tab_type: 'terminal' }];
    state.row = null; ctx.terminals.delete('T'); state.launchId = null;
  };
  return { rows, state, ctx, owner, registry, operation, events, archive, db, term };
}

for (const provider of ['codex', 'claude']) {
  test(provider + ': completed O -> process Stop -> exact archive cleanup retains logical ownership, not writer/readiness', () => {
    const h = fixture(provider), bytes = JSON.stringify(h.registry.read('T', 'O'));
    const before = h.owner.current('T');
    h.state.launchId = null; h.ctx.terminalCommandState.set('T', { runSeq: 2, isRunning: false });
    assert.equal(h.registry.applicability('T', 'O', 12).applicability.verdict, 'applicable');
    h.archive();
    const after = h.registry.applicability('T', 'O', 12).applicability;
    assert.equal(after.verdict, 'applicable'); assert.equal(after.currentBinding.sessionId, 'child');
    assert.equal(after.ownerToken, before.ownerToken); assert.deepEqual(after.ownerOrder, before.ownerOrder);
    const ctx = vm.createContext({ console: quiet, token: 'fixture', conversationOwners: h.owner,
      publicRuntimeSnapshots: new Map(), fingerprintAgentSendRequest: require('./agent-send-receipt-registry').fingerprintAgentSendRequest });
    vm.runInContext(webCode, ctx);
    const status = ctx.stampPublicRuntimeSnapshot('T', { status: 'unknown', processStatus: 'absent', inputReady: false,
      sessionId: null, readSessionId: null, writerSessionId: null, writerConfirmed: false });
    assert.equal(status.conversationOwner.currentBinding.sessionId, 'child');
    assert.equal(status.inputReady, false); assert.equal(status.writerConfirmed, false); assert.equal(status.writerSessionId, null);
    assert.equal(JSON.stringify(h.registry.read('T', 'O')), bytes);
    h.owner.noteInput('T'); assert.equal(h.registry.applicability('T', 'O').applicability.verdict, 'superseded');
  });
}

test('installed v1 token-only O with observation-unknown recovers through exact archive GET only; owner order advances', () => {
  const h = fixture(); delete h.operation.ownerCheckpoint.epoch;
  h.db.setAppState(h.registry.key('T', 'O'), h.operation);
  h.archive();
  const record = h.owner.stored('T');
  h.owner.write('T', { ...record, observationKnown: false, reason: 'observation-unknown' });
  const before = h.owner.public(h.owner.stored('T')), bytes = JSON.stringify(h.registry.read('T', 'O'));
  const result = h.registry.applicability('T', 'O', 12).applicability;
  assert.equal(result.verdict, 'applicable'); assert.equal(result.currentBinding.sessionId, 'child');
  assert.equal(result.ownerToken, before.ownerToken); assert.equal(result.ownerOrder.epoch, before.ownerOrder.epoch);
  assert.ok(result.ownerOrder.revision > before.ownerOrder.revision);
  const reopened = new ConversationOwners({ db: h.db, capture: () => h.ctx.captureConversationOwner('T'), instanceId: 'main-2' });
  assert.equal(reopened.applicability('T', h.operation, 12).applicability.verdict, 'applicable');
  assert.equal(JSON.stringify(h.registry.read('T', 'O')), bytes, 'no mutation, checkpoint backfill or receipt rewrite');
});

for (const edge of ['duplicate', 'missing', 'missing-project', 'missing-column', 'open-ambiguous', 'live-terminal', 'live-owner', 'sdk']) {
  test('archive capture at ' + edge + ' cannot manufacture current logical proof', () => {
    const h = fixture(); h.archive();
    if (edge === 'duplicate') h.state.archives.push({ ...h.state.archives[0], id: 32 });
    if (edge === 'missing') h.state.archives = [];
    if (edge === 'missing-project') h.state.project = null;
    if (edge === 'missing-column') delete h.state.archives[0].codex_session_id;
    if (edge === 'open-ambiguous') h.state.openRows = [{ project_id: 'Q' }, { project_id: 'R' }];
    if (edge === 'live-terminal') h.ctx.terminals.set('T', {});
    if (edge === 'live-owner') h.state.liveOwners = ['codex'];
    if (edge === 'sdk') h.ctx.sdkSessions.set('T', {});
    assert.equal(h.registry.applicability('T', 'O').applicability.verdict, 'unknown');
  });
}

for (const field of ['session', 'provider', 'cwd', 'project']) {
  test('foreign archived ' + field + ' supersedes, never borrows the completed binding', () => {
    const h = fixture(); h.archive(); const archive = h.state.archives[0];
    if (field === 'session') archive.codex_session_id = 'B';
    if (field === 'provider') { archive.command_type = 'claude'; archive.claude_session_id = 'child'; }
    if (field === 'cwd') archive.cwd = '/other';
    if (field === 'project') { archive.project_id = 'Q'; h.db.getProjectById = () => ({ id: 'Q', path: '/fixture' }); }
    assert.equal(h.registry.applicability('T', 'O').applicability.verdict, 'superseded');
  });
}

test('clear stays none after cleanup, but null without a checkpoint and legacy O never grant applicability', () => {
  const h = fixture('claude', true); h.archive();
  assert.equal(h.registry.applicability('T', 'O').applicability.currentBinding.state, 'none');
  const bytes = JSON.stringify(h.operation);
  assert.equal(h.owner.applicability('T', { ...h.operation, ownerCheckpoint: null }).applicability.verdict, 'unknown');
  const record = h.owner.stored('T');
  h.rows.clear();
  assert.equal(h.registry.read('T', 'O'), null);
  assert.equal(h.owner.applicability('T', h.operation).applicability.verdict, 'unknown');
  assert.equal(h.owner.current('T').currentBinding.state, 'unknown');
  h.db.setAppState('conversation-owner.v1:T', record);
  assert.equal(JSON.stringify(h.operation), bytes);
});

test('own Resume/order advance after Stop carries O once, stale snapshot/epoch/revision do not grant permission', () => {
  const h = fixture(), old = h.owner.current('T');
  h.state.launchId = null;
  h.owner.prepareResume('T', 'O', h.operation.ownerCheckpoint);
  h.state.launchId = 'own-next-L'; h.ctx.terminalCommandState.set('T', { runSeq: 3 });
  h.owner.carryResume('T', 'O', h.operation.ownerCheckpoint, h.owner.observation('T'));
  const current = h.owner.current('T');
  assert.equal(current.ownerToken, old.ownerToken); assert.ok(current.ownerOrder.revision > old.ownerOrder.revision);
  assert.equal(h.registry.applicability('T', 'O').applicability.verdict, 'applicable');
  assert.throws(() => h.registry.applicability('T', 'O', 11), /revision_changed/);
  assert.equal(h.owner.applicability('T', { ...h.operation, ownerCheckpoint: { ...h.operation.ownerCheckpoint, epoch: 'foreign' } }).applicability.verdict, 'unknown');
  assert.throws(() => h.owner.prepareResume('T', 'O', { ...h.operation.ownerCheckpoint, epoch: 'foreign' }), /superseded/);
  assert.throws(() => h.owner.carryResume('T', 'O', { token: 'wrong' }, h.owner.observation('T')), /superseded/);
  const ctx = vm.createContext({ conversationOwners: h.owner, console: quiet }); vm.runInContext(webCode, ctx);
  assert.equal(ctx.finishConversationOwnerRead('T', old).ownerSnapshotCurrent, false);
  h.owner.noteInput('T'); assert.equal(h.registry.applicability('T', 'O').applicability.verdict, 'superseded');
});

test('actual authenticated HTTP same-ID applicability reads exact archive; no terminal/history action is dispatched', async t => {
  const h = fixture(); h.archive(); let writes = 0;
  const sendJson = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const ctx = vm.createContext({ console: quiet, url, require: () => ({}), token: 'fixture', savedHistoryOperations: h.registry,
    conversationOwners: h.owner,
    decId: decodeURIComponent, sendJson, bridgeRequest: () => { writes++; throw Error('unexpected action'); } });
  vm.runInContext(webCode, ctx);
  const server = http.createServer((req, res) => ctx.handleApi(req, res, url.parse(req.url, true), new Map())
    .catch(e => sendJson(res, 500, { error: e.message })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = (revision, auth = true) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port,
      path: '/api/terminal-tabs/T/history-operations/O/applicability?operationRevision=' + revision,
      headers: auth ? { authorization: 'Bearer fixture' } : {} }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    }).on('error', reject);
  });
  assert.equal((await get(12, false)).status, 401);
  const stale = await get(11); assert.equal(stale.status, 409, JSON.stringify(stale));
  assert.equal((await get(12)).data.applicability.verdict, 'applicable');
  h.owner.noteInput('T'); assert.equal((await get(12)).data.applicability.verdict, 'superseded');
  assert.equal(writes, 0);
});

test('real SQLite archive + owner reopen preserve a completed checkpoint without live tab/writer or receipt backfill', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-logical-owner-'));
  const Sqlite = require('better-sqlite3'); let sql;
  try { sql = new Sqlite(path.join(root, 'fixture.sqlite')); }
  catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    if (error.code === 'ERR_DLOPEN_FAILED') { t.skip('Electron ABI'); return; } throw error;
  }
  t.after(() => { sql.close(); fs.rmSync(root, { recursive: true, force: true }); });
  sql.exec(`CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
    CREATE TABLE tabs(project_id TEXT,tab_id TEXT,command_type TEXT,cwd TEXT,claude_session_id TEXT,codex_session_id TEXT);
    CREATE TABLE tab_history(id INTEGER PRIMARY KEY,project_id TEXT,tab_id TEXT,command_type TEXT,cwd TEXT,
      claude_session_id TEXT,codex_session_id TEXT,tab_type TEXT,closed_at INTEGER);
    INSERT INTO tabs VALUES('P','T','codex','/fixture',NULL,'child');`);
  const db = Object.create(require('./database').prototype); db.db = sql;
  db.getProjectById = id => id === 'P' ? { id: 'P', path: '/fixture' } : null;
  const ctx = vm.createContext({ path, srcMainDir: __dirname, require, console: quiet, projectManager: { db },
    resolveAuthoritativeTabProjectId: tabId => sql.prepare('SELECT project_id FROM tabs WHERE tab_id=?').get(tabId)?.project_id || null,
    terminals: new Map([['T', {}]]), sdkSessions: new Map(), terminalProjects: new Map(), terminalCommandState: new Map(),
    getLiveAiRuntimeOwners: () => [], resolveAiToolOwner: require('./ai-tool-owner').resolveAiToolOwner,
    readAgentSendDestinationAtWriteBoundary: () => ({ terminalInstanceId: 'pty', launchId: null }),
  });
  vm.runInContext(captureCode, ctx);
  let owner = new ConversationOwners({ db, capture: id => ctx.captureConversationOwner(id), instanceId: 'main-1' });
  ctx.conversationOwners = owner;
  const op = { tabId: 'T', operationId: 'O', toolType: 'codex', revision: 12, state: 'completed', success: true,
    historyMutated: true, bindingCommitted: true, activeSessionId: 'child' };
  const registry = new SavedHistoryOperations({ db, runtime: { owner } });
  db.db.transaction(() => { op.ownerCheckpoint = owner.checkpoint('T', op, owner.observation('T')); db.setAppState(registry.key('T', 'O'), op); })();
  const before = JSON.stringify(registry.read('T', 'O'));
  sql.exec("INSERT INTO tab_history SELECT 1,project_id,tab_id,command_type,cwd,claude_session_id,codex_session_id,'terminal',100 FROM tabs; DELETE FROM tabs;");
  ctx.terminals.clear();
  owner.write('T', { ...owner.stored('T'), observationKnown: false, reason: 'observation-unknown' });
  sql.close(); sql = new Sqlite(path.join(root, 'fixture.sqlite')); db.db = sql;
  owner = new ConversationOwners({ db, capture: id => ctx.captureConversationOwner(id), instanceId: 'main-2' });
  ctx.conversationOwners = owner; registry.runtime.owner = owner;
  const after = registry.applicability('T', 'O', 12).applicability;
  assert.equal(after.verdict, 'applicable'); assert.equal(after.currentBinding.sessionId, 'child');
  assert.equal(JSON.stringify(registry.read('T', 'O')), before);
  owner.noteInput('T');
  sql.close(); sql = new Sqlite(path.join(root, 'fixture.sqlite')); db.db = sql;
  assert.equal(registry.applicability('T', 'O').applicability.verdict, 'superseded');
  assert.equal(JSON.stringify(registry.read('T', 'O')), before);
});
