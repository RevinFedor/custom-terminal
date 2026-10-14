import test from 'node:test'
import assert from 'node:assert/strict'

import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { history, isolateHistory, redo, undo } from '@codemirror/commands'
import { createComposerHistoryPayloadExtension } from './composerHistory.ts'

const payloadEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right)

const createHarness = ({ doc, payload, derive, textMode }) => {
  const aggregate = createComposerHistoryPayloadExtension({
    initial: payload,
    derive,
    equal: payloadEqual,
    textMode,
  })
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.length),
    extensions: [history(), aggregate.extension],
  })
  let lastTransaction = null
  let lastHistoryTransaction = null
  const dispatch = (transaction) => {
    lastTransaction = transaction
    state = transaction.state
  }
  const dispatchHistory = (transaction) => {
    lastHistoryTransaction = transaction
    dispatch(transaction)
    const reconciliation = aggregate.reconciliationFor(transaction)
    if (reconciliation) {
      dispatch(state.update(reconciliation))
    }
  }
  return {
    aggregate,
    get state() { return state },
    get lastTransaction() { return lastTransaction },
    get lastHistoryTransaction() { return lastHistoryTransaction },
    dispatch,
    dispatchHistory,
    apply(spec) { state = state.update(spec).state },
  }
}

test('mapped history preserves streamed text added after an explicit insertion', () => {
  const h = createHarness({ doc: 'Hello', payload: [], derive: (_text, previous) => previous, textMode: 'mapped' })
  h.apply({ changes: { from: 5, insert: ' tab-12' }, effects: [h.aggregate.snapshotBoundary.of(true), h.aggregate.setPayload.of([])] })
  h.apply({ changes: { from: 12, insert: ' more speech' }, annotations: Transaction.addToHistory.of(false) })
  assert.equal(undo({ state: h.state, dispatch: h.dispatchHistory }), true)
  assert.equal(h.state.doc.toString(), 'Hello more speech')
  assert.equal(redo({ state: h.state, dispatch: h.dispatchHistory }), true)
  assert.equal(h.state.doc.toString(), 'Hello tab-12 more speech')
})

test('delete, undo, and redo restore text and attachment sidecars atomically', () => {
  const original = 'before [Image #1] [Pasted Content 5 chars] after'
  const image = { id: 1, path: '/tmp/image.png' }
  const chip = { id: 'paste-1', kind: 'paste', text: 'hello' }
  const harness = createHarness({
    doc: original,
    payload: { images: [image], chips: [chip] },
    derive: (nextText, previous) => ({
      images: nextText.includes('[Image #1]') ? previous.images : [],
      chips: nextText.includes('[Pasted Content 5 chars]') ? previous.chips : [],
    }),
  })

  harness.apply({
    changes: { from: 0, to: original.length, insert: '' },
    selection: EditorSelection.cursor(0),
    userEvent: 'delete.selection',
  })
  assert.equal(harness.state.doc.toString(), '')
  assert.deepEqual(harness.aggregate.read(harness.state), { images: [], chips: [] })

  assert.equal(undo({ state: harness.state, dispatch: harness.dispatchHistory }), true)
  assert.equal(harness.state.doc.toString(), original)
  assert.deepEqual(harness.aggregate.read(harness.state), { images: [image], chips: [chip] })
  assert.equal(harness.state.selection.main.from, original.length)
  assert.equal(harness.state.selection.main.to, original.length)

  assert.equal(redo({ state: harness.state, dispatch: harness.dispatchHistory }), true)
  assert.equal(harness.state.doc.toString(), '')
  assert.deepEqual(harness.aggregate.read(harness.state), { images: [], chips: [] })
})

test('async image resolution stays one paste action and redo restores final metadata', () => {
  const pending = '[Image saving…]'
  const ready = '[Image #1]'
  const finalPayload = {
    images: [{ id: 1, path: '/tmp/final.png', availability: 'available' }],
    chips: [],
  }
  const harness = createHarness({
    doc: '',
    payload: { images: [], chips: [] },
    derive: (_nextText, previous) => previous,
  })

  harness.apply({
    changes: { from: 0, insert: pending },
    selection: EditorSelection.cursor(pending.length),
    effects: [
      harness.aggregate.setPayload.of({ images: [], chips: [] }),
      harness.aggregate.snapshotBoundary.of(true),
    ],
    annotations: isolateHistory.of('full'),
    userEvent: 'input.paste',
  })
  harness.apply({
    changes: { from: 0, to: pending.length, insert: ready },
    selection: EditorSelection.cursor(ready.length),
    effects: harness.aggregate.setPayload.of(finalPayload),
    annotations: Transaction.addToHistory.of(false),
  })
  assert.equal(harness.state.doc.toString(), ready)
  assert.deepEqual(harness.aggregate.read(harness.state), finalPayload)

  assert.equal(undo({ state: harness.state, dispatch: harness.dispatchHistory }), true)
  assert.equal(
    harness.lastHistoryTransaction.effects.some((effect) => (
      effect.is(harness.aggregate.restoreSnapshot)
    )),
    true,
  )
  assert.equal(harness.state.doc.toString(), '')
  assert.deepEqual(harness.aggregate.read(harness.state), { images: [], chips: [] })

  assert.equal(redo({ state: harness.state, dispatch: harness.dispatchHistory }), true)
  assert.equal(harness.state.doc.toString(), ready)
  assert.deepEqual(harness.aggregate.read(harness.state), finalPayload)
})

test('effect-only prompt chip insertion participates in the same undo stack', () => {
  const empty = { images: [], chips: [] }
  const withPrompt = {
    images: [],
    chips: [{ id: 'prompt-1', kind: 'prompt', text: 'instructions' }],
  }
  const harness = createHarness({
    doc: 'draft',
    payload: empty,
    derive: (_nextText, previous) => previous,
  })

  harness.apply({
    effects: [
      harness.aggregate.setPayload.of(withPrompt),
      harness.aggregate.snapshotBoundary.of(true),
    ],
    annotations: isolateHistory.of('full'),
    userEvent: 'input',
  })
  assert.deepEqual(harness.aggregate.read(harness.state), withPrompt)

  assert.equal(undo({ state: harness.state, dispatch: harness.dispatchHistory }), true)
  assert.equal(harness.state.doc.toString(), 'draft')
  assert.deepEqual(harness.aggregate.read(harness.state), empty)

  assert.equal(redo({ state: harness.state, dispatch: harness.dispatchHistory }), true)
  assert.deepEqual(harness.aggregate.read(harness.state), withPrompt)
})
