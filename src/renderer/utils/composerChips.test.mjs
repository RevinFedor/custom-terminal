import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AI_COMPOSER_CHIP_THRESHOLD,
  DICTATION_CLIPBOARD_FLAVOR,
  buildHistoryComposerPresentationParts,
  isDictationClipboardPayload,
  haveSameComposerChips,
  buildPasteChipMarker,
  getPasteMarkerHighlightRanges,
  insertComposerSnapshotAtSelection,
  insertComposerTextAtSelection,
  isPlainTextPasteShortcut,
  isTerminalOnlyComposerDraft,
  MAX_AI_COMPOSER_CHIP_THRESHOLD,
  mergeComposerAuthoringSnapshot,
  MIN_AI_COMPOSER_CHIP_THRESHOLD,
  normalizeComposerChipThreshold,
  normalizeComposerChips,
  parsePastedContentParts,
  resolveMarkerAwareWordCaret,
  restoreComposerChipToText,
  retainPasteChipsForText,
  serializeComposerDraft,
  shouldCreatePasteChip,
  splitPromptChipPresentation,
  upsertComposerChip,
} from './composerChips.mjs';

const chip = (id, kind, text, extra = {}) => ({ id, kind, text, ...extra });

test('restored authoring snapshot merges with newer text and preserves same-source prompt intents', () => {
  const result = mergeComposerAuthoringSnapshot({
    currentText: 'new draft',
    currentChips: [
      chip('new-prompt', 'prompt', 'new prompt', { sourceKey: 'prompt:1' }),
      chip('shared', 'paste', 'new paste'),
    ],
    restoredText: 'queued draft',
    restoredChips: [
      chip('old-prompt', 'prompt', 'queued prompt', { sourceKey: 'prompt:1' }),
      chip('shared', 'paste', 'queued paste'),
    ],
    mode: 'append',
    createChipId: (_chip, index) => `restored-${index}`,
  });

  assert.equal(result.text, 'new draft\n\nqueued draft');
  assert.deepEqual(
    result.chips.map(({ id, text, sourceKey }) => ({ id, text, sourceKey })),
    [
      { id: 'new-prompt', text: 'new prompt', sourceKey: 'prompt:1' },
      { id: 'shared', text: 'new paste', sourceKey: undefined },
      { id: 'old-prompt', text: 'queued prompt', sourceKey: undefined },
      { id: 'restored-1', text: 'queued paste', sourceKey: undefined },
    ],
  );
});

test('prepended authoring snapshot preserves whitespace and avoids exact text duplication', () => {
  const prepended = mergeComposerAuthoringSnapshot({
    currentText: '\nnew',
    restoredText: 'old \n',
    mode: 'prepend',
  });
  assert.equal(prepended.text, 'old \n\nnew');

  const same = mergeComposerAuthoringSnapshot({
    currentText: 'same',
    restoredText: 'same',
    mode: 'append',
  });
  assert.equal(same.text, 'same');
});

test('chip threshold defaults to 800 and clamps to the supported range', () => {
  assert.equal(normalizeComposerChipThreshold(undefined), DEFAULT_AI_COMPOSER_CHIP_THRESHOLD);
  assert.equal(normalizeComposerChipThreshold(null), DEFAULT_AI_COMPOSER_CHIP_THRESHOLD);
  assert.equal(normalizeComposerChipThreshold(''), DEFAULT_AI_COMPOSER_CHIP_THRESHOLD);
  assert.equal(normalizeComposerChipThreshold('not-a-number'), DEFAULT_AI_COMPOSER_CHIP_THRESHOLD);
  assert.equal(normalizeComposerChipThreshold(99), MIN_AI_COMPOSER_CHIP_THRESHOLD);
  assert.equal(normalizeComposerChipThreshold(100_001), MAX_AI_COMPOSER_CHIP_THRESHOLD);
  assert.equal(normalizeComposerChipThreshold(812.6), 813);
});

test('manual paste becomes a chip only after the configured threshold', () => {
  assert.equal(shouldCreatePasteChip('x'.repeat(800), 800), false);
  assert.equal(shouldCreatePasteChip('x'.repeat(801), 800), true);
});

test('terminal-only slash detection ignores leading whitespace but not ordinary text', () => {
  assert.equal(isTerminalOnlyComposerDraft('/model'), true);
  assert.equal(isTerminalOnlyComposerDraft(' \n\t /effort high'), true);
  assert.equal(isTerminalOnlyComposerDraft('explain /model'), false);
  assert.equal(isTerminalOnlyComposerDraft('   '), false);
});

test('plain-text paste shortcut accepts only Shift+Cmd+V', () => {
  assert.equal(isPlainTextPasteShortcut({
    code: 'KeyV',
    metaKey: true,
    shiftKey: true,
  }), true);
  assert.equal(isPlainTextPasteShortcut({
    key: 'V',
    metaKey: true,
    shiftKey: true,
  }), true);
  assert.equal(isPlainTextPasteShortcut({
    code: 'KeyV',
    metaKey: true,
    shiftKey: false,
  }), false);
  assert.equal(isPlainTextPasteShortcut({
    code: 'KeyV',
    metaKey: true,
    shiftKey: true,
    altKey: true,
  }), false);
});

test('plain-text paste replaces the exact selection and returns the caret after inserted text', () => {
  assert.deepEqual(insertComposerTextAtSelection({
    text: 'before SELECT after',
    insertedText: 'plain paste',
    selectionStart: 7,
    selectionEnd: 13,
  }), {
    text: 'before plain paste after',
    caret: 18,
    selectionStart: 18,
    selectionEnd: 18,
  });
});

test('serialization puts prompt chips first, paste wrappers second, and editable text last', () => {
  const payload = serializeComposerDraft({
    text: 'cover note',
    chips: [
      chip('paste-1', 'paste', 'raw paste'),
      chip('prompt-1', 'prompt', 'saved prompt', { sourceKey: 'prompt:1' }),
      chip('prompt-2', 'prompt', 'saved variation', { sourceKey: 'prompt:1:variation:2' }),
    ],
  });

  assert.equal(
    payload,
    [
      'saved prompt',
      'saved variation',
      '<pasted_content>\nraw paste\n</pasted_content>',
      'cover note',
    ].join('\n\n'),
  );
});

test('prompt presentation sidecar removes only the exact durable prefix', () => {
  const promptChip = chip('prompt-1', 'prompt', 'saved prompt body', {
    label: 'Review: UI / UX',
  });
  const payload = serializeComposerDraft({
    text: 'user note',
    chips: [promptChip],
  });

  assert.deepEqual(splitPromptChipPresentation({
    text: payload,
    chips: [promptChip],
  }), {
    matched: true,
    text: 'user note',
    chips: [promptChip],
  });
  assert.deepEqual(splitPromptChipPresentation({
    text: 'different bytes',
    chips: [promptChip],
  }), {
    matched: false,
    text: 'different bytes',
    chips: [],
  });
});

test('pasted-content parser preserves the body and leaves ordinary text as text parts', () => {
  const body = '\n  keep leading and trailing  \n';
  const payload = serializeComposerDraft({
    text: 'after',
    chips: [chip('paste-1', 'paste', body)],
  });

  assert.deepEqual(parsePastedContentParts(payload), [
    { kind: 'paste', text: body },
    { kind: 'text', text: '\n\nafter' },
  ]);
  assert.deepEqual(parsePastedContentParts('broken <pasted_content>tail'), [
    { kind: 'text', text: 'broken <pasted_content>tail' },
  ]);
});

test('saved prompt source deduplicates in place while prompt variations remain distinct', () => {
  const initial = [
    chip('prompt-a', 'prompt', 'old body', { label: 'Prompt', sourceKey: 'prompt:7' }),
    chip('paste-a', 'paste', 'same'),
  ];
  const refreshed = upsertComposerChip(
    initial,
    chip('new-id-is-ignored', 'prompt', 'new body', { label: 'Prompt updated', sourceKey: 'prompt:7' }),
  );
  const withVariation = upsertComposerChip(
    refreshed,
    chip('prompt-variation', 'prompt', 'variation', { sourceKey: 'prompt:7:variation:2' }),
  );
  const withRepeatedPaste = upsertComposerChip(
    withVariation,
    chip('paste-b', 'paste', 'same'),
  );

  assert.deepEqual(refreshed[0], {
    id: 'prompt-a',
    kind: 'prompt',
    text: 'new body',
    label: 'Prompt updated',
    sourceKey: 'prompt:7',
  });
  assert.equal(withVariation.filter((item) => item.kind === 'prompt').length, 2);
  assert.equal(withRepeatedPaste.filter((item) => item.kind === 'paste').length, 2);
  assert.equal(normalizeComposerChips(withRepeatedPaste).length, 4);
});

test('chip snapshot comparison detects edits without depending on array identity', () => {
  const snapshot = [
    chip('a', 'prompt', 'alpha', { label: 'A', sourceKey: 'prompt:a' }),
    chip('b', 'paste', 'beta'),
  ];
  assert.equal(haveSameComposerChips(snapshot, snapshot.map((item) => ({ ...item }))), true);
  assert.equal(haveSameComposerChips(snapshot, [
    snapshot[0],
    { ...snapshot[1], text: 'changed while grab was waiting' },
  ]), false);
});

test('restore replaces the saved selection and puts the caret after the chip text', () => {
  assert.deepEqual(
    restoreComposerChipToText({
      text: 'before SELECT after',
      chipText: 'restored',
      selectionStart: 7,
      selectionEnd: 13,
    }),
    {
      text: 'before restored after',
      caret: 15,
      selectionStart: 15,
      selectionEnd: 15,
    },
  );

  assert.deepEqual(
    restoreComposerChipToText({
      text: 'abc',
      chipText: '!',
      selectionStart: 99,
      selectionEnd: 120,
    }),
    {
      text: 'abc!',
      caret: 4,
      selectionStart: 4,
      selectionEnd: 4,
    },
  );
});

test('dictation clipboard payload is recognised by its flavor', () => {
  assert.equal(
    isDictationClipboardPayload({ types: ['text/plain', DICTATION_CLIPBOARD_FLAVOR] }),
    true,
  );
});

test('an ordinary text paste is not treated as dictation', () => {
  assert.equal(isDictationClipboardPayload({ types: ['text/plain'] }), false);
});

test('missing or malformed clipboard data never claims dictation', () => {
  assert.equal(isDictationClipboardPayload(null), false);
  assert.equal(isDictationClipboardPayload(undefined), false);
  assert.equal(isDictationClipboardPayload({}), false);
});

test('DOMStringList-like types without .includes are handled', () => {
  // Some engines expose DataTransfer.types as a DOMStringList, which has
  // length/index access but no Array methods.
  const domStringList = { length: 2, 0: 'text/plain', 1: DICTATION_CLIPBOARD_FLAVOR };
  assert.equal(isDictationClipboardPayload({ types: domStringList }), true);
});

// ── Inline paste anchors ────────────────────────────────────────────────────
// A pasted blob belongs INSIDE the sentence, at the caret it was pasted into,
// not on a strip above the field. The text carries a short marker; the body
// stays in the chip store and is expanded in place on send.

const pasteChip = (id, text) => ({ id, kind: 'paste', text, label: 'Вставка' });

test('paste marker is located by its chip and reports its exact range', () => {
  const chip = pasteChip('paste-1', 'x'.repeat(1692));
  const marker = buildPasteChipMarker(chip);
  const text = 'до ' + marker + ' после';
  const ranges = getPasteMarkerHighlightRanges(text, [chip]);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].id, 'paste-1');
  assert.equal(text.slice(ranges[0].start, ranges[0].end), marker);
});

test('anchored paste expands in place, keeping the text around it', () => {
  const chip = pasteChip('paste-1', 'BLOB');
  const text = 'до ' + buildPasteChipMarker(chip) + ' после';
  const out = serializeComposerDraft({ text, chips: [chip] });
  assert.match(out, /до <pasted_content>\nBLOB\n<\/pasted_content> после/);
});

test('a chip without a marker still ships, as a prefix block', () => {
  // Drafts created before anchors existed, and any path that adds a chip
  // without touching the text, must not silently lose their content.
  const chip = pasteChip('paste-1', 'BLOB');
  const out = serializeComposerDraft({ text: 'просто текст', chips: [chip] });
  assert.match(out, /<pasted_content>\nBLOB\n<\/pasted_content>\n\nпросто текст/);
});

test('deleting the marker drops the chip so its body cannot ride along', () => {
  const chip = pasteChip('paste-1', 'BLOB');
  const withMarker = 'до ' + buildPasteChipMarker(chip) + ' после';
  assert.equal(retainPasteChipsForText(withMarker, [chip]).length, 1);
  assert.equal(retainPasteChipsForText('до после', [chip]).length, 0);
});

test('two equal-length pastes map positionally to distinct chips', () => {
  const a = pasteChip('paste-a', 'AAAA');
  const b = pasteChip('paste-b', 'BBBB');
  const marker = buildPasteChipMarker(a);
  assert.equal(marker, buildPasteChipMarker(b));
  const ranges = getPasteMarkerHighlightRanges(marker + ' и ' + marker, [a, b]);
  assert.deepEqual(ranges.map((r) => r.id), ['paste-a', 'paste-b']);
});

test('snapshot insertion keeps equal-length paste bodies aligned with marker order', () => {
  const a = pasteChip('paste-a', 'AAAA');
  const b = pasteChip('paste-b', 'BBBB');
  const marker = buildPasteChipMarker(a);
  const result = insertComposerSnapshotAtSelection({
    text: marker,
    chips: [a],
    insertedText: marker + ' then ',
    insertedChips: [b],
    selectionStart: 0,
    selectionEnd: 0,
  });

  assert.deepEqual(
    getPasteMarkerHighlightRanges(result.text, result.chips).map((range) => range.id),
    ['paste-b', 'paste-a'],
  );
  assert.equal(
    serializeComposerDraft(result),
    '<pasted_content>\nBBBB\n</pasted_content> then <pasted_content>\nAAAA\n</pasted_content>',
  );
});

test('snapshot replacement drops a paste chip whose marker was replaced', () => {
  const a = pasteChip('paste-a', 'AAAA');
  const b = pasteChip('paste-b', 'BBBB');
  const marker = buildPasteChipMarker(a);
  const result = insertComposerSnapshotAtSelection({
    text: 'before ' + marker + ' after',
    chips: [a],
    insertedText: buildPasteChipMarker(b),
    insertedChips: [b],
    selectionStart: 7,
    selectionEnd: 7 + marker.length,
  });

  assert.deepEqual(result.chips.map((item) => item.id), ['paste-b']);
  assert.match(serializeComposerDraft(result), /before <pasted_content>\nBBBB/);
  assert.doesNotMatch(serializeComposerDraft(result), /AAAA/);
});

test('prompt chips keep their prefix placement alongside an anchored paste', () => {
  const prompt = { id: 'p1', kind: 'prompt', text: 'PROMPT', label: 'P' };
  const paste = pasteChip('paste-1', 'BLOB');
  const text = 'край ' + buildPasteChipMarker(paste);
  const out = serializeComposerDraft({ text, chips: [prompt, paste] });
  assert.ok(out.startsWith('PROMPT\n\n'));
  assert.match(out, /край <pasted_content>\nBLOB\n<\/pasted_content>$/);
});

test('History presentation keeps text, images, and pasted bodies in exact transport order', () => {
  const text = 'до [Image #1] между <pasted_content>\nBLOB\n</pasted_content> после';
  const result = buildHistoryComposerPresentationParts({
    text,
    imagePaths: [{ id: 1, path: '/tmp/one.png', availability: 'available' }],
  });
  assert.deepEqual(result.parts.map((part) => part.kind), [
    'text', 'image', 'text', 'paste', 'text',
  ]);
  assert.equal(result.parts[0].text, 'до ');
  assert.equal(result.parts[1].id, 1);
  assert.equal(result.parts[2].text, ' между ');
  assert.equal(result.parts[3].text, 'BLOB');
  assert.equal(result.parts[4].text, ' после');
});

test('History presentation never treats an image example inside pasted content as an attachment', () => {
  const result = buildHistoryComposerPresentationParts({
    text: '<pasted_content>\nexample [Image #1] and [imagePath: /tmp/one.png]\n</pasted_content>',
    imagePaths: [{ id: 1, path: '/tmp/one.png', availability: 'available' }],
  });
  assert.deepEqual(result.parts, [{
    kind: 'paste',
    text: 'example [Image #1] and [imagePath: /tmp/one.png]',
  }]);
});

test('History presentation renders a portable image path only with a matching audited ref', () => {
  const proven = buildHistoryComposerPresentationParts({
    text: 'a [imagePath: /tmp/one.png] b',
    imagePaths: [{ id: 7, path: '/tmp/one.png', availability: 'available' }],
  });
  assert.deepEqual(proven.parts.map((part) => part.kind), ['text', 'image', 'text']);
  assert.equal(proven.parts[1].id, 7);

  const literal = buildHistoryComposerPresentationParts({
    text: 'docs [imagePath: /tmp/one.png]',
  });
  assert.deepEqual(literal.parts, [{ kind: 'text', text: 'docs [imagePath: /tmp/one.png]' }]);

  const unprovenSlot = buildHistoryComposerPresentationParts({ text: '[Image #1]' });
  assert.deepEqual(unprovenSlot.parts, [{ kind: 'text', text: '[Image #1]' }]);
});

test('History presentation replaces an exact prompt prefix without reordering the remaining text', () => {
  const prompt = chip('prompt-1', 'prompt', 'PROMPT BODY', { label: 'Prompt' });
  const result = buildHistoryComposerPresentationParts({
    text: 'PROMPT BODY\n\nleft <pasted_content>\nPASTE\n</pasted_content> right',
    chips: [prompt],
  });
  assert.deepEqual(result.parts.map((part) => part.kind), ['prompt', 'text', 'text', 'paste', 'text']);
  assert.equal(result.parts[1].text, '\n\n');
  assert.equal(result.parts[2].text, 'left ');
  assert.equal(result.parts[3].text, 'PASTE');
  assert.equal(result.parts[4].text, ' right');
});

// ── Opt+Arrow across an opaque marker ──────────────────────────────────────
// The marker is one object to the user; word-wise motion used to stop between
// its inner words and leave the caret where typing corrupts it.
const markerText = 'АА [Pasted Content 1 500 chars] ББ';
const markerSpan = { start: 3, end: 31 };
const wordCaret = (caret, direction) => resolveMarkerAwareWordCaret({
  text: markerText,
  caret,
  direction,
  ranges: [markerSpan],
});

test('marker-aware caret: forward from the opening bracket clears the whole marker', () => {
  assert.equal(markerText.slice(markerSpan.start, markerSpan.end), '[Pasted Content 1 500 chars]');
  assert.equal(wordCaret(markerSpan.start, 'forward'), markerSpan.end);
});

test('marker-aware caret: forward from inside the marker still exits it in one move', () => {
  // Old behaviour parked the caret right after the "[" — this is that spot.
  assert.equal(wordCaret(markerSpan.start + 1, 'forward'), markerSpan.end);
  assert.equal(wordCaret(markerSpan.end - 1, 'forward'), markerSpan.end);
});

test('marker-aware caret: backward from the closing bracket returns to the opening one', () => {
  assert.equal(wordCaret(markerSpan.end, 'backward'), markerSpan.start);
  assert.equal(wordCaret(markerSpan.end - 2, 'backward'), markerSpan.start);
});

test('marker-aware caret: ordinary text keeps native word-wise behaviour', () => {
  // null = "not our case, let the browser do it".
  assert.equal(wordCaret(0, 'forward'), null);
  assert.equal(wordCaret(markerSpan.end, 'forward'), null);
  assert.equal(wordCaret(markerSpan.start, 'backward'), null);
  assert.equal(wordCaret(markerText.length, 'forward'), null);
});

test('marker-aware caret: no markers means no interference at all', () => {
  assert.equal(resolveMarkerAwareWordCaret({ text: 'обычный текст', caret: 3, direction: 'forward' }), null);
  assert.equal(resolveMarkerAwareWordCaret({
    text: 'обычный текст', caret: 3, direction: 'backward', ranges: [],
  }), null);
});

test('marker-aware caret: image and paste markers obey one rule', () => {
  const mixed = 'до [Image #1] между [Pasted Content 900 chars] после';
  const image = { start: 3, end: 13 };
  const paste = { start: 20, end: 46 };
  assert.equal(mixed.slice(image.start, image.end), '[Image #1]');
  assert.equal(mixed.slice(paste.start, paste.end), '[Pasted Content 900 chars]');
  const move = (caret, direction) => resolveMarkerAwareWordCaret({
    text: mixed, caret, direction, ranges: [paste, image],
  });
  assert.equal(move(image.start, 'forward'), image.end);
  assert.equal(move(paste.start + 4, 'forward'), paste.end);
  assert.equal(move(image.end, 'backward'), image.start);
  assert.equal(move(paste.end, 'backward'), paste.start);
});
