'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { createAgentInputObservation, observeAgentInput } = require('../agent-input-observation');
const draftAuthority = require('../codex-draft-authority');
const { agentInputObservationInvalidated } = require('../../shared/agent-input-observation.cjs');

const mainSource = fs.readFileSync(path.join(process.env.ACTUAL_SOURCE_DIR || path.join(__dirname, '..'), 'main.js'), 'utf8');
const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);

function actualFunction(name) {
  const node = mainAst.statements.find((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  ));
  if (!node) throw new Error(`Missing actual main.js function ${name}`);
  return node.getText(mainAst);
}

function actualDeclaration(name) {
  const node = mainAst.statements.find(statement =>
    (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    || (ts.isVariableStatement(statement) && statement.declarationList.declarations
      .some(declaration => declaration.name.getText(mainAst) === name)));
  if (!node) throw new Error('Missing actual main.js declaration ' + name);
  return node.getText(mainAst);
}

function actualDraftStateHandler() {
  const statement = mainAst.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(mainAst) === 'ipcMain.handle'
    && node.expression.arguments[0]?.text === 'codex:get-draft-state');
  if (!statement) throw new Error('Missing actual codex:get-draft-state handler');
  return statement.expression.arguments[1].getText(mainAst);
}

function startupFrameDeclarations() {
  return ['codexSendStartupFrameWaits', 'captureCodexSendStartupFrameWait',
    'codexSendStartupFrameWaitIsCurrent', 'clearCodexSendStartupFrameWait']
    .map(actualDeclaration).join('\n');
}

function createFakeClock(startAt = 1000) {
  let time = startAt;
  let nextId = 0;
  const timers = new Map();
  const setCalls = [];
  return {
    timers,
    setCalls,
    now: () => time,
    setTimer(callback, delayMs) {
      const id = ++nextId;
      const normalizedDelay = Math.max(0, Number(delayMs) || 0);
      timers.set(id, { callback, dueAt: time + normalizedDelay, delayMs: normalizedDelay });
      setCalls.push({ id, delayMs: normalizedDelay, dueAt: time + normalizedDelay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      time += Math.max(0, Number(ms) || 0);
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= time)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!next) return;
        const [id, timer] = next;
        timers.delete(id);
        timer.callback();
      }
    },
    advanceToNext() {
      const next = [...timers.values()].sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!next) return false;
      this.advance(next.dueAt - time);
      return true;
    },
  };
}

function createCodexDraftRequestHarness({
  mirror = { generation: 'G1', generationOrdinal: 1, complete: true, synchronizedFrameWaiters: new Set() },
  getDraft = () => ({ success: true, hasDraft: false, source: 'headless-main:cursor:10',
    frameIdentity: { generation: 'G1', writeSeq: 31 } }),
  flush = async () => ({ success: true }),
  rendererAvailable = true,
  clock = createFakeClock(),
  owner = { terminalRunSeq: 1, inputRevision: 1, terminalLifecycleGeneration: 'L1',
    mirrorGeneration: mirror.generation, terminalStopRevision: 0 },
} = {}) {
  let currentMirror = mirror;
  const ipcMain = new EventEmitter();
  const reports = [];
  const logs = [];
  let rendererRequest = null;
  const webContents = rendererAvailable ? {
    isDestroyed: () => false,
    send: (_channel, request) => { rendererRequest = request; },
  } : null;
  const vm = require('node:vm');
  const observationFactory = (tabId, toolType, timeoutMs, options = {}) => {
    const capturedMirror = currentMirror;
    const capturedOwner = { ...owner };
    const isCurrent = () => currentMirror === capturedMirror
      && owner.terminalRunSeq === capturedOwner.terminalRunSeq
      && owner.inputRevision === capturedOwner.inputRevision
      && owner.terminalLifecycleGeneration === capturedOwner.terminalLifecycleGeneration
      && owner.mirrorGeneration === capturedOwner.mirrorGeneration
      && owner.terminalStopRevision === capturedOwner.terminalStopRevision
      && options.isCancelled?.() !== true && options.isOwnerCurrent?.() !== false;
    const observation = createAgentInputObservation({
      timeoutMs,
      isCurrent,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      subscribe(wake) {
        capturedMirror?.synchronizedFrameWaiters?.add(wake);
        return () => capturedMirror?.synchronizedFrameWaiters?.delete(wake);
      },
    });
    observation.identity = {
      mirrorToken: capturedMirror,
      terminalRunSeq: capturedOwner.terminalRunSeq,
      inputRevision: capturedOwner.inputRevision,
      terminalLifecycleGeneration: capturedOwner.terminalLifecycleGeneration,
      mirrorGeneration: capturedOwner.mirrorGeneration,
      terminalStopRevision: capturedOwner.terminalStopRevision,
    };
    observation.owner = capturedOwner;
    observation.toolType = toolType;
    return observation;
  };

  const declarations = [
    startupFrameDeclarations(),
    actualFunction('waitForHeadlessCodexDraftState'),
    actualFunction('agentDraftObservationResult'),
    actualFunction('requestTerminalCodexDraftState'),
  ].join('\n');
  const context = vm.createContext({
    ...require('../agent-send-preparation'), agentSendReceiptStore: null,
    ...draftAuthority,
    ...require('../codex-runtime-contract'),
    // This ordinary-probe fixture has no cold launch. Use the real projector
    // with empty owner maps; do not stub away the final guard's startup branch.
    codexLastRunCommandPayload: new Map(), terminals: new Map(), terminalCommandState: new Map(),
    aiStoppingTabs: new Map(), getTerminalLifecycleGeneration: () => owner.terminalLifecycleGeneration,
    CODEX_STARTUP_NO_STATE_TIMEOUT_MS: 60000, Date: { now: clock.now },
    crypto: require('node:crypto'),
    ipcMain,
    mainWindow: null,
    createMainAgentInputObservation: observationFactory,
    observeAgentInput,
    agentInputObservationInvalidated,
    decorateAgentDraftProofIdentity: (_tabId, proof) => proof,
    hasDefinitiveDraftState: draftAuthority.hasDefinitiveDraftState,
    agentSendTestFaultActive: () => false,
    codexDraftUnknownTestFaultConsumed: false,
    codexTurnWatchers: new Map(),
    getHeadlessTerminalMirror: () => currentMirror,
    getHeadlessCodexDraftState: (_tabId, reason) => getDraft(reason, currentMirror),
    flushHeadlessTerminalMirror: (...args) => flush(...args, currentMirror),
    HEADLESS_XTERM_FLUSH_TIMEOUT_MS: 500,
    reportTerminalIncident: (key, payload) => reports.push({ key, payload }),
    setTimeout: clock.setTimer,
    clearTimeout: clock.clearTimer,
    console: {
      log: message => logs.push(String(message)),
      warn: message => logs.push(String(message)),
    },
  });
  vm.runInContext(`${declarations}\n`
    + 'globalThis.readDraft = requestTerminalCodexDraftState;\n'
    + 'globalThis.publicReadDraft = ' + actualDraftStateHandler() + ';\n'
    + 'globalThis.waitForDraft = waitForHeadlessCodexDraftState;', context);

  return {
    clock, ipcMain, reports, logs, mirror, context,
    get rendererRequest() { return rendererRequest; },
    setCurrentMirror(value) { currentMirror = value; },
    setOwner(value) { owner = { ...owner, ...value }; },
    read(reason = 'codex-pre-submit-before-paste', options = {}, contents = webContents, timeoutMs = 700) {
      return context.readDraft(contents, 'T', reason, timeoutMs, options);
    },
    readPublic(reason = 'codex-pre-submit-before-paste', options = {}, timeoutMs = 700) {
      return context.publicReadDraft(null, 'T', { ...options, reason, timeoutMs });
    },
    waitForHeadlessDraftState(expected = false, timeoutMs = 1000,
      reason = 'headless-draft-wait', options = { waitOnUnknownOnly: true }) {
      return context.waitForDraft('T', expected, timeoutMs, reason, options);
    },
    replyRenderer(payload = {}) {
      if (!rendererRequest) throw new Error('renderer hint was not requested');
      ipcMain.emit('terminal:codex-draft-state-response', null, {
        requestId: rendererRequest.requestId,
        success: true,
        hasDraft: false,
        source: 'cursor:10:dim-hint',
        frameIdentity: { generation: 'G1', writeSeq: 31 },
        ...payload,
      });
    },
    notifyFrame(mirrorToNotify = mirror) {
      for (const wake of [...(mirrorToNotify?.synchronizedFrameWaiters || [])]) wake();
    },
  };
}

const drainMicrotasks = async (rounds = 12) => {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
};

module.exports = { actualFunction, startupFrameDeclarations, createCodexDraftRequestHarness, createFakeClock, drainMicrotasks };
