import { keymap, EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { foldable, foldedRanges, foldEffect } from '@codemirror/language'
import { findBlock } from './blockMove'
import { type ClipboardAdapter, resolveClipboardAdapter } from './clipboardAdapter'
import {
  adoptForeignImagePathMarkers,
  buildPortableImageClipboardOutput,
  buildPortableImageClipboardText,
} from './foreignImagePath'

export interface ClipboardConfig {
  onImagePaste?: (base64: string) => Promise<string | null>
  onGenerateTitle?: (text: string) => Promise<string>
  /**
   * Injectable clipboard transport. When omitted, falls back to
   * `navigator.clipboard` (web). Electron hosts pass an adapter backed by
   * Electron's `clipboard` module — navigator.clipboard is dead in a renderer
   * with no native Edit menu. See clipboardAdapter.ts.
   */
  clipboard?: ClipboardAdapter
}

/**
 * Normalize indentation of pasted text relative to cursor position.
 *
 * Example:
 *   Cursor at position with 4-space indent
 *   Pasting:
 *       line1  (8 spaces)
 *     line2    (4 spaces - minimum)
 *       line3  (8 spaces)
 *
 *   Result:
 *     line1    (4 + 4 = 8, relative preserved)
 *     line2    (4 + 0 = 4)
 *     line3    (4 + 4 = 8)
 */
function normalizeIndent(text: string, currentIndent: string): string {
  const lines = text.split('\n')

  // Single line - no normalization needed
  if (lines.length <= 1) return text

  // Find minimum indent across ALL non-empty lines (including first!)
  let minIndent = Infinity
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue // Skip empty lines

    const indent = line.match(/^[ \t]*/)?.[0] || ''
    const indentSize = countIndentSize(indent)
    if (indentSize < minIndent) {
      minIndent = indentSize
    }
  }

  // If no indented lines found, use 0
  if (minIndent === Infinity) minIndent = 0

  // Normalize lines:
  // - Line 0: remove minIndent, but DON'T add currentIndent (cursor is already positioned)
  // - Line 1+: remove minIndent, add currentIndent + relativeIndent
  const result: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.trim() === '') {
      // Preserve empty lines (with currentIndent for lines after first)
      result.push(i === 0 ? '' : currentIndent)
      continue
    }

    // Calculate current line's indent
    const lineIndent = line.match(/^[ \t]*/)?.[0] || ''
    const lineIndentSize = countIndentSize(lineIndent)

    // Calculate relative indent (how much more than minimum)
    const relativeIndent = lineIndentSize - minIndent

    // First line: only relative indent (cursor already has position)
    // Other lines: currentIndent + relative indent
    const newIndent = i === 0
      ? ' '.repeat(Math.max(0, relativeIndent))
      : currentIndent + ' '.repeat(Math.max(0, relativeIndent))

    // Replace old indent with new
    result.push(newIndent + line.slice(lineIndent.length))
  }

  return result.join('\n')
}

/**
 * Count indent size (tabs = 4 spaces)
 */
function countIndentSize(indent: string): number {
  let size = 0
  for (const char of indent) {
    if (char === '\t') {
      size += 4 - (size % 4)
    } else {
      size++
    }
  }
  return size
}

/**
 * Get current line's indent at cursor position
 */
function getCurrentIndent(view: EditorView): string {
  const pos = view.state.selection.main.head
  const line = view.state.doc.lineAt(pos)
  const lineText = line.text

  // Extract leading whitespace
  const match = lineText.match(/^[ \t]*/)
  return match ? match[0] : ''
}

/**
 * Paste text with normalized indentation
 */
function pasteWithNormalizedIndent(view: EditorView, text: string): void {
  const selection = view.state.selection.main
  const currentIndent = getCurrentIndent(view)
  const adoptedImages = adoptForeignImagePathMarkers(text)
  if (adoptedImages.adopted > 0) {
    console.log('[Clipboard:Paste] adopted foreign image markers', { count: adoptedImages.adopted })
  }
  const normalizedText = normalizeIndent(adoptedImages.text, currentIndent)

  console.log('[Clipboard:Paste] normalizedIndent dispatch', {
    rawLen: text.length,
    normLen: normalizedText.length,
    currentIndentLen: currentIndent.length,
    insertFrom: selection.from, insertTo: selection.to,
    looksLikeCollapsibleHeader: /^\s*\^\^/.test(normalizedText),
    first60: normalizedText.slice(0, 60),
  })

  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: normalizedText },
    selection: { anchor: selection.from + normalizedText.length }
  })

  // If the pasted text contains `^^` headers (e.g. user did Cmd+C on a folded
  // block then Cmd+V here), fold them synchronously to avoid the 1-frame flash
  // that setTimeout(0)-based autoFoldCollapsedMarkers would produce.
  if (normalizedText.includes('^^')) {
    refoldNewMarkersInRange(view, selection.from, selection.from + normalizedText.length)
  }
}

/**
 * Walk lines in [from..to] and fold any unfolded `^^` headers found there.
 * Synchronous — call right after a text-changing dispatch to keep the browser
 * from painting a frame with expanded bodies.
 */
function refoldNewMarkersInRange(view: EditorView, from: number, to: number): void {
  const doc = view.state.doc
  const startLine = doc.lineAt(Math.max(0, from)).number
  const endLine = doc.lineAt(Math.min(to, doc.length)).number
  const effects: any[] = []
  for (let i = startLine; i <= endLine; i++) {
    const line = doc.line(i)
    if (!line.text.trim().startsWith('^^')) continue
    let already = false
    foldedRanges(view.state).between(line.from, line.to, () => { already = true })
    if (already) continue
    const range = foldable(view.state, line.from, line.to)
    if (range && (range.to - range.from) > 2) {
      effects.push(foldEffect.of(range))
    }
  }
  if (effects.length > 0) {
    view.dispatch({ effects })
  }
}

/**
 * If the cursor's line is the root of a tree (= has at least one deeper-indented
 * child below it), return the full subtree range (line.from .. last-descendant.to).
 * Returns null if the line is a leaf (no children) — caller should fall through
 * to CM6's default single-line copy.
 *
 * Covers two cases uniformly:
 *   - Folded `^^` collapsible: the stored fold range is exact, use it directly
 *     (matches what the user visually perceives as "the block").
 *   - Anything else (expanded `>>`, headings with nested content, list items
 *     with sub-items, plain indented blocks): delegate to `findBlock` from
 *     blockMove — same indent-based subtree detection that Alt+Up/Down already
 *     uses, so Cmd+C/X agrees with what gets moved as one unit.
 *
 * Single-line semantics: if a line has no children, return null. Default CM6
 * line-copy already copies that one line — no need to override.
 */
function indentBlockRange(view: EditorView): { from: number; to: number } | null {
  const { state } = view
  const doc = state.doc
  const line = doc.lineAt(state.selection.main.head)

  // Folded ^^ first — stored range is authoritative.
  let foldedTo: number | null = null
  foldedRanges(state).between(line.from, line.to, (_from, to) => {
    foldedTo = to
  })
  if (foldedTo !== null) {
    return { from: line.from, to: foldedTo as number }
  }

  // Don't promote an empty line into "tree root". findBlock treats an empty
  // indent-0 line as a parent of everything indented below it (see fact-block-move.md::4.6)
  // — fine for Alt+Up/Down where the block-as-mover semantics make sense, but
  // wrong for Cmd+C/X where the user clearly cued the empty line as a separator
  // and would not expect "copy from cursor down through the entire next subtree".
  if (line.text.trim() === '') return null

  // Indent-based subtree (works for any line, not just collapsible markers).
  const block = findBlock(doc, line.number, state.tabSize)
  if (block.endLine === block.startLine) return null // leaf — no children

  const endLine = doc.line(block.endLine)
  return { from: line.from, to: endLine.to }
}

/**
 * Paste clipboard as collapsed `^^ paste text [N]` block.
 *
 * Scans lines below cursor to detect max indent — if existing content
 * has deeper indent, the header must be placed at that level so the
 * fold service (indent > baseIndent) doesn't absorb existing blocks.
 */
function pasteAsCollapsed(view: EditorView, cb: ClipboardAdapter): boolean {
  console.log('[Clipboard:Paste] pasteAsCollapsed ENTRY', {
    pos: view.state.selection.main.head,
    stack: new Error().stack?.split('\n').slice(2, 6).join(' | ')
  })
  Promise.resolve(cb.readText()).then((text) => {
    if (!text) { console.log('[Clipboard:Paste] pasteAsCollapsed: empty clipboard'); return }

    // Read fresh state after async
    const sel = view.state.selection.main
    const doc = view.state.doc
    const line = doc.lineAt(sel.head)
    const currentIndent = line.text.match(/^[ \t]*/)?.[0] || ''
    const currentIndentSize = countIndentSize(currentIndent)

    // Scan lines below: find max indent that fold would absorb
    let maxIndentBelow = 0
    for (let i = line.number + 1; i <= doc.lines; i++) {
      const nextLine = doc.line(i)
      if (nextLine.text.trim() === '') continue
      const nextIndentSize = countIndentSize(nextLine.text.match(/^[ \t]*/)?.[0] || '')
      if (nextIndentSize <= currentIndentSize) break
      if (nextIndentSize > maxIndentBelow) maxIndentBelow = nextIndentSize
    }

    // Header indent >= maxIndentBelow so existing content won't be absorbed
    const headerIndentSize = Math.max(currentIndentSize, maxIndentBelow)
    const headerIndent = ' '.repeat(headerIndentSize)
    const bodyIndent = headerIndent + '    '

    const charCount = text.length
    const header = `${headerIndent}^^ paste text [${charCount}]`
    // Хвостовые \n буфера срезаем ДО разбиения: text="a\nb\n" → split даёт
    // ["a","b",""] → пустой хвост получал bodyIndent → «лишняя пустая строка
    // с отступом» внутри секции после вставки (баг юзера). trimEnd хвоста.
    const bodyLines = text.replace(/\n+$/, '').split('\n').map(l => l.trim() === '' ? '' : bodyIndent + l)
    // Trailing `\n` is critical: places cursor OUTSIDE the fold.
    // Without it, cursor lands at `headerLine.to` == `fold.from`, which is
    // INSIDE Decoration.replace({inclusive: true}) — DOM node gets removed
    // and the blinking cursor disappears (typing still works, but blind).
    const block = header + '\n' + bodyLines.join('\n') + '\n'

    // Replace from line.from to consume existing indent (header already has it).
    // Курсор здесь — ВРЕМЕННО за блоком (вне будущего fold); финальная позиция
    // (конец заголовка) выставляется НИЖЕ в одной транзакции с foldEffect: только
    // когда граница fold реальна, assoc=-1 переживает нормализацию CM6 и каретка
    // на fold.from остаётся видимой (шрам: cursorPos==fold.from с assoc=0 →
    // coordsAtPos пробует скрытый виджет → null → каретка-DOM не строится).
    // → fix-cm6-cursor-selection.md::Cursor stuck inside fold.
    const insertFrom = line.from
    view.dispatch({
      changes: { from: insertFrom, to: sel.to, insert: block },
      selection: { anchor: insertFrom + block.length }
    })

    // Synchronous refold: fold ^^ immediately in the same event loop cycle
    // (before browser paint) to avoid flash of expanded content.
    // Same technique as blockMove.ts:refoldCollapsedMarkers()
    const headerLine = view.state.doc.lineAt(insertFrom)
    if (headerLine.text.trim().startsWith('^^')) {
      let isFolded = false
      foldedRanges(view.state).between(headerLine.from, headerLine.to, () => {
        isFolded = true
      })
      if (!isFolded) {
        const range = foldable(view.state, headerLine.from, headerLine.to)
        if (range && (range.to - range.from) > 2) {
          // Fold + курсор в конец заголовка АТОМАРНО (см. коммент выше).
          view.dispatch({
            effects: foldEffect.of(range),
            selection: EditorSelection.cursor(headerLine.to, -1),
          })
        }
      }
    }
  }).catch(err => console.error('[Clipboard]', err))

  return true
}

/**
 * Paste clipboard as collapsed block with AI-generated title.
 * Inserts `^^ ⏳` placeholder, calls onGenerateTitle, then replaces ⏳ with the result.
 */
function pasteAsCollapsedAI(view: EditorView, onGenerateTitle: (text: string) => Promise<string>, cb: ClipboardAdapter): boolean {
  console.warn('[clipboard:pasteAsCollapsedAI] ENTRY', { hasCallback: typeof onGenerateTitle === 'function' })
  Promise.resolve(cb.readText()).then((text) => {
    if (!text) { console.warn('[clipboard:pasteAsCollapsedAI] empty clipboard'); return }
    console.warn('[clipboard:pasteAsCollapsedAI] clipboard read', { textLen: text.length })

    // Read fresh state after async
    const sel = view.state.selection.main
    const doc = view.state.doc
    const line = doc.lineAt(sel.head)
    const currentIndent = line.text.match(/^[ \t]*/)?.[0] || ''
    const currentIndentSize = countIndentSize(currentIndent)

    // Scan lines below: find max indent that fold would absorb
    let maxIndentBelow = 0
    for (let i = line.number + 1; i <= doc.lines; i++) {
      const nextLine = doc.line(i)
      if (nextLine.text.trim() === '') continue
      const nextIndentSize = countIndentSize(nextLine.text.match(/^[ \t]*/)?.[0] || '')
      if (nextIndentSize <= currentIndentSize) break
      if (nextIndentSize > maxIndentBelow) maxIndentBelow = nextIndentSize
    }

    // Header indent >= maxIndentBelow so existing content won't be absorbed
    const headerIndentSize = Math.max(currentIndentSize, maxIndentBelow)
    const headerIndent = ' '.repeat(headerIndentSize)
    const bodyIndent = headerIndent + '    '

    const header = `${headerIndent}^^ ⏳`
    // Хвостовые \n буфера срезаем ДО разбиения — иначе пустой хвост split'а
    // получает bodyIndent → лишняя пустая строка в секции (см. pasteAsCollapsed).
    const bodyLines = text.replace(/\n+$/, '').split('\n').map(l => l.trim() === '' ? '' : bodyIndent + l)
    // Trailing `\n` lands cursor OUTSIDE the fold (see pasteAsCollapsed).
    const block = header + '\n' + bodyLines.join('\n') + '\n'

    // Replace from line.from to consume existing indent (header already has it)
    const insertFrom = line.from
    view.dispatch({
      changes: { from: insertFrom, to: sel.to, insert: block },
      selection: { anchor: insertFrom + block.length }
    })

    // Synchronous refold + курсор в конец заголовка атомарно с fold (assoc=-1
    // переживает нормализацию только когда граница fold уже реальна — см.
    // pasteAsCollapsed / fix-cm6-cursor-selection.md).
    const headerLine = view.state.doc.lineAt(insertFrom)
    if (headerLine.text.trim().startsWith('^^')) {
      let isFolded = false
      foldedRanges(view.state).between(headerLine.from, headerLine.to, () => {
        isFolded = true
      })
      if (!isFolded) {
        const range = foldable(view.state, headerLine.from, headerLine.to)
        if (range && (range.to - range.from) > 2) {
          view.dispatch({
            effects: foldEffect.of(range),
            selection: EditorSelection.cursor(headerLine.to, -1),
          })
        }
      }
    }

    // Call AI to generate title, then replace ⏳ with it
    console.warn('[clipboard:pasteAsCollapsedAI] calling onGenerateTitle…')
    onGenerateTitle(text).then((title) => {
      console.warn('[clipboard:pasteAsCollapsedAI] onGenerateTitle resolved', { title })
      const resolvedTitle = (title && title.trim()) ? title.trim() : 'paste text'
      // Re-read document state (may have changed during async AI call)
      const currentDoc = view.state.doc
      for (let i = 1; i <= currentDoc.lines; i++) {
        const ln = currentDoc.line(i)
        const match = ln.text.match(/^(\s*)\^\^\s*⏳\s*$/)
        if (match) {
          const indent = match[1]
          const newText = `${indent}^^ ${resolvedTitle}`
          // Если каретка стоит на placeholder-строке (юзер не ушёл) — после
          // замены явно ставим её в конец НОВОГО заголовка (assoc=-1: позиция
          // совпадает с fold.from). Без selection в этом dispatch CM6 ремапит
          // старую позицию через changeset и каретка оказывалась не в конце
          // строки («позиционирование курсора после ai-вставки», баг юзера).
          // Если юзер уже печатает в другом месте — selection не трогаем.
          const selHead = view.state.selection.main.head
          const caretOnPlaceholder = selHead >= ln.from && selHead <= ln.to
          view.dispatch({
            changes: { from: ln.from, to: ln.to, insert: newText },
            ...(caretOnPlaceholder
              ? { selection: EditorSelection.cursor(ln.from + newText.length, -1) }
              : {}),
          })
          break
        }
      }
    }).catch((err) => {
      console.error('[clipboard:pasteAsCollapsedAI] AI title generation failed:', err?.message || err, err)
      // Fallback: replace ⏳ with 'paste text'
      const currentDoc = view.state.doc
      for (let i = 1; i <= currentDoc.lines; i++) {
        const ln = currentDoc.line(i)
        const match = ln.text.match(/^(\s*)\^\^\s*⏳\s*$/)
        if (match) {
          const indent = match[1]
          const newText = `${indent}^^ paste text`
          view.dispatch({
            changes: { from: ln.from, to: ln.to, insert: newText }
          })
          break
        }
      }
    })
  }).catch(err => console.error('[Clipboard]', err))

  return true
}

// === Paste Waiting Modes (AI / non-AI) ===
// When activated (from Command Palette), next Cmd+V triggers the matching paste flow.
// The two modes are mutually exclusive — activating one cancels the other.
let _waitingForAIPaste = false
let _waitingForNonAIPaste = false
let _waitingIndicator: HTMLElement | null = null
let _waitingView: EditorView | null = null

function positionIndicator(view: EditorView, indicator: HTMLElement): void {
  const pos = view.state.selection.main.head
  const coords = view.coordsAtPos(pos) ?? view.coordsAtPos(pos, -1)
  if (!coords) return
  indicator.style.left = `${coords.left}px`
  indicator.style.top = `${coords.bottom + 6}px`
  // Adjust if off-screen
  requestAnimationFrame(() => {
    if (!indicator.parentElement) return
    const rect = indicator.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      indicator.style.left = `${window.innerWidth - rect.width - 10}px`
    }
  })
}

function buildWaitingIndicator(view: EditorView, labelText: string, onCancel: () => void): HTMLElement {
  const indicator = document.createElement('div')
  indicator.className = 'cm-ai-paste-indicator'
  indicator.setAttribute('data-ai-paste-indicator', 'true')

  const badge = document.createElement('span')
  badge.className = 'cm-ai-paste-badge'
  badge.textContent = labelText

  const cancelBtn = document.createElement('span')
  cancelBtn.className = 'cm-ai-paste-cancel'
  cancelBtn.textContent = '✕'
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    onCancel()
  })

  indicator.appendChild(badge)
  indicator.appendChild(cancelBtn)
  document.body.appendChild(indicator)
  positionIndicator(view, indicator)
  return indicator
}

export function activateAIPasteMode(view: EditorView): void {
  console.log('[Clipboard:PasteMode] activate AI', {
    prevAI: _waitingForAIPaste, prevNonAI: _waitingForNonAIPaste,
    sameView: _waitingView === view,
    stack: new Error().stack?.split('\n').slice(2, 6).join(' | ')
  })
  cancelNonAIPasteMode()
  cancelAIPasteIndicator()
  _waitingForAIPaste = true
  _waitingView = view
  _waitingIndicator = buildWaitingIndicator(view, '📋 AI Paste', cancelAIPasteMode)
}

export function activateNonAIPasteMode(view: EditorView): void {
  console.log('[Clipboard:PasteMode] activate NonAI', {
    prevAI: _waitingForAIPaste, prevNonAI: _waitingForNonAIPaste,
    sameView: _waitingView === view,
    stack: new Error().stack?.split('\n').slice(2, 6).join(' | ')
  })
  cancelAIPasteMode()
  cancelAIPasteIndicator()
  _waitingForNonAIPaste = true
  _waitingView = view
  _waitingIndicator = buildWaitingIndicator(view, '＋ paste', cancelNonAIPasteMode)
}

function cancelAIPasteIndicator(): void {
  if (_waitingIndicator) {
    _waitingIndicator.remove()
    _waitingIndicator = null
  }
}

export function cancelAIPasteMode(): void {
  if (!_waitingForAIPaste) return
  console.log('[Clipboard:PasteMode] cancel AI')
  _waitingForAIPaste = false
  _waitingView = null
  cancelAIPasteIndicator()
}

export function cancelNonAIPasteMode(): void {
  if (!_waitingForNonAIPaste) return
  console.log('[Clipboard:PasteMode] cancel NonAI')
  _waitingForNonAIPaste = false
  _waitingView = null
  cancelAIPasteIndicator()
}

export function isAIPasteModeActive(): boolean {
  return _waitingForAIPaste
}

export function isNonAIPasteModeActive(): boolean {
  return _waitingForNonAIPaste
}

/** Update listener that repositions the paste indicator when cursor moves */
export const aiPasteTrackerPlugin = EditorView.updateListener.of((update) => {
  if (!(_waitingForAIPaste || _waitingForNonAIPaste) || !_waitingIndicator) return
  if (update.selectionSet || update.geometryChanged || update.viewportChanged) {
    positionIndicator(update.view, _waitingIndicator)
  }
})

// Clipboard keymap — reads/writes through an injectable ClipboardAdapter
// (config.clipboard). Defaults to navigator.clipboard for web; Electron hosts
// inject an electron.clipboard-backed adapter (navigator.clipboard is dead in a
// renderer with no native Edit menu). See clipboardAdapter.ts.
export function createClipboardKeymap(config: ClipboardConfig = {}) {
  // Resolve ONCE — every call site below shares this. Resolving per-call risks a
  // site forgetting the fallback and silently breaking the web build.
  const cb = resolveClipboardAdapter(config.clipboard)
  const logPortableExport = (
    portable: ReturnType<typeof buildPortableImageClipboardText>,
    route: 'keymap' | 'native',
  ) => {
    if (!portable.handled) return
    console.log('[Clipboard:PortableImage] export', {
      route,
      converted: portable.converted,
      partial: portable.partial,
      textLen: portable.text.length,
    })
  }
  const portableSelection = (view: EditorView, from: number, to: number) => {
    const portable = buildPortableImageClipboardText(view.state.doc.toString(), from, to)
    logPortableExport(portable, 'keymap')
    return portable.text
  }
  const portableNativeOutput = EditorView.clipboardOutputFilter.of((text, state) => {
    const portable = buildPortableImageClipboardOutput(
      state.doc.toString(),
      text,
      state.selection.ranges,
      state.lineBreak,
    )
    logPortableExport(portable, 'native')
    return portable.text
  })

  return [portableNativeOutput, keymap.of([
    {
      key: 'Mod-c',
      run: (view: EditorView) => {
        const selection = view.state.selection.main

        if (selection.empty) {
          // No selection: copy the cursor's subtree (the line + all deeper-indented
          // descendants). Covers collapsible `>>`/`^^` headers AND any nested list
          // item / heading with children. Single-line leaves fall through to CM6
          // default line-copy.
          const blockRange = indentBlockRange(view)
          if (blockRange) {
            const text = portableSelection(view, blockRange.from, blockRange.to)
            console.log('[Clipboard:Block] copy indent block',
              { from: blockRange.from, to: blockRange.to, textLen: text.length })
            Promise.resolve(cb.writeText(text)).catch((err) => {
              console.error('[Editor] Copy failed:', err)
            })
            return true
          }
          return false
        }

        const text = portableSelection(view, selection.from, selection.to)

        Promise.resolve(cb.writeText(text)).catch((err) => {
          console.error('[Editor] Copy failed:', err)
        })
        return true
      }
    },
    {
      key: 'Mod-x',
      run: (view: EditorView) => {
        const selection = view.state.selection.main

        if (selection.empty) {
          // Same subtree-aware special-case as Mod-c. Cut also drops the trailing
          // \n when the block is not the last in the document so the document
          // doesn't end up with a stray empty line where the section used to be.
          const blockRange = indentBlockRange(view)
          if (blockRange) {
            const text = portableSelection(view, blockRange.from, blockRange.to)
            // Удаляем блок ВМЕСТЕ с одним соседним \n, иначе остаётся пустая строка.
            // Mid-doc — съедаем трейлинг (to+1). Last-in-doc — трейлинга нет, поэтому
            // съедаем ЛИДИНГ \n (from-1 = конец предыдущей строки). Без leading-ветки
            // cut последнего folded-блока оставлял пустую строку, а курсор уходил на
            // строку выше (баг: removeTo==to, строка не удалялась). text для clipboard
            // по-прежнему [from, to] — соседний \n не копируем.
            const atDocEnd = blockRange.to >= view.state.doc.length
            const removeFrom = atDocEnd && blockRange.from > 0
              ? blockRange.from - 1
              : blockRange.from
            const removeTo = atDocEnd
              ? blockRange.to
              : blockRange.to + 1
            console.log('[Clipboard:Block] cut indent block',
              { from: blockRange.from, to: blockRange.to,
                removeFrom, removeTo, atDocEnd, textLen: text.length })
            // Write first, then delete UNCONDITIONALLY. The old code put the
            // delete inside writeText().then() — fatal with Electron's adapter
            // where writeText may reject/not-resolve in some renderers: the
            // .then() never ran, so text was neither copied nor removed (cut did
            // nothing / data-loss shape). We capture text synchronously above,
            // fire the write fire-and-forget, and dispatch the delete in the same
            // tick while doc positions are still valid.
            Promise.resolve(cb.writeText(text)).catch((err) => {
              console.error('[Editor] Cut clipboard write failed:', err)
            })
            view.dispatch({
              changes: { from: removeFrom, to: removeTo, insert: '' },
              selection: { anchor: removeFrom },
              userEvent: 'delete.cut'
            })
            return true
          }
          return false
        }

        const text = portableSelection(view, selection.from, selection.to)

        // Same ordering fix as the subtree branch: write fire-and-forget, delete
        // synchronously so a rejecting/never-resolving writeText can't strand the
        // selection (the previous .then()-gated delete was the cut-does-nothing bug).
        Promise.resolve(cb.writeText(text)).catch((err) => {
          console.error('[Editor] Cut clipboard write failed:', err)
        })
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert: '' },
          selection: { anchor: selection.from },
          userEvent: 'delete.cut'
        })
        return true
      }
    },
    {
      key: 'Mod-v',
      run: (view: EditorView) => {
        const pos = view.state.selection.main.head
        const lineNum = view.state.doc.lineAt(pos).number
        // Always log the entry — which flags were set BEFORE we decided, so we
        // can trace why a plain Cmd+V suddenly produced a collapsible block.
        console.log('[Clipboard:PasteEntry] Mod-v', {
          waitingAI: _waitingForAIPaste,
          waitingNonAI: _waitingForNonAIPaste,
          sameView: _waitingView === view,
          waitingViewIsAttached: _waitingView ? !!(_waitingView as any).dom?.isConnected : null,
          hasAICallback: typeof config.onGenerateTitle === 'function',
          pos, line: lineNum,
        })
        // Check if non-AI Paste waiting mode is active (no AI call, fixed header)
        if (_waitingForNonAIPaste) {
          console.log('[Clipboard:PasteEntry] → pasteAsCollapsed (NonAI mode)')
          cancelAIPasteIndicator()
          _waitingForNonAIPaste = false
          _waitingView = null
          return pasteAsCollapsed(view, cb)
        }
        // Check if AI Paste waiting mode is active
        if (_waitingForAIPaste && config.onGenerateTitle) {
          console.log('[Clipboard:PasteEntry] → pasteAsCollapsedAI (AI mode)')
          cancelAIPasteIndicator()
          _waitingForAIPaste = false
          _waitingView = null
          return pasteAsCollapsedAI(view, config.onGenerateTitle, cb)
        }

        // Text-only paste through the adapter. Used when the adapter has no
        // readItems (Electron host omits it) — images then flow through the
        // native DOM `paste` handler (imagePaste.ts, event.clipboardData), which
        // works in Electron without permissions and without navigator.clipboard.
        const pasteTextOnly = () => {
          Promise.resolve(cb.readText()).then((text) => {
            if (text) {
              console.log('[Clipboard:PasteEntry] → pasteWithNormalizedIndent (text-only adapter)', {
                textLen: text.length, first40: text.slice(0, 40),
                hasNewlines: text.includes('\n'), lineCount: text.split('\n').length,
              })
              pasteWithNormalizedIndent(view, text)
            } else {
              console.log('[Clipboard:PasteEntry] → empty clipboard, nothing pasted')
            }
          }).catch((err) => console.error('[Clipboard] Text paste failed:', err))
        }

        if (!cb.readItems) {
          // No rich-items reader (Electron adapter): skip the image probe entirely.
          pasteTextOnly()
          return true
        }

        // Keep the existing rich-clipboard contract: when the clipboard offers
        // an actual bitmap, handle it as an image first. The foreign image-path
        // marker is adopted only after this path has naturally fallen through
        // to plain text, so adding that marker does not change normal paste.
        cb.readItems().then(async (items) => {
          for (const item of items) {
            // Check if there's an image
            const imageType = item.types.find(t => t.startsWith('image/'))
            if (imageType && config.onImagePaste) {
              try {
                const blob = await item.getType(imageType)
                const buffer = await blob.arrayBuffer()
                const uint8Array = new Uint8Array(buffer)
                let binary = ''
                for (let i = 0; i < uint8Array.length; i++) {
                  binary += String.fromCharCode(uint8Array[i])
                }
                const base64 = btoa(binary)

                console.log('[Clipboard:PasteEntry] → image paste', { base64Len: base64.length })
                const imagePath = await config.onImagePaste(base64)

                if (imagePath) {
                  // Inline insert, no trailing space/newline (see imagePaste.ts):
                  // caret at matchEnd is the token's edge → chip shows immediately.
                  const markdown = `![image](${imagePath})`
                  const pos = view.state.selection.main.head
                  view.dispatch({
                    changes: { from: pos, insert: markdown },
                    selection: { anchor: pos + markdown.length }
                  })
                }
                return // Image handled
              } catch (err) {
                console.error('[Clipboard] Image paste failed:', err)
              }
            }
          }

          // No image, paste text with normalized indent. Text-only
          // [imagePath: /abs/path] markers are adopted inside that text path.
          pasteTextOnly()
        }).catch((err) => {
          // Fallback to text-only paste
          console.warn('[Clipboard] readItems() failed, falling back to readText:', err)
          pasteTextOnly()
        })
        return true
      }
    },
    {
      key: 'Alt-Mod-v',
      run: (view: EditorView) => {
        console.log('[Clipboard:PasteEntry] Alt-Mod-v → pasteAsCollapsed (explicit hotkey)')
        return pasteAsCollapsed(view, cb)
      }
    },
    {
      key: 'Shift-Mod-v',
      run: (view: EditorView) => {
        console.log('[Clipboard:PasteEntry] Shift-Mod-v', {
          hasAICallback: typeof config.onGenerateTitle === 'function'
        })
        if (config.onGenerateTitle) {
          return pasteAsCollapsedAI(view, config.onGenerateTitle, cb)
        }
        return pasteAsCollapsed(view, cb)
      }
    }
  ])]
}
