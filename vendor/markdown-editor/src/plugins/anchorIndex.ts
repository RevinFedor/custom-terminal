/**
 * Anchor index — resolves [text](#anchor) and [text](./file.md#anchor) refs
 * to actual line numbers in a markdown document.
 *
 * Anchor types are identified by leading marker:
 *   - `##slug`  /  `###slug`     → markdown heading h2/h3 (count of `#` = level)
 *   - `#^^slug`                  → collapsible scope (^^ ...)
 *   - `#-slug`                   → bullet list item (- ...)
 *
 * Slug rules (must match generator and parser deterministically):
 *   - Lowercase
 *   - Cyrillic preserved as-is
 *   - Whitespace → '-'
 *   - Strip markdown emphasis (**bold**, *italic*, `code`, ~~strike~~)
 *   - Strip leading/trailing punctuation
 *   - Multiple dashes collapsed to one
 *
 * For bullets: kebab is built from the FIRST line of the item only.
 */

export type AnchorType = 'heading' | 'collapsible' | 'bullet'

export interface AnchorEntry {
  type: AnchorType
  level?: number      // for headings: 1..6
  slug: string
  line: number        // 1-based
  rawText: string     // original line text for hover preview
}

export interface AnchorIndex {
  byKey: Map<string, AnchorEntry>      // key = anchorKey({type, level, slug})
  duplicates: Set<string>              // keys that appear more than once
  all: AnchorEntry[]                   // for autocomplete listing
}

export function anchorKey(type: AnchorType, level: number | undefined, slug: string): string {
  if (type === 'heading') return `h${level || 1}:${slug}`
  if (type === 'collapsible') return `^^:${slug}`
  return `-:${slug}`
}

/**
 * Slugify a heading/bullet text.
 * Returns lowercase kebab with cyrillic preserved.
 */
export function slugify(text: string): string {
  let s = text
  // Strip markdown emphasis markers (keep inner text)
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/_([^_]+)_/g, '$1')
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  // Strip square-bracket inline marker (e.g. "Heading [links]" → "Heading")
  // We treat [...] suffixes as user-provided ID, not part of the slug text
  // — but slugify is also used on raw user input where they may include the brackets.
  // The caller decides; here we keep brackets — strip below if needed.
  // Lowercase
  s = s.toLowerCase()
  // Replace any whitespace run with single dash
  s = s.replace(/\s+/g, '-')
  // Strip punctuation we don't want in slugs (keep letters/digits/dashes/underscores/cyrillic)
  // Allowed: \p{L} (any letter) \p{N} (digit) - _
  s = s.replace(/[^\p{L}\p{N}\-_]/gu, '')
  // Collapse multiple dashes
  s = s.replace(/-+/g, '-')
  // Trim leading/trailing dashes
  s = s.replace(/^-+|-+$/g, '')
  return s
}

const HEADING_RE = /^(>{2}\s+|[\^]{2}\s+)?(#{1,6})\s+(.+?)\s*$/
const COLLAPSIBLE_RE = /^([\^]{2}|>{2})\s+(?!#)(.+?)\s*$/
const BULLET_RE = /^(\s*)-\s+(.+?)\s*$/
const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/
const TAB_SIZE = 4

function indentColumn(indentText: string): number {
  let col = 0
  for (const ch of indentText) col += ch === '\t' ? TAB_SIZE - (col % TAB_SIZE) : 1
  return col
}

function lineIndentColumn(text: string): number {
  const match = text.match(/^([ \t]*)/)
  return indentColumn(match ? match[1] : '')
}

function computeFenceMask(lines: string[]): boolean[] {
  const mask = new Array(lines.length).fill(false)
  let pending: { line: number; col: number; ch: string; len: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE_RE)
    if (!m) continue

    const info = (m[3] || '').trim()
    const marker = m[2]
    const current = {
      line: i,
      col: indentColumn(m[1]),
      ch: marker[0],
      len: marker.length,
    }

    if (!pending) {
      if (info === '' || /^[A-Za-z0-9_-]+$/.test(info)) pending = current
      continue
    }

    const closes =
      info === '' &&
      current.ch === pending.ch &&
      current.len === pending.len &&
      current.col === pending.col

    if (closes) {
      for (let j = pending.line + 1; j < i; j++) {
        if (lines[j].trim() === '' || lineIndentColumn(lines[j]) >= pending.col) mask[j] = true
      }
      pending = null
      continue
    }

    pending = (info === '' || /^[A-Za-z0-9_-]+$/.test(info)) ? current : null
  }

  return mask
}

/**
 * Build anchor index for a document.
 * Skips lines inside fenced code blocks.
 */
export function buildAnchorIndex(docText: string): AnchorIndex {
  const lines = docText.split('\n')
  const byKey = new Map<string, AnchorEntry>()
  const seen = new Map<string, number>()      // key → count
  const all: AnchorEntry[] = []
  const fenceMask = computeFenceMask(lines)

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (fenceMask[i]) continue

    let entry: AnchorEntry | null = null

    // Try heading first (handles `>> #...` and `^^ #...` collapsible-with-heading too)
    const hm = text.match(HEADING_RE)
    if (hm) {
      const level = hm[2].length
      const inner = hm[3]
      const slug = slugify(inner)
      if (slug) entry = { type: 'heading', level, slug, line: i + 1, rawText: text }
    }

    // Collapsible scope without heading: `^^ name` or `>> name` (and not a heading inside)
    if (!entry) {
      const cm = text.match(COLLAPSIBLE_RE)
      if (cm) {
        const inner = cm[2]
        const slug = slugify(inner)
        if (slug) entry = { type: 'collapsible', slug, line: i + 1, rawText: text }
      }
    }

    // Bullet
    if (!entry) {
      const bm = text.match(BULLET_RE)
      if (bm) {
        const inner = bm[2]
        const slug = slugify(inner)
        if (slug) entry = { type: 'bullet', slug, line: i + 1, rawText: text }
      }
    }

    if (entry) {
      const key = anchorKey(entry.type, entry.level, entry.slug)
      const prev = seen.get(key) ?? 0
      seen.set(key, prev + 1)
      // Keep first occurrence (consistent navigation)
      if (prev === 0) byKey.set(key, entry)
      all.push(entry)
    }
  }

  const duplicates = new Set<string>()
  for (const [k, n] of seen) {
    if (n > 1) duplicates.add(k)
  }

  return { byKey, duplicates, all }
}

/**
 * Parse a fragment string like:
 *   "##my-heading"     → heading h2
 *   "###my-heading"    → heading h3
 *   "^^my-scope"       → collapsible
 *   "-first-bullet"    → bullet
 *
 * Slug part may already be slugified by the user; we re-slugify defensively.
 *
 * Returns null if format is unrecognized.
 */
export function parseAnchorFragment(fragment: string): { type: AnchorType; level?: number; slug: string } | null {
  if (!fragment) return null

  // Headings: leading run of '#' (1..6)
  const h = fragment.match(/^(#{1,6})(.*)$/)
  if (h) {
    const level = h[1].length
    const slug = slugify(h[2])
    if (!slug) return null
    return { type: 'heading', level, slug }
  }

  // Collapsible: ^^...
  if (fragment.startsWith('^^')) {
    const slug = slugify(fragment.slice(2))
    if (!slug) return null
    return { type: 'collapsible', slug }
  }

  // Bullet: -...
  if (fragment.startsWith('-')) {
    const slug = slugify(fragment.slice(1))
    if (!slug) return null
    return { type: 'bullet', slug }
  }

  return null
}

/**
 * Resolve a parsed fragment against an index.
 * Returns:
 *   - line number (1-based) if found uniquely
 *   - 'duplicate' if multiple matches
 *   - null if not found
 */
export function resolveAnchor(
  index: AnchorIndex,
  parsed: { type: AnchorType; level?: number; slug: string }
): number | 'duplicate' | null {
  const key = anchorKey(parsed.type, parsed.level, parsed.slug)
  if (index.duplicates.has(key)) return 'duplicate'
  const entry = index.byKey.get(key)
  return entry ? entry.line : null
}

/**
 * Build a fragment string from a parsed anchor (for serialization / autocomplete).
 *   heading h3 "примеры" → "###примеры"
 *   collapsible "примеры" → "^^примеры"
 *   bullet "first" → "-first"
 */
export function buildFragment(entry: { type: AnchorType; level?: number; slug: string }): string {
  if (entry.type === 'heading') return '#'.repeat(entry.level || 1) + entry.slug
  if (entry.type === 'collapsible') return '^^' + entry.slug
  return '-' + entry.slug
}
