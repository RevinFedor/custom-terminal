'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  replaceAgentInputIfUnchangedAtBoundary,
} = require('./agent-input-compare-and-swap');

test('replaces only an exact unchanged input', async () => {
  const restores = [];
  const result = await replaceAgentInputIfUnchangedAtBoundary({
    expectedText: 'before',
    replacementText: 'after',
    capture: async () => ({ success: true, text: 'before', inputRevision: 2 }),
    restore: async (text) => {
      restores.push(text);
      return { success: true, inputRevision: 3 };
    },
    isCurrent: () => true,
  });

  assert.deepEqual(result, { success: true, replaced: true });
  assert.deepEqual(restores, ['after']);
});

test('a newer user draft is preserved without invoking restore', async () => {
  let restored = false;
  const result = await replaceAgentInputIfUnchangedAtBoundary({
    expectedText: 'before',
    replacementText: 'after',
    capture: async () => ({ success: true, text: 'user typed' }),
    restore: async () => {
      restored = true;
      return { success: true };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.replaced, false);
  assert.equal(result.reason, 'input_changed');
  assert.equal(result.actualText, 'user typed');
  assert.equal(restored, false);
});

test('generation loss before restore fails closed', async () => {
  let restored = false;
  const result = await replaceAgentInputIfUnchangedAtBoundary({
    expectedText: 'before',
    replacementText: 'after',
    capture: async () => ({ success: true, text: 'before' }),
    restore: async () => {
      restored = true;
      return { success: true };
    },
    isCurrent: () => false,
  });

  assert.deepEqual(result, {
    success: false,
    replaced: false,
    error: 'terminal_generation_changed',
  });
  assert.equal(restored, false);
});

test('restore failure never reports replacement', async () => {
  const result = await replaceAgentInputIfUnchangedAtBoundary({
    expectedText: 'before',
    replacementText: 'after',
    capture: async () => ({ success: true, text: 'before' }),
    restore: async () => ({ success: false, error: 'external_editor_return_unconfirmed' }),
  });

  assert.deepEqual(result, {
    success: false,
    replaced: false,
    error: 'external_editor_return_unconfirmed',
  });
});
