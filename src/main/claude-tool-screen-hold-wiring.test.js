'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const hookSource = fs.readFileSync(
  path.resolve(__dirname, '../../scripts/claude-hooks/noted-turn-event.js'),
  'utf8',
);

test('Claude hook identity holds tool-owned screen until exact JSONL result', () => {
  assert.match(hookSource, /tool_use_id: payload\.tool_use_id/);
  assert.match(hookSource, /tool_response: boundedHookValue\(payload\.tool_response\)/);
  assert.match(mainSource, /claudeToolScreenHolds\.start\(\{/);
  assert.match(mainSource, /claudeToolScreenHolds\.complete\(\{/);
  assert.match(mainSource, /reason: 'claude-hook-tool-screen-owned'/);
  assert.match(mainSource, /claudeToolScreenHolds\.release\(\{ tabId: detail\.tabId, toolUseIds \}\)/);
});

test('Claude structured patch participates in the exact tool-result proof', () => {
  assert.match(
    mainSource,
    /collectTerminalHistoryStructuredProofStrings\(message\?\.toolUseResult, result\)/,
  );
});
