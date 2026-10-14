import { EditorView } from '@codemirror/view'
import { foldedRanges } from '@codemirror/language'
import { EditorSelection } from '@codemirror/state'

/**
 * Push the cursor out of fold-replaced regions on click.
 *
 * Why this exists:
 * `codeFolding()` uses `Decoration.replace({ inclusive: true })`. A cursor
 * positioned at `fold.from` or `fold.to` is considered INSIDE the fold and
 * its DOM node is removed from `.cm-cursorLayer` — the blinking cursor
 * disappears, even though `EditorState.selection` is valid and typing
 * still mutates the document.
 *
 * Reproducible case: file ends with a folded `^^` block. User clicks in
 * the empty area below the last visible line. CM6's `posAtCoords` snaps
 * to `doc.length`, which equals `fold.to`. Cursor lands inside the
 * inclusive replace → invisible.
 *
 * Fix policy (after CM6 sets the selection via setTimeout 0 — direct
 * `view.dispatch` during `update()` is forbidden):
 *   - If cursor sits inside a fold AND the fold reaches doc end → append
 *     `\n` and put cursor on the new line. Stable visible landing past the
 *     fold, matches the "click below last line" intent.
 *   - If cursor sits inside a fold mid-document → move cursor to the END
 *     of the line just BEFORE the header (always outside the inclusive
 *     replace). Mid-doc folds usually have content above; the user's
 *     intent was "somewhere near here", and landing on the header line
 *     start would jump too far up.
 *
 * setTimeout(0) is the documented escape hatch — same as createConcealClickFix.
 */
export const cursorOutOfFoldPlugin = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || event.shiftKey || event.altKey) return false

    setTimeout(() => {
      const { state } = view
      const sel = state.selection.main
      if (!sel.empty) return

      const pos = sel.head

      // Special case kept from the original plugin: when the user clicks past
      // the visible content of a doc whose tail is folded, posAtCoords snaps to
      // doc.length. doc.length equals fold.to for the trailing fold, and there
      // is no visible line below the fold to land on — append a blank line and
      // move the cursor onto it. This is the ONLY case where pos === fold.to
      // is genuinely "nowhere to go visually". Mid-doc fold.to has the next
      // visible line right after it (line at fold.to + 0 chars = start of
      // next line in the doc), so we leave such positions alone.
      if (pos === state.doc.length) {
        let trailingFold: { from: number; to: number } | null = null
        foldedRanges(state).between(pos, pos, (from, to) => {
          if (to >= pos) trailingFold = { from, to }
        })
        if (trailingFold) {
          const insertPos = state.doc.length
          view.dispatch({
            changes: { from: insertPos, insert: '\n' },
            selection: EditorSelection.cursor(insertPos + 1),
            scrollIntoView: true,
          })
          return
        }
      }

      // STRICTLY-INSIDE check (pos > from && pos < to). Previously this was
      // `pos >= from && pos <= to` based on an older CM6 version where
      // codeFolding used `Decoration.replace({ inclusive: true })` — back then
      // a cursor sitting on the boundary did get visually swallowed by the
      // replace zone, and we had to nudge it one char inward. In the current
      // @codemirror/view, `Decoration.replace({ widget })` defaults to
      // non-inclusive — the POSITION is outside the range, but the CURSOR
      // RENDERER (RectangleMarker.forRange) calls
      // `coordsAtPos(head, range.assoc || 1)` and the `|| 1` defaults to
      // RIGHT-side probing, which lands INSIDE the hidden widget → coords
      // null → cursor DOM never created → user sees no caret.
      let containing: { from: number; to: number } | null = null
      let onBoundary: { from: number; to: number } | null = null
      foldedRanges(state).between(pos, pos, (from, to) => {
        if (pos > from && pos < to) containing = { from, to }
        else if (pos === from || pos === to) onBoundary = { from, to }
      })

      // Strictly-inside: nudge to a safe visible spot. Rare patho case.
      if (containing) {
        const c = containing as { from: number; to: number }
        const headerLine = state.doc.lineAt(c.from)
        const safe = Math.max(headerLine.from, headerLine.to - 1)
        console.log('[CursorOutOfFold] strictly-inside fold, nudging',
          { pos, foldFrom: c.from, foldTo: c.to, safe })
        view.dispatch({
          selection: EditorSelection.cursor(safe, -1),
        })
        return
      }

      // On boundary: re-establish the assoc that points to the VISIBLE side.
      // Asymmetric — same logic as foldBoundaryAssocFix transactionFilter:
      //   pos === fold.from → probe LEFT (assoc=-1), header line is visible
      //   pos === fold.to   → probe RIGHT (assoc=+1), next line is visible
      // Earlier this hardcoded assoc=-1 for both sides, which broke clicks
      // landing exactly on fold.to (the rendererProbe at pos-1 looks INTO
      // the display:none widget → null coords → invisible cursor).
      if (onBoundary) {
        const b = onBoundary as { from: number; to: number }
        const isFrom = pos === b.from
        const desiredAssoc = isFrom ? -1 : 1
        const currentAssoc = (sel as any).assoc ?? 0
        const needsFix = isFrom ? currentAssoc >= 0 : currentAssoc < 0
        if (needsFix) {
          console.log('[CursorOutOfFold] on boundary, pinning assoc',
            { pos, foldFrom: b.from, foldTo: b.to, side: isFrom ? 'from' : 'to', currentAssoc, desiredAssoc })
          view.dispatch({
            selection: EditorSelection.cursor(pos, desiredAssoc),
          })
        }
      }
    }, 0)

    return false
  },
})
