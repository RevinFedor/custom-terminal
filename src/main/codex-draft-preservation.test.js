'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const preservation = require('./codex-draft-preservation');

const prefix = 'A'.repeat(80);
const original = {
  success: true,
  editorReturnReady: true,
  terminalIdentityStable: true,
  captureOperationId: 'CAPTURE-1',
  text: prefix + '\nKEEP EXACT TAIL [Image #1]\n',
  capturedText: prefix + '\nKEEP EXACT TAIL [Image #1]\n',
  images: 1,
  imagePaths: [{ id: 1, assetId: 'sha256-original', path: '/durable/image.png', availability: 'available' }],
  inputRevision: 11,
};
const snapshot = preservation.exactCodexDraftSnapshot(original);

test('full original text and attachments are required, not the first 80 characters', () => {
  const changes = [
    { text: prefix, capturedText: prefix, images: 0, imagePaths: [] },
    { capturedText: original.capturedText.replace('EXACT TAIL', 'WRONG TAIL') },
    { capturedText: original.capturedText.slice(0, -1) },
    { images: 0, imagePaths: [] },
    { imagePaths: [{ ...original.imagePaths[0], assetId: 'sha256-different' }] },
    { imagePaths: [{ ...original.imagePaths[0], availability: 'missing' }] },
    { editorReturnReady: false },
    { terminalIdentityStable: false },
  ];
  for (const change of changes) {
    assert.equal(preservation.compareCodexDraftSnapshots(snapshot, { ...original, ...change }).matched, false, JSON.stringify(change));
  }
  assert.equal(preservation.compareCodexDraftSnapshots(snapshot, original).matched, true);
});

test('native image proof preserves slot identity and does not confuse replaced same-count attachments', () => {
  assert.equal(preservation.compareCodexDraftSnapshots(snapshot, {
    ...original, imagePaths: [{ ...original.imagePaths[0], id: 2 }],
  }).matched, false);
  assert.equal(preservation.exactCodexDraftSnapshot({ ...original, imagePaths: [] }), null);
  const transfer = preservation.codexNativeDraftTransfer('T', snapshot);
  assert.equal(transfer.id, 'codex-native-stash:CAPTURE-1');
  assert.equal(transfer.text, original.text);
  assert.deepEqual(transfer.imagePaths, original.imagePaths);
  transfer.imagePaths[0].path = 'changed consumer copy';
  assert.equal(snapshot.imagePaths[0].path, '/durable/image.png');
});

test('Ctrl+G rebase authorizes only its own exact one-revision transition', () => {
  assert.equal(preservation.codexExactCaptureOwnedRevision(original, 10, 11), 11);
  assert.equal(preservation.codexExactCaptureOwnedRevision(original, 10, 12), null);
  assert.equal(preservation.codexExactCaptureOwnedRevision(original, 9, 11), null);
  assert.equal(preservation.codexExactCaptureOwnedRevision({ ...original, success: false }, 10, 11), null);
});

function actualFunctions(extra = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('async function stashCodexDraftForPicker(');
  const end = source.indexOf('\nfunction latestCodexSynchronizedFrameText(', start);
  const writes = [];
  const functions = vm.runInNewContext(source.slice(start, end)
    + '\n({ stashCodexDraftForPicker, restoreCodexDraftAfterPicker })', {
    ...preservation,
    console: { log() {}, warn() {} },
    readCodexPickerWriteRefusal: () => null,
    sendCodexKeyAndCapture: async (_term, key) => {
      writes.push(key);
      return { clean: '', timedOut: false };
    },
    ...extra,
  });
  return { ...functions, writes };
}

test('actual native Up restoration rejects truncated text and returns the full preserved snapshot', async () => {
  const h = actualFunctions();
  const result = await h.restoreCodexDraftAfterPicker({}, {
    tabId: 'T', logPrefix: '[test]', slashSubmitted: true, expectedSnapshot: snapshot,
    captureDraftSnapshot: async () => ({ ...original, text: prefix, capturedText: prefix, images: 0, imagePaths: [] }),
  });
  assert.equal(result.success, false);
  assert.equal(result.draftTransfer.text, original.text);
  assert.deepEqual(Array.from(h.writes), ['\x1b[A', '\x1b[A']);
  assert.equal(result.draftTransfer.imagePaths[0].assetId, original.imagePaths[0].assetId);
});

test('exact snapshot is acquired before native Ctrl+C and refused capture never clears input', async () => {
  const h = actualFunctions();
  const result = await h.stashCodexDraftForPicker({}, {
    tabId: 'T', logPrefix: '[test]', draftPreview: prefix,
    captureDraftSnapshot: async () => {
      assert.equal(h.writes.length, 0);
      return original;
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.draftSnapshot.capturedText, original.capturedText);
  assert.deepEqual(h.writes, ['\x03']);

  const failed = actualFunctions();
  assert.equal((await failed.stashCodexDraftForPicker({}, {
    tabId: 'T', logPrefix: '[test]', captureDraftSnapshot: async () => ({ success: false }),
  })).success, false);
  assert.equal(failed.writes.length, 0);

  const empty = actualFunctions();
  assert.equal((await empty.stashCodexDraftForPicker({}, {
    tabId: 'T', logPrefix: '[test]', captureDraftSnapshot: async () => ({
      ...original, text: '', capturedText: '', images: 0, imagePaths: [],
    }),
  })).stashed, false);
  assert.equal(empty.writes.length, 0, 'stale visual positive must not recall unrelated native history');
});
