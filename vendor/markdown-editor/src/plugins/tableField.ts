import { Facet, StateField, Transaction, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { foldEffect, foldedRanges, unfoldEffect } from '@codemirror/language'
import { MarkdownTableWidget, type MarkdownTableConfig } from '../widgets/MarkdownTableWidget'
import { TableEditControlsWidget } from '../widgets/TableEditControlsWidget'
import { editMarkdownTable, parseMarkdownTables, type MarkdownTable } from './markdownTables'

interface TableFieldValue {
  tables: MarkdownTable[]
  decorations: DecorationSet
  editing: { from: number; to: number } | null
}

// All table source belongs to this field, including when it is revealed for
// editing. Image chips/previews must not overlap a table's block replacement.
export const markdownTableRanges = Facet.define<readonly { from: number; to: number }[], readonly { from: number; to: number }[]>({
  combine: values => values.flat(),
})

function buildDecorations(state: EditorState, tables: MarkdownTable[], editing: TableFieldValue['editing'], config: MarkdownTableConfig) {
  const folds = foldedRanges(state)
  const decorations: { from: number; to: number; value: Decoration }[] = []
  for (const table of tables) {
    const isEditing = editing && editing.from < table.to && editing.to > table.from
    let hidden = false
    folds.between(table.from, table.to, (from, to) => { if (from < table.to && to > table.from) hidden = true })
    if (!isEditing && !hidden) decorations.push({
      from: table.from, to: table.to,
      value: Decoration.replace({ widget: new MarkdownTableWidget(table, config, state.readOnly), block: true }),
    })
  }
  if (editing && !state.readOnly) {
    let hidden = false
    folds.between(editing.from, editing.to, (from, to) => { if (from < editing.to && to > editing.from) hidden = true })
    if (!hidden) {
      const first = state.doc.lineAt(editing.from).number, last = state.doc.lineAt(editing.to).number
      decorations.push({ from: state.doc.line(first).from, to: state.doc.line(first).from,
        value: Decoration.widget({ widget: new TableEditControlsWidget(state.doc.line(first).from), block: true, side: -1 }) })
      for (let line = first; line <= last; line++) {
        decorations.push({ from: state.doc.line(line).from, to: state.doc.line(line).from,
          value: Decoration.line({ class: 'cm-markdown-table-source-line' + (line === first ? ' cm-markdown-table-source-first' : '') + (line === last ? ' cm-markdown-table-source-last' : '') }) })
      }
    }
  }
  return Decoration.set(decorations.map(item => item.value.range(item.from, item.to)), true)
}

export function createTableField(config: MarkdownTableConfig = {}): Extension {
  return StateField.define<TableFieldValue>({
    create(state) {
      const tables = parseMarkdownTables(state)
      return { tables, editing: null, decorations: buildDecorations(state, tables, null, config) }
    },
    update(value, tr) {
      const tabChanged = tr.startState.tabSize !== tr.state.tabSize
      const readonlyChanged = tr.startState.readOnly !== tr.state.readOnly
      if (!tr.docChanged && !tabChanged && !readonlyChanged && !tr.selection && !tr.effects.some(effect => effect.is(foldEffect) || effect.is(unfoldEffect) || effect.is(editMarkdownTable))) return value
      const tables = tr.docChanged || tabChanged ? parseMarkdownTables(tr.state) : value.tables
      let editing = value.editing && { from: tr.changes.mapPos(value.editing.from, -1), to: tr.changes.mapPos(value.editing.to, 1) }
      for (const effect of tr.effects) if (effect.is(editMarkdownTable)) editing = effect.value
      // Search/Goto explicitly navigate to source offsets. Keep those existing
      // contracts; native reading selections and tagged mouse selections do not.
      if (tr.isUserEvent('select.search') || (tr.selection && !tr.annotation(Transaction.userEvent))) {
        const match = tables.find(table => tr.state.selection.main.from < table.to && tr.state.selection.main.to >= table.from)
        if (match) editing = { from: match.from, to: match.to }
      }
      if (tr.state.readOnly || (editing && editing.from >= editing.to)) editing = null
      return { tables, editing, decorations: buildDecorations(tr.state, tables, editing, config) }
    },
    provide: field => [
      EditorView.decorations.from(field, value => value.decorations),
      markdownTableRanges.from(field, value => value.editing ? [...value.tables, value.editing].sort((a, b) => a.from - b.from) : value.tables),
    ],
  })
}
