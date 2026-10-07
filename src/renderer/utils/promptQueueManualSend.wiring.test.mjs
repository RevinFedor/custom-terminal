import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { runAgentSendFlow } from './agentSendFlow.mjs';
import { enqueueAgentSendScenario } from './agentSendSequencer.mjs';
import { normalizeAgentSendOutcome } from './agentSendOutcome.mjs';
import * as codexSettings from './codexHistorySettingsPlan.mjs';
import * as localSlash from './codexLocalSlashCommand.mjs';
import * as promptPresentation from './historyPromptPresentation.mjs';
import * as agentLocalCommand from './agentLocalCommand.mjs';
import { planHistoryPromptPresentationDismissal } from './historyPromptPresentationDismissal.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const sourceRules = require('../../main/prompt-queue-source');
const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const main = read('../../main/main.js');
const overlay = read('../components/Workspace/PromptQueueOverlay.tsx');
const history = read('../components/Workspace/HistoryPanel.tsx');
const part = (source, first, next) => {
  const start = source.indexOf(first), end = source.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, first);
  return source.slice(start, end);
};
const compile = source => ts.transpileModule(source.replace(/\bexport /g, ''), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function handoffModule() {
  const exports = {};
  // The real renderer dependencies are ESM. Electron 28's Node 18 cannot
  // synchronously require them from this transpiled CommonJS test wrapper.
  const requireHandoff = id => {
    if (id === './historyPromptPresentation.mjs') return promptPresentation;
    if (id === './agentLocalCommand.mjs') return agentLocalCommand;
    return require(id);
  };
  vm.runInNewContext(ts.transpileModule(read('./historyPromptHandoffs.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: requireHandoff, console, setTimeout, clearTimeout });
  return exports;
}
const noop = () => {};

function harness({ status = 'busy', inputReady = true, pasteResult = null } = {}) {
  const handoffs = handoffModule();
  const handlers = new Map();
  const pasted = [], removed = [], notices = [], calls = [], stages = [], paused = [];
  const item = { id: 'item', text: 'manual Run After message', imagePaths: [], chips: [] };
  const terminal = {};
  const presence = { status, sessionStatus: status, busy: status === 'busy',
    liveLifecycle: status !== 'inactive', inputReady, sessionId: 'writer' };
  const workspace = { tabs: new Map([['T', { codexSessionId: 'writer', cwd: '/fixture' }]]) };
  const state = { openProjects: new Map([['P', workspace]]), clearInterruptedState: noop };
  let replaying = new Set();
  const context = {
    ...sourceRules, ...codexSettings, ...localSlash, ...agentLocalCommand,
    ...require('../../main/agent-send-target-precondition'),
    console: { log() {}, warn() {}, error() {} },
    tabId: 'T', sessionType: 'codex',
    useCallback: fn => fn,
    replayingIdsRef: { current: new Set() },
    setReplayingIds: update => { replaying = update(replaying); },
    ensureQueuedPromptImagesReady: async () => ({ ready: true, item }),
    buildQueuedPromptPayload: item => item.text,
    hasMalformedQueuedImageMarker: () => false,
    resolveActiveInputSurface: () => 'history',
    focusHistoryComposer: noop, focusActiveTerminal: noop,
    serializeComposerDraft: value => value.text,
    buildPromptQueueReceiptHandoffId: () => 'H',
    runHistoryPromptHandoff: handoffs.runHistoryPromptHandoff,
    historyPromptHandoffInitialStatus: handoffs.historyPromptHandoffInitialStatus,
    useWorkspaceStore: { getState: () => state },
    usePromptQueueStore: { getState: () => ({ setAutoRun: (tabId, value) => paused.push({tabId,value}) }) },
    showToast: message => notices.push(message),
    removePrompt: (_tabId, id) => removed.push(id),
    queueSendTransferredOwnership: result => result.submitted === true,
    AGENT_SETTINGS_INTENT_NONE: { kind: 'none' },
    runAgentSendFlow, enqueueAgentSendScenario, normalizeAgentSendOutcome,
    agentSendSettingsContractError: () => null,
    prepareTabWorkContext: async (_tabId, _handoffId, prompt) => ({ prompt }),
    activateTabWorkContext: noop, settleTabWorkContext: noop,
    getAgentSendProviderContract: () => ({ toolType: 'codex', passCancellationGuardToTransport: false }),
    prepareAgentRecordContext: async () => ({ restartPerformed: false, historyContextResult: null }),
    prepareAgentRuntimeForSend: async () => {
      stages.push('ensure-ready');
      return { status, submitCapability: status === 'busy' ? 'queue' : 'direct',
        presence: { runtimeSnapshot: presence }, expectedTarget: { toolType: 'codex', sessionId: 'writer' } };
    },
    proveAgentComposerForSend: async () => { stages.push('prove-composer'); return { complete: false }; },
    findTabRuntimeContext: () => ({ tab: workspace.tabs.get('T'), projectId: 'P' }),
    codexSendInflight: new Map(),
    agentSendReceiptStore: { get: () => null },
    terminalRegistry: { getCodexDraftState: () => ({ hasDraft: false }) },
    readCodexDraftAuthority: async () => ({ success: true, hasDraft: false, source: 'headless-test' }),
    isSubmittedCodexAuditTimeout: () => false,
    shortTab: value => value, errorText: String,
    nodePerformance: { now: () => 1 },
    terminals: new Map([['T', terminal]]),
    terminalCommandState: new Map([['T', { isRunning: status !== 'inactive' }]]),
    terminalLifecycleEpochs: new WeakMap([[terminal, 'instance-T']]),
    getTerminalLifecycleGeneration: () => 'lifecycle-T',
    getCodexWriterProofSnapshot: () => ({ sessionId: 'writer', terminalToken: terminal,
      runSeq: 0, lifecycleGeneration: 'lifecycle-T' }),
    currentCodexAcceptedResumeSourceProof: () => null,
    codexLastRunCommandPayload: new Map(), codexTurnWatchers: new Map(),
    getCodexResumeReadIdentityLeaseForTab: () => null,
    isCodexTuiEffectivelyReady: () => inputReady,
    codexHasLivePtySubmitEvidence: () => status !== 'inactive',
    getCodexPublicRuntimeProjection: () => presence,
    ensureCodexInputReadyForExternalPrompt: async () => ({ success: inputReady, error: 'not-ready' }),
    getCodexRuntimeSessionSnapshot: async () => presence,
    CODEX_PASTE_AUDIT_TIMEOUT_MS: 1000,
    safePasteAndSubmit: async (_terminal, prompt, options) => {
      stages.push('owned-paste'); pasted.push({ prompt, options });
      return pasteResult || { success: true, submitted: true, status: 'queued',
        providerQueueAccepted: true, queued: true };
    },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    ipcRenderer: { invoke: async (channel, ...args) => {
      calls.push({ channel, args });
      assert.ok(handlers.has(channel), 'real handler exists: ' + channel);
      return handlers.get(channel)({ sender: {} }, ...args);
    } },
  };
  vm.createContext(context);
  vm.runInContext(part(main, 'function readAgentSendDestinationAtWriteBoundary(',
    'function captureClaudeDraftPasteTarget('), context);
  vm.runInContext(part(main, 'function isCodexOperationalInputReady(', 'function observeCodexInputControlReadinessFrame('), context);
  vm.runInContext(part(main, "ipcMain.handle('codex:send-command'", 'async function executeCodexSelectModelEffortRequest('), context);
  vm.runInContext(compile(part(read('./historyAgentRuntimes.ts'), 'async function sendCodexPrompt(', 'async function interruptCodexTurn(')), context);
  const runtime = { getPresence: async () => presence,
    sendPrompt: (...args) => context.sendCodexPrompt(...args) };
  context.getHistoryAgentRuntime = () => runtime;
  vm.runInContext(compile(read('./agentSendAdapter.ts').slice(read('./agentSendAdapter.ts').indexOf('export function createAgentSendAdapter('))), context);
  vm.runInContext(compile(part(read('./agentScenarios.ts'), 'const normalizeStatus =', 'export async function stopAgentProcessScenario(')), context);
  // This fixture controls admission only; the real SQLite FIFO and App DTO
  // round trip are exercised by agent-send-application-queue.integration.test.
  // Re-enter the SAME scenario with Main-issued attempt identity, as Main does.
  handlers.set('agent:enqueue-prompt', (_event, input) => context.sendAgentPromptScenario({
    ...input, runtime, workContextPrepared: true, sendOperationKey: 'history:T:' + input.handoffId,
    sendAttemptId: 'private-attempt',
  }));
  const sendNowSource = read('./runAfterSendNow.ts');
  vm.runInContext(compile(sendNowSource.slice(sendNowSource.indexOf('export async function sendQueuedPromptNow('))), context);
  vm.runInContext(compile(part(overlay, '  const replayChip = useCallback(', '  useEffect(() => {\n    const setCmd'))
    + '\nglobalThis.replayChip = replayChip;', context);
  return { context, handlers, handoffs, item, pasted, removed, notices, calls, stages, paused };
}

test('actual Cmd+Replay caller reaches native busy send through the ordinary scenario and main handler', async () => {
  const h = harness();
  await h.context.replayChip('item', h.item, { submit: true });
  assert.equal(h.pasted.length, 1, JSON.stringify({ notices: h.notices, calls: h.calls }));
  assert.deepEqual(h.stages, ['ensure-ready', 'prove-composer', 'owned-paste']);
  assert.equal(h.pasted[0].options.queuedAtSubmit, true);
  assert.equal(h.pasted[0].options.source, 'codex-prompt-queue');
  assert.equal(h.pasted[0].options.promptQueueAction, 'send-now');
  assert.equal(h.pasted[0].options.verifyCodexVisibleDraftBeforeSubmit, true);
  assert.equal(h.pasted[0].options.awaitCodexUserMessageAudit, true);
  assert.deepEqual(h.removed, ['item']);
});

test('actual manual replay also preserves its original conversation at the shared main target guard', async () => {
  const h = harness();
  h.context.getCodexWriterProofSnapshot = () => ({ sessionId: 'other-conversation' });
  await h.context.replayChip('item', h.item, { submit: true });
  assert.equal(h.pasted.length, 0);
  assert.equal(h.removed.length, 0);
  assert.ok(h.notices.some(message => message.includes('target conversation changed')));
});

test('auto Run After still defers while busy even when a caller supplies queue:true', async () => {
  const h = harness();
  const result = await h.context.ipcRenderer.invoke('codex:send-command', 'T', 'automatic', {
    source: 'prompt-queue', statusAtSend: 'busy', queue: true,
  });
  assert.equal(result.deferred, true);
  assert.equal(result.submitted, false);
  assert.equal(result.pasteWritten, false);
  assert.deepEqual(h.pasted, []);
});

test('auto Run After still delivers on the active input-ready boundary', async () => {
  const h = harness({ status: 'active' });
  const result = await h.context.ipcRenderer.invoke('codex:send-command', 'T', 'automatic', {
    source: 'prompt-queue', statusAtSend: 'active',
  });
  assert.equal(result.submitted, true);
  assert.equal(h.pasted.length, 1);
  assert.equal(h.pasted[0].options.promptQueueAction, undefined);
});

test('manual send-now keeps readiness refusal and does not remove the queued prompt', async () => {
  const h = harness({ inputReady: false });
  await h.context.replayChip('item', h.item, { submit: true });
  assert.deepEqual(h.pasted, []);
  assert.deepEqual(h.removed, []);
  assert.equal(h.handoffs.getHistoryPromptHandoffsSnapshot('T')[0].statusReason, 'send-proven-not-submitted');
});

test('manual send-now preserves a downstream draft/identity refusal and leaves the source chip', async () => {
  const h = harness({ pasteResult: { success: false, submitted: false, error: 'codex_existing_draft_before_paste' } });
  await h.context.replayChip('item', h.item, { submit: true });
  assert.equal(h.pasted.length, 1);
  assert.equal(h.pasted[0].options.verifyCodexVisibleDraftBeforeSubmit, true);
  assert.deepEqual(h.removed, []);
  assert.equal(h.handoffs.getHistoryPromptHandoffsSnapshot('T')[0].queueStatus, 'failed');
  assert.deepEqual(h.paused,[{tabId:'T',value:false}]);
});

test('unknown selected Send-now pauses automatic continuation without removing or repeating the card',async()=>{
  const h=harness({pasteResult:{success:null,submitted:null,deliveryUnknown:true,status:'delivery-unknown'}});
  await h.context.replayChip('item',h.item,{submit:true});
  assert.equal(h.pasted.length,1);assert.equal(h.removed.length,0);
  assert.deepEqual(h.paused,[{tabId:'T',value:false}]);
});

test('slow Codex confirmation remains a pending History row through the actual send runtime and scenario', async () => {
  const h = harness({ status: 'active', pasteResult: {
    success: null, accepted: true, submitted: true,
    pasteWritten: true, enterWritten: true,
    status: 'audit-pending', receiptState: 'audit-pending',
    auditPending: true, deliveryUnknown: false, exactAuditConfirmed: false,
    userMessageAuditPending: true, code: 'codex_user_message_audit_pending',
    pendingReason: 'codex_user_message_audit_timeout',
    codexAudit: { success: false, error: 'codex_user_message_audit_timeout', lateReconciliationPending: true },
  } });
  await h.context.replayChip('item', h.item, { submit: true });
  const row = h.handoffs.getHistoryPromptHandoffsSnapshot('T')[0];
  assert.equal(row.queueStatus, 'audit-pending');
  const presentation = h.handoffs.historyPromptHandoffStatusPresentation(row.queueStatus);
  assert.equal(presentation.pending, true);
  assert.equal(presentation.label, 'CONFIRMING');
  assert.notEqual(presentation.tone, 'warning');
  assert.deepEqual(h.notices, []);
  assert.equal(h.pasted.length, 1);
  assert.equal(row.auditProof, null, 'an empty composer or timeout never fabricates SENT proof');
});

test('Claude manual action reaches the real terminal:paste profile and retains image/audit origin without auto idle policy', async () => {
  const handlers = new Map(), requests = [];
  let autoAdmissionChecks = 0;
  const context = {
    ...sourceRules, ...require('../../main/terminal-paste-profile'),
    console: { log() {}, warn() {}, error() {} },
    useWorkspaceStore: { getState: () => ({ clearInterruptedState: noop }) },
    sendInflight: new Map(), shortTab: value => value, errorText: String,
    isStandaloneAgentLocalCommand: () => false,
    terminals: new Map([['T', {}]]), aiStoppingTabs: new Map(), hasLiveClaudeInTab: () => true,
    captureClaudePromptQueuePtyAdmission: () => { autoAdmissionChecks++; return { available: false, reason: 'busy' }; },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    ipcRenderer: { invoke: async (channel, ...args) => {
      assert.equal(channel, 'terminal:paste');
      return handlers.get(channel)({}, ...args);
    } },
  };
  vm.createContext(context);
  // Execute the exact source-policy declarations and queue-only gate from
  // the paste function, without constructing a fake second submit engine.
  const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
  const inner = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === '_safePasteAndSubmitInner');
  const declarations = ['isCodexPasteSource', 'hasPromptQueueOrigin', 'isPromptQueueAutomation']
    .map(name => inner.body.statements.find(node => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === name)).getText(ast));
  let gate;
  const findGate = node => {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === 'isPromptQueueAutomation && !isCodexPasteSource') gate = node;
    if (!gate) ts.forEachChild(node, findGate);
  };
  findGate(inner.body);
  assert.ok(gate);
  vm.runInContext('function queuePolicyAtPaste(source, promptQueueAction) { const broadcastTabId = "T", term = {}; '
    + 'let claudePromptQueuePtyAdmission = null; const logPrefix = "test"; '
    + declarations.join('\n') + '\n' + gate.getText(ast)
    + '\nreturn { success: true, origin: hasPromptQueueOrigin }; }', context);
  context.safePasteAndSubmit = async (_term, _prompt, options) => {
    requests.push(options);
    const policy = context.queuePolicyAtPaste(options.source, options.promptQueueAction);
    return policy.success ? { success: true, submitted: true } : policy;
  };
  vm.runInContext(part(main, "ipcMain.handle('terminal:paste'", 'function mediaTypeFromImagePath('), context);
  vm.runInContext(compile(part(read('./claudePtyActions.ts'), 'export async function sendClaudePtyPrompt(',
    'export async function interruptClaudePtyTurn(')), context);
  const result = await context.sendClaudePtyPrompt('T', 'manual Claude prompt', {
    handoffId: 'H', source: 'prompt-queue', promptQueueAction: 'send-now', statusAtSend: 'busy', queue: true,
  });
  assert.equal(result.submitted, true);
  assert.equal(autoAdmissionChecks, 0);
  assert.equal(requests[0].source, 'prompt-queue');
  assert.equal(requests[0].promptQueueAction, 'send-now');
  assert.equal(requests[0].verifyClaudeVisibleDraftBeforePaste, true);
  assert.equal(requests[0].awaitClaudeUserMessageAudit, true);
  assert.equal(context.queuePolicyAtPaste('prompt-queue', undefined).submitted, false);
  assert.equal(autoAdmissionChecks, 1);
});

test('actual failed-before-submit handoff can hide its local presentation without a nonexistent receipt', async () => {
  const handoffs = handoffModule();
  await handoffs.runHistoryPromptHandoff({ tabId: 'T', handoffId: 'failed', toolType: 'codex',
    text: 'failed local row', source: 'prompt-queue', send: async () => ({ success: false, submitted: false }) });
  const record = handoffs.getHistoryPromptHandoffsSnapshot('T')[0];
  const removed = [], notices = [], calls = [];
  const context = {
    ...handoffs, tabId: 'T', toolType: 'codex', useCallback: fn => fn,
    planHistoryPromptPresentationDismissal, isLocalPromptEntry: row => row.uuid.startsWith('local-prompt-'),
    historyDiag: noop, console: { warn() {} },
    removeLocalPromptEntry: id => removed.push(id),
    waitForHistoryPromptHandoffSendIdentity: async () => null,
    showHistoryIncidentToast: (_tabId, message) => notices.push(message),
    ipcRenderer: { invoke: async channel => { calls.push(channel);
      return { success: false, dismissed: false, reason: 'receipt-not-found' }; } },
  };
  vm.createContext(context);
  vm.runInContext(compile(part(history, '  const dismissPromptPresentation = useCallback(', '  const acknowledgeMaterializedHistoryReceipt ='))
    + '\nglobalThis.dismissPromptPresentation = dismissPromptPresentation;', context);
  await context.dismissPromptPresentation({ uuid: 'local-prompt-failed', role: 'queued', handoffId: 'failed',
    queueStatus: record.queueStatus, statusReason: record.statusReason, requiresAuditIdentity: true });
  assert.deepEqual(removed, ['failed'], JSON.stringify({ calls, notices, record }));
  assert.deepEqual(calls, []);
  assert.deepEqual(notices, []);
});

function dismissalHarness({ handoffPatch = {}, entryPatch = {}, durableRows = [], holdReceiptRead = false } = {}) {
  const handoffs = handoffModule();
  handoffs.beginHistoryPromptHandoff({ tabId: 'T', handoffId: 'legacy', toolType: 'codex',
    text: 'same text', source: 'prompt-queue', requiresAuditIdentity: true,
    initialReceipt: { queueStatus: 'failed', reason: 'send-refused-before-submit' }, ...handoffPatch });
  const record = handoffs.getHistoryPromptHandoffsSnapshot('T')[0];
  let rows = [{ uuid: 'local-prompt-legacy', role: 'queued', handoffId: 'legacy', content: 'same text',
    queueStatus: record.queueStatus, statusReason: record.statusReason, requiresAuditIdentity: true, ...entryPatch },
  { uuid: 'canonical-user', role: 'user', handoffId: 'legacy', content: 'same text' }];
  const calls = [], notices = [], handlers = new Map();
  let releaseReceipt;
  const receiptReady = holdReceiptRead ? new Promise(resolve => { releaseReceipt = resolve; }) : Promise.resolve();
  const context = {
    ...handoffs, tabId: 'T', toolType: 'codex', useCallback: fn => fn,
    LOCAL_PROMPT_PREFIX: 'local-prompt-', historySnapshotOwner: 'owner',
    presentationEntriesRef: { current: rows }, promptHandoffMetaRef: { current: new Map() },
    suppressedPromptsRef: { current: new Map() },
    planHistoryPromptPresentationDismissal, historyDiag: noop, console: { warn() {} },
    setEntries: update => { rows = update(rows); context.presentationEntriesRef.current = rows; },
    persistVolatileOverlay: noop,
    waitForHistoryPromptHandoffSendIdentity: async () => null,
    showHistoryIncidentToast: (_tabId, message) => notices.push(message),
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    agentSendReceiptStartupReady: receiptReady,
    DESKTOP_HISTORY_SEND_SURFACE: 'desktop-history',
    agentSendReceiptStore: { list: () => durableRows,
      dismissPresentation: () => ({ ok: false, applied: false, reason: 'test-keep-durable-presentation' }) },
    ipcRenderer: { invoke: async (channel, payload) => {
      calls.push(channel);
      assert.equal(channel, 'agent:dismiss-send-receipt-presentation', 'hiding must not call cancellation or PTY');
      return handlers.get(channel)({}, payload);
    } },
  };
  vm.createContext(context);
  vm.runInContext(part(main, "ipcMain.handle('agent:dismiss-send-receipt-presentation'", "ipcMain.handle('agent:record-history-context'"), context);
  vm.runInContext(compile(part(history, 'const isLocalPromptEntry =', 'const isLocalRewindEntry ='))
    + compile(part(history, '  const removeLocalPromptEntry = useCallback(', '  const acknowledgeMaterializedHistoryReceipt ='))
    + '\nglobalThis.dismissPromptPresentation = dismissPromptPresentation;', context);
  return { context, handoffs, calls, notices, releaseReceipt,
    rows: () => rows, dismiss: () => context.dismissPromptPresentation(rows[0]),
    changeRow: patch => context.setEntries(current => current.map(row => row.role === 'queued' ? { ...row, ...patch } : row)),
  };
}

test('legacy failed local row hides after exact main receipt absence without touching an equal canonical message', async () => {
  const h = dismissalHarness();
  await h.dismiss();
  assert.deepEqual(h.calls, ['agent:dismiss-send-receipt-presentation']);
  assert.deepEqual(h.rows().map(row => row.uuid), ['canonical-user']);
  assert.equal(h.rows()[0].content, 'same text');
  assert.equal(h.handoffs.getHistoryPromptHandoffsSnapshot('T').length, 0);
  assert.deepEqual(h.notices, []);
});

for (const [label, options] of [
  ['pending', { handoffPatch: { initialReceipt: { queueStatus: 'queued', reason: 'send-result' } } }],
  ['unknown', { handoffPatch: { initialReceipt: { queueStatus: 'delivery-unknown', reason: 'send-delivery-unknown' } } }],
  ['partial attempt', { handoffPatch: { sendAttemptId: 'partial' } }],
  ['partial operation', { handoffPatch: { sendOperationKey: 'partial' } }],
  ['accepted proof', { entryPatch: { auditEntryUuid: 'real-user' } }],
  ['non-local transcript', { entryPatch: { role: 'user', uuid: 'canonical-first' } }],
  ['ambiguous durable receipt', { durableRows: [{ handoffId: 'legacy' }, { handoffId: 'legacy' }] }],
]) {
  test(`local dismissal does not erase ${label} despite unavailable receipt`, async () => {
    const h = dismissalHarness(options);
    await h.dismiss();
    assert.equal(h.rows().length, 2);
    assert.equal(h.handoffs.getHistoryPromptHandoffsSnapshot('T').length, 1);
  });
}

test('late receipt-not-found cannot hide a now-unknown row or newly bound attempt', async () => {
  for (const change of ['row-unknown', 'attempt-bound']) {
    const h = dismissalHarness({ holdReceiptRead: true });
    const waiting = h.dismiss();
    await Promise.resolve();
    if (change === 'row-unknown') h.changeRow({ queueStatus: 'delivery-unknown' });
    else h.handoffs.bindHistoryPromptHandoffSendIdentity('T', 'legacy', { sendAttemptId: 'late-attempt' });
    h.releaseReceipt(); await waiting;
    assert.equal(h.rows().length, 2);
    assert.equal(h.handoffs.getHistoryPromptHandoffsSnapshot('T').length, 1);
  }
});

test('future generic failure is unknown, while only explicit negative submit evidence creates a proved failure', async () => {
  for (const [result, status, reason] of [
    [{ success: false, error: 'transport-failed' }, 'delivery-unknown', 'send-delivery-unknown'],
    [{ success: false, submitted: null, deliveryOutcome: 'not-submitted' }, 'delivery-unknown', 'send-delivery-unknown'],
    [{ success: false, submitted: false }, 'failed', 'send-proven-not-submitted'],
    [{ success: false, deliveryOutcome: 'not-submitted' }, 'failed', 'send-proven-not-submitted'],
  ]) {
    const handoffs = handoffModule();
    await handoffs.runHistoryPromptHandoff({ tabId: 'T', handoffId: 'proof', toolType: 'codex',
      text: 'preserve', send: async () => result });
    const record = handoffs.getHistoryPromptHandoffsSnapshot('T')[0];
    assert.equal(record.queueStatus, status);
    assert.equal(record.statusReason, reason);
    assert.equal(record.text, 'preserve');
  }
});
