'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const repoDir = path.join(__dirname, '../../..');
const agentScenariosPath = path.join(__dirname, 'agentScenarios.ts');

async function buildScenarioBundle() {
  const wrapper = `
    import { sendAgentPromptScenario } from ${JSON.stringify(agentScenariosPath)};

    export async function runRecordContext(options = {}) {
      const state = { status: options.initialStatus || 'active', events: [] };
      globalThis.__recordContextState = state;
      const runtime = {
        toolType: options.toolType || 'claude',
        label: options.toolType === 'codex' ? 'Codex' : 'Claude',
        lowerLabel: options.toolType === 'codex' ? 'codex' : 'claude',
        logPrefix: 'RecordContextTest',
        busyEvent: 'agent:busy',
        readyEvent: 'agent:ready',
        supportsQuestions: false,
        supportsInterruptRecovery: false,
        allowSendWhileBusy: true,
        optimisticBusyOnSend: false,
        optimisticActiveOnInterrupt: false,
        getPresence: async () => {
          state.events.push(['presence', state.status]);
          const materialized = options.conversationMaterialized === null
            ? undefined
            : options.conversationMaterialized !== undefined
              ? options.conversationMaterialized
              : !!options.sessionId;
          return {
            status: state.status,
            sessionId: Object.prototype.hasOwnProperty.call(options, 'presenceSessionId')
              ? options.presenceSessionId
              : options.sessionId ?? null,
            inputReady: state.status === 'active',
            isBusy: state.status === 'busy',
            conversationMaterialized: materialized,
            canResume: materialized,
            runtimeSnapshot: runtime.toolType === 'codex'
              ? (options.presenceSessionId || options.sessionId
                ? {
                    liveLifecycle: state.status !== 'inactive',
                    writerConfirmed: state.status !== 'inactive',
                    provenWriterSessionId: options.presenceSessionId || options.sessionId,
                    codexCurrentSettingsOwnerId: options.presenceSessionId || options.sessionId,
                    codexCurrentModel: options.runtimeModel || 'gpt-5.6-sol',
                    codexCurrentEffort: options.runtimeEffort || 'max',
                    codexCurrentSettingsProofAt: options.runtimeProofAt || 123,
                  }
                : {
                    liveLifecycle: state.status !== 'inactive',
                    writerConfirmed: false,
                    codexProvisionalSettingsOwnerId: 'launch:test-launch',
                    codexProvisionalModel: 'gpt-5.6-sol',
                    codexProvisionalEffort: 'max',
                    codexProvisionalSettingsProofAt: 123,
                  })
              : undefined,
          };
        },
        resume: async ({ sessionId }) => {
          state.events.push(['resume', sessionId]);
          if (options.launchFailure) return { success: false, error: 'resume failed' };
          state.status = options.startingBeforeReady ? 'starting' : 'active';
          if (options.startingBeforeReady) {
            setTimeout(() => {
              state.status = 'active';
              globalThis.__recordContextEmit('agent:ready', { tabId: 'record-context-tab' });
            }, 10);
          }
          return { success: true };
        },
        startFresh: async () => {
          state.events.push(['startFresh']);
          return { success: false, error: 'record flow must not start an empty session' };
        },
        stopProcess: async (_tabId, stopOptions) => {
          state.events.push(['stop', stopOptions?.reason || null]);
          if (options.stopFailure) return { success: false, error: 'stop failed' };
          if (runtime.toolType === 'codex' && stopOptions?.captureCodexRestartSettings) {
            if (options.stopSettingsProofFailure) {
              return {
                success: false,
                submitted: false,
                error: 'codex_history_context_settings_proof_unavailable',
                reason: options.stopSettingsProofFailure,
              };
            }
            const ownerId = options.presenceSessionId || options.sessionId || 'launch:test-launch';
            const ownerKind = options.presenceSessionId || options.sessionId ? 'writer' : 'launch';
            const effort = options.stopCapturedEffort || 'max';
            state.status = 'inactive';
            return {
              success: true,
              restartSettingsProof: {
                kind: 'codex-stop-captured-settings',
                model: options.stopCapturedModel || 'gpt-5.6-sol',
                effort,
                scope: effort === 'ultra' ? 'conversation-only' : 'persistent-default',
                owner: { kind: ownerKind, id: ownerId },
                observedAt: 200,
                authority: {
                  lifecycleGeneration: 'lifecycle-test',
                  runSeq: 1,
                  inputRevision: 0,
                  mirrorGeneration: 'mirror-test',
                  committedFrameGeneration: 1,
                  writeSeq: 1,
                },
              },
            };
          }
          state.status = 'inactive';
          return { success: true };
        },
        recordHistoryContext: async (_tabId, prompt, recordOptions) => {
          state.events.push([
            'record',
            prompt,
            recordOptions.sessionId ?? null,
            recordOptions.model ?? null,
            recordOptions.effort ?? null,
          ]);
          if (options.recordFailure) {
            return { success: false, accepted: false, historyOnly: true, error: 'record failed' };
          }
          return {
            success: true,
            accepted: true,
            submitted: false,
            historyOnly: true,
            historyRecorded: true,
            modelTurnStarted: false,
            sessionId: options.recordedSessionId || recordOptions.sessionId || 'new-session',
            sendAttemptId: 'attempt-1',
            sendOperationKey: 'operation-1',
            pasteAudit: {
              success: true,
              auditTimestamp: '2026-08-18T00:00:00.000Z',
              actualHash: 'hash',
              sessionId: options.recordedSessionId || recordOptions.sessionId || 'new-session',
              entryUuid: 'entry-1',
            },
          };
        },
        sendPrompt: async () => {
          state.events.push(['send']);
          return { success: true, submitted: true };
        },
        interruptTurn: () => ({ success: true }),
        grabDraft: async () => ({ success: false }),
        copyDraft: async () => ({ success: false }),
      };
      const result = await sendAgentPromptScenario({
        tabId: 'record-context-tab',
        toolType: runtime.toolType,
        runtime,
        sessionId: options.sessionId ?? null,
        cwd: '/tmp/project',
        prompt: 'record-context-prompt',
        handoffId: 'record-context-handoff',
        source: 'history-panel',
        statusAtSend: options.initialStatus || 'active',
        queue: true,
        settingsIntent: { kind: 'none' },
        historyRestartSettings: options.historyRestartSettings
          || (runtime.toolType === 'codex'
            ? {
                kind: 'codex-launch-settings',
                model: 'gpt-5.6-sol',
                effort: 'max',
              }
            : undefined),
        recordWithoutReply: true,
        onRestartPhase: (phase) => state.events.push(['phase', phase]),
      });
      return { result, events: state.events };
    }
  `;
  const stubs = new Map([
    ['../store/useWorkspaceStore', `
      export const useWorkspaceStore = { getState: () => ({
        setClaudeSessionId(_tabId, sessionId) { globalThis.__recordContextState.events.push(['bindClaude', sessionId]); },
        async setCodexSessionId(_tabId, sessionId) { globalThis.__recordContextState.events.push(['bindCodex', sessionId]); return true; },
        clearInterruptedState() {},
      }) };
    `],
    ['../store/useUIStore', `export const useUIStore = { getState: () => ({}) };`],
    ['./claudeStartupDefaultsReady', `export async function waitForClaudeStartupDefaultsReadyWithVisibleFallback() {}`],
    ['./terminalRegistry', `
      const registry = new Map(); registry.getDraftDiagnosticSnapshot = () => ({ success: false });
      export const terminalRegistry = registry;
    `],
    ['./codexRewindCommit', `export async function requireCommittedCodexRewind() { return true; }`],
    ['./codexWriterIdentity', `export async function requireConfirmedCodexWriter() { return true; }`],
    ['../store/rewindOperationState', `export function selectRewindOperation() { return null; }`],
    ['../store/useRewindOperationStore', `export const useRewindOperationStore = { getState: () => ({}) };`],
    ['./agentActionCoordinator.mjs', `
      export function cancelCoordinatedAgentSendFollowers() { return { cancelled: 0 }; }
      export function createCoordinatedAgentSendCancellationWait() { return null; }
      export function getCoordinatedAgentSendCancellation() { return null; }
      export function isCoordinatedAgentSendCancellationRequested() { return false; }
      export async function settleCoordinatedAgentSend() { return { settled: true, stopped: false }; }
    `],
    ['./agentSendSequencer.mjs', `export function enqueueAgentSendScenario({ run }) { return run(); }`],
    ['./agentDraftPreflight.mjs', `
      export function applyAgentDraftCaptureResolution(value) { return value; }
      export function buildExactDraftCaptureProof() { return {}; }
      export function classifyAgentDraftPreflight() { return { decision: 'clear' }; }
      export function resolveAgentDraftConflict() { return { decision: 'clear' }; }
    `],
    ['./composerChips.mjs', `export function buildClaudeRewindPromptProjection(v) { return { menuText: String(v || '') }; }`],
    ['./agentDraftContradictionToast.mjs', `export function showAgentDraftScreenContradictionToast() {}`],
  ]);
  const plugin = {
    name: 'record-context-stubs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => stubs.has(args.path)
        ? { path: args.path, namespace: 'record-context-stub' }
        : null);
      build.onLoad({ filter: /.*/, namespace: 'record-context-stub' }, (args) => ({
        contents: stubs.get(args.path), loader: 'js',
      }));
    },
  };
  const listeners = new Map();
  const ipcRenderer = {
    on(event, listener) { const set = listeners.get(event) || new Set(); set.add(listener); listeners.set(event, set); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
    invoke: async () => ({}),
  };
  global.__recordContextEmit = (event, payload) => {
    for (const listener of [...(listeners.get(event) || [])]) listener({}, payload);
  };
  global.window = { require: () => ({ ipcRenderer }) };
  const built = await esbuild.build({
    stdin: { contents: wrapper, loader: 'ts', resolveDir: repoDir, sourcefile: 'record-context-wrapper.ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent', plugins: [plugin],
  });
  const loaded = new Module(path.join(repoDir, 'record-context-wrapper.cjs'), module);
  loaded.filename = path.join(repoDir, 'record-context-wrapper.cjs');
  loaded.paths = Module._nodeModulePaths(repoDir);
  loaded._compile(built.outputFiles[0].text, loaded.filename);
  return loaded.exports;
}

let bundle;
test.before(async () => { bundle = await buildScenarioBundle(); });

test('record-context stops, writes history, resumes, and never starts a model turn', async () => {
  const { result, events } = await bundle.runRecordContext({
    initialStatus: 'active', sessionId: 'saved-session',
  });
  assert.equal(result.historyOnly, true);
  assert.equal(result.modelTurnStarted, false);
  assert.equal(result.reopened, true);
  assert.deepEqual(events.filter((event) => event[0] === 'stop'), [['stop', 'record-history-context']]);
  assert.deepEqual(events.filter((event) => event[0] === 'record'), [['record', 'record-context-prompt', 'saved-session', null, null]]);
  assert.deepEqual(events.filter((event) => event[0] === 'resume'), [['resume', 'saved-session']]);
  assert.equal(events.some((event) => event[0] === 'send'), false);
  assert.ok(events.findIndex((event) => event[0] === 'stop') < events.findIndex((event) => event[0] === 'record'));
  assert.ok(events.findIndex((event) => event[0] === 'record') < events.findIndex((event) => event[0] === 'resume'));
});

test('sessionless Codex materializes through provider history then resumes that exact session', async () => {
  const { events } = await bundle.runRecordContext({
    initialStatus: 'active', toolType: 'codex', sessionId: null, recordedSessionId: 'codex-created',
  });
  assert.deepEqual(events.filter((event) => event[0] === 'record'), [[
    'record', 'record-context-prompt', null, 'gpt-5.6-sol', 'max',
  ]]);
  assert.deepEqual(events.filter((event) => event[0] === 'bindCodex'), [['bindCodex', 'codex-created']]);
  assert.deepEqual(events.filter((event) => event[0] === 'resume'), [['resume', 'codex-created']]);
  assert.equal(events.some((event) => event[0] === 'startFresh'), false);
  assert.equal(events.some((event) => event[0] === 'send'), false);
});

test('live Codex restart settings come from the same main-owned runtime proof before Stop', async () => {
  const { events } = await bundle.runRecordContext({
    initialStatus: 'active',
    toolType: 'codex',
    sessionId: 'writer-a',
    historyRestartSettings: {
      kind: 'codex-runtime-proof',
      model: 'gpt-5.6-sol',
      effort: 'max',
      owner: { kind: 'writer', id: 'writer-a' },
      proofAt: 123,
    },
  });
  assert.deepEqual(events.filter((event) => event[0] === 'record'), [[
    'record', 'record-context-prompt', 'writer-a', 'gpt-5.6-sol', 'max',
  ]]);
  assert.ok(events.findIndex((event) => event[0] === 'stop')
    < events.findIndex((event) => event[0] === 'record'));
});

test('main-captured settings outrank a stale renderer restart hint', async () => {
  const { result, events } = await bundle.runRecordContext({
    initialStatus: 'active',
    toolType: 'codex',
    sessionId: 'writer-a',
    historyRestartSettings: {
      kind: 'codex-runtime-proof',
      model: 'gpt-5.6-sol',
      effort: 'max',
      owner: { kind: 'writer', id: 'writer-b' },
      proofAt: 123,
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(events.filter((event) => event[0] === 'record'), [[
    'record', 'record-context-prompt', 'writer-a', 'gpt-5.6-sol', 'max',
  ]]);
});

test('conversation-only Ultra keeps record-without-reply available without comparing persistent effort', async () => {
  const { result, events } = await bundle.runRecordContext({
    initialStatus: 'active',
    toolType: 'codex',
    sessionId: 'writer-a',
    stopCapturedEffort: 'ultra',
    historyRestartSettings: {
      kind: 'codex-settings-unavailable',
      reason: 'live-proof-required',
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(events.filter((event) => event[0] === 'record'), [[
    'record', 'record-context-prompt', 'writer-a', 'gpt-5.6-sol', 'ultra',
  ]]);
});

test('proofAt is not compared across renderer and main clocks when pair and owner match', async () => {
  const { result, events } = await bundle.runRecordContext({
    initialStatus: 'active',
    toolType: 'codex',
    sessionId: 'writer-a',
    runtimeProofAt: 5000,
    historyRestartSettings: {
      kind: 'codex-runtime-proof',
      model: 'gpt-5.6-sol',
      effort: 'max',
      owner: { kind: 'writer', id: 'writer-a' },
      proofAt: 7000,
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(events.filter((event) => event[0] === 'record'), [[
    'record', 'record-context-prompt', 'writer-a', 'gpt-5.6-sol', 'max',
  ]]);
});

test('unavailable committed footer returns structured failure and preserves the live process', async () => {
  const { result, events } = await bundle.runRecordContext({
    initialStatus: 'active',
    toolType: 'codex',
    sessionId: 'writer-a',
    stopSettingsProofFailure: 'committed-headless-frame-unavailable',
  });
  assert.equal(result.code, 'codex_history_context_settings_required');
  assert.equal(result.reason, 'committed-headless-frame-unavailable');
  assert.equal(result.submitted, false);
  assert.equal(events.some((event) => event[0] === 'record'), false);
  assert.equal(events.some((event) => event[0] === 'resume'), false);
});

test('stopped Codex settings gap is structured and does not Stop, write, or Resume', async () => {
  for (const reason of ['pair-missing', 'model-migration-pending']) {
    const { result, events } = await bundle.runRecordContext({
      initialStatus: 'inactive',
      toolType: 'codex',
      sessionId: 'writer-a',
      historyRestartSettings: {
        kind: 'codex-settings-unavailable',
        reason,
      },
    });
    assert.equal(result.submitted, false);
    assert.equal(result.code, 'codex_history_context_settings_required');
    assert.equal(result.reason, reason);
    assert.equal(events.some((event) => event[0] === 'stop'), false);
    assert.equal(events.some((event) => event[0] === 'record'), false);
    assert.equal(events.some((event) => event[0] === 'resume'), false);
  }
});

test('technical Claude UUID without conversation is not reused as a false Resume source', async () => {
  const { events } = await bundle.runRecordContext({
    initialStatus: 'active', sessionId: 'technical-id', conversationMaterialized: false, recordedSessionId: 'claude-created',
  });
  assert.deepEqual(events.filter((event) => event[0] === 'record'), [['record', 'record-context-prompt', null, null, null]]);
  assert.deepEqual(events.filter((event) => event[0] === 'resume'), [['resume', 'claude-created']]);
});

test('unknown owner and failed Stop do not mutate provider history', async () => {
  await assert.rejects(bundle.runRecordContext({ initialStatus: 'unknown', sessionId: 'saved' }), /status could not be verified/);
  assert.equal(global.__recordContextState.events.some((event) => event[0] === 'record'), false);
  await assert.rejects(bundle.runRecordContext({ initialStatus: 'active', sessionId: 'saved', stopFailure: true }), /stop failed/);
  assert.equal(global.__recordContextState.events.some((event) => event[0] === 'record'), false);
});

test('live materialized session with missing writer identity fails closed instead of creating a fresh thread', async () => {
  await assert.rejects(
    bundle.runRecordContext({
      initialStatus: 'active',
      sessionId: 'saved',
      presenceSessionId: null,
      conversationMaterialized: true,
    }),
    /live writer session could not be verified/,
  );
  assert.equal(global.__recordContextState.events.some((event) => event[0] === 'record'), false);
});

test('provider rejection does not reopen and does not call ordinary send', async () => {
  await assert.rejects(bundle.runRecordContext({ initialStatus: 'active', sessionId: 'saved', recordFailure: true }), /record failed/);
  const events = global.__recordContextState.events;
  assert.equal(events.some((event) => event[0] === 'resume'), false);
  assert.equal(events.some((event) => event[0] === 'send'), false);
});

test('a recorded row survives reopen failure and is never restored as an unsent draft', async () => {
  const { result, events } = await bundle.runRecordContext({
    initialStatus: 'active', sessionId: 'saved', launchFailure: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.historyRecorded, true);
  assert.equal(result.reopened, false);
  assert.match(result.reopenWarning, /resume failed/);
  assert.equal(events.some((event) => event[0] === 'send'), false);
});

test('record-context waits on one ready edge instead of busy-spinning', async () => {
  const { events } = await bundle.runRecordContext({
    initialStatus: 'active', sessionId: 'saved', startingBeforeReady: true,
  });
  assert.ok(events.filter((event) => event[0] === 'presence').length < 10);
});

test('Cmd-hover is the only alternate gesture and reaches canonical History recording', () => {
  const control = fs.readFileSync(path.join(repoDir, 'src/renderer/components/Workspace/ClaudeControlBar.tsx'), 'utf8');
  const history = fs.readFileSync(path.join(repoDir, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
  assert.match(control, /enterRecordMode[\s\S]*event\.metaKey[\s\S]*sendComposerInput\(\{ recordWithoutReply \}\)/);
  assert.match(control, /rgba\(124,58,237,0\.72\)/);
  assert.doesNotMatch(control, /onContextMenu=\{\(event\)[\s\S]{0,300}recordWithoutReply/);
  assert.match(history, /sendAgentPromptScenario\(\{[\s\S]*recordWithoutReply,[\s\S]*onRestartPhase:/);
  assert.match(history, /const initialQueueStatus = recordWithoutReply[\s\S]*\? 'preparing'/);
  assert.match(history, /recordContextAcceptsFollowup[\s\S]*!recordContextAcceptsFollowup/);
  assert.match(history, /authoringText: rawDraftSnapshot[\s\S]*authoringChips: sourceDraftChips/);
  assert.match(history, /history-context-head-failed[\s\S]*SEND_CASCADE_RESTORE/);
  assert.match(history, /source: 'history-panel'/);
});
