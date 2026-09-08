'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { isSameCodexUnwrittenOperationScope, canUseCodexProofAfterDiscoveryCompletion } = require('./codex-writer-ownership');
const { projectCodexWriterInspectionFromProof } = require('./codex-runtime-contract');
const mainFile = process.env.NATIVE_REWIND_MAIN_BASELINE || path.join(__dirname, 'main.js');
const source = fs.readFileSync(mainFile, 'utf8');
const begin = source.indexOf('  async function authorizeCodexRewindAtWriteBoundary(');
const end = source.indexOf('\n  }\n\n', begin) + 5;
assert.ok(begin >= 0 && end > begin);
const body = source.slice(begin, end) + '\nauthorizeCodexRewindAtWriteBoundary';
const quiet = { log() {}, warn() {} };

function boundary({ change = null, afterWatcher = null, expectedKind = 'provisional-resume-source', resultKind = 'stale-generation' } = {}) {
  const term = { write() { assert.fail('authorization must not write PTY'); } };
  const state = { runSeq: 3, isRunning: true };
  const runtime = { generation: 'life:3', input: 7, observation: 2, ready: true, usable: true };
  const terminals = new Map([['T', term]]), intents = new Map([['T', { launchId: 'L' }]]);
  const launch = new Map([['T', { launchId: 'L' }]]), known = new Map(), turn = new Map();
  let proof = null, reconciles = 0;
  const publish = () => {
    proof = { valid: true, sessionId: 'S', filePath: '/owned/S.jsonl', pids: [99], launchId: 'L', terminalToken: term, lifecycleGeneration: 'life:3', runSeq: 3 };
    known.set('T', 'S'); intents.delete('T');
    if (change) change({ proof, runtime, terminals, state, launch, intents, known });
  };
  const context = {
    console: quiet, tabId: 'T', term, writerAuthorization: expectedKind, writerSessionId: 'S', writerLaunchId: 'L',
    terminals, codexSessionDiscoveryIntents: intents, codexLastRunCommandPayload: launch,
    codexKnownSessions: known, codexTurnWatchers: turn, codexTuiReadyMeta: new Map(), aiStoppingTabs: new Map(),
    terminalCommandState: new Map([['T', state]]), mainWindow: null,
    getTerminalLifecycleGeneration: () => runtime.generation,
    getTerminalInputRevision: () => runtime.input,
    getCodexWriterObservationGeneration: () => runtime.observation,
    getCodexWriterProofSnapshot: () => proof,
    isCodexWriterUsableForMutation: () => runtime.usable,
    isCodexTuiEffectivelyReady: () => runtime.ready,
    inspectAiDescendantProcessesByTab: async () => ({ status: 'found', matches: [{ pid: 99 }] }),
    AI_PROCESS_LOOKUP_STATUS: { UNKNOWN: 'unknown' },
    reconcileCodexWriterFromProcess: async () => {
      reconciles++;
      if (resultKind !== 'provisional-source') publish();
      return { status: resultKind, sessionId: 'S', preserveWriterProof: true, expectedLaunchId: 'L', currentLaunchId: null };
    },
    ensureCodexSubmissionWatcher: async () => { publish(); return { available: true, kind: 'writer', sessionId: 'S', launchId: 'L' }; },
    isSameCodexUnwrittenOperationScope, canUseCodexProofAfterDiscoveryCompletion, projectCodexWriterInspectionFromProof,
    resolveCodexNativeRewindSourceContext: () => ({ allowed: true, runtimeSourceSessionId: 'S', terminalToken: term, lifecycleGeneration: 'life:3', runSeq: 3 }),
    resolveCodexNativeRewindActionGeneration: args => args.writerActionGeneration || args.writerLaunchId,
    terminalProjects: new Map([['T', '/owned']]),
    ensureCodexTurnWatcher: async () => { turn.set('T', { sessionId: 'S', busy: false }); if (afterWatcher) afterWatcher({ runtime, state }); },
    hasCodexPromptOrTurnInFlight: () => false,
  };
  const fn = vm.runInNewContext(body, context);
  return { run: () => fn('locked-before-first-write'), proof: () => proof, count: () => reconciles };
}

test('actual native boundary re-reads the same confirmed source after discovery was consumed, with zero PTY action/reconcile replay', async () => {
  const h = boundary();
  const result = await h.run();
  assert.equal(result.success, true);
  assert.equal(result.writer.status, 'adopted');
  assert.equal(result.writer.projectionSource, 'event-owned-writer-proof');
  assert.equal(result.provisionalResumeRewind, false);
  assert.equal(h.count(), 1);
  assert.equal(h.proof().valid, true);
});

test('same-source confirmation is strengthening even when the reconcile result is already adopted', async () => {
  assert.equal((await boundary({ resultKind: 'adopted' }).run()).success, true);
});

test('confirmation during the additional submission-watcher read is also accepted without another action', async () => {
  assert.equal((await boundary({ resultKind: 'provisional-source' }).run()).success, true);
  assert.equal((await boundary({ resultKind: 'provisional-source', change: c => c.runtime.input++ }).run()).success, false);
});

test('changed terminal, run, input, lifecycle, ownership epoch, launch, writer and incomplete proof still refuse', async () => {
  for (const change of [
    c => c.terminals.set('T', {}), c => c.state.runSeq++, c => c.runtime.input++,
    c => { c.runtime.generation = 'replacement'; }, c => c.runtime.observation++,
    c => c.launch.set('T', { launchId: 'new-launch' }),
    c => c.intents.set('T', { launchId: 'new-discovery' }),
    c => { c.proof.sessionId = 'OTHER'; c.known.set('T', 'OTHER'); },
    c => { c.proof.valid = false; }, c => { c.runtime.usable = false; },
    c => { c.proof.pids = [101]; }, c => { c.proof.launchId = 'OTHER'; },
    c => { c.runtime.ready = false; },
  ]) {
    const h = boundary({ change });
    assert.equal((await h.run()).success, false, String(change));
    assert.equal(h.count(), 1);
  }
  for (const resultKind of ['stale-observer', 'stale-exit-observer', 'stale-observation-generation', 'unknown']) {
    assert.equal((await boundary({ resultKind }).run()).success, false, resultKind);
  }
});

test('a change during final turn-watcher read also cannot pass the unwritten boundary', async () => {
  assert.equal((await boundary({ afterWatcher: c => c.runtime.input++ }).run()).success, false);
});

const rendererFile = process.env.NATIVE_REWIND_RENDERER_BASELINE
  || path.join(__dirname, '../renderer/utils/agentScenarios.ts');
const renderer = fs.readFileSync(rendererFile, 'utf8');
const rendererBegin = renderer.indexOf('export async function revalidatePreparedCodexRewindRuntime(');
const rendererEnd = renderer.indexOf('\nexport async function rewindAgentTimelineScenario(', rendererBegin);
const revalidationBody = stripTypeScriptTypes(renderer.slice(rendererBegin, rendererEnd).replace(/^export /, ''))
  + '\nrevalidatePreparedCodexRewindRuntime';
async function revalidate({ kind = 'confirmed-writer', launchId = 'L', writer = 'S', busy = false, atomic = false } = {}) {
  let confirmedChecks = 0, separateTurnReads = 0;
  const turn = { hasWatcher: true, sessionId: kind === 'confirmed-writer' ? writer : null, provisional: kind === 'provisional-resume-source', catchUpPending: false, busy };
  const fn = vm.runInNewContext(revalidationBody, {
    proveCodexRewindTargetMapping: async () => ({ targetUuid: 'target', endUuid: 'end', lineageDepth: 0 }),
    ipcRenderer: { invoke: async channel => channel === 'codex:get-rewind-writer-authorization'
      ? { success: true, writerSessionId: writer, authorization: kind, launchId, ...(atomic ? { turnState: turn } : {}) }
      : (separateTurnReads++, turn) },
    requireConfirmedCodexWriter: async () => { confirmedChecks++; },
  });
  const result = await fn({ tabId: 'T', prepared: { sourceSessionId: 'S', writerSessionId: 'S', writerAuthorization: 'provisional-resume-source', writerLaunchId: 'L', targetUuid: 'target', endUuid: 'end' } });
  return { result, confirmedChecks, separateTurnReads };
}
test('actual renderer revalidation accepts only same-launch strengthening and adopts its confirmed turn check', async () => {
  const { result, confirmedChecks } = await revalidate();
  assert.equal(result.writerAuthorization, 'confirmed-writer');
  assert.equal(confirmedChecks, 1);
  assert.equal((await revalidate({ kind: 'provisional-resume-source' })).result.writerAuthorization, 'provisional-resume-source');
  for (const args of [{ launchId: 'new' }, { launchId: null }, { writer: 'other' }, { busy: true }]) {
    await assert.rejects(revalidate(args));
  }
});

test('renderer uses the turn from the same main authorization snapshot', async () => {
  const result = await revalidate({ atomic: true });
  assert.equal(result.separateTurnReads, 0);
  assert.equal(result.confirmedChecks, 1);
});

test('actual authorization query observes same-source strengthening during catch-up and returns its turn atomically', async () => {
  const start = source.indexOf("ipcMain.handle('codex:get-rewind-writer-authorization'");
  const finish = source.indexOf("ipcMain.handle('codex:get-tui-ready'", start);
  let handler, proof = null;
  const turns = new Map([['T', { hasWatcher: true, sessionId: null, provisional: true, busy: false }]]);
  vm.runInNewContext(source.slice(start, finish), {
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    terminalProjects: new Map([['T', '/owned']]),
    ensureCodexSubmissionWatcher: async () => ({ available: true, kind: 'provisional-source', sessionId: 'S', launchId: 'L' }),
    resolveCodexTurnState: async () => {
      proof = { valid: true, sessionId: 'S', launchId: 'L' };
      turns.set('T', { hasWatcher: true, sessionId: 'S', provisional: false, busy: false });
    },
    getCodexWriterProofSnapshot: () => proof,
    isCodexWriterUsableForMutation: () => true,
    codexTurnWatchers: turns, codexTurnStateSnapshot: value => ({ ...value }),
  });
  const auth = await handler(null, { tabId: 'T', sourceSessionId: 'S' });
  assert.equal(auth.authorization, 'confirmed-writer');
  assert.equal(auth.turnState.sessionId, 'S');
  assert.equal(auth.turnState.provisional, false);
});
