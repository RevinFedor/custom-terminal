import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'

/**
 * Manual Layer Selection Plugin
 * Replaces native drawSelection with a custom layer to allow:
 * 1. Full-width background for selected lines (VS Code style).
 * 2. Precise text selection for partial ranges.
 */

interface SelectionRect {
  type: 'full' | 'partial'
  top: number
  height: number
  left: number
  width: number
}

export const fullLineSelectionPlugin = ViewPlugin.fromClass(
  class {
    layer: HTMLElement
    view: EditorView
    
    constructor(view: EditorView) {
      this.view = view
      this.layer = document.createElement('div')
      this.layer.className = 'cm-custom-selection-layer'
      this.layer.setAttribute('aria-hidden', 'true')
      view.scrollDOM.appendChild(this.layer)
      this.measureAndDraw()
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) {
        this.measureAndDraw()
      }
    }

    destroy() {
      this.layer.remove()
    }

    measureAndDraw() {
      this.view.requestMeasure({
        read: (view) => this.readSelections(view),
        write: (rects) => {
          if (rects && rects.length > 0) {
            this.drawSelections(rects)
          } else {
            this.layer.textContent = ''
          }
        }
      })
    }

    readSelections(view: EditorView): SelectionRect[] {
      const { selection, doc } = view.state

      if (selection.main.empty) return []

      const rects: SelectionRect[] = []

      try {
        const parentRect = view.scrollDOM.getBoundingClientRect()
        const scrollLeft = view.scrollDOM.scrollLeft
        const scrollTop = view.scrollDOM.scrollTop

        const toRelative = (r: DOMRect) => {
          return {
            left: r.left - parentRect.left + scrollLeft,
            top: r.top - parentRect.top + scrollTop,
            width: r.width,
            height: r.height
          }
        }

        for (const range of selection.ranges) {
          if (range.empty) continue

          const startLine = doc.lineAt(range.from)
          const endLine = doc.lineAt(range.to)

          for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
            const line = doc.line(lineNum)
            if (lineNum === endLine.number && range.to === line.from) continue

            const coversStart = range.from <= line.from
            const isLastLine = (line.from + line.length) === doc.length
            const coversEnd = isLastLine ? range.to >= line.to : range.to > line.to

            if (coversStart && coversEnd) {
              try {
                  const domInfo = view.domAtPos(line.from)
                  let lineEl = domInfo.node
                  while (lineEl && lineEl !== view.contentDOM) {
                      if (lineEl.nodeType === 1 && (lineEl as HTMLElement).classList.contains('cm-line')) break
                      lineEl = lineEl.parentElement!
                  }

                  if (lineEl && (lineEl as HTMLElement).classList.contains('cm-line')) {
                     const el = lineEl as HTMLElement
                     const lineRect = el.getBoundingClientRect()

                     const style = window.getComputedStyle(el)
                     const pLeft = parseFloat(style.paddingLeft) || 0
                     const tIndent = parseFloat(style.textIndent) || 0
                     const visualOffset = pLeft + tIndent

                     const left = lineRect.left + visualOffset - parentRect.left + scrollLeft
                     const top = lineRect.top - parentRect.top + scrollTop
                     const height = lineRect.height

                     rects.push({
                        type: 'full',
                        top,
                        height,
                        left,
                        width: 0
                     })
                  }
              } catch (e) {}
            } else {
              try {
                  const from = Math.max(range.from, line.from)
                  const to = Math.min(range.to, line.to)
                  const start = view.domAtPos(from)
                  const end = view.domAtPos(to)
                  const domRange = document.createRange()
                  domRange.setStart(start.node, start.offset)
                  domRange.setEnd(end.node, end.offset)
                  const clientRects = domRange.getClientRects()
                  for (let i = 0; i < clientRects.length; i++) {
                      const rel = toRelative(clientRects[i])
                      rects.push({ type: 'partial', top: rel.top, height: rel.height, left: rel.left, width: rel.width })
                  }
              } catch (e) {}
            }
          }
        }
      } catch (e) {
        console.error('[FullLineSelection] readSelections failed:', {
          error: e instanceof Error ? e.message : e,
          selectionRanges: selection.ranges.length,
          mainRange: { from: selection.main.from, to: selection.main.to },
          docLength: doc.length
        })
        return []
      }
      return rects
    }

    drawSelections(rects: SelectionRect[]) {
      this.layer.textContent = ''
      for (const r of rects) {
        const el = document.createElement('div')
        el.className = 'cm-custom-selection-rect'
        if (r.type === 'full') {
            el.classList.add('cm-full-line-selection') 
            el.style.top = `${r.top}px`
            el.style.height = `${r.height}px`
            el.style.left = `${r.left}px`
            el.style.right = '0'
        } else {
            el.classList.add('cm-partial-selection')
            el.style.top = `${r.top}px`
            el.style.height = `${r.height}px`
            el.style.left = `${r.left}px`
            el.style.width = `${r.width}px`
        }
        this.layer.appendChild(el)
      }
    }
  }
)

export function customFullLineSelection() {
  return [fullLineSelectionPlugin]
}
