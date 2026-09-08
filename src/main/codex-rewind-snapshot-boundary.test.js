'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const {
  CODEX_ACTION_PROFILE_NATIVE_REWIND,
  validateCodexActionAuthority,
} = require('./codex-action-authority');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const sourceFile = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function functionSource(name) {
  let found = null;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(found, 'actual main caller function exists: ' + name);
  return mainSource.slice(found.getStart(sourceFile), found.end);
}

function createBoundaryHarness({
  intentGeneration = 'rewind-generation',
  currentInputRevision = 4,
  manualOwnedInputRevision = null,
} = {}) {
  const tabId = 'tab-rewind-boundary';
  const terminalToken = { id: 'pty' };
  const target = {
    targetUuid: 'codex-user-source-9',
    targetPhysicalSessionId: 'physical-source',
    targetSourceLine: 9,
    targetTextHash: 'a'.repeat(64),
    targetUserOrdinal: null,
    targetDerivation: null,
  };
  const authority = {
    authorityId: 'authority-1',
    profile: CODEX_ACTION_PROFILE_NATIVE_REWIND,
    phase: 'consumed',
    actionGeneration: 'rewind-generation',
    target,
    identity: {
      terminalToken,
      projectId: 'project-1',
      tabId,
      lifecycleGeneration: 'lifecycle-1',
      runSeq: 7,
      launchId: 'launch-1',
      sourceSessionId: 'view-source',
      persistedSessionId: 'view-source',
      inputRevision: 4,
      operationId: 'operation-1',
      requestId: 'request-1',
    },
  };
  const observer = {
    sourceMode: 'writer-handoff',
    launchId: 'rewind-generation',
    sourceSessionId: 'view-source',
    expectedBindingSessionId: 'view-source',
    sourceBindingMode: 'confirmed-writer',
    sourceFilePath: '/tmp/view-source.jsonl',
    sourceTerminalToken: terminalToken,
    sourceLifecycleGeneration: 'lifecycle-1',
    sourceRunSeq: 7,
    actionAuthority: authority,
    ...(manualOwnedInputRevision === null
      ? {}
      : { manualRewind: { ownedInputRevision: manualOwnedInputRevision } }),
  };
  const intents = new Map([[tabId, { launchId: intentGeneration }]]);
  let journalWrites = 0;
  const context = {
    CODEX_ACTION_PROFILE_NATIVE_REWIND,
    Number,
    Object,
    String,
    console: { log() {}, warn() {} },
    codexWatchers: new Map([[tabId, observer]]),
    codexSessionDiscoveryIntents: intents,
    terminals: new Map([[tabId, terminalToken]]),
    terminalCommandState: new Map([[tabId, { runSeq: 7 }]]),
    getTerminalInputRevision: () => currentInputRevision,
    currentCodexActionAuthorityIdentity: () => ({
      ...authority.identity,
      inputRevision: currentInputRevision,
    }),
    validateCodexActionAuthority,
    bindCodexActionAuthorityTarget: () => ({ success: true }),
    transitionMainCodexActionAuthority: (_authority, phase, reason) => {
      _authority.phase = phase;
      _authority.reason = reason;
      return { success: true };
    },
    publishCodexActionAuthorityState() {},
    persistPendingCodexNativeRewindHandoff: (_tabId, payload) => {
      journalWrites += 1;
      assert.equal(payload.rewindSourceSnapshot.targetPhysicalSessionId, 'physical-source');
      return { success: true };
    },
    invalidateCodexWriterObservations() {},
  };
  const markBoundary = vm.runInNewContext(
    '(' + functionSource('markCodexWriterHandoffActionBoundary') + ')',
    context,
  );
  const rewindSourceSnapshot = {
    sourceSessionId: 'view-source',
    entryUuids: ['retained-user'],
    boundaryEntryUuid: 'retained-user',
    snapshotComplete: true,
    nextIterationIndex: 1,
    sourceSegments: [{
      physicalSessionId: 'physical-source',
      fromByte: 0,
      toByte: 100,
      startLine: 0,
      endLine: 8,
      prefixDigest: 'b'.repeat(64),
    }],
    capturedAt: 99,
    targetPhysicalSessionId: 'physical-source',
    targetSourceLine: 9,
    targetTurnStartByteOffset: 100,
  };
  return {
    call: () => markBoundary(tabId, 100, {
      ...target,
      rollbackTurns: 1,
      rewindSourceSnapshot,
      actionAuthority: authority,
    }),
    journalWrites: () => journalWrites,
  };
}

test('actual Rewind boundary persists the frozen source only while generation and input remain current', () => {
  const valid = createBoundaryHarness();
  assert.equal(valid.call(), true);
  assert.equal(valid.journalWrites(), 1);

  const staleGeneration = createBoundaryHarness({ intentGeneration: 'replacement-generation' });
  assert.equal(staleGeneration.call(), false);
  assert.equal(staleGeneration.journalWrites(), 0);

  const staleProgrammaticInput = createBoundaryHarness({ currentInputRevision: 5 });
  assert.equal(staleProgrammaticInput.call(), false);
  assert.equal(staleProgrammaticInput.journalWrites(), 0);

  const staleManualInput = createBoundaryHarness({
    currentInputRevision: 5,
    manualOwnedInputRevision: 4,
  });
  assert.equal(staleManualInput.call(), false);
  assert.equal(staleManualInput.journalWrites(), 0);
});
