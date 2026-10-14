/**
 * Foreign image references pasted as TEXT.
 *
 * Noted Terminal copies an attachment from its composer as a plain-text marker
 * `[imagePath: /abs/path.png]`. Text-only keeps the surrounding words, while a
 * pasteboard that also advertises a bitmap lets receivers choose the bitmap and
 * discard those words. This rewrite turns every durable marker into GT Editor's
 * own inline image token, rendered as the usual `▸ 🖼 image` chip.
 *
 * Only absolute paths are adopted. Relative markers stay ordinary text because
 * GT Editor cannot resolve them against the source application's document.
 */
const FOREIGN_IMAGE_PATH_MARKER = /\[imagePath:\s*([^\]\r\n]+?)\s*\]/gi

// Keep this grammar byte-for-byte aligned with imageField.ts. Clipboard export
// deliberately works on the source markdown rather than on rendered DOM: the
// chip is only a view, while this token is GT Editor's durable image identity.
const GT_IMAGE_MARKER = /!\[([^\]|]*)?(?:\|(\d+))?(\|\+)?\]\(([^)]+)\)/g

export interface PortableImageClipboardText {
  text: string
  converted: number
  partial: number
  handled: boolean
}

export interface PortableImageClipboardRange {
  from: number
  to: number
}

export function adoptForeignImagePathMarkers(text: string): { text: string; adopted: number } {
  let adopted = 0
  const transformed = String(text || '').replace(FOREIGN_IMAGE_PATH_MARKER, (marker, rawPath) => {
    const filePath = String(rawPath || '').trim()
    if (!filePath.startsWith('/')) return marker
    adopted += 1
    return `![image](${filePath})`
  })

  return { text: transformed, adopted }
}

/**
 * Serialize a GT Editor selection for another application.
 *
 * A complete absolute-path image becomes the common text-only wire marker
 * `[imagePath: /abs/path]`. Surrounding text stays in the same clipboard
 * payload. If a selection cuts through such a token, fail visibly instead of
 * exporting a markdown fragment that merely looks like an attachment.
 * Relative image sources remain ordinary markdown because the receiver cannot
 * resolve them independently of this document.
 */
export function buildPortableImageClipboardText(
  sourceText: string,
  selectionStart = 0,
  selectionEnd = sourceText.length,
): PortableImageClipboardText {
  const source = String(sourceText || '')
  const from = Math.max(0, Math.min(source.length, Math.min(selectionStart, selectionEnd)))
  const to = Math.max(from, Math.min(source.length, Math.max(selectionStart, selectionEnd)))

  let cursor = from
  let converted = 0
  let partial = 0
  let output = ''

  for (const match of source.matchAll(GT_IMAGE_MARKER)) {
    const marker = match[0]
    const markerFrom = match.index ?? 0
    const markerTo = markerFrom + marker.length
    const imagePath = String(match[4] || '').trim()

    if (markerTo <= from) continue
    if (markerFrom >= to) break
    if (!imagePath.startsWith('/')) continue

    output += source.slice(cursor, Math.max(cursor, markerFrom))
    const isWholeMarker = markerFrom >= from && markerTo <= to
    if (isWholeMarker) {
      output += `[imagePath: ${imagePath}]`
      converted += 1
    } else {
      output += '[imageError]'
      partial += 1
    }
    cursor = Math.min(markerTo, to)
  }

  output += source.slice(cursor, to)
  return {
    text: output,
    converted,
    partial,
    handled: converted > 0 || partial > 0,
  }
}

/**
 * Apply the portable image contract to CodeMirror's native clipboard output.
 *
 * CodeMirror gives output filters the already-copied text plus the current
 * editor state. For an explicit selection we must serialize against the full
 * source document, not against that fragment alone: only the full source can
 * prove that a selection cut through an image marker and must fail closed.
 * With no explicit selection CodeMirror performs a line-wise copy, so its
 * `copiedText` is already the authoritative payload and can be transformed as
 * a self-contained string.
 */
export function buildPortableImageClipboardOutput(
  sourceText: string,
  copiedText: string,
  ranges: readonly PortableImageClipboardRange[],
  lineBreak = '\n',
): PortableImageClipboardText {
  const explicitRanges = ranges.filter((range) => range.from !== range.to)
  if (explicitRanges.length === 0) {
    return buildPortableImageClipboardText(copiedText)
  }

  const parts = explicitRanges.map((range) => (
    buildPortableImageClipboardText(sourceText, range.from, range.to)
  ))
  const converted = parts.reduce((sum, part) => sum + part.converted, 0)
  const partial = parts.reduce((sum, part) => sum + part.partial, 0)
  const handled = converted > 0 || partial > 0

  if (!handled) {
    return { text: copiedText, converted: 0, partial: 0, handled: false }
  }

  return {
    text: parts.map((part) => part.text).join(lineBreak),
    converted,
    partial,
    handled: true,
  }
}
