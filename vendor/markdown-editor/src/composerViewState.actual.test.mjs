import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { Annotation, EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { history, undoDepth } from '@codemirror/commands'

// Actual handle implementation and real CM state; measurement scheduling and
// scroll geometry are controlled ports, not a DOM/focus/E2E claim.
const source = fs.readFileSync(process.env.COMPOSER_VIEW_TEST_SOURCE
  || new URL('./ComposerEditor.tsx', import.meta.url), 'utf8')
const syntax = ts.createSourceFile('ComposerEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let restore, handle
const walk = node => {
  if (ts.isMethodDeclaration(node) && node.name.getText(syntax) === 'restoreViewState') {
    restore = node
    handle = node.parent
  }
  ts.forEachChild(node, walk)
}
walk(syntax)
assert.ok(restore && handle)
const getters = handle.properties.filter(node => ts.isGetAccessorDeclaration(node)
  && ['selectionStart', 'selectionEnd', 'selectionAnchor', 'selectionHead'].includes(node.name.getText(syntax)))
const compiled = ts.transpileModule('globalThis.handle = ({'
  + [...getters, restore].map(node => node.getText(syntax)).join(',') + '})', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function harness(doc = '0123456789', readOnly = false) {
  const external = Annotation.define(), measures = [], transactions = []
  const view = {
    state: EditorState.create({ doc, extensions: [history(), EditorState.readOnly.of(readOnly)] }),
    scrollDOM: { scrollTop: 0, scrollHeight: 300, clientHeight: 100 },
    dispatch(spec) { const tr = this.state.update(spec); transactions.push(tr); this.state = tr.state },
    requestMeasure(request) { measures.push(request) },
  }
  const context = vm.createContext({ viewRef: { current: view }, viewRestoreGenerationRef: { current: 0 },
    EditorSelection, Transaction, externalValueSync: external })
  vm.runInContext(compiled, context)
  return { view, handle: context.handle, context, transactions, external,
    flush() { for (const request of measures.splice(0)) request.write(request.read(view)) },
  }
}

test('saved backward view restores anchor/head and ordered getters without creating Undo', () => {
  const h = harness(), applied = []
  h.handle.restoreViewState({ selectionStart: 2, selectionEnd: 8,
    selectionAnchor: 8, selectionHead: 2, scrollTop: 70 }, value => applied.push(value))
  assert.equal(h.view.state.selection.main.anchor, 8)
  assert.equal(h.view.state.selection.main.head, 2)
  assert.equal(h.handle.selectionStart, 2)
  assert.equal(h.handle.selectionEnd, 8)
  assert.equal(h.handle.selectionAnchor, 8)
  assert.equal(h.handle.selectionHead, 2)
  assert.equal(undoDepth(h.view.state), 0)
  assert.equal(h.transactions[0].annotation(h.external), true)
  assert.equal(h.transactions[0].annotation(Transaction.addToHistory), false)
  assert.equal(applied.length, 0)
  h.flush()
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), [{ selectionStart: 2, selectionEnd: 8,
    selectionAnchor: 8, selectionHead: 2, scrollTop: 70 }])
})

test('legacy records retain forward and descending range behavior', () => {
  for (const [start, end] of [[2, 8], [8, 2], [5, 5]]) {
    const h = harness()
    h.handle.restoreViewState({ selectionStart: start, selectionEnd: end, scrollTop: 0 })
    assert.equal(h.view.state.selection.main.anchor, start)
    assert.equal(h.view.state.selection.main.head, end)
  }
})

test('incomplete, invalid and range-mismatched direction cannot replace the legacy range', () => {
  for (const fields of [
    { selectionAnchor: 8 }, { selectionHead: 2 },
    { selectionAnchor: 7, selectionHead: 2 }, { selectionAnchor: 8, selectionHead: 3 },
    { selectionAnchor: NaN, selectionHead: 2 }, { selectionAnchor: 8, selectionHead: -2 },
    { selectionAnchor: '8', selectionHead: 2 }, { selectionAnchor: 8.5, selectionHead: 2 },
    { selectionAnchor: Number.MAX_SAFE_INTEGER + 1, selectionHead: 2 },
  ]) {
    const h = harness()
    h.handle.restoreViewState({ selectionStart: 2, selectionEnd: 8, scrollTop: 0, ...fields })
    assert.equal(h.view.state.selection.main.anchor, 2)
    assert.equal(h.view.state.selection.main.head, 8)
  }
})

test('shorter restored document clamps both directed endpoints without flipping direction', () => {
  const h = harness()
  h.handle.restoreViewState({ selectionStart: 2, selectionEnd: 80,
    selectionAnchor: 80, selectionHead: 2, scrollTop: 999 })
  assert.equal(h.view.state.selection.main.anchor, 10)
  assert.equal(h.view.state.selection.main.head, 2)
  h.flush()
  assert.equal(h.view.scrollDOM.scrollTop, 200)
  assert.equal(h.view.state.doc.toString(), '0123456789')
})

test('late measurement of an earlier restore cannot overwrite a newer view or scroll', () => {
  const h = harness(), first = [], second = []
  h.handle.restoreViewState({ selectionStart: 2, selectionEnd: 8,
    selectionAnchor: 8, selectionHead: 2, scrollTop: 70 }, value => first.push(value))
  h.handle.restoreViewState({ selectionStart: 4, selectionEnd: 4, scrollTop: 30 }, value => second.push(value))
  h.flush()
  assert.equal(first.length, 0)
  assert.equal(second.length, 1)
  assert.equal(h.view.scrollDOM.scrollTop, 30)
  h.handle.restoreViewState({ selectionStart: 2, selectionEnd: 8,
    selectionAnchor: 8, selectionHead: 2, scrollTop: 100 }, value => first.push(value))
  h.context.viewRef.current = { state: EditorState.create({ doc: 'new owner' }) }
  h.flush()
  assert.equal(first.length, 0)
  assert.equal(h.view.scrollDOM.scrollTop, 30)
})

test('readOnly view restoration retains text/readOnly and does not request caret scrolling', () => {
  const h = harness('0123456789', true)
  h.handle.restoreViewState({ selectionStart: 2, selectionEnd: 8,
    selectionAnchor: 8, selectionHead: 2, scrollTop: 70 })
  h.flush()
  assert.equal(h.view.state.readOnly, true)
  assert.equal(h.view.state.doc.toString(), '0123456789')
  assert.equal(h.transactions[0].scrollIntoView, false)
  assert.equal(h.view.state.selection.main.anchor, 8)
  assert.equal(h.view.state.selection.main.head, 2)
})
