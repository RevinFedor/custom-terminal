import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPromptImagePayload,
  getPromptImageAttachmentState,
  getPromptImageMarkerHighlightRanges,
  hasMalformedPromptImageMarker,
  haveSamePromptImageRefs,
  insertPromptImageAttachments,
  normalizePromptImageIdentity,
  retainPromptImageRefsForText,
} from './promptImageAttachments.mjs';

const ref = (id, path = `/tmp/image-${id}.png`) => ({
  id,
  path,
  assetId: `asset-${id}.png`,
  mediaType: 'image/png',
  size: id * 100,
  availability: 'available',
});

test('insertion remaps attachment ids without colliding with the current draft', () => {
  const result = insertPromptImageAttachments({
    text: 'before [Image #1] after',
    imagePaths: [ref(1)],
    start: 7,
    end: 7,
    insertedText: 'new [Image #1] ',
    insertedImagePaths: [ref(1, '/tmp/new.png')],
  });

  assert.equal(result.text, 'before new [Image #2] [Image #1] after');
  assert.deepEqual(result.imagePaths.map((item) => [item.id, item.path]), [
    [1, '/tmp/image-1.png'],
    [2, '/tmp/new.png'],
  ]);
  assert.equal(result.caret, 'before new [Image #2] '.length);
});

test('clipboard marker leaves one trailing space and places caret after it', () => {
  const result = insertPromptImageAttachments({
    text: 'before [Image saving…]after',
    start: 'before '.length,
    end: 'before [Image saving…]'.length,
    insertedText: '[Image #0] ',
    insertedImagePaths: [ref(0)],
  });

  assert.equal(result.text, 'before [Image #1] after');
  assert.equal(result.caret, 'before [Image #1] '.length);
});

test('removing a complete marker releases only its ref, damaged markers retain refs for repair', () => {
  const refs = [ref(1), ref(2)];
  assert.deepEqual(
    retainPromptImageRefsForText('keep [Image #2]', refs).map((item) => item.id),
    [2],
  );
  assert.equal(hasMalformedPromptImageMarker('keep [Image #2', refs), true);
  assert.deepEqual(
    retainPromptImageRefsForText('keep [Image #2', refs).map((item) => item.id),
    [1, 2],
  );
});

test('valid markers highlight and build ordered transport paths', () => {
  const refs = [ref(1), ref(2)];
  const text = 'first [Image #2], then [Image #1]';
  assert.deepEqual(
    getPromptImageMarkerHighlightRanges(text, refs).map((range) => range.id),
    [2, 1],
  );
  assert.equal(
    buildPromptImagePayload(text, refs),
    'first [imagePath: /tmp/image-2.png], then [imagePath: /tmp/image-1.png]',
  );
  assert.equal(getPromptImageAttachmentState({ text, images: 2, imagePaths: refs }), 'ready');
});

test('unknown or unavailable attachment blocks instead of silently degrading', () => {
  assert.equal(
    getPromptImageAttachmentState({
      text: '[Image #2]',
      images: 1,
      imagePaths: [ref(1)],
    }),
    'missing',
  );
  assert.equal(
    buildPromptImagePayload('[Image #2]', [ref(1)]),
    '[imageError: queued_image_path_unavailable #2]',
  );
});

test('image identity treats authoring marker and transport path as one slot', () => {
  assert.equal(
    normalizePromptImageIdentity('look [Image #7] now'),
    normalizePromptImageIdentity('look [imagePath: /tmp/a b.png] now'),
  );
});

test('draft snapshot detects attachment replacement without caring about ref order', () => {
  assert.equal(haveSamePromptImageRefs([ref(2), ref(1)], [ref(1), ref(2)]), true);
  assert.equal(
    haveSamePromptImageRefs([ref(1)], [ref(1, '/tmp/replaced.png')]),
    false,
  );
});
