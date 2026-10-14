import { EditorSelection, Extension } from '@codemirror/state'
import { ViewPlugin, Decoration, DecorationSet, EditorView, ViewUpdate, WidgetType } from '@codemirror/view'

// === Кастомные image-эмодзи ===
//
// Архитектура (см. fact-emoji-shortcuts.md после документирования):
//  • В ТЕКСТЕ файла живёт токен `:имя:` (классический custom-emoji синтаксис
//    Slack/GitHub). Файл остаётся plain markdown — картинка НЕ встраивается
//    в текст, только ссылка-имя.
//  • Картинка (base64 PNG 64×64 из IconCropper) лежит в settings
//    (emojiShortcuts[].image) — тот же паттерн, что customDomainRules у
//    linkIcon.ts и customIconRules у файловых иконок.
//  • Этот плагин сканирует видимые строки на `:имя:`, для известных имён
//    подменяет токен inline-виджетом <img> (Decoration.replace).
//  • В редакторе ведёт себя как обычный emoji-глиф, а не как markdown-чип:
//    известный токен всегда заменяется картинкой, клик по картинке ставит
//    каретку до/после атома, но не раскрывает сырой `:имя:`.
//
// Регистр имени точный. Имена — буквы/цифры/дефис/подчёркивание (включая
// кириллицу), без пробелов: пробел в имени сделал бы токен неотличимым от
// обычного текста с двоеточиями.

export interface CustomEmojiEntry {
  name: string
  image: string // base64 data URI
}

export interface CustomEmojiConfig {
  // Getter (не снапшот) — настройки меняются без пересоздания редактора,
  // тот же приём, что getEmojiShortcuts/getRules в соседних плагинах.
  getCustomEmoji: () => CustomEmojiEntry[]
}

const TOKEN_RE = /:([\p{L}\p{N}_-]+):/gu

class CustomEmojiWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly name: string,
    readonly from: number,
    readonly to: number,
    readonly selected: boolean,
  ) { super() }

  eq(other: CustomEmojiWidget) {
    return other.src === this.src && other.name === this.name &&
      other.from === this.from && other.to === this.to &&
      other.selected === this.selected
  }

  toDOM(view: EditorView) {
    const span = document.createElement('span')
    span.className = `cm-custom-emoji${this.selected ? ' selected' : ''}`
    span.dataset.name = this.name
    span.title = `:${this.name}:`
    span.setAttribute('role', 'img')
    span.setAttribute('aria-label', `:${this.name}:`)

    const img = document.createElement('img')
    img.src = this.src
    img.alt = `:${this.name}:`
    img.className = 'cm-custom-emoji-img'
    img.draggable = false
    span.appendChild(img)

    // Let CodeMirror handle mousedown/mousemove so the image token can be
    // selected by normal drag gestures. Double-click is the only explicit
    // widget gesture: a browser doesn't know that this <img> represents the
    // hidden `:name:` text range, so select that full range ourselves.
    span.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({
        selection: EditorSelection.range(this.from, this.to),
        scrollIntoView: true,
        userEvent: 'select'
      })
      view.focus()
    })
    return span
  }

  ignoreEvent(event: Event) {
    return event.type === 'dblclick'
  }

  coordsAt(dom: HTMLElement, _pos: number, side: number) {
    const rect = dom.getBoundingClientRect()
    const x = side < 0 ? rect.left : rect.right
    return { left: x, right: x, top: rect.top, bottom: rect.bottom }
  }
}

export function createCustomEmojiPlugin(config: CustomEmojiConfig): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }

    update(update: ViewUpdate) {
      // selectionSet — conceal-reveal при движении каретки; viewport — скролл.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = this.build(update.view)
      }
    }

    build(view: EditorView): DecorationSet {
      const entries = config.getCustomEmoji()
      if (!entries || entries.length === 0) return Decoration.none
      const byName = new Map(entries.filter(e => e.name && e.image).map(e => [e.name, e.image]))
      if (byName.size === 0) return Decoration.none

      const decos: { from: number; to: number; deco: Decoration }[] = []
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to)
        TOKEN_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = TOKEN_RE.exec(text))) {
          const image = byName.get(m[1])
          if (!image) continue
          const tFrom = from + m.index
          const tTo = tFrom + m[0].length
          const selected = view.state.selection.ranges.some(r =>
            !r.empty && r.from < tTo && r.to > tFrom
          )
          decos.push({
            from: tFrom,
            to: tTo,
            deco: Decoration.replace({ widget: new CustomEmojiWidget(image, m[1], tFrom, tTo, selected) })
          })
        }
      }
      decos.sort((a, b) => a.from - b.from)
      try {
        return Decoration.set(decos.map(d => d.deco.range(d.from, d.to)), true)
      } catch (_) {
        return Decoration.none
      }
    }
  }, { decorations: v => v.decorations })

  return [
    plugin,
    // Treat `:name:` like one emoji glyph for cursor navigation/delete. Without
    // this, CM can place the caret inside the hidden replacement range and the
    // user sees raw-token/caret glitches on click or arrow navigation.
    EditorView.atomicRanges.of(view => view.plugin(plugin)?.decorations ?? Decoration.none)
  ]
}
