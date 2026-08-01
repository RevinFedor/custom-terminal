'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'utils', 'agentScenarios.ts'),
  'utf8',
);

test('every public agent send enters the tab-scoped intent sequencer', () => {
  assert.match(source, /function runAgentPromptScenario\(/);
  assert.match(source, /export function sendAgentPromptScenario[\s\S]*enqueueAgentSendScenario\(\{/);
  assert.match(source, /run:\s*\(\)\s*=>\s*runAgentPromptScenario\(args\)/);
});
