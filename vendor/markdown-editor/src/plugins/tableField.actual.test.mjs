import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const built = await build({
  stdin: { contents: `export {parseMarkdownTables,editMarkdownTable} from './markdownTables';
    export {tableTextOffsets,tableDOMPosition} from './tableTextPosition';
    export {createTableField} from './tableField'; export {createImageField} from './imageField';
    export {EditorState,EditorSelection,Compartment} from '@codemirror/state';
    export {codeFolding,foldEffect,unfoldEffect} from '@codemirror/language';
    export {history,undo,redo} from '@codemirror/commands';`,
    resolveDir: new URL('.', import.meta.url).pathname },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
})
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gt-table-test-'))
const compiled = path.join(temporary, 'tables.mjs')
await fs.writeFile(compiled, built.outputFiles[0].text)
const { parseMarkdownTables, editMarkdownTable, tableTextOffsets, tableDOMPosition, createTableField, createImageField, EditorState,
  EditorSelection, Compartment, codeFolding, foldEffect, unfoldEffect, history, undo, redo } =
  await import(pathToFileURL(compiled))
await fs.rm(temporary, { recursive: true, force: true })

const sample = '\n| Этап | Компании | Обоснование |\n|---|:---:|---:|\n' +
  '| Веб-студия | **STRV, Netguru** | Интерфейсы и интеграции |\n' +
  '| Учебники | **VitalSource** | EPUB и PDF |\n' +
  '| Портал | **Canvas** | Оценки и задания |\n' +
  '| Поля | **OneSoil** | Аграрные данные |\n\nAfter'

function create(doc = sample, config = {}) {
  const field = createTableField(config)
  const images = createImageField()
  const state = EditorState.create({ doc, extensions: [field, images, codeFolding(), history()] })
  return { field, images, state }
}

function previews(state, field) {
  let count = 0
  for (const cursor = state.field(field).decorations.iter(); cursor.value; cursor.next()) if (cursor.value.spec.widget?.table) count++
  return count
}

test('real Markdown parsing produces 3 columns, 4 body rows and exact UTF-16 source positions', () => {
  const { field, state } = create()
  const value = state.field(field), table = value.tables[0]
  assert.equal(value.tables.length, 1)
  assert.equal(table.rows.length, 5)
  assert.equal(table.rows[0].length, 3)
  assert.deepEqual(table.align, [null, 'center', 'right'])
  assert.equal(table.rows[1][1].node.children[0].type, 'strong')
  assert.equal(sample.slice(table.rows[1][1].from, table.rows[1][1].from + 6), '**STRV')
  assert.equal(value.decorations.size, 1)
  assert.equal(state.doc.toString(), sample)
  const emoji = parseMarkdownTables(EditorState.create({ doc: '| 😀 | **name** |\n|--|--|\n| x | y |' }))[0]
  assert.equal(emoji.rows[0][1].from, '| 😀 | '.length)
})

test('GFM alignment, optional outer pipes, escaped pipes and uneven body cells', () => {
  const tables = parseMarkdownTables(EditorState.create({ doc: 'A | B\n:-: | -:\nx\\|y | `q\\|r` | excess\nz\n' }))
  assert.equal(tables.length, 1)
  assert.deepEqual(tables[0].align, ['center', 'right'])
  assert.equal(tables[0].rows[1][0].node.children[0].value, 'x|y')
  assert.equal(tables[0].rows[1][1].node.children[0].value, 'q|r')
  assert.equal(tables[0].rows[2].length, 1)
})

test('valid fences and invalid delimiter/header counts never become table widgets', () => {
  for (const doc of ['| A | B |\n|---|\n| x |', 'A | B\nnot a delimiter', '```md\nA | B\n---|---\nx|y\n```']) {
    assert.equal(parseMarkdownTables(EditorState.create({ doc })).length, 0, doc)
  }
})

test('GT indentation survives parsing and maps each cell back to its original line', () => {
  const doc = '>> Section\n\t| Name | Value |\n    |---|---|\n\t| x | **y** |\nOutside'
  const table = parseMarkdownTables(EditorState.create({ doc }))[0]
  assert.equal(table.indent, 4)
  assert.equal(table.rows.length, 2)
  assert.equal(doc.slice(table.rows[1][1].from, table.rows[1][1].from + 5), '**y**')
  assert(!table.source.includes('Outside'))
})

test('ordinary selection keeps the table; explicit Edit/Done changes mode without reparsing or rewriting', () => {
  const { field, state } = create()
  const tables = state.field(field).tables
  const selected = state.update({ selection: { anchor: tables[0].rows[2][1].from }, userEvent: 'select.table.read' }).state
  assert.equal(previews(selected, field), 1)
  const editing = selected.update({ effects: editMarkdownTable.of({ from: tables[0].from, to: tables[0].to }) }).state
  assert.equal(previews(editing, field), 0)
  assert.equal(editing.field(field).tables, tables)
  const outside = editing.update({ selection: { anchor: editing.doc.length } }).state
  assert.equal(previews(outside, field), 0)
  assert.equal(outside.field(field).tables, tables)
  const all = outside.update({ selection: EditorSelection.single(0, outside.doc.length) }).state
  assert.equal(previews(all, field), 0)
  assert.equal(all.doc.toString(), sample)
  assert.equal(outside.update({}).state.field(field), outside.field(field))
  const done = all.update({ effects: editMarkdownTable.of(null) }).state
  assert.equal(previews(done, field), 1)
  assert.equal(done.field(field).tables, tables)
  assert.equal(state.update({ selection: EditorSelection.single(0, state.doc.length), userEvent: 'select' }).state.field(field).editing, null)
})

test('fold/unfold suppresses nested table blocks, keeping the cached parse and document', () => {
  const { field, state } = create()
  const table = state.field(field).tables[0]
  const range = { from: 0, to: table.to }
  const hidden = state.update({ effects: foldEffect.of(range) }).state
  assert.equal(hidden.field(field).decorations.size, 0)
  const shown = hidden.update({ effects: unfoldEffect.of(range) }).state
  assert.equal(shown.field(field).decorations.size, 1)
  assert.equal(shown.field(field).tables, state.field(field).tables)
  assert.equal(shown.doc.toString(), sample)
})

test('editing, undo/redo and tab-size changes keep ranges valid', () => {
  const tabs = new Compartment(), field = createTableField()
  let state = EditorState.create({ doc: sample, extensions: [field, history(), tabs.of(EditorState.tabSize.of(4))] })
  const view = { get state() { return state }, dispatch(spec) { state = state.update(spec).state } }
  const pos = state.field(field).tables[0].rows[1][0].from
  view.dispatch({ changes: { from: pos, insert: 'new ' }, selection: { anchor: pos + 4 }, userEvent: 'input.type' })
  assert(state.doc.toString().includes('new Веб-студия'))
  assert(undo(view))
  assert.equal(state.doc.toString(), sample)
  assert(redo(view))
  assert(state.doc.toString().includes('new Веб-студия'))
  view.dispatch({ effects: tabs.reconfigure(EditorState.tabSize.of(8)) })
  for (const table of state.field(field).tables) assert(table.from >= 0 && table.to <= state.doc.length)
})

class Element {
  constructor(tag = '#text', text = '') { this.tag = tag; this.text = text; this.childNodes = []; this.attrs = {}; this.style = { setProperty() {} } }
  appendChild(child) { child.parent = this; this.childNodes.push(child); return child }
  setAttribute(name, value) { this.attrs[name] = value }
  getAttribute(name) { return this.attrs[name] ?? null }
  set textContent(text) { this.text = text; this.childNodes = [] }
  get textContent() { return this.text + this.childNodes.map(node => node.textContent).join('') }
  closest(selector) { for (let node = this; node; node = node.parent) if (selector === 'a' ? node.tag === 'a' : node.getAttribute(selector.slice(1, -1)) !== null) return node; return null }
  contains(other) { for (let node = other; node; node = node.parent) if (node === this) return true; return false }
  focus() { this.ownerDocument.activeElement = this }
}
function nodes(root, tag) { return (root.tag === tag ? [root] : []).concat(root.childNodes.flatMap(child => nodes(child, tag))) }
function dom(doc, config = {}) {
  const original = globalThis.document
  const owner = { selected: null, point: null, getSelection() { return this.selected }, caretRangeFromPoint() { return this.point } }
  owner.createElement = tag => Object.assign(new Element(tag), { ownerDocument: owner })
  owner.createTextNode = text => Object.assign(new Element('#text', text), { ownerDocument: owner })
  globalThis.document = owner
  const { field, state } = create(doc, config)
  const view = { state, dom: { querySelector() { return null } }, focus() {}, requestMeasure() {}, dispatch(spec) { this.state = this.state.update(spec).state } }
  view.dispatch = view.dispatch.bind(view)
  const widget = state.field(field).decorations.iter().value.spec.widget
  try { return { root: widget.toDOM(view), view, field, owner } }
  finally { globalThis.document = original }
}

test('actual widget has a header, aligned cells, normalized body columns and rendered inline formatting', () => {
  const { root } = dom('A | B\n:-: | -:\n**bold** | `code` | excess\nx\n')
  assert.equal(nodes(root, 'th').length, 2)
  assert.equal(nodes(root, 'td').length, 4)
  assert.equal(nodes(root, 'td')[0].textContent, 'bold')
  assert.equal(nodes(root, 'code')[0].textContent, 'code')
  assert.equal(nodes(root, 'th')[0].style.textAlign, 'center')
  assert.equal(nodes(root, 'th')[1].style.textAlign, 'right')
  assert(!root.textContent.includes('excess'))
})

test('actual widget opens external links, keeps reading on ordinary clicks and enters source only via Edit', () => {
  const opened = [], source = '\nA | Link\n---|---\nvalue | [**site**](https://example.com/#part)\n'
  const { root, view, field } = dom(source, { onOpenUrl: url => opened.push(url) })
  const link = nodes(root, 'a')[0], event = { button: 0, target: link, metaKey: true, preventDefault() {}, stopPropagation() {} }
  root.onmousedown(event)
  assert.deepEqual(opened, ['https://example.com/#part'])
  assert.equal(view.state.field(field).decorations.size, 1)
  const cell = nodes(root, 'td')[0]
  root.onmousedown({ ...event, target: cell, metaKey: false })
  assert.equal(root.onmouseup({ ...event, target: cell, metaKey: false }), undefined)
  assert.equal(view.state.field(field).editing, null)
  assert.equal(previews(view.state, field), 1)
  nodes(root, 'button')[0].onclick(event)
  assert.equal(previews(view.state, field), 0)
  assert.equal(view.state.doc.toString(), source)
})

test('clicked n inside bold Canvas lands on the same source character after pressing Edit', () => {
  const source = '\nName | Value\n---|---\n**Canvas** | text\n'
  const { root, view, field, owner } = dom(source)
  const text = nodes(root, '#text').find(node => node.text === 'Canvas')
  owner.point = { startContainer: text, startOffset: 2 }
  const event = { button: 0, target: text.parent, clientX: 20, clientY: 10, preventDefault() {}, stopPropagation() {} }
  root.onmousedown(event)
  assert.equal(owner.activeElement, root)
  assert.equal(view.state.field(field).editing, null)
  nodes(root, 'button')[0].onclick(event)
  assert.equal(view.state.selection.main.head, source.indexOf('Canvas') + 2)
  assert.equal(view.state.doc.sliceString(view.state.selection.main.head, view.state.selection.main.head + 1), 'n')
  assert.equal(view.state.doc.toString(), source)
})

test('native text selection across cells copies its text and maps both ends when entering source', () => {
  const source = '\nName | Value\n---|---\n**Canvas** | `value`\n', copied = []
  const { root, view, field, owner } = dom(source, { clipboard: { readText() { return '' }, writeText(text) { copied.push(text) } } })
  const left = nodes(root, '#text').find(node => node.text === 'Canvas')
  const right = nodes(root, '#text').find(node => node.text === 'value')
  owner.selected = { anchorNode: left, anchorOffset: 2, focusNode: right, focusOffset: 3, isCollapsed: false, toString() { return 'nvas\tval' } }
  const event = { metaKey: true, code: 'KeyC', preventDefault() {}, stopPropagation() {} }
  root.onkeydown(event)
  assert.deepEqual(copied, ['nvas\tval'])
  assert.equal(view.state.field(field).editing, null)
  const nativeCopy = []
  root.oncopy({ ...event, clipboardData: { setData(type, value) { nativeCopy.push([type, value]) } } })
  assert.deepEqual(nativeCopy, [['text/plain', 'nvas\tval']])
  nodes(root, 'button')[0].onclick(event)
  assert.equal(view.state.selection.main.anchor, source.indexOf('Canvas') + 2)
  assert.equal(view.state.selection.main.head, source.indexOf('value') + 3)
})

test('Undo/Redo from the focused reading surface uses editor history, not browser editing', () => {
  const source = '\nName | Value\n---|---\nCanvas | value\n'
  const { root, view } = dom(source)
  const from = source.indexOf('Canvas')
  view.dispatch({ changes: { from, to: from + 6, insert: 'Netguru' }, userEvent: 'input.type' })
  const event = { metaKey: true, code: 'KeyZ', preventDefault() {}, stopPropagation() {} }
  root.onkeydown(event)
  assert.equal(view.state.doc.toString(), source)
  root.onkeydown({ ...event, shiftKey: true })
  assert(view.state.doc.toString().includes('Netguru'))
})

test('text mapping accounts for escapes, entities, inline-code delimiters and UTF-16 characters', () => {
  assert.deepEqual(tableTextOffsets('a\\|b', 'a|b', 10), [10, 12, 13, 14])
  assert.deepEqual(tableTextOffsets('a&amp;b', 'a&b', 10), [10, 11, 16, 17])
  assert.deepEqual(tableTextOffsets('` Canvas `', 'Canvas', 10, 'code'), [12, 13, 14, 15, 16, 17, 18])
  assert.deepEqual(tableTextOffsets('😀n', '😀n', 0), [0, 1, 2, 3])
  const map = new WeakMap(), outer = new Element('span'), text = outer.appendChild(new Element('#text', 'test'))
  map.set(text, [10, 11, 12, 13, 14])
  assert.equal(tableDOMPosition(outer, 0, map), 10)
  assert.equal(tableDOMPosition(outer, 1, map), 14)
})

test('explicit source mode remaps through edits, Done restores preview, and search keeps source highlighting', () => {
  const { state, field } = create()
  const table = state.field(field).tables[0]
  const editing = state.update({ effects: editMarkdownTable.of({ from: table.from, to: table.to }) }).state
  const changed = editing.update({ changes: { from: table.rows[1][0].from, insert: 'new ' } }).state
  assert.equal(changed.field(field).editing.to, table.to + 4)
  const done = changed.update({ effects: editMarkdownTable.of(null) }).state
  assert.equal(previews(done, field), 1)
  const searched = done.update({ selection: EditorSelection.single(table.rows[1][1].from, table.rows[1][1].from + 3), userEvent: 'select.search' }).state
  assert.equal(previews(searched, field), 0)
  const navigated = done.update({ selection: { anchor: table.rows[1][1].from } }).state
  assert.equal(previews(navigated, field), 0)
  const pointer = done.update({ selection: { anchor: table.rows[1][1].from }, userEvent: 'select.pointer' }).state
  assert.equal(previews(pointer, field), 1)
})

test('read-only reconfiguration closes source editing and removes its controls', () => {
  const locked = new Compartment(), field = createTableField()
  const state = EditorState.create({ doc: sample, extensions: [field, locked.of(EditorState.readOnly.of(false))] })
  const table = state.field(field).tables[0]
  const editing = state.update({ effects: editMarkdownTable.of({ from: table.from, to: table.to }) }).state
  const readonly = editing.update({ effects: locked.reconfigure(EditorState.readOnly.of(true)) }).state
  assert.equal(readonly.field(field).editing, null)
  assert.equal(previews(readonly, field), 1)
  assert.equal(readonly.doc.toString(), sample)
})

test('literal HTML stays text and table images do not install overlapping image chips', () => {
  const { root } = dom('| A | B |\n|---|---|\n| <script>alert(1)</script> | ![image](https://example.com/x.png) |\n')
  assert.equal(nodes(root, 'script').length, 0)
  assert.equal(nodes(root, 'img').length, 1)
  assert(root.textContent.includes('<script>'))
  const { state, images } = create('A | B\n---|---\n![image](x.png) | text\n')
  assert.equal(state.field(images).decorations.size, 0)
})

test('images outside tables and standalone image-field consumers keep their chip behavior', () => {
  const { state, images } = create('\n![outside](outside.png)\n\nA | B\n---|---\n![inside](inside.png) | value\n')
  assert.equal(state.field(images).decorations.size, 1)
  assert.equal(state.field(images).atoms.size, 1)
  const standalone = createImageField()
  const ordinary = EditorState.create({ doc: '\n![image](x.png)', extensions: [standalone] })
  assert.equal(ordinary.field(standalone).decorations.size, 1)
  assert.equal(ordinary.field(standalone).atoms.size, 1)
})
