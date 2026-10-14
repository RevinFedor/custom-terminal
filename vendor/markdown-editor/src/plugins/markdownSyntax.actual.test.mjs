import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-syntax-test-'))
await build({
  stdin: { contents: `export {createMarkdownSyntaxPlugin} from './markdownSyntax.ts';
    export {createRangeContains} from './rangeContainment.ts';
    export {EditorState,EditorSelection,Compartment} from '@codemirror/state';`, resolveDir: here },
  bundle: true, platform: 'node', format: 'esm', outfile: path.join(temporary, 'syntax.mjs'), logLevel: 'silent'
})
const { createMarkdownSyntaxPlugin, createRangeContains, EditorState, EditorSelection, Compartment } =
  await import(path.join(temporary, 'syntax.mjs'))
await fs.rm(temporary, { recursive: true, force: true })

function tuples(decorations) {
  const result = []
  for (const cursor = decorations.iter(); cursor.value; cursor.next()) {
    const value = cursor.value, spec = { ...value.spec }
    if (spec.widget) {
      const widget = spec.widget
      spec.widget = { type: widget.constructor.name.replace(/\d+$/, ''),
        ...Object.fromEntries(Object.entries(widget).filter(([key]) => key !== 'view')) }
    }
    result.push([cursor.from, cursor.to, value.startSide, value.endSide, value.point, spec])
  }
  return result
}

function update(plugin, view, spec = {}, flags = {}) {
  const startState = view.state, transaction = startState.update(spec)
  view.state = transaction.state
  plugin.update({ view, startState, state: view.state, docChanged: transaction.docChanged,
    selectionSet: !!spec.selection, viewportChanged: false, focusChanged: false,
    changes: transaction.changes, ...flags })
}

test('point index preserves half-open membership for overlapping and nested ranges', () => {
  let seed = 513
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
  for (let i = 0; i < 1000; i++) {
    const ranges = [{ from: 0, to: 100 }, { from: 20, to: 30 },
      ...Array.from({ length: Math.floor(random() * 50) }, () => {
        const from = Math.floor(random() * 100)
        return { from, to: from + Math.floor(random() * 70) }
      })]
    const original = structuredClone(ranges), contains = createRangeContains(ranges)
    assert.deepEqual(ranges, original)
    for (let pos = -1; pos < 180; pos++)
      assert.equal(contains(pos), ranges.some(range => range.from <= pos && pos < range.to))
  }
  assert.equal(createRangeContains([])(0), false)
})

test('syntax, widgets and active-line reveal match the pre-optimization golden cases', async () => {
  const baseline = JSON.parse(await fs.readFile(path.join(here, 'fixtures/markdownSyntax-baseline.json'), 'utf8'))
  const warn = console.warn, log = console.log
  console.warn = console.log = () => {}
  try {
    for (const { doc, expected } of baseline.cases) for (const [key, hash] of Object.entries(expected)) {
      const [tabSize, mode] = key.split('/'), last = doc.length
      const ranges = mode === 'last' ? [EditorSelection.cursor(last)]
        : mode === 'all' ? [EditorSelection.range(0, last)]
        : mode === 'multi' && last > 2 ? [EditorSelection.cursor(0), EditorSelection.cursor(last)]
        : [EditorSelection.cursor(0)]
      const state = EditorState.create({ doc, selection: EditorSelection.create(ranges),
        extensions: [EditorState.tabSize.of(+tabSize), EditorState.allowMultipleSelections.of(true)] })
      const view = { state, hasFocus: mode !== 'blur' }, plugin = createMarkdownSyntaxPlugin().create(view)
      assert.equal(createHash('sha256').update(JSON.stringify(tuples(plugin.decorations))).digest('hex'), hash, `${key}: ${doc}`)
      const previous = plugin.decorations
      update(plugin, view, {}, { viewportChanged: true })
      assert.equal(plugin.decorations, previous, 'viewport-only update must reuse the complete syntax result')
    }
  } finally { console.warn = warn; console.log = log }
})

test('text, selection, focus and tab-size changes invalidate the right syntax state', () => {
  const tabSize = new Compartment()
  const view = { state: EditorState.create({ doc: '\t```\n    **x**\n\t```',
    extensions: [tabSize.of(EditorState.tabSize.of(4))] }), hasFocus: false }
  const plugin = createMarkdownSyntaxPlugin().create(view)
  for (const [spec, flags] of [
    [{ effects: tabSize.reconfigure(EditorState.tabSize.of(8)) }, {}],
    [{ changes: { from: 8, to: 9, insert: 'z' } }, {}],
    [{ selection: { anchor: 5 } }, { viewportChanged: true }],
    [{ changes: { from: 0, to: 1, insert: '    ' } }, {}],
    [{}, { focusChanged: true }],
  ]) {
    if (flags.focusChanged) view.hasFocus = true
    update(plugin, view, spec, flags)
    assert.deepEqual(tuples(plugin.decorations), tuples(createMarkdownSyntaxPlugin().create(view).decorations))
  }
})

test('failed construction/update retries on viewport and remaps old ranges on a text change', () => {
  const view = { state: EditorState.create({ doc: '**before** then *after*' }), hasFocus: false }
  const plugin = createMarkdownSyntaxPlugin().create(view), original = plugin.buildDecorations
  const error = console.error, log = console.log
  console.error = console.log = () => {}
  try {
    const before = plugin.decorations, transaction = view.state.update({ changes: { from: 0, to: 4, insert: 'x' } })
    plugin.buildDecorations = () => { throw Error('injected build failure') }
    update(plugin, view, { changes: { from: 0, to: 4, insert: 'x' } })
    assert.equal(plugin.needsRetry, true)
    assert.deepEqual(tuples(plugin.decorations), tuples(before.map(transaction.changes)))
    plugin.buildDecorations = original
    update(plugin, view, {}, { viewportChanged: true })
    assert.equal(plugin.needsRetry, false)
    assert.deepEqual(tuples(plugin.decorations), tuples(createMarkdownSyntaxPlugin().create(view).decorations))
    const complete = plugin.decorations
    update(plugin, view, {}, { viewportChanged: true })
    assert.equal(plugin.decorations, complete)

    const Plugin = plugin.constructor, method = Plugin.prototype.buildDecorations
    let failed
    try {
      Plugin.prototype.buildDecorations = () => { throw Error('injected constructor failure') }
      failed = new Plugin(view)
    } finally { Plugin.prototype.buildDecorations = method }
    assert.equal(failed.needsRetry, true)
    update(failed, view, {}, { viewportChanged: true })
    assert.equal(failed.needsRetry, false)
    assert.deepEqual(tuples(failed.decorations), tuples(createMarkdownSyntaxPlugin().create(view).decorations))
  } finally { console.error = error; console.log = log }
})
