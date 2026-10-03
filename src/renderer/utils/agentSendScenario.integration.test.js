'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const repoDir = path.join(__dirname, '../../..');
const scenarioPath = path.join(__dirname, 'agentScenarios.ts');

async function buildBundle() {
  const wrapper = `
    import { sendAgentPromptScenario } from ${JSON.stringify(scenarioPath)};
    import { subscribeAgentSendScenarios } from ${JSON.stringify(path.join(__dirname, 'agentSendSequencer.mjs'))};
    export async function run(options = {}) {
      const state = { status: options.status || 'active', reads: 0, events: [], lastSendOptions: null };
      const sendActivity = [];
      const unsubscribe = subscribeAgentSendScenarios(({ tabId, pending }) => {
        if (tabId === 'scenario-integration-tab') sendActivity.push(pending);
      });
      globalThis.__sendScenarioState = state;
      const toolType = options.toolType || 'claude';
      const runtime = {
        toolType,
        label: toolType === 'codex' ? 'Codex' : 'Claude',
        lowerLabel: toolType,
        logPrefix: 'ScenarioIntegration',
        busyEvent: toolType + ':busy',
        readyEvent: toolType + ':ready',
        supportsQuestions: false,
        supportsInterruptRecovery: false,
        allowSendWhileBusy: true,
        optimisticBusyOnSend: false,
        optimisticActiveOnInterrupt: false,
        getPresence: async () => {
          state.reads += 1;
          if (state.reads <= Number(options.presenceFailureReads || 0)) {
            state.events.push(['presence-error']);
            throw new Error('presence unavailable');
          }
          if (state.reads === Number(options.presenceFailureAtRead || 0)) {
            state.events.push(['presence-error']);
            throw new Error('presence unavailable');
          }
          if (options.becomeActiveOnSecondRead && state.reads >= 2) state.status = 'active';
          if (options.becomeActiveOnThirdRead && state.reads >= 3) state.status = 'active';
          state.events.push(['presence', state.status]);
          return {
            status: state.status,
            inputReady: state.status === 'active'
              || state.status === 'busy'
              || (toolType === 'codex' && options.startingInputReady),
            isBusy: state.status === 'busy',
            sessionId: options.sessionId || null,
            conversationMaterialized: Boolean(options.sessionId),
            canResume: Boolean(options.sessionId),
          };
        },
        resume: async ({ sessionId }) => {
          state.events.push(['resume', sessionId]);
          if (options.resumeRejectedByConcurrentLaunch) {
            state.status = 'starting';
            return { success: false, error: 'already starting' };
          }
          state.status = 'active';
          return { success: true };
        },
        startFresh: async () => {
          state.events.push(['startFresh']);
          state.status = 'active';
          return { success: true };
        },
        sendPrompt: async (_tabId, prompt, sendOptions) => {
          state.lastSendOptions = sendOptions;
          state.events.push(['send', prompt, sendOptions.queue, sendOptions.source]);
          return {
            success: true,
            submitted: true,
            pasteAudit: {
              success: true,
              auditTimestamp: '2026-08-19T00:00:00.000Z',
              actualHash: 'integration-hash',
            },
          };
        },
        recordHistoryContext: async () => ({ success: false }),
        interruptTurn: () => ({ success: true }),
        stopProcess: async () => ({ success: true }),
        grabDraft: async () => ({ success: false }),
        copyDraft: async () => ({ success: false }),
        probeDraft: async () => ({ hasDraft: false, proofOutcome: 'absent', source: 'test' }),
      };
      let result;
      try { result = await sendAgentPromptScenario({
        tabId: 'scenario-integration-tab',
        toolType,
        runtime,
        sessionId: options.sessionId || null,
        prompt: 'integration prompt',
        handoffId: options.handoffId || 'integration-handoff',
        source: options.source || 'prompt-queue',
        statusAtSend: options.statusAtSend || options.status || 'active',
        ...(options.omitSettingsIntent ? {} : {
          settingsIntent: options.settingsIntent || { kind: 'none' },
        }),
        historyRestartSettings: options.historyRestartSettings,
        recordWithoutReply: options.recordWithoutReply === true,
      }); } finally { unsubscribe(); }
      return { result, events: state.events, sendOptions: state.lastSendOptions, sendActivity };
    }
  `;
  const stubs = new Map([
    ['../store/useWorkspaceStore', `export const useWorkspaceStore = { getState: () => ({ setClaudeSessionId() {}, async setCodexSessionId() { return true; } }) };`],
    ['../store/useUIStore', `export const useUIStore = { getState: () => ({}) };`],
    ['./claudeStartupDefaultsReady', `
      export async function waitForClaudeStartupDefaultsReadyWithVisibleFallback() {}
      export async function waitForClaudeStartupDefaultsReadyUntilSettled() {}
    `],
    ['./terminalRegistry', `const registry = new Map(); registry.getDraftDiagnosticSnapshot = () => ({}); export const terminalRegistry = registry;`],
    ['./codexRewindCommit', `export async function requireCommittedCodexRewind() { return true; }`],
    ['./codexWriterIdentity', `export async function requireConfirmedCodexWriter() { return true; }`],
    ['../store/rewindOperationState', `export function selectRewindOperation() { return null; }`],
    ['../store/useRewindOperationStore', `export const useRewindOperationStore = { getState: () => ({}) };`],
    ['./agentActionCoordinator.mjs', `
      export function cancelCoordinatedAgentSendFollowers() { return { cancelled: 0 }; }
      export function createCoordinatedAgentSendCancellationWait() { return null; }
      export function getCoordinatedAgentSendCancellation() { return null; }
      export function isCoordinatedAgentSendCancellationRequested() { return false; }
      export async function settleCoordinatedAgentSend() { return { settled: true }; }
    `],
    ['./agentDraftPreflight.mjs', `
      export function classifyAgentDraftPreflight() { return { decision: 'clear' }; }
      export function buildExactDraftCaptureProof() { return {}; }
      export function resolveAgentDraftConflict() { return { decision: 'clear' }; }
      export function applyAgentDraftCaptureResolution(value) { return value; }
    `],
    ['./agentDraftContradictionToast.mjs', `export function showAgentDraftScreenContradictionToast() {}`],
  ]);
  const plugin = {
    name: 'send-scenario-integration-stubs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => stubs.has(args.path)
        ? { path: args.path, namespace: 'send-scenario-stub' }
        : null);
      build.onLoad({ filter: /.*/, namespace: 'send-scenario-stub' }, (args) => ({
        contents: stubs.get(args.path), loader: 'js',
      }));
    },
  };
  global.window = { require: () => ({ ipcRenderer: {
    on() {}, removeListener() {},
    async invoke(channel, request) {
      // This fixture has no attached/deferred working context; execute the
      // real renderer context wrapper against its explicit neutral API reply.
      if (channel === 'tab-work-context:prepare') return { success: true, prompt: request.prompt, prefix: '' };
      if (channel === 'tab-work-context:activate' || channel === 'tab-work-context:settle') return { success: true };
      assert.fail('unexpected integration IPC: ' + channel);
    },
  } }) };
  const built = await esbuild.build({
    stdin: { contents: wrapper, loader: 'ts', resolveDir: repoDir, sourcefile: 'send-scenario-integration.ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent', plugins: [plugin],
    // The real work-context wrapper imports its UI stylesheet. This Node
    // scenario fixture verifies delivery, not CSS, and has no output file.
    loader: { '.css': 'empty' },
  });
  const loaded = new Module(path.join(repoDir, 'send-scenario-integration.cjs'), module);
  loaded.filename = path.join(repoDir, 'send-scenario-integration.cjs');
  loaded.paths = Module._nodeModulePaths(repoDir);
  loaded._compile(built.outputFiles[0].text, loaded.filename);
  return loaded.exports;
}

let bundle;
test.before(async () => { bundle = await buildBundle(); });

for (const toolType of ['codex', 'claude']) {
  for (const source of ['history-panel', 'project-api', 'mobile-native', 'prompt-queue']) {
    test(`${toolType}/${source}: actual shared cold scenario owns activity from enqueue through readiness and send result`, async () => {
      const { result, events, sendActivity } = await bundle.run({ toolType, source, status: 'inactive' });
      assert.equal(result.deliveryOutcome, 'confirmed');
      assert.equal(events.filter((event) => event[0] === 'startFresh').length, 1);
      assert.equal(events.filter((event) => event[0] === 'send').length, 1);
      assert.deepEqual(sendActivity, [1, 0]);
    });
  }
}

test('inactive Run After uses the shared scenario to Resume then submit once', async () => {
  const { result, events } = await bundle.run({ status: 'inactive', sessionId: 'saved-session' });
  assert.deepEqual(events.filter((event) => event[0] === 'resume'), [['resume', 'saved-session']]);
  assert.deepEqual(events.filter((event) => event[0] === 'send'), [[
    'send', 'integration prompt', false, 'prompt-queue',
  ]]);
  assert.equal(result.deliveryOutcome, 'confirmed');
});

test('a Send already admitted as starting waits instead of launching a duplicate process', async () => {
  const { events } = await bundle.run({
    status: 'starting',
    statusAtSend: 'starting',
    sessionId: 'saved-session',
    becomeActiveOnSecondRead: true,
  });
  assert.equal(events.some((event) => event[0] === 'resume' || event[0] === 'startFresh'), false);
  assert.equal(events.filter((event) => event[0] === 'send').length, 1);
});

test('Codex starting with a proven composer is submit-capable before MCP completion', async () => {
  const { events } = await bundle.run({
    toolType: 'codex',
    status: 'starting',
    statusAtSend: 'starting',
    startingInputReady: true,
  });
  assert.equal(events.some((event) => event[0] === 'resume' || event[0] === 'startFresh'), false);
  assert.equal(events.filter((event) => event[0] === 'send').length, 1);
});

test('unknown presence never authorizes a duplicate lifecycle launch', async () => {
  const { events } = await bundle.run({
    status: 'active',
    statusAtSend: 'active',
    sessionId: 'saved-session',
    presenceFailureReads: 1,
  });
  assert.equal(events.some((event) => event[0] === 'resume' || event[0] === 'startFresh'), false);
  assert.equal(events.filter((event) => event[0] === 'send').length, 1);
});

test('a concurrent launch rejection is re-read and joined instead of disarming Run After', async () => {
  const { events } = await bundle.run({
    status: 'inactive',
    statusAtSend: 'inactive',
    sessionId: 'saved-session',
    resumeRejectedByConcurrentLaunch: true,
    becomeActiveOnThirdRead: true,
  });
  assert.equal(events.filter((event) => event[0] === 'resume').length, 1);
  assert.equal(events.filter((event) => event[0] === 'send').length, 1);
});

test('a failed post-gate presence reread waits and never starts a second process', async () => {
  const { events } = await bundle.run({
    status: 'active',
    statusAtSend: 'active',
    sessionId: 'saved-session',
    presenceFailureAtRead: 2,
  });
  assert.equal(events.some((event) => event[0] === 'resume' || event[0] === 'startFresh'), false);
  assert.equal(events.filter((event) => event[0] === 'send').length, 1);
});

test('ordinary busy prompt carries an explicit none intent and reaches the provider queue without settings', async () => {
  const { result, events, sendOptions } = await bundle.run({
    toolType: 'codex',
    status: 'busy',
    statusAtSend: 'busy',
  });
  assert.equal(result.success, true);
  assert.equal(events.filter((event) => event[0] === 'send').length, 1);
  assert.equal(sendOptions.queue, true);
  assert.equal(sendOptions.model, undefined);
  assert.equal(sendOptions.effort, undefined);
  assert.equal(sendOptions.thinking, undefined);
});

test('busy Claude prompt remains input-capable and reaches its provider queue', async () => {
  const { result, events, sendOptions } = await bundle.run({
    toolType: 'claude',
    status: 'busy',
    statusAtSend: 'busy',
  });
  assert.equal(result.success, true);
  assert.equal(events.filter((event) => event[0] === 'send').length, 1);
  assert.equal(sendOptions.queue, true);
});

test('explicit settings intent is the only shape unwrapped into provider options', async () => {
  const { sendOptions } = await bundle.run({
    settingsIntent: {
      kind: 'explicit-change',
      model: 'claude-opus-5[1m]',
      effort: 'max',
      thinking: 'adaptive',
    },
  });
  assert.equal(sendOptions.model, 'claude-opus-5[1m]');
  assert.equal(sendOptions.effort, 'max');
  assert.equal(sendOptions.thinking, 'adaptive');
});

test('missing or cross-wired settings contract is a structured pre-submit failure', async () => {
  const missing = await bundle.run({ omitSettingsIntent: true });
  assert.equal(missing.result.code, 'agent_send_settings_contract_invalid');
  assert.equal(missing.result.submitted, false);
  assert.equal(missing.events.some((event) => event[0] === 'send'), false);

  const crossWired = await bundle.run({
    historyRestartSettings: {
      kind: 'codex-launch-settings',
      model: 'gpt-5.6-sol',
      effort: 'max',
    },
  });
  assert.equal(crossWired.result.code, 'agent_send_settings_contract_invalid');
  assert.equal(crossWired.events.some((event) => event[0] === 'send'), false);
});
