import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adoptForeignImagePathMarkers,
  buildPortableImageClipboardOutput,
  buildPortableImageClipboardText,
} from './foreignImagePath.ts'

test('adopts one absolute image path', () => {
  assert.deepEqual(
    adoptForeignImagePathMarkers('[imagePath: /Users/test/image.png]'),
    { text: '![image](/Users/test/image.png)', adopted: 1 },
  )
})

test('keeps surrounding text around an adopted image', () => {
  assert.deepEqual(
    adoptForeignImagePathMarkers('before [imagePath: /tmp/a.png] after'),
    { text: 'before ![image](/tmp/a.png) after', adopted: 1 },
  )
})

test('adopts multiple adjacent image paths', () => {
  assert.deepEqual(
    adoptForeignImagePathMarkers('[imagePath: /tmp/a.png][imagePath: /tmp/b.png]'),
    { text: '![image](/tmp/a.png)![image](/tmp/b.png)', adopted: 2 },
  )
})

test('does not adopt a relative path', () => {
  assert.deepEqual(
    adoptForeignImagePathMarkers('[imagePath: images/a.png]'),
    { text: '[imagePath: images/a.png]', adopted: 0 },
  )
})

test('leaves ordinary text unchanged', () => {
  assert.deepEqual(
    adoptForeignImagePathMarkers('ordinary text'),
    { text: 'ordinary text', adopted: 0 },
  )
})

test('exports one absolute GT image as a text-only portable marker', () => {
  assert.deepEqual(
    buildPortableImageClipboardText('![image](/Users/test/image.png)'),
    {
      text: '[imagePath: /Users/test/image.png]',
      converted: 1,
      partial: 0,
      handled: true,
    },
  )
})

test('keeps surrounding text and exports adjacent images in one payload', () => {
  assert.deepEqual(
    buildPortableImageClipboardText('before ![a](/tmp/a.png)![b](/tmp/b.png) after').text,
    'before [imagePath: /tmp/a.png][imagePath: /tmp/b.png] after',
  )
})

test('exports width and expanded image syntax using only its absolute path', () => {
  assert.deepEqual(
    buildPortableImageClipboardText('x ![preview|240|+](/tmp/a b.png) y').text,
    'x [imagePath: /tmp/a b.png] y',
  )
})

test('leaves a relative GT image as ordinary markdown', () => {
  assert.deepEqual(
    buildPortableImageClipboardText('![image](images/a.png)'),
    {
      text: '![image](images/a.png)',
      converted: 0,
      partial: 0,
      handled: false,
    },
  )
})

test('fails closed when selection cuts through an absolute GT image', () => {
  const source = 'before ![image](/tmp/a.png) after'
  const imageStart = source.indexOf('![image]')
  assert.deepEqual(
    buildPortableImageClipboardText(source, imageStart + 3, source.length).text,
    '[imageError] after',
  )
})

test('native explicit selection exports a complete image with surrounding text', () => {
  const source = 'before ![image](/tmp/a.png) after'
  assert.deepEqual(
    buildPortableImageClipboardOutput(
      source,
      source,
      [{ from: 0, to: source.length }],
    ),
    {
      text: 'before [imagePath: /tmp/a.png] after',
      converted: 1,
      partial: 0,
      handled: true,
    },
  )
})

test('native line-wise copy without a selection exports the image path', () => {
  const copiedLine = '![image](/tmp/a.png)'
  assert.equal(
    buildPortableImageClipboardOutput(
      copiedLine,
      copiedLine,
      [{ from: 0, to: 0 }],
    ).text,
    '[imagePath: /tmp/a.png]',
  )
})

test('native partial selection fails closed using the full source document', () => {
  const source = 'before ![image](/tmp/a.png) after'
  const markerFrom = source.indexOf('![image]')
  const from = markerFrom + 3
  assert.deepEqual(
    buildPortableImageClipboardOutput(
      source,
      source.slice(from),
      [{ from, to: source.length }],
    ),
    {
      text: '[imageError] after',
      converted: 0,
      partial: 1,
      handled: true,
    },
  )
})

test('native multi-selection keeps order and rewrites every selected image', () => {
  const source = 'A ![image](/tmp/a.png) B ![image](/tmp/b.png) C'
  const firstTo = source.indexOf(' B')
  const secondFrom = source.indexOf('![image]', firstTo)
  const copiedText = `${source.slice(0, firstTo)}\n${source.slice(secondFrom)}`
  assert.equal(
    buildPortableImageClipboardOutput(
      source,
      copiedText,
      [
        { from: 0, to: firstTo },
        { from: secondFrom, to: source.length },
      ],
    ).text,
    'A [imagePath: /tmp/a.png]\n[imagePath: /tmp/b.png] C',
  )
})
