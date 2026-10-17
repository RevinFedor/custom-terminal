import React, { useEffect, useRef, useMemo } from 'react'
import {
  EditorView,
  keymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection
} from '@codemirror/view'
import { EditorState, Prec, EditorSelection, Transaction, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, redo, addCursorAbove, addCursorBelow, copyLineUp, copyLineDown } from '@codemirror/commands'
import { highlightSelectionMatches, selectNextOccurrence, selectSelectionMatches } from '@codemirror/search'
import { foldKeymap, codeFolding, indentUnit, foldedRanges, foldEffect, foldable } from '@codemirror/language'
// One-time cleanup of legacy localStorage cache. The fold snapshot layer
// (`md-editor-fold:*`) is gone — text-marker `^^` is the single source of
// truth, restored at mount by collapsibleArrowPlugin. Drop the stale keys
// once per browser so they don't sit around forever.
if (typeof localStorage !== 'undefined' && !localStorage.getItem('md-editor-fold-cleanup-v1')) {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i)
    if (k && k.startsWith('md-editor-fold:')) localStorage.removeItem(k)
  }
  localStorage.setItem('md-editor-fold-cleanup-v1', '1')
}

import { createDarkTheme } from './theme'
import { terminalMessageReferences } from './plugins/terminalMessageReference'
import { resolveClipboardAdapter } from './plugins/clipboardAdapter'
import {
  collapsibleFoldService,
  collapsibleGutter,
  collapsibleTitleClick,
  collapsibleArrowPlugin,
  createCollapsibleArrowClickHandler,
  createCollapsibleEnterHandler,
  createCollapsibleFoldParentHandler,
  createCollapsibleBackspaceHandler,
  createCollapsibleArrowDownHandler,
  createCollapsibleHoverPreview,
  collapsibleFoldHistorySupport,
  foldBoundaryAssocFix,
  collapsibleScopePlugin,
  fullLineSelectionPlugin,
  createMarkdownSyntaxPlugin,
  createImageField,
  createTableField,
  createImageDeleteHandler,
  createClipboardKeymap,
  createWrapSelectionHandler,
  createImagePasteHandler,
  createContextMenuHandler,
  showCommandPalette,
  hideCommandPalette,
  selectionTrackerPlugin,
  wrapSelection,
  stableWordSelection,
  hangingIndentPlugin,
  createLineNumbersWithVirtual,
  toggleLinePrefix,
  createIncludeLinkPlugin,
  createIncludeLinkClickHandler,
  createEmbeddingLinkPlugin,
  createLinkProtocolPlugin,
  createAtTriggerMenuPlugin,
  lineBackgroundExtension,
  applyLineBackground,
  serializeLineBackgrounds,
  loadLineBackgrounds,
  setLineBackgroundPalette,
  getActiveLineBackground,
  changeLineBgEffect,
  type LineBgEntry,
  type SerializedLineBackgrounds,
  createFrontmatterProtocolPlugin,
  createLinkIconPlugin,
  createAnchorLinkPlugin,
  createAnchorLinkClickHandler,
  createAnchorAutocompletion,
  type DomainRule,
  type AnchorIndex,
  tabStopIndent,
  blockIndent,
  blockOutdent,
  moveBlockUp,
  moveBlockDown,
  type IncludeOffset,
  aiPasteTrackerPlugin,
  createConcealClickFix,
  createEmojiHoverTooltip,
  createCustomEmojiPlugin,
  cursorOutOfFoldPlugin,
  type ClipboardAdapter
} from './plugins'

import './styles/editor.css'

export interface MarkdownEditorProps {
  /** Markdown content */
  content: string
  /** Called when content changes */
  onChange: (content: string) => void

  /** Font size in pixels (default: 14) */
  fontSize?: number
  /** Enable word wrap (default: true) */
  wordWrap?: boolean

  /** Called when user pastes an image. Should return the path to save or null to cancel */
  onImagePaste?: (base64: string) => Promise<string | null>
  /** Transform image src before loading (e.g., add protocol) */
  resolveImageUrl?: (src: string) => string

  /** Callback to receive the EditorView instance */
  onEditorView?: (view: EditorView | null) => void

  /** Initial scroll position */
  initialScrollTop?: number

  /** Resolve include path to file content (for "Copy with includes" feature) */
  resolveInclude?: (relativePath: string) => Promise<string>

  /** Called when user clicks "open file" on an include link */
  onOpenInclude?: (relativePath: string) => void

  /** Count files in a path for @embedding tooltip */
  onCountEmbeddingFiles?: (absolutePath: string) => Promise<number>

  /** Resolve a relative @include path to absolute (for RMB → Open in Finder / Copy Path). */
  resolveIncludeAbsolute?: (relativePath: string) => string | null

  /** Open a file in a new tab. Used by @link / @include / @embedding RMB → Open. */
  onOpenAbsoluteFile?: (absolutePath: string) => void

  /** Reveal a file in Finder (shell.showItemInFolder). */
  onRevealInFinder?: (absolutePath: string) => void

  /** Copy a file path to clipboard. */
  onCopyAbsolutePath?: (absolutePath: string) => void

  /** Pick a file via native dialog. Used by `@` palette → Link item. */
  onPickFileForLink?: () => Promise<string | null>

  /** Palette of named line-background colors (from settings) for the Background menu. */
  lineBackgroundPalette?: LineBgEntry[]
  /** Initial line/range backgrounds for this file. Legacy shape: { lineNumber: bgId }. */
  initialLineBackgrounds?: SerializedLineBackgrounds
  /** Called (debounced) when the line/range background metadata changes. */
  onLineBackgroundsChange?: (map: SerializedLineBackgrounds) => void

  /**
   * Check whether an absolute path exists on disk. Used by file-pointing
   * widgets (@link / @include / @embedding) to flip to "not found" state
   * (yellow ⚠) when the target has been moved/deleted.
   */
  checkFileExists?: (absolutePath: string) => Promise<boolean>

  /** Called when editor loses focus (for auto-save) */
  onBlur?: () => void

  /** Show line numbers gutter (default: true) */
  showLineNumbers?: boolean

  /** Disable overscroll padding (default: false). Use for compact/sidebar editors */
  compact?: boolean

  /** Read-only mode — not editable but widgets (collapsible, links) stay interactive (default: false) */
  readOnly?: boolean

  /** Horizontal content padding in pixels (default: 16) */
  contentPaddingX?: number

  /** Vertical content padding in pixels (default: 16) */
  contentPaddingY?: number

  /** Line offsets for virtual line numbers (transclusion support) */
  includeOffsets?: IncludeOffset[]

  /** Called to generate AI title for Shift+Cmd+V paste */
  onGenerateTitle?: (text: string) => Promise<string>

  /** Emoji shortcuts for context menu quick-insert */
  emojiShortcuts?: {emoji: string, name: string, description?: string}[]

  /** Called when user Cmd+Clicks a URL. Opens in system browser. */
  onOpenUrl?: (url: string) => void
  /** Explicit Cmd+click on an immutable Noted message snapshot. */
  onMessageReferenceNavigate?: (snapshot: any) => void | Promise<unknown>

  /** Cmd+] toggle Outline-панели. Перехватывается ВНУТРИ редактора (Prec.highest),
      иначе defaultKeymap отрабатывает Mod-] как indentMore и сдвигает строку.
      dir: 'right' для Cmd+] (toggle), 'left' для Cmd+[ (зарезервировано). */
  onToggleOutline?: (dir: 'right' | 'left') => void

  /** Domain → icon mapping for link favicons */
  domainIcons?: DomainRule[]

  /** Resolve [text](./relative.md#frag) → absolute path on disk. Return null to mark as broken. */
  resolveAnchorFile?: (relativePath: string) => string | null
  /** Read anchor index for a file (cross-file anchor support). Return null on error/missing. */
  getCrossFileAnchors?: (absolutePath: string) => Promise<AnchorIndex | null>
  /** Cmd+Click on an anchor link.
   *   - Same-file: path=null, line=target line in current file.
   *   - Cross-file: path=absolute path, line=target line (or null if unresolved). */
  onNavigateAnchor?: (path: string | null, line: number | null) => void

  /**
   * Injectable clipboard transport for copy/cut/paste. When omitted, the editor
   * uses `navigator.clipboard` (correct for web). In an Electron renderer
   * navigator.clipboard is dead — the host must inject an adapter backed by
   * Electron's `clipboard` module so Cmd+C/X/V and AI-paste actually work.
   * Omit `readItems` to delegate image paste to the DOM handler. See
   * clipboardAdapter.ts.
   */
  clipboard?: ClipboardAdapter
}

// Stable empty array to avoid recreating editor on every render
const EMPTY_OFFSETS: IncludeOffset[] = []

export function MarkdownEditor({
  content,
  onChange,
  fontSize = 14,
  wordWrap = true,
  onImagePaste,
  resolveImageUrl,
  onEditorView,
  initialScrollTop = 0,
  resolveInclude,
  onOpenInclude,
  onCountEmbeddingFiles,
  resolveIncludeAbsolute,
  onOpenAbsoluteFile,
  onRevealInFinder,
  onCopyAbsolutePath,
  onPickFileForLink,
  checkFileExists,
  lineBackgroundPalette,
  initialLineBackgrounds,
  onLineBackgroundsChange,
  onBlur,
  showLineNumbers = true,
  compact = false,
  readOnly = false,
  contentPaddingX = 16,
  contentPaddingY = 16,
  includeOffsets,
  onGenerateTitle,
  emojiShortcuts,
  onOpenUrl,
  onMessageReferenceNavigate,
  onToggleOutline,
  domainIcons,
  resolveAnchorFile,
  getCrossFileAnchors,
  onNavigateAnchor,
  clipboard
}: MarkdownEditorProps) {
  // Use stable reference for includeOffsets to prevent editor recreation
  // Stabilize includeOffsets BY VALUE so an external file change does not
  // remount the editor (which would wipe CM6 undo history).
  //
  // calculateIncludeOffsets() returns a FRESH array on every call — including a
  // brand-new empty [] for files without includes. includeOffsets is a dep of
  // the EditorView-creation effect, so a new reference tears the view down
  // (view.destroy) and rebuilds it from scratch, discarding the undo stack.
  // That made AI-agent edits un-undoable: the agent writes the file on disk →
  // FileWatcher fs-change → App recomputes includeOffsets (new array) →
  // MarkdownEditor remounts → the just-applied edit has no history entry, so
  // Cmd+Z does nothing. Memoizing by serialized value keeps the reference
  // stable when offsets are unchanged → no remount → the external-content-sync
  // dispatch below lands in history → Cmd+Z / Cmd+Y work like a normal edit.
  // (When offsets genuinely change — a transclusion block grew/shrank — the key
  // changes and a remount is acceptable; that is a rare structural change.)
  const includeOffsetsKey = JSON.stringify(includeOffsets ?? [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableIncludeOffsets = useMemo(() => includeOffsets ?? EMPTY_OFFSETS, [includeOffsetsKey])
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useMemo(() => new Compartment(), [])
  const appliedThemeRef = useRef<{ view: EditorView; fontSize: number; x: number; y: number } | null>(null)

  // Store callbacks in refs to avoid recreating editor on every render
  const onChangeRef = useRef(onChange)
  const onImagePasteRef = useRef(onImagePaste)
  const resolveImageUrlRef = useRef(resolveImageUrl)
  const onEditorViewRef = useRef(onEditorView)
  const resolveIncludeRef = useRef(resolveInclude)
  const onOpenIncludeRef = useRef(onOpenInclude)
  const onCountEmbeddingFilesRef = useRef(onCountEmbeddingFiles)
  const resolveIncludeAbsoluteRef = useRef(resolveIncludeAbsolute)
  const onOpenAbsoluteFileRef = useRef(onOpenAbsoluteFile)
  const onRevealInFinderRef = useRef(onRevealInFinder)
  const onCopyAbsolutePathRef = useRef(onCopyAbsolutePath)
  const onPickFileForLinkRef = useRef(onPickFileForLink)
  const checkFileExistsRef = useRef(checkFileExists)
  const lineBgPaletteRef = useRef(lineBackgroundPalette ?? [])
  const initialLineBgRef = useRef(initialLineBackgrounds)
  const onLineBackgroundsChangeRef = useRef(onLineBackgroundsChange)
  const onBlurRef = useRef(onBlur)
  const onGenerateTitleRef = useRef(onGenerateTitle)
  const emojiShortcutsRef = useRef(emojiShortcuts)
  const onOpenUrlRef = useRef(onOpenUrl)
  const onMessageReferenceNavigateRef = useRef(onMessageReferenceNavigate)
  onMessageReferenceNavigateRef.current = onMessageReferenceNavigate
  const onToggleOutlineRef = useRef(onToggleOutline)
  const initialScrollTopRef = useRef(initialScrollTop)
  const domainIconsRef = useRef(domainIcons ?? [])
  const resolveAnchorFileRef = useRef(resolveAnchorFile)
  const getCrossFileAnchorsRef = useRef(getCrossFileAnchors)
  const onNavigateAnchorRef = useRef(onNavigateAnchor)
  const clipboardRef = useRef(clipboard)

  // Update refs when props change
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onImagePasteRef.current = onImagePaste
  }, [onImagePaste])

  useEffect(() => {
    resolveImageUrlRef.current = resolveImageUrl
  }, [resolveImageUrl])

  useEffect(() => {
    onEditorViewRef.current = onEditorView
  }, [onEditorView])

  useEffect(() => {
    resolveIncludeRef.current = resolveInclude
  }, [resolveInclude])

  useEffect(() => {
    onOpenIncludeRef.current = onOpenInclude
  }, [onOpenInclude])

  useEffect(() => {
    onCountEmbeddingFilesRef.current = onCountEmbeddingFiles
  }, [onCountEmbeddingFiles])

  useEffect(() => { resolveIncludeAbsoluteRef.current = resolveIncludeAbsolute }, [resolveIncludeAbsolute])
  useEffect(() => { onOpenAbsoluteFileRef.current = onOpenAbsoluteFile }, [onOpenAbsoluteFile])
  useEffect(() => { onRevealInFinderRef.current = onRevealInFinder }, [onRevealInFinder])
  useEffect(() => { onCopyAbsolutePathRef.current = onCopyAbsolutePath }, [onCopyAbsolutePath])
  useEffect(() => { onPickFileForLinkRef.current = onPickFileForLink }, [onPickFileForLink])
  useEffect(() => { checkFileExistsRef.current = checkFileExists }, [checkFileExists])
  useEffect(() => { onLineBackgroundsChangeRef.current = onLineBackgroundsChange }, [onLineBackgroundsChange])
  // Push the line-background palette into the running editor when it changes.
  useEffect(() => {
    lineBgPaletteRef.current = lineBackgroundPalette ?? []
    if (viewRef.current) setLineBackgroundPalette(viewRef.current, lineBgPaletteRef.current as any)
  }, [lineBackgroundPalette])

  useEffect(() => {
    onBlurRef.current = onBlur
  }, [onBlur])

  useEffect(() => {
    onGenerateTitleRef.current = onGenerateTitle
  }, [onGenerateTitle])

  useEffect(() => {
    clipboardRef.current = clipboard
  }, [clipboard])

  useEffect(() => {
    emojiShortcutsRef.current = emojiShortcuts
  }, [emojiShortcuts])

  useEffect(() => {
    onOpenUrlRef.current = onOpenUrl
  }, [onOpenUrl])

  useEffect(() => {
    onToggleOutlineRef.current = onToggleOutline
  }, [onToggleOutline])

  useEffect(() => {
    initialScrollTopRef.current = initialScrollTop
  }, [initialScrollTop])

  useEffect(() => {
    domainIconsRef.current = domainIcons ?? []
    // Force redecorate by dispatching empty transaction
    if (viewRef.current) {
      viewRef.current.dispatch({})
    }
  }, [domainIcons])

  useEffect(() => {
    resolveAnchorFileRef.current = resolveAnchorFile
  }, [resolveAnchorFile])

  useEffect(() => {
    getCrossFileAnchorsRef.current = getCrossFileAnchors
  }, [getCrossFileAnchors])

  useEffect(() => {
    onNavigateAnchorRef.current = onNavigateAnchor
  }, [onNavigateAnchor])

  useEffect(() => {
    if (!editorRef.current) return

    const vscodeKeymap = [
      { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
      { key: 'Mod-Shift-l', run: selectSelectionMatches, preventDefault: true },
      // Multi-cursor: Ctrl+Shift+Up/Down (VS Code style)
      { key: 'Ctrl-Shift-ArrowUp', run: addCursorAbove, preventDefault: true },
      { key: 'Ctrl-Shift-ArrowDown', run: addCursorBelow, preventDefault: true },
      // Also Cmd+Alt+Up/Down (default CodeMirror binding)
      { key: 'Mod-Alt-ArrowUp', run: addCursorAbove, preventDefault: true },
      { key: 'Mod-Alt-ArrowDown', run: addCursorBelow, preventDefault: true },
      // Move block up/down: Cmd+Up/Down (block-aware, moves line + deeper children)
      { key: 'Mod-ArrowUp', run: moveBlockUp, preventDefault: true },
      { key: 'Mod-ArrowDown', run: moveBlockDown, preventDefault: true },
      // Copy line up/down: Alt+Shift+Up/Down (VS Code style)
      { key: 'Alt-Shift-ArrowUp', run: copyLineUp, preventDefault: true },
      { key: 'Alt-Shift-ArrowDown', run: copyLineDown, preventDefault: true },
      // Block-aware indent/outdent: Cmd+Shift+]/[ (line + deeper children).
      // Cmd+]/[ намеренно НЕ заняты здесь — отданы под toggle Outline-панели на
      // уровне приложения (App.jsx / ProjectApp.jsx). Раньше блочный indent висел
      // на Cmd+], и нажатие в редакторе одновременно сдвигало строку И открывало
      // outline. Блочный indent также доступен через Tab/Shift-Tab на строке с
      // >>/^^ (tabIndent.ts), так что это не единственный путь к нему.
      { key: 'Mod-Shift-]', run: blockIndent, preventDefault: true },
      { key: 'Mod-Shift-[', run: blockOutdent, preventDefault: true }
    ]

    // URL regex for Cmd+Click — matches http(s), t.me, and other common patterns
    const urlAtPosRegex = /(?:https?:\/\/[^\s)`\]>]+|(?:t\.me|github\.com|docs\.google\.com)\/[^\s)`\]>]+)/g
    const markdownLinkAtPosRegex = /\[([^\]]+)\]\(([^)]+)\)/g

    // DOM event handlers: blur for auto-save, focus/blur logging, mousedown diagnostics
    const domHandlers = EditorView.domEventHandlers({
      mousedown(event, view) {
        // Cmd+Click → open URL in system browser
        if ((event.metaKey || event.ctrlKey) && event.button === 0 && onOpenUrlRef.current) {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos !== null) {
            const line = view.state.doc.lineAt(pos)
            const lineText = line.text
            // The visible label and the (usually concealed) destination occupy
            // different document ranges. Resolve the whole Markdown token
            // before falling back to a bare URL at the clicked position.
            markdownLinkAtPosRegex.lastIndex = 0
            let linkMatch
            while ((linkMatch = markdownLinkAtPosRegex.exec(lineText)) !== null) {
              if (lineText[linkMatch.index - 1] === '!') continue
              const from = line.from + linkMatch.index
              const to = from + linkMatch[0].length
              if (pos < from || pos >= to) continue
              const destination = linkMatch[2].trim().replace(/^<(.+)>$/, '$1')
              urlAtPosRegex.lastIndex = 0
              const urlMatch = urlAtPosRegex.exec(destination)
              // Keep relative-file and same-file anchor navigation with its
              // own handler, even when the label itself looks like a URL.
              if (urlMatch?.index !== 0) return false
              const url = urlMatch[0].startsWith('http') ? urlMatch[0] : 'https://' + urlMatch[0]
              event.preventDefault()
              event.stopPropagation()
              onOpenUrlRef.current(url)
              return true
            }
            urlAtPosRegex.lastIndex = 0
            let match
            while ((match = urlAtPosRegex.exec(lineText)) !== null) {
              const from = line.from + match.index
              const to = from + match[0].length
              if (pos >= from && pos <= to) {
                let url = match[0]
                if (!url.startsWith('http')) url = 'https://' + url
                event.preventDefault()
                event.stopPropagation()
                onOpenUrlRef.current(url)
                return true
              }
            }
          }
        }

        const diag = (window as any).__foldDiag || {}
        if (diag.pendingFold > 0 || diag.pendingUnfold > 0) {
          const folds: { from: number; to: number }[] = []
          foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
            folds.push({ from, to })
          })
          console.warn('[Fold:mousedown] PENDING OPS AT CLICK', {
            x: event.clientX, y: event.clientY,
            folds: folds.length,
            foldRanges: folds.slice(0, 5),
            pending: { ...diag },
            docLen: view.state.doc.length
          })
        }
      },
      blur(event, view) {
        console.log('[Editor] blur', { scrollTop: view.scrollDOM.scrollTop })
        onBlurRef.current?.()
      },
      focus(event, view) {
        console.log('[Editor] focus', { scrollTop: view.scrollDOM.scrollTop })
      }
    })

    // Cmd+. для fold/unfold nearest parent collapsible section
    const collapsibleFoldKeymap = createCollapsibleFoldParentHandler()

    // Cmd+^ для toggle >> prefix на текущей строке
    const collapsibleToggleKeymap = Prec.high(keymap.of([
      {
        key: 'Mod-^',
        run: (view: EditorView) => {
          toggleLinePrefix(view, '>> ')
          return true
        }
      }
    ]))

    // Cmd+/ для command palette (toggle)
    // IMPORTANT: capture selection BEFORE CM keymap processing may collapse it
    const commandPaletteKeymap = Prec.highest(EditorView.domEventHandlers({
      keydown(event, view) {
        const isMod = event.metaKey || event.ctrlKey
        if (!isMod || event.key !== '/') return false

        event.preventDefault()
        event.stopPropagation()

        const sel = view.state.selection

        const existing = document.querySelector('[data-command-palette]')
        if (existing) {
          hideCommandPalette()
          view.focus()
          return true
        }
        showCommandPalette(view, sel)
        return true
      }
    }))

    // Cmd+8 — wrap with * (additive, pressing again adds more stars)
    const starWrapHandler = Prec.highest(EditorView.domEventHandlers({
      keydown(event, view) {
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && (event.key === '8' || event.code === 'Digit8')) {
          event.preventDefault()
          // Collapse selection to cursor so wrapSelection uses full-line mode
          // This prevents unwrap: existing *markers* end up INSIDE selectedText
          const cursor = view.state.selection.main.head
          view.dispatch({ selection: { anchor: cursor } })
          wrapSelection(view, '*')
          return true
        }
        return false
      }
    }))

    // Cmd+Shift+D — duplicate line down (Sublime Text style).
    // Use event.code (physical key) so the binding works on any keyboard layout
    // (RU, EN, etc) — same pattern as Cmd+8 above.
    const duplicateLineHandler = Prec.highest(EditorView.domEventHandlers({
      keydown(event, view) {
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyD') {
          event.preventDefault()
          copyLineDown(view)
          return true
        }
        return false
      }
    }))

    // Cmd+] toggle Outline-панели. ОБЯЗАН перехватываться здесь (Prec.highest),
    // а не на уровне window: defaultKeymap биндит Mod-] → indentMore (CodeMirror
    // core), оно отрабатывало РАНЬШE window-listener'а и сдвигало строку вместо
    // открытия панели. event.code (BracketRight) — layout-independent (на RU
    // event.key===']' это 'ъ').
    // ТОЛЬКО Cmd+] (не Cmd+[): Cmd+[ остаётся за indentLess/blockOutdent.
    // Cmd+Shift+] — blockIndent (намеренно не трогаем).
    const outlineToggleHandler = Prec.highest(EditorView.domEventHandlers({
      keydown(event) {
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
            && event.code === 'BracketRight') {
          if (!onToggleOutlineRef.current) return false
          event.preventDefault()
          event.stopPropagation()
          onToggleOutlineRef.current('right')
          return true
        }
        return false
      }
    }))

    const extensions = [
      // Track selection for Cmd+/ palette (before any handlers)
      selectionTrackerPlugin,
      // External URLs must win over the local-anchor handler for https://…#….
      // Other clicks still fall through to normal editing/navigation.
      Prec.highest(domHandlers),
      // Cmd+. fold/unfold parent, Cmd+^ toggle prefix
      collapsibleFoldKeymap,
      collapsibleToggleKeymap,
      // Cmd+/ для command palette
      commandPaletteKeymap,
      // Cmd+* для wrap with stars
      starWrapHandler,
      // Cmd+Shift+D — duplicate line (works on any keyboard layout via event.code)
      duplicateLineHandler,
      // Cmd+] toggle Outline (перехват до defaultKeymap indentMore)
      outlineToggleHandler,
      history(),
      // Re-emit foldEffect on undo when the deleted range contained folded blocks.
      // Without this, Cmd+X on a folded ^^ → Cmd+Z restores text but loses fold;
      // autoFoldCollapsedMarkers re-folds via setTimeout(0) → 1-frame flash of
      // expanded body. See collapsibleArrow.ts for full reasoning.
      collapsibleFoldHistorySupport,
      // Pattern B (transactionFilter) — guarantees the blinking caret stays
      // visible when its position lands on `fold.from` (start of a
      // Decoration.replace widget). Catches click, keyboard, paste, undo —
      // every entry point — and biases empty-range assoc to -1. Without this
      // CM6's default cursor-renderer probes the RIGHT side of fold.from,
      // hits the hidden widget (display:none placeholderDOM), gets null
      // from coordsAtPos, and never appends the cursor DOM node. See
      // collapsibleArrow.ts::foldBoundaryAssocFix for full reasoning.
      foldBoundaryAssocFix,
      // Enable multiple cursors (Cmd+Click, Ctrl+Shift+Up/Down)
      EditorState.allowMultipleSelections.of(true),
      // Draw cursors and selections (required for multi-cursor visibility)
      drawSelection(),
      // 4 spaces for indent
      indentUnit.of('    '),
      // Clipboard keymap BEFORE defaultKeymap to intercept Mod-c/v/x
      createClipboardKeymap({
        onImagePaste: (base64) => onImagePasteRef.current?.(base64) ?? Promise.resolve(null),
        onGenerateTitle: (text) => onGenerateTitleRef.current ? onGenerateTitleRef.current(text) : Promise.resolve('paste text'),
        clipboard: clipboardRef.current ?? undefined
      }),
      terminalMessageReferences(() => ({
        clipboard: resolveClipboardAdapter(clipboardRef.current),
        navigate: onMessageReferenceNavigateRef.current,
      })),
      // Track cursor movement for AI Paste indicator
      aiPasteTrackerPlugin,
      // Tab/Shift+Tab with VS Code-style tab stop snapping
      keymap.of([tabStopIndent, ...foldKeymap, ...vscodeKeymap, ...defaultKeymap, ...historyKeymap, { key: 'Mod-y', run: redo, preventDefault: true }]),
      themeCompartment.of(createDarkTheme(fontSize, contentPaddingX, contentPaddingY)),
      // Collapsible sections & Highlighting
      collapsibleFoldService,
      // Клик по ТЕКСТУ заголовка collapsible → toggle fold (без установки
      // каретки/выделения). Клик слева от названия или правее ВИДИМОГО конца
      // текста → обычный CM6-клик (каретка/selection). Если каретка уже на
      // строке — обычная правка.
      // → plugins/headerClick.ts. Pointer-курсор-аффорданс чисто CSS:
      // .cm-collapsible-title-text; activeLine возвращает text cursor.
      collapsibleTitleClick,
      codeFolding({
        placeholderDOM: () => {
          const span = document.createElement('span')
          span.style.display = 'none'
          return span
        }
      }),
      // collapsibleGutter убран — используем inline стрелки вместо gutter
      // Inline стрелки с учётом отступа
      collapsibleArrowPlugin,
      createCollapsibleArrowClickHandler(),
      // Enter at end of folded section → insert after fold
      createCollapsibleEnterHandler(),
      // Backspace at line start after folded section → move to header end
      createCollapsibleBackspaceHandler(),
      // ArrowDown above folded section → land on the header line, not past the fold
      createCollapsibleArrowDownHandler(),
      // Cmd+hover on folded ^^ header → preview body in portal popover (Cmd+Shift to pin)
      createCollapsibleHoverPreview(),
      // Цветные indent guides для collapsible секций
      collapsibleScopePlugin,
      // Selection на всю ширину строки
      fullLineSelectionPlugin,
      createMarkdownSyntaxPlugin({
        resolveImageUrl: (src) => resolveImageUrlRef.current?.(src) ?? src
      }),
      // Fix: click at visual line end with hidden markup → snap to actual line.to
      createConcealClickFix(),
      // Fix: cursor lands inside fold (Decoration.replace inclusive) → invisible.
      // Push it out to a visible position after click.
      cursorOutOfFoldPlugin,
      createTableField({
        onOpenUrl: (url) => onOpenUrlRef.current?.(url),
        clipboard: clipboardRef.current ?? undefined,
        resolveImageUrl: (src) => resolveImageUrlRef.current?.(src) ?? src,
        resolveCrossFilePath: (rel) => resolveAnchorFileRef.current?.(rel) ?? null,
        getCrossFileAnchors: (abs) => getCrossFileAnchorsRef.current?.(abs) ?? Promise.resolve(null),
        onNavigate: (path, line) => onNavigateAnchorRef.current?.(path, line),
      }),
      // StateField for images (supports block widgets)
      createImageField({
        resolveImageUrl: (src) => resolveImageUrlRef.current?.(src) ?? src,
        clipboard: clipboardRef.current ?? undefined
      }),
      // Option/Alt+Backspace deletes a whole ![...](...) token when the cursor
      // sits right after its closing `)`. Prec.high → above defaultKeymap.
      createImageDeleteHandler(),
      ...(showLineNumbers ? [createLineNumbersWithVirtual(stableIncludeOffsets), highlightActiveLineGutter()] : []),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          // Skip onChange echo when the change came from our External-content-sync
          // useEffect — otherwise a parent state update → sync dispatch → onChange
          // → parent state update loop crashes CodeMirror with "Position N out of
          // range" because mid-loop the sibling editor instance dispatches
          // replaceAll based on stale content.
          const isExternalSync = update.transactions.some(tr => tr.annotation(Transaction.userEvent) === 'external-sync')
          if (!isExternalSync) {
            onChangeRef.current(update.state.doc.toString())
          }
        }
        // Persist per-line backgrounds whenever they change — direct apply, remap
        // on edit, OR undo/redo (which re-dispatches changeLineBgEffect). Cheap
        // serialize; host debounces the actual write.
        if (onLineBackgroundsChangeRef.current) {
          const touchedBg = update.docChanged ||
            update.transactions.some(tr => tr.effects.some(e => e.is(changeLineBgEffect)))
          if (touchedBg) {
            try {
              onLineBackgroundsChangeRef.current(serializeLineBackgrounds(update.view))
            } catch {}
          }
        }
        // Diagnostic: when selection lands on a fold boundary the blinking
        // caret can disappear (codeFolding uses Decoration.replace and even a
        // bias-mapped position can be considered "inside" the inclusive zone).
        // Log every selection move with userEvent + cursor-in-fold flag so the
        // disappearing-caret bug can be debugged from dev.log without guessing.
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main
          if (sel.empty) {
            let inFold: { from: number; to: number } | null = null
            let boundarySide: 'from' | 'to' | null = null
            try {
              foldedRanges(update.state).between(sel.head, sel.head, (f, t) => {
                if (sel.head >= f && sel.head <= t) inFold = { from: f, to: t }
                if (sel.head === f) boundarySide = 'from'
                else if (sel.head === t) boundarySide = 'to'
              })
            } catch {}
            const ev = update.transactions
              .map(tr => tr.annotation(Transaction.userEvent))
              .filter(Boolean)
              .join(',') || '(none)'
            if (inFold) {
              console.warn('[Cursor:InFold] selection inside fold range',
                { head: sel.head, assoc: (sel as any).assoc, fold: inFold,
                  boundarySide, userEvent: ev, docChanged: update.docChanged })
            }
            // Final-state check: after ALL filters + extensions applied,
            // count the actual cursor DOM nodes. If selection is on a fold
            // boundary and DOM cursor is missing → renderer rejected the
            // current assoc.
            if (boundarySide) {
              setTimeout(() => {
                try {
                  const count = document.querySelectorAll('.cm-cursorLayer .cm-cursor').length
                  console.log('[Cursor:FinalDOM] post-update on fold boundary',
                    { head: sel.head, assoc: (sel as any).assoc,
                      boundarySide, cursorCountInDOM: count,
                      userEvent: ev, docChanged: update.docChanged })
                } catch {}
              }, 0)
            }
          }
        }
      }),
      ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      ...(compact ? [] : [EditorView.contentAttributes.of({ style: 'padding-bottom: calc(100vh - 80px)' })]),
      // Wrap selected text when typing * ` _ etc.
      createWrapSelectionHandler(),
      // Image paste handler
      createImagePasteHandler({
        onImagePaste: (base64) => {
          // console.log('[Editor] onImagePaste wrapper called, ref exists:', !!onImagePasteRef.current)
          return onImagePasteRef.current?.(base64) ?? Promise.resolve(null)
        }
      }),
      // Include links (file transclusion)
      createIncludeLinkPlugin({
        onOpenFile: (path) => onOpenIncludeRef.current?.(path),
        resolveAbsolute: (rel) => resolveIncludeAbsoluteRef.current?.(rel) ?? null,
        onReveal: (abs) => onRevealInFinderRef.current?.(abs),
        onCopyPath: (abs) => onCopyAbsolutePathRef.current?.(abs),
        checkExists: (abs) => checkFileExistsRef.current?.(abs) ?? Promise.resolve(true),
      }),
      // Cmd+Click handler for include links
      createIncludeLinkClickHandler({
        onOpenFile: (path) => onOpenIncludeRef.current?.(path)
      }),
      // Embedding links (GraphRAG sources)
      createEmbeddingLinkPlugin({
        onCountFiles: (path) => onCountEmbeddingFilesRef.current?.(path) ?? Promise.resolve(0),
        onOpen: (abs) => onOpenAbsoluteFileRef.current?.(abs),
        onReveal: (abs) => onRevealInFinderRef.current?.(abs),
        onCopyPath: (abs) => onCopyAbsolutePathRef.current?.(abs),
        checkExists: (abs) => checkFileExistsRef.current?.(abs) ?? Promise.resolve(true),
      }),
      // @link — simple file pointer (green pilule)
      createLinkProtocolPlugin({
        onOpen: (abs) => onOpenAbsoluteFileRef.current?.(abs),
        onReveal: (abs) => onRevealInFinderRef.current?.(abs),
        onCopyPath: (abs) => onCopyAbsolutePathRef.current?.(abs),
        checkExists: (abs) => checkFileExistsRef.current?.(abs) ?? Promise.resolve(true),
      }),
      // `@` trigger palette — AI / Include / Embedding / Link insertion menu
      createAtTriggerMenuPlugin({
        pickFileForLink: () => onPickFileForLinkRef.current?.() ?? Promise.resolve(null),
      }),
      // AI Protocol frontmatter
      createFrontmatterProtocolPlugin(),
      // Domain icons before link text
      createLinkIconPlugin({
        getRules: () => domainIconsRef.current
      }),
      // Anchor links — same-file (#) and cross-file (./other.md#)
      createAnchorLinkPlugin({
        resolveCrossFilePath: (rel) => resolveAnchorFileRef.current?.(rel) ?? null,
        getCrossFileAnchors: (abs) => getCrossFileAnchorsRef.current?.(abs) ?? Promise.resolve(null),
        onNavigate: (path, line) => onNavigateAnchorRef.current?.(path, line)
      }),
      createAnchorLinkClickHandler({
        onNavigate: (path, line) => onNavigateAnchorRef.current?.(path, line)
      }),
      // Autocomplete fragment after `](#` or `](./file.md#`
      createAnchorAutocompletion({
        resolveCrossFilePath: (rel) => resolveAnchorFileRef.current?.(rel) ?? null,
        getCrossFileAnchors: (abs) => getCrossFileAnchorsRef.current?.(abs) ?? Promise.resolve(null)
      }),
      // Context menu
      // Per-line background StateField (Background context-menu).
      lineBackgroundExtension(),
      createContextMenuHandler({
        resolveInclude: (path) => resolveIncludeRef.current?.(path) ?? Promise.reject('No resolver'),
        getEmojiShortcuts: () => emojiShortcutsRef.current ?? [],
        clipboard: clipboardRef.current ?? undefined,
        getLineBackgrounds: () => lineBgPaletteRef.current as any,
        applyLineBackground: (v, bgId) => applyLineBackground(v, bgId),
        getActiveLineBackground: (v) => getActiveLineBackground(v),
      }),
      // Cmd+Hover on emoji in text → show tooltip with description
      createEmojiHoverTooltip({
        getEmojiShortcuts: () => emojiShortcutsRef.current ?? []
      }),
      // Кастомные image-эмодзи: токен `:имя:` в тексте → inline <img> из
      // settings.emojiShortcuts (записи с полем image). → plugins/customEmoji.ts
      createCustomEmojiPlugin({
        getCustomEmoji: () => (emojiShortcutsRef.current ?? [])
          .filter((s: any) => s && s.image && s.name)
          .map((s: any) => ({ name: s.name, image: s.image })),
      }),
      // Stable word selection (fix anchor/head flipping on dblclick + drag)
      stableWordSelection
    ]

    if (wordWrap) {
      extensions.push(EditorView.lineWrapping)
      extensions.push(hangingIndentPlugin)
    }

    let state = EditorState.create({
      doc: content,
      extensions
    })

    // Pre-fold ^^ headers BEFORE creating EditorView. Otherwise the first paint
    // of the editor shows the body expanded for one frame, then collapsibleArrow
    // plugin's constructor dispatches a fold — visible as a "flash". Applying
    // the fold via state.update() folds into the initial state, so the first
    // and only paint already has the body hidden.
    const initialFoldEffects: any[] = []
    for (let i = 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i)
      if (!line.text.trim().startsWith('^^')) continue
      const range = foldable(state, line.from, line.to)
      if (range && (range.to - range.from) > 2) {
        initialFoldEffects.push(foldEffect.of(range))
      }
    }
    if (initialFoldEffects.length > 0) {
      state = state.update({ effects: initialFoldEffects }).state
    }

    const view = new EditorView({
      state,
      parent: editorRef.current
    })

    viewRef.current = view
    appliedThemeRef.current = { view, fontSize, x: contentPaddingX, y: contentPaddingY }
    onEditorViewRef.current?.(view)

    // Seed line-background palette + this file's saved backgrounds.
    if (lineBgPaletteRef.current && lineBgPaletteRef.current.length) {
      setLineBackgroundPalette(view, lineBgPaletteRef.current as any)
    }
    if (initialLineBgRef.current) {
      loadLineBackgrounds(view, initialLineBgRef.current)
    }

    // Catch posBefore errors and dump fold state for diagnostics.
    // Also dump full context (selection, doc len, fold list) on
    // "Position N is out of range" — that's the dual-editor-sync class of bug.
    const errorHandler = (event: ErrorEvent) => {
      const msg = event.message || ''
      if (msg.includes('posBefore') || msg.includes('Invalid child')) {
        const folds: { from: number; to: number; headerText: string }[] = []
        try {
          foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
            const headerLine = view.state.doc.lineAt(from)
            folds.push({ from, to, headerText: headerLine.text.slice(0, 50) })
          })
        } catch {}
        console.error('[Fold:ERROR] posBefore — active folds:', folds, 'docLen:', view.state.doc.length)
      }
      if (msg.includes('out of range for changeset')) {
        try {
          const sel = view.state.selection.main
          console.error('[CM:RangeError]', {
            msg, docLen: view.state.doc.length,
            anchor: sel.anchor, head: sel.head,
            stack: event.error?.stack?.split('\n').slice(0, 8).join(' | '),
          })
        } catch (e) {
          console.error('[CM:RangeError] (also failed to read state)', msg, e)
        }
      }
    }
    window.addEventListener('error', errorHandler)

    // Cmd+Tab swallows keyup(Meta), and window/app switches can also lose
    // Option keyup. Drop modifier cursor classes on window blur (matches
    // blur-reset pattern of hover plugins).
    const modifierHeldBlurReset = () => {
      editorRef.current?.classList.remove('cmd-held')
      editorRef.current?.classList.remove('option-held')
    }
    window.addEventListener('blur', modifierHeldBlurReset)

    // Listen outside CM as well: Cmd can be pressed while a toolbar/sidebar
    // owns focus, with the mouse already over a link. Mouse events also heal
    // stale modifier state after switching windows.
    const modifierHeldDocumentSync = (event: KeyboardEvent | MouseEvent) => {
      editorRef.current?.classList.toggle('cmd-held', event.metaKey || event.ctrlKey)
      editorRef.current?.classList.toggle('option-held', event.altKey)
    }
    document.addEventListener('keydown', modifierHeldDocumentSync, true)
    document.addEventListener('keyup', modifierHeldDocumentSync, true)
    document.addEventListener('mousemove', modifierHeldDocumentSync, true)

    // Defer scroll restore one frame so mount-time autoFold (in
    // collapsibleArrowPlugin's constructor → setTimeout 0) has applied its
    // fold effects and the document height reflects the folded state.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scrollTarget = initialScrollTopRef.current
        if (scrollTarget > 0) {
          view.scrollDOM.scrollTop = scrollTarget
          const actualScroll = view.scrollDOM.scrollTop
          console.log('[Editor] scroll restored:', { requested: scrollTarget, actual: actualScroll, scrollHeight: view.scrollDOM.scrollHeight })
        }
      })
    })

    return () => {
      window.removeEventListener('error', errorHandler)
      window.removeEventListener('blur', modifierHeldBlurReset)
      document.removeEventListener('keydown', modifierHeldDocumentSync, true)
      document.removeEventListener('keyup', modifierHeldDocumentSync, true)
      document.removeEventListener('mousemove', modifierHeldDocumentSync, true)
      console.log('[Editor] DESTROYING editor', { scrollTop: view.scrollDOM.scrollTop })
      view.destroy()
      onEditorViewRef.current?.(null)
    }
  }, [wordWrap, stableIncludeOffsets, showLineNumbers, compact, readOnly, themeCompartment])

  // Typography changes are presentation updates. Recreating the view loses
  // undo/selection and leaves consumers' scroll listeners on a dead scroller.
  // CM remeasures the new theme while retaining the current document/view.
  useEffect(() => {
    const view = viewRef.current, previous = appliedThemeRef.current
    if (!view || (previous?.view === view && previous.fontSize === fontSize &&
        previous.x === contentPaddingX && previous.y === contentPaddingY)) return
    view.dispatch({ effects: themeCompartment.reconfigure(createDarkTheme(fontSize, contentPaddingX, contentPaddingY)) })
    appliedThemeRef.current = { view, fontSize, x: contentPaddingX, y: contentPaddingY }
  }, [fontSize, contentPaddingX, contentPaddingY, themeCompartment])

  // Sync content from props (only when external change detected).
  //
  // Selection clamp: when two editor instances share the same `content` source
  // (e.g. inline notes + slide-out both bound to tab.notes), serial replaceAll
  // dispatches happen between them. If the local selection was past the new
  // doc length (cursor at 296, new doc 287), CodeMirror throws
  //   "Position N is out of range for changeset of length M"
  // because the changeset can't remap an out-of-bounds anchor. Pre-clamp the
  // selection to fit the new doc length BEFORE the dispatch.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const currentContent = view.state.doc.toString()
    if (currentContent === content) return
    const newLen = content.length
    const sel = view.state.selection.main
    const safeAnchor = Math.min(sel.anchor, newLen)
    const safeHead = Math.min(sel.head, newLen)
    console.warn('[MarkdownEditor] External content sync:', {
      currentLength: currentContent.length,
      newLength: content.length,
      anchor: sel.anchor, head: sel.head,
      safeAnchor, safeHead
    })
    try {
      view.dispatch({
        changes: { from: 0, to: currentContent.length, insert: content },
        selection: { anchor: safeAnchor, head: safeHead },
        // Mark this dispatch so our updateListener skips onChange echo and
        // breaks the parent-state ↔ editor sync ping-pong.
        userEvent: 'external-sync',
      })
      // External-sync wipes all fold ranges (replaceAll → CM remaps them to
      // zero-length). collapsibleArrowPlugin would re-fold via setTimeout(0)
      // from its update(), which paints one frame of expanded ^^ content —
      // visible when the sibling editor (e.g. TabNotesSlideout sharing
      // tab.notes with the inline editor) pushes a new snapshot in.
      // Synchronous fold immediately after the change dispatch — no flash.
      const doc2 = view.state.doc
      const foldEffects: any[] = []
      for (let i = 1; i <= doc2.lines; i++) {
        const line = doc2.line(i)
        if (!line.text.trim().startsWith('^^')) continue
        let already = false
        foldedRanges(view.state).between(line.from, line.to, () => { already = true })
        if (already) continue
        const range = foldable(view.state, line.from, line.to)
        if (range && (range.to - range.from) > 2) {
          foldEffects.push(foldEffect.of(range))
        }
      }
      if (foldEffects.length > 0) {
        view.dispatch({ effects: foldEffects })
      }
    } catch (err) {
      console.error('[MarkdownEditor] sync dispatch threw', {
        msg: (err as Error)?.message,
        anchor: sel.anchor, head: sel.head,
        currentLength: currentContent.length, newLength: newLen
      })
      throw err
    }
  }, [content])

  return <div ref={editorRef} className="markdown-editor" />
}

export default MarkdownEditor
