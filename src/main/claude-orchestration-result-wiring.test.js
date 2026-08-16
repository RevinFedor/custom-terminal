'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('Claude orchestration turn grouping uses the shared prompt-carrier classifier', () => {
  const start = mainSource.indexOf('function _groupIntoTurns(branch)');
  const end = mainSource.indexOf('\nasync function _loadCodexSessionTurns', start);
  assert.ok(start >= 0 && end > start, 'could not isolate _groupIntoTurns');
  const grouping = mainSource.slice(start, end);

  assert.match(grouping, /const carrier = extractClaudePromptCarrier\(entry\);/);
  assert.match(grouping, /claudeInternalAgentContinuationKindFromEntry\(entry\)/);
  assert.match(grouping, /current\.completionAssistantUuids = \[\];/);
  assert.ok(
    grouping.indexOf('if (!carrier) {') < grouping.indexOf('flush();'),
    'service carriers must be handled before the current turn is flushed',
  );
});

test('Claude result proof materializes the continuation-aware turn projection', () => {
  const start = mainSource.indexOf('async function _getAgentTurnResultForOrchestration');
  const end = mainSource.indexOf('\nasync function handleOverseerRequest', start);
  assert.ok(start >= 0 && end > start, 'could not isolate orchestration result reader');
  const reader = mainSource.slice(start, end);

  assert.match(reader, /materializeClaudeOrchestrationTurn\(/);
  assert.match(reader, /internalContinuationCount: claudeResult\.internalContinuationCount/);
});
