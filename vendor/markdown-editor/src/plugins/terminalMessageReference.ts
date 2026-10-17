import { StateField } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { collectTerminalMessageBlocks, terminalMessageLabel } from '../terminalMessageReference.mjs'
import { attachTerminalMessageChip, openTerminalMessageDetails } from '../terminalMessageReferenceChip'
import type { ClipboardAdapter } from './clipboardAdapter'

type Options = { clipboard: ClipboardAdapter; navigate?: (snapshot: any) => void | Promise<unknown> }
class MessageReferenceWidget extends WidgetType {
  private cleanup: (() => void) | null = null
  private closeDetails: (() => void) | null = null
  constructor(readonly snapshot: any, readonly options: () => Options, readonly selected: boolean) { super() }
  eq(other: MessageReferenceWidget) {
    return this.snapshot.referenceId === other.snapshot.referenceId && this.snapshot.detailsText === other.snapshot.detailsText
      && JSON.stringify(this.snapshot.source) === JSON.stringify(other.snapshot.source) && this.selected === other.selected
  }
  toDOM() {
    const chip = document.createElement('span')
    chip.className = 'cm-composer-token cm-composer-token--paste' + (this.selected ? ' cm-composer-token--selected' : '')
    const label = document.createElement('span'); label.className = 'cm-composer-token-label'
    label.textContent = terminalMessageLabel(this.snapshot); chip.appendChild(label)
    this.cleanup = attachTerminalMessageChip(chip, this.snapshot, {
      allowDetails: () => !this.selected,
      openDetails: snapshot => { this.closeDetails?.(); this.closeDetails = openTerminalMessageDetails(chip.ownerDocument, snapshot, text => this.options().clipboard.writeText(text)) },
      navigate: snapshot => { const navigate = this.options().navigate; if (!navigate) throw Error('Переход к сообщению недоступен'); return navigate(snapshot) },
      error: reason => { chip.title = reason; chip.dataset.messageReferenceError = 'true' },
    })
    return chip
  }
  ignoreEvent(event: Event) { return event.type !== 'mousedown' }
  destroy() { this.cleanup?.(); this.closeDetails?.() }
}
export function terminalMessageReferences(options: () => Options) {
  const field = StateField.define<{ blocks: any[]; decorations: any }>({
    create(state) {
      const blocks = collectTerminalMessageBlocks(state.doc.toString())
      return { blocks, decorations: render(state, blocks) }
    },
    update(previous, transaction) {
      if (!transaction.docChanged && !transaction.selection) return previous
      let blocks = previous.blocks
      if (transaction.docChanged) {
        const windows: Array<{ from: number; to: number }> = []
        const retained = blocks.filter(block => {
          let touched = false
          transaction.changes.iterChangedRanges((from, to) => { if (from < block.to && to > block.from || from === to && from > block.from && from < block.to) touched = true })
          if (touched) windows.push({ from: transaction.changes.mapPos(block.from, -1), to: transaction.changes.mapPos(block.to, 1) })
          return !touched
        }).map(block => ({ ...block, from: transaction.changes.mapPos(block.from, 1), to: transaction.changes.mapPos(block.to, -1) }))
        transaction.changes.iterChangedRanges((_from, _to, from, to) => {
          // Complete paste/Undo is inside the inserted range; ordinary typing
          // scans nearby framing rather than the next megabyte of the document.
          windows.push({ from: Math.max(0, from - 12000), to: Math.min(transaction.state.doc.length, to + 12000) })
        })
        const byRange = new Map(retained.map(block => [block.from + ':' + block.to, block]))
        for (const window of windows) {
          for (const block of collectTerminalMessageBlocks(transaction.state.doc.sliceString(window.from, window.to))) {
            const absolute = { ...block, from: window.from + block.from, to: window.from + block.to }
            byRange.set(absolute.from + ':' + absolute.to, absolute)
          }
        }
        let end = -1
        blocks = [...byRange.values()].filter(b => b.to > b.from).sort((a, b) => a.from - b.from || b.to - a.to)
          .filter(block => { if (block.from < end) return false; end = block.to; return true })
      }
      return { blocks, decorations: render(transaction.state, blocks) }
    },
    provide: field => [EditorView.decorations.from(field, value => value.decorations), EditorView.atomicRanges.of(view => view.state.field(field).decorations)],
  })
  function render(state: any, blocks: any[]) {
    return Decoration.set(blocks.map(block => Decoration.replace({ widget: new MessageReferenceWidget(block.snapshot, options,
      state.selection.ranges.some((range: any) => range.from < block.to && range.to > block.from)) }).range(block.from, block.to)), true)
  }
  return field
}
