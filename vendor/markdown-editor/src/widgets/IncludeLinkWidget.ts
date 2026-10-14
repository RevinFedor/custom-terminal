import { WidgetType } from '@codemirror/view'
import { showWidgetContextMenu } from '../plugins/widgetContextMenu'

export interface IncludeLinkContextCallbacks {
  /** Open file in a new tab. Receives the original RELATIVE path. */
  onOpen?: (path: string) => void
  /**
   * RMB → Open in Finder / Copy Path require an absolute path.
   * The plugin supplies a resolver that turns the widget's relative path
   * into absolute (resolved against current file's directory).
   */
  resolveAbsolute?: (relativePath: string) => string | null
  onReveal?: (absolutePath: string) => void
  onCopyPath?: (absolutePath: string) => void
  /** Existence check (receives absolute path). */
  checkExists?: (absolutePath: string) => Promise<boolean>
}

export class IncludeLinkWidget extends WidgetType {
  constructor(
    private readonly path: string,
    private readonly onOpenFile?: (path: string) => void,
    private readonly ctxCallbacks: IncludeLinkContextCallbacks = {}
  ) {
    super()
  }

  eq(other: IncludeLinkWidget) {
    return other.path === this.path
  }

  toDOM() {
    const container = document.createElement('span')
    container.className = 'cm-include-link'

    const icon = document.createElement('span')
    icon.className = 'cm-include-link-icon'
    icon.textContent = '📎'
    container.appendChild(icon)

    const pathSpan = document.createElement('span')
    pathSpan.className = 'cm-include-link-path'
    pathSpan.textContent = this.path
    container.appendChild(pathSpan)

    if (this.onOpenFile) {
      const openBtn = document.createElement('button')
      openBtn.className = 'cm-include-link-open'
      openBtn.textContent = '↗'
      openBtn.title = 'Open file'
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        e.preventDefault()
        this.onOpenFile?.(this.path)
      })
      container.appendChild(openBtn)

      // Cmd+Click on the whole widget opens the file
      container.addEventListener('mousedown', (e) => {
        if (e.metaKey || e.ctrlKey) {
          e.stopPropagation()
          e.preventDefault()
          this.onOpenFile?.(this.path)
        }
      })
    }

    // Right-click → shared context menu. Resolve relative→absolute via callback.
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const abs = this.ctxCallbacks.resolveAbsolute?.(this.path) ?? this.path
      showWidgetContextMenu(e.clientX, e.clientY, {
        absolutePath: abs,
        onOpen: () => (this.ctxCallbacks.onOpen ?? this.onOpenFile)?.(this.path),
        onReveal: this.ctxCallbacks.onReveal,
        onCopyPath: this.ctxCallbacks.onCopyPath,
      })
    })

    // Async existence check — resolve relative→absolute, then ping disk.
    if (this.ctxCallbacks.checkExists) {
      const abs = this.ctxCallbacks.resolveAbsolute?.(this.path) ?? this.path
      this.ctxCallbacks.checkExists(abs).then(exists => {
        if (!exists) {
          container.classList.add('not-found')
          container.title = `File not found: ${abs}`
        }
      }).catch(() => {})
    }

    return container
  }

  ignoreEvent(event: Event) {
    // Let CM6 ignore mousedown + contextmenu so the widget's own handlers fire.
    return event.type === 'mousedown' || event.type === 'contextmenu'
  }
}
