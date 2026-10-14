import { ViewPlugin, EditorView } from '@codemirror/view'
import { buildFencedLineSet } from './directiveGuard'

/**
 * @-trigger palette — opens when the user types `@` in plain text.
 * Shows 4 options: AI block, Include, Embedding, Link.
 * Enter / click → replaces the `@` with a directive template, placing the
 * cursor inside the placeholder. If the trigger line wasn't empty, a `\n` is
 * prepended so the directive lands on its own line (all four widgets occupy
 * an entire line).
 *
 * Escape / click-outside / unrelated typing → close, leaving `@` in the doc.
 */

export interface AtTriggerMenuConfig {
  /**
   * Pick a file via native dialog. Used when the user selects the "Link" item.
   * Resolves to an absolute path or null if cancelled.
   */
  pickFileForLink?: () => Promise<string | null>
}

type ItemKey = 'ai' | 'include' | 'embedding' | 'link'

interface PaletteItem {
  key: ItemKey
  label: string
  hint: string
  color: string
}

const ITEMS: PaletteItem[] = [
  { key: 'ai',        label: 'AI block',           hint: 'multi-line @ai directive',         color: '#fab387' }, // peach
  { key: 'include',   label: 'Include file',       hint: 'inline file contents (relative)',  color: '#6cb6ff' }, // blue
  { key: 'embedding', label: 'Embedding source',   hint: 'GraphRAG indexing root',           color: '#f472b6' }, // pink
  { key: 'link',      label: 'Link to file',       hint: 'file pointer (pick via dialog)',   color: '#6ee7b7' }, // green
]

interface PaletteState {
  /** Doc position right AFTER the trigger `@` (i.e. caret position when palette opened). */
  triggerAfter: number
  /** Triggering line number — palette closes if selection moves to a different line. */
  triggerLine: number
}

let activePalette: HTMLDivElement | null = null
let activeState: PaletteState | null = null
let activeConfig: AtTriggerMenuConfig | undefined
let activeIndex = 0
let cleanupFns: (() => void)[] = []

function closePalette() {
  for (const fn of cleanupFns) {
    try { fn() } catch (_) {}
  }
  cleanupFns = []
  if (activePalette) {
    activePalette.remove()
    activePalette = null
  }
  activeState = null
  activeConfig = undefined
  activeIndex = 0
}

function isInsideFencedOrBacktick(view: EditorView, pos: number): boolean {
  const fenced = buildFencedLineSet(view.state)
  const line = view.state.doc.lineAt(pos)
  if (fenced.has(line.number)) return true
  // Inline code: count backticks before pos on this line. Odd → inside code.
  const before = view.state.doc.sliceString(line.from, pos)
  let count = 0
  for (let i = 0; i < before.length; i++) if (before[i] === '`') count++
  return count % 2 === 1
}

function renderPalette(view: EditorView) {
  if (!activePalette) return
  const list = activePalette.querySelector('.cm-at-palette-items') as HTMLDivElement | null
  if (!list) return
  list.innerHTML = ''
  ITEMS.forEach((item, i) => {
    const row = document.createElement('div')
    row.className = 'cm-at-palette-item' + (i === activeIndex ? ' active' : '')

    const bar = document.createElement('span')
    bar.className = 'cm-at-palette-color'
    bar.style.backgroundColor = item.color
    row.appendChild(bar)

    const label = document.createElement('span')
    label.className = 'cm-at-palette-label'
    label.textContent = item.label
    row.appendChild(label)

    const hint = document.createElement('span')
    hint.className = 'cm-at-palette-hint'
    hint.textContent = item.hint
    row.appendChild(hint)

    row.addEventListener('mousedown', (e) => {
      // Prevent the editor from blurring on click.
      e.preventDefault()
      e.stopPropagation()
    })
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      activeIndex = i
      applySelection(view, item.key, activeConfig)
    })
    list.appendChild(row)
  })
}

/**
 * Insert the template for the chosen item at the trigger position,
 * removing the `@`, optionally prepending `\n` if the line was non-empty.
 */
async function applySelection(view: EditorView, key: ItemKey, config?: AtTriggerMenuConfig) {
  if (!activeState) return
  const { triggerAfter } = activeState
  const triggerAtPos = triggerAfter - 1 // position of `@` itself
  const doc = view.state.doc
  if (triggerAtPos < 0 || triggerAtPos >= doc.length) {
    closePalette()
    return
  }
  if (doc.sliceString(triggerAtPos, triggerAtPos + 1) !== '@') {
    // Doc shifted (paste, undo, etc.) — abort cleanly.
    closePalette()
    return
  }

  const line = doc.lineAt(triggerAtPos)
  const before = doc.sliceString(line.from, triggerAtPos)
  const after = doc.sliceString(triggerAtPos + 1, line.to)
  const lineEmptyAround = before.trim() === '' && after.trim() === ''

  // For Link — file picker before deciding the template.
  let linkPath = ''
  if (key === 'link') {
    const picked = config?.pickFileForLink ? await config.pickFileForLink() : null
    linkPath = (picked && picked.trim()) ? picked.trim() : ''
    // If still no path, fall through to empty template `<!-- @link: / -->`.
  }

  // Build (insert, cursorOffsetWithinInsert) for each kind.
  const build = (k: ItemKey): { text: string; caret: number } => {
    switch (k) {
      case 'ai': {
        // Multi-line:
        //   <!-- @ai:
        //   |
        //   -->
        const t = '<!-- @ai:\n\n-->'
        return { text: t, caret: '<!-- @ai:\n'.length }
      }
      case 'include': {
        const t = '<!-- @include: ./ -->'
        return { text: t, caret: t.length - ' -->'.length }
      }
      case 'embedding': {
        const t = '<!-- @embedding: / -->'
        return { text: t, caret: t.length - ' -->'.length }
      }
      case 'link': {
        if (linkPath) {
          const t = `<!-- @link: ${linkPath} -->`
          return { text: t, caret: t.length }
        }
        const t = '<!-- @link: / -->'
        return { text: t, caret: t.length - ' -->'.length }
      }
    }
  }

  const { text, caret } = build(key)

  // Compute replacement range and prefix:
  // We always remove `@` and, if the line had other content, also insert `\n`.
  // - lineEmptyAround:   replace just the `@`               → text
  // - not empty:         replace `@`, move to end of line, then `\n` + text.
  //                      We do this by:
  //                        - replacing `@` (1 char) with ''
  //                        - then inserting '\n' + text at the end-of-line position
  //                      The simplest single transaction: replace the range
  //                      [triggerAtPos, triggerAtPos+1] with '' and at line.to
  //                      (which doesn't shift because removal is before it) insert prefix+text.

  const changes: { from: number; to: number; insert: string }[] = []
  let cursorPos: number

  if (lineEmptyAround) {
    // Replace `@` and any trailing whitespace from the line with the template
    // (so `   @` becomes `   <!-- ... -->` on the same line keeping leading ws).
    changes.push({ from: triggerAtPos, to: line.to, insert: text })
    cursorPos = triggerAtPos + caret
  } else {
    // Remove `@`, then append `\n` + template at end of line.
    changes.push({ from: triggerAtPos, to: triggerAtPos + 1, insert: '' })
    // After removal: characters from triggerAtPos+1 .. line.to shift left by 1.
    // New end-of-line position = line.to - 1.
    const newEol = line.to - 1
    changes.push({ from: line.to, to: line.to, insert: '\n' + text })
    cursorPos = newEol + 1 /* \n */ + caret
  }

  closePalette()
  view.dispatch({
    changes,
    selection: { anchor: cursorPos },
    scrollIntoView: true,
  })
  view.focus()
  console.log('[AtMenu] insert', { key, lineEmpty: lineEmptyAround, cursorPos, linkPath })
}

function openPalette(view: EditorView, triggerAfter: number, config?: AtTriggerMenuConfig) {
  closePalette()
  const line = view.state.doc.lineAt(triggerAfter)
  if (isInsideFencedOrBacktick(view, triggerAfter - 1)) return

  const coords = view.coordsAtPos(triggerAfter)
  if (!coords) return

  const palette = document.createElement('div')
  palette.className = 'cm-at-palette'
  palette.setAttribute('data-at-palette', 'true')
  palette.style.left = `${coords.left}px`
  palette.style.top = `${coords.bottom + 4}px`

  const items = document.createElement('div')
  items.className = 'cm-at-palette-items'
  palette.appendChild(items)

  document.body.appendChild(palette)
  activePalette = palette
  activeState = { triggerAfter, triggerLine: line.number }
  activeConfig = config
  activeIndex = 0
  renderPalette(view)

  // Clamp to viewport.
  requestAnimationFrame(() => {
    const rect = palette.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      palette.style.left = `${window.innerWidth - rect.width - 10}px`
    }
    if (rect.bottom > window.innerHeight) {
      palette.style.top = `${coords.top - rect.height - 4}px`
    }
  })

  const keydown = (e: KeyboardEvent) => {
    if (!activePalette) return
    if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      activeIndex = (activeIndex + 1) % ITEMS.length
      renderPalette(view)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      activeIndex = (activeIndex - 1 + ITEMS.length) % ITEMS.length
      renderPalette(view)
    } else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      const item = ITEMS[activeIndex]
      applySelection(view, item.key, activeConfig)
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      closePalette()
      view.focus()
    }
  }

  const mousedown = (e: MouseEvent) => {
    if (!palette.contains(e.target as Node)) closePalette()
  }

  document.addEventListener('keydown', keydown, true)
  document.addEventListener('mousedown', mousedown, true)
  cleanupFns.push(() => document.removeEventListener('keydown', keydown, true))
  cleanupFns.push(() => document.removeEventListener('mousedown', mousedown, true))

  console.log('[AtMenu] open at pos', triggerAfter, 'line', line.number)
}

export function createAtTriggerMenuPlugin(config: AtTriggerMenuConfig = {}) {
  return ViewPlugin.fromClass(
    class {
      constructor(_view: EditorView) {}

      update(update: { docChanged: boolean; selectionSet: boolean; transactions: readonly any[]; view: EditorView; state: any }) {
        // Close if cursor leaves the triggering line.
        if (activeState && update.selectionSet) {
          const sel = update.state.selection.main
          const line = update.state.doc.lineAt(sel.head).number
          if (line !== activeState.triggerLine) {
            closePalette()
            return
          }
        }

        // If the trigger `@` was deleted, close.
        if (activeState && update.docChanged) {
          const pos = activeState.triggerAfter - 1
          if (pos < 0 || pos >= update.state.doc.length) {
            closePalette()
            return
          }
          if (update.state.doc.sliceString(pos, pos + 1) !== '@') {
            closePalette()
            return
          }
        }

        // Detect a fresh `@` insertion in any transaction.
        for (const tr of update.transactions) {
          if (!tr.docChanged) continue
          // Only react to user input — ignore programmatic changes from undo/paste/etc.
          // History/paste transactions usually carry annotations; cheapest filter:
          // require the change to be exactly the single-char '@' insert.
          let triggerPos: number | null = null
          tr.changes.iterChanges((fromA: number, toA: number, _fromB: number, _toB: number, inserted: any) => {
            if (triggerPos !== null) return
            const str = inserted.toString()
            if (str === '@' && fromA === toA) {
              triggerPos = fromA + 1 // position right after the inserted `@`
            }
          })
          if (triggerPos !== null) {
            // Schedule open on next frame so the editor's own selection update settles.
            const view = update.view
            const pos = triggerPos
            requestAnimationFrame(() => {
              // Confirm `@` is still there and cursor is right after it.
              if (pos - 1 < 0 || pos - 1 >= view.state.doc.length) return
              if (view.state.doc.sliceString(pos - 1, pos) !== '@') return
              const sel = view.state.selection.main
              if (!sel.empty || sel.head !== pos) return
              openPalette(view, pos, config)
            })
          }
        }
      }

      destroy() {
        closePalette()
      }
    }
  )
}

// Exposed for debugging from devtools.
export { closePalette as _closeAtPalette }
