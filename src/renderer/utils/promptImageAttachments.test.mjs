import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImageAwareClipboardText,
  buildPromptImagePayload,
  getPromptImageErrorTokenLabel,
  getPromptImageStatusTokenRanges,
  getPromptImageMarkerHighlightRanges as markerRanges,
  getPromptImageAttachmentState,
  getPromptImageMarkerHighlightRanges,
  hasMalformedPromptImageMarker,
  haveSamePromptImageRefs,
  inspectPromptImageAttachments,
  insertPromptImageAttachments,
  normalizePromptImageIdentity,
  remapPromptImageSelectionAfterReplacement,
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
  assert.equal(result.text[result.caret - 2], ']');
  assert.equal(result.text[result.caret - 1], ' ');

  const pendingEnd = 'before [Image saving…]'.length;
  assert.deepEqual(
    remapPromptImageSelectionAfterReplacement({
      selectionStart: pendingEnd,
      selectionEnd: pendingEnd,
      replacedStart: 'before '.length,
      replacedEnd: pendingEnd,
      insertionCaret: result.caret,
    }),
    { start: result.caret, end: result.caret },
  );
});

test('image marker replacement preserves selections around the async marker', () => {
  assert.deepEqual(
    remapPromptImageSelectionAfterReplacement({
      selectionStart: 12,
      selectionEnd: 15,
      replacedStart: 6,
      replacedEnd: 12,
      insertionCaret: 10,
    }),
    { start: 10, end: 13 },
  );
  assert.deepEqual(
    remapPromptImageSelectionAfterReplacement({
      selectionStart: 8,
      selectionEnd: 8,
      replacedStart: 6,
      replacedEnd: 12,
      insertionCaret: 10,
    }),
    { start: 10, end: 10 },
  );
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

test('attachment inspection separates unavailable bytes from ambiguous identity', () => {
  const unavailable = inspectPromptImageAttachments(
    'before [Image #2] after',
    [{ ...ref(2, '/missing/two.png'), availability: 'missing', error: 'image_path_missing' }],
  );
  assert.equal(unavailable.blocking, false);
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.firstUnavailable.id, 2);
  assert.equal(unavailable.firstUnavailable.path, '/missing/two.png');
  assert.match(unavailable.firstUnavailable.excerpt, /before \[Image #2\] after/);

  const unbound = inspectPromptImageAttachments('before [Image #3] after', [ref(2)]);
  assert.equal(unbound.blocking, true);
  assert.equal(unbound.firstBlocking.kind, 'unbound');
  assert.equal(unbound.firstBlocking.id, 3);

  const malformed = inspectPromptImageAttachments('before [Image #2 after', [ref(2)]);
  assert.equal(malformed.blocking, true);
  assert.equal(malformed.firstBlocking.kind, 'malformed');
});

test('explicit imageError is transferable warning text and paste markers stay unrelated', () => {
  const explicit = inspectPromptImageAttachments(
    'start [imageError: history_image_path_unavailable #4 path=/tmp/missing image.png] end',
    [],
  );
  assert.equal(explicit.blocking, false);
  assert.equal(explicit.unavailable, true);
  assert.equal(explicit.firstUnavailable.kind, 'error-marker');
  assert.equal(explicit.firstUnavailable.id, 4);
  assert.equal(explicit.firstUnavailable.path, '/tmp/missing image.png');
  assert.equal(getPromptImageErrorTokenLabel(explicit.firstUnavailable.marker), 'imageError #4');

  const short = inspectPromptImageAttachments('[imageError]', []);
  assert.equal(short.blocking, false);
  assert.equal(short.unavailable, true);

  const pasteOnly = inspectPromptImageAttachments('[Pasted Content 123 chars]', []);
  assert.deepEqual(pasteOnly.issues, []);
  assert.equal(pasteOnly.blocking, false);
  assert.equal(pasteOnly.unavailable, false);
});

test('imageError keeps its full serialized value but renders as a compact atomic token', () => {
  const marker = '[imageError: portable_image_path_unavailable #2 path=/tmp/missing image.png]';
  const text = `before ${marker} after`;
  const ranges = getPromptImageStatusTokenRanges(text);

  assert.equal(ranges.length, 1);
  assert.equal(text.slice(ranges[0].start, ranges[0].end), marker);
  assert.equal(ranges[0].label, 'imageError #2');
  assert.equal(ranges[0].kind, 'error');
  assert.equal(ranges[0].replace, true);
});

test('transient image statuses remain visible source instead of pretending to be attachments', () => {
  const text = 'a [Image saving…] b [imagePath: /tmp/example.png] c';
  const ranges = getPromptImageStatusTokenRanges(text);

  assert.deepEqual(ranges.map(({ kind, label, replace }) => ({ kind, label, replace })), [
    { kind: 'pending', label: '[Image saving…]', replace: false },
    { kind: 'error', label: '[imagePath: /tmp/example.png]', replace: false },
  ]);
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

// ── Clipboard safety around image markers ──────────────────────────────────
// A selection that cuts through `[Image #N]` must not travel as plain prose:
// the fragment references nothing and can collide with another ref at the
// paste target.

test('a selection of whole markers copies verbatim', () => {
  const text = 'до [Image #1] после';
  const res = buildImageAwareClipboardText(text, 0, text.length);
  assert.equal(res.partial, 0);
  assert.equal(res.whole, 1);
  assert.equal(res.text, text);
});

test('a cut marker is replaced by an explicit error marker', () => {
  const text = 'до [Image #1] после';
  // Stop inside the marker, right after "[Image #".
  const res = buildImageAwareClipboardText(text, 0, text.indexOf('#') + 1);
  assert.equal(res.partial, 1);
  assert.equal(res.text, 'до [imageError]');
});

test('a selection starting inside a marker also reports damage', () => {
  const text = 'до [Image #1] после';
  const res = buildImageAwareClipboardText(text, text.indexOf('#'), text.length);
  assert.equal(res.partial, 1);
  assert.match(res.text, /^\[imageError\] после$/);
});

test('text without markers is returned untouched', () => {
  const res = buildImageAwareClipboardText('обычный текст', 0, 7);
  assert.deepEqual(res, { text: 'обычный', partial: 0, whole: 0 });
});

test('an empty selection produces nothing to copy', () => {
  assert.deepEqual(buildImageAwareClipboardText('до [Image #1]', 4, 4), { text: '', partial: 0, whole: 0 });
});

test('whole and cut markers in one selection are counted separately', () => {
  const text = '[Image #1] и [Image #2] хвост';
  const res = buildImageAwareClipboardText(text, 0, text.indexOf('#2') + 1);
  assert.equal(res.whole, 1);
  assert.equal(res.partial, 1);
  assert.match(res.text, /^\[Image #1\] и \[imageError\]$/);
});

// ── Paste anchor must not be mistaken for a damaged image marker ───────────
// Regression 2026-07-30: the inline `[Pasted Content N chars]` anchor was
// introduced into the draft text and the composer immediately began showing
// "Image needs attention" next to a perfectly attached image. Both marker
// families now coexist in one string, so every image check must ignore the
// paste anchor.

const PASTE_ANCHOR = '[Pasted Content 3 438 chars]';
const MIXED = PASTE_ANCHOR + ' авыава [Image #1]';
const READY_REF = [{ id: 1, path: '/tmp/a.png', availability: 'available' }];

test('a paste anchor beside a valid image is not a damaged marker', () => {
  assert.equal(hasMalformedPromptImageMarker(MIXED, READY_REF), false);
  assert.equal(
    getPromptImageAttachmentState({ text: MIXED, images: 1, imagePaths: READY_REF }),
    'ready',
  );
});

test('a paste anchor does not get painted as an image marker', () => {
  const ranges = markerRanges(MIXED, READY_REF);
  assert.equal(ranges.length, 1);
  assert.equal(MIXED.slice(ranges[0].start, ranges[0].end), '[Image #1]');
});

test('blue highlight requires a real file, never the marker alone', () => {
  assert.deepEqual(markerRanges('авыава [Image #1]', []), []);
  assert.deepEqual(
    markerRanges('авыава [Image #1]', [{ id: 1, path: '/tmp/x.png', availability: 'missing' }]),
    [],
  );
});

test('copying a paste anchor alone reports no image damage', () => {
  const res = buildImageAwareClipboardText(MIXED, 0, PASTE_ANCHOR.length);
  assert.equal(res.partial, 0);
  assert.equal(res.whole, 0);
  assert.equal(res.text, PASTE_ANCHOR);
});
