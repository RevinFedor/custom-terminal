import { WidgetType } from '@codemirror/view'
import { showWidgetContextMenu } from '../plugins/widgetContextMenu'

export interface EmbeddingLinkContextCallbacks {
  onOpen?: (absolutePath: string) => void
  onReveal?: (absolutePath: string) => void
  onCopyPath?: (absolutePath: string) => void
  checkExists?: (absolutePath: string) => Promise<boolean>
}

export class EmbeddingLinkWidget extends WidgetType {
  private fileCount: number | null = null

  constructor(
    private readonly path: string,
    private readonly onCountFiles?: (path: string) => Promise<number>,
    private readonly ctxCallbacks: EmbeddingLinkContextCallbacks = {}
  ) {
    super()
  }

  eq(other: EmbeddingLinkWidget) {
    return other.path === this.path
  }

  toDOM() {
    const container = document.createElement('span')
    container.className = 'cm-embedding-link'

    const icon = document.createElement('span')
    icon.className = 'cm-embedding-link-icon'
    icon.textContent = '\u{1F9E0}' // brain emoji
    container.appendChild(icon)

    const pathSpan = document.createElement('span')
    pathSpan.className = 'cm-embedding-link-path'
    pathSpan.textContent = this.path
    container.appendChild(pathSpan)

    // Tooltip with file count — appears on hover
    const tooltip = document.createElement('span')
    tooltip.className = 'cm-embedding-link-tooltip'
    tooltip.textContent = '...'
    container.appendChild(tooltip)

    // Load file count async
    if (this.onCountFiles) {
      this.onCountFiles(this.path).then(count => {
        this.fileCount = count
        tooltip.textContent = `${count} files`
      }).catch(() => {
        tooltip.textContent = 'error'
      })
    }

    container.addEventListener('mouseenter', () => {
      tooltip.classList.add('visible')
    })
    container.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible')
    })

    // Right-click → shared context menu (path is already absolute for @embedding).
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showWidgetContextMenu(e.clientX, e.clientY, {
        absolutePath: this.path,
        onOpen: this.ctxCallbacks.onOpen,
        onReveal: this.ctxCallbacks.onReveal,
        onCopyPath: this.ctxCallbacks.onCopyPath,
      })
    })

    // Async existence check — flip to .not-found if the path is gone.
    if (this.ctxCallbacks.checkExists) {
      this.ctxCallbacks.checkExists(this.path).then(exists => {
        if (!exists) {
          container.classList.add('not-found')
          container.title = `Not found: ${this.path}`
        }
      }).catch(() => {})
    }

    return container
  }

  ignoreEvent() {
    return true
  }
}
