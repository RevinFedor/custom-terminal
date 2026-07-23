import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AI_COMPOSER_CHIP_THRESHOLD,
  haveSameComposerChips,
  MAX_AI_COMPOSER_CHIP_THRESHOLD,
  mergeComposerAuthoringSnapshot,
  MIN_AI_COMPOSER_CHIP_THRESHOLD,
  normalizeComposerChipThreshold,
  normalizeComposerChips,
  parsePastedContentParts,
  restoreComposerChipToText,
  serializeComposerDraft,
  shouldCreatePasteChip,
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
