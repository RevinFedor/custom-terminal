import { lineNumbers, GutterMarker } from '@codemirror/view'
import { foldedRanges, foldEffect, unfoldEffect, foldable } from '@codemirror/language'

export interface IncludeOffset {
  editorLine: number  // 1-based line number in editor
  diskLines: number   // how many lines this block takes on disk
}

/**
 * Create lineNumbers gutter with:
 * - Virtual line numbers (accounting for transclusion)
 * - Fold/unfold on click for collapsible headers
 */
export function createLineNumbersWithVirtual(offsets: IncludeOffset[] = []) {
  return lineNumbers({
    formatNumber: (editorLine: number) => {
      let diskLine = editorLine
      for (const offset of offsets) {
        if (editorLine > offset.editorLine) {
          diskLine += offset.diskLines  // hidden block lines (BEGIN+content+END) not visible in editor
        }
      }
      return String(diskLine)
    },
    domEventHandlers: {
      // mousedown to prevent text selection
      mousedown(view, line, event) {
        const lineObj = view.state.doc.lineAt(line.from)
        const text = lineObj.text.trim()

        // Fold/unfold logic for >> (expanded) or ^^ (collapsed) headers
        if (text.startsWith('>>') || text.startsWith('^^')) {
          let isFolded = false
          let foldedRange: { from: number; to: number } | null = null

          foldedRanges(view.state).between(line.from, line.to, (from, to) => {
            isFolded = true
            foldedRange = { from, to }
          })

          // Find marker position for replacement
          const lineText = lineObj.text
          const createMarkerChange = (fromMarker: string, toMarker: string) => {
            const idx = lineText.indexOf(fromMarker)
            if (idx === -1) return null
            return { from: lineObj.from + idx, to: lineObj.from + idx + 2, insert: toMarker }
          }

          if (isFolded && foldedRange) {
            // Unfold: ^^ -> >>
            const change = createMarkerChange('^^', '>>')
            view.dispatch({
              effects: unfoldEffect.of(foldedRange),
              changes: change ? [change] : undefined
            })
          } else {
            const range = foldable(view.state, line.from, line.to)
            if (range && (range.to - range.from) > 2) {
              // Fold: >> -> ^^
              const change = createMarkerChange('>>', '^^')
              view.dispatch({
                effects: foldEffect.of(range),
                changes: change ? [change] : undefined
              })
            }
          }

          event.preventDefault()
          event.stopPropagation()
          return true
        }

        return false
      }
    }
  })
}

// Legacy export for backwards compatibility (no virtual line numbers)
export const lineNumbersWithFold = createLineNumbersWithVirtual([])