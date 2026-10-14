import { WidgetType } from '@codemirror/view'

export class HorizontalRuleWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement('div')
    hr.className = 'cm-horizontal-rule'
    return hr
  }
}
