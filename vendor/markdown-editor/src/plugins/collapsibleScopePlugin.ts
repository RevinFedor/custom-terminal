import { ViewPlugin, Decoration, DecorationSet, EditorView } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

const collapsiblePattern = /^(\s*)(>>|\^\^)/

/**
 * Определяет тип форматирования по ПЕРВОМУ non-space символу content после >>/^^.
 * Позиционное правило, не приоритетное: какой токен идёт первым — такой цвет.
 *
 * Примеры:
 *   >> `code` **bold**   → code (первый токен — backtick)
 *   >> **bold** `code`   → bold
 *   >> # Heading         → h1
 *   >> ## *italic*       → h2 (заголовок выигрывает у italic потому что # идёт первым)
 *   >> ~strike~          → null (одинарный ~ не считается)
 *
 * ВАЖНО: _ (нижнее подчёркивание) не учитывается — только *.
 */
function detectFormatting(lineText: string): string | null {
  // Убираем >>/^^ и leading whitespace
  const content = lineText.replace(/^\s*(>>|\^\^)\s*/, '')
  if (!content) return null

  const c0 = content[0]

  // # ... # — заголовок 1..6 уровня, за #-ками должен идти пробел
  if (c0 === '#') {
    let level = 0
    while (level < content.length && content[level] === '#') level++
    if (level >= 1 && level <= 6 && content[level] === ' ') {
      return `h${level}`
    }
    return null
  }

  // * → bold если следующий тоже *, иначе italic
  if (c0 === '*') {
    return content[1] === '*' ? 'bold' : 'italic'
  }

  // ` → code
  if (c0 === '`') {
    return 'code'
  }

  // ~~ → strike (одинарная ~ не считается)
  if (c0 === '~' && content[1] === '~') {
    return 'strike'
  }

  return null
}

/**
 * Вычисляет уровень отступа строки (количество табов или групп по 4 пробела)
 */
function getIndentLevel(lineText: string): number {
  const match = lineText.match(/^(\s*)/)
  if (!match) return 0
  const indentStr = match[1]
  // Считаем табы как 1 уровень, 4 пробела как 1 уровень
  let level = 0
  let spaces = 0
  for (const char of indentStr) {
    if (char === '\t') {
      level++
      spaces = 0
    } else if (char === ' ') {
      spaces++
      if (spaces >= 4) {
        level++
        spaces = 0
      }
    }
  }
  return level
}

interface ActiveScope {
  headerLine: number
  headerIndentLevel: number // Уровень отступа заголовка
  formatType: string
  ownsLevel: number // Какой уровень indent принадлежит этой секции (headerIndentLevel + 1)
}

/**
 * Плагин для добавления классов cm-scope-L{level}-{formatType} к строкам
 * Поддерживает вложенные collapsible секции с разными цветами на разных уровнях
 */
export const collapsibleScopePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view)
    }

    update(update: { docChanged: boolean; view: EditorView }) {
      if (update.docChanged) {
        this.decorations = this.buildDecorations(update.view)
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const doc = view.state.doc
      const builder = new RangeSetBuilder<Decoration>()

      // Стек активных секций
      const activeScopes: ActiveScope[] = []

      // Собираем все декорации
      const lineDecorations: Map<number, Set<string>> = new Map()

      for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
        const line = doc.line(lineNum)
        const lineText = line.text
        const currentIndentLevel = getIndentLevel(lineText)
        const isEmptyLine = lineText.trim() === ''

        // Очищаем стек от секций, которые уже закончились
        // Секция заканчивается когда мы встречаем НЕпустую строку с indent <= headerIndent
        if (!isEmptyLine) {
          while (activeScopes.length > 0) {
            const topScope = activeScopes[activeScopes.length - 1]
            if (currentIndentLevel <= topScope.headerIndentLevel) {
              activeScopes.pop()
            } else {
              break
            }
          }
        }

        // Проверяем, является ли строка заголовком collapsible.
        // NB: scope-colors активируются ТОЛЬКО для строк, начинающихся с >> или ^^.
        // Обычные строки с **bold** или *italic*, под которыми есть indented children,
        // НЕ получают coloured indent guides — см. detectFormatting и regex выше.
        // Если юзер жалуется «выделил bold, цвет линии не сменился» — это by-design;
        // ему нужен collapsible-header (>>), не просто bold.
        const match = lineText.match(collapsiblePattern)
        if (match) {
          const formatType = detectFormatting(lineText)
          if (formatType) {
            // Добавляем новую секцию в стек
            activeScopes.push({
              headerLine: lineNum,
              headerIndentLevel: currentIndentLevel,
              formatType,
              ownsLevel: currentIndentLevel + 1
            })
          }
        }

        // Для текущей строки определяем классы на основе активных секций
        // Но не для строк-заголовков (они сами не внутри своего scope)
        if (!isEmptyLine && currentIndentLevel > 0) {
          const classes = new Set<string>()

          for (const scope of activeScopes) {
            // Секция влияет на линию своего уровня (ownsLevel)
            // Если текущая строка имеет indent >= ownsLevel, то линия на уровне ownsLevel принадлежит этой секции
            if (currentIndentLevel >= scope.ownsLevel) {
              classes.add(`cm-scope-L${scope.ownsLevel}-${scope.formatType}`)
            }
          }

          if (classes.size > 0) {
            lineDecorations.set(lineNum, classes)
          }
        }

        // Для пустых строк — копируем классы от предыдущей непустой строки
        // чтобы линии не прерывались
        if (isEmptyLine && activeScopes.length > 0) {
          const classes = new Set<string>()
          for (const scope of activeScopes) {
            // Для пустых строк добавляем все активные scope
            classes.add(`cm-scope-L${scope.ownsLevel}-${scope.formatType}`)
          }
          if (classes.size > 0) {
            lineDecorations.set(lineNum, classes)
          }
        }
      }

      // Конвертируем в декорации (сортированные по позиции)
      const sortedLineNums = Array.from(lineDecorations.keys()).sort((a, b) => a - b)

      for (const lineNum of sortedLineNums) {
        const classes = lineDecorations.get(lineNum)!
        const line = doc.line(lineNum)
        const classString = Array.from(classes).join(' ')
        builder.add(line.from, line.from, Decoration.line({ class: classString }))
      }

      return builder.finish()
    }
  },
  { decorations: v => v.decorations }
)
