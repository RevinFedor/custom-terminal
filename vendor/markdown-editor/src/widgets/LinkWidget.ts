import { WidgetType } from '@codemirror/view'
import { showWidgetContextMenu } from '../plugins/widgetContextMenu'

/**
 * @link — simple "symlink-like" pointer to a file. Unlike @include, does NOT
 * inline content; unlike @embedding, has no GraphRAG semantics. Just a clickable
 * reference (green pilule).
 *
 * Path is stored ABSOLUTE in the document, so no resolveAbs callback is needed.
 */
export interface LinkWidgetCallbacks {
  onOpen?: (absolutePath: string) => void
  onReveal?: (absolutePath: string) => void
  onCopyPath?: (absolutePath: string) => void
  /** Returns true if absolutePath exists on disk. Async — widget updates after. */
  checkExists?: (absolutePath: string) => Promise<boolean>
}

export class LinkWidget extends WidgetType {
  constructor(
    private readonly path: string,
    private readonly callbacks: LinkWidgetCallbacks = {}
  ) {
    super()
  }

  eq(other: LinkWidget) {
    return other.path === this.path
  }

  toDOM() {
    const container = document.createElement('span')
    container.className = 'cm-link-widget'

    const icon = document.createElement('span')
    icon.className = 'cm-link-widget-icon'
    icon.textContent = '\u{1F517}' // 🔗
    container.appendChild(icon)

    const pathSpan = document.createElement('span')
    pathSpan.className = 'cm-link-widget-path'
    pathSpan.textContent = this.path
    container.appendChild(pathSpan)

    // Left-click on the widget body → open. Use Cmd+Click parity with @include
    // (both metaKey/ctrlKey and plain click trigger open — RMB has its own path).
    container.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      this.callbacks.onOpen?.(this.path)
    })

    // Right-click → shared context menu.
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showWidgetContextMenu(e.clientX, e.clientY, {
        absolutePath: this.path,
        onOpen: this.callbacks.onOpen,
        onReveal: this.callbacks.onReveal,
        onCopyPath: this.callbacks.onCopyPath,
      })
    })

    // Async existence check — flip to .not-found if the file is gone.
    if (this.callbacks.checkExists) {
      this.callbacks.checkExists(this.path).then(exists => {
        if (!exists) {
          container.classList.add('not-found')
          container.title = `File not found: ${this.path}`
        }
      }).catch(() => {})
    }

    return container
  }

  ignoreEvent(event: Event) {
    // Let CM6 ignore mousedown + contextmenu so widget handlers fire cleanly.
    return event.type === 'mousedown' || event.type === 'contextmenu'
  }
}
