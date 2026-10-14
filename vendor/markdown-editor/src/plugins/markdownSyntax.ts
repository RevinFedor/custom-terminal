import { ViewPlugin, ViewUpdate, Decoration, DecorationSet, EditorView } from '@codemirror/view'
import { EditorSelection, type Text } from '@codemirror/state'
import { createRangeContains } from './rangeContainment'
import {
  HiddenWidget,
  BulletWidget,
  CollapsibleHeaderWidget
} from '../widgets'

const inlinePatterns = [
  // Bold: только ** (не __)
  { regex: /\*\*(.+?)\*\*/g, class: 'cm-md-bold', startLen: 2, endLen: 2 },
  // Italic: только * (не _)
  { regex: /(?<!\*)\*(.+?)\*(?!\*)/g, class: 'cm-md-italic', startLen: 1, endLen: 1 },
  { regex: /~~(.+?)~~/g, class: 'cm-md-strike', startLen: 2, endLen: 2 },
  { regex: /`([^`]*)`/g, class: 'cm-md-code', startLen: 1, endLen: 1 },
]

const headingPattern = /^(\s*)(#{1,6})\s*(.+)$/
const headingTagPattern = /\[(\w+)\]\s*$/

// Heading tag → CSS class mapping (case-insensitive)
const HEADING_TAG_MAP: Record<string, string> = {
  logs: 'cm-heading-tag-logs',
  log: 'cm-heading-tag-logs',
  data: 'cm-heading-tag-logs',
  links: 'cm-heading-tag-links',
  link: 'cm-heading-tag-links',
  sources: 'cm-heading-tag-links',
  source: 'cm-heading-tag-links',
  deprecated: 'cm-heading-tag-deprecated',
  old: 'cm-heading-tag-deprecated',
  obsolete: 'cm-heading-tag-deprecated',
  status: 'cm-heading-tag-status',
  todo: 'cm-heading-tag-status',
  tasks: 'cm-heading-tag-status',
}
const horizontalRulePattern = /^(?:-{3,}|\/{3,}|\\{3,})$/
const horizontalRuleWithIndentPattern = /^(\s*)((?:-{3,}|\/{3,}|\\{3,}))$/
const unorderedListPattern = /^(\s*)([*+-])\s+/ 
const orderedListPattern = /^(\s*)(\d+\.)\s+/ 
// >> = expanded, ^^ = collapsed
const collapsiblePattern = /^(\s*)(>>|\^\^)\s*(.*)$/
const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g
const fenceLinePattern = /^([ \t]*)(`{3,}|~{3,})(.*)$/
const maxCodeBlockIndentColumn = 24

export interface MarkdownSyntaxConfig {
  resolveImageUrl?: (src: string) => string
}

function getIndent(text: string): number {
  const match = text.match(/^(\s*)/)
  const indentText = match ? match[0] : ''
  return Math.floor(indentText.replace(/\t/g, '    ').length / 4)
}

// Column-exact indent for fence pairing: tabs expand to the NEXT tab stop.
// 2 tabs == 8 spaces, but "tab after 1 space" == column 4, not 5. The simpler
// getIndent floor division is too coarse for "closing fence must stand on the
// same visual column" rule.
function indentColumn(indentText: string, tabSize: number): number {
  let col = 0
  for (const ch of indentText) col += ch === '\t' ? tabSize - (col % tabSize) : 1
  return col
}

interface FenceMarker {
  lineNum: number
  from: number
  markerFrom: number
  markerTo: number
  indentColumn: number
  markerChar: string
  markerLen: number
  rest: string
  canOpen: boolean
  canClose: boolean
}

interface CodeBlockLineInfo {
  baseColumn: number
  role: 'start' | 'middle' | 'end'
}

function parseFenceMarker(lineNum: number, lineFrom: number, text: string, tabSize: number): FenceMarker | null {
  const match = text.match(fenceLinePattern)
  if (!match) return null

  const indentText = match[1]
  const marker = match[2]
  const rest = match[3] || ''
  const info = rest.trim()

  return {
    lineNum,
    from: lineFrom,
    markerFrom: lineFrom + indentText.length,
    markerTo: lineFrom + indentText.length + marker.length,
    indentColumn: indentColumn(indentText, tabSize),
    markerChar: marker[0],
    markerLen: marker.length,
    rest,
    // Opening may have a simple language tag (` ```text`, ` ```objective-c`).
    // Anything more complex is treated as an invalid fence marker and rendered
    // as unclosed, not as a working block.
    canOpen: info === '' || /^[A-Za-z0-9_-]+$/.test(info),
    // Closing must be a bare fence at the same visual indent as the opener.
    canClose: info === '',
  }
}

function lineIndentColumn(text: string, tabSize: number): number {
  const match = text.match(/^([ \t]*)/)
  return indentColumn(match ? match[1] : '', tabSize)
}

function buildCodeBlockDecorInfo(doc: Text, tabSize: number): {
  codeLines: Map<number, CodeBlockLineInfo>
  unclosedFences: Map<number, { from: number; to: number }>
} {
  const codeLines = new Map<number, CodeBlockLineInfo>()
  const unclosedFences = new Map<number, { from: number; to: number }>()
  let pending: FenceMarker | null = null

  const markUnclosed = (marker: FenceMarker) => {
    unclosedFences.set(marker.lineNum, { from: marker.markerFrom, to: marker.markerTo })
  }

  const addMatchedBlock = (open: FenceMarker, close: FenceMarker) => {
    for (let lineNum = open.lineNum; lineNum <= close.lineNum; lineNum++) {
      const line = doc.line(lineNum)
      const isStart = lineNum === open.lineNum
      const isEnd = lineNum === close.lineNum
      const text = line.text
      const isBlank = text.trim() === ''
      const isInsideHorizontally = isStart || isEnd || isBlank || lineIndentColumn(text, tabSize) >= open.indentColumn

      if (!isInsideHorizontally) continue
      codeLines.set(lineNum, {
        baseColumn: open.indentColumn,
        role: isStart ? 'start' : isEnd ? 'end' : 'middle',
      })
    }
  }

  for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
    const line = doc.line(lineNum)
    const marker = parseFenceMarker(lineNum, line.from, line.text, tabSize)
    if (!marker) continue

    if (!pending) {
      if (marker.canOpen) pending = marker
      else markUnclosed(marker)
      continue
    }

    const closesPending =
      marker.canClose &&
      marker.markerChar === pending.markerChar &&
      marker.markerLen === pending.markerLen &&
      marker.indentColumn === pending.indentColumn

    if (closesPending) {
      addMatchedBlock(pending, marker)
      pending = null
      continue
    }

    // A second fence marker at a different visual column/type doesn't silently
    // close the first block. Per GT rules both markers are unclosed and only
    // the marker glyphs get the red warning background.
    markUnclosed(pending)
    if (marker.canOpen) pending = marker
    else {
      markUnclosed(marker)
      pending = null
    }
  }

  if (pending) markUnclosed(pending)

  return { codeLines, unclosedFences }
}

export function createMarkdownSyntaxPlugin(config: MarkdownSyntaxConfig = {}) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      needsRetry = false

      constructor(view: EditorView) {
        try {
          this.decorations = this.rebuild(view, 'mount')
        } catch (e) {
          this.needsRetry = true
          console.error('[MarkdownSyntax] constructor failed:', e instanceof Error ? e.message : e, {
            docLength: view.state.doc.length, docLines: view.state.doc.lines
          })
          this.decorations = Decoration.none
        }
      }

      update(update: ViewUpdate) {
        // This builder covers the whole document, not visibleRanges. Scrolling
        // can reuse its ranges; CM still virtualizes and measures their DOM.
        // Keep the old viewport retry after a failed build and invalidate the
        // fence columns when tabSize is reconfigured without a text change.
        if (update.docChanged || update.selectionSet || update.focusChanged ||
            update.startState.tabSize !== update.state.tabSize ||
            (update.viewportChanged && this.needsRetry)) {
          try {
            this.decorations = this.rebuild(update.view, update.docChanged ? 'document'
              : update.startState.tabSize !== update.state.tabSize ? 'tab-size'
              : update.selectionSet ? 'selection' : update.focusChanged ? 'focus' : 'retry')
            this.needsRetry = false
          } catch (e) {
            this.needsRetry = true
            console.error('[MarkdownSyntax] buildDecorations failed:', e instanceof Error ? e.message : e, {
              docChanged: update.docChanged, docLength: update.state.doc.length, docLines: update.state.doc.lines
            })
            if (update.docChanged) {
              // CRITICAL: old decorations reference old doc positions — must remap or clear
              try {
                this.decorations = this.decorations.map(update.changes)
              } catch {
                this.decorations = Decoration.none
              }
            }
            // else: doc unchanged, old positions are still valid — keep previous decorations
          }
        }
      }

      rebuild(view: EditorView, reason: string): DecorationSet {
        const start = performance.now()
        let result: DecorationSet | undefined
        try {
          result = this.buildDecorations(view)
          return result
        } finally {
          const end = performance.now()
          // Same renderer log channel as the host's action/native diagnostics.
          // No document text or extra layout read; absolute intervals can be
          // correlated with IPC, React commits and Chromium lifecycle work.
          if (end - start >= 24 || !result) {
            console.log('[Perf:MarkdownSyntax]', {
              reason, startAbs: performance.timeOrigin + start,
              endAbs: performance.timeOrigin + end, buildMs: end - start,
              lines: view.state.doc.lines, length: view.state.doc.length,
              ranges: result?.size, outcome: result ? 'built' : 'error'
            })
          }
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const decorations: { from: number; to?: number; decoration: Decoration }[] = []
        const doc = view.state.doc
        // Column-aware fence pairing (одна карта на оба прохода: рендер + skip
        // в multiline-пассе). Заменяет наивный inCodeBlock-toggle, который
        // парил ``` без учёта отступа.
        const { codeLines, unclosedFences } = buildCodeBlockDecorInfo(doc, view.state.tabSize)
        // Track unclosed marker positions: position → marker length (decorations added after multiline pass)
        const unclosedPositions = new Map<number, number>()
        // All ranges matched by single-line inline patterns (protected from multiline stealing)
        const singleLineMatchedRanges: Array<{from: number, to: number}> = []
        
        // Предварительный расчет отступов для пустых строк
        const lineIndents = new Array(doc.lines + 1).fill(0)
        for (let i = 1; i <= doc.lines; i++) {
          const text = doc.line(i).text
          if (text.trim() !== '') {
            lineIndents[i] = getIndent(text)
          }
        }
        
        // Заполняем "дыры" (пустые строки) отступом предыдущей значимой строки
        let lastKnownIndent = 0
        // Track whether the last non-empty line was a collapsible header (>>/^^).
        // A header sits at its literal indent (often 0) but OWNS the level of its
        // body (header indent + 1). An empty line directly under a header must
        // inherit the BODY's level so the vertical guide stays continuous —
        // otherwise min(headerIndent=0, bodyIndent) collapses to 0 and the guide
        // disappears on the blank line (reported bug: line 23 between `>> смчсм`
        // and `    мсч` had no guide).
        let lastWasCollapsibleHeader = false
        // Diagnostic: kept as a regression detector. After the header-aware fix
        // this should fire only on genuine block boundaries, never on a blank
        // line that visually lives inside a section.
        const emptyLineDiag: Array<{ ln: number; prev: number; next: number; prevHeader: boolean; computed: number }> = []
        for (let i = 1; i <= doc.lines; i++) {
          const text = doc.line(i).text
          if (text.trim() === '') {
            // Ищем следующий ненулевой отступ, чтобы понять, находимся ли мы внутри блока
            let nextIndent = 0
            for(let j = i + 1; j <= Math.min(i + 5, doc.lines); j++) {
                if (doc.line(j).text.trim() !== '') {
                    nextIndent = lineIndents[j]
                    break
                }
            }
            // When prev is a header, take the following content's level directly
            // (the body's level). Otherwise keep the conservative min() so a
            // blank line between sibling blocks of different depth shows only the
            // guide that genuinely continues through it.
            lineIndents[i] = lastWasCollapsibleHeader
              ? nextIndent
              : Math.min(lastKnownIndent, nextIndent)
            // Log only the suspicious case: a neighbour is indented (blank line
            // plausibly inside a block) yet the guide still collapsed to nothing.
            if ((lastKnownIndent > 0 || nextIndent > 0) && lineIndents[i] === 0) {
              emptyLineDiag.push({ ln: i, prev: lastKnownIndent, next: nextIndent, prevHeader: lastWasCollapsibleHeader, computed: lineIndents[i] })
            }
          } else {
            lastKnownIndent = lineIndents[i]
            lastWasCollapsibleHeader = collapsiblePattern.test(text)
          }
        }
        if (emptyLineDiag.length > 0) {
          console.log('[IndentGuide:EmptyLine] guide dropped on empty lines',
            JSON.stringify(emptyLineDiag))
        }

        // Get active lines only if editor has focus (preview mode when blurred)
        const activeLines = new Set<number>()
        if (view.hasFocus) {
          for (const range of view.state.selection.ranges) {
            const startLine = doc.lineAt(range.from).number
            const endLine = doc.lineAt(range.to).number
            for (let i = startLine; i <= endLine; i++) {
              activeLines.add(i)
            }
          }
        }

        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i)
          const lineText = line.text
          const isActiveLine = activeLines.has(i)
          const indentLevel = lineIndents[i]
          const clampedIndent = Math.min(indentLevel, 6)
          const indentClass = clampedIndent > 0 ? ` cm-indent-L${clampedIndent}` : ''

          const trimmedText = lineText.trim()

          // Fenced code blocks. Valid block = opener/closer fence with the same
          // marker type/length and the same visual indent column. The gray block
          // starts at the opener's column; lines outdented to the left of that
          // column are deliberately excluded (they are visually outside).
          const codeInfo = codeLines.get(i)
          if (codeInfo) {
            // Гайды для строк блока — от уровня FENCE, не от собственного отступа
            // строки: иначе глубокая индентация кода рисует indent-гайды внутри
            // серого. cm-cb-s{col} задаёт --cb-start (колонку старта серого).
            const fenceLevel = Math.min(Math.floor(codeInfo.baseColumn / 4), 6)
            const fenceIndentClass = fenceLevel > 0 ? ` cm-indent-L${fenceLevel}` : ''
            const startColClass = ` cm-cb-s${Math.min(codeInfo.baseColumn, maxCodeBlockIndentColumn)}`
            const roleClass = codeInfo.role === 'start'
              ? ' cm-code-block-start'
              : codeInfo.role === 'end'
                ? ' cm-code-block-end'
                : ''
            decorations.push({
              from: line.from,
              decoration: Decoration.line({
                class: `cm-code-block-line${startColClass}${roleClass}${fenceIndentClass}`
              })
            })
            continue
          }

          const unclosedFence = unclosedFences.get(i)
          if (unclosedFence) {
            if (indentClass) {
              decorations.push({ from: line.from, decoration: Decoration.line({ class: indentClass.trim() }) })
            }
            decorations.push({
              from: unclosedFence.from,
              to: unclosedFence.to,
              decoration: Decoration.mark({ class: 'cm-md-unclosed' })
            })
            continue
          }

          // Headings (with optional indent)
          const headingMatch = lineText.match(headingPattern)
          if (headingMatch) {
            const indentLen = headingMatch[1].length
            const level = headingMatch[2].length
            const hashStart = indentLen
            const hashLen = level + (lineText.charAt(hashStart + level) === ' ' ? 1 : 0)
            // Check for [tag] at end of heading text
            const headingText = headingMatch[3]
            const tagMatch = headingText.match(headingTagPattern)
            const tagClass = tagMatch ? HEADING_TAG_MAP[tagMatch[1].toLowerCase()] || '' : ''
            decorations.push({ from: line.from, decoration: Decoration.line({ class: `cm-md-heading cm-md-h${level}${indentClass}${tagClass ? ' ' + tagClass : ''}` }) })
            if (!isActiveLine && hashLen > 0) {
              // Hide only the hashes (and space), keep indent visible
              decorations.push({ from: line.from + hashStart, to: line.from + hashStart + hashLen, decoration: Decoration.replace({ widget: new HiddenWidget() }) })
              // Font-size mark starts AFTER hidden range to avoid overlap conflict
              if (level <= 6 && line.from + hashStart + hashLen < line.to) {
                decorations.push({ from: line.from + hashStart + hashLen, to: line.to, decoration: Decoration.mark({ class: `cm-heading-size-${level}` }) })
              }
            } else if (level <= 6) {
              // Active line: # visible, mark covers everything from # to end
              decorations.push({ from: line.from + hashStart, to: line.to, decoration: Decoration.mark({ class: `cm-heading-size-${level}` }) })
            }
            continue
          }

          // Horizontal rule (с учётом отступа)
          const hrMatch = lineText.match(horizontalRuleWithIndentPattern)
          if (hrMatch) {
            const hrIndentLen = hrMatch[1].length  // Длина отступа
            const hrLen = hrMatch[2].length        // Длина маркера HR

            decorations.push({ from: line.from, decoration: Decoration.line({ class: 'cm-hr-line' + indentClass }) })
            if (!isActiveLine) {
              // ВАЖНО: скрываем ТОЛЬКО маркер HR, оставляя отступ видимым в DOM
              const hrStart = line.from + hrIndentLen
              const hrEnd = hrStart + hrLen
              decorations.push({ from: hrStart, to: hrEnd, decoration: Decoration.mark({ class: 'cm-hr-text-hidden' }) })
            }
            continue
          }

          // Lists
          const ulMatch = lineText.match(unorderedListPattern)
          const olMatch = lineText.match(orderedListPattern)
          const collapsibleMatch = lineText.match(collapsiblePattern)

          if (ulMatch) {
            const [fullMatch, indentStr] = ulMatch
            const markerStart = line.from + indentStr.length
            const markerEnd = line.from + indentStr.length + (fullMatch.length - indentStr.length)
            decorations.push({ from: line.from, decoration: Decoration.line({ class: 'cm-list-line' + indentClass }) })
            if (!isActiveLine) {
              // Replace ONLY the `- ` marker, NOT the indent — the indent stays as
              // real text before the widget (matches the collapsible `>>` arrow and
              // keeps line backgrounds from bleeding into the indent). See
              // fix-codemirror-inline-widgets.md and lineBackground.ts.
              decorations.push({ from: markerStart, to: markerEnd, decoration: Decoration.replace({ widget: new BulletWidget(indentStr, false, view, markerStart, markerEnd) }) })
            }
          } else if (olMatch) {
            decorations.push({ from: line.from, decoration: Decoration.line({ class: 'cm-list-line' + indentClass }) })
          } else if (collapsibleMatch) {
            // collapsibleMatch: [1]=indent, [2]=marker (>> or ^^), [3]=content
            const markerPos = collapsibleMatch[1].length // position after indent
            const markerLen = 2 // >> or ^^
            const contentStart = markerPos + markerLen + (lineText.charAt(markerPos + markerLen) === ' ' ? 1 : 0)
            const collapsibleContent = collapsibleMatch[3] || ''

            // Проверяем есть ли заголовок внутри collapsible (>> # Header)
            const innerHeadingMatch = collapsibleContent.match(/^(#{1,6})\s*(.+)$/)
            if (innerHeadingMatch) {
              const level = innerHeadingMatch[1].length
              const innerTagMatch = innerHeadingMatch[2].match(headingTagPattern)
              const innerTagClass = innerTagMatch ? HEADING_TAG_MAP[innerTagMatch[1].toLowerCase()] || '' : ''
              decorations.push({ from: line.from, decoration: Decoration.line({ class: `cm-collapsible-header cm-md-heading cm-md-h${level}${indentClass}${innerTagClass ? ' ' + innerTagClass : ''}` }) })
              // Скрываем хэши заголовка если строка не активна
              if (!isActiveLine) {
                const hashLen = level + (collapsibleContent.charAt(level) === ' ' ? 1 : 0)
                decorations.push({ from: line.from + contentStart, to: line.from + contentStart + hashLen, decoration: Decoration.replace({ widget: new HiddenWidget() }) })
                // Font-size mark starts AFTER hidden range to avoid overlap conflict
                if (level <= 6 && line.from + contentStart + hashLen < line.to) {
                  decorations.push({ from: line.from + contentStart + hashLen, to: line.to, decoration: Decoration.mark({ class: `cm-heading-size-${level}` }) })
                }
              } else if (level <= 6) {
                // Active line: # visible, mark covers everything from # to end
                decorations.push({ from: line.from + contentStart, to: line.to, decoration: Decoration.mark({ class: `cm-heading-size-${level}` }) })
              }
            } else {
              decorations.push({ from: line.from, decoration: Decoration.line({ class: 'cm-collapsible-header' + indentClass }) })
              // НЕ скрываем >> — это делает collapsibleArrowPlugin
            }
          } else {
            // Обычная строка или пустая строка
            const finalClass = (indentClass).trim()
            if (finalClass) {
              decorations.push({ from: line.from, decoration: Decoration.line({ class: finalClass }) })
            }
          }

          // Inline markup (только если не заголовок и не HR)
          if (!headingMatch && !horizontalRulePattern.test(trimmedText)) {
              // Для collapsible — ищем inline только в контенте после >> или ^^
              let searchText = lineText
              let searchOffset = 0
              if (collapsibleMatch) {
                const markerPos = collapsibleMatch[1].length
                const markerEnd = markerPos + 2 // >> or ^^
                const contentStart = lineText.charAt(markerEnd) === ' ' ? markerEnd + 1 : markerEnd
                searchText = lineText.substring(contentStart)
                searchOffset = contentStart
              }

              // Собираем успешные диапазоны для проверки unclosed
              const matchedRanges: Array<{from: number, to: number}> = []

              for (const pattern of inlinePatterns) {
                const regex = new RegExp(pattern.regex.source, 'g')
                let match
                while ((match = regex.exec(searchText)) !== null) {
                  const startOffset = line.from + searchOffset + match.index
                  const endOffset = startOffset + match[0].length
                  // Skip if this match overlaps with an already-matched range
                  // (e.g. italic regex matching **bold** that was already handled by bold regex)
                  if (matchedRanges.some(r => startOffset < r.to && endOffset > r.from)) continue
                  const contentStart = startOffset + pattern.startLen
                  const contentEnd = endOffset - pattern.endLen
                  decorations.push({ from: contentStart, to: contentEnd, decoration: Decoration.mark({ class: pattern.class }) })
                  matchedRanges.push({ from: startOffset, to: endOffset })
                  singleLineMatchedRanges.push({ from: startOffset, to: endOffset })
                  if (!isActiveLine) {
                    decorations.push({ from: startOffset, to: contentStart, decoration: Decoration.replace({ widget: new HiddenWidget() }) })
                    decorations.push({ from: contentEnd, to: endOffset, decoration: Decoration.replace({ widget: new HiddenWidget() }) })
                  }
                }
              }

              // Links: [text](url)
              const linkRegex = new RegExp(linkPattern.source, 'g')
              let linkMatch
              while ((linkMatch = linkRegex.exec(searchText)) !== null) {
                // Skip `![...](...)` — that's an IMAGE, owned by imageField. If
                // markdownSyntax also decorated it (cm-md-link + HiddenWidget),
                // two Decoration.replace from different plugins would overlap on
                // the same span. The leading `!` is the standard markdown
                // image-vs-link discriminator. Read from lineText at the
                // absolute offset so it's correct even when index===0 within a
                // searchOffset-shifted searchText.
                if (lineText[searchOffset + linkMatch.index - 1] === '!') continue
                const fullMatch = linkMatch[0]        // [text](url)
                const linkText = linkMatch[1]         // text
                const startOffset = line.from + searchOffset + linkMatch.index
                const endOffset = startOffset + fullMatch.length
                const textStart = startOffset + 1     // after [
                const textEnd = textStart + linkText.length  // before ]

                // Style the link text
                decorations.push({ from: textStart, to: textEnd, decoration: Decoration.mark({ class: 'cm-md-link' }) })
                matchedRanges.push({ from: startOffset, to: endOffset })
                singleLineMatchedRanges.push({ from: startOffset, to: endOffset })

                if (!isActiveLine) {
                  // Hide [ before text
                  decorations.push({ from: startOffset, to: textStart, decoration: Decoration.replace({ widget: new HiddenWidget() }) })
                  // Hide ](url) after text
                  decorations.push({ from: textEnd, to: endOffset, decoration: Decoration.replace({ widget: new HiddenWidget() }) })
                }
              }

              // Ищем unclosed маркеры (сироты) — маркеры которые не вошли в успешные пары
              // _ исключён — не участвует в форматировании
              const unclosedMarkers = ['**', '~~', '*', '`']
              for (const marker of unclosedMarkers) {
                const markerRegex = new RegExp(marker.replace(/[*]/g, '\\*').replace(/[`]/g, '\\`'), 'g')
                let match
                while ((match = markerRegex.exec(searchText)) !== null) {
                  const absPos = line.from + searchOffset + match.index
                  // Проверяем не входит ли в успешный диапазон
                  const isMatched = matchedRanges.some(r => absPos >= r.from && absPos < r.to)
                  if (!isMatched) {
                    // Для одиночных * и _ — проверяем что не часть ** или __
                    if (marker.length === 1) {
                      const nextChar = searchText[match.index + 1]
                      const prevChar = match.index > 0 ? searchText[match.index - 1] : ''
                      if (nextChar === marker || prevChar === marker) continue
                    }
                    // Проверяем "прилипание" — должен быть рядом с текстом
                    const afterChar = searchText[match.index + marker.length]
                    const beforeChar = match.index > 0 ? searchText[match.index - 1] : ' '
                    const isOpening = afterChar && afterChar !== ' ' && afterChar !== '\t'
                    const isClosing = beforeChar !== ' ' && beforeChar !== '\t'
                    if (isOpening || isClosing) {
                      unclosedPositions.set(absPos, marker.length)
                    }
                  }
                }
              }
          }
        }

        // ========== MULTILINE FORMATTING ==========
        // Ищем форматирование через несколько строк (до 5)
        // _ исключён — не участвует в форматировании
        const multilineMarkers = [
          { marker: '**', class: 'cm-md-bold' },
          { marker: '~~', class: 'cm-md-strike' },
          { marker: '*', class: 'cm-md-italic' },
          { marker: '`', class: 'cm-md-code' },
        ]

        const maxMultilineLines = 5
        const singleLineContains = createRangeContains(singleLineMatchedRanges)
        const addedRanges: Array<{from: number, to: number}> = []
        // Only the main forward scan may use this frontier: each new span
        // starts at its current position. Lookahead and orphan queries are not
        // monotonic, so they use the immutable point-membership indexes.
        let addedThrough = -1
        const markUsed = (from: number, to: number) => {
          addedRanges.push({ from, to })
          addedThrough = Math.max(addedThrough, to)
        }

        for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
          const line = doc.line(lineNum)
          const text = line.text

          // Пропускаем code blocks, пустые, headings, HR
          if (codeLines.has(lineNum) || unclosedFences.has(lineNum)) continue
          if (text.trim() === '') continue
          if (headingPattern.test(text)) continue
          if (horizontalRulePattern.test(text.trim())) continue

          for (let charIdx = 0; charIdx < text.length; charIdx++) {
            const char = text.charCodeAt(charIdx)
            if (char !== 42 && char !== 96 && char !== 126) continue // *, `, ~
            const absolutePos = line.from + charIdx

            // Пропускаем уже обработанные диапазоны
            if (absolutePos < addedThrough || singleLineContains(absolutePos)) continue

            for (const pattern of multilineMarkers) {
              const marker = pattern.marker

              // Проверяем что маркер начинается здесь
              if (text.substr(charIdx, marker.length) !== marker) continue

              // Для одиночных маркеров - не часть двойного
              if (marker.length === 1) {
                if (charIdx + 1 < text.length && text[charIdx + 1] === marker) continue
                if (charIdx > 0 && text[charIdx - 1] === marker) continue
              }

              // Проверяем "прилипание" - после маркера не пробел
              const afterIdx = charIdx + marker.length
              if (afterIdx >= text.length) continue
              const afterChar = text[afterIdx]
              if (afterChar === ' ' || afterChar === '\t' || afterChar === '\n') continue

              // Ищем закрывающий маркер - сначала на той же строке
              let closingOnSameLine = false
              for (let searchIdx = afterIdx; searchIdx <= text.length - marker.length; searchIdx++) {
                if (text.substr(searchIdx, marker.length) !== marker) continue

                // Для одиночных - не часть двойного
                if (marker.length === 1) {
                  if (searchIdx + 1 < text.length && text[searchIdx + 1] === marker) continue
                  if (searchIdx > 0 && text[searchIdx - 1] === marker) continue
                }

                // Прилипание - перед маркером не пробел
                if (searchIdx > 0 && (text[searchIdx - 1] === ' ' || text[searchIdx - 1] === '\t')) continue

                // Don't steal closers from complete single-line pairs
                const closeAbsPos = line.from + searchIdx
                if (singleLineContains(closeAbsPos)) continue

                closingOnSameLine = true
                // Однострочное - уже обработано inlinePatterns
                markUsed(absolutePos, line.from + searchIdx + marker.length)
                break
              }

              if (closingOnSameLine) break

              // Ищем на следующих строках
              let closingInfo: { lineNum: number, charIdx: number, absolutePos: number } | null = null

              for (let searchLineNum = lineNum + 1; searchLineNum <= Math.min(lineNum + maxMultilineLines, doc.lines); searchLineNum++) {
                const searchLine = doc.line(searchLineNum)
                const searchText = searchLine.text

                // Пустая строка или code block - прекращаем
                if (searchText.trim() === '' || codeLines.has(searchLineNum) || unclosedFences.has(searchLineNum)) break

                for (let searchIdx = 0; searchIdx <= searchText.length - marker.length; searchIdx++) {
                  if (searchText.substr(searchIdx, marker.length) !== marker) continue

                  // Для одиночных - не часть двойного
                  if (marker.length === 1) {
                    if (searchIdx + 1 < searchText.length && searchText[searchIdx + 1] === marker) continue
                    if (searchIdx > 0 && searchText[searchIdx - 1] === marker) continue
                  }

                  // Closing marker must be right-flanking (preceded by non-space text)
                  // At position 0, nothing precedes — can't be a closer
                  if (searchIdx === 0 || searchText[searchIdx - 1] === ' ' || searchText[searchIdx - 1] === '\t') continue

                  // Don't steal closers from complete single-line pairs
                  const closeAbsPos = searchLine.from + searchIdx
                  if (singleLineContains(closeAbsPos)) continue

                  closingInfo = { lineNum: searchLineNum, charIdx: searchIdx, absolutePos: searchLine.from + searchIdx }
                  break
                }

                if (closingInfo) break
              }

              if (closingInfo) {
                // Multiline match!
                const openStart = absolutePos
                const openEnd = absolutePos + marker.length
                const closeStart = closingInfo.absolutePos
                const closeEnd = closingInfo.absolutePos + marker.length

                // Декорация контента
                decorations.push({
                  from: openEnd,
                  to: closeStart,
                  decoration: Decoration.mark({ class: pattern.class })
                })

                // Скрываем маркеры если строки не активны
                const openLineActive = activeLines.has(lineNum)
                const closeLineActive = activeLines.has(closingInfo.lineNum)

                if (!openLineActive) {
                  decorations.push({
                    from: openStart,
                    to: openEnd,
                    decoration: Decoration.replace({ widget: new HiddenWidget() })
                  })
                }

                if (!closeLineActive) {
                  decorations.push({
                    from: closeStart,
                    to: closeEnd,
                    decoration: Decoration.replace({ widget: new HiddenWidget() })
                  })
                }

                // Помечаем как использованное
                markUsed(openStart, closeEnd)
                break
              } else if (!closingOnSameLine) {
                // Record as unclosed (decoration added after multiline pass to avoid conflicts)
                // Don't mark as used: the final pass must still decorate this orphan.
                unclosedPositions.set(absolutePos, marker.length)
                break
              }
            }
          }
        }

        // Add unclosed marker decorations AFTER multiline pass to avoid conflicts
        // Only mark positions that weren't matched by any pass (single-line or multiline)
        const addedContains = createRangeContains(addedRanges)
        for (const [pos, len] of unclosedPositions) {
          const isMatched = singleLineContains(pos) || addedContains(pos)
          if (!isMatched) {
            decorations.push({
              from: pos,
              to: pos + len,
              decoration: Decoration.mark({ class: 'cm-md-unclosed' })
            })
          }
        }

        // Фильтруем невалидные декорации (from >= to для mark decorations, out of bounds)
        const docLength = doc.length
        const validDecorations = decorations.filter((d) => {
          if (d.to !== undefined && d.from >= d.to) return false
          if (d.from < 0 || d.from > docLength) return false
          if (d.to !== undefined && (d.to < 0 || d.to > docLength)) return false
          return true
        })

        // Build ranges for Decoration.set()
        const ranges = validDecorations.map((d) => (d.to ? d.decoration.range(d.from, d.to) : d.decoration.range(d.from)))

        // --- Diagnostic: detect conflicts before Decoration.set() ---
        // Sort a copy to find overlapping replace decorations at the same position
        const sorted = ranges.slice().sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1]
          const curr = sorted[i]
          // Check: two replace decorations overlapping at the same from
          if (prev.from === curr.from && prev.to !== undefined && curr.to !== undefined) {
            const prevIsReplace = (prev.value as any).widget !== undefined && prev.from !== prev.to
            const currIsReplace = (curr.value as any).widget !== undefined && curr.from !== curr.to
            if (prevIsReplace && currIsReplace) {
              const lineInfo = doc.lineAt(curr.from)
              console.warn('[MarkdownSyntax] CONFLICT: overlapping replaces at same from', {
                pos: curr.from,
                line: lineInfo.number,
                lineText: lineInfo.text.substring(0, 80),
                prev: { from: prev.from, to: prev.to, startSide: prev.value.startSide },
                curr: { from: curr.from, to: curr.to, startSide: curr.value.startSide }
              })
            }
          }
          // Check: replace that fully contains another range
          if (prev.to !== undefined && curr.from < prev.to) {
            const prevIsReplace = (prev.value as any).widget !== undefined && prev.from !== prev.to
            const currIsReplace = (curr.value as any).widget !== undefined && curr.from !== curr.to
            if (prevIsReplace || currIsReplace) {
              const lineInfo = doc.lineAt(curr.from)
              console.warn('[MarkdownSyntax] CONFLICT: overlapping ranges (one is replace)', {
                pos: curr.from,
                line: lineInfo.number,
                lineText: lineInfo.text.substring(0, 80),
                prev: { from: prev.from, to: prev.to, isReplace: prevIsReplace },
                curr: { from: curr.from, to: curr.to, isReplace: currIsReplace }
              })
            }
          }
        }

        // Pass true to let CodeMirror sort decorations by from/startSide
        return Decoration.set(ranges, true)
      }
    },
    { decorations: (v) => v.decorations }
  )
}

/**
 * Fix cursor placement when clicking past the visual end of a line.
 *
 * Two problems solved:
 * 1. Hidden markup: `**текс**` concealed as `текс` — clicking past "с" should
 *    place cursor at line.to (after `**`), not at contentEnd (before `**`).
 * 2. Last character skip: clicking in empty space past `текст:` sometimes places
 *    cursor before `:` instead of after it.
 *
 * Approach: capture the visual x-coordinate of line.to BEFORE the line becomes
 * active (while markup is still hidden). After CM6 processes the click, if the
 * click was at/past that visual end and cursor isn't at line.to — snap it there.
 */
export function createConcealClickFix() {
  return EditorView.domEventHandlers({
    mousedown(event: MouseEvent, view: EditorView) {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false

      const clickX = event.clientX
      const clickY = event.clientY

      const clickPos = view.posAtCoords({ x: clickX, y: clickY })
      if (clickPos === null) return false

      const line = view.state.doc.lineAt(clickPos)

      // coordsAtPos(line.to) returns NULL when line.to is at the edge of a
      // zero-width Decoration.replace (hidden **,~~,` etc). Walk backwards
      // to find the nearest position with valid visual coordinates.
      let endCoords: {left: number, top: number, bottom: number} | null = null
      for (let p = line.to; p >= Math.max(line.from, line.to - 8); p--) {
        endCoords = view.coordsAtPos(p) || view.coordsAtPos(p, -1)
        if (endCoords) break
      }
      if (!endCoords) return false

      // Diagnostic snapshot at mousedown — capture wrap geometry BEFORE the
      // line activates. lineStartCoords vs endCoords tops tell us if the line
      // wraps; clickY vs endCoords.top/bottom tells us whether click was on
      // the same visual row as endCoords.
      const preStartCoords = view.coordsAtPos(line.from) || view.coordsAtPos(line.from, 1)
      const preClickPosCoords = view.coordsAtPos(clickPos) || view.coordsAtPos(clickPos, -1)
      const preLineWraps = preStartCoords && endCoords ? Math.abs(preStartCoords.top - endCoords.top) > 4 : false
      const preClickRowMatchesEnd = preClickPosCoords && endCoords
        ? (clickY >= endCoords.top - 2 && clickY <= endCoords.bottom + 2)
        : null

      setTimeout(() => {
        const sel = view.state.selection.main
        if (!sel.empty) return

        const pos = sel.head
        const currentLine = view.state.doc.lineAt(pos)
        if (pos === currentLine.to) return

        // Post-click geometry probe: where does the line actually sit NOW (after
        // CM6 activated it and recomputed conceal). Compare wrap rows for pos
        // (where CM6 put the cursor) and for line.to (visual end) to see if the
        // snap target is on a DIFFERENT visual row than the click.
        let postStartCoords: { left: number; top: number; bottom: number } | null = null
        let postEndCoords: { left: number; top: number; bottom: number } | null = null
        let postPosCoords: { left: number; top: number; bottom: number } | null = null
        try {
          postStartCoords = view.coordsAtPos(currentLine.from) || view.coordsAtPos(currentLine.from, 1)
          for (let p = currentLine.to; p >= Math.max(currentLine.from, currentLine.to - 8); p--) {
            postEndCoords = view.coordsAtPos(p) || view.coordsAtPos(p, -1)
            if (postEndCoords) break
          }
          postPosCoords = view.coordsAtPos(pos) || view.coordsAtPos(pos, -1)
        } catch {}
        const postLineWraps = postStartCoords && postEndCoords
          ? Math.abs(postStartCoords.top - postEndCoords.top) > 4 : false
        // null when we couldn't measure (fall back to allowing snap to preserve
        // the original short-line behavior); false only when we are SURE the
        // click landed on a different visual row than the line's end.
        const postClickAndEndSameRow = postEndCoords && postPosCoords
          ? Math.abs(postEndCoords.top - postPosCoords.top) <= 4 : null

        // X-only past-the-end check (original behavior).
        const pastVisualEnd = clickX >= endCoords!.left - 1
        // WRAP GUARD: on a wrapped line, coordsAtPos(line.to) returns the X of
        // the LAST visual row. If the user clicked on an EARLIER visual row,
        // clickX can exceed that X purely because the rows are unrelated — a
        // false "past the end". Only snap when the click row and the end row
        // are the same visual line (or we couldn't measure → don't block).
        // Deterministic signature from dev.log: shouldSnap fired with
        // postClickAndEndSameRow:false ONLY in the bug case; every correct
        // short-line snap had postClickAndEndSameRow:true.
        const shouldSnap = pastVisualEnd && postClickAndEndSameRow !== false

        // Diagnostic — capture decision + full wrap geometry (pre/post activation).
        console.log('[ConcealClick:Snap]',
          { line: currentLine.number, pos, lineTo: currentLine.to,
            lineLen: currentLine.length,
            distFromEnd: currentLine.to - pos,
            clickX: Math.round(clickX),
            clickY: Math.round(clickY),
            endLeft: Math.round(endCoords!.left),
            endTop: Math.round(endCoords!.top),
            endBottom: Math.round(endCoords!.bottom),
            preLineWraps,
            preClickRowMatchesEnd,
            postLineWraps,
            postClickAndEndSameRow,
            postPosTop: postPosCoords ? Math.round(postPosCoords.top) : null,
            postEndTop: postEndCoords ? Math.round(postEndCoords.top) : null,
            pastVisualEnd,
            shouldSnap })
        if (shouldSnap) {
          const targetPos = currentLine.to
          view.dispatch({
            selection: EditorSelection.cursor(targetPos)
          })
          // Settle check: after one frame, see if cursor actually landed where
          // we asked. If something pulled it back (atomic skip, fold inclusive
          // edge, another snap handler), log it so we can find what moved it.
          requestAnimationFrame(() => {
            const finalHead = view.state.selection.main.head
            if (finalHead !== targetPos) {
              console.warn('[ConcealClick:Snap] cursor moved AFTER snap',
                { line: currentLine.number, requestedPos: targetPos, finalHead,
                  drift: finalHead - targetPos })
            }
          })
        }
      }, 0)

      return false
    }
  })
}
