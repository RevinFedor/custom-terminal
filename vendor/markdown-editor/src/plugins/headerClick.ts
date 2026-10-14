import { EditorView } from '@codemirror/view'
import { Extension } from '@codemirror/state'
import { foldedRanges } from '@codemirror/language'
import { getCollapsibleTitleRange, toggleFoldOnLine } from './collapsibleArrow'

const COLLAPSIBLE_LINE_RE = /^[\t ]*(>>|\^\^)/

// Клик по ТЕКСТУ заголовка collapsible-списка (>>/^^) сворачивает/разворачивает
// блок — как клик по стрелке, но рабочая зона = весь текст названия.
//
// Модель (вторая итерация спеки):
//  • Клик по тексту названия → toggle fold. mousedown+preventDefault: курсор НЕ
//    ставится, выделение НЕ начинается, быстрые повторные клики работают.
//  • Клик по ПУСТОМУ месту слева от названия (indent/маркерная зона до текста)
//    или правее ВИДИМОГО конца текста → CM6 ставит каретку/выделяет строку
//    штатным способом (вход в редактирование).
//  • Каретка УЖЕ на этой строке → все клики обычные (правка названия как
//    раньше). То есть строка становится обычной редактируемой строкой.
//  • Option/Alt инвертирует режим только для активной строки: если каретка уже
//    на этой collapsible-строке, title-текст снова становится toggle; если
//    строка неактивна — Option отдаёт клик CM6 как обычный текст.
//  • Клик по стрелке-виджету — не наш (свой handler); клик с Cmd/Shift и при
//    активном выделении — не наш.
//
// ШРАМ №1 — граница «текст/пустота» меряется по ПОСЛЕДНЕМУ ВИДИМОМУ глифу, а не
// по line.to. У заголовков с разметкой на хвосте (`*курсив*`, `**жирный**`)
// закрывающие звёздочки скрыты conceal-виджетом (display:none) — обе пробы
// coordsAtPos(line.to, ±1) возвращают null. Прежний код при null МОЛЧА
// пропускал guard пустоты → ВСЯ строка работала как toggle, в конец строки
// нельзя было кликнуть для редактирования. Симптом типозависимый: «работает
// только на заголовках с решёткой» — у них хвост строки видимый.
//
// ШРАМ №2 — зона редактирования включается ПОЗИЦИЕЙ каретки. Это намеренно:
// пользователь ставит каретку в конец collapsible-строки (клик в пустую зону)
// и после этого строка должна вести себя как обычный текст, а НЕ как pointer-
// toggle. Клик по названию снова станет toggle только после ухода каретки с этой
// строки. CSS должен совпадать: `.cm-activeLine .cm-collapsible-title-text`
// получает text cursor.
//
// ШРАМ №2.1 — левая пустота должна быть симметрична правой. У indented
// collapsible-строк отступ до стрелки остаётся реальным текстом в DOM
// (`Decoration.replace` покрывает только сам `>>`/`^^`, см. collapsibleArrow.ts).
// Без явного guard'а клик по этой leading-зоне проходил до toggle, хотя курсор
// там уже был text и пользователь ожидал обычный click/selection.
//
// ШРАМ №3 — toggle идёт через toggleFoldOnLine (свап >>↔^^ + fold/unfold
// атомарно) — тот же путь, что у стрелки-виджета, оглавления и Cmd+. .
// Прежний код маркер НЕ свапал → fold через титул не переживал переоткрытие
// файла (persistence = только маркер в тексте), а unfold `^^`-блока молча
// РЕ-фолдился autoFoldCollapsedMarkers при следующей правке документа.
//
// Историческая справка: самый первый headerClickPlugin (отключён тогда с
// комментом «сворачивание только через gutter») глотал ВСЕ клики по строке —
// заголовок нельзя было редактировать вовсе.

function getVisibleTitleBounds(
  view: EditorView,
  line: { from: number; to: number; text: string }
) {
  const range = getCollapsibleTitleRange(line.text)
  if (!range || range.to <= range.from) return null

  const titleFrom = line.from + range.from
  const titleTo = line.from + range.to
  const start = view.coordsAtPos(titleFrom, 1) ?? view.coordsAtPos(titleFrom, -1)
  if (!start) return null

  let endX: number | null = null
  let endProbe = titleTo
  for (let p = titleTo; p >= titleFrom; p--) {
    const c = view.coordsAtPos(p, -1) ?? view.coordsAtPos(p, 1)
    if (c) { endX = c.left; endProbe = p; break }
  }
  if (endX === null) return null

  return {
    titleFrom,
    titleTo,
    endProbe,
    startX: start.left,
    endX,
    midY: (start.top + start.bottom) / 2
  }
}

function maybeRouteBoundaryGapToPreviousLine(
  event: MouseEvent,
  view: EditorView,
  lineEl: Element,
  currentLine: { from: number; to: number; number: number; text: string }
) {
  if (currentLine.number <= 1) return false

  const rect = (lineEl as HTMLElement).getBoundingClientRect()
  // CM6 maps the vertical leading/top gap of the lower line to that lower line.
  // For adjacent collapsible titles that feels backwards: the gap belongs to the
  // visual end of the previous row. Only reroute the top third, so real clicks
  // in the lower line body still go to the lower line.
  if (event.clientY > rect.top + rect.height / 3) return false

  const prevLine = view.state.doc.line(currentLine.number - 1)
  if (!COLLAPSIBLE_LINE_RE.test(prevLine.text)) return false

  const prevBounds = getVisibleTitleBounds(view, prevLine)
  if (!prevBounds) return false

  // This is the vertical gap over the previous title's text span. Leading indent
  // and right empty zones stay normal text-click areas handled by CM6.
  if (event.clientX < prevBounds.startX - 4 || event.clientX > prevBounds.endX + 4) {
    return false
  }

  const projected = view.posAtCoords({ x: event.clientX, y: prevBounds.midY })
  if (projected === null) return false

  const anchor = Math.max(prevBounds.titleFrom, Math.min(prevBounds.titleTo, projected))
  view.dispatch({
    selection: { anchor },
    scrollIntoView: false,
    userEvent: 'select.pointer'
  })
  console.log('[TitleClick] boundary gap → previous line caret', {
    fromLine: currentLine.number,
    line: prevLine.number,
    anchor,
    clickX: Math.round(event.clientX),
    clickY: Math.round(event.clientY),
    lowerTop: Math.round(rect.top),
    lowerHeight: Math.round(rect.height),
    titleStartX: Math.round(prevBounds.startX),
    titleEndX: Math.round(prevBounds.endX),
    endProbe: prevBounds.endProbe
  })
  event.preventDefault()
  return true
}

const titleClickHandlers = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false // только ЛКМ
    // Shift/Cmd — жесты выделения и мультикурсора. Option/Alt обрабатывается
    // ниже как инверсия active-line режима, поэтому тут НЕ отсекается.
    if (event.shiftKey || event.metaKey) return false
    const target = event.target as HTMLElement

    // Стрелка — отдельный обработчик (createCollapsibleArrowClickHandler).
    if (target.closest('.cm-collapsible-arrow')) return false

    const lineEl = target.closest('.cm-line')
    if (!lineEl) return false

    let pos: number
    try { pos = view.posAtDOM(lineEl) } catch (_) { return false }
    const line = view.state.doc.lineAt(pos)

    // Логи на КАЖДЫЙ отказ обязательны: причины для юзера невидимы, и «клик по
    // названию молча не сработал» читается как поломка (реальный репорт).
    const sel = view.state.selection.main
    if (!sel.empty) {
      // Живое выделение → клик схлопывает его обычным путём, не toggle.
      console.log('[TitleClick] skip: active selection → default', { line: line.number })
      return false
    }

    const caretOnLine = sel.head >= line.from && sel.head <= line.to
    if (event.altKey) {
      if (!COLLAPSIBLE_LINE_RE.test(line.text) || !caretOnLine) {
        console.log('[TitleClick] skip: option on inactive line → default', { line: line.number })
        return false
      }
    } else {
      if (maybeRouteBoundaryGapToPreviousLine(event, view, lineEl, line)) return true
      if (!COLLAPSIBLE_LINE_RE.test(line.text)) return false
    }

    if (caretOnLine && !event.altKey) {
      console.log('[TitleClick] skip: caret on line → edit mode', { line: line.number })
      return false
    }

    const clickPos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    const titleRange = getCollapsibleTitleRange(line.text)
    if (!titleRange) {
      console.log('[TitleClick] skip: no title text → caret', { line: line.number })
      return false
    }

    const titleBounds = getVisibleTitleBounds(view, line)
    const titleFrom = line.from + titleRange.from
    const beforeTitle =
      clickPos !== null &&
      (titleBounds
        ? event.clientX < titleBounds.startX - 4
        : clickPos < titleFrom)
    if (beforeTitle) {
      console.log('[TitleClick] skip: leading zone → caret', {
        line: line.number, clickPos, titleFrom,
        ...(titleBounds ? { titleStartX: Math.round(titleBounds.startX), clickX: Math.round(event.clientX) } : {})
      })
      return false
    }

    // Правая пустая зона меряется по КОНЦУ ВИДИМОГО title-range, а не по line.to.
    // У `**title**` / `*title*` closing markers скрыты conceal-декорациями; если
    // проверять line.to, clickPos может оказаться "до" скрытых маркеров и такой
    // клик ошибочно уйдёт в toggle вместо постановки каретки справа от текста.
    //
    // Счётчик `[12L]` в folded-состоянии — видимый title-widget на конце строки,
    // поэтому он расширяет правую границу интерактивной зоны; клик правее него
    // уже считается пустотой.
    let interactiveEndX = titleBounds?.endX ?? null
    const lineCountEl = (lineEl as HTMLElement).querySelector('.cm-collapsible-line-count') as HTMLElement | null
    const lineCountRect = lineCountEl?.getBoundingClientRect()
    if (interactiveEndX !== null && lineCountRect && lineCountRect.width > 0) {
      interactiveEndX = Math.max(interactiveEndX, lineCountRect.right)
    }

    // Пустая зона: клик правее интерактивного конца И на последнем визуальном ряду
    // title (clickPos >= endProbe). Без позиционной проверки на wrap-строках клик
    // у правого края ВЕРХНИХ рядов (x > endX последнего ряда, но попадает в
    // середину текста) ложно уходил бы в каретку.
    if (titleBounds && interactiveEndX !== null && clickPos !== null &&
        clickPos >= titleBounds.endProbe && event.clientX > interactiveEndX + 4) {
      console.log('[TitleClick] skip: empty zone → caret', {
        line: line.number,
        clickX: Math.round(event.clientX),
        titleEndX: Math.round(titleBounds.endX),
        interactiveEndX: Math.round(interactiveEndX),
        endProbe: titleBounds.endProbe,
        clickPos
      })
      return false
    }

    // wasFolded — только для лога (toggleFoldOnLine сам определяет состояние).
    let wasFolded = false
    foldedRanges(view.state).between(line.from, line.to, () => { wasFolded = true })

    if (!toggleFoldOnLine(view, line)) {
      console.log('[TitleClick] skip: empty section → caret', { line: line.number })
      return false // нечего сворачивать → клик = обычная установка каретки
    }

    console.log('[TitleClick] toggle fold', { line: line.number, wasFolded })
    // preventDefault: не дать CM6 поставить каретку/начать выделение —
    // фокус строки не меняется, быстрые клики не выделяют текст.
    event.preventDefault()
    return true
  },
})

export const collapsibleTitleClick: Extension = titleClickHandlers

// Pointer-курсор над строкой-заголовком collapsible — ЧИСТО CSS, выведен из
// состояния: pointer только над title-range, а когда строка активна
// (.cm-activeLine) — text. См. editor.css рядом с `.cm-collapsible-title-text`.
// Прежний mousemove-плагин (collapsibleTitleHoverCursor) удалён: класс терялся
// при ребилде DOM строки после fold и снимался над стрелкой — курсор мигал
// pointer↔text.

// Legacy-алиас старого имени (был отключён в Editor.tsx; новый плагин — замена).
export const headerClickPlugin = collapsibleTitleClick
