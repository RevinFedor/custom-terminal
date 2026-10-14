import test from 'node:test'
import assert from 'node:assert/strict'

import { readComposerNaturalHeight } from './composerGeometry.ts'

test('measures the document independently from a stale tall scroll viewport', () => {
  const view = {
    contentHeight: 34,
    scrollDOM: {
      clientHeight: 313,
      scrollHeight: 313,
    },
  }

  assert.equal(readComposerNaturalHeight(view), 34)
})
