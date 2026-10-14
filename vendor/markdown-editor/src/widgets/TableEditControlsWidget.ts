import { EditorSelection } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { editMarkdownTable } from '../plugins/markdownTables'

export class TableEditControlsWidget extends WidgetType {
  constructor(readonly from: number) { super() }
  eq(other: TableEditControlsWidget) { return this.from === other.from }
  get estimatedHeight() { return 15 }

  toDOM(view: EditorView) {
    const strip = document.createElement('div')
    strip.className = 'cm-markdown-table-source-controls'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-markdown-table-edge-action'
    button.textContent = 'Готово'
    button.title = 'Завершить редактирование и показать таблицу'
    button.setAttribute('aria-label', 'Завершить редактирование таблицы')
    button.onmousedown = event => { event.preventDefault(); event.stopPropagation() }
    button.onclick = event => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({ effects: editMarkdownTable.of(null), selection: EditorSelection.cursor(this.from), userEvent: 'select.table.read' })
      const preview = view.dom.querySelector(`[data-markdown-table-from="${this.from}"]`) as HTMLElement | null
      if (preview) preview.focus({ preventScroll: true })
      else view.focus()
    }
    strip.appendChild(button)
    return strip
  }

  ignoreEvent() { return true }
}
