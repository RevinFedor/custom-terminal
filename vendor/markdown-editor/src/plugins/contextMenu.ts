import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { Prec, Extension, EditorSelection, Transaction } from '@codemirror/state'
import { foldedRanges, unfoldEffect } from '@codemirror/language'
import { resolveAllIncludes, INCLUDE_PATTERN } from './includeLink'
import { activateAIPasteMode, activateNonAIPasteMode } from './clipboard'
import { type ClipboardAdapter, resolveClipboardAdapter } from './clipboardAdapter'

// Track last non-empty selection for Cmd+/ palette
// (CM6 may collapse selection before keydown handlers fire)
let lastNonEmptySelection: EditorSelection | null = null

export const selectionTrackerPlugin = ViewPlugin.fromClass(class {
  update(update: ViewUpdate) {
    const sel = update.state.selection
    if (!sel.main.empty) {
      lastNonEmptySelection = sel
    }
  }
})

export interface EmojiShortcut {
  emoji: string
  name: string
  description?: string
  // Кастомный image-эмодзи: base64-картинка (IconCropper 64×64). Если задана —
  // в текст вставляется токен `:name:`, а customEmoji.ts рендерит его картинкой.
  // emoji-поле у таких записей пустое. → plugins/customEmoji.ts.
  image?: string
}

export interface LineBackgroundEntry {
  id: string
  name: string
  color: string
}

export interface ContextMenuConfig {
  /** Resolve include path to file content (for "Copy with includes" feature) */
  resolveInclude?: (relativePath: string) => Promise<string>
  /** Get current emoji shortcuts (getter to avoid editor recreation) */
  getEmojiShortcuts?: () => EmojiShortcut[]
  /**
   * Injectable clipboard transport (same adapter as ClipboardConfig). When
   * omitted, copy falls back to navigator.clipboard → execCommand. Electron
   * hosts inject an electron.clipboard-backed adapter. See clipboardAdapter.ts.
   */
  clipboard?: ClipboardAdapter
  /** Configured line-background palette (for the Background submenu). */
  getLineBackgrounds?: () => LineBackgroundEntry[]
  /** Apply (bgId) or clear (null) the background on the current selection's lines. */
  applyLineBackground?: (view: EditorView, bgId: string | null) => void
  /** Current background id of the active line (to show ✓). */
  getActiveLineBackground?: (view: EditorView) => string | null
}

function getSelectedCharCount(view: EditorView): number {
  return view.state.selection.ranges.reduce((sum, range) => {
    return range.empty ? sum : sum + Math.abs(range.to - range.from)
  }, 0)
}

// Get line indent (spaces/tabs at start)
function getLineIndent(line: string): string {
  const match = line.match(/^[\t ]*/)
  return match ? match[0] : ''
}

// Find where actual content starts, skipping structural prefixes:
// indent + collapsible (>> or ^^) + heading (#{1,6}) + list marker (- * + \d.)
function getContentStart(lineText: string): number {
  let pos = 0

  // 1. Skip leading whitespace
  while (pos < lineText.length && (lineText[pos] === ' ' || lineText[pos] === '\t')) {
    pos++
  }

  // 2. Skip collapsible marker: >> or ^^
  if (
    pos + 1 < lineText.length &&
    ((lineText[pos] === '>' && lineText[pos + 1] === '>') ||
     (lineText[pos] === '^' && lineText[pos + 1] === '^'))
  ) {
    pos += 2
    if (pos < lineText.length && lineText[pos] === ' ') pos++
  }

  // 3. Skip heading marker: #{1,6}
  if (pos < lineText.length && lineText[pos] === '#') {
    let hashCount = 0
    while (pos + hashCount < lineText.length && lineText[pos + hashCount] === '#' && hashCount < 6) {
      hashCount++
    }
    if (hashCount > 0 && (pos + hashCount >= lineText.length || lineText[pos + hashCount] === ' ')) {
      pos += hashCount
      if (pos < lineText.length && lineText[pos] === ' ') pos++
    }
  }

  // 4. Skip list marker: - * + or \d+.
  const remaining = lineText.substring(pos)
  const listMatch = remaining.match(/^([*+\-]|\d+\.)\s+/)
  if (listMatch) {
    pos += listMatch[0].length
  }

  return pos
}

// Format: Add prefix after indent (e.g., ">> " for collapsible, "# " for heading)
export function addLinePrefix(view: EditorView, prefix: string) {
  const { state } = view
  const selection = state.selection.main

  // Get all lines in selection (or current line if no selection)
  const fromLine = state.doc.lineAt(selection.from)
  const toLine = state.doc.lineAt(selection.to)

  const changes: { from: number; to: number; insert: string }[] = []

  for (let i = fromLine.number; i <= toLine.number; i++) {
    const line = state.doc.line(i)
    const text = line.text
    const indent = getLineIndent(text)
    const content = text.slice(indent.length)

    // Check if prefix already exists
    if (content.startsWith(prefix)) continue

    // Insert prefix after indent (works for empty lines too)
    changes.push({
      from: line.from + indent.length,
      to: line.from + indent.length,
      insert: prefix
    })
  }

  if (changes.length > 0) {
    view.dispatch({ changes })
  }
}

// Format: Remove prefix after indent
export function removeLinePrefix(view: EditorView, prefix: string) {
  const { state } = view
  const selection = state.selection.main

  const fromLine = state.doc.lineAt(selection.from)
  const toLine = state.doc.lineAt(selection.to)

  const changes: { from: number; to: number; insert: string }[] = []

  for (let i = fromLine.number; i <= toLine.number; i++) {
    const line = state.doc.line(i)
    const text = line.text
    const indent = getLineIndent(text)
    const content = text.slice(indent.length)

    // Check if prefix exists
    if (content.startsWith(prefix)) {
      changes.push({
        from: line.from + indent.length,
        to: line.from + indent.length + prefix.length,
        insert: ''
      })
    }
  }

  if (changes.length > 0) {
    view.dispatch({ changes })
  }
}

// Wrap a multi-line selection into a folded `^^` section with an empty header.
// The selected lines (always whole lines — from fromLine.from to toLine.to)
// become the body of the section, reindented by +4 spaces relative to the
// header so they are nested inside the foldable range. The header itself
// inherits the leading-whitespace indent of the first selected line so the
// section sits at the same nesting level as its first body line previously had.
// Cursor lands after `^^ ` on the header line — section is empty-named and the
// user can immediately type its title. autoFoldCollapsedMarkers (in
// collapsibleArrow.ts) sees the new `^^` on the next tick and folds it.
function wrapSelectionIntoCollapsedSection(
  view: EditorView,
  fromLine: { from: number; to: number; text: string; number: number },
  toLine: { from: number; to: number; text: string; number: number }
) {
  const state = view.state
  const headerIndent = (fromLine.text.match(/^[\t ]*/)?.[0]) ?? ''

  const bodyLines: string[] = []
  for (let i = fromLine.number; i <= toLine.number; i++) {
    const ln = state.doc.line(i)
    // Reindent: prepend 4 spaces to whatever leading whitespace the line already
    // has. Empty lines stay empty (no trailing whitespace inserted) — fold service
    // tolerates blank lines inside the block as long as a deeper-indented line
    // follows.
    bodyLines.push(ln.text === '' ? '' : '    ' + ln.text)
  }

  const headerText = headerIndent + '^^ '
  const body = bodyLines.join('\n')
  const insert = headerText + '\n' + body

  const cursorPos = fromLine.from + headerText.length

  console.log('[Palette:Collapsible] multi-line wrap',
    { fromLine: fromLine.number, toLine: toLine.number,
      bodyLineCount: bodyLines.length,
      headerIndentLen: headerIndent.length, cursorPos })

  // cursorPos === headerLine.to === the section's fold.from
  // (collapsibleFold.ts sets fold.from = headerLine.to). We express the intended
  // assoc=-1 bias here, BUT it does not survive on its own: at this instant no
  // fold exists yet (autoFoldCollapsedMarkers folds a tick later, async), so
  // cursorPos is not a boundary and CM6 normalizes assoc back to 0 — verified in
  // [FoldBoundary] logs (this dispatch sets -1, selAfter reads assoc:0). The
  // DURABLE fix lives in autoFoldCollapsedMarkers: it re-asserts assoc=-1 as a
  // separate transaction right AFTER it creates the fold, when the boundary is
  // real. Without that, the caret lands on fold.from with assoc=0 → coordsAtPos
  // probes RIGHT into the hidden body widget → null → caret DOM not built
  // (typing works, no blinking cursor until the user clicks).
  // → fix-cm6-cursor-selection.md::Cursor stuck inside fold
  view.dispatch({
    changes: { from: fromLine.from, to: toLine.to, insert },
    selection: EditorSelection.cursor(cursorPos, -1),
    scrollIntoView: true,
    userEvent: 'input'
  })
}

// Cmd+/ palette → Collapsible (single-line / no-selection path).
//
// Turns the current line into a `>> ` section header and parks the cursor at the
// title start (right after the marker). Deliberately plain:
//   - empty line → `>> ` with cursor right after it (NO "Bullet" placeholder)
//   - non-empty  → `>> <existing text>`, cursor before the text
//   - NO auto-inserted empty body line below the header
// Rationale: a plain click (no selection) should just create an empty, ready-to-
// name section — the user types the title first, then Enter+Tab to add a body.
// (The right-click menu keeps its own `>> Bullet`-on-empty behavior via
// toggleLinePrefix; only this palette path is the "clean" one.)
//
// If the line was ALREADY a section (`>>`/`^^`), picking Collapsible toggles the
// marker OFF via toggleLinePrefix and leaves the cursor in place.
// Multi-line selections take the wrapSelectionIntoCollapsedSection branch.
export function applyCollapsibleFromPalette(view: EditorView) {
  const sel = view.state.selection.main
  const fromLine = view.state.doc.lineAt(sel.from)
  const toLine = view.state.doc.lineAt(sel.to)

  // Multi-line selection → wrap whole selection into a folded ^^ section with
  // an empty header. Body = selected lines reindented by +4 spaces so they
  // fall inside the foldable range (indent > header indent).
  // Cursor lands after `^^ ` on the (empty) header line so the user can
  // immediately type the section title. autoFoldCollapsedMarkers picks up
  // the ^^ marker on the next tick and folds the section.
  if (fromLine.number !== toLine.number) {
    wrapSelectionIntoCollapsedSection(view, fromLine, toLine)
    return
  }

  const line = fromLine
  const wasSection = /^[\t ]*(>>|\^\^)/.test(line.text)
  console.log('[Palette:Collapsible] single-line toggle',
    { line: line.number, wasSection, lineText: line.text.slice(0, 40) })

  // Already a section → toggle the marker OFF, leave the cursor where it is.
  if (wasSection) {
    toggleLinePrefix(view, '>> ')
    return
  }

  // Fresh section: insert `>> ` after the line's indent, cursor at title start.
  const indent = getLineIndent(line.text)
  const insertPos = line.from + indent.length
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: '>> ' },
    selection: { anchor: insertPos + 3 }, // right after ">> " (title start)
    scrollIntoView: true,
    userEvent: 'input',
  })
}

// Toggle prefix (add if not present, remove if present)
export function toggleLinePrefix(view: EditorView, prefix: string) {
  const { state } = view
  const selection = state.selection.main
  const line = state.doc.lineAt(selection.from)
  const text = line.text
  const indent = getLineIndent(text)
  const content = text.slice(indent.length)

  // Special case for collapsible: check both >> and ^^ (with or without trailing space)
  if (prefix === '>> ') {
    // Order matters: check with-space first to capture the full prefix
    let actualPrefix: string | null = null
    if (content.startsWith('>> ')) actualPrefix = '>> '
    else if (content.startsWith('^^ ')) actualPrefix = '^^ '
    else if (content.startsWith('>>')) actualPrefix = '>>'
    else if (content.startsWith('^^')) actualPrefix = '^^'

    if (actualPrefix) {

      // Check if this section is folded — unfold FIRST, then remove marker
      let foldedRange: { from: number; to: number } | null = null
      foldedRanges(state).between(line.from, state.doc.length, (from, to) => {
        if (from >= line.to && from <= line.to + 1 && !foldedRange) {
          foldedRange = { from, to }
        }
      })

      if (foldedRange) {
        // Step 1: Unfold (also change ^^ back to >> so marker is consistent)
        const markerIsCollapsed = actualPrefix.startsWith('^^')
        const markerChange = markerIsCollapsed ? {
          from: line.from + indent.length,
          to: line.from + indent.length + 2,
          insert: '>>'
        } : undefined

        view.dispatch({
          effects: unfoldEffect.of(foldedRange),
          ...(markerChange ? { changes: [markerChange] } : {})
        })

        // Step 2: Remove prefix from the now-unfolded line (re-read from fresh state)
        const newState = view.state
        const newLine = newState.doc.lineAt(selection.from)
        const newIndent = getLineIndent(newLine.text)
        const newContent = newLine.text.slice(newIndent.length)
        let newPrefix: string | null = null
        if (newContent.startsWith('>> ')) newPrefix = '>> '
        else if (newContent.startsWith('^^ ')) newPrefix = '^^ '
        else if (newContent.startsWith('>>')) newPrefix = '>>'
        else if (newContent.startsWith('^^')) newPrefix = '^^'

        if (newPrefix) {
          view.dispatch({
            changes: [{
              from: newLine.from + newIndent.length,
              to: newLine.from + newIndent.length + newPrefix.length,
              insert: ''
            }]
          })
        }
      } else {
        // Not folded — just remove the prefix
        view.dispatch({
          changes: [{
            from: line.from + indent.length,
            to: line.from + indent.length + actualPrefix.length,
            insert: ''
          }]
        })
      }
    } else {
      // Empty line: insert prefix + default text "Bullet" with cursor after it
      if (content.trim() === '') {
        const defaultText = 'Bullet'
        const insertPos = line.from + indent.length
        view.dispatch({
          changes: [{
            from: insertPos,
            to: line.to,
            insert: prefix + defaultText
          }],
          selection: { anchor: insertPos + prefix.length + defaultText.length }
        })
      } else {
        addLinePrefix(view, prefix)
      }
    }
    return
  }

  if (content.startsWith(prefix)) {
    removeLinePrefix(view, prefix)
  } else {
    addLinePrefix(view, prefix)
  }
}

// Format: Wrap selection or word with markers (e.g., ** for bold, * for italic)
export function wrapSelection(view: EditorView, marker: string, endMarker?: string) {
  const { state } = view
  const selection = state.selection.main
  const end = endMarker ?? marker

  let from = selection.from
  let to = selection.to

  // If no selection, select line content after structural prefixes
  if (selection.empty) {
    const line = state.doc.lineAt(from)
    const lineText = line.text
    if (lineText.trim() === '') return // empty line
    const contentStart = getContentStart(lineText)
    const contentEnd = lineText.trimEnd().length
    if (contentStart >= contentEnd) return // only prefixes, no content

    from = line.from + contentStart
    to = line.from + contentEnd
  }

  // Trim whitespace then narrow if text includes markers at boundaries
  const rawText = state.sliceDoc(from, to)
  const lwsW = rawText.length - rawText.trimStart().length
  const twsW = rawText.length - rawText.trimEnd().length
  const trimTextW = rawText.trim()
  const ml = marker.length
  const el = end.length
  if (trimTextW.length >= ml + el + 1 && trimTextW.startsWith(marker) && trimTextW.endsWith(end)) {
    from = from + lwsW + ml
    to = to - twsW - el
  }

  const selectedText = state.sliceDoc(from, to)

  // Check if already wrapped - unwrap
  const beforeStart = from >= marker.length ? state.sliceDoc(from - marker.length, from) : ''
  const afterEnd = to + end.length <= state.doc.length ? state.sliceDoc(to, to + end.length) : ''

  if (beforeStart === marker && afterEnd === end) {
    // Unwrap
    view.dispatch({
      changes: [
        { from: from - marker.length, to: from, insert: '' },
        { from: to, to: to + end.length, insert: '' }
      ],
      selection: { anchor: from - marker.length, head: to - marker.length }
    })
  } else {
    // Wrap
    view.dispatch({
      changes: [
        { from, to, insert: marker + selectedText + end }
      ],
      selection: { anchor: from + marker.length, head: from + marker.length + selectedText.length }
    })
  }
}

// Heading levels
export function setHeadingLevel(view: EditorView, level: number) {
  const { state } = view
  const selection = state.selection.main

  const fromLine = state.doc.lineAt(selection.from)
  const toLine = state.doc.lineAt(selection.to)

  const changes: { from: number; to: number; insert: string }[] = []

  for (let i = fromLine.number; i <= toLine.number; i++) {
    const line = state.doc.line(i)
    const text = line.text
    const indent = getLineIndent(text)
    let offset = indent.length
    let afterPrefix = text.slice(offset)

    // Skip collapsible marker: >> or ^^ (heading goes AFTER collapsible)
    const collapsibleMatch = afterPrefix.match(/^(>>|\^\^)\s?/)
    if (collapsibleMatch) {
      offset += collapsibleMatch[0].length
      afterPrefix = text.slice(offset)
    }

    // Remove existing heading markers
    const existingHeading = afterPrefix.match(/^#{1,6}\s*/)

    // New prefix
    const newPrefix = level > 0 ? '#'.repeat(level) + ' ' : ''

    changes.push({
      from: line.from + offset,
      to: line.from + offset + (existingHeading ? existingHeading[0].length : 0),
      insert: newPrefix
    })
  }

  if (changes.length > 0) {
    view.dispatch({ changes })
  }
}

// Menu item types
export interface MenuItem {
  label: string
  action?: (view: EditorView) => void
  submenu?: MenuItem[]
  divider?: boolean
  /** Description shown as tooltip on Cmd+hover (for emoji shortcuts) */
  _emojiDescription?: string
  /** Кастомный image-эмодзи: base64 — рендерится <img> перед label. */
  _emojiImage?: string
  /** Thin color bar on the left (Cmd+/-palette style) — for Format items. */
  color?: string
  /** Filled square swatch on the left — for Background color items. */
  swatch?: string
  /** Checkmark prefix state (active format / current background). */
  checked?: boolean
  /**
   * Action fired when the PARENT row of a submenu is itself clicked (not a child).
   * The submenu still opens on hover; this only adds click-to-act on the parent.
   * Used by Background: clicking the parent toggles OFF the active color, mirroring
   * a click on the active swatch inside the submenu. Undefined → parent is a pure
   * submenu-opener (click does nothing, as before).
   */
  parentAction?: (view: EditorView) => void
}

// Find inline code at cursor position
function findInlineCodeAtCursor(view: EditorView): { content: string; from: number; to: number } | null {
  const { state } = view
  const pos = state.selection.main.head
  const line = state.doc.lineAt(pos)
  const lineText = line.text
  const posInLine = pos - line.from

  // Find all backtick pairs in line (including empty)
  const regex = /`([^`]*)`/g
  let match
  while ((match = regex.exec(lineText)) !== null) {
    const start = match.index
    const end = start + match[0].length
    // Check if cursor is inside this code block (including backticks)
    if (posInLine >= start && posInLine <= end) {
      return {
        content: match[1], // Content without backticks
        from: line.from + start,
        to: line.from + end
      }
    }
  }
  return null
}

// Copy text to clipboard via the injected adapter (electron.clipboard in the
// Electron host), falling back to the execCommand textarea trick. cb defaults to
// navigator.clipboard when the host doesn't inject one (web).
async function copyToClipboard(text: string, cb?: ClipboardAdapter) {
  const adapter = resolveClipboardAdapter(cb)
  try {
    await Promise.resolve(adapter.writeText(text))
  } catch (err) {
    // Fallback
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
}

// Check if selection/word is wrapped with marker
function isWrappedWith(view: EditorView, marker: string): boolean {
  const { state } = view
  const selection = state.selection.main

  let from = selection.from
  let to = selection.to

  // If no selection, select line content after structural prefixes
  if (selection.empty) {
    const line = state.doc.lineAt(from)
    const lineText = line.text
    if (lineText.trim() === '') return false
    const contentStart = getContentStart(lineText)
    const contentEnd = lineText.trimEnd().length
    if (contentStart >= contentEnd) return false

    from = line.from + contentStart
    to = line.from + contentEnd
  }

  // Trim whitespace from boundaries before marker detection
  // (user may select "**text** " with trailing space)
  const rawText = state.sliceDoc(from, to)
  const leadingWs = rawText.length - rawText.trimStart().length
  const trailingWs = rawText.length - rawText.trimEnd().length
  const trimmedFrom = from + leadingWs
  const trimmedTo = to - trailingWs
  const trimmedText = rawText.trim()

  // If text starts/ends with marker, narrow range inward so the
  // "check outside" logic below naturally finds the markers.
  // Example: selected "**zsf** " → trim → "**zsf**" → narrow to "zsf" → beforeStart="**" ✓
  const ml = marker.length
  if (trimmedText.length >= ml * 2 + 1 && trimmedText.startsWith(marker) && trimmedText.endsWith(marker)) {
    from = trimmedFrom + ml
    to = trimmedTo - ml
  }

  const beforeStart = from >= marker.length ? state.sliceDoc(from - marker.length, from) : ''
  const afterEnd = to + marker.length <= state.doc.length ? state.sliceDoc(to, to + marker.length) : ''

  return beforeStart === marker && afterEnd === marker
}

// Check if line has prefix
function hasLinePrefix(view: EditorView, prefix: string): boolean {
  const { state } = view
  const selection = state.selection.main
  const line = state.doc.lineAt(selection.from)
  const text = line.text
  const indent = getLineIndent(text)
  const content = text.slice(indent.length)
  return content.startsWith(prefix)
}

// Get current heading level (0 if no heading)
function getCurrentHeadingLevel(view: EditorView): number {
  const { state } = view
  const selection = state.selection.main
  const line = state.doc.lineAt(selection.from)
  const text = line.text
  const indent = getLineIndent(text)
  let content = text.slice(indent.length)

  // Skip collapsible marker: >> or ^^ (heading sits after it)
  const collapsibleMatch = content.match(/^(>>|\^\^)\s?/)
  if (collapsibleMatch) {
    content = content.slice(collapsibleMatch[0].length)
  }

  const match = content.match(/^(#{1,6})\s/)
  return match ? match[1].length : 0
}

// Check if document has any includes
function hasIncludes(doc: string): boolean {
  return INCLUDE_PATTERN.test(doc)
}

// Render a saturated, OPAQUE preview of a possibly-translucent color so the
// background swatch is clearly visible against the dark menu. Composites the
// color over a near-black backdrop (matching the editor) and forces alpha→1.
function opaquePreview(color: string): string {
  const s = String(color).trim()
  const rgba = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i)
  if (rgba) {
    const r = +rgba[1], g = +rgba[2], b = +rgba[3]
    const a = rgba[4] != null ? Math.max(0, Math.min(1, parseFloat(rgba[4]))) : 1
    if (a >= 0.95) return s
    // Composite over the menu backdrop (#1e1e1e ≈ 30) so very low-alpha tints
    // still show their hue instead of a flat gray.
    const bg = 30
    const comp = (c: number) => Math.round(c * a + bg * (1 - a))
    // Boost toward the pure hue a bit so it's vivid, not muddy.
    const mix = (c: number) => Math.round(comp(c) * 0.35 + c * 0.65)
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
  }
  return s
}

// Default menu items
export function getDefaultMenuItems(view?: EditorView, config?: ContextMenuConfig): MenuItem[] {
  const items: MenuItem[] = []

  // Check formatting state
  const isBold = view ? isWrappedWith(view, '**') : false
  const isItalic = view ? isWrappedWith(view, '*') && !isBold : false
  const isCode = view ? isWrappedWith(view, '`') : false
  const isStrike = view ? isWrappedWith(view, '~~') : false
  const isCollapsible = view ? (hasLinePrefix(view, '>> ') || hasLinePrefix(view, '^^ ')) : false
  const headingLevel = view ? getCurrentHeadingLevel(view) : 0

  // Check if cursor is inside inline code
  if (view) {
    const inlineCode = findInlineCodeAtCursor(view)
    if (inlineCode) {
      items.push({
        label: 'Copy block',
        action: () => {
          copyToClipboard(inlineCode.content, config?.clipboard)
        }
      })
      items.push({ divider: true, label: '' })
    }
  }

  // Add "Copy with includes" if document has includes and resolver is available
  if (view && config?.resolveInclude) {
    const docText = view.state.doc.toString()
    if (hasIncludes(docText)) {
      items.push({
        label: 'Copy with includes',
        action: async () => {
          try {
            const resolved = await resolveAllIncludes(docText, config.resolveInclude!)
            await copyToClipboard(resolved, config?.clipboard)
          } catch (e) {
            console.error('[ContextMenu] Failed to resolve includes:', e)
          }
        }
      })
      items.push({ divider: true, label: '' })
    }
  }

  // Background submenu FIRST. Empty selection -> recolor lines. Non-empty
  // selection -> recolor exactly the selected character ranges; the parent label
  // shows the selected character count so the user can see that this is range
  // mode, not whole-line mode.
  if (view && config?.getLineBackgrounds && config?.applyLineBackground) {
    const backgrounds = config.getLineBackgrounds() ?? []
    const activeBg = config.getActiveLineBackground?.(view) ?? null
    const activeEntry = activeBg ? backgrounds.find(b => b.id === activeBg) : null
    const selectedChars = getSelectedCharCount(view)
    const labelBase = activeEntry ? (activeEntry.name || 'color') : 'Background'
    const label = selectedChars > 0 ? `${labelBase} (${selectedChars})` : labelBase
    const bgSubmenu: MenuItem[] = []
    for (const bg of backgrounds) {
      const isActive = activeBg === bg.id
      bgSubmenu.push({
        label: bg.name || bg.color,
        swatch: bg.color,
        checked: isActive,
        // Second click on the active color clears it; otherwise apply.
        action: (v) => config.applyLineBackground!(v, isActive ? null : bg.id),
      })
    }
    if (bgSubmenu.length > 0) {
      items.push({
        // Active -> show the color name (e.g. "Warning"); selection -> append
        // char count, e.g. "Background (18)".
        label,
        // Swatch on the parent row reflects the active line background (or empty).
        swatch: activeEntry ? activeEntry.color : undefined,
        submenu: bgSubmenu,
        // Clicking the parent itself, when a color is active, clears it (toggle-off)
        // — same as re-clicking the active swatch. No active color → no parentAction
        // (parent stays a pure hover-opener).
        parentAction: activeBg ? (v) => config.applyLineBackground!(v, null) : undefined,
      })
    }
  }

  // Format submenu — cloned from the Cmd+/ palette: thin color bar + label.
  // Same colors as getPaletteItems so the two menus read identically.
  items.push({
    label: 'Format',
    submenu: [
      { label: 'Bold', color: '#ffa348', checked: isBold, action: (v) => wrapSelection(v, '**') },
      { label: 'Italic', color: '#69dbdb', checked: isItalic, action: (v) => wrapSelection(v, '*') },
      { label: 'Code', color: '#50fa7b', checked: isCode, action: (v) => wrapSelection(v, '`') },
      { label: 'Strikethrough', color: '#ff6b6b', checked: isStrike, action: (v) => wrapSelection(v, '~~') },
      { divider: true, label: '' },
      { label: 'Heading 1', color: '#c678dd', checked: headingLevel === 1, action: (v) => setHeadingLevel(v, headingLevel === 1 ? 0 : 1) },
      { label: 'Heading 2', color: '#b197fc', checked: headingLevel === 2, action: (v) => setHeadingLevel(v, headingLevel === 2 ? 0 : 2) },
      { label: 'Heading 3', color: '#a78bfa', checked: headingLevel === 3, action: (v) => setHeadingLevel(v, headingLevel === 3 ? 0 : 3) },
      { divider: true, label: '' },
      { label: 'Collapsible', color: '#868e96', checked: isCollapsible, action: (v) => toggleLinePrefix(v, '>> ') },
    ]
  })

  // Emoji shortcuts submenu
  const emojiShortcuts = config?.getEmojiShortcuts?.() ?? []
  if (emojiShortcuts.length > 0) {
    items.push({ divider: true, label: '' })
    items.push({
      label: 'Emoji',
      submenu: emojiShortcuts.map((shortcut) => {
        // Image-эмодзи: в меню — мини-превью картинки, в текст — токен `:name:`
        // (рендерится картинкой через customEmoji.ts). Обычный эмодзи — как был.
        const isImage = !!shortcut.image
        const insert = isImage ? `:${shortcut.name}:` : shortcut.emoji
        return {
          label: isImage ? (shortcut.name || 'custom') : `${shortcut.emoji}  ${shortcut.name || shortcut.emoji}`,
          _emojiImage: isImage ? shortcut.image : undefined,
          _emojiDescription: shortcut.description,
          action: (view: EditorView) => {
            const pos = view.state.selection.main.head
            view.dispatch({
              changes: { from: pos, insert },
              selection: { anchor: pos + insert.length },
            })
          }
        } as MenuItem
      })
    })
  }

  return items
}

// Create and show context menu
export function showContextMenu(
  view: EditorView,
  x: number,
  y: number,
  items?: MenuItem[],
  config?: ContextMenuConfig
) {
  const menuItems = items ?? getDefaultMenuItems(view, config)
  // Remove existing menu
  hideContextMenu()

  const menu = document.createElement('div') as HTMLDivElement & { _emojiCleanup?: () => void }
  menu.className = 'cm-context-menu'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  menu.setAttribute('data-context-menu', 'true')

  // Track active tooltip for Cmd+hover on emoji items
  let activeTooltip: HTMLElement | null = null
  let hoveredEmojiItem: { el: HTMLElement; desc: string } | null = null

  function showEmojiTooltip(el: HTMLElement, description: string) {
    hideEmojiTooltip()
    const tooltip = document.createElement('div')
    tooltip.className = 'cm-emoji-tooltip'
    tooltip.textContent = description
    document.body.appendChild(tooltip)

    const rect = el.getBoundingClientRect()
    tooltip.style.left = `${rect.right + 8}px`
    tooltip.style.top = `${rect.top}px`

    // Adjust if off-screen
    requestAnimationFrame(() => {
      const tRect = tooltip.getBoundingClientRect()
      if (tRect.right > window.innerWidth) {
        tooltip.style.left = `${rect.left - tRect.width - 8}px`
      }
      if (tRect.bottom > window.innerHeight) {
        tooltip.style.top = `${window.innerHeight - tRect.height - 8}px`
      }
    })

    activeTooltip = tooltip
  }

  function hideEmojiTooltip() {
    if (activeTooltip) {
      activeTooltip.remove()
      activeTooltip = null
    }
  }

  // Cmd key listener for emoji tooltips
  const cmdKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Meta' && hoveredEmojiItem) {
      showEmojiTooltip(hoveredEmojiItem.el, hoveredEmojiItem.desc)
    }
  }
  const cmdKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Meta') {
      hideEmojiTooltip()
    }
  }
  document.addEventListener('keydown', cmdKeyDown)
  document.addEventListener('keyup', cmdKeyUp)

  // Store cleanup so hideContextMenu can remove listeners
  menu._emojiCleanup = () => {
    document.removeEventListener('keydown', cmdKeyDown)
    document.removeEventListener('keyup', cmdKeyUp)
    hideEmojiTooltip()
    hoveredEmojiItem = null
  }

  function positionSubmenu(parentItem: HTMLElement, submenu: HTMLElement) {
    const margin = 8
    const baseGap = 5
    const parentRect = parentItem.getBoundingClientRect()

    // The submenu is display:none until hover. Measure it hidden but laid out,
    // then leave CSS :hover to control visibility. This avoids the old static
    // `left:100%; top:-5px` clipping at the bottom of the app.
    const prevDisplay = submenu.style.display
    const prevVisibility = submenu.style.visibility

    submenu.style.display = 'block'
    submenu.style.visibility = 'hidden'
    submenu.style.maxHeight = ''
    submenu.style.overflowY = ''

    const measured = submenu.getBoundingClientRect()
    const naturalHeight = measured.height
    const naturalWidth = measured.width
    const maxHeight = Math.max(80, window.innerHeight - margin * 2)
    const menuHeight = Math.min(naturalHeight, maxHeight)

    const spaceRight = window.innerWidth - parentRect.right - margin
    const spaceLeft = parentRect.left - margin
    const openLeft = naturalWidth > spaceRight && spaceLeft > spaceRight

    if (openLeft) {
      submenu.style.left = 'auto'
      submenu.style.right = '100%'
    } else {
      submenu.style.left = '100%'
      submenu.style.right = 'auto'
    }

    let viewportTop = parentRect.top - baseGap
    const downBottom = viewportTop + menuHeight
    if (downBottom > window.innerHeight - margin) {
      // Prefer opening upward from the parent row bottom. If even that doesn't
      // fit, clamp inside the viewport; the submenu will scroll internally.
      viewportTop = parentRect.bottom - menuHeight + baseGap
      if (viewportTop < margin) viewportTop = margin
    }
    if (viewportTop + menuHeight > window.innerHeight - margin) {
      viewportTop = window.innerHeight - margin - menuHeight
    }

    submenu.style.top = `${Math.round(viewportTop - parentRect.top)}px`
    submenu.style.display = prevDisplay
    submenu.style.visibility = prevVisibility
    // Do not preserve stale max-height from a smaller previous viewport.
    submenu.style.maxHeight = naturalHeight > maxHeight ? `${maxHeight}px` : ''
    submenu.style.overflowY = naturalHeight > maxHeight ? 'auto' : ''

    const labelEl = Array.from(parentItem.children).find((child) =>
      (child as HTMLElement).classList?.contains('cm-menu-label')
    ) as HTMLElement | undefined
    console.log('[ContextMenu] submenu positioned', {
      label: labelEl?.textContent?.trim() ?? parentItem.textContent?.trim(),
      side: openLeft ? 'left' : 'right',
      top: Math.round(viewportTop),
      height: Math.round(menuHeight),
      scroll: naturalHeight > maxHeight
    })
  }

  function renderItems(container: HTMLElement, menuItems: MenuItem[], isSubmenu = false) {
    menuItems.forEach((item) => {
      if (item.divider) {
        const divider = document.createElement('div')
        divider.className = 'cm-context-menu-divider'
        container.appendChild(divider)
        return
      }

      const menuItem = document.createElement('div')
      menuItem.className = 'cm-context-menu-item'

      if (item.submenu) {
        menuItem.classList.add('has-submenu')
        // Optional swatch on the parent row (e.g. Background shows the active color).
        if (item.swatch) {
          const sw = document.createElement('span')
          sw.className = 'cm-menu-swatch'
          sw.style.backgroundColor = opaquePreview(item.swatch)
          menuItem.appendChild(sw)
        }
        const labelEl = document.createElement('span')
        labelEl.className = 'cm-menu-label'
        labelEl.textContent = item.label
        menuItem.appendChild(labelEl)
        // Custom chevron — a real SVG, not a 2px ▸ glyph.
        const arrow = document.createElement('span')
        arrow.className = 'submenu-arrow'
        arrow.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>'
        menuItem.appendChild(arrow)

        const submenu = document.createElement('div')
        submenu.className = 'cm-context-submenu'

        // Emoji tooltip delegation: mousemove on submenu container
        // (mouseenter on individual items doesn't fire when submenu appears under cursor)
        let currentHoveredEl: HTMLElement | null = null
        submenu.addEventListener('mousemove', (e) => {
          // Find which direct child item is under the cursor
          let target: HTMLElement | null = null
          for (const child of submenu.children) {
            const rect = (child as HTMLElement).getBoundingClientRect()
            if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
              target = child as HTMLElement
              break
            }
          }
          
          if (target) {
             // console.log('[EmojiTooltip] Mousemove hit target:', target.textContent, 'data:', target.dataset)
          }

          if (target === currentHoveredEl) return
          currentHoveredEl = target
          
          const desc = target?.dataset.emojiDesc
          console.log('[EmojiTooltip] Hover changed. Target:', target?.textContent?.trim(), 'Desc:', desc, 'Meta:', e.metaKey)
          
          if (target && desc) {
            hoveredEmojiItem = { el: target, desc }
            if (e.metaKey) {
              showEmojiTooltip(target, desc)
            }
          } else {
            hoveredEmojiItem = null
            hideEmojiTooltip()
          }
        })
        submenu.addEventListener('mouseleave', () => {
          currentHoveredEl = null
          hoveredEmojiItem = null
          hideEmojiTooltip()
        })

        renderItems(submenu, item.submenu, true)
        menuItem.appendChild(submenu)
        menuItem.addEventListener('mouseenter', () => positionSubmenu(menuItem, submenu))

        // Parent-row click: only meaningful when parentAction is set (Background
        // with an active color → clear it). Clicks landing on a submenu CHILD are
        // already handled by the child's own listener + stopPropagation, so this
        // fires only for clicks on the parent row's own area. Without parentAction
        // the parent stays a pure hover-opener (no-op on click, as before).
        if (item.parentAction) {
          menuItem.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.cm-context-submenu')) return
            e.stopPropagation()
            hideContextMenu()
            item.parentAction!(view)
            view.focus()
          })
        }
      } else {
        // Optional leading indicator: thin color bar (Format) or filled swatch (Background).
        if (item.color) {
          const bar = document.createElement('span')
          bar.className = 'cm-menu-color'
          bar.style.backgroundColor = item.color
          menuItem.appendChild(bar)
        } else if (item.swatch) {
          const sw = document.createElement('span')
          sw.className = 'cm-menu-swatch'
          // The stored color is semi-transparent (alpha ~0.14) so it's nearly
          // invisible on the dark menu — show a SATURATED (opaque) preview of the
          // same RGB so each color reads clearly.
          sw.style.backgroundColor = opaquePreview(item.swatch)
          menuItem.appendChild(sw)
        }

        // Image-эмодзи: мини-превью картинки перед текстом (как эмодзи-символ).
        if (item._emojiImage) {
          const img = document.createElement('img')
          img.src = item._emojiImage
          img.className = 'cm-menu-emoji-img'
          menuItem.appendChild(img)
        }

        const labelEl = document.createElement('span')
        labelEl.className = 'cm-menu-label'
        labelEl.textContent = item.label
        menuItem.appendChild(labelEl)

        if (item.checked) {
          menuItem.classList.add('is-checked')
          const check = document.createElement('span')
          check.className = 'cm-menu-check'
          check.textContent = '✓'
          menuItem.appendChild(check)
        }

        menuItem.addEventListener('click', (e) => {
          e.stopPropagation()
          hideContextMenu()
          item.action?.(view)
          view.focus()
        })

        // Store description as data attribute for mousemove delegation
        if (item._emojiDescription) {
          menuItem.dataset.emojiDesc = item._emojiDescription
          console.log('[EmojiTooltip] Set data-emoji-desc on item:', item.label, 'desc:', item._emojiDescription)
        }
      }

      container.appendChild(menuItem)
    })
  }

  renderItems(menu, menuItems)
  console.log('[EmojiTooltip] Menu rendered. HTML:', menu.innerHTML)
  document.body.appendChild(menu)
  // console.log('[ContextMenu] Menu appended to body, element:', menu)

  // Adjust position if menu goes off screen
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect()
    let newLeft = x
    let newTop = y

    // Горизонтальная корректировка
    if (rect.right > window.innerWidth) {
      newLeft = window.innerWidth - rect.width - 10
    }

    // Вертикальная корректировка: если не хватает места снизу - открываем вверх
    const spaceBelow = window.innerHeight - y
    const spaceAbove = y

    if (rect.height > spaceBelow && spaceAbove > spaceBelow) {
      // Открываем вверх от курсора
      newTop = y - rect.height
      // console.log('[ContextMenu] Открываем вверх: spaceBelow=', spaceBelow, 'spaceAbove=', spaceAbove, 'menuHeight=', rect.height)
    } else if (rect.bottom > window.innerHeight) {
      // Сдвигаем вверх чтобы поместилось
      newTop = window.innerHeight - rect.height - 10
    }

    // Не допускаем отрицательные значения
    menu.style.left = `${Math.max(10, newLeft)}px`
    menu.style.top = `${Math.max(10, newTop)}px`
  })

  // Close on click outside
  const closeHandler = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('[data-context-menu]')) {
      hideContextMenu()
      document.removeEventListener('click', closeHandler)
    }
  }

  // Close on Escape
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      hideContextMenu()
      document.removeEventListener('keydown', escHandler)
    }
  }

  // All exits (item action, host disposal, outside-click, Escape) remove BOTH
  // listeners. Otherwise an old handler can dismiss a later editor's menu.
  ;(menu as any)._closeCleanup = () => {
    document.removeEventListener('click', closeHandler)
    document.removeEventListener('keydown', escHandler)
  }

  setTimeout(() => {
    if (!menu.isConnected) return
    document.addEventListener('click', closeHandler)
    document.addEventListener('keydown', escHandler)
  }, 0)
}

export function hideContextMenu() {
  const existing = document.querySelector('[data-context-menu]') as any
  if (existing) {
    existing._closeCleanup?.()
    existing._emojiCleanup?.()
    existing.remove()
  }
}

// ============================================================================
// Command Palette (Cmd+/)
// ============================================================================

interface PaletteItem {
  label: string
  color: string
  action: (view: EditorView) => void
  /** Optional second clickable half (e.g. "+ paste" beside "📋 AI Paste"). */
  altLabel?: string
  altAction?: (view: EditorView) => void
}

/**
 * Прогнать одно-range палитровое действие по ВСЕМ курсорам/выделениям.
 *
 * Все action-функции (wrapSelection/toggleLinePrefix/setHeadingLevel/…) читают
 * только `state.selection.main` — поэтому при мульти-курсоре (Cmd+click) формат
 * применялся бы лишь к последнему range. Драйвер делает поведение идентичным
 * single-cursor, но для каждой ветки: где есть выделение — форматирует выделенный
 * текст, где только курсор — всю строку (логику выбора решает сама action).
 *
 * Стратегия — последовательные dispatch'и, range за range, СНИЗУ ВВЕРХ (по
 * убыванию позиции). Почему так, а не один объединённый transaction:
 *   • Каждая action сама диспатчит (а toggleLinePrefix ещё и пере-читает state
 *     между шагами — unfold, затем правка). Собрать их в один changeset нельзя
 *     без переписывания всех шести функций и риска рассинхрона позиций.
 *   • Идём снизу вверх, чтобы правки на нижних строках НЕ сдвигали ещё не
 *     обработанные верхние (их from/to остаются валидны). CM6 ремапит selection
 *     сам, но порядок «снизу вверх» исключает любые сдвиги для pending-ranges.
 *   • Каждый шаг временно ставит свой range как единственный `.main` (через
 *     dispatch с addToHistory:false — это служебное перемещение курсора, не
 *     отдельный undo-шаг), затем зовёт action на свежем view.
 *
 * Один range (или ноль) → прямой вызов action, нулевой риск (старый путь).
 */
function runOverRanges(view: EditorView, action: (v: EditorView) => void) {
  const ranges = view.state.selection.ranges
  if (ranges.length <= 1) { action(view); return }

  // Снимок СТРОК, затронутых каждым range, ДО любых правок. После всех action'ов
  // (которые смещают позиции документа) резолвим линии заново из свежего state
  // и ставим картеки в их концы. Это сохраняет исходную мульти-каретку — юзер
  // видит те же N курсоров, что и при открытии палитры, но в результирующих
  // позициях. → запрос: «курсор в конец всех выделенных строк».
  const touchedLines: number[] = []
  for (const r of ranges) {
    const a = view.state.doc.lineAt(r.from).number
    const b = view.state.doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) {
      if (!touchedLines.includes(n)) touchedLines.push(n)
    }
  }

  // Снимок (from,to) каждого range. Идём по убыванию from — правки снизу не
  // двигают позиции верхних.
  const snaps = ranges
    .map(r => ({ from: r.from, to: r.to }))
    .sort((a, b) => b.from - a.from)

  for (const s of snaps) {
    const len = view.state.doc.length
    const from = Math.min(s.from, len)
    const to = Math.min(s.to, len)
    // Поставить ЭТОТ range единственным main, чтобы action (читающий .main)
    // отработал именно по нему. Служебный dispatch — не в историю
    // (addToHistory — это аннотация транзакции, не поле dispatch).
    view.dispatch({
      selection: EditorSelection.single(from, to),
      annotations: Transaction.addToHistory.of(false),
    })
    action(view)
  }

  // Восстановить мульти-каретку: для каждой ИСХОДНО затронутой строки резолвим
  // её номер заново из свежего state (позиции могли сместиться) и ставим каретку
  // в КОНЕЦ КОНТЕНТА строки (перед закрывающими маркерами/пробелами) — так же,
  // как wrapSelection в single-режиме ставит курсор внутри **, а не после них.
  // line.to даёт позицию сразу за \n, включая маркеры; contentEnd — перед ними.
  const restored: Array<ReturnType<typeof EditorSelection.range>> = []
  for (const ln of touchedLines.sort((a, b) => a - b)) {
    if (ln >= 1 && ln <= view.state.doc.lines) {
      const line = view.state.doc.line(ln)
      // От line.to отступаем назад: убираем хвостовые пробелы, затем закрывающие
      // markup-символы (*, _, ~, `). Это позиция «конец полезного текста» —
      // зеркало того, куда wrapSelection ставит каретку при single-формате.
      let contentEnd = line.to
      const raw = line.text
      // 1) откусываем пробелы с конца
      let trimEnd = raw.length
      while (trimEnd > 0 && (raw[trimEnd-1] === ' ' || raw[trimEnd-1] === '\t')) trimEnd--
      // 2) откусываем markup-хвост (** или * и т.п.) — ровно те же символы,
      //    что wrapSelection проверяет как маркеры.
      const MARKUP_CHARS = '*_~`'
      while (trimEnd > 0 && MARKUP_CHARS.includes(raw[trimEnd-1])) trimEnd--
      contentEnd = line.from + trimEnd
      restored.push(EditorSelection.range(contentEnd, contentEnd))
    }
  }
  if (restored.length > 0) {
    view.dispatch({
      selection: EditorSelection.create(restored, restored.length - 1),
      annotations: Transaction.addToHistory.of(false),
      scrollIntoView: true,
    })
  }
}

function getPaletteItems(view: EditorView): PaletteItem[] {
  const headingLevel = getCurrentHeadingLevel(view)
  const isBold = isWrappedWith(view, '**')
  const isItalic = isWrappedWith(view, '*') && !isBold
  const isCode = isWrappedWith(view, '`')
  const isCollapsible = hasLinePrefix(view, '>>') || hasLinePrefix(view, '^^')
  return [
    {
      label: isCollapsible ? '✓ Collapsible' : 'Collapsible',
      color: 'var(--gt-md-strike)',
      action: (v) => runOverRanges(v, (vv) => applyCollapsibleFromPalette(vv)),
      altLabel: '＋ paste',
      altAction: (v) => activateNonAIPasteMode(v),
    },
    { label: isBold ? '✓ Bold' : 'Bold', color: 'var(--gt-md-bold)', action: (v) => runOverRanges(v, (vv) => wrapSelection(vv, '**')) },
    { label: isItalic ? '✓ Italic' : 'Italic', color: 'var(--gt-md-italic)', action: (v) => runOverRanges(v, (vv) => wrapSelection(vv, '*')) },
    { label: isCode ? '✓ Code' : 'Code', color: 'var(--gt-md-code)', action: (v) => runOverRanges(v, (vv) => wrapSelection(vv, '`')) },
    { label: headingLevel === 1 ? '✓ H1' : 'H1', color: 'var(--gt-md-h1)', action: (v) => runOverRanges(v, (vv) => setHeadingLevel(vv, headingLevel === 1 ? 0 : 1)) },
    { label: headingLevel === 2 ? '✓ H2' : 'H2', color: 'var(--gt-md-h2)', action: (v) => runOverRanges(v, (vv) => setHeadingLevel(vv, headingLevel === 2 ? 0 : 2)) },
    { label: headingLevel === 3 ? '✓ H3' : 'H3', color: 'var(--gt-md-h3)', action: (v) => runOverRanges(v, (vv) => setHeadingLevel(vv, headingLevel === 3 ? 0 : 3)) },
    { label: '📋 AI Paste', color: '#4ecdc4', action: (v) => activateAIPasteMode(v) },
  ]
}

let paletteKeydownHandler: ((e: KeyboardEvent) => void) | null = null
let paletteClickHandler: ((e: MouseEvent) => void) | null = null

export function hideCommandPalette() {
  const existing = document.querySelector('[data-command-palette]')
  if (existing) {
    existing.remove()
  }
  if (paletteKeydownHandler) {
    document.removeEventListener('keydown', paletteKeydownHandler, true)
    paletteKeydownHandler = null
  }
  if (paletteClickHandler) {
    document.removeEventListener('click', paletteClickHandler)
    paletteClickHandler = null
  }
}

export function showCommandPalette(view: EditorView, capturedSelection?: EditorSelection) {
  hideCommandPalette()

  // Priority: capturedSelection > current view selection > lastNonEmptySelection
  // When capturedSelection is provided (from Cmd+/ keydown at Prec.highest),
  // trust it — if it's empty, user genuinely has no selection.
  // Only fallback to lastNonEmptySelection when NO capturedSelection was provided.
  let sel = capturedSelection ?? view.state.selection
  if (!capturedSelection && sel.main.empty && lastNonEmptySelection && !lastNonEmptySelection.main.empty) {
    sel = lastNonEmptySelection
  }
  const selMain = sel.main

  // Restore selection into the view so getPaletteItems/isWrappedWith see it.
  // Восстанавливаем и при мульти-курсоре БЕЗ выделения (несколько пустых кареток):
  // иначе runOverRanges не увидит все range'ы. Раньше гейт был только на !empty.
  if (!selMain.empty || sel.ranges.length > 1) {
    view.dispatch({ selection: sel })
  }

  const pos = selMain.head
  // coordsAtPos returns null at fold boundaries (cursor at end of folded ^^ line).
  // Fallback: side=-1 gets coords from the left (visible) side of the boundary.
  const coords = view.coordsAtPos(pos) ?? view.coordsAtPos(pos, -1)
  if (!coords) return

  const items = getPaletteItems(view)

  const palette = document.createElement('div')
  palette.className = 'cm-command-palette'
  palette.setAttribute('data-command-palette', 'true')
  palette.style.left = `${coords.left}px`
  palette.style.top = `${coords.bottom + 4}px`

  // Header при МУЛЬТИ-курсоре (Cmd+click): сколько строк/выделений затронем.
  // Формат применится к каждому range (см. runOverRanges). Считаем уникальные
  // строки по range'ам — пользователь думает в строках, не в каретках.
  const ranges = sel.ranges
  if (ranges.length > 1) {
    const lineSet = new Set<number>()
    for (const r of ranges) {
      const a = view.state.doc.lineAt(r.from).number
      const b = view.state.doc.lineAt(r.to).number
      for (let n = a; n <= b; n++) lineSet.add(n)
    }
    const header = document.createElement('div')
    header.className = 'cm-command-palette-header'
    const n = lineSet.size
    // Русская плюрализация строк: 1 строка / 2 строки / 5 строк.
    const plural = (k: number) => {
      const m10 = k % 10, m100 = k % 100
      if (m10 === 1 && m100 !== 11) return 'строка'
      if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'строки'
      return 'строк'
    }
    header.textContent = `Выделено: ${n} ${plural(n)}`
    palette.appendChild(header)
  } else if (!selMain.empty) {
    // Одиночное выделение — превью текста (как было).
    const selectedText = view.state.sliceDoc(selMain.from, selMain.to)
    const preview = document.createElement('div')
    preview.className = 'cm-command-palette-preview'
    const truncated = selectedText.length > 30 ? selectedText.slice(0, 30) + '...' : selectedText
    preview.textContent = truncated
    palette.appendChild(preview)
  }

  // Items container (so renderItems doesn't destroy preview)
  const itemsContainer = document.createElement('div')
  palette.appendChild(itemsContainer)

  let activeIndex = 0
  // Only meaningful when the active row is a split item (altAction present).
  let activeHalf: 'left' | 'right' = 'left'

  function isSplit(item: PaletteItem): boolean {
    return typeof item.altAction === 'function'
  }

  function renderItems() {
    itemsContainer.innerHTML = ''
    items.forEach((item, i) => {
      const el = document.createElement('div')
      const isActiveRow = i === activeIndex
      el.className = 'cm-command-palette-item' + (isActiveRow && !isSplit(item) ? ' active' : '')

      const colorBar = document.createElement('span')
      colorBar.className = 'palette-color'
      colorBar.style.backgroundColor = item.color
      el.appendChild(colorBar)

      if (isSplit(item)) {
        el.classList.add('split')

        const left = document.createElement('span')
        left.className = 'palette-half palette-half-left'
        if (isActiveRow && activeHalf === 'left') left.classList.add('active')
        left.textContent = item.label
        left.addEventListener('click', (e) => {
          e.stopPropagation()
          hideCommandPalette()
          item.action(view)
          view.focus()
        })

        const right = document.createElement('span')
        right.className = 'palette-half palette-half-right'
        if (isActiveRow && activeHalf === 'right') right.classList.add('active')
        right.textContent = item.altLabel ?? ''
        right.addEventListener('click', (e) => {
          e.stopPropagation()
          hideCommandPalette()
          item.altAction!(view)
          view.focus()
        })

        el.appendChild(left)
        el.appendChild(right)
      } else {
        const label = document.createElement('span')
        label.textContent = item.label
        el.appendChild(label)
        el.addEventListener('click', (e) => {
          e.stopPropagation()
          hideCommandPalette()
          item.action(view)
          view.focus()
        })
      }

      itemsContainer.appendChild(el)
    })
  }

  renderItems()
  document.body.appendChild(palette)

  // Arm hover-highlight only after the cursor actually moves inside the palette
  // — otherwise an item under a stationary mouse cursor steals focus the moment
  // Cmd+/ opens the palette. CSS rule `.mouse-armed .cm-command-palette-item:hover`
  // does nothing until this class lands.
  const armMouse = () => {
    palette.classList.add('mouse-armed')
    palette.removeEventListener('mousemove', armMouse)
  }
  palette.addEventListener('mousemove', armMouse)

  // Adjust position if off-screen
  requestAnimationFrame(() => {
    const rect = palette.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      palette.style.left = `${window.innerWidth - rect.width - 10}px`
    }
    if (rect.bottom > window.innerHeight) {
      palette.style.top = `${coords.top - rect.height - 4}px`
    }
    palette.style.left = `${Math.max(10, parseInt(palette.style.left))}px`
    palette.style.top = `${Math.max(10, parseInt(palette.style.top))}px`
  })

  // Save selection to restore after action
  const savedSelection = sel

  paletteKeydownHandler = (e: KeyboardEvent) => {
    const activeItem = items[activeIndex]
    const splitNow = activeItem && isSplit(activeItem)

    if (
      e.key === 'ArrowDown' ||
      e.key === 'ArrowUp' ||
      e.key === 'Enter' ||
      e.key === 'Escape' ||
      ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && splitNow)
    ) {
      // Stop event from reaching CodeMirror
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
    }

    if (e.key === 'ArrowDown') {
      activeIndex = (activeIndex + 1) % items.length
      activeHalf = 'left'
      renderItems()
    } else if (e.key === 'ArrowUp') {
      activeIndex = (activeIndex - 1 + items.length) % items.length
      activeHalf = 'left'
      renderItems()
    } else if (e.key === 'ArrowRight' && splitNow) {
      activeHalf = 'right'
      renderItems()
    } else if (e.key === 'ArrowLeft' && splitNow) {
      activeHalf = 'left'
      renderItems()
    } else if (e.key === 'Enter') {
      const item = items[activeIndex]
      const action = isSplit(item) && activeHalf === 'right' ? item.altAction! : item.action
      hideCommandPalette()
      // Restore cursor position before applying action (in case arrows moved it)
      view.dispatch({ selection: savedSelection })
      action(view)
      view.focus()
    } else if (e.key === 'Escape') {
      hideCommandPalette()
      // Restore cursor position
      view.dispatch({ selection: savedSelection })
      view.focus()
    }
  }

  paletteClickHandler = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('[data-command-palette]')) {
      hideCommandPalette()
    }
  }

  setTimeout(() => {
    document.addEventListener('keydown', paletteKeydownHandler!, true)
    document.addEventListener('click', paletteClickHandler!)
  }, 0)
}

// Create context menu handler for EditorView
export function createContextMenuHandler(config?: ContextMenuConfig): Extension {
  return Prec.highest(EditorView.domEventHandlers({
    contextmenu: (event, view) => {
      // console.log('[ContextMenu] Right click at', event.clientX, event.clientY)
      event.preventDefault()

      const selection = view.state.selection.main
      const clickPos = view.posAtCoords({ x: event.clientX, y: event.clientY })

      // Только перемещать курсор если НЕТ выделения или клик ВНЕ выделения
      if (clickPos !== null) {
        const hasSelection = !selection.empty
        const clickInsideSelection = hasSelection && clickPos >= selection.from && clickPos <= selection.to

        if (!clickInsideSelection) {
          // Клик вне выделения — перемещаем курсор
          view.dispatch({
            selection: { anchor: clickPos }
          })
        }
        // Если клик внутри выделения — оставляем выделение как есть
      }

      showContextMenu(view, event.clientX, event.clientY, undefined, config)
      return true
    },
  }))
}
