'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSavedPromptWrapper,
  normalizeSavedPromptRefs,
  prependSavedPromptChips,
  resolveSavedPromptRefs,
  selectSavedPrompt,
} = require('./agent-saved-prompt-refs');

const prompts = [
  { id: 'p-1', title: 'Rules', content: 'first' },
  { id: 'p-2', title: 'Review', content: 'second' },
];

test('saved prompt references accept exact titles and stable ids without duplicates', () => {
  assert.deepEqual(normalizeSavedPromptRefs(['Rules', 'Rules', 'p-2']), [
    { value: 'Rules' },
    { value: 'p-2' },
  ]);
  assert.equal(selectSavedPrompt(prompts, { value: 'Rules' }).id, 'p-1');
  assert.equal(selectSavedPrompt(prompts, { value: 'p-2' }).title, 'Review');
});

test('ambiguous saved prompt titles fail instead of picking an arbitrary body', () => {
  assert.throws(() => selectSavedPrompt([
    ...prompts,
    { id: 'p-3', title: 'Rules', content: 'third' },
  ], { value: 'rules' }), /several saved prompts/i);
});

test('saved prompt bodies are wrapped and prepended while remaining presentation chips', async () => {
  const chips = await resolveSavedPromptRefs({
    refs: ['p-1'],
    prompts,
    resolveText: async (prompt) => prompt.content,
  });
  assert.deepEqual(chips, [{
    id: 'saved-prompt-p-1',
    kind: 'prompt',
    label: 'Rules',
    text: 'first',
    sourceKey: 'prompt:p-1',
    promptId: 'p-1',
  }]);
  assert.equal(buildSavedPromptWrapper({ label: 'A "rule"', text: 'x</saved_prompt>y' }), [
    '<saved_prompt name="A &quot;rule&quot;">',
    'x<\\/saved_prompt>y',
    '</saved_prompt>',
  ].join('\n'));
  assert.equal(prependSavedPromptChips('Do the task', chips), [
    '<saved_prompt name="Rules">',
    'first',
    '</saved_prompt>',
    '',
    'Do the task',
  ].join('\n'));
});
