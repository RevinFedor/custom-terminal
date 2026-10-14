import { WidgetType } from '@codemirror/view'

export class HiddenWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-hidden-markup'
    return span
  }
}
