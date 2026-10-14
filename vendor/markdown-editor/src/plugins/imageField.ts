import { Decoration, DecorationSet, EditorView } from '@codemirror/view'
import { StateField, EditorState, RangeSet, RangeValue } from '@codemirror/state'
import { ImageWidget } from '../widgets/ImageWidget'
import { ImageToggleWidget } from '../widgets/ImageToggleWidget'
import type { ClipboardAdapter } from './clipboardAdapter'
import { markdownTableRanges } from './tableField'

// Marker value for atomicRanges. The image chip span is registered as an atomic
// range so the cursor TREATS THE WHOLE `![...](...)` AS ONE GLYPH: arrows /
// Shift-arrows skip over it, a click is bounced off it (CM atom-skips
// select.pointer), and Backspace deletes it whole. This is what makes "adjacent
// cursor / arrow-through / select-around → chip stays, never reveals raw" work
// (see fact-images.md::Активация по токену). Crucially CM only skips positions
// STRICTLY inside (pos > from && pos < to), so a caret resting вплотную at an
// edge is left alone — exactly the post-paste / arrow-to-edge case.
class ImageAtom extends RangeValue {}
const IMAGE_ATOM = new ImageAtom()

interface ImageFieldValue {
  decorations: DecorationSet
  atoms: RangeSet<ImageAtom>
}

// Pattern for images: ![alt|width|+](path) — NOT anchored, so an image can sit
// anywhere in a line with text before/after it. Matched globally per line.
//  - alt:    any chars except ] or |
//  - |width: optional pixel width (digits)
//  - |+:     optional EXPAND flag — preview is shown. ABSENT = collapsed.
//            Collapse state lives in the text itself (like >>/^^ for sections),
//            so it survives reopen and stays consistent across windows. A fresh
//            paste and every pre-existing file have no flag → collapsed by
//            default. See fact-collapsible-sections.md::Persistence and
//            methodology/дизайн-принципы.md::Один источник правды.
//
// NOTE: markdownSyntax.ts skips `[...](...)` preceded by `!` so it never fights
// imageField over the same span (two overlapping Decoration.replace). imageField
// is the sole owner of `![...](...)`.
const imagePattern = /!\[([^\]|]*)?(?:\|(\d+))?(\|\+)?\]\(([^)]+)\)/g

export interface ImageFieldConfig {
  resolveImageUrl?: (src: string) => string
  clipboard?: ClipboardAdapter
}

export const createImageField = (config: ImageFieldConfig = {}) => {
  // Per-EditorView state: freeze width while cursor is inside the image token
  // Key: src, Value: width snapshot taken when cursor first entered the token
  const frozenWidths = new Map<string, number | null>()

  return StateField.define<ImageFieldValue>({
    create(state) {
      return buildImageDecorations(state, config, frozenWidths)
    },
    update(value, tr) {
      // Update only if document or selection changed
      if (tr.docChanged || tr.selection) {
        return buildImageDecorations(tr.state, config, frozenWidths)
      }
      return value
    },
    provide: (field) => [
      EditorView.decorations.from(field, (v) => v.decorations),
      // Register chip spans as atomic so cursor motion/click/delete treat each
      // image as a single unit. Only chips (collapsed-to-pill spans) are atomic;
      // a token whose raw is revealed (cursor strictly inside) is NOT in the set,
      // so it stays freely editable.
      EditorView.atomicRanges.of((view) => view.state.field(field).atoms)
    ]
  })
}

function buildImageDecorations(
  state: EditorState,
  config: ImageFieldConfig,
  frozenWidths: Map<string, number | null>
): ImageFieldValue {
  const widgets: Array<{ from: number; to?: number; decoration: Decoration }> = []
  // Spans of CHIP tokens — registered as atomicRanges so the cursor treats each
  // as one glyph. Built in document order (lines ascending, matches ascending),
  // so already sorted for RangeSet.of.
  const atomRanges: Array<{ from: number; to: number }> = []
  const cursor = state.selection.main.head
  // Track srcs still present this pass so frozenWidths can be GC'd for removed ones.
  const seenActiveSrcs = new Set<string>()
  const tableRanges = state.facet(markdownTableRanges)
  let tableIndex = 0

  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i)
    while (tableIndex < tableRanges.length && tableRanges[tableIndex].to < line.from) tableIndex++
    const table = tableRanges[tableIndex]
    if (table && table.from <= line.from && table.to >= line.to) continue
    const lineText = line.text
    if (lineText.indexOf('![') === -1) continue // cheap skip before regex

    for (const match of lineText.matchAll(imagePattern)) {
      const [full, alt, widthStr, expandFlag, src] = match
      const matchStart = line.from + (match.index ?? 0)
      const matchEnd = matchStart + full.length
      const width = widthStr ? parseInt(widthStr, 10) : null
      const isExpanded = expandFlag === '|+'

      // Reveal raw markdown ONLY when the cursor is STRICTLY inside this token
      // (matchStart < cursor < matchEnd). A caret resting вплотную at an edge —
      // after paste, after arrowing up to it, after typing text right beside it —
      // is NOT strictly inside → stays a chip. The chip span is atomic (see
      // atomRanges), so the ONLY way to get strictly-inside is the chip's own
      // body-click (programmatic dispatch, not atom-skipped). Arrows / Shift-
      // arrows / a stray native click all skip or bounce off the whole token.
      // fact-images.md::Активация по токену.
      const isActive = cursor > matchStart && cursor < matchEnd

      // Freeze width while editing — avoid jumpy resize on every keystroke.
      // Snapshot taken on entry, applied on exit. (Only observable while
      // expanded, i.e. the preview is shown.)
      let displayWidth = width
      if (isActive) {
        seenActiveSrcs.add(src)
        if (!frozenWidths.has(src)) frozenWidths.set(src, width)
        displayWidth = frozenWidths.get(src) ?? width
      }

      if (isActive) {
        // Show the raw markdown (full path) muted for editing — just the image
        // span, leaving surrounding text untouched.
        widgets.push({
          from: matchStart,
          to: matchEnd,
          decoration: Decoration.mark({ class: 'cm-md-image-syntax' })
        })
      } else {
        // Replace just the image span with an inline chip:
        //   ▸ 🖼 image  (collapsed)   /   ▾ 🖼 image  (expanded)
        // Text before/after the image stays as normal editable text.
        widgets.push({
          from: matchStart,
          to: matchEnd,
          decoration: Decoration.replace({
            widget: new ImageToggleWidget(
              matchStart,
              isExpanded,
              config.resolveImageUrl?.(src) ?? src,
            )
          })
        })
        // This token is a chip → make it atomic (cursor skips/bounces off it as
        // one unit). The active (raw) token is deliberately NOT atomic so it can
        // be edited char-by-char.
        atomRanges.push({ from: matchStart, to: matchEnd })
      }

      // Preview as a block below the whole line ONLY when expanded — the `|+`
      // flag is the single source of truth, independent of cursor focus (same
      // contract as a collapsible body following its >>/^^ marker). Block
      // widgets render full-width, so the preview starts from the left even if
      // the image sits mid-line.
      if (isExpanded) {
        widgets.push({
          from: line.to,
          decoration: Decoration.widget({
            widget: new ImageWidget(src, alt || '', displayWidth, config.resolveImageUrl, isActive, config.clipboard),
            block: true,
            side: 1
          })
        })
      }
    }
  }

  // GC frozen widths for srcs no longer on the active line.
  for (const key of frozenWidths.keys()) {
    if (!seenActiveSrcs.has(key)) frozenWidths.delete(key)
  }

  // Sort by position (block widget at line.to may tie with an inline span that
  // ends at line.to; CM6 orders ties by side, block side:1 sorts after).
  widgets.sort((a, b) => a.from - b.from)

  const decorations = Decoration.set(
    widgets.map((w) => (w.to !== undefined ? w.decoration.range(w.from, w.to) : w.decoration.range(w.from))),
    true
  )
  // atomRanges already in ascending order (lines then matches, both ascending);
  // sort:true is cheap insurance against any future reorder.
  const atoms = RangeSet.of(
    atomRanges.map((r) => IMAGE_ATOM.range(r.from, r.to)),
    true
  )
  return { decorations, atoms }
}
