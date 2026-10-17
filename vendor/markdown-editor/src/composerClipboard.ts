import type { ClipboardAdapter } from './plugins/clipboardAdapter'

export interface ComposerClipboardPayload {
  text: string
  formats: string[]
  html?: string
}

/**
 * Composer paste has to decide during the trusted keydown whether it owns the
 * gesture. Electron's clipboard API is synchronous, while the browser adapter
 * may return a Promise. An async result cannot safely suppress the native
 * event (doing so would also swallow bitmap paste), so it deliberately falls
 * back to the DOM path.
 */
export function readSynchronousComposerClipboardPayload(
  adapter?: ClipboardAdapter,
): ComposerClipboardPayload | null {
  if (!adapter) return null
  try {
    const value = adapter.readText()
    if (typeof value !== 'string') return null
    const formats = adapter.readFormats?.()
    const html = adapter.readHTML?.()
    return {
      text: value,
      ...(typeof html === 'string' ? { html } : {}),
      formats: Array.isArray(formats)
        ? formats.filter((format): format is string => typeof format === 'string')
        : [],
    }
  } catch {
    return null
  }
}

/**
 * Native paste keeps image priority when a pasteboard advertises both bitmap
 * and text representations. Empty text also belongs to that native path.
 */
export function shouldDeferComposerPasteToNative(
  payload: ComposerClipboardPayload | null,
): boolean {
  if (!payload || !payload.text) return true
  return payload.formats.some((format) => format.toLowerCase().startsWith('image/'))
}
