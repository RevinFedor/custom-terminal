import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeFailedHistoryAuthoringSnapshot,
  resolveInterruptedPromptOwnership,
} from './historyDraftOwnership.mjs';

const image = (id, path) => ({
  id,
  path,
  assetId: path.split('/').pop(),
  availability: 'available',
});

test('interrupt ownership never treats an empty terminal draft as cancellation proof', () => {
  assert.equal(resolveInterruptedPromptOwnership({
    durablePromptExists: true,
    returnedDraftExists: false,
  }), 'durable');
  assert.equal(resolveInterruptedPromptOwnership({
    durablePromptExists: false,
    returnedDraftExists: true,
    returnedDraftMatchesHandoff: true,
  }), 'restore');
  assert.equal(resolveInterruptedPromptOwnership({
    durablePromptExists: false,
    returnedDraftExists: true,
    returnedDraftMatchesHandoff: false,
  }), 'unrelated-draft');
  assert.equal(resolveInterruptedPromptOwnership({
    durablePromptExists: false,
    returnedDraftExists: false,
  }), 'pending');
  assert.equal(resolveInterruptedPromptOwnership({
    durablePromptExists: true,
    returnedDraftExists: true,
    returnedDraftMatchesHandoff: true,
  }), 'durable');
});

test('failed snapshot is prepended without overwriting a newer draft and image ids are remapped', () => {
  const result = mergeFailedHistoryAuthoringSnapshot({
    currentText: 'new [Image #1]',
    currentImages: [image(1, '/tmp/new.png')],
    snapshotText: 'old [Image #1]',
    snapshotImages: [image(1, '/tmp/old.png')],
    createChipId: (_chip, index) => `restored-${index}`,
  });

  assert.equal(result.text, 'old [Image #2]\n\nnew [Image #1]');
  assert.deepEqual(result.images.map((ref) => [ref.id, ref.path]), [
    [1, '/tmp/new.png'],
    [2, '/tmp/old.png'],
  ]);
  assert.equal(result.remappedImageCount, 1);
  assert.deepEqual(result.missingImageSourceIds, []);
});

test('failed chips are restored before new chips with fresh ids and no source-key data loss', () => {
  const result = mergeFailedHistoryAuthoringSnapshot({
    currentText: 'new draft',
    currentChips: [
      { id: 'same-id', kind: 'prompt', text: 'new prompt', sourceKey: 'prompt:1' },
      { id: 'new-paste', kind: 'paste', text: 'new paste' },
    ],
    snapshotText: 'old draft',
    snapshotChips: [
      { id: 'same-id', kind: 'prompt', text: 'old prompt', sourceKey: 'prompt:1' },
      { id: 'old-paste', kind: 'paste', text: 'old paste' },
    ],
    createChipId: (_chip, index) => index === 0 ? 'same-id' : `restored-${index}`,
  });

  assert.equal(result.text, 'old draft\n\nnew draft');
  assert.deepEqual(
    result.chips.map(({ id, text, sourceKey }) => ({ id, text, sourceKey })),
    [
      { id: 'same-id-1', text: 'old prompt', sourceKey: undefined },
      { id: 'restored-1', text: 'old paste', sourceKey: undefined },
      { id: 'same-id', text: 'new prompt', sourceKey: 'prompt:1' },
      { id: 'new-paste', text: 'new paste', sourceKey: undefined },
    ],
  );
  assert.equal(result.restoredChipCount, 2);
});

test('raw whitespace is preserved while only the missing draft boundary is inserted', () => {
  const result = mergeFailedHistoryAuthoringSnapshot({
    currentText: '\nnew',
    snapshotText: 'old \n',
  });

  assert.equal(result.text, 'old \n\nnew');
});
