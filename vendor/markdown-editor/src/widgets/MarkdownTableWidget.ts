import { EditorView, WidgetType } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { undo, redo } from '@codemirror/commands'
import type { PhrasingContent } from 'mdast'
import { editMarkdownTable, tableSourcePosition, type MarkdownTable } from '../plugins/markdownTables'
import { tableDOMPosition, tableTextOffsets } from '../plugins/tableTextPosition'
import { resolveClipboardAdapter, type ClipboardAdapter } from '../plugins/clipboardAdapter'
import type { AnchorLinkConfig } from '../plugins/anchorLink'
import { buildAnchorIndex, parseAnchorFragment, resolveAnchor } from '../plugins/anchorIndex'

export interface MarkdownTableConfig extends AnchorLinkConfig {
  onOpenUrl?: (url: string) => void
  resolveImageUrl?: (src: string) => string
  clipboard?: ClipboardAdapter
}

function externalUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url
  if (/^(?:t\.me|github\.com|docs\.google\.com)\//i.test(url)) return 'https://' + url
  return null
}

function appendInline(parent: HTMLElement, nodes: readonly PhrasingContent[], config: MarkdownTableConfig, view: EditorView,
  table: MarkdownTable, positions: WeakMap<Node, readonly number[]>) {
  const appendText = (element: HTMLElement, value: string, node: PhrasingContent, kind: 'text' | 'code' | 'literal') => {
    const text = document.createTextNode(value)
    const from = node.position ? tableSourcePosition(table, node.position.start) : table.from
    const to = node.position ? tableSourcePosition(table, node.position.end) : from + value.length
    positions.set(text, tableTextOffsets(view.state.doc.sliceString(from, to), value, from, kind))
    element.appendChild(text)
  }
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'inlineCode') {
      if (node.type === 'text') appendText(parent, node.value, node, 'text')
      else {
        const code = document.createElement('code')
        code.className = 'cm-md-code'
        appendText(code, node.value, node, 'code')
        parent.appendChild(code)
      }
      continue
    }
    if (node.type === 'break' || (node.type === 'html' && /^<br\s*\/?>$/i.test(node.value))) {
      parent.appendChild(document.createElement('br'))
      continue
    }
    if (node.type === 'image') {
      const image = document.createElement('img')
      const src = config.resolveImageUrl?.(node.url) ?? node.url
      if (!/^\s*(?:javascript|vbscript):/i.test(src)) image.src = src
      image.alt = node.alt ?? ''
      image.className = 'cm-markdown-table-image'
      image.onload = () => view.requestMeasure()
      parent.appendChild(image)
      continue
    }
    if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete' || node.type === 'link') {
      const element = document.createElement(node.type === 'link' ? 'a' : 'span')
      element.className = node.type === 'strong' ? 'cm-md-bold'
        : node.type === 'emphasis' ? 'cm-md-italic'
        : node.type === 'delete' ? 'cm-md-strike' : 'cm-md-link'
      if (node.type === 'link') {
        element.setAttribute('data-table-link', node.url)
        element.setAttribute('tabindex', '-1')
        if (!/^\s*(?:javascript|vbscript|data):/i.test(node.url)) element.setAttribute('href', node.url)
        if (node.title) element.title = node.title
      }
      appendInline(element, node.children, config, view, table, positions)
      parent.appendChild(element)
      continue
    }
    // Raw HTML stays literal, except explicit line breaks above. Building DOM
    // from AST text also preserves untrusted cell content without innerHTML.
    if ('children' in node) appendInline(parent, node.children, config, view, table, positions)
    else if ('value' in node) appendText(parent, String(node.value), node, 'literal')
    else if ('alt' in node) parent.appendChild(document.createTextNode(node.alt ?? ''))
  }
}

export class MarkdownTableWidget extends WidgetType {
  constructor(readonly table: MarkdownTable, readonly config: MarkdownTableConfig, readonly readOnly = false) { super() }

  eq(other: MarkdownTableWidget) {
    return this.table.from === other.table.from && this.table.to === other.table.to &&
      this.table.source === other.table.source && this.config === other.config && this.readOnly === other.readOnly
  }

  private async navigate(url: string, view: EditorView) {
    const external = externalUrl(url)
    if (external) { this.config.onOpenUrl?.(external); return }
    if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//')) return
    const hash = url.indexOf('#')
    const file = hash < 0 ? url : url.slice(0, hash)
    const fragment = hash < 0 ? null : parseAnchorFragment(url.slice(hash + 1))
    if (hash >= 0 && !fragment) return
    if (!file && fragment) {
      const line = resolveAnchor(buildAnchorIndex(view.state.doc.toString()), fragment)
      if (typeof line !== 'number') return
      const pos = view.state.doc.line(line).from
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
      view.focus()
      return
    }
    const path = this.config.resolveCrossFilePath?.(file)
    if (!path) return
    let line: number | null = null
    if (fragment) {
      const index = await this.config.getCrossFileAnchors?.(path)
      const target = index && resolveAnchor(index, fragment)
      if (typeof target === 'number') line = target
    }
    this.config.onNavigate?.(path, line)
  }

  toDOM(view: EditorView) {
    const container = document.createElement('div')
    container.className = 'cm-markdown-table-widget'
    container.setAttribute('data-markdown-table-from', String(this.table.from))
    container.tabIndex = 0
    container.style.setProperty('--cm-table-indent', String(this.table.indent))
    const frame = document.createElement('div')
    frame.className = 'cm-markdown-table-frame'
    const scroller = document.createElement('div')
    scroller.className = 'cm-markdown-table-scroll'
    const table = document.createElement('table')
    table.className = 'cm-markdown-table'
    const columns = this.table.rows[0].length
    const positions = new WeakMap<Node, readonly number[]>()
    const owner = container.ownerDocument
    let lastClick = this.table.rows[0][0].from
    const rememberClick = (event: MouseEvent) => {
      const document = owner as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
      const point = document.caretPositionFromPoint?.(event.clientX, event.clientY)
      const range = point ? null : document.caretRangeFromPoint?.(event.clientX, event.clientY)
      const node = point?.offsetNode ?? range?.startContainer
      const offset = point?.offset ?? range?.startOffset
      if (node && offset !== undefined && container.contains(node)) {
        const position = tableDOMPosition(node, offset, positions)
        if (position !== null) { lastClick = position; return true }
      }
      return false
    }
    if (!this.readOnly) {
      const controls = document.createElement('div')
      controls.className = 'cm-markdown-table-edge-controls'
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'cm-markdown-table-edge-action'
      edit.textContent = 'Редактировать'
      edit.title = 'Редактировать исходный Markdown таблицы'
      edit.setAttribute('aria-label', 'Редактировать таблицу')
      edit.onmousedown = event => { event.preventDefault(); event.stopPropagation() }
      edit.onclick = event => {
        event.preventDefault()
        event.stopPropagation()
        if (view.state.readOnly) return
        const selected = owner.getSelection()
        const anchor = selected?.anchorNode && container.contains(selected.anchorNode)
          ? tableDOMPosition(selected.anchorNode, selected.anchorOffset, positions) : null
        const head = selected?.focusNode && container.contains(selected.focusNode)
          ? tableDOMPosition(selected.focusNode, selected.focusOffset, positions) : null
        view.dispatch({
          effects: editMarkdownTable.of({ from: this.table.from, to: this.table.to }),
          selection: EditorSelection.single(anchor ?? lastClick, head ?? anchor ?? lastClick),
          scrollIntoView: true, userEvent: 'select.table.edit',
        })
        view.focus()
      }
      controls.appendChild(edit)
      frame.appendChild(controls)
    }
    const head = document.createElement('thead'), body = document.createElement('tbody')
    for (let rowIndex = 0; rowIndex < this.table.rows.length; rowIndex++) {
      const row = document.createElement('tr')
      const cells = this.table.rows[rowIndex]
      for (let column = 0; column < columns; column++) {
        const cell = document.createElement(rowIndex === 0 ? 'th' : 'td')
        const source = cells[column]
        cell.setAttribute('data-table-cell-from', String(source?.from ?? cells[0]?.from ?? this.table.from + 1))
        if (rowIndex === 0) cell.setAttribute('scope', 'col')
        cell.style.textAlign = this.table.align?.[column] ?? 'left'
        if (source) appendInline(cell, source.node.children, this.config, view, this.table, positions)
        row.appendChild(cell)
      }
      ;(rowIndex === 0 ? head : body).appendChild(row)
    }
    table.appendChild(head)
    if (body.childNodes.length) table.appendChild(body)
    scroller.appendChild(table)
    frame.appendChild(scroller)
    container.appendChild(frame)
    container.onmousedown = event => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      const link = target.closest('[data-table-link]')
      if (link && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        event.stopPropagation()
        this.navigate(link.getAttribute('data-table-link')!, view).catch(error => console.error('[Table:Link] navigation failed:', error))
        return
      }
      const cell = target.closest('[data-table-cell-from]')
      if (!cell) return
      if (!rememberClick(event)) lastClick = Number(cell.getAttribute('data-table-cell-from'))
      // Focus a native, non-editable surface so CM's source selection/keymap
      // does not replace the browser's ordinary text selection in the table.
      if (!view.state.selection.main.empty) view.dispatch({ selection: { anchor: this.table.from }, userEvent: 'select.table.read' })
      container.focus({ preventScroll: true })
    }
    container.onmouseup = event => { rememberClick(event) }
    container.onclick = event => { if ((event.target as HTMLElement).closest('a')) event.preventDefault() }
    const selectedText = () => {
      const selected = owner.getSelection()
      return selected && !selected.isCollapsed && selected.anchorNode && selected.focusNode &&
        container.contains(selected.anchorNode) && container.contains(selected.focusNode) ? selected.toString() : null
    }
    container.oncopy = event => {
      const text = selectedText()
      if (text === null || !event.clipboardData) return
      event.clipboardData.setData('text/plain', text)
      event.preventDefault()
      event.stopPropagation()
    }
    container.onkeydown = event => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.code === 'KeyZ' || event.code === 'KeyY') {
        if (view.state.readOnly) return
        const changed = event.code === 'KeyY' || event.shiftKey ? redo(view) : undo(view)
        if (changed) {
          event.preventDefault()
          event.stopPropagation()
          const preview = view.dom.querySelector(`[data-markdown-table-from="${this.table.from}"]`) as HTMLElement | null
          if (preview) preview.focus({ preventScroll: true })
          else view.focus()
        }
        return
      }
      if (event.shiftKey) return
      if (event.code === 'KeyA') {
        const selected = owner.getSelection()
        if (!selected) return
        const range = owner.createRange()
        range.selectNodeContents(table)
        selected.removeAllRanges()
        selected.addRange(range)
        event.preventDefault()
        event.stopPropagation()
      } else if (event.code === 'KeyC') {
        const text = selectedText()
        if (text === null) return
        event.preventDefault()
        event.stopPropagation()
        Promise.resolve(resolveClipboardAdapter(this.config.clipboard).writeText(text))
          .catch(error => console.error('[Table:Copy] failed:', error))
      }
    }
    return container
  }

  ignoreEvent() { return true }
}
