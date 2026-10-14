import { EditorView, keymap } from '@codemirror/view'
import { Prec, EditorSelection } from '@codemirror/state'

// Same image syntax imageField owns: ![alt|width|+](path). Non-global here —
// we test individual matches per line and check which one ends at the cursor.
const imagePattern = /!\[([^\]|]*)?(?:\|(\d+))?(\|\+)?\]\(([^)]+)\)/g

/**
 * Option/Alt+Backspace treats an image token `![...](...)` as ATOMIC.
 *
 * Spec (user): with the cursor right after the closing `)` of an image, one
 * Alt+Backspace deletes the WHOLE token up to and including `!` — not word-by-
 * word like the default `deleteGroupBackward`. If there are trailing spaces
 * after the image, the first Alt+Backspace deletes those (default behaviour,
 * we fall through), landing the cursor on `)`; the next press then removes the
 * image as one unit.
 *
 * Implementation: intercept Alt+Backspace at Prec.high (above defaultKeymap's
 * `Alt-Backspace → deleteGroupBackward`). Only act when the cursor is empty and
 * sits exactly at an image match's end (i.e. just past `)`). Otherwise return
 * false so the default group-delete runs untouched — that path also handles the
 * trailing-spaces step naturally.
 */
export function createImageDeleteHandler() {
  return Prec.high(keymap.of([{
    // mac: Option+Backspace; other platforms: Mod+Backspace — mirror the
    // default binding so we intercept the same physical chord everywhere.
    key: 'Mod-Backspace',
    mac: 'Alt-Backspace',
    run: (view: EditorView) => {
      const sel = view.state.selection.main
      if (!sel.empty) return false

      const pos = sel.head
      const line = view.state.doc.lineAt(pos)
      // The char just before the cursor must be `)` — cheap pre-check before
      // running the regex (also means trailing-spaces case falls through).
      if (pos === line.from || view.state.doc.sliceString(pos - 1, pos) !== ')') return false

      // Find an image match on this line whose end is exactly at the cursor.
      for (const match of line.text.matchAll(imagePattern)) {
        const matchStart = line.from + (match.index ?? 0)
        const matchEnd = matchStart + match[0].length
        if (matchEnd !== pos) continue

        view.dispatch({
          changes: { from: matchStart, to: matchEnd, insert: '' },
          selection: EditorSelection.cursor(matchStart),
          scrollIntoView: true,
          userEvent: 'delete.backward'
        })
        console.log('[Image:Delete] atomic token delete',
          { from: matchStart, to: matchEnd, len: match[0].length })
        return true
      }

      return false // cursor after a `)` that isn't an image close → default
    }
  }]))
}
