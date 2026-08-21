'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'utils', 'agentScenarios.ts'),
  'utf8',
);
const flow = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'utils', 'agentSendFlow.mjs'),
  'utf8',
);
const preparation = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'utils', 'agentSendPreparation.ts'),
  'utf8',
);
const queueRunner = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'hooks', 'usePromptQueueRunner.ts'),
  'utf8',
);
const appSource = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'App.tsx'),
  'utf8',
);
const controlBar = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'components', 'Workspace', 'ClaudeControlBar.tsx'),
  'utf8',
);
const promptQueueOverlay = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'components', 'Workspace', 'PromptQueueOverlay.tsx'),
  'utf8',
);
const infoPanel = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'components', 'Workspace', 'panels', 'InfoPanel.tsx'),
  'utf8',
);
const historyPanel = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'components', 'Workspace', 'HistoryPanel.tsx'),
  'utf8',
);
const settingsContract = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'utils', 'agentSendSettingsContract.ts'),
  'utf8',
);

test('shared History/API/Queue prompt callers enter the tab-scoped intent sequencer', () => {
  assert.match(source, /function runAgentPromptScenario\(/);
  assert.match(source, /export function sendAgentPromptScenario[\s\S]*enqueueAgentSendScenario\(\{/);
  assert.match(source, /result = await runAgentPromptScenario\(args\)/);
  assert.match(source, /createAgentSendAdapter\(/);
  assert.match(source, /return runAgentSendFlow\(\{/);
  assert.match(queueRunner, /return sendAgentPromptScenario\(\{/,
    'Run After and Loop must cross the same product scenario as History/API sends');
  assert.doesNotMatch(queueRunner, /ipcRenderer\.invoke\((?:channel|'claude:send-command'|'codex:send-command')/,
    'Run After and Loop must not bypass the shared scenario with direct provider IPC');
  assert.match(flow, /prepareContext[\s\S]*ensureReady[\s\S]*proveComposer[\s\S]*runProviderOperation/);
  // `/fast` is a provider control that changes service tier; it is not a user
  // prompt and intentionally keeps its exact picker/write transaction.
  assert.match(appSource, /action === 'sendCodexFast'[\s\S]*command: '\/fast'/);
  assert.match(controlBar, /const sendCodexFast = async \(\)[\s\S]*command: '\/fast'/);
});

test('Cmd+Replay uses the shared driver while launch bootstrap remains a scoped exception', () => {
  assert.match(promptQueueOverlay, /if \(submitNow\)[\s\S]*runHistoryPromptHandoff\(\{/);
  assert.match(promptQueueOverlay, /send:\s*\(exactHandoffId\) => sendAgentPromptScenario\(\{/);
  assert.match(promptQueueOverlay, /settingsIntent:\s*AGENT_SETTINGS_INTENT_NONE/);
  assert.match(
    promptQueueOverlay,
    /else \{[\s\S]*ipcRenderer\.invoke\(sessionType \+ ':append-input'[\s\S]*submit:\s*false/,
    'plain Replay remains a draft transfer, not a send bypass',
  );
  const bootstrapStart = infoPanel.indexOf("command: 'claude'");
  const bootstrap = infoPanel.slice(bootstrapStart, bootstrapStart + 900);
  assert.ok(bootstrapStart >= 0);
  assert.match(bootstrap, /prompt:\s*finalPrompt/);
  assert.doesNotMatch(bootstrap, /\b(?:model|effort|thinking)\s*:/,
    'InfoPanel initial prompt is launch bootstrap, not a per-send settings request');
});

test('a submit during STARTING waits for the existing launch instead of creating another process', () => {
  assert.match(source, /requestedStatusAtSend:\s*context\.requestedStatusForSend/);
  assert.match(preparation, /const launchAlreadyInProgress = requestedStatusAtSend === 'starting'/);
  assert.match(preparation, /presence\?\.status === 'inactive' && !launchAlreadyInProgress/);
  assert.doesNotMatch(preparation, /\(!presence \|\| presence\.status === 'inactive'\)/,
    'unknown presence must never authorize Start/Resume');
  assert.match(preparation, /afterRejectedLaunch[\s\S]*action=wait-existing-launch/,
    'a concurrent launch refusal must be re-read and joined');
  assert.match(preparation, /wait for existing launch/);
  assert.match(source, /onReadyForSend\?\.\(statusForSend\)/);
});

test('public scenario callers classify settings before entering the shared send driver', () => {
  const argsStart = source.indexOf('export interface SendAgentPromptScenarioArgs');
  const argsEnd = source.indexOf('interface AgentSendFlowContext', argsStart);
  const args = source.slice(argsStart, argsEnd);
  assert.match(args, /settingsIntent:\s*AgentSettingsIntent/);
  assert.match(args, /historyRestartSettings\?:\s*AgentHistoryRestartSettings/);
  assert.doesNotMatch(args, /\n\s*(?:model|effort|thinking)\?:\s*string/,
    'loose settings fields must not re-enter the public scenario contract');

  assert.match(historyPanel, /settingsIntent:\s*AGENT_SETTINGS_INTENT_NONE/);
  assert.match(historyPanel, /historyRestartSettings,/);
  assert.match(queueRunner, /settingsIntent:\s*AGENT_SETTINGS_INTENT_NONE/);
  assert.match(appSource, /settingsIntent:\s*createAgentSettingsIntent\(\{/,
    'the untyped Project API bridge must normalize external fields exactly once');
  assert.match(settingsContract, /recordWithoutReply !== true && historyRestartSettings/);
  assert.match(settingsContract, /recordWithoutReply === true && settingsIntent\.kind === 'explicit-change'/);
});
