import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildComposerClipboardText,
  buildPortableImageImportSnapshot,
  collapsePortableImageImportSnapshot,
  collectPortableImagePathMarkers,
} from './composerClipboard.mjs';
import { buildPasteChipMarker } from './composerChips.mjs';

const imageRef = (id, path = `/tmp/image-${id}.png`, extra = {}) => ({
  id,
  path,
  availability: 'available',
  ...extra,
});
const pasteChip = (id, text) => ({ id, kind: 'paste', text });

test('copy expands one paste marker to its exact body', () => {
  const chip = pasteChip('paste-1', 'large body\nsecond line');
  const marker = buildPasteChipMarker(chip);
  assert.deepEqual(
    buildComposerClipboardText({
      text: marker,
      selectionStart: 0,
      selectionEnd: marker.length,
      chips: [chip],
    }),
    {
      text: chip.text,
      handled: true,
      imageResolved: 0,
      imageMissing: 0,
      imagePartial: 0,
      pasteExpanded: 1,
      pasteMissing: 0,
    },
  );
});

test('copy keeps surrounding text and expands image plus paste in source order', () => {
  const chip = pasteChip('paste-1', 'PASTE [Image #99] BODY');
  const marker = buildPasteChipMarker(chip);
  const text = `before [Image #1] middle ${marker} after`;
  const result = buildComposerClipboardText({
    text,
    selectionStart: 0,
    selectionEnd: text.length,
    chips: [chip],
    imagePaths: [imageRef(1, '/tmp/proven.png')],
  });
  assert.equal(
    result.text,
    'before [imagePath: /tmp/proven.png] middle PASTE [Image #99] BODY after',
  );
  assert.equal(result.imageResolved, 1);
  assert.equal(result.pasteExpanded, 1);
});

test('equal-length paste markers expand positionally to distinct bodies', () => {
  const first = pasteChip('first', 'AAAA');
  const second = pasteChip('second', 'BBBB');
  const marker = buildPasteChipMarker(first);
  const text = `${marker}|${marker}`;
  assert.equal(
    buildComposerClipboardText({
      text,
      selectionStart: 0,
      selectionEnd: text.length,
      chips: [first, second],
    }).text,
    'AAAA|BBBB',
  );
});

test('copying only the second equal-length paste keeps its durable identity', () => {
  const first = pasteChip('first', 'AAAA');
  const second = pasteChip('second', 'BBBB');
  const marker = buildPasteChipMarker(first);
  const text = `${marker}|${marker}`;
  const start = marker.length + 1;
  assert.equal(
    buildComposerClipboardText({
      text,
      selectionStart: start,
      selectionEnd: text.length,
      chips: [first, second],
    }).text,
    'BBBB',
  );
});

test('partial image marker fails closed while partial paste marker stays literal', () => {
  const chip = pasteChip('paste-1', 'body');
  const marker = buildPasteChipMarker(chip);
  const imageText = 'x [Image #1] y';
  assert.equal(
    buildComposerClipboardText({
      text: imageText,
      selectionStart: 4,
      selectionEnd: imageText.length,
      imagePaths: [imageRef(1)],
    }).text,
    '[imageError] y',
  );
  assert.deepEqual(
    buildComposerClipboardText({
      text: marker,
      selectionStart: 1,
      selectionEnd: marker.length - 1,
      chips: [chip],
    }),
    {
      text: marker.slice(1, -1),
      handled: false,
      imageResolved: 0,
      imageMissing: 0,
      imagePartial: 0,
      pasteExpanded: 0,
      pasteMissing: 0,
    },
  );
});

test('a whole image marker without a proven file becomes an explicit error', () => {
  const marker = '[Image #4]';
  const result = buildComposerClipboardText({
    text: marker,
    selectionStart: 0,
    selectionEnd: marker.length,
  });
  assert.equal(result.text, '[imageError]');
  assert.equal(result.imageMissing, 1);
});

test('portable marker parser accepts only absolute paths', () => {
  const text = '[imagePath: /tmp/a.png] [imagePath: images/b.png] [imagePath: /tmp/c.png]';
  assert.deepEqual(
    collectPortableImagePathMarkers(text).map(({ id, path }) => ({ id, path })),
    [
      { id: 1, path: '/tmp/a.png' },
      { id: 2, path: '/tmp/c.png' },
    ],
  );
});

test('portable import preserves text, multiple images, and visible missing errors', () => {
  const source = 'before [imagePath: /tmp/a.png] middle [imagePath: /tmp/missing.png] after';
  const snapshot = buildPortableImageImportSnapshot(source, [
    imageRef(1, '/assets/a.png', { assetId: 'a.png' }),
    imageRef(2, '/tmp/missing.png', { availability: 'missing' }),
  ]);
  assert.equal(
    snapshot.text,
    'before [Image #1] middle [imageError: portable_image_path_unavailable #2 path=/tmp/missing.png] after',
  );
  assert.deepEqual(snapshot.imagePaths.map(({ id, path }) => ({ id, path })), [
    { id: 1, path: '/assets/a.png' },
  ]);
  assert.equal(snapshot.imported, 1);
  assert.equal(snapshot.missing, 1);
});

test('large portable import keeps images outside opaque paste chips', () => {
  const longBefore = 'a'.repeat(101);
  const longAfter = 'b'.repeat(102);
  const result = collapsePortableImageImportSnapshot({
    text: `${longBefore}[Image #1] short [Image #2]${longAfter}`,
    imagePaths: [imageRef(1), imageRef(2)],
    threshold: 100,
    createChipId: (_text, index) => `paste-${index}`,
    createdAt: 10,
  });
  assert.equal(
    result.text,
    '[Pasted Content 101 chars][Image #1] short [Image #2][Pasted Content 102 chars]',
  );
  assert.deepEqual(result.chips.map(({ id, text }) => ({ id, text })), [
    { id: 'paste-0', text: longBefore },
    { id: 'paste-1', text: longAfter },
  ]);
  assert.equal(result.imagePaths.length, 2);
});
