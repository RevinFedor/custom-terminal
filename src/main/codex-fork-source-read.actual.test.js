'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const codexData = require('./ipc/codex-data');
const { SessionTranscriptService } = require('./session-transcript-service');
const { projectCodexForkSnapshotAvailability, resolveCodexReadIdentity } = require('./codex-runtime-contract');

const SID = '55555555-5555-4555-8555-555555555555';
const TAB = 'test-fork-source';
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const action = ast.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name.text === 'getCodexForkSourceRuntimeSnapshot').getText(ast);
const ipc = ast.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === 'ipcMain.handle'
  && node.expression.arguments[0]?.text === 'codex:get-runtime-session').getText(ast);

function runtime(probe, patch = {}) {
  const read = resolveCodexReadIdentity({ liveLifecycle: false, savedSessionId: SID });
  return {
    success: true, projectId: 'project-a', sessionStatus: 'inactive', liveLifecycle: false,
    savedSessionId: SID, readSessionId: read.sessionId, readIdentitySource: read.source,
    canCopySessionId: read.available, writerConfirmed: false, writerUsableForMutation: false,
    writerStatus: 'no-process', provenWriterSessionId: null, inputReady: false, busy: false,
    conversationMaterialized: probe.materialized, materializationReason: probe.reason,
    ...projectCodexForkSnapshotAvailability({ liveLifecycle: false, savedSessionId: SID,
      conversationMaterialized: probe.materialized }), ...patch,
  };
}

function harness(initial, service, inspect = codexData._api.inspectConversationMaterialization) {
  let current = initial;
  const scope = { terminal: {}, runSeq: 0, lifecycle: 'life-a', inputRevision: 0,
    projectId: 'project-a', cwd: '/test/project', launchId: null };
  const calls = [];
  const handlers = new Map();
  const context = vm.createContext({
    console: { log() {}, warn() {} },
    getCodexRuntimeSessionSnapshot: async (_tabId, options) => { calls.push(options); return current; },
    projectCodexForkSnapshotAvailability,
    terminals: { get: () => scope.terminal },
    terminalCommandState: { get: () => ({ runSeq: scope.runSeq }) },
    getTerminalLifecycleGeneration: () => scope.lifecycle,
    getTerminalInputRevision: () => scope.inputRevision,
    resolveAuthoritativeTabProjectId: () => scope.projectId,
    terminalProjects: { get: () => scope.cwd },
    codexLastRunCommandPayload: { get: () => ({ launchId: scope.launchId }) },
    transcriptService: service,
    codexDataModule: { _api: { inspectConversationMaterialization: inspect } },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  });
  vm.runInContext(action + '\n' + ipc, context);
  return { calls, scope, setRuntime: value => { current = value; },
    invoke: (_channel, request) => handlers.get('codex:get-runtime-session')(null, request),
    read: () => handlers.get('codex:get-runtime-session')(null, { tabId: TAB, purpose: 'fork-source' }),
  };
}

async function physicalSource(t, hasUser = true) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-fork-source-read-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  const created = await codexData._api.materializeEmptySession({ cwd: root, sessionId: SID,
    now: new Date('2026-09-10T08:52:00Z'), sessionsDir });
  const compact = { type: 'compacted', payload: { message: 'earlier compact',
    replacement_history: [{ type: 'compaction', encrypted_content: 'x'.repeat(600 * 1024) }] } };
  await fs.promises.appendFile(created.filePath, JSON.stringify(compact) + '\n'
    + (hasUser ? JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'saved prompt' } }) + '\n' : ''));
  const probe = await codexData._api.inspectConversationMaterializationFromFile(SID, root, { sessionsDir });
  const reads = [];
  const service = new SessionTranscriptService({ getMainWindow: () => null,
    sessionHistoryStore: { getSessionHistoryEvents: () => [] },
    codexData: { _api: { ...codexData._api,
      findCodexSessionFile: async () => ({ filePath: created.filePath }),
      loadSessionRecords: async (id, cwd, options) => {
        reads.push({ id, cwd, options });
        const stat = await fs.promises.stat(created.filePath);
        const parsed = await codexData._api.readJsonlRange(created.filePath, 0, stat.size - 1);
        return { success: parsed.errors === 0, records: parsed.records, filePath: created.filePath,
          sourceSnapshot: { size: stat.size, mtimeMs: stat.mtimeMs } };
      },
    } },
  });
  return { root, probe, reads, service };
}

test('actual renderer → IPC → logical reader resolves stopped giant-compact history without a live writer', async t => {
  const f = await physicalSource(t);
  assert.equal(f.probe.reason, 'materialization-unresolved-bounded-head');
  assert.equal(f.probe.materialized, false);
  assert.equal(f.probe.inspectedBytes, 512 * 1024);
  const h = harness(runtime(f.probe), f.service);
  h.scope.cwd = f.root;
  const ordinary = await h.invoke('codex:get-runtime-session', TAB);
  assert.equal(ordinary.canForkSnapshot, false, 'reproduces the original false rejection');
  assert.equal(f.reads.length, 0, 'ordinary status never performs a full transcript read');

  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/utils/codexWriterIdentity.ts'), 'utf8');
  const compiled = ts.transpileModule(renderer, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const presence = await import('../renderer/utils/codexPtyPresence.mjs');
  const exports = {};
  const requests = [];
  vm.runInNewContext(compiled, { exports, console,
    window: { require: () => ({ ipcRenderer: { invoke: (channel, request) => {
      requests.push(request); return h.invoke(channel, request);
    } } }) },
    require: id => id.includes('codexPtyPresence') ? presence : {
      useWorkspaceStore: { getState: () => { throw new Error('read source must never become a writer binding'); } },
    },
  });
  assert.equal(await exports.requireCodexForkSourceSessionId({ tabId: TAB, operation: 'fork' }), SID);
  assert.equal(requests[0].purpose, 'fork-source');
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].options.forceFresh, true);
  const fixed = await h.read();
  assert.equal(fixed.canForkSnapshot, true);
  assert.equal(fixed.conversationMaterialized, true);
  assert.equal(fixed.writerConfirmed, false);
  assert.equal(fixed.provenWriterSessionId, null);
  assert.equal(fixed.liveLifecycle, false);
});

test('full action read still refuses history with no real user turn after the oversized compact', async t => {
  const f = await physicalSource(t, false);
  const h = harness(runtime(f.probe), f.service);
  h.scope.cwd = f.root;
  const result = await h.read();
  assert.equal(result.canForkSnapshot, false);
  assert.equal(result.forkSnapshotReason, 'history-session-empty');
});

const unknown = () => runtime({ materialized: false, reason: 'materialization-unresolved-bounded-head' });
test('action-only source read revalidates every scope and read binding after asynchronous IO', async () => {
  for (const key of ['terminal', 'runSeq', 'lifecycle', 'inputRevision', 'projectId', 'cwd', 'launchId', 'readSessionId', 'savedSessionId', 'canCopySessionId']) {
    let h;
    h = harness(unknown(), { loadCodexOperationSource: async () => {
      if (Object.hasOwn(h.scope, key)) h.scope[key] = key === 'terminal' ? {} : 'changed';
      else h.setRuntime({ ...unknown(), [key]: key === 'canCopySessionId' ? false : 'changed' });
      return { success: true, composite: true, timelineEntries: [{ type: 'user' }] };
    } });
    const result = await h.read();
    assert.equal(result.canForkSnapshot, false, key);
    assert.equal(result.forkSnapshotReason, 'fork-source-changed-during-read', key);
    assert.equal(result.writerConfirmed, false, key);
  }
});

test('metadata-only, unresolved owner and provisional busy/startup never acquire Fork authority by a deep read', async () => {
  for (const patch of [
    { materializationReason: 'session-meta-only' },
    { materializationReason: 'session-meta-missing-or-mismatched' },
    { canCopySessionId: false }, { readSessionId: null }, { liveLifecycle: null },
    { liveLifecycle: true, inputReady: false, readIdentitySource: 'resume-source' },
    { liveLifecycle: true, busy: true, inputReady: true, readIdentitySource: 'resume-source' },
    { liveLifecycle: true, sessionStatus: 'stopping', inputReady: true, readIdentitySource: 'resume-source' },
  ]) {
    const h = harness({ ...unknown(), ...patch }, {
      loadCodexOperationSource: () => { throw new Error('must not read'); },
    });
    const result = await h.read();
    assert.equal(result.canForkSnapshot, false, JSON.stringify(patch));
    assert.equal(h.calls.length, 1);
  }
});

test('exact idle Resume source remains forkable without promotion; failed lineage never grants a snapshot', async () => {
  const initial = { ...unknown(), liveLifecycle: true, sessionStatus: 'active', inputReady: true,
    readIdentitySource: 'resume-source', writerStatus: 'provisional-source' };
  const h = harness(initial, { loadCodexOperationSource: async () => ({
    success: true, composite: true, timelineEntries: [{ type: 'user' }],
  }) });
  assert.equal((await h.read()).canForkSnapshot, true);
  assert.equal((await h.read()).writerConfirmed, false);
  const broken = harness(initial, { loadCodexOperationSource: async () => ({
    success: false, error: 'lineage_unresolved', lineageReason: 'frozen-source-changed',
  }) });
  const result = await broken.read();
  assert.equal(result.canForkSnapshot, false);
  assert.equal(result.forkSnapshotReason, 'fork-source-history-read-failed');
});
