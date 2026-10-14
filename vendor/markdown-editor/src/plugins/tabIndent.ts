import { EditorView, type KeyBinding } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'
import { findBlock } from './blockMove'

/**
 * Count leading whitespace columns (tabs expand to tabSize).
 */
function countIndentColumns(text: string, tabSize: number): number {
  let col = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 9) col += tabSize - (col % tabSize)
    else if (text.charCodeAt(i) === 32) col++
    else break
  }
  return col
}

/**
 * Get tab stop step size from indentUnit facet.
 */
function getTabStep(state: EditorState): number {
  const unit = state.facet(indentUnit)
  return unit === '\t' ? state.tabSize : unit.length
}

/**
 * Generate indent string (spaces only, matching indentUnit convention).
 */
function makeIndent(cols: number): string {
  return ' '.repeat(cols)
}

/**
 * VS Code-style Tab / Shift-Tab with tab stop snapping.
 *
 * Instead of blindly adding 4 spaces (indentMore), snaps the line's
 * leading whitespace to the next/previous multiple of indentUnit size.
 *
 * Examples (step=4):
 *   Tab:       0→4, 1→4, 3→4, 4→8, 5→8, 8→12
 *   Shift-Tab: 4→0, 5→4, 8→4, 1→0, 0→0
 *
 * Uses state.changeByRange() for correct multi-cursor support
 * (same pattern as CM6's built-in indentMore/indentLess).
 */
const collapsiblePattern = /^\s*(>>|\^\^)/

/**
 * Collect the set of line numbers that should move together with the user's
 * selection on Tab / Shift-Tab. For each line in [from..to], if it's a
 * collapsible header (>>/^^), pull in its children (deeper-indented body via
 * findBlock) so the header doesn't get detached from its own subtree.
 *
 * Without this: selecting lines 36-37 where line 37 is `>> X` causes the
 * shifted-by-Tab line 37 to become a child of line 36 (visually `^^` stays at
 * indent 0 but is now nested under whatever's above), while its actual body
 * (lines 38+ that were NOT in the selection) stay at the old depth. Tree
 * structure breaks.
 */
function collectAffectedLines(state: EditorState, from: number, to: number): number[] {
  const doc = state.doc
  const startLine = doc.lineAt(from).number
  const endLine = doc.lineAt(to).number
  const lines = new Set<number>()

  for (let i = startLine; i <= endLine; i++) {
    lines.add(i)
    const lineText = doc.line(i).text
    if (collapsiblePattern.test(lineText)) {
      const block = findBlock(doc, i, state.tabSize)
      for (let j = block.startLine; j <= block.endLine; j++) lines.add(j)
    }
  }
  return Array.from(lines).sort((a, b) => a - b)
}

export const tabStopIndent: KeyBinding = {
  key: 'Tab',
  run: (view: EditorView): boolean => {
    const { state } = view
    const step = getTabStep(state)
    const tabSize = state.tabSize
    const sel = state.selection.main

    // Empty cursor on collapsible header → block-aware indent
    if (sel.empty) {
      const line = state.doc.lineAt(sel.head)
      if (collapsiblePattern.test(line.text)) {
        return blockIndent(view)
      }
    }

    // Multi-line selection: expand to include each collapsible header's
    // children so subtrees move as one unit, not just the visible header line.
    if (!sel.empty && state.doc.lineAt(sel.from).number !== state.doc.lineAt(sel.to).number) {
      const affected = collectAffectedLines(state, sel.from, sel.to)
      const changes: { from: number; to: number; insert: string }[] = []
      for (const ln of affected) {
        const line = state.doc.line(ln)
        if (line.text.trim() === '') continue
        const ws = /^\s*/.exec(line.text)![0]
        const cols = countIndentColumns(ws, tabSize)
        const newCols = (Math.floor(cols / step) + 1) * step
        changes.push({ from: line.from, to: line.from + ws.length, insert: makeIndent(newCols) })
      }
      if (changes.length === 0) return true
      const changeSet = state.changes(changes)
      console.log('[TabIndent:Block] multi-line indent with subtree expansion',
        { selFrom: sel.from, selTo: sel.to, affectedCount: affected.length, changes: changes.length })
      view.dispatch({
        changes,
        selection: EditorSelection.range(changeSet.mapPos(sel.anchor, 1), changeSet.mapPos(sel.head, 1)),
        scrollIntoView: true,
        userEvent: 'input.indent'
      })
      return true
    }

    const spec = state.changeByRange(range => {
      const changes: { from: number; to: number; insert: string }[] = []
      let atLine = -1

      for (let pos = range.from; pos <= range.to;) {
        const line = state.doc.lineAt(pos)
        if (line.number > atLine && (range.empty || range.to > line.from)) {
          atLine = line.number
          const ws = /^\s*/.exec(line.text)![0]
          const cols = countIndentColumns(ws, state.tabSize)
          const newCols = (Math.floor(cols / step) + 1) * step
          changes.push({
            from: line.from,
            to: line.from + ws.length,
            insert: makeIndent(newCols)
          })
        }
        pos = line.to + 1
      }

      const changeSet = state.changes(changes)
      return {
        changes,
        range: EditorSelection.range(
          changeSet.mapPos(range.anchor, 1),
          changeSet.mapPos(range.head, 1)
        )
      }
    })

    view.dispatch(spec, { scrollIntoView: true, userEvent: 'input.indent' })
    return true
  },
  shift: (view: EditorView): boolean => {
    const { state } = view
    const step = getTabStep(state)
    const tabSize = state.tabSize
    const sel = state.selection.main

    if (sel.empty) {
      const line = state.doc.lineAt(sel.head)
      if (collapsiblePattern.test(line.text)) {
        return blockOutdent(view)
      }
    }

    // Multi-line: subtree-aware outdent (mirror of Tab path)
    if (!sel.empty && state.doc.lineAt(sel.from).number !== state.doc.lineAt(sel.to).number) {
      const affected = collectAffectedLines(state, sel.from, sel.to)
      const changes: { from: number; to: number; insert: string }[] = []
      for (const ln of affected) {
        const line = state.doc.line(ln)
        if (line.text.trim() === '') continue
        const ws = /^\s*/.exec(line.text)![0]
        const cols = countIndentColumns(ws, tabSize)
        if (cols === 0) continue
        const newCols = Math.max(0, Math.floor((cols - 1) / step) * step)
        changes.push({ from: line.from, to: line.from + ws.length, insert: makeIndent(newCols) })
      }
      if (changes.length === 0) return true
      const changeSet = state.changes(changes)
      console.log('[TabIndent:Block] multi-line outdent with subtree expansion',
        { selFrom: sel.from, selTo: sel.to, affectedCount: affected.length, changes: changes.length })
      view.dispatch({
        changes,
        selection: EditorSelection.range(changeSet.mapPos(sel.anchor, 1), changeSet.mapPos(sel.head, 1)),
        scrollIntoView: true,
        userEvent: 'input.indent'
      })
      return true
    }

    const spec = state.changeByRange(range => {
      const changes: { from: number; to: number; insert: string }[] = []
      let atLine = -1

      for (let pos = range.from; pos <= range.to;) {
        const line = state.doc.lineAt(pos)
        if (line.number > atLine && (range.empty || range.to > line.from)) {
          atLine = line.number
          const ws = /^\s*/.exec(line.text)![0]
          const cols = countIndentColumns(ws, state.tabSize)
          if (cols > 0) {
            const newCols = Math.max(0, Math.floor((cols - 1) / step) * step)
            changes.push({
              from: line.from,
              to: line.from + ws.length,
              insert: makeIndent(newCols)
            })
          }
        }
        pos = line.to + 1
      }

      const changeSet = state.changes(changes)
      return {
        changes,
        range: EditorSelection.range(
          changeSet.mapPos(range.anchor, 1),
          changeSet.mapPos(range.head, 1)
        )
      }
    })

    view.dispatch(spec, { scrollIntoView: true, userEvent: 'input.indent' })
    return true
  },
  preventDefault: true
}

/**
 * Block-aware Cmd+] — indent current line + all deeper children.
 *
 * Empty cursor: finds block (cursor line + deeper children via findBlock),
 * computes delta from cursor line's tab stop snap, applies SAME delta
 * to all lines. Preserves relative indentation within the block.
 *
 * Selection: indent each selected line independently (tab stop snapping per line).
 */
export function blockIndent(view: EditorView): boolean {
  const { state } = view
  const step = getTabStep(state)
  const tabSize = state.tabSize
  const sel = state.selection.main

  if (sel.empty) {
    // Block-aware: uniform delta from cursor line
    const curLine = state.doc.lineAt(sel.head)
    const block = findBlock(state.doc, curLine.number, tabSize)

    const curWs = /^\s*/.exec(curLine.text)![0]
    const curCols = countIndentColumns(curWs, tabSize)
    const newCurCols = (Math.floor(curCols / step) + 1) * step
    const delta = newCurCols - curCols

    const changes: { from: number; to: number; insert: string }[] = []
    for (let i = block.startLine; i <= block.endLine; i++) {
      const line = state.doc.line(i)
      if (line.text.trim() === '') continue
      const ws = /^\s*/.exec(line.text)![0]
      const cols = countIndentColumns(ws, tabSize)
      changes.push({
        from: line.from,
        to: line.from + ws.length,
        insert: makeIndent(cols + delta)
      })
    }

    if (changes.length === 0) return true

    const changeSet = state.changes(changes)
    view.dispatch({
      changes,
      selection: EditorSelection.cursor(changeSet.mapPos(sel.head, 1)),
      scrollIntoView: true,
      userEvent: 'input.indent'
    })
    return true
  }

  // Selection: indent each line independently (tab stop snapping)
  const startLine = state.doc.lineAt(sel.from).number
  const endLine = state.doc.lineAt(sel.to).number

  const changes: { from: number; to: number; insert: string }[] = []
  for (let i = startLine; i <= endLine; i++) {
    const line = state.doc.line(i)
    if (line.text.trim() === '') continue
    const ws = /^\s*/.exec(line.text)![0]
    const cols = countIndentColumns(ws, tabSize)
    const newCols = (Math.floor(cols / step) + 1) * step
    changes.push({
      from: line.from,
      to: line.from + ws.length,
      insert: makeIndent(newCols)
    })
  }

  if (changes.length === 0) return true

  const changeSet = state.changes(changes)
  view.dispatch({
    changes,
    selection: EditorSelection.range(changeSet.mapPos(sel.anchor, 1), changeSet.mapPos(sel.head, 1)),
    scrollIntoView: true,
    userEvent: 'input.indent'
  })
  return true
}

/**
 * Block-aware Cmd+[ — outdent current line + all deeper children.
 *
 * Empty cursor: computes delta from cursor line's tab stop snap.
 * If cursor line is already at indent 0 → delta=0 → nothing moves (block stays intact).
 * Otherwise applies SAME delta to all lines, clamping at 0.
 *
 * Selection: outdent each selected line independently (tab stop snapping per line).
 */
export function blockOutdent(view: EditorView): boolean {
  const { state } = view
  const step = getTabStep(state)
  const tabSize = state.tabSize
  const sel = state.selection.main

  if (sel.empty) {
    // Block-aware: uniform delta from cursor line
    const curLine = state.doc.lineAt(sel.head)
    const block = findBlock(state.doc, curLine.number, tabSize)

    const curWs = /^\s*/.exec(curLine.text)![0]
    const curCols = countIndentColumns(curWs, tabSize)

    // Can't outdent: cursor line at indent 0 → nothing moves
    if (curCols === 0) return true

    const newCurCols = Math.max(0, Math.floor((curCols - 1) / step) * step)
    const delta = newCurCols - curCols // negative

    const changes: { from: number; to: number; insert: string }[] = []
    for (let i = block.startLine; i <= block.endLine; i++) {
      const line = state.doc.line(i)
      if (line.text.trim() === '') continue
      const ws = /^\s*/.exec(line.text)![0]
      const cols = countIndentColumns(ws, tabSize)
      const newCols = Math.max(0, cols + delta)
      if (newCols !== cols) {
        changes.push({
          from: line.from,
          to: line.from + ws.length,
          insert: makeIndent(newCols)
        })
      }
    }

    if (changes.length === 0) return true

    const changeSet = state.changes(changes)
    view.dispatch({
      changes,
      selection: EditorSelection.cursor(changeSet.mapPos(sel.head, 1)),
      scrollIntoView: true,
      userEvent: 'input.indent'
    })
    return true
  }

  // Selection: outdent each line independently (tab stop snapping)
  const startLine = state.doc.lineAt(sel.from).number
  const endLine = state.doc.lineAt(sel.to).number

  const changes: { from: number; to: number; insert: string }[] = []
  for (let i = startLine; i <= endLine; i++) {
    const line = state.doc.line(i)
    if (line.text.trim() === '') continue
    const ws = /^\s*/.exec(line.text)![0]
    const cols = countIndentColumns(ws, tabSize)
    if (cols > 0) {
      const newCols = Math.max(0, Math.floor((cols - 1) / step) * step)
      changes.push({
        from: line.from,
        to: line.from + ws.length,
        insert: makeIndent(newCols)
      })
    }
  }

  if (changes.length === 0) return true

  const changeSet = state.changes(changes)
  view.dispatch({
    changes,
    selection: EditorSelection.range(changeSet.mapPos(sel.anchor, 1), changeSet.mapPos(sel.head, 1)),
    scrollIntoView: true,
    userEvent: 'input.indent'
  })
  return true
}
