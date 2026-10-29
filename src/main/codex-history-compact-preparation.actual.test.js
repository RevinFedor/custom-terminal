'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { fixture, tick } = require('./fixtures/compact-preparation.cjs');
const rendererRoot = path.resolve(__dirname, '../renderer/utils');
const rendererSourceRoot = process.env.COMPACT_RENDERER_SOURCE_DIR || rendererRoot;

function declaration(file, names) {
  const source = fs.readFileSync(path.join(rendererSourceRoot, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name
      || ts.isVariableStatement(item) && item.declarationList.declarations.some(d => d.name.getText(ast) === name));
    assert.ok(node, file + ':' + name);
    return node.getText(ast).replace(/^export /, '');
  }).join('\n');
}

// Actual shared scenario → adapter → composer preflight → actual renderer
// Codex transport/probe → actual Main Compact/PTY serializer/SQLite registry.
// Readiness and current screen/CLI/OS leaves are controlled, not a live CLI.
// No substituted successful sender and no replacement timeout/proof algorithm.
async function joined(t, { prompt = '/compact', presentationSnapshot, draftProof, toolType = 'codex' } = {}) {
  const h = fixture(t);
  const ipc = [], probes = [], logs = [], captures = [];
  let cancel = null;
  const modules = Object.assign({},
    await import('../renderer/utils/agentSendFlow.mjs'),
    await import('../renderer/utils/agentSendOutcome.mjs'),
    await import('../renderer/utils/agentDraftPreflight.mjs'),
    await import('../renderer/utils/agentDraftTransfer.mjs'),
    await import('../renderer/utils/codexDraftAuthority.mjs'),
    await import('../renderer/utils/codexLocalSlashCommand.mjs'),
    await import('../renderer/utils/codexHistorySettingsPlan.mjs'));
  const context = vm.createContext({ ...modules,
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    codexSendInflight: new Map(), shortTab: value => value,
    findTabRuntimeContext: () => ({ projectId: 'fixture' }),
    errorText: error => error?.message || String(error),
    useWorkspaceStore: { getState: () => ({ clearInterruptedState() {} }) },
    useUIStore: { getState: () => ({}) },
    terminalRegistry: { get: () => ({}), getDraftDiagnosticSnapshot: () => ({}),
      getCodexDraftState: () => ({ hasDraft: null, source: 'no-renderer', preview: '' }) },
    ipcRenderer: { invoke: async (channel, ...args) => {
      ipc.push({ channel, args });
      if (channel === 'codex:get-draft-state') {
        probes.push(args[1]);
        return draftProof || h.ctx.requestTerminalCodexDraftState(null, 'T', args[1].reason,
          args[1].timeoutMs, args[1]);
      }
      if (channel === 'codex:send-live-slash-command') {
        // Addressing and native task_started proof are controlled fixture
        // leaves. The actual runtime carries the original H and no Send A/O.
        return h.ctx.executeCodexLiveSlashCommandRequest({ sender: null, ...args[0] });
      }
      assert.fail('unexpected IPC: ' + channel);
    } },
    prepareAgentRecordContext: async () => ({ complete: false, historyContextResult: null, restartPerformed: false }),
    prepareAgentRuntimeForSend: async () => ({ status: 'active', submitCapability: 'direct', presence: {} }),
    getCoordinatedAgentSendCancellation: () => cancel,
    agentSendSettingsContractError: () => null,
    getAgentSendProviderContract: () => ({ toolType, carriesExactEmptyEvidence: false,
      passCancellationGuardToTransport: false }),
    showAgentDraftScreenContradictionToast() {},
    isSubmittedCodexAuditTimeout: () => false,
  });
  const code = [
    declaration('agentSendPreparation.ts', ['needsExactDraftCapture', 'buildDraftCaptureProof', 'captureDraftWithOneCommittedFrameRefresh',
      'proveAgentComposerForSend']),
    declaration('agentSendAdapter.ts', ['createAgentSendAdapter']),
    declaration('historyAgentRuntimes.ts', ['sendCodexPrompt', 'probeCodexDraft']),
    declaration('agentScenarios.ts', ['normalizeStatus', 'runAgentPromptScenario']),
  ].join('\n');
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS } }).outputText, context);
  const runtime = { toolType, label: toolType, probeDraft: context.probeCodexDraft,
    sendPrompt: context.sendCodexPrompt,
    grabDraft: async () => { captures.push('grab'); return { success: true, text: 'controlled authoring', images: 0 }; },
    copyDraft: async () => { captures.push('copy'); return { success: true, text: 'controlled authoring', images: 0 }; } };
  const originalReceipt = JSON.stringify(h.store.get(h.identity.operationKey));
  return { ...h, context, ipc, probes, logs, captures, originalReceipt,
    cancelBeforeTransport() { cancel = { cancelReason: 'controlled-cancel' }; },
    start: () => context.runAgentPromptScenario({ tabId: 'T', toolType, runtime, prompt,
      handoffId: 'H', source: 'history-panel', statusAtSend: 'active',
      coordinatedSendToken: 1, settingsIntent: { kind: 'none' }, presentationSnapshot }),
  };
}

test('History Compact: real preflight expiry is NOT final; existing Main operation waits for late empty then ONE paste/Enter', async t => {
  const h = await joined(t); h.open();
  let done = false;
  const pending = h.start().then(result => { done = true; return result; });
  await tick(160); h.clock.advance(2600); await tick(240);
  assert.equal(done, false, 'short diagnostic observation must hand pending Compact to its existing Main owner');
  assert.equal(h.writes.length, 0);
  assert.equal(h.ctx.held(), false, 'frame wait is outside PTY lock');
  assert.equal(h.ipc.filter(call => call.channel === 'codex:send-live-slash-command').length, 1);
  assert.equal(h.probes.length, 1, 'runtime does not add a second 2.5s gate before Main Compact');
  h.clock.advance(1200); h.frame(''); await tick(240);
  assert.equal(h.writes.length, 1);
  h.clock.advance(3100); await tick(160); assert.equal(done, false);
  h.frame(); const result = await pending;
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.compactStartConfirmed, true);
  assert.equal(result.localCommandProof, 'codex-compact-causal-task-started');
  const request = h.ipc.find(call => call.channel === 'codex:send-live-slash-command').args[0];
  assert.equal(request.handoffId, 'H'); assert.equal(request.sendAttemptId, null);
  assert.equal(request.sendOperationKey, null); assert.equal(request.requireEmptyComposer, true);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  assert.equal(h.store.list({ tabId: 'T', handoffId: 'H' }).length, 1,
    'unrelated synthetic receipt count unchanged; local command did not create an ordinary Send attempt');
  assert.equal(JSON.stringify(h.store.get(h.identity.operationKey)), h.originalReceipt,
    'the local command did not refine the unrelated synthetic ordinary Send receipt');
});

test('History Compact: late real foreign draft is retained untouched, not stashed under deferred unknown', async t => {
  const h = await joined(t); h.open();
  const pending = h.start(); await tick(160); h.clock.advance(2600); await tick(240);
  h.frame('foreign unsent draft'); await tick(240);
  const result = await pending;
  assert.equal(result.code, 'terminal_draft_conflict', JSON.stringify(result));
  assert.equal(result.submitted, false); assert.equal(result.pasteWritten, false);
  assert.equal(result.draftPreserved, true);
  assert.equal(h.writes.length, 0);
  assert.equal(h.registry.getPending('T'), null);
});

for (const what of ['input', 'stop', 'owner']) test('History Compact: ' + what + ' revokes the actual joined pre-insert wait', async t => {
  const h = await joined(t); h.open(); const pending = h.start();
  await tick(160); h.clock.advance(2600); await tick(240);
  assert.equal(h.ipc.filter(call => call.channel === 'codex:send-live-slash-command').length, 1);
  h.change(what); h.frame(''); await tick(240); const result = await pending;
  assert.notEqual(result.submitted, true, JSON.stringify(result));
  assert.equal(h.writes.length, 0); assert.equal(h.registry.getPending('T'), null);
});

test('History Compact: cancellation before handoff does not enter Main or revive on late frame', async t => {
  const h = await joined(t); h.open(); const pending = h.start();
  await tick(160); h.cancelBeforeTransport(); h.clock.advance(2600); await tick(240);
  await assert.rejects(pending, /Send cancelled before terminal submission/);
  h.frame(''); await tick(120); assert.equal(h.writes.length, 0);
  assert.equal(h.ipc.filter(call => call.channel === 'codex:send-live-slash-command').length, 0);
});

test('History Compact: cancellation during the Main-only pending lifetime stops before any input', async t => {
  const h = await joined(t); let cancelled = false;
  h.ctx.agentSendCancellations.isCancelled = () => cancelled;
  h.open(); const pending = h.start(); await tick(160); h.clock.advance(2600); await tick(240);
  assert.equal(h.ipc.filter(call => call.channel === 'codex:send-live-slash-command').length, 1);
  cancelled = true; h.frame(''); await tick(240); const result = await pending;
  assert.equal(result.code, 'agent_send_cancelled'); assert.equal(result.submitted, false);
  assert.equal(h.writes.length, 0); assert.equal(h.registry.getPending('T'), null);
});

test('History Compact: an already current empty composer has no new fixed delay', async t => {
  const h = await joined(t); const at = h.clock.now(); const pending = h.start(); await tick(240);
  assert.equal(h.writes.length, 1, h.logs.join('\n'));
  assert.equal(h.clock.now(), at); assert.equal(h.probes.length, 1);
  h.frame(); const result = await pending;
  assert.equal(result.success, true); assert.equal(h.writes.length, 2);
});

test('History Compact: a positive draft still takes the pre-existing exact capture/refusal path before Main', async t => {
  const h = await joined(t, { draftProof: { success: true, hasDraft: true, preview: 'controlled authoring',
    proofOutcome: 'found', source: 'headless-main:cursor:10' } });
  const result = await h.start();
  assert.equal(result.code, 'terminal_draft_conflict', JSON.stringify(result));
  assert.deepEqual(h.captures, ['copy']);
  assert.equal(result.submitted, false); assert.equal(h.writes.length, 0);
  assert.equal(h.ipc.filter(call => call.channel === 'codex:send-live-slash-command').length, 0);
});

for (const proof of [
  { source: 'no-headless-mirror' },
  { source: 'headless-main:codex:observation-expired', observation: { status: 'expired' }, proofReason: 'deadline' },
  { source: 'headless-main:native-rewind-overlay', frameBlocker: 'synchronized-output-open',
    observation: { status: 'expired' }, proofReason: 'deadline' },
  { source: 'headless-main:codex:observation-expired', frameBlocker: 'synchronized-output-open',
    observation: { status: 'expired' }, proofReason: 'deadline', preparationFailure: { code: 'unrecognized-marker' } },
]) test('History Compact: opaque/foreign/control/preparation unknown is not a pending-frame handoff: ' + proof.source, async t => {
  const h = await joined(t, { draftProof: { success: false, hasDraft: null, ...proof } });
  const result = await h.start(); assert.equal(result.code, 'terminal_draft_state_unknown');
  assert.equal(h.writes.length, 0);
  assert.equal(h.ipc.filter(call => call.channel === 'codex:send-live-slash-command').length, 0);
});

for (const status of ['superseded', 'cancelled']) test('History Compact: ' + status + ' read is never delegated as pending frame', async t => {
  const h = await joined(t, { draftProof: { success: false, hasDraft: null,
    source: 'headless-main:codex:observation-expired', proofReason: 'deadline',
    frameBlocker: 'synchronized-output-open', observation: { status } } });
  const result = await h.start(); assert.equal(result.code, 'terminal_draft_state_unknown');
  assert.equal(h.ipc.filter(call => call.channel === 'codex:send-live-slash-command').length, 0);
  assert.equal(h.writes.length, 0);
});

for (const code of ['agent_send_preparation_expired', 'agent_send_cancelled', 'agent_send_preparation_superseded']) {
  test('History Compact: real preparation refusal ' + code + ' cannot become another preparation', async t => {
    const h = await joined(t, { draftProof: { success: false, hasDraft: null, proofReason: 'deadline',
      source: 'headless-main:codex:observation-expired', frameBlocker: 'synchronized-output-open',
      observation: { status: 'expired' }, preparationFailure: { code } } });
    const result = await h.start(); assert.equal(result.code, code);
    assert.equal(h.ipc.filter(call => call.channel === 'codex:send-live-slash-command').length, 0);
    assert.equal(h.writes.length, 0);
  });
}

for (const options of [
  { prompt: 'ordinary message' }, { prompt: '/fast' }, { prompt: '/compact\nbody' },
  { presentationSnapshot: { imagePaths: [{ path: '/synthetic/A.png' }] } },
  { presentationSnapshot: { promptChips: [{ kind: 'prompt', text: 'synthetic' }] } },
  { toolType: 'claude' },
]) test('non-Compact/attachment/provider keeps original unknown-frame refusal: ' + JSON.stringify(options), async t => {
  const h = await joined(t, options); h.open(); const pending = h.start();
  await tick(160); h.clock.advance(2600); await tick(240);
  const result = await pending;
  assert.equal(result.code, 'terminal_draft_state_unknown'); assert.equal(result.submitted, false);
  assert.equal(h.ipc.filter(call => call.channel === 'codex:send-live-slash-command').length, 0);
  assert.equal(h.writes.length, 0);
});

test('History Compact: short-read expiry does not renew existing Main60s when close arrives after expiry', async t => {
  const h = await joined(t); h.open(); let done = false;
  const pending = h.start().then(result => { done = true; return result; });
  await tick(160); h.clock.advance(2600); await tick(240);
  assert.equal(done, false);
  h.clock.advance(60000); await tick(240); const result = await pending;
  assert.equal(result.code, 'agent_send_preparation_expired', JSON.stringify(result));
  h.frame(''); await tick(120); assert.equal(h.writes.length, 0);
  assert.equal(h.ctx.held(), false); assert.equal(h.mirror.synchronizedFrameWaiters.size, 0);
});
