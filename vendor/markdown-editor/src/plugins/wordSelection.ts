import { EditorView } from '@codemirror/view'
import { EditorSelection, Extension } from '@codemirror/state'

/**
 * Stable Word Selection via mouseSelectionStyle
 *
 * Problem: CM6's default word-selection flips anchor/head when mouse crosses
 * the midpoint of the selected word during drag. This causes visual cursor jumping.
 *
 * Solution: Override mouseSelectionStyle to lock anchor during word-selection drag.
 * Uses event.detail === 2 to detect double-click (browser-native, no timers needed).
 *
 * Note: When extending selection beyond the original word, direction changes
 * are allowed - this is expected behavior (cursor at start when dragging up/left).
 */

interface WordBoundaries {
  start: number
  end: number
}

// Word character pattern (including Russian letters and hyphens)
const WORD_CHAR = /[\w\-а-яёА-ЯЁ_]/

function getWordAt(view: EditorView, pos: number): WordBoundaries {
  const doc = view.state.doc
  const line = doc.lineAt(pos)
  const lineText = line.text
  const posInLine = Math.max(0, Math.min(pos - line.from, line.length))

  let start = posInLine
  let end = posInLine

  while (start > 0 && WORD_CHAR.test(lineText[start - 1])) start--
  while (end < lineText.length && WORD_CHAR.test(lineText[end])) end++

  return {
    start: line.from + start,
    end: line.from + end
  }
}

function snapToWordBoundary(view: EditorView, pos: number, direction: 'left' | 'right'): number {
  const word = getWordAt(view, pos)
  return direction === 'left' ? word.start : word.end
}

/**
 * Custom mouseSelectionStyle that locks anchor during word-selection drag.
 */
export const stableWordSelection: Extension = EditorView.mouseSelectionStyle.of((view, event) => {
  // Only activate for double-click (word selection)
  if (event.detail !== 2) return null

  const startPos = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (startPos === null) return null

  const originalWord = getWordAt(view, startPos)

  // If clicked on whitespace (no word), don't activate
  if (originalWord.start === originalWord.end) return null

  // Lock anchor at word start (forward selection by default)
  const lockedAnchor = originalWord.start

  // Capture existing ranges for Cmd+double-click multi-cursor
  const isMulti = event.metaKey || event.ctrlKey
  const existingRanges = isMulti ? view.state.selection.ranges.slice() : []

  return {
    get(curEvent: MouseEvent, _extend: boolean, _multiple: boolean) {
      const curPos = view.posAtCoords({ x: curEvent.clientX, y: curEvent.clientY })

      let newRange: import('@codemirror/state').SelectionRange

      if (curPos === null) {
        newRange = EditorSelection.range(lockedAnchor, originalWord.end)
      } else if (curPos < originalWord.start) {
        // Dragging left - extend to word boundary, anchor stays at word end
        const newHead = snapToWordBoundary(view, curPos, 'left')
        newRange = EditorSelection.range(originalWord.end, newHead)
      } else if (curPos > originalWord.end) {
        // Dragging right - extend to word boundary, anchor stays at word start
        const newHead = snapToWordBoundary(view, curPos, 'right')
        newRange = EditorSelection.range(lockedAnchor, newHead)
      } else {
        // Still within original word - keep stable forward selection
        newRange = EditorSelection.range(lockedAnchor, originalWord.end)
      }

      if (existingRanges.length > 0) {
        return EditorSelection.create([...existingRanges, newRange])
      }
      return EditorSelection.create([newRange])
    },

    update(_update: import('@codemirror/view').ViewUpdate) {
      return false
    }
  }
})

// Export as function for consistency with other plugins
export function createStableWordSelection(): Extension {
  return stableWordSelection
}
