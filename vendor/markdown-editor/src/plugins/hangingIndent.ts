import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

/**
 * Plugin that adds hanging indent for wrapped lines.
 * When a line starts with whitespace and wraps, continuation lines
 * will be indented to match the first non-whitespace character.
 */
function computeHangingIndent(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()

  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos)
      const text = line.text

      // Count leading whitespace
      let indent = 0
      for (let i = 0; i < text.length; i++) {
        if (text[i] === ' ') {
          indent++
        } else if (text[i] === '\t') {
          // Tab = 4 spaces (matches indentUnit in Editor.tsx)
          indent += 4
        } else {
          break
        }
      }

      // Only add decoration if there's indent
      if (indent > 0) {
        const deco = Decoration.line({
          attributes: {
            // FIX: Add 6px (base padding) to padding-left to compensate for negative text-indent.
            // This ensures the first character stays at the 6px mark instead of jumping to 0px.
            style: `padding-left: calc(${indent}ch + 6px); text-indent: -${indent}ch;`
          }
        })
        builder.add(line.from, line.from, deco)
      }

      pos = line.to + 1
    }
  }

  return builder.finish()
}

export const hangingIndentPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = computeHangingIndent(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = computeHangingIndent(update.view)
      }
    }
  },
  {
    decorations: (v) => v.decorations
  }
)
