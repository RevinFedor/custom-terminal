// Mobile/web bridge: exposes Noted Terminal's project terminal tabs over
// HTTP+SSE/WS so a phone or external client can drive Claude/Codex PTY sessions.
// Backend runs in Electron main; frontend (mobile-web/) is a separate Vite app
// served as static files from this server. Authentication: single bearer token in
// ~/.noted-terminal/web-token.txt, regenerated only if missing.
//
// What's exposed:
//   GET  /api/me                                 → { ok: true } if token valid
//   GET  /api/agent-models                        → { codex:[…], claude:[…] } model catalog
//   GET  /api/projects                            → all projects from DB
//   GET  /api/focused-terminal-context             → exact terminal surface focused in desktop UI
//   GET  /api/projects/:projectId/tabs            → tabs of one project (DB)
//   POST /api/projects/:projectId/agent-tabs       → create Claude/Codex terminal tab
//   POST /api/terminal-tabs/:tabId/send            → send prompt through scenario layer
//   POST /api/terminal-tabs/:tabId/stop            → stop terminal runtime
//   POST /api/terminal-tabs/:tabId/fork            → fork Claude/Codex into a neighbour tab
//   POST /api/terminal-tabs/:tabId/link-file       → attach a file tab under an AI session
//   POST /api/external-research/orchestrations      → start/continue a tracked SC Desktop browser job
//   GET  /api/terminal-tabs/:tabId/history         → load JSONL/rollout session history
//   POST /api/terminal-tabs/:tabId/edit-range      → Claude JSONL / Codex rollout middle compact
//   POST /api/terminal-tabs/:tabId/delete-range    → Claude JSONL / Codex rollout middle delete
//   GET  /api/events?token=...&tabId=...           → live terminal event stream
//
// WS protocol — server → client:
//   { type:'snapshot',  tabId, messages, sessionId, busy }     (on subscribe)
//   { type:'message',   tabId, message, sessionId }            (per SDK message)
//   { type:'busy',      tabId, busy }                          (busy toggled)
//   { type:'done',      tabId, sessionId }                     (turn ended)
//   { type:'queue-update', tabId, queue }                      (Run-after queue changed)
//   { type:'ask-question', tabId, source, toolUseID, questions }  (Claude asked a question)
//   { type:'question-cancelled', tabId, source }               (question answered/aborted)
//
// State source: tabs come from SQLite (works for ALL projects, even closed),
// because renderer's openProjects map only has currently-open ones. Terminal
// runtime state comes from the renderer/main scenario layer; legacy SDK session
// metadata still comes from main's sdkSessions Map. Tab creation needs the
// renderer (so the tab actually appears in the UI), so we use a request/reply
// IPC bridge.
//
// Important: the WS protocol forwards the same payloads main already sends to
// the local renderer via webContents.send('claude-sdk:message' / 'busy-state').
// We added one helper at the source — `webBroadcast(...)` — that fan-outs to
// every WS client subscribed to that tabId. No business logic on the WS layer.

const http = require('http');
const http2 = require('http2');
const url = require('url');
const path = require('path');
const srcMainDir = __dirname;
const { AgentSendQueue } = require(path.join(srcMainDir, 'agent-send-queue'));
const { importMobileUploads, uploadPathKey, createOwnedAttachmentSnapshot,
  bindOwnedAttachmentSnapshot, attachmentOwnershipReceipt } = require(path.join(srcMainDir, 'owned-mobile-attachments'));
const { buildCodexImagePastePlan } = require(path.join(srcMainDir, 'codex-image-transport'));
const { imagePresentationFromReceipt } = require(path.join(srcMainDir, 'history-authoring-projection'));
const { completionNotificationCapability, completionNotificationRequest } = require(path.join(srcMainDir, 'tab-completion-notification-api'));
const { codexGoalCapability, codexGoalActionRequest } = require(path.join(srcMainDir, 'codex-goal-action-api'));
const { HistoryFreshness, historyFreshnessScopeKey } = require(path.join(srcMainDir, 'history-freshness'));
const { isLocalSlashCommandPrompt } = require(path.join(srcMainDir, 'agent-history-send-receipt'));
const { TabMessageService, formatTabMessagePrompt } = require(path.join(srcMainDir, 'tab-messages'));
const { compactTabMessage, handleTabMessageApi } = require(path.join(srcMainDir, 'tab-message-api'));
const { messageRuntimeIdentity, scenarioDestination, identityUnavailable } = require(path.join(srcMainDir, 'agent-message-identity'));
const { CompletionContentStore, buildOrchestrationCompletionContent,
  MAX_INLINE_ASSISTANT_CHARS } = require(path.join(srcMainDir, 'orchestration-completion-content'));
const { prepareStructuredAuthoring, validateStructuredSendEnvelope, bindStructuredAuthoringPresentation, STRUCTURED_AUTHORING_LIMITS } = require(path.join(srcMainDir, 'structured-authoring'));
const { MAX_EVENT_TABS, eventTabIds, stampedEventSink, PublicHistoryRevisions, TabTranscriptSubscriptions } = require(path.join(srcMainDir, 'public-history-read'));
const { observeHistoryResponseTimingBindings } = require(path.join(srcMainDir, 'history-response-timings'));
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { app, BrowserWindow, ipcMain } = require('electron');
const {
  codexSessionIdFromAuthoritativeStatus,
} = require('./codex-runtime-contract');
const {
  partitionProjectRuntimeTabs,
} = require('./project-tab-runtime-routing');
const { resolveAiToolOwner } = require('./ai-tool-owner');
const { prepareReusedInboxTab } = require('./inbox-tab-reuse');
const { prepareClosedCodexSettings } = require('./closed-codex-settings');
const { resolveSavedPromptComposition } = require('./saved-prompt-resolution');
const { historyReadSession, historyReadOwnerFromProjection } = require('./history-read-session');
const { resolveClaudeWatcherRuntime } = require('./claude-watcher-runtime');
const { readInboxResult } = require('./inbox-result-reader');
const { agentSendTargetPreconditionFailure } = require('./agent-send-target-precondition');
const { resolveInboxRewindTarget } = require('./inbox-rewind-identity');
const { historyEntryHasExactIdentity } = require('../shared/history-entry-identity.cjs');
const {
  classifyAgentActionBridgeError,
  classifyAgentActionResult,
  validateFreshAgentRuntimeStatus,
} = require('./project-api-runtime-contract');
const {
  waitForAgentReadyTransition,
  agentAdmittedReadyOwner,
  assertAgentReadyOwner,
} = require('./agent-ready-wait');
const {
  OrchestrationRunStore,
  hasNewerTargetRun,
  isActiveStatus,
  isTerminalStatus,
  isExternalResearchRun,
  isResultProofPending,
  isPausedRun,
  isCompleteOrchestrationResult,
  classifyAgentSendReceipt,
  shouldScheduleCreatedTargetAutoStop,
  shouldRetryWaitingNotificationForSourceLifecycle,
  shouldMarkSourceFollowupUnconfirmed,
  orchestrationTargetRunIdFromAudit,
  orchestrationCompletionRunIdFromAudit,
  mergeActiveLoadersWithOrchestrations,
  buildOrchestrationResultLookup,
  captureOrchestrationResultAttempt,
  orchestrationResultAttemptMatches,
  orchestrationSendFailureRecoveryPolicy,
  resolveCausalSourceExecutionContext,
} = require('./orchestration-runs');
const {
  ScExternalResearchClient,
  isScResearchTerminalStatus,
} = require('./sc-external-research-client');
const {
  ExternalResearchCoordinator,
} = require('./external-research-coordinator');
const {
  externalResearchJobId,
  normalizeExternalResearchRequest,
  externalResearchRequestFingerprint,
  externalResearchTargetLabel,
  continuationRequest,
} = require('./external-research-request');
const {
  buildDelegationResultTarget,
  isAgentStatusBusyForClose,
  isOrchestrationDeliveryIdentityCompatible,
  resolveOrchestrationDeliveryAdmission,
  resolveNewAgentTabPlacement,
  resolveOrchestrationSendOptions,
  resolveOrchestrationSourceNotificationSendOptions,
} = require('./orchestration-request-plan');
const {
  createOrchestrationDeliverySingleFlight,
} = require('./orchestration-delivery-single-flight');
const {
  findTaskCompletionBlockers,
} = require('./task-completion-intent');
const {
  createOrchestrationProofCoordinator,
} = require('./orchestration-proof-coordinator');
const {
  promptAuditFingerprint,
} = require('./prompt-audit-fingerprint');
const {
  withPromptOriginPresentation,
  backfillConfirmedCanonicalAuthoringPresentations,
} = require(path.join(__dirname, 'history-prompt-presentations'));
const {
  agentPromptAuditMatchesHash,
} = require('./agent-prompt-audit-identity');
const { compactSendReceiptPresentation } = require(path.join(srcMainDir, 'compact-send-settlement'));
const {
  RECEIPT_STATES: AGENT_SEND_RECEIPT_STATES,
  createAgentSendReceiptRegistry,
  fingerprintAgentSendRequest,
  isAgentSendProviderQueueAccepted,
} = require('./agent-send-receipt-registry');
const { applyHistoryEntryWindow } = require('./history-entry-window');
const { historyPayloadCapability, historyPayloadQuery } = require(path.join(srcMainDir, 'public-history-read'));
const {
  orchestrationRequestFingerprint,
  reservedOrchestrationTargetTabId,
} = require('./orchestration-request-identity');
const {
  assertAgentProviderModel,
  projectConfiguredAgentModels,
  projectConfiguredClaudeModels,
  resolveAgentModelRequest,
  resolveConfiguredAgentDefaultPair,
  resolveConfiguredAgentQuickPair,
  resolveAgentProvider,
} = require('./agent-provider-model-contract');
const {
  findUniqueLegacySourceFollowupProof,
} = require('./orchestration-source-reconcile');
const {
  RESULT_PROOF_CODES,
  classifyOrchestrationResultProbe,
} = require('./orchestration-result-proof');
const {
  runOrchestrationCompletionFlow,
} = require('./orchestration-completion-flow');
const {
  resolveRestorableAgentTab,
  runSingleFlight,
} = require('./agent-tab-restore');
const {
  prependSavedPromptChips,
  resolveSavedPromptRefs,
} = require('./agent-saved-prompt-refs');
const {
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_TOTAL_BYTES,
  prependContextFileChips,
  resolveContextFileRefs,
} = require('./agent-context-files');
const INBOX_PROJECT_ID = '__noted_inbox__';
const isInboxProjectId = (projectId) => projectId === INBOX_PROJECT_ID;
// Lazy-require the helpers (loaded fresh each call so missing module just
// disables the dependent endpoints, not the whole server).
let findSessionFile = null;
let parseTimelineUuids = null;
let parseTimelineEntries = null;
let getClaudeSessionMaterialization = null;
let claudeDataApi = null;
let loadCodexSessionRecords = null;
let buildCodexTimeline = null;
let listCodexModels = null;
let codexDataApi = null;
let sanitizeFileForPrompt = null;
try {
  const cd = require(path.join(__dirname, 'ipc', 'claude-data'));
  findSessionFile = cd.findSessionFile;
  parseTimelineUuids = cd.parseTimelineUuids;
  parseTimelineEntries = cd.parseTimelineEntries;
  getClaudeSessionMaterialization = cd.getSessionMaterialization;
  claudeDataApi = cd._api || null;
} catch (e) {
  console.warn('[WebServer] claude-data helpers not loaded:', e.message);
}
try {
  const codex = require(path.join(__dirname, 'ipc', 'codex-data'));
  codexDataApi = codex._api || null;
  loadCodexSessionRecords = codex._api?.loadSessionRecords || null;
  buildCodexTimeline = codex._api?.buildCodexTimeline || codex.buildCodexTimeline || null;
  listCodexModels = codex.listCodexModels || codex._api?.listCodexModels || null;
} catch (e) {
  console.warn('[WebServer] codex-data helpers not loaded:', e.message);
}
try {
  sanitizeFileForPrompt = require(path.join(__dirname, 'ipc', 'settings')).sanitizeFileForPrompt || null;
} catch (e) {
  console.warn('[WebServer] prompt file sanitizer not loaded:', e.message);
}

// Claude model list for native/web clients. Mirror of the renderer source of
// truth `src/renderer/constants/claudeLevels.ts::DEFAULT_CLAUDE_CODE_MODELS` —
// kept inline because that file is TS/renderer-only and main cannot require it.
// If Anthropic revs the list, edit both (claudeLevels.ts is canonical).
const CLAUDE_MODELS_FOR_CLIENTS = [
  { id: 'default', label: 'default' },
  { id: 'sonnet', label: 'sonnet' },
  { id: 'opus', label: 'opus' },
  { id: 'haiku', label: 'haiku' },
  { id: 'fable', label: 'fable' },
];

function configuredSettingsForProvider(projectManager, provider) {
  try {
    const key = provider === 'claude' ? 'claudeCodeSettings' : 'codexSettings';
    return projectManager?.db?.getAppState?.(key) || null;
  } catch (error) {
    console.warn('[AgentModelSelection] settings unavailable provider=' + provider
      + ' error=' + (error?.message || String(error)));
    return null;
  }
}

function configuredModelsForProvider(projectManager, provider) {
  if (provider !== 'claude') return [];
  const settings = configuredSettingsForProvider(projectManager, provider);
  return Array.isArray(settings?.models) ? settings.models : [];
}

async function projectedModelsForProvider(projectManager, provider, { strict = false } = {}) {
  const settings = configuredSettingsForProvider(projectManager, provider);
  if (provider === 'claude') {
    return projectConfiguredClaudeModels({
      configuredSettings: settings,
      fallbackModels: CLAUDE_MODELS_FOR_CLIENTS,
    });
  }
  if (!listCodexModels) {
    if (!strict) return [];
    const error = new Error('Codex model catalog is unavailable');
    error.code = 'agent_model_catalog_unavailable';
    error.statusCode = 503;
    throw error;
  }
  try {
    return projectConfiguredAgentModels({
      liveModels: await listCodexModels(),
      configuredSettings: settings,
    });
  } catch (cause) {
    if (!strict) return [];
    const error = new Error('Codex model catalog is unavailable: ' + String(cause?.message || cause));
    error.code = 'agent_model_catalog_unavailable';
    error.statusCode = 503;
    throw error;
  }
}

async function resolveProjectAgentModelRequest(projectManager, {
  provider,
  model,
  modelSelection,
} = {}) {
  const selection = resolveAgentModelRequest({
    provider,
    model,
    modelSelection,
    configuredModels: configuredModelsForProvider(projectManager, provider),
    catalogModels: String(modelSelection?.kind || '').trim().toLowerCase() === 'catalog'
      ? await projectedModelsForProvider(projectManager, provider, { strict: true })
      : undefined,
  });
  if (selection.requestedModel && (
    selection.model !== selection.requestedModel
    || !['settings-exact-id', 'catalog-selection'].includes(selection.resolution)
  )) {
    console.log('[AgentModelSelection] provider=' + provider
      + ' requested=' + selection.requestedModel
      + ' resolved=' + selection.model
      + ' source=' + selection.resolution);
  }
  return selection;
}

let WebSocketServer;
try {
  WebSocketServer = require('ws').WebSocketServer;
} catch {
  WebSocketServer = null;
}

// Preferred port. Can be overridden via env (NOTED_WEB_PORT). Default 7878
// keeps the installed app's URL stable for muscle memory. If 7878 is taken
// (typically by a sibling dev or prod instance), we walk forward to find the
// first free port in the range and publish the resolved port via the
// discovery file below — StatusBar reads it back so the QR/copy URL is always
// correct. Before this fallback, second instance silently EADDRINUSE-failed
// and mobile-web was reachable on neither end.
const PORT_PREFERRED = parseInt(process.env.NOTED_WEB_PORT || '', 10) || 7878;
const PORT_MAX = PORT_PREFERRED + 20; // 7878..7898 — plenty for parallel runs
let resolvedPort = PORT_PREFERRED;
const DISCOVERY_DIR = process.env.NOTED_DISCOVERY_DIR
  ? path.resolve(process.env.NOTED_DISCOVERY_DIR)
  : path.join(require('os').homedir(), '.noted-terminal');
const TOKEN_PATH = path.join(DISCOVERY_DIR, 'web-token.txt');
const DISCOVERY_FILE = path.join(DISCOVERY_DIR, 'web-server-' + process.pid + '.json');
const IOS_PUSH_TOKENS_PATH = path.join(DISCOVERY_DIR, 'ios-push-tokens.json');

let httpServer = null;
let wss = null;
let token = null;
let apnsJwtCache = null;
const webServerInstanceId = crypto.randomUUID();
let webServerState = 'stopped';
let webServerStartRequestedAt = null;
let webServerListeningAt = null;
let webServerStoppedAt = null;
let webServerLastRequestAt = null;
let webServerLastRequest = null;
let webServerRequestCount = 0;
let webServerLastError = null;
let webServerBindConflicts = [];

function webServerServiceHealth() {
  const listening = !!httpServer?.listening;
  return {
    name: 'noted-terminal',
    pid: process.pid,
    instanceId: webServerInstanceId,
    state: listening ? 'listening' : webServerState,
    listening,
    preferredPort: PORT_PREFERRED,
    port: listening ? resolvedPort : null,
    startRequestedAt: webServerStartRequestedAt,
    listeningAt: webServerListeningAt,
    stoppedAt: webServerStoppedAt,
    lastRequestAt: webServerLastRequestAt,
    lastRequest: webServerLastRequest,
    requestCount: webServerRequestCount,
    bindConflicts: webServerBindConflicts.slice(),
    lastError: webServerLastError,
  };
}
// Injected from main at start() — reads the live busy/running Maps (the same
// ones that drive the per-tab UI loader). Used by GET /api/active-loaders.
let computeActiveLoaders = null;
// Injected from main at start() — tiny aggregate for the native iOS project
// list badge. This is deliberately project-scoped, not a tab transcript stream:
// one SSE connection carries a full snapshot of {projectId,count,streaming}.
let computeProjectActivity = null;
// Frozen in main before renderer restore can clear wasInterrupted.
let startupInterruptedSnapshot = null;
// Mobile question answering — injected by main.start(). answerClaudeQuestion
// routes SDK (resolve parked Promise) vs PTY (drive TUI keystrokes);
// getClaudePendingQuestion reads the live pending question for the SSE snapshot.
let answerClaudeQuestion = null;
let getClaudePendingQuestion = null;
let transcriptService = null;
let publicHistoryFreshness = null;
const historyFreshnessCapability = Object.freeze({ version: 1, providers: ['claude','codex'],
  endpoint: '/api/history-freshness', maxTabs: 32, historyQuery: { freshness: 'v1' },
  event: 'history-freshness', ordering: 'epoch-sequence', outcomeCoverage: false });
let getAgentTurnResult = null;
let getAgentExecutionContext = null;
let readAgentLifecycleIdentity = null;
let readAgentRuntimeSnapshot = null;
let codexGoalActions = null;
let stopAgentProcess = null;
let readAgentParams = null;
let agentParamsService = null;
let registerTaskCompletionIntent = null;
let e2eBoundaryTestGate = null;
let agentSendBridgeTimeoutMs = 60_000;
// Main owns the agent startup/readiness state. The renderer bridge remains a
// compatibility fallback for isolated module use, but live Project API waits
// must not depend on a renderer projection arriving before the main-owned wake.
let readAgentStartReadiness = null;
// Disk-owned project prompt catalog is injected by Electron main so HTTP
// clients (GT Editor) see the exact same paths/order as the desktop picker.
let projectPromptCatalog = null;
let savedPromptService = null;
let systemPromptService = null;
const { handleSystemPromptApi } = require('./system-prompt-api');
// Main-owned Codex process/writer resolver. Renderer state and SQLite are not
// authoritative for a live rollout, so web routes fall back to this callback
// when the bridge is unavailable instead of publishing the saved resume ID.
let resolveCodexRuntimeSessionInfo = null;
let resolveCodexRuntimeProjectionBatch = null;
let readCodexNativeRewindState = null;
let recoverCodexRewindPostEnter = null;
let readCodexRewindPostEnterResult = null;
let savedHistoryOperations = null;
let inboxSavedHistoryOperations = null;
let savedHistoryIpcRegistered = false;
let conversationOwners = null;
let readAgentTabTiming = null;
let readAgentUsage = null;
let readCodexAuthProfile = null;
let releaseTimingBindingObserver = null;
const publicHistoryRevisions = new PublicHistoryRevisions();
const publicTimingSnapshots = new Map();
let tabTranscriptSubscriptions = null;

function validateSavedHistoryStop(request) {
  try {
    if (!savedHistoryOperations) throw new Error('saved_history_unavailable');
    return savedHistoryOperations.validateStop(request);
  } catch (error) { return { allowed: false, reason: error.code || error.message }; }
}

function validateSavedHistoryResume(request, event, detail) {
  if (!savedHistoryOperations) throw new Error('saved_history_unavailable');
  return savedHistoryOperations.validateResume(request, event, detail);
}

function commitSavedHistoryCodexBinding(request, commit) {
  if (!savedHistoryOperations) throw new Error('saved_history_unavailable');
  return savedHistoryOperations.commitCodexBinding(request, commit);
}
let resolveAgentToolType = null;
// tabId → Set<Sink>. A Sink is the common interface for both transports:
//   { kind:'ws'|'sse', send(str):void, isAlive():bool, close():void }
// WebSocket and SSE both register here so webBroadcast() fans out to either
// without caring which transport the client used. Yandex/Chrome anti-tracker
// extensions silently block ws:// to private IPs (deterministically observed:
// fetch 200 but WS TIMEOUT rs=0, while curl gets 101) — SSE over plain GET is
// the reliable fallback. See fact-mobile-web.md::SSE transport.
const subscribers = new Map();
const PROJECT_ACTIVITY_TOPIC = '__project_activity__';
// pending bridge requests to renderer: requestId → { resolve, reject, timer }
const pendingBridge = new Map();
const LATE_BRIDGE_REPLY_RETENTION_MS = 5 * 60 * 1000;
const externalRuns = new Map();      // runId -> run metadata
const externalRunByTabId = new Map(); // tabId -> runId
const externalRunByConversationKey = new Map(); // conversationKey -> runId
const publicRuntimeSnapshots = new Map(); // tabId -> { revision, fingerprint, snapshot }
const DEFAULT_EXTERNAL_AUTO_CLOSE_MS = 15 * 60 * 1000;
let orchestrationRunStore = null;
let scExternalResearchClient = null;
let externalResearchCoordinator = null;
// Injected from main. SQLite is the restart-safe authority for whether one
// exact Project API / Terminal MCP / Inbox operation may cross Enter. The
// in-memory registry below only joins concurrent callers and projects the
// current-process waiter; it must never recreate retry authority after restart.
let agentSendReceiptStore = null;
let agentSendQueue = null;
let sendQueueRendererReady = false;
const sendQueueRendererOwners = new Set();
let sendQueueRecoveryReady = false;
let tabMessageService = null;
let tabMessageSdkSessions = null;
let orchestrationCompletionContentStore = null;
let agentSendReceiptStartupReady = Promise.resolve({ ready: true });

function normalizePublicRuntimeStatus(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'running') return 'busy';
  if (normalized === 'resuming') return 'starting';
  return ['inactive', 'starting', 'active', 'busy', 'stopping', 'unknown'].includes(normalized)
    ? normalized
    : null;
}

function stampPublicRuntimeSnapshot(tabId, payload = {}) {
  const previous = publicRuntimeSnapshots.get(tabId) || null;
  const prior = previous?.snapshot || {};
  const incomingLaunch = payload.launchId || payload.launchGeneration || null;
  const ownerChanged = !!((incomingLaunch && prior.launchId && incomingLaunch !== prior.launchId)
    || (payload.lifecycleGeneration && prior.lifecycleGeneration && payload.lifecycleGeneration !== prior.lifecycleGeneration));
  const codexOwnerChanged = ownerChanged
    && (payload.toolType || payload.commandType || prior.toolType || prior.commandType) === 'codex';
  // A full main snapshot explicitly owns nulls too. Only partial legacy
  // events may inherit omitted fields; otherwise a cleared/replaced launch
  // is silently recombined with the previous SID/PID.
  const field = (name, fallback = null) => payload.coherent === true
    ? (Object.hasOwn(payload, name) ? payload[name] : fallback)
    : (payload[name] ?? prior[name] ?? fallback);
  const runtimeField = (name, fallback = null) => ownerChanged
    ? (Object.hasOwn(payload, name) ? payload[name] : fallback) : field(name, fallback);
  // Additive fields use explicit null as a clear even on partial events.
  // Legacy SID/null semantics remain unchanged above.
  const observedField = (name, fallback = null) => Object.hasOwn(payload, name)
    ? payload[name] : ownerChanged || payload.coherent === true ? fallback : prior[name] ?? fallback;
  const type = payload.type || 'snapshot';
  const explicitStatus = normalizePublicRuntimeStatus(payload.sessionStatus)
    || normalizePublicRuntimeStatus(payload.status);
  let sessionStatus = explicitStatus || prior.sessionStatus || 'unknown';
  if (!explicitStatus && type === 'busy') {
    sessionStatus = payload.busy === true ? 'busy' : (prior.sessionStatus === 'stopping' ? 'stopping' : 'active');
  } else if (!explicitStatus && type === 'done') {
    sessionStatus = prior.sessionStatus === 'stopping' ? 'stopping' : 'active';
  }
  const turnBusy = typeof payload.turnBusy === 'boolean'
    ? payload.turnBusy
    : typeof payload.busy === 'boolean'
      ? payload.busy
      : sessionStatus === 'busy';
  const lifecycleGeneration = field('lifecycleGeneration');
  const sessionId = codexOwnerChanged ? (Object.hasOwn(payload, 'sessionId') ? payload.sessionId : null) : field('sessionId');
  const readSessionId = payload.coherent === true || codexOwnerChanged ? (payload.readSessionId ?? payload.codexReadSessionId ?? null) : (payload.readSessionId
    ?? payload.codexReadSessionId
    ?? prior.readSessionId
    ?? prior.codexReadSessionId
    ?? null);
  const snapshot = {
    ...(Object.hasOwn(payload, 'conversationOwner') ? { conversationOwner: payload.conversationOwner }
      : conversationOwners ? { conversationOwner: conversationOwners.current(tabId) } : {}),
    launchId: incomingLaunch || runtimeField('launchId'),
    startupDefaultsRevision: runtimeField('startupDefaultsRevision'),
    startupDefaultsAttemptId: runtimeField('startupDefaultsAttemptId'),
    sessionStatus,
    inputReady: typeof payload.inputReady === 'boolean' ? payload.inputReady : (!ownerChanged && prior.inputReady === true),
    turnBusy,
    sessionId,
    readSessionId,
    codexReadSessionId: readSessionId,
    writerSessionId: runtimeField('writerSessionId'),
    writerConfirmed: runtimeField('writerConfirmed'),
    writerUsableForMutation: runtimeField('writerUsableForMutation'),
    processStatus: runtimeField('processStatus'), processPid: runtimeField('processPid'),
    terminalRunSeq: runtimeField('terminalRunSeq'), inputRevision: runtimeField('inputRevision'),
    lifecycleGeneration,
    commandType: field('commandType'),
    toolType: field('toolType'),
    model: observedField('model'), effort: observedField('effort'),
    liveSettings: observedField('liveSettings'), runtimePolicy: observedField('runtimePolicy'),
    manualActionRequired: observedField('manualActionRequired', false),
    manualActionType: observedField('manualActionType'),
  };
  const fingerprint = fingerprintAgentSendRequest({ ...snapshot,
    // Animation advances frameSeq without changing the observed model.
    liveSettings: snapshot.liveSettings ? { model: snapshot.liveSettings.model, effort: snapshot.liveSettings.effort,
      ownerId: snapshot.liveSettings.ownerId, proofAt: snapshot.liveSettings.proofAt } : null,
  });
  const revision = previous && previous.fingerprint === fingerprint
    ? previous.revision
    : Number(previous?.revision || 0) + 1;
  publicRuntimeSnapshots.set(tabId, { revision, fingerprint, snapshot });
  return {
    ...payload,
    ...snapshot,
    status: sessionStatus,
    busy: turnBusy,
    starting: sessionStatus === 'starting',
    stopping: sessionStatus === 'stopping',
    runtimeRevision: revision,
    runtimeObservedAt: Date.now(),
  };
}
const orchestrationCompletionInflight = new Map();
const orchestrationCompletionTrailing = new Set();
const orchestrationNotificationInflight = new Set();
const orchestrationAutoStopInflight = new Set();
const orchestrationDeliverySingleFlight = createOrchestrationDeliverySingleFlight({
  onEvent(event, detail) {
    console.log('[OrchestrationDeliveryWake] event=' + event
      + ' run=' + String(detail?.runId || '-').slice(0, 12)
      + ' reason=' + String(detail?.request?.reason || '-')
      + ' status=' + String(detail?.request?.targetStatus?.status
        || detail?.request?.targetStatus?.sessionStatus
        || '-'));
  },
});
const closedAgentRestoreInflight = new Map();
const agentSendReceiptRegistry = createAgentSendReceiptRegistry({
  onEvict(detail) {
    console.warn('[AgentSendReceipt] evict tab=' + shortId(detail?.tabId, 12)
      + ' handoff=' + String(detail?.handoffId || '-').slice(0, 32)
      + ' state=' + (detail?.state || '-')
      + ' reason=' + (detail?.reason || '-'));
  },
});
let orchestrationPolicyTimer = null;
const ORCHESTRATION_RESULT_PROOF_FLUSH_GRACE_MS = 60_000;
let orchestrationResultProofCoordinator = null;
let orchestrationSourceProofCoordinator = null;

function getOrchestrationRunStore() {
  if (!orchestrationRunStore) {
    orchestrationRunStore = new OrchestrationRunStore(path.join(app.getPath('userData'), 'orchestration-runs.json'));
  }
  return orchestrationRunStore;
}

function getCompletionContentStore() {
  if (!orchestrationCompletionContentStore) {
    orchestrationCompletionContentStore = new CompletionContentStore({
      db: require(path.join(srcMainDir, 'project-manager')).db.db,
    });
  }
  return orchestrationCompletionContentStore;
}

async function prepareOrchestrationCompletionContent(run) {
  const snapshots = getCompletionContentStore();
  const frozen = snapshots.get(run.runId);
  if (frozen) return frozen;
  // A pre-upgrade handoff may already be in the provider queue. Its payload
  // must remain the original legacy notification through every retry.
  if (run.notificationAttemptedAt || run.notificationPromptHash || run.notificationAttempt) return null;
  if (!run.sourceSendTarget && !run.sourceSessionId && !run.sourceExecutionContext?.sessionId) return null;
  const resultAttempt = captureOrchestrationResultAttempt(run);
  let result;
  if (run.status !== 'completed') {
    result = { runId: run.runId, success: false, error: run.error || run.resultError || run.outcome };
  } else if (isExternalResearchRun(run)) {
    const read = await readExternalResearchResult(run.runId, MAX_INLINE_ASSISTANT_CHARS);
    if (read.statusCode !== 200 || read.body?.ready !== true || read.body?.success !== true) {
      throw Object.assign(new Error(read.body?.error || 'external_research_result_not_ready'), {
        code: read.body?.code || 'external_research_result_not_ready',
      });
    }
    result = read.body;
  } else {
    result = await probeOrchestrationResult(run, { maxChars: MAX_INLINE_ASSISTANT_CHARS,
      forceFresh: true, resultReadMode: 'source-proof', resultAttempt });
    if (!isCompleteOrchestrationResult(result)) {
      throw Object.assign(new Error(result.error || 'orchestration_result_not_ready'), {
        code: result.errorCode || 'orchestration_result_not_ready',
      });
    }
  }
  const current = await getOrchestrationRunStore().getInternal(run.runId);
  if (!current || current.status !== run.status || current.completedAt !== run.completedAt
    || current.notificationSuppressed || current.notificationCancelRequestedAt
    || (!isExternalResearchRun(run) && !orchestrationResultAttemptMatches(current, resultAttempt))) {
    throw Object.assign(new Error('orchestration_completion_changed_during_read'), {
      code: 'orchestration_completion_changed_during_read',
    });
  }
  const content = snapshots.freeze(buildOrchestrationCompletionContent(current, result, {
    baseUrl: 'http://127.0.0.1:' + resolvedPort,
  }));
  console.log('[OrchestrationContent] frozen run=' + run.runId + ' mode=' + content.mode
    + ' chars=' + content.assistantChars + ' promptChars=' + content.prompt.length
    + ' hash=' + content.promptHash + ' source=' + run.sourceTabId);
  return content;
}

async function resolveTabMessageIdentity(tabId) {
  const descriptor = findOrchestrationTabDescriptor(tabId);
  if (!descriptor) return null;
  if (descriptor.tabType === 'claude-sdk') {
    const sessionId = tabMessageSdkSessions?.get(tabId)?.sessionId || descriptor.sessionId;
    if (!sessionId) throw identityUnavailable();
    return { ...descriptor, provider: 'claude', sessionId, sendTarget: { toolType: 'claude', sessionId } };
  }
  if (typeof readAgentRuntimeSnapshot !== 'function') throw identityUnavailable();
  return messageRuntimeIdentity(descriptor, await readAgentRuntimeSnapshot(tabId));
}

async function readScenarioDestination(tabId) {
  const descriptor = findOrchestrationTabDescriptor(tabId);
  if (descriptor?.tabType === 'claude-sdk') return (await resolveTabMessageIdentity(tabId)).sendTarget;
  if (typeof readAgentRuntimeSnapshot !== 'function') return descriptor;
  return scenarioDestination(await readAgentRuntimeSnapshot(tabId));
}

async function captureOrchestrationSourceTarget(source, priorRun, expectedExecution = null) {
  if (priorRun) return priorRun.sourceSendTarget || null;
  const identity = await resolveTabMessageIdentity(source.tabId);
  if (!identity) throw identityUnavailable('orchestration_source_tab_unavailable');
  if (expectedExecution && (expectedExecution.provider !== identity.provider
    || (expectedExecution.sessionId && expectedExecution.sessionId !== identity.sessionId
      && expectedExecution.sessionId !== identity.acceptedResumeSourceSessionId))) {
    throw identityUnavailable('orchestration_source_changed_during_reservation');
  }
  return identity.sendTarget;
}

function emitTabMessage(message, reason) {
  const payload = { type: 'tab-message-update', message: compactTabMessage(message), reason };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('tab-messages:changed', payload);
  }
  for (const tabId of new Set([message.sourceTabId, message.targetTabId])) webBroadcast(tabId, payload);
}

function getTabMessageService() {
  if (!tabMessageService) {
    tabMessageService = new TabMessageService({
      db: require(path.join(srcMainDir, 'project-manager')).db.db,
      resolveTab: resolveTabMessageIdentity,
      getReceipt: operationKey => agentSendReceiptStore?.get(operationKey) || null,
      receiptRequiredBeforeSend: true,
      releaseReceipt: operationKey => agentSendReceiptStore?.unpinForOwner(operationKey, 'tab-message'),
      send: sendTabMessage,
      onChanged: emitTabMessage,
      log: (event, detail) => console.log('[TabMessages] ' + event + ' ' + JSON.stringify(detail)),
    });
  }
  return tabMessageService;
}

async function sendTabMessage(message) {
  await agentSendReceiptStartupReady;
  if (!agentSendReceiptStore) throw Object.assign(new Error('message_receipt_store_unavailable'), { submitted: false });
  // Receipt absence proves no send only while pruning cannot remove the
  // evidence between physical submission and the message's durable sent state.
  agentSendReceiptStore.pinForOwner(message.operationKey, 'tab-message');
  const service = getTabMessageService();
  const status = await resolveAgentSessionInfo(message.targetTabId, 2000);
  const expectedTarget = { toolType: message.targetProvider, sessionId: message.targetSessionId };
  const source = 'tab-message:' + message.messageId;
  const question = message.replyTo ? service.getMessage(message.replyTo)?.message : null;
  const rawPrompt = formatTabMessagePrompt(message, question);
  let prompt = message.preparedPrompt || message.prompt;
  if (!message.preparedPrompt) {
    prompt = tabWorkContext
      ? (await tabWorkContext.prepare(message.targetTabId, message.handoffId, prompt)).prompt
      : prompt;
    service.updateFrozenPrompt(message.messageId, prompt);
  }
  const result = await runAgentSendScenario({
    tabId: message.targetTabId, prompt, workContextPrepared: true,
    handoffId: message.handoffId, source,
    statusAtSend: status?.status || 'unknown', queue: true, ownership: 'project',
    provider: message.targetProvider, sessionId: message.targetSessionId,
    expectedTarget, cwd: message.targetCwd,
    sendOperationKey: message.operationKey, sendSurface: 'tab-message',
    presentationSnapshot: { semanticTags: [{ kind: 'tab-message',
      messageId: message.messageId, replyTo: message.replyTo || null, phase: message.kind,
      ...(prompt.endsWith(rawPrompt) ? { envelopeStart: prompt.length - rawPrompt.length } : {}),
      envelopeText: rawPrompt.slice(0, rawPrompt.length - message.text.length),
      bodyProjectionHash: crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
      bodyStart: prompt.length - message.text.length, bodyEnd: prompt.length,
      sourceTabId: message.sourceTabId, sourceTabName: message.sourceTabName,
      sourceProjectId: message.sourceProjectId, targetTabId: message.targetTabId,
      targetTabName: message.targetTabName, targetProjectId: message.targetProjectId,
    }] },
    onLateReceipt: () => service.reconcileReceipts(message.targetTabId, 'late-receipt'),
  });
  return result;
}

function getScExternalResearchClient() {
  if (!scExternalResearchClient) scExternalResearchClient = new ScExternalResearchClient();
  return scExternalResearchClient;
}

function getExternalResearchCoordinator() {
  if (!externalResearchCoordinator) {
    externalResearchCoordinator = new ExternalResearchCoordinator({
      store: getOrchestrationRunStore(),
      client: getScExternalResearchClient(),
      emitChanges: emitOrchestrationChanges,
      finalizeSettled: finalizeSettledOrchestration,
    });
  }
  return externalResearchCoordinator;
}

function ensureOrchestrationProofCoordinators() {
  if (!transcriptService) return false;
  // Capture the service instance. stop() intentionally nulls the global
  // reference while coordinator unsubscribe work may still be draining.
  const proofTranscriptService = transcriptService;
  if (!orchestrationResultProofCoordinator) {
    orchestrationResultProofCoordinator = createOrchestrationProofCoordinator({
      label: 'result',
      subscribe: (payload) => proofTranscriptService.subscribe(payload),
      unsubscribe: (payload) => proofTranscriptService.unsubscribe(payload),
      onWake: async (runId, meta) => {
        console.log('[OrchestrationResultProof] wake run=' + runId
          + ' session=' + String(meta?.sessionId || '').slice(0, 8)
          + ' version=' + (meta?.version ?? '-')
          + ' size=' + (meta?.size ?? '-'));
        const run = await getOrchestrationRunStore().getInternal(runId);
        if (!run) return;
        if (isActiveStatus(run.status)) {
          await reconcileOrchestrationRun(runId, 'target-transcript-changed');
        } else {
          await finalizeSettledOrchestration(run, 'target-transcript-changed');
        }
      },
    });
  }
  if (!orchestrationSourceProofCoordinator) {
    orchestrationSourceProofCoordinator = createOrchestrationProofCoordinator({
      label: 'source-followup',
      subscribe: (payload) => proofTranscriptService.subscribe(payload),
      unsubscribe: (payload) => proofTranscriptService.unsubscribe(payload),
      onWake: async (runId, meta) => {
        console.log('[OrchestrationSourceProof] wake run=' + runId
          + ' session=' + String(meta?.sessionId || '').slice(0, 8)
          + ' version=' + (meta?.version ?? '-')
          + ' size=' + (meta?.size ?? '-'));
        const run = await getOrchestrationRunStore().getInternal(runId);
        if (run) await reconcileOrchestrationSourceFollowup(run, 'source-transcript-changed');
      },
    });
  }
  return true;
}

async function armOrchestrationResultProof(run, probe = {}) {
  if (!run?.runId || !ensureOrchestrationProofCoordinators()) {
    return { success: false, error: 'transcript-service-unavailable' };
  }
  const sessionId = probe.sessionId || run.sessionId || null;
  return orchestrationResultProofCoordinator.arm({
    runId: run.runId,
    toolType: run.targetToolType,
    sessionId,
    cwd: run.targetCwd || run.targetProjectPath || null,
  });
}

async function releaseOrchestrationResultProof(runId, reason) {
  return orchestrationResultProofCoordinator?.release(runId, reason) || false;
}

async function armOrchestrationSourceProof(run, sourceInfo = null) {
  if (!run?.runId || !ensureOrchestrationProofCoordinators()) {
    return { success: false, error: 'transcript-service-unavailable' };
  }
  const sessionId = run.notificationSourceSessionId || sourceInfo?.sessionId || null;
  const toolType = sourceInfo?.toolType || sourceInfo?.commandType || null;
  if (!sessionId || (toolType !== 'claude' && toolType !== 'codex')) {
    return { success: false, error: 'source-transcript-identity-unresolved' };
  }
  return orchestrationSourceProofCoordinator.arm({
    runId: run.runId,
    toolType,
    sessionId,
    cwd: sourceInfo?.cwd || run.sourceProjectPath || null,
  });
}

async function releaseOrchestrationSourceProof(runId, reason) {
  return orchestrationSourceProofCoordinator?.release(runId, reason) || false;
}

function notifyAgentTranscriptChanged(meta = {}) {
  const resultWakes = orchestrationResultProofCoordinator?.handleTranscriptChanged(meta) || 0;
  const sourceWakes = orchestrationSourceProofCoordinator?.handleTranscriptChanged(meta) || 0;
  return { resultWakes, sourceWakes };
}

function shortId(value, len = 8) {
  const s = value == null ? '' : String(value);
  return s ? s.slice(-len) : 'nil';
}

function bridgePayloadLabel(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = [];
  if (payload.tabId) parts.push('tab=' + shortId(payload.tabId, 12));
  if (payload.projectId) parts.push('project=' + shortId(payload.projectId, 12));
  if (payload.targetIndex != null) parts.push('targetIndex=' + payload.targetIndex);
  if (payload.mode) parts.push('mode=' + payload.mode);
  return parts.length ? ' ' + parts.join(' ') : '';
}

function startRoutePendingLog(prefix, startedAt, afterMs = 10_000) {
  const timer = setTimeout(() => {
    console.log(prefix + ' STILL_PENDING ms=' + (Date.now() - startedAt));
  }, afterMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

function cleanOptionalString(value, fallback = '') {
  const s = value == null ? '' : String(value).trim();
  return s || fallback;
}

function claudeMaterializationFor(sessionId, cwd) {
  if (!sessionId || !getClaudeSessionMaterialization) {
    return {
      materialized: false,
      conversationMaterialized: false,
      timelineCount: sessionId ? null : 0,
      fileFound: false,
      reason: sessionId ? 'materialization-helper-unavailable' : 'no-session-id',
    };
  }
  try {
    const result = getClaudeSessionMaterialization(sessionId, cwd);
    return {
      ...result,
      materialized: result?.materialized === true,
      conversationMaterialized: result?.materialized === true,
      timelineCount: typeof result?.timelineCount === 'number' ? result.timelineCount : null,
    };
  } catch (e) {
    return {
      materialized: false,
      conversationMaterialized: false,
      timelineCount: null,
      fileFound: false,
      reason: 'materialization-check-failed',
      error: String(e?.message || e),
    };
  }
}

const MOBILE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const MOBILE_ATTACHMENT_PREVIEW_MAX_BYTES = 12 * 1024 * 1024;
const mobileAttachmentIndex = new Map();
let mobileAttachmentAssetStore = null;

function mobileAttachmentRoot() {
  return path.join(app.getPath('temp'), 'noted-terminal-mobile-attachments');
}

function sanitizeMobileAttachmentName(name, fallback = 'attachment') {
  const raw = String(name || fallback).trim() || fallback;
  return raw
    .replace(/[\/\\:\0]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 160) || fallback;
}

function normalizeMobileAttachmentKind(kind, mimeType) {
  const k = String(kind || '').toLowerCase();
  if (k === 'image' || k === 'file') return k;
  return String(mimeType || '').startsWith('image/') ? 'image' : 'file';
}

function inferMobileAttachmentMimeType(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.heic' || ext === '.heif') return 'image/heic';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.txt' || ext === '.md') return 'text/plain';
  return fallback;
}

function safeMobileAttachmentPath(id, name) {
  const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  return path.join(mobileAttachmentRoot(), safeId, sanitizeMobileAttachmentName(name));
}

async function removeMobileAttachment(id) {
  const cleanId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanId) return false;
  const known = mobileAttachmentIndex.get(cleanId);
  const dir = known?.dir || path.join(mobileAttachmentRoot(), cleanId);
  await fs.promises.rm(dir, { recursive: true, force: true });
  mobileAttachmentIndex.delete(cleanId);
  return true;
}

async function cleanupMobileAttachments() {
  const root = mobileAttachmentRoot();
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = path.join(root, entry.name);
        try {
          const stat = await fs.promises.stat(dir);
          if (stat.mtimeMs < cutoff) await fs.promises.rm(dir, { recursive: true, force: true });
        } catch {}
      }));
  } catch {}
}

async function storeMobileAttachment(payload) {
  const name = sanitizeMobileAttachmentName(payload?.name, payload?.kind === 'image' ? 'image.jpg' : 'attachment');
  const mimeType = cleanOptionalString(payload?.mimeType, 'application/octet-stream');
  const kind = normalizeMobileAttachmentKind(payload?.kind, mimeType);
  const dataBase64 = typeof payload?.dataBase64 === 'string' ? payload.dataBase64 : '';
  if (!dataBase64) {
    const err = new Error('dataBase64 required');
    err.statusCode = 400;
    throw err;
  }
  const estimatedBytes = Math.floor((dataBase64.length * 3) / 4);
  if (estimatedBytes > MOBILE_ATTACHMENT_MAX_BYTES) {
    const err = new Error('attachment too large');
    err.statusCode = 413;
    throw err;
  }
  const buffer = Buffer.from(dataBase64, 'base64');
  if (!buffer.length || buffer.length > MOBILE_ATTACHMENT_MAX_BYTES) {
    const err = new Error('attachment too large');
    err.statusCode = 413;
    throw err;
  }
  const id = crypto.randomUUID();
  const dir = path.join(mobileAttachmentRoot(), id);
  const filePath = safeMobileAttachmentPath(id, name);
  if (!filePath) {
    const err = new Error('invalid attachment id');
    err.statusCode = 500;
    throw err;
  }
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(filePath, buffer);
  const item = { id, kind, name, mimeType, size: buffer.length, path: filePath, dir, createdAt: Date.now() };
  mobileAttachmentIndex.set(id, item);
  // Sent chat history keeps preview references to this Mac-local file. Do not
  // age-clean uploads here; explicit composer removal is the only immediate
  // delete path.
  return item;
}

function sendAttachmentError(code, message, statusCode = 400) {
  const error = new Error(message || code);
  error.code = code;
  error.statusCode = statusCode;
  error.submitted = false;
  error.pasteWritten = false;
  error.enterWritten = false;
  return error;
}

function findOwnedMobileUpload(sourcePath, assetId = null) {
  if (typeof agentSendQueue === 'undefined' || !agentSendQueue) return null;
  const exact = agentSendQueue.ownedUploadRef(sourcePath, assetId);
  if (exact) return exact;
  const root = path.resolve(mobileAttachmentRoot());
  let physicalRoot = root;
  try { physicalRoot = fs.realpathSync(root); } catch {}
  const candidate = path.resolve(sourcePath);
  const prefix = [root, physicalRoot].find(base => candidate.startsWith(base + path.sep));
  if (!prefix) return null;
  const parts = path.relative(prefix, candidate).split(path.sep);
  if (parts.length !== 2) return null;
  return agentSendQueue.ownedUploadRef(null, assetId, parts.join('/'));
}

function normalizeSendAttachments(attachments, { strict = false } = {}) {
  if (attachments == null) return [];
  if (!Array.isArray(attachments)) {
    if (strict) throw sendAttachmentError('attachments_invalid', 'attachments must be an array');
    return [];
  }
  const root = mobileAttachmentRoot();
  const normalized = [];
  for (const item of attachments) {
    if (!item || typeof item !== 'object') {
      if (strict) throw sendAttachmentError('attachment_invalid', 'attachment must be an object');
      continue;
    }
    const requestedKind = String(item.kind || '').toLowerCase();
    if (strict && requestedKind && !['image', 'file'].includes(requestedKind)) {
      throw sendAttachmentError('unsupported_attachment_kind', 'attachment kind must be image or file');
    }
    const id = typeof item?.id === 'string' ? item.id : '';
    const known = id ? mobileAttachmentIndex.get(id) : null;
    const rawPath = String(item?.path || item?.filePath || known?.path || '').trim();
    if (!rawPath || !path.isAbsolute(rawPath)) {
      if (strict) throw sendAttachmentError('attachment_path_invalid', 'absolute managed attachment path required');
      continue;
    }
    const resolved = path.resolve(rawPath);
    const retained = typeof findOwnedMobileUpload === 'function' ? findOwnedMobileUpload(rawPath, item.assetId || null) : null;
    if (!retained && !resolved.startsWith(path.resolve(root) + path.sep)
      && !(strict && (() => { try { return resolved.startsWith(fs.realpathSync(root) + path.sep); } catch { return false; } })())) {
      if (strict) throw sendAttachmentError('attachment_path_outside_owner', 'attachment path is outside the managed upload root', 403);
      continue;
    }
    if (!retained && !fs.existsSync(resolved)) {
      if (strict) throw sendAttachmentError('attachment_missing', 'uploaded attachment is no longer available', 410);
      continue;
    }
    const name = sanitizeMobileAttachmentName(item?.name || known?.name || path.basename(resolved));
    const mimeType = cleanOptionalString(item?.mimeType || known?.mimeType, 'application/octet-stream');
    const kind = normalizeMobileAttachmentKind(item?.kind || known?.kind, mimeType);
    const size = Number(item?.size || known?.size || 0) || 0;
    normalized.push({ id, kind, name, mimeType, size, path: resolved,
      ...(typeof item.assetId === 'string' && item.assetId ? { assetId: item.assetId } : {}) });
  }
  return normalized;
}

async function readMobileAttachmentPreview(payload) {
  const rawPath = String(payload?.path || payload?.filePath || '').trim();
  if (!rawPath || !path.isAbsolute(rawPath)) {
    const err = new Error('absolute attachment path required');
    err.statusCode = 400;
    throw err;
  }
  const owned = typeof findOwnedMobileUpload === 'function' ? findOwnedMobileUpload(rawPath, payload?.assetId || null) : null;
  if (owned?.ambiguous) throw sendAttachmentError('attachment_upload_identity_ambiguous', 'assetId is required for this captured upload', 409);
  if (payload?.assetId && !owned) throw sendAttachmentError('attachment_upload_identity_mismatch', 'assetId does not belong to this upload path', 403);
  if (owned && mobileAttachmentAssetStore) {
    let materialized;
    try { materialized = await mobileAttachmentAssetStore.verifyOwnedRef(owned, { touch: true }); }
    catch { throw sendAttachmentError('attachment_missing', 'owned attachment is no longer available', 410); }
    const result = { id: owned.uploadId, kind: owned.kind, name: owned.name,
      mimeType: owned.mediaType, size: owned.size, path: owned.sourcePath,
      sourcePath: owned.sourcePath, assetId: owned.assetId };
    if (owned.kind === 'image' && owned.size <= MOBILE_ATTACHMENT_PREVIEW_MAX_BYTES) {
      result.dataBase64 = (await fs.promises.readFile(materialized.path)).toString('base64');
    }
    return result;
  }
  const root = path.resolve(mobileAttachmentRoot());
  const resolved = path.resolve(rawPath);
  if (!resolved.startsWith(root + path.sep)) {
    const err = new Error('attachment path outside mobile temp root');
    err.statusCode = 403;
    throw err;
  }
  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw sendAttachmentError('attachment_missing', 'uploaded attachment is no longer available', 410);
    }
    throw error;
  }
  if (!stat.isFile()) {
    const err = new Error('attachment path is not a file');
    err.statusCode = 400;
    throw err;
  }
  const rel = path.relative(root, resolved);
  const id = rel.split(path.sep)[0] || '';
  const known = id ? mobileAttachmentIndex.get(id) : null;
  const mimeType = cleanOptionalString(known?.mimeType, inferMobileAttachmentMimeType(resolved));
  const kind = normalizeMobileAttachmentKind(known?.kind, mimeType);
  const result = {
    id,
    kind,
    name: sanitizeMobileAttachmentName(known?.name || path.basename(resolved)),
    mimeType,
    size: stat.size,
    path: resolved,
  };
  if (kind === 'image' && stat.size <= MOBILE_ATTACHMENT_PREVIEW_MAX_BYTES) {
    const buffer = await fs.promises.readFile(resolved);
    result.dataBase64 = buffer.toString('base64');
  }
  return result;
}

function appendAttachmentsToPrompt(prompt, attachments, { strict = false, includeFileRanges = false } = {}) {
  const cleanPrompt = String(prompt || '').trim();
  const normalized = normalizeSendAttachments(attachments, { strict });
  if (!normalized.length) return { prompt: cleanPrompt, attachments: [] };
  const remainingMarkers = new Map();
  const prefixImageBindings = [], bodyImageBindings = [];
  const imageMarkers = normalized
    .filter((attachment) => attachment.kind === 'image')
    .filter((attachment) => {
      const marker = '[imagePath: ' + attachment.path + ']';
      if (!includeFileRanges) return !cleanPrompt.includes(marker);
      const next = remainingMarkers.get(marker) || 0;
      const at = cleanPrompt.indexOf(marker, next);
      const binding = { refIndex: normalized.indexOf(attachment), marker };
      if (at >= 0) {
        remainingMarkers.set(marker, at + marker.length);
        bodyImageBindings.push({ ...binding, start: at }); return false;
      }
      prefixImageBindings.push(binding);
      return true;
    }).map(attachment => '[imagePath: ' + attachment.path + ']');
  const lines = normalized.filter((attachment) => attachment.kind !== 'image').map((att) => {
    const sizePart = att.size ? ', ' + Math.ceil(att.size / 1024) + ' KB' : '';
    const meta = [att.kind, att.mimeType].filter(Boolean).join(', ');
    return '- [' + (meta || 'file') + '] ' + att.name + ': ' + att.path + sizePart;
  });
  const attachmentBlock = [
    'Attached files from iOS are already uploaded to this Mac. Read them from these local paths if relevant:',
    ...lines,
  ].filter((line, index) => index === 0 ? lines.length > 0 : true).join('\n');
  const withRanges = result => {
    if (!includeFileRanges) return result;
    const fileRanges = [];
    let prefixAt = 0;
    const imageRanges = prefixImageBindings.map(binding => {
      const range = { start: prefixAt, end: prefixAt + binding.marker.length, refIndex: binding.refIndex };
      prefixAt += binding.marker.length + 2; return range;
    });
    for (const binding of bodyImageBindings) imageRanges.push({
      start: prefixAt + binding.start, end: prefixAt + binding.start + binding.marker.length, refIndex: binding.refIndex,
    });
    let after = result.prompt.indexOf('Attached files from iOS are already uploaded to this Mac');
    for (const [index, att] of normalized.filter(item => item.kind === 'file').entries()) {
      const line = lines[index];
      let at = result.prompt.indexOf(line, Math.max(0, after));
      if (at < 0) {
        at = result.prompt.length + 1;
        result.prompt += '\n' + line;
      }
      const start = at + line.indexOf(att.path);
      fileRanges.push({ start, end: start + att.path.length, sourcePath: att.path, line,
        refIndex: normalized.indexOf(att) });
      after = at + line.length;
    }
    return { ...result, fileRanges, imageRanges };
  };
  if (cleanPrompt.includes('Attached files from iOS are already uploaded to this Mac')) {
    return withRanges({
      prompt: [...imageMarkers, cleanPrompt].filter(Boolean).join('\n\n'),
      attachments: normalized,
    });
  }
  return withRanges({
    prompt: [...imageMarkers, cleanPrompt, attachmentBlock].filter(Boolean).join('\n\n'),
    attachments: normalized,
  });
}

function inboxAttachmentPresentationSnapshot(snapshot, attachments) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const imagePaths = (Array.isArray(attachments) ? attachments : [])
    .filter((attachment) => attachment?.kind === 'image' && path.isAbsolute(String(attachment.path || '')))
    .map((attachment, index) => ({
      id: index + 1,
      path: attachment.path,
      mediaType: String(attachment.mimeType || ''),
      size: Number(attachment.size || 0) || 0,
      availability: 'available',
    }));
  const promptChips = Array.isArray(source.promptChips) ? source.promptChips : [];
  const semanticTags = Array.isArray(source.semanticTags) ? source.semanticTags : [];
  return promptChips.length || semanticTags.length || imagePaths.length
    ? { promptChips, semanticTags, imagePaths }
    : null;
}

async function prepareMobileSendOwnership({ tabId, handoffId, operationKey, requestFingerprint,
  prompt, attachments, fileRanges, imageRanges = [], presentationSnapshot }) {
  if (!mobileAttachmentAssetStore || !agentSendQueue) return null;
  const root = path.resolve(mobileAttachmentRoot());
  const physicalRoot = await fs.promises.realpath(root).catch(() => root);
  const isUpload = sourcePath => [root, physicalRoot].some(base => String(sourcePath).startsWith(base + path.sep));
  const candidates = [...(attachments || [])];
  const declaredImages = presentationSnapshot?.authoringTransport ? presentationSnapshot.imagePaths : null;
  // Reuse the SAME image grammar as physical Send. A plain local/GT path is
  // not import authority. Legacy mobile image markers already name upload refs.
  const images = buildCodexImagePastePlan(prompt, sourcePath => ({
    success: true, path: sourcePath, inputPath: sourcePath,
  }), { authoringTransport: presentationSnapshot?.authoringTransport || null, includeSourceRanges: true });
  const imageParts = images.segments.filter(segment => segment.kind === 'image');
  if (declaredImages && declaredImages.length !== imageParts.length) {
    throw sendAttachmentError('attachment_authoring_changed', 'image occurrence proof changed', 409);
  }
  const imageRefIndexes = [];
  for (const [index, part] of imageParts.entries()) {
    const declared = declaredImages?.[index];
    if (declared && declared.path !== part.sourcePath) throw sendAttachmentError('attachment_authoring_changed', 'image occurrence path changed', 409);
    if (!isUpload(part.sourcePath)) { imageRefIndexes.push(-1); continue; }
    const formatted = !declaredImages && imageRanges.find(range => range.start === part.sourceRange.start && range.end === part.sourceRange.end);
    let refIndex = formatted ? formatted.refIndex : candidates.findIndex(ref => ref.path === part.sourcePath && ref.kind === 'image'
      && (!declared || (ref.assetId || null) === (declared.assetId || null)));
    if (refIndex < 0) {
      refIndex = candidates.length;
      candidates.push({ path: part.sourcePath, kind: 'image', name: path.basename(part.sourcePath),
        mimeType: declared?.mediaType || inferMobileAttachmentMimeType(part.sourcePath), id: '',
        ...(declared?.assetId ? { assetId: declared.assetId } : {}) });
    }
    imageRefIndexes.push(refIndex);
  }
  if (!candidates.length) return null;
  const retained = await importMobileUploads({ rootDir: root, attachments: candidates, assetStore: mobileAttachmentAssetStore,
    resolveRetained: findOwnedMobileUpload });
  try {
    const snapshot = createOwnedAttachmentSnapshot({ tabId, handoffId, operationKey,
      requestFingerprint, prompt, refs: retained.refs, fileRanges: fileRanges || [],
      imageRefIndexes,
      authoringTransport: presentationSnapshot?.authoringTransport || null });
    const imagePaths = snapshot.ranges.filter(range => snapshot.refs[range.refIndex].kind === 'image')
      .map((range, index) => { const ref = snapshot.refs[range.refIndex]; return {
        id: index + 1, path: ref.sourcePath, assetId: ref.assetId,
        mediaType: ref.mediaType, size: ref.size, availability: 'available',
      }; });
    // Existing authored refs (including non-mobile images) stay ordered; only
    // their proven upload asset metadata is enriched.
    const oldRefs = presentationSnapshot?.imagePaths;
    const presentedImages = Array.isArray(oldRefs) && oldRefs.length
      ? oldRefs.map((ref, index) => { const owned = declaredImages ? snapshot.refs[imageRefIndexes[index]]
        : snapshot.refs.find(value => value.kind === 'image' && value.sourcePath === ref.path && (!ref.assetId || value.assetId === ref.assetId));
        return owned ? { ...ref, assetId: owned.assetId, size: owned.size } : ref; })
      : imagePaths;
    return { snapshot, release: retained.release,
      presentationSnapshot: { ...(presentationSnapshot || {}), imagePaths: presentedImages } };
  } catch (error) { retained.release(); throw error; }
}

async function resolveInboxAttachmentPrompt(prompt, attachments) {
  // The upload owner reads documents at the same preparation boundary as
  // Project API context files. A path hint is not delivery of file contents.
  const contextFiles = await resolveContextFileRefs({
    refs: attachments.filter(item => item.kind === 'file')
      .map(item => ({ path: item.path, label: item.name, role: 'source' })),
  });
  const images = appendAttachmentsToPrompt(
    prependContextFileChips(prompt, contextFiles),
    attachments.filter(item => item.kind === 'image'),
    { strict: true },
  );
  return {
    prompt: images.prompt,
    attachments,
    contextFiles: contextFiles.map(file => ({
      path: file.filePath, role: file.role, sha256: file.sha256, bytes: file.bytes,
    })),
  };
}

async function resolveSavedPromptText(prompt, prompts = []) {
  const composed = await resolveSavedPromptComposition(prompt, prompts, async (item) => {
    const parts = [];
    const own = String(item?.content || '').trim();
    if (own) parts.push(own);
    const filePaths = Array.isArray(item?.file_paths) ? item.file_paths : [];
    for (const fp of filePaths) {
      const filePath = typeof fp === 'string' ? fp.trim() : '';
      if (!filePath) continue;
      try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const sanitized = sanitizeFileForPrompt ? sanitizeFileForPrompt(raw, filePath) : raw;
        const text = String(sanitized || '').trim();
        if (text) parts.push(text);
      } catch (error) {
        console.warn('[SavedPromptRefs] linked file unavailable prompt='
          + cleanOptionalString(item?.id || item?.title, '-')
          + ' file=' + filePath
          + ' error=' + String(error?.message || error));
      }
    }
    return parts;
  });
  return composed.parts.join('\n\n');
}

async function resolveSendPromptPresentation(projectManager, body, taskPrompt) {
  const refs = body?.prompts ?? body?.promptRefs ?? null;
  const fileRefs = body?.files ?? body?.contextFiles ?? null;
  const savedPrompts = projectManager.getPrompts();
  const promptChips = refs == null
    ? []
    : await resolveSavedPromptRefs({
      refs,
      prompts: savedPrompts,
      resolveText: (prompt) => resolveSavedPromptText(prompt, savedPrompts),
    });
  const contextFiles = fileRefs == null
    ? []
    : await resolveContextFileRefs({ refs: fileRefs });
  const task = String(taskPrompt || '').trim();
  const promptWithFiles = prependContextFileChips(task, contextFiles);
  return {
    prompt: prependSavedPromptChips(promptWithFiles, promptChips),
    // Request identity excludes file bodies but keeps saved-prompt resolution
    // compatible with the historical contract. File paths/roles/hashes travel
    // separately in contextFiles below.
    identityPrompt: prependSavedPromptChips(task, promptChips),
    promptChips,
    contextFiles: contextFiles.map((file) => ({
      label: file.label,
      path: file.filePath,
      role: file.role,
      sha256: file.sha256,
      bytes: file.bytes,
    })),
  };
}

function clampAutoStopMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30_000;
  return Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.floor(n)));
}

function clampAutoCloseMs(value) {
  if (value == null || value === '') return DEFAULT_EXTERNAL_AUTO_CLOSE_MS;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_EXTERNAL_AUTO_CLOSE_MS;
  return Math.max(0, Math.min(7 * 24 * 60 * 60 * 1000, Math.floor(n)));
}

function setExternalRunMeta(tabId, meta) {
  if (!tabId || !meta) return;
  bridgeRequest('setExternalRunMeta', { tabId, meta }, 1500).catch(() => {});
}

function clearExternalRunTimer(run, key) {
  if (!run?.[key]) return;
  clearTimeout(run[key]);
  run[key] = null;
}

function cleanupExternalRun(run) {
  if (!run) return;
  clearExternalRunTimer(run, 'stopTimer');
  clearExternalRunTimer(run, 'closeTimer');
  if (run.tabId && externalRunByTabId.get(run.tabId) === run.runId) {
    externalRunByTabId.delete(run.tabId);
  }
  if (run.conversationKey && externalRunByConversationKey.get(run.conversationKey) === run.runId) {
    externalRunByConversationKey.delete(run.conversationKey);
  }
  if (run.runId) externalRuns.delete(run.runId);
}

async function readAgentReadyStatus(tabId) {
  if (readAgentStartReadiness) {
    return await readAgentStartReadiness(tabId);
  }
  return await bridgeRequest('getClaudeTabStatus', { tabId }, 2000);
}

async function waitForAgentReady(tabId, timeoutMs = 20_000, expectedOwner = null) {
  return await waitForAgentReadyTransition({
    tabId,
    timeoutMs,
    expectedOwner: expectedOwner === null ? null : agentAdmittedReadyOwner(expectedOwner) || {},
    eventBus: ipcMain,
    readStatus: () => readAgentReadyStatus(tabId),
    log: (message) => console.log(message.replace('[AgentReadyWait]', '[WebReadyWait]')),
  });
}

async function readFreshReadyRuntimeStatus(tabId, label, expectedOwner = null) {
  let status;
  try {
    status = await readAgentReadyStatus(tabId);
  } catch (error) {
    const wrapped = new Error('runtime snapshot unavailable after startup defaults: ' + String(error?.message || error));
    wrapped.code = error?.code === 'bridge_timeout'
      ? 'runtime_snapshot_timeout'
      : 'runtime_snapshot_unavailable';
    wrapped.statusCode = error?.code === 'bridge_timeout' ? 504 : 502;
    wrapped.status = null;
    throw wrapped;
  }
  assertAgentReadyOwner(expectedOwner, status);
  const verdict = validateFreshAgentRuntimeStatus(status);
  if (!verdict.ok) {
    const error = new Error(verdict.error);
    error.code = verdict.error;
    error.statusCode = verdict.statusCode;
    error.status = status;
    throw error;
  }
  console.log('[WebReadyFresh] tab=' + shortId(tabId, 12)
    + ' label=' + label
    + ' status=' + (status?.status || '-')
    + ' inputReady=' + (status?.inputReady === true)
    + ' tool=' + (status?.toolType || status?.commandType || '-'));
  return status;
}

async function resolveEditRangeMutationTarget(tabId, body = {}, operation = 'edit') {
  const operationName = operation === 'delete' ? 'delete-range' : 'edit-range';
  let status = null;
  try {
    status = await bridgeRequest('getClaudeTabStatus', { tabId }, 2000);
  } catch (e) {
    const err = new Error('tab is not open or status is unavailable: ' + String(e.message || e));
    err.statusCode = 409;
    throw err;
  }

  const toolType = status?.toolType || status?.commandType;
  if (toolType !== 'claude' && toolType !== 'codex') {
    const err = new Error('history ' + operationName + ' is supported only for Claude/Codex terminal tabs');
    err.statusCode = 400;
    err.details = { commandType: status?.commandType || null, toolType: status?.toolType || null };
    throw err;
  }
  if (status?.status === 'stopping' || status?.stopping === true) {
    const err = new Error('tab is stopping; history range mutation is not allowed');
    err.statusCode = 409;
    err.details = { status: status?.status || null, toolType };
    throw err;
  }
  if (toolType === 'codex' && status?.status !== 'inactive') {
    const err = new Error('Codex ' + operationName + ' requires an inactive tab; stop Codex before mutating rollout history');
    err.statusCode = 409;
    err.details = { status: status?.status || null, toolType };
    throw err;
  }
  const claudeMutation = operation === 'delete' ? claudeDataApi?.deleteRange : claudeDataApi?.editRange;
  const codexMutation = operation === 'delete' ? codexDataApi?.deleteCodexRange : codexDataApi?.editCodexRange;
  if (toolType === 'claude' && !claudeMutation) {
    const err = new Error('claude history mutation API is not initialised');
    err.statusCode = 500;
    throw err;
  }
  if (toolType === 'codex' && !codexMutation) {
    const err = new Error('codex history mutation API is not initialised');
    err.statusCode = 500;
    throw err;
  }

  const statusSessionId = toolType === 'codex'
    ? cleanOptionalString(status?.sessionId || status?.codexSessionId, '')
    : cleanOptionalString(status?.sessionId || status?.claudeSessionId, '');
  const requestedSessionId = cleanOptionalString(body.sessionId, '');
  const sessionId = requestedSessionId || statusSessionId;
  if (!sessionId) {
    const err = new Error((toolType === 'codex' ? 'Codex' : 'Claude') + ' session id is required');
    err.statusCode = 400;
    throw err;
  }
  const exactInPlaceRepair = toolType === 'codex'
    && operation === 'delete'
    && body.inPlace === true
    && cleanOptionalString(body.expectedCurrentSessionId, '') === statusSessionId
    && cleanOptionalString(body.confirmInPlaceSessionId, '') === requestedSessionId;
  if (requestedSessionId && statusSessionId && requestedSessionId !== statusSessionId && !exactInPlaceRepair) {
    const err = new Error('body.sessionId does not match tab sessionId');
    err.statusCode = 409;
    err.details = { requestedSessionId, tabSessionId: statusSessionId, toolType };
    throw err;
  }

  const cwd = cleanOptionalString(body.cwd, '') || cleanOptionalString(status?.cwd, '');
  const startUuid = cleanOptionalString(body.startUuid || body.targetUuid, '');
  const endUuid = cleanOptionalString(body.endUuid, '');
  if (!startUuid || !endUuid) {
    const err = new Error('startUuid and endUuid required');
    err.statusCode = 400;
    throw err;
  }

  return { status, toolType, sessionId, cwd, startUuid, endUuid, exactInPlaceRepair };
}

function scheduleExternalRunStop(run, reason = 'auto-stop') {
  if (!run || !run.tabId || run.openedInTerminalAt || inboxSavedHistoryOperations?.holds(run.tabId)) return;
  const autoStopMs = clampAutoStopMs(run.autoStopMs);
  if (autoStopMs < 0) return;
  clearExternalRunTimer(run, 'stopTimer');
  const stopAt = Date.now() + autoStopMs;
  run.autoStopAt = stopAt;
  setExternalRunMeta(run.tabId, { status: run.status || 'done', autoStopAt: stopAt, autoStopMs });
  run.stopTimer = setTimeout(async () => {
    try {
      if (run.cleanupCancelled || externalRuns.get(run.runId) !== run
        || externalRunByTabId.get(run.tabId) !== run.runId || run.status === 'rewinding'
        || inboxSavedHistoryOperations?.holds(run.tabId)) return;
      run.status = 'stopping';
      setExternalRunMeta(run.tabId, { status: 'stopping', autoStopAt: null, autoStopMs });
      await runAgentStopScenario(run.tabId, 5000);
      run.status = 'stopped';
      run.stoppedAt = Date.now();
      setExternalRunMeta(run.tabId, { status: 'stopped', autoStopAt: null, autoStopMs, stoppedAt: run.stoppedAt, stopReason: reason });
    } catch (e) {
      run.status = 'stop_failed';
      setExternalRunMeta(run.tabId, { status: 'stop_failed', autoStopAt: null, stopError: String(e.message || e) });
    }
  }, autoStopMs);
}

function scheduleExternalRunClose(run, reason = 'auto-close') {
  if (!run || !run.tabId || run.openedInTerminalAt || inboxSavedHistoryOperations?.holds(run.tabId)) return;
  const autoCloseMs = clampAutoCloseMs(run.autoCloseMs);
  clearExternalRunTimer(run, 'closeTimer');
  if (autoCloseMs <= 0) {
    run.autoCloseAt = null;
    setExternalRunMeta(run.tabId, { autoCloseAt: null, autoCloseMs });
    return;
  }
  const closeAt = Date.now() + autoCloseMs;
  run.autoCloseAt = closeAt;
  setExternalRunMeta(run.tabId, { autoCloseAt: closeAt, autoCloseMs });
  run.closeTimer = setTimeout(async () => {
    try {
      if (run.cleanupCancelled || externalRuns.get(run.runId) !== run
        || externalRunByTabId.get(run.tabId) !== run.runId || run.status === 'rewinding'
        || inboxSavedHistoryOperations?.holds(run.tabId)) return;
      run.status = 'closing';
      setExternalRunMeta(run.tabId, { status: 'closing', autoCloseAt: null, autoCloseMs, closeReason: reason });
      await bridgeRequest('closeTab', { tabId: run.tabId, aiBusyOverride: false }, 8000);
      cleanupExternalRun(run);
    } catch (e) {
      run.status = 'close_failed';
      setExternalRunMeta(run.tabId, { status: 'close_failed', autoCloseAt: null, closeError: String(e.message || e) });
    }
  }, autoCloseMs);
}

function scheduleExternalRunCompletionTimers(run, reason = 'turn-done') {
  if (!run || !run.tabId || run.openedInTerminalAt || inboxSavedHistoryOperations?.holds(run.tabId)) return;
  run.cleanupCancelled = false;
  scheduleExternalRunStop(run, reason);
  scheduleExternalRunClose(run, reason);
}

async function getInboxResultResponse(runId, includeEntries = true) {
  await agentSendReceiptStartupReady;
  const record = agentSendReceiptStore?.get('inbox:' + runId) || null;
  // Wake the existing result observer on an exact pre-provider setup failure.
  // Its no-write proof remains at canonical GET /runs/:id; this is not an
  // assistant response, nor an inference from a legacy preparing receipt.
  if (record?.surface === 'inbox' && record.runId === runId
    && record.state === 'not-submitted' && record.inboxSetup?.noSubmitProof) {
    return { statusCode: 409, body: { ok: false, runId, code: 'inbox_setup_not_submitted',
      error: record.receipt?.error || 'Inbox setup stopped before submission',
      protocol: 'codex-inbox-result-v1', tabId: record.tabId, handoffId: record.handoffId } };
  }
  const descriptor = record?.tabId ? findOrchestrationTabDescriptor(record.tabId)
    || findRestorableAgentTabDescriptor(record.tabId) : null;
  return readInboxResult({
    runId, record, liveRun: externalRuns.get(runId), cwd: descriptor?.cwd, includeEntries,
    loadRecords: loadCodexSessionRecords,
    projectHistory: codexDataApi?.projectCodexFullHistoryFromFile,
    hydratePayload: transcriptService ? (payload) => transcriptService.getToolPayload(payload) : null,
    api: codexDataApi,
  });
}

// Tab-level done is a wake-up signal, not an Inbox result. A late event from
// another turn must neither finish this send nor arm a timer that kills it.
async function refreshExternalRunCompletion(run) {
  if (!run?.runId || run.completionStamp || run.status === 'rewinding' || inboxSavedHistoryOperations?.holds(run.tabId)) return;
  run.completionReadRequested = true;
  if (run.completionReadPending) return;
  run.completionReadPending = true;
  try {
    do {
      run.completionReadRequested = false;
      const observedActivityRevision = run.activityRevision || 0;
      const snapshot = await getInboxResultResponse(run.runId, false);
      if (externalRuns.get(run.runId) !== run || externalRunByTabId.get(run.tabId) !== run.runId
        || run.status === 'rewinding' || inboxSavedHistoryOperations?.holds(run.tabId)) return;
      const result = snapshot.body;
      if (snapshot.statusCode !== 200 || !result.ok || result.terminal?.ended !== true) continue;
      run.completionStamp = result.attemptId + ':' + result.identity.turnId;
      run.completedAt = Date.now();
      const processEnded = ['manual-stop', 'terminal-kill'].includes(result.terminal.reason);
      const busyScope = run.latestBusyScope;
      const activityChangedWhileReading = (run.activityRevision || 0) !== observedActivityRevision;
      const busyScopeMatchesResult = busyScope?.turnId === result.identity.turnId
        && (!busyScope?.sessionId || busyScope.sessionId === result.sessionId);
      const busyScopeContradictsResult = (busyScope?.turnId && busyScope.turnId !== result.identity.turnId)
        || (busyScope?.sessionId && busyScope.sessionId !== result.sessionId);
      // A delayed `busy:true` for this exact session+turn can arrive while the
      // canonical JSONL read is in flight. The completed turn is stronger proof;
      // treating the mere revision bump as newer work leaked the Inbox tab and
      // its timers forever. Different/unknown scope remains fail-safe: never stop
      // something that may be a later user-owned turn.
      const newerActivity = busyScopeContradictsResult
        || (activityChangedWhileReading && !busyScopeMatchesResult);
      run.status = processEnded ? 'stopped' : 'done';
      setExternalRunMeta(run.tabId, { status: run.status, completedAt: run.completedAt,
        sessionId: result.sessionId, completionReason: result.terminal.reason });
      if (!newerActivity && !run.openedInTerminalAt) {
        run.cleanupCancelled = false;
        if (processEnded) scheduleExternalRunClose(run, result.terminal.reason);
        else scheduleExternalRunCompletionTimers(run, 'exact-turn-result');
      }
      webBroadcast(run.tabId, { type: 'inbox-result', runId: run.runId, attemptId: result.attemptId,
        sessionId: result.sessionId, identity: result.identity, terminal: result.terminal });
      return;
    } while (run.completionReadRequested);
  } catch (error) {
    console.warn('[InboxResult] completion proof unavailable run=' + run.runId + ': ' + error.message);
  } finally { run.completionReadPending = false; }
}

function summarizeStreamMessage(message) {
  const recordType = message?.type || '-';
  const msg = message?.message && typeof message.message === 'object' ? message.message : null;
  const blocks = Array.isArray(msg?.content) ? msg.content : [];
  let textLen = 0;
  let thinkingLen = 0;
  let toolUses = 0;
  let toolResults = 0;
  let toolResultLen = 0;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') textLen += String(block.text || '').length;
    else if (block.type === 'thinking') thinkingLen += String(block.thinking || '').length;
    else if (block.type === 'tool_use') toolUses += 1;
    else if (block.type === 'tool_result') {
      toolResults += 1;
      const c = block.content;
      toolResultLen += typeof c === 'string' ? c.length : JSON.stringify(c || '').length;
    }
  }
  const resultLen = message?.result == null
    ? 0
    : typeof message.result === 'string'
      ? message.result.length
      : JSON.stringify(message.result).length;
  return ' record=' + recordType +
    ' uuid=' + shortId(message?.uuid) +
    ' msg=' + shortId(msg?.id) +
    ' session=' + shortId(message?.sessionId || message?.session_id) +
    ' blocks=' + blocks.length +
    ' textLen=' + textLen +
    ' thinkingLen=' + thinkingLen +
    ' tools=' + toolUses +
    ' toolResults=' + toolResults +
    ' toolResultLen=' + toolResultLen +
    ' resultLen=' + resultLen +
    ' synthetic=' + (message?.__webSynthetic === true) +
    ' queued=' + (message?.__wasQueued === true);
}

function streamMessageBlocks(message) {
  const msg = message?.message && typeof message.message === 'object' ? message.message : null;
  return Array.isArray(msg?.content) ? msg.content : [];
}

function streamMessageText(message) {
  const msg = message?.message && typeof message.message === 'object' ? message.message : null;
  if (typeof msg?.content === 'string') return msg.content;
  const out = [];
  for (const block of streamMessageBlocks(message)) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text);
  }
  return out.join('\n');
}

function isSlashCommandTranscriptText(text) {
  const trimmed = String(text || '').trim();
  return trimmed.startsWith('<command-name>');
}

function isNonTranscriptServiceText(text) {
  const trimmed = String(text || '').trim();
  return trimmed.startsWith('<local-command-stdout>')
    || trimmed.startsWith('<local-command-caveat>')
    || trimmed.startsWith('<system-reminder>')
    || trimmed === '[tool_result]'
    || trimmed.startsWith('<tool_result>');
}

function extractQueuedCommandProjectionText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt.map((item) => {
      if (!item) return '';
      if (typeof item === 'string') return item;
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      if (typeof item.message === 'string') return item.message;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (prompt && typeof prompt === 'object') {
    if (typeof prompt.text === 'string') return prompt.text;
    if (typeof prompt.content === 'string') return prompt.content;
    if (typeof prompt.message === 'string') return prompt.message;
  }
  return '';
}

function queuedCommandProjectionText(message) {
  if (message?.type !== 'attachment' || message?.attachment?.type !== 'queued_command') return '';
  return extractQueuedCommandProjectionText(message.attachment.prompt).trim();
}

function isSlashCommandText(text) {
  return String(text || '').trim().startsWith('/');
}

function deriveMessageProjection(payload) {
  if (!payload || payload.type !== 'message') return null;
  if (payload.projection && typeof payload.projection === 'object') return payload.projection;
  const message = payload.message || {};
  const msg = message?.message && typeof message.message === 'object' ? message.message : null;
  const blocks = streamMessageBlocks(message);
  const entryId = message?.uuid || msg?.id || message?.id || null;
  const source = message?.__projectionSource
    || (message?.__webSynthetic === true ? 'synthetic-web-broadcast' : null)
    || (String(entryId || '').startsWith('codex-live-') ? 'codex-rollout-live' : null)
    || 'agent-live';
  let kind = message?.type || msg?.role || 'unknown';
  let role = msg?.role || (message?.type === 'user' ? 'user' : message?.type === 'assistant' ? 'assistant' : null);
  let transcript = message?.__projectionTranscript;
  let ephemeral = message?.__projectionEphemeral === true;
  let timeline = message?.__projectionTimeline;

  if (transcript == null) {
    const hasText = blocks.some((b) => b?.type === 'text' && String(b?.text || '').trim());
    const hasToolUse = blocks.some((b) => b?.type === 'tool_use');
    const hasToolResult = blocks.some((b) => b?.type === 'tool_result');
    const hasThinking = blocks.some((b) => b?.type === 'thinking' && String(b?.thinking || '').trim());
    const text = streamMessageText(message);
    const queuedText = queuedCommandProjectionText(message);
    if (queuedText) {
      kind = isSlashCommandText(queuedText) ? 'slash' : 'queued';
      role = 'user';
      transcript = true;
      ephemeral = false;
      timeline = !isSlashCommandText(queuedText);
    } else if (message?.type === 'assistant' && hasThinking && !hasText && !hasToolUse) {
      kind = 'thinking';
      role = 'assistant';
      transcript = false;
      ephemeral = true;
      timeline = false;
    } else if (message?.type === 'user' && isSlashCommandTranscriptText(text)) {
      kind = 'slash';
      role = 'user';
      transcript = true;
      ephemeral = false;
      timeline = false;
    } else if (message?.type === 'user' && isNonTranscriptServiceText(text)) {
      kind = 'service';
      role = 'user';
      transcript = false;
      ephemeral = true;
      timeline = false;
    } else if (hasToolResult) {
      kind = 'tool_result';
      transcript = false;
      ephemeral = true;
      timeline = false;
    } else {
      transcript = true;
      if (timeline == null) timeline = message?.type === 'user';
    }
  }

  return {
    version: 1,
    source,
    entryId,
    kind,
    role,
    transcript: transcript === true,
    timeline: timeline === true,
    ephemeral,
  };
}

function withMessageProjection(payload) {
  if (!payload || payload.type !== 'message') return payload;
  const projection = deriveMessageProjection(payload);
  return projection ? { ...payload, projection } : payload;
}

function summarizeBroadcastPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.type === 'message') {
    const projection = payload.projection || deriveMessageProjection(payload);
    const projectionPart = projection
      ? ' projection=' + (projection.transcript === false ? 'skip' : 'transcript') +
        '/' + (projection.timeline === false ? 'no-timeline' : 'timeline') +
        '/' + (projection.kind || '-') +
        ' entry=' + shortId(projection.entryId) +
        ' source=' + (projection.source || '-')
      : '';
    return summarizeStreamMessage(payload.message) + projectionPart;
  }
  if (payload.type === 'project-activity') {
    const projects = Array.isArray(payload.projects) ? payload.projects : [];
    const active = projects.filter((p) => (Number(p?.count) || 0) > 0 || p?.streaming === true).length;
    const streaming = projects.filter((p) => p?.streaming === true).length;
    return ' projects=' + projects.length + ' active=' + active + ' streaming=' + streaming + ' projectOrder=' + (payload.projectOrderChanged === true);
  }
  if (payload.type === 'snapshot') {
    return ' status=' + (payload.sessionStatus || '-') +
      ' busy=' + (payload.busy == null ? '-' : payload.busy) +
      ' session=' + shortId(payload.sessionId) +
      ' tool=' + (payload.toolType || payload.commandType || '-');
  }
  if (payload.type === 'busy') return ' busy=' + (payload.busy == null ? '-' : payload.busy) + ' reason=' + (payload.reason || '-');
  if (payload.type === 'done') return ' session=' + shortId(payload.sessionId) + ' reason=' + (payload.reason || '-');
  if (payload.type === 'bridge-update') return ' model=' + (payload.model || '-') + ' context=' + (payload.contextPct == null ? '-' : payload.contextPct);
  if (payload.type === 'queue-update') return ' queue=yes';
  if (payload.type === 'ask-question') return ' source=' + (payload.source || '-') + ' questions=' + (Array.isArray(payload.questions) ? payload.questions.length : 0);
  if (payload.type === 'question-cancelled') return ' source=' + (payload.source || '-');
  return '';
}

function loadOrCreateToken() {
  try {
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  } catch {}
  if (fs.existsSync(TOKEN_PATH)) {
    return fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
  }
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_PATH, fresh + '\n', { mode: 0o600 });
  return fresh;
}

function readIosPushTokens() {
  try {
    if (!fs.existsSync(IOS_PUSH_TOKENS_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(IOS_PUSH_TOKENS_PATH, 'utf-8'));
    return Array.isArray(parsed?.tokens) ? parsed.tokens : [];
  } catch (e) {
    console.warn('[APNs] token store read failed:', e?.message || e);
    return [];
  }
}

function writeIosPushTokens(tokens) {
  fs.mkdirSync(path.dirname(IOS_PUSH_TOKENS_PATH), { recursive: true });
  fs.writeFileSync(IOS_PUSH_TOKENS_PATH, JSON.stringify({ tokens, updatedAt: Date.now() }, null, 2) + '\n', { mode: 0o600 });
}

function registerIosPushToken(payload = {}) {
  const rawToken = String(payload.token || '').trim().replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (!rawToken || rawToken.length < 32) return { ok: false, error: 'invalid token' };
  const environment = payload.environment === 'production' ? 'production' : 'development';
  const bundleId = String(payload.bundleId || process.env.NOTED_APNS_BUNDLE_ID || 'com.habittracker.swift').trim();
  const now = Date.now();
  const existing = readIosPushTokens().filter((item) => String(item.token || '').toLowerCase() !== rawToken);
  existing.push({
    token: rawToken,
    environment,
    bundleId,
    deviceName: String(payload.deviceName || '').slice(0, 120),
    platform: String(payload.platform || 'ios').slice(0, 40),
    registeredAt: now,
    lastSeenAt: now,
  });
  writeIosPushTokens(existing);
  console.log('[APNs] registered token env=' + environment + ' bundle=' + bundleId + ' suffix=' + rawToken.slice(-10) + ' total=' + existing.length);
  return { ok: true, count: existing.length, environment, bundleId };
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function derToJose(signature) {
  const buf = Buffer.from(signature);
  let offset = 0;
  if (buf[offset++] !== 0x30) throw new Error('APNs JWT signature is not DER sequence');
  let seqLen = buf[offset++];
  if (seqLen & 0x80) {
    const bytes = seqLen & 0x7f;
    seqLen = 0;
    for (let i = 0; i < bytes; i++) seqLen = (seqLen << 8) | buf[offset++];
  }
  const readInt = () => {
    if (buf[offset++] !== 0x02) throw new Error('APNs JWT signature integer missing');
    let len = buf[offset++];
    let value = buf.subarray(offset, offset + len);
    offset += len;
    while (value.length > 0 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) value = value.subarray(value.length - 32);
    if (value.length < 32) value = Buffer.concat([Buffer.alloc(32 - value.length), value]);
    return value;
  };
  return base64url(Buffer.concat([readInt(), readInt()]));
}

function apnsConfigFor(envOverride) {
  const keyId = process.env.NOTED_APNS_KEY_ID || process.env.APNS_KEY_ID || '';
  const teamId = process.env.NOTED_APNS_TEAM_ID || process.env.APNS_TEAM_ID || '';
  const keyPath = process.env.NOTED_APNS_KEY_PATH || process.env.APNS_KEY_PATH || '';
  const inlineKey = process.env.NOTED_APNS_PRIVATE_KEY || process.env.APNS_PRIVATE_KEY || '';
  let privateKey = inlineKey ? inlineKey.replace(/\\n/g, '\n') : '';
  let keyReadError = '';
  if (!privateKey && keyPath) {
    try {
      privateKey = fs.readFileSync(path.resolve(keyPath), 'utf-8');
    } catch (e) {
      keyReadError = e?.message || String(e);
    }
  }
  const forcedEnv = process.env.NOTED_APNS_ENV || process.env.APNS_ENV || '';
  const environment = forcedEnv === 'production' || forcedEnv === 'development'
    ? forcedEnv
    : (envOverride === 'production' ? 'production' : 'development');
  if (!keyId || !teamId || !privateKey) {
    return { configured: false, missing: ['KEY_ID', 'TEAM_ID', 'PRIVATE_KEY'].filter((name) => {
      if (name === 'KEY_ID') return !keyId;
      if (name === 'TEAM_ID') return !teamId;
      return !privateKey;
    }), error: keyReadError };
  }
  return { configured: true, keyId, teamId, privateKey, environment };
}

function apnsJwt(config) {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = config.keyId + ':' + config.teamId;
  if (apnsJwtCache && apnsJwtCache.cacheKey === cacheKey && now - apnsJwtCache.issuedAt < 45 * 60) {
    return apnsJwtCache.jwt;
  }
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: now }));
  const signingInput = header + '.' + claims;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), crypto.createPrivateKey(config.privateKey));
  const jwt = signingInput + '.' + derToJose(signature);
  apnsJwtCache = { cacheKey, issuedAt: now, jwt };
  return jwt;
}

function sendApnsNotification(tokenRecord, payload) {
  return new Promise((resolve) => {
    const config = apnsConfigFor(tokenRecord.environment);
    if (!config.configured) {
      console.warn('[APNs] skip not configured missing=' + config.missing.join(',') + ' token=' + String(tokenRecord.token || '').slice(-10) + (config.error ? ' error=' + config.error : ''));
      resolve({ ok: false, skipped: true, reason: 'not_configured', error: config.error || undefined });
      return;
    }
    let jwt = '';
    try {
      jwt = apnsJwt(config);
    } catch (e) {
      resolve({ ok: false, error: 'jwt: ' + (e?.message || String(e)) });
      return;
    }
    const host = config.environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    const bundleId = tokenRecord.bundleId || process.env.NOTED_APNS_BUNDLE_ID || 'com.habittracker.swift';
    const client = http2.connect(host);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch {}
      resolve(result);
    };
    client.on('error', (e) => finish({ ok: false, error: e?.message || String(e) }));
    const req = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + tokenRecord.token,
      authorization: 'bearer ' + jwt,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400),
    });
    let status = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => { status = Number(headers[':status'] || 0); });
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => finish({ ok: status >= 200 && status < 300, status, body }));
    req.on('error', (e) => finish({ ok: false, error: e?.message || String(e) }));
    req.end(JSON.stringify(payload));
  });
}

async function sendTabCompletionPush(detail = {}) {
  const projectId = String(detail.projectId || '').trim();
  const tabId = String(detail.tabId || '').trim();
  if (!projectId || !tabId) return { ok: false, error: 'projectId/tabId required' };
  const tokens = readIosPushTokens();
  if (tokens.length === 0) {
    console.log('[APNs] no registered iOS tokens for tab notification tab=' + tabId.slice(-10));
    return { ok: true, sent: 0, total: 0 };
  }
  const firedAt = Number(detail.firedAt) || Date.now();
  const tabName = String(detail.tabName || 'Terminal').slice(0, 160);
  const mode = detail.persistent === true ? 'persistent' : 'oneshot';
  const payload = {
    aps: {
      alert: { title: 'Terminal', body: tabName },
      sound: 'default',
      'content-available': 1,
    },
    kind: 'terminal-completion',
    projectId,
    tabId,
    tabName,
    firedAt,
    mode,
  };
  console.log('[APNs] send terminal completion project=' + projectId.slice(-10) + ' tab=' + tabId.slice(-10) + ' tokens=' + tokens.length + ' mode=' + mode);
  const results = [];
  for (const tokenRecord of tokens) {
    // Sequential sends keep logs readable and avoid opening a burst of HTTP/2 sessions.
    // Expected device count is tiny for this personal companion app.
    // eslint-disable-next-line no-await-in-loop
    const result = await sendApnsNotification(tokenRecord, payload);
    results.push({ token: String(tokenRecord.token || ''), tokenSuffix: String(tokenRecord.token || '').slice(-10), env: tokenRecord.environment, ...result });
    console.log('[APNs] result token=' + String(tokenRecord.token || '').slice(-10) + ' env=' + tokenRecord.environment + ' ok=' + !!result.ok + ' status=' + (result.status || '-') + ' reason=' + (result.reason || result.body || result.error || '-'));
  }
  const invalidReasons = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
  const invalid = new Set(results.filter((r) => {
    if (!r.body) return false;
    try { return invalidReasons.has(JSON.parse(r.body).reason); } catch { return false; }
  }).map((r) => r.token));
  if (invalid.size > 0) {
    const kept = tokens.filter((item) => !invalid.has(String(item.token || '')));
    writeIosPushTokens(kept);
    console.warn('[APNs] removed invalid tokens count=' + invalid.size + ' remaining=' + kept.length);
  }
  return { ok: true, sent: results.filter((r) => r.ok).length, total: tokens.length, results };
}

function getLanIp() {
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function checkAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7) === token;
  }
  // Fallback: ?token=... in query (used by WS upgrade since browsers can't
  // set headers on WS handshakes from JS).
  const parsed = url.parse(req.url, true);
  return parsed.query.token === token;
}

// Compress responses bigger than ~4KB if the client accepts gzip. Phone JSON
// payloads (history with thousands of messages) shrink ~10x — 20MB → 2MB —
// which is the difference between a 15s WiFi transfer and a 1.5s one.
const GZIP_THRESHOLD = 4 * 1024;
function sendJson(res, status, body) {
  // An owned operation may settle after its HTTP observer already received
  // 202 or disconnected. That does not cancel the operation or write twice.
  if (res.writableEnded || res.destroyed) return;
  const json = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Vary': 'Accept-Encoding',
  };
  const accept = (res.req && res.req.headers['accept-encoding']) || '';
  const useGzip = json.length >= GZIP_THRESHOLD && /\bgzip\b/.test(accept);
  if (useGzip) {
    const t0 = Date.now();
    const buf = zlib.gzipSync(json, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = String(buf.length);
    res.writeHead(status, headers);
    res.end(buf);
    if (json.length > 64 * 1024) {
      console.log(`[WebGzip] ${json.length}B → ${buf.length}B (${Math.round((1 - buf.length / json.length) * 100)}%) in ${Date.now() - t0}ms`);
    }
  } else {
    headers['Content-Length'] = String(Buffer.byteLength(json));
    res.writeHead(status, headers);
    res.end(json);
  }
}

function sendTerminalBridgeError(res, error) {
  const message = String(error?.message || error || 'unknown error');
  const requestedStatus = Number(error?.statusCode || error?.status);
  if (Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599) {
    return sendJson(res, requestedStatus, {
      ok: false,
      success: false,
      submitted: false,
      code: error?.code || 'request_rejected',
      error: message,
    });
  }
  const bridgeData = error?.bridgeData && typeof error.bridgeData === 'object'
    ? error.bridgeData
    : null;
  if (bridgeData?.reason) {
    const reason = String(bridgeData.reason);
    const status = reason === 'stale_layout'
      ? 409
      : /not_found|missing|unavailable/.test(reason)
        ? 404
        : 400;
    return sendJson(res, status, {
      ok: false,
      success: false,
      code: reason,
      error: message,
      ...bridgeData,
    });
  }
  const missingPrefix = 'working_directory_missing:';
  const missingIndex = message.indexOf(missingPrefix);
  if (missingIndex !== -1) {
    const cwd = message.slice(missingIndex + missingPrefix.length).trim();
    return sendJson(res, 409, {
      ok: false,
      error: 'working_directory_missing',
      message: 'Project folder does not exist' + (cwd ? ': ' + cwd : ''),
      cwd: cwd || null,
    });
  }
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes('launch_not_accepted') || lowerMessage.includes('start failed')) {
    return sendJson(res, 409, {
      ok: false,
      success: false,
      error: lowerMessage.includes('codex') ? 'codex_launch_not_accepted' : 'agent_launch_not_accepted',
      message,
    });
  }
  return sendJson(res, 500, { ok: false, error: message });
}

function sendAuditPending(res, data, extra = {}) {
  return sendJson(res, 202, {
    ...(data || {}),
    ...extra,
    ok: true,
    success: null,
    accepted: true,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
    exactAuditConfirmed: false,
    pendingReason: data?.error || data?.message || 'exact delivery confirmation pending',
    error: undefined,
  });
}

function sendDeliveryUnknown(res, data, extra = {}) {
  return sendJson(res, 202, {
    ...(data || {}),
    ...extra,
    ok: true,
    success: null,
    accepted: true,
    submitted: null,
    status: 'delivery-unknown',
    deliveryUnknown: true,
    exactAuditConfirmed: false,
    pendingReason: data?.error || data?.message
      || 'the renderer did not return a delivery receipt; do not retry blindly',
    error: undefined,
  });
}

function sendSendFailure(res, data, extra = {}) {
  const code = data && typeof data.code === 'string' ? data.code : 'send_failed';
  const requestedStatus = Number(data?.httpStatus || data?.statusCode);
  const httpStatus = Number.isInteger(requestedStatus)
    && requestedStatus >= 400
    && requestedStatus <= 599
    ? requestedStatus
    : 409;
  return sendJson(res, httpStatus, {
    ...(data || {}),
    ...extra,
    ok: false,
    success: false,
    accepted: false,
    submitted: data?.submitted === true,
    code,
    error: (data && (data.error || data.message)) || 'send failed',
  });
}

function externalRunResponseFields(run) {
  const setupOutcome = inboxSetupOutcome(run);
  return {
    runId: run.runId,
    provider: run.provider,
    tabId: run.tabId || null,
    sessionId: run.auditSessionId || run.sessionId || null,
    source: run.source,
    handoffId: run.handoffId,
    exactAuditConfirmed: run.auditConfirmedAt != null,
    auditEntryUuid: run.auditEntryUuid || null,
    auditSourceIdentity: run.auditSourceIdentity || null,
    conversationKey: run.conversationKey || null,
    resultUrl: '/api/inbox/runs/' + encodeURIComponent(run.runId) + '/result',
    ...(run.tabId ? {
      eventsUrl: '/api/events?tabId=' + encodeURIComponent(run.tabId),
      stopUrl: '/api/inbox/runs/' + encodeURIComponent(run.runId) + '/stop',
    } : {}),
    autoStopMs: run.autoStopMs,
    autoCloseMs: run.autoCloseMs,
    reused: run.reused === true,
    idempotent: true,
    ...(setupOutcome ? { setupOutcome } : {}),
  };
}

function inboxSetupOutcome(run) {
  const record = agentSendReceiptStore?.get('inbox:' + run.runId);
  if (!record || record.surface !== 'inbox' || record.runId !== run.runId
    || record.handoffId !== run.handoffId || record.provider !== run.provider) return null;
  const setup = record.inboxSetup;
  let submissionState = 'unknown', submissionProof = null;
  if (record.state === 'confirmed' && record.auditIdentity?.attemptId === record.attemptId) {
    submissionState = 'sent';
    submissionProof = { kind: 'exact-audit', operationKey: record.operationKey,
      attemptId: record.attemptId, provider: record.provider, sessionId: record.auditIdentity.sessionId,
      entryUuid: record.auditIdentity.entryUuid, sourceIdentity: record.auditIdentity.sourceIdentity };
  } else if (durableRecordHasProviderQueueAcceptance(record)) {
    submissionState = 'queued';
    submissionProof = { kind: 'provider-queue', operationKey: record.operationKey,
      attemptId: record.attemptId, provider: record.provider, providerQueueAccepted: true };
  } else if (record.state === 'not-submitted' && (setup?.noSubmitProof
    || record.attemptId && record.receipt?.submitted === false
      && record.receipt?.pasteWritten === false && record.receipt?.enterWritten === false)) {
    submissionState = 'not-submitted';
    submissionProof = setup?.noSubmitProof || { kind: 'no-submit', operationKey: record.operationKey,
      tabId: record.tabId, attemptId: record.attemptId, receiptState: record.state,
      submitted: false, pasteWritten: false, enterWritten: false };
  }
  return { version: 1, runId: record.runId, conversationKey: run.conversationKey || null,
    handoffId: record.handoffId, operationKey: record.operationKey,
    creationRequestId: setup?.creationRequestId || null, reservedTabId: record.tabId,
    creationState: setup?.creationState === 'pending' && run.setupExecutionId !== setup.executionId
      ? 'unknown' : setup?.creationState || 'unknown', submissionState, submissionProof };
}

function readDurableInboxRun(runId) {
  const record = agentSendReceiptStore?.get('inbox:' + runId);
  if (!record || record.surface !== 'inbox' || record.runId !== runId
    || record.handoffId !== 'external-run:' + runId) return null;
  const descriptor = record.tabId ? findOrchestrationTabDescriptor(record.tabId) : null;
  const meta = descriptor?.externalRun;
  // Legacy identity is recoverable only from the original reserved operation
  // metadata. This is NOT recovery of its lost renderer creation receipt.
  const exactMeta = descriptor?.projectId === INBOX_PROJECT_ID && descriptor.toolType === record.provider
    && meta?.runId === runId && meta.provider === record.provider
    && meta.handoffId === record.handoffId && meta.requestFingerprint === record.requestFingerprint
    && meta.reservedTabId === record.tabId ? meta : null;
  const scope = record.inboxSetup || exactMeta || {};
  return { runId, provider: record.provider, handoffId: record.handoffId,
    source: scope.source || null, conversationKey: scope.conversationKey || null,
    requestFingerprint: record.requestFingerprint, reservedTabId: record.tabId,
    tabId: record.inboxSetup?.creationState === 'created' || record.attemptId ? record.tabId : null,
    sessionId: record.sessionId, status: externalRunStatusFromDurableRecord(record),
    startedAt: record.createdAt, autoStopMs: exactMeta?.autoStopMs ?? 0, autoCloseMs: exactMeta?.autoCloseMs ?? 0,
    auditConfirmedAt: record.auditIdentity ? record.settledAt : null,
    auditSessionId: record.auditIdentity?.sessionId, auditEntryUuid: record.auditIdentity?.entryUuid,
    auditSourceIdentity: record.auditIdentity?.sourceIdentity,
    lastSendReceipt: durableAgentSendReplay(record) };
}

function inboxSetupRetryable(record) {
  // preparing/null attempt is not a no-write receipt. In particular, restart
  // must never turn a lost creator into a new create/send permission.
  return record?.state === 'not-submitted' && record.receipt?.submitted === false
    && (record.inboxSetup?.noSubmitProof || record.attemptId
      && record.receipt?.pasteWritten === false && record.receipt?.enterWritten === false);
}

function assertInboxSetupOwner(run) {
  if (externalRuns.get(run.runId) !== run || run.cleanupCancelled) {
    throw Object.assign(new Error('Inbox setup owner changed'), { code: 'external_run_setup_owner_changed' });
  }
  if (!agentSendReceiptStore || !run.setupExecutionId) return;
  if (agentSendReceiptStore.get('inbox:' + run.runId)?.inboxSetup?.executionId !== run.setupExecutionId) {
    throw Object.assign(new Error('Inbox setup receipt owner changed'), { code: 'external_run_setup_owner_changed' });
  }
}

function settleInboxSetupBeforeSend(run, error) {
  assertInboxSetupOwner(run);
  if (!agentSendReceiptStore || !run.setupExecutionId) return;
  const operationKey = 'inbox:' + run.runId;
  const setup = agentSendReceiptStore.get(operationKey)?.inboxSetup;
  if (setup?.creationState === 'pending' && setup.dispatched !== true) {
    agentSendReceiptStore.updateInboxSetup(operationKey, run.setupExecutionId, { creationState: 'refused' });
  }
  const settled = agentSendReceiptStore.settleInboxSetupNoWrite(operationKey, run.setupExecutionId, {
    code: error.code, error: String(error.message || error),
  });
  if (!settled.ok) return;
  run.lastSendReceipt = settled.record.receipt;
  if (settled.applied) webBroadcast(run.reservedTabId, { type: 'inbox-result',
    runId: run.runId, reason: 'inbox-setup-not-submitted' });
}

function replayExternalRunResponse(res, run) {
  const extra = externalRunResponseFields(run);
  if (extra.setupOutcome?.submissionState === 'unknown'
    && ['reserving', 'starting', 'setup_unknown', 'setup_failed', 'auth_required', 'start_failed', 'start_timeout'].includes(run.status)) {
    return sendJson(res, 202, { ok: true, success: null, accepted: true, submitted: null,
      status: ['reserving', 'starting'].includes(run.status) ? run.status : 'setup_unknown',
      code: 'external_run_setup_pending_or_unknown', ...extra });
  }
  if (run.status === 'delivery_unknown') {
    return sendDeliveryUnknown(res, run.lastSendReceipt || {}, extra);
  }
  if (run.status === 'audit_pending' || run.status === 'reserving'
    || run.status === 'starting' || run.status === 'sending') {
    if (run.status === 'audit_pending') {
      return sendAuditPending(res, run.lastSendReceipt || {}, extra);
    }
    return sendJson(res, 202, {
      ok: true,
      success: null,
      accepted: true,
      submitted: null,
      status: run.status,
      ...extra,
    });
  }
  if (run.status === 'running' || run.status === 'done' || run.status === 'stopped' || run.status === 'archived') {
    return sendJson(res, 200, {
      ok: true,
      success: true,
      submitted: true,
      status: run.status === 'running' ? 'sent' : run.status,
      exactAuditConfirmed: run.auditConfirmedAt != null,
      ...extra,
    });
  }
  return sendSendFailure(res, run.lastSendReceipt || {
    code: run.errorCode || run.status || 'external_run_failed',
    error: run.error || 'external run failed before delivery',
  }, extra);
}

function reservedInboxTabId(runId, conversationKey = '') {
  const stableOwner = conversationKey ? `conversation:${conversationKey}` : `run:${runId}`;
  const suffix = crypto.createHash('sha256').update(stableOwner).digest('hex').slice(0, 24);
  return `${INBOX_PROJECT_ID}-tab-external-${suffix}`;
}

function claimInboxHistoryCleanup({ tabId, runId, conversationKey, descriptor, audit }) {
  const reject = () => { throw Object.assign(new Error('inbox_history_owner_changed'), { code: 'inbox_history_owner_changed', statusCode: 409 }); };
  if (descriptor?.projectId !== INBOX_PROJECT_ID || descriptor.toolType !== 'codex') reject();
  if (!runId || audit?.runId !== runId || audit.tabId !== tabId || audit.conversationKey !== conversationKey
    || audit.provider !== 'codex' || audit.operationKey !== 'inbox:' + runId
    || audit.handoffId !== 'external-run:' + runId || !audit.requestFingerprint || !audit.attemptId) reject();
  let ownerId = externalRunByTabId.get(tabId) || null;
  const conversationOwnerId = externalRunByConversationKey.get(conversationKey);
  if (ownerId && conversationOwnerId && conversationOwnerId !== ownerId) reject();
  const validateCleanupRecord = candidate => {
    if (!candidate?.runId || candidate.handoffId !== 'external-run:' + candidate.runId
      || !candidate.requestFingerprint) reject();
    if (candidate.runId === runId) {
      if (candidate.requestFingerprint !== audit.requestFingerprint) reject();
    } else {
      // Rewind may explicitly select an older audited turn A while cleanup
      // belongs to a later B in that SAME conversation. Keep that capability,
      // but prove B by its own receipt, never by equal SID/text/title.
      const current = agentSendReceiptStore?.get('inbox:' + candidate.runId);
      if (current?.surface !== 'inbox' || current.runId !== candidate.runId || current.tabId !== tabId
        || current.provider !== 'codex' || current.state !== 'confirmed'
        || !current.attemptId || current.auditIdentity?.attemptId !== current.attemptId
        || current.auditIdentity.provider !== 'codex' || !current.auditIdentity.sessionId
        || current.handoffId !== candidate.handoffId || current.requestFingerprint !== candidate.requestFingerprint) reject();
    }
  };
  let run = ownerId ? externalRuns.get(ownerId) : null;
  if (ownerId && !run) reject();
  if (!run) {
    // Closed tabs retain the original cleanup policy in their own metadata.
    // Do not guess a policy, start a provider, or transplant another chat's run.
    const meta = descriptor.externalRun;
    if (!meta?.runId || meta.tabId !== tabId || meta.conversationKey !== conversationKey || meta.provider !== 'codex') reject();
    validateCleanupRecord(meta);
    const existingConversation = externalRunByConversationKey.get(conversationKey);
    if (existingConversation && existingConversation !== meta.runId || externalRuns.has(meta.runId)) reject();
    const archivedOwner = meta.archiveOwner;
    const archived = archivedOwner?.version === 1 && archivedOwner.runId === meta.runId
      && archivedOwner.tabId === tabId && archivedOwner.requestFingerprint === meta.requestFingerprint;
    // Archive commits before its close control settles. Only a durably carried
    // archive owner AND absence of a live control owner make this historical
    // `closing` safe to rebind. Never normalize a currently executing Stop/Close.
    run = { ...meta, sessionId: descriptor.sessionId, stopTimer: null, closeTimer: null,
      ...(archived && ['closing', 'stopping'].includes(meta.status) ? { status: 'archived' } : {}) };
    ownerId = run.runId;
    externalRuns.set(ownerId, run);
    externalRunByTabId.set(tabId, ownerId);
    externalRunByConversationKey.set(conversationKey, ownerId);
  }
  validateCleanupRecord(run);
  const cleanupFingerprint = run.requestFingerprint;
  const validate = () => {
    if (externalRuns.get(ownerId) !== run || externalRunByTabId.get(tabId) !== ownerId
      || externalRunByConversationKey.get(conversationKey) !== ownerId
      || run.tabId !== tabId || run.conversationKey !== conversationKey || run.provider !== 'codex'
      || run.runId !== ownerId || run.handoffId !== 'external-run:' + ownerId || run.requestFingerprint !== cleanupFingerprint
      || ['stopping', 'closing', 'rewinding'].includes(run.status)) reject();
  };
  validate();
  const stamp = run.completionStamp;
  const activityRevision = run.activityRevision;
  clearExternalRunTimer(run, 'stopTimer');
  clearExternalRunTimer(run, 'closeTimer');
  run.cleanupCancelled = true;
  run.autoStopAt = null;
  run.autoCloseAt = null;
  return { runId: ownerId, validate, release: operation => {
    try { validate(); } catch { return; } // never overwrite a later owner
    if (operation?.success === true) {
      run.sessionId = operation.activeSessionId || operation.newSessionId;
      run.status = 'done';
      // Keep auditSessionId/UUID/attempt as the OLD send proof. Only the runtime
      // binding changes; this history receipt is not a second provider answer.
      run.completionStamp = 'saved-history:' + operation.operationId;
      run.historyOperationId = operation.operationId;
      setExternalRunMeta(tabId, { status: 'done', sessionId: run.sessionId,
        historyOperationId: operation.operationId, historyCompletedAt: Date.now() });
      scheduleExternalRunCompletionTimers(run, 'saved-history');
    } else if (!operation?.historyMutated && run.completionStamp === stamp && run.activityRevision === activityRevision && stamp) {
      scheduleExternalRunCompletionTimers(run, 'saved-history-no-mutation');
    }
  } };
}

function durableRecordHasProviderQueueAcceptance(record) {
  return !!record && isAgentSendProviderQueueAccepted(record.receipt, {
    provider: record.provider,
    operationKey: record.operationKey,
    attemptId: record.attemptId,
  });
}

function externalRunStatusFromDurableRecord(record) {
  if (record?.state === 'confirmed') return 'running';
  if (durableRecordHasProviderQueueAcceptance(record)) return 'running';
  if (record?.state === 'audit-pending') return 'audit_pending';
  if (record?.state === 'delivery-unknown'
    || record?.state === 'in-flight'
    || record?.state === 'enter-armed') return 'delivery_unknown';
  if (record?.state === 'not-submitted'
    || record?.state === AGENT_SEND_RECEIPT_STATES.PROVIDER_NOT_ACCEPTED) return 'send_failed';
  return 'setup_unknown';
}

function durableAgentSendReplay(record, overrides = {}) {
  const applicationQueued = typeof agentSendQueue !== 'undefined' && agentSendQueue?.receipt(record?.operationKey);
  if (applicationQueued) return { ...applicationQueued, ...overrides, replayed: true };
  const storedReceipt = record?.receipt && typeof record.receipt === 'object'
    ? record.receipt
    : {};
  const receipt = storedReceipt.ownedAttachments
    ? { ...storedReceipt, attachmentOwnership: attachmentOwnershipReceipt(storedReceipt.ownedAttachments) }
    : storedReceipt;
  const state = record?.state || 'delivery-unknown';
  if (durableRecordHasProviderQueueAcceptance(record)
    && (state === 'enter-armed' || state === 'audit-pending' || state === 'delivery-unknown')) {
    return {
      ...receipt,
      success: true,
      accepted: true,
      submitted: true,
      queued: true,
      status: 'queued',
      receiptState: state,
      providerQueueAccepted: true,
      // Queue acceptance is successful, but it is not the canonical user-row
      // audit. Preserve that durable phase when the in-memory registry settles
      // the first response, just as a later idempotent replay does.
      auditPending: state === 'audit-pending',
      deliveryUnknown: false,
      ...overrides,
      replayed: true,
    };
  }
  if (state === 'confirmed') {
    return {
      ...receipt,
      success: true,
      accepted: true,
      submitted: true,
      status: receipt.status || 'sent',
      exactAuditConfirmed: receipt.exactAuditConfirmed === true,
      receiptState: 'confirmed',
      ...overrides,
      replayed: true,
    };
  }
  if (state === 'audit-pending') {
    return {
      ...receipt,
      success: null,
      accepted: true,
      submitted: true,
      status: 'audit-pending',
      auditPending: true,
      receiptState: 'audit-pending',
      ...overrides,
      replayed: true,
    };
  }
  if (state === AGENT_SEND_RECEIPT_STATES.PROVIDER_NOT_ACCEPTED) {
    return {
      ...receipt,
      success: false,
      accepted: false,
      submitted: true,
      status: AGENT_SEND_RECEIPT_STATES.PROVIDER_NOT_ACCEPTED,
      providerAccepted: false,
      auditPending: false,
      deliveryUnknown: false,
      receiptState: AGENT_SEND_RECEIPT_STATES.PROVIDER_NOT_ACCEPTED,
      ...overrides,
      replayed: true,
    };
  }
  if (state === 'not-submitted') {
    return {
      ...receipt,
      success: false,
      accepted: false,
      submitted: false,
      status: 'not-submitted',
      receiptState: 'not-submitted',
      ...overrides,
      replayed: true,
    };
  }
  return {
    ...receipt,
    success: null,
    accepted: true,
    submitted: null,
    status: 'delivery-unknown',
    deliveryUnknown: true,
    receiptState: 'delivery-unknown',
    code: receipt.code || 'agent_send_durable_delivery_unknown',
    warning: receipt.warning
      || 'The durable send operation is unresolved; do not retry this handoff blindly.',
    ...overrides,
    replayed: true,
  };
}

function publicAgentSendReceipt(record) {
  if (typeof agentSendQueue !== 'undefined' && agentSendQueue) record = agentSendQueue.projectRecord(record);
  const replay = durableAgentSendReplay(record, {
    operationKey: record.operationKey,
    attemptId: record.attemptId || null,
  });
  const serviceCommand = compactSendReceiptPresentation(record);
  const { serviceCommand: _storedPresentation, ...delivery } = replay;
  return {
    ...delivery,
    operationKey: record.operationKey,
    attemptId: record.attemptId || null,
    surface: record.surface,
    runId: record.runId || null,
    tabId: record.tabId,
    handoffId: record.handoffId,
    provider: record.provider,
    sessionId: record.auditIdentity?.sessionId || record.sessionId || null,
    receiptState: record.state,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    settledAt: record.settledAt || null,
    ...(record.applicationQueue ? { applicationQueue: record.applicationQueue } : {}),
    exactAuditConfirmed: record.state === 'confirmed',
    entryUuid: record.auditIdentity?.entryUuid || null,
    auditEntryUuid: record.auditIdentity?.entryUuid || null,
    sourceIdentity: record.auditIdentity?.sourceIdentity || null,
    auditSourceIdentity: record.auditIdentity?.sourceIdentity || null,
    sourceIdentityAliases: record.auditIdentity?.sourceIdentityAliases || [],
    ...(serviceCommand ? { serviceCommand } : {}),
  };
}

function durableAgentSendFailure(verdict, { tabId, handoffId } = {}) {
  if (verdict?.action === 'conflict') {
    return {
      success: false,
      accepted: false,
      submitted: false,
      status: 'conflict',
      code: 'agent_send_handoff_conflict',
      error: 'The same durable send operation was already used for a different request.',
      tabId: tabId || verdict?.record?.tabId || null,
      handoffId: handoffId || verdict?.record?.handoffId || null,
      mismatchedFields: verdict?.mismatchedFields || [],
    };
  }
  return {
    success: false,
    accepted: false,
    submitted: false,
    status: 'not-submitted',
    code: verdict?.code || 'agent_send_receipt_store_capacity',
    error: 'The durable send receipt store cannot reserve this operation.',
    tabId: tabId || null,
    handoffId: handoffId || null,
  };
}

let tabWorkContext = null;
let projectCardSignals = null;

function projectCardsSnapshot(projectId, tabs) {
  if (!projectCardSignals) return {};
  try {
    const startedAt = Date.now();
    const cardSignals = projectCardSignals.snapshot(projectId, tabs.map(tab => tab.tabId));
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 20) console.log('[CardSignals] read project=' + String(projectId).slice(-16)
      + ' revision=' + cardSignals.revision + ' tabs=' + cardSignals.tabs.length + ' durationMs=' + elapsedMs);
    return { cardSignals };
  } catch (error) {
    console.warn('[CardSignals] read failed project=' + String(projectId).slice(-16) + ' reason=' + String(error.code || error.message));
    return { cardSignals: { version: 1, projectId, epoch: projectCardSignals.wake().epoch,
      revision: projectCardSignals.wake().revision, unavailable: true, reason: 'metadata-read-failed' } };
  }
}

async function runAgentSendScenario(args) {
  if (!args.handoffId) args = { ...args, handoffId: 'context-send:' + crypto.randomUUID() };
  // Capture the intended conversation at admission, not when a later slot is
  // finally dispatched. Runtime/writer proof is still obtained by the scenario.
  if (!args.expectedTarget && typeof agentSendQueue !== 'undefined' && agentSendQueue) {
    const admitted = args.sendOperationKey && agentSendQueue.item(args.sendOperationKey);
    const target = findOrchestrationTabDescriptor(args.tabId);
    if (admitted) {
      const original = JSON.parse(admitted.request_json);
      args = { ...args, expectedTarget: original.expectedTarget || null };
    } else if (target?.sessionId && ['claude','codex'].includes(target.toolType)) {
      args = { ...args, expectedTarget: { toolType: target.toolType, sessionId: target.sessionId } };
    }
  }
  const prepared = tabWorkContext && args.workContextPrepared !== true
    ? await tabWorkContext.prepare(args.tabId, args.handoffId, args.prompt)
    : { prompt: args.prompt };
  try {
    const presentationSnapshot = bindStructuredAuthoringPresentation(args.presentationSnapshot, args.authoringSourcePrompt ?? args.prompt, prepared.prompt);
    const ownedAttachments = args.ownedAttachments
      ? bindOwnedAttachmentSnapshot(args.ownedAttachments, args.prompt, prepared.prompt,
        { prefix: prepared.prefix || '', authoringTransport: presentationSnapshot?.authoringTransport || null }) : null;
    const result = await runPreparedAgentSendScenario({ ...args, prompt: prepared.prompt, presentationSnapshot,
      ...(ownedAttachments ? { ownedAttachments } : {}) });
    if (result?.applicationQueued !== true) tabWorkContext?.settle(args.tabId, args.handoffId, result);
    return result;
  } catch (error) {
    if (error?.submitted === false) tabWorkContext?.release(args.tabId, args.handoffId);
    throw error;
  }
}

async function runPreparedAgentSendScenario(args) {
  const {
  tabId,
  prompt,
  model,
  effort,
  thinking,
  cwd,
  handoffId,
  source,
  statusAtSend,
  queue,
  ownership,
  presentationSnapshot,
  authoringSnapshot = null,
  ownedAttachments = null,
  provider,
  sessionId,
  sendOperationKey,
  sendSurface = 'project-api',
  sendRunId = null,
  sendRequestFingerprint = null,
  prepareSend,
  expectedTarget = null,
  requireLive = false,
  timeoutMs = agentSendBridgeTimeoutMs,
  onLateReceipt = null,
  applicationQueueAcceptedResponse = false,
  applicationQueueExecution = false,
  } = args;
  // A restart may have left an Enter-armed operation whose exact transcript
  // proof is still being reconciled. Never reserve/replay that operation until
  // the single bounded startup pass has settled its durable truth.
  await agentSendReceiptStartupReady;
  const promptHash = promptAuditFingerprint(prompt);
  const requestFingerprint = sendRequestFingerprint || fingerprintAgentSendRequest({
    prompt,
    model: model || null,
    effort: effort || null,
    thinking: thinking || null,
    cwd: cwd || null,
    source: source || null,
    queue: queue === true,
    ownership: ownership || null,
    ...(authoringSnapshot ? { authoring: authoringSnapshot } : {}),
    ...(expectedTarget ? { expectedTarget } : {}),
  });
  const durableIdentity = handoffId && sendOperationKey && agentSendReceiptStore
    ? {
      operationKey: sendOperationKey,
      surface: sendSurface,
      runId: sendRunId,
      tabId,
      handoffId,
      requestFingerprint,
      provider: provider || null,
      sessionId: sessionId || null,
      promptHash,
      promptLength: String(prompt || '').length,
    }
    : null;

  if (expectedTarget?.expectedBinding === 'none') {
    if (!conversationOwners || !durableIdentity) throw Object.assign(new Error('agent_send_owner_unavailable'), { statusCode: 503 });
    // Existing receipts are historical facts: a replay must remain readable
    // after a later owner. A new action is checked BEFORE reservation.
    if (!agentSendReceiptStore.get(sendOperationKey)) conversationOwners.assertNone(tabId, expectedTarget);
  }

  if (durableIdentity) {
    if (typeof agentSendQueue !== 'undefined' && agentSendQueue && !applicationQueueExecution
      && ['claude', 'codex'].includes(provider) && !isLocalSlashCommandPrompt(prompt)
      && findOrchestrationTabDescriptor(tabId)?.tabType !== 'claude-sdk') {
      const { prepareSend: _prepare, onLateReceipt: _late, ...request } = args;
      const admitted = agentSendQueue.enqueue({ identity: durableIdentity, request,
        execute: typeof prepareSend === 'function' || typeof onLateReceipt === 'function' ? async scope => {
          const receipt = await runPreparedAgentSendScenario({ ...args, applicationQueueExecution: true,
            sendRequestFingerprint: scope.requestFingerprint,
            ...(scope.expectedTarget ? { expectedTarget: scope.expectedTarget } : {}),
          });
          tabWorkContext?.settle(tabId, handoffId, receipt);
          return receipt;
        } : undefined,
      });
      if (!admitted.ok) return durableAgentSendFailure(admitted, { tabId, handoffId });
      if (admitted.receipt && applicationQueueAcceptedResponse) return admitted.receipt;
      const record = admitted.item?.state === 'waiting'
        ? await agentSendQueue.result(sendOperationKey) : admitted.record;
      return durableAgentSendReplay(record, { operationKey: sendOperationKey,
        attemptId: record?.attemptId || null, tabId, handoffId });
    }
    const reservation = agentSendReceiptStore.reserveOrGet(durableIdentity);
    if (!reservation?.ok) {
      return durableAgentSendFailure(reservation, { tabId, handoffId });
    }
    const currentProcessWaiter = (reservation.record?.state === 'in-flight'
      || reservation.record?.state === 'enter-armed')
      && agentSendReceiptRegistry.snapshot(tabId).some((record) => (
        record.handoffId === handoffId && record.sendPending === true
      ));
    if (reservation.action === 'replay' && reservation.retryable !== true && !currentProcessWaiter) {
      return durableAgentSendReplay(reservation.record, {
        operationKey: sendOperationKey,
        attemptId: reservation.record?.attemptId || null,
        tabId,
        handoffId,
      });
    }
  }

  const executeSend = async () => {
    tabWorkContext?.activate(tabId, handoffId);
    let durableAttemptId = null;
    let result;
    let preparedTarget = null;
    let admittedExpectedTarget = expectedTarget;
    try { tabWorkContext?.assertContinuationScope?.(tabId, handoffId); }
    catch (error) { result = { ...error, error: error.message, status: 'not-submitted', httpStatus: 409 }; }
    if (!result && typeof prepareSend === 'function') {
      // Restoring/reopening a closed tab is preparation, not a physical send.
      // Keep the receipt retryable across a crash here; the exact attempt only
      // starts immediately before the renderer/PTY bridge can be crossed.
      if (durableIdentity) agentSendReceiptStore.markPreparing(sendOperationKey);
      try {
        preparedTarget = await prepareSend();
      } catch (error) {
        result = {
          success: false,
          accepted: false,
          submitted: false,
          status: 'not-submitted',
          code: error?.code || 'agent_send_prepare_failed',
          error: error?.message || String(error),
          httpStatus: Number(error?.statusCode) || undefined,
          handoffId: handoffId || null,
          tabId,
        };
      }
    }
    if (!result) {
      try { tabWorkContext?.assertContinuationScope?.(tabId, handoffId); }
      catch (error) { result = { ...error, error: error.message, status: 'not-submitted', httpStatus: 409 }; }
    }
    if (!result && expectedTarget) {
      try {
        const currentTarget = typeof readAgentRuntimeSnapshot === 'function'
          ? await readScenarioDestination(tabId) : findOrchestrationTabDescriptor(tabId);
        // A first-turn/Resume launch can be input-ready before its writer SID
        // exists. The common readiness + physical boundary prove the original
        // SID later; an early null is not evidence of a different conversation.
        const provisionalLocalCommand = currentTarget?.toolType === 'codex'
          && !currentTarget.sessionId && !!currentTarget.terminalInstanceId && !!currentTarget.launchId
          && isLocalSlashCommandPrompt(prompt);
        result = agentSendTargetPreconditionFailure((applicationQueueExecution || provisionalLocalCommand) && !currentTarget?.sessionId
          ? { ...expectedTarget, sessionId: null } : expectedTarget, currentTarget);
        if (!result && provisionalLocalCommand) {
          // This is admission to the existing local-command proof, NOT input
          // permission. Keep the requested SID and bind the observed process;
          // Main must still prove its exact provisional Resume at every write.
          admittedExpectedTarget = Object.freeze({ ...expectedTarget,
            terminalInstanceId: expectedTarget.terminalInstanceId || currentTarget.terminalInstanceId,
            launchId: expectedTarget.launchId || currentTarget.launchId });
        }
      } catch (error) {
        result = { success: false, accepted: false, submitted: false, status: 'not-submitted',
          code: error.code || 'agent_send_target_unavailable', error: error.message, httpStatus: 503 };
      }
    }
    if (!result && durableIdentity) {
      if (applicationQueueExecution && agentSendQueue?.item(sendOperationKey)?.state === 'cancelled') {
        return { success: false, accepted: false, submitted: false, pasteWritten: false,
          code: 'agent_send_queue_cancelled', error: 'Send cancelled before terminal input' };
      }
      const begun = agentSendReceiptStore.beginAttempt(durableIdentity);
      if (!begun?.ok) {
        return durableAgentSendFailure(begun, { tabId, handoffId });
      }
      if (begun.action !== 'attempt-started') {
        return durableAgentSendReplay(begun.record, {
          operationKey: sendOperationKey,
          attemptId: begun.record?.attemptId || null,
          tabId,
          handoffId,
        });
      }
      durableAttemptId = begun.attemptId;
      if (expectedTarget) {
        // Persist the immutable destination on the same attempt. The physical
        // PTY boundary rechecks it; no renderer-only lease or new side registry.
        const staged = agentSendReceiptStore.stageAttemptContext(sendOperationKey, durableAttemptId, {
          expectedTarget: admittedExpectedTarget,
          ...(ownedAttachments ? { ownedAttachments } : {}),
        });
        if (staged?.ok !== true) result = {
          success: false, accepted: false, submitted: false, pasteWritten: false,
          status: 'not-submitted', code: 'agent_send_target_precondition_not_durable',
          error: 'The exact send destination could not be recorded before submission.',
        };
      }
      if (!result && expectedTarget?.expectedBinding === 'none') {
        try { conversationOwners.claimSend(tabId, expectedTarget, { sendOperationKey, sendAttemptId: durableAttemptId }); }
        catch (error) { result = { ...error, error: error.message, status: 'not-submitted', httpStatus: 409 }; }
      }
      if (!result && ownedAttachments && !expectedTarget) {
        const staged = agentSendReceiptStore.stageAttemptContext(sendOperationKey, durableAttemptId, { ownedAttachments });
        if (staged?.ok !== true) result = { success: false, submitted: false, pasteWritten: false,
          code: 'attachment_context_not_durable', error: 'Attachment ownership could not be staged.' };
      }
    }
    const settleLateBridgeReceipt = async ({ ok, data, error }) => {
      if (!durableIdentity || !durableAttemptId || !data || typeof data !== 'object') return;
      const lateResult = ok === false
        ? { ...data, success: false, error: data.error || error || 'renderer scenario failed' }
        : data;
      const settled = agentSendReceiptStore.settleAttempt(
        sendOperationKey,
        durableAttemptId,
        lateResult,
      );
      const exactRecord = settled?.record;
      if (!exactRecord || exactRecord.attemptId !== durableAttemptId) return;
      const exactReceipt = durableAgentSendReplay(exactRecord, {
        operationKey: sendOperationKey,
        attemptId: durableAttemptId,
        tabId,
        handoffId,
        lateBridgeReply: true,
      });
      tabWorkContext?.settle(tabId, handoffId, exactReceipt);
      console.warn('[AgentSendReceipt] late renderer receipt operation='
        + String(sendOperationKey).slice(0, 72)
        + ' attempt=' + String(durableAttemptId).slice(0, 12)
        + ' state=' + exactRecord.state
        + ' submitted=' + String(exactReceipt.submitted));
      if (typeof onLateReceipt === 'function') {
        await onLateReceipt(exactReceipt, exactRecord);
      }
    };

    if (!result) try {
      const target = preparedTarget?.descriptor || findOrchestrationTabDescriptor(tabId);
      result = await bridgeRequest('sendAgentPromptScenario', {
        tabId,
        targetProjectId: target?.projectId || null,
        expectedToolType: expectedTarget?.toolType || target?.toolType || provider || null,
        expectedTabType: target?.tabType || null,
        expectedSessionId: expectedTarget?.sessionId || null,
        ...(admittedExpectedTarget ? { expectedTarget: admittedExpectedTarget } : {}),
        ...(expectedTarget?.expectedBinding === 'none' ? { expectedBinding: 'none' } : {}),
        requireLive,
        prompt,
        workContextPrepared: true,
        model,
        effort,
        thinking,
        cwd,
        handoffId,
        sendOperationKey: sendOperationKey || null,
        sendAttemptId: durableAttemptId,
        source,
        statusAtSend,
        queue: queue === true,
        presentationSnapshot: withPromptOriginPresentation(presentationSnapshot, source),
        ...(authoringSnapshot ? { authoringSnapshot } : {}),
        // Project/History/iOS controls the terminal tab directly: leave a found
        // terminal draft untouched and report conflict. External Inbox owns its
        // own chat composer: atomically pull terminal draft out for caller rollback.
        returnDraftOnConflict: ownership === 'external',
      }, timeoutMs, {
        onLateReply: settleLateBridgeReceipt,
      });
    } catch (error) {
      if (error?.dispatched === false || error?.code === 'bridge_unavailable') {
        result = {
          success: false,
          accepted: false,
          submitted: false,
          status: 'not-submitted',
          code: error?.code || 'bridge_unavailable',
          error: error?.message || String(error),
          httpStatus: 503,
          handoffId: handoffId || null,
          tabId,
        };
      } else if (error?.code === 'bridge_failed'
        && error?.bridgeData && typeof error.bridgeData === 'object') {
        // An explicit renderer reply is not a transport timeout. Preserve its
        // receipt (including submitted:false) and let the shared classifier
        // decide; success:false by itself still does not prove no Enter.
        result = {
          ...error.bridgeData,
          success: false,
          error: error.bridgeData.error || error.message || 'renderer scenario failed',
          handoffId: handoffId || null,
          tabId,
        };
      } else {
        // BrowserWindow.send crossed the main -> renderer boundary, but the
        // renderer did not return its receipt before the caller deadline. The
        // scenario may still be launching, proving readiness, or waiting for the
        // post-Enter transcript audit. Treating this as "not sent" invites a
        // duplicate; treating it as "sent" fabricates delivery. Preserve the
        // exact handoff for a later audit and surface an explicit unknown state.
        const bridgeFailureCode = error?.code === 'bridge_failed'
          ? 'bridge_failed_delivery_unknown'
          : 'bridge_timeout_delivery_unknown';
        console.warn('[AgentScenario] renderer receipt unavailable tab=' + shortId(tabId, 12)
          + ' handoff=' + (handoffId || '-')
          + ' source=' + (source || '-')
          + ' timeoutMs=' + timeoutMs
          + ' -> delivery-unknown');
        result = {
          success: null,
          accepted: true,
          submitted: null,
          status: 'delivery-unknown',
          deliveryUnknown: true,
          code: bridgeFailureCode,
          warning: 'The send scenario may still complete; do not retry this handoff blindly.',
          handoffId: handoffId || null,
          tabId,
        };
      }
    }

    if (durableIdentity && durableAttemptId) {
      const bridgeTimedOut = result?.deliveryUnknown === true
        && result?.code === 'bridge_timeout_delivery_unknown';
      if (bridgeTimedOut) {
        // Keep the exact attempt open so a renderer reply that lost the race
        // with the caller deadline can still prove submitted:false. A process
        // restart converts this active attempt to delivery-unknown; neither
        // path grants retry authority or fabricates success.
        const exactRecord = agentSendReceiptStore.get(sendOperationKey);
        if (exactRecord?.attemptId === durableAttemptId
          && exactRecord.state !== 'in-flight') {
          return durableAgentSendReplay(exactRecord, {
            operationKey: sendOperationKey,
            attemptId: durableAttemptId,
            tabId,
            handoffId,
          });
        }
      } else {
        const settled = agentSendReceiptStore.settleAttempt(
          sendOperationKey,
          durableAttemptId,
          result,
        );
        // An exact audit may win the race while the renderer callback is still
        // returning. Never let that stale callback overwrite the durable fact.
        if (settled?.record && (settled.record.state === 'confirmed' || settled.applied !== true)) {
          return durableAgentSendReplay(settled.record, {
            operationKey: sendOperationKey,
            attemptId: durableAttemptId,
            tabId,
            handoffId,
            replayed: settled.applied !== true,
          });
        }
      }
    }
    if (durableIdentity && !durableAttemptId && result?.submitted === false) {
      // This branch has not begun an attempt or crossed the renderer bridge.
      // Persist its explicit refusal on the same receipt instead of leaving
      // a failed local command in preparing/delivery-unknown after restart.
      agentSendReceiptStore.settleQueuedNoWrite(sendOperationKey, result);
    }
    return {
      ...(result || {}),
      ...(ownedAttachments ? { attachmentOwnership: attachmentOwnershipReceipt(ownedAttachments) } : {}),
      ...(sendOperationKey ? { operationKey: sendOperationKey } : {}),
      ...(durableAttemptId ? { attemptId: durableAttemptId } : {}),
    };
  };

  if (!handoffId) return await executeSend();
  const registered = await agentSendReceiptRegistry.run({
    tabId,
    handoffId,
    requestFingerprint,
    provider: provider || null,
    sessionId: sessionId || null,
    promptHash,
  }, executeSend);
  if (registered.replayed === true || registered.joined === true
    || registered.state === AGENT_SEND_RECEIPT_STATES.CONFLICT) {
    console.log('[AgentSendReceipt] reuse tab=' + shortId(tabId, 12)
      + ' handoff=' + String(handoffId).slice(0, 32)
      + ' state=' + registered.state
      + ' replayed=' + (registered.replayed === true)
      + ' joined=' + (registered.joined === true)
      + ' attempt=' + (registered.attempt ?? '-'));
  }

  if (registered.state === AGENT_SEND_RECEIPT_STATES.CONFLICT) {
    return {
      success: false,
      accepted: false,
      submitted: false,
      status: 'conflict',
      code: 'agent_send_handoff_conflict',
      error: 'The same handoffId was already used for a different send request.',
      handoffId,
      tabId,
      mismatchedFields: registered.mismatchedFields || [],
    };
  }
  if (registered.state === AGENT_SEND_RECEIPT_STATES.CAPACITY) {
    return {
      success: false,
      accepted: false,
      submitted: false,
      status: 'not-submitted',
      code: registered.code,
      error: 'The exact send receipt registry is full; the prompt was not submitted.',
      handoffId,
      tabId,
    };
  }
  if (registered.state === AGENT_SEND_RECEIPT_STATES.EVICTED_UNKNOWN) {
    return {
      success: null,
      accepted: true,
      submitted: null,
      status: 'delivery-unknown',
      deliveryUnknown: true,
      code: registered.code,
      warning: 'The unresolved send receipt expired; do not retry this handoff blindly.',
      handoffId,
      tabId,
      replayed: true,
    };
  }
  return {
    ...(registered.receipt || {}),
    handoffId,
    tabId,
    receiptState: registered.state,
    replayed: registered.replayed === true,
    joined: registered.joined === true,
    sendAttempt: registered.attempt,
  };
}

async function applyOrchestrationTargetSendReceipt(runId, sendResult, {
  reason = 'target-send-receipt',
  targetStatus = null,
  late = false,
} = {}) {
  const store = getOrchestrationRunStore();
  const current = await store.getInternal(runId);
  if (!current || isTerminalStatus(current.status)) {
    return {
      kind: 'settled',
      receiptState: classifyAgentSendReceipt(sendResult).state,
      run: await store.get(runId),
    };
  }

  const sendReceipt = classifyAgentSendReceipt(sendResult);
  if (sendReceipt.state === AGENT_SEND_RECEIPT_STATES.PROVIDER_NOT_ACCEPTED) {
    // Physical Enter is only a transport fact. An exact post-Enter composer
    // proof may still show that Claude never created the provider turn. A
    // positive transcript proof wins a race; transport acceptance alone does
    // not turn this terminal negative receipt back into audit-pending.
    if (current.targetPromptProofAt) {
      console.warn('[OrchestrationDelivery] stale provider-not-accepted receipt ignored run=' + runId
        + ' late=' + late
        + ' promptProofAt=' + current.targetPromptProofAt);
      return { kind: 'accepted', receiptState: 'confirmed', run: await store.get(runId) };
    }
    const recoveryPolicy = orchestrationSendFailureRecoveryPolicy(sendResult);
    console.warn('[OrchestrationDelivery] exact provider-not-accepted after Enter run=' + runId
      + ' late=' + late
      + ' target=' + String(current.targetTabId || '').slice(-12)
      + ' code=' + (sendResult?.code || '-')
      + ' draftPreserved=' + (sendResult?.draftPreserved === true));
    const failed = await store.beginRecovery(
      runId,
      current.targetCreated ? 'startup_failed' : 'failed',
      sendResult?.error || sendResult?.message || sendResult?.code
        || 'provider did not accept the submitted prompt',
      { failureGraceMs: recoveryPolicy.failureGraceMs },
    );
    emitOrchestrationChanges(failed.changed, reason + '-provider-not-accepted');
    await finalizeSettledOrchestrations(failed.settled, reason + '-provider-not-accepted');
    return {
      kind: 'send-failed',
      receiptState: sendReceipt.state,
      run: await store.get(runId),
    };
  }
  if (sendReceipt.state === 'not-submitted') {
    // A transcript audit or accepted Enter is stronger than a stale renderer
    // callback. Only an exact pre-Enter receipt may turn a still-unaccepted
    // orchestration into failure.
    if (current.deliveryAcceptedAt || current.targetPromptProofAt) {
      console.warn('[OrchestrationDelivery] stale not-submitted receipt ignored run=' + runId
        + ' late=' + late
        + ' acceptedAt=' + (current.deliveryAcceptedAt || '-')
        + ' promptProofAt=' + (current.targetPromptProofAt || '-'));
      const provenReceiptState = current.targetPromptProofAt
        ? 'confirmed'
        : current.deliveryAuditPendingAt
          ? 'audit-pending'
          : 'confirmed';
      return { kind: 'accepted', receiptState: provenReceiptState, run: await store.get(runId) };
    }
    const recoveryPolicy = orchestrationSendFailureRecoveryPolicy(sendResult);
    if (recoveryPolicy.provenNotSent && sendResult?.cancelled === true) {
      const cancelled = await store.cancel(runId, {
        reason: 'target-send-cancelled-before-submit', suppressNotification: false,
      });
      console.log('[OrchestrationDelivery] cancelled before submit run=' + runId
        + ' target=' + String(current.targetTabId || '').slice(-12));
      emitOrchestrationChanges(cancelled.changed, reason + '-send-cancelled');
      await finalizeSettledOrchestrations(cancelled.settled, reason + '-send-cancelled');
      return { kind: 'send-cancelled', receiptState: sendReceipt.state, run: await store.get(runId) };
    }
    if (recoveryPolicy.provenNotSent) {
      await store.resetDeferredDelivery(runId, 'send-refused-before-submit');
      console.warn('[OrchestrationDelivery] exact pre-submit failure run=' + runId
        + ' late=' + late
        + ' target=' + String(current.targetTabId || '').slice(-12)
        + ' code=' + (sendResult?.code || '-')
        + ' error=' + (sendResult?.error || sendResult?.message || 'send failed'));
    } else {
      console.warn('[OrchestrationDelivery] unproven send failure keeps recovery grace run=' + runId
        + ' late=' + late
        + ' target=' + String(current.targetTabId || '').slice(-12)
        + ' submitted=' + String(sendResult?.submitted)
        + ' accepted=' + String(sendResult?.accepted)
        + ' error=' + (sendResult?.error || sendResult?.message || 'send failed'));
    }
    const failed = await store.beginRecovery(
      runId,
      current.targetCreated ? 'startup_failed' : 'failed',
      sendResult?.error || sendResult?.message || sendResult?.code || 'send failed',
      { failureGraceMs: recoveryPolicy.failureGraceMs },
    );
    emitOrchestrationChanges(failed.changed, reason + '-send-failed');
    await finalizeSettledOrchestrations(failed.settled, reason + '-send-failed');
    return {
      kind: 'send-failed',
      receiptState: sendReceipt.state,
      run: await store.get(runId),
    };
  }

  if (sendReceipt.state === 'delivery-unknown') {
    const unknown = await store.patch(runId, {
      status: 'sending',
      deliveryTransportUnknownAt: current.deliveryTransportUnknownAt || Date.now(),
      deliveryTransportError: sendResult?.code || 'bridge_timeout_delivery_unknown',
    });
    emitOrchestrationRun(unknown, reason + '-delivery-unknown');
    return { kind: 'delivery-unknown', receiptState: sendReceipt.state, run: unknown };
  }

  if (isAgentSendProviderQueueAccepted(sendResult)) {
    const acceptedRuntime = await resolveAgentSessionInfo(current.targetTabId, 2000).catch(() => null);
    const accepted = await store.markDelivery(runId, {
      baselineBusy: true,
      sessionId: sendResult?.sessionId || acceptedRuntime?.sessionId || targetStatus?.sessionId || null,
      lifecycleGeneration: acceptedRuntime?.lifecycleGeneration || targetStatus?.lifecycleGeneration || null,
      launchGeneration: acceptedRuntime?.launchGeneration || targetStatus?.launchGeneration || null,
      auditPending: false,
    });
    emitOrchestrationRun(accepted, reason + '-provider-queued');
    const reconciled = await reconcileOrchestrationRun(runId, reason + '-provider-queued-reconcile');
    return { kind: 'accepted', receiptState: 'queued', run: reconciled || accepted };
  }

  if (current.deliveryAcceptedAt) {
    const reconciled = await reconcileOrchestrationRun(runId, reason + '-already-accepted');
    return { kind: 'accepted', receiptState: sendReceipt.state, run: reconciled };
  }
  const acceptedRuntime = await resolveAgentSessionInfo(current.targetTabId, 2000).catch(() => null);
  const accepted = await store.markDelivery(runId, {
    baselineBusy: false,
    sessionId: sendResult?.sessionId || acceptedRuntime?.sessionId || targetStatus?.sessionId || null,
    lifecycleGeneration: acceptedRuntime?.lifecycleGeneration || targetStatus?.lifecycleGeneration || null,
    launchGeneration: acceptedRuntime?.launchGeneration || targetStatus?.launchGeneration || null,
    auditPending: sendReceipt.state === 'audit-pending',
  });
  emitOrchestrationRun(accepted, reason + '-delivery-accepted');
  const reconciled = await reconcileOrchestrationRun(runId, reason + '-delivery-reconcile');
  return { kind: 'accepted', receiptState: sendReceipt.state, run: reconciled || accepted };
}

async function prepareOrchestrationTargetForDelivery(runId, reason) {
  const store = getOrchestrationRunStore();
  let current = await store.getInternal(runId);
  if (!current?.compactBeforeTask || current.targetPreparationCompletedAt) {
    return { prepared: true, run: current };
  }
  if (current.targetPreparationStartedAt) {
    const recovery = await store.beginRecovery(
      runId,
      'startup_failed',
      'pre-task compact outcome is unknown after interruption; retry explicitly',
      { failureGraceMs: 0 },
    );
    emitOrchestrationChanges(recovery.changed, reason + '-compact-outcome-unknown');
    await finalizeSettledOrchestrations(recovery.settled, reason + '-compact-outcome-unknown');
    return { prepared: false, run: await store.getInternal(runId), reason: 'compact-outcome-unknown' };
  }

  current = await store.patch(runId, {
    status: 'starting',
    targetPreparationStartedAt: Date.now(),
    targetPreparationKind: 'compact',
  });
  await store.persistStrict();
  emitOrchestrationRun(current, reason + '-compact-started');
  try {
    const result = await bridgeRequest('compactAgentTab', {
      tabId: current.targetTabId,
      projectId: current.targetProjectId,
      handoffId: 'orchestration-pre-task-compact:' + current.runId,
      timeoutMs: 180_000,
    }, 185_000);
    if (result?.success !== true) throw new Error(result?.error || 'pre-task compact failed');
    const prepared = await store.patch(runId, {
      status: 'queued',
      targetPreparationCompletedAt: Date.now(),
      targetPreparationOperationId: result?.operation?.operationId || null,
      targetPreparationError: null,
    });
    await store.persistStrict();
    emitOrchestrationRun(prepared, reason + '-compact-completed');
    return { prepared: true, run: await store.getInternal(runId) };
  } catch (error) {
    const recovery = await store.beginRecovery(
      runId,
      'startup_failed',
      'pre-task compact failed: ' + String(error?.message || error),
      { failureGraceMs: 0 },
    );
    emitOrchestrationChanges(recovery.changed, reason + '-compact-failed');
    await finalizeSettledOrchestrations(recovery.settled, reason + '-compact-failed');
    return { prepared: false, run: await store.getInternal(runId), reason: 'compact-failed' };
  }
}

async function dispatchDeferredOrchestrationRun(runId, {
  reason = 'delivery-wake',
  targetStatus = null,
  singleFlightOwned = false,
} = {}) {
  if (!runId) {
    return { dispatched: false, deferred: false, reason: 'run-id-required' };
  }
  if (!singleFlightOwned) {
    return orchestrationDeliverySingleFlight.run(runId, { reason, targetStatus }, (attempt) => (
      dispatchDeferredOrchestrationRun(runId, {
        ...attempt,
        singleFlightOwned: true,
      })
    ));
  }

    const store = getOrchestrationRunStore();
    let current = await store.getInternal(runId);
    if (!current || isTerminalStatus(current.status)) {
      return { dispatched: false, deferred: false, reason: 'run-not-active', run: await store.get(runId) };
    }
    if (!current.deliveryIntent) {
      return { dispatched: false, deferred: false, reason: 'delivery-already-crossed-enter', run: await store.get(runId) };
    }
    let status = targetStatus
      || await resolveAgentSessionInfo(current.targetTabId, 2000, {
        onLateStatus: (lateStatus) => {
          if (!isOrchestrationDeliveryIdentityCompatible(current, lateStatus)) {
            console.warn('[OrchestrationDeliveryWake] rejected late status identity run=' + current.runId
              + ' target=' + shortId(current.targetTabId, 12));
            return;
          }
          void dispatchDeferredOrchestrationRun(current.runId, {
            reason: 'late-runtime-status',
            targetStatus: lateStatus,
          }).catch((error) => {
            console.warn('[OrchestrationDeliveryWake] late status dispatch failed run=' + current.runId
              + ' error=' + String(error?.message || error));
          });
        },
      }).catch(() => null);
    if (status && !isOrchestrationDeliveryIdentityCompatible(current, status)) {
      console.warn('[OrchestrationDeliveryWake] rejected runtime status identity run=' + current.runId
        + ' target=' + shortId(current.targetTabId, 12));
      status = null;
    }
    let deliveryAdmission = resolveOrchestrationDeliveryAdmission(status);
    if (!deliveryAdmission.canDispatch) {
      const deferred = await store.deferDelivery(runId, {
        reason: deliveryAdmission.reason,
        sessionId: status?.sessionId || null,
        lifecycleGeneration: status?.lifecycleGeneration || null,
        launchGeneration: status?.launchGeneration || null,
      });
      emitOrchestrationRun(deferred, reason + '-deferred');
      const exactStatus = typeof readAgentStartReadiness === 'function'
        ? await readAgentStartReadiness(current.targetTabId).catch(() => null)
        : null;
      const exactAdmission = resolveOrchestrationDeliveryAdmission(exactStatus);
      if (!exactAdmission.canDispatch
        || !isOrchestrationDeliveryIdentityCompatible(current, exactStatus)) {
        return { dispatched: false, deferred: true, reason: 'target-not-idle', run: deferred };
      }
      console.log('[OrchestrationDeliveryWake] event=exact-readiness-recheck'
        + ' run=' + current.runId
        + ' reason=' + deliveryAdmission.reason
        + ' status=' + String(exactStatus?.status || exactStatus?.sessionStatus || '-'));
      status = exactStatus;
      deliveryAdmission = exactAdmission;
    }

    if (current.compactBeforeTask && !current.targetPreparationCompletedAt) {
      if (deliveryAdmission.statusAtSend !== 'active') {
        const deferred = await store.deferDelivery(runId, {
          reason: 'target-preparation-requires-active-runtime',
          sessionId: status?.sessionId || null,
          lifecycleGeneration: status?.lifecycleGeneration || null,
          launchGeneration: status?.launchGeneration || null,
        });
        emitOrchestrationRun(deferred, reason + '-compact-awaiting-active-runtime');
        return {
          dispatched: false,
          deferred: true,
          reason: 'target-preparation-requires-active-runtime',
          run: deferred,
        };
      }
      const preparation = await prepareOrchestrationTargetForDelivery(runId, reason);
      if (!preparation.prepared) {
        return {
          dispatched: false,
          deferred: false,
          reason: preparation.reason,
          run: await store.get(runId),
        };
      }
      current = preparation.run;
      status = typeof readAgentStartReadiness === 'function'
        ? await readAgentStartReadiness(current.targetTabId).catch(() => status)
        : await resolveAgentSessionInfo(current.targetTabId, 2000).catch(() => status);
      deliveryAdmission = resolveOrchestrationDeliveryAdmission(status);
      if (!deliveryAdmission.canDispatch || deliveryAdmission.statusAtSend !== 'active') {
        const deferred = await store.deferDelivery(runId, {
          reason: 'target-not-ready-after-preparation',
          sessionId: status?.sessionId || null,
          lifecycleGeneration: status?.lifecycleGeneration || null,
          launchGeneration: status?.launchGeneration || null,
        });
        emitOrchestrationRun(deferred, reason + '-compact-finished-target-not-ready');
        return {
          dispatched: false,
          deferred: true,
          reason: 'target-not-ready-after-preparation',
          run: deferred,
        };
      }
    }

    const claimed = await store.claimDeferredDelivery(runId, {
      sessionId: status?.sessionId || null,
      lifecycleGeneration: status?.lifecycleGeneration || null,
      launchGeneration: status?.launchGeneration || null,
    });
    if (!claimed.claimed) {
      if (claimed.reason === 'delivery-outcome-unknown') {
        const recovery = await store.beginRecovery(
          runId,
          'failed',
          'delivery outcome is unknown; retry explicitly to avoid applying the prompt twice',
        );
        emitOrchestrationChanges(recovery.changed, reason + '-outcome-unknown');
        await finalizeSettledOrchestrations(recovery.settled, reason + '-outcome-unknown');
      } else if (claimed.reason === 'predecessor-not-materialized') {
        const deferred = await store.deferDelivery(runId, { reason: claimed.reason });
        emitOrchestrationRun(deferred, reason + '-predecessor');
      }
      return {
        dispatched: false,
        deferred: claimed.reason !== 'delivery-outcome-unknown',
        reason: claimed.reason,
        run: await store.get(runId),
      };
    }

    emitOrchestrationRun(claimed.run, reason + '-dispatching');
    const intent = claimed.intent;
    const sendOptions = resolveOrchestrationSendOptions({
      targetCreated: current.targetCreated === true,
      targetToolType: current.targetToolType,
      baselineStatus: deliveryAdmission.statusAtSend,
      queueRequested: false,
      model: intent.model || undefined,
      effort: intent.effort || undefined,
      thinking: intent.thinking || undefined,
    });
    const targetHandoffId = 'orchestration:' + current.runId;
    const targetSendOperationKey = 'orchestration-target:' + current.runId;
    const rawSendResult = await runAgentSendScenario({
      tabId: current.targetTabId,
      prompt: intent.prompt,
      workContextPrepared: true,
      model: sendOptions.model,
      effort: sendOptions.effort,
      thinking: sendOptions.thinking,
      cwd: current.targetCwd,
      handoffId: targetHandoffId,
      source: 'orchestration:' + current.sourceTabId,
      statusAtSend: deliveryAdmission.statusAtSend,
      // Independent orchestration runs must be distinct provider turns.  The
      // native Claude busy queue can merge a follow-up into the previous turn.
      queue: false,
      ownership: 'project',
      presentationSnapshot: orchestrationPresentationSnapshot(current, 'request'),
      provider: current.targetToolType || status?.toolType || status?.commandType || null,
      sessionId: status?.sessionId || current.sessionId || null,
      sendOperationKey: targetSendOperationKey,
      sendSurface: 'orchestration',
      sendRunId: current.runId,
      timeoutMs: agentSendBridgeTimeoutMs,
      onLateReceipt: async (lateReceipt, durableRecord) => {
        if (durableRecord?.surface !== 'orchestration'
          || durableRecord?.runId !== current.runId
          || durableRecord?.tabId !== current.targetTabId
          || durableRecord?.handoffId !== targetHandoffId) {
          console.warn('[OrchestrationDelivery] ignored foreign late receipt run=' + current.runId
            + ' operation=' + String(durableRecord?.operationKey || '-').slice(0, 72));
          return;
        }
        await applyOrchestrationTargetSendReceipt(current.runId, lateReceipt, {
          reason: reason + '-late-renderer-receipt',
          late: true,
        });
      },
    });
    const sendResult = {
      ...(rawSendResult && typeof rawSendResult === 'object' ? rawSendResult : {}),
      handoffId: targetHandoffId,
    };
    const appliedReceipt = await applyOrchestrationTargetSendReceipt(runId, sendResult, {
      reason,
      targetStatus: status,
    });
    if (appliedReceipt.kind === 'send-failed') {
      return { dispatched: false, deferred: false, reason: 'send-failed', sendResult, run: await store.get(runId) };
    }

    if (appliedReceipt.kind === 'delivery-unknown') {
      return {
        dispatched: true,
        deferred: false,
        reason: 'delivery-unknown',
        receiptState: appliedReceipt.receiptState,
        sendResult,
        run: appliedReceipt.run,
      };
    }
    return {
      dispatched: true,
      deferred: false,
      reason: null,
      receiptState: appliedReceipt.receiptState,
      sendResult,
      run: appliedReceipt.run,
    };
}

async function dispatchNextDeferredOrchestrationForTarget(tabId, reason = 'target-idle', targetStatus = null) {
  if (!tabId) return null;
  const store = getOrchestrationRunStore();
  const candidates = (await store.listAll())
    .filter((run) => run.targetTabId === tabId && !isTerminalStatus(run.status))
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  for (const candidate of candidates) {
    const internal = await store.getInternal(candidate.runId);
    if (!internal?.deliveryIntent) continue;
    return dispatchDeferredOrchestrationRun(candidate.runId, { reason, targetStatus });
  }
  return null;
}

async function runAgentStopScenario(tabId, timeoutMs = 5000, options = {}) {
  // The process Stop scenario already belongs to main (the desktop IPC uses
  // this same callback). A renderer reply deadline is not a stop outcome. Keep
  // awaiting the owned scenario even if the HTTP client disconnects; runtime
  // events continue and a late reply never schedules another Stop.
  if (typeof stopAgentProcess === 'function') {
    const result = await stopAgentProcess({ tabId, reason: options?.reason || null, authority: options?.authority || null });
    return { tabId, toolType: result?.toolType || result?.processName || null,
      stopped: result?.success === true, ...(result || {}) };
  }
  // Compatibility for isolated legacy hosts without the paired main caller.
  return await bridgeRequest('stopAgentProcessScenario', {
    tabId,
    reason: options?.reason || null,
    authority: options?.authority || null,
  }, timeoutMs);
}

async function runAgentInterruptScenario(tabId, timeoutMs = 2000, busy) {
  return await bridgeRequest('interruptAgentTurnScenario', {
    tabId,
    ...(typeof busy === 'boolean' ? { busy } : {}),
  }, timeoutMs);
}

async function runAgentGrabDraftScenario(tabId, timeoutMs = 5000) {
  return await bridgeRequest('grabAgentDraftScenario', { tabId }, timeoutMs);
}

async function runAgentInspectDraftScenario(tabId, timeoutMs = 5000) {
  return await bridgeRequest('inspectAgentDraftScenario', { tabId }, timeoutMs);
}

async function runAgentRewindScenario(tabId, payload, timeoutMs) {
  return await bridgeRequest('rewindAgentTimelineScenario', { tabId, ...payload }, timeoutMs);
}

async function runAgentAnswerQuestionScenario(payload) {
  if (!answerClaudeQuestion) {
    return { success: false, error: 'answer handler not wired' };
  }
  return await answerClaudeQuestion(payload);
}

function getAgentPendingQuestionScenario(tabId) {
  return getClaudePendingQuestion ? getClaudePendingQuestion(tabId) : null;
}

function promptFingerprint(prompt) {
  const normalized = String(prompt || '').replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function resolvePersistedPtyAgentOwner(tab) {
  if (!tab || (tab.tabType || 'terminal') === 'claude-sdk') return null;
  return resolveAiToolOwner({
    claudeSessionId: tab.claudeSessionId || null,
    codexSessionId: tab.codexSessionId || null,
    storedCommandType: tab.commandType || null,
  });
}

function resolveCurrentPtyAgentOwner(tab) {
  if (!tab) return null;
  const live = typeof resolveAgentToolType === 'function'
    ? resolveAgentToolType(tab.tabId)
    : null;
  if (live?.observed === true) return live.toolType || null;
  return resolvePersistedPtyAgentOwner(tab);
}

function findOrchestrationTabDescriptor(tabId) {
  if (!tabId) return null;
  try {
    const projectManager = require('./project-manager');
    for (const project of projectManager.db.getAllProjects()) {
      const tab = (project.tabs || []).find((item) => item.tabId === tabId);
      if (!tab) continue;
      const toolType = tab.tabType === 'claude-sdk'
        ? 'claude'
        : resolveCurrentPtyAgentOwner(tab);
      return {
        tabId,
        tabName: tab.name || tabId.slice(-12),
        projectId: project.id,
        projectName: project.name || path.basename(project.path || '') || project.id,
        projectPath: project.path || tab.cwd || null,
        cwd: tab.cwd || project.path || null,
        toolType,
        tabType: tab.tabType || 'terminal',
        commandType: tab.commandType || null,
        sessionId: toolType === 'codex'
          ? (tab.codexSessionId || null)
          : toolType === 'claude'
            ? (tab.claudeSessionId || null)
            : null,
        claudeSessionId: tab.claudeSessionId || null,
        codexSessionId: tab.codexSessionId || null,
        externalRun: tab.externalRun && typeof tab.externalRun === 'object'
          ? { ...tab.externalRun }
          : null,
      };
    }
  } catch (error) {
    console.warn('[Orchestration] tab lookup failed tab=' + shortId(tabId, 12) + ' error=' + (error?.message || error));
  }
  return null;
}

function findRestorableAgentTabDescriptor(tabId) {
  if (!tabId) {
    return {
      ok: false,
      code: 'target_tab_not_restorable',
      statusCode: 404,
      error: 'target tab is neither open nor present in restorable history',
    };
  }
  try {
    const projectManager = require('./project-manager');
    const entries = projectManager.db.getTabHistoryEntriesByTabId(tabId, 2);
    const projectId = entries.length === 1
      ? (entries[0].project_id || entries[0].projectId || null)
      : null;
    const project = projectId ? projectManager.db.getProjectById(projectId) : null;
    return resolveRestorableAgentTab({ tabId, historyEntries: entries, project });
  } catch (error) {
    return {
      ok: false,
      code: 'target_tab_restore_lookup_failed',
      statusCode: 500,
      error: String(error?.message || error),
    };
  }
}

function explicitAgentTargetError(resolution, fallbackCode = 'target_tab_restore_failed') {
  const error = new Error(resolution?.error || 'target tab restore failed');
  error.code = resolution?.code || fallbackCode;
  error.statusCode = Number(resolution?.statusCode) || 409;
  return error;
}

async function ensureExplicitAgentTabOpen(tabId, restorable = null) {
  const alreadyOpen = findOrchestrationTabDescriptor(tabId);
  if (alreadyOpen) return { descriptor: alreadyOpen, restored: false };

  const resolution = restorable?.ok === true
    ? restorable
    : findRestorableAgentTabDescriptor(tabId);
  if (resolution?.ok !== true) throw explicitAgentTargetError(resolution);

  return runSingleFlight(closedAgentRestoreInflight, tabId, async () => {
    const concurrentOpen = findOrchestrationTabDescriptor(tabId);
    if (concurrentOpen) return { descriptor: concurrentOpen, restored: false };

    let restored;
    try {
      restored = await bridgeRequest('restoreClosedAgentTab', {
        projectId: resolution.projectId,
        historyId: resolution.historyId,
        expectedTabId: tabId,
      }, 20_000);
    } catch (error) {
      // A manual restore can win the same history lease between the DB read
      // and bridge action. One exact post-event read is enough; never poll.
      const racedOpen = findOrchestrationTabDescriptor(tabId);
      if (racedOpen) return { descriptor: racedOpen, restored: false };
      throw explicitAgentTargetError({
        code: error?.bridgeData?.reason === 'busy'
          ? 'target_tab_restore_busy'
          : 'target_tab_restore_failed',
        statusCode: error?.code === 'bridge_unavailable' ? 503 : 409,
        error: error?.bridgeData?.message || error?.message || 'target tab restore failed',
      });
    }
    if (restored?.tabId !== tabId) {
      throw explicitAgentTargetError({
        code: 'target_tab_restore_identity_mismatch',
        statusCode: 409,
        error: 'restored tab does not match the requested target identity',
      });
    }

    const descriptor = findOrchestrationTabDescriptor(tabId);
    if (!descriptor || descriptor.projectId !== resolution.projectId) {
      throw explicitAgentTargetError({
        code: 'target_tab_restore_not_persisted',
        statusCode: 409,
        error: 'restored target was not durably persisted under its original identity',
      });
    }
    return { descriptor, restored: true };
  });
}

function revealTerminalApplicationWindow(reason = 'external-open-tab') {
  const windows = BrowserWindow.getAllWindows();
  const mainWindow = windows.find((win) => {
    if (!win || win.isDestroyed()) return false;
    const title = String(win.getTitle?.() || '');
    const page = String(win.webContents?.getURL?.() || '');
    return /^Noted Terminal(?:\s|$)/.test(title)
      && !page.startsWith('devtools://');
  }) || null;
  if (!mainWindow) return { ok: false, revealed: false, reason: 'main_window_not_found' };
  if (process.env.NOTED_E2E_WINDOWED === '1') {
    return { ok: true, revealed: false, e2eSuppressed: true, reason };
  }
  try {
    mainWindow.show();
    if (process.platform === 'darwin') {
      mainWindow.moveTop();
      app.focus({ steal: true });
    }
    mainWindow.focus();
    return { ok: true, revealed: true, reason };
  } catch (error) {
    return { ok: false, revealed: false, reason: 'main_window_reveal_failed', error: String(error?.message || error) };
  }
}

async function openAgentTabInWorkspace({ tabId, spaceId = '', workspaceName = 'Докс', windowIndex = 0 } = {}) {
  const exactTabId = cleanOptionalString(tabId, '');
  if (!exactTabId) throw Object.assign(new Error('tabId required'), { statusCode: 400 });
  const opened = await ensureExplicitAgentTabOpen(exactTabId);
  const descriptor = opened?.descriptor;
  if (!descriptor?.projectId) {
    throw Object.assign(new Error('restored tab has no project identity'), { statusCode: 409 });
  }
  if (descriptor.toolType !== 'codex') {
    throw Object.assign(new Error('bound Inbox tab is not a Codex tab'), {
      code: 'inbox_tab_provider_mismatch', statusCode: 409,
    });
  }

  const snapshot = await bridgeRequest('describeWorkspaceLayout', { sourceTabId: exactTabId }, 5000);
  const spaces = Array.isArray(snapshot?.spaces) ? snapshot.spaces : [];
  const exactSpaceId = cleanOptionalString(spaceId, '');
  const normalizedName = cleanOptionalString(workspaceName, 'Докс').toLocaleLowerCase('ru-RU');
  const matches = exactSpaceId
    ? spaces.filter((space) => space?.id === exactSpaceId)
    : spaces.filter((space) => String(space?.name || '').trim().toLocaleLowerCase('ru-RU') === normalizedName);
  if (matches.length === 0) {
    throw Object.assign(new Error('workspace not found: ' + (exactSpaceId || workspaceName || 'Докс')), {
      code: 'workspace_not_found', statusCode: 404,
    });
  }
  if (matches.length > 1) {
    throw Object.assign(new Error('workspace name is ambiguous: ' + workspaceName), {
      code: 'workspace_ambiguous', statusCode: 409,
    });
  }
  const space = matches[0];
  const requestedWindowIndex = Number.isInteger(Number(windowIndex)) && Number(windowIndex) >= 0
    ? Number(windowIndex)
    : 0;
  const targetWindow = Array.isArray(space.windows) ? space.windows[requestedWindowIndex] : null;
  if (!targetWindow?.windowRef) {
    throw Object.assign(new Error('workspace window not found'), {
      code: 'workspace_window_not_found', statusCode: 409,
    });
  }

  const placement = await bridgeRequest('commitWorkspaceWindowAction', {
    sourceTabId: exactTabId,
    windowTarget: {
      spaceId: space.id,
      windowRef: targetWindow.windowRef,
      mode: 'same-window',
      insertIndex: Array.isArray(targetWindow.tabs) ? targetWindow.tabs.length : 0,
      reveal: true,
    },
    entries: [{ projectId: descriptor.projectId, tabId: exactTabId }],
    show: true,
    focus: true,
    reveal: true,
    moveExisting: true,
  }, 8000);
  if (placement?.ok !== true) {
    throw Object.assign(new Error(placement?.reason || 'workspace placement failed'), {
      code: placement?.reason || 'workspace_placement_failed', statusCode: 409,
    });
  }

  // Once the user explicitly opens the background Inbox tab, automated cleanup
  // no longer owns it. Otherwise a previously armed timer can close the tab under
  // the user's cursor seconds after this navigation succeeds.
  const runId = externalRunByTabId.get(exactTabId);
  const run = runId ? externalRuns.get(runId) : null;
  if (run) {
    run.cleanupCancelled = true;
    run.openedInTerminalAt = Date.now();
    clearExternalRunTimer(run, 'stopTimer');
    clearExternalRunTimer(run, 'closeTimer');
    run.autoStopAt = null;
    run.autoCloseAt = null;
    setExternalRunMeta(exactTabId, {
      openedInTerminalAt: run.openedInTerminalAt,
      autoStopAt: null,
      autoCloseAt: null,
    });
  }

  const reveal = revealTerminalApplicationWindow('voice-open-in-terminal');
  return {
    ok: true,
    tabId: exactTabId,
    projectId: descriptor.projectId,
    restored: opened.restored === true,
    spaceId: space.id,
    spaceName: space.name,
    windowIndex: requestedWindowIndex,
    placement,
    reveal,
  };
}

async function resolveHistorySessionInfo(tabId, timeoutMs = 1500) {
  // Claude History is a durable data read, not a renderer/presence question.
  // Prefer the persisted tab binding so a hidden, reloading or absent window
  // cannot add latency or make server-side history unavailable.
  const persisted = findOrchestrationTabDescriptor(tabId);
  if (persisted?.toolType === 'claude' && persisted.sessionId) return persisted;
  if (persisted?.toolType === 'codex' && typeof resolveCodexRuntimeProjectionBatch === 'function') {
    const runtime = resolveCodexRuntimeProjectionBatch([
      { tabId, savedSessionId: persisted.sessionId || null },
    ], persisted.projectId || null)?.[tabId];
    return historyReadOwnerFromProjection(persisted, runtime, true);
  }
  return historyReadSession(await resolveAgentSessionInfo(tabId, timeoutMs));
}

function historyFreshnessReadOwners(tabIds) {
  const db = require('./project-manager').db;
  const rows = db.getHistoryReadTabDescriptors(tabIds).map(row => {
    const toolType = row.tabType === 'claude-sdk' ? null : resolveCurrentPtyAgentOwner(row);
    return { ...row, toolType, sessionId: toolType === 'codex' ? row.codexSessionId : row.claudeSessionId };
  });
  const codex = rows.filter(row => row.toolType === 'codex');
  const available = typeof resolveCodexRuntimeProjectionBatch === 'function';
  const projection = available ? resolveCodexRuntimeProjectionBatch(codex.map(row => ({
    tabId: row.tabId, savedSessionId: row.sessionId || null,
  })), null) || {} : {};
  return new Map(rows.map(row => [row.tabId,
    historyReadOwnerFromProjection(row, projection[row.tabId], available)
      || { ...row, sessionId: null }]));
}

async function readPublicHistoryFreshness(tabIds) {
  const owner = publicHistoryFreshness;
  if (!owner) throw Object.assign(new Error('history_freshness_unavailable'), { statusCode: 503 });
  const started = Date.now();
  const scopes = historyFreshnessReadOwners(tabIds);
  const snapshots = new Array(tabIds.length); let index = 0;
  const jobs = Array.from({ length: Math.min(4, tabIds.length) }, async () => {
    while (index < tabIds.length) {
      const position = index++, tabId = tabIds[position];
      const scope = scopes.get(tabId) || { tabId };
      const budget = Math.min(1000, 2000 - (Date.now() - started));
      snapshots[position] = budget > 0 ? await owner.probe(scope, budget)
        : owner.envelope(scope, 'unknown', { reason: 'batch-budget-exceeded', revalidate: true });
    }
  });
  await Promise.all(jobs);
  const current = historyFreshnessReadOwners(tabIds);
  for (let i = 0; i < tabIds.length; i++) {
    const scope = current.get(tabIds[i]) || { tabId: tabIds[i] };
    if (historyFreshnessScopeKey(scope) !== historyFreshnessScopeKey(scopes.get(tabIds[i]) || { tabId: tabIds[i] })) {
      snapshots[i] = owner.envelope(scope, 'unknown', { reason: 'read-owner-changed', revalidate: true });
    }
  }
  const result = { ok: true, epoch: owner.epoch, snapshots };
  console.log('[HistoryFreshness] batch tabs=' + tabIds.length + ' known='
    + snapshots.filter(s => s.state === 'known').length + ' bytes=' + Buffer.byteLength(JSON.stringify(result))
    + ' ms=' + (Date.now() - started));
  return result;
}

async function readHistoryFreshnessWindow({ info, readScope, requestedRevision, deltaOk }) {
  const owner = publicHistoryFreshness;
  const scope = { ...readScope, readIdentitySource: info.readIdentitySource };
  const prior = publicHistoryRevisions.lookup(requestedRevision, readScope);
  const priorCoverage = publicHistoryRevisions.lookupFreshness(requestedRevision, readScope);
  const head = await owner.probe(scope);
  if (prior && priorCoverage?.state === 'known' && head.state === 'known'
    && priorCoverage.epoch === head.epoch && priorCoverage.token === head.token) {
    return { success: true, unchanged: true, revision: prior, historyFreshness: head };
  }
  const ticket = await owner.beginRead(scope);
  const result = await transcriptService.getHistory({ ...readScope, ifRevision: prior,
    freshnessProof: true, deltaOk,
    deltaConsumerId: deltaOk ? 'http:' + crypto.createHash('sha256').update(JSON.stringify(readScope)).digest('hex') : null,
  });
  if (!result?.success) return result;
  const historyFreshness = await owner.bounded(scope, owner.completeRead(scope, result, ticket));
  const { freshnessReadSources: _sources, freshnessReader: _reader, ...data } = result;
  return { ...data, historyFreshness };
}

function findOrchestrationProjectDescriptor(projectId) {
  if (!projectId) return null;
  try {
    const projectManager = require('./project-manager');
    const project = projectManager.db.getProjectById(projectId);
    if (!project) return null;
    return {
      projectId: project.id || projectId,
      projectName: project.name || path.basename(project.path || '') || projectId,
      projectPath: project.path || null,
      cwd: project.path || null,
    };
  } catch (error) {
    console.warn('[Orchestration] project lookup failed project=' + shortId(projectId, 12)
      + ' error=' + (error?.message || error));
    return null;
  }
}

function orchestrationUrls(run) {
  const runId = encodeURIComponent(run.runId);
  return {
    statusUrl: '/api/orchestrations/' + runId,
    resultUrl: '/api/orchestrations/' + runId + '/result',
    cancelUrl: '/api/orchestrations/' + runId + '/cancel',
    eventsUrl: '/api/events?tabId=' + encodeURIComponent(run.sourceTabId),
  };
}

function withOrchestrationUrls(run) {
  return run ? { ...run, ...orchestrationUrls(run) } : null;
}

async function assertExternalResearchCapabilities(provider) {
  let capabilities;
  try {
    capabilities = await getScExternalResearchClient().capabilities();
  } catch (cause) {
    const error = new Error('SC Desktop external research API is unavailable: '
      + String(cause?.message || cause));
    error.code = 'external_research_capability_unavailable';
    error.statusCode = 503;
    throw error;
  }
  if (Number(capabilities?.version) !== 1
    || capabilities?.idempotentRequestId !== true
    || !Array.isArray(capabilities?.statusRecovery)
    || !capabilities.statusRecovery.includes('durable-request')
    || capabilities?.continuation?.conversationUrl !== true
    || capabilities?.continuation?.separateJobPerTurn !== true) {
    const error = new Error('SC Desktop does not expose idempotent external research orchestration');
    error.code = 'external_research_capability_unavailable';
    error.statusCode = 503;
    throw error;
  }
  if (!Array.isArray(capabilities.providers) || !capabilities.providers.includes(provider)) {
    const error = new Error(`SC Desktop does not support tracked requestId for provider=${provider}`);
    error.code = 'external_research_provider_unsupported';
    error.statusCode = 400;
    throw error;
  }
  return capabilities;
}

async function reconcileExternalResearchRun(runId, reason = 'external-research-reconcile') {
  const store = getOrchestrationRunStore();
  const current = await store.getInternal(runId);
  if (!isExternalResearchRun(current)) return current ? store.get(runId) : null;
  if (isTerminalStatus(current.status)) return store.get(runId);
  try {
    const snapshot = await getExternalResearchCoordinator().readStatus(runId);
    if (snapshot) {
      const applied = await store.applyExternalResearchSnapshot(runId, snapshot);
      emitOrchestrationChanges(applied.changed, reason);
      for (const settled of applied.settled || []) {
        await finalizeSettledOrchestration(settled, reason + '-terminal');
      }
    }
  } catch (error) {
    const waiting = await store.markExternalResearchTransportWait(runId, {
      error: String(error?.message || error),
      retryAt: Date.now() + 1000,
    });
    if (waiting) emitOrchestrationRun(waiting, reason + '-transport-wait');
  }
  const after = await store.get(runId);
  if (after && !isTerminalStatus(after.status)) {
    getExternalResearchCoordinator().watch(runId, reason + '-watch');
  }
  return after;
}

function externalResearchAnswerText(snapshot) {
  const result = snapshot?.result;
  if (!result || typeof result !== 'object') return '';
  for (const field of ['document_text', 'text', 'answer_text']) {
    if (typeof result[field] === 'string' && result[field].length > 0) return result[field];
  }
  return '';
}

function boundedExternalResearchResult(result, maxChars) {
  if (!result || typeof result !== 'object') return null;
  const bounded = { ...result };
  const truncatedFields = [];
  for (const field of ['text', 'answer_text', 'document_text', 'reasoning_text']) {
    if (typeof bounded[field] !== 'string' || bounded[field].length <= maxChars) continue;
    bounded[field] = bounded[field].slice(0, maxChars);
    truncatedFields.push(field);
  }
  if (truncatedFields.length > 0) bounded.truncatedFields = truncatedFields;
  return bounded;
}

async function readExternalResearchResult(runId, maxChars) {
  const store = getOrchestrationRunStore();
  let run = await reconcileExternalResearchRun(runId, 'external-result-read');
  if (!run) return { statusCode: 404, body: { ok: false, error: 'run not found' } };
  if (isActiveStatus(run.status)) {
    return {
      statusCode: 202,
      body: { ok: true, ready: false, status: run.status, run: withOrchestrationUrls(run) },
    };
  }

  let snapshot = null;
  if (run.status !== 'completed') {
    try {
      snapshot = await getScExternalResearchClient().status(run.externalResearchJobId, { waitMs: 0 });
    } catch {}
    const assistantText = externalResearchAnswerText(snapshot);
    const truncated = assistantText.length > maxChars;
    return {
      statusCode: 200,
      body: {
        ok: true,
        ready: true,
        success: false,
        runId,
        runKind: 'external-research',
        status: run.status,
        outcome: run.outcome || run.status,
        provider: run.externalResearchProvider || snapshot?.provider || null,
        jobId: run.externalResearchJobId,
        conversationUrl: snapshot?.conversationUrl
          || snapshot?.result?.url
          || snapshot?.url
          || run.externalResearchConversationUrl
          || null,
        conversationId: snapshot?.conversationId || run.externalResearchConversationId || null,
        continuedFromRunId: run.externalResearchContinuedFromRunId || null,
        error: snapshot?.error || run.error || 'external research failed',
        assistantText: truncated ? assistantText.slice(0, maxChars) : assistantText,
        assistantChars: assistantText.length,
        truncated,
        externalResult: boundedExternalResearchResult(snapshot?.result, maxChars),
      },
    };
  }
  try {
    snapshot = await getScExternalResearchClient().status(run.externalResearchJobId, { waitMs: 0 });
  } catch (error) {
    return {
      statusCode: Number(error?.status || error?.statusCode) === 404 ? 409 : 503,
      body: {
        ok: false,
        ready: false,
        code: error?.code || 'external_research_result_unavailable',
        error: String(error?.message || error),
        run: withOrchestrationUrls(run),
      },
    };
  }
  if (!isScResearchTerminalStatus(snapshot?.status)) {
    return {
      statusCode: 202,
      body: { ok: true, ready: false, status: run.status, run: withOrchestrationUrls(run) },
    };
  }

  const assistantText = externalResearchAnswerText(snapshot);
  const truncated = assistantText.length > maxChars;
  const visibleText = truncated ? assistantText.slice(0, maxChars) : assistantText;
  const conversationUrl = snapshot?.conversationUrl
    || snapshot?.result?.url
    || snapshot?.url
    || run.externalResearchConversationUrl
    || null;
  const success = snapshot.status === 'done' && run.status === 'completed';
  return {
    statusCode: 200,
    body: {
      ok: true,
      ready: true,
      success,
      runId,
      runKind: 'external-research',
      status: run.status,
      outcome: run.outcome || (success ? 'success' : 'failed'),
      provider: run.externalResearchProvider || snapshot.provider || null,
      jobId: run.externalResearchJobId,
      conversationUrl,
      conversationId: snapshot?.conversationId || run.externalResearchConversationId || null,
      continuedFromRunId: run.externalResearchContinuedFromRunId || null,
      error: success ? null : (snapshot.error || run.error || 'external research failed'),
      assistantText: visibleText,
      assistantChars: assistantText.length,
      truncated,
      externalResult: boundedExternalResearchResult(snapshot.result, maxChars),
    },
  };
}

function emitOrchestrationRun(run, reason = 'changed') {
  if (run && (isTerminalStatus(run.status) || run.status === 'waiting_recovery')
    && run.targetTabId
    && !run.deliveryDispatchStartedAt && !run.targetPromptProofAt) {
    tabWorkContext?.release(run.targetTabId, 'orchestration:' + run.runId);
  }
  if (!run) return;
  const payload = { type: 'orchestration-update', reason, run: withOrchestrationUrls(run) };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('orchestration:changed', payload);
  }
  const tabIds = new Set([run.sourceTabId, run.targetTabId].filter(Boolean));
  for (const tabId of tabIds) webBroadcast(tabId, payload);
}

async function probeOrchestrationResult(run, {
  maxChars = 100_000,
  sessionInfo = null,
  forceFresh = false,
  resultReadMode = 'authoritative',
  resultAttempt = captureOrchestrationResultAttempt(run),
} = {}) {
  if (!run || typeof getAgentTurnResult !== 'function') {
    return { found: false, resultAvailable: false, sourceVerified: false,
      error: 'result reader unavailable', resultAttempt };
  }
  const lookup = resultAttempt?.lookup || buildOrchestrationResultLookup(run);
  const toolType = resultAttempt?.targetToolType || lookup.targetExecutionContext?.provider || null;
  const { targetTabId, sessionId: storedSessionId, targetCwd, targetProjectPath } = resultAttempt || run;
  const info = sessionInfo || await resolveAgentSessionInfo(targetTabId, 2000).catch(() => null);
  const sessionId = lookup.targetExecutionContext?.sessionId || storedSessionId || info?.sessionId || null;
  const cwd = targetCwd || info?.cwd || targetProjectPath || null;
  if (!sessionId) return { found: false, resultAvailable: false, sourceVerified: false, sessionId: null, resultAttempt };
  try {
    const result = await getAgentTurnResult({
      toolType,
      sessionId,
      cwd,
      ...lookup,
      forceFresh,
      resultReadMode,
      maxChars,
    });
    return {
      ...(result || {}),
      found: result?.found === true,
      resultComplete: result?.complete === true,
      resultAvailable: typeof result?.assistantText === 'string' && result.assistantText.length > 0,
      sessionId,
      resultAttempt,
    };
  } catch (error) {
    return { found: false, resultAvailable: false, sourceVerified: false,
      sessionId, error: String(error?.message || error), resultAttempt };
  }
}

function emitOrchestrationChanges(changed, reason) {
  for (const run of Array.isArray(changed) ? changed : []) emitOrchestrationRun(run, reason);
}

function orchestrationNotificationText(run) {
  const baseUrl = 'http://127.0.0.1:' + resolvedPort;
  const success = run.status === 'completed';
  const executor = isExternalResearchRun(run)
    ? `${run.targetTabName || 'Browser research'} via SC Desktop`
    : `${run.targetTabName || run.targetTabId} (${run.targetToolType || 'agent'})`;
  return [
    success ? '[Оркестрация] Запрос завершён.' : '[Оркестрация] Запрос завершён с ошибкой.',
    'runId: ' + run.runId,
    'Исполнитель: ' + executor + '.',
    success ? null : 'Исход: ' + (run.outcome || run.status) + '. ' + (run.error || 'Подробности не указаны.'),
    'Результат не вставлен в сообщение. Получи его одним запросом:',
    'Terminal MCP: get_delegation_result({ runId: "' + run.runId + '" })',
    'HTTP fallback: curl -sS -H "Authorization: Bearer $(cat ~/.noted-terminal/web-token.txt)" "' + baseUrl + '/api/orchestrations/' + encodeURIComponent(run.runId) + '/result"',
    'Не опрашивай статус повторно. После получения результата продолжи исходную задачу.',
  ].filter(Boolean).join('\n');
}

function orchestrationPresentationSnapshot(run, phase, content = null, preparedPrompt = null) {
  if (!run?.runId) return null;
  const promptChips = phase === 'request' && Array.isArray(run.deliveryIntent?.promptChips)
    ? run.deliveryIntent.promptChips
    : [];
  return {
    ...(promptChips.length > 0 ? { promptChips } : {}),
    semanticTags: [{
      kind: 'orchestration',
      runId: run.runId,
      phase,
      parentRunId: run.parentRunId || undefined,
      sourceTabId: run.sourceTabId || undefined,
      targetTabId: run.targetTabId || undefined,
      sourceTabName: run.sourceTabName || undefined,
      targetTabName: run.targetTabName || undefined,
      sourceProjectId: run.sourceProjectId || undefined,
      targetProjectId: run.targetProjectId || undefined,
      runKind: run.runKind || 'agent',
      externalProvider: run.externalResearchProvider || undefined,
      outcome: run.outcome || undefined,
      ...(content && typeof preparedPrompt === 'string' && preparedPrompt.endsWith(content.prompt)
        && Number.isSafeInteger(content.bodyStart) && Number.isSafeInteger(content.bodyEnd)
        ? { envelopeStart: preparedPrompt.length - content.prompt.length,
          envelopeText: content.prompt.slice(0, content.bodyStart),
          bodyProjectionHash: crypto.createHash('sha256').update(preparedPrompt, 'utf8').digest('hex'),
          bodyStart: preparedPrompt.length - content.prompt.length + content.bodyStart,
          bodyEnd: preparedPrompt.length - content.prompt.length + content.bodyEnd } : {}),
    }],
  };
}

async function sendOrchestrationCompletionNotification(run, options = {}) {
  if (!run?.runId || orchestrationNotificationInflight.has(run.runId)) return;
  const store = getOrchestrationRunStore();
  const current = await store.getInternal(run.runId);
  if (!current || !isTerminalStatus(current.status)) return;
  if (current.status === 'completed' && current.resultComplete !== true) return;
  if (current.notifySource === false || current.notificationSuppressed) return;
  if (['audit-pending', 'sent', 'queued', 'suppressed', 'source-closed'].includes(current.notificationStatus)) return;
  if (current.notificationStatus === 'unconfirmed' && options.force !== true) return;
  if (current.notificationCancelRequestedAt && !current.sourceFollowupStartedAt) {
    const suppressed = await store.markNotification(current.runId, 'suppressed', {
      notificationDismissedAt: Date.now(),
      notificationError: null,
    });
    emitOrchestrationChanges(suppressed?.changed, 'notification-cancelled');
    for (const settled of suppressed?.settled || []) {
      await finalizeSettledOrchestration(settled, 'ancestor-settled');
    }
    return;
  }
  if (!current.sourceTabId || current.sourceTabId === current.targetTabId) {
    const suppressed = await store.markNotification(current.runId, 'suppressed');
    emitOrchestrationChanges(suppressed?.changed, 'notification-suppressed');
    return;
  }

  orchestrationNotificationInflight.add(run.runId);
  let notificationText = orchestrationNotificationText(current);
  const notificationHandoffId = 'orchestration-complete:' + current.runId;
  try {
    const completionContent = await prepareOrchestrationCompletionContent(current);
    if (completionContent) notificationText = completionContent.prompt;
    const status = await resolveAgentSessionInfo(current.sourceTabId, 2000);
    if (!status) {
      await releaseOrchestrationSourceProof(current.runId, 'source-unavailable');
      const sourceClosed = await store.markNotification(current.runId, 'source-closed', {
        notificationSuppressed: true,
        notificationError: 'source tab unavailable',
      });
      emitOrchestrationChanges(sourceClosed?.changed, 'notification-source-closed');
      return;
    }
    const sourceSendOptions = resolveOrchestrationSourceNotificationSendOptions(status);
    const completionTarget = completionContent ? current.sourceSendTarget || {
      toolType: current.sourceToolType || current.sourceExecutionContext?.provider
        || status.toolType || status.commandType,
      sessionId: completionContent.metadata.sourceSessionId || current.notificationSourceSessionId
        || current.sourceExecutionContext?.sessionId || null,
    } : null;
    if (completionTarget) {
      const actual = await readScenarioDestination(current.sourceTabId);
      const failure = agentSendTargetPreconditionFailure(completionTarget, actual);
      if (failure) throw Object.assign(new Error(failure.error), failure);
    }
    if (tabWorkContext && (!current.notificationPromptAuditHash
      || tabWorkContext.hasHandoff(current.sourceTabId, notificationHandoffId))) {
      notificationText = (await tabWorkContext.prepare(current.sourceTabId, notificationHandoffId, notificationText)).prompt;
    }
    const notificationAttempt = Number(current.notificationAttempt || 0) + 1;
    const sending = await store.markNotification(current.runId, 'sending', {
      notificationAttempt,
      notificationAttemptedAt: Date.now(),
      notificationPromptHash: promptFingerprint(notificationText),
      notificationPromptAuditHash: promptAuditFingerprint(notificationText),
      notificationHandoffId,
      notificationDeferredAt: null,
      notificationDeferredReason: null,
    });
    emitOrchestrationChanges(sending?.changed, 'notification-sending');
    const notificationSourceSessionId = status?.sessionId || current.notificationSourceSessionId || null;
    if (notificationSourceSessionId) {
      await store.bindNotificationSourceSession(current.runId, notificationSourceSessionId);
      const proofRun = await store.getInternal(current.runId);
      const armed = await armOrchestrationSourceProof(proofRun, status);
      if (armed?.success !== true) {
        console.warn('[OrchestrationSourceProof] arm failed run=' + current.runId
          + ' error=' + (armed?.error || 'unknown'));
      }
    }
    const result = await runAgentSendScenario({
      tabId: current.sourceTabId,
      prompt: notificationText,
      workContextPrepared: true,
      handoffId: notificationHandoffId,
      // Reserve the existing History identity before entering the shared FIFO.
      // Without it the renderer re-admits this same handoff into its caller's
      // in-memory registry, causing a fingerprint conflict (or a self-join).
      sendOperationKey: `history:${current.sourceTabId}:${notificationHandoffId}`,
      sendSurface: 'desktop-history',
      source: 'orchestration-completion:' + current.runId,
      statusAtSend: sourceSendOptions.statusAtSend,
      queue: sourceSendOptions.queue,
      ownership: 'project',
      presentationSnapshot: orchestrationPresentationSnapshot(
        current,
        current.status === 'completed' ? 'completion' : 'failure',
        completionContent,
        notificationText,
      ),
      provider: status?.toolType || status?.commandType || null,
      sessionId: notificationSourceSessionId,
      ...(completionTarget ? { expectedTarget: completionTarget } : {}),
      timeoutMs: 60_000,
    });
    const sendReceipt = classifyAgentSendReceipt(result);
    if (sendReceipt.state === 'not-submitted'
      || sendReceipt.state === AGENT_SEND_RECEIPT_STATES.PROVIDER_NOT_ACCEPTED) {
      await releaseOrchestrationSourceProof(current.runId, 'notification-send-failed');
      const latest = await store.getInternal(current.runId);
      if (result?.error === 'agent_send_cancelled' || latest?.notificationCancelRequestedAt) {
        const suppressed = await store.markNotification(current.runId, 'suppressed', {
          notificationDismissedAt: Date.now(),
          notificationError: null,
        });
        emitOrchestrationChanges(suppressed?.changed, 'notification-cancelled');
        for (const settled of suppressed?.settled || []) {
          await finalizeSettledOrchestration(settled, 'ancestor-settled');
        }
        return;
      }
      const notificationStatus = (
        result?.code === 'terminal_draft_conflict'
        || sendReceipt.state === AGENT_SEND_RECEIPT_STATES.PROVIDER_NOT_ACCEPTED
      )
        ? 'waiting-for-input'
        : 'failed';
      const failed = await store.markNotification(current.runId, notificationStatus, {
        notificationError: result?.error || result?.message || 'notification send failed',
      });
      emitOrchestrationChanges(failed?.changed, 'notification-finished');
    } else if (isAgentSendProviderQueueAccepted(result)) {
      const delivered = await store.markNotification(current.runId, 'queued', {
        notificationDeliveredAt: Date.now(),
        notificationError: null,
        notificationAuditPendingAt: null,
        notificationCancelRequestedAt: null,
      });
      emitOrchestrationChanges(delivered?.changed, 'notification-provider-queued');
    } else if (sendReceipt.state === 'delivery-unknown') {
      const unknown = await store.markNotification(current.runId, 'unconfirmed', {
        notificationAuditPendingAt: null,
        notificationError: result?.code || 'bridge_timeout_delivery_unknown',
        notificationCancelRequestedAt: null,
      });
      emitOrchestrationChanges(unknown?.changed, 'notification-delivery-unknown');
    } else if (sendReceipt.state === 'audit-pending') {
      const pending = await store.markNotification(current.runId, 'unconfirmed', {
        notificationAuditPendingAt: Date.now(),
        notificationError: 'Enter пересечён, но точное подтверждение доставки пока не найдено',
        notificationUnconfirmedAt: Date.now(),
        notificationUnconfirmedReason: 'source-followup-audit-timeout',
        notificationCancelRequestedAt: null,
      });
      emitOrchestrationChanges(pending?.changed, 'notification-unconfirmed');
    } else {
      const delivered = await store.markNotification(current.runId, result?.queued ? 'queued' : 'sent', {
        notificationDeliveredAt: Date.now(),
        notificationError: null,
        // Cancellation is checked immediately before Enter. If the send still
        // succeeds, the request arrived after that boundary and cannot retract
        // the provider message; do not leave the UI claiming cancellation.
        notificationCancelRequestedAt: null,
      });
      emitOrchestrationChanges(delivered?.changed, 'notification-finished');
      const audit = result?.codexAudit || result?.pasteAudit || null;
      if (audit?.success === true) {
        await notifyAgentPromptAuditResult({
          tabId: current.sourceTabId,
          handoffId: notificationHandoffId,
          sendOperationKey: result.operationKey || null,
          sendAttemptId: result.attemptId || null,
          source: 'orchestration-completion:' + current.runId,
          success: true,
          toolType: audit.executionContext?.provider
            || status?.commandType
            || status?.toolType
            || null,
          auditTimestamp: audit.auditTimestamp || null,
          actualHash: audit.actualHash || null,
          expectedHash: audit.expectedHash || null,
          expectedLen: Number.isFinite(audit.expectedLen) ? Number(audit.expectedLen) : null,
          actualLen: Number.isFinite(audit.actualLen) ? Number(audit.actualLen) : null,
          sessionId: audit.sessionId || null,
          entryUuid: audit.entryUuid || null,
          sourceIdentity: audit.sourceIdentity || null,
          executionContext: audit.executionContext || null,
          queuedAtSubmit: audit.queuedAtSubmit === true,
        });
      }
      const deliveredRun = await store.getInternal(current.runId);
      const sourceProof = await reconcileOrchestrationSourceFollowup(
        deliveredRun,
        'notification-transcript-proof',
      );
      if (sourceProof?.confirmed === true) {
        await releaseOrchestrationSourceProof(current.runId, 'source-followup-proved');
      }
      for (const settled of delivered?.settled || []) {
        await finalizeSettledOrchestration(settled, 'ancestor-settled');
      }
    }
  } catch (error) {
    await releaseOrchestrationSourceProof(current.runId, 'notification-send-threw');
    console.warn('[OrchestrationContent] delivery-failed run=' + current.runId
      + ' source=' + current.sourceTabId + ' code=' + (error?.code || 'notification_error')
      + ' error=' + String(error?.message || error).slice(0, 500));
    const latest = await store.getInternal(current.runId);
    if (latest?.notificationCancelRequestedAt) {
      const suppressed = await store.markNotification(current.runId, 'suppressed', {
        notificationDismissedAt: Date.now(),
        notificationError: null,
      });
      emitOrchestrationChanges(suppressed?.changed, 'notification-cancelled');
      for (const settled of suppressed?.settled || []) {
        await finalizeSettledOrchestration(settled, 'ancestor-settled');
      }
      return;
    }
    const failed = await store.markNotification(current.runId, 'failed', {
      notificationError: String(error?.message || error),
    });
    emitOrchestrationChanges(failed?.changed, 'notification-finished');
  } finally {
    orchestrationNotificationInflight.delete(run.runId);
  }
}

async function notifyAgentPromptAuditResult(detail = {}) {
  // This main-owned receipt is the send authority for ordinary Project API,
  // Terminal MCP and Inbox retries. Promote it before the feature-specific
  // orchestration projections consume the same exact audit.
  const durableOperationKey = cleanOptionalString(detail?.sendOperationKey, '');
  const durableAttemptId = cleanOptionalString(detail?.sendAttemptId, '');
  const durableAuditTabId = cleanOptionalString(detail?.tabId, '');
  const durableAuditHandoffId = cleanOptionalString(detail?.handoffId, '');
  const durableCandidates = agentSendReceiptStore
    && durableAuditTabId
    && durableAuditHandoffId
    ? agentSendReceiptStore.list({ tabId: durableAuditTabId })
      .filter((record) => record.handoffId === durableAuditHandoffId)
    : [];
  const durableRecordForAudit = agentSendReceiptStore && durableOperationKey
    ? agentSendReceiptStore.get(durableOperationKey)
    : durableCandidates.length === 1
      ? durableCandidates[0]
      : null;
  const durableIdentityRequired = !!agentSendReceiptStore && (
    !!durableOperationKey
    || !!durableAttemptId
    || durableCandidates.length > 0
  );
  const durableIdentityComplete = !!durableOperationKey && !!durableAttemptId;
  let durablePromotion = null;
  if (durableIdentityRequired && !durableIdentityComplete) {
    durablePromotion = {
      ok: false,
      matched: durableCandidates.length > 0,
      promoted: false,
      reason: 'durable-audit-identity-missing',
      record: durableRecordForAudit,
    };
    console.warn('[AgentSendReceipt] reject audit without exact durable identity tab='
      + shortId(detail?.tabId, 12)
      + ' handoff=' + String(detail?.handoffId || '-').slice(0, 32)
      + ' candidates=' + durableCandidates.length);
  } else if (agentSendReceiptStore && durableIdentityComplete) {
    durablePromotion = agentSendReceiptStore.promoteFromAudit({
      ...detail,
      operationKey: durableOperationKey,
      attemptId: durableAttemptId,
      promptHash: detail?.expectedHash || detail?.promptHash || detail?.actualHash,
      actualHash: detail?.actualHash || detail?.promptHash,
    });
    console.log('[AgentSendReceipt] durable audit op=' + durableOperationKey.slice(0, 72)
      + ' attempt=' + durableAttemptId.slice(0, 24)
      + ' promoted=' + (durablePromotion?.promoted === true)
      + ' reason=' + (durablePromotion?.reason || '-'));
  }
  const durableAuditAccepted = !durableIdentityRequired || !agentSendReceiptStore
    || durablePromotion?.promoted === true
    || (durablePromotion?.idempotent === true && durablePromotion?.record?.state === 'confirmed');
  if (durableAuditAccepted && durablePromotion?.record?.state === 'confirmed'
    && (durablePromotion.record.receipt?.imageRequestProjection
      || durablePromotion.record.receipt?.ownedAttachmentProjection
      || durablePromotion.record.provider === 'claude')) {
    try {
      backfillConfirmedCanonicalAuthoringPresentations(
        require(path.join(srcMainDir, 'project-manager')).db, [durablePromotion.record],
      );
    } catch (error) {
      console.warn('[HistoryAuthoringProjection] audit persistence failed:', error?.message || error);
    }
  }
  if (durableAuditAccepted && detail?.success === true) {
    tabWorkContext?.confirm(detail.tabId, detail.handoffId, detail.expectedHash || detail.actualHash);
  } else {
    tabWorkContext?.settle(detail.tabId, detail.handoffId, detail);
  }
  if (tabMessageService) await tabMessageService.reconcileReceipts(detail.tabId, 'prompt-audit');
  const sendReceiptPromotion = durableAuditAccepted
    ? agentSendReceiptRegistry.promoteFromAudit(detail)
    : { matched: false, promoted: false, reason: 'durable-audit-rejected' };
  if (sendReceiptPromotion.matched) {
    console.log('[AgentSendReceipt] audit tab=' + shortId(detail?.tabId, 12)
      + ' handoff=' + String(detail?.handoffId || '-').slice(0, 32)
      + ' promoted=' + (sendReceiptPromotion.promoted === true)
      + ' state=' + (sendReceiptPromotion.state || '-')
      + ' reason=' + (sendReceiptPromotion.reason || '-'));
  }
  const externalHandoffId = typeof detail?.handoffId === 'string' ? detail.handoffId : '';
  if (detail?.success === true && externalHandoffId.startsWith('external-run:')) {
    const externalRunId = externalHandoffId.slice('external-run:'.length);
    const durableRecord = durablePromotion?.record
      || durableRecordForAudit;
    let externalRun = externalRuns.get(externalRunId);
    if (!externalRun && durableRecord?.surface === 'inbox' && durableRecord.runId === externalRunId) {
      externalRun = {
        runId: externalRunId,
        provider: durableRecord.provider,
        source: 'external-api',
        handoffId: durableRecord.handoffId,
        promptAuditHash: durableRecord.promptHash,
        requestFingerprint: durableRecord.requestFingerprint,
        status: 'audit_pending',
        startedAt: durableRecord.createdAt,
        autoStopMs: 0,
        autoCloseMs: 0,
        collapsed: false,
        tabId: durableRecord.tabId,
        sessionId: durableRecord.sessionId,
        stopTimer: null,
        closeTimer: null,
        lastSendReceipt: durableRecord.receipt,
      };
      externalRuns.set(externalRunId, externalRun);
      if (externalRun.tabId) externalRunByTabId.set(externalRun.tabId, externalRunId);
    }
    const exactProvider = typeof detail?.toolType === 'string'
      && detail.toolType === externalRun?.provider;
    const exactSession = typeof detail?.sessionId === 'string'
      && detail.sessionId.length > 0
      && (!externalRun?.sessionId || detail.sessionId === externalRun.sessionId);
    const exactDurableAttempt = !agentSendReceiptStore || Boolean(
      durableOperationKey === `inbox:${externalRunId}`
      && durableAttemptId
      && durableAuditAccepted
      && durableRecord?.state === 'confirmed'
      && durableRecord?.attemptId === durableAttemptId
    );
    const externalPromptProof = externalRun?.promptAuditHash
      ? agentPromptAuditMatchesHash(externalRun.promptAuditHash, detail)
      : { matches: false };
    const confirmed = Boolean(
      externalRun
      && exactDurableAttempt
      && externalRun.tabId === detail.tabId
      && externalRun.handoffId === externalHandoffId
      && exactProvider
      && exactSession
      && externalRun.promptAuditHash
      && externalPromptProof.matches === true
    );
    if (!confirmed) {
      return {
        matched: Boolean(externalRun),
        confirmed: false,
        reason: externalRun ? 'external-prompt-identity-mismatch' : 'external-run-not-found',
      };
    }
    if (!externalRun.completionStamp) externalRun.status = 'running';
    externalRun.auditPendingAt = null;
    externalRun.auditConfirmedAt = Date.now();
    externalRun.sessionId ||= detail.sessionId;
    externalRun.auditSessionId = detail.sessionId;
    externalRun.auditEntryUuid = detail.entryUuid || null;
    externalRun.auditSourceIdentity = detail.sourceIdentity || null;
    setExternalRunMeta(externalRun.tabId, {
      status: externalRun.status,
      sessionId: externalRun.auditSessionId,
      handoffId: externalRun.handoffId,
      auditConfirmedAt: externalRun.auditConfirmedAt,
      auditEntryUuid: externalRun.auditEntryUuid,
      auditSourceIdentity: externalRun.auditSourceIdentity,
    });
    void refreshExternalRunCompletion(externalRun);
    return { matched: true, confirmed: true, kind: 'external-delivery', runId: externalRunId };
  }
  const store = getOrchestrationRunStore();
  const targetRunId = orchestrationTargetRunIdFromAudit(detail);
  if (targetRunId) {
    const confirmation = await store.confirmTargetPromptDelivery(targetRunId, {
      targetTabId: detail.tabId,
      handoffId: detail.handoffId,
      source: detail.source,
      toolType: detail.toolType,
      auditTimestamp: detail.auditTimestamp || null,
      actualHash: detail.actualHash || null,
      expectedHash: detail.expectedHash || null,
      actualLen: Number.isFinite(detail.actualLen) ? Number(detail.actualLen) : null,
      expectedLen: Number.isFinite(detail.expectedLen) ? Number(detail.expectedLen) : null,
      canonicalized: detail.canonicalized === true,
      canonicalReason: detail.canonicalReason || null,
      sessionId: detail.sessionId || null,
      userUuid: detail.entryUuid || null,
      sourceIdentity: detail.sourceIdentity || null,
      executionContext: detail.executionContext || null,
    });
    if (confirmation.confirmed) {
      console.log('[Orchestration] target prompt confirmed run=' + targetRunId
        + ' proof=prompt-audit tab=' + shortId(detail.tabId, 12)
        + ' session=' + shortId(detail.sessionId)
        + ' executionContext=' + (confirmation.contextBound ? 'bound' : 'unbound'));
      if (confirmation.contextReason) {
        console.warn('[Orchestration] target prompt execution context not changed run='
          + targetRunId
          + ' reason=' + confirmation.contextReason
          + ' mainDiagnostic=' + (detail.executionContextDiagnostic || 'none'));
      }
      const proofRun = await store.getInternal(targetRunId);
      const armed = await armOrchestrationResultProof(proofRun, {
        sessionId: detail.sessionId || proofRun?.sessionId || null,
      });
      if (armed?.success !== true) {
        console.warn('[OrchestrationResultProof] target arm failed run=' + targetRunId
          + ' error=' + (armed?.error || 'unknown'));
      }
      await reconcileOrchestrationRun(targetRunId, 'target-prompt-audit');
    } else {
      console.warn('[Orchestration] target prompt audit rejected run=' + targetRunId
        + ' reason=' + (confirmation.reason || 'unknown'));
    }
    emitOrchestrationChanges(confirmation.changed, 'target-prompt-audit-confirmed');
    return { matched: true, kind: 'target-delivery', ...confirmation };
  }

  const runId = orchestrationCompletionRunIdFromAudit(detail);
  if (!runId) {
    if (sendReceiptPromotion.matched) {
      return {
        ...sendReceiptPromotion,
        confirmed: sendReceiptPromotion.state === AGENT_SEND_RECEIPT_STATES.CONFIRMED,
        kind: 'agent-send-receipt',
      };
    }
    if (durablePromotion?.matched) {
      return {
        ...durablePromotion,
        confirmed: durablePromotion.record?.state === 'confirmed',
        kind: 'durable-agent-send-receipt',
      };
    }
    return { matched: false, confirmed: false };
  }
  const confirmation = await store.confirmSourceFollowup(runId, {
    kind: 'prompt-audit',
    sourceTabId: detail.tabId,
    handoffId: detail.handoffId,
    source: detail.source,
    auditTimestamp: detail.auditTimestamp || null,
    actualHash: detail.actualHash || null,
    expectedHash: detail.expectedHash || null,
    canonicalized: detail.canonicalized === true,
    canonicalReason: detail.canonicalReason || null,
    toolType: detail.toolType || null,
    sessionId: detail.sessionId || null,
    userUuid: detail.entryUuid || null,
    sourceIdentity: detail.sourceIdentity || null,
    executionContext: detail.executionContext || null,
    queuedAtSubmit: detail.queuedAtSubmit === true,
  });
  if (confirmation.confirmed) {
    console.log('[Orchestration] source follow-up confirmed run=' + runId
      + ' proof=prompt-audit tab=' + shortId(detail.tabId, 12));
    await releaseOrchestrationSourceProof(runId, 'source-followup-audit-proved');
  } else {
    console.warn('[Orchestration] source follow-up audit rejected run=' + runId
      + ' reason=' + (confirmation.reason || 'unknown'));
  }
  emitOrchestrationChanges(confirmation.changed, 'source-followup-audit-confirmed');
  await finalizeSettledOrchestrations(confirmation.settled, 'source-followup-audit-settled');
  if (confirmation.confirmed && !confirmation.idempotent && confirmation.run?.parentRunId) {
    await reconcileOrchestrationRun(
      confirmation.run.parentRunId,
      'source-followup-audit-parent-reconcile',
    );
  }
  return { matched: true, ...confirmation };
}

async function reconcileOrchestrationSourceFollowup(run, reason = 'source-followup-reconcile') {
  const store = getOrchestrationRunStore();
  const saved = await store.getInternal(run?.runId);
  const current = saved ? { ...saved } : null;
  if (!current) return { confirmed: false, reason: 'run-not-found' };
  if (current.sourceFollowupStartedAt) {
    await releaseOrchestrationSourceProof(current.runId, 'source-followup-already-proved');
    return { confirmed: true, idempotent: true, run: current };
  }
  if (current.sourceFollowupPending !== true
    || !current.notificationPromptHash
    || typeof getAgentTurnResult !== 'function') {
    return { confirmed: false, reason: 'source-followup-not-reconcilable' };
  }
  const sourceToolType = current.sourceToolType || current.sourceExecutionContext?.provider || null;
  const sourceInfo = await resolveAgentSessionInfo(current.sourceTabId, 2000).catch(() => null);
  let sessionId = current.notificationSourceSessionId
    || sourceInfo?.sessionId
    || current.sourceFollowupSessionId
    || null;
  let cwd = sourceInfo?.cwd || current.sourceProjectPath || null;
  const requestedAt = current.notificationAttemptedAt
    || current.notificationDeliveredAt
    || current.completedAt
    || current.createdAt;
  const probeSession = (candidateSessionId, candidateCwd, candidateToolType = null) => getAgentTurnResult({
    toolType: sourceToolType || candidateToolType || sourceInfo?.toolType || sourceInfo?.commandType || null,
    sessionId: candidateSessionId,
    cwd: candidateCwd,
    promptHash: current.notificationPromptHash,
    requestedAt,
    forceFresh: true,
    // Prompt consumption is authoritative before the source finishes its turn.
    resultReadMode: 'prompt-proof',
    maxChars: 500,
  }).catch((error) => ({ found: false, error: String(error?.message || error) }));
  let proof = sessionId ? await probeSession(sessionId, cwd) : null;
  if (!sessionId) {
    let projects = [];
    try {
      projects = require('./project-manager').db.getAllProjects();
    } catch {}
    const legacy = await findUniqueLegacySourceFollowupProof({
      run: current,
      projects,
      probe: async (candidate) => {
        const candidateProof = await probeSession(candidate.sessionId,
          candidate.cwd || current.sourceProjectPath || null, candidate.toolType);
        return candidateProof.sourceVerified === false
          ? { ...candidateProof, found: false }
          : candidateProof;
      },
    });
    if (legacy.found !== true || legacy.proof?.sourceVerified === false) {
      return { confirmed: false, reason: legacy.reason || 'source-session-unresolved' };
    }
    sessionId = legacy.candidate.sessionId;
    cwd = legacy.candidate.cwd || current.sourceProjectPath || null;
    proof = legacy.proof;
    await store.patch(current.runId, {
      notificationSourceSessionId: sessionId,
      sourceFollowupLegacyResolvedAt: Date.now(),
      sourceFollowupLegacyTabId: legacy.candidate.tabId || null,
    });
    console.log('[Orchestration] legacy source session resolved run=' + current.runId
      + ' staleTab=' + shortId(current.sourceTabId, 12)
      + ' currentTab=' + shortId(legacy.candidate.tabId, 12)
      + ' session=' + shortId(sessionId));
  }
  if (proof?.found !== true) {
    return { confirmed: false, reason: proof?.error || 'source-followup-turn-not-found' };
  }
  if (proof.sourceVerified === false) {
    return { confirmed: false, reason: 'result-source-unverified' };
  }
  let sourceFollowupExecutionContext = proof.executionContext || null;
  const persistedParent = current.parentRunId
    ? await store.getInternal(current.parentRunId)
    : null;
  const persistedParentContext = persistedParent?.targetExecutionContext || null;
  if (sourceFollowupExecutionContext
    && persistedParentContext
    && sourceFollowupExecutionContext.provider === persistedParentContext.provider
    && sourceFollowupExecutionContext.sessionId === persistedParentContext.sessionId
    && sourceFollowupExecutionContext.turnId === persistedParentContext.turnId) {
    // A transcript can recover provider/session/turn identity, but process and
    // lifecycle generation live only in the durable parent run. Reattach those
    // fields only after the exact provider turn matches; never promote a text
    // match or a neighbouring turn into runtime ownership proof.
    sourceFollowupExecutionContext = {
      ...sourceFollowupExecutionContext,
      processId: persistedParentContext.processId || null,
      generation: persistedParentContext.generation ?? null,
      startedAt: persistedParentContext.startedAt ?? sourceFollowupExecutionContext.startedAt ?? null,
    };
  }
  const confirmation = await store.confirmSourceFollowup(current.runId, {
    kind: 'transcript',
    resultSourceVerified: proof.sourceVerified,
    sourceTabId: current.sourceTabId,
    notificationPromptHash: current.notificationPromptHash,
    sessionId,
    userUuid: proof.userUuid || null,
    sourceIdentity: proof.sourceIdentity || null,
    toolType: sourceFollowupExecutionContext?.provider || sourceInfo?.toolType || sourceInfo?.commandType || null,
    executionContext: sourceFollowupExecutionContext,
    sameTurnComplete: proof.complete === true,
  });
  if (confirmation.confirmed) {
    console.log('[Orchestration] source follow-up reconciled run=' + current.runId
      + ' proof=transcript tab=' + shortId(current.sourceTabId, 12)
      + ' user=' + shortId(proof.userUuid, 12));
    await releaseOrchestrationSourceProof(current.runId, 'source-followup-proved');
  }
  emitOrchestrationChanges(confirmation.changed, reason);
  await finalizeSettledOrchestrations(confirmation.settled, reason + '-settled');
  return confirmation;
}

async function finalizeSettledOrchestration(run, reason = 'settled') {
  if (!run || !isTerminalStatus(run.status)) return;
  if (orchestrationCompletionInflight.has(run.runId)) {
    // A transcript edge can land while the completion probe is still reading
    // the previous file revision. Remember one trailing pass instead of
    // dropping that edge or starting two competing result owners.
    orchestrationCompletionTrailing.add(run.runId);
    return orchestrationCompletionInflight.get(run.runId);
  }
  const flight = (async () => {
    try {
      let next = run;
      let nextReason = reason;
      do {
        orchestrationCompletionTrailing.delete(run.runId);
        await finalizeSettledOrchestrationPass(next, nextReason);
        if (!orchestrationCompletionTrailing.delete(run.runId)) break;
        next = await getOrchestrationRunStore().getInternal(run.runId);
        nextReason = 'trailing-transcript-proof';
      } while (next && isTerminalStatus(next.status));
    } finally {
      orchestrationCompletionInflight.delete(run.runId);
      orchestrationCompletionTrailing.delete(run.runId);
      void scheduleOrchestrationPolicyTimer();
    }
  })();
  // Every caller, including target close, awaits this entire drain. The drain
  // calls the pass directly: re-entering this wrapper would await itself.
  orchestrationCompletionInflight.set(run.runId, flight);
  return flight;
}

async function finalizeSettledOrchestrationPass(run, reason) {
  let e2eResultProofBoundary = null;
  try {
    const store = getOrchestrationRunStore();
    let current = await store.getInternal(run.runId);
    if (!current) return;
    if (isExternalResearchRun(current)) {
      emitOrchestrationRun(await store.get(current.runId), reason);
      await sendOrchestrationCompletionNotification(current);
      return;
    }
    if (!isTerminalStatus(current.status)) return;
    const resultProofBoundary = e2eBoundaryTestGate?.enabled === true
      ? await e2eBoundaryTestGate.waitIfArmed({
          kind: 'orchestration-result-proof',
          identity: {
            runId: current.runId,
            targetTabId: current.targetTabId,
            status: current.status,
            ...(current.sessionId ? { sessionId: current.sessionId } : {}),
            ...(current.targetLifecycleGeneration
              ? { lifecycleGeneration: current.targetLifecycleGeneration }
              : {}),
          },
        })
      : { claimed: false, reason: 'test_hook_disabled' };
    if (resultProofBoundary?.claimed === true) {
      if (resultProofBoundary.action === 'hold') {
        e2eResultProofBoundary = resultProofBoundary;
        console.warn('[E2E:Boundary] action=hold kind=orchestration-result-proof'
          + ' run=' + current.runId
          + ' target=' + shortId(current.targetTabId, 12)
          + ' status=' + current.status);
        current = await store.getInternal(run.runId);
        if (!current || !isTerminalStatus(current.status)) return;
      } else {
        e2eBoundaryTestGate.complete({
          armId: resultProofBoundary.arm.armId,
          operationId: resultProofBoundary.arm.operationId,
          reason: 'non-hold-result-proof-boundary-ignored',
          result: { success: true },
        });
      }
    }
    // Both reads in the completion flow belong to one immutable attempt. The
    // store's live object can otherwise become Resume's new execution mid-read.
    const resultAttempt = captureOrchestrationResultAttempt(current);
    current = { ...current };
    let committedAttempt = resultAttempt;
    let proofChanged = false;
    let proofIgnored = false;
    const completion = await runOrchestrationCompletionFlow({
      run: current,
      probeResult: () => probeOrchestrationResult(current, { forceFresh: true, resultAttempt }),
      classifyProbe: (probe) => classifyOrchestrationResultProbe(probe, {
        authoritativeCompletion: true,
      }),
      // Subscribe first, then read again. A transcript edge on either side of
      // watcher setup is therefore observed by this pass or its trailing pass.
      armProof: async (probe) => {
        const latest = await store.getInternal(current.runId);
        if (!orchestrationResultAttemptMatches(latest, probe.resultAttempt)) {
          proofIgnored = true;
          return { success: false, error: 'stale-result-attempt' };
        }
        return armOrchestrationResultProof(current, probe);
      },
      markTerminalFailure: async (classification, probe) => {
        const failed = await store.markResultProofTerminalFailure(
          current.runId,
          classification.message,
          {
            resultAttempt: probe.resultAttempt,
            resultSourceVerified: probe.sourceVerified,
            errorCode: classification.code,
            outcome: classification.outcome,
            resultAvailable: probe.resultAvailable === true,
            turnIndex: probe.turnIndex,
            userUuid: probe.userUuid || null,
          },
        );
        proofIgnored ||= failed?.resolved !== true;
        if (failed?.resolved) {
          proofChanged = true;
          committedAttempt = failed.resultAttempt;
          await releaseOrchestrationResultProof(current.runId, 'exact-terminal-result-failure');
          emitOrchestrationChanges(failed.changed, reason + '-terminal-failure');
          await finalizeSettledOrchestrations(
            (failed.settled || []).filter((settledRun) => settledRun.runId !== current.runId),
            reason + '-terminal-failure-settled',
          );
        }
        return failed.run;
      },
      recordResult: async (probe, classification, watcher) => {
        const resultComplete = classification.kind === 'complete';
        const sourceSnapshot = probe?.sourceSnapshot || null;
        const observation = {
          resultAttempt: probe.resultAttempt,
          resultSourceVerified: probe.sourceVerified,
          resultComplete,
          resultAvailable: probe.resultAvailable === true,
          resultTurnIndex: Number.isInteger(probe.turnIndex) ? probe.turnIndex : null,
          resultUserUuid: probe.userUuid || null,
          resultSourceIdentity: probe.sourceIdentity || null,
          resultPromptCarrierKind: probe.promptCarrierKind || null,
          resultInternalContinuationCount: Math.max(
            0,
            Number(probe.internalContinuationCount) || 0,
          ),
          resultProofStatus: resultComplete ? 'complete' : 'awaiting-transcript',
          resultProofDeadlineAt: resultComplete
            ? null
            : (current.resultProofDeadlineAt
              || Date.now() + ORCHESTRATION_RESULT_PROOF_FLUSH_GRACE_MS),
          resultProofObservedSize: Number.isFinite(Number(sourceSnapshot?.size))
            ? Number(sourceSnapshot.size)
            : null,
          resultProofObservedMtimeMs: Number.isFinite(Number(sourceSnapshot?.mtimeMs))
            ? Number(sourceSnapshot.mtimeMs)
            : null,
          resultError: !probe.found
            ? (probe.error || 'matching turn not found')
            : (resultComplete
              ? null
              : (watcher?.success === false
                ? 'matching transcript turn is incomplete; watcher unavailable: ' + watcher.error
                : 'matching transcript turn is incomplete')),
          resultErrorCode: resultComplete ? null : (probe.errorCode || null),
          sessionId: probe.sessionId || current.sessionId || null,
        };
        if (resultComplete && shouldScheduleCreatedTargetAutoStop({
          ...current,
          ...observation,
        })) {
          observation.autoStopAt = (current.completedAt || Date.now()) + current.successAutoStopMs;
          observation.autoStopStatus = 'scheduled';
        }
        const recorded = await store.recordResultProofObservation(current.runId, observation, {
          withOutcome: true,
        });
        proofChanged ||= recorded.changed;
        proofIgnored ||= recorded.ignored;
        committedAttempt = recorded.resultAttempt;
        return recorded.run;
      },
    });
    if (proofIgnored || !orchestrationResultAttemptMatches(
      await store.getInternal(current.runId), committedAttempt,
    )) return;
    const finalized = completion.run;
    if (!finalized) return;
    if (completion.outcome === 'terminal-failure') {
      if (finalized?.status !== 'failed') {
        return;
      }
      await dispatchNextDeferredOrchestrationForTarget(
        current.targetTabId,
        'predecessor-terminal-result-failure',
      );
      await sendOrchestrationCompletionNotification(finalized);
      return;
    }
    if (proofChanged || current.status !== 'completed') emitOrchestrationRun(finalized, reason);
    if (completion.outcome === 'pending') {
      if (!proofChanged) return;
      console.warn('[Orchestration] completion awaiting transcript proof run=' + finalized.runId
        + ' session=' + String(finalized.sessionId || '').slice(0, 8)
        + ' found=' + (finalized.resultAvailable === true)
        + ' size=' + (finalized.resultProofObservedSize ?? '-')
        + ' mtime=' + (finalized.resultProofObservedMtimeMs ?? '-')
        + ' watcher=' + (orchestrationResultProofCoordinator?.snapshot()
          .some((entry) => entry.runId === finalized.runId) ? 'armed' : 'unavailable'));
      return;
    }
    await releaseOrchestrationResultProof(finalized.runId, 'result-proved');
    // Only after the predecessor's exact result is materialized may another
    // orchestration enter this target.  Sending it earlier through Claude's
    // native queue can merge both intents into one assistant turn.
    await dispatchNextDeferredOrchestrationForTarget(
      finalized.targetTabId,
      'predecessor-result-proved',
    );
    await sendOrchestrationCompletionNotification(finalized);
  } finally {
    if (e2eResultProofBoundary?.state === 'released') {
      e2eBoundaryTestGate.complete({
        armId: e2eResultProofBoundary.arm.armId,
        operationId: e2eResultProofBoundary.arm.operationId,
        reason: 'result-proof-pass-finished',
        result: { success: true },
      });
    }
  }
}

async function finalizeSettledOrchestrations(runs, reason) {
  for (const run of Array.isArray(runs) ? runs : []) {
    await finalizeSettledOrchestration(run, reason);
  }
}

async function retryWaitingNotificationsForSource(tabId) {
  const runs = await getOrchestrationRunStore().listForTab(tabId);
  for (const run of runs) {
    if (run.sourceTabId !== tabId || !isTerminalStatus(run.status)) continue;
    const neverAttemptedPending = run.notificationStatus === 'pending'
      && !run.notificationAttemptedAt;
    if (!neverAttemptedPending
      && run.notificationStatus !== 'waiting-for-input'
      && run.notificationStatus !== 'failed') continue;
    await sendOrchestrationCompletionNotification(run);
  }
}

async function reconcileAwaitingSourceProofsAfterDone(tabId) {
  const store = getOrchestrationRunStore();
  const runs = await store.listForTab(tabId);
  for (const run of runs) {
    if (run.sourceTabId !== tabId
      || !isTerminalStatus(run.status)
      || run.notificationStatus !== 'audit-pending'
      || run.sourceFollowupPending !== true
      || run.sourceFollowupStartedAt) continue;
    const current = await store.getInternal(run.runId);
    const proof = await reconcileOrchestrationSourceFollowup(
      current,
      'source-done-followup-reconcile',
    );
    const after = await store.getInternal(run.runId);
    if (!shouldMarkSourceFollowupUnconfirmed(after, proof)) continue;
    const unconfirmed = await store.markNotification(run.runId, 'unconfirmed', {
      notificationError: 'Точное подтверждение доставки не найдено после завершения хода источника',
      notificationUnconfirmedAt: Date.now(),
      notificationUnconfirmedReason: proof?.reason || 'source-followup-turn-not-found',
    });
    emitOrchestrationChanges(unconfirmed?.changed, 'source-followup-unconfirmed-after-done');
  }
}

const codexCapacityContinuations = new Map();

function coordinateCodexCapacityContinuation(owner, operation) {
  const key = JSON.stringify([owner.tabId, owner.sessionId, owner.generation, owner.turnId]);
  const existing = codexCapacityContinuations.get(key);
  if (existing) return existing;
  // Register synchronously before the watcher publishes done. Even failure
  // grace=0 must not deliver a failed-result callback ahead of its owned retry.
  const pending = Promise.resolve().then(operation);
  codexCapacityContinuations.set(key, pending);
  void pending.finally(() => {
    if (codexCapacityContinuations.get(key) === pending) codexCapacityContinuations.delete(key);
  }).catch(() => {});
  return pending;
}

async function processOrchestrationLifecycle(tabId, payload) {
  if (!tabId || !['busy', 'done', 'snapshot', 'background-work'].includes(payload?.type)) return;
  // The TUI warning can remove the visible loader immediately, but only the
  // typed rollout outcome owns recovery/notification for this failed turn.
  if (payload.reason === 'model_capacity' && payload.capacitySurfaceOnly === true) return;
  try {
    if ((payload.type === 'done' || (payload.type === 'busy' && payload.busy === false))
      && payload.reason === 'model_capacity') {
      const key = JSON.stringify([tabId, payload.sessionId, payload.lifecycleGeneration, payload.executionContext?.turnId || payload.turnId]);
      await codexCapacityContinuations.get(key)?.catch(() => {});
    }
    const store = getOrchestrationRunStore();
    if (payload.type === 'busy' || payload.type === 'done' || payload.type === 'background-work') {
      const result = await store.applyLifecycle(tabId, payload);
      const internal = (result.changed || []).find((run) => (
        run.waitingForInternalDescendants === true
        || payload.internalAgentContinuation
      ));
      if (internal) {
        console.log('[OrchestrationInternalWork] run=' + internal.runId
          + ' tab=' + shortId(tabId, 12)
          + ' event=' + payload.type
          + ' continuation=' + String(payload.internalAgentContinuation || '-')
          + ' background=' + (payload.backgroundWorkCount ?? '-')
          + ' waiting=' + (internal.waitingForInternalDescendants === true));
      }
      emitOrchestrationChanges(result.changed, 'target-lifecycle');
      await finalizeSettledOrchestrations(result.settled, 'target-settled');
    }
    // A busy:true edge is the event-driven wake-up for a notification which
    // previously hit a composer draft. Delivery still repeats the authoritative
    // draft preflight; only an empty composer may accept the notification.
    // This lets it queue behind the active turn without guessing from a timer.
    if (shouldRetryWaitingNotificationForSourceLifecycle(payload)) {
      await retryWaitingNotificationsForSource(tabId);
    }
    if (payload.type === 'done') {
      await reconcileAwaitingSourceProofsAfterDone(tabId);
    }
    const snapshotAdmission = payload.type === 'snapshot'
      ? resolveOrchestrationDeliveryAdmission(payload)
      : null;
    if (payload.type === 'done' || snapshotAdmission?.canDispatch === true) {
      await dispatchNextDeferredOrchestrationForTarget(
        tabId,
        'target-idle-lifecycle',
        payload.type === 'snapshot' ? payload : null,
      );
    }
    void scheduleOrchestrationPolicyTimer();
  } catch (error) {
    console.warn('[Orchestration] lifecycle failed tab=' + shortId(tabId, 12) + ' error=' + (error?.message || error));
  }
}

async function performE2eBoundaryAction(request = {}) {
  if (e2eBoundaryTestGate?.enabled !== true) {
    return { success: false, error: 'test_hook_disabled' };
  }
  const action = String(request?.action || '').trim();
  if (action !== 'inject-provider-error') {
    return { success: false, error: 'unsupported action' };
  }
  const runId = String(request?.runId || '').trim();
  if (!runId) return { success: false, error: 'runId required' };
  const store = getOrchestrationRunStore();
  const run = await store.getInternal(runId);
  if (!run) return { success: false, error: 'run not found' };
  if (run.status !== 'running'
    || run.targetBusySeen !== true
    || !run.targetTabId
    || !run.targetExecutionContext) {
    return {
      success: false,
      error: 'run_not_in_exact_active_turn',
      status: run.status,
    };
  }
  const identity = {
    runId: run.runId,
    targetTabId: run.targetTabId,
    status: run.status,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run.targetLifecycleGeneration
      ? { lifecycleGeneration: run.targetLifecycleGeneration }
      : {}),
    provider: String(run.targetExecutionContext.provider || run.targetToolType || 'unknown'),
    ...(run.targetExecutionContext.turnId
      ? { turnId: run.targetExecutionContext.turnId }
      : {}),
  };
  const claimed = e2eBoundaryTestGate.claim({
    kind: 'orchestration-provider-error',
    identity,
  });
  if (claimed.claimed !== true || claimed.action !== 'inject') {
    if (claimed.claimed === true) {
      e2eBoundaryTestGate.complete({
        armId: claimed.arm.armId,
        operationId: claimed.arm.operationId,
        reason: 'non-inject-provider-error-boundary-ignored',
        result: { success: false },
      });
    }
    return {
      success: false,
      error: claimed.reason || 'provider_error_hook_not_armed',
    };
  }
  console.warn('[TestFault] inject kind=orchestration-provider-error'
    + ' run=' + run.runId
    + ' target=' + shortId(run.targetTabId, 12)
    + ' provider=' + identity.provider
    + ' turn=' + String(identity.turnId || '-').slice(0, 16));
  await processOrchestrationLifecycle(run.targetTabId, {
    type: 'done',
    reason: 'provider_error',
    completedAt: Date.now(),
    sessionId: run.sessionId || null,
    lifecycleGeneration: run.targetLifecycleGeneration || null,
    executionContext: run.targetExecutionContext,
  });
  const after = await store.getInternal(run.runId);
  const injected = !!after
    && (after.status === 'waiting_recovery' || after.status === 'failed')
    && after.outcome === 'failed'
    && String(after.error || '').includes('provider_error');
  e2eBoundaryTestGate.complete({
    armId: claimed.arm.armId,
    operationId: claimed.arm.operationId,
    reason: injected ? 'provider-error-applied' : 'provider-error-not-applied',
    result: {
      success: injected,
      recovery: after?.status === 'waiting_recovery',
    },
  });
  return {
    success: injected,
    error: injected ? null : 'provider_error_not_applied',
    runId: run.runId,
    targetTabId: run.targetTabId,
    status: after?.status || null,
    outcome: after?.outcome || null,
  };
}

async function reconcileOrchestrationRun(runId, reason = 'reconcile', {
  resultReadMode = 'observe',
} = {}) {
  const store = getOrchestrationRunStore();
  const run = await store.getInternal(runId);
  if (!run || !isActiveStatus(run.status)) return store.get(runId);
  const resultAttempt = captureOrchestrationResultAttempt(run);
  const sessionInfo = await resolveAgentSessionInfo(run.targetTabId, 2000).catch(() => null);
  const status = sessionInfo?.status || sessionInfo?.sessionStatus || 'unknown';
  // An undispatched durable queue row has the same prompt hash as its future
  // turn, and may intentionally be byte-identical to an earlier run.  It has
  // no right to inspect target results until exact Enter/audit cleared the
  // private delivery intent.
  let probe = resultAttempt.deliveryPending || resultAttempt.paused || resultAttempt.resumeAwaitingNewTurn
    ? { found: false, resultComplete: false, resultAvailable: false, sourceVerified: false,
        sessionId: resultAttempt.sessionId, resultAttempt }
    : await probeOrchestrationResult(run, {
        resultAttempt,
        sessionInfo,
        forceFresh: status !== 'busy',
        resultReadMode,
      });
  const reconcileProbe = () => store.reconcile(runId, {
    resultAttempt,
    resultSourceVerified: probe.sourceVerified,
    busy: status === 'busy',
    lifecycleGeneration: sessionInfo?.lifecycleGeneration || null,
    sessionId: probe.sessionId || sessionInfo?.sessionId || resultAttempt.sessionId || null,
    resultFound: probe.found === true,
    resultComplete: probe.resultComplete === true,
    resultAvailable: probe.resultAvailable === true,
    resultTerminalEvent: probe.terminalEvent || null,
    resultTerminalReason: probe.terminalOutcomeReason || null,
    resultProviderError: probe.terminalEvent === 'provider_error' && probe.proofDefinitive === true
      ? { code: probe.errorCode || 'provider_error', message: probe.error || probe.terminalOutcomeReason }
      : null,
    resultHasFinalResult: probe.hasFinalResult === true,
    resultExecutionContext: probe.executionContext || null,
    internalContinuationCount: Math.max(0, Number(probe.internalContinuationCount) || 0),
    turnIndex: probe.turnIndex,
  });
  let reconciled = await reconcileProbe();
  if (reconciled.requiresAuthoritativeResult && resultReadMode === 'observe') {
    // A cheap candidate may keep waiting for children without hashing history.
    // Only the store's current state can decide whether it now needs proof;
    // retain the original attempt across the promotion and its CAS commit.
    probe = await probeOrchestrationResult(run, {
      resultAttempt, sessionInfo, forceFresh: true, resultReadMode: 'authoritative',
    });
    reconciled = await reconcileProbe();
  }
  if (reconciled.changed) emitOrchestrationRun(reconciled.changed, reason);
  await finalizeSettledOrchestrations(reconciled.settled, 'recovered-settled');
  return store.get(runId);
}

async function admitAgentLifecycleLaunch(tabId, { launchSource = 'explicit' } = {}) {
  const store = getOrchestrationRunStore();
  const admission = await store.admitAgentLaunch(tabId, {
    launchSource,
    now: Date.now(),
  });
  for (const runId of admission?.supersededRunIds || []) {
    emitOrchestrationRun(await store.get(runId), 'auto-stop-superseded-by-launch');
  }
  if (admission?.supersededRunIds?.length) void scheduleOrchestrationPolicyTimer();
  return admission;
}

function validateOrchestrationAutoStopAuthority(authority = {}) {
  if (authority?.kind !== 'orchestration-auto-stop') {
    return { valid: false, reason: 'stop-authority-invalid' };
  }
  return getOrchestrationRunStore().validateAutoStopClaim(
    authority.runId,
    authority.claimId,
  );
}

async function processDueOrchestrationPolicies() {
  const store = getOrchestrationRunStore();
  const now = Date.now();
  const proofRuns = await store.listAll();
  for (const run of proofRuns) {
    if (run.status !== 'completed'
      || run.resultComplete === true
      || !run.resultProofDeadlineAt
      || run.resultProofDeadlineAt > now) continue;
    const recovery = await store.beginResultProofRecovery(
      run.runId,
      'result proof deadline elapsed after authoritative target completion',
      { now, errorCode: RESULT_PROOF_CODES.RESULT_PROOF_DEADLINE },
    );
    emitOrchestrationChanges(recovery.changed, 'result-proof-deadline');
    await finalizeSettledOrchestrations(recovery.settled, 'result-proof-deadline');
  }
  const expired = await store.expireRecoveryDeadlines(now);
  emitOrchestrationChanges(expired.changed, 'recovery-expired');
  await finalizeSettledOrchestrations(expired.settled, 'recovery-expired');

  const allRuns = await store.listAll();
  for (const run of allRuns) {
    if (run.status !== 'completed'
      || run.resultComplete !== true
      || !run.autoStopAt
      || run.autoStopAt > now
      || run.autoStopFinishedAt) continue;
    if (orchestrationAutoStopInflight.has(run.runId)) continue;
    orchestrationAutoStopInflight.add(run.runId);
    try {
      const status = await resolveAgentSessionInfo(run.targetTabId, 2000).catch(() => null);
      const busy = status && (status.status === 'busy' || status.sessionStatus === 'busy');
      const expectedTargetIdentity = readAgentLifecycleIdentity
        ? await readAgentLifecycleIdentity(run.targetTabId, run.targetToolType || null).catch((error) => ({
            processStatus: 'unknown',
            error: String(error?.message || error),
          }))
        : { processStatus: 'unknown' };
      const claim = await store.claimDueAutoStop(run.runId, {
        now,
        expectedTargetIdentity,
        observedBusy: busy === true,
      });
      if (claim.claimed !== true) {
        if (claim.run) emitOrchestrationRun(claim.run, 'auto-stop-not-claimed');
        continue;
      }
      emitOrchestrationRun(claim.run, 'auto-stop-claimed');
      const stopResult = await runAgentStopScenario(run.targetTabId, 8000, {
        reason: 'orchestration-auto-stop',
        authority: {
          kind: 'orchestration-auto-stop',
          runId: run.runId,
          claimId: claim.claimId,
        },
      }).catch((error) => ({
        success: false,
        error: String(error?.message || error),
      }));
      const guardMeansTargetChanged = stopResult?.guardRejected === true
        && /changed|activity|claim/i.test(String(stopResult?.guardReason || ''));
      const finalStatus = stopResult?.success === false
        ? (guardMeansTargetChanged ? 'skipped-target-changed' : 'failed')
        : stopResult?.noProcess === true
          ? 'stopped-no-process'
          : 'stopped';
      const settlement = await store.settleAutoStopClaim(run.runId, claim.claimId, {
        status: finalStatus,
        error: stopResult?.success === false
          ? (stopResult.error || stopResult.guardReason || 'stop failed')
          : null,
      });
      if (settlement.run) emitOrchestrationRun(settlement.run, 'auto-stop-finished');
    } finally {
      orchestrationAutoStopInflight.delete(run.runId);
    }
  }
}

async function scheduleOrchestrationPolicyTimer() {
  if (orchestrationPolicyTimer) clearTimeout(orchestrationPolicyTimer);
  orchestrationPolicyTimer = null;
  const store = getOrchestrationRunStore();
  const recoveryAt = await store.nextRecoveryDeadline();
  const allRuns = await store.listAll();
  const autoStopAt = allRuns.reduce((next, run) => {
    if (run.status !== 'completed'
      || run.resultComplete !== true
      || !run.autoStopAt
      || run.autoStopFinishedAt) return next;
    return next === null || run.autoStopAt < next ? run.autoStopAt : next;
  }, null);
  const resultProofAt = allRuns.reduce((next, run) => {
    if (run.status !== 'completed'
      || run.resultComplete === true
      || !Number.isFinite(Number(run.resultProofDeadlineAt))) return next;
    const value = Number(run.resultProofDeadlineAt);
    return next === null || value < next ? value : next;
  }, null);
  const nextAt = [recoveryAt, autoStopAt, resultProofAt]
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)[0];
  if (!nextAt) return;
  const delay = Math.max(0, Math.min(0x7fffffff, nextAt - Date.now()));
  orchestrationPolicyTimer = setTimeout(() => {
    orchestrationPolicyTimer = null;
    void processDueOrchestrationPolicies()
      .catch((error) => console.warn('[Orchestration] policy timer failed:', error?.message || error))
      .finally(() => scheduleOrchestrationPolicyTimer());
  }, delay);
}

async function materializeReservedOrchestrationTarget(run, intent) {
  if (run.forkFromTabId) {
    return bridgeRequest('forkAgentTab', {
      sourceTabId: run.forkFromTabId,
      projectId: run.targetProjectId,
      name: run.targetTabName || undefined,
      reservedTabId: run.targetTabId,
      background: true,
      fromLatestCompact: run.fullHistoryFork !== true,
      visualParentTabId: run.targetParentTabId || run.forkFromTabId,
      afterTabId: run.targetParentTabId || run.forkFromTabId,
      codexModel: intent?.model || undefined,
      codexEffort: intent?.effort || undefined,
      windowTarget: run.targetWindowTarget || undefined,
    }, 60_000);
  }
  return bridgeRequest('createAgentTab', {
    projectId: run.targetProjectId,
    cwd: run.targetCwd || undefined,
    sourceTabId: run.sourceTabId || undefined,
    windowTarget: run.targetWindowTarget || undefined,
    toolType: run.targetToolType,
    name: run.targetTabName || undefined,
    reservedTabId: run.targetTabId,
    startNow: true,
    background: true,
    codexModel: intent?.model || undefined,
    codexEffort: intent?.effort || undefined,
    visualParentTabId: run.targetParentTabId || undefined,
    afterTabId: run.targetParentTabId || undefined,
    placement: run.targetPlacement || 'child',
  }, 12_000);
}

function persistOrchestrationForkEvent(run, childSessionId) {
  if (!run?.forkFromTabId || !run?.forkSourceSessionId || !childSessionId) return false;
  try {
    const db = require('./project-manager').db;
    db.saveSessionForkEvent({
      operationKind: 'fork',
      provider: run.targetToolType,
      sourceSessionId: run.forkSourceSessionId,
      childSessionId,
      entryUuids: [],
      snapshotComplete: false,
      sourceTabId: run.forkFromTabId,
      childTabId: run.targetTabId,
      visualParentTabId: run.targetParentTabId || run.forkFromTabId,
      orchestrationRunId: run.runId,
      orchestrationParentRunId: run.parentRunId || null,
      forkMode: run.fullHistoryFork === true ? 'full' : 'latest_compact',
      occurredAt: run.createdAt || null,
      origin: 'orchestration',
      isDirect: true,
    });
    return true;
  } catch (error) {
    console.warn('[Orchestration] fork history event persist failed run=' + run.runId + ': ' + error.message);
    return false;
  }
}

async function recoverMissingOrchestrationTarget(run, reason = 'startup-missing-target') {
  if (!run?.runId || findOrchestrationTabDescriptor(run.targetTabId)) {
    return { handled: false, recovered: false, run };
  }
  const store = getOrchestrationRunStore();
  const current = await store.getInternal(run.runId);
  if (!current || isTerminalStatus(current.status)) {
    return { handled: false, recovered: false, run: current };
  }

  const canFinishReservedCreation = current.targetCreated === true
    && !current.targetMaterializedAt
    && !!current.deliveryIntent
    && !current.deliveryDispatchStartedAt;
  if (!canFinishReservedCreation) {
    const closed = await store.handleTargetClosed(current.targetTabId, {
      failureGraceMs: current.failureGraceMs,
    });
    emitOrchestrationChanges(closed, reason + '-target-closed');
    return {
      handled: true,
      recovered: false,
      run: await store.get(current.runId),
    };
  }

  try {
    const intent = current.deliveryIntent;
    const created = await materializeReservedOrchestrationTarget(current, intent);
    if (!created?.tabId || created.tabId !== current.targetTabId) {
      throw new Error('recovered target tab does not match its durable reservation');
    }
    const descriptor = findOrchestrationTabDescriptor(current.targetTabId) || {};
    const materialized = await store.patch(current.runId, {
      status: 'starting',
      targetMaterializedAt: Date.now(),
      targetTabName: descriptor.tabName || created.name || current.targetTabName,
      targetProjectId: descriptor.projectId || created.projectId || current.targetProjectId,
      targetProjectName: descriptor.projectName || created.projectName || current.targetProjectName,
      targetProjectPath: descriptor.projectPath || created.projectPath || created.cwd || current.targetProjectPath,
      targetCwd: descriptor.cwd || created.cwd || current.targetCwd,
      targetToolType: descriptor.toolType || created.toolType || current.targetToolType,
      forkSourceSessionId: created.sourceSessionId || current.forkSourceSessionId || null,
      targetForkSessionId: created.sessionId || current.targetForkSessionId || null,
    });
    emitOrchestrationRun(materialized, reason + '-target-recreated');
    const status = await waitForAgentReady(current.targetTabId, 20_000, created);
    persistOrchestrationForkEvent(
      { ...current, ...materialized },
      status?.sessionId || created.sessionId || current.targetForkSessionId || null,
    );
    await store.patch(current.runId, {
      status: 'queued',
      sessionId: status?.sessionId || current.sessionId || null,
      targetLifecycleGeneration: status?.lifecycleGeneration || null,
      targetLaunchGeneration: status?.launchGeneration || null,
    });
    const delivery = await dispatchDeferredOrchestrationRun(current.runId, {
      reason: reason + '-dispatch',
      targetStatus: status,
    });
    return {
      handled: true,
      recovered: delivery.dispatched === true,
      run: delivery.run || await store.get(current.runId),
    };
  } catch (error) {
    const failed = await store.beginRecovery(
      current.runId,
      'startup_failed',
      'reserved target recovery failed: ' + String(error?.message || error),
    );
    emitOrchestrationChanges(failed.changed, reason + '-target-recovery-failed');
    await finalizeSettledOrchestrations(failed.settled, reason + '-target-recovery-failed');
    return {
      handled: true,
      recovered: false,
      run: await store.get(current.runId),
      error: String(error?.message || error),
    };
  }
}

async function reconcileActiveOrchestrations() {
  const store = getOrchestrationRunStore();
  const active = await store.listActive();
  for (const run of active) {
    if (isExternalResearchRun(run)) {
      if (isActiveStatus(run.status)) {
        getExternalResearchCoordinator().watch(run.runId, 'external-research-startup');
      } else if (isTerminalStatus(run.status)
        && run.resultComplete === true
        && run.notificationStatus === 'pending'
        && !run.notificationAttemptedAt) {
        await sendOrchestrationCompletionNotification(run);
      }
    } else if (isActiveStatus(run.status) && !findOrchestrationTabDescriptor(run.targetTabId)) {
      const recovery = await recoverMissingOrchestrationTarget(run, 'startup-reconcile');
      if (recovery.handled) continue;
    } else if (isActiveStatus(run.status)) {
      await reconcileOrchestrationRun(run.runId, 'startup-reconcile');
    } else if (run.status === 'completed' && run.resultComplete !== true) {
      // A previous process may have observed Stop before the final JSONL line
      // became durable. Re-arm the exact transcript proof on startup so these
      // runs self-heal instead of preserving an inherited loader forever.
      if (findOrchestrationTabDescriptor(run.targetTabId)) {
        await finalizeSettledOrchestration(run, 'startup-result-proof-reconcile');
      } else {
        // A removed target cannot append another transcript record. Do one last
        // fresh proof read, then preserve an explicit result-unavailable error
        // instead of resurrecting a ghost loader on every app restart.
        await finalizeClosedTargetResultProof(run.runId, {
          reason: 'startup-closed-target-result-proof',
          knownTargetClosed: true,
        });
      }
    }
    const current = await store.getInternal(run.runId);
    if (current?.sourceFollowupPending === true && !current.sourceFollowupStartedAt) {
      const sourceInfo = await resolveAgentSessionInfo(current.sourceTabId, 2000).catch(() => null);
      if (sourceInfo?.sessionId) {
        await store.patch(current.runId, {
          notificationSourceSessionId: current.notificationSourceSessionId || sourceInfo.sessionId,
        });
        await armOrchestrationSourceProof({
          ...current,
          notificationSourceSessionId: current.notificationSourceSessionId || sourceInfo.sessionId,
        }, sourceInfo);
      }
      const sourceProof = await reconcileOrchestrationSourceFollowup(
        current,
        'startup-source-followup-reconcile',
      );
      const afterReconcile = await store.getInternal(current.runId);
      if (shouldMarkSourceFollowupUnconfirmed(afterReconcile, sourceProof)) {
        const unconfirmed = await store.markNotification(current.runId, 'unconfirmed', {
          notificationError: 'Точное подтверждение доставки не найдено после перезапуска',
          notificationUnconfirmedAt: Date.now(),
          notificationUnconfirmedReason: sourceProof?.reason || 'source-followup-turn-not-found',
        });
        emitOrchestrationChanges(unconfirmed?.changed, 'source-followup-unconfirmed');
      }
    }
  }
  const deferredTargets = new Set(
    active
      .filter((run) => run.status === 'queued')
      .map((run) => run.targetTabId)
      .filter(Boolean),
  );
  for (const tabId of deferredTargets) {
    await dispatchNextDeferredOrchestrationForTarget(tabId, 'startup-deferred-reconcile');
  }
  await processDueOrchestrationPolicies();
  await scheduleOrchestrationPolicyTimer();
}

async function performOrchestrationAction(runId, action, options = {}) {
  const store = getOrchestrationRunStore();
  const current = await store.get(runId);
  if (!current) return { ok: false, statusCode: 404, error: 'run not found' };

  if (isExternalResearchRun(current)
    && ['pause', 'resume', 'report', 'wait'].includes(action)) {
    return {
      ok: false,
      statusCode: 409,
      error: 'this action belongs to agent-tab recovery, not an external research job',
      run: withOrchestrationUrls(current),
    };
  }
  if (isExternalResearchRun(current) && action === 'retry' && isActiveStatus(current.status)) {
    getExternalResearchCoordinator().watch(runId, 'external-research-explicit-reconcile');
    return { ok: true, waiting: true, run: withOrchestrationUrls(current) };
  }

  if (action === 'detach' || action === 'cancel') {
    if (isTerminalStatus(current.status) && !isResultProofPending(current)) {
      const autoStopCancellation = await store.cancelAutoStop(runId, {
        reason: 'detached-by-user',
      });
      if (autoStopCancellation.cancelled) {
        emitOrchestrationRun(autoStopCancellation.run, 'auto-stop-detached-by-user');
      }
      const canCancelNotification = current.sourceFollowupPending === true
        && !current.sourceFollowupStartedAt
        && (current.notificationStatus === 'pending' || current.notificationStatus === 'sending');
      if (!canCancelNotification) {
        if (autoStopCancellation.cancelled) {
          void scheduleOrchestrationPolicyTimer();
          return {
            ok: true,
            detached: true,
            run: withOrchestrationUrls(autoStopCancellation.run),
          };
        }
        return { ok: false, error: 'run is already settled', run: withOrchestrationUrls(current) };
      }
      if (orchestrationNotificationInflight.has(runId)) {
        if (options.cancelSendAccepted !== true) {
          return {
            ok: false,
            error: 'notification delivery cancellation requires exact handoff control',
            run: withOrchestrationUrls(current),
          };
        }
        const pending = await store.patch(runId, { notificationCancelRequestedAt: Date.now() });
        emitOrchestrationRun(pending, 'notification-cancel-requested');
        return { ok: true, cancellationPending: true, run: withOrchestrationUrls(pending) };
      }
      const suppressed = await store.markNotification(runId, 'suppressed', {
        notificationDismissedAt: Date.now(),
        notificationError: null,
      });
      emitOrchestrationChanges(suppressed?.changed, 'notification-cancelled');
      await finalizeSettledOrchestrations(suppressed?.settled, 'notification-cancelled');
      void scheduleOrchestrationPolicyTimer();
      return { ok: true, run: withOrchestrationUrls(suppressed?.run) };
    }
    const cancellation = await store.cancel(runId, {
      reason: 'detached-by-user',
      suppressNotification: true,
      outcome: 'detached',
    });
    emitOrchestrationChanges(cancellation?.changed, 'detached-by-user');
    await finalizeSettledOrchestrations(cancellation?.settled, 'detached-by-user');
    await dispatchNextDeferredOrchestrationForTarget(
      current.targetTabId,
      'predecessor-detached',
    );
    void scheduleOrchestrationPolicyTimer();
    return {
      ok: true,
      run: withOrchestrationUrls(cancellation?.run),
      detached: true,
    };
  }

  if (action === 'pause') {
    const paused = await store.pause(runId);
    if (!paused?.paused) {
      return {
        ok: false,
        error: current.sourceFollowupStartedAt || current.sourceFollowupPending === true
          ? 'result handoff has already started'
          : 'run cannot be paused in its current state',
        run: withOrchestrationUrls(paused?.run || current),
      };
    }
    await releaseOrchestrationResultProof(runId, 'orchestration-paused');
    await store.persistStrict();
    emitOrchestrationChanges(paused.changed, 'orchestration-paused');
    void scheduleOrchestrationPolicyTimer();
    return { ok: true, paused: true, run: withOrchestrationUrls(paused.run) };
  }

  if (action === 'resume') {
    if (!isPausedRun(current)) {
      return { ok: false, error: 'run is not paused', run: withOrchestrationUrls(current) };
    }
    if (!findOrchestrationTabDescriptor(current.targetTabId)) {
      return {
        ok: false,
        error: 'target tab is closed; restore the tab before resuming',
        run: withOrchestrationUrls(current),
      };
    }
    const targetInfo = await resolveAgentSessionInfo(current.targetTabId, 2000).catch(() => null);
    if (!targetInfo) {
      return {
        ok: false,
        error: 'target runtime is not ready; start or restore it before resuming',
        run: withOrchestrationUrls(current),
      };
    }
    if (current.targetToolType === 'codex' && !targetInfo.lifecycleGeneration) {
      return {
        ok: false,
        error: 'target process generation is not proven; resume once the Codex composer is ready',
        run: withOrchestrationUrls(current),
      };
    }
    const resumed = await store.resolveRecovery(runId, 'resume', {
      sessionId: targetInfo.sessionId || null,
      lifecycleGeneration: targetInfo.lifecycleGeneration || null,
      executionContext: null,
    });
    if (!resumed?.run || resumed.run.resumeAwaitingNewTurn !== true) {
      return { ok: false, error: 'run could not be resumed', run: withOrchestrationUrls(resumed?.run) };
    }
    await store.persistStrict();
    emitOrchestrationChanges(resumed.changed, 'orchestration-resumed');
    void scheduleOrchestrationPolicyTimer();
    return {
      ok: true,
      resumed: true,
      waitingForNextTurn: true,
      run: withOrchestrationUrls(resumed.run),
    };
  }

  if (action === 'report') {
    const resolved = await store.resolveRecovery(runId, 'report');
    const run = resolved?.run;
    if (!run || run.status !== 'failed') {
      return { ok: false, error: 'run is not waiting for recovery', run: withOrchestrationUrls(run) };
    }
    emitOrchestrationChanges(resolved.changed, 'recovery-reported');
    await finalizeSettledOrchestrations(resolved.settled, 'recovery-reported');
    return { ok: true, run: withOrchestrationUrls(await store.get(runId)) };
  }

  if (action === 'dismiss') {
    const resolved = await store.resolveRecovery(runId, 'dismiss');
    const run = resolved?.run;
    if (!run || run.status !== 'cancelled') {
      return { ok: false, error: 'run is not waiting for recovery', run: withOrchestrationUrls(run) };
    }
    emitOrchestrationChanges(resolved.changed, 'recovery-dismissed');
    await finalizeSettledOrchestrations(resolved.settled, 'recovery-dismissed');
    void scheduleOrchestrationPolicyTimer();
    return { ok: true, run: withOrchestrationUrls(run) };
  }

  if (action === 'wait') {
    const resolved = await store.resolveRecovery(runId, 'wait');
    const run = resolved?.run;
    if (!run || run.status !== 'waiting_recovery') {
      return { ok: false, error: 'run is not waiting for recovery', run: withOrchestrationUrls(run) };
    }
    emitOrchestrationChanges(resolved.changed, 'recovery-waiting-indefinitely');
    void scheduleOrchestrationPolicyTimer();
    return { ok: true, run: withOrchestrationUrls(run) };
  }

  if (action === 'dismiss-attention') {
    const tabId = cleanOptionalString(options.tabId, '');
    if (!tabId) return { ok: false, error: 'tabId required', run: withOrchestrationUrls(current) };
    const dismissed = await store.dismissAttention(runId, tabId);
    if (!dismissed?.dismissed) {
      return { ok: false, error: 'run does not belong to this tab', run: withOrchestrationUrls(dismissed?.run) };
    }
    emitOrchestrationChanges(dismissed.changed, 'attention-dismissed');
    await finalizeSettledOrchestrations(dismissed.settled, 'attention-dismissed');
    void scheduleOrchestrationPolicyTimer();
    return { ok: true, run: withOrchestrationUrls(dismissed.run) };
  }

  if (action === 'retry') {
    if (isPausedRun(current)) {
      return { ok: false, error: 'paused run must be resumed explicitly', run: withOrchestrationUrls(current) };
    }
    const actionTabId = cleanOptionalString(options.tabId, '');
    const sourceNotificationAwaitingProof = current.sourceTabId === actionTabId
      && isTerminalStatus(current.status)
      && current.notificationStatus === 'audit-pending';
    if (sourceNotificationAwaitingProof) {
      return {
        ok: false,
        error: 'completion Enter already crossed; exact delivery confirmation is still pending',
        run: withOrchestrationUrls(current),
      };
    }
    const canRetrySourceNotification = current.sourceTabId === actionTabId
      && isTerminalStatus(current.status)
      && ['waiting-for-input', 'failed', 'unconfirmed'].includes(current.notificationStatus);
    if (canRetrySourceNotification) {
      await sendOrchestrationCompletionNotification(current, { force: true });
      const retried = await store.get(runId);
      return { ok: true, run: withOrchestrationUrls(retried) };
    }
    if (isExternalResearchRun(current)) {
      return {
        ok: false,
        error: 'the browser job is terminal; start a new external research run for another request',
        run: withOrchestrationUrls(current),
      };
    }
    if (!findOrchestrationTabDescriptor(current.targetTabId)) {
      return {
        ok: false,
        error: 'target tab is closed; restore the tab from History before reconnecting',
        run: withOrchestrationUrls(current),
      };
    }
    const targetInfo = await resolveAgentSessionInfo(current.targetTabId, 2000).catch(() => null);
    if (!targetInfo) {
      return {
        ok: false,
        error: 'target runtime is not ready; start or restore it before reconnecting',
        run: withOrchestrationUrls(current),
      };
    }
    if (current.targetToolType === 'codex' && !targetInfo.lifecycleGeneration) {
      return {
        ok: false,
        error: 'target process generation is not proven; retry once the Codex composer is ready',
        run: withOrchestrationUrls(current),
      };
    }
    const resolved = await store.resolveRecovery(runId, 'reopen', {
      sessionId: targetInfo.sessionId || null,
      lifecycleGeneration: targetInfo.lifecycleGeneration || null,
    });
    const run = resolved?.run;
    if (!run || run.status !== 'queued') {
      return { ok: false, error: 'run is not waiting for recovery', run: withOrchestrationUrls(run) };
    }
    emitOrchestrationChanges(resolved.changed, 'recovery-reopened');
    const internal = await store.getInternal(runId);
    if (internal?.deliveryIntent) {
      // The user explicitly chose Retry, so a prior unknown transport outcome
      // may now be attempted again.  Automatic restart reconciliation never
      // clears this boundary.
      await store.resetDeferredDelivery(runId, 'explicit-retry');
      const delivery = await dispatchDeferredOrchestrationRun(runId, {
        reason: 'explicit-retry',
        targetStatus: targetInfo,
      });
      return {
        ok: delivery.dispatched === true || delivery.deferred === true,
        waitingForInput: delivery.deferred === true,
        error: delivery.reason === 'send-failed'
          ? (delivery.sendResult?.error || 'send failed')
          : undefined,
        run: withOrchestrationUrls(await store.get(runId)),
      };
    }
    void scheduleOrchestrationPolicyTimer();
    return { ok: true, waitingForInput: true, run: withOrchestrationUrls(run) };
  }

  if (action === 'deliver') {
    if (!isTerminalStatus(current.status)) {
      return { ok: false, error: 'run is not settled', run: withOrchestrationUrls(current) };
    }
    await sendOrchestrationCompletionNotification(current);
    return { ok: true, run: withOrchestrationUrls(await store.get(runId)) };
  }

  return { ok: false, statusCode: 400, error: 'unsupported action' };
}

async function finalizeClosedTargetResultProof(runId, {
  reason = 'closed-target-result-proof',
  knownTargetClosed = false,
} = {}) {
  const store = getOrchestrationRunStore();
  const before = await store.getInternal(runId);
  if (!before || before.status !== 'completed' || before.resultComplete === true) return [];
  const resultAttempt = captureOrchestrationResultAttempt(before);

  // Closing the tab does not erase a result that already reached JSONL. Always
  // perform one final authoritative read before declaring the proof unavailable.
  await finalizeSettledOrchestration(before, reason + '-final-read');
  let afterProbe = await store.getInternal(runId);
  if (!afterProbe || afterProbe.status !== 'completed' || afterProbe.resultComplete === true) return [];
  if (!orchestrationResultAttemptMatches(afterProbe, resultAttempt)) return [];
  if (!knownTargetClosed && findOrchestrationTabDescriptor(afterProbe.targetTabId)) return [];

  // Absence itself is about to decide the closed target's outcome. Unlike an
  // ordinary watcher wake, this final read must verify the consumed prefix even
  // when the warm index has no terminal candidate (rewrite+growth can add one).
  const sourceProof = await probeOrchestrationResult(afterProbe, {
    resultAttempt, forceFresh: true, resultReadMode: 'source-proof',
  });
  afterProbe = await store.getInternal(runId);
  if (!afterProbe || afterProbe.status !== 'completed' || afterProbe.resultComplete === true) return [];
  if (!orchestrationResultAttemptMatches(afterProbe, resultAttempt)) return [];
  if (classifyOrchestrationResultProbe(sourceProof, { authoritativeCompletion: true }).kind !== 'pending') {
    // The stronger read refreshed the index. Let the existing finalizer own
    // recording, watcher cleanup and the one notification, with its usual CAS.
    await finalizeSettledOrchestration(afterProbe, reason + '-source-proved');
    afterProbe = await store.getInternal(runId);
    if (!afterProbe || afterProbe.status !== 'completed' || afterProbe.resultComplete === true) return [];
    if (!orchestrationResultAttemptMatches(afterProbe, resultAttempt)) return [];
  }
  if (!knownTargetClosed && findOrchestrationTabDescriptor(afterProbe.targetTabId)) return [];

  const unavailable = await store.markResultProofUnavailable(
    runId,
    'target tab closed and exact result could not be recovered from transcript',
    { resultAttempt },
  );
  if (!unavailable?.resolved) return [];
  await releaseOrchestrationResultProof(runId, 'closed-target-result-unavailable');
  emitOrchestrationChanges(unavailable.changed, reason + '-unavailable');
  await finalizeSettledOrchestrations(unavailable.settled, reason + '-settled');
  return unavailable.changed || [];
}

async function handleOrchestrationTabClosed(tabId) {
  if (!tabId) return [];
  agentSendQueue?.stop(tabId);
  const store = getOrchestrationRunStore();
  const pendingResultRuns = (await store.listForTab(tabId, { activeOnly: true }))
    .filter((run) => run.targetTabId === tabId
      && run.status === 'completed'
      && run.resultComplete !== true);
  const targetRuns = await store.handleTargetClosed(tabId);
  const sourceRuns = await store.handleSourceClosed(tabId);
  for (const run of sourceRuns) {
    await releaseOrchestrationSourceProof(run.runId, 'source-tab-closed');
  }
  const resultProofRuns = [];
  for (const run of pendingResultRuns) {
    resultProofRuns.push(...await finalizeClosedTargetResultProof(run.runId, {
      reason: 'target-tab-closed-result-proof',
      knownTargetClosed: true,
    }));
  }
  emitOrchestrationChanges(targetRuns, 'target-tab-closed');
  emitOrchestrationChanges(sourceRuns, 'source-tab-closed');
  void scheduleOrchestrationPolicyTimer();
  return [...targetRuns, ...sourceRuns, ...resultProofRuns].map(withOrchestrationUrls);
}

function mobileTimelineColor(kind) {
  switch (kind) {
    case 'compact': return 'f59e0b';
    case 'continued': return 'fb923c';
    case 'docs_edit': return '22c55e';
    case 'docs_search': return '38bdf8';
    case 'user': return 'a78bfa';
    default: return '888888';
  }
}

function mobileTimelinePreview(value, max = 360) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function mobileTimelineTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : value;
  }
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function normalizeMobileTimelineEntries(entries, fullEntries = []) {
  const fullByUuid = new Map();
  for (const entry of Array.isArray(fullEntries) ? fullEntries : []) {
    if (entry && typeof entry.uuid === 'string') fullByUuid.set(entry.uuid, entry);
  }

  return (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && typeof entry.uuid === 'string')
    .map((entry) => {
      const fullEntry = fullByUuid.get(entry.uuid) || {};
      const entryRef = entry.entryRef || fullEntry.entryRef || null;
      const contentRevision = entry.contentRevision
        || fullEntry.contentRevision
        || entryRef?.contentRevision
        || null;
      const sourceIdentity = entry.sourceIdentity || fullEntry.sourceIdentity || entryRef?.sourceIdentity || null;
      const identityFields = {
        entryRef,
        contentRevision,
        sourceIdentity,
        sourceIdentityAliases: entry.sourceIdentityAliases || fullEntry.sourceIdentityAliases || [],
        physicalSessionId: entry.physicalSessionId || fullEntry.physicalSessionId || entryRef?.physicalSessionId || null,
        composite: entry.composite === true || fullEntry.composite === true || !!entryRef || undefined,
      };
      const rawKind = String(entry.kind || entry.type || entry.role || 'entry');
      const compactSummary = entry.compactSummary || fullEntry.compactSummary || '';
      const isCompact = rawKind === 'compact' || entry.isCompactSummary === true || fullEntry.isCompactSummary === true;
      if (isCompact) {
        const full = compactSummary || entry.full || fullEntry.full || entry.preview || fullEntry.content || 'Conversation compacted';
        const preview = mobileTimelinePreview(entry.preview || full || 'Conversation compacted');
        return {
          uuid: entry.uuid,
          kind: 'compact',
          color: entry.color || '#cba6f7',
          preview: preview || 'Conversation compacted',
          full: full || undefined,
          ts: mobileTimelineTs(entry.ts || entry.timestamp || fullEntry.ts || fullEntry.timestamp),
          preTokens: entry.preTokens || fullEntry.preTokens || undefined,
          postTokens: entry.postTokens || fullEntry.postTokens || undefined,
          compactEncrypted: entry.compactEncrypted === true || fullEntry.compactEncrypted === true || undefined,
          truncated: entry.truncated || undefined,
          tools: entry.tools || undefined,
          ...identityFields,
        };
      }
      if (entry.kind && (entry.preview || entry.full)) {
        const kind = String(entry.kind || 'entry');
        const full = entry.full || fullEntry.full || entry.preview || '';
        const preview = mobileTimelinePreview(entry.preview || full || kind);
        return {
          uuid: entry.uuid,
          kind,
          color: entry.color || mobileTimelineColor(kind),
          preview: preview || kind,
          full: full || undefined,
          ts: mobileTimelineTs(entry.ts || entry.timestamp || fullEntry.ts || fullEntry.timestamp),
          preTokens: entry.preTokens || fullEntry.preTokens || undefined,
          postTokens: entry.postTokens || fullEntry.postTokens || undefined,
          compactEncrypted: entry.compactEncrypted === true || fullEntry.compactEncrypted === true || undefined,
          truncated: entry.truncated || undefined,
          tools: entry.tools || undefined,
          ...identityFields,
        };
      }
      const kind = String(entry.type || entry.role || 'entry');
      const content = entry.content || fullEntry.content || '';
      const full = kind === 'compact'
        ? (compactSummary || content || 'Conversation compacted')
        : (content || compactSummary || '');
      const preview = kind === 'compact'
        ? mobileTimelinePreview(full || 'Conversation compacted')
        : mobileTimelinePreview(content || compactSummary || kind);
      const tsMs = Date.parse(entry.timestamp || fullEntry.timestamp || '');

      return {
        uuid: entry.uuid,
        kind,
        color: mobileTimelineColor(kind),
        preview: preview || kind,
        full: full || undefined,
        ts: Number.isFinite(tsMs) ? Math.floor(tsMs / 1000) : undefined,
        preTokens: entry.preTokens || fullEntry.preTokens || undefined,
        postTokens: entry.postTokens || fullEntry.postTokens || undefined,
        compactEncrypted: entry.compactEncrypted === true || fullEntry.compactEncrypted === true || undefined,
        ...identityFields,
      };
    });
}

async function sendInitialSnapshot(tabId, sink, sdkSessions) {
  const session = sdkSessions.get(tabId);
  const pendingQuestion = getClaudePendingQuestion ? getClaudePendingQuestion(tabId) : null;
  const replayExternalRunTerminalEvent = () => {
    const runId = externalRunByTabId.get(tabId);
    if (!runId) return;
    const run = externalRuns.get(runId);
    if (!run) return;
    if (run.status === 'done') {
      sink.send(JSON.stringify({
        type: 'done',
        tabId,
        runId,
        sessionId: run.sessionId || null,
        reason: 'snapshot-replay',
        completedAt: run.completedAt || null,
      }));
    } else if (
      run.status === 'send_failed'
      || run.status === 'start_timeout'
      || run.status === 'start_failed'
      || run.status === 'auth_required'
    ) {
      sink.send(JSON.stringify({
        type: 'error',
        tabId,
        runId,
        error: run.error || run.status,
      }));
    }
  };
  const replayOrchestrationRuns = async () => {
    const runs = await getOrchestrationRunStore().listForTab(tabId);
    sink.send(JSON.stringify({
      type: 'orchestration-snapshot',
      tabId,
      runs: runs.map(withOrchestrationUrls),
    }));
  };
  if (session) {
    const snapshot = await coherentPublicRuntimeSnapshot(tabId, {
      type: 'snapshot',
      tabId,
      sessionId: session.sessionId || null,
      busy: true,
      sessionStatus: 'busy',
      starting: false,
      stopping: false,
      inputReady: true,
      commandType: 'claude-sdk',
      toolType: 'claude',
      source: pendingQuestion?.source,
      toolUseID: pendingQuestion?.toolUseID,
      questions: pendingQuestion?.questions,
    });
    sink.send(JSON.stringify(snapshot));
    replayExternalRunTerminalEvent();
    await replayOrchestrationRuns();
    return;
  }
  try {
    // Resolve through the DB-aware helper so a renderer that has not hydrated
    // this tab cannot answer a live Codex process with a fabricated inactive
    // state. Codex is overlaid with main's process/writer snapshot below.
    const status = await resolveAgentSessionInfo(tabId, 1500);
    const sessionStatus = status?.status || status?.sessionStatus || 'unknown';
    const readSessionId = status?.readSessionId || status?.codexReadSessionId || null;
    const snapshot = await coherentPublicRuntimeSnapshot(tabId, {
      type: 'snapshot',
      tabId,
      sessionId: status?.sessionId || null,
      readSessionId,
      codexReadSessionId: readSessionId,
      busy: sessionStatus === 'busy',
      sessionStatus,
      starting: sessionStatus === 'starting',
      stopping: sessionStatus === 'stopping',
      commandType: status?.commandType || null,
      toolType: status?.toolType || null,
      inputReady: status?.inputReady === true,
      conversationMaterialized: status?.conversationMaterialized === true,
      canResume: status?.canResume === true,
      canCopySessionId: status?.canCopySessionId === true,
      timelineCount: typeof status?.timelineCount === 'number' ? status.timelineCount : null,
      materializationReason: status?.materializationReason || null,
      startupDefaultsPending: status?.startupDefaultsPending === true,
      startupDefaultsReady: status?.startupDefaultsReady === true,
      startupDefaultsError: status?.startupDefaultsError || null,
      lastNotReady: status?.lastNotReady || null,
      source: pendingQuestion?.source,
      toolUseID: pendingQuestion?.toolUseID,
      questions: pendingQuestion?.questions,
    });
    sink.send(JSON.stringify(snapshot));
    replayExternalRunTerminalEvent();
    await replayOrchestrationRuns();
  } catch {
    const snapshot = stampPublicRuntimeSnapshot(tabId, {
      type: 'snapshot',
      tabId,
      sessionId: null,
      busy: false,
      sessionStatus: 'unknown',
      starting: false,
      stopping: false,
      inputReady: false,
      commandType: null,
      toolType: null,
      source: pendingQuestion?.source,
      toolUseID: pendingQuestion?.toolUseID,
      questions: pendingQuestion?.questions,
    });
    sink.send(JSON.stringify(snapshot));
    replayExternalRunTerminalEvent();
    await replayOrchestrationRuns();
  }
}

function projectActivitySnapshot(reason = 'snapshot') {
  if (!computeProjectActivity) {
    return { type: 'project-activity', projects: [], ts: Date.now(), reason, unavailable: true };
  }
  try {
    const snap = computeProjectActivity() || {};
    const projects = (Array.isArray(snap.projects) ? snap.projects : []).map((project) => ({
      ...project,
      tabs: Array.isArray(project?.tabs)
        ? project.tabs.map((tab) => {
            const stamped = stampPublicRuntimeSnapshot(tab.tabId, {
              ...tab,
              type: 'snapshot',
              tabId: tab.tabId,
              sessionStatus: tab.status || 'unknown',
              busy: tab.turnBusy ?? tab.streaming ?? false,
            });
            const { type: _type, ...runtime } = stamped;
            return { ...tab, ...runtime };
          })
        : [],
    }));
    return {
      type: 'project-activity',
      projects,
      layoutChangedProjectIds: Array.isArray(snap.layoutChangedProjectIds) ? snap.layoutChangedProjectIds : [],
      projectOrderChanged: snap.projectOrderChanged === true,
      ...(snap.cardSignals ? { cardSignals: snap.cardSignals } : {}),
      ts: snap.ts || Date.now(),
      reason,
    };
  } catch (e) {
    console.warn('[ProjectActivity] snapshot failed:', e?.message || e);
    return { type: 'project-activity', projects: [], ts: Date.now(), reason, error: String(e?.message || e) };
  }
}

function sendProjectActivitySnapshot(sink, reason = 'connect') {
  const payload = projectActivitySnapshot(reason);
  sink.send(JSON.stringify(payload));
  return payload;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Ask renderer to do something (create tab, list open tabs, etc) and wait for
// a single reply. The renderer registers `web:bridge-reply` as the response
// channel; here we just allocate a requestId and time out at 5s. Used for
// state that only the live UI knows (current openProjects map, tab creation).
function bridgeRequest(action, payload, timeoutMs = 5000, {
  onLateReply = null,
  lateReplyRetentionMs = LATE_BRIDGE_REPLY_RETENTION_MS,
  requestId: ownedRequestId = null,
  observationOnly = false,
  onDispatch = null,
  captureReply = null,
  onAbort = null,
  onObservationExpired = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const wins = BrowserWindow.getAllWindows();
    const win = wins[0];
    const label = bridgePayloadLabel(payload);
    if (!win || win.isDestroyed()) {
      console.log('[BridgeDiag] NO_WINDOW action=' + action + label + ' wins=' + wins.length);
      const error = new Error('No window');
      error.code = 'bridge_unavailable';
      error.dispatched = false;
      return reject(error);
    }
    const requestId = ownedRequestId || crypto.randomBytes(8).toString('hex');
    if (pendingBridge.has(requestId)) return reject(Object.assign(new Error('Bridge request already pending'), {
      code: 'bridge_request_identity_conflict', dispatched: false,
    }));
    const timer = setTimeout(() => {
      const pending = pendingBridge.get(requestId);
      if (!pending) return;
      if (observationOnly) {
        // The timeout bounds an HTTP observation, not tab creation. The SAME
        // await continues once; its exact result is committed before resolve.
        console.log('[BridgeDiag] OBSERVATION_EXPIRED action=' + action + label + ' rid=' + requestId + ' afterMs=' + timeoutMs);
        try { onObservationExpired?.({ requestId }); }
        catch (error) { console.warn('[BridgeDiag] observation callback failed rid=' + requestId + ' error=' + error.message); }
        return;
      }
      if (pending && typeof pending.onLateReply === 'function') {
        pending.timedOut = true;
        pending.lateCleanupTimer = setTimeout(() => {
          if (pendingBridge.get(requestId) === pending) pendingBridge.delete(requestId);
        }, Math.max(1_000, Number(lateReplyRetentionMs) || LATE_BRIDGE_REPLY_RETENTION_MS));
        pending.lateCleanupTimer.unref?.();
      } else {
        pendingBridge.delete(requestId);
      }
      console.log('[BridgeDiag] TIMEOUT action=' + action + label + ' rid=' + requestId + ' afterMs=' + timeoutMs);
      const error = new Error('Bridge timeout: ' + action);
      error.code = 'bridge_timeout';
      reject(error);
    }, timeoutMs);
    pendingBridge.set(requestId, {
      resolve,
      reject,
      timer,
      action,
      label,
      sentAt: Date.now(),
      onLateReply: typeof onLateReply === 'function' ? onLateReply : null,
      timedOut: false,
      lateCleanupTimer: null,
      captureReply,
      onAbort,
      dispose: null,
      expectedSender: observationOnly ? win.webContents : null,
    });
    console.log('[BridgeDiag] SEND action=' + action + label + ' rid=' + requestId + ' wins=' + wins.length);
    try {
      onDispatch?.({ requestId });
      if (observationOnly && typeof win.webContents.once === 'function') {
        const destroyed = () => {
          const pending = pendingBridge.get(requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          pendingBridge.delete(requestId);
          const error = Object.assign(new Error('Bridge renderer closed during owned operation'), {
            code: 'bridge_unavailable', dispatched: true,
          });
          try { pending.onAbort?.(error); } catch {}
          pending.reject(error);
        };
        win.webContents.once('destroyed', destroyed);
        pendingBridge.get(requestId).dispose = () => win.webContents.removeListener?.('destroyed', destroyed);
      }
      win.webContents.send('web:bridge-request', { requestId, action, payload });
    } catch (sendError) {
      clearTimeout(timer);
      const pending = pendingBridge.get(requestId);
      pending?.dispose?.();
      pendingBridge.delete(requestId);
      sendError.code ||= 'bridge_unavailable';
      sendError.dispatched = false;
      try { onAbort?.(sendError); } catch {}
      reject(sendError);
      return;
    }
    if (e2eBoundaryTestGate?.enabled === true && action === 'sendAgentPromptScenario') {
      const prompt = String(payload?.prompt || '');
      const identity = {
        requestId,
        action,
        tabId: String(payload?.tabId || ''),
        source: String(payload?.source || 'unknown'),
        promptHash: promptAuditFingerprint(prompt),
        promptLength: prompt.length,
        ...(payload?.handoffId ? { handoffId: String(payload.handoffId) } : {}),
      };
      const claimed = e2eBoundaryTestGate.claim({
        kind: 'renderer-bridge-receipt',
        identity,
      });
      if (claimed.claimed === true && claimed.action === 'drop') {
        clearTimeout(timer);
        pendingBridge.delete(requestId);
        const error = new Error('Bridge receipt dropped by exact E2E boundary');
        error.code = 'bridge_timeout';
        console.warn('[E2E:Boundary] action=drop kind=renderer-receipt'
          + ' request=' + requestId
          + ' tab=' + shortId(payload?.tabId, 12)
          + ' handoff=' + String(payload?.handoffId || '-').slice(0, 24));
        reject(error);
        e2eBoundaryTestGate.complete({
          armId: claimed.arm.armId,
          operationId: claimed.arm.operationId,
          reason: 'renderer-receipt-dropped',
          result: { success: true },
        });
      } else if (claimed.claimed === true) {
        e2eBoundaryTestGate.complete({
          armId: claimed.arm.armId,
          operationId: claimed.arm.operationId,
          reason: 'non-drop-renderer-receipt-boundary-ignored',
          result: { success: true },
        });
      }
    }
  });
}

async function resolveAgentSessionInfo(tabId, timeoutMs = 1500, { onLateStatus = null } = {}) {
  let info = null;
  try {
    // Orchestration needs the live presence snapshot (status/inputReady), not
    // only the tab's saved session metadata.  The metadata-only bridge can
    // truthfully identify a Claude tab while leaving lifecycle absent; treating
    // that shape as `unknown` strands every durable delivery in the server
    // queue even though the composer is already ready.
    info = await bridgeRequest('getClaudeTabStatus', { tabId }, timeoutMs, {
      onLateReply: typeof onLateStatus === 'function'
        ? ({ ok, data }) => {
            if (ok && data) return onLateStatus(data);
          }
        : null,
    });
  } catch {}
  const overlayMainCodexRuntime = async (base = {}, historicalSessionId = null) => {
    let runtime = null;
    try {
      runtime = typeof resolveCodexRuntimeSessionInfo === 'function'
        ? await resolveCodexRuntimeSessionInfo(tabId, 'web-resolve-agent-session')
        : null;
    } catch {}
    const sessionStatus = runtime?.sessionStatus || 'unknown';
    const sessionId = runtime?.sessionId || null;
    const readSessionId = runtime?.canCopySessionId === true
      && typeof runtime?.readSessionId === 'string'
      && runtime.readSessionId.trim()
      ? runtime.readSessionId.trim()
      : null;
    return {
      ...base,
      tabId,
      toolType: 'codex',
      commandType: 'codex',
      status: sessionStatus,
      sessionStatus,
      sessionId,
      codexSessionId: sessionId,
      readSessionId,
      codexReadSessionId: readSessionId,
      savedSessionId: runtime?.savedSessionId || historicalSessionId || base?.savedSessionId || null,
      liveLifecycle: runtime ? (runtime.liveLifecycle ?? null) : null,
      inputReady: runtime?.inputReady === true,
      writerConfirmed: runtime?.writerConfirmed === true,
      writerUsableForMutation: runtime?.writerUsableForMutation === true,
      writerSessionId: runtime?.writerSessionId || sessionId,
      canCopySessionId: !!readSessionId,
      lifecycleGeneration: runtime?.lifecycleGeneration || null,
      canResume: sessionStatus === 'inactive' && !!sessionId,
    };
  };

  // Renderer owns UI-only fields, but main owns Codex process/writer truth.
  // Even a non-null renderer answer can be stale across hydration or a process
  // transition, so every Codex result is overlaid with one main snapshot.
  if (info?.toolType === 'codex') {
    return await overlayMainCodexRuntime(info, info?.savedSessionId || null);
  }
  if (info?.toolType) return info;

  try {
    const projectManager = require('./project-manager');
    for (const p of projectManager.db.getAllProjects()) {
      const t = (p.tabs || []).find(x => x.tabId === tabId);
      if (!t) continue;
      const persistedOwner = resolveCurrentPtyAgentOwner(t);
      const isCodex = persistedOwner === 'codex';
      const isClaude = persistedOwner === 'claude';
      const toolType = isCodex ? 'codex' : isClaude ? 'claude' : null;
      if (isCodex) {
        return await overlayMainCodexRuntime({
          tabId,
          toolType: 'codex',
          commandType: t.commandType || 'codex',
          claudeSessionId: null,
          savedSessionId: t.codexSessionId || null,
          geminiSessionId: t.geminiSessionId || null,
          cwd: t.cwd || null,
        }, t.codexSessionId || null);
      }
      const sessionId = isClaude ? (t.claudeSessionId || null) : null;
      return {
        tabId,
        toolType,
        commandType: t.commandType || null,
        sessionId,
        claudeSessionId: t.claudeSessionId || null,
        codexSessionId: t.codexSessionId || null,
        geminiSessionId: t.geminiSessionId || null,
        cwd: t.cwd || null,
      };
    }
  } catch {}

  return info || {
    tabId,
    toolType: null,
    commandType: null,
    sessionId: null,
    claudeSessionId: null,
    codexSessionId: null,
    geminiSessionId: null,
    cwd: null,
  };
}

async function coherentPublicRuntimeSnapshot(tabId, base = {}, expectedOwner = null) {
  if (typeof readAgentRuntimeSnapshot === 'function') {
    const snapshot = await readAgentRuntimeSnapshot(tabId);
    if (snapshot) {
      assertAgentReadyOwner(expectedOwner, snapshot);
      if (base.ready === true) {
        const verdict = validateFreshAgentRuntimeStatus(snapshot);
        if (!verdict.ok) throw Object.assign(new Error(verdict.error), { code: verdict.error, statusCode: verdict.statusCode, status: snapshot });
      }
      return stampPublicRuntimeSnapshot(tabId, { ...base, ...snapshot });
    }
    // A missing result from the paired main reader is unknown for PTY. It must
    // not silently reuse the pre-wait base (which may carry an old PID/ready).
    if (base.commandType === 'claude-sdk' && !expectedOwner) {
      return stampPublicRuntimeSnapshot(tabId, base);
    }
    throw Object.assign(new Error('main did not return a PTY runtime snapshot'), {
      code: 'runtime_snapshot_unavailable', statusCode: 503, runtimeStateUnknown: true,
    });
  }
  // Main and this transport are paired dependencies. A missing selector is
  // not permission to combine an earlier renderer status with a later PID.
  // Production supplies the main selector even for cold/background tabs.
  if (base.commandType === 'claude-sdk') return stampPublicRuntimeSnapshot(tabId, base);
  throw Object.assign(new Error('runtime snapshot reader unavailable'), {
    code: 'runtime_snapshot_unavailable', statusCode: 503, runtimeStateUnknown: true,
  });
}

function finishConversationOwnerRead(tabId, before) {
  if (!conversationOwners) return {};
  const after = conversationOwners.current(tabId);
  const current = before?.ownerToken === after.ownerToken
    && before?.ownerOrder?.epoch === after.ownerOrder?.epoch
    && before?.ownerOrder?.revision === after.ownerOrder?.revision;
  return { conversationOwner: before || after, ownerSnapshotCurrent: current };
}

function registerBridgeReplyHandler() {
  ipcMain.on('web:bridge-reply', (event, { requestId, ok, data, error }) => {
    const pending = pendingBridge.get(requestId);
    if (!pending) {
      console.log('[BridgeDiag] REPLY_DROPPED rid=' + requestId + ' ok=' + ok + ' err=' + (error || '-') + ' (no pending — probably already timed out)');
      return;
    }
    if (pending.expectedSender && event?.sender !== pending.expectedSender) {
      console.warn('[BridgeDiag] FOREIGN_REPLY action=' + pending.action + ' rid=' + requestId);
      return;
    }
    const elapsed = Date.now() - pending.sentAt;
    console.log('[BridgeDiag] REPLY action=' + pending.action + (pending.label || '') + ' rid=' + requestId + ' ok=' + ok + ' elapsedMs=' + elapsed + ' err=' + (error || '-'));
    clearTimeout(pending.timer);
    pending.dispose?.();
    if (pending.lateCleanupTimer) clearTimeout(pending.lateCleanupTimer);
    pendingBridge.delete(requestId);
    if (typeof pending.captureReply === 'function') {
      try { pending.captureReply({ requestId, ok, data, error, elapsedMs: elapsed }); }
      catch (captureError) {
        captureError.code ||= 'bridge_owned_result_unknown';
        try { pending.onAbort?.(captureError); } catch {}
        pending.reject(captureError);
        return;
      }
    }
    if (pending.timedOut === true) {
      console.warn('[BridgeDiag] LATE_REPLY action=' + pending.action
        + (pending.label || '')
        + ' rid=' + requestId
        + ' ok=' + ok
        + ' elapsedMs=' + elapsed);
      if (typeof pending.onLateReply === 'function') {
        void Promise.resolve(pending.onLateReply({ ok, data, error, elapsedMs: elapsed }))
          .catch((lateError) => console.warn('[BridgeDiag] late reply handler failed action='
            + pending.action + ' rid=' + requestId + ' error=' + (lateError?.message || lateError)));
      }
      return;
    }
    if (ok) {
      pending.resolve(data);
    } else {
      const bridgeError = new Error(error || 'Bridge failed');
      bridgeError.code = 'bridge_failed';
      bridgeError.bridgeData = data;
      pending.reject(bridgeError);
    }
  });
}

// Project/tab IDs могут содержать `=` (base64 от пути), пробелы, кириллицу —
// всё это URL-кодируется на клиенте как %3D, %20, %D0%9F и т.п.
// Без decodeURIComponent любой projectId оканчивающийся на `=` (например
// uav → `...dWF2%3D`) превращается в строку которой нет в БД → 404.
function decId(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

let activeLoadersLogSignature = null;
function logActiveLoadersSnapshot(snapshot, status = 200, error = null) {
  const loaders = Array.isArray(snapshot?.loaders) ? snapshot.loaders : [];
  const kinds = loaders.reduce((acc, loader) => {
    const key = loader?.kind || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const signature = JSON.stringify({
    status,
    idle: snapshot?.idle === true,
    count: Number(snapshot?.count || loaders.length || 0),
    kinds,
    error: error || null,
  });
  if (signature === activeLoadersLogSignature) return;
  activeLoadersLogSignature = signature;
  const tabs = loaders.slice(0, 8).map((loader) =>
    String(loader?.tabId || '').slice(-12) + ':' + (loader?.kind || '-') + ':' + (loader?.status || '-')
  ).join(',');
  console.log('[ActiveLoaders] status=' + status +
    ' idle=' + (snapshot?.idle === true) +
    ' count=' + Number(snapshot?.count || loaders.length || 0) +
    ' kinds=' + JSON.stringify(kinds) +
    ' tabs=' + (tabs || '-') +
    (error ? ' error=' + error : ''));
}

// ───────── REST handlers ─────────

async function handleApi(req, res, parsed, sdkSessions) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, {});
    return;
  }

  // Public ping endpoint — checks if token works. No body required.
  if (parsed.pathname === '/api/me' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, {
      ok: true,
      lanIp: getLanIp(),
      service: webServerServiceHealth(),
      capabilities: {
        ...(projectCardSignals ? { cardSignals: projectCardSignals.capability } : {}),
        ...(publicHistoryFreshness ? { historyFreshness: historyFreshnessCapability } : {}),
        completionNotifications: completionNotificationCapability,
        ...(agentSendQueue ? { sendQueue: { version: 1, providers: ['claude', 'codex'], durable: true,
          providerPendingLimit: 1, optIn: 'applicationQueue', acceptanceStatus: 'application-queued',
          ...(mobileAttachmentAssetStore ? { attachmentOwnership: { version: 1, scope: 'mobile-upload',
            durableBeforeAck: true, images: true, files: true,
            structuredFiles: { version: 1, partField: 'uploadFiles', rangeUnit: 'utf16',
              endpoint: '/api/terminal-tabs/:tabId/send' } } } : {}),
          receiptEndpoint: '/api/terminal-tabs/:tabId/send-receipts' } } : {}),
        ...(systemPromptService ? { systemPrompts: { version: 1, revision: true, endpoint: '/api/system-prompts', settings: '/api/system-prompts/settings' } } : {}),
        historyRead: { version: 1, view: 'history', conditional: 'ifRevision', delta: true, deltaProviders: ['codex'], settingsBaselineVersion: 1 },
        ...(transcriptService?.getToolPayload ? { historyPayloads: historyPayloadCapability } : {}),
        tabEvents: { version: 1, multiplex: 'tabIds', maxTabs: MAX_EVENT_TABS },
        ...(readAgentTabTiming ? { responseTiming: { version: 1, providers: ['claude', 'codex'], live: true, historySidecars: true } } : {}),
        mobileDiagnostics: { version: 1, serviceHealth: 'api-me' },
        ...(readAgentUsage ? { agentUsage: { version: 1, providers: ['codex', 'claude'], readOnly: true, endpoint: '/api/agent-usage' } } : {}),
        ...(readAgentParams ? { agentParams: { version: 1, coherentCurrent: true,
          providers: ['codex', 'claude'], operationProviders: agentParamsService ? ['claude'] : [],
          requestId: 'client-stable', operationRead: '/api/terminal-tabs/:tabId/params?operationId=:operationId' } } : {}),
        ...(readAgentRuntimeSnapshot ? { codexRuntimePolicy: { version: 1, dialogs: ['resume-goal', 'usage-exhaustion'],
          liveSettings: true, manualAction: true, background: true } } : {}),
        ...(codexGoalActions ? { codexGoal: codexGoalCapability } : {}),
        ...(readCodexAuthProfile ? { codexAuthProfile: { version: 1, mode: 'server-profile', readOnly: true, endpoint: '/api/codex-auth-profile' } } : {}),
        nativeRewind: { version: 2, escapeReady: 'committed-frame', wrappedSelection: 'display-rows', postEnterRecovery: 1 },
        ...(savedHistoryOperations ? { savedHistory: { version: 1, providers: savedHistoryOperations.claude ? ['codex', 'claude'] : ['codex'], operations: ['rewind', 'delete'],
          receipts: true, structuredDraft: true, nativeRewindUnchanged: true } } : {}),
        ...(conversationOwners ? { conversationOwner: { version: 1, providers: ['codex', 'claude'],
          applicability: '/api/terminal-tabs/:tabId/history-operations/:operationId/applicability',
          strictKnownEmptySend: ['claude'], order: 'ownerOrder', receiptUnchanged: true } } : {}),
        ...(inboxSavedHistoryOperations ? { inboxSavedHistory: { version: 1, providers: ['codex'],
          operations: ['rewind', 'delete'], exactRunAudit: true, receipts: true, structuredDraft: true, structuredAuthoring: true } } : {}),
        ...(agentSendReceiptStore ? { inboxSetupOutcome: { version: 1,
          read: '/api/inbox/runs/:runId', creationReceipt: true, observationDoesNotCancel: true } } : {}),
        structuredAuthoring: { version: 1, providers: ['codex', 'claude'], parts: true,
          commonSerializer: true, maxBytes: STRUCTURED_AUTHORING_LIMITS.bytes },
        inboxAttachments: {
          version: 1,
          documents: 'context-file',
          images: 'native',
          strict: true,
          exactPathAudit: true,
        },
        contextFiles: {
          version: 1,
          roles: ['source', 'instructions'],
          maxFiles: MAX_CONTEXT_FILES,
          maxFileBytes: MAX_CONTEXT_FILE_BYTES,
          maxTotalBytes: MAX_CONTEXT_TOTAL_BYTES,
        },
        agentModelSelection: {
          version: 1,
          kinds: ['catalog', 'custom'],
        },
        loopTaskCompletion: { version: 2, statuses: ['completed', 'blocked'] },
        tabMessages: { version: 1, durable: true, replyTo: true, dismiss: true },
        orchestrationInlineResults: { version: 1 },
        externalResearchOrchestration: {
          version: 1,
          startEndpoint: '/api/external-research/orchestrations',
          resultEndpoint: '/api/orchestrations/:runId/result',
          providers: ['chatgpt', 'claude', 'perplexity'],
          continuation: 'continueFromRunId',
        },
      },
    });
  }

  if (parsed.pathname === '/api/focused-terminal-context' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    try {
      const data = await bridgeRequest('getFocusedTerminalContext', {}, 3000);
      return sendJson(res, 200, {
        ok: true,
        instancePid: process.pid,
        context: data?.context || null,
        reason: data?.reason || null,
      });
    } catch (e) {
      return sendJson(res, 503, {
        ok: false,
        error: 'focused terminal context unavailable',
        detail: String(e?.message || e),
      });
    }
  }

  // ─── Voice Record dictation chips ───────────────────────────────────────
  //
  // A global dictation finishing INSIDE the History composer. Voice Record
  // calls begin at the moment the user presses the finish hotkey: the
  // renderer drops an inline `[Dictating vr-<ts>]` placeholder at the caret
  // and Voice Record keeps committing the speech tail on its side. resolve
  // replaces that placeholder with the recognised text (or reports failure);
  // the vr-<ts> id doubles as the Voice Record history timestamp, so a
  // failed/stale chip can be retried from either side after any restart.
  //
  // begin also ANSWERS the gating question "is the composer focused in the
  // window that is frontmost right now": Voice Record must not guess — a
  // wrong guess would either paste into the composer twice or drop the take
  // into a background draft the user is not looking at. `accepted:false`
  // tells Voice Record to fall back to the ordinary Cmd+V path.
  if (parsed.pathname === '/api/dictation-chip/begin' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad body: ' + e.message }); }
    const chipId = String(body?.chipId || '').trim();
    if (!/^vr-[0-9]+$/.test(chipId)) {
      return sendJson(res, 400, { ok: false, error: 'chipId must be vr-<ts>' });
    }
    const waitForFocusMs = Math.max(0, Math.min(Number(body?.waitForFocusMs) || 0, 8000));
    try {
      const data = await bridgeRequest('dictationChipBegin', {
        chipId,
        label: String(body?.label || ''),
        autoSend: body?.autoSend === true,
        waitForFocusMs,
      }, Math.max(3000, waitForFocusMs + 1500));
      return sendJson(res, 200, { ok: true, instancePid: process.pid, ...data });
    } catch (e) {
      return sendJson(res, 503, {
        ok: false,
        error: 'dictation chip begin unavailable',
        detail: String(e?.message || e),
      });
    }
  }

  if (parsed.pathname === '/api/dictation-chip/open' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad body: ' + e.message }); }
    const tabId = String(body?.tabId || '').trim();
    const expectedPid = Number(body?.expectedPid);
    if (!tabId || tabId.length > 512 || !Number.isInteger(expectedPid) || expectedPid <= 0) {
      return sendJson(res, 400, { ok: false, error: 'tabId and expectedPid required' });
    }
    if (expectedPid !== process.pid) return sendJson(res, 409, { ok: false, error: 'terminal instance changed' });
    try {
      const data = await bridgeRequest('dictationChipOpenOwner', { tabId }, 5000);
      if (data?.opened !== true) return sendJson(res, 404, { ok: false, error: 'tab not open' });
      const focus = revealTerminalApplicationWindow('dictation-chip-owner');
      return sendJson(res, focus.ok ? 200 : 503, {
        ok: focus.ok, opened: true, focused: focus.revealed === true,
        ...(focus.ok ? {} : { error: focus.error || focus.reason }),
      });
    } catch (e) {
      return sendJson(res, 503, { ok: false, error: 'dictation owner navigation unavailable', detail: String(e?.message || e) });
    }
  }

  if (parsed.pathname === '/api/dictation-chip/resolve' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad body: ' + e.message }); }
    const chipId = String(body?.chipId || '').trim();
    if (!/^vr-[0-9]+$/.test(chipId)) {
      return sendJson(res, 400, { ok: false, error: 'chipId must be vr-<ts>' });
    }
    const outcome = body?.outcome === 'text' || body?.outcome === 'empty' || body?.outcome === 'error'
      ? body.outcome : null;
    if (!outcome) return sendJson(res, 400, { ok: false, error: 'outcome must be text|empty|error' });
    try {
      const data = await bridgeRequest('dictationChipResolve', {
        chipId,
        outcome,
        text: String(body?.text || ''),
        error: String(body?.error || ''),
        imagePaths: Array.isArray(body?.imagePaths) ? body.imagePaths.slice(0, 20) : [],
        ...(typeof body?.autoSend === 'boolean' ? { autoSend: body.autoSend } : {}),
      }, 5000);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendJson(res, 503, {
        ok: false,
        error: 'dictation chip resolve unavailable',
        detail: String(e?.message || e),
      });
    }
  }

  // Stop may land first and Option+1 second. This updates the already-visible
  // chip immediately; resolve repeats the latest value atomically with text.
  if (parsed.pathname === '/api/dictation-chip/auto-send' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad body: ' + e.message }); }
    const chipId = String(body?.chipId || '').trim();
    if (!/^vr-[0-9]+$/.test(chipId)) {
      return sendJson(res, 400, { ok: false, error: 'chipId must be vr-<ts>' });
    }
    if (typeof body?.armed !== 'boolean') {
      return sendJson(res, 400, { ok: false, error: 'armed must be boolean' });
    }
    try {
      const data = await bridgeRequest('dictationChipAutoSend', {
        chipId,
        armed: body.armed,
      }, 3000);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendJson(res, 503, {
        ok: false,
        error: 'dictation chip auto-send unavailable',
        detail: String(e?.message || e),
      });
    }
  }

  // Live tail of a still-committing take: Voice Record streams the END of the
  // recognised text and only the chip LABEL follows it. Fire-and-forget on
  // the VR side; a lost tick is superseded by the next one or by resolve.
  if (parsed.pathname === '/api/dictation-chip/progress' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJson(res, 400, { ok: false, error: 'bad body: ' + e.message }); }
    const chipId = String(body?.chipId || '').trim();
    if (!/^vr-[0-9]+$/.test(chipId)) {
      return sendJson(res, 400, { ok: false, error: 'chipId must be vr-<ts>' });
    }
    try {
      const data = await bridgeRequest('dictationChipProgress', {
        chipId,
        label: String(body?.label || ''),
      }, 3000);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendJson(res, 503, {
        ok: false,
        error: 'dictation chip progress unavailable',
        detail: String(e?.message || e),
      });
    }
  }

  if (parsed.pathname === '/api/ios/push-token' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    const result = registerIosPushToken(body);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (parsed.pathname === '/api/ios/push-status' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const tokens = readIosPushTokens();
    const config = apnsConfigFor();
    return sendJson(res, 200, {
      ok: true,
      configured: config.configured === true,
      missing: config.configured ? [] : config.missing,
      error: config.error || null,
      tokenCount: tokens.length,
      tokens: tokens.map((item) => ({
        environment: item.environment,
        bundleId: item.bundleId,
        deviceName: item.deviceName,
        tokenSuffix: String(item.token || '').slice(-10),
        lastSeenAt: item.lastSeenAt,
      })),
    });
  }

  // Active-loaders snapshot — every tab across every project that is still
  // "working" (AI turn/loader, SDK streaming, Gemini busy, or a Restart-after
  // owned non-AI shell process). Manual shell commands are not install blockers.
  // AI CLI liveness by itself is not a loader: idle Claude/Codex tabs are
  // allowed to be closed by build:install. Computed in main against the live
  // Maps that already drive the UI loader — no separate busy notion.
  // See computeActiveLoaders() in main.js.
  if (parsed.pathname === '/api/active-loaders' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (!computeActiveLoaders) {
      // Fail SAFE: if the injection is missing we must NOT report idle — that
      // would green-light a rebuild mid-work. Signal the poller to keep waiting.
      logActiveLoadersSnapshot({ idle: false, count: 0, loaders: [] }, 503, 'unavailable');
      return sendJson(res, 503, { error: 'active-loaders unavailable', idle: false });
    }
    try {
      const runtimeSnapshot = await Promise.resolve(computeActiveLoaders());
      const orchestrationRuns = await getOrchestrationRunStore().listActive();
      const snapshot = mergeActiveLoadersWithOrchestrations(runtimeSnapshot, orchestrationRuns);
      logActiveLoadersSnapshot(snapshot, 200);
      return sendJson(res, 200, snapshot);
    } catch (e) {
      logActiveLoadersSnapshot({ idle: false, count: 0, loaders: [] }, 500, String(e.message || e));
      return sendJson(res, 500, { error: String(e.message), idle: false });
    }
  }

  // Project-level activity snapshot for native iOS project badges. This is a
  // small aggregate, not a tab list refresh: count = live agent tabs in project,
  // streaming = at least one child tab currently has its loader on. The matching
  // SSE scope sends the same full snapshot so dropped events self-heal.
  if (parsed.pathname === '/api/project-activity' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (!computeProjectActivity) {
      return sendJson(res, 503, { error: 'project-activity unavailable', projects: [], ts: Date.now() });
    }
    try {
      return sendJson(res, 200, computeProjectActivity());
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message), projects: [], ts: Date.now() });
    }
  }

  // ───────── SSE live channel (WebSocket replacement) ─────────
  // EventSource over plain HTTP GET. Yandex/Chrome anti-tracker extensions
  // block ws:// to private IPs but NOT text/event-stream. Same subscriber
  // registry + webBroadcast() as WS, so main.js fan-out is transport-agnostic.
  // Auth via ?token= (EventSource can't set headers, same as WS handshake).
  if (parsed.pathname === '/api/events' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let multipleTabIds;
    try { multipleTabIds = eventTabIds(parsed.query); }
    catch (error) { return sendJson(res, 400, { error: error.message }); }
    if (multipleTabIds) {
      const missing = multipleTabIds.find(id => !sdkSessions.has(id) && !findOrchestrationTabDescriptor(id));
      if (missing) return sendJson(res, 404, { error: 'tab_not_found', tabId: missing });
    }
    const scope = parsed.query.scope ? String(parsed.query.scope) : '';
    const isProjectActivity = scope === 'projects' || parsed.query.projectActivity === '1';
    const tabId = parsed.query.tabId ? decId(String(parsed.query.tabId)) : null;
    if (!tabId && !isProjectActivity && !multipleTabIds) return sendJson(res, 400, { error: 'tabId required' });
    const topic = isProjectActivity ? PROJECT_ACTIVITY_TOPIC : tabId;
    const topics = multipleTabIds || [topic];

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Disable proxy buffering (nginx etc.) so events flush immediately.
      'X-Accel-Buffering': 'no',
    });
    // Initial comment + retry hint. EventSource auto-reconnects on drop using
    // this interval; we still keep it modest since the network is LAN.
    res.write('retry: 2000\n\n');

    const transport = {
      kind: 'sse',
      sent: 0,
      errors: 0,
      send: (str) => {
        try {
          res.write('data: ' + str + '\n\n');
          sink.sent += 1;
        } catch (e) {
          sink.errors += 1;
          console.warn('[WebSSE:WriteError] tab=' + shortId(topic, 12) + ' sent=' + sink.sent + ' err=' + (e?.message || e));
        }
      },
      isAlive: () => !res.writableEnded && !res.destroyed,
      close: () => { try { res.end(); } catch {} },
    };
    const sink = stampedEventSink(transport, webServerInstanceId);
    for (const id of topics) subscribe(id, sink);
    console.log('[WebSSE:Open] tab=' + topics.map(id => shortId(id, 12)).join(',') + ' scope=' + (isProjectActivity ? 'projects' : multipleTabIds ? 'tabs' : 'tab') + ' from=' + (req.socket.remoteAddress || '?'));

    if (isProjectActivity) {
      // Full summary snapshot on connect; the client treats later events as
      // replacement snapshots, not deltas.
      try { sendProjectActivitySnapshot(sink, 'connect'); } catch {}
    } else {
      // Initial snapshot — mirror the WS upgrade path so the client renders
      // immediately without waiting for the next broadcast.
      for (const id of topics) {
        const initialSink = sink.beginInitial(id);
        sendInitialSnapshot(id, initialSink, sdkSessions)
          .then(() => sendTabTimingSnapshot(id, initialSink, 'connect'))
          .then(() => sendHistoryFreshnessSnapshot(id, initialSink))
          .catch(() => {}).finally(() => initialSink.finish());
        startClaudeTabWatcher(id).catch(() => {});
        startTranscriptSubscriptionForTab(id).catch(() => {});
      }
    }

    // Heartbeat: SSE connections die silently behind some proxies/radios.
    // A comment line every 25s keeps the socket warm and lets the client's
    // onerror fire promptly if the pipe is actually dead.
    const hb = setInterval(() => {
      try { res.write(': hb\n\n'); } catch {}
    }, 25000);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(hb);
      unsubscribeAll(sink);
      if (!isProjectActivity) releaseClaudeWatchersIfOrphan();
      if (!isProjectActivity) releaseTranscriptSubscriptionsIfOrphan();
      console.log('[WebSSE:Close] tabs=' + topics.length + ' scope=' + (isProjectActivity ? 'projects' : 'tab') + ' sent=' + sink.sent + ' errors=' + sink.errors);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    return; // keep the response open
  }

  if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });

  if (parsed.pathname === '/api/history-freshness' && req.method === 'GET') {
    let ids;
    try { ids = eventTabIds(parsed.query); if (!ids) throw new Error('tabIds required'); }
    catch (error) { return sendJson(res, 400, { ok: false, error: error.message }); }
    try { return sendJson(res, 200, await readPublicHistoryFreshness(ids)); }
    catch (error) { return sendJson(res, error.statusCode || 503, { ok: false, error: error.message }); }
  }

  if (parsed.pathname === '/api/codex-auth-profile') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!readCodexAuthProfile) return sendJson(res, 404, { error: 'codex_auth_profile_not_configured' });
    try { return sendJson(res, 200, await readCodexAuthProfile()); }
    catch (error) { return sendJson(res, error.statusCode || 503, { error: error.code || 'codex_auth_profile_unavailable' }); }
  }
  if (parsed.pathname === '/api/agent-usage') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'read_only', message: 'Usage доступен только для чтения.' } });
    if (!readAgentUsage) return sendJson(res, 503, { ok: false, error: { code: 'usage_unavailable', message: 'Usage API недоступен в этом экземпляре.' } });
    try {
      const result = await readAgentUsage({ provider: parsed.query.provider, accountKey: parsed.query.accountKey ?? null });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.statusCode || 500, { ok: false, error: {
        code: error.statusCode === 400 ? error.code : 'usage_unavailable',
        message: error.statusCode === 400 ? 'Проверьте provider и ключ аккаунта.' : 'Не удалось прочитать лимиты.',
      } });
    }
  }

  if (parsed.pathname === '/api/mobile-attachments' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const item = await storeMobileAttachment(body);
      return sendJson(res, 200, {
        ok: true,
        attachment: {
          id: item.id,
          kind: item.kind,
          name: item.name,
          mimeType: item.mimeType,
          size: item.size,
          path: item.path,
        },
      });
    } catch (e) {
      const status = Number(e?.statusCode) || 500;
      return sendJson(res, status, { ok: false, code: e?.code || 'attachment_upload_failed', error: String(e?.message || e) });
    }
  }

  if (parsed.pathname === '/api/mobile-attachments/preview' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const item = await readMobileAttachmentPreview(body);
      return sendJson(res, 200, { ok: true, attachment: item });
    } catch (e) {
      const status = Number(e?.statusCode) || 500;
      return sendJson(res, status, { ok: false, code: e?.code || 'attachment_preview_failed', error: String(e?.message || e) });
    }
  }

  let attachmentMatch = parsed.pathname.match(/^\/api\/mobile-attachments\/([^/]+)$/);
  if (attachmentMatch && req.method === 'DELETE') {
    try {
      await removeMobileAttachment(decId(attachmentMatch[1]));
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, Number(e?.statusCode) || 500, {
        ok: false,
        code: e?.code || 'attachment_delete_failed',
        error: String(e?.message || e),
      });
    }
  }

  if (parsed.pathname === '/api/app-settings' && req.method === 'GET') {
    try {
      const data = await bridgeRequest('getAppSettings', {}, 1500);
      return sendJson(res, 200, { streamerMode: !!data?.streamerMode });
    } catch (e) {
      return sendJson(res, 200, { streamerMode: false });
    }
  }

  if (parsed.pathname === '/api/app-settings' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('setAppSettings', {
        streamerMode: typeof body.streamerMode === 'boolean' ? body.streamerMode : undefined,
      }, 1500);
      return sendJson(res, 200, { streamerMode: !!data?.streamerMode });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Immutable boot snapshot of the Claude/Codex PTYs stopped by the previous
  // graceful app shutdown. `build:i-cont` reads this only from the replacement
  // app and submits through the ordinary Project API send scenario.
  if (parsed.pathname === '/api/build-continue-targets' && req.method === 'GET') {
    const snapshot = startupInterruptedSnapshot || {
      version: 1,
      source: 'snapshot-unavailable',
      capturedAt: null,
      shutdownPid: null,
      resolvedAt: Date.now(),
      targets: [],
      unresolved: [{ reason: 'startup interrupted snapshot unavailable' }],
    };
    return sendJson(res, 200, { ok: true, snapshot });
  }

  const projectManager = require('./project-manager');

  if (await handleSystemPromptApi({ req, res, parsed, service: systemPromptService, readBody, sendJson })) return;

  if (parsed.pathname === '/api/prompt-library' && req.method === 'GET') {
    if (!savedPromptService) return sendJson(res, 503, { error: 'saved prompt library service unavailable', code: 'app_update_required' });
    return sendJson(res, 200, savedPromptService.catalog());
  }
  if (parsed.pathname === '/api/prompt-library/read' && req.method === 'POST') {
    if (!savedPromptService) return sendJson(res, 503, { error: 'saved prompt library service unavailable', code: 'app_update_required' });
    try {
      const body = await readBody(req);
      const prompts = await savedPromptService.readMany({
        promptIds: body.promptIds,
        mode: body.mode,
        resolveText: (prompt) => resolveSavedPromptText(prompt, savedPromptService.list()),
      });
      return sendJson(res, 200, { prompts });
    } catch (error) {
      return sendJson(res, Number(error.statusCode) || 500, { error: error.message, code: error.code, revision: error.revision, prompt: error.prompt });
    }
  }
  if (parsed.pathname === '/api/prompt-groups' && req.method === 'POST') {
    if (!savedPromptService) return sendJson(res, 503, { error: 'saved prompt library service unavailable', code: 'app_update_required' });
    try { return sendJson(res, 201, { group: savedPromptService.createGroup(await readBody(req)) }); }
    catch (error) { return sendJson(res, Number(error.statusCode) || 500, { error: error.message, code: error.code, revision: error.revision, group: error.group }); }
  }
  const groupPathMatch = /^\/api\/prompt-groups\/(\d+)$/.exec(parsed.pathname);
  if (groupPathMatch && ['GET', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!savedPromptService) return sendJson(res, 503, { error: 'saved prompt library service unavailable', code: 'app_update_required' });
    const groupId = Number(groupPathMatch[1]);
    try {
      if (req.method === 'GET') return sendJson(res, 200, { group: savedPromptService.getGroup(groupId) });
      const body = await readBody(req);
      if (req.method === 'PATCH') return sendJson(res, 200, { group: savedPromptService.updateGroup({ groupId, ...body }) });
      return sendJson(res, 200, savedPromptService.deleteGroup({ groupId, ...body }));
    } catch (error) {
      return sendJson(res, Number(error.statusCode) || 500, { error: error.message, code: error.code, revision: error.revision, group: error.group });
    }
  }
  if (parsed.pathname === '/api/prompts' && req.method === 'POST') {
    if (!savedPromptService) return sendJson(res, 503, { error: 'saved prompt library service unavailable', code: 'app_update_required' });
    try { return sendJson(res, 201, { prompt: savedPromptService.createPrompt(await readBody(req)) }); }
    catch (error) { return sendJson(res, Number(error.statusCode) || 500, { error: error.message, code: error.code, revision: error.revision, prompt: error.prompt }); }
  }
  const promptMoveMatch = /^\/api\/prompts\/([^/]+)\/move$/.exec(parsed.pathname);
  if (promptMoveMatch && req.method === 'POST') {
    if (!savedPromptService) return sendJson(res, 503, { error: 'saved prompt library service unavailable', code: 'app_update_required' });
    try {
      const body = await readBody(req);
      return sendJson(res, 200, { prompt: savedPromptService.movePrompt({ stableId: decId(promptMoveMatch[1]), ...body }) });
    } catch (error) {
      return sendJson(res, Number(error.statusCode) || 500, { error: error.message, code: error.code, revision: error.revision, prompt: error.prompt });
    }
  }
  const promptPathMatch = /^\/api\/prompts\/([^/]+)$/.exec(parsed.pathname);
  if (promptPathMatch && ['GET', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!savedPromptService) return sendJson(res, 503, { error: 'saved prompt update service unavailable' });
    const stableId = decId(promptPathMatch[1]);
    try {
      if (req.method === 'GET') {
        const currentPrompts = savedPromptService.list();
        const prompt = savedPromptService.get(stableId);
        return sendJson(res, 200, { prompt: { ...prompt, resolvedText: await resolveSavedPromptText(prompt, currentPrompts) } });
      }
      const body = await readBody(req);
      if (req.method === 'DELETE') return sendJson(res, 200, savedPromptService.deletePrompt({ stableId, revision: body.revision }));
      return sendJson(res, 200, { prompt: savedPromptService.update({ stableId, revision: body.revision, title: body.title, text: body.text, filePaths: body.filePaths, position: body.position }) });
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      return sendJson(res, status, {
        error: error.message,
        code: error.code || 'saved_prompt_update_failed',
        revision: error.revision,
        prompt: error.prompt,
      });
    }
  }

  if (parsed.pathname === '/api/tab-contexts' && req.method === 'GET') {
    if (!tabWorkContext) return sendJson(res, 503, { ok: false, error: 'tab work context unavailable' });
    await tabWorkContext.syncLinks();
    const wanted = parsed.query.tabIds ? new Set(String(parsed.query.tabIds).split(',')) : null;
    const tabs = tabWorkContext.list().filter((tab) => !wanted || wanted.has(tab.tabId));
    return sendJson(res, 200, { ok: true, tabs });
  }
  const contextRoute = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/work-context(?:\/(responsibility|updates))?$/);
  if (contextRoute) {
    if (!tabWorkContext) return sendJson(res, 503, { ok: false, error: 'tab work context unavailable' });
    const tabId = decId(contextRoute[1]);
    try {
      if (req.method === 'GET' && !contextRoute[2]) {
        tabWorkContext.requireTab(tabId);
        await tabWorkContext.syncLinks();
        return sendJson(res, 200, { ok: true, context: tabWorkContext.get(tabId) });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (contextRoute[2] === 'responsibility') return sendJson(res, 200, {
          ok: true, context: tabWorkContext.setResponsibility(tabId, body.description),
        });
        if (contextRoute[2] === 'updates') return sendJson(res, 200, {
          ok: true, ...tabWorkContext.publish(tabId, {
            title: body.title, text: body.text, sourceTabId: body.sourceTabId, requestId: body.requestId,
          }),
        });
      }
      return sendJson(res, 405, { ok: false, error: 'unsupported context operation' });
    } catch (error) { return sendJson(res, error.statusCode || 400, {
      ok: false, error: error.message, ...(error.code ? { code: error.code } : {}),
    }); }
  }

  if (parsed.pathname === '/api/tab-messages' || parsed.pathname.startsWith('/api/tab-messages/')) {
    const handled = await handleTabMessageApi(req, res, parsed, { service: getTabMessageService(),
      resolveTab: resolveTabMessageIdentity, readBody, sendJson });
    if (!handled) sendJson(res, 404, { ok: false, error: 'unknown_tab_message_route' });
    return;
  }

  if (parsed.pathname === '/api/external-research/orchestrations' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const sourceTabId = cleanOptionalString(body.sourceTabId, '');
      if (!sourceTabId) return sendJson(res, 400, { ok: false, error: 'sourceTabId required' });
      const source = findOrchestrationTabDescriptor(sourceTabId);
      if (!source) return sendJson(res, 404, { ok: false, error: 'source tab not found' });
      const notifySource = body.notifySource !== false;
      if (notifySource && !source.toolType) {
        return sendJson(res, 409, { ok: false, error: 'source tab is not a Claude/Codex agent' });
      }

      const requestedRunId = cleanOptionalString(body.runId, '') || crypto.randomUUID();
      const continueFromRunId = cleanOptionalString(body.continueFromRunId, '');
      const previous = continueFromRunId
        ? await getOrchestrationRunStore().getInternal(continueFromRunId)
        : null;
      const request = continueFromRunId
        ? continuationRequest(previous, body)
        : normalizeExternalResearchRequest(body);

      const sourceMeta = body.sourceMeta && typeof body.sourceMeta === 'object'
        ? body.sourceMeta
        : null;
      const sourceExecutionContext = resolveCausalSourceExecutionContext({
        sourceTabId,
        sourceMeta,
        getExecutionContext: getAgentExecutionContext,
      });
      const label = cleanOptionalString(body.label, '');
      const parentRunId = cleanOptionalString(body.parentRunId, '');
      const requestFingerprint = externalResearchRequestFingerprint({
        runId: requestedRunId,
        sourceTabId,
        request,
        label,
        parentRunId,
        continueFromRunId,
        notifySource,
      });
      const jobId = externalResearchJobId(requestedRunId);
      const targetLabel = externalResearchTargetLabel(request);
      const existingRun = await getOrchestrationRunStore().getInternal(requestedRunId);
      const sourceSendTarget = notifySource ? await captureOrchestrationSourceTarget(source, existingRun, sourceExecutionContext) : null;
      if (!existingRun) await assertExternalResearchCapabilities(request.provider);
      const reservation = await getOrchestrationRunStore().reserveOrGet({
        runId: requestedRunId,
        runKind: 'external-research',
        requestFingerprint,
        status: 'creating',
        label,
        sourceTabId,
        sourceTabName: source.tabName,
        sourceProjectId: source.projectId,
        sourceProjectName: source.projectName,
        sourceProjectPath: source.projectPath,
        sourceExecutionContext,
        sourceToolType: sourceSendTarget?.toolType || source.toolType,
        sourceSendTarget,
        sourceSessionId: sourceSendTarget?.sessionId || null,
        targetTabId: null,
        targetTabName: targetLabel,
        targetProjectId: null,
        targetProjectName: 'SC Desktop',
        targetProjectPath: null,
        targetToolType: null,
        targetCreated: false,
        parentRunId: parentRunId || undefined,
        waitForDescendants: body.waitForDescendants !== false,
        notifySource,
        autoStopCreatedTargets: false,
        requiresTargetPromptProof: false,
        promptChars: request.prompt.length,
        externalResearchJobId: jobId,
        externalResearchProvider: request.provider,
        externalResearchModel: request.options?.model || null,
        externalResearchEffort: request.options?.effort || null,
        externalResearchMode: request.options?.mode || null,
        externalResearchContinuedFromRunId: continueFromRunId || null,
        externalResearchConversationUrl: request.conversationUrl || null,
        externalResearchIntent: request,
      });
      if (reservation.conflict) {
        return sendJson(res, 409, {
          ok: false,
          code: 'idempotency_key_reused',
          error: reservation.reason === 'request-identity-unavailable'
            ? 'runId belongs to a legacy run whose request identity cannot be proven'
            : 'runId was already used for a different external research request',
          run: withOrchestrationUrls(reservation.run),
        });
      }
      const run = reservation.run;
      if (reservation.created) emitOrchestrationRun(run, 'external-research-reserved');
      getExternalResearchCoordinator().watch(
        run.runId,
        reservation.created ? 'external-research-request' : 'external-research-idempotent-retry',
      );
      return sendJson(res, reservation.created ? 202 : 200, {
        ok: true,
        accepted: true,
        idempotent: reservation.created !== true,
        runId: run.runId,
        jobId: run.externalResearchJobId,
        run: withOrchestrationUrls(run),
      });
    } catch (error) {
      return sendJson(res, Number(error?.statusCode || error?.status) || 400, {
        ok: false,
        code: error?.code || 'external_research_orchestration_failed',
        error: String(error?.message || error),
      });
    }
  }

  if (parsed.pathname === '/api/orchestrations' && req.method === 'GET') {
    const tabId = parsed.query.tabId ? decId(String(parsed.query.tabId)) : null;
    const runs = tabId
      ? await getOrchestrationRunStore().listForTab(tabId, { activeOnly: parsed.query.active === '1' })
      : await getOrchestrationRunStore().listActive();
    return sendJson(res, 200, { ok: true, runs: runs.map(withOrchestrationUrls) });
  }

  if (parsed.pathname === '/api/orchestrations/settings' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, settings: await getOrchestrationRunStore().getSettings() });
  }

  if (parsed.pathname === '/api/orchestrations/settings' && req.method === 'POST') {
    const body = await readBody(req);
    const settings = await getOrchestrationRunStore().updateSettings({
      failureGraceMs: Object.prototype.hasOwnProperty.call(body, 'failureGraceMs') ? body.failureGraceMs : undefined,
      successAutoStopMs: Object.prototype.hasOwnProperty.call(body, 'successAutoStopMs') ? body.successAutoStopMs : undefined,
      reactToManualInterrupt: typeof body.reactToManualInterrupt === 'boolean' ? body.reactToManualInterrupt : undefined,
      autoStopCreatedTargets: typeof body.autoStopCreatedTargets === 'boolean' ? body.autoStopCreatedTargets : undefined,
      codexCapacityRetryEnabled: typeof body.codexCapacityRetryEnabled === 'boolean' ? body.codexCapacityRetryEnabled : undefined,
      codexCapacityRetryLimit: Object.prototype.hasOwnProperty.call(body, 'codexCapacityRetryLimit') ? body.codexCapacityRetryLimit : undefined,
    });
    ipcMain.emit('codex-capacity-retry:settings-updated', null, settings);
    void scheduleOrchestrationPolicyTimer();
    return sendJson(res, 200, { ok: true, settings });
  }

  if (parsed.pathname === '/api/orchestrations' && req.method === 'POST') {
    let createdRunId = null;
    let preparedWorkContext = null;
    try {
      const body = await readBody(req);
      const taskPrompt = cleanOptionalString(body.prompt ?? body.text, '');
      const sourceTabId = cleanOptionalString(body.sourceTabId, '');
      let targetTabId = cleanOptionalString(body.targetTabId, '');
      let targetProjectId = cleanOptionalString(body.targetProjectId || body.projectId, '');
      const forkFromTabId = cleanOptionalString(body.forkFromTabId, '');
      const requestedCwd = cleanOptionalString(body.cwd, '');
      const windowTarget = body.windowTarget && typeof body.windowTarget === 'object'
        ? body.windowTarget
        : null;
      const requestedTargetToolType = resolveAgentProvider({
        toolType: body.toolType,
        provider: body.provider,
        fallback: 'claude',
      });
      const notifySource = body.notifySource !== false;
      if (!taskPrompt) return sendJson(res, 400, { ok: false, error: 'prompt required' });
      if (!sourceTabId) return sendJson(res, 400, { ok: false, error: 'sourceTabId required' });
      if (targetTabId && forkFromTabId) {
        return sendJson(res, 400, { ok: false, error: 'targetTabId and forkFromTabId are mutually exclusive' });
      }
      if (body.compactBeforeTask === true && !forkFromTabId) {
        return sendJson(res, 400, { ok: false, error: 'compactBeforeTask requires forkFromTabId' });
      }
      if (!targetTabId && !targetProjectId && !forkFromTabId && !windowTarget) {
        return sendJson(res, 400, { ok: false, error: 'targetTabId, targetProjectId, forkFromTabId, or windowTarget required' });
      }

      const requestedRunId = cleanOptionalString(body.runId, '') || crypto.randomUUID();
      const promptPresentation = await resolveSendPromptPresentation(projectManager, body, taskPrompt);
      let prompt = promptPresentation.prompt;
      const source = findOrchestrationTabDescriptor(sourceTabId);
      if (!source) return sendJson(res, 404, { ok: false, error: 'source tab not found' });
      let resolvedCreationTarget = null;
      if (!targetTabId && !forkFromTabId) {
        resolvedCreationTarget = await bridgeRequest('resolveWorkspaceCreationTarget', {
          projectId: targetProjectId || undefined,
          fallbackProjectId: source.projectId,
          cwd: requestedCwd || undefined,
          sourceTabId,
          windowTarget: windowTarget || undefined,
        }, 8_000);
        targetProjectId = resolvedCreationTarget?.creation?.projectId || targetProjectId;
      }
      const forkSource = forkFromTabId ? findOrchestrationTabDescriptor(forkFromTabId) : null;
      if (forkFromTabId && !forkSource) {
        return sendJson(res, 404, { ok: false, error: 'fork source tab not found or not open' });
      }
      if (forkSource && !forkSource.toolType) {
        return sendJson(res, 409, { ok: false, error: 'fork source is not a Claude/Codex agent' });
      }
      if (forkSource && !targetProjectId) targetProjectId = forkSource.projectId;
      if (!targetTabId && !targetProjectId) {
        return sendJson(res, 400, { ok: false, error: 'target project could not be resolved' });
      }
      if (forkSource && forkSource.projectId !== targetProjectId) {
        return sendJson(res, 409, { ok: false, error: 'fork target must stay in the source project' });
      }
      if (notifySource && !source.toolType) {
        return sendJson(res, 409, { ok: false, error: 'source tab is not a Claude/Codex agent' });
      }
      const sourceMeta = body.sourceMeta && typeof body.sourceMeta === 'object'
        ? body.sourceMeta
        : null;
      const sourceExecutionContext = resolveCausalSourceExecutionContext({
        sourceTabId,
        sourceMeta,
        getExecutionContext: getAgentExecutionContext,
      });

      const requestedTargetTabId = targetTabId;
      const targetName = cleanOptionalString(body.name || body.targetName, '');
      const requestedModelInput = cleanOptionalString(body.model || body.codexModel, '');
      const requestedEffort = cleanOptionalString(body.effort || body.codexEffort, '');
      const requestedThinking = cleanOptionalString(body.thinking, '');
      let target = targetTabId ? findOrchestrationTabDescriptor(targetTabId) : null;
      let targetCreated = !targetTabId;
      let targetNeedsRestore = false;
      let restorableTarget = null;
      let targetPlacement = null;
      if (targetTabId && !target) {
        restorableTarget = findRestorableAgentTabDescriptor(targetTabId);
        if (restorableTarget?.ok !== true) {
          return sendJson(res, Number(restorableTarget?.statusCode) || 404, {
            ok: false,
            success: false,
            code: restorableTarget?.code || 'target_tab_not_restorable',
            error: restorableTarget?.error || 'target tab not found',
          });
        }
        target = restorableTarget;
        targetNeedsRestore = true;
      }
      if (!targetTabId) {
        const targetProject = findOrchestrationProjectDescriptor(targetProjectId);
        if (!targetProject) {
          return sendJson(res, 404, { ok: false, error: 'target project not found' });
        }
        targetPlacement = resolveNewAgentTabPlacement({
          placement: body.placement,
          parentTabId: cleanOptionalString(body.parentTabId, '') || forkFromTabId,
          sourceTabId,
          sourceProjectId: source.projectId,
          targetProjectId,
        });
        if (targetPlacement.visualParentTabId) {
          const parent = targetPlacement.visualParentTabId === sourceTabId
            ? source
            : findOrchestrationTabDescriptor(targetPlacement.visualParentTabId);
          if (!parent) {
            return sendJson(res, 404, { ok: false, error: 'parent tab not found' });
          }
          if (parent.projectId !== targetProjectId) {
            return sendJson(res, 409, {
              ok: false,
              error: 'parent tab must belong to the target project',
            });
          }
        }
        targetTabId = reservedOrchestrationTargetTabId(targetProjectId, requestedRunId);
        target = {
          tabId: targetTabId,
          tabName: targetName || targetTabId.slice(-12),
          projectId: targetProject.projectId,
          projectName: targetProject.projectName,
          projectPath: targetProject.projectPath,
          cwd: requestedCwd || resolvedCreationTarget?.creation?.cwd || forkSource?.cwd || targetProject.cwd,
          toolType: forkSource?.toolType || requestedTargetToolType,
          commandType: forkSource?.toolType || requestedTargetToolType,
        };
      }
      if (targetTabId === sourceTabId) {
        return sendJson(res, 409, { ok: false, error: 'source and target tabs must be different' });
      }
      if (!target?.toolType) {
        return sendJson(res, 409, { ok: false, error: 'target tab is not a Claude/Codex agent' });
      }
      const hasExplicitTargetProvider = Boolean(
        cleanOptionalString(body.toolType, '') || cleanOptionalString(body.provider, ''),
      );
      if (requestedTargetTabId && hasExplicitTargetProvider
        && requestedTargetToolType !== target.toolType) {
        const mismatch = new Error(
          `Requested ${requestedTargetToolType} cannot target an existing ${target.toolType} tab.`,
        );
        mismatch.code = 'agent_target_provider_mismatch';
        mismatch.statusCode = 400;
        throw mismatch;
      }
      if (forkSource && hasExplicitTargetProvider && requestedTargetToolType !== forkSource.toolType) {
        const mismatch = new Error(
          `Requested ${requestedTargetToolType} cannot fork a ${forkSource.toolType} session.`,
        );
        mismatch.code = 'agent_fork_provider_mismatch';
        mismatch.statusCode = 400;
        throw mismatch;
      }
      const requestedModel = (await resolveProjectAgentModelRequest(projectManager, {
        provider: target.toolType,
        model: requestedModelInput,
        modelSelection: body.modelSelection,
      })).model;

      const priorContextRun = await getOrchestrationRunStore().getInternal(requestedRunId);
      if (tabWorkContext && (!priorContextRun
        || tabWorkContext.hasHandoff(targetTabId, 'orchestration:' + requestedRunId))) {
        const prepared = await tabWorkContext.prepare(targetTabId, 'orchestration:' + requestedRunId, prompt);
        prompt = prepared.prompt;
        if (!priorContextRun) preparedWorkContext = { tabId: targetTabId, handoffId: 'orchestration:' + requestedRunId };
      }
      const requestFingerprint = orchestrationRequestFingerprint({
        sourceTabId,
        targetTabId: requestedTargetTabId,
        targetProjectId,
        targetToolType: target?.toolType || requestedTargetToolType,
        name: targetName,
        placement: targetPlacement?.placement || null,
        visualParentTabId: targetPlacement?.visualParentTabId || null,
        afterTabId: targetPlacement?.afterTabId || null,
        cwd: requestedCwd || resolvedCreationTarget?.creation?.cwd || null,
        windowTarget,
        forkFromTabId,
        fullHistoryFork: body.fullHistoryFork === true,
        compactBeforeTask: body.compactBeforeTask === true,
        prompt: promptPresentation.identityPrompt,
        contextFiles: promptPresentation.contextFiles,
        label: cleanOptionalString(body.label, ''),
        model: requestedModel,
        effort: requestedEffort,
        thinking: requestedThinking,
        queue: body.queue !== false,
        notifySource,
        waitForDescendants: body.waitForDescendants !== false,
        parentRunId: cleanOptionalString(body.parentRunId, ''),
        failureGraceMs: body.failureGraceMs,
        successAutoStopMs: body.successAutoStopMs,
        reactToManualInterrupt: body.reactToManualInterrupt,
        autoStopCreatedTargets: body.autoStopCreatedTargets,
      });
      const sourceSendTarget = notifySource
        ? await captureOrchestrationSourceTarget(source, priorContextRun, sourceExecutionContext) : null;
      const reservation = await getOrchestrationRunStore().reserveOrGet({
        runId: requestedRunId,
        requestFingerprint,
        status: targetCreated || targetNeedsRestore ? 'starting' : 'sending',
        label: cleanOptionalString(body.label, ''),
        sourceTabId,
        sourceTabName: source.tabName,
        sourceProjectId: source.projectId,
        sourceProjectName: source.projectName,
        sourceProjectPath: source.projectPath,
        targetTabId,
        targetTabName: target.tabName,
        targetProjectId: target.projectId,
        targetProjectName: target.projectName,
        targetProjectPath: target.projectPath,
        targetCwd: target.cwd,
        targetWindowTarget: windowTarget,
        targetToolType: target.toolType,
        targetCreated,
        targetPlacement: targetPlacement?.placement || null,
        targetParentTabId: targetPlacement?.visualParentTabId || null,
        forkFromTabId: forkFromTabId || null,
        forkSourceSessionId: forkSource?.sessionId || null,
        fullHistoryFork: forkFromTabId ? body.fullHistoryFork === true : false,
        compactBeforeTask: forkFromTabId ? body.compactBeforeTask === true : false,
        parentRunId: cleanOptionalString(body.parentRunId, '') || undefined,
        sourceExecutionContext,
        sourceToolType: sourceSendTarget?.toolType || source.toolType,
        sourceSendTarget,
        sourceSessionId: sourceSendTarget?.sessionId || null,
        waitForDescendants: body.waitForDescendants !== false,
        notifySource,
        failureGraceMs: Number.isFinite(Number(body.failureGraceMs)) ? Number(body.failureGraceMs) : undefined,
        successAutoStopMs: Number.isFinite(Number(body.successAutoStopMs)) ? Number(body.successAutoStopMs) : undefined,
        reactToManualInterrupt: typeof body.reactToManualInterrupt === 'boolean' ? body.reactToManualInterrupt : undefined,
        autoStopCreatedTargets: typeof body.autoStopCreatedTargets === 'boolean' ? body.autoStopCreatedTargets : undefined,
        promptHash: promptFingerprint(prompt),
        targetPromptAuditHash: promptAuditFingerprint(prompt),
        requiresTargetPromptProof: true,
        promptChars: prompt.length,
        contextFiles: promptPresentation.contextFiles,
        // A second delegation to the same target must wait in the Project API,
        // not inside Claude's native busy queue.  Persist the unsent intent so
        // that this queue survives restart; publicRun() redacts it.
        deliveryIntent: {
          prompt,
          promptChips: promptPresentation.promptChips,
          contextFiles: promptPresentation.contextFiles,
          model: requestedModel,
          effort: requestedEffort,
          thinking: requestedThinking,
          queueRequested: body.queue !== false,
        },
      });
      if (reservation.conflict) {
        if (preparedWorkContext) tabWorkContext?.release(preparedWorkContext.tabId, preparedWorkContext.handoffId);
        return sendJson(res, 409, {
          ok: false,
          code: 'idempotency_key_reused',
          error: reservation.reason === 'request-identity-unavailable'
            ? 'runId belongs to a legacy run whose request identity cannot be proven'
            : 'runId was already used for a different orchestration request',
          run: withOrchestrationUrls(reservation.run),
        });
      }
      if (!reservation.created) {
        let idempotentRun = reservation.run;
        if (isActiveStatus(idempotentRun.status)) {
          if (!findOrchestrationTabDescriptor(idempotentRun.targetTabId)) {
            const recovered = await recoverMissingOrchestrationTarget(
              idempotentRun,
              'idempotent-retry',
            );
            idempotentRun = recovered.run || idempotentRun;
          } else {
            const internalExisting = await getOrchestrationRunStore().getInternal(idempotentRun.runId);
            if (internalExisting?.deliveryIntent) {
              const delivery = await dispatchDeferredOrchestrationRun(idempotentRun.runId, {
                reason: 'idempotent-retry',
              });
              idempotentRun = delivery.run || await getOrchestrationRunStore().get(idempotentRun.runId);
            }
          }
        }
        return sendJson(res, 200, {
          ok: true,
          idempotent: true,
          run: withOrchestrationUrls(idempotentRun),
        });
      }
      let run = reservation.run;
      let admittedTarget = null;
      createdRunId = run.runId;
      emitOrchestrationRun(run, 'reserved');

      if (targetNeedsRestore) {
        const restored = await ensureExplicitAgentTabOpen(targetTabId, restorableTarget);
        target = restored.descriptor;
        run = await getOrchestrationRunStore().patch(run.runId, {
          status: 'starting',
          targetMaterializedAt: Date.now(),
          targetTabName: target.tabName,
          targetProjectId: target.projectId,
          targetProjectName: target.projectName,
          targetProjectPath: target.projectPath,
          targetCwd: target.cwd,
          targetToolType: target.toolType,
        });
        emitOrchestrationRun(run, 'target-restored');
      }

      if (targetCreated) {
        const internalReservedRun = await getOrchestrationRunStore().getInternal(run.runId);
        const created = await materializeReservedOrchestrationTarget(
          internalReservedRun,
          internalReservedRun?.deliveryIntent,
        );
        admittedTarget = created;
        if (!created?.tabId || created.tabId !== targetTabId) {
          throw new Error('created target tab does not match its durable reservation');
        }
        target = findOrchestrationTabDescriptor(targetTabId) || {
          ...target,
          tabName: created?.name || target.tabName,
          projectId: created?.projectId || target.projectId,
          projectName: created?.projectName || target.projectName,
          projectPath: created?.projectPath || created?.cwd || target.projectPath,
          cwd: created?.cwd || target.cwd,
          toolType: created?.toolType || target.toolType,
          commandType: created?.commandType || target.commandType,
        };
        run = await getOrchestrationRunStore().patch(run.runId, {
          status: 'starting',
          targetMaterializedAt: Date.now(),
          targetTabName: target.tabName,
          targetProjectId: target.projectId,
          targetProjectName: target.projectName,
          targetProjectPath: target.projectPath,
          targetCwd: target.cwd,
          targetToolType: target.toolType,
          forkSourceSessionId: created.sourceSessionId || run.forkSourceSessionId || null,
          targetForkSessionId: created.sessionId || run.targetForkSessionId || null,
        });
      }
      emitOrchestrationRun(run, 'created');

      let targetStatus = null;
      if (targetCreated) {
        const startupTimeoutMs = Math.max(5_000, Math.min(60_000, Number(body.startupTimeoutMs) || 20_000));
        targetStatus = await waitForAgentReady(targetTabId, startupTimeoutMs, admittedTarget || {});
      } else {
        targetStatus = await resolveAgentSessionInfo(targetTabId, 2000);
      }
      persistOrchestrationForkEvent(
        run,
        targetStatus?.sessionId || run.targetForkSessionId || null,
      );
      const baselineStatus = targetStatus?.status || targetStatus?.sessionStatus || 'unknown';
      await getOrchestrationRunStore().patch(run.runId, {
        status: 'sending',
        sessionId: targetStatus?.sessionId || null,
        targetLaunchGeneration: targetStatus?.launchGeneration || null,
      });
      emitOrchestrationRun(await getOrchestrationRunStore().get(run.runId), 'sending');

      const internalRun = await getOrchestrationRunStore().getInternal(run.runId);
      const predecessor = internalRun?.predecessorRunId
        ? await getOrchestrationRunStore().getInternal(internalRun.predecessorRunId)
        : null;
      const targetBusy = baselineStatus === 'busy'
        || targetStatus?.busy === true
        || targetStatus?.turnBusy === true
        || targetStatus?.isBusy === true;
      const predecessorBlocksDelivery = Boolean(predecessor
        && (!isTerminalStatus(predecessor.status)
          || (predecessor.status === 'completed' && predecessor.resultComplete !== true)));
      if ((targetBusy || predecessorBlocksDelivery) && body.queue === false) {
        await getOrchestrationRunStore().resetDeferredDelivery(run.runId, 'queue-disabled');
        const failed = await getOrchestrationRunStore().beginRecovery(
          run.runId,
          'failed',
          'target is busy and queue=false',
          { failureGraceMs: 0 },
        );
        emitOrchestrationChanges(failed.changed, 'send-refused-busy');
        await finalizeSettledOrchestrations(failed.settled, 'send-refused-busy');
        return sendJson(res, 409, {
          ok: false,
          success: false,
          code: 'target_busy',
          error: 'target is busy and queue=false',
          runId: run.runId,
          targetTabId,
        });
      }

      if (targetBusy || predecessorBlocksDelivery) {
        const queued = await getOrchestrationRunStore().deferDelivery(run.runId, {
          reason: predecessorBlocksDelivery ? 'predecessor-not-materialized' : 'target-busy',
          sessionId: targetStatus?.sessionId || null,
          lifecycleGeneration: targetStatus?.lifecycleGeneration || null,
          launchGeneration: targetStatus?.launchGeneration || null,
        });
        emitOrchestrationRun(queued, 'delivery-deferred');
        // Close the race where the predecessor became fully idle between the
        // first status read and persisting this queue row.  This is one fresh
        // event-boundary check, not polling.
        const immediateWake = await dispatchDeferredOrchestrationRun(run.runId, {
          reason: 'post-defer-reconcile',
        });
        return sendJson(res, 202, {
          ok: true,
          accepted: true,
          queued: immediateWake.dispatched !== true,
          run: withOrchestrationUrls(immediateWake.run || queued),
        });
      }

      const delivery = await dispatchDeferredOrchestrationRun(run.runId, {
        reason: 'request',
        targetStatus,
      });
      if (delivery.reason === 'send-failed') {
        return sendSendFailure(res, delivery.sendResult, { runId: run.runId, targetTabId });
      }
      if (!delivery.dispatched && !delivery.deferred) {
        return sendJson(res, 409, {
          ok: false,
          success: false,
          code: delivery.reason || 'send_failed',
          error: delivery.reason || 'send failed',
          runId: run.runId,
          targetTabId,
        });
      }
      const reconciled = delivery.run;
      return sendJson(res, 202, {
        ok: true,
        accepted: true,
        queued: delivery.deferred === true || delivery.receiptState === 'queued',
        submitted: delivery.sendResult?.submitted,
        handoffId: delivery.sendResult?.handoffId || null,
        status: delivery.receiptState === 'delivery-unknown'
          ? 'delivery-unknown'
          : delivery.receiptState === 'audit-pending'
            ? 'audit-pending'
            : delivery.receiptState === 'queued'
              ? 'queued'
              : 'accepted',
        deliveryUnknown: delivery.receiptState === 'delivery-unknown',
        auditPending: delivery.receiptState === 'audit-pending',
        run: withOrchestrationUrls(reconciled),
      });
    } catch (error) {
      if (preparedWorkContext && !createdRunId) tabWorkContext?.release(preparedWorkContext.tabId, preparedWorkContext.handoffId);
      if (createdRunId) {
        const failed = await getOrchestrationRunStore().beginRecovery(
          createdRunId,
          'startup_failed',
          String(error?.message || error),
        );
        emitOrchestrationChanges(failed.changed, 'orchestration-error');
        await finalizeSettledOrchestrations(failed.settled, 'orchestration-error');
        void scheduleOrchestrationPolicyTimer();
      }
      return sendJson(res, Number(error?.statusCode || error?.status) || 500, {
        ok: false,
        success: false,
        code: error?.code || 'orchestration_failed',
        runId: createdRunId,
        error: String(error?.message || error),
      });
    }
  }

  const orchestrationResultMatch = parsed.pathname.match(/^\/api\/orchestrations\/([^/]+)\/result$/);
  if (orchestrationResultMatch && req.method === 'GET') {
    const runId = decId(orchestrationResultMatch[1]);
    const requestedMaxChars = Math.max(500, Math.min(250_000, Number(parsed.query.maxChars) || 100_000));
    const initialRun = await getOrchestrationRunStore().getInternal(runId);
    if (isExternalResearchRun(initialRun)) {
      const external = await readExternalResearchResult(runId, requestedMaxChars);
      return sendJson(res, external.statusCode, external.body);
    }
    let run = await reconcileOrchestrationRun(runId, 'result-read', { resultReadMode: 'source-proof' });
    if (!run) return sendJson(res, 404, { ok: false, error: 'run not found' });
    if (isActiveStatus(run.status)) {
      return sendJson(res, 202, { ok: true, ready: false, status: run.status, run: withOrchestrationUrls(run) });
    }
    let internal = await getOrchestrationRunStore().getInternal(runId);
    if (run.status === 'completed' && run.resultComplete !== true) {
      await finalizeSettledOrchestration(internal, 'result-read-finalize');
      run = await getOrchestrationRunStore().get(runId);
      internal = await getOrchestrationRunStore().getInternal(runId);
    }
    const result = await probeOrchestrationResult(internal, {
      maxChars: requestedMaxChars,
      forceFresh: true,
      resultReadMode: 'source-proof',
    });
    if (run.status !== 'completed') {
      const resultFound = result.found === true && result.sourceVerified !== false;
      return sendJson(res, 200, {
        ok: true,
        ready: true,
        success: false,
        runId,
        status: run.status,
        outcome: run.outcome || run.status,
        error: run.error || 'run did not complete',
        sessionId: result.sessionId || run.sessionId || null,
        ...buildDelegationResultTarget(run),
        turnIndex: (resultFound ? result.turnIndex : null) ?? run.resultTurnIndex ?? null,
        userUuid: (resultFound ? result.userUuid : null) || run.resultUserUuid || null,
        assistantText: resultFound ? (result.assistantText || '') : '',
        assistantChars: resultFound ? (Number(result.assistantChars) || (result.assistantText || '').length) : 0,
        truncated: resultFound && result.truncated === true,
      });
    }
    if (!isCompleteOrchestrationResult(result)) {
      return sendJson(res, 202, {
        ok: true,
        ready: false,
        status: run.status,
        error: result.error || (result.found
          ? 'matching transcript turn is incomplete'
          : 'matching transcript turn not materialized'),
        run: withOrchestrationUrls(run),
      });
    }
    if (run.resultComplete !== true) {
      // The explicit result read may be the first observer after the final
      // JSONL append. Persist that proof and deliver the source notification;
      // returning 200 without repairing the durable run recreates the purple
      // loader on restart.
      await finalizeSettledOrchestration(internal, 'result-read-proved');
      run = await getOrchestrationRunStore().get(runId);
    }
    return sendJson(res, 200, {
      ok: true,
      ready: true,
      success: true,
      runId,
      status: run.status,
      sessionId: result.sessionId || run.sessionId || null,
      ...buildDelegationResultTarget(run),
      turnIndex: result.turnIndex ?? run.resultTurnIndex ?? null,
      userUuid: result.userUuid || run.resultUserUuid || null,
      assistantText: result.assistantText || '',
      assistantChars: Number(result.assistantChars) || (result.assistantText || '').length,
      truncated: result.truncated === true,
    });
  }

  const orchestrationCancelMatch = parsed.pathname.match(/^\/api\/orchestrations\/([^/]+)\/cancel$/);
  if (orchestrationCancelMatch && req.method === 'POST') {
    const runId = decId(orchestrationCancelMatch[1]);
    const current = await getOrchestrationRunStore().get(runId);
    if (!current) return sendJson(res, 404, { ok: false, error: 'run not found' });
    const body = await readBody(req);
    const cancellation = await getOrchestrationRunStore().cancel(runId, {
      reason: 'cancelled-by-api',
      suppressNotification: true,
    });
    const cancelled = cancellation?.run;
    emitOrchestrationChanges(cancellation?.changed, 'cancelled');
    await finalizeSettledOrchestrations(cancellation?.settled, 'cancelled');
    let interrupt = null;
    if (body.interrupt === true) {
      interrupt = isExternalResearchRun(current)
        ? await getScExternalResearchClient().stop(current.externalResearchJobId)
          .catch((error) => ({ success: false, error: String(error?.message || error) }))
        : await runAgentInterruptScenario(current.targetTabId, 5000)
          .catch((error) => ({ success: false, error: String(error?.message || error) }));
    }
    return sendJson(res, 200, { ok: true, run: withOrchestrationUrls(cancelled), interrupt });
  }

  const orchestrationActionMatch = parsed.pathname.match(/^\/api\/orchestrations\/([^/]+)\/action$/);
  if (orchestrationActionMatch && req.method === 'POST') {
    const runId = decId(orchestrationActionMatch[1]);
    const body = await readBody(req);
    const action = cleanOptionalString(body.action, '');
    const result = await performOrchestrationAction(runId, action, {
      tabId: cleanOptionalString(body.tabId, ''),
    });
    return sendJson(res, result?.ok === false ? (result.statusCode || 409) : 200, result);
  }

  const orchestrationAckMatch = parsed.pathname.match(/^\/api\/orchestrations\/([^/]+)\/ack$/);
  if (orchestrationAckMatch && req.method === 'POST') {
    const runId = decId(orchestrationAckMatch[1]);
    const body = await readBody(req);
    const tabId = cleanOptionalString(body.tabId, '');
    if (!tabId) return sendJson(res, 400, { ok: false, error: 'tabId required' });
    const acknowledged = await getOrchestrationRunStore().acknowledge(runId, tabId);
    if (!acknowledged) return sendJson(res, 404, { ok: false, error: 'run not found' });
    emitOrchestrationRun(acknowledged, 'acknowledged');
    return sendJson(res, 200, { ok: true, run: withOrchestrationUrls(acknowledged) });
  }

  const orchestrationStatusMatch = parsed.pathname.match(/^\/api\/orchestrations\/([^/]+)$/);
  if (orchestrationStatusMatch && req.method === 'GET') {
    const runId = decId(orchestrationStatusMatch[1]);
    const internal = await getOrchestrationRunStore().getInternal(runId);
    const run = isExternalResearchRun(internal)
      ? await reconcileExternalResearchRun(runId, 'external-status-read')
      : await getOrchestrationRunStore().get(runId);
    if (!run) return sendJson(res, 404, { ok: false, error: 'run not found' });
    return sendJson(res, 200, { ok: true, run: withOrchestrationUrls(run) });
  }

  if (parsed.pathname === '/api/inbox' && req.method === 'GET') {
    const inbox = projectManager.db.getProjectById(INBOX_PROJECT_ID);
    if (!inbox) return sendJson(res, 500, { error: 'inbox project missing' });
    return sendJson(res, 200, {
      project: {
        id: inbox.id,
        name: inbox.name,
        path: inbox.path,
        icon: inbox.icon || null,
        isSystem: true,
        systemType: 'inbox',
        tabCount: (inbox.tabs || []).length,
      },
    });
  }

  // Projects list (from SQLite — includes closed projects too)
  if (parsed.pathname === '/api/projects' && req.method === 'GET') {
    // Ask renderer which projects are currently open in the desktop UI so the
    // mobile client can split into Active / All. If the bridge fails (renderer
    // not ready, no window), fall back to "nothing is active" — phone still
    // gets the project list, just without the badge.
    let openProjectIds = [];
    let openIds = new Set();
    let activeProjectId = null;
    let awaitingIds = new Set();
    let completionNotificationCounts = {};
    try {
      const data = await bridgeRequest('getOpenProjectIds', {}, 1500);
      if (Array.isArray(data?.ids)) {
        openProjectIds = data.ids;
        openIds = new Set(data.ids);
      }
      activeProjectId = data?.activeProjectId || null;
      if (Array.isArray(data?.awaitingIds)) awaitingIds = new Set(data.awaitingIds);
      if (data?.completionNotificationCounts && typeof data.completionNotificationCounts === 'object') {
        completionNotificationCounts = data.completionNotificationCounts;
      }
    } catch {}

    const openOrder = new Map(openProjectIds.map((id, index) => [id, index]));
    const all = projectManager.db.getAllProjects().map(p => {
      const tabs = p.tabs || [];
      const sdkTabs = tabs.filter(t => t.tabType === 'claude-sdk');
      // Count how many SDK tabs are streaming RIGHT NOW (one entry in
      // sdkSessions per active query). Lets the phone show a "live" pulse.
      const liveSdkCount = sdkTabs.filter(t => t.tabId && sdkSessions.has(t.tabId)).length;
      return {
        id: p.id,
        name: p.name,
        path: p.path,
        icon: p.icon || null,
        tabCount: tabs.length,
        sdkTabCount: sdkTabs.length,
        liveSdkCount,
        updatedAt: p.updatedAt,
        isOpen: openIds.has(p.id),
        isActive: p.id === activeProjectId,
        hasAwaiting: awaitingIds.has(p.id),
        completionNotificationCount: Number(completionNotificationCounts[p.id]) || 0,
        isSystem: isInboxProjectId(p.id),
        systemType: isInboxProjectId(p.id) ? 'inbox' : null,
      };
    });
    all.sort((a, b) => {
      if (isInboxProjectId(a.id) !== isInboxProjectId(b.id)) return isInboxProjectId(a.id) ? -1 : 1;
      const aOpen = openOrder.has(a.id);
      const bOpen = openOrder.has(b.id);
      if (aOpen && bOpen) return openOrder.get(a.id) - openOrder.get(b.id);
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return sendJson(res, 200, { projects: all });
  }

  // Read-only batch used by GT Editor's sidebar. One request per visible root,
  // never one request per file row. Authentication is the normal Project API
  // bearer token checked below by the shared request gate.
  if (parsed.pathname === '/api/project-prompt-usage' && req.method === 'GET') {
    if (!projectPromptCatalog) return sendJson(res, 503, { ok: false, error: 'project prompt catalog unavailable' });
    const rootPath = cleanOptionalString(parsed.query.root, '');
    if (!rootPath || !path.isAbsolute(rootPath)) {
      return sendJson(res, 400, { ok: false, error: 'absolute root required' });
    }
    try {
      const usages = projectPromptCatalog.usageForRoot(rootPath);
      return sendJson(res, 200, { ok: true, root: rootPath, usages, updatedAt: Date.now() });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message || error) });
    }
  }

  // Rename a project. Mobile parity with the tab rename below — same shape
  // (POST {name}) delegating to the renderer store so the desktop UI, the
  // SQLite metadata and the mobile list all converge. `renameProject` bridge
  // action persists via project:save-metadata (see useProjectsStore.updateProject).
  // NOTE: first use of `m` in this handler — declare it here with `let`. The old
  // first declaration (the /tabs route below) is now a plain reassignment. A
  // bare `m = …` here referenced the later `let m` → TDZ "Cannot access 'm'
  // before initialization", which 500'd every route from this point down.
  let m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/rename$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    try {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name required' });
      const data = await bridgeRequest('renameProject', { projectId, name });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Soniox temporary API key — mints a short-lived (5 min) key bound to
  // websocket-transcribe usage. Mobile client never sees SONIOX_API_KEY itself.
  // The mint call goes to api.soniox.com with our long-lived key in the
  // Authorization header; returned `api_key` is what the browser uses to open
  // wss://stt-rt.soniox.com/transcribe-websocket. If SONIOX_API_KEY is missing
  // from env we return 503 so the client can disable the mic button.
  if (parsed.pathname === '/api/soniox-token' && req.method === 'POST') {
    try {
      const key = process.env.SONIOX_API_KEY;
      if (!key) return sendJson(res, 503, { error: 'SONIOX_API_KEY not configured' });
      const r = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 300 }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return sendJson(res, 502, { error: `soniox ${r.status}: ${txt.slice(0, 200)}` });
      }
      const data = await r.json();
      return sendJson(res, 200, { api_key: data.api_key, expires_at: data.expires_at });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Client-side log sink — mobile sends diagnostic lines here, they land in
  // logs/dev.log via the [WebClient] tag so the user's standard log workflow
  // picks them up. POST body: { tag: 'TimelineGoTo', msg: '...', data: any }.
  if (parsed.pathname === '/api/log/client' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const tag = body.tag || 'WebClient';
      const msg = body.msg || '';
      const data = body.data !== undefined ? ' ' + JSON.stringify(body.data) : '';
      console.log(`[${tag}] ${msg}${data}`);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Read-only file preview for mobile file-tabs. The tab list already exposes
  // filePath for tabType='file'; this endpoint returns the current file body so
  // mobile can show the same Markdown document without depending on renderer
  // Zustand/FilePreview state.
  if (parsed.pathname === '/api/file-preview' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const filePath = String(body.path || '').trim();
      if (!filePath) return sendJson(res, 400, { error: 'path required' });
      if (!path.isAbsolute(filePath)) return sendJson(res, 400, { error: 'absolute path required' });
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return sendJson(res, 400, { error: 'not a file' });
      const MAX_FILE_PREVIEW_BYTES = 1024 * 1024;
      if (stat.size > MAX_FILE_PREVIEW_BYTES) {
        return sendJson(res, 413, { error: 'file too large for mobile preview' });
      }
      const content = await fs.promises.readFile(filePath, 'utf8');
      return sendJson(res, 200, {
        path: filePath,
        name: path.basename(filePath),
        ext: path.extname(filePath).toLowerCase(),
        size: stat.size,
        content,
      });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  // Prompts library (groups + items). Read-only — used by mobile composer
  // Insert-Prompt button. Schema:
  //   group: { id, name, position }
  //   prompt: { id, title, content, group_id?, position, file_paths[], resolvedText }
  if (parsed.pathname === '/api/prompts' && req.method === 'GET') {
    try {
      const groups = projectManager.getPromptGroups();
      const sourcePrompts = savedPromptService ? savedPromptService.list() : projectManager.getPrompts();
      const prompts = await Promise.all(sourcePrompts.map(async (prompt) => ({
        ...prompt,
        // Legacy clients use this field as the selected prompt's own assembled
        // payload and may build ancestor chips themselves. Keep that response
        // shape stable; the targeted and batch read APIs expose inheritance.
        resolvedText: await resolveSavedPromptText(prompt, []),
      })));
      // Cheap content fingerprint — client passes ?etag=<previous> to skip the
      // body when nothing changed. SHA-1 of the canonical JSON, hex-truncated
      // to 16 chars (~10^19 keys, plenty for a never-evicted cache).
      const json = JSON.stringify({ groups, prompts });
      const etag = crypto.createHash('sha1').update(json).digest('hex').slice(0, 16);
      const clientEtag = parsed.query.etag;
      if (clientEtag && clientEtag === etag) {
        // 304-equivalent: return tiny payload, mobile reuses its localStorage copy.
        return sendJson(res, 200, { etag, unchanged: true });
      }
      return sendJson(res, 200, { groups, prompts, etag });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Agent model catalog for native/web clients. The account-scoped live list
  // contributes capability bounds, while the user's Settings catalog owns
  // visibility, order, labels, and selected efforts. External clients must not
  // resurrect unchecked rows merely because `codex debug models` reports them.
  // Claude rows use the same Settings keys/labels/runtime ids as mutation
  // resolution. Server-wide, no tabId, no bridge. Direct `pathname ===` route — does NOT touch
  // `m`, so it's safe above the `let m` chain (see fact-mobile-web.md::let m TDZ).
  if (parsed.pathname === '/api/agent-models' && req.method === 'GET') {
    try {
      let codexSettings = null;
      let defaultCodexModel = null;
      let defaultCodexEffort = null;
      try {
        codexSettings = projectManager?.db?.getAppState?.('codexSettings') || null;
        defaultCodexModel = projectManager?.db?.getAppState?.('defaultCodexModel') || null;
        defaultCodexEffort = projectManager?.db?.getAppState?.('defaultCodexEffort') || null;
      } catch (e) {
        console.warn('[WebServer] /api/agent-models settings unavailable:', e.message);
      }
      const [configuredCodexModels, configuredClaudeModels] = await Promise.all([
        projectedModelsForProvider(projectManager, 'codex'),
        projectedModelsForProvider(projectManager, 'claude'),
      ]);
      return sendJson(res, 200, {
        success: true,
        codex: configuredCodexModels,
        codexDefault: resolveConfiguredAgentDefaultPair(defaultCodexModel, defaultCodexEffort, configuredCodexModels),
        codexQuick: resolveConfiguredAgentQuickPair(codexSettings, configuredCodexModels),
        claude: configuredClaudeModels,
        controlCapabilities: {
          // v2 reads every numbered effort row from the live TUI instead of a
          // closed name whitelist, so clients may safely expose future levels.
          codexEffortPicker: 'tui-numbered-v2',
        },
      });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  if (parsed.pathname === '/api/agent-models/resolve' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const provider = resolveAgentProvider({
        toolType: body.toolType,
        provider: body.provider,
        fallback: '',
      });
      const selection = await resolveProjectAgentModelRequest(projectManager, {
        provider,
        model: cleanOptionalString(body.model, ''),
        modelSelection: body.modelSelection,
      });
      return sendJson(res, 200, {
        success: true,
        provider,
        model: selection.model || null,
        resolution: selection.resolution,
        modelSelection: selection.modelSelection || null,
      });
    } catch (error) {
      return sendJson(res, Number(error?.statusCode) || 400, {
        success: false,
        code: error?.code || 'agent_model_selection_failed',
        error: error?.message || String(error),
        candidates: error?.candidates || undefined,
      });
    }
  }

  // Tabs of a project. (`m` is declared at the project-rename route above.)
  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tabs$/);
  if (m && req.method === 'GET') {
    const projectId = decId(m[1]);
    let project = projectManager.db.getProjectById(projectId);
    // Live fallback — проект может быть открыт в Zustand но без записи в БД
    // (новый незаsavedaftered draft). Спрашиваем renderer что у него есть.
    if (!project) {
      try {
        const live = await bridgeRequest('getProjectTabsLive', { projectId }, 1500);
        if (live?.project) {
          console.log('[WebServer] project ' + projectId.slice(0, 16) + ' served from live Zustand (not in DB)');
          const tabs = (Array.isArray(live.tabs) ? live.tabs : []).map((tab) => {
            const rawToolType = String(tab?.toolType || tab?.commandType || '').trim().toLowerCase();
            const toolType = rawToolType === 'claude' || rawToolType === 'codex'
              ? rawToolType
              : null;
            if (toolType !== 'claude' && toolType !== 'codex') return tab;
            const sessionStatus = normalizePublicRuntimeStatus(tab?.sessionStatus) || 'unknown';
            const stamped = stampPublicRuntimeSnapshot(tab.tabId, {
              ...tab,
              type: 'snapshot',
              toolType,
              commandType: toolType,
              sessionStatus,
              sessionId: toolType === 'codex'
                ? (tab.codexSessionId || null)
                : (tab.claudeSessionId || null),
              busy: sessionStatus === 'busy',
              turnBusy: tab.turnBusy ?? sessionStatus === 'busy',
            });
            const { type: _type, ...publicRuntime } = stamped;
            return { ...tab, ...publicRuntime };
          });
          return sendJson(res, 200, { ...live, tabs, ...projectCardsSnapshot(projectId, tabs) });
        }
      } catch (e) {
        // bridge failed, fall through to 404
      }
      console.log('[WebServer] 404 project not found: ' + projectId + ' (not in DB, not in live Zustand)');
      return sendJson(res, 404, { error: 'project not found', projectId });
    }
    // For PTY agent tabs (Claude/Codex, excluding SDK)
    // ask renderer for sessionStatus in a single batch — cheap because
    // renderer holds the live runtime adapters. SDK tabs have no
    // sessionStatus concept here; we keep null for them.
    let statusMap = new Map();
    let inputReadyMap = new Map();
    let lastNotReadyMap = new Map();
    let awaitingMap = new Map();
    let runtimeSessionMap = new Map();
    let runtimeReadSessionMap = new Map();
    let codexWriterConfirmedMap = new Map();
    let codexWriterUsableMap = new Map();
    let canCopySessionIdMap = new Map();
    let canResumeMap = new Map();
    let conversationMaterializedMap = new Map();
    let timelineCountMap = new Map();
    let materializationReasonMap = new Map();
    let transcriptStatusMap = new Map();
    let lifecycleGenerationMap = new Map();
    let startupFailedMap = new Map();
    let startupErrorMap = new Map();
    let startupDefaultsPendingMap = new Map();
    let startupDefaultsReadyMap = new Map();
    let startupDefaultsErrorMap = new Map();
    let completionNotificationMap = new Map();
    try {
      const data = await bridgeRequest('getProjectCompletionNotifications', { projectId }, 1500);
      if (data?.tabs && typeof data.tabs === 'object') {
        for (const [id, info] of Object.entries(data.tabs)) completionNotificationMap.set(id, info || {});
      }
    } catch (e) {
      // Runtime-only notification state lives in renderer; closed projects just
      // expose the persisted "persistent" arm flag below.
    }
    // Claude presence still lives in renderer. Codex is resolved once below
    // from main's authoritative lifecycle projection. Sending Codex through
    // this bridge batch as well made one /tabs read perform the same expensive
    // writer lookup twice per Codex tab.
    const runtimeRoutes = partitionProjectRuntimeTabs(
      project.tabs || [],
      resolveCurrentPtyAgentOwner,
    );
    const rendererPtyAgentIds = runtimeRoutes.rendererTabIds;
    if (rendererPtyAgentIds.length > 0) {
      try {
        const data = await bridgeRequest('getClaudeTabStatusBatch', { tabIds: rendererPtyAgentIds, projectId }, 1500);
        if (data?.statuses) for (const [id, st] of Object.entries(data.statuses)) statusMap.set(id, st);
        if (data?.inputReady) for (const [id, ready] of Object.entries(data.inputReady)) inputReadyMap.set(id, !!ready);
        if (data?.lastNotReady) for (const [id, value] of Object.entries(data.lastNotReady)) lastNotReadyMap.set(id, value);
        if (data?.awaiting) for (const [id, aw] of Object.entries(data.awaiting)) if (aw) awaitingMap.set(id, true);
        if (data?.sessions) for (const [id, sid] of Object.entries(data.sessions)) if (sid) runtimeSessionMap.set(id, sid);
        if (data?.readSessions) for (const [id, sid] of Object.entries(data.readSessions)) if (sid) runtimeReadSessionMap.set(id, sid);
        if (data?.codexWriterConfirmed) for (const [id, value] of Object.entries(data.codexWriterConfirmed)) codexWriterConfirmedMap.set(id, value === true);
        if (data?.codexWriterUsableForMutation) for (const [id, value] of Object.entries(data.codexWriterUsableForMutation)) codexWriterUsableMap.set(id, value === true);
        if (data?.canCopySessionId) for (const [id, value] of Object.entries(data.canCopySessionId)) canCopySessionIdMap.set(id, value === true);
        if (data?.canResume) for (const [id, value] of Object.entries(data.canResume)) canResumeMap.set(id, value === true);
        if (data?.conversationMaterialized) for (const [id, value] of Object.entries(data.conversationMaterialized)) conversationMaterializedMap.set(id, value === true);
        if (data?.timelineCount) for (const [id, value] of Object.entries(data.timelineCount)) timelineCountMap.set(id, value == null ? null : Number(value));
        if (data?.materializationReason) for (const [id, value] of Object.entries(data.materializationReason)) materializationReasonMap.set(id, value || null);
        if (data?.startupFailed) for (const [id, value] of Object.entries(data.startupFailed)) if (value) startupFailedMap.set(id, true);
        if (data?.startupError) for (const [id, value] of Object.entries(data.startupError)) if (value) startupErrorMap.set(id, value);
        if (data?.startupDefaultsPending) for (const [id, value] of Object.entries(data.startupDefaultsPending)) if (value) startupDefaultsPendingMap.set(id, true);
        if (data?.startupDefaultsReady) for (const [id, value] of Object.entries(data.startupDefaultsReady)) if (value) startupDefaultsReadyMap.set(id, true);
        if (data?.startupDefaultsError) for (const [id, value] of Object.entries(data.startupDefaultsError)) if (value) startupDefaultsErrorMap.set(id, value);
      } catch (e) {
        // Bridge unavailable — every PTY agent tab will show no badge until
        // user opens it (per-tab GET /status still works on demand).
      }
    }
    // Resolve every Codex row from one main-owned event projection batch.
    // The production callback is synchronous/O(1): no renderer bridge,
    // process scan, lsof or transcript read is allowed on this HTTP path.
    const codexRows = runtimeRoutes.mainCodexTabs;
    let codexRuntimeRows;
    if (typeof resolveCodexRuntimeProjectionBatch === 'function') {
      const batch = resolveCodexRuntimeProjectionBatch(
        codexRows.map((tab) => ({
          tabId: tab.tabId,
          savedSessionId: tab.codexSessionId || null,
        })),
        projectId,
      ) || {};
      codexRuntimeRows = codexRows.map((tab) => ({
        tab,
        runtime: batch[tab.tabId] || null,
      }));
    } else {
      // Missing projection injection is unknown, never permission to resurrect
      // the old query-driven N×ps/lsof fallback.
      codexRuntimeRows = codexRows.map((tab) => ({ tab, runtime: null }));
    }
    const codexPresentation = new Map(codexRuntimeRows.map(({ tab, runtime }) => [tab.tabId, {
      liveSettings: runtime?.liveSettings || null, model: runtime?.liveSettings?.model || null,
      effort: runtime?.liveSettings?.effort || null, runtimePolicy: runtime?.runtimePolicy || null,
      manualActionRequired: runtime?.manualActionRequired === true, manualActionType: runtime?.manualActionType || null,
    }]));
    for (const { tab: t, runtime } of codexRuntimeRows) {
      runtimeSessionMap.delete(t.tabId);
      runtimeReadSessionMap.delete(t.tabId);
      if (!runtime) {
        statusMap.set(t.tabId, 'unknown');
        inputReadyMap.set(t.tabId, false);
        codexWriterConfirmedMap.set(t.tabId, false);
        codexWriterUsableMap.set(t.tabId, false);
        canCopySessionIdMap.set(t.tabId, false);
        canResumeMap.set(t.tabId, false);
        continue;
      }
      statusMap.set(t.tabId, runtime.sessionStatus || 'unknown');
      inputReadyMap.set(t.tabId, runtime.inputReady === true);
      if (runtime.sessionId) runtimeSessionMap.set(t.tabId, runtime.sessionId);
      if (runtime.canCopySessionId === true && runtime.readSessionId) {
        runtimeReadSessionMap.set(t.tabId, runtime.readSessionId);
      }
      codexWriterConfirmedMap.set(t.tabId, runtime.writerConfirmed === true);
      codexWriterUsableMap.set(t.tabId, runtime.writerUsableForMutation === true);
      canCopySessionIdMap.set(t.tabId, runtimeReadSessionMap.has(t.tabId));
      canResumeMap.set(
        t.tabId,
        runtime.sessionStatus === 'inactive'
          && !!runtime.sessionId
          && runtime.conversationMaterialized === true,
      );
      conversationMaterializedMap.set(t.tabId, runtime.conversationMaterialized === true);
      timelineCountMap.set(t.tabId, runtime.timelineCount == null ? null : Number(runtime.timelineCount));
      materializationReasonMap.set(t.tabId, runtime.materializationReason || null);
      transcriptStatusMap.set(t.tabId, runtime.transcriptStatus || null);
      lifecycleGenerationMap.set(t.tabId, runtime.lifecycleGeneration || null);
    }
    // Configurable status-marker palette (assigned-category color + shape/size)
    // AND process-bar config (loader strip position/base/shimmer) live in renderer
    // useUIStore — fetch once so the phone mirrors both the desktop left-marker
    // and the loader strip exactly. Falls back to dot/8px + left process-bar
    // when the bridge is unavailable.
    let markerCfg = { shape: 'dot', sizePx: 8 };
    let processBarCfg = { colorA: '#155E75', shimmerColor: '#FFFFFF', shimmerSpacingPct: 50, shimmerOpacityPct: 55, position: 'left' };
    let statusesForClient = [];
    let paletteById = new Map();
    try {
      const cfg = await bridgeRequest('getStatusMarkerConfig', {}, 1500);
      if (cfg?.shape) markerCfg = { shape: cfg.shape, sizePx: cfg.sizePx || 8 };
      if (Array.isArray(cfg?.statuses)) {
        statusesForClient = cfg.statuses.map(s => ({ id: s.id, color: s.color, label: s.label }));
        for (const s of statusesForClient) paletteById.set(s.id, s);
      }
      if (cfg?.processBar) processBarCfg = cfg.processBar;
    } catch (e) {
      // renderer not ready — phone renders runtime-only markers, no category tint
    }
    const tabs = (project.tabs || []).map(t => {
      // Materialized conversation is a separate axis from "Claude wrote a UUID".
      // A pre-prompt Claude process can create a JSONL with only mode/permission
      // records; that UUID is not resumable and must not enable Copy/Resume.
      const claudeMaterialization = t.claudeSessionId
        ? claudeMaterializationFor(t.claudeSessionId, t.cwd)
        : null;
      const runtimeStatus = statusMap.get(t.tabId) || null;
      const runtimeAgentSessionId = runtimeSessionMap.get(t.tabId) || null;
      const runtimeCodexSessionId = runtimeAgentSessionId;
      const runtimeCodexReadSessionId = runtimeReadSessionMap.get(t.tabId) || null;
      const persistedOwner = resolveCurrentPtyAgentOwner(t);
      const isCodex = persistedOwner === 'codex';
      const isClaude = persistedOwner === 'claude';
      const codexWriterConfirmed = codexWriterConfirmedMap.get(t.tabId) === true;
      const codexWriterUsableForMutation = codexWriterUsableMap.get(t.tabId) === true;
      const codexHistoricalSessionId = t.codexSessionId || null;
      const codexSessionId = isCodex
        ? runtimeStatus === 'inactive'
          ? (runtimeCodexSessionId || codexHistoricalSessionId)
          : runtimeStatus && codexWriterConfirmed
            ? runtimeCodexSessionId
            : null
        : null;
      const timelineCount = isClaude && typeof claudeMaterialization?.timelineCount === 'number'
        ? claudeMaterialization.timelineCount
        : isCodex && timelineCountMap.has(t.tabId)
          ? timelineCountMap.get(t.tabId)
          : null;
      const conversationMaterialized = isClaude
        ? claudeMaterialization?.materialized === true
        : isCodex
          ? conversationMaterializedMap.get(t.tabId) === true
          : false;
      // Assigned-category status (DB column session_status holds the palette id;
      // distinct from runtime sessionStatus which drives the loader/background).
      const statusId = t.sessionStatus || null;
      const isPtyAgent = persistedOwner !== null;
      const notification = completionNotificationMap.get(t.tabId) || {};
      const row = {
        tabId: t.tabId,
        name: t.name,
        tabType: t.tabType || 'terminal',
        commandType: persistedOwner || t.commandType,
        color: t.color || null,   // desktop TabColor — drives row bg (mobile mirrors desktop)
        cwd: t.cwd,
        filePath: t.filePath || null,
        claudeSessionId: isClaude ? (runtimeAgentSessionId || t.claudeSessionId || null) : t.claudeSessionId,
        codexSessionId,
        codexReadSessionId: isCodex ? runtimeCodexReadSessionId : null,
        codexWriterConfirmed,
        codexWriterUsableForMutation,
        geminiSessionId: t.geminiSessionId,
        timelineCount,
        conversationMaterialized,
        canResume: isCodex
          ? (canResumeMap.has(t.tabId)
            ? canResumeMap.get(t.tabId)
            : runtimeStatus === 'inactive' && !!codexSessionId && conversationMaterialized)
          : isClaude && runtimeStatus === 'inactive' && conversationMaterialized,
        canCopySessionId: isCodex
          ? (canCopySessionIdMap.has(t.tabId)
            ? canCopySessionIdMap.get(t.tabId)
            : !!runtimeCodexReadSessionId)
          : isClaude
            ? conversationMaterialized
            : !!t.geminiSessionId,
        materializationReason: isClaude
          ? (claudeMaterialization?.reason || null)
          : isCodex
            ? (materializationReasonMap.get(t.tabId) || null)
            : null,
        transcriptStatus: isCodex ? (transcriptStatusMap.get(t.tabId) || null) : null,
        ...(isCodex ? codexPresentation.get(t.tabId) : {}),
        sessionStatus: runtimeStatus,
        starting: runtimeStatus === 'starting',
        stopping: runtimeStatus === 'stopping',
        inputReady: inputReadyMap.has(t.tabId) ? inputReadyMap.get(t.tabId) : null,
        lastNotReady: lastNotReadyMap.get(t.tabId) || null,
        startupFailed: startupFailedMap.get(t.tabId) || false,
        startupError: startupErrorMap.get(t.tabId) || null,
        startupDefaultsPending: isClaude ? (startupDefaultsPendingMap.get(t.tabId) || false) : false,
        startupDefaultsReady: isClaude ? (startupDefaultsReadyMap.get(t.tabId) || false) : (isPtyAgent ? true : false),
        startupDefaultsError: startupDefaultsErrorMap.get(t.tabId) || null,
        awaiting: awaitingMap.get(t.tabId) || false,
        statusId,
        statusColor: statusId ? (paletteById.get(statusId)?.color || null) : null,
        completionNotificationPersistent: notification.completionNotificationPersistent === true || t.completionNotificationPersistent === true,
        completionNotificationArmed: notification.completionNotificationArmed === true,
        completionNotificationFired: notification.completionNotificationFired === true,
        completionNotificationFiredAt: notification.completionNotificationFiredAt || null,
        groupId: t.groupId || null,
        visualParentTabId: t.visualParentTabId || null,
        // Last-known context fill % (SQLite context_pct). Seeds the native/web
        // header pill on open so it shows a value before the next live
        // bridge-update/turn, instead of being blank until the first turn.
        contextPct: (typeof t.contextPct === 'number' && isFinite(t.contextPct)) ? t.contextPct : null,
        // Live state if SDK session is active in main right now
        live: t.tabId && sdkSessions.has(t.tabId) ? {
          sessionId: sdkSessions.get(t.tabId).sessionId,
          cwd: sdkSessions.get(t.tabId).cwd,
        } : null,
      };
      if (!isPtyAgent) return row;
      const stamped = stampPublicRuntimeSnapshot(t.tabId, {
        ...row,
        type: 'snapshot',
        sessionId: isCodex
          ? (runtimeCodexSessionId || codexSessionId)
          : (runtimeAgentSessionId || t.claudeSessionId || null),
        lifecycleGeneration: isCodex
          ? (lifecycleGenerationMap.get(t.tabId) || null)
          : null,
        sessionStatus: runtimeStatus || 'unknown',
        busy: runtimeStatus === 'busy',
        turnBusy: runtimeStatus === 'busy',
      });
      const { type: _type, ...publicRuntime } = stamped;
      return { ...row, ...publicRuntime };
    });
    const groups = (project.tabGroups || []).map(g => ({
      id: g.id,
      name: g.name,
      createdAt: g.createdAt || null,
      anchorTabId: g.anchorTabId || null,
      collapsed: !!g.collapsed,
      color: g.color || null,
      sessionStatus: g.sessionStatus || null,
      statusColor: g.sessionStatus ? (paletteById.get(g.sessionStatus)?.color || null) : null,
    }));
    return sendJson(res, 200, {
      project: { id: project.id, name: project.name, path: project.path, icon: project.icon || null },
      tabs,
      groups,
      statusMarker: markerCfg,
      statuses: statusesForClient,
      processBar: processBarCfg,
      ...projectCardsSnapshot(projectId, tabs),
    });
  }

  // Create tab group in a project. Delegates to the renderer store so group
  // anchors, activeGroupId semantics, persistence, and desktop UI stay single-source.
  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-groups$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('createTabGroup', { projectId, name: body.name });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-groups\/([^/]+)\/rename$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    const groupId = decId(m[2]);
    try {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name required' });
      const data = await bridgeRequest('renameTabGroup', { projectId, groupId, name });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-groups\/([^/]+)\/toggle-collapsed$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    const groupId = decId(m[2]);
    try {
      const data = await bridgeRequest('toggleTabGroupCollapsed', { projectId, groupId });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-groups\/([^/]+)\/status$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    const groupId = decId(m[2]);
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('setTabGroupSessionStatus', { projectId, groupId, status: body.status || null });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-groups\/([^/]+)\/delete$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    const groupId = decId(m[2]);
    try {
      const data = await bridgeRequest('deleteTabGroup', { projectId, groupId });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tab-layout$/);
  if (m && req.method === 'POST') {
    const projectId = decId(m[1]);
    try {
      const body = await readBody(req);
      if (!Array.isArray(body.orderedIds)) return sendJson(res, 400, { error: 'orderedIds required' });
      const data = await bridgeRequest('applyTabLayout', {
        projectId,
        orderedIds: body.orderedIds,
        groupAssignments: body.groupAssignments || {},
        visualParentAssignments: body.visualParentAssignments || {},
        groupAnchorAssignments: body.groupAnchorAssignments || {},
      });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Durable delivery receipts for reconnect/cold-start clients. Reading this
  // endpoint never retries a send; callers match their immutable handoffId and
  // project the exact stored outcome.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/send-receipts$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    await agentSendReceiptStartupReady;
    if (!agentSendReceiptStore) {
      return sendJson(res, 503, { ok: false, error: 'agent_send_receipt_store_unavailable' });
    }
    const handoffId = cleanOptionalString(parsed.query.handoffId, '');
    const limit = Math.max(1, Math.min(500, Number(parsed.query.limit) || 100));
    const receipts = agentSendReceiptStore.list({
      tabId,
      handoffId: handoffId || undefined,
      limit,
    })
      .map(publicAgentSendReceipt);
    return sendJson(res, 200, {
      ok: true,
      tabId,
      handoffId: handoffId || null,
      receipts,
    });
  }

  // Send prompt to a project terminal tab. The scenario layer owns draft
  // preflight, busy/send-during-streaming and stopped-session readiness. Legacy
  // SDK tabs can still be routed by tab type, but the public endpoint is
  // terminal-tabs because Claude/Codex PTY is the main API surface.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/send$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    let releaseOwnedUploads = null;
    try {
      const body = await readBody(req);
      const { prompt, model, effort, thinking, cwd, handoffId, source, statusAtSend, queue, attachments } = body;
      const expectedSessionId = cleanOptionalString(body.expectedSessionId, '');
      const expectedToolType = cleanOptionalString(body.expectedToolType, '');
      if (expectedToolType && !['codex', 'claude'].includes(expectedToolType)) {
        return sendJson(res, 400, { error: 'expectedToolType must be codex or claude', submitted: false });
      }
      const expectedTarget = expectedSessionId || expectedToolType
        ? { sessionId: expectedSessionId || null, toolType: expectedToolType || null,
          ...(body.expectedBinding != null || body.ownerToken != null ? { expectedBinding: body.expectedBinding, ownerToken: body.ownerToken } : {}) }
        : null;
      if ((body.expectedBinding != null || body.ownerToken != null) && body.authoring == null) {
        return sendJson(res, 400, { error: 'expectedBinding requires structured authoring', submitted: false });
      }
      if (!prompt && body.authoring == null) return sendJson(res, 400, { error: 'prompt required' });
      const operationHandoffId = cleanOptionalString(handoffId, '')
        || 'project-send:' + crypto.randomUUID();
      const sendOperationKey = `project:${tabId}:${operationHandoffId}`;
      const uploadRequestFingerprint = fingerprintAgentSendRequest({ tabId, body });
      const previousQueuedSend = typeof agentSendQueue !== 'undefined' && agentSendQueue
        ? agentSendQueue.item(sendOperationKey) : null;
      const previousUploadSnapshot = previousQueuedSend
        ? JSON.parse(previousQueuedSend.request_json).ownedAttachments : null;
      if (previousUploadSnapshot) {
        if (previousUploadSnapshot.requestFingerprint !== uploadRequestFingerprint) {
          return sendSendFailure(res, durableAgentSendFailure({ action: 'conflict',
            mismatchedFields: ['requestFingerprint'] }, { tabId, handoffId: operationHandoffId }));
        }
        // Replays read the admitted request before path validation, linked-file
        // rereads, target reopening or import. A removed temp is not a new Send.
        const replay = publicAgentSendReceipt(agentSendReceiptStore.get(sendOperationKey));
        if (replay.submitted === false && replay.applicationQueued !== true) return sendSendFailure(res, replay);
        const pending = replay.applicationQueued === true || replay.auditPending === true || replay.deliveryUnknown === true;
        return sendJson(res, pending ? 202 : 200, { ok: true, ...replay });
      }
      const ownUploads = typeof mobileAttachmentAssetStore !== 'undefined' && mobileAttachmentAssetStore
        && typeof agentSendQueue !== 'undefined' && agentSendQueue && !previousQueuedSend;
      let structured = null;
      if (body.authoring != null) {
        validateStructuredSendEnvelope(body);
        structured = await prepareStructuredAuthoring(body.authoring, { allowUploadFiles: !!ownUploads });
      }
      const promptPresentation = structured || await resolveSendPromptPresentation(projectManager, body, prompt);
      // Structured snapshots already contain ordered image parts. Do not add
      // upload prefixes or re-resolve saved/context files over those snapshots.
      const sendPayload = structured
        ? { prompt: structured.prompt, attachments: structured.uploadAttachments || [], fileRanges: structured.uploadFileRanges || [] }
        : appendAttachmentsToPrompt(promptPresentation.prompt, attachments, { strict: !!ownUploads, includeFileRanges: !!ownUploads });
      // This request is the user's explicit authorization to reopen a closed
      // archived AI tab. Passive lifecycle/reconcile paths never call this.
      const openDescriptor = findOrchestrationTabDescriptor(tabId);
      const restorable = openDescriptor ? null : findRestorableAgentTabDescriptor(tabId);
      const targetProvider = openDescriptor?.toolType
        || (restorable?.ok === true ? restorable.toolType : null);
      if (structured?.uploadAttachments?.length && (!['codex', 'claude'].includes(targetProvider)
        || openDescriptor?.tabType === 'claude-sdk')) {
        throw sendAttachmentError('structured_upload_files_target_unsupported', 'typed uploads require a Claude/Codex terminal target', 400);
      }
      if (structured?.uploadAttachments?.length && isLocalSlashCommandPrompt(sendPayload.prompt)) {
        throw sendAttachmentError('structured_upload_files_local_command', 'standalone commands do not carry upload files', 400);
      }
      let sendPresentation = structured?.presentationSnapshot || (promptPresentation.promptChips.length > 0
        ? { promptChips: promptPresentation.promptChips } : null);
      let sendAuthoring = structured?.authoringSnapshot || null;
      let ownedAttachments = null;
      if (ownUploads && ['codex', 'claude'].includes(targetProvider)
        && openDescriptor?.tabType !== 'claude-sdk' && !isLocalSlashCommandPrompt(sendPayload.prompt)) {
        const owned = await prepareMobileSendOwnership({ tabId, handoffId: operationHandoffId,
          operationKey: sendOperationKey, requestFingerprint: uploadRequestFingerprint,
          prompt: sendPayload.prompt, attachments: sendPayload.attachments, fileRanges: sendPayload.fileRanges,
          imageRanges: sendPayload.imageRanges,
          presentationSnapshot: sendPresentation });
        if (owned) {
          ownedAttachments = owned.snapshot; releaseOwnedUploads = owned.release; sendPresentation = owned.presentationSnapshot;
          if (sendAuthoring) sendAuthoring = { ...sendAuthoring, imagePaths: sendAuthoring.imagePaths.map(ref => {
            const asset = ref.availability !== 'missing' && owned.snapshot.refs.find(value => value.kind === 'image'
              && value.sourcePath === ref.path && (!ref.assetId || value.assetId === ref.assetId));
            return asset ? { ...ref, assetId: asset.assetId, size: asset.size } : ref;
          }) };
        }
      }
      let resolvedModel = model;
      if (targetProvider) {
        const hasExplicitTargetProvider = Boolean(
          cleanOptionalString(body.toolType, '') || cleanOptionalString(body.provider, ''),
        );
        if (hasExplicitTargetProvider) {
          const requestedProvider = resolveAgentProvider({
            toolType: body.toolType,
            provider: body.provider,
            fallback: targetProvider,
          });
          if (requestedProvider !== targetProvider) {
            const mismatch = new Error(
              `Requested ${requestedProvider} cannot target an existing ${targetProvider} tab.`,
            );
            mismatch.code = 'agent_target_provider_mismatch';
            mismatch.statusCode = 400;
            throw mismatch;
          }
        }
        resolvedModel = (await resolveProjectAgentModelRequest(projectManager, {
          provider: targetProvider,
          model,
          modelSelection: body.modelSelection,
        })).model;
      }
      // Single bridge round-trip — renderer dispatches by tab.tabType/commandType.
      // Earlier this endpoint did TWO round-trips (status check + send), adding
      // ~50ms per phone send on top of the actual PTY paste latency.
      const data = await runAgentSendScenario({
        tabId, prompt: sendPayload.prompt, model: resolvedModel, effort, thinking, cwd,
        handoffId: operationHandoffId, source, statusAtSend, queue: queue === true,
        ownership: 'project',
        sendOperationKey,
        sendSurface: 'project-api',
        expectedTarget,
        provider: targetProvider,
        applicationQueueAcceptedResponse: body.applicationQueue === true,
        restoreClosedTab: true,
        ...(ownedAttachments ? { ownedAttachments } : {}),
        authoringSnapshot: sendAuthoring,
        presentationSnapshot: sendPresentation,
        // A stopped/new Claude prompt can create a new physical session. The
        // exact post-Enter audit binds that session to the receipt.
        sessionId: null,
        // Restoring a closed tab belongs to a physical send attempt. A replay
        // of an already pending/confirmed receipt must not reopen UI state.
        prepareSend: () => ensureExplicitAgentTabOpen(tabId, restorable),
      });
      const sendReceipt = classifyAgentSendReceipt(data);
      if (data?.applicationQueued === true) return sendJson(res, 202, { ok: true,
        ...data, attachments: sendPayload.attachments, contextFiles: promptPresentation.contextFiles });
      if (sendReceipt.state === 'not-submitted'
        || sendReceipt.state === AGENT_SEND_RECEIPT_STATES.PROVIDER_NOT_ACCEPTED) {
        return sendSendFailure(res, data, { tabId, handoffId: operationHandoffId });
      }
      if (sendReceipt.state === 'delivery-unknown') {
        return sendDeliveryUnknown(res, data, {
          tabId,
          handoffId: operationHandoffId,
          attachments: sendPayload.attachments,
          contextFiles: promptPresentation.contextFiles,
        });
      }
      if (isAgentSendProviderQueueAccepted(data)) {
        return sendJson(res, 200, {
          ok: true,
          success: true,
          accepted: true,
          submitted: true,
          status: 'queued',
          queued: true,
          exactAuditConfirmed: false,
          attachments: sendPayload.attachments,
          contextFiles: promptPresentation.contextFiles,
          ...(data || {}),
          handoffId: operationHandoffId,
        });
      }
      if (sendReceipt.state === 'audit-pending') {
        return sendAuditPending(res, data, {
          tabId,
          handoffId: operationHandoffId,
          attachments: sendPayload.attachments,
          contextFiles: promptPresentation.contextFiles,
        });
      }
      return sendJson(res, 200, {
        ok: true,
        success: data?.success !== false,
        status: data?.queued ? 'queued' : 'sent',
        attachments: sendPayload.attachments,
        contextFiles: promptPresentation.contextFiles,
        ...(data || {}),
        handoffId: operationHandoffId,
      });
    } catch (e) {
      return sendJson(res, Number(e?.statusCode) || 500, {
        ok: false,
        success: false,
        code: e?.code || 'send_failed',
        error: String(e.message),
        ...(e?.submitted === false ? { submitted: false, pasteWritten: false, enterWritten: false } : {}),
      });
    } finally { releaseOwnedUploads?.(); }
  }

  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/codex\/goal$/);
  if (m && (req.method === 'GET' || req.method === 'POST')) {
    let body;
    if (req.method === 'POST') {
      try { body = await readBody(req); }
      catch { return sendJson(res, 400, { ok: false, code: 'invalid-goal-action', error: 'Invalid Goal action request.' }); }
    }
    const tabId = decId(m[1]);
    const result = codexGoalActionRequest({ method: req.method, tabId, body,
      requestId: parsed.query.requestId, actions: codexGoalActions,
      descriptor: findOrchestrationTabDescriptor(tabId) });
    return sendJson(res, result.status, result.data);
  }

  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/completion-notification$/);
  if (m && (req.method === 'GET' || req.method === 'POST')) {
    let body = null;
    if (req.method === 'POST') {
      try { body = await readBody(req); }
      catch { return sendJson(res, 400, { ok: false, success: false,
        error: 'completion_notification_request_invalid', mutationOutcome: 'not-started' }); }
    }
    try {
      const result = await completionNotificationRequest({ method: req.method, tabId: decId(m[1]),
        body,
        db: require('./project-manager').db, bridge: bridgeRequest });
      return sendJson(res, result.status, result.data);
    } catch (error) {
      return sendJson(res, 500, { ok: false, success: false, error: 'completion_notification_unavailable',
        mutationOutcome: req.method === 'POST' ? 'unknown' : 'not-started' });
    }
  }

  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/completion-notification\/clear$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const data = await bridgeRequest('clearTabCompletionNotification', { tabId, keepPersistent: true }, 1500);
      return sendJson(res, 200, { ok: true, success: true, ...(data || {}) });
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  // Legacy Claude-only alias. Keep it on the same native-safe path as
  // /agent-tabs: API clients may never mount the desktop Terminal component,
  // so pendingAction alone is not enough to start the CLI.
  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/claude-tabs$/);
  if (m && req.method === 'POST') {
    try {
      const data = await bridgeRequest('createAgentTab', {
        projectId: decId(m[1]),
        toolType: 'claude',
        startNow: true,
      }, 12_000);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  // Create PTY agent tab in a project. Body: { toolType: 'claude' | 'codex' }.
  // Native/API clients do not necessarily mount the desktop Terminal component,
  // so the bridge starts the agent immediately after the PTY is created.
  if (parsed.pathname === '/api/inbox/agent-tabs' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const toolType = resolveAgentProvider({
        toolType: body.toolType,
        provider: body.provider,
        fallback: 'claude',
      });
      assertAgentProviderModel({
        provider: toolType,
        model: cleanOptionalString(body.model || body.codexModel, ''),
      });
      await bridgeRequest('ensureInboxProject', {}, 5000);
      const data = await bridgeRequest('createAgentTab', { projectId: INBOX_PROJECT_ID, toolType, startNow: true }, 12_000);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  if (parsed.pathname === '/api/inbox/runs' && req.method === 'POST') {
    let inboxRun = null;
    try {
      await agentSendReceiptStartupReady;
      const body = await readBody(req);
      const provider = body.provider === 'codex' ? 'codex' : null;
      if (!provider) return sendJson(res, 400, { error: 'provider must be codex' });
      let prompt = cleanOptionalString(body.prompt ?? body.text);
      let normalizedAttachments, sendPayload, structured = null;
      try {
        if (body.authoring != null) {
          validateStructuredSendEnvelope({ ...body, expectedToolType: body.expectedToolType || provider });
          if (!cleanOptionalString(body.runId, '') || !cleanOptionalString(body.conversationKey, '')
            || body.expectedToolType && body.expectedToolType !== provider
            || body.resumeSessionId && body.resumeSessionId !== body.expectedSessionId) {
            throw Object.assign(new Error('Inbox authoring requires runId/conversationKey and one exact session target'), { code: 'structured_authoring_invalid', statusCode: 400 });
          }
          structured = await prepareStructuredAuthoring(body.authoring);
          prompt = structured.prompt;
          normalizedAttachments = [];
          sendPayload = { prompt, attachments: [], contextFiles: [] };
        } else {
          normalizedAttachments = normalizeSendAttachments(body.attachments, { strict: true });
          sendPayload = await resolveInboxAttachmentPrompt(prompt, normalizedAttachments);
        }
      } catch (error) {
        // Preparation precedes both run reservation and tab creation. Report
        // that fact explicitly so Voice returns the same draft + attachments.
        return sendSendFailure(res, {
          submitted: false,
          pasteWritten: false,
          enterWritten: false,
          code: error?.code || 'attachment_preparation_failed',
          error: String(error?.message || error),
          statusCode: Number(error?.statusCode) || 400,
        }, { attachments: Array.isArray(body.attachments) ? body.attachments : [] });
      }
      if (!prompt && normalizedAttachments.length === 0) {
        return sendJson(res, 400, { error: 'prompt or attachment required' });
      }
      let presentationSnapshot = structured?.presentationSnapshot || inboxAttachmentPresentationSnapshot(
        body.presentationSnapshot,
        normalizedAttachments,
      );
      const runId = body.runId && String(body.runId).trim() ? String(body.runId).trim() : crypto.randomUUID();
      const source = cleanOptionalString(body.source, 'external-api');
      const conversationKey = cleanOptionalString(body.conversationKey || body.chatId, '');
      const autoStopMs = clampAutoStopMs(body.autoStopMs);
      const autoCloseMs = clampAutoCloseMs(body.autoCloseMs);
      const startupTimeoutMs = Math.max(5_000, Math.min(120_000, Number(body.startupTimeoutMs) || 20_000));
      const developerInstructions = cleanOptionalString(body.developerInstructions || body.systemPrompt, '');
      const requestedModel = cleanOptionalString(body.model, '');
      const requestedEffort = cleanOptionalString(body.effort, '');
      const requestedResumeSessionId = cleanOptionalString(structured ? body.expectedSessionId : body.resumeSessionId, '');
      const expectedAuthoringTarget = structured ? { toolType: provider, sessionId: requestedResumeSessionId } : null;
      assertAgentProviderModel({ provider, model: requestedModel });
      const requestFingerprint = fingerprintAgentSendRequest({
        provider,
        prompt,
        source,
        conversationKey: conversationKey || null,
        developerInstructions: developerInstructions || null,
        model: requestedModel || null,
        effort: requestedEffort || null,
        resumeSessionId: requestedResumeSessionId || null,
        queue: body.queue === true,
        name: cleanOptionalString(body.name, '') || null,
        autoStopMs,
        autoCloseMs,
        startupTimeoutMs,
        collapsed: body.collapsed === true,
        attachments: normalizedAttachments,
        contextFiles: sendPayload.contextFiles,
        presentationSnapshot,
        ...(structured ? { authoring: structured.authoringSnapshot, expectedTarget: expectedAuthoringTarget } : {}),
      });
      const sendOperationKey = `inbox:${runId}`;
      const previousConversationRunId = conversationKey
        ? externalRunByConversationKey.get(conversationKey)
        : null;
      const previousConversationTabId = previousConversationRunId
        ? externalRuns.get(previousConversationRunId)?.tabId || null
        : null;
      const inboxReservedTabId = previousConversationTabId
        || reservedInboxTabId(runId, conversationKey);
      inboxSavedHistoryOperations?.assertAvailable(inboxReservedTabId);
      prompt = sendPayload.prompt;
      if (tabWorkContext && prompt) {
        prompt = (await tabWorkContext.prepare(inboxReservedTabId, 'external-run:' + runId, prompt)).prompt;
      }
      const durableInboxIdentity = agentSendReceiptStore ? {
        operationKey: sendOperationKey,
        surface: 'inbox',
        runId,
        tabId: inboxReservedTabId,
        handoffId: 'external-run:' + runId,
        requestFingerprint,
        provider,
        sessionId: null,
        promptHash: promptAuditFingerprint(prompt),
        promptLength: prompt.length,
      } : null;
      const durableInboxReservation = durableInboxIdentity
        ? agentSendReceiptStore.reserveOrGet(durableInboxIdentity)
        : null;
      if (durableInboxReservation && !durableInboxReservation.ok) {
        if (durableInboxReservation.action === 'conflict') {
          return sendJson(res, 409, {
            ok: false,
            success: false,
            submitted: false,
            code: 'external_run_identity_conflict',
            error: 'The same runId was already used for a different Inbox request.',
            runId,
            tabId: durableInboxReservation.record?.tabId || inboxReservedTabId,
            mismatchedFields: durableInboxReservation.mismatchedFields || [],
          });
        }
        return sendJson(res, 503, {
          ok: false,
          success: false,
          submitted: false,
          code: durableInboxReservation.code || 'agent_send_receipt_store_capacity',
          error: 'Inbox send could not reserve a durable receipt before creating a tab.',
          runId,
          tabId: inboxReservedTabId,
        });
      }
      const startedAt = Date.now();
      const autoStopAt = autoStopMs > 0 ? null : null;
      const autoCloseAt = null;
      let existingRun = externalRuns.get(runId) || null;
      if (!existingRun && durableInboxReservation?.action === 'replay'
        && (durableInboxReservation.retryable !== true || !inboxSetupRetryable(durableInboxReservation.record))) {
        const record = durableInboxReservation.record;
        existingRun = {
          runId,
          provider,
          source,
          handoffId: 'external-run:' + runId,
          promptAuditHash: record.promptHash,
          requestFingerprint,
          conversationKey: conversationKey || undefined,
          status: externalRunStatusFromDurableRecord(record),
          startedAt: record.createdAt || startedAt,
          autoStopAt: null,
          autoStopMs,
          autoCloseAt: null,
          autoCloseMs,
          collapsed: body.collapsed === true,
          reservedTabId: record.tabId || inboxReservedTabId,
          tabId: record.tabId || inboxReservedTabId,
          sessionId: record.sessionId || null,
          resumeSessionId: requestedResumeSessionId || null,
          stopTimer: null,
          closeTimer: null,
          lastSendReceipt: durableAgentSendReplay(record, {
            operationKey: sendOperationKey,
            attemptId: record.attemptId || null,
          }),
          auditConfirmedAt: record.receipt?.exactAuditConfirmed === true || record.auditIdentity
            ? record.settledAt || Date.now()
            : null,
          auditSessionId: record.auditIdentity?.sessionId || null,
          auditEntryUuid: record.auditIdentity?.entryUuid || null,
          auditSourceIdentity: record.auditIdentity?.sourceIdentity || null,
        };
        externalRuns.set(runId, existingRun);
        externalRunByTabId.set(existingRun.tabId, runId);
        if (conversationKey) externalRunByConversationKey.set(conversationKey, runId);
        return replayExternalRunResponse(res, existingRun);
      }
      if (existingRun) {
        if (existingRun.requestFingerprint !== requestFingerprint) {
          return sendJson(res, 409, {
            ok: false,
            success: false,
            submitted: false,
            code: 'external_run_identity_conflict',
            error: 'The same runId was already used for a different Inbox request.',
            runId,
            tabId: existingRun.tabId || null,
          });
        }
        // The reservation/status transition happens synchronously before the
        // first await. Treat it as the per-run retry lease: a concurrent
        // identical request observes the same operation instead of entering a
        // second setup/create/send attempt after an earlier retryable failure.
        if (['reserving', 'starting', 'sending'].includes(existingRun.status)) {
          return replayExternalRunResponse(res, existingRun);
        }
        const retryablePreSubmit = durableInboxReservation
          ? inboxSetupRetryable(durableInboxReservation.record)
          : existingRun.lastSendReceipt?.submitted === false;
        if (!retryablePreSubmit) return replayExternalRunResponse(res, existingRun);
        inboxRun = existingRun;
        clearExternalRunTimer(inboxRun, 'stopTimer');
        clearExternalRunTimer(inboxRun, 'closeTimer');
        inboxRun.status = 'starting';
        inboxRun.error = null;
        inboxRun.errorCode = null;
        inboxRun.reservedTabId ||= inboxReservedTabId;
      } else {
        inboxRun = {
          runId,
          provider,
          source,
          handoffId: 'external-run:' + runId,
          promptAuditHash: promptAuditFingerprint(prompt),
          requestFingerprint,
          conversationKey: conversationKey || undefined,
          status: 'reserving',
          startedAt,
          autoStopAt,
          autoStopMs,
          autoCloseAt,
          autoCloseMs,
          collapsed: body.collapsed === true,
          reservedTabId: inboxReservedTabId,
          tabId: null,
          sessionId: null,
          resumeSessionId: requestedResumeSessionId || null,
          stopTimer: null,
          closeTimer: null,
          lastSendReceipt: null,
        };
        // Reserve before any asynchronous tab creation. A concurrent retry of
        // the same runId now observes this exact operation instead of creating
        // another tab and another physical send.
        externalRuns.set(runId, inboxRun);
      }
      if (durableInboxReservation?.record?.state === 'reserved') {
        agentSendReceiptStore.markPreparing(sendOperationKey);
      }
      if (agentSendReceiptStore) {
        const previousSetup = agentSendReceiptStore.get(sendOperationKey)?.inboxSetup;
        inboxRun.setupExecutionId ||= previousSetup?.executionId || crypto.randomUUID();
        if (!previousSetup) {
          const setup = agentSendReceiptStore.recordInboxSetup(sendOperationKey, requestFingerprint, {
            ...inboxRun, executionId: inboxRun.setupExecutionId,
          });
          if (!setup.ok) throw Object.assign(new Error('Inbox setup could not bind its durable owner'), {
            code: 'external_run_setup_owner_changed',
          });
        }
      }
      await bridgeRequest('ensureInboxProject', {}, 5000);
      assertInboxSetupOwner(inboxRun);
      let tabId = inboxRun.tabId || null;
      let sessionId = inboxRun.sessionId || null;
      let reused = !!tabId;
      let launchAdmission = null;
      let targetCreated = false;
      if (!tabId && inboxRun.reservedTabId) {
        const reservedDescriptor = findOrchestrationTabDescriptor(inboxRun.reservedTabId);
        if (reservedDescriptor?.toolType === provider) {
          tabId = inboxRun.reservedTabId;
          sessionId = reservedDescriptor.sessionId || null;
          reused = true;
        }
      }
      if (!tabId && conversationKey && externalRunByConversationKey.has(conversationKey)) {
        const prevRunId = externalRunByConversationKey.get(conversationKey);
        const prevRun = externalRuns.get(prevRunId);
        if (prevRun?.tabId && prevRun.tabId === inboxRun.reservedTabId) {
          try {
            clearExternalRunTimer(prevRun, 'stopTimer');
            clearExternalRunTimer(prevRun, 'closeTimer');
            const prevStatus = await bridgeRequest('getClaudeTabStatus', { tabId: prevRun.tabId }, 2000);
            if (prevStatus?.toolType === 'codex') {
              tabId = prevRun.tabId;
              // A null current ID is intentional while a live resume is
              // resolving its writer. Never fill it with the previous run's
              // historical identity.
              sessionId = codexSessionIdFromAuthoritativeStatus(prevStatus);
              reused = true;
            }
          } catch {}
        }
      }
      const requestedTabName = cleanOptionalString(body.name, '');
      const tabName = requestedTabName
        || (conversationKey ? `Codex · ${conversationKey.slice(-8)}` : `Codex · ${source}`);
      inboxRun.status = 'starting';
      if (tabId) {
        if (expectedAuthoringTarget) {
          const current = await readAgentReadyStatus(tabId);
          const failure = agentSendTargetPreconditionFailure(expectedAuthoringTarget, current?.sendTarget || {
            toolType: current?.toolType || provider,
            sessionId: codexSessionIdFromAuthoritativeStatus(current) || findOrchestrationTabDescriptor(tabId)?.sessionId,
          });
          if (failure) throw Object.assign(new Error(failure.error), failure, { statusCode: 409 });
        }
        const preparation = await prepareReusedInboxTab({
          tabId,
          provider,
          readStatus: readAgentReadyStatus,
          resume: (id) => bridgeRequest('resumeClaudeTab', { tabId: id }, 12_000),
          clearTimers: (id) => {
            for (const previous of externalRuns.values()) {
              if (previous.tabId !== id) continue;
              previous.cleanupCancelled = true;
              clearExternalRunTimer(previous, 'stopTimer');
              clearExternalRunTimer(previous, 'closeTimer');
            }
          },
        });
        launchAdmission = preparation.admission;
        assertInboxSetupOwner(inboxRun);
        if (agentSendReceiptStore && !agentSendReceiptStore.get(sendOperationKey)?.inboxSetup?.creationResult) {
          const committed = agentSendReceiptStore.updateInboxSetup(sendOperationKey, inboxRun.setupExecutionId, {
            creationState: 'created', creationResult: { tabId, projectId: INBOX_PROJECT_ID, toolType: provider, reused: true },
          });
          if (!committed.ok) throw Object.assign(new Error('Inbox reuse receipt owner changed'), { code: 'external_run_setup_owner_changed' });
        }
        console.log('[InboxReuse] tab=' + tabId + ' status=' + preparation.status?.status
          + ' resumed=' + preparation.resumed);
      }
      if (!tabId) {
        const previousSetup = agentSendReceiptStore?.get(sendOperationKey)?.inboxSetup;
        if (previousSetup?.creationState === 'created' || previousSetup?.creationState === 'refused') {
          throw Object.assign(new Error('The original Inbox creation is already settled; use its exact receipt'), {
            code: 'external_run_creation_already_settled',
          });
        }
        const creationRequestId = crypto.randomBytes(8).toString('hex');
        const tab = await bridgeRequest('createAgentTab', {
          projectId: INBOX_PROJECT_ID,
          toolType: provider,
          name: tabName,
          // The fallback only prevents an id-shaped blank tab while Codex
          // starts. It must not suppress the same first-prompt auto-naming used
          // by ordinary/forked tabs. A real caller-supplied name stays manual.
          nameSetManually: !!requestedTabName,
          startNow: true,
          externalRun: inboxRun,
          codexDeveloperInstructions: developerInstructions || undefined,
          codexModel: requestedModel,
          codexEffort: requestedEffort,
          resumeSessionId: requestedResumeSessionId || undefined,
          reservedTabId: inboxRun.reservedTabId,
        }, 8000, {
          requestId: creationRequestId,
          observationOnly: true,
          onDispatch: () => {
            assertInboxSetupOwner(inboxRun);
            if (!agentSendReceiptStore) return;
            const bound = agentSendReceiptStore.updateInboxSetup(sendOperationKey, inboxRun.setupExecutionId, {
              creationRequestId, dispatched: true,
            });
            if (!bound.ok) throw Object.assign(new Error('Inbox creation request owner changed'), { code: 'external_run_setup_owner_changed' });
          },
          captureReply: ({ requestId, ok, data }) => {
            assertInboxSetupOwner(inboxRun);
            if (requestId !== creationRequestId || ok && (data?.tabId !== inboxRun.reservedTabId
              || data?.projectId !== INBOX_PROJECT_ID || data?.toolType !== provider)) {
              throw Object.assign(new Error('Inbox creation result did not match its exact reserved owner'), {
                code: 'bridge_owned_result_unknown',
              });
            }
            if (!agentSendReceiptStore) return;
            const committed = agentSendReceiptStore.updateInboxSetup(sendOperationKey, inboxRun.setupExecutionId, {
              creationState: ok ? 'created' : 'refused', creationRequestId,
              ...(ok ? { creationResult: data } : {}),
            });
            if (!committed.ok) throw Object.assign(new Error('Inbox creation result could not commit'), { code: 'bridge_owned_result_unknown' });
          },
          onAbort: error => {
            agentSendReceiptStore?.updateInboxSetup(sendOperationKey, inboxRun.setupExecutionId, {
              creationState: error.dispatched === false ? 'refused' : 'unknown', errorCode: error.code,
            });
          },
          onObservationExpired: () => {
            assertInboxSetupOwner(inboxRun);
            agentSendReceiptStore?.updateInboxSetup(sendOperationKey, inboxRun.setupExecutionId, { observedExpired: true });
            replayExternalRunResponse(res, inboxRun);
          },
        });
        assertInboxSetupOwner(inboxRun);
        tabId = tab?.tabId;
        launchAdmission = tab;
        if (!tabId) {
          const createError = new Error('failed to create tab');
          createError.code = 'external_tab_create_failed';
          throw createError;
        }
        targetCreated = true;
      }
      const run = inboxRun;
      const persistedOpenedAt = Number(
        findOrchestrationTabDescriptor(tabId)?.externalRun?.openedInTerminalAt || 0,
      );
      Object.assign(run, {
        tabId,
        sessionId,
        reused,
        status: 'starting',
        ...(persistedOpenedAt > 0 ? { openedInTerminalAt: persistedOpenedAt } : {}),
      });
      externalRunByTabId.set(tabId, runId);
      if (conversationKey) externalRunByConversationKey.set(conversationKey, runId);
      setExternalRunMeta(tabId, { ...run, stopTimer: undefined, closeTimer: undefined });
      let status = null;
      try {
        status = await waitForAgentReady(tabId, startupTimeoutMs, launchAdmission || {});
      } catch (e) {
        settleInboxSetupBeforeSend(run, e);
        if (e?.code === 'codex_auth_required') {
          run.status = 'auth_required';
          run.errorCode = 'codex_auth_required';
          run.error = 'codex_auth_required';
          run.lastSendReceipt = {
            success: false,
            submitted: false,
            code: 'codex_auth_required',
            error: 'codex_auth_required',
          };
          setExternalRunMeta(tabId, { status: 'auth_required', error: 'codex_auth_required' });
          return sendJson(res, 409, { ok: false, runId, tabId, error: 'codex_auth_required', status: e.status || null });
        }
        if (e?.code === 'agent_startup_defaults_failed') {
          run.status = 'start_failed';
          run.errorCode = e.code;
          run.error = String(e.message || e);
          run.lastSendReceipt = {
            success: false,
            submitted: false,
            code: e.code,
            error: run.error,
          };
          setExternalRunMeta(tabId, { status: 'start_failed', error: String(e.message || e) });
          return sendJson(res, 409, {
            ok: false,
            runId,
            tabId,
            error: e.code,
            detail: String(e.message || e),
            status: e.status || null,
          });
        }
        run.status = 'start_timeout';
        run.errorCode = 'agent_start_timeout';
        run.error = String(e.message || e);
        run.lastSendReceipt = {
          success: false,
          submitted: false,
          code: run.errorCode,
          error: run.error,
        };
        setExternalRunMeta(tabId, { status: 'start_timeout', error: String(e.message || e) });
        return sendJson(res, 504, { ok: false, runId, tabId, error: 'agent did not become ready', status: e.status || null });
      }
      sessionId = codexSessionIdFromAuthoritativeStatus(status);
      assertInboxSetupOwner(run);
      run.status = 'sending';
      run.sessionId = sessionId;
      setExternalRunMeta(tabId, { status: 'sending', sessionId, autoStopAt: null, autoCloseAt: null });
      const sendOptions = resolveOrchestrationSendOptions({
        targetCreated,
        targetToolType: provider,
        baselineStatus: status?.status || 'active',
        queueRequested: body.queue === true,
        model: requestedModel || undefined,
        effort: requestedEffort || undefined,
      });
      const sendResult = await runAgentSendScenario({
        tabId,
        prompt,
        model: sendOptions.model,
        effort: sendOptions.effort,
        handoffId: run.handoffId,
        source: 'external:' + source,
        statusAtSend: status?.status || 'active',
        queue: sendOptions.queue,
        ownership: 'external',
        provider,
        sessionId,
        sendOperationKey,
        sendSurface: 'inbox',
        sendRunId: runId,
        sendRequestFingerprint: requestFingerprint,
        prepareSend: async () => { assertInboxSetupOwner(run); },
        presentationSnapshot,
        ...(structured ? { authoringSnapshot: structured.authoringSnapshot,
          expectedTarget: expectedAuthoringTarget, authoringSourcePrompt: sendPayload.prompt, workContextPrepared: true } : {}),
        timeoutMs: 60_000,
      });
      run.lastSendReceipt = sendResult;
      const exactSendAudit = sendResult?.codexAudit || sendResult?.pasteAudit || null;
      if (exactSendAudit?.success === true && exactSendAudit?.entryUuid) {
        run.auditConfirmedAt ||= Date.now();
        run.auditSessionId = exactSendAudit.sessionId || sessionId;
        run.auditEntryUuid = exactSendAudit.entryUuid;
        run.auditSourceIdentity = exactSendAudit.sourceIdentity || null;
      }
      const sendReceipt = classifyAgentSendReceipt(sendResult);
      if (sendReceipt.state === 'not-submitted'
        || sendReceipt.state === AGENT_SEND_RECEIPT_STATES.PROVIDER_NOT_ACCEPTED) {
        const failureCode = sendResult?.code || 'send_failed';
        run.status = failureCode === 'terminal_draft_conflict' ? 'draft_conflict' : 'send_failed';
        run.errorCode = failureCode;
        run.error = sendResult.error || 'send failed';
        setExternalRunMeta(tabId, { status: run.status, error: sendResult.error || 'send failed' });
        return sendSendFailure(res, sendResult, {
          runId,
          tabId,
          sessionId,
          attachments: sendPayload.attachments,
        });
      }
      if (sendReceipt.state === 'delivery-unknown') {
        run.status = 'delivery_unknown';
        run.errorCode = null;
        run.error = null;
        run.auditPendingAt = null;
        run.deliveryUnknownAt = Date.now();
        setExternalRunMeta(tabId, {
          status: 'delivery_unknown',
          sessionId,
          handoffId: run.handoffId,
          deliveryUnknownAt: run.deliveryUnknownAt,
          autoStopAt: null,
          autoCloseAt: null,
        });
        return sendDeliveryUnknown(res, sendResult, {
          runId,
          provider,
          tabId,
          sessionId,
          source,
          handoffId: run.handoffId,
          conversationKey: conversationKey || null,
          eventsUrl: '/api/events?tabId=' + encodeURIComponent(tabId),
          resultUrl: '/api/inbox/runs/' + encodeURIComponent(runId) + '/result',
          stopUrl: '/api/inbox/runs/' + encodeURIComponent(runId) + '/stop',
          autoStopMs,
          autoCloseMs,
          reused,
          attachments: sendPayload.attachments,
        });
      }
      if (isAgentSendProviderQueueAccepted(sendResult)) {
        if (!run.completionStamp) run.status = 'running';
        run.errorCode = null;
        run.error = null;
        run.auditPendingAt = null;
        setExternalRunMeta(tabId, {
          status: 'running',
          sessionId,
          handoffId: run.handoffId,
          autoStopAt: null,
          autoCloseAt: null,
        });
        return sendJson(res, 200, {
          ok: true,
          success: true,
          accepted: true,
          submitted: true,
          queued: true,
          status: 'queued',
          exactAuditConfirmed: false,
          runId,
          provider,
          tabId,
          sessionId,
          source,
          handoffId: run.handoffId,
          conversationKey: conversationKey || null,
          eventsUrl: '/api/events?tabId=' + encodeURIComponent(tabId),
          resultUrl: '/api/inbox/runs/' + encodeURIComponent(runId) + '/result',
          stopUrl: '/api/inbox/runs/' + encodeURIComponent(runId) + '/stop',
          autoStopMs,
          autoCloseMs,
          reused,
          attachments: sendPayload.attachments,
        });
      }
      if (sendReceipt.state === 'audit-pending') {
        if (run.auditConfirmedAt) {
          if (!run.completionStamp) run.status = 'running';
          return sendJson(res, 200, {
            ok: true,
            success: true,
            accepted: true,
            submitted: true,
            status: 'sent',
            exactAuditConfirmed: true,
            runId,
            provider,
            tabId,
            sessionId: run.auditSessionId || sessionId,
            source,
            handoffId: run.handoffId,
            conversationKey: conversationKey || null,
            eventsUrl: '/api/events?tabId=' + encodeURIComponent(tabId),
            resultUrl: '/api/inbox/runs/' + encodeURIComponent(runId) + '/result',
            stopUrl: '/api/inbox/runs/' + encodeURIComponent(runId) + '/stop',
            autoStopMs,
            autoCloseMs,
            reused,
            attachments: sendPayload.attachments,
          });
        }
        run.status = 'audit_pending';
        run.errorCode = null;
        run.error = null;
        run.auditPendingAt = Date.now();
        setExternalRunMeta(tabId, {
          status: 'audit_pending',
          sessionId,
          handoffId: run.handoffId,
          autoStopAt: null,
          autoCloseAt: null,
        });
        return sendAuditPending(res, sendResult, {
          runId,
          provider,
          tabId,
          sessionId,
          source,
          handoffId: run.handoffId,
          conversationKey: conversationKey || null,
          eventsUrl: '/api/events?tabId=' + encodeURIComponent(tabId),
          resultUrl: '/api/inbox/runs/' + encodeURIComponent(runId) + '/result',
          stopUrl: '/api/inbox/runs/' + encodeURIComponent(runId) + '/stop',
          autoStopMs,
          autoCloseMs,
          reused,
          attachments: sendPayload.attachments,
        });
      }
      if (!run.completionStamp) run.status = 'running';
      run.errorCode = null;
      run.error = null;
      setExternalRunMeta(tabId, { status: run.status, sessionId, autoStopAt: run.autoStopAt, autoStopMs, autoCloseAt: run.autoCloseAt, autoCloseMs });
      return sendJson(res, 200, {
        ok: true,
        success: true,
        status: sendResult?.queued ? 'queued' : 'sent',
        runId,
        provider,
        tabId,
        sessionId,
        source,
        handoffId: run.handoffId,
        conversationKey: conversationKey || null,
        eventsUrl: '/api/events?tabId=' + encodeURIComponent(tabId),
        resultUrl: '/api/inbox/runs/' + encodeURIComponent(runId) + '/result',
        stopUrl: '/api/inbox/runs/' + encodeURIComponent(runId) + '/stop',
        autoStopMs,
        autoCloseMs,
        reused,
        attachments: sendPayload.attachments,
      });
    } catch (e) {
      if (inboxRun && ['reserving', 'starting'].includes(inboxRun.status)) {
        try { settleInboxSetupBeforeSend(inboxRun, e); } catch {}
        inboxRun.status = 'setup_failed';
        inboxRun.errorCode = e?.code || 'external_run_setup_failed';
        inboxRun.error = String(e.message || e);
        inboxRun.lastSendReceipt = {
          success: false,
          submitted: false,
          code: inboxRun.errorCode,
          error: inboxRun.error,
        };
        if (agentSendReceiptStore) return replayExternalRunResponse(res, inboxRun);
      }
      return sendTerminalBridgeError(res, e);
    }
  }

  if (parsed.pathname === '/api/inbox/sessions/resume' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const conversationKey = cleanOptionalString(body.conversationKey, '');
      const resumeSessionId = cleanOptionalString(body.sessionId || body.resumeSessionId, '');
      if (!conversationKey || !resumeSessionId) {
        return sendJson(res, 400, {
          ok: false,
          success: false,
          error: 'conversationKey + sessionId required',
        });
      }
      await bridgeRequest('ensureInboxProject', {}, 5000);
      const reservedTabId = reservedInboxTabId('resume', conversationKey);
      const descriptor = findOrchestrationTabDescriptor(reservedTabId);
      let tabId = descriptor?.toolType === 'codex' ? reservedTabId : null;
      let launchAdmission = null;
      if (tabId) {
        const current = await bridgeRequest('getClaudeTabStatus', { tabId }, 2500);
        launchAdmission = current;
        if (current?.status === 'inactive') {
          launchAdmission = await bridgeRequest('resumeClaudeTab', { tabId }, 12_000);
        }
      } else {
        const created = await bridgeRequest('createAgentTab', {
          projectId: INBOX_PROJECT_ID,
          toolType: 'codex',
          name: cleanOptionalString(body.name, '') || `Codex · ${conversationKey.slice(-8)}`,
          startNow: true,
          resumeSessionId,
          reservedTabId,
        }, 12_000);
        tabId = created?.tabId || null;
        launchAdmission = created;
      }
      if (!tabId) throw new Error('failed to restore Inbox Codex tab');
      const ready = await waitForAgentReady(tabId, Math.max(5_000, Math.min(120_000, Number(body.startupTimeoutMs) || 30_000)), launchAdmission || {});
      return sendJson(res, 200, {
        ok: true,
        success: true,
        provider: 'codex',
        conversationKey,
        tabId,
        sessionId: codexSessionIdFromAuthoritativeStatus(ready) || resumeSessionId,
        status: ready?.status || 'active',
        inputReady: ready?.inputReady === true,
      });
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  m = parsed.pathname.match(/^\/api\/inbox\/runs\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const runId = decId(m[1]);
    const run = externalRuns.get(runId) || readDurableInboxRun(runId);
    if (!run) {
      return sendJson(res, 404, {
        ok: false,
        success: false,
        code: 'external_run_not_found',
        error: 'Inbox run is no longer live',
        runId,
      });
    }
    return replayExternalRunResponse(res, run);
  }

  m = parsed.pathname.match(/^\/api\/inbox\/runs\/([^/]+)\/result$/);
  if (m && req.method === 'GET') {
    const runId = decId(m[1]);
    try {
      const result = await getInboxResultResponse(runId);
      return sendJson(res, result.statusCode, result.body);
    } catch (error) {
      return sendJson(res, 503, { ok: false, runId, code: 'inbox_result_read_failed', error: String(error?.message || error) });
    }
  }

  // Additive saved-history ingress. The legacy native route below is unchanged.
  m = parsed.pathname.match(/^\/api\/inbox\/runs\/([^/]+)\/history-operations(?:\/([^/]+))?$/);
  if (m && (req.method === 'POST' || req.method === 'GET')) {
    try {
      if (!inboxSavedHistoryOperations) return sendJson(res, 503, { ok: false, error: 'saved_history_unavailable' });
      await agentSendReceiptStartupReady;
      const runId = decId(m[1]);
      const result = req.method === 'POST' && !m[2]
        ? await inboxSavedHistoryOperations.accept(runId, await readBody(req))
        : req.method === 'GET' && m[2] ? inboxSavedHistoryOperations.read(runId, decId(m[2])) : null;
      if (!result) return sendJson(res, 404, { ok: false, error: 'history_operation_not_found' });
      const operation = result.operation;
      return sendJson(res, operation.pending ? 202 : operation.success ? 200 : 409, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, error.statusCode || 409, { ok: false, code: error.code || error.message, error: error.message });
    }
  }

  m = parsed.pathname.match(/^\/api\/inbox\/runs\/([^/]+)\/rewind$/);
  if (m && req.method === 'POST') {
    const runId = decId(m[1]);
    let run = externalRuns.get(runId) || null;
    try {
      const body = await readBody(req);
      let targetEntryUuid = cleanOptionalString(body.targetEntryUuid || body.entryUuid, '');
      const targetSourceIdentity = cleanOptionalString(body.sourceIdentity || body.targetSourceIdentity, '');
      if (!targetEntryUuid && !targetSourceIdentity) {
        return sendJson(res, 400, { ok: false, success: false, error: 'Exact target identity required' });
      }
      if (!run) {
        const durableRecord = agentSendReceiptStore
          ? agentSendReceiptStore.list({ surface: 'inbox', runId })[0] || null
          : null;
        const conversationKey = cleanOptionalString(body.conversationKey, '');
        const durableEntryUuid = cleanOptionalString(durableRecord?.auditIdentity?.entryUuid, '');
        const durableSourceIdentity = cleanOptionalString(durableRecord?.auditIdentity?.sourceIdentity, '');
        const durableSessionId = cleanOptionalString(durableRecord?.auditIdentity?.sessionId || durableRecord?.sessionId, '');
        const resumeSessionId = durableSessionId || cleanOptionalString(body.sessionId || body.resumeSessionId, '');
        if (!conversationKey || !resumeSessionId || !durableRecord || durableRecord.state !== 'confirmed') {
          return sendJson(res, 409, {
            ok: false,
            success: false,
            code: 'external_run_rewind_target_unavailable',
            error: 'The closed Inbox run needs a confirmed durable receipt before history Rewind.',
            runId,
          });
        }
        if ((!durableEntryUuid && !durableSourceIdentity)
          || durableRecord.provider !== 'codex'
          || durableRecord.tabId !== reservedInboxTabId(runId, conversationKey)
          || (targetSourceIdentity && durableSourceIdentity && targetSourceIdentity !== durableSourceIdentity)
          || (targetEntryUuid && durableEntryUuid && durableEntryUuid !== targetEntryUuid)) {
          return sendJson(res, 409, {
            ok: false,
            success: false,
            code: 'external_run_rewind_identity_mismatch',
            error: 'The requested message does not match the durable Inbox audit identity.',
            runId,
            targetEntryUuid,
            auditedEntryUuid: durableEntryUuid || null,
          });
        }
        await bridgeRequest('ensureInboxProject', {}, 5000);
        const reservedTabId = reservedInboxTabId(runId, conversationKey);
        let descriptor = findOrchestrationTabDescriptor(reservedTabId);
        if (!descriptor) {
          const archived = findRestorableAgentTabDescriptor(reservedTabId);
          if (archived?.ok) descriptor = (await ensureExplicitAgentTabOpen(reservedTabId, archived)).descriptor;
        }
        let restoredTabId = descriptor?.toolType === 'codex' ? reservedTabId : null;
        if (!restoredTabId) {
          const created = await bridgeRequest('createAgentTab', {
            projectId: INBOX_PROJECT_ID,
            toolType: 'codex',
            name: cleanOptionalString(body.name, '') || `Codex · ${conversationKey.slice(-8)}`,
            startNow: false,
            resumePolicy: 'never',
            background: true,
            resumeSessionId,
            reservedTabId,
          }, 12_000);
          restoredTabId = created?.tabId || null;
        }
        if (!restoredTabId) throw new Error('failed to restore Inbox tab before Rewind');
        run = {
          runId,
          provider: 'codex',
          source: 'external-rewind-restore',
          handoffId: 'external-run:' + runId,
          conversationKey,
          status: 'active',
          startedAt: Date.now(),
          autoStopMs: clampAutoStopMs(body.autoStopMs),
          autoCloseMs: clampAutoCloseMs(body.autoCloseMs),
          tabId: restoredTabId,
          reservedTabId,
          sessionId: descriptor?.sessionId || resumeSessionId,
          auditSessionId: resumeSessionId,
          auditEntryUuid: durableEntryUuid,
          auditSourceIdentity: durableRecord.auditIdentity?.sourceIdentity || null,
          stopTimer: null,
          closeTimer: null,
          lastSendReceipt: null,
        };
        externalRuns.set(runId, run);
        externalRunByTabId.set(run.tabId, runId);
        externalRunByConversationKey.set(conversationKey, runId);
      }
      if (!run?.tabId || !run?.sessionId) {
        return sendJson(res, 409, {
          ok: false,
          success: false,
          code: 'external_run_rewind_target_unavailable',
          error: 'The Inbox Codex history binding is unavailable.',
          runId,
        });
      }
      if (body.conversationKey && run.conversationKey !== body.conversationKey) {
        return sendJson(res, 409, {
          ok: false,
          success: false,
          code: 'external_run_rewind_identity_mismatch',
          error: 'The requested chat does not own this Inbox run.',
          runId,
          targetEntryUuid,
          auditedEntryUuid: run.auditEntryUuid || null,
        });
      }
      const sessionInfo = await resolveHistorySessionInfo(run.tabId, 5000);
      if (!transcriptService || sessionInfo?.toolType !== 'codex' || !sessionInfo?.sessionId) {
        return sendJson(res, 409, { ok: false, code: 'external_run_rewind_target_unavailable', error: 'Codex history is not available yet' });
      }
      const timeline = await transcriptService.getTimeline({ tabId: run.tabId, toolType: 'codex', sessionId: sessionInfo.sessionId, cwd: sessionInfo.cwd });
      if (!timeline?.success) throw new Error(timeline?.error || 'Cannot read current Codex history');
      const resolved = resolveInboxRewindTarget(timeline.entries, {
        entryUuid: run.auditEntryUuid, sourceIdentity: run.auditSourceIdentity,
      }, { entryUuid: targetEntryUuid, sourceIdentity: targetSourceIdentity });
      if (!resolved.ok) return sendJson(res, 409, { ok: false, code: resolved.code,
        error: 'Не удалось однозначно найти сообщение в текущей истории Codex; история не изменена' });
      const target = resolved.entry;
      targetEntryUuid = target.uuid;
      clearExternalRunTimer(run, 'stopTimer');
      clearExternalRunTimer(run, 'closeTimer');
      run.status = 'rewinding';
      setExternalRunMeta(run.tabId, { status: 'rewinding', rewindTargetUuid: targetEntryUuid });
      const nativeRewind = body.mode === 'native';
      const rewindUsers = timeline.entries.filter((entry) => !entry.serviceCarrier
        && (entry.type === 'user' || entry.role === 'user' || entry.kind === 'user'));
      const result = await bridgeRequest(nativeRewind ? 'rewindAgentTimelineScenario' : 'rewindAgentHistoryScenario', {
        tabId: run.tabId,
        targetUuid: targetEntryUuid,
        targetIndex: rewindUsers.findIndex((entry) => entry.uuid === targetEntryUuid),
        rewindableCount: rewindUsers.length,
        startUuid: targetEntryUuid,
        targetText: target.fullText || target.text || target.content || '',
        targetFullText: target.fullText || target.text || target.content || '',
        targetSourceIdentity: target.sourceIdentity,
        targetEntryRef: target.entryRef,
        expectedContentRevision: target.contentRevision || timeline.contentRevision,
        mode: 'native',
        restoreDraft: false,
      }, 180_000);
      if (result?.success === false) {
        run.status = 'rewind_failed';
        run.error = result.error || 'Inbox history Rewind failed';
        setExternalRunMeta(run.tabId, { status: 'rewind_failed', rewindError: run.error });
        return sendJson(res, 409, { ok: false, runId, tabId: run.tabId, ...result });
      }
      const nextSessionId = cleanOptionalString(result?.activeSessionId || result?.newSessionId || result?.sessionId, '') || run.sessionId;
      const previewOnly = nativeRewind && result?.handoffStatus === 'branch-draft-restored';
      for (const candidate of [...externalRuns.values()]) {
        if (candidate.runId === run.runId) continue;
        if (candidate.conversationKey !== run.conversationKey) continue;
        if (Number(candidate.startedAt || 0) <= Number(run.startedAt || 0)) continue;
        cleanupExternalRun(candidate);
      }
      run.sessionId = nextSessionId;
      run.auditSessionId = nextSessionId;
      run.status = 'done';
      // This object now describes a completed history operation, not another
      // completion of its old audited send. In particular a prepared native
      // branch must not inherit cleanup from a historical result reread.
      run.completionStamp = (previewOnly ? 'native-preview:' : 'history-rewind:')
        + String(result?.handoffGeneration || nextSessionId);
      run.error = null;
      run.errorCode = null;
      externalRunByTabId.set(run.tabId, run.runId);
      if (run.conversationKey) externalRunByConversationKey.set(run.conversationKey, run.runId);
      setExternalRunMeta(run.tabId, {
        status: 'done',
        sessionId: nextSessionId,
        rewindTargetUuid: targetEntryUuid,
        rewindCompletedAt: Date.now(),
      });
      // Native backtrack can prepare a branch that only becomes durable at the
      // next submit. Automatic process teardown would cancel that branch.
      if (!previewOnly) scheduleExternalRunCompletionTimers(run, 'history-rewind');
      return sendJson(res, 200, {
        ...result,
        ok: true,
        success: true,
        runId,
        tabId: run.tabId,
        sessionId: nextSessionId,
        targetEntryUuid,
        previewOnly,
        nativeRewind: nativeRewind ? {
          status: previewOnly ? 'pending' : 'committed',
          generation: result.handoffGeneration,
          sourceIdentity: target.sourceIdentity,
          targetUuid: targetEntryUuid,
        } : null,
      });
    } catch (e) {
      if (run) {
        run.status = 'rewind_failed';
        run.error = String(e?.message || e);
        if (run.tabId) setExternalRunMeta(run.tabId, { status: 'rewind_failed', rewindError: run.error });
      }
      return sendTerminalBridgeError(res, e);
    }
  }

  m = parsed.pathname.match(/^\/api\/inbox\/runs\/([^/]+)\/stop$/);
  if (m && req.method === 'POST') {
    const runId = decId(m[1]);
    const run = externalRuns.get(runId);
    if (!run?.tabId) return sendJson(res, 404, { error: 'run not found' });
    const prevStatus = run.status;
    // An unproven stop must fully restore the pre-attempt state: the status
    // AND the auto-stop safety timer this handler cleared before trying.
    // Otherwise a refused stop leaves the run alive with its token-burn
    // guard silently disarmed. Only re-arm what actually existed — mid-turn
    // runs have no stop timer yet (it arms on turn-done), and inventing one
    // here would auto-kill the agent mid-answer.
    const hadStopTimer = !!run.stopTimer;
    const revertToPreStop = () => {
      run.status = prevStatus;
      setExternalRunMeta(run.tabId, { status: prevStatus, autoStopAt: null });
      if (hadStopTimer) scheduleExternalRunStop(run, 'rearm-after-stop-unconfirmed');
    };
    try {
      clearExternalRunTimer(run, 'stopTimer');
      run.status = 'stopping';
      setExternalRunMeta(run.tabId, { status: 'stopping', autoStopAt: null });
      const data = await runAgentStopScenario(run.tabId, 5000);
      // The run may only be marked stopped on a proven stop. A structured
      // refusal / lookupUnknown keeps the process alive — marking the run
      // stopped and scheduling auto-close would close a tab whose agent is
      // still running (same contract as /stop's classify above).
      const stopProven = data?.success === true || data?.stopped === true;
      if (!stopProven) {
        revertToPreStop();
        return sendJson(res, 409, {
          ok: false,
          runId,
          tabId: run.tabId,
          stopped: false,
          error: data?.error || 'agent_stop_unconfirmed',
          ...data,
        });
      }
      run.status = 'stopped';
      run.stoppedAt = Date.now();
      setExternalRunMeta(run.tabId, { status: 'stopped', stoppedAt: run.stoppedAt, autoStopAt: null, stopReason: 'api' });
      scheduleExternalRunClose(run, 'api-stop');
      return sendJson(res, 200, { ok: true, runId, tabId: run.tabId, stopped: true, ...data });
    } catch (e) {
      // Bridge timeout / renderer gone: the stop is unproven, same contract
      // as the structured refusal — do not leave the run in 'stopping'
      // forever with no safety timer.
      revertToPreStop();
      return sendJson(res, 500, { ok: false, runId, stopped: false, error: String(e.message || e) });
    }
  }

  m = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/agent-tabs$/);
  if (m && req.method === 'POST') {
    const started = Date.now();
    const projectId = decId(m[1]);
    try {
      const body = await readBody(req);
      const toolType = resolveAgentProvider({
        toolType: body.toolType,
        provider: body.provider,
        fallback: 'claude',
      });
      const requestedModel = (await resolveProjectAgentModelRequest(projectManager, {
        provider: toolType,
        model: cleanOptionalString(body.model || body.codexModel, ''),
        modelSelection: body.modelSelection,
      })).model;
      const placement = resolveNewAgentTabPlacement({
        placement: body.placement,
        parentTabId: cleanOptionalString(body.parentTabId, ''),
        targetProjectId: projectId,
      });
      if (placement.visualParentTabId) {
        const parent = findOrchestrationTabDescriptor(placement.visualParentTabId);
        if (!parent) return sendJson(res, 404, { ok: false, error: 'parent tab not found' });
        if (parent.projectId !== projectId) {
          return sendJson(res, 409, {
            ok: false,
            error: 'parent tab must belong to the target project',
          });
        }
      }
      console.log('[WebAgentTabs] START project=' + shortId(projectId, 12)
        + ' tool=' + toolType
        + ' model=' + (requestedModel || '-')
        + ' effort=' + (cleanOptionalString(body.effort || body.codexEffort, '') || '-'));
      const data = await bridgeRequest('createAgentTab', {
        projectId,
        cwd: cleanOptionalString(body.cwd, '') || undefined,
        sourceTabId: cleanOptionalString(body.sourceTabId, '') || undefined,
        windowTarget: body.windowTarget && typeof body.windowTarget === 'object'
          ? body.windowTarget
          : undefined,
        toolType,
        startNow: true,
        name: cleanOptionalString(body.name, ''),
        codexModel: requestedModel,
        codexEffort: cleanOptionalString(body.effort || body.codexEffort, ''),
        visualParentTabId: placement.visualParentTabId,
        afterTabId: placement.afterTabId,
        background: body.background !== false,
      }, 12_000);
      console.log('[WebAgentTabs] OK project=' + shortId(projectId, 12)
        + ' tool=' + toolType
        + ' tab=' + shortId(data?.tabId, 12)
        + ' status=' + (data?.sessionStatus || (data?.starting ? 'starting' : '-'))
        + ' session=' + shortId(data?.claudeSessionId || data?.codexSessionId || data?.sessionId)
        + ' materialized=' + (data?.conversationMaterialized === true)
        + ' canResume=' + (data?.canResume === true)
        + ' canCopy=' + (data?.canCopySessionId === true)
        + ' defaultsPending=' + (data?.startupDefaultsPending === true)
        + ' defaultsReady=' + (data?.startupDefaultsReady === true)
        + ' ms=' + (Date.now() - started));
      return sendJson(res, 200, data);
    } catch (e) {
      console.warn('[WebAgentTabs] ERR project=' + shortId(projectId, 12)
        + ' error=' + String(e?.message || e)
        + ' ms=' + (Date.now() - started));
      return sendTerminalBridgeError(res, e);
    }
  }

  if (parsed.pathname === '/api/terminal-tabs' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('createTerminalTab', {
        projectId: cleanOptionalString(body.projectId, '') || undefined,
        fallbackProjectId: cleanOptionalString(body.fallbackProjectId, '') || undefined,
        cwd: cleanOptionalString(body.cwd, '') || undefined,
        sourceTabId: cleanOptionalString(body.sourceTabId, '') || undefined,
        windowTarget: body.windowTarget && typeof body.windowTarget === 'object'
          ? body.windowTarget
          : undefined,
        name: cleanOptionalString(body.name, '') || undefined,
        command: cleanOptionalString(body.command, '') || undefined,
        color: cleanOptionalString(body.color, '') || undefined,
        background: body.background !== false,
      }, 20_000);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  if (parsed.pathname === '/api/agent-tabs' && req.method === 'POST') {
    const started = Date.now();
    try {
      const body = await readBody(req);
      const toolType = resolveAgentProvider({
        toolType: body.toolType,
        provider: body.provider,
        fallback: 'claude',
      });
      const requestedModel = (await resolveProjectAgentModelRequest(projectManager, {
        provider: toolType,
        model: cleanOptionalString(body.model || body.codexModel, ''),
        modelSelection: body.modelSelection,
      })).model;
      const data = await bridgeRequest('createAgentTab', {
        projectId: cleanOptionalString(body.projectId, '') || undefined,
        fallbackProjectId: cleanOptionalString(body.fallbackProjectId, '') || undefined,
        cwd: cleanOptionalString(body.cwd, '') || undefined,
        sourceTabId: cleanOptionalString(body.sourceTabId, '') || undefined,
        windowTarget: body.windowTarget && typeof body.windowTarget === 'object'
          ? body.windowTarget
          : undefined,
        toolType,
        startNow: true,
        name: cleanOptionalString(body.name, ''),
        codexModel: requestedModel,
        codexEffort: cleanOptionalString(body.effort || body.codexEffort, ''),
        placement: cleanOptionalString(body.placement, '') || 'child',
        visualParentTabId: cleanOptionalString(body.parentTabId, '') || undefined,
        background: body.background !== false,
      }, 60_000);
      console.log('[WebAgentTabs] contextual OK project=' + shortId(data?.projectId, 12)
        + ' tool=' + toolType
        + ' tab=' + shortId(data?.tabId, 12)
        + ' space=' + shortId(data?.placement?.spaceId, 12)
        + ' ms=' + (Date.now() - started));
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      console.warn('[WebAgentTabs] contextual ERR error=' + String(e?.message || e)
        + ' ms=' + (Date.now() - started));
      return sendTerminalBridgeError(res, e);
    }
  }

  // Форк вкладки: копия разговора в новой вкладке, рядом с исходной.
  //
  // Отличается от /overseer/fork, который правит только файл истории: здесь
  // появляется живая вкладка с агентом, продолжающим копию.
  //
  // Реализация НЕ своя: тот же `forkAgentTab`, которым уже пользуется
  // оркестрация (materializeReservedOrchestrationTarget). Он несёт то, что
  // отдельная копия растеряла бы: отказ форкать занятую вкладку, проверку что
  // разговор вообще сохранён, запись родословной форка и закрытие вкладки,
  // если запуск не приняли. Таймаут тот же 60с — форк от последнего сжатия
  // сначала материализует файл истории.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/fork$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('forkAgentTab', {
        sourceTabId: tabId,
        name: cleanOptionalString(body.name, '') || undefined,
        background: body.background !== false,
        windowTarget: body.windowTarget && typeof body.windowTarget === 'object'
          ? body.windowTarget
          : undefined,
        // По умолчанию — от последнего сжатия контекста, как в оркестрации и в
        // меню вкладки: полная история дороже и нужна редко.
        fromLatestCompact: body.fullHistory !== true && body.fromLatestCompact !== false,
      }, 60_000);
      console.log('[WebTabFork] OK source=' + shortId(tabId, 12)
        + ' fork=' + shortId(data?.tabId, 12)
        + ' provider=' + (data?.toolType || data?.provider || '-'));
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      console.warn('[WebTabFork] ERR source=' + shortId(tabId, 12)
        + ' error=' + String(e?.message || e));
      return sendTerminalBridgeError(res, e);
    }
  }

  // ── Рабочая область: что на экране и как это переставить ────────────────
  //
  // The workspace had no API at all: a caller could create tabs but not say
  // WHERE they should appear, so «сделай форк и открой обе справа» was not
  // expressible. Two endpoints, because they are two different questions —
  // reading the arrangement and stating a new one.
  if (parsed.pathname === '/api/workspace' && req.method === 'GET') {
    try {
      const data = await bridgeRequest('describeWorkspaceLayout', {
        sourceTabId: cleanOptionalString(parsed.query.sourceTabId, '') || undefined,
      }, 5_000);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  if (parsed.pathname === '/api/workspace/windows' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('commitWorkspaceWindowAction', {
        sourceTabId: cleanOptionalString(body.sourceTabId, '') || undefined,
        windowTarget: {
          ...(body.windowTarget && typeof body.windowTarget === 'object' ? body.windowTarget : {}),
          mode: 'new-window',
          side: cleanOptionalString(body.side, '') || body.windowTarget?.side || 'right',
        },
        createEmptyWindow: true,
        focus: body.focus === true,
        reveal: body.reveal === true,
      }, 8_000);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  if (parsed.pathname === '/api/workspace/place-tabs' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const entries = Array.isArray(body.entries)
        ? body.entries
        : (Array.isArray(body.tabIds) ? body.tabIds.map((tabId) => ({ tabId })) : []);
      const normalized = entries.map((entry) => {
        if (typeof entry === 'string') {
          const descriptor = findOrchestrationTabDescriptor(entry);
          return descriptor ? { projectId: descriptor.projectId, tabId: entry } : { projectId: '', tabId: entry };
        }
        if (entry?.projectId) return entry;
        const descriptor = findOrchestrationTabDescriptor(entry?.tabId);
        return descriptor
          ? { projectId: descriptor.projectId, tabId: entry.tabId }
          : { projectId: '', tabId: entry?.tabId || '' };
      }).filter((entry) => entry.projectId && entry.tabId);
      if (normalized.length === 0) return sendJson(res, 400, { ok: false, error: 'tabs required' });
      const data = await bridgeRequest('commitWorkspaceWindowAction', {
        sourceTabId: cleanOptionalString(body.sourceTabId, '') || undefined,
        windowTarget: body.windowTarget && typeof body.windowTarget === 'object'
          ? body.windowTarget
          : {},
        entries: normalized,
        show: body.show === true,
        focus: body.focus === true,
        reveal: body.reveal === true,
        moveExisting: body.moveExisting !== false,
      }, 8_000);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  // Repair workflow layouts without touching project tabs or processes. The
  // caller must first read `/api/workspace` and echo its fingerprint: recovery
  // then fails closed if the user rearranged anything between inspection and
  // commit. Every candidate tab is validated by the live renderer before the
  // repaired session is written synchronously.
  if (parsed.pathname === '/api/workspace/spaces/recover' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
      if (candidates.length === 0) {
        return sendJson(res, 400, { ok: false, error: 'candidates required' });
      }
      if (candidates.length > 20) {
        return sendJson(res, 400, { ok: false, error: 'too many candidates' });
      }
      const data = await bridgeRequest('recoverWorkspaceSpaces', {
        candidates,
        overwriteExistingIds: Array.isArray(body?.overwriteExistingIds)
          ? body.overwriteExistingIds
          : [],
        expectedFingerprint: cleanOptionalString(body?.expectedFingerprint, '') || undefined,
        reassignProjects: body?.reassignProjects === true,
        dryRun: body?.dryRun === true,
      }, 10_000);
      console.log('[WebWorkspace] recovery dryRun=' + (body?.dryRun === true)
        + ' added=' + (data?.addedIds || []).join(',')
        + ' replaced=' + (data?.replacedIds || []).join(',')
        + ' missingTabs=' + (data?.missingTabs || []).length);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  // Bounded history of replaced workspace snapshots. Values stay internal;
  // the API returns only enough structure to identify a useful revision. A
  // selected revision is then merged by the live renderer, which validates
  // every tab before committing — writing the DB row behind a live renderer
  // would only let its next debounce overwrite the restore again.
  if (parsed.pathname === '/api/workspace/revisions' && req.method === 'GET') {
    try {
      const requested = Number(parsed.query.limit);
      const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.floor(requested))) : 20;
      const revisions = projectManager.db.listAppStateRevisions('workspace-session', { limit })
        .map((revision) => {
          let snapshot = null;
          try { snapshot = JSON.parse(revision.value); } catch {}
          const spaces = Array.isArray(snapshot?.spaces) && snapshot.spaces.length > 0
            ? snapshot.spaces
            : (snapshot ? [{ id: 'space-1', name: 'main', layout: snapshot }] : []);
          return {
            id: revision.id,
            reason: revision.reason,
            source: revision.source,
            createdAt: revision.createdAt,
            activeSpaceId: snapshot?.activeSpaceId || spaces[0]?.id || null,
            projectCount: Array.isArray(snapshot?.openProjects) ? snapshot.openProjects.length : 0,
            spaces: spaces.map((space) => {
              const panes = Array.isArray(space?.layout?.splitPanes) ? space.layout.splitPanes : [];
              const tabIds = new Set();
              panes.forEach((pane) => {
                if (pane?.tabId) tabIds.add(pane.tabId);
                (Array.isArray(pane?.tabs) ? pane.tabs : []).forEach((entry) => {
                  if (entry?.tabId) tabIds.add(entry.tabId);
                });
              });
              return {
                id: space?.id || null,
                name: space?.name || 'main',
                paneCount: panes.length,
                tabCount: tabIds.size,
                projectIds: Array.isArray(space?.projectIds) ? space.projectIds : [],
              };
            }),
          };
        });
      return sendJson(res, 200, { ok: true, revisions });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  m = parsed.pathname.match(/^\/api\/workspace\/revisions\/(\d+)\/recover$/);
  if (m && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('recoverWorkspaceSessionRevision', {
        revisionId: Number(m[1]),
        overwriteExistingIds: Array.isArray(body?.overwriteExistingIds)
          ? body.overwriteExistingIds
          : [],
        expectedFingerprint: cleanOptionalString(body?.expectedFingerprint, '') || undefined,
        reassignProjects: body?.reassignProjects === true,
        dryRun: body?.dryRun === true,
      }, 10_000);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  // ONE call applies the whole arrangement. Composing it from single-window
  // gestures would be several requests that can each half-fail, and the desktop
  // guard "one empty window at a time" refuses the second one anyway.
  if (parsed.pathname === '/api/workspace/arrange' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      // Nesting carries the distinction, so no extra flag: [[a],[b]] means two
      // windows side by side, [[a,b]] means one window with two tabs.
      const windows = Array.isArray(body.windows) ? body.windows : [];
      if (windows.length === 0) {
        return sendJson(res, 400, { ok: false, error: 'windows required' });
      }
      const normalized = windows.map((strip) => (Array.isArray(strip) ? strip : [strip])
        .map((entry) => {
          if (typeof entry === 'string') {
            const descriptor = findOrchestrationTabDescriptor(entry);
            return descriptor
              ? { projectId: descriptor.projectId, tabId: entry }
              : { projectId: '', tabId: entry };
          }
          return {
            projectId: cleanOptionalString(entry?.projectId, ''),
            tabId: cleanOptionalString(entry?.tabId, ''),
          };
        })
        .filter((entry) => entry.tabId));
      console.log('[WebWorkspace] arrange windows=' + normalized.length
        + ' tabs=' + normalized.flat().length
        + ' side=' + (body.side || 'right')
        + ' divide=' + (body.divide || 'columns'));
      const data = await bridgeRequest('arrangeWorkspaceLayout', {
        side: cleanOptionalString(body.side, '') || undefined,
        divide: cleanOptionalString(body.divide, '') || undefined,
        anchorIndex: Number.isInteger(body.anchorIndex) ? body.anchorIndex : undefined,
        sourceTabId: cleanOptionalString(body.sourceTabId, '') || undefined,
        windowTarget: body.windowTarget && typeof body.windowTarget === 'object'
          ? body.windowTarget
          : undefined,
        show: body.show !== false,
        focus: body.focus !== false,
        reveal: body.reveal === true,
        windows: normalized,
      }, 8_000);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendTerminalBridgeError(res, e);
    }
  }

  // Start a fresh agent runtime in an existing PTY tab. This is intentionally
  // separate from /resume: an unmaterialized Claude tab has no saved
  // conversation to resume, but it still needs a way to launch Claude again.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/start$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const startupTimeoutMs = Math.max(1000, Math.min(60_000, Number(body.startupTimeoutMs) || 60_000));
      let beforeStatus = null;
      try {
        beforeStatus = await bridgeRequest('getClaudeTabStatus', { tabId }, 1500);
      } catch (statusErr) {
        console.warn('[MobStart] preflight status failed tab=' + shortId(tabId, 12)
          + ' error=' + String(statusErr?.message || statusErr));
      }
      console.log('[MobStart] request tab=' + shortId(tabId, 12)
        + ' status=' + (beforeStatus?.status || '-')
        + ' tool=' + (beforeStatus?.toolType || beforeStatus?.commandType || '-')
        + ' session=' + shortId(beforeStatus?.sessionId || beforeStatus?.codexSessionId || beforeStatus?.claudeSessionId)
        + ' materialized=' + (beforeStatus?.conversationMaterialized === true)
        + ' canResume=' + (beforeStatus?.canResume === true)
        + ' bodyAction=start');
      const beforeToolType = beforeStatus?.toolType || beforeStatus?.commandType || null;
      const beforeSessionId = beforeStatus?.sessionId
        || beforeStatus?.codexSessionId
        || beforeStatus?.claudeSessionId
        || null;
      if ((beforeToolType === 'codex' || beforeToolType === 'claude')
        && beforeStatus?.canResume === true
        && beforeSessionId) {
        return sendJson(res, 409, {
          ok: false,
          success: false,
          ready: false,
          error: 'tab_has_resumable_session',
          reason: 'start_blocked_by_resumable_session',
          tabId,
          toolType: beforeToolType,
          commandType: beforeToolType,
          sessionId: beforeSessionId,
          ...(beforeToolType === 'codex' ? { codexSessionId: beforeSessionId } : { claudeSessionId: beforeSessionId }),
          status: beforeStatus.status || 'inactive',
          conversationMaterialized: true,
          canResume: true,
          canCopySessionId: true,
          timelineCount: beforeStatus.timelineCount ?? null,
          materializationReason: beforeStatus.materializationReason
            || (beforeToolType === 'codex' ? 'codex-session-bound' : 'timeline-has-entries'),
        });
      }
      let data;
      try {
        data = await bridgeRequest('startAgentTab', { tabId }, Math.max(5000, Math.min(15_000, startupTimeoutMs)));
      } catch (bridgeErr) {
        return sendJson(res, 409, {
          ok: false,
          success: false,
          ready: false,
          error: String(bridgeErr.message || bridgeErr),
        });
      }
      if (data?.success === false || data?.ok === false) {
        return sendJson(res, 409, { ...(data || {}), ok: false, success: false, ready: false });
      }
      try {
        const status = await waitForAgentReady(tabId, startupTimeoutMs, data || {});
        const startedTool = data?.toolType || status?.toolType || status?.commandType || data?.commandType;
        const needsStartupDefaults = startedTool === 'claude';
        const defaultsReady = needsStartupDefaults
          ? status?.startupDefaultsReady === true
          : true;
        const defaultsError = status?.startupDefaultsError || null;
        let liveStatus = status;
        try {
          liveStatus = await readFreshReadyRuntimeStatus(tabId, 'start-after-defaults', data || {});
        } catch (freshErr) {
          console.warn('[MobStart] fresh runtime proof failed tab=' + shortId(tabId, 12)
            + ' error=' + String(freshErr?.message || freshErr)
            + ' status=' + (freshErr?.status?.status || '-'));
          return sendJson(res, freshErr?.statusCode || 503, {
            ...(data || {}),
            ok: false,
            success: false,
            ready: false,
            error: freshErr?.code || 'runtime_snapshot_unavailable',
            detail: String(freshErr?.message || freshErr),
            status: freshErr?.status?.status || null,
            inputReady: freshErr?.status?.inputReady === true,
            startupDefaultsReady: defaultsReady,
            startupDefaultsError: defaultsError,
          });
        }
        const coherent = await coherentPublicRuntimeSnapshot(tabId, {
          ok: true,
          success: true,
          ready: true,
          ...(data || {}),
          startupDefaultsReady: defaultsReady,
          startupDefaultsError: defaultsError,
          status: liveStatus?.status || 'active',
          starting: liveStatus?.status === 'starting',
          stopping: liveStatus?.status === 'stopping',
          inputReady: liveStatus?.inputReady === true,
          conversationMaterialized: false,
          canResume: false,
          canCopySessionId: false,
          timelineCount: 0,
          materializationReason: 'timeline-empty',
        }, data || {});
        return sendJson(res, 200, coherent);
      } catch (readyErr) {
        return sendJson(res, Number(readyErr?.statusCode) || 504, {
          ...(data || {}),
          ok: false,
          success: false,
          ready: false,
          error: String(readyErr.message || readyErr),
          code: readyErr?.code || 'agent_ready_failed',
          status: readyErr.status || null,
        });
      }
    } catch (e) {
      return sendJson(res, 500, { ok: false, success: false, ready: false, error: String(e.message) });
    }
  }

  // Resume inactive Claude session (PTY tab whose `claude` process exited).
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/resume$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const startupTimeoutMs = Math.max(1000, Math.min(60_000, Number(body.startupTimeoutMs) || 60_000));
      let data;
      try {
        data = await bridgeRequest('resumeClaudeTab', { tabId }, Math.max(5000, Math.min(15_000, startupTimeoutMs)));
      } catch (bridgeErr) {
        return sendJson(res, 409, {
          ok: false,
          success: false,
          ready: false,
          error: String(bridgeErr.message || bridgeErr),
        });
      }
      if (data?.success === false || data?.ok === false) {
        return sendJson(res, 409, { ...(data || {}), ok: false, success: false, ready: false });
      }
      try {
        const status = await waitForAgentReady(tabId, startupTimeoutMs, data || {});
        const defaultsReady = status?.startupDefaultsReady === true;
        const defaultsError = status?.startupDefaultsError || null;
        let liveStatus = status;
        try {
          liveStatus = await readFreshReadyRuntimeStatus(tabId, 'resume-after-defaults', data || {});
        } catch (freshErr) {
          console.warn('[MobResume] fresh runtime proof failed tab=' + shortId(tabId, 12)
            + ' error=' + String(freshErr?.message || freshErr)
            + ' status=' + (freshErr?.status?.status || '-'));
          return sendJson(res, freshErr?.statusCode || 503, {
            ...(data || {}),
            ok: false,
            success: false,
            ready: false,
            error: freshErr?.code || 'runtime_snapshot_unavailable',
            detail: String(freshErr?.message || freshErr),
            status: freshErr?.status?.status || null,
            inputReady: freshErr?.status?.inputReady === true,
            startupDefaultsReady: defaultsReady,
            startupDefaultsError: defaultsError,
          });
        }
        const coherent = await coherentPublicRuntimeSnapshot(tabId, {
          ok: true,
          success: true,
          ready: true,
          ...(data || {}),
          startupDefaultsReady: defaultsReady,
          startupDefaultsError: defaultsError,
          status: liveStatus?.status || 'active',
          starting: liveStatus?.status === 'starting',
          stopping: liveStatus?.status === 'stopping',
          inputReady: liveStatus?.inputReady === true,
        }, data || {});
        return sendJson(res, 200, coherent);
      } catch (readyErr) {
        return sendJson(res, Number(readyErr?.statusCode) || 504, {
          ...(data || {}),
          ok: false,
          success: false,
          ready: false,
          error: String(readyErr.message || readyErr),
          code: readyErr?.code || 'agent_ready_failed',
          status: readyErr.status || null,
        });
      }
    } catch (e) {
      return sendJson(res, 500, { ok: false, success: false, ready: false, error: String(e.message) });
    }
  }

  // Status snapshot for a PTY+Claude tab: active | busy | inactive.
  // Mobile polls this on chat-open to decide Resume-banner visibility.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/status$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const started = Date.now();
    const statusPrefix = '[WebStatus] tab=' + shortId(tabId, 12);
    const clearPending = startRoutePendingLog(statusPrefix, started);
    console.log(statusPrefix + ' START');
    try {
      const resolved = await resolveAgentSessionInfo(tabId, 2500);
      const data = await coherentPublicRuntimeSnapshot(tabId, resolved || {});
      clearPending();
      console.log(statusPrefix +
        ' status=' + (data?.status || '-') +
        ' busy=' + (data?.busy == null ? '-' : data.busy) +
        ' session=' + shortId(data?.sessionId) +
        ' materialized=' + (data?.conversationMaterialized === true) +
        ' timelineCount=' + (data?.timelineCount == null ? '-' : data.timelineCount) +
        ' canResume=' + (data?.canResume === true) +
        ' defaultsPending=' + (data?.startupDefaultsPending === true) +
        ' defaultsReady=' + (data?.startupDefaultsReady === true) +
        ' defaultsError=' + (data?.startupDefaultsError || '-') +
        ' command=' + (data?.commandType || '-') +
        ' tool=' + (data?.toolType || '-') +
        ' ms=' + (Date.now() - started));
      return sendJson(res, 200, data);
    } catch (e) {
      clearPending();
      console.warn(statusPrefix + ' error=' + String(e.message || e) + ' ms=' + (Date.now() - started));
      return sendJson(res, Number(e.statusCode) || 500, { error: e.code || String(e.message), runtimeStateUnknown: e.runtimeStateUnknown === true });
    }
  }

  // Truncate history (drop everything ≥ targetUuid). Used by mobile Edit/Repeat
  // — bridges to the renderer which then invokes the same `claude-sdk:truncate-history`
  // ipcMain handler the desktop UI uses. After 200 OK the caller sends the new
  // prompt via /send (with original or edited text) and Claude resumes off the
  // truncated tip.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/truncate$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const targetUuid = (body.targetUuid || '').trim();
      if (!targetUuid) return sendJson(res, 400, { error: 'targetUuid required' });
      const data = await bridgeRequest('truncateHistory', { tabId, targetUuid });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Middle history compact-edit for Claude JSONL / Codex rollout. This is NOT
  // native `/rewind`: it calls the same core edit-range implementation as
  // desktop Timeline. It does not run Gemini or stop/restart a live agent.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/edit-range$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const started = Date.now();
    const prefix = '[WebEditRange] tab=' + shortId(tabId, 12);
    const clearPending = startRoutePendingLog(prefix, started);
    console.log(prefix + ' START');
    try {
      const body = await readBody(req);
      const compactText = cleanOptionalString(body.compactText, '').trim();
      if (!compactText) {
        clearPending();
        return sendJson(res, 400, { ok: false, success: false, error: 'compactText required' });
      }
      const target = await resolveEditRangeMutationTarget(tabId, body);
      console.log(prefix + ' BODY tool=' + target.toolType +
        ' sid=' + shortId(target.sessionId) +
        ' start=' + shortId(target.startUuid) +
        ' end=' + shortId(target.endUuid) +
        ' status=' + (target.status?.status || '-') +
        ' compactChars=' + compactText.length);
      const result = target.toolType === 'codex'
        ? await codexDataApi.editCodexRange({
          sessionId: target.sessionId,
          cwd: target.cwd,
          startUuid: target.startUuid,
          endUuid: target.endUuid,
          compactText,
          ...(target.status?.codexSettingsProof
            ? { codexSettingsProof: target.status.codexSettingsProof }
            : {}),
        })
        : await claudeDataApi.editRange({
          sessionId: target.sessionId,
          cwd: target.cwd,
          startUuid: target.startUuid,
          endUuid: target.endUuid,
          compactText,
        });
      let adoptedSessionId = null;
      let adoptionError = null;
      if (target.toolType === 'codex' && result?.success !== false && result?.newSessionId) {
        try {
          await bridgeRequest('setCodexSessionId', {
            tabId,
            sessionId: result.newSessionId,
            reason: 'api-edit-range',
            codexSettingsProof: result.codexSettingsProof || target.status?.codexSettingsProof || null,
          }, 3000);
          adoptedSessionId = result.newSessionId;
        } catch (adoptErr) {
          adoptionError = String(adoptErr.message || adoptErr);
          console.warn(prefix + ' ADOPT_FAILED newSid=' + shortId(result.newSessionId) + ' error=' + adoptionError);
        }
      }
      clearPending();
      console.log(prefix + ' DONE tool=' + target.toolType +
        ' success=' + (result?.success === true) +
        ' removed=' + (result?.removedCount == null ? '-' : result.removedCount) +
        ' newSid=' + shortId(result?.newSessionId) +
        ' adopted=' + shortId(adoptedSessionId) +
        ' code=' + (result?.code || '-') +
        ' error=' + JSON.stringify(result?.error || adoptionError || '') +
        ' ms=' + (Date.now() - started));
      const statusCode = result?.success === false ? 409 : 200;
      return sendJson(res, statusCode, {
        ok: result?.success !== false,
        mode: 'compact',
        toolType: target.toolType,
        tabId,
        sessionId: target.sessionId,
        adoptedSessionId,
        adoptionError,
        startUuid: target.startUuid,
        endUuid: target.endUuid,
        ...result,
      });
    } catch (e) {
      clearPending();
      const statusCode = e.statusCode || 500;
      console.warn(prefix + ' ERROR ' + String(e.message || e) + ' ms=' + (Date.now() - started));
      return sendJson(res, statusCode, { ok: false, success: false, error: String(e.message || e), ...(e.details || {}) });
    }
  }

  // Middle history deletion for Claude JSONL / Codex rollout. Unlike /truncate,
  // this removes the selected range without inserting a compact replacement.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/delete-range$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const started = Date.now();
    const prefix = '[WebDeleteRange] tab=' + shortId(tabId, 12);
    const clearPending = startRoutePendingLog(prefix, started);
    console.log(prefix + ' START');
    try {
      const body = await readBody(req);
      const target = await resolveEditRangeMutationTarget(tabId, body, 'delete');
      console.log(prefix + ' BODY tool=' + target.toolType +
        ' sid=' + shortId(target.sessionId) +
        ' start=' + shortId(target.startUuid) +
        ' end=' + shortId(target.endUuid) +
        ' status=' + (target.status?.status || '-'));
      const result = target.toolType === 'codex'
        ? await (target.exactInPlaceRepair
          ? codexDataApi.deleteCodexRangeInPlace({
            sessionId: target.sessionId,
            cwd: target.cwd,
            startUuid: target.startUuid,
            endUuid: target.endUuid,
          })
          : codexDataApi.deleteCodexRange({
          sessionId: target.sessionId,
          cwd: target.cwd,
          startUuid: target.startUuid,
          endUuid: target.endUuid,
          ...(target.status?.codexSettingsProof
            ? { codexSettingsProof: target.status.codexSettingsProof }
            : {}),
        }))
        : await claudeDataApi.deleteRange({
          sessionId: target.sessionId,
          cwd: target.cwd,
          startUuid: target.startUuid,
          endUuid: target.endUuid,
        });
      let adoptedSessionId = null;
      let adoptionError = null;
      if (target.toolType === 'codex' && result?.success !== false && result?.newSessionId) {
        try {
          await bridgeRequest('setCodexSessionId', {
            tabId,
            sessionId: result.newSessionId,
            reason: 'api-delete-range',
            codexSettingsProof: result.codexSettingsProof || target.status?.codexSettingsProof || null,
          }, 3000);
          adoptedSessionId = result.newSessionId;
        } catch (adoptErr) {
          adoptionError = String(adoptErr.message || adoptErr);
          console.warn(prefix + ' ADOPT_FAILED newSid=' + shortId(result.newSessionId) + ' error=' + adoptionError);
        }
      }
      clearPending();
      console.log(prefix + ' DONE tool=' + target.toolType +
        ' success=' + (result?.success === true) +
        ' removed=' + (result?.removedCount == null ? '-' : result.removedCount) +
        ' fileDeleted=' + (result?.fileDeleted === true) +
        ' newSid=' + shortId(result?.newSessionId) +
        ' adopted=' + shortId(adoptedSessionId) +
        ' code=' + (result?.code || '-') +
        ' error=' + JSON.stringify(result?.error || adoptionError || '') +
        ' ms=' + (Date.now() - started));
      const statusCode = result?.success === false ? 409 : 200;
      return sendJson(res, statusCode, {
        ok: result?.success !== false,
        mode: 'delete',
        toolType: target.toolType,
        tabId,
        sessionId: target.sessionId,
        adoptedSessionId,
        adoptionError,
        startUuid: target.startUuid,
        endUuid: target.endUuid,
        ...result,
      });
    } catch (e) {
      clearPending();
      const statusCode = e.statusCode || 500;
      console.warn(prefix + ' ERROR ' + String(e.message || e) + ' ms=' + (Date.now() - started));
      return sendJson(res, statusCode, { ok: false, success: false, error: String(e.message || e), ...(e.details || {}) });
    }
  }

  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/open-in-workspace$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const result = await openAgentTabInWorkspace({
        tabId,
        spaceId: cleanOptionalString(body.spaceId, ''),
        workspaceName: cleanOptionalString(body.workspaceName, 'Докс'),
        windowIndex: body.windowIndex,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendTerminalBridgeError(res, error);
    }
  }

  // Rename tab (delegates to renderer store via bridge, with an exact archived
  // Inbox fallback so Voice and Terminal history do not diverge after auto-close).
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/rename$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name required' });
      try {
        const data = await bridgeRequest('renameTab', { tabId, name });
        return sendJson(res, 200, data);
      } catch (openError) {
        // Inbox tabs are intentionally auto-closed. Renaming a chat afterwards
        // must update the exact archived tab row instead of leaving Voice and
        // Terminal with different titles until the next resume.
        const archived = findRestorableAgentTabDescriptor(tabId);
        if (!archived?.ok) throw openError;
        const projectManager = require('./project-manager');
        const renamed = projectManager.db.updateTabHistoryTitle(archived.historyId, name, true);
        if (!renamed) throw new Error('archived tab title was not updated');
        webBroadcast(tabId, {
          type: 'tab-metadata',
          projectId: archived.projectId,
          name,
          nameSetManually: true,
          source: 'manual',
          archived: true,
          changedAt: Date.now(),
        });
        return sendJson(res, 200, { ok: true, tabId, name, archived: true });
      }
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Link a real file to an open AI tab using the same renderer/store scenario
  // as the desktop drag-and-drop flow. Canonicalization keeps the operation
  // idempotent across symlinks and relative-path aliases.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/link-file$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const requestedPath = typeof body.path === 'string' ? body.path.trim() : '';
      if (!requestedPath) return sendJson(res, 400, { error: 'path required' });
      if (!path.isAbsolute(requestedPath)) {
        return sendJson(res, 400, { error: 'path must be absolute' });
      }
      const filePath = await fs.promises.realpath(requestedPath);
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return sendJson(res, 400, { error: 'path must point to a file' });
      const data = await bridgeRequest('linkFileToTab', { tabId, filePath });
      return sendJson(res, 200, data);
    } catch (e) {
      const code = e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 404 : 409;
      return sendJson(res, code, { error: String(e.message || e) });
    }
  }

  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/status$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('setTabSessionStatus', { tabId, status: body.status || null });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Close tab (delegates to renderer store — same constraint as rename:
  // closed-only-when-open).
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/close$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      if (body.requireIdle === true) {
        const status = await bridgeRequest('getClaudeTabStatus', { tabId }, 2000);
        const lifecycle = status?.status || status?.sessionStatus || 'unknown';
        if (isAgentStatusBusyForClose(status)) {
          return sendJson(res, 409, {
            ok: false,
            closed: false,
            error: 'tab_is_busy',
            status: lifecycle,
          });
        }
      }
      const data = await bridgeRequest('closeTab', {
        tabId,
        aiBusyOverride: body.aiBusy === true || body.streaming === true
      });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Fork a materialized Claude/Codex session into a neighbouring PTY tab.
  // The renderer owns tab creation and pendingAction semantics; HTTP remains a
  // scenario boundary and never writes PTY commands itself.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/fork$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const data = await bridgeRequest('forkToTab', { tabId });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Fork a Claude session (PTY tab → new SDK tab). Source tab must be open
  // in the desktop and have a captured claudeSessionId. Returns the new tabId
  // so the mobile client can navigate straight into the chat.
  m = parsed.pathname.match(/^\/api\/tabs\/([^/]+)\/fork-to-sdk$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const data = await bridgeRequest('forkToSDK', { tabId });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 409, { error: String(e.message) });
    }
  }

  // Stop terminal runtime (or legacy SDK stream when the tab is still SDK).
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/stop$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const session = sdkSessions.get(tabId);
    if (session) {
      try { session.query.close(); } catch {}
      sdkSessions.delete(tabId);
      return sendJson(res, 200, { stopped: true });
    }
    // Normal path: Claude/Codex terminal tab. Try stop via scenario bridge.
    try {
      const data = await runAgentStopScenario(tabId, 2000);
      const outcome = classifyAgentActionResult('stop', data);
      return sendJson(res, outcome.statusCode, outcome.body);
    } catch (e) {
      const outcome = classifyAgentActionBridgeError('stop', e);
      return sendJson(res, outcome.statusCode, outcome.body);
    }
  }

  // SOFT interrupt the CURRENT TURN (composer Stop button). Claude/Codex PTY
  // goes through the terminal scenario layer; legacy SDK still uses query.close()
  // as a warm interrupt. Distinct from /stop, which kills the terminal process.
  // See fact-mobile-claude-pty.md.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/interrupt$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const session = sdkSessions.get(tabId);
    if (session) {
      // SDK soft-interrupt = close the query stream; the process is kept warm by
      // the desktop runner and the next message revives the turn loop.
      try { session.query.close(); } catch {}
      sdkSessions.delete(tabId);
      return sendJson(res, 200, { interrupted: true, kind: 'sdk' });
    }
    try {
      const data = await runAgentInterruptScenario(tabId, 30_000);
      const outcome = classifyAgentActionResult('interrupt', { kind: 'pty', ...data });
      return sendJson(res, outcome.statusCode, outcome.body);
    } catch (e) {
      const outcome = classifyAgentActionBridgeError('interrupt', e);
      return sendJson(res, outcome.statusCode, outcome.body);
    }
  }

  // Read the current terminal composer draft after a deterministic interrupt.
  // Mobile uses the same bridge action as desktop History instead of keeping a
  // local "last sent prompt" fallback.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/draft$/);
  if (m && (req.method === 'GET' || req.method === 'POST')) {
    const tabId = decId(m[1]);
    try {
      // Capture includes process/draft preflight, helper authorization and the
      // editor-return barrier. Its transport deadline must encompass those
      // bounded phases; a 5s outer timeout could discard an already transferred
      // snapshot even though the operation correctly finished seconds later.
      const data = await runAgentGrabDraftScenario(tabId, 30_000);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Non-mutating terminal-composer probe. Codex uses this before History/mobile
  // send: an empty dim-placeholder must not go through Ctrl+G/grab because that
  // changes TUI state. Claude currently has no visual probe, so the renderer
  // returns hasDraft:null and callers can fall back to the established grab path.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/draft-state$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    try {
      const data = await runAgentInspectDraftScenario(tabId, 5000);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // A separate current verdict; the operation GET itself remains immutable.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/history-operations\/([^/]+)\/applicability$/);
  if (m && req.method === 'GET') {
    try {
      if (!savedHistoryOperations || !conversationOwners) return sendJson(res, 503, { ok: false, error: 'history_owner_unavailable' });
      const data = savedHistoryOperations.applicability(decId(m[1]), decId(m[2]), parsed.query?.operationRevision);
      return data ? sendJson(res, 200, { ok: true, ...data })
        : sendJson(res, 404, { ok: false, error: 'history_operation_not_found' });
    } catch (error) { return sendJson(res, error.statusCode || 500, { ok: false, error: error.code || error.message }); }
  }

  // Additive saved-history scenario. Never reinterpret legacy /rewind mode.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/history-operations(?:\/([^/]+))?$/);
  if (m && (req.method === 'POST' || req.method === 'GET')) {
    const tabId = decId(m[1]);
    try {
      if (!savedHistoryOperations) return sendJson(res, 503, { ok: false, error: 'saved_history_unavailable' });
      const operation = req.method === 'POST' && !m[2]
        ? savedHistoryOperations.accept(tabId, await readBody(req))
        : req.method === 'GET' && m[2]
          ? savedHistoryOperations.read(tabId, decId(m[2])) : null;
      if (!operation) return sendJson(res, 404, { ok: false, error: 'history_operation_not_found' });
      return sendJson(res, operation.pending ? 202 : operation.success ? 200 : 409, { ok: true, operation });
    } catch (error) {
      return sendJson(res, error.statusCode || 500, { ok: false, error: error.code || error.message });
    }
  }

  // Native timeline rewind/backtrack for PTY Claude/Codex. The renderer routes
  // by live tab tool type to the same IPC handlers desktop Timeline uses.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/rewind$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const started = Date.now();
    const rewindPrefix = '[WebRewind] tab=' + shortId(tabId, 12);
    const clearPending = startRoutePendingLog(rewindPrefix, started);
    console.log(rewindPrefix + ' START');
    try {
      const body = await readBody(req);
      const mode = body.mode === 'ai' ? 'ai' : 'native';
      const timeoutMs = mode === 'ai' ? 180000 : 20000;
      console.log(rewindPrefix +
        ' BODY mode=' + mode +
        ' targetIndex=' + (body.targetIndex == null ? '-' : body.targetIndex) +
        ' rewindable=' + (body.rewindableCount == null ? '-' : body.rewindableCount) +
        ' skipDuplicates=' + (body.skipDuplicates || 0) +
        ' timeoutMs=' + timeoutMs);
      const data = await runAgentRewindScenario(tabId, {
        targetIndex: body.targetIndex,
        targetText: body.targetText,
        targetFullText: body.targetFullText,
        rewindableCount: body.rewindableCount,
        skipDuplicates: body.skipDuplicates || 0,
        mode,
        startUuid: body.startUuid || body.targetUuid || null,
        endUuid: body.endUuid || null,
        targetEntryRef: body.targetEntryRef || null,
        expectedContentRevision: body.expectedContentRevision || null,
        targetSourceIdentity: body.targetSourceIdentity || null,
        additionalPrompt: body.additionalPrompt || null,
      }, timeoutMs);
      clearPending();
      console.log(rewindPrefix + ' DONE mode=' + mode + ' ms=' + (Date.now() - started));
      return sendJson(res, 200, data);
    } catch (e) {
      clearPending();
      console.warn(rewindPrefix + ' ERROR ' + String(e.message || e) + ' ms=' + (Date.now() - started));
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Answer (or stop) an AskUserQuestion from mobile. Body:
  //   { source:'pty'|'sdk', toolUseID, answers:{[questionText]:label|labels}, stop? }
  // Routes to main's answerClaudeQuestion (PTY → drive TUI keystrokes, SDK →
  // resolve the parked canUseTool Promise). No bridge — these run in main directly.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/answer-question$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    try {
      const body = await readBody(req);
      const result = await runAgentAnswerQuestionScenario({
        tabId,
        source: body.source || 'pty',
        toolUseID: body.toolUseID,
        questions: body.questions,
        answers: body.answers || {},
        stop: !!body.stop,
      });
      return sendJson(res, 200, result || { success: false });
    } catch (e) {
      return sendJson(res, 200, { success: false, error: String(e.message) });
    }
  }
  // Current pending question for a tab (mobile fetches on mount in case it
  // connected mid-question and the ask-question broadcast already fired).
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/pending-question$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const q = getAgentPendingQuestionScenario(tabId);
    return sendJson(res, 200, { pendingQuestion: q });
  }

  // SDK params (model/effort/thinking) for a tab — read & update.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/params$/);
  if (m && req.method === 'GET') {
    try {
      const tabId = decId(m[1]);
      if (agentParamsService && parsed.query.operationId !== undefined) {
        const { statusCode, ...data } = await agentParamsService.read({ tabId, operationId: parsed.query.operationId });
        return sendJson(res, statusCode, data);
      }
      const current = typeof readAgentParams === 'function' ? await readAgentParams(tabId) : null;
      // null is the explicit SDK surface, not a PTY read-error fallback.
      const data = current ?? await bridgeRequest('getSDKParams', { tabId });
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, e.statusCode || 409, { error: String(e.message),
      ...(e.code ? { code: e.code } : {}), ...(e.runtimeStateUnknown ? { runtimeStateUnknown: true } : {}) }); }
  }
  if (m && req.method === 'POST') {
    let requestedSettingsTabId = null;
    try {
      const body = await readBody(req);
      const tabId = decId(m[1]);
      requestedSettingsTabId = tabId;
      if (agentParamsService && Object.prototype.hasOwnProperty.call(body, 'requestId')) {
        const { statusCode, ...data } = agentParamsService.submit({ ...body, tabId });
        return sendJson(res, statusCode, data);
      }
      const preparation = await prepareClosedCodexSettings({
        tabId, model: body.model, effort: body.effort,
        findOpen: findOrchestrationTabDescriptor,
        findArchived: findRestorableAgentTabDescriptor,
        restore: ensureExplicitAgentTabOpen,
      });
      const data = await bridgeRequest('setSDKParams', {
        ...body, tabId, persistRestoredCodexOptions: preparation.restored,
      });
      return sendJson(res, 200, data);
    } catch (e) {
      const detail = e?.bridgeData;
      const applied = detail?.appliedSettings;
      // Preserve only the confirmed half of THIS bridge request. A timeout
      // has no such reply; absence must not become "nothing was applied".
      const hasPartialProof = requestedSettingsTabId && detail?.tabId === requestedSettingsTabId
        && applied && typeof applied === 'object' && !Array.isArray(applied);
      const partial = hasPartialProof ? {
        appliedSettings: Object.fromEntries(['model', 'effort']
          .filter(kind => typeof applied[kind] === 'string').map(kind => [kind, applied[kind]])),
        ...(typeof detail.code === 'string' ? { code: detail.code } : {}),
        ...(typeof detail.failedCommand === 'string' ? { failedCommand: detail.failedCommand } : {}),
      } : {};
      return sendJson(res, e.statusCode || 409, { error: String(e.message), ...(e.code ? { code: e.code } : {}), ...partial });
    }
  }

  // Fast is a durable desired state. The bridge accepts it while Codex is
  // stopped/starting and main reconciles the latest intent after TUI readiness.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/codex\/fast$/);
  if (m && req.method === 'POST') {
    try {
      const data = await bridgeRequest('sendCodexFast', { tabId: decId(m[1]) });
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 409, { error: String(e.message) }); }
  }

  // Prompt-queue ("Run after") for a tab — read live core + sibling AI-tabs, or
  // apply one mutation op. Mobile mirrors the desktop store; the desktop runner
  // does the firing. GET returns { queue, aiTabs }; POST body { op, args } maps
  // 1:1 to a store method (see App.tsx::mutatePromptQueue). Live deltas arrive
  // separately via the `queue-update` SSE event.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/queue$/);
  if (m && req.method === 'GET') {
    try {
      const data = await bridgeRequest('getPromptQueue', { tabId: decId(m[1]) });
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 409, { error: String(e.message) }); }
  }
  if (m && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = await bridgeRequest('mutatePromptQueue', { tabId: decId(m[1]), op: body.op, args: body.args });
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 409, { error: String(e.message) }); }
  }

  // Explicit task completion is scoped to the caller's current live turn. It
  // does not finish a run by itself; main attaches the intent to the matching
  // authoritative turn-end edge, where Loop can consume it exactly once.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/complete-task$/);
  if (m && req.method === 'POST') {
    const tabId = decId(m[1]);
    const body = await readBody(req);
    const sourceTabId = cleanOptionalString(body?.sourceMeta?.tabId, '') || tabId;
    if (sourceTabId !== tabId) {
      return sendJson(res, 403, { ok: false, code: 'source_tab_mismatch' });
    }
    if (typeof registerTaskCompletionIntent !== 'function') {
      return sendJson(res, 503, { ok: false, code: 'completion_registry_unavailable' });
    }

    const blockers = findTaskCompletionBlockers(
      await getOrchestrationRunStore().listActive(),
      tabId,
    );
    if (blockers.length > 0) {
      return sendJson(res, 409, {
        ok: false,
        code: 'active_child_delegations',
        blockers,
      });
    }

    const result = registerTaskCompletionIntent({ tabId, sourceTabId, status: body?.status, reason: body?.reason });
    if (result?.ok !== true) {
      return sendJson(res, 409, { ok: false, code: result?.code || 'completion_rejected' });
    }
    return sendJson(res, 200, {
      ok: true,
      idempotent: result.idempotent === true,
      turn: result.turn,
    });
  }

  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/rewind-recovery$/);
  if (m && (req.method === 'GET' || req.method === 'POST')) {
    const tabId = decId(m[1]);
    try {
      const input = req.method === 'POST' ? await readBody(req) : parsed.query;
      const request = { tabId,
        operationId: cleanOptionalString(input.operationId, ''),
        actionGeneration: cleanOptionalString(input.actionGeneration || input.generation, '') };
      if (!request.operationId || !request.actionGeneration) {
        return sendJson(res, 400, { success: false, error: 'codex_rewind_recovery_identity_required' });
      }
      const handler = req.method === 'POST' ? recoverCodexRewindPostEnter : readCodexRewindPostEnterResult;
      if (!handler) return sendJson(res, 503, { success: false, error: 'codex_rewind_recovery_unavailable' });
      const result = await handler(request);
      return sendJson(res, result?.success ? 200 : result?.pending ? 202 : 409, result);
    } catch (error) { return sendTerminalBridgeError(res, error); }
  }

  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/rewind-state$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const identity = cleanOptionalString(parsed.query.sourceIdentity || parsed.query.targetUuid, '');
    const generation = cleanOptionalString(parsed.query.generation, '');
    if (!identity || !generation || !readCodexNativeRewindState) {
      return sendJson(res, 400, { ok: false, error: 'sourceIdentity and generation required' });
    }
    try {
      const journal = readCodexNativeRewindState(tabId);
      if (journal?.invalid || (journal?.pending && String(journal.generation) !== generation)) {
        return sendJson(res, 200, { ok: true, state: 'unknown', reason: 'rewind-owner-unresolved' });
      }
      const openDescriptor = findOrchestrationTabDescriptor(tabId);
      const archivedDescriptor = openDescriptor ? null : findRestorableAgentTabDescriptor(tabId);
      if (!openDescriptor && !archivedDescriptor?.ok) return sendJson(res, 200, { ok: true, state: 'unknown' });
      const runtime = openDescriptor ? await bridgeRequest('getClaudeTabStatus', { tabId }, 5000) : { status: 'inactive' };
      const processAlive = ['active', 'busy', 'starting', 'resuming'].includes(runtime?.status);
      if (journal?.pending && processAlive) return sendJson(res, 200, { ok: true, state: 'pending', generation });
      if (!processAlive && runtime?.status !== 'inactive') return sendJson(res, 200, { ok: true, state: 'unknown' });
      const info = openDescriptor ? await resolveHistorySessionInfo(tabId, 5000) : archivedDescriptor;
      const timeline = await transcriptService?.getTimeline({ tabId, toolType: 'codex', sessionId: info?.sessionId, cwd: info?.cwd });
      if (!timeline?.success) return sendJson(res, 200, { ok: true, state: 'unknown', error: timeline?.error });
      const matches = timeline.entries.filter((entry) => historyEntryHasExactIdentity(entry, identity));
      return sendJson(res, 200, { ok: true,
        state: matches.length === 0 ? 'committed' : matches.length === 1 ? 'unchanged' : 'unknown',
        sessionId: info.sessionId, generation });
    } catch (error) { return sendTerminalBridgeError(res, error); }
  }

  // Timeline entries for a tab (any tab — SDK or terminal — as long as it has
  // a Claude session). Goes through bridgeRequest → renderer reads tab.cwd +
  // claudeSessionId from the live store, then we call the IPC directly here.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/timeline$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const ownerBeforeRead = conversationOwners?.current(tabId) || null;
    const t0 = Date.now();
    const requestId = crypto.randomBytes(4).toString('hex');
    const timelinePrefix = `[WebTiming] /timeline rid=${requestId} tab=${shortId(tabId, 12)}`;
    const clearPending = startRoutePendingLog(timelinePrefix, t0);
    console.log(`${timelinePrefix} START`);
    try {
      const tBridge = Date.now();
      const info = await resolveHistorySessionInfo(tabId, 1500);
      const sessionId = info?.sessionId || null;
      const cwd = info?.cwd || null;
      const toolType = info?.toolType || null;
      if (!sessionId || !toolType) {
        clearPending();
        console.log(`${timelinePrefix} NO_SESSION bridge=${tBridge-t0}ms total=${Date.now()-t0}ms`);
        return sendJson(res, 200, { entries: [], ...finishConversationOwnerRead(tabId, ownerBeforeRead) });
      }
      if (transcriptService && (toolType === 'codex' || toolType === 'claude')) {
        const timelineResult = await transcriptService.getTimeline({ tabId, toolType, sessionId, cwd });
        if (!timelineResult?.success) {
          clearPending();
          console.log(`${timelinePrefix} TRANSCRIPT_NO_TIMELINE tool=${toolType} bridge=${tBridge-t0}ms total=${Date.now()-t0}ms error=${String(timelineResult?.error || '-')}`);
          return sendJson(res, timelineResult?.error === 'lineage_unresolved' ? 409 : 500, {
            ...timelineResult, success: false, entries: [], sessionId, toolType,
            error: timelineResult?.error || 'timeline_read_failed',
          });
        }
        const entries = timelineResult.entries || [];
        let fullEntries = [];
        if (entries.some(e => e?.type === 'compact' || e?.role === 'compact' || e?.kind === 'compact')) {
          try {
            const full = await transcriptService.getHistory({ tabId, toolType, sessionId, cwd });
            fullEntries = Array.isArray(full?.entries) ? full.entries : [];
          } catch (summaryErr) {
            console.log(`[WebTiming] /timeline TRANSCRIPT_COMPACT_SUMMARY_SKIP ${String(summaryErr.message)}`);
          }
        }
        const mobileEntries = normalizeMobileTimelineEntries(entries, fullEntries);
        const tParse = Date.now();
        clearPending();
        console.log(`${timelinePrefix} DONE tool=${toolType} source=transcript entries=${mobileEntries.length} bridge=${tBridge-t0}ms parse=${tParse-tBridge}ms total=${tParse-t0}ms`);
        return sendJson(res, 200, {
          entries: mobileEntries,
          sessionId,
          toolType,
          ...finishConversationOwnerRead(tabId, ownerBeforeRead),
          count: mobileEntries.length,
          revision: timelineResult.revision || null,
          contentRevision: timelineResult.contentRevision || null,
          composite: timelineResult.composite === true,
          viewOwnerSessionId: timelineResult.viewOwnerSessionId || sessionId,
        });
      }
      if (toolType === 'codex') {
        if (!loadCodexSessionRecords || !buildCodexTimeline) {
          clearPending();
          return sendJson(res, 500, { error: 'codex timeline parser not loaded' });
        }
        const loaded = await loadCodexSessionRecords(sessionId, cwd);
        if (!loaded?.success) {
          clearPending();
          console.log(`${timelinePrefix} CODEX_NO_FILE bridge=${tBridge-t0}ms total=${Date.now()-t0}ms`);
          return sendJson(res, 200, { entries: [], sessionId, toolType });
        }
        const entries = buildCodexTimeline(loaded.records || [], sessionId);
        let fullEntries = [];
        if (entries.some(e => e?.type === 'compact' || e?.role === 'compact')) {
          try {
            const full = await bridgeRequest('loadAgentFullHistory', { tabId }, 5000);
            fullEntries = Array.isArray(full?.entries) ? full.entries : [];
          } catch (summaryErr) {
            console.log(`[WebTiming] /timeline CODEX_COMPACT_SUMMARY_SKIP ${String(summaryErr.message)}`);
          }
        }
        const mobileEntries = normalizeMobileTimelineEntries(entries, fullEntries);
        const tParse = Date.now();
        clearPending();
        console.log(`${timelinePrefix} DONE tool=codex entries=${mobileEntries.length} bridge=${tBridge-t0}ms parse=${tParse-tBridge}ms total=${tParse-t0}ms`);
        return sendJson(res, 200, { entries: mobileEntries, sessionId, toolType, count: mobileEntries.length });
      }
      if (!parseTimelineEntries || !findSessionFile) {
        clearPending();
        return sendJson(res, 500, { error: 'timeline parser not loaded' });
      }
      const found = findSessionFile(sessionId, cwd);
      if (!found) {
        clearPending();
        console.log(`${timelinePrefix} NO_FILE bridge=${tBridge-t0}ms total=${Date.now()-t0}ms`);
        return sendJson(res, 200, { entries: [], sessionId, toolType });
      }
      const tFind = Date.now();
      const entries = parseTimelineEntries(found.filePath);
      let fullEntries = [];
      if (entries.some(e => e?.type === 'compact' || e?.role === 'compact')) {
        try {
          const full = await bridgeRequest('loadAgentFullHistory', { tabId }, 5000);
          fullEntries = Array.isArray(full?.entries) ? full.entries : [];
        } catch (summaryErr) {
          console.log(`[WebTiming] /timeline CLAUDE_COMPACT_SUMMARY_SKIP ${String(summaryErr.message)}`);
        }
      }
      const mobileEntries = normalizeMobileTimelineEntries(entries, fullEntries);
      const tParse = Date.now();
      clearPending();
      console.log(`${timelinePrefix} DONE tool=claude entries=${mobileEntries.length} bridge=${tBridge-t0}ms find=${tFind-tBridge}ms parse=${tParse-tFind}ms total=${tParse-t0}ms`);
      return sendJson(res, 200, { entries: mobileEntries, sessionId, toolType, count: mobileEntries.length });
    } catch (e) {
      clearPending();
      console.log(`${timelinePrefix} ERROR ${String(e.message)} total=${Date.now()-t0}ms`);
      return sendJson(res, 500, { error: String(e.message) });
    }
  }

  // Read the SAME main-owned interval as desktop. No renderer/PTY readiness
  // lookup and no request-clock masquerading as the beginning of an answer.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/timing$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const toolType = parsed.query.toolType;
    if (toolType != null && toolType !== 'claude' && toolType !== 'codex') {
      return sendJson(res, 400, { error: 'toolType must be claude or codex' });
    }
    if (!findOrchestrationTabDescriptor(tabId)) return sendJson(res, 404, { error: 'tab_not_found' });
    if (!readAgentTabTiming) return sendJson(res, 503, { error: 'response_timing_unavailable' });
    try { return sendJson(res, 200, publicTabTimingSnapshot(tabId, toolType)); }
    catch (error) { return sendJson(res, 500, { error: error.message }); }
  }

  // Load JSONL session history.
  // - Default: JSON `{ messages, total, truncated, dropped, etag }` (legacy clients)
  // - With `Accept: application/x-ndjson` OR `?ndjson=1`: STREAMING NDJSON.
  //     Line 1: `{"type":"meta", total, sessionId, etag, returned, lastUuid}`
  //     Lines 2..N+1: one message JSON per line
  //     Compressed via Brotli (quality 4) when client accepts `br`, piped
  //     directly to the response — first message bytes reach the phone in
  //     ~50ms instead of the ~4s buffered-and-compress wait.
  // - `?after=<uuid>` returns ONLY messages strictly after that uuid (delta sync).
  // - `?before=<uuid>` returns ONLY messages strictly before that uuid (prefix
  //    backfill). Combined with phase 1 `?last=200` → phase 2 `?before=<firstTailUuid>`,
  //    the cold-open paint flow is: tail in 1s, prefix streams in behind it.
  // - `?last=N` returns the last N messages.
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/history-payload$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const started = Date.now();
    let request;
    try { request = historyPayloadQuery(parsed.query); }
    catch (error) { return sendJson(res, 400, { success: false, error: error.message }); }
    if (!transcriptService?.getToolPayload) return sendJson(res, 503, { success: false, error: 'history_payload_unavailable' });
    try {
      const info = await resolveHistorySessionInfo(tabId, 1500);
      if (!info?.sessionId) return sendJson(res, 409, { success: false, error: 'history_read_identity_unavailable' });
      if (info.sessionId !== request.sessionId || info.toolType !== request.toolType) {
        return sendJson(res, 409, { success: false, error: 'history_read_identity_changed' });
      }
      const result = await transcriptService.getToolPayload({ ...request, tabId, cwd: info.cwd || null });
      const current = await resolveHistorySessionInfo(tabId, 1500);
      if (current?.sessionId !== info.sessionId || current?.toolType !== info.toolType || (current?.cwd || null) !== (info.cwd || null)) {
        return sendJson(res, 409, { success: false, error: 'history_read_identity_changed' });
      }
      console.log('[WebTiming] /history-payload tab=' + tabId.slice(-12) + ' tool=' + info.toolType
        + ' success=' + (result?.success === true) + ' source=' + (result?.source || '-')
        + ' reason=' + (result?.error || '-') + ' chars=' + (result?.payload?.length || 0) + ' ms=' + (Date.now() - started));
      const status = result?.success ? 200 : result?.error === 'history_payload_not_found' || result?.error === 'payload not found' ? 404
        : /^(history_payload_(generation_changed|changed)|history_source_changed_during_preparation|lineage_unresolved)/.test(result?.error || '') ? 409 : 500;
      return sendJson(res, status, result || { success: false, error: 'history_payload_unavailable' });
    } catch (error) {
      console.log('[WebTiming] /history-payload ERROR reason=' + String(error.message) + ' ms=' + (Date.now() - started));
      return sendJson(res, error.message === 'history_payload_range_invalid' ? 400 : 500,
        { success: false, error: error.message });
    }
  }
  m = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/history$/);
  if (m && req.method === 'GET') {
    const tabId = decId(m[1]);
    const ownerBeforeRead = conversationOwners?.current(tabId) || null;
    const t0 = Date.now();
    const lastRaw = parsed.query.last;
    const lastN = lastRaw != null ? Math.max(1, Math.min(20000, parseInt(String(lastRaw), 10) || 0)) : null;
    const afterUuid = typeof parsed.query.after === 'string' ? parsed.query.after : null;
    const beforeUuid = typeof parsed.query.before === 'string' ? parsed.query.before : null;
    const fromUuid = typeof parsed.query.from === 'string' ? parsed.query.from : null;
    const aroundUuid = typeof parsed.query.around === 'string' ? parsed.query.around : null;
    const radiusRaw = parsed.query.radius;
    const aroundRadius = radiusRaw != null ? Math.max(1, Math.min(500, parseInt(String(radiusRaw), 10) || 80)) : 80;
    const wantHistoryEntries = parsed.query.view === 'history' || parsed.query.entries === '1';
    const wantNdjson = /\bapplication\/x-ndjson\b/.test(req.headers['accept'] || '') || parsed.query.ndjson === '1';
    const requestedRevision = parsed.query.ifRevision;
    const deltaOk = parsed.query.delta === '1';
    const payloadPolicy = parsed.query.payloads;
    const freshnessRequested = parsed.query.freshness === 'v1';
    if (parsed.query.freshness != null && !freshnessRequested) return sendJson(res, 400,
      { success: false, error: 'history_freshness_version_invalid' });
    if (freshnessRequested && (!wantHistoryEntries || !publicHistoryFreshness)) return sendJson(res, 400,
      { success: false, error: 'history_freshness_unavailable' });
    if (payloadPolicy != null && payloadPolicy !== historyPayloadCapability.historyQuery.payloads) {
      return sendJson(res, 400, { success: false, error: 'history_payload_policy_invalid' });
    }
    if (payloadPolicy && !wantHistoryEntries) return sendJson(res, 400, { success: false, error: 'history payloads require view=history' });
    if (requestedRevision != null && (typeof requestedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(requestedRevision))) {
      return sendJson(res, 400, { error: 'ifRevision must be an opaque historyRevision token' });
    }
    if ((requestedRevision != null || deltaOk) && !wantHistoryEntries) {
      return sendJson(res, 400, { error: 'conditional history requires view=history' });
    }
    console.log(`[WebTiming] /history START tabId=${tabId.slice(0, 24)} last=${lastN || 'all'} after=${afterUuid ? afterUuid.slice(0, 8) : 'none'} before=${beforeUuid ? beforeUuid.slice(0, 8) : 'none'} around=${aroundUuid ? aroundUuid.slice(0, 8) : 'none'} radius=${aroundRadius} view=${wantHistoryEntries ? 'history' : 'messages'} ndjson=${wantNdjson} payloads=${payloadPolicy || 'full'}`);
    try {
      if (wantHistoryEntries) {
        let data = null;
        let readScope = null;
        if (transcriptService) {
          try {
            const info = await resolveHistorySessionInfo(tabId, 1500);
            if ((info?.toolType === 'codex' || info?.toolType === 'claude') && info?.sessionId) {
              const bounds = { last: lastN, afterUuid, beforeUuid, fromUuid, aroundUuid, radius: aroundRadius };
              readScope = { tabId, toolType: info.toolType, sessionId: info.sessionId, cwd: info.cwd || null, bounds };
              if (freshnessRequested) readScope.freshness = 'v1';
              if (payloadPolicy) Object.assign(readScope, { payloadPolicy, dehydrate: true,
                payloadHeaderVersion: historyPayloadCapability.headerVersion });
              data = freshnessRequested ? await readHistoryFreshnessWindow({ info, readScope, requestedRevision, deltaOk })
                : await transcriptService.getHistory({
                ...readScope,
                ifRevision: publicHistoryRevisions.lookup(requestedRevision, readScope),
                deltaOk,
                deltaConsumerId: deltaOk
                  ? 'http:' + crypto.createHash('sha256').update(JSON.stringify(readScope)).digest('hex')
                  : null,
              });
              if (data?.success) {
                if (freshnessRequested || payloadPolicy || requestedRevision != null || deltaOk || info.readIdentitySource === 'empty-resume-source') {
                  const current = await resolveHistorySessionInfo(tabId, 1500);
                  if (current?.sessionId !== info.sessionId || current?.toolType !== info.toolType || (current?.cwd || null) !== (info.cwd || null)
                    || (info.readIdentitySource === 'empty-resume-source' && current?.readIdentitySource !== 'empty-resume-source')) {
                    return sendJson(res, 409, { success: false, error: 'history_read_identity_changed',
                      previousReadSessionId: info.sessionId, readSessionId: current?.sessionId || null,
                      toolType: current?.toolType || null });
                  }
                }
                data = { ...data, toolType: info.toolType, commandType: info.toolType, sessionId: info.sessionId,
                  readSessionId: info.sessionId, writerSessionId: info.writerSessionId || null,
                  writerConfirmed: info.writerConfirmed === true,
                  ...(payloadPolicy ? { payloadPolicy, payloadHeaderVersion: historyPayloadCapability.headerVersion } : {}),
                  historyRevision: publicHistoryRevisions.remember(data.revision, readScope, data.historyFreshness) };
                if (data.historyFreshness) data.historyFreshness = { ...data.historyFreshness,
                  coverage: { requestKey: crypto.createHash('sha256').update(JSON.stringify(readScope)).digest('hex'),
                    historyRevision: data.historyRevision } };
                publishTabTiming(tabId, 'history-read');
              } else if (data?.error) {
                // A known read failure is authoritative. Renderer fallback
                // used to discard lineageReason and turn missing ancestry
                // into an unrelated empty/error response.
                return sendJson(res, data.error === 'lineage_unresolved' ? 409 : 500, {
                  ...data, toolType: info.toolType, sessionId: info.sessionId,
                });
              } else {
                data = null;
              }
            }
          } catch (e) {
            console.log(`[WebTiming] /history TRANSCRIPT_HISTORY_SKIP ${String(e.message)}`);
          }
        }
        if (!data && (freshnessRequested || payloadPolicy || requestedRevision != null || deltaOk)) {
          return sendJson(res, 409, { success: false, error: 'history_read_identity_unavailable' });
        }
        if (!data) data = await bridgeRequest('loadAgentFullHistory', { tabId }, 5000);
        data = { ...data, ...finishConversationOwnerRead(tabId, ownerBeforeRead) };
        // Neither unchanged nor delta means "empty history". Keep both shapes
        // intact; do not feed a missing entries array through the window parser.
        if (data?.unchanged === true || data?.delta === true) return sendJson(res, 200, data);
        const historyWindow = data?.boundsApplied === true
          ? {
              entries: Array.isArray(data?.entries) ? data.entries : [],
              total: Number.isFinite(data?.total) ? data.total : (data?.entries?.length || 0),
              dropped: Number.isFinite(data?.dropped) ? data.dropped : 0,
              truncated: data?.truncated === true,
              firstUuid: data?.firstUuid || null,
              lastUuid: data?.lastUuid || null,
            }
          : applyHistoryEntryWindow(data?.entries || [], {
              last: lastN,
              afterUuid,
              beforeUuid,
              fromUuid,
              aroundUuid,
              radius: aroundRadius,
            });
        const { entries, total, dropped, truncated, firstUuid, lastUuid } = historyWindow;
        const etagSrc = (payloadPolicy ? payloadPolicy + ':headers:' + historyPayloadCapability.headerVersion + ':' : '')
          + entries.map((e) => `${e?.uuid || ''}:${e?.queueStatus || ''}:${e?.deliveryStatus || ''}`).join('|');
        const etag = crypto.createHash('sha1').update(etagSrc).digest('hex').slice(0, 16);
        console.log(`[WebTiming] /history DONE view=history tool=${data?.toolType || '-'} total=${total} returned=${entries.length} dropped=${dropped} around=${aroundUuid ? aroundUuid.slice(0, 8) : 'none'} ms=${Date.now()-t0}`);
        return sendJson(res, 200, { ...data, entries, total, truncated, dropped, etag, firstUuid, lastUuid });
      }

      let data = null;
      if (transcriptService) {
        try {
          const info = await resolveAgentSessionInfo(tabId, 1500);
          if (info?.toolType === 'codex' && info?.sessionId) {
            data = await transcriptService.getMessages({
              tabId,
              toolType: info.toolType,
              sessionId: info.sessionId,
              cwd: info.cwd || null,
            });
            if (data?.success) {
              data = { ...data, toolType: info.toolType, commandType: info.toolType, sessionId: info.sessionId };
            } else {
              data = null;
            }
          }
        } catch (e) {
          console.log(`[WebTiming] /history TRANSCRIPT_MESSAGES_SKIP ${String(e.message)}`);
        }
      }
      if (!data) data = await bridgeRequest('loadSDKHistory', { tabId });
      const allMsgs = data?.messages || [];
      const total = allMsgs.length;

      // Apply filters in order: after-cursor → before-cursor → last-tail.
      let messages = allMsgs;
      let dropped = 0;
      if (afterUuid) {
        const idx = messages.findIndex((m) => m && m.uuid === afterUuid);
        if (idx >= 0) messages = messages.slice(idx + 1);
        else messages = []; // unknown uuid → empty delta
      }
      if (beforeUuid) {
        const idx = messages.findIndex((m) => m && m.uuid === beforeUuid);
        // Found → return the prefix (everything strictly before it).
        // Not found → safer to return empty than to dump everything; client
        // would think this IS the prefix and skip phase 2 entirely.
        if (idx >= 0) messages = messages.slice(0, idx);
        else messages = [];
      }
      if (lastN && messages.length > lastN) {
        dropped = messages.length - lastN;
        messages = messages.slice(messages.length - lastN);
      }
      const truncated = dropped > 0;
      const lastUuid = messages.length ? (messages[messages.length - 1]?.uuid || null) : null;
      // Cheap content fingerprint over uuids — client uses this as a cache key.
      // Hashing uuids only (not bodies) is enough: any backend mutation creates
      // a new uuid via Anthropic SDK, so uuid-set uniquely identifies content.
      const etagSrc = messages.map((m) => m?.uuid || '').join('|');
      const etag = crypto.createHash('sha1').update(etagSrc).digest('hex').slice(0, 16);

      const firstUuid = messages.length ? (messages[0]?.uuid || null) : null;

      if (!wantNdjson) {
        console.log(`[WebTiming] /history DONE total=${total} returned=${messages.length} dropped=${dropped} ms=${Date.now()-t0} mode=json`);
        return sendJson(res, 200, { ...data, messages, total, truncated, dropped, etag, lastUuid, firstUuid });
      }

      // ─── NDJSON streaming path ────────────────────────────────────────
      // Pipe: write() lines → Brotli transform (if accepted) → response.
      const accept = req.headers['accept-encoding'] || '';
      const useBrotli = /\bbr\b/.test(accept);
      const useGzip = !useBrotli && /\bgzip\b/.test(accept);

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Vary': 'Accept-Encoding, Accept',
        ...(useBrotli ? { 'Content-Encoding': 'br' } : useGzip ? { 'Content-Encoding': 'gzip' } : {}),
        // Tell intermediaries (and clients) we want chunked-transfer, not
        // wait-for-full-length. Critical for streaming perception.
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      });

      let sink = res;
      if (useBrotli) {
        // Quality 4 = balanced ratio/speed for live encoding (~20-40 MB/s).
        // Higher quality (11 default) is 100x slower for tiny ratio win.
        const br = zlib.createBrotliCompress({
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          },
        });
        br.pipe(res);
        sink = br;
      } else if (useGzip) {
        const gz = zlib.createGzip({ level: 4 });
        gz.pipe(res);
        sink = gz;
      }

      const writeLine = (obj) => sink.write(JSON.stringify(obj) + '\n');

      // Meta first — client uses `total` for the progress bar, `etag` for cache key.
      // `firstUuid` enables phase-2 prefix backfill (`?before=<firstUuid>`).
      writeLine({
        type: 'meta',
        total,
        returned: messages.length,
        truncated,
        dropped,
        sessionId: data?.sessionId,
        etag,
        lastUuid,
        firstUuid,
      });

      // Yield to event loop every 200 messages so we don't synchronously block
      // when a single client requests a 5000-message dump. The lighter pulse
      // keeps the HTTP server responsive to other requests during a big stream.
      const FLUSH_EVERY = 200;
      let written = 0;
      for (const msg of messages) {
        writeLine(msg);
        written += 1;
        if (written % FLUSH_EVERY === 0) {
          await new Promise((r) => setImmediate(r));
        }
      }
      // End sentinel — client can rely on `done` to know stream completed
      // cleanly vs was cut off mid-flight.
      writeLine({ type: 'done', written });
      sink.end();
      console.log(`[WebTiming] /history DONE total=${total} returned=${messages.length} dropped=${dropped} ms=${Date.now()-t0} mode=ndjson enc=${useBrotli ? 'br' : useGzip ? 'gz' : 'plain'}`);
      return;
    } catch (e) {
      console.log(`[WebTiming] /history ERROR ${String(e.message)} total=${Date.now()-t0}ms`);
      if (!res.headersSent) return sendJson(res, 500, { error: String(e.message) });
      try { res.end(); } catch {}
      return;
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

// ───────── Static file serving (mobile-web/dist) ─────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, parsed) {
  const distRoot = path.resolve(__dirname, '../../mobile-web/dist');
  let urlPath = parsed.pathname;
  if (urlPath === '/') urlPath = '/index.html';
  // SPA fallback — any unknown path serves index.html so React Router takes over
  let filePath = path.join(distRoot, urlPath);
  // Block directory escapes
  if (!filePath.startsWith(distRoot)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Fallback to index.html for SPA routes
      filePath = path.join(distRoot, 'index.html');
      fs.readFile(filePath, (err2, data) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('mobile-web/dist not built. Run: cd mobile-web && npm run build');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ───────── WS pub/sub ─────────

function hasTabSubscribers(tabId) {
  return [...(subscribers.get(tabId) || [])].some(sink => sink.isAlive());
}

function publishCompletionNotificationChange({ tabId, projectId }) {
  const payload = { type: 'completion-notification-changed', tabId, projectId };
  webBroadcast(tabId, payload);
  // Directory/menu clients need no per-tab History subscription just to see
  // a desktop bell change. This is a wake, not another settings mirror.
  webBroadcast(PROJECT_ACTIVITY_TOPIC, payload);
}

function publicTabTimingSnapshot(tabId, toolType = null) {
  const value = readAgentTabTiming({ tabId, ...(toolType ? { toolType } : {}) });
  const fingerprint = JSON.stringify({ success: value.success, timing: value.timing, scope: value.scope });
  // Content revision, not a counter that resets after unsubscribe. GET never
  // consumes the change notification owed to another connected client.
  const revision = crypto.createHash('sha256').update(fingerprint).digest('hex');
  return { ...value, tabId, timingRevision: revision, instanceId: webServerInstanceId };
}

function sendTabTimingSnapshot(tabId, sink, reason) {
  if (!readAgentTabTiming || !sink.isAlive()) return;
  sink.send(JSON.stringify({ type: 'timing-changed', ...publicTabTimingSnapshot(tabId), reason }));
}

async function sendHistoryFreshnessSnapshot(tabId, sink) {
  if (!publicHistoryFreshness || !sink.isAlive()) return;
  const result = await readPublicHistoryFreshness([tabId]);
  if (sink.isAlive()) sink.send(JSON.stringify({ type: 'history-freshness', tabId,
    historyFreshness: result.snapshots[0], reason: 'connect' }));
}

function publishTabTiming(tabId, reason, force = false) {
  if (!readAgentTabTiming || !hasTabSubscribers(tabId)) return;
  const previous = publicTimingSnapshots.get(tabId + ':current');
  const snapshot = publicTabTimingSnapshot(tabId);
  if (!force && previous === snapshot.timingRevision) return;
  publicTimingSnapshots.set(tabId + ':current', snapshot.timingRevision);
  webBroadcast(tabId, { type: 'timing-changed', ...snapshot, reason });
}

function subscribe(tabId, sink) {
  if (!subscribers.has(tabId)) subscribers.set(tabId, new Set());
  subscribers.get(tabId).add(sink);
  console.log('[WebSub:Subscribe] tab=' + shortId(tabId, 12) + ' kind=' + sink.kind + ' total=' + subscribers.get(tabId).size + ' tabs=' + subscribers.size);
}
function unsubscribeAll(sink) {
  let removed = 0;
  for (const [tabId, set] of subscribers) {
    if (set.delete(sink)) removed++;
    if (!set.size) {
      subscribers.delete(tabId);
      for (const tool of ['current', 'claude', 'codex']) publicTimingSnapshots.delete(tabId + ':' + tool);
    }
  }
  if (removed) console.log('[WebSub:Unsubscribe] kind=' + (sink.kind || '?') + ' removed=' + removed + ' remainingTabs=' + Array.from(subscribers.entries()).filter(([_, s]) => s.size > 0).length);
}

// Wrap a raw WebSocket as a Sink.
function wsSink(ws) {
  return {
    kind: 'ws',
    send: (str) => { if (ws.readyState === 1) ws.send(str); },
    isAlive: () => ws.readyState === 1,
    close: () => { try { ws.close(); } catch {} },
    _ws: ws,
  };
}

// Stop watcher AND drop pending-promotion slot for any tab whose last
// subscriber (ws OR sse) disconnected. Both maps may hold orphans. Shared by
// the WS close/error handlers and the SSE req-close handler.
function releaseClaudeWatchersIfOrphan() {
  const allTabIds = new Set([
    ...claudeTabWatchers.keys(),
    ...claudeTabWatcherPending,
  ]);
  for (const tid of allTabIds) {
    const set = subscribers.get(tid);
    if (!set || set.size === 0) stopClaudeTabWatcher(tid);
  }
}

function releaseTranscriptSubscriptionsIfOrphan() {
  tabTranscriptSubscriptions?.releaseOrphans();
}

// Called from main.js when SDK/PTY fires events. Cheap O(n) over clients
// subscribed to that specific tabId — usually 0-1 phone connected. Transport
// (ws/sse) is opaque here; each Sink knows how to write itself.
//
// Logging is lifecycle-first, with one important exception: when a phone is
// actively subscribed, 'message' fan-out is logged with metadata only. That
// gives a permanent causal trace for "server emitted → SSE wrote → iOS applied"
// without dumping chat text or spamming desktop-only sessions with message drops.
const BCAST_LOG_TYPES = new Set(['snapshot', 'busy', 'done', 'tab-metadata', 'background-work', 'bridge-update', 'queue-update', 'ask-question', 'question-cancelled', 'project-activity', 'orchestration-update']);
function webBroadcast(tabId, payload) {
  if (payload?.type === 'activity-timing-invalidated') {
    publishTabTiming(tabId, payload.reason); return;
  }
  payload = withMessageProjection(payload);
  if (payload && (payload.type === 'snapshot' || payload.type === 'busy' || payload.type === 'done')) {
    payload = stampPublicRuntimeSnapshot(tabId, payload);
  }
  const type = payload && payload.type;
  if (publicHistoryFreshness?.hasTab(tabId)
    && ['transcript-changed','timing-changed','snapshot','bridge-update'].includes(type)) {
    const historyFreshness = publicHistoryFreshness.invalidate(tabId, type);
    webBroadcast(tabId, { type: 'history-freshness', historyFreshness });
  }
  if (['busy','done','snapshot','bridge-update'].includes(type)) agentSendQueue?.notifyRuntime(tabId);
  if (tabMessageService && ['busy', 'done', 'snapshot', 'bridge-update'].includes(type)) {
    void tabMessageService.wake(tabId, type).catch(error => {
      console.warn('[TabMessages] wake-failed tab=' + tabId + ' reason=' + type + ' error=' + error.message);
    });
  }
  const loggable = BCAST_LOG_TYPES.has(type);
  if (type === 'busy' || type === 'done' || type === 'snapshot' || type === 'background-work') {
    void processOrchestrationLifecycle(tabId, payload);
  }
  if (hasTabSubscribers(tabId) && (type === 'snapshot' || type === 'bridge-update')) {
    // A read source may become a writer/child while the phone stays connected.
    // Reconcile the existing consumer; do not wait for reopen or start a parser.
    void startTranscriptSubscriptionForTab(tabId);
    void startClaudeTabWatcher(tabId);
  }
  const runId = externalRunByTabId.get(tabId);
  const run = runId ? externalRuns.get(runId) : null;
  try {
    if (run) {
      if (type === 'busy') {
        if (payload.busy) {
          run.activityRevision = (run.activityRevision || 0) + 1;
          run.latestBusyScope = { sessionId: payload.sessionId, turnId: payload.turnId };
          run.cleanupCancelled = true;
          clearExternalRunTimer(run, 'stopTimer');
          clearExternalRunTimer(run, 'closeTimer');
        }
        if (!run.completionStamp) {
          run.status = payload.busy ? 'running' : 'idle';
          setExternalRunMeta(tabId, { status: run.status, sessionId: payload.sessionId || run.sessionId || null });
        }
      } else if (type === 'done') {
        if (payload.capacitySurfaceOnly !== true) {
          run.observedTerminal = payload;
          void refreshExternalRunCompletion(run);
        }
      } else if (type === 'message' && run.status === 'sending') {
        run.status = 'running';
        setExternalRunMeta(tabId, { status: 'running', sessionId: run.sessionId || null });
      }
    }
  } catch (e) {
    console.warn('[WebBcast:MetaError] tab=' + shortId(tabId, 12) + ' type=' + type + ' run=' + (runId || '-') + ' error=' + (e?.message || String(e)));
  }
  const set = subscribers.get(tabId);
  if (!set || set.size === 0) {
    if (loggable || type === 'message') console.log('[WebBcast:DROP] tab=' + shortId(tabId, 12) + ' type=' + type + summarizeBroadcastPayload(payload) + ' noSubscribers (registered=' + subscribers.size + ')');
    return;
  }
  const envelope = tabId === PROJECT_ACTIVITY_TOPIC ? payload : { tabId, ...payload };
  const msg = JSON.stringify(envelope);
  let sent = 0;
  const dead = [];
  for (const sink of set) {
    try {
      if (sink.isAlive()) { sink.send(msg); sent++; }
      else dead.push(sink);
    } catch { dead.push(sink); }
  }
  for (const d of dead) set.delete(d);
  if (dead.length) {
    releaseClaudeWatchersIfOrphan();
    releaseTranscriptSubscriptionsIfOrphan();
  }
  if (loggable || type === 'message' || dead.length) {
    console.log('[WebBcast:SEND] tab=' + shortId(tabId, 12) + ' type=' + type + ' to=' + sent + '/' + (sent + dead.length) + summarizeBroadcastPayload(payload) + (dead.length ? ' (pruned ' + dead.length + ' dead)' : ''));
  }
}

function broadcastProjectActivity(reason = 'event') {
  // recordActivity already publishes this event for open/close/teardown.
  // Read that owner here; do not alter its capture logic or create a new clock.
  for (const tabId of subscribers.keys()) {
    if (tabId !== PROJECT_ACTIVITY_TOPIC) publishTabTiming(tabId, reason);
  }
  const set = subscribers.get(PROJECT_ACTIVITY_TOPIC);
  if (!set || set.size === 0) return false;
  const payload = projectActivitySnapshot(reason);
  webBroadcast(PROJECT_ACTIVITY_TOPIC, payload);
  return true;
}

// ───────── JSONL tail-watchers for PTY+Claude tabs ─────────
// SDK tabs get their live events via webBroadcast() called from main on each
// SDK message. PTY+Claude tabs write to a JSONL file (~/.claude/projects/...) —
// the mobile client needs the same {type:'message'} stream. We fs.watch the
// resolved JSONL path and incrementally read new bytes.
//
// Activated on first WS subscribe to a tabId whose commandType==='claude'.
// Released when all subscribers for that tab disconnect.
//
// tabId -> { sessionId, filePath, offset, watcher, leftover, timer, inflight, attempts }
const claudeTabWatchers = new Map();
const claudeTabDirectoryWatchers = new Map();
// Tabs whose WS is subscribed but Claude hasn't produced a sessionId yet.
// When sessionId arrives via main's `claude:session-detected` IPC path we
// promote them to live watchers — no polling, no timeouts. The set is also
// consulted on bridgeReady so we don't miss a sessionId that materialised
// before subscribe.
const claudeTabWatcherPending = new Set();

// Called from main.js whenever a claude session id is freshly attached to a
// tab (Bridge:Fresh / Bridge:PID / explicit resume / fork). Promotes any
// pending watcher for this tabId from "waiting for sessionId" → live fs.watch.
// Idempotent: a no-op if no pending entry exists.
function notifyClaudeSessionAvailable(tabId) {
  if (!claudeTabWatcherPending.has(tabId)) {
    console.log('[ClaudeWatcher] notify ignored tabId=' + shortId(tabId, 12) + ' no pending watcher');
    return;
  }
  console.log('[ClaudeWatcher] notify promote tabId=' + shortId(tabId, 12));
  claudeTabWatcherPending.delete(tabId);
  startClaudeTabWatcher(tabId).catch((e) => {
    console.warn('[ClaudeWatcher] late-start failed for', shortId(tabId, 12), e?.message);
  });
}

async function startTranscriptSubscriptionForTab(tabId) {
  return tabTranscriptSubscriptions?.reconcile(tabId);
}

async function startClaudeTabWatcher(tabId) {
  if (!hasTabSubscribers(tabId)) return;
  let resolved;
  try {
    resolved = await resolveClaudeWatcherRuntime({
      tabId,
      readRendererStatus: id => bridgeRequest('getClaudeTabStatus', { tabId: id }, 2000),
      readMainRuntime: typeof readAgentRuntimeSnapshot === 'function'
        ? id => readAgentRuntimeSnapshot(id)
        : null,
      isCurrent: () => hasTabSubscribers(tabId),
    });
  } catch (e) {
    console.warn('[ClaudeWatcher] status failed tabId=' + shortId(tabId, 12) + ' err=' + (e?.message || e));
    return; // tab not open in renderer or bridge unavailable — skip
  }
  if (resolved.cancelled || !hasTabSubscribers(tabId)) return;
  const status = resolved.watcherStatus;
  if (resolved.mainError) {
    console.warn('[ClaudeWatcher] current runtime unavailable tabId=' + shortId(tabId, 12)
      + ' err=' + (resolved.mainError?.message || resolved.mainError)
      + ' action=watch-without-lifecycle-snapshot');
  }
  const existing = claudeTabWatchers.get(tabId);
  if (existing && existing.sessionId === status?.sessionId) return;
  if (existing) stopClaudeTabWatcher(tabId);
  if (status?.commandType !== 'claude') {
    if (claudeTabWatcherPending.has(tabId)) stopClaudeTabWatcher(tabId);
    console.log('[ClaudeWatcher] skip tabId=' + shortId(tabId, 12) + ' command=' + (status?.commandType || '-') + ' tool=' + (status?.toolType || '-'));
    return; // not a PTY+Claude tab
  }
  if (!status.sessionId || !findSessionFile) {
    // No sessionId yet — Claude is still booting. Park the tabId; main.js will
    // call notifyClaudeSessionAvailable(tabId) the moment session-detected
    // fires (deterministic event from SessionBridge — never polled).
    claudeTabWatcherPending.add(tabId);
    console.log('[ClaudeWatcher] parked tabId=' + shortId(tabId, 12) + ' waiting for sessionId event findSessionFile=' + !!findSessionFile);
    return;
  }
  const found = findSessionFile(status.sessionId, status.cwd);
  if (!found) {
    // SessionId is known but the JSONL file isn't on disk yet — Claude wrote
    // the bridge.json moments before the first JSONL line landed (it batches
    // initial writes). Watch the parent directory ONCE for the file to
    // appear, then promote. No polling — fs.watch on the dir is event-driven.
    if (claudeTabWatcherPending.has(tabId)) {
      console.log('[ClaudeWatcher] still-pending tabId=' + shortId(tabId, 12) + ' sid=' + shortId(status.sessionId));
      return;
    }
    claudeTabWatcherPending.add(tabId);
    let dirWatcher = null;
    const tryPromote = () => {
      if (!hasTabSubscribers(tabId)) { stopClaudeTabWatcher(tabId); return; }
      if (findSessionFile(status.sessionId, status.cwd)) {
        try { dirWatcher?.close(); } catch {}
        claudeTabDirectoryWatchers.delete(tabId);
        console.log('[ClaudeWatcher] dir-promote tabId=' + shortId(tabId, 12) + ' sid=' + shortId(status.sessionId));
        claudeTabWatcherPending.delete(tabId);
        startClaudeTabWatcher(tabId).catch(() => {});
      }
    };
    try {
      // Watch the projects/ root since cwd-encoded subdir may itself not
      // exist yet for a brand-new project.
      const watchDir = require(path.join(srcMainDir, 'claude-paths')).claudeProjectsDir();
      dirWatcher = fs.watch(watchDir, { recursive: true }, (_, fname) => {
        if (fname && fname.includes(status.sessionId)) tryPromote();
      });
      claudeTabDirectoryWatchers.set(tabId, dirWatcher);
    } catch (e) {
      console.warn('[ClaudeWatcher] dir-watch failed tabId=' + shortId(tabId, 12) + ' sid=' + shortId(status.sessionId) + ' err=' + (e?.message || e));
    }
    return;
  }
  const filePath = found.filePath;
  // Start at current EOF when there's already some history (user got it via
  // /history REST endpoint on chat open). For brand-new sessions whose first
  // JSONL bytes haven't been written yet, the file would have been "not found"
  // above; here size >= 1 record means /history already returned it.
  // Always-from-EOF policy avoids duplicate messages on the mobile reducer
  // (which would still dedupe by uuid, but at the cost of unnecessary WS
  // bytes). The race window where mobile has loaded /history but JSONL grew
  // between that read and our fs.stat is small (~ms); any messages from that
  // window arrive via the next turn's WS push because reducer.apply is
  // idempotent on uuid.
  let offset = 0;
  try { offset = fs.statSync(filePath).size; } catch (e) {
    console.warn('[ClaudeWatcher] stat failed tabId=' + shortId(tabId, 12) + ' file=' + filePath + ' err=' + (e?.message || e));
    return;
  }
  const entry = {
    sessionId: status.sessionId,
    filePath,
    offset,
    watcher: null,
    timer: null,
    inflight: false,        // guard against re-entrant readDelta
    leftover: '',           // partial last line carried to next read
  };

  // The renderer answer above is allowed to locate the JSONL file, but it is
  // not lifecycle authority. During startup it may have been captured before
  // the main-owned settings transaction committed ready. Publishing it here
  // used to create active→starting with a larger public revision. Only the
  // coherent main snapshot may describe lifecycle; if that read failed, keep
  // the watcher alive and wait for the next authoritative event/read.
  if (resolved.publicSnapshot) webBroadcast(tabId, resolved.publicSnapshot);
  else console.log('[ClaudeWatcher] initial lifecycle snapshot skipped tabId='
    + shortId(tabId, 12) + ' reason=' + (resolved.reason || 'main-runtime-unavailable'));

  const readDelta = () => {
    // Inflight guard: fs.watch on macOS can fire multiple times between our
    // scheduleRead debounce and stream.on('end'). Without this, two concurrent
    // reads share entry.offset and skip bytes (same shape as bug in
    // fix-incremental-reader-race.md::Race condition in Case 2).
    if (entry.inflight) {
      console.log('[ClaudeWatcher:Delta] skip-inflight tab=' + shortId(tabId, 12) + ' offset=' + entry.offset);
      return;
    }
    let size;
    try { size = fs.statSync(filePath).size; } catch (e) {
      console.warn('[ClaudeWatcher:Delta] stat failed tab=' + shortId(tabId, 12) + ' err=' + (e?.message || e));
      return;
    }
    if (size <= entry.offset) {
      // File got truncated (e.g. fork rewrite reusing same sessionId, or
      // session rewrite via `claude:fork-session-file`). Reset to head and
      // also drop leftover — old position invalidates partial line buffer.
      if (size < entry.offset) {
        console.log('[ClaudeWatcher:Delta] truncated tab=' + shortId(tabId, 12) + ' oldOffset=' + entry.offset + ' newSize=' + size);
        entry.offset = 0;
        entry.leftover = '';
      }
      return;
    }
    entry.inflight = true;
    const startOffset = entry.offset; // snapshot before yielding
    const stream = fs.createReadStream(filePath, { start: startOffset, end: size - 1 });
    let buf = entry.leftover;
    entry.leftover = ''; // carry forward only what survives this pass
    stream.on('data', (chunk) => { buf += chunk.toString('utf-8'); });
    stream.on('end', () => {
      entry.offset = size;
      // Last fragment may not end with \n — Claude's append could land
      // mid-record between two writes. Defer to next readDelta.
      const endsWithNewline = buf.endsWith('\n');
      const lines = buf.split('\n');
      if (!endsWithNewline) entry.leftover = lines.pop() || '';
      let sentRecords = 0;
      let parseErrors = 0;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch {
          // Malformed JSON in a complete line is a real corruption — log
          // (deduped) and skip. NOT the partial-line case above.
          parseErrors += 1;
          continue;
        }
        // Mirror SDK WS protocol — mobile reducer expects { type:'message', message: inner }.
        // The inner record is what JSONL stores: { type:'user'|'assistant'|..., message:..., uuid, ... }.
        webBroadcast(tabId, { type: 'message', sessionId: parsed.sessionId || status.sessionId, message: parsed });
        sentRecords += 1;
      }
      console.log('[ClaudeWatcher:Delta] tab=' + shortId(tabId, 12) +
        ' sid=' + shortId(status.sessionId) +
        ' bytes=' + (size - startOffset) +
        ' range=' + startOffset + '..' + size +
        ' lines=' + lines.filter(Boolean).length +
        ' sent=' + sentRecords +
        ' parseErrors=' + parseErrors +
        ' leftover=' + entry.leftover.length);
      entry.inflight = false;
      // If fs.stat shows growth that happened DURING our read, schedule once
      // more so we don't miss bytes flushed between stat and our consumption.
      try {
        const nowSize = fs.statSync(filePath).size;
        if (nowSize > entry.offset) scheduleRead();
      } catch {}
    });
    stream.on('error', (e) => {
      entry.inflight = false;
      console.warn('[ClaudeWatcher:Delta] read error tab=' + shortId(tabId, 12) + ' err=' + (e?.message || e));
    });
  };

  // Debounced re-read to coalesce rapid writes (Claude flushes JSONL in bursts).
  const scheduleRead = () => {
    if (entry.timer) return;
    entry.timer = setTimeout(() => { entry.timer = null; readDelta(); }, 60);
  };

  try {
    entry.watcher = fs.watch(filePath, () => {
      console.log('[ClaudeWatcher:FS] change tab=' + shortId(tabId, 12) + ' offset=' + entry.offset);
      scheduleRead();
    });
  } catch (e) {
    console.warn('[ClaudeWatcher] fs.watch failed for', filePath, e.message);
    return;
  }
  claudeTabWatchers.set(tabId, entry);
  console.log('[ClaudeWatcher] started tabId=' + shortId(tabId, 12) + ' sid=' + shortId(status.sessionId) + ' status=' + (status.status || '-') + ' file=' + filePath + ' startOffset=' + offset);
  // Immediate read once — covers the race where Claude appended bytes between
  // our fs.statSync(filePath).size above and fs.watch arming. Subsequent
  // growth is caught by the watcher itself; offset guards against duplicates.
  scheduleRead();
}

function stopClaudeTabWatcher(tabId) {
  // Drop pending-promotion slot so a late session-detected event doesn't
  // try to start a watcher for a tab no one is watching anymore.
  claudeTabWatcherPending.delete(tabId);
  try { claudeTabDirectoryWatchers.get(tabId)?.close(); } catch {}
  claudeTabDirectoryWatchers.delete(tabId);
  const entry = claudeTabWatchers.get(tabId);
  if (!entry) return;
  try { entry.watcher?.close(); } catch {}
  if (entry.timer) clearTimeout(entry.timer);
  claudeTabWatchers.delete(tabId);
  console.log('[ClaudeWatcher] stopped tabId=' + shortId(tabId, 12) + ' sid=' + shortId(entry.sessionId) + ' offset=' + entry.offset);
}

function attachWebSocket(server, sdkSessions) {
  if (!WebSocketServer) {
    console.warn('[WebServer] `ws` package not installed — WS streaming disabled');
    return;
  }
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const parsed = url.parse(req.url, true);
    const remote = (socket.remoteAddress || '?') + ':' + (socket.remotePort || '?');
    console.log('[WebWS:Upgrade] path=' + parsed.pathname + ' tabId=' + String(parsed.query.tabId || '').slice(-12) + ' from=' + remote + ' tokenLen=' + String(parsed.query.token || '').length);
    if (parsed.pathname !== '/ws') {
      console.log('[WebWS:Upgrade:REJECT] bad path ' + parsed.pathname);
      socket.destroy();
      return;
    }
    if (parsed.query.token !== token) {
      console.log('[WebWS:Upgrade:REJECT] token mismatch (got len=' + String(parsed.query.token || '').length + ', expected len=' + String(token || '').length + ')');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tabId = parsed.query.tabId;
      const sink = wsSink(ws);
      ws.tabId = tabId || null;
      if (tabId) {
        subscribe(tabId, sink);
        // Send initial snapshot of live state — what the phone needs to render
        // immediately without waiting for the next message.
        sendInitialSnapshot(tabId, sink, sdkSessions).then(() => sendHistoryFreshnessSnapshot(tabId, sink)).catch(() => {});
        // Start fs-watch on PTY+Claude tab's JSONL (no-op for SDK tabs).
        startClaudeTabWatcher(tabId).catch(() => {});
        startTranscriptSubscriptionForTab(tabId).catch(() => {});
      }
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'subscribe' && msg.tabId) {
            subscribe(msg.tabId, sink);
            sendInitialSnapshot(msg.tabId, sink, sdkSessions).then(() => sendHistoryFreshnessSnapshot(msg.tabId, sink)).catch(() => {});
            startClaudeTabWatcher(msg.tabId).catch(() => {});
            startTranscriptSubscriptionForTab(msg.tabId).catch(() => {});
          }
        } catch {}
      });
      ws.on('close', () => { unsubscribeAll(sink); releaseClaudeWatchersIfOrphan(); releaseTranscriptSubscriptionsIfOrphan(); });
      ws.on('error', () => { unsubscribeAll(sink); releaseClaudeWatchersIfOrphan(); releaseTranscriptSubscriptionsIfOrphan(); });
    });
  });
}

// ───────── lifecycle ─────────

function start({
  tabWorkContext: tabWorkContextInstance,
  projectCardSignals: projectCardSignalsInstance,
  mobileAttachmentAssetStore: mobileAttachmentAssetStoreInstance,
  sdkSessions,
  agentSendReceiptStore: agentSendReceiptStoreFn,
  agentSendReceiptStartupReady: agentSendReceiptStartupReadyFn,
  cancelAgentSend: cancelAgentSendFn,
  computeActiveLoaders: computeFn,
  computeProjectActivity: computeProjectActivityFn,
  readAgentTabTiming: readAgentTabTimingFn,
  readAgentUsage: readAgentUsageFn,
  readCodexAuthProfile: readCodexAuthProfileFn,
  startupInterruptedAgentSnapshot: startupInterruptedSnapshotFn,
  answerClaudeQuestion: answerFn,
  getClaudePendingQuestion: getQFn,
  transcriptService: transcriptServiceFn,
  savedHistoryRuntime,
  resolveCodexRuntimeSessionInfo: resolveCodexRuntimeFn,
  resolveCodexRuntimeProjectionBatch: resolveCodexRuntimeProjectionBatchFn,
  readCodexNativeRewindState: readCodexNativeRewindStateFn,
  recoverCodexRewindPostEnter: recoverCodexRewindPostEnterFn,
  readCodexRewindPostEnterResult: readCodexRewindPostEnterResultFn,
  resolveAgentToolType: resolveAgentToolTypeFn,
  getAgentTurnResult: getAgentTurnResultFn,
  getAgentExecutionContext: getAgentExecutionContextFn,
  readAgentLifecycleIdentity: readAgentLifecycleIdentityFn,
  readAgentStartReadiness: readAgentStartReadinessFn,
  readAgentRuntimeSnapshot: readAgentRuntimeSnapshotFn,
  codexGoalActions: codexGoalActionsValue,
  stopAgentProcess: stopAgentProcessFn,
  readAgentParams: readAgentParamsFn,
  agentParamsService: agentParamsServiceValue,
  registerTaskCompletionIntent: registerTaskCompletionIntentFn,
  e2eBoundaryTestGate: e2eBoundaryTestGateFn,
  agentSendBridgeTimeoutMs: agentSendBridgeTimeoutMsFn,
  projectPromptCatalog: projectPromptCatalogFn,
  savedPromptService: savedPromptServiceFn,
  systemPromptService: systemPromptServiceFn,
}) {
  if (httpServer) {
    console.log('[WebServer] already started state=' + webServerServiceHealth().state);
    return;
  }
  if (!sdkSessions) throw new Error('start({sdkSessions}) — Map of live SDK sessions required');
  tabMessageSdkSessions = sdkSessions;
  tabWorkContext = tabWorkContextInstance || null;
  projectCardSignals = projectCardSignalsInstance || null;
  mobileAttachmentAssetStore = mobileAttachmentAssetStoreInstance || null;
  agentSendReceiptStore = agentSendReceiptStoreFn || null;
  sendQueueRecoveryReady = false;
  if (agentSendReceiptStore?.subscribe) {
    agentSendQueue = new AgentSendQueue({ store: agentSendReceiptStore,
      ready: () => sendQueueRendererReady && sendQueueRecoveryReady,
      cancelAttempt: record => cancelAgentSendFn?.(record),
      admit: async request => {
        // Independent delegated runs still need their own turn. Ordinary
        // prompts/notifications may steer streaming; a delayed delegation may
        // not silently become steering just because it waited in this backlog.
        if (request.sendSurface !== 'orchestration') return true;
        const status = await resolveAgentSessionInfo(request.tabId, 2000, {
          onLateStatus: () => agentSendQueue?.notifyRuntime(request.tabId),
        });
        return resolveOrchestrationDeliveryAdmission(status).canDispatch;
      },
      execute: async (request, scope) => {
        const receipt = await runPreparedAgentSendScenario({ ...request, applicationQueueExecution: true,
          sendRequestFingerprint: scope.requestFingerprint,
          ...(scope.expectedTarget ? { expectedTarget: scope.expectedTarget } : {}),
          ...(request.restoreClosedTab === true ? {
            prepareSend: () => ensureExplicitAgentTabOpen(request.tabId,
              findOrchestrationTabDescriptor(request.tabId) ? null : findRestorableAgentTabDescriptor(request.tabId)),
          } : {}),
        });
        tabWorkContext?.settle(request.tabId, request.handoffId, receipt);
        return receipt;
      },
      publish: record => {
        if (record.state === 'not-submitted' && !record.attemptId) {
          tabWorkContext?.settle(record.tabId, record.handoffId, record.receipt);
        }
        // Live receipts must carry the same exact image proof as the bounded
        // list IPC. Otherwise a mounted local card stays pathless until remount.
        const rendererRecord = { ...record, imagePresentation: imagePresentationFromReceipt(record) };
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('agent:send-queue-receipt', rendererRecord);
        }
        // Remote clients already own the authored prompt. Wake their exact
        // receipt reader without resending every context chip/image snapshot
        // over SSE on each transition.
        const receipt = publicAgentSendReceipt(record);
        webBroadcast(record.tabId, { type: 'send-receipt', receipt: {
          tabId: record.tabId, handoffId: record.handoffId, operationKey: record.operationKey,
          attemptId: record.attemptId, status: receipt.status, receiptState: record.state,
          applicationQueue: record.applicationQueue, submitted: receipt.submitted,
          providerQueueAccepted: receipt.providerQueueAccepted === true,
          exactAuditConfirmed: receipt.exactAuditConfirmed === true,
        } });
      },
    });
  }
  agentSendReceiptStartupReady = agentSendReceiptStartupReadyFn
    ? Promise.resolve(agentSendReceiptStartupReadyFn).catch((error) => ({
      ready: false,
      error: error?.message || String(error),
    }))
    : Promise.resolve({ ready: true });
  const startupQueue = agentSendQueue;
  void agentSendReceiptStartupReady.then(result => {
    if (agentSendQueue !== startupQueue || result?.ready === false) return;
    sendQueueRecoveryReady = true;
    agentSendQueue?.resume();
  });
  if (agentSendReceiptStore && !agentSendReceiptStartupReadyFn) {
    const reconciled = agentSendReceiptStore.reconcileStartup();
    if (reconciled?.changed) {
      console.warn('[AgentSendReceipt] startup reconciled active attempts=' + reconciled.changed);
    }
  }
  computeActiveLoaders = computeFn || null;
  computeProjectActivity = computeProjectActivityFn || null;
  readAgentTabTiming = readAgentTabTimingFn || null;
  readAgentUsage = readAgentUsageFn || null;
  readCodexAuthProfile = readCodexAuthProfileFn || null;
  startupInterruptedSnapshot = startupInterruptedSnapshotFn || null;
  answerClaudeQuestion = answerFn || null;
  getClaudePendingQuestion = getQFn || null;
  transcriptService = transcriptServiceFn || null;
  publicHistoryFreshness = typeof transcriptService?.getHistoryFreshnessContext === 'function'
    ? new HistoryFreshness({ readContext: (scope, ids) => transcriptService.getHistoryFreshnessContext(scope, ids) }) : null;
  if (transcriptService) {
    const service = transcriptService; // cleanup cannot target a later server
    tabTranscriptSubscriptions = new TabTranscriptSubscriptions({
      hasConsumers: hasTabSubscribers,
      readSession: tabId => resolveHistorySessionInfo(tabId, 2000),
      subscribe: request => service.subscribe(request),
      unsubscribe: request => service.unsubscribe(request),
      onError: error => console.warn('[TranscriptWebSub] reconcile failed:', error.message),
    });
  }
  releaseTimingBindingObserver = observeHistoryResponseTimingBindings(detail => {
    if (detail.tabId) publishTabTiming(detail.tabId, 'history-response-bound', true);
  });
  if (savedHistoryRuntime && transcriptService) {
    conversationOwners = savedHistoryRuntime.owner || null;
    const { SavedHistoryOperations } = require(path.join(srcMainDir, 'saved-history-operation'));
    const { PromptQueueAssetStore } = require(path.join(srcMainDir, 'prompt-queue-assets'));
    const { materializeClaudeSavedHistoryImages } = require(path.join(srcMainDir, 'claude-saved-history-images'));
    const historyAssets = new PromptQueueAssetStore({ rootDir: path.join(app.getPath('userData'), 'prompt-queue-assets') });
    savedHistoryOperations = new SavedHistoryOperations({
      db: require(path.join(srcMainDir, 'project-manager')).db,
      transcript: transcriptService, runtime: savedHistoryRuntime,
      claude: claudeDataApi?.loadOperationSource && claudeDataApi?.deleteRange ? {
        ...claudeDataApi,
        materializeImages: (record, refs) => materializeClaudeSavedHistoryImages(record, refs, historyAssets),
      } : null,
      resolveSession: tabId => resolveHistorySessionInfo(tabId, 5000),
      dispatch: (action, payload) => bridgeRequest(action, {
        ...payload, targetProjectId: findOrchestrationTabDescriptor(payload.tabId)?.projectId || null,
      }, 180_000),
      deleteRange: params => codexDataApi.deleteCodexRange(params),
      buildTimeline: buildCodexTimeline,
      broadcast: webBroadcast,
    });
    const { InboxSavedHistoryOperations } = require(path.join(srcMainDir, 'inbox-saved-history-operation'));
    inboxSavedHistoryOperations = new InboxSavedHistoryOperations({
      db: require(path.join(srcMainDir, 'project-manager')).db,
      executor: savedHistoryOperations, transcript: transcriptService,
      getReceipt: runId => agentSendReceiptStore?.get('inbox:' + runId) || null,
      reservedTabId: reservedInboxTabId, ensureOpen: ensureExplicitAgentTabOpen,
      resolveSession: tabId => resolveHistorySessionInfo(tabId, 5000),
      cleanup: { claim: claimInboxHistoryCleanup },
      readNativeState: tabId => readCodexNativeRewindState?.(tabId),
    });
    if (!savedHistoryIpcRegistered) {
      ipcMain.handle('saved-history:step', (_event, request) => savedHistoryOperations.step(request));
      ipcMain.handle('saved-history:get', (_event, request) => savedHistoryOperations.read(request.tabId, request.operationId));
      savedHistoryIpcRegistered = true;
    }
  }
  ensureOrchestrationProofCoordinators();
  resolveCodexRuntimeSessionInfo = resolveCodexRuntimeFn || null;
  resolveCodexRuntimeProjectionBatch = resolveCodexRuntimeProjectionBatchFn || null;
  readCodexNativeRewindState = readCodexNativeRewindStateFn || null;
  recoverCodexRewindPostEnter = recoverCodexRewindPostEnterFn || null;
  readCodexRewindPostEnterResult = readCodexRewindPostEnterResultFn || null;
  resolveAgentToolType = resolveAgentToolTypeFn || null;
  getAgentTurnResult = getAgentTurnResultFn || null;
  getAgentExecutionContext = getAgentExecutionContextFn || null;
  readAgentLifecycleIdentity = readAgentLifecycleIdentityFn || null;
  readAgentRuntimeSnapshot = readAgentRuntimeSnapshotFn || null;
  codexGoalActions = codexGoalActionsValue || null;
  stopAgentProcess = stopAgentProcessFn || null;
  readAgentParams = readAgentParamsFn || null;
  agentParamsService = agentParamsServiceValue || null;
  readAgentStartReadiness = readAgentStartReadinessFn || null;
  registerTaskCompletionIntent = registerTaskCompletionIntentFn || null;
  e2eBoundaryTestGate = e2eBoundaryTestGateFn || null;
  projectPromptCatalog = projectPromptCatalogFn || null;
  savedPromptService = savedPromptServiceFn || null;
  systemPromptService = systemPromptServiceFn || null;
  agentSendBridgeTimeoutMs = Math.max(
    1,
    Number(agentSendBridgeTimeoutMsFn) || 60_000,
  );
  token = loadOrCreateToken();
  webServerState = 'starting';
  webServerStartRequestedAt = Date.now();
  webServerListeningAt = null;
  webServerStoppedAt = null;
  webServerLastRequestAt = null;
  webServerLastRequest = null;
  webServerRequestCount = 0;
  webServerLastError = null;
  webServerBindConflicts = [];
  resolvedPort = PORT_PREFERRED;
  console.log('[WebServer:Health] start-request pid=' + process.pid + ' preferredPort=' + PORT_PREFERRED
    + ' instance=' + webServerInstanceId);
  registerBridgeReplyHandler();
  const messageServiceForStart = getTabMessageService();
  void agentSendReceiptStartupReady.then(() => messageServiceForStart.initialize())
    .catch(error => console.warn('[TabMessages] startup-failed error=' + error.message));
  void getOrchestrationRunStore().initialize()
    .then(() => reconcileActiveOrchestrations())
    .catch((error) => console.warn('[Orchestration] startup recovery failed:', error?.message || error));

  httpServer = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname.startsWith('/api/') || parsed.pathname === '/api') {
      webServerLastRequestAt = Date.now();
      webServerLastRequest = String(req.method || 'GET') + ' ' + parsed.pathname;
      webServerRequestCount += 1;
      handleApi(req, res, parsed, sdkSessions).catch((err) => {
        console.error('[WebServer] handler error:', err);
        sendJson(res, 500, { error: String(err.message) });
      });
      return;
    }
    serveStatic(req, res, parsed);
  });

  attachWebSocket(httpServer, sdkSessions);

  // Port-walk fallback. listen() emits 'error' with EADDRINUSE if port is taken.
  // Catch it, increment, retry — up to PORT_MAX. The successful port is stored
  // in `resolvedPort` and published via discovery file so renderer (StatusBar
  // mobile-web chip) reads the real port instead of the hardcoded 7878.
  const tryListen = (p) => {
    httpServer.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && p < PORT_MAX) {
        console.warn('[WebServer] port ' + p + ' in use, trying ' + (p + 1));
        webServerBindConflicts.push(p);
        webServerLastError = { code: 'EADDRINUSE', message: 'port in use', port: p, at: Date.now() };
        console.warn('[WebServer:Health] bind-conflict pid=' + process.pid + ' port=' + p + ' next=' + (p + 1));
        // listen() emits one error per attempt; recreate listener for retry
        setImmediate(() => tryListen(p + 1));
        return;
      }
      webServerState = 'failed';
      webServerLastError = {
        code: String(err?.code || 'server_error'),
        message: String(err?.message || err || 'unknown').replace(/\s+/g, ' ').slice(0, 240),
        port: p,
        at: Date.now(),
      };
      console.error('[WebServer] server error:', err.message);
      console.error('[WebServer:Health] listen-failed pid=' + process.pid + ' port=' + p
        + ' code=' + webServerLastError.code + ' error=' + webServerLastError.message);
    });
    httpServer.listen(p, '0.0.0.0', () => {
      resolvedPort = p;
      webServerState = 'listening';
      webServerListeningAt = Date.now();
      webServerLastError = null;
      writeWebServerDiscovery();
      const ip = getLanIp();
      console.log('[WebServer] listening on http://' + ip + ':' + p + ' (pid=' + process.pid + ')');
      console.log('[WebServer:Health] listening pid=' + process.pid + ' preferredPort=' + PORT_PREFERRED
        + ' resolvedPort=' + p + ' shifted=' + (p !== PORT_PREFERRED)
        + ' conflicts=' + (webServerBindConflicts.join(',') || '-'));
      console.log('[WebServer] token (' + TOKEN_PATH + '): ' + token);
      console.log('[WebServer] mobile URL example: http://' + ip + ':' + p + '/?token=' + token);
    });
  };
  tryListen(PORT_PREFERRED);
}

function writeWebServerDiscovery() {
  try {
    fs.mkdirSync(DISCOVERY_DIR, { recursive: true });
    fs.writeFileSync(DISCOVERY_FILE, JSON.stringify({
      port: resolvedPort,
      pid: process.pid,
      lanIp: getLanIp(),
      updatedAt: Date.now(),
      instanceId: webServerInstanceId,
      preferredPort: PORT_PREFERRED,
      state: webServerState,
      listeningAt: webServerListeningAt,
    }));
  } catch (e) { console.warn('[WebServer:Discovery] write failed:', e.message); }
}

function stop() {
  const serverToClose = httpServer;
  let serverClosePromise = Promise.resolve();
  const externalResearchStopPromise = externalResearchCoordinator
    ? externalResearchCoordinator.stop().catch(() => {})
    : Promise.resolve();
  externalResearchCoordinator = null;
  scExternalResearchClient = null;
  webServerState = 'stopping';
  console.log('[WebServer:Health] stop-request pid=' + process.pid + ' listening=' + !!serverToClose?.listening);
  if (orchestrationPolicyTimer) clearTimeout(orchestrationPolicyTimer);
  orchestrationPolicyTimer = null;
  if (orchestrationResultProofCoordinator) {
    void orchestrationResultProofCoordinator.stop('web-server-stop');
    orchestrationResultProofCoordinator = null;
  }
  if (orchestrationSourceProofCoordinator) {
    void orchestrationSourceProofCoordinator.stop('web-server-stop');
    orchestrationSourceProofCoordinator = null;
  }
  orchestrationCompletionTrailing.clear();
  if (wss) try { wss.close(); } catch {}
  if (serverToClose) {
    serverClosePromise = new Promise((resolve) => {
      try {
        serverToClose.close(() => resolve());
        serverToClose.closeIdleConnections?.();
      } catch {
        resolve();
      }
    });
  }
  try { fs.unlinkSync(DISCOVERY_FILE); } catch {}
  void tabTranscriptSubscriptions?.stop();
  tabTranscriptSubscriptions = null;
  releaseTimingBindingObserver?.(); releaseTimingBindingObserver = null;
  readAgentTabTiming = null;
  readAgentUsage = null;
  readCodexAuthProfile = null;
  conversationOwners = null;
  publicTimingSnapshots.clear();
  publicHistoryRevisions.clear();
  publicHistoryFreshness = null;
  for (const tabId of new Set([...claudeTabWatchers.keys(), ...claudeTabWatcherPending])) stopClaudeTabWatcher(tabId);
  httpServer = null;
  webServerState = 'stopped';
  webServerStoppedAt = Date.now();
  console.log('[WebServer:Health] stopped pid=' + process.pid + ' requests=' + webServerRequestCount);
  wss = null;
  computeActiveLoaders = null;
  computeProjectActivity = null;
  startupInterruptedSnapshot = null;
  answerClaudeQuestion = null;
  getClaudePendingQuestion = null;
  transcriptService = null;
  resolveCodexRuntimeSessionInfo = null;
  resolveCodexRuntimeProjectionBatch = null;
  getAgentTurnResult = null;
  getAgentExecutionContext = null;
  readAgentLifecycleIdentity = null;
  readAgentRuntimeSnapshot = null;
  codexGoalActions = null;
  stopAgentProcess = null;
  readAgentParams = null;
  agentParamsService = null;
  readAgentStartReadiness = null;
  registerTaskCompletionIntent = null;
  e2eBoundaryTestGate = null;
  agentSendBridgeTimeoutMs = 60_000;
  for (const pending of pendingBridge.values()) {
    clearTimeout(pending.timer);
    if (pending.lateCleanupTimer) clearTimeout(pending.lateCleanupTimer);
    const error = new Error('Bridge stopped');
    error.code = 'bridge_unavailable';
    error.dispatched = true;
    pending.dispose?.();
    try { pending.onAbort?.(error); } catch {}
    pending.reject?.(error);
  }
  pendingBridge.clear();
  agentSendReceiptRegistry.clear();
  for (const run of externalRuns.values()) {
    clearExternalRunTimer(run, 'stopTimer');
    clearExternalRunTimer(run, 'closeTimer');
  }
  externalRuns.clear();
  externalRunByTabId.clear();
  externalRunByConversationKey.clear();
  publicRuntimeSnapshots.clear();
  // The injected SQLite store deliberately remains intact. Clearing this
  // reference only releases the current server instance; start() receives the
  // same durable authority again after an app/server restart.
  agentSendQueue?.dispose();
  agentSendQueue = null;
  sendQueueRecoveryReady = false;
  agentSendReceiptStore = null;
  agentSendReceiptStartupReady = Promise.resolve({ ready: true });
  tabMessageService?.dispose();
  tabMessageService = null;
  tabMessageSdkSessions = null;
  orchestrationCompletionContentStore = null;
  projectPromptCatalog = null;
  for (const sink of new Set([...subscribers.values()].flatMap(set => [...set]))) sink.close();
  subscribers.clear();
  return Promise.all([serverClosePromise, externalResearchStopPromise]).then(() => undefined);
}

function getInfo() {
  return {
    running: !!httpServer?.listening,
    port: resolvedPort,
    token,
    lanIp: getLanIp(),
    service: webServerServiceHealth(),
  };
}

function updateExternalRunSettings(payload = {}) {
  const tabId = cleanOptionalString(payload.tabId, '');
  const runId = cleanOptionalString(payload.runId, '') || (tabId ? externalRunByTabId.get(tabId) : '');
  const run = runId ? externalRuns.get(runId) : null;
  if (!run?.tabId) return { ok: false, error: 'run not found' };

  if (Object.prototype.hasOwnProperty.call(payload, 'autoStopMs')) {
    run.autoStopMs = clampAutoStopMs(payload.autoStopMs);
  } else {
    run.autoStopMs = clampAutoStopMs(run.autoStopMs);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'autoCloseMs')) {
    run.autoCloseMs = clampAutoCloseMs(payload.autoCloseMs);
  } else {
    run.autoCloseMs = clampAutoCloseMs(run.autoCloseMs);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'collapsed')) {
    run.collapsed = payload.collapsed === true;
  }

  clearExternalRunTimer(run, 'stopTimer');
  clearExternalRunTimer(run, 'closeTimer');
  run.autoStopAt = null;
  run.autoCloseAt = null;

  const meta = {
    runId: run.runId,
    tabId: run.tabId,
    status: run.status,
    autoStopMs: run.autoStopMs,
    autoStopAt: null,
    autoCloseMs: run.autoCloseMs,
    autoCloseAt: null,
    collapsed: !!run.collapsed,
  };
  setExternalRunMeta(run.tabId, meta);

  if (run.status === 'done' || run.status === 'idle') {
    scheduleExternalRunCompletionTimers(run, 'settings');
  } else if (run.status === 'stopped' || run.status === 'stop_failed') {
    scheduleExternalRunClose(run, 'settings');
  }

  return {
    ok: true,
    runId: run.runId,
    tabId: run.tabId,
    externalRun: {
      ...meta,
      autoStopAt: run.autoStopAt || null,
      autoCloseAt: run.autoCloseAt || null,
    },
  };
}

async function listOrchestrationRunsForTab(tabId) {
  return (await getOrchestrationRunStore().listForTab(tabId)).map(withOrchestrationUrls);
}

async function readOrchestrationSourceCompletionFacts(scope) {
  return getOrchestrationRunStore().sourceCompletionFacts(scope);
}

async function acknowledgeOrchestrationRun(runId, tabId) {
  const run = await getOrchestrationRunStore().acknowledge(runId, tabId);
  if (run) emitOrchestrationRun(run, 'acknowledged');
  return run ? withOrchestrationUrls(run) : null;
}

async function listActiveOrchestrationRuns() {
  return (await getOrchestrationRunStore().listActive()).map(withOrchestrationUrls);
}

async function getOrchestrationSettings() {
  return getOrchestrationRunStore().getSettings();
}

async function updateOrchestrationSettings(patch) {
  const settings = await getOrchestrationRunStore().updateSettings(patch || {});
  ipcMain.emit('codex-capacity-retry:settings-updated', null, settings);
  void scheduleOrchestrationPolicyTimer();
  return settings;
}

async function sendCodexCapacityContinuation({ tabId, sessionId, turnId, generation, handoffId, isCurrent }) {
  const store = getOrchestrationRunStore();
  const runs = await store.listForTab(tabId);
  const run = runs.find(item => item.targetTabId === tabId && item.targetToolType === 'codex'
    && item.sessionId === sessionId && item.targetExecutionContext?.turnId === turnId);
  if (!await isCurrent()) return { submitted: false, error: 'capacity_retry_cancelled' };
  // Atomically arm the next future turn of this exact request. Manual pause
  // intentionally cannot recover failed runs; capacity owns a narrower path.
  if (run) {
    const resumed = await store.resolveRecovery(run.runId, 'codex-capacity-retry', {
      tabId, sessionId, turnId, lifecycleGeneration: generation, handoffId,
    });
    if (resumed?.error || resumed?.run?.resumeAwaitingNewTurn !== true) {
      return { submitted: false, error: resumed?.error || 'capacity_retry_run_not_resumed' };
    }
    await releaseOrchestrationResultProof(run.runId, 'codex-capacity-retry');
    await store.persistStrict();
    emitOrchestrationChanges(resumed.changed, 'codex-capacity-retry');
    void scheduleOrchestrationPolicyTimer();
  }
  return runAgentSendScenario({
    tabId, prompt: 'continue', handoffId, source: 'codex-capacity-retry', queue: true,
    provider: 'codex', sessionId: null, ownership: 'project', requireLive: true,
    expectedTarget: { toolType: 'codex', sessionId, turnId, lifecycleGeneration: generation },
    sendOperationKey: `project:${tabId}:${handoffId}`, sendSurface: 'project-api',
    prepareSend: async () => {
      if (!await isCurrent()) throw Object.assign(new Error('capacity_retry_cancelled'), { code: 'capacity_retry_cancelled', statusCode: 409 });
      return { descriptor: findOrchestrationTabDescriptor(tabId) };
    },
  });
}

module.exports = {
  markSendQueueRendererReady: (ready = true, ownerId = 0) => {
    if (ready) sendQueueRendererOwners.add(ownerId); else sendQueueRendererOwners.delete(ownerId);
    sendQueueRendererReady = sendQueueRendererOwners.size > 0;
    if (sendQueueRendererReady) agentSendQueue?.resume();
  },
  cancelQueuedAgentSends: (tabId, handoffId, options) => (options?.stop
    ? agentSendQueue?.stop(tabId) : agentSendQueue?.cancelWaiting(tabId, handoffId, options))
    || { cancelled: false, count: 0 },
  dismissUnwrittenQueuedSend: (tabId, handoffId) => agentSendQueue?.dismissUnwritten(tabId, handoffId)
    || { cancelled: false, count: 0 },
  releaseQueuedSendPresentation: operationKey => agentSendQueue?.releasePresentation(operationKey),
  queuedSendAssetIds: () => agentSendQueue?.referencedAssetIds() || new Set(),
  applicationQueueInfo: operationKey => {
    const item = agentSendQueue?.item(operationKey);
    return item ? { version: 1, id: item.id, state: item.state, queuedAt: item.created_at } : null;
  },
  projectQueuedSendReceipt: record => agentSendQueue?.projectRecord(record) || record,
  enqueueDesktopAgentPrompt: async input => {
    if (!input?.tabId || !input.handoffId || typeof input.prompt !== 'string'
      || !['claude', 'codex'].includes(input.toolType)) throw new Error('Invalid application send request');
    if (input.ownedAttachments || input.ownedAttachmentProjection) {
      throw new Error('Upload ownership is issued by Main upload admission, not a renderer request');
    }
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > STRUCTURED_AUTHORING_LIMITS.bytes) {
      throw new Error('Send request is too large');
    }
    const settings = input.settingsIntent?.kind === 'explicit-change' ? input.settingsIntent : {};
    return runAgentSendScenario({ ...input, provider: input.toolType,
      model: settings.model, effort: settings.effort, thinking: settings.thinking,
      expectedTarget: input.expectedTarget || (input.sessionId
        ? { toolType: input.toolType, sessionId: input.sessionId } : null),
      sessionId: null,
      sendOperationKey: `history:${input.tabId}:${input.handoffId}`, sendSurface: 'desktop-history',
      ownership: input.returnDraftOnConflict === true ? 'external' : 'project',
      applicationQueueAcceptedResponse: input.source === 'history-panel',
    });
  },
  listTabMessages: async (tabId) => (await getTabMessageService().listForTab(tabId)).map(compactTabMessage),
  getTabMessage: (messageId) => getTabMessageService().getMessage(messageId),
  dismissTabMessage: (tabId, messageId) => {
    const result = getTabMessageService().dismissMessage({ tabId, messageId });
    return { ...result, message: compactTabMessage(result.message) };
  },
  readMobileAttachmentPreview,
  commitSavedHistoryCodexBinding,
  validateSavedHistoryStop,
  validateSavedHistoryResume,
  start,
  stop,
  webBroadcast,
  publishCompletionNotificationChange,
  broadcastProjectActivity,
  getInfo,
  updateExternalRunSettings,
  admitAgentLifecycleLaunch,
  validateOrchestrationAutoStopAuthority,
  listOrchestrationRunsForTab,
  listActiveOrchestrationRuns,
  acknowledgeOrchestrationRun,
  readOrchestrationSourceCompletionFacts,
  getOrchestrationSettings,
  updateOrchestrationSettings,
  coordinateCodexCapacityContinuation,
  sendCodexCapacityContinuation,
  performE2eBoundaryAction,
  performOrchestrationAction,
  handleOrchestrationTabClosed,
  notifyClaudeSessionAvailable,
  sendTabCompletionPush,
  notifyAgentPromptAuditResult,
  notifyAgentTranscriptChanged,
  __testPublicRuntimeSnapshots: {
    normalizeStatus: normalizePublicRuntimeStatus,
    stamp: stampPublicRuntimeSnapshot,
    reset: () => publicRuntimeSnapshots.clear(),
  },
};
