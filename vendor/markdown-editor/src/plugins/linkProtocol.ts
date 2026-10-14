import { ViewPlugin, Decoration, DecorationSet, EditorView } from '@codemirror/view'
import { LinkWidget } from '../widgets/LinkWidget'
import { buildFencedLineSet, isDirectiveInsideBacktick } from './directiveGuard'

// Pattern: <!-- @link: /absolute/path -->
// Path is always absolute. Resolution is trivial — no relative-path math like @include.
const LINK_PATTERN = /^<!--\s*@link:\s*(.+?)\s*-->$/

export interface LinkProtocolConfig {
  onOpen?: (absolutePath: string) => void
  onReveal?: (absolutePath: string) => void
  onCopyPath?: (absolutePath: string) => void
  checkExists?: (absolutePath: string) => Promise<boolean>
}

/**
 * @link widget plugin — green 🔗 pilule pointing to an absolute file path.
 * Same architecture as embeddingLink: line-replace decoration when cursor is
 * not on the line, raw text when editing.
 */
export function createLinkProtocolPlugin(config: LinkProtocolConfig = {}) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view)
      }

      update(update: { docChanged: boolean; selectionSet: boolean; focusChanged: boolean; view: EditorView }) {
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          this.decorations = this.buildDecorations(update.view)
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const decorations: { from: number; to: number; decoration: Decoration }[] = []
        const doc = view.state.doc

        const cursorLines = new Set<number>()
        if (view.hasFocus) {
          for (const range of view.state.selection.ranges) {
            const startLine = doc.lineAt(range.from).number
            const endLine = doc.lineAt(range.to).number
            for (let l = startLine; l <= endLine; l++) cursorLines.add(l)
          }
        }

        const fenced = buildFencedLineSet(view.state)

        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i)
          const match = line.text.match(LINK_PATTERN)
          if (!match) continue
          if (fenced.has(i)) continue
          if (isDirectiveInsideBacktick(line.text, '<!-- @link:')) continue
          if (cursorLines.has(i)) continue

          const absolutePath = match[1].trim()
          const widget = new LinkWidget(absolutePath, {
            onOpen: config.onOpen,
            onReveal: config.onReveal,
            onCopyPath: config.onCopyPath,
            checkExists: config.checkExists,
          })

          decorations.push({
            from: line.from,
            to: line.to,
            decoration: Decoration.replace({ widget }),
          })
        }

        decorations.sort((a, b) => a.from - b.from)

        try {
          return Decoration.set(
            decorations.map(d => d.decoration.range(d.from, d.to)),
            true
          )
        } catch (e) {
          console.error('[LinkProto] decoration build failed:', e)
          return Decoration.none
        }
      }
    },
    { decorations: v => v.decorations }
  )
}

export { LINK_PATTERN }
