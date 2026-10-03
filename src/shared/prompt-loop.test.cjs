const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_LOOP_PROMPT, LEGACY_DEFAULT_LOOP_PROMPT, migrateLoopPromptContent } = require('./prompt-loop.cjs');

test('old untouched default (including trailing whitespace) gets the blocked instruction', () => {
  assert.equal(migrateLoopPromptContent(JSON.stringify(LEGACY_DEFAULT_LOOP_PROMPT + '\n\n  ')), DEFAULT_LOOP_PROMPT);
  assert.match(DEFAULT_LOOP_PROMPT, /status:"blocked"/);
});
test('custom global text and deliberate empty text survive migration', () => {
  assert.equal(migrateLoopPromptContent(JSON.stringify('my exact policy\n')), 'my exact policy\n');
  assert.equal(migrateLoopPromptContent(JSON.stringify('')), '');
});
test('only without a global text does migration choose the newest legacy per-tab body', () => {
  const queues = { old: { loopPromptText: 'old', loopPromptArmedAt: 1 }, latest: { loopPromptText: 'latest', loopPromptArmedAt: 2 } };
  assert.equal(migrateLoopPromptContent(null, JSON.stringify(queues)), 'latest');
  assert.equal(migrateLoopPromptContent(JSON.stringify('global'), queues), 'global');
  assert.equal(migrateLoopPromptContent(null, 'bad JSON'), DEFAULT_LOOP_PROMPT);
});
