import { ViewPlugin, Decoration, DecorationSet, EditorView } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { IncludeLinkWidget } from '../widgets/IncludeLinkWidget'
import { buildFencedLineSet, isDirectiveInsideBacktick } from './directiveGuard'

// Pattern: <!-- @include: ./path/to/file.md -->
const INCLUDE_PATTERN = /^<!--\s*@include:\s*(.+?)\s*-->$/

export interface IncludeLinkConfig {
  onOpenFile?: (relativePath: string) => void
  /** Resolve a relative include path to an absolute on-disk path for RMB menu. */
  resolveAbsolute?: (relativePath: string) => string | null
  /** RMB → Open in Finder for the absolute path. */
  onReveal?: (absolutePath: string) => void
  /** RMB → Copy absolute Path to clipboard. */
  onCopyPath?: (absolutePath: string) => void
  /** Existence check (receives absolute path). */
  checkExists?: (absolutePath: string) => Promise<boolean>
}

/**
 * Plugin to display include links as styled inline widgets
 * - Shows widget when cursor is NOT on the line (preview mode)
 * - Shows raw text when cursor IS on the line (edit mode)
 * - Cmd+Click navigates to the included file
 */
export function createIncludeLinkPlugin(config: IncludeLinkConfig = {}) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      cmdPressed = false

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view)
        this.setupCmdListener(view)
      }

      setupCmdListener(view: EditorView) {
        const onKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Meta' || e.key === 'Control') {
            this.cmdPressed = true
            view.contentDOM.classList.add('cm-include-cmd-mode')
          }
        }
        const onKeyUp = (e: KeyboardEvent) => {
          if (e.key === 'Meta' || e.key === 'Control') {
            this.cmdPressed = false
            view.contentDOM.classList.remove('cm-include-cmd-mode')
          }
        }
        const onBlur = () => {
          this.cmdPressed = false
          view.contentDOM.classList.remove('cm-include-cmd-mode')
        }

        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('keyup', onKeyUp)
        window.addEventListener('blur', onBlur)

        // Store cleanup function
        ;(view as any)._includeLinkCleanup = () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('keyup', onKeyUp)
          window.removeEventListener('blur', onBlur)
        }
      }

      destroy() {
        // Cleanup will be called when plugin is destroyed
      }

      update(update: { docChanged: boolean; selectionSet: boolean; focusChanged: boolean; view: EditorView }) {
        // Rebuild when doc changes OR when selection changes OR when focus changes (for edit mode toggle)
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          this.decorations = this.buildDecorations(update.view)
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const decorations: { from: number; to: number; decoration: Decoration }[] = []
        const doc = view.state.doc

        // Get current cursor line(s) - only if editor has focus
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
          const match = line.text.match(INCLUDE_PATTERN)

          if (match) {
            // Skip if this is a documentation example (inside ``` fence or `inline` code)
            if (fenced.has(i)) continue
            if (isDirectiveInsideBacktick(line.text, '<!-- @include:')) continue

            // If cursor is on this line, show raw text (edit mode)
            if (cursorLines.has(i)) {
              continue // Skip decoration - show raw markdown
            }

            const relativePath = match[1].trim()
            const widget = new IncludeLinkWidget(relativePath, config.onOpenFile, {
              resolveAbsolute: config.resolveAbsolute,
              onOpen: config.onOpenFile,
              onReveal: config.onReveal,
              onCopyPath: config.onCopyPath,
              checkExists: config.checkExists,
            })

            // Replace the entire line content with the widget
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
          console.error('[IncludeLink] Error:', e)
          return Decoration.none
        }
      }
    },
    { decorations: v => v.decorations }
  )
}

/**
 * Click handler for Cmd+Click on include links
 * Uses Prec.highest to intercept before CodeMirror default handling
 */
export function createIncludeLinkClickHandler(config: IncludeLinkConfig = {}) {
  return Prec.highest(EditorView.domEventHandlers({
    mousedown(event: MouseEvent, view: EditorView) {
      if (!event.metaKey && !event.ctrlKey) return false

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos === null) return false

      const line = view.state.doc.lineAt(pos)
      const match = line.text.match(INCLUDE_PATTERN)

      if (match && config.onOpenFile) {
        const relativePath = match[1].trim()
        event.preventDefault()
        event.stopPropagation()
        config.onOpenFile(relativePath)
        return true
      }

      return false
    }
  }))
}

/**
 * Resolve all includes in document text
 * Used for "Copy with includes" functionality
 */
export async function resolveAllIncludes(
  docText: string,
  resolveInclude: (relativePath: string) => Promise<string>
): Promise<string> {
  const lines = docText.split('\n')
  const result: string[] = []

  for (const line of lines) {
    const match = line.match(INCLUDE_PATTERN)
    if (match) {
      const relativePath = match[1].trim()
      try {
        const content = await resolveInclude(relativePath)
        result.push(content)
      } catch (e) {
        // If file not found, keep the original line
        result.push(line)
      }
    } else {
      result.push(line)
    }
  }

  return result.join('\n')
}

// Export the pattern for use in context menu
export { INCLUDE_PATTERN }
