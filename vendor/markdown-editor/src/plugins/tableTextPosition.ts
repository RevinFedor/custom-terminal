import { decodeString } from 'micromark-util-decode-string'

/** One source offset per rendered UTF-16 boundary. Markers belong to their AST
 * parent; text escapes and entities are decoded here without losing positions. */
export function tableTextOffsets(raw: string, rendered: string, from: number, kind: 'text' | 'code' | 'literal' = 'text') {
  let start = 0, end = raw.length
  if (kind === 'code') {
    const ticks = /^`+/.exec(raw)?.[0].length ?? 0
    start = ticks
    end -= ticks
    const content = raw.slice(start, end).replace(/\r?\n/g, ' ')
    if (content.startsWith(' ') && content.endsWith(' ') && content.trim()) { start++; end-- }
  }
  const offsets: number[] = []
  let shown = 0
  for (let index = start; index < end && shown < rendered.length;) {
    let token = raw[index], length = 1, source = index
    if (kind !== 'literal' && raw[index] === '\\' && index + 1 < end) {
      const escaped = raw.slice(index, index + 2)
      const decoded = kind === 'code' ? (raw[index + 1] === '|' ? '|' : escaped) : decodeString(escaped)
      if (decoded !== escaped) { token = decoded; length = 2; source = index + 1 }
    }
    if (kind === 'text' && raw[index] === '&') {
      const entity = /^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/.exec(raw.slice(index, end))?.[0]
      if (entity && decodeString(entity) !== entity) { token = decodeString(entity); length = entity.length }
    }
    if (kind === 'code' && raw[index] === '\n') token = ' '
    if (rendered.startsWith(token, shown)) {
      for (let unit = 0; unit < token.length; unit++) offsets.push(from + source + (length === token.length ? unit : 0))
      shown += token.length
    }
    index += length
  }
  while (offsets.length < rendered.length) offsets.push(from + end)
  offsets.push(from + end)
  return offsets
}

export function tableDOMPosition(node: Node, offset: number, positions: WeakMap<Node, readonly number[]>): number | null {
  const direct = positions.get(node)
  if (direct) return direct[Math.min(offset, direct.length - 1)]
  const first = (child: Node): number | null => {
    const own = positions.get(child)
    if (own) return own[0]
    for (const nested of Array.from(child.childNodes)) { const value = first(nested); if (value !== null) return value }
    return null
  }
  const last = (child: Node): number | null => {
    const own = positions.get(child)
    if (own) return own[own.length - 1]
    for (const nested of Array.from(child.childNodes).reverse()) { const value = last(nested); if (value !== null) return value }
    return null
  }
  const next = node.childNodes[offset]
  if (next) { const value = first(next); if (value !== null) return value }
  const previous = node.childNodes[offset - 1]
  return previous ? last(previous) : null
}
