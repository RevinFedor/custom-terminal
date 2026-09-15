'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { createClaudeStartupMainRuntime } = require('./claude-startup-main-runtime');
const { createClaudeSettingsSendRuntime } = require('./claude-settings-send');
const { parseClaudeStartupSlashCommand } = require('./claude-startup-slash-proof');
const { projectClaudePtyPresence } = require('./claude-pty-presence');
const { claudeParamsOperationOutcome } = require('./claude-settings-outcome');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const quiet = { log() {}, warn() {}, error() {} };
function declaration(name) {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, 'actual main declaration ' + name);
  return node.getText(ast);
}
function registration(channel) {
  const node = ast.statements.find(item => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression)
    && item.expression.expression.getText(ast) === 'ipcMain.handle' && item.expression.arguments[0]?.text === channel);
  assert.ok(node, 'actual IPC registration ' + channel);
  return node.getText(ast);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { resolve, promise };
}
const found = (value, kind = 'model') => ({ success: true, outcome: 'found', reason: 'jsonl-stdout',
  actualValue: value, requestSatisfied: true, sessionId: 'S',
  observed: kind === 'model' ? { label: value, modelId: null, contextTokens: null } : { label: value, effort: value } });
const rejected = message => ({ success: false, outcome: 'unresolved', terminal: true,
  failureCode: 'claude_rate_limit', outputText: message });
const different = (value, kind = 'model') => ({ success: true, outcome: 'found', terminal: true,
  reason: 'jsonl-stdout', actualValue: value, requestSatisfied: false, sessionId: 'S',
  observed: kind === 'model' ? { label: value, modelId: null, contextTokens: null }
    : { label: value, effort: value } });
const unknown = () => ({ success: false, outcome: 'unresolved', reason: 'stdout-not-found' });

// These tests execute the real main capture -> main send/claim function ->
// main outcome forwarder -> existing startup coordinator, plus the actual main
// settings-helper wiring, PTY mutex, gate publisher and dismissal IPC. Only
// transport, evidence-capability creation and provider proof are fixture leaves.
// All deadline time is virtual; there is no app, process, UI or provider call.
function fixture({ startupSettings = { model: 'unavailable', effort: 'max' }, proofFor } = {}) {
  const events = new EventEmitter();
  const handlers = new Map();
  const tokens = new Map();
  const commands = [];
  const outcomes = [];
  const captures = [];
  const settlements = [];
  const lateWaits = [];
  const notifications = [];
  const parkedPromptFlushes = [];
  let clock = 10000;
  let tokenSequence = 0;
  const term = {};
  let lifecycle = 'LC';
  const ctx = vm.createContext({
    console: quiet, crypto, path, srcMainDir: __dirname, Date,
    parseClaudeStartupSlashCommand, projectClaudePtyPresence, claudeParamsOperationOutcome,
    terminals: new Map([['T', term]]),
    claudeLaunchGenerationByTab: new Map([['T', { generation: 'L' }]]),
    terminalCommandState: new Map([['T', { runSeq: 1 }]]),
    getTerminalLifecycleGeneration: () => lifecycle,
    aiStoppingTabs: new Map(),
    bridgeKnownSessions: new Map([['T', 'S']]), claudeCliActive: new Map([['T', true]]),
    claudeTurnBusy: new Map(), claudeLocalCommandWatchers: new Map(), claudePromptReady: new Set(['T']),
    claudeStartupIntents: new Map(), claudeAwaitingInput: new Map(),
    claudeStartupDefaultsGateByTab: new Map(), claudeStartupGateRevisions: new Map(),
    projectManager: null, scheduleProjectLayoutBroadcast() {}, scheduleProjectActivityBroadcast() {},
    _webBroadcast: (_tab, payload) => notifications.push(payload),
    emitAgentReadinessChanged() {}, consumeClaudeStartupIntent() {},
    flushClaudePendingPromptAfterStartup: (...args) => parkedPromptFlushes.push(args),
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => notifications.push(args) } },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    agentSendReceiptStore: null, agentSendCancellations: { isCancelled: () => false },
    aiProcessLookupScopeCurrent: () => true,
    claudeDataApi: { getConfirmedSettings: async () => ({ sessionId: 'S' }) },
    confirmClaudeSettingsDialogFromCurrentFrame: async () => ({ confirmed: false }),
    inspectClaudeExactSettingInput: async () => assert.fail('a submitted settings command cannot get another Enter'),
    toggleClaudeThinkingInternal: async () => assert.fail('no thinking request in this fixture'),
    safePasteAndSubmit: async () => assert.fail('a settings outcome must never flush a user prompt'),
    beginAgentSettingsActivity: () => null, agentSettingsActivity: { end() {} },
  });
  const lockStart = source.indexOf('const pasteInflight = new WeakMap();');
  const lockEnd = source.indexOf('\nfunction markActivePtySubmit(', lockStart);
  assert.ok(lockStart > 0 && lockEnd > lockStart);
  vm.runInContext(source.slice(lockStart, lockEnd), ctx);
  const queue = vm.runInContext('({ withPtyWriteLock, ptyWriteOwners, pasteInflight })', ctx);
  const ownerNow = () => queue.ptyWriteOwners.get(term) || null;
  const gate = () => ctx.claudeStartupDefaultsGateByTab.get('T') || null;
  const nextEvent = (name, predicate, existing = []) => {
    const current = existing.find(predicate);
    if (current) return Promise.resolve(current);
    return new Promise(resolve => {
      const listener = value => {
        if (!predicate(value)) return;
        events.off(name, listener);
        resolve(value);
      };
      events.on(name, listener);
    });
  };
  ctx.claudeSettingEvidence = {
    admit: identity => {
      const token = { ...identity, commandId: 'setting-command-' + (++tokenSequence), proof: null, written: false };
      tokens.set(token.commandId, token);
      return token;
    },
    get: (commandId, identity) => {
      const token = tokens.get(commandId);
      return token?.tabId === identity.tabId && token.command === identity.command ? token : null;
    },
  };
  ctx.sendClaudeCommandUnclaimed = async (tabId, command, options) => queue.withPtyWriteLock(term, async owner => {
    assert.equal(ownerNow(), owner);
    assert.equal(owner.active, true);
    const token = options.claudeSettingEvidenceToken;
    assert.equal(tokens.get(token?.commandId), token, 'main forwards the admitted evidence capability to the physical leaf');
    assert.equal(token.command, command);
    assert.equal(token.tabId, tabId);
    Object.assign(token, { source: options.source, written: true, owner });
    token.proof = proofFor?.(token) || (command === '/model unavailable'
      ? rejected('OLD MODEL 429') : found(command.slice(command.indexOf(' ') + 1), command.startsWith('/effort') ? 'effort' : 'model'));
    const written = { command, source: options.source, owner, commandId: token.commandId,
      operationId: token.operationId, startupAttemptId: token.startupAttemptId };
    commands.push(written);
    events.emit('command', written);
    return { success: true, submitted: true, enterWritten: true, pasteWritten: true };
  }, { kind: 'fixture-transport', tabId, submitted: true }, options.ptyWriteOwner || null);
  ctx.readClaudeStartupSlashProof = async request => {
    const token = ctx.claudeSettingEvidence.get(request.commandId, request);
    assert.ok(token?.written, 'proof is read for the exact physically written command ID');
    return token.proof;
  };
  ctx.claudeStartupProofSession = { wait: request => {
    const token = ctx.claudeSettingEvidence.get(request.commandId, request);
    assert.ok(token?.written);
    assert.equal(token.owner.active, false, 'late observation starts only after its own PTY owner release');
    assert.equal(request.ptyWriteOwner, undefined, 'observer cannot inherit an expired write owner');
    token.late ||= deferred();
    lateWaits.push({ request, token });
    return token.late.promise;
  } };
  for (const name of ['agentSendRequestExpectedTargets', 'agentSendRequestTargetFailure',
    'currentClaudeStartupDefaultsGate', 'getClaudePtyRuntimePresence', 'readClaudeStartupGateSnapshot',
    'publishClaudeStartupDefaultsGate', 'sendClaudeCommandInternal',
    'captureClaudeSettingsOperationRuntime', 'reconcileClaudeStartupAfterSettings']) {
    vm.runInContext(declaration(name), ctx);
  }
  vm.runInContext('let claudeSettingsOperationOrder = 0;', ctx);
  const startup = createClaudeStartupMainRuntime({
    now: () => clock,
    currentLaunchGeneration: tabId => ctx.claudeLaunchGenerationByTab.get(tabId)?.generation,
    resolveSettings: async () => startupSettings,
    sendCommand: payload => ctx.sendClaudeCommandInternal(payload.tabId, payload.command, {
      source: payload.source, startupAttemptId: payload.attemptId,
    }),
    proveCommand: payload => ctx.readClaudeStartupSlashProof({ tabId: payload.tabId, command: payload.command,
      commandId: payload.sendResult.settingCommandId }),
    publishGate: payload => {
      ctx.publishClaudeStartupDefaultsGate(payload, { notifyRenderer: true });
      events.emit('gate', gate());
    },
  });
  const actualSettlement = startup.settleManualClaim;
  startup.settleManualClaim = (...args) => {
    settlements.push({ args, owner: ownerNow() });
    return actualSettlement(...args);
  };
  // No outcome may reach these lifecycle initiators. Tests start the initial
  // transaction through the captured function before installing this guard.
  const ensure = startup.ensure;
  const retry = startup.retry;
  startup.ensure = () => assert.fail('outcome callback must not create/retry a startup');
  startup.retry = () => assert.fail('outcome callback must not replay a startup step');
  ctx.claudeStartupMainRuntime = startup;
  const actualCapture = ctx.captureClaudeSettingsOperationRuntime;
  ctx.captureClaudeSettingsOperationRuntime = (...args) => {
    const captured = actualCapture(...args);
    captures.push(captured);
    return captured;
  };
  const actualReconcile = ctx.reconcileClaudeStartupAfterSettings;
  ctx.reconcileClaudeStartupAfterSettings = async outcome => {
    for (const command of commands.filter(item => item.operationId === outcome.runtime.settingsOperationId)) {
      assert.equal(command.owner.active, false, 'the caller notifies only after its own complete settings owner exits');
    }
    outcomes.push(outcome);
    const result = await actualReconcile(outcome);
    events.emit('outcome', outcome);
    return result;
  };
  ctx.require = request => path.basename(request) === 'claude-settings-send'
    ? { createClaudeSettingsSendRuntime: deps => createClaudeSettingsSendRuntime({
      ...deps, now: () => clock, wait: async milliseconds => { clock += milliseconds; },
    }) } : require(request);
  const wiring = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(ast) === 'claudeSettingsSendRuntime'));
  assert.ok(wiring, 'actual main settings helper wiring');
  vm.runInContext(wiring.getText(ast), ctx);
  for (const channel of ['claude:apply-settings', 'claude:dismiss-startup-defaults-failure', 'claude:get-startup-defaults-gate']) {
    vm.runInContext(registration(channel), ctx);
  }
  const settings = vm.runInContext('claudeSettingsSendRuntime', ctx);
  return {
    ctx, startup, settings, term, tokens, commands, outcomes, captures, settlements, lateWaits,
    ownerNow, gate, notifications, parkedPromptFlushes,
    commandTexts: () => commands.map(item => item.command),
    start: () => ensure({ tabId: 'T', generation: ctx.claudeLaunchGenerationByTab.get('T').generation, trigger: 'fixture' }),
    retry: () => retry('T'),
    apply: request => settings.applySettings({ tabId: 'T', source: 'fixture-manual', ...request }),
    applyIPC: request => handlers.get('claude:apply-settings')({}, { tabId: 'T', ...request }),
    dismiss: identity => handlers.get('claude:dismiss-startup-defaults-failure')({}, { tabId: 'T', ...identity }),
    readGate: () => handlers.get('claude:get-startup-defaults-gate')({}, { tabId: 'T' }).gate,
    waitGate: predicate => nextEvent('gate', predicate, gate() ? [gate()] : []),
    waitOutcome: predicate => nextEvent('outcome', predicate, outcomes),
    waitCommand: predicate => nextEvent('command', predicate, commands),
    settleLate: (commandId, proof) => {
      const token = tokens.get(commandId);
      assert.ok(token?.late, 'same retained observer exists');
      token.proof = proof;
      token.late.resolve(proof);
    },
    retire: () => {
      startup.clear('T', 'fixture-stop');
      ctx.claudeLaunchGenerationByTab.set('T', { generation: 'L2' });
      ctx.terminalCommandState.set('T', { runSeq: 2 });
      lifecycle = 'LC2';
    },
  };
}

test('actual caller: failed model → B plus effort 429 gives one effort and a new exact dismissible failure', { timeout: 3000 }, async () => {
  const h = fixture({ proofFor: token => token.source === 'fixture-manual:effort' ? rejected('CURRENT EFFORT 429') : null });
  await h.start().promise;
  const old = { ...h.gate() };
  assert.equal(h.dismiss(old).dismissed, true);
  assert.equal(h.readGate().dismissed, true);
  const result = await h.applyIPC({ model: 'B', effort: 'max', source: 'fixture-manual' });
  assert.equal(result.success, false);
  assert.equal(result.failedCommand, '/effort max');
  assert.equal(result.appliedSettings.model, 'B');
  assert.deepEqual(h.commandTexts(), ['/model unavailable', '/model B', '/effort max']);
  assert.equal(h.commands[1].owner, h.commands[2].owner, 'the successful prefix and rejected suffix share one owner');
  assert.equal(h.commands[1].owner.active, false);
  assert.equal(h.ownerNow(), null);
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].startupAttemptId, old.attemptId);
  assert.equal(h.commands[1].operationId, h.captures[0].settingsOperationId);
  assert.equal(h.commands[1].startupAttemptId, old.attemptId);
  assert.notEqual(h.commands[1].commandId, h.commands[2].commandId);
  const next = h.gate();
  assert.equal(next.attemptId, old.attemptId);
  assert.equal(next.error, 'CURRENT EFFORT 429');
  assert.equal(next.failedCommand, '/effort max');
  assert.notEqual(next.failureId, old.failureId);
  assert.ok(next.failureRevision > old.failureRevision);
  assert.equal(next.dismissed, false);
  assert.equal(h.dismiss(old).dismissed, false, 'dismissed old model failure cannot hide current effort rejection');
  assert.equal(h.readGate().dismissed, false);
  assert.equal(h.dismiss(next).dismissed, true);
  assert.equal(h.startup.snapshot('T').claims.model.value, 'B');
  assert.equal(h.startup.snapshot('T').claims.effort, null);
  assert.equal(h.parkedPromptFlushes.length, 0, 'partial failure does not flush a parked prompt');
});

test('actual caller: full model-only replacement continues only the original unsent startup effort', { timeout: 3000 }, async () => {
  const h = fixture();
  await h.start().promise;
  const old = h.gate();
  const ready = h.waitGate(value => value.status === 'ready');
  const result = await h.apply({ model: 'B' });
  assert.equal(result.success, true);
  await ready;
  assert.equal(h.gate().attemptId, old.attemptId);
  assert.deepEqual(h.commandTexts(), ['/model unavailable', '/model B', '/effort max']);
  assert.notEqual(h.commands[1].owner, h.commands[2].owner, 'continuation acquires a new owner after manual release');
  assert.equal(h.commands[1].owner.active, false);
  assert.equal(h.outcomes[0].allowUnattemptedContinuation, true);
  assert.equal(h.startup.snapshot('T').claims.model.value, 'B');
  assert.equal(h.startup.snapshot('T').claims.effort.value, 'max');
});

test('actual caller: an unknown pair releases the owner and late proof settles the same claim without sending its suffix', { timeout: 3000 }, async () => {
  const h = fixture({ proofFor: token => token.source === 'fixture-manual:model' ? unknown() : null });
  await h.start().promise;
  await assert.rejects(h.apply({ model: 'B', effort: 'max' }), error => error.code === 'claude_setting_outcome_unknown');
  assert.equal(h.ownerNow(), null);
  assert.deepEqual(h.commandTexts(), ['/model unavailable', '/model B']);
  assert.equal(h.lateWaits.length, 1);
  const unknownClaim = h.startup.snapshot('T').claims.model;
  assert.equal(unknownClaim.proofStatus, 'unknown');
  const unknownSettlement = h.settlements.find(item => item.args[3] === 'jsonl-proof-unknown');
  assert.ok(unknownSettlement.owner?.active === false, 'the old owner token is no longer active after the reply');
  assert.equal(h.outcomes[0].steps[1].status, 'unattempted');
  const completed = h.waitOutcome(outcome => outcome.results.length === 1);
  h.settleLate(h.lateWaits[0].request.commandId, found('Observed B'));
  await completed;
  const lateSettlement = h.settlements.find(item => item.args[3] === 'late-jsonl-proof-found');
  assert.equal(lateSettlement.args[1], unknownClaim.id);
  assert.equal(lateSettlement.owner, null);
  assert.equal(h.startup.snapshot('T').claims.model.id, unknownClaim.id);
  assert.equal(h.startup.snapshot('T').claims.model.actualValue, 'Observed B');
  assert.equal(h.startup.snapshot('T').claims.model.requestedValue, 'B');
  assert.equal(h.gate().failedCommand, '/effort max');
  assert.equal(h.gate().errorCode, 'claude_startup_setting_unattempted');
  assert.equal(h.outcomes.at(-1).allowUnattemptedContinuation, false);
  assert.deepEqual(h.commandTexts(), ['/model unavailable', '/model B']);
  assert.equal(h.parkedPromptFlushes.length, 0);
});

test('actual caller preserves requested-satisfaction through immediate and late applied-different outcomes', { timeout: 3000 }, async () => {
  const immediate = fixture({ proofFor: token => token.command === '/model B' ? different('Observed A') : null });
  await immediate.start().promise;
  await assert.rejects(immediate.apply({ model: 'B' }), error => error.settingStatus === 'applied-different');
  const immediateStep = immediate.outcomes.at(-1).steps[0];
  assert.equal(immediateStep.status, 'applied-different');
  assert.equal(immediateStep.requestSatisfied, false);
  assert.equal(immediate.startup.snapshot('T').claims.model.proofStatus, 'applied-different');
  assert.equal(claudeParamsOperationOutcome(immediate.outcomes.at(-1))
    .steps[0].observed.requestedSatisfied, false);

  const late = fixture({ proofFor: token => token.command === '/model B' ? unknown() : null });
  await late.start().promise;
  await assert.rejects(late.apply({ model: 'B' }), error => error.code === 'claude_setting_outcome_unknown');
  const completed = late.waitOutcome(outcome => outcome.results.length === 1);
  late.settleLate(late.lateWaits[0].request.commandId, different('Observed A'));
  await completed;
  const lateStep = late.outcomes.at(-1).steps[0];
  assert.equal(lateStep.status, 'applied-different');
  assert.equal(lateStep.requestSatisfied, false);
  assert.equal(claudeParamsOperationOutcome(late.outcomes.at(-1))
    .steps[0].observed.requestedSatisfied, false);
  assert.equal(late.startup.snapshot('T').claims.model.proofStatus, 'applied-different');
});

test('actual caller: Retry repeats rejected high despite rollback to an older confirmed low', { timeout: 3000 }, async () => {
  const h = fixture({ proofFor: token => token.command === '/effort high'
    ? rejected('HIGH REJECTED') : null });
  await h.start().promise;
  await h.apply({ effort: 'low' });
  await assert.rejects(h.apply({ model: 'B', effort: 'high' }), /HIGH REJECTED/);
  assert.equal(h.startup.snapshot('T').claims.effort.value, 'low');
  const before = h.commandTexts().length;
  const retried = await h.retry().promise;
  assert.equal(retried.status, 'failed');
  assert.deepEqual(h.commandTexts().slice(before), ['/effort high']);
  assert.equal(h.startup.snapshot('T').claims.model.value, 'B');
  const beforeSecond = h.commandTexts().length;
  assert.equal((await h.retry().promise).status, 'failed');
  assert.deepEqual(h.commandTexts().slice(beforeSecond), ['/effort high']);
});

test('actual caller: late Retry B proof cannot replace subsequently admitted D', { timeout: 3000 }, async () => {
  const retryB = deferred();
  const h = fixture({ proofFor: token => {
    if (token.command !== '/model B') return null;
    return token.source.includes('manual-retry') ? retryB.promise : rejected('B REJECTED');
  } });
  await h.start().promise;
  await assert.rejects(h.apply({ model: 'B' }), /B REJECTED/);
  const retry = h.retry();
  await h.waitCommand(command => command.command === '/model B' && command.source.includes('manual-retry'));
  await h.apply({ model: 'D', effort: 'low' });
  retryB.resolve(found('B'));
  assert.equal((await retry.promise).status, 'cancelled');
  assert.equal(h.startup.snapshot('T').claims.model.value, 'D');
  assert.equal(h.startup.snapshot('T').claims.model.via, 'fixture-manual:model');
  assert.deepEqual(h.commandTexts(), ['/model unavailable', '/model B', '/model B', '/model D', '/effort low']);
});

test('actual caller: successful Retry B is the fallback after a newer D rejection', { timeout: 3000 }, async () => {
  const retryB = deferred();
  const proofD = deferred();
  const h = fixture({ startupSettings: { model: 'A', effort: 'max' }, proofFor: token => {
    if (token.command === '/effort max') return rejected('EFFORT REJECTED');
    if (token.command === '/model B') {
      return token.source.includes('manual-retry') ? retryB.promise : rejected('B REJECTED');
    }
    if (token.command === '/model D') return proofD.promise;
    return null;
  } });
  await h.start().promise;
  assert.equal(h.startup.snapshot('T').claims.model.value, 'A');
  await assert.rejects(h.apply({ model: 'B' }), /B REJECTED/);
  const retry = h.retry();
  await h.waitCommand(command => command.command === '/model B' && command.source.includes('manual-retry'));
  const applyD = h.apply({ model: 'D' });
  await h.waitCommand(command => command.command === '/model D');
  retryB.resolve(found('B'));
  await retry.promise;
  proofD.resolve(rejected('D REJECTED'));
  await assert.rejects(applyD, /D REJECTED/);
  assert.equal(h.startup.snapshot('T').claims.model.value, 'B');
});

test('actual caller: Retry of B joins a newer pending D without replacing the startup attempt', { timeout: 3000 }, async () => {
  const proofD = deferred();
  const h = fixture({ proofFor: token => token.command === '/model B' ? rejected('B REJECTED')
    : token.command === '/model D' ? proofD.promise : null });
  await h.start().promise;
  await assert.rejects(h.apply({ model: 'B' }), /B REJECTED/);
  const attemptId = h.startup.snapshot('T').transaction.attemptId;
  const applyD = h.apply({ model: 'D' });
  await h.waitCommand(command => command.command === '/model D');
  const joined = h.retry();
  assert.equal(joined.joined, true);
  assert.equal(joined.reason, 'newer-manual-operation-pending');
  assert.equal(h.startup.snapshot('T').transaction.attemptId, attemptId);
  proofD.resolve(found('D'));
  await applyD;
  assert.equal((await joined.promise).status, 'ready');
  assert.equal(h.startup.snapshot('T').claims.model.value, 'D');
});

test('actual caller: applied-different Retry stores its new observed value as current fallback', { timeout: 3000 }, async () => {
  const h = fixture({ proofFor: token => token.command === '/model wanted'
    ? { ...different(token.source.includes('manual-retry') ? 'Opus 4.6' : 'Sonnet 5'), outcome: 'unresolved' }
    : null });
  await h.start().promise;
  await assert.rejects(h.apply({ model: 'wanted' }), error => error.settingStatus === 'applied-different');
  assert.equal(h.startup.snapshot('T').claims.model.value, 'Sonnet 5');
  assert.equal((await h.retry().promise).status, 'failed');
  assert.equal(h.startup.snapshot('T').claims.model.value, 'Opus 4.6');
  assert.equal(h.startup.snapshot('T').claims.model.proofStatus, 'applied-different');
});

test('actual caller: late old A may settle its historical receipt but never overwrite the newer B claim/gate', { timeout: 3000 }, async () => {
  const receipts = [];
  const h = fixture({ proofFor: token => token.command === '/model A' ? unknown() : null });
  await h.start().promise;
  await assert.rejects(h.apply({ model: 'A', effort: 'max', paramsOperationId: 'request-A',
    paramsOutcome: value => receipts.push(value) }), error => error.code === 'claude_setting_outcome_unknown');
  const oldScope = h.captures[0];
  await h.apply({ model: 'B', effort: 'high', paramsOperationId: 'request-B' });
  const current = h.gate();
  assert.equal(current.status, 'ready');
  assert.ok(h.captures[1].settingsOperationOrder > oldScope.settingsOperationOrder);
  const done = h.waitOutcome(outcome => outcome.runtime.settingsOperationId === 'request-A' && outcome.results.length === 1);
  h.settleLate(h.lateWaits[0].request.commandId, found('A'));
  await done;
  assert.equal(receipts.at(-1).appliedSettings.model, 'A', 'the old receipt still receives its own exact late result');
  assert.equal(h.gate(), current);
  assert.equal(h.startup.snapshot('T').claims.model.actualValue, 'B');
  assert.equal(h.startup.snapshot('T').claims.effort.actualValue, 'high');
  assert.deepEqual(h.commandTexts(), ['/model unavailable', '/model A', '/model B', '/effort high']);
});

test('actual caller: Stop/relaunch rejects late old settings state while retaining its historical outcome address', { timeout: 3000 }, async () => {
  const receipts = [];
  const h = fixture({ proofFor: token => token.command === '/model A' ? unknown() : null });
  await h.start().promise;
  await assert.rejects(h.apply({ model: 'A', paramsOperationId: 'old-request', paramsOutcome: value => receipts.push(value) }));
  const oldClaim = h.startup.snapshot('T').claims.model;
  h.retire();
  await h.start().promise;
  const replacement = h.gate();
  const before = h.commandTexts();
  const done = h.waitOutcome(outcome => outcome.runtime.settingsOperationId === 'old-request' && outcome.results.length === 1);
  h.settleLate(h.lateWaits[0].request.commandId, found('A'));
  await done;
  assert.equal(receipts.at(-1).appliedSettings.model, 'A');
  assert.equal(h.gate(), replacement);
  assert.equal(h.startup.snapshot('T').claims.model, null);
  assert.ok(h.settlements.some(item => item.args[1] === oldClaim.id && item.args[3] === 'late-jsonl-proof-found'));
  assert.deepEqual(h.commandTexts(), before);
});

test('actual admission order wins even when late A arrives while the newer B is still proving under its own lock', { timeout: 3000 }, async () => {
  const pendingB = deferred();
  const receipts = [];
  const h = fixture({ proofFor: token => token.command === '/model A' ? unknown()
    : token.command === '/model B' ? pendingB.promise : null });
  await h.start().promise;
  await assert.rejects(h.apply({ model: 'A', effort: 'max', paramsOperationId: 'request-A',
    paramsOutcome: value => receipts.push(value) }));
  const oldGate = h.gate();
  const applicationB = h.apply({ model: 'B', effort: 'high', paramsOperationId: 'request-B' });
  const writeB = await h.waitCommand(command => command.command === '/model B');
  assert.equal(writeB.owner.active, true);
  assert.equal(h.ownerNow(), writeB.owner);
  assert.ok(h.captures[1].settingsOperationOrder > h.captures[0].settingsOperationOrder);
  const claimB = h.startup.snapshot('T').claims.model;
  const settledA = h.waitOutcome(outcome => outcome.runtime.settingsOperationId === 'request-A' && outcome.results.length === 1);
  h.settleLate(h.lateWaits[0].request.commandId, found('Late A'));
  await settledA;
  assert.equal(receipts.at(-1).appliedSettings.model, 'Late A');
  assert.equal(h.gate(), oldGate, 'old completion cannot claim the gate even before the newer outcome exists');
  assert.equal(h.startup.snapshot('T').claims.model.id, claimB.id);
  assert.equal(h.startup.snapshot('T').claims.model.value, 'B');
  assert.equal(writeB.owner.active, true, 'old read-only completion neither retains nor releases the newer owner');
  assert.deepEqual(h.commandTexts(), ['/model unavailable', '/model A', '/model B']);
  pendingB.resolve(found('B'));
  assert.equal((await applicationB).success, true);
  assert.equal(h.gate().status, 'ready');
  assert.equal(h.startup.snapshot('T').claims.model.actualValue, 'B');
  assert.deepEqual(h.commandTexts(), ['/model unavailable', '/model A', '/model B', '/effort high']);
});
