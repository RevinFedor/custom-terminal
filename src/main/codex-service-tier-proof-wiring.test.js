'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoDir = path.join(__dirname, '../..');
const mainSource = fs.readFileSync(path.join(repoDir, 'src/main/main.js'), 'utf8');
const appSource = fs.readFileSync(path.join(repoDir, 'src/renderer/App.tsx'), 'utf8');
const controlBarSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/components/Workspace/ClaudeControlBar.tsx'),
  'utf8',
);

function functionSource(name, nextName) {
  const start = mainSource.indexOf('function ' + name);
  const end = mainSource.indexOf('function ' + nextName, start + 1);
  assert.ok(start >= 0 && end > start, 'expected function boundary for ' + name);
  return mainSource.slice(start, end);
}

test('normal task_complete refresh preserves only the same exact live service-tier proof', () => {
  const source = functionSource(
    'markCodexTuiReadyFromTurnEnd',
    'maybeArmCodexMcpStartupWatchdog',
  );
  assert.match(source, /const previousTierProof = codexTuiReadyMeta\.get\(tabId\)\?\.serviceTierProof/);
  assert.match(source, /getCurrentCodexServiceTierProofIdentity\(tabId\)/);
  assert.match(source, /preserveCodexServiceTierProofForTurnEnd\(previousTierProof, currentTierIdentity\)/);
  assert.match(source, /serviceTierProof: tierPreservation\.proof/);
  assert.match(source, /clearCodexServiceTierProof\([\s\S]{0,180}'turn-end-readiness-refresh:' \+ tierPreservation\.reason/);
});

test('service-tier publication binds the proof to terminal, run, launch, and current owner', () => {
  const identitySource = functionSource(
    'getCurrentCodexServiceTierProofIdentity',
    'clearCodexServiceTierProof',
  );
  assert.match(identitySource, /const terminalToken = terminals\.get\(tabId\)/);
  assert.match(identitySource, /getTerminalLifecycleGeneration\(tabId\)/);
  assert.match(identitySource, /terminalCommandState\.get\(tabId\)\?\.runSeq/);
  assert.match(identitySource, /const terminalRunOwnerId = !writerOwnerId[\s\S]{0,240}'terminal-run:' \+ terminalLifecycleGeneration/);
  assert.doesNotMatch(identitySource, /ownerId === writerOwnerId[\s\S]{0,120}writerProof\?\.launchId/);
  assert.match(identitySource, /ownerId === provisionalOwnerId[\s\S]{0,120}codexProvisionalSettingsLaunchId/);
  assert.match(identitySource, /const generationMode = launchId \? 'launch' : 'terminal-run'/);
  assert.match(identitySource, /requestedOwnerId !== writerOwnerId[\s\S]{0,100}requestedOwnerId !== provisionalOwnerId/);

  const publishSource = functionSource(
    'publishCodexServiceTierProof',
    'isCodexWriterUsableForMutation',
  );
  assert.match(publishSource, /createCodexServiceTierProof\(\{/);
  assert.match(publishSource, /\.\.\.identity/);
  assert.match(publishSource, /serviceTier: normalizedTier/);
  assert.match(publishSource, /previousProof\?\.serviceTier === normalizedTier[\s\S]{0,180}preserveCodexServiceTierProofForTurnEnd\(previousProof, identity\)/);
  assert.match(publishSource, /if \(reusableProof\.preserved\)[\s\S]{0,520}return reusableProof\.proof/);
});

test('writer and lifecycle invalidation clear main proof and renderer live tier', () => {
  const invalidateSource = functionSource(
    'invalidateCodexWriterProof',
    'clearCodexKnownSession',
  );
  assert.match(invalidateSource, /clearCodexServiceTierProof\(tabId, 'writer-proof-invalidated:' \+ reason\)/);
  const clearReadySource = functionSource(
    'clearCodexTuiReady',
    'resetCodexTuiReadyDetection',
  );
  assert.match(clearReadySource, /clearCodexServiceTierProof\(tabId, 'tui-ready-cleared:' \+ reason\)/);
  assert.match(clearReadySource, /clearCodexServiceTierLaunchCandidate\(tabId, 'tui-ready-cleared:' \+ reason\)/);
  assert.match(appSource, /if \(data\?\.cleared === true\)[\s\S]{0,260}codexLiveServiceTier: undefined/);
  assert.match(controlBarSource, /if \(!ownerId \|\| !\['priority', 'default'\]\.includes\(serviceTier\)\)[\s\S]{0,260}codexLiveServiceTier: undefined/);
});

test('same-writer adoption revalidates proof while explicit tier feedback replaces it', () => {
  const setKnownSource = functionSource(
    'setCodexKnownSession',
    'getCodexWriterProofSnapshot',
  );
  assert.match(setKnownSource, /publishCodexServiceTierProof\([\s\S]{0,180}'verified-composer-writer-handoff'/);
  assert.match(setKnownSource, /publishCodexServiceTierProof\([\s\S]{0,180}'live-writer-handoff'/);
  assert.match(setKnownSource, /reconcileCodexServiceTierProofIdentity\(tabId, 'writer-adoption'\)/);
});

test('an exact provisional FAST proof is carried atomically to the first durable writer', () => {
  const setKnownSource = functionSource(
    'setCodexKnownSession',
    'getCodexWriterProofSnapshot',
  );
  assert.match(setKnownSource, /authorizeCodexServiceTierProofOwnerHandoff\([\s\S]{0,520}sourceOwnerId: incomingLaunchId[\s\S]{0,100}'terminal-run:' \+ currentTierLifecycleGeneration/);
  assert.match(setKnownSource, /exactSettingsProofToPersist[\s\S]{0,220}fast: serviceTierOwnerHandoff\.proof\.fast/);
  assert.match(setKnownSource, /if \(serviceTierOwnerHandoff\.allowed\)[\s\S]{0,220}'exact-first-writer-service-tier-handoff'/);
  const syncSource = functionSource(
    'syncPendingCodexServiceTierProof',
    'publishCodexServiceTierProof',
  );
  assert.match(syncSource, /!\['launch', 'terminal-run'\]\.includes\(pending\.generationMode\)/);
  assert.match(syncSource, /identity\?\.terminalToken !== pending\.terminalToken/);
  assert.match(syncSource, /identity\?\.launchId !== pending\.launchId/);
  assert.match(syncSource, /identity\?\.generationId !== identity\?\.terminalLifecycleGeneration/);
  assert.match(syncSource, /fast: proof\.fast/);
});

test('fresh launch card can prove FAST only for the exact launch generation before writer adoption', () => {
  assert.match(mainSource, /parseCodexVerifiedLaunchCardSettings,/);
  const resolveSource = functionSource(
    'resolveCodexVerifiedCurrentFrameSettings',
    'armCodexCurrentLaunchSettingsProof',
  );
  assert.match(resolveSource, /parseCodexVerifiedComposerFooter\(frameText \|\| ''\)/);
  assert.match(resolveSource, /if \(footerSettings\) return footerSettings/);
  assert.match(resolveSource, /parseCodexVerifiedLaunchCardSettings\(frameText \|\| ''\)/);
  assert.match(resolveSource, /getCodexWriterProofSnapshot\(tabId\)/);
  assert.match(resolveSource, /getCurrentCodexServiceTierLaunchCandidate\(tabId/);
  assert.match(resolveSource, /launch\?\.terminalToken !== terminalToken/);
  assert.match(resolveSource, /Number\(launch\?\.runSeq\) !== terminalRunSeq/);
  assert.match(resolveSource, /\(launch\.lifecycleGeneration \|\| launch\.terminalLifecycleGeneration\) !== lifecycleGeneration/);
  assert.match(resolveSource, /expectedLaunchId && launchId !== expectedLaunchId/);

  const armSource = functionSource(
    'armCodexCurrentLaunchSettingsProof',
    'getCurrentCodexServiceTierProofIdentity',
  );
  assert.match(armSource, /getCodexWriterProofSnapshot\(tabId\)/);
  assert.match(armSource, /getCurrentCodexServiceTierLaunchCandidate\(tabId/);
  assert.match(armSource, /createPendingCodexSettingsProofHandoff\(\{/);
  assert.match(armSource, /terminalToken,/);
  assert.match(armSource, /runSeq: terminalRunSeq/);
  assert.match(armSource, /launchId,/);
  assert.match(armSource, /applicationProofSource: settings\.proof/);
});

test('readiness, output-edge recovery, and explicit state read share the exact frame settings proof', () => {
  const emitSource = functionSource('tryEmitCodexTuiReady', 'closeCodexWatcher');
  assert.match(emitSource, /const tierLaunch = codexLastRunCommandPayload\.get\(tabId\)[\s\S]{0,100}getCurrentCodexServiceTierLaunchCandidate\(tabId\)/);
  assert.match(emitSource, /const tierProbeTrigger = codexTuiReadyTabs\.has\(tabId\)[\s\S]{0,240}!getCodexWriterProofSnapshot\(tabId\)[\s\S]{0,120}tierLaunch\?\.launchId[\s\S]{0,120}\/model:\|Full Access\/i\.test\(clean\)/);
  assert.match(emitSource, /resolveCodexVerifiedCurrentFrameSettings\(/);
  assert.match(emitSource, /const launchSettingsProof = composerSettings[\s\S]{0,100}armCodexCurrentLaunchSettingsProof\(tabId, composerSettings\)/);
  assert.match(emitSource, /footerIsCurrentComposer \|\| launchCardIsCurrentGeneration \|\| !!launchSettingsProof/);

  const getStateSource = functionSource('getCodexTuiReadyState', 'markCodexTuiReadyAfterVerifiedComposer');
  assert.match(getStateSource, /resolveCodexVerifiedCurrentFrameSettings\(/);
  assert.match(getStateSource, /armCodexCurrentLaunchSettingsProof\(tabId, composerSettings\)/);

  const readySource = functionSource(
    'markCodexTuiReadyAfterVerifiedComposer',
    'pokeCodexStartupPromptFromVisibleBuffer',
  );
  assert.match(readySource, /resolveCodexVerifiedCurrentFrameSettings\([\s\S]{0,240}expectedLaunchId,[\s\S]{0,80}expectedTerminal,[\s\S]{0,80}expectedRunSeq/);
  assert.match(readySource, /armCodexCurrentLaunchSettingsProof\(tabId, composerSettings,[\s\S]{0,180}expectedLaunchId,[\s\S]{0,80}expectedTerminal,[\s\S]{0,80}expectedRunSeq/);
  assert.match(readySource, /const previousTierProof = codexTuiReadyMeta\.get\(tabId\)\?\.serviceTierProof/);
  assert.match(readySource, /finishCodexStartupLifecycle\(tabId, reason,[\s\S]{0,120}preserveLateMcpRecovery: true/);
  assert.ok(
    readySource.indexOf('finishCodexStartupLifecycle(tabId, reason,')
      < readySource.indexOf('preserveCodexServiceTierProofForTurnEnd(previousTierProof, currentTierIdentity)'),
    'startup cleanup must precede exact service-tier proof restoration',
  );
  assert.match(readySource, /serviceTierProof: tierPreservation\.proof/);
});

test('startup cleanup retains only the exact late-card candidate until writer adoption', () => {
  const finishSource = functionSource(
    'finishCodexStartupLifecycle',
    'markCodexTuiReadyFromTurnEnd',
  );
  assert.match(finishSource, /clearCodexLaunchPayload\(tabId, reason, null, \{[\s\S]{0,120}preserveServiceTierLaunchCandidate: true/);

  const knownSource = functionSource('setCodexKnownSession', 'getCodexWriterProofSnapshot');
  assert.match(knownSource, /clearCodexServiceTierLaunchCandidate\([\s\S]{0,120}'first-writer-adopted:' \+ sessionId/);

  assert.match(mainSource, /const codexServiceTierLaunchCandidates = new Map\(\)/);
  assert.match(mainSource, /armCodexServiceTierLaunchCandidate\(tabId, launchPayload\)/);
  assert.match(mainSource, /clearCodexServiceTierLaunchCandidate\(tabId, 'launch-started:' \+ launchId\)/);
  assert.match(mainSource, /if \(!generationAdvance\.consumed\) \{[\s\S]{0,120}clearCodexServiceTierLaunchCandidate\(tabId, 'shell-command-generation-started'\)/);
});

test('a transient startup blocker revokes input readiness without erasing same-generation FAST proof', () => {
  const retainSource = functionSource(
    'retainCodexServiceTierProofAcrossReadinessBlocker',
    'syncPendingCodexServiceTierProof',
  );
  assert.match(retainSource, /getCurrentCodexServiceTierProofIdentity\(tabId\)/);
  assert.match(retainSource, /preserveCodexServiceTierProofForTurnEnd\(previousProof, identity\)/);
  assert.match(retainSource, /clearCodexServiceTierProof\(/);

  const blockerSource = functionSource(
    'invalidateCodexTuiReadyForStartupBlocker',
    'inspectCodexInputReadyText',
  );
  assert.match(blockerSource, /const hadReady = codexTuiReadyTabs\.delete\(tabId\)/);
  assert.match(blockerSource, /retainCodexServiceTierProofAcrossReadinessBlocker\(/);
  assert.match(blockerSource, /codexTuiReadyMeta\.delete\(tabId\)/);
  assert.match(blockerSource, /if \(retainedTierProof\)[\s\S]{0,120}codexTuiReadyMeta\.set\(tabId, \{ serviceTierProof: retainedTierProof \}\)/);
});
