import { ViewPlugin, Decoration, DecorationSet, EditorView } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import {
  AnchorIndex,
  buildAnchorIndex,
  parseAnchorFragment,
  resolveAnchor,
  AnchorEntry
} from './anchorIndex'
import { buildFencedLineSet, isPositionInsideInlineCode } from './directiveGuard'

/**
 * anchorLink plugin
 *
 * Recognises markdown links whose URL contains a `#anchor` fragment and styles them:
 *   - `.cm-anchor-link`        — resolvable, valid target
 *   - `.cm-anchor-broken`      — unknown anchor (red underline)
 *   - `.cm-anchor-duplicate`   — multiple matches (orange underline)
 *
 * Supported URL shapes:
 *   - `#frag`               — same file
 *   - `./relative.md#frag`  — cross-file
 *   - `relative.md#frag`    — cross-file
 *
 * Does NOT use Decoration.replace — the standard markdown link parser still owns
 * the `[text](url)` rendering. We add a `mark` decoration over the visible "text"
 * part, plus class flags that the click handler reads to decide what to do.
 *
 * Cross-file targets are resolved via the async `getCrossFileAnchors` config — the
 * plugin caches the index per-path. The first lookup returns "unknown" (renders as
 * link, not broken — neutral), then the cache fills and a redecorate transaction
 * is dispatched. This avoids flashing red on first paint.
 */

export interface AnchorLinkConfig {
  /**
   * Resolve a link URL like `./other.md` or `../foo.md` to an absolute path
   * suitable for `getCrossFileAnchors`. Returns null if the URL is not a file
   * link we can resolve in this context.
   */
  resolveCrossFilePath?: (relativePath: string) => string | null
  /**
   * Read the anchor index for a cross-file path. Cached by absolute path inside
   * the plugin; called at most once per path until invalidated externally.
   */
  getCrossFileAnchors?: (absolutePath: string) => Promise<AnchorIndex | null>
  /**
   * Called when user Cmd+Clicks an anchor link.
   *   - For same-file: `path` is null, only `line` matters.
   *   - For cross-file: `path` is the resolved absolute path, `line` is the
   *     target line in that file (or null if anchor unresolved at click time).
   */
  onNavigate?: (path: string | null, line: number | null) => void
}

const LINK_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)/g

interface ParsedLink {
  textFrom: number    // pos of the [ in [text](...)
  textTo: number      // pos of the ] in [text](...)
  urlFrom: number     // pos of the ( in [text](...)
  urlTo: number       // pos right after the )
  text: string
  url: string
  filePart: string    // empty for same-file links
  fragment: string    // including leading marker (#, ##, ^^, -)
}

function splitUrl(url: string): { filePart: string; fragment: string } | null {
  const hashIdx = url.indexOf('#')
  if (hashIdx === -1) return null
  return {
    filePart: url.slice(0, hashIdx),
    fragment: url.slice(hashIdx + 1)
  }
}

function findLinks(text: string, lineFrom: number): ParsedLink[] {
  const links: ParsedLink[] = []
  const re = new RegExp(LINK_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const split = splitUrl(m[2])
    if (!split) continue
    if (!split.fragment) continue
    const startIdx = m.index
    if (isPositionInsideInlineCode(text, startIdx)) continue
    const linkStart = lineFrom + startIdx
    const textFrom = linkStart
    const textTo = linkStart + 1 + m[1].length // +1 for [
    const urlFrom = textTo + 1                  // skip ]
    const urlTo = linkStart + m[0].length
    links.push({
      textFrom,
      textTo,
      urlFrom,
      urlTo,
      text: m[1],
      url: m[2],
      filePart: split.filePart,
      fragment: split.fragment
    })
  }
  return links
}

type Status = 'ok' | 'broken' | 'duplicate' | 'pending'

function classifyAnchor(
  link: ParsedLink,
  ownIndex: AnchorIndex,
  crossCache: Map<string, AnchorIndex | null>,
  resolveCrossFilePath: ((p: string) => string | null) | undefined
): { status: Status; line: number | null; absPath: string | null; entry?: AnchorEntry } {
  const parsed = parseAnchorFragment(link.fragment)
  if (!parsed) return { status: 'broken', line: null, absPath: null }

  if (link.filePart === '') {
    // Same file
    const r = resolveAnchor(ownIndex, parsed)
    if (r === 'duplicate') return { status: 'duplicate', line: null, absPath: null }
    if (r === null) return { status: 'broken', line: null, absPath: null }
    const key = entryKeyFromParsed(parsed)
    return { status: 'ok', line: r, absPath: null, entry: ownIndex.byKey.get(key) }
  }

  // Cross-file
  const absPath = resolveCrossFilePath ? resolveCrossFilePath(link.filePart) : null
  if (!absPath) return { status: 'broken', line: null, absPath: null }
  if (!crossCache.has(absPath)) return { status: 'pending', line: null, absPath }

  const idx = crossCache.get(absPath)
  if (!idx) return { status: 'broken', line: null, absPath }
  const r = resolveAnchor(idx, parsed)
  if (r === 'duplicate') return { status: 'duplicate', line: null, absPath }
  if (r === null) return { status: 'broken', line: null, absPath }
  const key = entryKeyFromParsed(parsed)
  return { status: 'ok', line: r, absPath, entry: idx.byKey.get(key) }
}

function entryKeyFromParsed(parsed: { type: string; level?: number; slug: string }): string {
  if (parsed.type === 'heading') return `h${parsed.level || 1}:${parsed.slug}`
  if (parsed.type === 'collapsible') return `^^:${parsed.slug}`
  return `-:${parsed.slug}`
}

export function createAnchorLinkPlugin(config: AnchorLinkConfig = {}) {
  // Module-scoped cache shared by every editor instance. Cross-file file contents
  // rarely change at high frequency; if they do, callers can clear by mutating.
  const crossCache = new Map<string, AnchorIndex | null>()
  const inflight = new Set<string>()

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      links: ParsedLink[] = []
      ownIndex: AnchorIndex
      // For the click handler to look up a link at a position
      linkAt: (pos: number) => ParsedLink | null

      constructor(view: EditorView) {
        this.ownIndex = buildAnchorIndex(view.state.doc.toString())
        this.decorations = this.build(view)
        this.linkAt = (pos: number) => this.findLinkAt(pos)
      }

      update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
        if (update.docChanged) {
          this.ownIndex = buildAnchorIndex(update.view.state.doc.toString())
        }
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.build(update.view)
        }
      }

      build(view: EditorView): DecorationSet {
        const decos: { from: number; to: number; deco: Decoration }[] = []
        const doc = view.state.doc
        const fenced = buildFencedLineSet(view.state)
        const links: ParsedLink[] = []

        for (let i = 1; i <= doc.lines; i++) {
          if (fenced.has(i)) continue
          const line = doc.line(i)
          const lineLinks = findLinks(line.text, line.from)
          for (const link of lineLinks) {
            const cls = classifyAnchor(link, this.ownIndex, crossCache, config.resolveCrossFilePath)

            // Trigger cross-file load if needed
            if (cls.status === 'pending' && cls.absPath && !inflight.has(cls.absPath)) {
              inflight.add(cls.absPath)
              const path = cls.absPath
              ;(async () => {
                try {
                  const idx = config.getCrossFileAnchors
                    ? await config.getCrossFileAnchors(path)
                    : null
                  crossCache.set(path, idx)
                } catch {
                  crossCache.set(path, null)
                } finally {
                  inflight.delete(path)
                  // Force redecorate
                  view.dispatch({})
                }
              })()
            }

            const className =
              cls.status === 'ok'
                ? 'cm-anchor-link'
                : cls.status === 'duplicate'
                ? 'cm-anchor-link cm-anchor-duplicate'
                : cls.status === 'broken'
                ? 'cm-anchor-link cm-anchor-broken'
                : 'cm-anchor-link cm-anchor-pending'

            const tooltip = buildHoverText(link, cls)

            decos.push({
              from: link.textFrom + 1, // skip the [
              to: link.textTo,         // up to the ]
              deco: Decoration.mark({
                class: className,
                attributes: {
                  'data-anchor-status': cls.status,
                  'data-anchor-line': cls.line != null ? String(cls.line) : '',
                  'data-anchor-path': cls.absPath || '',
                  title: tooltip
                }
              })
            })

            links.push(link)
          }
        }

        this.links = links
        decos.sort((a, b) => a.from - b.from || a.to - b.to)
        return Decoration.set(decos.map(d => d.deco.range(d.from, d.to)))
      }

      findLinkAt(pos: number): ParsedLink | null {
        for (const l of this.links) {
          if (pos >= l.textFrom && pos <= l.urlTo) return l
        }
        return null
      }
    },
    {
      decorations: v => v.decorations
    }
  )
}

function buildHoverText(link: ParsedLink, cls: { status: Status; line: number | null; entry?: AnchorEntry }): string {
  const fragment = link.fragment
  const filePart = link.filePart || '(this file)'
  if (cls.status === 'ok') {
    const linePart = cls.line ? ` :${cls.line}` : ''
    const preview = cls.entry ? ` — ${cls.entry.rawText.trim().slice(0, 80)}` : ''
    return `${filePart}#${fragment}${linePart}${preview}`
  }
  if (cls.status === 'duplicate') {
    return `Duplicate anchor: multiple matches for #${fragment}`
  }
  if (cls.status === 'broken') {
    return `Anchor not found: #${fragment}`
  }
  return `Resolving #${fragment}…`
}

/**
 * Click handler — Cmd+Click on a `.cm-anchor-link` span navigates.
 * Same-file: scroll via the editor itself. Cross-file: delegate to onNavigate.
 */
export function createAnchorLinkClickHandler(config: AnchorLinkConfig = {}) {
  return Prec.highest(EditorView.domEventHandlers({
    mousedown(event: MouseEvent, view: EditorView) {
      if (!event.metaKey && !event.ctrlKey) return false
      const target = event.target as HTMLElement | null
      console.log('[AnchorClick] mousedown cmd', { tag: target?.tagName, cls: target?.className, closest: !!target?.closest?.('.cm-anchor-link') })
      if (!target) return false
      const anchorEl = target.closest('.cm-anchor-link') as HTMLElement | null
      if (!anchorEl) return false

      const status = anchorEl.getAttribute('data-anchor-status') || ''
      console.log('[AnchorClick] hit', { status, line: anchorEl.getAttribute('data-anchor-line'), path: anchorEl.getAttribute('data-anchor-path') })
      if (status === 'broken' || status === 'duplicate') {
        event.preventDefault()
        event.stopPropagation()
        return true
      }

      const lineStr = anchorEl.getAttribute('data-anchor-line') || ''
      const path = anchorEl.getAttribute('data-anchor-path') || ''
      const line = lineStr ? parseInt(lineStr, 10) : null

      event.preventDefault()
      event.stopPropagation()

      if (path) {
        config.onNavigate?.(path, line)
      } else if (line) {
        // Same-file scroll
        const doc = view.state.doc
        if (line >= 1 && line <= doc.lines) {
          const target = doc.line(line)
          view.dispatch({
            selection: { anchor: target.from },
            effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
            scrollIntoView: true
          })
          view.focus()
        }
      }
      return true
    }
  }))
}
