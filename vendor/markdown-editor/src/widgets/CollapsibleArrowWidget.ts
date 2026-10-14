import { WidgetType, EditorView } from '@codemirror/view'
import { foldedRanges, foldEffect, unfoldEffect, foldable } from '@codemirror/language'

/**
 * Виджет стрелки сворачивания для collapsible секций (>>)
 * Отображается inline с учётом отступа строки
 */
// Цвет стрелки берётся из тех же CSS-переменных, что и текст (единый источник
// истины — editor.css :root). Меняешь --gt-md-bold в настройках → меняется и
// текст, и эта стрелка. См. editor.css::GT MARKDOWN COLOR TOKENS.
const FORMAT_COLORS: Record<string, string> = {
  bold: 'var(--gt-md-bold)',
  italic: 'var(--gt-md-italic)',
  code: 'var(--gt-md-code)',
  strike: 'var(--gt-md-strike)',
  h1: 'var(--gt-md-h1)',
  h2: 'var(--gt-md-h2)',
  h3: 'var(--gt-md-h3)',
  h4: 'var(--gt-md-h4)',
  h5: 'var(--gt-md-h5)',
  h6: 'var(--gt-md-h6)'
}

export class CollapsibleArrowWidget extends WidgetType {
  constructor(
    readonly indent: string,
    readonly isOpen: boolean,
    readonly isEmpty: boolean,
    readonly lineFrom: number,
    readonly formatType: string | null = null, // 'bold', 'italic', 'code', 'strike'
    readonly view: EditorView | null = null
  ) {
    super()
  }

  toDOM() {
    const arrow = document.createElement('span')
    arrow.className = `cm-collapsible-arrow ${this.isOpen ? 'open' : 'closed'}${this.isEmpty ? ' empty' : ''}`
    arrow.append(document.createTextNode(this.isOpen ? '▾' : '▸'))
    arrow.dataset.lineFrom = String(this.lineFrom)

    // Применяем цвет на основе форматирования
    if (this.formatType && FORMAT_COLORS[this.formatType]) {
      arrow.style.color = FORMAT_COLORS[this.formatType]
    }

    // Handle click directly in widget (events don't bubble to domEventHandlers from widgets)
    arrow.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()

      if (this.isEmpty || !this.view) return

      const line = this.view.state.doc.lineAt(this.lineFrom)
      const range = foldable(this.view.state, line.from, line.to)
      if (!range || (range.to - range.from) <= 2) return

      let foldedRange: { from: number; to: number } | null = null
      foldedRanges(this.view.state).between(line.from, line.to, (from, to) => {
        foldedRange = { from, to }
      })

      if (foldedRange) {
        const markerChange = this.createMarkerChange(line, '^^', '>>')
        this.view.dispatch({
          effects: unfoldEffect.of(foldedRange),
          changes: markerChange ? [markerChange] : undefined
        })
      } else {
        const markerChange = this.createMarkerChange(line, '>>', '^^')
        this.view.dispatch({
          effects: foldEffect.of(range),
          changes: markerChange ? [markerChange] : undefined
        })
      }
    })

    // FIX: Prevent selection on mousedown
    arrow.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })

    return arrow
  }

  eq(other: CollapsibleArrowWidget) {
    return this.indent === other.indent &&
           this.isOpen === other.isOpen &&
           this.isEmpty === other.isEmpty &&
           this.lineFrom === other.lineFrom &&
           this.formatType === other.formatType &&
           this.view === other.view
  }

  /**
   * Create a text change to replace marker (>> <-> ^^)
   */
  private createMarkerChange(line: { from: number; text: string }, fromMarker: string, toMarker: string) {
    const markerIndex = line.text.indexOf(fromMarker)
    if (markerIndex === -1) return null

    return {
      from: line.from + markerIndex,
      to: line.from + markerIndex + fromMarker.length,
      insert: toMarker
    }
  }

  ignoreEvent(event: Event) {
    // Игнорируем события мыши, чтобы CM не пытался ставить курсор или выделять
    // Но клики всё равно пройдут через глобальный handler, так как они всплывают
    if (event.type === 'mousedown' || event.type === 'click' || event.type === 'dblclick') {
        return true
    }
    return false
  }
}

export class CollapsibleLineCountWidget extends WidgetType {
  constructor(
    readonly count: number,
    readonly formatType: string | null = null
  ) {
    super()
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-collapsible-line-count'
    span.append(document.createTextNode(`[${this.count}`))

    const unit = document.createElement('span')
    unit.className = 'cm-collapsible-line-count-unit'
    unit.textContent = 'L'
    span.append(unit, document.createTextNode(']'))

    if (this.formatType && FORMAT_COLORS[this.formatType]) {
      span.style.color = FORMAT_COLORS[this.formatType]
    }

    return span
  }

  eq(other: CollapsibleLineCountWidget) {
    return this.count === other.count && this.formatType === other.formatType
  }

  ignoreEvent() {
    return false
  }
}
