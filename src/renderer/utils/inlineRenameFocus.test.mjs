import assert from 'node:assert/strict';
import test from 'node:test';
import { focusAndSelectInlineName } from './inlineRenameFocus.mjs';

test('inline name activation focuses and selects the whole value', () => {
  let focused = 0;
  let selected = 0;
  const input = { focus: () => { focused += 1; }, select: () => { selected += 1; } };
  assert.equal(focusAndSelectInlineName(input), true);
  assert.equal(focused, 1);
  assert.equal(selected, 1);
  assert.equal(focusAndSelectInlineName(null), false);
});
