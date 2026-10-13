'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { classifyCodexManualEnterFrame } = require('./codex-model-picker');
const { selectCodexPendingPromptAudit } = require('./codex-prompt-audit');
const { createCodexNativeSettingsIntentTracker } = require('./codex-native-settings-intent');
const {
  projectCodexPublicRuntimeProjection,
  validateCodexPickerRuntimeAdmission,
  codexPasteAuditOwnsInput,
  codexPromptOrTurnInFlightFromSignals,
} = require('./codex-runtime-contract');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const part = name => {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\n}\n', start) + 3;
  assert(start > 0 && end > start);
  return source.slice(start, end);
};
const pickerText = [
  'Select Model',
  '› 1. codex-auto-review (current) Balanced review',
  '  2. All models Choose a specific model',
  'Press enter to confirm or esc to go back',
];

function harness({ frameLines = pickerText } = {}) {
  let generation = 'PTY-A:1';
  let currentFrame = { success: true, lines: frameLines.map(text => ({ text })) };
  const ready = new Set(['T']);
  const meta = new Map([['T', { initializedLifecycleGeneration: generation }]]);
  const command = new Map([['T', { isRunning: true }]]);
  const events = [];
  const context = {
    codexRuntimePolicies: null,
    terminals: new Map(),
    codexSettingsMutationQueue: require('./codex-settings-mutation-queue').createCodexSettingsMutationQueue(),
    classifyCodexManualEnterFrame,
    codexNativeSettingsIntentTracker: createCodexNativeSettingsIntentTracker({
      getScope: () => null, getIntent: () => null, commit: () => assert.fail('no native intent proof in lifecycle fixture'),
    }),
    console: { log() {} },
    getTerminalLifecycleGeneration: () => generation,
    terminalCommandState: command,
    codexTuiReadyTabs: ready,
    codexTuiReadyMeta: meta,
    codexInputControlFrameCache: new WeakMap(),
    getHeadlessTerminalMirror: () => ({ lastCommittedVisibleSnapshot: currentFrame }),
    getHeadlessVisibleBufferSnapshot: () => currentFrame,
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } },
    clearTimeout,
  };
  for (const name of ['clearCodexLateMcpProofPending', 'clearCodexManualActionRequired', 'clearCodexServiceTierProof']) context[name] = () => {};
  for (const name of ['codexLateMcpProofPending', 'codexTuiReadyQuietTimers', 'codexTuiReadyBuffers', 'codexTuiReadyRejectKeys', 'codexTuiReadyLastNotReady']) context[name] = new Map();
  for (const name of ['codexForkComposerSeenTabs', 'codexStartupNoStateTimeoutTabs']) context[name] = new Set();
  const names = ['hasCodexEstablishedComposerLifecycle', 'codexInputControlFromCommittedSnapshot', 'getCodexLiveInputControl', 'isCodexTuiEffectivelyReady', 'resetCodexTuiReadyDetection', 'prepareCodexNativeSettingsIntentInput', 'markCodexNativeSettingsIntentInputWritten', 'tryHandleManualCodexActivePickerEnter'];
  const fns = vm.runInNewContext(names.map(part).join('\n') + '\n({' + names.join(',') + '})', context);
  const projection = (turnBusy = false) => projectCodexPublicRuntimeProjection({
    liveLifecycle: command.get('T').isRunning,
    turnBusy,
    tuiInputReady: fns.isCodexTuiEffectivelyReady('T'),
    tuiLifecycleEstablished: fns.hasCodexEstablishedComposerLifecycle('T'),
    inputControlActive: !!fns.getCodexLiveInputControl('T'),
  });
  return { ...fns, projection, ready, meta, command, events,
    replaceProcess: () => { generation = 'PTY-B:1'; },
    composer: () => {
      currentFrame = { success: true, lines: [{ text: '› Ask Codex to do anything' }, { text: 'gpt-5.6-luna medium · Full Access' }] };
      ready.add('T');
      meta.set('T', { initializedLifecycleGeneration: generation });
    },
  };
}

test('a native model menu closes external input without turning an established process into startup', () => {
  const h = harness();
  assert.deepEqual(h.projection(), { sessionStatus: 'active', busy: false, inputReady: false });
  const writes = [];
  const result = h.tryHandleManualCodexActivePickerEnter('T', { write: data => writes.push(data) }, '\r', 'manual-enter-write-boundary');
  assert.equal(result.pickerKind, 'top-model');
  assert.deepEqual(writes, ['\r']);
  assert.equal(h.ready.has('T'), false, 'old composer proof is still invalidated');
  assert.deepEqual(h.projection(), { sessionStatus: 'active', busy: false, inputReady: false });
  assert.deepEqual(h.projection(true), { sessionStatus: 'busy', busy: true, inputReady: false });
  h.composer();
  assert.deepEqual(h.projection(), { sessionStatus: 'active', busy: false, inputReady: true });
});

for (const selected of [1, 2]) test('actual Main writes promotion choice once through picker control, not generic prompt bookkeeping: ' + selected, () => {
  const h = harness({ frameLines: ['Meet GPT-6 Luna',
    `${selected === 1 ? '›' : ' '} 1. Try new model`,
    `${selected === 2 ? '›' : ' '} 2. Use existing model`, 'enter/esc confirm · ⌃c quit'] });
  const writes = [];
  const result = h.tryHandleManualCodexActivePickerEnter('T', { write: data => writes.push(data) }, '\r', 'manual-enter-write-boundary');
  assert.equal(result.handled, true, 'the actual terminal:input caller returns before beginCodexPromptInFlight');
  assert.equal(result.pickerKind, 'model-promotion');
  assert.deepEqual(writes, ['\r']);
  assert.equal(h.ready.has('T'), false, 'wait for a new actual composer frame');
  const from = source.indexOf("const pickerEnter = tryHandleManualCodexActivePickerEnter(", source.indexOf("const manualOperation = {\n      kind: 'manual-codex-enter'"));
  const until = source.indexOf("const promptInFlight = manualCompactIntentPending", from);
  assert.ok(from > 0 && until > from);
  assert.match(source.slice(from, until), /if \(pickerEnter\.handled\) return;/);
  h.composer();
  assert.deepEqual(h.projection(), { sessionStatus: 'active', busy: false, inputReady: true });
});

test('real startup/reset and replacement process cannot inherit the previous initialized composer', () => {
  const h = harness();
  h.replaceProcess();
  assert.equal(h.hasCodexEstablishedComposerLifecycle('T'), false);
  h.resetCodexTuiReadyDetection('T', 'startup-prompt-resume-goal');
  assert.deepEqual(h.projection(), { sessionStatus: 'starting', busy: false, inputReady: false });
  h.command.set('T', { isRunning: false });
  assert.deepEqual(h.projection(), { sessionStatus: 'inactive', busy: false, inputReady: false });
});

test('picker admission remains sealed to its exact existing generation and input CAS', () => {
  const initial = { sameTerminal: true, expectedRunSeq: 2, currentRunSeq: 2,
    processRunning: true, hasLiveCodexEvidence: true, tuiReady: true,
    hasDraft: false, expectedInputRevision: 7, currentInputRevision: 7 };
  assert.equal(validateCodexPickerRuntimeAdmission(initial).allowed, true);
  assert.equal(validateCodexPickerRuntimeAdmission({ ...initial, currentInputRevision: 8 }).allowed, false);
  assert.equal(validateCodexPickerRuntimeAdmission({ ...initial, currentRunSeq: 3 }).allowed, false);
  const start = source.indexOf('async function executeCodexSelectModelEffortRequest(');
  const body = source.slice(start, source.indexOf("ipcMain.handle('codex:select-model-effort'", start));
  assert.match(body, /pickerInputAdmitted = false/);
  assert.match(body, /pickerInputAdmitted && hasCodexEstablishedComposerLifecycle\(tabId\)/);
  assert.match(body, /pickerInputAdmitted = true;[\s\S]{0,90}const writeGuard/);
});

test('retained unknown audit is not live busy after manual B completed, but active Enter proof still blocks', () => {
  const oldOperation = {};
  const audit = { awaitUserMessage: true, callerTimedOut: true, finished: false, writeOperation: oldOperation,
    expectedText: 'OLD A', expectedLen: 5, expectedHash: 'exact-old-a',
    preSubmitBoundary: { sessionId: 'writer-A', filePath: '/synthetic/rollout-A', fileSize: 10 } };
  const audits = [audit];
  const term = {};
  const active = new WeakMap();
  const prompt = new Map();
  const turn = new Map([['T', { busy: false }]]);
  let compact = null;
  const check = vm.runInNewContext(part('hasCodexPromptOrTurnInFlight') + '\nhasCodexPromptOrTurnInFlight', {
    codexPasteAuditOwnsInput, codexPromptOrTurnInFlightFromSignals,
    terminals: new Map([['T', term]]), ptyActiveWriteOperation: active,
    codexTurnWatchers: turn, getPendingCodexPasteAudits: () => audits,
    codexPromptInFlight: prompt, compactOperations: { getPending: () => compact },
    activityOpenIntervals: new Map(), CODEX_PROMPT_IN_FLIGHT_TTL_MS: 120000,
    clearCodexPromptInFlight: () => prompt.delete('T'),
  });
  assert.equal(check('T'), false);
  assert.equal(audits.length, 1, 'late receipt is retained');
  assert.equal(audit.finished, false, 'unknown receipt is not falsely resolved');
  assert.equal(selectCodexPendingPromptAudit(audits, {
    actualText: 'OLD A', actualHash: 'exact-old-a',
    actualIdentity: { sessionId: 'writer-A', filePath: '/synthetic/rollout-A', byteOffset: 20 },
  })?.audit, audit,
    'late exact A still finds the same retained audit after B completed');
  active.set(term, oldOperation);
  assert.equal(check('T'), true, 'physical operation still owns its boundary, even after caller timeout');
  active.delete(term);
  turn.set('T', { busy: true });
  assert.equal(check('T'), true);
  turn.set('T', { busy: false });
  prompt.set('T', { startedAt: Date.now() });
  assert.equal(check('T'), true);
  prompt.clear();
  compact = { operationId: 'compact' };
  assert.equal(check('T'), true);
});
