import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { Annotation, EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { history, isolateHistory, redo, undo } from '@codemirror/commands'
import { createComposerHistoryPayloadExtension } from './composerHistory.ts'

const source = fs.readFileSync(new URL('./ComposerEditor.tsx', import.meta.url), 'utf8')
const syntax = ts.createSourceFile('ComposerEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let method
const visit = node => {
  if (ts.isMethodDeclaration(node) && node.name.getText(syntax) === 'applySnapshot') method = node
  ts.forEachChild(node, visit)
}
visit(syntax)
assert.ok(method, 'actual public applySnapshot method')
const compiled = ts.transpileModule('globalThis.apply = ({' + method.getText(syntax) + '}).applySnapshot', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const pending = '[Image saving…]'
const ready = '[Image #1]'

function harness(doc = pending) {
  const aggregate = createComposerHistoryPayloadExtension({ initial: { pending: true },
    derive: (next, previous) => next.includes(pending) ? previous : { pending: false },
    equal: (a, b) => a.pending === b.pending })
  let state = EditorState.create({ doc, extensions: [history(), aggregate.extension] })
  const view = { get state() { return state }, dispatch(value) {
    state = value instanceof Transaction ? value.state : state.update(value).state
  } }
  const context = vm.createContext({ viewRef: { current: view }, historyExtensionRef: { current: aggregate },
    EditorSelection, Transaction, isolateHistory, externalValueSync: Annotation.define() })
  vm.runInContext(compiled, context)
  return { get state() { return state }, aggregate, apply: context.apply,
    change(changes) { view.dispatch({ changes, annotations: isolateHistory.of('full'), userEvent: 'input' }) },
    replay(command) { return command({ state, dispatch(transaction) {
      const reconciliation = aggregate.reconciliationFor(transaction)
      view.dispatch(transaction)
      if (reconciliation) view.dispatch(reconciliation)
    } }) },
  }
}

test('public exact-range completion preserves Undo and Redo of unrelated suffix typing', () => {
  const h = harness()
  h.change({ from: pending.length, insert: ' suffix' })
  h.apply({ value: ready + ' suffix', replacement: { from: 0, to: pending.length, insert: ready },
    history: 'replace', historyPayload: { pending: false } })
  assert.equal(h.replay(undo), true)
  assert.equal(h.state.doc.toString(), ready)
  assert.equal(h.replay(redo), true)
  assert.equal(h.state.doc.toString(), ready + ' suffix')
})

for (const replacement of [
  { from: 0, to: pending.length, insert: ready },
  { from: -1, to: 3, insert: ready },
  { from: 4, to: 1, insert: ready },
  { from: 0, to: 1000, insert: ready },
]) {
  test('public stale or inconsistent exact range cannot overwrite current author text: ' + JSON.stringify(replacement), () => {
    const h = harness('new unrelated author text')
    assert.equal(h.apply({ value: ready, replacement, history: 'replace', historyPayload: { pending: false } }), false)
    assert.equal(h.state.doc.toString(), 'new unrelated author text')
    assert.deepEqual(h.aggregate.read(h.state), { pending: true })
    assert.equal(h.replay(undo), false)
  })
}

test('legacy callers without exact range retain whole-snapshot behavior', () => {
  const h = harness()
  h.apply({ value: 'legacy replacement', historyPayload: { pending: false } })
  assert.equal(h.state.doc.toString(), 'legacy replacement')
  assert.equal(h.replay(undo), true)
  assert.equal(h.state.doc.toString(), pending)
})

test('native metadata-changing deletion remains redoable after restored pending result resolves', () => {
  const h = harness()
  h.change({ from: 0, to: pending.length, insert: '' })
  assert.equal(h.replay(undo), true)
  h.apply({ value: ready, replacement: { from: 0, to: pending.length, insert: ready },
    history: 'replace', historyPayload: { pending: false } })
  assert.equal(h.replay(redo), true)
  assert.equal(h.state.doc.toString(), '')
  assert.deepEqual(h.aggregate.read(h.state), { pending: false })
})

test('ordinary suffix typing does not capture full aggregate snapshots', () => {
  const h = harness()
  h.change({ from: pending.length, insert: ' suffix' })
  let transaction
  undo({ state: h.state, dispatch: value => { transaction = value } })
  assert.equal(transaction.effects.some(effect => effect.is(h.aggregate.restoreSnapshot)), false)
})
