import { WidgetType, EditorView } from '@codemirror/view'

export class BulletWidget extends WidgetType {
  private indent: string
  private hasChildren: boolean
  private view: EditorView
  private markerStart: number // position of `-` (after indent)
  private markerEnd: number   // position after `- ` (text start)

  constructor(indent: string, hasChildren: boolean = false, view: EditorView, markerStart: number, markerEnd: number) {
    super()
    this.indent = indent
    this.hasChildren = hasChildren
    this.view = view
    this.markerStart = markerStart
    this.markerEnd = markerEnd
  }

  eq(other: BulletWidget) {
    return this.indent === other.indent && this.hasChildren === other.hasChildren
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = `cm-list-bullet ${this.hasChildren ? 'has-children' : ''}`

    // NOTE: the widget replaces ONLY the marker (`markerStart..markerEnd`), not
    // the indent — CM renders the leading whitespace as real text before this
    // widget (same principle as the collapsible `>>` arrow, see
    // fix-codemirror-inline-widgets.md). This keeps the indent OUT of any
    // line-background mark that hugs the content, so per-line backgrounds don't
    // bleed into the indent. We therefore do NOT render an indent span here.
    const iconSpan = document.createElement('span')
    iconSpan.className = 'bullet-icon'
    iconSpan.textContent = '• '
    span.appendChild(iconSpan)

    span.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()

      // Determine left vs right click position relative to bullet icon center
      const iconRect = iconSpan.getBoundingClientRect()
      const iconCenter = iconRect.left + iconRect.width / 2
      const clickedLeft = e.clientX < iconCenter

      // Click on left of bullet → before the dash; right → after `- ` (text start)
      const pos = clickedLeft ? this.markerStart : this.markerEnd
      this.view.dispatch({ selection: { anchor: pos } })
      this.view.focus()
    })

    return span
  }

  ignoreEvent() { return true }
}
