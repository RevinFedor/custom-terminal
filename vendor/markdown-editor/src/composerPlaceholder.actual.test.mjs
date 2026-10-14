import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { createComposerHistoryPayloadExtension } from './composerHistory.ts'

// Execute the actual TSX effect and its constructor/cleanup records against
// real CM state. React commit, EditorView/DOM, focus and layout are not simulated.
const source = fs.readFileSync(new URL('./ComposerEditor.tsx', import.meta.url), 'utf8')
const syntax = ts.createSourceFile('ComposerEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const hooks = []
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)) }
walk(syntax, node => {
  if (ts.isCallExpression(node) && ['useEffect', 'useLayoutEffect'].includes(node.expression.getText(syntax))) hooks.push(node)
})
const effect = hooks.find(node => node.arguments[1]?.getText(syntax) === '[placeholder]')?.arguments[0]
const mount = hooks.find(node => node.arguments[0]?.getText(syntax).includes('new EditorView('))?.arguments[0]
assert.ok(effect && mount, 'actual placeholder effect and editor constructor effect')
assert.equal(hooks.find(node => node.arguments[0] === mount).arguments[1].getText(syntax), '[]')
const record = statements => statements.find(node => ts.isExpressionStatement(node)
  && ts.isBinaryExpression(node.expression)
  && node.expression.left.getText(syntax) === 'appliedPlaceholderRef.current')
const initialized = record(mount.body.statements)
const cleanup = mount.body.statements.find(ts.isReturnStatement)?.expression
const cleared = cleanup && record(cleanup.body.statements)
assert.ok(initialized && cleared, 'actual constructor and cleanup own the applied record')
let initialExtension, dispatch
walk(mount, node => {
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'placeholderCompartment.of') initialExtension = node
})
walk(effect, node => {
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'view.dispatch') dispatch = node
})
assert.ok(initialExtension && dispatch)
const compile = text => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const placeholderDefinition = syntax.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => declaration.name.getText(syntax) === 'composerPlaceholderExtension'))
assert.ok(placeholderDefinition, 'actual generated-hint extension')
const actualPlaceholderDefinition = compile(placeholderDefinition.getText(syntax))
const actualEffect = compile(`(${effect.getText(syntax)})()`)
const constructorRecord = compile(initialized.getText(syntax))
const cleanupRecord = compile(cleared.getText(syntax))
// Unguarded reference uses the actual unchanged dispatch payload. This is the
// old behavior's distinguishing control, not a second implementation of the fix.
const unguardedEffect = compile(`if (viewRef.current) { const view = viewRef.current; ${dispatch.getText(syntax)} }`)

function harness(mode = 'actual', initialPlaceholder = 'Send a prompt...', doc = '', applied = { current: null }) {
  const placeholderCompartment = new Compartment(), readOnlyCompartment = new Compartment(), historyCompartment = new Compartment()
  const aggregate = createComposerHistoryPayloadExtension({
    initial: { chips: [{ id: 'synthetic', body: 'control payload' }], images: [] },
    derive: (_next, previous) => previous,
  })
  const context = vm.createContext({ placeholderCompartment, EditorView,
    placeholder: initialPlaceholder, appliedPlaceholderRef: applied })
  vm.runInContext(actualPlaceholderDefinition, context)
  const installed = vm.runInContext(initialExtension.getText(syntax), context)
  const view = {
    state: EditorState.create({ doc, extensions: [installed, aggregate.extension, historyCompartment.of(history()),
      readOnlyCompartment.of([EditorState.readOnly.of(false), EditorView.editable.of(true)])] }),
    dispatches: 0, throwNext: false,
    dispatch(spec) {
      if (this.throwNext) { this.throwNext = false; throw Error('controlled dispatch refusal') }
      this.state = spec instanceof Transaction ? spec.state : this.state.update(spec).state
      this.dispatches++
    },
  }
  Object.assign(context, { view, viewRef: { current: view }, placeholderCompartmentRef: { current: placeholderCompartment } })
  vm.runInContext(constructorRecord, context)
  const snapshot = () => ({
    doc: view.state.doc.toString(), selection: view.state.selection.toJSON(),
    payload: aggregate.read(view.state), undo: undoDepth(view.state), redo: redoDepth(view.state),
    readOnly: view.state.readOnly, editable: view.state.facet(EditorView.editable),
    attributes: view.state.facet(EditorView.contentAttributes).map(value => (
      // This executes the actual view-dependent facet with real CM state;
      // it does not render a DOM or prove browser input/layout behavior.
      JSON.parse(JSON.stringify(typeof value === 'function' ? value(view) : value))
    )),
  })
  return { view, context, applied, placeholderCompartment, readOnlyCompartment, historyCompartment, aggregate,
    installed: placeholderCompartment.get(view.state), snapshot,
    effect(value) {
      context.placeholder = value
      vm.runInContext(mode === 'actual' ? actualEffect : unguardedEffect, context)
    },
    cleanup() { context.viewRef.current = null; vm.runInContext(cleanupRecord, context) },
    replay(command) { return command({ state: view.state, dispatch(transaction) {
      const reconciliation = aggregate.reconciliationFor(transaction)
      view.dispatch(transaction)
      if (reconciliation) view.dispatch(reconciliation)
    } }) },
  }
}
const pair = (text, doc) => [harness('unguarded', text, doc), harness('actual', text, doc)]
const parity = items => assert.deepEqual(items[0].snapshot(), items[1].snapshot())

test('cold mount preserves its initial placeholder extension instead of publishing it twice', () => {
  for (const text of ['', 'Send a prompt...', 'Запускаю терминал…']) {
    const items = pair(text, '')
    parity(items)
    for (const item of items) item.effect(text)
    assert.equal(items[0].view.dispatches, 1)
    assert.equal(items[1].view.dispatches, 0)
    assert.notEqual(items[0].placeholderCompartment.get(items[0].view.state), items[0].installed)
    assert.equal(items[1].placeholderCompartment.get(items[1].view.state), items[1].installed)
    parity(items)
  }
})

test('a real prop change before the first passive effect is applied, including an empty value', () => {
  for (const text of ['Stopping...', '']) {
    const items = pair('Send a prompt...', 'draft')
    for (const item of items) item.effect(text)
    parity(items)
    assert.equal(items[1].view.dispatches, 1)
    assert.equal(items[1].snapshot().attributes[0]['aria-placeholder'], text)
  }
})

test('hint visibility follows the real document through input and Undo, retaining accessible text', () => {
  const item = harness('actual', 'Enter sends')
  assert.deepEqual(item.snapshot().attributes, [{
    'aria-placeholder': 'Enter sends', 'data-composer-empty-placeholder': '',
  }])
  item.view.dispatch({ changes: { from: 0, insert: 'a\nb' }, userEvent: 'input' })
  assert.deepEqual(item.snapshot().attributes, [{ 'aria-placeholder': 'Enter sends' }])
  item.effect('Updated hint')
  assert.equal(item.snapshot().doc, 'a\nb')
  assert.deepEqual(item.snapshot().attributes, [{ 'aria-placeholder': 'Updated hint' }])
  assert.equal(item.replay(undo), true)
  assert.deepEqual(item.snapshot().attributes, [{
    'aria-placeholder': 'Updated hint', 'data-composer-empty-placeholder': '',
  }])
  item.effect('')
  assert.deepEqual(item.snapshot().attributes, [{ 'aria-placeholder': '' }])
})

test('real placeholder transitions preserve doc, reverse selection, readOnly/editable and decorations', () => {
  const items = pair('', 'initial draft')
  for (const item of items) item.view.dispatch({ selection: EditorSelection.single(7, 3) })
  for (const text of ['', 'Enter запускает Codex и отправляет', 'Запускаю терминал…', 'Send a prompt...', 'Stopping...', 'Rewinding... input is locked', '']) {
    for (const item of items) item.effect(text)
    parity(items)
    assert.equal(items[1].view.state.selection.main.anchor, 7)
    assert.equal(items[1].view.state.selection.main.head, 3)
  }
  for (const locked of [true, false]) {
    for (const item of items) item.view.dispatch({ effects: item.readOnlyCompartment.reconfigure([
      EditorState.readOnly.of(locked), EditorView.editable.of(!locked),
    ]) })
    for (const item of items) item.effect(locked ? 'Locked' : 'Ready')
    parity(items)
    assert.equal(items[1].view.state.readOnly, locked)
  }
})

test('aggregate Undo/Redo and owner-history reset remain equivalent across placeholder publication', () => {
  const items = pair('A', 'draft')
  for (const item of items) {
    item.effect('A')
    item.view.dispatch({ changes: { from: 5, insert: ' [chip]' }, selection: EditorSelection.single(12),
      effects: [item.aggregate.snapshotBoundary.of(true), item.aggregate.setPayload.of({ chips: ['second'], images: [] })],
      annotations: isolateHistory.of('full'), userEvent: 'input' })
    item.effect('B')
  }
  parity(items)
  for (const command of [undo, redo]) {
    for (const item of items) assert.equal(item.replay(command), true)
    parity(items)
    assert.equal(items[1].snapshot().doc, command === undo ? 'draft' : 'draft [chip]')
    assert.equal(items[1].snapshot().payload.chips[0]?.id || items[1].snapshot().payload.chips[0], command === undo ? 'synthetic' : 'second')
  }
  for (const item of items) {
    item.view.dispatch({ effects: item.historyCompartment.reconfigure([]), annotations: Transaction.addToHistory.of(false) })
    item.view.dispatch({ effects: item.historyCompartment.reconfigure(history()), annotations: Transaction.addToHistory.of(false) })
    item.effect('B')
    assert.equal(undoDepth(item.view.state), 0)
  }
  parity(items)
})

test('constructor/cleanup records belong to each view; repeated effects and a new view keep their initial value', () => {
  const applied = { current: null }
  const first = harness('actual', 'A', '', applied)
  first.effect('A'); first.effect('B')
  first.cleanup()
  assert.equal(applied.current, null)
  const second = harness('actual', 'B', '', applied)
  second.effect('B'); second.effect('B')
  assert.equal(second.view.dispatches, 0)
  assert.equal(second.applied.current.view, second.view)
  assert.notEqual(first.view, second.view)
  assert.equal(second.snapshot().attributes[0]['aria-placeholder'], 'B')
  second.effect('C')
  assert.equal(second.view.dispatches, 1)
})

test('missing view, failed dispatch and a different view cannot falsely mark the placeholder applied', () => {
  const item = harness('actual', 'A')
  item.context.viewRef.current = null
  item.effect('B')
  assert.equal(item.applied.current.value, 'A')
  item.context.viewRef.current = item.view
  item.view.throwNext = true
  assert.throws(() => item.effect('B'), /controlled dispatch refusal/)
  assert.equal(item.applied.current.value, 'A')
  item.effect('B')
  assert.equal(item.applied.current.value, 'B')
  item.applied.current = { view: {}, value: 'C' }
  item.effect('C')
  assert.equal(item.applied.current.view, item.view)
  assert.equal(item.view.dispatches, 2)
})
