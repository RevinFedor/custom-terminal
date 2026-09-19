'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const api = require('./ipc/codex-data')._api;
const contract = require('./codex-runtime-contract');
const { resolveCodexSourceSettingsProof } = require('./codex-source-settings');
const { historyPreparationActivity } = require('./history-preparation-activity');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const tree = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const runner = tree.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'runCodexCommandFromPayloadInner');
assert.ok(runner);
// Execute the real admission + preparation + settings planner. End at its
// existing launch boundary, so this test cannot issue PTY/CLI/account writes.
const prefix = runner.getText(tree).split('  const effectiveModel = commandSettings.model;')[0]
  + '\nreturn { commandSettings, sourceSettingsProof, sourceMetadataForLaunch, sourceMaterialization, emptyReadSource, forkSourceHistorySnapshot };\n}';
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const quiet = { log() {}, warn() {}, error() {} };
const line = row => JSON.stringify(row) + '\n';
const meta = cwd => ({ type: 'session_meta', payload: { id: SID, cwd, history_mode: 'legacy' } });
const settings = effort => ({ type: 'turn_context', payload: { model: 'source-model', effort } });

async function fixture(t, { heavy = false, empty = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-main-resume-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  const created = await api.materializeEmptySession({ sessionId: SID, cwd: root, sessionsDir });
  fs.writeFileSync(created.filePath, line(meta(root)) + (empty ? '' : line(settings('max'))
    + line({ type: 'event_msg', payload: { type: 'user_message', message: 'fixture only' } })));
  if (heavy) fs.appendFileSync(created.filePath, line({ type: 'compacted', payload: {
    replacement_history: [{ type: 'message', content: 'x'.repeat(8 * 1024 * 1024) }],
  } }));
  let fullReads = 0;
  const scopedApi = { ...api,
    loadResumeSource: (sid, cwd, options) => api.loadResumeSource(sid, cwd, { ...options, sessionsDir }),
    inspectConversationMaterializationFromFile: (sid, cwd) =>
      api.inspectConversationMaterializationFromFile(sid, cwd, { sessionsDir }),
    loadSessionRecords: async () => { fullReads++; throw Error('full/raw Resume reader forbidden'); },
  };
  const context = vm.createContext({ console: quiet, ...contract, resolveCodexSourceSettingsProof,
    codexRewindRecoveryScanStatus: 'complete', readPendingCodexNativeRewindHandoff: () => null,
    terminals: new Map([['T', { write() { throw Error('no PTY writes'); } }]]),
    terminalCommandState: new Map([['T', { runSeq: 7 }]]), terminalProjects: new Map([['T', root]]),
    proveIdleShellForAgentLaunch: async () => ({ allowed: true }),
    getCodexBoundSessionId: () => SID, resolveAuthoritativeTabProjectId: () => 'P',
    projectManager: { db: { getTabCodexSettingsState: () => null } },
    readDefaultCodexSetting: () => null,
    codexDataModule: { _api: scopedApi }, codexConversationMaterializationCache: new Map(),
  });
  vm.runInContext(prefix, context);
  return { ...created, root, sessionsDir, context, scopedApi, fullReads: () => fullReads,
    run: patch => context.runCodexCommandFromPayloadInner(null, {
      tabId: 'T', command: 'codex-c', sessionId: SID, cwd: root,
      model: 'tab-choice', effort: 'low', modelSource: 'tab-or-explicit', effortSource: 'tab-or-explicit',
      ...patch,
    }) };
}

test('actual main Resume proof reaches launch with exact source pair without calling full/raw loader', async t => {
  const h = await fixture(t, { heavy: true });
  const operations = [];
  const unsubscribe = historyPreparationActivity.subscribe(state => operations.push(state.operations));
  t.after(unsubscribe);
  const result = await h.run();
  assert.equal(result.commandSettings.allowed, true);
  assert.equal(result.commandSettings.model, 'source-model');
  assert.equal(result.commandSettings.effort, 'max');
  assert.equal(result.sourceMetadataForLaunch.id, SID);
  assert.equal(result.sourceMaterialization.userTurns, 1);
  assert.equal(h.fullReads(), 0);
  assert.deepEqual(operations.map(rows => rows.length), [1, 0]);
  assert.equal(operations[0][0].kind, 'resume');
  assert.equal(operations[0][0].tabId, 'T');
  await h.run();
  assert.equal(operations.length, 2, 'unchanged Resume has no preparation flash');
  fs.appendFileSync(h.filePath, line(settings(null)));
  const invalid = await h.run();
  assert.equal(invalid.error, 'codex_resume_source_settings_invalid');
  assert.equal(h.fullReads(), 0);
});

test('actual main empty Resume preserves metadata-only choice and the standalone empty read proof', async t => {
  const h = await fixture(t, { empty: true });
  const result = await h.run();
  assert.equal(result.commandSettings.allowed, true);
  assert.equal(result.commandSettings.settingsSource, 'resume-empty-tab-choice');
  assert.equal(result.commandSettings.model, 'tab-choice');
  assert.equal(result.sourceMaterialization.metadataOnly, true);
  assert.equal(result.emptyReadSource.sessionId, SID);
  assert.equal(result.emptyReadSource.filePath, h.filePath);
  assert.equal(h.fullReads(), 0);
  const fresh = await h.run({ materializedFresh: true });
  assert.equal(fresh.commandSettings.settingsSource, 'materialized-new-thread');
});

test('actual main Fork retains the full loaded source and exact lineage snapshot capability', async t => {
  const h = await fixture(t);
  let loaded, captured = null, lineage = 0;
  h.scopedApi.loadResumeSource = () => { throw Error('Fork must keep raw snapshot capability'); };
  h.scopedApi.loadSessionRecords = async () => {
    const stat = fs.statSync(h.filePath);
    const result = await api.readJsonlRange(h.filePath, 0, stat.size - 1);
    loaded = { success: true, records: result.records, filePath: h.filePath };
    return loaded;
  };
  h.context.transcriptService = {
    ensureCodexProviderForkLineage: async () => { lineage++; return { required: false, success: true }; },
    captureCodexForkSourceSnapshot: async request => { captured = request; return { snapshotComplete: true, fixture: 'exact' }; },
  };
  const result = await h.run({ command: 'codex-f' });
  assert.equal(result.commandSettings.allowed, true);
  assert.equal(result.commandSettings.settingsSource, 'fork-source-jsonl');
  assert.equal(lineage, 1);
  assert.equal(captured.loaded, loaded);
  assert.equal(result.forkSourceHistorySnapshot.snapshotComplete, true);
});

test('actual History rebuild publishes known-heavy work and finishes before unchanged/append reads', async t => {
  const h = await fixture(t, { heavy: true });
  const operations = [];
  const unsubscribe = historyPreparationActivity.subscribe(state => operations.push(state.operations));
  t.after(unsubscribe);
  const first = await api.projectCodexTimelineFromFile(SID, h.root, { sessionsDir: h.sessionsDir, tabId: 'H' });
  assert.equal(first.success, true);
  assert.deepEqual(operations.map(rows => rows.length), [1, 0]);
  assert.equal(operations[0][0].kind, 'history');
  const unchanged = await api.projectCodexTimelineFromFile(SID, h.root, { sessionsDir: h.sessionsDir });
  assert.equal(unchanged.mode, 'unchanged');
  fs.appendFileSync(h.filePath, line({ type: 'event_msg', payload: { type: 'task_complete' } }));
  assert.equal((await api.projectCodexTimelineFromFile(SID, h.root, { sessionsDir: h.sessionsDir })).mode, 'append');
  assert.equal(operations.length, 2);
});

test('actual History failed cold read releases its preparation operation', async t => {
  const h = await fixture(t, { heavy: true });
  api.invalidateCodexHistoryProjectors(h.filePath);
  const operations = [];
  const unsubscribe = historyPreparationActivity.subscribe(state => operations.push(state.operations.length));
  const original = fs.createReadStream;
  try {
    fs.createReadStream = (filePath, options) => {
      if (filePath === h.filePath) throw Error('isolated history read failure');
      return original(filePath, options);
    };
    await assert.rejects(api.projectCodexTimelineFromFile(SID, h.root, { sessionsDir: h.sessionsDir }),
      /isolated history read failure/);
  } finally { fs.createReadStream = original; unsubscribe(); }
  assert.deepEqual(operations, [1, 0]);
  assert.equal(historyPreparationActivity.snapshot().operations.length, 0);
});
