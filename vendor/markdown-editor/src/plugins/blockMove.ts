import { EditorView } from '@codemirror/view'
import { EditorSelection, type Text } from '@codemirror/state'
import { foldedRanges, foldEffect, foldable } from '@codemirror/language'

/**
 * Block-aware move: Alt+Up/Down moves the entire block (line + deeper-indented children)
 * instead of a single line.
 *
 * Algorithm:
 * 1. Find the block under cursor: cursorLine + all lines below with deeper indent
 * 2. Determine target to swap with:
 *    - Empty line above/below → swap block with single line
 *    - Line with indent < baseIndent (parent) → swap block with single line (exits parent)
 *    - Line with indent >= baseIndent → find sibling block, swap entire blocks
 */

// ─── Indent helper (same logic as collapsibleFold.ts) ───────────────────────

/** Count visual indent columns. Tabs expand to tabSize (default 4). */
function countIndent(text: string, tabSize: number): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 9) n += tabSize - (n % tabSize) // Tab
    else if (code === 32) n++ // Space
    else break
  }
  return n
}

// ─── Block detection ────────────────────────────────────────────────────────

export interface BlockRange {
  startLine: number
  endLine: number
}

/**
 * Find the block starting at `lineNumber`.
 * Block = the line itself + all subsequent lines with deeper indentation.
 * Trailing empty lines are NOT included.
 * Internal empty lines (followed by deeper content) ARE included.
 */
export function findBlock(doc: Text, lineNumber: number, tabSize: number): BlockRange {
  const line = doc.line(lineNumber)
  const baseIndent = countIndent(line.text, tabSize)

  let lastContentLine = lineNumber

  for (let i = lineNumber + 1; i <= doc.lines; i++) {
    const nextText = doc.line(i).text

    // Empty line: keep scanning (don't commit as block end)
    if (nextText.trim() === '') continue

    const nextIndent = countIndent(nextText, tabSize)

    if (nextIndent > baseIndent) {
      // Deeper indentation → part of this block
      lastContentLine = i
    } else {
      // Same or less indentation → block ended
      break
    }
  }

  return { startLine: lineNumber, endLine: lastContentLine }
}

// ─── Sibling detection ──────────────────────────────────────────────────────

/**
 * Scan upward from `blockStartLine - 1` to find the previous sibling block.
 * A sibling is a non-empty line with indent == baseIndent.
 * Lines with indent > baseIndent are children of the sibling.
 * Empty lines are skipped.
 *
 * Returns { startLine, endLine } of the sibling block, or null if no sibling
 * (hit a parent line with indent < baseIndent, or start of document).
 *
 * Note: endLine = blockStartLine - 1 (everything between sibling header and our block).
 */
function findPreviousSibling(
  doc: Text, blockStartLine: number, baseIndent: number, tabSize: number
): BlockRange | null {
  if (blockStartLine <= 1) return null

  const siblingEnd = blockStartLine - 1

  for (let i = blockStartLine - 1; i >= 1; i--) {
    const text = doc.line(i).text

    if (text.trim() === '') continue // skip empty lines

    const indent = countIndent(text, tabSize)

    if (indent === baseIndent) {
      // Found sibling header
      return { startLine: i, endLine: siblingEnd }
    } else if (indent > baseIndent) {
      // Child of the sibling — keep scanning up
      continue
    } else {
      // indent < baseIndent → hit parent boundary
      return null
    }
  }

  return null // reached start of document
}

// ─── Swap helper ────────────────────────────────────────────────────────────

/**
 * Swap two adjacent text ranges in the document.
 * `upper` is above `lower` in the document. They must be adjacent
 * (upper.endLine + 1 == lower.startLine is guaranteed by the algorithm).
 */
function swapBlocks(
  view: EditorView,
  upper: BlockRange,
  lower: BlockRange,
  cursor: number,
  /** Which block the cursor belongs to: 'upper' or 'lower' */
  cursorBlock: 'upper' | 'lower',
  /**
   * Optional selection to preserve across the swap. If passed, both anchor and
   * head are re-mapped to the new positions (so a multi-line selection
   * continues to cover the moved block — required for repeated Cmd+↑/↓ to
   * keep working on the same logical range).
   */
  preserveSelection?: { anchor: number; head: number }
): void {
  const doc = view.state.doc

  const upperFrom = doc.line(upper.startLine).from
  const upperTo = doc.line(upper.endLine).to
  const lowerFrom = doc.line(lower.startLine).from
  const lowerTo = doc.line(lower.endLine).to

  const upperText = doc.sliceString(upperFrom, upperTo)
  const lowerText = doc.sliceString(lowerFrom, lowerTo)

  // New text: lower first, then upper
  const newText = lowerText + '\n' + upperText

  /**
   * Re-map a position from old doc → new doc after the swap.
   * Positions inside the cursor's own block shift by the height of the OTHER
   * block (± its char count + 1 for the joining \n). Positions outside the
   * swapped region stay put.
   */
  const lowerTextLen = lowerTo - lowerFrom
  const upperTextLen = upperTo - upperFrom
  const remap = (p: number): number => {
    if (cursorBlock === 'lower') {
      // Cursor's block was the LOWER one, moves UP to upperFrom
      if (p >= lowerFrom && p <= lowerTo) return upperFrom + (p - lowerFrom)
      // Anything in the upper block shifts down by (lowerTextLen + 1)
      if (p >= upperFrom && p <= upperTo) return p + lowerTextLen + 1
      return p
    } else {
      // Cursor's block was the UPPER one, moves DOWN
      if (p >= upperFrom && p <= upperTo) return upperFrom + lowerTextLen + 1 + (p - upperFrom)
      if (p >= lowerFrom && p <= lowerTo) return upperFrom + (p - lowerFrom)
      return p
    }
  }

  // Clamp helper for the new doc length
  const newDocLen = view.state.doc.length - (lowerTo - upperFrom) + newText.length
  const clamp = (p: number): number => Math.max(0, Math.min(p, newDocLen))

  // Build the selection to dispatch
  let dispatchSelection: any
  if (preserveSelection) {
    const newAnchor = clamp(remap(preserveSelection.anchor))
    const newHead = clamp(remap(preserveSelection.head))
    dispatchSelection = EditorSelection.range(newAnchor, newHead)
  } else {
    const newCursorPos = clamp(remap(cursor))
    dispatchSelection = EditorSelection.cursor(newCursorPos)
  }

  view.dispatch({
    changes: { from: upperFrom, to: lowerTo, insert: newText },
    selection: dispatchSelection
  })

  // newCursorPos for downstream logging / scrollIntoView (use head)
  const newCursorPos = preserveSelection
    ? clamp(remap(preserveSelection.head))
    : clamp(remap(cursor))

  // Re-fold ^^ markers synchronously to prevent visual flash of expanded content.
  // The swap dispatch destroys fold ranges (CM remaps them to zero-length).
  // autoFoldCollapsedMarkers would re-fold via setTimeout(0), but that allows
  // a paint frame with expanded content between dispatches.
  // Two synchronous dispatches → one paint → no flash.
  refoldCollapsedMarkers(view, upperFrom, lowerTo)

  // Scroll policy: only nudge viewport when the cursor would otherwise be
  // outside the visible area. CM6's scrollIntoView with default y="nearest"
  // does exactly that — keeps scrollTop unchanged while the cursor is in view,
  // bumps by ~1 line when it isn't. No scroll-pinning ("cursor glued to a
  // fixed screen Y") — viewport stays still as the block walks past it.
  // Dispatched after refold so height calculations use the post-fold layout.
  console.log('[BlockMove:Scroll] scrollIntoView (nearest)',
    { newCursorPos, cursorBlock, savedScrollTopBefore: view.scrollDOM.scrollTop })
  view.dispatch({
    effects: EditorView.scrollIntoView(newCursorPos)
  })
}

// ─── Re-fold helper ─────────────────────────────────────────────────────────

/**
 * Synchronously re-fold ^^ markers in the affected range after a swap dispatch.
 *
 * The swap replaces the entire [from..to] range, which destroys CM6 fold ranges
 * (ChangeDesc.mapPos collapses positions inside the replaced range to a single point).
 * collapsibleArrowPlugin.autoFoldCollapsedMarkers would re-fold via setTimeout(0),
 * but between the dispatch and the setTimeout callback the browser paints a frame
 * with expanded content — causing the visual flash.
 *
 * By dispatching fold effects synchronously here (after the swap dispatch but
 * before returning to the event loop), the browser only paints ONCE with folds
 * already restored. No flash.
 */
function refoldCollapsedMarkers(view: EditorView, from: number, to: number): void {
  const doc = view.state.doc
  const startLine = doc.lineAt(from).number
  const endLine = doc.lineAt(Math.min(to, doc.length)).number
  const effects: any[] = []

  for (let i = startLine; i <= endLine; i++) {
    const line = doc.line(i)
    if (!line.text.trim().startsWith('^^')) continue

    // Check if already folded (shouldn't be after full-range swap, but be safe)
    let isFolded = false
    foldedRanges(view.state).between(line.from, line.to, () => {
      isFolded = true
    })

    if (!isFolded) {
      const range = foldable(view.state, line.from, line.to)
      if (range && (range.to - range.from) > 2) {
        effects.push(foldEffect.of(range))
      }
    }
  }

  if (effects.length > 0) {
    view.dispatch({ effects })
  }
}

// ─── Commands ───────────────────────────────────────────────────────────────

/**
 * Resolve the block to move when the user has a multi-line selection.
 * Without this, a 5-line selection only moves the head line's block — the
 * other 4 stay behind, breaking the user's mental model of "move the lines
 * I selected as one unit".
 *
 * Strategy: take the selection's [fromLine..toLine] span verbatim and then
 * extend the lower edge by the children of the last selected line (so a
 * collapsible/list parent at the bottom keeps its body attached). The upper
 * edge is NOT extended — selecting from line 5 means "5", not "the parent of 5".
 *
 * baseIndent of the resulting block = indent of the FIRST line of the span
 * (used by swap logic to detect parent/sibling relationships above/below).
 */
function resolveSelectionBlock(
  doc: Text,
  sel: { from: number; to: number },
  tabSize: number
): { block: BlockRange; baseIndent: number } {
  const fromLine = doc.lineAt(sel.from)
  const toLine = doc.lineAt(sel.to)

  // Single-line selection: keep legacy behavior (block = findBlock from cursor)
  if (fromLine.number === toLine.number) {
    const block = findBlock(doc, fromLine.number, tabSize)
    return { block, baseIndent: countIndent(fromLine.text, tabSize) }
  }

  // Multi-line: span = fromLine..toLine, extend bottom with last line's children
  const tailBlock = findBlock(doc, toLine.number, tabSize)
  const block: BlockRange = {
    startLine: fromLine.number,
    endLine: Math.max(toLine.number, tailBlock.endLine)
  }
  const baseIndent = countIndent(fromLine.text, tabSize)
  return { block, baseIndent }
}

/** Move the block under cursor UP (Alt+ArrowUp). */
export function moveBlockUp(view: EditorView): boolean {
  const { state } = view
  const doc = state.doc
  const tabSize = state.tabSize
  const sel = state.selection.main
  const cursor = sel.head

  const { block, baseIndent } = resolveSelectionBlock(doc, sel, tabSize)

  // Preserve multi-line selection across the swap; single-line stays as cursor.
  const preserve = !sel.empty && doc.lineAt(sel.from).number !== doc.lineAt(sel.to).number
    ? { anchor: sel.anchor, head: sel.head }
    : undefined

  // Can't move past start of document
  if (block.startLine <= 1) {
    return false
  }

  const aboveLine = doc.line(block.startLine - 1)

  // Case 1: Empty line above → single line swap
  if (aboveLine.text.trim() === '') {
    swapBlocks(view,
      { startLine: aboveLine.number, endLine: aboveLine.number },
      block,
      cursor,
      'lower',
      preserve
    )
    return true
  }

  const aboveIndent = countIndent(aboveLine.text, tabSize)

  // Case 2: Parent line above (less indent) → single line swap, block exits parent
  if (aboveIndent < baseIndent) {
    swapBlocks(view,
      { startLine: aboveLine.number, endLine: aboveLine.number },
      block,
      cursor,
      'lower',
      preserve
    )
    return true
  }

  // Case 3: Sibling or child of sibling above → find sibling block
  const sibling = findPreviousSibling(doc, block.startLine, baseIndent, tabSize)

  if (sibling) {
    swapBlocks(view, sibling, block, cursor, 'lower', preserve)
    return true
  }

  // No sibling found (e.g. orphan deeper line above) → single line swap
  swapBlocks(view,
    { startLine: aboveLine.number, endLine: aboveLine.number },
    block,
    cursor,
    'lower',
    preserve
  )
  return true
}

/** Move the block under cursor DOWN (Alt+ArrowDown). */
export function moveBlockDown(view: EditorView): boolean {
  const { state } = view
  const doc = state.doc
  const tabSize = state.tabSize
  const sel = state.selection.main
  const cursor = sel.head

  const { block, baseIndent } = resolveSelectionBlock(doc, sel, tabSize)

  const preserve = !sel.empty && doc.lineAt(sel.from).number !== doc.lineAt(sel.to).number
    ? { anchor: sel.anchor, head: sel.head }
    : undefined

  // Can't move past end of document
  if (block.endLine >= doc.lines) {
    return false
  }

  const belowLine = doc.line(block.endLine + 1)

  // Case 1: Empty line below → single line swap
  if (belowLine.text.trim() === '') {
    swapBlocks(view,
      block,
      { startLine: belowLine.number, endLine: belowLine.number },
      cursor,
      'upper',
      preserve
    )
    return true
  }

  const belowIndent = countIndent(belowLine.text, tabSize)

  // Case 2: Parent boundary below (less indent) → single line swap
  if (belowIndent < baseIndent) {
    swapBlocks(view,
      block,
      { startLine: belowLine.number, endLine: belowLine.number },
      cursor,
      'upper',
      preserve
    )
    return true
  }

  // Case 3: Sibling below (same indent) → find its full block, swap
  if (belowIndent === baseIndent) {
    const siblingBlock = findBlock(doc, belowLine.number, tabSize)
    swapBlocks(view, block, siblingBlock, cursor, 'upper', preserve)
    return true
  }

  // Case 4: Deeper indent below (shouldn't happen — would be in our block)
  // Fallback: single line swap
  swapBlocks(view,
    block,
    { startLine: belowLine.number, endLine: belowLine.number },
    cursor,
    'upper',
    preserve
  )
  return true
}
