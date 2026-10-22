'use strict';
// Source/private only. Node's SQLite replaces the incompatible better-sqlite3
// binary; this fixture is not native ABI/Electron/provider acceptance.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module');
class NodeSqlite {
  constructor(file = ':memory:') { this.raw = new DatabaseSync(file); this.depth = 0; this.name = file; this.open = true; }
  get inTransaction() { return this.depth > 0; }
  exec(sql) { return this.raw.exec(sql); }
  prepare(sql) {
    const q = this.raw.prepare(sql);
    const names = new Set([...sql.matchAll(/[@:$]([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]));
    const bind = args => args.length === 1 && args[0] && typeof args[0] === 'object' && !Buffer.isBuffer(args[0])
      ? [Object.fromEntries(Object.entries(args[0]).filter(([key]) => names.has(key.replace(/^[@:$]/, ''))))] : args;
    const plain = row => row == null ? undefined : { ...row };
    return { get: (...args) => plain(q.get(...bind(args))), all: (...args) => q.all(...bind(args)).map(plain),
      run: (...args) => q.run(...bind(args)), iterate: function* (...args) { for (const row of q.iterate(...bind(args))) yield plain(row); } };
  }
  pragma(text, options = {}) { const rows = this.raw.prepare('PRAGMA ' + text).all(); return options.simple ? Object.values(rows[0] || {})[0] : rows; }
  function(name, options, fn) { return this.raw.function(name, typeof options === 'function' ? options : fn); }
  transaction(fn) {
    const mode = type => (...args) => {
      const nested = this.depth > 0, key = 'install_' + this.depth;
      this.exec(nested ? 'SAVEPOINT ' + key : 'BEGIN ' + type); this.depth++;
      try { const value = fn(...args); if (value?.then) throw Error('async private transaction');
        this.exec(nested ? 'RELEASE ' + key : 'COMMIT'); return value; }
      catch (error) { this.exec(nested ? 'ROLLBACK TO ' + key : 'ROLLBACK'); if (nested) this.exec('RELEASE ' + key); throw error; }
      finally { this.depth--; }
    };
    const run = mode('DEFERRED'); run.immediate = mode('IMMEDIATE'); run.deferred = run; run.exclusive = mode('EXCLUSIVE'); return run;
  }
  close() { this.raw.close(); this.open = false; }
}
function codexApi() {
  const original = Module._load;
  try {
    Module._load = function(name, parent, main) {
      if (name === 'electron') return { ipcMain: { handle() {}, on() {} } };
      return original.call(this, name, parent, main);
    };
    return require('../ipc/codex-data')._api;
  } finally { Module._load = original; }
}
function mainResultReader(file, requests = []) {
  const api = codexApi();
  const { createCodexResultReader } = require('../codex-result-reader');
  const { createCodexResultSourceResolver } = require('../codex-result-source');
  const reader = createCodexResultReader({ readJsonlRange: api.readJsonlRange,
    createTimelineProjector: api.createCodexTimelineProjector, buildResult: api.buildCodexProviderTurnAssistantResult,
    extractText: api.extractTextContent, userIdentity: api.getCodexUserRecordIdentity,
    isCompactPayload: api.isCompactPayload, extractReasoning: api.extractReasoning,
    findExecutionContext: api.findCodexPromptExecutionContext, collectLegacy: api.collectCodexTurnAssistantBlocks, log: { log() {} } });
  const resolver = createCodexResultSourceResolver({ codexApi: { findCodexSessionFile: async () => ({ filePath: file }) } });
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const begin = main.indexOf('async function _getAgentTurnResultForOrchestration(');
  const end = main.indexOf('\nfunction sessionCatalogProjectMatches', begin);
  if (begin < 0 || end < 0) throw Error('actual Main reader missing');
  const read = vm.runInNewContext('(' + main.slice(begin, end) + ')', {
    _loadSessionTurns() { throw Error('generic history forbidden'); },
    codexDataModule: { _api: { loadCodexProviderResult: request => reader.load(request),
      loadSessionRecords() { throw Error('whole History/raw reader forbidden'); } } },
    transcriptService: { resolveCodexResultSource: args => resolver.resolve({ ...args, lineage: { kind: 'physical' } }) },
    console: { log() {}, warn() {} }, Date, // same test clock as the producer/receipt/queue store
  });
  return request => { requests.push(request); return read(request); };
}
if (process.env.INSTALL_POSTHOOK_SQLITE_ADAPTER === '1') {
  const original = Module._load;
  Module._load = function(name, parent, main) { return name === 'better-sqlite3' ? NodeSqlite : original.call(this, name, parent, main); };
}
module.exports = { NodeSqlite, mainResultReader, codexApi };

async function installContextFixture(t, options = {}) {
  const os = require('node:os');
  const { TabWorkContext } = require('../tab-work-context');
  const { createAgentSendReceiptStore } = require('../agent-send-receipt-store');
  const { AgentSendQueue } = require('../agent-send-queue');
  const { createBuildInstallContinuations } = require('../build-install-continuation');
  const { promptAuditFingerprint } = require('../prompt-audit-fingerprint');
  const { fingerprintAgentSendRequest } = require('../agent-send-receipt-registry');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-posthook-'));
  const db = new NodeSqlite(path.join(root, 'proof.sqlite'));
  db.exec('CREATE TABLE state(value TEXT NOT NULL)');
  const source = { tabId: '753', projectId: 'P', toolType: 'codex', sessionId: 'S', cwd: root,
    expectedTarget: { toolType: 'codex', sessionId: 'S' } };
  const logical = options.logical || 'Continue the original install iteration.\r\n';
  const handoff = 'build-install-return:J', operationKey = 'project:753:' + handoff;
  const context = new TabWorkContext({ db, listTabs: () => [{ tabId: '753', projectId: 'P', commandType: 'codex', codexSessionId: 'S', cwd: root }], archivedTab: () => null, onChanged() {} });
  const updates = options.updates || [{ id: 'context-one', title: 'Working state', text: 'A saved update from another owner.' }];
  for (const [i, update] of updates.entries()) db.prepare(`INSERT INTO tab_context_updates(id,tab_id,title,text,kind,created_at)
    VALUES (?,'753',?,?,'manual',?)`).run(update.id, update.title, update.text, i + 1);
  const store = createAgentSendReceiptStore(db), inputs = [], reads = [], changes = [];
  const queue = new AgentSendQueue({ store, ready: () => false, execute: async request => { inputs.push(request); } });
  const file = path.join(root, 'provider.jsonl');
  const realRead = mainResultReader(file, reads);
  const state = { owner: 'S', coherent: true, transform: value => value, onResult: null,
    readPrepared: (tabId, handoffId) => context.readPreparedHandoff(tabId, handoffId) };
  const make = () => createBuildInstallContinuations({
    read: () => { const row = db.prepare('SELECT value FROM state').get(); return row ? JSON.parse(row.value) : null; },
    write: value => db.transaction(() => { db.prepare('DELETE FROM state').run(); db.prepare('INSERT INTO state VALUES (?)').run(JSON.stringify(value)); })(),
    receipts: () => ({ list: query => store.list(query).map(state.transform), get: key => state.transform(store.get(key)) }),
    readQueuedRequest: key => queue.item(key), readPreparedHandoff: (tabId, handoffId) => state.readPrepared(tabId, handoffId),
    readSource: async () => ({ coherent: state.coherent, sessionId: state.owner, toolType: 'codex', processStatus: 'found' }),
    readResult: async request => { const result = await realRead(request); await state.onResult?.(request, result); return result; },
    changed: entry => changes.push(entry),
  });
  let service = make(); service.reserve({ requestId: 'I', jobId: 'J', source });
  service.armCallback({ requestId: 'I', jobId: 'J', prompt: logical });
  const transport = (await context.prepare('753', handoff, options.preparedLogical || logical)).prompt;
  const request = { tabId: '753', provider: 'codex', source: 'build-install-return', handoffId: handoff,
    prompt: transport, expectedTarget: source.expectedTarget };
  const identity = { operationKey, surface: 'project-api', tabId: '753', provider: 'codex', sessionId: 'S', handoffId: handoff,
    requestFingerprint: fingerprintAgentSendRequest(request), promptHash: promptAuditFingerprint(transport), promptLength: transport.length };
  assertFixture(queue.enqueue({ identity, request }).ok, 'private immutable queue admission');
  const attempt = store.beginAttempt(identity);
  store.settleAttempt(operationKey, attempt.attemptId, { success: null, submitted: true, deliveryUnknown: true,
    status: 'delivery-unknown', transportText: transport });
  // One explicit fixture timeline. Callers that compare a queue arm/floor
  // provide auditAt from their controlled clock; other tests use their clock.
  const auditAt = options.auditAt ?? Date.now();
  assertFixture(Number.isFinite(auditAt), 'finite private auditAt required');
  const completedAt = auditAt + 1000;
  const rows = [{ type: 'event_msg', timestamp: new Date(auditAt - 1000).toISOString(), payload: { type: 'task_started', turn_id: 'callback-T' } },
    { type: 'event_msg', timestamp: new Date(auditAt).toISOString(), payload: { type: 'user_message', message: transport } }];
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
  const auditIdentity = codexApi().getCodexUserRecordIdentity({ ...rows[1], __line: 1,
    __byteOffset: Buffer.byteLength(JSON.stringify(rows[0]) + '\n') }, 'S');
  assertFixture(store.promoteFromAudit({ success: true, operationKey, attemptId: attempt.attemptId, provider: 'codex', sessionId: 'S',
    promptHash: identity.promptHash, actualHash: identity.promptHash, entryUuid: auditIdentity.userUuid,
    sourceIdentity: auditIdentity.sourceIdentity, auditTimestamp: rows[1].timestamp, transcriptBoundary: { byteOffset: 1 } }).promoted,
  'private exact native audit promotion');
  t.after(async () => { queue.dispose(); await new Promise(resolve => setImmediate(resolve));
    for (const watcher of context.watchers.values()) watcher.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, root, source, logical, transport, context, queue, store, state, changes, inputs, reads, resultReader: realRead, operationKey, attempt, auditAt, completedAt,
    read: () => service.snapshot(), blocked: () => service.blocked('753'), reconcile: () => service.reconcile('753'),
    reconcileAll: () => service.reconcile(),
    restore: () => { service = make(); },
    complete: () => fs.appendFileSync(file, [
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'completed callback work' }] } },
      { type: 'event_msg', timestamp: new Date(completedAt).toISOString(), payload: { type: 'task_complete', turn_id: 'callback-T', last_agent_message: 'completed callback work' } },
    ].map(row => JSON.stringify(row) + '\n').join('')),
    legacy: () => { const saved = service.snapshot(); delete saved.entries[0].callbackIntent;
      db.prepare('UPDATE state SET value=?').run(JSON.stringify(saved)); service = make(); },
  };
}
function assertFixture(value, message) { if (!value) throw Error(message); }
module.exports.installContextFixture = installContextFixture;
