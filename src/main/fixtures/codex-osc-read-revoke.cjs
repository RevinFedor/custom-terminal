'use strict';

// Full actual OSC reducer -> canonical read contract -> retained projection ->
// actual Web History handler/recheck. Only OS/provider/UI leaves are controlled.
// Synthetic rollout bytes live exclusively under one disposable private root.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), crypto = require('node:crypto'), http = require('node:http'), url = require('node:url');
const ts = require('typescript');
const mainDir = path.resolve(__dirname, '..');
const contract = require('../codex-runtime-contract');
const { createCodexRuntimeProjectionStore } = require('../codex-runtime-projection-store');
const { projectCodexPolicyRuntime } = require('../codex-runtime-policies');
const { SessionTranscriptService } = require('../session-transcript-service');
const { PublicHistoryRevisions, historyPayloadCapability } = require('../public-history-read');
const { historyReadSession, historyReadOwnerFromProjection } = require('../history-read-session');
const { beginHttpReadDependency } = require('../http-read-diagnostics');
const { createHttpReadDiagnostics } = require('../http-read-diagnostics');
const { applyHistoryEntryWindow } = require('../history-entry-window');
const { assertAgentReadyOwner } = require('../agent-ready-wait');
const { validateFreshAgentRuntimeStatus } = require('../project-api-runtime-contract');
const { fingerprintAgentSendRequest } = require('../agent-send-receipt-registry');
const { resolveAiToolOwner } = require('../ai-tool-owner');
const { listExecutionNamespaces } = require('../workflow-organization-http');
const api = require('../ipc/codex-data')._api;
const quiet = { log() {}, warn() {}, error() {} };
const cached = new Map();
function declarations(file, names) {
  const key = file + ':' + names.join(',');
  if (cached.has(key)) return cached.get(key);
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const code = names.map(name => {
    const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (!node) throw Error('missing actual declaration ' + name); return node.getText(tree);
  }).join('\n'); cached.set(key, code); return code;
}
async function createOscReadFixture(t, { mainSource = process.env.IOS35_CANDIDATE_MAIN || path.join(mainDir, 'main.js'),
  webSource = process.env.IOS35_CANDIDATE_WEB || path.join(mainDir, 'web-server.js'),
  tabId = 'ios35-chat', fixtureCwd = null, projectId = 'P' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-osc-read-'));
  const cwd = fixtureCwd || path.join(root, 'project'); if (!fixtureCwd) fs.mkdirSync(cwd);
  const sessionId = crypto.randomUUID(), filePath = path.join(root, 'synthetic.jsonl');
  const rows = [
    { type: 'session_meta', timestamp: '2026-10-20T00:00:00.000Z', payload: { id: sessionId, cwd, source: 'cli' } },
    { type: 'event_msg', timestamp: '2026-10-20T00:00:01.000Z', payload: { type: 'user_message', message: 'PRIVATE IOS35 QUESTION', images: [] } },
    { type: 'response_item', timestamp: '2026-10-20T00:00:02.000Z', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'PRIVATE IOS35 HISTORY TEXT' }] } },
  ];
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
  const term = { pid: 10001 }, events = [], inputEffects = [];
  let savedSessionId = sessionId, readHook = null, statusHook = null, reads = 0;
  const ctx = vm.createContext({ require, path, fs, crypto, srcMainDir: mainDir, console: quiet,
    ...contract, ...require('../ai-shell-launch'), projectCodexPolicyRuntime,
    CODEX_STARTUP_NO_STATE_TIMEOUT_MS: 60000, TERMINAL_COMMAND_META_TTL_MS: 15000,
    codexRuntimeProjectionStore: createCodexRuntimeProjectionStore(),
    terminals: new Map([[tabId, term]]), terminalLifecycleEpochs: new Map([[term, 'G']]),
    terminalCommandState: new Map([[tabId, { runSeq: 7, isRunning: true }]]),
    terminalProjects: new Map([[tabId, cwd]]), codexRuntimePolicies: null, codexLiveSettingsObserver: null,
    terminalProjectIds: new Map([[tabId, projectId]]), terminalInputRevisions: new Map(), terminalStopRevisions: new Map(),
    sdkSessions: new Map(), bridgeKnownSessions: new Map(), claudeStartupGateRevisions: new Map(), claudeTurnBusy: new Map(),
    // No logical history-mutation owner is provisioned by this read fixture.
    // This explicit unknown is not another SID or an authoring/writer proof.
    conversationOwners: { current: () => ({ version: 1, ownerToken: null, ownerOrder: null, currentBinding: { state: 'unknown' } }) },
    resolveAiToolTypeForTab: id => id === tabId ? 'codex' : null,
    getActiveAgentExecutionContext: () => null, currentClaudeStartupDefaultsGate: () => null,
    getCodexTuiReadyState: async () => ({}),
    codexSessionIdFromDb: () => savedSessionId, resolveAuthoritativeTabProjectId: () => projectId,
    isCodexWriterUsableForMutation: () => false,
    isCodexTuiEffectivelyReady: () => true, hasCodexEstablishedComposerLifecycle: () => true,
    hasCodexEstablishedWriterUiLifecycle: () => false, hasEstablishedCodexLifecycleIndicators: () => true,
    getCodexLiveInputControl: () => null, hasCodexPromptOrTurnInFlight: () => false,
    codexTurnStateSnapshot: () => ({ busy: false, hasWatcher: true }),
    getCodexProvisionalSettingsSnapshot: () => null, getCodexMcpStartupStatus: () => null,
    readAgentSendDestinationAtWriteBoundary: () => null,
    ipcMain: { emit: (...args) => events.push(['ipc', ...args]) },
    terminalShellReadiness: { markCommandBoundary() {}, markAgentLaunchStarted() {} },
    terminalCommandAdmission: { started: () => null },
    clearClaudeEditableLastPrompt() {}, clearCodexDescendantExitRecheck() {},
    clearCodexServiceTierLaunchCandidate() {}, clearTerminalActiveCommandMeta(state) { delete state.activeCommand; },
    rememberTerminalCommandRun() {},
    invalidateCodexWriterProof(id) { ctx.codexWriterProofs.delete(id); },
    invalidateCodexWriterObservations() {}, rearmCodexProcessActionBoundary: id => events.push(['rearm', id]),
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => events.push(['renderer', ...args]) } },
    // Physical effects are forbidden even if a fixture accidentally reaches one.
    safePasteAndSubmit() { inputEffects.push('paste'); throw Error('no physical input in read fixture'); },
  });
  for (const name of ['codexWriterProofs','codexKnownSessions','codexWatchers','codexTurnWatchers','codexProviderSemanticSources',
    'codexLastRunCommandPayload','codexResumeSourceLeases','codexSessionDiscoveryIntents','codexProvisionalSourceObservations',
    'codexConversationMaterializationCache','codexReadIdentitySubmitPending','aiStoppingTabs','codexManualActionRequired',
    'codexTuiReadyLastNotReady','codexLifecycleWarnings','claudeStartupIntents','claudeDebounceTimers','claudePendingPrompt',
    'claudeState','claudePreclaimedCommandGenerations','codexPreclaimedCommandGenerations','claudeLaunchGenerationByTab',
    'codexFinishDebounceTimers','terminalPendingCommandMeta','terminalInitialCommand']) ctx[name] = new Map();
  for (const name of ['codexLateMcpProofPending','codexTuiReadyTabs','codexStartupNoStateTimeoutTabs','claudeCliActive']) ctx[name] = new Set();
  ctx.claudeSpinnerBusy = new Map();
  const names = ['getTerminalLifecycleGeneration','parseOSC133AndEmit','applyTerminalCommandStartMeta',
    'getCodexWriterProofSnapshot','getCurrentCodexProvisionalSourceObservation','getCodexResumeSourceLeaseForTab',
    'getCodexResumeReadIdentityLeaseForTab','bindCodexResumeReadIdentityLease','getCurrentCodexEmptyReadSource',
    'projectCodexRuntimeSnapshotFromEvents','publishCodexRuntimeProjection','getCodexRuntimeProjectionBatch',
    'armCodexReadIdentitySubmitBarrier','markCodexReadIdentitySubmitWritten','clearCodexReadIdentitySubmitBarrier',
    'getTerminalInputRevision','getTerminalStopRevision','captureAiProcessLookupScope','aiProcessLookupScopeCurrent',
    'getCodexRuntimeSessionId','getCodexSavedSessionId','getCodexPublicWriterFields',
    'readMainAgentStartReadiness','readMainPublicRuntimeSnapshot'];
  vm.runInContext(declarations(mainSource, names), ctx);
  // Existing public-status readers use this SAME canonical context. Physical
  // lookup/TUI/registry leaves are controlled; no CLI/OS lookup or provider is
  // started. The full actual Main reader still rechecks physical/input/Stop
  // scope after its awaits. Never synthesize a positive public status tuple.
  ctx.readAiLifecycleIdentityForTab = async id => {
    const scope = ctx.captureAiProcessLookupScope(id), inputRevision = ctx.getTerminalInputRevision(id);
    const result = { processStatus: scope.terminal ? 'found' : 'absent',
      processPid: scope.terminal ? scope.terminal.pid + 1 : null,
      terminalRunSeq: scope.runSeq, inputRevision };
    await statusHook?.(); return result;
  };
  ctx.getCodexRuntimeSessionSnapshot = async id => ctx.projectCodexRuntimeSnapshotFromEvents(id);
  function installReadOwner() {
    const runSeq = ctx.terminalCommandState.get(tabId).runSeq, lifecycle = ctx.getTerminalLifecycleGeneration(tabId);
    const launch = { command: 'codex-c', tabId, sessionId, launchId: 'L' + runSeq, terminalToken: ctx.terminals.get(tabId), runSeq, lifecycleGeneration: lifecycle };
    ctx.codexLastRunCommandPayload.set(tabId, launch);
    ctx.codexResumeSourceLeases.set(sessionId, { tabId, launchId: launch.launchId });
    ctx.codexSessionDiscoveryIntents.set(tabId, { sourceMode: 'resume', sourceSessionId: sessionId,
      launchId: launch.launchId, sourceRunSeq: runSeq, sourceLifecycleGeneration: lifecycle });
    ctx.bindCodexResumeReadIdentityLease({ tabId, sourceSessionId: sessionId, launchId: launch.launchId,
      terminalToken: launch.terminalToken, terminalRunSeq: runSeq, terminalLifecycleGeneration: lifecycle });
    ctx.codexProvisionalSourceObservations.set(tabId, { status: 'provisional-source', sessionId, sourceSessionId: sessionId, persistedSessionId: sessionId,
      launchId: launch.launchId, terminalToken: launch.terminalToken, runSeq, lifecycleGeneration: lifecycle,
      processRunning: true, pids: [10002] });
    ctx.codexTurnWatchers.set(tabId, { sessionId, sourceObservationLaunchId: launch.launchId, processGeneration: lifecycle });
    ctx.codexConversationMaterializationCache.set(sessionId, { materialized: true, metadataOnly: false, timelineCount: 2, userTurns: 1 });
    return ctx.publishCodexRuntimeProjection(tabId, 'fixture-process-open-proof');
  }
  installReadOwner();
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData: { _api: {
    ...api, findCodexSessionFile: async sid => sid === sessionId ? { success: true, filePath } : null,
    loadSessionRecords: async sid => {
      if (sid !== sessionId) throw Error('foreign synthetic session');
      reads++; await readHook?.(); const stat = fs.statSync(filePath);
      const parsed = await api.readJsonlRange(filePath, 0, stat.size - 1);
      return { success: true, records: parsed.records, filePath, sourceSnapshot: {
        filePath, size: stat.size, mtimeMs: stat.mtimeMs, sessionId, linkKind: 'end' } };
    },
  } } });
  const sendJson = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const projectManager = { workflowOrganization: { listNamespaces: () => [{ id: projectId, path: cwd,
    tabs: [{ tabId, commandType: 'codex', cwd, codexSessionId: savedSessionId }] }] } };
  const web = vm.createContext({ url, crypto, path, console: quiet, setTimeout, clearTimeout,
    token: 'ios35-private-fixture', beginHttpReadDependency,
    httpReadDiagnostics: createHttpReadDiagnostics({ serviceId: 'ios35-private-read', log() {} }),
    handleSystemPromptApi: async () => false, handleDictationClipboardHttp: async () => false,
    workflowOrganizationHttp: async () => false, handleStorageMaintenance: async () => false, storageMaintenance: null,
    systemPromptService: null, readBody: async () => ({}),
    decId: decodeURIComponent, sendJson, historyReadSession, historyReadOwnerFromProjection,
    transcriptService: service, publicHistoryRevisions: new PublicHistoryRevisions(), historyPayloadCapability, applyHistoryEntryWindow,
    conversationOwners: null, finishConversationOwnerRead: () => ({}), publishTabTiming() {},
    publicTabActivity: null, publicRuntimeSnapshots: new Map(), fingerprintAgentSendRequest,
    assertAgentReadyOwner, validateFreshAgentRuntimeStatus, resolveAiToolOwner, listExecutionNamespaces,
    findOrchestrationTabDescriptor: id => id === tabId ? { tabId, toolType: 'codex', projectId, cwd, sessionId: savedSessionId } : null,
    resolveCodexRuntimeProjectionBatch: (tabs, projectId) => ctx.getCodexRuntimeProjectionBatch(tabs, projectId),
    resolveCodexRuntimeSessionInfo: id => ctx.getCodexRuntimeSessionSnapshot(id),
    readAgentRuntimeSnapshot: id => ctx.readMainPublicRuntimeSnapshot(id),
    resolveAgentToolType: null,
    bridgeRequest: () => { throw Error('renderer fallback forbidden'); },
    require: name => { if (name === './project-manager') return projectManager;
      throw Error('unexpected Web dependency ' + name); },
  });
  vm.runInContext(declarations(webSource, ['checkAuth','handleApi','resolveHistorySessionInfo',
    'resolvePersistedPtyAgentOwner','resolveCurrentPtyAgentOwner','resolveAgentSessionInfo',
    'coherentPublicRuntimeSnapshot','normalizePublicRuntimeStatus','stampPublicRuntimeSnapshot',
    'shortId','startRoutePendingLog','tabActivityProjection']), web);
  let server = null;
  const cleanup = async () => {
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await fs.promises.rm(root, { recursive: true });
  };
  if (t) t.after(cleanup);
  const boundary = (marker = 'codex') => ctx.parseOSC133AndEmit(tabId, '\x1b]133;B' + (marker ? ';tool=' + marker : '') + '\x07', ctx.terminals.get(tabId));
  const start = async () => {
    if (server) return server.address().port;
    server = http.createServer((req, res) => web.handleApi(req, res, url.parse(req.url, true), new Map())
      .catch(error => sendJson(res, 500, { error: error.message })));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port;
  };
  const request = async kind => {
    const port = await start();
    const response = await fetch('http://127.0.0.1:' + port + '/api/terminal-tabs/' + tabId + '/' + kind,
      { headers: { authorization: 'Bearer ios35-private-fixture' } });
    return { status: response.status, body: await response.json() };
  };
  return { root, cwd, sessionId, tabId, filePath, term, ctx, web, service, events, inputEffects,
    boundary, installReadOwner, read: () => request('history?view=history&delta=1&last=80'),
    status: () => request('status'), cleanup, reads: () => reads,
    holdRead: fn => { readHook = fn; }, holdStatus: fn => { statusHook = fn; }, replaceSaved: id => { savedSessionId = id; } };
}
module.exports = { createOscReadFixture, declarations };
