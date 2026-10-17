/**
 * ClipboardAdapter — injectable clipboard transport for the markdown editor.
 *
 * WHY THIS EXISTS:
 * The editor's clipboard keymap (clipboard.ts) and context menu (contextMenu.ts)
 * historically called `navigator.clipboard.{readText,writeText,read}` directly.
 * That works in a normal web page, but **fails silently inside an Electron
 * renderer** that has no native Edit menu (role:cut/copy/paste): readText()
 * resolves to '' (or rejects), writeText() rejects, and read() throws. The host
 * app (e.g. custom-terminal) reaches the OS clipboard through Electron's own
 * `clipboard` module instead — but the editor package can't depend on Electron.
 *
 * Solution: the host injects a ClipboardAdapter; every read/write path in the
 * editor routes through it. When no adapter is supplied (pure-web consumers),
 * we fall back to `navigatorClipboardAdapter` so behavior is unchanged there.
 *
 * Mirrors the existing DI seam used for `onImagePaste` / `onGenerateTitle`.
 *
 * Image bytes are NOT handled here — they stay on the native DOM `paste`
 * handler (imagePaste.ts, `event.clipboardData`), which works in Electron
 * without permissions. `readItems` is optional precisely so an Electron host
 * can OMIT it, making the keymap's image-probe branch yield to that DOM handler.
 * The only image WRITE path is optional `writeImageFile`: rendered image
 * previews can ask the host to copy the source file as a real bitmap without
 * teaching the editor package about Electron.
 */
export interface ClipboardItemLike {
  types: string[]
  getType: (type: string) => Promise<Blob>
}

export interface ClipboardAdapter {
  /** Read plain text from the clipboard. May be sync (Electron) or async (web). */
  readText: () => Promise<string> | string
  /** Optional HTML from the same host clipboard transport. */
  readHTML?: () => Promise<string> | string
  /** Write plain text to the clipboard. May be sync (Electron) or async (web). */
  writeText: (text: string) => Promise<void> | void
  /**
   * Synchronous list of native clipboard formats when the host can expose it.
   * ComposerEditor uses this to leave bitmap-bearing payloads on the native
   * DOM paste path and to preserve custom flavors (for example dictated text)
   * while reading plain text through an Electron adapter.
   */
  readFormats?: () => string[]
  /**
   * Read rich clipboard items (used only to detect/extract pasted images in the
   * keymap path). OPTIONAL: when omitted, the keymap image-probe is skipped and
   * images fall through to the DOM `paste` handler (imagePaste.ts). Electron
   * hosts should omit this.
   */
  readItems?: () => Promise<ClipboardItemLike[]>
  /** Copy an image file to the OS clipboard as bitmap data. Electron hosts only. */
  writeImageFile?: (filePath: string) => Promise<void> | void
}

/**
 * Default adapter backed by the Web `navigator.clipboard` API.
 * Used whenever the host does not inject its own adapter (web context).
 */
export const navigatorClipboardAdapter: ClipboardAdapter = {
  readText: () => navigator.clipboard.readText(),
  writeText: (text: string) => navigator.clipboard.writeText(text),
  readItems: () => navigator.clipboard.read() as unknown as Promise<ClipboardItemLike[]>,
}

/** Resolve a config-provided adapter, falling back to the navigator default. */
export function resolveClipboardAdapter(adapter?: ClipboardAdapter): ClipboardAdapter {
  return adapter ?? navigatorClipboardAdapter
}
