import { WidgetType, EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'

/**
 * Inline chip shown in place of `![...](path)` when the cursor is NOT on its
 * line. Renders a pilule — `▸ [thumbnail] image` (collapsed/expanded) —
 * in the same visual family as the `@link` widget, but lavender so it reads as
 * a distinct semantic (see методология::цвета чипов — neighbouring chips of
 * different meaning must differ in colour).
 *
 * The image can sit anywhere in a line with text before/after it, so the chip
 * is an INLINE replace (not line-level). Clicking the arrow flips the `|+`
 * expand-flag INSIDE the image markdown — collapse state lives in the text
 * itself, exactly like `>>`/`^^` for collapsible sections
 * (fact-collapsible-sections.md::Persistence,
 * methodology/дизайн-принципы.md::Один источник правды). No side-channel.
 *
 * imageField is a StateField (no EditorView at construction), so the click
 * handler resolves the live view via `EditorView.findFromDOM`.
 *
 * Per-zone click semantics (методология::семантика клика per-зона):
 *   - arrow  → toggle preview WITHOUT moving the cursor (mousedown swallowed →
 *     line stays inactive → chip just swaps ▸/▾ and shows/hides the preview).
 *   - body   → reveal raw `![...](path)` for editing.
 *
 * Why the body click is handled PROGRAMMATICALLY (not "fall through to CM"):
 * the chip span is registered as an atomicRange (imageField.ts), so the cursor
 * treats the whole token as one glyph — arrows skip it, and a NATIVE pointer
 * click is bounced to an edge by CM (it atom-skips `select.pointer`). An edge
 * caret is NOT strictly-inside, so it would NOT reveal raw. We therefore swallow
 * the pointer events (ignoreEvent + stopPropagation) and dispatch a selection
 * strictly INSIDE the token ourselves — programmatic selections are not
 * atom-skipped, so this is the single deterministic way to reveal raw. Adjacent
 * caret / arrow-through / select-around can never land strictly-inside, so the
 * chip stays a chip until explicitly clicked. fact-images.md::Активация по токену.
 */
export class ImageToggleWidget extends WidgetType {
  constructor(
    /** Absolute doc position of this image's `!` — the anchor for the edit. */
    readonly imgFrom: number,
    readonly isExpanded: boolean,
    /** Host-resolved URL (for example gt-file://...) used only by the view. */
    readonly imageUrl: string,
  ) {
    super()
  }

  eq(other: ImageToggleWidget) {
    return other.imgFrom === this.imgFrom
      && other.isExpanded === this.isExpanded
      && other.imageUrl === this.imageUrl
  }

  toDOM() {
    const chip = document.createElement('span')
    chip.className = 'cm-image-chip'

    const arrow = document.createElement('span')
    // Reuse `.cm-collapsible-arrow` glyph/hover for visual consistency with
    // section folds; `.cm-image-chip-arrow` is our per-zone ignoreEvent hook.
    arrow.className = `cm-image-chip-arrow cm-collapsible-arrow ${this.isExpanded ? 'open' : 'closed'}`
    arrow.textContent = this.isExpanded ? '▾' : '▸'
    arrow.title = this.isExpanded ? 'Свернуть превью' : 'Показать превью'

    const thumbnail = document.createElement('span')
    thumbnail.className = 'cm-image-chip-thumbnail'

    const image = document.createElement('img')
    image.src = this.imageUrl
    image.alt = ''
    image.draggable = false

    const fallback = document.createElement('span')
    fallback.className = 'cm-image-chip-thumbnail-fallback'
    fallback.textContent = '\u{1F5BC}' // 🖼, visible only when the file cannot load
    fallback.hidden = true

    image.addEventListener('error', () => {
      image.hidden = true
      fallback.hidden = false
    })
    thumbnail.appendChild(image)
    thumbnail.appendChild(fallback)

    const label = document.createElement('span')
    label.className = 'cm-image-chip-label'
    label.textContent = 'image'

    // Prevent cursor placement / selection on the arrow so the line stays
    // inactive after a toggle (same trick as CollapsibleArrowWidget).
    arrow.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    arrow.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()

      const editorDom = chip.closest('.cm-editor') as HTMLElement | null
      const view = editorDom ? EditorView.findFromDOM(editorDom) : null
      if (!view) return

      // Find THIS image's `](` — scoped to the span starting at imgFrom, so it
      // is correct even with several images on one line (a whole-line indexOf
      // would always return the first image's bracket).
      const line = view.state.doc.lineAt(this.imgFrom)
      const relStart = this.imgFrom - line.from
      const bracketRel = line.text.indexOf('](', relStart)
      if (bracketRel === -1) return
      const bracketAbs = line.from + bracketRel

      const hasFlag = line.text.slice(bracketRel - 2, bracketRel) === '|+'
      // No `selection` in the dispatch — the user's cursor lives elsewhere; CM
      // maps it through the change untouched.
      const changes = hasFlag
        ? { from: bracketAbs - 2, to: bracketAbs }        // remove `|+`
        : { from: bracketAbs, insert: '|+' }              // add `|+`
      view.dispatch({ changes })

      console.log('[Image:Toggle]', { imgFrom: this.imgFrom, was: hasFlag ? 'expanded' : 'collapsed' })
    })

    // Body (thumbnail + label) → reveal raw. The span is atomic, so a native click
    // would be bounced to an edge; we place the caret strictly INSIDE the token
    // programmatically (not atom-skipped) — the single way to reveal raw.
    const revealRaw = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const editorDom = chip.closest('.cm-editor') as HTMLElement | null
      const view = editorDom ? EditorView.findFromDOM(editorDom) : null
      if (!view) return

      // Land one char past `!` — strictly inside the token (imgFrom < pos <
      // matchEnd), which is what imageField checks to switch chip → raw. assoc 1
      // keeps the caret stable as the surrounding decoration recomputes.
      const pos = this.imgFrom + 1
      view.dispatch({
        selection: EditorSelection.cursor(pos, 1),
        userEvent: 'select'
      })
      view.focus()
      console.log('[Image:Reveal]', { imgFrom: this.imgFrom, pos })
    }
    // mousedown swallowed so CM's own pointer-select (which would atom-bounce to
    // an edge) never runs; click does the programmatic reveal.
    thumbnail.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
    label.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
    thumbnail.addEventListener('click', revealRaw)
    label.addEventListener('click', revealRaw)

    chip.appendChild(arrow)
    chip.appendChild(thumbnail)
    chip.appendChild(label)
    return chip
  }

  ignoreEvent(event: Event) {
    // Swallow mousedown/click for the WHOLE chip — every interactive zone is
    // handled by our own listeners (arrow → toggle, body → programmatic reveal).
    // Letting CM see these would run its pointer-select, which atom-bounces the
    // caret to an edge and defeats the reveal. Non-pointer events fall through.
    return event.type === 'mousedown' || event.type === 'click'
  }
}
