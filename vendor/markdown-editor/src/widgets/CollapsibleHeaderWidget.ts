import { WidgetType } from '@codemirror/view'

export class CollapsibleHeaderWidget extends WidgetType {
  private indent: string

  constructor(indent: string = '') {
    super()
    this.indent = indent
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-collapsible-marker'

    // Preserve indent before the marker
    if (this.indent) {
      const indentSpan = document.createElement('span')
      indentSpan.textContent = this.indent
      span.appendChild(indentSpan)
    }

    return span
  }

  eq(other: CollapsibleHeaderWidget) {
    return this.indent === other.indent
  }
}
