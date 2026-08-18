'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const runtimes = fs.readFileSync(
  path.join(root, 'src/renderer/utils/historyAgentRuntimes.ts'),
  'utf8',
);
const scenarios = fs.readFileSync(
  path.join(root, 'src/renderer/utils/agentScenarios.ts'),
  'utf8',
);

test('Claude startup send waits for a parsed headless composer edge, never a timer success', () => {
  const start = main.indexOf('async function waitForTerminalClaudeDraftState');
  const end = main.indexOf('async function verifyClaudeComposerEmptyAtWriteBoundary', start);
  assert.ok(start >= 0 && end > start);
  const body = main.slice(start, end);
  assert.match(body, /waitForHeadlessSynchronizedOutputClose\(/);
  assert.match(body, /afterWriteSeq: observedWriteSeq/);
  assert.match(body, /claudeDraftProofIsSettled\(result\)/);
  assert.match(body, /timedOut: true[\s\S]{0,120}proofOutcome: 'unknown'/);
  assert.doesNotMatch(body, /timedOut: true[\s\S]{0,120}proofOutcome: '(?:found|absent)'/);
  assert.match(runtimes, /waitOnUnknownOnly: true,[\s\S]{0,80}waitTimeoutMs: 15000/);
});

test('one startup Send waits for the gate and re-reads presence before transport', () => {
  const start = scenarios.indexOf('async function ensureAgentReadyForSend');
  const end = scenarios.indexOf('export async function rewindAgentTimelineScenario', start);
  const body = scenarios.slice(start, end);
  assert.match(body, /presence\?\.status === 'starting'[\s\S]{0,520}await waitStartupDefaultsIfNeeded\(\)/);
  assert.match(body, /await waitStartupDefaultsIfNeeded\(\);[\s\S]{0,140}presence = await runtime\.getPresence/);
  assert.match(body, /if \(presence\?\.status === 'busy'\) return 'busy'/);
  assert.match(body, /if \(isReadyComposer\(\)\) return 'active'/);
});
