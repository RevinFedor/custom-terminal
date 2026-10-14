import type { EditorState } from '@codemirror/state'
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  search,
  searchKeymap,
  setSearchQuery,
} from '@codemirror/search'
import { keymap, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view'

export interface ComposerSearchMatchStats {
  current: number
  total: number
}

export function getComposerSearchMatchStats(
  state: EditorState,
  query: SearchQuery = getSearchQuery(state),
): ComposerSearchMatchStats {
  if (!query.valid || !query.search) return { current: 0, total: 0 }
  const selection = state.selection.main
  let current = 0
  let total = 0
  const cursor = query.getCursor(state)
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    const match = next.value
    total += 1
    if (selection.from === match.from && selection.to === match.to) current = total
  }
  return { current, total }
}

const makeIconButton = (
  label: string,
  path: string,
  onClick: () => void,
) => {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'cm-composer-search-action'
  button.setAttribute('aria-label', label)
  button.title = label
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" /></svg>`
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', onClick)
  return button
}

export function createComposerSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'cm-composer-search-panel'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'cm-composer-search-input'
  input.placeholder = 'Find'
  input.setAttribute('aria-label', 'Find in input')
  input.setAttribute('main-field', 'true')
  input.autocomplete = 'off'
  input.spellcheck = false

  const count = document.createElement('span')
  count.className = 'cm-composer-search-count'
  count.setAttribute('aria-live', 'polite')

  const refresh = () => {
    const query = getSearchQuery(view.state)
    if (input.value !== query.search) input.value = query.search
    const stats = getComposerSearchMatchStats(view.state, query)
    count.textContent = `${stats.current}/${stats.total}`
    count.title = stats.total === 1 ? '1 match' : `${stats.total} matches`
  }

  const move = (command: (target: EditorView) => boolean) => {
    command(view)
    input.focus()
    input.select()
    refresh()
  }

  const previous = makeIconButton('Previous match', 'm15 18-6-6 6-6', () => move(findPrevious))
  const next = makeIconButton('Next match', 'm9 6 6 6-6 6', () => move(findNext))
  const close = makeIconButton('Close search', 'M18 6 6 18M6 6l12 12', () => {
    closeSearchPanel(view)
    view.focus()
  })

  input.addEventListener('input', () => {
    const current = getSearchQuery(view.state)
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({
        search: input.value,
        caseSensitive: current.caseSensitive,
        literal: current.literal,
        regexp: current.regexp,
        wholeWord: current.wholeWord,
      })),
    })
    if (input.value) findNext(view)
    refresh()
  })
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      move(event.shiftKey ? findPrevious : findNext)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeSearchPanel(view)
      view.focus()
    }
  })

  dom.append(input, count, previous, next, close)
  refresh()

  return {
    dom,
    top: true,
    mount() {
      input.focus()
      input.select()
    },
    update(_update: ViewUpdate) {
      refresh()
    },
  }
}

export const composerSearchExtensions = [
  search({ top: true, createPanel: createComposerSearchPanel }),
  keymap.of(searchKeymap),
]
