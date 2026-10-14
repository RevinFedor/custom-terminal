'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const codexData = require('./ipc/codex-data');
const { SessionTranscriptService } = require('./session-transcript-service');
const { buildCodexForkLineageManifest } = require('./session-history-events');
const { hashFileSegment } = require('./codex-virtual-transcript');
const SOURCE = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const meta = extra => ({ type: 'session_meta', payload: { id: CHILD, cwd: '/fixture', ...extra } });
const quiet = { warn() {}, log() {}, error() {} };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/components/Workspace/Terminal.tsx'), 'utf8');
const ast = ts.createSourceFile('Terminal.tsx', renderer, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const finalize = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'finalizeAiLaunchSnapshot').getText(ast);
const compiled = ts.transpileModule(finalize, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function finalizer(invoke) {
  let snapshot = { sessionType: 'codex', autoTitleMode: 'fork' };
  const tab = { cwd: '/fixture', codexSessionId: CHILD }, calls = [];
  const store = { openProjects: new Map([['P', { tabs: new Map([['T', tab]]) }]]),
    getAiLaunchSnapshot: () => snapshot,
    clearAiLaunchSnapshot: (...args) => calls.push(['clear', ...args]),
    discardUnmaterializedAiLaunchSession: async (...args) => calls.push(['discard', ...args]) };
  const run = vm.runInNewContext(compiled + '\nfinalizeAiLaunchSnapshot', {
    useWorkspaceStore: { getState: () => store }, ipcRenderer: { invoke }, console: quiet,
  });
  return { run: () => run('T'), calls, tab, replace: () => { snapshot = { ...snapshot }; } };
}
function timelineHandler(service, physical) {
  const src = fs.readFileSync(path.join(__dirname, 'ipc/codex-data.js'), 'utf8');
  const start = src.indexOf("  ipcMain.handle('codex:get-timeline'");
  const end = src.indexOf("  ipcMain.handle('codex:get-full-history'", start);
  let handler;
  vm.runInNewContext(src.slice(start, end), { ipcMain: { handle: (_name, fn) => { handler = fn; } },
    transcriptService: service, projectCodexTimelineFromFile: async () => physical,
    deriveCodexForkSnapshot: () => null, console: quiet });
  return payload => handler(null, payload);
}

for (const extra of [{ forked_from_id: SOURCE }, { history_base: { session_id: SOURCE } },
  { forked_from_ordinal_exclusive: 0 }, { history_mode: 'linked' }]) {
  test('thin linked child is never disposable metadata-only: ' + Object.keys(extra)[0], () => {
    const state = codexData._api.inspectConversationMaterialization([meta(extra),
      { type: 'event_msg', payload: { type: 'thread_settings_applied' } }], CHILD);
    assert.equal(state.metadataOnly, false);
    assert.equal(state.materialized, false, 'physical header does not prove composite readability either');
  });
}

test('legacy timeline/finalizer reads actual composite source prefix, not empty physical child', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-finalize-proof-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.jsonl'), childPath = path.join(dir, 'child.jsonl');
  const sourceRecords = [meta({ id: SOURCE }), { type: 'event_msg', timestamp: '2026-10-14T00:00:00Z',
    payload: { type: 'user_message', message: 'external source retained' } }];
  const childRecords = [meta({ forked_from_id: SOURCE }), { type: 'event_msg', payload: { type: 'thread_settings_applied' } }];
  const jsonl = rows => rows.map(x => JSON.stringify(x)).join('\n') + '\n';
  await fs.promises.writeFile(sourcePath, jsonl(sourceRecords));
  await fs.promises.writeFile(childPath, jsonl(childRecords));
  const sourceBytes = (await fs.promises.stat(sourcePath)).size, childBytes = (await fs.promises.stat(childPath)).size;
  const lineageManifest = buildCodexForkLineageManifest({ sourceSessionId: SOURCE, childSessionId: CHILD,
    sourceSegments: [{ physicalSessionId: SOURCE, fromByte: 0, toByte: sourceBytes, startLine: 0,
      endLine: sourceRecords.length, prefixDigest: (await hashFileSegment(sourcePath, 0, sourceBytes)).sha256 }],
    childTailStart: { byteOffset: childBytes, line: childRecords.length,
      prefixDigest: (await hashFileSegment(childPath, 0, childBytes)).sha256 } });
  const service = new SessionTranscriptService({ getMainWindow: () => null,
    codexData: { _api: { ...codexData._api, findCodexSessionFile: async id => ({ filePath: id === SOURCE ? sourcePath : childPath }) } },
    sessionHistoryStore: { getSessionHistoryEvents: id => id === CHILD ? [{ eventType: 'fork', provider: 'codex',
      sessionId: CHILD, sourceSessionId: SOURCE, childSessionId: CHILD, snapshotComplete: true,
      origin: 'app', isDirect: true, lineageManifest }] : [] } });
  t.after(() => service.dispose());
  const invoke = timelineHandler(service, { success: true, entries: [], sessionMeta: childRecords[0].payload });
  const result = await invoke({ sessionId: CHILD, cwd: '/fixture', tabId: 'T' });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.entries.filter(x => x.type === 'user').length, 1);
  const f = finalizer((_channel, payload) => invoke(payload));
  await f.run();
  assert.equal(f.calls.some(c => c[0] === 'discard'), false);
  assert.equal(fs.existsSync(childPath), true);
});

test('unresolved canonical lineage is not replaced with physical empty success', async () => {
  const failure = { success: false, error: 'lineage_unresolved', entries: [] };
  const invoke = timelineHandler({ getTimeline: async () => failure }, { success: true, entries: [] });
  assert.strictEqual(await invoke({ sessionId: CHILD }), failure);
});

for (const changed of ['snapshot', 'session', 'cwd']) test('late empty result cannot discard changed ' + changed, async () => {
  const hold = deferred(), f = finalizer(() => hold.promise);
  const pending = f.run();
  if (changed === 'snapshot') f.replace();
  if (changed === 'session') f.tab.codexSessionId = SOURCE;
  if (changed === 'cwd') f.tab.cwd = '/different';
  hold.resolve({ success: true, entries: [] });
  await pending;
  assert.deepEqual(f.calls, []);
});

test('proven ordinary empty result keeps existing discard request', async () => {
  const f = finalizer(async () => ({ success: true, entries: [] }));
  await f.run();
  assert.equal(f.calls.filter(c => c[0] === 'discard').length, 1);
});

for (const fork of [true, false]) test('actual Main discard boundary ' + (fork ? 'preserves thin child' : 'still cleans standalone empty'), async () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('tab:set-codex-session-id'");
  const end = source.indexOf("ipcMain.handle('codex:reconcile-native-rewind-before-history-rewrite'", start);
  let handler, cas = 0, unlinks = 0;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    runKeyedExclusive: (_map, _key, operation) => operation(), codexLaunchInflight: new Map(),
    resolveAuthoritativeTabProjectId: () => 'P', codexLastRunCommandPayload: new Map(),
    getCodexRuntimeSessionSnapshot: async () => ({ liveLifecycle: false }),
    projectManager: { db: { getTabCodexSessionId: () => CHILD, compareAndSetTabCodexSessionId: () => { cas++; return true; } } },
    terminalProjects: new Map([['T', '/fixture']]), codexConversationMaterializationCache: new Map(),
    codexDataModule: { _api: { inspectConversationMaterialization: codexData._api.inspectConversationMaterialization,
      loadSessionRecords: async () => ({ success: true, filePath: '/controlled-child', records: [meta(fork ? { forked_from_id: SOURCE } : {})] }) } },
    fs: { promises: { unlink: async () => { unlinks++; } } }, console: quiet,
  });
  const result = await handler(null, { projectId: 'P', tabId: 'T', sessionId: null,
    expectedSessionId: CHILD, reason: 'discard-unmaterialized' });
  assert.equal(result.success, !fork);
  assert.equal(cas, fork ? 0 : 1);
  assert.equal(unlinks, fork ? 0 : 1);
});
