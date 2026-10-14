/**
 * Shared right-click context-menu for file-pointing widgets:
 *   @include (📎 blue), @embedding (🧠 pink), @link (🔗 green).
 *
 * Three items:
 *   - Open                — open the file in a new tab in the current window
 *   - Open in Finder      — shell.showItemInFolder(absPath)
 *   - Copy Path           — clipboard.writeText(absPath)
 *
 * Visual: re-uses `.context-menu` + `.context-menu-item` + `.context-menu-divider`
 * classes from `src/styles/main.css` so it matches Sidebar RMB menu.
 */

export interface WidgetContextMenuConfig {
  /** Absolute path on disk. Caller is responsible for resolving relative paths. */
  absolutePath: string
  /** Open the file (new tab in current window). */
  onOpen?: (absolutePath: string) => void
  /** Reveal in Finder via shell.showItemInFolder. */
  onReveal?: (absolutePath: string) => void
  /** Copy the absolute path to clipboard. */
  onCopyPath?: (absolutePath: string) => void
}

let activeMenu: HTMLDivElement | null = null
let cleanup: (() => void) | null = null

function closeMenu() {
  if (cleanup) {
    cleanup()
    cleanup = null
  }
  if (activeMenu) {
    activeMenu.remove()
    activeMenu = null
  }
}

export function showWidgetContextMenu(x: number, y: number, config: WidgetContextMenuConfig) {
  closeMenu()

  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.setAttribute('data-widget-context-menu', 'true')
  // Positioning matches Sidebar's useClampedPosition behavior — clamp to viewport.
  menu.style.position = 'fixed'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  menu.style.zIndex = '99999'
  menu.style.visibility = 'hidden'

  const mkItem = (label: string, handler: () => void) => {
    const el = document.createElement('div')
    el.className = 'context-menu-item'
    el.textContent = label
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      closeMenu()
      handler()
    })
    return el
  }

  menu.appendChild(mkItem('Open', () => config.onOpen?.(config.absolutePath)))
  menu.appendChild(mkItem('Open in Finder', () => config.onReveal?.(config.absolutePath)))
  const divider = document.createElement('div')
  divider.className = 'context-menu-divider'
  menu.appendChild(divider)
  menu.appendChild(mkItem('Copy Path', () => config.onCopyPath?.(config.absolutePath)))

  document.body.appendChild(menu)
  activeMenu = menu

  // Clamp to viewport after measure.
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect()
    let nx = x, ny = y
    if (rect.right > window.innerWidth) nx = window.innerWidth - rect.width - 8
    if (rect.bottom > window.innerHeight) ny = window.innerHeight - rect.height - 8
    menu.style.left = `${Math.max(8, nx)}px`
    menu.style.top = `${Math.max(8, ny)}px`
    menu.style.visibility = 'visible'
  })

  const onMouseDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeMenu()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
    }
  }
  // Defer so the same right-click that opened the menu does not close it.
  setTimeout(() => {
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKey, true)
  }, 0)

  cleanup = () => {
    document.removeEventListener('mousedown', onMouseDown, true)
    document.removeEventListener('keydown', onKey, true)
  }
}

export function showImageContextMenu(x: number, y: number, onCopy: () => void) {
  closeMenu()

  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.setAttribute('data-widget-context-menu', 'true')
  menu.style.position = 'fixed'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  menu.style.zIndex = '99999'
  menu.style.visibility = 'hidden'

  const item = document.createElement('div')
  item.className = 'context-menu-item'
  item.textContent = 'Copy'
  item.addEventListener('click', (e) => {
    e.stopPropagation()
    e.preventDefault()
    closeMenu()
    onCopy()
  })
  menu.appendChild(item)

  document.body.appendChild(menu)
  activeMenu = menu

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect()
    let nx = x, ny = y
    if (rect.right > window.innerWidth) nx = window.innerWidth - rect.width - 8
    if (rect.bottom > window.innerHeight) ny = window.innerHeight - rect.height - 8
    menu.style.left = `${Math.max(8, nx)}px`
    menu.style.top = `${Math.max(8, ny)}px`
    menu.style.visibility = 'visible'
  })

  const onMouseDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeMenu()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
    }
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKey, true)
  }, 0)

  cleanup = () => {
    document.removeEventListener('mousedown', onMouseDown, true)
    document.removeEventListener('keydown', onKey, true)
  }
}

export function hideWidgetContextMenu() {
  closeMenu()
}
