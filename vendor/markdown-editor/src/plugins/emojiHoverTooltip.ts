import { EditorView, ViewPlugin } from '@codemirror/view'
import { Extension } from '@codemirror/state'
import type { EmojiShortcut } from './contextMenu'

export interface EmojiHoverTooltipConfig {
  getEmojiShortcuts: () => EmojiShortcut[]
}

// Intl.Segmenter is available in Electron/Chrome but not in older TS lib types
declare namespace Intl {
  class Segmenter {
    constructor(locale?: string, options?: { granularity: 'grapheme' | 'word' | 'sentence' })
    segment(input: string): Iterable<{ segment: string; index: number }>
  }
}

/**
 * ViewPlugin: Cmd+Hover on emoji in editor text → show tooltip with description.
 * Reuses `.cm-emoji-tooltip` CSS class from editor.css.
 *
 * Cursor change uses CSS class `.cm-emoji-hover` on `.cm-editor` wrapper
 * (not inline style on `.cm-content`) because CM6 resets contentDOM styles on update.
 *
 * Meta key is tracked at document level to work regardless of contentDOM focus.
 */
export function createEmojiHoverTooltip(config: EmojiHoverTooltipConfig): Extension {
  // Segmenter for correct grapheme cluster extraction (emoji can be multi-codepoint)
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

  return ViewPlugin.fromClass(class {
    tooltip: HTMLElement | null = null
    currentEmoji: string | null = null
    lastMouseX = 0
    lastMouseY = 0
    // Dynamic <style> tag for cursor override (CM6 resets both .cm-content inline styles
    // AND .cm-editor className on every update cycle, so neither approach survives)
    cursorStyleEl: HTMLStyleElement | null = null
    // Track Meta key at document level (contentDOM keydown requires focus)
    metaDown = false
    private _onKeyDown: (e: KeyboardEvent) => void
    private _onKeyUp: (e: KeyboardEvent) => void
    private _onWindowBlur: () => void
    // Cache: emoji → description (rebuilt when shortcuts change)
    emojiMap: Map<string, string> = new Map()
    lastShortcutsRef: EmojiShortcut[] | null = null

    constructor(private view: EditorView) {
      this._onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Meta') {
          this.metaDown = true
          this.onMetaPress()
        }
      }
      this._onKeyUp = (e: KeyboardEvent) => {
        if (e.key === 'Meta') {
          this.metaDown = false
          this.hideTooltip()
        }
      }
      // Cmd+Tab swallows keyup(Meta); reset cache on focus loss so hover
      // without Cmd doesn't fire the tooltip after return. Same pattern as
      // includeLink.ts.
      this._onWindowBlur = () => {
        if (!this.metaDown) return
        this.metaDown = false
        this.hideTooltip()
      }
      document.addEventListener('keydown', this._onKeyDown)
      document.addEventListener('keyup', this._onKeyUp)
      window.addEventListener('blur', this._onWindowBlur)
    }

    getEmojiMap(): Map<string, string> {
      const shortcuts = config.getEmojiShortcuts()
      if (shortcuts !== this.lastShortcutsRef) {
        this.lastShortcutsRef = shortcuts
        this.emojiMap = new Map()
        for (const s of shortcuts) {
          if (s.description) {
            this.emojiMap.set(s.emoji, s.description)
          }
        }
      }
      return this.emojiMap
    }

    /** Called when Meta is pressed — show tooltip if mouse is already over an emoji */
    onMetaPress() {
      const pos = this.view.posAtCoords({ x: this.lastMouseX, y: this.lastMouseY })
      if (pos === null) return
      const match = this.matchEmojiAt(this.view, pos, this.lastMouseX)
      if (match) {
        this.currentEmoji = match.emoji
        this.showTooltip(match.description, this.lastMouseX, this.lastMouseY)
      }
    }

    showTooltip(description: string, x: number, y: number) {
      this.hideTooltip()
      const el = document.createElement('div')
      el.className = 'cm-emoji-tooltip'
      el.textContent = description
      el.style.left = `${x + 12}px`
      el.style.top = `${y + 12}px`
      document.body.appendChild(el)

      // Adjust if off-screen
      requestAnimationFrame(() => {
        if (!el.isConnected) return
        const rect = el.getBoundingClientRect()
        if (rect.right > window.innerWidth) {
          el.style.left = `${x - rect.width - 4}px`
        }
        if (rect.bottom > window.innerHeight) {
          el.style.top = `${y - rect.height - 4}px`
        }
      })

      this.tooltip = el
    }

    hideTooltip() {
      if (this.tooltip) {
        this.tooltip.remove()
        this.tooltip = null
      }
      this.currentEmoji = null
    }

    setCursorHover(isEmoji: boolean) {
      if (isEmoji) {
        if (!this.cursorStyleEl) {
          this.cursorStyleEl = document.createElement('style')
          this.cursorStyleEl.textContent = '.cm-content { cursor: default !important; }'
          document.head.appendChild(this.cursorStyleEl)
        }
      } else {
        if (this.cursorStyleEl) {
          this.cursorStyleEl.remove()
          this.cursorStyleEl = null
        }
      }
    }

    /**
     * Extract the grapheme cluster at document position `pos` and check if it's an emoji
     * from the shortcuts map. Returns the description or null.
     */
    matchEmojiAt(view: EditorView, pos: number, mouseX: number): { emoji: string; description: string } | null {
      const map = this.getEmojiMap()
      if (map.size === 0) return null

      const doc = view.state.doc
      const from = Math.max(0, pos - 8)
      const to = Math.min(doc.length, pos + 12)
      const slice = doc.sliceString(from, to)

      for (const { segment, index } of segmenter.segment(slice)) {
        const segStart = from + index
        const segEnd = segStart + segment.length
        if (pos >= segStart && pos <= segEnd) {
          const desc = map.get(segment)
          if (desc) {
            // Verify mouse X is within emoji's visual bounds
            const left = view.coordsAtPos(segStart)
            const right = view.coordsAtPos(segEnd, -1)
            if (left && right && mouseX >= left.left && mouseX <= right.right) {
              return { emoji: segment, description: desc }
            }
          }
        }
      }
      return null
    }

    destroy() {
      if (this.cursorStyleEl) {
        this.cursorStyleEl.remove()
        this.cursorStyleEl = null
      }
      this.hideTooltip()
      document.removeEventListener('keydown', this._onKeyDown)
      document.removeEventListener('keyup', this._onKeyUp)
      window.removeEventListener('blur', this._onWindowBlur)
    }
  }, {
    eventHandlers: {
      mousemove(e: MouseEvent, view: EditorView) {
        this.lastMouseX = e.clientX
        this.lastMouseY = e.clientY

        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
        if (pos === null) {
          this.setCursorHover(false)
          this.hideTooltip()
          return
        }

        const match = this.matchEmojiAt(view, pos, this.lastMouseX)

        // Cursor: always default when over emoji, text otherwise
        this.setCursorHover(!!match)

        // Self-heal stale cache (belt-and-suspenders to blur reset).
        if (this.metaDown && !e.metaKey) this.metaDown = false
        const metaActive = e.metaKey || this.metaDown
        if (!metaActive) {
          if (this.tooltip) this.hideTooltip()
          return
        }

        if (match) {
          if (this.currentEmoji !== match.emoji) {
            this.currentEmoji = match.emoji
            this.showTooltip(match.description, e.clientX, e.clientY)
          }
        } else {
          this.hideTooltip()
        }
      },
      mouseleave() {
        this.setCursorHover(false)
        this.hideTooltip()
      }
    }
  })
}
