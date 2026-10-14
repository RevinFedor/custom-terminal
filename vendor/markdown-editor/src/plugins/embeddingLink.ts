import { ViewPlugin, Decoration, DecorationSet, EditorView } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { EmbeddingLinkWidget } from '../widgets/EmbeddingLinkWidget'
import { buildFencedLineSet, isDirectiveInsideBacktick } from './directiveGuard'

// Pattern: <!-- @embedding: /absolute/path -->
const EMBEDDING_PATTERN = /^<!--\s*@embedding:\s*(.+?)\s*-->$/

export interface EmbeddingLinkConfig {
  onCountFiles?: (absolutePath: string) => Promise<number>
  onOpen?: (absolutePath: string) => void
  onReveal?: (absolutePath: string) => void
  onCopyPath?: (absolutePath: string) => void
  checkExists?: (absolutePath: string) => Promise<boolean>
}

/**
 * Plugin to display embedding source links as styled inline widgets (pink)
 * Same architecture as includeLink (blue) but for GraphRAG indexing sources
 */
export function createEmbeddingLinkPlugin(config: EmbeddingLinkConfig = {}) {
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
            for (let l = startLine; l <= endLine; l++) {
              cursorLines.add(l)
            }
          }
        }

        // Single O(N) pass; per-line lookup is O(1)
        const fenced = buildFencedLineSet(view.state)

        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i)
          const match = line.text.match(EMBEDDING_PATTERN)

          if (match) {
            if (fenced.has(i)) continue
            if (isDirectiveInsideBacktick(line.text, '<!-- @embedding:')) continue
            if (cursorLines.has(i)) continue

            const absolutePath = match[1].trim()
            const widget = new EmbeddingLinkWidget(absolutePath, config.onCountFiles, {
              onOpen: config.onOpen,
              onReveal: config.onReveal,
              onCopyPath: config.onCopyPath,
              checkExists: config.checkExists,
            })

            decorations.push({
              from: line.from,
              to: line.to,
              decoration: Decoration.replace({ widget })
            })
          }
        }

        decorations.sort((a, b) => a.from - b.from)

        try {
          return Decoration.set(
            decorations.map(d => d.decoration.range(d.from, d.to)),
            true
          )
        } catch (e) {
          return Decoration.none
        }
      }
    },
    { decorations: v => v.decorations }
  )
}

/**
 * Extract all @embedding paths from document text
 */
export function extractEmbeddingPaths(docText: string): string[] {
  const paths: string[] = []
  for (const line of docText.split('\n')) {
    const match = line.match(EMBEDDING_PATTERN)
    if (match) paths.push(match[1].trim())
  }
  return paths
}

export { EMBEDDING_PATTERN }
