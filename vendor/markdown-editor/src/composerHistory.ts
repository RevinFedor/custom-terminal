import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type StateEffectType,
  type TransactionSpec,
} from '@codemirror/state'
import { invertedEffects } from '@codemirror/commands'

export interface ComposerHistoryPayloadConfig<T> {
  initial: T
  derive: (nextText: string, previous: T, transaction: Transaction) => T
  equal?: (left: T, right: T) => boolean
  /** Live documents keep newer external text when an author undoes an edit. */
  textMode?: 'snapshot' | 'mapped'
}

export interface ComposerHistoryPayloadExtension<T> {
  extension: Extension
  field: StateField<T>
  setPayload: StateEffectType<T>
  snapshotBoundary: StateEffectType<true>
  restoreSnapshot: StateEffectType<ComposerAggregateSnapshot<T>>
  read(state: EditorState): T
  reconciliationFor(transaction: Transaction): TransactionSpec | null
}

interface ComposerAggregateSnapshot<T> {
  text: string
  payload: T
  anchor: number
  head: number
}

/**
 * Put host-owned composer metadata in the same undo event as CodeMirror text.
 *
 * Image refs and Pasted Content bodies deliberately stay outside the document,
 * but deleting their visible anchors is still one authoring action. CodeMirror
 * exposes `invertedEffects` precisely for this: every text transaction derives
 * its next sidecar, while history records the previous sidecar beside the text
 * inverse. Undo/redo therefore never exposes a marker with the wrong metadata.
 */
export function createComposerHistoryPayloadExtension<T>(
  config: ComposerHistoryPayloadConfig<T>,
): ComposerHistoryPayloadExtension<T> {
  const equal = config.equal || Object.is
  const setPayload = StateEffect.define<T>()
  // Explicit host actions (image/paste insertion, cut, chip restore) need a
  // full snapshot boundary. A later addToHistory=false async resolution can
  // map CodeMirror's text inverse away, while this non-positional effect stays
  // intact and remains able to restore the exact aggregate.
  const snapshotBoundary = StateEffect.define<true>()
  const restoreSnapshot = StateEffect.define<ComposerAggregateSnapshot<T>>()
  const field = StateField.define<T>({
    create: () => config.initial,
    update(previous, transaction) {
      let next = previous
      for (const effect of transaction.effects) {
        if (effect.is(setPayload)) next = effect.value
      }
      return next
    },
  })

  const derivePayload = EditorState.transactionExtender.of((transaction) => {
    if (!transaction.docChanged) return null
    // Explicit snapshot transactions and history replay already carry their
    // exact payload. Deriving again could discard newly imported refs.
    if (transaction.effects.some((effect) => effect.is(setPayload))) return null
    const previous = transaction.startState.field(field)
    const next = config.derive(transaction.newDoc.toString(), previous, transaction)
    return equal(previous, next) ? null : { effects: setPayload.of(next) }
  })

  const invertPayload = invertedEffects.of((transaction) => {
    const snapshotTransaction = transaction.effects.some((effect) => (
      effect.is(snapshotBoundary) || effect.is(restoreSnapshot)
    )) || (transaction.docChanged && transaction.effects.some((effect) => effect.is(setPayload)))
    // Native deletion of an attachment also owns an aggregate snapshot. A
    // later async result can remap its text inverse away after Undo restored
    // the pending attachment. Ordinary typing with unchanged metadata stays
    // on CodeMirror's compact text history; do not snapshot every keystroke.
    if (snapshotTransaction && config.textMode !== 'mapped') {
      const selection = transaction.startState.selection.main
      return [restoreSnapshot.of({
        text: transaction.startState.doc.toString(),
        payload: transaction.startState.field(field),
        anchor: selection.anchor,
        head: selection.head,
      })]
    }
    if (!transaction.effects.some((effect) => effect.is(setPayload))) return []
    return [setPayload.of(transaction.startState.field(field))]
  })

  const reconciliationFor = (transaction: Transaction): TransactionSpec | null => {
    let snapshot: ComposerAggregateSnapshot<T> | null = null
    for (const effect of transaction.effects) {
      if (effect.is(restoreSnapshot)) snapshot = effect.value
    }
    if (!snapshot) return null
    return {
      changes: {
        from: 0,
        to: transaction.newDoc.length,
        insert: snapshot.text,
      },
      selection: EditorSelection.single(snapshot.anchor, snapshot.head),
      effects: setPayload.of(snapshot.payload),
      annotations: Transaction.addToHistory.of(false),
      userEvent: 'composer.history.reconcile',
    }
  }

  return {
    extension: [field, derivePayload, invertPayload],
    field,
    setPayload,
    snapshotBoundary,
    restoreSnapshot,
    read: (state) => state.field(field),
    reconciliationFor,
  }
}
