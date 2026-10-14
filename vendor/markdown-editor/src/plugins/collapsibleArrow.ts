import { ViewPlugin, Decoration, DecorationSet, EditorView, keymap } from '@codemirror/view'
import { Prec, EditorSelection, EditorState } from '@codemirror/state'
import { foldedRanges, foldEffect, unfoldEffect, foldable } from '@codemirror/language'
import { invertedEffects } from '@codemirror/commands'
import { CollapsibleArrowWidget, CollapsibleLineCountWidget } from '../widgets'

/**
 * Fold boundary assoc fixer (Pattern B from the Anthropic Claude research,
 * 2026-05-18, id rbgmqqj4lmpb1yin7).
 *
 * Problem
 * -------
 * Our codeFolding placeholder is `display:none`. When the cursor lands on
 * `fold.from` (start of a Decoration.replace widget), the renderer
 * `RectangleMarker.forRange` calls
 *     view.coordsAtPos(range.head, range.assoc || 1)
 * — and `range.assoc || 1` defaults to +1 whenever assoc is 0 (the default
 * for `EditorSelection.cursor(pos)` without an explicit assoc, AND the
 * default for selections that come out of CM6's own click handler). Probing
 * +1 (right) of fold.from lands inside the hidden widget DOM, browser returns
 * no client rect, `coordsAtPos` returns null, the cursor DOM node is never
 * appended to `.cm-cursorLayer`. The selection itself is valid (typing
 * mutates the doc), but the caret doesn't blink — the user sees nothing.
 *
 * Why a transactionFilter and not just per-handler EditorSelection.cursor(p, -1)
 * ----------------------------------------------------------------------------
 * Our Backspace/ArrowDown handlers can build selections with explicit assoc=-1
 * (and they do). But the click path goes through CM6's default mousedown →
 * `mouseSelection.update` → `EditorSelection.cursor(pos)` with no assoc.
 * Every selection that lands on fold.from from a non-instrumented entry point
 * has assoc=0 and the cursor disappears. A `transactionFilter` runs after
 * EVERY transaction's selection is built but before it's applied, so it
 * catches click, keyboard navigation, programmatic dispatches from third-
 * party plugins, undo/redo — everything. ~15 LOC, no perf cost when there
 * are no folds.
 *
 * Why fold.from specifically (and not also fold.to)
 * -------------------------------------------------
 * For `pos === fold.to`, probing +1 lands at the START of the next visible
 * line, which always has a DOM element with real coords → coordsAtPos
 * returns valid geometry → cursor renders. fold.from is the only direction
 * where +1 lands inside the hidden widget. Verified by the same research:
 * "When range.assoc = -1, RectangleMarker.forRange invokes coordsAtPos(pos,
 * -1), which asks for the rect of the element BEFORE the position. At
 * pos === fold.from, that element is the last visible character on the line
 * — its rect is well-defined."
 *
 * Why not auto-unfold instead
 * ---------------------------
 * @codemirror/language's foldState auto-unfolds on `a < head && b > head`
 * (strict-inside). The boundary cases `head == a` and `head == b` are
 * intentionally NOT auto-unfolded — that's by design (the user should be
 * able to place the cursor adjacent to a fold). So we have to fix
 * rendering, not collapse the fold.
 */
export const foldBoundaryAssocFix = EditorState.transactionFilter.of(tr => {
  // Selection or doc-change path matters: the bug fires both on pure
  // selection moves AND on text changes that shift fold endpoints into the
  // new head position (e.g. typing a space exactly at fold.from — the insert
  // pushes fold.from → fold.from+1, head also lands at the new fold.from+1,
  // and we need assoc=-1 again on that fresh boundary).
  const needsCheck = !!tr.selection || tr.docChanged
  if (!needsCheck) return tr

  // POST-mapping fold ranges. The naive `foldedRanges(tr.startState)` reflects
  // PRE-transaction positions, so when a transaction both inserts text AND
  // moves the cursor, we'd compare the new head against stale fold endpoints
  // and miss the case where the insert shifted fold.from to the new head.
  // We rebuild the fold range list by mapping each pre-fold {from, to} through
  // tr.changes with the SAME bias as foldState's stored sides (startSide
  // positive → mapPos +1, endSide negative → mapPos -1).
  const preFolds = foldedRanges(tr.startState)
  const postFolds: { from: number; to: number }[] = []
  preFolds.between(0, tr.startState.doc.length, (from, to) => {
    postFolds.push({
      from: tr.changes.mapPos(from, 1),
      to: tr.changes.mapPos(to, -1)
    })
  })

  // Selection after this transaction is applied. If tr.selection is null,
  // CM6 keeps the prior selection mapped through tr.changes — re-derive it.
  const selection = tr.selection ?? tr.startState.selection.map(tr.changes)

  let touched = false
  let skipReason = ''
  let forcedAssoc = 0
  let branch = ''
  let posShift = 0
  let needAppendNewline = false
  const doc = tr.state.doc
  const docLen = doc.length
  const newRanges = selection.ranges.map(r => {
    if (!r.empty) {
      skipReason = 'not-empty'
      return r
    }
    const onBoundaryFrom = postFolds.some(f => f.from === r.head)
    const onBoundaryTo = postFolds.some(f => f.to === r.head)
    if (!onBoundaryFrom && !onBoundaryTo) {
      skipReason = `not-on-boundary head=${r.head} foldStarts=[${postFolds.map(f => f.from).join(',')}] foldEnds=[${postFolds.map(f => f.to).join(',')}]`
      return r
    }
    // Two-stage fix:
    //   Stage 1 — assoc fix. For boundary positions where the adjacent visible
    //   char exists, just bias assoc toward the visible side and the cursor
    //   renderer is happy.
    //   Stage 2 — position shift. There are layouts where the fold endpoint
    //   sits at the END of a hidden line (fold.to == \n of the last folded
    //   line). In that case the line containing fold.to is ITSELF entirely
    //   hidden, and `coordsAtPos(fold.to, ±1)` returns null for every assoc
    //   because neither side has rendered text. The only fix is to shift the
    //   position past the boundary: fold.from → fold.from - 1 (end of header
    //   line which is visible), fold.to → fold.to + 1 (first char of next
    //   visible line). We detect this by computing the line of `head`: if it
    //   lies entirely inside the fold range, no assoc can save us.
    // A line is fully hidden iff there is a fold range whose [from,to]
    // covers [lineAtHead.from, lineAtHead.to]. When the cursor lands on
    // such a line's boundary, no assoc works — `coordsAtPos(pos, ±1)`
    // returns null for every direction because the entire line is inside
    // the replace decoration.
    const lineAtHead = doc.lineAt(r.head)
    const lineFullyHidden = postFolds.some(f =>
      f.from <= lineAtHead.from && f.to >= lineAtHead.to
    )

    if (onBoundaryFrom) {
      branch = 'from'
      if (lineFullyHidden) {
        // pos at fold.from but the header line is somehow hidden too — shift
        // back one char. Should be rare; fold.from is normally end of header.
        const shifted = Math.max(0, r.head - 1)
        if (shifted !== r.head) {
          touched = true
          posShift = -1
          return EditorSelection.cursor(shifted, -1)
        }
        skipReason = 'from-line-fully-hidden-cant-shift'
        return r
      }
      if (r.assoc < 0) {
        skipReason = 'from-boundary-assoc-already-negative'
        return r
      }
      touched = true
      forcedAssoc = -1
      return EditorSelection.cursor(r.head, -1)
    }

    branch = 'to'
    if (lineFullyHidden) {
      // pos at fold.to but the ENTIRE line containing fold.to is folded.
      // Means fold.to lands on the \n of the last hidden line.
      // coordsAtPos(head, ±1) → null because neither pos nor pos±1 has a
      // rendered glyph. Shift to fold.to + 1 = first char of next visible
      // line. Bounded by docLen.
      const shifted = Math.min(docLen, r.head + 1)
      if (shifted !== r.head) {
        touched = true
        posShift = 1
        return EditorSelection.cursor(shifted, -1)
      }
      // r.head === docLen and line is hidden → nowhere to shift visually.
      // Signal the outer to append a \n and move the cursor one past docLen.
      // Same effect as cursorOutOfFoldPlugin's doc-tail special case but it
      // only fires on mousedown — without this here, Cmd+Backspace lands on
      // a docLen fold.to and the cursor stays invisible.
      touched = true
      needAppendNewline = true
      branch = 'to-append'
      return EditorSelection.cursor(r.head + 1, -1)
    }
    if (r.assoc >= 0) {
      skipReason = 'to-boundary-assoc-already-non-negative'
      return r
    }
    touched = true
    forcedAssoc = 1
    return EditorSelection.cursor(r.head, 1)
  })

  // Diagnostic: log every transaction that touches selection or doc near
  // folded ranges. Drop only completely irrelevant transactions to keep
  // dev.log noise low while still capturing every Cmd+Backspace edge case.
  if (postFolds.length > 0 || tr.selection || tr.docChanged) {
    try {
      const ues: string[] = []
      ;(tr as any).annotations?.forEach?.((a: any) => {
        // CM6 Transaction.annotations is private; userEvent annotation is
        // exposed via tr.isUserEvent — collect via probe of known prefixes
        // for diagnostic purposes only.
      })
      const probes = ['select.pointer', 'select.keyboard', 'select', 'delete.backward', 'delete.forward', 'delete.lineboundary', 'delete.cut', 'delete.selection', 'input.type', 'input.paste', 'move']
      const ue = probes.find(p => tr.isUserEvent(p)) || '(none)'
      const before = tr.startState.selection.main
      const after = selection.main
      console.log('[FoldBoundary] tx',
        'ue=' + ue,
        'docChanged=' + tr.docChanged,
        'selBefore={head:' + before.head + ',assoc:' + before.assoc + '}',
        'selAfter={head:' + after.head + ',assoc:' + after.assoc + '}',
        'postFolds=' + JSON.stringify(postFolds),
        'touched=' + touched,
        touched ? `→ branch=${branch} forcedAssoc=${forcedAssoc} posShift=${posShift}` : 'skipReason=' + skipReason
      )
    } catch (e) {
      // never let logging break the filter
    }
  }

  if (!touched) return tr
  if (needAppendNewline) {
    return [tr, {
      changes: { from: docLen, insert: '\n' },
      selection: EditorSelection.create(newRanges, selection.mainIndex),
      sequential: true
    }]
  }
  return [tr, {
    selection: EditorSelection.create(newRanges, selection.mainIndex),
    sequential: true
  }]
})

/**
 * History support for fold state.
 *
 * @codemirror/language's foldState (StateField) wipes fold ranges on any
 * userEvent matching "delete" (see clearTouchedFolds in language/index.cjs).
 * Our `Cmd+X` on a folded ^^ block dispatches `userEvent:'delete.cut'`, which
 * matches → fold range is destroyed together with the text.
 *
 * Neither foldEffect nor unfoldEffect register `invertedEffects`, so the
 * history field only records text changes. Undo restores the text but the
 * fold is gone — autoFoldCollapsedMarkers re-folds via setTimeout(0), which
 * paints one frame of expanded content (the "flash" the user reports).
 *
 * Fix: register invertedEffects to emit `foldEffect.of(oldRange)` for every
 * folded range whose endpoints fall inside the transaction's removed text. On
 * undo the change is applied AND the fold is re-emitted in the SAME
 * transaction — no flash.
 *
 * Positions stored in the inverted effect are pre-change (the range as it
 * existed in startState). After undo the text positions match again because
 * undo applies the inverse change set, so foldEffect.of({from, to}) lands on
 * the restored block exactly.
 */
export const collapsibleFoldHistorySupport = invertedEffects.of((tr) => {
  if (tr.changes.empty) return []
  const folded = foldedRanges(tr.startState)
  const effects: any[] = []
  // For each removed range in the transaction, find any fold ranges fully
  // contained inside the removal — those would be wiped by clearTouchedFolds.
  // Emit foldEffect with the original startState positions so undo can restore.
  tr.changes.iterChangedRanges((fromA, toA) => {
    folded.between(fromA, toA, (foldFrom, foldTo) => {
      if (foldFrom >= fromA && foldTo <= toA) {
        effects.push(foldEffect.of({ from: foldFrom, to: foldTo }))
      }
    })
  })
  return effects
})

// >> = expanded (open), ^^ = collapsed (folded)
const collapsiblePattern = /^(\s*)(>>|\^\^)/

/**
 * Range of the visible title affordance inside a collapsible header:
 *   ">> title"       -> " title" hitbox starts right after >>
 *   ">> ### title"   -> " ### title" hitbox starts right after >>
 *   ">> **title**"   -> " **title" hitbox starts right after >>
 *
 * Leading document indent before the marker is NOT included: clicking there is
 * still normal text/selection. Spaces after the arrow ARE included. They are
 * visually between the arrow widget and the title, so treating them as an edit
 * zone makes the click/cursor affordance disagree with the title toggle model.
 *
 * This is not a full markdown parser. It only defines the cursor/click
 * affordance range; the existing markdownSyntax plugin still owns conceal/styling.
 */
export function getCollapsibleTitleRange(lineText: string): { from: number; to: number } | null {
  const match = lineText.match(collapsiblePattern)
  if (!match) return null

  const clickFrom = match[1].length + match[2].length
  let contentFrom = clickFrom
  while (contentFrom < lineText.length && /[ \t]/.test(lineText[contentFrom])) contentFrom++

  let to = lineText.length
  if (contentFrom >= to) return null

  const heading = lineText.slice(contentFrom).match(/^(#{1,6})[ \t]+/)
  if (heading) contentFrom += heading[0].length

  const full = lineText.slice(contentFrom, to)
  const wrappers: Array<[string, string]> = [
    ['**', '**'],
    ['~~', '~~'],
    ['`', '`'],
    ['*', '*']
  ]
  for (const [open, close] of wrappers) {
    if (full.length > open.length + close.length && full.startsWith(open) && full.endsWith(close)) {
      to -= close.length
      break
    }
  }

  return contentFrom < to ? { from: clickFrom, to } : null
}

// Diagnostic: track pending async fold operations
const _foldDiag = { pendingFold: 0, pendingUnfold: 0 }
;(window as any).__foldDiag = _foldDiag

/**
 * Плагин для отображения inline стрелок сворачивания
 * Стрелки отображаются с учётом отступа строки (не в gutter)
 */
export const collapsibleArrowPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view)
      // Mount-time autoFold: when an editor is created with `^^` markers already
      // in the document, no docChanged transaction will ever fire — so update()
      // never autoFolds. Without this, a sibling editor that mounts AFTER its
      // source content already contains `^^` (e.g. TabNotesSlideout opening over
      // tab.notes that InfoPanel already folded) renders the block expanded.
      //
      // ALWAYS async (setTimeout 0). A previous version tried sync dispatch
      // here to avoid a 1-frame flash, but ViewPlugin constructors fire DURING
      // CM6's update cycle when a new EditorView is created (CodeMirror runs
      // plugin constructors as part of the initial view update). A sync
      // `view.dispatch` from inside the constructor throws:
      //     "Calls to EditorView.update are not allowed while an update is in
      //      progress"
      // — which crashes this plugin entirely → decorations never build →
      // every `^^` marker renders as plain text and the fold never applies.
      // Tab-switch UX bug reproduced (2026-05-18). setTimeout(0) is the only
      // safe path; the flash is acceptable, a crashed editor is not.
      this.autoFoldCollapsedMarkers(view, /* synchronous */ false)
    }

    update(update: { docChanged: boolean; selectionSet: boolean; view: EditorView; state: any }) {
      // Обновляем при изменении документа, selection или состояния fold
      if (update.docChanged || update.selectionSet || this.foldStateChanged(update)) {
        this.decorations = this.buildDecorations(update.view)
      }

      // Auto-unfold stale folds BEFORE auto-folding (order matters for setTimeout queue)
      if (update.docChanged) {
        this.autoUnfoldStaleFolds(update.view)
        this.autoFoldCollapsedMarkers(update.view)
      }
    }

    /**
     * Automatically fold blocks marked with ^^ (collapsed marker).
     *
     * `sync=true` dispatches in the same call (safe at mount or right after a
     * trusted dispatch — anywhere outside an update() cycle). `sync=false`
     * defers via setTimeout(0) — required inside update() because CM6 forbids
     * dispatch during update.
     *
     * The async path causes a 1-frame paint with ^^ blocks expanded; only
     * call it when you have no choice (i.e. from update()).
     */
    autoFoldCollapsedMarkers(view: EditorView, sync = false) {
      const doc = view.state.doc
      const foldEffects: any[] = []

      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i)
        const trimmed = line.text.trim()

        // Check for ^^ marker (collapsed state)
        if (trimmed.startsWith('^^')) {
          // Check if already folded
          let isFolded = false
          foldedRanges(view.state).between(line.from, line.to, () => {
            isFolded = true
          })

          // If not folded, fold it
          if (!isFolded) {
            const range = foldable(view.state, line.from, line.to)
            if (range && (range.to - range.from) > 2) {
              foldEffects.push(foldEffect.of(range))
            }
          }
        }
      }

      // Count total ^^ blocks for diagnostic
      let totalCollapsed = 0
      for (let i = 1; i <= doc.lines; i++) {
        if (doc.line(i).text.trim().startsWith('^^')) totalCollapsed++
      }

      // Apply all fold effects in one dispatch
      if (foldEffects.length === 0) {
        if (totalCollapsed > 0) {
          console.log('[Fold:autoFold] ran: 0 to fold, all', totalCollapsed, '^^ blocks already folded')
        }
        return
      }

      // Caret-rescue after the fold lands. If the caret sits EXACTLY on a
      // fold.from we just created, the inclusive-replace boundary swallows it:
      // RectangleMarker.forRange probes coordsAtPos(head, assoc||1) → with
      // assoc=0 that's +1, RIGHT into the hidden body widget → null → caret DOM
      // not built (typing works, no blinking cursor). The transaction that
      // PLACED the caret (multi-line Collapsible wrap) ran BEFORE this fold
      // existed, and CM6 normalizes an explicit assoc=-1 back to 0 when the
      // position is not yet a boundary — verified in [FoldBoundary] logs:
      // wrap sets cursor(pos,-1) but selAfter reads assoc:0.
      //
      // So the bias must be RE-ASSERTED as a SEPARATE transaction AFTER the fold
      // is applied — only then is the position a real boundary and assoc=-1
      // sticks. This is exactly the `sequential: true` pattern foldBoundaryAssocFix
      // uses, and the state a user's rescue-click would otherwise have to reach.
      // foldBoundaryAssocFix itself can't cover us: the fold dispatch is
      // effects-only (no selection / no docChange) so its guard skips it.
      // → fix-cm6-cursor-selection.md::Cursor stuck inside fold
      const rescueCaretOnFreshFold = (v: EditorView) => {
        const sel = v.state.selection.main
        if (!sel.empty || sel.assoc < 0) return
        const onFoldFrom = foldEffects.some(eff => {
          const r = eff?.value as { from: number; to: number } | undefined
          return r != null && sel.head === r.from
        })
        if (!onFoldFrom) return
        console.log('[Fold:autoFold] re-asserting caret assoc=-1 on fresh fold.from', { head: sel.head })
        v.dispatch({ selection: EditorSelection.cursor(sel.head, -1) })
      }

      if (sync) {
        console.log('[Fold:autoFold]', foldEffects.length, '/', totalCollapsed, 'unfolded ^^ blocks found, folding synchronously')
        view.dispatch({ effects: foldEffects })
        rescueCaretOnFreshFold(view)
        return
      }

      console.log('[Fold:autoFold]', foldEffects.length, '/', totalCollapsed, 'unfolded ^^ blocks found, scheduling fold')
      _foldDiag.pendingFold++
      setTimeout(() => {
        _foldDiag.pendingFold--
        view.dispatch({ effects: foldEffects })
        rescueCaretOnFreshFold(view)
      }, 0)
    }

    /**
     * Auto-unfold stale folds.
     * When content after a folded section gets indented (Tab) or moved (Alt+Up/Down),
     * the fold range becomes stale — foldable() returns a different range than stored.
     * Detect this and unfold + swap ^^ → >> to keep state consistent.
     */
    autoUnfoldStaleFolds(view: EditorView) {
      const doc = view.state.doc
      const unfoldEffects: any[] = []
      const markerChanges: { from: number; to: number; insert: string }[] = []

      foldedRanges(view.state).between(0, doc.length, (foldFrom, foldTo) => {
        // foldFrom is headerLine.to (fold starts at end of header line)
        const headerLine = doc.lineAt(foldFrom)
        const match = headerLine.text.match(collapsiblePattern)
        if (!match) return // Not a collapsible fold

        // Compute what the fold range SHOULD be based on current content
        const expectedRange = foldable(view.state, headerLine.from, headerLine.to)

        // Stale if: no foldable range anymore, or range endpoint changed
        if (!expectedRange || expectedRange.to !== foldTo) {
          unfoldEffects.push(unfoldEffect.of({ from: foldFrom, to: foldTo }))
          // Swap ^^ → >> to prevent autoFoldCollapsedMarkers from re-folding
          if (match[2] === '^^') {
            const markerStart = headerLine.from + match[1].length
            markerChanges.push({ from: markerStart, to: markerStart + 2, insert: '>>' })
          }
        }
      })

      if (unfoldEffects.length > 0) {
        _foldDiag.pendingUnfold++
        // Use setTimeout to avoid dispatch during update
        // ^^ → >> is same length (2 chars), so positions stay stable
        setTimeout(() => {
          _foldDiag.pendingUnfold--
          view.dispatch({
            ...(markerChanges.length > 0 ? { changes: markerChanges } : {}),
            effects: unfoldEffects
          })
        }, 0)
      }
    }

    foldStateChanged(update: any): boolean {
      // Проверяем изменилось ли состояние fold
      for (const tr of update.transactions || []) {
        for (const effect of tr.effects) {
          if (effect.is(foldEffect) || effect.is(unfoldEffect)) {
            return true
          }
        }
      }
      return false
    }

    buildDecorations(view: EditorView): DecorationSet {
      const decorations: { from: number; to: number; decoration: Decoration }[] = []
      const doc = view.state.doc

      // Стрелка отображается ВСЕГДА (даже на активной строке)
      // Это позволяет кликать для fold/unfold в любой момент

      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i)
        const match = line.text.match(collapsiblePattern)

        if (match) {
          const indentLen = match[1].length // Длина отступа
          const markerLen = match[2].length // Длина '>>' (всегда 2)

          // ВАЖНО: заменяем ТОЛЬКО '>>', оставляя отступ в DOM
          const decoStart = line.from + indentLen
          const decoEnd = decoStart + markerLen

          // Определяем состояние fold
          const hasContent = this.hasContent(view, line.from, line.to)
          const foldedRange = this.foldedRange(view, line.from, line.to)
          const isFolded = foldedRange !== null
          const foldedLineCount = foldedRange
            ? Math.max(0, doc.lineAt(foldedRange.to).number - line.number)
            : 0

          // Определяем тип форматирования в заголовке
          const formatType = this.detectFormatting(line.text)

          // Создаём виджет со стрелкой
          const widget = new CollapsibleArrowWidget(
            '', // Отступ не нужен — CodeMirror отрисует его как обычный текст
            !isFolded, // isOpen (empty sections show ▾ with .empty styling)
            !hasContent, // isEmpty
            line.from,
            formatType, // Тип форматирования для цвета
            view // EditorView для обработки кликов
          )

          // Заменяем ТОЛЬКО '>>' на стрелку (отступ остаётся в DOM!)
          decorations.push({
            from: decoStart,
            to: decoEnd,
            decoration: Decoration.replace({ widget })
          })

          // Cursor affordance: pointer only over the title text, not over the
          // whole .cm-line. The structural `.cm-collapsible-header` line-class
          // is too wide: it also covers the empty edit zone to the right.
          const titleRange = getCollapsibleTitleRange(line.text)
          if (titleRange) {
            decorations.push({
              from: line.from + titleRange.from,
              to: line.from + titleRange.to,
              decoration: Decoration.mark({ class: 'cm-collapsible-title-text' })
            })
          }

          // Folded line count belongs at the END of the visible title, not near
          // the arrow. `side:-1` keeps it on the visible header side of
          // fold.from (= line.to), before codeFolding's hidden replace widget.
          if (isFolded && foldedLineCount > 0) {
            decorations.push({
              from: line.to,
              to: line.to,
              decoration: Decoration.widget({
                widget: new CollapsibleLineCountWidget(foldedLineCount, formatType),
                side: -1
              })
            })
          }
        }
      }

      decorations.sort((a, b) => a.from - b.from)

      try {
        return Decoration.set(
          decorations.map(d => d.decoration.range(d.from, d.to)),
          true
        )
      } catch (e) {
        console.error('[CollapsibleArrow] Error:', e)
        return Decoration.none
      }
    }

    hasContent(view: EditorView, lineFrom: number, lineTo: number): boolean {
      const range = foldable(view.state, lineFrom, lineTo)
      return range !== null && (range.to - range.from) > 2
    }

    foldedRange(view: EditorView, lineFrom: number, lineTo: number): { from: number; to: number } | null {
      let folded: { from: number; to: number } | null = null
      foldedRanges(view.state).between(lineFrom, lineTo, (from, to) => {
        folded = { from, to }
      })
      return folded
    }

    /**
     * Определяет тип форматирования по ПЕРВОМУ non-space символу content после >>/^^.
     * Позиционное правило — какой токен идёт первым, тот цвет и выигрывает.
     * Логика должна быть идентична collapsibleScopePlugin.detectFormatting,
     * иначе цвет стрелки и цвет индент-линии разойдутся.
     */
    detectFormatting(lineText: string): string | null {
      const content = lineText.replace(/^\s*(>>|\^\^)\s*/, '')
      if (!content) return null
      const c0 = content[0]

      if (c0 === '#') {
        let level = 0
        while (level < content.length && content[level] === '#') level++
        if (level >= 1 && level <= 6 && content[level] === ' ') return `h${level}`
        return null
      }
      if (c0 === '*') {
        return content[1] === '*' ? 'bold' : 'italic'
      }
      if (c0 === '`') {
        return 'code'
      }
      if (c0 === '~' && content[1] === '~') {
        return 'strike'
      }
      return null
    }

  },
  { decorations: v => v.decorations }
)

/**
 * Обработчик кликов на стрелки сворачивания
 */
export function createCollapsibleArrowClickHandler() {
  return EditorView.domEventHandlers({
    click(event, view) {
      const target = event.target as HTMLElement

      // Option/Alt temporarily turns collapsible controls into normal text
      // editing hit targets. Keep arrow behavior aligned with title-click.
      if (event.altKey) return false

      // Проверяем клик на стрелку
      if (!target.classList.contains('cm-collapsible-arrow')) {
        return false
      }

      const lineFromStr = target.dataset.lineFrom
      if (!lineFromStr) return false

      const lineFrom = parseInt(lineFromStr, 10)
      const line = view.state.doc.lineAt(lineFrom)

      // Проверяем есть ли контент для сворачивания
      const range = foldable(view.state, line.from, line.to)
      if (!range || (range.to - range.from) <= 2) {
        // Пустая секция — ничего не делаем
        event.preventDefault()
        return true
      }

      // Проверяем свёрнуто ли
      let foldedRange: { from: number; to: number } | null = null
      foldedRanges(view.state).between(line.from, line.to, (from, to) => {
        foldedRange = { from, to }
      })

      if (foldedRange) {
        view.dispatch({ effects: unfoldEffect.of(foldedRange) })
      } else {
        view.dispatch({ effects: foldEffect.of(range) })
      }

      event.preventDefault()
      return true
    }
  })
}

/**
 * Custom Enter handler (Prec.high).
 *
 * Two responsibilities:
 *
 * 1. FOLDED SECTIONS: cursor on a folded ^^ header can be at fold.from
 *    (headerLine.to) or fold.to (lastContentLine.to). Insert \n after fold,
 *    outside the inclusive boundary, so fold is not broken.
 *    Only matches when cursor is exactly at a fold boundary of a collapsible header.
 *
 * 2. INDENT PRESERVATION: for all other Enter-at-line-end presses, copy
 *    the current line's leading whitespace. This replaces CM6's
 *    insertNewlineAndIndent which may not preserve indent without a Language.
 */
export function createCollapsibleEnterHandler() {
  return Prec.high(keymap.of([
    {
      key: 'Enter',
      run: (view: EditorView) => {
        const { state } = view
        const sel = state.selection.main
        if (!sel.empty) return false

        const pos = sel.head
        const line = state.doc.lineAt(pos)

        // Only intercept when cursor is at line end
        if (pos !== line.to) return false

        // --- Case 1: Folded collapsible section ---
        // Cursor can be at fold.from (headerLine.to) or fold.to (lastContentLine.to).
        let targetFold: { from: number; to: number } | null = null
        foldedRanges(state).between(pos, pos, (from, to) => {
          const headerLine = state.doc.lineAt(from)
          if (headerLine.text.match(collapsiblePattern) && (pos === headerLine.to || pos === to)) {
            targetFold = { from, to }
          }
        })

        if (targetFold) {
          const fold = targetFold as { from: number; to: number }
          // Insert \n AFTER the fold's trailing \n (= start of next line).
          // This avoids fold absorption since codeFolding decorations use inclusive: true.
          // Preserve header indent so the new line matches the folded section's level.
          const headerLine = state.doc.lineAt(fold.from)
          const headerIndent = headerLine.text.match(/^\s*/)?.[0] ?? ''
          const foldEndLine = state.doc.lineAt(fold.to)
          if (foldEndLine.number < state.doc.lines) {
            const nextLineFrom = state.doc.line(foldEndLine.number + 1).from
            const insert = headerIndent + '\n'
            view.dispatch({
              changes: { from: nextLineFrom, insert },
              selection: { anchor: nextLineFrom + headerIndent.length }
            })
          } else {
            const insert = '\n' + headerIndent
            view.dispatch({
              changes: { from: state.doc.length, insert },
              selection: { anchor: state.doc.length + insert.length }
            })
          }
          return true
        }

        // --- Case 1.5: Expanded collapsible header (>>) — indent +1 tab ---
        const collapsibleMatch = line.text.match(/^(\s*)(>>)\s/)
        if (collapsibleMatch) {
          const currentIndent = collapsibleMatch[1]
          const insert = '\n' + currentIndent + '    '
          view.dispatch(
            state.replaceSelection(insert),
            { scrollIntoView: true, userEvent: 'input' }
          )
          return true
        }

        // --- Case 2: Normal line — preserve indentation ---
        // Use current line's leading whitespace.
        // If current line has no indent, check the immediately next line only.
        let leading = /^\s*/.exec(line.text)?.[0] ?? ''
        if (line.number < state.doc.lines) {
          const nextLine = state.doc.line(line.number + 1)
          const nextLeading = /^\s*/.exec(nextLine.text)?.[0] ?? ''
          if (nextLeading.length > leading.length) {
            leading = nextLeading
          }
        }
        const insert = '\n' + leading
        view.dispatch(
          state.replaceSelection(insert),
          { scrollIntoView: true, userEvent: 'input' }
        )
        return true
      }
    },
    {
      key: 'Mod-Enter',
      run: (view: EditorView) => {
        const { state } = view
        const sel = state.selection.main
        if (!sel.empty) return false

        const line = state.doc.lineAt(sel.head)

        // --- Folded collapsible section ---
        let targetFold: { from: number; to: number } | null = null
        foldedRanges(state).between(line.from, line.to, (from, to) => {
          const headerLine = state.doc.lineAt(from)
          if (headerLine.text.match(collapsiblePattern)) {
            targetFold = { from, to }
          }
        })

        if (targetFold) {
          const fold = targetFold as { from: number; to: number }
          // Preserve header indent so the new line matches the folded section's level.
          const headerLine = state.doc.lineAt(fold.from)
          const headerIndent = headerLine.text.match(/^\s*/)?.[0] ?? ''
          const foldEndLine = state.doc.lineAt(fold.to)
          if (foldEndLine.number < state.doc.lines) {
            const nextLineFrom = state.doc.line(foldEndLine.number + 1).from
            const insert = headerIndent + '\n'
            view.dispatch({
              changes: { from: nextLineFrom, insert },
              selection: { anchor: nextLineFrom + headerIndent.length },
              scrollIntoView: true
            })
          } else {
            const insert = '\n' + headerIndent
            view.dispatch({
              changes: { from: state.doc.length, insert },
              selection: { anchor: state.doc.length + insert.length },
              scrollIntoView: true
            })
          }
          return true
        }

        // --- Expanded collapsible header (>>) — indent +1 tab ---
        const collapsibleMatch = line.text.match(/^(\s*)(>>)\s/)
        if (collapsibleMatch) {
          const currentIndent = collapsibleMatch[1]
          const insert = '\n' + currentIndent + '    '
          view.dispatch({
            changes: { from: line.to, insert },
            selection: { anchor: line.to + insert.length },
            scrollIntoView: true,
            userEvent: 'input'
          })
          return true
        }

        // --- Normal line — insert after line end with look-ahead indent ---
        let leading = /^\s*/.exec(line.text)?.[0] ?? ''
        if (line.number < state.doc.lines) {
          const nextLine = state.doc.line(line.number + 1)
          const nextLeading = /^\s*/.exec(nextLine.text)?.[0] ?? ''
          if (nextLeading.length > leading.length) {
            leading = nextLeading
          }
        }
        const insert = '\n' + leading
        view.dispatch({
          changes: { from: line.to, insert },
          selection: { anchor: line.to + insert.length },
          scrollIntoView: true,
          userEvent: 'input'
        })
        return true
      }
    }
  ]))
}

/**
 * Custom Backspace handler to prevent cursor from disappearing into folded sections.
 *
 * When cursor is at the start of a line and the previous position (pos-1)
 * is inside a folded collapsible range, default deleteCharBackward would
 * merge the line into the invisible fold. Instead, move cursor to the
 * visible end of the fold's header line.
 */
export function createCollapsibleBackspaceHandler() {
  return Prec.high(keymap.of([{
    key: 'Backspace',
    run: (view: EditorView) => {
      const { state } = view
      const sel = state.selection.main
      if (!sel.empty) return false

      const pos = sel.head
      if (pos === 0) return false
      const line = state.doc.lineAt(pos)
      if (pos !== line.from) return false

      // Check if pos-1 is inside a folded collapsible range
      let targetFold: { from: number; to: number } | null = null
      foldedRanges(state).between(pos - 1, pos - 1, (from, to) => {
        const headerLine = state.doc.lineAt(from)
        if (headerLine.text.match(collapsiblePattern)) {
          targetFold = { from, to }
        }
      })

      if (targetFold) {
        const fold = targetFold as { from: number; to: number }
        const headerLine = state.doc.lineAt(fold.from)
        // Land cursor on `headerLine.to` (= fold.from). In current CM6,
        // `Decoration.replace({widget})` defaults to non-inclusive — the
        // position itself is outside the replaced range, but the CURSOR
        // RENDERER calls `coordsAtPos(head, range.assoc || 1)` (RectangleMarker
        // .forRange) which defaults the side to +1 = "right of position".
        // Right of fold.from is INSIDE the hidden widget → coordsAtPos
        // returns null → the cursor DOM node is never created → the user
        // sees the caret disappear even though selection.head is valid and
        // typing still mutates the doc. Pin assoc=-1 so the renderer probes
        // LEFT of the position (end of the visible header line) and gets
        // real coords. This is the documented escape — see
        // `fix-cm6-cursor-selection.md::Cursor stuck inside fold`.
        const targetPos = fold.from

        // Empty line immediately after fold: actually delete the \n so the line
        // disappears (default Backspace would merge an empty line into invisible
        // fold body — we don't want that, but we DO want the empty line removed).
        // Detection: current line is empty AND pos-1 == fold.to (the \n we'd delete
        // sits right after the fold's last content line).
        if (line.text === '' && pos - 1 === fold.to) {
          console.log('[Collapsible:Backspace] empty-line-after-fold delete',
            { line: line.number, headerLine: headerLine.number,
              foldFrom: fold.from, foldTo: fold.to, targetPos })
          view.dispatch({
            changes: { from: pos - 1, to: pos, insert: '' },
            selection: EditorSelection.cursor(targetPos, -1),
            scrollIntoView: true,
            userEvent: 'delete.backward'
          })
          return true
        }

        console.log('[Collapsible:Backspace] cursor-only move out of fold',
          { line: line.number, lineEmpty: line.text === '', headerLine: headerLine.number,
            foldFrom: fold.from, foldTo: fold.to, targetPos })
        view.dispatch({
          selection: EditorSelection.cursor(targetPos, -1),
          scrollIntoView: true
        })
        return true
      }
      return false
    }
  }]))
}

/**
 * Custom ArrowDown handler: skip past folded collapsible header correctly.
 *
 * Problem: when the line immediately below the cursor is a folded `^^` header
 * whose body (line N+1..M) is replaced by a zero-height widget, CM6's
 * `moveVertically` lands the cursor on the line AFTER the fold (visually 2nd
 * line below), not on the header itself. Root cause: the heightMap merges the
 * header line with its hidden body into a single block whose
 * `posAtCoordsInline` lookup for the goal X maps to the end of the block
 * (= fold.to), and `skipAtoms` then pushes the cursor past the fold to the
 * next visible line.
 *
 * Fix: detect "next doc line is a folded collapsible header" and route the
 * cursor onto that header line directly. Land on `headerLine.to - 1` — same
 * safe position used by the Backspace handler — to stay outside the inclusive
 * replace boundary that would otherwise hide the cursor.
 *
 * Only triggered when the move would actually skip the header. ArrowUp is
 * symmetric in user reports (works fine because the header is the *first*
 * visible block in that direction), so no Up handler is needed.
 */
export function createCollapsibleArrowDownHandler() {
  return Prec.high(keymap.of([{
    key: 'ArrowDown',
    run: (view: EditorView) => {
      const { state } = view
      const sel = state.selection.main
      if (!sel.empty) return false

      const pos = sel.head
      const line = state.doc.lineAt(pos)
      if (line.number >= state.doc.lines) return false

      // Find the FIRST visible line below the cursor — meaning a line whose
      // start position isn't covered by any folded range. This handles:
      //   (a) cursor on a folded ^^ header → nextLine is inside its hidden
      //       body, but the first visible line BELOW the body is what the user
      //       perceives as "next line". If that's another folded ^^, CM6's
      //       default vertical move overshoots it (same heightmap-merge bug
      //       documented for the single-folded case below).
      //   (b) cursor on a normal line above a folded ^^ → nextLine is the
      //       header itself, also handled here.
      // Skip lines whose `from` falls inside an existing folded range.
      const folds = foldedRanges(state)
      let candidate: { number: number; from: number; to: number; text: string } | null = null
      for (let i = line.number + 1; i <= state.doc.lines; i++) {
        const ln = state.doc.line(i)
        let coveredByFold = false
        folds.between(ln.from, ln.from, (from, to) => {
          if (ln.from > from && ln.from <= to) coveredByFold = true
        })
        if (coveredByFold) continue
        candidate = { number: ln.number, from: ln.from, to: ln.to, text: ln.text }
        break
      }
      if (!candidate) return false
      if (!collapsiblePattern.test(candidate.text)) return false

      // Override only if the candidate is actually folded — unfolded headers
      // navigate correctly with CM6 defaults.
      let isFolded = false
      folds.between(candidate.from, candidate.to, () => {
        isFolded = true
      })
      if (!isFolded) return false

      const targetPos = Math.max(candidate.from, candidate.to - 1)
      console.log('[Collapsible:ArrowDown] override → folded header',
        { fromLine: line.number, headerLine: candidate.number,
          skippedLines: candidate.number - line.number - 1,
          headerText: candidate.text.slice(0, 40), targetPos })
      view.dispatch({
        selection: EditorSelection.cursor(targetPos),
        scrollIntoView: true
      })
      return true
    }
  }]))
}

/**
 * Swap >> ↔ ^^ marker on a given line.
 * Returns the transaction change spec, or null if no marker found.
 */
function createMarkerChange(line: { text: string; from: number }, fromMarker: string, toMarker: string) {
  const match = line.text.match(collapsiblePattern)
  if (!match || match[2] !== fromMarker) return null
  const markerStart = line.from + match[1].length
  return { from: markerStart, to: markerStart + fromMarker.length, insert: toMarker }
}

/**
 * Toggle fold/unfold on a collapsible header line.
 * Swaps >> ↔ ^^ and applies fold/unfold effect.
 * Optional `selection` moves cursor in the same dispatch (atomic).
 * Exported: используется и тут (Cmd+., toggleFoldAtPos), и в headerClick.ts
 * (клик по тексту названия) — семантика toggle везде одна, включая свап маркера.
 */
export function toggleFoldOnLine(
  view: EditorView,
  line: { from: number; to: number; text: string },
  selection?: { anchor: number }
): boolean {
  // Check if currently folded
  let foldedRange: { from: number; to: number } | null = null
  foldedRanges(view.state).between(line.from, line.to, (from, to) => {
    foldedRange = { from, to }
  })

  if (foldedRange) {
    // Unfold: ^^ → >>
    const markerChange = createMarkerChange(line, '^^', '>>')
    const effects = [unfoldEffect.of(foldedRange!)]
    view.dispatch({
      ...(markerChange ? { changes: markerChange } : {}),
      effects,
      ...(selection ? { selection } : {})
    })
    return true
  } else {
    // Fold: >> → ^^
    const range = foldable(view.state, line.from, line.to)
    if (!range || (range.to - range.from) <= 2) return false // Empty section
    const markerChange = createMarkerChange(line, '>>', '^^')
    const effects = [foldEffect.of(range)]
    view.dispatch({
      ...(markerChange ? { changes: markerChange } : {}),
      effects,
      ...(selection ? { selection } : {})
    })
    return true
  }
}

/**
 * Public: toggle fold/unfold of the collapsible block whose HEADER line contains
 * `pos`. Used by the Outline panel — клик по элементу оглавления сворачивает/
 * разворачивает соответствующий блок в редакторе. Возвращает true, если строка
 * под `pos` — collapsible-заголовок (>>/^^) с непустым телом и тоггл применён;
 * false иначе (обычный #-заголовок без collapsible, пустая секция, плохой pos).
 *
 * Резолвит строку из char-offset (pos — начало строки заголовка из extractOutline)
 * и делегирует в toggleFoldOnLine (свап >>↔^^ + fold/unfold атомарно). НЕ двигает
 * курсор/селекшн — навигацию делает вызывающий отдельно.
 */
export function toggleFoldAtPos(view: EditorView, pos: number): boolean {
  const docLen = view.state.doc.length
  const safe = Math.max(0, Math.min(pos, docLen))
  const line = view.state.doc.lineAt(safe)
  const match = line.text.match(collapsiblePattern)
  if (!match) {
    console.log('[Outline:fold] not a collapsible header, skip', { line: line.number, text: line.text.slice(0, 30) })
    return false
  }
  // Пустая секция (нечего сворачивать) — toggleFoldOnLine сам это отсечёт при
  // fold, но при уже-folded состоянии unfold всё равно валиден. Проверяем явно
  // только для лога; решение оставляем toggleFoldOnLine.
  const range = foldable(view.state, line.from, line.to)
  let isFolded = false
  foldedRanges(view.state).between(line.from, line.to, () => { isFolded = true })
  if (!isFolded && (!range || range.to - range.from <= 2)) {
    console.log('[Outline:fold] empty section, nothing to fold', { line: line.number })
    return false
  }
  console.log('[Outline:fold] toggle', { line: line.number, wasFolded: isFolded, text: line.text.slice(0, 30) })
  // Курсор в КОНЕЦ строки заголовка (line.to), не в начало — иначе он садится
  // перед маркерами >>/####. Тот же селекшн, что у внутренних fold-хендлеров
  // (Enter/click по стрелке) — консистентно. line.to валиден и после fold:
  // схлопывается только тело ниже, сама строка-заголовок остаётся.
  toggleFoldOnLine(view, line, { anchor: line.to })
  return true
}

/**
 * Scan upward from `pos` to find the nearest parent collapsible header
 * whose foldable range contains `pos`.
 */
function findNearestParentHeader(state: EditorView['state'], pos: number) {
  const currentLine = state.doc.lineAt(pos)

  // Scan upward from current line
  for (let i = currentLine.number - 1; i >= 1; i--) {
    const line = state.doc.line(i)
    const match = line.text.match(collapsiblePattern)
    if (!match) continue

    // Check if this header's foldable range contains our position
    const range = foldable(state, line.from, line.to)
    if (range && range.to >= pos) {
      return line
    }

    // Also check if it's already folded and the fold range contains pos
    let foldedRange: { from: number; to: number } | null = null
    foldedRanges(state).between(line.from, line.to, (from, to) => {
      foldedRange = { from, to }
    })
    if (foldedRange && (foldedRange as { from: number; to: number }).to >= pos) {
      return line
    }
  }
  return null
}

/**
 * Cmd+. handler: fold/unfold nearest parent collapsible section.
 * If cursor is on a collapsible header — toggles that header.
 * Otherwise scans upward for the nearest parent header.
 *
 * Cursor always moves to end of header line (same dispatch, atomic).
 * Scroll is preserved so header appears at cursor's old screen position.
 */
export function createCollapsibleFoldParentHandler() {
  return Prec.high(keymap.of([
    {
      key: 'Mod-.',
      run: (view: EditorView) => {
        const { state } = view
        const pos = state.selection.main.head
        const currentLine = state.doc.lineAt(pos)

        // Case 1: cursor is on a collapsible header line
        if (collapsiblePattern.test(currentLine.text)) {
          toggleFoldOnLine(view, currentLine, { anchor: currentLine.to })
          return true
        }

        // Case 2: cursor inside section → fold nearest parent
        const parentLine = findNearestParentHeader(state, pos)
        if (parentLine) {
          // Capture cursor screen Y using lineBlockAt (document coordinates).
          // Must use lineBlockAt (not coordsAtPos) to stay in the same coordinate
          // space as scrollTop — coordsAtPos includes contentPaddingY offset.
          const cursorDocY = view.lineBlockAt(pos).top
          const headerDocY = view.lineBlockAt(parentLine.from).top
          const savedScrollTop = view.scrollDOM.scrollTop

          // Fold + move cursor to end of parent header (atomic dispatch)
          // >> → ^^ is same length, so parentLine.to is valid in new state
          toggleFoldOnLine(view, parentLine, { anchor: parentLine.to })

          // Adjust scroll: cursor moved from cursorDocY to headerDocY,
          // shift scrollTop by the same delta to keep screen position stable.
          // Browser auto-clamps scrollTop if document became too short.
          view.scrollDOM.scrollTop = savedScrollTop + (headerDocY - cursorDocY)

          return true
        }

        return true // Always consume the key
      }
    }
  ]))
}
