'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('all main-process queue admission boundaries share the source predicate', () => {
  const uses = mainSource.match(/isPromptQueueAutomationSource\(source\)/g) || [];
  assert.equal(uses.length, 3, 'safe paste, Claude send and Codex send must classify the same sources');
  assert.doesNotMatch(
    mainSource,
    /source\.includes\(['"]prompt-queue['"]\)/,
    'raw label checks let Prompt Loop bypass the Run After contract',
  );
});
