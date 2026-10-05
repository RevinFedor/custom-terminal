'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const source = fs.readFileSync(process.env.CODEX_REWIND_MAIN_SOURCE || path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const quiet = { log() {}, warn() {}, error() {} };
const noop = () => {};

function load(context, names) {
  vm.createContext(context);
  for (const name of names) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name);
    vm.runInContext(node.getText(ast), context);
  }
  return context;
}

// Real complete line handler; only adjacent services/IO are replaced. Keep
// noteInput before materialization, with the original current-owner guards.
function lineHarness({ statePatch = {}, offset = 9545463, foreignWatcher = false, liveGeneration } = {}) {
  const sid = 'a296a580-02d4-4ae7-ad3f-021be29390ac';
  const state = { tabId: 'HH467', sessionId: sid, processGeneration: 'pty:2',
    processGenerationBoundaryOffset: 9470177, eventSequence: 0, ...statePatch };
  const events = [];
  const context = load({
    console: quiet, mainWindow: null,
    ...require('./codex-turn-outcome'),
    ...require('./compact-operation-state'),
    ...require('./codex-prompt-audit'),
    compactOperations: require('./compact-operation-state').createCompactOperationRegistry(),
    terminals: new Map([['HH467', {}]]), terminalCommandState: new Map([['HH467', { runSeq: 2 }]]),
    codexTurnWatchers: new Map([['HH467', foreignWatcher ? {} : state]]),
    codexPromptGeneration: new Map(), codexKnownSessions: new Map([['HH467', sid]]),
    codexConversationMaterializationCache: new Map(),
    conversationOwners: { noteInput: id => events.push('input:' + id) },
    getTerminalLifecycleGeneration: () => liveGeneration || 'pty:2',
    recordCodexLiveSubagentOwnership: noop, trackCodexTabSubagentActivity: noop,
    codexEventType: r => r.type === 'event_msg' ? r.payload?.type : null,
    processCodexUserMessagePasteAudit: () => ({ matched: true }),
    resolveCodexLivePromptOwner: () => null,
    codexLiveSourceIdentity: () => 'exact-source', observeCodexCapacityRetryRecord: noop,
    buildCodexLiveRawMessage: () => null, buildCodexHistoryLiveCompactEntry: () => null,
    emitCodexHistoryLiveTurnBoundary: noop, reconcileCodexManualCompactPendingOwner: () => null,
    publishCodexRuntimeProjection: () => events.push('materialized'),
    loopTaskCompletionEligibility: () => ({ eligible: false }),
    terminalHistoryStreamingEnabled: true,
    terminalHistoryPreviewController: { bindPrompt: ({ sourceBoundary }) => {
      events.push('preview:' + sourceBoundary); return true;
    } },
  }, ['processCodexTurnLine']);
  const row = { type: 'event_msg', timestamp: '2026-10-05T12:13:19.125Z',
    payload: { type: 'user_message', message: 'а если я решу их делать то какой алооримт как это делаем?' } };
  const run = () => context.processCodexTurnLine(state, JSON.stringify(row), offset);
  return { state, context, events, run };
}

test('actual HH user_message handler no longer reads its offset in the TDZ', () => {
  const h = lineHarness();
  assert.doesNotThrow(h.run);
  assert.deepEqual(h.events.slice(0, 2), ['input:HH467', 'materialized']);
  assert.ok(h.events.includes('preview:9545463'));
});

for (const [name, options] of [
  ['old physical offset', { offset: 9470176 }],
  ['missing offset', { offset: null }],
  ['fractional offset', { offset: 9545463.5 }],
  ['foreign watcher', { foreignWatcher: true }],
  ['different generation', { liveGeneration: 'pty:3' }],
  ['suppressed Resume source', { statePatch: { publicTurnStateSuppressed: true } }],
  ['held catch-up', { statePatch: { catchUpPublicationsSuppressed: true } }],
]) {
  test('user_message preserves owner-checkpoint guard: ' + name, () => {
    const h = lineHarness(options);
    assert.doesNotThrow(h.run);
    assert.equal(h.events.filter(x => x.startsWith('input:')).length, 0);
  });
}

function sourceSubmitHarness(t, { large = false, journalPatch = {}, suffix, onScan, onRevalidate } = {}) {
  const Database = require('better-sqlite3');
  const DatabaseManager = require('./database');
  const data = require('./ipc/codex-data');
  const target = require('./codex-rewind-target-proof');
  const audit = require('./prompt-audit-fingerprint');
  // Production source proof stores the canonical lsof path. macOS tempdir is
  // a /var -> /private/var alias; use that same canonical authority in fixtures.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noted-native-source-submit-')));
  const sid = 'a296a580-02d4-4ae7-ad3f-021be29390ac';
  const tab = 'HH467';
  const key = 'codex.pending-writer-handoff.v1:' + tab;
  const file = path.join(root, 'rollout-' + sid + '.jsonl');
  const prompt = 'а если я решу их делать то какой алооримт как это делаем?';
  const timestamp = time => new Date(time).toISOString();
  const actionAt = Date.parse('2026-10-05T12:10:10.403Z');
  const sentAt = Date.parse('2026-10-05T12:13:18.238Z');
  const event = (type, time, extra = {}) => ({ type: 'event_msg', timestamp: timestamp(time), payload: { type, ...extra } });
  const response = (text, time) => ({ type: 'response_item', timestamp: timestamp(time),
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const rows = [{ type: 'session_meta', payload: { id: sid, source: 'cli', cwd: root } }];
  while (rows.length < 990) rows.push({ type: 'fixture_padding', payload: { text: large ? 'x'.repeat(9500) : '' } });
  rows.push(event('user_message', actionAt - 1000, { message: prompt }));
  const prefix = rows.map(x => JSON.stringify(x) + '\n').join('');
  const bytes = Buffer.byteLength(prefix);
  const defaultSuffix = [event('task_started', sentAt + 17, { turn_id: 'new-turn' }),
    response('# AGENTS.md instructions for /fixture\n<INSTRUCTIONS>rules</INSTRUCTIONS>', sentAt + 844),
    response(prompt, sentAt + 887), event('user_message', sentAt + 887, { message: prompt }),
    event('task_complete', sentAt + 1000, { turn_id: 'new-turn', last_agent_message: 'ANSWER' })];
  fs.writeFileSync(file, prefix + (suffix ? suffix({ event, response, prompt, sentAt }) : defaultSuffix)
    .map(x => JSON.stringify(x) + '\n').join(''));
  const sourceHash = require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const generation = 'codex-writer-handoff-1791202210118-41';
  const original = { version: 2, projectId: 'P', tabId: tab, cwd: root,
    sourceSessionId: sid, expectedBindingSessionId: sid, actionGeneration: generation,
    operationId: 'scenario-muv7jpzb-codex-us-9s8fkn', requestId: 'fixture-original-request',
    sourceLifecycleGeneration: 'pty:2', sourceRunSeq: 2,
    actionStartedAtMs: actionAt, targetSourceLine: 990, targetUuid: 'codex-user-' + sid + '-990',
    targetTextHash: target.hashCodexRewindTargetText(prompt), rollbackTurns: 1,
    restoredTextHash: target.hashCodexRewindTargetText(prompt), branchDraftRestoredAtMs: actionAt + 9590,
    phase: 'stable-source-submit-written',
    submitProof: { version: 1, originPhase: 'branch-draft-restored', sourceSessionId: sid,
      actionGeneration: generation, submitId: 'orchestration:docs51-realism-hh467-replay-20261005-v1',
      expectedLen: 57, expectedHash: audit.promptAuditFingerprint(prompt),
      sentAtMs: sentAt, submitWrittenAtMs: sentAt + 2, sourceFilePath: file, sourceFileSize: bytes, runSeq: 2 },
    ...journalPatch };
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);'
    + 'CREATE TABLE tabs(project_id TEXT, tab_id TEXT, codex_session_id TEXT);');
  const manager = new DatabaseManager({ existingConnection: db });
  db.prepare('INSERT INTO app_state VALUES(?,?,?)').run(key, JSON.stringify(original), 1);
  const immutableReceipt = JSON.stringify({ success: true, handoffStatus: 'branch-draft-restored',
    operationId: original.operationId, historyDraftText: prompt, activeSessionId: sid });
  db.prepare('INSERT INTO app_state VALUES(?,?,?)').run('original-result', immutableReceipt, 1);
  db.prepare('INSERT INTO tabs VALUES(?,?,?)').run('P', tab, sid);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const terminal = { write() { assert.fail('no PTY writes'); } };
  const command = { runSeq: 2, isRunning: true };
  const intent = { sourceMode: 'writer-handoff', sourceSessionId: sid, launchId: generation,
    sourceLifecycleGeneration: 'pty:2', sourceRunSeq: 2, expectedBindingSessionId: sid };
  const observer = { ...intent, handoffTerminalToken: terminal, sourceTerminalToken: terminal, handoffRunSeq: 2 };
  const candidate = { filePath: file, pids: [59326], fds: ['41'], meta: { id: sid, source: 'cli', cwd: root } };
  const incumbent = { status: 'incumbent-overlap-pending', reason: 'active-handoff-awaiting-successor',
    candidates: [candidate], preserveWriterProof: true };
  const state = { sessionId: sid, filePath: file, processGeneration: 'pty:2' };
  const events = [];
  let inputRevision = 8;
  let observation = 11;
  let processStatus = null;
  const context = {
    path, fs, console: quiet, setImmediate,
    ...target, ...require('./codex-writer-ownership'), ...require('./codex-writer-binding'),
    ...require('./codex-runtime-contract'),
    ...require('./codex-resume-user-activity'), ...require('./codex-prompt-audit'),
    pasteAuditHash: audit.promptAuditFingerprint,
    CODEX_NATIVE_REWIND_CHILD_WINDOW_MS: 600000,
    terminalProjects: new Map([[tab, root]]), terminalProjectIds: new Map([[tab, 'P']]),
    terminals: new Map([[tab, terminal]]), terminalCommandState: new Map([[tab, command]]),
    codexWatchers: new Map([[tab, observer]]), codexSessionDiscoveryIntents: new Map([[tab, intent]]),
    codexLastRunCommandPayload: new Map(), codexWriterSessionInflight: new Map(),
    codexKnownSessions: new Map([[tab, sid]]), codexWriterProofs: new Map(),
    codexPendingSettingsProofHandoffs: new Map(), codexTurnWatchers: new Map([[tab, state]]),
    projectManager: { db: manager },
    readPendingCodexNativeRewindHandoff: () => manager.inspectPendingCodexWriterHandoff(key).journal || null,
    codexSessionIdFromDb: () => manager.getTabCodexSessionId('P', tab),
    codexNativeRewindHandoffJournalKey: () => key,
    getTerminalLifecycleGeneration: () => 'pty:' + command.runSeq,
    getTerminalInputRevision: () => inputRevision,
    getCodexWriterObservationGeneration: () => observation,
    getCodexExitObserverGeneration: () => 'pty:' + command.runSeq,
    isCodexExitObserverCurrent: (_tab, lifecycle) => lifecycle === 'pty:' + command.runSeq,
    getCodexSessionOwner: () => null,
    runKeyedExclusive: (_map, _key, run) => run(),
    getCodexWriterProofSnapshot: () => context.codexWriterProofs.get(tab) || null,
    getPendingCodexPasteAudits: () => [], // The exact Send already settled; no TTL dependency.
    getCodexResumeSourceLeaseForTab: () => null,
    closeCodexDelayedWriterObserver: () => events.push('close-delayed'),
    closeCodexWatcher: () => { events.push('close-discovery');
      context.codexWatchers.delete(tab); context.codexSessionDiscoveryIntents.delete(tab); },
    codexDataModule: { _api: { ...data._api,
      findCodexSessionFile: async () => ({ filePath: file }),
      inspectCodexDescendantSessions: async () => ({ complete: true, descendants: [] }),
      scanCodexStableSourceRewindProof: async (...args) => {
        const value = await data._api.scanCodexStableSourceRewindProof(...args);
        onScan?.(context); return value;
      }, findCodexLinkedLiveBoundary: async () => ({ found: false }),
    } },
    inspectCodexOwnedWriter: async () => {
      if (context.codexSessionDiscoveryIntents.has(tab)) {
        events.push('probe-incumbent'); onRevalidate?.(context, events);
        return incumbent;
      }
      events.push('probe-normal');
      return processStatus || { status: 'owned', sessionId: sid, filePath: file, cwd: root, pids: [59326] };
    },
    syncCodexDelayedWriterCandidateWatchers: noop,
    invalidateCodexWriterProof: (_tab, reason) => events.push('invalid:' + reason),
    persistCodexKnownSessionBinding: () => ({ success: true, currentSessionId: sid }),
    setCodexKnownSession: (_tab, session, _reason, proof) => {
      assert.equal(manager.getTabCodexSessionId('P', tab), session);
      context.codexWriterProofs.set(tab, { ...proof, sessionId: session, valid: true });
      events.push('publish-writer'); return { success: true };
    },
    releaseCodexSourceObservationAfterWriterProof: noop,
    transcriptService: { notifyCodexLineageCommitted: noop },
  };
  load(context, ['projectCodexSourceTranscriptForRewindRecovery', 'recoverPendingCodexStableSourceFromTranscript',
    ...(ast.statements.some(n => n.name?.text === 'commitCodexStableSourceTranscriptRecovery')
      ? ['commitCodexStableSourceTranscriptRecovery'] : []),
    ...(ast.statements.some(n => n.name?.text === 'reconcileCodexNativeRewindSourceSubmit')
      ? ['reconcileCodexNativeRewindSourceSubmit'] : []),
    'reconcileCodexWriterFromProcessInner']);
  const run = () => context.reconcileCodexWriterFromProcessInner(tab, { expectedObserver: observer });
  return { run, context, events, original, db, manager, key, file, root, candidate, incumbent, sid, tab,
    sourceHash, immutableReceipt, setInput: x => { inputRevision = x; },
    setObservation: x => { observation = x; }, setProcessStatus: x => { processStatus = x; } };
}

test('HH native draft -> exact continued-source Send -> same writer, without a second Enter', async t => {
  const h = sourceSubmitHarness(t, { large: true });
  assert.ok(fs.statSync(h.file).size > 9_000_000);
  const result = await h.run();
  assert.equal(result.status, 'adopted', JSON.stringify(result));
  assert.equal(result.sessionId, h.sid);
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'absent');
  assert.equal(h.context.codexWriterProofs.get(h.tab)?.valid, true);
  assert.ok(h.events.indexOf('close-discovery') < h.events.indexOf('publish-writer'));
  assert.equal(h.db.prepare('SELECT value FROM app_state WHERE key=?').get('original-result').value, h.immutableReceipt);
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(h.file)).digest('hex'), h.sourceHash);
  const again = await h.context.reconcileCodexWriterFromProcessInner(h.tab);
  assert.equal(again.status, 'adopted');
  assert.equal(h.events.filter(x => x === 'close-discovery').length, 1);
});

for (const [name, patch] of [
  ['draft without submitted bytes', { phase: 'branch-draft-restored' }],
  ['different action generation', { actionGeneration: 'other' }],
  ['wrong physical target', { targetUuid: 'codex-user-other-990' }],
  ['wrong target hash', { targetTextHash: '0'.repeat(64) }],
  ['wrong source lifecycle', { sourceLifecycleGeneration: 'pty:9' }],
  ['wrong run', { sourceRunSeq: 9 }],
]) test('no source settlement: ' + name, async t => {
  const h = sourceSubmitHarness(t, { journalPatch: patch });
  assert.equal((await h.run()).status, 'incumbent-overlap-pending');
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'present');
  assert.equal(h.events.includes('publish-writer'), false);
});

for (const [name, mutation] of [
  ['input changed during scan', c => { c.getTerminalInputRevision = () => 9; }],
  ['terminal replaced', c => { c.terminals.set('HH467', {}); }],
  ['new launch', c => { c.codexLastRunCommandPayload.set('HH467', { launchId: 'new' }); }],
  ['watcher replaced', c => { c.codexWatchers.set('HH467', {}); }],
  ['project moved', c => { c.terminalProjectIds.set('HH467', 'other'); }],
  ['cwd changed', c => { c.terminalProjects.set('HH467', '/other'); }],
  ['journal replaced', c => { const j = c.readPendingCodexNativeRewindHandoff();
    c.projectManager.db.db.prepare('UPDATE app_state SET value=? WHERE key=?')
      .run(JSON.stringify({ ...j, requestId: 'new-request' }), c.codexNativeRewindHandoffJournalKey()); }],
]) test('async source proof cannot cross ' + name, async t => {
  const h = sourceSubmitHarness(t, { onScan: mutation });
  assert.equal((await h.run()).status, 'incumbent-overlap-pending');
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'present');
  assert.equal(h.events.includes('close-discovery'), false);
});

test('installed/pre-fix same-source path remains pending despite the exact durable submit', async t => {
  // With CODEX_REWIND_MAIN_SOURCE this test also documents the original RED.
  const h = sourceSubmitHarness(t);
  const initial = h.context.reconcileCodexNativeRewindSourceSubmit;
  if (!initial) return;
  h.context.reconcileCodexNativeRewindSourceSubmit = async () => ({ success: false });
  assert.equal((await h.run()).status, 'incumbent-overlap-pending');
  assert.equal(h.events.includes('publish-writer'), false);
  h.context.reconcileCodexNativeRewindSourceSubmit = initial;
});

for (const [name, discovery] of [
  ['incomplete discovery', { complete: false, descendants: [] }],
  ['existing child', { complete: true, descendants: [{ sessionId: 'child' }] }],
]) test('continued source does not erase ' + name, async t => {
  const h = sourceSubmitHarness(t);
  h.context.codexDataModule._api.inspectCodexDescendantSessions = async () => discovery;
  assert.equal((await h.run()).status, 'incumbent-overlap-pending');
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'present');
});

for (const [name, suffix] of [
  ['only service context', ({ event, response, sentAt }) => [event('task_started', sentAt + 10),
    response('# AGENTS.md instructions for /fixture\n<INSTRUCTIONS>rules</INSTRUCTIONS>', sentAt + 20)]],
  ['exact text without task', ({ event, prompt, sentAt }) => [event('user_message', sentAt + 20, { message: prompt })]],
  ['another first user then same-text steering', ({ event, prompt, sentAt }) => [event('task_started', sentAt + 10),
    event('user_message', sentAt + 20, { message: 'different' }), event('user_message', sentAt + 30, { message: prompt })]],
  ['aborted slot then same text', ({ event, response, prompt, sentAt }) => [event('task_started', sentAt + 10),
    response('different', sentAt + 20), event('turn_aborted', sentAt + 21),
    event('user_message', sentAt + 30, { message: prompt })]],
]) test('continued-source proof refuses ' + name, async t => {
  const h = sourceSubmitHarness(t, { suffix });
  assert.equal((await h.run()).status, 'incumbent-overlap-pending');
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'present');
});

for (const [name, mutate] of [
  ['new PID', h => { h.candidate.pids = [59327]; }],
  ['another root writer', h => { h.incumbent.candidates.push({ ...h.candidate, meta: { id: 'other', cwd: h.root } }); }],
  ['lost physical observation', h => { h.incumbent.status = 'unknown'; }],
  ['changed persisted binding', h => { h.db.prepare('UPDATE tabs SET codex_session_id=?').run('other'); }],
  ['source inode replaced', h => { fs.renameSync(h.file, h.file + '.old'); fs.copyFileSync(h.file + '.old', h.file); }],
  ['source truncated', h => { fs.truncateSync(h.file, 5); }],
]) test('final source commit rejects ' + name, async t => {
  let h;
  let probes = 0;
  h = sourceSubmitHarness(t, { onRevalidate: () => { if (++probes === 2) mutate(h); } });
  const result = await h.run();
  assert.notEqual(result.status, 'adopted');
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'present');
  assert.equal(h.events.includes('publish-writer'), false);
});

test('SQLite settlement refusal preserves observer/journal/receipt and publishes no writer', async t => {
  const h = sourceSubmitHarness(t);
  h.manager.resolvePendingCodexStableSourceFromTranscript = () => ({ success: false, error: 'fixture-CAS-refused' });
  assert.equal((await h.run()).status, 'incumbent-overlap-pending');
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'present');
  assert.equal(h.events.includes('close-discovery'), false);
  assert.equal(h.db.prepare('SELECT value FROM app_state WHERE key=?').get('original-result').value, h.immutableReceipt);
});

test('fresh physical unknown after exact settlement is not fabricated as adopted', async t => {
  const h = sourceSubmitHarness(t);
  h.setProcessStatus({ status: 'unknown', preserveWriterProof: true });
  assert.equal((await h.run()).status, 'unknown');
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'absent');
  assert.equal(h.events.includes('publish-writer'), false);
});

test('restart uses the same original branch submit tuple and exact startup CAS', async t => {
  const h = sourceSubmitHarness(t);
  const result = await h.context.recoverPendingCodexStableSourceFromTranscript({ key: h.key,
    journal: h.original, currentSessionId: h.sid, discoveryComplete: true, descendants: [] });
  assert.equal(result.success, true);
  assert.equal(result.reason, 'stable-source-exact-submit-task-and-user-message');
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'absent');
  assert.equal(h.events.includes('publish-writer'), false, 'startup settlement itself is not writer proof');
  assert.equal(h.db.prepare('SELECT value FROM app_state WHERE key=?').get('original-result').value, h.immutableReceipt);
});

test('proof IO failure keeps the written journal pending, not a thrown public read', async t => {
  const h = sourceSubmitHarness(t);
  h.context.codexDataModule._api.scanCodexStableSourceRewindProof = async () => { throw Error('fixture-read-failed'); };
  const result = await h.run();
  assert.equal(result.status, 'incumbent-overlap-pending');
  assert.equal(result.sourceSubmitReason, 'source-submit-read-failed');
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'present');
});

test('explicit Stop during proof cannot clear the written journal', async t => {
  const h = sourceSubmitHarness(t, { onScan: c => { c.isCodexExitObserverCurrent = () => false; } });
  assert.equal((await h.run()).status, 'stale-exit-observer');
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'present');
  assert.equal(h.events.includes('close-discovery'), false);
});

test('queued writer lock rejects a source replacement before the SQLite CAS', async t => {
  const h = sourceSubmitHarness(t);
  h.context.runKeyedExclusive = async (_map, _key, run) => {
    fs.renameSync(h.file, h.file + '.old'); fs.copyFileSync(h.file + '.old', h.file);
    return run();
  };
  assert.equal((await h.run()).status, 'incumbent-overlap-pending');
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'present');
});

test('real process FD/metadata inspection feeds exact source submit -> SQLite -> normal writer adoption', async t => {
  const cp = require('node:child_process');
  const util = require('node:util');
  const h = sourceSubmitHarness(t);
  const child = cp.spawn(process.execPath, ['-e',
    "const fs=require('node:fs'); const fd=fs.openSync(process.argv[1],'a'); process.stdout.write('READY'); process.stdin.resume();", h.file],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  t.after(async () => {
    if (child.exitCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error('dummy writer did not initialize')), 5000);
    child.once('error', e => { clearTimeout(deadline); reject(e); });
    child.stdout.once('data', chunk => { clearTimeout(deadline); assert.equal(String(chunk), 'READY'); resolve(); });
  });
  const term = h.context.terminals.get(h.tab);
  const generation = h.original.actionGeneration;
  Object.assign(h.context, {
    ...require('./codex-settings-writer-transition'),
    AI_PROCESS_LOOKUP_STATUS: { UNKNOWN: 'unknown', ABSENT: 'absent' },
    inspectAiDescendantProcessesByTab: async () => ({ status: 'found', matches: [{ pid: child.pid }] }),
    codexDescriptorProbeGate: { run: run => run() },
    execFileAsync: util.promisify(cp.execFile), codexSessionsDir: () => h.root,
    buildCodexNativeRewindProofContext: async (_tab, _proof, intent) => intent ? {
      kind: 'native-rewind', sourceSessionId: h.sid, actionGeneration: generation,
      observerGeneration: generation, actionStartedAtMs: h.original.actionStartedAtMs, liveProofs: [],
    } : null,
    buildCodexSettledRewindProofContext: () => null,
    buildCodexNativeRewindSourceIncumbentContext: (_tab, intent) => intent ? {
      kind: 'native-rewind-source-incumbent', valid: true, sessionId: h.sid, filePath: h.file,
      actionGeneration: generation, observerGeneration: generation,
      terminalToken: term, observerTerminalToken: term,
      lifecycleGeneration: 'pty:2', observerLifecycleGeneration: 'pty:2', runSeq: 2, observerRunSeq: 2,
      expectedBindingSessionId: h.sid, boundSessionId: h.sid, actionAuthorityId: 'fixture-original', incumbentOnly: true,
    } : null,
    buildCodexResumedSubmitCandidateProof: async () => ({ active: false }),
    inspectCodexWriterProcessProof: (...args) => h.context.inspectCodexWriterProcessProofInner(...args),
  });
  load(h.context, ['inspectCodexWriterProcessProofInner', 'inspectCodexOwnedWriter']);
  const result = await h.run();
  assert.equal(result.status, 'adopted', JSON.stringify(result));
  assert.deepEqual(result.pids, [child.pid]);
  assert.equal(h.context.codexWriterProofs.get(h.tab)?.sessionId, h.sid);
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'absent');
});

test('delayed child reads its own causal bytes, not an undefined Resume reservation', async t => {
  const h = sourceSubmitHarness(t);
  const childId = 'fixture-delayed-child';
  const created = Number(h.original.submitProof.sentAtMs) + 10;
  const rows = [
    { type: 'session_meta', timestamp: new Date(created).toISOString(), payload: { id: childId, cwd: h.root, source: 'cli' } },
    { type: 'event_msg', timestamp: new Date(created + 10).toISOString(),
      payload: { type: 'user_message', message: 'а если я решу их делать то какой алооримт как это делаем?' } },
  ];
  const file = path.join(h.root, 'rollout-' + childId + '.jsonl');
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r) + '\n').join(''));
  const candidate = { filePath: file, meta: rows[0].payload, metadata: { meta: rows[0].payload, records: rows }, pids: [42] };
  const submit = h.original.submitProof;
  const pendingAudit = { submitWritten: true, submitId: submit.submitId, sentAt: submit.sentAtMs,
    expectedLen: submit.expectedLen, expectedHash: submit.expectedHash,
    preSubmitBoundary: { sessionId: h.sid, filePath: h.file, fileSize: submit.sourceFileSize } };
  h.context.getPendingCodexPasteAudits = () => [pendingAudit];
  load(h.context, ['buildCodexDelayedStableSourceProofContext']);
  const result = await h.context.buildCodexDelayedStableSourceProofContext(h.tab, [candidate]);
  assert.equal(result.proofError, undefined, result.proofError);
  assert.equal(result.selection.status, 'selected', JSON.stringify(result.selection));
  assert.equal(result.selection.sessionId, childId);
  assert.equal(h.manager.inspectPendingCodexWriterHandoff(h.key).status, 'present', 'read proof never commits');
});

test('same-SID recovery uses the actual publisher to refresh desktop and public writer state', async t => {
  const h = sourceSubmitHarness(t);
  const sent = [];
  const snapshots = [];
  Object.assign(h.context, {
    ...require('./codex-settings-writer-transition'),
    codexTuiReadyMeta: new Map(),
    currentCodexAcceptedResumeSourceProof: () => null,
    getCodexModelEffortIntentRecord: () => null,
    planCodexModelEffortIntentOwnerHandoff: () => ({ transfer: false }),
    codexSessionContextObserver: null,
    ipcMain: new (require('node:events').EventEmitter)(),
    scheduleCodexModelEffortIntentReconcile: noop,
    clearCodexReadIdentitySubmitBarrier: () => sent.push({ name: 'barrier-cleared' }),
    tabWorkContext: { syncLinks: async () => {} },
    mainWindow: { isDestroyed: () => false, webContents: { send: (name, payload) => sent.push({ name, payload }) } },
    reconcileCodexServiceTierProofIdentity: noop,
    clearCodexServiceTierLaunchCandidate: noop,
    broadcastCodexPublicRuntimeSnapshot: () => snapshots.push(h.context.getCodexWriterProofSnapshot(h.tab)),
  });
  load(h.context, ['setCodexKnownSession', 'getCodexWriterProofSnapshot']);
  const result = await h.run();
  assert.equal(result.status, 'adopted');
  const notification = sent.find(x => x.name === 'terminal:mcp-ai-tab');
  assert.equal(notification.payload.writerProven, true);
  assert.equal(notification.payload.sessionId, h.sid);
  assert.equal(notification.payload.previousSessionId, h.sid);
  assert.equal(snapshots.at(-1).valid, true);
  assert.equal(snapshots.at(-1).kind, 'process-open-rollout');
  assert.ok(sent.some(x => x.name === 'barrier-cleared'));
  const read = h.context.resolveCodexReadIdentity({ tabId: h.tab, liveLifecycle: true,
    savedSessionId: h.sid, persistedSessionId: h.sid, provenWriterSessionId: snapshots.at(-1).sessionId,
    writerStatus: 'adopted', writerConfirmed: true, writerUsableForMutation: true, writerProof: snapshots.at(-1).kind });
  assert.equal(read.available, true);
  assert.equal(read.sessionId, h.sid);
  const data = require('./ipc/codex-data');
  const parsed = await data._api.readJsonlRange(h.file, 0, fs.statSync(h.file).size - 1);
  const history = data._api.buildCodexFullHistory(parsed.records, read.sessionId);
  assert.ok(history.some(entry => entry.role === 'user' && String(entry.content || '').includes('алооримт')));
  const timeline = data._api.buildCodexTimeline(parsed.records, read.sessionId);
  assert.ok(timeline.some(entry => entry.type === 'user' && entry.uuid === h.original.targetUuid));
  assert.ok(timeline.length >= 2, 'the exact target and new Send remain addressable');
});
