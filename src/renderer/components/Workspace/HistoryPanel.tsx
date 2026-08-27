import React, { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo, memo, startTransition } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { X, ChevronDown, ChevronRight, Search, ArrowUp, ArrowDown, ArrowDownToLine, RotateCcw, Scissors, AlertTriangle, Copy, Check, Loader2, Play, TerminalSquare, Bot, ArrowLeftRight, SlidersHorizontal, Target, Trash2 } from 'lucide-react';
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
import {
  historyActionHeadline,
  historyActionPresentationMeta,
  historyDisplayPath,
} from '../../../shared/history-action-grammar.mjs';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useRewindOperationStore } from '../../store/useRewindOperationStore';
import {
  isRewindOperationBlocking,
  selectActiveRewindOperation,
  type RewindOperationPhase,
} from '../../store/rewindOperationState';
import Tooltip from '../UI/Tooltip';
import ControlHint from '../UI/ControlHint';
import SideSurfaceToggleButton from './SideSurfaceToggleButton';
import CenteredUpwardPopover from '../UI/CenteredUpwardPopover';
import {
  getHistoryAgentRuntime,
  type AgentDraftGrabResult,
  type AgentHistoryTool,
  type AgentPendingQuestion,
  type AgentPtyStatus,
  type AgentQuestion,
} from '../../utils/historyAgentRuntimes';
import { sendAgentPromptScenario } from '../../utils/agentScenarios';
import {
  executeHistoryRewriteRewindScenario,
  HistoryRewriteRewindError,
} from '../../utils/historyRewriteRewind';
import {
  buildExactDraftCaptureProof,
  classifyAgentDraftPreflight,
  resolveAgentDraftConflict,
} from '../../utils/agentDraftPreflight.mjs';
import { showAgentDraftScreenContradictionToast } from '../../utils/agentDraftContradictionToast.mjs';
import { terminalRegistry } from '../../utils/terminalRegistry';
import {
  beginCoordinatedAgentSend,
  bindCoordinatedAgentSendHandoff,
  getCoordinatedAgentAction,
  requestCoordinatedStopAfterSend,
  subscribeCoordinatedAgentActions,
} from '../../utils/agentActionCoordinator.mjs';
import { isHistoryTaskBackgroundLive } from '../../utils/historyBackgroundLiveness.mjs';
import { markRendererActivity } from '../../utils/rendererActivityTrail';
import {
  setComposerControlsHost,
  releaseComposerControlsHost,
} from '../../utils/composerControlsHost.mjs';
import { recordHistorySurfacePresented } from '../../utils/timelineTranscriptRefresh.mjs';
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
  updateHistoryMeasuredLayoutScrollTop,
  estimateHistoryAverageRowHeight,
  createHistoryRowHeightLookup,
  pickHistoryMountWaveTarget,
} from '../../utils/historyMeasuredLayout';
import {
  projectNativeRewindPreview,
  shouldCaptureDelayedCodexRewindPrefix,
  shouldClearRewindPreviewForDurableUser,
  shouldClearRewindPreviewForOwnerTransition,
  type CodexWriterTransitionEvent,
} from '../../utils/historyRewindPreviewOwner';
import {
  buildPromptImagePayload,
  collectPromptImageRefIds,
  getPromptImageMarkerHighlightRanges,
  getPromptImageStatusTokenRanges,
  hasMalformedPromptImageMarker,
  haveSamePromptImageRefs,
  inspectPromptImageAttachments,
  insertPromptImageAttachments,
  normalizePromptImageIdentity,
  remapPromptImageSelectionAfterReplacement,
  retainPromptImageRefsForText,
} from '../../utils/promptImageAttachments.mjs';
import {
  buildComposerClipboardText,
  buildHistoryMessageClipboardPayload,
  buildPortableImageImportSnapshot,
  collapsePortableImageImportSnapshot,
  collectPortableImagePathMarkers,
  normalizeHistoryMessageComposerSnapshot,
} from '../../utils/composerClipboard.mjs';
import {
  electronComposerClipboardAdapter,
  readElectronComposerSnapshotClipboard,
  writeElectronComposerSnapshotClipboard,
} from '../../utils/electronComposerClipboardAdapter';
import { shouldRecordComposerViewEvent } from '../../utils/composerViewState.mjs';
import {
  isComposerKeyboardTarget,
  shouldOpenHistorySearchFromKeydown,
} from '../../utils/composerShortcutRouting.mjs';
import {
  composerImageUrl,
  useComposerImagePreview,
  useComposerImagePreviews,
} from '../../utils/composerImagePreview';
import { applyMarkerAwareWordMotion, type ComposerWordMotionEvent } from '../../utils/composerWordMotion';
import {
  buildPasteChipMarker,
  buildHistoryComposerPresentationParts,
  getPasteMarkerHighlightRanges,
  haveSameComposerChips,
  insertComposerSnapshotAtSelection,
  insertComposerTextAtSelection,
  isPlainTextPasteShortcut,
  normalizeComposerChips,
  promptChipDisplayLabel,
  restoreComposerChipToText,
  retainPasteChipsForText,
  serializeComposerDraft,
  shouldCreatePasteChip,
  isDictationClipboardPayload,
  splitPromptChipPresentation,
  upsertComposerChip,
} from '../../utils/composerChips.mjs';
import {
  interruptedPromptDraftMatchesHandoff,
  mergeFailedHistoryAuthoringSnapshot,
  mergeFailedHistoryAuthoringSnapshots,
  resolveInterruptedPromptOwnership,
} from '../../utils/historyDraftOwnership.mjs';
import {
  getHistoryDraftNoticeMeta,
  historyDraftNoticeBelongsOnComposerBorder,
  isHistoryDeliveryConfirmationNotice,
} from '../../utils/historyDraftNoticeMeta.mjs';
import { buildHistorySendIncidentReport } from '../../utils/historySendIncidentReport.mjs';
import { describeClaudeStartupFailure } from '../../utils/claudeStartupFailure.mjs';
import { resolveHistoryTerminalActivityAction } from '../../utils/historyTerminalActivityAction.mjs';
import {
  mixedMessageNeedsCollapse,
  truncateMixedMessageParts,
} from '../../utils/historyMixedMessageCollapse.mjs';
import {
  createHistoryTailPinScheduler,
  HISTORY_TAIL_MUTATION_MAX_SETTLE_FRAMES,
  HISTORY_TAIL_MUTATION_MIN_SETTLE_FRAMES,
  HISTORY_TAIL_MUTATION_REQUIRED_STABLE_FRAMES,
  HISTORY_TAIL_PIN_THRESHOLD_PX,
  isHistoryTailPinned,
  reconcileHistoryTailFollowIntent,
  scheduleHistoryBottomScroll,
} from '../../utils/historyBottomScroll.mjs';
import { createHistoryScrollSeekController } from '../../utils/historyScrollSeek.mjs';
import {
  chooseHistoryGestureReleaseAnchorMode,
  findHistoryUnitIndexByKey,
  pickHistoryGestureAnchorCandidate,
  settleHistoryVisualAnchor,
} from '../../utils/historyGestureAnchor.mjs';
import { historyForegroundPriority } from '../../utils/historyForegroundPriority.mjs';
import {
  advanceHistoryPresentationProof,
  createHistoryPresentationProof,
  historyPresentationOwnsWrite,
  resolveHistoryViewportPaintProof,
} from '../../utils/historyPresentationOwnership.mjs';
import { flushHistoryDurableWithRetry } from '../../utils/historyDurableFlush.mjs';
import {
  applyHistoryLiveToolResultsToEntry,
  buildHistoryLivePresentation,
  extractHistoryLiveToolResults,
  historyLivePresentationIdentities,
  historyLivePresentationKey,
  reconcileCommittedHistoryLiveProjection,
  reconcileHistoryLiveToolResults,
  reduceHistoryLiveProjection,
  retireHistoryLivePromptByExactProof,
  shouldIncludeHistoryLiveUserText,
} from '../../utils/historyLiveProjection.mjs';
import {
  filterHistoryTerminalPreviewLiveDuplicate,
  historyTerminalPreviewHandoffAction,
  historyTerminalPreviewHandoffAnchor,
  historyTerminalPreviewHandoffOwnsWrite,
  historyTerminalPreviewHandoffScrollTop,
  historyTerminalPreviewHasNewUserGesture,
  historyTerminalPreviewStatusLabel,
  resolveHistoryTerminalPreviewCanonicalTarget,
} from '../../utils/historyTerminalPreviewHandoff.mjs';
import {
  buildHistoryDisplayUnitsAppended,
  buildHistoryDisplayUnitsCached,
  rememberHistoryDisplayUnitsCached,
  findHistoryHydrationStub,
  historyDisplayUnitUuid,
  isGroupUnit,
  peekHistoryDisplayUnitsCached,
  resolveHistoryDisplayTarget,
} from '../../utils/historyDisplayUnits.mjs';
import {
  peekHistoryDisplayUnitsBaseline,
  rememberHistoryDisplayUnitsBaseline,
} from '../../utils/historyDisplayUnitsBaseline.mjs';
import {
  historyContentDistanceFromBottom,
  isHistoryAtContentBottom,
} from '../../utils/historyBottomGeometry.mjs';
import { isHistoryHydrationTargetStub } from '../../utils/historyHydrationTarget.mjs';
import {
  collectHistoryMaterializedWindowUuids,
  historyHydrationCenterForRange,
  retainHistoryMaterializedWindow,
} from '../../utils/historyMaterializedWindow.mjs';
import { stabilizeHistoryRevealAnchor } from '../../utils/historyRevealAnchor.mjs';
import {
  acceptHistoryPromptHandoffProviderQueue,
  adoptHistoryPromptHandoffCanonicalEntry,
  advanceHistoryPromptHandoffTransportPhase,
  beginHistoryPromptHandoff,
  bindHistoryPromptHandoffSendIdentity,
  consumeHistoryPromptHandoff,
  durableHistorySendReceiptMatchesCanonicalEntry,
  getHistoryPromptHandoffsSnapshot,
  HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS,
  HISTORY_PROMPT_SENT_PRESENTATION_MS,
  historyPromptHandoffAuditProofFromSendResult,
  historyPromptHandoffBlocksNewSubmit,
  historyPromptAuditIsProviderQueueReturn,
  historyPromptHandoffInitialStatus,
  historyPromptHandoffStatusPresentation,
  historyPromptHandoffUnconfirmedStatusFromSendResult,
  hydrateHistoryPromptHandoffFromDurableReceipt,
  legacyOrchestrationCompletionMatchesCanonicalEntry,
  reconcileHistoryPromptHandoffRows,
  retractHistoryPromptHandoff,
  selectLatestHistoryPromptInputStatus,
  settleHistoryPromptHandoff,
  subscribeHistoryPromptHandoffs,
  waitForHistoryPromptHandoffSendIdentity,
  type HistoryPromptHandoffStatus,
} from '../../utils/historyPromptHandoffs';
import {
  isStandaloneAgentLocalCommand,
  projectAgentLocalCommandSendResult,
} from '../../utils/agentLocalCommand.mjs';
import {
  historyEntryHasExactIdentity,
  matchesHistoryPromptAdoption,
  matchesHistoryPromptSuppression,
  resolveHistoryPromptHandoffPresentationSession,
} from '../../utils/historyPromptPresentation.mjs';
import { planHistoryPromptPresentationDismissal } from '../../utils/historyPromptPresentationDismissal.mjs';
import {
  historyResponseTailLabel,
  resolveHistoryResponseTailTiming,
} from '../../utils/historyResponseTiming.mjs';
import { queueSendTransferredOwnership } from '../../store/usePromptQueueStore';
import { resolveCenterRightInset } from '../../utils/surfaceInsets.mjs';
import {
  deriveCodexEffectiveSettingsFromHistory,
  planCodexHistorySettingsProjection,
  projectCodexProvisionalSettingsOverlay,
  resolveCodexEffectiveSettings,
} from '../../utils/codexEffectiveSettings.mjs';
import { resolveCodexHistoryRestartSettingsState } from '../../utils/codexHistorySettingsPlan.mjs';
import {
  AGENT_SETTINGS_INTENT_NONE,
  createAgentHistoryRestartSettings,
} from '../../utils/agentSendSettingsContract';
import {
  getCodexHistoryMutationSettingsProof,
  getCodexLaunchOptions,
} from '../../utils/codexLaunch';
import type { AgentLifecycleSummary } from './TerminalArea';
// Shared conversation blocks — same renderer as the SDK tab. The JSONL history
// window draws tool-calls / diff / thinking / markdown through this package;
// nested Task histories meet the same grammar in
// HistoryTranscriptPresentation rather than maintaining inline mini-cards.
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
  CompressIcon as CBCompressIcon,
} from '@noted/claude-blocks';
import {
  AIComposerImageAttachmentPreview,
  AIComposerSurface,
  type AIComposerSurfaceChip,
} from './AIConversation/AIComposerSurface';
import PastedContentPreview from './AIConversation/PastedContentPreview';
import {
  HistoryCollapsedGroupRow,
  HistoryGroupFoot,
  HistoryGroupRail,
  HistoryTranscriptPresentation,
  historyTurnsToTranscriptSteps,
  mergeHistoryTranscriptSteps,
  type HistoryTranscriptStep,
} from './HistoryTranscriptPresentation';

const { ipcRenderer, clipboard } = window.require('electron');
export const HISTORY_SURFACE_PRESENTATION_EVENT = 'history-panel:external-presentation';

const HISTORY_SLASH_COMMANDS = [
  {
    value: '/compact',
    description: 'Compact the current conversation context',
  },
] as const;

const historyDiag = (msg: string) => {
  // main.tsx already forwards every tagged console line to `log:renderer`.
  // Sending the same line explicitly doubled high-frequency History diagnostics.
  console.warn('[HistoryHandoff] ' + msg);
};

const showHistoryIncidentToast = (
  tabId: string,
  cause: unknown,
  incident: Record<string, unknown> = {},
) => {
  const message = (typeof cause === 'string'
    ? cause
    : String((cause as any)?.message ?? cause ?? '')).trim();
  if (!message) return;
  const requestedHeadline = typeof incident.headline === 'string'
    ? incident.headline.trim()
    : '';
  const firstLine = requestedHeadline || (message.split('\n')[0] || message).trim() || message;
  const headline = firstLine.length > 160 ? firstLine.slice(0, 157) + '…' : firstLine;
  const incidentReport = buildHistorySendIncidentReport({
    ...incident,
    error: message,
    tabId,
    occurredAt: Date.now(),
  });
  const incidentPreview = incidentReport.length > 4000
    ? incidentReport.slice(0, 4000) + '\n… full prompt remains available via copy'
    : incidentReport;
  useUIStore.getState().showToast(
    headline,
    'error',
    6000,
    true,
    incidentReport,
    undefined,
    undefined,
    tabId,
    undefined,
    incidentPreview,
  );
};

const historyOwnerDigest = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

// One source for both Virtuoso's physical React key and the positional
// geometry cache. The geometry identity adds only cheap shape facts that can
// change row height while the physical row intentionally stays mounted across
// live→durable adoption.
const historyVirtuosoUnitKey = (unit: any): string => (
  isGroupUnit(unit)
    ? String(unit?.key || '')
    : historyLivePresentationKey(unit?.entry)
);

const historyMeasuredUnitKey = (unit: any): string => {
  if (isGroupUnit(unit)) {
    const members = Array.isArray(unit?.entries) ? unit.entries : [];
    return [
      'group',
      historyVirtuosoUnitKey(unit),
      unit?.expanded === true ? 'open' : 'closed',
      members.length,
      members.at(-1)?.uuid || '',
      unit?.parentGroup?.key || '',
    ].join('|');
  }
  const entry = unit?.entry || {};
  return [
    'entry',
    historyVirtuosoUnitKey(unit),
    typeof entry.content === 'string' ? entry.content.length : 0,
    entry.rowStub ? 'stub' : 'full',
    Array.isArray(entry.promptChips) ? entry.promptChips.length : 0,
    Array.isArray(entry.imagePaths) ? entry.imagePaths.length : 0,
    unit?.expandedGroup?.key || '',
    unit?.expandedSubgroup?.key || '',
  ].join('|');
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
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
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
    // Grouping identity stamped by the parser (shared/history-action-grammar):
    // family read/search/git/run/edit/mcp/plan/web + parsed MCP server·method.
    family?: string;
    bashWord?: string;
    bashDetail?: string;
    mcpServer?: string;
    mcpMethod?: string;
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
  role: 'user' | 'assistant' | 'compact' | 'compact-error' | 'fork' | 'plan-mode' | 'continued' | 'queued' | 'rewind' | 'slash' | 'interrupted' | 'goal';
  timestamp: string;
  content: string;
  queueStatus?: HistoryPromptHandoffStatus;
  deliveryStatus?: 'editable-last-prompt';
  handoffId?: string;
  statusReason?: string;
  statusChangedAt?: number;
  statusAtSend?: AgentPtyStatus;
  rewindStatus?: 'rewinding' | 'done' | 'failed';
  optimisticAt?: number;
  thinking?: string;
  hasThinking?: boolean;
  thinkingRef?: HistoryPayloadRef;
  thinkingSeconds?: number;
  actions?: Action[];
  sessionId: string;
  viewOwnerSessionId?: string;
  physicalSessionId?: string;
  transcriptSegmentId?: string;
  rawUuid?: string;
  contentRevision?: string;
  entryRef?: {
    viewOwnerSessionId: string;
    segmentId: string;
    physicalSessionId: string;
    rawUuid: string;
    sourceIdentity?: string | null;
    contentRevision?: string | null;
  };
  compactSummary?: string;
  compactSummaryRef?: HistoryPayloadRef;
  preTokens?: number;
  postTokens?: number;
  compactEncrypted?: boolean;
  promptChips?: HistoryPromptDraftChip[];
  imagePaths?: HistoryPromptDraftImageRef[];
  requiresAuditIdentity?: boolean;
  auditTimestamp?: string;
  auditHash?: string;
  auditSessionId?: string;
  auditEntryUuid?: string;
  liveProjection?: boolean;
  sourceIdentity?: string;
  sourceIdentityAliases?: string[];
  serviceCarrier?: 'turn-aborted' | 'project-instructions' | 'goal-continuation' | 'compact-error';
  recordByteOffset?: number;
  semanticTags?: Array<{
    id?: string;
    kind: 'orchestration' | 'prompt-origin';
    runId?: string;
    phase?: 'request' | 'completion' | 'failure';
    source?: 'loop';
  }>;
  livePendingThinking?: boolean;
  responseTiming?: {
    intervalId: number;
    startTs: number;
    endTs: number;
    durationMs: number;
  };
  // Grouping identity (display-units projection). Claude: one model response
  // spans several records with one message id — text sharing it with tool
  // calls is a CAPTION, not a standalone reply. Codex: `textPhase` marks
  // commentary (caption) vs final_answer (turn boundary).
  messageId?: string;
  textPhase?: 'commentary' | 'final_answer';
  // Row-window stub metadata (main ships identity + grouping facts only).
  rowStub?: boolean;
  hasContent?: boolean;
  actionSummary?: Array<{
    toolUseId?: string;
    toolName?: string;
    family?: string;
    bashWord?: string;
    mcpServer?: string;
    mcpMethod?: string;
    isError?: boolean;
    description?: string;
    subagentStatus?: 'running' | 'completed' | 'interrupted';
    agentSessionId?: string;
    agentId?: string;
    taskPrompt?: string;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
  }>;
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

interface HistoryResponseTailTiming {
  state: 'running' | 'completed';
  intervalId: number | null;
  startTs: number;
  endTs: number | null;
  durationMs: number | null;
}

interface HistoryResponseActivitySnapshot {
  tabId: string;
  toolType: AgentHistoryTool;
  timing: HistoryActivityTiming | null;
}

interface TerminalHistoryPreview {
  previewId: string;
  tabId: string;
  toolType: 'claude' | 'codex';
  sessionId: string | null;
  turnId: string | null;
  lifecycleGeneration: string;
  mirrorGeneration: string;
  mirrorGenerationOrdinal: number;
  committedFrameGeneration: number | null;
  writeSeq: number | null;
  previewSeq: number;
  phase: 'streaming' | 'settled';
  sourceMode?: 'screen' | 'semantic' | 'semantic-pending';
  text: string;
  textHash: string | null;
  startedAt: number;
  updatedAt: number;
  reason: string | null;
  truncated: boolean;
}

interface TerminalHistoryPreviewClearHandoff {
  previewId: string;
  canonicalIdentity: string;
  canonicalTextHash: string | null;
  ownerKey: string;
  ownerGeneration: number;
  presentationVisit: number;
  anchorOffsetPx: number | null;
  bottomGapPx: number | null;
  gestureGeneration: number;
  gestureAt: number;
  followBottom: boolean;
  scrollOwnerToken: number | null;
  phase: 'waiting-row' | 'clearing-preview' | 'settling-row';
  requestedAt: number;
}

interface HistoryScrollTraceDomSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  topUuid: string | null;
  topPx: number | null;
  topHeight: number | null;
  topShell: boolean;
  topStub: boolean;
  domRows: number;
  shells: number;
  stubs: number;
}

interface HistoryScrollGestureTrace {
  id: number;
  startedAt: number;
  lastInputAt: number;
  lastActivityAt: number;
  baselineScrollTop: number;
  lastScrollTop: number;
  totalDeltaY: number;
  wheelEvents: number;
  scrollEvents: number;
  loggedWheelEvents: number;
  loggedScrollEvents: number;
  motionFrames: number;
  lastMotionFrameAt: number;
  droppedWheelEvents: number;
  droppedScrollEvents: number;
  settleTimer: ReturnType<typeof setTimeout> | null;
  motionRaf: number | null;
  finishRaf: number | null;
  postPaintRaf: number | null;
}

const HISTORY_SCROLL_TRACE_QUIET_MS = 220;
const HISTORY_SCROLL_TRACE_MAX_WHEEL_EVENTS = 20;
const HISTORY_SCROLL_TRACE_MAX_SCROLL_EVENTS = 28;
const HISTORY_SCROLL_TRACE_MAX_MOTION_FRAMES = 18;
const HISTORY_SCROLL_TRACE_MOTION_INTERVAL_MS = 60;
const HISTORY_WHEEL_GEOMETRY_FREEZE_HOLD_MS = 360;
const HISTORY_FOREGROUND_PRIORITY_HOLD_MS = 500;
const HISTORY_TERMINAL_PREVIEW_DOM_PROBE_FRAMES = 6;

// Bounded production diagnostic for the rare “ordinary upward scroll moved
// under me” report. DOM geometry is sampled only at gesture boundaries and on
// a throttled rAF, never synchronously on every wheel/scroll event.
const captureHistoryScrollTraceDomSnapshot = (
  scroller: HTMLElement,
): HistoryScrollTraceDomSnapshot => {
  const scrollerRect = scroller.getBoundingClientRect();
  const rows = scroller.querySelectorAll<HTMLElement>('[data-uuid]');
  let topRow: HTMLElement | null = null;
  let topRect: DOMRect | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= scrollerRect.top) continue;
    topRow = row;
    topRect = rect;
    break;
  }
  return {
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    topUuid: topRow?.getAttribute('data-uuid') || null,
    topPx: topRect ? topRect.top - scrollerRect.top : null,
    topHeight: topRect?.height ?? null,
    topShell: topRow?.hasAttribute('data-history-mount-shell') === true,
    topStub: topRow?.hasAttribute('data-history-row-stub') === true,
    domRows: rows.length,
    shells: scroller.querySelectorAll('[data-history-mount-shell]').length,
    stubs: scroller.querySelectorAll('[data-history-row-stub]').length,
  };
};

interface HistoryVirtuosoContext {
  terminalPreview: TerminalHistoryPreview | null;
  terminalPreviewCanonicalMaterialized: boolean;
  // One response-level clock at the physical transcript tail. It is not a
  // display unit: second ticks stay inside the Footer and cannot rebuild
  // grouping, hydration or Virtuoso item geometry.
  responseTiming: HistoryResponseTailTiming | null;
  // Scroll-seek replaces the normal Virtuoso item wrapper. Preserve the same
  // physical display-unit identity on its placeholder so exit can hand the
  // exact viewport coordinate back to the exact real row.
  seekUnitKeyAt: (index: number) => string;
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
  message?: string | null;
  completionProof?: string | null;
  sourceByteOffset?: number | null;
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

export interface HistoryInitialSourceSignal {
  tabId: string;
  sessionId: string | null;
  ownerKey: string;
  generation: number;
  phase: 'load' | 'subscribe';
  status: 'success' | 'cached' | 'failure';
}

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
  // Height of the docked input this panel must stop above, in px.
  //
  // The side panel is docked to the right edge of the CENTER box, and in
  // terminal-primary that box also carries the docked composer at its bottom.
  // The mirrored side terminal already stops there (FloatingTerminalFrame
  // bottomInset); this panel used to run to the very bottom instead, so it
  // covered the input by exactly the input's height — measured live: side
  // terminal bottom 714 = input top 714 (flush), side transcript bottom 859 vs
  // input top 714, i.e. 145px of overlap, the full height of the composer.
  // Same number, same source (the measured controls height), so the two side
  // panels cannot disagree.
  bottomInset?: number;
  // The pane is stacked in a column, so it is short: the composer starts at ONE
  // row and grows to the stacked ceiling from Settings (default 3) instead of
  // the full-height one. A tall empty input inside a half-height pane leaves
  // almost no room for the conversation it belongs to.
  compactComposer?: boolean;
  onSwapPrimarySurface?: () => void;
  terminalIsPrimary?: boolean;
  projectId?: string;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  lifecycleStatus?: AgentLifecycleSummary | null;
  inputBusy?: boolean;
  onControlsHeightChange?: (height: number) => void;
  // Deferred owner handoff: the workspace already highlights the NEXT tab
  // while this panel still renders the PREVIOUS owner's rows (frozen instance,
  // see Workspace's historyStaleCurtain). During those frames the transcript
  // on screen belongs to a tab that is no longer selected — cover the content
  // stage with the panel's own loader so the surface never claims the wrong
  // owner. Content is hidden, not unmounted: the frozen rows are what makes
  // the handoff cheap.
  staleOwnerCurtain?: boolean;
  // Mounted is not presented. Persistent split/space panes stay alive under
  // `visibility:hidden + inert`; background layout there may keep measuring,
  // but it must never claim a new user reading position. The parent owns this
  // proof because it alone knows which pane is actually on screen.
  presented?: boolean;
  // A persistently mounted pane retained the exact same rectangle/header/
  // composer geometry while hidden. In that case show/hide is presentation
  // ownership only: re-running multi-frame scroll convergence would measure
  // the position we already have and block the switch for no user-visible
  // change. A real geometry change keeps the legacy restore path.
  preservePresentationGeometry?: boolean;
  // Persistent pane wrappers can publish presentation ownership out-of-band.
  // This keeps the heavy memoized History tree's React props stable while the
  // outer space layer changes only visibility/inert.
  presentationExternallyManaged?: boolean;
  presentationChannel?: string;
  // Completion proof for background pane admission. This reports the raw
  // initial source load and watcher subscription; visibleSurfaceLoading is a
  // presentation-only value and is deliberately not used as completion.
  onInitialSourceSignal?: (signal: HistoryInitialSourceSignal) => void;
  // Split workspace: several REAL History instances are mounted (one per
  // pane), but window-level keyboard shortcuts (Escape-interrupt, Cmd+F) must
  // have exactly ONE owner — the focused pane. Non-focused panes stay fully
  // interactive through direct clicks/typing; only their global listeners are
  // parked. Composer availability is also withheld so grab/dictation resolve
  // to the focused pane's composer.
  suppressGlobalHotkeys?: boolean;
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
  recordByteOffset?: number;
}

interface DurablePromptIdentity {
  requiresAuditIdentity?: boolean;
  auditTimestamp?: string;
  auditHash?: string;
  auditSessionId?: string;
  auditEntryUuid?: string;
  sourceIdentity?: string;
  recordByteOffset?: number;
  sessionId?: string;
}

interface MidstreamPromptRecovery {
  serializedText: string;
  transportText: string;
  rawText: string;
  chips: HistoryPromptDraftChip[];
  images: HistoryPromptDraftImageRef[];
  at: number;
  submittedAt: number;
  handoffId: string;
  statusAtSend: AgentPtyStatus;
  durableIdentity: DurablePromptIdentity;
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
const LOCAL_COMPACT_ERROR_PREFIX = 'local-compact-error-';
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
const HISTORY_PENDING_DELIVERY_BLOCK_NOTICE =
  'Previous message is still being delivered. Wait for SENT or an error before sending another.';
const HISTORY_USER_TEXT_COLLAPSE_THRESHOLD = 600;
const HISTORY_USER_TEXT_COLLAPSED_CHARS = 400;

const HistoryResponseTailTimer = memo(({ timing, placement = 'tail' }: {
  timing: HistoryResponseTailTiming;
  placement?: 'tail' | 'entry';
}) => {
  // The one-second clock is deliberately local to the running tail instance.
  // Completed entry instances never tick. Keeping the clock out of
  // HistoryPanel means a tick changes one text node, not the transcript
  // projection and every visible virtual row.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (timing.state !== 'running') return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timing.intervalId, timing.startTs, timing.state]);
  const label = historyResponseTailLabel(timing, clock);
  return (
    <div
      data-history-tail-response-timer
      data-state={timing.state}
      data-placement={placement}
      aria-label={label || undefined}
      title={timing.state === 'running'
        ? 'Общее время текущего ответа'
        : placement === 'entry'
          ? 'Общее время этого завершённого ответа'
          : 'Общее время завершённого ответа'}
      className="hp-history-response-tail"
    >
      <span className="hp-history-response-tail-label">{label}</span>
    </div>
  );
});

const openTerminalHistoryPreviewContextMenu = (
  event: React.MouseEvent<HTMLDivElement>,
  preview: TerminalHistoryPreview,
) => {
  event.preventDefault();
  event.stopPropagation();
  const selection = window.getSelection();
  const selectionInside = !!selection
    && !selection.isCollapsed
    && (
      (!!selection.anchorNode && event.currentTarget.contains(selection.anchorNode))
      || (!!selection.focusNode && event.currentTarget.contains(selection.focusNode))
    );
  ipcRenderer.send('show-terminal-history-preview-context-menu', {
    tabId: preview.tabId,
    toolType: preview.toolType,
    preview,
    selectionText: selectionInside ? selection?.toString() || '' : '',
  });
};

const HistoryTerminalPreviewFooter = memo(({ context }: {
  context?: HistoryVirtuosoContext;
}) => {
  const preview = context?.terminalPreview || null;
  const canonicalMaterialized = context?.terminalPreviewCanonicalMaterialized === true;
  return (
    <>
      {preview && (
        <ConversationMessage
          layout="assistant"
          tone="accent"
          data-history-terminal-preview
          data-preview-id={preview.previewId}
          data-preview-phase={preview.phase}
          aria-live="polite"
          onContextMenu={(event) => openTerminalHistoryPreviewContextMenu(event, preview)}
          status={(
            <MessageStatusBadge
              label={historyTerminalPreviewStatusLabel({ canonicalMaterialized })}
              tone="accent"
              pending={preview.phase === 'streaming'}
              meta={preview.truncated ? 'начало скрыто' : undefined}
              style={{
                position: 'absolute',
                top: 0,
                left: 14,
                zIndex: 2,
                maxWidth: 'calc(100% - 28px)',
                margin: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                transform: 'translateY(-50%)',
              }}
            />
          )}
          style={{
            background: 'rgba(124, 58, 237, 0.045)',
            boxShadow: 'inset 2px 0 0 rgba(167, 139, 250, 0.42)',
          }}
        >
          <div style={{ fontSize: '1em' }}>
            <CBMarkdown text={preview.text} />
          </div>
        </ConversationMessage>
      )}
      {context?.responseTiming && (
        <HistoryResponseTailTimer timing={context.responseTiming} />
      )}
    </>
  );
});

// Cheap stand-in row rendered while the user is scrubbing the scrollbar or
// flinging the wheel faster than real rows can mount. Fast scrolling through
// heavy markdown/diff cards mounted and threw away dozens of full rows per
// frame — the exact jank scrollSeek exists to remove. The placeholder is a
// single flat div at the row's measured height, so total list height (and the
// thumb position under the cursor) does not move when it swaps in.
const HistoryScrollSeekPlaceholder = memo(({ height, index, context }: {
  height: number;
  index: number;
  context?: HistoryVirtuosoContext;
}) => (
  <div
    data-history-seek-placeholder
    data-history-seek-index={index}
    data-history-seek-key={context?.seekUnitKeyAt(index) || undefined}
    aria-hidden="true"
    style={{
      height,
      boxSizing: 'border-box',
      padding: '8px 16px',
      display: 'flex',
      alignItems: 'flex-start',
      pointerEvents: 'none',
    }}
  >
    <div
      style={{
        width: index % 3 === 0 ? '42%' : index % 3 === 1 ? '68%' : '55%',
        height: 10,
        maxHeight: '100%',
        borderRadius: 4,
        background: 'rgba(129, 140, 248, 0.10)',
      }}
    />
  </div>
));

// Mount-wave shell body. The OUTER wrapper (data-uuid, row-owner,
// onContextMenu, chain-break tint) is the real one — only the heavy card
// inside is deferred, so a right-click during the wave opens the same context
// menu with the same entry. Visually a faint bar, like the seek placeholder
// but dimmer: this state lasts a few frames per row.
const HistoryMountShellBody = memo(({ index }: { index: number }) => (
  <div
    aria-hidden="true"
    style={{
      display: 'flex',
      alignItems: 'flex-start',
      padding: '4px 16px 0',
      pointerEvents: 'none',
      height: '100%',
      boxSizing: 'border-box',
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        width: index % 3 === 0 ? '38%' : index % 3 === 1 ? '61%' : '49%',
        height: 10,
        maxHeight: '100%',
        borderRadius: 4,
        background: 'rgba(129, 140, 248, 0.07)',
      }}
    />
  </div>
));

const normalizeHistoryPromptText = (text: string) => String(text || '')
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/\[200~/g, '').replace(/~\]/g, '').trim();

const normalizeHistoryPromptIdentityText = (text: string) =>
  normalizePromptImageIdentity(normalizeHistoryPromptText(text));

const promptPreview = (text: string, max = 80) =>
  normalizeHistoryPromptText(text).replace(/\s+/g, ' ').slice(0, max);

const HISTORY_IMAGE_PENDING_MARKER = '[Image saving…]';

type HistoryComposerAggregate = {
  images: HistoryPromptDraftImageRef[];
  chips: HistoryPromptDraftChip[];
};

const historyComposerAggregateEqual = (left: unknown, right: unknown) => {
  const a = left as HistoryComposerAggregate | null;
  const b = right as HistoryComposerAggregate | null;
  if (!a || !b) return a === b;
  return JSON.stringify(a.images) === JSON.stringify(b.images)
    && haveSameComposerChips(a.chips, b.chips);
};

const retainHistoryDraftImages = (
  text: string,
  images?: HistoryPromptDraftImageRef[]
): HistoryPromptDraftImageRef[] => {
  return retainPromptImageRefsForText(text, images || []) as HistoryPromptDraftImageRef[];
};

type HistoryDraftImageNotice = {
  message: string;
  blocking: boolean;
  progress: boolean;
};

const historyDraftImageNotice = (
  text: string,
  images?: HistoryPromptDraftImageRef[]
): HistoryDraftImageNotice | null => {
  if (String(text || '').includes(HISTORY_IMAGE_PENDING_MARKER)) {
    return {
      message: 'Saving image attachment…',
      blocking: true,
      progress: true,
    };
  }
  const inspection = inspectPromptImageAttachments(text, images || []);
  if (inspection.firstBlocking) {
    const issue = inspection.firstBlocking as {
      id?: number | null;
      marker?: string;
      excerpt?: string;
    };
    const marker = issue.id ? `[Image #${issue.id}]` : (issue.marker || '[Image marker]');
    return {
      message: `${marker} is damaged or has no exact attachment. Near “${issue.excerpt || marker}”. Restore the complete marker or remove it before sending.`,
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
      message: `${marker} is unavailable.${pathPart} Send remains available; this slot will be sent as an explicit imageError. Near “${issue.excerpt || marker}”.`,
      blocking: false,
      progress: false,
    };
  }
  return null;
};

const historyDraftImagePreflightKey = (
  tabId: string,
  text: string,
  images: HistoryPromptDraftImageRef[],
) => {
  const ids = Array.from(collectPromptImageRefIds(text)).sort((a, b) => a - b);
  if (ids.length === 0 || images.length === 0) return '';
  const refs = images
    .filter((ref) => ids.includes(Number(ref.id)))
    .map((ref) => [
      Number(ref.id),
      String(ref.assetId || ''),
      String(ref.path || ''),
      String(ref.availability || ''),
      String(ref.error || ''),
    ])
    .sort((left, right) => Number(left[0]) - Number(right[0]));
  return `${tabId}\u0000${ids.join(',')}\u0000${JSON.stringify(refs)}`;
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
    sourceIdentityAliases: entry.sourceIdentityAliases,
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

const isLocalCompactErrorEntry = (entry: FullHistoryEntry) =>
  entry.role === 'compact-error' && entry.uuid.startsWith(LOCAL_COMPACT_ERROR_PREFIX);

const findServerPromptEntry = (
  serverEntries: FullHistoryEntry[],
  localEntry: FullHistoryEntry,
  excludedUuids: Set<string> = new Set(),
) => {
  const normalized = normalizeHistoryPromptIdentityText(localEntry.content);
  const localAt = localEntry.optimisticAt || Date.parse(localEntry.timestamp) || Date.now();
  return serverEntries.find((entry) => {
    if (excludedUuids.has(entry.uuid)) return false;
    // Old orchestration completion rows can outlive the renderer-local handoff
    // that created them. Their app-owned run tag is the only durable identity
    // available after such a restart; never fall back to equal text or time.
    if (legacyOrchestrationCompletionMatchesCanonicalEntry({
      handoffId: localEntry.handoffId || '',
      source: '',
      queueStatus: localEntry.queueStatus || 'sending',
      sendOperationKey: null,
      sendAttemptId: null,
    }, entry)) {
      return true;
    }
    if (localEntry.auditEntryUuid) {
      return historyEntryHasExactIdentity(entry, localEntry.auditEntryUuid);
    }
    const durableIdentity = {
      role: entry.role,
      normalizedText: normalizeHistoryPromptIdentityText(entry.content),
      timestamp: entry.timestamp,
      sessionId: entry.sessionId,
      sourceIdentity: entry.sourceIdentity,
      sourceIdentityAliases: entry.sourceIdentityAliases,
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
  const imagePathsByServerUuid = new Map<string, HistoryPromptDraftImageRef[]>();
  const locals: FullHistoryEntry[] = [];
  for (const entry of currentEntries) {
    if (isLocalCompactErrorEntry(entry)) {
      locals.push(entry);
      continue;
    }
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
      if ((entry.imagePaths?.length || 0) > 0 && !(matched.imagePaths?.length || 0)) {
        imagePathsByServerUuid.set(matched.uuid, entry.imagePaths || []);
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
  const decoratedServerEntries = promptChipsByServerUuid.size > 0 || imagePathsByServerUuid.size > 0
    ? serverEntries.map((entry) => {
        const chips = promptChipsByServerUuid.get(entry.uuid);
        const imagePaths = imagePathsByServerUuid.get(entry.uuid);
        return chips || imagePaths
          ? {
              ...entry,
              ...(chips ? { promptChips: chips } : {}),
              ...(imagePaths ? { imagePaths } : {}),
            }
          : entry;
      })
    : serverEntries;
  // Confirmed local rows already carry the exact transcript position. Feed
  // them through the same ordered projection used by live rows instead of
  // appending them after a newer durable answer.
  return locals.length > 0
    ? buildHistoryLivePresentation(decoratedServerEntries, locals) as FullHistoryEntry[]
    : decoratedServerEntries;
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
      left.subagentStatus === right.subagentStatus &&
      left.agentSessionId === right.agentSessionId &&
      left.agentId === right.agentId &&
      left.processGeneration === right.processGeneration &&
      left.startedAt === right.startedAt &&
      left.completedAt === right.completedAt &&
      left.durationMs === right.durationMs &&
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

const historySourceIdentityAliasesEqual = (
  left: string[] | undefined,
  right: string[] | undefined,
) => {
  const leftAliases = left || [];
  const rightAliases = right || [];
  return leftAliases.length === rightAliases.length
    && leftAliases.every((alias, index) => alias === rightAliases[index]);
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
    !historySourceIdentityAliasesEqual(left.sourceIdentityAliases, right.sourceIdentityAliases) ||
    left.recordByteOffset !== right.recordByteOffset ||
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
    left.postTokens !== right.postTokens ||
    left.compactEncrypted !== right.compactEncrypted ||
    !haveSameComposerChips(left.promptChips || [], right.promptChips || []) ||
    !haveSamePromptImageRefs(left.imagePaths || [], right.imagePaths || [])
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

// Delta transport reassembly (main's history-delta.js is the other half).
// The response names the full row order plus only the rows that changed;
// every other row is REQUIRED to already sit in the previous raw snapshot.
// Unchanged rows therefore keep their exact old object references — the
// memoized cards' props never change identity, and the downstream
// retainStable pass short-circuits on `left === right` instead of deep-
// comparing 15K rows. A uuid the baseline cannot supply means the digest
// described rows this renderer never applied — return null and let the
// caller fall back to a full load.
const reassembleHistoryDeltaEntries = (
  baseline: FullHistoryEntry[],
  order: string[],
  changedEntries: FullHistoryEntry[],
): FullHistoryEntry[] | null => {
  const changedByUuid = new Map(changedEntries.map((entry) => [entry.uuid, entry]));
  const baselineByUuid = new Map(baseline.map((entry) => [entry.uuid, entry]));
  const next: FullHistoryEntry[] = new Array(order.length);
  for (let index = 0; index < order.length; index++) {
    const uuid = order[index];
    const entry = changedByUuid.get(uuid) || baselineByUuid.get(uuid);
    if (!entry) return null;
    next[index] = entry;
  }
  return next;
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
  if (!preview) return { entries: rawEntries, hiddenCount: 0, hiddenTurnCount: 0 };
  return projectNativeRewindPreview(
    rawEntries,
    preview.targetUuid,
    (entry) => shouldCarryAfterRewindTarget(entry, preview),
    (entry) => entry.role === 'user' && !isLocalPromptEntry(entry),
  );
};

const serverHistoryMaterializedRewindBranch = (serverEntries: FullHistoryEntry[], preview: HistoryRewindPreview) => {
  // The old source future may legitimately remain in a stable-source rollout
  // after an upstream branch rejection. It no longer owns the preview once a
  // newer exact user carrier is durable; keeping the preview would hide that
  // real row and make Timeline clicks miss its UUID in visible History.
  return serverEntries.some((entry) => shouldClearRewindPreviewForDurableUser(
    preview,
    {
      uuid: entry.uuid,
      role: entry.role,
      timestamp: entry.timestamp,
      sessionId: entry.sessionId,
    },
  ));
};

// Thinking + markdown render via @noted/claude-blocks (CBThinkBlock /
// CBMarkdown). Task owns only its lifecycle/result shell here; its nested
// transcript renders through HistoryTranscriptPresentation below.

// Same path voice as raw tool cards/groups: basename normally, docs/... for
// documentation. Legacy FileAction rows must not resurrect their old .../a/b
// format beside the canonical renderer.
const shortPath = (path: string) => historyDisplayPath(path);

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
 * THE stationary-click law («это прям база», 16.08): the row the user clicked
 * does not move — in EITHER direction.
 *
 * Expand: the body opens DOWNWARD below the header; the header stays exactly
 * where it was. The list grew below the click point, so the thumb shortens
 * and content below shifts down — the natural consequence, never
 * compensated. No auto-scroll «to show the revealed content» (earlier
 * iterations pulled the list up and the header «уходит вверх» — rejected),
 * and no tail-follow either: expanding while pinned to the streaming tail
 * previously let followOutput treat the grown list as new content and jump
 * to the new bottom — the exact «нажимаю, и строчка уходит вверх» report.
 * Expanding IS leaving the bottom, so the pin turns off first.
 *
 * Collapse: height above the click point is unchanged, so normally nothing
 * moves either. Near the BOTTOM the browser may clamp scrollTop after the
 * content shrinks. That native clamp is now intentional: History no longer
 * manufactures empty footer space to preserve an otherwise impossible pixel
 * position. A collapse from a rail/foot still lands on the group's header by
 * identity; ordinary card/header collapses accept the browser's final range.
 *
 * Both directions work per-scroller (several History panels can be mounted
 * at once — column mode): the panel registers its scroller's operations
 * here, and the shared toggle helper looks them up by the scroller it found.
 */
interface HistoryRevealScrollerOps {
  /** Turn off tail-following (the user is now reading, not following). */
  unpinTail(): void;
}
const historyRevealOpsByScroller = new WeakMap<HTMLElement, HistoryRevealScrollerOps>();

function applyHistoryRevealUpdate(
  anchor: HTMLElement | null,
  opening: boolean,
  update: () => void,
) {
  const scroller = findHistoryScrollParent(anchor);
  if (!scroller) {
    flushSync(update);
    return;
  }
  const ops = historyRevealOpsByScroller.get(scroller) || null;
  // Toggling a row is READING, both directions — turn tail-following off
  // BEFORE the list changes size. A stale follow intent (pinned earlier,
  // then the list grew without a scroll event) otherwise fires on the very
  // resize this toggle causes and jumps to the new bottom, moving the
  // clicked row (measured live 16.08: collapse at dist=836 → +246px jump).
  ops?.unpinTail();
  if (opening) {
    flushSync(update);
    return;
  }
  flushSync(update);
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
const formatSubagentDuration = (durationMs: number) => {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? minutes + 'm' : minutes + 'm ' + rest + 's';
};

const historyAgentKey = (action: TaskAction, entryUuid: string) => (
  'task:' + (action.toolUseId || action.agentSessionId || action.agentId || entryUuid)
);

interface HistoryAgentInspectorController {
  selectedKey: string | null;
  openAgent: (agentKey: string) => void;
}

const HistoryAgentInspectorContext = React.createContext<HistoryAgentInspectorController>({
  selectedKey: null,
  openAgent: () => {},
});

// A Task row is an address into the single docked Agent Inspector. Its own
// transcript never expands inside the virtualized History list: that created
// a scrollable History inside another scrollable History and made wheel/anchor
// ownership ambiguous.
const SubAgentBlock = memo(({
  action,
  entryUuid,
  live,
}: {
  action: TaskAction;
  entryUuid: string;
  live: boolean;
}) => {
  const inspector = React.useContext(HistoryAgentInspectorContext);
  // Codex subagent live status: the loader is INHERITED by the card while the
  // in-process agent works; interrupted is amber, not an error red.
  // `subagentStatus` is durable transcript history, not a live lease. A
  // completed child can have an old `running` card in a cached/replayed row;
  // only the main-owned exact call-id snapshot may animate it now.
  const subagentRunning = live;
  const subagentInterrupted = action.subagentStatus === 'interrupted'
    || (!live
      && action.subagentStatus !== 'completed'
      && action.result == null
      && !(Number(action.completedAt) > 0));
  const description = String(action.description || 'Task agent')
    .replace(/\s+·\s+running\s*$/i, '');
  const durationMs = Number(action.durationMs) > 0
    ? Number(action.durationMs)
    : Number(action.completedAt) > 0 && Number(action.startedAt) > 0
      ? Math.max(0, Number(action.completedAt) - Number(action.startedAt))
      : 0;
  const agentKey = historyAgentKey(action, entryUuid);
  const selected = inspector.selectedKey === agentKey;
  const rowColor = subagentInterrupted ? '#d97706' : live ? '#d97706' : '#818cf8';

  return (
    <div
      data-history-agent-card={agentKey}
      style={{ marginTop: 4, borderLeft: '3px solid ' + rowColor, paddingLeft: 8 }}
    >
      <button
        type="button"
        onClick={() => inspector.openAgent(agentKey)}
        className="group"
        aria-expanded={selected}
        style={{
          width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6,
          padding: '2px 4px 2px 0', border: 'none', borderRadius: 4,
          background: selected ? 'rgba(129, 140, 248, 0.08)' : 'transparent',
          color: rowColor, cursor: 'pointer', fontSize: '0.85em', textAlign: 'left',
        }}
        title="Открыть агента"
      >
        {subagentRunning && (
          <Loader2 size={11} strokeWidth={2.5} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
        )}
        {!subagentRunning && <Bot size={11} style={{ flexShrink: 0 }} />}
        <span className="truncate" style={{ minWidth: 0, flex: 1 }}>{description}</span>
        {!subagentRunning && durationMs > 0 && (
          <span style={{ color: '#777', fontVariantNumeric: 'tabular-nums' }}>
            {formatSubagentDuration(durationMs)}
          </span>
        )}
        {selected
          ? <ChevronDown size={11} style={{ color: '#777', flexShrink: 0 }} />
          : <ChevronRight size={11} className="opacity-0 group-hover:opacity-100" style={{ color: '#777', flexShrink: 0 }} />}
      </button>
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
  const tokensLabel = entry.postTokens
    ? `${entry.postTokens >= 1000 ? Math.round(entry.postTokens / 1000) + 'k' : entry.postTokens} tokens`
    : null;
  const encryptedLabel = !tokensLabel && entry.compactEncrypted ? ' (encrypted)' : '';

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
    // Compact marker, minimal form (user decision): a thin left-aligned
    // service line — icon-weight, not a full-width banner. The Codex compact
    // body holds only copied user prompts, so it earns no card; the summary
    // opens on click, left-aligned, not centered.
    <div ref={anchorRef} style={{ padding: '2px 12px' }}>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          // Same -4/+4 margin/padding pair as .cb-tool-head, so the glyph
          // lands exactly on the shared icon column (12px rail).
          display: 'inline-flex', alignItems: 'center',
          gap: 8, cursor: hasSummary ? 'pointer' : 'default',
          minHeight: 22, padding: 4, margin: '0 -4px', borderRadius: 4,
          userSelect: 'none',
          background: hovered && hasSummary ? 'rgba(255, 255, 255, 0.03)' : undefined,
        }}
        onClick={hasSummary ? toggleOpen : undefined}
      >
        {/* Same voice as every other feed row: a REAL identity glyph in the
            shared icon column (compress arrows, amber = compaction), words in
            the ordinary 0.9em UI type, and the disclosure chevron TRAILING on
            hover exactly like every collapsible row — the chevron is a
            control, not the row's face. */}
        <CBCompressIcon
          size={14}
          strokeWidth={2.75}
          style={{ color: '#b58a3e', flexShrink: 0 }}
        />
        <span style={{ color: '#b8b6b1', fontSize: '0.9em', flexShrink: 0 }}>
          context compacted{tokensLabel ? ` · ${tokensLabel}` : encryptedLabel}
        </span>
        {hasSummary && (
          <ChevronRight
            size={11}
            style={{
              color: '#6f6d68', flexShrink: 0,
              opacity: visible || hovered ? 1 : 0,
              transform: visible ? 'rotate(90deg)' : undefined,
              transition: 'opacity 0.12s, transform 0.12s',
            }}
          />
        )}
      </div>
      {visible && entry.compactSummary && (
        <div style={{
          margin: '4px 12px 0 34px', padding: '6px 10px',
          borderLeft: '2px solid rgba(181, 138, 62, 0.35)',
          fontSize: '0.88em', color: '#999',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: 300, overflowY: 'auto',
        }}>
          {presentedSummary || entry.compactSummary}
        </div>
      )}
    </div>
  );
});

/** «2m 40s» / «22s» — duration of one expanded thinking row only. */
const formatThinkingDuration = (seconds: number): string => {
  if (!(seconds > 0)) return '';
  if (seconds < 60) return seconds + 's';
  const rest = seconds % 60;
  return Math.floor(seconds / 60) + 'm' + (rest ? ' ' + rest + 's' : '');
};

/**
 * Copy of a row whose payload may be DEHYDRATED (main ships a preview plus a
 * ref for anything large).
 *
 * Copying the preview would hand over a truncated payload with no sign that
 * it was cut — the one outcome a copy button must never produce. So a press
 * on a not-yet-loaded row asks for the payload and copies it the moment it
 * arrives, using the same lazy loader (and cache) that expanding uses. Rows
 * whose text is already whole copy synchronously, as before.
 */
const useRehydratedCopy = (
  preview: string | undefined,
  ref: HistoryPayloadRef | undefined,
  presented: string | undefined,
  requestPayload: (wanted: boolean) => void,
) => {
  const pendingRef = useRef(false);
  const isWhole = !ref || (presented != null && presented !== preview);
  // The deferred press completes in an EFFECT, never during render: writing
  // to the clipboard is a side effect, and React may render a component more
  // than once per commit.
  useEffect(() => {
    if (!pendingRef.current || !isWhole) return;
    pendingRef.current = false;
    const text = presented || preview || '';
    if (text) clipboard.writeText(text);
  }, [isWhole, presented, preview]);
  return (value: string) => {
    if (isWhole) {
      const text = value || presented || preview || '';
      if (text) clipboard.writeText(text);
      return;
    }
    pendingRef.current = true;
    requestPayload(true);
  };
};

const HistoryThinkBlock = memo(({ text, payloadRef, seconds }: {
  text: string;
  payloadRef?: HistoryPayloadRef;
  seconds?: number;
}) => {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const onToggle = useHistoryRevealToggle(anchorRef, open, setOpen);
  // Two readers of one payload: expanding shows it, copy hands it over. The
  // copy hook only says whether it still needs the full text; the fetch stays
  // a single call so both paths share one request and one cache entry.
  const [copyWanted, setCopyWanted] = useState(false);
  const { text: presented } = useRehydratedPayload(text, payloadRef, open || copyWanted);
  const copy = useRehydratedCopy(text, payloadRef, presented, setCopyWanted);
  // «thinking · 2m 40s» — duration derived from record timestamps (parser).
  const duration = formatThinkingDuration(Number(seconds) || 0);
  const label = duration ? 'thinking · ' + duration : 'thinking';
  return (
    <CBThinkBlock
      text={presented || text}
      label={label}
      open={open}
      onToggle={onToggle}
      anchorRef={anchorRef}
      onCopy={copy}
    />
  );
});

// Session-scoped fetch context for dehydrated payloads. Card components sit
// several layers below the panel; the context avoids threading
// toolType/sessionId/cwd through every action render.
const HistoryPayloadContext = React.createContext<{
  tabId: string;
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
  family,
  bashWord,
  bashDetail,
  mcpServer,
  mcpMethod,
  docsKind,
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
  // Parser-stamped grouping identity (see history-action-grammar.cjs):
  // refines the icon/verb (reading Bash → Read, git → Git) and turns raw
  // `mcp__server__method` labels into `server · method`.
  family?: string;
  bashWord?: string;
  bashDetail?: string;
  mcpServer?: string;
  mcpMethod?: string;
  docsKind?: string;
}) => {
  const anchorRef = useRef<HTMLDivElement>(null);
  // Every card starts collapsed — including Edit/Write/MultiEdit, which used
  // to be the ONLY default-open type. Open diff bodies meant DiffView rows
  // (125-221 per card on tab-3163, 06.08) were created inside scroll/mount
  // commits — 76-238ms tasks during ordinary in-viewport scroll;
  // `content-visibility` on the rows skips layout/paint but not React work
  // or DOM creation. Collapsed, the header still carries the verb, the path
  // and the ±line counts; the hunks enter the DOM only on explicit expand,
  // exactly like Bash/Read output. Collapsed height is one stable header
  // line, which also keeps measured-geometry snapshots honest.
  const [localOpen, setLocalOpen] = useState(false);
  const onToggle = useHistoryRevealToggle(anchorRef, localOpen, setLocalOpen);
  const open = localOpen;
  // The full output is fetched when the card is expanded; the preview renders
  // in the collapsed header either way. Copy is the SECOND reader of the same
  // payload — pressing it on a collapsed card must not hand over a preview.
  const [copyWanted, setCopyWanted] = useState(false);
  const { text: presentedResult, pending, failed } = useRehydratedPayload(result, resultRef, open || copyWanted);
  const copyResult = useRehydratedCopy(result, resultRef, presentedResult, setCopyWanted);

  return (
    <div
      className="hp-tool-scroll-scope"
      data-history-tool-name={toolName}
      data-history-docs-kind={docsKind || undefined}
    >
      <CBToolCallPart
        toolName={toolName}
        args={args}
        result={presentedResult}
        isError={isError}
        diffHunks={diffHunks}
        family={family}
        // The row label must say WHAT was touched, not the literal command
        // that touched it. Computed here (the package stays portable and
        // cannot import app-side modules) with the same grammar the parsers
        // and the grouping projection use.
        headline={historyActionHeadline({ toolName, args, family, bashWord, bashDetail, mcpServer, mcpMethod })}
        mcpServer={mcpServer}
        mcpMethod={mcpMethod}
        collapse={{ open, onToggle, anchorRef }}
        // Electron clipboard, never navigator.clipboard in a renderer — the
        // latter silently fails without HTTPS/permissions (project rule).
        // Routed through the rehydration-aware copy so a dehydrated result is
        // fetched first instead of copying its preview.
        onCopy={copyResult}
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
// Card content comes from durable/live History rows; liveness comes from the
// same main-owned exact active-call snapshot as the tab loader.
interface HistoryBackgroundChip {
  key: string;
  kind: 'bash' | 'subagent';
  label: string;
  entryUuid: string;
  startedAt: number;
  status?: 'running' | 'completed' | 'interrupted';
  completedAt?: number;
  durationMs?: number;
  // Detail-pane payload (workflow-style expansion above the bar).
  taskHistory?: Array<{ type: string; content?: string; tools?: string[] }>;
  taskResult?: string;
  agentSessionId?: string;
  agentId?: string;
  taskPrompt?: string;
  bashAcceptance?: string;
}

type HistoryAgentChip = HistoryBackgroundChip & {
  kind: 'subagent';
  status: 'running' | 'completed' | 'interrupted';
};

const EMPTY_HISTORY_AGENTS: HistoryAgentChip[] = [];

interface HistoryBackgroundAgentProof {
  provider: 'claude' | 'codex';
  toolUseId: string;
  agentId?: string;
  agentSessionId?: string;
  sessionId?: string | null;
  generation?: string | null;
  startedAt?: number;
}

interface HistoryBackgroundWorkSnapshot {
  tabId: string;
  revision: number;
  agents: HistoryBackgroundAgentProof[];
}

const historySubagentCallIdentity = (value: string | undefined) => (
  String(value || '').replace(/:canonical:\d+$/, '')
);

// One parsed step of a subagent's own transcript (main-side reader).
type SubagentStep = HistoryTranscriptStep;

const collectHistoryBackgroundChips = (
  entries: FullHistoryEntry[],
  isTurnBusy: boolean,
  agentProcessAlive: boolean,
  currentSessionId: string,
  currentProcessGeneration: string | null,
  chipToolType: string = 'claude',
  exactActiveSubagents: ReadonlyMap<string, HistoryBackgroundAgentProof> | null = null,
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
          status: 'running',
          bashAcceptance: action.rawTool.result,
        });
        continue;
      }
      if (!isTaskAction(action)) continue;
      // Explicit rollout status (Codex) is process-scoped truth; a Claude
      // Task without one is turn-scoped and needs the busy gate.
      const callIdentity = historySubagentCallIdentity(action.toolUseId);
      const exactActivity = callIdentity && exactActiveSubagents
        ? exactActiveSubagents.get(callIdentity) || null
        : null;
      const running = action.subagentStatus
        // Explicit background status is process-scoped. The exact main-owned
        // active-call snapshot is the authority; replayed `running` text from
        // a durable card cannot resurrect a child after completion.
        ? exactActivity?.provider === chipToolType
        : isHistoryTaskBackgroundLive({
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
          label: String(action.description || 'Task agent')
            .replace(/\s+·\s+running\s*$/i, '')
            .slice(0, 80),
          entryUuid: entry.uuid,
          startedAt: Number(exactActivity?.startedAt)
            || Number(action.startedAt)
            || Date.parse(entry.timestamp || '')
            || 0,
          status: 'running',
          taskHistory: action.history,
          taskResult: action.result,
          agentSessionId: exactActivity?.agentSessionId || action.agentSessionId,
          agentId: exactActivity?.agentId || action.agentId,
          taskPrompt: action.taskPrompt,
        });
      }
    }
  }
  // Newest first, matching the SDK bar.
  return chips.sort((a, b) => b.startedAt - a.startedAt);
};

const collectHistoryAgentChips = (
  entries: FullHistoryEntry[],
  liveChips: HistoryBackgroundChip[],
): HistoryAgentChip[] => {
  const liveByKey = new Map<string, HistoryAgentChip>(
    liveChips
      .filter((chip): chip is HistoryAgentChip => chip.kind === 'subagent')
      .map((chip): [string, HistoryAgentChip] => [
        chip.key,
        { ...chip, kind: 'subagent', status: 'running' },
      ]),
  );
  const byKey = new Map<string, HistoryAgentChip>();
  for (const entry of entries) {
    const hydratedTasks = Array.isArray(entry.actions)
      ? entry.actions.filter(isTaskAction)
      : [];
    const stubTasks: TaskAction[] = hydratedTasks.length === 0
      ? (entry.actionSummary || [])
          .filter((summary) => summary.toolName === 'Task' || summary.family === 'task')
          .map((summary) => ({
            tool: 'Task' as const,
            description: String(summary.description || 'Agent'),
            toolUseId: summary.toolUseId,
            subagentStatus: summary.subagentStatus,
            agentSessionId: summary.agentSessionId,
            agentId: summary.agentId,
            taskPrompt: summary.taskPrompt,
            startedAt: summary.startedAt,
            completedAt: summary.completedAt,
            durationMs: summary.durationMs,
          }))
      : [];
    for (const action of [...hydratedTasks, ...stubTasks]) {
      const key = historyAgentKey(action, entry.uuid);
      const live = liveByKey.get(key);
      const startedAt = Number(live?.startedAt)
        || Number(action.startedAt)
        || Date.parse(entry.timestamp || '')
        || 0;
      const completedAt = Number(action.completedAt) || 0;
      const durationMs = Number(action.durationMs) > 0
        ? Number(action.durationMs)
        : completedAt > 0 && startedAt > 0
          ? Math.max(0, completedAt - startedAt)
          : 0;
      const status: HistoryAgentChip['status'] = live
        ? 'running'
        : action.subagentStatus === 'interrupted'
          ? 'interrupted'
          : action.subagentStatus === 'completed' || action.result != null || completedAt > 0
            ? 'completed'
            : 'interrupted';
      const previous = byKey.get(key);
      const record: HistoryAgentChip = {
        key,
        kind: 'subagent',
        label: String(action.description || live?.label || 'Task agent')
          .replace(/\s+·\s+running\s*$/i, '')
          .slice(0, 120),
        entryUuid: entry.uuid,
        startedAt,
        status,
        completedAt: completedAt || undefined,
        durationMs: durationMs || undefined,
        taskHistory: (action.history?.length || 0) > 0 ? action.history : previous?.taskHistory,
        taskResult: action.result ?? previous?.taskResult,
        agentSessionId: live?.agentSessionId || action.agentSessionId || previous?.agentSessionId,
        agentId: live?.agentId || action.agentId || previous?.agentId,
        taskPrompt: action.taskPrompt || previous?.taskPrompt,
      };
      byKey.set(key, record);
      liveByKey.delete(key);
    }
  }
  // A spawn can reach the canonical live stream before the durable card has
  // entered the current hydration window. Keep that active agent addressable;
  // the durable record will enrich the same key later.
  for (const [key, live] of liveByKey) byKey.set(key, live);
  return Array.from(byKey.values()).sort((left, right) => {
    if (left.status === 'running' && right.status !== 'running') return -1;
    if (right.status === 'running' && left.status !== 'running') return 1;
    return right.startedAt - left.startedAt;
  });
};

// Entry uuids that currently have a LIVE background chip. The inline
// «РАБОТАЕТ В ФОНЕ» badge follows chip liveness: a background card whose
// process died with the turn (no notification ever) must not pulse forever.
const HistoryBackgroundLiveContext = React.createContext<ReadonlySet<string>>(new Set());
const HistoryBackgroundTaskCallContext = React.createContext<ReadonlySet<string>>(new Set());


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

const historySubagentScrollMemory = new Map<string, {
  scrollTop: number;
  followBottom: boolean;
}>();

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
function useSubagentSteps(chip: HistoryBackgroundChip | null, tabId: string, toolType: string, cwd: string, sessionId: string) {
  const [steps, setSteps] = useState<SubagentStep[]>([]);
  const [pending, setPending] = useState(false);
  const offsetRef = useRef(0);
  const canLocateTranscript = toolType === 'codex'
    || !!chip?.agentSessionId
    || !!chip?.agentId
    || !!chip?.taskPrompt;
  const chipKey = chip?.kind === 'subagent' && canLocateTranscript ? chip.key : '';

  useEffect(() => {
    if (!chipKey) { setSteps([]); setPending(false); offsetRef.current = 0; return; }
    let cancelled = false;
    let tickInFlight = false;
    let drainTimer: number | null = null;
    const effectReaderId = [
      'history-subagent-reader',
      tabId,
      toolType,
      chip?.agentSessionId || chip?.agentId || chipKey,
      Date.now().toString(36),
      Math.random().toString(36).slice(2),
    ].join(':');
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
      if (cancelled || tickInFlight) return;
      tickInFlight = true;
      let shouldDrain = false;
      const previousOffset = offsetRef.current;
      try {
        if (toolType === 'codex' && !resolvedThreadId) {
          const resolved = await ipcRenderer.invoke('subagent:resolve-codex-thread', {
            tabId,
            callId: chip?.key?.replace(/^task:/, '') || '',
          });
          if (resolved?.threadId) resolvedThreadId = resolved.threadId;
        }
        if (cancelled) return;
        const res = await ipcRenderer.invoke('subagent:read-steps', {
          readerId: effectReaderId,
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
          const nextOffset = Number(res.offset) || offsetRef.current;
          offsetRef.current = nextOffset;
          if (res.steps.length > 0) {
            // Calls and results may cross byte-read boundaries. The reader
            // returns the same stable id when a result arrives; update that
            // card instead of drawing a duplicate pending+completed pair.
            setSteps((prev) => mergeHistoryTranscriptSteps(
              res.reset === true ? [] : prev,
              res.steps,
            ));
            setPending(false);
          } else if (res.reset === true) {
            setSteps([]);
          } else if (!res.pending) {
            setPending(false);
          } else if (chip?.status !== 'running' && nextOffset <= previousOffset) {
            // A completed malformed/unfinished file cannot make progress.
            // Stop the local loader; the durable Task result remains visible.
            setPending(false);
          }
          shouldDrain = res.pending === true && nextOffset > previousOffset;
        } else if (chip?.status !== 'running') {
          setPending(false);
        }
      } catch {
        // A live file may appear on the next incremental read. A completed
        // agent gets one bounded attempt and then shows the durable result or
        // the explicit unavailable state instead of an eternal loader.
        if (chip?.status !== 'running' && !cancelled) setPending(false);
      } finally {
        tickInFlight = false;
        if (shouldDrain && !cancelled) {
          drainTimer = window.setTimeout(() => {
            drainTimer = null;
            void tick();
          }, 8);
        }
      }
    };
    void tick();
    // A completed transcript is immutable: read it once. Only a genuinely
    // running agent keeps the legacy incremental tail reader alive.
    const timer = chip?.status === 'running' ? window.setInterval(tick, 1200) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      if (drainTimer !== null) window.clearTimeout(drainTimer);
      ipcRenderer.send('subagent:release-reader', { readerId: effectReaderId });
    };
  }, [chipKey, tabId, toolType, cwd, sessionId, chip?.agentId, chip?.agentSessionId, chip?.taskPrompt, chip?.label, chip?.startedAt, chip?.status]);

  return { steps, pending };
}

// One docked inspector serves both live and completed agents. It is a sibling
// of the History viewport, not a scrollable child inside a virtual row.
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
  const running = chip.status === 'running'
    || (chip.kind === 'bash' && chip.status !== 'completed' && chip.status !== 'interrupted');
  const interrupted = chip.status === 'interrupted';
  const scrollMemoryKey = [
    tabId,
    toolType,
    sessionId,
    chip.key,
    chip.agentSessionId || chip.agentId || '',
    String(chip.startedAt || ''),
  ].join('|');
  const statusLabel = running ? 'Working' : interrupted ? 'Interrupted' : 'Completed';
  const statusColor = running ? '#d97706' : interrupted ? '#d97706' : '#4ade80';
  const durationMs = Number(chip.durationMs) > 0
    ? Number(chip.durationMs)
    : Number(chip.completedAt) > 0 && Number(chip.startedAt) > 0
      ? Math.max(0, Number(chip.completedAt) - Number(chip.startedAt))
      : 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const followBottomRef = useRef(true);
  const restoredScrollRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const { steps: liveSteps, pending: stepsPending } = useSubagentSteps(chip, tabId, toolType, cwd, sessionId);
  const [answerCopied, setAnswerCopied] = useState(false);
  const answerCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  useEffect(() => setShowThinking(false), [chip.key]);
  useEffect(() => {
    setAnswerCopied(false);
    return () => {
      if (answerCopiedTimerRef.current) window.clearTimeout(answerCopiedTimerRef.current);
      answerCopiedTimerRef.current = null;
    };
  }, [chip.key]);
  // Reasoning dwarfs everything else (784 thinking records vs 39 answers on a
  // real Codex agent), so it is folded away unless explicitly asked for.
  const visibleSteps = useMemo(
    () => (showThinking ? liveSteps : liveSteps.filter((step) => step.kind !== 'thinking')),
    [liveSteps, showThinking],
  );
  const fallbackSteps = useMemo(
    () => historyTurnsToTranscriptSteps(chip.taskHistory || []),
    [chip.taskHistory, chip.taskHistory?.length],
  );
  const basePresentedSteps = visibleSteps.length > 0 ? visibleSteps : fallbackSteps;
  const presentedSteps = useMemo(() => {
    const result = !running ? String(chip.taskResult || '').trim() : '';
    if (!result || basePresentedSteps.some((step) => String(step.text || '').trim() === result)) {
      return basePresentedSteps;
    }
    return [
      ...basePresentedSteps,
      {
        id: chip.key + ':final-result',
        kind: 'message' as const,
        role: 'assistant' as const,
        text: result,
        final: true,
      },
    ];
  }, [basePresentedSteps, chip.key, chip.taskResult, running]);
  const thinkingCount = useMemo(
    () => liveSteps.reduce((sum, step) => sum + (step.kind === 'thinking' ? 1 : 0), 0),
    [liveSteps],
  );
  const fullAgentAnswer = useMemo(() => {
    const durable = String(chip.taskResult || '').trim();
    if (durable) return durable;
    const final = [...liveSteps].reverse().find((step) => (
      step.kind === 'message' && step.role === 'assistant' && step.final === true
    ));
    return String(final?.text || '').trim();
  }, [chip.taskResult, liveSteps]);
  const copyAgentAnswer = useCallback(() => {
    if (!fullAgentAnswer) return;
    clipboard.writeText(fullAgentAnswer);
    setAnswerCopied(true);
    if (answerCopiedTimerRef.current) window.clearTimeout(answerCopiedTimerRef.current);
    answerCopiedTimerRef.current = window.setTimeout(() => {
      answerCopiedTimerRef.current = null;
      setAnswerCopied(false);
    }, 900);
  }, [fullAgentAnswer]);
  const loadSubagentPayload = useCallback(async (ref: { payloadId: string; totalChars: number }) => {
    const result = await ipcRenderer.invoke('subagent:get-step-payload', {
      payloadId: ref.payloadId,
    });
    if (!result?.success || typeof result.payload !== 'string') return null;
    return result.truncatedForRender
      ? result.payload
        + '\n… (показаны первые '
        + Math.round(result.payload.length / 1024)
        + ' KB из '
        + Math.round((result.totalChars || ref.totalChars || 0) / 1024)
        + ' KB)'
      : result.payload;
  }, []);
  const openSubagentMessageContextMenu = useCallback((
    event: React.MouseEvent<HTMLDivElement>,
    step: HistoryTranscriptStep,
  ) => {
    const selection = window.getSelection();
    if (
      selection
      && !selection.isCollapsed
      && selection.anchorNode
      && event.currentTarget.contains(selection.anchorNode)
    ) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    const provider = toolType === 'codex' ? 'Codex' : 'Claude';
    const timestamp = step.timestamp ? new Date(step.timestamp) : null;
    ipcRenderer.send('show-history-entry-context-menu', {
      copyText: [
        'Agent: ' + provider + ' subagent',
        'Role: ' + (step.role || 'assistant'),
        timestamp && !Number.isNaN(timestamp.getTime())
          ? 'Time: ' + timestamp.toLocaleString()
          : null,
        (step.messageId || step.id) ? 'Message ID: ' + (step.messageId || step.id) : null,
        (step.sessionId || chip.agentSessionId)
          ? 'Session ID: ' + (step.sessionId || chip.agentSessionId)
          : null,
        'Parent Tab ID: ' + tabId,
      ].filter(Boolean).join('\n'),
    });
  }, [chip.agentSessionId, tabId, toolType]);
  useEffect(() => {
    restoredScrollRef.current = false;
    const saved = historySubagentScrollMemory.get(scrollMemoryKey);
    followBottomRef.current = saved?.followBottom ?? true;
    return () => {
      const el = scrollRef.current;
      if (!el) return;
      historySubagentScrollMemory.delete(scrollMemoryKey);
      historySubagentScrollMemory.set(scrollMemoryKey, {
        scrollTop: el.scrollTop,
        followBottom: followBottomRef.current,
      });
      if (historySubagentScrollMemory.size > 128) {
        const oldest = historySubagentScrollMemory.keys().next().value;
        if (oldest) historySubagentScrollMemory.delete(oldest);
      }
    };
  }, [scrollMemoryKey]);
  // Follow new work only while the reader was already at the bottom. A user
  // inspecting an older step owns their position; collapse/reopen and tab
  // switches restore that exact nested scroll instead of snapping to tail.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = historySubagentScrollMemory.get(scrollMemoryKey);
    programmaticScrollRef.current = true;
    if (!restoredScrollRef.current && saved && !saved.followBottom) {
      el.scrollTop = Math.min(saved.scrollTop, Math.max(0, el.scrollHeight - el.clientHeight));
      restoredScrollRef.current = true;
    } else if (followBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      restoredScrollRef.current = true;
    }
    setShowScrollToBottom(
      el.scrollHeight - el.clientHeight - el.scrollTop > 12,
    );
    requestAnimationFrame(() => { programmaticScrollRef.current = false; });
  }, [scrollMemoryKey, presentedSteps]);
  return (
    <div
      data-history-background-detail
      style={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        borderTop: '1px solid #2a2a2a',
        background: '#111111',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 10px', borderBottom: '1px solid #222',
        color: '#bdbdbd', fontSize: '0.85em',
      }}>
        {running
          ? <HistoryBackgroundDot />
          : interrupted
            ? <AlertTriangle size={11} style={{ color: statusColor, flexShrink: 0 }} />
            : <Check size={11} style={{ color: statusColor, flexShrink: 0 }} />}
        {chip.kind === 'bash'
          ? <TerminalSquare size={12} style={{ color: statusColor, flexShrink: 0 }} />
          : <Bot size={12} style={{ color: statusColor, flexShrink: 0 }} />}
        <span className="truncate" style={{ flex: 1, fontFamily: 'monospace' }}>{chip.label}</span>
        <span style={{ color: statusColor, fontSize: '0.9em' }}>{statusLabel}</span>
        <span style={{ color: '#666', fontVariantNumeric: 'tabular-nums', minWidth: 0 }}>
          {running
            ? formatBackgroundElapsed(chip.startedAt)
            : durationMs > 0 ? formatSubagentDuration(durationMs) : ''}
        </span>
        {fullAgentAnswer && (
          <button
            type="button"
            onClick={copyAgentAnswer}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: 'none', border: '1px solid #333', borderRadius: 4,
              color: answerCopied ? '#4ade80' : '#999', fontSize: '0.9em',
              padding: '1px 7px', cursor: 'pointer',
            }}
            title={answerCopied ? 'Ответ скопирован' : 'Копировать полный ответ агента'}
          >
            {answerCopied ? <Check size={10} /> : <Copy size={10} />}
            {answerCopied ? 'Скопировано' : 'Копировать'}
          </button>
        )}
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
        onScroll={(event) => {
          if (programmaticScrollRef.current) return;
          const el = event.currentTarget;
          followBottomRef.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 12;
          setShowScrollToBottom(!followBottomRef.current);
          historySubagentScrollMemory.delete(scrollMemoryKey);
          historySubagentScrollMemory.set(scrollMemoryKey, {
            scrollTop: el.scrollTop,
            followBottom: followBottomRef.current,
          });
        }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 10px', fontSize: '0.82em', color: '#aaa' }}
      >
        {chip.kind === 'subagent' && (stepsPending && presentedSteps.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, color: '#777' }}>
            <HistorySpinner size={14} />
            Загружаем историю агента…
          </div>
        ) : presentedSteps.length > 0 ? (
          <>
            <HistoryTranscriptPresentation
              steps={presentedSteps}
              isTurnBusy={running}
              onCopy={(text) => clipboard.writeText(text)}
              loadPayload={loadSubagentPayload}
              onMessageContextMenu={openSubagentMessageContextMenu}
            />
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
            {running
              ? 'Агент работает — промежуточные шаги появятся здесь по мере записи.'
              : 'История агента недоступна.'}
          </div>
        ))}
        {chip.kind === 'bash' && (
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace' }}>
            {chip.bashAcceptance || 'Команда работает в фоне; итог придёт уведомлением.'}
          </div>
        )}
      </div>
      {showScrollToBottom && (
        <button
          type="button"
          aria-label="К последнему шагу агента"
          title="К последнему шагу"
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            programmaticScrollRef.current = true;
            el.scrollTop = el.scrollHeight;
            followBottomRef.current = true;
            setShowScrollToBottom(false);
            historySubagentScrollMemory.delete(scrollMemoryKey);
            historySubagentScrollMemory.set(scrollMemoryKey, {
              scrollTop: el.scrollTop,
              followBottom: true,
            });
            requestAnimationFrame(() => { programmaticScrollRef.current = false; });
          }}
          style={{
            position: 'absolute', right: 10, bottom: 10, zIndex: 2,
            width: 28, height: 28, display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', borderRadius: 7, border: '1px solid #3a3a3a',
            background: '#181818', color: '#9ca3af', cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          }}
        >
          <ArrowDownToLine size={14} />
        </button>
      )}
    </div>
  );
});

const HistoryAgentRoster = memo(({
  agents,
  selectedKey,
  onSelect,
  onClose,
}: {
  agents: HistoryAgentChip[];
  selectedKey: string | null;
  onSelect: (agentKey: string) => void;
  onClose: () => void;
}) => {
  const running = agents.filter((agent) => agent.status === 'running');
  const completed = agents.filter((agent) => agent.status === 'completed');
  const interrupted = agents.filter((agent) => agent.status === 'interrupted');
  const renderSection = (label: string, records: HistoryAgentChip[]) => {
    if (records.length === 0) return null;
    return (
      <div>
        <div style={{ padding: '5px 10px 3px', color: '#666', fontSize: '0.72em', textTransform: 'uppercase', letterSpacing: 0.7 }}>
          {label}
        </div>
        {records.map((agent) => {
          const selected = selectedKey === agent.key;
          const interrupted = agent.status === 'interrupted';
          const duration = Number(agent.durationMs) > 0
            ? Number(agent.durationMs)
            : Number(agent.completedAt) > 0 && agent.startedAt > 0
              ? Math.max(0, Number(agent.completedAt) - agent.startedAt)
              : 0;
          return (
            <button
              key={agent.key}
              type="button"
              onClick={() => onSelect(agent.key)}
              style={{
                width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: 7,
                padding: '5px 10px', border: 'none', background: selected ? 'rgba(129, 140, 248, 0.10)' : 'transparent',
                color: '#bdbdbd', cursor: 'pointer', textAlign: 'left', fontSize: '0.82em',
              }}
              onMouseEnter={(event) => { if (!selected) event.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
              onMouseLeave={(event) => { if (!selected) event.currentTarget.style.background = 'transparent'; }}
            >
              {agent.status === 'running'
                ? <HistoryBackgroundDot />
                : interrupted
                  ? <AlertTriangle size={11} style={{ color: '#d97706', flexShrink: 0 }} />
                  : <Check size={11} style={{ color: '#4ade80', flexShrink: 0 }} />}
              <Bot size={11} style={{ color: agent.status === 'running' || interrupted ? '#d97706' : '#818cf8', flexShrink: 0 }} />
              <span className="truncate" style={{ minWidth: 0, flex: 1 }}>{agent.label}</span>
              <span style={{ color: '#666', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                {agent.status === 'running'
                  ? formatBackgroundElapsed(agent.startedAt)
                  : duration > 0 ? formatSubagentDuration(duration) : ''}
              </span>
            </button>
          );
        })}
      </div>
    );
  };
  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid #2a2a2a', background: '#111' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderBottom: '1px solid #222', color: '#bdbdbd', fontSize: '0.85em' }}>
        <Bot size={12} style={{ color: '#818cf8' }} />
        <span style={{ flex: 1 }}>Agents · {agents.length}</span>
        <button type="button" onClick={onClose} aria-label="Close agents list" style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', padding: 2 }}>
          <X size={13} />
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 4 }}>
        {renderSection('Running', running)}
        {renderSection('Completed', completed)}
        {renderSection('Interrupted', interrupted)}
      </div>
    </div>
  );
});

const HistoryBackgroundTasksBar = memo(({
  chips,
  agents,
  selectedKey,
  rosterOpen,
  onToggleDetail,
  onToggleRoster,
  onSelectAgent,
  onJumpToCard,
  tabId,
  toolType,
  cwd,
  sessionId,
}: {
  chips: HistoryBackgroundChip[];
  agents: HistoryAgentChip[];
  selectedKey: string | null;
  rosterOpen: boolean;
  onToggleDetail: (chipKey: string) => void;
  onToggleRoster: () => void;
  onSelectAgent: (agentKey: string) => void;
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
  const [inspectorHeight, setInspectorHeight] = useState(260);
  const resizeCleanupRef = useRef<null | (() => void)>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);
  const beginInspectorResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();
    const startY = event.clientY;
    const startHeight = inspectorHeight;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    const onMove = (moveEvent: MouseEvent) => {
      const maxHeight = Math.max(160, Math.min(620, window.innerHeight - 120));
      setInspectorHeight(Math.max(140, Math.min(maxHeight, startHeight + startY - moveEvent.clientY)));
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', cleanup);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', cleanup);
  }, [inspectorHeight]);
  useEffect(() => {
    if (chips.length === 0 && !agents.some((agent) => agent.status === 'running')) return;
    const handle = window.setInterval(() => force(), 1000);
    return () => window.clearInterval(handle);
  }, [agents, chips.length]);
  if (chips.length === 0 && agents.length === 0) return null;
  const detailItems = new Map<string, HistoryBackgroundChip>();
  for (const chip of chips) detailItems.set(chip.key, chip);
  for (const agent of agents) detailItems.set(agent.key, agent);
  const expandedChip = selectedKey
    ? detailItems.get(selectedKey) || null
    : null;
  const runningAgentCount = agents.reduce((sum, agent) => sum + (agent.status === 'running' ? 1 : 0), 0);
  const popoverOpen = rosterOpen || !!expandedChip;
  return (
    <div style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      {popoverOpen && (
        <div
          data-history-agent-popover
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: '100%',
            height: inspectorHeight,
            minHeight: 140,
            maxHeight: 'calc(100vh - 120px)',
            zIndex: 20,
            background: '#111',
            boxShadow: '0 -10px 24px rgba(0, 0, 0, 0.34)',
          }}
        >
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Изменить высоту Agent Inspector"
            onMouseDown={beginInspectorResize}
            style={{
              position: 'absolute', left: 0, right: 0, top: -4, height: 8,
              zIndex: 2, cursor: 'ns-resize', display: 'flex', justifyContent: 'center', alignItems: 'center',
            }}
          >
            <span style={{ width: 38, height: 2, borderRadius: 2, background: '#4a4a4a', pointerEvents: 'none' }} />
          </div>
          {rosterOpen ? (
            <HistoryAgentRoster
              agents={agents}
              selectedKey={selectedKey}
              onSelect={onSelectAgent}
              onClose={onToggleRoster}
            />
          ) : expandedChip && (
            <HistoryBackgroundDetailPane
              chip={expandedChip}
              onJumpToCard={onJumpToCard}
              onClose={() => onToggleDetail(expandedChip.key)}
              tabId={tabId}
              toolType={toolType}
              cwd={cwd}
              sessionId={sessionId}
            />
          )}
        </div>
      )}
      <div
        data-history-background-tasks
        className="inline-flex items-stretch overflow-x-auto shrink-0"
        style={{
          display: 'inline-flex',
          width: 'max-content',
          maxWidth: '100%',
          borderTop: '1px solid #2a2a2a',
          borderRight: '1px solid #2a2a2a',
          background: '#141414',
        }}
      >
        {agents.length > 0 && (
          <button
            type="button"
            onClick={onToggleRoster}
            onMouseDown={(event) => event.preventDefault()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[0.85em] font-mono shrink-0 cursor-pointer outline-none"
            style={{
              background: rosterOpen ? 'rgba(129, 140, 248, 0.10)' : 'transparent',
              color: '#bdbdbd', minHeight: 22, border: 'none',
            }}
            title="Показать всех агентов"
          >
            {runningAgentCount > 0 ? <HistoryBackgroundDot /> : <Bot size={11} style={{ color: '#818cf8' }} />}
            <span>Agents</span>
            <span style={{ color: '#666', fontVariantNumeric: 'tabular-nums' }}>{agents.length}</span>
          </button>
        )}
        {chips.map((chip, index) => {
          const expanded = chip.key === selectedKey && !rosterOpen;
          return (
            <React.Fragment key={chip.key}>
              {(index > 0 || agents.length > 0) && (
                <span
                  aria-hidden
                  className="self-stretch shrink-0"
                  style={{ width: 1, background: '#2a2a2a', margin: '4px 0' }}
                />
              )}
              <button
                type="button"
                onClick={() => onToggleDetail(chip.key)}
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

// A wheel over an expanded tool body is physically consumed in the capture
// handler below. The same native event still reaches other listeners on the
// scroller unless it is stopped immediately; remember that exact object so
// the outer History intent handler does not also unpin/cancel restore for a
// movement that never belonged to the feed.
const historyInnerOwnedWheelEvents = new WeakSet<Event>();

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
      {/* Верхняя кнопка только у раскрытого блока: у свёрнутого начало текста
          видно целиком, и дублировать «раскрыть» в двух углах маленькой шапки
          нечего. У раскрытого же конец текста может быть далеко, поэтому
          «Свернуть» нужно и там, где чтение началось, и там, где закончилось. */}
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
  const dismiss = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && anchor?.contains(active)) active.blur();
    onClose();
  }, [anchor, onClose]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismiss]);

  if (!anchor?.isConnected) return null;

  return createPortal(
    <>
      <div
        data-history-chip-popover-backdrop
        aria-hidden
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
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
        settleBeforeShow
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

/**
 * Текстовый кусок сообщения, у которого есть и другие части (чипы, картинки).
 *
 * Кнопки раскрытия здесь НЕТ намеренно. Сообщение сворачивается целиком, как
 * одно сообщение, и кнопка сидит на его рамке — сверху и снизу слева (см.
 * `.cb-collapse-top/.cb-collapse-bottom`). Раньше этот кусок нёс свою кнопку
 * `display: inline-block` прямо в потоке текста: она вставала посреди строки,
 * между словами, и в сообщении с тремя вставками таких кнопок было три. Внутри
 * текста кнопке места нет — пользователь: «почему кнопка „раскрыть“ и „свернуть“
 * отображается внутри текста? такого никогда быть не должно».
 *
 * Обрезку тоже не делает: решение «сколько показать» принадлежит сообщению
 * целиком, иначе каждый кусок обрезался бы по своему порогу и в одном пузыре
 * оказалось бы несколько многоточий.
 */
const HistoryInlineTextPart = ({ text }: { text: string }) => <>{text}</>;

const HistoryImageTokenThumbnail = ({ src }: { src?: string }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const showImage = !!src && !failed;
  return (
    <span className="cm-composer-token-thumbnail" aria-hidden="true">
      {showImage && (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
      <span
        className="cm-composer-token-thumbnail-fallback"
        style={{ display: showImage ? 'none' : undefined }}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2.5" y="3" width="15" height="14" rx="2" />
          <circle cx="7" cy="8" r="1.5" />
          <path d="m4.5 15 4-4 2.5 2.5 2-2 2.5 3.5" />
        </svg>
      </span>
    </span>
  );
};

const HistoryComposerToken = ({
  kind,
  label,
  thumbnailUrl,
  onClick,
  buttonRef,
}: {
  kind: 'image' | 'paste';
  label: string;
  thumbnailUrl?: string;
  onClick: (trigger: HTMLElement) => void;
  buttonRef: (node: HTMLElement | null) => void;
}) => (
  <span
    ref={buttonRef}
    data-history-composer-token={kind}
    style={{ display: 'inline-flex', verticalAlign: 'middle' }}
  >
    <ComposerChip
      kind={kind}
      className="hp-history-attachment-chip"
      leading={kind === 'image' ? <HistoryImageTokenThumbnail src={thumbnailUrl} /> : undefined}
      label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(event.currentTarget);
      }}
    />
  </span>
);

type HistoryInstructionAttachment = {
  fileName: 'AGENTS.md' | 'CLAUDE.md';
  scopeLabel: string;
  provider: 'codex' | 'claude';
};

/** Codex writes its automatically injected project contract as an ordinary
 * `role=user` response_item (`# AGENTS.md instructions for …`). Claude may
 * expose the equivalent as a standalone `<system-reminder>` containing
 * CLAUDE.md. Structurally they stay transcript rows, but visually neither is
 * something the user typed — they are attached context and belong in a chip. */
const historyInstructionAttachment = (
  text: string,
  toolType?: 'claude' | 'gemini' | 'codex',
): HistoryInstructionAttachment | null => {
  if (toolType !== 'codex' && toolType !== 'claude') return null;
  const value = String(text || '').trim();
  if (!value) return null;

  const direct = value.match(
    /^#\s+(AGENTS\.md|CLAUDE\.md)\s+instructions\s+for\s+([^\r\n]+)(?:\r?\n|$)/i,
  );
  if (direct && /<(?:INSTRUCTIONS|instructions)>/i.test(value.slice(0, 2000))) {
    const rawName = direct[1].toUpperCase();
    const fileName = rawName.startsWith('CLAUDE') ? 'CLAUDE.md' : 'AGENTS.md';
    const scope = direct[2].trim().replace(/[\\/]+$/, '');
    const scopeLabel = scope.split(/[\\/]/).filter(Boolean).pop() || scope;
    return { fileName, scopeLabel, provider: toolType };
  }

  // Only a WHOLE standalone reminder qualifies. A normal user prompt may
  // legitimately quote `CLAUDE.md`; collapsing that prompt would hide what
  // the user actually said.
  if (!/^<system-reminder>[\s\S]*<\/system-reminder>$/.test(value)) return null;
  const reminderHead = value.slice(0, 5000);
  const nameMatch = reminderHead.match(/\b(AGENTS\.md|CLAUDE\.md)\b/i);
  if (!nameMatch) return null;
  const rawName = nameMatch[1].toUpperCase();
  const fileName = rawName.startsWith('CLAUDE') ? 'CLAUDE.md' : 'AGENTS.md';
  const pathMatch = reminderHead.match(
    /Contents of\s+([^\r\n]+?(?:AGENTS\.md|CLAUDE\.md))\b/i,
  );
  const rawPath = String(pathMatch?.[1] || '').trim().replace(/[\\/]+$/, '');
  const pathParts = rawPath.split(/[\\/]/).filter(Boolean);
  const scopeLabel = pathParts.length > 1 ? pathParts[pathParts.length - 2] : '';
  return { fileName, scopeLabel, provider: toolType };
};

/** A user row made only from attachment chips already has complete visual
 * containers. Wrapping one or several of them in the orange message bubble
 * creates a meaningless second card. Keep the raw message untouched; this
 * predicate is presentation-only and ignores whitespace-only separators. */
const historyUserPromptIsChipOnly = ({
  text,
  promptChips = [],
  imagePaths = [],
  toolType,
}: {
  text: string;
  promptChips?: HistoryPromptDraftChip[];
  imagePaths?: HistoryPromptDraftImageRef[];
  toolType?: 'claude' | 'gemini' | 'codex';
}) => {
  if (historyInstructionAttachment(text, toolType)) return true;
  const presentation = buildHistoryComposerPresentationParts({
    text,
    chips: promptChips,
    imagePaths,
  });
  const visibleParts = (presentation.parts as Array<any>).filter((part) => (
    part?.kind !== 'text' || String(part?.text || '').trim().length > 0
  ));
  return visibleParts.length > 0 && visibleParts.every((part) => part?.kind !== 'text');
};

const HistoryInstructionProviderIcon = ({ provider }: { provider: 'codex' | 'claude' }) => (
  provider === 'codex' ? (
    <svg
      className="hp-history-instruction-provider hp-history-instruction-provider--codex"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {/* Same Codex terminal-knot mark as the app asset, but currentColor lets
          this context attachment use the established Codex green channel. */}
      <path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="currentColor" />
    </svg>
  ) : (
    <svg
      className="hp-history-instruction-provider hp-history-instruction-provider--claude"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="M8 1.4v13.2M1.4 8h13.2M3.3 3.3l9.4 9.4M12.7 3.3l-9.4 9.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
);

const HistoryInstructionChip = ({
  attachment,
  text,
  forceExpanded = false,
}: {
  attachment: HistoryInstructionAttachment;
  text: string;
  forceExpanded?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const closePopover = useCallback(() => setOpen(false), []);
  return (
    <div className="cb-msg-text hp-history-instruction-attachment">
      <span ref={anchorRef} style={{ display: 'inline-flex', verticalAlign: 'middle' }}>
        <ComposerChip
          kind="prompt"
          className="hp-history-instruction-chip"
          leading={<HistoryInstructionProviderIcon provider={attachment.provider} />}
          label={attachment.fileName}
          preview={attachment.scopeLabel || undefined}
          onClick={forceExpanded ? undefined : (event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen((value) => {
              if (value) event.currentTarget.blur();
              return !value;
            });
          }}
        />
      </span>
      {forceExpanded && (
        <PastedContentPreview text={text} />
      )}
      {!forceExpanded && open && (
        <HistoryChipPopover anchor={anchorRef.current} onClose={closePopover}>
          <PastedContentPreview
            text={text}
            clampToViewport={false}
          />
        </HistoryChipPopover>
      )}
    </div>
  );
};

type HistoryPromptPresentationPart = {
  part: any;
  sourceIndex: number;
};

/** Saved prompts are serialized as a prefix before the user's own text. The
 * parser preserves the separating newlines because they are canonical bytes,
 * but presentation treats that prefix as one attachment band. This removes
 * only whitespace BETWEEN leading prompt chips; whitespace in the actual
 * message body remains untouched. */
const splitLeadingHistoryPromptParts = (parts: Array<any>) => {
  const promptParts: HistoryPromptPresentationPart[] = [];
  let cursor = 0;
  let foundPrompt = false;
  while (cursor < parts.length) {
    const part = parts[cursor];
    if (part?.kind === 'prompt') {
      promptParts.push({ part, sourceIndex: cursor });
      foundPrompt = true;
      cursor += 1;
      continue;
    }
    if (part?.kind === 'text' && String(part.text || '').trim().length === 0) {
      cursor += 1;
      continue;
    }
    break;
  }
  if (!foundPrompt) return { promptParts: [], bodyParts: parts };
  const bodyParts = parts.slice(cursor);
  // Wrapper serialization joins the last prompt and ordinary text with one
  // `\n\n`. parsePastedContentParts keeps it attached to that first text part;
  // remove only this known transport delimiter, not user-authored spaces.
  if (bodyParts[0]?.kind === 'text') {
    bodyParts[0] = {
      ...bodyParts[0],
      text: String(bodyParts[0].text || '').replace(/^(?:\r?\n){2}/, ''),
    };
  }
  return { promptParts, bodyParts };
};

const HistoryUserPromptBand = ({
  parts,
}: {
  parts: HistoryPromptPresentationPart[];
}) => {
  const [expandedPart, setExpandedPart] = useState<string | null>(null);
  const anchorsRef = useRef<Map<string, HTMLElement>>(new Map());
  const setAnchor = useCallback((partKey: string, node: HTMLElement | null) => {
    if (node) anchorsRef.current.set(partKey, node);
    else anchorsRef.current.delete(partKey);
  }, []);
  const closePopover = useCallback(() => setExpandedPart(null), []);

  return (
    <div className="hp-history-user-prompt-band" data-history-user-prompt-band>
      {parts.map(({ part, sourceIndex }) => {
        const chip = part.chip as HistoryPromptDraftChip;
        const partKey = `prompt-band:${sourceIndex}:${chip.id || sourceIndex}`;
        const open = expandedPart === partKey;
        return (
          <React.Fragment key={partKey}>
            <span
              ref={(node) => setAnchor(partKey, node)}
              className="hp-history-user-prompt-chip-slot"
            >
              <ComposerChip
                kind="prompt"
                label={promptChipDisplayLabel(chip)}
                title={chip.inheritanceParentLabel
                  ? `Наследует: ${chip.inheritanceParentLabel}`
                  : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setExpandedPart((current) => {
                    if (current === partKey) event.currentTarget.blur();
                    return current === partKey ? null : partKey;
                  });
                }}
              />
            </span>
            {open && (
              <HistoryChipPopover
                anchor={anchorsRef.current.get(partKey) || null}
                onClose={closePopover}
              >
                <PastedContentPreview
                  text={chip.text}
                  clampToViewport={false}
                />
              </HistoryChipPopover>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};

const HistoryUserPromptContent = ({
  text,
  promptChips = [],
  imagePaths = [],
  toolType,
  forceExpanded = false,
  presentationParts,
}: {
  text: string;
  promptChips?: HistoryPromptDraftChip[];
  imagePaths?: HistoryPromptDraftImageRef[];
  toolType?: 'claude' | 'gemini' | 'codex';
  forceExpanded?: boolean;
  presentationParts?: Array<any>;
}) => {
  const instructionAttachment = useMemo(
    () => historyInstructionAttachment(text, toolType),
    [text, toolType],
  );
  const [expandedPart, setExpandedPart] = useState<string | null>(null);
  // Раскрытие всего сообщения — отдельное состояние от раскрытия одной части
  // (чипа): это разные жесты, и «показать тело вставки» не должно разворачивать
  // сообщение целиком. Тот же helper компенсации прокрутки, что у обычного
  // длинного сообщения, поэтому клик не уводит строку из-под курсора.
  const [mixedExpanded, setMixedExpanded] = useState(false);
  const mixedAnchorRef = useRef<HTMLDivElement>(null);
  const toggleMixedExpanded = useHistoryRevealToggle(mixedAnchorRef, mixedExpanded, setMixedExpanded);
  const revealAnchorsRef = useRef<Map<string, HTMLElement>>(new Map());
  const setRevealAnchor = useCallback((partKey: string, node: HTMLElement | null) => {
    if (node) revealAnchorsRef.current.set(partKey, node);
    else revealAnchorsRef.current.delete(partKey);
  }, []);
  const togglePopoverPart = useCallback((partKey: string, trigger?: HTMLElement) => {
    if (forceExpanded) return;
    setExpandedPart((current) => {
      if (current === partKey) trigger?.blur();
      return current === partKey ? null : partKey;
    });
  }, [forceExpanded]);
  const closePopover = useCallback(() => setExpandedPart(null), []);
  const presentation = useMemo(
    () => buildHistoryComposerPresentationParts({ text, chips: promptChips, imagePaths }),
    [imagePaths, promptChips, text],
  );
  const parts = presentationParts || (presentation.parts as Array<any>);
  const hasOpaquePart = parts.some((part) => part.kind !== 'text');
  const imagePreviewUrls = useComposerImagePreviews(imagePaths);
  const expandedImagePart = useMemo(() => {
    if (!expandedPart?.startsWith('image:')) return null;
    const index = Number(expandedPart.split(':')[1]);
    const part = parts[index];
    return part?.kind === 'image' ? part : null;
  }, [expandedPart, parts]);
  const expandedImageRef = expandedImagePart?.ref as HistoryPromptDraftImageRef | undefined;
  const imageDetailPreview = useComposerImagePreview(expandedImageRef, 'detail');

  if (instructionAttachment) {
    return (
      <HistoryInstructionChip
        attachment={instructionAttachment}
        text={text}
        forceExpanded={forceExpanded}
      />
    );
  }

  if (parts.length === 0) return null;

  if (!hasOpaquePart) {
    const plainText = parts.map((part) => String(part?.text || '')).join('');
    return <HistoryCollapsiblePrompt text={plainText} forceExpanded={forceExpanded} />;
  }

  // Единица сворачивания — СООБЩЕНИЕ, а не отдельный текстовый кусок. Кнопка
  // сидит на рамке пузыря (сверху и снизу слева), ровно как у обычного длинного
  // сообщения; внутри текста её быть не может.
  const needsCollapse = mixedMessageNeedsCollapse(parts, HISTORY_USER_TEXT_COLLAPSE_THRESHOLD);
  const open = forceExpanded || mixedExpanded;
  const visible = needsCollapse && !open
    ? truncateMixedMessageParts(parts, HISTORY_USER_TEXT_COLLAPSED_CHARS)
    : { parts, truncated: false };
  const collapseToggle = needsCollapse && !forceExpanded ? (
    <button
      type="button"
      className="cb-collapse-btn"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleMixedExpanded();
      }}
    >
      {open ? 'Свернуть' : `Раскрыть полностью (${text.split('\n').length.toLocaleString()} строк)`}
    </button>
  ) : null;

  return (
    <div
      className="cb-msg-text"
      data-history-user-composer-flow
      ref={mixedAnchorRef}
      style={{ display: 'block' }}
    >
      {/* Верхняя кнопка только у раскрытого: у свёрнутого начало видно целиком. */}
      {open && collapseToggle && <div className="cb-collapse-top">{collapseToggle}</div>}
      {visible.parts.map((part, index) => {
        if (part.kind === 'text') {
          return (
            <HistoryInlineTextPart
              key={`text:${index}`}
              text={part.text}
            />
          );
        }
        if (part.kind === 'prompt') {
          const chip = part.chip as HistoryPromptDraftChip;
          const partKey = `prompt:${index}:${chip.id || index}`;
          const open = expandedPart === partKey;
          return (
            <React.Fragment key={partKey}>
              <span
                ref={(node) => setRevealAnchor(partKey, node)}
                style={{ display: 'inline-flex', verticalAlign: 'middle' }}
              >
                <ComposerChip
                  kind="prompt"
                  label={promptChipDisplayLabel(chip)}
                  title={chip.inheritanceParentLabel
                    ? `Наследует: ${chip.inheritanceParentLabel}`
                    : undefined}
                  onClick={(event) => togglePopoverPart(partKey, event.currentTarget)}
                />
              </span>
              {forceExpanded && (
                <PastedContentPreview text={chip.text} />
              )}
              {!forceExpanded && open && (
                <HistoryChipPopover
                  anchor={revealAnchorsRef.current.get(partKey) || null}
                  onClose={closePopover}
                >
                  <PastedContentPreview
                    text={chip.text}
                    clampToViewport={false}
                  />
                </HistoryChipPopover>
              )}
            </React.Fragment>
          );
        }
        if (part.kind === 'paste') {
          const partKey = `paste:${index}`;
          const open = expandedPart === partKey;
          return (
            <React.Fragment key={partKey}>
              <HistoryComposerToken
                kind="paste"
                label={`Pasted Content ${part.text.length.toLocaleString('ru-RU')} chars`}
                buttonRef={(node) => setRevealAnchor(partKey, node)}
                onClick={(trigger) => togglePopoverPart(partKey, trigger)}
              />
              {forceExpanded && (
                <PastedContentPreview text={part.text} />
              )}
              {!forceExpanded && open && (
                <HistoryChipPopover
                  anchor={revealAnchorsRef.current.get(partKey) || null}
                  onClose={closePopover}
                >
                  <PastedContentPreview
                    text={part.text}
                    clampToViewport={false}
                  />
                </HistoryChipPopover>
              )}
            </React.Fragment>
          );
        }

        const partKey = `image:${index}:${part.id}`;
        const ref = part.ref as HistoryPromptDraftImageRef | undefined;
        const open = expandedPart === partKey;
        return (
          <React.Fragment key={partKey}>
            <HistoryComposerToken
              kind="image"
              label={`image #${part.id}`}
              thumbnailUrl={composerImageUrl(ref, imagePreviewUrls)}
              buttonRef={(node) => setRevealAnchor(partKey, node)}
              onClick={(trigger) => togglePopoverPart(partKey, trigger)}
            />
            {!forceExpanded && open && (
              <HistoryChipPopover
                anchor={revealAnchorsRef.current.get(partKey) || null}
                onClose={closePopover}
              >
                <AIComposerImageAttachmentPreview
                  src={expandedImagePart === part ? imageDetailPreview.url : undefined}
                  loading={expandedImagePart === part && imageDetailPreview.loading}
                  error={expandedImagePart === part
                    ? imageDetailPreview.error || (!ref ? 'Image reference is unavailable in this History entry.' : null)
                    : null}
                  path={ref?.path}
                  assetId={ref?.assetId}
                  size={ref?.size}
                  alt={`Image attachment #${part.id}`}
                />
              </HistoryChipPopover>
            )}
          </React.Fragment>
        );
      })}
      {/* Многоточие ставится ОДИН раз, за всё сообщение: обрезка принадлежит
          сообщению, а не куску, иначе в одном пузыре было бы несколько «…». */}
      {visible.truncated && '…'}
      {collapseToggle && <div className="cb-collapse-bottom">{collapseToggle}</div>}
    </div>
  );
};

const HistoryUserEntry = memo(({
  entry,
  tabId,
  toolType,
  allowRewind,
  rewindLocked,
  rewindUnavailableReason,
  allowHistoryRewriteRewind,
  historyRewriteRewindLocked,
  historyRewriteRewindUnavailableReason,
  onHistoryRewriteRewind,
  forceExpanded,
  onDismissPromptPresentation,
}: {
  entry: FullHistoryEntry;
  tabId: string;
  toolType?: 'claude' | 'gemini' | 'codex';
  allowRewind: boolean;
  rewindLocked: boolean;
  rewindUnavailableReason?: string | null;
  allowHistoryRewriteRewind: boolean;
  historyRewriteRewindLocked: boolean;
  historyRewriteRewindUnavailableReason?: string | null;
  onHistoryRewriteRewind?: (entry: FullHistoryEntry) => void;
  forceExpanded?: boolean;
  onDismissPromptPresentation?: (entry: FullHistoryEntry) => void;
}) => {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editableLastPrompt = entry.deliveryStatus === 'editable-last-prompt';
  const instructionAttachment = useMemo(
    () => historyInstructionAttachment(entry.content, toolType),
    [entry.content, toolType],
  );
  const canRewind = allowRewind && !rewindLocked && !instructionAttachment;
  const canHistoryRewriteRewind = allowHistoryRewriteRewind
    && !historyRewriteRewindLocked
    && !instructionAttachment
    && !!onHistoryRewriteRewind;
  const queueStatus = entry.queueStatus;
  // Exact delivery can be confirmed while the expensive durable History
  // refresh is still deferred by a busy turn. SENT is brief feedback, not a
  // second lifecycle gate; derive its deadline from the stored transition so
  // scrolling/remounting cannot restart the success animation.
  const sentStatusChangedAt = queueStatus === 'sent' && Number.isFinite(entry.statusChangedAt)
    ? Number(entry.statusChangedAt)
    : null;
  const sentStatusExpiresAt = sentStatusChangedAt === null
    ? null
    : sentStatusChangedAt + HISTORY_PROMPT_SENT_PRESENTATION_MS;
  const [statusPresentationNow, setStatusPresentationNow] = useState(() => Date.now());
  const statusPresentationAt = Math.max(statusPresentationNow, Date.now());
  const queueStatusPresentation = historyPromptHandoffStatusPresentation(queueStatus, {
    statusChangedAt: sentStatusChangedAt ?? undefined,
    now: statusPresentationAt,
  });
  const canDismissPromptPresentation = isLocalPromptEntry(entry)
    && !!entry.handoffId
    && queueStatus !== 'sent'
    && !!onDismissPromptPresentation;
  const promptPresentation = useMemo(() => buildHistoryComposerPresentationParts({
    text: entry.content,
    chips: entry.promptChips,
    imagePaths: entry.imagePaths,
  }), [entry.content, entry.imagePaths, entry.promptChips]);
  const detachedPrompts = useMemo(() => (
    forceExpanded
      ? { promptParts: [] as HistoryPromptPresentationPart[], bodyParts: promptPresentation.parts as Array<any> }
      : splitLeadingHistoryPromptParts(promptPresentation.parts as Array<any>)
  ), [forceExpanded, promptPresentation.parts]);
  const hasDetachedPromptBand = detachedPrompts.promptParts.length > 0;
  const chipOnly = useMemo(() => (
    !forceExpanded && historyUserPromptIsChipOnly({
      text: entry.content,
      promptChips: entry.promptChips,
      imagePaths: entry.imagePaths,
      toolType,
    })
  ), [entry.content, entry.imagePaths, entry.promptChips, forceExpanded, toolType]);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  useEffect(() => {
    if (sentStatusExpiresAt === null) return;
    const remainingMs = sentStatusExpiresAt - Date.now();
    if (remainingMs <= 0) return;
    const timer = setTimeout(() => {
      setStatusPresentationNow(Date.now());
    }, remainingMs + 16);
    return () => clearTimeout(timer);
  }, [sentStatusExpiresAt]);

  const stopActionPropagation = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  const copyPrompt = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const copiedMessage = buildHistoryMessageClipboardPayload({
      text: entry.content,
      chips: entry.promptChips,
      imagePaths: entry.imagePaths,
    });
    const clipboardResult = writeElectronComposerSnapshotClipboard(copiedMessage);
    setCopied(clipboardResult.textCopied);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    if (clipboardResult.textCopied) {
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, 900);
    }
    historyDiag('PROMPT_ACTION tab=' + tabId.slice(-12) +
      ' action=copy' +
      ' entry=' + entry.uuid.slice(0, 8) +
      ' chars=' + copiedMessage.text.length +
      ' chips=' + copiedMessage.snapshot.chips.length +
      ' images=' + copiedMessage.snapshot.imagePaths.length +
      ' textCopied=' + (clipboardResult.textCopied ? '1' : '0') +
      ' snapshotCopied=' + (clipboardResult.snapshotCopied ? '1' : '0'));
    if (!clipboardResult.textCopied) {
      useUIStore.getState().showToast('Не удалось скопировать сообщение', 'error', 2200);
    } else if (!clipboardResult.snapshotCopied) {
      useUIStore.getState().showToast(
        'Скопирован только текст — структуру вложений сохранить не удалось',
        'warning',
        2600,
      );
    } else {
      useUIStore.getState().showToast('Сообщение и вложения скопированы', 'success', 1200);
    }
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

  const requestHistoryRewriteRewind = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canHistoryRewriteRewind) return;
    historyDiag('PROMPT_ACTION tab=' + tabId.slice(-12) +
      ' action=history-rewrite-rewind-request' +
      ' entry=' + entry.uuid.slice(0, 8) +
      ' chips=' + (entry.promptChips?.length || 0) +
      ' images=' + (entry.imagePaths?.length || 0));
    onHistoryRewriteRewind?.(entry);
  };

  const dismissPromptPresentation = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (canDismissPromptPresentation) onDismissPromptPresentation?.(entry);
  };

  return (
    <ConversationMessage
      layout="user"
      entryUuid={entry.uuid}
      emphasis={editableLastPrompt ? 'editable' : 'none'}
      title={editableLastPrompt ? 'Editable last prompt' : undefined}
      contentClassName={chipOnly ? 'hp-history-user-bubble--single-chip' : undefined}
      status={hasDetachedPromptBand ? (
        <HistoryUserPromptBand parts={detachedPrompts.promptParts} />
      ) : undefined}
      footer={queueStatusPresentation ? (
        <span className="hp-user-message-status">
          {canDismissPromptPresentation && (
            <Tooltip content="Скрыть эту карточку">
              <button
                type="button"
                className="hp-user-message-status-dismiss"
                aria-label="Скрыть статусную карточку сообщения"
                onMouseDown={stopActionPropagation}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={dismissPromptPresentation}
              >
                <X size={10} />
              </button>
            </Tooltip>
          )}
          <MessageStatusBadge
            label={queueStatusPresentation.label}
            tone={queueStatusPresentation.tone}
            pending={queueStatusPresentation.pending}
            title={queueStatusPresentation.title}
            meta={entry.timestamp
              ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : undefined}
          />
        </span>
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
          {!instructionAttachment && (allowRewind || allowHistoryRewriteRewind) && (
            <span
              data-history-rewind-action-stack
              style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}
            >
              {allowRewind && (
                <Tooltip content={rewindUnavailableReason || (rewindLocked ? 'Rewind уже выполняется' : 'Откатиться через native Rewind агента')}>
                  <MessageActionButton
                    tone="warning"
                    aria-label="Rewind to prompt"
                    data-testid="history-rewind-native"
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
              {allowHistoryRewriteRewind && (
                <Tooltip content={historyRewriteRewindUnavailableReason || 'Обрезать сохранённую JSONL-историю и вернуть этот prompt в input'}>
                  <MessageActionButton
                    aria-label="Rewrite saved history to prompt"
                    data-testid="history-rewind-jsonl"
                    disabled={!canHistoryRewriteRewind}
                    onMouseDown={stopActionPropagation}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={requestHistoryRewriteRewind}
                    style={{
                      color: canHistoryRewriteRewind ? '#a78bfa' : '#52525b',
                    }}
                  >
                    {historyRewriteRewindLocked ? <Loader2 size={11} className="animate-spin" /> : <Scissors size={11} />}
                  </MessageActionButton>
                </Tooltip>
              )}
            </span>
          )}
        </MessageActionRail>
      )}
    >
      <HistoryUserPromptContent
        text={entry.content}
        promptChips={entry.promptChips}
        imagePaths={entry.imagePaths}
        toolType={toolType}
        forceExpanded={forceExpanded}
        presentationParts={hasDetachedPromptBand ? detachedPrompts.bodyParts : undefined}
      />
    </ConversationMessage>
  );
});

const HistoryAssistantEntry = memo(({
  entry,
}: {
  entry: FullHistoryEntry;
}) => {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveBackgroundUuids = React.useContext(HistoryBackgroundLiveContext);
  const liveBackgroundTaskCalls = React.useContext(HistoryBackgroundTaskCallContext);
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const hasAssistantContent = !!entry.content;
  const hasAssistantActions = !!entry.actions?.length;
  const completedResponseTiming = useMemo(
    () => resolveHistoryResponseTailTiming(null, [entry]) as HistoryResponseTailTiming | null,
    [entry],
  );
  const isStandaloneToolRow = !hasAssistantContent
    && ((hasAssistantActions && !entry.thinking)
      // A thinking-only row is service chrome exactly like a tool-only row:
      // without this it kept the fat text-row padding ABOVE while the row
      // below sat at tool spacing — the «отступ сверху больше, чем снизу»
      // asymmetry on the screenshot.
      || (!hasAssistantActions && !!entry.thinking));
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
      footer={completedResponseTiming ? (
        <HistoryResponseTailTimer timing={completedResponseTiming} placement="entry" />
      ) : undefined}
      className={isStandaloneToolRow ? 'hp-assistant-tool-only' : undefined}
    >
      {entry.thinking && <HistoryThinkBlock text={entry.thinking} payloadRef={entry.thinkingRef} seconds={(entry as any).thinkingSeconds} />}

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
          const presentation = historyActionPresentationMeta({
            toolName,
            args: action.rawTool.args || {},
            family: action.rawTool.family,
            bashWord: action.rawTool.bashWord,
            bashDetail: action.rawTool.bashDetail,
            mcpServer: action.rawTool.mcpServer,
            mcpMethod: action.rawTool.mcpMethod,
          });
          return (
            <div key={'raw' + index + ':' + toolName}>
              <HistoryToolCallPart
                toolName={toolName}
                args={action.rawTool.args || {}}
                result={historyResult}
                resultRef={action.rawTool.resultRef}
                isError={action.rawTool.isError}
                diffHunks={action.rawTool.diffHunks}
                family={action.rawTool.family}
                bashWord={action.rawTool.bashWord}
                bashDetail={action.rawTool.bashDetail}
                mcpServer={action.rawTool.mcpServer}
                mcpMethod={action.rawTool.mcpMethod}
                docsKind={presentation.docsKind}
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
        if (isTaskAction(action)) {
          return (
            <SubAgentBlock
              key={'task' + index}
              action={action}
              entryUuid={entry.uuid}
              live={liveBackgroundTaskCalls.has(historySubagentCallIdentity(action.toolUseId))}
            />
          );
        }
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

    </ConversationMessage>
  );
});

/**
 * A slash command the USER typed (`/model`, `/effort`, `/rewind`).
 *
 * Not a message: nothing was said to the model, a switch was flipped. So it
 * is neither a right-side bubble (that column means "the user spoke") nor a
 * coloured/filled block (colour in this feed means STATE, and a filled
 * background is far too heavy for a one-word setting — user's own read). It
 * is a service line, exactly like a tool row: left side, one line, quiet
 * grey, small glyph. Previously these fell through to the assistant branch
 * and rendered as bare left-aligned text that looked like a torn-off message.
 */
/**
 * Status titles arrive as legacy ALL-CAPS constants («LOADING CODEX
 * SESSION...»). The feed speaks sentence case everywhere (one type voice —
 * user decision), so the chip presents them as a sentence; the constants stay
 * untouched because tests and logs match on them.
 */
const presentStatusTitle = (title: string): string => {
  const text = String(title || '');
  if (!/[A-Z]/.test(text) || text !== text.toUpperCase()) return text;
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

const HistorySlashRow = memo(({ entry }: { entry: FullHistoryEntry }) => (
  <ConversationMessage layout="block" entryUuid={entry.uuid} className="hp-assistant-tool-only">
    <div className="hp-history-slash">
      <SlidersHorizontal size={12} className="hp-history-slash-ic" />
      <span className="hp-history-slash-cmd">{entry.content}</span>
    </div>
  </ConversationMessage>
));

const HistoryInterruptedRow = memo(({ entry }: { entry: FullHistoryEntry }) => (
  <ConversationMessage layout="block" entryUuid={entry.uuid} className="hp-assistant-tool-only">
    <div className="hp-history-slash hp-history-interrupted">
      <SlidersHorizontal size={12} className="hp-history-slash-ic hp-history-interrupted-ic" />
      <span className="hp-history-slash-cmd">{entry.content}</span>
    </div>
  </ConversationMessage>
));

const HistoryGoalRow = memo(({ entry }: { entry: FullHistoryEntry }) => (
  <ConversationMessage layout="block" entryUuid={entry.uuid} className="hp-assistant-tool-only">
    <div className="hp-history-slash hp-history-goal">
      <Target size={12} className="hp-history-slash-ic hp-history-goal-ic" />
      <span className="hp-history-slash-cmd">{entry.content}</span>
    </div>
  </ConversationMessage>
));

// Single history entry renderer
const HistoryEntry = memo(({
  entry,
  tabId,
  toolType,
  allowRewind,
  rewindLocked,
  rewindUnavailableReason,
  allowHistoryRewriteRewind,
  historyRewriteRewindLocked,
  historyRewriteRewindUnavailableReason,
  onHistoryRewriteRewind,
  forceExpanded,
  onDismissRewindPresentation,
  onDismissPromptPresentation,
}: {
  entry: FullHistoryEntry;
  tabId: string;
  toolType?: 'claude' | 'gemini' | 'codex';
  allowRewind: boolean;
  rewindLocked: boolean;
  rewindUnavailableReason?: string | null;
  allowHistoryRewriteRewind: boolean;
  historyRewriteRewindLocked: boolean;
  historyRewriteRewindUnavailableReason?: string | null;
  onHistoryRewriteRewind?: (entry: FullHistoryEntry) => void;
  forceExpanded?: boolean;
  onDismissRewindPresentation?: (entry: FullHistoryEntry) => void;
  onDismissPromptPresentation?: (entry: FullHistoryEntry) => void;
}) => {
  if (entry.role === 'compact') {
    return <CompactBlock entry={entry} />;
  }

  if (entry.role === 'compact-error') {
    return <HistoryInterruptedRow entry={entry} />;
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
        toolType={toolType}
        allowRewind={false}
        rewindLocked={rewindLocked}
        rewindUnavailableReason={rewindUnavailableReason}
        allowHistoryRewriteRewind={false}
        historyRewriteRewindLocked={historyRewriteRewindLocked}
        historyRewriteRewindUnavailableReason={historyRewriteRewindUnavailableReason}
        forceExpanded={forceExpanded}
        onDismissPromptPresentation={onDismissPromptPresentation}
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
        actions={failed && entry.uuid.startsWith(LOCAL_REWIND_PREFIX)
          && onDismissRewindPresentation ? (
            <MessageActionButton
              tone="danger"
              data-history-rewind-dismiss="1"
              aria-label="Dismiss Rewind error"
              title="Dismiss"
              onClick={(event) => {
                event.stopPropagation();
                onDismissRewindPresentation(entry);
              }}
            >
              <X size={13} aria-hidden />
            </MessageActionButton>
          ) : undefined}
        meta={entry.timestamp
          ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : undefined}
      >
        {renderSentHistoryPromptHighlight(entry.content)}
      </MessageEvent>
    );
  }

  if (entry.role === 'slash') {
    return <HistorySlashRow entry={entry} />;
  }

  if (entry.role === 'interrupted') {
    return <HistoryInterruptedRow entry={entry} />;
  }

  if (entry.role === 'goal') {
    return <HistoryGoalRow entry={entry} />;
  }

  if (entry.role === 'user') {
    return (
      <HistoryUserEntry
        entry={entry}
        tabId={tabId}
        toolType={toolType}
        allowRewind={allowRewind}
        rewindLocked={rewindLocked}
        rewindUnavailableReason={rewindUnavailableReason}
        allowHistoryRewriteRewind={allowHistoryRewriteRewind}
        historyRewriteRewindLocked={historyRewriteRewindLocked}
        historyRewriteRewindUnavailableReason={historyRewriteRewindUnavailableReason}
        onHistoryRewriteRewind={onHistoryRewriteRewind}
        forceExpanded={forceExpanded}
        onDismissPromptPresentation={onDismissPromptPresentation}
      />
    );
  }

  return <HistoryAssistantEntry entry={entry} />;
});

// The feed's quietest voice — service text, as opposed to content.
//
// One number, used by BOTH the CSS below (`.hp-history-group-detail`, the «└ …»
// line under a collapsed group header) and by the inline-styled status chip on
// the composer's border. They are the same kind of text — a caption ABOUT
// something rather than the something — so they must not be sized separately;
// picking a number for one of them by eye is how the chip twice ended up as loud
// as the chat text itself.
const HISTORY_SERVICE_TEXT_RATIO = 0.82;
// …and its WEIGHT. The reference line sets none, i.e. it inherits the feed's
// ordinary text weight — a caption is quieter than what it annotates, so it has
// nothing to be emphatic about. Written out as a number rather than left to
// inheritance because the chip is styled inline and would otherwise pick up
// whatever weight its own container happens to carry.
//
// Half-bold (650) here was the second half of the same mistake as the font size:
// matching «the example» by eye instead of by reference, so the chip shouted at a
// size that was already too close to the content's.
const HISTORY_SERVICE_TEXT_WEIGHT = 400;

// How far the composer's frame stands off the left/right edge of the centre
// surface.
//
// One number for the frame AND for the button pair pinned just above its top
// edge, because the frame's border draws a vertical line the eye uses as a
// ruler: anything sitting above it that stops a few pixels short or long reads
// as broken. It already broke once — the frame kept its own 16 while the
// side-surface toggle carried an independent 12, and the button ended up 4px
// past the line the border drew (user: «по вертикальной границе справа должны
// совпадать… какого хуя он правее»).
const HISTORY_COMPOSER_SIDE_INSET = 16;

// Насколько плашка состояния поднимается ВЫШЕ верхней рамки композера.
//
// Она сидит верхом на линии (`bottom: 0` + `translateY(50%)`), то есть ровно
// половина её высоты уходит наружу, вверх. Полоса промптов стоит в том же слое
// над ней и, чтобы не наложиться, обязана подняться как минимум на эту половину.
//
// Считается, а НЕ задаётся числом: высота плашки — это её кегль (доля от шрифта
// транскрипта) на межстрочном 1.35, то есть она растёт вместе с настройкой
// размера шрифта у пользователя. Константа 8px, посчитанная для 13px, ломалась
// ровно так же, как когда-то кнопки «свернуть» на рамке сообщения: при 20px
// полоса промптов уже наезжала на плашку. Проверено измерением на 10/13/16/20/24.
const historyComposerStatusRise = (transcriptFontSize: number) =>
  Math.ceil(transcriptFontSize * HISTORY_SERVICE_TEXT_RATIO * 1.35 / 2);

// Flash/search/component styles. Keep the existing node across HMR, but refresh
// its contents: an "inject once" guard leaves stale CSS in a live dev renderer.
const historyPanelStyleText = `@keyframes hp-flash {
  0%   { background-color: transparent; }
  20%  { background-color: rgba(91, 156, 245, 0.2); }
  100% { background-color: transparent; }
}
@keyframes hp-history-working-shimmer {
  from { background-position: 100% 50%; }
  to { background-position: 0% 50%; }
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
/* Точка «идёт работа» обходит периметр кнопки. Путь тот же, что рисует рамку
   иконки, поэтому точка идёт ровно по её краю, а не по вписанному кругу. */
@keyframes hp-terminal-perimeter-travel {
  from { offset-distance: 0%; }
  to { offset-distance: 100%; }
}
.hp-terminal-perimeter-loader-dot {
  offset-path: path("M10 3 H16 Q18 3 18 5 V15 Q18 17 16 17 H4 Q2 17 2 15 V5 Q2 3 4 3 H10 Z");
  /* Точка круглая — поворачивать её вдоль пути не нужно, а без этого правила
     браузер доворачивал бы её и на субпиксельных размерах давал дрожание. */
  offset-rotate: 0deg;
  animation: hp-terminal-perimeter-travel 1.45s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  /* Точка, бегущая по периметру кнопки, здесь НЕ гасится намеренно.
     Её движение — это сам сигнал «идёт работа», а не украшение: раньше под
     системной настройкой «Уменьшать движение» она замирала, и кнопка выглядела
     одинаково в работе и в покое. Настройка просит убрать избыточное движение,
     а не единственный индикатор состояния (у пользователя она включена, и
     лоадер из-за этого стоял на месте — 2026-08-18).
     Гасится только то, что действительно декоративно: вращение при передаче
     поверхности и перелив подписи. */
  .hp-owner-transition-spin {
    animation: none;
  }
  .hp-history-response-tail[data-state="running"] .hp-history-response-tail-label {
    animation: none;
    background: none;
    color: #96938d;
    -webkit-text-fill-color: currentColor;
  }
}
/* Подсветка кнопки состояния под курсором.
   Решает БРАУЗЕР, а не наше состояние в памяти. Причина — замерено: когда узел
   кнопки удаляют из документа прямо под курсором (перестроение разметки: смена
   владельца истории, вход/выход из сплита, Ctrl+Tab), события «курсор ушёл» не
   приходит вовсе — уходить уже неоткуда. Наш флаг оставался поднятым, и кнопка
   продолжала показывать «остановить» на уже другой вкладке, пока пользователь
   не наведётся на неё ещё раз и не уведёт курсор.
   У :hover этой болезни нет по устройству: это не запомненный факт, а ответ
   на вопрос «курсор над этим узлом сейчас», и у нового узла он вычисляется
   заново. */
[data-agent-status-row][data-agent-status-action='stop']:hover {
  background-color: rgba(220, 38, 38, 0.20);
}
[data-agent-status-row][data-agent-status-action='start']:hover {
  background-color: rgba(255, 255, 255, 0.08);
}
/* Значки: под курсором показываем действие, иначе — состояние. Оба нарисованы
   всегда, видимостью управляет тот же :hover. Так «что случится по клику»
   и «что происходит сейчас» не могут разойтись во времени. */
[data-agent-status-row] > [data-agent-status-hover-glyph] { display: none; }
[data-agent-status-row] > [data-agent-status-idle-glyph] { display: block; }
[data-agent-status-row]:hover > [data-agent-status-hover-glyph] { display: block; }
/* Значок состояния прячется, только если под курсором есть чем его заменить.
   Пока действие не определено (состояние ещё выясняется), значка действия нет
   вовсе — и без этого условия кнопка стала бы под курсором ПУСТОЙ. */
[data-agent-status-row][data-agent-status-action='stop']:hover > [data-agent-status-idle-glyph],
[data-agent-status-row][data-agent-status-action='start']:hover > [data-agent-status-idle-glyph] {
  display: none;
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
.hp-user-message-status {
  --hp-user-message-status-height: 20px;
  /* Delivery status is a temporary annotation of the prompt, not a second
     History row. The next live/loader slot already owns the visual space
     below a just-sent prompt, so keeping this in flex flow made the feed grow
     and then shrink once the durable record arrived. Anchor it to the user
     column instead: it stays directly below the bubble without changing the
     measured height of this Virtuoso item. */
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  margin-top: 0;
  margin-bottom: 0;
  white-space: nowrap;
}
.hp-user-message-status > .cb-message-status {
  height: var(--hp-user-message-status-height);
  min-height: var(--hp-user-message-status-height);
  margin-bottom: 0;
  box-sizing: border-box;
}
.hp-user-message-status-dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--hp-user-message-status-height);
  height: var(--hp-user-message-status-height);
  padding: 0;
  border: 1px solid rgba(245, 158, 11, 0.45);
  border-radius: 6px;
  background: rgba(245, 158, 11, 0.08);
  color: #d6a24a;
  cursor: pointer;
  flex: 0 0 var(--hp-user-message-status-height);
  align-self: center;
  line-height: 0;
  vertical-align: middle;
}
.hp-user-message-status-dismiss > svg {
  display: block;
  margin: 0;
}
.hp-user-message-status-dismiss:hover {
  border-color: rgba(245, 158, 11, 0.8);
  background: rgba(245, 158, 11, 0.16);
  color: #f0b95b;
}
.hp-history-user-prompt-band {
  display: flex;
  flex-direction: row-reverse;
  flex-wrap: wrap;
  align-items: center;
  /* In row-reverse, flex-start is the physical RIGHT edge. Prompt ancestry
     therefore grows right→left and wraps back onto the same right boundary. */
  justify-content: flex-start;
  gap: 6px;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  overflow-x: clip;
  margin-bottom: 4px;
  white-space: normal;
}
.hp-history-user-prompt-chip-slot {
  display: inline-flex;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  vertical-align: middle;
}
.hp-history-user-prompt-chip-slot .cb-composer-chip {
  min-width: 0;
  max-width: min(240px, 100%);
}
.hp-history-user-prompt-chip-slot .cb-composer-chip-hit,
.hp-history-user-prompt-chip-slot .cb-composer-chip-content {
  min-width: 0;
  max-width: 100%;
}
.hp-history-user-prompt-chip-slot .cb-composer-chip-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
/* The transcript's own scrollbar. Without this it falls through to the app's
   global 8px bar with an opaque #1a1a1a track — a heavy grey column pinned to
   the right edge of the reading surface, next to the composer, on the one
   surface where the eye is following text. Same 5px ghost bar the SDK chat and
   the prompt fields already use, so the reading surfaces agree.
   Both properties are needed: scrollbar-width is what Firefox and newer
   Chromium honour, the ::-webkit rules are what this Electron build actually
   paints. (No backticks in this block — it lives inside a JS template
   literal, and one would end the string mid-comment.) */
.hp-history-transcript {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.10) transparent;
}
/* After fast seek, real cards mount invisibly so Virtuoso can accept their
   actual heights before text is shown. The previous path exposed text as soon
   as DOM existed, then let two scroll writers move it for another 200ms. */
.hp-history-transcript[data-history-seek-geometry-settling="1"] [data-history-row-real] {
  visibility: hidden;
}
/* Ordinary readable scrolling keeps real rows visible. During the bounded
   estimate -> measured handoff, a compositor-only offset holds the semantic
   frame while Virtuoso updates its physical size tree underneath. */
.hp-history-transcript[data-history-geometry-bridge="1"] [data-testid="virtuoso-item-list"] {
  translate: 0 var(--hp-history-geometry-bridge-y, 0px);
  will-change: translate;
}
.hp-history-transcript::-webkit-scrollbar {
  width: 5px;
  height: 5px;
}
.hp-history-transcript::-webkit-scrollbar-track {
  background: transparent;
}
.hp-history-transcript::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.10);
  border-radius: 999px;
  transition: background 0.15s ease;
}
/* Brightens when the pointer is anywhere over the transcript, so the position
   indicator is findable while reading without being a permanent stripe. */
.hp-history-transcript:hover::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.22);
}
.hp-history-transcript::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.34);
}
/* Virtuoso's real-row wrapper already contributes 4px above and below every
   root entry. The package's chat layout added another 6px to user rows, so a
   prompt paid for two independent gaps (10px per side) before the bubble's
   own internal padding even began. History removes only that duplicate
   vertical layer; the 12px horizontal alignment and the bubble's 8px content
   padding stay. Status plates above the bubble and embedded prompt chips then
   use the same outer rhythm as a plain prompt. */
.hp-history-transcript .cb-row-user {
  padding-top: 0;
  padding-bottom: 0;
}
/* Prompt/paste/image/instructions chips are already bordered cards. A row made
   only from one or several chips needs no second orange container; mixed
   content keeps the orange bubble around the user's actual text. */
.hp-history-transcript .cb-user-bubble.hp-history-user-bubble--single-chip {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.hp-history-transcript .cb-tool {
  margin-top: 2px;
  margin-bottom: 2px;
}
/* A reasoning row is a service line exactly like a tool row, so it gets the
   same tight rhythm. Its package default (12px above and below, sized for a
   chat bubble) survived here and made every «thinking · 39s» a 30px hole in
   an otherwise dense feed — three of them in a row read as three separate
   sections of nothing. */
.hp-history-transcript .cb-think {
  margin-top: 2px;
  margin-bottom: 2px;
}
/* Action rows are service lines under the prose, not competing blocks: one
   compact line (~22px), secondary type size, tight paddings. The expanded
   body keeps full size — density applies to the HEADER line only. */
.hp-history-transcript .cb-tool-head {
  padding-top: 2px;
  padding-bottom: 2px;
  font-size: 0.95em;
}
.hp-history-transcript .hp-assistant-tool-only {
  padding-top: 0;
  padding-bottom: 0;
}
.hp-history-nested-transcript {
  min-width: 0;
}
.hp-history-nested-transcript .hp-history-group-foot {
  /* Nested subagent detail uses #111 rather than the primary History canvas. */
  background: #111111;
}
.hp-history-nested-transcript .cb-assistant-meta-row {
  /* A reply-level Copy belongs to the lower-right edge of that reply. Keep it
     in flow so it cannot cover the final line or change measured height. */
  justify-content: flex-end;
}
/* Collapsed group unit: fixed two-line geometry (header + detail line). The
   detail line NEVER disappears on completion — its content changes from the
   live operation to the member digest (owner contract: constant tail
   geometry). */
.hp-history-group {
  /* Root rows have one symmetric rhythm, regardless of whether the row is a
     card, thinking, or a collapsed group. The wrapper gives a group 2px and
     this box gives it 8px on EACH side: 10px total, exactly the same as a
     normal service row (outer 4 + cb-row-block 4 + card margin 2).
     The old 8px above / 2px below made the visible gap Edit→Group 6px larger
     than Group→Thinking — the asymmetry reported on probe-a/b/c. */
  margin: 8px 0;
  border-radius: 4px;
  /* Align the header icon with regular tool-card icons: a card's icon sits at
     12px (.cb-row-block padding; the head's -4px margin and 4px padding
     cancel). The group head has the same -4/+4 pair, so the group's own
     padding must be exactly 12px too — 14px put the glyph 2px right of the
     card icon column (measured live). */
  padding: 0 12px;
}
/* Homogeneous aggregate: the semantic icon (Read/Search/Edit/MCP) is its
   identity, so it is visually lighter than the broad stack chapter. */
.hp-history-group--inner { margin-top: 8px; margin-bottom: 8px; }
.hp-history-group-member > [data-history-group] .hp-history-group--inner {
  margin: 0;
  /* Same content column as an ordinary child card (.cb-row-block: 12px).
     The old 4px put subgroup glyphs 8px LEFT of neighbouring Read/Thinking
     rows, so peers looked like different hierarchy levels before opening. */
  padding-left: 12px;
  padding-right: 12px;
}
.hp-history-group-head {
  /* Block-level flex with an INTEGRAL min-height: a virtualized feed measures
     every row, so a fractional inline-level height makes the whole list
     jitter during scroll. The interactive surface is narrowed to the content
     by the inner box below, not by making this one inline. */
  display: flex;
  align-items: center;
  min-height: 22px;
  border-radius: 4px;
  user-select: none;
}
.hp-history-group-head-inner {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  padding: 2px 4px;
  margin: 0 -4px;
  border-radius: 4px;
  cursor: pointer;
  overflow: hidden;
}
.hp-history-group-head-inner:hover { background: rgba(255, 255, 255, 0.03); }
.hp-history-group-count {
  /* WRAPS instead of hiding: the header lists every family fragment (no «N
     more»), so a long mixed run takes a second line — the same no-truncation
     law as card subjects. Children stay inline so a qualifier may wrap like
     ordinary text instead of turning each fragment into an unbreakable chip. */
  flex-shrink: 1;
  min-width: 0;
  font-size: 0.9em; /* same size as card labels — one type voice per feed */
  overflow-wrap: anywhere;
  line-height: 1.35;
}
.hp-history-group-token { display: inline; }
.hp-history-group-token-label {
  color: #bdbdbd;
  font-weight: 500;
}
.hp-history-group-token-qualifier { color: #e0e0e0; }
.hp-history-group-token-count {
  color: #888;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.hp-history-group-token-count--error {
  color: rgba(248, 113, 113, 0.58);
}
.hp-history-group-thinking-icon {
  display: inline-block;
  vertical-align: -2px;
  color: var(--cb-think, #a78bfa);
}
.hp-history-group-separator { color: #6f6d68; }
/* Documentation colour marks only the ACTION word. The subject/qualifier and
   the "xN" repeat count keep the same neutral hierarchy as every other
   fragment. In particular "MCP knowledge" is not a coloured action word:
   knowledge is the server qualifier, while Read/Search/Edit say what happened
   to docs. (No backticks in here: this CSS is a JS template string, and one
   stray backtick closes it — the known empty-window scar.) */
.hp-history-group-token--docs-search .hp-history-group-token-label { color: #bef264; }
.hp-history-group-token--docs-edit .hp-history-group-token-label { color: #34d399; }
/* Automatically injected project instructions are attached context, not a
   sentence the user typed. They reuse the purple saved-prompt chip and the
   same full-text popover; only the leading provider mark adds provenance. */
.hp-history-instruction-attachment { display: block; white-space: normal; }
.hp-history-instruction-chip { max-width: min(320px, 100%); }
.hp-history-instruction-provider {
  display: block;
  flex: 0 0 auto;
}
.hp-history-instruction-provider--codex { color: #10a37f; }
.hp-history-instruction-provider--claude { color: #da7756; }
/* Sent prompt/paste/image attachments share the exact ComposerChip hover
   grammar. Image thumbnails are kept inside the same 22px row height. */
.hp-history-attachment-chip { vertical-align: middle; }
.hp-history-attachment-chip .cm-composer-token-thumbnail {
  width: 16px;
  height: 16px;
  flex-basis: 16px;
}
.hp-history-attachment-chip .cm-composer-token-thumbnail-fallback {
  width: 13px;
  height: 13px;
}
/* User's own slash command: a service line, same rhythm and voice as a tool
   row — never a chat bubble and never a filled block. */
.hp-history-slash {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
  /* NO horizontal padding: the row wrapper (.cb-row-block) already insets by
     12px, so adding 12 more pushed this row a step right of every other row
     and it read as a child of something — while it has no parent (user).
     Its glyph must sit on the same vertical line as every other row's glyph. */
  padding: 0;
  color: #8f8d88;
  font-size: 0.9em;
}
.hp-history-slash-ic { flex-shrink: 0; color: #6f6d68; }
.hp-history-slash-cmd { overflow-wrap: anywhere; }
/* Provider interruption is service chrome, not a user prompt. It keeps the
   same quiet type/rhythm as /model but uses a dark raspberry channel so the
   boundary is easy to catch without reading as a bright error card. */
.hp-history-interrupted { color: #9f536c; }
.hp-history-interrupted-ic {
  flex: 0 0 auto;
  color: #b04e6d;
}
/* Automatic goal continuation is provider control input, not a user bubble.
   Target keeps the meaning distinct from /model while the muted violet tone
   matches Codex's own goal channel without becoming an alert. */
.hp-history-goal { color: #9275bd; }
.hp-history-goal-ic {
  flex: 0 0 auto;
  color: #a78bfa;
}
/* One response-level timer at the physical History tail. It is an ordinary
   left-aligned History row, not a centred divider: same inset, type size and
   vertical rhythm as Edit/Read. Running owns a muted neutral shimmer;
   completion keeps the identical box and settles to normal History white. */
.hp-history-response-tail {
  min-height: 22px;
  box-sizing: border-box;
  padding: 4px 12px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  color: var(--cb-text, #e0e0e0);
  font-size: 0.9em;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.45;
  user-select: none;
  pointer-events: none;
}
.hp-history-response-tail-label {
  white-space: nowrap;
}
/* Completed timing belongs to the response that produced it. Inside an
   assistant row the outer ConversationMessage already supplies the History
   inset, so repeating the tail's 12px padding would indent the label twice. */
.hp-history-response-tail[data-placement="entry"] {
  min-height: 18px;
  padding: 4px 0 0;
}
.hp-history-response-tail[data-state="running"] .hp-history-response-tail-label {
  color: transparent;
  background-image: linear-gradient(
    90deg,
    #8f8d88 0%,
    #8f8d88 42%,
    #b8b4ac 46%,
    #d3cfc7 50%,
    #b8b4ac 54%,
    #8f8d88 58%,
    #8f8d88 100%
  );
  /* One oversized, non-repeating gradient crosses the label at a constant
     linear rate. The old repeating 260% background used out-of-range
     positions (180% → -80%); its tile seam looked like a sudden extra pass. */
  background-size: 250% 100%;
  background-repeat: no-repeat;
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: hp-history-working-shimmer 1.65s linear infinite;
}
.hp-history-group-detail {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  min-height: 18px;
  padding: 0 4px 0 26px;
  color: #8f8d88;
  /* The reference for every service caption in this panel — see
     HISTORY_SERVICE_TEXT_RATIO. Interpolated rather than written as a literal so
     the composer's status chip, which is styled inline, cannot drift from it. */
  font-size: ${HISTORY_SERVICE_TEXT_RATIO}em;
  /* Full subject list, wrapped — never «file.md, file2.md · 3 more». */
  overflow-wrap: anywhere;
  line-height: 1.4;
}
/* Expanded members: shared left rail marks the group extent; contents are the
   ordinary collapsed cards. Heavy bodies still require each card's own click. */
.hp-history-group-member {
  position: relative;
  border-left: 1px solid rgba(255, 255, 255, 0.10);
  transition: border-left-color 0.12s;
  /* The rail hangs from the CENTER of the group glyph (icon column starts at
     12px, glyph is 14px wide → center 19px), the way a tree's child-line
     descends from its parent icon. A rail in the far-left gutter (tried at
     2px) belongs to nothing; flush against the header pill it reads as a
     border. Members indent one clear step right of it. */
  margin-left: 19px;
  /* 5px keeps the member card's hover pill (inner box bleeds 4px left) from
     touching the rail line. */
  padding-left: 5px;
  /* flow-root = a BFC: the member CONTAINS its card's 12px vertical margins
     instead of letting them collapse out. Without this the border-left only
     spanned the card itself, so the group rail rendered as short segments
     with 24px holes between members (user: «полоска прерывается»). */
  display: flow-root;
}
/* Every visible segment of the rail is the SAME collapse control. The
   transparent button is centred on the 1px border and spans the member's full
   height; it adds no layout width and does not turn the content area into a
   target. Pointer enter marks every currently rendered segment with the same
   group key, so one hover brightens the whole continuous rail rather than the
   30px fragment owned by one virtual row. */
.hp-history-group-rail-control {
  position: absolute;
  left: -7px;
  top: 0;
  bottom: 0;
  width: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  z-index: 1;
  outline: none;
}
.hp-history-group-member:has(> .hp-history-group-rail-control:hover),
.hp-history-group-member:has(> .hp-history-group-rail-control:focus-visible),
.hp-history-subgroup-member:has(> .hp-history-group-rail-control:hover),
.hp-history-subgroup-member:has(> .hp-history-group-rail-control:focus-visible),
.hp-history-group-member[data-history-group-rail-hot="1"],
.hp-history-subgroup-member[data-history-group-rail-hot="1"] {
  border-left-color: rgba(255, 255, 255, 0.42);
}

/* The rail's FOOT: the last stretch of the vertical line, turned into a
   collapse control.
   It costs the block NO extra height — the button is absolutely positioned
   over the rail's own bottom segment, and that segment is hidden underneath
   it (border-bottom-left-radius on the member would bend the line; masking a
   fixed 14px instead keeps the rail's geometry exactly as it was). The glyph
   is the line itself turning upward: the eye already follows this line down,
   so the control appears where the line ENDS rather than as a new element
   somewhere else. */
.hp-history-group-foot {
  position: absolute;
  /* The rail is the member's own 1px left border at x=-1 relative to the
     content box; the 14px hit area is CENTRED on it (-8px), so the chevron's
     two arms have room on both sides and the click target is comfortable
     without the drawing drifting off the line. */
  left: -8px;
  bottom: 0;
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  /* The panel's own ground, so the covered rail segment disappears cleanly
     under the hook instead of showing through it. */
  background: #151515;
  color: rgba(255, 255, 255, 0.28);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.12s;
  z-index: 2;
}
.hp-history-group-foot:hover,
.hp-history-group-foot:focus-visible,
[data-history-group-rail-hot="1"] > .hp-history-group-foot { color: #b8b6b1; }
/* A SINGLE-family group already names the family in its header (Git ×3,
   Read ×3), so repeating that same word on every member doubles it
   (user feedback). A MIXED group is the opposite case: the verb is the only
   thing telling one member from the next, so it stays. */
.hp-history-group-member[data-history-group-uniform="1"] > .cb-row .cb-tool-label { display: none; }
/* Rhythm INSIDE a container is tighter than the rhythm BETWEEN containers.
   A group is one thing the eye takes in at once — its members are a list, not
   a sequence of separate steps — so they tile without any air of their own
   and the only vertical space left is the hover pill's own padding (4px), the
   part that must stay because it is the clickable surface.
   Before this the space between two members was built from three layers at
   once — the card's own 2px margin, the head's 2px padding and the pill's 4px
   — i.e. 16px between neighbours, which made a 19-file group read as 19
   separate events (user, comparing with Codex: «внутри группы значительно
   меньше»). Groups themselves keep their margins: separating chapters of work
   is exactly what that air is for. */
.hp-history-group-member .cb-tool { margin-top: 0; margin-bottom: 0; }
.hp-history-group-member .cb-tool-head { padding-top: 0; padding-bottom: 0; }
/* The one exception: a member that is OPEN has a body, and a body pressed
   flush against the next row's header would read as belonging to that row.
   Air returns for that row only, and only while it is open. */
.hp-history-group-member .cb-tool:has(> .cb-tool-body) { margin-bottom: 8px; }
/* A reasoning row inside a group is a member like any other. */
.hp-history-group-member .cb-think { margin-top: 0; margin-bottom: 0; }
/* Third level: ordinary tool CARDS below one homogeneous aggregate. The list
   remains flat in Virtuoso; this nested rail is presentation only. The group
   header summarises the series, while every child keeps its own Read/Search/
   MCP header and starts COLLAPSED. Its body belongs to the child's own click,
   never to expanding the parent group. */
.hp-history-subgroup-member {
  position: relative;
  border-left: 1px solid rgba(255, 255, 255, 0.10);
  transition: border-left-color 0.12s;
  margin-left: 19px;
  padding-left: 5px;
  display: flow-root;
}
.hp-history-subgroup-member .cb-tool { margin-top: 0; margin-bottom: 0; }
.hp-history-subgroup-member .cb-tool-head { padding-top: 0; padding-bottom: 0; }
.hp-history-subgroup-member .cb-tool:has(> .cb-tool-body) { margin-bottom: 8px; }
.hp-history-subgroup-member .cb-tool-body { padding-top: 0; }
.hp-history-subgroup-member .cb-think { margin-top: 0; margin-bottom: 0; }
/* A direct homogeneous aggregate at the root uses the same rail geometry as
   one nested under a broad block. */
.hp-history-subgroup-member--root { margin-left: 19px; }

/* Documentation is an action attribute, not a new status. Running/error keep
   their status colours; completed icons inherit Timeline's two docs channels. */
.hp-tool-scroll-scope[data-history-docs-kind="search"] .cb-tool-ic.cb-c-done,
.hp-history-group[data-history-docs-kind="search"] > .hp-history-group-head .cb-tool-ic.cb-c-done {
  color: #bef264;
}
.hp-tool-scroll-scope[data-history-docs-kind="search"] .cb-tool-label {
  color: #bef264;
}
.hp-tool-scroll-scope[data-history-docs-kind="edit"] .cb-tool-ic.cb-c-done,
.hp-history-group[data-history-docs-kind="edit"] > .hp-history-group-head .cb-tool-ic.cb-c-done {
  /* Distinct from generic completed-action green (#4ade80). */
  color: #34d399;
}
.hp-tool-scroll-scope[data-history-docs-kind="edit"] .cb-tool-label {
  color: #34d399;
}
/* No open/close animation, by decision (16.08): rows in the virtualized list
   change height in one frame, and the toggle handlers compensate scrollTop in
   that same frame so the clicked row never moves. Any animated variant either
   fought the remeasure (jitter) or fought the compensation. */
.hp-history-composer-frame {
  border-color: #333;
  background: #0f0f0f;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.38);
  transition: none;
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
/* Inline blobs inside the History editor use the GT token shape, while saved
   prompts use ComposerChip. Give paste/image the same brightness hover and
   remove the old disclosure triangle: the preview can clamp above or below
   and the sideways arrow did not describe that gesture. */
.hp-history-composer-frame .cm-composer-token {
  transition: filter 0.12s ease, color 0.12s ease, background-color 0.12s ease;
}
.hp-history-composer-frame .cm-composer-token:hover { filter: brightness(1.15); }
.hp-history-composer-frame .cm-composer-token-arrow { display: none; }
.hp-history-composer-toolbar {
  display: flex;
  align-items: center;
  /* Не переносится. Строка живёт в слоте фиксированной высоты (24px), поэтому
     перенесённая часть просто уехала бы за границу и стала невидимой — хуже,
     чем сжатая. Всё, что здесь может расти в ширину (статус, предупреждения,
     панель управления), само сокращается: у панели для этого есть отдельное
     правило гашения показаний. */
  flex-wrap: nowrap;
  gap: 5px;
  min-width: 0;
  width: 100%;
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
/* Полоса промптов над рамкой — единственное место, где чип стоит НА линии, а не
   в строке. Здесь всё внутри чипа обязано быть не выше 14px: он не тянет за
   собой раскладку, но, распухнув, наедет на плашку состояния над ним. В обычной
   строке эти же кнопки остаются 18px. */
[data-history-composer-prompt-band] .cb-composer-chip {
  padding: 1px 6px;
  /* Непрозрачная подложка под чипом.
     Слой над рамкой сам по себе прозрачный, а под ним идёт переписка — и
     собственный фон чипа (13% плотности) её не закрывал: замерено, сквозь чип
     просвечивало 87% того, что под ним, и на светлой строке текста подпись
     чипа падала до контраста 1.28 (нечитаемо) вместо 9.45.
     Слой берётся от рамки ввода тем же токеном, что и плашка состояния рядом:
     фон рамки поменяется — подложка поедет за ним, без второй правки. Свой
     цвет чипа ложится СВЕРХУ этой подложки, поэтому оттенок сохраняется.
     Верхний слой записан заливкой в один цвет, а не вторым цветом через
     запятую: в сокращённой записи фона несколько слоёв — это только
     изображения, цвет допустим лишь последним, и запись с двумя цветами
     браузер отбрасывает ЦЕЛИКОМ (поймано замером: чип остался прозрачным). */
  background-color: var(--cb-composer-bg, #0f0f0f);
  background-image: linear-gradient(
    var(--cb-composer-chip-prompt-bg),
    var(--cb-composer-chip-prompt-bg)
  );
}
[data-history-composer-prompt-band] .hp-composer-chip-action {
  width: 14px;
  height: 14px;
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

// Состояние АГЕНТА, и только оно: цвет рамки — статус, маленькая оранжевая
// точка внутри периметра — «занят». Про раскладку эта иконка не знает ничего.
//
// У неё было два свойства от раскладки, и оба оказались багами. `active` давал
// свечение, когда открыта боковая панель, — тень менялась от действия, которое
// этой кнопке не принадлежит (выдвижением управляет своя кнопка в рейле).
// `surface` менял рисунок при реверсе — та же кнопка после смены центральной
// поверхности выглядела другой, хотя про агента ничего не изменилось. Оба свойства
// удалены, чтобы не вернулись: рисунок один — терминальный, потому что кнопка про
// процесс в терминале, а не про то, что сейчас в центре.
function HistoryTerminalActivityIcon({
  size = 19,
  busy = false,
  color,
}: {
  size?: number;
  busy?: boolean;
  color?: string;
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
      }}
    >
      <rect x="1" y="2" width="18" height="16" rx="2" opacity={busy ? 0.32 : 1} />
      <path d="m5 7 2.5 2L5 11" />
      <path d="M10 12h5" />
      {busy && (
        /* A single quiet point owns activity. It travels INSIDE the 20px icon
           instead of drawing a second large loader around the button.
           Движение задано в стилях (offset-path), а не разметкой SVG: у SMIL
           нет состояния покоя — точка без своих координат лежала бы в углу
           системы координат и была бы не видна, если анимация не пошла.
           У пути из стилей начало пути И ЕСТЬ состояние покоя, поэтому
           «анимация не идёт» превращается в «точка стоит на видном месте», а не
           в «индикатора нет вовсе». */
        <circle
          className="hp-terminal-perimeter-loader-dot"
          r="1.1"
          fill="#d97706"
          stroke="none"
          opacity="0.78"
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
  rewindPreviewHiddenTurnCount,
  terminalOpen,
  onToggleTerminal,
  onSwapPrimarySurface,
  terminalIsPrimary = false,
  lifecycleStatus,
  operationalPhase,
  onHeightChange,
  onRuntimeSnapshotChange,
  onInputBusyChange,
  onResponseTimingChange,
  overlayComposer = false,
  agentInputSurface: agentInputSurfaceProp,
  suppressWindowEscape = false,
  suppressWindowEscapeRef,
  interactionDisabled = false,
  compactComposer = false,
}: {
  tabId: string;
  sessionId: string;
  cwd: string;
  projectId?: string;
  toolType: AgentHistoryTool;
  onHistoryRefresh: (reason?: string) => void | Promise<boolean | void>;
  onPromptSubmitted: (
    text: string,
    queueStatus: Extract<HistoryPromptHandoffStatus,
      'preparing' | 'sending' | 'queued' | 'audit-pending' | 'delivery-unknown' | 'sent'>,
    meta: {
      handoffId: string;
      statusAtSend: AgentPtyStatus;
      submittedAt: number;
      promptChips?: HistoryPromptDraftChip[];
      imagePaths?: HistoryPromptDraftImageRef[];
      requiresAuditIdentity?: boolean;
      auditTimestamp?: string;
      auditHash?: string;
      auditSessionId?: string;
      auditEntryUuid?: string;
      sourceIdentity?: string;
      recordByteOffset?: number;
    }
  ) => void;
  onPromptStatusChange: (
    handoffId: string,
    queueStatus: Exclude<HistoryPromptHandoffStatus, 'preparing' | 'sending'>,
    reason: string,
    identity?: {
      requiresAuditIdentity?: boolean;
      auditTimestamp?: string;
      auditHash?: string;
      auditSessionId?: string;
      auditEntryUuid?: string;
      sourceIdentity?: string;
      recordByteOffset?: number;
    },
  ) => void;
  hasDurablePrompt: (
    text: string,
    submittedAt: number,
    identity?: DurablePromptIdentity,
  ) => boolean;
  rewindLocked: boolean;
  rewindPhase?: RewindOperationPhase;
  rewindMessage?: string;
  rewindPreviewActive: boolean;
  rewindPreviewHiddenTurnCount: number;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  onSwapPrimarySurface?: () => void;
  terminalIsPrimary?: boolean;
  lifecycleStatus?: AgentLifecycleSummary | null;
  operationalPhase?: CompactOperationalPhase | null;
  onHeightChange?: (height: number) => void;
  onRuntimeSnapshotChange?: (snapshot: any | null) => void;
  onInputBusyChange?: (busy: boolean) => void;
  onResponseTimingChange?: (snapshot: HistoryResponseActivitySnapshot) => void;
  overlayComposer?: boolean;
  agentInputSurface?: boolean;
  // Split: only the FOCUSED pane's composer listens to window-level Escape.
  suppressWindowEscape?: boolean;
  // Persistent workflow panes update focus through the external presentation
  // channel without re-rendering the whole transcript. Read that ownership at
  // keydown time instead of forcing a History subtree commit on every switch.
  suppressWindowEscapeRef?: React.MutableRefObject<boolean>;
  // Deferred owner handoff keeps the old component mounted for two paint
  // frames. Its portalled composer must be inert too, not only the transcript
  // curtain inside the panel subtree.
  interactionDisabled?: boolean;
  // Pane stacked in a column → short surface, so the input starts at one row.
  compactComposer?: boolean;
}) {
  // Owning the tab's input is not the same as being the centered surface: the
  // terminal-primary layout keeps this composer live in the side panel. Fall
  // back to the centered flag so preview/legacy hosts keep prior behavior.
  const agentInputSurface = agentInputSurfaceProp ?? overlayComposer;
  const localSuppressWindowEscapeRef = useRef(suppressWindowEscape);
  localSuppressWindowEscapeRef.current = suppressWindowEscape;
  const effectiveSuppressWindowEscapeRef = suppressWindowEscapeRef
    || localSuppressWindowEscapeRef;
  const runtime = useMemo(() => getHistoryAgentRuntime(toolType), [toolType]);
  const [status, setStatus] = useState<AgentPtyStatus>('inactive');
  const [processLifecycleGeneration, setProcessLifecycleGeneration] = useState<string | null>(null);
  const [presenceResolving, setPresenceResolving] = useState(true);
  const prompt = useUIStore(useCallback((s) => s.historyPromptDrafts[tabId] || '', [tabId]));
  const historySlashQuery = useMemo(() => {
    if (!/^[\\/][^\s]*$/.test(prompt)) return null;
    // Backslash is an input alias only. Matching and accepted values stay
    // canonical slash commands so `\\com` completes to `/compact`, which the
    // provider can actually execute.
    return ('/' + prompt.slice(1)).toLocaleLowerCase();
  }, [prompt]);
  const historySlashMatches = useMemo(() => (
    historySlashQuery === null
      ? []
      : HISTORY_SLASH_COMMANDS.filter((command) => (
          command.value.toLocaleLowerCase().startsWith(historySlashQuery)
        ))
  ), [historySlashQuery]);
  const [historySlashSelectedIndex, setHistorySlashSelectedIndex] = useState(0);
  const [historySlashDismissedValue, setHistorySlashDismissedValue] = useState<string | null>(null);
  const [historyComposerFocused, setHistoryComposerFocused] = useState(false);
  const historySlashMenuOpen = historySlashMatches.length > 0
    && historySlashDismissedValue !== prompt
    && historyComposerFocused
    && !interactionDisabled;
  useEffect(() => {
    setHistorySlashSelectedIndex(0);
  }, [historySlashQuery, tabId]);
  useEffect(() => {
    if (historySlashDismissedValue !== null && historySlashDismissedValue !== prompt) {
      setHistorySlashDismissedValue(null);
    }
  }, [historySlashDismissedValue, prompt]);
  const historyComposerFontSize = useUIStore((s) => s.historyComposerFontSize);
  const aiSecondaryFontSize = useUIStore((s) => s.aiSecondaryFontSize);
  // The transcript's base size — the floating status chip derives from IT
  // (same 0.9 ratio as .cb-tool-label), so the chip speaks in the same voice
  // as the feed's service lines instead of the separate secondary scale.
  const historyTranscriptFontSize = useUIStore((s) => s.historyFontSize);
  const historyComposerMinRowsSetting = useUIStore((s) => s.historyComposerMinRows);
  const historyComposerMaxRowsSetting = useUIStore((s) => s.historyComposerMaxRows);
  const stackedComposerMaxRows = useUIStore((s) => s.stackedComposerMaxRows);
  const aiComposerChipThreshold = useUIStore((s) => s.aiComposerChipThreshold);
  // A stacked pane has roughly half the height, so the composer shrinks to one
  // row at rest and grows to its own (smaller) ceiling.
  const historyComposerMinRows = compactComposer ? 1 : historyComposerMinRowsSetting;
  const historyComposerMaxRows = compactComposer
    ? Math.max(1, stackedComposerMaxRows)
    : historyComposerMaxRowsSetting;
  const historyComposerLineHeightPx = historyComposerFontSize * 1.35;
  const historyComposerMinHeight = Math.ceil(historyComposerLineHeightPx * historyComposerMinRows + 16);
  const historyComposerMaxHeight = Math.ceil(historyComposerLineHeightPx * historyComposerMaxRows + 16);
  // Zustand/React store snapshots must be referentially stable. Returning `[]`
  // here when the tab has no images creates a new snapshot on every read and
  // can crash History with React #185 when AgentHistoryControls mounts.
  const draftImages = useUIStore(useCallback((s) => s.historyPromptDraftImages[tabId] || EMPTY_HISTORY_DRAFT_IMAGES, [tabId]));
  const draftChips = useUIStore(useCallback((s) => s.historyPromptDraftChips[tabId] || EMPTY_HISTORY_DRAFT_CHIPS, [tabId]));
  const composerHistoryPayload = useMemo<HistoryComposerAggregate>(() => ({
    images: draftImages,
    chips: draftChips,
  }), [draftChips, draftImages]);
  const deriveComposerHistoryPayload = useCallback((nextText: string, previous: unknown) => {
    const aggregate = previous as HistoryComposerAggregate | null;
    return {
      images: retainHistoryDraftImages(nextText, aggregate?.images || []),
      chips: retainPasteChipsForText(nextText, aggregate?.chips || []) as HistoryPromptDraftChip[],
    } satisfies HistoryComposerAggregate;
  }, []);
  const setHistoryPromptDraft = useUIStore((s) => s.setHistoryPromptDraft);
  const setHistoryComposerView = useUIStore((s) => s.setHistoryComposerView);
  const flushHistoryComposerDrafts = useUIStore((s) => s.flushHistoryComposerDrafts);
  const flushHistoryComposerView = useUIStore((s) => s.flushHistoryComposerView);
  const setHistoryComposerAvailability = useUIStore((s) => s.setHistoryComposerAvailability);
  const setPromptQueueInputSurface = useUIStore((s) => s.setPromptQueueInputSurface);
  const setPrompt = useCallback((
    next: string | ((prev: string) => string),
    options: HistoryPromptDraftWriteOptions = { preserveImages: true, preserveChips: true }
  ) => {
    const current = useUIStore.getState().historyPromptDrafts[tabId] || '';
    const value = typeof next === 'function' ? next(current) : next;
    setHistoryPromptDraft(tabId, value, options);
  }, [setHistoryPromptDraft, tabId]);
  const [busyAction, setBusyAction] = useState<'resume' | 'send' | 'interrupt' | 'stop' | 'grab' | null>(null);
  const [activeInputStatus, setActiveInputStatus] = useState<HistoryPromptHandoffStatus | null>(() => (
    selectLatestHistoryPromptInputStatus(getHistoryPromptHandoffsSnapshot(tabId))
  ));
  const [isPasteBusy, setIsPasteBusy] = useState(false);
  useEffect(() => {
    onInputBusyChange?.(isPasteBusy);
  }, [isPasteBusy, onInputBusyChange]);
  useEffect(() => () => onInputBusyChange?.(false), [onInputBusyChange]);
  const [historyUpdating, setHistoryUpdating] = useState(false);
  // A failure is ANNOUNCED (top-right toast), it is not a state of the composer.
  //
  // It used to be a line at the very bottom of the panel: it appeared under the
  // input, raised the whole frame, and then stayed until some unrelated action
  // happened to clear it. The toast keeps the event out of the composer layout,
  // but a terminal failure must not disappear before the user can inspect or
  // copy its incident report. It therefore stays until explicitly dismissed.
  //
  // Scoped to this tab, so a failure in a background pane is announced over ITS
  // surface and not over the one being read; a tab-scoped toast falls back to
  // the window corner when its tab is off screen, so nothing is lost either way.
  const reportError = useCallback((cause: unknown, incident: Record<string, unknown> = {}) => {
    // Headline = the first line. A stack or a multi-line CLI complaint keeps its
    // full text in the copy payload; the chevron preview stays bounded so a
    // 50KB pasted-content prompt cannot become a giant toast DOM node.
    showHistoryIncidentToast(tabId, cause, incident);
  }, [tabId]);
  const [draftWarning, setDraftWarning] = useState<string | null>(null);
  const delayedDeliveryWarningHandoffRef = useRef<string | null>(null);
  const [interruptAwaiting, setInterruptAwaiting] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<AgentPendingQuestion | null>(null);
  const [answeringQuestion, setAnsweringQuestion] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [resumeMaterialized, setResumeMaterialized] = useState<boolean | null>(toolType === 'claude' ? null : true);
  // `resumeUnavailableReason` удалён: он писался в четырёх местах и не читался
  // нигде — остаток от кнопки Resume, которую заменил жест на кнопке терминала.
  // Само «можно ли возобновить» живёт в `resumeMaterialized`, а причина отказа
  // теперь доходит до пользователя объявлением через `reportError`.
  const [statusCopied, setStatusCopied] = useState(false);
  const [previewChipId, setPreviewChipId] = useState<string | null>(null);
  const [activityTiming, setActivityTiming] = useState<HistoryActivityTiming | null>(null);
  const [pasteActivityStartedAt, setPasteActivityStartedAt] = useState<number | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  // Publishing the controls slot as a callback ref, not through an effect and an
  // id lookup: the node this points at is replaced whenever the panel changes
  // layout, and an id lookup would keep answering with the detached one — the
  // controls would then draw into a node nobody can see.
  const composerControlsHostRef = useRef<HTMLDivElement | null>(null);
  const composerControlsHostTabRef = useRef<string>(tabId);
  const setComposerControlsHostNode = useCallback((node: HTMLDivElement | null) => {
    const previousTab = composerControlsHostTabRef.current;
    const previousNode = composerControlsHostRef.current;
    // Withdraw only OUR node. When the layout is rebuilt React mounts the new
    // composer before unmounting the old one, so clearing by tab id alone would
    // erase the slot the new one has just published — and the controls would
    // stay in the strip forever, because nothing publishes a second time.
    if (previousNode) releaseComposerControlsHost(previousTab, previousNode);
    composerControlsHostTabRef.current = tabId;
    composerControlsHostRef.current = node;
    if (node) setComposerControlsHost(tabId, node);
  }, [tabId]);
  useEffect(() => () => {
    if (composerControlsHostRef.current) {
      releaseComposerControlsHost(composerControlsHostTabRef.current, composerControlsHostRef.current);
    }
  }, []);
  const statusCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptTextareaRef = useRef<ComposerEditorHandle | null>(null);
  useLayoutEffect(() => {
    if (!interactionDisabled) return;
    promptTextareaRef.current?.dom?.blur();
  }, [interactionDisabled]);
  const initialComposerView = useUIStore.getState().historyComposerViewByTab[tabId];
  const promptCaretRef = useRef<{ start: number; end: number }>({
    start: initialComposerView?.selectionStart || 0,
    end: initialComposerView?.selectionEnd || 0,
  });
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;
  const composerViewRenderedTabRef = useRef(tabId);
  const composerViewRestoringTabRef = useRef<string | null>(tabId);
  if (composerViewRenderedTabRef.current !== tabId) {
    composerViewRenderedTabRef.current = tabId;
    composerViewRestoringTabRef.current = tabId;
  }
  const applyHistoryComposerSnapshot = useCallback(({
    ownerTabId,
    text,
    images,
    chips,
    selectionStart,
    selectionEnd = selectionStart,
    history = 'add',
    userEvent = 'input',
  }: {
    ownerTabId: string;
    text: string;
    images: HistoryPromptDraftImageRef[];
    chips: HistoryPromptDraftChip[];
    selectionStart: number;
    selectionEnd?: number;
    history?: 'add' | 'replace' | 'external';
    userEvent?: string;
  }) => {
    const editor = promptTextareaRef.current;
    const ownsMountedEditor = tabIdRef.current === ownerTabId
      && editor?.getAttribute('data-history-composer-tab-id') === ownerTabId;
    if (ownsMountedEditor) {
      editor.applySnapshot({
        value: text,
        selectionStart,
        selectionEnd,
        history,
        historyPayload: { images, chips } satisfies HistoryComposerAggregate,
        userEvent,
      });
    }
    // Programmatic async completion must not depend on the current keyboard
    // lock callback accepting a user edit. Keep the durable host draft exact;
    // the editor callback is normally a no-op duplicate of this write.
    setHistoryPromptDraft(ownerTabId, text, { images, chips });
    if (tabIdRef.current === ownerTabId) {
      promptCaretRef.current = { start: selectionStart, end: selectionEnd };
    }
  }, [setHistoryPromptDraft]);
  const acceptHistorySlashCommand = useCallback((command: string) => {
    const state = useUIStore.getState();
    const currentImages = state.historyPromptDraftImages[tabId] || [];
    const currentChips = state.historyPromptDraftChips[tabId] || [];
    applyHistoryComposerSnapshot({
      ownerTabId: tabId,
      text: command,
      images: retainHistoryDraftImages(command, currentImages),
      chips: retainPasteChipsForText(command, currentChips) as HistoryPromptDraftChip[],
      selectionStart: command.length,
      history: 'replace',
      userEvent: 'input.complete',
    });
    setHistorySlashDismissedValue(command);
    requestAnimationFrame(() => {
      const editor = promptTextareaRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(command.length, command.length);
    });
  }, [applyHistoryComposerSnapshot, tabId]);
  const activityTimingOwnerKeyRef = useRef(tabId + ':' + toolType);
  const activityTimingRequestSeqRef = useRef(0);
  const statusRef = useRef<AgentPtyStatus>('inactive');
  const availabilityOwnerRef = useRef(
    'history-composer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
  );
  const syncPromptTextareaHeight = useCallback(() => {
    const element = promptTextareaRef.current;
    if (!element) return;
    element.measureNaturalHeight((measuredHeight) => {
      if (promptTextareaRef.current !== element) return;
      const contentHeight = measuredHeight + 2;
      const nextHeight = Math.min(
        Math.max(contentHeight, historyComposerMinHeight),
        historyComposerMaxHeight,
      );
      element.style.height = nextHeight + 'px';
      element.style.overflowY = contentHeight > historyComposerMaxHeight ? 'auto' : 'hidden';
    });
  }, [historyComposerMaxHeight, historyComposerMinHeight]);

  const captureHistoryComposerViewFor = useCallback((
    ownerTabId: string,
    persist: boolean,
    reason: 'blur' | 'owner-cleanup' | 'beforeunload',
  ) => {
    const editor = promptTextareaRef.current;
    if (editor?.getAttribute('data-history-composer-tab-id') === ownerTabId) {
      const snapshot = {
        selectionStart: editor.selectionStart,
        selectionEnd: editor.selectionEnd,
        scrollTop: editor.scrollTop,
      };
      setHistoryComposerView(ownerTabId, snapshot);
      console.log('[HistoryComposerView] capture tab=' + ownerTabId.slice(-12)
        + ' reason=' + reason
        + ' selection=' + snapshot.selectionStart + ':' + snapshot.selectionEnd
        + ' scrollTop=' + snapshot.scrollTop.toFixed(3));
    }
    if (persist) {
      flushHistoryComposerDrafts();
      flushHistoryComposerView();
    }
  }, [flushHistoryComposerDrafts, flushHistoryComposerView, setHistoryComposerView]);

  const captureHistoryComposerView = useCallback((
    persist: boolean,
    reason: 'blur' | 'owner-cleanup' | 'beforeunload',
  ) => {
    captureHistoryComposerViewFor(tabId, persist, reason);
  }, [captureHistoryComposerViewFor, tabId]);

  useLayoutEffect(() => {
    syncPromptTextareaHeight();
  }, [prompt, syncPromptTextareaHeight]);

  useLayoutEffect(() => {
    const ownerTabId = tabId;
    const editor = promptTextareaRef.current;
    composerViewRestoringTabRef.current = ownerTabId;
    const saved = useUIStore.getState().historyComposerViewByTab[ownerTabId] || {
      selectionStart: 0,
      selectionEnd: 0,
      scrollTop: 0,
    };
    if (editor && editor.getAttribute('data-history-composer-tab-id') === ownerTabId) {
      editor.restoreViewState(saved, (applied) => {
        if (tabIdRef.current !== ownerTabId
            || promptTextareaRef.current !== editor
            || editor.getAttribute('data-history-composer-tab-id') !== ownerTabId) return;
        promptCaretRef.current = {
          start: applied.selectionStart,
          end: applied.selectionEnd,
        };
        composerViewRestoringTabRef.current = null;
        console.log('[HistoryComposerView] restore tab=' + ownerTabId.slice(-12)
          + ' selection=' + applied.selectionStart + ':' + applied.selectionEnd
          + ' scrollTop=' + applied.scrollTop.toFixed(3));
      });
    } else if (tabIdRef.current === ownerTabId) {
      // A child ref is assigned before parent layout effects. This branch is a
      // defensive fail-open for a surface that vanished in the same commit.
      composerViewRestoringTabRef.current = null;
    }
    return () => {
      // Capture the live editor synchronously before its owner DOM disappears.
      // This covers keyboard/tab switches that do not emit a final scroll event.
      captureHistoryComposerViewFor(ownerTabId, true, 'owner-cleanup');
    };
  }, [captureHistoryComposerViewFor, tabId]);

  useEffect(() => {
    const persistBeforeClose = () => captureHistoryComposerView(true, 'beforeunload');
    window.addEventListener('beforeunload', persistBeforeClose);
    return () => window.removeEventListener('beforeunload', persistBeforeClose);
  }, [captureHistoryComposerView]);

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
      const detail = (event as CustomEvent<{
        tabId?: string;
        selectionStart?: number;
        selectionEnd?: number;
        immediate?: boolean;
      }>).detail;
      if (detail?.tabId !== tabId) return;
      const applyFocus = () => {
        const editor = promptTextareaRef.current;
        if (!editor) return;
        editor.focus();
        if (!Number.isFinite(detail.selectionStart)) return;
        const start = Math.max(0, Math.min(detail.selectionStart!, editor.value.length));
        const requestedEnd = Number.isFinite(detail.selectionEnd)
          ? detail.selectionEnd!
          : start;
        const end = Math.max(start, Math.min(requestedEnd, editor.value.length));
        editor.setSelectionRange(start, end);
        promptCaretRef.current = { start, end };
      };
      if (detail.immediate) applyFocus();
      else requestAnimationFrame(applyFocus);
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
  const midstreamPromptRecoveryRef = useRef<MidstreamPromptRecovery | null>(null);
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
              + ' generation=' + presenceGeneration + ' current=' + presenceGenerationRef.current
              + ' action=retry-current');
            // `continue` alone used to fall through the do/while condition
            // when no caller happened to set `trailing`. The completed IPC was
            // discarded correctly, but no current-generation read replaced it,
            // leaving this mounted History at CHECKING forever.
            flight.trailing = true;
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
          onRuntimeSnapshotChange?.(presence.runtimeSnapshot || null);
          setProcessLifecycleGeneration(
            runtime.toolType === 'codex'
              ? (presence.runtimeSnapshot?.lifecycleGeneration || null)
              : null,
          );
          if (runtime.toolType === 'claude') {
            setResumeMaterialized(presence.conversationMaterialized === true || presence.canResume === true);
          } else {
            setResumeMaterialized(true);
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
          if (presenceGenerationRef.current !== presenceGeneration) {
            flight.trailing = true;
            continue;
          }
          console.warn('[' + runtime.logPrefix + '] presence failed tab=' + tabId.slice(-12) + ': ' + String(e?.message || e));
          setStatusFrom('inactive', 'presence-error');
          onRuntimeSnapshotChange?.(null);
          setProcessLifecycleGeneration(null);
        }
      } while (flight.trailing && presenceOwnerKeyRef.current === ownerKey);
    })().finally(() => {
      if (presenceFlightRef.current === flight) presenceFlightRef.current = null;
    });
    presenceFlightRef.current = flight;
    return flight.promise;
  }, [onRuntimeSnapshotChange, presenceOwnerKey, projectId, refreshPendingQuestion, runtime, setPendingQuestionFrom, setStatusFrom, tabId]);

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

  const durableIdentityForPending = useCallback((pending: MidstreamPromptRecovery) => {
    const handoff = getHistoryPromptHandoffsSnapshot(tabId)
      .find((candidate) => candidate.handoffId === pending.handoffId);
    const proof = handoff?.auditProof || null;
    const queueProof = handoff?.providerQueueProof || null;
    return {
      ...pending.durableIdentity,
      requiresAuditIdentity: true,
      auditTimestamp: proof?.auditTimestamp || pending.durableIdentity.auditTimestamp,
      auditHash: proof?.actualHash || pending.durableIdentity.auditHash,
      auditSessionId: proof?.sessionId || pending.durableIdentity.auditSessionId,
      auditEntryUuid: proof?.entryUuid || pending.durableIdentity.auditEntryUuid,
      sourceIdentity: proof?.sourceIdentity
        || queueProof?.sourceIdentity
        || pending.durableIdentity.sourceIdentity,
      recordByteOffset: proof?.recordByteOffset
        ?? queueProof?.recordByteOffset
        ?? pending.durableIdentity.recordByteOffset,
      sessionId: proof?.sessionId || queueProof?.sessionId || pending.durableIdentity.sessionId,
    } satisfies DurablePromptIdentity;
  }, [tabId]);

  const hasDurablePendingPrompt = useCallback((pending: MidstreamPromptRecovery) => (
    hasDurablePrompt(
      pending.serializedText,
      pending.submittedAt,
      durableIdentityForPending(pending),
    )
  ), [durableIdentityForPending, hasDurablePrompt]);

  const refreshDurablePromptProof = useCallback(async (
    pending: MidstreamPromptRecovery,
    reason: string,
    options: { forceRefresh?: boolean } = {},
  ) => {
    if (!options.forceRefresh && hasDurablePendingPrompt(pending)) return true;
    try {
      await onHistoryRefresh(reason);
    } catch (e: any) {
      console.warn('[' + runtime.logPrefix + '] durable prompt refresh failed tab='
        + tabId.slice(-12)
        + ' reason=' + reason
        + ' error=' + String(e?.message || e));
    }
    return hasDurablePendingPrompt(pending);
  }, [hasDurablePendingPrompt, onHistoryRefresh, runtime.logPrefix, tabId]);

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
    delayedDeliveryWarningHandoffRef.current = null;
    interruptRecoveryInFlightRef.current = false;
    interruptAwaitRef.current = null;
    setBusyAction(coordinatedAction ? 'send' : null);
    setIsPasteBusy(false);
    setHistoryUpdating(false);
    // Nothing to clear for failures: each one is an announcement with its own
    // lifetime, not a piece of this tab's state that a reset has to sweep.
    setDraftWarning(null);
    setInterruptAwaiting(false);
    setPendingQuestion(null);
    setAnsweringQuestion(false);
    setQuestionError(null);
    setResumeMaterialized(toolType === 'claude' ? null : true);
    setActivityTiming(null);
    setPasteActivityStartedAt(null);
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

  useEffect(() => subscribeHistoryPromptHandoffs(tabId, (snapshot, change) => {
    const nextInputStatus = selectLatestHistoryPromptInputStatus(snapshot);
    setActiveInputStatus(nextInputStatus);
    if (nextInputStatus === null) {
      setDraftWarning((current) => (
        current === HISTORY_PENDING_DELIVERY_BLOCK_NOTICE ? null : current
      ));
    }
    const handoffId = delayedDeliveryWarningHandoffRef.current;
    if (!handoffId) return;
    const exactRecord = snapshot.find((record) => record.handoffId === handoffId);
    const confirmed = exactRecord?.queueStatus === 'sent'
      || (change.type === 'consume' && change.handoffId === handoffId);
    if (!confirmed) return;
    delayedDeliveryWarningHandoffRef.current = null;
    setDraftWarning((current) => (
      current && isHistoryDeliveryConfirmationNotice(current) ? null : current
    ));
    historyDiag('DELIVERY_NOTICE_CLEAR tab=' + tabId.slice(-12)
      + ' handoff=' + handoffId
      + ' reason=' + (exactRecord?.queueStatus === 'sent' ? 'confirmed' : 'consumed'));
  }), [tabId]);

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
      reportError(event.result?.error || 'Stop failed');
    }
    refreshPresence();
  }), [refreshPresence, reportError, setStatusFrom]);

  useEffect(() => {
    const handleAgentError = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as { tabId?: string; message?: string; error?: string };
      if (detail.tabId !== tabId) return;
      const message = String(detail.message || detail.error || '').trim();
      if (!message) return;
      reportError(message);
      setDraftWarning(null);
    };
    const handleStartupGate = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as {
        tabId?: string;
        status?: string;
        reason?: string;
        error?: string;
        errorCode?: string | null;
        failedCommand?: string | null;
        proofOutcome?: string | null;
      };
      if (detail.tabId !== tabId) return;
      if (detail.status === 'failed') {
        const failure = describeClaudeStartupFailure({
          error: detail.error || detail.reason || 'Claude startup failed',
          errorCode: detail.errorCode,
          failedCommand: detail.failedCommand,
        });
        reportError(failure.message, {
          headline: failure.subtitle || undefined,
          incidentKind: 'startup-settings',
          toolType: 'claude',
          action: 'startup-settings',
          code: failure.code,
          failedCommand: detail.failedCommand || null,
          proofOutcome: detail.proofOutcome || null,
          recovery: failure.detail,
        });
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
  }, [refreshPresence, reportError, tabId]);

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
    const handlePasteBusy = (_: any, data: {
      tabId?: string;
      busy?: boolean;
      phase?: 'sending' | 'confirming' | 'idle';
      handoffId?: string | null;
    }) => {
      if (data?.tabId !== tabId) return;
      if (data.handoffId && (data.phase === 'sending' || data.phase === 'confirming')) {
        advanceHistoryPromptHandoffTransportPhase(tabId, data.handoffId, data.phase);
      }
      const nextBusy = !!data.busy;
      if (nextBusy && !pasteBusyRef.current) {
        setPasteActivityStartedAt(Date.now());
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
        return {
          stale: false,
          text: '',
          images: 0,
          imagePaths: [] as HistoryPromptDraftImageRef[],
          claudeExactEmptyEvidence: null,
        };
      }
      if (draftDecision.decision === 'unknown' && draftState.exactCaptureRecommended !== true) {
        throw new Error(runtime.label + ' terminal draft state is unknown; send stopped before touching terminal input.');
      }
    }
    console.log('[' + runtime.logPrefix + ':draft] grab-request tab=' + tabId.slice(-12) + ' reason=' + reason);
    const result = await runtime.grabDraft(tabId, draftState ? {
      draftProof: buildExactDraftCaptureProof(
        draftState,
        terminalRegistry.getDraftDiagnosticSnapshot(tabId, {
          promptRow: (draftState as any)?.promptRow,
          cursorRow: (draftState as any)?.cursorRow,
        }),
      ),
    } : undefined);
    if (tabIdRef.current !== requestTabId) return {
      stale: true,
      text: '',
      images: 0,
      imagePaths: [] as HistoryPromptDraftImageRef[],
      claudeExactEmptyEvidence: null,
    };
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
      showAgentDraftScreenContradictionToast(useUIStore.getState(), {
        tabId,
        label: runtime.label,
      });
      console.warn('[' + runtime.logPrefix + ':draft] ambiguous screen tail resolved as empty tab='
        + tabId.slice(-12) + ' reason=' + (conflict.reason || '-'));
    }
    console.log('[' + runtime.logPrefix + ':draft] grab-ok tab=' + tabId.slice(-12) + ' reason=' + reason + ' chars=' + text.length + ' images=' + images);
    return {
      stale: false,
      text,
      images,
      imagePaths,
      claudeExactEmptyEvidence: runtime.toolType === 'claude'
        && draftState
        && !text
        && images === 0
        && result?.proofOutcome === 'absent'
        && result?.terminalIdentityStable === true
        && result?.editorReturnReady === true
        ? result as Record<string, unknown>
        : null,
    };
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
        console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery probe tab=' + tabId.slice(-12)
          + ' attempt=' + attempt
          + ' source=authoritative-stop-event');
        try {
            const draft = await readTerminalDraft('interrupt-recovery');
            if (draft.stale || tabIdRef.current !== requestTabId) return;
            if (!draft.text) {
              console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery empty tab=' + tabId.slice(-12) + ' attempt=' + attempt);
            } else {
              const ui = useUIStore.getState();
              const current = ui.historyPromptDrafts[requestTabId] || '';
              const currentChips = ui.historyPromptDraftChips[requestTabId] || [];
              const currentImages = ui.historyPromptDraftImages[requestTabId] || [];
              const authoringProof = interruptedPromptDraftMatchesHandoff({
                returnedDraft: draft.text,
                presentationText: pending.serializedText,
                transportText: pending.transportText,
              });
              const confirmedOwnership = resolveInterruptedPromptOwnership({
                durablePromptExists: authoringProof
                  ? await refreshDurablePromptProof(pending, 'interrupt-exact-draft', {
                      // The prompt can disappear from Claude's active branch on
                      // interrupt after an older History snapshot already saw
                      // it. A returned exact draft therefore forces one fresh
                      // branch read before durable ownership is allowed to win.
                      forceRefresh: true,
                    })
                  : hasDurablePendingPrompt(pending),
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
            pending,
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
  }, [hasDurablePendingPrompt, isNonAuthoritativeBusyEvent, onPromptStatusChange, readTerminalDraft, refreshDurablePromptProof, refreshPresence, runtime, setHistoryPromptDraft, showEmptyDraftNotice, tabId]);

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
      reportError(runtime.label + ' is not ready (' + statusRef.current + ')');
      return;
    }
    if (pendingQuestionRef.current) {
      reportError(runtime.label + ' is waiting for a question answer');
      return;
    }

    const actionTabId = tabId;
    const actionSeq = ++actionSeqRef.current;
    const isCurrentAction = () => (
      tabIdRef.current === actionTabId && actionSeqRef.current === actionSeq
    );
    actionInFlightRef.current = true;
    setBusyAction('grab');
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
        reportError(e);
        refreshPresence();
      }
    } finally {
      if (isCurrentAction()) {
        actionInFlightRef.current = false;
        setBusyAction(null);
      }
    }
  }, [readTerminalDraft, refreshPresence, reportError, runtime.label, runtime.logPrefix, setHistoryPromptDraft, showEmptyDraftNotice, tabId]);

  const prepareHistoryPromptForSend = useCallback(async (
    text: string,
    images: HistoryPromptDraftImageRef[],
  ): Promise<{
    success: boolean;
    payload: string;
    images: HistoryPromptDraftImageRef[];
    warning?: string;
    degraded?: boolean;
  }> => {
    const retainedImages = retainHistoryDraftImages(text, images);
    const immediateNotice = historyDraftImageNotice(text, retainedImages);
    if (immediateNotice?.blocking) {
      return {
        success: false,
        payload: text,
        images: retainedImages,
        warning: immediateNotice.message,
      };
    }

    const imageIds = collectPromptImageRefIds(text);
    if (imageIds.size === 0) {
      return {
        success: true,
        payload: text,
        images: [],
        warning: immediateNotice?.message,
        degraded: immediateNotice?.blocking === false,
      };
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
      const materializedInspection = inspectPromptImageAttachments(text, materializedImages);
      if (materializedInspection.blocking) {
        return {
          success: false,
          payload: text,
          images: materializedImages,
          warning: historyDraftImageNotice(text, materializedImages)?.message
            || 'Image attachment identity is incomplete. The draft was kept.',
        };
      }
      const materializedNotice = historyDraftImageNotice(text, materializedImages);
      return {
        success: true,
        payload: buildPromptImagePayload(text, materializedImages, {
          missingCode: 'history_image_path_unavailable',
        }),
        images: materializedImages,
        warning: materializedNotice?.message,
        degraded: materializedInspection.unavailable,
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
  }, [runtime.logPrefix, tabId]);

  const runAction = useCallback(async (
    kind: 'resume' | 'send' | 'interrupt' | 'stop',
    options: { recordWithoutReply?: boolean } = {},
  ) => {
    const recordWithoutReply = kind === 'send' && options.recordWithoutReply === true;
    if (kind === 'send' && historyPromptHandoffBlocksNewSubmit(
      getHistoryPromptHandoffsSnapshot(tabId),
    )) {
      setDraftWarning(HISTORY_PENDING_DELIVERY_BLOCK_NOTICE);
      historyDiag('DROP_ACTION tab=' + tabId.slice(-12)
        + ' kind=send reason=previous-delivery-pending');
      return;
    }
    let queuedBehindExistingSend = false;
    const coordinatedAtClick = getCoordinatedAgentAction(tabId);
    if (coordinatedAtClick) {
      actionInFlightRef.current = true;
      activeActionKindRef.current = 'send';
    }
    if (actionInFlightRef.current) {
      const activeKind = activeActionKindRef.current;
      const sendCanJoinExistingLaunch = kind === 'send'
        && activeKind === 'resume'
        && statusRef.current === 'starting';
      if (sendCanJoinExistingLaunch) {
        // The already-running Start/Resume call owns process creation. Move
        // the single action lane to this submit intent; the shared send
        // scenario waits for that exact launch instead of starting a second
        // process or requiring a second Enter.
        historyDiag('JOIN_ACTION tab=' + tabId.slice(-12)
          + ' kind=send after=resume status=starting');
      } else if (kind === 'send' && activeKind === 'send') {
        setDraftWarning(HISTORY_PENDING_DELIVERY_BLOCK_NOTICE);
        historyDiag('DROP_ACTION tab=' + tabId.slice(-12)
          + ' kind=send reason=previous-send-action-inflight'
          + ' head=' + (coordinatedAtClick?.handoffId || '-'));
        return;
      } else if (kind === 'stop' && activeKind === 'send') {
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
      } else {
        console.log('[' + runtime.logPrefix + '] drop-action tab=' + tabId.slice(-12) + ' kind=' + kind + ' reason=inflight');
        historyDiag('DROP_ACTION tab=' + tabId.slice(-12) + ' kind=' + kind + ' reason=inflight busyAction=' + (busyAction || activeKind || 'none'));
        return;
      }
    }
    if (kind === 'send' && pasteBusyRef.current && !queuedBehindExistingSend) {
      console.log('[' + runtime.logPrefix + '] drop-action tab=' + tabId.slice(-12) + ' kind=send reason=paste-busy');
      return;
    }
    const actionTabId = tabId;
    let coordinatedSendToken: number | null = null;
    if (kind === 'send') {
      const started = beginCoordinatedAgentSend(actionTabId, Date.now(), {
        recordWithoutReply,
      });
      if (!started.started || !started.token) {
        if (started.reason === 'send-inflight') {
          setDraftWarning(HISTORY_PENDING_DELIVERY_BLOCK_NOTICE);
        }
        historyDiag('DROP_ACTION tab=' + actionTabId.slice(-12)
          + ' kind=send reason=' + (started.reason || 'coordinator-inflight'));
        return;
      }
      coordinatedSendToken = started.token;
      queuedBehindExistingSend = queuedBehindExistingSend || started.queued === true;
    }
    const actionSeq = ++actionSeqRef.current;
    const isCurrentAction = () => (
      tabIdRef.current === actionTabId
      && (kind === 'send' || actionSeqRef.current === actionSeq)
    );
    let sendHandoffId: string | null = null;
    let sendOwnershipTransferred = false;
    let sendDeliveryUnconfirmed = false;
    let sendTransferredQueueStatus: Exclude<HistoryPromptHandoffStatus,
      'preparing' | 'sending' | 'failed'> = 'sent';
    let sendAuditIdentity: {
      requiresAuditIdentity?: boolean;
      auditTimestamp?: string;
      auditHash?: string;
      auditSessionId?: string;
      auditEntryUuid?: string;
      sourceIdentity?: string;
      recordByteOffset?: number;
    } | undefined;
    let clearedPromptText: string | null = null;
    let clearedPromptImages: HistoryPromptDraftImageRef[] = [];
    let clearedPromptChips: HistoryPromptDraftChip[] = [];
    let sendRefusalPasteWritten = false;
    let deferredSendRollback = false;
    let sendIncidentPromptText = '';
    let sendIncidentStatusAtSend = '';
    let sendIncidentImages = 0;
    let sendIncidentChips = 0;
    let sendFailureResult: any = null;
    let sendCoordinatedSettlement: any = null;
    let historyRecordSettledEarly = false;
    let cascadeBatchRestored = false;
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
        const restoredText = restorePrompt || '';
        applyHistoryComposerSnapshot({
          ownerTabId: actionTabId,
          text: restoredText,
          images: clearedPromptImages,
          chips: clearedPromptChips,
          selectionStart: restoredText.length,
          history: 'external',
          userEvent: 'input.complete',
        });
        setHistoryComposerView(actionTabId, {
          selectionStart: restoredText.length,
          selectionEnd: restoredText.length,
          scrollTop: 0,
        });
        flushHistoryComposerDrafts();
        flushHistoryComposerView();
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
      applyHistoryComposerSnapshot({
        ownerTabId: actionTabId,
        text: merged.text,
        images: merged.images,
        chips: merged.chips,
        selectionStart: merged.text.length,
        history: 'external',
        userEvent: 'input.complete',
      });
      setHistoryComposerView(actionTabId, {
        selectionStart: merged.text.length,
        selectionEnd: merged.text.length,
        scrollTop: 0,
      });
      flushHistoryComposerDrafts();
      flushHistoryComposerView();
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
        sendIncidentPromptText = presentationText;
        sendIncidentChips = sourceDraftChips.length;
        if (!presentationText) return;
        if (pendingQuestionRef.current) throw new Error(runtime.label + ' is waiting for a question answer');
        const statusAtSend = statusRef.current;
        sendIncidentStatusAtSend = statusAtSend;
        let claudeExactEmptyEvidence: Record<string, unknown> | null = null;
        const acceptsBusyPrompt = statusAtSend === 'busy' && runtime.allowSendWhileBusy;
        const canWaitForExistingLaunch = statusAtSend === 'starting';
        const canLaunchBeforeSend = statusAtSend === 'inactive' && (
          sessionId
            ? (runtime.toolType !== 'claude' || resumeMaterialized === true)
            : !!runtime.startFresh
        );
        const canRecordWithoutReply = recordWithoutReply
          && (statusAtSend === 'active' || statusAtSend === 'inactive');
        const canQueueBehindExistingSend = queuedBehindExistingSend
          && statusAtSend !== 'unknown';
        if (statusAtSend !== 'active'
          && !acceptsBusyPrompt
          && !canLaunchBeforeSend
          && !canWaitForExistingLaunch
          && !canRecordWithoutReply
          && !canQueueBehindExistingSend) {
          throw new Error(runtime.label + ' is not ready (' + statusAtSend + ')');
        }
        if (statusAtSend === 'active') {
          const terminalDraft = await readTerminalDraft('send-preflight');
          if (terminalDraft.stale || !isCurrentAction()) return;
          claudeExactEmptyEvidence = terminalDraft.claudeExactEmptyEvidence || null;
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
        if (preparedPrompt.degraded) {
          const degradedInspection = inspectPromptImageAttachments(
            rawDraftSnapshot,
            preparedPrompt.images,
          );
          console.warn('[' + runtime.logPrefix + ':images] send degraded tab=' + actionTabId.slice(-12)
            + ' unavailable=' + degradedInspection.issues.filter((issue: any) => !issue.blocking).length
            + ' action=replace-with-imageError');
        }
        const sendDraftImages = preparedPrompt.images;
        sendIncidentImages = sendDraftImages.length;
        const sendPayload = serializeComposerDraft({
          text: preparedPrompt.payload,
          chips: sourceDraftChips,
        }).trim();
        // The copied incident must contain what the PTY scenario attempted to
        // send, not only the compact chip labels visible in the editor.
        sendIncidentPromptText = sendPayload;
        const handoffId = createPromptHandoffId();
        const submittedAt = Date.now();
        const initialQueueStatus = recordWithoutReply || queuedBehindExistingSend
          ? 'preparing'
          : historyPromptHandoffInitialStatus(statusAtSend);
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
        const localCommandCandidate = !recordWithoutReply
          && isStandaloneAgentLocalCommand({
            prompt: sendPayload,
            imageCount: sendDraftImages.length,
            chipCount: promptChipsForHistory.length,
          });
        const requiresAuditIdentity = !localCommandCandidate;
        beginHistoryPromptHandoff({
          tabId: actionTabId,
          handoffId,
          toolType: runtime.toolType,
          sessionIdHint: sessionId || null,
          text: presentationText,
          promptChips: promptChipsForHistory,
          imagePaths: sendDraftImages,
          authoringText: rawDraftSnapshot,
          authoringChips: sourceDraftChips,
          authoringImagePaths: sendDraftImages,
          submittedAt,
          source: 'history-panel',
          statusAtSend,
          initialStatus: initialQueueStatus,
          requiresAuditIdentity,
        });
        onPromptSubmitted(presentationText, initialQueueStatus, {
          handoffId,
          statusAtSend,
          submittedAt,
          promptChips: promptChipsForHistory,
          imagePaths: sendDraftImages,
          requiresAuditIdentity,
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
          const editorBeforeClear = promptTextareaRef.current;
          const editorCharsBefore = editorBeforeClear?.getAttribute('data-history-composer-tab-id') === actionTabId
            ? editorBeforeClear.value.length
            : -1;
          applyHistoryComposerSnapshot({
            ownerTabId: actionTabId,
            text: '',
            images: [],
            chips: [],
            selectionStart: 0,
            history: 'external',
            userEvent: 'input.complete',
          });
          setHistoryComposerView(actionTabId, {
            selectionStart: 0,
            selectionEnd: 0,
            scrollTop: 0,
          });
          // The handoff boundary must clear both the live CodeMirror document
          // and the restart-persistent draft before PTY ownership begins.
          // Otherwise the sent text can be revived by a stale editor callback
          // or by the previous persisted snapshot after renderer restart.
          flushHistoryComposerDrafts();
          flushHistoryComposerView();
          historyDiag('COMPOSER_HANDOFF_CLEAR tab=' + actionTabId.slice(-12)
            + ' handoff=' + handoffId
            + ' editorBefore=' + editorCharsBefore
            + ' editorAfter=' + (promptTextareaRef.current?.value.length ?? -1)
            + ' storeAfter=' + (useUIStore.getState().historyPromptDrafts[actionTabId] || '').length
            + ' persisted=1');
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
        delayedDeliveryWarningHandoffRef.current = null;
        setDraftWarning(null);
        // A normal prompt does not request model/effort at all. The live
        // ControlBar picker has already applied them, while cold Start/Resume
        // gets them from buildCodexRunPayload. Only record-without-reply stops
        // and reopens the writer, so only that lifecycle operation carries the
        // exact pair across its restart boundary.
        const codexMutationProof = runtime.toolType === 'codex'
          && recordWithoutReply
          && statusAtSend === 'active'
          && sessionId
          ? getCodexHistoryMutationSettingsProof(tabId, sessionId)
          : null;
        const codexLaunchSettings = runtime.toolType === 'codex' && recordWithoutReply
          ? getCodexLaunchOptions(tabId)
          : null;
        const codexRestartSettingsState = resolveCodexHistoryRestartSettingsState({
          recordWithoutReply,
          mutationProof: codexMutationProof,
          launchSettings: codexLaunchSettings,
        });
        const historyRestartSettings = codexRestartSettingsState
          ? createAgentHistoryRestartSettings(codexRestartSettingsState)
          : undefined;
        const result = await sendAgentPromptScenario({
          tabId,
          toolType: runtime.toolType,
          runtime,
          // The common scenario re-proves whether a Claude UUID represents a
          // materialized conversation before it stops the process. Renderer
          // state may still be loading and cannot choose Fresh vs Resume.
          sessionId,
          cwd,
          prompt: sendPayload,
          handoffId,
          // Recording context is a lifecycle policy of the same History
          // authoring operation. Keeping the canonical source preserves the
          // durable identity used to replace the optimistic row exactly.
          source: 'history-panel',
          statusAtSend,
          queue: !recordWithoutReply && statusAtSend === 'busy',
          settingsIntent: AGENT_SETTINGS_INTENT_NONE,
          historyRestartSettings,
          returnDraftOnConflict: true,
          initialComposerProof: claudeExactEmptyEvidence,
          coordinatedSendToken,
          recordWithoutReply,
          onRestartPhase: (phase) => {
            if (!isCurrentAction()) return;
            if (phase === 'stopping') {
              processStopInFlightRef.current = true;
              presenceGenerationRef.current += 1;
              setStatusFrom('stopping', 'record-context-stop');
            } else {
              processStopInFlightRef.current = false;
              presenceGenerationRef.current += 1;
              setStatusFrom('starting', 'record-context-start');
            }
          },
          onHistoryRecorded: (recorded) => {
            const attemptId = String(recorded?.sendAttemptId || recorded?.attemptId || '');
            const operationKey = String(recorded?.sendOperationKey || recorded?.operationKey || '');
            const proof = historyPromptHandoffAuditProofFromSendResult(recorded);
            if (!attemptId || !operationKey || !proof) {
              historyDiag('HISTORY_CONTEXT_EARLY_PROOF_MISSING tab=' + actionTabId.slice(-12)
                + ' handoff=' + handoffId
                + ' attempt=' + (attemptId || '-')
                + ' operation=' + (operationKey || '-'));
              return;
            }
            const bound = bindHistoryPromptHandoffSendIdentity(actionTabId, handoffId, {
              sendAttemptId: attemptId,
              sendOperationKey: operationKey,
            });
            if (!bound.ok) {
              historyDiag('HISTORY_CONTEXT_EARLY_BIND_FAILED tab=' + actionTabId.slice(-12)
                + ' handoff=' + handoffId
                + ' reason=' + (bound.reason || 'unknown'));
              return;
            }
            sendOwnershipTransferred = true;
            sendAuditIdentity = {
              requiresAuditIdentity: true,
              auditTimestamp: proof.auditTimestamp,
              auditHash: proof.actualHash,
              auditSessionId: proof.sessionId || undefined,
              auditEntryUuid: proof.entryUuid,
              sourceIdentity: proof.sourceIdentity,
              recordByteOffset: proof.recordByteOffset,
            };
            settleHistoryPromptHandoff(actionTabId, handoffId, {
              queueStatus: 'sent',
              reason: 'history-context-recorded',
              proof,
              requiresAuditIdentity: true,
            });
            onPromptStatusChange(
              handoffId,
              'sent',
              'history-context-recorded',
              sendAuditIdentity,
            );
            historyRecordSettledEarly = true;
            refreshHistoryWithUpdating('history-context-recorded');
          },
          onReadyForSend: (readyStatus) => {
            if (recordWithoutReply) return;
            advanceHistoryPromptHandoffTransportPhase(
              actionTabId,
              handoffId,
              readyStatus === 'busy' ? 'queued' : 'sending',
            );
          },
          presentationSnapshot: {
            historySessionId: sessionId || null,
            promptChips: promptChipsForHistory,
            imagePaths: sendDraftImages,
          },
        });
        sendFailureResult = result;
        sendCoordinatedSettlement = result?.coordinatedSettlement || null;
        const localSlashReceipt = projectAgentLocalCommandSendResult({
          candidate: localCommandCandidate,
          result,
        });
        const resultOwnershipTransferred = localSlashReceipt.handled
          ? localSlashReceipt.transferred === true
          : queueSendTransferredOwnership(result);
        const resultSendAttemptId = typeof (result?.sendAttemptId || result?.attemptId) === 'string'
          ? String(result.sendAttemptId || result.attemptId)
          : '';
        const resultSendOperationKey = typeof (result?.sendOperationKey || result?.operationKey) === 'string'
          ? String(result.sendOperationKey || result.operationKey)
          : '';
        let sendIdentityFailure = '';
        if (resultOwnershipTransferred && !localSlashReceipt.handled) {
          if (!resultSendAttemptId || !resultSendOperationKey) {
            sendIdentityFailure = 'missing-durable-send-identity';
          } else {
            const boundIdentity = bindHistoryPromptHandoffSendIdentity(
              actionTabId,
              handoffId,
              {
                sendAttemptId: resultSendAttemptId,
                sendOperationKey: resultSendOperationKey,
              },
            );
            if (!boundIdentity.ok) sendIdentityFailure = boundIdentity.reason;
          }
        }
        if (sendIdentityFailure) {
          console.error('[' + runtime.logPrefix + ':draft] send identity rejected tab='
            + actionTabId.slice(-12)
            + ' handoff=' + handoffId
            + ' attempt=' + (resultSendAttemptId.slice(0, 12) || '-')
            + ' operation=' + (resultSendOperationKey.slice(0, 72) || '-')
            + ' reason=' + sendIdentityFailure);
        }
        // A receipt from a different/unknown physical attempt cannot prove
        // this optimistic row. Keep ownership with the terminal and show an
        // explicit unconfirmed state; never retry the already-submitted text.
        const auditProof = localSlashReceipt.handled || sendIdentityFailure
          ? null
          : historyPromptHandoffAuditProofFromSendResult(result);
        const unconfirmedStatus = localSlashReceipt.handled
          ? (localSlashReceipt.queueStatus === 'delivery-unknown'
            ? 'delivery-unknown' as const
            : null)
          : sendIdentityFailure
            ? 'delivery-unknown' as const
            : historyPromptHandoffUnconfirmedStatusFromSendResult(result);
        const historyOnly = result?.historyOnly === true;
        const providerQueueReturned = !historyOnly && historyPromptAuditIsProviderQueueReturn(
          result?.pasteAudit || result,
        );
        const finalAuditFailure = result?.success === false
          && result?.submitted === true
          && !unconfirmedStatus;
        const effectiveStatusAtSend = result?.effectiveStatusAtSend || statusAtSend;
        const resultQueueStatus: Exclude<HistoryPromptHandoffStatus,
          'preparing' | 'sending' | 'failed'> = localSlashReceipt.handled
          && localSlashReceipt.queueStatus
          ? localSlashReceipt.queueStatus
          : providerQueueReturned
            ? 'cancelled'
            : unconfirmedStatus || (effectiveStatusAtSend === 'busy' ? 'queued' : 'sent');
        sendAuditIdentity = {
          requiresAuditIdentity: resultOwnershipTransferred && !localSlashReceipt.handled,
          auditTimestamp: auditProof?.auditTimestamp,
          auditHash: auditProof?.actualHash,
          auditSessionId: auditProof?.sessionId || undefined,
          auditEntryUuid: auditProof?.entryUuid,
          sourceIdentity: auditProof?.sourceIdentity,
          recordByteOffset: auditProof?.recordByteOffset,
        };
        if (resultOwnershipTransferred && !historyRecordSettledEarly) {
          settleHistoryPromptHandoff(actionTabId, handoffId, {
            queueStatus: resultQueueStatus,
            reason: localSlashReceipt.handled
              ? localSlashReceipt.reason || 'codex-local-slash-submitted'
              : sendIdentityFailure
              ? 'send-durable-identity-' + sendIdentityFailure
              : providerQueueReturned
                ? 'provider-queue-returned-to-terminal-composer'
              : finalAuditFailure
              ? 'send-submitted-audit-unconfirmed'
              : resultQueueStatus === 'audit-pending'
                ? 'send-submitted-audit-pending'
                : resultQueueStatus === 'delivery-unknown'
                  ? 'send-delivery-unknown'
                : historyOnly
                  ? 'history-context-recorded'
                  : 'send-result',
            proof: auditProof,
            requiresAuditIdentity: !localSlashReceipt.handled,
          });
        } else if (!resultOwnershipTransferred) {
          retractHistoryPromptHandoff(actionTabId, handoffId, 'send-refused-before-submit');
        }
        historyDiag('SEND_RESULT tab=' + tabId.slice(-12) +
          ' handoff=' + handoffId +
          ' success=' + (result?.success === null ? 'unknown' : result?.success !== false) +
          ' submitted=' + !!result?.submitted +
          ' chunks=' + (result?.chunksTotal ?? 'na') +
          ' error=' + (result?.error || '-'));
        sendOwnershipTransferred = resultOwnershipTransferred;
        sendDeliveryUnconfirmed = localSlashReceipt.handled
          ? localSlashReceipt.deliveryUnconfirmed === true
          : !providerQueueReturned && (
              unconfirmedStatus !== null
              || (result?.submitted === true && result?.success === false)
            );
        sendRefusalPasteWritten = result?.pasteWritten === true;
        sendTransferredQueueStatus = resultQueueStatus;
        historyDiag('SEND_OWNERSHIP tab=' + tabId.slice(-12) +
          ' handoff=' + handoffId +
          ' transferred=' + sendOwnershipTransferred +
          ' deliveryUnconfirmed=' + sendDeliveryUnconfirmed +
          ' submitted=' + !!result?.submitted +
          ' success=' + (result?.success === null ? 'unknown' : result?.success !== false));
        if (!sendOwnershipTransferred) {
          throw Object.assign(
            new Error(result?.error || 'Send failed before submit'),
            result && typeof result === 'object' ? result : {},
          );
        }
        if (!isCurrentAction()) return;
        onPromptStatusChange(
          handoffId,
          sendTransferredQueueStatus,
          sendDeliveryUnconfirmed ? 'send-submitted-unconfirmed' : 'send-result',
          sendAuditIdentity,
        );
        if (sendDeliveryUnconfirmed) {
          delayedDeliveryWarningHandoffRef.current = handoffId;
          const alreadyConfirmed = getHistoryPromptHandoffsSnapshot(actionTabId)
            .some((record) => record.handoffId === handoffId && record.queueStatus === 'sent');
          if (alreadyConfirmed) {
            delayedDeliveryWarningHandoffRef.current = null;
            setDraftWarning(null);
          } else {
            setDraftWarning(unconfirmedStatus === 'delivery-unknown'
              ? historyOnly
                ? 'History recording is unconfirmed. It will not be repeated automatically.'
                : 'Prompt delivery is unconfirmed. It will not be sent again automatically.'
              : 'Prompt was submitted, but delivery confirmation is delayed. It will not be sent again automatically.');
          }
          console.warn('[' + runtime.logPrefix + ':draft] send delivery unconfirmed; ownership kept by terminal tab='
            + actionTabId.slice(-12)
            + ' handoff=' + handoffId
            + ' error=' + (result?.error || '-'));
        }
        if (!localSlashReceipt.handled && !historyOnly) {
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
            durableIdentity: {
              requiresAuditIdentity: true,
              auditTimestamp: sendAuditIdentity.auditTimestamp,
              auditHash: sendAuditIdentity.auditHash,
              auditSessionId: sendAuditIdentity.auditSessionId,
              auditEntryUuid: sendAuditIdentity.auditEntryUuid,
              sourceIdentity: sendAuditIdentity.sourceIdentity,
              recordByteOffset: sendAuditIdentity.recordByteOffset,
              sessionId: sendAuditIdentity.auditSessionId || sessionId || undefined,
            },
          };
        }
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
        } else if (historyOnly) {
          midstreamPromptRecoveryRef.current = null;
          if (result?.reopenWarning) {
            setDraftWarning('Context was recorded, but the agent did not reopen: ' + result.reopenWarning);
          }
          if (result?.reopened === true) setStatusFrom('active', 'history-context-ready');
          else refreshPresence();
        } else if (localSlashReceipt.handled) {
          refreshPresence();
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
      if (kind === 'send') {
        sendCoordinatedSettlement = e?.coordinatedSettlement || sendCoordinatedSettlement;
      }
      const currentAction = isCurrentAction();
      if (kind === 'send' && e?.cascadeRestoreByToken && e?.cascadeRestoreBatched === true) {
        historyDiag('SEND_CASCADE_FOLLOWER_SKIP tab=' + actionTabId.slice(-12)
          + ' handoff=' + (sendHandoffId || '-')
          + ' ownerToken=' + e.cascadeRestoreByToken);
        sendHandoffId = null;
        return;
      }
      if (!currentAction && kind !== 'send') {
        console.log('[' + runtime.logPrefix + '] stale action error ignored tab=' + actionTabId.slice(-12)
          + ' kind=' + kind + ' actionSeq=' + actionSeq + ' currentSeq=' + actionSeqRef.current);
        return;
      }
      const cascadeHandoffIds = Array.isArray(e?.cancelledFollowerHandoffIds)
        ? [sendHandoffId, ...e.cancelledFollowerHandoffIds].filter(Boolean) as string[]
        : [];
      if (kind === 'send' && !sendOwnershipTransferred && cascadeHandoffIds.length > 1) {
        const handoffs = getHistoryPromptHandoffsSnapshot(actionTabId);
        const byId = new Map(handoffs.map((handoff) => [handoff.handoffId, handoff]));
        const snapshots = cascadeHandoffIds
          .map((handoffId) => byId.get(handoffId))
          .filter(Boolean) as Array<{
            handoffId: string;
            authoringText: string;
            authoringChips: readonly Readonly<Record<string, any>>[];
            authoringImagePaths: readonly Readonly<HistoryPromptDraftImageRef>[];
          }>;
        if (snapshots.length === cascadeHandoffIds.length) {
          const merged = mergeFailedHistoryAuthoringSnapshots({
            currentText: useUIStore.getState().historyPromptDrafts[actionTabId] || '',
            currentImages: useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
            currentChips: useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
            snapshots: snapshots.map((snapshot) => ({
              text: snapshot.authoringText,
              images: snapshot.authoringImagePaths,
              chips: snapshot.authoringChips,
            })),
            createChipId: (chip: HistoryPromptDraftChip) => createComposerChipId(chip.kind),
          });
          const mergedText = merged.text;
          const mergedImages = merged.images;
          const mergedChips = merged.chips as HistoryPromptDraftChip[];
          applyHistoryComposerSnapshot({
            ownerTabId: actionTabId,
            text: mergedText,
            images: mergedImages,
            chips: mergedChips,
            selectionStart: mergedText.length,
            history: 'external',
            userEvent: 'input.complete',
          });
          setHistoryComposerView(actionTabId, {
            selectionStart: mergedText.length,
            selectionEnd: mergedText.length,
            scrollTop: 0,
          });
          flushHistoryComposerDrafts();
          flushHistoryComposerView();
          for (const followerId of e.cancelledFollowerHandoffIds) {
            retractHistoryPromptHandoff(actionTabId, followerId, 'history-context-head-failed');
            onPromptStatusChange(followerId, 'failed', 'history-context-head-failed');
          }
          clearedPromptText = null;
          clearedPromptImages = [];
          clearedPromptChips = [];
          cascadeBatchRestored = true;
          setDraftWarning('Context was not recorded. Accepted drafts were restored in their original order.');
          historyDiag('SEND_CASCADE_RESTORE tab=' + actionTabId.slice(-12)
            + ' handoffs=' + cascadeHandoffIds.join(',')
            + ' chars=' + mergedText.length);
        }
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
        if (!sendOwnershipTransferred && !cascadeBatchRestored) {
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
        reportError(e, {
          action: kind,
          toolType: runtime.toolType,
          handoffId: sendHandoffId || undefined,
          sendAttemptId: sendFailureResult?.sendAttemptId || sendFailureResult?.attemptId,
          sendOperationKey: sendFailureResult?.sendOperationKey || sendFailureResult?.operationKey,
          statusAtSend: sendIncidentStatusAtSend || undefined,
          effectiveStatusAtSend: sendFailureResult?.effectiveStatusAtSend,
          submitted: typeof sendFailureResult?.submitted === 'boolean'
            ? sendFailureResult.submitted
            : undefined,
          pasteWritten: typeof sendFailureResult?.pasteWritten === 'boolean'
            ? sendFailureResult.pasteWritten
            : sendRefusalPasteWritten,
          code: sendFailureResult?.code,
          images: sendIncidentImages,
          chips: sendIncidentChips,
          promptText: sendIncidentPromptText,
        });
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
      if (isCurrentAction()
        && !keepInterruptAwait
        && !(kind === 'send' && coordinatedSendToken)) {
        actionInFlightRef.current = false;
        activeActionKindRef.current = null;
        if (kind === 'stop' || recordWithoutReply) {
          processStopInFlightRef.current = false;
        }
        setBusyAction(null);
      }
      if (kind === 'send' && coordinatedSendToken) {
        if (deferredSendRollback) {
          if (sendCoordinatedSettlement?.stopped) {
            restoreClearedSendSnapshot('post-paste-stop-proved');
          } else {
            historyDiag('SEND_ROLLBACK_WITHHELD tab=' + actionTabId.slice(-12)
              + ' handoff=' + (sendHandoffId || '-')
              + ' reason=stop-not-proved'
              + ' settlement=' + (sendCoordinatedSettlement?.reason || '-'));
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
  }, [applyHistoryComposerSnapshot, busyAction, cwd, flushHistoryComposerDrafts, flushHistoryComposerView, onPromptStatusChange, onPromptSubmitted, prepareHistoryPromptForSend, prompt, readTerminalDraft, refreshHistoryWithUpdating, refreshPresence, reportError, resumeMaterialized, runtime, sessionId, setHistoryComposerView, setHistoryPromptDraft, setStatusFrom, tabId]);

  useEffect(() => {
    const submitComposer = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        recordWithoutReply?: boolean;
      }>).detail;
      if (detail?.tabId !== tabId) return;
      void runAction('send', {
        recordWithoutReply: detail.recordWithoutReply === true,
      });
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
  const coordinatedComposerAction = getCoordinatedAgentAction(tabId);
  const recordContextAcceptsFollowup = busyAction === 'send'
    && coordinatedComposerAction?.recordWithoutReply === true
    && coordinatedComposerAction.stopRequestedAt === null;
  // A lifecycle Stop normally locks authoring. Recording context is different:
  // the Stop belongs to the accepted head prompt, while History remains the
  // owner of later authoring and may queue another immutable PREPARING intent.
  const localStopInProgress = busyAction === 'stop'
    || (status === 'stopping' && !recordContextAcceptsFollowup);
  const effectiveStopping = !recordContextAcceptsFollowup
    && (localStopInProgress || rawActiveLifecycle?.kind === 'stopping');
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
  const sendControlsLocked = controlsLocked
    && !(busyAction === 'resume' && status === 'starting')
    && !recordContextAcceptsFollowup;
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
  const derivedDraftImageNotice = useMemo(
    () => historyDraftImageNotice(prompt, draftImages),
    [draftImages, prompt]
  );
  const derivedDraftWarning = derivedDraftImageNotice?.message || null;
  const historyImagePastePending = prompt.includes(HISTORY_IMAGE_PENDING_MARKER);
  const draftImagePreflightKey = useMemo(
    () => historyDraftImagePreflightKey(tabId, prompt, draftImages),
    [draftImages, prompt, tabId],
  );
  const lastDraftImagePreflightRef = useRef('');
  useEffect(() => {
    if (!draftImagePreflightKey || historyImagePastePending) return;
    if (draftImages.every((ref) => ref.availability === 'missing')) return;
    if (lastDraftImagePreflightRef.current === draftImagePreflightKey) return;
    lastDraftImagePreflightRef.current = draftImagePreflightKey;
    const expectedText = prompt;
    const expectedImages = draftImages.map((ref) => ({ ...ref }));
    let cancelled = false;
    void ipcRenderer.invoke('prompt-queue:materialize-image-refs', {
      refs: expectedImages,
    }).then((result: any) => {
      if (cancelled || tabIdRef.current !== tabId) return;
      const returnedRefs = Array.isArray(result?.refs)
        ? result.refs as HistoryPromptDraftImageRef[]
        : [];
      const expectedIds = collectPromptImageRefIds(expectedText);
      const returnedIds = new Set(returnedRefs.map((ref) => Number(ref.id)));
      if (Array.from(expectedIds).some((id) => !returnedIds.has(id))) {
        console.warn('[HistoryImages:Preflight] incomplete result tab=' + tabId.slice(-12)
          + ' expected=' + expectedIds.size + ' returned=' + returnedIds.size);
        return;
      }
      const state = useUIStore.getState();
      const currentText = state.historyPromptDrafts[tabId] || '';
      const currentImages = state.historyPromptDraftImages[tabId] || [];
      const currentKey = historyDraftImagePreflightKey(tabId, currentText, currentImages);
      if (currentKey !== draftImagePreflightKey) {
        console.log('[HistoryImages:Preflight] stale result ignored tab=' + tabId.slice(-12));
        return;
      }
      const nextImages = retainHistoryDraftImages(currentText, returnedRefs);
      const nextKey = historyDraftImagePreflightKey(tabId, currentText, nextImages);
      lastDraftImagePreflightRef.current = nextKey;
      if (nextKey === currentKey) return;
      setHistoryPromptDraft(tabId, currentText, {
        images: nextImages,
        preserveChips: true,
      });
      const inspection = inspectPromptImageAttachments(currentText, nextImages);
      console.warn('[HistoryImages:Preflight] availability changed tab=' + tabId.slice(-12)
        + ' unavailable=' + inspection.issues.filter((issue: any) => !issue.blocking).length
        + ' blocking=' + inspection.issues.filter((issue: any) => issue.blocking).length);
    }).catch((cause: any) => {
      if (cancelled) return;
      console.warn('[HistoryImages:Preflight] check failed tab=' + tabId.slice(-12)
        + ' error=' + String(cause?.message || cause));
    });
    return () => { cancelled = true; };
  }, [draftImagePreflightKey, draftImages, historyImagePastePending, prompt, setHistoryPromptDraft, tabId]);
  const promptImageMarkerRanges = useMemo(
    () => getPromptImageMarkerHighlightRanges(prompt, draftImages) as Array<{ start: number; end: number; id: number }>,
    [draftImages, prompt],
  );
  const promptPasteMarkerRanges = useMemo(
    () => getPasteMarkerHighlightRanges(prompt, draftChips) as Array<{ start: number; end: number; id: string }>,
    [draftChips, prompt],
  );
  // Opt+Arrow crosses an opaque marker in ONE step (see composerWordMotion).
  // Both marker families reuse the spans already computed for the highlight
  // layer, so motion can never disagree with what is painted.
  const handleComposerWordMotion = useCallback((
    event: ComposerWordMotionEvent,
  ): boolean => applyMarkerAwareWordMotion(
    event,
    [...promptImageMarkerRanges, ...promptPasteMarkerRanges],
    (selection) => { promptCaretRef.current = selection; },
  ), [promptImageMarkerRanges, promptPasteMarkerRanges]);
  const draftImagePreviewUrls = useComposerImagePreviews(draftImages);
  const promptComposerTokens = useMemo<ComposerInlineToken[]>(() => {
    const refsById = new Map(draftImages.map((ref) => [Number(ref.id), ref]));
    const result: ComposerInlineToken[] = [
      ...promptImageMarkerRanges.map((range) => ({
        id: `image:${range.id}:${range.start}`,
        from: range.start,
        to: range.end,
        kind: 'image' as const,
        label: `image #${range.id}`,
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
    result.push(...getPromptImageStatusTokenRanges(prompt).map((range) => ({
      id: `status:${range.start}`,
      from: range.start,
      to: range.end,
      kind: range.kind,
      label: range.label,
      replace: range.replace,
    })));
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
    || status === 'starting'
    || recordContextAcceptsFollowup
    || canStartOrResume;
  const canAcceptSubmitIntent = canAcceptPrompt
    && !pendingQuestion
    && !sendControlsLocked
    && !historyImagePastePending
    && !derivedDraftImageNotice?.blocking;
  // Standalone Codex slash is a local TUI action, not a rollout user_message.
  // History still shows the user's command, but delivery is proven by the
  // specialized slash transaction (exact input frame + Enter), never by the
  // ordinary conversation audit. Command output may remain terminal-only.
  const canSend = canAcceptSubmitIntent
    && activeInputStatus === null
    && (prompt.trim().length > 0 || draftChips.length > 0);
  const canGrabDraft = (status === 'active' || status === 'busy') && !pendingQuestion && !controlsLocked;
  const canInterruptTurn = isTurnBusy && !controlsLocked;
  const canStopProcess = busyAction === 'send'
    || ((status === 'active' || status === 'busy' || status === 'starting')
      && !effectiveStopping
      && !busyAction);
  const visibleDraftWarning = draftWarning || derivedDraftWarning;
  const draftNoticeMeta = visibleDraftWarning ? getHistoryDraftNoticeMeta(visibleDraftWarning) : null;
  // Attachment problems are authoring state, not terminal status. Keep them
  // out of the lifecycle row, but persist them immediately above the input so
  // the user sees the exact slot/path before choosing Send.
  const isImageDraftNotice = draftNoticeMeta?.label === 'Image needs attention'
    || draftNoticeMeta?.label === 'Attaching image';
  // "Saving image attachment…" is PROGRESS, not a problem: it appears for the
  // fraction of a second between the paste and the file landing on disk, and it
  // clears itself. Announcing it as a warning toast put an orange ⚠ in the
  // corner of a perfectly normal paste — the exact false alarm the user hit.
  const isImageProgressNotice = draftNoticeMeta?.label === 'Attaching image';
  const inlineDraftNoticeMeta = isImageDraftNotice
    || !historyDraftNoticeBelongsOnComposerBorder(visibleDraftWarning)
    ? null
    : draftNoticeMeta;
  const persistentImageDraftNotice = derivedDraftImageNotice && !derivedDraftImageNotice.progress
    ? derivedDraftImageNotice
    // Red means BLOCKED, so a report that does not block must not be painted red.
    //
    // This branch covers image messages that arrive as plain text rather than
    // from the draft inspection (an image that stayed behind in the terminal, a
    // clipboard save that failed, a picture returned by Rewind). They read as
    // "we already dealt with it — an error marker is in the text, fix or replace
    // it", and Send stays available: only `derivedDraftImageNotice.blocking`
    // actually gates it (see `canAcceptSubmitIntent`). Hardcoding `blocking:true`
    // gave them the red `role="alert"` reserved for "you cannot send this",
    // announcing a barrier that does not exist.
    : (isImageDraftNotice && !isImageProgressNotice && visibleDraftWarning
      ? { message: visibleDraftWarning, blocking: false, progress: false }
      : null);
  const historyImageNoticeBanner = persistentImageDraftNotice ? (
    <div
      role={persistentImageDraftNotice.blocking ? 'alert' : 'status'}
      data-history-image-notice
      data-blocking={persistentImageDraftNotice.blocking ? 'true' : 'false'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        width: '100%',
        minWidth: 0,
        padding: '6px 8px',
        border: '1px solid ' + (persistentImageDraftNotice.blocking
          ? 'rgba(248, 113, 113, 0.48)'
          : 'rgba(251, 191, 36, 0.42)'),
        borderRadius: 7,
        background: persistentImageDraftNotice.blocking
          ? 'rgba(127, 29, 29, 0.18)'
          : 'rgba(217, 119, 6, 0.14)',
        color: persistentImageDraftNotice.blocking ? '#fecaca' : '#fcd34d',
        fontSize: aiSecondaryFontSize,
        lineHeight: 1.35,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        overflowWrap: 'anywhere',
        boxSizing: 'border-box',
      }}
    >
      <AlertTriangle size={13} style={{ flex: '0 0 auto', marginTop: 1 }} />
      <span>{persistentImageDraftNotice.message}</span>
    </div>
  ) : undefined;

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
      // `suppressWindowEscape` still owns transient local curtains. The
      // external ref adds pane-focus ownership; it does not replace that
      // existing safety gate.
      if (suppressWindowEscape || effectiveSuppressWindowEscapeRef.current) return;
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
  }, [canInterruptTurn, agentInputSurface, effectiveSuppressWindowEscapeRef, pendingQuestion, runAction, suppressWindowEscape, tabId, terminalOpen, terminalIsPrimary]);

  useEffect(() => {
    const insertIntoComposer = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        text?: string;
        source?: string;
        kind?: HistoryPromptDraftChip['kind'];
        label?: string;
        sourceKey?: string;
        inheritanceDepth?: number;
        inheritanceParentLabel?: string;
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
          inheritanceDepth: detail.inheritanceDepth,
          inheritanceParentLabel: detail.inheritanceParentLabel,
          createdAt: Date.now(),
        };
        const nextChips = upsertComposerChip(currentChips, chip) as HistoryPromptDraftChip[];
        const currentView = promptCaretRef.current;
        applyHistoryComposerSnapshot({
          ownerTabId: tabId,
          text: currentText,
          images: useUIStore.getState().historyPromptDraftImages[tabId] || [],
          chips: nextChips,
          selectionStart: currentView.start,
          selectionEnd: currentView.end,
          history: 'add',
          userEvent: 'input',
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
      const caret = start + text.length;
      applyHistoryComposerSnapshot({
        ownerTabId: tabId,
        text: next,
        images: retainHistoryDraftImages(
          next,
          useUIStore.getState().historyPromptDraftImages[tabId] || [],
        ),
        chips: useUIStore.getState().historyPromptDraftChips[tabId] || [],
        selectionStart: caret,
        history: 'add',
        userEvent: 'input',
      });
      requestAnimationFrame(() => {
        const currentElement = promptTextareaRef.current;
        if (!currentElement) return;
        currentElement.focus();
        currentElement.setSelectionRange(caret, caret);
      });
    };
    window.addEventListener('history-panel:composer-insert', insertIntoComposer);
    return () => window.removeEventListener('history-panel:composer-insert', insertIntoComposer);
  }, [applyHistoryComposerSnapshot, effectiveStopping, isCancellingTurn, rewindLocked, tabId]);

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
      applyHistoryComposerSnapshot({
        ownerTabId: tabId,
        text: nextText,
        images: retainHistoryDraftImages(
          nextText,
          useUIStore.getState().historyPromptDraftImages[tabId] || [],
        ),
        chips: retainPasteChipsForText(
          nextText,
          useUIStore.getState().historyPromptDraftChips[tabId] || [],
        ) as HistoryPromptDraftChip[],
        selectionStart: start,
        history: 'add',
        userEvent: 'delete.cut',
      });
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
  }, [applyHistoryComposerSnapshot, draftChips, draftImages, effectiveStopping, isCancellingTurn, rewindLocked, runtime.logPrefix, tabId]);

  const handleComposerImagePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Our own full-message snapshot is the authoritative representation of a
    // History copy. A user message can contain an image, and macOS may expose
    // an image flavor alongside the text/custom flavors. Looking at the image
    // flavor first reduced that whole message to one bitmap and discarded its
    // text, prompt chips and pasted-content bodies.
    const structuredSnapshot = normalizeHistoryMessageComposerSnapshot(
      readElectronComposerSnapshotClipboard(),
    );
    const hasImageItem = Array.from(event.clipboardData?.items || [])
      .some((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'));
    if (structuredSnapshot || !hasImageItem) {
      if (structuredSnapshot) {
        console.log('[' + runtime.logPrefix + ':clipboard] snapshot-paste selected tab=' + tabId.slice(-12)
          + ' nativeImage=' + (hasImageItem ? '1' : '0')
          + ' images=' + structuredSnapshot.imagePaths.length
          + ' chips=' + structuredSnapshot.chips.length);
        event.preventDefault();
        event.stopPropagation();
        if (isCancellingTurn || rewindLocked || effectiveStopping) {
          setDraftWarning('History input is temporarily locked');
          return;
        }
        const actionTabId = tabId;
        const element = event.currentTarget;
        const current = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
        const currentImages = useUIStore.getState().historyPromptDraftImages[actionTabId] || [];
        const currentChips = useUIStore.getState().historyPromptDraftChips[actionTabId] || [];
        const start = Math.max(0, Math.min(element.selectionStart ?? current.length, current.length));
        const end = Math.max(start, Math.min(element.selectionEnd ?? start, current.length));

        if (structuredSnapshot.imagePaths.length === 0) {
          const insertion = insertComposerSnapshotAtSelection({
            text: current,
            chips: currentChips,
            insertedText: structuredSnapshot.text,
            insertedChips: structuredSnapshot.chips,
            selectionStart: start,
            selectionEnd: end,
          });
          applyHistoryComposerSnapshot({
            ownerTabId: actionTabId,
            text: insertion.text,
            images: retainHistoryDraftImages(insertion.text, currentImages),
            chips: insertion.chips as HistoryPromptDraftChip[],
            selectionStart: insertion.caret,
            history: 'add',
            userEvent: 'input.paste',
          });
          setDraftWarning(null);
          console.log('[' + runtime.logPrefix + ':clipboard] snapshot-import tab=' + actionTabId.slice(-12)
            + ' images=0 chips=' + structuredSnapshot.chips.length);
          return;
        }

        if (current.includes(HISTORY_IMAGE_PENDING_MARKER)) {
          setDraftWarning('Wait for the current image to finish saving.');
          return;
        }
        const pendingText = current.slice(0, start) + HISTORY_IMAGE_PENDING_MARKER + current.slice(end);
        const pendingChips = retainPasteChipsForText(pendingText, currentChips) as HistoryPromptDraftChip[];
        const pendingCaret = start + HISTORY_IMAGE_PENDING_MARKER.length;
        applyHistoryComposerSnapshot({
          ownerTabId: actionTabId,
          text: pendingText,
          images: retainHistoryDraftImages(pendingText, currentImages),
          chips: pendingChips,
          selectionStart: pendingCaret,
          history: 'add',
          userEvent: 'input.paste',
        });
        void ipcRenderer.invoke('prompt-queue:materialize-image-refs', {
          refs: structuredSnapshot.imagePaths,
        }).then((materialized: { refs?: HistoryPromptDraftImageRef[] }) => {
          const latest = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
          const tokenStart = latest.indexOf(HISTORY_IMAGE_PENDING_MARKER);
          if (tokenStart < 0) return;
          const imageInsertion = insertPromptImageAttachments({
            text: latest,
            imagePaths: useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
            start: tokenStart,
            end: tokenStart + HISTORY_IMAGE_PENDING_MARKER.length,
            insertedText: structuredSnapshot.text,
            insertedImagePaths: materialized?.refs || [],
          });
          const remappedInsertedText = imageInsertion.text.slice(tokenStart, imageInsertion.caret);
          const insertion = insertComposerSnapshotAtSelection({
            text: latest,
            chips: useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
            insertedText: remappedInsertedText,
            insertedChips: structuredSnapshot.chips,
            selectionStart: tokenStart,
            selectionEnd: tokenStart + HISTORY_IMAGE_PENDING_MARKER.length,
          });
          applyHistoryComposerSnapshot({
            ownerTabId: actionTabId,
            text: insertion.text,
            images: retainHistoryDraftImages(insertion.text, imageInsertion.imagePaths),
            chips: insertion.chips as HistoryPromptDraftChip[],
            selectionStart: insertion.caret,
            history: 'replace',
            userEvent: 'input.complete',
          });
          setDraftWarning(imageInsertion.missingSourceIds.length > 0
            ? 'One or more copied images are unavailable. Missing slots were replaced with imageError.'
            : null);
          console.log('[' + runtime.logPrefix + ':clipboard] snapshot-import tab=' + actionTabId.slice(-12)
            + ' images=' + imageInsertion.addedImagePaths.length
            + ' imageMissing=' + imageInsertion.missingSourceIds.length
            + ' chips=' + structuredSnapshot.chips.length);
        }).catch((cause: any) => {
          const latest = useUIStore.getState().historyPromptDrafts[actionTabId] || '';
          if (!latest.includes(HISTORY_IMAGE_PENDING_MARKER)) return;
          const failedText = latest.replace(
            HISTORY_IMAGE_PENDING_MARKER,
            '[imageError: copied_message_image_import_failed]',
          );
          applyHistoryComposerSnapshot({
            ownerTabId: actionTabId,
            text: failedText,
            images: retainHistoryDraftImages(
              failedText,
              useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
            ),
            chips: retainPasteChipsForText(
              failedText,
              useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
            ) as HistoryPromptDraftChip[],
            selectionStart: failedText.length,
            history: 'replace',
            userEvent: 'input.complete',
          });
          setDraftWarning('Could not restore copied message images.');
          console.warn('[' + runtime.logPrefix + ':clipboard] snapshot-import failed tab='
            + actionTabId.slice(-12) + ' error=' + String(cause?.message || cause));
        });
        return;
      }
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
        const pendingCaret = start + HISTORY_IMAGE_PENDING_MARKER.length;
        applyHistoryComposerSnapshot({
          ownerTabId: actionTabId,
          text: pendingText,
          images: retainHistoryDraftImages(pendingText, currentImages),
          chips: pendingChips,
          selectionStart: pendingCaret,
          history: 'add',
          userEvent: 'input.paste',
        });
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
          const textarea = promptTextareaRef.current;
          const preserveSelection = textarea?.isFocused() === true
            && textarea?.getAttribute('data-history-composer-tab-id') === actionTabId;
          const selectionStart = preserveSelection ? (textarea?.selectionStart ?? pendingCaret) : pendingCaret;
          const selectionEnd = preserveSelection ? (textarea?.selectionEnd ?? selectionStart) : selectionStart;
          const remappedSelection = remapPromptImageSelectionAfterReplacement({
            selectionStart,
            selectionEnd,
            replacedStart: tokenStart,
            replacedEnd: tokenStart + HISTORY_IMAGE_PENDING_MARKER.length,
            insertionCaret: composerInsertion.caret,
          });
          applyHistoryComposerSnapshot({
            ownerTabId: actionTabId,
            text: composerInsertion.text,
            images: retainHistoryDraftImages(composerInsertion.text, imageInsertion.imagePaths),
            chips: composerInsertion.chips as HistoryPromptDraftChip[],
            selectionStart: remappedSelection.start,
            selectionEnd: remappedSelection.end,
            history: 'replace',
            userEvent: 'input.complete',
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

          if (preserveSelection) {
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
          const failedImages = retainHistoryDraftImages(
              failedText,
              useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
            );
          const failedChips = retainPasteChipsForText(
              failedText,
              useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
            ) as HistoryPromptDraftChip[];
          applyHistoryComposerSnapshot({
            ownerTabId: actionTabId,
            text: failedText,
            images: failedImages,
            chips: failedChips,
            selectionStart: failedText.length,
            history: 'replace',
            userEvent: 'input.complete',
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
      const nextImages = retainHistoryDraftImages(
          insertion.text,
          useUIStore.getState().historyPromptDraftImages[tabId] || [],
        );
      const caretAfterMarker = insertion.caret;
      applyHistoryComposerSnapshot({
        ownerTabId: tabId,
        text: insertion.text,
        images: nextImages,
        chips: insertion.chips as HistoryPromptDraftChip[],
        selectionStart: caretAfterMarker,
        history: 'add',
        userEvent: 'input.paste',
      });
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
    const pendingCaret = start + HISTORY_IMAGE_PENDING_MARKER.length;
    applyHistoryComposerSnapshot({
      ownerTabId: actionTabId,
      text: pendingText,
      images: retainHistoryDraftImages(pendingText, currentImages),
      chips: pendingChips,
      selectionStart: pendingCaret,
      history: 'add',
      userEvent: 'input.paste',
    });
    // Saving normally takes a fraction of a second. Do not turn that normal
    // progress into a warning-looking status; only actual failures surface.
    setDraftWarning(null);
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
          applyHistoryComposerSnapshot({
            ownerTabId: actionTabId,
            text: failedText,
            images: retainHistoryDraftImages(
              failedText,
              useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
            ),
            chips: retainPasteChipsForText(
              failedText,
              useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
            ) as HistoryPromptDraftChip[],
            selectionStart: tokenStart + errorMarker.length,
            history: 'replace',
            userEvent: 'input.complete',
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
        const tokenEnd = tokenStart + HISTORY_IMAGE_PENDING_MARKER.length;
        const remappedSelection = remapPromptImageSelectionAfterReplacement({
          selectionStart,
          selectionEnd,
          replacedStart: tokenStart,
          replacedEnd: tokenEnd,
          insertionCaret: insertion.caret,
        });
        applyHistoryComposerSnapshot({
          ownerTabId: actionTabId,
          text: insertion.text,
          images: insertion.imagePaths as HistoryPromptDraftImageRef[],
          chips: retainPasteChipsForText(
            insertion.text,
            useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
          ) as HistoryPromptDraftChip[],
          selectionStart: remappedSelection.start,
          selectionEnd: remappedSelection.end,
          history: 'replace',
          userEvent: 'input.complete',
        });
        if (tabIdRef.current === actionTabId) setDraftWarning(null);
        console.log('[' + runtime.logPrefix + ':images] clipboard-save ready tab=' + actionTabId.slice(-12)
          + ' id=' + (insertion.addedImagePaths[0]?.id || '-')
          + ' asset=' + (saved.assetId || '-')
          + ' bytes=' + (saved.size || 0));

        if (preserveSelection) {
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
        applyHistoryComposerSnapshot({
          ownerTabId: actionTabId,
          text: failedText,
          images: retainHistoryDraftImages(
            failedText,
            useUIStore.getState().historyPromptDraftImages[actionTabId] || [],
          ),
          chips: retainPasteChipsForText(
            failedText,
            useUIStore.getState().historyPromptDraftChips[actionTabId] || [],
          ) as HistoryPromptDraftChip[],
          selectionStart: failedText.length,
          history: 'replace',
          userEvent: 'input.complete',
        });
        if (tabIdRef.current === actionTabId) {
          setDraftWarning('Could not save the clipboard image. Copy it again and retry.');
        }
        console.warn('[' + runtime.logPrefix + ':images] clipboard-save exception tab=' + actionTabId.slice(-12)
          + ' error=' + String(cause?.message || cause));
      });
  }, [aiComposerChipThreshold, applyHistoryComposerSnapshot, effectiveStopping, isCancellingTurn, rewindLocked, runtime.logPrefix, tabId]);

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
    applyHistoryComposerSnapshot({
      ownerTabId: tabId,
      text: restored.text,
      images: retainHistoryDraftImages(
        restored.text,
        useUIStore.getState().historyPromptDraftImages[tabId] || [],
      ),
      chips: remainingChips,
      selectionStart: restored.caret,
      history: 'add',
      userEvent: 'input',
    });
    setPreviewChipId(null);
    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (!currentTextarea) return;
      currentTextarea.focus();
      currentTextarea.setSelectionRange(restored.caret, restored.caret);
    });
  }, [applyHistoryComposerSnapshot, effectiveStopping, isCancellingTurn, rewindLocked, tabId]);

  const discardComposerChip = useCallback((chipId: string) => {
    const state = useUIStore.getState();
    const currentText = state.historyPromptDrafts[tabId] || '';
    const selection = promptCaretRef.current;
    applyHistoryComposerSnapshot({
      ownerTabId: tabId,
      text: currentText,
      images: state.historyPromptDraftImages[tabId] || [],
      chips: (state.historyPromptDraftChips[tabId] || []).filter((chip) => chip.id !== chipId),
      selectionStart: selection.start,
      selectionEnd: selection.end,
      history: 'add',
      userEvent: 'delete',
    });
    setPreviewChipId((current) => current === chipId ? null : current);
    requestAnimationFrame(() => promptTextareaRef.current?.focus());
  }, [applyHistoryComposerSnapshot, tabId]);

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
    const caret = range.start + replacement.length;
    applyHistoryComposerSnapshot({
      ownerTabId: tabId,
      text: nextText,
      images: retainHistoryDraftImages(
        nextText,
        useUIStore.getState().historyPromptDraftImages[tabId] || [],
      ),
      chips: currentChips.filter((item) => item.id !== chip.id),
      selectionStart: caret,
      history: 'add',
      userEvent: replacement ? 'input' : 'delete',
    });
    setPreviewChipId((current) => current === chip.id ? null : current);
    requestAnimationFrame(() => {
      const textarea = promptTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  }, [applyHistoryComposerSnapshot, effectiveStopping, isCancellingTurn, rewindLocked, tabId]);

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

  // Прикреплённые промпты живут НАД рамкой, в том же слое, что и плашка
  // состояния, — нижней полосой, вплотную к рамке. Это ровно то, на что
  // договорились: «то, что касается прикреплённых промптов, их по-хорошему
  // перекреплять всё выше, тоже в позиции абсолют… перекреплять также над
  // рамкой», и порядок снизу вверх — черновик/промпты ближе к полю, системные
  // статусы выше.
  //
  // Внутрь рамки их отдавать нельзя по той же причине, по которой оттуда убрали
  // весь текст переменной длины: строка над полем — слот фиксированной высоты,
  // и чип с рамкой в неё не влезает. В прошлой версии они уходили в `chips`
  // общей поверхности и рисовались ПОВЕРХ поля ввода, перекрывая набранный
  // текст (юзер: «что это за хуйня… как ты вообще додумался разместить туда
  // промпты»). Над рамкой места сколько угодно, и пусто он не занимает ничего.
  const composerPromptChips = useMemo(
    () => draftChips.filter((chip) => chip.kind === 'prompt'),
    [draftChips],
  );
  // Раскрытие тела промпта делит одну область предпросмотра со вставками, и
  // ЭТА область принадлежит общей поверхности композера. Поэтому сами чипы
  // рисуем сами (над рамкой), а их раскрытое тело по-прежнему отдаём
  // поверхности — иначе клик по чипу молча ничего не делал бы.
  const composerPromptChipsForPreview = useMemo<AIComposerSurfaceChip[]>(
    () => composerPromptChips.map((chip) => ({
      id: chip.id,
      kind: chip.kind,
      label: chip.label || 'PROMPT',
      text: chip.text,
    })),
    [composerPromptChips],
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
        collapsedPreview: fileName,
        imagePreview: {
          src: selected ? draftImageDetailPreview.url : undefined,
          loading: selected && draftImageDetailPreview.loading,
          error: selected ? draftImageDetailPreview.error : null,
          path: ref?.path,
          assetId: ref?.assetId,
          size: ref?.size,
          alt: `Image attachment #${range.id}`,
        },
      };
    });
  }, [draftImageDetailPreview, draftImages, previewChipId, promptImageMarkerRanges]);
  const composerInlineChipsForPreview = useMemo(
    () => [
      ...composerPromptChipsForPreview,
      ...composerInlinePasteChipsForPreview,
      ...composerInlineImageChipsForPreview,
    ],
    [
      composerInlineImageChipsForPreview,
      composerInlinePasteChipsForPreview,
      composerPromptChipsForPreview,
    ],
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
  // The input phase comes from the exact handoff, never from the generic
  // button/action flag. This prevents a completed send from briefly
  // reappearing as SENDING while the async action is unwinding.
  const displayedInputStatus = activeInputStatus;
  const inputStatusPresentation = historyPromptHandoffStatusPresentation(displayedInputStatus);
  const terminalStatusTitle = unifiedTransientStatus?.title || activeLifecycle?.title || meta.label;
  const terminalStatusDescription =
    unifiedTransientStatus?.description ||
    activeLifecycle?.description ||
    basicStatusDescription[status];
  // Судьба ОТПРАВЛЕННОГО сообщения в плашку больше не попадает: она уже
  // показана бейджем над самим сообщением в истории (`MessageStatusBadge` у
  // каждой записи), и там ей самое место — она относится к конкретной записи, а
  // не к терминалу. В плашке она давала строку вида «Ready / confirming», где
  // первое слово — паразит: готовность не событие и сама по себе не
  // показывается, но приставка к статусу отправки заставляла её появиться.
  // Пользователь: «"confirming" для сообщения не должны показываться, поскольку
  // в history они показываются для каждого сообщения отдельно».
  //
  // В подсказке при наведении статус отправки остаётся: там он не занимает
  // места на экране и отвечает на прямой вопрос «а что с моей отправкой».
  const statusTitle = statusCopied ? 'COPIED' : terminalStatusTitle;
  const statusDescription = inputStatusPresentation
    ? terminalStatusDescription + '\n' + inputStatusPresentation.title
    : terminalStatusDescription;
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
  // Плашка = ТО, ЧТО ПРОИСХОДИТ с терминалом: запуск, остановка, прерывание,
  // сжатие контекста, неподтверждённое состояние. Готовность сюда не входит —
  // «всё готово» означает, что не происходит ничего, и показывать это нечего.
  // Статуса отправки здесь тоже нет: он висел приставкой и вытаскивал за собой
  // слово «Ready», хотя своего права появиться у того не было.
  const showStatusText = statusCopied
    || !!unifiedTransientStatus
    || !!activeLifecycle
    || status === 'starting'
    || status === 'stopping'
    || (status === 'unknown' && !presenceResolving);
  const showBusyLoader = status === 'busy' || isPasteBusy;
  const activityTimingOwnerMatches = activityTimingOwnerKeyRef.current === tabId + ':' + toolType;
  const displayedActivityTiming = useMemo<HistoryActivityTiming | null>(() => (
    !activityTimingOwnerMatches
      ? null
      : activityTiming?.state === 'running'
      ? activityTiming
      : pasteActivityStartedAt !== null
        ? {
            state: 'running',
            intervalId: null,
            toolType,
            sessionId: null,
            startTs: pasteActivityStartedAt,
            endTs: null,
            durationMs: null,
          }
        : activityTiming
  ), [activityTiming, activityTimingOwnerMatches, pasteActivityStartedAt, toolType]);
  // Controls own the exact activity/preflight signals, but no longer render
  // their clock. Publish edge changes to the transcript; the Footer owns the
  // one-second tick so this very large component does not rerender each second.
  useEffect(() => {
    onResponseTimingChange?.({ tabId, toolType, timing: displayedActivityTiming });
  }, [displayedActivityTiming, onResponseTimingChange, tabId, toolType]);
  useEffect(() => () => {
    onResponseTimingChange?.({ tabId, toolType, timing: null });
  }, [onResponseTimingChange, tabId, toolType]);
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
  // The status control is now the session's start/stop, not a surface switch.
  //
  // It used to toggle the terminal, which put two unrelated jobs on one button:
  // "what is happening" and "show me the other panel". The surface toggles moved
  // to the Run after rail, where they sit as one pair, and this control kept the
  // half that actually belongs next to a status indicator — acting on the thing
  // whose state it reports.
  //
  // An unavailable lifecycle action stays unavailable. It must not silently
  // turn the same ordinary click into an unrelated clipboard command while
  // presence/startup state is converging. Diagnostics remain on right-click.
  const statusPrimaryAction: 'stop' | 'start' | 'pending' =
    resolveHistoryTerminalActivityAction({
      canInterruptTurn,
      canStopProcess,
      canStartOrResume,
    });
  const activateUnifiedStatus = useCallback(() => {
    if (statusPrimaryAction === 'stop') {
      // Interrupt the answer while one is running; otherwise stop the process.
      void runAction(canInterruptTurn ? 'interrupt' : 'stop');
      return;
    }
    if (statusPrimaryAction === 'start') {
      void runAction('resume');
      return;
    }
    historyDiag('DROP_ACTION tab=' + tabId.slice(-12)
      + ' kind=status-control reason=lifecycle-action-pending status=' + status);
  }, [canInterruptTurn, runAction, status, statusPrimaryAction, tabId]);

  // History owns PTY state, but the top line follows the SDK presentation:
  // one compact terminal/status affordance plus transient authoring notices.
  // Start/Resume/Send/Stop stay in the workspace control bar below the surface.
  // The toggle always points at the SECONDARY surface, so its wording follows
  // the layout: History-primary hides/opens the terminal, terminal-primary
  // hides/opens the transcript. Same control, same "show me the other one".
  const secondarySurfaceLabel = terminalIsPrimary ? 'History' : 'terminal';
  const statusActionLabel = statusPrimaryAction === 'stop'
    ? (canInterruptTurn ? 'Остановить текущий ответ' : 'Остановить процесс')
    : statusPrimaryAction === 'start'
      ? (sessionId ? 'Возобновить сессию' : 'Запустить ' + runtime.label)
      : (presenceResolving || status === 'unknown'
        ? 'Состояние агента уточняется'
        : 'Нет доступного действия; детали — правым кликом');
  // Status sits ON the frame's top edge, centred — like a caption engraved into
  // a border, not a line of layout above it.
  //
  // Two constraints decided this. It cannot live IN the row: the row is a fixed
  // slot of fixed-size controls, and text of unbounded length ("SENDING",
  // "CLAUDE SESSION INTERRUPTED", a failure with a RETRY button) shoves every
  // button sideways and back on each change of state. And it cannot take a line
  // of its own above the frame: that line already belongs to attachments, and a
  // second one would raise the whole composer.
  //
  // Absolutely positioned astride the border, it costs zero layout in both
  // directions. The chip paints the composer's own background so the border
  // passes behind it and stops at its edges — the text reads as part of the
  // frame rather than as something floating over the transcript.
  // No `&& !error` on the warning and the rewind badge any more: a failure is a
  // toast now, in a different corner of the screen, so it can no longer collide
  // with them. Suppressing them was only ever about not stacking two red things
  // in the same place.
  const hasFloatingStatus = showStatusText
    || !!activeLifecycle
    || (!!visibleDraftWarning && !!inlineDraftNoticeMeta)
    || rewindPreviewActive;
  const historyComposerFloatingStatus = !hasFloatingStatus ? null : (
    <div
      data-history-composer-floating-status
      style={{
        position: 'absolute',
        // LEFT, aligned with the frame's own content inset — a service caption
        // starts where every other service line in this feed starts. The
        // centred/right placements read as a floating widget, not a label of
        // this frame (user).
        left: 12,
        // The frame's own top edge. The overlay slot ends exactly there, so the
        // chip is pulled down by half its height to straddle the line.
        bottom: 0,
        transform: 'translate(0, 50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: 'calc(100% - 24px)',
        padding: '0 8px',
        // Same ground as the composer, so the border disappears behind the chip
        // instead of striking through the text. Taken from the frame's own
        // token — a literal here would show as a seam the moment the composer
        // background changes.
        background: 'var(--cb-composer-bg, #0f0f0f)',
        borderRadius: 4,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        // EXACTLY the size of a group header's second line (`.hp-history-group-detail`,
        // 0.82em of the transcript font — the «└ …» caption under «Searched 5
        // queries»). That line is the quietest service text in the feed, and this
        // chip is the same kind of thing: an annotation of the frame, not content.
        //
        // Two earlier values were both wrong for the same reason — they were
        // picked as absolute numbers instead of derived from that one reference.
        // 0.9em is a tool-card LABEL, a step louder, and at the default 13px it
        // lands within a pixel of the chat text itself, so the chip read as a
        // message rather than as a caption (user, twice: «почему он по размеру
        // такой, как у меня текст в чате»).
        //
        // No `Math.max` floor here on purpose: a floor would hold the chip at
        // 10px while the reference line kept shrinking with the user's transcript
        // setting, and the two would visibly diverge again at small sizes.
        fontSize: historyTranscriptFontSize * HISTORY_SERVICE_TEXT_RATIO,
        // Set on the CONTAINER so every part inside inherits it — status, timer,
        // hints, badges. Each part used to carry its own 600-750, which is how the
        // chip stayed bold after the size was fixed.
        fontWeight: HISTORY_SERVICE_TEXT_WEIGHT,
        lineHeight: 1.35,
        whiteSpace: 'nowrap',
        // Buttons inside (dismiss / retry) must stay clickable; the chip itself
        // is not a target.
        pointerEvents: 'none',
      }}
    >
      <span style={{ display: 'contents', pointerEvents: 'auto' }}>
        {showStatusText && (
          <span
            data-agent-status-title
            style={{
              color: statusAccent,
              // Weight inherited from the chip. The status is distinguished by its
              // COLOUR (statusAccent) — adding weight on top made the one part the
              // user reads most the loudest thing on the frame.
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            }}
          >
            {presentStatusTitle(statusTitle)}
          </span>
        )}
        {activeLifecycle?.kind === 'error' && (
          <span
            role="status"
            data-agent-lifecycle-description
            title={activeLifecycle.detail || activeLifecycle.description}
            style={{
              color: '#fca5a5',
              // The chip straddles a 1px border; a 20px line-height would push
              // it off the line it is supposed to sit on.
              lineHeight: 1.35,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
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
              width: 16,
              height: 16,
              padding: 0,
              borderRadius: 4,
              border: '1px solid rgba(248, 113, 113, 0.35)',
              background: 'rgba(127, 29, 29, 0.16)',
              color: '#fca5a5',
              // A glyph, not text: its size is set by the 16px box it centres in,
              // not by the caption's scale.
              fontFamily: 'inherit',
              fontSize: 13,
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
              height: 16,
              padding: '0 6px',
              borderRadius: 4,
              border: '1px solid rgba(248, 113, 113, 0.5)',
              background: 'rgba(127, 29, 29, 0.22)',
              color: '#fecaca',
              // A <button> does NOT inherit type by default — the UA stylesheet
              // gives it `font: 400 13.333px Arial`, family included. So the whole
              // font has to be inherited explicitly, otherwise this one word is
              // set in a different typeface from the sentence it belongs to.
              fontFamily: 'inherit',
              fontSize: 'inherit',
              fontWeight: 'inherit',
              letterSpacing: '0.035em',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {activeLifecycle.retryLabel || 'RETRY SETTINGS'}
          </button>
        )}

        {visibleDraftWarning && inlineDraftNoticeMeta && (
          <Tooltip content={visibleDraftWarning}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                minWidth: 0,
                maxWidth: 260,
                height: 16,
                padding: '0 6px',
                borderRadius: 4,
                border: '1px solid ' + (inlineDraftNoticeMeta.tone === 'info' ? 'rgba(113, 113, 122, 0.55)' : 'rgba(251, 191, 36, 0.45)'),
                backgroundColor: inlineDraftNoticeMeta.tone === 'info' ? 'rgba(82, 82, 91, 0.18)' : 'rgba(217, 119, 6, 0.16)',
                color: inlineDraftNoticeMeta.tone === 'info' ? '#d4d4d8' : '#fbbf24',
                // Inherits the chip's weight like everything else in it. A badge
                // is already set apart by its border, fill and colour; adding
                // weight on top made a secondary badge heavier than the status
                // text beside it, which inverts what matters.
                letterSpacing: 0,
                flexShrink: 1,
              }}
            >
              {inlineDraftNoticeMeta.tone !== 'info' && <AlertTriangle size={11} style={{ flexShrink: 0 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {inlineDraftNoticeMeta.label}
              </span>
            </div>
          </Tooltip>
        )}

        {rewindPreviewActive && (
          <Tooltip content="The selected prompt is now a draft. The old future is still saved and only hidden from History until you submit this draft. Restarting the agent or reopening History restores the full transcript.">
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                minWidth: 0,
                maxWidth: 260,
                height: 16,
                padding: '0 6px',
                borderRadius: 4,
                border: '1px solid rgba(217, 119, 6, 0.42)',
                backgroundColor: 'rgba(217, 119, 6, 0.13)',
                color: '#fbbf24',
                // Weight inherited. This badge stays legible because it is
                // UPPERCASE inside a coloured outline — which is also what keeps
                // it readable on a screen recording (see the AI-Optimized UI rule
                // in CLAUDE.md), so nothing is lost by dropping the extra bold.
                letterSpacing: 0,
                flexShrink: 1,
              }}
            >
              <span style={{ whiteSpace: 'nowrap' }}>REWIND DRAFT</span>
              <span style={{ color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {rewindPreviewHiddenTurnCount > 0
                  ? rewindPreviewHiddenTurnCount + (rewindPreviewHiddenTurnCount === 1 ? ' old turn still saved' : ' old turns still saved')
                  : 'waiting for submit'}
              </span>
            </div>
          </Tooltip>
        )}
      </span>
    </div>
  );

  // Прикреплённые промпты — НИЖНЯЯ полоса того же слоя над рамкой.
  //
  // Почему именно здесь, а не в строке внутри рамки: чип с рамкой выше слота
  // фиксированной высоты, в котором живёт строка над полем, и любая попытка
  // положить его туда либо распирает композер, либо (как случилось) рисует его
  // поверх набранного текста. А слой над рамкой пуст, пока в нём ничего нет, и
  // не стоит ни строки.
  //
  // Полоса стоит ВЫШЕ плашки состояния и НЕ в одном ряду с ней: они появляются
  // и исчезают независимо, и если бы делили ряд, то исчезновение статуса
  // сдвигало бы промпты влево (юзер сам это и предвидел: «а если у меня будет
  // одновременно и прикреплённый промпт, и резюминг, они будут идти друг за
  // другом… нет, это будет некрасиво»). Сейчас промпты стоят на одном месте
  // всегда, статус приходит НАД ними.
  const historyComposerPromptBand = composerPromptChips.length === 0 ? null : (
    <div
      data-history-composer-prompt-band
      style={{
        position: 'absolute',
        // Тот же левый край, что у плашки состояния: обе полосы — подписи одной
        // и той же рамки и обязаны начинаться на одной вертикали.
        left: 12,
        // Вплотную над рамкой. Слой обрывается ровно на её верхнем крае, а
        // плашка состояния садится ВЕРХОМ на линию, поэтому полоса промптов
        // поднимается на выступающую половину плашки плюс зазор. Высота плашки
        // зависит от шрифта, поэтому и подъём считается, а не задан числом.
        bottom: historyComposerStatusRise(historyTranscriptFontSize) + 3,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        maxWidth: 'calc(100% - 24px)',
        // Чипы уезжают в горизонтальную прокрутку, а не переносятся: перенос
        // добавил бы вторую полосу и сдвинул всё, что стоит выше.
        flexWrap: 'nowrap',
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'none',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        // Тот же кегль, что у остальных подписей рамки: промпт здесь — тоже
        // подпись, а не содержимое.
        fontSize: historyTranscriptFontSize * HISTORY_SERVICE_TEXT_RATIO,
        fontWeight: HISTORY_SERVICE_TEXT_WEIGHT,
        lineHeight: 1.35,
      }}
    >
      {composerPromptChips.map((chip) => (
        <ComposerChip
          key={chip.id}
          kind="prompt"
          label={promptChipDisplayLabel(chip)}
          title={chip.inheritanceParentLabel
            ? `Наследует: ${chip.inheritanceParentLabel}`
            : undefined}
          onClick={() => setPreviewChipId(previewChipId === chip.id ? null : chip.id)}
          trailing={(
            <>
              <ControlHint label="Вернуть промпт в текст">
                <button
                  type="button"
                  className="hp-composer-chip-action"
                  aria-label="Вернуть чип в текст"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    restoreChipToComposer(chip);
                  }}
                >
                  <ArrowDownToLine size={11} />
                </button>
              </ControlHint>
              <ControlHint label="Удалить промпт">
                <button
                  type="button"
                  className="hp-composer-chip-action hp-composer-chip-action-danger"
                  aria-label="Удалить чип"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    discardComposerChip(chip.id);
                  }}
                >
                  <Trash2 size={11} />
                </button>
              </ControlHint>
            </>
          )}
        />
      ))}
    </div>
  );

  const historySlashCommandMenu = historySlashMenuOpen ? (
    <div
      data-history-slash-command-menu
      role="listbox"
      aria-label="Slash commands"
      style={{
        position: 'absolute',
        // This menu belongs to the text being completed, not to the whole
        // composer frame. It is rendered inside the editor slot below, so the
        // CodeMirror line inset is the only horizontal offset and its lower
        // edge sits directly above the leading slash.
        left: 6,
        bottom: 'calc(100% + 3px)',
        zIndex: 12,
        width: 'min(360px, calc(100% - 6px))',
        maxHeight: 'min(220px, 34vh)',
        overflowY: 'auto',
        padding: 0,
        border: '1px solid rgba(167, 139, 250, 0.34)',
        borderRadius: 7,
        background: 'rgba(18,18,18,0.98)',
        boxShadow: '0 14px 34px rgba(0,0,0,0.48)',
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: aiSecondaryFontSize,
      }}
      onMouseDown={(event) => {
        // Keep the real composer focused. The list owns keyboard selection,
        // but it is not a second text input with a competing caret.
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {historySlashMatches.map((command, index) => {
        const selected = index === Math.min(
          historySlashSelectedIndex,
          Math.max(0, historySlashMatches.length - 1),
        );
        return (
          <button
            key={command.value}
            type="button"
            role="option"
            aria-selected={selected}
            onMouseEnter={() => setHistorySlashSelectedIndex(index)}
            onClick={() => acceptHistorySlashCommand(command.value)}
            style={{
              width: '100%',
              minHeight: 28,
              padding: '3px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              border: 0,
              borderRadius: 6,
              background: selected ? 'rgba(124, 58, 237, 0.18)' : 'transparent',
              color: selected ? '#ddd6fe' : '#d4d4d8',
              font: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <span style={{ flex: '0 0 auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 650 }}>
              {command.value}
            </span>
            <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#85858d' }}>
              {command.description}
            </span>
          </button>
        );
      })}
    </div>
  ) : null;

  const historyComposerOverlay = (
    historyComposerFloatingStatus
    || historyComposerPromptBand
  )
    ? (
      <>
        {historyComposerFloatingStatus}
        {historyComposerPromptBand}
      </>
    )
    : null;

  const historyComposerTopBar = (
    <div className="hp-history-composer-toolbar">
      {/* Cmd-hover only. It used to be `always`, from when this control was an
          opaque icon whose meaning had to be spelled out — now the hover state
          itself says what the click does (▶ / red ■), and a card popping up on
          every pass of the cursor was just noise over the transcript. */}
      <Tooltip
        interactive={false}
        side="top"
        content={[
          statusDescription,
          statusDetail,
          statusActionLabel,
          'Right-click to copy status details',
        ].filter(Boolean).join('\n')}
      >
        <button
          type="button"
          data-agent-status-row
          data-agent-operational-phase={isCompacting ? 'compacting' : undefined}
          data-agent-send-phase={displayedInputStatus || undefined}
          data-agent-status-action={statusPrimaryAction}
          aria-label={statusActionLabel}
          aria-disabled={statusPrimaryAction === 'pending'}
          onClick={activateUnifiedStatus}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            copyStatusDetails();
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            // Fixed square, always. Its size no longer follows the status text
            // (that lives above the frame now), so neighbouring controls never
            // move when the agent changes state.
            width: 24,
            height: 22,
            padding: 0,
            border: 0,
            // Hovering a live session paints the whole control red and swaps the
            // activity glyph for a stop square. The rule this obeys: a control
            // that ENDS a state must not look like the indicator that reports it
            // — see methodology/переносимый-дизайн.md, destructive ≠ status.
            borderRadius: 5,
            // Фон здесь НЕ задаётся вовсе — им целиком распоряжается таблица
            // стилей по `:hover` (см. выше). Даже `transparent`, выставленный
            // тут, перебил бы правило подсветки: встроенный стиль сильнее
            // правила из таблицы, и кнопка осталась бы прозрачной под курсором.
            // (Поймано замером: значки менялись, фон — нет.) Прозрачность и так
            // действует по умолчанию — у кнопки нет своего фона.
            color: statusCopied ? '#86efac' : '#aaa',
            fontSize: aiSecondaryFontSize,
            fontWeight: 650,
            cursor: statusPrimaryAction === 'pending' ? 'default' : 'pointer',
            flexShrink: 0,
            transition: 'background-color 0.12s',
          }}
        >
          {presenceResolving ? (
            <HistoryOwnerTransitionIcon size={20} />
          ) : (
            // Оба значка нарисованы ВСЕГДА, а показывает нужный — браузер, по
            // `:hover` (правила в таблице стилей выше). Раньше выбор шёл здесь,
            // из запомненного «курсор над кнопкой», и этот флаг застревал: когда
            // узел кнопки удаляли прямо под курсором (смена владельца истории,
            // сплит, Ctrl+Tab), события «курсор ушёл» не приходило вовсе, и
            // кнопка продолжала показывать «остановить» на уже другой вкладке.
            //
            // Значок действия и значок состояния сменяются одним и тем же
            // правилом, поэтому разойтись во времени они не могут: не бывает
            // кадра, где видно оба или не видно ни одного.
            <>
              {statusPrimaryAction === 'stop' ? (
                <span
                  aria-hidden
                  data-agent-status-hover-glyph
                  data-agent-status-glyph="stop"
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 2,
                    margin: '0 5px',
                    background: '#f87171',
                    flexShrink: 0,
                  }}
                />
              ) : statusPrimaryAction === 'start' ? (
                <Play
                  aria-hidden
                  data-agent-status-hover-glyph
                  data-agent-status-glyph="start"
                  size={13}
                  strokeWidth={2.2}
                  style={{ margin: '0 3px', color: '#4ade80', flexShrink: 0 }}
                />
              ) : null}
              {/* Кнопка отвечает ТОЛЬКО за жизнь агента: запущен, занят,
                  остановлен. Ни свечение, ни рисунок не зависят от раскладки —
                  см. комментарий у HistoryTerminalActivityIcon, там оба
                  удалённых свойства описаны. */}
              {/* Никакого `display` в стиле элемента: он сильнее правила из
                  таблицы стилей и не дал бы его спрятать под курсором — тогда
                  видно оба значка сразу. Ровно эта ошибка уже была тут с фоном
                  кнопки. Раскладку задаёт `flex-shrink`, показ — только
                  таблица стилей. */}
              <span data-agent-status-idle-glyph style={{ flexShrink: 0 }}>
                <HistoryTerminalActivityIcon
                  size={20}
                  busy={showBusyLoader || isCompacting}
                  color={statusAccent}
                />
              </span>
            </>
          )}
          {/* The status TEXT moved above the frame — see
              historyComposerFloatingStatus. Inside the row it grew and shrank
              with the agent's state and shoved every control sideways. */}
        </button>
      </Tooltip>

      {/* Where the agent's controls are drawn. They belong to this line but are
          owned by ClaudeControlBar, which stays mounted where it always was —
          see composerControlsHost.mjs for why the component does not move.
          It sits INSIDE this toolbar rather than beside the input, because the
          composer disappears entirely while a question from the agent is
          pending, and this same toolbar is what that card keeps. */}
      <div
        ref={setComposerControlsHostNode}
        data-composer-controls-host={tabId}
        // Takes the rest of the line: the controls own their own left/right
        // arrangement inside, and the spacer they use to push the readings
        // rightward only works if this slot is actually wide.
        style={{ display: 'flex', alignItems: 'center', flex: '1 1 auto', minWidth: 0 }}
      />

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
      inert={interactionDisabled}
      aria-hidden={interactionDisabled ? true : undefined}
      style={{
        // The centered surface used to lift this row OUT of the column with
        // `position: absolute` so transcript rows showed around the floating
        // frame. The price was a lie about where the list ends: the scroller
        // still ran the full height, under the input, and a fake spacer the
        // height of this row was appended inside the list so the last row was
        // not hidden. Everything that asks «is the user at the bottom?» then
        // measured to the bottom of that spacer — the bottom of the WINDOW —
        // instead of the top border of the input, and the two only agreed
        // while the spacer happened to equal this row's height (nothing
        // enforced it; the background-tasks bar above the frame already
        // breaks the equality). The row is a normal last line of the column
        // again, so «the bottom» is literally the input's top border.
        position: 'relative',
        // Same constant the button pair above the frame uses, so the vertical
        // line the border draws and the buttons standing on it cannot disagree.
        // Kept in the docked layout too: the frame's rounded border, shadow
        // and side insets are its identity, and none of them needed absolute.
        paddingLeft: overlayComposer ? HISTORY_COMPOSER_SIDE_INSET : 12,
        paddingRight: overlayComposer ? HISTORY_COMPOSER_SIDE_INSET : 10,
        flexShrink: 0,
        borderTop: overlayComposer ? 'none' : '1px solid #333',
        backgroundColor: overlayComposer ? 'transparent' : '#151515',
        paddingTop: overlayComposer ? 0 : 8,
        paddingBottom: overlayComposer ? 4 : 10,
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
          // Никаких чипов ВНУТРИ поверхности: и промпты, и вставки, и картинки
          // рисуются либо над рамкой (промпты), либо внутри самого текста
          // (вставки/картинки). Здесь остаётся только их раскрытое тело.
          externalExpandableChips={composerInlineChipsForPreview}
          expandedChipId={previewChipId}
          onExpandedChipChange={setPreviewChipId}
          notice={historyImageNoticeBanner}
          // Floats above the frame, in the same stack the expanded chip preview
          // already uses. Empty it costs nothing; full it cannot move a single
          // control in the row below.
          overlay={historyComposerOverlay}
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
              {historySlashCommandMenu}
              <ComposerEditor
                ref={promptTextareaRef}
                className="hp-agent-prompt"
                data-history-composer-tab-id={tabId}
                data-status={status}
                value={prompt}
                tokens={promptComposerTokens}
                historyPayload={composerHistoryPayload}
                historyOwnerKey={`history:${tabId}`}
                deriveHistoryPayload={deriveComposerHistoryPayload}
                historyPayloadEqual={historyComposerAggregateEqual}
                fontSize={historyComposerFontSize}
                clipboard={electronComposerClipboardAdapter}
                onChange={(nextText, selection, historyPayload) => {
                  if (isCancellingTurn || rewindLocked) return;
                  const aggregate = historyPayload as HistoryComposerAggregate | null;
                  promptCaretRef.current = {
                    start: selection.start,
                    end: selection.end,
                  };
                  setPrompt(nextText, {
                    images: aggregate?.images || retainHistoryDraftImages(
                      nextText,
                      useUIStore.getState().historyPromptDraftImages[tabId] || [],
                    ),
                    // Deleting the anchor deletes the blob. Backspace over the
                    // marker is the natural way to drop a paste, and keeping the
                    // chip would smuggle its body into the sent prompt.
                    chips: aggregate?.chips || retainPasteChipsForText(
                      nextText,
                      useUIStore.getState().historyPromptDraftChips[tabId] || [],
                    ) as HistoryPromptDraftChip[],
                  });
                  if (draftWarning) setDraftWarning(null);
                }}
                onCopy={handleComposerImageAwareCopy}
                onCut={handleComposerImageAwareCopy}
                onPaste={handleComposerImagePaste}
                onKeyDown={(e) => {
                  // Marker-aware Opt+Arrow runs first: it either handles the
                  // move across an opaque marker or reports "not my case" and
                  // lets native word-wise motion proceed untouched.
                  if (handleComposerWordMotion(e)) return;
                  if (
                    historySlashMenuOpen
                    && !e.nativeEvent.isComposing
                    && !e.metaKey
                    && !e.ctrlKey
                    && !e.altKey
                    && !e.shiftKey
                  ) {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      e.stopPropagation();
                      e.nativeEvent.stopImmediatePropagation();
                      const direction = e.key === 'ArrowDown' ? 1 : -1;
                      setHistorySlashSelectedIndex((current) => {
                        const count = historySlashMatches.length;
                        if (count <= 1) return 0;
                        return (current + direction + count) % count;
                      });
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      e.nativeEvent.stopImmediatePropagation();
                      setHistorySlashDismissedValue(prompt);
                      return;
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      e.nativeEvent.stopImmediatePropagation();
                      const selected = historySlashMatches[Math.min(
                        historySlashSelectedIndex,
                        historySlashMatches.length - 1,
                      )];
                      if (selected) acceptHistorySlashCommand(selected.value);
                      return;
                    }
                  }
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
                    applyHistoryComposerSnapshot({
                      ownerTabId: tabId,
                      text: insertion.text,
                      images: retainHistoryDraftImages(
                        insertion.text,
                        useUIStore.getState().historyPromptDraftImages[tabId] || [],
                      ),
                      chips: useUIStore.getState().historyPromptDraftChips[tabId] || [],
                      selectionStart: insertion.selectionStart,
                      selectionEnd: insertion.selectionEnd,
                      history: 'add',
                      userEvent: 'input.paste',
                    });
                    if (draftWarning) setDraftWarning(null);
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
                      applyHistoryComposerSnapshot({
                        ownerTabId: tabId,
                        text: '',
                        images: [],
                        chips: [],
                        selectionStart: 0,
                        history: 'add',
                        userEvent: 'delete',
                      });
                      setDraftWarning(null);
                      requestAnimationFrame(() => promptTextareaRef.current?.focus());
                    } else if (canInterruptTurn) {
                      void runAction('interrupt');
                    } else if (status !== 'inactive') {
                      void runAction('stop');
                    }
                    return;
                  }
                  if (
                    e.key === 'Enter'
                    && e.altKey
                    && !e.metaKey
                    && !e.ctrlKey
                    && !e.shiftKey
                    && !e.nativeEvent.isComposing
                  ) {
                    // Option+Enter follows the split control beside this input:
                    // authoring content addresses its left half (capture), while
                    // a truly empty composer addresses Play/Pause. Keep both as
                    // tab-scoped commands so History duplicates neither the
                    // capture pipeline nor Run after countdown/arm semantics.
                    // A held key must not repeat either action.
                    e.preventDefault();
                    e.stopPropagation();
                    e.nativeEvent.stopImmediatePropagation();
                    if (!e.repeat) {
                      const state = useUIStore.getState();
                      const currentText = state.historyPromptDrafts[tabId] || '';
                      const currentImages = state.historyPromptDraftImages[tabId] || [];
                      const currentChips = state.historyPromptDraftChips[tabId] || [];
                      const hasAuthoringContent = currentText.trim().length > 0
                        || currentImages.length > 0
                        || currentChips.length > 0;
                      const promptQueueAction = hasAuthoringContent
                        ? 'prompt-queue:grab-current'
                        : 'prompt-queue:toggle-auto-run';
                      window.dispatchEvent(new CustomEvent(promptQueueAction, {
                        detail: { tabId },
                      }));
                    }
                    return;
                  }
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  if (canSend) runAction('send');
                }}
                onSelectionChange={(selection) => {
                  if (!shouldRecordComposerViewEvent(
                    tabId,
                    tabIdRef.current,
                    composerViewRestoringTabRef.current,
                  )) return;
                  promptCaretRef.current = {
                    start: selection.start,
                    end: selection.end,
                  };
                  setHistoryComposerView(tabId, {
                    selectionStart: selection.start,
                    selectionEnd: selection.end,
                  });
                }}
                onScrollChange={(scrollTop) => {
                  if (!shouldRecordComposerViewEvent(
                    tabId,
                    tabIdRef.current,
                    composerViewRestoringTabRef.current,
                  )) return;
                  setHistoryComposerView(tabId, { scrollTop });
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
                  setHistoryComposerFocused(true);
                  setPromptQueueInputSurface(tabId, 'history');
                  const editor = promptTextareaRef.current;
                  promptCaretRef.current = {
                    start: editor?.selectionStart ?? 0,
                    end: editor?.selectionEnd ?? 0,
                  };
                }}
                onBlur={() => {
                  setHistoryComposerFocused(false);
                  const editor = promptTextareaRef.current;
                  promptCaretRef.current = {
                    start: editor?.selectionStart ?? 0,
                    end: editor?.selectionEnd ?? 0,
                  };
                  captureHistoryComposerView(true, 'blur');
                }}
              />
            </div>
          )}
        />
      )}
      {/* No failure line here any more — failures are announced as a toast in the
          top-right corner (see `reportError`). A line at the bottom of the panel
          cost a row of layout under the input and, having no lifetime of its own,
          kept showing a failure long after the situation had changed. */}
    </div>
  );
}

const HISTORY_VIRTUOSO_COMPONENTS = {
  Footer: HistoryTerminalPreviewFooter,
  ScrollSeekPlaceholder: HistoryScrollSeekPlaceholder,
};

// Scroll-seek's mutable velocity/cooldown/kick state is created per mounted
// HistoryPanel below. Split mode may show several real panels at once, so a
// module singleton would make one pane suppress or nudge another.

// Row-level hydration window. Rows within this radius of what the user is
// reading arrive with content; the rest arrive as identity stubs (see
// applyHistoryRowWindow in main). 750 rows each way is far more than a
// screen — several flings' worth — so ordinary reading never waits for a
// hydration round-trip, while a 15.5K-row giant still ships ~1.5MB of stubs
// instead of ~150MB of presentation.
const HISTORY_HYDRATION_RADIUS_ROWS = 750;
// The tail is always hydrated whatever the user is looking at: the composer,
// tail-pin, live projection and background chips all read it.
const HISTORY_HYDRATION_TAIL_ROWS = 300;
// Refetch when the viewport comes within this many rows of the hydrated
// span's edge. Must be well below the radius so the request is issued while
// there are still hydrated rows to scroll through.
const HISTORY_HYDRATION_REFETCH_MARGIN_ROWS = 250;
// Range publications also come from our own React/Virtuoso measurements. A
// settled reading position, not every publication, owns one hydration centre.
const HISTORY_HYDRATION_RANGE_IDLE_MS = 180;
// A Timeline jump that lands on a stub row waits for its hydration under this
// absolute ceiling instead of the rAF attempt cap alone: a cold giant rebuild
// in main is seconds, and reporting found=false right before the rows arrive
// is exactly the "крестики + вечный скелетон" failure of 14.08.
const JUMP_STUB_HYDRATION_WAIT_MS = 20_000;
// Re-asking main to hydrate around the SAME row is refused inside this
// window. Success makes a repeat pointless (the span already covers the
// row); failure gets a bounded retry cadence instead of one request per
// animation frame from the jump loop.
const HYDRATION_REISSUE_COOLDOWN_MS = 1_200;
/**
 * Circuit breaker for hydration oscillation.
 *
 * The uuid cooldown above only stops a request repeating for the SAME centre.
 * A feedback loop that alternates between two centres slips through it — and
 * one did: grouping changed the unit count, the midpoint anchor moved to a
 * different row each pass, and the panel rebuilt ~8×/s while the user was not
 * scrolling at all (production 16.08, tab-3314). The anchor fix removes that
 * cause; this breaker makes the CLASS of failure survivable — if this many
 * viewport-driven requests land inside the window without the visible range
 * settling, viewport hydration stops until the next real user scroll.
 */
const HYDRATION_BURST_WINDOW_MS = 3_000;
const HYDRATION_BURST_MAX_REQUESTS = 12;

// Fallback average row height when no measured geometry exists yet (first
// ever visit to a session). Roughly a short assistant paragraph; real
// measurements replace estimates as rows mount, and returns use the stored
// per-owner average instead.
const HISTORY_DEFAULT_ROW_HEIGHT_PX = 120;
const HISTORY_INITIAL_VIEWPORT_BUFFER = { top: 0, bottom: 0 };
const HISTORY_SETTLED_VIEWPORT_BUFFER = { top: 600, bottom: 600 };

// ===== Mount wave =====
// The owner takeover used to mount every visible heavy card in ONE commit —
// markdown + diff bodies for the whole viewport, measured live at 650-730ms
// as a single unbreakable long task (`during=history-owner-mount`, 04.08),
// with only THREE visible rows in the worst case. React cannot yield inside
// one commit, so a right-click landing in that window queued behind it: the
// exact "fast tab switch + immediate right-click freezes" user flow.
//
// The wave splits that commit: the mount renders exact-height lightweight
// shells (geometry from the measured-layout store, so Virtuoso sees the SAME
// sizes it stored and nothing shifts), then rows upgrade to real cards in
// separate small commits — one unknown-cost row at a time, growing to three
// only after a step measured cheap. Each step is granted by this arbiter (at
// most one panel steps per frame — split panes must not compound into one
// long task), scheduled only after the PREVIOUS step's commit was observed by
// a layout effect plus one painted frame (React batches concurrent
// transitions, so a free-running loop would merge steps back into one big
// commit — the exact failure this exists to prevent).
type HistoryMountWaveLane = {
  wants: boolean;
  visible: () => boolean;
  run: () => void;
};
const historyMountWaveLanes = new Set<HistoryMountWaveLane>();
let historyMountWaveArbiterArmed = false;
let historyMountWavePriorityTimer: ReturnType<typeof setTimeout> | null = null;
const retryHistoryMountWaveAfterForeground = (): void => {
  if (historyMountWavePriorityTimer !== null) return;
  const waitMs = Math.max(16, Math.ceil(historyForegroundPriority.remainingMs()) + 1);
  historyMountWavePriorityTimer = setTimeout(() => {
    historyMountWavePriorityTimer = null;
    pumpHistoryMountWaveArbiter();
  }, waitMs);
};
const pumpHistoryMountWaveArbiter = (): void => {
  if (historyMountWaveArbiterArmed) return;
  let anyWants = false;
  for (const lane of historyMountWaveLanes) {
    if (lane.wants) { anyWants = true; break; }
  }
  if (!anyWants) return;
  // A shell is already enough to preserve list geometry. Upgrading hidden or
  // sibling cards while a physical wheel is queued only steals the frame from
  // the reader; keep the wants bit and resume at the global quiet edge.
  if (historyForegroundPriority.active()) {
    retryHistoryMountWaveAfterForeground();
    return;
  }
  historyMountWaveArbiterArmed = true;
  requestAnimationFrame(() => {
    historyMountWaveArbiterArmed = false;
    if (historyForegroundPriority.active()) {
      retryHistoryMountWaveAfterForeground();
      return;
    }
    const wanting = [...historyMountWaveLanes].filter((lane) => lane.wants);
    if (wanting.length === 0) return;
    const pick = wanting.find((lane) => lane.visible()) ?? wanting[0];
    pick.wants = false;
    // Insertion-order rotation keeps concurrent lanes fair.
    historyMountWaveLanes.delete(pick);
    historyMountWaveLanes.add(pick);
    pick.run();
    pumpHistoryMountWaveArbiter();
  });
};
const requestHistoryMountWaveStep = (lane: HistoryMountWaveLane): void => {
  lane.wants = true;
  pumpHistoryMountWaveArbiter();
};
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
  bottomInset = 0,
  compactComposer = false,
  onSwapPrimarySurface,
  terminalIsPrimary = false,
  projectId,
  terminalOpen = false,
  onToggleTerminal,
  lifecycleStatus,
  inputBusy = false,
  onControlsHeightChange,
  suppressGlobalHotkeys = false,
  staleOwnerCurtain = false,
  presented = true,
  preservePresentationGeometry = false,
  presentationExternallyManaged = false,
  presentationChannel,
  onInitialSourceSignal,
}: HistoryPanelProps) {
  const onInitialSourceSignalRef = useRef(onInitialSourceSignal);
  onInitialSourceSignalRef.current = onInitialSourceSignal;
  // Live input surface of the tab in BOTH agent layouts. Everything that makes
  // History the place the user types into — availability published to grab /
  // dictation / task plan, Escape-interrupt — keys off this, not off geometry.
  // Availability is keyed by tabId, so split panes (different tabs) publish it
  // independently; only WINDOW-level shortcuts are gated by pane focus via
  // suppressGlobalHotkeys.
  const agentInputSurface = mainSurface || agentSidePanel;
  const globalHotkeysSuppressedRef = useRef(suppressGlobalHotkeys);
  // Non-pane/legacy owners still follow the React prop. Persistent pane owners
  // receive focus through HISTORY_SURFACE_PRESENTATION_EVENT below; do not
  // overwrite that newer imperative value on unrelated History renders.
  if (!presentationExternallyManaged) {
    globalHotkeysSuppressedRef.current = suppressGlobalHotkeys;
  }
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
  // Right-edge obstacles over the CENTER box. Only meaningful while this panel
  // IS the center (mainSurface) — as a side panel it insets nothing. Same
  // arithmetic as the Run after strip and the terminal's arrow.
  const sideTerminalOpenForInset = useUIStore((s) => s.sideTerminalOpenTabs[tabId] ?? false);
  const sideTerminalWidthForInset = useUIStore((s) => s.sideTerminalWidth);
  const timelineTreeModeForInset = useUIStore((s) => s.timelineTreeModeTabs[tabId] ?? false);
  const timelinePinnedForInset = useUIStore((s) => s.timelinePinned);
  const timelineWidthForInset = useUIStore((s) => s.timelineWidth);
  const historyPinnedForInset = useUIStore((s) => s.historyPinned);
  const centerRightInset = resolveCenterRightInset({
    // As the side panel this transcript IS the obstacle; its own right edge is
    // clear and its arrow belongs inside it. (mainSurface already gates the
    // value at the use site, but saying it here keeps the rule in one place
    // for both surfaces.)
    isSidePanel: agentSidePanel,
    treeMode: timelineTreeModeForInset,
    pinned: timelinePinnedForInset,
    width: timelineWidthForInset,
    sideTerminalOpen: sideTerminalOpenForInset,
    sideTerminalWidth: sideTerminalWidthForInset,
    // A transcript that is itself the center never has a transcript docked
    // beside it — the opposite surface there is always the terminal.
    sideHistoryOpen: false,
    sideHistoryWidth: 0,
    // A pinned side terminal is a column, so this surface already ends before
    // it and must not inset again.
    sidePanelPinned: historyPinnedForInset,
  });
  const requestedHistoryScrollUuid = useUIStore((s) => s.historyScrollToUuid);
  const historyScrollTargetTabId = useUIStore((s) => s.historyScrollTargetTabId);
  // Persistent panes all stay mounted. A process-global UUID therefore is not
  // a navigation request — it is an invitation for every hidden History to
  // consume it. Only the named tab may translate or clear this request.
  const historyScrollToUuid = historyScrollTargetTabId === tabId
    ? requestedHistoryScrollUuid
    : null;
  const setHistoryScrollToUuid = useUIStore((s) => s.setHistoryScrollToUuid);
  const setHistoryVisibleUuids = useUIStore((s) => s.setHistoryVisibleUuids);
  const setHistoryScrollPosition = useUIStore((s) => s.setHistoryScrollPosition);
  const setHistoryPromptDraft = useUIStore((s) => s.setHistoryPromptDraft);
  const setHistoryRewindPreview = useUIStore((s) => s.setHistoryRewindPreview);
  const historyFontSize = useUIStore((s) => s.historyFontSize);
  const historyMarkdownCodeMaxLines = useUIStore((s) => s.historyMarkdownCodeMaxLines);
  const terminalHistoryStreamingEnabled = useUIStore(
    (s) => s.terminalHistoryStreamingEnabled,
  );
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
  const [controlsPasteBusy, setControlsPasteBusy] = useState(false);
  const [responseActivitySnapshot, setResponseActivitySnapshot] = useState<HistoryResponseActivitySnapshot>({
    tabId,
    toolType: toolType as AgentHistoryTool,
    timing: null,
  });
  const handleResponseTimingChange = useCallback((next: HistoryResponseActivitySnapshot) => {
    setResponseActivitySnapshot((previous) => {
      const left = previous.timing;
      const right = next.timing;
      const sameTiming = left === right || (!!left && !!right
        && left.state === right.state
        && left.intervalId === right.intervalId
        && left.toolType === right.toolType
        && left.sessionId === right.sessionId
        && left.startTs === right.startTs
        && left.endTs === right.endTs
        && left.durationMs === right.durationMs);
      return previous.tabId === next.tabId
        && previous.toolType === next.toolType
        && sameTiming
        ? previous
        : next;
    });
  }, []);
  const [codexHistoryActions, setCodexHistoryActions] = useState<{
    canNativeRewind: boolean;
    canRewriteHistory: boolean;
    canDeleteHistory: boolean;
    reason: string | null;
  } | null>(null);
  const handleRuntimeSnapshotChange = useCallback((snapshot: any | null) => {
    const provisionalSettingsPatch = projectCodexProvisionalSettingsOverlay(snapshot);
    if (provisionalSettingsPatch) {
      useWorkspaceStore.getState().updateCodexLiveState(tabId, provisionalSettingsPatch);
    }
    const next = snapshot && typeof snapshot === 'object'
      ? {
          canNativeRewind: snapshot.canNativeRewind === true,
          canRewriteHistory: snapshot.canRewriteHistory === true,
          canDeleteHistory: snapshot.canDeleteHistory === true,
          reason: typeof snapshot.historyActionReason === 'string'
            ? snapshot.historyActionReason
            : null,
        }
      : null;
    setCodexHistoryActions((previous) => (
      previous?.canNativeRewind === next?.canNativeRewind
      && previous?.canRewriteHistory === next?.canRewriteHistory
      && previous?.canDeleteHistory === next?.canDeleteHistory
      && previous?.reason === next?.reason
        ? previous
        : next
    ));
  }, [tabId]);
  useEffect(() => {
    setControlsPasteBusy(false);
    setCodexHistoryActions(null);
  }, [sessionId, tabId, toolType]);
  const historyInputBusy = inputBusy || controlsPasteBusy || isTurnBusy;
  const historyRewindUnavailableReason = rewindLocked
    ? 'Rewind уже выполняется'
    : historyInputBusy
      ? 'Дождись завершения текущей отправки или ответа перед Rewind'
      : toolType === 'codex' && enableClaudePtyControls && codexHistoryActions?.canNativeRewind !== true
        ? codexHistoryActions?.reason === 'composer-not-ready'
          ? 'Codex ещё готовит поле ввода'
          : codexHistoryActions?.reason === 'runtime-identity-unknown'
            ? 'Проверяю текущую Codex-сессию'
            : 'Rewind недоступен для текущего состояния Codex'
        : null;
  const historyRewindLocked = historyRewindUnavailableReason !== null;
  const historyRewriteRewindFlightsRef = useRef<Map<string, string>>(new Map());
  const [historyRewriteRewindBusyTabs, setHistoryRewriteRewindBusyTabs] = useState<Set<string>>(
    () => new Set(),
  );
  const historyRewriteRewindLocked = historyRewriteRewindBusyTabs.has(tabId)
    || rewindLocked;
  const historyRewriteRewindUnavailableReason = historyRewriteRewindBusyTabs.has(tabId)
    ? 'JSONL Rewind уже подготавливается'
    : rewindLocked
      ? 'Дождись завершения native Rewind'
      : null;
  const executeHistoryRewriteRewind = useCallback(async (entry: FullHistoryEntry) => {
    if (historyRewriteRewindFlightsRef.current.has(tabId)) {
      useUIStore.getState().showToast(
        'Rewind уже выполняется', 'warning', 2200, false,
        undefined, undefined, undefined, tabId,
      );
      return;
    }
    if (!sessionId || (toolType !== 'claude' && toolType !== 'codex')) {
      useUIStore.getState().showToast(
        'Нет сохранённой AI-сессии для JSONL Rewind', 'error', 2600, false,
        undefined, undefined, undefined, tabId,
      );
      return;
    }
    const operationUuid = entry.uuid;
    historyRewriteRewindFlightsRef.current.set(tabId, operationUuid);
    setHistoryRewriteRewindBusyTabs(new Set(historyRewriteRewindFlightsRef.current.keys()));
    try {
      await executeHistoryRewriteRewindScenario({
        tabId,
        toolType,
        sessionId,
        cwd,
        target: {
          uuid: entry.uuid,
          text: entry.content,
          promptChips: entry.promptChips,
          imagePaths: entry.imagePaths,
        },
      });
      useUIStore.getState().showToast(
        'Rewind выполнен: JSONL обрезан, запрос возвращён в input',
        'success',
        2600,
        false,
        undefined,
        undefined,
        undefined,
        tabId,
      );
    } catch (error: any) {
      const message = String(error?.message || error || 'Rewind failed');
      const historyMutated = error instanceof HistoryRewriteRewindError
        ? error.historyMutated
        : false;
      useUIStore.getState().showToast(
        historyMutated
          ? 'JSONL обрезан и запрос сохранён в input, но перезапуск не завершён: ' + message
          : 'JSONL Rewind не выполнен: ' + message,
        'error',
        4200,
        false,
        undefined,
        undefined,
        undefined,
        tabId,
      );
    } finally {
      if (historyRewriteRewindFlightsRef.current.get(tabId) === operationUuid) {
        historyRewriteRewindFlightsRef.current.delete(tabId);
        setHistoryRewriteRewindBusyTabs(new Set(historyRewriteRewindFlightsRef.current.keys()));
      }
    }
  }, [cwd, sessionId, tabId, toolType]);
  const closePanel = useCallback(() => setHistoryPanelOpen(tabId, false), [tabId, setHistoryPanelOpen]);
  const resetPanelWidth = useCallback(() => setHistoryPanelWidth(HISTORY_PANEL_DEFAULT_WIDTH), [setHistoryPanelWidth]);
  const panelRef = useRef<HTMLDivElement>(null);
  const historyPresentationProofRef = useRef(createHistoryPresentationProof(presented));
  // Presentation ownership is established before the wheel/geometry helpers
  // are declared below. Route hide through a ref so proof can be revoked first
  // and every temporary visual/measurement owner can then clean synchronously
  // without a TDZ dependency in the presentation layout effects.
  const historyPresentationHideCleanupRef = useRef<(() => void) | null>(null);
  if (!presentationExternallyManaged) {
    historyPresentationProofRef.current = advanceHistoryPresentationProof(
      historyPresentationProofRef.current,
      presented,
    );
  }
  const historyPresentationVisit = historyPresentationProofRef.current.visit;
  // React renders the initial/primed prop value to keep the heavy component's
  // props stable. A background transcript update may still re-render it while
  // dormant; restore the externally-owned diagnostic attributes in the same
  // commit so React cannot paint a false `presented=1` frame.
  useLayoutEffect(() => {
    if (!presentationExternallyManaged) return;
    const proof = historyPresentationProofRef.current;
    panelRef.current?.setAttribute('data-history-presented', proof.presented ? '1' : '0');
    panelRef.current?.setAttribute('data-history-presentation-visit', String(proof.visit));
  });
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
  const historyTabIdRef = useRef(tabId);
  historyTabIdRef.current = tabId;
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
  const [terminalPreview, setTerminalPreview] = useState<TerminalHistoryPreview | null>(null);
  const terminalPreviewRef = useRef<TerminalHistoryPreview | null>(null);
  terminalPreviewRef.current = terminalPreview;
  const [terminalPreviewClearHandoff, setTerminalPreviewClearHandoff] =
    useState<TerminalHistoryPreviewClearHandoff | null>(null);
  const terminalPreviewClearHandoffRef = useRef<TerminalHistoryPreviewClearHandoff | null>(null);
  // IPC and layout effects need the newest transaction synchronously. Do not
  // mirror state into this ref during render: an interrupted/concurrent render
  // can write an older handoff back over a newer imperative event.
  const publishTerminalPreviewClearHandoff = useCallback((
    next: TerminalHistoryPreviewClearHandoff | null,
  ) => {
    terminalPreviewClearHandoffRef.current = next;
    setTerminalPreviewClearHandoff(next);
  }, []);
  const terminalPreviewAnchorSettleCancelRef = useRef<(() => void) | null>(null);
  // A durable projection commit can move the exact replacement row without
  // emitting a scroll event. The active mid-list handoff publishes a manual
  // pre-paint correction signal here for that React-only geometry change.
  const terminalPreviewAnchorSettleSignalRef = useRef<(() => void) | null>(null);
  // External presentation changes arrive through an imperative channel, so a
  // hidden canonical handoff needs an imperative wake as well. The callback
  // itself only schedules work for rAF; applyPresentation stays geometry-read free.
  const terminalPreviewPresentationWakeRef = useRef<((source: string) => void) | null>(null);
  const [terminalPreviewHandoffWakeSeq, setTerminalPreviewHandoffWakeSeq] = useState(0);
  const terminalPreviewHandoffWakeRafRef = useRef(0);
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
  // Physical Virtuoso mount generation. Stable compositor visibility changes
  // do not touch it; a real geometry move increments it and gets a fresh
  // measured-layout/paint transaction.
  const [presentationRestoreTick, setPresentationRestoreTick] = useState(0);
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
  // Dedup for LIVE_ORPHANS diagnostics: one line per distinct unmatched-live
  // composition, not one per reconciliation pass.
  const liveOrphanDigestRef = useRef('');
  const liveToolResultsRef = useRef<{
    ownerKey: string;
    results: Map<string, HistoryLiveToolResult>;
  }>({ ownerKey: historyOwnerKey, results: new Map() });
  const durableSourceIdentitiesRef = useRef<Set<string>>(new Set(
    (
      (firstRenderSnapshot?.entries as unknown as FullHistoryEntry[] | undefined)
      || []
    )
      .flatMap((entry) => historyLivePresentationIdentities(entry)),
  ));
  const presentationEntriesRef = useRef(entries);
  presentationEntriesRef.current = entries;
  const historyPresentationApplyGuardRef = useRef<(reason: string) => void>(() => {});
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
        .filter((entry) => (
          !isLocalRewindEntry(entry)
          && !isLocalPromptEntry(entry)
          && !isLocalCompactErrorEntry(entry)
        ));
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
      if (isLocalCompactErrorEntry(entry)) return true;
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
    // Orphan diagnostics (16.08: an assistant block rendered at the very
    // tail, and stayed at the tail after the NEXT prompt — a live row whose
    // sourceIdentity never matched its durable twin survives reconciliation
    // forever and is appended after everything by the live merge). Log the
    // exact unmatched identities once per composition so the next incident
    // names the mismatch instead of guessing. Quiet while the turn is busy —
    // unmatched live rows are the NORMAL state mid-stream.
    if (remaining.length > 0 && !isTurnBusyRef.current) {
      const digest = remaining
        .map((entry) => (historyLivePresentationIdentities(entry)[0] || entry.uuid || '?').slice(-64))
        .join(',')
        .slice(0, 240);
      if (liveOrphanDigestRef.current !== digest) {
        liveOrphanDigestRef.current = digest;
        historyDiag('LIVE_ORPHANS tab=' + tabId.slice(-12)
          + ' count=' + remaining.length
          + ' durable=' + durableEntries.length
          + ' ids=' + digest);
      }
    } else if (remaining.length === 0) {
      liveOrphanDigestRef.current = '';
    }
    if (remaining.length === live.entries.length) return;
    liveProjectionRef.current = { ownerKey, entries: remaining };
    setLiveEntries(remaining);
  }, [tabId]);
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
        .flatMap((entry) => historyLivePresentationIdentities(entry)),
    );
    const hasUnmatchedProjection = live.ownerKey === ownerKey
      && live.entries.some((entry) => {
        const identities = historyLivePresentationIdentities(entry);
        return identities.length === 0
          || !identities.some((identity) => durableIdentities.has(identity));
      });
    return hasUnmatchedProjection || (
      liveToolResultsRef.current.ownerKey === ownerKey
      && liveToolResultsRef.current.results.size > 0
    );
  }, []);
  const historyPayloadContextValue = useMemo(
    () => (sessionId ? { tabId, toolType, sessionId, cwd } : null),
    [tabId, toolType, sessionId, cwd],
  );
  // Background chip PRESENTATION comes from durable/live provider rows;
  // local/optimistic rows can never be background work. Process availability
  // remains a coarse host boundary, while exact subagent liveness is joined
  // below from main's active call-id snapshot.
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
  // Exact active subagents come from the same main-owned provider watchers
  // that drive the tab loader. History used to re-infer this from durable Task
  // cards, creating two authorities: the tab correctly dropped a completed
  // child while a cached `running` card resurrected it with a 200-minute
  // timer after switching back. The snapshot is monotonic by revision, so a
  // slower mount-time query cannot overwrite a newer completion event.
  const [mainBackgroundWork, setMainBackgroundWork] = useState<HistoryBackgroundWorkSnapshot>({
    tabId: '',
    revision: -1,
    agents: [],
  });
  useEffect(() => {
    let cancelled = false;
    const accept = (detail: any) => {
      if (cancelled || String(detail?.tabId || '') !== tabId) return;
      const revision = Number(detail?.revision);
      const nextRevision = Number.isFinite(revision) ? revision : 0;
      const agents = Array.isArray(detail?.agents) ? detail.agents : [];
      const normalizedAgents: HistoryBackgroundAgentProof[] = agents
        .map((agent: any): HistoryBackgroundAgentProof => ({
          provider: agent?.provider === 'codex' ? 'codex' : 'claude',
          toolUseId: String(agent?.toolUseId || ''),
          agentId: String(agent?.agentId || ''),
          agentSessionId: String(agent?.agentSessionId || ''),
          sessionId: agent?.sessionId ? String(agent.sessionId) : null,
          generation: agent?.generation ? String(agent.generation) : null,
          startedAt: Number(agent?.startedAt) || 0,
        }))
        .filter((agent) => !!agent.toolUseId);
      setMainBackgroundWork((previous) => {
        if (previous.tabId === tabId && previous.revision > nextRevision) return previous;
        return {
          tabId,
          revision: nextRevision,
          agents: normalizedAgents,
        };
      });
    };
    const onBackgroundWork = (_event: unknown, detail: any) => accept(detail);
    ipcRenderer.on('tab:background-work', onBackgroundWork);
    void ipcRenderer.invoke('agent:list-background-work', { tabIds: [tabId] })
      .then((result: any) => {
        const record = Array.isArray(result?.records)
          ? result.records.find((item: any) => String(item?.tabId || '') === tabId)
          : null;
        if (record) accept(record);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      ipcRenderer.removeListener('tab:background-work', onBackgroundWork);
    };
  }, [tabId]);
  const exactActiveSubagents = useMemo(() => {
    if (mainBackgroundWork.tabId !== tabId) return null;
    const exact = new Map<string, HistoryBackgroundAgentProof>();
    for (const agent of mainBackgroundWork.agents) {
      if (agent.provider !== toolType) continue;
      if (agent.sessionId && sessionId && agent.sessionId !== sessionId) continue;
      if (agent.generation && agentProcessGeneration
        && agent.generation !== agentProcessGeneration) continue;
      const callIdentity = historySubagentCallIdentity(agent.toolUseId);
      if (callIdentity) exact.set(callIdentity, agent);
    }
    return exact;
  }, [agentProcessGeneration, mainBackgroundWork, sessionId, tabId, toolType]);
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
        exactActiveSubagents,
      )
      : EMPTY_HISTORY_CHIPS),
    [chipsOwnerSettled, chipSourceEntries, isTurnBusy, agentProcessAlive, sessionId, agentProcessGeneration, toolType, exactActiveSubagents],
  );
  const liveBackgroundUuids = useMemo(
    () => new Set(backgroundHistoryChips.map((chip) => chip.entryUuid)),
    [backgroundHistoryChips],
  );
  const liveBackgroundTaskCalls = useMemo(
    () => new Set(
      backgroundHistoryChips
        .filter((chip) => chip.kind === 'subagent')
        .map((chip) => historySubagentCallIdentity(chip.key.replace(/^task:/, '')))
        .filter(Boolean),
    ),
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
  const historyAgentChips = useMemo(
    () => (chipsOwnerSettled
      ? collectHistoryAgentChips(chipSourceEntries, backgroundHistoryChips)
      : EMPTY_HISTORY_AGENTS),
    [backgroundHistoryChips, chipSourceEntries, chipsOwnerSettled],
  );
  // The dock selection survives running → completed because both faces use
  // the same `task:<toolUseId>` key. It resets only when the selected action
  // genuinely leaves this session/owner.
  const [expandedBackgroundChipKey, setExpandedBackgroundChipKey] = useState<string | null>(null);
  const [agentRosterOpen, setAgentRosterOpen] = useState(false);
  const availableDetailKeys = useMemo(() => new Set([
    ...backgroundHistoryChips.map((chip) => chip.key),
    ...historyAgentChips.map((agent) => agent.key),
  ]), [backgroundHistoryChips, historyAgentChips]);
  useEffect(() => {
    if (!expandedBackgroundChipKey || !chipsOwnerSettled) return;
    if (!availableDetailKeys.has(expandedBackgroundChipKey)) {
      setExpandedBackgroundChipKey(null);
    }
  }, [availableDetailKeys, chipsOwnerSettled, expandedBackgroundChipKey]);
  useEffect(() => {
    setExpandedBackgroundChipKey(null);
    setAgentRosterOpen(false);
  }, [historyOwnerKey]);
  const openHistoryAgent = useCallback((agentKey: string) => {
    if (!agentKey) return;
    setExpandedBackgroundChipKey(agentKey);
    setAgentRosterOpen(false);
  }, []);
  const toggleHistoryDetail = useCallback((detailKey: string) => {
    setAgentRosterOpen(false);
    setExpandedBackgroundChipKey((current) => current === detailKey ? null : detailKey);
  }, []);
  const agentInspectorController = useMemo<HistoryAgentInspectorController>(() => ({
    selectedKey: expandedBackgroundChipKey,
    openAgent: openHistoryAgent,
  }), [expandedBackgroundChipKey, openHistoryAgent]);
  useEffect(() => {
    const onOpenAgent = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.tabId && detail.tabId !== tabId) return;
      const requestedKey = String(detail.agentKey || '');
      if (requestedKey) {
        openHistoryAgent(requestedKey);
      } else {
        setAgentRosterOpen(true);
      }
    };
    window.addEventListener('history-panel:open-agent', onOpenAgent);
    return () => window.removeEventListener('history-panel:open-agent', onOpenAgent);
  }, [openHistoryAgent, tabId]);
  const ownerLiveEntries = liveProjectionRef.current.ownerKey === historyOwnerKey
    ? liveEntries
    : [];
  const terminalPreviewCanonicalIdentity =
    terminalPreviewClearHandoff?.canonicalIdentity || '';
  const terminalPreviewCanonicalInDurableProjection = !!terminalPreviewCanonicalIdentity
    && renderEntries.some((entry) => (
      historyLivePresentationIdentities(entry).includes(terminalPreviewCanonicalIdentity)
    ));
  // Main's canonical-materialized event already proves the exact JSONL record.
  // During a busy turn the full History refresh is intentionally deferred, so
  // keep that exact live row as the replacement target until the durable
  // projection catches up. Suppress it only when the same physical identity is
  // already present there; equal text from another record remains visible.
  const visibleLiveEntries = useMemo(
    () => filterHistoryTerminalPreviewLiveDuplicate({
      liveEntries: ownerLiveEntries,
      canonicalIdentity: terminalPreviewCanonicalInDurableProjection
        ? terminalPreviewCanonicalIdentity
        : '',
      identitiesForEntry: historyLivePresentationIdentities,
    }) as FullHistoryEntry[],
    [
      ownerLiveEntries,
      terminalPreviewCanonicalIdentity,
      terminalPreviewCanonicalInDurableProjection,
    ],
  );
  // Live rollout rows and durable History rows share one virtualized list.
  // The durable version wins by source identity, while computeItemKey keeps
  // the same DOM row across the handoff. This removes the old footer/indexed
  // dual presentation and its materialization race.
  const mergedTranscriptEntries = useMemo(
    () => buildHistoryLivePresentation(renderEntries, visibleLiveEntries),
    [renderEntries, visibleLiveEntries],
  ) as FullHistoryEntry[];
  // Rewind owns the final presentation boundary. Applying it before the live
  // merge allowed an old live row beyond the target to reappear afterwards.
  const rewindPreviewResult = useMemo(
    () => buildRewindPreviewEntries(mergedTranscriptEntries, rewindPreview),
    [mergedTranscriptEntries, rewindPreview],
  );
  const displayEntries = rewindPreviewResult.entries;
  const displayEntriesRef = useRef(displayEntries);
  displayEntriesRef.current = displayEntries;
  const transcriptEntries = displayEntries;
  const visibleResponseActivityTiming = responseActivitySnapshot.tabId === tabId
    && responseActivitySnapshot.toolType === toolType
    ? responseActivitySnapshot.timing
    : null;
  const liveResponseTailTiming = useMemo<HistoryResponseTailTiming | null>(
    () => resolveHistoryResponseTailTiming(
      visibleResponseActivityTiming,
      EMPTY_HISTORY_ENTRIES,
    ) as HistoryResponseTailTiming | null,
    [visibleResponseActivityTiming],
  );
  // The shared tail owns only the running interval and the short completed →
  // durable binding handoff. Once the exact final response carries this
  // interval, that response renders its own `Worked for …`; keeping the same
  // timer in the Footer would duplicate it and would again make completion
  // look like metadata of only the latest iteration.
  const responseTailTiming = useMemo<HistoryResponseTailTiming | null>(() => {
    if (!liveResponseTailTiming) return null;
    if (liveResponseTailTiming.state !== 'completed') return liveResponseTailTiming;
    const intervalId = Number(liveResponseTailTiming.intervalId);
    const isBoundToVisibleResponse = Number.isFinite(intervalId)
      && displayEntries.some((entry) => Number(entry.responseTiming?.intervalId) === intervalId);
    return isBoundToVisibleResponse ? null : liveResponseTailTiming;
  }, [displayEntries, liveResponseTailTiming]);
  // ===== Display units: series collapsing (последняя ступень проекции) =====
  // Approved contract (docs/tmp/визуал-history.md::Вердикт): the unit list is
  // presentation-only; group keys are internal; everything that crosses this
  // boundary (anchors, hydration, jumps, search) speaks entry uuids and gets
  // translated to unit indices HERE. Kill switch: historyGroupActionsEnabled.
  const historyGroupActionsEnabled = useUIStore((s) => (s as any).historyGroupActionsEnabled !== false);
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<ReadonlySet<string>>(() => new Set());
  // Expansion state belongs to the owner (scar: state surviving an owner
  // switch was read by the wrong tab). Reset on owner change.
  const expandedGroupOwnerRef = useRef(historyOwnerKey);
  if (expandedGroupOwnerRef.current !== historyOwnerKey) {
    expandedGroupOwnerRef.current = historyOwnerKey;
    if (expandedGroupKeys.size > 0) setExpandedGroupKeys(new Set());
  }
  // Previous (rows, options, units) triple for the incremental append path —
  // owner-scoped: another tab's rows must never serve as a diff baseline.
  const displayUnitsPrevRef = useRef<{
    ownerKey: string;
    entries: FullHistoryEntry[];
    options: { enabled: boolean; threshold: number; expandedKeys: ReadonlySet<string> };
    units: unknown[];
  } | null>(null);
  // Пробуждение панели начинает не с нуля: базовая строка прошлого визита
  // хранится ПО СЕССИИ (historyDisplayUnitsBaseline.mjs) и переживает
  // размонтирование. Без неё вкладка, стримившая в прошлый визит, платила
  // полный проход по всем записям на каждом входе в пространство (62.8мс на
  // 3.9K-сессии в кадре клика — замер 20.08).
  if (displayUnitsPrevRef.current?.ownerKey !== historyOwnerKey) {
    displayUnitsPrevRef.current = (
      peekHistoryDisplayUnitsBaseline(historyOwnerKey) as typeof displayUnitsPrevRef.current
    ) || null;
  }
  const displayUnits = useMemo(
    () => {
      const unitOptions = {
        enabled: historyGroupActionsEnabled,
        threshold: 2,
        expandedKeys: expandedGroupKeys,
      };
      // Cross-visit cache first. useMemo is one slot, so A→B→A switching
      // rebuilt the same projection on every return (107-168ms on a 6.4K-row
      // session, twice per click — THE 16.08 click regression). Groups are
      // static between visits: same rows array + same expanded set = same
      // units, served from the WeakMap in historyDisplayUnits.mjs.
      const cached = peekHistoryDisplayUnitsCached(displayEntries, unitOptions);
      if (cached) return cached;
      // Perf attribution for real rebuilds (the mark names any long task
      // overlapping it; the ms log catches sub-50ms rebuilds too).
      const endMark = markRendererActivity('history-group-units:' + tabId.slice(-8));
      const startedAt = performance.now();
      let mode = 'full';
      let reusedUnits = 0;
      let rebuiltEntries = displayEntries.length;
      try {
        // Live append/delta: reuse the unit prefix up to the last hard
        // grouping boundary before the first changed row. Row REFERENCE
        // identity is the witness (delta reassembly preserves refs), so a
        // full reload that recreates objects falls back to the full build.
        const previous = displayUnitsPrevRef.current;
        if (previous && previous.ownerKey === historyOwnerKey) {
          const appended = buildHistoryDisplayUnitsAppended(
            previous.entries,
            previous.units,
            displayEntries,
            unitOptions,
            previous.options,
          );
          if (appended) {
            mode = 'append';
            reusedUnits = appended.reusedUnits;
            rebuiltEntries = appended.rebuiltEntries;
            // В межвизитный кэш кладётся И результат доклейки. Раньше туда
            // попадал только полный пересчёт, поэтому вкладка, СТРИМИВШАЯ при
            // прошлом визите, на каждом следующем пробуждении платила полный
            // проход по всем записям заново (62.8мс на 3.9K-сессии в кадре
            // клика по пространству, замер 20.08) — при том что готовая
            // карта уже существовала, просто под старым ключом.
            return rememberHistoryDisplayUnitsCached(displayEntries, unitOptions, appended.units);
          }
        }
        return buildHistoryDisplayUnitsCached(displayEntries, unitOptions);
      } finally {
        endMark();
        const elapsedMs = performance.now() - startedAt;
        if (elapsedMs >= 8 || mode === 'append') {
          historyDiag('GROUP_UNITS_BUILD tab=' + tabId.slice(-12)
            + ' entries=' + displayEntries.length
            + ' expanded=' + expandedGroupKeys.size
            + ' mode=' + mode
            + (mode === 'append'
              ? ' reusedUnits=' + reusedUnits + ' rebuiltEntries=' + rebuiltEntries
              : '')
            + ' ms=' + elapsedMs.toFixed(1));
        }
      }
    },
    [displayEntries, expandedGroupKeys, historyGroupActionsEnabled, historyOwnerKey, tabId],
  );
  displayUnitsPrevRef.current = {
    ownerKey: historyOwnerKey,
    entries: displayEntries,
    options: {
      enabled: historyGroupActionsEnabled,
      threshold: 2,
      expandedKeys: expandedGroupKeys,
    },
    units: displayUnits as unknown[],
  };
  rememberHistoryDisplayUnitsBaseline(displayUnitsPrevRef.current);
  const displayUnitsRef = useRef(displayUnits);
  displayUnitsRef.current = displayUnits;
  const displayUnitItemKeys = useMemo(
    () => displayUnits.map((unit) => historyVirtuosoUnitKey(unit)),
    [displayUnits],
  );
  const displayUnitItemKeysRef = useRef(displayUnitItemKeys);
  displayUnitItemKeysRef.current = displayUnitItemKeys;
  const seekUnitKeyAt = useCallback(
    (index: number) => displayUnitItemKeysRef.current[index] || '',
    [],
  );
  const displayUnitLayoutKeys = useMemo(
    () => displayUnits.map((unit) => historyMeasuredUnitKey(unit)),
    [displayUnits],
  );
  const displayUnitLayoutKeysRef = useRef(displayUnitLayoutKeys);
  displayUnitLayoutKeysRef.current = displayUnitLayoutKeys;
  const materializeHistoryWindowForPresentation = useCallback((
    rawEntries: FullHistoryEntry[],
    reason: string,
  ) => {
    const protectedUuids = collectHistoryMaterializedWindowUuids(
      displayUnitsRef.current,
      visibleRangeRef.current,
    );
    const retained = retainHistoryMaterializedWindow(
      presentationEntriesRef.current,
      rawEntries,
      protectedUuids,
    );
    if (retained.retained > 0 || retained.rejected > 0) {
      historyDiag('MATERIALIZED_WINDOW_RETAIN tab=' + tabId.slice(-12)
        + ' reason=' + reason
        + ' protected=' + protectedUuids.size
        + ' retained=' + retained.retained
        + ' rejected=' + retained.rejected);
    }
    return retained.entries as FullHistoryEntry[];
  }, [tabId]);
  // uuid → unit index for every entry uuid (members of collapsed groups map
  // to their group's unit). THE translation layer: no uuid-consumer below may
  // scan units itself.
  const unitIndexByUuid = useMemo(() => {
    const map = new Map<string, number>();
    for (let index = 0; index < displayUnits.length; index += 1) {
      const unit = displayUnits[index] as any;
      if (unit.kind === 'entry') {
        if (unit.entry?.uuid) map.set(unit.entry.uuid, index);
        // A caption merged into its call's row stays addressable there.
      } else {
        for (const member of unit.entries) {
          if (member?.uuid) map.set(member.uuid, index);
        }
      }
    }
    return map;
  }, [displayUnits]);
  const unitIndexByUuidRef = useRef(unitIndexByUuid);
  unitIndexByUuidRef.current = unitIndexByUuid;
  // Expand the group containing `uuid` (no-op when visible already). Returns
  // true when an expansion actually happened — jump loops then re-resolve on
  // the next frame against the new unit list.
  const expandGroupForUuid = useCallback((uuid: string, reason: string) => {
    const target = resolveHistoryDisplayTarget(displayUnitsRef.current, uuid);
    if (!target || !(target as any).groupKey) return false;
    const groupKey = (target as any).groupKey as string;
    historyDiag('JUMP_EXPAND tab=' + tabId.slice(-12)
      + ' uuid=' + uuid.slice(0, 8)
      + ' group=' + groupKey.slice(0, 24)
      + ' reason=' + reason);
    setExpandedGroupKeys((previous) => {
      if (previous.has(groupKey)) return previous;
      const next = new Set(previous);
      next.add(groupKey);
      return next;
    });
    return true;
  }, [tabId]);
  const visibleTerminalPreview = terminalPreview?.tabId === tabId
    && terminalPreview.toolType === toolType
    && (!sessionId || !terminalPreview.sessionId || terminalPreview.sessionId === sessionId)
    ? terminalPreview
    : null;
  const terminalPreviewCanonicalMaterialized = !!visibleTerminalPreview
    && terminalPreviewClearHandoff?.previewId === visibleTerminalPreview.previewId;
  const historyVirtuosoContext = useMemo<HistoryVirtuosoContext>(
    () => ({
      terminalPreview: visibleTerminalPreview,
      terminalPreviewCanonicalMaterialized,
      responseTiming: responseTailTiming,
      seekUnitKeyAt,
    }),
    [visibleTerminalPreview, terminalPreviewCanonicalMaterialized, responseTailTiming, seekUnitKeyAt],
  );
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
  const armHistoryViewportPaintProof = useCallback(() => {
    if (displayEntriesRef.current.length === 0) return;
    viewportReadyOwnerKeyRef.current = '';
    setViewportReadyOwnerKey('');
    setViewportProofRequired(true);
    surfacePresentedOwnerRef.current = '';
  }, []);
  const consumeHistoryViewportPaintProof = useCallback(({
    ownerKey,
    generation,
    presentationVisit,
    proof,
    domRows,
    source,
  }: {
    ownerKey: string;
    generation: number;
    presentationVisit: number;
    proof: 'mounted-painted-row' | 'painted-empty-state';
    domRows: number;
    source: string;
  }) => {
    const result = resolveHistoryViewportPaintProof({
      currentOwnerKey: historyOwnerKeyRef.current,
      currentGeneration: historyOwnerGenerationRef.current,
      currentPresentation: historyPresentationProofRef.current,
      readyOwnerKey: viewportReadyOwnerKeyRef.current,
      proofRequired: viewportReadyOwnerKeyRef.current !== historyOwnerKeyRef.current,
      ownerKey,
      generation,
      presentationVisit,
      proof,
      domRows,
    });
    if (!result.accepted) return false;
    if (result.changed) {
      viewportReadyOwnerKeyRef.current = result.readyOwnerKey;
      setViewportReadyOwnerKey(result.readyOwnerKey);
      setViewportProofRequired(result.proofRequired);
      historyDiag('VIEWPORT_READY tab=' + tabId.slice(-12)
        + ' owner=' + historyOwnerDigest(ownerKey)
        + ' generation=' + generation
        + ' presentationVisit=' + presentationVisit
        + ' domRows=' + domRows
        + ' proof=' + proof
        + ' source=' + source);
    }
    return true;
  }, [tabId]);
  const publishHistorySurfacePresented = useCallback(({
    ownerKey,
    generation,
    presentationVisit,
    proof,
    domRows,
    foreignDomRows,
    cache,
  }: {
    ownerKey: string;
    generation: number;
    presentationVisit: number;
    proof: 'mounted-painted-row' | 'painted-empty-state';
    domRows: number;
    foreignDomRows: number;
    cache: 'hit' | 'miss';
  }) => {
    // One painted-frame fact owns both gates. Previously this publisher only
    // released Timeline, leaving History's viewportPending bit armed forever
    // when rangeChanged had fired while mount-wave rows were still shells.
    if (!consumeHistoryViewportPaintProof({
      ownerKey,
      generation,
      presentationVisit,
      proof,
      domRows,
      source: 'surface-presented',
    })) return false;
    const detail = {
      tabId,
      sessionId: sessionId || null,
      toolType,
      owner: historyOwnerDigest(ownerKey),
      generation,
      presentationVisit,
      proof,
      domRows,
      foreignDomRows,
      cache,
    };
    // Recorded BEFORE dispatch so a subscriber mounting later (HMR remount,
    // deferred owner handoff) can replay the proof instead of waiting on a
    // bus that will stay silent — see readPresentedHistorySurface.
    recordHistorySurfacePresented(detail);
    window.dispatchEvent(new CustomEvent('history-panel:surface-presented', {
      detail,
    }));
    return true;
  }, [consumeHistoryViewportPaintProof, sessionId, tabId, toolType]);
  // Virtuoso now renders display UNITS. Every uuid-to-index consumer (anchor
  // restore, Timeline jump, search, hydration seeding) must receive UNIT
  // indices — this map is the single translation and already resolves a uuid
  // hidden inside a collapsed group to the group's own row.
  const displayEntryIndexByUuid = unitIndexByUuid;
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
      ?? (displayUnits.length > 0 ? displayUnits.length - 1 : 0);
  // Measured geometry of THIS owner, resolved once per physical list mount. An
  // explicit Timeline jump owns the position and must not be overridden by a
  // stored scroll offset.
  //
  // `restoreStateFrom` is consumed exactly once by Virtuoso. Legacy/shared
  // panels physically move on a new owner visit and therefore still use the
  // owner generation. Persistent panes do not: opacity/inert-only return keeps
  // the live scroller, its measured rows and its scrollTop. A real geometry
  // move receives an explicit presentationRestoreTick below.
  const historyOwnerVisit = historyOwnerVisitState;
  // Restored geometry is LATCHED once per physical mount, at the first render where the
  // list is actually eligible to mount with THIS owner's rows. A plain memo on
  // [owner, visit] resolved at the wrong moment on every cache-miss return:
  // the visit bump fires while entries are still the freshly seeded empty
  // array, so the count guard answered null — and with memo deps excluding
  // entries, the answer was never revisited when the real rows landed. Every
  // cache-miss return therefore fell back to the anchor hunt (measured 04.08
  // 20:21: 13 jumps / 1481ms of chopped frames) even when valid geometry
  // existed. The latch keeps the per-visit stability the memo was after (the
  // resolved value never changes mid-visit, so the list is not re-anchored
  // under the user) while moving the resolve to the first render where the
  // loader is off and rows are present — exactly the render that mounts the
  // list, which is the only moment `restoreStateFrom` is consumed. A stable
  // persistent show never resets this latch.
  //
  // Gates, each load-bearing:
  // - !surfaceLoading: the list is not in the tree while the loader shows, so
  //   nothing consumed here would reach a mount; and on a cache-hit switch the
  //   render right after the takeover effect is exactly the render that mounts
  //   the list — the latch must resolve there, with the new owner's cached
  //   rows already providing the correct count.
  // - rows > 0: an empty seed cannot be judged against a stored count.
  //
  // A follow-bottom anchor deliberately KEEPS the geometry: mounting from real
  // measured sizes paints the neighborhood instantly, and the restore effect
  // below runs the tail convergence on top so rows appended while away still
  // land the viewport at the CURRENT tail, not the tail as of save time.
  const restoredLayoutLatchRef = useRef<{
    visitKey: string;
    resolved: boolean;
    layout: ReturnType<typeof getHistoryMeasuredLayout>;
    avgRowHeight: number | null;
  } | null>(null);
  // ===== Mount wave (see the module-level arbiter for the why) =====
  // Render-driving state is REAL state, not a ref: each step's upgrade set is
  // committed inside startTransition, so an urgent render racing the
  // transition (a keystroke, a click) still sees the previous committed set
  // and cannot be tricked into mounting the whole batch at urgent priority —
  // the exact hazard of mutating a ref and "publishing" it via transition.
  const [mountWaveRenderState, setMountWaveRenderState] = useState<{
    visitKey: string;
    realUuids: Set<string>;
    done: boolean;
    interruptEpoch: number;
  }>({ visitKey: '', realUuids: new Set(), done: true, interruptEpoch: 0 });
  // Non-render mechanics: which rows are wave-eligible (a snapshot of the
  // rows that existed when the visit mounted — live rows streaming in later
  // are NEVER shelled, they render real immediately), the per-index height
  // resolver, and step accounting.
  const mountWaveMetaRef = useRef<{
    visitKey: string;
    shellUuids: Set<string>;
    heightLookup: (index: number) => number;
    heightsFrom: 'measured' | 'avg';
    startedAt: number;
    steps: number;
    upgraded: number;
    maxStepMs: number;
    batchSize: number;
    stepStartedAt: number;
    pendingStepUuids: string[] | null;
    pendingStepToken: number;
    clearStepInterrupt: (() => void) | null;
    stepEndMark: (() => void) | null;
    keepBottom: boolean;
    loggedStart: boolean;
    bankedDone: boolean;
  } | null>(null);
  const mountWaveStepSequenceRef = useRef(0);
  const mountWaveLaneRef = useRef<HistoryMountWaveLane | null>(null);
  const mountWaveStepRef = useRef<() => void>(() => {});
  if (!mountWaveLaneRef.current) {
    mountWaveLaneRef.current = {
      wants: false,
      visible: () => (
        historyPresentationProofRef.current.presented
        && !!virtuosoScrollerRef.current?.isConnected
      ),
      run: () => mountWaveStepRef.current(),
    };
  }
  // A persistent pane keeps one physical Virtuoso across opacity/inert-only
  // visits. Presentation visits version deferred writes, but only an owner or
  // geometry change may version the physical list. Legacy/shared panels still
  // use their owner visit because that panel can genuinely move.
  const restoredLayoutVisitKey = presentationExternallyManaged
    ? historyOwnerKey + ':mount:' + presentationRestoreTick
    : historyOwnerKey + ':visit:' + historyOwnerVisit;
  if (restoredLayoutLatchRef.current?.visitKey !== restoredLayoutVisitKey) {
    restoredLayoutLatchRef.current = {
      visitKey: restoredLayoutVisitKey,
      resolved: false,
      layout: null,
      avgRowHeight: null,
    };
  }
  // The latch resolves exactly when the list is mountable this render (same
  // conditions as the render stub below): loader off, rows present, the
  // takeover effect has published this owner (no transitional commit, no
  // pre-takeover visit 0). Anything looser resolves during commits that are
  // discarded before paint and double-logs the restore.
  if (
    !restoredLayoutLatchRef.current.resolved
    && !surfaceLoading
    && !ownerChangedBeforeLayoutHandoff
    && historyOwnerVisit > 0
    && displayEntries.length > 0
  ) {
    const latch = restoredLayoutLatchRef.current;
    latch.resolved = true;
    // Geometry is measured against DISPLAY UNITS (groups collapse rows), so
    // the stored item count must be compared in the same space.
    const storedLayout = getHistoryMeasuredLayout(historyOwnerKey, displayUnitLayoutKeys);
    // The height ESTIMATE is useful even when the position restore is not:
    // a Timeline jump owns the position, but unmeasured rows around the
    // target still size from this per-owner average instead of Virtuoso's
    // first-row guess (a 40px prompt next to a 500px diff card).
    latch.avgRowHeight = estimateHistoryAverageRowHeight(storedLayout);
    // An explicit Timeline jump owns the position for this visit.
    latch.layout = pendingInitialHistoryIndex >= 0 ? null : storedLayout;
    if (latch.layout) {
      historyDiag('LAYOUT_RESTORE tab=' + tabId.slice(-12)
        + ' owner=' + historyOwnerDigest(historyOwnerKey)
        + ' ranges=' + latch.layout.ranges.length
        + ' scrollTop=' + Math.round(latch.layout.scrollTop));
    }
    // Seed the mount wave for this visit, in the SAME render that mounts the
    // list — the first list commit must already render shells, not real
    // cards, or the whole point (no giant takeover commit) is lost. Only the
    // rows present at mount are eligible: anything streaming in later has no
    // stored height and belongs to the live path.
    const abandonedWave = mountWaveMetaRef.current;
    if (abandonedWave && abandonedWave.loggedStart && !abandonedWave.bankedDone
      && abandonedWave.visitKey !== restoredLayoutVisitKey) {
      // The owner left mid-wave (A→B before A finished hydrating). Nothing
      // needs cleanup — every stale step is dropped by the visit-key guards —
      // but the abandonment must be visible in the log, or E2E cannot tell
      // "wave cancelled correctly" from "wave finished".
      historyDiag('MOUNT_WAVE_CANCEL tab=' + tabId.slice(-12)
        + ' visit=' + abandonedWave.visitKey.slice(-14)
        + ' upgraded=' + abandonedWave.upgraded
        + ' steps=' + abandonedWave.steps);
    }
    abandonedWave?.clearStepInterrupt?.();
    abandonedWave?.stepEndMark?.();
    mountWaveMetaRef.current = {
      visitKey: restoredLayoutVisitKey,
      // Wave shells are per display UNIT: a collapsed group is one shell
      // (keyed by its first member's uuid, which is also its data-uuid).
      shellUuids: new Set(displayUnits.map((unit) => historyDisplayUnitUuid(unit)).filter(Boolean)),
      heightLookup: createHistoryRowHeightLookup(
        storedLayout,
        latch.avgRowHeight ?? HISTORY_DEFAULT_ROW_HEIGHT_PX,
      ),
      heightsFrom: storedLayout ? 'measured' : 'avg',
      startedAt: performance.now(),
      steps: 0,
      upgraded: 0,
      maxStepMs: 0,
      batchSize: 1,
      stepStartedAt: 0,
      pendingStepUuids: null,
      pendingStepToken: 0,
      clearStepInterrupt: null,
      stepEndMark: null,
      keepBottom: false,
      loggedStart: false,
      bankedDone: false,
    };
  }
  // Adjust-during-render for the wave's render state: the visit key changed
  // (new owner or new return), so the previous visit's upgrade set must not
  // leak real cards into this visit's first commit.
  if (mountWaveRenderState.visitKey !== restoredLayoutVisitKey) {
    setMountWaveRenderState({
      visitKey: restoredLayoutVisitKey,
      realUuids: new Set(),
      done: false,
      interruptEpoch: mountWaveRenderState.interruptEpoch,
    });
  }
  const mountWaveActive =
    !mountWaveRenderState.done
    && mountWaveMetaRef.current?.visitKey === restoredLayoutVisitKey;
  // Callbacks (geometry savers, seek suppressor) read the live value.
  const mountWaveActiveRef = useRef(mountWaveActive);
  mountWaveActiveRef.current = mountWaveActive;
  const mountWaveRenderStateRef = useRef(mountWaveRenderState);
  mountWaveRenderStateRef.current = mountWaveRenderState;
  const restoredLayoutVisitKeyRef = useRef(restoredLayoutVisitKey);
  restoredLayoutVisitKeyRef.current = restoredLayoutVisitKey;
  const restoredMeasuredLayout = restoredLayoutLatchRef.current.layout;
  const historyDefaultRowHeight =
    restoredLayoutLatchRef.current.avgRowHeight ?? HISTORY_DEFAULT_ROW_HEIGHT_PX;
  // Height source for row-window stubs. The mount wave's lookup covers the
  // visit's own rows; a stub can also appear later (hydration span moved
  // while the wave was long done), so the lookup is kept independently and
  // falls back to the owner's average — the same estimate Virtuoso uses for
  // never-measured rows, which is what keeps the scrollbar from lurching.
  const historyRowHeightLookup = useMemo(
    () => createHistoryRowHeightLookup(restoredMeasuredLayout, historyDefaultRowHeight),
    [restoredMeasuredLayout, historyDefaultRowHeight],
  );
  const rewindPreviewHiddenTurnCount = rewindPreviewResult.hiddenTurnCount;
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
  // This is user intent, not a sample of current geometry. A streaming footer
  // temporarily increases scrollHeight before the follow scroll lands; that
  // must not look like the user scrolled away from the tail.
  const isAtBottomRef = useRef(true);
  // react-virtuoso has a separate SIZE_INCREASED fallback that checks whether
  // the followOutput PROP itself is strictly false; a callback returning false
  // is still treated as enabled. Mirror intent into a primitive prop so an
  // explicit reveal-unpin reaches the library before the row count changes.
  const [historyFollowOutputEnabled, setHistoryFollowOutputEnabled] = useState(true);
  const historyFollowOutputEnabledRef = useRef(true);
  const setHistoryTailFollowIntent = useCallback((next: boolean) => {
    isAtBottomRef.current = next;
    if (historyFollowOutputEnabledRef.current === next) return;
    historyFollowOutputEnabledRef.current = next;
    setHistoryFollowOutputEnabled(next);
  }, []);
  const historyPointerScrollActiveRef = useRef(false);
  // Timestamp of the last REAL scroll gesture (wheel/touch/scroll keys).
  // Programmatic scrollTop writes cannot move it; the collapse hold loop
  // reads it to yield to the user instantly.
  const historyUserGestureAtRef = useRef(0);
  const historyUserGestureGenerationRef = useRef(0);
  const historyUserScrollDirectionRef = useRef<'up' | 'down' | null>(null);
  const historyScrollTraceSequenceRef = useRef(0);
  const historyScrollGestureTraceRef = useRef<HistoryScrollGestureTrace | null>(null);
  // Bumped by real user scroll intent and by owner change; the scroll-restore
  // convergence loop checks it each frame so it never fights the user.
  const scrollRestoreGenRef = useRef(0);
  // Non-zero while a restore (convergence loop or geometry application) owns
  // the scroller. Position/geometry writers must not record the restore's own
  // transient positions as "where the user is" — leaving the tab mid-hunt
  // would then restore to a half-converged offset. Token, not boolean: an
  // abandoned loop's abort callback can fire one frame AFTER the next owner's
  // loop already started, and a boolean reset there would unsuppress the live
  // loop. Each restore takes a fresh token and only clears its own.
  const historyRestoreInFlightRef = useRef(0);
  const historyRestoreTokenRef = useRef(0);
  // Composer height is reported OUTWARD (the terminal stage and the Run after
  // strip are laid out against it) but this panel no longer positions anything
  // by it: the composer is the column's last row, so the transcript stage's
  // own bottom edge already is the input's top border. A ref, not state — a
  // re-render on every keystroke-driven resize bought nothing.
  const controlsHeightRef = useRef(0);
  const prevVisibleUuidsRef = useRef('');
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Virtuoso's actual scroller element (filled via `scrollerRef` callback).
  // Used by Cmd+F CSS Highlight API to walk text nodes of the currently
  // mounted item range. Virtuoso unmounts off-screen items, so highlights
  // re-apply on every range change via the same effect (matchPositions deps).
  const virtuosoScrollerRef = useRef<HTMLElement | null>(null);
  const historyVirtuosoHeightLogRef = useRef({ gestureId: 0, count: 0 });
  const historyWheelGeometryFreezeRef = useRef<{
    scroller: HTMLElement | null;
    rows: Map<HTMLElement, {
      height: string;
      minHeight: string;
      maxHeight: string;
      overflow: string;
      frozenHeight: number;
    }>;
    observer: MutationObserver | null;
    timer: ReturnType<typeof setTimeout> | null;
    pendingSeekExit: boolean;
    seekExitAnchor: { identity: string; top: number; bottomGap: number } | null;
  }>({
    scroller: null,
    rows: new Map(),
    observer: null,
    timer: null,
    pendingSeekExit: false,
    seekExitAnchor: null,
  });
  const historyWheelGeometryReleaseSettleCancelRef = useRef<(() => void) | null>(null);
  const historySeekGeometryMaskReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historySeekRealRowsReadyCancelRef = useRef<(() => void) | null>(null);
  const historyScrollSeekTransitionRef = useRef<((event: any) => void) | null>(null);
  // Declared beside the seek controller because suppression is panel-local:
  // a Timeline jump in pane A must not disable placeholders in pane B.
  const historyScrollInFlightRef = useRef<{
    uuid: string;
    gen: number;
    startedAt: number;
    attempts: number;
  } | null>(null);
  const historyScrollSeekController = useMemo(
    () => createHistoryScrollSeekController({
      isSuppressed: () => (
        !historyPresentationProofRef.current.presented
        || historyRestoreInFlightRef.current !== 0
        || historyScrollInFlightRef.current !== null
        || isAtBottomRef.current
      ),
      onTransition: (event) => {
        if (event.kind === 'enter') {
          historyDiag('SCROLL_SEEK_ENTER tab=' + tabId.slice(-12)
            + ' velocity=' + Math.round(event.velocity)
            + ' burst=' + (event.burst ? '1' : '0')
            + ' wheelGesture=' + (event.wheelGesture ? '1' : '0')
            + ' owner=' + historyOwnerDigest(historyOwnerKeyRef.current));
        } else {
          historyDiag('SCROLL_SEEK_EXIT tab=' + tabId.slice(-12)
            + ' velocity=' + Math.round(event.velocity || 0)
            + ' heldMs=' + Math.round(event.heldMs || 0)
            + ' reason=' + event.reason
            + ' owner=' + historyOwnerDigest(historyOwnerKeyRef.current));
        }
        historyScrollSeekTransitionRef.current?.(event);
      },
    }),
    [],
  );
  const historyScrollerOwnerToken = useCallback(
    () => {
      const proof = historyPresentationProofRef.current;
      return historyOwnerKeyRef.current + ':' + historyOwnerGenerationRef.current
        + ':p' + (proof.presented ? '1' : '0') + ':v' + proof.visit;
    },
    [],
  );
  useEffect(
    () => () => historyScrollSeekController.dispose(),
    [historyScrollSeekController],
  );
  const historyTailPinScheduler = useMemo(
    () => createHistoryTailPinScheduler({
      getScroller: () => virtuosoScrollerRef.current,
      getOwnerToken: () => {
        const proof = historyPresentationProofRef.current;
        return historyOwnerKeyRef.current + ':' + historyOwnerGenerationRef.current
          + ':p' + (proof.presented ? '1' : '0') + ':v' + proof.visit;
      },
    }),
    [],
  );
  useEffect(
    () => () => historyTailPinScheduler.cancel(),
    [historyTailPinScheduler],
  );
  // Virtuoso follows appends when the number of presentation rows grows, but
  // a live answer often mutates the existing tail row (streamed assistant
  // text) or extends the current collapsed group without increasing the unit
  // count. In that case followOutput sees no append even though the transcript
  // visibly grew below the reader. Keep the physical edge aligned whenever
  // the reader still owns tail-follow intent. A real upward gesture clears the
  // intent and cancels this scheduler in the gesture handlers below.
  const keepHistoryTailPinnedAfterMutation = useCallback((
    reason: string,
    allowPhysicalBottomRearm = false,
  ) => {
    // Hidden persistent panes keep receiving transcript data, but they do not
    // own viewport writes. Their next visible visit restores the saved
    // follow-bottom/reading anchor through the presentation handoff.
    if (!historyPresentationProofRef.current.presented) return false;
    if (historyPointerScrollActiveRef.current) return false;
    const scroller = virtuosoScrollerRef.current;
    const shouldFollow = isAtBottomRef.current || (
      allowPhysicalBottomRearm
      && !!scroller
      && isHistoryAtContentBottom(scroller)
    );
    if (!shouldFollow) return false;
    const rearmed = !isAtBottomRef.current;
    if (rearmed) setHistoryTailFollowIntent(true);
    const wasPending = historyTailPinScheduler.isPending();
    const scheduled = historyTailPinScheduler.schedule({
      shouldPin: true,
      delayFrames: 2,
      // Sending is not one layout change. The optimistic card, the cleared
      // composer and the canonical card settle on different frames. A single
      // two-frame scroll can land between them and briefly turn a tail reader
      // into a mid-list reader. Keep the same owner pinned until its geometry
      // is stable; wheel/touch/reveal handlers already cancel this scheduler.
      settleUntilStable: true,
      minimumSettleFrames: HISTORY_TAIL_MUTATION_MIN_SETTLE_FRAMES,
      maximumSettleFrames: HISTORY_TAIL_MUTATION_MAX_SETTLE_FRAMES,
      requiredStableFrames: HISTORY_TAIL_MUTATION_REQUIRED_STABLE_FRAMES,
      onApplied: (settledScroller: HTMLElement, result?: {
        frames?: number;
        settled?: boolean;
        distancePx?: number;
      }) => {
        historyDiag('TAIL_MUTATION_PIN_DONE tab=' + tabId.slice(-12)
          + ' reason=' + reason
          + ' frames=' + Math.round(result?.frames || 0)
          + ' settled=' + (result?.settled ? '1' : '0')
          + ' distancePx=' + Math.round(result?.distancePx || 0)
          + ' scrollTop=' + Math.round(settledScroller.scrollTop));
      },
    });
    const active = scheduled || historyTailPinScheduler.isPending();
    if (active) {
      historyDiag('TAIL_MUTATION_PIN tab=' + tabId.slice(-12)
        + ' reason=' + reason
        + ' rearmed=' + (rearmed ? '1' : '0')
        + ' coalesced=' + (wasPending && !scheduled ? '1' : '0'));
    }
    return active;
  }, [historyTailPinScheduler, setHistoryTailFollowIntent, tabId]);
  // Card- and group-level toggles both need this panel's follow ownership.
  // Card toggles run through the shared applyHistoryRevealUpdate helper,
  // which looks the ops up by scroller element (column mode mounts several
  // panels at once) — registered from the scrollerRef callback below so it
  // exists before the first possible click.
  const historyRevealOps = useMemo<HistoryRevealScrollerOps>(() => ({
    unpinTail: () => {
      // Separate synchronous commit: Virtuoso must observe literal
      // followOutput=false BEFORE the following commit changes item count.
      flushSync(() => setHistoryTailFollowIntent(false));
      // A wheel that reached the tail immediately before this click no longer
      // owns the resize commit. Otherwise its recent "down" proof re-pins the
      // group expansion to the new bottom and moves the clicked header up.
      historyUserGestureAtRef.current = 0;
      historyUserScrollDirectionRef.current = null;
      historyTailPinScheduler.cancel();
    },
  }), [historyTailPinScheduler, setHistoryTailFollowIntent]);
  // Correlated geometry proof for the reported first-toggle-only jerk. A group
  // click can coincide with tab activation, a cold display-unit signature,
  // Virtuoso remeasurement or a competing machine scroll. The old one-line
  // GROUP_EXPAND/GROUP_COLLAPSE log named the click but none of those writers,
  // so a visible nudge was indistinguishable from ordinary legal reflow.
  // This observer is read-only: it records the click frame, two layout frames
  // and the post-measure settle without steering scroll or React state.
  const historyGroupToggleTraceSeqRef = useRef(0);
  const traceHistoryGroupToggleGeometry = useCallback((
    groupKey: string,
    action: 'expand' | 'collapse',
    source: string,
  ) => {
    const scroller = virtuosoScrollerRef.current;
    if (!scroller) return;
    const token = ++historyGroupToggleTraceSeqRef.current;
    const ownerKey = historyOwnerKeyRef.current;
    const ownerGeneration = historyOwnerGenerationRef.current;
    const startedAt = performance.now();
    const sample = (phase: 'before' | 'frame1' | 'frame2' | 'settled') => {
      if (!scroller.isConnected) return;
      if (
        historyOwnerKeyRef.current !== ownerKey
        || historyOwnerGenerationRef.current !== ownerGeneration
      ) {
        historyDiag('GROUP_GEOMETRY tab=' + tabId.slice(-12)
          + ' token=' + token
          + ' action=' + action
          + ' source=' + source
          + ' phase=' + phase
          + ' stale=owner');
        return;
      }
      let header: HTMLElement | null = null;
      for (const node of Array.from(scroller.querySelectorAll<HTMLElement>('[data-history-group]'))) {
        if (node.getAttribute('data-history-group') === groupKey) { header = node; break; }
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const headerRect = header?.getBoundingClientRect() || null;
      const groupUnitIndex = displayUnitsRef.current.findIndex(
        (unit: any) => unit?.kind === 'group' && unit.key === groupKey,
      );
      const groupUnit = groupUnitIndex >= 0
        ? displayUnitsRef.current[groupUnitIndex] as any
        : null;
      const groupEntries = Array.isArray(groupUnit?.entries) ? groupUnit.entries : [];
      const state = useWorkspaceStore.getState();
      let activeTab = false;
      for (const workspace of state.openProjects.values()) {
        if (!workspace.tabs.has(tabId)) continue;
        activeTab = workspace.activeTabId === tabId;
        break;
      }
      historyDiag('GROUP_GEOMETRY tab=' + tabId.slice(-12)
        + ' token=' + token
        + ' action=' + action
        + ' source=' + source
        + ' phase=' + phase
        + ' elapsedMs=' + Math.round(performance.now() - startedAt)
        + ' active=' + (activeTab ? 1 : 0)
        + ' unitIdx=' + groupUnitIndex
        + ' units=' + displayUnitsRef.current.length
        + ' members=' + groupEntries.length
        + ' memberStubs=' + groupEntries.filter((entry: any) => entry?.rowStub).length
        + ' expanded=' + (groupUnit?.expanded === true ? 1 : 0)
        + ' header=' + (header ? 1 : 0)
        + ' headerTop=' + (headerRect ? Math.round(headerRect.top - scrollerRect.top) : 'na')
        + ' headerHeight=' + (headerRect ? Math.round(headerRect.height) : 'na')
        + ' scrollTop=' + Math.round(scroller.scrollTop)
        + ' scrollHeight=' + Math.round(scroller.scrollHeight)
        + ' clientHeight=' + Math.round(scroller.clientHeight)
        + ' range=' + visibleRangeRef.current.start + '-' + visibleRangeRef.current.end
        + ' shells=' + scroller.querySelectorAll('[data-history-mount-shell]').length
        + ' stubs=' + scroller.querySelectorAll('[data-history-row-stub]').length
        + ' follow=' + (isAtBottomRef.current ? 1 : 0)
        + ' followProp=' + (historyFollowOutputEnabledRef.current ? 1 : 0)
        + ' physicalPinned=' + (isHistoryAtContentBottom(scroller) ? 1 : 0)
        + ' tailPinPending=' + (historyTailPinScheduler.isPending() ? 1 : 0)
        + ' restore=' + (historyRestoreInFlightRef.current ? 1 : 0)
        + ' jump=' + (historyScrollInFlightRef.current ? 1 : 0)
        + ' hydration=' + (hydrationRequestInFlightRef.current ? 1 : 0)
        + ' wave=' + (mountWaveActiveRef.current ? 1 : 0));
    };
    sample('before');
    requestAnimationFrame(() => {
      sample('frame1');
      requestAnimationFrame(() => {
        sample('frame2');
        setTimeout(() => sample('settled'), 200);
      });
    });
  }, [historyTailPinScheduler, tabId]);
  // Group toggles obey the same stationary-click law as card toggles (see
  // applyHistoryRevealUpdate): the clicked header does not move. Expand
  // grows the list BELOW the header (unpin first, or followOutput treats the
  // growth as new content and jumps to the new bottom — the reported
  // «нажимаю, и строчка уходит вверх»). Collapse accepts the browser's new
  // scroll range; no fake footer is created. Toggles are click-driven, so the
  // header is on screen by construction.
  const pendingHistoryGroupExpandRef = useRef<{
    groupKey: string;
    reason: string;
    scroller: HTMLElement | null;
    targetHeaderTop: number | null;
    ownerKey: string;
    ownerGeneration: number;
    gestureGeneration: number;
  } | null>(null);
  const [historyGroupExpandStage, setHistoryGroupExpandStage] = useState(0);

  const stabilizePendingHistoryGroupExpand = useCallback((pending: NonNullable<
    typeof pendingHistoryGroupExpandRef.current
  >) => {
    const {
      groupKey,
      reason,
      scroller,
      targetHeaderTop,
      ownerKey,
      ownerGeneration,
      gestureGeneration,
    } = pending;
    if (!scroller || targetHeaderTop === null) return;
    stabilizeHistoryRevealAnchor({
      targetTop: targetHeaderTop,
      readAnchorTop: () => {
        if (!scroller.isConnected) return null;
        for (const node of Array.from(scroller.querySelectorAll<HTMLElement>('[data-history-group]'))) {
          if (node.getAttribute('data-history-group') === groupKey) {
            return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          }
        }
        return null;
      },
      adjustScrollBy: (delta: number, correctionSource: string) => {
        const before = scroller.scrollTop;
        scroller.scrollTop += delta;
        historyDiag('GROUP_ANCHOR_WRITE tab=' + tabId.slice(-12)
          + ' key=' + groupKey.slice(0, 24)
          + ' reason=' + reason
          + ' source=' + correctionSource
          + ' delta=' + Math.round(delta)
          + ' before=' + Math.round(before)
          + ' after=' + Math.round(scroller.scrollTop)
          + ' follow=' + (isAtBottomRef.current ? 1 : 0)
          + ' followProp=' + (historyFollowOutputEnabledRef.current ? 1 : 0)
          + ' physicalPinned=' + (isHistoryAtContentBottom(scroller) ? 1 : 0));
      },
      subscribePositionChange: (listener: () => void) => {
        // Capture runs before History's ordinary scroll listener. A delayed
        // Virtuoso/browser compensation is therefore reverted in the same
        // pre-paint scroll dispatch, while a real wheel/touch/drag has already
        // advanced gestureGeneration and is allowed through unchanged.
        scroller.addEventListener('scroll', listener, { capture: true, passive: true });
        return () => scroller.removeEventListener('scroll', listener, true);
      },
      isCurrent: () => (
        scroller.isConnected
        && historyOwnerKeyRef.current === ownerKey
        && historyOwnerGenerationRef.current === ownerGeneration
      ),
      hasUserGesture: () => (
        historyPointerScrollActiveRef.current
        || historyUserGestureGenerationRef.current !== gestureGeneration
      ),
      onFinish: (outcome: any) => {
        historyDiag('GROUP_ANCHOR_SETTLE tab=' + tabId.slice(-12)
          + ' key=' + groupKey.slice(0, 24)
          + ' reason=' + reason
          + ' outcome=' + outcome.reason
          + ' frames=' + outcome.frames
          + ' writes=' + outcome.writes
          + ' positionSignals=' + outcome.positionSignals
          + ' maxDriftPx=' + Math.round(outcome.maxDriftPx));
      },
    });
  }, [tabId]);

  // Expansion is intentionally a TWO-COMMIT transaction. Turning our React
  // state/ref false and changing Virtuoso's data in the same click task is not
  // proof that the library has consumed the false prop: its prop bridge runs
  // at the commit/effect boundary. Production 20.08 10:53 UTC showed the
  // signature exactly — cold follow=1 moved by the full +776px reveal and
  // needed three corrections; the same group with follow=0 needed none.
  //
  // The passive effect is the acknowledgement boundary: the unchanged,
  // collapsed list has already committed with followOutput=false. Only then
  // may item count grow. The following layout effect starts the semantic
  // anchor before that expanded commit is painted.
  useEffect(() => {
    const pending = pendingHistoryGroupExpandRef.current;
    if (!pending || historyFollowOutputEnabled) return;
    if (
      historyOwnerKeyRef.current !== pending.ownerKey
      || historyOwnerGenerationRef.current !== pending.ownerGeneration
    ) {
      pendingHistoryGroupExpandRef.current = null;
      return;
    }
    if (expandedGroupKeys.has(pending.groupKey)) return;
    historyDiag('GROUP_EXPAND_COMMIT tab=' + tabId.slice(-12)
      + ' key=' + pending.groupKey.slice(0, 24)
      + ' reason=' + pending.reason
      + ' barrier=follow-prop-effect');
    setExpandedGroupKeys((previous) => {
      if (previous.has(pending.groupKey)) return previous;
      const next = new Set(previous);
      next.add(pending.groupKey);
      return next;
    });
  }, [expandedGroupKeys, historyFollowOutputEnabled, historyGroupExpandStage, tabId]);

  useLayoutEffect(() => {
    const pending = pendingHistoryGroupExpandRef.current;
    if (!pending || !expandedGroupKeys.has(pending.groupKey)) return;
    pendingHistoryGroupExpandRef.current = null;
    stabilizePendingHistoryGroupExpand(pending);
  }, [expandedGroupKeys, stabilizePendingHistoryGroupExpand]);

  const expandGroupPreservingViewport = useCallback((groupKey: string, reason: string) => {
    const scroller = virtuosoScrollerRef.current;
    let clickedHeader: HTMLElement | null = null;
    if (scroller) {
      for (const node of Array.from(scroller.querySelectorAll<HTMLElement>('[data-history-group]'))) {
        if (node.getAttribute('data-history-group') === groupKey) { clickedHeader = node; break; }
      }
    }
    const scrollerTop = scroller?.getBoundingClientRect().top ?? 0;
    const targetHeaderTop = clickedHeader
      ? clickedHeader.getBoundingClientRect().top - scrollerTop
      : null;
    const ownerKey = historyOwnerKeyRef.current;
    const ownerGeneration = historyOwnerGenerationRef.current;
    const gestureGeneration = historyUserGestureGenerationRef.current;
    historyDiag('GROUP_EXPAND tab=' + tabId.slice(-12)
      + ' key=' + groupKey.slice(0, 24)
      + ' reason=' + reason);
    traceHistoryGroupToggleGeometry(groupKey, 'expand', reason);
    pendingHistoryGroupExpandRef.current = {
      groupKey,
      reason,
      scroller,
      targetHeaderTop,
      ownerKey,
      ownerGeneration,
      gestureGeneration,
    };
    historyRevealOps.unpinTail();
    // Also drives the barrier when follow was already false and unpinTail's
    // guarded setter correctly produced no render.
    setHistoryGroupExpandStage((stage) => stage + 1);
  }, [historyRevealOps, tabId, traceHistoryGroupToggleGeometry]);
  const collapseGroupPreservingViewport = useCallback((groupKey: string) => {
    // Same order as the card path: following off BEFORE the resize, or a
    // stale tail pin rides the shrink to the new bottom (+246px measured).
    traceHistoryGroupToggleGeometry(groupKey, 'collapse', 'header');
    historyRevealOps.unpinTail();
    flushSync(() => {
      setExpandedGroupKeys((previous) => {
        if (!previous.has(groupKey)) return previous;
        const next = new Set(previous);
        next.delete(groupKey);
        return next;
      });
    });
  }, [historyRevealOps, traceHistoryGroupToggleGeometry]);
  /**
   * Collapse from the expanded rail — either any segment of its vertical line
   * or the arrow at the foot.
   *
   * Where the view lands is the whole question. Collapsing removes everything
   * ABOVE the click point, so simply holding scrollTop would leave the user
   * staring at rows from further down the feed while the block they just
   * closed sits far above, off-screen — the block would appear to vanish.
   * The honest landing is the block's own header: it is what the whole
   * expansion collapsed INTO.
   *
   * Two cases, one rule («land on the header»):
   *  - header still on screen → do not add another scroll command;
   *  - header scrolled off above → put it back at the top of the viewport.
   * Near the physical bottom the browser may clamp the requested top position;
   * visibility of the header is the contract, not an impossible empty tail.
   */
  const collapseGroupFromFoot = useCallback((
    groupKey: string,
    source: 'foot' | 'rail' = 'foot',
  ) => {
    const scroller = virtuosoScrollerRef.current;
    if (!scroller) {
      collapseGroupPreservingViewport(groupKey);
      return;
    }
    // Attribute compare instead of a selector: group keys carry `:` and other
    // characters that would have to be escaped, and there are only a handful
    // of headers in a virtualized DOM.
    let header: HTMLElement | null = null;
    for (const node of Array.from(scroller.querySelectorAll<HTMLElement>('[data-history-group]'))) {
      if (node.getAttribute('data-history-group') === groupKey) { header = node; break; }
    }
    const headerOffset = header
      ? header.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      : null;
    const headerIndex = displayUnits.findIndex(
      (unit: any) => unit?.kind === 'group' && unit.key === groupKey,
    );
    historyDiag('GROUP_COLLAPSE tab=' + tabId.slice(-12)
      + ' key=' + groupKey.slice(0, 24)
      + ' reason=' + source
      + ' headerOffset=' + (headerOffset === null ? 'virtualized' : Math.round(headerOffset)));
    traceHistoryGroupToggleGeometry(groupKey, 'collapse', source);
    historyRevealOps.unpinTail();
    flushSync(() => {
      setExpandedGroupKeys((previous) => {
        if (!previous.has(groupKey)) return previous;
        const next = new Set(previous);
        next.delete(groupKey);
        return next;
      });
    });
    if (headerOffset === null || headerOffset < 0) {
      // The data list has just changed shape. A pre-collapse pixel target is
      // not authoritative for Virtuoso: its remeasurement may move the same
      // logical item hundreds of pixels. Ask for the header by index on the
      // first post-commit frame, then measure the REAL header and lock that
      // exact position on the next frame.
      requestAnimationFrame(() => {
        if (headerIndex < 0 || !scroller.isConnected) return;
        virtuosoRef.current?.scrollToIndex({ index: headerIndex, align: 'start' });
        requestAnimationFrame(() => {
          if (!scroller.isConnected) return;
          let landedHeader: HTMLElement | null = null;
          for (const node of Array.from(scroller.querySelectorAll<HTMLElement>('[data-history-group]'))) {
            if (node.getAttribute('data-history-group') === groupKey) { landedHeader = node; break; }
          }
          if (!landedHeader) {
            virtuosoRef.current?.scrollToIndex({ index: headerIndex, align: 'start' });
            return;
          }
          const landedOffset = landedHeader.getBoundingClientRect().top
            - scroller.getBoundingClientRect().top;
          const landedTarget = Math.max(0, scroller.scrollTop + landedOffset - 8);
          scroller.scrollTop = landedTarget;
        });
      });
      return;
    }
  }, [collapseGroupPreservingViewport, displayUnits, historyRevealOps, tabId, traceHistoryGroupToggleGeometry]);
  // Visible index range from Virtuoso. Drives the visible-uuid set without
  // an IntersectionObserver (cheaper, exact: no threshold guessing).
  const visibleRangeRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  // Row-window hydration state. `centerUuid` is what the NEXT request asks
  // main to hydrate around (null = tail, the cold-open default). There is
  // deliberately NO mirrored "hydrated span" bookkeeping here any more: the
  // 14.08 17:10 deadlock came exactly from that derived state rotting (a
  // delta response without row-window fields flipped it to "not windowed",
  // an owner switch inherited another tab's span) while the per-row
  // `rowStub` flags — main's ground truth — stayed correct. Every decision
  // now reads the rows themselves.
  const hydrationCenterUuidRef = useRef<string | null>(null);
  const hydrationRequestInFlightRef = useRef(false);
  const hydrationRangeIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Orphans a stale request's completion callback after an owner switch: the
  // old `.finally` must not clear the in-flight flag (or fire the pending
  // follow-up) of the NEXT owner's request.
  const hydrationRequestSeqRef = useRef(0);
  // A targeted request (Timeline jump, search match) that arrives while a
  // request is in flight is queued — not silently dropped — and issued when
  // the flight settles. Silent refusal is how a jump starved forever.
  const hydrationPendingRef = useRef<{
    centerUuid: string;
    reason: string;
    extra: string;
  } | null>(null);
  // Retry stopper: when main answers "that centre row does not exist in my
  // projection" (centerMissing), re-asking for the same uuid is a request
  // storm, not persistence. The jump loop's timeout handles the UX.
  const hydrationLastResultRef = useRef<{
    centerUuid: string | null;
    centerMissing: boolean;
  } | null>(null);
  // Re-issue cooldown over the RECENT centres, not just the last one. The
  // jump loop calls in every frame while its target is a stub; and a feedback
  // loop that ALTERNATES between two centres walks straight through a
  // single-slot cooldown (production 16.08 02:04: two stub flanks requested
  // in strict turns, each response evicting the other flank). A small map of
  // recently issued uuids refuses both.
  const hydrationLastIssuedRef = useRef<Map<string, number>>(new Map());
  // While a Timeline jump is converging, IT owns the hydration centre. The
  // viewport watcher fires on every intermediate range the hunt passes
  // through; letting it re-centre mid-jump can pull the span away from the
  // target right after the target hydrated (ping-pong until the deadline).
  const historyJumpHydrationActiveRef = useRef(false);
  // Burst accounting for the hydration oscillation breaker; reset by a real
  // user scroll (see the scroll handler) and by the window rolling over.
  const hydrationBurstRef = useRef<{ since: number; count: number; tripped: boolean }>({
    since: 0, count: 0, tripped: false,
  });
  // `loadHistory` is declared far below (it depends on the whole load
  // pipeline), but hydration is requested from callbacks defined ABOVE it —
  // search-match navigation, the Timeline-jump effect. A ref is the only way
  // to call it from there without a temporal-dead-zone crash; it is assigned
  // in the same render that creates loadHistory.
  const loadHistoryRef = useRef<((isRefresh?: boolean) => Promise<boolean>) | null>(null);
  /** One place that starts a hydration re-centre, for every caller. */
  const requestHistoryHydrationAtRef = useRef<(
    centerUuid: string | null,
    reason: string,
    extra?: string,
  ) => boolean>(() => false);
  requestHistoryHydrationAtRef.current = (
    centerUuid: string | null,
    reason: string,
    extra = '',
  ) => {
    if (!centerUuid) return false;
    const last = hydrationLastResultRef.current;
    if (last && last.centerMissing && last.centerUuid === centerUuid) return false;
    const issuedMap = hydrationLastIssuedRef.current;
    const issuedAt = issuedMap.get(centerUuid);
    if (issuedAt !== undefined && performance.now() - issuedAt < HYDRATION_REISSUE_COOLDOWN_MS) {
      return false;
    }
    if (hydrationRequestInFlightRef.current) {
      if (hydrationCenterUuidRef.current !== centerUuid) {
        const firstQueue = hydrationPendingRef.current?.centerUuid !== centerUuid;
        hydrationPendingRef.current = { centerUuid, reason, extra };
        if (firstQueue) {
          historyDiag('HYDRATION_QUEUED tab=' + tabId.slice(-12) +
            ' reason=' + reason + extra +
            ' uuid=' + centerUuid.slice(0, 8));
        }
      }
      return false;
    }
    const load = loadHistoryRef.current;
    if (!load) return false;
    const seq = ++hydrationRequestSeqRef.current;
    hydrationCenterUuidRef.current = centerUuid;
    hydrationRequestInFlightRef.current = true;
    issuedMap.set(centerUuid, performance.now());
    // Bounded: drop expired marks, keep the map at a handful of live ones.
    if (issuedMap.size > 8) {
      const cutoff = performance.now() - HYDRATION_REISSUE_COOLDOWN_MS;
      for (const [uuid, at] of issuedMap) {
        if (at < cutoff) issuedMap.delete(uuid);
      }
    }
    historyDiag('HYDRATION_REQUEST tab=' + tabId.slice(-12) +
      ' reason=' + reason + extra +
      ' uuid=' + centerUuid.slice(0, 8));
    void load(true).finally(() => {
      if (hydrationRequestSeqRef.current !== seq) return;
      hydrationRequestInFlightRef.current = false;
      const pending = hydrationPendingRef.current;
      hydrationPendingRef.current = null;
      if (pending && pending.centerUuid !== centerUuid) {
        requestHistoryHydrationAtRef.current(
          pending.centerUuid, pending.reason, pending.extra,
        );
      }
    });
    return true;
  };
  const requestHistoryHydrationAt = useCallback((
    centerUuid: string | null,
    reason: string,
    extra = '',
  ) => requestHistoryHydrationAtRef.current(centerUuid, reason, extra), []);
  // Latest entries length — let stable callbacks (scrollToBottom) read it
  // without depending on `entries` (which would invalidate downstream effects
  // on every refresh).
  const lengthRef = useRef(0);
  const panelDiagContextRef = useRef('');
  panelDiagContextRef.current = ' open=' + (isOpen ? 1 : 0) +
    ' embedded=' + (embedded ? 1 : 0) +
    ' tool=' + toolType;

  const handleHistoryToolWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY === 0) return;
    const outerScroller = virtuosoScrollerRef.current;
    if (!outerScroller) return;
    const body = historyToolScrollBodyFromTarget(event.target, outerScroller);
    if (!body) return;
    const innerScroller = findHistoryToolInnerScroller(body, event.target);
    if (!innerScroller) return;
    const scale = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? innerScroller.clientHeight
        : 1;
    const delta = event.deltaY * scale;
    // Pointer inside an expanded body scrolls THAT body — no click needed.
    //
    // The old contract demanded a click first (which also painted the rail
    // as a focus state) because everything used to be expanded by default and
    // a stray wheel could hijack the feed. With collapsed-by-default rows an
    // expanded body is always deliberate, so requiring a click was pure
    // friction (user decision 16.08). At the body's own edge the wheel chains
    // out to the feed, the way nested scrollers normally behave.
    const atTop = innerScroller.scrollTop <= 0;
    const atBottom = innerScroller.scrollTop + innerScroller.clientHeight
      >= innerScroller.scrollHeight - 1;
    const wantsOut = (delta < 0 && atTop) || (delta > 0 && atBottom);
    if (wantsOut) {
      if (event.cancelable) event.preventDefault();
      outerScroller.scrollTop += delta;
      return;
    }
    if (event.cancelable) event.preventDefault();
    historyInnerOwnedWheelEvents.add(event);
    event.stopPropagation();
    innerScroller.scrollTop += delta;
  }, []);

  // ========== SEARCH ==========
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [historySeekPresentationEpoch, setHistorySeekPresentationEpoch] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Build flat list of match positions: { entryIdx, entryUuid, offset }
  // Matches found by main over the FULL projection (codex row-window path).
  // Kept keyed by query so a stale response cannot answer a newer query.
  const [serverMatches, setServerMatches] = useState<{
    query: string;
    positions: Array<{ entryUuid: string; offset: number }>;
  } | null>(null);
  const matchPositions = useMemo(() => {
    if (!searchQuery || searchQuery.length < 2) return [];
    const positions: Array<{ entryIdx: number; entryUuid: string; offset: number }> = [];
    // Row-window sessions: a far-away row is a stub with no content locally,
    // so scanning what the renderer holds would silently miss matches. Main
    // scanned the whole projection; map its row identities to current
    // indices (identity is stable, index is what Virtuoso needs).
    if (serverMatches && serverMatches.query === searchQuery) {
      for (const match of serverMatches.positions) {
        const entryIdx = displayEntryIndexByUuid.get(match.entryUuid);
        if (entryIdx === undefined) continue;
        positions.push({ entryIdx, entryUuid: match.entryUuid, offset: match.offset });
      }
      return positions;
    }
    const q = searchQuery.toLowerCase();
    for (let i = 0; i < displayEntries.length; i++) {
      const text = (displayEntries[i].content || '').toLowerCase();
      let idx = text.indexOf(q);
      while (idx !== -1) {
        // entryIdx must address the display-UNIT list (what Virtuoso renders),
        // not the raw entry array — a match inside a collapsed group resolves
        // to the group's own row.
        const unitIdx = displayEntryIndexByUuid.get(displayEntries[i].uuid);
        if (unitIdx !== undefined) {
          positions.push({ entryIdx: unitIdx, entryUuid: displayEntries[i].uuid, offset: idx });
        }
        idx = text.indexOf(q, idx + 1);
      }
    }
    return positions;
  }, [displayEntries, displayEntryIndexByUuid, searchQuery, serverMatches]);

  // Ask main to search whenever the query changes on a row-windowed session.
  // Local scanning still runs meanwhile (hydrated rows answer instantly), and
  // the server answer replaces it when it lands.
  useEffect(() => {
    if (toolType !== 'codex' || !sessionId) return;
    if (!searchOpen || searchQuery.length < 2) {
      setServerMatches(null);
      return;
    }
    let disposed = false;
    const queryAtStart = searchQuery;
    void ipcRenderer.invoke('agent-transcript:search-history', {
      toolType, sessionId, cwd, query: queryAtStart,
    }).then((result: any) => {
      if (disposed || !result?.success) return;
      setServerMatches({
        query: queryAtStart,
        positions: (result.matches || []).map((match: any) => ({
          entryUuid: match.entryUuid,
          offset: match.offset,
        })),
      });
      historyDiag('SEARCH_SERVER tab=' + tabId.slice(-12) +
        ' matches=' + (result.total ?? -1) +
        ' returned=' + (result.matches?.length ?? 0) +
        ' truncated=' + (result.truncated ? '1' : '0'));
    }).catch(() => {});
    return () => { disposed = true; };
  }, [cwd, searchOpen, searchQuery, sessionId, tabId, toolType]);

  // Reset current match when query changes and scroll to first match
  useEffect(() => {
    if (matchPositions.length > 0) {
      setCurrentMatchIdx(0);
      const match = matchPositions[0];
      setHistoryTailFollowIntent(false);
      historyTailPinScheduler.cancel();
      virtuosoRef.current?.scrollToIndex({ index: match.entryIdx, align: 'center', behavior: 'smooth' });
    }
  }, [historyTailPinScheduler, searchQuery, setHistoryTailFollowIntent]);

  // Navigate to current match entry. A match found by main can live outside
  // the hydrated span (that is the whole reason the search moved to main), so
  // re-centre hydration on it — the row is a placeholder until its content
  // arrives, and the highlight pass runs again when it does.
  const scrollToMatch = useCallback((idx: number) => {
    if (idx < 0 || idx >= matchPositions.length) return;
    const match = matchPositions[idx];
    setHistoryTailFollowIntent(false);
    historyTailPinScheduler.cancel();
    // A match inside a collapsed series: expand its group first so the
    // highlight pass has real text to walk. The unit index shifts after the
    // expansion commit — jump on the next frame via the uuid map.
    if (expandGroupForUuid(match.entryUuid, 'search-match')) {
      requestAnimationFrame(() => {
        const liveIdx = unitIndexByUuidRef.current.get(match.entryUuid);
        if (liveIdx !== undefined) {
          virtuosoRef.current?.scrollToIndex({ index: liveIdx, align: 'center', behavior: 'smooth' });
        }
      });
      return;
    }
    virtuosoRef.current?.scrollToIndex({ index: match.entryIdx, align: 'center', behavior: 'smooth' });
    // rowStub check runs by uuid over the ENTRY array (match.entryIdx is a
    // display-unit index and must not address the server-entry array).
    if (toolType === 'codex') {
      if (isHistoryHydrationTargetStub(
        presentationEntriesRef.current,
        match.entryUuid,
      )) {
        requestHistoryHydrationAt(match.entryUuid, 'search-match', ' idx=' + match.entryIdx);
      }
    }
  }, [expandGroupForUuid, historyTailPinScheduler, matchPositions, requestHistoryHydrationAt, setHistoryTailFollowIntent, toolType]);

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
    // mountWaveRenderState: highlights walk DOM text nodes, and a mount-wave
    // shell has none — each upgrade step must re-walk so matches inside
    // freshly hydrated rows get painted (the match COUNTER is data-driven and
    // was always right; only the paint needs the re-run).
  }, [
    searchQuery,
    matchPositions,
    currentMatchIdx,
    displayEntries,
    mountWaveRenderState,
    historySeekPresentationEpoch,
  ]);

  // Ctrl+F handler — scoped to history panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Non-focused split pane: window-level Cmd+F belongs to the focused pane.
      // Read the external focus lease at event time so workflow presentation
      // does not need to re-render the transcript just to flip this boolean.
      if (globalHotkeysSuppressedRef.current) return;
      if (!isOpen) return;
      if (shouldOpenHistorySearchFromKeydown(e, {
        isOpen,
        mainSurface,
        terminalOpen,
        terminalIsPrimary,
      })) {
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
        // A local composer search owns Escape as well. Run after is rendered
        // through a portal, so React ancestry cannot establish ownership.
        if (isComposerKeyboardTarget(e.target)) return;
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
    // Explicit command is itself the intent proof; the resulting scroll event
    // must not depend on a preceding wheel/keyboard gesture.
    setHistoryTailFollowIntent(true);
    const presentation = historyPresentationProofRef.current;
    historyDiag('SCROLL_BOTTOM_COMMAND tab=' + tabId.slice(-12)
      + ' presented=' + (presentation.presented ? '1' : '0')
      + ' visit=' + presentation.visit
      + ' smooth=' + (smooth ? '1' : '0'));
    scheduleHistoryBottomScroll({
      virtuoso: virtuosoRef.current,
      itemCount: lengthRef.current,
      getScroller: () => virtuosoScrollerRef.current,
      getOwnerToken: () => {
        const proof = historyPresentationProofRef.current;
        return historyOwnerKeyRef.current + ':' + historyOwnerGenerationRef.current
          + ':p' + (proof.presented ? '1' : '0') + ':v' + proof.visit;
      },
      smooth,
    });
  }, [setHistoryTailFollowIntent, tabId]);

  const handleControlsHeightChange = useCallback((height: number) => {
    // During the deferred owner beat this measurement belongs to the OLD tab;
    // applying it to the new workspace would mix owners even though the rows
    // are hidden behind the curtain.
    if (staleOwnerCurtain) return;
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
    //
    // The measurement is taken AFTER the resize already shortened the
    // viewport, so a reader parked at the tail is now exactly `grew` pixels
    // away from it — against a 4px threshold that reads as "left the bottom"
    // and the re-pin is skipped. The growth is handed in as slack so the
    // question stays «was the user at the bottom before this resize?».
    const scroller = virtuosoScrollerRef.current;
    const grew = Math.max(0, nextHeight - previousHeight);
    const liveAtBottom = scroller
      ? isHistoryAtContentBottom(scroller, {
        slackPx: grew,
      })
      : null;
    const shouldKeepTailVisible = isAtBottomRef.current
      && (liveAtBottom === null || liveAtBottom);
    const presentation = historyPresentationProofRef.current;
    controlsHeightRef.current = nextHeight;
    onControlsHeightChange?.(nextHeight);
    historyDiag('COMPOSER_HEIGHT tab=' + tabId.slice(-12) +
      ' from=' + previousHeight +
      ' to=' + nextHeight +
      ' main=' + (mainSurface ? '1' : '0') +
      ' atBottom=' + (shouldKeepTailVisible ? '1' : '0') +
      ' cachedAtBottom=' + (isAtBottomRef.current ? '1' : '0') +
      ' liveAtBottom=' + (liveAtBottom === null ? 'na' : liveAtBottom ? '1' : '0') +
      ' presented=' + (presentation.presented ? '1' : '0') +
      ' visit=' + presentation.visit);
    if (mainSurface && presentation.presented) {
      historyTailPinScheduler.schedule({ shouldPin: shouldKeepTailVisible });
    }
  }, [historyTailPinScheduler, mainSurface, onControlsHeightChange, staleOwnerCurtain, tabId]);

  const appendLocalPromptEntry = useCallback((
    text: string,
    queueStatus: Extract<HistoryPromptHandoffStatus,
      'preparing' | 'sending' | 'queued' | 'audit-pending' | 'delivery-unknown' | 'sent'>,
    meta: {
      handoffId: string;
      statusAtSend: AgentPtyStatus;
      submittedAt: number;
      promptChips?: HistoryPromptDraftChip[];
      imagePaths?: HistoryPromptDraftImageRef[];
      requiresAuditIdentity?: boolean;
      auditTimestamp?: string;
      auditHash?: string;
      auditSessionId?: string;
      auditEntryUuid?: string;
      sourceIdentity?: string;
      recordByteOffset?: number;
      sessionId?: string;
      statusChangedAt?: number;
    }
  ) => {
    const cleanContent = normalizeHistoryPromptText(text);
    if (!cleanContent) return;
    const now = Date.now();
    const submittedAt = Number.isFinite(meta.submittedAt)
      ? Number(meta.submittedAt)
      : now;
    const statusChangedAt = Number.isFinite(meta.statusChangedAt)
      ? Number(meta.statusChangedAt)
      : now;
    const handoffId = meta.handoffId || createPromptHandoffId();
    const resolvedSessionId = meta.auditSessionId || meta.sessionId || sessionId;
    const isNewPromptPresentation = !presentationEntriesRef.current.some((candidate) =>
      isLocalPromptEntry(candidate) && candidate.handoffId === handoffId
    );
    // Submitting from the physical bottom is explicit intent to keep following
    // the new turn. This repairs a stale false intent left by a previous
    // reveal/collapse without pulling a reader who is genuinely above the
    // tail. The two-frame pin lands after the optimistic row commits.
    if (isNewPromptPresentation) {
      keepHistoryTailPinnedAfterMutation('prompt-submitted', true);
    }
    const entry: FullHistoryEntry = {
      uuid: LOCAL_PROMPT_PREFIX + tabId + '-' + handoffId,
      role: 'queued',
      queueStatus,
      statusAtSend: meta.statusAtSend,
      handoffId,
      statusReason: queueStatus === 'preparing'
        ? 'send-preparing'
        : queueStatus === 'sending'
          ? 'send-start'
          : 'send-result',
      timestamp: new Date(submittedAt).toISOString(),
      content: cleanContent,
      sessionId: resolvedSessionId,
      optimisticAt: submittedAt,
      statusChangedAt,
      promptChips: normalizeComposerChips(meta.promptChips || [])
        .filter((chip) => chip.kind === 'prompt') as HistoryPromptDraftChip[],
      imagePaths: retainHistoryDraftImages(cleanContent, meta.imagePaths || []),
      requiresAuditIdentity: meta.requiresAuditIdentity === true,
      auditTimestamp: meta.auditTimestamp,
      auditHash: meta.auditHash,
      auditSessionId: meta.auditSessionId,
      auditEntryUuid: meta.auditEntryUuid,
      sourceIdentity: meta.sourceIdentity,
      recordByteOffset: meta.recordByteOffset,
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
      recordByteOffset: meta.recordByteOffset,
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
              statusChangedAt,
              promptChips: entry.promptChips,
              imagePaths: entry.imagePaths,
              requiresAuditIdentity: entry.requiresAuditIdentity,
              auditTimestamp: entry.auditTimestamp,
              auditHash: entry.auditHash,
              auditSessionId: entry.auditSessionId,
              auditEntryUuid: entry.auditEntryUuid,
              sourceIdentity: entry.sourceIdentity,
              recordByteOffset: entry.recordByteOffset,
              sessionId: entry.sessionId,
            }
          : candidate);
      presentationEntriesRef.current = nextEntries;
      persistVolatileOverlay(historySnapshotOwner, nextEntries);
      return nextEntries;
    });
  }, [historySnapshotOwner, keepHistoryTailPinnedAfterMutation, persistVolatileOverlay, sessionId, tabId]);

  const updateLocalPromptEntry = useCallback((
    handoffId: string,
    queueStatus: Exclude<HistoryPromptHandoffStatus, 'preparing' | 'sending'>,
    reason: string,
    identity?: {
      requiresAuditIdentity?: boolean;
      auditTimestamp?: string;
      auditHash?: string;
      auditSessionId?: string;
      auditEntryUuid?: string;
      sourceIdentity?: string;
      recordByteOffset?: number;
    },
    changedAtOverride?: number,
  ) => {
    if (!handoffId) return;
    const changedAt = Number.isFinite(changedAtOverride)
      ? Number(changedAtOverride)
      : Date.now();
    const handoffMeta = promptHandoffMetaRef.current.get(handoffId) || null;
    const currentHandoff = getHistoryPromptHandoffsSnapshot(tabId)
      .find((record) => record.handoffId === handoffId) || null;
    if (
      currentHandoff
      && (currentHandoff.queueStatus === 'cancelled' || currentHandoff.queueStatus === 'failed')
      && queueStatus !== currentHandoff.queueStatus
    ) {
      historyDiag('LOCAL_STATUS_IGNORED tab=' + tabId.slice(-12)
        + ' handoff=' + handoffId
        + ' queueStatus=' + queueStatus
        + ' reason=' + reason
        + ' terminal=' + currentHandoff.queueStatus);
      return;
    }
    if (handoffMeta && identity) {
      promptHandoffMetaRef.current.set(handoffId, {
        ...handoffMeta,
        requiresAuditIdentity: identity.requiresAuditIdentity,
        auditTimestamp: identity.auditTimestamp,
        auditHash: identity.auditHash,
        auditEntryUuid: identity.auditEntryUuid,
        sourceIdentity: identity.sourceIdentity,
        recordByteOffset: identity.recordByteOffset,
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
        recordByteOffset: identity?.recordByteOffset ?? handoffMeta.recordByteOffset,
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
                recordByteOffset: identity.recordByteOffset,
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

  const dismissPromptPresentation = useCallback(async (entry: FullHistoryEntry) => {
    const handoffId = typeof entry.handoffId === 'string' ? entry.handoffId.trim() : '';
    if (!handoffId || !isLocalPromptEntry(entry)) return;
    try {
      const currentHandoff = getHistoryPromptHandoffsSnapshot(tabId)
        .find((handoff) => handoff.handoffId === handoffId);
      const dismissalPlan = planHistoryPromptPresentationDismissal({
        isLocalPrompt: true,
        handoffId,
        requiresAuditIdentity: entry.requiresAuditIdentity
          ?? currentHandoff?.requiresAuditIdentity,
        sendOperationKey: currentHandoff?.sendOperationKey,
        sendAttemptId: currentHandoff?.sendAttemptId,
      });
      if (dismissalPlan.mode === 'local-only') {
        historyDiag('LOCAL_PRESENTATION_DISMISS tab=' + tabId.slice(-12)
          + ' handoff=' + handoffId
          + ' reason=' + dismissalPlan.reason);
        consumeHistoryPromptHandoff(tabId, handoffId);
        removeLocalPromptEntry(handoffId, 'user-dismissed-receiptless-local-command');
        return;
      }
      if (currentHandoff && (!currentHandoff.sendOperationKey || !currentHandoff.sendAttemptId)) {
        await waitForHistoryPromptHandoffSendIdentity(tabId, handoffId);
      }
      const result = await ipcRenderer.invoke('agent:dismiss-send-receipt-presentation', {
        tabId,
        handoffId,
      });
      historyDiag('DURABLE_PRESENTATION_DISMISS tab=' + tabId.slice(-12)
        + ' handoff=' + handoffId
        + ' success=' + (result?.success === true ? '1' : '0')
        + ' dismissed=' + (result?.dismissed === true ? '1' : '0')
        + ' reason=' + (result?.reason || '-'));
      if (result?.success !== true || result?.dismissed !== true) {
        const reason = String(result?.reason || 'presentation-dismiss-failed');
        showHistoryIncidentToast(tabId, 'Не удалось скрыть карточку сообщения: ' + reason, {
          headline: 'Не удалось скрыть карточку сообщения',
          toolType,
          action: 'dismiss-prompt-presentation',
          handoffId,
          sendAttemptId: currentHandoff?.sendAttemptId || null,
          sendOperationKey: currentHandoff?.sendOperationKey || null,
          statusAtSend: entry.queueStatus || null,
          code: reason,
        });
        return;
      }
      consumeHistoryPromptHandoff(tabId, handoffId);
      removeLocalPromptEntry(handoffId, 'user-dismissed-prompt-presentation');
    } catch (error: any) {
      console.warn('[HistoryPanel] durable presentation dismiss failed tab=' + tabId.slice(-12)
        + ' handoff=' + handoffId
        + ': ' + String(error?.message || error));
      const failureHandoff = getHistoryPromptHandoffsSnapshot(tabId)
        .find((handoff) => handoff.handoffId === handoffId);
      showHistoryIncidentToast(tabId, error, {
        headline: 'Не удалось скрыть карточку сообщения',
        toolType,
        action: 'dismiss-prompt-presentation',
        handoffId,
        sendAttemptId: failureHandoff?.sendAttemptId || null,
        sendOperationKey: failureHandoff?.sendOperationKey || null,
        statusAtSend: entry.queueStatus || null,
        code: 'presentation-dismiss-exception',
      });
    }
  }, [removeLocalPromptEntry, tabId, toolType]);

  const acknowledgeMaterializedHistoryReceipt = useCallback(async (input: {
    operationKey?: string | null;
    attemptId?: string | null;
    handoffId?: string | null;
    provider?: string | null;
    sessionId?: string | null;
    auditEntryUuid?: string | null;
    auditSourceIdentity?: string | null;
  }, matched: FullHistoryEntry) => {
    const operationKey = typeof input.operationKey === 'string' ? input.operationKey.trim() : '';
    const attemptId = typeof input.attemptId === 'string' ? input.attemptId.trim() : '';
    const handoffId = typeof input.handoffId === 'string' ? input.handoffId.trim() : '';
    const provider = input.provider === 'claude' || input.provider === 'codex'
      ? input.provider
      : null;
    const exactSessionId = typeof input.sessionId === 'string' && input.sessionId
      ? input.sessionId
      : matched.sessionId;
    const auditEntryUuid = typeof input.auditEntryUuid === 'string'
      ? input.auditEntryUuid
      : '';
    const auditSourceIdentity = typeof input.auditSourceIdentity === 'string'
      ? input.auditSourceIdentity
      : '';
    const exactEntryMatched = !!auditEntryUuid
      && historyEntryHasExactIdentity(matched, auditEntryUuid);
    const exactSourceMatched = !auditEntryUuid && !!auditSourceIdentity
      && historyEntryHasExactIdentity(matched, auditSourceIdentity);
    if (!operationKey
      || !attemptId
      || !handoffId
      || !provider
      || !exactSessionId
      || (!exactEntryMatched && !exactSourceMatched)) {
      return false;
    }
    try {
      const result = await ipcRenderer.invoke('agent:acknowledge-send-receipt-presentation', {
        operationKey,
        attemptId,
        tabId,
        handoffId,
        provider,
        sessionId: exactSessionId,
        entryUuid: exactEntryMatched ? auditEntryUuid : matched.uuid,
        sourceIdentity: exactSourceMatched
          ? auditSourceIdentity
          : (matched.sourceIdentity || null),
      });
      historyDiag('DURABLE_PRESENTATION_ACK tab=' + tabId.slice(-12)
        + ' handoff=' + handoffId
        + ' success=' + (result?.success === true ? '1' : '0')
        + ' applied=' + (result?.applied === true ? '1' : '0')
        + ' reason=' + (result?.reason || '-'));
      return result?.success === true;
    } catch (error: any) {
      console.warn('[HistoryPanel] durable presentation ACK failed tab=' + tabId.slice(-12)
        + ' handoff=' + handoffId
        + ': ' + String(error?.message || error));
      return false;
    }
  }, [tabId]);

  useEffect(() => {
    let disposed = false;
    void ipcRenderer.invoke('agent:list-send-receipts', {
      tabId,
    }).then(async (result: any) => {
      if (disposed || result?.success !== true || !Array.isArray(result.records)) return;
      let restorableDraft: string | null = null;
      let restorableAt = -1;
      let hydrated = 0;
      for (const record of result.records) {
        if (record?.provider !== toolType) continue;
        const canonicalProjectionReady = presentedOwnerKey === historyOwnerKey
          && (rawServerEntriesRef.current.length > 0
            || chipsFreshOwnerKey === historyOwnerKey);
        // On a cold owner, the durable transcript has not been read yet. A
        // confirmed receipt means its canonical row exists, so wait for that
        // first read instead of briefly appending a duplicate SENT at the end.
        if (record?.state === 'confirmed'
          && !record?.presentation
          && !canonicalProjectionReady) {
          continue;
        }
        const materialized = record?.state === 'confirmed'
          ? rawServerEntriesRef.current.find((entry) =>
              durableHistorySendReceiptMatchesCanonicalEntry(record, entry)
            )
          : null;
        if (materialized) {
          const acknowledged = await acknowledgeMaterializedHistoryReceipt({
            operationKey: record.operationKey,
            attemptId: record.attemptId,
            handoffId: record.handoffId,
            provider: record.provider,
            sessionId: record.receipt?.sessionId || record.sessionId,
            auditEntryUuid: record.receipt?.entryUuid || record.auditIdentity?.entryUuid,
            auditSourceIdentity: record.receipt?.sourceIdentity
              || record.auditIdentity?.sourceIdentity,
          }, materialized);
          if (!acknowledged || disposed) continue;
          consumeHistoryPromptHandoff(tabId, record.handoffId);
          removeLocalPromptEntry(record.handoffId, 'durable-presentation-already-materialized');
          continue;
        }
        // Project API/iOS/Terminal MCP own their external composer and retry
        // projection, so History must not recreate their optimistic cards
        // after restart. It still lists their confirmed receipts above so an
        // exact canonical transcript row can retire a local card that was
        // already projected while the renderer was alive.
        if (record?.surface !== 'desktop-history') continue;
        const outcome = hydrateHistoryPromptHandoffFromDurableReceipt(record);
        if (outcome.hydrated) hydrated += 1;
        if (!outcome.hydrated && (
          outcome.reason === 'durable-history-presentation-already-materialized'
          || outcome.reason === 'durable-history-presentation-dismissed'
          || outcome.reason === 'durable-history-confirmed-identity-missing'
          || outcome.reason === 'durable-history-confirmed-proof-incomplete'
        )) {
          consumeHistoryPromptHandoff(tabId, record.handoffId);
          removeLocalPromptEntry(record.handoffId, outcome.reason);
        }
        if (outcome.restorableDraft && Number(record?.updatedAt || 0) >= restorableAt) {
          restorableDraft = outcome.restorableDraft;
          restorableAt = Number(record?.updatedAt || 0);
        }
      }
      if (restorableDraft) {
        const currentDraft = useUIStore.getState().historyPromptDrafts[tabId] || '';
        if (!currentDraft) {
          setHistoryPromptDraft(tabId, restorableDraft);
          historyDiag('DURABLE_DRAFT_RESTORED tab=' + tabId.slice(-12)
            + ' chars=' + restorableDraft.length);
        }
      }
      if (hydrated > 0) {
        historyDiag('DURABLE_HANDOFFS_HYDRATED tab=' + tabId.slice(-12)
          + ' count=' + hydrated);
      }
    }).catch((error: any) => {
      console.warn('[HistoryPanel] durable receipt hydration failed tab=' + tabId.slice(-12)
        + ': ' + String(error?.message || error));
    });
    return () => { disposed = true; };
  }, [
    acknowledgeMaterializedHistoryReceipt,
    chipsFreshOwnerKey,
    historyOwnerKey,
    presentedOwnerKey,
    removeLocalPromptEntry,
    setHistoryPromptDraft,
    tabId,
    toolType,
  ]);

  useEffect(() => subscribeHistoryPromptHandoffs(tabId, (snapshot, change) => {
    if (change.type === 'consume' || change.type === 'retract') {
      removeLocalPromptEntry(change.handoffId, 'handoff-' + change.type);
      return;
    }
    const records = change.type === 'replay'
      ? snapshot
      : snapshot.filter((record) => record.handoffId === change.handoffId);
    for (const record of records) {
      if (record.toolType !== toolType) continue;
      const carrierProof = record.auditProof || record.providerQueueProof;
      const sessionRoute = resolveHistoryPromptHandoffPresentationSession({
        auditSessionId: carrierProof?.sessionId,
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
        inheritanceDepth: chip.inheritanceDepth,
        inheritanceParentLabel: chip.inheritanceParentLabel,
      }));
      const imagePaths = record.imagePaths.map((ref) => ({ ...ref })) as HistoryPromptDraftImageRef[];
      const identity = {
        requiresAuditIdentity: record.requiresAuditIdentity,
        auditTimestamp: record.auditProof?.auditTimestamp,
        auditHash: record.auditProof?.actualHash,
        auditSessionId,
        auditEntryUuid: record.auditProof?.entryUuid,
        sourceIdentity: carrierProof?.sourceIdentity,
        recordByteOffset: carrierProof?.recordByteOffset,
      };
      if (identity.sourceIdentity && liveProjectionRef.current.ownerKey === historyOwnerKey) {
        const currentLive = liveProjectionRef.current.entries;
        const retainedLive = retireHistoryLivePromptByExactProof(currentLive, {
          sourceIdentity: identity.sourceIdentity,
          entryUuid: identity.auditEntryUuid,
        }) as FullHistoryEntry[];
        if (retainedLive !== currentLive) {
          liveProjectionRef.current = { ownerKey: historyOwnerKey, entries: retainedLive };
          setLiveEntries(retainedLive);
          historyDiag('LIVE_PROMPT_RETIRED tab=' + tabId.slice(-12)
            + ' handoff=' + record.handoffId
            + ' proof=exact-source-identity');
        }
      }
      if (
        record.queueStatus === 'preparing'
        || record.queueStatus === 'sending'
        || record.queueStatus === 'queued'
        || record.queueStatus === 'audit-pending'
        || record.queueStatus === 'delivery-unknown'
        || record.queueStatus === 'sent'
      ) {
        appendLocalPromptEntry(record.text, record.queueStatus, {
          handoffId: record.handoffId,
          statusAtSend: record.statusAtSend,
          submittedAt: record.submittedAt,
          statusChangedAt: record.statusChangedAt,
          promptChips,
          imagePaths,
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
          statusChangedAt: record.statusChangedAt,
          promptChips,
          imagePaths,
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
    historyOwnerKey,
    removeLocalPromptEntry,
    sessionId,
    tabId,
    toolType,
    updateLocalPromptEntry,
  ]);

  const appendCompactErrorEntry = useCallback((operation: CompactOperationalPhase) => {
    if (operation.outcome !== 'failed') return;
    const message = String(operation.message || '').trim();
    if (!message) return;
    const operationId = String(operation.operationId || '').trim();
    if (!operationId) return;
    const endedAt = Number.isFinite(operation.endedAt)
      ? Number(operation.endedAt)
      : Date.now();
    const uuid = LOCAL_COMPACT_ERROR_PREFIX + operationId;
    const entry: FullHistoryEntry = {
      uuid,
      role: 'compact-error',
      serviceCarrier: 'compact-error',
      timestamp: new Date(endedAt).toISOString(),
      content: message,
      sessionId: operation.sessionId || sessionId || '',
      optimisticAt: endedAt,
      statusReason: operation.reason || 'compact-failed',
      sourceIdentity: 'compact-error:' + operationId,
      recordByteOffset: Number.isFinite(operation.sourceByteOffset)
        ? Number(operation.sourceByteOffset)
        : undefined,
    };
    const alreadyVisible = presentationEntriesRef.current.some((candidate) => candidate.uuid === uuid);
    if (!alreadyVisible) keepHistoryTailPinnedAfterMutation('compact-error', true);
    setEntries((previous) => {
      const withoutDuplicate = previous.filter((candidate) => candidate.uuid !== uuid);
      const nextEntries = mergeServerAndLocalEntries(withoutDuplicate, [entry]);
      presentationEntriesRef.current = nextEntries;
      persistVolatileOverlay(historySnapshotOwner, nextEntries);
      return nextEntries;
    });
  }, [
    historySnapshotOwner,
    keepHistoryTailPinnedAfterMutation,
    persistVolatileOverlay,
    sessionId,
  ]);

  useEffect(() => {
    let disposed = false;
    let eventRevision = 0;
    const settleOperationHandoff = (operation: CompactOperationalPhase) => {
      appendCompactErrorEntry(operation);
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
  }, [appendCompactErrorEntry, removeLocalPromptEntry, tabId, toolType]);

  const hasDurablePrompt = useCallback((
    text: string,
    submittedAt: number,
    identity: DurablePromptIdentity = {},
  ) => (
    serverHasPromptEntry(
      rawServerEntriesRef.current,
      {
        uuid: LOCAL_PROMPT_PREFIX + 'durable-check',
        role: 'queued',
        content: text,
        timestamp: new Date(submittedAt).toISOString(),
        optimisticAt: submittedAt,
        requiresAuditIdentity: true,
        auditTimestamp: identity.auditTimestamp,
        auditHash: identity.auditHash,
        auditSessionId: identity.auditSessionId || identity.sessionId,
        auditEntryUuid: identity.auditEntryUuid,
        sourceIdentity: identity.sourceIdentity,
        recordByteOffset: identity.recordByteOffset,
        sessionId: identity.auditSessionId || identity.sessionId,
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

  const dismissLocalRewindPresentation = useCallback((entry: FullHistoryEntry) => {
    if (entry.role !== 'rewind' || !entry.uuid.startsWith(LOCAL_REWIND_PREFIX)) return;
    setEntries((previous) => {
      const next = previous.filter((candidate) => candidate.uuid !== entry.uuid);
      if (next.length === previous.length) return previous;
      presentationEntriesRef.current = next;
      persistVolatileOverlay(historySnapshotOwner, next);
      return next;
    });
  }, [historySnapshotOwner, persistVolatileOverlay]);

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
      const carrierProof = handoff.auditProof || handoff.providerQueueProof;
      const localIdentity: FullHistoryEntry = {
        uuid: LOCAL_PROMPT_PREFIX + tabId + '-' + handoff.handoffId,
        role: 'queued',
        timestamp: new Date(handoff.submittedAt).toISOString(),
        content: normalizeHistoryPromptText(handoff.text),
        sessionId: carrierProof?.sessionId || handoff.sessionIdHint || sessionId,
        optimisticAt: handoff.submittedAt,
        queueStatus: handoff.queueStatus,
        statusReason: handoff.statusReason,
        requiresAuditIdentity: handoff.requiresAuditIdentity,
        auditTimestamp: handoff.auditProof?.auditTimestamp,
        auditHash: handoff.auditProof?.actualHash,
        auditSessionId: handoff.auditProof?.sessionId || undefined,
        auditEntryUuid: handoff.auditProof?.entryUuid,
        sourceIdentity: carrierProof?.sourceIdentity,
        recordByteOffset: carrierProof?.recordByteOffset,
      };
      const legacyOrchestrationMatch = serverEntries.find((entry) => (
        !consumedServerUuids.has(entry.uuid)
        && legacyOrchestrationCompletionMatchesCanonicalEntry(handoff, entry)
      ));
      const matched = legacyOrchestrationMatch || findServerPromptEntry(
        serverEntries,
        localIdentity,
        consumedServerUuids,
      );
      if (!matched) continue;
      consumedServerUuids.add(matched.uuid);
      if (legacyOrchestrationMatch) {
        consumeHistoryPromptHandoff(tabId, handoff.handoffId);
        removeLocalPromptEntry(handoff.handoffId, 'legacy-orchestration-materialized');
        historyDiag('HANDOFF_CONSUMED tab=' + tabId.slice(-12) +
          ' handoff=' + handoff.handoffId +
          ' proof=orchestration-run-tag');
        continue;
      }
      adoptHistoryPromptHandoffCanonicalEntry(tabId, handoff.handoffId, {
        entryUuid: matched.uuid,
        sessionId: matched.sessionId,
        sourceIdentity: matched.sourceIdentity,
        sourceIdentityAliases: matched.sourceIdentityAliases,
      });
      void acknowledgeMaterializedHistoryReceipt({
        operationKey: handoff.sendOperationKey,
        attemptId: handoff.sendAttemptId,
        handoffId: handoff.handoffId,
        provider: handoff.toolType,
        sessionId: carrierProof?.sessionId || handoff.sessionIdHint,
        auditEntryUuid: handoff.auditProof?.entryUuid,
        auditSourceIdentity: carrierProof?.sourceIdentity,
      }, matched).then((acknowledged) => {
        if (!acknowledged) return;
        consumeHistoryPromptHandoff(tabId, handoff.handoffId);
        historyDiag('HANDOFF_CONSUMED tab=' + tabId.slice(-12) +
          ' handoff=' + handoff.handoffId +
          ' proof=' + (handoff.auditProof
            ? 'audit'
            : handoff.providerQueueProof
              ? 'provider-queue'
              : 'fallback'));
      });
    }
  }, [acknowledgeMaterializedHistoryReceipt, removeLocalPromptEntry, sessionId, tabId, toolType]);

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
    const waitForHistoryApplySlot = async (phase: string) => {
      const presentedNow = historyPresentationProofRef.current.presented;
      // Initial foreground paint is the only apply that may stay on the
      // current lane. Every refresh and every hidden cold load first enters a
      // browser background task; queued wheel input therefore gets to mark
      // the global hold before React reconciliation is even scheduled.
      if (phase === 'cold' && presentedNow && !historyForegroundPriority.active()) return;
      const outcome = await historyForegroundPriority.waitForBackgroundSlot({
        shouldBypass: () => !isCurrentOwner(),
      });
      historyDiag('LOAD_APPLY_PRIORITY tab=' + tabId.slice(-12)
        + ' seq=' + loadSequence
        + ' phase=' + phase
        + ' outcome=' + outcome.reason
        + ' waitedMs=' + Math.round(outcome.waitedMs)
        + ' presented=' + (historyPresentationProofRef.current.presented ? '1' : '0'));
    };
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
    // Names any main-thread freeze overlapping this load (see
    // markRendererActivity): the platform reports attribution=unknown for our
    // own work, so the trail is the only way a 4s history read gets blamed.
    const endLoadMark = markRendererActivity(
      'history-load:' + tabId.slice(-8) + ':' + (isRefresh ? 'refresh' : 'cold')
    );
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
      const requestPayload = {
        toolType,
        sessionId,
        cwd,
        tabId,
        ifRevision: revisionForRequest,
        // Desktop History rehydrates payloads on card expand; heavy tool
        // outputs/thinking arrive as previews + refs instead of megabytes.
        dehydrate: true,
        // This panel holds the full previous projection, so a live refresh
        // may answer with only the changed rows (result.delta) instead of
        // re-cloning the whole session over IPC. Codex-only: the Claude
        // pipeline has its own probe/unchanged economy.
        deltaOk: toolType === 'codex',
        // Row-level hydration window: the full row LIST always arrives (every
        // positional mechanism here is indexed against it), but rows far from
        // what the user is reading arrive as identity stubs and render as
        // exact-height placeholders. The renderer names the row it wants the
        // span centred on; main keeps the tail and live-work rows hydrated
        // regardless. Codex-only for now — Claude sessions are orders of
        // magnitude smaller and their projection path is separate.
        hydrate: toolType === 'codex'
          ? {
              centerUuid: hydrationCenterUuidRef.current,
              radius: HISTORY_HYDRATION_RADIUS_ROWS,
              alwaysHydrateTail: HISTORY_HYDRATION_TAIL_ROWS,
            }
          : null,
      };
      let result = await ipcRenderer.invoke(ipcChannel, requestPayload);
      if (result?.success && result.delta === true && isCurrentOwner()) {
        // Reassembly needs the exact baseline the digest described. The raw
        // ref is owner-scoped and set together with the revision ref, so a
        // moved revision or an empty baseline means the digest talks about
        // rows this panel never applied — fall back to one full load.
        const baseline = rawServerEntriesRef.current;
        const baselineValid = historyRevisionRef.current === revisionForRequest && baseline.length > 0;
        const reassembled = baselineValid
          ? reassembleHistoryDeltaEntries(
              baseline,
              Array.isArray(result.order) ? result.order : [],
              Array.isArray(result.changedEntries) ? result.changedEntries : [],
            )
          : null;
        if (reassembled) {
          historyDiag('LOAD_DELTA tab=' + tabId.slice(-12) +
            ' session=' + sessionId.slice(0, 8) +
            ' seq=' + loadSequence +
            ' changed=' + (result.changedEntries?.length || 0) +
            ' total=' + reassembled.length +
            ' elapsedMs=' + (Date.now() - loadStartedAt));
          result = { ...result, entries: reassembled };
        } else {
          historyDiag('LOAD_DELTA_MISMATCH tab=' + tabId.slice(-12) +
            ' session=' + sessionId.slice(0, 8) +
            ' seq=' + loadSequence +
            ' reason=' + (!baselineValid
              ? (baseline.length === 0 ? 'no-baseline' : 'revision-moved')
              : 'missing-row'));
          result = await ipcRenderer.invoke(ipcChannel, { ...requestPayload, ifRevision: null });
        }
      }
      if (!isCurrentOwner()) {
        // The read itself is NOT stale — it answers exactly the owner it was
        // started for. Discarding it made the A→B→A dance quadratic: the
        // boot-time cold read of a 59MB session (2.2s of main-process work)
        // was thrown away because the user left before it landed, so the
        // return to that tab was cold AGAIN (measured 04.08 20:14: repeat
        // 525ms cold mount + right-click queued 382ms behind it). Bank the
        // rows under the owner they belong to; only presentation is skipped.
        if (Array.isArray(result?.entries) && result.entries.length > 0 && result.unchanged !== true) {
          const staleCacheResult = historySnapshotCache.set(historySnapshotOwner, {
            entries: result.entries,
            claudeMemoryBoundaryUuid: result.claudeMemoryBoundaryUuid || null,
            revision: result.revision || null,
            entriesApproxBytesHint: estimateHistoryEntriesBytesFast(result.entries),
          });
          historyDiag('LOAD_STALE_BANKED tab=' + tabId.slice(-12) +
            ' session=' + sessionId.slice(0, 8) +
            ' seq=' + loadSequence +
            ' entries=' + result.entries.length +
            ' stored=' + (staleCacheResult.stored ? '1' : '0'));
        }
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
        // Presentation already shows EXACTLY this snapshot (same array ref,
        // seeded by the owner mount) and no suppression churn is pending:
        // nothing changed ⇒ nothing to re-present. The old code re-merged and
        // re-committed all rows anyway — measured as the bulk of a 301ms
        // main-thread block inside the tab-click frame on a 1093-row session.
        if (
          rawSnapshot
          && rawServerEntriesRef.current === (rawSnapshot.entries as unknown as FullHistoryEntry[])
          && !needsRawForPresentation
        ) {
          historyLoaderReasonRef.current = 'load-unchanged';
          setLoading(false);
          historyDiag('LOAD_UNCHANGED tab=' + tabId.slice(-12) +
            ' session=' + sessionId.slice(0, 8) +
            ' seq=' + loadSequence +
            ' elapsedMs=' + (Date.now() - loadStartedAt) +
            ' cache=hit keptPresentation=1' +
            ' keptEntries=' + rawSnapshot.entries.length);
          return true;
        }
        if (rawSnapshot) {
          await waitForHistoryApplySlot('unchanged-cache');
          if (!isCurrentOwner()) return false;
          const rawEntries = rawSnapshot.entries as unknown as FullHistoryEntry[];
          rawServerEntriesRef.current = rawEntries;
          reconcileLiveToolResultsAgainstDurable(rawEntries, ownerKeyAtStart);
          consumeMaterializedPromptHandoffs(rawEntries);
          if (toolType === 'codex') {
            reconcileCodexEffectiveSettings(tabId, sessionId, rawEntries);
          }
          lastServerEntryUuidsRef.current = new Set(rawEntries.map((entry) => entry.uuid));
          const materializedRawEntries = materializeHistoryWindowForPresentation(
            rawEntries,
            'unchanged-cache',
          );
          const presentedServerEntries = filterSuppressedPromptEntries(
            materializedRawEntries,
            suppressedPromptsRef.current.values(),
          ).entries;
          const nextEntries = mergeServerAndLocalEntries(
            presentedServerEntries,
            presentationEntriesRef.current,
          );
          historyPresentationApplyGuardRef.current('unchanged-cache');
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
        // Yield one task boundary before the heavy per-entry passes. The IPC
        // continuation otherwise reconciles/filters/merges thousands of rows
        // in the SAME task the response landed in — one unbreakable 693-937ms
        // chunk (measured 04.08 19:38 on a 2618-row Claude session), and a
        // right-click that arrived during the IPC wait queued behind all of it
        // (inputDelay=240ms). The rAF lets the browser paint and dispatch
        // pending input first; the heavy work then runs one frame later.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => setTimeout(resolve, 0));
        });
        await waitForHistoryApplySlot(isRefresh ? 'refresh' : 'cold');
        if (!isCurrentOwner()) {
          historyDiag('LOAD_STALE_DROP tab=' + tabId.slice(-12) +
            ' session=' + sessionId.slice(0, 8) +
            ' seq=' + loadSequence +
            ' phase=apply-yield' +
            ' elapsedMs=' + (Date.now() - loadStartedAt));
          return false;
        }
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
        // The hydrated span is NOT mirrored into renderer state: the rows
        // themselves (rowStub flags) are the single source of truth for
        // every "do I need to hydrate?" decision. This log is diagnosis
        // only. `centerMissing` is remembered per-uuid so the panel does
        // not re-ask main for a row main just said it cannot find.
        if (result.rowWindowApplied) {
          hydrationLastResultRef.current = {
            centerUuid: hydrationCenterUuidRef.current,
            centerMissing: result.centerMissing === true,
          };
          historyDiag('HYDRATION_SPAN tab=' + tabId.slice(-12) +
            ' seq=' + loadSequence +
            ' span=' + (Number(result.hydratedFrom) || 0) + '-' + (Number(result.hydratedTo) || 0) +
            ' hydrated=' + (result.hydratedCount ?? -1) +
            ' stubbed=' + (result.stubbedCount ?? -1) +
            (result.centerMissing === true ? ' centerMissing=1' : ''));
        }
        const rawServerEntries: FullHistoryEntry[] = result.entries || [];
        rawServerEntriesRef.current = rawServerEntries;
        reconcileLiveToolResultsAgainstDurable(rawServerEntries, ownerKeyAtStart);
        consumeMaterializedPromptHandoffs(rawServerEntries);
        if (toolType === 'codex') {
          reconcileCodexEffectiveSettings(tabId, sessionId, rawServerEntries);
        }
        const materializedRawEntries = materializeHistoryWindowForPresentation(
          rawServerEntries,
          isRefresh ? 'refresh' : 'cold',
        );
        const suppressedResult = filterSuppressedPromptEntries(
          materializedRawEntries,
          suppressedPromptsRef.current.values(),
        );
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
          // A sibling pane may be receiving streaming/durable updates while
          // the user scrolls this one. Default-priority reconciliation can
          // begin just before the first wheel and then keep the renderer in a
          // 150-300ms commit. A transition preserves every row but lets React
          // yield that render to the physical input lane.
          historyPresentationApplyGuardRef.current('refresh:' + loadSequence);
          startTransition(() => {
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
          });
          // A settled refresh may replace the live tail in-place or extend an
          // already-collapsed final group, neither of which guarantees a
          // Virtuoso item-count append. Preserve the same tail ownership as
          // the live stream instead of leaving the completed answer below the
          // viewport.
          keepHistoryTailPinnedAfterMutation('durable-refresh');
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
          // the prefix stand as if it were the final history. The error banner
          // lives in the composer component, so the notice travels through the
          // same tab-scoped channel the rewind failure above already uses.
          window.dispatchEvent(new CustomEvent('history-panel:agent-error', {
            detail: {
              tabId,
              message: 'История новой ветки не загрузилась: ' + String(result?.error || 'load failed') + '. Показан общий префикс до отката.',
            },
          }));
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
          window.dispatchEvent(new CustomEvent('history-panel:agent-error', {
            detail: {
              tabId,
              message: 'История новой ветки не загрузилась: ' + String((e as any)?.message || e) + '. Показан общий префикс до отката.',
            },
          }));
        }
      }
      historyDiag('LOAD_ERROR tab=' + tabId.slice(-12) +
        ' session=' + sessionId.slice(0, 8) +
        ' seq=' + loadSequence +
        ' refresh=' + (isRefresh ? '1' : '0') +
        ' elapsedMs=' + (Date.now() - loadStartedAt) +
        ' error=' + String((e as any)?.message || e));
      return false;
    } finally {
      // Every exit closes the attribution mark — an unclosed mark would be
      // reported as "(open)" forever and blame this load for later freezes.
      endLoadMark();
    }
  }, [sessionId, cwd, historyOwnerKey, historySnapshotOwner, keepHistoryTailPinnedAfterMutation, materializeHistoryWindowForPresentation, persistVolatileOverlay, scrollToBottom, setHistoryRewindPreview, tabId, toolType, reconcileLiveToolResultsAgainstDurable, consumeMaterializedPromptHandoffs]);

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
  // Callers defined ABOVE this declaration (search-match navigation, the
  // Timeline-jump effect) reach the loader through this ref.
  loadHistoryRef.current = loadHistory;

  // Row-window hydration watcher.
  //
  // Called whenever the visible range moves. Stateless by design: it scans
  // the rows around the viewport for identity stubs instead of consulting a
  // mirrored "hydrated span" — derived span state is exactly what deadlocked
  // the 14.08 Timeline jumps (a delta response without row-window fields
  // flipped it to "not windowed", and an owner switch inherited another
  // tab's span). The rows main shipped cannot drift from themselves.
  //
  // Deliberately NOT event-throttled by a timer: one request in flight at a
  // time, and a request is only issued when a stub sits within the margin. A
  // fully hydrated neighbourhood issues nothing at all, so scrolling inside
  // the span is free; the scan itself is O(margin) property reads.
  const maybeRequestHistoryHydration = useCallback((reason: string) => {
    if (toolType !== 'codex') return;
    if (hydrationRequestInFlightRef.current) return;
    // Oscillation breaker (see HYDRATION_BURST_*): viewport-driven hydration
    // must converge. A burst that does not is a loop, and a loop makes the
    // whole app stutter — stop asking until the user scrolls again.
    if (reason === 'range-idle') {
      const now = performance.now();
      const burst = hydrationBurstRef.current;
      if (now - burst.since > HYDRATION_BURST_WINDOW_MS) {
        burst.since = now;
        burst.count = 0;
        burst.tripped = false;
      }
      if (burst.tripped) return;
      burst.count += 1;
      if (burst.count > HYDRATION_BURST_MAX_REQUESTS) {
        burst.tripped = true;
        historyDiag('HYDRATION_BURST_STOP tab=' + tabId.slice(-12)
          + ' count=' + burst.count
          + ' windowMs=' + Math.round(now - burst.since));
        return;
      }
    }
    // A converging Timeline jump owns the centre; ranges published while it
    // hunts are transit, not reading positions.
    if (historyJumpHydrationActiveRef.current) return;
    // A position restore is transit too — and this is the one that cost a
    // whole tab.
    //
    // Switching to a tab remounts the list, and the list publishes its first
    // range (rows 0-9, the top) BEFORE the restore has moved it to where the
    // person was reading. The watcher believed that range: it saw stubs at
    // row 0, asked main to hydrate around row 0 — and main's answer evicted
    // the span the reader was actually in. Live 18.08 01:50:31: `range=0-9
    // stubAt=0` immediately after the switch, the readable span moved from
    // 645-1394 to 0-750, and the tab went grey until it was clicked again.
    //
    // A jump restore already knew this; the position restore is the same fact
    // — the viewport is being MOVED, not read — and it already has a signal.
    // Ranges during the hunt are a machine scrolling, not a person reading,
    // and only a person's position deserves the hydrated span.
    if (reason === 'range-idle' && historyRestoreInFlightRef.current !== 0) return;
    // Anchor on the STUB, never on the viewport midpoint (the midpoint anchor
    // looped in production 16.08 ~01:08 — grouping moved it to a different
    // entry after every response, and that entry often could not anchor a
    // span at all). The stub search itself is bounded in ENTRIES and skips
    // collapsed groups — see findHistoryHydrationStub for the second loop
    // this closed (16.08 ~02:04: two stub flanks wider than one window,
    // every response evicting the other flank, ~7 reloads/s standing still).
    const range = visibleRangeRef.current;
    const found = findHistoryHydrationStub(
      displayUnitsRef.current,
      range,
      HISTORY_HYDRATION_REFETCH_MARGIN_ROWS,
    );
    if (!found) return;
    const stubEntry = found.entry as FullHistoryEntry;
    const centerUuid = historyHydrationCenterForRange(
      displayUnitsRef.current,
      range,
      stubEntry.uuid || null,
    );
    requestHistoryHydrationAt(
      centerUuid,
      reason,
      ' range=' + range.start + '-' + range.end
        + ' stubAt=' + found.index
        + ' stub=' + String(stubEntry.uuid || '').slice(0, 8),
    );
  }, [requestHistoryHydrationAt, toolType]);

  const scheduleHistoryHydrationRangeCheck = useCallback(() => {
    if (hydrationRangeIdleTimerRef.current !== null) {
      clearTimeout(hydrationRangeIdleTimerRef.current);
    }
    hydrationRangeIdleTimerRef.current = setTimeout(() => {
      hydrationRangeIdleTimerRef.current = null;
      if (
        historyPointerScrollActiveRef.current
        || historyScrollSeekController.isActive()
        || historyJumpHydrationActiveRef.current
        || historyRestoreInFlightRef.current !== 0
      ) return;
      maybeRequestHistoryHydration('range-idle');
    }, HISTORY_HYDRATION_RANGE_IDLE_MS);
  }, [historyScrollSeekController, maybeRequestHistoryHydration]);

  useEffect(() => () => {
    if (hydrationRangeIdleTimerRef.current !== null) {
      clearTimeout(hydrationRangeIdleTimerRef.current);
      hydrationRangeIdleTimerRef.current = null;
    }
  }, [historyOwnerKey]);

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
      !historyPresentationProofRef.current.presented
      || surfaceLoading
      || transcriptEntries.length !== 0
      || presentedOwnerKey !== historyOwnerKey
      || historyOwnerKeyRef.current !== historyOwnerKey
    ) return;

    const ownerAtSchedule = historyOwnerKey;
    const generationAtSchedule = historyOwnerGenerationRef.current;
    const presentationVisitAtSchedule = historyPresentationProofRef.current.visit;
    const presentedProofKey = ownerAtSchedule + ':' + generationAtSchedule
      + ':pv' + presentationVisitAtSchedule;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (
          historyOwnerKeyRef.current !== ownerAtSchedule
          || historyOwnerGenerationRef.current !== generationAtSchedule
          || !historyPresentationOwnsWrite(
            historyPresentationProofRef.current,
            presentationVisitAtSchedule,
          )
          || surfacePresentedOwnerRef.current === presentedProofKey
        ) return;
        const emptyState = panelRef.current?.querySelector(
          '[data-history-empty-state]',
        ) as HTMLElement | null;
        if (!emptyState || emptyState.getBoundingClientRect().height <= 0) return;
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
          + ' presentationVisit=' + presentationVisitAtSchedule
          + ' cache=' + cacheAtPaint
          + ' domRows=0 foreignDomRows=0'
          + ' loader=' + (visibleSurfaceLoading ? 'visible' : 'hidden')
          + ' proof=painted-empty-state');
        publishHistorySurfacePresented({
          ownerKey: ownerAtSchedule,
          generation: generationAtSchedule,
          presentationVisit: presentationVisitAtSchedule,
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
    presented,
    historyPresentationVisit,
  ]);

  // Initial load on mount / session change / tool type switch
  const initialLoadDoneRef = useRef(false);
  const appliedHistoryPresentationRef = useRef({
    presented,
    visit: historyPresentationVisit,
  });
  useLayoutEffect(() => {
    if (presentationExternallyManaged) return;
    const proof = historyPresentationProofRef.current;
    const previous = appliedHistoryPresentationRef.current;
    if (previous.presented === proof.presented && previous.visit === proof.visit) return;
    appliedHistoryPresentationRef.current = {
      presented: proof.presented,
      visit: proof.visit,
    };

    // The old dormant representation changed every pane to full-screen and
    // changed stacked composers to regular height. A restore was therefore
    // necessary on every visible visit. Exact dormant placement now keeps the
    // same rectangle/header/composer; in that path the DOM already owns the
    // right scrollTop and re-converging it is pure layout work.
    if (!preservePresentationGeometry) {
      initialLoadDoneRef.current = false;
      if (proof.presented) armHistoryViewportPaintProof();
    }
    scrollRestoreGenRef.current += 1;
    if (scrollSaveTimerRef.current) {
      clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = null;
    }
    historyTailPinScheduler.cancel();
    if (!proof.presented) {
      viewportPaintProbeRef.current?.cancel();
      surfacePresentedProbeRef.current?.cancel();
      historyPresentationHideCleanupRef.current?.();
    }
    historyDiag('PRESENTATION_STATE tab=' + tabId.slice(-12)
      + ' presented=' + (proof.presented ? '1' : '0')
      + ' visit=' + proof.visit
      + ' mode=' + (mainSurface ? 'main' : agentSidePanel ? 'side' : 'legacy')
      + ' follow=' + (isAtBottomRef.current ? '1' : '0'));
  }, [
    agentSidePanel,
    armHistoryViewportPaintProof,
    historyPresentationVisit,
    historyTailPinScheduler,
    mainSurface,
    preservePresentationGeometry,
    presented,
    presentationExternallyManaged,
    tabId,
  ]);

  useLayoutEffect(() => {
    if (!presentationExternallyManaged || !presentationChannel) return undefined;
    let paintFrame1 = 0;
    let paintFrame2 = 0;
    const cancelPaint = () => {
      if (paintFrame1) cancelAnimationFrame(paintFrame1);
      if (paintFrame2) cancelAnimationFrame(paintFrame2);
      paintFrame1 = 0;
      paintFrame2 = 0;
    };
    const remountForChangedGeometry = () => {
      initialLoadDoneRef.current = false;
      viewportPaintProbeRef.current?.cancel();
      surfacePresentedProbeRef.current?.cancel();
      armHistoryViewportPaintProof();
      // Width/stacking changes invalidate every stored pixel height even when
      // row identities are unchanged. The semantic reading anchor remains the
      // fallback source of truth; measured layout is only an accelerator.
      dropHistoryMeasuredLayout(historyOwnerKeyRef.current);
      setPresentationRestoreTick((value) => value + 1);
    };
    // Commit-safe structural check only. Reading client rects here used to
    // force the WHOLE workspace layout once per incoming History while React
    // was still inside the workflow-switch layout-effect pass: two panes cost
    // ~216ms and four cost ~400ms. Exact non-zero pixel proof remains below,
    // after two animation frames; this gate only catches the common stale-
    // padding case early enough to keep its loader over the first frame.
    const stableLayerHasContentNode = () => {
      const root = panelRef.current;
      if (!root) return false;
      const realRow = root.querySelector(
        `[data-history-row-real][data-history-row-owner="${CSS.escape(historyOwnerDomId)}"]`,
      );
      return !!realRow || !!root.querySelector('[data-history-empty-state]');
    };
    const applyPresentation = (nextPresented: boolean, geometryStable: boolean) => {
      const previous = historyPresentationProofRef.current;
      const proof = advanceHistoryPresentationProof(previous, nextPresented);
      const presentationChanged = previous.presented !== proof.presented
        || previous.visit !== proof.visit;
      if (presentationChanged) {
        historyPresentationProofRef.current = proof;
        appliedHistoryPresentationRef.current = {
          presented: proof.presented,
          visit: proof.visit,
        };
        panelRef.current?.setAttribute('data-history-presented', proof.presented ? '1' : '0');
        panelRef.current?.setAttribute('data-history-presentation-visit', String(proof.visit));

        if (!geometryStable) remountForChangedGeometry();
        scrollRestoreGenRef.current += 1;
        if (scrollSaveTimerRef.current) {
          clearTimeout(scrollSaveTimerRef.current);
          scrollSaveTimerRef.current = null;
        }
        historyTailPinScheduler.cancel();
        cancelPaint();
        if (!proof.presented) {
          viewportPaintProbeRef.current?.cancel();
          surfacePresentedProbeRef.current?.cancel();
          // Proof is already false here. Cleanup may cancel a visual bridge,
          // but its ownership guard can no longer transfer that offset into
          // hidden-pane scrollTop.
          historyPresentationHideCleanupRef.current?.();
        }
        historyDiag('PRESENTATION_STATE tab=' + tabId.slice(-12)
          + ' presented=' + (proof.presented ? '1' : '0')
          + ' visit=' + proof.visit
          + ' mode=' + (mainSurface ? 'main' : agentSidePanel ? 'side' : 'legacy')
          + ' follow=' + (isAtBottomRef.current ? '1' : '0')
          + ' external=1 geometry=' + (geometryStable ? 'stable' : 'changed'));
      } else {
        // First visible visit of a background-prewarmed pane crosses two
        // ownership mechanisms in one commit: the ordinary `presented` prop
        // sets the visit, then PersistentPaneHistory hands the same `true`
        // state to the external channel. Returning here used to drop the only
        // post-visibility paint opportunity when mount-wave had already
        // finished while the pane was transparent (`scroller=none`). Do not
        // version presentation or restore scroll again; only fall through to
        // the exact painted-row proof below.
        if (!proof.presented) return;
        if (!geometryStable) {
          cancelPaint();
          scrollRestoreGenRef.current += 1;
          if (scrollSaveTimerRef.current) {
            clearTimeout(scrollSaveTimerRef.current);
            scrollSaveTimerRef.current = null;
          }
          historyTailPinScheduler.cancel();
          remountForChangedGeometry();
          historyDiag('PRESENTATION_GEOMETRY_REMOUNT tab=' + tabId.slice(-12)
            + ' owner=' + historyOwnerDigest(historyOwnerKeyRef.current)
            + ' visit=' + proof.visit);
          return;
        }
        cancelPaint();
      }

      if (proof.presented) {
        terminalPreviewPresentationWakeRef.current?.(
          'presentation-visit:' + proof.visit,
        );
      }
      if (!proof.presented || !geometryStable) return;
      // A stable compositor layer normally keeps its painted Virtuoso. But a
      // hidden append can still leave only stale padding mounted. The old
      // owner-ready bit then described a PREVIOUS frame and exposed black
      // pixels on show (tab-4505). Re-arm only when the current DOM disproves
      // readiness; a genuinely warm layer remains untouched.
      const missingContentNode = displayEntriesRef.current.length > 0
        && !stableLayerHasContentNode();
      if (missingContentNode) {
        armHistoryViewportPaintProof();
        historyDiag('PRESENTATION_EMPTY_REARM tab=' + tabId.slice(-12)
          + ' owner=' + historyOwnerDigest(historyOwnerKeyRef.current)
          + ' visit=' + proof.visit);
      }
      const ownerAtSchedule = historyOwnerKeyRef.current;
      const generationAtSchedule = historyOwnerGenerationRef.current;
      const visitAtSchedule = proof.visit;
      const proofKeyAtSchedule = ownerAtSchedule + ':' + generationAtSchedule + ':pv' + visitAtSchedule;
      const historyProofPending = viewportReadyOwnerKeyRef.current !== ownerAtSchedule;
      const surfaceProofPending = surfacePresentedOwnerRef.current !== proofKeyAtSchedule;
      if (!historyProofPending && !surfaceProofPending) return;
      if (!presentationChanged) {
        historyDiag('PRESENTATION_PROBE_SAME_STATE tab=' + tabId.slice(-12)
          + ' owner=' + historyOwnerDigest(ownerAtSchedule)
          + ' generation=' + generationAtSchedule
          + ' visit=' + visitAtSchedule
          + ' viewportPending=' + (historyProofPending ? '1' : '0')
          + ' surfacePending=' + (surfaceProofPending ? '1' : '0'));
      }
      paintFrame1 = requestAnimationFrame(() => {
        paintFrame2 = requestAnimationFrame(() => {
          if (!historyPresentationOwnsWrite(historyPresentationProofRef.current, visitAtSchedule)) return;
          if (historyOwnerKeyRef.current !== ownerAtSchedule
            || historyOwnerGenerationRef.current !== generationAtSchedule) return;
          const root = panelRef.current;
          if (!root) return;
          const paintedRows = (selector: string) => Array.from(
            root.querySelectorAll(selector),
          ).filter((node) => (node as HTMLElement).getBoundingClientRect().height > 0).length;
          const realRows = paintedRows(
            `[data-history-row-real][data-history-row-owner="${CSS.escape(historyOwnerDomId)}"]`,
          );
          const allRealRows = paintedRows('[data-history-row-real]');
          const emptyState = root.querySelector('[data-history-empty-state]') as HTMLElement | null;
          const emptyPainted = !!emptyState && emptyState.getBoundingClientRect().height > 0;
          if (realRows === 0 && !emptyPainted) {
            // A real node existed during commit but still failed the exact
            // post-paint height proof. Re-arm now rather than weakening the
            // strict loader contract; unlike the old path this geometry read
            // cannot delay acknowledgement of the workflow click.
            if (!missingContentNode && displayEntriesRef.current.length > 0) {
              armHistoryViewportPaintProof();
              historyDiag('PRESENTATION_UNPAINTED_REARM tab=' + tabId.slice(-12)
                + ' owner=' + historyOwnerDigest(historyOwnerKeyRef.current)
                + ' visit=' + visitAtSchedule);
            }
            return;
          }
          const proofKey = ownerAtSchedule + ':' + generationAtSchedule + ':pv' + visitAtSchedule;
          if (surfacePresentedOwnerRef.current === proofKey) return;
          surfacePresentedOwnerRef.current = proofKey;
          const cacheAtPaint = historySnapshotCache.peek<FullHistoryEntry>(historySnapshotOwner)
            ? 'hit'
            : 'miss';
          historyDiag('SURFACE_PRESENTED tab=' + tabId.slice(-12)
            + ' owner=' + historyOwnerDigest(ownerAtSchedule)
            + ' generation=' + generationAtSchedule
            + ' presentationVisit=' + visitAtSchedule
            + ' cache=' + cacheAtPaint
            + ' domRows=' + realRows
            + ' foreignDomRows=' + Math.max(0, allRealRows - realRows)
            + ' loader=' + (visibleSurfaceLoading ? 'visible' : 'hidden')
            + ' proof=stable-space-layer');
          publishHistorySurfacePresented({
            ownerKey: ownerAtSchedule,
            generation: generationAtSchedule,
            presentationVisit: visitAtSchedule,
            proof: emptyPainted ? 'painted-empty-state' : 'mounted-painted-row',
            domRows: realRows,
            foreignDomRows: Math.max(0, allRealRows - realRows),
            cache: cacheAtPaint,
          });
        });
      });
    };
    const onPresentation = (event: Event) => {
      const detail = (event as CustomEvent<{
        channel?: string;
        presented?: boolean;
        geometryStable?: boolean;
        focused?: boolean;
      }>).detail;
      if (detail?.channel !== presentationChannel) return;
      if (typeof detail.focused === 'boolean') {
        globalHotkeysSuppressedRef.current = !detail.focused;
      }
      applyPresentation(detail.presented === true, detail.geometryStable === true);
    };
    window.addEventListener(HISTORY_SURFACE_PRESENTATION_EVENT, onPresentation);
    return () => {
      cancelPaint();
      window.removeEventListener(HISTORY_SURFACE_PRESENTATION_EVENT, onPresentation);
    };
  }, [
    agentSidePanel,
    armHistoryViewportPaintProof,
    historyOwnerDomId,
    historySnapshotOwner,
    historyTailPinScheduler,
    mainSurface,
    presentationChannel,
    presentationExternallyManaged,
    publishHistorySurfacePresented,
    tabId,
    visibleSurfaceLoading,
  ]);
  // Cancels a warm-return verify pass that has not fired yet (owner left
  // before its two-frame delay elapsed).
  const deferredWarmRefreshCancelRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    // Names the owner-takeover commit in freeze attribution. The 04.08 19:38
    // log showed 693/937ms long tasks whose first ~600-800ms preceded
    // LOAD_START — i.e. the takeover render+seeding itself, not the IPC load.
    // This mark closes on the next frame, covering exactly that commit.
    const endOwnerMountMark = markRendererActivity(
      'history-owner-mount:' + tabId.slice(-8)
    );
    requestAnimationFrame(() => endOwnerMountMark());
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
    const reportInitialLoadSettled = (status: HistoryInitialSourceSignal['status']) => {
      queueMicrotask(() => {
        if (
          historyOwnerKeyRef.current !== historyOwnerKey
          || historyOwnerGenerationRef.current !== generation
        ) return;
        onInitialSourceSignalRef.current?.({
          tabId,
          sessionId,
          ownerKey: historyOwnerKey,
          generation,
          phase: 'load',
          status,
        });
      });
    };
    deferredTranscriptRefreshRef.current = false;
    // Hydration machinery is owner-local. The seq bump orphans a previous
    // owner's in-flight completion callback so it can neither clear the new
    // owner's in-flight flag nor fire a queued request against it. Observed
    // 14.08 07:02: tab-2482's watcher read a span that tab-2546's load wrote.
    hydrationRequestSeqRef.current += 1;
    hydrationRequestInFlightRef.current = false;
    hydrationPendingRef.current = null;
    hydrationLastResultRef.current = null;
    hydrationLastIssuedRef.current = new Map();
    historyJumpHydrationActiveRef.current = false;
    // Seed the FIRST request's hydration centre from where this owner will
    // actually land: a pending Timeline jump wins, then the saved reading
    // anchor (a mid-history reader returns to hydrated rows instead of a
    // skeleton flash + second round-trip), tail otherwise (null).
    {
      const ui = useUIStore.getState();
      const pendingJumpUuid = ui.historyScrollTargetTabId === tabId
        ? ui.historyScrollToUuid
        : null;
      const savedAnchor = getHistoryReadingAnchor(scrollPositionKeyRef.current);
      hydrationCenterUuidRef.current = pendingJumpUuid
        || (savedAnchor && !savedAnchor.followBottom ? savedAnchor.uuid : null);
    }
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
    setHistoryTailFollowIntent(true);
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
            .filter((entry) => (
              !isLocalRewindEntry(entry)
              && !isLocalPromptEntry(entry)
              && !isLocalCompactErrorEntry(entry)
            ));
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
    // Reconcile only the bounded renderer-local overlay. The full transcript
    // can contain tens of thousands of rows and remains owned by the durable
    // history loader below. Exact handoffId is the sole identity here: equal
    // text/timestamps are never adoption proof.
    const handoffSessionRoutes = new Map<string, ReturnType<
      typeof resolveHistoryPromptHandoffPresentationSession
    >>();
    const ownerHandoffs = getHistoryPromptHandoffsSnapshot(tabId).filter((handoff) => {
      if (handoff.toolType !== toolType) return false;
      const sessionRoute = resolveHistoryPromptHandoffPresentationSession({
        auditSessionId: handoff.auditProof?.sessionId || handoff.providerQueueProof?.sessionId,
        sessionIdHint: handoff.sessionIdHint,
        currentSessionId: sessionId,
      });
      if (!sessionRoute.belongsToCurrent) return false;
      handoffSessionRoutes.set(handoff.handoffId, sessionRoute);
      return true;
    });
    const restoredHandoffMeta = new Map(volatileOverlay?.handoffs || []);
    for (const handoff of ownerHandoffs) {
      const cleanContent = normalizeHistoryPromptText(handoff.text);
      if (!cleanContent) continue;
      const route = handoffSessionRoutes.get(handoff.handoffId);
      const carrierProof = handoff.auditProof || handoff.providerQueueProof;
      restoredHandoffMeta.set(handoff.handoffId, {
        text: cleanContent,
        submittedAt: handoff.submittedAt,
        sessionId: carrierProof?.sessionId
          || route?.presentationSessionId
          || handoff.sessionIdHint
          || sessionId,
        requiresAuditIdentity: handoff.requiresAuditIdentity,
        auditTimestamp: handoff.auditProof?.auditTimestamp,
        auditHash: handoff.auditProof?.actualHash,
        auditEntryUuid: handoff.auditProof?.entryUuid,
        sourceIdentity: carrierProof?.sourceIdentity,
        recordByteOffset: carrierProof?.recordByteOffset,
      });
    }
    const restoredOverlayRows = (
      volatileOverlay?.entries as unknown as FullHistoryEntry[] | undefined
    ) || [];
    const reconciledOverlay = reconcileHistoryPromptHandoffRows({
      rows: restoredOverlayRows,
      handoffs: ownerHandoffs,
      createRow: (handoff): FullHistoryEntry | null => {
        const cleanContent = normalizeHistoryPromptText(handoff.text);
        const route = handoffSessionRoutes.get(handoff.handoffId);
        if (!cleanContent || !route) return null;
        return {
          uuid: LOCAL_PROMPT_PREFIX + tabId + '-' + handoff.handoffId,
          role: 'queued',
          queueStatus: handoff.queueStatus,
          statusAtSend: handoff.statusAtSend,
          handoffId: handoff.handoffId,
          statusReason: handoff.statusReason,
          timestamp: new Date(handoff.submittedAt).toISOString(),
          content: cleanContent,
          sessionId: route.presentationSessionId,
          optimisticAt: handoff.submittedAt,
          statusChangedAt: handoff.statusChangedAt,
          promptChips: normalizeComposerChips(handoff.promptChips)
            .filter((chip) => chip.kind === 'prompt') as HistoryPromptDraftChip[],
          imagePaths: retainHistoryDraftImages(cleanContent, handoff.imagePaths),
          requiresAuditIdentity: handoff.requiresAuditIdentity,
        };
      },
    });
    const now = Date.now();
    const restoredSuppressions = (volatileOverlay?.suppressions || [])
      .filter(([, suppression]) => suppression.expiresAt > now);
    promptHandoffMetaRef.current = restoredHandoffMeta;
    suppressedPromptsRef.current = new Map(restoredSuppressions);
    const restoredLocalEntries = mergeServerAndLocalEntries(
      [],
      reconciledOverlay.rows as FullHistoryEntry[],
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
    if (cachedSnapshot) {
      // Warm return: the cached rows are ALREADY on screen — the verify-
      // freshness pass is invisible to the user unless the file changed, so it
      // has no claim on the switch window. Waiting two frames keeps the whole
      // takeover (highlight, cached rows, restored position) clean of IPC and
      // heavy merges; a live session's tail events still arrive through the
      // transcript-changed subscription regardless of this initial check.
      //
      // Probe-first: "did anything change?" is a stats-only question, but the
      // old path asked it through the FULL get-full-history pipeline — main
      // resolved the whole 59MB chain to answer "unchanged" (821-1292ms wall
      // per switch under the switch-window IPC storm, live 05.08 15:29, felt
      // as a train of 150-250ms input stalls while moving the cursor). The
      // cheap probe answers from file stats; only a real change or a missing
      // revision escalates to the heavy load. Claude-only: codex's own
      // unchanged path already answers in ~50ms.
      let refreshRaf2 = 0;
      const refreshRaf1 = requestAnimationFrame(() => {
        refreshRaf2 = requestAnimationFrame(() => {
          if (historyOwnerKeyRef.current !== historyOwnerKey) return;
          const revisionForProbe = toolType === 'claude' ? historyRevisionRef.current : null;
          if (!revisionForProbe) {
            void loadHistory(true).then((ok) => {
              reportInitialLoadSettled(ok ? 'success' : 'failure');
            }).catch(() => reportInitialLoadSettled('failure'));
            return;
          }
          const probeStartedAt = Date.now();
          void ipcRenderer.invoke('claude:validate-full-history-revision', {
            sessionId,
            cwd,
            tabId,
            revision: revisionForProbe,
          }).then((probe: any) => {
            if (historyOwnerKeyRef.current !== historyOwnerKey) return;
            if (probe?.success && probe.unchanged === true
              // A newer revision means a full load landed while the probe ran
              // — its answer describes a stale question.
              && historyRevisionRef.current === revisionForProbe) {
              historyDiag('LOAD_FRESH_PROBE tab=' + tabId.slice(-12)
                + ' session=' + sessionId.slice(0, 8)
                + ' unchanged=1 elapsedMs=' + (Date.now() - probeStartedAt));
              reportInitialLoadSettled('cached');
              return;
            }
            void loadHistory(true).then((ok) => {
              reportInitialLoadSettled(ok ? 'success' : 'failure');
            }).catch(() => reportInitialLoadSettled('failure'));
          }).catch(() => {
            if (historyOwnerKeyRef.current !== historyOwnerKey) return;
            void loadHistory(true).then((ok) => {
              reportInitialLoadSettled(ok ? 'success' : 'failure');
            }).catch(() => reportInitialLoadSettled('failure'));
          });
        });
      });
      // Cancellation lives in the shared cleanup below via the owner guard —
      // an owner change before the frames fire makes the callback a no-op, and
      // the rAFs themselves are cancelled explicitly.
      const cancelDeferredRefresh = () => {
        cancelAnimationFrame(refreshRaf1);
        if (refreshRaf2) cancelAnimationFrame(refreshRaf2);
      };
      deferredWarmRefreshCancelRef.current = cancelDeferredRefresh;
    } else {
      deferredWarmRefreshCancelRef.current = null;
      void loadHistory(false).then((ok) => {
        reportInitialLoadSettled(ok ? 'success' : 'failure');
      }).catch(() => reportInitialLoadSettled('failure'));
    }
    return () => {
      deferredWarmRefreshCancelRef.current?.();
      deferredWarmRefreshCancelRef.current = null;
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
        .flatMap((entry) => historyLivePresentationIdentities(entry)),
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
    const presentationAtRestore = historyPresentationProofRef.current;
    if (!presentationAtRestore.presented) return;
    if (surfaceLoading || initialLoadDoneRef.current) return;
    // Same mountability gates as the render stub: passive effects of the
    // TRANSITIONAL commit (owner prop changed, takeover not yet re-rendered)
    // flush before the commit that actually mounts the list. Running the
    // restore there would consume initialLoadDoneRef against a null scroller
    // — the convergence loop would spin over nothing while blocking the real
    // restore of the mounted list one commit later.
    if (ownerChangedBeforeLayoutHandoff || historyOwnerVisit === 0) return;
    if (displayEntries.length === 0) return;
    const pendingJump = useUIStore.getState();
    if (
      pendingJump.historyScrollTargetTabId === tabId
      && pendingJump.historyScrollToUuid
    ) {
      // Timeline navigation wins; mark restore as done so it cannot fire
      // later and yank the viewport away from the jump target.
      initialLoadDoneRef.current = true;
      return;
    }
    initialLoadDoneRef.current = true;
    // Geometry restores the PIXEL position the user left — which is the wrong
    // target for a tail-pinned reader when rows arrived while they were away:
    // the old tail offset is now mid-list, and nothing after mount would
    // correct it (followOutput reacts only to appends that happen POST-mount;
    // a cold load commits the longer list before the list exists). Let the
    // geometry paint the neighborhood instantly from real sizes, but hand
    // position ownership to the tail convergence below. A warm return whose
    // cache was already at the tail measures drift≈0 and settles on the first
    // frame, so the common case pays nothing.
    const frozenRestoreAnchor = getHistoryReadingAnchor(scrollPositionKeyRef.current);
    if (presentationAtRestore.resumes > 0) {
      historyDiag('PRESENTATION_RESTORE tab=' + tabId.slice(-12)
        + ' visit=' + presentationAtRestore.visit
        + ' mode=' + (frozenRestoreAnchor?.followBottom
          ? 'tail'
          : frozenRestoreAnchor ? 'anchor' : 'fallback')
        + ' follow=' + (isAtBottomRef.current ? '1' : '0'));
    }
    // Geometry owns the position only for a PROVEN mid-list reading place. No
    // anchor at all means the user never scrolled this owner — they were at
    // the tail (the initial position), and the anchor writer simply never ran
    // (it lives on scroll-idle). Such a return must behave like followBottom,
    // not like "hold whatever pixel the geometry stored": rows appended while
    // away would strand the viewport mid-list with followOutput blocked (the
    // scroller is not tail-pinned, so the append hook refuses to pull).
    if (restoredMeasuredLayout && frozenRestoreAnchor && !frozenRestoreAnchor.followBottom) {
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
      // Virtuoso adjusts scrollTop for a few frames while applying the
      // restored geometry. The position writers (live offset patch, idle
      // anchor save) must not record those transitional offsets as the
      // user's place — hold the same in-flight token the hunt loops use
      // until the position stops moving. A real user gesture ends the hold
      // immediately (their position IS the truth from that moment on).
      const restoreToken = ++historyRestoreTokenRef.current;
      historyRestoreInFlightRef.current = restoreToken;
      const restoreGenAtStart = scrollRestoreGenRef.current;
      const releaseRestoreToken = () => {
        if (historyRestoreInFlightRef.current === restoreToken) {
          historyRestoreInFlightRef.current = 0;
          // The gate's velocity sample of this machine jump arrives AFTER
          // the release — cover the echo window (velocity=464679 flash).
          historyScrollSeekController.stampMachineScrollCooldown();
        }
      };
      const measureDrift = () => {
        if (
          historyOwnerKeyRef.current !== driftOwner
          || historyOwnerGenerationRef.current !== driftGeneration
          || scrollRestoreGenRef.current !== restoreGenAtStart
          || !historyPresentationOwnsWrite(
            historyPresentationProofRef.current,
            presentationAtRestore.visit,
          )
        ) {
          releaseRestoreToken();
          return;
        }
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
        releaseRestoreToken();
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
      if (!historyPresentationOwnsWrite(
        historyPresentationProofRef.current,
        presentationAtRestore.visit,
      )) return 'presentation-change';
      return null;
    };
    // A settled hunt is the one moment the position is BOTH correct and fully
    // measured — bank the geometry immediately. Waiting for the next
    // scroll-idle tick left a converged-then-abandoned tab with a mid-hunt
    // offset in the store (the presented-proof baseline fires while the hunt
    // is still running), which is exactly the cold-return this cache exists
    // to kill. The in-flight flag brackets the whole loop so the live
    // scrollTop patch ignores the hunt's transient jump positions.
    const settleRestoreAndBankGeometry = (ownerAtRestore: string, restoreToken: number) => {
      if (historyRestoreInFlightRef.current === restoreToken) {
        historyRestoreInFlightRef.current = 0;
        historyScrollSeekController.stampMachineScrollCooldown();
        // The machine stopped moving, so the visible range finally means a
        // reading position: check it once. Ranges published DURING the hunt
        // were refused above, and this is the event that says they may now be
        // believed — without it a restore that landed on stubs (its anchor row
        // was edited away) would wait for the person to scroll.
        // `maybeRequestHistoryHydration` only reads refs, so calling the
        // closure this effect captured is safe; it is not in the dep list
        // because its identity is stable and this effect is position-critical.
        maybeRequestHistoryHydration('restore-settled');
      }
      // While the mount wave still renders shells, Virtuoso's state would
      // bank SHELL heights as if they were card measurements — for an
      // avg-estimated wave that poisons the store the persistence layer then
      // faithfully keeps across restarts. Whichever of {restore, wave}
      // finishes LAST does the one full save; the wave-done step checks the
      // restore token the same way this checks the wave.
      if (mountWaveActiveRef.current) return;
      const layoutItemKeys = displayUnitLayoutKeysRef.current;
      const layoutItems = layoutItemKeys.length;
      try {
        virtuosoRef.current?.getState((snapshot) => {
          if (historyOwnerKeyRef.current !== ownerAtRestore) return;
          if (!historyPresentationOwnsWrite(
            historyPresentationProofRef.current,
            presentationAtRestore.visit,
          )) return;
          const saved = saveHistoryMeasuredLayout(ownerAtRestore, snapshot as any, layoutItemKeys);
          if (saved) {
            historyDiag('LAYOUT_SAVE tab=' + tabId.slice(-12)
              + ' owner=' + historyOwnerDigest(ownerAtRestore)
              + ' ranges=' + ((snapshot as any)?.ranges?.length ?? 0)
              + ' items=' + layoutItems
              + ' at=restore-settled');
          }
        });
      } catch { /* geometry is optional; never break position restore */ }
    };
    const anchor = getHistoryReadingAnchor(scrollPositionKeyRef.current);
    if (anchor && !anchor.followBottom) {
      const index = displayEntryIndexByUuidRef.current.get(anchor.uuid);
      if (index !== undefined) {
        // The restored position is mid-list: Virtuoso followOutput must not
        // treat a live append as "user is at the tail" and yank away.
        setHistoryTailFollowIntent(false);
        const ownerAtRestore = historyOwnerKey;
        const generationAtRestore = historyOwnerGenerationRef.current;
        const restoreGenAtStart = ++scrollRestoreGenRef.current;
        const uuidTag = anchor.uuid.slice(0, 8);
        historyDiag('SCROLL_RESTORE tab=' + tabId.slice(-12)
          + ' mode=anchor uuid=' + uuidTag
          + ' idx=' + index + ' offset=' + anchor.offsetPx);
        const restoreToken = ++historyRestoreTokenRef.current;
        historyRestoreInFlightRef.current = restoreToken;
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
          onSettled: (o) => {
            settleRestoreAndBankGeometry(ownerAtRestore, restoreToken);
            historyDiag('SCROLL_RESTORE_DONE tab=' + tabId.slice(-12)
              + ' uuid=' + uuidTag + ' attempts=' + o.attempts
              + ' settled=' + o.settled
              + ' driftPx=' + (o.driftPx === null ? 'na' : Math.round(o.driftPx))
              + ' elapsedMs=' + Math.round(o.elapsedMs));
          },
          onAborted: (o) => {
            if (historyRestoreInFlightRef.current === restoreToken) {
              historyRestoreInFlightRef.current = 0;
            }
            historyDiag('SCROLL_RESTORE_CANCEL tab=' + tabId.slice(-12)
              + ' uuid=' + uuidTag + ' attempts=' + o.attempts + ' reason=' + o.reason);
          },
        });
        return;
      }
      // Anchor row vanished (rewind/edit truncated the branch): fall through
      // to the tail rather than showing an unrelated pixel position.
    }
    if (anchor?.followBottom || (!anchor && restoredMeasuredLayout)) {
      // The tail is NOT the trivial case it looks like. "Show the last row" is
      // still executed against ESTIMATED heights, so a bare jump lands short
      // and snaps down once the rows measure — visible in prod (26.07) as the
      // history appearing at the top and then dropping to the bottom. This
      // branch was the last one left doing a single shot, and it was also the
      // only one that logged no outcome, which is exactly why no test caught
      // it: a silent path has nothing to disagree with reality.
      //
      // The no-anchor-with-geometry case belongs here too: geometry restored
      // the pixel tail AS OF SAVE TIME, and with rows appended while away
      // that pixel is now mid-list with followOutput refusing to pull (the
      // scroller is not tail-pinned). No anchor means the user never scrolled
      // this owner — their position is the tail by construction, so converge
      // to the CURRENT tail. When nothing was appended the first drift
      // measurement is ≈0 and the loop settles without a single jump.
      const ownerAtRestore = historyOwnerKey;
      const generationAtRestore = historyOwnerGenerationRef.current;
      const restoreGenAtStart = ++scrollRestoreGenRef.current;
      historyDiag('SCROLL_RESTORE tab=' + tabId.slice(-12) + ' mode=tail');
      const restoreToken = ++historyRestoreTokenRef.current;
      historyRestoreInFlightRef.current = restoreToken;
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
        onSettled: (o) => {
          settleRestoreAndBankGeometry(ownerAtRestore, restoreToken);
          historyDiag('SCROLL_RESTORE_DONE tab=' + tabId.slice(-12)
            + ' mode=tail attempts=' + o.attempts
            + ' settled=' + o.settled
            + ' driftPx=' + (o.driftPx === null ? 'na' : Math.round(o.driftPx))
            + ' elapsedMs=' + Math.round(o.elapsedMs));
        },
        onAborted: (o) => {
          if (historyRestoreInFlightRef.current === restoreToken) {
            historyRestoreInFlightRef.current = 0;
          }
          historyDiag('SCROLL_RESTORE_CANCEL tab=' + tabId.slice(-12)
            + ' mode=tail attempts=' + o.attempts + ' reason=' + o.reason);
        },
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
        const restoreToken = ++historyRestoreTokenRef.current;
        historyRestoreInFlightRef.current = restoreToken;
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
          onSettled: (o) => {
            settleRestoreAndBankGeometry(ownerAtRestore, restoreToken);
            historyDiag('SCROLL_RESTORE_DONE tab=' + tabId.slice(-12)
              + ' mode=legacy-px attempts=' + o.attempts
              + ' settled=' + o.settled
              + ' driftPx=' + (o.driftPx === null ? 'na' : Math.round(o.driftPx))
              + ' elapsedMs=' + Math.round(o.elapsedMs));
          },
          onAborted: (o) => {
            if (historyRestoreInFlightRef.current === restoreToken) {
              historyRestoreInFlightRef.current = 0;
            }
            historyDiag('SCROLL_RESTORE_CANCEL tab=' + tabId.slice(-12)
              + ' mode=legacy-px attempts=' + o.attempts + ' reason=' + o.reason);
          },
        });
      }
    }
    // `entries` in deps: on a cold owner this effect must re-run when the
    // first projection lands (surfaceLoading flips earlier than rows exist).
    // `historyOwnerVisit` in deps: after the takeover publishes the visit the
    // effect must re-run — the transitional-commit guard above returned early
    // on the render where `entries` landed, and without this dep nothing
    // re-triggers the restore for a cache-hit switch (entries don't change
    // again).
  }, [surfaceLoading, tabId, historyOwnerKey, historyOwnerVisit, ownerChangedBeforeLayoutHandoff, entries, restoredMeasuredLayout, presented, historyPresentationVisit, presentationRestoreTick]);

  const resolveTerminalPreviewCanonicalTarget = useCallback((canonicalIdentity: string) => (
    resolveHistoryTerminalPreviewCanonicalTarget({
      canonicalIdentity,
      displayEntries: displayEntriesRef.current,
      displayUnits: displayUnitsRef.current,
      unitIndexByUuid: unitIndexByUuidRef.current,
      identitiesForEntry: historyLivePresentationIdentities,
    })
  ), []);

  // A canonical entry can exist in the projection before Virtuoso mounts its
  // exact presentation unit. Probe only for a few frames after each concrete
  // mount-range signal; the pending handoff itself has no timer expiry.
  const scheduleTerminalPreviewHandoffWake = useCallback((source: string) => {
    if (!terminalPreviewClearHandoffRef.current) return;
    if (terminalPreviewHandoffWakeRafRef.current) return;
    terminalPreviewHandoffWakeRafRef.current = requestAnimationFrame(() => {
      terminalPreviewHandoffWakeRafRef.current = 0;
      let pending = terminalPreviewClearHandoffRef.current;
      if (!pending) return;
      const presentation = historyPresentationProofRef.current;
      const sameOwner = pending.ownerKey === historyOwnerKeyRef.current
        && pending.ownerGeneration === historyOwnerGenerationRef.current;
      if (!sameOwner) return;

      // A persistent pane may receive canonical proof while hidden, then get
      // a new presentation visit when shown. The old visit is never allowed to
      // write; establish a fresh handoff only after the same exact canonical
      // identity is proven in the new owner's current projection.
      if (pending.presentationVisit !== presentation.visit) {
        if (!presentation.presented || !terminalPreviewRef.current) return;
        const target = resolveTerminalPreviewCanonicalTarget(pending.canonicalIdentity);
        if (!target) return;
        const scroller = virtuosoScrollerRef.current;
        const previewNode = panelRef.current?.querySelector(
          `[data-history-terminal-preview][data-preview-id="${CSS.escape(pending.previewId)}"]`,
        ) as HTMLElement | null;
        const followBottom = isAtBottomRef.current;
        const handoffAnchor = historyTerminalPreviewHandoffAnchor({
          followBottom,
          previewOffsetPx: scroller && previewNode
            ? previewNode.getBoundingClientRect().top - scroller.getBoundingClientRect().top
            : null,
          bottomGapPx: scroller
            ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
            : null,
        });
        pending = {
          ...pending,
          presentationVisit: presentation.visit,
          ...handoffAnchor,
          gestureGeneration: historyUserGestureGenerationRef.current,
          gestureAt: historyUserGestureAtRef.current,
          followBottom,
          requestedAt: performance.now(),
        };
        publishTerminalPreviewClearHandoff(pending);
        historyDiag('TERMINAL_PREVIEW_HANDOFF_REBASE tab=' + tabId.slice(-12)
          + ' provider=' + toolType
          + ' preview=' + pending.previewId.slice(-18)
          + ' identity=' + pending.canonicalIdentity.slice(-32)
          + ' presentationVisit=' + presentation.visit
          + ' source=' + source);
        return;
      }
      if (!historyTerminalPreviewHandoffOwnsWrite(pending, {
        ownerKey: historyOwnerKeyRef.current,
        ownerGeneration: historyOwnerGenerationRef.current,
        presentationVisit: presentation.visit,
        presented: presentation.presented,
      })) return;
      setTerminalPreviewHandoffWakeSeq((value) => value + 1);
      historyDiag('TERMINAL_PREVIEW_HANDOFF_WAKE tab=' + tabId.slice(-12)
        + ' provider=' + toolType
        + ' preview=' + pending.previewId.slice(-18)
        + ' identity=' + pending.canonicalIdentity.slice(-32)
        + ' source=' + source);
    });
  }, [publishTerminalPreviewClearHandoff, resolveTerminalPreviewCanonicalTarget, tabId, toolType]);

  useLayoutEffect(() => {
    terminalPreviewPresentationWakeRef.current = scheduleTerminalPreviewHandoffWake;
    return () => {
      if (terminalPreviewPresentationWakeRef.current === scheduleTerminalPreviewHandoffWake) {
        terminalPreviewPresentationWakeRef.current = null;
      }
    };
  }, [scheduleTerminalPreviewHandoffWake]);

  useEffect(() => () => {
    if (terminalPreviewHandoffWakeRafRef.current) {
      cancelAnimationFrame(terminalPreviewHandoffWakeRafRef.current);
      terminalPreviewHandoffWakeRafRef.current = 0;
    }
  }, []);

  // Terminal bytes can appear before Claude/Codex has materialized the
  // corresponding assistant record in JSONL. Main owns that provisional
  // evidence and publishes it separately from the durable transcript; keeping
  // it in the Virtuoso footer avoids rebuilding an 80k-row History array on
  // every terminal frame.
  useEffect(() => {
    if (!terminalHistoryStreamingEnabled
      || (toolType !== 'codex' && toolType !== 'claude')) {
      terminalPreviewAnchorSettleCancelRef.current?.();
      terminalPreviewAnchorSettleCancelRef.current = null;
      publishTerminalPreviewClearHandoff(null);
      terminalPreviewRef.current = null;
      setTerminalPreview(null);
      return;
    }
    let disposed = false;
    const acceptPreview = (incoming: any, source: 'event' | 'hydrate') => {
      if (disposed || !incoming || incoming.tabId !== tabId || incoming.toolType !== toolType) return;
      if (sessionId && incoming.sessionId && incoming.sessionId !== sessionId) {
        historyDiag('TERMINAL_PREVIEW_REJECT tab=' + tabId.slice(-12)
          + ' source=' + source
          + ' reason=session-mismatch'
          + ' incoming=' + String(incoming.sessionId).slice(0, 8)
          + ' owner=' + sessionId.slice(0, 8));
        return;
      }
      if (!String(incoming.text || '').trim()) return;
      const previous = terminalPreviewRef.current;
      if (previous?.previewId === incoming.previewId
        && Number(previous.previewSeq || 0) > Number(incoming.previewSeq || 0)) {
        historyDiag('TERMINAL_PREVIEW_REJECT tab=' + tabId.slice(-12)
          + ' source=' + source
          + ' reason=older-preview-sequence'
          + ' incomingSeq=' + String(incoming.previewSeq ?? '-')
          + ' currentSeq=' + previous.previewSeq);
        return;
      }
      if (previous?.previewId !== incoming.previewId
        && Number(previous?.startedAt || 0) > Number(incoming.startedAt || 0)) {
        historyDiag('TERMINAL_PREVIEW_REJECT tab=' + tabId.slice(-12)
          + ' source=' + source
          + ' reason=older-turn'
          + ' incoming=' + String(incoming.previewId || '').slice(-18)
          + ' current=' + String(previous?.previewId || '').slice(-18));
        return;
      }
      if (
        terminalPreviewClearHandoffRef.current
        && terminalPreviewClearHandoffRef.current.previewId !== incoming.previewId
      ) {
        terminalPreviewAnchorSettleCancelRef.current?.();
        terminalPreviewAnchorSettleCancelRef.current = null;
        publishTerminalPreviewClearHandoff(null);
      }
      terminalPreviewRef.current = incoming as TerminalHistoryPreview;
      setTerminalPreview(incoming as TerminalHistoryPreview);
      historyDiag('TERMINAL_PREVIEW_APPLY tab=' + tabId.slice(-12)
        + ' source=' + source
        + ' provider=' + toolType
        + ' preview=' + String(incoming.previewId || '').slice(-18)
        + ' seq=' + String(incoming.previewSeq ?? '-')
        + ' frame=' + String(incoming.committedFrameGeneration ?? '-')
        + ' writeSeq=' + String(incoming.writeSeq ?? '-')
        + ' phase=' + String(incoming.phase || '-')
        + ' chars=' + String(incoming.text?.length || 0)
        + ' hash=' + String(incoming.textHash || '-')
        + ' followBottom=' + (isAtBottomRef.current ? '1' : '0')
        + ' physicalPinned=' + (virtuosoScrollerRef.current
            ? (isHistoryTailPinned(virtuosoScrollerRef.current) ? '1' : '0')
            : 'na')
        + ' scrollTop=' + Math.round(virtuosoScrollerRef.current?.scrollTop || 0)
        + ' scrollHeight=' + Math.round(virtuosoScrollerRef.current?.scrollHeight || 0)
        + ' reason=' + String(incoming.reason || '-'));
    };
    const onTerminalPreview = (_event: any, detail: any) => {
      if (detail?.tabId !== tabId || detail?.toolType !== toolType) return;
      if (detail.action === 'clear') {
        const previous = terminalPreviewRef.current;
        const canonicalIdentity = String(detail.canonicalIdentity || '');
        if (
          previous
          && previous.previewId === detail.previewId
          && detail.reason === 'canonical-materialized'
          && canonicalIdentity
        ) {
          const scroller = virtuosoScrollerRef.current;
          const previewNode = panelRef.current?.querySelector(
            `[data-history-terminal-preview][data-preview-id="${CSS.escape(previous.previewId)}"]`,
          ) as HTMLElement | null;
          const followBottom = isAtBottomRef.current;
          const { anchorOffsetPx, bottomGapPx } = historyTerminalPreviewHandoffAnchor({
            followBottom,
            previewOffsetPx: scroller && previewNode
              ? previewNode.getBoundingClientRect().top - scroller.getBoundingClientRect().top
              : null,
            bottomGapPx: scroller
              ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
              : null,
          });
          const handoff: TerminalHistoryPreviewClearHandoff = {
            previewId: previous.previewId,
            canonicalIdentity,
            canonicalTextHash: typeof detail.canonicalTextHash === 'string'
              ? detail.canonicalTextHash
              : null,
            ownerKey: historyOwnerKeyRef.current,
            ownerGeneration: historyOwnerGenerationRef.current,
            presentationVisit: historyPresentationProofRef.current.visit,
            anchorOffsetPx,
            bottomGapPx,
            gestureGeneration: historyUserGestureGenerationRef.current,
            gestureAt: historyUserGestureAtRef.current,
            followBottom,
            scrollOwnerToken: null,
            phase: 'waiting-row',
            requestedAt: performance.now(),
          };
          terminalPreviewAnchorSettleCancelRef.current?.();
          terminalPreviewAnchorSettleCancelRef.current = null;
          publishTerminalPreviewClearHandoff(handoff);
          historyDiag('TERMINAL_PREVIEW_CLEAR_PENDING tab=' + tabId.slice(-12)
            + ' provider=' + toolType
            + ' preview=' + previous.previewId.slice(-18)
            + ' identity=' + canonicalIdentity.slice(-32)
            + ' anchor=' + (anchorOffsetPx === null ? 'na' : Math.round(anchorOffsetPx))
            + ' bottomGap=' + (bottomGapPx === null ? 'na' : Math.round(bottomGapPx))
            + ' follow=' + (followBottom ? '1' : '0'));
          return;
        }
        terminalPreviewAnchorSettleCancelRef.current?.();
        terminalPreviewAnchorSettleCancelRef.current = null;
        publishTerminalPreviewClearHandoff(null);
        if (!previous || previous.previewId === detail.previewId) {
          terminalPreviewRef.current = null;
          setTerminalPreview(null);
        }
        historyDiag('TERMINAL_PREVIEW_CLEAR tab=' + tabId.slice(-12)
          + ' provider=' + toolType
          + ' preview=' + String(detail.previewId || '').slice(-18)
          + ' reason=' + String(detail.reason || '-'));
        return;
      }
      acceptPreview(detail.preview, 'event');
    };
    ipcRenderer.on('agent-transcript:terminal-preview', onTerminalPreview);
    void ipcRenderer.invoke('agent-transcript:get-terminal-preview', {
      tabId,
      toolType,
    }).then((result: any) => {
      if (!disposed && result?.success === true && result.preview) {
        acceptPreview(result.preview, 'hydrate');
      }
    }).catch((error: any) => {
      historyDiag('TERMINAL_PREVIEW_HYDRATE_FAILED tab=' + tabId.slice(-12)
        + ' provider=' + toolType
        + ' error=' + String(error?.message || error));
    });
    return () => {
      disposed = true;
      ipcRenderer.removeListener('agent-transcript:terminal-preview', onTerminalPreview);
      terminalPreviewAnchorSettleCancelRef.current?.();
      terminalPreviewAnchorSettleCancelRef.current = null;
      publishTerminalPreviewClearHandoff(null);
      terminalPreviewRef.current = null;
      setTerminalPreview(null);
    };
  }, [
    publishTerminalPreviewClearHandoff,
    sessionId,
    tabId,
    terminalHistoryStreamingEnabled,
    toolType,
  ]);

  // Exact live-preview → canonical-row handoff. The preview is a Virtuoso Footer
  // so streaming updates stay O(1), while its canonical replacement is a data
  // row. Main publishes the handoff only after exact JSONL materialization; the
  // matching live projection may legitimately reach this list before the full
  // History refresh, which stays deferred during a busy turn. Swap on that exact
  // mounted identity, then retain its semantic row-top anchor through Virtuoso's
  // bounded late measurement window. A real user gesture always cancels it.
  useLayoutEffect(() => {
    const requested = terminalPreviewClearHandoff;
    if (!requested) return;

    let cancelled = false;
    let raf = 0;
    let attempts = 0;
    const tryCommit = () => {
      if (cancelled) return;
      let current = terminalPreviewClearHandoffRef.current;
      if (!current || current.previewId !== requested.previewId) return;
      const presentation = historyPresentationProofRef.current;
      const ownsWrite = historyTerminalPreviewHandoffOwnsWrite(current, {
        ownerKey: historyOwnerKeyRef.current,
        ownerGeneration: historyOwnerGenerationRef.current,
        presentationVisit: presentation.visit,
        presented: presentation.presented,
      });
      const canonicalTarget = resolveTerminalPreviewCanonicalTarget(
        current.canonicalIdentity,
      );
      const scroller = virtuosoScrollerRef.current;
      if (!scroller) return;
      const targetNode = canonicalTarget
        ? scroller.querySelector(
          `[data-history-row-real][data-history-row-owner="${CSS.escape(historyOwnerDomId)}"]`
            + `[data-uuid="${CSS.escape(canonicalTarget.domUuid)}"]`,
        ) as HTMLElement | null
        : null;
      const action = historyTerminalPreviewHandoffAction({
        handoff: current,
        ownsWrite,
        canonicalTarget,
        targetMounted: !!targetNode,
      });
      if (
        action === 'stale'
        || action === 'waiting-canonical'
      ) return;
      if (action === 'settling') {
        // This layout effect reran because the live/durable projection changed.
        // Repair its exact row before this commit paints; the rAF fallback is
        // one frame too late and produced the observed up/down flash.
        terminalPreviewAnchorSettleSignalRef.current?.();
        return;
      }
      if (action === 'waiting-mounted-range') {
        attempts += 1;
        if (attempts < HISTORY_TERMINAL_PREVIEW_DOM_PROBE_FRAMES) {
          raf = requestAnimationFrame(tryCommit);
        }
        else historyDiag('TERMINAL_PREVIEW_HANDOFF_WAIT tab=' + tabId.slice(-12)
          + ' preview=' + current.previewId.slice(-18)
          + ' identity=' + current.canonicalIdentity.slice(-32)
          + ' unit=' + canonicalTarget.unitIndex
          + ' presentation=' + canonicalTarget.presentationKind
          + ' reason=canonical-row-not-mounted');
        return;
      }
      if (!canonicalTarget) return;

      const previewNode = panelRef.current?.querySelector(
        `[data-history-terminal-preview][data-preview-id="${CSS.escape(current.previewId)}"]`,
      ) as HTMLElement | null;
      const newestGestureIsReal = historyTerminalPreviewHasNewUserGesture(current, {
        gestureGeneration: historyUserGestureGenerationRef.current,
        gestureAt: historyUserGestureAtRef.current,
        pointerActive: historyPointerScrollActiveRef.current,
      });
      if (
        current.phase === 'waiting-row'
        && newestGestureIsReal
        && previewNode
      ) {
        // The reader moved while canonical presentation was catching up. Their
        // newest offset wins; never drag them back to the pre-gesture frame.
        const followBottom = isAtBottomRef.current;
        const handoffAnchor = historyTerminalPreviewHandoffAnchor({
          followBottom,
          previewOffsetPx: previewNode.getBoundingClientRect().top
            - scroller.getBoundingClientRect().top,
          bottomGapPx: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
        });
        current = {
          ...current,
          ...handoffAnchor,
          gestureGeneration: historyUserGestureGenerationRef.current,
          gestureAt: historyUserGestureAtRef.current,
          followBottom,
        };
        publishTerminalPreviewClearHandoff(current);
      }

      if (action === 'clear-preview' && current.scrollOwnerToken === null) {
        const scrollOwnerToken = ++historyRestoreTokenRef.current;
        historyRestoreInFlightRef.current = scrollOwnerToken;
        current = { ...current, scrollOwnerToken };
        publishTerminalPreviewClearHandoff(current);
      }

      const preserveAnchor = (source: string) => {
        const latestPresentation = historyPresentationProofRef.current;
        if (!historyTerminalPreviewHandoffOwnsWrite(current, {
          ownerKey: historyOwnerKeyRef.current,
          ownerGeneration: historyOwnerGenerationRef.current,
          presentationVisit: latestPresentation.visit,
          presented: latestPresentation.presented,
        })) return false;
        const targetOffsetPx = targetNode
          ? targetNode.getBoundingClientRect().top - scroller.getBoundingClientRect().top
          : null;
        const before = scroller.scrollTop;
        const next = historyTerminalPreviewHandoffScrollTop({
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          targetOffsetPx,
          anchorOffsetPx: current.anchorOffsetPx,
          bottomGapPx: current.bottomGapPx,
        });
        scroller.scrollTop = next;
        if (Math.abs(next - before) > 0.5) {
          historyDiag('TERMINAL_PREVIEW_ANCHOR_WRITE tab=' + tabId.slice(-12)
            + ' preview=' + current.previewId.slice(-18)
            + ' source=' + source
            + ' before=' + Math.round(before)
            + ' after=' + Math.round(next)
            + ' target=' + (targetOffsetPx === null ? 'unmounted' : Math.round(targetOffsetPx))
            + ' anchor=' + (current.anchorOffsetPx === null
              ? 'bottom-gap' : Math.round(current.anchorOffsetPx))
            + ' max=' + Math.round(scroller.scrollHeight - scroller.clientHeight));
        }
        return true;
      };

      if (action === 'clear-preview') {
        // Do not align against the duplicate layout. At this point both the
        // durable data row and the Footer occupy space; its offsets are not the
        // final document and the production 13:42 incident clamped that
        // correction straight to the tail. This layout-state update is flushed
        // before paint; the next pass measures the one remaining durable row.
        const clearing = { ...current, phase: 'clearing-preview' as const };
        publishTerminalPreviewClearHandoff(clearing);
        terminalPreviewRef.current = null;
        setTerminalPreview(null);
        return;
      }

      if (action !== 'start-settle') return;
      if (!preserveAnchor(action)) return;
      const settling = { ...current, phase: 'settling-row' as const };
      publishTerminalPreviewClearHandoff(settling);
      terminalPreviewAnchorSettleCancelRef.current?.();
      terminalPreviewAnchorSettleCancelRef.current = null;

      const releaseScrollOwner = () => {
        if (
          settling.scrollOwnerToken !== null
          && historyRestoreInFlightRef.current === settling.scrollOwnerToken
        ) {
          historyRestoreInFlightRef.current = 0;
          historyScrollSeekController.stampMachineScrollCooldown();
        }
      };
      const finish = (outcome: {
        reason: string;
        frames: number;
        writes: number;
        maxDriftPx: number;
        positionSignals: number;
      }) => {
        releaseScrollOwner();
        terminalPreviewAnchorSettleCancelRef.current = null;
        if (terminalPreviewClearHandoffRef.current === settling) {
          publishTerminalPreviewClearHandoff(null);
        }
        historyDiag('TERMINAL_PREVIEW_HANDOFF_DONE tab=' + tabId.slice(-12)
          + ' provider=' + toolType
          + ' preview=' + settling.previewId.slice(-18)
          + ' identity=' + settling.canonicalIdentity.slice(-32)
          + ' uuid=' + canonicalTarget.canonicalUuid.slice(0, 8)
          + ' unit=' + canonicalTarget.unitIndex
          + ' presentation=' + canonicalTarget.presentationKind
          + ' elapsedMs=' + Math.round(performance.now() - settling.requestedAt)
          + ' attempts=' + attempts
          + ' anchor=' + (settling.anchorOffsetPx === null
            ? 'bottom-gap' : Math.round(settling.anchorOffsetPx))
          + ' follow=' + (settling.followBottom ? '1' : '0')
          + ' outcome=' + outcome.reason
          + ' frames=' + outcome.frames
          + ' writes=' + outcome.writes
          + ' positionSignals=' + outcome.positionSignals
          + ' maxDriftPx=' + Math.round(outcome.maxDriftPx));
      };

      if (settling.anchorOffsetPx === null) {
        finish({
          reason: 'bottom-gap',
          frames: 0,
          writes: 0,
          maxDriftPx: 0,
          positionSignals: 0,
        });
        return;
      }

      const settleOwnerKey = settling.ownerKey;
      const settleOwnerGeneration = settling.ownerGeneration;
      const settlePresentationVisit = settling.presentationVisit;
      const settleScroller = scroller;
      const readCanonicalTop = () => {
        const latestTarget = resolveTerminalPreviewCanonicalTarget(
          settling.canonicalIdentity,
        );
        if (!latestTarget) return null;
        const latestNode = settleScroller.querySelector(
          `[data-history-row-real][data-history-row-owner="${CSS.escape(historyOwnerDomId)}"]`
            + `[data-uuid="${CSS.escape(latestTarget.domUuid)}"]`,
        ) as HTMLElement | null;
        return latestNode
          ? latestNode.getBoundingClientRect().top
            - settleScroller.getBoundingClientRect().top
          : null;
      };
      const cancelSettle = stabilizeHistoryRevealAnchor({
        targetTop: settling.anchorOffsetPx,
        readAnchorTop: readCanonicalTop,
        adjustScrollBy: (delta: number, source: string) => {
          const before = settleScroller.scrollTop;
          settleScroller.scrollTop += delta;
          historyDiag('TERMINAL_PREVIEW_ANCHOR_WRITE tab=' + tabId.slice(-12)
            + ' preview=' + settling.previewId.slice(-18)
            + ' source=settle-' + source
            + ' delta=' + Math.round(delta)
            + ' before=' + Math.round(before)
            + ' after=' + Math.round(settleScroller.scrollTop));
        },
        subscribePositionChange: (listener: () => void) => {
          terminalPreviewAnchorSettleSignalRef.current = listener;
          settleScroller.addEventListener('scroll', listener, { capture: true, passive: true });
          return () => {
            settleScroller.removeEventListener('scroll', listener, true);
            if (terminalPreviewAnchorSettleSignalRef.current === listener) {
              terminalPreviewAnchorSettleSignalRef.current = null;
            }
          };
        },
        isCurrent: () => {
          const latestPresentation = historyPresentationProofRef.current;
          return settleScroller.isConnected
            && terminalPreviewClearHandoffRef.current === settling
            && historyOwnerKeyRef.current === settleOwnerKey
            && historyOwnerGenerationRef.current === settleOwnerGeneration
            && historyTerminalPreviewHandoffOwnsWrite(settling, {
              ownerKey: historyOwnerKeyRef.current,
              ownerGeneration: historyOwnerGenerationRef.current,
              presentationVisit: latestPresentation.visit,
              presented: latestPresentation.presented,
            })
            && latestPresentation.visit === settlePresentationVisit;
        },
        hasUserGesture: () => historyTerminalPreviewHasNewUserGesture(settling, {
          gestureGeneration: historyUserGestureGenerationRef.current,
          gestureAt: historyUserGestureAtRef.current,
          pointerActive: historyPointerScrollActiveRef.current,
        }),
        onFinish: finish,
      });
      terminalPreviewAnchorSettleCancelRef.current = cancelSettle;
    };
    tryCommit();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [
    displayEntries,
    displayUnits,
    historyOwnerDomId,
    historyScrollSeekController,
    publishTerminalPreviewClearHandoff,
    resolveTerminalPreviewCanonicalTarget,
    tabId,
    terminalPreviewClearHandoff,
    terminalPreviewHandoffWakeSeq,
    toolType,
    unitIndexByUuid,
  ]);

  useEffect(() => {
    const onTerminalPreviewDiagnosticResult = (_event: any, detail: any) => {
      if (detail?.tabId !== tabId || detail?.toolType !== toolType) return;
      if (detail?.success === true) {
        useUIStore.getState().showToast(
          'Diagnostics saved · reference copied',
          'success',
          2600,
          false,
          undefined,
          undefined,
          undefined,
          tabId,
        );
        return;
      }
      useUIStore.getState().showToast(
        'Could not save terminal diagnostics: ' + String(detail?.error || 'unknown error'),
        'error',
        5000,
        false,
        undefined,
        undefined,
        undefined,
        tabId,
      );
    };
    ipcRenderer.on(
      'agent-transcript:terminal-preview-diagnostic-result',
      onTerminalPreviewDiagnosticResult,
    );
    return () => {
      ipcRenderer.removeListener(
        'agent-transcript:terminal-preview-diagnostic-result',
        onTerminalPreviewDiagnosticResult,
      );
    };
  }, [tabId, toolType]);

  useLayoutEffect(() => {
    if (!terminalPreview || !isAtBottomRef.current) return;
    historyTailPinScheduler.schedule({
      shouldPin: true,
      delayFrames: 2,
      onApplied: (scroller: HTMLElement) => {
        historyDiag('TERMINAL_PREVIEW_PIN tab=' + tabId.slice(-12)
          + ' preview=' + terminalPreview.previewId.slice(-18)
          + ' seq=' + terminalPreview.previewSeq
          + ' scrollTop=' + Math.round(scroller.scrollTop));
      },
    });
  }, [historyTailPinScheduler, tabId, terminalPreview?.previewId, terminalPreview?.previewSeq]);

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
      const currentPreview = useUIStore.getState().historyRewindPreviews[tabId] || null;
      if (shouldClearRewindPreviewForDurableUser(currentPreview, {
        uuid: detail?.message?.uuid,
        type: detail?.message?.type,
        timestamp: detail?.timestamp,
        sessionId: detail?.sessionId,
      })) {
        setHistoryRewindPreview(tabId, null);
      }
      const promptOwner = detail?.promptOwner && typeof detail.promptOwner === 'object'
        ? detail.promptOwner
        : null;
      if (
        toolType === 'claude'
        && promptOwner?.deliveryStage === 'provider-queued'
        && typeof promptOwner.handoffId === 'string'
        && promptOwner.handoffId
      ) {
        const acceptedAt = Date.parse(String(detail?.timestamp || ''));
        acceptHistoryPromptHandoffProviderQueue(tabId, promptOwner.handoffId, {
          sendAttemptId: typeof promptOwner.sendAttemptId === 'string'
            ? promptOwner.sendAttemptId
            : null,
          sendOperationKey: typeof promptOwner.sendOperationKey === 'string'
            ? promptOwner.sendOperationKey
            : null,
          changedAt: Number.isFinite(acceptedAt) ? acceptedAt : Date.now(),
          proof: typeof promptOwner.sourceIdentity === 'string' && promptOwner.sourceIdentity
            ? {
                sourceIdentity: promptOwner.sourceIdentity,
                sessionId: typeof promptOwner.sessionId === 'string'
                  ? promptOwner.sessionId
                  : detail.sessionId,
                ...(typeof promptOwner.entryUuid === 'string' && promptOwner.entryUuid
                  ? { entryUuid: promptOwner.entryUuid }
                  : {}),
                ...(Number.isSafeInteger(Number(promptOwner.recordByteOffset))
                  && Number(promptOwner.recordByteOffset) >= 0
                  ? { recordByteOffset: Number(promptOwner.recordByteOffset) }
                  : {}),
              }
            : null,
        });
      }
      const current = liveProjectionRef.current.ownerKey === ownerKey
        ? liveProjectionRef.current.entries
        : [];
      const localHandoffs = Array.from(promptHandoffMetaRef.current.entries())
        .map(([handoffId, handoff]) => ({
          handoffId,
          auditEntryUuid: handoff.auditEntryUuid,
          sourceIdentity: handoff.sourceIdentity,
        }));
      // History-originated sends already own an optimistic prompt row. Native
      // xterm input has no such owner, so its canonical Claude or Codex user
      // record becomes the live row. Ownership is exact; equal text alone can
      // never hide a manual terminal message.
      const includeUserText = shouldIncludeHistoryLiveUserText({
        toolType,
        envelope: detail,
        localHandoffs,
        currentEntries: current,
      });
      const reduced = reduceHistoryLiveProjection(current, detail, {
        includeUserText,
      });
      let projectionChanged = reduced !== current;
      if (projectionChanged) {
        const alreadyPresentedLiveIdentities = new Set(
          current
            .flatMap((entry) => historyLivePresentationIdentities(entry)),
        );
        const projected = reduced
          .map((entry: FullHistoryEntry) => (
            entry.liveProjection ? entry : { ...entry, liveProjection: true }
          ))
          .filter((entry: FullHistoryEntry) => {
            const identities = historyLivePresentationIdentities(entry);
            return identities.length === 0
              || !identities.some((identity) => durableSourceIdentitiesRef.current.has(identity))
              || identities.some((identity) => alreadyPresentedLiveIdentities.has(identity));
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
      keepHistoryTailPinnedAfterMutation('live-message');
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
    keepHistoryTailPinnedAfterMutation,
    sessionId,
    setHistoryRewindPreview,
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
    const generation = historyOwnerGenerationRef.current;
    let disposed = false;
    const reportSubscribeSettled = (status: HistoryInitialSourceSignal['status']) => {
      if (
        disposed
        || historyOwnerKeyRef.current !== ownerKey
        || historyOwnerGenerationRef.current !== generation
      ) return;
      onInitialSourceSignalRef.current?.({
        tabId,
        sessionId,
        ownerKey,
        generation,
        phase: 'subscribe',
        status,
      });
    };
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
      reportSubscribeSettled(result?.success ? 'success' : 'failure');
    }).catch((e: any) => {
      historyDiag('TRANSCRIPT_SUBSCRIBE_ERROR tab=' + tabId.slice(-12) +
        ' session=' + sessionId.substring(0, 8) +
        ' tool=' + toolType +
        ' error=' + String(e?.message || e));
      reportSubscribeSettled('failure');
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
  const lastProgrammaticHistoryScrollRef = useRef<{
    uuid: string;
    doneAt: number;
    reason: string;
    scrollTop: number;
    userIntentLogged: boolean;
    scrollEventLogged: boolean;
  } | null>(null);
  const historyTouchYRef = useRef<number | null>(null);

  // ===== Mount wave: step machine =====
  // One step = pick the topmost mounted shell in (or nearest to) the
  // viewport, upgrade it to its real card in a startTransition commit, and
  // only after that commit is OBSERVED (layout effect + the arbiter's next
  // frame) ask for the next step. The explicit commit-ack is what keeps the
  // steps as SEPARATE tasks — React batches concurrent transitions, so a
  // free-running loop of transitions merges back into the single giant
  // commit this exists to break up.
  mountWaveStepRef.current = () => {
    const meta = mountWaveMetaRef.current;
    const lane = mountWaveLaneRef.current;
    if (!meta || !lane) { historyDiag('MOUNT_WAVE_SKIP reason=no-meta'); return; }
    if (meta.visitKey !== restoredLayoutVisitKeyRef.current) {
      historyDiag('MOUNT_WAVE_SKIP reason=visit meta=' + meta.visitKey.slice(-10)
        + ' now=' + restoredLayoutVisitKeyRef.current.slice(-10));
      return;
    }
    const renderState = mountWaveRenderStateRef.current;
    if (renderState.done || renderState.visitKey !== meta.visitKey) {
      historyDiag('MOUNT_WAVE_SKIP reason=render-state done=' + (renderState.done ? 1 : 0)
        + ' rs=' + renderState.visitKey.slice(-10));
      return;
    }
    if (meta.pendingStepUuids) return; // a step is already in flight
    // Scroll-seek replaces every row with its own placeholder — the DOM has
    // no shells to count, and "no shells" must not read as "wave drained"
    // (seek exit would then mount the whole viewport in one giant commit).
    if (historyScrollSeekController.isActive()) {
      // The seek-exit handoff below wakes this lane only after an exact real
      // wrapper (or mount-wave shell) has committed. Waking on the predicate's
      // `exit=true` return is too early: placeholders are still in the DOM.
      return;
    }
    const scroller = virtuosoScrollerRef.current;
    if (!scroller || !scroller.isConnected) return; // list gone; start effect re-arms
    const shellNodes = scroller.querySelectorAll(
      `[data-history-mount-shell][data-history-row-owner="${CSS.escape(historyOwnerDomId)}"]`,
    );
    if (shellNodes.length === 0) {
      // Zero shells is only "drained" when rows are actually MOUNTED. The
      // step's first run races Virtuoso's own multi-frame init: the arm
      // fires when the scroller attaches, but the row window can still be
      // empty — and treating that emptiness as done flipped every row to
      // real before any had mounted, restoring the exact one-giant-commit
      // this wave exists to prevent (live 05.08 04:38: DONE upgraded=0 on a
      // 2618-row visit, then all visible rows mounted real at once). An
      // empty window waits; rangeChanged re-arms when rows land.
      const anyOwnerRows = scroller.querySelectorAll(
        `[data-history-row-owner="${CSS.escape(historyOwnerDomId)}"]`,
      ).length;
      if (anyOwnerRows === 0) return;
      // Every MOUNTED shell is upgraded. Flip the rest in one commit: they
      // are unmounted (outside the render window), so the flip costs nothing
      // now, and rows mounting later render real directly.
      historyDiag('MOUNT_WAVE_DONE tab=' + tabId.slice(-12)
        + ' owner=' + historyOwnerDigest(historyOwnerKeyRef.current)
        + ' rows=' + meta.shellUuids.size
        + ' upgraded=' + meta.upgraded
        + ' steps=' + meta.steps
        + ' maxStepMs=' + Math.round(meta.maxStepMs)
        + ' elapsedMs=' + Math.round(performance.now() - meta.startedAt)
        + ' heights=' + meta.heightsFrom);
      meta.clearStepInterrupt?.();
      meta.clearStepInterrupt = null;
      meta.stepEndMark?.();
      meta.stepEndMark = null;
      meta.pendingStepToken = 0;
      startTransition(() => {
        setMountWaveRenderState((prev) => (
          prev.visitKey === meta.visitKey ? { ...prev, done: true } : prev
        ));
      });
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    let candidates = Array.from(shellNodes).map((node) => {
      const rect = (node as HTMLElement).getBoundingClientRect();
      return {
        uuid: (node as HTMLElement).getAttribute('data-uuid') || '',
        top: rect.top,
        bottom: rect.bottom,
      };
    }).filter((row) => row.uuid);
    const targets: string[] = [];
    // A Timeline jump aimed at a still-shell row hydrates first: its
    // convergence loop refuses to declare the jump done on a shell, so the
    // wave owes it the real card before anything else.
    const jumpUuid = historyScrollInFlightRef.current?.uuid;
    if (jumpUuid && candidates.some((row) => row.uuid === jumpUuid)) {
      targets.push(jumpUuid);
      candidates = candidates.filter((row) => row.uuid !== jumpUuid);
    }
    while (targets.length < meta.batchSize && candidates.length > 0) {
      const picked = pickHistoryMountWaveTarget(
        candidates,
        { top: scrollerRect.top, bottom: scrollerRect.bottom },
      );
      if (!picked) break;
      targets.push(picked);
      candidates = candidates.filter((row) => row.uuid !== picked);
    }
    if (targets.length === 0) return;
    meta.stepStartedAt = performance.now();
    meta.pendingStepUuids = targets;
    const stepToken = ++mountWaveStepSequenceRef.current;
    meta.pendingStepToken = stepToken;
    // Tail-pin capture BEFORE the commit: an exact-height shell swap should
    // not move the tail, but sub-pixel rounding across many rows can drift
    // it — same protection the Timeline expand wave uses.
    meta.keepBottom = isHistoryAtContentBottom(scroller);
    if (!meta.loggedStart) {
      meta.loggedStart = true;
      historyDiag('MOUNT_WAVE_START tab=' + tabId.slice(-12)
        + ' owner=' + historyOwnerDigest(historyOwnerKeyRef.current)
        + ' rows=' + meta.shellUuids.size
        + ' mountedShells=' + shellNodes.length
        + ' heights=' + meta.heightsFrom);
    }
    meta.stepEndMark?.();
    meta.stepEndMark = markRendererActivity('history-mount-wave:' + tabId.slice(-8));
    meta.clearStepInterrupt?.();
    meta.clearStepInterrupt = null;
    if (!historyPresentationProofRef.current.presented) {
      meta.clearStepInterrupt = historyForegroundPriority.registerInterruptibleBackgroundWork(
        'history-mount-wave:' + tabId,
        () => {
          const current = mountWaveMetaRef.current;
          if (
            current !== meta
            || current.pendingStepToken !== stepToken
            || historyPresentationProofRef.current.presented
          ) return;
          current.pendingStepToken = 0;
          current.pendingStepUuids = null;
          current.clearStepInterrupt = null;
          current.stepEndMark?.();
          current.stepEndMark = null;
          historyDiag('MOUNT_WAVE_PREEMPT tab=' + tabId.slice(-12)
            + ' owner=' + historyOwnerDigest(historyOwnerKeyRef.current)
            + ' targets=' + targets.length
            + ' reason=foreground-wheel');
          // An urgent no-content-change state write invalidates any in-flight
          // transition render. Its updater below sees the cleared token and
          // cannot rebase the stale real-row upgrade onto this commit.
          setMountWaveRenderState((prev) => (
            prev.visitKey === meta.visitKey
              ? { ...prev, interruptEpoch: prev.interruptEpoch + 1 }
              : prev
          ));
          requestHistoryMountWaveStep(lane);
        },
      );
    }
    startTransition(() => {
      setMountWaveRenderState((prev) => {
        if (
          prev.visitKey !== meta.visitKey
          || prev.done
          || meta.pendingStepToken !== stepToken
        ) return prev;
        const nextReal = new Set(prev.realUuids);
        for (const uuid of targets) nextReal.add(uuid);
        return { ...prev, realUuids: nextReal };
      });
    });
  };

  // Wave lifecycle: register the lane, start the wave on the commit that
  // mounts the shell list, acknowledge each step's commit, and bank geometry
  // once at wave-done (unless a restore hunt still owns the scroller — then
  // its settle does the one save; see settleRestoreAndBankGeometry).
  useEffect(() => {
    const lane = mountWaveLaneRef.current;
    if (!lane) return;
    historyMountWaveLanes.add(lane);
    return () => {
      historyMountWaveLanes.delete(lane);
      const meta = mountWaveMetaRef.current;
      meta?.clearStepInterrupt?.();
      if (meta) meta.clearStepInterrupt = null;
      meta?.stepEndMark?.();
      if (meta) meta.stepEndMark = null;
    };
  }, []);
  useLayoutEffect(() => {
    const meta = mountWaveMetaRef.current;
    const lane = mountWaveLaneRef.current;
    if (!meta || !lane || meta.visitKey !== mountWaveRenderState.visitKey) return;
    if (mountWaveRenderState.done) {
      // Bank geometry exactly once per visit, at the drain commit. Later
      // re-runs of this effect (live appends change other deps) must not
      // re-save, and a restore hunt still holding the scroller owns the one
      // save instead (its settle checks the wave flag symmetrically).
      if (meta.bankedDone) return;
      meta.bankedDone = true;
      meta.pendingStepUuids = null;
      const presentation = historyPresentationProofRef.current;
      if (!presentation.presented) {
        historyDiag('LAYOUT_SAVE_SKIP tab=' + tabId.slice(-12)
          + ' at=wave-done reason=not-presented visit=' + presentation.visit);
        return;
      }
      if (historyRestoreInFlightRef.current) return;
      const layoutKey = historyOwnerKeyRef.current;
      const layoutItemKeys = displayUnitLayoutKeysRef.current;
      const layoutItems = layoutItemKeys.length;
      try {
        virtuosoRef.current?.getState((snapshot) => {
          if (historyOwnerKeyRef.current !== layoutKey) return;
          if (!historyPresentationOwnsWrite(
            historyPresentationProofRef.current,
            presentation.visit,
          )) return;
          const saved = saveHistoryMeasuredLayout(layoutKey, snapshot as any, layoutItemKeys);
          if (saved) {
            historyDiag('LAYOUT_SAVE tab=' + tabId.slice(-12)
              + ' owner=' + historyOwnerDigest(layoutKey)
              + ' ranges=' + ((snapshot as any)?.ranges?.length ?? 0)
              + ' items=' + layoutItems
              + ' at=wave-done');
          }
        });
      } catch { /* geometry is optional */ }
      return;
    }
    if (meta.pendingStepUuids) {
      // This effect re-runs on unrelated commits too (live appends change
      // deps). Only the commit that actually CONTAINS the step's upgrade set
      // acknowledges the step — anything else is not our transition landing.
      const landed = meta.pendingStepUuids.every(
        (uuid) => mountWaveRenderState.realUuids.has(uuid),
      );
      if (!landed) return;
      const stepMs = performance.now() - meta.stepStartedAt;
      meta.steps += 1;
      meta.upgraded += meta.pendingStepUuids.length;
      meta.clearStepInterrupt?.();
      meta.clearStepInterrupt = null;
      meta.stepEndMark?.();
      meta.stepEndMark = null;
      meta.pendingStepToken = 0;
      meta.maxStepMs = Math.max(meta.maxStepMs, stepMs);
      meta.pendingStepUuids = null;
      // One unknown row first; grow to 3 only while steps stay cheap, drop
      // back to 1 the moment a step blows the budget (a monster markdown/diff
      // card) — the audit's hard requirement, since three ordinary visible
      // rows measured 726ms in one commit.
      if (stepMs > 50) meta.batchSize = 1;
      else if (stepMs < 24) meta.batchSize = Math.min(3, meta.batchSize + 1);
      // Tail re-pin after the step — but never while a restore convergence
      // loop owns the scroller (it re-jumps every frame itself; two writers
      // is the exact fight the restore token exists to prevent).
      if (meta.keepBottom && !historyRestoreInFlightRef.current) {
        const scroller = virtuosoScrollerRef.current;
        if (scroller && !isHistoryAtContentBottom(scroller)) {
          scroller.scrollTop = Math.max(
            0,
            scroller.scrollHeight - scroller.clientHeight,
          );
        }
      }
      requestHistoryMountWaveStep(lane);
      return;
    }
    // No step in flight, wave not done: (re-)arm. Covers the first eligible
    // commit of the visit (shells just mounted) and any later commit that
    // finds the wave stalled (seek pause whose exit listener was lost to an
    // owner switch, HMR replay). Re-arming while idle is harmless — the step
    // itself no-ops when nothing needs doing.
    if (virtuosoScrollerRef.current?.isConnected) {
      historyDiag('MOUNT_WAVE_ARM tab=' + tabId.slice(-12)
        + ' visit=' + mountWaveRenderState.visitKey.slice(-10));
      requestHistoryMountWaveStep(lane);
    } else {
      historyDiag('MOUNT_WAVE_ARM_SKIP tab=' + tabId.slice(-12) + ' scroller=none');
    }
  }, [mountWaveRenderState, mountWaveActive, surfaceLoading, displayEntries.length, tabId]);
  useEffect(() => {
    // React StrictMode and Fast Refresh both run cleanup before installing the
    // same effect again while preserving refs. Re-arm the liveness proof in
    // setup; otherwise every later Timeline click starts a convergence loop
    // that exits before its first animation frame.
    scrollMountedRef.current = true;
    return () => {
      scrollMountedRef.current = false;
      historyScrollInFlightRef.current = null;
      historyJumpHydrationActiveRef.current = false;
      scrollGenRef.current++;
    };
  }, []);

  const cancelHistoryScrollFromUser = useCallback((reason: string) => {
    const inFlight = historyScrollInFlightRef.current;
    if (!inFlight) return false;
    if (!scrollMountedRef.current || scrollGenRef.current !== inFlight.gen) {
      historyScrollInFlightRef.current = null;
      historyJumpHydrationActiveRef.current = false;
      return false;
    }
    scrollGenRef.current++;
    historyScrollInFlightRef.current = null;
    historyJumpHydrationActiveRef.current = false;
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

  const cancelHistoryScrollTraceScheduledWork = useCallback((
    trace: HistoryScrollGestureTrace,
  ) => {
    if (trace.settleTimer !== null) clearTimeout(trace.settleTimer);
    if (trace.motionRaf !== null) cancelAnimationFrame(trace.motionRaf);
    if (trace.finishRaf !== null) cancelAnimationFrame(trace.finishRaf);
    if (trace.postPaintRaf !== null) cancelAnimationFrame(trace.postPaintRaf);
    trace.settleTimer = null;
    trace.motionRaf = null;
    trace.finishRaf = null;
    trace.postPaintRaf = null;
  }, []);

  const logHistoryScrollTraceFrame = useCallback((
    trace: HistoryScrollGestureTrace,
    phase: string,
  ) => {
    const scroller = virtuosoScrollerRef.current;
    if (!scroller?.isConnected) return;
    const now = performance.now();
    const snapshot = captureHistoryScrollTraceDomSnapshot(scroller);
    const proof = historyPresentationProofRef.current;
    const roundTenth = (value: number | null) => value === null
      ? 'na'
      : String(Math.round(value * 10) / 10);
    historyDiag('SCROLL_GESTURE_FRAME tab=' + tabId.slice(-12)
      + ' gid=' + trace.id
      + ' phase=' + phase
      + ' ageMs=' + Math.round(now - trace.startedAt)
      + ' sinceInputMs=' + Math.round(now - trace.lastInputAt)
      + ' wheels=' + trace.wheelEvents
      + ' scrolls=' + trace.scrollEvents
      + ' scrollTop=' + roundTenth(snapshot.scrollTop)
      + ' deltaFromBegin=' + roundTenth(snapshot.scrollTop - trace.baselineScrollTop)
      + ' scrollHeight=' + Math.round(snapshot.scrollHeight)
      + ' clientHeight=' + Math.round(snapshot.clientHeight)
      + ' range=' + visibleRangeRef.current.start + '-' + visibleRangeRef.current.end
      + ' topUuid=' + (snapshot.topUuid ? snapshot.topUuid.slice(-12) : '-')
      + ' topPx=' + roundTenth(snapshot.topPx)
      + ' topH=' + roundTenth(snapshot.topHeight)
      + ' topShell=' + (snapshot.topShell ? '1' : '0')
      + ' topStub=' + (snapshot.topStub ? '1' : '0')
      + ' domRows=' + snapshot.domRows
      + ' shells=' + snapshot.shells
      + ' stubs=' + snapshot.stubs
      + ' follow=' + (isAtBottomRef.current ? '1' : '0')
      + ' seek=' + (historyScrollSeekController.isActive() ? '1' : '0')
      + ' restore=' + (historyRestoreInFlightRef.current ? '1' : '0')
      + ' jump=' + (historyScrollInFlightRef.current?.uuid?.slice(-12) || '-')
      + ' hydration=' + (hydrationRequestInFlightRef.current ? '1' : '0')
      + ' wave=' + (mountWaveActiveRef.current ? '1' : '0')
      + ' pointer=' + (historyPointerScrollActiveRef.current ? '1' : '0')
      + ' gestureGen=' + historyUserGestureGenerationRef.current
      + ' presented=' + (proof.presented ? '1' : '0')
      + ' visit=' + proof.visit);
  }, [historyScrollSeekController, tabId]);

  const finishHistoryScrollGestureTrace = useCallback((
    trace: HistoryScrollGestureTrace,
    reason: string,
  ) => {
    if (historyScrollGestureTraceRef.current !== trace) return;
    cancelHistoryScrollTraceScheduledWork(trace);
    logHistoryScrollTraceFrame(trace, 'idle');
    trace.finishRaf = requestAnimationFrame(() => {
      trace.finishRaf = null;
      if (historyScrollGestureTraceRef.current !== trace) return;
      logHistoryScrollTraceFrame(trace, 'raf');
      trace.postPaintRaf = requestAnimationFrame(() => {
        trace.postPaintRaf = null;
        if (historyScrollGestureTraceRef.current !== trace) return;
        logHistoryScrollTraceFrame(trace, 'post-paint');
        const scroller = virtuosoScrollerRef.current;
        historyDiag('SCROLL_GESTURE_END tab=' + tabId.slice(-12)
          + ' gid=' + trace.id
          + ' reason=' + reason
          + ' durationMs=' + Math.round(performance.now() - trace.startedAt)
          + ' wheels=' + trace.wheelEvents
          + ' scrolls=' + trace.scrollEvents
          + ' totalDeltaY=' + Math.round(trace.totalDeltaY * 10) / 10
          + ' deltaTop=' + Math.round(((scroller?.scrollTop || 0) - trace.baselineScrollTop) * 10) / 10
          + ' motionFrames=' + trace.motionFrames
          + ' droppedWheels=' + trace.droppedWheelEvents
          + ' droppedScrolls=' + trace.droppedScrollEvents);
        historyScrollGestureTraceRef.current = null;
      });
    });
  }, [cancelHistoryScrollTraceScheduledWork, logHistoryScrollTraceFrame, tabId]);

  const scheduleHistoryScrollGestureTraceFinish = useCallback((
    trace: HistoryScrollGestureTrace,
  ) => {
    if (trace.settleTimer !== null) clearTimeout(trace.settleTimer);
    trace.settleTimer = setTimeout(() => {
      trace.settleTimer = null;
      finishHistoryScrollGestureTrace(trace, 'quiet');
    }, HISTORY_SCROLL_TRACE_QUIET_MS);
  }, [finishHistoryScrollGestureTrace]);

  const traceHistoryWheelInput = useCallback((event: WheelEvent) => {
    if (!event.isTrusted || !historyPresentationProofRef.current.presented) return;
    const scroller = virtuosoScrollerRef.current;
    if (!scroller?.isConnected) return;
    const now = performance.now();
    let trace = historyScrollGestureTraceRef.current;
    if (!trace && event.deltaY >= 0) return; // current production incident is upward only
    if (trace && now - trace.lastActivityAt > 1000) {
      cancelHistoryScrollTraceScheduledWork(trace);
      historyDiag('SCROLL_GESTURE_END tab=' + tabId.slice(-12)
        + ' gid=' + trace.id
        + ' reason=superseded'
        + ' durationMs=' + Math.round(now - trace.startedAt)
        + ' wheels=' + trace.wheelEvents
        + ' scrolls=' + trace.scrollEvents
        + ' droppedWheels=' + trace.droppedWheelEvents
        + ' droppedScrolls=' + trace.droppedScrollEvents);
      historyScrollGestureTraceRef.current = null;
      trace = null;
    }
    if (!trace) {
      trace = {
        id: ++historyScrollTraceSequenceRef.current,
        startedAt: now,
        lastInputAt: now,
        lastActivityAt: now,
        baselineScrollTop: scroller.scrollTop,
        lastScrollTop: scroller.scrollTop,
        totalDeltaY: 0,
        wheelEvents: 0,
        scrollEvents: 0,
        loggedWheelEvents: 0,
        loggedScrollEvents: 0,
        motionFrames: 0,
        lastMotionFrameAt: 0,
        droppedWheelEvents: 0,
        droppedScrollEvents: 0,
        settleTimer: null,
        motionRaf: null,
        finishRaf: null,
        postPaintRaf: null,
      };
      historyScrollGestureTraceRef.current = trace;
      historyDiag('SCROLL_GESTURE_BEGIN tab=' + tabId.slice(-12)
        + ' gid=' + trace.id
        + ' eventTs=' + Math.round(event.timeStamp * 10) / 10
        + ' receivedAbs=' + Math.round(performance.timeOrigin + now)
        + ' inputDelayMs=' + Math.max(0, Math.round((now - event.timeStamp) * 10) / 10)
        + ' deltaY=' + Math.round(event.deltaY * 10) / 10
        + ' deltaMode=' + event.deltaMode
        + ' scrollTop=' + Math.round(scroller.scrollTop * 10) / 10);
      logHistoryScrollTraceFrame(trace, 'before');
    } else {
      // A new wheel arrived while the quiet-frame proof was pending. Keep the
      // same gesture, cancel those frames and wait for the new physical end.
      if (trace.finishRaf !== null) cancelAnimationFrame(trace.finishRaf);
      if (trace.postPaintRaf !== null) cancelAnimationFrame(trace.postPaintRaf);
      trace.finishRaf = null;
      trace.postPaintRaf = null;
    }
    trace.lastInputAt = now;
    trace.lastActivityAt = now;
    trace.totalDeltaY += event.deltaY;
    trace.wheelEvents += 1;
    if (trace.loggedWheelEvents < HISTORY_SCROLL_TRACE_MAX_WHEEL_EVENTS) {
      trace.loggedWheelEvents += 1;
      historyDiag('SCROLL_GESTURE_INPUT tab=' + tabId.slice(-12)
        + ' gid=' + trace.id
        + ' seq=' + trace.wheelEvents
        + ' deltaY=' + Math.round(event.deltaY * 10) / 10
        + ' deltaMode=' + event.deltaMode
        + ' scrollTop=' + Math.round(scroller.scrollTop * 10) / 10
        + ' range=' + visibleRangeRef.current.start + '-' + visibleRangeRef.current.end);
    } else {
      trace.droppedWheelEvents += 1;
    }
    scheduleHistoryScrollGestureTraceFinish(trace);
  }, [
    cancelHistoryScrollTraceScheduledWork,
    logHistoryScrollTraceFrame,
    scheduleHistoryScrollGestureTraceFinish,
    tabId,
  ]);

  const traceHistoryScrollEvent = useCallback((scroller: HTMLElement) => {
    const trace = historyScrollGestureTraceRef.current;
    if (!trace) return;
    const now = performance.now();
    const deltaTop = scroller.scrollTop - trace.lastScrollTop;
    trace.lastScrollTop = scroller.scrollTop;
    trace.lastActivityAt = now;
    trace.scrollEvents += 1;
    if (trace.loggedScrollEvents < HISTORY_SCROLL_TRACE_MAX_SCROLL_EVENTS) {
      trace.loggedScrollEvents += 1;
      historyDiag('SCROLL_GESTURE_SCROLL tab=' + tabId.slice(-12)
        + ' gid=' + trace.id
        + ' seq=' + trace.scrollEvents
        + ' ageMs=' + Math.round(now - trace.startedAt)
        + ' sinceInputMs=' + Math.round(now - trace.lastInputAt)
        + ' deltaTop=' + Math.round(deltaTop * 10) / 10
        + ' scrollTop=' + Math.round(scroller.scrollTop * 10) / 10
        + ' range=' + visibleRangeRef.current.start + '-' + visibleRangeRef.current.end);
    } else {
      trace.droppedScrollEvents += 1;
    }
    if (
      trace.motionRaf === null
      && trace.motionFrames < HISTORY_SCROLL_TRACE_MAX_MOTION_FRAMES
      && now - trace.lastMotionFrameAt >= HISTORY_SCROLL_TRACE_MOTION_INTERVAL_MS
    ) {
      trace.lastMotionFrameAt = now;
      trace.motionRaf = requestAnimationFrame(() => {
        trace.motionRaf = null;
        if (historyScrollGestureTraceRef.current !== trace) return;
        trace.motionFrames += 1;
        logHistoryScrollTraceFrame(trace, 'motion-' + trace.motionFrames);
      });
    }
    scheduleHistoryScrollGestureTraceFinish(trace);
  }, [logHistoryScrollTraceFrame, scheduleHistoryScrollGestureTraceFinish, tabId]);

  useEffect(() => () => {
    const trace = historyScrollGestureTraceRef.current;
    if (trace) cancelHistoryScrollTraceScheduledWork(trace);
    historyScrollGestureTraceRef.current = null;
  }, [cancelHistoryScrollTraceScheduledWork, tabId]);

  const setHistorySeekGeometryMask = useCallback((
    scroller: HTMLElement | null,
    active: boolean,
  ) => {
    if (!scroller) return;
    if (active) scroller.setAttribute('data-history-seek-geometry-settling', '1');
    else {
      if (historySeekGeometryMaskReleaseTimerRef.current !== null) {
        clearTimeout(historySeekGeometryMaskReleaseTimerRef.current);
        historySeekGeometryMaskReleaseTimerRef.current = null;
      }
      scroller.removeAttribute('data-history-seek-geometry-settling');
    }
  }, []);

  const restoreHistoryWheelGeometryRows = useCallback(() => {
    const state = historyWheelGeometryFreezeRef.current;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    state.observer?.disconnect();
    state.observer = null;
    for (const [row, previous] of state.rows) {
      row.style.height = previous.height;
      row.style.minHeight = previous.minHeight;
      row.style.maxHeight = previous.maxHeight;
      row.style.overflow = previous.overflow;
    }
    state.rows.clear();
    state.scroller = null;
    state.pendingSeekExit = false;
    state.seekExitAnchor = null;
  }, []);

  const captureHistoryWheelGeometryAnchor = useCallback((
    scroller: HTMLElement,
    source: 'real' | 'seek',
  ) => {
    const scrollerRect = scroller.getBoundingClientRect();
    const nodes = source === 'seek'
      ? Array.from(scroller.querySelectorAll<HTMLElement>('[data-history-seek-key]'))
      : Array.from(scroller.querySelectorAll<HTMLElement>('[data-item-index]'));
    const candidates = nodes.map((node) => {
      const index = Number(source === 'seek'
        ? node.getAttribute('data-history-seek-index')
        : node.getAttribute('data-item-index'));
      const identity = source === 'seek'
        ? node.getAttribute('data-history-seek-key') || ''
        : displayUnitItemKeysRef.current[index] || '';
      const rect = node.getBoundingClientRect();
      return { identity, top: rect.top, bottom: rect.bottom };
    });
    const anchor = pickHistoryGestureAnchorCandidate(
      candidates,
      scrollerRect.top,
      scrollerRect.bottom,
    );
    return anchor
      ? {
        identity: anchor.identity,
        top: Number(anchor.top) - scrollerRect.top,
        bottomGap: Math.max(
          0,
          scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
        ),
      }
      : null;
  }, []);

  const measureHistoryWheelGeometryRelease = useCallback((identity: string) => {
    const anchorIndex = findHistoryUnitIndexByKey(displayUnitItemKeysRef.current, identity);
    if (anchorIndex < 0) return { trailingHeightDelta: 0, measuredRows: 0 };
    const state = historyWheelGeometryFreezeRef.current;
    let trailingHeightDelta = 0;
    let measuredRows = 0;
    for (const [row, previous] of state.rows) {
      if (!row.isConnected || (state.scroller && !state.scroller.contains(row))) continue;
      const index = Number(row.getAttribute('data-item-index'));
      if (!Number.isFinite(index) || index < anchorIndex) continue;
      const realRow = row.querySelector<HTMLElement>('[data-history-row-real]');
      const currentHeight = realRow?.getBoundingClientRect().height;
      if (!Number.isFinite(currentHeight) || Number(currentHeight) <= 0) continue;
      trailingHeightDelta += Number(currentHeight) - previous.frozenHeight;
      measuredRows += 1;
    }
    return { trailingHeightDelta, measuredRows };
  }, []);

  const readHistoryWheelGeometryAnchorTop = useCallback((
    scroller: HTMLElement,
    identity: string,
    requireReal: boolean,
  ) => {
    if (!scroller.isConnected) return null;
    const index = findHistoryUnitIndexByKey(displayUnitItemKeysRef.current, identity);
    if (index < 0) return null;
    const wrapper = scroller.querySelector<HTMLElement>(
      `[data-item-index="${CSS.escape(String(index))}"]`,
    );
    if (!wrapper || (requireReal && !wrapper.querySelector('[data-history-row-real]'))) return null;
    return wrapper.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, []);

  const settleHistoryWheelGeometryRelease = useCallback(({
    scroller,
    identity,
    targetTop,
    ownerKey,
    ownerGeneration,
    presentationVisit,
    gestureGeneration,
    source,
    bottomGap,
  }: {
    scroller: HTMLElement;
    identity: string;
    targetTop: number;
    ownerKey: string;
    ownerGeneration: number;
    presentationVisit: number;
    gestureGeneration: number;
    source: 'slow-real' | 'seek-exit' | 'hydration-apply';
    bottomGap: number;
  }) => {
    const releaseMeasurement = measureHistoryWheelGeometryRelease(identity);
    const anchorMode = chooseHistoryGestureReleaseAnchorMode({
      bottomGapPx: bottomGap,
      trailingHeightDeltaPx: releaseMeasurement.trailingHeightDelta,
      measuredRows: releaseMeasurement.measuredRows,
    });
    if (source === 'seek-exit') setHistorySeekGeometryMask(scroller, true);
    restoreHistoryWheelGeometryRows();
    setHistorySeekPresentationEpoch((value) => value + 1);
    const ownsRelease = () => (
      scroller.isConnected
      && historyOwnerKeyRef.current === ownerKey
      && historyOwnerGenerationRef.current === ownerGeneration
      && findHistoryUnitIndexByKey(displayUnitItemKeysRef.current, identity) >= 0
      && historyPresentationOwnsWrite(
        historyPresentationProofRef.current,
        presentationVisit,
      )
    );
    let bridgeWritesLogged = 0;
    let cancel = () => {};
    cancel = settleHistoryVisualAnchor({
      targetTop,
      readVisualTop: () => readHistoryWheelGeometryAnchorTop(scroller, identity, true),
      setVisualOffset: (offset: number, positionSource: string) => {
        scroller.setAttribute('data-history-geometry-bridge', '1');
        scroller.style.setProperty('--hp-history-geometry-bridge-y', offset + 'px');
        if (bridgeWritesLogged >= 6) return;
        bridgeWritesLogged += 1;
        historyDiag('WHEEL_GEOMETRY_BRIDGE_WRITE tab=' + historyTabIdRef.current.slice(-12)
          + ' key=' + identity.slice(-24)
          + ' path=' + source
          + ' source=' + positionSource
          + ' offset=' + Math.round(offset * 10) / 10);
      },
      canCommitVisualOffset: (offset: number) => {
        if (anchorMode === 'tail-gap') return true;
        const desiredTop = scroller.scrollTop - offset;
        // CSS translate participates in scroll overflow: a negative bridge
        // temporarily shortens the reported range by the same amount. Predict
        // the unbridged range instead of waiting forever for an impossible
        // `scrollHeight` while the bridge itself is active.
        const maxTop = Math.max(
          0,
          scroller.scrollHeight - scroller.clientHeight - offset,
        );
        return desiredTop >= -0.5 && desiredTop <= maxTop + 0.5;
      },
      commitVisualOffset: (offset: number, reason: string) => {
        const before = scroller.scrollTop;
        let delta = 0;
        // Clear the presentation transform first so the browser restores the
        // full physical scroll range; the following scroll write is in the
        // same JS task, therefore no unbridged intermediate frame can paint.
        scroller.removeAttribute('data-history-geometry-bridge');
        scroller.style.removeProperty('--hp-history-geometry-bridge-y');
        if (ownsRelease() && reason !== 'stale-owner') {
          if (anchorMode === 'tail-gap') {
            const desiredTop = Math.max(
              0,
              scroller.scrollHeight - scroller.clientHeight - Math.max(0, bottomGap),
            );
            scroller.scrollTop = desiredTop;
            delta = scroller.scrollTop - before;
          } else if (Math.abs(offset) > 0.01) {
            // Removing translate(offset) and scrolling by -offset are one
            // presentation transaction: the semantic row stays on the same
            // screen pixel, but the real scroller resumes as sole owner.
            scroller.scrollTop -= offset;
            delta = scroller.scrollTop - before;
          }
        }
        historyDiag('WHEEL_GEOMETRY_RELEASE_WRITE tab=' + historyTabIdRef.current.slice(-12)
          + ' key=' + identity.slice(-24)
          + ' path=' + source
          + ' anchorMode=' + anchorMode
          + ' source=bridge-commit'
          + ' reason=' + reason
          + ' delta=' + Math.round(delta * 10) / 10
          + ' before=' + Math.round(before * 10) / 10
          + ' after=' + Math.round(scroller.scrollTop * 10) / 10);
      },
      subscribeGeometryChange: (listener: () => void) => {
        const list = scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
        const resizeObserver = list ? new ResizeObserver(listener) : null;
        if (list) resizeObserver?.observe(list);
        const mutationObserver = list ? new MutationObserver(listener) : null;
        if (list) {
          mutationObserver?.observe(list, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-known-size'],
          });
        }
        scroller.addEventListener('scroll', listener, { capture: true, passive: true });
        return () => {
          resizeObserver?.disconnect();
          mutationObserver?.disconnect();
          scroller.removeEventListener('scroll', listener, true);
        };
      },
      isCurrent: ownsRelease,
      isPaused: () => (
        historyRestoreInFlightRef.current !== 0
        || historyScrollInFlightRef.current !== null
        || (source !== 'hydration-apply' && hydrationRequestInFlightRef.current)
        || historyScrollSeekController.isActive()
        || historyPointerScrollActiveRef.current
        || terminalPreviewAnchorSettleCancelRef.current !== null
      ),
      hasUserGesture: () => historyUserGestureGenerationRef.current !== gestureGeneration,
      onFinish: (outcome: any) => {
        if (historyWheelGeometryReleaseSettleCancelRef.current === cancel) {
          historyWheelGeometryReleaseSettleCancelRef.current = null;
        }
        const transferredToNewGesture = source === 'seek-exit'
          && (
            outcome.reason === 'user-gesture'
            || (outcome.reason === 'cancelled' && historyScrollSeekController.isActive())
          );
        if (source === 'seek-exit' && !transferredToNewGesture) {
          setHistorySeekGeometryMask(scroller, false);
        }
        historyDiag('WHEEL_GEOMETRY_RELEASE_DONE tab=' + historyTabIdRef.current.slice(-12)
          + ' key=' + identity.slice(-24)
          + ' path=' + source
          + ' anchorMode=' + anchorMode
          + ' trailingDelta=' + Math.round(releaseMeasurement.trailingHeightDelta * 10) / 10
          + ' measuredRows=' + releaseMeasurement.measuredRows
          + ' reason=' + outcome.reason
          + ' frames=' + outcome.frames
          + ' writes=' + outcome.writes
          + ' corrections=' + outcome.corrections
          + ' pausedFrames=' + outcome.pausedFrames
          + ' maxDrift=' + Math.round(outcome.maxDriftPx * 10) / 10);
      },
    });
    historyWheelGeometryReleaseSettleCancelRef.current = cancel;
  }, [
    historyScrollSeekController,
    measureHistoryWheelGeometryRelease,
    readHistoryWheelGeometryAnchorTop,
    restoreHistoryWheelGeometryRows,
    setHistorySeekGeometryMask,
  ]);

  historyPresentationApplyGuardRef.current = (reason: string) => {
    const scroller = virtuosoScrollerRef.current;
    if (
      !scroller?.isConnected
      || !historyPresentationProofRef.current.presented
      || historyScrollSeekController.isActive()
      || historyPointerScrollActiveRef.current
      || historyRestoreInFlightRef.current !== 0
      || historyScrollInFlightRef.current !== null
    ) return;
    const anchor = captureHistoryWheelGeometryAnchor(scroller, 'real');
    if (!anchor) return;
    historyWheelGeometryReleaseSettleCancelRef.current?.();
    historyWheelGeometryReleaseSettleCancelRef.current = null;
    historyDiag('MATERIALIZED_WINDOW_APPLY_START tab=' + historyTabIdRef.current.slice(-12)
      + ' reason=' + reason
      + ' key=' + anchor.identity.slice(-24)
      + ' top=' + Math.round(anchor.top * 10) / 10);
    settleHistoryWheelGeometryRelease({
      scroller,
      identity: anchor.identity,
      targetTop: anchor.top,
      ownerKey: historyOwnerKeyRef.current,
      ownerGeneration: historyOwnerGenerationRef.current,
      presentationVisit: historyPresentationProofRef.current.visit,
      gestureGeneration: historyUserGestureGenerationRef.current,
      source: 'hydration-apply',
      bottomGap: anchor.bottomGap,
    });
  };

  const waitForHistoryRealAnchorAndRelease = useCallback((
    scroller: HTMLElement,
    anchor: { identity: string; top: number; bottomGap: number },
    source: 'slow-real' | 'seek-exit',
  ) => {
    historyWheelGeometryReleaseSettleCancelRef.current?.();
    const ownerKey = historyOwnerKeyRef.current;
    const ownerGeneration = historyOwnerGenerationRef.current;
    const presentationVisit = historyPresentationProofRef.current.visit;
    const gestureGeneration = historyUserGestureGenerationRef.current;
    historyDiag('WHEEL_GEOMETRY_RELEASE_START tab=' + historyTabIdRef.current.slice(-12)
      + ' key=' + anchor.identity.slice(-24)
      + ' path=' + source
      + ' targetTop=' + Math.round(anchor.top * 10) / 10
      + ' bottomGap=' + Math.round(anchor.bottomGap * 10) / 10
      + ' currentTop=' + String(
        Math.round((readHistoryWheelGeometryAnchorTop(scroller, anchor.identity, true) || 0) * 10) / 10,
      )
      + ' scrollTop=' + Math.round(scroller.scrollTop * 10) / 10);
    let cancelled = false;
    let frame = 0;
    let frameToken: number | null = null;
    const cancel = () => {
      cancelled = true;
      if (frameToken !== null) cancelAnimationFrame(frameToken);
      frameToken = null;
    };
    const fail = (reason: string) => {
      if (historyWheelGeometryReleaseSettleCancelRef.current === cancel) {
        historyWheelGeometryReleaseSettleCancelRef.current = null;
      }
      if (source === 'seek-exit') setHistorySeekGeometryMask(scroller, false);
      restoreHistoryWheelGeometryRows();
      historyDiag('WHEEL_GEOMETRY_RELEASE_ABORT tab=' + historyTabIdRef.current.slice(-12)
        + ' key=' + anchor.identity.slice(-24)
        + ' path=' + source
        + ' reason=' + reason
        + ' frames=' + frame);
    };
    const step = () => {
      frameToken = null;
      if (cancelled) return;
      if (
        !scroller.isConnected
        || historyOwnerKeyRef.current !== ownerKey
        || historyOwnerGenerationRef.current !== ownerGeneration
        || historyUserGestureGenerationRef.current !== gestureGeneration
        || !historyPresentationOwnsWrite(
          historyPresentationProofRef.current,
          presentationVisit,
        )
      ) {
        fail('stale-owner');
        return;
      }
      if (readHistoryWheelGeometryAnchorTop(scroller, anchor.identity, true) !== null) {
        if (historyWheelGeometryReleaseSettleCancelRef.current === cancel) {
          historyWheelGeometryReleaseSettleCancelRef.current = null;
        }
        settleHistoryWheelGeometryRelease({
          scroller,
          identity: anchor.identity,
          targetTop: anchor.top,
          ownerKey,
          ownerGeneration,
          presentationVisit,
          gestureGeneration,
          source,
          bottomGap: anchor.bottomGap,
        });
        return;
      }
      frame += 1;
      if (frame >= 120) {
        fail('real-row-timeout');
        return;
      }
      frameToken = requestAnimationFrame(step);
    };
    historyWheelGeometryReleaseSettleCancelRef.current = cancel;
    step();
  }, [
    readHistoryWheelGeometryAnchorTop,
    restoreHistoryWheelGeometryRows,
    setHistorySeekGeometryMask,
    settleHistoryWheelGeometryRelease,
  ]);

  const releaseHistoryWheelGeometryFreeze = useCallback((settle = true) => {
    const state = historyWheelGeometryFreezeRef.current;
    const scroller = state.scroller;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    if (!settle || !scroller?.isConnected) {
      historyWheelGeometryReleaseSettleCancelRef.current?.();
      historyWheelGeometryReleaseSettleCancelRef.current = null;
      setHistorySeekGeometryMask(scroller, false);
      restoreHistoryWheelGeometryRows();
      return;
    }
    if (historyScrollSeekController.isActive()) {
      state.pendingSeekExit = true;
      historyDiag('WHEEL_GEOMETRY_RELEASE_WAIT tab=' + historyTabIdRef.current.slice(-12)
        + ' reason=seek-active rows=' + state.rows.size);
      return;
    }
    // The exact placeholder can leave overscan before this release frame. The
    // active geometry mask is still proof that this is a seek handoff; losing
    // the placeholder must not reclassify it as an ordinary release and leak
    // hidden real rows forever.
    const fromSeekExit = state.seekExitAnchor !== null
      || scroller.hasAttribute('data-history-seek-geometry-settling');
    const anchor = state.seekExitAnchor
      || captureHistoryWheelGeometryAnchor(scroller, 'real');
    state.pendingSeekExit = false;
    state.seekExitAnchor = null;
    if (!anchor) {
      setHistorySeekGeometryMask(scroller, false);
      restoreHistoryWheelGeometryRows();
      historyDiag('WHEEL_GEOMETRY_RELEASE_ABORT tab=' + historyTabIdRef.current.slice(-12)
        + ' reason=no-semantic-anchor');
      return;
    }
    waitForHistoryRealAnchorAndRelease(
      scroller,
      anchor,
      fromSeekExit ? 'seek-exit' : 'slow-real',
    );
  }, [
    captureHistoryWheelGeometryAnchor,
    historyScrollSeekController,
    restoreHistoryWheelGeometryRows,
    setHistorySeekGeometryMask,
    waitForHistoryRealAnchorAndRelease,
  ]);

  const freezeHistoryWheelGeometry = useCallback((scroller: HTMLElement) => {
    historyWheelGeometryReleaseSettleCancelRef.current?.();
    historyWheelGeometryReleaseSettleCancelRef.current = null;
    const state = historyWheelGeometryFreezeRef.current;
    const starting = state.scroller !== scroller;
    if (state.scroller && state.scroller !== scroller) {
      releaseHistoryWheelGeometryFreeze(false);
    }
    state.scroller = scroller;
    state.pendingSeekExit = false;
    state.seekExitAnchor = null;

    const freezeRow = (row: HTMLElement) => {
      if (state.rows.has(row)) return;
      const known = Number(row.getAttribute('data-known-size'));
      // `data-known-size` is Virtuoso's already-published geometry. Reading
      // every wrapper rect in the wheel handler would force layout on the
      // critical input task — the opposite of what this freeze protects.
      // A wrapper without known geometry is ignored until Virtuoso publishes
      // it; newly mounted rows arrive with the current estimate attached.
      const height = Number.isFinite(known) && known > 0 ? known : 0;
      if (!Number.isFinite(height) || height <= 0) return;
      state.rows.set(row, {
        height: row.style.height,
        minHeight: row.style.minHeight,
        maxHeight: row.style.maxHeight,
        overflow: row.style.overflow,
        frozenHeight: height,
      });
      const pixels = height + 'px';
      row.style.height = pixels;
      row.style.minHeight = pixels;
      row.style.maxHeight = pixels;
      row.style.overflow = 'hidden';
    };

    for (const row of scroller.querySelectorAll<HTMLElement>('[data-item-index][data-known-size]')) {
      freezeRow(row);
    }
    if (!state.observer) {
      state.observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const added of record.addedNodes) {
            if (!(added instanceof HTMLElement)) continue;
            if (added.matches('[data-item-index][data-known-size]')) freezeRow(added);
            for (const row of added.querySelectorAll<HTMLElement>('[data-item-index][data-known-size]')) {
              freezeRow(row);
            }
          }
        }
      });
      state.observer.observe(scroller, { childList: true, subtree: true });
    }
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(
      () => releaseHistoryWheelGeometryFreeze(true),
      HISTORY_WHEEL_GEOMETRY_FREEZE_HOLD_MS,
    );
    if (starting) {
      historyDiag('WHEEL_GEOMETRY_FREEZE_START tab=' + historyTabIdRef.current.slice(-12)
        + ' rows=' + state.rows.size
        + ' scrollTop=' + Math.round(scroller.scrollTop * 10) / 10
        + ' scrollHeight=' + Math.round(scroller.scrollHeight));
    }
  }, [releaseHistoryWheelGeometryFreeze]);

  const scheduleHistorySeekRealRowsReady = useCallback((scroller: HTMLElement) => {
    historySeekRealRowsReadyCancelRef.current?.();
    const ownerKey = historyOwnerKeyRef.current;
    const ownerGeneration = historyOwnerGenerationRef.current;
    const presentationVisit = historyPresentationProofRef.current.visit;
    let cancelled = false;
    let frame = 0;
    let frameToken: number | null = null;
    const cancel = () => {
      cancelled = true;
      if (frameToken !== null) cancelAnimationFrame(frameToken);
      frameToken = null;
    };
    const finish = (reason: string) => {
      if (historySeekRealRowsReadyCancelRef.current === cancel) {
        historySeekRealRowsReadyCancelRef.current = null;
      }
      historyDiag('SCROLL_SEEK_REAL_ROWS tab=' + historyTabIdRef.current.slice(-12)
        + ' reason=' + reason
        + ' frames=' + frame);
    };
    const step = () => {
      frameToken = null;
      if (cancelled) return;
      if (
        !scroller.isConnected
        || historyOwnerKeyRef.current !== ownerKey
        || historyOwnerGenerationRef.current !== ownerGeneration
        || !historyPresentationOwnsWrite(
          historyPresentationProofRef.current,
          presentationVisit,
        )
      ) {
        finish('stale-owner');
        return;
      }
      const wrapper = scroller.querySelector<HTMLElement>('[data-item-index]');
      if (wrapper) {
        setHistorySeekPresentationEpoch((value) => value + 1);
        if (mountWaveActiveRef.current && mountWaveLaneRef.current) {
          requestHistoryMountWaveStep(mountWaveLaneRef.current);
        }
        finish(wrapper.querySelector('[data-history-row-real]') ? 'real' : 'shell');
        return;
      }
      frame += 1;
      if (frame >= 60) {
        finish('timeout');
        return;
      }
      frameToken = requestAnimationFrame(step);
    };
    historySeekRealRowsReadyCancelRef.current = cancel;
    frameToken = requestAnimationFrame(step);
  }, [requestHistoryMountWaveStep]);

  historyScrollSeekTransitionRef.current = (event: any) => {
    if (event.kind === 'enter') {
      historySeekRealRowsReadyCancelRef.current?.();
      historySeekRealRowsReadyCancelRef.current = null;
      const scroller = virtuosoScrollerRef.current;
      if (scroller?.isConnected) freezeHistoryWheelGeometry(scroller);
      return;
    }
    if (event.kind !== 'exit') return;
    const scroller = virtuosoScrollerRef.current;
    if (!scroller?.isConnected) return;
    if (event.reason !== 'scroller-change' && event.reason !== 'scroller-gone') {
      scheduleHistorySeekRealRowsReady(scroller);
    }
    if (event.reason !== 'velocity-settled') {
      releaseHistoryWheelGeometryFreeze(false);
      return;
    }
    const state = historyWheelGeometryFreezeRef.current;
    const ownsFrozenGeometry = state.scroller === scroller;
    const releaseWasWaiting = ownsFrozenGeometry && state.pendingSeekExit;
    if (ownsFrozenGeometry) {
      // Mask before Virtuoso commits real cards. DOM existence is not geometry
      // proof: wrappers are still frozen here and their real sizes have not
      // reached Virtuoso's size tree yet.
      setHistorySeekGeometryMask(scroller, true);
      const anchor = captureHistoryWheelGeometryAnchor(scroller, 'seek');
      state.seekExitAnchor = anchor;
      state.pendingSeekExit = false;
      historyDiag('WHEEL_GEOMETRY_SEEK_HANDOFF tab=' + historyTabIdRef.current.slice(-12)
        + ' proof=' + (anchor ? 'exact-placeholder' : 'missing-placeholder')
        + ' key=' + (anchor?.identity.slice(-24) || '-'));
    }
    if (releaseWasWaiting) {
      requestAnimationFrame(() => releaseHistoryWheelGeometryFreeze(true));
    }
  };

  historyPresentationHideCleanupRef.current = () => {
    const scroller = virtuosoScrollerRef.current;
    const freezeState = historyWheelGeometryFreezeRef.current;
    const hadBridge = scroller?.hasAttribute('data-history-geometry-bridge') === true;
    const frozenRows = freezeState.rows.size;
    historySeekRealRowsReadyCancelRef.current?.();
    historySeekRealRowsReadyCancelRef.current = null;
    // `isSuppressed()` now observes presented=false, so an active seek exits
    // without its recovery kick and without converting any offset to scroll.
    historyScrollSeekController.configuration.exit(0);
    const trace = historyScrollGestureTraceRef.current;
    if (trace) cancelHistoryScrollTraceScheduledWork(trace);
    historyScrollGestureTraceRef.current = null;
    releaseHistoryWheelGeometryFreeze(false);
    // The cancellation callback normally clears the bridge. These explicit
    // removals also cover a partially-started/stale transaction whose cancel
    // owner was already gone.
    scroller?.removeAttribute('data-history-geometry-bridge');
    scroller?.style.removeProperty('--hp-history-geometry-bridge-y');
    setHistorySeekGeometryMask(scroller, false);
    if (hadBridge || frozenRows > 0) {
      historyDiag('PRESENTATION_GEOMETRY_CLEANUP tab=' + historyTabIdRef.current.slice(-12)
        + ' bridge=' + (hadBridge ? '1' : '0')
        + ' frozenRows=' + frozenRows);
    }
  };

  useEffect(() => () => {
    historySeekRealRowsReadyCancelRef.current?.();
    historySeekRealRowsReadyCancelRef.current = null;
    setHistorySeekGeometryMask(virtuosoScrollerRef.current, false);
    releaseHistoryWheelGeometryFreeze(false);
  }, [releaseHistoryWheelGeometryFreeze, setHistorySeekGeometryMask]);

  const measureHistoryVirtuosoItemSize = useCallback((element: HTMLElement, field: string) => {
    const rect = element.getBoundingClientRect();
    const actualSize = Math.round(field === 'offsetWidth' ? rect.width : rect.height);
    const knownSize = Number(element.getAttribute('data-known-size'));
    const trace = historyScrollGestureTraceRef.current;
    if (
      trace
      && historyPresentationProofRef.current.presented
      && Number.isFinite(knownSize)
      && Math.abs(actualSize - knownSize) > 1
    ) {
      const logState = historyVirtuosoHeightLogRef.current;
      if (logState.gestureId !== trace.id) {
        logState.gestureId = trace.id;
        logState.count = 0;
      }
      if (logState.count < 12) {
        logState.count += 1;
        const scroller = virtuosoScrollerRef.current;
        const scrollerRect = scroller?.getBoundingClientRect() || null;
        const row = element.querySelector<HTMLElement>('[data-uuid]');
        const zone = !scrollerRect
          ? 'unknown'
          : rect.top >= scrollerRect.bottom - 1
            ? 'below'
            : rect.bottom <= scrollerRect.top + 1 ? 'above' : 'visible';
        historyDiag('VIRTUOSO_ROW_HEIGHT_DELTA tab=' + historyTabIdRef.current.slice(-12)
          + ' gid=' + trace.id
          + ' index=' + String(element.getAttribute('data-item-index') || '-')
          + ' uuid=' + String(row?.getAttribute('data-uuid') || '-').slice(-18)
          + ' known=' + Math.round(knownSize)
          + ' actual=' + actualSize
          + ' delta=' + Math.round(actualSize - knownSize)
          + ' zone=' + zone
          + ' direction=' + String(historyUserScrollDirectionRef.current || '-')
          + ' scrollTop=' + Math.round((scroller?.scrollTop || 0) * 10) / 10
          + ' scrollHeight=' + Math.round(scroller?.scrollHeight || 0));
      }
    }
    return actualSize;
  }, []);

  const handleUserScrollIntent = useCallback((event: Event) => {
    if (event.type === 'wheel' && historyInnerOwnedWheelEvents.delete(event)) return;
    if (
      (event.type === 'wheel' || event.type === 'touchmove')
      && historyPresentationProofRef.current.presented
      && (event.type !== 'wheel' || (event as WheelEvent).isTrusted)
    ) {
      historyForegroundPriority.mark(tabId, HISTORY_FOREGROUND_PRIORITY_HOLD_MS);
    }
    if (event.type === 'wheel') traceHistoryWheelInput(event as WheelEvent);
    const reason = event.type === 'touchmove' ? 'user-touchmove' : 'user-wheel';
    historyUserGestureAtRef.current = performance.now();
    historyUserGestureGenerationRef.current += 1;
    // A GESTURE re-arms the hydration burst breaker — this, not scrollTop
    // movement, is what "the user genuinely wants new rows" means (scrollTop
    // moves on every reload of the very loop the breaker stops).
    {
      const burst = hydrationBurstRef.current;
      burst.since = performance.now();
      burst.count = 0;
      burst.tripped = false;
    }
    let isUpwardIntent = false;
    if (event.type === 'wheel') {
      const deltaY = (event as WheelEvent).deltaY;
      isUpwardIntent = deltaY < 0;
      historyUserScrollDirectionRef.current = deltaY < 0
        ? 'up'
        : deltaY > 0 ? 'down' : null;
      // Preserve real row DOM for small readable movement. Only a confirmed
      // dense upward packet burst pre-arms seek; Virtuoso's own velocity gate
      // remains the normal fast-scroll path.
      historyScrollSeekController.armWheelGesture(
        deltaY,
        (event as WheelEvent).timeStamp,
      );
      historyScrollSeekController.armWheelBurst((event as WheelEvent).deltaY);
    } else if (event.type === 'touchmove') {
      const touch = (event as TouchEvent).touches[0];
      const nextY = touch?.clientY ?? null;
      const previousY = historyTouchYRef.current;
      isUpwardIntent = nextY !== null && previousY !== null && nextY > previousY;
      historyUserScrollDirectionRef.current = previousY === null || nextY === null
        ? null
        : isUpwardIntent ? 'up' : 'down';
      historyTouchYRef.current = nextY;
    }
    const scrollerAtInput = virtuosoScrollerRef.current;
    if (
      event.type === 'wheel'
      && scrollerAtInput?.hasAttribute('data-history-seek-geometry-settling')
    ) {
      if (historySeekGeometryMaskReleaseTimerRef.current !== null) {
        clearTimeout(historySeekGeometryMaskReleaseTimerRef.current);
      }
      const maskScroller = scrollerAtInput;
      historySeekGeometryMaskReleaseTimerRef.current = setTimeout(() => {
        historySeekGeometryMaskReleaseTimerRef.current = null;
        if (
          maskScroller.isConnected
          && !historyScrollSeekController.isActive()
          && historyWheelGeometryReleaseSettleCancelRef.current === null
        ) {
          setHistorySeekGeometryMask(maskScroller, false);
        }
      }, 500);
    }
    if (isUpwardIntent) {
      setHistoryTailFollowIntent(false);
      historyTailPinScheduler.cancel();
    }
    // Any real wheel/touch takes position ownership from a running restore
    // convergence loop (same contract as the Timeline-jump cancel below).
    scrollRestoreGenRef.current += 1;
    const cancelledProgrammaticScroll = cancelHistoryScrollFromUser(reason);
    if (cancelledProgrammaticScroll) return;
    // Ordinary scrolling never freezes Virtuoso's `data-known-size`: for a
    // newly mounted row that number can still be an estimate. Treating it as
    // a measured height created giant empty group boxes and a compensating
    // jump when the constraint was released. Fast seek owns the only remaining
    // freeze path through historyScrollSeekTransitionRef.
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
  }, [
    cancelHistoryScrollFromUser,
    historyScrollSeekController,
    historyTailPinScheduler,
    setHistorySeekGeometryMask,
    tabId,
    traceHistoryWheelInput,
  ]);

  const handleHistoryTouchStart = useCallback((event: TouchEvent) => {
    historyTouchYRef.current = event.touches[0]?.clientY ?? null;
    historyUserScrollDirectionRef.current = null;
  }, []);

  const handleHistoryTouchEnd = useCallback(() => {
    historyTouchYRef.current = null;
    historyUserScrollDirectionRef.current = null;
  }, []);

  const handleHistoryScrollerPointerDown = useCallback((event: PointerEvent) => {
    const scroller = virtuosoScrollerRef.current;
    if (!scroller || event.target !== scroller) return;
    const rect = scroller.getBoundingClientRect();
    const onVerticalScrollbar = event.clientX >= rect.left + scroller.clientWidth;
    const onHorizontalScrollbar = event.clientY >= rect.top + scroller.clientHeight;
    // A click on empty scroller background is not scroll intent. Only a native
    // scrollbar drag may unpin a concurrently growing preview through scroll.
    if (onVerticalScrollbar || onHorizontalScrollbar) {
      historyPointerScrollActiveRef.current = true;
      historyForegroundPriority.mark(tabId, HISTORY_FOREGROUND_PRIORITY_HOLD_MS);
      // Grabbing the native scrollbar transfers position ownership to the
      // user before its first scroll event reveals a direction. A settling
      // send transaction must not get one more frame in which to pull back.
      historyTailPinScheduler.cancel();
      historyUserGestureAtRef.current = performance.now();
      historyUserGestureGenerationRef.current += 1;
      historyUserScrollDirectionRef.current = null;
      const burst = hydrationBurstRef.current;
      burst.since = performance.now();
      burst.count = 0;
      burst.tripped = false;
    }
  }, [historyTailPinScheduler, tabId]);

  const handleHistoryScrollerPointerEnd = useCallback(() => {
    historyPointerScrollActiveRef.current = false;
    historyUserScrollDirectionRef.current = null;
    scheduleHistoryHydrationRangeCheck();
  }, [scheduleHistoryHydrationRangeCheck]);

  const handleHistoryScrollerKeyIntent = useCallback((event: KeyboardEvent) => {
    const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
    if (!scrollKeys.includes(event.key)) return;
    historyUserGestureAtRef.current = performance.now();
    historyForegroundPriority.mark(tabId, HISTORY_FOREGROUND_PRIORITY_HOLD_MS);
    historyUserGestureGenerationRef.current += 1;
    const burst = hydrationBurstRef.current;
    burst.since = performance.now();
    burst.count = 0;
    burst.tripped = false;
    const movesUp = event.key === 'ArrowUp'
      || event.key === 'PageUp'
      || event.key === 'Home'
      || (event.key === ' ' && event.shiftKey);
    historyUserScrollDirectionRef.current = movesUp ? 'up' : 'down';
    if (!movesUp) return;
    setHistoryTailFollowIntent(false);
    historyTailPinScheduler.cancel();
  }, [historyTailPinScheduler, tabId]);

  useEffect(() => {
    window.addEventListener('pointerup', handleHistoryScrollerPointerEnd, true);
    window.addEventListener('pointercancel', handleHistoryScrollerPointerEnd, true);
    return () => {
      window.removeEventListener('pointerup', handleHistoryScrollerPointerEnd, true);
      window.removeEventListener('pointercancel', handleHistoryScrollerPointerEnd, true);
    };
  }, [handleHistoryScrollerPointerEnd]);

  useEffect(() => {
    if (!historyScrollToUuid) return;
    if (surfaceLoading || displayEntries.length === 0) return; // wait for entries; uuid stays in store
    const targetUuid = historyScrollToUuid;
    // Target hidden inside a collapsed series: expand SYNCHRONOUSLY first.
    // The state update re-runs this effect on the next commit against the
    // unrolled unit list; the store key is intentionally NOT consumed yet.
    if (expandGroupForUuid(targetUuid, 'timeline-jump')) return;
    const idx = displayEntryIndexByUuid.get(targetUuid) ?? -1;
    // Consume the store key immediately. The convergence loop is driven by the
    // ref-generation guard, NOT by this effect's cleanup, so clearing the key
    // (which re-runs the effect → early-return above) does not abort the loop.
    setHistoryScrollToUuid(null);
    if (idx < 0) {
      historyDiag('SCROLL_TO_MISS tab=' + tabId.slice(-12) +
        ' uuid=' + targetUuid.slice(-12) +
        panelDiagContextRef.current +
        ' entries=' + displayEntries.length +
        ' reason=uuid-not-in-display');
      // entry doesn't exist in this session — acknowledge so the dot spinner clears
      window.dispatchEvent(
        new CustomEvent('history-panel:scrolled-to', { detail: { tabId, uuid: targetUuid, found: false, reason: 'uuid-not-in-display' } }),
      );
      return;
    }

    // Row-window: a Timeline jump can target a row main shipped as a stub.
    // The convergence loop below owns that case — it drives the hydration
    // request itself (retrying if a load fails), holds its deadline open
    // while the placeholder awaits content, and only then converges. A
    // single fire-and-forget request here proved fatal on 14.08: it was
    // silently refused by a stale guard and nothing ever retried.

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
      ' uuid=' + targetUuid.slice(-12) +
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
      historyJumpHydrationActiveRef.current = false;
      // Same echo hazard as position restores: the jump's own velocity
      // sample lands after the in-flight suppressor clears.
      historyScrollSeekController.stampMachineScrollCooldown();
      historyDiag('SCROLL_TO_DONE tab=' + tabId.slice(-12) +
        ' uuid=' + targetUuid.slice(-12) +
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
    // Row-window: the loop OWNS hydration of a stub target. It re-requests
    // through the deduped/cooled-down request fn every frame (a failed load
    // retries after its cooldown), pauses the attempt budget while the
    // placeholder waits for content, and restarts convergence measurement
    // when the real card lands. A single fire-and-forget request before the
    // loop proved fatal on 14.08 — silently refused, never retried, 240
    // attempts hunting a placeholder the convergence rule rightly refuses.
    let lastTargetWasStub = false;
    let stubWaitStartedAt: number | null = null;
    let stubWaitTotalMs = 0;
    const step = () => {
      if (!scrollMountedRef.current || scrollGenRef.current !== myGen) return; // superseded / unmounted
      const currentIdx = displayEntryIndexByUuidRef.current.get(targetUuid) ?? -1;
      if (currentIdx < 0) {
        finish(false, 'target-disappeared');
        return;
      }
      const now = performance.now();
      const targetIsStub = toolType === 'codex'
        && isHistoryHydrationTargetStub(entriesRef.current, targetUuid);
      if (targetIsStub) {
        if (stubWaitStartedAt === null) stubWaitStartedAt = now;
        historyJumpHydrationActiveRef.current = true;
        requestHistoryHydrationAt(targetUuid, 'timeline-jump', ' idx=' + currentIdx);
        // Main just answered that this row does not exist in its projection
        // (file rewritten under us): waiting will not materialize it.
        const lastResult = hydrationLastResultRef.current;
        if (lastResult?.centerMissing && lastResult.centerUuid === targetUuid) {
          finish(false, 'target-not-in-projection');
          return;
        }
        if (now - startedAt > JUMP_STUB_HYDRATION_WAIT_MS) {
          finish(false, 'target-stub-hydration-timeout');
          return;
        }
      } else if (lastTargetWasStub) {
        // Content just landed: heights re-measure from scratch around the
        // target, so convergence gets its full budget against the real card.
        stubWaitTotalMs += stubWaitStartedAt === null ? 0 : now - stubWaitStartedAt;
        stubWaitStartedAt = null;
        attempts = 0;
        stable = 0;
        lastTop = null;
        historyDiag('SCROLL_TO_HYDRATED tab=' + tabId.slice(-12) +
          ' uuid=' + targetUuid.slice(-12) +
          ' idx=' + currentIdx +
          ' stubWaitMs=' + Math.round(stubWaitTotalMs));
      }
      lastTargetWasStub = targetIsStub;
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
            ' uuid=' + targetUuid.slice(-12) +
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
        // A mount-wave shell / row stub is a stable wrapper with NO content —
        // declaring the jump done on it would flash an empty bar and clear
        // Timeline's pending state against nothing. Keep converging until
        // the row is real, the stability check below then passes on it.
        const isShell = node.hasAttribute('data-history-mount-shell');
        // Offset of the row relative to the scroller's own viewport — immune to
        // the panel's slide-in transform (both translate together), so this only
        // moves when the INTERNAL scroll position is still settling.
        const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        if (!isShell && lastTop !== null && Math.abs(top - lastTop) < 1) stable++; else stable = 0;
        lastTop = top;
        // Mounted + position unchanged for 2 consecutive frames, after at least
        // a few scrollToIndex calls → Virtuoso has settled on the target row.
        if (stable >= 2 && attempts >= 3) { finish(true, 'stable-mounted'); return; }
      }
      if (attempts >= MAX_ATTEMPTS && !targetIsStub) {
        // A row seen on an earlier frame is not proof that the final target is
        // still mounted or settled. Report failure unless the normal stable
        // branch above completed; Timeline must not clear its pending jump on
        // a historical sighting. A stub target never trips this cap — its
        // bound is the wall-clock hydration deadline above.
        finish(false, node ? 'max-attempts-unstable-mounted' : 'max-attempts-unmounted');
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [displayEntryIndexByUuid, displayEntries, expandGroupForUuid, historyScrollToUuid, pendingInitialHistoryIndex, requestHistoryHydrationAt, setHistoryScrollToUuid, surfaceLoading, tabId, toolType]);

  // Native scroll handler — runs on the Virtuoso scroller element via a
  // direct addEventListener (Virtuoso doesn't pass an onScroll prop through
  // to the scroller). Computes scroll direction, at-bottom flag, debounced
  // position save; the at-bottom signal is also reported by Virtuoso via
  // `atBottomStateChange`, but we keep the scrollTop-derived signal because
  // it updates synchronously on every wheel tick (needed for the FAB toggle).
  const lastScrollTopRef = useRef(0);
  const scrollDirectionRef = useRef<'down' | 'up'>('down');
  const dormantScrollLoggedRef = useRef(false);
  const handleScroll = useCallback(() => {
    const el = virtuosoScrollerRef.current;
    if (!el) return;
    const presentation = historyPresentationProofRef.current;
    if (!presentation.presented) {
      // A permanently mounted dormant pane still receives scroll events from
      // composer resize, Virtuoso measurement and background appends. Those
      // are useful layout work, but none is evidence that the user moved.
      // Keep only the velocity baseline; do not touch follow intent, reading
      // anchor, pixel position or measured-layout scroll offset.
      lastScrollTopRef.current = el.scrollTop;
      if (!dormantScrollLoggedRef.current) {
        dormantScrollLoggedRef.current = true;
        historyDiag('SCROLL_DORMANT_SKIP tab=' + tabId.slice(-12)
          + ' visit=' + presentation.visit
          + ' scrollTop=' + Math.round(el.scrollTop)
          + ' scrollHeight=' + Math.round(el.scrollHeight)
          + ' follow=' + (isAtBottomRef.current ? '1' : '0'));
      }
      return;
    }
    dormantScrollLoggedRef.current = false;
    traceHistoryScrollEvent(el);
    // Keep the panel-local seek kick on the element that is actually moving.
    historyScrollSeekController.setScroller(el, historyScrollerOwnerToken());
    const deltaTop = el.scrollTop - lastScrollTopRef.current;
    // The hydration burst breaker is deliberately NOT re-armed on mere
    // scrollTop movement: every reload of the loop this breaker exists to
    // stop remeasures row heights and nudges scrollTop itself, so re-arming
    // on position change let the loop reset its own breaker every pass
    // (production 16.08 02:04 — the breaker never fired once through two
    // minutes of ~7 reloads/s). Re-arm lives on GESTURES: wheel/touch/keys
    // in their listeners, and an in-progress scrollbar drag here (the drag
    // produces no further discrete events, but the pointer-down flag is a
    // positive signal the loop cannot fake).
    if (historyPointerScrollActiveRef.current) {
      historyForegroundPriority.mark(tabId, HISTORY_FOREGROUND_PRIORITY_HOLD_MS);
      const burst = hydrationBurstRef.current;
      burst.since = performance.now();
      burst.count = 0;
      burst.tripped = false;
    }
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
    // Since the composer is the column's last row, the physical scroller
    // bottom is the only bottom. There is no synthetic footer to subtract.
    const distFromBottom = historyContentDistanceFromBottom(el);
    const physicalPinned = isHistoryAtContentBottom(el);
    const recentGestureDirection = performance.now() - historyUserGestureAtRef.current <= 500
      ? historyUserScrollDirectionRef.current
      : null;
    const pointerDirection = historyPointerScrollActiveRef.current
      ? deltaTop < 0 ? 'up' : deltaTop > 0 ? 'down' : null
      : null;
    const userMovedAwayFromTail = !physicalPinned && (
      pointerDirection === 'up'
      || recentGestureDirection === 'up'
      || historyScrollInFlightRef.current !== null
    );
    if (userMovedAwayFromTail) historyTailPinScheduler.cancel();
    setHistoryTailFollowIntent(reconcileHistoryTailFollowIntent({
      currentIntent: isAtBottomRef.current,
      physicalPinned,
      userMovedAway: userMovedAwayFromTail,
      userReachedBottom: physicalPinned && (
        pointerDirection === 'down'
        || recentGestureDirection === 'down'
      ),
    }));
    if (scrollArrowRef.current) {
      scrollArrowRef.current.style.display = distFromBottom > 150 ? '' : 'none';
    }
    scrollDirectionRef.current = el.scrollTop >= lastScrollTopRef.current ? 'down' : 'up';
    lastScrollTopRef.current = el.scrollTop;
    // Live O(1) patch of the stored geometry's offset. The FULL geometry save
    // waits for scroll-idle (150ms), so leaving the tab right after a gesture
    // restored the position of the PREVIOUS idle tick — one gesture ago. Row
    // sizes don't change from scrolling, so patching just the offset keeps
    // the stored snapshot exact without asking Virtuoso for a full state
    // walk on every wheel tick. No-op until the first full save exists.
    // Suppressed while a restore loop owns the scroller (its transient jump
    // positions are not the user's place) and until the viewport proof — the
    // scroll events Virtuoso fires while APPLYING restored geometry at mount
    // pass through intermediate offsets that must not overwrite the target.
    if (
      !historyRestoreInFlightRef.current
      && viewportReadyOwnerKeyRef.current === historyOwnerKeyRef.current
    ) {
      updateHistoryMeasuredLayoutScrollTop(historyOwnerKeyRef.current, el.scrollTop);
    }
    if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
    // Capture the owner key NOW, not when the timer fires: the panel is
    // persistently mounted, so 150ms later the tab may already be a
    // different one and a ref read would file this position under the
    // destination tab's key (the proven cross-tab poisoning bug).
    const saveKey = scrollPositionKeyRef.current;
    const savePresentationVisit = presentation.visit;
    scrollSaveTimerRef.current = setTimeout(() => {
      // Stale-guard: fire only while the same owner is still presented and
      // the scroller shows ITS rows. An owner switch mid-debounce discards
      // the save — the anchor already stored on the previous idle tick wins.
      if (scrollPositionKeyRef.current !== saveKey) return;
      if (!el.isConnected) return;
      if (!historyPresentationOwnsWrite(
        historyPresentationProofRef.current,
        savePresentationVisit,
      )) {
        historyDiag('SCROLL_SAVE_SKIP tab=' + tabId.slice(-12)
          + ' reason=presentation-change'
          + ' capturedVisit=' + savePresentationVisit
          + ' currentVisit=' + historyPresentationProofRef.current.visit
          + ' presented=' + (historyPresentationProofRef.current.presented ? '1' : '0'));
        return;
      }
      // A restore hunt re-jumps every frame, but a heavy row mount can hold
      // a frame past the 150ms debounce — and this callback then recorded a
      // MID-HUNT position as the user's reading place (anchor, pixels and
      // geometry alike), corrupting the very target the next return aims
      // for. The hunt's own settle banks the final position; nothing here is
      // lost by skipping.
      if (historyRestoreInFlightRef.current) return;
      setHistoryScrollPosition(saveKey, el.scrollTop);
      // Reading anchor: row identity + in-row offset instead of raw pixels.
      // Virtualized heights are estimates until measured, so scrollTop stops
      // meaning anything across remounts/re-measures; the anchor survives
      // both and an app restart (localStorage). Persist the semantic follow
      // intent, not mere threshold proximity: a tiny upward wheel can still
      // be four pixels from the tail, but it already transferred ownership
      // from streaming to the reader and must not be repinned on return.
      const anchor = captureHistoryAnchorFromDom(
        el,
        isAtBottomRef.current,
      );
      if (anchor) {
        setHistoryReadingAnchor(saveKey, {
          ...anchor,
          savedAt: Date.now(),
        });
        historyDiag('SCROLL_SAVE tab=' + tabId.slice(-12)
          + ' uuid=' + anchor.uuid.slice(0, 8)
          + ' offset=' + anchor.offsetPx
          + ' followBottom=' + (anchor.followBottom ? '1' : '0')
          + ' presented=1'
          + ' visit=' + savePresentationVisit);
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
      // Not during a mount wave: rows the user scrolled past mid-wave are
      // shells sized from the per-owner AVERAGE, and banking those as
      // measurements poisons the persisted store. Wave-done saves instead.
      if (mountWaveActiveRef.current) return;
      const layoutKey = historyOwnerKeyRef.current;
      const layoutItemKeys = displayUnitLayoutKeysRef.current;
      try {
        virtuosoRef.current?.getState((snapshot) => {
          if (historyOwnerKeyRef.current !== layoutKey) return; // owner moved on
          if (!historyPresentationOwnsWrite(
            historyPresentationProofRef.current,
            savePresentationVisit,
          )) return;
          saveHistoryMeasuredLayout(layoutKey, snapshot as any, layoutItemKeys);
        });
      } catch { /* geometry is optional; never break position saving */ }
    }, 150);
  }, [historyScrollerOwnerToken, historyScrollSeekController, historyTailPinScheduler, tabId, setHistoryScrollPosition, traceHistoryScrollEvent]);

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
    // The visible range indexes display UNITS; a collapsed group contributes
    // every member uuid (Timeline dots for those rows count as visible).
    const units = displayUnitsRef.current;
    if (units.length === 0) {
      setHistoryVisibleUuids(tabId, []);
      return;
    }
    const { start, end } = visibleRangeRef.current;
    const clampedStart = Math.max(0, Math.min(start, units.length - 1));
    const clampedEnd = Math.max(clampedStart, Math.min(end, units.length - 1));
    const visibleSet = new Set<string>();
    const directlyVisibleUsers: string[] = [];
    for (let i = clampedStart; i <= clampedEnd; i++) {
      const unit = units[i] as any;
      const unitEntries: FullHistoryEntry[] = isGroupUnit(unit)
        ? unit.entries
        : [unit.entry];
      for (const e of unitEntries) {
        if (!e?.uuid) continue;
        visibleSet.add(e.uuid);
        if (e.role === 'user') directlyVisibleUsers.push(e.uuid);
      }
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
    // Everything positional (scrollToIndex targets, geometry item counts)
    // lives in display-UNIT space now.
    lengthRef.current = displayUnits.length;
    recomputeVisibleUuids();
  }, [recomputeVisibleUuids, displayUnits.length]);

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

  // A callback ref with a fresh identity is not presentation-only: React
  // delivers the old ref `null` and the new ref the SAME element around an
  // ordinary render. That false scroller replacement used to erase the
  // machine-scroll cooldown stamped by a completed Timeline jump; the delayed
  // velocity sample then entered seek mode and painted a skeleton between two
  // identical text frames (production 20.08 03:20 UTC, 19/23 jumps).
  const handleHistoryVirtuosoScrollerRef = useCallback((rawScroller: HTMLElement | Window | null) => {
    const nextScroller = rawScroller instanceof HTMLElement ? rawScroller : null;
    const prev = virtuosoScrollerRef.current;
    if (prev === nextScroller) {
      historyScrollSeekController.setScroller(nextScroller, historyScrollerOwnerToken());
      return;
    }
    if (prev && prev !== nextScroller) {
      releaseHistoryWheelGeometryFreeze(false);
      historySeekRealRowsReadyCancelRef.current?.();
      historySeekRealRowsReadyCancelRef.current = null;
      if (historyRevealOpsByScroller.get(prev) === historyRevealOps) {
        historyRevealOpsByScroller.delete(prev);
      }
      prev.removeEventListener('scroll', handleScroll);
      prev.removeEventListener('wheel', handleUserScrollIntent);
      prev.removeEventListener('touchstart', handleHistoryTouchStart);
      prev.removeEventListener('touchmove', handleUserScrollIntent);
      prev.removeEventListener('touchend', handleHistoryTouchEnd);
      prev.removeEventListener('touchcancel', handleHistoryTouchEnd);
      prev.removeEventListener('wheel', handleHistoryToolWheel, true);
      prev.removeEventListener('pointerdown', handleHistoryScrollerPointerDown);
      prev.removeEventListener('keydown', handleHistoryScrollerKeyIntent);
      historyPointerScrollActiveRef.current = false;
    }
    virtuosoScrollerRef.current = nextScroller;
    historyScrollSeekController.setScroller(nextScroller, historyScrollerOwnerToken());
    if (nextScroller && mountWaveActiveRef.current && mountWaveLaneRef.current) {
      // Virtuoso attaches the scroller AFTER the panel's own layout effects on
      // a fresh mount, so this is the event-driven mount-wave arm.
      requestHistoryMountWaveStep(mountWaveLaneRef.current);
    }
    if (nextScroller) {
      historyRevealOpsByScroller.set(nextScroller, historyRevealOps);
      nextScroller.addEventListener('scroll', handleScroll, { passive: true });
      nextScroller.addEventListener('wheel', handleUserScrollIntent, { passive: true });
      nextScroller.addEventListener('touchstart', handleHistoryTouchStart, { passive: true });
      nextScroller.addEventListener('touchmove', handleUserScrollIntent, { passive: true });
      nextScroller.addEventListener('touchend', handleHistoryTouchEnd, { passive: true });
      nextScroller.addEventListener('touchcancel', handleHistoryTouchEnd, { passive: true });
      nextScroller.addEventListener('wheel', handleHistoryToolWheel, { capture: true, passive: false });
      nextScroller.addEventListener('pointerdown', handleHistoryScrollerPointerDown, { passive: true });
      nextScroller.addEventListener('keydown', handleHistoryScrollerKeyIntent);
    }
  }, [
    handleHistoryScrollerKeyIntent,
    handleHistoryScrollerPointerDown,
    handleHistoryToolWheel,
    handleHistoryTouchEnd,
    handleHistoryTouchStart,
    handleScroll,
    handleUserScrollIntent,
    historyRevealOps,
    releaseHistoryWheelGeometryFreeze,
    historyScrollerOwnerToken,
    historyScrollSeekController,
    requestHistoryMountWaveStep,
  ]);

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
      rewindPreviewHiddenTurnCount={rewindPreviewHiddenTurnCount}
      terminalOpen={terminalOpen}
      onToggleTerminal={onToggleTerminal}
      onSwapPrimarySurface={onSwapPrimarySurface}
      terminalIsPrimary={terminalIsPrimary}
      lifecycleStatus={lifecycleStatus}
      operationalPhase={compactOperationalPhase}
      onRuntimeSnapshotChange={handleRuntimeSnapshotChange}
      onInputBusyChange={setControlsPasteBusy}
      onResponseTimingChange={handleResponseTimingChange}
      onHeightChange={handleControlsHeightChange}
      // Overlay geometry belongs to the centered layout only; docked below the
      // terminal the composer is a normal bottom row of the workspace column.
      overlayComposer={mainSurface}
      agentInputSurface={agentInputSurface && !staleOwnerCurtain}
      suppressWindowEscape={staleOwnerCurtain}
      suppressWindowEscapeRef={globalHotkeysSuppressedRef}
      interactionDisabled={staleOwnerCurtain}
      compactComposer={compactComposer}
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
      // A CLOSED side panel is closed for the keyboard too. It stays mounted
      // (it owns the docked composer and its scroll position must survive the
      // toggle) and is merely pushed off-edge by translateX / width:0 — and a
      // translated element is still in the browser's focus order. Tab then
      // walked into it and the browser scrolled the pane sideways to reveal
      // what it had just focused, which looks exactly like the panel opening by
      // itself. Same defect and same fix as FloatingTerminalFrame — see the
      // long note there. `embedded` placements are laid out inline and are only
      // closed when their width is 0.
      inert={(embedded ? (!embeddedFill && !slideIn) : !isOpen) || staleOwnerCurtain}
      data-history-owner={historyOwnerDomId}
      data-history-session={sessionId || undefined}
      data-history-presented={presented ? '1' : '0'}
      data-history-presentation-visit={historyPresentationVisit}
      data-history-viewport-ready={
        viewportReadyOwnerKey === historyOwnerKey ? '1' : '0'
      }
      style={{
        position: embedded ? 'relative' : 'absolute',
        top: 0,
        // Stop above the docked input instead of running under it. Only the
        // free-floating side panel can do this: the embedded/pinned placements
        // are laid out by flex, where `bottom`/`height` are not theirs to set.
        bottom: !embedded && bottomInset > 0 ? bottomInset : 0,
        right: 0,
        width: embedded ? (embeddedFill ? '100%' : (slideIn ? width : 0)) : width,
        height: !embedded && bottomInset > 0 ? 'auto' : '100%',
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
        {/* Deferred-handoff curtain: the workspace highlight already moved to
            the next tab, but this frozen instance still shows the previous
            owner's rows for a couple of frames. Cover them with the panel's
            loader so the surface never displays a transcript the selected tab
            does not own. Above rows and the viewport loader (z 5), below the
            background chips bar (z 7). */}
        {staleOwnerCurtain && (
          <div
            data-history-stale-curtain
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              background: '#151515',
              color: '#818cf8',
              fontSize: 13,
            }}
          >
            <HistorySpinner size={16} />
            Loading...
          </div>
        )}
        <HistoryPayloadContext.Provider value={historyPayloadContextValue}>
        <HistoryBackgroundLiveContext.Provider value={liveBackgroundUuids}>
        <HistoryBackgroundTaskCallContext.Provider value={liveBackgroundTaskCalls}>
        <HistoryAgentInspectorContext.Provider value={agentInspectorController}>
        {/* The two extra conditions skip mounting the list during commits
            that are guaranteed to be replaced BEFORE the browser paints:
            (1) the transitional commit right after the owner prop changed
            (the takeover layout effect re-renders synchronously), and
            (2) the pre-takeover commits of a fresh panel (visit is still 0
            until the first takeover effect publishes a generation). Both
            used to mount a full Virtuoso + heavy rows under a key that the
            very next synchronous render discarded — every warm switch paid
            the list mount TWICE inside one frame. The stub is never visible:
            no paint happens between these commits. */}
        {surfaceLoading || ownerChangedBeforeLayoutHandoff || historyOwnerVisit === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#818cf8', fontSize: 13, gap: 8 }}>
            <HistorySpinner size={16} />
            Loading...
          </div>
        ) : transcriptEntries.length === 0 && !visibleTerminalPreview ? (
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
            // `restoreStateFrom` is consumed once per PHYSICAL mount. A stable
            // persistent-pane visit is opacity/inert only, so its ready
            // Virtuoso must keep the same key and measured DOM. Owner takeover
            // or a proven geometry change advances restoredLayoutVisitKey and
            // performs the one legitimate remount/restore transaction.
            key={restoredLayoutVisitKey}
            ref={virtuosoRef}
            data={displayUnits}
            itemSize={measureHistoryVirtuosoItemSize}
            components={HISTORY_VIRTUOSO_COMPONENTS}
            context={historyVirtuosoContext}
            // Live and durable versions use one physical identity, so a
            // completed answer updates in place instead of unmounting between
            // the rollout event and the durable History refresh. A collapsed
            // group keys by its own stable group key (first call id).
            computeItemKey={(_idx) => displayUnitItemKeys[_idx]}
            // Mount the scroller against our handleScroll so the per-scroll
            // FAB toggle / position-save stays identical to pre-virtuoso behavior.
            scrollerRef={handleHistoryVirtuosoScrollerRef}
            rangeChanged={(range) => {
              visibleRangeRef.current = { start: range.startIndex, end: range.endIndex };
              scheduleTerminalPreviewHandoffWake(
                'range-changed:' + range.startIndex + '-' + range.endIndex,
              );
              // Row-window: the viewport moved — check whether the readable
              // span still covers where the user is heading.
              scheduleHistoryHydrationRangeCheck();
              if (mountWaveActiveRef.current && mountWaveLaneRef.current) {
                // Range publications are the other "rows are mounted now"
                // signal — covers restores/jumps that mount a NEW set of
                // shells after the initial arm already drained its queue.
                requestHistoryMountWaveStep(mountWaveLaneRef.current);
              }
              const presentationAtRange = historyPresentationProofRef.current;
              if (!presentationAtRange.presented) return;
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
                  // A mount-wave shell is a real WRAPPER but not real CONTENT
                  // — declaring the viewport ready on one would drop the
                  // loader over placeholder bars and (worse) release the
                  // Timeline gate for a surface that has painted nothing.
                  // Readiness means at least one REAL card of this owner.
                  () => {
                    if (
                      historyOwnerKeyRef.current !== ownerAtRange
                      || historyOwnerGenerationRef.current !== generationAtRange
                      || !historyPresentationOwnsWrite(
                        historyPresentationProofRef.current,
                        presentationAtRange.visit,
                      )
                    ) return false;
                    const row = virtuosoScrollerRef.current?.querySelector(
                      `[data-history-row-real][data-history-row-owner="${CSS.escape(historyOwnerDomId)}"]`,
                    ) as HTMLElement | null;
                    return !!row && row.getBoundingClientRect().height > 0;
                  },
                  () => {
                    if (
                      historyOwnerKeyRef.current !== ownerAtRange
                      || historyOwnerGenerationRef.current !== generationAtRange
                      || !historyPresentationOwnsWrite(
                        historyPresentationProofRef.current,
                        presentationAtRange.visit,
                      )
                    ) return;
                    consumeHistoryViewportPaintProof({
                      ownerKey: ownerAtRange,
                      generation: generationAtRange,
                      presentationVisit: presentationAtRange.visit,
                      proof: 'mounted-painted-row',
                      domRows: 1,
                      source: 'range-paint-probe:' + range.startIndex + '-' + range.endIndex,
                    });
                  },
                );
              }
              const presentedProofKey = historyOwnerKey + ':' + viewportPaintOwner.generation
                + ':pv' + presentationAtRange.visit;
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
                      || !historyPresentationOwnsWrite(
                        historyPresentationProofRef.current,
                        presentationAtRange.visit,
                      )
                    ) return false;
                    // Same real-content requirement as the viewport probe: a
                    // mount-wave shell must not produce SURFACE_PRESENTED —
                    // Timeline replays this proof and would hydrate against a
                    // surface of placeholder bars.
                    const row = virtuosoScrollerRef.current?.querySelector(
                      `[data-history-row-real][data-history-row-owner="${CSS.escape(historyOwnerDomId)}"]`,
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
                      || !historyPresentationOwnsWrite(
                        historyPresentationProofRef.current,
                        presentationAtRange.visit,
                      )
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
                      + ' presentationVisit=' + presentationAtRange.visit
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
                      presentationVisit: presentationAtRange.visit,
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
                    const layoutItemKeys = displayUnitLayoutKeysRef.current;
                    const layoutItems = layoutItemKeys.length;
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                    if (!historyPresentationOwnsWrite(
                      historyPresentationProofRef.current,
                      presentationAtRange.visit,
                    )) return;
                    // A restore hunt still owns the scroller two frames after
                    // presentation on cold tail returns — its jump positions
                    // are not a baseline worth keeping, and the hunt's own
                    // settle banks the real one.
                    if (historyRestoreInFlightRef.current) return;
                    // Mid-wave the list is mostly shells; their heights are
                    // real only when they came FROM the store. Snapshotting
                    // now would bank avg-estimated shells as measurements —
                    // the wave-done step does the baseline save instead.
                    if (mountWaveActiveRef.current) return;
                    try {
                      virtuosoRef.current?.getState((snapshot) => {
                        if (historyOwnerKeyRef.current !== ownerAtRange) return;
                        if (!historyPresentationOwnsWrite(
                          historyPresentationProofRef.current,
                          presentationAtRange.visit,
                        )) return;
                        const saved = saveHistoryMeasuredLayout(
                          ownerAtRange, snapshot as any, layoutItemKeys,
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
            // Scrollbar scrub / hard fling renders flat placeholders instead
            // of full markdown rows — mounting-and-discarding dozens of heavy
            // cards per frame is what made fast scrolling stutter. Real rows
            // return as soon as velocity drops (see the config's exit gate).
            scrollSeekConfiguration={historyScrollSeekController.configuration}
            // Per-owner measured average for rows not yet measured. Without
            // it Virtuoso sizes the unknown region from the FIRST measured
            // row — a 40px prompt or a 500px diff card — and the scrollbar
            // thumb lurches every time a newly mounted row corrects the
            // estimate mid-scrub.
            defaultItemHeight={historyDefaultRowHeight}
            // Measured geometry from the previous visit to this same owner.
            // With it Virtuoso places the list from REAL sizes instead of
            // estimating and being corrected frame by frame. Mutually
            // exclusive with initialTopMostItemIndex — the snapshot already
            // carries its own scroll offset, and passing both makes the two
            // fight over the initial position.
            {...(restoredMeasuredLayout
              ? { restoreStateFrom: restoredMeasuredLayout as any }
              : { initialTopMostItemIndex })}
            // Tail following is user intent, not instantaneous geometry. A
            // growing footer moves the physical bottom before our next frame;
            // that must keep following. Wheel/touch/keyboard/scrollbar actions
            // explicitly turn the intent off, and reaching the tail turns it on.
            followOutput={historyFollowOutputEnabled ? 'auto' : false}
            // Virtuoso normally defers a ResizeObserver measurement to the
            // next rAF. A newly mounted variable-height row is then painted
            // once with its estimate and corrected one frame later — the
            // visible up/down flash from both 26.08 incidents. Immediate
            // measurement keeps the size publication in the same rendering
            // opportunity; the semantic wheel anchor above owns any resulting
            // position correction.
            skipAnimationFrameInResizeObserver
            className="hp-history-transcript"
            style={{
              height: '100%',
              // Virtuoso is the sole geometry owner. Chromium scroll
              // anchoring would otherwise be a second, unattributed writer
              // beside Virtuoso's own resize compensation.
              overflowAnchor: 'none',
              fontSize: historyFontSize,
              ['--cb-fs-base' as any]: '1em',
              // SyntaxHighlighter needs a concrete length, not a row count.
              // 0.92em × 1.5 line-height × N plus its 20px vertical padding.
              ['--cb-markdown-code-max-height' as any]:
                Math.ceil(historyFontSize * 0.92 * 1.5 * historyMarkdownCodeMaxLines + 20) + 'px',
            }}
            itemContent={(_idx, unit) => {
              // ---- Group header unit (collapsed OR expanded) ----
              if ((unit as any).kind === 'group') {
                const group = unit as any;
                const groupExpanded = group.expanded === true;
                const groupAnchorUuid = group.entries[0]?.uuid || '';
                const groupChainBreak =
                  claudeMemoryBoundaryIndex >= 0 && _idx <= claudeMemoryBoundaryIndex;
                const parentGroup = group.parentGroup as
                  | { key: string; familyKey: string; uniform?: boolean; first: boolean; last: boolean }
                  | undefined;
                const headerNode = (
                  <div
                    // When expanded, the first MEMBER row carries the anchor
                    // uuid as data-uuid; the header must not duplicate it or
                    // uuid-driven DOM lookups (restore, search highlight)
                    // would find two nodes.
                    data-uuid={groupExpanded ? undefined : groupAnchorUuid}
                    data-history-row-owner={historyOwnerDomId}
                    data-history-row-real="1"
                    data-history-unit-key={displayUnitItemKeys[_idx]}
                    data-history-group={group.key}
                    style={{
                      paddingTop: 2,
                      paddingBottom: 2,
                      backgroundColor: groupChainBreak ? 'rgba(239, 68, 68, 0.06)' : undefined,
                    }}
                  >
                    <HistoryCollapsedGroupRow
                      group={group}
                      expanded={groupExpanded}
                      liveBackgroundUuids={liveBackgroundUuids}
                      isTurnBusy={isTurnBusy}
                      isLastUnit={_idx === displayUnits.length - 1}
                      onToggle={() => {
                        if (groupExpanded) {
                          historyDiag('GROUP_COLLAPSE tab=' + tabId.slice(-12)
                            + ' key=' + group.key.slice(0, 24)
                            + ' reason=click');
                          collapseGroupPreservingViewport(group.key);
                        } else {
                          expandGroupPreservingViewport(group.key, 'click');
                        }
                      }}
                    />
                  </div>
                );
                if (!parentGroup) return headerNode;
                return (
                  <div
                    data-history-row-owner={historyOwnerDomId}
                    data-history-row-real="1"
                    data-history-unit-key={displayUnitItemKeys[_idx]}
                    className="hp-history-group-member"
                    data-history-group-member={parentGroup.key}
                    data-history-group-uniform={parentGroup.uniform ? '1' : undefined}
                    data-history-group-last={parentGroup.last ? '1' : undefined}
                    style={{
                      backgroundColor: groupChainBreak ? 'rgba(239, 68, 68, 0.06)' : undefined,
                    }}
                  >
                    <HistoryGroupRail
                      groupKey={parentGroup.key}
                      onCollapse={collapseGroupFromFoot}
                    />
                    {headerNode}
                    {parentGroup.last && (
                      <HistoryGroupFoot
                        groupKey={parentGroup.key}
                        onCollapse={collapseGroupFromFoot}
                      />
                    )}
                  </div>
                );
              }
              const entryUnit = unit as any;
              const entry = entryUnit.entry as FullHistoryEntry;
              const expandedGroup = entryUnit.expandedGroup as
                | { key: string; familyKey: string; uniform?: boolean; first: boolean; last: boolean }
                | undefined;
              const expandedSubgroup = entryUnit.expandedSubgroup as
                | { key: string; familyKey: string; docsKind?: string; first: boolean; last: boolean }
                | undefined;
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
              // Mount wave: rows that existed at visit mount render an
              // exact-height shell until their upgrade step commits. Rows
              // NOT in the shell set (streamed in during the wave) render
              // real immediately. The wrapper stays the real one either way
              // — context menu, uuid identity and tint are never deferred.
              // Row-window stub: main shipped this row's identity only (see
              // applyHistoryRowWindow). It renders exactly like a mount-wave
              // shell — same wrapper, same stored height — because it is the
              // same promise to Virtuoso: this row occupies these pixels, its
              // content arrives later. The difference is who fills it: the
              // wave upgrades locally, a stub needs main to hydrate it, which
              // the viewport watcher below requests.
              if ((presentedEntry as any).rowStub) {
                const stubHeight = mountWaveMetaRef.current?.heightLookup?.(_idx)
                  ?? historyRowHeightLookup(_idx);
                return (
                  <div
                    data-uuid={presentedEntry.uuid}
                    data-history-row-owner={historyOwnerDomId}
                    data-history-mount-shell="1"
                    data-history-row-stub="1"
                    data-history-unit-key={displayUnitItemKeys[_idx]}
                    onContextMenu={(event) => openHistoryEntryContextMenu(event, presentedEntry, toolType)}
                    style={{
                      paddingTop: 4,
                      paddingBottom: 4,
                      height: stubHeight,
                      boxSizing: 'border-box',
                      overflow: 'hidden',
                      backgroundColor: isChainBreakZone ? 'rgba(239, 68, 68, 0.06)' : undefined,
                    }}
                  >
                    <HistoryMountShellBody index={_idx} />
                  </div>
                );
              }
              const waveMeta = mountWaveMetaRef.current;
              const asShell =
                mountWaveActive
                && waveMeta?.visitKey === restoredLayoutVisitKey
                && waveMeta.shellUuids.has(presentedEntry.uuid)
                && !mountWaveRenderState.realUuids.has(presentedEntry.uuid);
              if (asShell && waveMeta) {
                return (
                  <div
                    data-uuid={presentedEntry.uuid}
                    data-history-row-owner={historyOwnerDomId}
                    data-history-mount-shell="1"
                    data-history-unit-key={displayUnitItemKeys[_idx]}
                    onContextMenu={(event) => openHistoryEntryContextMenu(event, presentedEntry, toolType)}
                    style={{
                      paddingTop: 4,
                      paddingBottom: 4,
                      // The wrapper adds 8px vertical padding around the
                      // card; the stored size is the WRAPPER's measured
                      // height, so the inner body gets size minus padding —
                      // giving the wrapper exactly the stored pixels.
                      height: waveMeta.heightLookup(_idx),
                      boxSizing: 'border-box',
                      overflow: 'hidden',
                      backgroundColor: isChainBreakZone ? 'rgba(239, 68, 68, 0.06)' : undefined,
                    }}
                  >
                    <HistoryMountShellBody index={_idx} />
                  </div>
                );
              }
              const entryBody = (
                <>
                  <HistoryEntry
                    entry={presentedEntry}
                    tabId={tabId}
                    toolType={toolType}
                    allowRewind={!previewMode && toolType !== 'gemini'}
                    rewindLocked={historyRewindLocked}
                    rewindUnavailableReason={historyRewindUnavailableReason}
                    allowHistoryRewriteRewind={
                      !previewMode
                      && (toolType === 'claude' || toolType === 'codex')
                      && !!sessionId
                    }
                    historyRewriteRewindLocked={historyRewriteRewindLocked}
                    historyRewriteRewindUnavailableReason={historyRewriteRewindUnavailableReason}
                    onHistoryRewriteRewind={executeHistoryRewriteRewind}
                    onDismissPromptPresentation={dismissPromptPresentation}
                    onDismissRewindPresentation={dismissLocalRewindPresentation}
                    forceExpanded={
                      searchQuery.length >= 2
                      && entry.content.toLowerCase().includes(searchQuery.toLowerCase())
                    }
                  />
                </>
              );
              return (
                <div
                  data-uuid={presentedEntry.uuid}
                  data-history-row-owner={historyOwnerDomId}
                  data-history-row-real="1"
                  data-history-unit-key={displayUnitItemKeys[_idx]}
                  data-history-live-entry={presentedEntry.liveProjection ? '1' : undefined}
                  data-history-durable-source={
                    !presentedEntry.liveProjection
                      ? presentedEntry.sourceIdentity || undefined
                      : undefined
                  }
                  onContextMenu={(event) => openHistoryEntryContextMenu(event, presentedEntry, toolType)}
                  style={{
                    // Member rows tile FLUSH: any wrapper padding would cut
                    // the group rail into segments (the member's border-left
                    // cannot reach across it).
                    paddingTop: expandedGroup || expandedSubgroup ? 0 : 4,
                    paddingBottom: expandedGroup || expandedSubgroup ? 0 : 4,
                    backgroundColor: isChainBreakZone ? 'rgba(239, 68, 68, 0.06)' : undefined,
                    ...(flashUuid === presentedEntry.uuid ? { animation: 'hp-flash 500ms ease-in-out' } : undefined),
                  }}
                >
                  {expandedGroup ? (
                    // Member of an expanded group: indented under the rail.
                    // Collapsing happens on the group HEADER above or anywhere
                    // along this member's rail (the foot is its final glyph),
                    // so a long block never requires scrolling back to its top.
                    <div
                      className="hp-history-group-member"
                      data-history-group-member={expandedGroup.key}
                      data-history-group-uniform={expandedGroup.uniform ? '1' : undefined}
                      data-history-group-last={expandedGroup.last ? '1' : undefined}
                    >
                      <HistoryGroupRail
                        groupKey={expandedGroup.key}
                        onCollapse={collapseGroupFromFoot}
                      />
                      {expandedSubgroup ? (
                        <div
                          className="hp-history-subgroup-member"
                          data-history-subgroup-member={expandedSubgroup.key}
                          data-history-subgroup-last={expandedSubgroup.last ? '1' : undefined}
                          data-history-docs-kind={expandedSubgroup.docsKind || undefined}
                        >
                          <HistoryGroupRail
                            groupKey={expandedSubgroup.key}
                            onCollapse={collapseGroupFromFoot}
                            title="Свернуть серию"
                            nested
                          />
                          {entryBody}
                          {expandedSubgroup.last && (
                            <HistoryGroupFoot
                              groupKey={expandedSubgroup.key}
                              onCollapse={collapseGroupFromFoot}
                              title="Свернуть серию"
                            />
                          )}
                        </div>
                      ) : entryBody}
                      {expandedGroup.last && (
                        <HistoryGroupFoot
                          groupKey={expandedGroup.key}
                          onCollapse={collapseGroupFromFoot}
                        />
                      )}
                    </div>
                  ) : expandedSubgroup ? (
                    <div
                      className="hp-history-subgroup-member hp-history-subgroup-member--root"
                      data-history-subgroup-member={expandedSubgroup.key}
                      data-history-subgroup-last={expandedSubgroup.last ? '1' : undefined}
                      data-history-docs-kind={expandedSubgroup.docsKind || undefined}
                    >
                      <HistoryGroupRail
                        groupKey={expandedSubgroup.key}
                        onCollapse={collapseGroupFromFoot}
                        title="Свернуть серию"
                        nested
                      />
                      {entryBody}
                      {expandedSubgroup.last && (
                        <HistoryGroupFoot
                          groupKey={expandedSubgroup.key}
                          onCollapse={collapseGroupFromFoot}
                          title="Свернуть серию"
                        />
                      )}
                    </div>
                  ) : entryBody}
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
        </HistoryAgentInspectorContext.Provider>
        </HistoryBackgroundTaskCallContext.Provider>
        </HistoryBackgroundLiveContext.Provider>
        </HistoryPayloadContext.Provider>
        {/* «Выдвинуть вторую поверхность» — вплотную над полем ввода, у правого
            края. Стоит ВСЕГДА, в отличие от стрелки слева от него: это орган
            управления раскладкой, и он не должен появляться и исчезать от
            прокрутки транскрипта — иначе за ним пришлось бы охотиться.

            ПРАВЫЙ КРАЙ КНОПКИ = ПРАВЫЙ КРАЙ РАМКИ ПОЛЯ ВВОДА. Не «примерно
            там же»: пользователь требовал совпадения по вертикали, и глаз ловит
            рассинхрон в 4px мгновенно, потому что рамка рисует эту линию.
            Поэтому отступ берётся из ЕДИНСТВЕННОГО источника — из того же
            числа, которым сама панель управления отодвинута от края
            (HISTORY_COMPOSER_SIDE_INSET). Своё независимое число здесь уже
            один раз разъехалось: у кнопки был `centerRightInset + 12`, а у
            рамки — свои 16px, и кнопка встала на 4px правее линии. */}
        {mainSurface && (
          <div
            data-history-side-surface-toggle
            style={{
              position: 'absolute',
              // 1px над рамкой поля — «буквально в расстоянии одного пикселя».
              // Поле теперь обычная нижняя строка колонки, поэтому низ этой
              // области = верхняя граница рамки; вычитать её высоту не нужно.
              bottom: 1,
              right: centerRightInset + HISTORY_COMPOSER_SIDE_INSET,
              zIndex: 10,
            }}
          >
            <SideSurfaceToggleButton tabId={tabId} size={28} />
          </div>
        )}
        {/* Scroll-to-bottom arrow — visibility toggled via ref in handleScroll.
            When this panel is the CENTER surface it must dodge the right-docked
            side panel, exactly like the Run after strip and the terminal's own
            arrow (shared arithmetic in surfaceInsets). As a side panel it insets
            nothing: its own bottom-right corner is already clear, and shifting
            it would push the control out of the panel it belongs to.

            Слева от кнопки раскладки, в 2px: пара стоит в одном месте, и стрелка
            не занимает её позицию, когда прячется. В боковой панели кнопки
            раскладки нет (она принадлежит центральной поверхности), поэтому там
            стрелка остаётся у самого края. */}
        <ControlHint label="Прокрутить History вниз">
        <div
          ref={scrollArrowRef}
          data-history-scroll-to-bottom
          className="flex items-center justify-center"
          onClick={() => scrollToBottom(false)}
          style={{
            display: 'none',
            position: 'absolute',
            bottom: mainSurface ? 1 : 12,
            right: mainSurface
              ? centerRightInset + HISTORY_COMPOSER_SIDE_INSET + 28 + 2
              : 12,
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

      {(backgroundHistoryChips.length > 0 || historyAgentChips.length > 0) && (
        // Only the compact chip-row owns normal-flow height. Its Inspector is
        // an absolute popover upward, so opening/loading/switching a child
        // transcript never changes the History viewport or a Virtuoso row.
        <div data-history-agent-dock style={{ flex: '0 0 auto', width: '100%', minWidth: 0, zIndex: 7 }}>
          <HistoryBackgroundTasksBar
            chips={backgroundHistoryChips}
            agents={historyAgentChips}
            selectedKey={expandedBackgroundChipKey}
            rosterOpen={agentRosterOpen}
            onToggleDetail={toggleHistoryDetail}
            onToggleRoster={() => setAgentRosterOpen((current) => !current)}
            onSelectAgent={openHistoryAgent}
            onJumpToCard={(entryUuid) => setHistoryScrollToUuid(entryUuid, tabId)}
            tabId={tabId}
            toolType={toolType}
            cwd={cwd}
            sessionId={sessionId || ''}
          />
        </div>
      )}

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
