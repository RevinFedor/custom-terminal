import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'
import {
  Decoration,
  EditorView,
  WidgetType,
  drawSelection,
  keymap,
  type DecorationSet,
  type Command,
} from '@codemirror/view'
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  redo,
  undo,
} from '@codemirror/commands'
import {
  createComposerHistoryPayloadExtension,
  type ComposerHistoryPayloadExtension,
} from './composerHistory'
import {
  composerPointerStayedWithinClickThreshold,
  composerTokenIntersectsSelection,
  findComposerStatusTokenBackwardDeleteRange,
  resolveComposerStatusTokenRevealCaret,
} from './composerTokenEditing'
import {
  readSynchronousComposerClipboardPayload,
  shouldDeferComposerPasteToNative,
} from './composerClipboard'
import { readComposerNaturalHeight } from './composerGeometry'
import { attachTerminalMessageChip } from './terminalMessageReferenceChip'
import type { ClipboardAdapter } from './plugins/clipboardAdapter'
import { composerSearchExtensions } from './composerSearch'

export type { ComposerEditorDeleteRange } from './composerTokenEditing'

export type ComposerInlineTokenKind = 'image' | 'paste' | 'error' | 'pending' | 'reference'

export interface ComposerInlineToken {
  id: string
  from: number
  to: number
  kind: ComposerInlineTokenKind
  label: string
  thumbnailUrl?: string
  messageReference?: { referenceId: string; source: any; detailsText: string }
  /** Error/pending ranges stay text; image/paste ranges become atomic chips. */
  replace?: boolean
}

export interface ComposerEditorSelection {
  start: number
  end: number
  /** Ordered start/end remain suitable for replacement; anchor/head retain direction. */
  anchor?: number
  head?: number
}

export interface ComposerEditorViewState {
  selectionStart: number
  selectionEnd: number
  selectionAnchor?: number
  selectionHead?: number
  scrollTop: number
}

export interface ComposerEditorHandle {
  readonly dom: HTMLDivElement | null
  readonly value: string
  readonly selectionStart: number
  readonly selectionEnd: number
  readonly selectionAnchor?: number
  readonly selectionHead?: number
  readonly scrollHeight: number
  readonly clientWidth: number
  scrollTop: number
  scrollLeft: number
  readonly style: CSSStyleDeclaration
  /**
   * Measure the document after CodeMirror has reconciled its own geometry.
   * This reports CodeMirror's content height, which is independent from the
   * currently constrained scroll viewport.
   */
  measureNaturalHeight(onMeasured: (height: number) => void): void
  focus(): void
  setSelectionRange(start: number, end?: number): void
  getBoundingClientRect(): DOMRect
  getAttribute(name: string): string | null
  isFocused(): boolean
  applySnapshot(snapshot: ComposerEditorSnapshot): boolean | void
  /**
   * Restore selection and the editor's own scroll as one layout operation.
   * Unlike setSelectionRange this deliberately does not scroll the caret into
   * view: the saved scroll position is authoritative and may not contain it.
   */
  restoreViewState(
    snapshot: ComposerEditorViewState,
    onApplied?: (state: ComposerEditorViewState) => void,
  ): void
}

export interface ComposerEditorSnapshot {
  value: string
  /** Optional exact edit for async completion. False return means the range
   * no longer produces value from the current document; nothing was applied. */
  replacement?: { from: number; to: number; insert: string }
  selectionStart?: number
  selectionEnd?: number
  history?: 'add' | 'replace' | 'external'
  historyPayload?: unknown
  userEvent?: string
  /** Background streaming must not reveal an offscreen caret. Defaults to true. */
  scrollIntoView?: boolean
}

export interface ComposerEditorProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'onCopy' | 'onCut' | 'onPaste' | 'onKeyDown' | 'onContextMenu'> {
  value: string
  onChange: (value: string, selection: ComposerEditorSelection, historyPayload?: unknown) => void
  tokens?: ComposerInlineToken[]
  placeholder?: string
  readOnly?: boolean
  autoFocus?: boolean
  fontSize?: number
  onSelectionChange?: (selection: ComposerEditorSelection) => void
  onScrollChange?: (scrollTop: number) => void
  /**
   * Opaque host-owned metadata that must travel through Undo/Redo with text.
   * History and Run after use this for exact image refs and hidden paste bodies.
   */
  historyPayload?: unknown
  /** Changing the owner resets native Undo/Redo so drafts never cross tabs/items. */
  historyOwnerKey?: string
  /** Set once per editor. Streaming documents undo edits through newer text. */
  historyTextMode?: 'snapshot' | 'mapped'
  /** Exact editor changes let hosts preserve identities of equal-looking anchors. */
  deriveHistoryPayload?: (nextValue: string, previousPayload: unknown, transaction?: Transaction) => unknown
  historyPayloadEqual?: (left: unknown, right: unknown) => boolean
  /**
   * Optional host clipboard transport. Electron hosts use its synchronous
   * readText/readFormats path because native text paste is not reliable in a
   * CodeMirror renderer without a native Edit menu. Bitmap payloads still
   * fall through to the native DOM paste event.
   */
  clipboard?: ClipboardAdapter
  /** Clipboard/key callbacks receive a textarea-compatible facade. */
  onCopy?: (event: any) => void
  onCut?: (event: any) => void
  onPaste?: (event: any) => void
  onKeyDown?: (event: any) => void
  onContextMenu?: (event: any) => void
  /** Return true to keep the token rendered; false reveals its raw source. */
  onTokenClick?: (token: ComposerInlineToken, event: MouseEvent) => boolean | void
  onMessageReferenceNavigate?: (snapshot: any) => void | Promise<unknown>
  /** Return true when the host displayed its own menu. */
  onTokenContextMenu?: (token: ComposerInlineToken, event: MouseEvent) => boolean | void
}

const externalValueSync = Annotation.define<boolean>()
const setTokensEffect = StateEffect.define<ComposerInlineToken[]>()

// Reuse the static StyleModule across views; CodeMirror installs it in each
// Document/ShadowRoot as needed. CSS variables still resolve per editor.
const composerTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: 'inherit',
    maxHeight: 'inherit',
    background: 'transparent',
    color: 'inherit',
    fontSize: 'var(--composer-editor-font-size, 14px)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.35',
    overflowY: 'auto',
    overflowX: 'hidden',
    scrollbarGutter: 'stable',
  },
  '.cm-content': {
    minHeight: 'inherit',
    padding: 'var(--composer-editor-padding-y, 7px) var(--composer-editor-padding-x, 8px)',
    caretColor: 'currentColor',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'currentColor' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: 'rgba(96, 165, 250, 0.30) !important',
  },
  // Generated hint reserves the same wrapped height as the empty line, but
  // adds no DOM text/widget to CodeMirror's editable document.
  '.cm-content[data-composer-empty-placeholder]': {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
  },
  '.cm-content[data-composer-empty-placeholder]::before': {
    content: 'attr(aria-placeholder) / ""',
    gridArea: '1 / 1',
    minWidth: '0',
    color: '#666',
    fontStyle: 'normal',
    pointerEvents: 'none',
    userSelect: 'none',
  },
  '.cm-content[data-composer-empty-placeholder] > .cm-line': {
    gridArea: '1 / 1',
    minWidth: '0',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(250, 204, 21, 0.30)',
    outline: '1px solid rgba(250, 204, 21, 0.42)',
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'rgba(250, 204, 21, 0.58)',
    outline: '1px solid rgba(253, 224, 71, 0.80)',
  },
})

// Keep aria-placeholder in empty and nonempty editors, like CM's string
// placeholder extension. Visibility follows the document, never focus/input.
const composerPlaceholderExtension = (hint: string) => (
  EditorView.contentAttributes.of((view) => ({
    'aria-placeholder': hint,
    ...(hint && view.state.doc.length === 0
      ? { 'data-composer-empty-placeholder': '' }
      : {}),
  }))
)

class ComposerTokenAtom extends RangeValue {}
const COMPOSER_TOKEN_ATOM = new ComposerTokenAtom()

type TokenHandlerRef = React.MutableRefObject<
  ((token: ComposerInlineToken, event: MouseEvent) => boolean | void) | undefined
>

class ComposerInlineTokenWidget extends WidgetType {
  // Set when the status-token mouseup path already delivered the click to the
  // host handler; the trailing native click on the same DOM node is a
  // duplicate of that same physical gesture.
  private suppressNextClick = false
  private disposeMessageReference: (() => void) | null = null

  constructor(
    readonly token: ComposerInlineToken,
    readonly selected: boolean,
    readonly clickHandler: TokenHandlerRef,
    readonly contextMenuHandler: TokenHandlerRef,
    readonly messageNavigate: { current?: ((snapshot: any) => void | Promise<unknown>) | null },
  ) {
    super()
  }

  eq(other: ComposerInlineTokenWidget) {
    return other.token.id === this.token.id
      && other.token.from === this.token.from
      && other.token.to === this.token.to
      && other.token.kind === this.token.kind
      && other.token.label === this.token.label
      && other.token.thumbnailUrl === this.token.thumbnailUrl
      && other.selected === this.selected
      && other.token.messageReference?.referenceId === this.token.messageReference?.referenceId
      && other.token.messageReference?.detailsText === this.token.messageReference?.detailsText
      && JSON.stringify(other.token.messageReference?.source || null) === JSON.stringify(this.token.messageReference?.source || null)
  }

  toDOM(view: EditorView) {
    const chip = document.createElement('span')
    chip.className = [
      'cm-composer-token',
      `cm-composer-token--${this.token.kind}`,
      this.selected ? 'cm-composer-token--selected' : '',
    ].filter(Boolean).join(' ')
    chip.dataset.composerTokenId = this.token.id

    // Pasted text has a disclosure metaphor: clicking it opens the stored
    // body.  An image already has a thumbnail and the same arrow looked like a
    // second dropdown control, even though no dropdown exists.
    if (this.token.kind === 'paste') {
      const arrow = document.createElement('span')
      arrow.className = 'cm-composer-token-arrow'
      arrow.textContent = '▸'
      arrow.setAttribute('aria-hidden', 'true')
      chip.appendChild(arrow)
    }

    if (this.token.kind === 'image') {
      const thumbnail = document.createElement('span')
      thumbnail.className = 'cm-composer-token-thumbnail'
      const fallback = document.createElement('span')
      fallback.className = 'cm-composer-token-thumbnail-fallback'
      fallback.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="m4.5 15 4-4 2.5 2.5 2-2 2.5 3.5"/></svg>'
      if (this.token.thumbnailUrl) {
        const image = document.createElement('img')
        image.src = this.token.thumbnailUrl
        image.alt = ''
        image.draggable = false
        fallback.hidden = true
        image.addEventListener('error', () => {
          image.hidden = true
          fallback.hidden = false
        })
        thumbnail.appendChild(image)
      }
      thumbnail.appendChild(fallback)
      chip.appendChild(thumbnail)
    }

    const label = document.createElement('span')
    label.className = 'cm-composer-token-label'
    label.textContent = this.token.label
    chip.appendChild(label)

    if (this.token.messageReference) {
      this.disposeMessageReference = attachTerminalMessageChip(chip, this.token.messageReference, {
        allowDetails: () => view.state.selection.main.empty,
        openDetails: () => this.clickHandler.current?.(this.token, new MouseEvent('click')),
        navigate: snapshot => {
          if (!this.messageNavigate.current) throw Error('Переход к сообщению недоступен в этом приложении')
          return this.messageNavigate.current(snapshot)
        },
        error: reason => { chip.title = reason; chip.dataset.messageReferenceError = 'true' },
      })
      chip.addEventListener('contextmenu', event => {
        if (this.contextMenuHandler.current?.(this.token, event) === true) {
          event.preventDefault(); event.stopPropagation()
        }
      })
      return chip
    }

    const revealSource = (
      clientX: number,
      bounds: { left: number; width: number } = chip.getBoundingClientRect(),
    ) => {
      const pos = resolveComposerStatusTokenRevealCaret(
        this.token,
        clientX,
        bounds,
      )
      view.dispatch({
        selection: EditorSelection.cursor(pos, 1),
        scrollIntoView: true,
        userEvent: 'select',
      })
      view.focus()
    }

    // A status widget can disappear during CodeMirror's mousedown handling:
    // CM maps the pointer into the hidden source range, the token becomes
    // active, and the replacement decoration is removed before `click` can
    // reach this DOM node.  Remember the original geometry and finish a real
    // click after native mouseup.  Drag-selection remains entirely CM-owned.
    const scheduleStatusTokenMouseupReveal = (event: MouseEvent) => {
      if (
        event.button !== 0
        || (this.token.kind !== 'error' && this.token.kind !== 'pending')
      ) return

      const rect = chip.getBoundingClientRect()
      const start = { x: event.clientX, y: event.clientY }
      let movedBeyondClick = false
      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!composerPointerStayedWithinClickThreshold(start, {
          x: moveEvent.clientX,
          y: moveEvent.clientY,
        })) movedBeyondClick = true
      }
      const cleanup = () => {
        window.removeEventListener('mousemove', onMouseMove, true)
        window.removeEventListener('mouseup', onMouseUp, true)
        window.removeEventListener('blur', cleanup)
      }
      const onMouseUp = (upEvent: MouseEvent) => {
        const clickLike = upEvent.button === 0
          && !movedBeyondClick
          && composerPointerStayedWithinClickThreshold(start, {
            x: upEvent.clientX,
            y: upEvent.clientY,
          })
        cleanup()
        if (!clickLike) return

        // Run after CodeMirror's handlers for this same physical mouseup. This
        // is an event-driven handoff, not a timer; it cannot race a later edit.
        queueMicrotask(() => {
          if (!view.dom.isConnected) return
          // A status token can be interactive (e.g. a failed-dictation chip
          // whose click retries). Offer the click to the host FIRST; only an
          // unhandled click falls through to the source reveal. When the
          // widget survives (no reveal → no unmount), the native click event
          // still dispatches on it — suppress that second delivery.
          const handled = this.clickHandler.current?.(this.token, upEvent)
          if (handled === true) {
            this.suppressNextClick = true
            return
          }
          if (!view.state.selection.main.empty) return
          if (view.state.doc.length < this.token.to) return
          revealSource(start.x, { left: rect.left, width: rect.width })
        })
      }

      window.addEventListener('mousemove', onMouseMove, true)
      window.addEventListener('mouseup', onMouseUp, { capture: true, once: true })
      window.addEventListener('blur', cleanup, { once: true })
    }

    // The second mousedown of a double click reaches CodeMirror before the
    // click handler and would invoke its word/widget selection.  A single
    // mousedown must still reach CM so drag-selection can start on the chip.
    chip.addEventListener('mousedown', (event) => {
      if (event.detail > 1) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      scheduleStatusTokenMouseupReveal(event)
    })
    chip.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })

    chip.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.detail > 1) return
      // The status-token mouseup path above may have already delivered this
      // physical click to the host; the native click that follows must not
      // deliver it twice.
      if (this.suppressNextClick) {
        this.suppressNextClick = false
        return
      }
      // A drag that started on the chip belongs to CodeMirror's selection
      // controller.  Do not turn the mouseup/click tail into a preview toggle.
      if (!view.state.selection.main.empty) return
      const handled = this.clickHandler.current?.(this.token, event)
      if (handled !== true) revealSource(event.clientX)
    })
    chip.addEventListener('contextmenu', (event) => {
      const handled = this.contextMenuHandler.current?.(this.token, event)
      if (handled !== true) return
      event.preventDefault()
      event.stopPropagation()
    })

    return chip
  }

  ignoreEvent(event: Event) {
    // Let CodeMirror own mousedown so a selection can start on an atomic chip.
    // Click/context-menu remain semantic host actions handled above.
    return event.type !== 'mousedown'
  }
  destroy() { this.disposeMessageReference?.(); this.disposeMessageReference = null }
}

interface ComposerTokenFieldValue {
  tokens: ComposerInlineToken[]
  decorations: DecorationSet
  atoms: RangeSet<ComposerTokenAtom>
}

const normalizeTokens = (tokens: ComposerInlineToken[], docLength: number) => (
  tokens
    .filter((token) => Number.isFinite(token.from)
      && Number.isFinite(token.to)
      && token.from >= 0
      && token.to > token.from
      && token.to <= docLength)
    .slice()
    .sort((left, right) => left.from - right.from || left.to - right.to)
)

const buildTokenFieldValue = (
  state: EditorState,
  tokens: ComposerInlineToken[],
  clickHandler: TokenHandlerRef,
  contextMenuHandler: TokenHandlerRef,
  messageNavigate: { current?: ((snapshot: any) => void | Promise<unknown>) | null },
): ComposerTokenFieldValue => {
  const normalized = normalizeTokens(tokens, state.doc.length)
  const decorations: Array<{ from: number; to: number; value: Decoration }> = []
  const atoms: Array<{ from: number; to: number; value: ComposerTokenAtom }> = []
  const cursor = state.selection.main.head
  const selection = state.selection.main
  let occupiedUntil = -1

  for (const token of normalized) {
    if (token.from < occupiedUntil) continue
    occupiedUntil = token.to
    const replace = token.replace ?? (token.kind === 'image' || token.kind === 'paste')
    const active = cursor > token.from && cursor < token.to
    const selected = composerTokenIntersectsSelection(token, selection)
    if (replace && !active) {
      decorations.push({
        from: token.from,
        to: token.to,
        value: Decoration.replace({
          widget: new ComposerInlineTokenWidget(token, selected, clickHandler, contextMenuHandler, messageNavigate),
        }),
      })
      atoms.push({ from: token.from, to: token.to, value: COMPOSER_TOKEN_ATOM })
    } else {
      decorations.push({
        from: token.from,
        to: token.to,
        value: Decoration.mark({ class: `cm-composer-token-source cm-composer-token-source--${token.kind}` }),
      })
    }
  }

  return {
    tokens: normalized,
    decorations: Decoration.set(
      decorations.map(({ from, to, value }) => value.range(from, to)),
      true,
    ),
    atoms: RangeSet.of(atoms.map(({ from, to, value }) => value.range(from, to)), true),
  }
}

const createComposerTokenField = (
  clickHandler: TokenHandlerRef,
  contextMenuHandler: TokenHandlerRef,
  messageNavigate: { current?: ((snapshot: any) => void | Promise<unknown>) | null },
) => StateField.define<ComposerTokenFieldValue>({
  create(state) {
    return buildTokenFieldValue(state, [], clickHandler, contextMenuHandler, messageNavigate)
  },
  update(previous, transaction) {
    let tokens = previous.tokens
    for (const effect of transaction.effects) {
      if (effect.is(setTokensEffect)) tokens = effect.value
    }
    if (!transaction.docChanged && !transaction.selection && tokens === previous.tokens) return previous
    return buildTokenFieldValue(transaction.state, tokens, clickHandler, contextMenuHandler, messageNavigate)
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).atoms),
  ],
})

const makeEventTarget = (view: EditorView) => ({
    get value() { return view.state.doc.toString() },
    get selectionStart() { return view.state.selection.main.from },
    get selectionEnd() { return view.state.selection.main.to },
    get scrollTop() { return view.scrollDOM.scrollTop },
    get scrollLeft() { return view.scrollDOM.scrollLeft },
    focus: () => view.focus(),
    setSelectionRange: (start: number, end = start) => {
      const max = view.state.doc.length
      view.dispatch({ selection: { anchor: Math.max(0, Math.min(start, max)), head: Math.max(0, Math.min(end, max)) } })
    },
})

const makeEventFacade = (event: Event, view: EditorView) => {
  const target = makeEventTarget(view)
  return {
    type: event.type,
    currentTarget: target,
    target,
    clipboardData: (event as ClipboardEvent).clipboardData,
    key: (event as KeyboardEvent).key,
    code: (event as KeyboardEvent).code,
    metaKey: (event as KeyboardEvent).metaKey,
    ctrlKey: (event as KeyboardEvent).ctrlKey,
    altKey: (event as KeyboardEvent).altKey,
    shiftKey: (event as KeyboardEvent).shiftKey,
    clientX: (event as MouseEvent).clientX,
    clientY: (event as MouseEvent).clientY,
    nativeEvent: event,
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
  }
}

const makeTextPasteFacade = (
  view: EditorView,
  text: string,
  formats: string[],
  html = '',
) => {
  let defaultPrevented = false
  const target = makeEventTarget(view)
  const types = Array.from(new Set([
    ...formats,
    ...(formats.some((format) => format.toLowerCase() === 'text/plain') ? [] : ['text/plain']),
  ]))
  const nativeEvent = {
    type: 'paste',
    get defaultPrevented() { return defaultPrevented },
    preventDefault: () => { defaultPrevented = true },
    stopPropagation: () => {},
    stopImmediatePropagation: () => {},
  }
  return {
    type: 'paste',
    currentTarget: target,
    target,
    clipboardData: {
      types,
      items: [],
      files: [],
      getData: (type: string) => (
        type.toLowerCase() === 'text/plain' || type.toLowerCase() === 'text'
          ? text
          : type.toLowerCase() === 'text/html' ? html : ''
      ),
    },
    nativeEvent,
    get defaultPrevented() { return defaultPrevented },
    preventDefault: nativeEvent.preventDefault,
    stopPropagation: nativeEvent.stopPropagation,
  }
}

const insertComposerClipboardText = (view: EditorView, text: string) => {
  const selection = view.state.selection.main
  const caret = selection.from + text.length
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: text },
    selection: EditorSelection.cursor(caret),
    scrollIntoView: true,
    userEvent: 'input.paste',
  })
}

/**
 * A deliberately small CodeMirror surface for AI composers. It owns no draft,
 * attachments, queue, or persistence; hosts keep those contracts. Its only job
 * is textarea-compatible editing plus real inline atomic tokens, which cannot
 * be implemented safely with a painted textarea overlay.
 */
export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor({
  value,
  onChange,
  tokens = [],
  placeholder = '',
  readOnly = false,
  autoFocus = false,
  fontSize = 14,
  onSelectionChange,
  onScrollChange,
  historyPayload,
  historyOwnerKey,
  historyTextMode = 'snapshot',
  deriveHistoryPayload,
  historyPayloadEqual,
  clipboard,
  onCopy,
  onCut,
  onPaste,
  onKeyDown,
  onContextMenu,
  onTokenClick,
  onMessageReferenceNavigate,
  onTokenContextMenu,
  className,
  style,
  ...domProps
}, forwardedRef) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onScrollChangeRef = useRef(onScrollChange)
  const historyPayloadRef = useRef<unknown>(historyPayload ?? null)
  const deriveHistoryPayloadRef = useRef(deriveHistoryPayload)
  const historyPayloadEqualRef = useRef(historyPayloadEqual)
  const historyExtensionRef = useRef<ComposerHistoryPayloadExtension<unknown> | null>(null)
  const historyCompartmentRef = useRef(new Compartment())
  const historyOwnerKeyRef = useRef(historyOwnerKey)
  const historyOwnerTransitionRef = useRef(false)
  const viewRestoreGenerationRef = useRef(0)
  const naturalHeightMeasureKeyRef = useRef({})
  const aggregateHistoryReplayRef = useRef(false)
  const clipboardRef = useRef(clipboard)
  const onCopyRef = useRef(onCopy)
  const onCutRef = useRef(onCut)
  const onPasteRef = useRef(onPaste)
  const onKeyDownRef = useRef(onKeyDown)
  const onContextMenuRef = useRef(onContextMenu)
  const tokenClickRef = useRef(onTokenClick)
  const messageNavigateRef = useRef(onMessageReferenceNavigate)
  const tokenContextMenuRef = useRef(onTokenContextMenu)
  const readOnlyCompartmentRef = useRef(new Compartment())
  const appliedReadOnlyRef = useRef<{ view: EditorView; value: boolean } | null>(null)
  const placeholderCompartmentRef = useRef(new Compartment())
  const appliedPlaceholderRef = useRef<{ view: EditorView; value: string } | null>(null)

  onChangeRef.current = onChange
  onSelectionChangeRef.current = onSelectionChange
  onScrollChangeRef.current = onScrollChange
  historyPayloadRef.current = historyPayload ?? null
  deriveHistoryPayloadRef.current = deriveHistoryPayload
  historyPayloadEqualRef.current = historyPayloadEqual
  clipboardRef.current = clipboard
  onCopyRef.current = onCopy
  onCutRef.current = onCut
  onPasteRef.current = onPaste
  onKeyDownRef.current = onKeyDown
  onContextMenuRef.current = onContextMenu
  tokenClickRef.current = onTokenClick
  messageNavigateRef.current = onMessageReferenceNavigate
  tokenContextMenuRef.current = onTokenContextMenu
  if (historyOwnerKeyRef.current !== historyOwnerKey) {
    historyOwnerTransitionRef.current = true
  }

  useImperativeHandle(forwardedRef, () => ({
    get dom() { return rootRef.current },
    get value() { return viewRef.current?.state.doc.toString() || '' },
    get selectionStart() { return viewRef.current?.state.selection.main.from || 0 },
    get selectionEnd() { return viewRef.current?.state.selection.main.to || 0 },
    get selectionAnchor() { return viewRef.current?.state.selection.main.anchor || 0 },
    get selectionHead() { return viewRef.current?.state.selection.main.head || 0 },
    get scrollHeight() { return viewRef.current?.scrollDOM.scrollHeight || rootRef.current?.scrollHeight || 0 },
    get clientWidth() { return rootRef.current?.clientWidth || 0 },
    get scrollTop() { return viewRef.current?.scrollDOM.scrollTop || 0 },
    set scrollTop(value: number) { if (viewRef.current) viewRef.current.scrollDOM.scrollTop = value },
    get scrollLeft() { return viewRef.current?.scrollDOM.scrollLeft || 0 },
    set scrollLeft(value: number) { if (viewRef.current) viewRef.current.scrollDOM.scrollLeft = value },
    get style() { return rootRef.current?.style || document.createElement('div').style },
    measureNaturalHeight(onMeasured) {
      const view = viewRef.current
      const root = rootRef.current
      if (!view || !root) return

      // scrollDOM.scrollHeight is never smaller than its current viewport.
      // Using it to decide the wrapper's next height creates a cycle: after a
      // full-document deletion the old tall viewport measures itself as tall
      // and stays that way until another editor update. CodeMirror's content
      // height comes from the measured document/height map instead, so it can
      // shrink immediately while still accounting for wrapping and widgets.
      view.requestMeasure({
        key: naturalHeightMeasureKeyRef.current,
        read(currentView) {
          return readComposerNaturalHeight(currentView)
        },
        write(height) {
          if (viewRef.current !== view || rootRef.current !== root) return
          onMeasured(height)
        },
      })
    },
    focus() { viewRef.current?.focus() },
    setSelectionRange(start: number, end = start) {
      const view = viewRef.current
      if (!view) return
      const max = view.state.doc.length
      view.dispatch({
        selection: {
          anchor: Math.max(0, Math.min(start, max)),
          head: Math.max(0, Math.min(end, max)),
        },
        scrollIntoView: true,
      })
    },
    getBoundingClientRect() {
      return rootRef.current?.getBoundingClientRect() || new DOMRect()
    },
    getAttribute(name: string) { return rootRef.current?.getAttribute(name) || null },
    isFocused() {
      const root = rootRef.current
      return !!root && !!document.activeElement && root.contains(document.activeElement)
    },
    applySnapshot(snapshot) {
      const view = viewRef.current
      const aggregate = historyExtensionRef.current
      if (!view || !aggregate) return false
      const replacement = snapshot.replacement
      if (replacement) {
        const { from, to, insert } = replacement
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)
          || from < 0 || to < from || to > view.state.doc.length || typeof insert !== 'string'
          || view.state.doc.sliceString(0, from) + insert + view.state.doc.sliceString(to) !== snapshot.value) {
          // A stale range is not permission to fall back to replacing a newer
          // author's entire draft. The host retains/reconciles its operation.
          return false
        }
      }
      const max = snapshot.value.length
      const selectionStart = Math.max(0, Math.min(snapshot.selectionStart ?? max, max))
      const selectionEnd = Math.max(0, Math.min(snapshot.selectionEnd ?? selectionStart, max))
      const historyMode = snapshot.history || 'add'
      const hasPayload = Object.prototype.hasOwnProperty.call(snapshot, 'historyPayload')
      const effects = [
        ...(historyMode === 'add' ? [aggregate.snapshotBoundary.of(true)] : []),
        ...(hasPayload ? [aggregate.setPayload.of(snapshot.historyPayload ?? null)] : []),
      ]
      view.dispatch({
        changes: replacement || { from: 0, to: view.state.doc.length, insert: snapshot.value },
        selection: EditorSelection.single(selectionStart, selectionEnd),
        effects,
        annotations: [
          ...(historyMode === 'add' ? [isolateHistory.of('full')] : []),
          ...(historyMode === 'add' ? [] : [Transaction.addToHistory.of(false)]),
          ...(historyMode === 'external' ? [externalValueSync.of(true)] : []),
        ],
        scrollIntoView: snapshot.scrollIntoView !== false,
        userEvent: snapshot.userEvent || (historyMode === 'add' ? 'input' : 'input.complete'),
      })
      return true
    },
    restoreViewState(snapshot, onApplied) {
      const view = viewRef.current
      if (!view) return
      const generation = ++viewRestoreGenerationRef.current
      const max = view.state.doc.length
      const selectionStart = Math.max(0, Math.min(snapshot.selectionStart, max))
      const selectionEnd = Math.max(0, Math.min(snapshot.selectionEnd, max))
      // Old saved views contain only a range. A complete matching pair carries
      // direction; malformed/stale additions cannot replace that legacy range.
      const { selectionAnchor, selectionHead } = snapshot
      const hasDirection = typeof selectionAnchor === 'number'
        && typeof selectionHead === 'number'
        && Number.isSafeInteger(selectionAnchor) && selectionAnchor >= 0
        && Number.isSafeInteger(selectionHead) && selectionHead >= 0
        && Math.min(selectionAnchor, selectionHead) === Math.min(snapshot.selectionStart, snapshot.selectionEnd)
        && Math.max(selectionAnchor, selectionHead) === Math.max(snapshot.selectionStart, snapshot.selectionEnd)
      const anchor = hasDirection ? Math.min(selectionAnchor, max) : selectionStart
      const head = hasDirection ? Math.min(selectionHead, max) : selectionEnd
      const requestedScrollTop = Number.isFinite(snapshot.scrollTop)
        ? Math.max(0, snapshot.scrollTop)
        : 0

      // A normal selection API asks CodeMirror to reveal the caret. That
      // measure runs after a direct scrollTop assignment and used to overwrite
      // the restored scroll with the top-of-document caret position.
      view.dispatch({
        selection: EditorSelection.single(anchor, head),
        annotations: [externalValueSync.of(true), Transaction.addToHistory.of(false)],
      })
      view.requestMeasure({
        read(currentView) {
          return Math.max(0, currentView.scrollDOM.scrollHeight - currentView.scrollDOM.clientHeight)
        },
        write(maxScrollTop) {
          if (viewRef.current !== view || viewRestoreGenerationRef.current !== generation) return
          view.scrollDOM.scrollTop = Math.min(requestedScrollTop, maxScrollTop)
          onApplied?.({
            selectionStart: view.state.selection.main.from,
            selectionEnd: view.state.selection.main.to,
            selectionAnchor: view.state.selection.main.anchor,
            selectionHead: view.state.selection.main.head,
            scrollTop: view.scrollDOM.scrollTop,
          })
        },
      })
    },
  }), [])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const tokenField = createComposerTokenField(tokenClickRef, tokenContextMenuRef, messageNavigateRef)
    const aggregateHistory = createComposerHistoryPayloadExtension<unknown>({
      initial: historyPayloadRef.current,
      textMode: historyTextMode,
      derive: (nextText, previous, transaction) => (
        deriveHistoryPayloadRef.current?.(nextText, previous, transaction) ?? previous
      ),
      equal: (left, right) => historyPayloadEqualRef.current?.(left, right) ?? Object.is(left, right),
    })
    historyExtensionRef.current = aggregateHistory
    const readOnlyCompartment = readOnlyCompartmentRef.current
    const placeholderCompartment = placeholderCompartmentRef.current
    const historyCompartment = historyCompartmentRef.current

    const emitAggregateState = (view: EditorView) => {
      const selection = view.state.selection.main
      const normalizedSelection = { start: selection.from, end: selection.to }
      onChangeRef.current(
        view.state.doc.toString(),
        normalizedSelection,
        aggregateHistory.read(view.state),
      )
      onSelectionChangeRef.current?.({ ...normalizedSelection, anchor: selection.anchor, head: selection.head })
    }

    const replayAggregateHistory = (view: EditorView, command: Command) => command({
      state: view.state,
      dispatch(transaction: Transaction) {
        const reconciliation = aggregateHistory.reconciliationFor(transaction)
        if (!reconciliation) {
          view.dispatch(transaction)
          return
        }
        aggregateHistoryReplayRef.current = true
        try {
          // CodeMirror must move its native history branch first. The mapped
          // text inverse can be incomplete after an async addToHistory=false
          // image resolution, so the saved aggregate snapshot is reconciled
          // synchronously before the browser can paint or React can observe it.
          view.dispatch(transaction)
          view.dispatch(reconciliation)
        } finally {
          aggregateHistoryReplayRef.current = false
        }
        emitAggregateState(view)
      },
    } as unknown as EditorView)

    const eventHandlers = EditorView.domEventHandlers({
      copy(event, view) {
        onCopyRef.current?.(makeEventFacade(event, view))
        return event.defaultPrevented
      },
      cut(event, view) {
        onCutRef.current?.(makeEventFacade(event, view))
        return event.defaultPrevented
      },
      paste(event, view) {
        onPasteRef.current?.(makeEventFacade(event, view))
        return event.defaultPrevented
      },
      keydown(event, view) {
        onKeyDownRef.current?.(makeEventFacade(event, view))
        return event.defaultPrevented
      },
      contextmenu(event, view) {
        onContextMenuRef.current?.(makeEventFacade(event, view))
        return event.defaultPrevented
      },
      beforeinput(event, view) {
        const inputType = (event as InputEvent).inputType
        if (inputType !== 'historyUndo' && inputType !== 'historyRedo') return false
        event.preventDefault()
        event.stopPropagation()
        return replayAggregateHistory(view, inputType === 'historyUndo' ? undo : redo)
      },
    })

    const aggregateHistoryKeymap = Prec.highest(keymap.of([
      { key: 'Mod-z', run: (view) => replayAggregateHistory(view, undo), preventDefault: true },
      { key: 'Mod-y', run: (view) => replayAggregateHistory(view, redo), preventDefault: true },
      { key: 'Mod-Shift-z', run: (view) => replayAggregateHistory(view, redo), preventDefault: true },
    ]))

    const statusTokenDeletionKeymap = Prec.high(keymap.of([{
      key: 'Alt-Backspace',
      run(view) {
        const selection = view.state.selection.main
        if (!selection.empty) return false
        const currentTokens = view.state.field(tokenField).tokens
        const range = findComposerStatusTokenBackwardDeleteRange(currentTokens, selection.head)
        if (!range) return false
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: '' },
          selection: EditorSelection.cursor(range.from),
          scrollIntoView: true,
          userEvent: 'delete.backward',
        })
        return true
      },
    }]))

    const clipboardTextPasteKeymap = Prec.highest(keymap.of([{
      key: 'Mod-v',
      run(view) {
        if (view.state.readOnly) return false
        const payload = readSynchronousComposerClipboardPayload(clipboardRef.current)
        if (shouldDeferComposerPasteToNative(payload)) return false

        const pasteEvent = makeTextPasteFacade(view, payload!.text, payload!.formats, payload!.html)
        onPasteRef.current?.(pasteEvent)
        if (!pasteEvent.defaultPrevented) {
          insertComposerClipboardText(view, payload!.text)
        }
        console.log('[ComposerEditor:Clipboard] text-paste chars=' + payload!.text.length
          + ' formats=' + (payload!.formats.join(',') || 'text/plain')
          + ' hostHandled=' + (pasteEvent.defaultPrevented ? '1' : '0'))
        return true
      },
    }]))

    const state = EditorState.create({
      doc: value,
      extensions: [
        historyCompartment.of(history()),
        drawSelection(),
        EditorView.lineWrapping,
        composerSearchExtensions,
        // Host key semantics (Enter sends, Escape closes, Shift+Cmd+V is a
        // special paste) must run before CodeMirror's default newline/indent.
        Prec.highest(eventHandlers),
        aggregateHistoryKeymap,
        clipboardTextPasteKeymap,
        statusTokenDeletionKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        readOnlyCompartment.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        placeholderCompartment.of(composerPlaceholderExtension(placeholder)),
        aggregateHistory.extension,
        tokenField,
        EditorView.updateListener.of((update) => {
          if (aggregateHistoryReplayRef.current) return
          const isExternalValueSync = update.transactions.some(
            (transaction) => transaction.annotation(externalValueSync),
          )
          const payloadChanged = !Object.is(
            aggregateHistory.read(update.startState),
            aggregateHistory.read(update.state),
          )
          if ((update.docChanged || payloadChanged)
              && !isExternalValueSync) {
            const selection = update.state.selection.main
            onChangeRef.current(update.state.doc.toString(), {
              start: selection.from,
              end: selection.to,
            }, aggregateHistory.read(update.state))
          }
          if (update.selectionSet && !isExternalValueSync) {
            const selection = update.state.selection.main
            onSelectionChangeRef.current?.({
              start: selection.from, end: selection.to, anchor: selection.anchor, head: selection.head,
            })
          }
        }),
        composerTheme,
      ],
    })
    const view = new EditorView({ state, parent: root })
    viewRef.current = view
    appliedReadOnlyRef.current = { view, value: readOnly }
    appliedPlaceholderRef.current = { view, value: placeholder }
    const handleScroll = () => {
      if (historyOwnerTransitionRef.current) return
      onScrollChangeRef.current?.(view.scrollDOM.scrollTop)
    }
    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })
    view.dispatch({ effects: setTokensEffect.of(tokens) })
    if (autoFocus) requestAnimationFrame(() => view.focus())

    return () => {
      viewRestoreGenerationRef.current += 1
      view.scrollDOM.removeEventListener('scroll', handleScroll)
      viewRef.current = null
      appliedReadOnlyRef.current = null
      appliedPlaceholderRef.current = null
      historyExtensionRef.current = null
      view.destroy()
    }
    // The live callbacks, value, tokens and compartments update below without
    // destroying CM's undo stack or selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    const view = viewRef.current
    const aggregate = historyExtensionRef.current
    if (!view || !aggregate) return
    const nextPayload = historyPayload ?? null
    const currentPayload = aggregate.read(view.state)
    const payloadIsEqual = historyPayloadEqualRef.current?.(currentPayload, nextPayload)
      ?? Object.is(currentPayload, nextPayload)
    if (view.state.doc.toString() === value && payloadIsEqual) return
    const previous = view.state.selection.main
    const max = value.length
    view.dispatch({
      changes: view.state.doc.toString() === value
        ? undefined
        : { from: 0, to: view.state.doc.length, insert: value },
      selection: {
        anchor: Math.min(previous.anchor, max),
        head: Math.min(previous.head, max),
      },
      effects: payloadIsEqual ? undefined : aggregate.setPayload.of(nextPayload),
      annotations: [externalValueSync.of(true), Transaction.addToHistory.of(false)],
    })
  }, [historyPayload, value])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || historyOwnerKeyRef.current === historyOwnerKey) return
    historyOwnerKeyRef.current = historyOwnerKey
    // Removing and immediately re-adding the history StateField gives the new
    // owner an empty branch without recreating the EditorView or losing DOM.
    view.dispatch({
      effects: historyCompartmentRef.current.reconfigure([]),
      annotations: Transaction.addToHistory.of(false),
    })
    view.dispatch({
      effects: historyCompartmentRef.current.reconfigure(history()),
      annotations: Transaction.addToHistory.of(false),
    })
    const frame = requestAnimationFrame(() => {
      if (historyOwnerKeyRef.current === historyOwnerKey) {
        historyOwnerTransitionRef.current = false
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [historyOwnerKey])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setTokensEffect.of(tokens) })
  }, [tokens])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const applied = appliedReadOnlyRef.current
    // The constructor installed both facets. A real prop change, even before
    // this first passive effect, must still update the existing editor.
    if (applied?.view === view && applied.value === readOnly) return
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    })
    appliedReadOnlyRef.current = { view, value: readOnly }
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const applied = appliedPlaceholderRef.current
    // The constructor already installed this value. Keep actual prop changes,
    // including one before the first passive effect, on the existing path.
    if (applied?.view === view && applied.value === placeholder) return
    view.dispatch({
      effects: placeholderCompartmentRef.current.reconfigure(composerPlaceholderExtension(placeholder)),
    })
    appliedPlaceholderRef.current = { view, value: placeholder }
  }, [placeholder])

  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => viewRef.current?.focus())
  }, [autoFocus])

  return (
    <div
      {...domProps}
      ref={rootRef}
      className={['gt-composer-editor', className].filter(Boolean).join(' ')}
      style={{
        ...style,
        '--composer-editor-font-size': `${fontSize}px`,
      } as React.CSSProperties}
    />
  )
})
