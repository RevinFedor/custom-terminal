import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EditorState } from '@codemirror/state'
import { createComposerHistoryPayloadExtension } from './composerHistory.ts'

const source = fs.readFileSync(new URL('./ComposerEditor.tsx', import.meta.url), 'utf8')
const wrapper = source.match(/derive: \(nextText, previous, transaction\) => \(([\s\S]*?)\),\s*equal:/)
assert.ok(wrapper, 'actual ComposerEditor history wrapper is found')
const actualDerive = callback => new Function('deriveHistoryPayloadRef',
  'return (nextText, previous, transaction) => (' + wrapper[1] + ')')({ current: callback })

test('ComposerEditor forwards the original CodeMirror transaction with exact replaced ranges', () => {
  let observed
  const derive = actualDerive((next, previous, transaction) => {
    observed = { next, previous, transaction }
    return { selected: 'surviving-B' }
  })
  const previous = { selected: 'A-and-B' }
  const aggregate = createComposerHistoryPayloadExtension({ initial: previous, derive })
  const state = EditorState.create({ doc: 'same same', extensions: aggregate.extension })
  const next = state.update({ changes: { from: 0, to: 5, insert: '' }, userEvent: 'delete.selection' })
  assert.ok(observed.transaction, 'range identity must not disappear in the public wrapper')
  assert.equal(observed.transaction.startState, state)
  assert.equal(observed.next, 'same')
  assert.equal(observed.previous, previous)
  const ranges = []
  observed.transaction.changes.iterChangedRanges((from, to) => ranges.push([from, to]))
  assert.deepEqual(ranges, [[0, 5]])
  assert.deepEqual(aggregate.read(next.state), { selected: 'surviving-B' })
})

test('existing two-argument callbacks and absent derivation remain compatible', () => {
  const previous = { value: 1 }
  assert.deepEqual(actualDerive((text, prior) => ({ text, value: prior.value }))('new', previous, {}), { text: 'new', value: 1 })
  assert.equal(actualDerive(undefined)('new', previous, {}), previous)
  assert.equal(actualDerive(() => undefined)('new', previous, {}), previous)
})
