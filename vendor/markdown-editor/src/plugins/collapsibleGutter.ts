import { gutter, GutterMarker } from '@codemirror/view'
import { EditorView } from '@codemirror/view'
import { foldedRanges, foldEffect, unfoldEffect, foldable } from '@codemirror/language'
import { RangeSet } from '@codemirror/state'

// Маркер для collapsible секций
class CollapsibleMarker extends GutterMarker {
  constructor(readonly isOpen: boolean, readonly isEmpty: boolean) {
    super()
  }

  toDOM() {
    const el = document.createElement('div')
    el.className = `cm-fold-marker ${this.isOpen ? 'open' : 'closed'}${this.isEmpty ? ' empty' : ''}`
    el.textContent = this.isOpen ? '▾' : '▸'
    return el
  }
}

const openMarker = new CollapsibleMarker(true, false)
const closedMarker = new CollapsibleMarker(false, false)
const emptyMarker = new CollapsibleMarker(false, true) // пустая секция - всегда "свёрнута" (декоративно)

// Проверяет есть ли контент для сворачивания
function hasContent(view: EditorView, lineFrom: number, lineTo: number): boolean {
  const range = foldable(view.state, lineFrom, lineTo)
  // Если range больше 2 символов - есть контент
  return range !== null && (range.to - range.from) > 2
}

// Проверяет свёрнута ли строка
function isFolded(view: EditorView, lineFrom: number, lineTo: number): boolean {
  let folded = false
  foldedRanges(view.state).between(lineFrom, lineTo, () => {
    folded = true
  })
  return folded
}

export const collapsibleGutter = gutter({
  class: 'cm-foldGutter',

  markers: (view) => {
    const markers: { from: number; marker: GutterMarker }[] = []

    for (let i = 1; i <= view.state.doc.lines; i++) {
      const line = view.state.doc.line(i)
      const text = line.text.trim()

      if (text.startsWith('>>') || text.startsWith('^^')) {
        const hasContentToFold = hasContent(view, line.from, line.to)

        if (!hasContentToFold) {
          // Пустая секция - декоративный маркер
          markers.push({ from: line.from, marker: emptyMarker })
        } else if (isFolded(view, line.from, line.to)) {
          markers.push({ from: line.from, marker: closedMarker })
        } else {
          markers.push({ from: line.from, marker: openMarker })
        }
      }
    }

    return RangeSet.of(markers.map(m => m.marker.range(m.from)))
  },

  domEventHandlers: {
    mousedown(view, line, event) {
      const lineObj = view.state.doc.lineAt(line.from)
      const text = lineObj.text.trim()

      if (!text.startsWith('>>') && !text.startsWith('^^')) return false

      // Проверяем есть ли контент
      const hasContentToFold = hasContent(view, line.from, line.to)
      if (!hasContentToFold) {
        // Пустая секция - ничего не делаем
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
        const range = foldable(view.state, line.from, line.to)
        if (range) {
          view.dispatch({ effects: foldEffect.of(range) })
        }
      }

      event.preventDefault()
      return true
    }
  }
})
