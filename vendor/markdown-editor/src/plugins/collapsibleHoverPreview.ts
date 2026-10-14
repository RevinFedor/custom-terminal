import { EditorView, ViewPlugin } from '@codemirror/view'
import { Extension } from '@codemirror/state'
import { foldedRanges, foldable } from '@codemirror/language'

/**
 * Cmd+Hover preview for collapsible sections (>> / ^^).
 *
 * - Cmd held + mouse over a folded `^^` header line → portal-popover under the
 *   header showing the hidden body text. No scroll, sized to content.
 * - Cmd+Shift toggles pin: 1px white border, pointer-events enabled (text
 *   selectable). Repeat Cmd+Shift or mousedown outside the popover removes pin.
 * - Single popover at a time. Re-hovering another folded header while Cmd is
 *   held switches the source.
 *
 * Position: left = X of the first non-whitespace char of the header (so the
 * preview lines up under the header text, indent included), top = bottom of
 * the header line + 4px gap. Same idea as if the user manually expanded the
 * fold — the body would appear right there.
 *
 * Reference patterns:
 *   - `emojiHoverTooltip.ts` for global Meta tracking + portal lifecycle
 *   - `IndexPopover/IndexButton.jsx` for Cmd+Shift pin semantics
 *   - global pattern doc: `Global-Templates/.../tooltip-resize-modal.md`
 */

const collapsiblePattern = /^(\s*)(>>|\^\^)/

/** Count visual indent columns: tabs expand to 4, spaces are 1. */
function visualIndentOf(prefix: string): number {
  let n = 0
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix.charCodeAt(i)
    if (c === 9) n += 4 - (n % 4)
    else if (c === 32) n++
    else break
  }
  return n
}

export function createCollapsibleHoverPreview(): Extension {
  return ViewPlugin.fromClass(class {
    popover: HTMLElement | null = null
    /** Document line.number of the currently shown header (to dedupe re-renders). */
    currentHeaderLine: number | null = null
    isPinned = false
    metaDown = false
    /**
     * Rising-edge latch for the Cmd+Shift pin chord. Shared by the keyboard
     * channel (focused window) and the mouse channel (unfocused floating
     * window) so the pin toggles EXACTLY once per physical chord press even
     * when both channels observe it. Set on rising edge, cleared on release.
     */
    chordEngaged = false
    lastMouseX = 0
    lastMouseY = 0
    /** DIAG: last (meta,shift,ctrl) tuple seen in mousemove, to log only on change. */
    _lastModSig = ''

    private _onKeyDown: (e: KeyboardEvent) => void
    private _onKeyUp: (e: KeyboardEvent) => void
    private _onMouseDown: (e: MouseEvent) => void

    private _onWindowBlur: () => void

    constructor(private view: EditorView) {
      this._onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Meta' || e.key === 'Control') {
          this.metaDown = true
          this.maybeShowAtCurrentMouse()
        }
        // Cmd+Shift pin toggle — keyboard channel (works only on the FOCUSED
        // window; an unfocused floating project window never receives keydown,
        // so the mousemove channel below mirrors this via mouse modifier flags).
        // Shared `chordEngaged` latch → exactly one toggle per physical press
        // even when both channels observe the chord on a focused window.
        // Gate on the pressed key being a modifier itself, so Cmd+Shift+<letter>
        // (e.g. a shortcut) doesn't toggle the pin — only the bare chord does.
        const chordKey = e.key === 'Shift' || e.key === 'Meta' || e.key === 'Control'
        const chord = (e.metaKey || e.ctrlKey) && e.shiftKey && chordKey
        if (chord && this.maybeToggleChord(true)) e.preventDefault()
      }
      this._onKeyUp = (e: KeyboardEvent) => {
        if (e.key === 'Meta' || e.key === 'Control') {
          this.metaDown = false
          if (!this.isPinned) this.hidePopover()
        }
        // Releasing either half of the chord re-arms the latch for the next press.
        if (e.key === 'Shift' || e.key === 'Meta' || e.key === 'Control') {
          if (!((e.metaKey || e.ctrlKey) && e.shiftKey)) this.chordEngaged = false
        }
      }
      this._onMouseDown = (e: MouseEvent) => {
        if (!this.isPinned) return
        const t = e.target as HTMLElement | null
        if (!t) return
        // Clicks inside our own popover do not drop the pin (text-select, etc.)
        if (t.closest && t.closest('[data-collapsible-preview]')) return
        this.unpinAndHide()
      }
      // Cmd+Tab swallows the keyup(Meta) — without this, cachedMetaDown stays
      // true after focus returns and the popover triggers on hover without Cmd.
      // Same pattern as includeLink.ts.
      this._onWindowBlur = () => {
        // Re-arm the chord latch: a Cmd+Shift+Tab away never delivers our keyup,
        // so without this the next chord press would be swallowed as stale. This
        // does NOT unpin (isPinned untouched) — pin survives focus loss by contract.
        this.chordEngaged = false
        if (!this.metaDown) return
        this.metaDown = false
        if (!this.isPinned) this.hidePopover()
      }
      document.addEventListener('keydown', this._onKeyDown, true)
      document.addEventListener('keyup', this._onKeyUp, true)
      document.addEventListener('mousedown', this._onMouseDown, true)
      window.addEventListener('blur', this._onWindowBlur)
    }

    /** When Cmd is pressed without movement: check whether mouse already sits on a folded header. */
    maybeShowAtCurrentMouse() {
      const pos = this.view.posAtCoords({ x: this.lastMouseX, y: this.lastMouseY })
      if (pos === null) return
      this.evaluateAndShow(pos)
    }

    /** Core dispatch: given a doc position, decide whether to show/hide/switch. */
    evaluateAndShow(pos: number) {
      const { state } = this.view
      const line = state.doc.lineAt(pos)
      const match = line.text.match(collapsiblePattern)
      if (!match) {
        if (!this.isPinned) this.hidePopover()
        return
      }

      // Only fire for FOLDED headers — expanded body is already visible inline.
      let foldRange: { from: number; to: number } | null = null
      foldedRanges(state).between(line.from, line.to, (from, to) => {
        foldRange = { from, to }
      })
      if (!foldRange) {
        if (!this.isPinned) this.hidePopover()
        return
      }

      // If the same header is already shown, no-op (avoid re-creating popover on every mousemove).
      if (this.popover && this.currentHeaderLine === line.number) return

      // Switch popover to this header. Pin survives if was set on the same header,
      // but switching to a different header drops the pin — matches global pattern
      // ("re-hovering switches source").
      const wasPinned = this.isPinned && this.currentHeaderLine === line.number
      this.hidePopover()
      this.isPinned = wasPinned
      this.showPopover(line, match, foldRange as { from: number; to: number })
    }

    showPopover(
      line: { from: number; to: number; number: number; text: string },
      headerMatch: RegExpMatchArray,
      foldRange: { from: number; to: number }
    ) {
      const indentLen = headerMatch[1].length
      const headerVisualIndent = visualIndentOf(headerMatch[1])
      const bodyText = this.view.state.sliceDoc(foldRange.from, foldRange.to)
      // sliceDoc starts with the trailing \n of the header — drop it.
      const cleanBody = bodyText.startsWith('\n') ? bodyText.slice(1) : bodyText
      if (cleanBody === '') return

      // Parse body lines into {visualIndent, content}. minBodyIndent is the
      // shallowest indent across non-empty lines — that's what the popover's
      // LEFT EDGE will line up with in the editor. Inside the popover, each
      // line gets padding-left = (visualIndent - minBodyIndent) ch — so the
      // root body lines have no padding (text flush to popover's left edge,
      // visually exactly under where they'd sit if expanded), and any deeper
      // sub-items keep their relative offset.
      const rawLines = cleanBody.split('\n')
      const parsed: { visualIndent: number; content: string; empty: boolean }[] = []
      let minBodyIndent = Infinity
      for (const lineText of rawLines) {
        let visualIndent = 0
        let charIdx = 0
        for (; charIdx < lineText.length; charIdx++) {
          const c = lineText.charCodeAt(charIdx)
          if (c === 9) visualIndent += 4 - (visualIndent % 4)
          else if (c === 32) visualIndent++
          else break
        }
        const content = lineText.slice(charIdx)
        const empty = content === ''
        if (!empty && visualIndent < minBodyIndent) minBodyIndent = visualIndent
        parsed.push({ visualIndent, content, empty })
      }
      if (!isFinite(minBodyIndent)) minBodyIndent = headerVisualIndent

      const el = document.createElement('div')
      el.className = 'cm-collapsible-preview' + (this.isPinned ? ' pinned' : '')
      el.setAttribute('data-collapsible-preview', '')

      // Inherit text color from the editor's content DOM rather than hardcoding.
      // Theme/scope plugins paint headers in special colors, but body lines
      // (which are what we're previewing) use the default editor foreground.
      // getComputedStyle on contentDOM returns the resolved default — same shade
      // body would show after manual expand.
      try {
        const editorColor = getComputedStyle(this.view.contentDOM).color
        if (editorColor) el.style.color = editorColor
      } catch {}

      for (const { visualIndent, content, empty } of parsed) {
        const lineEl = document.createElement('div')
        lineEl.className = 'cm-collapsible-preview-line'
        // Indent INSIDE popover only for lines deeper than the body root.
        // First-level body lines render at column 0 of the popover content area.
        const rel = empty ? 0 : Math.max(0, visualIndent - minBodyIndent)
        if (rel > 0) lineEl.style.paddingLeft = `${rel}ch`
        lineEl.textContent = content
        el.appendChild(lineEl)
      }

      // Position: anchor under the first non-whitespace char of the header.
      // coordsAtPos may return null right on a Decoration.replace boundary
      // (the ^^ widget) — walk forward up to a few positions to find a valid one.
      let anchorCoords: { left: number; top: number; bottom: number; right: number } | null = null
      for (let off = indentLen; off <= indentLen + 4 && off <= line.text.length; off++) {
        const c = this.view.coordsAtPos(line.from + off)
        if (c) { anchorCoords = c; break }
      }
      // Fallback: line block geometry
      if (!anchorCoords) {
        const block = this.view.lineBlockAt(line.from)
        const contentRect = this.view.contentDOM.getBoundingClientRect()
        anchorCoords = {
          left: contentRect.left + indentLen * 8,
          top: block.top + contentRect.top,
          bottom: block.bottom + contentRect.top,
          right: contentRect.right
        }
      }

      // Shift popover RIGHT by the delta between body root indent and header
      // indent: so the popover itself stands where body text would. Inside the
      // popover, text is flush to its left edge (no per-line padding for root
      // lines). This matches "от модалки отступ на ширину таба, а не наоборот".
      const chWidth = this.view.defaultCharacterWidth || 8
      const bodyOffsetCols = Math.max(0, minBodyIndent - headerVisualIndent)
      const xShift = bodyOffsetCols * chWidth
      // Also subtract popover padding so visual text aligns with the body's X,
      // not the popover border's X.
      const popoverPaddingPx = 12 // matches .cm-collapsible-preview { padding: 8px 12px }
      const leftPx = anchorCoords.left + xShift - popoverPaddingPx

      el.style.left = `${Math.round(Math.max(4, leftPx))}px`
      el.style.top = `${Math.round(anchorCoords.bottom + 4)}px`
      document.body.appendChild(el)

      // Положение и высота: считаем доступное место СВЕРХУ и СНИЗУ от header.
      // Выбираем сторону с большим запасом, ставим max-height = (space - margin)
      // чтобы поповер никогда не перекрывал header и не вылезал за viewport.
      // Если оба направления маленькие — берём максимум доступного и включаем
      // внутренний скролл. unpinned тоже скроллится (для длинных блоков).
      requestAnimationFrame(() => {
        if (!el.isConnected) return
        const rect = el.getBoundingClientRect()

        // X-clamp: сдвинуть влево если правая граница вылезла
        if (rect.right > window.innerWidth - 8) {
          const shifted = Math.max(8, window.innerWidth - 8 - rect.width)
          el.style.left = `${shifted}px`
        }

        const gap = 4
        const margin = 8
        const headerTop = anchorCoords!.top
        const headerBottom = anchorCoords!.bottom
        const spaceBelow = window.innerHeight - margin - (headerBottom + gap)
        const spaceAbove = (headerTop - gap) - margin
        const needed = rect.height
        const placeBelow = needed <= spaceBelow || spaceBelow >= spaceAbove

        // Скролл включаем только для pinned (unpinned pointer-events:none не
        // позволит крутить колесо в любом случае). Высота динамическая в обоих
        // режимах: unpinned просто обрежется по max-height.
        if (placeBelow) {
          const maxH = Math.max(40, spaceBelow)
          el.style.top = `${Math.round(headerBottom + gap)}px`
          el.style.maxHeight = `${Math.round(maxH)}px`
        } else {
          const maxH = Math.max(40, spaceAbove)
          const effH = Math.min(needed, maxH)
          el.style.top = `${Math.round(headerTop - gap - effH)}px`
          el.style.maxHeight = `${Math.round(maxH)}px`
        }
      })

      this.popover = el
      this.currentHeaderLine = line.number
      console.log('[Collapsible:Preview] show',
        { headerLine: line.number, bodyLen: cleanBody.length,
          left: el.style.left, top: el.style.top, pinned: this.isPinned })
    }

    hidePopover() {
      if (this.popover) {
        this.popover.remove()
        console.log('[Collapsible:Preview] hide',
          { headerLine: this.currentHeaderLine, wasPinned: this.isPinned })
      }
      this.popover = null
      this.currentHeaderLine = null
      // hide does NOT unpin — pin is dropped explicitly via togglePin / unpinAndHide
    }

    togglePin() {
      this.isPinned = !this.isPinned
      if (this.popover) {
        this.popover.classList.toggle('pinned', this.isPinned)
      }
      console.log('[Collapsible:Preview] pin toggle',
        { isPinned: this.isPinned, headerLine: this.currentHeaderLine })
    }

    /**
     * Rising-edge pin toggle for the Cmd+Shift chord, shared by the keyboard
     * and mouse channels. Returns true iff it actually toggled (so a keyboard
     * caller can preventDefault). The `chordEngaged` latch makes it idempotent
     * while the chord stays held — both channels can observe the same physical
     * press without double-toggling, and on the unfocused window it collapses
     * "chord held across N mousemoves" into a single toggle.
     *
     * ⚠️ The latch engages ONLY when it actually toggles. Earlier it engaged on
     * the rising edge regardless — which burned the edge when the chord arrived
     * before any popover existed (the unfocused mouse-first gesture: move onto a
     * folded header with Cmd+Shift already held → first mousemove has no popover
     * yet → latch consumed → every later mousemove short-circuits → never pins).
     * By only engaging on a real toggle, a chord held over non-header space waits
     * harmlessly until a popover appears, then pins on that event. Callers MUST
     * therefore invoke this AFTER showing/updating the popover (see mousemove).
     */
    maybeToggleChord(chordActive: boolean): boolean {
      if (!chordActive) { this.chordEngaged = false; return false }
      if (this.chordEngaged) return false
      if (this.popover || this.isPinned) {
        this.chordEngaged = true
        this.togglePin()
        return true
      }
      return false // nothing to act on — do NOT burn the rising edge
    }

    unpinAndHide() {
      this.isPinned = false
      this.hidePopover()
    }

    destroy() {
      this.hidePopover()
      this.isPinned = false
      document.removeEventListener('keydown', this._onKeyDown, true)
      document.removeEventListener('keyup', this._onKeyUp, true)
      document.removeEventListener('mousedown', this._onMouseDown, true)
      window.removeEventListener('blur', this._onWindowBlur)
    }
  }, {
    eventHandlers: {
      mousemove(e: MouseEvent, view: EditorView) {
        this.lastMouseX = e.clientX
        this.lastMouseY = e.clientY

        const chord = (e.metaKey || e.ctrlKey) && e.shiftKey

        // DIAG (temporary): log the modifier tuple delivered in mouse events on
        // this window, but only when it CHANGES (mousemove is a hot path). This
        // is how we confirm shiftKey IS delivered on an unfocused floating
        // window. Remove once the pin chord is confirmed working live.
        {
          const sig = `${e.metaKey?1:0}${e.shiftKey?1:0}${e.ctrlKey?1:0}`
          if (sig !== this._lastModSig) {
            this._lastModSig = sig
            console.log('[Collapsible:Chord] mousemove mods',
              { meta: e.metaKey, shift: e.shiftKey, ctrl: e.ctrlKey,
                hasFocus: document.hasFocus(), pinned: this.isPinned,
                hasPopover: !!this.popover })
          }
        }

        // Keep the popover state in sync with the hover position FIRST, then
        // evaluate the pin chord — so on the unfocused window (where the mouse
        // channel is the ONLY channel: no keydown ever arrives) the popover
        // already exists when the chord is read on this same event. Doing it the
        // other way burned the latch's rising edge before any popover existed →
        // never pinned. Pin freezes the target, so skip the resync while pinned.
        if (!this.isPinned) {
          // Self-heal stale cache: if event flag disagrees with cache, the truth
          // is the event (e.g. window.blur listener didn't fire on Cmd+Tab in
          // some corner). Belt-and-suspenders to the blur reset.
          if (this.metaDown && !e.metaKey) this.metaDown = false
          const metaActive = e.metaKey || this.metaDown
          if (!metaActive) {
            if (this.popover) this.hidePopover()
          } else {
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
            if (pos === null) this.hidePopover()
            else this.evaluateAndShow(pos)
          }
        }

        // Cmd+Shift pin chord — MOUSE channel. On an unfocused floating project
        // window (Path 3, see fix-macos-platform.md) keyboard events never
        // arrive, but the lifted window level lets mouse events carry real
        // modifier flags. So the chord the keyboard handler reads on a focused
        // window is mirrored here from e.metaKey/e.shiftKey. The shared
        // `chordEngaged` latch dedupes against the keyboard channel on a focused
        // window AND collapses "chord held across N mousemoves" into one toggle.
        // Evaluated LAST and unconditionally (also while pinned, so the chord can
        // UNPIN); a chord-false mousemove re-arms the latch (no keyup reaches
        // this window). maybeToggleChord only engages the latch on a real toggle,
        // so holding the chord over empty space until a header appears still pins.
        this.maybeToggleChord(chord)
      },
      mouseleave() {
        if (!this.isPinned) this.hidePopover()
      }
    }
  })
}
