import { WidgetType } from '@codemirror/view'
import { showImageContextMenu } from '../plugins/widgetContextMenu'
import type { ClipboardAdapter } from '../plugins/clipboardAdapter'

async function copyImageSourceToClipboard(src: string, resolvedSrc: string, clipboard?: ClipboardAdapter) {
  if (clipboard?.writeImageFile) {
    await Promise.resolve(clipboard.writeImageFile(src))
    return
  }

  const ClipboardItemCtor = (globalThis as any).ClipboardItem
  if (!navigator.clipboard?.write || !ClipboardItemCtor) {
    throw new Error('No image clipboard transport available')
  }

  const response = await fetch(resolvedSrc)
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`)
  const blob = await response.blob()
  const type = blob.type || 'image/png'
  await navigator.clipboard.write([new ClipboardItemCtor({ [type]: blob })])
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width: number | null,
    readonly resolveImageUrl?: (src: string) => string,
    readonly isActive: boolean = false,
    readonly clipboard?: ClipboardAdapter
  ) {
    super()
  }

  eq(other: ImageWidget) {
    return (
      other.src === this.src &&
      other.width === this.width
    )
  }

  private resolvedSrc() {
    return this.resolveImageUrl ? this.resolveImageUrl(this.src) : this.src
  }

  private installContextMenu(container: HTMLElement, resolvedSrc: string) {
    container.oncontextmenu = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (typeof (e as any).stopImmediatePropagation === 'function') {
        ;(e as any).stopImmediatePropagation()
      }

      showImageContextMenu(e.clientX, e.clientY, () => {
        copyImageSourceToClipboard(this.src, resolvedSrc, this.clipboard).catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[Image:Copy] failed:', message)
        })
      })
    }
  }

  updateDOM(dom: HTMLElement) {
    if (this.isActive) {
      dom.classList.add('cm-image-active')
    } else {
      dom.classList.remove('cm-image-active')
    }
    const src = this.resolvedSrc()
    // Update width on existing img element when it changes
    const img = dom.querySelector('img')
    if (img) {
      if (img.getAttribute('src') !== src) img.src = src
      if (img.alt !== this.alt) img.alt = this.alt
      if (this.width) {
        img.style.width = `${this.width}px`
      } else {
        img.style.width = ''
      }
    }
    this.installContextMenu(dom, src)
    return true
  }

  toDOM() {
    const container = document.createElement('div')
    container.className = 'cm-image-container' + (this.isActive ? ' cm-image-active' : '')

    const img = document.createElement('img')
    const src = this.resolvedSrc()

    img.src = src
    img.alt = this.alt
    img.className = 'cm-image-widget'

    if (this.width) {
      img.style.width = `${this.width}px`
    }

    img.onerror = () => {
      container.innerHTML = `<span class="cm-image-error">Image not found: ${this.src}</span>`
    }

    container.appendChild(img)
    this.installContextMenu(container, src)

    return container
  }

  ignoreEvent(event: Event) {
    return event.type === 'contextmenu'
  }
}
