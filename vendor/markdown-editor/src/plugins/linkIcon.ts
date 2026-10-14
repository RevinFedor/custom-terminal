import { ViewPlugin, Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view'

export interface DomainRule {
  // New shape: array of normalized domains sharing the same icon
  patterns?: string[]
  // Legacy shape (still readable for backwards compat)
  domain?: string
  image: string   // base64 data URI
}

export interface LinkIconConfig {
  /** Returns the current list of domain rules (read fresh on every rebuild) */
  getRules: () => DomainRule[]
}

const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g

function extractHost(url: string): string | null {
  try {
    // Add protocol if missing for URL parsing
    const u = url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`
    const parsed = new URL(u)
    let host = parsed.hostname.toLowerCase()
    if (host.startsWith('www.')) host = host.slice(4)
    return host
  } catch {
    return null
  }
}

function getRulePatterns(rule: DomainRule): string[] {
  if (Array.isArray(rule.patterns)) return rule.patterns
  if (rule.domain) return [rule.domain]
  return []
}

function findIconForHost(host: string, rules: DomainRule[]): string | null {
  // Exact match first
  for (const rule of rules) {
    if (getRulePatterns(rule).some(p => p === host)) return rule.image
  }
  // Subdomain match: rule "example.com" matches "sub.example.com"
  for (const rule of rules) {
    if (getRulePatterns(rule).some(p => host.endsWith('.' + p))) return rule.image
  }
  return null
}

class FaviconWidget extends WidgetType {
  constructor(private readonly src: string, private readonly host: string) {
    super()
  }

  eq(other: FaviconWidget) {
    return other.src === this.src && other.host === this.host
  }

  toDOM() {
    const img = document.createElement('img')
    img.src = this.src
    img.className = 'cm-link-favicon'
    img.alt = this.host
    return img
  }

  ignoreEvent() {
    return true
  }
}

export function createLinkIconPlugin(config: LinkIconConfig) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }

      update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.build(update.view)
        }
      }

      build(view: EditorView): DecorationSet {
        const rules = config.getRules()
        if (rules.length === 0) return Decoration.none

        const decos: { from: number; deco: Decoration }[] = []
        const doc = view.state.doc

        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i)
          const text = line.text
          const regex = new RegExp(linkPattern.source, 'g')
          let m
          while ((m = regex.exec(text)) !== null) {
            const url = m[2]
            const host = extractHost(url)
            if (!host) continue
            const icon = findIconForHost(host, rules)
            if (!icon) continue

            // Insert favicon widget before the [ of [text](url)
            const linkStart = line.from + m.index + 1  // +1 to skip [, place inside
            decos.push({
              from: linkStart,
              deco: Decoration.widget({
                widget: new FaviconWidget(icon, host),
                side: -1
              })
            })
          }
        }

        decos.sort((a, b) => a.from - b.from)
        return Decoration.set(decos.map(d => d.deco.range(d.from)))
      }
    },
    { decorations: v => v.decorations }
  )
}
