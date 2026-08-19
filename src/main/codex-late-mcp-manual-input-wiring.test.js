'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function between(start, end) {
  const from = main.indexOf(start);
  const to = main.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source range ${start} → ${end}`);
  return main.slice(from, to);
}

test('manual terminal input cancels late MCP proof before revision and reaches normal PTY flow', () => {
  const input = between('async function handleTerminalInput(', '// Anti-arrow-mash guard.');
  assert.match(input, /classifyLateMcpProofInput/);
  assert.match(input, /clearCodexLateMcpProofPending\([\s\S]*settlementAction: 'manual-input'/);
  assert.doesNotMatch(input, /BLOCKED during late MCP frame proof/);
  assert.ok(
    input.indexOf('clearCodexLateMcpProofPending(')
      < input.indexOf('bumpTerminalInputRevision(tabId)'),
    'proof must yield before the manual byte claims a new input generation',
  );
  assert.match(input, /xtermInputOrigin === 'terminal-response'/);
});

test('late MCP committed-frame proof settles every waiter and exact /model recovery is bounded', () => {
  const proof = between(
    'function createCodexLateMcpProofSettlement()',
    'function clearCodexTuiReady(',
  );
  assert.match(proof, /waitForCodexLateMcpProofSettlement/);
  assert.match(proof, /settlementAction: 'ready'/);
  assert.match(proof, /settlementAction: 'blocked'/);
  assert.match(proof, /replaced-by-new-candidate/);

  const slash = between(
    'async function sendCodexSlashCommand(',
    'function parseCodexServiceTierFeedback(',
  );
  assert.match(slash, /await waitForCodexLateMcpProofSettlement\(tabId\)/);
  assert.match(slash, /inspectCodexOwnedSlashDraft/);
  assert.match(slash, /slash-command-enter-retry/);
  assert.match(slash, /rollbackCodexOwnedSlashDraft/);
  assert.match(slash, /slashInserted: true/);
});
