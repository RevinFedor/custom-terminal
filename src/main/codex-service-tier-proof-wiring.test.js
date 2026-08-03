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
  assert.match(identitySource, /writerProof\?\.launchId/);
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
  assert.match(publishSource, /if \(reusableProof\.preserved\)[\s\S]{0,360}return reusableProof\.proof/);
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
