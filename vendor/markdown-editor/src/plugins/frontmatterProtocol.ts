import { StateField, StateEffect, RangeSet, EditorState } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView, WidgetType, GutterMarker, gutterLineClass } from '@codemirror/view'
import { buildFencedLineSet, isDirectiveInsideBacktick } from './directiveGuard'

/**
 * Conceals <!-- @ai: ... --> blocks.
 *
 * Format:
 *   <!-- @ai:
 *   any content, 1-100+ lines
 *   -->
 *
 * Or single-line: <!-- @ai: short text -->
 *
 * Strategy:
 * - When cursor is OUTSIDE: first line replaced with widget, rest hidden (display:none + gutter hidden)
 * - When cursor is INSIDE: raw text shown with peach background on entire block
 */

// Matches the opening line: <!-- @ai: (with optional content and optional closing -->)
const AI_OPEN = /^<!--\s*@ai:\s*/
const AI_CLOSE_SINGLE = /^<!--\s*@ai:\s*(.+?)\s*-->$/
const COMMENT_CLOSE = /-->\s*$/

class AiProtocolWidget extends WidgetType {
  constructor(private readonly charCount: number, private readonly preview: string) {
    super()
  }

  eq(other: AiProtocolWidget) {
    return other.charCount === this.charCount && other.preview === this.preview
  }

  toDOM() {
    const container = document.createElement('span')
    container.className = 'cm-ai-protocol'

    const icon = document.createElement('span')
    icon.className = 'cm-ai-protocol-icon'
    icon.textContent = 'AI'
    container.appendChild(icon)

    const label = document.createElement('span')
    label.className = 'cm-ai-protocol-label'
    label.textContent = `[${this.charCount}]`
    container.appendChild(label)
    container.title = this.preview ? `@ai: ${this.preview}` : `@ai: ${this.charCount} chars`

    return container
  }

  ignoreEvent() {
    return false
  }
}

class HiddenGutterMarker extends GutterMarker {
  elementClass = 'cm-frontmatter-hidden'
}
const hiddenGutter = new HiddenGutterMarker()

interface AiBlock {
  startLine: number  // line number of <!-- @ai:
  endLine: number    // line number of -->
  preview: string    // first meaningful content line (for single-line display)
  contentLines: number // number of content lines
  charCount: number  // content chars, excluding <!-- @ai: --> wrapper
}

interface ProtocolState {
  decorations: DecorationSet
  gutterMarkers: RangeSet<GutterMarker>
}

/**
 * Find all <!-- @ai: ... --> blocks in the document.
 * Supports both single-line and multi-line.
 */
function findAiBlocks(state: EditorState): AiBlock[] {
  const doc = state.doc
  const blocks: AiBlock[] = []
  // Single O(N) pass; per-line lookup is O(1) — replaces O(N²) isInFencedCodeBlock loop
  const fenced = buildFencedLineSet(state)

  let i = 1
  while (i <= doc.lines) {
    const lineText = doc.line(i).text

    // Skip lines inside fenced code blocks or where the directive is in inline backticks
    const skipAsExample =
      fenced.has(i) ||
      isDirectiveInsideBacktick(lineText, '<!-- @ai:') ||
      isDirectiveInsideBacktick(lineText, '<!--@ai:')
    if (skipAsExample) {
      i++
      continue
    }

    // Check for single-line: <!-- @ai: some text -->
    const singleMatch = lineText.match(AI_CLOSE_SINGLE)
    if (singleMatch) {
      const content = singleMatch[1].trim()
      blocks.push({
        startLine: i,
        endLine: i,
        preview: content,
        contentLines: 1,
        charCount: content.length
      })
      i++
      continue
    }

    // Check for multi-line opening: <!-- @ai:
    if (AI_OPEN.test(lineText) && !COMMENT_CLOSE.test(lineText)) {
      const startLine = i
      let endLine = -1

      // Search for closing --> within reasonable range
      for (let j = i + 1; j <= Math.min(doc.lines, i + 200); j++) {
        if (COMMENT_CLOSE.test(doc.line(j).text)) {
          endLine = j
          break
        }
      }

      if (endLine !== -1) {
        // Collect content for title + char count, excluding <!-- @ai: --> wrapper.
        const contentParts: string[] = []
        const contentAfterOpen = lineText.replace(AI_OPEN, '').trim()
        if (contentAfterOpen) contentParts.push(contentAfterOpen)
        for (let j = startLine + 1; j < endLine; j++) contentParts.push(doc.line(j).text)
        const closePrefix = doc.line(endLine).text.replace(COMMENT_CLOSE, '').trim()
        if (closePrefix) contentParts.push(closePrefix)

        const firstMeaningful = (contentParts.find(part => part.trim()) || '').trim()
        const preview = firstMeaningful.length > 60 ? firstMeaningful.slice(0, 57) + '...' : firstMeaningful
        const charCount = contentParts.join('\n').trim().length

        blocks.push({
          startLine,
          endLine,
          preview,
          contentLines: endLine - startLine - 1,
          charCount
        })
        i = endLine + 1
        continue
      }
    }

    i++
  }

  return blocks
}

function buildState(state: EditorState, hasFocus: boolean): ProtocolState {
  const empty: ProtocolState = { decorations: Decoration.none, gutterMarkers: RangeSet.empty }
  const doc = state.doc
  const blocks = findAiBlocks(state)
  if (blocks.length === 0) return empty

  // Determine which lines the cursor is on (only when editor is focused —
  // on first render hasFocus=false, so blocks render in concealed mode)
  const cursorLines = new Set<number>()
  if (hasFocus) {
    for (const range of state.selection.ranges) {
      const startLineNum = doc.lineAt(range.from).number
      const endLineNum = doc.lineAt(range.to).number
      for (let l = startLineNum; l <= endLineNum; l++) {
        cursorLines.add(l)
      }
    }
  }

  const decos: any[] = []
  const gutters: any[] = []

  for (const block of blocks) {
    // Check if cursor is inside this block
    let cursorInside = false
    for (let l = block.startLine; l <= block.endLine; l++) {
      if (cursorLines.has(l)) {
        cursorInside = true
        break
      }
    }

    if (cursorInside) {
      // Show raw text with peach background
      const bgLine = Decoration.line({ class: 'cm-frontmatter-active' })
      for (let l = block.startLine; l <= block.endLine; l++) {
        decos.push(bgLine.range(doc.line(l).from))
      }
    } else {
      // Concealed mode: widget on first line, hide the rest
      const firstLine = doc.line(block.startLine)

      if (block.startLine === block.endLine) {
        // Single-line: replace entire line with widget
        const widget = new AiProtocolWidget(block.charCount, block.preview)
        decos.push(Decoration.replace({ widget }).range(firstLine.from, firstLine.to))
      } else {
        // Multi-line: widget on first line, hide lines startLine+1..endLine
        const widget = new AiProtocolWidget(block.charCount, block.preview)
        decos.push(Decoration.replace({ widget }).range(firstLine.from, firstLine.to))

        const hiddenLine = Decoration.line({ class: 'cm-frontmatter-hidden' })
        for (let l = block.startLine + 1; l <= block.endLine; l++) {
          const lineFrom = doc.line(l).from
          decos.push(hiddenLine.range(lineFrom))
          gutters.push(hiddenGutter.range(lineFrom))
        }
      }
    }
  }

  // Sort by position
  decos.sort((a: any, b: any) => a.from - b.from)
  gutters.sort((a: any, b: any) => a.from - b.from)

  try {
    return {
      decorations: Decoration.set(decos, true),
      gutterMarkers: gutters.length > 0 ? RangeSet.of(gutters, true) : RangeSet.empty
    }
  } catch {
    return empty
  }
}

const setProtocolState = StateEffect.define<ProtocolState>()

const protocolField = StateField.define<ProtocolState>({
  create(state) {
    // Build concealed state on initial mount (no focus yet → blocks fold immediately)
    return buildState(state, false)
  },
  update(state, tr) {
    for (const e of tr.effects) {
      if (e.is(setProtocolState)) return e.value
    }
    if (tr.docChanged) {
      // Reflow on doc edits without selection movement; focus state unchanged
      return buildState(tr.state, false)
    }
    return state
  },
  provide: f => [
    EditorView.decorations.from(f, s => s.decorations),
    gutterLineClass.from(f, s => s.gutterMarkers)
  ]
})

export function createFrontmatterProtocolPlugin() {
  const updateDecorations = EditorView.updateListener.of((update) => {
    if (update.docChanged || update.selectionSet || update.focusChanged) {
      const newState = buildState(update.state, update.view.hasFocus)
      update.view.dispatch({
        effects: setProtocolState.of(newState)
      })
    }
  })

  return [protocolField, updateDecorations]
}
