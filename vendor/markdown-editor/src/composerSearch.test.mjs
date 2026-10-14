import test from 'node:test'
import assert from 'node:assert/strict'

import { EditorSelection, EditorState } from '@codemirror/state'
import { SearchQuery } from '@codemirror/search'
import { getComposerSearchMatchStats } from './composerSearch.ts'

test('composer search counts matches and identifies the selected result', () => {
  const state = EditorState.create({
    doc: 'one two one',
    selection: EditorSelection.range(8, 11),
  })
  assert.deepEqual(
    getComposerSearchMatchStats(state, new SearchQuery({ search: 'one' })),
    { current: 2, total: 2 },
  )
})

test('composer search reports zero current match for a regular caret', () => {
  const state = EditorState.create({ doc: 'one two one', selection: EditorSelection.cursor(4) })
  assert.deepEqual(
    getComposerSearchMatchStats(state, new SearchQuery({ search: 'one' })),
    { current: 0, total: 2 },
  )
})
