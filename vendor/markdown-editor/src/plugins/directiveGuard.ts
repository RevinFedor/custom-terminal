/**
 * Returns true if the line is meant to be treated as a directive
 * (<!-- @ai|@include|@embedding|@link -->), not as a literal example inside
 * inline code (`...`) or a code block (```).
 *
 * Logic:
 * - If the line is wholly inside a fenced code block — skip directive parsing.
 * - If the directive substring is wrapped by single/double/triple backticks
 *   somewhere on the line — skip.
 *
 * Used by frontmatterProtocol, includeLink, embeddingLink, linkProtocol,
 * anchorLink to avoid accidentally rendering documentation examples as real
 * widgets.
 */

import { EditorState } from '@codemirror/state'

const fenceLinePattern = /^([ \t]*)(`{3,}|~{3,})(.*)$/

function indentColumn(indentText: string, tabSize: number): number {
  let col = 0
  for (const ch of indentText) col += ch === '\t' ? tabSize - (col % tabSize) : 1
  return col
}

function lineIndentColumn(text: string, tabSize: number): number {
  const match = text.match(/^([ \t]*)/)
  return indentColumn(match ? match[1] : '', tabSize)
}

interface FenceMarker {
  lineNum: number
  indentColumn: number
  markerChar: string
  markerLen: number
  canOpen: boolean
  canClose: boolean
}

function parseFenceMarker(lineNum: number, text: string, tabSize: number): FenceMarker | null {
  const match = text.match(fenceLinePattern)
  if (!match) return null

  const info = (match[3] || '').trim()
  return {
    lineNum,
    indentColumn: indentColumn(match[1], tabSize),
    markerChar: match[2][0],
    markerLen: match[2].length,
    canOpen: info === '' || /^[A-Za-z0-9_-]+$/.test(info),
    canClose: info === '',
  }
}

/**
 * Build a Set of line numbers that are inside fenced code blocks.
 * One linear pass over the document. Use this when the caller iterates
 * many lines (anchorLink, linkIcon) — much cheaper than calling
 * isInFencedCodeBlock() per line, which is O(N²).
 */
export function buildFencedLineSet(state: EditorState): Set<number> {
  const set = new Set<number>()
  const doc = state.doc
  const tabSize = state.tabSize
  let pending: FenceMarker | null = null
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const marker = parseFenceMarker(i, line.text, tabSize)
    if (!marker) continue

    if (!pending) {
      if (marker.canOpen) pending = marker
      continue
    }

    const closesPending =
      marker.canClose &&
      marker.markerChar === pending.markerChar &&
      marker.markerLen === pending.markerLen &&
      marker.indentColumn === pending.indentColumn

    if (closesPending) {
      for (let lineNum = pending.lineNum + 1; lineNum < marker.lineNum; lineNum++) {
        const bodyLine = doc.line(lineNum)
        const text = bodyLine.text
        if (text.trim() === '' || lineIndentColumn(text, tabSize) >= pending.indentColumn) {
          set.add(lineNum)
        }
      }
      pending = null
      continue
    }

    // Mismatched fence marker invalidates the pending opener; the new marker may
    // start a later block, but the previous one is not a working fenced block.
    pending = marker.canOpen ? marker : null
  }
  return set
}

/**
 * Check whether the given line index is inside a fenced code block (``` ... ```).
 * Tracks open/close fences from line 1 up to the target line.
 *
 * NOTE: O(N) per call. If you need this for many lines in one pass,
 * use `buildFencedLineSet` instead.
 */
export function isInFencedCodeBlock(state: EditorState, lineNumber: number): boolean {
  return buildFencedLineSet(state).has(lineNumber)
}

/**
 * Returns true if the line text contains the directive AND the directive
 * is wrapped in backticks (inline code).
 *
 * Example matches (returns true → ignore the directive):
 *   - "see `<!-- @ai: ... -->` for details"
 *   - "the `<!-- @include: ./x.md -->` macro"
 *
 * Returns false (treat as real directive) when there are no backticks
 * around the directive on the same line.
 */
export function isDirectiveInsideBacktick(lineText: string, directiveStart: string): boolean {
  // directiveStart e.g. "<!-- @ai:" or "<!-- @include:"
  const idx = lineText.indexOf(directiveStart)
  if (idx === -1) return false
  // Count backticks before the directive on this line.
  // Odd count means we are inside an open inline code span.
  let backticks = 0
  for (let i = 0; i < idx; i++) {
    if (lineText[i] === '`') backticks++
  }
  return backticks % 2 === 1
}

/**
 * Returns true if a substring at `startIdx` in `lineText` is wrapped in
 * backticks (inline code). Generic version of isDirectiveInsideBacktick
 * for cases where the marker isn't a fixed string (e.g. anchorLink scans
 * arbitrary [text](#anchor) positions).
 */
export function isPositionInsideInlineCode(lineText: string, startIdx: number): boolean {
  if (startIdx <= 0) return false
  let backticks = 0
  for (let i = 0; i < startIdx; i++) {
    if (lineText[i] === '`') backticks++
  }
  return backticks % 2 === 1
}
