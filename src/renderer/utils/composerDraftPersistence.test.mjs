import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSER_DRAFT_STATE_LIMIT,
  buildComposerDraftMemory,
  readComposerDraftMemory,
  splitComposerDraftMemory,
} from './composerDraftPersistence.mjs';

test('composer draft persistence round-trips text, image refs, and hidden chip bodies together', () => {
  const memory = buildComposerDraftMemory({
    drafts: { a: 'before [Image #1] [Pasted Content 5 chars] after' },
    images: { a: [{ id: 1, path: '/tmp/image.png', availability: 'available', assetId: 'asset.png' }] },
    chips: { a: [{ id: 'paste-1', kind: 'paste', text: 'hello', label: 'Paste' }] },
    updatedAtByTab: { a: 42 },
  });
  assert.deepEqual(splitComposerDraftMemory(memory), {
    drafts: { a: 'before [Image #1] [Pasted Content 5 chars] after' },
    images: { a: [{ id: 1, path: '/tmp/image.png', assetId: 'asset.png', availability: 'available' }] },
    chips: { a: [{ id: 'paste-1', kind: 'paste', text: 'hello', label: 'Paste' }] },
    updatedAtByTab: { a: 42 },
  });
});

test('composer draft persistence rejects corrupt sidecars instead of reviving broken markers', () => {
  assert.deepEqual(readComposerDraftMemory({
    good: { text: 'safe', images: [{ id: 0, path: '' }], chips: [{ id: '', kind: 'paste', text: 'x' }] },
    empty: { text: '', images: [], chips: [] },
    bad: null,
  }), {
    good: { text: 'safe', images: [], chips: [], updatedAt: 0 },
  });
});

test('composer draft persistence caps old tab records but always keeps the newest draft', () => {
  const source = {};
  for (let index = 0; index < COMPOSER_DRAFT_STATE_LIMIT + 3; index += 1) {
    source[`tab-${index}`] = {
      text: `draft-${index}`,
      images: [],
      chips: [],
      updatedAt: index + 1,
    };
  }
  const memory = readComposerDraftMemory(source);
  assert.equal(Object.keys(memory).length, COMPOSER_DRAFT_STATE_LIMIT);
  assert.equal(memory['tab-0'], undefined);
  assert.equal(memory[`tab-${COMPOSER_DRAFT_STATE_LIMIT + 2}`].text, `draft-${COMPOSER_DRAFT_STATE_LIMIT + 2}`);
});
