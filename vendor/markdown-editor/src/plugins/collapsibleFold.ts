import { foldService } from '@codemirror/language'

// Count visual indent (tabs = 4 spaces)
function countIndent(text: string, tabSize = 4): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 9) n += tabSize - (n % tabSize) // Tab
    else if (code === 32) n++ // Space
    else break // Text started
  }
  return n
}

// Fold Service for collapsible sections (indentation-based)
// Trigger: >> (expanded) or ^^ (collapsed) at line start
// Boundary: first line with lesser or equal indent (ignoring trailing empty lines)
export const collapsibleFoldService = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart)
  const lineText = line.text
  const trimmed = lineText.trim()

  // Check if line is a header (starts with >> or ^^)
  if (!trimmed.startsWith('>>') && !trimmed.startsWith('^^')) return null

  // Base indent of header
  const baseIndent = countIndent(lineText)

  // Find end of block
  let lastContentLine: number | null = null // Last line with actual indented content
  let pendingEmptyLines = 0 // Count of empty lines after last content

  for (let i = line.number + 1; i <= state.doc.lines; i++) {
    const nextLine = state.doc.line(i)
    const nextText = nextLine.text

    // Empty lines - count them but don't commit yet
    if (nextText.trim() === '') {
      if (lastContentLine !== null) {
        pendingEmptyLines++
      }
      continue
    }

    const nextIndent = countIndent(nextText)

    // Блок продолжается, если:
    // 1. Строка не пустая и её отступ БОЛЬШЕ базового
    // 2. ИЛИ это пустая строка, НО за ней следует строка с отступом (обрабатывается циклом дальше)
    if (nextText.trim() !== '' && nextIndent > baseIndent) {
      lastContentLine = i
      pendingEmptyLines = 0
    } else if (nextText.trim() === '') {
      pendingEmptyLines++
    } else {
      // Нашли строку с таким же или меньшим отступом — всё, блок ГАРАНТИРОВАННО кончился
      break
    }
  }

  // Если нашли вложенные линии, возвращаем диапазон
  if (lastContentLine !== null) {
    const result = {
      from: line.to,
      to: state.doc.line(lastContentLine).to
    }
    // Diagnostic: log the computed fold span for a header. The "disappearing
    // line 21" bug = fold.to extends past the real last content line, swallowing
    // a trailing line that should stay visible/clickable. headerLine/lastContent
    // /pendingEmpty let us see if trailing empty lines were (in)correctly
    // included. trailingPendingEmpty>0 means there were empty lines after the
    // last content line that we (correctly) did NOT absorb — if a visible line
    // still vanished, the fold range or remount path is the culprit.
    console.log('[Fold:Service] computed range',
      { headerLine: line.number, headerText: trimmed.slice(0, 30),
        baseIndent, lastContentLine,
        trailingPendingEmpty: pendingEmptyLines,
        from: result.from, to: result.to,
        toLine: state.doc.lineAt(result.to).number,
        docLines: state.doc.lines })
    return result
  }

  // Пустая секция — нечего сворачивать
  return null
})
