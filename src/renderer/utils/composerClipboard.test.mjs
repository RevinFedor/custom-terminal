import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildComposerClipboardText,
  buildHistoryMessageClipboardPayload,
  insertHistoryClipboardSnapshotAtSelection,
  normalizeHistoryMessageComposerSnapshot,
  buildPortableImageImportSnapshot,
  collapsePortableImageImportSnapshot,
  collectPortableImagePathMarkers,
} from './composerClipboard.mjs';
import { buildPasteChipMarker, restoreComposerDraftFromHistoryPresentation, serializeComposerDraft } from './composerChips.mjs';

const imageRef = (id, path = `/tmp/image-${id}.png`, extra = {}) => ({
  id,
  path,
  availability: 'available',
  ...extra,
});
const pasteChip = (id, text) => ({ id, kind: 'paste', text });
const promptChip = (id, extra = {}) => ({ id, kind: 'prompt', label: 'Prompt', text: 'body', ...extra });
const copySnapshot = (chips, text = 'message') => normalizeHistoryMessageComposerSnapshot(JSON.parse(JSON.stringify(
  buildHistoryMessageClipboardPayload({ text: serializeComposerDraft({ text, chips }), chips }).snapshot,
)));

test('History Copy recovers sidecar identities past deferred wrappers without borrowing equal-body metadata', () => {
  const attached = promptChip('attached', { sourceKey: 'prompt:1' });
  const deferred = promptChip('deferred', { contextUpdateId: 'update-1' });
  const copied = buildHistoryMessageClipboardPayload({
    text: serializeComposerDraft({ text: 'message', chips: [deferred, attached] }), chips: [attached],
  });
  assert.equal(copied.snapshot.chips[0].contextUpdateId, 'update-1');
  assert.equal(copied.snapshot.chips[0].sourceKey, undefined);
  assert.deepEqual(copied.snapshot.chips[1], attached);
  assert.equal(copied.snapshot.text, 'message');
});

for (const sidecars of [true, false]) {
  test(`Copy replay into Rewind authoring keeps the same chips once (sidecars=${sidecars})`, () => {
    const prompts = [promptChip('library', { sourceKey: 'prompt:1', inheritanceDepth: 1, inheritanceParentLabel: 'Base' }),
      promptChip('update', { contextUpdateId: 'update-1' }),
      promptChip('file', { attachmentKind: 'file', filePath: '/synthetic/file.md', role: 'source', sha256: 'a'.repeat(64), bytes: 4 })];
    const input = { text: serializeComposerDraft({ text: 'message', chips: prompts }), chips: sidecars ? prompts : [] };
    const restored = restoreComposerDraftFromHistoryPresentation(input);
    const copied = buildHistoryMessageClipboardPayload(input).snapshot;
    const result = insertHistoryClipboardSnapshotAtSelection({ ...restored,
      insertedText: copied.text, insertedChips: copied.chips, selectionStart: 0, selectionEnd: restored.text.length });
    assert.equal(result.text, 'message');
    assert.deepEqual(result.chips, restored.chips);
  });
}

test('replay preserves unrelated equal-body prompts, variations and new chips', () => {
  const current = [promptChip('one'), promptChip('library', { sourceKey: 'prompt:1' })];
  const incoming = [current[0], promptChip('two'), promptChip('variation', { sourceKey: 'prompt:1:variation:2' })];
  const copied = copySnapshot(incoming, '  text\n\n');
  const result = insertHistoryClipboardSnapshotAtSelection({ text: 'before REPLACE after', chips: current,
    insertedText: copied.text, insertedChips: copied.chips, selectionStart: 7, selectionEnd: 14 });
  assert.equal(result.text, 'before   text\n\n after');
  assert.deepEqual(result.chips.map(chip => chip.id), ['one', 'library', 'two', 'variation']);
});

for (const [name, extra, changed] of [
  ['body', { sourceKey: 'prompt:1' }, { text: 'changed' }],
  ['title', { sourceKey: 'prompt:1' }, { label: 'Renamed' }],
  ['inheritance', { sourceKey: 'prompt:1' }, { inheritanceDepth: 1, inheritanceParentLabel: 'Base' }],
  ['file hash', { attachmentKind: 'file', filePath: '/synthetic/a.md', sha256: 'a'.repeat(64) }, { sha256: 'b'.repeat(64) }],
  ['context', { contextUpdateId: 'update-1' }, { text: 'new version' }],
  ['anonymous ID', {}, { text: 'new version' }],
]) {
  test(`replay retains both ${name} revisions and repeat paste is idempotent for chips`, () => {
    const old = promptChip('same-id', extra), current = { ...old, ...changed };
    const snapshot = copySnapshot([old]);
    const options = { insertedText: snapshot.text, insertedChips: snapshot.chips, createChipId: () => 'remapped' };
    const first = insertHistoryClipboardSnapshotAtSelection({ chips: [current], ...options });
    assert.equal(first.chips.length, 2);
    assert.deepEqual(first.chips[0], current);
    assert.equal(serializeComposerDraft({ chips: [first.chips[1]] }), serializeComposerDraft({ chips: [old] }));
    const repeated = insertHistoryClipboardSnapshotAtSelection({ ...first, ...options });
    assert.deepEqual(repeated.chips, first.chips);
    assert.equal(repeated.text, 'messagemessage', 'only chips deduplicate, never explicit text insertion');
  });
}

test('pending context replay requires exact identity and version, never title alone or sending/dismissed ownership', () => {
  const chip = promptChip('copied', { contextUpdateId: 'member-1' });
  const pending = { id: 'group-1', memberIds: ['member-1'], status: 'pending', title: chip.label, text: chip.text };
  for (const [update, dismissed, count] of [
    [pending, [], 0],
    [{ ...pending, text: 'new version' }, [], 1],
    [{ ...pending, title: 'new title' }, [], 1],
    [{ ...pending, memberIds: ['other'] }, [], 1],
    [{ ...pending, status: 'sending' }, [], 1],
    [pending, ['member-1'], 1],
    [{ ...pending, memberIds: ['member-1', 'member-2'] }, ['member-1'], 0],
  ]) {
    const result = insertHistoryClipboardSnapshotAtSelection({ insertedText: 'message', insertedChips: [chip],
      pendingContextUpdates: [update], dismissedContextUpdateIds: dismissed });
    assert.equal(result.chips.length, count);
    assert.equal(result.text, 'message');
  }
});

test('successful-message Copy into empty composer restores all chips; ordinary repeated paste bodies remain repeatable', () => {
  const prompt = promptChip('prompt'), paste = pasteChip('paste', 'body');
  const snapshot = copySnapshot([prompt, paste], 'before ' + buildPasteChipMarker(paste) + ' after');
  const first = insertHistoryClipboardSnapshotAtSelection({ insertedText: snapshot.text, insertedChips: snapshot.chips });
  assert.equal(serializeComposerDraft(first), serializeComposerDraft({ text: snapshot.text, chips: snapshot.chips }));
  const repeated = insertHistoryClipboardSnapshotAtSelection({ ...first, insertedText: snapshot.text, insertedChips: snapshot.chips });
  assert.equal(repeated.chips.filter(chip => chip.kind === 'prompt').length, 1);
  assert.equal(repeated.chips.filter(chip => chip.kind === 'paste').length, 2);
  assert.equal((serializeComposerDraft(repeated).match(/<pasted_content>/g) || []).length, 2);
});

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
