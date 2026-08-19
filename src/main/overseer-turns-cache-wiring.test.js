'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function between(startNeedle, endNeedle) {
  const start = main.indexOf(startNeedle);
  const end = main.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, startNeedle);
  return main.slice(start, end);
}

test('overseer active branch is built in linear time', () => {
  const block = between('function _buildActiveBranch(', 'function _isNoisePrompt(');
  assert.doesNotMatch(block, /\.unshift\(/);
  assert.match(block, /\.push\(/);
  assert.match(block, /\.reverse\(/);
});

test('overseer full-record cache is byte-bounded', () => {
  assert.match(main, /OVERSEER_TURNS_CACHE_MAX_SOURCE_BYTES/);
  assert.match(main, /function _setOverseerTurnsCache\(/);
  assert.match(main, /while \(_overseerTurnsCacheRawBytes > OVERSEER_TURNS_CACHE_MAX_SOURCE_BYTES/);
  assert.equal(
    (main.match(/_overseerTurnsCache\.set\(cacheKey, result\)/g) || []).length,
    1,
    'only the bounded helper may insert a full result',
  );
});
