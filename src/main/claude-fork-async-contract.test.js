'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('every main-process timeline UUID scan is awaited before persistence', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const callLines = source
    .split('\n')
    .filter((line) => line.includes('parseTimelineUuids('));

  assert.equal(callLines.length, 2, 'update the contract test when adding another call site');
  for (const line of callLines) {
    assert.match(line, /\bawait\s+parseTimelineUuids\(/);
  }
});
