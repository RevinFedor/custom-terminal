'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const {
  reserveClaudeExactEmptyEvidence,
  validateClaudeComposerWriteBoundary,
} = require('./claude-composer-proof');
const { classifyTerminalPasteProfile } = require('./terminal-paste-profile');

const mainPath = path.join(__dirname, 'main.js');
const historyPath = path.join(__dirname, '../renderer/components/Workspace/HistoryPanel.tsx');

function parse(filePath, scriptKind) {
  const source = fs.readFileSync(filePath, 'utf8');
  return {
    source,
    file: ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind),
  };
}

function findNode(parsed, predicate, label) {
  let found = null;
  const visit = (node) => {
    if (!found && predicate(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(parsed.file);
  assert.ok(found, 'missing source node: ' + label);
  return found;
}

function sourceForFunction(parsed, name) {
  const node = findNode(
    parsed,
    (candidate) => ts.isFunctionDeclaration(candidate) && candidate.name?.text === name,
    name,
  );
  return parsed.source.slice(node.getStart(parsed.file), node.end);
}

function sourceForVariableStatement(parsed, name) {
  const declaration = findNode(
    parsed,
    (candidate) => ts.isVariableDeclaration(candidate) && candidate.name?.getText(parsed.file) === name,
    name,
  );
  let statement = declaration;
  while (statement && !ts.isVariableStatement(statement)) statement = statement.parent;
  assert.ok(statement, 'missing variable statement: ' + name);
  return parsed.source.slice(statement.getStart(parsed.file), statement.end);
}

function sourceForVariableInitializer(parsed, name) {
  const declaration = findNode(
    parsed,
    (candidate) => ts.isVariableDeclaration(candidate) && candidate.name?.getText(parsed.file) === name,
    name,
  );
  assert.ok(declaration.initializer, 'missing initializer: ' + name);
  return parsed.source.slice(declaration.initializer.getStart(parsed.file), declaration.initializer.end);
}

function sourceForIpcHandler(parsed, channel) {
  const call = findNode(parsed, (node) => (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'handle'
    && ts.isStringLiteral(node.arguments[0])
    && node.arguments[0].text === channel
  ), channel);
  const callback = call.arguments[1];
  return parsed.source.slice(callback.getStart(parsed.file), callback.end);
}

async function buildF1Harness(surfaceMode) {
  const parsed = parse(mainPath, ts.ScriptKind.JS);
  const inputRevisions = new Map([['phase2-f1-tab', 0]]);
  const terminalCommandState = new Map([['phase2-f1-tab', { runSeq: 7 }]]);
  const mirror = {
    generation: 'phase2-mirror-generation',
    writeSeq: 20,
    flushedSeq: 20,
    redrawTrace: { synchronizedOutputOpen: false },
  };
  const state = {
    composer: '',
    executions: [],
    verifications: [],
  };
  const term = {
    write(text) {
      state.composer += text;
      mirror.writeSeq += 1;
      mirror.flushedSeq = mirror.writeSeq;
    },
  };
  const terminals = new Map([['phase2-f1-tab', term]]);
  const context = vm.createContext({
    CLAUDE_PASTE_AUDIT_TIMEOUT_MS: 8_000,
    Date,
    Promise,
    WeakMap,
    Map,
    aiStoppingTabs: new Map(),
    console: { log() {}, warn() {}, error() {} },
    classifyTerminalPasteProfile,
    getHeadlessTerminalMirror: () => mirror,
    getTerminalLifecycleGeneration: () => 'phase2-lifecycle-generation',
    hasLiveClaudeInTab: () => true,
    mainWindow: null,
    pasteInflight: new WeakMap(),
    ptyActiveWriteOperation: new WeakMap(),
    ptyLastQueuedWriteOperation: new WeakMap(),
    reserveClaudeExactEmptyEvidence,
    terminalCommandState,
    terminalInputRevisions: inputRevisions,
    terminals,
    validateClaudeComposerWriteBoundary,
  });
  context.findTabIdForTerm = (candidate) => candidate === term ? 'phase2-f1-tab' : null;
  context.requestTerminalClaudeDraftState = async () => {
    const common = {
      success: true,
      terminalRunSeq: 7,
      inputRevision: Number(inputRevisions.get('phase2-f1-tab') || 0),
      terminalLifecycleGeneration: 'phase2-lifecycle-generation',
      mirrorGeneration: mirror.generation,
      mirrorWriteSeq: mirror.writeSeq,
      mirrorFlushedSeq: mirror.flushedSeq,
      mirrorSynchronizedOutputOpen: false,
    };
    if (surfaceMode === 'found') {
      return {
        ...common,
        proofOutcome: 'found',
        hasDraft: true,
        text: state.composer,
        preview: state.composer,
        source: 'headless-main:claude-composer:found',
        proofReason: 'composer-content-found',
        exactCaptureRecommended: false,
      };
    }
    return {
      ...common,
      proofOutcome: 'unknown',
      hasDraft: null,
      text: '',
      preview: '',
      source: 'headless-main:claude-composer:unknown:residual-cells',
      proofReason: 'wrapped-composer-empty-ambiguous',
      exactCaptureRecommended: true,
    };
  };

  for (const name of [
    'getTerminalInputRevision',
    'bumpTerminalInputRevision',
    'withPtyWriteLock',
    'safePasteAndSubmit',
    'exactClaudeEmptyEvidenceStillCurrent',
    'verifyClaudeComposerEmptyAtWriteBoundary',
  ]) {
    new vm.Script(sourceForFunction(parsed, name), {
      filename: mainPath + '#' + name,
    }).runInContext(context);
  }
  const withPtyWriteLock = vm.runInContext('withPtyWriteLock', context);
  const verifyClaudeComposerEmptyAtWriteBoundary = vm.runInContext(
    'verifyClaudeComposerEmptyAtWriteBoundary',
    context,
  );
  context._safePasteAndSubmitInner = async (candidateTerm, content, options) => {
    const execution = {
      content,
      expectedInputRevision: options.expectedInputRevision,
      currentInputRevision: Number(inputRevisions.get('phase2-f1-tab') || 0),
    };
    state.executions.push(execution);
    if (content === 'queued replay') {
      candidateTerm.write(content);
      return { success: true, submitted: false, pasteWritten: true };
    }
    const verification = await verifyClaudeComposerEmptyAtWriteBoundary(
      'phase2-f1-tab',
      candidateTerm,
      'phase2-history-send',
      { exactEmptyEvidence: options.claudeExactEmptyEvidence },
    );
    state.verifications.push(verification);
    if (!verification.valid) {
      return {
        success: false,
        submitted: false,
        pasteWritten: false,
        error: verification.reason,
      };
    }
    candidateTerm.write(content);
    return { success: true, submitted: true, pasteWritten: true };
  };

  const appendInput = new vm.Script(`(${sourceForIpcHandler(parsed, 'claude:append-input')})`, {
    filename: mainPath + '#claude:append-input',
  }).runInContext(context);
  const terminalPaste = new vm.Script(`(${sourceForIpcHandler(parsed, 'terminal:paste')})`, {
    filename: mainPath + '#terminal:paste',
  }).runInContext(context);

  return {
    state,
    term,
    withPtyWriteLock,
    appendInput,
    terminalPaste,
    exactEvidence: {
      success: true,
      proofOutcome: 'absent',
      hasDraft: false,
      text: '',
      images: 0,
      terminalIdentityStable: true,
      editorReturnReady: true,
      terminalRunSeq: 7,
      inputRevision: 0,
      terminalLifecycleGeneration: 'phase2-lifecycle-generation',
      mirrorGeneration: mirror.generation,
      mirrorWriteSeq: mirror.writeSeq,
      mirrorFlushedSeq: mirror.flushedSeq,
      mirrorSynchronizedOutputOpen: false,
      source: 'headless-main:claude-composer:empty-exact-editor',
    },
  };
}

async function runQueuedReplayBeforeHistory(surfaceMode) {
  const harness = await buildF1Harness(surfaceMode);
  let releaseBlocker;
  const blockerGate = new Promise((resolve) => { releaseBlocker = resolve; });
  const blocker = harness.withPtyWriteLock(
    harness.term,
    () => blockerGate,
    { kind: 'phase2-test-barrier', submitted: false },
  );
  await new Promise((resolve) => setImmediate(resolve));

  const replay = harness.appendInput({}, 'phase2-f1-tab', 'queued replay', {
    submit: false,
    source: 'prompt-queue-replay',
  });
  await Promise.resolve();
  const history = harness.terminalPaste({}, {
    tabId: 'phase2-f1-tab',
    content: 'history prompt',
    submit: true,
    fast: false,
    handoffId: 'phase2-f1-history-handoff',
    source: 'history-panel',
    verifyClaudeVisibleDraftBeforePaste: true,
    awaitClaudeUserMessageAudit: true,
    claudeExactEmptyEvidence: harness.exactEvidence,
  });
  await Promise.resolve();
  releaseBlocker();
  const [, replayResult, historyResult] = await Promise.all([blocker, replay, history]);
  return { ...harness, replayResult, historyResult };
}

test('F1 complete Replay -> PTY queue -> History path cannot combine text across an old exact proof', async () => {
  const result = await runQueuedReplayBeforeHistory('ambiguous');
  const replayExecution = result.state.executions.find((entry) => entry.content === 'queued replay');
  const historyVerification = result.state.verifications[0];

  assert.deepEqual({
    replayCrossedNewerRevision: replayExecution.expectedInputRevision !== replayExecution.currentInputRevision,
    staleExactProofAccepted: historyVerification?.valid === true,
    physicalComposer: result.state.composer,
    historySubmitted: result.historyResult?.submitted === true,
  }, {
    replayCrossedNewerRevision: false,
    staleExactProofAccepted: false,
    physicalComposer: 'queued replay',
    historySubmitted: false,
  }, 'User-visible invariant violated: an older queued Replay must not cross History\'s exact empty-composer receipt and combine both prompts in one Claude composer.');
});

test('F1 strongest counterexample: a current visible draft rejects History even after the same queue ordering', async () => {
  const result = await runQueuedReplayBeforeHistory('found');
  assert.equal(result.state.composer, 'queued replay');
  assert.equal(result.historyResult?.submitted, false);
  assert.equal(result.state.verifications[0]?.valid, false);
  assert.equal(result.state.verifications[0]?.reason, 'claude_existing_draft_before_paste');
});

async function buildHistoryDurabilityCaller(serverEntries) {
  const parsed = parse(historyPath, ts.ScriptKind.TSX);
  const snippets = [
    sourceForVariableStatement(parsed, 'LOCAL_PROMPT_PREFIX'),
    sourceForVariableStatement(parsed, 'normalizeHistoryPromptText'),
    sourceForVariableStatement(parsed, 'normalizeHistoryPromptIdentityText'),
    sourceForVariableStatement(parsed, 'findServerPromptEntry'),
    sourceForVariableStatement(parsed, 'serverHasPromptEntry'),
  ];
  const hasDurableInitializer = sourceForVariableInitializer(parsed, 'hasDurablePrompt');
  const source = [
    ...snippets,
    `const hasDurablePrompt = ${hasDurableInitializer};`,
    'globalThis.__phase2Exports = { serverHasPromptEntry, hasDurablePrompt };',
  ].join('\n');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const [{ matchesHistoryPromptAdoption }, { normalizePromptImageIdentity }] = await Promise.all([
    import('../renderer/utils/historyPromptPresentation.mjs'),
    import('../renderer/utils/promptImageAttachments.mjs'),
  ]);
  const context = vm.createContext({
    Date,
    matchesHistoryPromptAdoption,
    normalizePromptImageIdentity,
    rawServerEntriesRef: { current: serverEntries },
    useCallback: (callback) => callback,
  });
  new vm.Script(js, { filename: historyPath + '#interrupt-durability' }).runInContext(context);
  return context.__phase2Exports;
}

test('F3 complete interrupt durability decision cannot let identical A prove exact handoff B', async () => {
  const submittedA = Date.parse('2026-08-02T10:00:00.000Z');
  const submittedB = submittedA + 4_000;
  const serverA = {
    uuid: 'exact-user-A',
    role: 'user',
    content: 'identical prompt',
    timestamp: new Date(submittedA).toISOString(),
    sessionId: 'session-A',
  };
  const { hasDurablePrompt } = await buildHistoryDurabilityCaller([serverA]);
  const { resolveInterruptedPromptOwnership } = await import('../renderer/utils/historyDraftOwnership.mjs');

  const weakDurableDecision = hasDurablePrompt('identical prompt', submittedB);
  const recoveryDisposition = resolveInterruptedPromptOwnership({
    durablePromptExists: weakDurableDecision,
    returnedDraftExists: false,
    returnedDraftMatchesHandoff: false,
  });

  assert.deepEqual({ weakDurableDecision, recoveryDisposition }, {
    weakDurableDecision: false,
    recoveryDisposition: 'pending',
  }, 'User-visible invariant violated: interrupt recovery for exact handoff B must not discard B because an older identical prompt A exists within five seconds.');
});

test('F3 strongest counterexample: the existing matcher rejects A when the caller carries B exact identity', async () => {
  const submittedA = Date.parse('2026-08-02T10:00:00.000Z');
  const submittedB = submittedA + 4_000;
  const serverA = {
    uuid: 'exact-user-A',
    role: 'user',
    content: 'identical prompt',
    timestamp: new Date(submittedA).toISOString(),
    sessionId: 'session-A',
  };
  const serverB = {
    uuid: 'exact-user-B',
    role: 'user',
    content: 'identical prompt',
    timestamp: new Date(submittedB).toISOString(),
    sessionId: 'session-B',
  };
  const { serverHasPromptEntry } = await buildHistoryDurabilityCaller([serverA, serverB]);
  const exactLocalB = {
    uuid: 'local-prompt-B',
    role: 'queued',
    content: 'identical prompt',
    timestamp: new Date(submittedB).toISOString(),
    optimisticAt: submittedB,
    requiresAuditIdentity: true,
    auditEntryUuid: 'exact-user-B',
    auditSessionId: 'session-B',
  };

  assert.equal(serverHasPromptEntry([serverA], exactLocalB), false);
  assert.equal(serverHasPromptEntry([serverA, serverB], exactLocalB), true);
});
