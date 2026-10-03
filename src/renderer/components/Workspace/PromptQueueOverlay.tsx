import { usePointerGesture } from '../../hooks/usePointerGesture';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, ArrowDown, CheckSquare, ChevronLeft, ChevronRight, LoaderCircle, MoreHorizontal, Paperclip, Pause, Pencil, Percent, Play, Plus, RefreshCw, RotateCcw, RotateCw, SlidersHorizontal, Square, Timer, Trash2, TriangleAlert, X } from 'lucide-react';
import { ComposerChip } from '@noted/claude-blocks';
import { AttachmentPreviewToolbar } from './AIConversation/PastedContentPreview';
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerInlineToken,
} from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';
import { acquirePromptQueueEditorLock, buildQueuedPromptPayload, countEnabledQueuedPrompts, ensureQueuedPromptImagesReady, getQueuedImageMarkerHighlightRanges, getQueuedPromptAttachmentState, getQueuedPromptLocalCommand, getShortGrabPromptTitle, hasMalformedQueuedImageMarker, hasPendingPromptQueueContinuation, isQueuedPromptEnabled, makeDefaultPromptTitle, queuedMetaActionDefaultTitle, queueSendTransferredOwnership, releasePromptQueueEditorLock, usePromptQueueStore, type QueuedComposerChip, type QueuedImageRef, type QueuedPrompt } from '../../store/usePromptQueueStore';
import { DEFAULT_RUN_AFTER_TITLE_PROMPT, RUN_AFTER_TITLE_PROMPT_ID, usePromptsStore } from '../../store/usePromptsStore';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { claudeEffortsForModel } from '../../constants/claudeLevels';
import { CODEX_EFFORT_LEVELS, mergeCodexModelOptions } from '../../constants/codexSettings';
import { isTabBusyNow, signalPromptQueueDictationResolved } from '../../hooks/usePromptQueueRunner';
import { DEFAULT_RUN_AFTER_PANEL_COLLAPSED } from '../../utils/promptQueuePanelDefault.mjs';
import { getHistoryAgentRuntime } from '../../utils/historyAgentRuntimes';
import { sendAgentPromptScenario } from '../../utils/agentScenarios';
import { AGENT_SETTINGS_INTENT_NONE } from '../../utils/agentSendSettingsContract';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { generateTitleFromPromptWithConfig, trimTabTitlePrompt } from '../../utils/generateTabTitle';
import {
  collectPromptImageRefIds,
  getPromptImageStatusTokenRanges,
  hasMalformedPromptImageMarker,
  haveSamePromptImageRefs,
  inspectPromptImageAttachments,
  insertPromptImageAttachments,
  remapPromptImageSelectionAfterReplacement,
  retainPromptImageRefsForText,
} from '../../utils/promptImageAttachments.mjs';
import { applyMarkerAwareWordMotion } from '../../utils/composerWordMotion';
import {
  buildPasteChipMarker,
  getPasteMarkerHighlightRanges,
  haveSameComposerChips,
  insertComposerSnapshotAtSelection,
  normalizeComposerChips,
  restoreComposerChipToText,
  retainPasteChipsForText,
  serializeComposerDraft,
  shouldCreatePasteChip,
} from '../../utils/composerChips.mjs';
import {
  composerImageUrl,
  useComposerImagePreview,
  useComposerImagePreviews,
} from '../../utils/composerImagePreview';
import {
  buildComposerClipboardText,
  buildPortableImageImportSnapshot,
  collapsePortableImageImportSnapshot,
  collectPortableImagePathMarkers,
} from '../../utils/composerClipboard.mjs';
import {
  electronComposerClipboardAdapter,
  isElectronDictationClipboardPayload,
} from '../../utils/electronComposerClipboardAdapter';
import { resolveRunAfterPreviewPlacement } from '../../utils/runAfterPreviewPlacement.mjs';
import { resolveRunAfterPlayAppearance } from '../../utils/runAfterPlayAppearance';
import { pointInHoverCluster, pointInRect } from '../../utils/hoverBridge.mjs';
import { shouldDisarmAfterTriggerClear } from '../../utils/runAfterTriggerClear.mjs';
import { consumePromptQueueMiddleClick } from '../../utils/promptQueueMiddleClick.mjs';
import { getAppRuntimeIdentity } from '../../utils/appRuntimeIdentity';
import { shouldArmQueueForTrigger } from '../../utils/promptTriggerArm.mjs';
import {
  getHistoryPromptHandoffsSnapshot,
  historyPromptHandoffInitialStatus,
  runHistoryPromptHandoff,
  subscribeHistoryPromptHandoffs,
} from '../../utils/historyPromptHandoffs';
import {
  buildPromptQueueReceiptHandoffId,
  selectPromptQueueTransportProgress,
} from '../../utils/promptQueueReceiptIdentity.mjs';
import {
  combineFirstDelayParts,
  formatFirstDelayCountdown,
  getFirstDelayRemainingSeconds,
  splitFirstDelaySeconds,
} from '../../utils/promptQueueDelay';
import { RunAfterTabPicker } from './RunAfterTabPicker';
import { OrchestrationStatusChip } from './OrchestrationStatusChip';
import { AIComposerImagePreview } from './AIConversation/AIComposerSurface';
import ControlHint from '../UI/ControlHint';
import { AGENT_DRAFT_CAPTURE_ERRORS } from '../../utils/agentDraftCaptureErrors';
import { adoptAgentDraftTransferOnce, readAgentDraftTransfer, recoverAgentDraftTransferToHistory } from '../../utils/agentDraftTransfer.mjs';
import { AutoCompactControl } from './AutoCompactControl';
import { requestQueuedRewindTarget as publishQueuedRewindTarget, cancelQueuedRewindTarget } from '../../utils/queuedRewindTarget.mjs';
import {
  getDictationChip,
  getDictationChipsSnapshot,
  moveDictationChipsToRunAfter,
  reconcileDictationChipsForRunAfterItem,
  setDictationChipStatus,
  subscribeDictationChips,
} from '../../utils/dictationChipRegistry.mjs';
import {
  dictationTokenLabel,
  getDictationMarkerRanges,
} from '../../utils/dictationChips.mjs';
import { retryVoiceRecordDictation } from '../../utils/voiceRecordClient.mjs';

const { ipcRenderer, clipboard } = window.require('electron');

// Map main-process error codes from claude:grab-input → user-facing toast strings.
// English for consistency with the button labels.
const GRAB_ERROR_TOASTS: Record<string, string> = {
  ...AGENT_DRAFT_CAPTURE_ERRORS,
  no_terminal: 'No terminal for this tab',
  no_claude_session: 'No Claude session running in this tab',
  no_codex_session: 'No Codex session running in this tab',
  no_codex_pid: 'No Codex process found in this tab',
  claude_busy: 'Claude is busy — wait for the response to finish',
  codex_ctrl_g_noop: 'Codex did not open the prompt editor — wait for the response to finish',
  codex_slash_completion_frame_unconfirmed: 'Codex command menu is still updating — draft preserved, try again',
  codex_slash_completion_identity_changed: 'Codex input changed while preparing the transfer — review it and retry',
  codex_slash_completion_dismiss_unconfirmed: 'Codex command menu did not close — draft preserved, try again',
  codex_slash_draft_changed_during_dismiss: 'Codex input changed while closing the command menu — action stopped',
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
const PANEL_BG = 'rgba(20,20,20,0.92)';
const BORDER = 'rgba(255,255,255,0.08)';
const PINNED_PANEL_BORDER = 'rgba(255,255,255,0.22)';
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

type RunAfterComposerAggregate = {
  imagePaths: QueuedImageRef[];
  chips: QueuedComposerChip[];
};

const runAfterComposerAggregateEqual = (left: unknown, right: unknown) => {
  const a = left as RunAfterComposerAggregate | null;
  const b = right as RunAfterComposerAggregate | null;
  if (!a || !b) return a === b;
  return JSON.stringify(a.imagePaths) === JSON.stringify(b.imagePaths)
    && haveSameComposerChips(a.chips, b.chips);
};

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
const EDITOR_PREVIEW_GAP = 8;
const EDITOR_PREVIEW_MAX_WIDTH = 440;
const EDITOR_PREVIEW_MIN_SIDE_WIDTH = 260;
// The panel's border-mounted policy controls occupy this gap. It is not empty
// layout: Post/Loop/… straddle the frame here without colliding with the always
// available count + Play/Pause rail above.
const COLLAPSED_RAIL_GAP = 11;
// Блоки, открытые ИЗ панели: они лежат прямо в body (иначе их обрезала бы
// панель со своим `overflow: hidden`), поэтому находятся по метке, а не по
// вложенности. Кнопка-счётчик добавляется отдельно через свой ref.
const HOVER_CLUSTER_SELECTOR = [
  '[data-run-after-picker-menu]',
  '[data-prompt-queue-chip-menu]',
  '[data-prompt-queue-meta-actions]',
  '[data-run-after-satellite]',
].join(', ');
// Допуск по краю: субпиксельные координаты панели и округление позиции курсора
// иначе дают «курсор снаружи» на самой границе.
const HOVER_CLUSTER_PAD = 2;

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
const RESIZE_MIN_WIDTH = 168;
const RESIZE_MAX_WIDTH = 600;
const RUN_AFTER_IMAGE_PENDING_MARKER = '[Image saving…]';

const runAfterImageNotice = (text: string, imagePaths: QueuedImageRef[]) => {
  if (String(text || '').includes(RUN_AFTER_IMAGE_PENDING_MARKER)) {
    return { message: 'Saving image attachment…', blocking: true, progress: true };
  }
  const inspection = inspectPromptImageAttachments(text, imagePaths || []);
  if (inspection.firstBlocking) {
    const issue = inspection.firstBlocking as {
      id?: number | null;
      marker?: string;
      excerpt?: string;
    };
    const marker = issue.id ? `[Image #${issue.id}]` : (issue.marker || '[Image marker]');
    return {
      message: `${marker} is damaged or has no exact attachment. Near “${issue.excerpt || marker}”. Restore the complete marker or remove it before Run after can send.`,
      blocking: true,
      progress: false,
    };
  }
  if (inspection.firstUnavailable) {
    const issue = inspection.firstUnavailable as {
      id?: number | null;
      marker?: string;
      path?: string | null;
      excerpt?: string;
    };
    const marker = issue.id ? `Image #${issue.id}` : (issue.marker || 'Image attachment');
    const pathPart = issue.path ? ` File: ${issue.path}.` : '';
    return {
      message: `${marker} is unavailable.${pathPart} Run after remains enabled; this slot will be sent as an explicit imageError. Near “${issue.excerpt || marker}”.`,
      blocking: false,
      progress: false,
    };
  }
  return null;
};

const createQueuedComposerChipId = () => (
  'paste-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
);

function chipTitle(item: QueuedPrompt): string {
  return (item.title || '').trim() || makeDefaultPromptTitle(item.text, item.images, item.chips?.length || 0);
}

function takeLeadingChars(value: string, count: number): string {
  return Array.from(value).slice(0, count).join('');
}

function shouldPreservePinnedEditorOnOutsideClick(target: Element | null): boolean {
  return !!target?.closest('[data-tab-item], [data-workspace-navigation]');
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
type EditorAnchorMode = 'panel' | 'list' | 'list-end';
type MetaActionsView = 'actions' | 'models' | 'efforts';
type QueueSettingsModel = { id: string; label: string; efforts: string[] };

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
  embedded?: boolean;
  embeddedPinned?: boolean;
  embeddedWidth?: number;
  embeddedMaxHeight?: number;
  beforeCloseRef?: { current: (reason?: 'outside') => boolean };
  onRewindTargetModeChange?: (active: boolean) => void;
  onHoverGestureChange?: (active: boolean, point: { clientX: number; clientY: number } | null) => void;
};

export function PromptQueueOverlay({
  tabId,
  sessionType,
  agentBusy,
  rightInset = 0,
  inputSurface = 'terminal',
  embedded = false,
  embeddedPinned = false,
  embeddedWidth = 460,
  embeddedMaxHeight = 430,
  beforeCloseRef,
  onRewindTargetModeChange,
  onHoverGestureChange,
}: Props) {
  const FLOATING_OVERLAY_Z_INDEX = embedded ? 15100 : 130;
  const [localPreviewId, setLocalPreviewId] = useState<string | null>(null);
  const agentLabel = AGENT_LABEL[sessionType];
  const chipLineClamp = useUIStore((s) => s.promptQueueChipLineClamp);
  const promptQueueChipFontSize = useUIStore((s) => s.promptQueueChipFontSize);
  const promptQueueEditorFontSize = useUIStore((s) => s.promptQueueEditorFontSize);
  const claudeCodeSettings = useUIStore((s) => s.claudeCodeSettings);
  const codexSettings = useUIStore((s) => s.codexSettings);
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
  const [promptTransportHandoffs, setPromptTransportHandoffs] = useState<readonly any[]>(
    () => getHistoryPromptHandoffsSnapshot(tabId),
  );
  useEffect(() => subscribeHistoryPromptHandoffs(
    tabId,
    (snapshot) => setPromptTransportHandoffs(snapshot),
  ), [tabId]);
  const promptTransportProgress = useMemo(() => selectPromptQueueTransportProgress(
    promptTransportHandoffs,
    items.map((item) => item.id),
  ), [items, promptTransportHandoffs]);
  const promptTransportPending = !!promptTransportProgress;
  const activeItemCount = useMemo(() => countEnabledQueuedPrompts(items), [items]);
  const autoRun = queue?.autoRun ?? false;
  const postPromptEnabled = queue?.postPromptEnabled ?? false;
  const postPromptText = queue?.postPromptText ?? '';
  const loopPromptEnabled = queue?.loopPromptEnabled ?? false;
  const loopPromptText = usePromptQueueStore((s) => s.sharedLoopPromptText);
  // Вкладка без своей записи в очереди = новая вкладка → свёрнуто. Локальный
  // `?? false` здесь раньше означал «развёрнуто» и переспорил бы дефолт стора.
  const collapsed = embedded ? false : queue?.panelCollapsed ?? DEFAULT_RUN_AFTER_PANEL_COLLAPSED;
  const firstChipArmedHint = queue?.firstChipHintActive ?? false;
  const runAfterTabId = queue?.runAfterTabId ?? null;
  const pinnedPreviewId = embedded ? localPreviewId : queue?.previewId ?? null;
  const {
    addPrompt, addMetaAction, removePrompt, updatePrompt, reorderPrompt,
    setPromptTrigger, setPromptCondition,
    setAutoRun,
    setPostPromptEnabled, setPostPromptText,
    setLoopPromptEnabled, setLoopPromptText,
    setPanelCollapsed: setStoredPanelCollapsed, setPreviewId: setStoredPreviewId,
    // popNext is consumed by hooks/usePromptQueueRunner.ts — not referenced here.
  } = usePromptQueueStore.getState();
  const setPanelCollapsed = useCallback((id: string, value: boolean) => {
    if (!embedded) setStoredPanelCollapsed(id, value);
  }, [embedded, setStoredPanelCollapsed]);
  const setPreviewId = useCallback((id: string, value: string | null) => {
    if (embedded) setLocalPreviewId(value); else setStoredPreviewId(id, value);
  }, [embedded, setStoredPreviewId]);

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
  const [editorImagePaths, setEditorImagePaths] = useState<QueuedImageRef[]>([]);
  const editorHistoryPayload = useMemo<RunAfterComposerAggregate>(() => ({
    imagePaths: editorImagePaths,
    chips: editorChips,
  }), [editorChips, editorImagePaths]);
  const deriveEditorHistoryPayload = useCallback((nextText: string, previous: unknown) => {
    const aggregate = previous as RunAfterComposerAggregate | null;
    return {
      imagePaths: retainPromptImageRefsForText(
        nextText,
        aggregate?.imagePaths || [],
      ) as QueuedImageRef[],
      chips: retainPasteChipsForText(
        nextText,
        aggregate?.chips || [],
      ) as QueuedComposerChip[],
    } satisfies RunAfterComposerAggregate;
  }, []);
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
  const dragIdRef = useRef<string | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [armedFlash, setArmedFlash] = useState(false);
  // Anchor for the editor modal — when set, the modal aligns its right edge to this rect's left edge
  // and its top edge to this rect's top edge. null = anchor to the whole panel's top-right corner.
  const [editorAnchor, setEditorAnchor] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const [editorSize, setEditorSize] = useState<{ width: number }>({
    width: EDITOR_WIDTH,
  });
  const [editorViewport, setEditorViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [editorMeasuredHeight, setEditorMeasuredHeight] = useState(EDITOR_MIN_HEIGHT);
  const [appearingIds, setAppearingIds] = useState<Set<string>>(new Set());
  const [savedFlashIds, setSavedFlashIds] = useState<Set<string>>(new Set());
  const [titleLoadingIds, setTitleLoadingIds] = useState<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [removeHoverId, setRemoveHoverId] = useState<string | null>(null);
  const [chipContextMenu, setChipContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [onTabTriggerDraftIds, setOnTabTriggerDraftIds] = useState<Set<string>>(() => new Set());
  // Per-element "open the tab list now" pulse. Set once when the user picks
  // «Добавить on tab» in the context menu, so the picker opens by itself
  // instead of requiring a second click on the empty row. A monotonic counter
  // is used because the picker consumes the key by value change.
  const [onTabTriggerOpenKeys, setOnTabTriggerOpenKeys] = useState<Map<string, number>>(() => new Map());
  const onTabTriggerOpenSeqRef = useRef(0);
  const [timerTriggerDraftIds, setTimerTriggerDraftIds] = useState<Set<string>>(() => new Set());
  const [contextConditionFocusIds, setContextConditionFocusIds] = useState<Set<string>>(() => new Set());
  const [metaActionsMenu, setMetaActionsMenu] = useState<{ left: number; top: number } | null>(null);
  const [metaActionsView, setMetaActionsView] = useState<MetaActionsView>('actions');
  const [metaSettingsModelId, setMetaSettingsModelId] = useState<string | null>(null);
  const [liveCodexModels, setLiveCodexModels] = useState<unknown[]>([]);
  const [queueProviderType, setQueueProviderType] = useState<string | null>(
    sessionType === 'codex' ? 'codex' : null,
  );
  const [rewindTargetRequestId, setRewindTargetRequestId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const queueHoverPreviewPanelRef = useRef<HTMLDivElement>(null);
  const metaActionsButtonRef = useRef<HTMLButtonElement>(null);
  const metaActionsMenuRef = useRef<HTMLDivElement>(null);
  const chipListRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const editorPreviewRef = useRef<HTMLDivElement>(null);
  const editorTitleInputRef = useRef<HTMLInputElement>(null);
  const editorTextareaRef = useRef<ComposerEditorHandle>(null);
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
    images: number;
    chips: QueuedComposerChip[];
    imagePaths: QueuedImageRef[];
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
    imagePaths: QueuedImageRef[];
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
  useEffect(() => {
    if (sessionType !== 'claude') {
      setQueueProviderType('codex');
      return;
    }
    let disposed = false;
    const adopt = (state: any) => {
      if (disposed) return;
      const providerType = String(state?.type || '').trim();
      setQueueProviderType(providerType || null);
    };
    const onChanged = (_event: unknown, data: { tabId?: string; state?: any }) => {
      if (data?.tabId === tabId) adopt(data.state);
    };
    void ipcRenderer.invoke('provider:get-status', { tabId }).then(adopt).catch(() => {
      if (!disposed) setQueueProviderType(null);
    });
    ipcRenderer.on('provider:state-changed', onChanged);
    return () => {
      disposed = true;
      ipcRenderer.removeListener('provider:state-changed', onChanged);
    };
  }, [sessionType, tabId]);
  const queuedModelEffortSupported = sessionType === 'codex' || queueProviderType === 'anthropic';
  const queueSettingsModels = useMemo<QueueSettingsModel[]>(() => {
    if (sessionType === 'claude') {
      if (queueProviderType !== 'anthropic') return [];
      return claudeCodeSettings.models
        .filter((model) => model.visible !== false)
        .map((model) => ({
          id: model.id,
          label: model.label || model.id,
          efforts: claudeEffortsForModel(model),
        }))
        .filter((model) => model.id && model.efforts.length > 0);
    }
    return mergeCodexModelOptions(
      liveCodexModels,
      codexSettings.models,
      codexSettings.removedModelIds,
    )
      .filter((model) => model.visible !== false)
      .map((model) => ({
        id: model.id,
        label: model.label || model.id,
        efforts: model.efforts?.filter(Boolean).length
          ? model.efforts.filter(Boolean)
          : [...CODEX_EFFORT_LEVELS],
      }))
      .filter((model) => model.id && model.efforts.length > 0);
  }, [claudeCodeSettings.models, codexSettings.models, codexSettings.removedModelIds, liveCodexModels, queueProviderType, sessionType]);
  const metaSettingsModel = useMemo(
    () => queueSettingsModels.find((model) => model.id === metaSettingsModelId) ?? null,
    [metaSettingsModelId, queueSettingsModels],
  );
  const editorImageMarkerRanges = useMemo(
    () => isSpecialPromptMode
      ? []
      : getQueuedImageMarkerHighlightRanges(editorText, editorImagePaths),
    [editorImagePaths, editorText, isSpecialPromptMode],
  );
  const editorImageNotice = useMemo(
    () => isSpecialPromptMode ? null : runAfterImageNotice(editorText, editorImagePaths),
    [editorImagePaths, editorText, isSpecialPromptMode],
  );
  const editorPasteMarkerRanges = useMemo(
    () => isSpecialPromptMode
      ? []
      : getPasteMarkerHighlightRanges(editorText, editorChips) as Array<{
          start: number; end: number; id: string;
        }>,
    [editorChips, editorText, isSpecialPromptMode],
  );
  const dictationSnapshot = useSyncExternalStore(
    subscribeDictationChips,
    getDictationChipsSnapshot,
  );
  const editorDictationMarkerRanges = useMemo(
    () => isSpecialPromptMode ? [] : getDictationMarkerRanges(editorText),
    [editorText, isSpecialPromptMode],
  );
  const editorDictationEntries = useMemo(() => {
    const result = new Map<string, any>();
    for (const entry of dictationSnapshot.entries as any[]) {
      if (entry.tabId === tabId && entry.surface === 'run-after'
        && (!editingId || entry.queueItemId === editingId)) result.set(entry.id, entry);
    }
    return result;
  }, [dictationSnapshot, editingId, tabId]);
  useEffect(() => {
    if (!editorOpen || !editingId || isSpecialPromptMode) return;
    reconcileDictationChipsForRunAfterItem(tabId, editingId, editorText);
  }, [editingId, editorOpen, editorText, isSpecialPromptMode, tabId]);
  const editorImagePreviewUrls = useComposerImagePreviews(editorImagePaths);
  const editorComposerTokens = useMemo<ComposerInlineToken[]>(() => {
    if (isSpecialPromptMode) return [];
    const refsById = new Map(editorImagePaths.map((ref) => [Number(ref.id), ref]));
    const result: ComposerInlineToken[] = [
      ...editorImageMarkerRanges.map((range) => ({
        id: `image:${range.id}:${range.start}`,
        from: range.start,
        to: range.end,
        kind: 'image' as const,
        label: `image #${range.id}`,
        thumbnailUrl: composerImageUrl(refsById.get(range.id), editorImagePreviewUrls),
      })),
      ...editorPasteMarkerRanges.map((range) => ({
        id: `paste:${range.id}`,
        from: range.start,
        to: range.end,
        kind: 'paste' as const,
        label: editorText.slice(range.start + 1, Math.max(range.start + 1, range.end - 1)),
      })),
      ...editorDictationMarkerRanges.map((range) => {
        const entry = editorDictationEntries.get(range.id);
        const problem = !entry || entry.status === 'error' || entry.status === 'stale';
        return {
          id: `dictation:${range.id}`,
          from: range.start,
          to: range.end,
          kind: (problem ? 'error' : 'pending') as ComposerInlineToken['kind'],
          label: dictationTokenLabel(entry || { status: 'stale', label: '' }),
          replace: true,
        };
      }),
    ];
    result.push(...getPromptImageStatusTokenRanges(editorText).map((range) => ({
      id: `status:${range.start}`,
      from: range.start,
      to: range.end,
      kind: range.kind,
      label: range.label,
      replace: range.replace,
    })));
    return result;
  }, [editorDictationEntries, editorDictationMarkerRanges, editorImageMarkerRanges, editorImagePaths,
    editorImagePreviewUrls, editorPasteMarkerRanges, editorText, isSpecialPromptMode]);
  const editorPreviewImageRange = useMemo(() => (
    editorChipPreviewId
      ? editorImageMarkerRanges.find((range) => (
          `image:${range.id}:${range.start}` === editorChipPreviewId
        ))
      : undefined
  ), [editorChipPreviewId, editorImageMarkerRanges]);
  const editorPreviewImageRef = useMemo(() => (
    editorPreviewImageRange
      ? editorImagePaths.find((ref) => Number(ref.id) === Number(editorPreviewImageRange.id))
      : undefined
  ), [editorImagePaths, editorPreviewImageRange]);
  const editorImageDetailPreview = useComposerImagePreview(editorPreviewImageRef, 'detail');

  useEffect(() => {
    if (!editorChipPreviewId) return;
    const hasChip = editorChips.some((chip) => chip.id === editorChipPreviewId);
    const hasImage = editorImageMarkerRanges.some((range) => (
      `image:${range.id}:${range.start}` === editorChipPreviewId
    ));
    if (!hasChip && !hasImage) setEditorChipPreviewId(null);
  }, [editorChipPreviewId, editorChips, editorImageMarkerRanges]);

  // ─── fixed width + drag-resize ─────────────────────────────────────────────
  // The panel has a FIXED width (no `fit-content`) so adding a +grab chip can't
  // reflow it — the user's complaint. Width is global (like timelineWidth) and
  // persisted in useUIStore. During a drag we render from `dragWidth` (local,
  // for 60fps without store churn) and commit to the store on mouse-up.
  const promptQueueWidth = useUIStore((s) => s.promptQueueWidth);
  const aiComposerChipThreshold = useUIStore((s) => s.aiComposerChipThreshold);
  const setPromptQueueWidth = useUIStore((s) => s.setPromptQueueWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const effectiveWidth = embedded ? embeddedWidth : dragWidth ?? promptQueueWidth;
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
  const [queueHoverPreviewOpen, setQueueHoverPreviewOpen] = useState(false);
  const [cmdPressed, setCmdPressed] = useState(false);
  const cmdPressedRef = useRef(false);
  const previewPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const previewResizeActiveRef = useRef(false);
  const recheckQueueHoverRef = useRef<(point: { clientX: number; clientY: number } | null) => void>(() => {});
  const queueCountButtonRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
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
  // Busy no longer drives a perpetual Run-control pulse: colour + Pause glyph
  // already communicate the armed state, while an exact handoff has its own
  // transport spinner.

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
    setEditorImagePaths([]);
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

  const openMetaActionsMenu = useCallback(() => {
    const rect = metaActionsButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 238;
    const height = 166;
    setMetaActionsView('actions');
    setMetaSettingsModelId(null);
    setMetaActionsMenu({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - height - 8)),
    });
    if (sessionType === 'codex') {
      void ipcRenderer.invoke('codex:list-models').then((result: any) => {
        if (Array.isArray(result?.models)) setLiveCodexModels(result.models);
      }).catch((error: unknown) => {
        console.warn('[PromptQueue] Codex model list failed:', error);
      });
    }
  }, [sessionType]);

  const enqueueRestartAction = useCallback(() => {
    const id = addMetaAction(tabId, { kind: 'restart' }, 'Restart tab');
    markAppearing(id);
    setMetaActionsMenu(null);
  }, [addMetaAction, markAppearing, tabId]);

  const enqueueStopAction = useCallback(() => {
    const id = addMetaAction(tabId, { kind: 'stop' });
    markAppearing(id);
    setMetaActionsMenu(null);
  }, [addMetaAction, markAppearing, tabId]);

  const enqueueCloseTabAction = useCallback(() => {
    const id = addMetaAction(tabId, { kind: 'close-tab' });
    markAppearing(id);
    setMetaActionsMenu(null);
  }, [addMetaAction, markAppearing, tabId]);

  const enqueueModelEffortAction = useCallback((model: QueueSettingsModel, effort: string) => {
    const normalizedEffort = effort.trim().toLowerCase();
    if (!model.id || !normalizedEffort) return;
    const id = addMetaAction(tabId, {
      kind: 'model-effort',
      toolType: sessionType,
      model: model.id,
      effort: normalizedEffort,
    }, `Model → ${model.label} · ${normalizedEffort}`);
    markAppearing(id);
    setMetaActionsMenu(null);
    setMetaActionsView('actions');
    setMetaSettingsModelId(null);
  }, [addMetaAction, markAppearing, sessionType, tabId]);

  const armRunAfterForSchedulingIfBusy = useCallback((triggerTabId: string | null = null) => {
    // A timer/context condition waits on the owner turn, but `on tab` waits on
    // the selected tab. Checking the owner for both cases leaves a queue OFF
    // when an idle owner is deliberately scheduled after a busy neighbour.
    const schedulingTabBusy = triggerTabId ? isTabBusyNow(triggerTabId) : agentBusy;
    if (!schedulingTabBusy) return;
    const live = usePromptQueueStore.getState().getQueue(tabId);
    if (!live.autoRun) setAutoRun(tabId, true);
  }, [agentBusy, setAutoRun, tabId]);

  const requestQueuedRewindTarget = useCallback(() => {
    const requestId = 'pq-rewind-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    setRewindTargetRequestId(requestId);
    setMetaActionsMenu(null);
    if (embedded) {
      const workspace = useWorkspaceStore.getState();
      for (const [projectId, project] of workspace.openProjects) {
        if (project.tabs.has(tabId)) { workspace.activateCenterTab(projectId, tabId); break; }
      }
    }
    publishQueuedRewindTarget(tabId, requestId);
  }, [tabId, embedded]);

  useEffect(() => {
    if (!rewindTargetRequestId) return;
    return () => cancelQueuedRewindTarget(tabId, rewindTargetRequestId);
  }, [rewindTargetRequestId, tabId]);
  useEffect(() => {
    onRewindTargetModeChange?.(!!rewindTargetRequestId);
    return () => onRewindTargetModeChange?.(false);
  }, [rewindTargetRequestId, onRewindTargetModeChange]);

  useEffect(() => {
    const onSelected = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        requestId?: string;
        uuid?: string;
        text?: string;
        sessionId?: string;
        toolType?: 'claude' | 'codex';
      }>).detail;
      if (!detail
        || detail.tabId !== tabId
        || detail.requestId !== rewindTargetRequestId
        || !detail.uuid
        || !detail.text
        || !detail.sessionId
        || (detail.toolType !== 'claude' && detail.toolType !== 'codex')) return;
      const id = addMetaAction(tabId, {
        kind: 'rewind',
        targetUuid: detail.uuid,
        targetText: detail.text,
        sourceSessionId: detail.sessionId,
        toolType: detail.toolType,
      });
      markAppearing(id);
      setRewindTargetRequestId(null);
    };
    const onCancelled = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; requestId?: string }>).detail;
      if (detail?.tabId === tabId && detail.requestId === rewindTargetRequestId) {
        setRewindTargetRequestId(null);
      }
    };
    window.addEventListener('prompt-queue:rewind-target-selected', onSelected);
    window.addEventListener('prompt-queue:rewind-target-cancelled', onCancelled);
    return () => {
      window.removeEventListener('prompt-queue:rewind-target-selected', onSelected);
      window.removeEventListener('prompt-queue:rewind-target-cancelled', onCancelled);
    };
  }, [addMetaAction, markAppearing, rewindTargetRequestId, tabId]);

  useEffect(() => {
    if (!metaActionsMenu) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (metaActionsMenuRef.current?.contains(target)) return;
      if (metaActionsButtonRef.current?.contains(target)) return;
      setMetaActionsMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMetaActionsMenu(null);
    };
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [metaActionsMenu]);

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

  const clearItemTrigger = useCallback((id: string) => {
    setPromptTrigger(tabId, id, null);
    // Clearing the only runnable item's trigger must not accidentally arm
    // plain turn-end execution. Both the cross and middle click use this path.
    const live = usePromptQueueStore.getState().getQueue(tabId);
    const runnableCount = live.items.filter(isQueuedPromptEnabled).length;
    if (live.autoRun && shouldDisarmAfterTriggerClear({ runnableCount })) {
      if (live.firstDelayCountdownAt !== null) {
        usePromptQueueStore.getState().cancelFirstDelayCountdown(tabId);
      }
      setAutoRun(tabId, false);
    }
    setOnTabTriggerDraftIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setTimerTriggerDraftIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, [setPromptTrigger, setAutoRun, tabId]);

  const generateRunAfterTitle = useCallback((id: string, opts?: { force?: boolean }) => {
    const queuedItem = usePromptQueueStore.getState().getQueue(tabId).items.find((item) => item.id === id);
    if (!queuedItem || getQueuedPromptLocalCommand(queuedItem.text, queuedItem.images, queuedItem.chips?.length || 0)) return false;
    const queuedDraft = serializeComposerDraft({ text: queuedItem.text, chips: queuedItem.chips || [] });
    const source = trimTabTitlePrompt(queuedDraft.trim());
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
        if (serializeComposerDraft({ text: current.text, chips: current.chips || [] }) !== queuedDraft
          || getQueuedPromptLocalCommand(current.text, current.images, current.chips?.length || 0)) return;
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
    nextImagePaths?: QueuedImageRef[],
  ): boolean => {
    const initial = editorInitialRef.current;
    if (!initial) return false;
    const normalizedChips = normalizeComposerChips(nextChips) as QueuedComposerChip[];
    const normalizedImagePaths = Array.isArray(nextImagePaths)
      ? nextImagePaths.map((ref) => ({ ...ref }))
      : null;
    if (normalizedImagePaths) setEditorImagePaths(normalizedImagePaths);

    if (initial.specialMode) {
      if (!acquireEditorPayloadLock(null)) return false;
      if (initial.specialMode === 'post') setPostPromptText(tabId, nextText);
      else setLoopPromptText(tabId, nextText);
      editorLastWrittenRef.current = {
        id: null,
        specialMode: initial.specialMode,
        text: nextText,
        chips: [],
        imagePaths: [],
      };
      return true;
    }

    if (!initial.id) {
      const previous = editorLastWrittenRef.current;
      editorLastWrittenRef.current = {
        id: null,
        specialMode: null,
        text: nextText,
        chips: normalizedChips,
        imagePaths: normalizedImagePaths || previous?.imagePaths || [],
      };
      return true;
    }
    if (!acquireEditorPayloadLock(initial.id)) return false;

    const previous = editorLastWrittenRef.current;
    const patch: { text?: string; chips?: QueuedComposerChip[]; imagePaths?: QueuedImageRef[] } = {};
    if (!previous || previous.text !== nextText) patch.text = nextText;
    if (!previous || !haveSameComposerChips(previous.chips, normalizedChips)) {
      patch.chips = normalizedChips;
    }
    if (normalizedImagePaths
      && !haveSamePromptImageRefs(previous?.imagePaths || [], normalizedImagePaths)) {
      patch.imagePaths = normalizedImagePaths;
    }
    if (!Object.prototype.hasOwnProperty.call(patch, 'text')
      && !Object.prototype.hasOwnProperty.call(patch, 'chips')
      && !Object.prototype.hasOwnProperty.call(patch, 'imagePaths')) {
      return true;
    }

    const accepted = updatePrompt(tabId, initial.id, patch);
    if (accepted) {
      const current = usePromptQueueStore.getState().getQueue(tabId).items
        .find((item) => item.id === initial.id);
      editorLastWrittenRef.current = {
        id: initial.id,
        specialMode: null,
        text: current?.text ?? nextText,
        chips: (current?.chips || normalizedChips) as QueuedComposerChip[],
        imagePaths: (current?.imagePaths || normalizedImagePaths || previous?.imagePaths || []) as QueuedImageRef[],
      };
    }
    return accepted;
  }, [acquireEditorPayloadLock, setLoopPromptText, setPostPromptText, tabId, updatePrompt]);

  const applyRunAfterComposerSnapshot = useCallback(({
    text,
    chips,
    imagePaths,
    selectionStart,
    selectionEnd = selectionStart,
    history = 'add',
    userEvent = 'input',
  }: {
    text: string;
    chips: QueuedComposerChip[];
    imagePaths: QueuedImageRef[];
    selectionStart: number;
    selectionEnd?: number;
    history?: 'add' | 'replace' | 'external';
    userEvent?: string;
  }) => {
    const editor = editorTextareaRef.current;
    if (editor) {
      editor.applySnapshot({
        value: text,
        selectionStart,
        selectionEnd,
        history,
        historyPayload: { chips, imagePaths } satisfies RunAfterComposerAggregate,
        userEvent,
      });
    }
    setEditorText(text);
    setEditorChips(chips);
    setEditorImagePaths(imagePaths);
    writeThroughEditorPayload(text, chips, imagePaths);
  }, [writeThroughEditorPayload]);

  useEffect(() => {
    const onDictationResolved = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        itemId?: string;
        text?: string;
        imagePaths?: QueuedImageRef[];
        replaced?: { from: number; to: number; caret: number };
      }>).detail;
      if (!editorOpen || !editingId || detail?.tabId !== tabId || detail.itemId !== editingId
        || typeof detail.text !== 'string' || !detail.replaced) return;
      const editor = editorTextareaRef.current;
      const selection = remapPromptImageSelectionAfterReplacement({
        selectionStart: editor?.selectionStart ?? detail.replaced.to,
        selectionEnd: editor?.selectionEnd ?? detail.replaced.to,
        replacedStart: detail.replaced.from,
        replacedEnd: detail.replaced.to,
        insertionCaret: detail.replaced.caret,
      });
      applyRunAfterComposerSnapshot({
        text: detail.text,
        chips: retainPasteChipsForText(detail.text, editorChips) as QueuedComposerChip[],
        imagePaths: detail.imagePaths || [],
        selectionStart: selection.start,
        selectionEnd: selection.end,
        history: 'add',
        userEvent: 'input.complete',
      });
    };
    window.addEventListener('prompt-queue:dictation-item-resolved', onDictationResolved);
    return () => window.removeEventListener('prompt-queue:dictation-item-resolved', onDictationResolved);
  }, [applyRunAfterComposerSnapshot, editingId, editorChips, editorOpen, tabId]);

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

      if (editorText.includes(RUN_AFTER_IMAGE_PENDING_MARKER)) {
        console.log('[PromptQueue:Images] commit deferred tab=' + tabId.slice(-8)
          + ' item=' + (initial.id || 'new') + ' reason=image-import-pending');
        return false;
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
        normalizedTitle !== makeDefaultPromptTitle(initialSerialized, initial.images, initial.chips.length)
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
      const committedImagePaths = retainPromptImageRefsForText(
        text,
        editorImagePaths,
      ) as QueuedImageRef[];

      if (initial.id) {
        if (
          editorLastWrittenRef.current?.text !== editorText
          || !haveSameComposerChips(editorLastWrittenRef.current?.chips, editorChips)
          || !haveSamePromptImageRefs(editorLastWrittenRef.current?.imagePaths, editorImagePaths)
        ) {
          writeThroughEditorPayload(editorText, editorChips, editorImagePaths);
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
            }), current.images, current.chips?.length || 0);
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
        const id = addPrompt(
          tabId,
          text,
          undefined,
          committedImagePaths,
          normalizedTitle,
          editorChips,
        );
        const titleWillGenerate = !normalizedTitle && generateRunAfterTitle(id);
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
  }, [addPrompt, editorChips, editorImagePaths, editorOpen, editorText, editorTitle, generateRunAfterTitle, markAppearing, markSaved, releaseEditorPayloadLock, removePrompt, resetEditor, tabId, updatePrompt, writeThroughEditorPayload]);

  const prepareQueueClose = useCallback((reason?: 'outside') => {
    // Pointer dismissal is an editor exit, not a pin. Keep pending attachments
    // and a requested Timeline selection alive without changing click ownership.
    if (editorOpen && editorText.includes(RUN_AFTER_IMAGE_PENDING_MARKER)) return false;
    if (rewindTargetRequestId && reason === 'outside') return false;
    if (rewindTargetRequestId) cancelQueuedRewindTarget(tabId, rewindTargetRequestId);
    const active = document.activeElement;
    if (active instanceof HTMLElement && (panelRef.current?.contains(active)
      || editorRef.current?.contains(active) || editorPreviewRef.current?.contains(active))) active.blur();
    commitEditor();
    return true;
  }, [commitEditor, editorOpen, editorText, rewindTargetRequestId, tabId]);

  useLayoutEffect(() => {
    if (!beforeCloseRef) return;
    beforeCloseRef.current = prepareQueueClose;
    return () => { if (beforeCloseRef.current === prepareQueueClose) beforeCloseRef.current = () => true; };
  }, [beforeCloseRef, prepareQueueClose]);

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
    generateRunAfterTitle(id, { force: true });
    setChipContextMenu(null);
  }, [generateRunAfterTitle, tabId]);

  const scheduleChipAfterAppRestart = useCallback(async (id: string) => {
    setChipContextMenu(null);
    try {
      const identity = await getAppRuntimeIdentity();
      const before = usePromptQueueStore.getState().getQueue(tabId);
      const item = before.items.find((candidate) => candidate.id === id);
      if (!item) return;
      setTimerTriggerDraftIds((current) => {
        const next = new Set(current); next.delete(id); return next;
      });
      setOnTabTriggerDraftIds((current) => {
        const next = new Set(current); next.delete(id); return next;
      });
      setPromptTrigger(tabId, id, {
        kind: 'app-restart',
        armedInstanceId: identity.instanceId,
      });
      console.log('[PromptQueue] after-restart scheduled tab=' + tabId.slice(-12)
        + ' item=' + id.slice(-12) + ' runtime=' + identity.instanceId.slice(-12));
      const live = usePromptQueueStore.getState().getQueue(tabId);
      const head = live.items.find(isQueuedPromptEnabled);
      // A condition on the next executable card is the whole scheduling
      // promise, so it arms immediately. A later card cannot arm the head on
      // somebody else's terms; its restart condition remains staged in order.
      if (shouldArmQueueForTrigger({ trigger: head?.trigger, isHead: head?.id === id })
        && !live.autoRun) setAutoRun(tabId, true);
    } catch (error: any) {
      showToast('Не удалось запланировать Run After после перезапуска: '
        + String(error?.message || error), 'error');
    }
  }, [setAutoRun, setPromptTrigger, showToast, tabId]);

  const anchorEditor = useCallback((id?: string, anchorMode: EditorAnchorMode = 'list') => {
    const panelRect = panelRef.current?.getBoundingClientRect();
    if (!panelRect) return null;
    // The local overlay owns free space on its LEFT. The global overview is
    // already a wide resizable work surface, so forcing the same side-out there
    // pushed the editor past the viewport. In embedded mode the editor mirrors
    // the queue inside its own bounds, aligned to the panel's right edge.
    const anchorRight = embedded
      ? Math.max(EDITOR_MARGIN, window.innerWidth - panelRect.right + EDITOR_MARGIN)
      : window.innerWidth - panelRect.left + 8; // 8px gap
    let anchorTop = panelRect.top;
    if (id) {
      const it = usePromptQueueStore.getState().getQueue(tabId).items.find((i) => i.id === id);
      if (!it) return null;
      const chipRect = chipRefs.current.get(id)?.getBoundingClientRect();
      if (chipRect) anchorTop = chipRect.top;
    } else if (anchorMode === 'list' || anchorMode === 'list-end') {
      const listRect = chipListRef.current?.getBoundingClientRect();
      if (listRect) {
        anchorTop = anchorMode === 'list-end'
          ? Math.min(listRect.bottom, window.innerHeight - EDITOR_MIN_HEIGHT - EDITOR_MARGIN)
          : listRect.top;
      }
    }
    if (embedded) {
      const minTop = panelRect.top + EDITOR_MARGIN;
      const maxTop = Math.max(minTop, panelRect.bottom - EDITOR_MIN_HEIGHT - EDITOR_MARGIN);
      anchorTop = Math.max(minTop, Math.min(maxTop, anchorTop));
    } else {
      anchorTop = Math.max(EDITOR_MARGIN, anchorTop);
    }
    const maxHeight = Math.max(96, embedded
      ? panelRect.bottom - anchorTop - EDITOR_MARGIN
      : window.innerHeight - anchorTop - EDITOR_MARGIN);
    return { top: anchorTop, right: anchorRight, maxHeight };
  }, [embedded, tabId]);

  const { start: startEditorResizeGesture } = usePointerGesture();
  const startEditorResize = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const rect = editorRef.current?.getBoundingClientRect();
    if (!rect || !editorAnchor) return;
    const startX = e.clientX;
    const startWidth = rect.width;
    const rightEdge = window.innerWidth - editorAnchor.right;
    const maxWidth = Math.max(EDITOR_MIN_WIDTH, Math.min(EDITOR_MAX_WIDTH, rightEdge - EDITOR_MARGIN));
    previewPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    startEditorResizeGesture(e, {
      cursor: 'ew-resize',
      onMove: (ev) => {
        previewPointerRef.current = { clientX: ev.clientX, clientY: ev.clientY };
        onHoverGestureChange?.(true, previewPointerRef.current);
        setEditorSize((prev) => ({
          ...prev,
          width: Math.max(EDITOR_MIN_WIDTH, Math.min(maxWidth, startWidth + startX - ev.clientX)),
        }));
      },
      onEnd: (reason, event) => {
        previewResizeActiveRef.current = false;
        if (event) previewPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
        if (reason === 'blur') previewPointerRef.current = null;
        onHoverGestureChange?.(false, previewPointerRef.current);
        if (reason !== 'dispose') recheckQueueHoverRef.current(previewPointerRef.current);
      },
    });
    previewResizeActiveRef.current = true;
    onHoverGestureChange?.(true, previewPointerRef.current);
  }, [editorAnchor, onHoverGestureChange, startEditorResizeGesture]);

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
    const anchor = anchorEditor(id, id ? 'list' : 'list-end');
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
      setEditorImagePaths((it.imagePaths || []).map((ref) => ({ ...ref })));
      setEditorChipPreviewId(null);
      setEditorTitle(title);
      setEditingId(id);
      if (mode === 'pin') setPreviewId(tabId, id);
      editorInitialRef.current = {
        id,
        specialMode: null,
        text: it.text,
        images: it.images,
        chips: (it.chips || []).map((chip) => ({ ...chip })),
        imagePaths: (it.imagePaths || []).map((ref) => ({ ...ref })),
        title,
        titleManual: !!it.titleManual,
      };
      editorLastWrittenRef.current = {
        id,
        specialMode: null,
        text: it.text,
        chips: (it.chips || []).map((chip) => ({ ...chip })),
        imagePaths: (it.imagePaths || []).map((ref) => ({ ...ref })),
      };
    } else {
      setEditorText('');
      setEditorChips([]);
      setEditorImagePaths([]);
      setEditorChipPreviewId(null);
      setEditorTitle('');
      setEditingId(null);
      if (mode === 'pin') setPreviewId(tabId, null);
      editorInitialRef.current = {
        id: null,
        specialMode: null,
        text: '',
        images: 0,
        chips: [],
        imagePaths: [],
        title: '',
        titleManual: false,
      };
      editorLastWrittenRef.current = {
        id: null,
        specialMode: null,
        text: '',
        chips: [],
        imagePaths: [],
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
    setEditorImagePaths([]);
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
      images: 0,
      chips: [],
      imagePaths: [],
      title: '',
      titleManual: false,
    };
    editorLastWrittenRef.current = {
      id: null,
      specialMode: mode,
      text,
      chips: [],
      imagePaths: [],
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
      if (editorPreviewRef.current?.contains(target)) return;
      const replayButton = editingId ? replayButtonRefs.current.get(editingId) : null;
      if (replayButton?.contains(target)) return;
      const currentChip = editingId ? chipRefs.current.get(editingId) : null;
      if (currentChip?.contains(target)) return;
      // Ховер-превью: клики по его строкам и по полоске кнопок — внутри
      // кластера, они переключают модалку сами и не считаются «снаружи».
      const previewPanel = queueHoverPreviewPanelRef.current;
      if (previewPanel?.contains(target)) return;
      if (previewPanel && queueCountButtonRef.current?.contains(target)) return;
      if (editorPinned && shouldPreservePinnedEditorOnOutsideClick(targetElement)) {
        commitEditor({ close: false });
        return;
      }
      commitEditor();
      // Клик снаружи закрывает весь кластер целиком: модалку И карточки
      // превью — «пока я не кликну в каком-то другом месте, чтобы они
      // закрылись».
      setQueueHoverPreviewOpen(false);
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
      const preview = editorPreviewRef.current?.getBoundingClientRect();
      if (!trigger || !editor) return;
      const x = e.clientX;
      const y = e.clientY;
      const inBridge =
        x >= editor.right - 2 &&
        x <= trigger.left + 2 &&
        y >= Math.min(editor.top, trigger.top) - 8 &&
        y <= Math.max(editor.bottom, trigger.bottom) + 8;
      const inPreviewBridge = !!preview
        && x >= preview.right - 2
        && x <= editor.left + 2
        && y >= Math.min(preview.top, editor.top) - 8
        && y <= Math.max(preview.bottom, editor.bottom) + 8;
      if (!inRect(trigger, x, y)
        && !inRect(editor, x, y)
        && !inRect(preview, x, y)
        && !inBridge
        && !inPreviewBridge) {
        resetEditor();
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [editingId, editorFocusWithin, editorOpen, editorPinned, resetEditor]);

  // Preview is a real sibling of the editor, so its fallback-below placement
  // needs the editor's actual content-driven height. ResizeObserver and the
  // window resize event keep this event-driven; no polling or timeout geometry.
  useLayoutEffect(() => {
    if (!editorOpen) return;
    const editor = editorRef.current;
    if (!editor) return;
    const updateGeometry = () => {
      const rect = editor.getBoundingClientRect();
      setEditorMeasuredHeight(rect.height);
      setEditorViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    updateGeometry();
    const observer = new ResizeObserver(updateGeometry);
    observer.observe(editor);
    window.addEventListener('resize', updateGeometry);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateGeometry);
    };
  }, [editorOpen]);

  useLayoutEffect(() => {
    if (!editorOpen || !editorAnchor) return;
    const textarea = editorTextareaRef.current;
    if (!textarea) return;
    const chromeHeight = isSpecialPromptMode ? 0 : editorTitleHeight + 1;
    const maxTextareaHeight = Math.max(
      editorTextareaMinHeight,
      editorAnchor.maxHeight - chromeHeight
    );
    textarea.measureNaturalHeight((measuredHeight) => {
      if (editorTextareaRef.current !== textarea) return;
      const nextHeight = Math.min(
        Math.max(measuredHeight, editorTextareaMinHeight),
        maxTextareaHeight
      );
      textarea.style.height = `${nextHeight}px`;
      textarea.style.overflowY = measuredHeight > maxTextareaHeight ? 'auto' : 'hidden';
    });
  }, [editorAnchor, editorOpen, editorSize.width, editorText, editorTextareaMinHeight, editorTitleHeight, isSpecialPromptMode]);

  useEffect(() => {
    if (!editingId) return;
    if (!items.some((i) => i.id === editingId)) resetEditor();
  }, [editingId, items, resetEditor]);

  useEffect(() => {
    if (!pinnedPreviewId || collapsed) return;
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

  const focusHistoryComposer = useCallback((
    reason = 'queue',
    selection?: { start: number; end?: number },
  ) => {
    console.log('[PromptQueue] focus History composer tab=' + tabId.slice(-8) + ' reason=' + reason);
    window.dispatchEvent(new CustomEvent('history-panel:focus-composer', {
      detail: {
        tabId,
        selectionStart: selection?.start,
        selectionEnd: selection?.end ?? selection?.start,
      },
    }));
  }, [tabId]);

  // Replay handler — paste chip's text into the agent's current input WITHOUT
  // touching stash. Normal click leaves it for review; Cmd+click also submits
  // immediately (same as user pressing Enter after paste). On success the chip
  // is removed from the queue (the prompt has "moved" into the agent input).
  // Which input the user is actually working in. The prop answers "which
  // surfaces exist on this tab", not "where is the caret": in terminal-primary
  // it is pinned to 'history', so grab/Replay always went to the untouched
  // History draft and reported "input is empty" while the user was typing in
  // the terminal. The live focus record wins whenever the tab has both inputs;
  // with nothing focused yet the terminal stays the historical default.
  //
  // Both branches carry the full draft, not just text: the History side moves
  // its images, prompt/paste chips and their refs together (they belong to the
  // same tab-scoped draft), while the terminal side reads its own images from
  // the grab IPC. Resolving the surface must not split that triple.
  const resolveActiveInputSurface = useCallback((): 'terminal' | 'history' => {
    if (inputSurface !== 'history') return inputSurface;
    const selected = useUIStore.getState().promptQueueInputSurfaceTabs[tabId];
    return selected === 'terminal' ? 'terminal' : 'history';
  }, [inputSurface, tabId]);

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
      if (validation.degraded) {
        console.warn('[PromptQueue] replay attachment unavailable but transferable tab=' + tabId.slice(-8)
          + ' item=' + id.slice(-8) + ' action=replace-with-imageError');
      }
      const payload = buildQueuedPromptPayload(validation.item);
      const submitNow = opts?.submit === true;
      console.log('[PromptQueue] replay start tab=' + tabId.slice(-8) + ' item=' + id.slice(-8) + ' agent=' + sessionType + ' submit=' + submitNow);
      // Same rule as grab: put the prompt back where the user is typing.
      // Cmd+Replay (submitNow) stays on the confirmed PTY path regardless.
      const replaySurface = resolveActiveInputSurface();
      if (!submitNow && replaySurface === 'history') {
        const ui = useUIStore.getState();
        const currentText = ui.historyPromptDrafts[tabId] || '';
        const currentImages = ui.historyPromptDraftImages[tabId] || [];
        const currentChips = ui.historyPromptDraftChips[tabId] || [];
        // Replay is a return-to-draft operation, not Paste at caret. Always
        // append the complete snapshot and leave the caret after it. This also
        // avoids querying the removed textarea surface now that History uses
        // CodeMirror.
        const caretStart = currentText.length;
        const caretEnd = currentText.length;
        const needsSpace = currentText.length > 0
          && !/\s$/.test(currentText);
        const insertedText = validation.item.text
          ? (needsSpace ? ' ' : '') + validation.item.text
          : '';
        const insertion = insertPromptImageAttachments({
          text: currentText,
          imagePaths: currentImages,
          start: caretStart,
          end: caretEnd,
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
        const insertedComposerText = insertion.text.slice(caretStart, insertion.caret);
        const authoringInsertion = insertComposerSnapshotAtSelection({
          text: currentText,
          chips: currentChips,
          insertedText: insertedComposerText,
          insertedChips: validation.item.chips || [],
          selectionStart: caretStart,
          selectionEnd: caretEnd,
        });
        ui.setHistoryPromptDraft(tabId, authoringInsertion.text, {
          images: insertion.imagePaths,
          chips: authoringInsertion.chips,
        });
        removePrompt(tabId, id);
        const caretAfterInsert = authoringInsertion.caret;
        // The History owner applies this to the live CodeMirror handle after
        // React has committed the appended value.
        focusHistoryComposer('replay-after-history-transfer', {
          start: caretAfterInsert,
          end: caretAfterInsert,
        });
        console.log('[PromptQueue] replay transferred to History composer tab=' + tabId.slice(-8)
          + ' item=' + id.slice(-8)
          + ' caret=' + caretStart + '→' + caretAfterInsert
          + ' atEnd=true');
        return;
      }
      if (replaySurface === 'terminal') {
        focusActiveTerminal(submitNow ? 'replay-submit-before-ipc' : 'replay-before-ipc');
      }
      const presentationText = serializeComposerDraft({
        text: validation.item.text,
        chips: validation.item.chips || [],
      }).trim();
      let res: any;
      if (submitNow) {
        const workspace = Array.from(useWorkspaceStore.getState().openProjects.values())
          .find((candidate) => candidate.tabs.has(tabId));
        const tab = workspace?.tabs.get(tabId);
        const runtime = getHistoryAgentRuntime(sessionType);
        const presence = await runtime.getPresence(tabId).catch(() => null);
        const statusAtSend = presence?.status || 'unknown';
        const sessionIdHint = sessionType === 'codex'
          ? (tab?.codexSessionId || null)
          : (tab?.claudeSessionId || null);
        const handoffId = buildPromptQueueReceiptHandoffId({
          kind: 'queue',
          itemId: id,
          payload,
        });
        res = await runHistoryPromptHandoff({
          tabId,
          handoffId,
          toolType: sessionType,
          sessionIdHint,
          text: presentationText,
          promptChips: validation.item.chips || [],
          imagePaths: validation.item.imagePaths || [],
          submittedAt: Date.now(),
          source: 'prompt-queue',
          statusAtSend,
          initialStatus: historyPromptHandoffInitialStatus(statusAtSend),
          send: (exactHandoffId) => sendAgentPromptScenario({
            tabId,
            toolType: sessionType,
            runtime,
            sessionId: sessionIdHint,
            cwd: tab?.cwd,
            prompt: payload,
            handoffId: exactHandoffId,
            source: 'prompt-queue',
            promptQueueAction: 'send-now',
            statusAtSend,
            queue: statusAtSend === 'busy',
            settingsIntent: AGENT_SETTINGS_INTENT_NONE,
            returnDraftOnConflict: false,
            presentationSnapshot: {
              historySessionId: sessionIdHint,
              promptChips: validation.item.chips || [],
              imagePaths: validation.item.imagePaths || [],
            },
          }),
        });
      } else {
        res = await ipcRenderer.invoke(sessionType + ':append-input', tabId, payload, {
          submit: false,
          source: 'prompt-queue-replay',
          presentationSnapshot: {
            promptChips: validation.item.chips || [],
            imagePaths: validation.item.imagePaths || [],
          },
        });
      }
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
      if (replaySurface === 'history') focusHistoryComposer('replay-submit-after-ipc');
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
  }, [tabId, sessionType, showToast, focusActiveTerminal, focusHistoryComposer, resolveActiveInputSurface, removePrompt]);

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

  const enqueueGrabbedPrompt = useCallback((
    text: string,
    images: number,
    imagePaths?: QueuedImageRef[],
    chips?: QueuedComposerChip[],
  ) => {
    const serializedDraft = serializeComposerDraft({ text, chips: chips || [] });
    const shortGrabTitle = getQueuedPromptLocalCommand(text, images, chips?.length || 0)
      || getShortGrabPromptTitle(serializedDraft);
    // Commit the queue item BEFORE any async title lookup. A pending Voice
    // Record marker can resolve while prompts:get is in flight; delaying the
    // ownership move until after that await used to leave an orphan marker in
    // Run After while the resolved text stayed behind in History. Title work
    // is presentation-only and must never sit on the transfer boundary.
    const id = addPrompt(tabId, text, images, imagePaths, shortGrabTitle || undefined, chips);
    const movedDictations = moveDictationChipsToRunAfter({
      tabId,
      queueItemId: id,
      text,
    });
    if (movedDictations.length > 0) {
      console.log('[PromptQueue:Grab] dictation ownership moved tab=' + tabId.slice(-8)
        + ' item=' + id.slice(-8) + ' chips=' + movedDictations.join(','));
    }
    if (shortGrabTitle) {
      markAppearing(id);
      return id;
    }
    // The queue already owns the snapshot. Title lookup is detached
    // presentation work: callers must be able to CAS-clear History now,
    // without awaiting prompts:get or an AI title.
    void (async () => {
      try {
        const insertPromptTitle = await findSavedInsertPromptTitle(serializedDraft).catch(() => null);
        const current = usePromptQueueStore.getState().getQueue(tabId).items.find((item) => item.id === id);
        if (!current) return;
        const currentDraft = serializeComposerDraft({ text: current.text, chips: current.chips || [] });
        // A title found for the captured snapshot is valid only while that
        // snapshot is still exact. Dictation resolution may already have
        // replaced its marker; in that case generate from the current text.
        if (insertPromptTitle && currentDraft === serializedDraft && !current.titleManual) {
          updatePrompt(tabId, id, { title: insertPromptTitle, titleManual: true }, {
            expected: { text: current.text, title: current.title, titleManual: current.titleManual },
          });
          markAppearing(id);
          return;
        }
        const titleWillGenerate = generateRunAfterTitle(id);
        if (!titleWillGenerate) markAppearing(id);
      } catch (error) {
        console.warn('[PromptQueue] captured prompt stored; title presentation failed:', error);
      }
    })();
    return id;
  }, [addPrompt, generateRunAfterTitle, markAppearing, tabId, updatePrompt]);

  // Exactly the same authoring clipboard contract as History: images become
  // portable paths and Pasted Content anchors expand to their stored bodies.
  const handleEditorImageAwareCopy = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    if (start === end) return;
    const result = buildComposerClipboardText({
      text: element.value,
      selectionStart: start,
      selectionEnd: end,
      chips: editorChips,
      imagePaths: editorImagePaths,
    });
    if (!result.handled) return;
    event.preventDefault();
    if (event.type === 'cut') {
      const nextText = element.value.slice(0, start) + element.value.slice(end);
      const nextChips = retainPasteChipsForText(nextText, editorChips) as QueuedComposerChip[];
      const nextImagePaths = retainPromptImageRefsForText(nextText, editorImagePaths) as QueuedImageRef[];
      applyRunAfterComposerSnapshot({
        text: nextText,
        chips: nextChips,
        imagePaths: nextImagePaths,
        selectionStart: start,
        history: 'add',
        userEvent: 'delete.cut',
      });
    }
    clipboard.writeText(result.text);
    if (result.imagePartial > 0 || result.imageMissing > 0) {
      showToast('Image marker is damaged or has no matching attachment. Copied imageError instead.', 'warning', 4000);
    } else if (result.pasteMissing > 0) {
      showToast('Pasted Content marker has no matching text. Copied pasteError instead.', 'warning', 4000);
    }
    console.log('[PromptQueue:Clipboard] composer-export tab=' + tabId.slice(-8)
      + ' type=' + event.type
      + ' images=' + result.imageResolved
      + ' imageMissing=' + result.imageMissing
      + ' imagePartial=' + result.imagePartial
      + ' pastes=' + result.pasteExpanded
      + ' pasteMissing=' + result.pasteMissing);
  }, [applyRunAfterComposerSnapshot, editorChips, editorImagePaths, showToast, tabId]);

  const handleEditorImagePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItem = Array.from(event.clipboardData?.items || [])
      .find((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'));
    const pastedText = event.clipboardData?.getData('text/plain') || '';
    if (!imageItem && isElectronDictationClipboardPayload(event.clipboardData)) return;
    const portableMarkers = imageItem ? [] : collectPortableImagePathMarkers(pastedText);

    if (!imageItem && portableMarkers.length === 0) {
      if (!shouldCreatePasteChip(pastedText, aiComposerChipThreshold)) return;
      event.preventDefault();
      event.stopPropagation();
      if (isSpecialPromptMode) {
        // Post/Loop have no chip sidecar. Preserve their existing plain-text
        // capability instead of silently dropping the pasted body.
        const element = event.currentTarget;
        const start = element.selectionStart ?? editorText.length;
        const end = element.selectionEnd ?? start;
        const nextText = editorText.slice(0, start) + pastedText + editorText.slice(end);
        const caret = start + pastedText.length;
        applyRunAfterComposerSnapshot({
          text: nextText,
          chips: [],
          imagePaths: [],
          selectionStart: caret,
          history: 'add',
          userEvent: 'input.paste',
        });
        requestAnimationFrame(() => {
          const textarea = editorTextareaRef.current;
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
        });
        return;
      }
      const chip: QueuedComposerChip = {
        id: createQueuedComposerChipId(),
        kind: 'paste',
        text: pastedText,
        label: 'Вставка',
        createdAt: Date.now(),
      };
      const insertion = insertComposerSnapshotAtSelection({
        text: editorText,
        chips: editorChips,
        insertedText: buildPasteChipMarker(chip),
        insertedChips: [chip],
        selectionStart: event.currentTarget.selectionStart,
        selectionEnd: event.currentTarget.selectionEnd,
      });
      const nextImagePaths = retainPromptImageRefsForText(
        insertion.text,
        editorImagePaths,
      ) as QueuedImageRef[];
      editorDirtyFieldsRef.current.text = true;
      editorDirtyFieldsRef.current.chips = true;
      applyRunAfterComposerSnapshot({
        text: insertion.text,
        chips: insertion.chips as QueuedComposerChip[],
        imagePaths: nextImagePaths,
        selectionStart: insertion.caret,
        history: 'add',
        userEvent: 'input.paste',
      });
      requestAnimationFrame(() => {
        const textarea = editorTextareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(insertion.caret, insertion.caret);
      });
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (isSpecialPromptMode) {
      showToast('Image attachments are available for queued Run after prompts, not Post/Loop text.', 'warning', 4000);
      return;
    }
    const initial = editorInitialRef.current;
    if (!initial) return;
    if (editorText.includes(RUN_AFTER_IMAGE_PENDING_MARKER)) {
      showToast('Wait for the current image to finish saving.', 'warning', 3000);
      return;
    }

    const element = event.currentTarget;
    const start = Math.max(0, Math.min(element.selectionStart ?? editorText.length, editorText.length));
    const end = Math.max(start, Math.min(element.selectionEnd ?? start, editorText.length));
    const pendingText = editorText.slice(0, start) + RUN_AFTER_IMAGE_PENDING_MARKER + editorText.slice(end);
    const pendingChips = retainPasteChipsForText(pendingText, editorChips) as QueuedComposerChip[];
    const pendingImagePaths = retainPromptImageRefsForText(
      pendingText,
      editorImagePaths,
    ) as QueuedImageRef[];
    editorDirtyFieldsRef.current.text = true;
    editorDirtyFieldsRef.current.chips = true;
    const pendingCaret = start + RUN_AFTER_IMAGE_PENDING_MARKER.length;
    applyRunAfterComposerSnapshot({
      text: pendingText,
      chips: pendingChips,
      imagePaths: pendingImagePaths,
      selectionStart: pendingCaret,
      history: 'add',
      userEvent: 'input.paste',
    });
    requestAnimationFrame(() => {
      const textarea = editorTextareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(pendingCaret, pendingCaret);
    });

    const operation = imageItem
      ? ipcRenderer.invoke('prompt-queue:save-clipboard-image', { tabId })
          .then((saved: QueuedImageRef & { success?: boolean }) => ({
            kind: 'bitmap' as const,
            refs: saved?.success === true && saved.path ? [{ ...saved, id: 1 }] : [],
            sourceText: '[imagePath: ' + (saved?.path || '') + ']',
            saveError: saved?.success === true && saved.path ? null : String((saved as any)?.error || 'save_failed'),
          }))
      : ipcRenderer.invoke('prompt-queue:materialize-image-refs', {
          refs: portableMarkers.map((marker) => ({ id: marker.id, path: marker.path, size: 0 })),
        }).then((result: { refs?: QueuedImageRef[] }) => ({
          kind: 'paths' as const,
          refs: result?.refs || [],
          sourceText: pastedText,
          saveError: null,
        }));

    console.log('[PromptQueue:Images] paste-import start tab=' + tabId.slice(-8)
      + ' item=' + (initial.id || 'new')
      + ' kind=' + (imageItem ? 'bitmap' : 'paths')
      + ' markers=' + (imageItem ? 1 : portableMarkers.length));
    void operation.then((resolved) => {
      const liveDraft = editorLastWrittenRef.current;
      const current = initial.id
        ? usePromptQueueStore.getState().getQueue(tabId).items
            .find((item) => item.id === initial.id)
        : editorInitialRef.current === initial && liveDraft?.specialMode === null
          ? {
              text: liveDraft.text,
              chips: liveDraft.chips,
              imagePaths: liveDraft.imagePaths,
            }
          : null;
      if (!current) return;
      const tokenStart = current.text.indexOf(RUN_AFTER_IMAGE_PENDING_MARKER);
      if (tokenStart < 0) {
        console.log('[PromptQueue:Images] paste-import dropped tab=' + tabId.slice(-8)
          + ' item=' + (initial.id || 'new') + ' reason=pending-marker-removed');
        return;
      }
      const sourceSnapshot = resolved.saveError
        ? {
            text: '[imageError: clipboard_image_save_failed]',
            imagePaths: [],
            imported: 0,
            missing: 1,
          }
        : buildPortableImageImportSnapshot(resolved.sourceText, resolved.refs);
      const snapshot = collapsePortableImageImportSnapshot({
        ...sourceSnapshot,
        threshold: aiComposerChipThreshold,
        createChipId: createQueuedComposerChipId,
      });
      const imageInsertion = insertPromptImageAttachments({
        text: current.text,
        imagePaths: current.imagePaths || [],
        start: tokenStart,
        end: tokenStart + RUN_AFTER_IMAGE_PENDING_MARKER.length,
        insertedText: snapshot.text,
        insertedImagePaths: snapshot.imagePaths,
      });
      if (imageInsertion.missingSourceIds.length > 0) {
        throw new Error('run_after_image_identity_missing');
      }
      const remappedInsertedText = imageInsertion.text.slice(tokenStart, imageInsertion.caret);
      const composerInsertion = insertComposerSnapshotAtSelection({
        text: current.text,
        chips: current.chips || [],
        insertedText: remappedInsertedText,
        insertedChips: snapshot.chips,
        selectionStart: tokenStart,
        selectionEnd: tokenStart + RUN_AFTER_IMAGE_PENDING_MARKER.length,
      });
      const nextChips = composerInsertion.chips as QueuedComposerChip[];
      const nextImagePaths = imageInsertion.imagePaths as QueuedImageRef[];
      const editorStillOwnsDraft = editorInitialRef.current === initial;
      const accepted = editorStillOwnsDraft
        ? writeThroughEditorPayload(composerInsertion.text, nextChips, nextImagePaths)
        : initial.id
          ? updatePrompt(tabId, initial.id, {
              text: composerInsertion.text,
              chips: nextChips,
              imagePaths: nextImagePaths,
            })
          : false;
      if (!accepted) throw new Error('run_after_editor_write_rejected');
      if (editorStillOwnsDraft) {
        applyRunAfterComposerSnapshot({
          text: composerInsertion.text,
          chips: nextChips,
          imagePaths: nextImagePaths,
          selectionStart: composerInsertion.caret,
          history: 'replace',
          userEvent: 'input.complete',
        });
      }
      if (sourceSnapshot.missing > 0) {
        showToast('One or more image files are unavailable. Inserted imageError instead.', 'warning', 4000);
      }
      console.log('[PromptQueue:Images] paste-import ready tab=' + tabId.slice(-8)
        + ' item=' + (initial.id || 'new')
        + ' imported=' + sourceSnapshot.imported
        + ' missing=' + sourceSnapshot.missing
        + ' pasteChips=' + snapshot.chips.length);
      if (editorStillOwnsDraft) requestAnimationFrame(() => {
        const textarea = editorTextareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(composerInsertion.caret, composerInsertion.caret);
      });
    }).catch((cause: any) => {
      const liveDraft = editorLastWrittenRef.current;
      const current = initial.id
        ? usePromptQueueStore.getState().getQueue(tabId).items
            .find((item) => item.id === initial.id)
        : editorInitialRef.current === initial && liveDraft?.specialMode === null
          ? {
              text: liveDraft.text,
              chips: liveDraft.chips,
              imagePaths: liveDraft.imagePaths,
            }
          : null;
      if (!current?.text.includes(RUN_AFTER_IMAGE_PENDING_MARKER)) return;
      const failedText = current.text.replace(
        RUN_AFTER_IMAGE_PENDING_MARKER,
        '[imageError: run_after_image_import_failed]',
      );
      const failedChips = retainPasteChipsForText(failedText, current.chips || []) as QueuedComposerChip[];
      const failedImagePaths = retainPromptImageRefsForText(
        failedText,
        current.imagePaths || [],
      ) as QueuedImageRef[];
      const editorStillOwnsDraft = editorInitialRef.current === initial;
      const accepted = editorStillOwnsDraft
        ? writeThroughEditorPayload(failedText, failedChips, failedImagePaths)
        : initial.id
          ? updatePrompt(tabId, initial.id, {
              text: failedText,
              chips: failedChips,
              imagePaths: failedImagePaths,
            })
          : false;
      if (!accepted) return;
      if (editorStillOwnsDraft) {
        applyRunAfterComposerSnapshot({
          text: failedText,
          chips: failedChips,
          imagePaths: failedImagePaths,
          selectionStart: failedText.length,
          history: 'replace',
          userEvent: 'input.complete',
        });
      }
      showToast('Could not import the image. Inserted imageError instead.', 'warning', 4000);
      console.warn('[PromptQueue:Images] paste-import failed tab=' + tabId.slice(-8)
        + ' item=' + (initial.id || 'new')
        + ' error=' + String(cause?.message || cause));
    });
  }, [aiComposerChipThreshold, applyRunAfterComposerSnapshot, editorChips, editorImagePaths, editorText, isSpecialPromptMode, showToast, tabId, updatePrompt, writeThroughEditorPayload]);

  const replaceEditorPasteAnchor = useCallback((
    chip: QueuedComposerChip,
    replacement: string,
  ) => {
    const range = editorPasteMarkerRanges.find((item) => item.id === chip.id);
    if (!range) return;
    const nextText = editorText.slice(0, range.start) + replacement + editorText.slice(range.end);
    const nextChips = editorChips.filter((item) => item.id !== chip.id);
    const nextImagePaths = retainPromptImageRefsForText(nextText, editorImagePaths) as QueuedImageRef[];
    editorDirtyFieldsRef.current.text = true;
    editorDirtyFieldsRef.current.chips = true;
    const caret = range.start + replacement.length;
    applyRunAfterComposerSnapshot({
      text: nextText,
      chips: nextChips,
      imagePaths: nextImagePaths,
      selectionStart: caret,
      history: 'add',
      userEvent: replacement ? 'input' : 'delete',
    });
    setEditorChipPreviewId((current) => current === chip.id ? null : current);
    requestAnimationFrame(() => {
      editorTextareaRef.current?.focus();
      editorTextareaRef.current?.setSelectionRange(caret, caret);
    });
  }, [applyRunAfterComposerSnapshot, editorChips, editorImagePaths, editorPasteMarkerRanges, editorText]);

  const pasteMenuRequestRef = useRef<string | null>(null);
  const openEditorPasteChipContextMenu = useCallback((chip: QueuedComposerChip) => {
    const requestId = `${editorLockTokenRef.current}:${Date.now()}:${Math.random()}`;
    pasteMenuRequestRef.current = requestId;
    ipcRenderer.send('show-paste-chip-context-menu', {
      requestId,
      chipId: chip.id,
    });
  }, []);

  useEffect(() => {
    if (!editorOpen || isSpecialPromptMode) return;
    const onMenuAction = (_event: unknown, payload: { chipId?: string; action?: string; requestId?: string }) => {
      if (!payload?.requestId || payload.requestId !== pasteMenuRequestRef.current) return;
      pasteMenuRequestRef.current = null;
      const chip = editorChips.find((item) => item.id === payload?.chipId);
      if (!chip || chip.kind !== 'paste') return;
      if (payload.action === 'preview') {
        setEditorChipPreviewId((current) => current === chip.id ? null : chip.id);
      } else if (payload.action === 'restore') {
        replaceEditorPasteAnchor(chip, chip.text || '');
      } else if (payload.action === 'discard') {
        replaceEditorPasteAnchor(chip, '');
      }
    };
    ipcRenderer.on('paste-chip-menu-action', onMenuAction);
    return () => { ipcRenderer.removeListener('paste-chip-menu-action', onMenuAction); };
  }, [editorChips, editorOpen, isSpecialPromptMode, replaceEditorPasteAnchor]);

  const grabCurrent = useCallback(async () => {
    try {
      const resolvedSurface = resolveActiveInputSurface();
      if (resolvedSurface === 'history') {
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
        const historyImageInspection = inspectPromptImageAttachments(raw, historyImages);
        const historyAttachmentsBlocked = raw.includes('[Image saving…]')
          || historyImageInspection.blocking;
        if (historyAttachmentsBlocked) {
          showToast('Wait for the image attachment or repair its marker before moving this prompt', 'warning');
          focusHistoryComposer('grab-history-image-blocked');
          return;
        }
        if (historyImageInspection.unavailable) {
          console.warn('[PromptQueue:Grab] History attachment unavailable but transferable tab='
            + tabId.slice(-8) + ' action=keep-explicit-imageError');
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
      const draftTransfer = readAgentDraftTransfer(res, tabId);
      if (draftTransfer) {
        if (!draftTransfer.text && draftTransfer.images === 0) {
          showToast(agentLabel + ' input is empty', 'warning');
          return;
        }
        try {
          await adoptAgentDraftTransferOnce(draftTransfer, 'queue:' + tabId, snapshot => enqueueGrabbedPrompt(
            snapshot.text, snapshot.images, snapshot.imagePaths,
          ));
        } catch (error) {
          await recoverAgentDraftTransferToHistory(res, tabId, useUIStore);
          showToast('The queue could not accept this draft. Its text and images were preserved in History.', 'error');
          console.warn('[PromptQueue] capture retained in History after queue failure:', error);
          return;
        }
        if (res.success !== true) {
          showToast('Draft saved in the queue; terminal readiness is unconfirmed. '
            + (GRAB_ERROR_TOASTS[res.error] || res.error || ''), 'warning');
        }
        focusActiveTerminal('grab-after-transfer');
        return;
      }
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
  }, [tabId, sessionType, agentLabel, enqueueGrabbedPrompt, focusActiveTerminal, focusHistoryComposer, resolveActiveInputSurface, showToast]);

  // The visible trigger now lives beside the History/terminal composer, while
  // this mounted overlay remains the owner of the already battle-tested grab
  // pipeline (draft ownership, image materialisation, exact clear semantics).
  // A tab-scoped UI request keeps that pipeline singular instead of cloning it
  // into ClaudeControlBar.
  useEffect(() => {
    const onGrabCurrent = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId !== tabId) return;
      void grabCurrent();
    };
    if (embedded) return;
    window.addEventListener('prompt-queue:grab-current', onGrabCurrent);
    return () => window.removeEventListener('prompt-queue:grab-current', onGrabCurrent);
  }, [grabCurrent, tabId, embedded]);

  // Copy moved to InfoPanel — see Copy prompt button next to Copy Session.

  // Toggle Run-after. If user disarms while a first-delay countdown is running,
  // freeze the remaining seconds back into firstDelaySeconds via the store so
  // the input shows "what's left" (not the original value).
  const toggleAutoRun = useCallback(() => {
    const next = !autoRun;
    if (next && activeItemCount === 0) return;
    const q = usePromptQueueStore.getState().getQueue(tabId);
    if (!next && q.firstDelayCountdownAt !== null) {
      usePromptQueueStore.getState().cancelFirstDelayCountdown(tabId);
    }
    setAutoRun(tabId, next);
    if (next) {
      setArmedFlash(true);
    } else {
      setArmedFlash(false);
    }
  }, [activeItemCount, autoRun, tabId, setAutoRun]);

  // The composer control is a second physical entrance to the SAME Play/Pause
  // action. Keep countdown cancellation, hint acknowledgement and armed flash
  // here with the rail owner instead of reimplementing them in the control bar.
  useEffect(() => {
    const onToggleAutoRun = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId !== tabId) return;
      toggleAutoRun();
    };
    if (embedded) return;
    window.addEventListener('prompt-queue:toggle-auto-run', onToggleAutoRun);
    return () => window.removeEventListener('prompt-queue:toggle-auto-run', onToggleAutoRun);
  }, [tabId, toggleAutoRun, embedded]);

  const expandPanel = useCallback(() => {
    setQueueHoverPreviewOpen(false);
    setPanelCollapsed(tabId, false);
  }, [tabId, setPanelCollapsed]);

  const collapsePanel = useCallback(() => {
    if (!prepareQueueClose()) return;
    setQueueHoverPreviewOpen(false);
    // Programmatic «pick a tab now» requests are one-shot UI commands. Closing
    // the whole panel explicitly retires any request that has not yet mounted,
    // so a later hover can only reopen the main queue surface.
    setOnTabTriggerOpenKeys(new Map());
    setMetaActionsMenu(null);
    setChipContextMenu(null);
    setPanelCollapsed(tabId, true);
  }, [prepareQueueClose, tabId, setPanelCollapsed]);

  // A click-open queue is persistent tab layout, not a modal. Outside clicks
  // and Escape belong to the satellite that is currently open (item editor,
  // tab picker, context menu); they must not also collapse the prompt list
  // behind it. The count button is the single explicit close control.

  const openQueueHoverPreview = useCallback((event: React.MouseEvent) => {
    // Empty is still a useful Run After state: Post, Loop, manual add and meta
    // actions are how the first item/settings get created. Tying hover to an
    // existing item made the zero-count rail a dead control.
    if (!collapsed) return;
    previewPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    setQueueHoverPreviewOpen(true);
  }, [collapsed]);

  useEffect(() => {
    if (collapsed) return;
    setQueueHoverPreviewOpen(false);
  }, [collapsed]);

  // Превью закрылось (разворот панели или уход курсора) — модалка,
  // открытая ИЗ него, не может остаться висеть одна: её якорь-строка исчезла.
  // Развёрнутая панель не задета: там queueHoverPreviewOpen и так false.
  const editorOpenRef = useRef(false);
  editorOpenRef.current = editorOpen;
  const prevPreviewOpenRef = useRef(false);
  useEffect(() => {
    if (prevPreviewOpenRef.current && !queueHoverPreviewOpen && collapsed && editorOpenRef.current) {
      commitEditor();
    }
    prevPreviewOpenRef.current = queueHoverPreviewOpen;
  }, [collapsed, commitEditor, queueHoverPreviewOpen]);

  // Окно живёт, пока курсор внутри своего целого: кнопка-счётчик, сама панель
  // и всё, что открыто ИЗ неё (список вкладок, меню сообщения, меню действий),
  // плюс зазоры между панелью и этими блоками. Зазор — визуальная деталь; для
  // курсора он должен быть продолжением панели, иначе окно исчезает ровно
  // посреди движения к списку, который сам же и открыло.
  //
  // Читаются живые прямоугольники: список вкладок раскрывается влево или
  // вправо, вверх или вниз в зависимости от места у края экрана, и любой
  // заранее записанный «список сторон» разошёлся бы с тем, что на экране.
  const closeQueueHoverPreview = useCallback(() => {
    if (!prepareQueueClose('outside')) return;
    setQueueHoverPreviewOpen(false);
    setOnTabTriggerOpenKeys(new Map());
    setMetaActionsMenu(null);
    setChipContextMenu(null);
  }, [prepareQueueClose]);

  const recheckQueueHover = useCallback((point: { clientX: number; clientY: number } | null) => {
    if (!queueHoverPreviewOpen || dragIdRef.current || previewResizeActiveRef.current || rewindTargetRequestId) return;
    if (!point) { closeQueueHoverPreview(); return; }
    const countRect = queueCountButtonRef.current?.getBoundingClientRect() ?? null;
    const railRect = railRef.current?.getBoundingClientRect() ?? null;
    // Only the orange count owns hover. The wide bridge can cover sibling
    // controls, but the thin rail border directly below the count remains a
    // path into the panel rather than an accidental close strip.
    if (pointInRect(railRect, point.clientX, point.clientY, 0)
      && (!countRect || point.clientX < countRect.left || point.clientX > countRect.right)) {
      closeQueueHoverPreview();
      return;
    }
    const previewRect = queueHoverPreviewPanelRef.current?.getBoundingClientRect() ?? null;
    if (!previewRect) return;
    const satellites: (DOMRect | null)[] = [
      countRect,
      ...Array.from(queueHoverPreviewPanelRef.current?.querySelectorAll<HTMLElement>('[data-prompt-queue-edge-controls]') || [])
        .map((el) => el.getBoundingClientRect()),
      ...Array.from(document.querySelectorAll<HTMLElement>(HOVER_CLUSTER_SELECTOR))
        .filter((el) => el.dataset.runAfterHoverOwner === editorLockTokenRef.current)
        .map((el) => el.getBoundingClientRect()),
    ];
    if (pointInHoverCluster({
      hub: previewRect,
      satellites,
      x: point.clientX,
      y: point.clientY,
      pad: HOVER_CLUSTER_PAD,
    })) return;
    closeQueueHoverPreview();
  }, [closeQueueHoverPreview, queueHoverPreviewOpen, rewindTargetRequestId, dragId]);
  recheckQueueHoverRef.current = recheckQueueHover;

  useEffect(() => {
    if (!queueHoverPreviewOpen) return;
    const onMouseMove = (event: MouseEvent) => {
      previewPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      recheckQueueHover(event);
    };
    const onExitWindow = () => { previewPointerRef.current = null; recheckQueueHover(null); };
    const onMouseOut = (event: MouseEvent) => { if (!event.relatedTarget) onExitWindow(); };
    recheckQueueHover(previewPointerRef.current);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseout', onMouseOut);
    window.addEventListener('blur', onExitWindow);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseout', onMouseOut);
      window.removeEventListener('blur', onExitWindow);
    };
  }, [queueHoverPreviewOpen, recheckQueueHover]);

  // ─── drag-and-drop reorder ───────────────────────────────────────────────
  const onDragStart = (id: string) => (e: React.DragEvent) => {
    dragIdRef.current = id;
    previewPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    onHoverGestureChange?.(true, previewPointerRef.current);
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    previewPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (dragIdRef.current) onHoverGestureChange?.(true, previewPointerRef.current);
    if (dragOverIdx !== idx) setDragOverIdx(idx);
  };
  const onDrop = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragId) return;
    const fromIdx = items.findIndex((i) => i.id === dragId);
    if (fromIdx < 0) return;
    reorderPrompt(tabId, fromIdx, idx);
    dragIdRef.current = null;
    previewPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    onHoverGestureChange?.(false, previewPointerRef.current);
    setDragId(null);
    setDragOverIdx(null);
  };
  const onDragEnd = (e: React.DragEvent) => {
    dragIdRef.current = null;
    previewPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    onHoverGestureChange?.(false, previewPointerRef.current);
    setDragId(null);
    setDragOverIdx(null);
  };

  useEffect(() => () => {
    if (!dragIdRef.current) return;
    dragIdRef.current = null;
    onHoverGestureChange?.(false, previewPointerRef.current);
  }, [onHoverGestureChange]);

  // chipRefs is still used: openEditor() needs each chip's top coordinate to
  // anchor the editor slideout next to the clicked chip.
  const chipRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const panelOpen = !collapsed;
  const panelPinned = embedded ? embeddedPinned : panelOpen;
  const queueHoverPreviewVisible = collapsed && queueHoverPreviewOpen;
  const panelAttached = panelOpen || queueHoverPreviewVisible;
  // Модалка-редактор существует в ОБОИХ режимах панели: в развёрнутом и в
  // ховер-превью свёрнутого рейла. Превью — это тот же список сообщений, а не
  // витрина без действий: клик по строке открывает ту же боковую модалку
  // (юзер: «я кликаю на строку, у меня появляется сбоку модалка»).
  const editorSurfaceVisible = panelOpen || queueHoverPreviewVisible;
  const railRunAppearance = resolveRunAfterPlayAppearance({
    autoRun,
    activeItemCount,
    firstChipArmedHint,
    hovered: railRunHover,
  });

  const editorPreviewChip = editorChipPreviewId
    ? editorChips.find((item) => item.id === editorChipPreviewId)
    : undefined;
  const editorPreviewFileName = editorPreviewImageRef?.path?.split('/').filter(Boolean).pop()
    || (editorPreviewImageRange ? `Image #${editorPreviewImageRange.id}` : '');
  const editorPreviewLabel = editorPreviewChip
    ? (editorPreviewChip.kind === 'prompt'
      ? (editorPreviewChip.label || 'Prompt')
      : 'Pasted content')
    : editorPreviewImageRange
      ? `Image #${editorPreviewImageRange.id}`
      : null;
  const editorPreviewMeta = editorPreviewChip
    ? `${editorPreviewChip.text.length.toLocaleString()} symbols`
    : editorPreviewFileName;
  const hasEditorPreview = !!editorPreviewLabel;
  const editorPreviewLayout = editorAnchor
    ? resolveRunAfterPreviewPlacement({
      viewport: editorViewport,
      anchor: editorAnchor,
      editorWidth: editorSize.width,
      editorHeight: editorMeasuredHeight,
      margin: EDITOR_MARGIN,
      gap: EDITOR_PREVIEW_GAP,
      maxWidth: EDITOR_PREVIEW_MAX_WIDTH,
      minSideWidth: EDITOR_PREVIEW_MIN_SIDE_WIDTH,
      minPreviewWidth: 180,
      minPreviewHeight: 80,
    })
    : null;
  const editorPreviewBeside = editorPreviewLayout?.placement === 'left';
  const editorPreviewWidth = editorPreviewLayout?.width ?? EDITOR_WIDTH;
  const editorPreviewTop = editorPreviewLayout?.top ?? 0;
  const editorPreviewRight = editorPreviewLayout?.right ?? 0;
  const editorPreviewMaxHeight = editorPreviewLayout?.maxHeight ?? EDITOR_MIN_HEIGHT;

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
        data-prompt-queue-instance={embedded ? 'global' : 'tab'}
        data-prompt-queue-owner={tabId}
        data-prompt-queue-hover-owner={editorLockTokenRef.current}
        style={{
          position: embedded ? 'relative' : 'absolute',
          ...(embedded ? { width: '100%' } : {}),
          top: 0,
          // Anchored edge — pinned, never moves during resize.
          ...(ANCHOR_SIDE === 'right' ? { right: rightInset } : { left: 0 }),
          background: 'transparent',
          border: 'none',
          borderRadius: 0,
          zIndex: OVERLAY_Z_INDEX,
          fontSize: 11,
          color: '#ddd',
          maxHeight: embedded ? embeddedMaxHeight : '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: ANCHOR_SIDE === 'right' ? 'flex-end' : 'flex-start',
          gap: COLLAPSED_RAIL_GAP,
          overflow: 'visible',
          pointerEvents: 'auto',
          boxSizing: 'border-box',
        }}
      >
        {(panelOpen || queueHoverPreviewVisible) && (
          <div
            ref={queueHoverPreviewVisible ? queueHoverPreviewPanelRef : undefined}
            data-prompt-queue-panel-mode={panelPinned ? 'pinned' : 'preview'}
            data-prompt-queue-hover-preview={queueHoverPreviewVisible ? 'true' : undefined}
            style={{
              position: 'relative',
              width: embedded ? '100%' : effectiveWidth,
              // The global editor floats over other graph rows. It must be
              // opaque there: a 0.92 surface let the covered row's Play glyph
              // show through and read as an action belonging to this popup.
              background: embedded ? '#141414' : PANEL_BG,
              // Hover preview stays visually quiet. A click-pinned panel gets a
              // single dim white frame without changing geometry: the same 1px
              // border slot is recoloured rather than adding an outer ring.
              border: `1px solid ${panelPinned ? PINNED_PANEL_BORDER : BORDER}`,
              borderRadius: 6,
              backdropFilter: embedded ? undefined : 'blur(8px)',
              maxHeight: embedded
                ? embeddedMaxHeight
                : (queueHoverPreviewVisible ? 'min(60vh, 420px)' : '100%'),
              display: 'flex',
              flexDirection: 'column',
              // Border-mounted policy controls extend half a button above the
              // frame. The scrolling list remains its own clipped region.
              overflow: 'visible',
              paddingTop: 11,
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
        {!embedded && !queueHoverPreviewVisible && <div
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
        />}
        {/* Queue-wide policies sit astride the panel border, like the History
            composer status caption. Their background masks the border beneath
            them, so they consume only half a control-height inside the list
            instead of a full settings row. */}
        <div
          data-prompt-queue-edge-controls
          style={{
            position: 'absolute',
            top: 0,
            left: 12,
            transform: 'translateY(-50%)',
            zIndex: FLOATING_OVERLAY_Z_INDEX + 1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: effectiveWidth < 150 ? 2 : 3,
            padding: effectiveWidth < 150 ? '0 2px' : '0 4px',
            background: PANEL_BG,
            borderRadius: 6,
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              height: 22,
              border: `1px solid ${postPromptEnabled ? TINT : BORDER}`,
              borderRadius: 6,
              overflow: 'hidden',
              background: PANEL_BG,
            }}
          >
            <ControlHint
              label={postPromptEnabled ? 'Не добавлять post-prompt к сообщениям очереди' : 'Добавлять post-prompt к каждому сообщению очереди'}
              side="left"
            >
              <button
                type="button"
                className="pq-edge-action"
                aria-pressed={postPromptEnabled}
                onClick={() => {
                  setPostPromptEnabled(tabId, !postPromptEnabled);
                }}
                title={postPromptText ? 'Post-prompt: ' + (postPromptText.length > 60 ? postPromptText.slice(0, 60) + '…' : postPromptText) : 'Post-prompt is empty — click ✏ to add'}
                style={{
                  minWidth: effectiveWidth >= 220 ? 34 : 22,
                  height: 20,
                  padding: '0 6px',
                  background: postPromptEnabled ? `${TINT}26` : 'transparent',
                  border: 0,
                  color: postPromptEnabled ? TINT : TEXT_MUTED,
                  cursor: 'pointer',
                  fontSize: 9,
                  fontFamily: 'inherit',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 3,
                }}
              >
                <span aria-hidden style={{ fontSize: 10, lineHeight: 1 }}>▣</span>
                {effectiveWidth >= 220 && <span>Post</span>}
              </button>
            </ControlHint>
            <ControlHint label="Изменить post-prompt" side="left">
              <button
                type="button"
                className="pq-edge-action"
                data-editor-trigger="post"
                onClick={() => {
                  openPostPromptEditor();
                }}
                aria-label="Изменить post-prompt"
                style={{
                  width: 22,
                  height: 20,
                  padding: 0,
                  background: 'transparent',
                  border: 0,
                  borderLeft: `1px solid ${postPromptEnabled ? TINT : BORDER}`,
                  color: postPromptEnabled ? TINT : TEXT_MUTED,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Pencil size={10} strokeWidth={2.2} aria-hidden />
              </button>
            </ControlHint>
          </div>

          <div
            style={{
              display: 'inline-flex',
              height: 22,
              border: `1px solid ${loopPromptEnabled ? PULSE : BORDER}`,
              borderRadius: 6,
              overflow: 'hidden',
              background: PANEL_BG,
            }}
          >
            <ControlHint
              label={loopPromptEnabled ? 'Остановить циклический prompt' : 'Отправлять prompt после каждого завершения'}
              side="left"
            >
              <button
                type="button"
                className="pq-edge-action"
                aria-pressed={loopPromptEnabled}
                onClick={() => {
                  setLoopPromptEnabled(tabId, !loopPromptEnabled);
                }}
                title={loopPromptText ? 'Loop: ' + (loopPromptText.length > 60 ? loopPromptText.slice(0, 60) + '…' : loopPromptText) : 'Loop is empty — click the pencil to add text'}
                style={{
                  minWidth: 24,
                  height: 20,
                  padding: effectiveWidth >= 220 ? '0 6px' : '0 5px',
                  background: loopPromptEnabled ? `${PULSE}22` : 'transparent',
                  border: 0,
                  color: loopPromptEnabled ? PULSE : TEXT_MUTED,
                  cursor: 'pointer',
                  fontSize: 9,
                  fontFamily: 'inherit',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 3,
                }}
              >
                <RefreshCw size={10} strokeWidth={2.2} aria-hidden />
                {effectiveWidth >= 220 && <span>Loop</span>}
              </button>
            </ControlHint>
            <ControlHint label="Изменить циклический prompt" side="left">
              <button
                type="button"
                className="pq-edge-action"
                data-editor-trigger="loop"
                onClick={() => {
                  openLoopPromptEditor();
                }}
                aria-label="Изменить циклический prompt"
                style={{
                  width: 22,
                  height: 20,
                  padding: 0,
                  background: 'transparent',
                  border: 0,
                  borderLeft: `1px solid ${loopPromptEnabled ? PULSE : BORDER}`,
                  color: loopPromptEnabled ? PULSE : TEXT_MUTED,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Pencil size={10} strokeWidth={2.2} aria-hidden />
              </button>
            </ControlHint>
          </div>

          <ControlHint label="Добавить prompt; ПКМ — Compact и другие действия" side="left">
            <button
              ref={metaActionsButtonRef}
              type="button"
              className="pq-edge-action"
              data-editor-trigger="add"
              aria-label="Добавить prompt вручную"
              onClick={() => {
                openEditor();
              }}
              onContextMenu={(event) => {
                event.preventDefault(); event.stopPropagation();
                if (metaActionsMenu) setMetaActionsMenu(null); else openMetaActionsMenu();
              }}
              style={{
                width: 22,
                height: 22,
                padding: 0,
                borderRadius: 6,
                border: `1px solid ${BORDER}`,
                background: PANEL_BG,
                color: TEXT_MUTED,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Plus size={13} strokeWidth={2.1} aria-hidden />
            </button>
          </ControlHint>

          <AutoCompactControl tabId={tabId} settings global={embedded} />
        </div>
        {/* Chip list */}
        <div
          ref={chipListRef}
          data-prompt-queue-item-list
          style={{
            overflowY: 'auto',
            flex: 1,
            minHeight: 0,
            maxHeight: queueHoverPreviewVisible ? 'min(56vh, 390px)' : undefined,
            // Hover → pinned changes ownership only. These values used to be
            // 3px in preview and 0px after click, shrinking the same list by
            // 6px and pulling its first row toward the edge controls.
            paddingTop: 3,
            paddingBottom: 3,
          }}
        >
          {items.length === 0 && (
            <div style={{ padding: '4px 8px', fontSize: 9, color: TEXT_DIM, textAlign: 'center', lineHeight: 1.2 }}>
              empty
            </div>
          )}
          {items.map((it, idx) => {
            const isEnabled = isQueuedPromptEnabled(it);
            const isMetaAction = !!it.metaAction;
            const isTitleLoading = titleLoadingIds.has(it.id)
              && !getQueuedPromptLocalCommand(it.text, it.images, it.chips?.length || 0);
            const title = isTitleLoading ? '' : chipTitle(it);
            const isMultiLine = chipLineClamp > 1;
            const isEditing = editorOpen && editingId === it.id;
            const isDragOver = dragOverIdx === idx;
            const isDragging = dragId === it.id;
            const isRemoveHovered = removeHoverId === it.id;
            const isRemoving = removingIds.has(it.id);
            const isReplayHovered = replayHoverId === it.id;
            const isSendPending = promptTransportProgress?.itemId === it.id;
            const itemDictationRanges = getDictationMarkerRanges(it.text);
            const itemDictationEntries = itemDictationRanges.map((range) => (
              (dictationSnapshot.entries as any[]).find((entry) => entry.id === range.id)
            ));
            const dictationBlocked = itemDictationRanges.length > 0;
            const dictationFailed = dictationBlocked && itemDictationEntries.some((entry) => (
              !entry || entry.status === 'error' || entry.status === 'stale'
            ));
            const isReplayBusy = replayingIds.has(it.id) || isSendPending || dictationBlocked;
            const isReplaySubmitMode = isReplayHovered && cmdPressed && !isReplayBusy;
            const attachmentState = getQueuedPromptAttachmentState(it);
            const malformedImageMarker = hasMalformedQueuedImageMarker(it.text, it.imagePaths);
            const attachmentNotice = runAfterImageNotice(it.text, it.imagePaths || []);
            const chipClass = [
              'pq-chip',
              'pq-middle-delete-target',
              appearingIds.has(it.id) ? 'pq-chip-enter' : '',
              savedFlashIds.has(it.id) ? 'pq-chip-saved' : '',
              isRemoving ? 'pq-chip-removing' : '',
            ].filter(Boolean).join(' ');
            const editingOnTabTrigger = onTabTriggerDraftIds.has(it.id);
            const editingTimerTrigger = timerTriggerDraftIds.has(it.id);
            const showOnTabTrigger = editingOnTabTrigger || (!editingTimerTrigger && it.trigger?.kind === 'onTab');
            const showTimerTrigger = editingTimerTrigger || (!editingOnTabTrigger && it.trigger?.kind === 'timer');
            const showAppRestartTrigger = !editingOnTabTrigger && !editingTimerTrigger
              && it.trigger?.kind === 'app-restart';
            const showContextCondition = it.condition?.kind === 'context-used';
            return (
              <Fragment key={it.id}>
              <div
                className={chipClass}
                data-prompt-queue-item={it.id}
                data-run-after-send-status={isSendPending ? promptTransportProgress?.queueStatus : undefined}
                data-run-after-dictation={dictationBlocked ? (dictationFailed ? 'error' : 'pending') : undefined}
                ref={(el) => { if (el) chipRefs.current.set(it.id, el); else chipRefs.current.delete(it.id); }}
                draggable
                onDragStart={onDragStart(it.id)}
                onDragOver={onDragOver(idx)}
                onDrop={onDrop(idx)}
                onDragEnd={onDragEnd}
                onMouseDownCapture={(e) => {
                  if (consumePromptQueueMiddleClick(e)) return;
                  if (e.button === 2) return;
                  const target = e.target as HTMLElement;
                  if (target.closest('[data-chip-action]')) return;
                  if (closePinnedEditorFromChip(it.id)) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
                onAuxClickCapture={(event) => consumePromptQueueMiddleClick(event, () => animateRemovePrompt(it.id))}
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
                  if (isMetaAction) return;
                  openEditor(it.id, 'pin');
                }}
                onContextMenu={(e) => openChipContextMenu(it.id, e)}
                style={{
                  position: 'relative',
                  padding: '4px 7px',
                  margin: '2px 5px',
                  border: isSendPending
                    ? `1px solid ${PULSE}88`
                    : isRemoveHovered
                    ? `1px solid ${DELETE_RED}`
                    : (attachmentState === 'missing'
                      ? `1px solid ${DELETE_RED}99`
                      : (isEditing && editorPinned ? '1px solid rgba(190,190,190,0.34)' : `1px solid ${BORDER}`)),
                  borderRadius: 7,
                  backgroundColor: isSendPending
                    ? `${PULSE}18`
                    : isRemoveHovered
                    ? `${DELETE_RED}18`
                    : (!isEnabled
                      ? (isEditing || isDragOver ? DISABLED_PROMPT_BG_HOVER : DISABLED_PROMPT_BG)
                      : (isEditing ? `${TINT}1a` : (isDragOver ? `${PULSE}22` : 'transparent'))),
                  boxShadow: 'none',
                  cursor: isDragging ? 'grabbing' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'none',
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
                  data-prompt-queue-transient-action
                  ref={(el) => { if (el) replayButtonRefs.current.set(it.id, el); else replayButtonRefs.current.delete(it.id); }}
                  disabled={isMetaAction || isReplayBusy}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (isMetaAction) return;
                    console.log('[PromptQueue] replay mousedown tab=' + tabId.slice(-8) + ' item=' + it.id.slice(-8) + ' meta=' + e.metaKey + ' disabled=' + isReplayBusy);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isMetaAction) return;
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
                    isMetaAction
                      ? `Queued ${queuedMetaActionDefaultTitle(it.metaAction!)} action`
                      : dictationBlocked
                      ? (dictationFailed ? 'Диктовка требует повтора перед Replay' : 'Дождитесь завершения диктовки')
                      : isReplayBusy
                      ? (isSendPending ? `Run after: ${promptTransportProgress?.queueStatus}` : 'Replay in progress…')
                      : (isReplaySubmitMode
                        ? '⌘+click: paste and send'
                        : 'Replay: paste into ' + agentLabel + ' input. Hold ⌘ to send')
                  }
                  style={{
                    background: isReplayBusy
                      ? `${TINT}26`
                      : (isReplaySubmitMode
                        ? `${SAVE_GREEN}30`
                        : (isReplayHovered ? `${TINT}26` : 'transparent')),
                    border: isReplaySubmitMode ? `1px solid ${SAVE_GREEN}88` : '1px solid transparent',
                    color: isReplayBusy
                      ? TINT
                      : (isReplaySubmitMode ? SAVE_GREEN : (isReplayHovered ? TINT : TEXT_MUTED)),
                    cursor: isMetaAction || isReplayBusy ? 'default' : 'pointer',
                    padding: 0, lineHeight: 1, fontSize: 10,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 16, height: 16, borderRadius: 999,
                    transition: 'none',
                    flexShrink: 0,
                    boxSizing: 'border-box',
                  }}
                  onMouseEnter={(e) => {
                    if (isMetaAction || isReplayBusy) return;
                    setReplayHoverId(it.id);
                    const effectiveCmd = e.metaKey;
                    cmdPressedRef.current = effectiveCmd;
                    setCmdPressed(effectiveCmd);
                    if (!queueHoverPreviewVisible) openEditor(it.id, 'hover');
                  }}
                  onMouseMove={(e) => {
                    if (isMetaAction || isReplayBusy) return;
                    cmdPressedRef.current = e.metaKey;
                    setCmdPressed(e.metaKey);
                  }}
                  onMouseLeave={() => {
                    if (isMetaAction || isReplayBusy) return;
                    setReplayHoverId((cur) => cur === it.id ? null : cur);
                  }}
                >{isMetaAction
                    ? (it.metaAction?.kind === 'rewind'
                      ? <RotateCcw size={12} strokeWidth={2} />
                      : it.metaAction?.kind === 'restart'
                        ? <RotateCw size={12} strokeWidth={2} />
                        : it.metaAction?.kind === 'model-effort'
                          ? <SlidersHorizontal size={12} strokeWidth={2} />
                        : it.metaAction?.kind === 'stop'
                          ? <Square size={11} strokeWidth={2} fill="currentColor" />
                          : <X size={12} strokeWidth={2.2} />)
                    : (dictationBlocked
                      ? (dictationFailed
                        ? <TriangleAlert size={11} strokeWidth={2} />
                        : <span className="pq-spinner" style={{ borderTopColor: '#f5a623' }} />)
                      : (isReplayBusy ? <span className="pq-spinner" /> : '▶'))}
                </button>
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
                {(it.images > 0 || attachmentState === 'missing') && (
                  <span
                    title={attachmentState === 'missing'
                      ? (attachmentNotice?.message
                        || (malformedImageMarker ? 'Image marker is damaged' : 'Image file is unavailable'))
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
                {dictationBlocked && (
                  <span
                    title={dictationFailed
                      ? 'Диктовка не распознана — откройте карточку и нажмите чип для повтора'
                      : 'Диктовка ещё распознаётся; Run After отправит карточку после завершения'}
                    style={{ color: dictationFailed ? '#f5a623' : '#f5a623', fontSize: 9,
                      display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}
                  >
                    {dictationFailed
                      ? <TriangleAlert size={10} strokeWidth={2} />
                      : <LoaderCircle size={10} strokeWidth={2} className="pq-spin-icon" />}
                    <span>{itemDictationRanges.length}</span>
                  </span>
                )}
                <ControlHint label="Удалить сообщение из очереди" side="left">
                <button
                  data-chip-action="remove"
                  data-prompt-queue-transient-action
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
                    transition: 'none',
                  }}
                ><Trash2 size={13} strokeWidth={1.9} /></button>
                </ControlHint>
              </div>
              {(showTimerTrigger || showOnTabTrigger || showAppRestartTrigger) && (
                <div
                  className="pq-middle-delete-target"
                  data-prompt-trigger-row={it.id}
                  data-prompt-trigger-kind={it.trigger?.kind}
                  style={{
                    minHeight: 21,
                    margin: '0 5px 3px 19px',
                    padding: '1px 3px 1px 5px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    borderLeft: `1px solid ${PULSE}66`,
                    borderBottom: `1px solid ${BORDER}`,
                    borderRadius: '0 0 5px 5px',
                    backgroundColor: 'rgba(167,139,250,0.045)',
                    fontSize: Math.max(8, Math.round(promptQueueChipFontSize * 0.85)),
                  }}
                  onMouseDownCapture={(event) => { consumePromptQueueMiddleClick(event); }}
                  onAuxClickCapture={(event) => consumePromptQueueMiddleClick(event, () => clearItemTrigger(it.id))}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  {showTimerTrigger ? (
                    <PromptTriggerTimerInput
                      tabId={tabId}
                      item={it}
                      autoRun={autoRun}
                      draft={timerTriggerDraftIds.has(it.id)}
                      onCommit={() => {
                        setTimerTriggerDraftIds((current) => {
                          const next = new Set(current);
                          next.delete(it.id);
                          return next;
                        });
                        armRunAfterForSchedulingIfBusy();
                      }}
                    />
                  ) : showAppRestartTrigger ? (
                    <div style={{ minWidth: 0, flex: 1, display: 'inline-flex', alignItems: 'center', gap: 5,
                      color: '#c4b5fd' }} title="Запустить эту итерацию после следующего перезапуска приложения">
                      <RotateCw size={11} strokeWidth={1.9} />
                      <span>после перезапуска</span>
                    </div>
                  ) : (
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <RunAfterTabPicker
                        hoverOwner={editorLockTokenRef.current}
                        zIndex={FLOATING_OVERLAY_Z_INDEX + 20}
                        tabId={tabId}
                        autoRun={autoRun}
                        runAfterTabId={it.trigger?.kind === 'onTab' ? it.trigger.tabId : null}
                        setRunAfterTab={(_ownerTabId, targetTabId) => {
                          if (targetTabId) {
                            setPromptTrigger(tabId, it.id, { kind: 'onTab', tabId: targetTabId });
                            armRunAfterForSchedulingIfBusy(targetTabId);
                          } else {
                            setPromptTrigger(tabId, it.id, null);
                          }
                          setOnTabTriggerDraftIds((current) => {
                            const next = new Set(current);
                            next.delete(it.id);
                            return next;
                          });
                        }}
                        waitingTabIds={pendingQueueTabIds}
                        panelRef={panelRef}
                        emptyLabel="выбрать вкладку"
                        title="Запустить это сообщение после вкладки"
                        menuWidth={252}
                        // «Добавить on tab» из контекстного меню = намерение выбрать
                        // вкладку прямо сейчас: список открывается сам, без второго
                        // клика по пустой строке. Ключ ставится один раз на момент
                        // создания черновика (см. onTabTriggerOpenKeys) — иначе
                        // список переоткрывался бы на каждом ре-рендере строки.
                        openRequestKey={onTabTriggerOpenKeys.get(it.id) ?? 0}
                        onOpenRequestConsumed={(consumedKey) => {
                          setOnTabTriggerOpenKeys((current) => {
                            if (current.get(it.id) !== consumedKey) return current;
                            const next = new Map(current);
                            next.delete(it.id);
                            return next;
                          });
                        }}
                        // Counter starts OFF on every open: only tabs with a
                        // loader are listed, and "show all" is a deliberate
                        // one-off click. It used to open expanded, and the
                        // expanded state also survived reopening.
                        persistProjectSelection
                        // This row already owns the clear button at its far
                        // right; the tab card owns only navigation + tab state.
                        showPillClearAction={false}
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    data-chip-action="remove-trigger"
                    aria-label="Clear trigger"
                    title="Clear trigger"
                    onClick={() => clearItemTrigger(it.id)}
                    style={{ width: 17, height: 17, flex: '0 0 17px', display: 'grid', placeItems: 'center', padding: 0, border: 0, borderRadius: 4, background: 'transparent', color: TEXT_DIM, cursor: 'pointer' }}
                  ><X size={10} /></button>
                </div>
              )}
              {showContextCondition && (
                <div
                  className="pq-middle-delete-target"
                  data-prompt-context-condition-row={it.id}
                  style={{
                    minHeight: 21,
                    margin: '0 5px 3px 19px',
                    padding: '1px 3px 1px 5px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    borderLeft: `1px solid ${PULSE}66`,
                    borderBottom: `1px solid ${BORDER}`,
                    borderRadius: '0 0 5px 5px',
                    backgroundColor: 'rgba(167,139,250,0.045)',
                    fontSize: Math.max(8, Math.round(promptQueueChipFontSize * 0.85)),
                  }}
                  onMouseDownCapture={(event) => { consumePromptQueueMiddleClick(event); }}
                  onAuxClickCapture={(event) => consumePromptQueueMiddleClick(event, () => setPromptCondition(tabId, it.id, null))}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <PromptContextConditionInput
                    tabId={tabId}
                    item={it}
                    compact={effectiveWidth < 210}
                    autoFocus={contextConditionFocusIds.has(it.id)}
                    onFocusConsumed={() => setContextConditionFocusIds((current) => {
                      if (!current.has(it.id)) return current;
                      const next = new Set(current);
                      next.delete(it.id);
                      return next;
                    })}
                  />
                  <button
                    type="button"
                    data-chip-action="remove-context-condition"
                    aria-label="Clear context condition"
                    title="Clear context condition"
                    onClick={() => setPromptCondition(tabId, it.id, null)}
                    style={{ width: 17, height: 17, flex: '0 0 17px', display: 'grid', placeItems: 'center', padding: 0, border: 0, borderRadius: 4, background: 'transparent', color: TEXT_DIM, cursor: 'pointer' }}
                  ><X size={10} /></button>
                </div>
              )}
              </Fragment>
            );
          })}
        </div>

          </div>
        )}
        {!embedded && <div
          ref={railRef}
          className="pq-collapsed-rail"
          style={{
            // Horizontal row of always-available controls ABOVE the panel.
            // The measured gap below is occupied by border-mounted Post/Loop
            // controls, so the rail keeps its complete independent frame.
            order: -1,
            position: 'relative',
            zIndex: 2,
            // Без внутренних отступов (2026-08-17): рамка идёт прямо по краю
            // кнопок, поэтому сами кнопки становятся выше и полоска перестаёт
            // тратить высоту на воздух вокруг них. Раньше здесь было 3px сверху
            // и снизу и 5px по бокам — при высоте кнопки в 18px это почти треть
            // полоски.
            padding: 0,
            boxSizing: 'border-box',
            background: '#151515',
            border: '1px solid #303030',
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            flexShrink: 0,
          }}
        >
          <OrchestrationStatusChip
            tabId={tabId}
            panelOpen={panelOpen}
            effectiveWidth={effectiveWidth}
          />
          <AutoCompactControl tabId={tabId} />
          <ControlHint
            label={collapsed ? 'Закрепить очередь Run after' : 'Закрыть очередь Run after'}
            shortcut={`${activeItemCount} активных шагов`}
            side="left"
          >
            <button
              ref={queueCountButtonRef}
              className={`pq-rail-button pq-rail-count ${panelAttached ? 'pq-rail-count-open' : 'pq-rail-count-closed'}`}
              onClick={() => {
                if (collapsed) expandPanel();
                else collapsePanel();
              }}
              onMouseEnter={openQueueHoverPreview}
              title={`Run after: ${activeItemCount} queued`}
              aria-label={`${collapsed ? 'Pin' : 'Close'} Run after queue, ${activeItemCount} queued`}
              aria-expanded={panelAttached}
              style={{
                position: 'relative',
                fontSize: 10,
                fontWeight: activeItemCount > 0 ? 700 : 500,
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              {activeItemCount > 99 ? '99' : activeItemCount}
              {(postPromptEnabled || loopPromptEnabled) && (
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    right: 2,
                    bottom: 2,
                    display: 'inline-flex',
                    gap: 1,
                    pointerEvents: 'none',
                  }}
                >
                  {postPromptEnabled && <span style={{ width: 3, height: 3, borderRadius: 999, background: TINT }} />}
                  {loopPromptEnabled && <span style={{ width: 3, height: 3, borderRadius: 999, background: TINT }} />}
                </span>
              )}
            </button>
          </ControlHint>

          <ControlHint
            label={autoRun ? 'Приостановить автоматическое продолжение' : 'Запустить очередь после завершения текущего хода'}
            shortcut={runAfterTabId ? 'Ожидает выбранную вкладку' : `${activeItemCount} активных шагов`}
            side="left"
            disabled={activeItemCount === 0}
          >
            <button
              type="button"
              className={`pq-rail-button pq-rail-run${autoRun ? ' pq-rail-active' : ''}${armedFlash ? ' pq-run-armed-once' : ''}`}
              data-prompt-queue-transient-action
              data-run-after-transport-status={promptTransportProgress?.queueStatus || undefined}
              disabled={activeItemCount === 0}
              onClick={toggleAutoRun}
              onAnimationEnd={(event) => {
                if (event.animationName === 'pq-run-armed-once') setArmedFlash(false);
              }}
              onMouseEnter={() => setRailRunHover(true)}
              onMouseLeave={() => setRailRunHover(false)}
              title={autoRun ? 'Pause Run after' : 'Start Run after'}
              aria-label={autoRun ? 'Pause Run after' : 'Start Run after'}
              aria-pressed={autoRun}
              style={{
                position: 'relative',
                background: railRunAppearance.background,
                borderColor: railRunAppearance.borderColor,
                color: railRunAppearance.color,
                cursor: activeItemCount === 0 ? 'default' : 'pointer',
                opacity: railRunAppearance.opacity,
              }}
            >
              {firstChipArmedHint && (
                <span
                  key={`rail-${blinkKey}`}
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: -1,
                    borderRadius: 6,
                    pointerEvents: 'none',
                    animation: `pq-hint-blink ${BLINK_CYCLE_MS}ms ease-in-out ${BLINK_ITERATIONS}`,
                  }}
                />
              )}
              {promptTransportPending ? (
                <span
                  className="pq-spinner"
                  aria-label={`Run after ${promptTransportProgress.queueStatus}`}
                  style={{ width: 10, height: 10, borderWidth: 1.4 }}
                />
              ) : autoRun ? (
                <Pause
                  size={12}
                  strokeWidth={2.2}
                  fill="currentColor"
                  aria-hidden
                />
              ) : (
                <Play
                  size={12}
                  strokeWidth={2.2}
                  fill="currentColor"
                  aria-hidden
                  style={{ marginLeft: 1 }}
                />
              )}
            </button>
          </ControlHint>
        </div>}
      </div>

      {metaActionsMenu && createPortal(
        <div
          ref={metaActionsMenuRef}
          data-run-after-satellite="true"
          data-run-after-hover-owner={editorLockTokenRef.current}
          data-prompt-queue-meta-actions
          onMouseDown={(event) => event.stopPropagation()}
          style={{
            position: 'fixed',
            left: metaActionsMenu.left,
            top: metaActionsMenu.top,
            width: 238,
            maxHeight: Math.min(340, window.innerHeight - metaActionsMenu.top - 8),
            overflowY: 'auto',
            padding: 4,
            background: 'rgba(18,18,18,0.98)',
            border: `1px solid ${BORDER}`,
            borderRadius: 7,
            boxShadow: '0 10px 30px rgba(0,0,0,0.36)',
            zIndex: FLOATING_OVERLAY_Z_INDEX + 12,
            boxSizing: 'border-box',
          }}
        >
          {metaActionsView === 'actions' ? (
            <>
              <button type="button" onClick={() => {
                addPrompt(tabId, '/compact', 0);
                if (agentBusy) setAutoRun(tabId, true);
                setMetaActionsMenu(null);
              }} style={{ width: '100%', height: 30, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 8, border: 0, borderRadius: 5, background: 'transparent', color: PULSE, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
                <Percent size={14} /><span>Compact · ≥ 50%</span>
              </button>
              <button
                type="button"
                data-prompt-queue-add-model-effort
                disabled={!queuedModelEffortSupported}
                title={queuedModelEffortSupported
                  ? 'Добавить смену model / effort в очередь'
                  : queueProviderType
                    ? 'Отложенная смена model / effort пока доступна для Claude subscription и Codex'
                    : 'Состояние Claude provider ещё загружается'}
                onClick={() => {
                  if (queuedModelEffortSupported) setMetaActionsView('models');
                }}
                style={{ width: '100%', height: 30, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 8, border: 0, borderRadius: 5, background: 'transparent', color: queuedModelEffortSupported ? '#a7a2ff' : '#666', cursor: queuedModelEffortSupported ? 'pointer' : 'default', fontSize: 12, fontFamily: 'inherit' }}
                onMouseEnter={(event) => { if (queuedModelEffortSupported) event.currentTarget.style.background = 'rgba(139,92,246,0.12)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                <SlidersHorizontal size={14} strokeWidth={1.9} />
                <span style={{ flex: 1, textAlign: 'left' }}>Model / effort</span>
                <ChevronRight size={13} strokeWidth={1.9} />
              </button>
              <button
                type="button"
                onClick={requestQueuedRewindTarget}
                style={{ width: '100%', height: 30, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 8, border: 0, borderRadius: 5, background: 'transparent', color: PULSE, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(139,92,246,0.12)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                <RotateCcw size={14} strokeWidth={1.9} />
                <span>Rewind</span>
              </button>
              <button
                type="button"
                onClick={enqueueRestartAction}
                style={{ width: '100%', height: 30, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 8, border: 0, borderRadius: 5, background: 'transparent', color: '#ddd', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                <RotateCw size={14} strokeWidth={1.9} />
                <span>Restart</span>
              </button>
              <button
                type="button"
                onClick={enqueueStopAction}
                style={{ width: '100%', height: 30, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 8, border: 0, borderRadius: 5, background: 'transparent', color: '#f0a58b', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(218,119,86,0.10)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                <Square size={13} strokeWidth={2} fill="currentColor" />
                <span>Stop</span>
              </button>
              <button
                type="button"
                onClick={enqueueCloseTabAction}
                style={{ width: '100%', height: 30, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 8, border: 0, borderRadius: 5, background: 'transparent', color: '#f87171', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(239,68,68,0.10)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                <X size={14} strokeWidth={2.1} />
                <span>Close tab</span>
              </button>
            </>
          ) : metaActionsView === 'models' ? (
            <>
              <button
                type="button"
                onClick={() => setMetaActionsView('actions')}
                style={{ width: '100%', minHeight: 30, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 8, border: 0, borderBottom: `1px solid ${BORDER}`, borderRadius: 5, background: 'transparent', color: TEXT_MUTED, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                <ChevronLeft size={13} strokeWidth={1.9} />
                <span>{agentLabel}: выберите модель</span>
              </button>
              {queueSettingsModels.length > 0 ? queueSettingsModels.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  data-prompt-queue-model={model.id}
                  onClick={() => {
                    setMetaSettingsModelId(model.id);
                    setMetaActionsView('efforts');
                  }}
                  title={model.id}
                  style={{ width: '100%', minHeight: 30, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 8, border: 0, borderRadius: 5, background: 'transparent', color: '#ddd', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', textAlign: 'left' }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(139,92,246,0.12)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.label}</span>
                  <ChevronRight size={13} strokeWidth={1.9} color={TEXT_MUTED} />
                </button>
              )) : (
                <div style={{ padding: '9px 8px', color: TEXT_MUTED, fontSize: 11 }}>Нет доступных моделей</div>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setMetaActionsView('models')}
                style={{ width: '100%', minHeight: 30, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 8, border: 0, borderBottom: `1px solid ${BORDER}`, borderRadius: 5, background: 'transparent', color: TEXT_MUTED, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                <ChevronLeft size={13} strokeWidth={1.9} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{metaSettingsModel?.label || 'Модель'}</span>
              </button>
              {metaSettingsModel?.efforts.map((effort) => (
                <button
                  key={effort}
                  type="button"
                  data-prompt-queue-effort={effort}
                  onClick={() => enqueueModelEffortAction(metaSettingsModel, effort)}
                  style={{ width: '100%', minHeight: 30, padding: '5px 8px 5px 29px', display: 'flex', alignItems: 'center', gap: 8, border: 0, borderRadius: 5, background: 'transparent', color: '#ddd', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', textAlign: 'left' }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(139,92,246,0.12)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                >
                  <span>{effort}</span>
                </button>
              )) || (
                <div style={{ padding: '9px 8px', color: TEXT_MUTED, fontSize: 11 }}>Нет доступных effort</div>
              )}
            </>
          )}
        </div>,
        document.body,
      )}

      {chipContextMenu && chipContextItem && createPortal((() => {
        const enabled = isQueuedPromptEnabled(chipContextItem);
        const allowTitleRefresh = !chipContextItem.metaAction && !getQueuedPromptLocalCommand(
          chipContextItem.text,
          chipContextItem.images,
          chipContextItem.chips?.length || 0,
        );
        const menuWidth = 206;
        const menuHeight = (chipContextItem.trigger ? 224 : 194) - (allowTitleRefresh ? 0 : 30);
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
            data-prompt-queue-chip-menu
            data-run-after-satellite="true"
            data-run-after-hover-owner={editorLockTokenRef.current}
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
            {/* Order = scheduling first (pivot, timer, context gate), then queue
                membership. Labels are English across the whole menu. */}
            <button
              onClick={() => {
                setTimerTriggerDraftIds((current) => {
                  const next = new Set(current);
                  next.delete(chipContextItem.id);
                  return next;
                });
                setOnTabTriggerDraftIds((current) => new Set(current).add(chipContextItem.id));
                // Same click also opens the tab list: choosing this menu item
                // IS the intent to pick a tab.
                onTabTriggerOpenSeqRef.current += 1;
                const openKey = onTabTriggerOpenSeqRef.current;
                setOnTabTriggerOpenKeys((current) => new Map(current).set(chipContextItem.id, openKey));
                setChipContextMenu(null);
              }}
              style={itemBase}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              {/* Триггер «после другой вкладки» — иконка вкладки, а не стрелка:
                  стрелка уже ничего не различала рядом с таймером. */}
              <AppWindow size={14} strokeWidth={1.9} />
              <span style={{ flex: 1, minWidth: 0 }}>on tab</span>
            </button>
            <button
              onClick={() => {
                setOnTabTriggerDraftIds((current) => {
                  const next = new Set(current);
                  next.delete(chipContextItem.id);
                  return next;
                });
                setTimerTriggerDraftIds((current) => new Set(current).add(chipContextItem.id));
                setChipContextMenu(null);
              }}
              style={itemBase}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <Timer size={14} strokeWidth={1.9} />
              <span style={{ flex: 1, minWidth: 0 }}>timer</span>
            </button>
            <button
              onClick={() => { void scheduleChipAfterAppRestart(chipContextItem.id); }}
              style={{
                ...itemBase,
                background: chipContextItem.trigger?.kind === 'app-restart'
                  ? 'rgba(167,139,250,0.10)'
                  : 'transparent',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(167,139,250,0.14)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = chipContextItem.trigger?.kind === 'app-restart' ? 'rgba(167,139,250,0.10)' : 'transparent'; }}
            >
              <RotateCw size={14} strokeWidth={1.9} />
              <span style={{ flex: 1, minWidth: 0 }}>after app restart</span>
            </button>
            <button
              onClick={() => {
                if (!chipContextItem.condition) {
                  setPromptCondition(tabId, chipContextItem.id, {
                    kind: 'context-used',
                    operator: 'gte',
                    percent: 50,
                  });
                  armRunAfterForSchedulingIfBusy();
                }
                setContextConditionFocusIds((current) => new Set(current).add(chipContextItem.id));
                setChipContextMenu(null);
              }}
              style={{
                ...itemBase,
                background: chipContextItem.condition ? 'rgba(255,255,255,0.07)' : 'transparent',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.12)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = chipContextItem.condition ? 'rgba(255,255,255,0.07)' : 'transparent'; }}
            >
              <Percent size={14} strokeWidth={1.9} />
              <span style={{ flex: 1, minWidth: 0 }}>context</span>
              {chipContextItem.condition && (
                <span style={{ color: TEXT_MUTED, fontSize: 10 }}>
                  {chipContextItem.condition.operator === 'gte' ? '≥' : '≤'} {chipContextItem.condition.percent}%
                </span>
              )}
            </button>
            {/* Queue membership. The label reports the RESULTING STATE, not the
                action, so the row and its checkbox never contradict each other:
                checked + highlighted + "In queue" ⇄ unchecked + plain +
                "Not in queue". A new chip starts enabled, hence highlighted. */}
            <button
              onClick={() => toggleChipEnabled(chipContextItem.id)}
              style={{
                ...itemBase,
                background: enabled ? 'rgba(255,255,255,0.07)' : DISABLED_PROMPT_BG,
                color: enabled ? '#f0f0f0' : DISABLED_PROMPT_TEXT,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = enabled ? 'rgba(255,255,255,0.13)' : DISABLED_PROMPT_BG_HOVER; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = enabled ? 'rgba(255,255,255,0.07)' : DISABLED_PROMPT_BG; }}
            >
              {enabled ? <CheckSquare size={14} strokeWidth={1.9} /> : <Square size={14} strokeWidth={1.9} />}
              <span style={{ flex: 1, minWidth: 0 }}>{enabled ? 'In queue' : 'Not in queue'}</span>
            </button>
            {chipContextItem.trigger && (
              <button
                onClick={() => {
                  setPromptTrigger(tabId, chipContextItem.id, null);
                  setTimerTriggerDraftIds((current) => {
                    const next = new Set(current);
                    next.delete(chipContextItem.id);
                    return next;
                  });
                  setOnTabTriggerDraftIds((current) => {
                    const next = new Set(current);
                    next.delete(chipContextItem.id);
                    return next;
                  });
                  setChipContextMenu(null);
                }}
                style={{ ...itemBase, color: '#fca5a5' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(239,68,68,0.08)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <X size={14} />
                <span style={{ flex: 1, minWidth: 0 }}>Clear trigger</span>
              </button>
            )}
            {allowTitleRefresh && (
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
                <span style={{ flex: 1, minWidth: 0 }}>Refresh title</span>
              </button>
            )}
          </div>
        );
      })(), document.body)}

      {/* Expanded chip content is a sibling of the editor, not a child inside
          its title/body column. On normal desktop widths it sits immediately
          to the left; narrow layouts fall back below without covering input. */}
      {editorSurfaceVisible && editorOpen && editorAnchor && hasEditorPreview && createPortal(
        <div
          ref={editorPreviewRef}
          data-run-after-satellite="true"
          data-run-after-hover-owner={editorLockTokenRef.current}
          className="pq-editor-preview-sibling"
          data-run-after-preview-sibling
          data-preview-placement={editorPreviewBeside ? 'left' : 'below'}
          data-run-after-image-preview={editorPreviewImageRange?.id}
          style={{
            position: 'fixed',
            top: editorPreviewTop,
            right: editorPreviewRight,
            width: editorPreviewWidth,
            maxHeight: editorPreviewMaxHeight,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            color: '#ddd',
            background: PANEL_BG,
            border: editorPinned ? '1px solid rgba(190,190,190,0.36)' : `1px solid ${BORDER}`,
            borderRadius: 6,
            boxShadow: editorPinned ? '0 0 0 1px rgba(190,190,190,0.10)' : 'none',
            backdropFilter: 'blur(8px)',
            boxSizing: 'border-box',
            pointerEvents: 'auto',
            zIndex: FLOATING_OVERLAY_Z_INDEX,
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="hp-composer-chip-preview-head" style={{ flex: '0 0 auto' }}>
            <span>{editorPreviewLabel}</span>
            <span>{editorPreviewMeta}</span>
            {editorPreviewChip?.kind === 'paste' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <AttachmentPreviewToolbar
                  text={editorPreviewChip.text}
                  onDelete={() => replaceEditorPasteAnchor(editorPreviewChip, '')}
                />
              </span>
            )}
          </div>
          {editorPreviewChip ? (
            <pre
              style={{
                minHeight: 0,
                margin: 0,
                padding: 8,
                overflow: 'auto',
                color: '#bdbdbd',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: promptQueueEditorFontSize,
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {editorPreviewChip.text}
            </pre>
          ) : editorPreviewImageRange ? (
            <div style={{ minHeight: 0, overflow: 'auto' }}>
              <AIComposerImagePreview
                src={editorImageDetailPreview.url}
                loading={editorImageDetailPreview.loading}
                error={editorImageDetailPreview.error}
                alt={`Run after image attachment #${editorPreviewImageRange.id}`}
              />
            </div>
          ) : null}
        </div>,
        document.body,
      )}

      {/* Editor slideout — docked to the LEFT of the queue panel, no scrim.
          Anchored by editorAnchor: top aligned to chip/list/panel, right edge stays fixed.
          Resize controls only width; height stays content-driven by textarea rows. */}
      {/* Модалка порталится в body: внутри окна сплита она сидела бы в его
          стековом контексте, и DOM-позднее соседнее окно закрывало бы её.
          Юзер: «менюшка может идти через другие окна и перекрывать окна
          снизу» — для этого она должна жить выше ВСЕХ окон, как меню. */}
      {editorSurfaceVisible && editorOpen && editorAnchor && createPortal(
        <div
          ref={editorRef}
          data-run-after-satellite="true"
          data-run-after-hover-owner={editorLockTokenRef.current}
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
              {editorChips.some((chip) => chip.kind === 'prompt') && (
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
                  {editorChips.filter((chip) => chip.kind === 'prompt').map((chip) => {
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
                                applyRunAfterComposerSnapshot({
                                  text: restored.text,
                                  chips: nextChips,
                                  imagePaths: editorImagePaths,
                                  selectionStart: restored.caret,
                                  history: 'add',
                                  userEvent: 'input',
                                });
                                setEditorChipPreviewId((current) => current === chip.id ? null : current);
                                requestAnimationFrame(() => {
                                  editorTextareaRef.current?.focus();
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
                                const textarea = editorTextareaRef.current;
                                const selectionStart = textarea?.selectionStart ?? editorText.length;
                                const selectionEnd = textarea?.selectionEnd ?? selectionStart;
                                editorDirtyFieldsRef.current.chips = true;
                                applyRunAfterComposerSnapshot({
                                  text: editorText,
                                  chips: nextChips,
                                  imagePaths: editorImagePaths,
                                  selectionStart,
                                  selectionEnd,
                                  history: 'add',
                                  userEvent: 'delete',
                                });
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
                </div>
              )}
            </>
          )}
          {editorImageNotice && !editorImageNotice.progress && (
            <div
              role={editorImageNotice.blocking ? 'alert' : 'status'}
              data-run-after-image-notice
              data-blocking={editorImageNotice.blocking ? 'true' : 'false'}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 7,
                padding: '6px 8px',
                borderBottom: `1px solid ${editorImageNotice.blocking ? 'rgba(248, 113, 113, 0.45)' : 'rgba(251, 191, 36, 0.4)'}`,
                background: editorImageNotice.blocking
                  ? 'rgba(127, 29, 29, 0.18)'
                  : 'rgba(217, 119, 6, 0.14)',
                color: editorImageNotice.blocking ? '#fecaca' : '#fcd34d',
                fontSize: Math.max(10, promptQueueEditorFontSize - 1),
                lineHeight: 1.35,
                overflowWrap: 'anywhere',
                flexShrink: 0,
              }}
            >
              <TriangleAlert size={13} style={{ flex: '0 0 auto', marginTop: 1 }} />
              <span>{editorImageNotice.message}</span>
            </div>
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
            <ComposerEditor
              ref={editorTextareaRef}
              className="pq-image-marker-textarea"
              autoFocus={editorAutoFocus && isSpecialPromptMode}
              value={editorText}
              tokens={editorComposerTokens}
              historyPayload={editorHistoryPayload}
              historyOwnerKey={`run-after:${tabId}:${specialPromptMode || editingId || 'new'}`}
              deriveHistoryPayload={deriveEditorHistoryPayload}
              historyPayloadEqual={runAfterComposerAggregateEqual}
              fontSize={promptQueueEditorFontSize}
              clipboard={electronComposerClipboardAdapter}
              onChange={(nextText, _selection, historyPayload) => {
                if (isSpecialPromptMode) editorDirtyFieldsRef.current.special = true;
                else editorDirtyFieldsRef.current.text = true;
                const aggregate = historyPayload as RunAfterComposerAggregate | null;
                const nextImagePaths = isSpecialPromptMode
                  ? []
                  : (aggregate?.imagePaths || retainPromptImageRefsForText(
                      nextText,
                      editorImagePaths,
                    ) as QueuedImageRef[]);
                const nextChips = isSpecialPromptMode ? [] : (aggregate?.chips || editorChips);
                setEditorText(nextText);
                setEditorChips(nextChips);
                setEditorImagePaths(nextImagePaths);
                writeThroughEditorPayload(nextText, nextChips, nextImagePaths);
                if (editingId && editorDictationMarkerRanges.length > 0
                  && getDictationMarkerRanges(nextText).length === 0) {
                  signalPromptQueueDictationResolved(tabId, editingId);
                }
              }}
              onCopy={handleEditorImageAwareCopy}
              onCut={handleEditorImageAwareCopy}
              onPaste={handleEditorImagePaste}
              onKeyDown={(e) => {
                // Opt+Arrow crosses an opaque marker in one step — same rule
                // as the History composer, same spans as the highlight layer.
                if (applyMarkerAwareWordMotion(e, [
                  ...editorImageMarkerRanges,
                  ...editorPasteMarkerRanges,
                  ...editorDictationMarkerRanges,
                ])) return;
                if (e.key === 'Escape') resetEditor();
                if (e.key === 'Enter' && e.metaKey) commitEditor();
              }}
              onAuxClickCapture={(event) => {
                if (event.button !== 1 || !(event.target instanceof Element)) return;
                const token = event.target.closest('[data-composer-token-id^="paste:"]');
                if (!token || !event.currentTarget.contains(token)) return;
                const chipId = token.getAttribute('data-composer-token-id')?.slice('paste:'.length);
                const chip = editorChips.find((item) => item.id === chipId && item.kind === 'paste');
                if (!chip) return;
                event.preventDefault();
                event.stopPropagation();
                replaceEditorPasteAnchor(chip, '');
              }}
              onTokenClick={(token) => {
                if (token.kind === 'image') {
                  setEditorChipPreviewId((current) => current === token.id ? null : token.id);
                  return true;
                }
                if (token.kind === 'paste') {
                  const chipId = token.id.slice('paste:'.length);
                  setEditorChipPreviewId((current) => current === chipId ? null : chipId);
                  return true;
                }
                if (token.id.startsWith('dictation:')) {
                  const chipId = token.id.slice('dictation:'.length);
                  const entry = getDictationChip(chipId);
                  if (!entry || entry.status === 'error' || entry.status === 'stale') {
                    setDictationChipStatus(chipId, 'pending');
                    void retryVoiceRecordDictation(chipId).then((result) => {
                      if (result.ok) return;
                      setDictationChipStatus(chipId, 'error', { error: result.error });
                      showToast('Не удалось перезапустить распознавание: ' + result.error, 'error');
                    });
                  }
                  return true;
                }
                return false;
              }}
              onTokenContextMenu={(token) => {
                if (token.kind !== 'paste') return false;
                const chipId = token.id.slice('paste:'.length);
                const chip = editorChips.find((item) => item.id === chipId);
                if (!chip) return false;
                openEditorPasteChipContextMenu(chip);
                return true;
              }}
              style={{
                position: 'relative',
                zIndex: 1,
                display: 'block',
                width: '100%',
                minHeight: editorTextareaMinHeight,
                maxHeight: editorAnchor.maxHeight - (isSpecialPromptMode ? 0 : editorTitleHeight + 1),
                background: 'transparent',
                color: '#ddd',
                caretColor: '#ddd',
                border: 'none',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                lineHeight: 1.35,
                outline: 'none',
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
            onPointerDown={startEditorResize}
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
            onPointerDown={startEditorResize}
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
        </div>,
        document.body,
      )}

      {/* Pulse animation keyframes + hide number-input spinner.
          The spinner adds ~16px to the right of the input which shifted layout
          when the input narrowed under flex pressure (Run/after wrap bug). */}
      <style>{`
        /* One hover target per removable row, including child controls and
           their gaps. Layer the highlight over the state-owned background;
           no React hover state or page-wide style changes are needed. */
        .pq-middle-delete-target:hover {
          background-image: linear-gradient(rgba(255,255,255,0.06), rgba(255,255,255,0.06));
        }
        @keyframes pq-run-armed-once {
          0%, 100% { filter: brightness(1); }
          38%      { filter: brightness(1.34); }
        }
        .pq-run-armed-once {
          animation: pq-run-armed-once 1.2s ease-out 1;
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
        .pq-rail-top-row {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
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
          width: 26px;
          min-width: 26px;
          max-width: 26px;
          height: 26px;
          min-height: 26px;
          max-height: 26px;
          flex: 0 0 26px;
          /* Squares (was 999px circles): the rail is now a horizontal row
             above the panel — square buttons read as one compact toolbar.
             21 → 26px вместе с удалением отступов рейла: полоска занимает
             столько же места, сколько занимала, но всё это место теперь —
             кнопки, а не воздух вокруг них. */
          border-radius: 5px;
          padding: 0;
          line-height: 1;
          appearance: none;
          transition: none;
        }
        /* Count owns only panel visibility: dim orange while the list is
           hidden, full orange while it is visibly open (including hover
           preview). Purple is reserved for the neighbouring Run button's
           armed/executing state. Keep these selectors count-specific so a
           future shared active class cannot repaint it purple again. */
        .pq-rail-count.pq-rail-count-closed {
          background: #211915;
          border-color: #654236;
          color: #a96852;
        }
        .pq-rail-count.pq-rail-count-open,
        .pq-rail-count.pq-rail-count-closed:hover {
          background: #3a241b;
          border-color: ${TINT};
          color: #f3d0c2;
        }
        .pq-rail-count.pq-rail-count-open:hover {
          background: #43291f;
          border-color: #e98b69;
          color: #ffe1d5;
        }
        .pq-rail-run.pq-rail-active {
          background: #2b2340;
          border-color: #8b75d9;
          color: #c4b5fd;
        }
        .pq-rail-button:hover {
          background: #3a241b;
          border-color: ${TINT};
          color: #f3d0c2;
        }
        .pq-rail-run.pq-rail-active:hover {
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
        /* Every border-mounted control owns a visible hover surface. Cursor
           alone was ambiguous because Post / pencil / Loop / pencil shared one
           tiny frame and only changed to pointer without showing the hit area. */
        .pq-edge-action {
          transition: none;
        }
        .pq-edge-action:hover {
          box-shadow: inset 0 0 0 999px rgba(255,255,255,0.09);
          filter: brightness(1.18);
        }
        .pq-edge-action:focus {
          outline: none;
        }
        .pq-edge-action:focus-visible {
          box-shadow: 0 0 0 2px rgba(167,139,250,0.36), inset 0 0 0 999px rgba(255,255,255,0.07);
        }
        .pq-editor-resize-handle {
          background: transparent;
          transition: none;
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
type PromptTriggerTimerInputProps = {
  tabId: string;
  item: QueuedPrompt;
  autoRun: boolean;
  draft?: boolean;
  onCommit?: () => void;
};
type PromptContextConditionInputProps = {
  tabId: string;
  item: QueuedPrompt;
  compact?: boolean;
  autoFocus?: boolean;
  onFocusConsumed?: () => void;
};
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

function PromptContextConditionInput({
  tabId,
  item,
  compact = false,
  autoFocus = false,
  onFocusConsumed,
}: PromptContextConditionInputProps) {
  const condition = item.condition?.kind === 'context-used'
    ? item.condition
    : { kind: 'context-used' as const, operator: 'gte' as const, percent: 50 };
  const setPromptCondition = usePromptQueueStore((state) => state.setPromptCondition);
  const [draftPercent, setDraftPercent] = useState(String(condition.percent));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftPercent(String(condition.percent));
  }, [condition.percent]);

  useEffect(() => {
    if (!autoFocus) return;
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
    onFocusConsumed?.();
  }, [autoFocus, onFocusConsumed]);

  const commitPercent = useCallback(() => {
    const parsed = Number(draftPercent);
    const percent = Number.isFinite(parsed)
      ? Math.max(0, Math.min(100, Math.round(parsed)))
      : condition.percent;
    setDraftPercent(String(percent));
    setPromptCondition(tabId, item.id, { ...condition, percent });
  }, [condition, draftPercent, item.id, setPromptCondition, tabId]);

  return (
    <div
      data-prompt-context-condition-input={item.id}
      style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 4, color: '#a7a7ad' }}
    >
      <Percent size={11} strokeWidth={1.9} style={{ flexShrink: 0, color: PULSE }} />
      {!compact && <span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>Context used</span>}
      <button
        type="button"
        data-chip-action="context-operator"
        aria-label={condition.operator === 'gte' ? 'At least' : 'At most'}
        title={condition.operator === 'gte' ? 'At least — click for at most' : 'At most — click for at least'}
      onClick={() => setPromptCondition(tabId, item.id, {
        ...condition,
        percent: Number.isFinite(Number(draftPercent))
          ? Math.max(0, Math.min(100, Math.round(Number(draftPercent))))
          : condition.percent,
        operator: condition.operator === 'gte' ? 'lte' : 'gte',
      })}
        style={{
          width: 20,
          height: 17,
          padding: 0,
          border: `1px solid ${BORDER}`,
          borderRadius: 4,
          background: 'rgba(255,255,255,0.04)',
          color: '#ddd',
          cursor: 'pointer',
          fontSize: 11,
          lineHeight: 1,
          flexShrink: 0,
        }}
      >{condition.operator === 'gte' ? '≥' : '≤'}</button>
      <label style={{ minWidth: 0, flex: '0 1 44px', height: 17, display: 'flex', alignItems: 'center', border: `1px solid ${BORDER}`, borderRadius: 4, background: 'rgba(255,255,255,0.04)' }}>
        <input
          ref={inputRef}
          type="number"
          className="pq-no-spin"
          min={0}
          max={100}
          value={draftPercent}
          aria-label="Context used threshold"
          onChange={(event) => setDraftPercent(event.target.value)}
          onBlur={commitPercent}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitPercent();
              event.currentTarget.blur();
            }
          }}
          style={{ width: '100%', minWidth: 0, padding: '1px 1px 1px 3px', border: 0, outline: 0, background: 'transparent', color: '#ddd', fontSize: 10, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
        />
        <span aria-hidden style={{ paddingRight: 3, color: TEXT_MUTED, fontSize: 9 }}>%</span>
      </label>
    </div>
  );
}

function PromptTriggerTimerInput({ tabId, item, autoRun, draft = false, onCommit }: PromptTriggerTimerInputProps) {
  const cfg = item.trigger?.kind === 'timer' ? item.trigger.seconds : 0;
  const countdownAt = usePromptQueueStore((s) => s.queues.get(tabId)?.firstDelayCountdownAt ?? null);
  const isHead = usePromptQueueStore((s) => (
    s.queues.get(tabId)?.items.find(isQueuedPromptEnabled)?.id === item.id
  ));
  const setPromptTrigger = usePromptQueueStore((s) => s.setPromptTrigger);
  const [parts, setParts] = useState<FirstDelayInputParts>(() => firstDelayInputParts(cfg));
  const skipNextBlurRef = useRef(false);

  // External writes (countdown finished, cancel-edit, etc) → mirror into local
  // input only when we're NOT counting (counting mode renders from `remaining`).
  useEffect(() => {
    if (countdownAt !== null && isHead) return;
    setParts(firstDelayInputParts(cfg));
  }, [cfg, countdownAt, isHead]);

  // Tick once per second while counting. State is fully derivable from store
  // (firstDelaySeconds + firstDelayCountdownAt), no local timer state needed.
  const [, force] = useState(0);
  useEffect(() => {
    if (countdownAt === null || !isHead) return;
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [countdownAt, isHead]);

  const remaining = isHead && countdownAt !== null
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
  const disabled = !draft && autoRun && isHead;
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
    setPromptTrigger(tabId, item.id, { kind: 'timer', seconds: total });
    setParts(firstDelayInputParts(total));
    onCommit?.();
  };
  return (
    <ControlHint label="Задержка перед первым сообщением очереди" shortcut="часы · минуты · секунды" side="left">
    <div
      role="group"
      aria-label="Задержка Run after"
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        if (skipNextBlurRef.current) {
          skipNextBlurRef.current = false;
          return;
        }
        commitParts();
      }}
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
