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
const preparation = fs.readFileSync(
  path.join(root, 'src/renderer/utils/agentSendPreparation.ts'),
  'utf8',
);
const providerContract = fs.readFileSync(
  path.join(root, 'src/renderer/utils/agentSendProviderContract.ts'),
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
  assert.match(scenarios, /adapter\.ensureReady\(\{/);
  assert.match(providerContract, /waitForStartupGate:[\s\S]*waitForClaudeStartupDefaultsReadyWithVisibleFallback/);
  assert.match(providerContract, /startupGateOwnsComposer:\s*\(presence\)\s*=>\s*presence\?\.status === 'starting'/);
  assert.match(preparation, /if \(providerContract\.startupGateOwnsComposer\(presence\)\)[\s\S]{0,180}await waitStartupGate\(\)/);
  assert.match(preparation, /await waitStartupGate\(\);[\s\S]{0,180}presence = await runtime\.getPresence/);
  assert.match(preparation, /if \(submitCapability\(\) === 'queue'\) return resolved\('busy', 'queue'\)/);
  assert.match(preparation, /if \(submitCapability\(\) === 'direct'\) return resolved\('active', 'direct'\)/);
});
