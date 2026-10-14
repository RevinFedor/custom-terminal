import { EditorView } from '@codemirror/view'

// Wrap selected text when typing *, `, _ etc.
export function createWrapSelectionHandler() {
  const wrapPairs: Record<string, string> = {
    '*': '*',
    '_': '_',
    '`': '`',
    '"': '"',
    "'": "'",
    '(': ')',
    '[': ']',
    '{': '}',
    '~': '~',
    // Русская раскладка: ё находится на той же клавише что и `
    'ё': '`',
    'Ё': '`'
  }

  return EditorView.domEventHandlers({
    keydown: (event, view) => {
      const char = event.key
      const closingChar = wrapPairs[char]

      // If character not in list — skip
      if (!closingChar) return false

      const selection = view.state.selection.main
      // Only if there's a selection
      if (selection.empty) return false

      // Prevent default behavior
      event.preventDefault()

      const selectedText = view.state.sliceDoc(selection.from, selection.to)

      // Для русской ё используем ` как оборачивающий символ
      const openChar = (char === 'ё' || char === 'Ё') ? '`' : char

      // Wrap text
      view.dispatch({
        changes: {
          from: selection.from,
          to: selection.to,
          insert: openChar + selectedText + closingChar
        },
        // Select text inside wrapper (without wrapper characters)
        selection: {
          anchor: selection.from + 1,
          head: selection.from + 1 + selectedText.length
        }
      })

      return true
    }
  })
}
