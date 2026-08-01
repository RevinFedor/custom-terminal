const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`\nasync function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test('the orchestration chip detach action never interrupts the target agent', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const actionSource = functionSource(source, 'performOrchestrationAction', 'handleOrchestrationTabClosed');

  assert.match(actionSource, /action === 'detach'/);
  assert.match(actionSource, /isTerminalStatus\(current\.status\) && !isResultProofPending\(current\)/);
  assert.match(actionSource, /reason: 'detached-by-user'/);
  assert.match(actionSource, /outcome: 'detached'/);
  assert.doesNotMatch(actionSource, /runAgentInterruptScenario/);
});

test('holding manual recovery only removes its countdown', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const actionSource = functionSource(source, 'performOrchestrationAction', 'handleOrchestrationTabClosed');

  assert.match(actionSource, /action === 'wait'/);
  assert.match(actionSource, /resolveRecovery\(runId, 'wait'\)/);
  assert.doesNotMatch(actionSource, /action === 'wait'[\s\S]{0,500}runAgentInterruptScenario/);
});
