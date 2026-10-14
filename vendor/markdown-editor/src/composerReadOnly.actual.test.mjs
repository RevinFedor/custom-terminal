import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, isolateHistory, redo, redoDepth, splitLine, undo, undoDepth } from '@codemirror/commands'
import { createComposerHistoryPayloadExtension } from './composerHistory.ts'

// Actual TSX callbacks with real CM state, facets, editing commands and aggregate
// history. The driver replaces React commit/EditorView/DOM; it does not prove
// native contenteditable, focus, layout, event delivery or pixel behavior.
const source = fs.readFileSync(new URL('./ComposerEditor.tsx', import.meta.url), 'utf8')
const syntax = ts.createSourceFile('ComposerEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)) }
const hooks = []
walk(syntax, node => {
  if (ts.isCallExpression(node) && ['useEffect', 'useLayoutEffect'].includes(node.expression.getText(syntax))) hooks.push(node)
})
const hook = deps => hooks.find(node => node.arguments[1]?.getText(syntax) === deps)?.arguments[0]
const effect = hook('[readOnly]'), ownerEffect = hook('[historyOwnerKey]')
const mountHook = hooks.find(node => node.arguments[0]?.getText(syntax).includes('new EditorView('))
const mount = mountHook?.arguments[0]
assert.ok(effect && ownerEffect && mount)
assert.equal(mountHook.arguments[1].getText(syntax), '[]', 'editor mount lifecycle is unchanged')
const record = statements => statements.find(node => ts.isExpressionStatement(node)
  && ts.isBinaryExpression(node.expression)
  && node.expression.left.getText(syntax) === 'appliedReadOnlyRef.current')
const initialized = record(mount.body.statements)
const cleanup = mount.body.statements.find(ts.isReturnStatement)?.expression
const cleared = cleanup && record(cleanup.body.statements)
let initialExtension, dispatchPayload
walk(mount, node => {
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'readOnlyCompartment.of') initialExtension = node
})
walk(effect, node => {
  if (ts.isCallExpression(node) && /dispatch$/.test(node.expression.getText(syntax))) dispatchPayload = node.arguments[0]
})
assert.ok(initialExtension && dispatchPayload)
const compile = text => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const actualEffect = compile(`(${effect.getText(syntax)})()`)
const actualOwnerEffect = compile(`(${ownerEffect.getText(syntax)})()`)
// Optional only so this same test can run RED against pre-fix source. Assertions
// below require the records' behavior, without implementing them in the driver.
const constructorRecord = compile(initialized?.getText(syntax) || '')
const cleanupRecord = compile(cleared?.getText(syntax) || '')
const unguardedEffect = compile(`viewRef.current?.dispatch(${dispatchPayload.getText(syntax)})`)

function harness(mode = 'actual', readOnly = false, doc = 'abcdef', applied = { current: null }) {
  const readOnlyCompartment = new Compartment(), historyCompartment = new Compartment()
  const initialPayload = { chips: [{ id: 'A', body: 'synthetic body A' }], images: [] }
  const aggregate = createComposerHistoryPayloadExtension({ initial: initialPayload, derive: (_text, previous) => previous })
  const frames = new Map()
  let nextFrame = 0
  const context = vm.createContext({ readOnlyCompartment, EditorState, EditorView, Transaction, history, readOnly,
    appliedReadOnlyRef: applied, historyCompartmentRef: { current: historyCompartment },
    historyOwnerKey: 'owner-A', historyOwnerKeyRef: { current: 'owner-A' }, historyOwnerTransitionRef: { current: false },
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
  })
  const installed = vm.runInContext(initialExtension.getText(syntax), context)
  const view = {
    state: EditorState.create({ doc, extensions: [installed, historyCompartment.of(history()), aggregate.extension] }),
    calls: 0, transactions: 0, failure: null,
    dispatch(spec) {
      this.calls++
      const failure = this.failure
      this.failure = null
      if (failure === 'before') throw Error('controlled dispatch refusal before apply')
      this.state = spec instanceof Transaction ? spec.state : this.state.update(spec).state
      this.transactions++
      if (failure === 'after') throw Error('controlled dispatch refusal after apply')
    },
  }
  Object.assign(context, { view, viewRef: { current: view }, readOnlyCompartmentRef: { current: readOnlyCompartment } })
  vm.runInContext(constructorRecord, context)
  return { view, context, aggregate, applied, readOnlyCompartment, installed: readOnlyCompartment.get(view.state),
    snapshot() { return {
      doc: view.state.doc.toString(), selection: view.state.selection.toJSON(), payload: aggregate.read(view.state),
      undo: undoDepth(view.state), redo: redoDepth(view.state),
      readOnly: view.state.readOnly, editable: view.state.facet(EditorView.editable),
    } },
    effect(value) {
      context.readOnly = value
      vm.runInContext(mode === 'actual' ? actualEffect : unguardedEffect, context)
    },
    cleanup() { context.viewRef.current = null; vm.runInContext(cleanupRecord, context) },
    changeOwner(key) {
      context.historyOwnerKey = key
      vm.runInContext(actualOwnerEffect, context)
      for (const [id, callback] of frames) { frames.delete(id); callback() }
    },
    run(command) { return command({ state: view.state, dispatch(transaction) {
      const reconciliation = aggregate.reconciliationFor(transaction)
      view.dispatch(transaction)
      if (reconciliation) view.dispatch(reconciliation)
    } }) },
  }
}
const pair = (initial, doc) => [harness('unguarded', initial, doc), harness('actual', initial, doc)]
const parity = items => assert.deepEqual(items[0].snapshot(), items[1].snapshot())
const facets = (item, locked) => {
  assert.equal(item.view.state.readOnly, locked)
  assert.equal(item.view.state.facet(EditorView.editable), !locked, 'DOM-driving editable facet')
}

test('initial true and false are installed immediately without a redundant transaction', () => {
  for (const initial of [false, true]) {
    const items = pair(initial)
    const beforeState = items[1].view.state
    for (const item of items) { facets(item, initial); item.effect(initial) }
    assert.equal(items[0].view.transactions, 1, 'unguarded actual payload reproduces the duplicate')
    assert.equal(items[1].view.transactions, 0)
    assert.equal(items[1].view.state, beforeState)
    assert.equal(items[1].readOnlyCompartment.get(items[1].view.state), items[1].installed)
    parity(items)
  }
})

test('legitimate false/true transitions preserve reverse selection and control real CM editing commands', () => {
  const items = pair(false)
  for (const item of items) item.view.dispatch({ selection: EditorSelection.single(5, 2) })
  for (const locked of [true, false, true, false]) {
    for (const item of items) { item.effect(locked); facets(item, locked) }
    parity(items)
    assert.equal(items[1].snapshot().doc, 'abcdef')
    assert.equal(items[1].view.state.selection.main.anchor, 5)
    assert.equal(items[1].view.state.selection.main.head, 2)
  }
  for (const item of items) {
    item.effect(true)
    assert.equal(item.run(splitLine), false, 'locked state rejects the actual editing command')
    assert.equal(item.snapshot().doc, 'abcdef')
    item.effect(false)
    assert.equal(item.run(splitLine), true, 'unlock restores ordinary editing')
    assert.equal(item.snapshot().doc, 'ab\nf')
  }
  parity(items)
})

test('a prop change before the first passive effect applies in both directions', () => {
  for (const initial of [false, true]) {
    const items = pair(initial)
    for (const item of items) { item.effect(!initial); facets(item, !initial) }
    assert.equal(items[1].view.transactions, 1)
    parity(items)
  }
})

test('aggregate chips/Undo/Redo and actual owner reset remain intact across lock transitions', () => {
  const items = pair(false, 'draft')
  for (const item of items) {
    item.effect(false)
    item.view.dispatch({ changes: { from: 5, insert: ' [chip]' }, selection: EditorSelection.single(12, 6),
      effects: [item.aggregate.snapshotBoundary.of(true), item.aggregate.setPayload.of({ chips: [{ id: 'B', body: 'synthetic body B' }], images: [] })],
      annotations: isolateHistory.of('full'), userEvent: 'input' })
    item.effect(true)
    assert.equal(item.run(undo), false)
    assert.equal(undoDepth(item.view.state), 1, 'locking does not discard Undo')
    item.effect(false)
    assert.equal(item.run(undo), true)
    assert.equal(item.snapshot().doc, 'draft')
    assert.equal(item.snapshot().payload.chips[0].id, 'A')
    item.effect(true)
    assert.equal(item.run(redo), false)
    item.effect(false)
    assert.equal(item.run(redo), true)
    assert.equal(item.snapshot().doc, 'draft [chip]')
    assert.equal(item.snapshot().payload.chips[0].id, 'B')
    assert.equal(item.view.state.selection.main.anchor, 12)
    assert.equal(item.view.state.selection.main.head, 6)
    item.changeOwner('owner-A')
    assert.equal(undoDepth(item.view.state), 1, 'same owner retains its Undo branch')
    const beforeOwner = item.snapshot()
    item.changeOwner('owner-B')
    assert.equal(undoDepth(item.view.state), 0)
    assert.equal(redoDepth(item.view.state), 0)
    assert.equal(item.snapshot().doc, beforeOwner.doc)
    assert.deepEqual(item.snapshot().payload, beforeOwner.payload)
    assert.deepEqual(item.snapshot().selection, beforeOwner.selection)
    item.effect(true); item.effect(false)
  }
  parity(items)
})

test('cleanup and a new view establish their own applied value without hiding a different-view update', () => {
  for (const initial of [false, true]) {
    const applied = { current: null }
    const first = harness('actual', initial, 'first', applied)
    first.effect(!initial)
    first.cleanup()
    assert.equal(applied.current, null)
    const second = harness('actual', !initial, 'second', applied)
    second.effect(!initial); second.effect(!initial)
    assert.equal(second.view.transactions, 0)
    assert.equal(applied.current?.view, second.view)
    assert.notEqual(first.view, second.view)
    facets(second, !initial)
    applied.current = { view: first.view, value: initial }
    second.effect(initial)
    assert.equal(second.view.transactions, 1)
    facets(second, initial)
    assert.equal(applied.current?.view, second.view)
  }
})

test('missing view and failed dispatch before/after state apply never advance the success record', () => {
  for (const failure of ['before', 'after']) {
    const item = harness('actual', false)
    item.context.viewRef.current = null
    item.effect(true)
    assert.equal(item.view.calls, 0)
    item.context.viewRef.current = item.view
    item.view.failure = failure
    assert.throws(() => item.effect(true), /controlled dispatch refusal/)
    assert.equal(item.applied.current?.value, false)
    facets(item, failure === 'after')
    item.effect(true)
    assert.equal(item.view.calls, 2, 'retry is not suppressed by a failed dispatch')
    facets(item, true)
    assert.equal(item.applied.current?.value, true)
    item.effect(true)
    assert.equal(item.view.calls, 2, 'successful retry now permits same-value suppression')
  }
})
