import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, CheckSquare, ChevronLeft, History, LoaderCircle, PanelRightClose, PanelRightOpen, Paperclip, Pencil, Plus, Power, RefreshCw, Square, Trash2, TriangleAlert, X } from 'lucide-react';
import { ComposerChip } from '@noted/claude-blocks';
import { acquirePromptQueueEditorLock, buildQueuedPromptPayload, countEnabledQueuedPrompts, ensureQueuedPromptImagesReady, getQueuedImageMarkerHighlightRanges, getQueuedPromptAttachmentState, getShortGrabPromptTitle, hasMalformedQueuedImageMarker, hasPendingPromptQueueContinuation, isQueuedPromptEnabled, makeDefaultPromptTitle, queueSendTransferredOwnership, releasePromptQueueEditorLock, usePromptQueueStore, type QueuedComposerChip, type QueuedImageMarkerRange, type QueuedImageRef, type QueuedPrompt } from '../../store/usePromptQueueStore';
import { DEFAULT_RUN_AFTER_TITLE_PROMPT, RUN_AFTER_TITLE_PROMPT_ID, usePromptsStore } from '../../store/usePromptsStore';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { generateTitleFromPromptWithConfig, trimTabTitlePrompt } from '../../utils/generateTabTitle';
import {
  collectPromptImageRefIds,
  getPromptImageAttachmentState,
  hasMalformedPromptImageMarker,
  haveSamePromptImageRefs,
  insertPromptImageAttachments,
} from '../../utils/promptImageAttachments.mjs';
import {
  haveSameComposerChips,
  normalizeComposerChips,
  restoreComposerChipToText,
  serializeComposerDraft,
} from '../../utils/composerChips.mjs';
import {
  combineFirstDelayParts,
  formatFirstDelayCountdown,
  getFirstDelayRemainingSeconds,
  splitFirstDelaySeconds,
} from '../../utils/promptQueueDelay';
import { RunAfterTabPicker } from './RunAfterTabPicker';
import { OrchestrationStatusChip } from './OrchestrationStatusChip';
import ControlHint from '../UI/ControlHint';

const { ipcRenderer } = window.require('electron');

// Map main-process error codes from claude:grab-input → user-facing toast strings.
// English for consistency with the button labels.
const GRAB_ERROR_TOASTS: Record<string, string> = {
  no_terminal: 'No terminal for this tab',
  no_claude_session: 'No Claude session running in this tab',
  no_codex_session: 'No Codex session running in this tab',
  no_codex_pid: 'No Codex process found in this tab',
  claude_busy: 'Claude is busy — wait for the response to finish',
  codex_ctrl_g_noop: 'Codex did not open the prompt editor — wait for the response to finish',
  already_in_progress: 'Grab already in progress',
  wrong_editor: 'Restart the agent in this tab — grab needs our editor helper, current $EDITOR is wrong',
  stale_pid: 'The agent was restarted outside our control — close & reopen this tab',
  editor_not_wired: 'Helper never reported back — check ~/.claude/hooks/noted-code-grab.js',
  tab_cleared: 'Tab was closed before grab finished',
  timeout: 'Grab timed out',
};

// ─── visual constants ──────────────────────────────────────────────────────
const TINT = '#DA7756';           // Claude orange tint for active states
const PULSE = '#a78bfa';          // purple — armed/waiting auto-run indicator
// Deeper violet for the Run-after target-tab pill. Distinct from PULSE so a
// user looking at the overlay sees "armed-self" (PULSE around the Run after
// button) vs "armed-on-other-tab" (DEEP_PULSE on the dropdown) as two
// different states, not the same thing. Both are in the purple family because
// they share the meaning "auto-run is configured for this queue", just with
// different triggers.
const DEEP_PULSE = '#8b5cf6';     // violet-500 — Run-after pointed at another tab
const HINT_RED = '#ef4444';       // red-500 — first-chip "don't forget to arm" hint
                                  // Previously #d97706 (amber) but that read as
                                  // "orange" and conflicted visually with the
                                  // active Run after state. True red is the
                                  // clearer "needs your attention" signal.
const HINT_RED_BG = 'rgba(127, 29, 29, 0.14)';
const HINT_RED_BORDER = 'rgba(239, 68, 68, 0.32)';
const HINT_RED_TEXT = '#b96b6b';
const HINT_RED_DOT = '#a45454';
const PANEL_BG = 'rgba(20,20,20,0.92)';
const BORDER = 'rgba(255,255,255,0.08)';
const TEXT_MUTED = '#888';
const TEXT_DIM = '#555';
const SAVE_GREEN = '#22c55e';
const DELETE_RED = '#ef4444';
const IMAGE_TAG_BLUE = '#60a5fa';
const DISABLED_PROMPT_BG = 'rgba(82, 18, 48, 0.48)';
const DISABLED_PROMPT_BG_HOVER = 'rgba(104, 24, 60, 0.56)';
const DISABLED_PROMPT_TEXT = '#d8c5cf';
const OVERLAY_Z_INDEX = 120;           // above HistoryPanel (z:101)
const FLOATING_OVERLAY_Z_INDEX = 130;  // editor/dropdowns above the rail/panel
const INSERT_PROMPT_TITLE_MATCH_CHARS = 50;

// Panel width is now FIXED (user-resizable, persisted in useUIStore.promptQueueWidth),
// NOT `fit-content`. Reason: `fit-content` reflowed the panel every time a +grab
// chip was added/removed or a button label changed — the user wants a stable width
// they set once. Width-stability of inner controls still matters (the Stop/Close
// split-button uses a CSS grid to reserve the wider label) so the content never
// pushes past the fixed width. Bounds + default live in useUIStore
// (PROMPT_QUEUE_WIDTH_MIN/MAX); RESIZE_MIN/MAX_WIDTH below must mirror them.
const EDITOR_WIDTH = 380;
const EDITOR_MARGIN = 8;
const EDITOR_TITLE_HEIGHT = 24;
const EDITOR_TEXTAREA_MIN_HEIGHT = 64;
const EDITOR_MIN_WIDTH = 280;
const EDITOR_MIN_HEIGHT = 96;
const EDITOR_MAX_WIDTH = 760;
const COLLAPSED_RAIL_FULL_WIDTH = 66;
const COLLAPSED_RAIL_COMPACT_WIDTH = 32;
const COLLAPSED_RAIL_GAP = 4;
const PANEL_SLIDE_MS = 100;

// Which screen edge the overlay is docked to. The panel is pinned by this edge
// (it never moves), and the resize handle lives on the OPPOSITE (free) edge so
// dragging only grows/shrinks toward the available space — per
// `🧩 Code-Patterns/.../tooltip-resize-modal.md`: «resize только в сторону,
// противоположную опорной границе». Today the overlay sits flush against the
// terminal's RIGHT edge (left of Timeline), so anchor = 'right' → handle on the
// LEFT → drag-left grows.
// When the menu later moves to the left side, flip this to 'left' (and swap the
// style to `left: 8`) — the handle auto-moves to the right, no other change.
const ANCHOR_SIDE: 'left' | 'right' = 'right';
// Resize bounds — must match useUIStore's PROMPT_QUEUE_WIDTH_MIN/MAX clamp.
const RESIZE_MIN_WIDTH = 240;
const RESIZE_MAX_WIDTH = 600;

function chipTitle(item: QueuedPrompt): string {
  return (item.title || '').trim() || makeDefaultPromptTitle(item.text);
}

function takeLeadingChars(value: string, count: number): string {
  return Array.from(value).slice(0, count).join('');
}

function shouldPreservePinnedEditorOnOutsideClick(target: Element | null): boolean {
  return !!target?.closest('[data-tab-item], [data-workspace-navigation]');
}

function renderEditorHighlight(text: string, ranges: QueuedImageMarkerRange[]): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <span
        key={`${range.start}:${range.end}:${range.id}`}
        style={{
          color: IMAGE_TAG_BLUE,
          background: 'rgba(59,130,246,0.16)',
          borderRadius: 2,
          boxShadow: 'inset 0 0 0 1px rgba(96,165,250,0.18)',
        }}
      >
        {text.slice(range.start, range.end)}
      </span>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  // A zero-width tail keeps the mirror's final empty line equal to textarea.
  parts.push(<span key="tail">&#8203;</span>);
  return parts;
}

type StoredInsertPrompt = { title?: unknown; content?: unknown };

async function findSavedInsertPromptTitle(text: string): Promise<string | null> {
  const normalizedText = text.trim();
  if (!normalizedText) return null;
  const textPrefix = takeLeadingChars(normalizedText, INSERT_PROMPT_TITLE_MATCH_CHARS);

  try {
    const result = await ipcRenderer.invoke('prompts:get');
    const prompts: StoredInsertPrompt[] =
      result && result.success && Array.isArray(result.data) ? result.data : [];

    for (const prompt of prompts) {
      const content = typeof prompt.content === 'string' ? prompt.content.trim() : '';
      const title = typeof prompt.title === 'string' ? prompt.title.trim() : '';
      if (!content || !title) continue;

      const contentChars = Array.from(content);
      const contentPrefix = takeLeadingChars(content, INSERT_PROMPT_TITLE_MATCH_CHARS);
      const matches =
        contentChars.length >= INSERT_PROMPT_TITLE_MATCH_CHARS
          ? textPrefix === contentPrefix
          : normalizedText.startsWith(content);
      if (matches) return title;
    }
  } catch (e) {
    console.warn('[PromptQueue] insert-prompt title lookup failed', e);
  }

  return null;
}

type QueueAgent = 'claude' | 'codex';
type EditorAnchorMode = 'panel' | 'list';

const AGENT_LABEL: Record<QueueAgent, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

type Props = {
  tabId: string;
  sessionType: QueueAgent;
  // Existing per-tab AI busy state from provider busy-state. We hold the loader's truth.
  agentBusy: boolean;
  rightInset?: number;
  hideHistoryToggle?: boolean;
  inputSurface?: 'terminal' | 'history';
};

export function PromptQueueOverlay({
  tabId,
  sessionType,
  agentBusy,
  rightInset = 0,
  hideHistoryToggle = false,
  inputSurface = 'terminal',
}: Props) {
  const agentLabel = AGENT_LABEL[sessionType];
  const chipLineClamp = useUIStore((s) => s.promptQueueChipLineClamp);
  const promptQueueChipFontSize = useUIStore((s) => s.promptQueueChipFontSize);
  const promptQueueEditorFontSize = useUIStore((s) => s.promptQueueEditorFontSize);
  const queue = usePromptQueueStore((s) => s.queues.get(tabId));
  const pendingQueueTabIdsKey = usePromptQueueStore((s) => {
    const ids: string[] = [];
    for (const [ownerTabId, ownerQueue] of s.queues) {
      if (hasPendingPromptQueueContinuation(ownerQueue)) ids.push(ownerTabId);
    }
    return ids.sort().join('\u001f');
  });
  const pendingQueueTabIds = useMemo(
    () => new Set(pendingQueueTabIdsKey ? pendingQueueTabIdsKey.split('\u001f') : []),
    [pendingQueueTabIdsKey],
  );
  const items = queue?.items ?? [];
  const activeItemCount = useMemo(() => countEnabledQueuedPrompts(items), [items]);
  const autoRun = queue?.autoRun ?? false;
  const stopAfter = queue?.stopAfter ?? false;
  const closeAfter = queue?.closeAfter ?? false;
  const postPromptEnabled = queue?.postPromptEnabled ?? false;
  const postPromptText = queue?.postPromptText ?? '';
  const loopPromptEnabled = queue?.loopPromptEnabled ?? false;
  const loopPromptText = usePromptQueueStore((s) => s.sharedLoopPromptText);
  const collapsed = queue?.panelCollapsed ?? false;
  const firstChipArmedHint = queue?.firstChipHintActive ?? false;
  const runAfterTabId = queue?.runAfterTabId ?? null;
  const pinnedPreviewId = queue?.previewId ?? null;
  const {
    addPrompt, removePrompt, updatePrompt, reorderPrompt,
    setAutoRun, setStopAfter, setCloseAfter, setRunAfterTab: setRunAfterTabInStore,
    setPostPromptEnabled, setPostPromptText,
    setLoopPromptEnabled, setLoopPromptText,
    setPanelCollapsed, setPreviewId,
    // popNext is consumed by hooks/usePromptQueueRunner.ts — not referenced here.
  } = usePromptQueueStore.getState();

  // ─── diagnostic: confirm overlay actually mounts + measure visibility ────
  // Logs once on mount and once on unmount. If gate=SHOWN in QueueGate logs but
  // we see no [Overlay:MOUNT] for the same tab — React did not render the JSX
  // (parent unmount or memo bailout). If we see MOUNT but the panel still does
  // not appear on screen — measure DOM rect on next frame to detect CSS clip /
  // covered by sibling.
  useEffect(() => {
    console.warn('[Overlay:MOUNT] tab=' + tabId.slice(-8) + ' items=' + items.length + ' autoRun=' + autoRun);
    const raf = requestAnimationFrame(() => {
      const el = panelRef.current;
      if (!el) {
        console.warn('[Overlay:MEASURE] tab=' + tabId.slice(-8) + ' panelRef=null (ref not yet bound)');
        return;
      }
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const parentRect = el.offsetParent ? (el.offsetParent as HTMLElement).getBoundingClientRect() : null;
      const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0;
      console.warn('[Overlay:MEASURE] tab=' + tabId.slice(-8) + ' rect=' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' display=' + cs.display + ' visibility=' + cs.visibility + ' opacity=' + cs.opacity + ' zIndex=' + cs.zIndex + ' visible=' + visible + ' parent=' + (parentRect ? Math.round(parentRect.width) + 'x' + Math.round(parentRect.height) : 'null'));
    });
    return () => {
      cancelAnimationFrame(raf);
      console.warn('[Overlay:UNMOUNT] tab=' + tabId.slice(-8));
    };
  }, [tabId]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [editorChips, setEditorChips] = useState<QueuedComposerChip[]>([]);
  const [editorChipPreviewId, setEditorChipPreviewId] = useState<string | null>(null);
  const [editorTitle, setEditorTitle] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  type SpecialPromptMode = 'post' | 'loop';
  // Special prompts reuse the queue editor surface but never become queue
  // chips. The explicit mode keeps blur-save ownership deterministic.
  const [specialPromptMode, setSpecialPromptMode] = useState<SpecialPromptMode | null>(null);
  const isSpecialPromptMode = specialPromptMode !== null;
  const [editorAutoFocus, setEditorAutoFocus] = useState(false);
  const [editorFocusWithin, setEditorFocusWithin] = useState(false);
  const [editorPinned, setEditorPinned] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [armedFlash, setArmedFlash] = useState(false);
  // Anchor for the editor modal — when set, the modal aligns its right edge to this rect's left edge
  // and its top edge to this rect's top edge. null = anchor to the whole panel's top-right corner.
  const [editorAnchor, setEditorAnchor] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const [editorSize, setEditorSize] = useState<{ width: number }>({
    width: EDITOR_WIDTH,
  });
  const [appearingIds, setAppearingIds] = useState<Set<string>>(new Set());
  const [savedFlashIds, setSavedFlashIds] = useState<Set<string>>(new Set());
  const [titleLoadingIds, setTitleLoadingIds] = useState<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [removeHoverId, setRemoveHoverId] = useState<string | null>(null);
  const [chipContextMenu, setChipContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const chipListRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const editorTitleInputRef = useRef<HTMLInputElement>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editorHighlightRef = useRef<HTMLDivElement>(null);
  const replayButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const committingRef = useRef(false);
  const editorLockTokenRef = useRef(
    `prompt-queue-editor:${tabId}:${Math.random().toString(36).slice(2)}`,
  );
  const editorPayloadLockedRef = useRef(false);
  const editorLastWrittenRef = useRef<{
    id: string | null;
    specialMode: SpecialPromptMode | null;
    text: string;
    chips: QueuedComposerChip[];
  } | null>(null);
  const editorDirtyFieldsRef = useRef({
    text: false,
    chips: false,
    title: false,
    special: false,
  });
  const removingIdsRef = useRef<Set<string>>(new Set());
  const chipCloseSuppressRef = useRef<{ id: string; until: number } | null>(null);
  const titleGeneratingIdsRef = useRef<Set<string>>(new Set());
  const editorInitialRef = useRef<{
    id: string | null;
    specialMode: SpecialPromptMode | null;
    text: string;
    chips: QueuedComposerChip[];
    title: string;
    titleManual: boolean;
  } | null>(null);
  const chipContextItem = useMemo(
    () => chipContextMenu ? items.find((item) => item.id === chipContextMenu.id) ?? null : null,
    [chipContextMenu, items]
  );
  const editingItem = useMemo(
    () => editingId ? items.find((item) => item.id === editingId) ?? null : null,
    [editingId, items],
  );
  const editorImageMarkerRanges = useMemo(
    () => isSpecialPromptMode
      ? []
      : getQueuedImageMarkerHighlightRanges(editorText, editingItem?.imagePaths),
    [editingItem?.imagePaths, editorText, isSpecialPromptMode],
  );

  // ─── fixed width + drag-resize ─────────────────────────────────────────────
  // The panel has a FIXED width (no `fit-content`) so adding a +grab chip can't
  // reflow it — the user's complaint. Width is global (like timelineWidth) and
  // persisted in useUIStore. During a drag we render from `dragWidth` (local,
  // for 60fps without store churn) and commit to the store on mouse-up.
  const promptQueueWidth = useUIStore((s) => s.promptQueueWidth);
  const setPromptQueueWidth = useUIStore((s) => s.setPromptQueueWidth);
  const historyPanelOpen = useUIStore((s) => s.historyPanelOpenTabs[tabId] ?? false);
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  const timelineTreeMode = useUIStore((s) => s.timelineTreeModeTabs[tabId] ?? false);
  const setTimelineTreeMode = useUIStore((s) => s.setTimelineTreeMode);
  const historyPinned = useUIStore((s) => s.historyPinned);
  const timelinePinned = useUIStore((s) => s.timelinePinned);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const effectiveWidth = dragWidth ?? promptQueueWidth;
  const chipTextLineHeight = Math.max(12, Math.round(promptQueueChipFontSize * 1.27));
  const editorTitleHeight = Math.max(EDITOR_TITLE_HEIGHT, Math.round(promptQueueEditorFontSize * 1.8));
  const editorTextareaMinHeight = Math.max(EDITOR_TEXTAREA_MIN_HEIGHT, Math.round(promptQueueEditorFontSize * 4.8));

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = useUIStore.getState().promptQueueWidth;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      // Anchor on the RIGHT → the LEFT edge is free → moving cursor left (dx<0)
      // must GROW the panel, so the delta is inverted. Anchor on the LEFT →
      // RIGHT edge free → dx is positive-grow. ANCHOR_SIDE makes this a 1-flip
      // change when the menu moves sides.
      const delta = ANCHOR_SIDE === 'right' ? -dx : dx;
      const next = Math.max(RESIZE_MIN_WIDTH, Math.min(RESIZE_MAX_WIDTH, startW + delta));
      setDragWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setDragWidth((w) => {
        if (w != null) setPromptQueueWidth(w);
        return null;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [setPromptQueueWidth]);

  // Toast handle — single getState() at top so both grabCurrent and the auto-runner share it
  // without re-declaring (which TS catches as duplicate identifier).
  const showToast = useUIStore.getState().showToast;
  const handleSetRunAfterTab = useCallback((ownerTabId: string, targetTabId: string | null) => {
    if (setRunAfterTabInStore(ownerTabId, targetTabId)) return;
    showToast('Run after не изменён: цепочка замкнётся сама на себя', 'warning', 3500);
  }, [setRunAfterTabInStore, showToast]);

  // ─── first-chip blink ────────────────────────────────────────────────────
  // When firstChipArmedHint flips false → true (user added the first chip
  // into an empty queue while Run after was off), we play one red blink to draw
  // the eye, then leave a low-red armed hint until the user explicitly presses
  // Run after or manually empties the queue. Hover is only inspection; it must
  // not acknowledge/clear the hint.
  //
  // We can't put the animation directly on the pill (re-renders would re-start
  // it mid-cycle). Instead, increment a counter every time the hint re-arms —
  // `key={blinkKey}` on the overlay span unmounts/remounts it, giving a fresh
  // animation each time.
  const [blinkKey, setBlinkKey] = useState(0);
  const BLINK_CYCLE_MS = 700;
  const BLINK_ITERATIONS = 1;
  // Per-chip Replay in-flight flag. Replay roundtrip is ~400-800ms (Ctrl+G grab
  // → helper write → main IPC → paste) and visually silent until the chip
  // disappears — without a per-button spinner the user double-clicks.
  // Set<chipId> instead of single string so multiple parallel replays don't
  // race (queue actions are independent per chip).
  const [replayingIds, setReplayingIds] = useState<Set<string>>(new Set());
  const replayingIdsRef = useRef<Set<string>>(new Set());
  const [replayHoverId, setReplayHoverId] = useState<string | null>(null);
  const [railRunHover, setRailRunHover] = useState(false);
  const [cmdPressed, setCmdPressed] = useState(false);
  const cmdPressedRef = useRef(false);
  const [panelOpening, setPanelOpening] = useState(false);
  const [panelClosing, setPanelClosing] = useState(false);
  const collapseTimerRef = useRef<number | null>(null);
  const openingTimerRef = useRef<number | null>(null);
  const prevHintRef = useRef(false);
  useEffect(() => {
    if (firstChipArmedHint && !prevHintRef.current) {
      setBlinkKey((k) => k + 1);
    }
    prevHintRef.current = firstChipArmedHint;
  }, [firstChipArmedHint]);

  // Auto-runner moved to hooks/usePromptQueueRunner.ts — mounted at App root.
  // The runner subscribes to provider busy-state IPC + queue store globally so
  // queued prompts auto-fire even when the user is on a different tab/project.
  // agentBusy prop here is still used for the Run pill's pulsing indicator.

  // ─── handlers ────────────────────────────────────────────────────────────
  const acquireEditorPayloadLock = useCallback((itemId: string | null): boolean => {
    const acquired = acquirePromptQueueEditorLock(
      tabId,
      editorLockTokenRef.current,
      itemId,
    );
    editorPayloadLockedRef.current = acquired;
    if (!acquired) {
      console.warn('[PromptQueue] editor payload lock refused tab=' + tabId.slice(-8)
        + ' item=' + (itemId?.slice(-8) || specialPromptMode || 'new'));
    }
    return acquired;
  }, [specialPromptMode, tabId]);

  const releaseEditorPayloadLock = useCallback((wakeAutoRun = true) => {
    if (!editorPayloadLockedRef.current) return;
    releasePromptQueueEditorLock(tabId, editorLockTokenRef.current, { wakeAutoRun });
    editorPayloadLockedRef.current = false;
  }, [tabId]);

  const resetEditor = useCallback((options: { wakeAutoRun?: boolean } = {}) => {
    releaseEditorPayloadLock(options.wakeAutoRun !== false);
    if (editingId) setPreviewId(tabId, null);
    setEditorOpen(false);
    setEditorText('');
    setEditorChips([]);
    setEditorChipPreviewId(null);
    setEditorTitle('');
    setEditingId(null);
    setSpecialPromptMode(null);
    setEditorAutoFocus(false);
    setEditorFocusWithin(false);
    setEditorPinned(false);
    editorInitialRef.current = null;
    editorLastWrittenRef.current = null;
    editorDirtyFieldsRef.current = {
      text: false,
      chips: false,
      title: false,
      special: false,
    };
  }, [editingId, releaseEditorPayloadLock, setPreviewId, tabId]);

  useEffect(() => () => {
    releasePromptQueueEditorLock(tabId, editorLockTokenRef.current);
    editorPayloadLockedRef.current = false;
  }, [tabId]);

  const markAppearing = useCallback((id: string) => {
    setAppearingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    window.setTimeout(() => {
      setAppearingIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 520);
  }, []);

  const markSaved = useCallback((id: string) => {
    setSavedFlashIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    window.setTimeout(() => {
      setSavedFlashIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 560);
  }, []);

  const setTitleLoading = useCallback((id: string, loading: boolean) => {
    setTitleLoadingIds((prev) => {
      const has = prev.has(id);
      if (loading && has) return prev;
      if (!loading && !has) return prev;
      const next = new Set(prev);
      if (loading) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const animateRemovePrompt = useCallback((id: string) => {
    if (removingIdsRef.current.has(id)) return;
    removingIdsRef.current.add(id);
    setRemovingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    window.setTimeout(() => {
      removePrompt(tabId, id);
      removingIdsRef.current.delete(id);
      setRemovingIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (removeHoverId === id) setRemoveHoverId(null);
    }, 260);
  }, [removePrompt, removeHoverId, tabId]);

  const generateRunAfterTitle = useCallback((id: string, text: string, opts?: { force?: boolean }) => {
    const source = trimTabTitlePrompt(text.trim());
    if (!source || titleGeneratingIdsRef.current.has(id)) return false;
    titleGeneratingIdsRef.current.add(id);
    setTitleLoading(id, true);
    void (async () => {
      try {
        const promptConfig = usePromptsStore.getState().getPromptById(RUN_AFTER_TITLE_PROMPT_ID);
        const title = await generateTitleFromPromptWithConfig(source, promptConfig, {
          fallbackPrompt: DEFAULT_RUN_AFTER_TITLE_PROMPT,
          sourceLabel: 'Текст задачи Run after',
          logPrefix: 'RunAfterTitle',
          taskType: 'run-after-title',
          promptId: RUN_AFTER_TITLE_PROMPT_ID,
        });
        if (!title) return;
        const current = usePromptQueueStore.getState().getQueue(tabId).items.find((p) => p.id === id);
        if (!current || (current.titleManual && !opts?.force)) return;
        updatePrompt(tabId, id, { title, titleManual: true });
        markSaved(id);
      } finally {
        titleGeneratingIdsRef.current.delete(id);
        setTitleLoading(id, false);
      }
    })();
    return true;
  }, [markSaved, setTitleLoading, tabId, updatePrompt]);

  const writeThroughEditorPayload = useCallback((
    nextText: string,
    nextChips: QueuedComposerChip[],
  ): boolean => {
    const initial = editorInitialRef.current;
    if (!initial) return false;
    const normalizedChips = normalizeComposerChips(nextChips) as QueuedComposerChip[];

    if (initial.specialMode) {
      if (!acquireEditorPayloadLock(null)) return false;
      if (initial.specialMode === 'post') setPostPromptText(tabId, nextText);
      else setLoopPromptText(tabId, nextText);
      editorLastWrittenRef.current = {
        id: null,
        specialMode: initial.specialMode,
        text: nextText,
        chips: [],
      };
      return true;
    }

    if (!initial.id) {
      editorLastWrittenRef.current = {
        id: null,
        specialMode: null,
        text: nextText,
        chips: normalizedChips,
      };
      return true;
    }
    if (!acquireEditorPayloadLock(initial.id)) return false;

    const previous = editorLastWrittenRef.current;
    const patch: { text?: string; chips?: QueuedComposerChip[] } = {};
    if (!previous || previous.text !== nextText) patch.text = nextText;
    if (!previous || !haveSameComposerChips(previous.chips, normalizedChips)) {
      patch.chips = normalizedChips;
    }
    if (!Object.prototype.hasOwnProperty.call(patch, 'text')
      && !Object.prototype.hasOwnProperty.call(patch, 'chips')) {
      return true;
    }

    const accepted = updatePrompt(tabId, initial.id, patch);
    if (accepted) {
      editorLastWrittenRef.current = {
        id: initial.id,
        specialMode: null,
        text: nextText,
        chips: normalizedChips,
      };
    }
    return accepted;
  }, [acquireEditorPayloadLock, setLoopPromptText, setPostPromptText, tabId, updatePrompt]);

  const commitEditor = useCallback((opts?: { close?: boolean; wakeAutoRun?: boolean }) => {
    if (!editorOpen || committingRef.current) return false;
    const initial = editorInitialRef.current;
    if (!initial) {
      if (opts?.close !== false) resetEditor({ wakeAutoRun: opts?.wakeAutoRun });
      return false;
    }
    committingRef.current = true;
    let changed = false;
    try {
      if (initial.specialMode) {
        changed = editorDirtyFieldsRef.current.special;
        if (editorLastWrittenRef.current?.text !== editorText) {
          writeThroughEditorPayload(editorText, []);
        }
        if (opts?.close !== false) resetEditor({ wakeAutoRun: opts?.wakeAutoRun });
        return changed;
      }

      const normalizedTitle = editorTitle.trim();
      const bodyText = editorText.trim();
      const hasExistingChips = editorChips.length > 0;
      const initialSerialized = serializeComposerDraft({
        text: initial.text,
        chips: initial.chips,
      });
      const titleCanStandInForBody = initial.chips.length === 0
        && normalizedTitle.length > 0 && (
        !initial.id ||
        !!initial.titleManual ||
        normalizedTitle !== initial.title ||
        normalizedTitle !== makeDefaultPromptTitle(initialSerialized)
      );
      // A chip-only queue item has an intentionally empty editable body. Its
      // generated title is presentation, not substitute payload; opening and
      // closing the editor must not copy that title into the body and send it
      // alongside the hidden chip.
      const text = bodyText || (
        titleCanStandInForBody
          ? normalizedTitle
          : ''
      );

      if (initial.id) {
        if (
          editorLastWrittenRef.current?.text !== editorText
          || !haveSameComposerChips(editorLastWrittenRef.current?.chips, editorChips)
        ) {
          writeThroughEditorPayload(editorText, editorChips);
        }
        const lastWritten = editorLastWrittenRef.current;
        const localPayloadChanged = editorDirtyFieldsRef.current.text
          || editorDirtyFieldsRef.current.chips;
        const titleEditedInForm = editorDirtyFieldsRef.current.title;
        changed = localPayloadChanged || titleEditedInForm;

        let itemStillExists = !!usePromptQueueStore.getState().getQueue(tabId)
          .items.find((item) => item.id === initial.id);
        if (!text && !hasExistingChips) {
          if (initial.chips.length > 0 && lastWritten) {
            // Deleting the last chip intentionally removes a chip-only item,
            // but only while the durable payload is still the exact payload
            // this editor wrote. A concurrent mobile edit makes this CAS fail.
            removePrompt(tabId, initial.id, {
              expected: {
                text: lastWritten.text,
                chips: lastWritten.chips,
              },
            });
            itemStillExists = !!usePromptQueueStore.getState().getQueue(tabId)
              .items.find((item) => item.id === initial.id);
          } else if (localPayloadChanged && lastWritten) {
            // Historical behaviour ignores clearing the only plain-text body.
            // Restore it only if nobody changed that same field after our last
            // write-through; otherwise the newer remote value wins.
            updatePrompt(
              tabId,
              initial.id,
              { text: initial.text },
              { expected: { text: lastWritten.text } },
            );
          }
        } else if (lastWritten && text !== lastWritten.text) {
          // Final whitespace/title normalization is a conditional write. It
          // must not replay the open-time snapshot over a later mobile edit.
          const accepted = updatePrompt(
            tabId,
            initial.id,
            { text },
            { expected: { text: lastWritten.text } },
          );
          if (accepted) {
            editorLastWrittenRef.current = { ...lastWritten, text };
          }
        }

        if (itemStillExists && titleEditedInForm) {
          const current = usePromptQueueStore.getState().getQueue(tabId)
            .items.find((item) => item.id === initial.id);
          if (current) {
            const nextDefaultTitle = makeDefaultPromptTitle(serializeComposerDraft({
              text: current.text,
              chips: current.chips || [],
            }));
            const titleManual = normalizedTitle.length > 0
              && normalizedTitle !== nextDefaultTitle;
            updatePrompt(tabId, initial.id, {
              title: titleManual ? normalizedTitle : nextDefaultTitle,
              titleManual,
            });
          }
        }
        if (changed && itemStillExists) {
          markSaved(initial.id);
        }
      } else {
        if (!text && !hasExistingChips) {
          if (opts?.close !== false) resetEditor({ wakeAutoRun: opts?.wakeAutoRun });
          return false;
        }
        const id = addPrompt(tabId, text, undefined, undefined, normalizedTitle, editorChips);
        const titleWillGenerate = !normalizedTitle && generateRunAfterTitle(
          id,
          serializeComposerDraft({ text, chips: editorChips }),
        );
        if (!titleWillGenerate) markAppearing(id);
        changed = true;
      }

      if (opts?.close !== false) resetEditor({ wakeAutoRun: opts?.wakeAutoRun });
      return changed;
    } finally {
      if (opts?.close === false) {
        editorDirtyFieldsRef.current = {
          text: false,
          chips: false,
          title: false,
          special: false,
        };
        releaseEditorPayloadLock(opts?.wakeAutoRun !== false);
      }
      window.setTimeout(() => { committingRef.current = false; }, 0);
    }
  }, [addPrompt, editorChips, editorOpen, editorText, editorTitle, generateRunAfterTitle, markAppearing, markSaved, releaseEditorPayloadLock, removePrompt, resetEditor, tabId, updatePrompt, writeThroughEditorPayload]);

  const suppressChipReopen = useCallback((id: string) => {
    chipCloseSuppressRef.current = { id, until: performance.now() + 450 };
  }, []);

  const isChipReopenSuppressed = useCallback((id: string) => {
    const current = chipCloseSuppressRef.current;
    if (!current) return false;
    if (performance.now() > current.until) {
      chipCloseSuppressRef.current = null;
      return false;
    }
    return current.id === id;
  }, []);

  const blurActiveElement = useCallback(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
  }, []);

  const closePinnedEditorFromChip = useCallback((id: string) => {
    if (!editorOpen || !editorPinned || editingId !== id || isSpecialPromptMode) return false;
    suppressChipReopen(id);
    commitEditor();
    blurActiveElement();
    return true;
  }, [blurActiveElement, commitEditor, editingId, editorOpen, editorPinned, isSpecialPromptMode, suppressChipReopen]);

  const openChipContextMenu = useCallback((id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    closePinnedEditorFromChip(id);
    setChipContextMenu({ id, x: e.clientX, y: e.clientY });
  }, [closePinnedEditorFromChip]);

  const toggleChipEnabled = useCallback((id: string) => {
    const current = usePromptQueueStore.getState().getQueue(tabId).items.find((item) => item.id === id);
    if (!current) return;
    updatePrompt(tabId, id, { enabled: !isQueuedPromptEnabled(current) });
    setChipContextMenu(null);
  }, [tabId, updatePrompt]);

  const regenerateChipTitle = useCallback((id: string) => {
    const current = usePromptQueueStore.getState().getQueue(tabId).items.find((item) => item.id === id);
    if (!current) return;
    generateRunAfterTitle(
      id,
      serializeComposerDraft({ text: current.text, chips: current.chips || [] }),
      { force: true },
    );
    setChipContextMenu(null);
  }, [generateRunAfterTitle, tabId]);

  const anchorEditor = useCallback((id?: string, anchorMode: EditorAnchorMode = 'list') => {
    const panelRect = panelRef.current?.getBoundingClientRect();
    if (!panelRect) return null;
    const anchorRight = window.innerWidth - panelRect.left + 8; // 8px gap
    let anchorTop = panelRect.top;
    if (id) {
      const it = usePromptQueueStore.getState().getQueue(tabId).items.find((i) => i.id === id);
      if (!it) return null;
      const chipRect = chipRefs.current.get(id)?.getBoundingClientRect();
      if (chipRect) anchorTop = chipRect.top;
    } else if (anchorMode === 'list') {
      const listRect = chipListRef.current?.getBoundingClientRect();
      if (listRect) anchorTop = listRect.top;
    }
    anchorTop = Math.max(EDITOR_MARGIN, anchorTop);
    const maxHeight = Math.max(96, window.innerHeight - anchorTop - EDITOR_MARGIN);
    return { top: anchorTop, right: anchorRight, maxHeight };
  }, [tabId]);

  const startEditorResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = editorRef.current?.getBoundingClientRect();
    if (!rect || !editorAnchor) return;

    const startX = e.clientX;
    const startWidth = rect.width;
    const rightEdge = window.innerWidth - editorAnchor.right;
    const maxWidth = Math.max(
      EDITOR_MIN_WIDTH,
      Math.min(EDITOR_MAX_WIDTH, rightEdge - EDITOR_MARGIN)
    );
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      setEditorSize((prev) => {
        const next = { ...prev };
        next.width = Math.max(
          EDITOR_MIN_WIDTH,
          Math.min(maxWidth, startWidth + (startX - ev.clientX))
        );
        return next;
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [editorAnchor]);

  const openEditor = useCallback((id?: string, mode: 'hover' | 'pin' | 'restore' = 'pin') => {
    if (id && mode === 'hover' && isChipReopenSuppressed(id)) return;
    if (mode === 'hover' && editorPinned) return;
    if (editorOpen && !isSpecialPromptMode) {
      if (id && editingId === id) {
        if (mode === 'hover') return;
        if (mode === 'restore') return;
        if (editorPinned) {
          suppressChipReopen(id);
          commitEditor();
          blurActiveElement();
          return;
        }
        setEditorPinned(true);
        setPreviewId(tabId, id);
        setEditorAutoFocus(true);
        requestAnimationFrame(() => {
          editorTitleInputRef.current?.focus();
        });
        return;
      }
      if (!id && !editingId) {
        if (mode === 'pin') {
          if (editorPinned) {
            setPreviewId(tabId, null);
            commitEditor();
            blurActiveElement();
            return;
          }
          setPreviewId(tabId, null);
          setEditorPinned(true);
          setEditorAutoFocus(true);
          requestAnimationFrame(() => {
            editorTextareaRef.current?.focus();
          });
          return;
        }
        commitEditor();
        return;
      }
      commitEditor();
    } else if (editorOpen) {
      commitEditor();
    }
    const anchor = anchorEditor(id);
    if (!anchor) return;
    editorDirtyFieldsRef.current = {
      text: false,
      chips: false,
      title: false,
      special: false,
    };
    if (id) {
      const it = usePromptQueueStore.getState().getQueue(tabId).items.find((i) => i.id === id);
      if (!it) return;
      const title = chipTitle(it);
      setEditorText(it.text);
      setEditorChips((it.chips || []).map((chip) => ({ ...chip })));
      setEditorChipPreviewId(null);
      setEditorTitle(title);
      setEditingId(id);
      if (mode === 'pin') setPreviewId(tabId, id);
      editorInitialRef.current = {
        id,
        specialMode: null,
        text: it.text,
        chips: (it.chips || []).map((chip) => ({ ...chip })),
        title,
        titleManual: !!it.titleManual,
      };
      editorLastWrittenRef.current = {
        id,
        specialMode: null,
        text: it.text,
        chips: (it.chips || []).map((chip) => ({ ...chip })),
      };
    } else {
      setEditorText('');
      setEditorChips([]);
      setEditorChipPreviewId(null);
      setEditorTitle('');
      setEditingId(null);
      if (mode === 'pin') setPreviewId(tabId, null);
      editorInitialRef.current = {
        id: null,
        specialMode: null,
        text: '',
        chips: [],
        title: '',
        titleManual: false,
      };
      editorLastWrittenRef.current = {
        id: null,
        specialMode: null,
        text: '',
        chips: [],
      };
    }
    setSpecialPromptMode(null);
    setEditorAutoFocus(mode === 'pin');
    setEditorFocusWithin(false);
    setEditorPinned(mode !== 'hover');
    setEditorAnchor(anchor);
    setEditorOpen(true);
  }, [anchorEditor, blurActiveElement, commitEditor, editingId, editorOpen, editorPinned, isChipReopenSuppressed, isSpecialPromptMode, setPreviewId, suppressChipReopen, tabId]);

  // Same editor surface as queue items, but with a distinct durable owner.
  const openSpecialPromptEditor = useCallback((mode: SpecialPromptMode) => {
    if (editorOpen && specialPromptMode === mode) {
      commitEditor();
      return;
    }
    if (editorOpen) commitEditor();
    const anchor = anchorEditor(undefined, 'panel');
    if (!anchor) return;
    editorDirtyFieldsRef.current = {
      text: false,
      chips: false,
      title: false,
      special: false,
    };
    const text = mode === 'post' ? postPromptText : loopPromptText;
    setPreviewId(tabId, null);
    setEditorText(text);
    setEditorChips([]);
    setEditorChipPreviewId(null);
    setEditorTitle('');
    setEditingId(null);
    setSpecialPromptMode(mode);
    setEditorAutoFocus(true);
    setEditorFocusWithin(false);
    setEditorPinned(true);
    editorInitialRef.current = {
      id: null,
      specialMode: mode,
      text,
      chips: [],
      title: '',
      titleManual: false,
    };
    editorLastWrittenRef.current = {
      id: null,
      specialMode: mode,
      text,
      chips: [],
    };
    setEditorAnchor(anchor);
    setEditorOpen(true);
  }, [anchorEditor, commitEditor, editorOpen, loopPromptText, postPromptText, setPreviewId, specialPromptMode, tabId]);

  const openPostPromptEditor = useCallback(() => {
    openSpecialPromptEditor('post');
  }, [openSpecialPromptEditor]);

  const openLoopPromptEditor = useCallback(() => {
    openSpecialPromptEditor('loop');
  }, [openSpecialPromptEditor]);

  useEffect(() => {
    if (!chipContextMenu) return;
    if (!chipContextItem) {
      setChipContextMenu(null);
      return;
    }
    const onMouseDown = () => setChipContextMenu(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChipContextMenu(null);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [chipContextItem, chipContextMenu]);

  useEffect(() => {
    if (!editorOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const targetElement = target instanceof Element ? target : null;
      if (targetElement?.closest('[data-editor-trigger]')) return;
      if (editorRef.current?.contains(target)) return;
      const replayButton = editingId ? replayButtonRefs.current.get(editingId) : null;
      if (replayButton?.contains(target)) return;
      const currentChip = editingId ? chipRefs.current.get(editingId) : null;
      if (currentChip?.contains(target)) return;
      if (editorPinned && shouldPreservePinnedEditorOnOutsideClick(targetElement)) {
        commitEditor({ close: false });
        return;
      }
      commitEditor();
    };
    window.addEventListener('mousedown', onMouseDown, true);
    return () => window.removeEventListener('mousedown', onMouseDown, true);
  }, [commitEditor, editingId, editorOpen, editorPinned]);

  useEffect(() => {
    if (!editorOpen || !editingId || editorPinned || editorFocusWithin) return;
    const inRect = (r: DOMRect | undefined, x: number, y: number, pad = 2) =>
      !!r && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
    const onMove = (e: MouseEvent) => {
      const trigger = replayButtonRefs.current.get(editingId)?.getBoundingClientRect();
      const editor = editorRef.current?.getBoundingClientRect();
      if (!trigger || !editor) return;
      const x = e.clientX;
      const y = e.clientY;
      const inBridge =
        x >= editor.right - 2 &&
        x <= trigger.left + 2 &&
        y >= Math.min(editor.top, trigger.top) - 8 &&
        y <= Math.max(editor.bottom, trigger.bottom) + 8;
      if (!inRect(trigger, x, y) && !inRect(editor, x, y) && !inBridge) {
        resetEditor();
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [editingId, editorFocusWithin, editorOpen, editorPinned, resetEditor]);

  useLayoutEffect(() => {
    if (!editorOpen || !editorAnchor) return;
    const textarea = editorTextareaRef.current;
    if (!textarea) return;
    const chromeHeight = isSpecialPromptMode ? 0 : editorTitleHeight + 1;
    const maxTextareaHeight = Math.max(
      editorTextareaMinHeight,
      editorAnchor.maxHeight - chromeHeight
    );
    textarea.style.height = 'auto';
    const nextHeight = Math.min(
      Math.max(textarea.scrollHeight, editorTextareaMinHeight),
      maxTextareaHeight
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxTextareaHeight ? 'auto' : 'hidden';
    const highlight = editorHighlightRef.current;
    if (highlight) {
      highlight.style.width = `${textarea.clientWidth}px`;
      highlight.style.height = `${nextHeight}px`;
      highlight.scrollTop = textarea.scrollTop;
      highlight.scrollLeft = textarea.scrollLeft;
    }
  }, [editorAnchor, editorOpen, editorSize.width, editorText, editorTextareaMinHeight, editorTitleHeight, isSpecialPromptMode]);

  useEffect(() => {
    if (!editingId) return;
    if (!items.some((i) => i.id === editingId)) resetEditor();
  }, [editingId, items, resetEditor]);

  useEffect(() => {
    if (!pinnedPreviewId || collapsed || panelClosing) return;
    if (editorOpen && editorPinned && editingId === pinnedPreviewId && !isSpecialPromptMode) return;
    if (!items.some((i) => i.id === pinnedPreviewId)) {
      setPreviewId(tabId, null);
      return;
    }
    const raf = requestAnimationFrame(() => openEditor(pinnedPreviewId, 'restore'));
    return () => cancelAnimationFrame(raf);
  }, [
    collapsed,
    editingId,
    editorOpen,
    editorPinned,
    isSpecialPromptMode,
    items,
    openEditor,
    panelClosing,
    pinnedPreviewId,
    setPreviewId,
    tabId,
  ]);

  // Auto-arm was removed — adding a chip no longer flips Run after on.
  // The user is the sole arbiter of when the queue starts firing (one toggle).
  // History: earlier we auto-armed on the first chip ("queued something = wants
  // auto"), but that fought with the new firstDelay countdown which only makes
  // sense when the user explicitly hits Run with delay configured.

  // Helper: focus terminal so Ink's render loop stays hot and external-editor flow
  // (clear / grab tempfile re-read) completes in one frame instead of waiting for
  // user to click back into the terminal.
  const focusActiveTerminal = useCallback((reason = 'queue') => {
    const term = terminalRegistry.get(tabId);
    const before = document.activeElement?.tagName?.toLowerCase() || '-';
    try { term?.focus(); } catch {}
    const after = document.activeElement?.tagName?.toLowerCase() || '-';
    console.log('[PromptQueue] focus terminal tab=' + tabId.slice(-8) + ' reason=' + reason + ' hadTerm=' + !!term + ' active=' + before + '→' + after);
    requestAnimationFrame(() => {
      try { terminalRegistry.get(tabId)?.focus(); } catch {}
    });
  }, [tabId]);

  const focusHistoryComposer = useCallback((reason = 'queue') => {
    console.log('[PromptQueue] focus History composer tab=' + tabId.slice(-8) + ' reason=' + reason);
    window.dispatchEvent(new CustomEvent('history-panel:focus-composer', { detail: { tabId } }));
  }, [tabId]);

  // Replay handler — paste chip's text into the agent's current input WITHOUT
  // touching stash. Normal click leaves it for review; Cmd+click also submits
  // immediately (same as user pressing Enter after paste). On success the chip
  // is removed from the queue (the prompt has "moved" into the agent input).
  const replayChip = useCallback(async (id: string, item: QueuedPrompt, opts?: { submit?: boolean }) => {
    // Guard against double-click while the previous IPC roundtrip is still
    // in flight — second click would queue a second bracketed paste against
    // the same chip, then a second removePrompt against an already-gone id.
    if (replayingIdsRef.current.has(id)) {
      console.log('[PromptQueue] replay ignored inflight tab=' + tabId.slice(-8) + ' item=' + id.slice(-8));
      return;
    }
    replayingIdsRef.current.add(id);
    setReplayingIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      const validation = await ensureQueuedPromptImagesReady(tabId, id);
      if (!validation.ready || !validation.item) {
        const malformedMarker = validation.item
          ? hasMalformedQueuedImageMarker(validation.item.text, validation.item.imagePaths)
          : false;
        showToast(
          malformedMarker
            ? 'Replay failed: image marker is damaged'
            : 'Replay failed: image file is unavailable',
          'error',
        );
        console.warn('[PromptQueue] replay blocked by attachment validation tab=' + tabId.slice(-8) + ' item=' + id.slice(-8));
        return;
      }
      const payload = buildQueuedPromptPayload(validation.item);
      const submitNow = opts?.submit === true;
      console.log('[PromptQueue] replay start tab=' + tabId.slice(-8) + ' item=' + id.slice(-8) + ' agent=' + sessionType + ' submit=' + submitNow);
      if (!submitNow && inputSurface === 'history') {
        const ui = useUIStore.getState();
        const currentText = ui.historyPromptDrafts[tabId] || '';
        const currentImages = ui.historyPromptDraftImages[tabId] || [];
        const currentChips = ui.historyPromptDraftChips[tabId] || [];
        const separator = !currentText
          ? ''
          : currentText.endsWith('\n\n')
            ? ''
            : currentText.endsWith('\n')
              ? '\n'
              : '\n\n';
        const insertedText = validation.item.text
          ? separator + validation.item.text
          : '';
        const insertion = insertPromptImageAttachments({
          text: currentText,
          imagePaths: currentImages,
          start: currentText.length,
          end: currentText.length,
          insertedText,
          insertedImagePaths: validation.item.imagePaths || [],
        });
        if (insertion.missingSourceIds.length > 0) {
          showToast('Replay failed: image attachment identity is incomplete', 'error');
          console.warn('[PromptQueue] replay History insertion missing refs tab=' + tabId.slice(-8)
            + ' item=' + id.slice(-8)
            + ' ids=' + insertion.missingSourceIds.join(','));
          return;
        }
        ui.setHistoryPromptDraft(tabId, insertion.text, {
          images: insertion.imagePaths,
          chips: normalizeComposerChips([
            ...currentChips,
            ...(validation.item.chips || []),
          ]),
        });
        removePrompt(tabId, id);
        focusHistoryComposer('replay-after-history-transfer');
        console.log('[PromptQueue] replay transferred to History composer tab=' + tabId.slice(-8) + ' item=' + id.slice(-8));
        return;
      }
      if (inputSurface === 'terminal') {
        focusActiveTerminal(submitNow ? 'replay-submit-before-ipc' : 'replay-before-ipc');
      }
      const res = await ipcRenderer.invoke(sessionType + ':append-input', tabId, payload, {
        submit: submitNow,
        source: 'prompt-queue-replay',
      });
      const replayTransferred = submitNow
        ? res?.submitted === true && queueSendTransferredOwnership(res)
        : res?.success === true;
      if (!replayTransferred) {
        const err = res?.error || 'unknown';
        showToast('Replay failed: ' + err, 'error');
        console.warn('[PromptQueue] replay failed:', err);
        return;
      }
      if (submitNow && res.success === false) {
        console.warn('[PromptQueue] replay submitted but audit unverified; committing transfer tab=' + tabId.slice(-8) + ' item=' + id.slice(-8) + ' agent=' + sessionType + ' error=' + (res.error || 'unknown'));
      }
      // Paste succeeded — chip has effectively moved into agent input, drop
      // it from the queue so it cannot be double-fired by Run after later.
      removePrompt(tabId, id);
      // Focus terminal so the user sees the appended text immediately + can
      // submit with Enter. Without this, focus might be on the chip button
      // and the user has to click into the terminal first.
      if (inputSurface === 'history') focusHistoryComposer('replay-submit-after-ipc');
      else focusActiveTerminal('replay-after-ipc');
    } catch (e: unknown) {
      const m = (e as { message?: string })?.message || String(e);
      showToast('Replay failed: ' + m, 'error');
      console.error('[PromptQueue] replay error', e);
    } finally {
      setReplayingIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      replayingIdsRef.current.delete(id);
    }
  }, [tabId, sessionType, showToast, focusActiveTerminal, focusHistoryComposer, inputSurface, removePrompt]);

  useEffect(() => {
    const setCmd = (value: boolean) => {
      cmdPressedRef.current = value;
      setCmdPressed(value);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey) setCmd(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') setCmd(false);
    };
    const onBlur = () => setCmd(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const enqueueGrabbedPrompt = useCallback(async (
    text: string,
    images: number,
    imagePaths?: QueuedImageRef[],
    chips?: QueuedComposerChip[],
  ) => {
    const serializedDraft = serializeComposerDraft({ text, chips: chips || [] });
    const shortGrabTitle = getShortGrabPromptTitle(serializedDraft);
    const insertPromptTitle = shortGrabTitle ? null : await findSavedInsertPromptTitle(serializedDraft);
    const initialTitle = shortGrabTitle || insertPromptTitle;
    const id = addPrompt(tabId, text, images, imagePaths, initialTitle || undefined, chips);
    const titleWillGenerate = initialTitle ? false : generateRunAfterTitle(id, serializedDraft);
    if (!titleWillGenerate) markAppearing(id);
  }, [addPrompt, generateRunAfterTitle, markAppearing, tabId]);

  const grabCurrent = useCallback(async () => {
    try {
      if (inputSurface === 'history') {
        const ui = useUIStore.getState();
        const raw = ui.historyPromptDrafts[tabId] || '';
        const chips = normalizeComposerChips(
          ui.historyPromptDraftChips[tabId] || [],
        ) as QueuedComposerChip[];
        const serializedDraft = serializeComposerDraft({ text: raw, chips });
        if (!serializedDraft.trim()) {
          showToast(agentLabel + ' input is empty', 'warning');
          focusHistoryComposer('grab-empty-history');
          return;
        }
        const text = raw.trim();
        const historyImages = ui.historyPromptDraftImages[tabId] || [];
        const historyImageIds = collectPromptImageRefIds(raw);
        const historyAttachmentsBlocked = raw.includes('[Image saving…]')
          || /\[imageError:\s*[^\]\r\n]+\]/i.test(raw)
          || hasMalformedPromptImageMarker(raw, historyImages)
          || getPromptImageAttachmentState({
            text: raw,
            images: historyImageIds.size,
            imagePaths: historyImages,
          }) !== 'ready';
        if (historyAttachmentsBlocked) {
          showToast('Wait for the image attachment or repair its marker before moving this prompt', 'warning');
          focusHistoryComposer('grab-history-image-blocked');
          return;
        }
        const queueImages: QueuedImageRef[] = historyImages.map((ref) => ({
          id: ref.id,
          path: ref.path,
          assetId: ref.assetId,
          mediaType: ref.mediaType || 'image/png',
          size: Number(ref.size) || 0,
          availability: ref.availability,
          error: ref.error,
        }));
        await enqueueGrabbedPrompt(text, queueImages.length, queueImages, chips);
        const latestUi = useUIStore.getState();
        const latestRaw = latestUi.historyPromptDrafts[tabId] || '';
        const latestImages = latestUi.historyPromptDraftImages[tabId] || [];
        const latestChips = latestUi.historyPromptDraftChips[tabId] || [];
        const sourceStillCurrent = latestRaw === raw
          && haveSamePromptImageRefs(latestImages, historyImages)
          && haveSameComposerChips(latestChips, chips);
        if (sourceStillCurrent) {
          latestUi.setHistoryPromptDraft(tabId, '', {
            images: [],
            chips: [],
          });
        } else {
          console.log('[PromptQueue] grab snapshot queued; newer History draft preserved tab='
            + tabId.slice(-8)
            + ' snapshotChars=' + raw.length
            + ' latestChars=' + latestRaw.length
            + ' snapshotChips=' + chips.length
            + ' latestChips=' + latestChips.length
            + ' snapshotImages=' + historyImages.length
            + ' latestImages=' + latestImages.length);
        }
        focusHistoryComposer('grab-after-history-transfer');
        return;
      }
      const res = await ipcRenderer.invoke(sessionType + ':grab-input', tabId);
      if (res && res.success && typeof res.text === 'string') {
        const t = res.text.trim();
        if (!t) {
          showToast(agentLabel + ' input is empty', 'warning');
          focusActiveTerminal('grab-before-read');
          return;
        }
        await enqueueGrabbedPrompt(
          t,
          res.images || 0,
          Array.isArray(res.imagePaths) ? res.imagePaths : undefined,
        );
        // No success toast on queue-add — the new chip appearing in the overlay
        // is its own confirmation; the toast was redundant noise (user request).
        // Refocus so the agent re-reads the (now empty) tempfile immediately — without
        // this the input visually keeps the old text until user clicks the terminal.
        focusActiveTerminal('grab-after-write');
      } else {
        const code = res?.error || 'timeout';
        const msg = GRAB_ERROR_TOASTS[code] || `Grab failed: ${code}`;
        showToast(msg, 'error');
        console.warn('[PromptQueue] grab-input failed:', code);
      }
    } catch (e: unknown) {
      const m = (e as { message?: string })?.message || String(e);
      showToast(`Grab failed: ${m}`, 'error');
      console.error('[PromptQueue] grab-input error', e);
    }
  }, [tabId, sessionType, agentLabel, enqueueGrabbedPrompt, focusActiveTerminal, focusHistoryComposer, inputSurface, showToast]);

  // Copy moved to InfoPanel — see Copy prompt button next to Copy Session.

  // Toggle Run-after. If user disarms while a first-delay countdown is running,
  // freeze the remaining seconds back into firstDelaySeconds via the store so
  // the input shows "what's left" (not the original value).
  const toggleAutoRun = useCallback(() => {
    const next = !autoRun;
    const q = usePromptQueueStore.getState().getQueue(tabId);
    if (!next && q.firstDelayCountdownAt !== null) {
      usePromptQueueStore.getState().cancelFirstDelayCountdown(tabId);
    }
    setAutoRun(tabId, next);
    if (next) {
      setArmedFlash(true);
      setTimeout(() => setArmedFlash(false), 600);
    }
  }, [autoRun, tabId, setAutoRun]);

  const toggleHistoryPanel = useCallback(() => {
    const nextOpen = !historyPanelOpen;
    if (nextOpen && !timelinePinned) setTimelineTreeMode(tabId, false);
    setHistoryPanelOpen(tabId, nextOpen);
  }, [historyPanelOpen, tabId, timelinePinned, setHistoryPanelOpen, setTimelineTreeMode]);

  const toggleTimelineTree = useCallback(() => {
    const nextOpen = !timelineTreeMode;
    if (nextOpen && !historyPinned) setHistoryPanelOpen(tabId, false);
    setTimelineTreeMode(tabId, nextOpen);
  }, [timelineTreeMode, tabId, historyPinned, setHistoryPanelOpen, setTimelineTreeMode]);

  const expandPanel = useCallback(() => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    if (openingTimerRef.current !== null) {
      window.clearTimeout(openingTimerRef.current);
    }
    setPanelClosing(false);
    setPanelOpening(true);
    setPanelCollapsed(tabId, false);
    openingTimerRef.current = window.setTimeout(() => {
      setPanelOpening(false);
      openingTimerRef.current = null;
    }, PANEL_SLIDE_MS);
  }, [tabId, setPanelCollapsed]);

  const collapsePanel = useCallback(() => {
    commitEditor();
    if (openingTimerRef.current !== null) {
      window.clearTimeout(openingTimerRef.current);
      openingTimerRef.current = null;
    }
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
    }
    setPanelOpening(false);
    setPanelClosing(true);
    setPanelCollapsed(tabId, true);
    collapseTimerRef.current = window.setTimeout(() => {
      setPanelClosing(false);
      collapseTimerRef.current = null;
    }, PANEL_SLIDE_MS);
  }, [commitEditor, tabId, setPanelCollapsed]);

  useEffect(() => {
    return () => {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      if (openingTimerRef.current !== null) {
        window.clearTimeout(openingTimerRef.current);
        openingTimerRef.current = null;
      }
    };
  }, []);

  // ─── drag-and-drop reorder ───────────────────────────────────────────────
  const onDragStart = (id: string) => (e: React.DragEvent) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (dragOverIdx !== idx) setDragOverIdx(idx);
  };
  const onDrop = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragId) return;
    const fromIdx = items.findIndex((i) => i.id === dragId);
    if (fromIdx < 0) return;
    reorderPrompt(tabId, fromIdx, idx);
    setDragId(null);
    setDragOverIdx(null);
  };
  const onDragEnd = () => { setDragId(null); setDragOverIdx(null); };

  // chipRefs is still used: openEditor() needs each chip's top coordinate to
  // anchor the editor slideout next to the clicked chip.
  const chipRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const panelOpen = !collapsed || panelClosing;
  // History is now the primary surface, so its rail toggle is hidden there.
  // Collapse the former two-column top row to the exact width of one 30px
  // button plus the 1px parent border on each side; no dead inner padding.
  const collapsedRailWidth = hideHistoryToggle
    ? COLLAPSED_RAIL_COMPACT_WIDTH
    : COLLAPSED_RAIL_FULL_WIDTH;
  const arrowExpanded = !collapsed && !panelClosing;
  const addEditorActive = editorOpen && !isSpecialPromptMode && editingId === null;
  const railRunBg = autoRun
    ? (railRunHover ? '#342a52' : '#2b2340')
    : firstChipArmedHint
      ? (railRunHover ? 'rgba(127, 29, 29, 0.22)' : HINT_RED_BG)
      : activeItemCount
        ? (railRunHover ? '#303030' : '#242424')
        : (railRunHover ? '#3a241b' : '#2a1a14');
  const railRunBorder = autoRun
    ? (railRunHover ? '#a78bfa' : '#8b75d9')
    : firstChipArmedHint
      ? (railRunHover ? 'rgba(239, 68, 68, 0.48)' : HINT_RED_BORDER)
      : activeItemCount
        ? (railRunHover ? '#666' : '#4a4a4a')
        : (railRunHover ? TINT : '#8a4a37');

  // ─── render ──────────────────────────────────────────────────────────────
  return (
    <>
      {/* Main overlay — terminal-right, directly left of Timeline. The outer
          wrapper is intentionally transparent: the control rail lives outside
          the Run after panel, while the panel itself opens to the rail's left.
          rightInset shifts the anchor left only for expanded Timeline; History
          keeps the normal terminal-right position and this overlay sits above it. */}
      <div
        ref={panelRef}
        style={{
          position: 'absolute',
          top: 0,
          // Anchored edge — pinned, never moves during resize.
          ...(ANCHOR_SIDE === 'right' ? { right: rightInset } : { left: 0 }),
          // FIXED width (was `fit-content` clamped [min,max] → reflowed on +grab).
          // Drag-resizable via the handle on the free edge below.
          width: panelOpen ? effectiveWidth + COLLAPSED_RAIL_GAP + collapsedRailWidth : collapsedRailWidth,
          background: 'transparent',
          border: 'none',
          borderRadius: 0,
          zIndex: OVERLAY_Z_INDEX,
          fontSize: 11,
          color: '#ddd',
          maxHeight: '100%',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: ANCHOR_SIDE === 'right' ? 'flex-end' : 'flex-start',
          gap: panelOpen ? COLLAPSED_RAIL_GAP : 0,
          overflow: 'visible',
          pointerEvents: 'auto',
          transition: `width ${PANEL_SLIDE_MS}ms ease-out`,
          boxSizing: 'border-box',
        }}
      >
        <OrchestrationStatusChip
          tabId={tabId}
          rightOffset={panelOpen ? effectiveWidth + COLLAPSED_RAIL_GAP + collapsedRailWidth : collapsedRailWidth}
        />
        {panelOpen && (
          <div
            className={panelClosing ? 'pq-panel-closing' : (panelOpening ? 'pq-panel-opening' : undefined)}
            style={{
              position: 'relative',
              width: effectiveWidth,
              background: PANEL_BG,
              border: `1px solid ${BORDER}`,
              borderRadius: 6,
              backdropFilter: 'blur(8px)',
              maxHeight: '100%',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              boxSizing: 'border-box',
              flexShrink: 0,
              zIndex: 1,
            }}
          >
        {/* Resize handle on the FREE edge (opposite the anchor). Drag changes
            width only; height is governed by chip line-clamp in Settings, not
            here. `data-cmd-hover-popover` so a Cmd+Shift-pinned popover elsewhere
            isn't dismissed by the mousedown. Flush INSIDE the edge (left/right:0,
            width 6) — the panel is `overflow:hidden`, so an outside offset would
            be clipped to a sliver; the 6px zone sits over the header's left
            padding, not over any interactive control. */}
        <div
          data-cmd-hover-popover
          onMouseDown={startResize}
          title="Потяни — изменить ширину"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            ...(ANCHOR_SIDE === 'right' ? { left: 0 } : { right: 0 }),
            width: 6,
            cursor: 'ew-resize',
            zIndex: FLOATING_OVERLAY_Z_INDEX,
          }}
        />
        {/* Header row: first-delay timer input on left, Run/Stop pills on right.
            The title "Очередь" was removed — context is obvious from the panel.
            Timer input doubles as a countdown display when armed:
              idle  → shows pending firstDelaySeconds, editable.
              armed → shows live remaining seconds, read-only.
            "Run after" toggles autoRun. Arming with delay > 0 starts the countdown.
            Disarming mid-countdown freezes the remaining seconds back into the input.
            "Stop after" — stop the agent after the next turn ends (independent). */}
        {/* Two-column header layout — both columns ~120px to match the user's
            spec ("колонки одинаковой ширины, узкие — как раньше Stop after").
            Old `grid 90px 1fr` made the right column 2-3x wider than the
            left, which is why Run after / Stop after / Post visually felt
            "huge" vs the trigger on the left.
            Strict equal columns via `1fr 1fr`; cell padding kept compact
            (6px outer, 4px row gap). All children of each column are
            `width:100%` to fill the column — fixed cell width means no
            layout shift when the trigger flips between «on tab» / selected. */}
        <div style={{
          padding: '6px 8px',
          borderBottom: `1px solid ${BORDER}`,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          columnGap: 6,
          rowGap: 4,
        }}>
          {/* ── LEFT COLUMN ───────────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <RunAfterTabPicker
              tabId={tabId}
              autoRun={autoRun}
              runAfterTabId={runAfterTabId}
              setRunAfterTab={handleSetRunAfterTab}
              waitingTabIds={pendingQueueTabIds}
              panelRef={panelRef}
            />
            <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
              <FirstDelayInput tabId={tabId} autoRun={autoRun} />
            </div>
          </div>

          {/* ── RIGHT COLUMN ──────────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch', minWidth: 0 }}>

          {/* Run-after pill — row 1 of right column. Width: 100% of column.
              firstChipArmedHint: red blink + low-red resting state when user
              adds the first chip into an empty queue while Run after is OFF.
              Cleared only by pressing Run after or manually emptying the queue. */}
          <ControlHint
            label={autoRun ? 'Выключить автоматический запуск очереди' : 'Запустить очередь после штатного завершения turn'}
            shortcut={runAfterTabId ? 'Триггер — выбранная соседняя вкладка' : 'Триггер — текущая вкладка'}
            side="left"
          >
          <button
            onClick={toggleAutoRun}
            style={{
              position: 'relative',
              width: '100%',
              padding: '2px 6px',
              background: autoRun ? `${PULSE}26` : (firstChipArmedHint ? HINT_RED_BG : 'transparent'),
              border: `1px solid ${autoRun ? PULSE : (firstChipArmedHint ? HINT_RED_BORDER : BORDER)}`,
              borderRadius: 10,
              color: autoRun ? PULSE : (firstChipArmedHint ? HINT_RED_TEXT : TEXT_MUTED),
              cursor: 'pointer', fontSize: 9, letterSpacing: 0.3,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              whiteSpace: 'nowrap',
              transition: 'all 0.15s',
              boxShadow: armedFlash
                ? `0 0 6px ${PULSE}`
                : 'none',
            }}
          >
            {firstChipArmedHint && (
              <span
                key={blinkKey}
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: -1,
                  borderRadius: 10,
                  pointerEvents: 'none',
                  animation: `pq-hint-blink ${BLINK_CYCLE_MS}ms ease-in-out ${BLINK_ITERATIONS}`,
                }}
              />
            )}
            <span
              style={{
                width: 6, height: 6, borderRadius: '50%',
                background: autoRun ? PULSE : (firstChipArmedHint ? HINT_RED_DOT : '#555'),
                animation: autoRun && agentBusy ? 'pq-pulse 1.4s ease-in-out infinite' : 'none',
              }}
            />
            Run after
          </button>
          </ControlHint>

          {/* Stop/Close split-button — TWO independent toggles under one frame:
                Left zone  → stopAfter   (kill the agent after next turn ends).
                Right zone → closeAfter  (also remove the tab from TabBar).
              closeAfter implies stopAfter (you can't close a tab without killing
              its process), so toggling closeAfter ON auto-arms stopAfter in the
              store. Turning stopAfter OFF cascades closeAfter→OFF (no orphan
              "close-but-don't-stop" state).

              Visual states (single button, 4 combinations):
                neither           → grey frame, both zones grey
                stopAfter only    → orange frame, left zone orange-tinted,
                                    right zone stays grey (close not armed)
                closeAfter on     → red frame around BOTH zones, both red,
                                    left label switches to "Close after"
                (closeAfter+!stopAfter is impossible per cascade above)
              */}
          {(() => {
            // Derived colour roles. CLOSE_RED is the destructive accent used
            // both for the right-zone hover and for the full "Close after" state.
            const CLOSE_RED = '#ef4444';
            // ── Seam architecture (vertical line between left and right zones) ──
            // Old impl: left had `borderRight: 'none'`, right drew its own
            // `borderLeft` at BORDER (grey 0.08 alpha). That seam vanished on
            // re-mount because:
            //   (a) 0.08-alpha grey on dark bg + subpixel rounding on retina
            //       compositing → Chromium would discard the 1px draw, even
            //       though logically present. Re-toggling the state forced a
            //       full re-style which redrew it.
            //   (b) `transition: all 0.15s` animated border-color across
            //       tab-switches (overlay stays mounted, only tabId prop
            //       changes) — orange→grey fade over 150ms = the "подёргивание".
            // New impl: LEFT button owns the seam via its OWN `borderRight`
            // (full border, no `none`). Right button skips its left edge
            // (`borderLeft: 'none'`). Result: seam = leftBorder (orange when
            // stop, red when close, grey when idle) — always visible because
            // it's an integer-pixel border-right draw on a known-coloured
            // edge, not a 0.08-alpha grey shim. Plus the seam now reads as
            // "left zone owns it", which matches the visual semantics — the
            // active left zone projects its colour across the seam.
            //
            // Right zone outer borders (top/right/bottom) remain grey when
            // only stopAfter is armed — the right zone is NOT outlined orange,
            // satisfying the earlier constraint that "right power-off doesn't
            // claim stopAfter's colour".
            //
            // No `transition` on border/background here. Tab-switch must NOT
            // animate — instant snap to the new tab's state. Hover effects
            // on the right zone are still instant (JS onMouseEnter/Leave).
            const leftBorder = closeAfter
              ? CLOSE_RED
              : (stopAfter ? TINT : BORDER);
            const leftColor = closeAfter
              ? CLOSE_RED
              : (stopAfter ? TINT : TEXT_MUTED);
            const leftBg = closeAfter
              ? `${CLOSE_RED}26`
              : (stopAfter ? `${TINT}26` : 'transparent');
            // Right zone has its OWN palette — never inherits orange from
            // stopAfter. It is only red when closeAfter is on, grey otherwise.
            const rightBorder = closeAfter ? CLOSE_RED : BORDER;
            const rightColor = closeAfter ? CLOSE_RED : TEXT_MUTED;
            const rightBg = closeAfter ? `${CLOSE_RED}26` : 'transparent';
            return (
              <div style={{ display: 'flex', width: '100%' }}>
                <ControlHint
                  label={stopAfter ? `Не останавливать ${agentLabel} после очереди` : `Остановить ${agentLabel}, когда очередь закончится`}
                  side="left"
                >
                <button
                  onClick={() => setStopAfter(tabId, !stopAfter)}
                  title={'Stop ' + agentLabel + ' after the next turn ends (if queue is empty)'}
                  onMouseEnter={(e) => {
                    // Hover policy (per user spec): when zone is INACTIVE,
                    // hover tints ONLY the label colour — no border or bg
                    // changes. When already active, hover is a no-op (the
                    // active state already paints the colour).
                    if (stopAfter || closeAfter) return;
                    (e.currentTarget as HTMLElement).style.color = TINT;
                  }}
                  onMouseLeave={(e) => {
                    if (stopAfter || closeAfter) return;
                    (e.currentTarget as HTMLElement).style.color = TEXT_MUTED;
                  }}
                  style={{
                    flex: 1,
                    padding: '2px 6px',
                    background: leftBg,
                    border: `1px solid ${leftBorder}`,
                    borderTopLeftRadius: 10,
                    borderBottomLeftRadius: 10,
                    borderTopRightRadius: 0,
                    borderBottomRightRadius: 0,
                    color: leftColor,
                    cursor: 'pointer', fontSize: 9, letterSpacing: 0.3,
                    whiteSpace: 'nowrap',
                    display: 'grid',
                    gridTemplateColumns: 'auto',
                    alignItems: 'center',
                    justifyItems: 'center',
                  }}
                >
                  <span style={{ gridArea: '1 / 1', visibility: closeAfter ? 'visible' : 'hidden' }}>Close after</span>
                  <span style={{ gridArea: '1 / 1', visibility: closeAfter ? 'hidden' : 'visible' }}>Stop after</span>
                </button>
                </ControlHint>
                <ControlHint
                  label={closeAfter ? 'Не закрывать вкладку после остановки' : 'Закрыть вкладку после остановки агента'}
                  side="left"
                >
                <button
                  onClick={() => setCloseAfter(tabId, !closeAfter)}
                  title={'Also close this tab after ' + agentLabel + ' stops'}
                  style={{
                    padding: '2px 6px',
                    background: rightBg,
                    // Three-sided border. LEFT edge is intentionally OMITTED —
                    // the seam is owned by the left button's right border
                    // (see the comment block above). Drawing our own
                    // borderLeft here would either double-stroke at the seam
                    // (2px-wide line) or — worse — fight with the left
                    // button's borderRight on subpixel boundaries and one of
                    // the two would silently disappear at certain widths.
                    borderTop: `1px solid ${rightBorder}`,
                    borderRight: `1px solid ${rightBorder}`,
                    borderBottom: `1px solid ${rightBorder}`,
                    borderLeft: 'none',
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                    borderTopRightRadius: 10,
                    borderBottomRightRadius: 10,
                    color: rightColor,
                    cursor: 'pointer', lineHeight: 1,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  onMouseEnter={(e) => {
                    // Same policy as the left zone: hover paints ONLY the
                    // icon colour. No bg, no border — those are reserved
                    // for the active-state palette.
                    if (closeAfter) return;
                    (e.currentTarget as HTMLElement).style.color = CLOSE_RED;
                  }}
                  onMouseLeave={(e) => {
                    if (closeAfter) return;
                    (e.currentTarget as HTMLElement).style.color = TEXT_MUTED;
                  }}
                >
                  <Power size={11} strokeWidth={2.4} aria-hidden="true" />
                </button>
                </ControlHint>
              </div>
            );
          })()}

          {/* Post-prompt split-button: left zone toggles, right zone (✏) opens
              the editor. Active = orange (matches "command attached to every
              send"). Both zones share one rounded border for a single visual
              control. Full column-width to match Run after / Stop after rows. */}
          <div
            style={{
              display: 'flex',
              width: '100%',
              border: `1px solid ${postPromptEnabled ? TINT : BORDER}`,
              borderRadius: 10,
              overflow: 'hidden',
              transition: 'border-color 0.15s',
            }}
          >
            <ControlHint
              label={postPromptEnabled ? 'Не добавлять post-prompt к сообщениям очереди' : 'Добавлять post-prompt к каждому сообщению очереди'}
              side="left"
            >
            <button
              onClick={() => setPostPromptEnabled(tabId, !postPromptEnabled)}
              title={postPromptText ? 'Post-prompt: ' + (postPromptText.length > 60 ? postPromptText.slice(0, 60) + '…' : postPromptText) : 'Post-prompt is empty — click ✏ to add'}
              style={{
                flex: 1,
                padding: '2px 6px',
                background: postPromptEnabled ? `${TINT}26` : 'transparent',
                border: 'none',
                color: postPromptEnabled ? TINT : TEXT_MUTED,
                cursor: 'pointer', fontSize: 9, letterSpacing: 0.3,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                whiteSpace: 'nowrap',
                transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 11, lineHeight: 1 }}>▣</span>
              Post
            </button>
            </ControlHint>
            <ControlHint label="Изменить post-prompt" side="left">
            <button
              data-editor-trigger="post"
              onClick={openPostPromptEditor}
              title="Edit post-prompt text"
              style={{
                padding: '2px 6px',
                background: 'transparent',
                border: 'none',
                borderLeft: `1px solid ${postPromptEnabled ? TINT : BORDER}`,
                color: postPromptEnabled ? TINT : TEXT_MUTED,
                cursor: 'pointer', lineHeight: 1,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${TINT}1a`; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <Pencil size={11} strokeWidth={2.4} aria-hidden="true" />
            </button>
            </ControlHint>
          </div>

          {/* Loop is a standalone prompt sent again after every authoritative
              natural completion. It is intentionally separate from Post,
              which only decorates consumable queue items. */}
          <div
            style={{
              display: 'flex',
              width: '100%',
              border: `1px solid ${loopPromptEnabled ? PULSE : BORDER}`,
              borderRadius: 10,
              overflow: 'hidden',
              transition: 'border-color 0.15s',
            }}
          >
            <ControlHint
              label={loopPromptEnabled ? 'Остановить циклический prompt' : 'Отправлять prompt после каждого завершения'}
              side="left"
            >
            <button
              onClick={() => setLoopPromptEnabled(tabId, !loopPromptEnabled)}
              title={loopPromptText ? 'Loop: ' + (loopPromptText.length > 60 ? loopPromptText.slice(0, 60) + '…' : loopPromptText) : 'Loop is empty — click the pencil to add text'}
              style={{
                flex: 1,
                padding: '2px 6px',
                background: loopPromptEnabled ? `${PULSE}22` : 'transparent',
                border: 'none',
                color: loopPromptEnabled ? PULSE : TEXT_MUTED,
                cursor: 'pointer', fontSize: 9, letterSpacing: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                whiteSpace: 'nowrap',
                transition: 'all 0.15s',
              }}
            >
              <RefreshCw size={10} strokeWidth={2.2} />
              Loop
            </button>
            </ControlHint>
            <ControlHint label="Изменить циклический prompt" side="left">
            <button
              data-editor-trigger="loop"
              onClick={openLoopPromptEditor}
              title="Edit loop prompt"
              style={{
                padding: '2px 6px',
                background: 'transparent',
                border: 'none',
                borderLeft: `1px solid ${loopPromptEnabled ? PULSE : BORDER}`,
                color: loopPromptEnabled ? PULSE : TEXT_MUTED,
                cursor: 'pointer', lineHeight: 1,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${PULSE}1a`; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <Pencil size={11} strokeWidth={2.4} aria-hidden="true" />
            </button>
            </ControlHint>
          </div>

          </div>
          {/* end right column */}
        </div>

        {/* Clear-all row — only when queue has items */}
        {items.length > 0 && (
          <div style={{ padding: '2px 8px 4px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'flex-end' }}>
            <ControlHint label="Удалить все сообщения из очереди" side="left">
            <button
              onClick={() => items.forEach((i) => animateRemovePrompt(i.id))}
              style={{ background: 'transparent', border: 'none', color: TEXT_DIM, cursor: 'pointer', fontSize: 9, padding: 0 }}
            >clear all</button>
            </ControlHint>
          </div>
        )}

        {/* Chip list */}
        <div ref={chipListRef} style={{ overflowY: 'auto', flex: 1 }}>
          {items.length === 0 && (
            <div style={{ padding: '4px 8px', fontSize: 9, color: TEXT_DIM, textAlign: 'center', lineHeight: 1.2 }}>
              empty
            </div>
          )}
          {items.map((it, idx) => {
            const isEnabled = isQueuedPromptEnabled(it);
            const isTitleLoading = titleLoadingIds.has(it.id);
            const title = isTitleLoading ? '' : chipTitle(it);
            const isMultiLine = chipLineClamp > 1;
            const isEditing = editorOpen && editingId === it.id;
            const isDragOver = dragOverIdx === idx;
            const isDragging = dragId === it.id;
            const isRemoveHovered = removeHoverId === it.id;
            const isRemoving = removingIds.has(it.id);
            const isReplayHovered = replayHoverId === it.id;
            const isReplaySubmitMode = isReplayHovered && cmdPressed && !replayingIds.has(it.id);
            const attachmentState = getQueuedPromptAttachmentState(it);
            const malformedImageMarker = hasMalformedQueuedImageMarker(it.text, it.imagePaths);
            const chipClass = [
              'pq-chip',
              appearingIds.has(it.id) ? 'pq-chip-enter' : '',
              savedFlashIds.has(it.id) ? 'pq-chip-saved' : '',
              isRemoving ? 'pq-chip-removing' : '',
            ].filter(Boolean).join(' ');
            return (
              <div
                className={chipClass}
                key={it.id}
                ref={(el) => { if (el) chipRefs.current.set(it.id, el); else chipRefs.current.delete(it.id); }}
                draggable
                onDragStart={onDragStart(it.id)}
                onDragOver={onDragOver(idx)}
                onDrop={onDrop(idx)}
                onDragEnd={onDragEnd}
                onMouseDownCapture={(e) => {
                  if (e.button === 2) return;
                  const target = e.target as HTMLElement;
                  if (target.closest('[data-chip-action]')) return;
                  if (closePinnedEditorFromChip(it.id)) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
                onClick={(e) => {
                  // Ignore clicks that originated on the replay/remove buttons
                  // (they call stopPropagation themselves, but defensively skip
                  // here too in case event ordering changes). Body click =
                  // click pins the editor. Hover on ▶ is preview-only.
                  const target = e.target as HTMLElement;
                  if (target.closest('[data-chip-action]')) return;
                  if (isChipReopenSuppressed(it.id)) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                  }
                  openEditor(it.id, 'pin');
                }}
                onContextMenu={(e) => openChipContextMenu(it.id, e)}
                style={{
                  position: 'relative',
                  padding: '4px 7px',
                  margin: '2px 5px',
                  border: isRemoveHovered
                    ? `1px solid ${DELETE_RED}`
                    : (attachmentState === 'missing'
                      ? `1px solid ${DELETE_RED}99`
                      : (isEditing && editorPinned ? '1px solid rgba(190,190,190,0.34)' : `1px solid ${BORDER}`)),
                  borderRadius: 7,
                  background: isRemoveHovered
                    ? `${DELETE_RED}18`
                    : (!isEnabled
                      ? (isEditing || isDragOver ? DISABLED_PROMPT_BG_HOVER : DISABLED_PROMPT_BG)
                      : (isEditing ? `${TINT}1a` : (isDragOver ? `${PULSE}22` : 'transparent'))),
                  boxShadow: 'none',
                  cursor: isDragging ? 'grabbing' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'background 0.15s, border-color 0.15s',
                  // Prevent native text selection while dragging — the synthetic
                  // selection that appears when the cursor moves over the chip
                  // body during a drag looks broken (blue highlight covers the
                  // chip text). Belt-and-braces: HTML drag should suppress
                  // selection on its own, but Electron + macOS sometimes shows
                  // a stale Safari-ish selection mid-drag.
                  // Chip body is click-to-pin / drag-as-reorder — never an
                  // editable text region. Disable text selection always so
                  // double-clicks (or rapid clicks) don't highlight characters.
                  userSelect: 'none',
                  WebkitUserSelect: 'none',
                  overflow: 'hidden',
                }}
              >
                {/* Replay (▶) — paste chip text into agent input, no submit.
                    Sits where the ⋮⋮ drag-handle used to. Drag still works
                    from any point on the chip body — HTML5 draggable=true
                    captures the gesture regardless of click target as long
                    as the user holds + moves rather than clicking. */}
                <button
                  type="button"
                  data-chip-action="replay"
                  ref={(el) => { if (el) replayButtonRefs.current.set(it.id, el); else replayButtonRefs.current.delete(it.id); }}
                  disabled={replayingIds.has(it.id)}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    console.log('[PromptQueue] replay mousedown tab=' + tabId.slice(-8) + ' item=' + it.id.slice(-8) + ' meta=' + e.metaKey + ' disabled=' + replayingIds.has(it.id));
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (editorOpen) commitEditor({ wakeAutoRun: false });
                    const latestItem = usePromptQueueStore.getState().getQueue(tabId)
                      .items.find((p) => p.id === it.id);
                    if (!latestItem) {
                      console.log('[PromptQueue] replay skipped missing item tab='
                        + tabId.slice(-8) + ' item=' + it.id.slice(-8));
                      return;
                    }
                    const submitNow = e.metaKey;
                    cmdPressedRef.current = submitNow;
                    setCmdPressed(submitNow);
                    console.log('[PromptQueue] replay click tab=' + tabId.slice(-8) + ' item=' + it.id.slice(-8) + ' submit=' + submitNow + ' active=' + (document.activeElement?.tagName?.toLowerCase() || '-'));
                    replayChip(it.id, latestItem, { submit: submitNow });
                  }}
                  title={
                    replayingIds.has(it.id)
                      ? 'Replay in progress…'
                      : (isReplaySubmitMode
                        ? '⌘+click: paste and send'
                        : 'Replay: paste into ' + agentLabel + ' input. Hold ⌘ to send')
                  }
                  style={{
                    background: replayingIds.has(it.id)
                      ? `${TINT}26`
                      : (isReplaySubmitMode
                        ? `${SAVE_GREEN}30`
                        : (isReplayHovered ? `${TINT}26` : 'transparent')),
                    border: isReplaySubmitMode ? `1px solid ${SAVE_GREEN}88` : '1px solid transparent',
                    color: replayingIds.has(it.id)
                      ? TINT
                      : (isReplaySubmitMode ? SAVE_GREEN : (isReplayHovered ? TINT : TEXT_MUTED)),
                    cursor: replayingIds.has(it.id) ? 'default' : 'pointer',
                    padding: 0, lineHeight: 1, fontSize: 10,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 16, height: 16, borderRadius: 999,
                    transition: 'background 0.12s, border-color 0.12s, color 0.12s',
                    flexShrink: 0,
                    boxSizing: 'border-box',
                  }}
                  onMouseEnter={(e) => {
                    if (replayingIds.has(it.id)) return;
                    setReplayHoverId(it.id);
                    const effectiveCmd = e.metaKey;
                    cmdPressedRef.current = effectiveCmd;
                    setCmdPressed(effectiveCmd);
                    openEditor(it.id, 'hover');
                  }}
                  onMouseMove={(e) => {
                    if (replayingIds.has(it.id)) return;
                    cmdPressedRef.current = e.metaKey;
                    setCmdPressed(e.metaKey);
                  }}
                  onMouseLeave={() => {
                    if (replayingIds.has(it.id)) return;
                    setReplayHoverId((cur) => cur === it.id ? null : cur);
                  }}
                >{replayingIds.has(it.id) ? <span className="pq-spinner" /> : '▶'}</button>
                {isTitleLoading ? (
                  <span style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: chipTextLineHeight,
                    display: 'inline-flex',
                    alignItems: 'center',
                    color: isEnabled ? TEXT_DIM : DISABLED_PROMPT_TEXT,
                  }}>
                    <span className="pq-spinner" style={{ width: 9, height: 9, borderWidth: 1.25 }} />
                  </span>
                ) : isMultiLine ? (
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: promptQueueChipFontSize, lineHeight: `${chipTextLineHeight}px`,
                    color: isEnabled ? '#ddd' : DISABLED_PROMPT_TEXT,
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical' as const,
                    WebkitLineClamp: chipLineClamp,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'normal',
                    wordBreak: 'break-word',
                  }}>{title}</span>
                ) : (
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: promptQueueChipFontSize, lineHeight: `${chipTextLineHeight}px`, color: isEnabled ? '#ddd' : DISABLED_PROMPT_TEXT }}>{title}</span>
                )}
                {it.images > 0 && (
                  <span
                    title={attachmentState === 'missing'
                      ? (malformedImageMarker ? 'Image marker is damaged' : 'Image file is unavailable')
                      : (attachmentState === 'materializing' ? 'Saving image…' : `${it.images} image${it.images === 1 ? '' : 's'}`)}
                    style={{
                      color: attachmentState === 'missing' ? DELETE_RED : (attachmentState === 'materializing' ? '#eab308' : TINT),
                      fontSize: 9,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 2,
                      flexShrink: 0,
                      minWidth: 18,
                      height: 12,
                    }}
                  >
                    {attachmentState === 'missing'
                      ? <TriangleAlert size={10} strokeWidth={2} />
                      : (attachmentState === 'materializing'
                        ? <LoaderCircle size={10} strokeWidth={2} className="pq-spin-icon" />
                        : <Paperclip size={10} strokeWidth={2} />)}
                    <span>{it.images}</span>
                  </span>
                )}
                <ControlHint label="Удалить сообщение из очереди" side="left">
                <button
                  data-chip-action="remove"
                  onMouseEnter={() => setRemoveHoverId(it.id)}
                  onMouseLeave={() => setRemoveHoverId((cur) => cur === it.id ? null : cur)}
                  onClick={(e) => { e.stopPropagation(); animateRemovePrompt(it.id); }}
                  style={{
                    background: isRemoveHovered ? `${DELETE_RED}26` : 'transparent',
                    border: 'none',
                    color: isRemoveHovered ? DELETE_RED : TEXT_DIM,
                    cursor: 'pointer',
                    padding: 0,
                    lineHeight: 1,
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.12s, color 0.12s',
                  }}
                ><Trash2 size={13} strokeWidth={1.9} /></button>
                </ControlHint>
              </div>
            );
          })}
        </div>

        {/* Footer — grab + add. "Copy prompt" lives in InfoPanel next to Copy Session
            (single canonical location for clipboard ops, avoids duplicate buttons). */}
        <div style={{ display: 'flex', borderTop: `1px solid ${BORDER}` }}>
          <ControlHint label={`Забрать текущий prompt из ${agentLabel} в очередь`} side="left">
          <button
            onClick={grabCurrent}
            style={{ flex: 1, padding: '6px 4px', background: 'transparent', border: 'none', borderRight: `1px solid ${BORDER}`, color: '#aaa', cursor: 'pointer', fontSize: 10 }}
          >+ grab</button>
          </ControlHint>
          <ControlHint label="Добавить новое сообщение в очередь" side="left">
          <button
            data-editor-trigger="add"
            onClick={() => openEditor()}
            style={{
              flex: 1,
              padding: '6px 4px',
              background: addEditorActive ? `${TINT}26` : 'transparent',
              border: 'none',
              color: addEditorActive ? TINT : '#aaa',
              cursor: 'pointer',
              fontSize: 10,
              transition: 'background 0.12s, color 0.12s',
            }}
          >+ add</button>
          </ControlHint>
        </div>
          </div>
        )}
        <div
          className="pq-collapsed-rail"
          style={{
            width: collapsedRailWidth,
            position: 'relative',
            zIndex: 2,
            padding: 0,
            boxSizing: 'border-box',
            background: '#151515',
            border: '1px solid #303030',
            borderRadius: 16,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            flexShrink: 0,
          }}
        >
          <div className="pq-rail-top-row">
            <ControlHint label={timelineTreeMode ? 'Скрыть Timeline' : 'Открыть Timeline'} shortcut="⌘\\" side="left">
            <button
              className={`pq-rail-button pq-rail-meta${timelineTreeMode ? ' pq-rail-active' : ''}`}
              onClick={toggleTimelineTree}
              title="Timeline (Cmd+\\ / Opt+\\)"
              aria-label="Toggle Timeline"
            >
              {timelineTreeMode
                ? <PanelRightClose size={17} strokeWidth={2.1} />
                : <PanelRightOpen size={17} strokeWidth={2.1} />}
            </button>
            </ControlHint>
            {!hideHistoryToggle && (
              <ControlHint label={historyPanelOpen ? 'Скрыть History' : 'Открыть History'} shortcut="⌘]" side="left">
              <button
                className={`pq-rail-button pq-rail-meta${historyPanelOpen ? ' pq-rail-active' : ''}`}
                onClick={toggleHistoryPanel}
                title="History (Cmd+] / Opt+])"
                aria-label="Toggle History"
              >
                <History size={17} strokeWidth={2.1} />
              </button>
              </ControlHint>
            )}
          </div>
          <ControlHint label={(collapsed || panelClosing) ? 'Развернуть Run after' : 'Свернуть Run after'} side="left">
          <button
            className="pq-rail-button"
            onClick={() => {
              if (collapsed || panelClosing) {
                expandPanel();
              } else {
                collapsePanel();
              }
            }}
            title={(collapsed || panelClosing) ? 'Expand Run after' : 'Collapse Run after'}
            aria-label={(collapsed || panelClosing) ? 'Expand Run after' : 'Collapse Run after'}
          >
            <ChevronLeft
              className="pq-rail-chevron"
              size={18}
              strokeWidth={2.1}
              style={{ transform: arrowExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
            />
          </button>
          </ControlHint>
          <ControlHint
            label={autoRun ? 'Выключить автоматический запуск очереди' : 'Включить автоматический запуск очереди'}
            shortcut={`${activeItemCount} сообщений в очереди`}
            side="left"
          >
          <button
            className="pq-rail-button"
            onClick={toggleAutoRun}
            onMouseEnter={() => setRailRunHover(true)}
            onMouseLeave={() => setRailRunHover(false)}
            title={(autoRun ? 'Run after on' : 'Run after off') + ' · ' + activeItemCount + ' queued'}
            aria-label={(autoRun ? 'Run after on' : 'Run after off') + ', ' + activeItemCount + ' queued'}
            style={{
              position: 'relative',
              background: railRunBg,
              borderColor: railRunBorder,
              color: autoRun ? PULSE : (firstChipArmedHint ? HINT_RED_TEXT : (activeItemCount ? '#e5e5e5' : TINT)),
              fontSize: activeItemCount > 0 ? 12 : 18,
              fontWeight: activeItemCount > 0 ? 700 : 500,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            {firstChipArmedHint && (
              <span
                key={`rail-${blinkKey}`}
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: -1,
                  borderRadius: 999,
                  pointerEvents: 'none',
                  animation: `pq-hint-blink ${BLINK_CYCLE_MS}ms ease-in-out ${BLINK_ITERATIONS}`,
                }}
              />
            )}
            {activeItemCount > 0 ? (activeItemCount > 99 ? '99' : activeItemCount) : '•'}
          </button>
          </ControlHint>
          <ControlHint label={`Забрать текущий prompt из ${agentLabel} в очередь`} side="left">
          <button
            className="pq-rail-button pq-rail-primary"
            onClick={grabCurrent}
            title="+ grab"
            aria-label="Grab current input"
          >
            <Plus size={18} strokeWidth={2.2} />
          </button>
          </ControlHint>
        </div>
      </div>

      {chipContextMenu && chipContextItem && createPortal((() => {
        const enabled = isQueuedPromptEnabled(chipContextItem);
        const menuWidth = 206;
        const menuHeight = 74;
        const left = Math.max(8, Math.min(chipContextMenu.x, window.innerWidth - menuWidth - 8));
        const top = Math.max(8, Math.min(chipContextMenu.y, window.innerHeight - menuHeight - 8));
        const itemBase: CSSProperties = {
          width: '100%',
          minHeight: 30,
          padding: '6px 8px',
          background: 'transparent',
          border: 'none',
          borderRadius: 5,
          color: '#ddd',
          cursor: 'pointer',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          textAlign: 'left',
          fontFamily: 'inherit',
        };
        return (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              left,
              top,
              width: menuWidth,
              padding: 4,
              background: 'rgba(18,18,18,0.98)',
              border: `1px solid ${BORDER}`,
              borderRadius: 7,
              boxShadow: '0 10px 30px rgba(0,0,0,0.36)',
              zIndex: FLOATING_OVERLAY_Z_INDEX + 10,
              boxSizing: 'border-box',
            }}
          >
            <button
              onClick={() => toggleChipEnabled(chipContextItem.id)}
              style={{
                ...itemBase,
                background: enabled ? 'transparent' : DISABLED_PROMPT_BG,
                color: enabled ? '#ddd' : DISABLED_PROMPT_TEXT,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = enabled ? 'rgba(255,255,255,0.06)' : DISABLED_PROMPT_BG_HOVER; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = enabled ? 'transparent' : DISABLED_PROMPT_BG; }}
            >
              {enabled ? <CheckSquare size={14} strokeWidth={1.9} /> : <Square size={14} strokeWidth={1.9} />}
              <span style={{ flex: 1, minWidth: 0 }}>Отправлять из очереди</span>
            </button>
            <button
              onClick={() => regenerateChipTitle(chipContextItem.id)}
              disabled={titleLoadingIds.has(chipContextItem.id)}
              style={{
                ...itemBase,
                color: titleLoadingIds.has(chipContextItem.id) ? TEXT_DIM : '#ddd',
                cursor: titleLoadingIds.has(chipContextItem.id) ? 'default' : 'pointer',
              }}
              onMouseEnter={(e) => {
                if (titleLoadingIds.has(chipContextItem.id)) return;
                (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)';
              }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              {titleLoadingIds.has(chipContextItem.id)
                ? <span className="pq-spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
                : <RefreshCw size={14} strokeWidth={1.9} />}
              <span style={{ flex: 1, minWidth: 0 }}>Обновить название</span>
            </button>
          </div>
        );
      })(), document.body)}

      {/* Editor slideout — docked to the LEFT of the queue panel, no scrim.
          Anchored by editorAnchor: top aligned to chip/list/panel, right edge stays fixed.
          Resize controls only width; height stays content-driven by textarea rows. */}
      {!collapsed && !panelClosing && editorOpen && editorAnchor && (
        <div
          ref={editorRef}
          style={{
            position: 'fixed',
            top: editorAnchor.top,
            right: editorAnchor.right,
            width: editorSize.width,
            minWidth: EDITOR_MIN_WIDTH,
            minHeight: EDITOR_MIN_HEIGHT,
            maxHeight: editorAnchor.maxHeight,
            background: PANEL_BG,
            border: editorPinned ? '1px solid rgba(190,190,190,0.36)' : `1px solid ${BORDER}`,
            borderRadius: 6,
            boxShadow: editorPinned ? '0 0 0 1px rgba(190,190,190,0.10)' : 'none',
            backdropFilter: 'blur(8px)',
            zIndex: FLOATING_OVERLAY_Z_INDEX,
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
            boxSizing: 'border-box',
            // The workspace portal host is click-through so it does not cover
            // History outside Run After. This editor is a sibling of the main
            // overlay root, so it must opt back into hit testing explicitly.
            pointerEvents: 'auto',
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onFocusCapture={() => {
            setEditorFocusWithin(true);
          }}
          onBlurCapture={(e) => {
            const next = e.relatedTarget as Node | null;
            if (next && e.currentTarget.contains(next)) return;
            setEditorFocusWithin(false);
            window.setTimeout(() => {
              const active = document.activeElement;
              if (active && editorRef.current?.contains(active)) return;
              commitEditor(editorPinned ? { close: false } : undefined);
            }, 0);
          }}
        >
          {!isSpecialPromptMode && (
            <>
              <input
                ref={editorTitleInputRef}
                autoFocus={editorAutoFocus}
                value={editorTitle}
                onChange={(e) => {
                  editorDirtyFieldsRef.current.title = true;
                  setEditorTitle(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') resetEditor();
                }}
                style={{
                  height: editorTitleHeight,
                  flexShrink: 0,
                  background: '#0e0e0e',
                  color: '#ddd',
                  border: 'none',
                  padding: '0 8px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: promptQueueEditorFontSize,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ height: 1, flexShrink: 0, background: BORDER }} />
              {editorChips.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    padding: 6,
                    background: '#0e0e0e',
                    borderBottom: `1px solid ${BORDER}`,
                    flexShrink: 0,
                  }}
                >
                  {editorChips.map((chip) => {
                    const preview = chip.text.slice(0, 70).replace(/\s+/g, ' ')
                      + (chip.text.length > 70 ? '…' : '');
                    return (
                      <ComposerChip
                        key={chip.id}
                        kind={chip.kind}
                        label={chip.kind === 'prompt' ? (chip.label || 'PROMPT') : 'PASTE'}
                        preview={preview}
                        meta={chip.text.length.toLocaleString()}
                        onClick={() => setEditorChipPreviewId((current) => (
                          current === chip.id ? null : chip.id
                        ))}
                        trailing={(
                          <>
                            <button
                              type="button"
                              className="hp-composer-chip-action"
                              aria-label="Вернуть чип в текст"
                              title="Вернуть в текст"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                const textarea = editorTextareaRef.current;
                                const restored = restoreComposerChipToText({
                                  text: editorText,
                                  chipText: chip.text,
                                  selectionStart: textarea?.selectionStart ?? editorText.length,
                                  selectionEnd: textarea?.selectionEnd ?? editorText.length,
                                });
                                const nextChips = editorChips.filter((item) => item.id !== chip.id);
                                editorDirtyFieldsRef.current.text = true;
                                editorDirtyFieldsRef.current.chips = true;
                                setEditorText(restored.text);
                                setEditorChips(nextChips);
                                writeThroughEditorPayload(restored.text, nextChips);
                                setEditorChipPreviewId((current) => current === chip.id ? null : current);
                                requestAnimationFrame(() => {
                                  editorTextareaRef.current?.focus();
                                  editorTextareaRef.current?.setSelectionRange(restored.caret, restored.caret);
                                });
                              }}
                            >
                              <ArrowDown size={11} />
                            </button>
                            <button
                              type="button"
                              className="hp-composer-chip-action hp-composer-chip-action-danger"
                              aria-label="Удалить чип"
                              title="Удалить"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                const nextChips = editorChips.filter((item) => item.id !== chip.id);
                                editorDirtyFieldsRef.current.chips = true;
                                setEditorChips(nextChips);
                                writeThroughEditorPayload(editorText, nextChips);
                                setEditorChipPreviewId((current) => current === chip.id ? null : current);
                              }}
                            >
                              <X size={11} />
                            </button>
                          </>
                        )}
                      />
                    );
                  })}
                  {editorChipPreviewId && (() => {
                    const chip = editorChips.find((item) => item.id === editorChipPreviewId);
                    if (!chip) return null;
                    return (
                      <div className="hp-composer-chip-preview">
                        <div className="hp-composer-chip-preview-head">
                          <span>{chip.kind === 'prompt' ? (chip.label || 'Prompt') : 'Pasted content'}</span>
                          <span>{chip.text.length.toLocaleString()} symbols</span>
                        </div>
                        <pre>{chip.text}</pre>
                      </div>
                    );
                  })()}
                </div>
              )}
            </>
          )}
          <div
            style={{
              position: 'relative',
              flex: '0 0 auto',
              width: '100%',
              minHeight: editorTextareaMinHeight,
              maxHeight: editorAnchor.maxHeight - (isSpecialPromptMode ? 0 : editorTitleHeight + 1),
              background: '#0e0e0e',
              overflow: 'hidden',
            }}
          >
            <div
              ref={editorHighlightRef}
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                minHeight: editorTextareaMinHeight,
                overflow: 'hidden',
                color: '#ddd',
                padding: '6px 8px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: promptQueueEditorFontSize,
                lineHeight: 1.35,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
                boxSizing: 'border-box',
                pointerEvents: 'none',
              }}
            >
              {renderEditorHighlight(editorText, editorImageMarkerRanges)}
            </div>
            <textarea
              ref={editorTextareaRef}
              className="pq-image-marker-textarea"
              autoFocus={editorAutoFocus && isSpecialPromptMode}
              value={editorText}
              onChange={(e) => {
                const nextText = e.target.value;
                if (isSpecialPromptMode) editorDirtyFieldsRef.current.special = true;
                else editorDirtyFieldsRef.current.text = true;
                setEditorText(nextText);
                writeThroughEditorPayload(nextText, editorChips);
              }}
              onScroll={(e) => {
                const highlight = editorHighlightRef.current;
                if (!highlight) return;
                highlight.scrollTop = e.currentTarget.scrollTop;
                highlight.scrollLeft = e.currentTarget.scrollLeft;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') resetEditor();
                if (e.key === 'Enter' && e.metaKey) commitEditor();
              }}
              style={{
                position: 'relative',
                zIndex: 1,
                display: 'block',
                width: '100%',
                minHeight: editorTextareaMinHeight,
                maxHeight: editorAnchor.maxHeight - (isSpecialPromptMode ? 0 : editorTitleHeight + 1),
                background: 'transparent',
                color: 'transparent',
                WebkitTextFillColor: 'transparent',
                caretColor: '#ddd',
                border: 'none', padding: '6px 8px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: promptQueueEditorFontSize,
                lineHeight: 1.35,
                resize: 'none', outline: 'none',
                overflowY: 'hidden',
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div
            className="pq-editor-resize-handle"
            data-cmd-hover-popover
            onMouseDown={startEditorResize}
            title="Потяни — изменить ширину"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 7,
              cursor: 'ew-resize',
              zIndex: 70,
            }}
          />
          <div
            className="pq-editor-resize-handle pq-editor-resize-corner"
            data-cmd-hover-popover
            onMouseDown={startEditorResize}
            title="Потяни — изменить ширину"
            style={{
              position: 'absolute',
              left: 0,
              bottom: 0,
              width: 15,
              height: 15,
              cursor: 'ew-resize',
              zIndex: 71,
            }}
          />
        </div>
      )}

      {/* Pulse animation keyframes + hide number-input spinner.
          The spinner adds ~16px to the right of the input which shifted layout
          when the input narrowed under flex pressure (Run/after wrap bug). */}
      <style>{`
        @keyframes pq-pulse {
          0%, 100% { box-shadow: 0 0 0 0 ${PULSE}88; }
          50%      { box-shadow: 0 0 0 6px ${PULSE}00; }
        }
        /* First-chip hint blink: one red ring grows outward and fades. The
           low-red resting state remains until the user arms Run after or
           manually empties the queue. */
        @keyframes pq-hint-blink {
          0%   { box-shadow: 0 0 0 0    ${HINT_RED}cc; background: ${HINT_RED}33; }
          70%  { box-shadow: 0 0 0 5px  ${HINT_RED}00; background: ${HINT_RED}11; }
          100% { box-shadow: 0 0 0 0    ${HINT_RED}00; background: transparent; }
        }
        .pq-no-spin::-webkit-inner-spin-button,
        .pq-no-spin::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .pq-no-spin {
          -moz-appearance: textfield;
          appearance: textfield;
        }
        .pq-image-marker-textarea::selection {
          background: rgba(96, 165, 250, 0.30);
        }
        /* Replay button spinner — rotating ring shown while claude:append-input
           IPC roundtrip is in flight (~400-800ms). Plain CSS rotation, no GPU
           hit because the SVG is 10×10 — but background-color of the chip body
           does NOT change, so the spinner stays detectable on video forensics. */
        @keyframes pq-spin {
          to { transform: rotate(360deg); }
        }
        .pq-spinner {
          width: 10px; height: 10px; border-radius: 50%;
          border: 1.5px solid currentColor;
          border-right-color: transparent;
          animation: pq-spin 1.35s linear infinite;
          display: inline-block;
        }
        .pq-spin-icon {
          animation: pq-spin 1.35s linear infinite;
        }
        .pq-panel-opening {
          transform-origin: right top;
          animation: pq-panel-open ${PANEL_SLIDE_MS}ms ease-out both;
        }
        .pq-panel-closing {
          pointer-events: none;
          transform-origin: right top;
          animation: pq-panel-close ${PANEL_SLIDE_MS}ms ease-in both;
        }
        @keyframes pq-panel-open {
          0% {
            transform: translateX(calc(100% + ${COLLAPSED_RAIL_GAP}px));
          }
          100% {
            transform: translateX(0);
          }
        }
        @keyframes pq-panel-close {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(calc(100% + ${COLLAPSED_RAIL_GAP}px));
          }
        }
        .pq-rail-chevron {
          transition: transform ${PANEL_SLIDE_MS}ms ease-in-out;
        }
        .pq-rail-top-row {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          width: 100%;
        }
        .pq-rail-button {
          border: 1px solid #8a4a37;
          background: #2a1a14;
          color: ${TINT};
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
          width: 30px;
          min-width: 30px;
          max-width: 30px;
          height: 30px;
          min-height: 30px;
          max-height: 30px;
          flex: 0 0 30px;
          border-radius: 999px;
          padding: 0;
          line-height: 1;
          appearance: none;
          transition: background 0.12s, border-color 0.12s, color 0.12s, transform 0.08s;
        }
        .pq-rail-meta {
          background: #242424;
          border-color: #4a4a4a;
          color: #d6d6d6;
        }
        .pq-rail-button.pq-rail-active {
          background: #2b2340;
          border-color: #8b75d9;
          color: #c4b5fd;
        }
        .pq-rail-button:hover {
          background: #3a241b;
          border-color: ${TINT};
          color: #f3d0c2;
        }
        .pq-rail-button.pq-rail-active:hover {
          background: #342a52;
          border-color: #a78bfa;
          color: #ddd6fe;
        }
        .pq-rail-button:focus {
          outline: none;
        }
        .pq-rail-button:focus-visible {
          outline: none;
          box-shadow: 0 0 0 2px rgba(231, 106, 75, 0.38);
        }
        .pq-rail-button:active {
          transform: translateY(1px);
        }
        .pq-rail-primary {
          background: #3a2018;
          border-color: #a85840;
        }
        .pq-rail-primary:hover {
          background: #4a281d;
          border-color: ${TINT};
          color: ${TINT};
        }
        .pq-editor-resize-handle {
          background: transparent;
          transition: background 0.12s;
        }
        .pq-editor-resize-handle:hover {
          background: ${TINT}18;
        }
        .pq-editor-resize-corner::after {
          content: '';
          position: absolute;
          left: 3px;
          bottom: 3px;
          width: 6px;
          height: 6px;
          border-left: 1px solid rgba(255,255,255,0.22);
          border-bottom: 1px solid rgba(255,255,255,0.22);
          pointer-events: none;
        }
        .pq-chip::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: inherit;
          pointer-events: none;
          opacity: 0;
          transform: scaleX(0);
          z-index: 0;
        }
        .pq-chip > * {
          position: relative;
          z-index: 1;
        }
        .pq-chip-enter {
          animation: pq-chip-enter 520ms ease-out both;
        }
        .pq-chip-enter::before {
          background: ${SAVE_GREEN}2e;
          transform-origin: left center;
          animation: pq-chip-green-wipe 520ms ease-out both;
        }
        .pq-chip-saved::before {
          background: ${SAVE_GREEN}38;
          transform-origin: left center;
          animation: pq-chip-save-flash 520ms ease-out both;
        }
        .pq-chip-removing {
          pointer-events: none;
          will-change: clip-path, opacity, transform;
          animation: pq-chip-remove 260ms ease-in forwards;
        }
        .pq-chip-removing::before {
          background: ${DELETE_RED}32;
          transform-origin: right center;
          animation: pq-chip-delete-wipe 260ms ease-in forwards;
        }
        @keyframes pq-chip-enter {
          0% { opacity: 0; transform: translateX(-10px); }
          100% { opacity: 1; transform: translateX(0); }
        }
        @keyframes pq-chip-green-wipe {
          0% { opacity: 1; transform: scaleX(0); }
          55% { opacity: 1; transform: scaleX(1); }
          100% { opacity: 0; transform: scaleX(1); }
        }
        @keyframes pq-chip-save-flash {
          0% { opacity: 0; transform: scaleX(0); }
          35% { opacity: 1; transform: scaleX(1); }
          100% { opacity: 0; transform: scaleX(1); }
        }
        @keyframes pq-chip-delete-wipe {
          0% { opacity: 0; transform: scaleX(0); }
          40% { opacity: 1; transform: scaleX(1); }
          100% { opacity: 0.15; transform: scaleX(1); }
        }
        @keyframes pq-chip-remove {
          0% { opacity: 1; transform: translateX(0); clip-path: inset(0 0 0 0); }
          100% { opacity: 0; transform: translateX(-10px); clip-path: inset(0 100% 0 0); }
        }
      `}</style>
    </>
  );
}

// ─── FirstDelayInput ────────────────────────────────────────────────────────
// Replaces the old "Очередь" header text. Two modes driven by store state:
//   idle      — separate hour/minute/second inputs for the pending delay.
//   counting  — read-only countdown display ticking from N → 0 once per second.
// When countdown reaches 0 the runner pops + fires (we just stop ticking here).
// Disarming Run while counting freezes "what's left" back into firstDelaySeconds.
// Natural fire consumes the delay back to 0, rendered as 0 ч / 0 м / 0 с.
type FirstDelayInputProps = { tabId: string; autoRun: boolean };
type FirstDelayInputParts = { hours: string; minutes: string; seconds: string };
const FIRST_DELAY_FIELDS: Array<{
  key: keyof FirstDelayInputParts;
  unit: string;
  ariaLabel: string;
  max?: number;
}> = [
  { key: 'hours', unit: 'ч', ariaLabel: 'Часы задержки' },
  { key: 'minutes', unit: 'м', ariaLabel: 'Минуты задержки', max: 59 },
  { key: 'seconds', unit: 'с', ariaLabel: 'Секунды задержки', max: 59 },
];

function firstDelayInputParts(value: number): FirstDelayInputParts {
  const parts = splitFirstDelaySeconds(value);
  return {
    hours: String(parts.hours),
    minutes: String(parts.minutes),
    seconds: String(parts.seconds),
  };
}

function firstDelayCountdownParts(value: number): FirstDelayInputParts {
  const parts = splitFirstDelaySeconds(value);
  return {
    hours: String(parts.hours),
    minutes: String(parts.minutes),
    seconds: String(parts.seconds),
  };
}

function FirstDelayInput({ tabId, autoRun }: FirstDelayInputProps) {
  const cfg = usePromptQueueStore((s) => s.queues.get(tabId)?.firstDelaySeconds ?? 0);
  const countdownAt = usePromptQueueStore((s) => s.queues.get(tabId)?.firstDelayCountdownAt ?? null);
  const setFirstDelaySeconds = usePromptQueueStore((s) => s.setFirstDelaySeconds);
  const [parts, setParts] = useState<FirstDelayInputParts>(() => firstDelayInputParts(cfg));
  const skipNextBlurRef = useRef(false);

  // External writes (countdown finished, cancel-edit, etc) → mirror into local
  // input only when we're NOT counting (counting mode renders from `remaining`).
  useEffect(() => {
    if (countdownAt !== null) return;
    setParts(firstDelayInputParts(cfg));
  }, [cfg, countdownAt]);

  // Tick once per second while counting. State is fully derivable from store
  // (firstDelaySeconds + firstDelayCountdownAt), no local timer state needed.
  const [, force] = useState(0);
  useEffect(() => {
    if (countdownAt === null) return;
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [countdownAt]);

  const remaining = countdownAt !== null
    ? getFirstDelayRemainingSeconds(cfg, countdownAt)
    : null;

  // Counting keeps the same three-field geometry as editing. At the hour
  // boundary the user sees 1:00:00 → 0:59:59 instead of a replacement label.
  if (remaining !== null) {
    const countdownParts = firstDelayCountdownParts(remaining);
    return (
      <ControlHint label="Осталось до отправки первого сообщения" shortcut="Выключение Run after отменит таймер" side="left">
      <div
        role="group"
        aria-label="Обратный отсчёт Run after"
        data-first-delay-countdown
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 2,
          width: '100%',
          minWidth: 0,
        }}
        title={`${formatFirstDelayCountdown(remaining)} до отправки первого сообщения`}
      >
        {FIRST_DELAY_FIELDS.map((field) => (
          <label
            key={field.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              height: 21,
              background: `${PULSE}12`,
              border: `1px solid ${PULSE}`,
              borderRadius: 4,
              boxSizing: 'border-box',
              cursor: 'default',
            }}
          >
            <input
              type="number"
              className="pq-no-spin"
              value={countdownParts[field.key]}
              readOnly
              tabIndex={-1}
              aria-label={`${field.ariaLabel}, осталось`}
              style={{
                width: '100%',
                minWidth: 0,
                padding: '2px 1px 2px 3px',
                background: 'transparent',
                border: 'none',
                color: PULSE,
                fontSize: 10,
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right',
                outline: 'none',
                cursor: 'default',
                boxSizing: 'border-box',
              }}
            />
            <span
              aria-hidden="true"
              style={{
                flexShrink: 0,
                paddingRight: 2,
                color: PULSE,
                fontSize: 8,
                userSelect: 'none',
              }}
            >
              {field.unit}
            </span>
          </label>
        ))}
      </div>
      </ControlHint>
    );
  }

  // Editable duration — three compact fields, persisted as the existing total
  // seconds value so old saved queues remain compatible.
  // Disabled while autoRun is on but countdown hasn't started yet (delay=0
  // immediate-fire path) — kept readable, just locked out so the user doesn't
  // race the runner with a mid-arm edit.
  const disabled = autoRun;
  const resetParts = () => setParts(firstDelayInputParts(cfg));
  const commitParts = () => {
    const parsed = {
      hours: parts.hours.trim() === '' ? 0 : Number(parts.hours),
      minutes: parts.minutes.trim() === '' ? 0 : Number(parts.minutes),
      seconds: parts.seconds.trim() === '' ? 0 : Number(parts.seconds),
    };
    if (Object.values(parsed).some((value) => !Number.isFinite(value) || value < 0)) {
      resetParts();
      return;
    }
    const total = combineFirstDelayParts(parsed.hours, parsed.minutes, parsed.seconds);
    setFirstDelaySeconds(tabId, total);
    setParts(firstDelayInputParts(total));
  };
  return (
    <ControlHint label="Задержка перед первым сообщением очереди" shortcut="часы · минуты · секунды" side="left">
    <div
      role="group"
      aria-label="Задержка Run after"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 2,
        width: '100%',
        minWidth: 0,
      }}
    >
      {FIRST_DELAY_FIELDS.map((field) => (
        <label
          key={field.key}
          style={{
            display: 'flex',
            alignItems: 'center',
            minWidth: 0,
            height: 21,
            background: '#1a1a1a',
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            boxSizing: 'border-box',
            cursor: disabled ? 'not-allowed' : 'text',
          }}
        >
          <input
            type="number"
            className="pq-no-spin"
            min={0}
            max={field.max}
            step={1}
            inputMode="numeric"
            aria-label={field.ariaLabel}
            value={parts[field.key]}
            disabled={disabled}
            onChange={(event) => {
              setParts((current) => ({ ...current, [field.key]: event.target.value }));
            }}
            onBlur={() => {
              if (skipNextBlurRef.current) {
                skipNextBlurRef.current = false;
                return;
              }
              commitParts();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
              if (event.key === 'Escape') {
                event.preventDefault();
                skipNextBlurRef.current = true;
                resetParts();
                (event.target as HTMLInputElement).blur();
              }
            }}
            style={{
              width: '100%',
              minWidth: 0,
              padding: '2px 1px 2px 3px',
              background: 'transparent',
              border: 'none',
              color: disabled ? TEXT_DIM : '#ddd',
              fontSize: 10,
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'right',
              outline: 'none',
              cursor: disabled ? 'not-allowed' : 'text',
              boxSizing: 'border-box',
            }}
          />
          <span
            aria-hidden="true"
            style={{
              flexShrink: 0,
              paddingRight: 2,
              color: disabled ? TEXT_DIM : TEXT_MUTED,
              fontSize: 8,
              userSelect: 'none',
            }}
          >
            {field.unit}
          </span>
        </label>
      ))}
    </div>
    </ControlHint>
  );
}
