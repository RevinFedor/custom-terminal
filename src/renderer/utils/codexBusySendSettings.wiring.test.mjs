import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '..');
const mainRoot = path.resolve(rendererRoot, '..', 'main');
const scenarios = fs.readFileSync(path.join(here, 'agentScenarios.ts'), 'utf8');
const runtimes = fs.readFileSync(path.join(here, 'historyAgentRuntimes.ts'), 'utf8');
const historyPanel = fs.readFileSync(
  path.join(rendererRoot, 'components', 'Workspace', 'HistoryPanel.tsx'),
  'utf8',
);
const main = fs.readFileSync(path.join(mainRoot, 'main.js'), 'utf8');

test('ordinary History prompts do not inherit ambient Codex settings', () => {
  assert.match(
    historyPanel,
    /resolveCodexHistoryRestartSettingsState\(\{[\s\S]{0,180}recordWithoutReply/,
  );
  assert.match(
    historyPanel,
    /runtime\.toolType === 'codex'[\s\S]{0,120}recordWithoutReply[\s\S]{0,120}statusAtSend === 'active'[\s\S]{0,120}sessionId/,
  );
  assert.doesNotMatch(
    historyPanel,
    /model:\s*codexMutationProof\?\.model \|\| codexLaunchSettings\?\.model/,
  );
  assert.match(historyPanel, /settingsIntent:\s*AGENT_SETTINGS_INTENT_NONE/);
  assert.match(historyPanel, /historyRestartSettings,/);
});

test('busy send reuses one main-owned presence snapshot for settings identity', () => {
  assert.match(
    scenarios,
    /runtimeSnapshot:\s*readyForSend\?\.presence\?\.runtimeSnapshot \|\| null/,
  );
  assert.match(
    scenarios,
    /runtimeSnapshot:\s*ready\.runtimeSnapshot/,
  );
  assert.match(
    runtimes,
    /settingsRuntimeSnapshot = hasSettingsRequest[\s\S]{0,120}options\.runtimeSnapshot \|\| null/,
  );
});

test('runtime settings proof is tied to the exact adopted writer', () => {
  assert.match(
    main,
    /durableOwner === provenWriterSessionId[\s\S]{0,400}source: 'durable-writer-proof'/,
  );
  assert.match(
    main,
    /codexCurrentSettingsOwnerId:\s*currentCodexSettings\?\.ownerId \|\| null/,
  );
});
