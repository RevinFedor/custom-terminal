import React, { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo, memo, startTransition } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { X, ChevronDown, ChevronRight, Search, ArrowUp, ArrowDown, RotateCcw, AlertTriangle, Copy, Check, Loader2, TerminalSquare, Bot, ArrowLeftRight } from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerInlineToken,
} from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';
import {
  HISTORY_PANEL_DEFAULT_WIDTH,
  useUIStore,
  type HistoryPromptDraftChip,
  type HistoryPromptDraftImageRef,
  type HistoryPromptDraftWriteOptions,
  type HistoryRewindPreview,
} from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useRewindOperationStore } from '../../store/useRewindOperationStore';
import {
  isRewindOperationBlocking,
  selectActiveRewindOperation,
  type RewindOperationPhase,
} from '../../store/rewindOperationState';
import Tooltip from '../UI/Tooltip';
import ControlHint from '../UI/ControlHint';
import CenteredUpwardPopover from '../UI/CenteredUpwardPopover';
import {
  getHistoryAgentRuntime,
  type AgentDraftGrabResult,
  type AgentHistoryTool,
  type AgentPendingQuestion,
  type AgentPtyStatus,
  type AgentQuestion,
} from '../../utils/historyAgentRuntimes';
import { sendAgentPromptScenario, stopAgentProcessScenario } from '../../utils/agentScenarios';
import {
  buildExactDraftCaptureProof,
  classifyAgentDraftPreflight,
  resolveAgentDraftConflict,
} from '../../utils/agentDraftPreflight.mjs';
import {
  beginCoordinatedAgentSend,
  bindCoordinatedAgentSendHandoff,
  getCoordinatedAgentAction,
  requestCoordinatedStopAfterSend,
  settleCoordinatedAgentSend,
  subscribeCoordinatedAgentActions,
} from '../../utils/agentActionCoordinator.mjs';
import { isHistoryTaskBackgroundLive } from '../../utils/historyBackgroundLiveness.mjs';
import { foldHistoryAgentProcessLiveness } from '../../utils/historyProcessLiveness.mjs';
import {
  estimateHistoryEntriesBytesFast,
  historySnapshotCache,
  historyVolatileOverlayCache,
  makeHistorySnapshotKey,
  type HistoryDurableRevision,
  type HistorySnapshotOwner,
} from '../../utils/historySnapshotCache';
import {
  createHistoryViewportPaintProbe,
  type HistoryViewportPaintOwner,
} from '../../utils/historyViewportPaintProbe';
import {
  captureHistoryAnchorFromDom,
  getHistoryReadingAnchor,
  setHistoryReadingAnchor,
} from '../../utils/historyReadingAnchor';
import {
  saveHistoryMeasuredLayout,
  getHistoryMeasuredLayout,
  dropHistoryMeasuredLayout,
} from '../../utils/historyMeasuredLayout';
import {
  projectNativeRewindPreview,
  shouldCaptureDelayedCodexRewindPrefix,
  shouldClearRewindPreviewForOwnerTransition,
  type CodexWriterTransitionEvent,
} from '../../utils/historyRewindPreviewOwner';
import {
  buildPromptImagePayload,
  collectPromptImageRefIds,
  getPromptImageAttachmentState,
  getPromptImageMarkerHighlightRanges,
  hasMalformedPromptImageMarker,
  haveSamePromptImageRefs,
  insertPromptImageAttachments,
  normalizePromptImageIdentity,
  remapPromptImageSelectionAfterReplacement,
  retainPromptImageRefsForText,
} from '../../utils/promptImageAttachments.mjs';
import {
  buildComposerClipboardText,
  buildPortableImageImportSnapshot,
  collapsePortableImageImportSnapshot,
  collectPortableImagePathMarkers,
} from '../../utils/composerClipboard.mjs';
import {
  composerImageUrl,
  useComposerImagePreview,
  useComposerImagePreviews,
} from '../../utils/composerImagePreview';
import {
  buildPasteChipMarker,
  getPasteMarkerHighlightRanges,
  haveSameComposerChips,
  insertComposerSnapshotAtSelection,
  insertComposerTextAtSelection,
  isPlainTextPasteShortcut,
  isTerminalOnlyComposerDraft,
  normalizeComposerChips,
  parsePastedContentParts,
  restoreComposerChipToText,
  retainPasteChipsForText,
  serializeComposerDraft,
  shouldCreatePasteChip,
  isDictationClipboardPayload,
  splitPromptChipPresentation,
  upsertComposerChip,
} from '../../utils/composerChips.mjs';
import {
  mergeFailedHistoryAuthoringSnapshot,
  resolveInterruptedPromptOwnership,
} from '../../utils/historyDraftOwnership.mjs';
import {
  createHistoryTailPinScheduler,
  isHistoryTailPinned,
  scheduleHistoryBottomScroll,
} from '../../utils/historyBottomScroll.mjs';
import { flushHistoryDurableWithRetry } from '../../utils/historyDurableFlush.mjs';
import {
  applyHistoryLiveToolResultsToEntry,
  buildHistoryLivePresentation,
  extractHistoryLiveToolResults,
  historyLivePresentationIdentity,
  historyLivePresentationKey,
  reconcileCommittedHistoryLiveProjection,
  reconcileHistoryLiveToolResults,
  reduceHistoryLiveProjection,
} from '../../utils/historyLiveProjection.mjs';
import {
  extractClaudeHistoryPromptCarrierText,
  hasClaudeHistoryLiveQueuePrompt,
  isClaudeHistoryPromptLocallyOwned,
} from '../../utils/historyClaudePromptCarriers.mjs';
import {
  beginHistoryPromptHandoff,
  consumeHistoryPromptHandoff,
  getHistoryPromptHandoffsSnapshot,
  HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS,
  historyPromptHandoffAuditProofFromSendResult,
  retractHistoryPromptHandoff,
  settleHistoryPromptHandoff,
  subscribeHistoryPromptHandoffs,
} from '../../utils/historyPromptHandoffs';
import {
  matchesHistoryPromptAdoption,
  matchesHistoryPromptSuppression,
  resolveHistoryPromptHandoffPresentationSession,
} from '../../utils/historyPromptPresentation.mjs';
import {
  elapsedHistoryResponseDurationMs,
  formatHistoryResponseDuration,
} from '../../utils/historyResponseTiming.mjs';
import { queueSendTransferredOwnership } from '../../store/usePromptQueueStore';
import {
  deriveCodexEffectiveSettingsFromHistory,
  planCodexHistorySettingsProjection,
  resolveCodexEffectiveSettings,
} from '../../utils/codexEffectiveSettings.mjs';
import type { AgentLifecycleSummary } from './TerminalArea';
// Shared conversation blocks — same renderer as the SDK tab. The JSONL history
// window now draws tool-calls / diff / thinking / markdown through this package
// so its style matches the rest of the app. Subagents (Task) are intentionally
// left on the legacy SubAgentBlock path ("субагентов пока не трогаем").
import {
  ConversationMessage,
  ComposerChip,
  Markdown as CBMarkdown,
  MessageActionButton,
  MessageActionRail,
  MessageEvent,
  MessageStatusBadge,
  ThinkBlock as CBThinkBlock,
  ToolCallPart as CBToolCallPart,
} from '@noted/claude-blocks';
import {
  AIComposerImagePreview,
  AIComposerSurface,
  type AIComposerSurfaceChip,
} from './AIConversation/AIComposerSurface';

const { ipcRenderer, clipboard } = window.require('electron');

const historyDiag = (msg: string) => {
  // main.tsx already forwards every tagged console line to `log:renderer`.
  // Sending the same line explicitly doubled high-frequency History diagnostics.
  console.warn('[HistoryHandoff] ' + msg);
};

const historyOwnerDigest = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

interface FileAction {
  tool: 'Edit' | 'Write' | 'Read';
  filePath: string;
  oldString?: string;
  newString?: string;
  content?: string;
}
interface TaskAction {
  tool: 'Task';
  description: string;
  toolUseId?: string;
  result?: string;
  history?: Array<{ type: string; content?: string; tools?: string[] }>;
  // Codex in-process subagents (multi_agent_v1 / collaboration): live status
  // from rollout events + child rollout session id for future drill-in.
  subagentStatus?: 'running' | 'completed' | 'interrupted';
  agentSessionId?: string;
  processGeneration?: string;
  // Handles back to the agent's OWN transcript, so the detail pane can show
  // what it is really doing. `agentId` addresses a Claude agent directly;
  // `taskPrompt` is the fallback for a running one whose id does not exist yet
  // (see subagent-transcript.js).
  agentId?: string;
  taskPrompt?: string;
}
// Raw tool carrier emitted by the main-process parser for every non-Task
// tool_use — full name+input+result, rendered via the package ToolCallPart.
// Reference to a payload dehydrated in main: the entry carries a short
// preview; the full text is fetched by exact payloadId on expand.
interface HistoryPayloadRef {
  payloadId: string;
  totalChars: number;
}
interface RawAction {
  tool: '__raw__';
  rawTool: {
    toolUseId?: string;
    toolName: string;
    args: Record<string, any>;
    result?: string;
    resultRef?: HistoryPayloadRef;
    isError?: boolean;
    // Background Bash lifecycle (run_in_background): 'running' while only
    // the acceptance result exists; the task-notification outcome otherwise.
    backgroundStatus?: string;
    diffHunks?: Array<{
      oldStart: number;
      newStart: number;
      entries: Array<{ tag: 'eq' | 'add' | 'del'; line: string }>;
    }>;
  };
}
type Action = string | FileAction | TaskAction | RawAction;

const isRawAction = (a: Action): a is RawAction =>
  typeof a === 'object' && a !== null && 'tool' in a && (a as any).tool === '__raw__';
const isFileAction = (a: Action): a is FileAction =>
  typeof a === 'object' && a !== null && 'tool' in a && (a as any).tool !== 'Task' && (a as any).tool !== '__raw__';
const isTaskAction = (a: Action): a is TaskAction =>
  typeof a === 'object' && a !== null && 'tool' in a && (a as any).tool === 'Task';
const historyActionToolUseId = (action: Action) => {
  if (isRawAction(action)) return action.rawTool.toolUseId || '';
  if (isTaskAction(action)) return action.toolUseId || '';
  return '';
};

interface FullHistoryEntry {
  uuid: string;
  role: 'user' | 'assistant' | 'compact' | 'fork' | 'plan-mode' | 'continued' | 'queued' | 'rewind' | 'slash';
  timestamp: string;
  content: string;
  queueStatus?: 'sending' | 'queued' | 'sent' | 'cancelled' | 'failed';
  deliveryStatus?: 'editable-last-prompt';
  handoffId?: string;
  statusReason?: string;
  statusChangedAt?: number;
  statusAtSend?: AgentPtyStatus;
  rewindStatus?: 'rewinding' | 'done' | 'failed';
  optimisticAt?: number;
  thinking?: string;
  thinkingRef?: HistoryPayloadRef;
  actions?: Action[];
  sessionId: string;
  compactSummary?: string;
  compactSummaryRef?: HistoryPayloadRef;
  preTokens?: number;
  promptChips?: HistoryPromptDraftChip[];
  requiresAuditIdentity?: boolean;
  auditTimestamp?: string;
  auditHash?: string;
  auditSessionId?: string;
  auditEntryUuid?: string;
  liveProjection?: boolean;
  sourceIdentity?: string;
  livePendingThinking?: boolean;
  responseTiming?: {
    intervalId: number;
    startTs: number;
    endTs: number;
    durationMs: number;
  };
}

interface HistoryActivityTiming {
  state: 'running' | 'pending';
  intervalId: number | null;
  toolType: 'claude' | 'codex';
  sessionId: string | null;
  startTs: number;
  endTs: number | null;
  durationMs: number | null;
}

interface CompactOperationalPhase {
  kind: 'compact';
  phase: 'compacting' | null;
  active: boolean;
  tabId: string;
  provider: AgentHistoryTool;
  operationId: string;
  sessionId?: string | null;
  generation?: string | null;
  handoffId?: string | null;
  outcome?: 'completed' | 'aborted' | 'failed' | 'unknown';
  reason?: string | null;
  startedAt: number;
  endedAt?: number;
}

const reconcileCodexEffectiveSettings = (
  tabId: string,
  sessionId: string,
  entries: FullHistoryEntry[],
) => {
  const effective = deriveCodexEffectiveSettingsFromHistory(entries);
  if (!effective) return;
  const state = useWorkspaceStore.getState();
  // History loads are async. A native Rewind/resume can hand the tab to a new
  // writer while an older file is still being parsed, so only the currently
  // bound session is allowed to project its turn_context into the tab state.
  if (state.getCodexSessionId(tabId) !== sessionId) return;
  let currentTab: any = null;
  for (const [, workspace] of state.openProjects) {
    currentTab = workspace.tabs.get(tabId) || null;
    if (currentTab) break;
  }
  if (!currentTab) return;
  if (effective.effort === 'ultra') {
    const current = resolveCodexEffectiveSettings({
      codexSessionId: currentTab.codexSessionId,
      codexModel: currentTab.codexModel,
      codexEffort: currentTab.codexEffort,
      codexLiveModel: currentTab.codexLiveModel,
      codexLiveEffort: currentTab.codexLiveEffort,
      codexLiveSettingsSessionId: currentTab.codexLiveSettingsSessionId,
    });
    state.updateCodexLiveState(tabId, {
      codexLiveModel: effective.model || current.model,
      codexLiveEffort: 'ultra',
      codexLiveSettingsSessionId: sessionId,
    });
    return;
  }
  const patch = planCodexHistorySettingsProjection({
    currentModel: currentTab.codexModel,
    currentEffort: currentTab.codexEffort,
    currentProofAt: currentTab.codexSettingsProofAt,
    currentProofSessionId: currentTab.codexSettingsProofSessionId,
    historySessionId: sessionId,
    historyEffective: effective,
  });
  if (!patch) return;
  state.updateCodexState(tabId, patch);
  if (currentTab.codexLiveSettingsSessionId === sessionId) {
    // A later non-Ultra turn_context is authoritative for this same writer.
    // Clear the conversation overlay so an earlier Ultra selection cannot
    // keep winning over the newer persistent/default pair in the UI.
    state.updateCodexLiveState(tabId, {
      codexLiveModel: undefined,
      codexLiveEffort: undefined,
      codexLiveSettingsSessionId: undefined,
    });
  }
};

interface HistoryPanelProps {
  tabId: string;
  sessionId: string;
  cwd: string;
  width: number;
  notesPanelWidth: number;
  isOpen: boolean;
  toolType?: 'claude' | 'gemini' | 'codex';
  enableClaudePtyControls?: boolean;
  embedded?: boolean;
  embeddedFill?: boolean;
  previewMode?: boolean;
  mainSurface?: boolean;
  // Terminal-primary layout: the SAME History runs as the side panel and stays
  // the tab's live input surface. Geometry differs from mainSurface, ownership
  // does not — draft, availability and Escape-interrupt still belong here.
  agentSidePanel?: boolean;
  // Terminal-primary keeps ONE composer, always docked below the terminal, so
  // the user can type and watch the effect in the same glance. It renders into
  // this workspace-level host instead of inside the panel; the side History is
  // then a pure transcript. Same component, same draft — only the DOM location
  // moves, because two mounted composers would mean two drafts.
  composerPortalHostId?: string;
  onSwapPrimarySurface?: () => void;
  terminalIsPrimary?: boolean;
  projectId?: string;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  lifecycleStatus?: AgentLifecycleSummary | null;
  onControlsHeightChange?: (height: number) => void;
}

interface PromptHandoffMeta {
  text: string;
  submittedAt: number;
  sessionId?: string;
  requiresAuditIdentity?: boolean;
  auditTimestamp?: string;
  auditHash?: string;
  auditEntryUuid?: string;
  sourceIdentity?: string;
}

interface SuppressedPrompt {
  handoffId: string;
  text: string;
  requiresAuditIdentity: boolean;
  auditTimestamp?: string;
  auditSessionId?: string;
  sourceIdentity?: string;
  since: number;
  until: number;
  expiresAt: number;
  reason: string;
}

interface HistoryLiveToolResult {
  toolUseId: string;
  result: string;
  isError: boolean;
}

const EMPTY_HISTORY_LIVE_TOOL_RESULTS = new Map<string, HistoryLiveToolResult>();
// Stable identity so a "no live rows" render never invalidates chip memos.
const EMPTY_HISTORY_ENTRIES: FullHistoryEntry[] = [];
// Stable identity so an in-flight owner handoff does not churn dependent memos.
const EMPTY_HISTORY_CHIPS: HistoryBackgroundChip[] = [];

const LOCAL_PROMPT_PREFIX = 'local-prompt-';
const LOCAL_REWIND_PREFIX = 'local-rewind-';
const LOCAL_PROMPT_FAILURE_TTL_MS = HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS;
// An in-flight local rewind row whose completion event was lost (crash mid-op)
// may survive at most this long in the persisted overlay. Long enough for any
// legitimate Rewind (AI mode deadline is 170s), short enough that a stale
// "REWINDING…" cannot haunt the owner across sessions.
const LOCAL_REWIND_STALE_TTL_MS = 5 * 60 * 1000;
const HISTORY_SCROLL_PIXEL_CAP_WARN_PX = 16_000_000;
const REWIND_BUSY_GUARD_RE = /\bis (?:busy|starting); wait (?:for the current turn|until the current loader finishes) before rewind\b/i;
const EMPTY_HISTORY_DRAFT_IMAGES: HistoryPromptDraftImageRef[] = [];
const EMPTY_HISTORY_DRAFT_CHIPS: HistoryPromptDraftChip[] = [];
const HISTORY_USER_TEXT_COLLAPSE_THRESHOLD = 600;
const HISTORY_USER_TEXT_COLLAPSED_CHARS = 400;

const HistoryBottomSpacer = memo(() => (
  <div
    data-history-bottom-spacer
    aria-hidden="true"
    style={{
      height: 'var(--hp-composer-overlay-height, 0px)',
      pointerEvents: 'none',
    }}
  />
));

const normalizeHistoryPromptText = (text: string) => String(text || '')
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/\[200~/g, '').replace(/~\]/g, '').trim();

const normalizeHistoryPromptIdentityText = (text: string) =>
  normalizePromptImageIdentity(normalizeHistoryPromptText(text));

const promptPreview = (text: string, max = 80) =>
  normalizeHistoryPromptText(text).replace(/\s+/g, ' ').slice(0, max);

const HISTORY_IMAGE_PENDING_MARKER = '[Image saving…]';

const hasHistoryDraftImageError = (text: string) =>
  /\[imageError:\s*[^\]\r\n]+?\]/i.test(String(text || ''));

const retainHistoryDraftImages = (
  text: string,
  images?: HistoryPromptDraftImageRef[]
): HistoryPromptDraftImageRef[] => {
  return retainPromptImageRefsForText(text, images || []) as HistoryPromptDraftImageRef[];
};

const historyDraftImageWarning = (
  _toolType: AgentHistoryTool,
  text: string,
  images?: HistoryPromptDraftImageRef[]
): string | null => {
  if (String(text || '').includes(HISTORY_IMAGE_PENDING_MARKER)) {
    return 'Saving image attachment…';
  }
  if (hasHistoryDraftImageError(text)) {
    return 'Image attachment is unavailable. Remove imageError or paste the image again before sending.';
  }
  if (hasMalformedPromptImageMarker(text, images || [])) {
    return 'Image marker is damaged or has no matching attachment. Restore the complete [Image #N] marker or remove it.';
  }
  const imageIds = collectPromptImageRefIds(text);
  if (imageIds.size > 0 && getPromptImageAttachmentState({
    text,
    images: imageIds.size,
    imagePaths: images || [],
  }) !== 'ready') {
    return 'Image file is unavailable. Paste the image again before sending.';
  }
  return null;
};

type PromptHighlightDecoration = {
  start: number;
  end: number;
  color: string;
  fontWeight: number;
  block?: boolean;
};

const renderHistoryPromptHighlight = (
  text: string,
  ranges: Array<{ start: number; end: number; id: number }>,
  preserveCaretMetrics = false,
  pasteRanges: Array<{ start: number; end: number; id: string }> = [],
) => {
  const decorated: PromptHighlightDecoration[] = ranges.map((range) => ({
    start: range.start,
    end: range.end,
    color: '#60a5fa',
    fontWeight: 650,
  }));
  // A paste anchor reads as a foreign body inside the sentence, so unlike an
  // image marker it gets a background box, not just a colour.
  for (const range of pasteRanges) {
    decorated.push({
      start: range.start,
      end: range.end,
      color: '#c7d2fe',
      fontWeight: 650,
      block: true,
    });
  }
  const addMatches = (re: RegExp, color: string, fontWeight = 650) => {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      decorated.push({
        start: match.index,
        end: match.index + match[0].length,
        color,
        fontWeight,
      });
    }
  };
  addMatches(/\[Image saving…\]/g, '#fbbf24');
  addMatches(/\[imageError:\s*[^\]\r\n]+?\]/gi, '#f87171');
  addMatches(/\[imagePath:\s*[^\]\r\n]+?\]/gi, '#60a5fa', 550);
  decorated.sort((a, b) => a.start - b.start || b.end - a.end);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const range of decorated) {
    if (range.start < cursor) continue;
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    nodes.push(
      <span
        key={`${range.start}:${range.end}`}
        style={{
          color: range.color,
          fontWeight: preserveCaretMetrics ? undefined : range.fontWeight,
          // Padding/border are deliberately omitted: this layer must stay
          // glyph-for-glyph aligned with the textarea underneath, and any box
          // metric here would shift every following character away from the
          // real caret. Background and radius do not affect layout.
          ...(range.block ? {
            background: 'rgba(129,140,248,0.16)',
            borderRadius: 3,
            boxShadow: '0 0 0 1px rgba(129,140,248,0.34)',
          } : undefined),
        }}
      >
        {text.slice(range.start, range.end)}
      </span>
    );
    cursor = range.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
};

const renderSentHistoryPromptHighlight = (text: string) => {
  const ranges: Array<{ start: number; end: number; id: number }> = [];
  const markerRe = /(?<!\\)\[Image\s+#?(\d+)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = markerRe.exec(text)) !== null) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      id: Number(match[1]),
    });
  }
  return renderHistoryPromptHighlight(text, ranges);
};

const createPromptHandoffId = () =>
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

const createComposerChipId = (kind: HistoryPromptDraftChip['kind']) =>
  kind + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

const isRewindBusyGuardMessage = (message: string) =>
  REWIND_BUSY_GUARD_RE.test(message);

const entryMatchesSuppressedPrompt = (entry: FullHistoryEntry, suppressed: SuppressedPrompt) => {
  return matchesHistoryPromptSuppression({
    role: entry.role,
    isLocal: isLocalPromptEntry(entry),
    normalizedText: normalizeHistoryPromptIdentityText(entry.content),
    timestamp: entry.timestamp,
    sessionId: entry.sessionId,
    sourceIdentity: entry.sourceIdentity,
  }, {
    normalizedText: normalizeHistoryPromptIdentityText(suppressed.text),
    requiresAuditIdentity: suppressed.requiresAuditIdentity,
    auditTimestamp: suppressed.auditTimestamp,
    auditSessionId: suppressed.auditSessionId,
    sourceIdentity: suppressed.sourceIdentity,
    since: suppressed.since,
    until: suppressed.until,
  });
};

const filterSuppressedPromptEntries = (
  entries: FullHistoryEntry[],
  suppressions: Iterable<SuppressedPrompt>,
) => {
  const active = Array.from(suppressions);
  if (active.length === 0) return { entries, hidden: 0 };
  const filtered = entries.filter((entry) =>
    !active.some((suppressed) => entryMatchesSuppressedPrompt(entry, suppressed))
  );
  return { entries: filtered, hidden: entries.length - filtered.length };
};

const isLocalPromptEntry = (entry: FullHistoryEntry) =>
  entry.role === 'queued' && entry.uuid.startsWith(LOCAL_PROMPT_PREFIX);

const isLocalRewindEntry = (entry: FullHistoryEntry) =>
  entry.role === 'rewind' && entry.uuid.startsWith(LOCAL_REWIND_PREFIX);

const findServerPromptEntry = (
  serverEntries: FullHistoryEntry[],
  localEntry: FullHistoryEntry,
  excludedUuids: Set<string> = new Set(),
) => {
  const normalized = normalizeHistoryPromptIdentityText(localEntry.content);
  const localAt = localEntry.optimisticAt || Date.parse(localEntry.timestamp) || Date.now();
  return serverEntries.find((entry) => {
    if (excludedUuids.has(entry.uuid)) return false;
    if (localEntry.auditEntryUuid) {
      return entry.uuid === localEntry.auditEntryUuid;
    }
    const durableIdentity = {
      role: entry.role,
      normalizedText: normalizeHistoryPromptIdentityText(entry.content),
      timestamp: entry.timestamp,
      sessionId: entry.sessionId,
      sourceIdentity: entry.sourceIdentity,
    };
    const localIdentity = {
      normalizedText: normalized,
      localAt,
      requiresAuditIdentity: localEntry.requiresAuditIdentity === true,
      auditTimestamp: localEntry.auditTimestamp,
      auditSessionId: localEntry.auditSessionId,
      sourceIdentity: localEntry.sourceIdentity,
      queueStatus: localEntry.queueStatus,
      statusReason: localEntry.statusReason,
      sessionId: localEntry.auditSessionId || localEntry.sessionId,
    };
    return matchesHistoryPromptAdoption(durableIdentity, localIdentity);
  });
};

const serverHasPromptEntry = (serverEntries: FullHistoryEntry[], localEntry: FullHistoryEntry) =>
  !!findServerPromptEntry(serverEntries, localEntry);

const mergeServerAndLocalEntries = (serverEntries: FullHistoryEntry[], currentEntries: FullHistoryEntry[]) => {
  const now = Date.now();
  const consumedServerUuids = new Set<string>();
  const promptChipsByServerUuid = new Map<string, HistoryPromptDraftChip[]>();
  const locals: FullHistoryEntry[] = [];
  for (const entry of currentEntries) {
    if (isLocalRewindEntry(entry)) {
      locals.push(entry);
      continue;
    }
    if (!isLocalPromptEntry(entry)) continue;
    const matched = findServerPromptEntry(serverEntries, entry, consumedServerUuids);
    if (matched) {
      const localAt = entry.optimisticAt || Date.parse(entry.timestamp || '');
      const serverAt = Date.parse(matched.timestamp || '');
      historyDiag('PROMPT_ADOPT'
        + ' local=' + entry.uuid
        + ' handoff=' + (entry.handoffId || '-')
        + ' server=' + matched.uuid
        + ' localAt=' + (Number.isFinite(localAt) ? localAt : -1)
        + ' serverAt=' + (Number.isFinite(serverAt) ? serverAt : -1)
        + ' deltaMs=' + (
          Number.isFinite(localAt) && Number.isFinite(serverAt)
            ? serverAt - localAt
            : 'unknown'
        )
        + ' matchMode=text-lower-bound'
        + ' chips=' + (entry.promptChips?.length || 0));
      consumedServerUuids.add(matched.uuid);
      if ((entry.promptChips?.length || 0) > 0 && !(matched.promptChips?.length || 0)) {
        promptChipsByServerUuid.set(matched.uuid, entry.promptChips || []);
      }
      continue;
    }
    const ageMs = now - (
      entry.statusChangedAt
      || entry.optimisticAt
      || Date.parse(entry.timestamp || '')
      || now
    );
    if (
      (entry.queueStatus === 'cancelled' || entry.queueStatus === 'failed')
      && ageMs >= LOCAL_PROMPT_FAILURE_TTL_MS
    ) {
      continue;
    }
    locals.push(entry);
  }
  const decoratedServerEntries = promptChipsByServerUuid.size > 0
    ? serverEntries.map((entry) => {
        const chips = promptChipsByServerUuid.get(entry.uuid);
        return chips ? { ...entry, promptChips: chips } : entry;
      })
    : serverEntries;
  return locals.length > 0 ? [...decoratedServerEntries, ...locals] : decoratedServerEntries;
};

const historyActionPresentationEqual = (left: Action, right: Action) => {
  if (left === right) return true;
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (left.tool !== right.tool) return false;
  if (isRawAction(left) && isRawAction(right)) {
    return left.rawTool.toolName === right.rawTool.toolName &&
      left.rawTool.result === right.rawTool.result &&
      left.rawTool.resultRef?.payloadId === right.rawTool.resultRef?.payloadId &&
      left.rawTool.isError === right.rawTool.isError &&
      JSON.stringify(left.rawTool.args || {}) === JSON.stringify(right.rawTool.args || {}) &&
      JSON.stringify(left.rawTool.diffHunks || []) === JSON.stringify(right.rawTool.diffHunks || []);
  }
  if (isTaskAction(left) && isTaskAction(right)) {
    return left.description === right.description &&
      left.toolUseId === right.toolUseId &&
      left.result === right.result &&
      JSON.stringify(left.history || []) === JSON.stringify(right.history || []);
  }
  if (isFileAction(left) && isFileAction(right)) {
    return left.filePath === right.filePath &&
      left.oldString === right.oldString &&
      left.newString === right.newString &&
      left.content === right.content;
  }
  return false;
};

const historyEntryPresentationEqual = (left: FullHistoryEntry, right: FullHistoryEntry) => {
  if (left === right) return true;
  if (
    left.uuid !== right.uuid ||
    left.role !== right.role ||
    left.timestamp !== right.timestamp ||
    left.content !== right.content ||
    left.queueStatus !== right.queueStatus ||
    left.deliveryStatus !== right.deliveryStatus ||
    left.handoffId !== right.handoffId ||
    left.statusReason !== right.statusReason ||
    left.statusChangedAt !== right.statusChangedAt ||
    left.statusAtSend !== right.statusAtSend ||
    left.rewindStatus !== right.rewindStatus ||
    left.optimisticAt !== right.optimisticAt ||
    left.requiresAuditIdentity !== right.requiresAuditIdentity ||
    left.auditTimestamp !== right.auditTimestamp ||
    left.auditHash !== right.auditHash ||
    left.auditSessionId !== right.auditSessionId ||
    left.liveProjection !== right.liveProjection ||
    left.sourceIdentity !== right.sourceIdentity ||
    left.livePendingThinking !== right.livePendingThinking ||
    left.responseTiming?.intervalId !== right.responseTiming?.intervalId ||
    left.responseTiming?.startTs !== right.responseTiming?.startTs ||
    left.responseTiming?.endTs !== right.responseTiming?.endTs ||
    left.responseTiming?.durationMs !== right.responseTiming?.durationMs ||
    left.thinking !== right.thinking ||
    left.thinkingRef?.payloadId !== right.thinkingRef?.payloadId ||
    left.sessionId !== right.sessionId ||
    left.compactSummary !== right.compactSummary ||
    left.compactSummaryRef?.payloadId !== right.compactSummaryRef?.payloadId ||
    left.preTokens !== right.preTokens ||
    !haveSameComposerChips(left.promptChips || [], right.promptChips || [])
  ) return false;
  const leftActions = left.actions || [];
  const rightActions = right.actions || [];
  return leftActions.length === rightActions.length &&
    leftActions.every((action, index) => historyActionPresentationEqual(action, rightActions[index]));
};

const retainStableHistoryEntryReferences = (
  previous: FullHistoryEntry[],
  next: FullHistoryEntry[],
) => {
  const previousByUuid = new Map(previous.map((entry) => [entry.uuid, entry]));
  return next.map((entry) => {
    const old = previousByUuid.get(entry.uuid);
    return old && historyEntryPresentationEqual(old, entry) ? old : entry;
  });
};

const entryClockMs = (entry: FullHistoryEntry) => {
  if (entry.optimisticAt && Number.isFinite(entry.optimisticAt)) return entry.optimisticAt;
  const parsed = Date.parse(entry.timestamp || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const shouldCarryAfterRewindTarget = (entry: FullHistoryEntry, preview: HistoryRewindPreview) => {
  if (isLocalRewindEntry(entry) && entry.uuid.includes(preview.opId)) return true;
  if (isLocalPromptEntry(entry)) return true;
  return entryClockMs(entry) >= preview.startedAt - 1000;
};

const buildRewindPreviewEntries = (rawEntries: FullHistoryEntry[], preview: HistoryRewindPreview | null) => {
  if (!preview) return { entries: rawEntries, hiddenCount: 0 };
  return projectNativeRewindPreview(
    rawEntries,
    preview.targetUuid,
    (entry) => shouldCarryAfterRewindTarget(entry, preview),
  );
};

const serverHistoryMaterializedRewindBranch = (serverEntries: FullHistoryEntry[], preview: HistoryRewindPreview) => {
  const hasNewUser = serverEntries.some(
    (entry) => entry.role === 'user' && entryClockMs(entry) >= preview.startedAt - 1000,
  );
  const targetIndex = serverEntries.findIndex((entry) => entry.uuid === preview.targetUuid);
  // A committed native Claude rewind rebuilds the active parentUuid chain from
  // the restored prompt. The original target UUID can therefore disappear
  // from the active backtrace even though the new user turn is already durable.
  // Requiring that old UUID kept the local "unsaved" preview forever.
  if (targetIndex < 0) return hasNewUser;
  const afterTarget = serverEntries.slice(targetIndex + 1);
  const hasOldFuture = afterTarget.some((entry) => entryClockMs(entry) < preview.startedAt - 1000);
  const hasNewUserAfterTarget = afterTarget.some(
    (entry) => entry.role === 'user' && entryClockMs(entry) >= preview.startedAt - 1000,
  );
  return hasNewUserAfterTarget && !hasOldFuture;
};

// Thinking + markdown now render via @noted/claude-blocks (CBThinkBlock /
// CBMarkdown) — the local ThinkingBlock and the MarkdownRenderer import were
// removed. SubAgentBlock (Task) keeps its own inline rendering below.

// Short path: last 2 segments
const shortPath = (p: string) => {
  const parts = p.split('/');
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p;
};

function findHistoryScrollParent(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement || null;
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * History expansion follows the revealed content, not the old header position.
 * After Virtuoso has measured the taller row, scroll only by the part that fell
 * below the viewport. Blocks that already fit do not move the list.
 */
function applyHistoryRevealUpdate(
  anchor: HTMLElement | null,
  opening: boolean,
  update: () => void,
) {
  const scroller = findHistoryScrollParent(anchor);
  flushSync(update);
  if (!opening || !anchor || !scroller) return;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!anchor.isConnected || !scroller.isConnected) return;
      const anchorRect = anchor.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      // In the primary History surface the composer floats over the scroller.
      // The footer spacer keeps the final row reachable, but the composer's
      // occupied height is still not part of the currently visible viewport.
      // Reuse that single geometry source instead of querying a second DOM
      // element (which could select controls from another mounted tab).
      const overlayHeight = Number.parseFloat(
        window.getComputedStyle(scroller).getPropertyValue('--hp-composer-overlay-height'),
      ) || 0;
      const visibleBottom = scrollerRect.bottom - overlayHeight - 8;
      const overflow = anchorRect.bottom - visibleBottom;
      if (overflow > 0.5) scroller.scrollTop += overflow;
    });
  });
}

/**
 * Frame-by-frame convergence for a scroll restore, shared by every restore
 * mode.
 *
 * A single `scrollToIndex` is NEVER proof of arrival: Virtuoso jumps using
 * ESTIMATED row heights, and once the landed rows measure for real the
 * position silently drifts. Both known symptoms are the same defect — a
 * mid-list anchor landing ~11 rows off while the log claimed success (E2E),
 * and a tail restore visibly appearing at the top and then snapping down
 * (prod 26.07, `mode=tail` was the one branch still doing a bare jump).
 *
 * So the jump is re-issued each frame until the measured drift stops moving.
 * Exit is dual: exact (|drift| <= 2px stable for 2 frames) OR "a re-issued
 * jump no longer changes anything" (3 stagnant frames) — with fractional row
 * heights Virtuoso settles 3-4px off, and demanding exactness burned the whole
 * frame budget at an already-correct position.
 *
 * Every exit is reported. A silent `return` cannot be told apart from "the
 * loop never ran", which is precisely why the tail defect survived testing.
 */
interface HistoryConvergenceOutcome {
  attempts: number;
  settled: '1' | 'drift' | '0';
  driftPx: number | null;
  elapsedMs: number;
}

function runHistoryScrollConvergence(opts: {
  /** Signed distance from the intended position; null while unmeasurable. */
  measureDrift: () => number | null;
  /** Re-issue the jump. false = target no longer exists, abort. */
  jump: () => boolean;
  /** Cancel reason, or null to keep going. Position ownership check. */
  cancelled: () => string | null;
  onSettled: (outcome: HistoryConvergenceOutcome) => void;
  onAborted: (outcome: { attempts: number; reason: string }) => void;
}) {
  const startedAt = performance.now();
  const MAX_ATTEMPTS = 240;
  let attempts = 0;
  let stableFrames = 0;
  let stagnantFrames = 0;
  let jumpedLastFrame = false;
  let prevDrift: number | null = null;
  let lastDrift: number | null = null;

  const step = () => {
    const cancelReason = opts.cancelled();
    if (cancelReason) {
      opts.onAborted({ attempts, reason: cancelReason });
      return;
    }
    attempts += 1;
    const drift = opts.measureDrift();
    lastDrift = drift;
    const atDesired = drift !== null && Math.abs(drift) <= 2;
    const unchanged = drift !== null && prevDrift !== null
      && Math.abs(drift - prevDrift) <= 1;
    if (atDesired && unchanged) stableFrames += 1;
    else stableFrames = 0;
    if (!atDesired && unchanged && jumpedLastFrame) stagnantFrames += 1;
    else if (!unchanged) stagnantFrames = 0;
    prevDrift = drift;

    const converged = stableFrames >= 2;
    const acceptedDrift = stagnantFrames >= 3;
    if (converged || acceptedDrift || attempts >= MAX_ATTEMPTS) {
      opts.onSettled({
        attempts,
        settled: converged ? '1' : acceptedDrift ? 'drift' : '0',
        driftPx: lastDrift,
        elapsedMs: performance.now() - startedAt,
      });
      return;
    }

    jumpedLastFrame = false;
    if (!atDesired) {
      if (!opts.jump()) {
        opts.onAborted({ attempts, reason: 'target-lost' });
        return;
      }
      jumpedLastFrame = true;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function useHistoryRevealToggle(
  anchorRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
) {
  return useCallback(() => {
    const opening = !open;
    const anchor = anchorRef.current;
    applyHistoryRevealUpdate(anchor, opening, () => setOpen(opening));
  }, [anchorRef, open, setOpen]);
}

// Edit/Write — purple border, collapsible, no emoji
const FileActionBlock = memo(({ action }: { action: FileAction }) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const toggleOpen = useHistoryRevealToggle(anchorRef, open, setOpen);

  return (
    <div ref={anchorRef} style={{ marginTop: 4, borderLeft: '3px solid #c084fc', paddingLeft: 8 }}>
      <button
        onClick={toggleOpen}
        style={{
          background: 'none', border: 'none', color: '#c084fc',
          cursor: 'pointer', fontSize: '0.85em', display: 'flex',
          alignItems: 'center', gap: 4, padding: 0,
        }}
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {shortPath(action.filePath)}
      </button>
      {open && action.tool === 'Edit' && (
        <div style={{
          marginTop: 2, fontSize: '0.85em', fontFamily: 'monospace',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5,
        }}>
          {action.oldString && action.oldString.split('\n').map((line, i) => (
            <div key={'o' + i} style={{ color: '#fca5a5', backgroundColor: 'rgba(239,68,68,0.07)' }}>
              {'\u2212 '}{line}
            </div>
          ))}
          {action.newString && action.newString.split('\n').map((line, i) => (
            <div key={'n' + i} style={{ color: '#86efac', backgroundColor: 'rgba(34,197,94,0.07)' }}>
              {'+ '}{line}
            </div>
          ))}
        </div>
      )}
      {open && action.tool === 'Write' && action.content && (
        <div style={{
          marginTop: 2, fontSize: '0.85em', fontFamily: 'monospace',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#999', lineHeight: 1.5,
          maxHeight: 200, overflowY: 'auto',
        }}>
          {action.content}
        </div>
      )}
    </div>
  );
});

// Read — orange border, not collapsible, no emoji
const ReadActionBlock = ({ filePath }: { filePath: string }) => (
  <div style={{ marginTop: 4, borderLeft: '3px solid #f59e0b', paddingLeft: 8 }}>
    <span style={{ fontSize: '0.85em', color: '#f59e0b' }}>{shortPath(filePath)}</span>
  </div>
);

// Sub-agent (Task) — blue border, collapsible result and history
const SubAgentBlock = memo(({ action }: { action: TaskAction }) => {
  const [showResult, setShowResult] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const toggleResult = useHistoryRevealToggle(resultRef, showResult, setShowResult);
  const toggleHistory = useHistoryRevealToggle(historyRef, showHistory, setShowHistory);
  // Codex subagent live status: the loader is INHERITED by the card while the
  // in-process agent works; interrupted is amber, not an error red.
  const subagentRunning = action.subagentStatus === 'running';
  const subagentInterrupted = action.subagentStatus === 'interrupted';

  return (
    <div style={{ marginTop: 4, borderLeft: '3px solid ' + (subagentInterrupted ? '#d97706' : '#60a5fa'), paddingLeft: 8 }}>
      <span style={{ fontSize: '0.85em', color: subagentInterrupted ? '#d97706' : '#60a5fa', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {subagentRunning && (
          <Loader2 size={11} strokeWidth={2.5} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
        )}
        {'\u{1F9F5}'} {action.description || 'Task agent'}
      </span>

      {action.result && (
        <div ref={resultRef} style={{ marginTop: 2 }}>
          <button
            onClick={toggleResult}
            style={{
              background: 'none', border: 'none', color: '#60a5fa',
              cursor: 'pointer', fontSize: '0.77em', display: 'flex',
              alignItems: 'center', gap: 3, padding: 0, opacity: 0.8,
            }}
          >
            {showResult ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Результат
          </button>
          {showResult && (
            <div data-history-empty-state="unbound-session" style={{
              marginTop: 2, fontSize: '0.85em', color: '#bbb',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              maxHeight: 300, overflowY: 'auto',
              backgroundColor: 'rgba(96, 165, 250, 0.05)',
              padding: '4px 6px', borderRadius: 4,
            }}>
              {action.result}
            </div>
          )}
        </div>
      )}

      {action.history && action.history.length > 0 && (
        <div ref={historyRef} style={{ marginTop: 2 }}>
          <button
            onClick={toggleHistory}
            style={{
              background: 'none', border: 'none', color: '#4ade80',
              cursor: 'pointer', fontSize: '0.77em', display: 'flex',
              alignItems: 'center', gap: 3, padding: 0, opacity: 0.8,
            }}
          >
            {showHistory ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            История ({action.history.length} turns)
          </button>
          {showHistory && (
            <div style={{
              marginTop: 2, fontSize: '0.85em', maxHeight: 400, overflowY: 'auto',
              display: 'flex', flexDirection: 'column', gap: 2,
            }}>
              {action.history.map((turn, i) => (
                <div key={i} style={{
                  padding: '2px 4px', borderRadius: 3,
                  backgroundColor: turn.type === 'user'
                    ? 'rgba(255,255,255,0.03)' : 'transparent',
                }}>
                  <span style={{ color: turn.type === 'user' ? '#888' : '#60a5fa', fontSize: '0.77em' }}>
                    {turn.type === 'user' ? '\u{1F464}' : '\u{1F916}'}
                  </span>{' '}
                  {turn.content && (
                    <span style={{ color: '#aaa', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {turn.content.length > 300 ? turn.content.substring(0, 300) + '...' : turn.content}
                    </span>
                  )}
                  {turn.tools && turn.tools.map((t, j) => (
                    <div key={j} style={{ color: '#777', fontSize: '0.77em', paddingLeft: 14 }}>{t}</div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// Compact block — expandable with summary
const CompactBlock = memo(({ entry }: { entry: FullHistoryEntry }) => {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const toggleOpen = useHistoryRevealToggle(anchorRef, open, setOpen);
  const hasSummary = !!entry.compactSummary;
  const visible = open || (hovered && altHeld);
  const { text: presentedSummary } = useRehydratedPayload(
    entry.compactSummary,
    entry.compactSummaryRef,
    visible,
  );
  const tokensLabel = entry.preTokens ? `${Math.round(entry.preTokens / 1000)}k tokens` : null;

  useEffect(() => {
    if (!hasSummary) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(false);
    };
    const onBlur = () => setAltHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [hasSummary]);

  return (
    <div ref={anchorRef} style={{ padding: '4px 0' }}>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 6, cursor: hasSummary ? 'pointer' : 'default',
        }}
        onClick={hasSummary ? toggleOpen : undefined}
      >
        <div style={{ flex: 1, height: 1, backgroundColor: '#f59e0b', opacity: 0.3 }} />
        {hasSummary && (
          visible ? <ChevronDown size={10} style={{ color: '#f59e0b', flexShrink: 0 }} />
                  : <ChevronRight size={10} style={{ color: '#f59e0b', flexShrink: 0 }} />
        )}
        <span style={{ color: '#f59e0b', fontSize: '0.85em', letterSpacing: 1, flexShrink: 0, opacity: 0.8 }}>
          COMPACTED{tokensLabel ? ` (${tokensLabel})` : ''}
        </span>
        <div style={{ flex: 1, height: 1, backgroundColor: '#f59e0b', opacity: 0.3 }} />
      </div>
      {visible && entry.compactSummary && (
        <div style={{
          marginTop: 6, padding: '8px 12px',
          backgroundColor: 'rgba(245, 158, 11, 0.04)',
          borderLeft: '2px solid rgba(245, 158, 11, 0.3)',
          borderRadius: 4,
          fontSize: '0.92em', color: '#999',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: 300, overflowY: 'auto',
        }}>
          {presentedSummary || entry.compactSummary}
        </div>
      )}
    </div>
  );
});

const HistoryThinkBlock = memo(({ text, payloadRef }: {
  text: string;
  payloadRef?: HistoryPayloadRef;
}) => {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const onToggle = useHistoryRevealToggle(anchorRef, open, setOpen);
  const { text: presented } = useRehydratedPayload(text, payloadRef, open);
  return <CBThinkBlock text={presented || text} open={open} onToggle={onToggle} anchorRef={anchorRef} />;
});

// Session-scoped fetch context for dehydrated payloads. Card components sit
// several layers below the panel; the context avoids threading
// toolType/sessionId/cwd through every action render.
const HistoryPayloadContext = React.createContext<{
  toolType: 'claude' | 'gemini' | 'codex';
  sessionId: string;
  cwd?: string;
} | null>(null);

// In-flight and resolved payloads for the current renderer lifetime. Resolved
// texts are kept per payloadId so re-expanding a card is instant; bounded by
// count — payloads are display-sized after the render cap.
const rehydratedPayloadCache = new Map<string, string>();
const REHYDRATED_PAYLOAD_CACHE_MAX = 64;

const rememberRehydratedPayload = (key: string, text: string) => {
  rehydratedPayloadCache.delete(key);
  rehydratedPayloadCache.set(key, text);
  while (rehydratedPayloadCache.size > REHYDRATED_PAYLOAD_CACHE_MAX) {
    const lruKey = rehydratedPayloadCache.keys().next().value as string | undefined;
    if (lruKey === undefined) break;
    rehydratedPayloadCache.delete(lruKey);
  }
};

/**
 * Lazy full-payload loader for a dehydrated ref. Returns the preview until
 * `wanted` becomes true, then swaps in the full text once fetched. Fetch
 * failures keep the preview and surface a short inline notice — the data on
 * disk is intact, only this read failed.
 */
const useRehydratedPayload = (
  preview: string | undefined,
  ref: HistoryPayloadRef | undefined,
  wanted: boolean,
): { text: string | undefined; pending: boolean; failed: boolean } => {
  const context = React.useContext(HistoryPayloadContext);
  const cacheKey = context && ref
    ? context.toolType + ':' + context.sessionId + ':' + ref.payloadId
    : '';
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  const stateRef = useRef<{ key: string; pending: boolean; failed: boolean }>({
    key: '',
    pending: false,
    failed: false,
  });
  useEffect(() => {
    if (!wanted || !ref || !cacheKey || !context) return;
    if (rehydratedPayloadCache.has(cacheKey)) return;
    if (stateRef.current.key === cacheKey && (stateRef.current.pending || stateRef.current.failed)) return;
    stateRef.current = { key: cacheKey, pending: true, failed: false };
    force();
    let cancelled = false;
    void (async () => {
      try {
        const result = await ipcRenderer.invoke('history:get-tool-payload', {
          toolType: context.toolType,
          sessionId: context.sessionId,
          cwd: context.cwd,
          payloadId: ref.payloadId,
        });
        if (cancelled) return;
        if (result?.success && typeof result.payload === 'string') {
          const text = result.truncatedForRender
            ? result.payload + '\n… (показаны первые ' + Math.round(result.payload.length / 1024) + ' KB из ' + Math.round((result.totalChars || 0) / 1024) + ' KB)'
            : result.payload;
          rememberRehydratedPayload(cacheKey, text);
          stateRef.current = { key: cacheKey, pending: false, failed: false };
        } else {
          stateRef.current = { key: cacheKey, pending: false, failed: true };
        }
      } catch {
        if (!cancelled) stateRef.current = { key: cacheKey, pending: false, failed: true };
      }
      if (!cancelled) force();
    })();
    return () => { cancelled = true; };
  }, [wanted, cacheKey, ref, context]);

  if (!ref || !cacheKey) return { text: preview, pending: false, failed: false };
  const cached = rehydratedPayloadCache.get(cacheKey);
  if (cached !== undefined) return { text: cached, pending: false, failed: false };
  const isCurrent = stateRef.current.key === cacheKey;
  return {
    text: preview,
    pending: wanted && isCurrent && stateRef.current.pending,
    failed: isCurrent && stateRef.current.failed,
  };
};

const HistoryToolCallPart = memo(({
  toolName,
  args,
  result,
  resultRef,
  isError,
  diffHunks,
}: {
  toolName: string;
  args: Record<string, any>;
  result?: string;
  resultRef?: HistoryPayloadRef;
  isError?: boolean;
  diffHunks?: Array<{
    oldStart: number;
    newStart: number;
    entries: Array<{ tag: 'eq' | 'add' | 'del'; line: string }>;
  }>;
}) => {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => (
    toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit'
  ));
  const onToggle = useHistoryRevealToggle(anchorRef, open, setOpen);
  // The full output is fetched when the card is expanded; the preview renders
  // in the collapsed header either way.
  const { text: presentedResult, pending, failed } = useRehydratedPayload(result, resultRef, open);

  return (
    <div
      className="hp-tool-scroll-scope"
      data-history-tool-name={toolName}
    >
      <CBToolCallPart
        toolName={toolName}
        args={args}
        result={presentedResult}
        isError={isError}
        diffHunks={diffHunks}
        collapse={{ open, onToggle, anchorRef }}
      />
      {open && pending && (
        <div style={{ fontSize: '0.8em', color: '#818cf8', padding: '2px 8px' }}>
          загружается полный вывод…
        </div>
      )}
      {open && failed && (
        <div style={{ fontSize: '0.8em', color: '#d97706', padding: '2px 8px' }}>
          полный вывод не загрузился — показан фрагмент
        </div>
      )}
    </div>
  );
});

// ── Background-process zone ────────────────────────────────────────────────
// Active background work (run_in_background Bash, in-process subagents) as a
// chips strip above the composer — the same presentation the SDK tab uses
// (BackgroundTasksBar): the inline card stays in the transcript with a
// terminal/handed-off state, while the LIVE face of the process is the chip.
// Chips derive purely from durable entries; no separate lifecycle store.
interface HistoryBackgroundChip {
  key: string;
  kind: 'bash' | 'subagent';
  label: string;
  entryUuid: string;
  startedAt: number;
  // Detail-pane payload (workflow-style expansion above the bar).
  taskHistory?: Array<{ type: string; content?: string; tools?: string[] }>;
  taskResult?: string;
  agentSessionId?: string;
  agentId?: string;
  taskPrompt?: string;
  bashAcceptance?: string;
}

// One parsed step of a subagent's own transcript (main-side reader).
interface SubagentStep {
  kind: 'tool' | 'message' | 'thinking';
  text: string;
  tool?: string;
  final?: boolean;
}

const collectHistoryBackgroundChips = (
  entries: FullHistoryEntry[],
  isTurnBusy: boolean,
  agentProcessAlive: boolean,
  currentSessionId: string,
  currentProcessGeneration: string | null,
  chipToolType: string = 'claude',
): HistoryBackgroundChip[] => {
  // A chip is the LIVE face of work. Two liveness models:
  //
  // 1. Turn-scoped work (Claude Task subagents without an explicit status):
  //    lives only in the LAST turn while that turn is busy right now.
  //    Historical turns are full of result-less cards (aborted turns,
  //    docs-noise, rewound branches); treating them as running produced
  //    boards of eternal "1236m" chips after a restart. Claude Escape kills
  //    the turn's subagents, so busy=false is terminal for them.
  //
  // 2. Process-scoped work — outlives its spawn turn but never the host
  //    process (gate: composer availability), scanned across ALL turns
  //    because "spawn in turn N, still running in turn N+2" is its normal
  //    shape (a last-turn-only scan silently dropped these chips the moment
  //    the user sent another prompt):
  //    - Codex in-process subagents with an EXPLICIT rollout status: no
  //      terminal event can ever arrive for a dead codex process.
  //    - Claude background Bash (run_in_background): the turn ends at the
  //      ACCEPTANCE while the OS process keeps running; the outcome arrives
  //      later as an injected <task-notification> turn. E2E (ct-e2e13 C)
  //      showed a fast turn ends before the acceptance even reaches the
  //      renderer, so a busy-gated bash chip is unobservable by design.
  //      Epoch guard: `claude --resume` copies the parent transcript with
  //      the ORIGINAL sessionId, and those copied acceptances can never
  //      notify in this process — only acceptances from the current session
  //      epoch are live.
  if (!isTurnBusy && !agentProcessAlive) return [];
  let lastTurnStart = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role === 'user' && !isLocalPromptEntry(entries[i])) {
      lastTurnStart = i;
      break;
    }
  }
  const chips: HistoryBackgroundChip[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!Array.isArray(entry.actions)) continue;
    const inLastTurn = i >= lastTurnStart;
    for (const action of entry.actions) {
      if (isRawAction(action) && action.rawTool.backgroundStatus === 'running') {
        if (!agentProcessAlive) continue; // process-scoped
        if (entry.sessionId && currentSessionId && entry.sessionId !== currentSessionId) {
          continue; // resume-copied acceptance from a previous epoch
        }
        const command = typeof action.rawTool.args?.command === 'string'
          ? action.rawTool.args.command
          : '';
        chips.push({
          key: 'bash:' + (action.rawTool.toolUseId || entry.uuid),
          kind: 'bash',
          label: command.slice(0, 80) || action.rawTool.toolName,
          entryUuid: entry.uuid,
          startedAt: Date.parse(entry.timestamp || '') || 0,
          bashAcceptance: action.rawTool.result,
        });
        continue;
      }
      if (!isTaskAction(action)) continue;
      // Explicit rollout status (Codex) is process-scoped truth; a Claude
      // Task without one is turn-scoped and needs the busy gate.
      const running = isHistoryTaskBackgroundLive({
        // Provider decides which proof of liveness applies: Codex must match a
        // process generation, Claude never has one to match.
        toolType: chipToolType,
        subagentStatus: action.subagentStatus,
        actionProcessGeneration: action.processGeneration,
        currentProcessGeneration,
        agentProcessAlive,
        inLastTurn,
        isTurnBusy,
        hasResult: action.result != null,
      });
      if (running) {
        chips.push({
          key: 'task:' + (action.toolUseId || entry.uuid),
          kind: 'subagent',
          label: (action.description || 'Task agent').slice(0, 80),
          entryUuid: entry.uuid,
          startedAt: Date.parse(entry.timestamp || '') || 0,
          taskHistory: action.history,
          taskResult: action.result,
          agentSessionId: action.agentSessionId,
          agentId: action.agentId,
          taskPrompt: action.taskPrompt,
        });
      }
    }
  }
  // Newest first, matching the SDK bar.
  return chips.sort((a, b) => b.startedAt - a.startedAt);
};

// Entry uuids that currently have a LIVE background chip. The inline
// «РАБОТАЕТ В ФОНЕ» badge follows chip liveness: a background card whose
// process died with the turn (no notification ever) must not pulse forever.
const HistoryBackgroundLiveContext = React.createContext<ReadonlySet<string>>(new Set());


const HistoryBackgroundDot = () => (
  <span
    className="inline-block w-[6px] h-[6px] rounded-full shrink-0"
    style={{
      background: '#d97706',
      animation: 'sdk-bg-task-pulse 1.4s ease-in-out infinite',
      boxShadow: '0 0 4px rgba(217, 119, 6, 0.4)',
    }}
  />
);

const formatBackgroundElapsed = (startedAt: number) => {
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs === 0 ? m + 'm' : m + 'm ' + rs + 's';
};

// Live steps of one subagent, tailed from its own transcript.
//
// The agent writes into its OWN file and returns only a final answer to the
// parent, so the parent transcript can never show the work. Reading is
// incremental: real agents produce thousands of records (one explorer wrote
// 3810), and re-parsing the whole file every tick would stall the main process
// precisely while the user is watching. `offset` advances by consumed bytes;
// a partial trailing line is left for the next tick instead of being dropped.
const useSubagentSteps = (chip: HistoryBackgroundChip | null, tabId: string, toolType: string, cwd: string, sessionId: string) => {
  const [steps, setSteps] = useState<SubagentStep[]>([]);
  const [pending, setPending] = useState(false);
  const offsetRef = useRef(0);
  const chipKey = chip?.kind === 'subagent' ? chip.key : '';

  useEffect(() => {
    if (!chipKey) { setSteps([]); setPending(false); offsetRef.current = 0; return; }
    let cancelled = false;
    offsetRef.current = 0;
    setSteps([]);
    setPending(true);
    // A LIVE Codex card has no thread id yet: the spawn is rendered when the
    // call appears, while the id arrives later (spawn output in v1, an activity
    // event in v2). The main-side watcher already knows it, so ask before the
    // first read — otherwise the pane sits on "loading" for the agent's whole
    // life (E2E ct-e2e27).
    let resolvedThreadId = chip?.agentSessionId || '';
    const tick = async () => {
      try {
        if (toolType === 'codex' && !resolvedThreadId) {
          const resolved = await ipcRenderer.invoke('subagent:resolve-codex-thread', {
            tabId,
            callId: chip?.key?.replace(/^task:/, '') || '',
          });
          if (resolved?.threadId) resolvedThreadId = resolved.threadId;
        }
        const res = await ipcRenderer.invoke('subagent:read-steps', {
          chipKey,
          toolType,
          parentSessionId: sessionId,
          cwd,
          agentId: chip?.agentId,
          agentSessionId: resolvedThreadId,
          taskText: chip?.taskPrompt || chip?.label,
          spawnedAt: chip?.startedAt,
          offset: offsetRef.current,
        });
        if (cancelled) return;
        if (res?.success && Array.isArray(res.steps)) {
          offsetRef.current = Number(res.offset) || offsetRef.current;
          if (res.steps.length > 0) {
            // Append: each tick returns only what was newly written.
            setSteps((prev) => [...prev, ...res.steps].slice(-400));
            setPending(false);
          } else if (!res.pending) {
            setPending(false);
          }
        }
      } catch { /* transient: the file may be mid-rotation */ }
    };
    tick();
    const timer = window.setInterval(tick, 1200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [chipKey, toolType, cwd, sessionId, chip?.agentId, chip?.agentSessionId, chip?.taskPrompt, chip?.label, chip?.startedAt]);

  return { steps, pending };
};

// Workflow-style detail pane above the chips bar: what the agent is doing
// right now — its real steps, tailed live from the agent's own transcript.
// Read-only by design: no input; stopping stays on the existing Escape flow
// which interrupts the whole turn.
const HistoryBackgroundDetailPane = memo(({
  chip,
  onJumpToCard,
  onClose,
  tabId,
  toolType,
  cwd,
  sessionId,
}: {
  chip: HistoryBackgroundChip;
  onJumpToCard: (entryUuid: string) => void;
  onClose: () => void;
  tabId: string;
  toolType: string;
  cwd: string;
  sessionId: string;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { steps: liveSteps, pending: stepsPending } = useSubagentSteps(chip, tabId, toolType, cwd, sessionId);
  const [showThinking, setShowThinking] = useState(false);
  // Reasoning dwarfs everything else (784 thinking records vs 39 answers on a
  // real Codex agent), so it is folded away unless explicitly asked for.
  const visibleSteps = useMemo(
    () => (showThinking ? liveSteps : liveSteps.filter((step) => step.kind !== 'thinking')),
    [liveSteps, showThinking],
  );
  const thinkingCount = useMemo(
    () => liveSteps.reduce((sum, step) => sum + (step.kind === 'thinking' ? 1 : 0), 0),
    [liveSteps],
  );
  const stepCount = visibleSteps.length || chip.taskHistory?.length || 0;
  // Follow the newest step while the agent works.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stepCount]);
  return (
    <div
      data-history-background-detail
      style={{
        maxHeight: 260,
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid #2a2a2a',
        background: '#111111',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 10px', borderBottom: '1px solid #222',
        color: '#bdbdbd', fontSize: '0.85em',
      }}>
        <HistoryBackgroundDot />
        {chip.kind === 'bash'
          ? <TerminalSquare size={12} style={{ color: '#d97706', flexShrink: 0 }} />
          : <Bot size={12} style={{ color: '#d97706', flexShrink: 0 }} />}
        <span className="truncate" style={{ flex: 1, fontFamily: 'monospace' }}>{chip.label}</span>
        <span style={{ color: '#666', fontVariantNumeric: 'tabular-nums' }}>
          {formatBackgroundElapsed(chip.startedAt)}
        </span>
        <button
          type="button"
          onClick={() => onJumpToCard(chip.entryUuid)}
          style={{
            background: 'none', border: '1px solid #333', borderRadius: 4,
            color: '#999', fontSize: '0.9em', padding: '1px 8px', cursor: 'pointer',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ddd'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#999'; }}
        >
          в историю
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close agent pane"
          style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', padding: 2 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ddd'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#666'; }}
        >
          <X size={13} />
        </button>
      </div>
      <div
        ref={scrollRef}
        style={{ overflowY: 'auto', padding: '6px 10px', fontSize: '0.82em', color: '#aaa' }}
      >
        {chip.kind === 'subagent' && (visibleSteps.length > 0 ? (
          <>
            {visibleSteps.map((step, index) => (
              <div key={index} style={{ marginBottom: 5 }}>
                {step.kind === 'tool' && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ color: '#60a5fa', fontFamily: 'monospace', flexShrink: 0 }}>
                      {step.tool}
                    </span>
                    <span style={{
                      color: '#7a7a7a', fontFamily: 'monospace', fontSize: '0.95em',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      maxHeight: 44, overflow: 'hidden',
                    }}>
                      {step.text}
                    </span>
                  </div>
                )}
                {step.kind === 'message' && (
                  <div style={{
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    color: step.final ? '#ddd' : '#bbb',
                    maxHeight: 140, overflow: 'hidden',
                  }}>
                    {step.text}
                  </div>
                )}
                {step.kind === 'thinking' && (
                  <div style={{
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    color: '#6b6b6b', fontStyle: 'italic',
                    maxHeight: 100, overflow: 'hidden',
                  }}>
                    {step.text}
                  </div>
                )}
              </div>
            ))}
            {thinkingCount > 0 && (
              <button
                type="button"
                onClick={() => setShowThinking((value) => !value)}
                style={{
                  background: 'none', border: 'none', color: '#666',
                  cursor: 'pointer', fontSize: '0.95em', padding: '2px 0',
                }}
              >
                {showThinking ? 'скрыть размышления' : 'показать размышления (' + thinkingCount + ')'}
              </button>
            )}
          </>
        ) : (
          <div style={{ color: '#666' }}>
            {stepsPending
              ? 'Загружаем шаги агента…'
              : 'Агент работает — промежуточные шаги появятся здесь по мере записи.'}
          </div>
        ))}
        {chip.kind === 'bash' && (
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace' }}>
            {chip.bashAcceptance || 'Команда работает в фоне; итог придёт уведомлением.'}
          </div>
        )}
      </div>
    </div>
  );
});

const HistoryBackgroundTasksBar = memo(({
  chips,
  expandedKey,
  onToggle,
  onJumpToCard,
  tabId,
  toolType,
  cwd,
  sessionId,
}: {
  chips: HistoryBackgroundChip[];
  expandedKey: string | null;
  onToggle: (chipKey: string) => void;
  onJumpToCard: (entryUuid: string) => void;
  // Passed through to the detail pane, which needs them to locate the
  // expanded agent's own transcript.
  tabId: string;
  toolType: string;
  cwd: string;
  sessionId: string;
}) => {
  // 1s tick keeps elapsed labels live while anything runs.
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (chips.length === 0) return;
    const handle = window.setInterval(() => force(), 1000);
    return () => window.clearInterval(handle);
  }, [chips.length]);
  if (chips.length === 0) return null;
  const expandedChip = expandedKey
    ? chips.find((chip) => chip.key === expandedKey) || null
    : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {expandedChip && (
        <HistoryBackgroundDetailPane
          chip={expandedChip}
          onJumpToCard={onJumpToCard}
          onClose={() => onToggle(expandedChip.key)}
          tabId={tabId}
          toolType={toolType}
          cwd={cwd}
          sessionId={sessionId}
        />
      )}
      <div
        data-history-background-tasks
        className="flex items-stretch overflow-x-auto shrink-0"
        style={{ borderTop: '1px solid #2a2a2a', background: '#141414' }}
      >
        {chips.map((chip, index) => {
          const expanded = chip.key === expandedKey;
          return (
            <React.Fragment key={chip.key}>
              {index > 0 && (
                <span
                  aria-hidden
                  className="self-stretch shrink-0"
                  style={{ width: 1, background: '#2a2a2a', margin: '4px 0' }}
                />
              )}
              <button
                type="button"
                onClick={() => onToggle(chip.key)}
                onMouseDown={(event) => event.preventDefault()}
                className="group inline-flex items-center gap-1.5 px-2.5 py-1 text-[0.85em] font-mono shrink-0 cursor-pointer transition-colors outline-none"
                style={{
                  background: expanded ? 'rgba(217, 119, 6, 0.10)' : 'transparent',
                  color: '#bdbdbd',
                  minHeight: 22,
                }}
                onMouseEnter={(event) => { if (!expanded) (event.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
                onMouseLeave={(event) => { if (!expanded) (event.currentTarget as HTMLElement).style.background = 'transparent'; }}
                title={chip.label}
              >
                <HistoryBackgroundDot />
                {chip.kind === 'bash'
                  ? <TerminalSquare size={11} style={{ color: '#d97706' }} />
                  : <Bot size={11} style={{ color: '#d97706' }} />}
                <span className="truncate max-w-[220px]">{chip.label}</span>
                {chip.startedAt > 0 && (
                  <span className="text-[0.85em] text-[#666] tabular-nums">{formatBackgroundElapsed(chip.startedAt)}</span>
                )}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
});

const historyEntryDetailsText = (
  entry: FullHistoryEntry,
  toolType?: 'claude' | 'gemini' | 'codex',
) => {
  const provider = toolType === 'gemini' ? 'Gemini' : toolType === 'codex' ? 'Codex' : 'Claude';
  const timestamp = entry.timestamp ? new Date(entry.timestamp) : null;
  return [
    'Agent: ' + provider,
    'Role: ' + entry.role,
    timestamp && !Number.isNaN(timestamp.getTime()) ? 'Time: ' + timestamp.toLocaleString() : null,
    entry.uuid ? 'Message ID: ' + entry.uuid : null,
    entry.sessionId ? 'Session ID: ' + entry.sessionId : null,
    entry.handoffId ? 'Handoff ID: ' + entry.handoffId : null,
    entry.queueStatus ? 'Queue status: ' + entry.queueStatus : null,
    entry.rewindStatus ? 'Rewind status: ' + entry.rewindStatus : null,
  ].filter(Boolean).join('\n');
};

const pointTouchesHistoryText = (root: HTMLElement, clientX: number, clientY: number) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.textContent?.trim()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          return true;
        }
      }
    }
    node = walker.nextNode();
  }
  return false;
};

const historyToolScrollBodyFromTarget = (
  target: EventTarget | null,
  outerScroller: HTMLElement,
): HTMLElement | null => {
  const element = target instanceof Element ? target : null;
  const body = element?.closest('.cb-tool-body') as HTMLElement | null;
  if (!body || !outerScroller.contains(body) || !body.closest('.hp-tool-scroll-scope')) return null;
  return body;
};

const findHistoryToolInnerScroller = (
  body: HTMLElement,
  target: EventTarget | null,
): HTMLElement | null => {
  const isScrollable = (element: HTMLElement) => {
    const overflowY = window.getComputedStyle(element).overflowY;
    return /(auto|scroll)/.test(overflowY)
      && element.scrollHeight > element.clientHeight + 1;
  };

  let element = target instanceof HTMLElement ? target : null;
  while (element && element !== body) {
    if (isScrollable(element)) return element;
    element = element.parentElement;
  }
  for (const candidate of body.querySelectorAll<HTMLElement>('*')) {
    if (isScrollable(candidate)) return candidate;
  }
  return null;
};

const openHistoryEntryContextMenu = (
  event: React.MouseEvent<HTMLDivElement>,
  entry: FullHistoryEntry,
  toolType?: 'claude' | 'gemini' | 'codex',
) => {
  const selection = window.getSelection();
  if (
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    event.currentTarget.contains(selection.anchorNode)
  ) {
    return;
  }

  const target = event.target as HTMLElement | null;
  if (target?.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
  if (pointTouchesHistoryText(event.currentTarget, event.clientX, event.clientY)) return;

  event.preventDefault();
  event.stopPropagation();
  console.log(
    '[HistoryEntryMenu] open role=' + entry.role +
    ' id=' + (entry.uuid ? entry.uuid.slice(0, 8) : 'none'),
  );
  ipcRenderer.send('show-history-entry-context-menu', {
    copyText: historyEntryDetailsText(entry, toolType),
  });
};

const HistoryCollapsiblePrompt = ({
  text,
  forceExpanded = false,
}: {
  text: string;
  forceExpanded?: boolean;
}) => {
  const [expanded, setExpanded] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const needsCollapse = text.length > HISTORY_USER_TEXT_COLLAPSE_THRESHOLD;
  const open = forceExpanded || expanded;
  const toggleExpanded = useHistoryRevealToggle(anchorRef, expanded, setExpanded);
  if (!needsCollapse) {
    return <p className="cb-msg-text">{renderSentHistoryPromptHighlight(text)}</p>;
  }
  const preview = text.slice(0, HISTORY_USER_TEXT_COLLAPSED_CHARS).trimEnd();
  const toggle = (
    <button
      type="button"
      className="cb-collapse-btn"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleExpanded();
      }}
    >
      {open ? 'Свернуть' : `Раскрыть полностью (${text.split('\n').length.toLocaleString()} строк)`}
    </button>
  );
  return (
    <div ref={anchorRef}>
      {open && !forceExpanded && <div className="cb-collapse-top">{toggle}</div>}
      <p className="cb-msg-text">
        {renderSentHistoryPromptHighlight(open ? text : preview + '…')}
      </p>
      {!forceExpanded && <div className="cb-collapse-bottom">{toggle}</div>}
    </div>
  );
};

const HistoryChipPopover = ({
  anchor,
  onClose,
  children,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
}) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!anchor?.isConnected) return null;

  return createPortal(
    <>
      <div
        data-history-chip-popover-backdrop
        aria-hidden
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10069,
          background: 'transparent',
        }}
      />
      <CenteredUpwardPopover
        getAnchorRect={() => (anchor.isConnected ? anchor.getBoundingClientRect() : null)}
        horizontalAlign="end"
        gap={4}
        zIndex={10070}
        style={{ width: 'min(560px, calc(100vw - 16px))' }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </CenteredUpwardPopover>
    </>,
    document.body,
  );
};

const HistoryUserPromptContent = ({
  text,
  promptChips = [],
  forceExpanded = false,
}: {
  text: string;
  promptChips?: HistoryPromptDraftChip[];
  forceExpanded?: boolean;
}) => {
  const [expandedPart, setExpandedPart] = useState<string | null>(null);
  const revealAnchorsRef = useRef<Map<string, HTMLElement>>(new Map());
  const setRevealAnchor = useCallback((partKey: string, node: HTMLElement | null) => {
    if (node) revealAnchorsRef.current.set(partKey, node);
    else revealAnchorsRef.current.delete(partKey);
  }, []);
  const togglePopoverPart = useCallback((partKey: string, open: boolean) => {
    if (forceExpanded) return;
    setExpandedPart(open ? null : partKey);
  }, [forceExpanded]);
  const closePopover = useCallback(() => setExpandedPart(null), []);
  const promptPresentation = useMemo(
    () => splitPromptChipPresentation({ text, chips: promptChips }),
    [promptChips, text],
  );
  const parts = useMemo(
    () => parsePastedContentParts(promptPresentation.text),
    [promptPresentation.text],
  );
  if (
    promptPresentation.chips.length === 0
    && !parts.some((part: { kind: string }) => part.kind === 'paste')
  ) {
    return <HistoryCollapsiblePrompt text={text} forceExpanded={forceExpanded} />;
  }
  return (
    <div className="cb-user-parts">
      {promptPresentation.chips.length > 0 && (
        <div
          data-history-user-prompt-chips
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}
        >
          {promptPresentation.chips.map((chip: HistoryPromptDraftChip, index: number) => {
            const partKey = `prompt:${chip.id || index}`;
            const open = forceExpanded || expandedPart === partKey;
            return (
              <div
                key={partKey}
                style={{ maxWidth: '100%' }}
              >
                <span
                  ref={(node) => setRevealAnchor(partKey, node)}
                  style={{ display: 'inline-flex' }}
                >
                  <ComposerChip
                    kind="prompt"
                    label={chip.label || 'PROMPT'}
                    onClick={() => togglePopoverPart(partKey, open)}
                  />
                </span>
                {forceExpanded && (
                  <div className="cb-paste-chip-body">
                    <div style={{ marginBottom: 5, color: '#777', fontSize: '0.82em' }}>
                      {chip.text.length.toLocaleString()} символов
                    </div>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{chip.text}</pre>
                  </div>
                )}
                {!forceExpanded && open && (
                  <HistoryChipPopover
                    anchor={revealAnchorsRef.current.get(partKey) || null}
                    onClose={closePopover}
                  >
                    <div
                      className="cb-paste-chip-body"
                      style={{
                        width: '100%',
                        margin: 0,
                        maxHeight: 'min(360px, calc(100vh - 32px))',
                      }}
                    >
                      <div style={{ marginBottom: 5, color: '#777', fontSize: '0.82em' }}>
                        {chip.text.length.toLocaleString()} символов
                      </div>
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{chip.text}</pre>
                    </div>
                  </HistoryChipPopover>
                )}
              </div>
            );
          })}
        </div>
      )}
      {parts.map((part: { kind: 'text' | 'paste'; text: string }, index: number) => {
        if (part.kind === 'text') {
          const content = part.text.trim();
          return content
            ? <HistoryCollapsiblePrompt key={'text:' + index} text={content} forceExpanded={forceExpanded} />
            : null;
        }
        const partKey = `paste:${index}`;
        const open = forceExpanded || expandedPart === partKey;
        const preview = part.text.slice(0, 60).replace(/\s+/g, ' ')
          + (part.text.length > 60 ? '…' : '');
        return (
          <div key={partKey}>
            <button
              ref={(node) => setRevealAnchor(partKey, node)}
              type="button"
              className="cb-paste-chip"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                togglePopoverPart(partKey, open);
              }}
            >
              <span className="cb-paste-chip-preview">{preview}</span>
              <span className="cb-paste-chip-len">{part.text.length.toLocaleString()}</span>
            </button>
            {forceExpanded && <pre className="cb-paste-chip-body">{part.text}</pre>}
            {!forceExpanded && open && (
              <HistoryChipPopover
                anchor={revealAnchorsRef.current.get(partKey) || null}
                onClose={closePopover}
              >
                <pre
                  className="cb-paste-chip-body"
                  style={{
                    width: '100%',
                    margin: 0,
                    maxHeight: 'min(360px, calc(100vh - 32px))',
                  }}
                >
                  {part.text}
                </pre>
              </HistoryChipPopover>
            )}
          </div>
        );
      })}
    </div>
  );
};

const HistoryUserEntry = memo(({
  entry,
  tabId,
  allowRewind,
  rewindLocked,
  forceExpanded,
}: {
  entry: FullHistoryEntry;
  tabId: string;
  allowRewind: boolean;
  rewindLocked: boolean;
  forceExpanded?: boolean;
}) => {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editableLastPrompt = entry.deliveryStatus === 'editable-last-prompt';
  const canRewind = allowRewind && !rewindLocked;
  const queueStatus = entry.queueStatus;
  const queueStatusPresentation = queueStatus === 'sending'
    ? {
        label: 'SENDING',
        tone: 'info' as const,
        pending: true,
        title: 'Сообщение отправляется',
      }
    : queueStatus === 'queued'
      ? {
          label: 'QUEUED',
          tone: 'accent' as const,
          pending: true,
          title: 'Сообщение ждёт завершения текущего ответа',
        }
      : queueStatus === 'sent'
        ? {
            label: 'SENT',
            tone: 'success' as const,
            pending: false,
            title: 'Сообщение передано агенту и ожидает появления в сохранённой истории',
          }
        : queueStatus === 'cancelled'
          ? {
              label: 'CANCELLED',
              tone: 'warning' as const,
              pending: false,
              title: 'Отправка отменена до появления сообщения в сохранённой истории',
            }
          : queueStatus === 'failed'
            ? {
                label: 'SEND FAILED',
                tone: 'danger' as const,
                pending: false,
                title: 'Сообщение не удалось отправить',
              }
            : null;

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const stopActionPropagation = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  const copyPrompt = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    clipboard.writeText(entry.content);
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = null;
      setCopied(false);
    }, 900);
    historyDiag('PROMPT_ACTION tab=' + tabId.slice(-12) +
      ' action=copy' +
      ' entry=' + entry.uuid.slice(0, 8) +
      ' chars=' + entry.content.length);
    useUIStore.getState().showToast('Prompt скопирован', 'success', 1200);
  };

  const requestRewind = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canRewind) return;
    historyDiag('PROMPT_ACTION tab=' + tabId.slice(-12) +
      ' action=rewind-request' +
      ' entry=' + entry.uuid.slice(0, 8));
    window.dispatchEvent(new CustomEvent('history-panel:request-rewind', {
      detail: { tabId, uuid: entry.uuid, mode: 'native' },
    }));
  };

  return (
    <ConversationMessage
      layout="user"
      entryUuid={entry.uuid}
      emphasis={editableLastPrompt ? 'editable' : 'none'}
      title={editableLastPrompt ? 'Editable last prompt' : undefined}
      status={queueStatusPresentation ? (
        <MessageStatusBadge
          label={queueStatusPresentation.label}
          tone={queueStatusPresentation.tone}
          pending={queueStatusPresentation.pending}
          title={queueStatusPresentation.title}
          meta={entry.timestamp
            ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : undefined}
        />
      ) : undefined}
      actions={(
        <MessageActionRail placement="outside-start" aria-label="Prompt actions">
          <Tooltip content={copied ? 'Скопировано' : 'Копировать prompt'}>
            <MessageActionButton
              aria-label="Copy prompt"
              onMouseDown={stopActionPropagation}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={copyPrompt}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
            </MessageActionButton>
          </Tooltip>
          {allowRewind && (
            <Tooltip content={rewindLocked ? 'Rewind уже выполняется' : 'Откатиться к этому prompt'}>
              <MessageActionButton
                tone="warning"
                aria-label="Rewind to prompt"
                disabled={!canRewind}
                onMouseDown={stopActionPropagation}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={requestRewind}
              >
                <RotateCcw size={11} />
              </MessageActionButton>
            </Tooltip>
          )}
        </MessageActionRail>
      )}
    >
      <HistoryUserPromptContent
        text={entry.content}
        promptChips={entry.promptChips}
        forceExpanded={forceExpanded}
      />
    </ConversationMessage>
  );
});

const HistoryAssistantEntry = memo(({ entry }: { entry: FullHistoryEntry }) => {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveBackgroundUuids = React.useContext(HistoryBackgroundLiveContext);
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const hasAssistantContent = !!entry.content;
  const hasAssistantActions = !!entry.actions?.length;
  const isStandaloneToolRow = !hasAssistantContent && !entry.thinking && hasAssistantActions;
  const copyAnswer = () => {
    if (!entry.content) return;
    clipboard.writeText(entry.content);
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = null;
      setCopied(false);
    }, 900);
  };

  return (
    <ConversationMessage
      layout={isStandaloneToolRow ? 'block' : 'assistant'}
      entryUuid={entry.uuid}
      actions={hasAssistantContent ? (
        <MessageActionRail placement="sticky-end" aria-label="Assistant response actions">
          <Tooltip content={copied ? 'Скопировано' : 'Копировать ответ'}>
            <MessageActionButton aria-label="Copy assistant response" onClick={copyAnswer}>
              {copied ? <Check size={11} /> : <Copy size={11} />}
            </MessageActionButton>
          </Tooltip>
        </MessageActionRail>
      ) : undefined}
      className={isStandaloneToolRow ? 'hp-assistant-tool-only' : undefined}
    >
      {entry.thinking && <HistoryThinkBlock text={entry.thinking} payloadRef={entry.thinkingRef} />}

      {entry.content && (
        <div style={{ fontSize: '1em' }}>
          <CBMarkdown text={entry.content} />
        </div>
      )}

      {entry.actions?.map((action, index) => {
        if (isRawAction(action)) {
          const toolName = String(action.rawTool.toolName || '');
          const toolResult = action.rawTool.result;
          const historyResult = toolResult == null && toolName.toLowerCase().includes('mcp')
            ? ''
            : toolResult;
          const backgroundRunning = action.rawTool.backgroundStatus === 'running'
            && liveBackgroundUuids.has(entry.uuid);
          return (
            <div key={'raw' + index + ':' + toolName}>
              <HistoryToolCallPart
                toolName={toolName}
                args={action.rawTool.args || {}}
                result={historyResult}
                resultRef={action.rawTool.resultRef}
                isError={action.rawTool.isError}
                diffHunks={action.rawTool.diffHunks}
              />
              {backgroundRunning && (
                // The card holds only the acceptance text; the live face of
                // this process is the chip in the background strip below.
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  marginTop: 2, padding: '1px 6px', borderRadius: 4,
                  background: 'rgba(217, 119, 6, 0.08)',
                  color: '#d97706', fontSize: '0.75em', letterSpacing: 0.4,
                }}>
                  <HistoryBackgroundDot />
                  РАБОТАЕТ В ФОНЕ
                </div>
              )}
            </div>
          );
        }
        if (isTaskAction(action)) return <SubAgentBlock key={'task' + index} action={action} />;
        if (isFileAction(action)) {
          return action.tool === 'Read'
            ? <ReadActionBlock key={'rd' + index} filePath={action.filePath} />
            : <FileActionBlock key={'ew' + index} action={action} />;
        }
        return (
          <div key={'s' + index} style={{ marginTop: 6 }}>
            <span style={{
              fontSize: '0.85em',
              color: '#999',
              backgroundColor: 'rgba(255,255,255,0.04)',
              padding: '2px 6px',
              borderRadius: 4,
              wordBreak: 'break-all',
            }}>
              {action as string}
            </span>
          </div>
        );
      })}

      {entry.responseTiming && (
        <div
          data-history-response-duration
          title="Время работы приложения от начала ответа до завершения loader"
          style={{
            marginTop: 6,
            color: '#71717a',
            fontSize: '0.72em',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.015em',
          }}
        >
          Время работы: {formatHistoryResponseDuration(entry.responseTiming.durationMs)}
        </div>
      )}
    </ConversationMessage>
  );
});

// Single history entry renderer
const HistoryEntry = memo(({
  entry,
  tabId,
  toolType,
  allowRewind,
  rewindLocked,
  forceExpanded,
}: {
  entry: FullHistoryEntry;
  tabId: string;
  toolType?: 'claude' | 'gemini' | 'codex';
  allowRewind: boolean;
  rewindLocked: boolean;
  forceExpanded?: boolean;
}) => {
  if (entry.role === 'compact') {
    return <CompactBlock entry={entry} />;
  }

  if (entry.role === 'fork') {
    return <MessageEvent label="FORK" tone="info" entryUuid={entry.uuid} />;
  }

  if (entry.role === 'plan-mode') {
    return <MessageEvent label="CLEAR CONTEXT" tone="success" entryUuid={entry.uuid} />;
  }

  if (entry.role === 'continued') {
    return (
      <MessageEvent
        label="CONTINUED"
        tone="info"
        entryUuid={entry.uuid}
      >
        Session continued from previous conversation…
      </MessageEvent>
    );
  }

  if (entry.role === 'queued') {
    return (
      <HistoryUserEntry
        entry={entry}
        tabId={tabId}
        allowRewind={false}
        rewindLocked={rewindLocked}
        forceExpanded={forceExpanded}
      />
    );
  }

  if (entry.role === 'rewind') {
    const status = entry.rewindStatus || 'rewinding';
    const active = status === 'rewinding';
    const failed = status === 'failed';
    const label = failed ? 'REWIND FAILED' : active ? 'REWINDING' : 'I REWOUND';
    return (
      <MessageEvent
        label={label}
        tone={failed ? 'danger' : 'warning'}
        pending={active}
        entryUuid={entry.uuid}
        meta={entry.timestamp
          ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : undefined}
      >
        {renderSentHistoryPromptHighlight(entry.content)}
      </MessageEvent>
    );
  }

  if (entry.role === 'user') {
    return (
      <HistoryUserEntry
        entry={entry}
        tabId={tabId}
        allowRewind={allowRewind}
        rewindLocked={rewindLocked}
        forceExpanded={forceExpanded}
      />
    );
  }

  return <HistoryAssistantEntry entry={entry} />;
});

// Flash/search/component styles. Keep the existing node across HMR, but refresh
// its contents: an "inject once" guard leaves stale CSS in a live dev renderer.
const historyPanelStyleText = `@keyframes hp-flash {
  0%   { background-color: transparent; }
  20%  { background-color: rgba(91, 156, 245, 0.2); }
  100% { background-color: transparent; }
}
@keyframes hp-terminal-perimeter {
  from { stroke-dashoffset: 0; }
  to { stroke-dashoffset: -100; }
}
/* Owner handoff loader. Two opposed arrows used to live here, but that shape
   now means "swap the primary surface" on its own button right next to this
   slot — a spinning ring keeps the transient loading state unambiguous. */
@keyframes hp-owner-transition-spin {
  to { transform: rotate(360deg); }
}
.hp-owner-transition-spin {
  transform-origin: 50% 50%;
  animation: hp-owner-transition-spin 0.85s linear infinite;
}
.hp-terminal-perimeter-loader {
  animation: hp-terminal-perimeter 0.9s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .hp-terminal-perimeter-loader {
    animation: none;
    stroke-dasharray: 100 0;
    stroke-dashoffset: 0;
  }
  .hp-owner-transition-spin {
    animation: none;
  }
}
::highlight(hp-search) {
  background-color: rgba(234, 179, 8, 0.35);
  color: inherit;
}
::highlight(hp-search-current) {
  background-color: rgba(234, 179, 8, 0.8);
  color: #000;
}
.hp-agent-prompt::placeholder {
  color: #666;
  opacity: 1;
}
.hp-agent-prompt[data-status="inactive"]::placeholder,
.hp-agent-prompt[data-status="starting"]::placeholder {
  color: #555;
}
.hp-agent-prompt {
  scrollbar-width: thin;
  scrollbar-color: #454545 transparent;
}
.hp-agent-prompt::-webkit-scrollbar {
  width: 5px;
}
.hp-agent-prompt::-webkit-scrollbar-track {
  background: transparent;
}
.hp-agent-prompt::-webkit-scrollbar-thumb {
  background: #454545;
  border-radius: 999px;
}
.hp-agent-prompt::-webkit-scrollbar-thumb:hover {
  background: #5a5a5a;
}
.hp-agent-prompt-highlight {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
.hp-agent-prompt-highlight::-webkit-scrollbar {
  width: 5px;
}
.hp-agent-prompt-highlight::-webkit-scrollbar-track,
.hp-agent-prompt-highlight::-webkit-scrollbar-thumb {
  background: transparent;
}
.hp-history-transcript .cb-tool {
  margin-top: 4px;
  margin-bottom: 4px;
}
.hp-history-transcript .hp-assistant-tool-only {
  padding-top: 0;
  padding-bottom: 0;
}
.hp-history-transcript .hp-tool-scroll-scope .cb-tool-body > .cb-rail {
  transition: border-left-color 90ms ease, filter 90ms ease;
}
.hp-history-transcript .hp-tool-scroll-scope .cb-tool-body[data-hp-scroll-focus="true"] > .cb-rail {
  border-left-color: rgba(255, 255, 255, 0.88);
  filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.22));
}
.hp-history-composer-frame {
  border-color: #333;
  background: #0f0f0f;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.38);
  transition: border-color 120ms ease;
}
.hp-history-composer-frame:focus-within {
  border-color: #FFB382;
}
.hp-history-composer-frame .cb-composer-main {
  padding-top: 0;
}
.hp-history-composer-frame .cb-composer-chips {
  padding: 0 0 6px;
}
.hp-history-composer-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.hp-composer-chip-action {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: currentColor;
  opacity: 0.65;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.hp-composer-chip-action:hover,
.hp-composer-chip-action:focus-visible {
  opacity: 1;
  color: #fff;
  background: rgba(255, 255, 255, 0.09);
  outline: none;
}
.hp-composer-chip-action-danger:hover,
.hp-composer-chip-action-danger:focus-visible {
  color: #f87171;
}
.hp-composer-chip-preview {
  flex: 1 0 100%;
  min-width: 0;
  max-height: 210px;
  overflow: auto;
  border: 1px solid #333;
  border-radius: 8px;
  background: #151515;
}
.hp-composer-chip-preview-head {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  color: #888;
  background: #1a1a1a;
  border-bottom: 1px solid #2d2d2d;
  font-size: 10px;
}
.hp-composer-chip-preview pre {
  margin: 0;
  padding: 8px;
  color: #bdbdbd;
  font: inherit;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}`;
let historyPanelStyle = document.getElementById('hp-flash-style') as HTMLStyleElement | null;
if (!historyPanelStyle) {
  historyPanelStyle = document.createElement('style');
  historyPanelStyle.id = 'hp-flash-style';
}
if (historyPanelStyle.textContent !== historyPanelStyleText) {
  historyPanelStyle.textContent = historyPanelStyleText;
}
if (!historyPanelStyle.isConnected) {
  const style = historyPanelStyle;
  document.head.appendChild(style);
}

const AGENT_STATUS_META: Record<AgentPtyStatus, { label: string; color: string }> = {
  active: { label: 'READY', color: '#4ade80' },
  busy: { label: 'BUSY', color: '#d97706' },
  inactive: { label: 'STOPPED', color: '#777' },
  starting: { label: 'STARTING', color: '#60a5fa' },
  stopping: { label: 'STOPPING', color: '#f59e0b' },
  unknown: { label: 'CHECKING', color: '#8b8b91' },
};

const historyControlButtonBase: React.CSSProperties = {
  height: 26,
  borderRadius: 5,
  border: '1px solid #343434',
  backgroundColor: '#242424',
  color: '#cfcfcf',
  padding: '0 8px',
  fontSize: 11,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
};

const QUESTION_PURPLE = '#a78bfa';
const QUESTION_PURPLE_BG = 'rgba(147, 51, 234, 0.18)';
const QUESTION_PURPLE_BORDER = 'rgba(168, 85, 247, 0.9)';

const DRAFT_GRAB_ERROR_MESSAGES: Record<string, string> = {
  no_terminal: 'No terminal for this tab',
  no_claude_session: 'No Claude session running in this tab',
  no_claude_pid: 'No Claude process found in this tab',
  claude_busy: 'Claude is busy - wait for the response to finish',
  already_in_progress: 'Draft grab already in progress',
  wrong_editor: 'Restart Claude in this tab - editor helper is not wired',
  stale_pid: 'Claude was restarted in shell - close and reopen this tab',
  editor_not_wired: 'Helper never reported back',
  tab_cleared: 'Tab was closed before grab finished',
  timeout: 'Draft grab timed out',
};

const draftGrabErrorText = (result: AgentDraftGrabResult | null | undefined) => {
  const code = result?.error || 'unknown';
  return DRAFT_GRAB_ERROR_MESSAGES[code] || ('Draft grab failed: ' + code);
};

const prependPromptText = (base: string, addition: string) => {
  const left = addition.trim();
  const right = base.trimStart();
  if (!left) return right;
  if (!right) return left;
  return left + '\n\n' + right;
};

const prependPromptTextOnce = (base: string, addition: string) => {
  const left = addition.trim();
  const right = base.trim();
  if (!left) return base;
  if (
    right === left ||
    right.startsWith(left + '\n\n') ||
    right.endsWith('\n\n' + left) ||
    right.includes('\n\n' + left + '\n\n')
  ) {
    return base;
  }
  return prependPromptText(base, left);
};

function HistorySpinner({ size = 14, flexShrink = 0 }: { size?: number; flexShrink?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{
        animation: 'spinner-rotate 0.85s linear infinite',
        transformOrigin: '50% 50%',
        willChange: 'transform',
        flexShrink,
        display: 'block',
      }}
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
    </svg>
  );
}

// One affordance for "the other surface". The frame and the busy perimeter are
// identical in both layouts — only the glyph inside says WHICH surface the click
// reveals: a shell prompt for the terminal, transcript lines for History. Same
// place, same size, same loader, so the control stays recognisable after a swap.
function HistoryTerminalActivityIcon({
  size = 19,
  busy = false,
  active = false,
  color,
  surface = 'terminal',
}: {
  size?: number;
  busy?: boolean;
  active?: boolean;
  color?: string;
  surface?: 'terminal' | 'history';
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-terminal-perimeter-loader={busy ? 'true' : undefined}
      style={{
        display: 'block',
        flexShrink: 0,
        color,
        filter: active
          ? 'drop-shadow(0 0 3px rgba(245, 245, 245, 0.45))'
          : undefined,
      }}
    >
      <rect x="1" y="2" width="18" height="16" rx="2" opacity={busy ? 0.32 : 1} />
      {surface === 'history' ? (
        <>
          <path d="M5 6.5h10" />
          <path d="M5 10h10" />
          <path d="M5 13.5h6" />
        </>
      ) : (
        <>
          <path d="m5 7 2.5 2L5 11" />
          <path d="M10 12h5" />
        </>
      )}
      {busy && (
        <rect
          className="hp-terminal-perimeter-loader"
          x="1"
          y="2"
          width="18"
          height="16"
          rx="2"
          pathLength="100"
          strokeDasharray="24 76"
          strokeWidth="2.2"
        />
      )}
    </svg>
  );
}

function HistoryOwnerTransitionIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-history-owner-transition="true"
      style={{ display: 'block', flexShrink: 0, color: '#818cf8' }}
    >
      <circle cx="10" cy="10" r="6.5" opacity={0.25} />
      <path className="hp-owner-transition-spin" d="M16.5 10a6.5 6.5 0 0 0-6.5-6.5" />
    </svg>
  );
}

const getDraftNoticeMeta = (message: string) => {
  if (/terminal input is empty/i.test(message)) {
    return {
      label: 'Terminal input empty',
      tone: 'info' as const,
    };
  }
  if (/prompt was not returned/i.test(message)) {
    return {
      label: 'Cancel confirmed',
      tone: 'info' as const,
    };
  }
  if (/interrupted prompt/i.test(message)) {
    return {
      label: 'Prompt restored',
      tone: 'warning' as const,
    };
  }
  if (/saving image attachment/i.test(message)) {
    return {
      label: 'Attaching image',
      tone: 'info' as const,
    };
  }
  if (/image placeholder|imageError|image attachment|image marker|image file|картинк|вложени/i.test(message)) {
    return {
      label: 'Image needs attention',
      tone: 'warning' as const,
    };
  }
  return {
    label: 'Send stopped · draft moved',
    tone: 'warning' as const,
  };
};

const QUESTION_NAV_KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  enter: '\r',
  space: ' ',
} as const;

type QuestionTerminalCursor = {
  questionIndex: number;
  optionIndex: number;
  submit: boolean;
};

const sleepQuestionNav = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ClaudeHistoryQuestionCard({
  tabId,
  pending,
  answering,
  error,
  onAnswer,
  onStop,
}: {
  tabId: string;
  pending: AgentPendingQuestion;
  answering: boolean;
  error: string | null;
  onAnswer: (answers: Record<string, string>) => void;
  onStop: () => void;
}) {
  const questions = pending.questions || [];
  const terminalDriven = pending.source === 'pty';
  const multiQuestion = questions.length > 1;
  const [selection, setSelection] = useState<Record<number, string[]>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [optionIndex, setOptionIndex] = useState(0);
  const [terminalSubmitReady, setTerminalSubmitReady] = useState(false);
  const [terminalBusyTarget, setTerminalBusyTarget] = useState<string | null>(null);
  const [choiceControlHover, setChoiceControlHover] = useState<string | null>(null);
  const terminalBusyRef = useRef(false);
  const terminalBusyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalCursorRef = useRef<QuestionTerminalCursor>({ questionIndex: 0, optionIndex: 0, submit: false });
  const questionSignature = useMemo(
    () => questions.map((q) => q?.question || '').join('||'),
    [questions],
  );

  useEffect(() => {
    setSelection({});
    setQuestionIndex(0);
    setOptionIndex(0);
    setTerminalSubmitReady(false);
    setTerminalBusyTarget(null);
    setChoiceControlHover(null);
    terminalBusyRef.current = false;
    terminalCursorRef.current = { questionIndex: 0, optionIndex: 0, submit: false };
    if (terminalBusyTimerRef.current) {
      clearTimeout(terminalBusyTimerRef.current);
      terminalBusyTimerRef.current = null;
    }
  }, [pending.source, pending.toolUseID, questionSignature]);

  useEffect(() => {
    return () => {
      if (terminalBusyTimerRef.current) clearTimeout(terminalBusyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (questionIndex >= questions.length && questions.length > 0) setQuestionIndex(questions.length - 1);
  }, [questionIndex, questions.length]);

  const currentQuestion: AgentQuestion | null = questions.length > 0
    ? questions[Math.min(questionIndex, questions.length - 1)]
    : null;
  const currentOptions = currentQuestion?.options || [];
  const currentSelection = selection[questionIndex] || [];
  const isMultiSelect = !!currentQuestion?.multiSelect;

  const buildAnswers = useCallback((snapshot: Record<number, string[]>) => {
    const out: Record<string, string> = {};
    questions.forEach((q, i) => {
      const selected = snapshot[i];
      if (q?.question && selected && selected.length) out[q.question] = selected.join(', ');
    });
    return out;
  }, [questions]);

  const allAnswered = questions.length > 0 && questions.every((_q, i) => (selection[i]?.length || 0) > 0);
  const controlsBusy = answering || !!terminalBusyTarget;

  const writeTerminalKey = useCallback(async (seq: string, gap = 72) => {
    ipcRenderer.send('terminal:input', tabId, seq);
    await sleepQuestionNav(gap);
  }, [tabId]);

  const clearTerminalBusyLater = useCallback((target: string, delayMs = 140) => {
    if (terminalBusyTimerRef.current) clearTimeout(terminalBusyTimerRef.current);
    terminalBusyTimerRef.current = setTimeout(() => {
      terminalBusyTimerRef.current = null;
      terminalBusyRef.current = false;
      setTerminalBusyTarget((current) => current === target ? null : current);
    }, delayMs);
  }, []);

  const runTerminalQuestionAction = useCallback(async (
    target: string,
    action: () => Promise<void>,
    settleMs = 140,
  ) => {
    if (!terminalDriven || terminalBusyRef.current || answering) return;
    terminalBusyRef.current = true;
    if (terminalBusyTimerRef.current) {
      clearTimeout(terminalBusyTimerRef.current);
      terminalBusyTimerRef.current = null;
    }
    setTerminalBusyTarget(target);
    try {
      await action();
    } catch (e: any) {
      console.warn('[ClaudeHistoryQuestion] terminal-nav failed tab=' + tabId.slice(-12) + ': ' + String(e?.message || e));
    } finally {
      clearTerminalBusyLater(target, settleMs);
    }
  }, [answering, clearTerminalBusyLater, tabId, terminalDriven]);

  const navigateTerminalTo = useCallback(async (
    targetQuestionIndex: number,
    targetOptionIndex = 0,
    targetSubmit = false,
  ) => {
    const lastQuestionIndex = Math.max(0, questions.length - 1);
    const clampedQuestion = Math.max(0, Math.min(targetQuestionIndex, lastQuestionIndex));
    const clampedOption = Math.max(0, targetOptionIndex);
    const current = terminalCursorRef.current;
    const currentTab = current.submit ? questions.length : current.questionIndex;
    const targetTab = targetSubmit ? questions.length : clampedQuestion;
    const tabDelta = targetTab - currentTab;

    for (let i = 0; i < Math.abs(tabDelta); i++) {
      await writeTerminalKey(tabDelta > 0 ? QUESTION_NAV_KEY.right : QUESTION_NAV_KEY.left, 82);
    }

    if (targetSubmit) {
      terminalCursorRef.current = { questionIndex: lastQuestionIndex, optionIndex: 0, submit: true };
      return;
    }

    const optionBase = tabDelta === 0 && !current.submit ? current.optionIndex : 0;
    const optionDelta = clampedOption - optionBase;
    for (let i = 0; i < Math.abs(optionDelta); i++) {
      await writeTerminalKey(optionDelta > 0 ? QUESTION_NAV_KEY.down : QUESTION_NAV_KEY.up, 72);
    }
    terminalCursorRef.current = { questionIndex: clampedQuestion, optionIndex: clampedOption, submit: false };
  }, [questions.length, writeTerminalKey]);

  const focusQuestion = useCallback((index: number) => {
    const nextIndex = Math.max(0, Math.min(index, Math.max(0, questions.length - 1)));
    if (!terminalDriven) {
      setQuestionIndex(nextIndex);
      setOptionIndex(0);
      return;
    }
    runTerminalQuestionAction('question:' + nextIndex, async () => {
      await navigateTerminalTo(nextIndex, 0, false);
      setQuestionIndex(nextIndex);
      setOptionIndex(0);
      setTerminalSubmitReady(false);
    });
  }, [navigateTerminalTo, questions.length, runTerminalQuestionAction, terminalDriven]);

  const focusOption = useCallback((index: number) => {
    if (controlsBusy || !currentQuestion) return;
    const maxIndex = Math.max(0, (currentQuestion.options || []).length - 1);
    const nextIndex = Math.max(0, Math.min(index, maxIndex));
    if (!terminalDriven) {
      setOptionIndex(nextIndex);
      return;
    }
    const target = 'option-focus:' + questionIndex + ':' + nextIndex;
    runTerminalQuestionAction(target, async () => {
      await navigateTerminalTo(questionIndex, nextIndex, false);
      setOptionIndex(nextIndex);
      setTerminalSubmitReady(false);
    }, 110);
  }, [controlsBusy, currentQuestion, navigateTerminalTo, questionIndex, runTerminalQuestionAction, terminalDriven]);

  const commitOption = useCallback((label: string, index: number) => {
    if (controlsBusy || !currentQuestion) return;
    setOptionIndex(index);
    if (terminalDriven) {
      const target = 'option:' + questionIndex + ':' + index;
      runTerminalQuestionAction(target, async () => {
        await navigateTerminalTo(questionIndex, index, false);
        setOptionIndex(index);
        if (isMultiSelect) {
          await writeTerminalKey(QUESTION_NAV_KEY.space, 90);
          setSelection((prev) => {
            const current = prev[questionIndex] || [];
            const next = current.includes(label)
              ? current.filter((item) => item !== label)
              : [...current, label];
            return { ...prev, [questionIndex]: next };
          });
          setTerminalSubmitReady(false);
          return;
        }

        const nextSelection = { ...selection, [questionIndex]: [label] };
        setSelection(nextSelection);
        await writeTerminalKey(QUESTION_NAV_KEY.enter, 115);

        if (multiQuestion) {
          if (questionIndex < questions.length - 1) {
            const nextQuestionIndex = questionIndex + 1;
            terminalCursorRef.current = { questionIndex: nextQuestionIndex, optionIndex: 0, submit: false };
            setQuestionIndex(nextQuestionIndex);
            setOptionIndex(0);
            setTerminalSubmitReady(false);
          } else {
            terminalCursorRef.current = { questionIndex, optionIndex: index, submit: true };
            setTerminalSubmitReady(true);
          }
        }
      }, multiQuestion || isMultiSelect ? 150 : 850);
      return;
    }

    if (isMultiSelect) {
      setSelection((prev) => {
        const current = prev[questionIndex] || [];
        const next = current.includes(label)
          ? current.filter((item) => item !== label)
          : [...current, label];
        return { ...prev, [questionIndex]: next };
      });
      return;
    }

    const nextSelection = { ...selection, [questionIndex]: [label] };
    setSelection(nextSelection);
    if (!multiQuestion) {
      onAnswer(buildAnswers(nextSelection));
    } else if (questionIndex < questions.length - 1) {
      setQuestionIndex(questionIndex + 1);
      setOptionIndex(0);
    }
  }, [
    buildAnswers,
    controlsBusy,
    currentQuestion,
    isMultiSelect,
    multiQuestion,
    navigateTerminalTo,
    onAnswer,
    questionIndex,
    questions.length,
    runTerminalQuestionAction,
    selection,
    terminalDriven,
    writeTerminalKey,
  ]);

  const submit = useCallback(() => {
    if (controlsBusy || !allAnswered) return;
    if (terminalDriven) {
      runTerminalQuestionAction('submit', async () => {
        await navigateTerminalTo(Math.max(0, questions.length - 1), 0, true);
        await writeTerminalKey(QUESTION_NAV_KEY.enter, 110);
        setTerminalSubmitReady(false);
      }, 850);
      return;
    }
    onAnswer(buildAnswers(selection));
  }, [
    allAnswered,
    buildAnswers,
    controlsBusy,
    navigateTerminalTo,
    onAnswer,
    questions.length,
    runTerminalQuestionAction,
    selection,
    terminalDriven,
    writeTerminalKey,
  ]);

  const headerLabel = questions.length > 0
    ? (terminalSubmitReady ? 'SUBMIT' : 'QUESTION' + (multiQuestion ? ' ' + (questionIndex + 1) + '/' + questions.length : ''))
    : 'QUESTION';

  return (
    <div
      style={{
        border: '1px solid rgba(168, 85, 247, 0.32)',
        backgroundColor: '#101010',
        borderRadius: 6,
        padding: 10,
        animation: 'noted-fade-in 0.16s ease-out',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, minWidth: 0 }}>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.4,
          color: QUESTION_PURPLE,
          padding: '2px 7px',
          borderRadius: 999,
          backgroundColor: QUESTION_PURPLE_BG,
          border: '1px solid ' + QUESTION_PURPLE_BORDER,
          flexShrink: 0,
        }}>
          {headerLabel}
        </span>
        {currentQuestion?.header && (
          <span style={{ color: '#999', fontSize: 11, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentQuestion.header}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {(answering || terminalBusyTarget) && (
          <span style={{ color: QUESTION_PURPLE, flexShrink: 0 }}>
            <HistorySpinner size={13} />
          </span>
        )}
      </div>

      {multiQuestion && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
          {questions.map((q, i) => {
            const answered = (selection[i]?.length || 0) > 0;
            const active = i === questionIndex;
            const chipBusy = terminalBusyTarget === 'question:' + i;
            return (
              <button
                key={i}
                type="button"
                onClick={() => focusQuestion(i)}
                disabled={controlsBusy}
                style={{
                  borderRadius: 5,
                  border: '1px solid ' + (active ? QUESTION_PURPLE_BORDER : 'transparent'),
                  backgroundColor: active ? QUESTION_PURPLE_BG : 'transparent',
                  color: active ? '#f3e8ff' : '#8f8f96',
                  padding: '3px 7px',
                  fontSize: 10,
                  cursor: controlsBusy ? 'default' : 'pointer',
                  maxWidth: 120,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                title={q.question}
              >
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    height: 12,
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {chipBusy ? (
                    <HistorySpinner size={10} />
                  ) : answered ? (
                    <span style={{
                      width: 9,
                      height: 9,
                      borderRadius: 999,
                      backgroundColor: QUESTION_PURPLE,
                      boxShadow: '0 0 0 2px rgba(168, 85, 247, 0.18)',
                    }} />
                  ) : null}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.header || 'Q' + (i + 1)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {currentQuestion ? (
        <>
          <div style={{ color: '#f4f4f5', fontSize: 13, fontWeight: 600, lineHeight: 1.35, marginBottom: 8, wordBreak: 'break-word' }}>
            {currentQuestion.question}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {currentOptions.map((option, index) => {
              const checked = currentSelection.includes(option.label);
              const focused = index === optionIndex && !terminalSubmitReady;
              const optionBusy = terminalBusyTarget === 'option:' + questionIndex + ':' + index;
              const optionFocusBusy = terminalBusyTarget === 'option-focus:' + questionIndex + ':' + index;
              const controlKey = questionIndex + ':' + index;
              const controlHover = choiceControlHover === controlKey;
              return (
                <div
                  key={option.label + ':' + index}
                  role="button"
                  tabIndex={0}
                  onClick={() => focusOption(index)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    focusOption(index);
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    borderRadius: 5,
                    border: '1px solid ' + (focused ? QUESTION_PURPLE_BORDER : '#303030'),
                    backgroundColor: focused ? 'rgba(168, 85, 247, 0.16)' : '#181818',
                    color: '#e5e5e5',
                    cursor: controlsBusy ? 'default' : 'pointer',
                    padding: '8px 9px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <button
                      type="button"
                      aria-label={(checked ? 'Deselect ' : 'Select ') + option.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        commitOption(option.label, index);
                      }}
                      onMouseEnter={() => setChoiceControlHover(controlKey)}
                      onMouseLeave={() => setChoiceControlHover((current) => current === controlKey ? null : current)}
                      disabled={controlsBusy}
                      style={{
                        width: 24,
                        height: 24,
                        margin: '-5px -2px -5px -3px',
                        padding: 0,
                        border: '1px solid ' + (controlHover && !controlsBusy ? QUESTION_PURPLE_BORDER : 'transparent'),
                        borderRadius: isMultiSelect ? 6 : 999,
                        backgroundColor: controlHover && !controlsBusy ? 'rgba(168, 85, 247, 0.14)' : 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: QUESTION_PURPLE,
                        cursor: controlsBusy ? 'default' : 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      <span style={{
                        width: 10,
                        height: 10,
                        borderRadius: isMultiSelect ? 2 : 999,
                        border: '1px solid ' + (checked ? QUESTION_PURPLE : '#666'),
                        backgroundColor: checked ? QUESTION_PURPLE : 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                        {optionBusy && <HistorySpinner size={10} />}
                      </span>
                    </button>
                    <span style={{
                      width: 12,
                      height: 12,
                      flexShrink: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: QUESTION_PURPLE,
                      marginLeft: -6,
                    }}>
                      {optionFocusBusy && <HistorySpinner size={10} />}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: checked ? 600 : 500, overflowWrap: 'anywhere', minWidth: 0 }}>
                      {option.label}
                    </span>
                  </span>
                  {option.description && (
                    <span style={{ color: '#999', fontSize: 11, lineHeight: 1.35, paddingLeft: 18 }}>
                      {option.description}
                    </span>
                  )}
                  {option.preview && (
                    <pre style={{
                      margin: '3px 0 0 18px',
                      padding: '6px 8px',
                      borderRadius: 4,
                      backgroundColor: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: '#bbb',
                      fontSize: 11,
                      lineHeight: 1.35,
                      maxHeight: 120,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {option.preview}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div style={{ color: '#bbb', fontSize: 12, lineHeight: 1.35 }}>
          Claude asked a question in the terminal. The structured payload is empty, so answer manually.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <button
          type="button"
          onClick={onStop}
          disabled={controlsBusy}
          style={{
            ...historyControlButtonBase,
            height: 28,
            cursor: controlsBusy ? 'default' : 'pointer',
            color: '#aaa',
          }}
        >
          Respond manually
        </button>
        <div style={{ flex: 1 }} />
        {(isMultiSelect || multiQuestion) && (
          <button
            type="button"
            onClick={submit}
            disabled={controlsBusy || !allAnswered}
            style={{
              ...historyControlButtonBase,
              height: 28,
              border: `1px solid ${allAnswered && !controlsBusy ? QUESTION_PURPLE_BORDER : '#343434'}`,
              backgroundColor: allAnswered && !controlsBusy ? QUESTION_PURPLE : '#242424',
              color: allAnswered && !controlsBusy ? '#121212' : '#666',
              cursor: allAnswered && !controlsBusy ? 'pointer' : 'default',
              fontWeight: 700,
              gap: 6,
            }}
          >
            {terminalBusyTarget === 'submit' && <HistorySpinner size={12} />}
            Submit{multiQuestion ? ' ' + Object.keys(selection).filter((key) => (selection[Number(key)]?.length || 0) > 0).length + '/' + questions.length : ''}
          </button>
        )}
      </div>
      {error && (
        <div style={{ marginTop: 7, color: '#fca5a5', fontSize: 11, wordBreak: 'break-word' }}>
          {error}
        </div>
      )}
    </div>
  );
}

function AgentHistoryControls({
  tabId,
  sessionId,
  cwd,
  projectId,
  toolType,
  onHistoryRefresh,
  onPromptSubmitted,
  onPromptStatusChange,
  hasDurablePrompt,
  rewindLocked,
  rewindPhase,
  rewindMessage,
  rewindPreviewActive,
  rewindPreviewHiddenCount,
  terminalOpen,
  onToggleTerminal,
  onSwapPrimarySurface,
  terminalIsPrimary = false,
  lifecycleStatus,
  operationalPhase,
  onHeightChange,
  overlayComposer = false,
  agentInputSurface: agentInputSurfaceProp,
}: {
  tabId: string;
  sessionId: string;
  cwd: string;
  projectId?: string;
  toolType: AgentHistoryTool;
  onHistoryRefresh: (reason?: string) => void | Promise<boolean | void>;
  onPromptSubmitted: (
    text: string,
    queueStatus: 'sending' | 'queued' | 'sent',
    meta: {
      handoffId: string;
      statusAtSend: AgentPtyStatus;
      submittedAt: number;
      promptChips?: HistoryPromptDraftChip[];
      requiresAuditIdentity?: boolean;
      auditTimestamp?: string;
      auditHash?: string;
      auditSessionId?: string;
      auditEntryUuid?: string;
      sourceIdentity?: string;
    }
  ) => void;
  onPromptStatusChange: (
    handoffId: string,
    queueStatus: 'queued' | 'sent' | 'cancelled' | 'failed',
    reason: string,
    identity?: {
      requiresAuditIdentity?: boolean;
      auditTimestamp?: string;
      auditHash?: string;
      auditSessionId?: string;
      auditEntryUuid?: string;
      sourceIdentity?: string;
    },
  ) => void;
  hasDurablePrompt: (text: string, submittedAt: number) => boolean;
  rewindLocked: boolean;
  rewindPhase?: RewindOperationPhase;
  rewindMessage?: string;
  rewindPreviewActive: boolean;
  rewindPreviewHiddenCount: number;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  onSwapPrimarySurface?: () => void;
  terminalIsPrimary?: boolean;
  lifecycleStatus?: AgentLifecycleSummary | null;
  operationalPhase?: CompactOperationalPhase | null;
  onHeightChange?: (height: number) => void;
  overlayComposer?: boolean;
  agentInputSurface?: boolean;
}) {
  // Owning the tab's input is not the same as being the centered surface: the
  // terminal-primary layout keeps this composer live in the side panel. Fall
  // back to the centered flag so preview/legacy hosts keep prior behavior.
  const agentInputSurface = agentInputSurfaceProp ?? overlayComposer;
  const runtime = useMemo(() => getHistoryAgentRuntime(toolType), [toolType]);
  const [status, setStatus] = useState<AgentPtyStatus>('inactive');
  const [processLifecycleGeneration, setProcessLifecycleGeneration] = useState<string | null>(null);
  const [presenceResolving, setPresenceResolving] = useState(true);
  const prompt = useUIStore(useCallback((s) => s.historyPromptDrafts[tabId] || '', [tabId]));
  const historyComposerFontSize = useUIStore((s) => s.historyComposerFontSize);
  const aiSecondaryFontSize = useUIStore((s) => s.aiSecondaryFontSize);
  const historyComposerMinRows = useUIStore((s) => s.historyComposerMinRows);
  const historyComposerMaxRows = useUIStore((s) => s.historyComposerMaxRows);
  const aiComposerChipThreshold = useUIStore((s) => s.aiComposerChipThreshold);
  const historyComposerLineHeightPx = historyComposerFontSize * 1.35;
  const historyComposerMinHeight = Math.ceil(historyComposerLineHeightPx * historyComposerMinRows + 16);
  const historyComposerMaxHeight = Math.ceil(historyComposerLineHeightPx * historyComposerMaxRows + 16);
  // Zustand/React store snapshots must be referentially stable. Returning `[]`
  // here when the tab has no images creates a new snapshot on every read and
  // can crash History with React #185 when AgentHistoryControls mounts.
  const draftImages = useUIStore(useCallback((s) => s.historyPromptDraftImages[tabId] || EMPTY_HISTORY_DRAFT_IMAGES, [tabId]));
  const draftChips = useUIStore(useCallback((s) => s.historyPromptDraftChips[tabId] || EMPTY_HISTORY_DRAFT_CHIPS, [tabId]));
  const setHistoryPromptDraft = useUIStore((s) => s.setHistoryPromptDraft);
  const setHistoryComposerAvailability = useUIStore((s) => s.setHistoryComposerAvailability);
  const setPromptQueueInputSurface = useUIStore((s) => s.setPromptQueueInputSurface);
  const removeHistoryPromptDraftChip = useUIStore((s) => s.removeHistoryPromptDraftChip);
  const setPrompt = useCallback((
    next: string | ((prev: string) => string),
    options: HistoryPromptDraftWriteOptions = { preserveImages: true, preserveChips: true }
  ) => {
    const current = useUIStore.getState().historyPromptDrafts[tabId] || '';
    const value = typeof next === 'function' ? next(current) : next;
    setHistoryPromptDraft(tabId, value, options);
  }, [setHistoryPromptDraft, tabId]);
  const [busyAction, setBusyAction] = useState<'resume' | 'send' | 'interrupt' | 'stop' | 'grab' | null>(null);
  const [isPasteBusy, setIsPasteBusy] = useState(false);
  const [historyUpdating, setHistoryUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftWarning, setDraftWarning] = useState<string | null>(null);
  const [interruptAwaiting, setInterruptAwaiting] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<AgentPendingQuestion | null>(null);
  const [answeringQuestion, setAnsweringQuestion] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [resumeMaterialized, setResumeMaterialized] = useState<boolean | null>(toolType === 'claude' ? null : true);
  const [resumeUnavailableReason, setResumeUnavailableReason] = useState<string | null>(null);
  const [statusCopied, setStatusCopied] = useState(false);
  const [previewChipId, setPreviewChipId] = useState<string | null>(null);
  const [activityTiming, setActivityTiming] = useState<HistoryActivityTiming | null>(null);
  const [pasteActivityStartedAt, setPasteActivityStartedAt] = useState<number | null>(null);
  const [activityClock, setActivityClock] = useState(() => Date.now());
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const statusCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptTextareaRef = useRef<ComposerEditorHandle | null>(null);
  const promptCaretRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const tabIdRef = useRef(tabId);
  const activityTimingOwnerKeyRef = useRef(tabId + ':' + toolType);
  const activityTimingRequestSeqRef = useRef(0);
  const statusRef = useRef<AgentPtyStatus>('inactive');
  const availabilityOwnerRef = useRef(
    'history-composer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
  );
  const syncPromptTextareaHeight = useCallback(() => {
    const element = promptTextareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const contentHeight = element.scrollHeight + 2;
    const nextHeight = Math.min(
      Math.max(contentHeight, historyComposerMinHeight),
      historyComposerMaxHeight,
    );
    element.style.height = nextHeight + 'px';
    element.style.overflowY = contentHeight > historyComposerMaxHeight ? 'auto' : 'hidden';
  }, [historyComposerMaxHeight, historyComposerMinHeight]);

  useLayoutEffect(() => {
    syncPromptTextareaHeight();
  }, [prompt, syncPromptTextareaHeight]);

  useEffect(() => {
    const element = promptTextareaRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let lastWidth = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (Math.abs(nextWidth - lastWidth) < 0.5) return;
      lastWidth = nextWidth;
      syncPromptTextareaHeight();
    });
    if (!element.dom) return;
    observer.observe(element.dom);
    return () => observer.disconnect();
  }, [syncPromptTextareaHeight]);

  useEffect(() => {
    const focusComposer = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId !== tabId) return;
      requestAnimationFrame(() => promptTextareaRef.current?.focus());
    };
    window.addEventListener('history-panel:focus-composer', focusComposer);
    return () => window.removeEventListener('history-panel:focus-composer', focusComposer);
  }, [tabId]);

  const actionInFlightRef = useRef(false);
  const actionSeqRef = useRef(0);
  const activeActionKindRef = useRef<'resume' | 'send' | 'interrupt' | 'stop' | null>(null);
  const historyUpdateSeqRef = useRef(0);
  const pasteBusyRef = useRef(false);
  const pendingQuestionRef = useRef<AgentPendingQuestion | null>(null);
  const answeringQuestionRef = useRef(false);
  const midstreamPromptRecoveryRef = useRef<{
    serializedText: string;
    transportText: string;
    rawText: string;
    chips: HistoryPromptDraftChip[];
    images: HistoryPromptDraftImageRef[];
    at: number;
    submittedAt: number;
    handoffId: string;
    statusAtSend: AgentPtyStatus;
  } | null>(null);
  const interruptRecoveryInFlightRef = useRef(false);
  const interruptAwaitRef = useRef<{ tabId: string; seq: number; at: number } | null>(null);
  const emptyDraftNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceOwnerKey = tabId + ':' + toolType + ':' + (projectId || '');
  const presenceOwnerKeyRef = useRef(presenceOwnerKey);
  presenceOwnerKeyRef.current = presenceOwnerKey;
  const presenceGenerationRef = useRef(0);
  const processStopInFlightRef = useRef(false);
  const presenceFlightRef = useRef<{
    ownerKey: string;
    trailing: boolean;
    promise: Promise<void>;
  } | null>(null);

  useEffect(() => {
    const element = controlsRef.current;
    if (!element || !onHeightChange || typeof ResizeObserver === 'undefined') return;
    const report = () => onHeightChange(Math.ceil(element.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
      onHeightChange(0);
    };
  }, [onHeightChange, tabId]);

  useEffect(() => () => {
    if (statusCopiedTimerRef.current) clearTimeout(statusCopiedTimerRef.current);
  }, []);

  const clearEmptyDraftNoticeTimer = useCallback(() => {
    if (emptyDraftNoticeTimerRef.current) {
      clearTimeout(emptyDraftNoticeTimerRef.current);
      emptyDraftNoticeTimerRef.current = null;
    }
  }, []);

  const showEmptyDraftNotice = useCallback((message: string) => {
    clearEmptyDraftNoticeTimer();
    setDraftWarning(message);
    emptyDraftNoticeTimerRef.current = setTimeout(() => {
      emptyDraftNoticeTimerRef.current = null;
      setDraftWarning((current) => current === message ? null : current);
    }, 1100);
  }, [clearEmptyDraftNoticeTimer]);

  const setStatusFrom = useCallback((next: AgentPtyStatus, reason: string) => {
    const prev = statusRef.current;
    statusRef.current = next;
    if (prev !== next) {
      console.log('[' + runtime.logPrefix + '] status tab=' + tabId.slice(-12) + ' ' + prev + ' -> ' + next + ' reason=' + reason);
    }
    setStatus(next);
  }, [runtime.logPrefix, tabId]);

  const refreshActivityTiming = useCallback(async (reason: string) => {
    const requestTabId = tabId;
    const requestOwnerKey = tabId + ':' + toolType;
    const requestSeq = ++activityTimingRequestSeqRef.current;
    if (toolType !== 'claude' && toolType !== 'codex') {
      setActivityTiming(null);
      return;
    }
    try {
      const result = await ipcRenderer.invoke('agent-activity:get-tab-timing', {
        tabId,
        toolType,
      });
      if (
        tabIdRef.current !== requestTabId
        || activityTimingOwnerKeyRef.current !== requestOwnerKey
        || activityTimingRequestSeqRef.current !== requestSeq
      ) return;
      const timing = result?.success ? result.timing : null;
      const valid = timing
        && (timing.state === 'running' || timing.state === 'pending')
        && Number.isFinite(Number(timing.startTs));
      setActivityTiming(valid ? {
        state: timing.state,
        intervalId: Number.isFinite(Number(timing.intervalId))
          ? Number(timing.intervalId)
          : null,
        toolType,
        sessionId: timing.sessionId ? String(timing.sessionId) : null,
        startTs: Number(timing.startTs),
        endTs: Number.isFinite(Number(timing.endTs)) ? Number(timing.endTs) : null,
        durationMs: Number.isFinite(Number(timing.durationMs))
          ? Number(timing.durationMs)
          : null,
      } : null);
      setActivityClock(Date.now());
    } catch (e: any) {
      if (
        tabIdRef.current !== requestTabId
        || activityTimingOwnerKeyRef.current !== requestOwnerKey
        || activityTimingRequestSeqRef.current !== requestSeq
      ) return;
      console.warn('[' + runtime.logPrefix + '] response timing refresh failed tab='
        + tabId.slice(-12)
        + ' reason=' + reason
        + ' error=' + String(e?.message || e));
    }
  }, [runtime.logPrefix, tabId, toolType]);

  const setPendingQuestionFrom = useCallback((next: AgentPendingQuestion | null, reason: string) => {
    pendingQuestionRef.current = next;
    setPendingQuestion(next);
    console.log('[ClaudeHistoryQuestion] pending tab=' + tabId.slice(-12) + ' reason=' + reason + ' source=' + (next?.source || 'none') + ' qs=' + (next?.questions?.length || 0));
  }, [tabId]);

  const isNonAuthoritativeBusyEvent = useCallback((data: { reason?: string }) => {
    return runtime.toolType === 'claude' && data.reason === 'spinner';
  }, [runtime.toolType]);

  const refreshPendingQuestion = useCallback(async (reason: string) => {
    if (!tabId || !runtime.getPendingQuestion) return null;
    const requestTabId = tabId;
    try {
      const pending = await runtime.getPendingQuestion(tabId);
      if (tabIdRef.current !== requestTabId) return null;
      setPendingQuestionFrom(pending, reason);
      if (pending && (pending.questions?.length || 0) === 0) {
        console.warn('[ClaudeHistoryQuestion] empty-payload tab=' + tabId.slice(-12) + ' reason=' + reason);
      }
      return pending;
    } catch (e: any) {
      if (tabIdRef.current !== requestTabId) return null;
      const message = String(e?.message || e);
      console.warn('[ClaudeHistoryQuestion] pending refresh failed tab=' + tabId.slice(-12) + ': ' + message);
      setQuestionError(message);
      return null;
    }
  }, [runtime, setPendingQuestionFrom, tabId]);

  const refreshPresence = useCallback((): Promise<void> => {
    if (!tabId) return Promise.resolve();
    const ownerKey = presenceOwnerKey;
    const active = presenceFlightRef.current;
    if (active?.ownerKey === ownerKey) {
      active.trailing = true;
      return active.promise;
    }

    const flight: {
      ownerKey: string;
      trailing: boolean;
      promise: Promise<void>;
    } = {
      ownerKey,
      trailing: false,
      promise: Promise.resolve(),
    };

    flight.promise = (async () => {
      do {
        flight.trailing = false;
        const presenceGeneration = presenceGenerationRef.current;
        try {
          const presence = await runtime.getPresence(tabId, projectId, {
            consumer: 'history-panel',
            ownerKey,
            generation: presenceGeneration,
          });
          if (presenceOwnerKeyRef.current !== ownerKey) {
            console.log('[' + runtime.logPrefix + '] stale presence ignored tab=' + tabId.slice(-12)
              + ' reason=owner-change requested=' + ownerKey
              + ' current=' + presenceOwnerKeyRef.current
              + ' generation=' + presenceGeneration);
            return;
          }
          if (presenceGenerationRef.current !== presenceGeneration) {
            console.log('[' + runtime.logPrefix + '] stale presence ignored tab=' + tabId.slice(-12)
              + ' generation=' + presenceGeneration + ' current=' + presenceGenerationRef.current);
            continue;
          }
          if (processStopInFlightRef.current
            && presence.status !== 'stopping'
            && presence.status !== 'inactive') {
            console.log('[' + runtime.logPrefix + '] presence ignored during Stop tab=' + tabId.slice(-12)
              + ' status=' + presence.status);
            continue;
          }
          setStatusFrom(presence.status, 'presence');
          setProcessLifecycleGeneration(
            runtime.toolType === 'codex'
              ? (presence.runtimeSnapshot?.lifecycleGeneration || null)
              : null,
          );
          if (runtime.toolType === 'claude') {
            const materialized = presence.conversationMaterialized === true || presence.canResume === true;
            setResumeMaterialized(materialized);
            setResumeUnavailableReason(materialized ? null : (presence.materializationReason || 'session_not_materialized'));
          } else {
            setResumeMaterialized(true);
            setResumeUnavailableReason(null);
          }
          if (presence.awaiting) {
            void refreshPendingQuestion('presence-awaiting');
          } else if (pendingQuestionRef.current) {
            setPendingQuestionFrom(null, 'presence-not-awaiting');
          }
        } catch (e: any) {
          if (presenceOwnerKeyRef.current !== ownerKey) {
            console.log('[' + runtime.logPrefix + '] stale presence failure ignored tab=' + tabId.slice(-12)
              + ' reason=owner-change requested=' + ownerKey
              + ' current=' + presenceOwnerKeyRef.current
              + ' generation=' + presenceGeneration);
            return;
          }
          if (presenceGenerationRef.current !== presenceGeneration) continue;
          console.warn('[' + runtime.logPrefix + '] presence failed tab=' + tabId.slice(-12) + ': ' + String(e?.message || e));
          setStatusFrom('inactive', 'presence-error');
          setProcessLifecycleGeneration(null);
        }
      } while (flight.trailing && presenceOwnerKeyRef.current === ownerKey);
    })().finally(() => {
      if (presenceFlightRef.current === flight) presenceFlightRef.current = null;
    });
    presenceFlightRef.current = flight;
    return flight.promise;
  }, [presenceOwnerKey, projectId, refreshPendingQuestion, runtime, setPendingQuestionFrom, setStatusFrom, tabId]);

  const refreshHistoryWithUpdating = useCallback((reason: string) => {
    const seq = ++historyUpdateSeqRef.current;
    setHistoryUpdating(true);
    historyDiag('REFRESH_REQUEST tab=' + tabId.slice(-12) + ' reason=' + reason);
    Promise.resolve(onHistoryRefresh(reason))
      .catch((e: any) => {
        console.warn('[' + runtime.logPrefix + '] history refresh failed tab=' + tabId.slice(-12) + ' reason=' + reason + ': ' + String(e?.message || e));
      })
      .finally(() => {
        if (historyUpdateSeqRef.current === seq && tabIdRef.current === tabId) {
          setHistoryUpdating(false);
        }
        void refreshActivityTiming('history-refresh:' + reason);
      });
  }, [onHistoryRefresh, refreshActivityTiming, runtime.logPrefix, tabId]);

  const refreshDurablePromptProof = useCallback(async (
    text: string,
    submittedAt: number,
    reason: string,
  ) => {
    if (hasDurablePrompt(text, submittedAt)) return true;
    try {
      await onHistoryRefresh(reason);
    } catch (e: any) {
      console.warn('[' + runtime.logPrefix + '] durable prompt refresh failed tab='
        + tabId.slice(-12)
        + ' reason=' + reason
        + ' error=' + String(e?.message || e));
    }
    return hasDurablePrompt(text, submittedAt);
  }, [hasDurablePrompt, onHistoryRefresh, runtime.logPrefix, tabId]);

  useEffect(() => {
    tabIdRef.current = tabId;
    activityTimingOwnerKeyRef.current = tabId + ':' + toolType;
    activityTimingRequestSeqRef.current += 1;
    presenceGenerationRef.current += 1;
    const coordinatedAction = getCoordinatedAgentAction(tabId);
    processStopInFlightRef.current = coordinatedAction?.stopRequestedAt !== null
      && coordinatedAction?.stopRequestedAt !== undefined;
    actionSeqRef.current += 1;
    actionInFlightRef.current = !!coordinatedAction;
    activeActionKindRef.current = coordinatedAction ? 'send' : null;
    pasteBusyRef.current = false;
    pendingQuestionRef.current = null;
    answeringQuestionRef.current = false;
    midstreamPromptRecoveryRef.current = null;
    interruptRecoveryInFlightRef.current = false;
    interruptAwaitRef.current = null;
    setBusyAction(coordinatedAction ? 'send' : null);
    setIsPasteBusy(false);
    setHistoryUpdating(false);
    setError(null);
    setDraftWarning(null);
    setInterruptAwaiting(false);
    setPendingQuestion(null);
    setAnsweringQuestion(false);
    setQuestionError(null);
    setResumeMaterialized(toolType === 'claude' ? null : true);
    setResumeUnavailableReason(null);
    setActivityTiming(null);
    setPasteActivityStartedAt(null);
    setActivityClock(Date.now());
    setPresenceResolving(true);
    setProcessLifecycleGeneration(null);
    setStatusFrom(
      coordinatedAction?.stopRequestedAt
        ? 'stopping'
        : coordinatedAction
          ? 'starting'
          : 'unknown',
      coordinatedAction ? 'tab-bind-coordinated-action' : 'tab-bind',
    );
    const ownerAtBind = presenceOwnerKey;
    void refreshPresence().finally(() => {
      if (presenceOwnerKeyRef.current === ownerAtBind) setPresenceResolving(false);
    });
    void refreshActivityTiming('tab-bind');
    return () => {
      clearEmptyDraftNoticeTimer();
    };
  }, [clearEmptyDraftNoticeTimer, presenceOwnerKey, refreshActivityTiming, refreshPresence, setStatusFrom, tabId, toolType]);

  useEffect(() => {
    const handleTimingChanged = (_event: any, detail: { tabId?: string }) => {
      if (detail?.tabId !== tabId) return;
      void refreshActivityTiming('activity-event');
    };
    ipcRenderer.on('agent-activity:timing-changed', handleTimingChanged);
    return () => {
      ipcRenderer.removeListener('agent-activity:timing-changed', handleTimingChanged);
    };
  }, [refreshActivityTiming, tabId]);

  useEffect(() => {
    if (activityTiming?.state !== 'running' && pasteActivityStartedAt === null) return;
    setActivityClock(Date.now());
    const timer = setInterval(() => setActivityClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activityTiming?.startTs, activityTiming?.state, pasteActivityStartedAt]);

  useEffect(() => {
    if (activityTiming?.state !== 'pending' || !activityTiming.endTs) return;
    const remainingMs = Math.max(
      0,
      10 * 1000 - (Date.now() - activityTiming.endTs),
    );
    const timer = setTimeout(() => {
      void refreshActivityTiming('pending-expired');
    }, remainingMs + 50);
    return () => clearTimeout(timer);
  }, [activityTiming?.endTs, activityTiming?.state, refreshActivityTiming]);

  useEffect(() => subscribeCoordinatedAgentActions((event: any) => {
    if (event?.tabId !== tabIdRef.current) return;
    const coordinatedAction = event.state || getCoordinatedAgentAction(tabIdRef.current);
    if (coordinatedAction) {
      actionInFlightRef.current = true;
      activeActionKindRef.current = 'send';
      setBusyAction('send');
      if (coordinatedAction.stopRequestedAt !== null) {
        processStopInFlightRef.current = true;
        presenceGenerationRef.current += 1;
        setStatusFrom('stopping', 'coordinated-stop-after-send');
      }
      return;
    }
    actionInFlightRef.current = false;
    activeActionKindRef.current = null;
    processStopInFlightRef.current = false;
    setBusyAction(null);
    if (event.reason === 'queued-stop-complete') {
      presenceGenerationRef.current += 1;
      pasteBusyRef.current = false;
      setIsPasteBusy(false);
      setStatusFrom('inactive', 'coordinated-stop-complete');
      return;
    }
    if (event.reason === 'queued-stop-failed') {
      setError(String(event.result?.error || 'Stop failed'));
    }
    refreshPresence();
  }), [refreshPresence, setStatusFrom]);

  useEffect(() => {
    const handleAgentError = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as { tabId?: string; message?: string; error?: string };
      if (detail.tabId !== tabId) return;
      const message = String(detail.message || detail.error || '').trim();
      if (!message) return;
      setError(message);
      setDraftWarning(null);
    };
    const handleStartupGate = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as { tabId?: string; status?: string; reason?: string; error?: string };
      if (detail.tabId !== tabId) return;
      if (detail.status === 'failed') {
        const message = String(detail.error || detail.reason || 'Claude startup failed').trim();
        setError(message);
        setDraftWarning(null);
        refreshPresence();
      } else if (detail.status === 'ready') {
        refreshPresence();
      }
    };
    const handleDraftWarning = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as { tabId?: string; message?: string };
      if (detail.tabId !== tabId) return;
      const message = String(detail.message || '').trim();
      if (!message) return;
      setDraftWarning(message);
    };
    window.addEventListener('history-panel:agent-error', handleAgentError);
    window.addEventListener('history-panel:draft-warning', handleDraftWarning);
    window.addEventListener('claude-startup-defaults-gate', handleStartupGate);
    return () => {
      window.removeEventListener('history-panel:agent-error', handleAgentError);
      window.removeEventListener('history-panel:draft-warning', handleDraftWarning);
      window.removeEventListener('claude-startup-defaults-gate', handleStartupGate);
    };
  }, [refreshPresence, tabId]);

  useEffect(() => {
    const handleTuiReady = (_: any, data: { tabId?: string }) => {
      if (data?.tabId !== tabId) return;
      if (processStopInFlightRef.current) return;
      console.log('[' + runtime.logPrefix + '] ready-event tab=' + tabId.slice(-12));
      refreshPresence();
    };
    const handleStarted = (_: any, data: { tabId?: string }) => {
      if (data?.tabId !== tabId) return;
      if (processStopInFlightRef.current) {
        console.log('[' + runtime.logPrefix + '] command-started ignored during Stop tab=' + tabId.slice(-12));
        return;
      }
      const current = statusRef.current;
      if (runtime.toolType === 'codex') setProcessLifecycleGeneration(null);
      const next = current === 'active' || current === 'busy' ? current : 'starting';
      setStatusFrom(next, 'command-started');
    };
    const handleBusy = (_: any, data: { tabId?: string; busy?: boolean; reason?: string; lifecycleGeneration?: string | null }) => {
      if (data?.tabId !== tabId) return;
      if (processStopInFlightRef.current) {
        console.log('[' + runtime.logPrefix + '] busy event ignored during Stop tab=' + tabId.slice(-12)
          + ' busy=' + !!data.busy + ' reason=' + (data.reason || '-'));
        return;
      }
      if (isNonAuthoritativeBusyEvent(data)) {
        refreshPresence();
        return;
      }
      if (runtime.toolType === 'codex' && data.lifecycleGeneration) {
        setProcessLifecycleGeneration(data.lifecycleGeneration);
      }
      if (data.busy) setStatusFrom('busy', 'busy-state');
      else {
        if (pendingQuestionRef.current) setPendingQuestionFrom(null, 'busy-false');
        refreshHistoryWithUpdating('busy-false:' + (data.reason || 'unknown'));
        refreshPresence();
      }
    };
    const handleFinished = (_: any, data: { tabId?: string }) => {
      if (data?.tabId !== tabId) return;
      pasteBusyRef.current = false;
      setIsPasteBusy(false);
      refreshHistoryWithUpdating('command-finished');
      refreshPresence();
    };
    const handleAwaitingInput = (_: any, data: { tabId?: string; awaiting?: boolean }) => {
      if (data?.tabId !== tabId) return;
      console.log('[ClaudeHistoryQuestion] awaiting-event tab=' + tabId.slice(-12) + ' awaiting=' + !!data.awaiting);
      if (data.awaiting) {
        refreshPendingQuestion('awaiting-event');
      } else {
        setPendingQuestionFrom(null, 'awaiting-cleared');
        setQuestionError(null);
      }
    };
    const handlePasteBusy = (_: any, data: { tabId?: string; busy?: boolean }) => {
      if (data?.tabId !== tabId) return;
      const nextBusy = !!data.busy;
      if (nextBusy && !pasteBusyRef.current) {
        setPasteActivityStartedAt(Date.now());
        setActivityClock(Date.now());
      } else if (!nextBusy) {
        setPasteActivityStartedAt(null);
      }
      pasteBusyRef.current = nextBusy;
      setIsPasteBusy(nextBusy);
      console.log('[' + runtime.logPrefix + '] paste-busy tab=' + tabId.slice(-12) + ' busy=' + !!data.busy);
    };

    if (runtime.readyEvent) ipcRenderer.on(runtime.readyEvent, handleTuiReady);
    ipcRenderer.on(runtime.busyEvent, handleBusy);
    if (runtime.awaitingEvent) ipcRenderer.on(runtime.awaitingEvent, handleAwaitingInput);
    if (runtime.pasteBusyEvent) ipcRenderer.on(runtime.pasteBusyEvent, handlePasteBusy);
    ipcRenderer.on('terminal:command-started', handleStarted);
    ipcRenderer.on('terminal:command-finished', handleFinished);
    return () => {
      if (runtime.readyEvent) ipcRenderer.removeListener(runtime.readyEvent, handleTuiReady);
      ipcRenderer.removeListener(runtime.busyEvent, handleBusy);
      if (runtime.awaitingEvent) ipcRenderer.removeListener(runtime.awaitingEvent, handleAwaitingInput);
      if (runtime.pasteBusyEvent) ipcRenderer.removeListener(runtime.pasteBusyEvent, handlePasteBusy);
      ipcRenderer.removeListener('terminal:command-started', handleStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleFinished);
    };
  }, [refreshPendingQuestion, runtime, setPendingQuestionFrom, tabId, refreshPresence, setStatusFrom, isNonAuthoritativeBusyEvent, refreshHistoryWithUpdating]);

  const readTerminalDraft = useCallback(async (reason: string) => {
    const requestTabId = tabId;
    const draftState = runtime.probeDraft
      ? await runtime.probeDraft(tabId, 'history-' + reason)
      : runtime.inspectDraft?.(tabId);
    if (draftState) {
      console.log('[' + runtime.logPrefix + ':draft] preflight tab=' + tabId.slice(-12) + ' reason=' + reason + ' hasDraft=' + draftState.hasDraft + ' source=' + draftState.source);
      const draftDecision = classifyAgentDraftPreflight(draftState);
      if (draftDecision.decision === 'clear') {
        return { stale: false, text: '', images: 0, imagePaths: [] as HistoryPromptDraftImageRef[] };
      }
      if (draftDecision.decision === 'unknown' && draftState.exactCaptureRecommended !== true) {
        throw new Error(runtime.label + ' terminal draft state is unknown; send stopped before touching terminal input.');
      }
    }
    console.log('[' + runtime.logPrefix + ':draft] grab-request tab=' + tabId.slice(-12) + ' reason=' + reason);
    const result = await runtime.grabDraft(tabId, draftState ? {
      draftProof: buildExactDraftCaptureProof(draftState),
    } : undefined);
    if (tabIdRef.current !== requestTabId) return { stale: true, text: '', images: 0, imagePaths: [] as HistoryPromptDraftImageRef[] };
    if (!result?.success) {
      const message = draftGrabErrorText(result);
      console.warn('[' + runtime.logPrefix + ':draft] grab-failed tab=' + tabId.slice(-12) + ' reason=' + reason + ' error=' + (result?.error || 'unknown'));
      throw new Error(message);
    }
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    const images = Number(result.images || 0);
    const imagePaths = Array.isArray(result.imagePaths) ? result.imagePaths : [];
    if (draftState && !text && images === 0) {
      const conflict = resolveAgentDraftConflict(draftState, result, {
        attemptedCapture: true,
      });
      if (conflict.decision !== 'clear') {
        throw new Error(runtime.label + ' terminal draft state is still unknown; send stopped before touching terminal input.');
      }
      console.warn('[' + runtime.logPrefix + ':draft] ambiguous screen tail resolved as empty tab='
        + tabId.slice(-12) + ' reason=' + (conflict.reason || '-'));
    }
    console.log('[' + runtime.logPrefix + ':draft] grab-ok tab=' + tabId.slice(-12) + ' reason=' + reason + ' chars=' + text.length + ' images=' + images);
    return { stale: false, text, images, imagePaths };
  }, [runtime, tabId]);

  useEffect(() => {
    if (!runtime.supportsInterruptRecovery) return;
    const finishInterruptAwait = (finishReason: string) => {
      const waiting = interruptAwaitRef.current;
      if (!waiting || waiting.tabId !== tabIdRef.current) return;
      const ageMs = Date.now() - waiting.at;
      console.log('[' + runtime.logPrefix + ':draft] interrupt-await done tab=' + tabId.slice(-12) + ' reason=' + finishReason + ' ageMs=' + ageMs);
      interruptAwaitRef.current = null;
      setInterruptAwaiting(false);
      if (actionSeqRef.current === waiting.seq) {
        actionInFlightRef.current = false;
        setBusyAction((current) => current === 'interrupt' ? null : current);
      }
      refreshPresence();
    };
    const handleInterruptRecovery = (_: any, data: { tabId?: string; busy?: boolean; reason?: string }) => {
      if (data?.tabId !== tabId || data.busy) return;
      if (isNonAuthoritativeBusyEvent(data)) return;
      console.log('[' + runtime.logPrefix + ':draft] interrupt-event tab=' + tabId.slice(-12) + ' reason=' + (data.reason || '-') + ' hasPending=' + !!midstreamPromptRecoveryRef.current);
      historyDiag('INTERRUPT_EVENT tab=' + tabId.slice(-12) +
        ' reason=' + (data.reason || '-') +
        ' hasPending=' + !!midstreamPromptRecoveryRef.current +
        ' pending=' + (midstreamPromptRecoveryRef.current?.handoffId || '-'));
      const recoveryReasons = runtime.interruptRecoveryReasons || ['interrupt'];
      if (!recoveryReasons.includes(data.reason || '')) {
        midstreamPromptRecoveryRef.current = null;
        finishInterruptAwait('busy-false:' + (data.reason || 'unknown'));
        return;
      }
      const pending = midstreamPromptRecoveryRef.current;
      if (!pending) {
        console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery skip tab=' + tabId.slice(-12) + ' reason=no-midstream-send');
        finishInterruptAwait('confirmed-no-prompt');
        return;
      }
      if (interruptRecoveryInFlightRef.current) {
        console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery skip tab=' + tabId.slice(-12) + ' reason=inflight');
        return;
      }
      const ageMs = Date.now() - pending.at;
      if (ageMs > 120000) {
        console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery skip tab=' + tabId.slice(-12) + ' reason=stale ageMs=' + ageMs);
        midstreamPromptRecoveryRef.current = null;
        finishInterruptAwait('stale-pending-prompt');
        return;
      }

      const requestTabId = tabId;
      interruptRecoveryInFlightRef.current = true;
      console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery start tab=' + tabId.slice(-12) + ' ageMs=' + ageMs + ' sentChars=' + pending.serializedText.length + ' chips=' + pending.chips.length);
      historyDiag('INTERRUPT_RECOVERY_START tab=' + tabId.slice(-12) +
        ' handoff=' + pending.handoffId +
        ' ageMs=' + ageMs +
        ' statusAtSend=' + pending.statusAtSend +
        ' chars=' + pending.serializedText.length +
        ' chips=' + pending.chips.length +
        ' preview="' + promptPreview(pending.serializedText) + '"');
      (async () => {
        const attempt = 1;
        if (tabIdRef.current !== requestTabId) return;
        if (hasDurablePrompt(pending.serializedText, pending.submittedAt)) {
          console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery accepted tab=' + tabId.slice(-12)
            + ' attempt=' + attempt
            + ' handoff=' + pending.handoffId
            + ' disposition=durable');
          historyDiag('INTERRUPT_RECOVERY_ACCEPTED tab=' + tabId.slice(-12) +
            ' handoff=' + pending.handoffId +
            ' attempt=' + attempt +
            ' disposition=durable');
          return;
        }
        console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery probe tab=' + tabId.slice(-12)
          + ' attempt=' + attempt
          + ' source=authoritative-stop-event');
        try {
            const draft = await readTerminalDraft('interrupt-recovery');
            if (draft.stale || tabIdRef.current !== requestTabId) return;
            if (!draft.text) {
              console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery empty tab=' + tabId.slice(-12) + ' attempt=' + attempt);
            } else {
              const ownership = resolveInterruptedPromptOwnership({
                durablePromptExists: hasDurablePrompt(pending.serializedText, pending.submittedAt),
                returnedDraftExists: true,
                returnedDraftMatchesHandoff: false,
              });
              if (ownership === 'durable') {
                console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery accepted tab=' + tabId.slice(-12)
                  + ' attempt=' + attempt
                  + ' handoff=' + pending.handoffId
                  + ' disposition=durable-after-probe');
                historyDiag('INTERRUPT_RECOVERY_ACCEPTED tab=' + tabId.slice(-12) +
                  ' handoff=' + pending.handoffId +
                  ' attempt=' + attempt +
                  ' disposition=durable-after-probe');
                return;
              }
              const ui = useUIStore.getState();
              const current = ui.historyPromptDrafts[requestTabId] || '';
              const currentChips = ui.historyPromptDraftChips[requestTabId] || [];
              const currentImages = ui.historyPromptDraftImages[requestTabId] || [];
              const terminalIdentity = normalizeHistoryPromptIdentityText(draft.text);
              const authoringProof = terminalIdentity === normalizeHistoryPromptIdentityText(pending.serializedText)
                || terminalIdentity === normalizeHistoryPromptIdentityText(pending.transportText);
              const confirmedOwnership = resolveInterruptedPromptOwnership({
                durablePromptExists: authoringProof
                  ? await refreshDurablePromptProof(
                      pending.serializedText,
                      pending.submittedAt,
                      'interrupt-exact-draft',
                    )
                  : hasDurablePrompt(pending.serializedText, pending.submittedAt),
                returnedDraftExists: true,
                returnedDraftMatchesHandoff: authoringProof,
              });
              if (confirmedOwnership === 'durable') {
                historyDiag('INTERRUPT_RECOVERY_ACCEPTED tab=' + tabId.slice(-12) +
                  ' handoff=' + pending.handoffId +
                  ' attempt=' + attempt +
                  ' disposition=durable-after-fresh-read');
                return;
              }
              const composerStillEmpty = !current.trim()
                && currentChips.length === 0
                && currentImages.length === 0;

              if (authoringProof && composerStillEmpty) {
                setHistoryPromptDraft(requestTabId, pending.rawText, {
                  images: pending.images,
                  chips: pending.chips,
                });
                setDraftWarning(runtime.label + ' returned an interrupted prompt; its text and chips were restored.');
                console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery restored tab=' + tabId.slice(-12)
                  + ' source=authoring-snapshot chars=' + pending.rawText.length
                  + ' chips=' + pending.chips.length
                  + ' images=' + pending.images.length);
                onPromptStatusChange(pending.handoffId, 'cancelled', 'interrupt-restored-authoring-snapshot');
                historyDiag('INTERRUPT_RECOVERY_RESTORED tab=' + tabId.slice(-12) +
                  ' handoff=' + pending.handoffId +
                  ' attempt=' + attempt +
                  ' source=authoring-snapshot' +
                  ' chars=' + pending.rawText.length +
                  ' chips=' + pending.chips.length +
                  ' images=' + pending.images.length);
                requestAnimationFrame(() => promptTextareaRef.current?.focus());
                return;
              }

              const nextText = prependPromptTextOnce(current, draft.text);
              const mergedImages = retainHistoryDraftImages(nextText, [
                ...currentImages,
                ...(Array.isArray(draft.imagePaths) ? draft.imagePaths : []),
              ]);
              setHistoryPromptDraft(requestTabId, nextText, {
                ...(mergedImages.length > 0 ? { images: mergedImages } : { preserveImages: true }),
                preserveChips: true,
              });
              setDraftWarning(authoringProof
                ? runtime.label + ' returned an interrupted prompt; pulled it back from terminal input.'
                : runtime.label + ' had another terminal draft; it was moved into the input without cancelling the sent message.');
              console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery restored tab=' + tabId.slice(-12)
                + ' source=terminal-raw attempt=' + attempt
                + ' chars=' + draft.text.length
                + ' images=' + draft.images
                + ' conflict=' + (!composerStillEmpty)
                + ' authoringProof=' + authoringProof);
              if (confirmedOwnership === 'restore') {
                onPromptStatusChange(pending.handoffId, 'cancelled', 'interrupt-restored-terminal-draft');
              }
              historyDiag('INTERRUPT_RECOVERY_RESTORED tab=' + tabId.slice(-12) +
                ' handoff=' + pending.handoffId +
                ' attempt=' + attempt +
                ' chars=' + draft.text.length +
                ' images=' + draft.images +
                ' ownership=' + confirmedOwnership);
              requestAnimationFrame(() => promptTextareaRef.current?.focus());
              return;
            }
        } catch (e: any) {
          console.warn('[' + runtime.logPrefix + ':draft] interrupt-recovery probe-failed tab=' + tabId.slice(-12) + ' attempt=' + attempt + ': ' + String(e?.message || e));
        }
        if (tabIdRef.current !== requestTabId) return;
        const ownership = resolveInterruptedPromptOwnership({
          durablePromptExists: await refreshDurablePromptProof(
            pending.serializedText,
            pending.submittedAt,
            'interrupt-empty-draft',
          ),
          returnedDraftExists: false,
        });
        if (ownership === 'durable') {
          historyDiag('INTERRUPT_RECOVERY_ACCEPTED tab=' + tabId.slice(-12) +
            ' handoff=' + pending.handoffId +
            ' attempt=' + attempt +
            ' disposition=durable');
          return;
        }
        showEmptyDraftNotice(runtime.label + ' stopped; the prompt was not returned, so its delivery remains pending.');
        console.warn('[' + runtime.logPrefix + ':draft] interrupt-recovery pending tab=' + tabId.slice(-12) + ' reason=no-terminal-draft probes=1 sentChars=' + pending.serializedText.length);
        historyDiag('INTERRUPT_RECOVERY_PENDING tab=' + tabId.slice(-12) +
          ' handoff=' + pending.handoffId +
          ' reason=no-terminal-draft probes=1' +
          ' sentChars=' + pending.serializedText.length);
      })()
        .catch((e: any) => {
          console.warn('[' + runtime.logPrefix + ':draft] interrupt-recovery failed tab=' + tabId.slice(-12) + ': ' + String(e?.message || e));
        })
        .finally(() => {
          if (tabIdRef.current === requestTabId) {
            midstreamPromptRecoveryRef.current = null;
            interruptRecoveryInFlightRef.current = false;
            finishInterruptAwait('recovery-complete');
          }
        });
    };

    ipcRenderer.on(runtime.busyEvent, handleInterruptRecovery);
    return () => {
      ipcRenderer.removeListener(runtime.busyEvent, handleInterruptRecovery);
    };
  }, [hasDurablePrompt, isNonAuthoritativeBusyEvent, onPromptStatusChange, readTerminalDraft, refreshDurablePromptProof, refreshPresence, runtime, setHistoryPromptDraft, showEmptyDraftNotice, tabId]);

  useEffect(() => {
    if (!interruptAwaiting || status === 'busy') return;
    const waiting = interruptAwaitRef.current;
    if (!waiting || waiting.tabId !== tabIdRef.current) return;
    const timer = setTimeout(() => {
      const current = interruptAwaitRef.current;
      if (!current || current.tabId !== tabIdRef.current || statusRef.current === 'busy') return;
      const ageMs = Date.now() - current.at;
      console.log('[' + runtime.logPrefix + ':draft] interrupt-await clear tab=' + tabId.slice(-12) + ' reason=non-busy-status status=' + statusRef.current + ' ageMs=' + ageMs);
      historyDiag('INTERRUPT_AWAIT_CLEAR tab=' + tabId.slice(-12) +
        ' reason=non-busy-status' +
        ' status=' + statusRef.current +
        ' ageMs=' + ageMs);
      interruptAwaitRef.current = null;
      setInterruptAwaiting(false);
      if (actionSeqRef.current === current.seq) {
        actionInFlightRef.current = false;
        setBusyAction((active) => active === 'interrupt' ? null : active);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [interruptAwaiting, runtime.logPrefix, status, tabId]);

  const pullTerminalDraft = useCallback(async () => {
    if (actionInFlightRef.current) {
      console.log('[' + runtime.logPrefix + ':draft] drop-pull tab=' + tabId.slice(-12) + ' reason=inflight');
      return;
    }
    if (statusRef.current !== 'active' && statusRef.current !== 'busy') {
      setError(runtime.label + ' is not ready (' + statusRef.current + ')');
      return;
    }
    if (pendingQuestionRef.current) {
      setError(runtime.label + ' is waiting for a question answer');
      return;
    }

    const actionTabId = tabId;
    const actionSeq = ++actionSeqRef.current;
    const isCurrentAction = () => (
      tabIdRef.current === actionTabId && actionSeqRef.current === actionSeq
    );
    actionInFlightRef.current = true;
    setBusyAction('grab');
    setError(null);
    setDraftWarning(null);
    try {
      const draft = await readTerminalDraft('manual-pull');
      if (draft.stale || !isCurrentAction()) return;
      if (!draft.text) {
        showEmptyDraftNotice(runtime.label + ' terminal input is empty');
        return;
      }
      const current = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
      const pulledImages = Array.isArray(draft.imagePaths) ? draft.imagePaths : [];
      // A blue [Image #N] means "the file is here". Any marker whose file did
      // not come across must NOT keep that look — it would promise an
      // attachment the send has no way to deliver. Unresolved markers become a
      // red [imageError: …], the same shape Run after already uses.
      const resolvedIds = new Set(pulledImages.map((ref: any) => Number(ref?.id)));
      let unresolvedMarkers = 0;
      const pulledText = String(draft.text || '').replace(
        /\[Image\s+#?(\d+)\]/g,
        (marker, rawId) => {
          if (resolvedIds.has(Number(rawId))) return marker;
          unresolvedMarkers += 1;
          return '[imageError: файл изображения #' + rawId + ' не найден]';
        },
      );
      const nextText = prependPromptText(current, pulledText);
      const mergedImages = retainHistoryDraftImages(nextText, [
        ...(useUIStore.getState().historyPromptDraftImages[actionTabId] || []),
        ...pulledImages,
      ]);
      setHistoryPromptDraft(actionTabId, nextText, mergedImages.length > 0
        ? { images: mergedImages, preserveChips: true }
        : { preserveImages: true, preserveChips: true });
      // Only failure is worth a warning. A fully carried-over image is a normal
      // successful transfer, and warning about it trained the user to ignore
      // the row that also reports real problems.
      if (unresolvedMarkers > 0) {
        setDraftWarning(
          unresolvedMarkers === 1
            ? 'Картинка осталась в терминале: файл не найден. В тексте вместо неё — пометка ошибки, удалите её или вставьте картинку заново.'
            : 'Не перенеслись картинки: ' + unresolvedMarkers + '. В тексте вместо них — пометки ошибки, удалите их или вставьте картинки заново.',
        );
      }
      console.log('[' + runtime.logPrefix + ':draft] pull-images tab=' + actionTabId.slice(-12)
        + ' markers=' + draft.images
        + ' carried=' + pulledImages.length
        + ' unresolved=' + unresolvedMarkers);
      requestAnimationFrame(() => promptTextareaRef.current?.focus());
    } catch (e: any) {
      if (isCurrentAction()) {
        setError(String(e?.message || e));
        refreshPresence();
      }
    } finally {
      if (isCurrentAction()) {
        actionInFlightRef.current = false;
        setBusyAction(null);
      }
    }
  }, [readTerminalDraft, refreshPresence, runtime.label, runtime.logPrefix, setHistoryPromptDraft, showEmptyDraftNotice, tabId]);

  const prepareHistoryPromptForSend = useCallback(async (
    text: string,
    images: HistoryPromptDraftImageRef[],
  ): Promise<{
    success: boolean;
    payload: string;
    images: HistoryPromptDraftImageRef[];
    warning?: string;
  }> => {
    const retainedImages = retainHistoryDraftImages(text, images);
    const immediateWarning = historyDraftImageWarning(runtime.toolType, text, retainedImages);
    if (immediateWarning) {
      return { success: false, payload: text, images: retainedImages, warning: immediateWarning };
    }

    const imageIds = collectPromptImageRefIds(text);
    if (imageIds.size === 0) {
      return { success: true, payload: text, images: [] };
    }

    try {
      const result = await ipcRenderer.invoke('prompt-queue:materialize-image-refs', {
        refs: retainedImages,
      });
      const returnedRefs = Array.isArray(result?.refs)
        ? result.refs as HistoryPromptDraftImageRef[]
        : [];
      const returnedById = new Map(returnedRefs.map((ref) => [Number(ref.id), ref]));
      const responseIsComplete = Array.from(imageIds).every((id) => returnedById.has(id));
      if (!responseIsComplete) {
        return {
          success: false,
          payload: text,
          images: retainedImages,
          warning: 'Could not verify the image file. The draft was kept; try sending again.',
        };
      }
      const materializedImages = retainHistoryDraftImages(
        text,
        returnedRefs,
      );
      const state = getPromptImageAttachmentState({
        text,
        images: imageIds.size,
        imagePaths: materializedImages,
      });
      if (state !== 'ready') {
        return {
          success: false,
          payload: text,
          images: materializedImages,
          warning: 'Image file is unavailable. The draft was kept; paste the image again before sending.',
        };
      }
      return {
        success: true,
        payload: buildPromptImagePayload(text, materializedImages, {
          missingCode: 'history_image_path_unavailable',
        }),
        images: materializedImages,
      };
    } catch (cause: any) {
      console.warn('[' + runtime.logPrefix + ':images] materialize failed tab=' + tabId.slice(-12)
        + ' error=' + String(cause?.message || cause));
      return {
        success: false,
        payload: text,
        images: retainedImages,
        warning: 'Could not verify the image file. The draft was kept; try pasting the image again.',
      };
    }
  }, [runtime.logPrefix, runtime.toolType, tabId]);

  const runAction = useCallback(async (kind: 'resume' | 'send' | 'interrupt' | 'stop') => {
    if (kind === 'send') {
      const currentDraft = useUIStore.getState().historyPromptDrafts[tabId] || '';
      if (isTerminalOnlyComposerDraft(currentDraft)) {
        historyDiag('DROP_ACTION tab=' + tabId.slice(-12) + ' kind=send reason=terminal-only-slash');
        requestAnimationFrame(() => promptTextareaRef.current?.focus());
        return;
      }
    }
    const coordinatedAtClick = getCoordinatedAgentAction(tabId);
    if (coordinatedAtClick) {
      actionInFlightRef.current = true;
      activeActionKindRef.current = 'send';
    }
    if (actionInFlightRef.current) {
      const activeKind = activeActionKindRef.current;
      if (kind === 'stop' && activeKind === 'send') {
        const queued = requestCoordinatedStopAfterSend(tabId);
        if (queued.queued && !queued.deduped) {
          if (queued.state?.handoffId) {
            const cancelled = await ipcRenderer.invoke('agent:cancel-send', {
              tabId,
              handoffId: queued.state.handoffId,
            }).catch((cause: any) => ({
              cancelled: false,
              reason: String(cause?.message || cause),
            }));
            historyDiag('CANCEL_SEND_BOUNDARY tab=' + tabId.slice(-12)
              + ' handoff=' + queued.state.handoffId
              + ' cancelled=' + !!cancelled?.cancelled
              + ' reason=' + (cancelled?.reason || '-'));
          }
          processStopInFlightRef.current = true;
          presenceGenerationRef.current += 1;
          setStatusFrom('stopping', 'stop-queued-after-send');
          historyDiag('QUEUE_ACTION tab=' + tabId.slice(-12)
            + ' kind=stop after=send'
            + ' busyAction=' + (busyAction || activeKind));
        } else if (queued.queued) {
          historyDiag('DEDUP_ACTION tab=' + tabId.slice(-12)
            + ' kind=stop after=send'
            + ' queuedAgeMs=' + (
              queued.state?.stopRequestedAt
                ? Date.now() - queued.state.stopRequestedAt
                : 0
            ));
        } else {
          historyDiag('DROP_ACTION tab=' + tabId.slice(-12)
            + ' kind=stop reason=' + (queued.reason || 'coordinator-missing'));
        }
        return;
      }
      console.log('[' + runtime.logPrefix + '] drop-action tab=' + tabId.slice(-12) + ' kind=' + kind + ' reason=inflight');
      historyDiag('DROP_ACTION tab=' + tabId.slice(-12) + ' kind=' + kind + ' reason=inflight busyAction=' + (busyAction || activeKind || 'none'));
      return;
    }
    if (kind === 'send' && pasteBusyRef.current) {
      console.log('[' + runtime.logPrefix + '] drop-action tab=' + tabId.slice(-12) + ' kind=send reason=paste-busy');
      return;
    }
    const actionTabId = tabId;
    let coordinatedSendToken: number | null = null;
    if (kind === 'send') {
      const started = beginCoordinatedAgentSend(actionTabId);
      if (!started.started || !started.token) {
        historyDiag('DROP_ACTION tab=' + actionTabId.slice(-12)
          + ' kind=send reason=' + (started.reason || 'coordinator-inflight'));
        return;
      }
      coordinatedSendToken = started.token;
    }
    const actionSeq = ++actionSeqRef.current;
    const isCurrentAction = () => (
      tabIdRef.current === actionTabId && actionSeqRef.current === actionSeq
    );
    let sendHandoffId: string | null = null;
    let sendOwnershipTransferred = false;
    let sendDeliveryUnconfirmed = false;
    let sendTransferredQueueStatus: 'queued' | 'sent' = 'sent';
    let sendAuditIdentity: {
      requiresAuditIdentity?: boolean;
      auditTimestamp?: string;
      auditHash?: string;
      auditSessionId?: string;
      auditEntryUuid?: string;
      sourceIdentity?: string;
    } | undefined;
    let clearedPromptText: string | null = null;
    let clearedPromptImages: HistoryPromptDraftImageRef[] = [];
    let clearedPromptChips: HistoryPromptDraftChip[] = [];
    let sendRefusalPasteWritten = false;
    let deferredSendRollback = false;
    const restoreClearedSendSnapshot = (reason: string) => {
      const restorePrompt = clearedPromptText;
      if (
        sendOwnershipTransferred
        || (
          restorePrompt === null
          && clearedPromptImages.length === 0
          && clearedPromptChips.length === 0
        )
      ) return;
      const current = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
      const currentImages = useUIStore.getState().historyPromptDraftImages[actionTabId] || [];
      const currentChips = useUIStore.getState().historyPromptDraftChips[actionTabId] || [];
      const hasNewDraft = !!current || currentImages.length > 0 || currentChips.length > 0;
      if (!hasNewDraft) {
        setHistoryPromptDraft(actionTabId, restorePrompt || '', {
          images: clearedPromptImages,
          chips: clearedPromptChips,
        });
        historyDiag('SEND_ROLLBACK_RESTORE tab=' + actionTabId.slice(-12)
          + ' handoff=' + (sendHandoffId || '-')
          + ' reason=' + reason
          + ' mode=exact'
          + ' chars=' + (restorePrompt || '').length
          + ' images=' + clearedPromptImages.length
          + ' chips=' + clearedPromptChips.length);
        return;
      }
      const merged = mergeFailedHistoryAuthoringSnapshot({
        currentText: current,
        currentImages,
        currentChips,
        snapshotText: restorePrompt || '',
        snapshotImages: clearedPromptImages,
        snapshotChips: clearedPromptChips,
        createChipId: (chip: HistoryPromptDraftChip) => createComposerChipId(chip.kind),
      });
      setHistoryPromptDraft(actionTabId, merged.text, {
        images: merged.images,
        chips: merged.chips,
      });
      if (isCurrentAction()) {
        setDraftWarning('Send stopped before Enter. The failed prompt was restored before your newer draft.');
      }
      historyDiag('SEND_ROLLBACK_RESTORE tab=' + actionTabId.slice(-12)
        + ' handoff=' + (sendHandoffId || '-')
        + ' reason=' + reason
        + ' mode=prepend-merge'
        + ' snapshotChars=' + (restorePrompt || '').length
        + ' currentChars=' + current.length
        + ' mergedChars=' + merged.text.length
        + ' snapshotHash=' + historyOwnerDigest(restorePrompt || '')
        + ' currentHash=' + historyOwnerDigest(current)
        + ' mergedHash=' + historyOwnerDigest(merged.text)
        + ' images=' + clearedPromptImages.length + '->' + merged.images.length
        + ' remappedImages=' + merged.remappedImageCount
        + ' missingImageIds=' + merged.missingImageSourceIds.join(',')
        + ' chips=' + clearedPromptChips.length + '+' + currentChips.length + '->' + merged.chips.length);
    };
    actionInFlightRef.current = true;
    activeActionKindRef.current = kind;
    setBusyAction(kind);
    setError(null);
    try {
      if (kind === 'resume') {
        processStopInFlightRef.current = false;
        presenceGenerationRef.current += 1;
        const startingFresh = !sessionId;
        setStatusFrom('starting', startingFresh ? 'start-click' : 'resume-click');
        const result = startingFresh
          ? await runtime.startFresh?.({ tabId, cwd })
          : await runtime.resume({ tabId, sessionId, cwd });
        if (!isCurrentAction()) return;
        if (!result) throw new Error(runtime.label + ' cannot start from History');
        if (!result.success) {
          if (runtime.toolType === 'claude' && result.error === 'session_not_materialized') {
            setResumeMaterialized(false);
            setResumeUnavailableReason(result.materializationReason || 'session_not_materialized');
            throw new Error('Claude has no saved conversation yet');
          }
          throw new Error(result.error || 'Resume failed');
        }
        if (result.alreadyRunning && result.status) setStatusFrom(result.status, 'resume-already-running');
      } else if (kind === 'send') {
        // Event-driven senders (dictation stop+Enter, Run After, external
        // composer actions) can update the tab-scoped draft and request Send
        // in the same turn. Read the source of truth now instead of relying on
        // the React render that created this callback.
        const rawDraftSnapshot = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
        const sourceDraftChips = normalizeComposerChips(
          useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
        ) as HistoryPromptDraftChip[];
        const presentationText = serializeComposerDraft({
          text: rawDraftSnapshot,
          chips: sourceDraftChips,
        }).trim();
        if (!presentationText) return;
        if (pendingQuestionRef.current) throw new Error(runtime.label + ' is waiting for a question answer');
        const statusAtSend = statusRef.current;
        const acceptsBusyPrompt = statusAtSend === 'busy' && runtime.allowSendWhileBusy;
        const canLaunchBeforeSend = statusAtSend === 'inactive' && (
          sessionId
            ? (runtime.toolType !== 'claude' || resumeMaterialized === true)
            : !!runtime.startFresh
        );
        if (statusAtSend !== 'active' && !acceptsBusyPrompt && !canLaunchBeforeSend) {
          throw new Error(runtime.label + ' is not ready (' + statusAtSend + ')');
        }
        if (statusAtSend === 'active') {
          const terminalDraft = await readTerminalDraft('send-preflight');
          if (terminalDraft.stale || !isCurrentAction()) return;
          if (terminalDraft.text) {
            const nextEditableText = prependPromptText(rawDraftSnapshot, terminalDraft.text);
            const mergedImages = retainHistoryDraftImages(nextEditableText, [
              ...(useUIStore.getState().historyPromptDraftImages[actionTabId] || []),
              ...(Array.isArray(terminalDraft.imagePaths) ? terminalDraft.imagePaths : []),
            ]);
            setHistoryPromptDraft(actionTabId, nextEditableText, {
              ...(mergedImages.length > 0 ? { images: mergedImages } : { preserveImages: true }),
              chips: sourceDraftChips,
            });
            setDraftWarning('Terminal draft found — send stopped, text moved to top.');
            console.log('[' + runtime.logPrefix + ':draft] send-preflight blocked tab=' + tabId.slice(-12) + ' chars=' + terminalDraft.text.length + ' images=' + terminalDraft.images);
            requestAnimationFrame(() => promptTextareaRef.current?.focus());
            if (terminalDraft.images > 0) {
              setDraftWarning('Terminal draft found — send stopped, text moved to top. Review image placeholders.');
            }
            return;
          }
        } else {
          console.log('[' + runtime.logPrefix + ':draft] send-preflight skipped tab=' + tabId.slice(-12)
            + ' reason=' + (statusAtSend === 'inactive' ? 'auto-launch' : 'busy-midstream'));
        }
        // Image identity belongs only to the editable textarea. Chip bodies
        // may legitimately contain a literal "[Image #1]" copied from logs;
        // treating that literal as an attachment would consume an unrelated
        // image ref or turn it into imageError. Materialize textarea markers
        // first, then serialize prompt/paste chips around that transport text.
        const sourceDraftImages = retainHistoryDraftImages(
          rawDraftSnapshot,
          useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
        );
        const preparedPrompt = await prepareHistoryPromptForSend(rawDraftSnapshot, sourceDraftImages);
        if (!isCurrentAction()) return;
        if (!preparedPrompt.success) {
          const latestText = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
          const latestImages = retainHistoryDraftImages(
            latestText,
            useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
          );
          const latestChips = useUIStore.getState().historyPromptDraftChips[actionTabId] || [];
          const sourceStillCurrent = latestText === rawDraftSnapshot
            && haveSamePromptImageRefs(latestImages, sourceDraftImages)
            && haveSameComposerChips(latestChips, sourceDraftChips);
          if (sourceStillCurrent) {
            setHistoryPromptDraft(actionTabId, rawDraftSnapshot, {
              images: preparedPrompt.images,
              chips: sourceDraftChips,
            });
            setDraftWarning(preparedPrompt.warning || 'Image attachment is not ready.');
          } else {
            setDraftWarning('The draft changed while the image was being checked. Review it and press Send again.');
            console.log('[' + runtime.logPrefix + ':images] materialize stale draft preserved tab=' + actionTabId.slice(-12));
          }
          requestAnimationFrame(() => promptTextareaRef.current?.focus());
          return;
        }
        const sendDraftImages = preparedPrompt.images;
        const sendPayload = serializeComposerDraft({
          text: preparedPrompt.payload,
          chips: sourceDraftChips,
        }).trim();
        const handoffId = createPromptHandoffId();
        const submittedAt = Date.now();
        sendHandoffId = handoffId;
        if (coordinatedSendToken) {
          const bound = bindCoordinatedAgentSendHandoff(
            actionTabId,
            coordinatedSendToken,
            handoffId,
          );
          if (!bound.bound) {
            throw new Error('Send handoff could not be bound to its cancellation owner');
          }
        }
        if (statusAtSend === 'inactive') {
          // Enter is the user's single submit intent. The scenario layer owns
          // Start/Resume + readiness; History only projects that lifecycle
          // immediately so there is never an inert "press Resume first" step.
          setStatusFrom('starting', sessionId ? 'send-auto-resume' : 'send-auto-start');
        }
        historyDiag('SEND_CLICK tab=' + tabId.slice(-12) +
          ' handoff=' + handoffId +
          ' statusAtSend=' + statusAtSend +
          ' chars=' + presentationText.length +
          ' draftChars=' + rawDraftSnapshot.length +
          ' payloadChars=' + sendPayload.length +
          ' draftHash=' + historyOwnerDigest(rawDraftSnapshot) +
          ' textHash=' + historyOwnerDigest(presentationText) +
          ' chips=' + sourceDraftChips.length +
          ' images=' + sendDraftImages.length +
          ' pasteBusy=' + pasteBusyRef.current +
          ' preview="' + promptPreview(presentationText) + '"');
        const promptChipsForHistory = sourceDraftChips
          .filter((chip) => chip.kind === 'prompt')
          .map((chip) => ({ ...chip, kind: 'prompt' as const }));
        beginHistoryPromptHandoff({
          tabId: actionTabId,
          handoffId,
          toolType: runtime.toolType,
          sessionIdHint: sessionId || null,
          text: presentationText,
          promptChips: promptChipsForHistory,
          submittedAt,
          source: 'history-panel',
          statusAtSend,
          requiresAuditIdentity: true,
        });
        onPromptSubmitted(presentationText, 'sending', {
          handoffId,
          statusAtSend,
          submittedAt,
          promptChips: promptChipsForHistory,
          requiresAuditIdentity: true,
        });
        const latestText = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
        const latestImages = retainHistoryDraftImages(
          latestText,
          useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
        );
        const latestChips = useUIStore.getState().historyPromptDraftChips[actionTabId] || [];
        const sourceStillCurrent = latestText === rawDraftSnapshot
          && haveSamePromptImageRefs(latestImages, sourceDraftImages)
          && haveSameComposerChips(latestChips, sourceDraftChips);
        if (sourceStillCurrent) {
          clearedPromptImages = sendDraftImages;
          clearedPromptChips = sourceDraftChips;
          setHistoryPromptDraft(actionTabId, '', { images: [], chips: [] });
          clearedPromptText = rawDraftSnapshot;
        } else {
          const mismatch = latestText !== rawDraftSnapshot
            ? 'text'
            : !haveSamePromptImageRefs(latestImages, sourceDraftImages)
              ? 'images'
              : 'chips';
          console.log('[' + runtime.logPrefix + ':images] send snapshot handed off; newer draft preserved tab='
            + actionTabId.slice(-12)
            + ' mismatch=' + mismatch
            + ' snapshotChars=' + rawDraftSnapshot.length
            + ' latestChars=' + latestText.length
            + ' snapshotHash=' + historyOwnerDigest(rawDraftSnapshot)
            + ' latestHash=' + historyOwnerDigest(latestText));
        }
        setDraftWarning(null);
        const result = await sendAgentPromptScenario({
          tabId,
          toolType: runtime.toolType,
          runtime,
          sessionId,
          cwd,
          prompt: sendPayload,
          handoffId,
          source: 'history-panel',
          statusAtSend,
          queue: statusAtSend === 'busy',
          returnDraftOnConflict: true,
          coordinatedSendToken,
          presentationSnapshot: {
            historySessionId: sessionId || null,
            promptChips: promptChipsForHistory,
          },
        });
        const resultOwnershipTransferred = queueSendTransferredOwnership(result);
        const auditProof = historyPromptHandoffAuditProofFromSendResult(result);
        const lateAuditPending = result?.codexAudit?.lateReconciliationPending === true
          || result?.pasteAudit?.lateReconciliationPending === true;
        const finalAuditFailure = result?.success === false
          && result?.submitted === true
          && !lateAuditPending;
        const effectiveStatusAtSend = result?.effectiveStatusAtSend || statusAtSend;
        const resultQueueStatus: 'queued' | 'sent' = effectiveStatusAtSend === 'busy'
          ? 'queued'
          : 'sent';
        sendAuditIdentity = {
          requiresAuditIdentity: resultOwnershipTransferred,
          auditTimestamp: auditProof?.auditTimestamp,
          auditHash: auditProof?.actualHash,
          auditSessionId: auditProof?.sessionId || undefined,
          auditEntryUuid: auditProof?.entryUuid,
          sourceIdentity: auditProof?.sourceIdentity,
        };
        if (resultOwnershipTransferred) {
          settleHistoryPromptHandoff(actionTabId, handoffId, {
            queueStatus: resultQueueStatus,
            reason: finalAuditFailure
              ? 'send-submitted-audit-unconfirmed'
              : lateAuditPending
                ? 'send-submitted-audit-pending'
                : 'send-result',
            proof: auditProof,
            requiresAuditIdentity: true,
          });
        } else {
          retractHistoryPromptHandoff(actionTabId, handoffId, 'send-refused-before-submit');
        }
        historyDiag('SEND_RESULT tab=' + tabId.slice(-12) +
          ' handoff=' + handoffId +
          ' success=' + (result?.success !== false) +
          ' submitted=' + !!result?.submitted +
          ' chunks=' + (result?.chunksTotal ?? 'na') +
          ' error=' + (result?.error || '-'));
        sendOwnershipTransferred = resultOwnershipTransferred;
        sendDeliveryUnconfirmed = result?.success === false && result?.submitted === true;
        sendRefusalPasteWritten = result?.pasteWritten === true;
        sendTransferredQueueStatus = resultQueueStatus;
        historyDiag('SEND_OWNERSHIP tab=' + tabId.slice(-12) +
          ' handoff=' + handoffId +
          ' transferred=' + sendOwnershipTransferred +
          ' deliveryUnconfirmed=' + sendDeliveryUnconfirmed +
          ' submitted=' + !!result?.submitted +
          ' success=' + (result?.success !== false));
        if (!sendOwnershipTransferred) throw new Error(result?.error || 'Send failed before submit');
        if (!isCurrentAction()) return;
        onPromptStatusChange(
          handoffId,
          sendTransferredQueueStatus,
          sendDeliveryUnconfirmed ? 'send-submitted-unconfirmed' : 'send-result',
          sendAuditIdentity,
        );
        if (sendDeliveryUnconfirmed) {
          setDraftWarning('Prompt was submitted, but delivery confirmation is delayed. It will not be sent again automatically.');
          console.warn('[' + runtime.logPrefix + ':draft] send delivery unconfirmed; ownership kept by terminal tab='
            + actionTabId.slice(-12)
            + ' handoff=' + handoffId
            + ' error=' + (result?.error || '-'));
        }
        midstreamPromptRecoveryRef.current = {
          serializedText: presentationText,
          transportText: sendPayload,
          rawText: rawDraftSnapshot,
          chips: sourceDraftChips,
          images: sendDraftImages,
          at: Date.now(),
          submittedAt,
          handoffId,
          statusAtSend: (effectiveStatusAtSend === 'active' || effectiveStatusAtSend === 'busy')
            ? effectiveStatusAtSend
            : statusAtSend,
        };
        console.log('[' + runtime.logPrefix + ':draft] send tracked tab=' + tabId.slice(-12) + ' handoff=' + handoffId + ' statusAtSend=' + statusAtSend + ' chars=' + presentationText.length + ' chips=' + sourceDraftChips.length);
        const coordinatedAfterSend = getCoordinatedAgentAction(actionTabId);
        if (
          coordinatedAfterSend?.token === coordinatedSendToken
          && coordinatedAfterSend.stopRequestedAt !== null
        ) {
          historyDiag('SEND_STOP_QUEUED tab=' + actionTabId.slice(-12)
            + ' handoff=' + handoffId
            + ' submitted=' + !!result?.submitted
            + ' transferred=' + sendOwnershipTransferred
            + ' queuedAgeMs=' + (Date.now() - coordinatedAfterSend.stopRequestedAt));
        } else if (runtime.optimisticBusyOnSend) {
          setStatusFrom('busy', 'send-click');
        } else {
          setStatusFrom('busy', 'send-confirmed');
          if (effectiveStatusAtSend !== 'active') refreshPresence();
        }
        refreshHistoryWithUpdating('send-result');
      } else if (kind === 'interrupt') {
        const statusAtInterrupt = statusRef.current;
        const pending = midstreamPromptRecoveryRef.current;
        historyDiag('INTERRUPT_CLICK tab=' + tabId.slice(-12) +
          ' status=' + statusAtInterrupt +
          ' pending=' + (pending?.handoffId || '-') +
          ' pendingAgeMs=' + (pending ? Date.now() - pending.at : 0) +
          ' busyAction=' + (busyAction || 'none'));
        const result = runtime.interruptTurn(tabId);
        historyDiag('INTERRUPT_RESULT tab=' + tabId.slice(-12) +
          ' success=' + !!result.success +
          ' interrupted=' + !!result.interrupted +
          ' pending=' + (pending?.handoffId || '-') +
          ' error=' + (result.error || '-'));
        if (!result.success) throw new Error(result.error || 'Stop failed');
        if (result.interrupted && isCurrentAction()) {
          if (statusAtInterrupt === 'busy') {
            interruptAwaitRef.current = { tabId: actionTabId, seq: actionSeq, at: Date.now() };
            setInterruptAwaiting(true);
            setDraftWarning(null);
            console.log('[' + runtime.logPrefix + ':draft] interrupt-await start tab=' + tabId.slice(-12) + ' status=' + statusAtInterrupt);
            setTimeout(() => {
              if (tabIdRef.current === actionTabId && interruptAwaitRef.current?.seq === actionSeq) {
                refreshPresence();
              }
            }, 700);
          } else if (runtime.optimisticActiveOnInterrupt) {
            setStatusFrom('active', 'interrupt-click');
          } else {
            refreshPresence();
          }
        }
      } else if (kind === 'stop') {
        processStopInFlightRef.current = true;
        presenceGenerationRef.current += 1;
        setStatusFrom('stopping', 'stop-process-click-start');
        const result = await runtime.stopProcess(tabId);
        if (!isCurrentAction()) return;
        if (result?.success === false) throw new Error(result?.error || 'Stop failed');
        presenceGenerationRef.current += 1;
        pasteBusyRef.current = false;
        setIsPasteBusy(false);
        setStatusFrom('inactive', 'stop-process-click');
      }
    } catch (e: any) {
      const currentAction = isCurrentAction();
      if (!currentAction && kind !== 'send') {
        console.log('[' + runtime.logPrefix + '] stale action error ignored tab=' + actionTabId.slice(-12)
          + ' kind=' + kind + ' actionSeq=' + actionSeq + ' currentSeq=' + actionSeqRef.current);
        return;
      }
      if (kind === 'send' && sendHandoffId) {
        if (sendOwnershipTransferred) {
          onPromptStatusChange(
            sendHandoffId,
            sendTransferredQueueStatus,
            'send-post-transfer-error',
            sendAuditIdentity,
          );
          historyDiag('SEND_POST_TRANSFER_ERROR tab=' + actionTabId.slice(-12) +
            ' handoff=' + sendHandoffId +
            ' deliveryUnconfirmed=' + sendDeliveryUnconfirmed +
            ' error=' + String(e?.message || e));
        } else {
          retractHistoryPromptHandoff(actionTabId, sendHandoffId, 'send-pre-submit-error');
          onPromptStatusChange(sendHandoffId, 'failed', 'send-pre-submit-error');
        }
        if (!sendOwnershipTransferred) {
          if (sendRefusalPasteWritten) {
            deferredSendRollback = true;
            historyDiag('SEND_ROLLBACK_DEFER tab=' + actionTabId.slice(-12)
              + ' handoff=' + sendHandoffId
              + ' reason=paste-written-awaiting-stop-proof');
          } else {
            restoreClearedSendSnapshot('pre-paste-refusal');
          }
        }
      }
      if (currentAction) {
        setError(String(e?.message || e));
        if (kind === 'stop') {
          processStopInFlightRef.current = false;
          presenceGenerationRef.current += 1;
        }
        refreshPresence();
      }
    } finally {
      const keepInterruptAwait =
        kind === 'interrupt' &&
        isCurrentAction() &&
        interruptAwaitRef.current?.seq === actionSeq;
      if (isCurrentAction() && !keepInterruptAwait) {
        actionInFlightRef.current = false;
        activeActionKindRef.current = null;
        if (kind === 'stop') processStopInFlightRef.current = false;
        setBusyAction(null);
      }
      if (kind === 'send' && coordinatedSendToken) {
        const coordinatedSettlement = await settleCoordinatedAgentSend({
          tabId: actionTabId,
          token: coordinatedSendToken,
          runQueuedStop: async () => {
            const queuedStop = getCoordinatedAgentAction(actionTabId);
            historyDiag('RUN_QUEUED_ACTION tab=' + actionTabId.slice(-12)
              + ' kind=stop after=send'
              + ' queuedAgeMs=' + (
                queuedStop?.stopRequestedAt
                  ? Date.now() - queuedStop.stopRequestedAt
                  : 0
              ));
            return await stopAgentProcessScenario({
              tabId: actionTabId,
              toolType: runtime.toolType,
              runtime,
            });
          },
        });
        if (deferredSendRollback) {
          if (coordinatedSettlement.stopped) {
            restoreClearedSendSnapshot('post-paste-stop-proved');
          } else {
            historyDiag('SEND_ROLLBACK_WITHHELD tab=' + actionTabId.slice(-12)
              + ' handoff=' + (sendHandoffId || '-')
              + ' reason=stop-not-proved'
              + ' settlement=' + (coordinatedSettlement.reason || '-'));
            if (isCurrentAction()) {
              setDraftWarning('Send was cancelled after paste, but process stop was not proven. The prompt was not restored to avoid sending it twice.');
            }
          }
        }
        if (sendHandoffId) {
          await ipcRenderer.invoke('agent:clear-send-cancel', {
            tabId: actionTabId,
            handoffId: sendHandoffId,
          }).catch(() => null);
        }
      }
    }
  }, [busyAction, cwd, onPromptStatusChange, onPromptSubmitted, prepareHistoryPromptForSend, prompt, readTerminalDraft, refreshHistoryWithUpdating, refreshPresence, resumeMaterialized, runtime, sessionId, setHistoryPromptDraft, setStatusFrom, tabId]);

  useEffect(() => {
    const submitComposer = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId !== tabId) return;
      void runAction('send');
    };
    window.addEventListener('history-panel:submit-composer', submitComposer);
    return () => window.removeEventListener('history-panel:submit-composer', submitComposer);
  }, [runAction, tabId]);

  useEffect(() => {
    const interruptTurn = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId !== tabId) return;
      void runAction('interrupt');
    };
    window.addEventListener('history-panel:interrupt-turn', interruptTurn);
    return () => window.removeEventListener('history-panel:interrupt-turn', interruptTurn);
  }, [runAction, tabId]);

  useEffect(() => {
    const stopProcess = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId !== tabId) return;
      void runAction('stop');
    };
    window.addEventListener('history-panel:stop-process', stopProcess);
    return () => window.removeEventListener('history-panel:stop-process', stopProcess);
  }, [runAction, tabId]);

  useEffect(() => {
    const pullDraft = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId !== tabId) return;
      void pullTerminalDraft();
    };
    window.addEventListener('history-panel:pull-terminal-draft', pullDraft);
    return () => window.removeEventListener('history-panel:pull-terminal-draft', pullDraft);
  }, [pullTerminalDraft, tabId]);

  const answerPendingQuestion = useCallback(async (answers: Record<string, string>, stop = false) => {
    if (!runtime.answerQuestion) return;
    if (answeringQuestionRef.current) {
      console.log('[ClaudeHistoryQuestion] drop-answer tab=' + tabId.slice(-12) + ' reason=inflight stop=' + stop);
      return;
    }
    let pending = pendingQuestionRef.current;
    if (!pending) {
      pending = await refreshPendingQuestion('answer-missing-pending');
    }
    if (!pending) {
      setQuestionError('No pending question');
      console.warn('[ClaudeHistoryQuestion] no-pending tab=' + tabId.slice(-12) + ' stop=' + stop);
      return;
    }

    const actionTabId = tabId;
    answeringQuestionRef.current = true;
    setAnsweringQuestion(true);
    setQuestionError(null);
    console.log('[ClaudeHistoryQuestion] answer-start tab=' + tabId.slice(-12) + ' source=' + pending.source + ' stop=' + stop + ' answers=' + Object.keys(answers || {}).length);
    try {
      const result = await runtime.answerQuestion({ tabId, pendingQuestion: pending, answers, stop });
      if (result?.success === false) throw new Error(result?.error || result?.reason || 'Question answer failed');
      if (tabIdRef.current !== actionTabId) return;
      setPendingQuestionFrom(null, stop ? 'respond-manually' : 'answered');
      if (!stop) setStatusFrom('busy', 'question-answered');
      refreshHistoryWithUpdating('question-answer');
    } catch (e: any) {
      if (tabIdRef.current === actionTabId) {
        const message = String(e?.message || e);
        setQuestionError(message);
        console.warn('[ClaudeHistoryQuestion] answer-failed tab=' + tabId.slice(-12) + ': ' + message);
        refreshPendingQuestion('answer-error');
      }
    } finally {
      if (tabIdRef.current === actionTabId) setAnsweringQuestion(false);
      answeringQuestionRef.current = false;
    }
  }, [refreshHistoryWithUpdating, refreshPendingQuestion, runtime, setPendingQuestionFrom, setStatusFrom, tabId]);

  const meta = AGENT_STATUS_META[status];
  const rawActiveLifecycle = lifecycleStatus?.tabId === tabId ? lifecycleStatus : null;
  const localStopInProgress = busyAction === 'stop' || status === 'stopping';
  const effectiveStopping = localStopInProgress || rawActiveLifecycle?.kind === 'stopping';
  const activeLifecycle: AgentLifecycleSummary | null = effectiveStopping
    ? (rawActiveLifecycle?.kind === 'stopping'
      ? rawActiveLifecycle
      : {
        tabId,
        sessionId: sessionId || null,
        kind: 'stopping',
        title: `STOPPING ${runtime.label.toUpperCase()}...`,
        description: 'Waiting for the process to exit safely',
        detail: 'manual-stop',
        spinner: true,
      })
    : rawActiveLifecycle;
  const isTurnBusy = status === 'busy';
  const controlsLocked = !!busyAction || isPasteBusy || answeringQuestion || rewindLocked || effectiveStopping;
  const isCancellingTurn = busyAction === 'interrupt' || interruptAwaiting;
  const isCompacting = operationalPhase?.tabId === tabId
    && operationalPhase.provider === toolType
    && operationalPhase.active === true
    && operationalPhase.phase === 'compacting';
  const rewindStatusMeta = useMemo(() => {
    if (!rewindLocked) return null;
    switch (rewindPhase) {
      case 'compacting':
        return {
          title: 'COMPACTING',
          description: rewindMessage || 'Preparing a compacted history for Rewind',
          placeholder: 'Compacting... input is locked',
        };
      case 'preparing':
        return {
          title: 'PREPARING REWIND',
          description: rewindMessage || 'Preparing Rewind',
          placeholder: 'Preparing Rewind... input is locked',
        };
      case 'cancelling':
        return {
          title: 'CANCELLING REWIND',
          description: rewindMessage || 'Waiting for Rewind cancellation confirmation',
          placeholder: 'Cancelling Rewind... input is locked',
        };
      case 'committing':
        return {
          title: 'FINISHING REWIND',
          description: rewindMessage || 'Rewind is applying its durable result',
          placeholder: 'Finishing Rewind... input is locked',
        };
      case 'pasting':
      case 'rewinding':
      default:
        return {
          title: 'REWINDING',
          description: rewindMessage || runtime.label + ' rewind is running',
          placeholder: 'Rewinding... input is locked',
        };
    }
  }, [rewindLocked, rewindMessage, rewindPhase, runtime.label]);
  const showRewindingChip = !!rewindStatusMeta && !pendingQuestion;
  const showUpdatingChip = historyUpdating
    && !effectiveStopping
    && status !== 'inactive'
    && !isTurnBusy
    && !isCancellingTurn
    && !pendingQuestion
    && !rewindLocked;
  const derivedDraftWarning = useMemo(
    () => historyDraftImageWarning(toolType, prompt, draftImages),
    [draftImages, prompt, toolType]
  );
  const historyImagePastePending = prompt.includes(HISTORY_IMAGE_PENDING_MARKER);
  const promptImageMarkerRanges = useMemo(
    () => getPromptImageMarkerHighlightRanges(prompt, draftImages) as Array<{ start: number; end: number; id: number }>,
    [draftImages, prompt],
  );
  const promptPasteMarkerRanges = useMemo(
    () => getPasteMarkerHighlightRanges(prompt, draftChips) as Array<{ start: number; end: number; id: string }>,
    [draftChips, prompt],
  );
  const draftImagePreviewUrls = useComposerImagePreviews(draftImages);
  const promptComposerTokens = useMemo<ComposerInlineToken[]>(() => {
    const refsById = new Map(draftImages.map((ref) => [Number(ref.id), ref]));
    const result: ComposerInlineToken[] = [
      ...promptImageMarkerRanges.map((range) => ({
        id: `image:${range.id}:${range.start}`,
        from: range.start,
        to: range.end,
        kind: 'image' as const,
        label: 'image',
        thumbnailUrl: composerImageUrl(refsById.get(range.id), draftImagePreviewUrls),
      })),
      ...promptPasteMarkerRanges.map((range) => ({
        id: `paste:${range.id}`,
        from: range.start,
        to: range.end,
        kind: 'paste' as const,
        label: prompt.slice(range.start + 1, Math.max(range.start + 1, range.end - 1)),
      })),
    ];
    const statusPattern = /\[Image saving…\]|\[(?:imagePath|imageError):[^\]\r\n]+\]/gi;
    let match: RegExpExecArray | null;
    while ((match = statusPattern.exec(prompt)) !== null) {
      result.push({
        id: `status:${match.index}`,
        from: match.index,
        to: match.index + match[0].length,
        kind: match[0] === HISTORY_IMAGE_PENDING_MARKER ? 'pending' : 'error',
        label: match[0],
        replace: false,
      });
    }
    return result;
  }, [draftImagePreviewUrls, draftImages, prompt, promptImageMarkerRanges, promptPasteMarkerRanges]);
  const previewedDraftImageRange = useMemo(() => (
    previewChipId
      ? promptImageMarkerRanges.find((range) => (
          `image:${range.id}:${range.start}` === previewChipId
        ))
      : undefined
  ), [previewChipId, promptImageMarkerRanges]);
  const previewedDraftImageRef = useMemo(() => (
    previewedDraftImageRange
      ? draftImages.find((ref) => Number(ref.id) === Number(previewedDraftImageRange.id))
      : undefined
  ), [draftImages, previewedDraftImageRange]);
  const draftImageDetailPreview = useComposerImagePreview(previewedDraftImageRef, 'detail');

  useEffect(() => {
    if (!previewChipId) return;
    const hasChip = draftChips.some((chip) => chip.id === previewChipId);
    const hasImage = promptImageMarkerRanges.some((range) => (
      `image:${range.id}:${range.start}` === previewChipId
    ));
    if (!hasChip && !hasImage) setPreviewChipId(null);
  }, [draftChips, previewChipId, promptImageMarkerRanges]);
  const canStartFresh = status === 'inactive' && !effectiveStopping && !sessionId && !!runtime.startFresh && !busyAction;
  const canResume = status === 'inactive' && !effectiveStopping && !!sessionId && (runtime.toolType !== 'claude' || resumeMaterialized === true) && !busyAction;
  const canStartOrResume = canStartFresh || canResume;
  const canAcceptPrompt = status === 'active'
    || (status === 'busy' && runtime.allowSendWhileBusy)
    || canStartOrResume;
  const canAcceptSubmitIntent = canAcceptPrompt
    && !pendingQuestion
    && !controlsLocked
    && !historyImagePastePending
    && !derivedDraftWarning;
  const terminalOnlySlashDraft = isTerminalOnlyComposerDraft(prompt);
  const canSend = canAcceptSubmitIntent
    && !terminalOnlySlashDraft
    && (prompt.trim().length > 0 || draftChips.length > 0);
  const canGrabDraft = (status === 'active' || status === 'busy') && !pendingQuestion && !controlsLocked;
  const canInterruptTurn = isTurnBusy && !controlsLocked;
  const canStopProcess = busyAction === 'send'
    || ((status === 'active' || status === 'busy' || status === 'starting')
      && !effectiveStopping
      && !busyAction);
  const visibleDraftWarning = draftWarning || derivedDraftWarning;
  const draftNoticeMeta = visibleDraftWarning ? getDraftNoticeMeta(visibleDraftWarning) : null;
  // Attachment problems are NOT terminal status. Sitting next to the terminal
  // icon and the agent lifecycle, an image warning reads as "the terminal
  // broke"; it also stayed pinned there long after the user moved on. Image
  // notices are announced once as a toast instead, and the status row keeps
  // only agent state. Non-image draft notices (locked input, restored prompt)
  // remain inline — they describe the field the user is looking at.
  const isImageDraftNotice = draftNoticeMeta?.label === 'Image needs attention'
    || draftNoticeMeta?.label === 'Attaching image';
  // "Saving image attachment…" is PROGRESS, not a problem: it appears for the
  // fraction of a second between the paste and the file landing on disk, and it
  // clears itself. Announcing it as a warning toast put an orange ⚠ in the
  // corner of a perfectly normal paste — the exact false alarm the user hit.
  const isImageProgressNotice = draftNoticeMeta?.label === 'Attaching image';
  const inlineDraftNoticeMeta = isImageDraftNotice ? null : draftNoticeMeta;
  const announcedImageNoticeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isImageDraftNotice || isImageProgressNotice || !visibleDraftWarning) {
      announcedImageNoticeRef.current = null;
      return;
    }
    // One toast per distinct message: the derived warning recomputes on every
    // keystroke, and re-announcing it would spam the corner while typing.
    if (announcedImageNoticeRef.current === visibleDraftWarning) return;
    announcedImageNoticeRef.current = visibleDraftWarning;
    useUIStore.getState().showToast(visibleDraftWarning, 'warning', 5000);
  }, [isImageDraftNotice, isImageProgressNotice, visibleDraftWarning]);

  useLayoutEffect(() => {
    const ownerId = availabilityOwnerRef.current;
    if (!agentInputSurface) {
      setHistoryComposerAvailability(tabId, null, ownerId);
      return;
    }
    setHistoryComposerAvailability(tabId, {
      ownerId,
      canSend,
      canAcceptSubmitIntent,
      canInterruptTurn,
      canPullDraft: canGrabDraft,
      status,
      lifecycleGeneration: processLifecycleGeneration,
      canStopProcess,
    }, ownerId);
    historyDiag('COMPOSER_AVAILABILITY tab=' + tabId.slice(-12) +
      ' status=' + status +
      ' send=' + (canSend ? '1' : '0') +
      ' acceptSubmit=' + (canAcceptSubmitIntent ? '1' : '0') +
      ' interrupt=' + (canInterruptTurn ? '1' : '0') +
      ' pull=' + (canGrabDraft ? '1' : '0'));
  }, [
    canGrabDraft,
    canAcceptSubmitIntent,
    canInterruptTurn,
    canSend,
    canStopProcess,
    agentInputSurface,
    processLifecycleGeneration,
    setHistoryComposerAvailability,
    status,
    tabId,
  ]);

  useEffect(() => {
    const ownerId = availabilityOwnerRef.current;
    return () => setHistoryComposerAvailability(tabId, null, ownerId);
  }, [setHistoryComposerAvailability, tabId]);

  useEffect(() => {
    // A shown terminal owns Escape only while it is the surface the user types
    // into. In terminal-primary it is always shown, yet the typing happens in
    // this side panel — gating on terminalOpen alone would kill Escape there
    // for good.
    const terminalOwnsEscape = terminalOpen && !terminalIsPrimary;
    if (!agentInputSurface || terminalOwnsEscape || pendingQuestion || !canInterruptTurn) return;
    const interruptOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      // Menus/search/modals own Escape first. Their capture handlers normally
      // stop the event before this bubble listener; the DOM guard also covers
      // portal menus whose handler is mounted later in the tree.
      if (document.querySelector([
        '[data-history-insert-menu-root]',
        '[data-history-insert-menu-scripts]',
        '[data-timeline-context-menu]',
        '[data-run-after-picker-menu]',
        '[data-task-plan-status-menu]',
        '[data-task-plan-action-menu]',
        '[aria-modal="true"]',
      ].join(','))) return;
      event.preventDefault();
      event.stopPropagation();
      historyDiag('ESCAPE_INTERRUPT tab=' + tabId.slice(-12) + ' source=history-main');
      void runAction('interrupt');
    };
    // Bubble phase is deliberate: search and popup capture handlers get first
    // refusal. Escape reaches the turn interrupt only when no higher-priority
    // surface claimed it.
    window.addEventListener('keydown', interruptOnEscape);
    return () => window.removeEventListener('keydown', interruptOnEscape);
  }, [canInterruptTurn, agentInputSurface, pendingQuestion, runAction, tabId, terminalOpen, terminalIsPrimary]);

  useEffect(() => {
    const insertIntoComposer = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        text?: string;
        source?: string;
        kind?: HistoryPromptDraftChip['kind'];
        label?: string;
        sourceKey?: string;
      }>).detail;
      if (detail?.tabId !== tabId) return;
      // A cancelable composer event uses preventDefault as its synchronous
      // handled acknowledgement. Claim it before lock checks so the picker
      // never bypasses a mounted composer's lock via its persistent fallback.
      if (event.defaultPrevented) return;
      event.preventDefault();
      const text = String(detail.text || '');
      if (!text) return;
      if (isCancellingTurn || rewindLocked || effectiveStopping) {
        setDraftWarning('History input is temporarily locked');
        return;
      }

      const insertAsPromptChip = detail.kind === 'prompt' || detail.source === 'prompt-picker';
      if (insertAsPromptChip) {
        const currentText = useUIStore.getState().historyPromptDrafts[tabId] || '';
        const currentChips = useUIStore.getState().historyPromptDraftChips[tabId] || [];
        const chip: HistoryPromptDraftChip = {
          id: createComposerChipId('prompt'),
          kind: 'prompt',
          text,
          label: detail.label || 'Prompt',
          sourceKey: detail.sourceKey,
          createdAt: Date.now(),
        };
        const nextChips = upsertComposerChip(currentChips, chip) as HistoryPromptDraftChip[];
        setHistoryPromptDraft(tabId, currentText, {
          preserveImages: true,
          chips: nextChips,
        });
        requestAnimationFrame(() => promptTextareaRef.current?.focus());
        return;
      }

      const element = promptTextareaRef.current;
      const current = useUIStore.getState().historyPromptDrafts[tabId] || '';
      const start = element
        ? Math.max(0, Math.min(element.selectionStart ?? current.length, current.length))
        : current.length;
      const end = element
        ? Math.max(start, Math.min(element.selectionEnd ?? start, current.length))
        : start;
      const next = current.slice(0, start) + text + current.slice(end);
      setPrompt(next, {
        images: retainHistoryDraftImages(
          next,
          useUIStore.getState().historyPromptDraftImages[tabId] || [],
        ),
        preserveChips: true,
      });
      const caret = start + text.length;
      requestAnimationFrame(() => {
        const currentElement = promptTextareaRef.current;
        if (!currentElement) return;
        currentElement.focus();
        currentElement.setSelectionRange(caret, caret);
      });
    };
    window.addEventListener('history-panel:composer-insert', insertIntoComposer);
    return () => window.removeEventListener('history-panel:composer-insert', insertIntoComposer);
  }, [effectiveStopping, isCancellingTurn, rewindLocked, setHistoryPromptDraft, setPrompt, tabId]);

  // Clipboard export is one authoring-level operation for both attachment
  // families. Images leave as portable absolute paths; a complete Pasted
  // Content anchor expands to its exact hidden body. Doing both in one source-
  // range pass prevents a literal `[Image #1]` inside the hidden paste body
  // from accidentally consuming a visible attachment.
  const handleComposerImageAwareCopy = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    if (start === end) return;
    const result = buildComposerClipboardText({
      text: element.value,
      selectionStart: start,
      selectionEnd: end,
      chips: draftChips,
      imagePaths: draftImages,
    });
    if (!result.handled) return;
    event.preventDefault();
    if (event.type === 'cut' && !(isCancellingTurn || rewindLocked || effectiveStopping)) {
      const nextText = element.value.slice(0, start) + element.value.slice(end);
      setPrompt(nextText, {
        images: retainHistoryDraftImages(
          nextText,
          useUIStore.getState().historyPromptDraftImages[tabId] || [],
        ),
        chips: retainPasteChipsForText(
          nextText,
          useUIStore.getState().historyPromptDraftChips[tabId] || [],
        ) as HistoryPromptDraftChip[],
      });
      promptCaretRef.current = { start, end: start };
    }
    clipboard.writeText(result.text);
    if (result.imagePartial > 0 || result.imageMissing > 0) {
      setDraftWarning('Image marker is damaged or has no matching attachment. An imageError marker was copied instead.');
    } else if (result.pasteMissing > 0) {
      setDraftWarning('Pasted Content marker has no matching stored text. A pasteError marker was copied instead.');
    }
    console.log('[' + runtime.logPrefix + ':clipboard] composer-export tab=' + tabId.slice(-12)
      + ' type=' + event.type
      + ' images=' + result.imageResolved
      + ' imageMissing=' + result.imageMissing
      + ' imagePartial=' + result.imagePartial
      + ' pastes=' + result.pasteExpanded
      + ' pasteMissing=' + result.pasteMissing);
  }, [draftChips, draftImages, effectiveStopping, isCancellingTurn, rewindLocked, runtime.logPrefix, setPrompt, tabId]);

  const handleComposerImagePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const hasImageItem = Array.from(event.clipboardData?.items || [])
      .some((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'));
    if (!hasImageItem) {
      const pastedText = event.clipboardData?.getData('text/plain') || '';
      const portableMarkers = collectPortableImagePathMarkers(pastedText);
      if (portableMarkers.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        if (isCancellingTurn || rewindLocked || effectiveStopping) {
          setDraftWarning('History input is temporarily locked');
          return;
        }

        const actionTabId = tabId;
        const element = event.currentTarget;
        const current = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
        if (current.includes(HISTORY_IMAGE_PENDING_MARKER)) {
          setDraftWarning('Wait for the current image to finish saving.');
          return;
        }
        const start = Math.max(0, Math.min(element.selectionStart ?? current.length, current.length));
        const end = Math.max(start, Math.min(element.selectionEnd ?? start, current.length));
        const currentImages = useUIStore.getState().historyPromptDraftImages[actionTabId] || [];
        const currentChips = useUIStore.getState().historyPromptDraftChips[actionTabId] || [];
        const pendingText = current.slice(0, start) + HISTORY_IMAGE_PENDING_MARKER + current.slice(end);
        const pendingChips = retainPasteChipsForText(pendingText, currentChips) as HistoryPromptDraftChip[];
        setHistoryPromptDraft(actionTabId, pendingText, {
          images: retainHistoryDraftImages(pendingText, currentImages),
          chips: pendingChips,
        });
        const pendingCaret = start + HISTORY_IMAGE_PENDING_MARKER.length;
        promptCaretRef.current = { start: pendingCaret, end: pendingCaret };
        requestAnimationFrame(() => {
          const textarea = promptTextareaRef.current;
          if (!textarea || textarea.getAttribute('data-history-composer-tab-id') !== actionTabId) return;
          textarea.focus();
          textarea.setSelectionRange(pendingCaret, pendingCaret);
        });

        console.log('[' + runtime.logPrefix + ':images] path-import start tab=' + actionTabId.slice(-12)
          + ' markers=' + portableMarkers.length);
        void ipcRenderer.invoke('prompt-queue:materialize-image-refs', {
          refs: portableMarkers.map((marker) => ({
            id: marker.id,
            path: marker.path,
            size: 0,
          })),
        }).then((materialized: { refs?: HistoryPromptDraftImageRef[] }) => {
          const latest = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
          const tokenStart = latest.indexOf(HISTORY_IMAGE_PENDING_MARKER);
          if (tokenStart < 0) {
            console.log('[' + runtime.logPrefix + ':images] path-import dropped tab=' + actionTabId.slice(-12)
              + ' reason=pending-marker-removed');
            return;
          }
          const sourceSnapshot = buildPortableImageImportSnapshot(pastedText, materialized?.refs || []);
          const snapshot = collapsePortableImageImportSnapshot({
            ...sourceSnapshot,
            threshold: aiComposerChipThreshold,
            createChipId: () => createComposerChipId('paste'),
          });
          const currentRefs = useUIStore.getState().historyPromptDraftImages[actionTabId] || [];
          const imageInsertion = insertPromptImageAttachments({
            text: latest,
            imagePaths: currentRefs,
            start: tokenStart,
            end: tokenStart + HISTORY_IMAGE_PENDING_MARKER.length,
            insertedText: snapshot.text,
            insertedImagePaths: snapshot.imagePaths,
          });
          if (imageInsertion.missingSourceIds.length > 0) {
            throw new Error('portable_image_identity_missing');
          }
          const remappedInsertedText = imageInsertion.text.slice(tokenStart, imageInsertion.caret);
          const composerInsertion = insertComposerSnapshotAtSelection({
            text: latest,
            chips: useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
            insertedText: remappedInsertedText,
            insertedChips: snapshot.chips,
            selectionStart: tokenStart,
            selectionEnd: tokenStart + HISTORY_IMAGE_PENDING_MARKER.length,
          });
          setHistoryPromptDraft(actionTabId, composerInsertion.text, {
            images: retainHistoryDraftImages(composerInsertion.text, imageInsertion.imagePaths),
            chips: composerInsertion.chips,
          });
          if (tabIdRef.current === actionTabId) {
            setDraftWarning(sourceSnapshot.missing > 0
              ? 'One or more image files are unavailable. Missing paths were replaced with imageError.'
              : null);
          }
          console.log('[' + runtime.logPrefix + ':images] path-import ready tab=' + actionTabId.slice(-12)
            + ' imported=' + sourceSnapshot.imported
            + ' missing=' + sourceSnapshot.missing
            + ' pasteChips=' + snapshot.chips.length);

          const textarea = promptTextareaRef.current;
          const preserveSelection = textarea?.isFocused() === true
            && textarea?.getAttribute('data-history-composer-tab-id') === actionTabId;
          if (preserveSelection) {
            const selectionStart = textarea?.selectionStart ?? pendingCaret;
            const selectionEnd = textarea?.selectionEnd ?? selectionStart;
            const remappedSelection = remapPromptImageSelectionAfterReplacement({
              selectionStart,
              selectionEnd,
              replacedStart: tokenStart,
              replacedEnd: tokenStart + HISTORY_IMAGE_PENDING_MARKER.length,
              insertionCaret: composerInsertion.caret,
            });
            promptCaretRef.current = remappedSelection;
            requestAnimationFrame(() => {
              const currentTextarea = promptTextareaRef.current;
              if (!currentTextarea?.isFocused()) return;
              currentTextarea.setSelectionRange(remappedSelection.start, remappedSelection.end);
            });
          }
        }).catch((cause: any) => {
          const latest = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
          if (!latest.includes(HISTORY_IMAGE_PENDING_MARKER)) return;
          const failedText = latest.replace(
            HISTORY_IMAGE_PENDING_MARKER,
            '[imageError: portable_image_import_failed]',
          );
          setHistoryPromptDraft(actionTabId, failedText, {
            images: retainHistoryDraftImages(
              failedText,
              useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
            ),
            chips: retainPasteChipsForText(
              failedText,
              useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
            ) as HistoryPromptDraftChip[],
          });
          if (tabIdRef.current === actionTabId) {
            setDraftWarning('Could not import the image paths. Missing paths were replaced with imageError.');
          }
          console.warn('[' + runtime.logPrefix + ':images] path-import failed tab=' + actionTabId.slice(-12)
            + ' error=' + String(cause?.message || cause));
        });
        return;
      }
      // Dictated speech is not an attachment. It is what the user just said and
      // wants to keep editing, so collapsing it into a chip hides their own
      // words behind a click — length is the wrong signal here. Voice Record
      // marks its clipboard payload, and a marked paste always goes in as plain
      // text regardless of size.
      if (isDictationClipboardPayload(event.clipboardData)) return;
      if (!shouldCreatePasteChip(pastedText, aiComposerChipThreshold)) return;
      event.preventDefault();
      event.stopPropagation();
      if (isCancellingTurn || rewindLocked || effectiveStopping) {
        setDraftWarning('History input is temporarily locked');
        return;
      }
      const element = event.currentTarget;
      const currentText = useUIStore.getState().historyPromptDrafts[tabId] || '';
      const start = Math.max(0, Math.min(element.selectionStart ?? currentText.length, currentText.length));
      const end = Math.max(start, Math.min(element.selectionEnd ?? start, currentText.length));
      const currentChips = useUIStore.getState().historyPromptDraftChips[tabId] || [];
      const chip: HistoryPromptDraftChip = {
        id: createComposerChipId('paste'),
        kind: 'paste',
        text: pastedText,
        label: 'Вставка',
        createdAt: Date.now(),
      };
      // The blob lands AT THE CARET as an inline marker, so the sentence keeps
      // reading `текст [Pasted Content N chars] ещё текст`. Previously the text
      // was only cut and the chip appeared on a strip above the field, which
      // detached it from the place the user pasted into.
      const marker = buildPasteChipMarker(chip);
      const insertion = insertComposerSnapshotAtSelection({
        text: currentText,
        chips: currentChips,
        insertedText: marker,
        insertedChips: [chip],
        selectionStart: start,
        selectionEnd: end,
      });
      setHistoryPromptDraft(tabId, insertion.text, {
        images: retainHistoryDraftImages(
          insertion.text,
          useUIStore.getState().historyPromptDraftImages[tabId] || [],
        ),
        chips: insertion.chips,
      });
      const caretAfterMarker = insertion.caret;
      promptCaretRef.current = { start: caretAfterMarker, end: caretAfterMarker };
      requestAnimationFrame(() => {
        const textarea = promptTextareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(caretAfterMarker, caretAfterMarker);
      });
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (isCancellingTurn || rewindLocked || effectiveStopping) {
      setDraftWarning('History input is temporarily locked');
      return;
    }

    const actionTabId = tabId;
    const element = event.currentTarget;
    const current = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
    if (current.includes(HISTORY_IMAGE_PENDING_MARKER)) {
      setDraftWarning('Wait for the current image to finish saving.');
      return;
    }
    const start = Math.max(0, Math.min(element.selectionStart ?? current.length, current.length));
    const end = Math.max(start, Math.min(element.selectionEnd ?? start, current.length));
    const pendingText = current.slice(0, start) + HISTORY_IMAGE_PENDING_MARKER + current.slice(end);
    const currentImages = useUIStore.getState().historyPromptDraftImages[actionTabId] || [];
    const currentChips = useUIStore.getState().historyPromptDraftChips[actionTabId] || [];
    const pendingChips = retainPasteChipsForText(pendingText, currentChips) as HistoryPromptDraftChip[];
    setHistoryPromptDraft(actionTabId, pendingText, {
      images: retainHistoryDraftImages(pendingText, currentImages),
      chips: pendingChips,
    });
    // Saving normally takes a fraction of a second. Do not turn that normal
    // progress into a warning-looking status; only actual failures surface.
    setDraftWarning(null);
    const pendingCaret = start + HISTORY_IMAGE_PENDING_MARKER.length;
    promptCaretRef.current = { start: pendingCaret, end: pendingCaret };
    requestAnimationFrame(() => {
      const textarea = promptTextareaRef.current;
      if (!textarea || textarea.getAttribute('data-history-composer-tab-id') !== actionTabId) return;
      textarea.focus();
      textarea.setSelectionRange(pendingCaret, pendingCaret);
    });

    console.log('[' + runtime.logPrefix + ':images] clipboard-save start tab=' + actionTabId.slice(-12));
    void ipcRenderer.invoke('prompt-queue:save-clipboard-image', { tabId: actionTabId })
      .then((saved: HistoryPromptDraftImageRef & { success?: boolean }) => {
        const latest = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
        const tokenStart = latest.indexOf(HISTORY_IMAGE_PENDING_MARKER);
        if (tokenStart < 0) {
          console.log('[' + runtime.logPrefix + ':images] clipboard-save dropped tab=' + actionTabId.slice(-12) + ' reason=pending-marker-removed');
          return;
        }
        const textarea = promptTextareaRef.current;
        const preserveSelection = textarea?.isFocused() === true
          && textarea?.getAttribute('data-history-composer-tab-id') === actionTabId;
        const selectionStart = preserveSelection ? (textarea?.selectionStart ?? 0) : 0;
        const selectionEnd = preserveSelection ? (textarea?.selectionEnd ?? selectionStart) : 0;

        if (saved?.success !== true || !saved.path) {
          const errorMarker = '[imageError: clipboard_image_save_failed]';
          const failedText = latest.slice(0, tokenStart)
            + errorMarker
            + latest.slice(tokenStart + HISTORY_IMAGE_PENDING_MARKER.length);
          setHistoryPromptDraft(actionTabId, failedText, {
            images: retainHistoryDraftImages(
              failedText,
              useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
            ),
            chips: retainPasteChipsForText(
              failedText,
              useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
            ) as HistoryPromptDraftChip[],
          });
          if (tabIdRef.current === actionTabId) {
            setDraftWarning('Could not save the clipboard image. Copy it again and retry.');
          }
          console.warn('[' + runtime.logPrefix + ':images] clipboard-save failed tab=' + actionTabId.slice(-12)
            + ' error=' + String(saved?.error || 'unknown'));
          return;
        }

        const insertion = insertPromptImageAttachments({
          text: latest,
          imagePaths: useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
          start: tokenStart,
          end: tokenStart + HISTORY_IMAGE_PENDING_MARKER.length,
          insertedText: '[Image #0] ',
          insertedImagePaths: [{ ...saved, id: 0 }],
        });
        if (insertion.missingSourceIds.length > 0) {
          throw new Error('saved_image_identity_missing');
        }
        setHistoryPromptDraft(actionTabId, insertion.text, {
          images: insertion.imagePaths,
          chips: retainPasteChipsForText(
            insertion.text,
            useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
          ) as HistoryPromptDraftChip[],
        });
        if (tabIdRef.current === actionTabId) setDraftWarning(null);
        console.log('[' + runtime.logPrefix + ':images] clipboard-save ready tab=' + actionTabId.slice(-12)
          + ' id=' + (insertion.addedImagePaths[0]?.id || '-')
          + ' asset=' + (saved.assetId || '-')
          + ' bytes=' + (saved.size || 0));

        if (preserveSelection) {
          const tokenEnd = tokenStart + HISTORY_IMAGE_PENDING_MARKER.length;
          const remappedSelection = remapPromptImageSelectionAfterReplacement({
            selectionStart,
            selectionEnd,
            replacedStart: tokenStart,
            replacedEnd: tokenEnd,
            insertionCaret: insertion.caret,
          });
          promptCaretRef.current = remappedSelection;
          requestAnimationFrame(() => {
            const currentTextarea = promptTextareaRef.current;
            if (!currentTextarea?.isFocused()) return;
            currentTextarea.setSelectionRange(remappedSelection.start, remappedSelection.end);
          });
        }
      })
      .catch((cause: any) => {
        const latest = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
        if (!latest.includes(HISTORY_IMAGE_PENDING_MARKER)) {
          console.log('[' + runtime.logPrefix + ':images] clipboard-save exception dropped tab=' + actionTabId.slice(-12)
            + ' reason=pending-marker-removed error=' + String(cause?.message || cause));
          return;
        }
        const failedText = latest.replace(HISTORY_IMAGE_PENDING_MARKER, '[imageError: clipboard_image_save_failed]');
        setHistoryPromptDraft(actionTabId, failedText, {
          images: retainHistoryDraftImages(
            failedText,
            useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
          ),
          chips: retainPasteChipsForText(
            failedText,
            useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
          ) as HistoryPromptDraftChip[],
        });
        if (tabIdRef.current === actionTabId) {
          setDraftWarning('Could not save the clipboard image. Copy it again and retry.');
        }
        console.warn('[' + runtime.logPrefix + ':images] clipboard-save exception tab=' + actionTabId.slice(-12)
          + ' error=' + String(cause?.message || cause));
      });
  }, [aiComposerChipThreshold, effectiveStopping, isCancellingTurn, rewindLocked, runtime.logPrefix, setHistoryPromptDraft, tabId]);

  const restoreChipToComposer = useCallback((chip: HistoryPromptDraftChip) => {
    if (isCancellingTurn || rewindLocked || effectiveStopping) {
      setDraftWarning('History input is temporarily locked');
      return;
    }
    const currentText = useUIStore.getState().historyPromptDrafts[tabId] || '';
    const textarea = promptTextareaRef.current;
    const saved = promptCaretRef.current;
    const selectionStart = textarea?.isFocused()
      ? (textarea?.selectionStart ?? saved.start)
      : saved.start;
    const selectionEnd = textarea?.isFocused()
      ? (textarea?.selectionEnd ?? saved.end)
      : saved.end;
    const restored = restoreComposerChipToText({
      text: currentText,
      chipText: chip.text,
      selectionStart,
      selectionEnd,
    });
    const remainingChips = (useUIStore.getState().historyPromptDraftChips[tabId] || [])
      .filter((item) => item.id !== chip.id);
    setHistoryPromptDraft(tabId, restored.text, {
      images: retainHistoryDraftImages(
        restored.text,
        useUIStore.getState().historyPromptDraftImages[tabId] || [],
      ),
      chips: remainingChips,
    });
    setPreviewChipId(null);
    promptCaretRef.current = { start: restored.caret, end: restored.caret };
    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (!currentTextarea) return;
      currentTextarea.focus();
      currentTextarea.setSelectionRange(restored.caret, restored.caret);
    });
  }, [effectiveStopping, isCancellingTurn, rewindLocked, setHistoryPromptDraft, tabId]);

  const discardComposerChip = useCallback((chipId: string) => {
    removeHistoryPromptDraftChip(tabId, chipId);
    setPreviewChipId((current) => current === chipId ? null : current);
    requestAnimationFrame(() => promptTextareaRef.current?.focus());
  }, [removeHistoryPromptDraftChip, tabId]);

  // Anchor-scoped operations. Unlike the old strip actions these replace the
  // marker WHERE IT SITS, so the paste returns to (or disappears from) the exact
  // spot in the sentence the user put it in.
  const replacePasteAnchor = useCallback((
    chip: HistoryPromptDraftChip,
    replacement: string,
  ) => {
    if (isCancellingTurn || rewindLocked || effectiveStopping) {
      setDraftWarning('History input is temporarily locked');
      return;
    }
    const currentText = useUIStore.getState().historyPromptDrafts[tabId] || '';
    const currentChips = useUIStore.getState().historyPromptDraftChips[tabId] || [];
    const range = (getPasteMarkerHighlightRanges(currentText, currentChips) as Array<{
      start: number; end: number; id: string;
    }>).find((item) => item.id === chip.id);
    if (!range) return;
    const nextText = currentText.slice(0, range.start) + replacement + currentText.slice(range.end);
    setHistoryPromptDraft(tabId, nextText, {
      images: retainHistoryDraftImages(
        nextText,
        useUIStore.getState().historyPromptDraftImages[tabId] || [],
      ),
      chips: currentChips.filter((item) => item.id !== chip.id),
    });
    setPreviewChipId((current) => current === chip.id ? null : current);
    const caret = range.start + replacement.length;
    promptCaretRef.current = { start: caret, end: caret };
    requestAnimationFrame(() => {
      const textarea = promptTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  }, [effectiveStopping, isCancellingTurn, rewindLocked, setHistoryPromptDraft, tabId]);

  const openPasteChipContextMenu = useCallback((
    chip: HistoryPromptDraftChip,
    _range: { start: number; end: number; id: string },
  ) => {
    ipcRenderer.send('show-paste-chip-context-menu', {
      chipId: chip.id,
      chars: (chip.text || '').length,
      preview: chip.text || '',
    });
  }, []);

  useEffect(() => {
    const onMenuAction = (_event: unknown, payload: { chipId?: string; action?: string }) => {
      const chip = (useUIStore.getState().historyPromptDraftChips[tabId] || [])
        .find((item) => item.id === payload?.chipId);
      if (!chip) return;
      if (payload.action === 'preview') {
        setPreviewChipId((current) => current === chip.id ? null : chip.id);
        return;
      }
      if (payload.action === 'restore') {
        replacePasteAnchor(chip, chip.text || '');
        return;
      }
      if (payload.action === 'discard') replacePasteAnchor(chip, '');
    };
    ipcRenderer.on('paste-chip-menu-action', onMenuAction);
    return () => { ipcRenderer.removeListener('paste-chip-menu-action', onMenuAction); };
  }, [replacePasteAnchor, tabId]);

  // The top line above the input carries PROMPTS only. A pasted blob is part of
  // what you are writing, not a saved prompt you picked — its place is inline in
  // the field, the way a terminal shows `[Pasted Content N chars]`. Mixing both
  // kinds in one strip made the row read as "attachments" and pushed the actual
  // prompt labels out of view on narrow widths.
  const composerSurfaceChips = useMemo<AIComposerSurfaceChip[]>(
    () => draftChips
      .filter((chip) => chip.kind === 'prompt')
      .map((chip) => ({
        id: chip.id,
        kind: chip.kind,
        label: chip.label || 'PROMPT',
        text: chip.text,
        onRestore: () => restoreChipToComposer(chip),
        onDiscard: () => discardComposerChip(chip.id),
      })),
    [discardComposerChip, draftChips, restoreChipToComposer],
  );
  const composerInlinePasteChips = useMemo(
    () => draftChips.filter((chip) => chip.kind === 'paste'),
    [draftChips],
  );
  // Same chips, in the shape the surface needs to host their expanded preview.
  const composerInlinePasteChipsForPreview = useMemo<AIComposerSurfaceChip[]>(
    () => composerInlinePasteChips.map((chip) => ({
      id: chip.id,
      kind: chip.kind,
      label: 'ВСТАВКА',
      text: chip.text,
    })),
    [composerInlinePasteChips],
  );
  const composerInlineImageChipsForPreview = useMemo<AIComposerSurfaceChip[]>(() => {
    const refsById = new Map(draftImages.map((ref) => [Number(ref.id), ref]));
    return promptImageMarkerRanges.map((range) => {
      const id = `image:${range.id}:${range.start}`;
      const ref = refsById.get(Number(range.id));
      const selected = previewChipId === id;
      const fileName = ref?.path?.split('/').filter(Boolean).pop() || `Image #${range.id}`;
      return {
        id,
        kind: 'image',
        label: `IMAGE #${range.id}`,
        previewMeta: fileName,
        expandedPreview: (
          <AIComposerImagePreview
            src={selected ? draftImageDetailPreview.url : undefined}
            loading={selected && draftImageDetailPreview.loading}
            error={selected ? draftImageDetailPreview.error : null}
            alt={`Image attachment #${range.id}`}
          />
        ),
      };
    });
  }, [draftImageDetailPreview, draftImages, previewChipId, promptImageMarkerRanges]);
  const composerInlineChipsForPreview = useMemo(
    () => [...composerInlinePasteChipsForPreview, ...composerInlineImageChipsForPreview],
    [composerInlineImageChipsForPreview, composerInlinePasteChipsForPreview],
  );

  const basicStatusDescription: Record<AgentPtyStatus, string> = {
    active: runtime.label + ' is ready for prompts',
    busy: runtime.label + ' is working; a new prompt will be queued',
    inactive: sessionId ? runtime.label + ' is stopped; resume keeps this conversation' : runtime.label + ' is not running; start creates a new conversation',
    starting: runtime.label + ' is preparing terminal input',
    stopping: runtime.label + ' is shutting down safely',
    unknown: runtime.label + ' status is not confirmed yet',
  };
  const unifiedTransientStatus = isCancellingTurn
    ? {
        title: 'STOPPING',
        description: 'Waiting for ' + runtime.label + ' stop record and restored prompt',
        accent: '#f59e0b',
      }
    : showRewindingChip
      ? {
          title: rewindStatusMeta.title,
          description: rewindStatusMeta.description,
          accent: '#a78bfa',
        }
      : isCompacting
        ? {
            title: 'COMPACTING',
            description: runtime.label + ' is compacting the conversation context',
            accent: '#a78bfa',
          }
      : showUpdatingChip
        ? {
            title: 'UPDATING',
            description: runtime.label + ' history is updating',
            accent: '#60a5fa',
          }
        : null;
  const statusTitle = statusCopied
    ? 'COPIED'
    : (unifiedTransientStatus?.title || activeLifecycle?.title || meta.label);
  const statusDescription =
    unifiedTransientStatus?.description ||
    activeLifecycle?.description ||
    basicStatusDescription[status];
  const statusDetail = activeLifecycle?.detail || null;
  const statusSessionId = sessionId || activeLifecycle?.sessionId || null;
  const statusAccent = unifiedTransientStatus?.accent || (
    activeLifecycle?.kind === 'error'
      ? '#ef4444'
      : activeLifecycle?.kind === 'interrupted'
        ? '#f59e0b'
        : activeLifecycle?.kind === 'stopping'
          ? '#d97706'
        : activeLifecycle
          ? '#60a5fa'
          : meta.color
  );
  const showStatusText = statusCopied
    || !!unifiedTransientStatus
    || !!activeLifecycle
    || status === 'starting'
    || status === 'stopping'
    || (status === 'unknown' && !presenceResolving);
  const showBusyLoader = (status === 'busy' || isPasteBusy) && !showStatusText;
  const displayedActivityTiming = activityTiming?.state === 'running'
    ? activityTiming
    : pasteActivityStartedAt !== null
      ? {
          state: 'running' as const,
          intervalId: null,
          toolType,
          sessionId: null,
          startTs: pasteActivityStartedAt,
          endTs: null,
          durationMs: null,
        }
      : activityTiming;
  const activityDurationLabel = displayedActivityTiming
    ? formatHistoryResponseDuration(
        elapsedHistoryResponseDurationMs(displayedActivityTiming, activityClock),
      )
    : null;
  const copyStatusDetails = useCallback(() => {
    const text = [
      statusTitle === 'COPIED' ? (activeLifecycle?.title || meta.label) : statusTitle,
      statusDescription,
      statusDetail,
      statusSessionId ? 'Session ' + statusSessionId : null,
      'Tab ' + tabId,
    ].filter(Boolean).join('\n');
    clipboard.writeText(text);
    setStatusCopied(true);
    if (statusCopiedTimerRef.current) clearTimeout(statusCopiedTimerRef.current);
    statusCopiedTimerRef.current = setTimeout(() => {
      statusCopiedTimerRef.current = null;
    setStatusCopied(false);
    }, 900);
  }, [activeLifecycle?.title, meta.label, statusDescription, statusDetail, statusSessionId, statusTitle, tabId]);
  const activateUnifiedStatus = useCallback(() => {
    if (onToggleTerminal) {
      onToggleTerminal();
      return;
    }
    copyStatusDetails();
  }, [copyStatusDetails, onToggleTerminal]);

  // History owns PTY state, but the top line follows the SDK presentation:
  // one compact terminal/status affordance plus transient authoring notices.
  // Start/Resume/Send/Stop stay in the workspace control bar below the surface.
  // The toggle always points at the SECONDARY surface, so its wording follows
  // the layout: History-primary hides/opens the terminal, terminal-primary
  // hides/opens the transcript. Same control, same "show me the other one".
  const secondarySurfaceLabel = terminalIsPrimary ? 'History' : 'terminal';
  const historyComposerTopBar = (
    <div className="hp-history-composer-toolbar">
      <Tooltip
        always
        interactive={false}
        side="top"
        content={[
          statusDescription,
          statusDetail,
          onToggleTerminal
            ? ((terminalOpen ? 'Click to hide ' : 'Click to open ') + secondarySurfaceLabel)
            : 'Click to copy status details',
          'Right-click to copy status details',
        ].filter(Boolean).join('\n')}
      >
        <button
          type="button"
          data-agent-status-row
          data-agent-operational-phase={isCompacting ? 'compacting' : undefined}
          data-terminal-toggle={onToggleTerminal ? 'status' : undefined}
          aria-label={onToggleTerminal
            ? ((terminalOpen ? 'Hide ' : 'Open ') + secondarySurfaceLabel)
            : 'Copy agent status details'}
          aria-pressed={onToggleTerminal ? !!terminalOpen : undefined}
          onClick={activateUnifiedStatus}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            copyStatusDetails();
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: showStatusText ? 6 : 0,
            minWidth: showStatusText ? 24 : 20,
            maxWidth: 'min(36vw, 360px)',
            height: 22,
            padding: showStatusText ? '0 4px 0 0' : 0,
            border: 0,
            borderRadius: 0,
            background: 'transparent',
            color: statusCopied ? '#86efac' : '#aaa',
            fontSize: aiSecondaryFontSize,
            fontWeight: 650,
            letterSpacing: showStatusText ? '0.04em' : 0,
            cursor: onToggleTerminal ? 'pointer' : 'copy',
            flexShrink: 0,
          }}
        >
          {presenceResolving ? (
            <HistoryOwnerTransitionIcon size={20} />
          ) : (
            <HistoryTerminalActivityIcon
              size={20}
              busy={showBusyLoader || isCompacting}
              active={!!(terminalOpen && onToggleTerminal)}
              color={statusAccent}
              surface={terminalIsPrimary ? 'history' : 'terminal'}
            />
          )}
          {showStatusText && (
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {statusTitle}
            </span>
          )}
        </button>
      </Tooltip>

      {activeLifecycle?.kind === 'error' && (
        <span
          role="status"
          data-agent-lifecycle-description
          title={activeLifecycle.detail || activeLifecycle.description}
          style={{
            color: '#fca5a5',
            fontSize: aiSecondaryFontSize,
            fontWeight: 600,
            lineHeight: '20px',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {activeLifecycle.description}
        </span>
      )}

      {activeLifecycle?.kind === 'error' && activeLifecycle.onDismiss && (
        <button
          type="button"
          data-agent-lifecycle-dismiss
          aria-label={activeLifecycle.dismissLabel || 'Dismiss starting status'}
          onMouseDown={(event) => {
            // Do not move focus out of the History composer while clearing the
            // same main-owned failure that the floating terminal can clear.
            event.preventDefault();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            activeLifecycle.onDismiss?.();
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            padding: 0,
            borderRadius: 5,
            border: '1px solid rgba(248, 113, 113, 0.35)',
            background: 'rgba(127, 29, 29, 0.16)',
            color: '#fca5a5',
            fontSize: 16,
            lineHeight: 1,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          ×
        </button>
      )}

      {activeLifecycle?.kind === 'error' && activeLifecycle.onRetry && (
        <button
          type="button"
          data-agent-lifecycle-retry
          aria-label={activeLifecycle.retryLabel || 'Retry startup settings'}
          onMouseDown={(event) => {
            // Keep the user's composer selection/draft intact while the shared
            // TerminalArea owner starts the retry transaction.
            event.preventDefault();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            activeLifecycle.onRetry?.();
          }}
          style={{
            height: 20,
            padding: '0 7px',
            borderRadius: 5,
            border: '1px solid rgba(248, 113, 113, 0.5)',
            background: 'rgba(127, 29, 29, 0.22)',
            color: '#fecaca',
            fontSize: aiSecondaryFontSize,
            fontWeight: 750,
            letterSpacing: '0.035em',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {activeLifecycle.retryLabel || 'RETRY SETTINGS'}
        </button>
      )}

      {activityDurationLabel && (
        <span
          data-history-response-timer
          data-state={displayedActivityTiming?.state}
          title={displayedActivityTiming?.state === 'running'
            ? 'Время текущего ответа'
            : 'Ответ завершён; ждём точную запись в истории'}
          style={{
            color: displayedActivityTiming?.state === 'running' ? '#a1a1aa' : '#7c8494',
            fontSize: aiSecondaryFontSize,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {activityDurationLabel}
        </span>
      )}

      {terminalOnlySlashDraft && (
        <span
          id={'history-terminal-only-hint-' + tabId}
          role="status"
          data-history-terminal-only-hint
          style={{
            color: '#8b8b92',
            fontSize: aiSecondaryFontSize,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          ← Terminal only
        </span>
      )}

      {visibleDraftWarning && !error && inlineDraftNoticeMeta && (
        <Tooltip content={visibleDraftWarning}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              minWidth: 0,
              maxWidth: 260,
              height: 20,
              padding: '0 7px',
              borderRadius: 5,
              border: '1px solid ' + (inlineDraftNoticeMeta.tone === 'info' ? 'rgba(113, 113, 122, 0.55)' : 'rgba(251, 191, 36, 0.45)'),
              backgroundColor: inlineDraftNoticeMeta.tone === 'info' ? 'rgba(82, 82, 91, 0.18)' : 'rgba(217, 119, 6, 0.16)',
              color: inlineDraftNoticeMeta.tone === 'info' ? '#d4d4d8' : '#fbbf24',
              fontSize: aiSecondaryFontSize,
              fontWeight: 650,
              letterSpacing: 0,
              flexShrink: 1,
            }}
          >
            {inlineDraftNoticeMeta.tone !== 'info' && <AlertTriangle size={12} style={{ flexShrink: 0 }} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {inlineDraftNoticeMeta.label}
            </span>
          </div>
        </Tooltip>
      )}

      {rewindPreviewActive && !error && (
        <Tooltip content="Preview after native rewind. JSONL is not changed until you submit the restored prompt. Restarting Claude or reopening History shows the full transcript again.">
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              minWidth: 0,
              maxWidth: 260,
              height: 20,
              padding: '0 7px',
              borderRadius: 5,
              border: '1px solid rgba(217, 119, 6, 0.42)',
              backgroundColor: 'rgba(217, 119, 6, 0.13)',
              color: '#fbbf24',
              fontSize: aiSecondaryFontSize,
              fontWeight: 750,
              letterSpacing: 0,
              flexShrink: 1,
            }}
          >
            <span style={{ whiteSpace: 'nowrap' }}>REWIND PREVIEW</span>
            <span style={{ color: '#a1a1aa', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {rewindPreviewHiddenCount > 0 ? rewindPreviewHiddenCount + ' hidden' : 'unsaved'}
            </span>
          </div>
        </Tooltip>
      )}

    </div>
  );

  // Swap sits at the FAR end of the composer top line, opposite the terminal
  // control, so the two never read as one cluster: the left icon shows and
  // hides the terminal, this one changes which surface owns the center. Amber
  // when active — the pin controls already own violet.
  const historyComposerTopBarTrailing = onSwapPrimarySurface ? (
    <ControlHint
      label={terminalIsPrimary
        ? 'Вернуть историю как основную поверхность'
        : 'Сделать терминал основной поверхностью'}
      shortcut="⌘["
      side="top"
    >
      <button
        type="button"
        data-history-swap-primary
        data-active={terminalIsPrimary ? '1' : '0'}
        aria-label={terminalIsPrimary ? 'Make History the main surface' : 'Make terminal the main surface'}
        aria-pressed={terminalIsPrimary}
        onMouseDown={(event) => {
          // Keep the caret and selection in the composer while the surrounding
          // layout changes shape.
          event.preventDefault();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSwapPrimarySurface();
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 20,
          padding: 0,
          borderRadius: 5,
          border: terminalIsPrimary ? '1px solid rgba(217, 119, 6, 0.45)' : '1px solid transparent',
          background: terminalIsPrimary ? 'rgba(217, 119, 6, 0.16)' : 'transparent',
          color: terminalIsPrimary ? '#fbbf24' : '#8b8b92',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <ArrowLeftRight size={14} strokeWidth={2} />
      </button>
    </ControlHint>
  ) : undefined;

  return (
    <div
      ref={controlsRef}
      data-history-controls
      style={{
        position: overlayComposer ? 'absolute' : 'relative',
        left: overlayComposer ? 16 : undefined,
        right: overlayComposer ? 16 : undefined,
        bottom: overlayComposer ? 0 : undefined,
        zIndex: overlayComposer ? 20 : undefined,
        flexShrink: 0,
        borderTop: overlayComposer ? 'none' : '1px solid #333',
        backgroundColor: overlayComposer ? 'transparent' : '#151515',
        padding: overlayComposer ? '0 0 4px' : '8px 10px 10px 12px',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {pendingQuestion ? (
        <div className="hp-history-composer-frame" style={{ border: '1px solid #333', borderRadius: 12, padding: 8, background: '#0f0f0f' }}>
          <div className="cb-composer-topbar">
            {historyComposerTopBar}
          </div>
          <ClaudeHistoryQuestionCard
            key={(pendingQuestion.source || 'unknown') + ':' + (pendingQuestion.toolUseID || 'none') + ':' + (pendingQuestion.questions?.length || 0)}
            tabId={tabId}
            pending={pendingQuestion}
            answering={answeringQuestion}
            error={questionError}
            onAnswer={(answers) => answerPendingQuestion(answers, false)}
            onStop={() => answerPendingQuestion({}, true)}
          />
        </div>
      ) : (
        <AIComposerSurface
          density="comfortable"
          className="hp-history-composer-frame"
          topBar={historyComposerTopBar}
          topBarTrailing={historyComposerTopBarTrailing}
          chips={composerSurfaceChips}
          externalExpandableChips={composerInlineChipsForPreview}
          expandedChipId={previewChipId}
          onExpandedChipChange={setPreviewChipId}
          secondaryFontSize={aiSecondaryFontSize}
          input={(
            <div
              style={{
                position: 'relative',
                flex: 1,
                minWidth: 0,
                borderRadius: 5,
                backgroundColor: isCancellingTurn || rewindLocked || effectiveStopping ? '#130f0a' : '#0f0f0f',
              }}
            >
              <ComposerEditor
                ref={promptTextareaRef}
                className="hp-agent-prompt"
                data-history-composer-tab-id={tabId}
                data-status={status}
                aria-describedby={terminalOnlySlashDraft
                  ? 'history-terminal-only-hint-' + tabId
                  : undefined}
                value={prompt}
                tokens={promptComposerTokens}
                fontSize={historyComposerFontSize}
                onChange={(nextText, selection) => {
                  if (isCancellingTurn || rewindLocked) return;
                  promptCaretRef.current = {
                    start: selection.start,
                    end: selection.end,
                  };
                  setPrompt(nextText, {
                    images: retainHistoryDraftImages(
                      nextText,
                      useUIStore.getState().historyPromptDraftImages[tabId] || [],
                    ),
                    // Deleting the anchor deletes the blob. Backspace over the
                    // marker is the natural way to drop a paste, and keeping the
                    // chip would smuggle its body into the sent prompt.
                    chips: retainPasteChipsForText(
                      nextText,
                      useUIStore.getState().historyPromptDraftChips[tabId] || [],
                    ) as HistoryPromptDraftChip[],
                  });
                  if (draftWarning) setDraftWarning(null);
                  if (error) setError(null);
                }}
                onCopy={handleComposerImageAwareCopy}
                onCut={handleComposerImageAwareCopy}
                onPaste={handleComposerImagePaste}
                onKeyDown={(e) => {
                  if (isPlainTextPasteShortcut(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.nativeEvent.stopImmediatePropagation();
                    if (isCancellingTurn || rewindLocked || effectiveStopping) {
                      setDraftWarning('History input is temporarily locked');
                      return;
                    }
                    const currentText = useUIStore.getState().historyPromptDrafts[tabId] || '';
                    const insertedText = clipboard.readText();
                    if (!insertedText) return;
                    const insertion = insertComposerTextAtSelection({
                      text: currentText,
                      insertedText,
                      selectionStart: e.currentTarget.selectionStart,
                      selectionEnd: e.currentTarget.selectionEnd,
                    });
                    setHistoryPromptDraft(tabId, insertion.text, {
                      images: retainHistoryDraftImages(
                        insertion.text,
                        useUIStore.getState().historyPromptDraftImages[tabId] || [],
                      ),
                      preserveChips: true,
                    });
                    promptCaretRef.current = {
                      start: insertion.selectionStart,
                      end: insertion.selectionEnd,
                    };
                    if (draftWarning) setDraftWarning(null);
                    if (error) setError(null);
                    requestAnimationFrame(() => {
                      const textarea = promptTextareaRef.current;
                      if (!textarea) return;
                      textarea.focus();
                      textarea.setSelectionRange(insertion.selectionStart, insertion.selectionEnd);
                    });
                    return;
                  }
                  if (e.code === 'KeyC' && e.ctrlKey && !e.metaKey && !e.altKey) {
                    const selectionStart = e.currentTarget.selectionStart ?? 0;
                    const selectionEnd = e.currentTarget.selectionEnd ?? selectionStart;
                    // Preserve the ordinary copy gesture when textarea text is
                    // selected. With no selection, Ctrl+C is a two-stage
                    // terminal gesture: clear every authoring surface first;
                    // only the next press on a truly empty composer may stop.
                    if (selectionEnd > selectionStart) return;
                    const state = useUIStore.getState();
                    const currentText = state.historyPromptDrafts[tabId] || '';
                    const currentImages = state.historyPromptDraftImages[tabId] || [];
                    const currentChips = state.historyPromptDraftChips[tabId] || [];
                    const hasAuthoringState = currentText.length > 0
                      || currentImages.length > 0
                      || currentChips.length > 0;
                    e.preventDefault();
                    e.stopPropagation();
                    e.nativeEvent.stopImmediatePropagation();
                    if (hasAuthoringState) {
                      setHistoryPromptDraft(tabId, '', { images: [], chips: [] });
                      setDraftWarning(null);
                      promptCaretRef.current = { start: 0, end: 0 };
                      requestAnimationFrame(() => promptTextareaRef.current?.focus());
                    } else if (canInterruptTurn) {
                      void runAction('interrupt');
                    } else if (status !== 'inactive') {
                      void runAction('stop');
                    }
                    return;
                  }
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  if (canSend) runAction('send');
                }}
                onSelectionChange={(selection) => {
                  promptCaretRef.current = {
                    start: selection.start,
                    end: selection.end,
                  };
                }}
                onTokenClick={(token) => {
                  if (token.kind === 'image') {
                    setPreviewChipId((current) => current === token.id ? null : token.id);
                    return true;
                  }
                  if (token.kind === 'paste') {
                    const chipId = token.id.slice('paste:'.length);
                    setPreviewChipId((current) => current === chipId ? null : chipId);
                    return true;
                  }
                  return false;
                }}
                onTokenContextMenu={(token) => {
                  if (token.kind !== 'paste') return false;
                  const chipId = token.id.slice('paste:'.length);
                  const range = promptPasteMarkerRanges.find((item) => item.id === chipId);
                  const chip = draftChips.find((item) => item.id === chipId);
                  if (!range || !chip) return false;
                  openPasteChipContextMenu(chip, range);
                  return true;
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  // Raw/revealed paste source still uses the field menu; a
                  // rendered chip handles the same action through
                  // onTokenContextMenu above.
                  const caret = e.currentTarget.selectionStart ?? -1;
                  const hitRange = caret >= 0
                    ? promptPasteMarkerRanges.find((range) => caret >= range.start && caret <= range.end)
                    : undefined;
                  const hitChip = hitRange
                    ? draftChips.find((chip) => chip.id === hitRange.id)
                    : undefined;
                  if (hitChip) {
                    openPasteChipContextMenu(hitChip, hitRange!);
                    return;
                  }
                  window.dispatchEvent(new CustomEvent('history-panel:open-insert-menu', {
                    detail: {
                      tabId,
                      cwd,
                      x: e.clientX,
                      y: e.clientY,
                    },
                  }));
                }}
                placeholder={rewindLocked ? rewindStatusMeta?.placeholder || 'Rewinding... input is locked' : isCancellingTurn || effectiveStopping ? 'Stopping...' : status === 'inactive' ? 'Enter запускает ' + runtime.label + ' и отправляет' : status === 'starting' ? 'Запускаю терминал…' : 'Send a prompt...'}
                readOnly={isCancellingTurn || rewindLocked || effectiveStopping}
                style={{
                  position: 'relative',
                  zIndex: 1,
                  display: 'block',
                  width: '100%',
                  minWidth: 0,
                  boxSizing: 'border-box',
                  overflowY: 'hidden',
                  scrollbarGutter: 'stable',
                  maxHeight: historyComposerMaxHeight,
                  minHeight: historyComposerMinHeight,
                  backgroundColor: 'transparent',
                  border: 0,
                  borderRadius: 8,
                  color: isCancellingTurn || rewindLocked || effectiveStopping ? '#c7c7c7' : '#e5e5e5',
                  caretColor: isCancellingTurn || rewindLocked || effectiveStopping ? '#c7c7c7' : '#e5e5e5',
                  outline: 'none',
                  lineHeight: 1.35,
                  fontFamily: 'inherit',
                  overflowWrap: 'break-word',
                  wordBreak: 'break-word',
                }}
                onFocus={() => {
                  setPromptQueueInputSurface(tabId, 'history');
                  const editor = promptTextareaRef.current;
                  promptCaretRef.current = {
                    start: editor?.selectionStart ?? 0,
                    end: editor?.selectionEnd ?? 0,
                  };
                }}
                onBlur={() => {
                  const editor = promptTextareaRef.current;
                  promptCaretRef.current = {
                    start: editor?.selectionStart ?? 0,
                    end: editor?.selectionEnd ?? 0,
                  };
                }}
              />
            </div>
          )}
        />
      )}
      {error && (
        <div style={{ marginTop: 6, color: '#fca5a5', fontSize: 11, wordBreak: 'break-word' }}>
          {error}
        </div>
      )}
    </div>
  );
}

const HISTORY_VIRTUOSO_COMPONENTS = { Footer: HistoryBottomSpacer };
const HISTORY_INITIAL_VIEWPORT_BUFFER = { top: 0, bottom: 0 };
const HISTORY_SETTLED_VIEWPORT_BUFFER = { top: 600, bottom: 600 };


function HistoryPanel({
  tabId,
  sessionId,
  cwd,
  width,
  notesPanelWidth,
  isOpen,
  toolType = 'claude',
  enableClaudePtyControls = false,
  embedded = false,
  embeddedFill = false,
  previewMode = false,
  mainSurface = false,
  agentSidePanel = false,
  composerPortalHostId,
  onSwapPrimarySurface,
  terminalIsPrimary = false,
  projectId,
  terminalOpen = false,
  onToggleTerminal,
  lifecycleStatus,
  onControlsHeightChange,
}: HistoryPanelProps) {
  // Live input surface of the tab in BOTH agent layouts. Everything that makes
  // History the place the user types into — availability published to grab /
  // dictation / task plan, Escape-interrupt — keys off this, not off geometry.
  const agentInputSurface = mainSurface || agentSidePanel;
  // Docked-composer host. Looked up from the DOM because the host belongs to the
  // workspace column, not to this subtree; state (not a ref) so the portal
  // renders as soon as the host exists.
  const [composerHostEl, setComposerHostEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!composerPortalHostId) {
      setComposerHostEl(null);
      return;
    }
    setComposerHostEl(document.getElementById(composerPortalHostId));
  }, [composerPortalHostId]);
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  const setHistoryPanelWidth = useUIStore((s) => s.setHistoryPanelWidth);
  const historyScrollToUuid = useUIStore((s) => s.historyScrollToUuid);
  const setHistoryScrollToUuid = useUIStore((s) => s.setHistoryScrollToUuid);
  const setHistoryVisibleUuids = useUIStore((s) => s.setHistoryVisibleUuids);
  const setHistoryScrollPosition = useUIStore((s) => s.setHistoryScrollPosition);
  const setHistoryPromptDraft = useUIStore((s) => s.setHistoryPromptDraft);
  const setHistoryRewindPreview = useUIStore((s) => s.setHistoryRewindPreview);
  const historyFontSize = useUIStore((s) => s.historyFontSize);
  const isTurnBusy = useWorkspaceStore(useCallback((state) => {
    if (projectId) {
      return state.openProjects.get(projectId)?.tabs.get(tabId)?.aiBusy === true;
    }
    const active = state.activeProjectId
      ? state.openProjects.get(state.activeProjectId)
      : null;
    const activeTab = active?.tabs.get(tabId);
    if (activeTab) return activeTab.aiBusy === true;
    for (const workspace of state.openProjects.values()) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return tab.aiBusy === true;
    }
    return false;
  }, [projectId, tabId]));
  const storedRewindPreview = useUIStore((s) => s.historyRewindPreviews[tabId] || null);
  const activeRewindOperation = useRewindOperationStore(
    useCallback((state) => selectActiveRewindOperation(state, tabId), [tabId])
  );
  const rewindLocked = isRewindOperationBlocking(activeRewindOperation);
  const closePanel = useCallback(() => setHistoryPanelOpen(tabId, false), [tabId, setHistoryPanelOpen]);
  const resetPanelWidth = useCallback(() => setHistoryPanelWidth(HISTORY_PANEL_DEFAULT_WIDTH), [setHistoryPanelWidth]);
  const panelRef = useRef<HTMLDivElement>(null);
  const rewindPreview = storedRewindPreview && (!storedRewindPreview.sessionId || storedRewindPreview.sessionId === sessionId)
    ? storedRewindPreview
    : null;
  // Rewind convergence only needs membership, not a second retained copy of the
  // full History payload (which can contain hundreds of MB of tool output).
  const lastServerEntryUuidsRef = useRef<Set<string>>(new Set());
  const historySnapshotOwner = useMemo<HistorySnapshotOwner>(
    () => ({ tabId, toolType, sessionId: sessionId || '', cwd: cwd || '' }),
    [cwd, sessionId, tabId, toolType],
  );
  const historyOwnerKey = useMemo(
    () => makeHistorySnapshotKey(historySnapshotOwner),
    [historySnapshotOwner],
  );
  const historyOwnerDomId = useMemo(
    () => historyOwnerDigest(historyOwnerKey),
    [historyOwnerKey],
  );
  const historyOwnerKeyRef = useRef(historyOwnerKey);
  const historyOwnerGenerationRef = useRef(0);
  // Reactive mirror of the generation. The ref alone cannot drive the list's
  // remount key — refs do not re-render — and the list only consumes restored
  // geometry at mount.
  const [historyOwnerVisitState, setHistoryOwnerVisitState] = useState(0);
  const historyLoadFlightRef = useRef<{
    ownerKey: string;
    generation: number;
    trailingRefresh: boolean;
    promise: Promise<boolean>;
  } | null>(null);
  const rewindPreviewOwnerRef = useRef({ tabId, sessionId });

  // Save scroll position + clean up CSS highlights on unmount.
  // Virtuoso owns scrolling — the scrollTop we save belongs to the inner
  // scroller element (via scrollerRef), not scrollRef.
  // The position is keyed by tab + session: after Rewind/fork the child branch
  // is a different document, and replaying the source branch's pixel offset
  // into the truncated child list lands on an unrelated row.
  const scrollPositionKey = tabId + ':' + (sessionId || 'no-session');
  const scrollPositionKeyRef = useRef(scrollPositionKey);
  scrollPositionKeyRef.current = scrollPositionKey;
  // Cleanup on owner change intentionally does NOT read the DOM to save a
  // position. This panel is persistently mounted: by the time this cleanup
  // runs the render already committed the NEXT owner (the key ref points at
  // the new tab and the scroller may show transitional content), so a save
  // here poisoned the DESTINATION tab's stored position on every switch —
  // the proven "scroll restore never works anywhere" bug. Position saving
  // lives solely in the scroll-idle handler, which captures its owner key
  // synchronously with the gesture.
  useEffect(() => {
    return () => {
      if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
      const CSS_HL = (CSS as any).highlights;
      CSS_HL?.delete('hp-search');
      CSS_HL?.delete('hp-search-current');
    };
  }, [tabId]);

  // Slide animation state
  const [slideIn, setSlideIn] = useState(false);
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setSlideIn(true));
      });
    } else {
      setSlideIn(false);
    }
  }, [isOpen]);

  const firstRenderSnapshot = historySnapshotCache.peek<FullHistoryEntry>(historySnapshotOwner);
  // Rewind owner handoff: when the tab's session flips source → child while a
  // rewind operation owns this tab, the previous owner's rows up to the rewind
  // target are a PROVEN COMMON PREFIX of the child branch (the writer proof
  // compared both histories turn-by-turn before commit). Present that prefix
  // instead of tearing down to an empty loader; the child's real projection
  // replaces it in one commit when loadHistory lands. Held per owner-key so a
  // later unrelated session change can never resurrect it.
  const rewindPrefixHandoffRef = useRef<{
    sourceSessionId: string;
    expectedChildSessionId: string | null;
    entries: FullHistoryEntry[];
    capturedAt: number;
  } | null>(null);
  // True while the visible rows are a display-only rewind prefix that has
  // not yet been replaced by the child owner's durable projection. A failed
  // first load must not leave the prefix standing as if it were final.
  const rewindPrefixOnScreenRef = useRef<string | null>(null);
  const [entries, setEntries] = useState<FullHistoryEntry[]>(
    () => (firstRenderSnapshot?.entries as unknown as FullHistoryEntry[] | undefined) || [],
  );
  const [liveEntries, setLiveEntries] = useState<FullHistoryEntry[]>([]);
  const [liveToolResults, setLiveToolResults] = useState<Map<string, HistoryLiveToolResult>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(() => !firstRenderSnapshot);
  const [compactOperationalPhase, setCompactOperationalPhase] = useState<CompactOperationalPhase | null>(null);
  const [presentedOwnerKey, setPresentedOwnerKey] = useState(historyOwnerKey);
  // Owner whose rows have been read from disk at least once in this mount.
  // Distinct from `presentedOwnerKey`, which only means "this owner is on
  // screen" and is satisfied by a cache hit. Liveness claims (background
  // chips) need the stronger fact, because a cache written while an agent was
  // still running keeps describing it as running after it finished.
  const [chipsFreshOwnerKey, setChipsFreshOwnerKey] = useState('');
  // Nobody is "already presented" before a frame exists — including a first
  // render seeded from the snapshot cache. Marking the warm owner ready here
  // pre-answered the paint proof and reopened the blank-frame hole from the
  // other side (see viewportProofRequired below).
  const [viewportReadyOwnerKey, setViewportReadyOwnerKey] = useState('');
  // Paint proof is required on EVERY owner, warm cache included. Having the
  // rows in memory is not having them on screen: the warm path used to drop the
  // loader the moment the data was there, and the rows themselves still cost
  // 180-760ms of layout on heavy tabs — the user stared at a blank surface for
  // that whole gap (prod 26.07, LOADER_HIDDEN → SURFACE_PRESENTED measured
  // repeatedly at ~190ms on one tab and 24ms on its neighbour). Skipping the
  // proof for a cache hit was an assumption that "ready data" equals "ready
  // frame", and it is the one hole through which every blank-frame report came.
  const [viewportProofRequired, setViewportProofRequired] = useState(true);
  const viewportReadyOwnerKeyRef = useRef('');
  const loaderHiddenAtRef = useRef<number | null>(null);
  const viewportPaintProbeRef = useRef<ReturnType<typeof createHistoryViewportPaintProbe> | null>(null);
  if (!viewportPaintProbeRef.current) {
    viewportPaintProbeRef.current = createHistoryViewportPaintProbe();
  }
  const surfacePresentedProbeRef = useRef<ReturnType<typeof createHistoryViewportPaintProbe> | null>(null);
  if (!surfacePresentedProbeRef.current) {
    surfacePresentedProbeRef.current = createHistoryViewportPaintProbe();
  }
  const surfacePresentedOwnerRef = useRef('');
  const ownerChangedBeforeLayoutHandoff = presentedOwnerKey !== historyOwnerKey;
  const cachedRenderEntries = firstRenderSnapshot?.entries as unknown as FullHistoryEntry[] | undefined;
  // A cached owner is already safe to present during the prop-change render.
  // Keep the authoritative `entries` state untouched until the layout handoff:
  // the previous owner's cleanup still reads presentationEntriesRef and must
  // never persist B's rows under A's key. This display-only snapshot removes
  // the false Loading/blank frame without weakening owner isolation.
  const renderEntries = ownerChangedBeforeLayoutHandoff && cachedRenderEntries
    ? cachedRenderEntries
    : entries;
  const surfaceLoading = !cachedRenderEntries && (
    loading || ownerChangedBeforeLayoutHandoff
  );
  const historyOwnerStartedAtRef = useRef(Date.now());
  const historyLoaderReasonRef = useRef(
    firstRenderSnapshot ? 'first-render-cache-hit' : 'first-render-cache-miss',
  );
  const historyLoadSequenceRef = useRef(0);
  const historyRevisionRef = useRef<HistoryDurableRevision | null>(firstRenderSnapshot?.revision || null);
  const isTurnBusyRef = useRef(isTurnBusy);
  isTurnBusyRef.current = isTurnBusy;
  const deferredTranscriptRefreshRef = useRef(false);
  const promptHandoffMetaRef = useRef<Map<string, PromptHandoffMeta>>(new Map());
  const rewindDraftPresentationRef = useRef<Map<string, {
    text: string;
    chips: HistoryPromptDraftChip[];
  }>>(new Map());
  const suppressedPromptsRef = useRef<Map<string, SuppressedPrompt>>(new Map());
  const rawServerEntriesRef = useRef<FullHistoryEntry[]>(
    (firstRenderSnapshot?.entries as unknown as FullHistoryEntry[] | undefined) || [],
  );
  const liveProjectionRef = useRef<{
    ownerKey: string;
    entries: FullHistoryEntry[];
  }>({ ownerKey: historyOwnerKey, entries: [] });
  const liveToolResultsRef = useRef<{
    ownerKey: string;
    results: Map<string, HistoryLiveToolResult>;
  }>({ ownerKey: historyOwnerKey, results: new Map() });
  const durableSourceIdentitiesRef = useRef<Set<string>>(new Set(
    (
      (firstRenderSnapshot?.entries as unknown as FullHistoryEntry[] | undefined)
      || []
    )
      .map((entry) => historyLivePresentationIdentity(entry))
      .filter((identity): identity is string => !!identity),
  ));
  const presentationEntriesRef = useRef(entries);
  presentationEntriesRef.current = entries;
  useEffect(() => {
    const captureDelayedWriterPrefix = (
      _event: unknown,
      data: CodexWriterTransitionEvent = {},
    ) => {
      const preview = useUIStore.getState().historyRewindPreviews[tabId] || null;
      const currentSessionId = useWorkspaceStore.getState().getCodexSessionId(tabId);
      if (!shouldCaptureDelayedCodexRewindPrefix({
        tabId,
        currentSessionId,
        preview,
        event: data,
      })) return;

      const previousRows = presentationEntriesRef.current;
      const targetIdx = previousRows.findIndex((entry) => entry.uuid === preview!.targetUuid);
      if (targetIdx <= 0) return;
      const prefix = previousRows
        .slice(0, targetIdx)
        .filter((entry) => !isLocalRewindEntry(entry) && !isLocalPromptEntry(entry));
      if (prefix.length === 0) return;

      rewindPrefixHandoffRef.current = {
        sourceSessionId: String(data.previousSessionId),
        expectedChildSessionId: String(data.sessionId),
        entries: prefix,
        capturedAt: Date.now(),
      };
      historyDiag('REWIND_PREFIX_CAPTURE_DELAYED tab=' + tabId.slice(-12)
        + ' op=' + preview!.opId
        + ' source=' + String(data.previousSessionId).slice(0, 8)
        + ' child=' + String(data.sessionId).slice(0, 8)
        + ' generation=' + String(data.writerGeneration)
        + ' prefixRows=' + prefix.length
        + ' target=' + String(preview!.targetUuid).slice(0, 8));
    };

    // Main publishes every proven Codex writer replacement through this
    // existing channel before renderer state adopts it. The direct
    // codex:session-detected event is a second delivery of the same proof and
    // is deliberately not registered here.
    ipcRenderer.on('terminal:mcp-ai-tab', captureDelayedWriterPrefix);
    return () => {
      ipcRenderer.removeListener('terminal:mcp-ai-tab', captureDelayedWriterPrefix);
    };
  }, [tabId]);
  const persistVolatileOverlay = useCallback((
    owner: HistorySnapshotOwner,
    sourceEntries: FullHistoryEntry[],
    handoffs: Map<string, PromptHandoffMeta> = promptHandoffMetaRef.current,
    suppressions: Map<string, SuppressedPrompt> = suppressedPromptsRef.current,
  ) => {
    const now = Date.now();
    const activeSuppressions = Array.from(suppressions.entries())
      .filter(([, suppression]) => suppression.expiresAt > now);
    const localEntries = sourceEntries.filter((entry) => {
      if (isLocalRewindEntry(entry)) {
        // Terminal rewind rows are removed by their own events; an IN-FLIGHT
        // row that outlives its operation (crash mid-op, lost rewind-log
        // event) must not resurrect as an eternal "REWINDING…" on the next
        // visit to this owner. Failed rows keep the shorter failure TTL.
        const rewindAgeMs = now - (
          entry.optimisticAt || Date.parse(entry.timestamp || '') || now
        );
        if (entry.rewindStatus === 'failed') {
          return rewindAgeMs < LOCAL_PROMPT_FAILURE_TTL_MS;
        }
        return rewindAgeMs < LOCAL_REWIND_STALE_TTL_MS;
      }
      if (!isLocalPromptEntry(entry)) return false;
      const ageMs = now - (
        entry.statusChangedAt ||
        entry.optimisticAt ||
        Date.parse(entry.timestamp || '') ||
        now
      );
      if (entry.queueStatus === 'cancelled' || entry.queueStatus === 'failed') {
        return ageMs < LOCAL_PROMPT_FAILURE_TTL_MS;
      }
      return true;
    });
    const liveHandoffIds = new Set<string>();
    for (const entry of localEntries) {
      if (entry.handoffId) liveHandoffIds.add(entry.handoffId);
    }
    for (const [handoffId] of activeSuppressions) liveHandoffIds.add(handoffId);
    const activeHandoffs = Array.from(handoffs.entries())
      .filter(([handoffId]) => liveHandoffIds.has(handoffId));
    const stored = historyVolatileOverlayCache.set(owner, {
      entries: localEntries,
      handoffs: activeHandoffs,
      suppressions: activeSuppressions,
    });
    if (!stored) {
      console.warn(
        '[HistoryPanel] volatile overlay not cached tab=' + owner.tabId.slice(-12)
        + ' entries=' + localEntries.length
        + ' handoffs=' + activeHandoffs.length
        + ' suppressions=' + activeSuppressions.length,
      );
    }
  }, []);
  const reconcileLiveProjectionAgainstDurable = useCallback((
    durableEntries: FullHistoryEntry[],
    ownerKey = historyOwnerKeyRef.current,
  ) => {
    const live = liveProjectionRef.current;
    const reconciled = reconcileCommittedHistoryLiveProjection(
      live.ownerKey === ownerKey ? live.entries : [],
      durableEntries,
    );
    durableSourceIdentitiesRef.current = reconciled.durableIdentities;
    if (live.ownerKey !== ownerKey || live.entries.length === 0) return;
    const remaining = reconciled.entries as FullHistoryEntry[];
    if (remaining.length === live.entries.length) return;
    liveProjectionRef.current = { ownerKey, entries: remaining };
    setLiveEntries(remaining);
  }, []);
  const reconcileLiveToolResultsAgainstDurable = useCallback((
    durableEntries: FullHistoryEntry[],
    ownerKey = historyOwnerKeyRef.current,
  ) => {
    const live = liveToolResultsRef.current;
    if (live.ownerKey !== ownerKey || live.results.size === 0) return;
    const remaining = reconcileHistoryLiveToolResults(durableEntries, live.results);
    if (remaining.size === live.results.size) return;
    liveToolResultsRef.current = { ownerKey, results: remaining };
    setLiveToolResults(remaining);
  }, []);
  const hasUnmatchedLiveForOwner = useCallback((ownerKey: string) => {
    const live = liveProjectionRef.current;
    const durableIdentities = new Set(
      rawServerEntriesRef.current
        .map((entry) => historyLivePresentationIdentity(entry))
        .filter((identity): identity is string => !!identity),
    );
    const hasUnmatchedProjection = live.ownerKey === ownerKey
      && live.entries.some((entry) => {
        const identity = historyLivePresentationIdentity(entry);
        return !identity || !durableIdentities.has(identity);
      });
    return hasUnmatchedProjection || (
      liveToolResultsRef.current.ownerKey === ownerKey
      && liveToolResultsRef.current.results.size > 0
    );
  }, []);
  const historyPayloadContextValue = useMemo(
    () => (sessionId ? { toolType, sessionId, cwd } : null),
    [toolType, sessionId, cwd],
  );
  // Background chips derive from durable rows only; local/optimistic rows
  // can never be background work. Process liveness comes from the composer
  // availability the controls already publish (status: active/busy/starting
  // = agent process alive) — Codex in-process subagents outlive their spawn
  // turn but never their host process.
  // NO RECORD ≠ DEAD PROCESS. The availability record is deleted on every
  // rebind of the composer to a tab, so defaulting the missing case to
  // `inactive` asserted "the process ended" at the exact moment we knew
  // nothing at all. Falling back to `unknown` keeps the last established
  // answer instead (see the fold below); a genuine `inactive` still arrives
  // as a real status and still clears.
  const agentProcessStatus = useUIStore(
    (s) => s.historyComposerAvailability[tabId]?.status || 'unknown',
  );
  const agentProcessGeneration = useUIStore(
    (s) => s.historyComposerAvailability[tabId]?.lifecycleGeneration || null,
  );
  // `unknown` is "not established yet", NOT "dead". It appears on every
  // tab-bind, before presence re-confirms the process a few hundred ms later.
  // Folding it into "dead" made a running agent's chip blink out and back on
  // each switch to the tab (E2E 2026-07-29 caught the flip:
  // active→unknown→active gave count=1 → 0 → 1 with the agent working the
  // whole time). Liveness lookup is three-valued — found / absent / unknown —
  // and only a POSITIVE absence may clear confirmed state; uncertainty holds
  // the last answer. `inactive` is a real negative and still clears.
  // Last ESTABLISHED answer per tab. Keyed by tab because the panel is
  // persistent-mounted and shared by every tab — a single slot would carry
  // one tab's liveness onto the next one on switch.
  const agentProcessAliveByTabRef = useRef<Map<string, boolean>>(new Map());
  const agentProcessAlive = useMemo(() => {
    const known = agentProcessAliveByTabRef.current;
    const previous = known.get(tabId) ?? false;
    const alive = foldHistoryAgentProcessLiveness(agentProcessStatus, previous);
    if (agentProcessStatus !== 'unknown') known.set(tabId, alive);
    return alive;
  }, [agentProcessStatus, tabId]);
  // Chips must see the SAME rows the transcript shows, durable + live. A Codex
  // subagent is durable only after the rollout is re-read, but its spawn is
  // already on screen through the live stream — computing chips from durable
  // rows alone meant a short-lived agent was never a chip at all (E2E ct-e2e22:
  // three agents, each alive ~2s, zero chips, while every durable recompute
  // landed in the gaps between them). Live rows carry the same Task-card shape,
  // so the collector needs no special case; the durable row wins later by
  // source identity exactly as it does in the transcript.
  const chipLiveEntries = liveProjectionRef.current.ownerKey === historyOwnerKey
    ? liveEntries
    : EMPTY_HISTORY_ENTRIES;
  const chipSourceEntries = useMemo(
    () => (chipLiveEntries.length === 0
      ? entries
      : buildHistoryLivePresentation(entries, chipLiveEntries) as FullHistoryEntry[]),
    [entries, chipLiveEntries],
  );
  // Chips belong to the tab whose rows they were computed from.
  //
  // `entries` is component state and deliberately survives a tab switch until
  // the new owner's rows are loaded and handed off. During that window the
  // panel is already bound to tab B while still holding tab A's rows — so
  // computing chips unconditionally publishes A's running agent under B's
  // tabId. E2E 2026-07-29 caught exactly that: `tab=g-tab-900372 count=1
  // keys=subagent:task:toolu_01QdKj…`, the SAME spawn id that belonged to
  // tab-900371, ~112 ms long. Short enough to miss on screenshots, long
  // enough to light the loader on a tab that has no agent at all.
  //
  // The owner handoff is already tracked for the transcript; the chip strip
  // must respect the same boundary rather than race it. Until the presented
  // owner catches up, this tab has no proven rows and therefore no chips —
  // "not established yet", never a claim about another tab's work.
  //
  // Returning to a tab adds a second, subtler stale window: the cached rows
  // paint instantly while the fresh read is still in flight, and a cache
  // written BEFORE the agent finished still describes it as running. E2E
  // 2026-07-29 measured that blip 8 seconds after the agent had actually
  // completed — count=0 → 1 → 0 across a single LOAD_APPLY, i.e. the strip
  // briefly resurrected finished work. A stale cache may paint the
  // transcript (rows are rows), but it must not assert that something is
  // ALIVE: liveness claims wait for rows this owner has actually loaded.
  //
  // But "wait for the disk read" is only the right answer for CACHED rows.
  // Production 2026-07-31 05:01: switching to a tab with three working agents
  // showed an empty strip for 1930 ms — the whole duration of the refresh read
  // — because the gate also suppressed rows arriving on the LIVE stream. Those
  // rows cannot be stale by construction: they were produced after this owner
  // was bound, describe work happening right now, and are exactly what the
  // durable read will later confirm. Live rows therefore establish this owner
  // for liveness on their own; only the cached-rows path keeps waiting.
  const chipsLiveOwnerProven = chipLiveEntries.length > 0;
  const chipsOwnerSettled = presentedOwnerKey === historyOwnerKey
    && (chipsFreshOwnerKey === historyOwnerKey || chipsLiveOwnerProven);
  const backgroundHistoryChips = useMemo(
    () => (chipsOwnerSettled
      ? collectHistoryBackgroundChips(
        chipSourceEntries,
        isTurnBusy,
        agentProcessAlive,
        sessionId || '',
        agentProcessGeneration,
        toolType,
      )
      : EMPTY_HISTORY_CHIPS),
    [chipsOwnerSettled, chipSourceEntries, isTurnBusy, agentProcessAlive, sessionId, agentProcessGeneration, toolType],
  );
  const liveBackgroundUuids = useMemo(
    () => new Set(backgroundHistoryChips.map((chip) => chip.entryUuid)),
    [backgroundHistoryChips],
  );
  // Observable trace of the background zone. Both the presence AND the
  // absence of chips are acceptance conditions of the E2E scenarios, and a
  // silently-empty strip is indistinguishable from a strip that was never
  // computed — so the line prints on every change of the live set, including
  // the transition to zero, together with the gates that produced it.
  const backgroundChipsDigest = backgroundHistoryChips
    .map((chip) => chip.kind + ':' + chip.key)
    .join(',');
  // The TAB LOADER means "an agent is working here", not "something is
  // running here". A `run_in_background` Bash command stays visible in the
  // strip above the composer — the user can still see and open it — but it
  // must not spin the tab, or a long-running shell reads as an active agent
  // from the tab list. Only subagent chips are broadcast outward.
  const backgroundAgentChipCount = useMemo(
    () => backgroundHistoryChips.filter((chip) => chip.kind === 'subagent').length,
    [backgroundHistoryChips],
  );
  useEffect(() => {
    // `count` is the STRIP (subagents + background Bash). `agents` is what
    // actually drives the tab loader. Printing only the first number made two
    // E2E runs read a visible Bash chip as "the loader is spinning", and a
    // handoff-empty strip as "the agent died" — both wrong, and both because
    // the trace conflated two different questions. `owner` says whether this
    // tab is allowed to make liveness claims at all right now.
    historyDiag('BACKGROUND_CHIPS tab=' + tabId.slice(-12)
      + ' count=' + backgroundHistoryChips.length
      + ' agents=' + backgroundAgentChipCount
      + ' owner=' + (chipsOwnerSettled ? 'settled' : 'handoff')
      // Which fact established the owner: rows read from disk, or the live
      // stream while that read is still in flight.
      + ' ownerVia=' + (chipsFreshOwnerKey === historyOwnerKey
        ? 'durable'
        : chipsLiveOwnerProven ? 'live' : 'none')
      + ' turnBusy=' + (isTurnBusy ? '1' : '0')
      + ' processAlive=' + (agentProcessAlive ? '1' : '0')
      + ' processGeneration=' + (agentProcessGeneration || '-')
      + ' keys=' + (backgroundChipsDigest || '-'));
  }, [tabId, backgroundChipsDigest, backgroundHistoryChips.length, backgroundAgentChipCount, chipsOwnerSettled, chipsFreshOwnerKey, chipsLiveOwnerProven, historyOwnerKey, isTurnBusy, agentProcessAlive, agentProcessGeneration]);
  // Tab-level loader inheritance: a Codex subagent can outlive its spawn
  // turn, so the tab must keep spinning while any background chip is live
  // even though the parent turn's busy flag is already false. Broadcast the
  // live count; TabBar folds it into the shimmer (display-only — lifecycle
  // busy ownership stays with the runtime signals).
  useEffect(() => {
    // Publish only what this tab actually owns. While the owner handoff is in
    // flight the strip is empty by construction (see chipsOwnerSettled), and
    // broadcasting that emptiness would read as "the agent stopped" — the
    // loader would blink off on every switch. Silence during the handoff means
    // "no new answer"; TabBar keeps the last one until this tab can speak for
    // itself again.
    if (!chipsOwnerSettled) return;
    window.dispatchEvent(new CustomEvent('history-panel:background-work', {
      detail: { tabId, count: backgroundAgentChipCount },
    }));
    // No zeroing on unmount: the count is now owned by the main-process
    // watcher (`tab:background-work`), which sees every tab whether or not its
    // History is open. Publishing 0 here used to erase a still-running agent
    // the moment the user switched away — the tab looked idle until clicked
    // back, which is exactly how a live agent stayed invisible.
  }, [chipsOwnerSettled, tabId, backgroundAgentChipCount]);
  const [expandedBackgroundChipKey, setExpandedBackgroundChipKey] = useState<string | null>(null);
  // Auto-close the pane when its chip finishes (mirrors the SDK bar).
  useEffect(() => {
    if (!expandedBackgroundChipKey) return;
    if (!backgroundHistoryChips.some((chip) => chip.key === expandedBackgroundChipKey)) {
      setExpandedBackgroundChipKey(null);
    }
  }, [backgroundHistoryChips, expandedBackgroundChipKey]);
  const rewindPreviewResult = useMemo(
    () => buildRewindPreviewEntries(renderEntries, rewindPreview),
    [renderEntries, rewindPreview],
  );
  const displayEntries = rewindPreviewResult.entries;
  const visibleLiveEntries = liveProjectionRef.current.ownerKey === historyOwnerKey
    ? liveEntries
    : [];
  // Live rollout rows and durable History rows share one virtualized list.
  // The durable version wins by source identity, while computeItemKey keeps
  // the same DOM row across the handoff. This removes the old footer/indexed
  // dual presentation and its materialization race.
  const transcriptEntries = useMemo(
    () => buildHistoryLivePresentation(displayEntries, visibleLiveEntries),
    [displayEntries, visibleLiveEntries],
  ) as FullHistoryEntry[];
  const visibleLiveToolResults = liveToolResultsRef.current.ownerKey === historyOwnerKey
    ? liveToolResults
    : EMPTY_HISTORY_LIVE_TOOL_RESULTS;
  const visibleLiveToolResultValues = useMemo(
    () => Array.from(visibleLiveToolResults.values()),
    [visibleLiveToolResults],
  );
  // A cold owner becomes data-ready before Virtuoso has mounted its first
  // measured row. Keep the loader over the already-mounted list during that
  // gap; otherwise the user sees a blank History surface. This applies to warm
  // owners too — see viewportProofRequired: a cache hit delivers data instantly
  // but not pixels.
  const viewportAwaitingFirstRange = !surfaceLoading
    && viewportProofRequired
    && displayEntries.length > 0
    && viewportReadyOwnerKey !== historyOwnerKey;
  const visibleSurfaceLoading = surfaceLoading || viewportAwaitingFirstRange;
  const historyViewportBuffer = viewportReadyOwnerKey === historyOwnerKey
    ? HISTORY_SETTLED_VIEWPORT_BUFFER
    : HISTORY_INITIAL_VIEWPORT_BUFFER;
  const publishHistorySurfacePresented = useCallback(({
    ownerKey,
    generation,
    proof,
    domRows,
    foreignDomRows,
    cache,
  }: {
    ownerKey: string;
    generation: number;
    proof: 'mounted-painted-row' | 'painted-empty-state';
    domRows: number;
    foreignDomRows: number;
    cache: 'hit' | 'miss';
  }) => {
    window.dispatchEvent(new CustomEvent('history-panel:surface-presented', {
      detail: {
        tabId,
        sessionId: sessionId || null,
        toolType,
        owner: historyOwnerDigest(ownerKey),
        generation,
        proof,
        domRows,
        foreignDomRows,
        cache,
      },
    }));
  }, [sessionId, tabId, toolType]);
  const displayEntryIndexByUuid = useMemo(() => {
    const index = new Map<string, number>();
    for (let i = 0; i < displayEntries.length; i += 1) {
      index.set(displayEntries[i].uuid, i);
    }
    return index;
  }, [displayEntries]);
  const displayEntryIndexByUuidRef = useRef(displayEntryIndexByUuid);
  displayEntryIndexByUuidRef.current = displayEntryIndexByUuid;
  const pendingInitialHistoryIndex = useMemo(() => {
    if (!historyScrollToUuid || displayEntries.length === 0) return -1;
    return displayEntryIndexByUuid.get(historyScrollToUuid) ?? -1;
  }, [displayEntryIndexByUuid, displayEntries.length, historyScrollToUuid]);
  // Reading-anchor restore target. An explicit Timeline jump wins; otherwise
  // a saved non-follow-bottom anchor puts the exact row the user last read
  // at the exact in-row offset; follow-bottom (or no anchor) starts at the
  // tail. Row identity + offset survives remounts, re-measures and app
  // restarts, unlike a raw pixel scrollTop.
  const initialAnchorLocation = useMemo(() => {
    if (displayEntries.length === 0) return null;
    const anchor = getHistoryReadingAnchor(scrollPositionKey);
    if (!anchor || anchor.followBottom) return null;
    const index = displayEntryIndexByUuid.get(anchor.uuid);
    if (index === undefined) return null;
    return {
      index,
      align: 'start' as const,
      behavior: 'auto' as const,
      offset: anchor.offsetPx,
    };
  }, [displayEntryIndexByUuid, displayEntries.length, scrollPositionKey]);
  const initialTopMostItemIndex = pendingInitialHistoryIndex >= 0
    ? { index: pendingInitialHistoryIndex, align: 'center' as const, behavior: 'auto' as const }
    : initialAnchorLocation
      ?? (displayEntries.length > 0 ? displayEntries.length - 1 : 0);
  // Measured geometry of THIS owner from its previous visit, resolved once per
  // owner (the list is keyed by owner, so it is read exactly at mount). An
  // explicit Timeline jump owns the position and must not be overridden by a
  // stored scroll offset.
  // Per-visit identity for the virtualized list.
  //
  // `restoreStateFrom` is consumed exactly once, gated on Virtuoso's own mount
  // signal — re-passing it to a live list does nothing. So a return to the same
  // tab must produce a genuine mount, and the only reliable "this is a new
  // visit" signal is the owner GENERATION, which the panel already increments
  // on every owner takeover. Deriving it from a key comparison (as a first
  // attempt did) missed returns to the same tab entirely: the key is identical,
  // so the counter never moved, the list was reused, and the restored offset
  // was silently discarded — the log showed 55846 going in while the screen sat
  // at 0 (e2e24).
  const historyOwnerVisit = historyOwnerVisitState;
  const restoredMeasuredLayout = useMemo(() => {
    if (pendingInitialHistoryIndex >= 0) return null;
    if (displayEntries.length === 0) return null;
    const layout = getHistoryMeasuredLayout(historyOwnerKey, displayEntries.length);
    if (layout) {
      historyDiag('LAYOUT_RESTORE tab=' + tabId.slice(-12)
        + ' owner=' + historyOwnerDigest(historyOwnerKey)
        + ' ranges=' + layout.ranges.length
        + ' scrollTop=' + Math.round(layout.scrollTop));
    }
    return layout;
    // Scoped to owner+visit, not to entries: re-reading on every entries
    // change would swap the restore prop mid-life and re-anchor the list under
    // the user, but scoping to the owner alone made a return to the same tab
    // reuse the FIRST visit's snapshot forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOwnerKey, historyOwnerVisit]);
  const rewindPreviewHiddenCount = rewindPreviewResult.hiddenCount;
  // Last entry uuid Claude's own backtrace reaches before stopping at the first
  // orphan. Any entry at index <= boundary is part of the chain-break zone:
  // visible in HistoryPanel through recovery, but unreachable by Claude's
  // own backtrace. Red tint marks it across all view modes (HistoryPanel
  // included) so the user sees what Claude actually has in RAM vs what we
  // recovered via physical-predecessor fallback. Compact is irrelevant —
  // orphans appear with or without compacts (rebuild / Stop / Esc / SSE).
  const [claudeMemoryBoundaryUuid, setClaudeMemoryBoundaryUuid] = useState<string | null>(
    firstRenderSnapshot?.claudeMemoryBoundaryUuid || null,
  );
  const renderClaudeMemoryBoundaryUuid = ownerChangedBeforeLayoutHandoff
    ? (firstRenderSnapshot?.claudeMemoryBoundaryUuid || null)
    : claudeMemoryBoundaryUuid;
  const claudeMemoryBoundaryIndex = useMemo(() => {
    if (!renderClaudeMemoryBoundaryUuid) return -1;
    return displayEntries.findIndex(e => e.uuid === renderClaudeMemoryBoundaryUuid);
  }, [displayEntries, renderClaudeMemoryBoundaryUuid]);
  const scrollArrowRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const isResizing = useRef(false);
  const isAtBottomRef = useRef(true);
  // Bumped by real user scroll intent and by owner change; the scroll-restore
  // convergence loop checks it each frame so it never fights the user.
  const scrollRestoreGenRef = useRef(0);
  const [controlsHeight, setControlsHeight] = useState(0);
  const controlsHeightRef = useRef(0);
  const prevVisibleUuidsRef = useRef('');
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Virtuoso's actual scroller element (filled via `scrollerRef` callback).
  // Used by Cmd+F CSS Highlight API to walk text nodes of the currently
  // mounted item range. Virtuoso unmounts off-screen items, so highlights
  // re-apply on every range change via the same effect (matchPositions deps).
  const virtuosoScrollerRef = useRef<HTMLElement | null>(null);
  const historyTailPinScheduler = useMemo(
    () => createHistoryTailPinScheduler({
      getScroller: () => virtuosoScrollerRef.current,
    }),
    [],
  );
  useEffect(
    () => () => historyTailPinScheduler.cancel(),
    [historyTailPinScheduler],
  );
  // Visible index range from Virtuoso. Drives the visible-uuid set without
  // an IntersectionObserver (cheaper, exact: no threshold guessing).
  const visibleRangeRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  // Latest entries length — let stable callbacks (scrollToBottom) read it
  // without depending on `entries` (which would invalidate downstream effects
  // on every refresh).
  const lengthRef = useRef(0);
  const panelDiagContextRef = useRef('');
  const activeHistoryToolScrollBodyRef = useRef<HTMLElement | null>(null);
  panelDiagContextRef.current = ' open=' + (isOpen ? 1 : 0) +
    ' embedded=' + (embedded ? 1 : 0) +
    ' tool=' + toolType;

  const clearHistoryToolScrollFocus = useCallback((reason: string) => {
    const activeBody = activeHistoryToolScrollBodyRef.current;
    if (!activeBody) return;
    activeBody.removeAttribute('data-hp-scroll-focus');
    const toolName = activeBody.closest('.hp-tool-scroll-scope')
      ?.getAttribute('data-history-tool-name') || 'unknown';
    activeHistoryToolScrollBodyRef.current = null;
    historyDiag('TOOL_SCROLL_FOCUS tab=' + tabId.slice(-12) +
      ' tool=' + toolName +
      ' active=0' +
      ' reason=' + reason);
  }, [tabId]);

  const activateHistoryToolScrollFocus = useCallback((body: HTMLElement) => {
    if (activeHistoryToolScrollBodyRef.current === body) return;
    clearHistoryToolScrollFocus('focus-switch');
    activeHistoryToolScrollBodyRef.current = body;
    body.setAttribute('data-hp-scroll-focus', 'true');
    const toolName = body.closest('.hp-tool-scroll-scope')
      ?.getAttribute('data-history-tool-name') || 'unknown';
    historyDiag('TOOL_SCROLL_FOCUS tab=' + tabId.slice(-12) +
      ' tool=' + toolName +
      ' active=1' +
      ' reason=block-click');
  }, [clearHistoryToolScrollFocus, tabId]);

  const handleHistoryToolPointerDown = useCallback((event: PointerEvent) => {
    const outerScroller = virtuosoScrollerRef.current;
    if (!outerScroller) return;
    const body = historyToolScrollBodyFromTarget(event.target, outerScroller);
    if (!body || !findHistoryToolInnerScroller(body, event.target)) return;
    activateHistoryToolScrollFocus(body);
  }, [activateHistoryToolScrollFocus]);

  const handleHistoryToolWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY === 0) return;
    const outerScroller = virtuosoScrollerRef.current;
    if (!outerScroller) return;
    const activeBody = activeHistoryToolScrollBodyRef.current;
    const body = historyToolScrollBodyFromTarget(event.target, outerScroller);

    // A clicked tool body owns the wheel while the pointer remains inside it.
    // Reaching its top/bottom is a clamp, not permission to chain-scroll the
    // History viewport. Ownership ends only after an explicit wheel/click
    // outside, so extra ticks at the edge cannot unexpectedly move the chat.
    if (activeBody && body === activeBody && activeBody.contains(event.target as Node)) {
      const innerScroller = findHistoryToolInnerScroller(activeBody, event.target);
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      if (!innerScroller) return;
      const scale = event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? innerScroller.clientHeight
          : 1;
      innerScroller.scrollTop += event.deltaY * scale;
      return;
    }
    if (activeBody) {
      clearHistoryToolScrollFocus('outside-wheel');
    }

    if (!body) return;
    const innerScroller = findHistoryToolInnerScroller(body, event.target);
    if (!innerScroller) return;
    if (event.cancelable) event.preventDefault();
    const scale = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? outerScroller.clientHeight
        : 1;
    outerScroller.scrollTop += event.deltaY * scale;
  }, [clearHistoryToolScrollFocus]);

  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      const activeBody = activeHistoryToolScrollBodyRef.current;
      if (activeBody && !activeBody.contains(event.target as Node)) {
        clearHistoryToolScrollFocus('outside-click');
      }
    };
    document.addEventListener('pointerdown', handleOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer, true);
      clearHistoryToolScrollFocus('unmount');
    };
  }, [clearHistoryToolScrollFocus]);

  // ========== SEARCH ==========
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Build flat list of match positions: { entryIdx, entryUuid, offset }
  const matchPositions = useMemo(() => {
    if (!searchQuery || searchQuery.length < 2) return [];
    const q = searchQuery.toLowerCase();
    const positions: Array<{ entryIdx: number; entryUuid: string; offset: number }> = [];
    for (let i = 0; i < displayEntries.length; i++) {
      const text = (displayEntries[i].content || '').toLowerCase();
      let idx = text.indexOf(q);
      while (idx !== -1) {
        positions.push({ entryIdx: i, entryUuid: displayEntries[i].uuid, offset: idx });
        idx = text.indexOf(q, idx + 1);
      }
    }
    return positions;
  }, [displayEntries, searchQuery]);

  // Reset current match when query changes and scroll to first match
  useEffect(() => {
    if (matchPositions.length > 0) {
      setCurrentMatchIdx(0);
      const match = matchPositions[0];
      virtuosoRef.current?.scrollToIndex({ index: match.entryIdx, align: 'center', behavior: 'smooth' });
    }
  }, [searchQuery]);

  // Navigate to current match entry
  const scrollToMatch = useCallback((idx: number) => {
    if (idx < 0 || idx >= matchPositions.length) return;
    const match = matchPositions[idx];
    virtuosoRef.current?.scrollToIndex({ index: match.entryIdx, align: 'center', behavior: 'smooth' });
  }, [matchPositions]);

  const goNextMatch = useCallback(() => {
    if (matchPositions.length === 0) return;
    const next = (currentMatchIdx + 1) % matchPositions.length;
    setCurrentMatchIdx(next);
    scrollToMatch(next);
  }, [currentMatchIdx, matchPositions.length, scrollToMatch]);

  const goPrevMatch = useCallback(() => {
    if (matchPositions.length === 0) return;
    const prev = (currentMatchIdx - 1 + matchPositions.length) % matchPositions.length;
    setCurrentMatchIdx(prev);
    scrollToMatch(prev);
  }, [currentMatchIdx, matchPositions.length, scrollToMatch]);

  // CSS Highlight API — apply highlights after render
  useEffect(() => {
    const CSS_HL = (CSS as any).highlights;
    if (!CSS_HL || !virtuosoScrollerRef.current) {
      CSS_HL?.delete('hp-search');
      CSS_HL?.delete('hp-search-current');
      return;
    }
    if (!searchQuery || searchQuery.length < 2 || matchPositions.length === 0) {
      CSS_HL.delete('hp-search');
      CSS_HL.delete('hp-search-current');
      return;
    }

    // Debounce DOM traversal slightly
    const timer = setTimeout(() => {
      const q = searchQuery.toLowerCase();
      const qLen = searchQuery.length;
      const allRanges: Range[] = [];
      const currentRanges: Range[] = [];
      const currentMatch = matchPositions[currentMatchIdx];

      // Walk all text nodes in scroll container
      const walker = document.createTreeWalker(virtuosoScrollerRef.current!, NodeFilter.SHOW_TEXT);
      // Track which data-uuid entry we're inside + occurrence index per entry
      const entryOccurrences = new Map<string, number>();

      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const text = node.textContent?.toLowerCase();
        if (!text) continue;

        // Find which entry this node belongs to
        let entryUuid = '';
        let parent = node.parentElement;
        while (parent && parent !== virtuosoScrollerRef.current) {
          if (parent.dataset?.uuid) { entryUuid = parent.dataset.uuid; break; }
          parent = parent.parentElement;
        }

        let idx = text.indexOf(q);
        while (idx !== -1) {
          try {
            const range = new Range();
            range.setStart(node, idx);
            range.setEnd(node, idx + qLen);
            allRanges.push(range);

            // Check if this is the current match
            if (currentMatch && entryUuid === currentMatch.entryUuid) {
              const occ = entryOccurrences.get(entryUuid) || 0;
              // Find how many matches exist for this entry before currentMatchIdx
              const entryMatches = matchPositions.filter(m => m.entryUuid === entryUuid);
              const localIdx = entryMatches.findIndex(m => m === currentMatch);
              if (occ === localIdx) {
                currentRanges.push(range);
              }
              entryOccurrences.set(entryUuid, occ + 1);
            }
          } catch {}
          idx = text.indexOf(q, idx + 1);
        }
      }

      if (allRanges.length > 0) {
        CSS_HL.set('hp-search', new (window as any).Highlight(...allRanges));
      } else {
        CSS_HL.delete('hp-search');
      }
      if (currentRanges.length > 0) {
        CSS_HL.set('hp-search-current', new (window as any).Highlight(...currentRanges));
      } else {
        CSS_HL.delete('hp-search-current');
      }
    }, 50);

    return () => {
      clearTimeout(timer);
      CSS_HL?.delete('hp-search');
      CSS_HL?.delete('hp-search-current');
    };
  }, [searchQuery, matchPositions, currentMatchIdx, displayEntries]);

  // Ctrl+F handler — scoped to history panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.metaKey && e.key === 'f') {
        // Cmd+F follows the CENTER surface: whichever one the user is looking
        // at owns find. In terminal-primary that is the terminal, so this
        // panel keeps its own search behind the header button instead of
        // stealing the shortcut from the surface filling the window.
        if (terminalIsPrimary) return;
        if (mainSurface && terminalOpen) return;
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape' && searchOpen) {
        e.stopPropagation();
        setSearchOpen(false);
        setSearchQuery('');
        setCurrentMatchIdx(0);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true); // capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, mainSurface, searchOpen, terminalOpen, terminalIsPrimary]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setCurrentMatchIdx(0);
  }, []);

  useEffect(() => {
    // Opening the floating terminal hands find over to it — but in
    // terminal-primary the terminal is permanently shown, and closing this
    // panel's search on that basis would make it impossible to keep open.
    if (mainSurface && terminalOpen && !terminalIsPrimary && searchOpen) closeSearch();
  }, [closeSearch, mainSurface, searchOpen, terminalOpen, terminalIsPrimary]);

  // Explicit jump-to-bottom helper. First let Virtuoso materialize/measure the
  // final transcript row, then include the composer spacer in the final pixel
  // position. Normal streaming is owned by Virtuoso followOutput; the
  // cancellable scheduler is reserved for composer-height changes.
  // Reads the latest length via ref so consumer effects don't need to depend
  // on `entries` (the callback identity stays stable).
  const scrollToBottom = useCallback((smooth = false) => {
    scheduleHistoryBottomScroll({
      virtuoso: virtuosoRef.current,
      itemCount: lengthRef.current,
      getScroller: () => virtuosoScrollerRef.current,
      smooth,
    });
  }, []);

  const handleControlsHeightChange = useCallback((height: number) => {
    const nextHeight = Math.max(0, Math.ceil(height));
    if (controlsHeightRef.current === nextHeight) return;
    const previousHeight = controlsHeightRef.current;
    // Re-pin permission is read from the LIVE scroller, not from the cached
    // flag. The cached one is only as fresh as the last scroll event, and the
    // composer resizes on its own schedule while the agent streams — so a user
    // reading upward kept being yanked back down (prod 26.07: three unrequested
    // jumps to the tail in 8s while the pointer never moved). Reading position
    // now makes the decision reflect where the user actually is.
    //
    // The intent flag still wins when it says "not at bottom": a wheel-up is
    // recorded there immediately, before the 4px pin threshold is even cleared,
    // and that intent must not be overridden by a scroller that has not moved
    // far enough yet.
    const scroller = virtuosoScrollerRef.current;
    const liveAtBottom = scroller ? isHistoryTailPinned(scroller) : null;
    const shouldKeepTailVisible = isAtBottomRef.current
      && (liveAtBottom === null || liveAtBottom);
    controlsHeightRef.current = nextHeight;
    setControlsHeight(nextHeight);
    onControlsHeightChange?.(nextHeight);
    historyDiag('COMPOSER_HEIGHT tab=' + tabId.slice(-12) +
      ' from=' + previousHeight +
      ' to=' + nextHeight +
      ' main=' + (mainSurface ? '1' : '0') +
      ' atBottom=' + (shouldKeepTailVisible ? '1' : '0') +
      ' cachedAtBottom=' + (isAtBottomRef.current ? '1' : '0') +
      ' liveAtBottom=' + (liveAtBottom === null ? 'na' : liveAtBottom ? '1' : '0'));
    if (mainSurface) {
      historyTailPinScheduler.schedule({ shouldPin: shouldKeepTailVisible });
    }
  }, [historyTailPinScheduler, mainSurface, onControlsHeightChange, tabId]);

  const appendLocalPromptEntry = useCallback((
    text: string,
    queueStatus: 'sending' | 'queued' | 'sent',
    meta: {
      handoffId: string;
      statusAtSend: AgentPtyStatus;
      submittedAt: number;
      promptChips?: HistoryPromptDraftChip[];
      requiresAuditIdentity?: boolean;
      auditTimestamp?: string;
      auditHash?: string;
      auditSessionId?: string;
      auditEntryUuid?: string;
      sourceIdentity?: string;
      sessionId?: string;
    }
  ) => {
    const cleanContent = normalizeHistoryPromptText(text);
    if (!cleanContent) return;
    const now = Date.now();
    const submittedAt = Number.isFinite(meta.submittedAt)
      ? Number(meta.submittedAt)
      : now;
    const handoffId = meta.handoffId || createPromptHandoffId();
    const resolvedSessionId = meta.auditSessionId || meta.sessionId || sessionId;
    const entry: FullHistoryEntry = {
      uuid: LOCAL_PROMPT_PREFIX + tabId + '-' + handoffId,
      role: 'queued',
      queueStatus,
      statusAtSend: meta.statusAtSend,
      handoffId,
      statusReason: queueStatus === 'sending' ? 'send-start' : 'send-result',
      timestamp: new Date(submittedAt).toISOString(),
      content: cleanContent,
      sessionId: resolvedSessionId,
      optimisticAt: submittedAt,
      statusChangedAt: now,
      promptChips: normalizeComposerChips(meta.promptChips || [])
        .filter((chip) => chip.kind === 'prompt') as HistoryPromptDraftChip[],
      requiresAuditIdentity: meta.requiresAuditIdentity === true,
      auditTimestamp: meta.auditTimestamp,
      auditHash: meta.auditHash,
      auditSessionId: meta.auditSessionId,
      auditEntryUuid: meta.auditEntryUuid,
      sourceIdentity: meta.sourceIdentity,
    };
    promptHandoffMetaRef.current.set(handoffId, {
      text: cleanContent,
      submittedAt,
      sessionId: resolvedSessionId,
      requiresAuditIdentity: meta.requiresAuditIdentity === true,
      auditTimestamp: meta.auditTimestamp,
      auditHash: meta.auditHash,
      auditEntryUuid: meta.auditEntryUuid,
      sourceIdentity: meta.sourceIdentity,
    });
    historyDiag('LOCAL_APPEND tab=' + tabId.slice(-12) +
      ' handoff=' + handoffId +
      ' queueStatus=' + queueStatus +
      ' statusAtSend=' + meta.statusAtSend +
      ' chars=' + cleanContent.length +
      ' submittedLagMs=' + (now - submittedAt) +
      ' preview="' + promptPreview(cleanContent) + '"');
    setEntries(prev => {
      const existingIndex = prev.findIndex((candidate) =>
        isLocalPromptEntry(candidate) && candidate.handoffId === handoffId
      );
      const nextEntries = existingIndex < 0
        ? [...prev, entry]
        : prev.map((candidate, index) => index === existingIndex
          ? {
              ...candidate,
              queueStatus,
              statusAtSend: entry.statusAtSend,
              statusReason: entry.statusReason,
              statusChangedAt: now,
              promptChips: entry.promptChips,
              requiresAuditIdentity: entry.requiresAuditIdentity,
              auditTimestamp: entry.auditTimestamp,
              auditHash: entry.auditHash,
              auditSessionId: entry.auditSessionId,
              auditEntryUuid: entry.auditEntryUuid,
              sourceIdentity: entry.sourceIdentity,
              sessionId: entry.sessionId,
            }
          : candidate);
      presentationEntriesRef.current = nextEntries;
      persistVolatileOverlay(historySnapshotOwner, nextEntries);
      return nextEntries;
    });
  }, [historySnapshotOwner, persistVolatileOverlay, sessionId, tabId]);

  const updateLocalPromptEntry = useCallback((
    handoffId: string,
    queueStatus: 'queued' | 'sent' | 'cancelled' | 'failed',
    reason: string,
    identity?: {
      requiresAuditIdentity?: boolean;
      auditTimestamp?: string;
      auditHash?: string;
      auditSessionId?: string;
      auditEntryUuid?: string;
      sourceIdentity?: string;
    },
    changedAtOverride?: number,
  ) => {
    if (!handoffId) return;
    const changedAt = Number.isFinite(changedAtOverride)
      ? Number(changedAtOverride)
      : Date.now();
    const handoffMeta = promptHandoffMetaRef.current.get(handoffId) || null;
    if (handoffMeta && identity) {
      promptHandoffMetaRef.current.set(handoffId, {
        ...handoffMeta,
        requiresAuditIdentity: identity.requiresAuditIdentity,
        auditTimestamp: identity.auditTimestamp,
        auditHash: identity.auditHash,
        auditEntryUuid: identity.auditEntryUuid,
        sourceIdentity: identity.sourceIdentity,
        sessionId: identity.auditSessionId || handoffMeta.sessionId,
      });
    }
    const durableAlreadyExists = !!handoffMeta && serverHasPromptEntry(
      rawServerEntriesRef.current,
      {
        uuid: LOCAL_PROMPT_PREFIX + handoffId,
        role: 'queued',
        content: handoffMeta.text,
        timestamp: new Date(handoffMeta.submittedAt).toISOString(),
        optimisticAt: handoffMeta.submittedAt,
        requiresAuditIdentity: identity?.requiresAuditIdentity === true
          || handoffMeta.requiresAuditIdentity === true,
        auditTimestamp: identity?.auditTimestamp || handoffMeta.auditTimestamp,
        auditHash: identity?.auditHash || handoffMeta.auditHash,
        auditSessionId: identity?.auditSessionId || handoffMeta.sessionId,
        auditEntryUuid: identity?.auditEntryUuid || handoffMeta.auditEntryUuid,
        sourceIdentity: identity?.sourceIdentity || handoffMeta.sourceIdentity,
        sessionId: identity?.auditSessionId || handoffMeta.sessionId || sessionId,
      } as FullHistoryEntry,
    );
    if ((queueStatus === 'cancelled' || queueStatus === 'failed') && durableAlreadyExists) {
      historyDiag('LOCAL_STATUS_IGNORED tab=' + tabId.slice(-12) +
        ' handoff=' + handoffId +
        ' queueStatus=' + queueStatus +
        ' reason=' + reason +
        ' durable=1');
      return;
    }
    let suppression: SuppressedPrompt | null = null;
    const suppressionRequiresAudit = identity?.requiresAuditIdentity === true
      || handoffMeta?.requiresAuditIdentity === true;
    const suppressionAuditTimestamp = identity?.auditTimestamp || handoffMeta?.auditTimestamp;
    if (
      (queueStatus === 'cancelled' || queueStatus === 'failed')
      && handoffMeta?.text
      && (!suppressionRequiresAudit || !!suppressionAuditTimestamp)
    ) {
      suppression = {
        handoffId,
        text: handoffMeta.text,
        requiresAuditIdentity: suppressionRequiresAudit,
        auditTimestamp: suppressionAuditTimestamp,
        auditSessionId: identity?.auditSessionId || handoffMeta.sessionId,
        sourceIdentity: identity?.sourceIdentity || handoffMeta.sourceIdentity,
        since: handoffMeta.submittedAt - 5000,
        until: changedAt + 10000,
        expiresAt: changedAt + 5 * 60 * 1000,
        reason,
      };
      suppressedPromptsRef.current.set(handoffId, suppression);
      historyDiag('SUPPRESS_ARMED tab=' + tabId.slice(-12) +
        ' handoff=' + handoffId +
        ' reason=' + reason +
        ' since=' + suppression.since +
        ' until=' + suppression.until +
        ' expiresAt=' + suppression.expiresAt +
        ' preview="' + promptPreview(handoffMeta.text) + '"');
    }
    setEntries(prev => {
      const nextEntries = prev.map(entry => {
        if (!isLocalPromptEntry(entry) || entry.handoffId !== handoffId) return entry;
        historyDiag('LOCAL_STATUS tab=' + tabId.slice(-12) +
          ' handoff=' + handoffId +
          ' queueStatus=' + queueStatus +
          ' reason=' + reason +
          ' prev=' + (entry.queueStatus || 'queued') +
          ' ageMs=' + (changedAt - (entry.optimisticAt || changedAt)));
        return {
          ...entry,
          queueStatus,
          statusReason: reason,
          statusChangedAt: changedAt,
          ...(identity
            ? {
                requiresAuditIdentity: identity.requiresAuditIdentity === true,
                auditTimestamp: identity.auditTimestamp,
                auditHash: identity.auditHash,
                auditSessionId: identity.auditSessionId,
                auditEntryUuid: identity.auditEntryUuid,
                sourceIdentity: identity.sourceIdentity,
                sessionId: identity.auditSessionId || entry.sessionId,
              }
            : {}),
        };
      }).filter(entry => !suppression || !entryMatchesSuppressedPrompt(entry, suppression));
      presentationEntriesRef.current = nextEntries;
      persistVolatileOverlay(historySnapshotOwner, nextEntries);
      return nextEntries;
    });
  }, [historySnapshotOwner, persistVolatileOverlay, sessionId, tabId]);

  const removeLocalPromptEntry = useCallback((handoffId: string, reason: string) => {
    if (!handoffId) return;
    promptHandoffMetaRef.current.delete(handoffId);
    suppressedPromptsRef.current.delete(handoffId);
    setEntries((prev) => {
      const nextEntries = prev.filter((entry) =>
        !isLocalPromptEntry(entry) || entry.handoffId !== handoffId
      );
      if (nextEntries.length === prev.length) return prev;
      historyDiag('LOCAL_REMOVE tab=' + tabId.slice(-12) +
        ' handoff=' + handoffId +
        ' reason=' + reason);
      presentationEntriesRef.current = nextEntries;
      persistVolatileOverlay(historySnapshotOwner, nextEntries);
      return nextEntries;
    });
  }, [historySnapshotOwner, persistVolatileOverlay, tabId]);

  useEffect(() => subscribeHistoryPromptHandoffs(tabId, (snapshot, change) => {
    if (change.type === 'consume' || change.type === 'retract' || change.type === 'evict') {
      removeLocalPromptEntry(change.handoffId, 'handoff-' + change.type);
      return;
    }
    const records = change.type === 'replay'
      ? snapshot
      : snapshot.filter((record) => record.handoffId === change.handoffId);
    for (const record of records) {
      if (record.toolType !== toolType) continue;
      const sessionRoute = resolveHistoryPromptHandoffPresentationSession({
        auditSessionId: record.auditProof?.sessionId,
        sessionIdHint: record.sessionIdHint,
        currentSessionId: sessionId,
      });
      const auditSessionId = sessionRoute.exactSessionId || undefined;
      if (!sessionRoute.belongsToCurrent) {
        removeLocalPromptEntry(record.handoffId, 'handoff-audit-session-mismatch');
        continue;
      }
      const promptChips = record.promptChips.map((chip, index) => ({
        id: chip.id || record.handoffId + '-chip-' + index,
        kind: 'prompt' as const,
        text: chip.text,
        label: chip.label,
        sourceKey: chip.sourceKey,
      }));
      const identity = {
        requiresAuditIdentity: record.requiresAuditIdentity,
        auditTimestamp: record.auditProof?.auditTimestamp,
        auditHash: record.auditProof?.actualHash,
        auditSessionId,
        auditEntryUuid: record.auditProof?.entryUuid,
        sourceIdentity: record.auditProof?.sourceIdentity,
      };
      if (
        record.queueStatus === 'sending'
        || record.queueStatus === 'queued'
        || record.queueStatus === 'sent'
      ) {
        appendLocalPromptEntry(record.text, record.queueStatus, {
          handoffId: record.handoffId,
          statusAtSend: record.statusAtSend,
          submittedAt: record.submittedAt,
          promptChips,
          sessionId: sessionRoute.presentationSessionId,
          ...identity,
        });
      } else {
        // A failed/retracted result can be replayed after History mounts. Seed
        // the same local identity first so the existing failure/suppression
        // path remains the single presentation owner.
        appendLocalPromptEntry(record.text, 'sending', {
          handoffId: record.handoffId,
          statusAtSend: record.statusAtSend,
          submittedAt: record.submittedAt,
          promptChips,
          sessionId: sessionRoute.presentationSessionId,
          ...identity,
        });
        updateLocalPromptEntry(
          record.handoffId,
          record.queueStatus,
          record.statusReason,
          identity,
          record.statusChangedAt,
        );
      }
    }
  }), [
    appendLocalPromptEntry,
    removeLocalPromptEntry,
    sessionId,
    tabId,
    toolType,
    updateLocalPromptEntry,
  ]);

  useEffect(() => {
    let disposed = false;
    let eventRevision = 0;
    const settleOperationHandoff = (operation: CompactOperationalPhase) => {
      if (!operation.handoffId) return;
      removeLocalPromptEntry(
        operation.handoffId,
        'compact-' + (operation.outcome || 'unknown'),
      );
      consumeHistoryPromptHandoff(tabId, operation.handoffId);
    };
    const applyOperation = (operation: CompactOperationalPhase | null | undefined) => {
      if (!operation || operation.tabId !== tabId || operation.provider !== toolType) return;
      if (operation.active && operation.phase === 'compacting') {
        setCompactOperationalPhase(operation);
        return;
      }
      settleOperationHandoff(operation);
      setCompactOperationalPhase((current) => (
        !current || current.operationId === operation.operationId ? null : current
      ));
    };
    const handleOperationalPhase = (_event: unknown, operation: CompactOperationalPhase) => {
      eventRevision += 1;
      applyOperation(operation);
    };

    setCompactOperationalPhase(null);
    ipcRenderer.on('agent:operational-phase', handleOperationalPhase);
    const revisionAtRequest = eventRevision;
    void ipcRenderer.invoke('agent:get-operational-phase', {
      tabId,
      provider: toolType,
    }).then((snapshot: {
      active?: CompactOperationalPhase | null;
      settled?: CompactOperationalPhase[];
    }) => {
      if (disposed) return;
      for (const operation of snapshot?.settled || []) settleOperationHandoff(operation);
      // An event delivered while the snapshot request was in flight is newer
      // than that snapshot and must not be overwritten by its late response.
      if (eventRevision === revisionAtRequest) {
        setCompactOperationalPhase(snapshot?.active || null);
      }
    }).catch((error: unknown) => {
      console.warn('[HistoryCompactPhase] snapshot failed tab=' + tabId.slice(-12)
        + ' provider=' + toolType
        + ' error=' + (error instanceof Error ? error.message : String(error)));
    });
    return () => {
      disposed = true;
      ipcRenderer.removeListener('agent:operational-phase', handleOperationalPhase);
    };
  }, [removeLocalPromptEntry, tabId, toolType]);

  const hasDurablePrompt = useCallback((text: string, submittedAt: number) => (
    serverHasPromptEntry(
      rawServerEntriesRef.current,
      {
        uuid: LOCAL_PROMPT_PREFIX + 'durable-check',
        role: 'queued',
        content: text,
        timestamp: new Date(submittedAt).toISOString(),
        optimisticAt: submittedAt,
      } as FullHistoryEntry,
    )
  ), []);

  const upsertLocalRewindEntry = useCallback((detail: {
    tabId?: string;
    opId?: string;
    status?: 'start' | 'done' | 'failed';
    targetUuid?: string;
    targetText?: string;
    historyDraftText?: string;
    historyDraftImages?: HistoryPromptDraftImageRef[];
    historyDraftChips?: HistoryPromptDraftChip[];
    historyDraftWarning?: string;
    mode?: 'native' | 'ai';
    toolType?: string;
    sourceSessionId?: string | null;
    writerGeneration?: string;
    persisted?: boolean;
    historyInputDraft?: boolean;
    error?: string;
    message?: string;
  }) => {
    if (detail.tabId !== tabId) return;
    // Owner guard for ROW-INSERTING events only ('start'/'failed'): a late
    // event from the SOURCE branch of a completed Rewind must not inject a
    // local rewind row into the adopted CHILD owner's overlay. 'done' is
    // exempt on purpose — a successful Codex Rewind swaps the tab session
    // BEFORE emitting done, so the done event legitimately carries the source
    // id; it only removes rows and restores the draft (tab-level, idempotent).
    // Events without a session stamp stay tab-scoped (legacy emitters).
    if (
      detail.status !== 'done'
      && typeof detail.sourceSessionId === 'string'
      && detail.sourceSessionId
      && sessionId
      && detail.sourceSessionId !== sessionId
    ) {
      historyDiag('REWIND_LOG_STALE_OWNER tab=' + tabId.slice(-12)
        + ' op=' + (detail.opId || '-')
        + ' eventSession=' + detail.sourceSessionId.slice(0, 8)
        + ' currentSession=' + String(sessionId).slice(0, 8)
        + ' status=' + (detail.status || 'start'));
      // A late-stage rewind failure can land after the tab already adopted
      // the child session (Codex swaps before the result settles). The row
      // belongs to the source overlay and is dropped, but the failure itself
      // is tab-level news the user must still see — otherwise the rewind
      // dies silently with no failed row and no error banner.
      if (detail.status === 'failed') {
        window.dispatchEvent(new CustomEvent('history-panel:agent-error', {
          detail: {
            tabId,
            message: String(detail.error || detail.message || 'Rewind failed'),
          },
        }));
      }
      return;
    }
    const opId = detail.opId || String(Date.now());
    const status = detail.status || 'start';
    const targetText = normalizeHistoryPromptText(detail.targetText || '');
    const historyDraftText = normalizeHistoryPromptText(detail.historyDraftText || targetText);
    const historyDraftImages = Array.isArray(detail.historyDraftImages) ? detail.historyDraftImages : [];
    const exactTargetEntry = detail.targetUuid
      ? entriesRef.current.find((entry) => entry.uuid === detail.targetUuid && entry.role === 'user') || null
      : null;
    if (status === 'start' && !rewindDraftPresentationRef.current.has(opId)) {
      const capturedPresentation = splitPromptChipPresentation({
        text: targetText || exactTargetEntry?.content || '',
        chips: exactTargetEntry?.promptChips || [],
      });
      rewindDraftPresentationRef.current.set(opId, {
        text: capturedPresentation.text,
        chips: capturedPresentation.chips,
      });
      historyDiag('REWIND_DRAFT_CAPTURE tab=' + tabId.slice(-12)
        + ' op=' + opId
        + ' entry=' + String(detail.targetUuid || '-').slice(0, 8)
        + ' chips=' + capturedPresentation.chips.length
        + ' chars=' + capturedPresentation.text.length);
    }
    const capturedPresentation = rewindDraftPresentationRef.current.get(opId) || null;
    const restoredPresentation = splitPromptChipPresentation({
      text: historyDraftText || capturedPresentation?.text || targetText,
      chips: Array.isArray(detail.historyDraftChips)
        ? detail.historyDraftChips
        : capturedPresentation?.chips || exactTargetEntry?.promptChips || [],
    });
    const restoredDraftOptions = {
      images: historyDraftImages,
      chips: restoredPresentation.chips,
    };
    const now = Date.now();
    const uuid = LOCAL_REWIND_PREFIX + tabId + '-' + opId;
    const detailMessage = String(detail.error || detail.message || '');
    if (status === 'failed' && isRewindBusyGuardMessage(detailMessage)) {
      rewindDraftPresentationRef.current.delete(opId);
      setEntries(prev => {
        const nextEntries = prev.filter(entry => entry.uuid !== uuid);
        presentationEntriesRef.current = nextEntries;
        persistVolatileOverlay(historySnapshotOwner, nextEntries);
        return nextEntries;
      });
      window.dispatchEvent(new CustomEvent('history-panel:agent-error', {
        detail: { tabId, message: detailMessage }
      }));
      return;
    }
    const rewindStatus: FullHistoryEntry['rewindStatus'] =
      status === 'failed' ? 'failed' : status === 'done' ? 'done' : 'rewinding';
    const content = detail.message
      ? detail.message
      : status === 'failed'
      ? (detail.error ? 'Failed: ' + detail.error : 'Rewind failed')
      : targetText
        ? 'Target: ' + targetText
        : 'Native /rewind';

    const removeLocalRewindEntry = () => {
      setEntries(prev => {
        const nextEntries = prev.filter(entry => entry.uuid !== uuid);
        presentationEntriesRef.current = nextEntries;
        persistVolatileOverlay(historySnapshotOwner, nextEntries);
        return nextEntries;
      });
    };
    const isDurableRewind =
      status === 'done' && (
        detail.persisted === true ||
        detail.mode === 'ai' ||
        detail.toolType === 'gemini'
      );
    if (isDurableRewind) {
      setHistoryRewindPreview(tabId, null);
      if (historyDraftText && detail.historyInputDraft === true) {
        setHistoryPromptDraft(tabId, restoredPresentation.text, restoredDraftOptions);
        if (detail.historyDraftWarning) {
          window.dispatchEvent(new CustomEvent('history-panel:draft-warning', {
            detail: { tabId, message: detail.historyDraftWarning },
          }));
        }
      }
      removeLocalRewindEntry();
      rewindDraftPresentationRef.current.delete(opId);
      return;
    }
    const nativePreviewTool = detail.toolType || toolType;
    if (
      status === 'done'
      && detail.mode === 'native'
      && detail.targetUuid
      && targetText
      && (nativePreviewTool === 'claude' || nativePreviewTool === 'codex')
    ) {
      setHistoryRewindPreview(tabId, {
        opId,
        targetUuid: detail.targetUuid,
        targetText,
        startedAt: now,
        sessionId,
        writerGeneration: detail.writerGeneration,
      });
      setHistoryPromptDraft(tabId, restoredPresentation.text, restoredDraftOptions);
      if (detail.historyDraftWarning) {
        window.dispatchEvent(new CustomEvent('history-panel:draft-warning', {
          detail: { tabId, message: detail.historyDraftWarning },
        }));
      }
    }
    if (status !== 'failed') {
      removeLocalRewindEntry();
      if (status === 'done') rewindDraftPresentationRef.current.delete(opId);
      return;
    }
    rewindDraftPresentationRef.current.delete(opId);
    setEntries(prev => {
      const idx = prev.findIndex(entry => entry.uuid === uuid);
      const nextEntry: FullHistoryEntry = {
        uuid,
        role: 'rewind',
        rewindStatus,
        timestamp: new Date(now).toISOString(),
        content,
        sessionId,
        optimisticAt: now,
      };
      const next = idx < 0 ? [...prev, nextEntry] : [...prev];
      if (idx >= 0) next[idx] = { ...next[idx], ...nextEntry };
      presentationEntriesRef.current = next;
      persistVolatileOverlay(historySnapshotOwner, next);
      return next;
    });
  }, [historySnapshotOwner, persistVolatileOverlay, sessionId, setHistoryPromptDraft, setHistoryRewindPreview, tabId, toolType]);

  useEffect(() => {
    const previousOwner = rewindPreviewOwnerRef.current;
    const currentOwner = { tabId, sessionId };
    rewindPreviewOwnerRef.current = currentOwner;
    if (shouldClearRewindPreviewForOwnerTransition(previousOwner, currentOwner)) {
      setHistoryRewindPreview(tabId, null);
    }
  }, [tabId, sessionId, setHistoryRewindPreview]);

  useEffect(() => {
    const clearPreview = (_event: any, data: { tabId?: string }) => {
      if (data?.tabId === tabId) setHistoryRewindPreview(tabId, null);
    };
    ipcRenderer.on('terminal:command-finished', clearPreview);
    ipcRenderer.on('terminal:command-started', clearPreview);
    return () => {
      ipcRenderer.removeListener('terminal:command-finished', clearPreview);
      ipcRenderer.removeListener('terminal:command-started', clearPreview);
    };
  }, [tabId, setHistoryRewindPreview]);

  const consumeMaterializedPromptHandoffs = useCallback((serverEntries: FullHistoryEntry[]) => {
    const consumedServerUuids = new Set<string>();
    const handoffs = [...getHistoryPromptHandoffsSnapshot(tabId)]
      .sort((left, right) => left.submittedAt - right.submittedAt);
    for (const handoff of handoffs) {
      if (handoff.toolType !== toolType) continue;
      const localIdentity: FullHistoryEntry = {
        uuid: LOCAL_PROMPT_PREFIX + tabId + '-' + handoff.handoffId,
        role: 'queued',
        timestamp: new Date(handoff.submittedAt).toISOString(),
        content: normalizeHistoryPromptText(handoff.text),
        sessionId: handoff.auditProof?.sessionId || handoff.sessionIdHint || sessionId,
        optimisticAt: handoff.submittedAt,
        queueStatus: handoff.queueStatus,
        statusReason: handoff.statusReason,
        requiresAuditIdentity: handoff.requiresAuditIdentity,
        auditTimestamp: handoff.auditProof?.auditTimestamp,
        auditHash: handoff.auditProof?.actualHash,
        auditSessionId: handoff.auditProof?.sessionId || undefined,
        auditEntryUuid: handoff.auditProof?.entryUuid,
        sourceIdentity: handoff.auditProof?.sourceIdentity,
      };
      const matched = findServerPromptEntry(
        serverEntries,
        localIdentity,
        consumedServerUuids,
      );
      if (!matched) continue;
      consumedServerUuids.add(matched.uuid);
      consumeHistoryPromptHandoff(tabId, handoff.handoffId);
      historyDiag('HANDOFF_CONSUMED tab=' + tabId.slice(-12) +
        ' handoff=' + handoff.handoffId +
        ' proof=' + (handoff.auditProof ? 'audit' : 'fallback'));
    }
  }, [sessionId, tabId, toolType]);

  // Load full history
  const runHistoryLoad = useCallback(async (isRefresh = false) => {
    const ownerKeyAtStart = historyOwnerKey;
    const generationAtStart = historyOwnerGenerationRef.current;
    const loadSequence = ++historyLoadSequenceRef.current;
    const loadStartedAt = Date.now();
    const isCurrentOwner = () => (
      historyOwnerKeyRef.current === ownerKeyAtStart &&
      historyOwnerGenerationRef.current === generationAtStart
    );
    if (!sessionId) {
      if (!isCurrentOwner()) {
        historyDiag('LOAD_STALE_DROP tab=' + tabId.slice(-12) +
          ' seq=' + loadSequence +
          ' phase=no-session');
        return false;
      }
      lastServerEntryUuidsRef.current = new Set();
      rawServerEntriesRef.current = [];
      setClaudeMemoryBoundaryUuid(null);
      historyRevisionRef.current = null;
      presentationEntriesRef.current = [];
      setEntries((current) => current.length === 0 ? current : []);
      historyLoaderReasonRef.current = 'no-session';
      setLoading(false);
      historyDiag('LOAD_EMPTY tab=' + tabId.slice(-12) +
        ' seq=' + loadSequence +
        ' elapsedMs=' + (Date.now() - loadStartedAt));
      return true;
    }
    const housekeepingNow = Date.now();
    let suppressionsExpired = false;
    for (const [handoffId, suppressed] of suppressedPromptsRef.current) {
      if (suppressed.expiresAt > housekeepingNow) continue;
      suppressedPromptsRef.current.delete(handoffId);
      promptHandoffMetaRef.current.delete(handoffId);
      suppressionsExpired = true;
      historyDiag('SUPPRESS_EXPIRED tab=' + tabId.slice(-12) +
        ' handoff=' + handoffId +
        ' reason=' + suppressed.reason);
    }
    if (suppressionsExpired) {
      persistVolatileOverlay(historySnapshotOwner, presentationEntriesRef.current);
    }
    const cachedRawSnapshot = historySnapshotCache.peek<FullHistoryEntry>(historySnapshotOwner);
    const needsRawForPresentation =
      suppressionsExpired || suppressedPromptsRef.current.size > 0;
    const revisionForRequest =
      isRefresh && (!needsRawForPresentation || !!cachedRawSnapshot)
        ? historyRevisionRef.current
        : null;
    historyDiag('LOAD_START tab=' + tabId.slice(-12) +
      ' session=' + sessionId.slice(0, 8) +
      ' tool=' + toolType +
      ' owner=' + historyOwnerDigest(ownerKeyAtStart) +
      ' seq=' + loadSequence +
      ' generation=' + generationAtStart +
      ' refresh=' + (isRefresh ? '1' : '0') +
      ' cache=' + (cachedRawSnapshot ? 'hit' : 'miss') +
      ' cacheEntries=' + (cachedRawSnapshot?.entries.length || 0) +
      ' cacheAgeMs=' + (cachedRawSnapshot ? Math.max(0, Date.now() - cachedRawSnapshot.capturedAt) : -1) +
      ' requestRevision=' + (revisionForRequest ? '1' : '0'));
    try {
      const ipcChannel = toolType === 'gemini' ? 'gemini:get-full-history' : toolType === 'codex' ? 'agent-transcript:get-history' : 'claude:get-full-history';
      const result = await ipcRenderer.invoke(ipcChannel, {
        toolType,
        sessionId,
        cwd,
        tabId,
        ifRevision: revisionForRequest,
        // Desktop History rehydrates payloads on card expand; heavy tool
        // outputs/thinking arrive as previews + refs instead of megabytes.
        dehydrate: true,
      });
      if (!isCurrentOwner()) {
        historyDiag('LOAD_STALE_DROP tab=' + tabId.slice(-12) +
          ' session=' + sessionId.slice(0, 8) +
          ' seq=' + loadSequence +
          ' phase=after-ipc' +
          ' elapsedMs=' + (Date.now() - loadStartedAt));
        return false;
      }
      if (result?.success && result.unchanged === true) {
        historyRevisionRef.current = result.revision || historyRevisionRef.current;
        const rawSnapshot = historySnapshotCache.peek<FullHistoryEntry>(historySnapshotOwner);
        if (rawSnapshot) {
          const rawEntries = rawSnapshot.entries as unknown as FullHistoryEntry[];
          rawServerEntriesRef.current = rawEntries;
          reconcileLiveToolResultsAgainstDurable(rawEntries, ownerKeyAtStart);
          consumeMaterializedPromptHandoffs(rawEntries);
          if (toolType === 'codex') {
            reconcileCodexEffectiveSettings(tabId, sessionId, rawEntries);
          }
          lastServerEntryUuidsRef.current = new Set(rawEntries.map((entry) => entry.uuid));
          const presentedServerEntries = filterSuppressedPromptEntries(
            rawEntries,
            suppressedPromptsRef.current.values(),
          ).entries;
          const nextEntries = mergeServerAndLocalEntries(
            presentedServerEntries,
            presentationEntriesRef.current,
          );
          presentationEntriesRef.current = nextEntries;
          setEntries(nextEntries);
          persistVolatileOverlay(historySnapshotOwner, nextEntries);
        }
        historyLoaderReasonRef.current = 'load-unchanged';
        setLoading(false);
        historyDiag('LOAD_UNCHANGED tab=' + tabId.slice(-12) +
          ' session=' + sessionId.slice(0, 8) +
          ' seq=' + loadSequence +
          ' elapsedMs=' + (Date.now() - loadStartedAt) +
          ' cache=' + (rawSnapshot ? 'hit' : 'miss') +
          ' keptEntries=' + (rawSnapshot?.entries.length || presentationEntriesRef.current.length));
        return true;
      }
      if (result.success) {
        const now = Date.now();
        for (const [handoffId, suppressed] of suppressedPromptsRef.current) {
          if ((suppressed.expiresAt || suppressed.until) < now) {
            suppressedPromptsRef.current.delete(handoffId);
            promptHandoffMetaRef.current.delete(handoffId);
            historyDiag('SUPPRESS_EXPIRED tab=' + tabId.slice(-12) +
              ' handoff=' + handoffId +
              ' reason=' + suppressed.reason);
          }
        }
        const rawServerEntries: FullHistoryEntry[] = result.entries || [];
        rawServerEntriesRef.current = rawServerEntries;
        reconcileLiveToolResultsAgainstDurable(rawServerEntries, ownerKeyAtStart);
        consumeMaterializedPromptHandoffs(rawServerEntries);
        if (toolType === 'codex') {
          reconcileCodexEffectiveSettings(tabId, sessionId, rawServerEntries);
        }
        const suppressedResult = filterSuppressedPromptEntries(rawServerEntries, suppressedPromptsRef.current.values());
        const serverEntries = suppressedResult.entries;
        lastServerEntryUuidsRef.current = new Set(rawServerEntries.map((entry) => entry.uuid));
        if (suppressedResult.hidden > 0) {
          historyDiag('SUPPRESS_FILTERED tab=' + tabId.slice(-12) +
            ' hidden=' + suppressedResult.hidden +
            ' serverRaw=' + rawServerEntries.length +
            ' server=' + serverEntries.length);
        }
        const nextBoundaryUuid = result.claudeMemoryBoundaryUuid || null;
        const nextRevision = result.revision || null;
        setClaudeMemoryBoundaryUuid(nextBoundaryUuid);
        historyRevisionRef.current = nextRevision;
        const cacheAccountingStartedAt = performance.now();
        const entriesApproxBytesHint = estimateHistoryEntriesBytesFast(rawServerEntries);
        const cacheResult = historySnapshotCache.set(historySnapshotOwner, {
          entries: rawServerEntries,
          claudeMemoryBoundaryUuid: nextBoundaryUuid,
          revision: nextRevision,
          entriesApproxBytesHint,
        });
        const cacheAccountingMs = performance.now() - cacheAccountingStartedAt;
        if (cacheResult.stored) {
          historyDiag('CACHE_WRITE tab=' + tabId.slice(-12) +
            ' session=' + sessionId.slice(0, 8) +
            ' owner=' + historyOwnerDigest(ownerKeyAtStart) +
            ' seq=' + loadSequence +
            ' entries=' + rawServerEntries.length +
            ' approxBytes=' + cacheResult.approxBytes +
            ' accountingMs=' + cacheAccountingMs.toFixed(1) +
            ' evicted=' + (
              cacheResult.evictedKeys.length > 0
                ? cacheResult.evictedKeys.map(historyOwnerDigest).join(',')
                : '-'
            ) +
            ' replaced=' + (cacheResult.invalidatedExisting ? '1' : '0'));
        } else if ('reason' in cacheResult) {
          historyDiag('CACHE_REJECT tab=' + tabId.slice(-12) +
            ' session=' + sessionId.slice(0, 8) +
            ' owner=' + historyOwnerDigest(ownerKeyAtStart) +
            ' seq=' + loadSequence +
            ' reason=' + cacheResult.reason +
            ' entries=' + rawServerEntries.length +
            ' approxBytes=' + cacheResult.approxBytes +
            ' accountingMs=' + cacheAccountingMs.toFixed(1) +
            ' invalidated=' + (cacheResult.invalidatedExisting ? '1' : '0'));
          console.warn(
            '[HistoryPanel] snapshot not cached tab=' + tabId.slice(-12)
            + ' reason=' + cacheResult.reason
            + ' approxBytes=' + cacheResult.approxBytes
            + ' entries=' + serverEntries.length,
          );
        }
        const currentPreview = useUIStore.getState().historyRewindPreviews[tabId] || null;
        if (currentPreview && serverHistoryMaterializedRewindBranch(rawServerEntries, currentPreview)) {
          setHistoryRewindPreview(tabId, null);
        }

        if (!isRefresh) {
          const newEntries = mergeServerAndLocalEntries(
            serverEntries,
            presentationEntriesRef.current,
          );
          console.warn(`[HP] initial load: ${newEntries.length} entries`);
          presentationEntriesRef.current = newEntries;
          persistVolatileOverlay(historySnapshotOwner, newEntries);
          historyLoaderReasonRef.current = 'load-success';
          // The durable projection replaced any display-only rewind prefix
          // wholesale; nothing partial is on screen.
          rewindPrefixOnScreenRef.current = null;
          historyDiag('LOAD_APPLY tab=' + tabId.slice(-12) +
            ' session=' + sessionId.slice(0, 8) +
            ' seq=' + loadSequence +
            ' refresh=0' +
            ' elapsedMs=' + (Date.now() - loadStartedAt) +
            ' rawEntries=' + rawServerEntries.length +
            ' visibleEntries=' + newEntries.length +
            ' cacheStored=' + (cacheResult.stored ? '1' : '0'));
          // These rows came from disk, so liveness claims about them are now
          // allowed for this owner (see chipsOwnerSettled).
          setChipsFreshOwnerKey(historyOwnerKey);
          // startTransition: React 19 yields to browser between chunks,
          // keeping spinner animation smooth during heavy DOM renders
          startTransition(() => {
            if (!isCurrentOwner()) {
              historyDiag('LOAD_STALE_DROP tab=' + tabId.slice(-12) +
                ' session=' + sessionId.slice(0, 8) +
                ' seq=' + loadSequence +
                ' phase=start-transition');
              return;
            }
            setEntries(newEntries);
            setLoading(false);
          });
          // Starts at the top by default (no scrollToBottom on initial load)
        } else {
          // Refresh: update when count OR stable row state changed. Queue-operation
          // rows can flip QUEUED → SENT without changing entries.length.
          setEntries(prev => {
            if (!isCurrentOwner()) return prev;
            const localBefore = prev.filter(isLocalPromptEntry);
            if (localBefore.length > 0) {
              const localSummary = localBefore.map((entry) => {
                const matched = serverHasPromptEntry(serverEntries, entry);
                const ageMs = Date.now() - (entry.optimisticAt || Date.parse(entry.timestamp || '') || Date.now());
                return (entry.handoffId || entry.uuid.slice(-8)) + ':' + (entry.queueStatus || 'queued') + ':matched=' + matched + ':age=' + ageMs;
              }).join(',');
              historyDiag('REFRESH_LOCALS tab=' + tabId.slice(-12) +
                ' server=' + serverEntries.length +
                ' locals=' + localBefore.length +
                ' [' + localSummary + ']');
            }
            const mergedEntries = mergeServerAndLocalEntries(serverEntries, prev);
            const newEntries = retainStableHistoryEntryReferences(prev, mergedEntries);
            const sameEntries =
              newEntries.length === prev.length &&
              newEntries.every((entry, idx) => entry === prev[idx]);
            if (sameEntries) return prev;
            console.warn(`[HP] refresh: ${prev.length} → ${newEntries.length}`);
            presentationEntriesRef.current = newEntries;
            persistVolatileOverlay(historySnapshotOwner, newEntries);
            return newEntries;
          });
          historyDiag('LOAD_APPLY tab=' + tabId.slice(-12) +
            ' session=' + sessionId.slice(0, 8) +
            ' seq=' + loadSequence +
            ' refresh=1' +
            ' elapsedMs=' + (Date.now() - loadStartedAt) +
            ' rawEntries=' + rawServerEntries.length +
            ' visibleEntries=' + serverEntries.length +
            ' cacheStored=' + (cacheResult.stored ? '1' : '0'));
          setChipsFreshOwnerKey(historyOwnerKey);
        }
        return true;
      }
      if (!isRefresh) {
        historyLoaderReasonRef.current = 'load-result-failed';
        setLoading(false);
        if (rewindPrefixOnScreenRef.current === historyOwnerKey) {
          // The rows on screen are still the display-only rewind prefix and
          // the child projection failed to load — say so instead of letting
          // the prefix stand as if it were the final history.
          setError('История новой ветки не загрузилась: ' + String(result?.error || 'load failed') + '. Показан общий префикс до отката.');
        }
      }
      historyDiag('LOAD_RESULT_FAIL tab=' + tabId.slice(-12) +
        ' session=' + sessionId.slice(0, 8) +
        ' seq=' + loadSequence +
        ' refresh=' + (isRefresh ? '1' : '0') +
        ' elapsedMs=' + (Date.now() - loadStartedAt) +
        ' error=' + String(result?.error || 'unsuccessful-result'));
      return false;
    } catch (e) {
      if (!isCurrentOwner()) {
        historyDiag('LOAD_STALE_DROP tab=' + tabId.slice(-12) +
          ' session=' + sessionId.slice(0, 8) +
          ' seq=' + loadSequence +
          ' phase=catch');
        return false;
      }
      console.warn('[HistoryPanel] Load error:', e);
      if (!isRefresh) {
        historyLoaderReasonRef.current = 'load-exception';
        setLoading(false);
        if (rewindPrefixOnScreenRef.current === historyOwnerKey) {
          setError('История новой ветки не загрузилась: ' + String((e as any)?.message || e) + '. Показан общий префикс до отката.');
        }
      }
      historyDiag('LOAD_ERROR tab=' + tabId.slice(-12) +
        ' session=' + sessionId.slice(0, 8) +
        ' seq=' + loadSequence +
        ' refresh=' + (isRefresh ? '1' : '0') +
        ' elapsedMs=' + (Date.now() - loadStartedAt) +
        ' error=' + String((e as any)?.message || e));
      return false;
    }
  }, [sessionId, cwd, historyOwnerKey, historySnapshotOwner, persistVolatileOverlay, scrollToBottom, setHistoryRewindPreview, tabId, toolType, reconcileLiveToolResultsAgainstDurable, consumeMaterializedPromptHandoffs]);

  // One heavyweight History IPC may be active per owner. Events that arrive
  // while it is running collapse into one trailing reconciliation instead of
  // cloning the same large snapshot through Electron in parallel.
  const loadHistory = useCallback((isRefresh = false): Promise<boolean> => {
    if (!sessionId) return Promise.resolve(runHistoryLoad(false));
    const ownerKey = historyOwnerKey;
    const generation = historyOwnerGenerationRef.current;
    const active = historyLoadFlightRef.current;
    if (active?.ownerKey === ownerKey && active.generation === generation) {
      if (isRefresh) active.trailingRefresh = true;
      historyDiag('LOAD_JOIN tab=' + tabId.slice(-12) +
        ' session=' + sessionId.slice(0, 8) +
        ' refresh=' + (isRefresh ? '1' : '0') +
        ' trailing=' + (active.trailingRefresh ? '1' : '0'));
      return active.promise;
    }

    const flight: {
      ownerKey: string;
      generation: number;
      trailingRefresh: boolean;
      promise: Promise<boolean>;
    } = {
      ownerKey,
      generation,
      trailingRefresh: false,
      promise: Promise.resolve(false),
    };
    flight.promise = (async () => {
      let nextIsRefresh = isRefresh;
      let ok = false;
      do {
        flight.trailingRefresh = false;
        ok = await runHistoryLoad(nextIsRefresh);
        nextIsRefresh = true;
      } while (
        flight.trailingRefresh &&
        historyOwnerKeyRef.current === ownerKey &&
        historyOwnerGenerationRef.current === generation
      );
      return ok;
    })().finally(() => {
      if (historyLoadFlightRef.current === flight) historyLoadFlightRef.current = null;
    });
    historyLoadFlightRef.current = flight;
    return flight.promise;
  }, [historyOwnerKey, runHistoryLoad, sessionId, tabId]);

  const flushLiveHistoryToDurable = useCallback(async (
    reason: string,
    ownerKey = historyOwnerKey,
  ) => {
    const generation = historyOwnerGenerationRef.current;
    const result = await flushHistoryDurableWithRetry({
      load: () => loadHistory(true),
      isCurrent: () => (
        historyOwnerKeyRef.current === ownerKey
        && historyOwnerGenerationRef.current === generation
      ),
      hasUnmatchedLive: () => hasUnmatchedLiveForOwner(ownerKey),
    });
    if (result.stale) return false;
    deferredTranscriptRefreshRef.current = !result.settled;
    historyDiag((result.settled ? 'TRANSCRIPT_FLUSH_SETTLED' : 'TRANSCRIPT_FLUSH_PENDING')
      + ' tab=' + tabId.slice(-12)
      + ' session=' + (sessionId ? sessionId.substring(0, 8) : 'none')
      + ' tool=' + toolType
      + ' reason=' + reason
      + ' attempts=' + result.attempts
      + ' loadSuccess=' + (result.success ? '1' : '0')
      + ' unmatched=' + (hasUnmatchedLiveForOwner(ownerKey) ? '1' : '0'));
    return result.settled;
  }, [
    hasUnmatchedLiveForOwner,
    historyOwnerKey,
    loadHistory,
    sessionId,
    tabId,
    toolType,
  ]);

  // Suppression is a temporary presentation overlay, not durable transcript
  // state. Reconcile at the nearest expiry even when the JSONL is idle and no
  // transcript invalidation event arrives.
  useEffect(() => {
    if (suppressedPromptsRef.current.size === 0) return;
    const nextExpiry = Math.min(
      ...Array.from(suppressedPromptsRef.current.values())
        .map((suppression) => suppression.expiresAt),
    );
    const ownerKey = historyOwnerKey;
    const generation = historyOwnerGenerationRef.current;
    const timer = setTimeout(() => {
      if (
        historyOwnerKeyRef.current !== ownerKey ||
        historyOwnerGenerationRef.current !== generation
      ) return;
      const now = Date.now();
      let changed = false;
      for (const [handoffId, suppression] of suppressedPromptsRef.current) {
        if (suppression.expiresAt > now) continue;
        suppressedPromptsRef.current.delete(handoffId);
        promptHandoffMetaRef.current.delete(handoffId);
        changed = true;
      }
      if (!changed) return;
      const rawSnapshot = historySnapshotCache.peek<FullHistoryEntry>(historySnapshotOwner);
      if (!rawSnapshot) {
        void loadHistory(false);
        return;
      }
      const rawEntries = rawSnapshot.entries as unknown as FullHistoryEntry[];
      reconcileLiveToolResultsAgainstDurable(rawEntries, ownerKey);
      const nextEntries = mergeServerAndLocalEntries(
        filterSuppressedPromptEntries(
          rawEntries,
          suppressedPromptsRef.current.values(),
        ).entries,
        presentationEntriesRef.current,
      );
      presentationEntriesRef.current = nextEntries;
      setEntries(nextEntries);
      persistVolatileOverlay(historySnapshotOwner, nextEntries);
    }, Math.max(0, nextExpiry - Date.now()) + 10);
    return () => clearTimeout(timer);
  }, [entries, historyOwnerKey, historySnapshotOwner, loadHistory, persistVolatileOverlay, reconcileLiveToolResultsAgainstDurable]);

  const waitForDurableRewindHistory = useCallback(async (detail: {
    targetUuid?: string;
    opId?: string;
    toolType?: string;
  }) => {
    const targetUuid = detail.targetUuid || '';
    for (let attempt = 0; attempt < 6; attempt++) {
      const ok = await loadHistory(true);
      const serverEntryUuids = lastServerEntryUuidsRef.current;
      const targetStillVisible = !!targetUuid && serverEntryUuids.has(targetUuid);
      historyDiag('REWIND_REFRESH tab=' + tabId.slice(-12) +
        ' op=' + (detail.opId || '-') +
        ' attempt=' + (attempt + 1) +
        ' ok=' + ok +
        ' targetStillVisible=' + targetStillVisible +
        ' server=' + serverEntryUuids.size);
      if (!targetStillVisible) return true;
      await new Promise((resolve) => setTimeout(resolve, attempt < 2 ? 140 : 320));
    }
    return false;
  }, [loadHistory, tabId]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as {
        tabId?: string;
        opId?: string;
        status?: 'start' | 'done' | 'failed';
        targetUuid?: string;
        targetText?: string;
        historyDraftText?: string;
        historyDraftImages?: HistoryPromptDraftImageRef[];
        historyDraftChips?: HistoryPromptDraftChip[];
        historyDraftWarning?: string;
        mode?: 'native' | 'ai';
        toolType?: string;
        writerGeneration?: string;
        persisted?: boolean;
        historyInputDraft?: boolean;
        error?: string;
        message?: string;
      };
      if (detail.tabId !== tabId) return;
      // A rewind rewrites the branch: stored row sizes describe a list that no
      // longer exists, and restoring them would place the viewport by geometry
      // from a different history. Cheap to drop — the next visit just measures
      // again.
      dropHistoryMeasuredLayout(historyOwnerKey);
      const durableDone = detail.status === 'done' && (
        detail.persisted === true ||
        detail.mode === 'ai' ||
        detail.toolType === 'gemini'
      );
      if (!durableDone) {
        upsertLocalRewindEntry(detail);
        return;
      }
      if (detail.toolType === 'codex' && detail.persisted === true) {
        // A persisted Codex result means the writer moved to a durably bound
        // child. The session-id prop change is the refresh event: it tears down
        // the source owner and loads the child once. A proven stable-source
        // result is deliberately not marked persisted and takes the preview
        // path above until a later user message materializes the new branch.
        upsertLocalRewindEntry(detail);
        return;
      }
      upsertLocalRewindEntry({
        ...detail,
        status: 'start',
        message: 'Updating history...',
      });
      waitForDurableRewindHistory(detail)
        .catch((e: any) => {
          console.warn('[HistoryPanel] rewind refresh wait failed tab=' + tabId.slice(-12) + ': ' + String(e?.message || e));
        })
        .finally(() => {
          upsertLocalRewindEntry(detail);
        });
    };
    window.addEventListener('history-panel:rewind-log', handler);
    return () => window.removeEventListener('history-panel:rewind-log', handler);
  }, [tabId, historyOwnerKey, upsertLocalRewindEntry, waitForDurableRewindHistory]);

  // Broadcast loading state to InfoPanel button
  useEffect(() => {
    const snapshot = historySnapshotCache.peek<FullHistoryEntry>(historySnapshotOwner);
    // Stamped so SURFACE_PRESENTED can report the blank-frame window directly.
    loaderHiddenAtRef.current = visibleSurfaceLoading ? null : performance.now();
    historyDiag((visibleSurfaceLoading ? 'LOADER_VISIBLE' : 'LOADER_HIDDEN') +
      ' tab=' + tabId.slice(-12) +
      ' session=' + (sessionId ? sessionId.slice(0, 8) : 'none') +
      ' tool=' + toolType +
      ' owner=' + historyOwnerDigest(historyOwnerKey) +
      ' reason=' + historyLoaderReasonRef.current +
      ' viewportPending=' + (viewportAwaitingFirstRange ? '1' : '0') +
      ' cache=' + (snapshot ? 'hit' : 'miss') +
      ' cacheEntries=' + (snapshot?.entries.length || 0) +
      ' visibleEntries=' + presentationEntriesRef.current.length +
      ' ownerAgeMs=' + Math.max(0, Date.now() - historyOwnerStartedAtRef.current));
    window.dispatchEvent(new CustomEvent('history-panel:loading', { detail: { tabId, loading: visibleSurfaceLoading } }));
  }, [
    historyOwnerKey,
    historySnapshotOwner,
    sessionId,
    tabId,
    toolType,
    viewportAwaitingFirstRange,
    visibleSurfaceLoading,
  ]);

  // A valid empty transcript is also a finished presentation. Publish it only
  // after the exact owner's empty-state element survives a paint boundary, so
  // Timeline cannot be released by an async result that has not reached DOM.
  useEffect(() => {
    if (
      surfaceLoading
      || transcriptEntries.length !== 0
      || presentedOwnerKey !== historyOwnerKey
      || historyOwnerKeyRef.current !== historyOwnerKey
    ) return;

    const ownerAtSchedule = historyOwnerKey;
    const generationAtSchedule = historyOwnerGenerationRef.current;
    const presentedProofKey = ownerAtSchedule + ':' + generationAtSchedule;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (
          historyOwnerKeyRef.current !== ownerAtSchedule
          || historyOwnerGenerationRef.current !== generationAtSchedule
          || surfacePresentedOwnerRef.current === presentedProofKey
          || !panelRef.current?.querySelector('[data-history-empty-state]')
        ) return;
        const cacheAtPaint = historySnapshotCache.peek<FullHistoryEntry>(historySnapshotOwner)
          ? 'hit'
          : 'miss';
        surfacePresentedOwnerRef.current = presentedProofKey;
        // `loader=` must report the ACTUAL loader state, not a constant. This
        // branch hard-coded `hidden`, so an empty-state frame — a legitimately
        // painted "no history" placeholder — was indistinguishable in the log
        // from the forbidden blank frame (no rows AND no indicator). An
        // independent reviewer read exactly that and filed a regression that
        // did not exist (e2e21). A log line that cannot express the difference
        // between the safe and the unsafe case is a trap for whoever reads it.
        historyDiag('SURFACE_PRESENTED tab=' + tabId.slice(-12)
          + ' owner=' + historyOwnerDigest(ownerAtSchedule)
          + ' generation=' + generationAtSchedule
          + ' cache=' + cacheAtPaint
          + ' domRows=0 foreignDomRows=0'
          + ' loader=' + (visibleSurfaceLoading ? 'visible' : 'hidden')
          + ' proof=painted-empty-state');
        publishHistorySurfacePresented({
          ownerKey: ownerAtSchedule,
          generation: generationAtSchedule,
          proof: 'painted-empty-state',
          domRows: 0,
          foreignDomRows: 0,
          cache: cacheAtPaint,
        });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [
    historyOwnerKey,
    historySnapshotOwner,
    presentedOwnerKey,
    publishHistorySurfacePresented,
    surfaceLoading,
    tabId,
    transcriptEntries.length,
  ]);

  // Initial load on mount / session change / tool type switch
  const initialLoadDoneRef = useRef(false);
  useLayoutEffect(() => {
    const generation = historyOwnerGenerationRef.current + 1;
    const viewportPaintOwner: HistoryViewportPaintOwner = {
      key: historyOwnerKey,
      generation,
    };
    const ownerStartedAt = Date.now();
    historyOwnerStartedAtRef.current = ownerStartedAt;
    historyOwnerGenerationRef.current = generation;
    // Publish the generation so the list's key changes and it truly remounts;
    // that mount is the only moment restored geometry is applied.
    setHistoryOwnerVisitState(generation);
    historyOwnerKeyRef.current = historyOwnerKey;
    deferredTranscriptRefreshRef.current = false;
    liveProjectionRef.current = { ownerKey: historyOwnerKey, entries: [] };
    liveToolResultsRef.current = { ownerKey: historyOwnerKey, results: new Map() };
    durableSourceIdentitiesRef.current = new Set();
    setLiveEntries([]);
    setLiveToolResults(new Map());
    viewportPaintProbeRef.current?.cancel();
    surfacePresentedProbeRef.current?.cancel();
    surfacePresentedOwnerRef.current = '';
    setPresentedOwnerKey(historyOwnerKey);
    initialLoadDoneRef.current = false;
    // New owner starts pinned to the tail until ITS rows report otherwise;
    // a leftover false from the previous owner would suppress followOutput
    // on a tab that opens at the bottom.
    isAtBottomRef.current = true;
    if (scrollSaveTimerRef.current) {
      // A scroll-idle save armed by the previous owner must not observe the
      // next owner's scroller (the timer's own stale-guard also covers this;
      // clearing here just avoids the no-op wakeup).
      clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = null;
    }
    // Rewind owner handoff capture: presentationEntriesRef still holds the
    // PREVIOUS owner's rows at this point. If this session change was caused
    // by a rewind that adopted a child branch, everything strictly before the
    // rewind target is a proven common prefix of the new branch — hold it for
    // the cache-miss branch below instead of flashing an empty loader.
    {
      const activeOp = selectActiveRewindOperation(useRewindOperationStore.getState(), tabId);
      const previousRows = presentationEntriesRef.current;
      // The child adoption a rewind performs happens only while the operation
      // is committing (Timeline swaps the session right after mutation proof)
      // or done (activeSessionId carries the exact child). A session swap
      // during earlier phases cannot be this rewind's doing — e.g. a stale
      // bridge takeover racing a still-compacting rewind — and showing the
      // source prefix for such a swap would present another session's rows.
      const opPhaseAllowsAdoption = activeOp?.phase === 'committing' || activeOp?.phase === 'done';
      if (
        activeOp
        && opPhaseAllowsAdoption
        && activeOp.sourceSessionId
        && sessionId
        && activeOp.sourceSessionId !== sessionId
        && (activeOp.phase === 'committing'
          ? !activeOp.activeSessionId || activeOp.activeSessionId === sessionId
          : activeOp.activeSessionId === sessionId)
        && previousRows.length > 0
      ) {
        const targetIdx = previousRows.findIndex((entry) => entry.uuid === activeOp.targetUuid);
        if (targetIdx > 0) {
          const prefix = previousRows
            .slice(0, targetIdx)
            .filter((entry) => !isLocalRewindEntry(entry) && !isLocalPromptEntry(entry));
          if (prefix.length > 0) {
            rewindPrefixHandoffRef.current = {
              sourceSessionId: activeOp.sourceSessionId,
              expectedChildSessionId: sessionId,
              entries: prefix,
              capturedAt: Date.now(),
            };
            historyDiag('REWIND_PREFIX_CAPTURE tab=' + tabId.slice(-12)
              + ' op=' + activeOp.opId
              + ' source=' + activeOp.sourceSessionId.slice(0, 8)
              + ' child=' + sessionId.slice(0, 8)
              + ' prefixRows=' + prefix.length
              + ' target=' + String(activeOp.targetUuid).slice(0, 8));
          }
        }
      }
    }
    const volatileOverlay = sessionId
      ? historyVolatileOverlayCache.get<
          FullHistoryEntry,
          PromptHandoffMeta,
          SuppressedPrompt
        >(historySnapshotOwner)
      : undefined;
    const now = Date.now();
    const restoredSuppressions = (volatileOverlay?.suppressions || [])
      .filter(([, suppression]) => suppression.expiresAt > now);
    promptHandoffMetaRef.current = new Map(volatileOverlay?.handoffs || []);
    suppressedPromptsRef.current = new Map(restoredSuppressions);
    const restoredLocalEntries = mergeServerAndLocalEntries(
      [],
      (volatileOverlay?.entries as unknown as FullHistoryEntry[] | undefined) || [],
    );
    const cachedSnapshot = sessionId
      ? historySnapshotCache.get<FullHistoryEntry>(historySnapshotOwner)
      : undefined;
    const cacheStats = historySnapshotCache.stats();
    historyLoaderReasonRef.current = cachedSnapshot
      ? 'owner-cache-hit'
      : sessionId
        ? 'owner-cache-miss'
        : 'no-session';
    historyDiag('SURFACE_OWNER tab=' + tabId.slice(-12) +
      ' session=' + (sessionId ? sessionId.slice(0, 8) : 'none') +
      ' tool=' + toolType +
      ' owner=' + historyOwnerDigest(historyOwnerKey) +
      ' generation=' + generation +
      ' cache=' + (cachedSnapshot ? 'hit' : 'miss') +
      ' cacheEntries=' + (cachedSnapshot?.entries.length || 0) +
      ' cacheAgeMs=' + (cachedSnapshot ? Math.max(0, ownerStartedAt - cachedSnapshot.capturedAt) : -1) +
      ' cacheSnapshots=' + cacheStats.snapshots +
      ' cacheTotalEntries=' + cacheStats.totalEntries +
      ' cacheApproxBytes=' + cacheStats.approxBytes +
      ' localEntries=' + restoredLocalEntries.length);
    if (cachedSnapshot) {
      // A cached child projection wins over the display-only prefix; drop the
      // handoff so a LATER unrelated owner change cannot consume stale rows.
      rewindPrefixHandoffRef.current = null;
      const rawCachedEntries = cachedSnapshot.entries as unknown as FullHistoryEntry[];
      reconcileLiveToolResultsAgainstDurable(rawCachedEntries, historyOwnerKey);
      const presentedCachedEntries = filterSuppressedPromptEntries(
        rawCachedEntries,
        suppressedPromptsRef.current.values(),
      ).entries;
      const cachedEntries = mergeServerAndLocalEntries(
        presentedCachedEntries,
        restoredLocalEntries,
      );
      const needsViewportProof = cachedEntries.length > 0;
      viewportReadyOwnerKeyRef.current = needsViewportProof ? '' : historyOwnerKey;
      setViewportReadyOwnerKey(needsViewportProof ? '' : historyOwnerKey);
      setViewportProofRequired(needsViewportProof);
      presentationEntriesRef.current = cachedEntries;
      setEntries(cachedEntries);
      setClaudeMemoryBoundaryUuid(cachedSnapshot.claudeMemoryBoundaryUuid);
      historyRevisionRef.current = cachedSnapshot.revision;
      lastServerEntryUuidsRef.current = new Set(rawCachedEntries.map((entry) => entry.uuid));
      rawServerEntriesRef.current = rawCachedEntries;
      rewindPrefixOnScreenRef.current = null;
      setLoading(false);
      persistVolatileOverlay(historySnapshotOwner, cachedEntries);
    } else {
      // Cache miss. A rewind-adopted child may present the proven common
      // prefix of its source branch while the real projection loads — the
      // screen keeps the conversation up to the rewind target instead of
      // flashing empty. The prefix is display-only: it is NOT written to the
      // snapshot cache or treated as server truth, and loadHistory's commit
      // replaces it wholesale (owner+generation guarded).
      const prefixHandoff = rewindPrefixHandoffRef.current;
      rewindPrefixHandoffRef.current = null;
      const prefixRows = prefixHandoff
        && prefixHandoff.expectedChildSessionId === sessionId
        && Date.now() - prefixHandoff.capturedAt < 30_000
        ? prefixHandoff.entries
        : [];
      const initialRows = prefixRows.length > 0
        ? mergeServerAndLocalEntries(prefixRows, restoredLocalEntries)
        : restoredLocalEntries;
      if (prefixRows.length > 0) {
        historyDiag('REWIND_PREFIX_PRESENT tab=' + tabId.slice(-12)
          + ' child=' + (sessionId ? sessionId.slice(0, 8) : 'none')
          + ' prefixRows=' + prefixRows.length);
        rewindPrefixOnScreenRef.current = historyOwnerKey;
        // The owner-keyed virtualized viewport remounts for the child. Keep
        // the loader until that new viewport has painted one of the proven
        // prefix rows; the source viewport itself is not child presentation
        // proof even though the rows are a valid common prefix.
        viewportReadyOwnerKeyRef.current = '';
        setViewportReadyOwnerKey('');
        setViewportProofRequired(true);
        setLoading(false);
      } else {
        // Strict loader contract for every other cold owner: the loader
        // stays visible until a real row is mounted AND painted (viewport
        // proof). Fast-path presentation of stale fragments here produced
        // dark frames with no indicator — a screen with rows=0 and no
        // loader must be impossible by construction, not caught by tests.
        viewportReadyOwnerKeyRef.current = '';
        setViewportReadyOwnerKey('');
        setViewportProofRequired(true);
        setLoading(!!sessionId);
      }
      presentationEntriesRef.current = initialRows;
      setEntries(initialRows);
      setClaudeMemoryBoundaryUuid(null);
      historyRevisionRef.current = null;
      lastServerEntryUuidsRef.current = new Set();
      rawServerEntriesRef.current = [];
      persistVolatileOverlay(historySnapshotOwner, restoredLocalEntries);
    }
    const currentPreview = useUIStore.getState().historyRewindPreviews[tabId] || null;
    if (currentPreview?.sessionId && currentPreview.sessionId !== sessionId) {
      setHistoryRewindPreview(tabId, null);
    }
    void loadHistory(!!cachedSnapshot);
    return () => {
      viewportPaintProbeRef.current?.cancel(viewportPaintOwner);
      surfacePresentedProbeRef.current?.cancel(viewportPaintOwner);
      // Geometry is captured continuously while the owner is alive (see the
      // sampling effect below), NOT here. `getState` resolves through
      // Virtuoso's own reactive graph: by the time this cleanup runs the list
      // for this owner is already unmounting, the graph has no live publisher
      // left, and the callback simply never fires — measured live (e2e17) as
      // 20 cleanups producing zero LAYOUT_SAVE lines while the same boot
      // logged 21 other new-instrumentation lines, i.e. the code shipped and
      // the call was silently dropped. Teardown is the wrong moment to ask a
      // dying component anything.
      persistVolatileOverlay(
        historySnapshotOwner,
        presentationEntriesRef.current,
        promptHandoffMetaRef.current,
        suppressedPromptsRef.current,
      );
      if (historyOwnerGenerationRef.current === generation) {
        historyOwnerGenerationRef.current += 1;
      }
      historyDiag('SURFACE_OWNER_CLEANUP tab=' + tabId.slice(-12) +
        ' session=' + (sessionId ? sessionId.slice(0, 8) : 'none') +
        ' tool=' + toolType +
        ' owner=' + historyOwnerDigest(historyOwnerKey) +
        ' generation=' + generation +
        ' lifetimeMs=' + Math.max(0, Date.now() - ownerStartedAt));
    };
  }, [historyOwnerKey, historySnapshotOwner, loadHistory, persistVolatileOverlay, reconcileLiveToolResultsAgainstDurable, sessionId, setHistoryRewindPreview, tabId, toolType]);

  // `transcriptEntries` already committed the durable version into the same
  // virtualized slot before this layout effect runs. Now it is safe to retire
  // the redundant live state; the next render keeps the same row and key.
  useLayoutEffect(() => {
    if (
      presentedOwnerKey !== historyOwnerKey
      || historyOwnerKeyRef.current !== historyOwnerKey
    ) return;
    durableSourceIdentitiesRef.current = new Set(
      entries
        .map((entry) => historyLivePresentationIdentity(entry))
        .filter((identity): identity is string => !!identity),
    );
    reconcileLiveProjectionAgainstDurable(entries, historyOwnerKey);
  }, [
    entries,
    historyOwnerKey,
    presentedOwnerKey,
    reconcileLiveProjectionAgainstDurable,
  ]);

  // Restore the reading position once per owner, after the surface is ready.
  // Anchor first (row identity + in-row offset — stable across remeasures,
  // remounts and app restarts), then the legacy pixel slot, then the tail.
  // An explicit Timeline jump (historyScrollToUuid) owns the position and
  // must not be raced by a competing restore.
  useEffect(() => {
    if (surfaceLoading || initialLoadDoneRef.current) return;
    if (displayEntries.length === 0) return;
    if (useUIStore.getState().historyScrollToUuid) {
      // Timeline navigation wins; mark restore as done so it cannot fire
      // later and yank the viewport away from the jump target.
      initialLoadDoneRef.current = true;
      return;
    }
    initialLoadDoneRef.current = true;
    if (restoredMeasuredLayout) {
      // Virtuoso was handed real measured sizes plus this owner's scroll
      // offset, so the list is already where the user left it. Running the
      // anchor loop on top would be two mechanisms steering one viewport —
      // exactly the fight this whole area keeps producing. Verify instead of
      // re-position: report the residual drift so a bad restore is visible in
      // the log rather than silently "fine".
      // Wait for the anchor row to actually exist before measuring. A single
      // rAF fires before Virtuoso has mounted rows from the restored geometry,
      // so the row lookup missed and every drift reading came back `na` — a
      // verification that never verifies (e2e18: 20/20 na). Poll a few frames,
      // then report honestly whether the row was reachable at all.
      const driftOwner = historyOwnerKey;
      const driftGeneration = historyOwnerGenerationRef.current;
      // Freeze the target. Re-reading the anchor inside the loop compared the
      // restored position against an anchor the user's own scrolling had
      // already MOVED — a moving target, so the "error" was partly just the
      // reader scrolling (e2e20: 153px and 331px readings that A5 proved
      // visually correct). What is being verified is "did the restore land
      // where we were asked to land", so the ask must be captured up front.
      const driftAnchor = getHistoryReadingAnchor(scrollPositionKeyRef.current);
      let driftFrames = 0;
      let stableTop: number | null = null;
      let stableFrames = 0;
      const MAX_DRIFT_FRAMES = 30;
      const measureDrift = () => {
        if (
          historyOwnerKeyRef.current !== driftOwner
          || historyOwnerGenerationRef.current !== driftGeneration
        ) return;
        driftFrames += 1;
        const scroller = virtuosoScrollerRef.current;
        const anchor = driftAnchor;
        const node = scroller && anchor
          ? scroller.querySelector(
            `[data-uuid="${CSS.escape(anchor.uuid)}"]`,
          ) as HTMLElement | null
          : null;
        if (!node && driftFrames < MAX_DRIFT_FRAMES) {
          requestAnimationFrame(measureDrift);
          return;
        }
        // The row EXISTING is not the row having SETTLED. Virtuoso mounts rows
        // and keeps adjusting scrollTop for a few frames while it applies the
        // restored geometry; sampling at first sight caught that motion and
        // reported it as restore error — e2e19 read 340px and 107px at frames
        // 3 and 7, while every reading that waited to frame 5+ was 0-2px. The
        // measurement must wait for the position to stop moving, otherwise it
        // measures its own impatience. Two identical frames = settled.
        if (node && driftFrames < MAX_DRIFT_FRAMES) {
          const top = node.getBoundingClientRect().top;
          if (stableTop !== null && Math.abs(top - stableTop) <= 1) stableFrames += 1;
          else stableFrames = 0;
          stableTop = top;
          if (stableFrames < 2) {
            requestAnimationFrame(measureDrift);
            return;
          }
        }
        let driftPx: number | string = 'row-not-mounted';
        if (node && scroller && anchor) {
          driftPx = Math.round(
            node.getBoundingClientRect().top
            - (scroller.getBoundingClientRect().top - anchor.offsetPx),
          );
        } else if (!anchor) {
          driftPx = 'no-anchor';
        }
        historyDiag('SCROLL_RESTORE tab=' + tabId.slice(-12)
          + ' mode=measured-layout attempts=0'
          + ' driftPx=' + driftPx
          + ' frames=' + driftFrames);
      };
      requestAnimationFrame(measureDrift);
      return;
    }
    // Position ownership, identical for every restore mode: the tab we started
    // for must still be the one on screen, and no newer restore or real user
    // wheel/touch may have taken over (the gesture always wins).
    const cancelReasonForRestore = (
      ownerAtRestore: string,
      generationAtRestore: number,
      restoreGenAtStart: number,
    ): string | null => {
      if (scrollRestoreGenRef.current !== restoreGenAtStart) return 'superseded-or-user-scroll';
      if (historyOwnerKeyRef.current !== ownerAtRestore) return 'owner-change';
      if (historyOwnerGenerationRef.current !== generationAtRestore) return 'owner-change';
      return null;
    };
    const anchor = getHistoryReadingAnchor(scrollPositionKeyRef.current);
    if (anchor && !anchor.followBottom) {
      const index = displayEntryIndexByUuidRef.current.get(anchor.uuid);
      if (index !== undefined) {
        // The restored position is mid-list: Virtuoso followOutput must not
        // treat a live append as "user is at the tail" and yank away.
        isAtBottomRef.current = false;
        const ownerAtRestore = historyOwnerKey;
        const generationAtRestore = historyOwnerGenerationRef.current;
        const restoreGenAtStart = ++scrollRestoreGenRef.current;
        const uuidTag = anchor.uuid.slice(0, 8);
        historyDiag('SCROLL_RESTORE tab=' + tabId.slice(-12)
          + ' mode=anchor uuid=' + uuidTag
          + ' idx=' + index + ' offset=' + anchor.offsetPx);
        runHistoryScrollConvergence({
          cancelled: () => cancelReasonForRestore(
            ownerAtRestore, generationAtRestore, restoreGenAtStart,
          ),
          measureDrift: () => {
            const scroller = virtuosoScrollerRef.current;
            if (!scroller) return null;
            const node = scroller.querySelector(
              `[data-uuid="${CSS.escape(anchor.uuid)}"]`,
            ) as HTMLElement | null;
            if (!node) return null;
            const desiredTop = scroller.getBoundingClientRect().top - anchor.offsetPx;
            return node.getBoundingClientRect().top - desiredTop;
          },
          jump: () => {
            const currentIndex = displayEntryIndexByUuidRef.current.get(anchor.uuid);
            if (currentIndex === undefined) return false; // row vanished mid-restore
            virtuosoRef.current?.scrollToIndex({
              index: currentIndex,
              align: 'start',
              behavior: 'auto',
              offset: anchor.offsetPx,
            });
            return true;
          },
          onSettled: (o) => historyDiag('SCROLL_RESTORE_DONE tab=' + tabId.slice(-12)
            + ' uuid=' + uuidTag + ' attempts=' + o.attempts
            + ' settled=' + o.settled
            + ' driftPx=' + (o.driftPx === null ? 'na' : Math.round(o.driftPx))
            + ' elapsedMs=' + Math.round(o.elapsedMs)),
          onAborted: (o) => historyDiag('SCROLL_RESTORE_CANCEL tab=' + tabId.slice(-12)
            + ' uuid=' + uuidTag + ' attempts=' + o.attempts + ' reason=' + o.reason),
        });
        return;
      }
      // Anchor row vanished (rewind/edit truncated the branch): fall through
      // to the tail rather than showing an unrelated pixel position.
    }
    if (anchor?.followBottom) {
      // The tail is NOT the trivial case it looks like. "Show the last row" is
      // still executed against ESTIMATED heights, so a bare jump lands short
      // and snaps down once the rows measure — visible in prod (26.07) as the
      // history appearing at the top and then dropping to the bottom. This
      // branch was the last one left doing a single shot, and it was also the
      // only one that logged no outcome, which is exactly why no test caught
      // it: a silent path has nothing to disagree with reality.
      const ownerAtRestore = historyOwnerKey;
      const generationAtRestore = historyOwnerGenerationRef.current;
      const restoreGenAtStart = ++scrollRestoreGenRef.current;
      historyDiag('SCROLL_RESTORE tab=' + tabId.slice(-12) + ' mode=tail');
      runHistoryScrollConvergence({
        cancelled: () => cancelReasonForRestore(
          ownerAtRestore, generationAtRestore, restoreGenAtStart,
        ),
        // Distance from a true bottom, measured on the scroller itself: the
        // last row has no stable uuid across live appends, and "pinned to the
        // bottom" is a property of the viewport, not of any one row.
        measureDrift: () => {
          const scroller = virtuosoScrollerRef.current;
          if (!scroller) return null;
          return scroller.scrollTop - (scroller.scrollHeight - scroller.clientHeight);
        },
        jump: () => {
          const count = lengthRef.current;
          if (count <= 0) return false;
          virtuosoRef.current?.scrollToIndex({
            index: count - 1, align: 'end', behavior: 'auto',
          });
          return true;
        },
        onSettled: (o) => historyDiag('SCROLL_RESTORE_DONE tab=' + tabId.slice(-12)
          + ' mode=tail attempts=' + o.attempts
          + ' settled=' + o.settled
          + ' driftPx=' + (o.driftPx === null ? 'na' : Math.round(o.driftPx))
          + ' elapsedMs=' + Math.round(o.elapsedMs)),
        onAborted: (o) => historyDiag('SCROLL_RESTORE_CANCEL tab=' + tabId.slice(-12)
          + ' mode=tail attempts=' + o.attempts + ' reason=' + o.reason),
      });
      return;
    }
    if (!anchor) {
      // Legacy pixel fallback for positions saved before the anchor existed.
      const positions = useUIStore.getState().historyScrollPositions;
      const savedPos = positions[scrollPositionKeyRef.current] ?? positions[tabId];
      if (savedPos && savedPos > 0) {
        // Same convergence contract as the other two modes. A raw scrollTop
        // assignment is undone the moment Virtuoso re-measures, and the old
        // "assign it twice across two frames" trick was a guess at how long
        // that takes, not a check that it held.
        const ownerAtRestore = historyOwnerKey;
        const generationAtRestore = historyOwnerGenerationRef.current;
        const restoreGenAtStart = ++scrollRestoreGenRef.current;
        historyDiag('SCROLL_RESTORE tab=' + tabId.slice(-12) + ' mode=legacy-px px=' + Math.round(savedPos));
        runHistoryScrollConvergence({
          cancelled: () => cancelReasonForRestore(
            ownerAtRestore, generationAtRestore, restoreGenAtStart,
          ),
          measureDrift: () => {
            const el = virtuosoScrollerRef.current;
            if (!el) return null;
            // Clamp to the reachable maximum: a pixel position saved against a
            // longer list can be past the end, and chasing it would never
            // converge.
            const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
            return el.scrollTop - Math.min(savedPos, maxTop);
          },
          jump: () => {
            const el = virtuosoScrollerRef.current;
            if (!el) return false;
            const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
            el.scrollTop = Math.min(savedPos, maxTop);
            return true;
          },
          onSettled: (o) => historyDiag('SCROLL_RESTORE_DONE tab=' + tabId.slice(-12)
            + ' mode=legacy-px attempts=' + o.attempts
            + ' settled=' + o.settled
            + ' driftPx=' + (o.driftPx === null ? 'na' : Math.round(o.driftPx))
            + ' elapsedMs=' + Math.round(o.elapsedMs)),
          onAborted: (o) => historyDiag('SCROLL_RESTORE_CANCEL tab=' + tabId.slice(-12)
            + ' mode=legacy-px attempts=' + o.attempts + ' reason=' + o.reason),
        });
      }
    }
    // `entries` in deps: on a cold owner this effect must re-run when the
    // first projection lands (surfaceLoading flips earlier than rows exist).
  }, [surfaceLoading, tabId, historyOwnerKey, entries, restoredMeasuredLayout]);

  // Both PTY agents expose canonical incremental transcript records. Project
  // that same stream into desktop History while the turn is busy,
  // instead of reparsing and cloning the complete rollout after every append.
  // User messages remain owned by the prompt-handoff layer, so the live stream
  // cannot create a second copy before the durable audit arrives.
  useEffect(() => {
    if (!sessionId || (toolType !== 'codex' && toolType !== 'claude')) return;
    const ownerKey = historyOwnerKey;
    const clearLiveProjection = () => {
      if (liveProjectionRef.current.ownerKey !== ownerKey) return;
      liveProjectionRef.current = { ownerKey, entries: [] };
      liveToolResultsRef.current = { ownerKey, results: new Map() };
      setLiveEntries([]);
      setLiveToolResults(new Map());
    };
    const onLiveMessage = (_event: any, detail: any) => {
      if (detail?.tabId !== tabId || detail?.toolType !== toolType) return;
      if (detail?.sessionId !== sessionId) return;
      if (historyOwnerKeyRef.current !== ownerKey) return;
      const current = liveProjectionRef.current.ownerKey === ownerKey
        ? liveProjectionRef.current.entries
        : [];
      const record = detail?.message;
      const carrierText = toolType === 'claude'
        ? extractClaudeHistoryPromptCarrierText(detail)
        : '';
      const locallyOwnedPrompt = !!carrierText && isClaudeHistoryPromptLocallyOwned(
        detail,
        Array.from(promptHandoffMetaRef.current.entries()).map(([handoffId, handoff]) => ({
          handoffId,
          auditEntryUuid: handoff.auditEntryUuid,
        })),
      );
      const isQueueSettlement = record?.type === 'queue-operation'
        && (
          record.operation === 'dequeue'
          || record.operation === 'remove'
          || record.operation === 'popAll'
        );
      // History-originated sends already own an optimistic prompt row. Native
      // xterm input has no such owner, so its exact Claude queue/user carrier
      // becomes the live row. Queue settlement remains enabled only when that
      // native live row actually exists.
      const includeUserText = toolType === 'claude' && (
        isQueueSettlement
          ? hasClaudeHistoryLiveQueuePrompt(current)
          : !locallyOwnedPrompt
      );
      const reduced = reduceHistoryLiveProjection(current, detail, {
        includeUserText,
      });
      let projectionChanged = reduced !== current;
      if (projectionChanged) {
        const alreadyPresentedLiveIdentities = new Set(
          current
            .map((entry) => historyLivePresentationIdentity(entry))
            .filter((identity): identity is string => !!identity),
        );
        const projected = reduced
          .map((entry: FullHistoryEntry) => (
            entry.liveProjection ? entry : { ...entry, liveProjection: true }
          ))
          .filter((entry: FullHistoryEntry) => {
            const identity = historyLivePresentationIdentity(entry);
            return !identity
              || !durableSourceIdentitiesRef.current.has(identity)
              || alreadyPresentedLiveIdentities.has(identity);
          });
        projectionChanged = projected !== current;
        liveProjectionRef.current = { ownerKey, entries: projected };
        setLiveEntries(projected);
      }
      const resultValues = extractHistoryLiveToolResults(detail) as HistoryLiveToolResult[];
      let toolResultsChanged = false;
      if (resultValues.length > 0) {
        const currentResults = liveToolResultsRef.current.ownerKey === ownerKey
          ? liveToolResultsRef.current.results
          : new Map<string, HistoryLiveToolResult>();
        const nextResults = new Map(currentResults);
        for (const result of resultValues) {
          const previous = nextResults.get(result.toolUseId);
          if (
            previous?.result === result.result
            && previous.isError === result.isError
          ) continue;
          nextResults.set(result.toolUseId, result);
          toolResultsChanged = true;
        }
        if (toolResultsChanged) {
          liveToolResultsRef.current = { ownerKey, results: nextResults };
          setLiveToolResults(nextResults);
        }
      }
      if (!projectionChanged && !toolResultsChanged) return;
      deferredTranscriptRefreshRef.current = true;
      if (!isTurnBusyRef.current) {
        void flushLiveHistoryToDurable('live-message-after-turn', ownerKey);
      }
    };
    ipcRenderer.on('agent-transcript:live-message', onLiveMessage);
    return () => {
      ipcRenderer.removeListener('agent-transcript:live-message', onLiveMessage);
      clearLiveProjection();
    };
  }, [
    flushLiveHistoryToDurable,
    historyOwnerKey,
    sessionId,
    tabId,
    toolType,
  ]);

  // Event-driven transcript refresh. The main process watches JSONL/rollout
  // changes and emits a lightweight invalidation; HistoryPanel keeps its own
  // merge/local-prompt logic by reusing loadHistory(true).
  useEffect(() => {
    if (!sessionId || toolType === 'gemini') return;
    const consumerId = 'history:' + tabId + ':' + toolType + ':' + sessionId;
    const ownerKey = historyOwnerKey;
    let disposed = false;
    let refreshQueued = false;
    const queueRefresh = (reason: string) => {
      if (refreshQueued || disposed) return;
      refreshQueued = true;
      requestAnimationFrame(() => {
        refreshQueued = false;
        if (disposed) return;
        historyDiag('TRANSCRIPT_REFRESH tab=' + tabId.slice(-12) +
          ' session=' + sessionId.substring(0, 8) +
          ' tool=' + toolType +
          ' reason=' + reason);
        void flushLiveHistoryToDurable(
          'transcript-change:' + reason,
          ownerKey,
        ).then(() => {
          if (
            disposed
            || isTurnBusyRef.current
            || historyOwnerKeyRef.current !== ownerKey
          ) return;
        });
      });
    };
    const onChanged = (_event: any, detail: any) => {
      if (detail?.sessionId !== sessionId) return;
      if (detail?.toolType && detail.toolType !== toolType) return;
      if (isTurnBusyRef.current) {
        deferredTranscriptRefreshRef.current = true;
        historyDiag('TRANSCRIPT_DEFERRED tab=' + tabId.slice(-12) +
          ' session=' + sessionId.substring(0, 8) +
          ' tool=' + toolType +
          ' reason=turn-busy' +
          ' source=' + (detail?.reason || 'transcript-change'));
        return;
      }
      queueRefresh(detail?.reason || 'transcript-change');
    };
    ipcRenderer.on('agent-transcript:changed', onChanged);
    ipcRenderer.invoke('agent-transcript:subscribe', {
      consumerId,
      tabId,
      toolType,
      sessionId,
      cwd,
    }).then((result: any) => {
      if (disposed) {
        ipcRenderer.invoke('agent-transcript:unsubscribe', { consumerId }).catch(() => {});
        return;
      }
      historyDiag('TRANSCRIPT_SUBSCRIBE tab=' + tabId.slice(-12) +
        ' session=' + sessionId.substring(0, 8) +
        ' tool=' + toolType +
        ' ok=' + (result?.success ? '1' : '0') +
        ' file=' + (result?.filePath ? '1' : '0'));
    }).catch((e: any) => {
      historyDiag('TRANSCRIPT_SUBSCRIBE_ERROR tab=' + tabId.slice(-12) +
        ' session=' + sessionId.substring(0, 8) +
        ' tool=' + toolType +
        ' error=' + String(e?.message || e));
    });
    return () => {
      disposed = true;
      ipcRenderer.removeListener('agent-transcript:changed', onChanged);
      ipcRenderer.invoke('agent-transcript:unsubscribe', { consumerId }).catch(() => {});
    };
  }, [sessionId, cwd, tabId, toolType, flushLiveHistoryToDurable, historyOwnerKey]);

  useEffect(() => {
    if (isTurnBusy) return;
    // Claude may publish a standalone thinking record that is intentionally
    // absent from the durable History projection. It remains visible while the
    // turn is live, but at the authoritative settled edge it must not become a
    // permanent unmatched row or force three full-history reloads forever.
    const live = liveProjectionRef.current;
    if (live.ownerKey === historyOwnerKey && live.entries.length > 0) {
      const settledEntries = reduceHistoryLiveProjection(live.entries, {
        type: 'turn_boundary',
        boundary: 'turn_settled',
        sessionId,
      }) as FullHistoryEntry[];
      if (settledEntries !== live.entries) {
        liveProjectionRef.current = { ownerKey: historyOwnerKey, entries: settledEntries };
        setLiveEntries(settledEntries);
      }
    }
    const hasLiveProjection = hasUnmatchedLiveForOwner(historyOwnerKey);
    if (!deferredTranscriptRefreshRef.current && !hasLiveProjection) return;
    historyDiag('TRANSCRIPT_FLUSH tab=' + tabId.slice(-12) +
      ' session=' + (sessionId ? sessionId.substring(0, 8) : 'none') +
      ' tool=' + toolType +
      ' reason=turn-settled' +
      ' live=' + (hasLiveProjection ? '1' : '0'));
    const ownerKey = historyOwnerKey;
    void flushLiveHistoryToDurable('turn-settled', ownerKey);
  }, [
    flushLiveHistoryToDurable,
    hasUnmatchedLiveForOwner,
    historyOwnerKey,
    isTurnBusy,
    sessionId,
    tabId,
    toolType,
  ]);

  // Listen for scroll-to-bottom from Timeline arrow button
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tabId === tabId) scrollToBottom(false);
    };
    window.addEventListener('history-panel:scroll-to-bottom', handler);
    return () => window.removeEventListener('history-panel:scroll-to-bottom', handler);
  }, [tabId, scrollToBottom]);

  // Scroll to entry when Timeline click sets historyScrollToUuid.
  //
  // Race: Cmd+click on Timeline opens the panel AND sets uuid in the same tick.
  // The panel mounts → loadHistory async → entries=[] for ~200-500ms.
  // Effect runs immediately with entries=[] → must NOT drop the uuid (otherwise
  // the click is lost forever). Only clear uuid once we've actually scrolled.
  //
  // Target lookup uses the entry index (we have entries[] here) — Virtuoso's
  // scrollToIndex handles the off-screen case; DOM querySelector wouldn't
  // find a virtualized item that isn't mounted yet.
  const [flashUuid, setFlashUuid] = useState<string | null>(null);

  // Generation guard for the scroll-to-uuid convergence loop below: a newer
  // Cmd+click supersedes an in-flight loop, and unmount stops it (so it can't
  // setState on an unmounted component). NOT driven by the effect's cleanup —
  // the loop must survive the re-render caused by clearing historyScrollToUuid.
  const scrollGenRef = useRef(0);
  const scrollMountedRef = useRef(true);
  const historyScrollInFlightRef = useRef<{
    uuid: string;
    gen: number;
    startedAt: number;
    attempts: number;
  } | null>(null);
  const lastProgrammaticHistoryScrollRef = useRef<{
    uuid: string;
    doneAt: number;
    reason: string;
    scrollTop: number;
    userIntentLogged: boolean;
    scrollEventLogged: boolean;
  } | null>(null);
  const historyTouchYRef = useRef<number | null>(null);
  useEffect(() => {
    // React StrictMode and Fast Refresh both run cleanup before installing the
    // same effect again while preserving refs. Re-arm the liveness proof in
    // setup; otherwise every later Timeline click starts a convergence loop
    // that exits before its first animation frame.
    scrollMountedRef.current = true;
    return () => {
      scrollMountedRef.current = false;
      historyScrollInFlightRef.current = null;
      scrollGenRef.current++;
    };
  }, []);

  const cancelHistoryScrollFromUser = useCallback((reason: string) => {
    const inFlight = historyScrollInFlightRef.current;
    if (!inFlight) return false;
    if (!scrollMountedRef.current || scrollGenRef.current !== inFlight.gen) {
      historyScrollInFlightRef.current = null;
      return false;
    }
    scrollGenRef.current++;
    historyScrollInFlightRef.current = null;
    setFlashUuid(null);
    const scroller = virtuosoScrollerRef.current;
    historyDiag('SCROLL_TO_CANCEL tab=' + tabId.slice(-12) +
      ' uuid=' + inFlight.uuid.slice(0, 8) +
      panelDiagContextRef.current +
      ' reason=' + reason +
      ' attempts=' + inFlight.attempts +
      ' elapsedMs=' + Math.round(performance.now() - inFlight.startedAt) +
      ' range=' + visibleRangeRef.current.start + '-' + visibleRangeRef.current.end +
      ' scrollTop=' + Math.round(scroller?.scrollTop || 0) +
      ' scrollHeight=' + Math.round(scroller?.scrollHeight || 0));
    window.dispatchEvent(
      new CustomEvent('history-panel:scrolled-to', { detail: { tabId, uuid: inFlight.uuid, found: true, reason } }),
    );
    return true;
  }, [tabId]);

  const handleUserScrollIntent = useCallback((event: Event) => {
    const reason = event.type === 'touchmove' ? 'user-touchmove' : 'user-wheel';
    let isUpwardIntent = false;
    if (event.type === 'wheel') {
      isUpwardIntent = (event as WheelEvent).deltaY < 0;
    } else if (event.type === 'touchmove') {
      const touch = (event as TouchEvent).touches[0];
      const nextY = touch?.clientY ?? null;
      const previousY = historyTouchYRef.current;
      isUpwardIntent = nextY !== null && previousY !== null && nextY > previousY;
      historyTouchYRef.current = nextY;
    }
    if (isUpwardIntent) {
      isAtBottomRef.current = false;
      historyTailPinScheduler.cancel();
    }
    // Any real wheel/touch takes position ownership from a running restore
    // convergence loop (same contract as the Timeline-jump cancel below).
    scrollRestoreGenRef.current += 1;
    if (cancelHistoryScrollFromUser(reason)) return;
    const lastJump = lastProgrammaticHistoryScrollRef.current;
    if (!lastJump || lastJump.userIntentLogged) return;
    const ageMs = performance.now() - lastJump.doneAt;
    if (ageMs > 1500) return;
    lastJump.userIntentLogged = true;
    const scroller = virtuosoScrollerRef.current;
    historyDiag('USER_SCROLL_AFTER_JUMP tab=' + tabId.slice(-12) +
      ' uuid=' + lastJump.uuid.slice(0, 8) +
      panelDiagContextRef.current +
      ' type=' + event.type +
      ' ageMs=' + Math.round(ageMs) +
      ' doneReason=' + lastJump.reason +
      ' range=' + visibleRangeRef.current.start + '-' + visibleRangeRef.current.end +
      ' scrollTop=' + Math.round(scroller?.scrollTop || 0) +
      ' jumpScrollTop=' + Math.round(lastJump.scrollTop));
  }, [cancelHistoryScrollFromUser, historyTailPinScheduler, tabId]);

  const handleHistoryTouchStart = useCallback((event: TouchEvent) => {
    historyTouchYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleHistoryTouchEnd = useCallback(() => {
    historyTouchYRef.current = null;
  }, []);

  useEffect(() => {
    if (!historyScrollToUuid) return;
    if (surfaceLoading || displayEntries.length === 0) return; // wait for entries; uuid stays in store
    const targetUuid = historyScrollToUuid;
    const idx = displayEntryIndexByUuid.get(targetUuid) ?? -1;
    // Consume the store key immediately. The convergence loop is driven by the
    // ref-generation guard, NOT by this effect's cleanup, so clearing the key
    // (which re-runs the effect → early-return above) does not abort the loop.
    setHistoryScrollToUuid(null);
    if (idx < 0) {
      historyDiag('SCROLL_TO_MISS tab=' + tabId.slice(-12) +
        ' uuid=' + targetUuid.slice(0, 8) +
        panelDiagContextRef.current +
        ' entries=' + displayEntries.length +
        ' reason=uuid-not-in-display');
      // entry doesn't exist in this session — acknowledge so the dot spinner clears
      window.dispatchEvent(
        new CustomEvent('history-panel:scrolled-to', { detail: { tabId, uuid: targetUuid, found: false, reason: 'uuid-not-in-display' } }),
      );
      return;
    }

    // Variable-height virtualization race. On the closed→open Cmd+click path
    // the list now mounts at the target index when possible, but rows above the
    // target are still estimated until Virtuoso measures them. Re-issue
    // scrollToIndex across frames until the target row's real DOM rect stops
    // moving (Virtuoso has honored the scroll AND finished measuring), then
    // flash + emit the done-event. Stability is the signal.
    const myGen = ++scrollGenRef.current;
    const startedAt = performance.now();
    let attempts = 0;
    let stable = 0;
    let lastTop: number | null = null;
    let sawNode = false;
    const MAX_ATTEMPTS = 240; // rAF bounded; long variable-height sessions may need many measurements
    historyScrollInFlightRef.current = { uuid: targetUuid, gen: myGen, startedAt, attempts: 0 };

    const startScroller = virtuosoScrollerRef.current;
    const startScrollHeight = Math.round(startScroller?.scrollHeight || 0);
    historyDiag('SCROLL_TO_START tab=' + tabId.slice(-12) +
      ' uuid=' + targetUuid.slice(0, 8) +
      panelDiagContextRef.current +
      ' idx=' + idx +
      ' entries=' + displayEntries.length +
      ' initialIdx=' + pendingInitialHistoryIndex +
      ' range=' + visibleRangeRef.current.start + '-' + visibleRangeRef.current.end +
      ' scrollTop=' + Math.round(startScroller?.scrollTop || 0) +
      ' scrollHeight=' + startScrollHeight +
      ' clientHeight=' + Math.round(startScroller?.clientHeight || 0) +
      ' pixelCap=' + (startScrollHeight >= HISTORY_SCROLL_PIXEL_CAP_WARN_PX ? 1 : 0));

    const finish = (found: boolean, reason: string) => {
      if (!scrollMountedRef.current || scrollGenRef.current !== myGen) return;
      const scroller = virtuosoScrollerRef.current;
      historyScrollInFlightRef.current = null;
      historyDiag('SCROLL_TO_DONE tab=' + tabId.slice(-12) +
        ' uuid=' + targetUuid.slice(0, 8) +
        panelDiagContextRef.current +
        ' found=' + found +
        ' reason=' + reason +
        ' attempts=' + attempts +
        ' sawNode=' + sawNode +
        ' stable=' + stable +
        ' elapsedMs=' + Math.round(performance.now() - startedAt) +
        ' range=' + visibleRangeRef.current.start + '-' + visibleRangeRef.current.end +
        ' scrollTop=' + Math.round(scroller?.scrollTop || 0) +
        ' scrollHeight=' + Math.round(scroller?.scrollHeight || 0));
      if (found) {
        lastProgrammaticHistoryScrollRef.current = {
          uuid: targetUuid,
          doneAt: performance.now(),
          reason,
          scrollTop: scroller?.scrollTop || 0,
          userIntentLogged: false,
          scrollEventLogged: false,
        };
        setFlashUuid(targetUuid);
      }
      window.dispatchEvent(
        new CustomEvent('history-panel:scrolled-to', { detail: { tabId, uuid: targetUuid, found, reason } }),
      );
      if (!found) return;
      setTimeout(() => {
        if (scrollMountedRef.current && scrollGenRef.current === myGen) setFlashUuid(null);
      }, 600);
    };

    let capSuspectLogged = false;
    const step = () => {
      if (!scrollMountedRef.current || scrollGenRef.current !== myGen) return; // superseded / unmounted
      const currentIdx = displayEntryIndexByUuidRef.current.get(targetUuid) ?? -1;
      if (currentIdx < 0) {
        finish(false, 'target-disappeared');
        return;
      }
      virtuosoRef.current?.scrollToIndex({ index: currentIdx, align: 'center', behavior: 'auto' });
      attempts++;
      if (historyScrollInFlightRef.current?.gen === myGen) {
        historyScrollInFlightRef.current.attempts = attempts;
      }
      const scroller = virtuosoScrollerRef.current;
      const node = scroller?.querySelector(`[data-uuid="${CSS.escape(targetUuid)}"]`) as HTMLElement | null;
      if (!node && !capSuspectLogged && scroller && attempts >= 20) {
        const range = visibleRangeRef.current;
        const farFromMountedRange = currentIdx < range.start - 50 || currentIdx > range.end + 50;
        if (farFromMountedRange && scroller.scrollHeight >= HISTORY_SCROLL_PIXEL_CAP_WARN_PX) {
          capSuspectLogged = true;
          historyDiag('SCROLL_CAP_SUSPECT tab=' + tabId.slice(-12) +
            ' uuid=' + targetUuid.slice(0, 8) +
            panelDiagContextRef.current +
            ' idx=' + currentIdx +
            ' entries=' + entriesRef.current.length +
            ' attempts=' + attempts +
            ' range=' + range.start + '-' + range.end +
            ' scrollTop=' + Math.round(scroller.scrollTop) +
            ' scrollHeight=' + Math.round(scroller.scrollHeight));
        }
      }
      if (node && scroller) {
        sawNode = true;
        // Offset of the row relative to the scroller's own viewport — immune to
        // the panel's slide-in transform (both translate together), so this only
        // moves when the INTERNAL scroll position is still settling.
        const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        if (lastTop !== null && Math.abs(top - lastTop) < 1) stable++; else stable = 0;
        lastTop = top;
        // Mounted + position unchanged for 2 consecutive frames, after at least
        // a few scrollToIndex calls → Virtuoso has settled on the target row.
        if (stable >= 2 && attempts >= 3) { finish(true, 'stable-mounted'); return; }
      }
      if (attempts >= MAX_ATTEMPTS) {
        // A row seen on an earlier frame is not proof that the final target is
        // still mounted or settled. Report failure unless the normal stable
        // branch above completed; Timeline must not clear its pending jump on
        // a historical sighting.
        finish(false, node ? 'max-attempts-unstable-mounted' : 'max-attempts-unmounted');
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [displayEntryIndexByUuid, displayEntries, historyScrollToUuid, pendingInitialHistoryIndex, setHistoryScrollToUuid, surfaceLoading, tabId]);

  // Native scroll handler — runs on the Virtuoso scroller element via a
  // direct addEventListener (Virtuoso doesn't pass an onScroll prop through
  // to the scroller). Computes scroll direction, at-bottom flag, debounced
  // position save; the at-bottom signal is also reported by Virtuoso via
  // `atBottomStateChange`, but we keep the scrollTop-derived signal because
  // it updates synchronously on every wheel tick (needed for the FAB toggle).
  const lastScrollTopRef = useRef(0);
  const scrollDirectionRef = useRef<'down' | 'up'>('down');
  const handleScroll = useCallback(() => {
    const el = virtuosoScrollerRef.current;
    if (!el) return;
    clearHistoryToolScrollFocus('history-scroll');
    const deltaTop = el.scrollTop - lastScrollTopRef.current;
    const lastJump = lastProgrammaticHistoryScrollRef.current;
    if (lastJump && !lastJump.scrollEventLogged) {
      const ageMs = performance.now() - lastJump.doneAt;
      if (ageMs <= 1500) {
        lastJump.scrollEventLogged = true;
        historyDiag('SCROLL_EVENT_AFTER_JUMP tab=' + tabId.slice(-12) +
          ' uuid=' + lastJump.uuid.slice(0, 8) +
          panelDiagContextRef.current +
          ' ageMs=' + Math.round(ageMs) +
          ' deltaTop=' + Math.round(deltaTop) +
          ' doneReason=' + lastJump.reason +
          ' range=' + visibleRangeRef.current.start + '-' + visibleRangeRef.current.end +
          ' scrollTop=' + Math.round(el.scrollTop) +
          ' jumpScrollTop=' + Math.round(lastJump.scrollTop));
      }
    }
    const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    isAtBottomRef.current = isHistoryTailPinned(el);
    if (scrollArrowRef.current) {
      scrollArrowRef.current.style.display = distFromBottom > 150 ? '' : 'none';
    }
    scrollDirectionRef.current = el.scrollTop >= lastScrollTopRef.current ? 'down' : 'up';
    lastScrollTopRef.current = el.scrollTop;
    if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
    // Capture the owner key NOW, not when the timer fires: the panel is
    // persistently mounted, so 150ms later the tab may already be a
    // different one and a ref read would file this position under the
    // destination tab's key (the proven cross-tab poisoning bug).
    const saveKey = scrollPositionKeyRef.current;
    scrollSaveTimerRef.current = setTimeout(() => {
      // Stale-guard: fire only while the same owner is still presented and
      // the scroller shows ITS rows. An owner switch mid-debounce discards
      // the save — the anchor already stored on the previous idle tick wins.
      if (scrollPositionKeyRef.current !== saveKey) return;
      if (!el.isConnected) return;
      setHistoryScrollPosition(saveKey, el.scrollTop);
      // Reading anchor: row identity + in-row offset instead of raw pixels.
      // Virtualized heights are estimates until measured, so scrollTop stops
      // meaning anything across remounts/re-measures; the anchor survives
      // both and an app restart (localStorage).
      const anchor = captureHistoryAnchorFromDom(el, isHistoryTailPinned(el));
      if (anchor) {
        setHistoryReadingAnchor(saveKey, {
          ...anchor,
          savedAt: Date.now(),
        });
        historyDiag('SCROLL_SAVE tab=' + tabId.slice(-12)
          + ' uuid=' + anchor.uuid.slice(0, 8)
          + ' offset=' + anchor.offsetPx
          + ' followBottom=' + (anchor.followBottom ? '1' : '0'));
      }
      // Deferral state of what is on screen NOW. The presentation-time count
      // only describes the first frame of the owner, so scrolling to a diff
      // card produced no evidence that deferral engaged (e2e18 read
      // deferredDiffRows=0 with a diff card plainly visible and concluded the
      // feature was broken — it was the probe that was blind, not the feature).
      const deferRowsNow = el.querySelectorAll('.cb-diff-defer').length;
      if (deferRowsNow > 0) {
        historyDiag('DEFER_LIVE tab=' + tabId.slice(-12)
          + ' rows=' + deferRowsNow
          + ' range=' + visibleRangeRef.current.start + '-' + visibleRangeRef.current.end);
      }
      // Sample the MEASURED geometry on the same scroll-idle tick. The list is
      // alive here, so Virtuoso's reactive graph can actually answer — unlike
      // at owner teardown, where the request is dropped silently. Scroll-idle
      // is also the moment the geometry is most complete: whatever the user
      // just scrolled past has been measured for real.
      const layoutKey = historyOwnerKeyRef.current;
      const layoutItems = lengthRef.current;
      try {
        virtuosoRef.current?.getState((snapshot) => {
          if (historyOwnerKeyRef.current !== layoutKey) return; // owner moved on
          saveHistoryMeasuredLayout(layoutKey, snapshot as any, layoutItems);
        });
      } catch { /* geometry is optional; never break position saving */ }
    }, 150);
  }, [clearHistoryToolScrollFocus, tabId, setHistoryScrollPosition]);

  // Keep entries ref fresh for observer closure (avoids stale data if entries update with same length)
  const entriesRef = useRef(displayEntries);
  entriesRef.current = displayEntries;

  // Build mapping: assistant/non-user UUID → preceding user UUID
  // So when an assistant response is visible, the parent user dot stays highlighted in Timeline.
  const assistantToUserMap = React.useMemo(() => {
    const map = new Map<string, string>();
    let lastUserUuid: string | null = null;
    for (const e of displayEntries) {
      if (e.role === 'user') {
        lastUserUuid = e.uuid;
      } else if (lastUserUuid) {
        map.set(e.uuid, lastUserUuid);
      }
    }
    return map;
  }, [displayEntries]);

  // Track visible entries for Timeline viewport indicator (UUID-based, no text search).
  //
  // Prev impl used IntersectionObserver on `[data-uuid]` children of scrollRef.
  // With Virtuoso, off-screen children are unmounted — IntersectionObserver
  // would see only the small mounted window and the inferred "visible" set
  // would be inflated. Instead Virtuoso reports `rangeChanged({startIndex,
  // endIndex})` on every scroll/resize; we recompute the visible UUID set
  // from that index range directly. Cheaper than IO, exact.
  const recomputeVisibleUuids = useCallback(() => {
    const all = entriesRef.current;
    if (all.length === 0) {
      setHistoryVisibleUuids(tabId, []);
      return;
    }
    const { start, end } = visibleRangeRef.current;
    const clampedStart = Math.max(0, Math.min(start, all.length - 1));
    const clampedEnd = Math.max(clampedStart, Math.min(end, all.length - 1));
    const visibleSet = new Set<string>();
    const directlyVisibleUsers: string[] = [];
    for (let i = clampedStart; i <= clampedEnd; i++) {
      const e = all[i];
      if (!e?.uuid) continue;
      visibleSet.add(e.uuid);
      if (e.role === 'user') directlyVisibleUsers.push(e.uuid);
    }
    const resolvedSet = new Set<string>();
    for (const uuid of visibleSet) {
      resolvedSet.add(uuid);
      const parentUser = assistantToUserMap.get(uuid);
      if (parentUser) resolvedSet.add(parentUser);
    }
    // Single-turn highlight: if multiple user entries are directly visible,
    // keep only one based on scroll direction (matches the IO impl).
    if (directlyVisibleUsers.length > 1) {
      const keepIdx = scrollDirectionRef.current === 'down'
        ? directlyVisibleUsers.length - 1
        : 0;
      for (let j = 0; j < directlyVisibleUsers.length; j++) {
        if (j !== keepIdx) resolvedSet.delete(directlyVisibleUsers[j]);
      }
    }
    const key = [...resolvedSet].sort().join(',');
    if (key !== prevVisibleUuidsRef.current) {
      prevVisibleUuidsRef.current = key;
      setHistoryVisibleUuids(tabId, [...resolvedSet]);
    }
  }, [tabId, setHistoryVisibleUuids, assistantToUserMap]);

  // Reset prev key + cleanup on session change
  useEffect(() => {
    prevVisibleUuidsRef.current = '';
    return () => {
      setHistoryVisibleUuids(tabId, []);
    };
  }, [tabId, setHistoryVisibleUuids]);

  // Recompute when entries change (incremental refresh adds rows → bottom range may shift)
  useEffect(() => {
    lengthRef.current = transcriptEntries.length;
    recomputeVisibleUuids();
  }, [recomputeVisibleUuids, transcriptEntries.length]);

  // Resize handle
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const rightEdge = panelRef.current?.getBoundingClientRect().right ?? (document.body.clientWidth - notesPanelWidth);
      const newWidth = rightEdge - e.clientX;
      if (newWidth >= 280) {
        setHistoryPanelWidth(newWidth);
      }
    };
    const handleMouseUp = () => {
      if (previewMode || embeddedFill) return;
      if (isResizing.current) {
        isResizing.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [embeddedFill, notesPanelWidth, previewMode, setHistoryPanelWidth]);

  const handleResizeDoubleClick = useCallback(() => {
    closePanel();
  }, [closePanel]);

  // Single composer for the tab, rendered either inside the panel (History
  // primary) or into the docked host below the terminal (terminal primary).
  // Built once as a node so both placements share identical props — two
  // separately mounted composers would split the draft in half.
  const composerNode = enableClaudePtyControls && (toolType === 'claude' || toolType === 'codex') ? (
    <AgentHistoryControls
      tabId={tabId}
      sessionId={sessionId}
      cwd={cwd}
      projectId={projectId}
      toolType={toolType as AgentHistoryTool}
      onHistoryRefresh={(reason) => {
        const settlesTurn = reason?.startsWith('busy-false:')
          || reason === 'command-finished';
        if (settlesTurn) {
          return flushLiveHistoryToDurable(
            'history-controls:' + reason,
            historyOwnerKey,
          );
        }
        return loadHistory(true);
      }}
      onPromptSubmitted={appendLocalPromptEntry}
      onPromptStatusChange={updateLocalPromptEntry}
      hasDurablePrompt={hasDurablePrompt}
      rewindLocked={rewindLocked}
      rewindPhase={activeRewindOperation?.phase}
      rewindMessage={activeRewindOperation?.message}
      rewindPreviewActive={!!rewindPreview}
      rewindPreviewHiddenCount={rewindPreviewHiddenCount}
      terminalOpen={terminalOpen}
      onToggleTerminal={onToggleTerminal}
      onSwapPrimarySurface={onSwapPrimarySurface}
      terminalIsPrimary={terminalIsPrimary}
      lifecycleStatus={lifecycleStatus}
      operationalPhase={compactOperationalPhase}
      onHeightChange={handleControlsHeightChange}
      // Overlay geometry belongs to the centered layout only; docked below the
      // terminal the composer is a normal bottom row of the workspace column.
      overlayComposer={mainSurface}
      agentInputSurface={agentInputSurface}
    />
  ) : null;

  // No session id can mean three different things. Only one of them is real
  // waiting: the agent process is currently starting. A stopped fresh tab is
  // waiting for the USER to choose an agent, while a ready process with no id
  // is waiting for the first prompt to materialize its history file. Showing
  // the same spinner for all three made an idle screen look stuck.
  const unboundAgentName = toolType === 'codex' ? 'Codex' : 'Claude';
  const unboundAgentStarting = !sessionId && (
    agentProcessStatus === 'starting'
    || (lifecycleStatus?.tabId === tabId && lifecycleStatus.kind === 'starting')
  );
  const unboundAgentStopped = !sessionId
    && !unboundAgentStarting
    && agentProcessStatus === 'inactive';

  const panel = (
    <div
      ref={panelRef}
      data-history-main={mainSurface ? '1' : undefined}
      // Observable open/geometry state: "the panel is off-screen" and "the
      // panel was never told to open" look identical in a screenshot, and the
      // side-panel layout has two independent inputs (per-tab open flag and
      // the slide animation). Both are published so a test can tell them apart.
      data-history-open={isOpen ? '1' : '0'}
      data-history-slide={slideIn ? '1' : '0'}
      data-history-owner={historyOwnerDomId}
      data-history-session={sessionId || undefined}
      data-history-viewport-ready={
        viewportReadyOwnerKey === historyOwnerKey ? '1' : '0'
      }
      style={{
        position: embedded ? 'relative' : 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
        width: embedded ? (embeddedFill ? '100%' : (slideIn ? width : 0)) : width,
        height: '100%',
        flexShrink: 0,
        overflow: 'hidden',
        backgroundColor: '#1a1a1a',
        borderLeft: mainSurface || (embedded && (!slideIn || previewMode)) ? 'none' : '1px solid #333',
        zIndex: mainSurface ? 1 : 101,
        display: 'flex',
        flexDirection: 'column',
        transform: embedded ? 'none' : (slideIn ? 'translateX(0)' : 'translateX(100%)'),
        transition: embedded ? (embeddedFill ? 'none' : 'width 50ms ease-out') : 'transform 50ms ease-out',
      }}
    >
      {/* Resize handle (left edge) */}
      {!previewMode && !embeddedFill && (
        <div
          onMouseDown={handleResizeMouseDown}
          onDoubleClick={handleResizeDoubleClick}
          style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 4,
            cursor: 'col-resize', zIndex: 10, backgroundColor: 'transparent',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#5b9cf5'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'; }}
        />
      )}

      {/* Header. In the primary History surface it exists only as a transient
          Cmd+F search strip; the old panel title/reset/close chrome is gone. */}
      {(!mainSurface || searchOpen) && (
      <div
        style={mainSurface ? {
          position: 'absolute',
          top: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 30,
          width: 'min(440px, calc(100% - 32px))',
          height: 32,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 8px',
          border: '1px solid #3f3f46',
          borderRadius: 7,
          background: 'rgba(24,24,27,0.96)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.38)',
        } : {
          display: 'flex', alignItems: 'center', height: 30,
          padding: '0 8px 0 12px', borderBottom: '1px solid #333', flexShrink: 0, gap: 6,
        }}
      >
        {!mainSurface && (
        <span style={{ fontSize: 12, color: '#999', fontWeight: 500, flexShrink: 0 }}>History</span>
        )}
        {!mainSurface && (
        <ControlHint label="Поиск по History" shortcut="⌘F">
        <button
          onClick={openSearch}
          style={{
            background: 'none', border: 'none', color: searchOpen ? '#e0e0e0' : '#666',
            cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = searchOpen ? '#e0e0e0' : '#666'; }}
        >
          <Search size={13} />
        </button>
        </ControlHint>
        )}
        {searchOpen && (
          <>
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); goNextMatch(); }
                if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); goPrevMatch(); }
                if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
                if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation();
              }}
              placeholder="Search..."
              style={{
                flex: 1, minWidth: 0, height: 20, fontSize: 12,
                backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: 3,
                color: '#e0e0e0', padding: '0 6px', outline: 'none',
              }}
              onFocus={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = '#5b9cf5'; }}
              onBlur={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = '#444'; }}
            />
            <ControlHint label="Предыдущее совпадение" shortcut="Shift+Enter">
            <button onClick={goPrevMatch} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', padding: 1, display: 'flex' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#888'; }}
            ><ArrowUp size={14} /></button>
            </ControlHint>
            <ControlHint label="Следующее совпадение" shortcut="Enter">
            <button onClick={goNextMatch} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', padding: 1, display: 'flex' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#888'; }}
            ><ArrowDown size={14} /></button>
            </ControlHint>
            <span style={{ fontSize: 11, color: '#666', flexShrink: 0, minWidth: 35, textAlign: 'right' }}>
              {matchPositions.length > 0 ? `${currentMatchIdx + 1}/${matchPositions.length}` : searchQuery.length >= 2 ? '0' : ''}
            </span>
            <ControlHint label="Закрыть поиск" shortcut="Esc">
            <button onClick={closeSearch} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', padding: 1, display: 'flex', flexShrink: 0 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#666'; }}
            ><X size={13} /></button>
            </ControlHint>
          </>
        )}
        {!searchOpen && !mainSurface && <div style={{ flex: 1 }} />}
        {!previewMode && !mainSurface && (
          <>
            <ControlHint label="Вернуть ширину History по умолчанию">
              <button
                aria-label="Reset History panel width"
                onClick={resetPanelWidth}
                style={{
                  background: 'none',
                  border: 'none',
                  color: width === HISTORY_PANEL_DEFAULT_WIDTH ? '#444' : '#666',
                  cursor: 'pointer',
                  padding: 2,
                  width: 22,
                  height: 22,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = width === HISTORY_PANEL_DEFAULT_WIDTH ? '#444' : '#666'; }}
              >
                <RotateCcw size={15} />
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: '50%',
                    transform: 'translateY(-48%)',
                    textAlign: 'center',
                    fontSize: 7,
                    fontWeight: 800,
                    lineHeight: 1,
                    pointerEvents: 'none',
                  }}
                >
                  W
                </span>
              </button>
            </ControlHint>
            <ControlHint label="Закрыть History">
              <button
                onClick={closePanel}
                style={{
                  background: 'none', border: 'none', color: '#666',
                  cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', flexShrink: 0,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#666'; }}
              >
                <X size={14} />
              </button>
            </ControlHint>
          </>
        )}
      </div>
      )}

      {/* Content */}
      <div data-history-content-stage style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <HistoryPayloadContext.Provider value={historyPayloadContextValue}>
        <HistoryBackgroundLiveContext.Provider value={liveBackgroundUuids}>
        {surfaceLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#818cf8', fontSize: 13, gap: 8 }}>
            <HistorySpinner size={16} />
            Loading...
          </div>
        ) : transcriptEntries.length === 0 ? (
          !sessionId && (toolType === 'claude' || toolType === 'codex') ? (
            <div
              data-history-empty-state={unboundAgentStarting
                ? 'starting-agent'
                : unboundAgentStopped
                  ? 'awaiting-agent-start'
                  : 'awaiting-first-message'}
              style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', height: '100%', color: '#777',
              fontSize: 13, gap: 8, textAlign: 'center', padding: '0 24px',
              }}
            >
              {unboundAgentStarting && <HistorySpinner size={14} />}
              <div>
                {unboundAgentStarting
                  ? `Запускаем ${unboundAgentName}…`
                  : unboundAgentStopped
                    ? 'Запустите Claude или Codex'
                    : 'История пока пуста'}
              </div>
              <div style={{ fontSize: 11, color: '#555' }}>
                {unboundAgentStarting
                  ? 'История появится после первого сообщения.'
                  : unboundAgentStopped
                    ? 'Выберите агента внизу, чтобы начать новую сессию.'
                    : 'Отправьте первое сообщение — после него появится история сессии.'}
              </div>
            </div>
          ) : (
            <div data-history-empty-state="empty-transcript" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#555', fontSize: 13 }}>
              No history entries
            </div>
          )
        ) : (
          <>
          <Virtuoso
            // Keyed by owner AND visit. `restoreStateFrom` is read once, at
            // mount — so a return to the SAME tab reused the existing list and
            // silently ignored the restored geometry: the log showed the right
            // offset going in (50802) while the screen sat at 0 from the third
            // return onward (e2e23). Including the visit generation makes each
            // return a real mount, which is the only moment the prop has any
            // effect. The generation already increments per owner takeover, so
            // this adds no remounts beyond the ones that were happening anyway
            // for cross-tab switches.
            key={historyOwnerKey + ':' + historyOwnerVisit}
            ref={virtuosoRef}
            data={transcriptEntries}
            components={HISTORY_VIRTUOSO_COMPONENTS}
            // Live and durable versions use one physical identity, so a
            // completed answer updates in place instead of unmounting between
            // the rollout event and the durable History refresh.
            computeItemKey={(_idx, item) => historyLivePresentationKey(item)}
            // Mount the scroller against our handleScroll so the per-scroll
            // FAB toggle / position-save stays identical to pre-virtuoso behavior.
            scrollerRef={(el) => {
              const prev = virtuosoScrollerRef.current;
              if (prev && prev !== el) {
                prev.removeEventListener('scroll', handleScroll);
                prev.removeEventListener('wheel', handleUserScrollIntent);
                prev.removeEventListener('touchstart', handleHistoryTouchStart);
                prev.removeEventListener('touchmove', handleUserScrollIntent);
                prev.removeEventListener('touchend', handleHistoryTouchEnd);
                prev.removeEventListener('touchcancel', handleHistoryTouchEnd);
                prev.removeEventListener('pointerdown', handleHistoryToolPointerDown, true);
                prev.removeEventListener('wheel', handleHistoryToolWheel, true);
              }
              virtuosoScrollerRef.current = el as HTMLElement | null;
              if (el) {
                const scroller = el as HTMLElement;
                scroller.addEventListener('scroll', handleScroll, { passive: true });
                scroller.addEventListener('wheel', handleUserScrollIntent, { passive: true });
                scroller.addEventListener('touchstart', handleHistoryTouchStart, { passive: true });
                scroller.addEventListener('touchmove', handleUserScrollIntent, { passive: true });
                scroller.addEventListener('touchend', handleHistoryTouchEnd, { passive: true });
                scroller.addEventListener('touchcancel', handleHistoryTouchEnd, { passive: true });
                scroller.addEventListener('pointerdown', handleHistoryToolPointerDown, true);
                scroller.addEventListener('wheel', handleHistoryToolWheel, { capture: true, passive: false });
              }
            }}
            rangeChanged={(range) => {
              visibleRangeRef.current = { start: range.startIndex, end: range.endIndex };
              const viewportPaintOwner: HistoryViewportPaintOwner = {
                key: historyOwnerKey,
                generation: historyOwnerGenerationRef.current,
              };
              if (
                viewportReadyOwnerKeyRef.current !== historyOwnerKey
                && !viewportPaintProbeRef.current?.isActive(viewportPaintOwner)
              ) {
                const ownerAtRange = historyOwnerKey;
                const generationAtRange = historyOwnerGenerationRef.current;
                viewportPaintProbeRef.current?.start(
                  viewportPaintOwner,
                  () => (
                    historyOwnerKeyRef.current === ownerAtRange
                    && historyOwnerGenerationRef.current === generationAtRange
                    && !!virtuosoScrollerRef.current?.querySelector(
                      `[data-history-row-owner="${CSS.escape(historyOwnerDomId)}"]`,
                    )
                  ),
                  () => {
                    if (
                      historyOwnerKeyRef.current !== ownerAtRange
                      || historyOwnerGenerationRef.current !== generationAtRange
                    ) return;
                    viewportReadyOwnerKeyRef.current = ownerAtRange;
                    setViewportReadyOwnerKey(ownerAtRange);
                    setViewportProofRequired(false);
                    historyDiag('VIEWPORT_READY tab=' + tabId.slice(-12) +
                      ' owner=' + historyOwnerDigest(ownerAtRange) +
                      ' range=' + range.startIndex + '-' + range.endIndex +
                      ' entries=' + displayEntries.length +
                      ' proof=mounted-painted-row');
                  },
                );
              }
              const presentedProofKey = historyOwnerKey + ':' + viewportPaintOwner.generation;
              if (
                surfacePresentedOwnerRef.current !== presentedProofKey
                && !surfacePresentedProbeRef.current?.isActive(viewportPaintOwner)
              ) {
                const ownerAtRange = historyOwnerKey;
                const generationAtRange = historyOwnerGenerationRef.current;
                const cacheAtRange = historySnapshotCache.peek<FullHistoryEntry>(historySnapshotOwner)
                  ? 'hit'
                  : 'miss';
                surfacePresentedProbeRef.current?.start(
                  viewportPaintOwner,
                  () => {
                    if (
                      historyOwnerKeyRef.current !== ownerAtRange
                      || historyOwnerGenerationRef.current !== generationAtRange
                    ) return false;
                    const row = virtuosoScrollerRef.current?.querySelector(
                      `[data-history-row-owner="${CSS.escape(historyOwnerDomId)}"]`,
                    ) as HTMLElement | null;
                    if (!row) return false;
                    // Being IN the markup is not being ON the screen. Under load
                    // — a heavy tab still painting while the user already
                    // switched away — this proof fired with a row that had zero
                    // height, and the surface was declared presented at
                    // `domRows=0 loader=hidden`: exactly the blank frame the
                    // strict loader contract exists to forbid (prod 26.07,
                    // reproduced on every sub-second switch). A real row has
                    // non-zero height.
                    return row.getBoundingClientRect().height > 0;
                  },
                  () => {
                    if (
                      historyOwnerKeyRef.current !== ownerAtRange
                      || historyOwnerGenerationRef.current !== generationAtRange
                    ) return;
                    const allDomRows = virtuosoScrollerRef.current
                      ?.querySelectorAll('[data-uuid]').length || 0;
                    const domRows = virtuosoScrollerRef.current
                      ?.querySelectorAll(
                        `[data-history-row-owner="${CSS.escape(historyOwnerDomId)}"]`,
                      ).length || 0;
                    surfacePresentedOwnerRef.current = presentedProofKey;
                    // paintGapMs is the number the blank-frame class is judged
                    // on: how long the surface stood between "loader gone" and
                    // "rows on screen". Deriving it by pairing two log lines
                    // worked but made every check a manual join; as its own
                    // field it is one grep. deferredDiffRows proves the diff
                    // deferral actually engaged — its absence is how a
                    // threshold bug (per-hunk instead of per-card) survived a
                    // full run unnoticed.
                    // Counted at presentation time, i.e. the first painted
                    // frame of THIS owner. It says whether deferral is active
                    // for what is on screen right now — not whether the
                    // session contains deferrable diffs at all. Scrolling to a
                    // diff later does not retroactively change this line; the
                    // live count is published separately on scroll idle.
                    const deferredDiffRows = virtuosoScrollerRef.current
                      ?.querySelectorAll('.cb-diff-defer').length || 0;
                    const loaderHiddenAt = loaderHiddenAtRef.current;
                    historyDiag('SURFACE_PRESENTED tab=' + tabId.slice(-12)
                      + ' owner=' + historyOwnerDigest(ownerAtRange)
                      + ' generation=' + generationAtRange
                      + ' cache=' + cacheAtRange
                      + ' domRows=' + domRows
                      + ' foreignDomRows=' + Math.max(0, allDomRows - domRows)
                      + ' loader=' + (visibleSurfaceLoading ? 'visible' : 'hidden')
                      + ' paintGapMs=' + (loaderHiddenAt === null
                        ? 'na' : Math.round(performance.now() - loaderHiddenAt))
                      + ' deferredDiffRows=' + deferredDiffRows
                      + ' proof=mounted-painted-row');
                    publishHistorySurfacePresented({
                      ownerKey: ownerAtRange,
                      generation: generationAtRange,
                      proof: 'mounted-painted-row',
                      domRows,
                      foreignDomRows: Math.max(0, allDomRows - domRows),
                      cache: cacheAtRange,
                    });
                    // Baseline geometry sample: covers a visit that is opened
                    // and left before any scroll-idle tick, which would
                    // otherwise store nothing and pay the full anchor hunt on
                    // the next return.
                    //
                    // Deferred by two frames on purpose. At presentation time
                    // the list may still sit at offset 0 while it applies the
                    // restored geometry; sampling right here captured that
                    // transient zero and overwrote a perfectly good saved
                    // position with the top of the list (e2e22: three saves at
                    // 43140 then one at 0, after which every return landed at
                    // the very top). The store rejects such a regression too,
                    // but not creating it is the actual fix.
                    const layoutItems = lengthRef.current;
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                    try {
                      virtuosoRef.current?.getState((snapshot) => {
                        if (historyOwnerKeyRef.current !== ownerAtRange) return;
                        const saved = saveHistoryMeasuredLayout(
                          ownerAtRange, snapshot as any, layoutItems,
                        );
                        if (saved) {
                          historyDiag('LAYOUT_SAVE tab=' + tabId.slice(-12)
                            + ' owner=' + historyOwnerDigest(ownerAtRange)
                            + ' ranges=' + ((snapshot as any)?.ranges?.length ?? 0)
                            + ' items=' + layoutItems
                            + ' at=presented');
                        }
                      });
                    } catch { /* geometry is optional */ }
                    }));
                  },
                );
              }
              recomputeVisibleUuids();
            }}
            // The first owner proof mounts only the actual viewport, keeping a
            // cache-hit switch below one frame budget even when the tail has
            // heavyweight cards. Immediately after that proof the full buffer
            // returns, so flash highlights and Cmd+F still include the same
            // neighborhood as before.
            increaseViewportBy={historyViewportBuffer}
            // Measured geometry from the previous visit to this same owner.
            // With it Virtuoso places the list from REAL sizes instead of
            // estimating and being corrected frame by frame. Mutually
            // exclusive with initialTopMostItemIndex — the snapshot already
            // carries its own scroll offset, and passing both makes the two
            // fight over the initial position.
            {...(restoredMeasuredLayout
              ? { restoreStateFrom: restoredMeasuredLayout as any }
              : { initialTopMostItemIndex })}
            // Same live-position rule as the composer-resize path: the cached
            // flag alone is only as fresh as the last scroll event, and rows
            // append on the agent's schedule, not the reader's. A user
            // scrolling upward through a streaming session kept being pulled
            // back to the tail (prod e2e17: four saves at followBottom=0 then
            // one at 1, with no downward input in between). Intent must be
            // held AND the scroller must still actually be at the bottom.
            followOutput={() => {
              if (!isAtBottomRef.current) return false;
              const scroller = virtuosoScrollerRef.current;
              if (scroller && !isHistoryTailPinned(scroller)) return false;
              return 'auto';
            }}
            className="hp-history-transcript"
            style={{
              height: '100%',
              fontSize: historyFontSize,
              ['--cb-fs-base' as any]: '1em',
              ['--hp-composer-overlay-height' as any]: mainSurface ? controlsHeight + 'px' : '0px',
            }}
            itemContent={(_idx, entry) => {
              const presentedEntry = applyHistoryLiveToolResultsToEntry(
                entry,
                visibleLiveToolResultValues,
              ) as FullHistoryEntry;
              // Red tint for the chain-break zone: every entry at or before
              // the boundary uuid is unreachable by Claude's own backtrace
              // (live Claude would truncate to entries AFTER the boundary on
              // next resume). Independent of compact — orphans appear with
              // or without compact (rebuild / Stop / Esc / SSE crash).
              const isChainBreakZone =
                claudeMemoryBoundaryIndex >= 0 && _idx <= claudeMemoryBoundaryIndex;
              return (
                <div
                  data-uuid={presentedEntry.uuid}
                  data-history-row-owner={historyOwnerDomId}
                  data-history-live-entry={presentedEntry.liveProjection ? '1' : undefined}
                  data-history-durable-source={
                    !presentedEntry.liveProjection
                      ? presentedEntry.sourceIdentity || undefined
                      : undefined
                  }
                  onContextMenu={(event) => openHistoryEntryContextMenu(event, presentedEntry, toolType)}
                  style={{
                    paddingTop: 4,
                    paddingBottom: 4,
                    backgroundColor: isChainBreakZone ? 'rgba(239, 68, 68, 0.06)' : undefined,
                    ...(flashUuid === presentedEntry.uuid ? { animation: 'hp-flash 500ms ease-in-out' } : undefined),
                  }}
                >
                  <HistoryEntry
                    entry={presentedEntry}
                    tabId={tabId}
                    toolType={toolType}
                    allowRewind={!previewMode && toolType !== 'gemini'}
                    rewindLocked={rewindLocked}
                    forceExpanded={
                      searchQuery.length >= 2
                      && entry.content.toLowerCase().includes(searchQuery.toLowerCase())
                    }
                  />
                </div>
              );
            }}
          />
          {viewportAwaitingFirstRange && (
            <div
              data-history-viewport-loader
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 5,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                background: '#151515',
                color: '#818cf8',
                fontSize: 13,
                pointerEvents: 'none',
              }}
            >
              <HistorySpinner size={16} />
              Loading...
            </div>
          )}
          </>
        )}
        </HistoryBackgroundLiveContext.Provider>
        </HistoryPayloadContext.Provider>
        {backgroundHistoryChips.length > 0 && (
          // Live face of background work (bash run_in_background, subagents):
          // chips strip pinned above the composer, SDK-tab presentation. A
          // chip click expands the workflow-style detail pane above the bar;
          // «в историю» inside the pane jumps to the transcript card. The
          // inline card keeps the handed-off/terminal state.
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: mainSurface ? controlsHeight : 0,
              zIndex: 7,
            }}
          >
            <HistoryBackgroundTasksBar
              chips={backgroundHistoryChips}
              expandedKey={expandedBackgroundChipKey}
              onToggle={(chipKey) => setExpandedBackgroundChipKey(
                (current) => current === chipKey ? null : chipKey,
              )}
              onJumpToCard={(entryUuid) => setHistoryScrollToUuid(entryUuid)}
              tabId={tabId}
              toolType={toolType}
              cwd={cwd}
              sessionId={sessionId || ''}
            />
          </div>
        )}
        {/* Scroll-to-bottom arrow — visibility toggled via ref in handleScroll */}
        <ControlHint label="Прокрутить History вниз">
        <div
          ref={scrollArrowRef}
          className="flex items-center justify-center"
          onClick={() => scrollToBottom(false)}
          style={{
            display: 'none',
            position: 'absolute',
            bottom: (mainSurface ? controlsHeight : 0) + 12,
            right: 12,
            width: 28,
            height: 28,
            borderRadius: 6,
            backgroundColor: '#323237',
            border: '1px solid rgba(167, 139, 250, 0.3)',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
            cursor: 'pointer',
            zIndex: 10,
          }}
        >
          <ChevronDown size={16} color="#a78bfa" strokeWidth={2.5} />
        </div>
        </ControlHint>
      </div>

      {composerNode && !composerPortalHostId && composerNode}
    </div>
  );

  // Docked below the terminal in terminal-primary. The host is a workspace-level
  // element, so the composer keeps its identity (one mount, one draft) while the
  // transcript above it moves to the side panel.
  const dockedComposer = composerNode && composerPortalHostId && composerHostEl
    ? createPortal(composerNode, composerHostEl)
    : null;

  if (embedded) return <>{panel}{dockedComposer}</>;

  // Unpinned History floats above the terminal WITHOUT a backdrop and without
  // click-outside close: it is a parallel working surface, not a modal. Dimming
  // the terminal and dismissing the panel on the next click made every glance
  // at the terminal cost a reopen. Closing stays explicit — Cmd+] or the ×.
  return (
    <>
      {panel}
      {dockedComposer}
    </>
  );
}

export default memo(HistoryPanel);
