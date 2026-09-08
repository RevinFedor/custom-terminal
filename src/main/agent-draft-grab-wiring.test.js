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
  path.join(__dirname, '../renderer/utils/agentSendPreparation.ts'),
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
const appSource = fs.readFileSync(
  path.join(__dirname, '../renderer/App.tsx'),
  'utf8',
);
const terminalRegistrySource = fs.readFileSync(
  path.join(__dirname, '../renderer/utils/terminalRegistry.ts'),
  'utf8',
);
const contradictionToastSource = fs.readFileSync(
  path.join(__dirname, '../renderer/utils/agentDraftContradictionToast.mjs'),
  'utf8',
);

test('shared send passes the exact screen proof into the Ctrl+G request', () => {
  const entry = fs.readFileSync(path.join(__dirname, '../renderer/utils/agentScenarios.ts'), 'utf8');
  const adapter = fs.readFileSync(path.join(__dirname, '../renderer/utils/agentSendAdapter.ts'), 'utf8');
  assert.match(entry, /runAgentSendFlow\(/);
  assert.match(entry, /createAgentSendAdapter\(/);
  assert.match(adapter, /proveComposer:.*proveAgentComposerForSend\(/s);
  assert.match(
    scenarioSource,
    /runtime\.grabDraft\(tabId,\s*\{\s*draftProof:\s*buildDraftCaptureProof\(tabId, visual\)/,
    'the grab must carry the exact proof that it is trying to disprove',
  );
  assert.match(
    scenarioSource,
    /runtime\.copyDraft\(tabId,\s*\{\s*draftProof:\s*buildDraftCaptureProof\(tabId, visual\)/,
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
  assert.match(
    scenarioSource,
    /terminalRegistry\.getDraftDiagnosticSnapshot\(tabId,[\s\S]{0,220}promptRow:[\s\S]{0,120}cursorRow:/,
    'the proof must carry a bounded snapshot of the renderer xterm from the same pre-grab moment',
  );
  assert.match(
    mainSource,
    /\[AgentDraftProof:CONTRADICTION\][\s\S]{0,500}parity=[\s\S]{0,500}rendererBefore=[\s\S]{0,500}headlessBefore=/,
    'a contradiction must log both screens and whether their write boundary is comparable',
  );
});

test('a contradiction records painted renderer evidence after visibility and resize settle', () => {
  assert.match(
    mainSource,
    /requestAgentDraftScreenDiagnostic\([\s\S]{0,180}'ctrl-g-empty-after-screen-found'/,
    'the contradiction must arm a renderer/headless follow-up instead of relying on a hidden preflight frame',
  );
  assert.match(
    appSource,
    /const handleTerminalDraftScreenDiagnosticRequest[\s\S]{0,2200}waitForPaintedDraftScreenDiagnostic/,
    'the renderer must wait for a painted, stable boundary before returning its follow-up',
  );
  assert.match(
    terminalRegistrySource,
    /painted:\s*hiddenBy === null[\s\S]{0,300}layerPresented:/,
    'renderer evidence must say whether the xterm was actually painted, not merely mounted',
  );
  assert.match(
    mainSource,
    /\[AgentDraftProof:SCREEN_FOLLOWUP\][\s\S]{0,700}parity=[\s\S]{0,700}renderer=[\s\S]{0,700}headless=/,
  );
  assert.match(
    mainSource,
    /capturePage\([\s\S]{0,700}\[AgentDraftProof:SCREEN_ARTIFACT\]/,
    'the stable visible frame must leave a bounded screenshot artifact for pixel-level verification',
  );
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
    /runtime\.grabDraft\(tabId, draftState \? \{\s*draftProof:\s*buildExactDraftCaptureProof\([\s\S]{0,220}draftState,[\s\S]{0,220}getDraftDiagnosticSnapshot\(tabId/,
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
    'captureAgentInputAtWriteBoundary(',
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
    'let draftProofCaptureIdentity = captureAgentInputIdentity',
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
  assert.match(
    mainSource,
    /const inputRevisionTransitionOwned\s*=\s*validateAgentExactCaptureInputTransition\(pending\)[\s\S]{0,2600}inputRevisionTransition:\s*'ctrl-g-exact-capture'[\s\S]{0,220}screenProofInputRevision:/,
    'main must attest its own exact pre-proof → Ctrl+G revision transition',
  );
});

test('missing-prompt fallback excludes the capture operation itself from PTY contention', () => {
  const publicCapture = mainSource.indexOf('async function captureAgentInput(tabId, mode, agent');
  const nextFunction = mainSource.indexOf('async function captureClaudeInput(', publicCapture);
  const body = mainSource.slice(publicCapture, nextFunction);
  assert.match(body, /ownedWriteOperation:\s*operation/);
  assert.match(
    mainSource,
    /hasConflictingPtyWriteOperation\(\{[\s\S]{0,260}ownedOperation:\s*ownedWriteOperation/,
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
    /const startEditorReturnWait = \(\) => agent === 'claude'[\s\S]{0,220}waitForNextPtySynchronizedFrame[\s\S]{0,220}waitForNextPtyOutput/,
    'Claude must wait for its complete synchronized frame and Codex for its post-helper PTY edge',
  );
  const snapshot = mainSource.indexOf('pending.preparedDraft = { text: resolvedText');
  const waiter = mainSource.indexOf('editorReturnPromise = startEditorReturnWait();', snapshot);
  const authorize = mainSource.indexOf('agentInputCaptureProtocol.authorize(', waiter);
  const acknowledge = mainSource.indexOf('acknowledgeCapture(authorization.decision)', authorize);
  assert.ok(snapshot > 0 && waiter > snapshot && authorize > waiter && acknowledge > authorize,
    'a complete snapshot and return waiter must precede disk commit/socket acknowledgement');
  assert.match(
    mainSource,
    /exactEmptyProven = exactEmpty\s*&&\s*!!contradiction\s*&&\s*identityStable\s*&&\s*inputRevisionTransitionOwned\s*&&\s*editorReturn\?\.ready === true/,
  );
  assert.match(
    mainSource,
    /waitForAgentEditorReturnReady[\s\S]{0,900}waitForHeadlessSynchronizedOutputClose/,
    'Claude return is usable only after the raw frame is parsed and flushed by the headless xterm',
  );
  assert.match(
    mainSource,
    /waitForAgentEditorReturnReady[\s\S]{0,1400}afterWriteSeq:\s*captureIdentity\?\.mirrorWriteSeq/,
    'the flushed frame must be newer than the frame captured before Ctrl+G',
  );
  assert.match(
    mainSource,
    /const captureSucceeded = editorReturn\?\.ready === true && helperApplied && identityStable;[\s\S]{0,120}success: captureSucceeded/,
    'a timeout is unknown/failure, never permission to continue writing',
  );
});

test('a resolved screen contradiction remains visible as one closeable tab-scoped error', () => {
  assert.match(
    scenarioSource,
    /conflict\.decision === 'clear'[\s\S]{0,300}showAgentDraftScreenContradictionToast\(useUIStore\.getState\(\)/,
  );
  assert.match(
    historyPanelSource,
    /conflict\.decision !== 'clear'[\s\S]{0,300}showAgentDraftScreenContradictionToast\(useUIStore\.getState\(\)/,
  );
  assert.match(contradictionToastSource, /'error'[\s\S]{0,80}true/);
  assert.match(contradictionToastSource, /toast\?\.tabId === exactTabId/);
});

test('ownership-changing grab cannot share an in-flight result with non-destructive copy', () => {
  assert.match(claudeRuntimeSource, /const captureKey = tabId \+ ':' \+ mode \+ ':' \+ captureRequestId;/);
  assert.match(claudeRuntimeSource, /draftGrabInflight\.get\(captureKey\)/);
  assert.match(codexRuntimeSource, /const captureKey = tabId \+ ':' \+ mode \+ ':' \+ captureRequestId;/);
  assert.match(codexRuntimeSource, /codexDraftInflight\.get\(captureKey\)/);
});

test('Codex closes a proven slash completion before Ctrl+G and preserves the same draft', () => {
  const helperStart = mainSource.indexOf(
    'async function dismissCodexSlashCompletionBeforeExternalEditor(',
  );
  const helperEnd = mainSource.indexOf(
    '\nfunction validateAgentExactCaptureInputTransition',
    helperStart,
  );
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  const helper = mainSource.slice(helperStart, helperEnd);
  assert.match(helper, /inspectCodexSlashCompletionSnapshot\(before\)/);
  assert.match(helper, /waitForHeadlessSynchronizedOutputClose\(tabId, mirror, 900\)/);
  assert.match(helper, /const ownedInputRevision = bumpTerminalInputRevision\(tabId\)/);
  assert.match(helper, /waitForCommittedSemanticFrame\(\{/);
  assert.match(helper, /inspectCodexSlashCompletionDismissal\(snapshot, completion\.draftText\)/);
  assert.match(helper, /inspection\.dismissed === true && inspection\.draftPreserved === true/);
  assert.match(helper, /term\.write\('\\x1b'\)/);
  assert.match(helper, /proofReason: 'codex-slash-completion-dismissed-draft-preserved'/);

  const captureStart = mainSource.indexOf('async function captureAgentInputAtWriteBoundary(');
  const captureEnd = mainSource.indexOf('\nasync function captureAgentInput(', captureStart);
  const capture = mainSource.slice(captureStart, captureEnd);
  const pendingGuard = capture.indexOf('if (grabInputPending.has(tabId))');
  const dismiss = capture.indexOf('dismissCodexSlashCompletionBeforeExternalEditor(');
  const writeLocks = capture.indexOf('agentInputCaptureProtocol.arm({', dismiss);
  const ctrlG = capture.indexOf("term.write('\\x07')", writeLocks);
  assert.ok(
    pendingGuard >= 0 && dismiss > pendingGuard && writeLocks > dismiss && ctrlG > writeLocks,
    'slash completion dismissal must stay inside the serialized capture and precede helper locks/Ctrl+G',
  );
  assert.match(
    capture,
    /draftProofCaptureIdentity = captureAgentInputIdentity\(tabId, term\)[\s\S]{0,260}agentDraftProofMatchesCaptureIdentity/,
    'the verified Escape transition must rebase the proof before Ctrl+G owns its own revision',
  );
});
