import { EditorState, StateEffect } from '@codemirror/state'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Table, TableCell } from 'mdast'
import { buildFencedLineSet } from './directiveGuard'

export interface MarkdownTableCell {
  node: TableCell
  from: number
}

export interface MarkdownTable {
  from: number
  to: number
  source: string
  indent: number
  align: Table['align']
  rows: MarkdownTableCell[][]
  lines: { from: number; removed: number; padding: number }[]
}

export const editMarkdownTable = StateEffect.define<{ from: number; to: number } | null>()

export function tableSourcePosition(table: MarkdownTable, point: { line: number; column: number }) {
  const line = table.lines[point.line - 1]
  return line.from + line.removed + point.column - 1 - line.padding
}

function indentation(text: string, tabSize: number) {
  let columns = 0, chars = 0
  while (chars < text.length && (text[chars] === ' ' || text[chars] === '\t')) {
    columns += text[chars] === '\t' ? tabSize - columns % tabSize : 1
    chars++
  }
  return { columns, chars }
}

function removeIndent(text: string, columns: number, tabSize: number) {
  let removed = 0, reached = 0
  while (reached < columns && removed < text.length) {
    if (text[removed] !== ' ' && text[removed] !== '\t') break
    reached += text[removed] === '\t' ? tabSize - reached % tabSize : 1
    removed++
  }
  const padding = Math.max(0, reached - columns)
  return { text: ' '.repeat(padding) + text.slice(removed), removed, padding }
}

/** Candidate blocks are dedented for GFM, then every cell maps back to the
 * unchanged CM document. GT's tab-indented sections are not indented code. */
export function parseMarkdownTables(state: EditorState): MarkdownTable[] {
  const doc = state.doc, tables: MarkdownTable[] = []
  if (!doc.toString().includes('|')) return tables
  const fenced = buildFencedLineSet(state)
  for (let lineNumber = 1; lineNumber < doc.lines; lineNumber++) {
    const header = doc.line(lineNumber), delimiter = doc.line(lineNumber + 1)
    if (fenced.has(lineNumber) || fenced.has(lineNumber + 1) || !header.text.includes('|')) continue
    if (!delimiter.text.includes('-') || !/^[\s|:-]+$/.test(delimiter.text)) continue
    const indent = indentation(header.text, state.tabSize).columns
    if (indentation(delimiter.text, state.tabSize).columns < indent) continue
    const lines: { from: number; text: string; removed: number; padding: number }[] = []
    for (let number = lineNumber; number <= doc.lines; number++) {
      const line = doc.line(number)
      if (!line.text.trim() || fenced.has(number) || indentation(line.text, state.tabSize).columns < indent) break
      lines.push({ from: line.from, ...removeIndent(line.text, indent, state.tabSize) })
    }
    const tree = fromMarkdown(lines.map(line => line.text).join('\n'), {
      extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()],
    })
    const node = tree.children[0]
    if (node?.type !== 'table' || !node.position) continue
    const lastNumber = lineNumber + node.position.end.line - 1
    const to = doc.line(lastNumber).to
    tables.push({
      from: header.from, to, indent,
      source: doc.sliceString(header.from, to), align: node.align,
      lines: lines.slice(0, node.position.end.line).map(({ from, removed, padding }) => ({ from, removed, padding })),
      rows: node.children.map(row => row.children.map(cell => {
        const point = cell.children[0]?.position?.start ?? cell.position!.start
        const line = lines[point.line - 1]
        return { node: cell, from: line.from + line.removed + point.column - 1 - line.padding }
      })),
    })
    lineNumber = lastNumber
  }
  return tables
}
