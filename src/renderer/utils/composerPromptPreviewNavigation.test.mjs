import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveComposerPromptPreviewNavigation,
  resolveOrderedPreviewNavigation,
} from './composerPromptPreviewNavigation.mjs';

const prompt = (id, extra = {}) => ({
  id,
  kind: 'prompt',
  text: `body:${id}`,
  ...extra,
});

test('saved-prompt preview navigation follows the supplied left-to-right order', () => {
  const result = resolveComposerPromptPreviewNavigation([
    prompt('left'),
    { id: 'paste', kind: 'paste', text: 'opaque paste' },
    prompt('middle'),
    { id: 'image', kind: 'image', imagePreview: {} },
    prompt('right'),
  ], 'middle');

  assert.deepEqual(result, {
    currentId: 'middle',
    currentIndex: 1,
    count: 3,
    previousId: 'left',
    nextId: 'right',
  });
});

test('navigation disables the missing direction at the two ends', () => {
  const chips = [prompt('left'), prompt('right')];
  assert.equal(resolveComposerPromptPreviewNavigation(chips, 'left')?.previousId, null);
  assert.equal(resolveComposerPromptPreviewNavigation(chips, 'left')?.nextId, 'right');
  assert.equal(resolveComposerPromptPreviewNavigation(chips, 'right')?.previousId, 'left');
  assert.equal(resolveComposerPromptPreviewNavigation(chips, 'right')?.nextId, null);
});

test('non-expandable, disabled and duplicate prompt targets are skipped', () => {
  const result = resolveComposerPromptPreviewNavigation([
    prompt('left'),
    prompt('hidden', { expandable: false }),
    prompt('disabled', { disabled: true }),
    prompt('left'),
    prompt('right', { text: undefined, expandedPreview: 'rich body' }),
  ], 'right');

  assert.equal(result?.count, 2);
  assert.equal(result?.previousId, 'left');
});

test('one prompt or a non-prompt open preview has no prompt navigation', () => {
  assert.equal(resolveComposerPromptPreviewNavigation([prompt('only')], 'only'), null);
  assert.equal(resolveComposerPromptPreviewNavigation([
    prompt('left'),
    prompt('right'),
    { id: 'paste', kind: 'paste', text: 'opaque paste' },
  ], 'paste'), null);
});

test('an external prompt-like context update keeps its exact place in the shared band', () => {
  assert.deepEqual(resolveOrderedPreviewNavigation([
    'context:update-a',
    'prompt:left',
    'prompt:right',
  ], 'prompt:left'), {
    currentId: 'prompt:left',
    currentIndex: 1,
    count: 3,
    previousId: 'context:update-a',
    nextId: 'prompt:right',
  });
});
