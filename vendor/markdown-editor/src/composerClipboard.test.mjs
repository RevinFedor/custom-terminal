import test from 'node:test'
import assert from 'node:assert/strict'

import {
  readSynchronousComposerClipboardPayload,
  shouldDeferComposerPasteToNative,
} from './composerClipboard.ts'

test('reads synchronous Electron text together with custom clipboard flavors', () => {
  const payload = readSynchronousComposerClipboardPayload({
    readText: () => 'dictated body',
    writeText: () => {},
    readFormats: () => ['text/plain', 'application/x-voice-record-dictation'],
  })

  assert.deepEqual(payload, {
    text: 'dictated body',
    formats: ['text/plain', 'application/x-voice-record-dictation'],
  })
  assert.equal(shouldDeferComposerPasteToNative(payload), false)
})

test('leaves bitmap-bearing payloads on the native image paste path', () => {
  const payload = readSynchronousComposerClipboardPayload({
    readText: () => 'alternate representation',
    writeText: () => {},
    readFormats: () => ['text/plain', 'image/png'],
  })

  assert.equal(shouldDeferComposerPasteToNative(payload), true)
})

test('leaves empty or asynchronous clipboard reads on the native path', () => {
  assert.equal(shouldDeferComposerPasteToNative(
    readSynchronousComposerClipboardPayload({
      readText: () => '',
      writeText: () => {},
    }),
  ), true)
  assert.equal(readSynchronousComposerClipboardPayload({
    readText: async () => 'browser text',
    writeText: () => {},
  }), null)
})
