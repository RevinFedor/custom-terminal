import { CompletionContext, CompletionResult, Completion, autocompletion } from '@codemirror/autocomplete'
import { buildAnchorIndex, AnchorIndex, AnchorEntry, buildFragment } from './anchorIndex'

/**
 * Autocomplete `[text](#...)` and `[text](./file.md#...)` fragments.
 *
 * Triggers when the cursor is positioned right after `#` inside a link URL.
 * Suggestions:
 *   - All headings (`##slug`, `###slug`, …)
 *   - All collapsible scopes (`^^slug`)
 *   - All bullets (`-slug`) — first 60 chars only to keep list scannable
 *
 * For cross-file links (`[text](./other.md#…)`), reads the target file via
 * the same getCrossFileAnchors callback the link plugin uses (caches by path).
 */

export interface AnchorCompleteConfig {
  resolveCrossFilePath?: (relativePath: string) => string | null
  getCrossFileAnchors?: (absolutePath: string) => Promise<AnchorIndex | null>
}

const URL_PREFIX_RE = /\]\(([^)\n]*)#([^)\n]*)$/

function entryToCompletion(e: AnchorEntry): Completion {
  const fragment = buildFragment(e)
  const typeLabel =
    e.type === 'heading' ? `h${e.level}` : e.type === 'collapsible' ? '^^' : '-'
  const detail = e.rawText.trim().slice(0, 60)
  return {
    label: fragment,
    detail: `${typeLabel} • L${e.line} • ${detail}`,
    type: 'reference',
    apply: fragment
  }
}

export function createAnchorCompletionSource(config: AnchorCompleteConfig = {}) {
  const cache = new Map<string, AnchorIndex | null>()

  return async function anchorCompletion(ctx: CompletionContext): Promise<CompletionResult | null> {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = line.text.slice(0, ctx.pos - line.from)
    const m = before.match(URL_PREFIX_RE)
    if (!m) return null

    const filePart = m[1]
    const fragmentPart = m[2]

    let index: AnchorIndex | null
    if (filePart === '') {
      index = buildAnchorIndex(ctx.state.doc.toString())
    } else {
      const abs = config.resolveCrossFilePath ? config.resolveCrossFilePath(filePart) : null
      if (!abs) return null
      if (cache.has(abs)) {
        index = cache.get(abs) || null
      } else if (config.getCrossFileAnchors) {
        index = await config.getCrossFileAnchors(abs)
        cache.set(abs, index)
      } else {
        index = null
      }
    }
    if (!index) return null

    const completions: Completion[] = index.all.map(entryToCompletion)

    return {
      from: ctx.pos - fragmentPart.length,
      to: ctx.pos,
      options: completions,
      // Filter & sort by user input
      filter: true,
      validFor: /^[^)#\n]*$/
    }
  }
}

export function createAnchorAutocompletion(config: AnchorCompleteConfig = {}) {
  return autocompletion({
    override: [createAnchorCompletionSource(config)],
    activateOnTyping: true,
    closeOnBlur: true,
    maxRenderedOptions: 50
  })
}
