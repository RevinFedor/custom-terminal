/**
 * Wiring guard for the screen-found / exact-empty Ctrl+G reconciliation.
 *
 * Prod scar 2026-07-29 (tab-2599): the screen parser reported an old prompt
 * as a draft, Ctrl+G twice returned zero bytes, but the shared send path still
 * returned `Terminal has an unsent draft`. The proof also crosses an external
 * editor boundary, so resolving a generic grab before Claude redraws its next
 * frame can lose the following paste. These checks keep the exact screen proof
 * attached to its grab without delaying unrelated grab/copy operations.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const scenarioSource = fs.readFileSync(
  path.join(__dirname, '../renderer/utils/agentScenarios.ts'),
  'utf8',
);
const historyPanelSource = fs.readFileSync(
  path.join(__dirname, '../renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);
const claudeRuntimeSource = fs.readFileSync(
  path.join(__dirname, '../renderer/utils/claudePtyActions.ts'),
  'utf8',
);
const codexRuntimeSource = fs.readFileSync(
  path.join(__dirname, '../renderer/utils/historyAgentRuntimes.ts'),
  'utf8',
);

test('shared send passes the exact screen proof into the Ctrl+G request', () => {
  assert.match(
    scenarioSource,
    /runtime\.grabDraft\(tabId,\s*\{\s*draftProof:\s*buildExactDraftCaptureProof\(visual\)/,
    'the grab must carry the exact proof that it is trying to disprove',
  );
  assert.match(
    scenarioSource,
    /runtime\.copyDraft\(tabId,\s*\{\s*draftProof:\s*buildExactDraftCaptureProof\(visual\)/,
    'project-owned sends must inspect without removing a real terminal draft',
  );
  for (const field of [
    'terminalRunSeq',
    'inputRevision',
    'terminalLifecycleGeneration',
    'mirrorGeneration',
    'mirrorWriteSeq',
    'mirrorFlushedSeq',
    'mirrorSynchronizedOutputOpen',
    'synchronizedOutputGeneration',
  ]) {
    const helperSource = fs.readFileSync(
      path.join(__dirname, '../renderer/utils/agentDraftPreflight.mjs'),
      'utf8',
    );
    assert.match(helperSource, new RegExp(field + ':\\s*proof\\?\\.' + field));
  }
});

test('missing active prompt escalates only from a current idle frame and is rechecked before Ctrl+G', () => {
  assert.match(
    mainSource,
    /classifyClaudeMissingPromptCaptureForTab\([\s\S]{0,1400}exactCaptureRecommended:\s*true/,
    'main must attach exact-capture authority after lifecycle admission, not in the screen parser',
  );
  const captureGuard = mainSource.indexOf('const isClaudeMissingPromptCapture =');
  const liveSnapshot = mainSource.indexOf("'before-missing-prompt-exact-capture'", captureGuard);
  const frameGuard = mainSource.indexOf(
    'validateAgentInputFrameIdentity(tabId, draftProofCaptureIdentity)',
    liveSnapshot,
  );
  const refusal = mainSource.indexOf("error: 'claude_draft_state_unknown_before_paste'", frameGuard);
  const ctrlG = mainSource.indexOf("term.write('\\x07')", refusal);
  assert.ok(
    captureGuard > 0
      && liveSnapshot > captureGuard
      && frameGuard > liveSnapshot
      && refusal > frameGuard
      && ctrlG > refusal,
    'the exact current frame and lifecycle must be revalidated before Ctrl+G can touch Claude',
  );
});

test('an exact empty capture replaces the stale screen-unknown decision', () => {
  assert.match(
    scenarioSource,
    /let draftDecision = classifyAgentDraftPreflight\(visual\)/,
    'the initial screen decision must be replaceable after exact capture',
  );
  assert.match(
    scenarioSource,
    /conflict\.decision === 'clear'[\s\S]{0,180}draftDecision = applyAgentDraftCaptureResolution\(draftDecision, conflict\)/,
    'an exact empty capture must clear the original unknown before its final guard runs',
  );
  const resolvedAt = scenarioSource.indexOf(
    'draftDecision = applyAgentDraftCaptureResolution(draftDecision, conflict)',
  );
  const unknownGuardAt = scenarioSource.indexOf(
    "if (draftDecision.decision === 'unknown')",
    resolvedAt,
  );
  assert.ok(resolvedAt > 0 && unknownGuardAt > resolvedAt,
    'the final unknown guard must consume the reconciled decision');
});

test('History composer carries the same exact proof into its ownership-changing grab', () => {
  assert.match(
    historyPanelSource,
    /runtime\.grabDraft\(tabId, draftState \? \{\s*draftProof:\s*buildExactDraftCaptureProof\(draftState\)/,
  );
  assert.match(
    historyPanelSource,
    /resolveAgentDraftConflict\(draftState, result, \{\s*attemptedCapture:\s*true/,
    'an empty Ctrl+G result must not silently clear an ambiguous screen without exact identity proof',
  );
});

test('main forwards grab options and records identity before Ctrl+G', () => {
  assert.match(
    mainSource,
    /claude:grab-input'[\s\S]{0,180}captureAgentInput\(tabId, 'grab', 'claude', options\)/,
  );
  assert.match(
    mainSource,
    /codex:grab-input'[\s\S]{0,180}captureAgentInput\(tabId, 'grab', 'codex', options\)/,
  );
  assert.match(
    mainSource,
    /claude:copy-input'[\s\S]{0,180}captureAgentInput\(tabId, 'copy', 'claude', options\)/,
  );
  const identityGuard = mainSource.indexOf('const draftProofMatchesAtWrite =');
  const pendingProof = mainSource.indexOf(
    'draftProofIdentityAtWrite: draftProofMatchesAtWrite',
    identityGuard,
  );
  const ctrlGWrite = mainSource.indexOf("term.write('\\x07')", pendingProof);
  assert.ok(identityGuard > 0 && pendingProof > identityGuard && ctrlGWrite > pendingProof,
    'the proof identity must be frozen on the pending grab before Ctrl+G is written');
  assert.match(
    mainSource,
    /identityStable = validateAgentInputIdentity[\s\S]{0,180}pending\.draftProofIdentityAtWrite === true/,
    'an empty grab from a changed generation must stay unknown',
  );
});

test('Ctrl+G owns the shared PTY write boundary and advances input identity exactly there', () => {
  const privateCapture = mainSource.indexOf('async function captureAgentInputAtWriteBoundary(');
  const publicCapture = mainSource.indexOf('async function captureAgentInput(tabId, mode, agent');
  const lock = mainSource.indexOf('return withPtyWriteLock(', publicCapture);
  const privateCall = mainSource.indexOf(
    'captureAgentInputAtWriteBoundary(tabId, mode, agent, options, term)',
    lock,
  );
  assert.ok(
    privateCapture > 0 && publicCapture > privateCapture && lock > publicCapture && privateCall > lock,
    'public grab/copy/restore must serialize the whole Ctrl+G roundtrip',
  );

  const revision = mainSource.indexOf('const ownedInputRevision = bumpTerminalInputRevision(tabId)', privateCapture);
  const pending = mainSource.indexOf('grabInputPending.set(tabId', revision);
  const ctrlG = mainSource.indexOf("term.write('\\x07')", pending);
  assert.ok(
    revision > privateCapture && pending > revision && ctrlG > pending,
    'the revision reservation must happen at the locked boundary before Ctrl+G',
  );
  const proofIdentity = mainSource.indexOf(
    'const draftProofCaptureIdentity = captureAgentInputIdentity',
    privateCapture,
  );
  const postReservationIdentity = mainSource.indexOf(
    'const captureIdentity = captureAgentInputIdentity',
    proofIdentity + 1,
  );
  assert.ok(
    proofIdentity > privateCapture
      && postReservationIdentity > proofIdentity
      && postReservationIdentity < publicCapture,
    'the pre-Ctrl+G proof identity and post-reservation capture identity must remain separate',
  );
});

test('Codex Rewind uses the already-owned capture boundary instead of nesting the PTY lock', () => {
  const rewindStart = mainSource.indexOf('async function grabRestoredCodexRewindInput(');
  const rewindEnd = mainSource.indexOf('let codexRewindOverlayOpen', rewindStart);
  const body = mainSource.slice(rewindStart, rewindEnd);
  assert.match(body, /captureAgentInputAtWriteBoundary\(/);
  assert.doesNotMatch(body, /await captureAgentInput\(/);
});

test('every external-editor capture holds PTY ownership until the agent TUI returns', () => {
  assert.match(
    mainSource,
    /const editorReturnPromise = agent === 'claude'[\s\S]{0,220}waitForNextPtySynchronizedFrame[\s\S]{0,220}waitForNextPtyOutput/,
    'Claude must wait for its complete synchronized frame and Codex for its post-helper PTY edge',
  );
  const waiter = mainSource.indexOf("const editorReturnPromise = agent === 'claude'");
  const acknowledge = mainSource.indexOf('acknowledgeHookEnvelope();', waiter);
  assert.ok(waiter > 0 && acknowledge > waiter,
    'the return waiter must be armed before helper acknowledgement can let the TUI resume');
  assert.match(
    mainSource,
    /exactEmptyProven = exactEmpty\s*&&\s*!!contradiction\s*&&\s*identityStable\s*&&\s*editorReturn\?\.ready === true/,
  );
  assert.match(
    mainSource,
    /success: editorReturn\?\.ready === true,[\s\S]{0,120}external_editor_return_unconfirmed/,
    'a timeout is unknown/failure, never permission to continue writing',
  );
});

test('ownership-changing grab cannot share an in-flight result with non-destructive copy', () => {
  assert.match(claudeRuntimeSource, /const captureKey = tabId \+ ':' \+ mode;/);
  assert.match(claudeRuntimeSource, /draftGrabInflight\.get\(captureKey\)/);
  assert.match(codexRuntimeSource, /const captureKey = tabId \+ ':' \+ mode;/);
  assert.match(codexRuntimeSource, /codexDraftInflight\.get\(captureKey\)/);
});
