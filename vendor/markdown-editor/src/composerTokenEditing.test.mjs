import test from 'node:test'
import assert from 'node:assert/strict'

import {
  composerPointerStayedWithinClickThreshold,
  composerTokenIntersectsSelection,
  findComposerStatusTokenBackwardDeleteRange,
  resolveComposerStatusTokenRevealCaret,
} from './composerTokenEditing.ts'

const errorToken = {
  kind: 'error',
  from: 7,
  to: 57,
}

test('Option+Backspace target covers the complete imageError marker', () => {
  assert.deepEqual(
    findComposerStatusTokenBackwardDeleteRange([errorToken], 57),
    { from: 7, to: 57 },
  )
})

test('also consumes an error marker when the caret is immediately before its closing bracket', () => {
  assert.deepEqual(
    findComposerStatusTokenBackwardDeleteRange([errorToken], 56),
    { from: 7, to: 57 },
  )
  assert.equal(findComposerStatusTokenBackwardDeleteRange([errorToken], 55), null)
  assert.equal(findComposerStatusTokenBackwardDeleteRange([errorToken], 58), null)
})

test('does not override word deletion for atomic image and paste chips', () => {
  assert.equal(findComposerStatusTokenBackwardDeleteRange([
    { kind: 'image', from: 0, to: 10 },
    { kind: 'paste', from: 10, to: 35 },
  ], 35), null)
})

test('pending image status uses the same whole-token deletion boundary', () => {
  assert.deepEqual(
    findComposerStatusTokenBackwardDeleteRange([
      { kind: 'pending', from: 3, to: 18 },
    ], 18),
    { from: 3, to: 18 },
  )
})

test('status-token click reveals near the side the user clicked', () => {
  const bounds = { left: 100, width: 80 }
  assert.equal(resolveComposerStatusTokenRevealCaret(errorToken, 115, bounds), 8)
  assert.equal(resolveComposerStatusTokenRevealCaret(errorToken, 185, bounds), 56)
})

test('non-status token and missing pointer geometry retain the left editing position', () => {
  const bounds = { left: 100, width: 80 }
  assert.equal(resolveComposerStatusTokenRevealCaret(
    { kind: 'image', from: 7, to: 57 },
    185,
    bounds,
  ), 8)
  assert.equal(resolveComposerStatusTokenRevealCaret(errorToken, 0, { left: 0, width: 0 }), 8)
})

test('status-token mouse handoff distinguishes a click from drag-selection', () => {
  const start = { x: 100, y: 50 }
  assert.equal(composerPointerStayedWithinClickThreshold(start, { x: 103, y: 52 }), true)
  assert.equal(composerPointerStayedWithinClickThreshold(start, { x: 105, y: 50 }), false)
  assert.equal(composerPointerStayedWithinClickThreshold(start, { x: Number.NaN, y: 50 }), false)
})

test('atomic chip gets selected styling when a range crosses any part of it', () => {
  const token = { from: 10, to: 30 }
  assert.equal(composerTokenIntersectsSelection(token, { from: 0, to: 10 }), false)
  assert.equal(composerTokenIntersectsSelection(token, { from: 0, to: 11 }), true)
  assert.equal(composerTokenIntersectsSelection(token, { from: 15, to: 16 }), true)
  assert.equal(composerTokenIntersectsSelection(token, { from: 30, to: 35 }), false)
})

test('empty caret never paints an atomic chip as selected', () => {
  assert.equal(
    composerTokenIntersectsSelection({ from: 10, to: 30 }, { from: 20, to: 20 }),
    false,
  )
})
