'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const main = read('src/main/main.js');
const lifecycle = read('src/renderer/components/Workspace/useAgentLifecycle.ts');
const history = read('src/renderer/components/Workspace/HistoryPanel.tsx');

test('every committed headless frame can terminalize an exact capacity attempt', () => {
  const commitStart = main.indexOf('function commitHeadlessVisibleBufferSnapshot');
  const commitEnd = main.indexOf('function parseClaudeDraftFromVisibleSnapshot', commitStart);
  const commitBody = main.slice(commitStart, commitEnd);
  assert.match(commitBody, /observeCodexModelCapacityCommittedFrame\(/);

  const finishStart = main.indexOf('function finishCodexModelCapacityOutcome');
  const finishEnd = main.indexOf('function observeCodexModelCapacityCommittedFrame', finishStart);
  const finishBody = main.slice(finishStart, finishEnd);
  assert.match(finishBody, /markCodexTuiReadyFromTurnEnd\(tabId, 'model-capacity'\)/);
  assert.match(finishBody, /emitCodexBusy\(tabId, false, 'model_capacity'/);
  assert.match(finishBody, /if \(lifecycleStillPending\) \{[\s\S]*emitCodexBusy/,
    'a rollout that already ended the turn must not receive a duplicate done edge');
  assert.match(finishBody, /setCodexLifecycleWarning/);
  assert.doesNotMatch(finishBody, /finalizeStoppedAiCommandState|stop_ai|kill/);
});

test('capacity watch starts only for the exact submitted prompt or task turn', () => {
  const submittedStart = main.indexOf('function markCodexPromptSubmitted');
  const submittedEnd = main.indexOf('function clearCodexPromptInFlight', submittedStart);
  assert.match(main.slice(submittedStart, submittedEnd), /armCodexModelCapacityWatch\(tabId, reason\)/);

  const turnStart = main.indexOf('if (turnOutcome?.busy === true)');
  const turnEnd = main.indexOf('if (turnOutcome?.busy === false)', turnStart);
  assert.match(main.slice(turnStart, turnEnd), /armCodexModelCapacityWatch\(state\.tabId, 'task-started'/);
  assert.match(main, /Number\(getTerminalInputRevision\(tabId\)\) === Number\(watch\.inputRevision\)/);
});

test('warning is level-triggered per tab and History renders it amber without a spinner', () => {
  assert.match(main, /lifecycleWarning: codexLifecycleWarnings\.get\(tabId\) \|\| null/);
  assert.match(main, /ipcMain\.handle\('codex:clear-lifecycle-warning'/);
  assert.match(lifecycle, /kind: isWarning \? 'warning'/);
  assert.match(lifecycle, /ipcRenderer\.on\('codex:lifecycle-warning'/);
  assert.match(history, /lifecycleIsWarning\s*\? '#f59e0b'/);
  assert.match(history, /lifecycleNeedsExplanation/);
});
