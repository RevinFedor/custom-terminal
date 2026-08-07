'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const {
  reserveClaudeExactEmptyEvidence,
} = require('../../main/claude-composer-proof');

const repoDir = path.join(__dirname, '../../..');
const agentScenariosPath = path.join(__dirname, 'agentScenarios.ts');
const claudeActionsPath = path.join(__dirname, 'claudePtyActions.ts');
const agentActionCoordinatorPath = path.join(__dirname, 'agentActionCoordinator.mjs');
const mainSource = fs.readFileSync(path.join(repoDir, 'src/main/main.js'), 'utf8');

test('F6 physical Think picker owns the shared PTY queue and advances input identity', () => {
  const start = mainSource.indexOf("ipcMain.handle('claude:toggle-thinking'");
  const end = mainSource.indexOf('// Claude rewind through the native', start);
  assert.ok(start >= 0 && end > start, 'Claude Think IPC handler not found');
  const handler = mainSource.slice(start, end);
  assert.match(handler, /withPtyWriteLock\(term/,
    'Think writes must be serialized with prompt, Replay, compact, and settings writes');
  assert.match(handler, /manualInputYields: true/,
    'a physical user key must be able to take ownership from picker automation');
  assert.match(handler, /ownedInputRevision = bumpTerminalInputRevision\(tabId\)/,
    'opening the picker must invalidate composer proofs captured before the UI mutation');
  assert.match(handler, /getTerminalInputRevision\(tabId\) === ownedInputRevision/,
    'every later picker write must still belong to the exact input generation');
  assert.match(handler, /waitForNextPtySynchronizedFrame\(term/,
    'picker writes must wait for the next synchronized Claude frame');
  assert.match(handler, /getHeadlessVisibleBufferSnapshot\(/,
    'picker state must come from the complete main-owned visible frame');
  assert.match(handler, /inspectClaudeThinkingPickerSnapshot\(/,
    'picker state must be classified from the current full frame, not a differential output chunk');
  assert.match(handler, /think_verify_open/,
    'a changed setting must be read back before the following prompt is authorized');
});

async function buildScenarioBundle() {
  const wrapper = `
    import { sendAgentPromptScenario } from ${JSON.stringify(agentScenariosPath)};
    import { sendClaudePtyPrompt } from ${JSON.stringify(claudeActionsPath)};
    import {
      beginCoordinatedAgentSend,
      requestCoordinatedStopAfterSend,
      resetCoordinatedAgentActionsForTests,
    } from ${JSON.stringify(agentActionCoordinatorPath)};

    export function beginScenarioSend() {
      resetCoordinatedAgentActionsForTests();
      return beginCoordinatedAgentSend('phase2-f6-tab');
    }

    export function cancelScenarioSend() {
      return requestCoordinatedStopAfterSend('phase2-f6-tab');
    }

    export async function runClaudeScenario(options = {}) {
      const state = globalThis.__phase2F6State;
      const identity = () => ({
        terminalRunSeq: 9,
        inputRevision: state.inputRevision,
        terminalLifecycleGeneration: 'phase2-f6-lifecycle',
        mirrorGeneration: 'phase2-f6-mirror',
      });
      const runtime = {
        toolType: 'claude',
        label: 'Claude',
        lowerLabel: 'claude',
        logPrefix: 'Phase2F6',
        busyEvent: 'claude:busy-state',
        supportsQuestions: true,
        supportsInterruptRecovery: true,
        allowSendWhileBusy: true,
        optimisticBusyOnSend: false,
        optimisticActiveOnInterrupt: false,
        getPresence: async () => {
          state.events.push({ kind: 'presence', inputRevision: state.inputRevision });
          return { status: 'active', inputReady: true, isBusy: false };
        },
        probeDraft: async () => {
          state.events.push({ kind: 'composer-proof-screen', inputRevision: state.inputRevision });
          if (options.screenProof === 'unknown-no-capture') {
            return {
              success: true,
              proofOutcome: 'unknown',
              proofReason: 'cursor-before-composer',
              hasDraft: null,
              text: '',
              preview: '',
              source: 'headless-main:claude-composer:unknown:cursor-before-composer',
              exactCaptureRecommended: false,
              ...identity(),
            };
          }
          if (options.screenProof === 'missing') {
            return {
              success: true,
              proofOutcome: 'unknown',
              proofReason: 'active-prompt-not-found',
              hasDraft: null,
              text: '',
              preview: '',
              source: 'headless-main:claude-composer:unknown:active-prompt-not-found',
              exactCaptureRecommended: true,
              ...identity(),
            };
          }
          return {
            success: true,
            proofOutcome: 'found',
            hasDraft: true,
            text: 'residual-cell false positive',
            preview: 'residual-cell false positive',
            source: 'headless-main:claude-composer:found',
            exactCaptureRecommended: true,
            ...identity(),
          };
        },
        copyDraft: async () => {
          state.events.push({ kind: 'composer-proof-exact', inputRevision: state.inputRevision });
          return {
            success: true,
            proofOutcome: 'absent',
            hasDraft: false,
            text: '',
            images: 0,
            terminalIdentityStable: true,
            editorReturnReady: true,
            source: 'headless-main:claude-composer:empty-exact-editor',
            ...identity(),
          };
        },
        grabDraft: async () => ({ success: false, error: 'unexpected grab' }),
        inspectDraft: () => ({ proofOutcome: 'unknown', hasDraft: null, source: 'unused' }),
        resume: async () => ({ success: true }),
        sendPrompt: sendClaudePtyPrompt,
        interruptTurn: () => ({ success: true }),
        stopProcess: async () => ({ success: true }),
      };
      return sendAgentPromptScenario({
        tabId: 'phase2-f6-tab',
        toolType: 'claude',
        runtime,
        prompt: 'phase2 user prompt',
        handoffId: options.handoffId || 'phase2-f6-handoff',
        source: 'terminal-mcp',
        statusAtSend: 'active',
        model: options.model,
        effort: options.effort,
        thinking: options.thinking,
        coordinatedSendToken: options.coordinatedSendToken,
      });
    }
  `;
  const stubPlugin = {
    name: 'phase2-f6-renderer-stubs',
    setup(build) {
      const stubs = new Map([
        ['../store/useWorkspaceStore', `
          export const useWorkspaceStore = {
            getState: () => ({ clearInterruptedState() {} }),
          };
        `],
        ['../store/useUIStore', `
          export const useUIStore = { getState: () => ({}) };
        `],
        ['./claudeStartupDefaultsReady', `
          export async function waitForClaudeStartupDefaultsReadyWithVisibleFallback() {}
        `],
        ['./terminalRegistry', `
          export const terminalRegistry = new Map();
        `],
        ['./codexRewindCommit', `
          export async function requireCommittedCodexRewind() { return true; }
        `],
        ['./codexWriterIdentity', `
          export async function requireConfirmedCodexWriter() { return true; }
        `],
        ['../store/rewindOperationState', `
          export function selectRewindOperation() { return null; }
        `],
        ['../store/useRewindOperationStore', `
          export const useRewindOperationStore = { getState: () => ({}) };
        `],
      ]);
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!stubs.has(args.path)) return null;
        return { path: args.path, namespace: 'phase2-f6-stub' };
      });
      build.onLoad({ filter: /.*/, namespace: 'phase2-f6-stub' }, (args) => ({
        contents: stubs.get(args.path),
        loader: 'js',
      }));
    },
  };
  const result = await esbuild.build({
    stdin: {
      contents: wrapper,
      loader: 'ts',
      resolveDir: repoDir,
      sourcefile: 'phase2-f6-wrapper.ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins: [stubPlugin],
  });
  const loaded = new Module(path.join(repoDir, 'phase2-f6-wrapper.cjs'), module);
  loaded.filename = path.join(repoDir, 'phase2-f6-wrapper.cjs');
  loaded.paths = Module._nodeModulePaths(repoDir);
  loaded._compile(result.outputFiles[0].text, loaded.filename);
  return loaded.exports;
}

function resetState() {
  const state = {
    inputRevision: 30,
    events: [],
    lastPaste: null,
  };
  global.__phase2F6State = state;
  global.window.__thinkStateForTab = new Map();
  return state;
}

test('F6 complete shared scenario -> Claude runtime -> IPC path reproves after settings and Think', async (t) => {
  const previousWindow = global.window;
  const previousState = global.__phase2F6State;
  global.window = {
    __thinkStateForTab: new Map(),
    setTimeout,
    require: () => ({
      ipcRenderer: {
        send() {},
        on() {},
        removeListener() {},
        invoke: async (channel, ...args) => {
          const state = global.__phase2F6State;
          if (channel === 'claude:send-command') {
            state.events.push({ kind: 'setting-write', command: args[1], inputRevision: state.inputRevision });
            state.inputRevision += 1;
            return { success: true, submitted: true, startupSettingClaimId: state.inputRevision };
          }
          if (channel === 'claude:startup-slash-proof') {
            state.events.push({ kind: 'setting-jsonl-proof', inputRevision: state.inputRevision });
            if (state.cancelOnSettingProof) {
              const cancel = state.cancelOnSettingProof;
              state.cancelOnSettingProof = null;
              cancel();
            }
            return {
              success: true,
              reason: 'jsonl-proof-found',
              sessionId: 'phase2-f6-session',
              timestamp: new Date().toISOString(),
            };
          }
          if (channel === 'claude:set-setting-claim-result') return { success: true };
          if (channel === 'claude:toggle-thinking') {
            state.events.push({ kind: 'thinking-mutation', inputRevision: state.inputRevision });
            // The real main reserves a new input generation for the picker.
            state.inputRevision += 1;
            return state.thinkingResult || { success: true, thinking: false };
          }
          if (channel === 'terminal:paste') {
            const payload = args[0];
            const before = state.inputRevision;
            const reserved = reserveClaudeExactEmptyEvidence({
              evidence: payload.claudeExactEmptyEvidence,
              currentInputRevision: before,
              reservedInputRevision: before + 1,
              currentRunSeq: 9,
              currentLifecycleGeneration: 'phase2-f6-lifecycle',
              currentMirrorGeneration: 'phase2-f6-mirror',
            });
            state.inputRevision = before + 1;
            state.lastPaste = { payload, reserved };
            state.events.push({
              kind: 'physical-paste-boundary',
              inputRevision: state.inputRevision,
              exactProofReserved: Boolean(reserved),
            });
            if (!reserved) {
              return {
                success: false,
                submitted: false,
                pasteWritten: false,
                error: 'terminal_draft_state_unknown',
              };
            }
            return { success: true, submitted: true, pasteWritten: true };
          }
          throw new Error('Unexpected F6 IPC channel: ' + channel);
        },
      },
    }),
  };
  t.after(() => {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousState === undefined) delete global.__phase2F6State;
    else global.__phase2F6State = previousState;
  });

  const scenario = await buildScenarioBundle();

  await t.test('F6 model/effort: fresh exact composer proof must follow the last settings mutation', async () => {
    const state = resetState();
    const result = await scenario.runClaudeScenario({
      handoffId: 'phase2-f6-settings',
      model: 'opus',
      effort: 'high',
    });
    const lastMutation = Math.max(...state.events
      .map((entry, index) => entry.kind === 'setting-write' ? index : -1));
    const lastComposerProof = Math.max(...state.events
      .map((entry, index) => entry.kind === 'composer-proof-exact' ? index : -1));

    assert.deepEqual({
      freshProofAfterSettings: lastComposerProof > lastMutation,
      proofReservedAtPhysicalPaste: Boolean(state.lastPaste?.reserved),
      submitted: result?.submitted === true,
    }, {
      freshProofAfterSettings: true,
      proofReservedAtPhysicalPaste: true,
      submitted: true,
    }, 'User-visible invariant violated: changing Claude model/effort must finish first, then obtain a fresh exact empty-composer proof before the user prompt is physically submitted.');
  });

  await t.test('F6 strongest settings counterexample: no setting mutation keeps the exact proof valid', async () => {
    const state = resetState();
    const result = await scenario.runClaudeScenario({ handoffId: 'phase2-f6-no-settings' });
    assert.equal(state.events.some((entry) => entry.kind === 'setting-write'), false);
    assert.equal(Boolean(state.lastPaste?.reserved), true);
    assert.equal(result?.submitted, true);
  });

  await t.test('Stop after /model proof cancels the remaining /effort and user prompt writes', async () => {
    const state = resetState();
    const coordinated = scenario.beginScenarioSend();
    assert.equal(coordinated.started, true);
    state.cancelOnSettingProof = () => scenario.cancelScenarioSend();

    const result = await scenario.runClaudeScenario({
      handoffId: 'phase2-f6-cancel-settings-bundle',
      model: 'opus',
      effort: 'high',
      coordinatedSendToken: coordinated.token,
    });
    assert.deepEqual({
      success: result?.success,
      error: result?.error,
    }, {
      success: false,
      error: 'Send cancelled before terminal submission',
    });

    assert.deepEqual({
      settingWrites: state.events
        .filter((entry) => entry.kind === 'setting-write')
        .map((entry) => entry.command),
      physicalPasteCount: state.events.filter((entry) => (
        entry.kind === 'physical-paste-boundary'
      )).length,
    }, {
      settingWrites: ['/model opus'],
      physicalPasteCount: 0,
    }, 'Stop must cancel the rest of the settings transaction before /effort or the user prompt reaches the PTY.');
  });

  await t.test('F6 missing prompt marker uses exact empty capture and still submits once', async () => {
    const state = resetState();
    const result = await scenario.runClaudeScenario({
      handoffId: 'phase2-f6-missing-prompt',
      screenProof: 'missing',
    });
    assert.deepEqual({
      exactCaptureCount: state.events.filter((entry) => (
        entry.kind === 'composer-proof-exact'
      )).length,
      physicalPasteCount: state.events.filter((entry) => (
        entry.kind === 'physical-paste-boundary'
      )).length,
      proofReservedAtPhysicalPaste: Boolean(state.lastPaste?.reserved),
      submitted: result?.submitted === true,
    }, {
      exactCaptureCount: 1,
      physicalPasteCount: 1,
      proofReservedAtPhysicalPaste: true,
      submitted: true,
    });
  });

  await t.test('preflight uncertainty is an exact no-Enter receipt', async () => {
    const state = resetState();
    const result = await scenario.runClaudeScenario({
      handoffId: 'phase2-f6-preflight-refusal',
      screenProof: 'unknown-no-capture',
    });
    assert.deepEqual({
      code: result?.code,
      submitted: result?.submitted,
      accepted: result?.accepted,
      physicalPasteReached: Boolean(state.lastPaste),
    }, {
      code: 'terminal_draft_state_unknown',
      submitted: false,
      accepted: false,
      physicalPasteReached: false,
    }, 'A refusal before the prompt runtime is called must release orchestration serialization safely.');
  });

  await t.test('F6 Think: successful picker mutation must not reuse the proof captured before the picker', async () => {
    const unfinishedState = resetState();
    global.window.__thinkStateForTab.set('phase2-f6-tab', true);
    unfinishedState.thinkingResult = {
      success: false,
      error: 'think_post_confirm_timeout',
    };
    const unfinished = await scenario.runClaudeScenario({
      handoffId: 'phase2-f6-thinking-unfinished',
      thinking: 'disabled',
    });
    assert.deepEqual({
      code: unfinished?.code,
      submitted: unfinished?.submitted === true,
      physicalPasteReached: Boolean(unfinishedState.lastPaste),
    }, {
      code: 'claude_thinking_state_unknown',
      submitted: false,
      physicalPasteReached: false,
    }, 'User-visible invariant violated: an unfinished Think picker must remain unknown and must not submit the following prompt.');

    const state = resetState();
    const result = await scenario.runClaudeScenario({
      handoffId: 'phase2-f6-thinking-toggle',
      thinking: 'disabled',
    });
    const thinkIndex = state.events.findIndex((entry) => entry.kind === 'thinking-mutation');
    const proofAfterThink = state.events.findIndex((entry, index) => (
      index > thinkIndex && entry.kind === 'composer-proof-exact'
    ));

    assert.deepEqual({
      thinkMutated: thinkIndex >= 0,
      proofAfterThink: proofAfterThink >= 0,
      freshProofReserved: Boolean(state.lastPaste?.reserved),
      submitted: result?.submitted === true,
    }, {
      thinkMutated: true,
      proofAfterThink: true,
      freshProofReserved: true,
      submitted: true,
    }, 'User-visible invariant violated: a Think picker operation must return to a freshly proven empty composer before the following prompt can reuse exact-proof authority.');
  });

  await t.test('F6 strongest Think counterexample: requesting the already-enabled state performs no picker mutation', async () => {
    const state = resetState();
    global.window.__thinkStateForTab.set('phase2-f6-tab', true);
    const result = await scenario.runClaudeScenario({
      handoffId: 'phase2-f6-thinking-noop',
      thinking: 'enabled',
    });
    assert.equal(state.events.some((entry) => entry.kind === 'thinking-mutation'), false);
    assert.equal(Boolean(state.lastPaste?.reserved), true);
    assert.equal(result?.submitted, true);
  });
});
