import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const root = process.env.R3_SOURCE_ROOT ? path.resolve(process.env.R3_SOURCE_ROOT) : fileURLToPath(new URL('../../../', import.meta.url));
export const read = name => fs.readFileSync(path.join(root, name), 'utf8');
export const load = name => import(pathToFileURL(path.join(root, name)).href);
const mainSource = read('src/main/main.js');
const require = createRequire(import.meta.url);
export function declaration(source, name) {
  const start = source.search(new RegExp('(?:export )?(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name + ' is a supplied function');
  const end = start + source.slice(start).search(/\n}(?=\r?\n|$)/);
  assert.ok(end > start, name + ' has a top-level closing brace');
  return source.slice(start, end + 2).replace(/^export /, '');
}
export const strip = source => stripTypeScriptTypes(source, { mode: 'strip' });
export const turns = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

// Executes selected unchanged Main authority/owner readers and real registry.
// SQL rows, process identity/maps and IPC delivery are controlled input ports.
// There is no provider, PTY, native readiness or persistent DB in this fixture.
export async function mainFixture(toolType = 'codex') {
  const { createAgentLaunchPreparationRegistry } = require(path.join(root, 'src/main/agent-launch-preparation.js'));
  const { createAgentLaunchAdmission } = await load('src/renderer/utils/agentLaunchAdmission.mjs');
  const { rememberAgentLaunchFence, readAgentLaunchFence } = await load('src/renderer/utils/agentLaunchFence.mjs');
  const tabId = 'T-' + crypto.randomUUID(), term = {}, sender = Object.assign(new EventEmitter(), { id: 1 });
  const row = { id: 1, project_id: 'P', cwd: '/fixture', codex_session_id: toolType === 'codex' ? 'S' : null, claude_session_id: toolType === 'claude' ? 'S' : null };
  const registry = createAgentLaunchPreparationRegistry(), calls = [], writes = [], events = new EventEmitter();
  const env = { crypto, path, require, srcMainDir: path.join(root, 'src/main'),
    ...require(path.join(root, 'src/main/codex-runtime-contract.js')),
    console: { warn() {}, log() {} }, terminalLaunchFenceOrders: new WeakMap(), nextTerminalLaunchFenceOrder: 0,
    terminals: new Map([[tabId, term]]), terminalStopRevisions: new WeakMap(), terminalLifecycleEpochs: new WeakMap(),
    terminalCommandState: new Map([[tabId, { runSeq: 1 }]]), terminalProjects: new Map([[tabId, '/fixture']]),
    terminalProjectIds: new Map([[tabId, 'P']]), aiStoppingTabs: new Map(), agentLaunchIntentSenders: new Set(), agentLaunchPreparations: registry,
    resolveAuthoritativeTabProjectId: () => 'P', agentSendRequestTargetFailure: (_tab, _tool, request) => {
      assert.equal(request.expectedTarget, undefined, 'these controls carry no strong target pin'); return null;
    },
    codexKnownSessions: new Map(), codexWriterProofs: new Map(), codexLastRunCommandPayload: new Map(), codexTurnWatchers: new Map(),
    codexLaunchAcceptancePending: new Map(), isCodexTuiEffectivelyReady: () => false,
    bridgeKnownSessions: new Map(), claudeLaunchGenerationByTab: new Map(), findClaudePidByTab: () => 42,
    getCodexResumeReadIdentityLeaseForTab: () => null,
    AGENT_SEND_DURABLE_STATES: { IN_FLIGHT: 'in-flight' },
    agentSendReceiptStore: { get: () => ({ tabId, provider: toolType, attemptId: 'A', state: 'in-flight' }), isDeliveryCancelled: () => false },
    projectManager: { db: { db: { prepare: () => ({ all: () => [row] }) } } },
  };
  const names = ['captureAgentLaunchFence', 'getTerminalStopRevision', 'getTerminalLifecycleGeneration',
    'readAgentLaunchIntentSource', 'agentLaunchIntentSourceCurrent', 'agentLaunchIntentTrace', 'agentLaunchIntentRefusal',
    'agentLaunchIntentPayloadKey', 'watchAgentLaunchIntentSender', 'beginAgentLaunchIntent', 'cancelAgentLaunchIntent',
    'runAgentLaunchIntentAttempt', 'assertAgentSendLaunchCurrent', 'inspectAgentLaunchIntent',
    'getCodexWriterProofSnapshot', 'currentCodexAcceptedResumeSourceProof', 'readAgentSendDestinationAtWriteBoundary',
    'adoptAgentLaunchMaterializedSource', 'agentLaunchMaterializationResult', 'reuseCurrentCodexResumeLaunch'];
  vm.createContext(env); vm.runInContext(names.map(n => declaration(mainSource, n)).join('\n'), env);
  const original = env.captureAgentLaunchFence(tabId); rememberAgentLaunchFence(tabId, original);
  const hooks = {};
  const invoke = async (channel, input) => {
    calls.push({ channel, input: structuredClone(input) });
    if (channel === 'agent:begin-launch-intent') {
      await hooks.beforeBegin?.(input);
      const result = env.beginAgentLaunchIntent({ sender }, input);
      await hooks.beginAck?.();
      return hooks.beginResult ? hooks.beginResult(result) : result;
    }
    if (channel === 'agent:cancel-launch-intent' || channel === 'agent:finish-launch-intent') {
      return env.cancelAgentLaunchIntent({ sender }, input, channel.includes('finish'));
    }
    if (channel === 'agent:inspect-launch-intent') return env.inspectAgentLaunchIntent({ sender }, input);
    if (channel === 'codex:materialize-empty-session') {
      env.assertAgentSendLaunchCurrent(tabId, toolType, input, { validateTarget: true });
      row.codex_session_id = 'M';
      assert.equal(env.adoptAgentLaunchMaterializedSource(input, 'M'), true);
      return env.agentLaunchMaterializationResult(input, { success: true, sessionId: 'M', metadataOnly: true });
    }
    if (channel === toolType + ':run-command') {
      const result = await env.runAgentLaunchIntentAttempt(sender, input, async () => {
        env.assertAgentSendLaunchCurrent(tabId, toolType, input, { validateTarget: true });
        assert.equal(registry.markIntentWrite(input.launchIntent.token, input.launchAttempt, false, 'L'), true); writes.push(input);
        assert.equal(registry.markIntentWrite(input.launchIntent.token, input.launchAttempt, true), true);
        return { success: true, accepted: true, launchId: 'L' };
      });
      await hooks.runAck?.(); return hooks.runResult ? hooks.runResult(result) : result;
    }
    throw new Error('Unexpected controlled port ' + channel);
  };
  const scope = options => createAgentLaunchAdmission({ invoke, events, tabId, toolType,
    sessionId: 'S', cwd: '/fixture', responseTimeoutMs: 60, inspectTimeoutMs: 50, ...options });
  const adopt = (sessionId = 'C', lineage = 'S') => {
    const lifecycleGeneration = env.getTerminalLifecycleGeneration(tabId);
    if (toolType === 'codex') {
      row.codex_session_id = sessionId; env.codexKnownSessions.set(tabId, sessionId);
      env.codexWriterProofs.set(tabId, { valid: true, sessionId, sourceSessionId: lineage,
        terminalToken: term, runSeq: 1, lifecycleGeneration, launchId: 'L' });
      env.codexLastRunCommandPayload.set(tabId, { command: 'codex-c', sessionId: lineage, terminalToken: term,
        runSeq: 1, lifecycleGeneration, launchId: 'L' });
    } else {
      row.claude_session_id = sessionId; env.bridgeKnownSessions.set(tabId, sessionId);
      env.claudeLaunchGenerationByTab.set(tabId, { generation: 'L', pid: 42, launchMode: 'resume', sessionIdHint: lineage,
        firstAcceptedBridge: { sessionId, generation: 'L', pid: 42, terminalToken: term, runSeq: 1, lifecycleGeneration } });
    }
  };
  const run = item => item.run(toolType + ':run-command', { tabId, command: toolType + '-c', sessionId: 'S', cwd: '/fixture' });
  return { env, sender, tabId, term, original, registry, calls, writes, events, row, hooks, scope, adopt, run,
    cached: () => readAgentLaunchFence(tabId), capture: () => env.captureAgentLaunchFence(tabId),
    stop: () => env.terminalStopRevisions.set(term, env.getTerminalStopRevision(tabId) + 1) };
}

function property(source, name) {
  const start = source.lastIndexOf('\n  ' + name + ': '), end = source.indexOf('\n  },', start);
  assert.ok(start >= 0 && end > start, 'actual Store action ' + name);
  return source.slice(start, end + 4);
}
export async function storeFixture(sessionId = null, toolType = 'codex') {
  const f = await mainFixture(toolType), tab = { [toolType + 'SessionId']: sessionId, commandType: toolType, cwd: '/fixture', wasInterrupted: !!sessionId };
  f.row[toolType + '_session_id'] = sessionId;
  const { resolvePtyAgentOwner } = await load('src/renderer/utils/ptyAgentOwner.mjs');
  const { withAgentLaunchAdmission } = await load('src/renderer/utils/agentLaunchAdmission.mjs');
  const planCodexLaunchSettingsPersistence = vm.runInNewContext('('
    + declaration(read('src/renderer/utils/codexEffectiveSettings.mjs'), 'planCodexLaunchSettingsPersistence') + ')');
  const store = { openProjects: new Map([['P', { projectId: 'P', tabs: new Map([[f.tabId, tab]]) }]]),
    setTabCommandType() {}, markAiLaunchAutoTitle() {}, clearAiLaunchSnapshot() {} };
  const env = { exports: {}, window: {}, console: { log() {}, warn() {} }, AbortController, resolvePtyAgentOwner, withAgentLaunchAdmission,
    get: () => store, set() {}, saveTabs() {}, saveTabsThenNotifyProjectLayoutChanged() {},
    projectCodexSettingsProofOwner: input => {
      // This fixture has no carried settings proof; it does not test its absent producer.
      assert.equal(input.currentProofAt, undefined); assert.equal(input.currentProofSessionId, undefined); return null;
    }, maybeArmPendingAutoTabTitle() {}, clearPendingAutoTabTitle() {},
    useWorkspaceStore: { getState: () => store }, shortTab: x => x,
    buildCodexRunPayload: args => ({ ...args }),
    getCodexLaunchOptions: () => ({ model: 'launch-model', effort: 'high' }), planCodexLaunchSettingsPersistence,
    ipcRenderer: { invoke: async () => ({ success: true }) } };
  vm.createContext(env);
  const source = read('src/renderer/store/useWorkspaceStore.ts');
  vm.runInContext(strip('globalThis.actions = {' + ['setCodexSessionId', 'setClaudeSessionId', 'updateCodexState', 'clearInterruptedState']
    .map(name => property(source, name)).join(',') + '};'), env);
  Object.assign(store, env.actions);
  const runtimes = read('src/renderer/utils/historyAgentRuntimes.ts');
  const contextStart = runtimes.indexOf('const findTabRuntimeContext =');
  const contextSource = runtimes.slice(contextStart, runtimes.indexOf('\n};', contextStart) + 3);
  vm.runInContext(strip(contextSource + '\n' + declaration(runtimes, 'startFreshCodexSession')
    + '\n' + declaration(runtimes, 'resumeCodexSession')
    + '\n' + declaration(runtimes, 'startFreshClaudePtySession')
    + '\nglobalThis.actualStart = startFreshCodexSession; globalThis.actualResume = resumeCodexSession; globalThis.actualClaudeStart = startFreshClaudePtySession;'), env);
  return { ...f, mainEnv: f.env, env, store, tab };
}
