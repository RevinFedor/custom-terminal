'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = source.indexOf('  const postLineageObservationScope = observationScope();');
const end = source.indexOf('  const durableBinding = candidateSubmitAuditProven', start);
assert.ok(start >= 0 && end > start);
const guard = '(function () {' + source.slice(start, end) + '\nreturn {status:"admitted"};})()';

function inspect({ expectedLaunch = null, currentLaunch, replacedTerminal = false, run = 7, generation = 'terminal:7', exitCurrent = true } = {}) {
  const terminal = {};
  return vm.runInNewContext(guard, {
    tabId: 'T', owned: { sessionId: 'existing-writer' },
    terminalAtAdoption: terminal, runSeqAtAdoption: 7, lifecycleGenerationAtAdoption: 'terminal:7',
    intentGeneration: expectedLaunch,
    observationScope: () => ({ status: 'current' }),
    exitObserverCurrent: () => exitCurrent,
    terminals: new Map([['T', replacedTerminal ? {} : terminal]]),
    terminalCommandState: new Map([['T', { runSeq: run }]]),
    getTerminalLifecycleGeneration: () => generation,
    codexSessionDiscoveryIntents: currentLaunch == null ? new Map() : new Map([['T', { launchId: currentLaunch }]]),
    staleObservationResult: (scope) => scope,
  });
}

test('an already adopted writer with no launch intent remains valid after lineage preparation', () => {
  assert.equal(inspect().status, 'admitted', 'missing optional launchId and normalized null denote the same absent launch');
  assert.equal(inspect({ expectedLaunch: 'launch-1', currentLaunch: 'launch-1' }).status, 'admitted');
});

test('a real owner/launch replacement is still rejected by the final admission boundary', () => {
  for (const change of [
    { currentLaunch: 'new-launch' },
    { expectedLaunch: 'removed-launch' },
    { expectedLaunch: 'old-launch', currentLaunch: 'new-launch' },
    { replacedTerminal: true }, { run: 8 }, { generation: 'terminal:8' }, { exitCurrent: false },
  ]) {
    assert.equal(inspect(change).status, 'stale-lineage-preparation-scope');
  }
});
