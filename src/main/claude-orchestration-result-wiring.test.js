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
  assert.match(grouping, /if \(!carrier\) continue;/);
  assert.ok(
    grouping.indexOf('if (!carrier) continue;') < grouping.indexOf('flush();'),
    'service carriers must be rejected before the current turn is flushed',
  );
});
