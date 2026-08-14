import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo, startTransition } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Copy, Minimize2, Pencil, Search, Trash2, StickyNote, ChevronDown, Check, Scissors, X, Zap, RefreshCw, Repeat2, ArrowUpToLine } from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import ControlHint from '../UI/ControlHint';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { markRendererActivity } from '../../utils/rendererActivityTrail';
import { useUIStore, type HistoryPromptDraftImageRef } from '../../store/useUIStore';
import { useWorkspaceStore, type PendingAutoTabTitle } from '../../store/useWorkspaceStore';
import { useRewindOperationStore } from '../../store/useRewindOperationStore';
import {
  classifyRewindCancelReply,
  isRewindOperationCancellable,
  makeRewindOperationKey,
  selectActiveRewindOperation,
  selectRewindOperation,
  type RewindOperation,
  type RewindOperationMode,
} from '../../store/rewindOperationState';
import { TAB_TITLE_PROMPT_ID, TIMELINE_GROUPING_PROMPT_ID, usePromptsStore } from '../../store/usePromptsStore';
import { generateTabTitleFromPrompt, generateTimelineActionLabelFromPrompt, isEligibleTabTitleEntry, trimTabTitlePrompt } from '../../utils/generateTabTitle';
import { timelineSummaryKey, timelineSummarySourceHash, useTimelineSummaryStore, type TimelineSummaryTool } from '../../store/useTimelineSummaryStore';
import {
  timelineOutlineKey,
  useTimelineOutlineStore,
  type TimelineSemanticGroup,
} from '../../store/useTimelineOutlineStore';
import { buildCodexRunPayload } from '../../utils/codexLaunch';
import { requireConfirmedCodexWriter } from '../../utils/codexWriterIdentity';
import { requireCommittedCodexRewind } from '../../utils/codexRewindCommit';
import {
  prepareCodexRewindRuntime,
  revalidatePreparedCodexRewindRuntime,
  type PreparedCodexRewindRuntime,
} from '../../utils/agentScenarios';
import {
  getHistoryAgentRuntime,
  type AgentHistoryTool,
  type AgentPtyPresence,
  type AgentPtyStatus,
} from '../../utils/historyAgentRuntimes';
import type { HistoryDurableRevision } from '../../utils/historySnapshotCache';
import { shouldClearRewindPreviewForOwnerTransition } from '../../utils/historyRewindPreviewOwner';
import {
  matchesHistorySurfacePresented,
  planTimelineTranscriptRefresh,
  readPresentedHistorySurface,
} from '../../utils/timelineTranscriptRefresh.mjs';
import {
  buildTimelineCornerBadges,
  collectTimelineDocs,
  isTimelineGroupExpanded,
  timelineMarkerGeometry,
} from '../../utils/timelineMarkerPresentation.mjs';
import {
  normalizeForkMarkerEntryUuids,
  normalizeForkMarkers,
} from '../../utils/forkMarkerSnapshot.mjs';
import { buildClaudeRewindPromptProjection } from '../../utils/composerChips.mjs';
import { waitForClaudeStartupDefaultsReadyWithVisibleFallback } from '../../utils/claudeStartupDefaultsReady';
import EditRangePanel from './EditRangePanel';
import HoverBridgeDebug from '../HoverBridgeDebug';

const { ipcRenderer, clipboard } = window.require('electron');

// ════════════════════════════════════════════════════════════
// SECTION: HELPERS — module-level pure functions, types, module state
// ════════════════════════════════════════════════════════════

function isTimelineTextSearchDiagEnabled(): boolean {
  try {
    return (window as any).__TIMELINE_TEXT_SEARCH_DIAG__ === true
      || localStorage.getItem('noted-terminal-debug-timeline-text-search') === '1';
  } catch {
    return false;
  }
}

function warnTimelineTextSearchDiag(message: string) {
  if (isTimelineTextSearchDiagEnabled()) {
    console.warn(message);
  }
}

const REWIND_BUSY_GUARD_RE = /\bis busy; wait for the current turn before rewind\b/i;
const HISTORY_SCROLL_SAFETY_TIMEOUT_MS = 8000;
const EXPANDED_PREVIEW_CHARS_PER_LINE = 180;
const EXPANDED_PREVIEW_MIN_CHARS = 240;
const EXPANDED_PREVIEW_MAX_CHARS = 1800;
const rewindGeminiAbortControllers = new Map<string, AbortController>();
const EXPANDED_PREVIEW_TITLE_MAX_CHARS = 2000;

function isRewindBusyGuardMessage(message: string): boolean {
  return REWIND_BUSY_GUARD_RE.test(message);
}

function emitHistoryAgentError(tabId: string, message: string) {
  window.dispatchEvent(new CustomEvent('history-panel:agent-error', {
    detail: { tabId, message }
  }));
}

function expandedPreviewCharLimit(lineClamp: number): number {
  const n = Number.isFinite(lineClamp) ? Math.max(1, Math.floor(lineClamp)) : 3;
  return Math.max(
    EXPANDED_PREVIEW_MIN_CHARS,
    Math.min(EXPANDED_PREVIEW_MAX_CHARS, n * EXPANDED_PREVIEW_CHARS_PER_LINE)
  );
}

function truncateTimelinePreviewText(text: string, maxChars: number): string {
  if (!text) return '';
  const startMatch = /\S/.exec(text);
  if (!startMatch) return '';
  const start = startMatch.index;
  if (text.length - start <= maxChars) {
    return text.slice(start).trimEnd();
  }
  return text.slice(start, start + maxChars).trimEnd() + '…';
}

// True when an entry is NOT a regular user prompt. `isCompactSummary` can still
// arrive as type:"user" in Claude JSONL, but it is the visible compact body,
// not a terminal prompt with its own scroll/boundary position.
// If a new attribute-style entry type is ever added, update this ONE place.
function isAttributeEntry(entry: { type?: string; isCompactSummary?: boolean }): boolean {
  if (entry.isCompactSummary) return true;
  return entry.type === 'compact' || entry.type === 'continued'
    || entry.type === 'docs_edit' || entry.type === 'docs_search';
}

const DOCS_TIMELINE_COLORS = {
  edited: {
    hover: '#86efac',
    visible: '#4ade80',
    dim: '#22c55e',
    glow: '74, 222, 128',
    tooltip: 'rgba(74, 222, 128, 0.9)',
    tooltipMuted: 'rgba(74, 222, 128, 0.82)',
    borderClass: 'border-green-500/15',
    hoverClass: 'hover:bg-green-500/5',
  },
  search: {
    hover: '#d9f99d',
    visible: '#bef264',
    dim: '#84cc16',
    glow: '190, 242, 100',
    tooltip: 'rgba(190, 242, 100, 0.9)',
    tooltipMuted: 'rgba(190, 242, 100, 0.82)',
    borderClass: 'border-lime-500/15',
    hoverClass: 'hover:bg-lime-500/5',
  },
} as const;

type TimelineCornerBadgeItem = {
  kind: 'count' | 'loop' | 'docs-edit' | 'docs-search';
  slot: 'top-right' | 'middle-right' | 'bottom-right' | 'middle-inner';
  text?: string;
  tone?: 'compact' | 'group' | null;
};

const TimelineCornerBadges: React.FC<{
  items: TimelineCornerBadgeItem[];
  isExpandedLayout: boolean;
  timelineFontSize: number;
  groupAccent: string;
}> = ({ items, isExpandedLayout, timelineFontSize, groupAccent }) => {
  const rightColumnCount = items.filter(item => item.slot.endsWith('right')).length;
  const dense = !isExpandedLayout && rightColumnCount >= 3;

  return <>
    {items.map((badge) => {
      const isInner = badge.slot === 'middle-inner';
      const isTop = badge.slot === 'top-right';
      const isBottom = badge.slot === 'bottom-right';
      const positionStyle: React.CSSProperties = {
        position: 'absolute',
        zIndex: 2,
        right: isExpandedLayout
          ? (isInner ? '18px' : '5px')
          : (isInner ? '10px' : '2px'),
        ...(isTop
          ? { top: isExpandedLayout ? '3px' : '1px' }
          : isBottom
            ? { bottom: isExpandedLayout ? '3px' : '1px' }
            : { top: '50%', transform: 'translateY(-50%)' }),
      };

      if (badge.kind === 'count') {
        const compact = badge.tone === 'compact';
        return (
          <span
            key={`${badge.kind}:${badge.slot}`}
            className="pointer-events-none select-none"
            aria-label={compact ? `${badge.text} compacts` : `${badge.text} grouped calls`}
            style={{
              ...positionStyle,
              color: compact ? '#f2bf58' : groupAccent,
              fontFamily: 'monospace',
              fontSize: isExpandedLayout ? '9px' : (dense ? '8px' : '9px'),
              fontWeight: compact ? 700 : 600,
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
              textShadow: compact ? '0 1px 2px rgba(0, 0, 0, 0.85)' : undefined,
            }}
          >
            {badge.text}
          </span>
        );
      }

      const size = isExpandedLayout
        ? Math.max(7, Math.min(9, Math.round(timelineFontSize * 0.62)))
        : (dense ? 6 : 7);
      const Icon = badge.kind === 'loop'
        ? Repeat2
        : badge.kind === 'docs-edit'
          ? Pencil
          : Search;
      const color = badge.kind === 'loop'
        ? '#60a5fa'
        : badge.kind === 'docs-edit'
          ? DOCS_TIMELINE_COLORS.edited.visible
          : DOCS_TIMELINE_COLORS.search.visible;
      return (
        <Icon
          key={`${badge.kind}:${badge.slot}`}
          className="pointer-events-none select-none"
          aria-label={badge.kind}
          size={size}
          strokeWidth={2.2}
          color={color}
          style={positionStyle}
        />
      );
    })}
  </>;
};

// Portal for tooltip to escape overflow:hidden
const TooltipPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return createPortal(
    <div data-timeline-portal style={{ display: 'contents' }}>
      {children}
    </div>,
    document.body,
  );
};

// Portal for status labels (Rewinding, Copying) to stay on top of all panels
const StatusLabelPortal: React.FC<{
  label: string;
  top: number;
  rightOffset: number;
  color: string;
  className?: string;
}> = ({ label, top, rightOffset, color }) => {
  return createPortal(
    <div
      data-timeline-portal
      className="fixed pointer-events-none transition-all duration-300"
      style={{
        top,
        right: rightOffset,
        zIndex: 9999,
        backgroundColor: '#1a1a1a', // Dark theme background
        padding: '3px 8px',
        borderRadius: '4px',
        border: '1px solid #444',
        boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
        transform: 'translateY(-50%)',
      }}
    >
      <span
        className="text-[10px] font-bold tracking-widest uppercase text-white/90"
      >
        {label}
      </span>
    </div>,
    document.body
  );
};

interface TimelineEntry {
  uuid: string;
  type: 'user' | 'compact' | 'continued' | 'docs_edit' | 'docs_search';
  timestamp: string;
  content: string;
  isCompactSummary?: boolean;
  compactSummary?: string;
  preTokens?: number;
  hasImage?: boolean;
  sessionId?: string;
  isPlan?: boolean;
  isSubAgent?: boolean;
  isSubAgentTimeout?: boolean;
  subAgentName?: string;
  subAgentTaskId?: string;
  docsEdited?: string[];
  docsSearchQueries?: string[];
  semanticTags?: Array<{
    id?: string;
    kind: 'orchestration';
    runId: string;
    phase: 'request' | 'completion' | 'failure';
    parentRunId?: string;
    sourceTabId?: string;
    targetTabId?: string;
    outcome?: string;
  } | {
    id?: string;
    kind: 'prompt-origin';
    source: 'loop';
  }>;
  responseTokens?: number;
  responseModel?: string;          // last assistant.message.model for this turn (e.g. 'deepseek-v4-flash', 'claude-opus-4-7')
  responseHasThinking?: boolean;   // any assistant content block of type 'thinking' in this turn
  sourceLine?: number;
  // Codex-only per-turn API usage from last_token_usage (honest per-entry, see codex-data.js).
  // Input split = uncached + cache-read (Codex has no cache_creation); output split = answer + reasoning.
  codexUsage?: {
    inputCached: number;
    inputUncached: number;
    outputAnswer: number;
    outputReasoning: number;
  };
  // Codex-only subscription quota snapshot at this turn. resets_at = ISO string
  // (normalizeCodexReset converts epoch→ISO; same shape the toolbar usage chip uses).
  codexLimits?: {
    fiveHourPct: number | null;
    fiveHourResetsAt: string | null;
    weeklyPct: number | null;
    weeklyResetsAt: string | null;
    planType: string | null;
  };
}

type DeleteScope = 'selection' | 'through-start';

interface GroupInfo {
  isGroupHeader: boolean;
  isGroupChild: boolean;
  groupId: string;
  groupSize: number;
  agentName: string;
  hasTimeout: boolean;
  groupKind: 'subagent' | 'orchestration';
  startIndex: number; // first entry index in the group
}

interface SessionBoundary {
  childSessionId: string;
  parentSessionId: string;
}

// Progressive expand ("wave") tuning. Expansion lands at the tail, so only
// the last N rows need full presentation immediately; rows above upgrade in
// batches across frames until every row is real. Stubs keep entry identity
// (key/uuid/ref) so the visibility system and jumps stay canonical, and each
// stub reserves a plausible row height so the scrollbar doesn't collapse.
const TIMELINE_EXPAND_INITIAL_ROWS = 120;
const TIMELINE_EXPAND_BATCH_ROWS = 200;

interface TimelineProps {
  tabId: string;
  sessionId: string | null;
  cwd: string;
  isActive?: boolean; // Claude/Gemini is currently running
  isTurnBusy?: boolean; // One agent turn is streaming; durable refresh waits for its outcome
  isVisible?: boolean; // New prop to control visibility from parent
  isOpen?: boolean; // CMD+\ toggle — controls slide in/out
  toolType?: 'claude' | 'gemini' | 'codex'; // Which AI tool this timeline is for
  pinned?: boolean; // When true, expanded Timeline reserves layout width instead of overlaying terminal
  readOnly?: boolean; // Home preview: Timeline only navigates HistoryPanel
  historySurfaceVisible?: boolean; // Primary History replaces xterm without opening the legacy side panel
}

interface CodexTimelineSessionMeta {
  id?: string;
  forked_from_id?: string;
  timestamp?: string;
  cwd?: string;
  sourceLine?: number;
  forkLiveStartLine?: number;
}

function sessionIdLooseMatch(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function renderSingleStarHighlights(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    const open = text.indexOf('*', cursor);
    if (open < 0 || text[open - 1] === '*' || text[open + 1] === '*') {
      nodes.push(text.slice(cursor));
      break;
    }
    const close = text.indexOf('*', open + 1);
    if (close < 0 || close === open + 1 || text[close - 1] === '*' || text[close + 1] === '*') {
      nodes.push(text.slice(cursor));
      break;
    }
    if (open > cursor) nodes.push(text.slice(cursor, open));
    nodes.push(
      <span key={`hl-${key++}`} style={{ color: '#69dbdb', fontWeight: 700 }}>
        {text.slice(open + 1, close)}
      </span>
    );
    nodes.push(text.slice(close + 1).replace(/\*/g, ''));
    break;
  }
  return nodes;
}

function selectAutoTabTitlePrompt(
  entries: TimelineEntry[],
  pending: PendingAutoTabTitle,
  toolType: 'claude' | 'codex',
  forkMarkers: ForkMarker[],
  forkMarkerLastSnapIndex: number[],
  codexSessionMeta: CodexTimelineSessionMeta | null
): TimelineEntry | undefined {
  if (pending.mode !== 'fork') {
    return entries.find(isEligibleTabTitleEntry);
  }

  if (toolType === 'claude') {
    if (forkMarkers.length === 0) return undefined;
    const boundaryIndex = forkMarkerLastSnapIndex.length > 0
      ? Math.max(...forkMarkerLastSnapIndex)
      : -1;
    return entries.find((entry, index) => index > boundaryIndex && !getOrchestrationTag(entry) && isEligibleTabTitleEntry(entry));
  }

  const forkedFromId = codexSessionMeta?.forked_from_id;
  if (pending.sourceSessionId && forkedFromId && !sessionIdLooseMatch(forkedFromId, pending.sourceSessionId)) {
    return undefined;
  }

  const forkLiveStartLine = typeof codexSessionMeta?.forkLiveStartLine === 'number'
    ? codexSessionMeta.forkLiveStartLine
    : undefined;
  if (forkLiveStartLine !== undefined) {
    return entries.find((entry) => {
      return typeof entry.sourceLine === 'number'
        && entry.sourceLine > forkLiveStartLine
        && !getOrchestrationTag(entry)
        && isEligibleTabTitleEntry(entry);
    });
  }
  if (forkedFromId || pending.sourceSessionId) return undefined;

  const startedAt = codexSessionMeta?.timestamp ? Date.parse(codexSessionMeta.timestamp) : NaN;
  if (!Number.isFinite(startedAt)) return undefined;
  return entries.find((entry) => {
    const entryAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    return Number.isFinite(entryAt) && entryAt >= startedAt + 1000
      && !getOrchestrationTag(entry)
      && isEligibleTabTitleEntry(entry);
  });
}

function isGenericAiTabName(name: unknown, toolType: 'claude' | 'codex'): boolean {
  const text = String(name || '').trim().toLowerCase();
  return text === toolType || new RegExp(`^${toolType}-\\d{2}$`).test(text);
}

// Truncate text for tooltip display
const formatTokenCount = (count: number): string => {
  return `${(count / 1000).toFixed(1)}K`;
};

// Map raw model id from JSONL message.model to (Provider label, Short model label, color)
// Sources: anthropic SDK (`claude-opus-4-7`, `claude-haiku-4-5-...`), DeepSeek (`deepseek-v4-flash`),
// OpenCode Zen (`minimax-m2.7`, `kimi-...`). Unknown → fall back to the raw string.
function describeModel(rawModel?: string): { provider: string; short: string; color: string } | null {
  if (!rawModel || rawModel === '<synthetic>') return null;
  const m = rawModel.toLowerCase();
  if (m.startsWith('claude-')) {
    let short = 'Claude';
    if (m.includes('opus')) short = 'Opus';
    else if (m.includes('sonnet')) short = 'Sonnet';
    else if (m.includes('haiku')) short = 'Haiku';
    return { provider: 'Anthropic', short, color: '#DA7756' };
  }
  if (m.startsWith('deepseek-')) {
    let short = 'DeepSeek';
    if (m.includes('v4-flash')) short = 'V4F';
    else if (m.includes('v4-pro')) short = 'V4P';
    return { provider: 'DeepSeek', short, color: '#4ade80' };
  }
  if (m.startsWith('minimax-') || m.startsWith('kimi-') || m.startsWith('glm-')) {
    return { provider: 'Zen', short: rawModel, color: '#6B8AFF' };
  }
  return { provider: 'Custom', short: rawModel, color: '#a78bfa' };
}

const truncateText = (text: string | unknown, maxLength: number = 120): string => {
  if (typeof text !== 'string') {
    if (Array.isArray(text)) {
      const firstText = text.find((item: any) => item.type === 'text' && item.text);
      if (firstText) return truncateText(firstText.text, maxLength);
      return '[Complex content]';
    }
    return '[Non-text content]';
  }
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return clean.slice(0, maxLength) + '…';
};

interface ForkMarker {
  source_session_id: string;
  fork_session_id: string;
  entry_uuids: string[];  // Snapshot of all entry UUIDs at fork time
  hidden?: boolean;        // Soft-deleted: stripe hidden but snapshot kept for boundary suppression
}

// Extract search text from entry content for terminal buffer search.
// - Skips separator lines (repeated single char like ========)
// - Limits to 50 chars to avoid spanning terminal line wraps
//   (Ink adds indent on wrapped continuation lines → extra spaces break search)
function getSearchText(content: string): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.length < 3) continue;
    // Skip separators: lines made of a single repeated character
    if (/^(.)\1+$/.test(t)) continue;
    return t.slice(0, 50);
  }
  // Fallback: first non-empty line, even if it's a separator
  return lines.find(l => l.trim())?.trim().slice(0, 50) || '';
}

// Multi-line search: returns up to 3 meaningful lines (each truncated to 50 chars).
// Used for Gemini buffer-text search where single-line xterm search is insufficient.
// Multiple lines dramatically improve match precision for short messages like "да".
function getSearchLines(content: string): string[] {
  const rawLines = content.split('\n');
  const result: string[] = [];
  for (const line of rawLines) {
    const t = line.trim();
    if (!t) continue;
    // Skip separators: lines of repeated chars (═══, ───, ---) including
    // near-separators like "────────╯" where >80% is the same char
    if (t.length >= 3) {
      if (/^(.)\1+$/.test(t)) continue;
      // Near-separator: count most frequent char
      const freq = new Map<string, number>();
      for (const ch of t) freq.set(ch, (freq.get(ch) || 0) + 1);
      const maxFreq = Math.max(...freq.values());
      if (maxFreq / t.length >= 0.8) continue;
    }
    result.push(t.slice(0, 50));
    if (result.length >= 3) break;
  }
  // Fallback: at least return first non-empty line
  if (result.length === 0) {
    const first = rawLines.find(l => l.trim())?.trim().slice(0, 50);
    if (first) result.push(first);
  }
  return result;
}

function getOrchestrationTag(entry: TimelineEntry) {
  return entry.semanticTags?.find(tag => tag.kind === 'orchestration') || null;
}

function getLoopPromptOriginTag(entry: TimelineEntry) {
  return entry.semanticTags?.find(tag => tag.kind === 'prompt-origin' && tag.source === 'loop') || null;
}

// Build grouping map for consecutive built-in sub-agent or durable Terminal MCP
// turns. The structural sidecar tag is the only orchestration classifier; text
// such as "[Оркестрация]" is intentionally ignored.
function computeGroups(entries: TimelineEntry[]): Map<number, GroupInfo> {
  const groups = new Map<number, GroupInfo>();
  let i = 0;
  let groupCounter = 0;

  while (i < entries.length) {
    const entry = entries[i];
    const groupKind = getOrchestrationTag(entry)
      ? 'orchestration'
      : (entry.isSubAgent || entry.isSubAgentTimeout)
        ? 'subagent'
        : null;
    if (!groupKind) {
      i++;
      continue;
    }

    const startIdx = i;
    let j = i + 1;

    // Keep provider-internal agents and durable Terminal MCP calls as separate
    // visual groups even when they happen next to each other.
    while (j < entries.length) {
      const candidateKind = getOrchestrationTag(entries[j])
        ? 'orchestration'
        : (entries[j].isSubAgent || entries[j].isSubAgentTimeout)
          ? 'subagent'
          : null;
      if (candidateKind !== groupKind) break;
      j++;
    }

    const size = j - startIdx;
    const groupId = `group-${groupCounter++}`;
    const hasTimeout = entries.slice(startIdx, j).some(e => e.isSubAgentTimeout);
    // Collect unique agent names for the group
    const agentNames = new Set<string>();
    for (let k = startIdx; k < j; k++) {
      if (entries[k].subAgentName) agentNames.add(entries[k].subAgentName!);
    }
    const agentName = groupKind === 'orchestration'
      ? 'Terminal MCP'
      : agentNames.size === 1
        ? [...agentNames][0]
        : (agentNames.size > 1 ? `${agentNames.size} agents` : 'Claude');

    if (size > 1) {
      // First entry is BOTH header and first child
      groups.set(startIdx, {
        isGroupHeader: true,
        isGroupChild: true,
        groupId,
        groupSize: size,
        agentName,
        hasTimeout,
        groupKind,
        startIndex: startIdx,
      });

      // Remaining entries are children
      for (let k = startIdx + 1; k < j; k++) {
        groups.set(k, {
          isGroupHeader: false,
          isGroupChild: true,
          groupId,
          groupSize: size,
          agentName,
          hasTimeout,
          groupKind,
          startIndex: startIdx,
        });
      }
    } else {
      // Single entry — no group
      groups.set(startIdx, {
        isGroupHeader: false,
        isGroupChild: false,
        groupId,
        groupSize: 1,
        agentName,
        hasTimeout,
        groupKind,
        startIndex: startIdx,
      });
    }

    i = j;
  }

  return groups;
}

// Module-level: survives component remount (project switch destroys Timeline instance)
const _savedEditRangeMap = new Map<string, any>();
const SAVED_MAP_MAX = 20;
const _autoTabTitleAttempted = new Set<string>();
const _autoTabTitleInFlight = new Set<string>();
const TIMELINE_SNAPSHOT_CACHE_MAX_OWNERS = 8;
const TIMELINE_SNAPSHOT_CACHE_MAX_ENTRIES = 20_000;

interface TimelineSnapshotCacheRecord {
  entries: TimelineEntry[];
  sessionMeta: CodexTimelineSessionMeta | null;
  revision: HistoryDurableRevision | null;
}

const _timelineSnapshotCache = new Map<string, TimelineSnapshotCacheRecord>();
let _timelineSnapshotCacheEntries = 0;

function getTimelineSnapshotCache(key: string): TimelineSnapshotCacheRecord | null {
  const record = _timelineSnapshotCache.get(key) || null;
  if (!record) return null;
  _timelineSnapshotCache.delete(key);
  _timelineSnapshotCache.set(key, record);
  return record;
}

function peekTimelineSnapshotCache(key: string): TimelineSnapshotCacheRecord | null {
  return _timelineSnapshotCache.get(key) || null;
}

function setTimelineSnapshotCache(
  key: string,
  record: TimelineSnapshotCacheRecord,
) {
  const previous = _timelineSnapshotCache.get(key);
  if (previous) {
    _timelineSnapshotCache.delete(key);
    _timelineSnapshotCacheEntries -= previous.entries.length;
  }
  _timelineSnapshotCache.set(key, record);
  _timelineSnapshotCacheEntries += record.entries.length;
  while (
    _timelineSnapshotCache.size > TIMELINE_SNAPSHOT_CACHE_MAX_OWNERS ||
    _timelineSnapshotCacheEntries > TIMELINE_SNAPSHOT_CACHE_MAX_ENTRIES
  ) {
    const oldestKey = _timelineSnapshotCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = _timelineSnapshotCache.get(oldestKey);
    _timelineSnapshotCache.delete(oldestKey);
    _timelineSnapshotCacheEntries -= oldest?.entries.length || 0;
  }
  if (_timelineSnapshotCacheEntries < 0) _timelineSnapshotCacheEntries = 0;
}

function perfAbsNow(): number {
  return performance.timeOrigin + performance.now();
}

// ════════════════════════════════════════════════════════════
// SECTION: COMPONENT SETUP — props, UIStore subscriptions, state, ref declarations
// ════════════════════════════════════════════════════════════
// Stable per-render bridge into the parent's live closures. The row component
// below is memoized; passing the parent's handlers directly would hand every
// row a fresh function identity each render and defeat the memo entirely. The
// object identity is created once; the parent overwrites its FIELDS every
// render, and rows call through it at event time — events always reach the
// freshest closure while props stay reference-stable.
interface TimelineRowApi {
  handleMouseEnterSegment: (index: number) => void;
  handleMouseLeaveSegment: (e: React.MouseEvent) => void;
  handleEntryClick: (entry: TimelineEntry, e?: React.MouseEvent) => void;
  handleEntryDoubleClick: (entry: TimelineEntry) => void;
  handleRightClick: (e: React.MouseEvent, entry: TimelineEntry) => void;
  handleNoteStripEnter: (index: number) => void;
  handleNoteStripLeave: (e: React.MouseEvent) => void;
  flashStripFailed: (index: number, kind: 'fork' | 'plan' | 'boundary' | 'compact-strip') => void;
  expandGroup: (groupId: string, groupKind: GroupInfo['groupKind']) => void;
  collapseGroup: (groupId: string) => void;
  setSegmentRef: (index: number, el: HTMLDivElement | null) => void;
  onForkMarkerEnter: (index: number) => void;
  onForkMarkerLeave: (e: React.MouseEvent, index: number) => void;
}

interface TimelineSegmentRowProps {
  entry: TimelineEntry;
  index: number;
  api: TimelineRowApi;
  // Stable-per-load lookups (identity changes only when the data changes).
  groupInfo: GroupInfo | undefined;
  groupPresentation: { edited?: string[]; searched?: string[]; isLoop?: boolean } | undefined;
  compactClusterCount: number;
  hasSemanticMembership: boolean;
  metaPromptTitle: string | null;
  semanticActionText: string | null;
  semanticActionManual: boolean;
  summaryText: string;
  summaryLoading: boolean;
  // Per-row booleans derived in the parent. Volatile state (hover, click
  // feedback, selection) arrives ONLY as these primitives, so a hover moving
  // from dot 5 to dot 6 re-renders exactly two rows, not all 97 — the whole
  // point of the extraction (CPU profile 05.08: 188ms self in the map body
  // per Timeline render, re-run on every hover/viewport/notes tick).
  isGroupExpanded: boolean;
  active: boolean;
  forkMarkerVisible: boolean;
  isPlanModeBoundary: boolean;
  isInViewport: boolean;
  isResponseOnly: boolean;
  isUnreachable: boolean;
  dotClickState: 'loading' | 'failed' | null;
  isHovered: boolean;
  noteHovered: boolean;
  hasNote: boolean;
  notePos: 'dot' | 'before' | 'after';
  isRewindMarked: boolean;
  isOldHistory: boolean;
  isChainBreakZone: boolean;
  isLastBoundary: boolean;
  failedFlashKind: 'fork' | 'plan' | 'boundary' | 'compact-strip' | null;
  isForkActive: boolean;
  isCmdHeld: boolean;
  // Shared scalars.
  isExpandedLayout: boolean;
  treeMode: boolean;
  isCodex: boolean;
  isSdkTab: boolean;
  historyTargetVisible: boolean;
  timelineFontSize: number;
  timelineSummaryFontSize: number;
  timelineLineClamp: number;
  intrinsicPreviewFontSize: number;
}

const TimelineSegmentRow = React.memo(function TimelineSegmentRow({
  entry,
  index,
  api,
  groupInfo,
  groupPresentation,
  compactClusterCount,
  hasSemanticMembership,
  metaPromptTitle,
  semanticActionText,
  semanticActionManual,
  summaryText,
  summaryLoading,
  isGroupExpanded,
  active,
  forkMarkerVisible,
  isPlanModeBoundary,
  isInViewport,
  isResponseOnly,
  isUnreachable,
  dotClickState,
  isHovered,
  noteHovered,
  hasNote,
  notePos,
  isRewindMarked,
  isOldHistory,
  isChainBreakZone,
  isLastBoundary,
  failedFlashKind,
  isForkActive,
  isCmdHeld,
  isExpandedLayout,
  treeMode,
  isCodex,
  isSdkTab,
  historyTargetVisible,
  timelineFontSize,
  timelineSummaryFontSize,
  timelineLineClamp,
  intrinsicPreviewFontSize,
}: TimelineSegmentRowProps) {
  const isCompacted = entry.type === 'compact';
  const isCompactSummaryMarker = !!entry.isCompactSummary;
  const displaysAsCompact = isCompacted || isCompactSummaryMarker;
  const isContinued = entry.type === 'continued';
  const isPlan = !!entry.isPlan;
  const isDocsEdit = entry.type === 'docs_edit';
  const isDocsSearch = entry.type === 'docs_search';
  const entryIsSubAgent = !!(entry.isSubAgent || entry.isSubAgentTimeout);
  const entryIsTimeout = !!entry.isSubAgentTimeout;
  const orchestrationTag = getOrchestrationTag(entry);
  const entryIsOrchestration = !!orchestrationTag;
  const orchestrationGroup = groupInfo?.groupKind === 'orchestration';
  const groupAccent = orchestrationGroup ? '#a855f7' : '#818cf8';
  const groupAccentDim = orchestrationGroup ? '#7e22ce' : '#7c86f0';
  const groupAccentRgb = orchestrationGroup ? '168, 85, 247' : '129, 140, 248';
  const isGroupCollapsed = !!(groupInfo?.isGroupHeader && !isGroupExpanded);
  const isGroupChild = !!(groupInfo?.isGroupChild && isGroupExpanded);
  const showAsChild = isGroupChild && !(groupInfo?.isGroupHeader && !isGroupExpanded);
  const isExpandedHeader = !!(groupInfo?.isGroupHeader && isGroupExpanded);
  const isGroupMeta = isGroupCollapsed || isExpandedHeader;
  const isPromptVisible = isInViewport && !isResponseOnly;

  const markerEdited = groupPresentation?.edited
    || entry.docsEdited
    || (isDocsEdit && entry.content ? [entry.content] : []);
  const markerSearched = groupPresentation?.searched
    || entry.docsSearchQueries
    || (isDocsSearch && entry.content ? [entry.content] : []);
  const isLoopPrompt = groupPresentation?.isLoop ?? !!getLoopPromptOriginTag(entry);
  const cornerBadges = buildTimelineCornerBadges({
    isLoop: isLoopPrompt,
    docsEditedCount: markerEdited.length,
    docsSearchCount: markerSearched.length,
    collapsedGroupSize: isGroupCollapsed ? groupInfo?.groupSize || 0 : 0,
    compactClusterSize: displaysAsCompact && !treeMode ? compactClusterCount : 0,
  });
  const hasDenseCornerBadges = cornerBadges.items
    .filter((item: TimelineCornerBadgeItem) => item.slot.endsWith('right')).length >= 3;

  // ── Dot color ──
  let dotColor: string;
  let dotGlow: string;
  if (displaysAsCompact) {
    dotColor = isHovered ? '#f59e0b' : '#a67c1a';
    dotGlow = isHovered ? '0 0 10px rgba(245, 158, 11, 0.5)' : 'none';
  } else if (isContinued) {
    dotColor = isHovered ? '#f59e0b' : '#a67c1a';
    dotGlow = isHovered ? '0 0 10px rgba(245, 158, 11, 0.5)' : 'none';
  } else if (isPlan) {
    dotColor = isHovered ? '#5eada3' : '#3d7a72';
    dotGlow = isHovered ? '0 0 10px rgba(94, 173, 163, 0.5)' : 'none';
  } else if (active) {
    dotColor = '#60a5fa';
    dotGlow = '0 0 6px rgba(96, 165, 250, 0.3)';
  } else if (entryIsTimeout) {
    dotColor = isHovered ? '#ef4444' : (isPromptVisible ? '#e84040' : '#b33');
    dotGlow = isHovered ? '0 0 10px rgba(239, 68, 68, 0.5)' : (isPromptVisible ? '0 0 6px rgba(239, 68, 68, 0.2)' : 'none');
  } else if (entryIsSubAgent) {
    dotColor = isHovered ? '#818cf8' : (isPromptVisible ? '#7c86f0' : '#5c63b8');
    dotGlow = isHovered ? '0 0 10px rgba(129, 140, 248, 0.5)' : (isPromptVisible ? '0 0 6px rgba(129, 140, 248, 0.2)' : 'none');
  } else if (entryIsOrchestration) {
    dotColor = isHovered ? '#c084fc' : (isPromptVisible ? '#a855f7' : '#7e22ce');
    dotGlow = isHovered ? '0 0 10px rgba(168, 85, 247, 0.55)' : (isPromptVisible ? '0 0 6px rgba(168, 85, 247, 0.25)' : 'none');
  } else {
    dotColor = isHovered ? '#fff' : (isPromptVisible ? '#ccc' : '#999');
    dotGlow = isHovered ? '0 0 10px rgba(255, 255, 255, 0.5)' : (isPromptVisible ? '0 0 6px rgba(255, 255, 255, 0.15)' : 'none');
  }
  const dotGeometry = timelineMarkerGeometry({
    isOrchestration: entryIsOrchestration,
    displaysAsCompact,
    showAsChild,
    isHovered,
    isInViewport,
  });
  if (isGroupMeta) {
    dotColor = isHovered ? groupAccent : groupAccentDim;
    dotGlow = isHovered ? `0 0 10px rgba(${groupAccentRgb}, 0.5)` : `0 0 6px rgba(${groupAccentRgb}, 0.2)`;
  }
  if (hasNote && notePos === 'dot') {
    dotColor = isHovered ? '#67e8f9' : '#0891b2';
    dotGlow = isHovered ? '0 0 10px rgba(34, 211, 238, 0.5)' : '0 0 6px rgba(34, 211, 238, 0.25)';
  }
  if (isRewindMarked) {
    dotColor = isHovered ? '#f472b6' : '#ec4899';
    dotGlow = isHovered ? '0 0 10px rgba(236, 72, 153, 0.5)' : '0 0 6px rgba(236, 72, 153, 0.25)';
  }

  const noteStrip = (
    <div
      className="flex-shrink-0 w-full flex items-center justify-center"
      style={{ height: '6px', cursor: 'pointer' }}
      onMouseEnter={() => api.handleNoteStripEnter(index)}
      onMouseLeave={api.handleNoteStripLeave}
    >
      <div
        style={{
          width: noteHovered ? '18px' : '14px',
          height: noteHovered ? '3px' : '2px',
          borderRadius: '1px',
          backgroundColor: noteHovered ? '#67e8f9' : '#0891b2',
          boxShadow: noteHovered ? '0 0 8px rgba(34, 211, 238, 0.5)' : 'none',
          transition: 'background-color 0.2s, box-shadow 0.2s',
        }}
      />
    </div>
  );

  return (
    <React.Fragment>
      {/* Phase 2: Expanded group toggle bar (collapse control) */}
      {isExpandedHeader && (
        <div
          className="relative w-full flex items-center"
          style={{ flex: '0 0 auto', height: '14px', cursor: 'pointer', justifyContent: 'center' }}
          onClick={(e) => {
            e.stopPropagation();
            api.collapseGroup(groupInfo!.groupId);
          }}
        >
          <div style={{ flex: 1, height: '1px', backgroundColor: `rgba(${groupAccentRgb}, 0.2)`, marginRight: '3px' }} />
          <span className="pointer-events-none select-none shrink-0" style={{ fontSize: '9px', lineHeight: '1', color: groupAccent, fontFamily: 'monospace', fontWeight: 600 }}>
            {groupInfo!.groupSize}
          </span>
          <div style={{ flex: 1, height: '1px', backgroundColor: `rgba(${groupAccentRgb}, 0.2)`, marginLeft: '3px' }} />
        </div>
      )}
      {/* Note indicator strip — before dot */}
      {hasNote && notePos === 'before' && noteStrip}
      <div
        ref={(el) => api.setSegmentRef(index, el)}
        data-segment
        data-timeline-entry-uuid={entry.uuid}
        {...(isUnreachable ? { 'data-unreachable': '' } : {})}
        className="relative w-full flex items-center"
        onMouseEnter={() => {
          // Codex compact bodies are not available to the client; the
          // count marker intentionally has no misleading Cmd tooltip.
          if (!(isCodex && isCompacted)) api.handleMouseEnterSegment(index);
        }}
        onMouseLeave={(e) => api.handleMouseLeaveSegment(e)}
        onClick={(e) => {
          // Phase 2: Click on collapsed group header toggles expansion
          if (groupInfo?.isGroupHeader && !isGroupExpanded) {
            e.stopPropagation();
            api.expandGroup(groupInfo.groupId, groupInfo.groupKind);
          } else {
            api.handleEntryClick(entry, e);
          }
        }}
        onDoubleClick={() => api.handleEntryDoubleClick(entry)}
        onContextMenu={(e) => api.handleRightClick(e, entry)}
        style={{
          // expanded: height auto-fits content (no overlap with neighbours).
          // dots-only/tree: original flex-grow distribution.
          flex: isExpandedLayout
            ? '0 0 auto'
            : `1 0 ${hasDenseCornerBadges ? '22px' : treeMode ? '22px' : (showAsChild ? '14px' : '20px')}`,
          minHeight: isExpandedLayout
            ? undefined
            : (hasDenseCornerBadges ? '22px' : treeMode ? '22px' : (showAsChild ? '14px' : '20px')),
          alignItems: isExpandedLayout ? 'flex-start' : undefined,
          justifyContent: isExpandedLayout ? 'flex-start' : (treeMode ? 'flex-start' : 'center'),
          paddingLeft: isExpandedLayout
            ? '6px'
            : (treeMode
                ? (showAsChild ? '20px' : entryIsSubAgent ? '10px' : '4px')
                : (showAsChild ? '4px' : undefined)),
          paddingRight: isExpandedLayout
            ? (cornerBadges.items.length > 0
                ? (cornerBadges.items.some((item: TimelineCornerBadgeItem) => item.slot.endsWith('inner')) ? '34px' : '22px')
                : '8px')
            : undefined,
          paddingTop: isExpandedLayout ? '6px' : undefined,
          paddingBottom: isExpandedLayout ? '6px' : undefined,
          gap: isExpandedLayout ? '6px' : undefined,
          boxShadow: isExpandedLayout && hasSemanticMembership
            ? 'inset 9px 0 0 -8px rgba(192,132,252,0.28)'
            : undefined,
          overflow: isExpandedLayout ? 'hidden' : undefined,
          // Perf: skip rendering off-screen entries; refs/hit-boxes still attach.
          // intrinsic-size hint ≈ lineHeight(1.3) * lines * fontSize + vertical padding 12.
          contentVisibility: isExpandedLayout ? 'auto' : undefined,
          containIntrinsicSize: isExpandedLayout
            ? `auto ${Math.round(intrinsicPreviewFontSize * 1.3 * timelineLineClamp + 12)}px`
            : undefined,
          backgroundColor: active
            ? 'rgba(59, 130, 246, 0.15)'
            : isHovered && isExpandedLayout && !isGroupMeta
              ? 'rgba(255, 255, 255, 0.04)'
              // Red zones: chain-break (unreachable by Claude's backtrace, all
              // views) and pre-compact old-history (Claude-only, suppressed
              // when the full chat renders elsewhere).
              : (isChainBreakZone && !isGroupMeta && !displaysAsCompact)
                ? 'rgba(239, 68, 68, 0.06)'
                : (isOldHistory && !isGroupMeta && !historyTargetVisible && !isSdkTab
                    ? 'rgba(239, 68, 68, 0.06)'
                    : 'transparent'),
          cursor: (isContinued || isDocsEdit || isDocsSearch || (isOldHistory && !historyTargetVisible && !isSdkTab)) ? 'default' : 'pointer',
        } as React.CSSProperties}
      >
        {/* Dot: hollow ring if unreachable, filled otherwise. pointer-events:
            auto so ПКМ на сам кружок ловится отдельно от полосы. */}
        {isExpandedLayout ? (
          (() => {
            const expSize = displaysAsCompact ? '8px' : (showAsChild ? '6px' : '8px');
            return (
              <div className="flex items-center justify-center shrink-0" style={{ width: '14px', alignSelf: 'stretch' }}>
                <div
                  className="pointer-events-none shrink-0"
                  style={{
                    width: expSize,
                    height: expSize,
                    borderRadius: entryIsOrchestration ? '2px' : '50%',
                    backgroundColor: isUnreachable && !displaysAsCompact ? 'transparent' : dotColor,
                    border: isUnreachable && !displaysAsCompact ? `1px solid ${isRewindMarked ? '#ec4899' : hasNote && notePos === 'dot' ? '#0891b2' : dotColor}` : 'none',
                    boxShadow: dotGlow,
                    boxSizing: 'border-box',
                    transform: entryIsOrchestration ? 'rotate(45deg)' : undefined,
                    pointerEvents: 'auto',
                    transition: 'background-color 0.2s, box-shadow 0.2s',
                  }}
                />
              </div>
            );
          })()
        ) : (
          <div
            className="pointer-events-none shrink-0"
            style={{
              width: dotGeometry.width,
              height: dotGeometry.height,
              borderRadius: entryIsOrchestration ? '2px' : dotGeometry.radius,
              backgroundColor: isUnreachable && !isHovered && !displaysAsCompact ? 'transparent' : dotColor,
              border: isUnreachable && !isHovered && !displaysAsCompact ? `1px solid ${isRewindMarked ? '#ec4899' : hasNote && notePos === 'dot' ? '#0891b2' : dotColor}` : 'none',
              boxShadow: dotGlow,
              boxSizing: 'border-box',
              transform: entryIsOrchestration ? 'rotate(45deg)' : undefined,
              pointerEvents: 'auto',
              transition: 'width 0.15s, height 0.15s, border-radius 0.15s, background-color 0.2s, box-shadow 0.2s',
            }}
          />
        )}

        <TimelineCornerBadges
          items={cornerBadges.items as TimelineCornerBadgeItem[]}
          isExpandedLayout={isExpandedLayout}
          timelineFontSize={timelineFontSize}
          groupAccent={groupAccent}
        />

        {/* Expanded layout: N-line preview text only (type is conveyed by dot color) */}
        {isExpandedLayout && (() => {
          const rawEntryContent = entry.content || '';
          const previewLimit = expandedPreviewCharLimit(timelineLineClamp);
          let previewText = displaysAsCompact
            ? (isCodex
                ? `compact${compactClusterCount > 1 ? ` ×${compactClusterCount}` : ''}`
                : 'Conversation compacted')
            : metaPromptTitle
              ? `META · ${metaPromptTitle}`
              : rawEntryContent;
          let previewColor = 'rgba(255, 255, 255, 0.85)';
          let previewStyle: React.CSSProperties = {};
          let isSummaryPreview = false;
          if (metaPromptTitle) {
            previewColor = 'rgba(232, 180, 254, 0.92)';
          } else if (!displaysAsCompact && semanticActionManual && semanticActionText) {
            previewText = semanticActionText;
            isSummaryPreview = true;
          } else if (!displaysAsCompact && summaryText) {
            previewText = summaryText;
            isSummaryPreview = true;
          } else if (!displaysAsCompact && semanticActionText) {
            previewText = semanticActionText;
            isSummaryPreview = true;
          } else if (!displaysAsCompact && summaryLoading) {
            previewText = 'summarizing prompt...';
            previewColor = 'rgba(125, 211, 252, 0.88)';
            previewStyle = {
              background: 'linear-gradient(90deg, rgba(56,189,248,0.28), rgba(255,255,255,0.72), rgba(56,189,248,0.28))',
              backgroundSize: '180% 100%',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
              WebkitTextFillColor: 'transparent',
              willChange: 'background-position',
              animation: 'timeline-summary-text-shimmer 1.2s linear infinite',
            };
          }
          previewText = truncateTimelinePreviewText(previewText, previewLimit);
          if (!previewText) return null;
          const previewTitle = !displaysAsCompact && previewText !== rawEntryContent
            ? truncateTimelinePreviewText(rawEntryContent, EXPANDED_PREVIEW_TITLE_MAX_CHARS)
            : undefined;
          return (
            <div
              className="flex-1 min-w-0 pointer-events-none"
              style={{
                fontSize: isSummaryPreview ? `${timelineSummaryFontSize}px` : '1em',
                lineHeight: 1.3,
                color: previewColor,
                display: '-webkit-box',
                WebkitLineClamp: timelineLineClamp,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
                ...previewStyle,
              }}
              title={previewTitle}
            >
              {isSummaryPreview ? renderSingleStarHighlights(previewText) : previewText}
            </div>
          );
        })()}

        {/* Loading indicator — mirrors the resting-state Viewport-Dash shape. */}
        {dotClickState === 'loading' && (
          isExpandedLayout ? (
            <div className="absolute top-0 bottom-0 flex items-center justify-center pointer-events-none" style={{ left: 6, width: 14 }}>
              <div className="animate-glow-white" style={{ width: 10, height: 3, borderRadius: 1 }} />
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="animate-glow-white" style={{ width: 10, height: 3, borderRadius: 1 }} />
            </div>
          )
        )}
        {/* Failed X — same anchoring rule as loader. */}
        {dotClickState === 'failed' && (
          isExpandedLayout ? (
            <div className="absolute top-0 bottom-0 flex items-center justify-center pointer-events-none" style={{ left: 6, width: 14 }}>
              <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.7 }}>
                <line x1="2" y1="2" x2="8" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="8" y1="2" x2="2" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.7 }}>
                <line x1="2" y1="2" x2="8" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="8" y1="2" x2="2" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          )
        )}
      </div>
      {/* Note indicator strip — after dot */}
      {hasNote && notePos === 'after' && noteStrip}
      {/* Last boundary separator — "session starts below"; click → red X flash. */}
      {isLastBoundary && (
        <Tooltip content="Current session starts below">
        <div
          className="flex-shrink-0 w-full flex items-center justify-center relative"
          style={{ height: '8px', cursor: 'default' }}
          onClick={(e) => { e.stopPropagation(); api.flashStripFailed(index, 'boundary'); }}
        >
          <div style={{ width: '100%', height: '1px', backgroundColor: 'rgba(255, 255, 255, 0.2)' }} />
          {failedFlashKind === 'boundary' && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.85 }}>
                <line x1="2" y1="2" x2="8" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="8" y1="2" x2="2" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          )}
        </div>
        </Tooltip>
      )}
      {/* Fork marker — not navigable; Cmd+hover opens the fork tooltip. */}
      {forkMarkerVisible && (
        <div
          className="flex-shrink-0 w-full flex items-center justify-center relative"
          style={{ height: '8px', cursor: isCmdHeld ? 'pointer' : 'default', padding: '6px 0', boxSizing: 'content-box' }}
          onClick={(e) => { e.stopPropagation(); api.flashStripFailed(index, 'fork'); }}
          onMouseEnter={() => api.onForkMarkerEnter(index)}
          onMouseLeave={(e) => api.onForkMarkerLeave(e, index)}
        >
          <div
            style={{
              width: isForkActive ? '14px' : isInViewport ? '10px' : '12px',
              height: isForkActive ? '4px' : isInViewport ? '3px' : '2px',
              borderRadius: '1px',
              backgroundColor: isForkActive ? '#93c5fd' : isInViewport ? '#60a5fa' : '#3b82f6',
              boxShadow: isForkActive ? '0 0 8px rgba(59, 130, 246, 0.5)' : isInViewport ? '0 0 6px rgba(59, 130, 246, 0.25)' : 'none',
              transition: 'all 0.2s',
            }}
          />
          {failedFlashKind === 'fork' && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.85 }}>
                <line x1="2" y1="2" x2="8" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="8" y1="2" x2="2" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          )}
        </div>
      )}
      {/* Plan mode marker — not navigable, click → X. */}
      {isPlanModeBoundary && (
        <Tooltip content="Plan mode - context was cleared here">
        <div
          className="flex-shrink-0 w-full flex items-center justify-center relative"
          style={{ height: '8px', cursor: 'default' }}
          onClick={(e) => { e.stopPropagation(); api.flashStripFailed(index, 'plan'); }}
        >
          <div
            style={{
              width: isInViewport ? '10px' : '12px',
              height: isInViewport ? '3px' : '2px',
              borderRadius: '1px',
              backgroundColor: isInViewport ? '#5eada3' : '#48968c',
              boxShadow: isInViewport ? '0 0 6px rgba(72, 150, 140, 0.25)' : 'none',
              transition: 'background-color 0.2s, box-shadow 0.2s',
            }}
          />
          {failedFlashKind === 'plan' && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.85 }}>
                <line x1="2" y1="2" x2="8" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="8" y1="2" x2="2" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          )}
        </div>
        </Tooltip>
      )}
    </React.Fragment>
  );
});

function Timeline({
  tabId,
  sessionId,
  cwd,
  isActive = true,
  isTurnBusy = false,
  isVisible = true,
  isOpen = true,
  toolType = 'claude',
  pinned = false,
  readOnly = false,
  historySurfaceVisible = false,
}: TimelineProps) {
  const isGemini = toolType === 'gemini';
  const isCodex = toolType === 'codex';
  const usesTextSearchAnchors = isGemini || isCodex;
  const supportsClaudeTimelineActions = !readOnly && !isGemini && !isCodex;
  const supportsEditRangeActions = !readOnly && (supportsClaudeTimelineActions || isCodex);
  const supportsDeleteRangeActions = !readOnly && (supportsClaudeTimelineActions || isCodex);
  const summaryToolType: TimelineSummaryTool | null = isGemini ? null : (isCodex ? 'codex' : 'claude');
  const promptSummaries = useTimelineSummaryStore(state => state.summaries);
  const promptSummaryLoadingKeys = useTimelineSummaryStore(state => state.loadingKeys);
  const promptSummaryLoadedSessionKeys = useTimelineSummaryStore(state => state.loadedSessionKeys);
  const loadPromptSummaries = useTimelineSummaryStore(state => state.loadSummaries);
  const generatePromptSummary = useTimelineSummaryStore(state => state.generateSummary);
  const refreshPromptSummariesForTab = useTimelineSummaryStore(state => state.refreshEntriesForTab);
  const promptSummaryGlobalAuto = useTimelineSummaryStore(state => state.globalAuto);
  const promptSummaryGlobalAutoSince = useTimelineSummaryStore(state => state.globalAutoSince);
  const promptSummaryTabAuto = useTimelineSummaryStore(state => state.autoByTab[tabId] === true);
  const promptSummaryTabAutoSince = useTimelineSummaryStore(state => state.autoSinceByTab[tabId] || 0);
  const promptSummaryPreviousUserCount = useTimelineSummaryStore(state => state.previousUserContextCount);
  const promptSummaryAutoEnabled = promptSummaryGlobalAuto || promptSummaryTabAuto;
  const promptSummaryAutoSince = (() => {
    const candidates = [
      promptSummaryGlobalAuto ? promptSummaryGlobalAutoSince : 0,
      promptSummaryTabAuto ? promptSummaryTabAutoSince : 0,
    ].filter((n) => Number.isFinite(n) && n > 0);
    return candidates.length ? Math.min(...candidates) : 0;
  })();
  const outlineSessionKey = summaryToolType && sessionId
    ? timelineOutlineKey(summaryToolType, sessionId)
    : '';
  const timelineOutlineRecord = useTimelineOutlineStore((state) => (
    outlineSessionKey ? state.outlines[outlineSessionKey] : undefined
  ));
  const timelineActionOverrides = useTimelineOutlineStore((state) => (
    outlineSessionKey ? state.actionOverridesBySession[outlineSessionKey] : undefined
  ));
  const loadTimelineOutline = useTimelineOutlineStore((state) => state.loadOutline);
  const loadTimelineActionOverrides = useTimelineOutlineStore((state) => state.loadActionOverrides);
  const saveTimelineActionOverride = useTimelineOutlineStore((state) => state.saveActionOverride);
  const syncTimelineOutlineUuids = useTimelineOutlineStore((state) => state.syncEligibleUuids);

  // Slide animation (matches HistoryPanel pattern)
  const [slideIn, setSlideIn] = useState(isOpen);
  // effect: isOpen → setSlideIn after 2 RAFs (slide-in transition); false → reset immediately
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setSlideIn(true));
      });
    } else {
      setSlideIn(false);
    }
  }, [isOpen]);

  const timelineOwnerKey = useMemo(() => JSON.stringify({ tabId, toolType, sessionId: sessionId || '', cwd: cwd || '' }), [tabId, toolType, sessionId, cwd]);
  const timelineOwnerKeyRef = useRef(timelineOwnerKey);
  timelineOwnerKeyRef.current = timelineOwnerKey;
  const timelineLoadGenerationRef = useRef(0);
  const timelineLoadFlightRef = useRef<{
    ownerKey: string;
    promise: Promise<void> | null;
    trailingReason: string | null;
  }>({
    ownerKey: timelineOwnerKey,
    promise: null,
    trailingReason: null,
  });
  const [entriesSnapshot, setEntriesSnapshot] = useState<{ ownerKey: string; entries: TimelineEntry[] }>({
    ownerKey: timelineOwnerKey,
    entries: [],
  });
  // A prop switch immediately makes the previous array invisible. This is the
  // ownership boundary that prevents new session IDs from being paired with
  // stale prompts while the next async JSONL read is still in flight.
  const entries = entriesSnapshot.ownerKey === timelineOwnerKey ? entriesSnapshot.entries : [];
  const [loadingOwnerKey, setLoadingOwnerKey] = useState<string | null>(
    sessionId ? timelineOwnerKey : null
  );
  const [historyPresentedOwnerKey, setHistoryPresentedOwnerKey] = useState('');
  const [hydratedTimelineOwnerKey, setHydratedTimelineOwnerKey] = useState('');
  const historyPresentationGateOpen = !historySurfaceVisible
    || historyPresentedOwnerKey === timelineOwnerKey;
  const isLoading = loadingOwnerKey === timelineOwnerKey;
  const entriesCountRef = useRef(0);
  entriesCountRef.current = entries.length;
  const [compactSummaryCache, setCompactSummaryCache] = useState<Record<string, string | null>>({});
  const [forkMarkers, setForkMarkers] = useState<ForkMarker[]>([]);
  const [codexSessionMeta, setCodexSessionMeta] = useState<CodexTimelineSessionMeta | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [activeTooltipIndex, setActiveTooltipIndex] = useState<number | null>(null);
  const timelineInstanceIdRef = useRef(Math.random().toString(36).slice(2, 8));
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const historyPresentationGateOpenRef = useRef(historyPresentationGateOpen);
  historyPresentationGateOpenRef.current = historyPresentationGateOpen;
  const isTurnBusyRef = useRef(isTurnBusy);
  isTurnBusyRef.current = isTurnBusy;
  const deferredTranscriptRefreshRef = useRef(false);
  const deferredTranscriptReasonRef = useRef<'turn-busy' | 'surface-hidden' | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [tooltipCopied, setTooltipCopied] = useState(false);
  // Per-entry collapsed/expanded state for docs blocks in tooltip. Key = entry uuid.
  // Default collapsed (compact one-liner) — click on the line to expand and see full paths/queries.
  const [expandedDocsEdit, setExpandedDocsEdit] = useState<Set<string>>(new Set());
  const [expandedDocsSearch, setExpandedDocsSearch] = useState<Set<string>>(new Set());
  const [selectionStartId, setSelectionStartId] = useState<string | null>(null);
  const selectionStartIdRef = useRef<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, entry: TimelineEntry, source?: 'dot' | 'segment', anchorY?: number } | null>(null);
  const [refreshingActionUuid, setRefreshingActionUuid] = useState<string | null>(null);
  const [sessionBoundaries, setSessionBoundaries] = useState<SessionBoundary[]>([]);
  // Boundary uuid from backend (= youngest entry of pre-orphan tail, set when
  // Generic CHAIN BREAK recovery fired). Used ONLY to detect post-compact
  // chain breaks (orphan UUID after the last /compact boundary) — those need
  // red-background even in HistoryPanel/SDK mode, because pre-orphan tail in
  // post-compact zone is not actually visible to live Claude. When the orphan
  // sits BEFORE the last compact, the existing isOldHistory red band already
  // covers it — nothing extra to do.
  const [claudeMemoryBoundaryUuid, setClaudeMemoryBoundaryUuid] = useState<string | null>(null);
  const [copyingRange, setCopyingRange] = useState<{ startIndex: number, endIndex: number } | null>(null);
  const [copiedRange, setCopiedRange] = useState<{ startIndex: number, endIndex: number } | null>(null);
  const [visibleEntryIndices, setVisibleEntryIndices] = useState<Set<number>>(new Set());
  const [responseOnlyIndices, setResponseOnlyIndices] = useState<Set<number>>(new Set());
  const [unreachableIndices, setUnreachableIndices] = useState<Set<number>>(new Set());
  // Index of the last compact/plan-mode boundary — entries at or before this are "old history"
  const [lastBoundaryIndex, setLastBoundaryIndex] = useState(-1);
  const [clickedState, setClickedState] = useState<{ index: number; status: 'loading' | 'failed' } | null>(null);
  // Tracks an in-flight history-panel scroll triggered by Cmd+click / click-when-open.
  // Cleared by 'history-panel:scrolled-to' event (success) or the safety timeout.
  const pendingHistoryScrollRef = useRef<{ uuid: string; index: number } | null>(null);
  const historyClickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Failed-click flash for non-clickable strip markers (fork, plan-mode, last-boundary
  // unified line). Keyed by the entry index the strip is rendered next to + a kind
  // tag so multiple strips of the same entry (rare) wouldn't collide. Renders a red
  // X inside the strip's bounding box for 1.2s — same affordance as the dot-level
  // `failed` state, but scoped to the strip element.
  const [failedStripFlash, setFailedStripFlash] = useState<{ index: number; kind: 'fork' | 'plan' | 'boundary' | 'compact-strip' } | null>(null);
  const flashStripFailed = useCallback((index: number, kind: 'fork' | 'plan' | 'boundary' | 'compact-strip') => {
    setFailedStripFlash({ index, kind });
    setTimeout(() => {
      setFailedStripFlash((cur) => (cur && cur.index === index && cur.kind === kind ? null : cur));
    }, 1200);
  }, []);
  const rewindState = useRewindOperationStore(
    useCallback((state) => selectActiveRewindOperation(state, tabId), [tabId])
  );
  const [rewindLoadingMenu, setRewindLoadingMenu] = useState<{ x: number; y: number } | null>(null);
  const [rewindAgentPresence, setRewindAgentPresence] = useState<AgentPtyPresence | null>(null);
  const rewindAgentStatus: AgentPtyStatus | null = rewindAgentPresence?.status || null;

  const createAgentReadyWait = useCallback((runtime: ReturnType<typeof getHistoryAgentRuntime>, timeoutMs = 30000) => {
    let cleanup = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new Error(runtime.label + ' did not become ready for rewind'));
      }, timeoutMs);
      const handler = (_event: any, data: { tabId?: string } = {}) => {
        if (data?.tabId !== tabId) return;
        finish();
      };
      cleanup = () => {
        clearTimeout(timer);
        if (runtime.readyEvent) ipcRenderer.removeListener(runtime.readyEvent, handler);
      };
      if (!runtime.readyEvent) {
        finish();
      } else {
        ipcRenderer.on(runtime.readyEvent, handler);
      }
    });
    return {
      promise,
      cancel: () => cleanup(),
    };
  }, [tabId]);

  useEffect(() => {
    if (toolType !== 'claude' && toolType !== 'codex') {
      setRewindAgentPresence(null);
      return;
    }
    let cancelled = false;
    const runtime = getHistoryAgentRuntime(toolType as AgentHistoryTool);
    runtime.getPresence(tabId)
      .then((presence) => {
        if (!cancelled) setRewindAgentPresence(presence || null);
      })
      .catch(() => {
        if (!cancelled) setRewindAgentPresence(null);
      });
    return () => {
      cancelled = true;
    };
  }, [contextMenu?.entry.uuid, isTurnBusy, sessionId, tabId, toolType]);

  // Edit Range state
  const [editRangeState, _setEditRangeState] = useState<{
    range: { startIndex: number; endIndex: number };
    phase: 'loading' | 'ready' | 'applying' | 'done';
    sourceContent: string;
    compactText: string;
    compactUuid?: string; // UUID of the inserted compact entry (after apply)
    autoEditInitial?: boolean; // open with first Gemini-message in inline-edit mode
  } | null>(null);
  // Ref mirror — always current, used by useEffect cleanup (closures capture stale state)
  const editRangeStateRef = useRef(editRangeState);
  // Wrapper with logging to trace phantom resets
  const setEditRangeState: typeof _setEditRangeState = (val) => {
    if (val === null) {
      console.warn('[EditRange:State] → null', new Error().stack?.split('\n')[2]?.trim());
    } else if (typeof val === 'function') {
      _setEditRangeState((prev) => {
        const next = (val as any)(prev);
        if (next === null) console.warn('[EditRange:State] fn→null', new Error().stack?.split('\n')[2]?.trim());
        else if (next) console.warn('[EditRange:State] fn→' + next.phase);
        editRangeStateRef.current = next;
        return next;
      });
      return;
    } else {
      console.warn('[EditRange:State] →' + val.phase + ' range=[' + val.range.startIndex + ',' + val.range.endIndex + ']');
    }
    _setEditRangeState(val);
    editRangeStateRef.current = typeof val === 'function' ? null : val; // fn case handled above
  };
  // AbortController for edit-range Gemini API call
  const editRangeAbortRef = useRef<AbortController | null>(null);
  // Context menu for edit-range loading overlay (Interrupt / Cancel)
  const [editRangeLoadingMenu, setEditRangeLoadingMenu] = useState<{ x: number; y: number } | null>(null);
  // Auto-dismiss "done" overlay: 1s after cursor moves in terminal, unless hovering overlay/panel
  const editRangeDoneHovered = useRef(false);
  const editRangeDoneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // effect: editRangeState.phase==='done' → 1s mousemove timer clears editRangeState (unless hovered)
  useEffect(() => {
    if (editRangeState?.phase !== 'done') {
      editRangeDoneHovered.current = false;
      if (editRangeDoneTimer.current) { clearTimeout(editRangeDoneTimer.current); editRangeDoneTimer.current = null; }
      return;
    }
    const onMove = () => {
      if (editRangeDoneHovered.current || editRangeDoneTimer.current) return;
      editRangeDoneTimer.current = setTimeout(() => {
        if (!editRangeDoneHovered.current) {
          setEditRangeState(null);
        }
        editRangeDoneTimer.current = null;
      }, 1000);
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (editRangeDoneTimer.current) { clearTimeout(editRangeDoneTimer.current); editRangeDoneTimer.current = null; }
    };
  }, [editRangeState?.phase]);
  useEffect(() => {
    if (!rewindState) setRewindLoadingMenu(null);
  }, [rewindState]);
  // Range action menu — appears after second click to choose Copy / Edit / Delete
  const [rangeActionMenu, setRangeActionMenu] = useState<{
    x: number; y: number;
    range: { startIndex: number; endIndex: number };
    startUuid: string; endUuid: string;
    crossesBoundary: boolean;  // range hit compact/isCompactSummary/continued; Delete confirm can auto-extend to safe boundary
  } | null>(null);
  const [postPromptMode, setPostPromptMode] = useState(false);
  // Same "add your own instruction first" step, but for a single-point Rewind.
  // Holds the entry the instruction belongs to: the single-point menu has no
  // selection range to fall back on, so the target must be explicit.
  const [singlePostPromptEntryUuid, setSinglePostPromptEntryUuid] = useState<string | null>(null);
  const [postPromptText, setPostPromptText] = useState('');
  const postPromptRef = useRef<HTMLTextAreaElement>(null);
  // Inline confirm for "Удалить историю" inside rangeActionMenu (no side panel)
  const [deleteConfirmMode, setDeleteConfirmMode] = useState(false);
  const [deleteRangeScope, setDeleteRangeScope] = useState<DeleteScope>('selection');
  // Animation state while delete IPC is running (red overlay over the range)
  const [deletingRange, setDeletingRange] = useState<{ startIndex: number; endIndex: number } | null>(null);
  // Inline confirm for "Удалить запрос" inside contextMenu (single user-entry delete)
  const [deleteEntryConfirmMode, setDeleteEntryConfirmMode] = useState(false);
  const [deleteEntryScope, setDeleteEntryScope] = useState<DeleteScope>('selection');
  // effect: contextMenu closes → reset entry-delete confirm (prevents reopening in confirm state)
  useEffect(() => {
    if (!contextMenu) {
      setDeleteEntryConfirmMode(false);
      setDeleteEntryScope('selection');
    }
  }, [contextMenu]);
  // effect: rangeActionMenu closes → reset deleteConfirmMode (prevents next popup opening in confirm state)
  useEffect(() => {
    if (!rangeActionMenu) {
      setDeleteConfirmMode(false);
      setDeleteRangeScope('selection');
    }
  }, [rangeActionMenu]);

  // Ref to context-menu root so we can measure its rect for the hover-bridge test.
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenuMeasuredH, setContextMenuMeasuredH] = useState(0);
  const contextMenuMeasuredRef = useRef(0);
  // Refs to the other two fixed popups so we can re-clamp them post-mount when
  // the cursor was near the bottom of the screen (otherwise their bottom edge
  // slips below the viewport — same issue we fixed for contextMenu).
  const editRangeLoadingMenuRef = useRef<HTMLDivElement>(null);
  const rewindLoadingMenuRef = useRef<HTMLDivElement>(null);
  const rangeActionMenuRef = useRef<HTMLDivElement>(null);
  // Token breakdown for range — fetched async from claude:estimate-range-tokens when
  // the action menu opens. `total` is the "max upper bound" (all toggles ON).
  // categories is the per-class breakdown rendered in the hover popover.
  type TokenBreakdown = {
    total: number;
    downTotal: number;
    apiInputTokens: number;
    apiOutputTokens: number;
    // Cache breakdown — splits apiInputTokens на три части. Сумма всегда равна
    // apiInputTokens. Cache touches только input (output не кэшируется).
    //   apiInputUncached    — input_tokens, full price (свежий промпт)
    //   apiInputCacheCreate — cache_creation_input_tokens, 1.25× price
    //   apiInputCacheRead   — cache_read_input_tokens, 0.1× price
    // Backend старый версии может не вернуть эти поля → 0 fallback.
    apiInputUncached?: number;
    apiInputCacheCreate?: number;
    apiInputCacheRead?: number;
    categories: {
      user: number; claudeText: number; claudeThinking: number;
      read: number; edit: number; bash: number; tools: number;
      subagentResult: number; subagentHistory: number; compact: number;
    };
  };
  const [tokenEstimate, setTokenEstimate] = useState<TokenBreakdown | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdownFlipUp, setBreakdownFlipUp] = useState(false);
  const tokenChipRef = useRef<HTMLDivElement>(null);
  const breakdownPopoverRef = useRef<HTMLDivElement>(null);

  // Single-entry breakdown (Cmd+hover tooltip on a user-entry → ↑XXK chip). Reuses the
  // same IPC as range mode but with start=end=entry.uuid. Backend forward-expand picks
  // up the trailing assistant chain automatically.
  const [singleTokenEstimate, setSingleTokenEstimate] = useState<TokenBreakdown | null>(null);
  const [singleTokenUuid, setSingleTokenUuid] = useState<string | null>(null);
  const [singleBreakdownOpen, setSingleBreakdownOpen] = useState(false);
  const [singleBreakdownFlipUp, setSingleBreakdownFlipUp] = useState(false);
  const [singleChipEl, setSingleChipEl] = useState<HTMLSpanElement | null>(null);
  const singleBreakdownPopoverRef = useRef<HTMLDivElement>(null);
  // Mode toggle shared between range and single popovers. Persists during the session
  // (user's preference doesn't reset between hovers). 'jsonl' shows the per-category
  // weight breakdown; 'api' shows what Anthropic actually billed for this range.
  const [breakdownMode, setBreakdownMode] = useState<'jsonl' | 'api'>('jsonl');

  const emitRewindCancelled = useCallback((operation: RewindOperation) => {
    window.dispatchEvent(new CustomEvent('history-panel:rewind-log', {
      detail: {
        tabId: operation.tabId,
        opId: operation.opId,
        status: 'failed',
        targetUuid: operation.targetUuid,
        targetText: operation.targetText,
        mode: operation.mode,
        toolType: operation.toolType,
        sourceSessionId: operation.sourceSessionId || null,
        error: 'Rewind cancelled',
      }
    }));
  }, []);

  const cancelActiveRewind = useCallback(() => {
    const active = rewindState;
    if (!active) return;
    const store = useRewindOperationStore.getState();
    if (!store.requestCancel(active.tabId, active.opId)) return;

    setRewindLoadingMenu(null);
    const operationKey = makeRewindOperationKey(active.tabId, active.opId);
    const abortController = rewindGeminiAbortControllers.get(operationKey);
    if (abortController) {
      abortController.abort();
      rewindGeminiAbortControllers.delete(operationKey);
    }

    // Before the runtime request starts, renderer ownership is sufficient:
    // no PTY mutation can race this cancellation.
    if (!active.runtimeRequestStarted) {
      if (useRewindOperationStore.getState().resolveCancel(active.tabId, active.opId, 'accepted')) {
        emitRewindCancelled(active);
      }
      return;
    }

    void ipcRenderer.invoke('rewind:cancel', {
      tabId: active.tabId,
      toolType: active.toolType,
      opId: active.opId,
    }).then((reply: unknown) => {
      const resolution = classifyRewindCancelReply(reply);
      if (resolution === 'accepted') {
        if (useRewindOperationStore.getState().resolveCancel(active.tabId, active.opId, 'accepted')) {
          emitRewindCancelled(active);
        }
        return;
      }
      if (resolution === 'too-late') {
        useRewindOperationStore.getState().resolveCancel(active.tabId, active.opId, 'too-late');
        return;
      }
      useRewindOperationStore.getState().rejectCancel(
        active.tabId,
        active.opId,
        'Cancellation was not accepted; waiting for the Rewind result',
      );
    }).catch((err: any) => {
      console.warn('[Restore:Rewind] cancel IPC failed:', err?.message || err);
      useRewindOperationStore.getState().rejectCancel(
        active.tabId,
        active.opId,
        'Cancellation check failed; waiting for the Rewind result',
      );
    });
  }, [rewindState, emitRewindCancelled]);

  // effect: contextMenu open → mousemove listener closes menu when cursor leaves Timeline+menu+bridge rect (uses geometric hit-test instead of elementFromPoint)
  useEffect(() => {
    if (!contextMenu) return;
    const onMove = (e: MouseEvent) => {
      const tlEl = containerRef.current;
      const menuEl = contextMenuRef.current;
      if (!tlEl || !menuEl) return;
      const tlRect = tlEl.getBoundingClientRect();
      const menuRect = menuEl.getBoundingClientRect();
      const { clientX: x, clientY: y } = e;

      const inTimeline = x >= tlRect.left && x <= tlRect.right && y >= tlRect.top && y <= tlRect.bottom;
      const inMenu = x >= menuRect.left && x <= menuRect.right && y >= menuRect.top && y <= menuRect.bottom;
      // Bridge: horizontal corridor between menu.right and tlRect.left at the menu's
      // vertical range (with a small Y padding so it's forgiving on top/bottom edges).
      const bridgePad = 8;
      const inBridge =
        x >= menuRect.right &&
        x <= tlRect.left &&
        y >= Math.min(menuRect.top, tlRect.top) - bridgePad &&
        y <= Math.max(menuRect.bottom, tlRect.bottom) + bridgePad;

      if (!inTimeline && !inMenu && !inBridge) setContextMenu(null);
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [contextMenu]);

  // Measure context menu height after render. Position is derived from the entry
  // anchor during render (same mental model as Cmd-hover), so this effect must not
  // write a corrected `top` back into state — doing that creates a visible jump for
  // bottom entries.
  useLayoutEffect(() => {
    if (!contextMenu) {
      if (contextMenuMeasuredRef.current !== 0) {
        contextMenuMeasuredRef.current = 0;
        setContextMenuMeasuredH(0);
      }
      return;
    }
    const el = contextMenuRef.current;
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (Math.abs(h - contextMenuMeasuredRef.current) > 1) {
      contextMenuMeasuredRef.current = h;
      setContextMenuMeasuredH(h);
    }
  }, [contextMenu?.entry?.uuid, selectionStartId, deleteEntryConfirmMode]);

  // Same clamp for the edit-range loading popup ("Прервать / Отмена").
  // Set from `e.clientY` raw, no height guess. When cursor was near the very
  // bottom of Timeline the two buttons get clipped by the viewport edge.
  // Dep is `!!editRangeLoadingMenu` so the effect fires once per open/close
  // toggle, not on every `y` update — the inner check prevents looping.
  useLayoutEffect(() => {
    if (!editRangeLoadingMenu) return;
    const el = editRangeLoadingMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 10;
    let desired = editRangeLoadingMenu.y;
    if (r.top + r.height > window.innerHeight - margin) {
      desired = window.innerHeight - r.height - margin;
    }
    if (desired < margin) desired = margin;
    if (desired !== editRangeLoadingMenu.y) {
      setEditRangeLoadingMenu({ ...editRangeLoadingMenu, y: desired });
    }
  }, [!!editRangeLoadingMenu]);

  // Same clamp for the Rewind loading popup (right-click on REWINDING overlay).
  useLayoutEffect(() => {
    if (!rewindLoadingMenu) return;
    const el = rewindLoadingMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 10;
    let desired = rewindLoadingMenu.y;
    if (r.top + r.height > window.innerHeight - margin) {
      desired = window.innerHeight - r.height - margin;
    }
    if (desired < margin) desired = margin;
    if (desired !== rewindLoadingMenu.y) {
      setRewindLoadingMenu({ ...rewindLoadingMenu, y: desired });
    }
  }, [!!rewindLoadingMenu]);

  // Same clamp for the range-action popup (Удалить N записей / Копировать /
  // Откатить). Initial clamp uses a hardcoded POPUP_H estimate; this corrects
  // it to the real rendered height (deleteConfirmMode swaps the row set and
  // changes vertical size, so the guess can be off by tens of pixels).
  useLayoutEffect(() => {
    if (!rangeActionMenu) return;
    const el = rangeActionMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 10;
    let desired = rangeActionMenu.y;
    if (r.top + r.height > window.innerHeight - margin) {
      desired = window.innerHeight - r.height - margin;
    }
    if (desired < margin) desired = margin;
    if (desired !== rangeActionMenu.y) {
      setRangeActionMenu({ ...rangeActionMenu, y: desired });
    }
  }, [rangeActionMenu?.range?.startIndex, rangeActionMenu?.range?.endIndex, deleteConfirmMode]);

  // Fetch token breakdown for the active range. claude-only; Gemini falls back to the
  // legacy heuristic (sum of user.content lengths) since it has no copy-range backend.
  useEffect(() => {
    if (!rangeActionMenu || !supportsClaudeTimelineActions || !sessionId) {
      setTokenEstimate(null);
      setBreakdownOpen(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const result = await ipcRenderer.invoke('claude:estimate-range-tokens', {
        sessionId, cwd,
        startUuid: rangeActionMenu.startUuid,
        endUuid: rangeActionMenu.endUuid,
      });
      if (cancelled) return;
      if (result?.success) {
        setTokenEstimate({
          total: result.total,
          downTotal: result.downTotal || 0,
          apiInputTokens: result.apiInputTokens || 0,
          apiOutputTokens: result.apiOutputTokens || 0,
          apiInputUncached: result.apiInputUncached || 0,
          apiInputCacheCreate: result.apiInputCacheCreate || 0,
          apiInputCacheRead: result.apiInputCacheRead || 0,
          categories: result.categories,
        });
      } else {
        setTokenEstimate(null);
      }
    })();
    return () => { cancelled = true; };
  }, [rangeActionMenu?.startUuid, rangeActionMenu?.endUuid, sessionId, cwd, supportsClaudeTimelineActions]);

  // Position the breakdown popover: open downward by default, flip up if there's not
  // enough room below the action menu. Same flip pattern as note tooltip.
  useLayoutEffect(() => {
    if (!breakdownOpen) return;
    const chipEl = tokenChipRef.current;
    const popEl = breakdownPopoverRef.current;
    if (!chipEl || !popEl) return;
    const chipRect = chipEl.getBoundingClientRect();
    const popHeight = popEl.getBoundingClientRect().height;
    const margin = 10;
    const spaceBelow = window.innerHeight - chipRect.bottom - margin;
    setBreakdownFlipUp(spaceBelow < popHeight && chipRect.top > popHeight + margin);
  }, [breakdownOpen, tokenEstimate, breakdownMode]);

  // Lazy fetch single-entry breakdown when user hovers the ↑ chip in Cmd+hover tooltip.
  // Skip if Gemini, no session, or already fetched the same uuid (cache hit avoids
  // network roundtrip when user moves mouse out and back in).
  const singleCachedUuidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!singleTokenUuid || !supportsClaudeTimelineActions || !sessionId) {
      setSingleTokenEstimate(null);
      return;
    }
    if (singleCachedUuidRef.current === singleTokenUuid && singleTokenEstimate) return;
    let cancelled = false;
    (async () => {
      const result = await ipcRenderer.invoke('claude:estimate-range-tokens', {
        sessionId, cwd,
        startUuid: singleTokenUuid,
        endUuid: singleTokenUuid,
      });
      if (cancelled) return;
      if (result?.success) {
        singleCachedUuidRef.current = singleTokenUuid;
        setSingleTokenEstimate({
          total: result.total,
          downTotal: result.downTotal || 0,
          apiInputTokens: result.apiInputTokens || 0,
          apiOutputTokens: result.apiOutputTokens || 0,
          apiInputUncached: result.apiInputUncached || 0,
          apiInputCacheCreate: result.apiInputCacheCreate || 0,
          apiInputCacheRead: result.apiInputCacheRead || 0,
          categories: result.categories,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [singleTokenUuid, sessionId, cwd, supportsClaudeTimelineActions]);

  // Global mousemove guard for both breakdown popovers. Closing on chip.onMouseLeave
  // unmounts the popover wrapper before the cursor can cross the 4px gap into it —
  // mouseenter never fires on an unmounted node. Instead we keep the popover open
  // and close it only when the cursor is outside BOTH the chip rect and the popover
  // rect (with a tiny tolerance for the visual gap). This is the Invisible Bridge
  // pattern from docs/methodology/design.md — listener only runs while open, no perf
  // cost otherwise.
  useEffect(() => {
    if (!singleBreakdownOpen) return;
    const onMove = (e: MouseEvent) => {
      const chipRect = singleChipEl?.getBoundingClientRect();
      const popRect = singleBreakdownPopoverRef.current?.getBoundingClientRect();
      const inRect = (r: DOMRect | undefined, pad = 0) =>
        !!r && e.clientX >= r.left - pad && e.clientX <= r.right + pad
          && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
      if (!inRect(chipRect, 2) && !inRect(popRect, 2)) {
        setSingleBreakdownOpen(false);
        // §2.7: while the popover is open the parent onMouseLeave is a no-op (~4177),
        // so THIS continuous guard is the sole owner of closing the gesture. The chip
        // lives in the parent tooltip footer — once the cursor has left both chip and
        // popover we must ALSO re-evaluate the parent, else it would be left stuck open.
        // tooltipRef is the wrapper (visible content + CSS bridge corridor to the
        // Timeline strip); if the cursor is outside that too, close it exactly like
        // handleMouseLeaveTooltipArea would. Guards read via refs / store.getState() —
        // they are declared later in the body, so they MUST NOT go in the deps array
        // (deps are evaluated eagerly at render → TDZ). Reading at event-time is safe.
        const parentRect = tooltipRef.current?.getBoundingClientRect();
        if (!inRect(parentRect, 2)
            && !isExpanded
            && !isResizingTooltipRef.current
            && !isLockedTooltipRef.current
            && !useUIStore.getState().freezeCmdPopups) {
          isMouseInTooltipRef.current = false;
          setHoveredIndex(null);
          setActiveTooltipIndex(null);
        }
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [singleBreakdownOpen, singleChipEl, isExpanded]);

  useEffect(() => {
    if (!breakdownOpen) return;
    const onMove = (e: MouseEvent) => {
      const chipRect = tokenChipRef.current?.getBoundingClientRect();
      const popRect = breakdownPopoverRef.current?.getBoundingClientRect();
      const inRect = (r: DOMRect | undefined, pad = 0) =>
        !!r && e.clientX >= r.left - pad && e.clientX <= r.right + pad
          && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
      if (!inRect(chipRect, 2) && !inRect(popRect, 2)) {
        setBreakdownOpen(false);
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [breakdownOpen]);

  // Single-entry breakdown flip-up logic — same pattern as range version.
  useLayoutEffect(() => {
    if (!singleBreakdownOpen || !singleChipEl) return;
    const popEl = singleBreakdownPopoverRef.current;
    if (!popEl) return;
    const chipRect = singleChipEl.getBoundingClientRect();
    const popHeight = popEl.getBoundingClientRect().height;
    const margin = 10;
    const spaceBelow = window.innerHeight - chipRect.bottom - margin;
    setSingleBreakdownFlipUp(spaceBelow < popHeight && chipRect.top > popHeight + margin);
  }, [singleBreakdownOpen, singleTokenEstimate, singleTokenUuid, entries, singleChipEl, breakdownMode]);

  // Phase 2: Collapsible groups
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Semantic groups are a separate, persisted projection. Unlike the legacy
  // sub-agent clusters they own no raw entry and never replace UUID/index data.
  const [expandedSemanticGroups, setExpandedSemanticGroups] = useState<Set<string>>(new Set());
  const [hoveredSemanticGroupId, setHoveredSemanticGroupId] = useState<string | null>(null);
  const [activeSemanticGroupId, setActiveSemanticGroupId] = useState<string | null>(null);
  const activeSemanticGroupIdRef = useRef<string | null>(null);
  const hydratedSemanticSessionKeyRef = useRef<string | null>(null);
  const semanticGroupHeaderRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Phase 3: Tree view (per-tab, persisted in UIStore)
  const treeModeTarget = useUIStore(state => state.timelineTreeModeTabs[tabId] ?? false);
  const setTimelineTreeMode = useUIStore(state => state.setTimelineTreeMode);
  // Two-phase expand. The store flag arrives as an URGENT update — flipping
  // the layout in that same render re-built every entry row (hundreds of
  // preview chips) synchronously inside the click handler's frame, so the
  // button that toggled it stayed visually pressed for 1-1.5s on long
  // sessions and macOS showed the beachball cursor. Same defect class and
  // same cure as the History owner handoff: the urgent frame paints only the
  // cheap part (button release, width), and the heavy row re-render follows
  // one frame later inside startTransition, where React can yield to input.
  // Collapse keeps the same path for symmetry — unmounting hundreds of rows
  // is cheaper but still not click-frame material.
  const [treeMode, setTreeModeRender] = useState(treeModeTarget);
  // Progressive expansion budget: how many TAIL entries render as full
  // expanded rows. Expansion jumps to the bottom, so the tail is what the
  // user actually sees; everything above starts as flat stubs and upgrades
  // in frame-sized batches. Without this the expand commit rebuilt every row
  // in one unbreakable chunk — 726ms measured on 2618 entries (during= was
  // none-marked), which is also why startTransition alone is not enough:
  // Timeline is a single component, React cannot yield inside one unit.
  const [expandedRenderBudget, setExpandedRenderBudget] = useState(TIMELINE_EXPAND_INITIAL_ROWS);
  const expandDiagRef = useRef<{ startedAt: number; entries: number; steps: number } | null>(null);
  // Owner switch adopts the new tab's mode IN this render (the official
  // adjust-state-during-render pattern): the deferred handoff must not show
  // two frames of the previous tab's layout on the new tab's rows. This
  // path is already inside Workspace's deferred owner lane, so it costs the
  // click frame nothing.
  const [treeModePrevTabId, setTreeModePrevTabId] = useState(tabId);
  if (treeModePrevTabId !== tabId) {
    setTreeModePrevTabId(tabId);
    setTreeModeRender(treeModeTarget);
    setExpandedRenderBudget(TIMELINE_EXPAND_INITIAL_ROWS);
    expandDiagRef.current = null;
  }
  useEffect(() => {
    if (treeMode === treeModeTarget) return;
    const endExpandMark = markRendererActivity(
      'timeline-' + (treeModeTarget ? 'expand' : 'collapse') + ':' + tabId.slice(-8),
    );
    if (treeModeTarget) {
      expandDiagRef.current = { startedAt: performance.now(), entries: 0, steps: 0 };
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        startTransition(() => setTreeModeRender(treeModeTarget));
        // The mark closes when the transition commit's frame paints — the
        // rAF below is queued after the state update, so a long commit
        // stretches the mark over exactly the work it names.
        requestAnimationFrame(() => endExpandMark());
      });
    });
    return () => {
      endExpandMark();
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [treeMode, treeModeTarget, tabId]);
  // A collapsed timeline re-arms the light budget so the NEXT expand starts
  // cheap again.
  useEffect(() => {
    if (!treeMode) setExpandedRenderBudget(TIMELINE_EXPAND_INITIAL_ROWS);
  }, [treeMode]);
  // The wave: while expanded and rows are still stubs, upgrade one batch per
  // transition commit until the whole list is real. Each step is its own
  // interruptible render, so a click/hover between steps dispatches first —
  // this is what "React cannot yield inside one component" costs us and how
  // we pay it back in installments. Runs behind the visible tail, so the
  // user sees a complete timeline immediately and the upgrade is invisible
  // unless they outrun it scrolling up (then stubs briefly show as thin
  // 22px rows before filling in).
  // Rows upgrade ABOVE the visible tail, so each batch grows the content
  // height above the viewport and would visually drag the tail away. Capture
  // "was pinned to the bottom" BEFORE each step (after the growth the
  // measurement is already poisoned) and re-pin in a layout effect right
  // after the commit, before paint. A user who scrolled up mid-wave fails
  // the capture and is never yanked.
  const waveKeepBottomRef = useRef(true);
  useEffect(() => {
    if (!treeMode) return;
    const total = entries.length;
    if (expandedRenderBudget >= total) {
      const diag = expandDiagRef.current;
      if (diag) {
        expandDiagRef.current = null;
        console.warn('[Timeline:Expand] WAVE_DONE tab=' + tabId.slice(-8)
          + ' entries=' + total
          + ' steps=' + diag.steps
          + ' elapsedMs=' + Math.round(performance.now() - diag.startedAt));
      }
      return;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const diag = expandDiagRef.current;
        if (diag) {
          diag.steps += 1;
          diag.entries = total;
        }
        const el = scrollRef.current;
        waveKeepBottomRef.current = !el
          || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        startTransition(() => {
          setExpandedRenderBudget((current) => current >= total
            ? current
            : Math.min(total, current + TIMELINE_EXPAND_BATCH_ROWS));
        });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [treeMode, expandedRenderBudget, entries.length, tabId]);
  useLayoutEffect(() => {
    if (!treeMode || !waveKeepBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [expandedRenderBudget, treeMode]);
  const showToast = useUIStore(state => state.showToast);
  // Dedup CHAIN BREAK toast per (session, count): show once when recovery first appears
  // (proxy crash dropped an in-flight assistant response, history auto-recovered).
  const chainBreakNotifiedRef = useRef<Map<string, number>>(new Map());
  // Last orphan uuid we already toast'ed for this session — used so a NEW
  // orphan (different uuid) in the same session produces a fresh toast.
  const chainBreakLastUuidRef = useRef<Map<string, string>>(new Map());

  const notesPanelWidth = useUIStore(state => state.notesPanelWidth);
  const timelineTooltipWidth = useUIStore(state => state.timelineTooltipWidth);
  const setTimelineTooltipWidth = useUIStore(state => state.setTimelineTooltipWidth);
  const timelineWidth = useUIStore(state => state.timelineWidth);
  const setTimelineWidth = useUIStore(state => state.setTimelineWidth);
  const timelineFontSize = useUIStore(state => state.timelineFontSize);
  const timelineSummaryFontSize = useUIStore(state => state.timelineSummaryFontSize);
  const timelineLineClamp = useUIStore(state => state.timelineLineClamp);
  // treeMode IS the expanded layout (chip + preview text). Old 160px tree-with-labels
  // visualisation is replaced. Width drag-resizable in expanded mode.
  const isExpandedLayout = readOnly ? false : treeMode;
  const effectiveWidth = isExpandedLayout ? timelineWidth : 32;
  useEffect(() => {
    if (isOpen && isExpandedLayout) return;
    setExpandedGroups((current) => current.size > 0 ? new Set() : current);
  }, [isExpandedLayout, isOpen, tabId]);
  const [widthTransitionTabKey, setWidthTransitionTabKey] = useState(tabId);
  const widthTransitionEnabled = widthTransitionTabKey === tabId;
  useLayoutEffect(() => {
    if (widthTransitionTabKey === tabId) return;
    const raf = requestAnimationFrame(() => setWidthTransitionTabKey(tabId));
    return () => cancelAnimationFrame(raf);
  }, [tabId, widthTransitionTabKey]);
  const handlePinnedSlotTransitionEnd = useCallback((event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'width') return;
    if (!pinned) return;
    window.dispatchEvent(new CustomEvent('timeline:pinned-layout-settled', {
      detail: { tabId, expanded: isExpandedLayout },
    }));
  }, [isExpandedLayout, pinned, tabId]);
  const intrinsicPreviewFontSize = Math.max(timelineFontSize, timelineSummaryFontSize);
  // Measured CSS `right:` value (px) that anchors popups to Timeline's left edge.
  // Computed from real DOM rect — robust to HistoryPanel open/close, treeMode, window resize.
  // Previously hardcoded as `notesPanelWidth + (treeMode ? 160 : 32) - 8` — incorrectly subtracted
  // notesPanelWidth even when HistoryPanel was closed, causing 300px gap between popup and Timeline.
  const [popupRightPx, setPopupRightPx] = useState<number>(40);
  const copyIncludeEditing = useUIStore(state => state.copyIncludeEditing);
  const copyIncludeReading = useUIStore(state => state.copyIncludeReading);
  const copyIncludeUser = useUIStore(state => state.copyIncludeUser);
  const copyIncludeClaude = useUIStore(state => state.copyIncludeClaude);
  const copyIncludeText = useUIStore(state => state.copyIncludeText);
  const copyIncludeThinking = useUIStore(state => state.copyIncludeThinking);
  const copyIncludeBash = useUIStore(state => state.copyIncludeBash);
  const copyIncludeTools = useUIStore(state => state.copyIncludeTools);
  const copyIncludeWebSearch = useUIStore(state => state.copyIncludeWebSearch);
  const copyIncludeToolSearch = useUIStore(state => state.copyIncludeToolSearch);
  const copyIncludeOtherTools = useUIStore(state => state.copyIncludeOtherTools);
  const copyIncludeSubagentResult = useUIStore(state => state.copyIncludeSubagentResult);
  const copyIncludeSubagentHistory = useUIStore(state => state.copyIncludeSubagentHistory);
  const debugHoverBridges = useUIStore(state => state.debugHoverBridges);
  const freezeCmdPopups = useUIStore(state => state.freezeCmdPopups);

  useLayoutEffect(() => {
    if (!historySurfaceVisible) return;
    const releaseGate = (proof: string) => {
      setHistoryPresentedOwnerKey(timelineOwnerKey);
      if (import.meta.env.DEV) {
        console.warn(
          '[Timeline:HistoryGate] released'
          + ' tab=' + tabId.slice(-8)
          + ' session=' + (sessionId ? sessionId.substring(0, 8) : 'none')
          + ' tool=' + toolType
          + ' proof=' + proof
          + ' abs=' + perfAbsNow().toFixed(1)
        );
      }
    };
    // Replay first: the proof is a one-shot event, and an instance that
    // mounts AFTER History already presented (HMR remount, deferred owner
    // handoff) would otherwise wait forever on a bus with nothing left to
    // say — gate closed, initial load never runs, the expanded panel shows
    // a permanent "Loading timeline…" with zero rows (live 05.08:
    // WAVE_DONE entries=0 while History displayed the full session).
    const replayed = readPresentedHistorySurface({ tabId, sessionId, toolType });
    if (replayed) {
      releaseGate('replay:' + String(replayed.proof || 'unknown'));
    }
    const onHistorySurfacePresented = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!matchesHistorySurfacePresented({
        detail,
        tabId,
        sessionId,
        toolType,
      })) return;
      releaseGate(String(detail?.proof || 'unknown'));
    };
    window.addEventListener('history-panel:surface-presented', onHistorySurfacePresented);
    return () => {
      window.removeEventListener('history-panel:surface-presented', onHistorySurfacePresented);
    };
  }, [historySurfaceVisible, sessionId, tabId, timelineOwnerKey, toolType]);

  // All copy settings as a single object — spread into IPC invoke calls (range-copy, single-copy,
  // edit-range source fetch, rewind compact). Centralises forwarding so adding a future flag
  // doesn't require touching every callsite.
  const copyFlags = {
    includeEditing: copyIncludeEditing,
    includeReading: copyIncludeReading,
    includeUser: copyIncludeUser,
    includeClaude: copyIncludeClaude,
    includeText: copyIncludeText,
    includeThinking: copyIncludeThinking,
    includeBash: copyIncludeBash,
    includeTools: copyIncludeTools,
    includeWebSearch: copyIncludeWebSearch,
    includeToolSearch: copyIncludeToolSearch,
    includeOtherTools: copyIncludeOtherTools,
    includeSubagentResult: copyIncludeSubagentResult,
    includeSubagentHistory: copyIncludeSubagentHistory,
  };
  const setHistoryScrollToUuid = useUIStore(state => state.setHistoryScrollToUuid);
  const setHistoryPromptDraft = useUIStore(state => state.setHistoryPromptDraft);
  const setHistoryRewindPreview = useUIStore(state => state.setHistoryRewindPreview);
  const isHistoryOpen = useUIStore(state => state.historyPanelOpenTabs[tabId] ?? false);
  const historyTargetVisible = historySurfaceVisible || isHistoryOpen;
  const historySurfaceKind = historySurfaceVisible
    ? 'primary'
    : isHistoryOpen
      ? 'legacy-panel'
      : 'closed';
  const setHistoryPanelOpen = useUIStore(state => state.setHistoryPanelOpen);
  const historyVisibleUuids = useUIStore(state => state.historyVisibleUuids[tabId]);
  const rewindPreviewOwnerRef = useRef({ tabId, sessionId });
  useEffect(() => {
    const previousOwner = rewindPreviewOwnerRef.current;
    const currentOwner = { tabId, sessionId };
    rewindPreviewOwnerRef.current = currentOwner;
    if (shouldClearRewindPreviewForOwnerTransition(previousOwner, currentOwner)) {
      setHistoryRewindPreview(tabId, null);
    }
  }, [sessionId, setHistoryRewindPreview, tabId]);
  useEffect(() => {
    const clearPreview = (_event: any, data: { tabId?: string } = {}) => {
      if (data?.tabId === tabId) setHistoryRewindPreview(tabId, null);
    };
    ipcRenderer.on('terminal:command-finished', clearPreview);
    ipcRenderer.on('terminal:command-started', clearPreview);
    return () => {
      ipcRenderer.removeListener('terminal:command-finished', clearPreview);
      ipcRenderer.removeListener('terminal:command-started', clearPreview);
    };
  }, [setHistoryRewindPreview, tabId]);
  // SDK tabs render the FULL chat history in-place (assistant-ui virtualized
  // thread), so pre-compact entries are reachable in their own chat — the
  // Timeline "Old History Zone" red background is misleading there. Same idea
  // as isHistoryOpen: when full history is rendered somewhere, don't mark
  // pre-compact entries as unreachable. Fingerprint selector to avoid Map-ref
  // re-renders (see CLAUDE.md anti-pattern «Не подписывайся на Map целиком»).
  const isSdkTab = useWorkspaceStore(state => {
    for (const [, ws] of state.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.tabType === 'claude-sdk';
    }
    return false;
  });
  const isTabAiBusy = useWorkspaceStore(state => {
    for (const [, ws] of state.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return !!(t.aiBusy || t.claudeBusy);
    }
    return false;
  });
  const historyActionSnapshot = isCodex
    ? rewindAgentPresence?.runtimeSnapshot || null
    : null;
  const lifecycleBlocksHistoryAction = rewindAgentStatus === 'busy'
    || rewindAgentStatus === 'starting'
    || rewindAgentStatus === 'stopping';
  const historyActionInFlight = isTabAiBusy || isTurnBusy || lifecycleBlocksHistoryAction;
  const historyRewriteUiBlocked = historyActionInFlight
    || (isCodex && historyActionSnapshot?.canRewriteHistory !== true);
  const historyDeleteUiBlocked = historyActionInFlight
    || (isCodex && historyActionSnapshot?.canDeleteHistory !== true);
  const historyMutationBlockedMessage = historyActionInFlight
    ? 'Дождись завершения текущей отправки или ответа'
    : isCodex
      ? 'Текущая Codex-сессия ещё не подтверждена для изменения истории'
      : 'Изменение истории сейчас недоступно';
  const rejectBlockedHistoryMutation = useCallback((blocked: boolean) => {
    if (!blocked) return false;
    useUIStore.getState().showToast(historyMutationBlockedMessage, 'warning', 2600);
    return true;
  }, [historyMutationBlockedMessage]);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerWrapperRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Compute overlay position from DOM refs instead of % (handles flex-grow, markers, collapsed groups)
  const getOverlayRect = (startIdx: number, endIdx: number): { top: number; height: number } | null => {
    const wrapper = innerWrapperRef.current;
    const startEl = segmentRefs.current[startIdx];
    const endEl = segmentRefs.current[endIdx];
    if (!wrapper || !startEl || !endEl) return null;
    const wrapperTop = wrapper.offsetTop;
    const top = startEl.offsetTop - wrapperTop;
    const bottom = endEl.offsetTop - wrapperTop + endEl.offsetHeight;
    return { top, height: bottom - top };
  };

  // Custom scroll indicator + scroll-down arrow — DOM refs for direct update (no re-render on scroll)
  const thumbRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLButtonElement>(null);
  const jumpTimelineToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);
  const jumpTimelineToBottomAfterLayout = useCallback(() => {
    jumpTimelineToBottom();
    requestAnimationFrame(() => {
      jumpTimelineToBottom();
      requestAnimationFrame(jumpTimelineToBottom);
    });
  }, [jumpTimelineToBottom]);

  // CMD key state for tooltip activation
  const [isCmdHeld, setIsCmdHeld] = useState(false);
  const isCmdHeldRef = useRef(false);
  // CMD+Shift lock — закрепляет ОТКРЫТЫЙ tooltip (entry / note / fork) на месте,
  // как `freezeCmdPopups` из StatusBar, но локально и привязано к жесту.
  // Условия закрытия от ухода курсора/отпускания CMD не срабатывают пока locked=true.
  // Снимается повторным CMD+Shift или mousedown'ом вне tooltip-обёрток (см. ниже).
  const [isLockedTooltip, setIsLockedTooltip] = useState(false);
  const isLockedTooltipRef = useRef(false);
  useEffect(() => { isLockedTooltipRef.current = isLockedTooltip; }, [isLockedTooltip]);
  // Refs для индексов: window-handlers читают синхронно, без пересоздания на ховер.
  const hoveredIndexRef = useRef<number | null>(null);
  const activeTooltipIndexRef = useRef<number | null>(null);
  const activeNoteIndexRef = useRef<number | null>(null);
  const activeForkMarkerIndexRef = useRef<number | null>(null);
  const chainResolvedRef = useRef<string | null>(null); // prevents A→B→A→B feedback loop
  // hoveredForkIndex removed — replaced by hoveredForkMarkerIndex + activeForkMarkerIndex (CMD pattern)

  // Timeline notes state
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notePositions, setNotePositions] = useState<Record<string, 'dot' | 'before' | 'after'>>({});
  const [rewindMarkers, setRewindMarkers] = useState<Set<string>>(new Set());
  const [activeNoteIndex, setActiveNoteIndex] = useState<number | null>(null);
  const [isNoteEditing, setIsNoteEditing] = useState(false);
  const [noteEditText, setNoteEditText] = useState('');
  const [noteEditPosition, setNoteEditPosition] = useState<'dot' | 'before' | 'after'>('before');
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);
  const noteTooltipRef = useRef<HTMLDivElement>(null);
  const [hoveredNoteIndex, setHoveredNoteIndex] = useState<number | null>(null);

  // Note: previously this effect locked Timeline scroll while editRangeState was active.
  // The lock was a leftover from when overlays were positioned in viewport coordinates
  // and detached from the scroll content visually. Overlays now live inside
  // innerWrapperRef (which scrolls with entries), so they stay aligned automatically —
  // and locking scroll only made it impossible for the user to navigate to the active
  // overlay when returning to a tab where the scroll was elsewhere.

  // ════════════════════════════════════════════════════════════
  // SECTION: DERIVATIONS — useMemo'd derivations from entries/forkMarkers
  // ════════════════════════════════════════════════════════════

  // Compute group map for sub-agent entries (Phase 2)
  const groupMap = useMemo(() => computeGroups(entries), [entries]);
  const collapsedGroupPresentation = useMemo(() => {
    const presentations = new Map<string, {
      edited: string[];
      searched: string[];
      isLoop: boolean;
    }>();
    for (const info of groupMap.values()) {
      if (!info.isGroupHeader || presentations.has(info.groupId)) continue;
      const members = entries.slice(info.startIndex, info.startIndex + info.groupSize);
      presentations.set(info.groupId, {
        ...collectTimelineDocs(members),
        isLoop: members.some(candidate => !!getLoopPromptOriginTag(candidate)),
      });
    }
    return presentations;
  }, [entries, groupMap]);
  const entryIndexByUuid = useMemo(() => {
    const indexByUuid = new Map<string, number>();
    entries.forEach((entry, index) => {
      if (entry.uuid) indexByUuid.set(entry.uuid, index);
    });
    return indexByUuid;
  }, [entries]);

  const outlineEligibleUuids = useMemo(() => entries
    .filter((entry) => entry.uuid && !entry.isSubAgent && !entry.isSubAgentTimeout && !getOrchestrationTag(entry) && isEligibleTabTitleEntry(entry))
    .map((entry) => entry.uuid), [entries]);

  const semanticGroups = useMemo<TimelineSemanticGroup[]>(() => {
    const rawGroups = timelineOutlineRecord?.outline?.groups || [];
    if (rawGroups.length === 0 || outlineEligibleUuids.length === 0) return [];
    const eligibleIndex = new Map(outlineEligibleUuids.map((uuid, index) => [uuid, index]));
    return rawGroups.filter((group) => {
      const members = Array.isArray(group.memberUuids) ? group.memberUuids : [];
      if (members.length < 2) return false;
      const first = eligibleIndex.get(members[0]);
      if (first == null) return false;
      return members.every((uuid, offset) => eligibleIndex.get(uuid) === first + offset);
    });
  }, [timelineOutlineRecord, outlineEligibleUuids]);
  const semanticGroupIdsKey = semanticGroups.map((group) => group.id).join('\u001f');

  const semanticActionByUuid = useMemo(() => {
    const map = new Map<string, { description: string; role?: string; manual?: boolean }>();
    const schemaVersion = Number(
      timelineOutlineRecord?.schemaVersion || timelineOutlineRecord?.outline?.schemaVersion || 1
    );
    if (schemaVersion >= 2) {
      for (const turn of timelineOutlineRecord?.outline?.turns || []) {
        const uuid = String(turn?.uuid || '');
        const description = String(turn?.description || turn?.detail || '').trim().replace(/[.。]+$/, '');
        if (uuid && description) map.set(uuid, { description, role: turn.role });
      }
    }
    for (const override of Object.values(timelineActionOverrides || {})) {
      const uuid = String(override?.entryUuid || '');
      const description = String(override?.actionLabel || '').trim().replace(/[.。]+$/, '');
      if (uuid && description) map.set(uuid, { description, manual: true });
    }
    return map;
  }, [timelineOutlineRecord, timelineActionOverrides]);

  const semanticGroupByUuid = useMemo(() => {
    const map = new Map<string, { group: TimelineSemanticGroup; memberIndex: number; role?: string; detail?: string }>();
    const bounds: Array<{ group: TimelineSemanticGroup; startIndex: number; endIndex: number }> = [];
    for (const group of semanticGroups) {
      const memberMeta = new Map((group.members || []).map((member) => [member.uuid, member]));
      group.memberUuids.forEach((uuid, memberIndex) => {
        const meta = memberMeta.get(uuid);
        map.set(uuid, { group, memberIndex, role: meta?.role, detail: meta?.description || meta?.detail });
      });
      const startIndex = entryIndexByUuid.get(group.memberUuids[0]);
      const endIndex = entryIndexByUuid.get(group.memberUuids[group.memberUuids.length - 1]);
      if (startIndex == null || endIndex == null || endIndex < startIndex) continue;
      bounds.push({ group, startIndex, endIndex });
    }

    bounds.forEach((bound, boundIndex) => {
      // A compact describes context accumulated before it, so a compact
      // between semantic groups belongs to the preceding group. Leading
      // compacts attach to the first group and trailing ones to the last.
      const ownershipStartIndex = boundIndex === 0 ? 0 : bound.startIndex;
      const ownershipEndIndex = boundIndex + 1 < bounds.length
        ? bounds[boundIndex + 1].startIndex - 1
        : entries.length - 1;
      for (let index = ownershipStartIndex; index <= ownershipEndIndex; index += 1) {
        const entry = entries[index];
        if (!entry?.uuid || map.has(entry.uuid)) continue;
        const isEmptyCodexContinuation = isCodex && entry.type === 'user' &&
          !String(entry.content || '').trim() && !entry.hasImage;
        if (entry.type === 'compact' || entry.isCompactSummary || isEmptyCodexContinuation) {
          map.set(entry.uuid, { group: bound.group, memberIndex: -1 });
        }
      }
    });
    return map;
  }, [semanticGroups, entries, entryIndexByUuid, isCodex]);

  const semanticMetaPromptByUuid = useMemo(() => new Map(
    (timelineOutlineRecord?.outline?.metaPrompts || []).map((meta) => [meta.uuid, meta])
  ), [timelineOutlineRecord]);

  const codexCompactClusters = useMemo(() => {
    const map = new Map<number, { headIndex: number; count: number; isHead: boolean; isNoise?: boolean }>();
    if (!isCodex) return map;
    let index = 0;
    while (index < entries.length) {
      if (entries[index].type !== 'compact') { index += 1; continue; }
      const headIndex = index;
      const memberIndices: Array<{ index: number; isNoise: boolean }> = [];
      let count = 0;
      while (index < entries.length) {
        const candidate = entries[index];
        if (candidate.type === 'compact') {
          memberIndices.push({ index, isNoise: false });
          count += 1;
          index += 1;
          continue;
        }
        const isEmptyContinuation = candidate.type === 'user' && !String(candidate.content || '').trim() && !candidate.hasImage;
        if (isEmptyContinuation) {
          memberIndices.push({ index, isNoise: true });
          index += 1;
          continue;
        }
        break;
      }
      for (const member of memberIndices) {
        map.set(member.index, {
          headIndex,
          count,
          isHead: member.index === headIndex,
          isNoise: member.isNoise,
        });
      }
    }
    return map;
  }, [entries, isCodex]);

  // Index of the chain-break boundary (= youngest entry of pre-orphan tail).
  // Resolved here from uuid → index for downstream useMemos.
  const claudeMemoryBoundaryIndex = useMemo(() => {
    if (!claudeMemoryBoundaryUuid) return -1;
    return entryIndexByUuid.get(claudeMemoryBoundaryUuid) ?? -1;
  }, [entryIndexByUuid, claudeMemoryBoundaryUuid]);
  // Precompute fork snapshot UUID Sets for suppressing inherited plan mode boundaries
  const forkSnapshotSets = useMemo(() =>
    forkMarkers
      .map(m => normalizeForkMarkerEntryUuids(m.entry_uuids))
      .filter(snapshot => snapshot.length > 0)
      .map(snapshot => new Set(snapshot)),
    [forkMarkers]
  );
  // Per-marker, the index of the LAST entry whose UUID is in the snapshot.
  // The blue stripe is drawn only after that one entry — not after every snapshot↔
  // non-snapshot edge. If the parent session ran rewind / edit-range / delete-range
  // between forks, the snapshot becomes a sparse set of survivors instead of a prefix,
  // and a naive "snapshot edge" detector drew dozens of false stripes.
  const forkMarkerLastSnapIndex = useMemo(() => {
    const arr: number[] = [];
    for (const m of forkMarkers) {
      const snap = normalizeForkMarkerEntryUuids(m.entry_uuids);
      if (snap.length === 0) { arr.push(-1); continue; }
      let lastIdx = -1;
      for (const uuid of snap) {
        const index = entryIndexByUuid.get(uuid);
        if (index != null && index > lastIdx) lastIdx = index;
      }
      arr.push(lastIdx);
    }
    return arr;
  }, [forkMarkers, entryIndexByUuid]);
  const forkMarkerIndexByLastSnapIndex = useMemo(() => {
    const markerIndexByEntryIndex = new Map<number, number>();
    forkMarkerLastSnapIndex.forEach((entryIndex, markerIndex) => {
      if (entryIndex >= 0 && !markerIndexByEntryIndex.has(entryIndex)) {
        markerIndexByEntryIndex.set(entryIndex, markerIndex);
      }
    });
    return markerIndexByEntryIndex;
  }, [forkMarkerLastSnapIndex]);
  const semanticGroupForcedOpenIds = useMemo(() => {
    const forcedOpenIds = new Set<string>();
    const hasActiveRangeAction = selectionStartId !== null ||
      rangeActionMenu !== null ||
      copyingRange !== null ||
      deletingRange !== null ||
      rewindState !== null ||
      editRangeState !== null;

    if (hasActiveRangeAction) {
      semanticGroups.forEach((group) => forcedOpenIds.add(group.id));
      return forcedOpenIds;
    }

    for (const group of semanticGroups) {
      for (const uuid of group.memberUuids) {
        if (notes[uuid] || rewindMarkers.has(uuid)) {
          forcedOpenIds.add(group.id);
          break;
        }
        const rawIndex = entryIndexByUuid.get(uuid);
        if (rawIndex == null) continue;
        if (rawIndex === lastBoundaryIndex || forkMarkerIndexByLastSnapIndex.has(rawIndex)) {
          forcedOpenIds.add(group.id);
          break;
        }
        const current = entries[rawIndex];
        const next = entries[rawIndex + 1];
        if (next && current.sessionId && next.sessionId && current.sessionId !== next.sessionId) {
          forcedOpenIds.add(group.id);
          break;
        }
      }
    }
    return forcedOpenIds;
  }, [
    semanticGroups,
    notes,
    rewindMarkers,
    entryIndexByUuid,
    lastBoundaryIndex,
    forkMarkerIndexByLastSnapIndex,
    entries,
    selectionStartId,
    rangeActionMenu,
    copyingRange,
    deletingRange,
    rewindState,
    editRangeState,
  ]);
  // Count visible nodes (entries minus hidden group children)
  const hasSubAgentGroups = useMemo(() => {
    for (const [, g] of groupMap) {
      if (g.isGroupHeader) return true;
    }
    return false;
  }, [groupMap]);

  // Claude can write one semantic compact as two JSONL records:
  // system/compact_boundary, then an isCompactSummary user record. The boundary
  // is the technical edge; the summary record is the user-facing compact content.
  // Keep both records in Timeline entries for ranges/copy and old-history math,
  // but hide the paired boundary dot. HistoryPanel renders the boundary row and
  // embeds the summary there.
  const hiddenCompactBoundaryIndices = useMemo(() => {
    const indices = new Set<number>();
    entries.forEach((entry, index) => {
      const next = index + 1 < entries.length ? entries[index + 1] : null;
      if (entry.type === 'compact' && next?.isCompactSummary) {
        indices.add(index);
      }
    });
    return indices;
  }, [entries]);

  // ════════════════════════════════════════════════════════════
  // SECTION: CUSTOM SCROLLBAR — thumbRef/arrowRef direct DOM updates (avoid re-render on scroll)
  // ════════════════════════════════════════════════════════════

  // effect: scrollRef + entries/treeMode → scroll/resize listeners drive thumb position + scroll-down arrow visibility via direct DOM style writes
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateThumb = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const thumb = thumbRef.current;
      const arrow = arrowRef.current;
      if (scrollHeight <= clientHeight) {
        if (thumb) thumb.style.display = 'none';
        if (arrow) arrow.style.display = 'none';
        return;
      }
      const ratio = clientHeight / scrollHeight;
      const thumbH = Math.max(ratio * clientHeight, 20); // min 20px
      const maxScroll = scrollHeight - clientHeight;
      const thumbTop = (scrollTop / maxScroll) * (clientHeight - thumbH);
      if (thumb) {
        thumb.style.display = '';
        thumb.style.top = `${thumbTop}px`;
        thumb.style.height = `${thumbH}px`;
      }

      // "Scroll down" arrow: check if reachable entries exist below visible area
      const isAtBottom = scrollTop >= maxScroll - 5;
      let showArrow = false;
      if (!isAtBottom) {
        const visibleBottom = scrollTop + clientHeight;
        const segments = el.querySelectorAll('[data-segment]');
        for (let i = segments.length - 1; i >= 0; i--) {
          const child = segments[i] as HTMLElement;
          if (child.offsetTop >= visibleBottom && !child.dataset.unreachable) {
            showArrow = true;
            break;
          }
        }
      }
      if (arrow) arrow.style.display = showArrow ? '' : 'none';
    };
    updateThumb();
    el.addEventListener('scroll', updateThumb, { passive: true });
    const ro = new ResizeObserver(updateThumb);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateThumb);
      ro.disconnect();
    };
  }, [entries, treeMode]); // recalc when entries change or tree mode toggles

  // effect: entries change → trim segmentRefs array length to match (prevents stale refs)
  useEffect(() => {
    segmentRefs.current = segmentRefs.current.slice(0, entries.length);
  }, [entries]);

  const getElementCenterY = (index: number) => {
    const el = segmentRefs.current[index];
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return rect.top + rect.height / 2;
  };

  const getEntryAnchoredPopupTop = (
    index: number,
    contentHeight: number,
    estimatedHeight: number,
    fallbackCenterY?: number
  ) => {
    const centerY = index >= 0 ? getElementCenterY(index) : (fallbackCenterY ?? window.innerHeight / 2);
    const topMargin = 40;
    const bottomMargin = 0;
    const estimate = Math.max(1, estimatedHeight);
    const height = Math.max(1, contentHeight || estimate);
    const idealTop = centerY - estimate / 2;

    if (idealTop < topMargin) {
      return topMargin;
    }
    if (idealTop + estimate > window.innerHeight - bottomMargin) {
      return Math.max(topMargin, window.innerHeight - height - bottomMargin);
    }
    return centerY - height / 2;
  };

  // effect: activeTooltipIndex changes → reset isExpanded + tooltipCopied (each new tooltip starts collapsed/un-copied)
  useEffect(() => {
    setIsExpanded(false);
    setTooltipCopied(false);
  }, [activeTooltipIndex]);

  useEffect(() => {
    setCompactSummaryCache({});
  }, [sessionId]);

  // Claude has a real compact summary and keeps the existing lazy tooltip path.
  // Codex's original compact body is server-encrypted; do not fetch or present
  // replacement_history as if it were that body — Codex shows count-only ×N.
  useEffect(() => {
    if (!sessionId || isGemini || isCodex || activeTooltipIndex === null) return;
    const entry = entries[activeTooltipIndex];
    if (!entry || entry.type !== 'compact') return;
    if (entry.compactSummary) return;
    if (Object.prototype.hasOwnProperty.call(compactSummaryCache, entry.uuid)) return;

    let cancelled = false;
    const channel = 'claude:get-full-history';
    (async () => {
      try {
        const result = await ipcRenderer.invoke(channel, { sessionId, cwd, tabId });
        if (cancelled) return;
        const fullEntry = Array.isArray(result?.entries)
          ? result.entries.find((item: any) => item?.uuid === entry.uuid)
          : null;
        const summary = typeof fullEntry?.compactSummary === 'string' && fullEntry.compactSummary.trim()
          ? fullEntry.compactSummary
          : null;
        setCompactSummaryCache(prev => (
          Object.prototype.hasOwnProperty.call(prev, entry.uuid)
            ? prev
            : { ...prev, [entry.uuid]: summary }
        ));
      } catch (err) {
        if (!cancelled) {
          console.warn('[Timeline:CompactTooltip] failed to load compact summary:', err);
          setCompactSummaryCache(prev => ({ ...prev, [entry.uuid]: null }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeTooltipIndex, entries, sessionId, cwd, isGemini, isCodex, compactSummaryCache]);

  // ════════════════════════════════════════════════════════════
  // SECTION: POPUPRIGHTPX MEASUREMENT — derives CSS `right:` for every Timeline-anchored popup
  // ════════════════════════════════════════════════════════════

  // effect: isVisible/isHistoryOpen/treeMode/notesPanelWidth → ResizeObserver on containerRef+body + window resize → setPopupRightPx (CSS `right:` for all popups anchored to Timeline left edge)
  useEffect(() => {
    if (!isVisible) return;
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      // Popup's right edge sits exactly at Timeline's left edge (no gap, no overlap).
      // In expanded mode user wants tight join, in compact mode same — single rule.
      const next = Math.max(0, Math.round(window.innerWidth - rect.left));
      setPopupRightPx(prev => prev === next ? prev : next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // ResizeObserver fires on element size changes, but Timeline's `left` can change when an
    // adjacent panel resizes without our element changing size. Observe document.body too —
    // it covers the window-resize and sibling-reflow cases.
    if (document.body) ro.observe(document.body);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [isVisible, historyTargetVisible, treeMode, notesPanelWidth]);

  // ════════════════════════════════════════════════════════════
  // SECTION: CMD-HOLD SYNC — global keydown/keyup tracks Meta; tooltip/note/fork tooltip visibility derives from isCmdHeld+hover state
  // ════════════════════════════════════════════════════════════

  // effect: window keydown/keyup/blur for Meta → isCmdHeld + isCmdHeldRef (tooltip only opens while CMD held)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Meta') {
        isCmdHeldRef.current = true;
        setIsCmdHeld(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') {
        isCmdHeldRef.current = false;
        setIsCmdHeld(false);
      }
    };
    const handleBlur = () => {
      isCmdHeldRef.current = false;
      setIsCmdHeld(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  // effect: isCmdHeld/hoveredIndex/isExpanded → setActiveTooltipIndex (CMD+hover opens; release closes unless expanded/cursor-in-tooltip/resizing/frozen)
  useEffect(() => {
    if (isCmdHeld && hoveredIndex !== null) {
      setActiveTooltipIndex(hoveredIndex);
    } else if (!freezeCmdPopups && !isLockedTooltip && !isCmdHeld && !isExpanded && !isMouseInTooltipRef.current && !isResizingTooltipRef.current) {
      setActiveTooltipIndex(null);
    }
  }, [isCmdHeld, hoveredIndex, isExpanded, freezeCmdPopups, isLockedTooltip]);

  useEffect(() => {
    if (isCmdHeld && hoveredSemanticGroupId) {
      setActiveSemanticGroupId(hoveredSemanticGroupId);
      setActiveTooltipIndex(null);
      setActiveNoteIndex(null);
      setActiveForkMarkerIndex(null);
    } else if (!freezeCmdPopups && !isLockedTooltip && !isCmdHeld) {
      setActiveSemanticGroupId(null);
    }
  }, [isCmdHeld, hoveredSemanticGroupId, freezeCmdPopups, isLockedTooltip]);

  // effect: isCmdHeld/hoveredNoteIndex/isNoteEditing/activeNoteIndex → setActiveNoteIndex (CMD+hover opens note tooltip + hides entry tooltip; release closes unless editing/cursor-in-tooltip/frozen)
  useEffect(() => {
    if (isCmdHeld && hoveredNoteIndex !== null) {
      setActiveNoteIndex(hoveredNoteIndex);
      setActiveTooltipIndex(null); // hide entry tooltip
    } else if (!freezeCmdPopups && !isLockedTooltip && !isCmdHeld && !isNoteEditing && activeNoteIndex !== null && !isMouseInNoteTooltipRef.current) {
      setActiveNoteIndex(null);
    }
  }, [isCmdHeld, hoveredNoteIndex, isNoteEditing, activeNoteIndex, freezeCmdPopups, isLockedTooltip]);

  // Fork marker tooltip: sync with CMD key — same pattern as notes
  const [hoveredForkMarkerIndex, setHoveredForkMarkerIndex] = useState<number | null>(null);
  const [activeForkMarkerIndex, setActiveForkMarkerIndex] = useState<number | null>(null);
  // effect: isCmdHeld/hoveredForkMarkerIndex/activeForkMarkerIndex → setActiveForkMarkerIndex (CMD+hover opens fork tooltip + hides entry tooltip; release closes unless cursor-in-tooltip)
  useEffect(() => {
    if (isCmdHeld && hoveredForkMarkerIndex !== null) {
      setActiveForkMarkerIndex(hoveredForkMarkerIndex);
      setActiveTooltipIndex(null); // hide entry tooltip
    } else if (!freezeCmdPopups && !isLockedTooltip && !isCmdHeld && activeForkMarkerIndex !== null && !isMouseInForkTooltipRef.current) {
      setActiveForkMarkerIndex(null);
    }
  }, [isCmdHeld, hoveredForkMarkerIndex, activeForkMarkerIndex, freezeCmdPopups, isLockedTooltip]);

  // effect: зеркалим индексы в refs — нужны для синхронного чтения в keydown/mousedown listener'ах.
  useEffect(() => { hoveredIndexRef.current = hoveredIndex; }, [hoveredIndex]);
  useEffect(() => { activeTooltipIndexRef.current = activeTooltipIndex; }, [activeTooltipIndex]);
  useEffect(() => {
    activeSemanticGroupIdRef.current = activeSemanticGroupId;
  }, [activeSemanticGroupId]);
  useEffect(() => { activeNoteIndexRef.current = activeNoteIndex; }, [activeNoteIndex]);
  useEffect(() => { activeForkMarkerIndexRef.current = activeForkMarkerIndex; }, [activeForkMarkerIndex]);

  // effect: HistoryPanel scrolled-to → clear dot spinner (Cmd+click / open-panel click path).
  useEffect(() => {
    const onScrolledTo = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tabId?: string; uuid?: string; found?: boolean; reason?: string } | undefined;
      if (!detail || detail.tabId !== tabId) return;
      const pending = pendingHistoryScrollRef.current;
      if (!pending || pending.uuid !== detail.uuid) return;
      console.warn('[Timeline:HistoryScroll] ack tab=' + tabId.slice(-12) +
        ' uuid=' + String(detail.uuid || '').slice(0, 8) +
        ' found=' + detail.found +
        ' reason=' + (detail.reason || '-') +
        ' index=' + pending.index);
      pendingHistoryScrollRef.current = null;
      if (historyClickTimeoutRef.current) {
        clearTimeout(historyClickTimeoutRef.current);
        historyClickTimeoutRef.current = null;
      }
      if (detail.found === false) {
        setClickedState({ index: pending.index, status: 'failed' });
        setTimeout(() => setClickedState((s) => (s?.index === pending.index ? null : s)), 1200);
      } else {
        setClickedState((s) => (s?.index === pending.index ? null : s));
      }
    };
    window.addEventListener('history-panel:scrolled-to', onScrolledTo);
    return () => window.removeEventListener('history-panel:scrolled-to', onScrolledTo);
  }, [tabId]);

  // effect: CMD+Shift toggle + global mousedown unlock.
  // Закрепить можно когда любой из tooltip'ов открыт или есть hovered entry/note/fork.
  // Снимается повторным CMD+Shift или mousedown'ом вне tooltip-обёрток
  // (метятся атрибутом `data-cmd-hover-popover`).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && e.metaKey) {
        const hasActive = isLockedTooltipRef.current
          || activeTooltipIndexRef.current !== null
          || activeSemanticGroupIdRef.current !== null
          || activeNoteIndexRef.current !== null
          || activeForkMarkerIndexRef.current !== null
          || hoveredIndexRef.current !== null;
        if (!hasActive) return;
        e.preventDefault();
        setIsLockedTooltip(prev => !prev);
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!isLockedTooltipRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-cmd-hover-popover]')) return;
      setIsLockedTooltip(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown, true);
    };
  }, []);

  // ════════════════════════════════════════════════════════════
  // SECTION: TIMELINE DATA LOAD — loadTimeline IPC, 2s poll, session-switch cleanup, _savedEditRangeMap save/restore
  // ════════════════════════════════════════════════════════════

  useLayoutEffect(() => {
    // Invalidate every older request before the browser can paint the new tab.
    // The next load owns a fresh generation and may commit only to this key.
    timelineLoadGenerationRef.current += 1;
    timelineLoadFlightRef.current = {
      ownerKey: timelineOwnerKey,
      promise: null,
      trailingReason: null,
    };
    // Clear the previous owner's rail synchronously, but do not hydrate a
    // large cached rail inside this layout boundary. On the primary History
    // surface that work waits for History's exact painted-owner proof; this
    // keeps a 300-dot Timeline from blocking the first History frame.
    setLoadingOwnerKey(sessionId ? timelineOwnerKey : null);
    setHydratedTimelineOwnerKey('');
    setEntriesSnapshot({
      ownerKey: timelineOwnerKey,
      entries: [],
    });
    setSessionBoundaries([]);
    setForkMarkers([]);
    setCodexSessionMeta(null);
    setClaudeMemoryBoundaryUuid(null);
    setNotes({});
    setNotePositions({});
    setRewindMarkers(new Set());
  }, [timelineOwnerKey, sessionId]);

  // Hydrate a cached rail only after the primary History owner has survived a
  // paint boundary. The transition keeps this secondary surface interruptible;
  // the exact cached revision is still validated by the normal load effect
  // after hydration commits.
  useEffect(() => {
    if (!historyPresentationGateOpen) return;
    const ownerKeyAtHydration = timelineOwnerKey;
    const cachedSnapshot = isCodex && sessionId
      ? getTimelineSnapshotCache(ownerKeyAtHydration)
      : null;
    const commitHydration = () => {
      if (timelineOwnerKeyRef.current !== ownerKeyAtHydration) return;
      if (cachedSnapshot) {
        setEntriesSnapshot({
          ownerKey: ownerKeyAtHydration,
          entries: cachedSnapshot.entries,
        });
        setCodexSessionMeta(cachedSnapshot.sessionMeta || null);
      }
      setHydratedTimelineOwnerKey(ownerKeyAtHydration);
    };
    if (cachedSnapshot) {
      startTransition(commitHydration);
    } else {
      commitHydration();
    }
  }, [
    historyPresentationGateOpen,
    isCodex,
    sessionId,
    timelineOwnerKey,
  ]);

  // Load timeline and fork markers when sessionId changes
  const runTimelineLoad = useCallback(async (reason = 'unknown') => {
    const ownerKeyAtStart = timelineOwnerKey;
    // A listener holding the previous callback may fire during a prop switch.
    // It must not invalidate the fresh owner's in-flight generation.
    if (timelineOwnerKeyRef.current !== ownerKeyAtStart) return;
    const loadGeneration = ++timelineLoadGenerationRef.current;
    const ownsLoad = () => (
      timelineOwnerKeyRef.current === ownerKeyAtStart &&
      timelineLoadGenerationRef.current === loadGeneration
    );
    const loadStartedAt = performance.now();
    const loadStartAbs = performance.timeOrigin + loadStartedAt;
    const shortSession = sessionId ? sessionId.substring(0, 8) : 'none';
    const shortTab = tabId ? tabId.slice(-8) : 'none';
    const visibleAtStart = isVisibleRef.current;
    if (import.meta.env.DEV) {
      console.warn(
        `[Perf:TimelineLoad] start reason=${reason}` +
        ` inst=${timelineInstanceIdRef.current}` +
        ` tab=${shortTab}` +
        ` session=${shortSession}` +
        ` startAbs=${loadStartAbs.toFixed(1)}` +
        ` tool=${isGemini ? 'gemini' : isCodex ? 'codex' : 'claude'}` +
        ` visible=${visibleAtStart}` +
        ` doc=${document.visibilityState}` +
        ` prevEntries=${entriesCountRef.current}`
      );
    }
    if (!sessionId) {
      if (!ownsLoad()) return;
      setEntriesSnapshot({ ownerKey: ownerKeyAtStart, entries: [] });
      setForkMarkers([]);
      setCodexSessionMeta(null);
      setExpandedGroups(new Set());
      setTimelineTreeMode(tabId, false);
      setClaudeMemoryBoundaryUuid(null);
      if (import.meta.env.DEV) {
        console.warn(
          `[Perf:TimelineLoad] done reason=${reason}` +
          ` inst=${timelineInstanceIdRef.current}` +
          ` tab=${shortTab}` +
          ` session=none` +
          ` startAbs=${loadStartAbs.toFixed(1)}` +
          ` endAbs=${perfAbsNow().toFixed(1)}` +
          ` durMs=${(performance.now() - loadStartedAt).toFixed(1)}` +
          ' outcome=no-session'
        );
      }
      return;
    }

    try {
      // Caller attribution rides into main's perfOp registry via the universal
      // IPC wrapper (it lifts source/reason/tabId/visible from the first arg) —
      // a MainLoopGap right after a poll now names WHICH Timeline instance
      // polled, not just "some timeline IPC".
      const callerContext = {
        source: 'Timeline.loadTimeline',
        reason,
        tabId,
        visible: visibleAtStart,
        instanceId: timelineInstanceIdRef.current,
      };
      if (isGemini) {
        // Gemini: single IPC call, no fork markers or session chains
        const timelineResult = await ipcRenderer.invoke('gemini:get-timeline', { sessionId, cwd, ...callerContext });
        if (!ownsLoad()) return;
        if (timelineResult.success) {
          setEntriesSnapshot({ ownerKey: ownerKeyAtStart, entries: timelineResult.entries || [] });
          setSessionBoundaries([]);
          setForkMarkers([]);
          setCodexSessionMeta(null);
          setClaudeMemoryBoundaryUuid(null);
        }
      } else if (isCodex) {
        const cachedSnapshot = getTimelineSnapshotCache(ownerKeyAtStart);
        const timelineResult = await ipcRenderer.invoke('agent-transcript:get-timeline', {
          toolType: 'codex',
          sessionId,
          cwd,
          tabId,
          ifRevision: cachedSnapshot?.revision || null,
          ...callerContext,
        });
        if (!ownsLoad()) return;
        if (timelineResult.success && timelineResult.unchanged === true && cachedSnapshot) {
          setEntriesSnapshot((current) => (
            current.ownerKey === ownerKeyAtStart
            && current.entries === cachedSnapshot.entries
              ? current
              : {
                  ownerKey: ownerKeyAtStart,
                  entries: cachedSnapshot.entries,
                }
          ));
          setCodexSessionMeta((current) => (
            current === (cachedSnapshot.sessionMeta || null)
              ? current
              : cachedSnapshot.sessionMeta || null
          ));
        } else if (timelineResult.success) {
          const nextEntries = timelineResult.entries || [];
          const nextSessionMeta = timelineResult.sessionMeta || null;
          setTimelineSnapshotCache(ownerKeyAtStart, {
            entries: nextEntries,
            sessionMeta: nextSessionMeta,
            revision: timelineResult.revision || null,
          });
          setEntriesSnapshot({ ownerKey: ownerKeyAtStart, entries: nextEntries });
          setSessionBoundaries([]);
          setForkMarkers([]);
          setCodexSessionMeta(nextSessionMeta);
          setClaudeMemoryBoundaryUuid(null);
        }
      } else {
        // Claude: load timeline entries and fork markers in parallel.
        // ifRevision: byte-identical chain files ⇒ identical timeline. The
        // unchanged fast-path spares main the 250-441ms chain resolve that
        // every warm tab switch was paying just to receive the same rows
        // (part of the 15:29 switch-window IPC storm).
        const cachedClaudeSnapshot = getTimelineSnapshotCache(ownerKeyAtStart);
        const [timelineResult, markersResult] = await Promise.all([
          ipcRenderer.invoke('claude:get-timeline', {
            sessionId,
            cwd,
            ifRevision: cachedClaudeSnapshot?.revision || null,
            ...callerContext,
          }),
          ipcRenderer.invoke('claude:get-fork-markers', { sessionId, ...callerContext })
        ]);

        if (!ownsLoad()) return;

        if (timelineResult.success && timelineResult.unchanged === true && cachedClaudeSnapshot) {
          setEntriesSnapshot((current) => (
            current.ownerKey === ownerKeyAtStart
            && current.entries === cachedClaudeSnapshot.entries
              ? current
              : { ownerKey: ownerKeyAtStart, entries: cachedClaudeSnapshot.entries }
          ));
          setCodexSessionMeta(null);
          const cachedExtras = cachedClaudeSnapshot.sessionMeta as unknown as {
            claudeSessionBoundaries?: SessionBoundary[];
            claudeMemoryBoundaryUuid?: string | null;
          } | null;
          setSessionBoundaries(cachedExtras?.claudeSessionBoundaries || []);
          setClaudeMemoryBoundaryUuid(cachedExtras?.claudeMemoryBoundaryUuid || null);
        } else if (timelineResult.success) {
          setTimelineSnapshotCache(ownerKeyAtStart, {
            entries: timelineResult.entries || [],
            // Claude reuses the codex cache record shape; the meta slot
            // carries the two claude-only extras the unchanged path must
            // restore alongside the rows.
            sessionMeta: {
              claudeSessionBoundaries: timelineResult.sessionBoundaries || [],
              claudeMemoryBoundaryUuid: timelineResult.claudeMemoryBoundaryUuid || null,
            } as unknown as CodexTimelineSessionMeta,
            revision: timelineResult.revision || null,
          });
          setEntriesSnapshot({ ownerKey: ownerKeyAtStart, entries: timelineResult.entries || [] });
          setSessionBoundaries(timelineResult.sessionBoundaries || []);
          setCodexSessionMeta(null);
          setClaudeMemoryBoundaryUuid(timelineResult.claudeMemoryBoundaryUuid || null);

          // CHAIN BREAK notifications.
          //
          // Any orphan parentUuid in the JSONL is a chain break — caused by
          // Claude CLI being killed mid-stream (rebuild / Stop button / Esc
          // mid-turn / SSE crash / close-tab / etc.). Live Claude usually
          // still has the missing parent in RAM so the running session keeps
          // working, but the JSONL is corrupted — on next `claude --resume`
          // the live backtrace would truncate at the orphan. AutoRepair fixes
          // this at app boot and at pre-resume time; here we just SURFACE it
          // to the user so they know it happened and can verify the red zone.
          //
          // Toast policy: fire whenever boundaryUuid CHANGES (new orphan
          // appeared OR a different orphan became the newest). Keyed by uuid
          // so a second/third orphan in the same session produces a fresh
          // toast; same uuid = same break = no spam.
          //
          // No compact guard — orphans are independent of /compact. They can
          // appear in sessions with zero compacts (the original bug we hunted
          // for hours: rebuild while Claude is writing). Painting them as
          // post-compact-only red was wrong.
          //
          // [JsonlChainDiag:ChainBreak] log line in main process remains for
          // forensic grep — `tail -F production.log | grep ChainBreak` still works.
          const newBoundaryUuid: string | null = timelineResult.claudeMemoryBoundaryUuid || null;
          const lastNotifiedUuid = chainBreakLastUuidRef.current.get(sessionId);
          if (newBoundaryUuid && newBoundaryUuid !== lastNotifiedUuid) {
            const prevCount = chainBreakNotifiedRef.current.get(sessionId) || 0;
            const newCount = prevCount + 1;
            chainBreakNotifiedRef.current.set(sessionId, newCount);
            chainBreakLastUuidRef.current.set(sessionId, newBoundaryUuid);
            const message = newCount === 1
              ? 'Обрыв UUID в JSONL — записи до обрыва Claude не видит через backtrace, помечены красным. При следующем resume будут восстановлены.'
              : `Ещё один обрыв UUID (всего ${newCount}). Записи до обрыва помечены красным.`;
            showToast(
              message,
              'warning',
              0,
              true,
              undefined,
              undefined,
              undefined,
              tabId
            );
          }

          // Detect session ID change (e.g., after "Clear Context" in plan mode)
          // Guard: prevent A→B→A→B feedback loop (circular session_links from dual-PID Bridge)
          if (timelineResult.latestSessionId && timelineResult.latestSessionId !== sessionId) {
            if (chainResolvedRef.current === timelineResult.latestSessionId) {
              // We already resolved TO this session, and now it wants to go back — cycle detected
              console.warn('[Timeline:ChainResolve] BLOCKED cycle:', sessionId.substring(0, 8), '→', timelineResult.latestSessionId.substring(0, 8), '(already resolved from there)');
            } else {
              console.warn('[Timeline:ChainResolve] OVERWRITE session for tab', tabId, ':', sessionId.substring(0, 8), '→', timelineResult.latestSessionId.substring(0, 8), '(Timeline resolved chain)');
              chainResolvedRef.current = sessionId; // remember WHERE we resolved FROM
              useWorkspaceStore.getState().setClaudeSessionId(tabId, timelineResult.latestSessionId, 'timelineChain');
            }
          }
        }
        if (markersResult.success) {
          // Only keep directParent marker (forked_to === sessionId) — shows fork point in CHILD sessions.
          // fromMe markers (source === sessionId) are NOT shown in parent — fork point is
          // already visible in the child's timeline via its own directParent marker.
          const all = normalizeForkMarkers(markersResult.markers) as ForkMarker[];
          const toMe = all.filter((m: ForkMarker) => m.fork_session_id === sessionId);
          let directParent: ForkMarker | null = null;
          for (const m of toMe) {
            if (!directParent || (m.entry_uuids?.length || 0) > (directParent.entry_uuids?.length || 0)) {
              directParent = m;
            }
          }
          setForkMarkers(directParent ? [directParent] : []);
        }
      }
      // Load notes for this session (works for both Claude and Gemini)
      const notesResult = await ipcRenderer.invoke('timeline:get-notes', { sessionId, ...callerContext });
      if (!ownsLoad()) return;
      if (notesResult.success) {
        setNotes(notesResult.notes || {});
        setNotePositions(notesResult.positions || {});
      }
      // Load rewind markers (pink dots)
      const markersResult = await ipcRenderer.invoke('timeline:get-rewind-markers', { sessionId, ...callerContext });
      if (!ownsLoad()) return;
      if (markersResult.success) {
        setRewindMarkers(new Set(markersResult.markers || []));
      }
    } catch (error) {
      console.error('[Timeline] Error loading timeline:', error);
    } finally {
      if (import.meta.env.DEV) {
        console.warn(
          `[Perf:TimelineLoad] done reason=${reason}` +
          ` inst=${timelineInstanceIdRef.current}` +
          ` tab=${shortTab}` +
          ` session=${shortSession}` +
          ` startAbs=${loadStartAbs.toFixed(1)}` +
          ` endAbs=${perfAbsNow().toFixed(1)}` +
          ` durMs=${(performance.now() - loadStartedAt).toFixed(1)}` +
          ` visibleStart=${visibleAtStart}` +
          ` visibleNow=${isVisibleRef.current}` +
          ` entriesNow=${entriesCountRef.current}`
        );
      }
    }
  }, [sessionId, cwd, tabId, isGemini, isCodex, timelineOwnerKey]);

  // Transcript changes can arrive in bursts (one event per JSONL append). A
  // full Timeline read is expensive for long sessions, so keep one IPC load in
  // flight per owner and collapse every event that arrives meanwhile into one
  // trailing read. The single trailing slot can be updated while that read is
  // running, but requests never overlap.
  const loadTimeline = useCallback((reason = 'unknown'): Promise<void> => {
    const ownerKeyAtRequest = timelineOwnerKey;
    if (timelineOwnerKeyRef.current !== ownerKeyAtRequest) return Promise.resolve();

    let flight = timelineLoadFlightRef.current;
    if (flight.ownerKey !== ownerKeyAtRequest) {
      flight = {
        ownerKey: ownerKeyAtRequest,
        promise: null,
        trailingReason: null,
      };
      timelineLoadFlightRef.current = flight;
    }

    if (flight.promise) {
      flight.trailingReason = reason;
      return flight.promise;
    }

    const hasCachedSnapshot = isCodex &&
      !!peekTimelineSnapshotCache(ownerKeyAtRequest);
    setLoadingOwnerKey(sessionId && !hasCachedSnapshot ? ownerKeyAtRequest : null);
    const runBurst = async () => {
      let nextReason: string | null = reason;
      while (
        nextReason &&
        timelineOwnerKeyRef.current === ownerKeyAtRequest &&
        timelineLoadFlightRef.current === flight
      ) {
        flight.trailingReason = null;
        await runTimelineLoad(nextReason);
        nextReason = flight.trailingReason;
      }
    };

    const promise = runBurst().finally(() => {
      if (timelineLoadFlightRef.current !== flight) return;
      flight.promise = null;
      flight.trailingReason = null;
      setLoadingOwnerKey((currentOwnerKey) => (
        currentOwnerKey === ownerKeyAtRequest ? null : currentOwnerKey
      ));
    });
    flight.promise = promise;
    return promise;
  }, [timelineOwnerKey, sessionId, isCodex, runTimelineLoad]);

  useEffect(() => {
    const plan = planTimelineTranscriptRefresh({
      pending: deferredTranscriptRefreshRef.current,
      isTurnBusy,
      documentVisible: document.visibilityState === 'visible',
      surfaceVisible: isVisible && historyPresentationGateOpen,
    });
    deferredTranscriptRefreshRef.current = plan.pending;
    if (!plan.refresh) return;
    const deferredReason = deferredTranscriptReasonRef.current;
    deferredTranscriptReasonRef.current = null;
    const refreshReason = deferredReason === 'surface-hidden'
      ? 'surface-resume'
      : 'turn-settled';
    console.warn(
      '[Timeline:TranscriptFlush]' +
      ' inst=' + timelineInstanceIdRef.current +
      ' tab=' + tabId.slice(-8) +
      ' session=' + (sessionId ? sessionId.substring(0, 8) : 'none') +
      ' reason=' + refreshReason +
      ' abs=' + perfAbsNow().toFixed(1)
    );
    void loadTimeline(refreshReason);
  }, [
    historyPresentationGateOpen,
    isTurnBusy,
    isVisible,
    loadTimeline,
    sessionId,
    tabId,
  ]);

  // effect: loadTimeline callback identity changes (sessionId/cwd/tabId/isGemini) → trigger initial timeline load
  useEffect(() => {
    if (
      !historyPresentationGateOpen
      || hydratedTimelineOwnerKey !== timelineOwnerKey
    ) return;
    loadTimeline('effect');
  }, [
    historyPresentationGateOpen,
    hydratedTimelineOwnerKey,
    loadTimeline,
    timelineOwnerKey,
  ]);

  useEffect(() => {
    if (!historyPresentationGateOpen || !summaryToolType || !sessionId) return;
    void loadPromptSummaries(summaryToolType, sessionId);
  }, [historyPresentationGateOpen, summaryToolType, sessionId, loadPromptSummaries]);

  useEffect(() => {
    if (!historyPresentationGateOpen || !summaryToolType || !sessionId) return;
    void loadTimelineOutline(summaryToolType, sessionId);
  }, [historyPresentationGateOpen, summaryToolType, sessionId, loadTimelineOutline]);

  useEffect(() => {
    if (!historyPresentationGateOpen || !summaryToolType || !sessionId) return;
    void loadTimelineActionOverrides(summaryToolType, sessionId);
  }, [historyPresentationGateOpen, summaryToolType, sessionId, loadTimelineActionOverrides]);

  useEffect(() => {
    if (!historyPresentationGateOpen || !summaryToolType || !sessionId) return;
    syncTimelineOutlineUuids(summaryToolType, sessionId, outlineEligibleUuids);
  }, [historyPresentationGateOpen, summaryToolType, sessionId, outlineEligibleUuids, syncTimelineOutlineUuids]);

  useEffect(() => {
    if (!outlineSessionKey) {
      setExpandedSemanticGroups(new Set());
      setHoveredSemanticGroupId(null);
      setActiveSemanticGroupId(null);
      hydratedSemanticSessionKeyRef.current = null;
      return;
    }
    const groupIds = semanticGroupIdsKey ? semanticGroupIdsKey.split('\u001f') : [];
    const validIds = new Set(groupIds);
    const sessionChanged = hydratedSemanticSessionKeyRef.current !== outlineSessionKey;
    let restored = new Set<string>();
    try {
      const raw = localStorage.getItem(`timeline-semantic-groups:${outlineSessionKey}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          restored = new Set(parsed.filter((id) => validIds.has(String(id))).map(String));
          if (parsed.length > 0 && restored.size === 0 && groupIds.length > 0) {
            restored.add(groupIds[groupIds.length - 1]);
          }
        }
      } else if (groupIds.length > 0) {
        restored.add(groupIds[groupIds.length - 1]);
      }
    } catch {
      if (groupIds.length > 0) restored.add(groupIds[groupIds.length - 1]);
    }
    setExpandedSemanticGroups(restored);
    setHoveredSemanticGroupId((current) => (
      sessionChanged || (current && !validIds.has(current)) ? null : current
    ));
    setActiveSemanticGroupId((current) => (
      sessionChanged || (current && !validIds.has(current)) ? null : current
    ));
    hydratedSemanticSessionKeyRef.current = outlineSessionKey;
  }, [outlineSessionKey, semanticGroupIdsKey]);

  useEffect(() => {
    if (!outlineSessionKey || semanticGroups.length === 0) return;
    try {
      localStorage.setItem(
        `timeline-semantic-groups:${outlineSessionKey}`,
        JSON.stringify([...expandedSemanticGroups])
      );
    } catch { /* localStorage is optional */ }
  }, [outlineSessionKey, semanticGroups.length, expandedSemanticGroups]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId !== tabId) return;
      if (!summaryToolType || !sessionId) {
        showToast('Нет Claude/Codex сессии для пересказа', 'warning');
        return;
      }
      void refreshPromptSummariesForTab({
        tabId,
        toolType: summaryToolType,
        sessionId,
        entries,
      });
    };
    window.addEventListener('timeline-summary:refresh-tab', handler as EventListener);
    return () => window.removeEventListener('timeline-summary:refresh-tab', handler as EventListener);
  }, [tabId, summaryToolType, sessionId, entries, refreshPromptSummariesForTab, showToast]);

  useEffect(() => {
    if (!promptSummaryAutoEnabled || !summaryToolType || !sessionId) return;
    if (!promptSummaryLoadedSessionKeys.has(`${summaryToolType}:${sessionId}`)) return;
    const eligibleEntries = entries.filter((entry) => entry.uuid && !getOrchestrationTag(entry) && isEligibleTabTitleEntry(entry));
    let cancelled = false;
    // Long sessions can contain hundreds of eligible prompts. Launching every
    // AI request in the same render creates a network/state-update storm; the
    // automatic path is intentionally serialized. Manual full refresh already
    // follows the same bounded pattern in the store.
    void (async () => {
      for (let i = 0; i < eligibleEntries.length; i++) {
        if (cancelled) return;
        const entry = eligibleEntries[i];
        if (!entry.uuid || getOrchestrationTag(entry) || !isEligibleTabTitleEntry(entry)) continue;
        const entryAt = Date.parse(entry.timestamp || '');
        if (promptSummaryAutoSince > 0 && (!Number.isFinite(entryAt) || entryAt < promptSummaryAutoSince - 1000)) continue;
        const previousUserMessages = promptSummaryPreviousUserCount > 0
          ? eligibleEntries.slice(Math.max(0, i - promptSummaryPreviousUserCount), i).map((candidate) => String(candidate.content || ''))
          : [];
        await generatePromptSummary({
          tabId,
          toolType: summaryToolType,
          sessionId,
          entry,
          previousUserMessages,
          iterationIndex: i + 1,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [entries, promptSummaryAutoEnabled, promptSummaryAutoSince, promptSummaryLoadedSessionKeys, promptSummaryPreviousUserCount, summaryToolType, sessionId, tabId, generatePromptSummary]);

  // Tab switch: save editRangeState (ready/done only), reset everything else.
  // What's saved: editRangeState when phase=ready or done (user has Gemini response in panel).
  // What's NOT saved: loading (fetch aborted), applying (runs in background), all other overlays.
  // Why not save loading: abort → re-fetch created infinite loops and "plan mode" errors
  //   from stale entries. User re-selects range instead.
  const prevSessionForCleanup = useRef<string | null>(null);
  // Always-current sessionId ref — closures in async fetchEditRangeCompact capture stale prop
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const prevPropsDiagRef = useRef<{
    tabId: string;
    sessionId: string | null;
    cwd: string;
    isVisible: boolean;
    toolType: string;
  } | null>(null);

  useEffect(() => {
    const inst = timelineInstanceIdRef.current;
    console.warn(
      '[Timeline:Mount]' +
      ' inst=' + inst +
      ' tab=' + tabId.slice(-8) +
      ' session=' + (sessionId ? sessionId.substring(0, 8) : 'none') +
      ' tool=' + toolType +
      ' visible=' + isVisible +
      ' cwdSet=' + (cwd ? '1' : '0') +
      ' abs=' + perfAbsNow().toFixed(1)
    );
    return () => {
      console.warn(
        '[Timeline:Unmount]' +
        ' inst=' + inst +
        ' tab=' + tabId.slice(-8) +
        ' session=' + (sessionIdRef.current ? sessionIdRef.current.substring(0, 8) : 'none') +
        ' visible=' + isVisibleRef.current +
        ' abs=' + perfAbsNow().toFixed(1)
      );
    };
  }, []);

  useEffect(() => {
    const prev = prevPropsDiagRef.current;
    if (prev) {
      const changed = prev.tabId !== tabId ||
        prev.sessionId !== sessionId ||
        prev.cwd !== cwd ||
        prev.isVisible !== isVisible ||
        prev.toolType !== toolType;
      if (changed) {
        console.warn(
          '[Timeline:Props]' +
          ' inst=' + timelineInstanceIdRef.current +
          ' prevTab=' + prev.tabId.slice(-8) +
          ' nextTab=' + tabId.slice(-8) +
          ' prevSession=' + (prev.sessionId ? prev.sessionId.substring(0, 8) : 'none') +
          ' nextSession=' + (sessionId ? sessionId.substring(0, 8) : 'none') +
          ' prevVisible=' + prev.isVisible +
          ' nextVisible=' + isVisible +
          ' prevTool=' + prev.toolType +
          ' nextTool=' + toolType +
          ' cwdChanged=' + (prev.cwd !== cwd ? '1' : '0') +
          ' abs=' + perfAbsNow().toFixed(1)
        );
      }
    }
    prevPropsDiagRef.current = { tabId, sessionId, cwd, isVisible, toolType };
  }, [tabId, sessionId, cwd, isVisible, toolType]);
  // effect: sessionId changes → save/restore editRangeState via _savedEditRangeMap + reset all overlay/selection/tooltip state; unmount cleanup also saves state
  useEffect(() => {
    if (sessionId !== prevSessionForCleanup.current) {
      // Freeze attribution: the whole Timeline instance swap (state reset,
      // rail rebuild in the following commits) used to hide inside the same
      // long task as History's owner-mount and got billed to it — the 919ms
      // task of 05.08 08:12 carried ~800ms of surface swap before History
      // even started. One mark per surface turns during= into a real
      // breakdown instead of one collective suspect.
      const endSwapMark = markRendererActivity('timeline-swap:' + tabId.slice(-8));
      requestAnimationFrame(() => endSwapMark());
      const prevSid = prevSessionForCleanup.current;
      // Always run save/restore — even when prevSid is null (tab without session in between).
      // Without this, switching through a no-session tab (sessionId=null) breaks the chain:
      // A(saved) → null(skip because prevSid=null) → A(no restore because prevSid was null)
      {
        // DON'T abort in-flight fetch on tab switch — let it complete in background.
        // Aborting + re-fetching on every switch wastes Gemini API calls and makes loading
        // take 30-40s instead of 5s (each switch restarts the ~5s fetch from scratch).
        // Guard in fetchEditRangeCompact will save result to _savedEditRangeMap when done.
        const hadFetch = !!editRangeAbortRef.current;
        console.warn('[EditRange:TabSwitch] LEAVE ' + (prevSid?.substring(0, 8) || 'null') + ' → ' + (sessionId?.substring(0, 8) || 'null') + ' editPhase=' + (editRangeState?.phase || 'null') + ' abortedFetch=' + hadFetch + ' savedMapSize=' + _savedEditRangeMap.size);
        // Save editRangeState (loading/ready/done — not applying). Skip if prevSid is null (no session to save for)
        if (prevSid && editRangeState && editRangeState.phase !== 'applying') {
          _savedEditRangeMap.set(prevSid, editRangeState);
          if (_savedEditRangeMap.size > SAVED_MAP_MAX) {
            const first = _savedEditRangeMap.keys().next().value;
            if (first) _savedEditRangeMap.delete(first);
          }
          console.warn('[EditRange:TabSwitch] Saved phase=' + editRangeState.phase + ' range=[' + editRangeState.range.startIndex + ',' + editRangeState.range.endIndex + '] sourceLen=' + (editRangeState.sourceContent?.length || 0) + ' for ' + (prevSid?.substring(0, 8) || 'null'));
        }
        // Restore or reset editRangeState
        const saved = sessionId ? _savedEditRangeMap.get(sessionId) : null;
        if (saved) {
          setEditRangeState(saved);
          _savedEditRangeMap.delete(sessionId);
          console.warn('[EditRange:TabSwitch] Restored phase=' + saved.phase + ' range=[' + saved.range.startIndex + ',' + saved.range.endIndex + '] sourceLen=' + (saved.sourceContent?.length || 0) + ' for ' + sessionId.substring(0, 8));
          // If loading: fetch continues in background, no re-fetch needed.
          // When fetch completes, guard saves result to _savedEditRangeMap → next restore picks it up.
        } else {
          console.warn('[EditRange:TabSwitch] No saved state for ' + sessionId?.substring(0, 8) + ' → null');
          setEditRangeState(null);
        }
        // Always reset everything else
        setEditRangeLoadingMenu(null);
        setCopyingRange(null);
        setCopiedRange(null);
        setSelectionStartId(null);
        selectionStartIdRef.current = null;
        setContextMenu(null);
        setClickedState(null);
        setActiveTooltipIndex(null);
        setHoveredIndex(null);
        setHoveredSemanticGroupId(null);
        setActiveSemanticGroupId(null);
        setPostPromptMode(false);
        setUnreachableIndices(new Set());
        setVisibleEntryIndices(new Set());
        setResponseOnlyIndices(new Set());
      }
      prevSessionForCleanup.current = sessionId;
    }
    // Cleanup on unmount (project switch or conditional unrender when showTimeline=null)
    return () => {
      const sid = prevSessionForCleanup.current;
      const state = editRangeStateRef.current; // ref always current, closure would be stale
      if (sid && state && state.phase !== 'applying') {
        _savedEditRangeMap.set(sid, state);
        console.warn('[EditRange:Unmount] Saved phase=' + state.phase + ' for ' + sid.substring(0, 8));
      }
      // DON'T abort fetch here — let it complete in background and save to _savedEditRangeMap
    };
  }, [sessionId]);

  // Auto-scroll Timeline to bottom whenever the user lands on a tab/session.
  //
  // Intent (user): "переключился на другую вкладку и обратно — скролл всегда внизу",
  // regardless of whether Claude/Gemini/SDK is running or not. The Timeline is a
  // SINGLE instance whose tabId/sessionId props swap on tab switch (isVisible stays
  // true within a project), so the trigger is a (tabId | sessionId) change.
  //
  // The trap the previous impl fell into: it scrolled on the prop-change tick, when
  // `entries` still held the PREVIOUS tab's data — so it scrolled to a stale
  // scrollHeight and never re-scrolled after loadTimeline replaced entries (its guard
  // `sessionId !== prevSessionRef` was already satisfied). Fix: ARM a pending flag on
  // key change, then CONSUME it on the first NON-EMPTY `entries` reference change (the
  // post-load commit). Separately, a real append (entries.length increase) always
  // jumps to bottom; metadata-only refreshes with the same length do not.
  // Timing-independent: no setTimeout window to outrun a slow IPC load.
  const scrollKeyRef = useRef<string | null>(null);
  const pendingBottomRef = useRef(false);
  // effect: (tabId | sessionId) change → arm pending bottom-scroll (consumed by the next fresh entries commit)
  useEffect(() => {
    const key = `${tabId}::${sessionId || ''}`;
    if (key !== scrollKeyRef.current) {
      scrollKeyRef.current = key;
      pendingBottomRef.current = true;
    }
  }, [tabId, sessionId]);

  // effect: first non-empty `entries` commit after arming → jump scroll to bottom (double-rAF survives content-visibility:auto height correction)
  useEffect(() => {
    if (!pendingBottomRef.current || entries.length === 0) return;
    pendingBottomRef.current = false;
    jumpTimelineToBottomAfterLayout();
  }, [entries, jumpTimelineToBottomAfterLayout]);

  // Desktop Timeline follows newly appended entries unconditionally. This is
  // intentionally stronger than the old "preserve manual scroll during refresh"
  // rule: if the transcript gained a new Timeline entry, the rail should land
  // on the latest point immediately.
  const lastTimelineAppendRef = useRef<{ key: string; length: number } | null>(null);
  useEffect(() => {
    const key = `${tabId}::${sessionId || ''}`;
    const prev = lastTimelineAppendRef.current;
    lastTimelineAppendRef.current = { key, length: entries.length };
    if (!prev || prev.key !== key || entries.length === 0) return;
    if (entries.length > prev.length) {
      jumpTimelineToBottomAfterLayout();
    }
  }, [tabId, sessionId, entries.length, jumpTimelineToBottomAfterLayout]);

  // Cmd+\ changes the Timeline from dot rail to expanded preview layout. The
  // browser may keep/reset the old scrollTop while entry heights are being
  // recomputed, so opening the expanded Timeline has its own bottom-jump trigger.
  const expandedLayoutScrollKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${tabId}::${sessionId || ''}::${isExpandedLayout ? 'expanded' : 'rail'}`;
    if (!isVisible || !isExpandedLayout) {
      expandedLayoutScrollKeyRef.current = key;
      return;
    }
    if (entries.length === 0) return;
    if (expandedLayoutScrollKeyRef.current === key) return;
    expandedLayoutScrollKeyRef.current = key;
    jumpTimelineToBottomAfterLayout();
  }, [tabId, sessionId, isVisible, isExpandedLayout, entries.length, jumpTimelineToBottomAfterLayout]);

  // Auto-generate a tab title once the first real user prompt is materialized
  // in the transcript. Uses Timeline entries instead of raw terminal input so
  // service commands and metadata do not become tab names.
  useEffect(() => {
    if (!sessionId || entries.length === 0) return;
    if (toolType !== 'claude' && toolType !== 'codex') return;

    const store = useWorkspaceStore.getState();
    const attemptKey = `${toolType}:${sessionId}`;
    if (_autoTabTitleAttempted.has(attemptKey)) {
      store.consumePendingAutoTabTitle(tabId, toolType, sessionId);
      return;
    }
    if (_autoTabTitleInFlight.has(attemptKey)) return;

    let pendingAutoTitle = store.getPendingAutoTabTitle(tabId, toolType, sessionId);
    let recoveredGenericForkTitle = false;
    if (!pendingAutoTitle && toolType === 'claude' && forkMarkers.length > 0) {
      let tab: any = null;
      for (const [, workspace] of store.openProjects) {
        const candidate = workspace.tabs.get(tabId);
        if (candidate) { tab = candidate; break; }
      }
      const currentSessionId = tab?.claudeSessionId;
      if (tab
          && currentSessionId === sessionId
          && !tab.nameSetManually
          && isGenericAiTabName(tab.name, toolType)) {
        pendingAutoTitle = {
          toolType,
          sessionId,
          mode: 'fork',
          at: Date.now(),
        };
        recoveredGenericForkTitle = true;
        console.warn(
          '[Timeline:AutoTabTitle]' +
          ' recover-generic-fork' +
          ' tab=' + tabId.slice(-8) +
          ' tool=' + toolType +
          ' session=' + sessionId.slice(0, 8) +
          ' name=' + JSON.stringify(tab.name)
        );
      }
    }
    if (!pendingAutoTitle) return;

    const firstUserPrompt = selectAutoTabTitlePrompt(
      entries,
      pendingAutoTitle,
      toolType,
      forkMarkers,
      forkMarkerLastSnapIndex,
      codexSessionMeta
    );
    if (!firstUserPrompt) return;
    console.warn(
      '[Timeline:AutoTabTitle]' +
      ' candidate' +
      ' tab=' + tabId.slice(-8) +
      ' tool=' + toolType +
      ' session=' + sessionId.slice(0, 8) +
      ' mode=' + pendingAutoTitle.mode +
      ' entries=' + entries.length +
      ' promptChars=' + String(firstUserPrompt.content || '').length
    );

    let tab: any = null;
    for (const [, workspace] of store.openProjects) {
      const candidate = workspace.tabs.get(tabId);
      if (candidate) { tab = candidate; break; }
    }
    if (!tab) return;
    if (tab.nameSetManually) {
      console.warn(
        '[Timeline:AutoTabTitle]' +
        ' skip=manual-name' +
        ' tab=' + tabId.slice(-8) +
        ' tool=' + toolType +
        ' session=' + sessionId.slice(0, 8) +
        ' name=' + JSON.stringify(tab.name)
      );
      store.consumePendingAutoTabTitle(tabId, toolType, sessionId);
      _autoTabTitleAttempted.add(attemptKey);
      return;
    }

    const currentSessionId = toolType === 'codex' ? tab.codexSessionId : tab.claudeSessionId;
    if (currentSessionId !== sessionId) {
      console.warn(
        '[Timeline:AutoTabTitle]' +
        ' skip=session-mismatch' +
        ' tab=' + tabId.slice(-8) +
        ' tool=' + toolType +
        ' wanted=' + sessionId.slice(0, 8) +
        ' current=' + (currentSessionId ? String(currentSessionId).slice(0, 8) : 'none')
      );
      return;
    }

    _autoTabTitleInFlight.add(attemptKey);
    const titleToolType = toolType;
    const titleSessionId = sessionId;
    const titleTabId = tabId;
    const titleAttemptKey = attemptKey;
    const sourcePrompt = trimTabTitlePrompt(firstUserPrompt.content);
    console.warn(
      '[Timeline:AutoTabTitle]' +
      ' start' +
      ' tab=' + titleTabId.slice(-8) +
      ' tool=' + titleToolType +
      ' session=' + titleSessionId.slice(0, 8) +
      ' sourceChars=' + sourcePrompt.length
    );
    store.setTabTitleNaming(titleTabId, true);

    void (async () => {
      try {
        const promptConfig = usePromptsStore.getState().getPromptById(TAB_TITLE_PROMPT_ID);
        const title = await generateTabTitleFromPrompt(sourcePrompt, promptConfig);
        if (!title) {
          console.warn(
            '[Timeline:AutoTabTitle]' +
            ' generated-null' +
            ' tab=' + titleTabId.slice(-8) +
            ' tool=' + titleToolType +
            ' session=' + titleSessionId.slice(0, 8)
          );
          if (!recoveredGenericForkTitle) {
            useWorkspaceStore.getState().consumePendingAutoTabTitle(titleTabId, titleToolType, titleSessionId);
          }
          _autoTabTitleAttempted.add(titleAttemptKey);
          return;
        }
        console.warn(
          '[Timeline:AutoTabTitle]' +
          ' rename' +
          ' tab=' + titleTabId.slice(-8) +
          ' tool=' + titleToolType +
          ' session=' + titleSessionId.slice(0, 8) +
          ' title=' + JSON.stringify(title)
        );
        const renamed = useWorkspaceStore.getState().autoRenameTab(titleTabId, title, {
          toolType: titleToolType,
          sessionId: titleSessionId,
        });
        if (renamed) {
          if (!recoveredGenericForkTitle) {
            useWorkspaceStore.getState().consumePendingAutoTabTitle(titleTabId, titleToolType, titleSessionId);
          }
          _autoTabTitleAttempted.add(titleAttemptKey);
        } else {
          console.warn(
            '[Timeline:AutoTabTitle]' +
            ' rename-skipped' +
            ' tab=' + titleTabId.slice(-8) +
            ' tool=' + titleToolType +
            ' session=' + titleSessionId.slice(0, 8) +
            ' title=' + JSON.stringify(title)
          );
          if (!recoveredGenericForkTitle) {
            useWorkspaceStore.getState().consumePendingAutoTabTitle(titleTabId, titleToolType, titleSessionId);
          }
          _autoTabTitleAttempted.add(titleAttemptKey);
        }
      } catch (err: any) {
        console.warn(
          '[Timeline:AutoTabTitle]' +
          ' error' +
          ' tab=' + titleTabId.slice(-8) +
          ' tool=' + titleToolType +
          ' session=' + titleSessionId.slice(0, 8) +
          ' message=' + (err?.message || err)
        );
      } finally {
        console.warn(
          '[Timeline:AutoTabTitle]' +
          ' finish' +
          ' tab=' + titleTabId.slice(-8) +
          ' tool=' + titleToolType +
          ' session=' + titleSessionId.slice(0, 8)
        );
        _autoTabTitleInFlight.delete(titleAttemptKey);
        useWorkspaceStore.getState().setTabTitleNaming(titleTabId, false);
      }
    })();
  }, [entries, sessionId, tabId, toolType, forkMarkers, forkMarkerLastSnapIndex, codexSessionMeta]);

  // effect: subscribe to main-process transcript watcher. UI refreshes on
  // durable JSONL/rollout changes; visibility resume does one reconciliation
  // refresh instead of running a permanent polling loop.
  useEffect(() => {
    if (!sessionId || isGemini) {
      console.warn(
        '[Timeline:TranscriptInactive]' +
        ' inst=' + timelineInstanceIdRef.current +
        ' tab=' + tabId.slice(-8) +
        ' session=' + (sessionId ? sessionId.substring(0, 8) : 'none') +
        ' reason=' + (!sessionId ? 'no-session' : 'gemini') +
        ' visible=' + isVisible +
        ' doc=' + document.visibilityState +
        ' abs=' + perfAbsNow().toFixed(1)
      );
      return;
    }

    const consumerId = 'timeline:' + tabId + ':' + toolType + ':' + sessionId;
    let disposed = false;
    let refreshQueued = false;
    const queueRefresh = (reason: string) => {
      if (refreshQueued || disposed) return;
      refreshQueued = true;
      requestAnimationFrame(() => {
        refreshQueued = false;
        if (disposed) return;
        console.warn(
          '[Timeline:TranscriptRefresh]' +
          ' inst=' + timelineInstanceIdRef.current +
          ' tab=' + tabId.slice(-8) +
          ' session=' + sessionId.substring(0, 8) +
          ' reason=' + reason +
          ' visible=' + isVisibleRef.current +
          ' doc=' + document.visibilityState +
          ' abs=' + perfAbsNow().toFixed(1)
        );
        loadTimeline(reason);
      });
    };

    const onTranscriptChanged = (_event: any, detail: any) => {
      if (detail?.sessionId !== sessionId) return;
      if (detail?.toolType && detail.toolType !== toolType) return;
      const busy = isTurnBusyRef.current;
      const surfaceVisible = isVisibleRef.current
        && historyPresentationGateOpenRef.current;
      const documentVisible = document.visibilityState === 'visible';
      const plan = planTimelineTranscriptRefresh({
        pending: deferredTranscriptRefreshRef.current,
        invalidation: true,
        isTurnBusy: busy,
        documentVisible,
        surfaceVisible,
      });
      deferredTranscriptRefreshRef.current = plan.pending;
      if (!plan.refresh) {
        const deferredReason = busy ? 'turn-busy' : 'surface-hidden';
        deferredTranscriptReasonRef.current = deferredReason;
        console.warn(
          '[Timeline:TranscriptDeferred]' +
          ' inst=' + timelineInstanceIdRef.current +
          ' tab=' + tabId.slice(-8) +
          ' session=' + sessionId.substring(0, 8) +
          ' reason=' + deferredReason +
          ' source=' + (detail?.reason || 'changed') +
          ' visible=' + surfaceVisible +
          ' doc=' + document.visibilityState +
          ' abs=' + perfAbsNow().toFixed(1)
        );
        return;
      }
      deferredTranscriptReasonRef.current = null;
      queueRefresh('transcript-change');
    };

    ipcRenderer.on('agent-transcript:changed', onTranscriptChanged);
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
      console.warn(
        '[Timeline:TranscriptSubscribe]' +
        ' inst=' + timelineInstanceIdRef.current +
        ' tab=' + tabId.slice(-8) +
        ' session=' + sessionId.substring(0, 8) +
        ' success=' + (result?.success ? '1' : '0') +
        ' file=' + (result?.filePath ? '1' : '0') +
        ' visible=' + isVisibleRef.current +
        ' doc=' + document.visibilityState +
        ' abs=' + perfAbsNow().toFixed(1)
      );
    }).catch((err: any) => {
      console.warn('[Timeline:TranscriptSubscribe] failed tab=' + tabId.slice(-8) + ' session=' + sessionId.substring(0, 8) + ' err=' + String(err?.message || err));
    });

    const onVis = () => {
      if (document.visibilityState === 'visible') {
        ipcRenderer.invoke('agent-transcript:refresh', {
          tabId,
          toolType,
          sessionId,
          cwd,
          reason: 'visibility-resume',
        }).catch(() => {});
        const plan = planTimelineTranscriptRefresh({
          pending: deferredTranscriptRefreshRef.current,
          // Visibility resume is itself a reconciliation boundary: filesystem
          // invalidations may have been throttled while the document was hidden.
          invalidation: true,
          isTurnBusy: isTurnBusyRef.current,
          documentVisible: true,
          surfaceVisible: isVisibleRef.current
            && historyPresentationGateOpenRef.current,
        });
        deferredTranscriptRefreshRef.current = plan.pending;
        if (plan.refresh) {
          deferredTranscriptReasonRef.current = null;
          queueRefresh('visibility-resume');
        } else {
          deferredTranscriptReasonRef.current = isTurnBusyRef.current
            ? 'turn-busy'
            : 'surface-hidden';
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVis);
      ipcRenderer.removeListener('agent-transcript:changed', onTranscriptChanged);
      ipcRenderer.invoke('agent-transcript:unsubscribe', { consumerId }).catch(() => {});
    };
  }, [sessionId, cwd, tabId, toolType, isGemini, loadTimeline]);

  // ════════════════════════════════════════════════════════════
  // SECTION: NOTES + REWIND MARKERS + CONTINUE — window event listeners for cross-component triggers
  // ════════════════════════════════════════════════════════════

  // effect: window 'timeline:force-refresh' (for this tabId) → loadTimeline (manual refresh from InfoPanel)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tabId === tabId) {
        loadTimeline('force-refresh');
      }
    };
    window.addEventListener('timeline:force-refresh', handler);
    return () => window.removeEventListener('timeline:force-refresh', handler);
  }, [tabId, loadTimeline]);

  // effect: window 'timeline:scroll-to-bottom' (for this tabId) → scrollRef.scrollTo bottom (triggered by Continue button)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tabId === tabId) {
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        });
      }
    };
    window.addEventListener('timeline:scroll-to-bottom', handler);
    return () => window.removeEventListener('timeline:scroll-to-bottom', handler);
  }, [tabId]);

  // ════════════════════════════════════════════════════════════
  // SECTION: PROMPT BOUNDARY BINDING — map JSONL entries to OSC 7777 markers (Claude only)
  // ════════════════════════════════════════════════════════════

  // effect: entries/tabId/isGemini → terminalRegistry.bindEntryToPromptBoundary for each user entry (skips attribute entries; OSC 7777 markers anchor scrollToEntry; entries without markers fall back to SearchAddon)
  useEffect(() => {
    if (usesTextSearchAnchors || entries.length === 0) return;
    const boundaryCount = terminalRegistry.getPromptBoundaryCount(tabId);
    if (boundaryCount === 0) return;

    // User-type entries only (skip compact, continued, docs_edit, docs_search)
    let promptSeq = 0;
    for (const entry of entries) {
      if (isAttributeEntry(entry)) continue;
      // Try to bind this entry to the next available prompt boundary
      // Boundary 0 = prompt after first response → where second message was typed
      // For entry 0 (first message), there's no boundary (it was typed at the initial prompt)
      // So entry 1 → boundary 0, entry 2 → boundary 1, etc.
      if (promptSeq > 0) {
        terminalRegistry.bindEntryToPromptBoundary(tabId, entry.uuid, promptSeq - 1);
      }
      promptSeq++;
    }
  }, [entries, tabId, usesTextSearchAnchors]);

  // ════════════════════════════════════════════════════════════
  // SECTION: VISIBILITY + REACHABILITY — computePositions/checkVisibility/checkReachability tied to terminal viewport
  // ════════════════════════════════════════════════════════════

  // effect: tabId/entries/isVisible/isGemini/isHistoryOpen/historyVisibleUuids → setVisibleEntryIndices, setResponseOnlyIndices, setUnreachableIndices, setLastBoundaryIndex (history-panel mode uses UUID set; non-history runs computePositions/checkVisibility/checkReachability + terminalRegistry.onViewportChange debounced 100/500ms)
  useEffect(() => {
    if (!isVisible || entries.length === 0) {
      setVisibleEntryIndices(prev => prev.size === 0 ? prev : new Set());
      setResponseOnlyIndices(prev => prev.size === 0 ? prev : new Set());
      setUnreachableIndices(prev => prev.size === 0 ? prev : new Set());
      return;
    }

    // History panel open OR SDK tab — full history rendered elsewhere, no
    // terminal-buffer reachability check applies. SDK tabs in particular have
    // NO xterm buffer at all — running checkReachability against them would
    // mark every entry as unreachable. Visibility for SDK falls back to
    // historyVisibleUuids when the SDK chat reports its viewport via the
    // existing `claude-sdk:visible-uuids` channel (same wire as HistoryPanel).
    if (historyTargetVisible || isSdkTab) {
      setUnreachableIndices(prev => prev.size === 0 ? prev : new Set());
      setResponseOnlyIndices(prev => prev.size === 0 ? prev : new Set());
      // Pre-compact entries are reachable elsewhere (full history is rendered);
      // clear the boundary so `clickIsOldHistory` doesn't gate clicks.
      setLastBoundaryIndex(-1);

      const uuidSet = historyVisibleUuids ? new Set(historyVisibleUuids) : new Set<string>();
      const newVisible = new Set<number>();
      entries.forEach((entry, index) => {
        if (uuidSet.has(entry.uuid)) {
          newVisible.add(index);
        } else if (entry.isCompactSummary && index > 0 && uuidSet.has(entries[index - 1].uuid)) {
          newVisible.add(index);
        }
      });
      setVisibleEntryIndices(prev => {
        if (prev.size === newVisible.size && [...prev].every(i => newVisible.has(i))) return prev;
        return newVisible;
      });
      return;
    }

    // Find the last compact/plan-mode boundary.
    // Entries before this index are cleared from terminal — always unreachable, never visible.
    // Note: 'continued' (fork) and sessionId changes do NOT clear terminal — only compact and plan-mode do.
    // Gemini/Codex exception: compact does NOT mean the pre-compact history is
    // inaccessible in our history layer. Only Claude uses compact as a terminal
    // old-history boundary; Plan Mode is Claude-only too.
    let lastBoundaryIdx = -1;
    if (!isGemini && !isCodex) {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.type === 'compact' || e.isPlan) {
          lastBoundaryIdx = e.type === 'compact' && entries[i + 1]?.isCompactSummary ? i + 1 : i;
        }
      }
    }

    // === Range-based visibility ===
    // Instead of searching for prompt TEXT in the viewport, we resolve each entry's
    // buffer row position (from OSC markers for Claude, text search for Gemini).
    // Each entry "owns" a range from its position to the next entry's position.
    // Visibility = viewport overlaps with the entry's range.
    // This eliminates false positives from duplicate text (e.g. "> [Claude Sub-Agent Response]")
    // and ensures the timeline always shows activity even when scrolling through AI responses.

    // Resolve entry → buffer row positions
    const computePositions = (): number[] => {
      const pos = new Array(entries.length).fill(-1);

      if (usesTextSearchAnchors) {
        // Gemini/Codex: single-pass anchored buffer scan
        const searchData: { searchLines: string[]; entryIndex: number }[] = [];
        entries.forEach((entry, index) => {
          if (index <= lastBoundaryIdx) return;
          if (isAttributeEntry(entry)) return;
          const lines = getSearchLines(entry.content);
          if (lines.length > 0) {
            searchData.push({ searchLines: lines, entryIndex: index });
          }
        });
        if (searchData.length > 0) {
          const rows = terminalRegistry.buildPositionIndex(tabId, searchData);
          searchData.forEach((sd, i) => {
            pos[sd.entryIndex] = rows[i];
            if (rows[i] < 0) {
              warnTimelineTextSearchDiag(`[Timeline:TextSearchDiag] MISS tool=${toolType} entry#${sd.entryIndex} type=${entries[sd.entryIndex].type} searchLines=${JSON.stringify(sd.searchLines)}`);
            }
          });
          const found = rows.filter(r => r >= 0).length;
          const missed = rows.filter(r => r < 0).length;
          if (missed > 0) {
            warnTimelineTextSearchDiag(`[Timeline:TextSearchDiag] tool=${toolType} positions: ${found} found, ${missed} missed, total=${searchData.length}, lastBoundaryIdx=${lastBoundaryIdx}`);
          }
        }
      } else {
        // Claude: map entries to prompt boundary positions.
        // PTY middleware injects OSC 7777 prompt:<seq> at each BUSY→IDLE transition.
        // Entry 0 was typed at the initial prompt (pos 0).
        // Entry N was typed at the prompt shown after Entry N-1's response = boundary N-1.
        // For forked sessions: only the most recent entries have boundaries in this terminal.
        // We map from the END so that the newest entries match the newest boundaries.
        const boundaryLines = terminalRegistry.getPromptBoundaryLines(tabId);

        // Collect indices of "real" entries (non-compact, non-continued, non-docs_edit, non-docs_search) after lastBoundaryIdx
        const realIndices: number[] = [];
        entries.forEach((entry, index) => {
          if (index <= lastBoundaryIdx) return;
          if (isAttributeEntry(entry)) return;
          realIndices.push(index);
        });

        if (boundaryLines.length > 0 && realIndices.length > 0) {
          // Primary: K prompt boundaries → last K+1 real entries get positions
          const positionable = boundaryLines.length + 1;
          const startFrom = Math.max(0, realIndices.length - positionable);

          // First positionable entry → position 0 (typed at initial prompt)
          pos[realIndices[startFrom]] = 0;

          // Subsequent entries → prompt boundary lines in order
          for (let i = 1; i < positionable && (startFrom + i) < realIndices.length; i++) {
            pos[realIndices[startFrom + i]] = boundaryLines[i - 1];
          }
        } else if (realIndices.length > 0) {
          // Fallback: no prompt boundaries registered yet (startup, HMR, etc.)
          // Use text-based buffer search (same approach as Gemini) to find positions.
          const searchData: { searchLines: string[]; entryIndex: number }[] = [];
          for (const idx of realIndices) {
            const entry = entries[idx];
            const text = entry.hasImage ? '[Image' : getSearchText(entry.content);
            if (text) searchData.push({ searchLines: [text], entryIndex: idx });
          }
          if (searchData.length > 0) {
            const rows = terminalRegistry.buildPositionIndex(tabId, searchData);
            searchData.forEach((sd, i) => { pos[sd.entryIndex] = rows[i]; });
          }
        }
      }

      return pos;
    };

    let positions = computePositions();

    // Viewport visibility — range overlap check (no text scanning)
    const checkVisibility = () => {
      const viewport = terminalRegistry.getViewportState(tabId);
      if (!viewport) {
        setVisibleEntryIndices(prev => prev.size === 0 ? prev : new Set());
        setResponseOnlyIndices(prev => prev.size === 0 ? prev : new Set());
        return;
      }

      // Build sorted list of entries with valid positions
      const sorted: { index: number; row: number }[] = [];
      for (let i = 0; i < positions.length; i++) {
        if (positions[i] >= 0) sorted.push({ index: i, row: positions[i] });
      }
      sorted.sort((a, b) => a.row - b.row);

      const newVisible = new Set<number>();
      const newResponseOnly = new Set<number>();
      for (let i = 0; i < sorted.length; i++) {
        const blockStart = sorted[i].row;
        const blockEnd = i + 1 < sorted.length ? sorted[i + 1].row : Infinity;

        // Overlap: block [blockStart, blockEnd) ∩ viewport [top, bottom)
        if (blockStart < viewport.bottom && blockEnd > viewport.top) {
          newVisible.add(sorted[i].index);
          // Prompt row NOT in viewport → we only see the AI response part
          if (blockStart < viewport.top) {
            newResponseOnly.add(sorted[i].index);
          }
        }
      }

      setVisibleEntryIndices(prev => {
        if (prev.size === newVisible.size && [...prev].every(i => newVisible.has(i))) return prev;
        return newVisible;
      });
      setResponseOnlyIndices(prev => {
        if (prev.size === newResponseOnly.size && [...prev].every(i => newResponseOnly.has(i))) return prev;
        return newResponseOnly;
      });
    };

    // Buffer reachability — does the entry exist in the terminal buffer?
    // Uses positions from computePositions: pos >= 0 → reachable, pos < 0 → unreachable.
    // For Gemini, buildPositionIndex already does anchored text search with fallback.
    // For Claude, prompt boundary markers track disposal on scrollback trim.
    const checkReachability = () => {
      // Recompute positions (one buffer scan — serves both visibility and reachability)
      positions = computePositions();

      // Check if the terminal exists and has buffer content.
      // If terminal doesn't exist yet (startup, HMR), don't mark anything red — no data.
      // If terminal exists (even with empty buffer), trust position results: pos < 0 → unreachable.
      const terminal = terminalRegistry.get(tabId);
      const canDetermineReachability = !!terminal;

      const newUnreachable = new Set<number>();

      entries.forEach((entry, index) => {
        if (isAttributeEntry(entry) || entry.isPlan) return;
        if (index <= lastBoundaryIdx) {
          newUnreachable.add(index);
          return;
        }
        if (canDetermineReachability && positions[index] < 0) {
          newUnreachable.add(index);
        }
      });

      // Inherit unreachable for attribute entries (compact/summary/continued/docs/plan) from next regular entry
      entries.forEach((entry, index) => {
        if (!isAttributeEntry(entry) && !entry.isPlan) return;
        if (index <= lastBoundaryIdx) {
          newUnreachable.add(index);
          return;
        }
        for (let j = index + 1; j < entries.length; j++) {
          const next = entries[j];
          if (isAttributeEntry(next) || next.isPlan) continue;
          if (newUnreachable.has(j)) newUnreachable.add(index);
          break;
        }
      });

      if (usesTextSearchAnchors && newUnreachable.size > 0) {
        warnTimelineTextSearchDiag(`[Timeline:TextSearchDiag] tool=${toolType} unreachable=[${[...newUnreachable].join(',')}] terminal=${canDetermineReachability} lastBoundaryIdx=${lastBoundaryIdx} entries=${entries.length}`);
        [...newUnreachable].forEach(idx => {
          const e = entries[idx];
          warnTimelineTextSearchDiag(`[Timeline:TextSearchDiag]   #${idx} type=${e.type} isPlan=${e.isPlan} content=${JSON.stringify(e.content?.substring(0, 60))}`);
        });
      }

      setUnreachableIndices(prev => {
        if (prev.size === newUnreachable.size && [...prev].every(i => newUnreachable.has(i))) return prev;
        return newUnreachable;
      });
      setLastBoundaryIndex(lastBoundaryIdx);

      // Re-check visibility with updated positions
      checkVisibility();
    };

    // Run both on mount / entries change
    checkVisibility();
    checkReachability();

    // On viewport change (scroll + buffer writes via onWriteParsed):
    // - checkVisibility: 100ms debounce (reads cached positions + viewport state — O(n) cheap)
    // - checkReachability: 500ms debounce (recomputes positions from buffer — more expensive)
    let visTimer: ReturnType<typeof setTimeout> | null = null;
    let reachTimer: ReturnType<typeof setTimeout> | null = null;
    terminalRegistry.onViewportChange(tabId, () => {
      if (visTimer) clearTimeout(visTimer);
      visTimer = setTimeout(checkVisibility, 100);
      if (reachTimer) clearTimeout(reachTimer);
      reachTimer = setTimeout(checkReachability, 500);
    });

    return () => {
      if (visTimer) clearTimeout(visTimer);
      if (reachTimer) clearTimeout(reachTimer);
      terminalRegistry.offViewportChange(tabId);
    };
  }, [tabId, entries, isVisible, isGemini, isCodex, usesTextSearchAnchors, historyTargetVisible, isSdkTab, historyVisibleUuids, toolType]);

  // Refs
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipContentRef = useRef<HTMLDivElement>(null);
  const isMouseInTooltipRef = useRef(false);
  const isResizingTooltipRef = useRef(false);
  const isMouseInNoteTooltipRef = useRef(false);
  const isMouseInForkTooltipRef = useRef(false);
  const forkTooltipRef = useRef<HTMLDivElement>(null);
  const tooltipMeasuredRef = useRef(0);
  const [tooltipMeasuredH, setTooltipMeasuredH] = useState(0);

  // ════════════════════════════════════════════════════════════
  // SECTION: TOOLTIP HANDLERS — measurement, dismiss-on-mousedown, enter/leave for entry tooltip + tooltip area
  // ════════════════════════════════════════════════════════════

  // effect: activeTooltipIndex/isExpanded/timelineTooltipWidth → measure tooltipContentRef height before paint → setTooltipMeasuredH (skipped during resize so wrapper doesn't reposition under cursor)
  useLayoutEffect(() => {
    if (isResizingTooltipRef.current) return;
    if (tooltipContentRef.current && activeTooltipIndex !== null) {
      const h = tooltipContentRef.current.getBoundingClientRect().height;
      if (Math.abs(h - tooltipMeasuredRef.current) > 1) {
        tooltipMeasuredRef.current = h;
        setTooltipMeasuredH(h);
      }
    } else if (activeTooltipIndex === null && tooltipMeasuredRef.current !== 0) {
      tooltipMeasuredRef.current = 0;
      setTooltipMeasuredH(0);
    }
  }, [activeTooltipIndex, isExpanded, timelineTooltipWidth]);

  // effect: activeTooltipIndex open → window mousedown listener closes tooltip when click is outside tooltipContentRef (handles dead-zone clicks, scrollbar grabs)
  useEffect(() => {
    if (activeTooltipIndex === null) return;
    const handleGlobalMouseDown = (e: MouseEvent) => {
      if (tooltipContentRef.current?.contains(e.target as Node)) return;
      setActiveTooltipIndex(null);
      setHoveredIndex(null);
    };
    window.addEventListener('mousedown', handleGlobalMouseDown);
    return () => window.removeEventListener('mousedown', handleGlobalMouseDown);
  }, [activeTooltipIndex]);

  const handleMouseEnterSegment = (index: number) => {
    setHoveredIndex(index);
    // Tooltip only appears when CMD is held (synced via useEffect)
    if (isCmdHeldRef.current) {
      setActiveSemanticGroupId(null);
      setActiveTooltipIndex(index);
    }
  };

  const handleMouseLeaveSegment = (e: React.MouseEvent) => {
    // Don't clear hoveredIndex during selection — keeps the range indicator visible
    if (!selectionStartIdRef.current) {
      setHoveredIndex(null);
    }

    // Direct DOM check: if we moved into the tooltip wrapper, definitely keep it open
    if (tooltipRef.current && e.relatedTarget instanceof Node && tooltipRef.current.contains(e.relatedTarget)) {
      return;
    }

    // Get segment bounds to determine direction
    const segmentRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = e.clientX;
    const mouseY = e.clientY;

    // If mouse went LEFT (towards tooltip) - keep open only if within tooltip wrapper bounds
    // Relaxed check (+5px buffer) to catch edge cases where mouseX is slightly inside segment
    // or exactly on the border.
    const wentLeft = mouseX <= segmentRect.left + 5;

    if (wentLeft && !isExpanded) {
      // Check if mouse Y is within tooltip wrapper bounds — if not, cursor is in empty space
      // and will never reach the tooltip, so close immediately
      if (tooltipRef.current) {
        const wrapperRect = tooltipRef.current.getBoundingClientRect();
        if (mouseY < wrapperRect.top || mouseY > wrapperRect.bottom) {
          setActiveTooltipIndex(null);
        }
      }
    } else if (!wentLeft && !isExpanded) {
      setActiveTooltipIndex(null);
    }
  };

  // Simple hover close - CSS bridge handles the gap, no complex JS needed
  const handleMouseLeaveTooltipArea = () => {
    if (!isExpanded && !isResizingTooltipRef.current) {
      setHoveredIndex(null);
      setActiveTooltipIndex(null);
    }
  };

  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const justSetRangeMenuRef = useRef(false);

  const getHistoryPanelTargetUuid = useCallback((entry: TimelineEntry, index: number): string => {
    // In Claude JSONL one semantic compact can be {compact_boundary, isCompactSummary user}.
    // HistoryPanel renders the compact block at the boundary UUID and embeds the summary there,
    // while Timeline shows only the summary dot. Route history-scroll clicks to the rendered row.
    if (entry.isCompactSummary && index > 0 && entries[index - 1]?.type === 'compact') {
      return entries[index - 1].uuid;
    }
    return entry.uuid;
  }, [entries]);

  // ════════════════════════════════════════════════════════════
  // SECTION: CLICK DISPATCH — single/double/right-click + range-selection start; routes to terminal scroll, history-panel scroll, or range action menu
  // ════════════════════════════════════════════════════════════

  const handleEntryClick = (entry: TimelineEntry, e?: React.MouseEvent) => {
    if (readOnly) {
      const index = entries.findIndex(e => e.uuid === entry.uuid);
      const targetUuid = getHistoryPanelTargetUuid(entry, index);
      if (e) e.stopPropagation();
      if (!historyTargetVisible) setHistoryPanelOpen(tabId, true);
      setHistoryScrollToUuid(targetUuid);
      console.warn('[Timeline:HistoryScroll] request tab=' + tabId.slice(-12) +
        ' uuid=' + targetUuid.slice(0, 8) +
        ' entryUuid=' + entry.uuid.slice(0, 8) +
        ' index=' + index +
        ' entries=' + entries.length +
        ' mode=read-only-preview' +
        ' surface=' + historySurfaceKind);
      setClickedState({ index, status: 'loading' });
      pendingHistoryScrollRef.current = { uuid: targetUuid, index };
      if (historyClickTimeoutRef.current) clearTimeout(historyClickTimeoutRef.current);
      historyClickTimeoutRef.current = setTimeout(() => {
        pendingHistoryScrollRef.current = null;
        setClickedState((s) => (s?.index === index ? null : s));
      }, HISTORY_SCROLL_SAFETY_TIMEOUT_MS);
      return;
    }

    // Если режим выделения активен — показываем меню выбора действия
    if (selectionStartIdRef.current) {
      if (selectionStartIdRef.current === entry.uuid) {
        // Клик по той же точке → отменить выделение
        selectionStartIdRef.current = null;
        setSelectionStartId(null);
      } else {
        // Клик по другой точке → показать popup "Копировать / Редактировать / Удалить"
        const startId = selectionStartIdRef.current;
        const startIndex = entries.findIndex(e => e.uuid === startId);
        const endIndex = entries.findIndex(e => e.uuid === entry.uuid);
        const range = {
          startIndex: Math.min(startIndex, endIndex),
          endIndex: Math.max(startIndex, endIndex),
        };

        // Detect boundary crossing — ONLY real cross-file bridge entries count:
        //   - `compact` (auto-compact boundary, type 'compact_boundary' in JSONL)
        //   - `continued` (Context Overflow Recovery bridge — new JSONL, new sessionId, dangling parentUuid)
        // Mere sessionId difference inside the same JSONL is NOT a bridge: it happens when
        // Claude CLI resumes a session (claude --resume) — new file inherits the parent
        // transcript with original sessionIds, then writes new entries with the new sessionId.
        // The parentUuid chain stays intact within the file, so delete-range relinks safely.
        // Our claude:fork-session-file rewrites all sessionIds in the copy, so forks don't
        // create this case in the first place.
        const sliced = entries.slice(range.startIndex, range.endIndex + 1);
        const crossesBoundary = sliced.some(en => en.type === 'compact' || en.type === 'continued' || en.isCompactSummary);

        // Position popup vertically centred on the SECOND click (the entry the user just
        // clicked on). Horizontal anchor is `right:` CSS at render time (popup hugs Timeline
        // left edge), so we no longer compute x from containerRect — that math drifted when
        // Timeline was on the right side of a wide viewport.
        const POPUP_H = 180;
        const targetEl = segmentRefs.current[endIndex];
        const targetRect = targetEl?.getBoundingClientRect();
        let y = targetRect
          ? targetRect.top + targetRect.height / 2 - POPUP_H / 2
          : 100;

        // Clamp vertically — top/bottom only, horizontal handled by `right:` CSS.
        const MARGIN = 10;
        if (y < MARGIN) y = MARGIN;
        if (y + POPUP_H > window.innerHeight - MARGIN) y = window.innerHeight - POPUP_H - MARGIN;

        // Prevent handleClickOutside from immediately clearing the menu
        justSetRangeMenuRef.current = true;
        if (e) e.stopPropagation();

        // Mutually exclusive with the single-point menu — same anchor, same
        // screen position, and this one renders on the higher layer.
        setContextMenu(null);
        setSinglePostPromptEntryUuid(null);
        setPostPromptText('');
        setRangeActionMenu({
          x: 0, y, range,
          startUuid: entries[range.startIndex].uuid,
          endUuid: entries[range.endIndex].uuid,
          crossesBoundary,
        });
      }
      return;
    }

    // Второй клик double-click — отменяем таймер и loader
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      setClickedState(null);
      return;
    }

    const index = entries.findIndex(e => e.uuid === entry.uuid);
    const clickIsOldHistory = !isCodex && lastBoundaryIndex >= 0 && index <= lastBoundaryIndex;
    const historyPanelTargetUuid = getHistoryPanelTargetUuid(entry, index);

    // Cmd+Click (macOS) / Ctrl+Click (other) → принудительно открыть History Panel и
    // проскроллить к этой записи. Обычный клик скроллит в терминале. Mental model
    // пользователя: «обычный клик → видеть промпт в терминале; Cmd+клик → видеть его
    // в полной истории». Если панель уже открыта — поведение совпадает с обычным
    // кликом при isHistoryOpen (scroll-in-history), Cmd просто гарантирует открытие.
    if (e && (e.metaKey || e.ctrlKey)) {
      if (!historyTargetVisible) setHistoryPanelOpen(tabId, true);
      setHistoryScrollToUuid(historyPanelTargetUuid);
      // Spinner on dot — HistoryPanel emits 'history-panel:scrolled-to' when done.
      // Safety: clear in case the panel never mounts (no session).
      console.warn('[Timeline:HistoryScroll] request tab=' + tabId.slice(-12) +
        ' uuid=' + historyPanelTargetUuid.slice(0, 8) +
        ' entryUuid=' + entry.uuid.slice(0, 8) +
        ' index=' + index +
        ' entries=' + entries.length +
        ' mode=cmd-click' +
        ' surface=' + historySurfaceKind);
      setClickedState({ index, status: 'loading' });
      pendingHistoryScrollRef.current = { uuid: historyPanelTargetUuid, index };
      if (historyClickTimeoutRef.current) clearTimeout(historyClickTimeoutRef.current);
      historyClickTimeoutRef.current = setTimeout(() => {
        console.warn('[Timeline:HistoryScroll] timeout tab=' + tabId.slice(-12) +
          ' uuid=' + historyPanelTargetUuid.slice(0, 8) +
          ' entryUuid=' + entry.uuid.slice(0, 8) +
          ' index=' + index +
          ' ms=' + HISTORY_SCROLL_SAFETY_TIMEOUT_MS);
        pendingHistoryScrollRef.current = null;
        setClickedState((s) => (s?.index === index ? null : s));
      }, HISTORY_SCROLL_SAFETY_TIMEOUT_MS);
      return;
    }

    // If history panel is open — scroll to entry in history only, skip terminal scroll
    // This includes compact/continued entries which have no terminal position but DO exist in history panel
    if (historyTargetVisible) {
      setHistoryScrollToUuid(historyPanelTargetUuid);
      console.warn('[Timeline:HistoryScroll] request tab=' + tabId.slice(-12) +
        ' uuid=' + historyPanelTargetUuid.slice(0, 8) +
        ' entryUuid=' + entry.uuid.slice(0, 8) +
        ' index=' + index +
        ' entries=' + entries.length +
        ' mode=history-open' +
        ' surface=' + historySurfaceKind);
      setClickedState({ index, status: 'loading' });
      pendingHistoryScrollRef.current = { uuid: historyPanelTargetUuid, index };
      if (historyClickTimeoutRef.current) clearTimeout(historyClickTimeoutRef.current);
      historyClickTimeoutRef.current = setTimeout(() => {
        console.warn('[Timeline:HistoryScroll] timeout tab=' + tabId.slice(-12) +
          ' uuid=' + historyPanelTargetUuid.slice(0, 8) +
          ' entryUuid=' + entry.uuid.slice(0, 8) +
          ' index=' + index +
          ' ms=' + HISTORY_SCROLL_SAFETY_TIMEOUT_MS);
        pendingHistoryScrollRef.current = null;
        setClickedState((s) => (s?.index === index ? null : s));
      }, HISTORY_SCROLL_SAFETY_TIMEOUT_MS);
      return;
    }

    // SDK tabs render the full chat in-place — scroll-in-SDK works for ANY
    // entry (regular, compact, continued, old-history). Dispatch first so the
    // boundary/attribute gates below don't intercept SDK-reachable entries.
    if (isSdkTab) {
      window.dispatchEvent(new CustomEvent('claude-sdk:scroll-to-entry', { detail: { tabId, uuid: entry.uuid, content: entry.content } }));
      setClickedState({ index, status: 'loading' });
      setTimeout(() => setClickedState(null), 300);
      return;
    }

    // Old history entries are not in the terminal buffer (and HistoryPanel
    // isn't open to render them either). Flash failed X so the click is
    // acknowledged rather than silently ignored.
    if (clickIsOldHistory) {
      setClickedState({ index, status: 'failed' });
      setTimeout(() => setClickedState((s) => (s?.index === index ? null : s)), 1200);
      return;
    }

    // Compact/continued/docs_edit/docs_search have no terminal position. Same
    // failed-flash treatment as old-history — without HistoryPanel they're
    // non-navigable.
    if (isAttributeEntry(entry)) {
      setClickedState({ index, status: 'failed' });
      setTimeout(() => setClickedState((s) => (s?.index === index ? null : s)), 1200);
      return;
    }

    // History panel NOT open — scroll in terminal only
    // Instant visual feedback — loader appears immediately
    setClickedState({ index, status: 'loading' });

    // Diagnose click (debug)
    console.warn(`[Timeline] Clicking entry #${index}. isUnreachable=${unreachableIndices.has(index)}`);

    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;

      let found = false;

      if (usesTextSearchAnchors) {
        // Gemini/Codex: buffer-text search with multi-line matching.
        // These CLIs don't use Claude ❯/⏵ prompt markers,
        // so xterm search addon validation is useless. Instead we search
        // the full buffer text for consecutive lines matching the entry content.
        const searchLines = getSearchLines(entry.content);

        // Count earlier entries with same searchLines[0] (duplicate handling)
        let occurrenceIndex = 0;
        for (let i = 0; i < index; i++) {
          const e = entries[i];
          if (e.type !== entry.type) continue;
          const eLines = getSearchLines(e.content);
          // Compare all search lines for precise duplicate detection
          if (eLines.length === searchLines.length && eLines.every((l, j) => l === searchLines[j])) {
            occurrenceIndex++;
          }
        }

        // Anchored search: find the previous entry's buffer position so we skip
        // past false matches in AI responses. For "continue" (Entry 4), without
        // anchoring it would match "continue" in an AI response before the user
        // actually typed it. By starting after the previous entry, we guarantee
        // the correct chronological match.
        let startAfterRow = -1;
        if (index > 0) {
          // Walk backwards to find the closest previous entry with a locatable position
          for (let pi = index - 1; pi >= 0; pi--) {
            const prevEntry = entries[pi];
            if (isAttributeEntry(prevEntry)) continue;
            const prevLines = getSearchLines(prevEntry.content);
            if (prevLines.length === 0) continue;

            // Count occurrences of this previous entry before it
            let prevOccurrence = 0;
            for (let j = 0; j < pi; j++) {
              const ej = entries[j];
              if (ej.type !== prevEntry.type) continue;
              const ejLines = getSearchLines(ej.content);
              if (ejLines.length === prevLines.length && ejLines.every((l, k) => l === prevLines[k])) {
                prevOccurrence++;
              }
            }

            const prevRow = terminalRegistry.findTextBufferRow(tabId, prevLines, prevOccurrence, startAfterRow);
            if (prevRow >= 0) {
              startAfterRow = prevRow;
              break;
            }
          }
        }

        found = terminalRegistry.scrollToTextInBuffer(tabId, searchLines, occurrenceIndex, startAfterRow);

        // Fallback: if anchored search failed, retry without anchor.
        // This handles cases where the previous entry's anchor was placed too far
        // (e.g., separator patterns matching at wrong position in buffer).
        if (!found && startAfterRow >= 0) {
          console.warn('[Timeline] Anchored search failed (startAfterRow=' + startAfterRow + '), retrying without anchor...');
          found = terminalRegistry.scrollToTextInBuffer(tabId, searchLines, occurrenceIndex, -1);
        }
      } else {
        // Claude: try marker-based navigation first (deterministic), fall back to SearchAddon
        found = terminalRegistry.scrollToEntry(tabId, entry.uuid);
        if (found) {
          console.log('[Timeline] Marker-based scroll succeeded for', entry.uuid);
        } else {
          // Fallback: xterm search addon with ❯/⏵ prompt marker validation
          const searchText = entry.isPlan
            ? 'Plan to implement'
            : getSearchText(entry.content);
          if (searchText) {
            let occurrenceIndex = 0;
            for (let i = 0; i < index; i++) {
              const e = entries[i];
              if (e.type !== entry.type) continue;
              const eKey = e.isPlan
                ? 'Plan to implement'
                : getSearchText(e.content);
              if (eKey === searchText) occurrenceIndex++;
            }
            found = terminalRegistry.searchAndScrollToNth(tabId, searchText, occurrenceIndex, !!entry.isPlan);
          }
        }
      }

      if (found) {
        setTimeout(() => setClickedState(null), 300);
      } else {
        setClickedState({ index, status: 'failed' });
        setTimeout(() => setClickedState(null), 1200);
      }
    }, 250);
  };

  const handleEntryDoubleClick = (entry: TimelineEntry) => {
    if (readOnly) return;
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setClickedState(null);
    selectionStartIdRef.current = entry.uuid;
    setSelectionStartId(entry.uuid);
  };

  const handleRightClick = (e: React.MouseEvent, entry: TimelineEntry, _source?: 'dot' | 'segment') => {
    e.preventDefault();
    e.stopPropagation();
    if (readOnly) return;

    // Position: anchor popup's RIGHT edge to Timeline's LEFT edge (mirrors note tooltip).
    // X is no longer derived from cursor — vertical position follows the dot, horizontal is
    // pinned. Without this popup drifted into the centre of the screen when user clicked the
    // right half of the 32px-wide dot. We store x=0 and rely on `right:` CSS at render time
    // (see context-menu Portal); y is centred on the clicked dot.
    const menuHeight = selectionStartIdRef.current ? 44 : 220;
    const targetIndex = entries.findIndex(en => en.uuid === entry.uuid);
    const targetEl = segmentRefs.current[targetIndex];
    const targetRect = targetEl?.getBoundingClientRect();
    const anchorY = targetRect ? targetRect.top + targetRect.height / 2 : e.clientY;
    const y = getEntryAnchoredPopupTop(targetIndex, menuHeight, menuHeight, anchorY);

    // Both popups anchor to the same left edge of Timeline and are positioned
    // relative to the clicked dot, so they land on top of each other; the range
    // menu also sits on a higher layer. Leaving it open meant the visible
    // "Отменить выделение" was covered by the range menu's own Rewind zone, and
    // a click aimed at cancelling the selection started a real rewind instead
    // (caught in E2E 2026-07-31: cleanup click launched a Gemini fetch). Only
    // one of the two may be open at a time.
    setRangeActionMenu(null);
    setDeleteConfirmMode(false);
    setPostPromptMode(false);
    setSinglePostPromptEntryUuid(null);
    setPostPromptText('');
    // x stays 0 — render layer reads `right` from notesPanelWidth + timeline width.
    setContextMenu({ x: 0, y, entry, anchorY });
  };

  const startRangeSelection = (entry: TimelineEntry) => {
    selectionStartIdRef.current = entry.uuid;
    setSelectionStartId(entry.uuid);
    setContextMenu(null);
  };

  // ════════════════════════════════════════════════════════════
  // SECTION: EDIT-RANGE PIPELINE — Gemini compact fetch, executeRangeAction (copy/edit), executeDeleteRange
  // ════════════════════════════════════════════════════════════

  // Standalone Gemini fetch for edit-range. Used by both executeRangeAction (initial)
  // and tab-switch restore (re-fetch after abort). Does NOT touch selection state.
  // Guard: checks sessionId hasn't changed after fetch (prevents cross-tab state write).
  // expectedSessionId is REQUIRED — prevents cross-tab state writes when abort fails.
  // Uses sessionIdRef.current (always fresh) instead of sessionId closure (stale after tab switch).
  const fetchEditRangeCompact = async (range: { startIndex: number; endIndex: number }, sourceContent: string, expectedSessionId: string, additionalPrompt?: string) => {
    const currentSid = sessionIdRef.current;
    console.warn('[EditRange:Fetch] START range=[' + range.startIndex + ',' + range.endIndex + '] sourceLen=' + sourceContent.length + ' expected=' + expectedSessionId.substring(0, 8) + ' currentRef=' + (currentSid?.substring(0, 8) || 'null') + (additionalPrompt ? ' +postPrompt=' + additionalPrompt.length : ''));
    const { getPromptById, rewindPromptId } = usePromptsStore.getState();
    const promptConfig = getPromptById(rewindPromptId);
    if (!promptConfig) {
      console.warn('[EditRange:Fetch] ABORT: No rewind prompt configured (rewindPromptId=' + rewindPromptId + ')');
      if (sessionIdRef.current === expectedSessionId) setEditRangeState(null);
      return;
    }
    console.warn('[EditRange:Fetch] Prompt found: model=' + promptConfig.model + ' contentLen=' + promptConfig.content?.length);
    // Load attached file contents
    let fileContentsBlock = '';
    const filePaths = promptConfig.filePaths || [];
    if (filePaths.length > 0) {
      const filesResult = await ipcRenderer.invoke('ai-prompts:read-files', filePaths);
      if (filesResult.success && filesResult.data.length > 0) {
        fileContentsBlock = '\n\n' + filesResult.data.map((f: { path: string; content: string }) =>
          `--- File: ${f.path} ---\n${f.content}`
        ).join('\n\n');
      }
    }
    const apiKey = process.env.GEMINI_API_KEY;
    const model = promptConfig.model;
    // If additionalPrompt provided, prepend it as higher-priority instruction
    const promptPrefix = additionalPrompt
      ? `ПРИОРИТЕТНАЯ ИНСТРУКЦИЯ (выполнить в первую очередь):\n${additionalPrompt}\n\n---\nОСНОВНОЙ ПРОМПТ:\n`
      : '';
    const fullPrompt = promptPrefix + promptConfig.content + fileContentsBlock + sourceContent;
    const requestBody: any = { contents: [{ parts: [{ text: fullPrompt }] }] };
    if (model.includes('gemini-3') && promptConfig.thinkingLevel !== 'NONE') {
      requestBody.generationConfig = { thinkingConfig: { thinkingLevel: promptConfig.thinkingLevel } };
    }
    try {
      console.warn('[EditRange:Fetch] Sending to Gemini, model:', model, 'promptLen:', fullPrompt.length);
      editRangeAbortRef.current = new AbortController();
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody), signal: editRangeAbortRef.current.signal }
      );
      editRangeAbortRef.current = null;
      // GUARD: sessionIdRef.current is always fresh (not stale closure).
      // If abort failed (race condition), this catches cross-tab writes.
      const nowSid = sessionIdRef.current;
      console.warn('[EditRange:Fetch] Response received, status:', response.status, 'expected=' + expectedSessionId.substring(0, 8) + ' currentRef=' + (nowSid?.substring(0, 8) || 'null'));
      const data = await response.json();
      const compactText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      // Build error message once — shared by cross-tab and same-tab paths
      const errMsg = !compactText
        ? (response.status >= 400
            ? `Gemini ${response.status}: ${data.error?.message?.substring(0, 120) || data.error?.status || 'ошибка'}`
            : 'Gemini вернул пустой ответ')
        : null;

      if (nowSid !== expectedSessionId) {
        // Tab switched during fetch — save result to map for later restore
        if (compactText) {
          const readyState = { range, phase: 'ready' as const, sourceContent, compactText };
          _savedEditRangeMap.set(expectedSessionId, readyState);
          console.warn('[EditRange:Fetch] CROSS-TAB: saved to map for ' + expectedSessionId.substring(0, 8) + ' len=' + compactText.length);
          // Find tab name and projectId for clickable toast
          const targetTabId = tabId; // captured from component prop closure
          let targetTabName = 'вкладку';
          let targetProjectId = '';
          for (const [pid, ws] of useWorkspaceStore.getState().openProjects) {
            const tab = ws.tabs.get(targetTabId);
            if (tab) { targetTabName = tab.name; targetProjectId = pid; break; }
          }
          useUIStore.getState().showToast(
            'Rewind готов — ',
            'pink',
            5000,
            false,
            undefined,
            targetTabName,
            () => {
              const store = useWorkspaceStore.getState();
              if (targetProjectId && targetProjectId !== store.activeProjectId) {
                store.showWorkspace(targetProjectId);
              }
              if (targetProjectId) {
                store.switchTab(targetProjectId, targetTabId);
              }
            }
          );
        } else {
          // CRITICAL: clear saved loading state, otherwise loader is infinite on tab return
          _savedEditRangeMap.delete(expectedSessionId);
          console.warn('[EditRange:Fetch] CROSS-TAB: empty/error, cleared saved map for ' + expectedSessionId.substring(0, 8) + ' (' + errMsg + ')');
          useUIStore.getState().showToast(errMsg!, 'error', 4000);
        }
        return;
      }
      if (!compactText) {
        console.warn('[EditRange:Fetch] EMPTY response from Gemini. status:', response.status, 'data.error:', JSON.stringify(data.error || 'none').substring(0, 200));
        useUIStore.getState().showToast(errMsg!, 'error', 4000);
        setEditRangeState(null);
        return;
      }
      console.warn('[EditRange:Fetch] Compact ready, length:', compactText.length);
      setEditRangeState({ range, phase: 'ready' as const, sourceContent, compactText });
    } catch (err: any) {
      editRangeAbortRef.current = null;
      if (err.name === 'AbortError') {
        console.warn('[EditRange:Fetch] AbortError (tab switch or user cancel)');
        return;
      }
      console.warn('[EditRange:Fetch] ERROR:', err.message || String(err));
      if (sessionIdRef.current === expectedSessionId) setEditRangeState(null);
    }
  };

  const stopCodexForHistoryMutation = async (operation: 'Edit Range' | 'Delete Range'): Promise<string> => {
    const caller = operation === 'Edit Range'
      ? 'Timeline.codexEditRange'
      : 'Timeline.codexDeleteRange';
    const cmdState = await ipcRenderer.invoke('terminal:getCommandState', {
      tabId,
      caller,
      expectedProcess: 'codex',
      allowProcessTreeLookup: true,
    });
    console.warn(`[Codex${operation.replace(/\s/g, '')}] commandState:`, JSON.stringify(cmdState));
    if (cmdState?.processLookupUnknown && !cmdState?.isRunning) {
      throw new Error(`Не удалось проверить процесс Codex перед ${operation}; история не изменена`);
    }

    // A stopped tab has no live writer to prove. Its persisted session is the
    // historical mutation target; do not auto-resume here because that would
    // silently choose launch settings (model/effort) inside a history action.
    if (!cmdState?.isRunning) {
      const historicalSessionId = sessionIdRef.current;
      if (!historicalSessionId) {
        throw new Error(`Нет Codex-сессии для ${operation}`);
      }
      return historicalSessionId;
    }

    const writerSessionId = await requireConfirmedCodexWriter({
      tabId,
      expectedSessionId: sessionIdRef.current,
      operation: operation === 'Edit Range' ? 'Редактировать историю' : 'Удалить историю',
    });

    const turnState = await ipcRenderer.invoke('codex:get-turn-state', tabId).catch((err: any) => {
      console.warn(`[Codex${operation.replace(/\s/g, '')}] turn-state lookup failed:`, err?.message || err);
      return null;
    });
    if (turnState?.busy === true) {
      throw new Error(`Codex сейчас выполняет turn — дождитесь завершения перед ${operation}`);
    }

    const stopResult = await ipcRenderer.invoke('terminal:stop-ai-process', tabId);
    if (!stopResult?.success) {
      throw new Error(stopResult?.error || 'Failed to stop Codex');
    }
    return writerSessionId;
  };

  const adoptAndRestartCodexHistory = async (newSessionId: string, reason: 'editRange' | 'deleteRange') => {
    const committed = await useWorkspaceStore.getState().setCodexSessionId(tabId, newSessionId, reason);
    if (!committed) throw new Error('Codex session binding could not be committed');
    const launchResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
      tabId,
      command: 'codex-c',
      sessionId: newSessionId,
      cwd,
    }));
    if (launchResult?.success === false) {
      throw new Error(launchResult.error || launchResult.reason || 'Codex restart failed');
    }
  };

  // Third zone of the violet Rewind: open the review window with EMPTY text and
  // let the user write the replacement summary themselves — no Gemini call at
  // all. Shared by the selection menu and the single-point menu; duplicating it
  // per call site is how the two paths drifted apart in the first place (the
  // single-point flow had no window whatsoever).
  const openEditRangeWithoutSummary = async (
    range: { startIndex: number; endIndex: number },
    startUuid: string,
    endUuid: string,
  ) => {
    if (rejectBlockedHistoryMutation(historyRewriteUiBlocked)) return;
    if (!sessionId) return;
    const rangeEntries = entries.slice(range.startIndex, range.endIndex + 1);
    const hasCompact = rangeEntries.some((en) => en.type === 'compact' || en.isCompactSummary);
    const hasContinued = rangeEntries.some((en) => en.type === 'continued');
    if (!isCodex && (hasCompact || hasContinued)) {
      useUIStore.getState().showToast(
        hasCompact
          ? 'Нельзя редактировать диапазон с compact boundary'
          : 'Нельзя редактировать через Context Overflow recovery — только текущий сегмент',
        'error', 3000
      );
      return;
    }
    selectionStartIdRef.current = null;
    setSelectionStartId(null);
    setRangeActionMenu(null);
    setPostPromptMode(false);
    try {
      const copyRangeChannel = isCodex ? 'codex:copy-range' : 'claude:copy-range';
      const result = await ipcRenderer.invoke(copyRangeChannel, {
        sessionId, cwd, startUuid, endUuid,
        ...copyFlags,
      });
      if (result.success) {
        setEditRangeState({ range, phase: 'ready', sourceContent: result.content, compactText: '', autoEditInitial: true });
      } else {
        useUIStore.getState().showToast('Не удалось собрать диапазон', 'error', 3000);
      }
    } catch (err: any) {
      console.error('[EditRange:ManualOpen] Failed:', err);
      useUIStore.getState().showToast('Ошибка: ' + (err.message || err), 'error', 3000);
    }
  };

  const executeRangeAction = async (mode: 'copy' | 'edit', range: { startIndex: number; endIndex: number }, startUuid: string, endUuid: string, additionalPrompt?: string) => {
    if (!sessionId) return;
    if (mode === 'edit' && rejectBlockedHistoryMutation(historyRewriteUiBlocked)) return;

    // Clear selection
    selectionStartIdRef.current = null;
    setSelectionStartId(null);
    setRangeActionMenu(null);
    setPostPromptMode(false);

    if (mode === 'edit') {
      // Edit-range works inside one local history representation. Claude can relink
      // parentUuid; Codex uses a separate copy-on-write rollout rewrite.
      const rangeEntries = entries.slice(range.startIndex, range.endIndex + 1);
      const hasCompact = rangeEntries.some(e => e.type === 'compact' || e.isCompactSummary);
      const hasContinued = rangeEntries.some(e => e.type === 'continued');
      if (!isCodex && (hasCompact || hasContinued)) {
        useUIStore.getState().showToast(
          hasCompact
            ? 'Нельзя редактировать диапазон с compact boundary'
            : 'Нельзя редактировать через Context Overflow recovery — только текущий сегмент',
          'error', 3000
        );
        return;
      }

      // Edit mode: fetch range content → send to Gemini for compact → open panel
      setEditRangeState({ range, phase: 'loading', sourceContent: '', compactText: '' });

      try {
        const copyRangeChannel = isCodex ? 'codex:copy-range' : 'claude:copy-range';
        const result = await ipcRenderer.invoke(copyRangeChannel, {
          sessionId,
          cwd,
          startUuid,
          endUuid,
          ...copyFlags,
        });

        if (!result.success) {
          setEditRangeState(null);
          return;
        }

        const sourceContent = result.content;
        // Update state with sourceContent so tab-switch save has the data for re-fetch
        setEditRangeState({ range, phase: 'loading', sourceContent, compactText: '' });
        await fetchEditRangeCompact(range, sourceContent, sessionId, additionalPrompt);
      } catch (err: any) {
        console.error('[EditRange] Failed to get source content:', err);
        setEditRangeState(null);
      }
      return;
    }

    // Copy mode
    setCopyingRange(range);

    try {
      const copyRangeChannel = isCodex ? 'codex:copy-range' : isGemini ? 'gemini:copy-range' : 'claude:copy-range';
      const result = await ipcRenderer.invoke(copyRangeChannel, {
        sessionId,
        cwd,
        startUuid,
        endUuid,
        ...copyFlags,
      });

      setCopyingRange(null);

      if (result.success) {
        clipboard.writeText(result.content);

        setCopiedRange(range);
        setTimeout(() => {
          setCopiedRange(null);
        }, 800);
      }
    } catch (error) {
      console.error('[Timeline] Range copy failed:', error);
      setCopyingRange(null);
    }
  };

  // Удаление диапазона без вставки compact-entry. Claude переписывает текущий
  // JSONL, Codex создаёт новую локальную версию rollout и продолжает её.
  const executeDeleteRange = async (range: { startIndex: number; endIndex: number }, startUuid: string, endUuid: string) => {
    if (!sessionId) return;
    if (!supportsDeleteRangeActions) return;
    if (rejectBlockedHistoryMutation(historyDeleteUiBlocked)) return;

    // Очистка selection и popup
    selectionStartIdRef.current = null;
    setSelectionStartId(null);
    setContextMenu(null);
    setRangeActionMenu(null);
    setDeleteConfirmMode(false);
    setDeleteEntryConfirmMode(false);
    setDeletingRange(range);

    try {
      let mutationSessionId = sessionId;
      if (isCodex) {
        mutationSessionId = await stopCodexForHistoryMutation('Delete Range');
      }

      const deleteChannel = isCodex ? 'codex:delete-range' : 'claude:delete-range';
      const result = await ipcRenderer.invoke(deleteChannel, {
        sessionId: mutationSessionId,
        cwd,
        startUuid,
        endUuid,
      });

      setDeletingRange(null);

      if (!result.success) {
        useUIStore.getState().showToast(
          'Удаление не удалось: ' + (result.error || 'unknown'),
          'error', 4000
        );
        return;
      }

      const removedTotal = result.removedCount || 0;
      const removedHuman = result.removedUsers || 0;

      if (isCodex) {
        if (!result.newSessionId) {
          throw new Error('Codex delete-range did not return a new session');
        }
        await adoptAndRestartCodexHistory(result.newSessionId, 'deleteRange');
      } else if (result.fileDeleted) {
        // Файл стёрт — освобождаем таб от сессии. Кнопка "Продолжить" запустит claude
        // как новую сессию (без --resume), а Timeline опустеет на следующем рефреше.
        const ws = useWorkspaceStore.getState();
        ws.setClaudeSessionId(tabId, '', 'timelineChain');
      } else {
        loadTimeline('delete-range');
      }

      useUIStore.getState().showToast(
        isCodex
          ? `Удалено ${removedHuman} ходов (${removedTotal} записей). Создана новая версия истории`
          : `Удалено ${removedHuman} сообщений (${removedTotal} записей)`,
        'success', 2500
      );
    } catch (err: any) {
      console.error('[Timeline] Delete range failed:', err);
      setDeletingRange(null);
      useUIStore.getState().showToast(
        'Удаление не удалось: ' + (err?.message || String(err)),
        'error', 4000
      );
    }
  };

  const isSelected = (entry: TimelineEntry, index: number) => {
    if (!selectionStartId) return false;
    const startIndex = entries.findIndex(e => e.uuid === selectionStartId);
    if (startIndex === -1) return false;
    
    const min = Math.min(startIndex, hoveredIndex ?? activeTooltipIndex ?? startIndex);
    const max = Math.max(startIndex, hoveredIndex ?? activeTooltipIndex ?? startIndex);
    
    const currentIndex = entries.findIndex(e => e.uuid === entry.uuid);
    return currentIndex >= min && currentIndex <= max;
  };

  // effect: isExpanded/isNoteEditing/deleteConfirmMode/postPromptMode → window click listener dismisses contextMenu, expanded tooltip, note editor, rangeActionMenu and selection range on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (
        contextMenuRef.current?.contains(target) ||
        rangeActionMenuRef.current?.contains(target) ||
        rewindLoadingMenuRef.current?.contains(target) ||
        editRangeLoadingMenuRef.current?.contains(target)
      )) {
        return;
      }
      setContextMenu(null);
      // The single-point instruction editor lives INSIDE this menu, so it must
      // die with it — a stale target uuid would reopen the editor on the next
      // right-click instead of showing the buttons.
      setSinglePostPromptEntryUuid(null);
      setPostPromptText('');
      // Close expanded tooltip on outside click (skip if resize just ended)
      if (isExpanded && !isResizingTooltipRef.current) {
        // Skip if click target is inside tooltip (resize handle click → drag → mouseup → click)
        if (target && tooltipContentRef.current?.contains(target)) return;
        setIsExpanded(false);
        setActiveTooltipIndex(null);
      }
      // Close note editing on outside click
      if (isNoteEditing) {
        setIsNoteEditing(false);
        setActiveNoteIndex(null);
      }
      // Close range action menu on outside click.
      // Earlier we skipped this for deleteConfirmMode/postPromptMode "to avoid mouse-move dismiss"
      // — but mouseLeave already does that job (it's the disabled handler, not click-outside).
      // Confirm/postPrompt blocked outside-click meant user had no escape if the popup was in the
      // way; only path was hitting Cancel inside the popup. Restoring outside-click as a global
      // dismiss matches every other Timeline popup and matches user expectation.
      // Popup buttons stop propagation via e.stopPropagation() (see popup render), so clicking
      // inside the popup never reaches this handler.
      if (justSetRangeMenuRef.current) {
        justSetRangeMenuRef.current = false;
      } else {
        if (rangeActionMenu) {
          setRangeActionMenu(null);
          setDeleteConfirmMode(false);
          setPostPromptMode(false);
          setPostPromptText('');
        }
      }
      // Cancel range selection if clicking outside timeline
      if (target && selectionStartIdRef.current && containerRef.current && !containerRef.current.contains(target)) {
        selectionStartIdRef.current = null;
        setSelectionStartId(null);
      }
    };
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, [isExpanded, isNoteEditing, deleteConfirmMode, postPromptMode]);

  // ════════════════════════════════════════════════════════════
  // SECTION: REWIND PIPELINE — handleRewind (/rewind TUI menu, optional AI compact paste, scroll stabilization)
  // ════════════════════════════════════════════════════════════

  const getRewindTargetContext = useCallback((entry: TimelineEntry) => {
    const entryIndex = entries.findIndex(e => e.uuid === entry.uuid);
    if (entryIndex === -1) return null;

    // Claude Rewind TUI only shows entries after the last compact/plan boundary.
    // Codex/Gemini native selectors do not have that boundary in our model.
    let lastBoundaryIdx = -1;
    if (!isGemini && !isCodex) {
      for (let i = 0; i < entryIndex; i++) {
        const e = entries[i];
        if (e.type === 'compact' || e.isPlan) {
          lastBoundaryIdx = i;
        }
      }
    }

    const rewindableEntries = entries.filter((e, i) => e.type === 'user' && i > lastBoundaryIdx);
    const targetIndex = rewindableEntries.findIndex(e => e.uuid === entry.uuid);
    if (targetIndex === -1) return null;

    return { entryIndex, rewindableEntries, targetIndex, lastBoundaryIdx };
  }, [entries, isGemini, isCodex]);

  const handleRewind = async (entry: TimelineEntry, mode: RewindOperationMode = 'native', additionalPrompt?: string) => {
    console.warn('[Restore:Rewind] handleRewind called',
      'tool=' + toolType,
      'mode=' + mode,
      'tab=' + tabId.slice(-12),
      'session=' + (sessionId ? sessionId.slice(0, 8) : 'none'),
      'entry=' + entry.uuid.slice(0, 8));
    setContextMenu(null);
    setRewindLoadingMenu(null);
    const rewindStore = useRewindOperationStore.getState();
    const activeForTab = selectActiveRewindOperation(rewindStore, tabId);
    if (activeForTab) {
      console.warn(
        '[Restore:Rewind] ABORT another rewind is already active',
        activeForTab.opId,
        activeForTab.tabId,
      );
      return;
    }
    if (!sessionId) {
      console.warn('[Restore:Rewind] ABORT no sessionId at handler entry');
      return;
    }
    console.warn('[Restore:Rewind] after session guard',
      'entries=' + entries.length,
      'entryType=' + entry.type,
      'entryContent=' + JSON.stringify((entry.content || '').slice(0, 40)));

    const targetContext = getRewindTargetContext(entry);
    console.warn('[Restore:Rewind] targetContext',
      targetContext
        ? ('entryIndex=' + targetContext.entryIndex + ' targetIndex=' + targetContext.targetIndex + ' rewindable=' + targetContext.rewindableEntries.length)
        : 'null');
    if (!targetContext) {
      console.warn('[Restore:Rewind] Target is before compact/plan-mode boundary, cannot rewind');
      return;
    }
    const { entryIndex, rewindableEntries, targetIndex, lastBoundaryIdx } = targetContext;

    const normalizeRewindMatchKey = (text: string) => text.replace(/\s+/g, ' ').trim();
    const projectRewindMatchKey = (text: string) => {
      if (isCodex || isGemini) {
        return {
          menuText: normalizeRewindMatchKey(text),
          menuSource: 'full-text',
        };
      }
      return buildClaudeRewindPromptProjection(text);
    };

    // Count duplicate visible keys AFTER the target within rewindable range.
    // Short 40-char prefixes are ambiguous for adjacent prompts with the same opening.
    const targetProjection = projectRewindMatchKey(entry.content);
    const targetPrefix = targetProjection.menuText;
    let skipDuplicates = 0;
    for (let i = targetIndex + 1; i < rewindableEntries.length; i++) {
      const ePrefix = projectRewindMatchKey(rewindableEntries[i].content).menuText;
      if (ePrefix === targetPrefix) skipDuplicates++;
    }
    console.warn('[Restore:Rewind] duplicate scan done',
      'skipDuplicates=' + skipDuplicates,
      'menuSource=' + targetProjection.menuSource,
      'menuHead=' + JSON.stringify(targetPrefix.slice(0, 80)));

    console.warn('[Restore:Rewind] Starting rewind to entry', targetIndex, '/', rewindableEntries.length,
      '- uuid:', entry.uuid, 'skipDuplicates:', skipDuplicates, 'boundaryIdx:', lastBoundaryIdx,
      'tool:', isGemini ? 'gemini' : isCodex ? 'codex' : 'claude', 'mode:', mode);

    const rewindOpId = Date.now().toString(36) + '-' + entry.uuid.slice(0, 8);
    const rewindStarted = useRewindOperationStore.getState().begin({
      opId: rewindOpId,
      tabId,
      toolType,
      sourceSessionId: sessionId,
      targetUuid: entry.uuid,
      targetText: entry.content,
      targetIndex: entryIndex,
      mode,
      phase: 'preparing',
      message: mode === 'ai' ? 'Preparing transcript for AI Rewind' : 'Preparing Rewind',
    });
    if (!rewindStarted) {
      console.warn('[Restore:Rewind] ABORT operation ownership was claimed concurrently', rewindOpId, tabId);
      return;
    }
    const rewindOperationKey = makeRewindOperationKey(tabId, rewindOpId);
    const getThisRewind = () => selectRewindOperation(
      useRewindOperationStore.getState(),
      tabId,
      rewindOpId,
    );
    const isThisRewindActive = () => (
      useRewindOperationStore.getState().activeOpIdByTab[tabId] === rewindOpId
      && !!getThisRewind()
    );
    const setThisRewindPhase = (
      phase: RewindOperation['phase'],
      message?: string,
    ) => useRewindOperationStore.getState().setPhase(tabId, rewindOpId, phase, message);
    const clearThisRewindState = () => {
      return useRewindOperationStore.getState().clear(tabId, rewindOpId);
    };
    const emitHistoryRewindLog = (
      status: 'start' | 'done' | 'failed',
      error?: string,
      message?: string,
      options: {
        persisted?: boolean;
        historyInputDraft?: boolean;
        historyDraftText?: string;
        historyDraftImages?: HistoryPromptDraftImageRef[];
        historyDraftWarning?: string;
        writerGeneration?: string;
      } = {}
    ) => {
      if (status === 'done') {
        const targetDraft = typeof options.historyDraftText === 'string' && options.historyDraftText.trim()
          ? options.historyDraftText.trim()
          : entry.content.trim();
        const durable = options.persisted === true || (!isCodex && (mode === 'ai' || isGemini));
        if (durable) {
          setHistoryRewindPreview(tabId, null);
        } else if (
          mode === 'native'
          && (toolType === 'claude' || toolType === 'codex')
          && options.historyInputDraft === true
          && targetDraft
        ) {
          setHistoryPromptDraft(
            tabId,
            targetDraft,
            Array.isArray(options.historyDraftImages) && options.historyDraftImages.length > 0
              ? { images: options.historyDraftImages }
              : undefined
          );
          setHistoryRewindPreview(tabId, {
            opId: rewindOpId,
            targetUuid: entry.uuid,
            targetText: targetDraft,
            startedAt: Date.now(),
            sessionId,
            writerGeneration: options.writerGeneration,
          });
        }
      }
      window.dispatchEvent(new CustomEvent('history-panel:rewind-log', {
        detail: {
          tabId,
          opId: rewindOpId,
          status,
          targetUuid: entry.uuid,
          targetText: entry.content,
          mode,
          toolType,
          sourceSessionId: sessionId,
          persisted: options.persisted ?? (!isCodex && (mode === 'ai' || isGemini) && status === 'done'),
          historyInputDraft: options.historyInputDraft,
          historyDraftText: options.historyDraftText,
          historyDraftImages: options.historyDraftImages,
          historyDraftWarning: options.historyDraftWarning,
          writerGeneration: options.writerGeneration,
          error,
          message,
        }
      }));
    };
    const showRewindFailureFeedback = (message: string) => {
      const cleanMessage = String(message || 'Rewind failed').trim();
      const codexToast = (() => {
        if (!isCodex) return null;
        if (/codex_rewind_restored_input_mismatch/i.test(cleanMessage)) {
          return {
            title: 'Rewind остановлен: Codex вернул другой prompt',
            details: 'Rollback уже мог примениться в истории, но в поле ввода вернулся текст, который не совпал с выбранной строкой. История перечитывается из сохранённого лога, а Rewind не отмечается успешным, чтобы не скрыть расхождение.',
          };
        }
        if (/codex_rewind_prime_hint_not_observed|codex_rewind_start_state_not_clean|codex_rewind_start_state_unstable|codex_rewind_transcript_not_observed/i.test(cleanMessage)) {
          return {
            title: 'Rewind не стартовал: Codex не подтвердил режим отката',
            details: 'Codex мог быть готов к обычному вводу, но не показал состояние Rewind после первого шага. История не менялась; операция остановлена до подтверждения, чтобы не откатить не туда.',
          };
        }
        if (/codex_rewind_target_not_selected_before_enter/i.test(cleanMessage)) {
          return {
            title: 'Rewind остановлен: выбранный prompt не подтверждён',
            details: 'Codex открыл историю, но подсвеченная строка не совпала с выбранным prompt. Enter не нажимается, история не меняется, и нужно повторить Rewind с нужной строки.',
          };
        }
        return null;
      })();
      setClickedState({ index: entryIndex, status: 'failed' });
      setTimeout(() => setClickedState((s) => (s?.index === entryIndex ? null : s)), 1600);
      if (!historyTargetVisible) {
        if (codexToast) {
          useUIStore.getState().showToast(
            codexToast.title,
            'error',
            0,
            true,
            undefined,
            undefined,
            undefined,
            tabId,
            undefined,
            codexToast.details
          );
          return;
        }
        useUIStore.getState().showToast(
          cleanMessage.toLowerCase().startsWith('rewind failed')
            ? cleanMessage
            : 'Rewind failed: ' + cleanMessage,
          'error',
          5000
        );
      }
    };
    emitHistoryRewindLog(
      'start',
      undefined,
      mode === 'ai' ? 'Gemini Rewind: preparing transcript...' : undefined
    );

    const finishCancelled = () => {
      if (clearThisRewindState()) {
        emitHistoryRewindLog('failed', 'Rewind cancelled');
      }
      setRewindLoadingMenu(null);
    };

    // IPC channel names based on tool type
    const copyRangeChannel = isCodex ? 'codex:copy-range' : isGemini ? 'gemini:copy-range' : 'claude:copy-range';
    const historyMenuChannel = isCodex ? 'codex:open-history-menu' : isGemini ? 'gemini:open-history-menu' : 'claude:open-history-menu';
    const sourceEndUuid = entries[entries.length - 1].uuid;
    let preparedCodex: PreparedCodexRewindRuntime | null = null;
    if (isCodex) {
      try {
        preparedCodex = await prepareCodexRewindRuntime({
          tabId,
          runtime: getHistoryAgentRuntime('codex'),
          sourceSessionId: sessionId,
          cwd,
          targetIndex,
          targetUuid: entry.uuid,
          endUuid: mode === 'ai' ? sourceEndUuid : null,
          targetFullText: entry.content.trim(),
          rewindableCount: rewindableEntries.length,
        });
      } catch (error: any) {
        if (!isThisRewindActive()) return;
        const message = String(error?.message || error || 'Codex Rewind preparation failed');
        emitHistoryRewindLog('failed', message);
        showRewindFailureFeedback(message);
        clearThisRewindState();
        return;
      }
    }
    if (!isThisRewindActive()) return;

    // Phase 1: Optional AI compact of entries being lost (from clicked entry to end).
    // Native rewind intentionally skips this for the fast `/rewind` → arrows → Enter path.
    let compactText = '';
    let compactError = '';
    if (mode === 'ai') {
      if (!setThisRewindPhase('compacting', 'Preparing compact context with Gemini')) return;

      try {
        emitHistoryRewindLog('start', undefined, 'Gemini Rewind: copying range...');
        const rangeResult = await ipcRenderer.invoke(copyRangeChannel, {
          sessionId: preparedCodex?.writerSessionId || sessionId,
          cwd,
          startUuid: preparedCodex?.targetUuid || entry.uuid,
          endUuid: preparedCodex?.endUuid || sourceEndUuid,
          ...copyFlags,
        });
        if (!isThisRewindActive()) return;

        if (rangeResult.success && rangeResult.content) {
          console.warn('[Restore:Rewind] Range copied, length:', rangeResult.content.length);
          emitHistoryRewindLog('start', undefined, 'Gemini Rewind: request to Gemini...');

          // Compact via Gemini API using rewind prompt
          const { getPromptById, rewindPromptId } = usePromptsStore.getState();
          const promptConfig = getPromptById(rewindPromptId);

          if (promptConfig) {
            // Load attached file contents
            let fileContentsBlock = '';
            const fpaths = promptConfig.filePaths || [];
            if (fpaths.length > 0) {
              const filesResult = await ipcRenderer.invoke('ai-prompts:read-files', fpaths);
              if (!isThisRewindActive()) return;
              if (filesResult.success && filesResult.data.length > 0) {
                fileContentsBlock = '\n\n' + filesResult.data.map((f: { path: string; content: string }) =>
                  `--- File: ${f.path} ---\n${f.content}`
                ).join('\n\n');
              }
            }
            const apiKey = process.env.GEMINI_API_KEY;
            const model = promptConfig.model;
            const promptPrefix = additionalPrompt
              ? `ПРИОРИТЕТНАЯ ИНСТРУКЦИЯ (выполнить в первую очередь):\n${additionalPrompt}\n\n---\nОСНОВНОЙ ПРОМПТ:\n`
              : '';
            const fullPrompt = promptPrefix + promptConfig.content + fileContentsBlock + rangeResult.content;

            const requestBody: any = {
              contents: [{ parts: [{ text: fullPrompt }] }],
              ...(model.includes('gemini-3') || model.includes('gemini-2.5') ? {
                tools: [{ googleSearch: {} }]
              } : {})
            };

            if (model.includes('gemini-3') && promptConfig.thinkingLevel !== 'NONE') {
              requestBody.generationConfig = {
                thinkingConfig: { thinkingLevel: promptConfig.thinkingLevel }
              };
            }

            try {
              console.warn('[Restore:Rewind] Sending to Gemini for compact, model:', model);
              const abortController = new AbortController();
              rewindGeminiAbortControllers.set(rewindOperationKey, abortController);
              const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(requestBody),
                  signal: abortController.signal,
                }
              );
              if (rewindGeminiAbortControllers.get(rewindOperationKey) === abortController) {
                rewindGeminiAbortControllers.delete(rewindOperationKey);
              }
              if (!isThisRewindActive()) return;

              const data = await response.json();
              if (!isThisRewindActive()) return;
              if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                compactText = data.candidates[0].content.parts[0].text;
                console.warn('[Restore:Rewind] Compact ready, length:', compactText.length);
                emitHistoryRewindLog('start', undefined, 'Gemini Rewind: response ready, opening native Rewind...');
              } else {
                console.error('[Restore:Rewind] Gemini returned empty/blocked response');
                compactError = response.status >= 400
                  ? `Gemini ${response.status}: ${data.error?.message || data.error?.status || 'error'}`
                  : 'Gemini returned empty response';
              }
            } catch (geminiErr) {
              rewindGeminiAbortControllers.delete(rewindOperationKey);
              if (!isThisRewindActive() || (geminiErr as any)?.name === 'AbortError') {
                return;
              }
              console.error('[Restore:Rewind] Gemini compact failed:', geminiErr);
              compactError = String((geminiErr as any)?.message || geminiErr);
            }
          } else {
            console.warn('[Restore:Rewind] No rewind prompt configured, skipping compact');
            compactError = 'No Rewind prompt configured';
          }
        } else {
          compactError = rangeResult?.error || 'Copy range failed';
        }
      } catch (rangeErr) {
        console.error('[Restore:Rewind] Copy range failed:', rangeErr);
        compactError = String((rangeErr as any)?.message || rangeErr);
      }

      if (!compactText.trim()) {
        if (!isThisRewindActive()) return;
        const error = compactError || 'Gemini Rewind produced empty text';
        emitHistoryRewindLog('failed', error);
        clearThisRewindState();
        useUIStore.getState().showToast('Gemini Rewind failed: ' + error, 'error', 4000);
        return;
      }
    }

    const ensureNonCodexAgentReadyForRewind = async () => {
      if (isGemini) return;
      if (toolType !== 'claude') return;
      const runtime = getHistoryAgentRuntime('claude');
      const describePresence = (presence: any) =>
        'status=' + (presence?.status || 'unknown') +
        ' inputReady=' + !!presence?.inputReady +
        ' hasTerm=' + !!presence?.hasTerm +
        ' busy=' + !!presence?.isBusy;
      const isBlockedStatus = (status?: AgentPtyStatus | null) => status === 'busy' || status === 'starting' || status === 'stopping';
      const blockedMessage = (status?: AgentPtyStatus | null) =>
        status === 'starting'
          ? runtime.label + ' is starting; wait until the current loader finishes before rewind'
          : status === 'stopping'
          ? runtime.label + ' is stopping; wait until the current loader finishes before rewind'
          : runtime.label + ' is busy; wait for the current turn before rewind';
      const waitStartupDefaultsIfNeeded = async () => {
        if (toolType !== 'claude') return;
        emitHistoryRewindLog('start', undefined, 'Claude Rewind: applying startup defaults...');
        await waitForClaudeStartupDefaultsReadyWithVisibleFallback(tabId, 15000, 'timeline-rewind');
        console.warn('[Restore:Rewind] Claude startup defaults gate passed');
      };

      let presence = await runtime.getPresence(tabId).catch((err: any) => {
        console.warn('[Restore:Rewind] Presence check failed before resume:', err?.message || err);
        return null;
      });
      console.warn('[Restore:Rewind] Presence before native rewind:', runtime.label, describePresence(presence));
      if (isBlockedStatus(presence?.status)) {
        throw new Error(blockedMessage(presence?.status));
      }
      if (presence?.status === 'active' && presence?.inputReady) {
        await waitStartupDefaultsIfNeeded();
        return;
      }

      const readyWait = createAgentReadyWait(runtime);
      try {
        const resumedForRewind = !presence || presence.status === 'inactive';
        if (!presence || presence.status === 'inactive') {
          emitHistoryRewindLog('start', undefined, runtime.label + ' Rewind: starting session...');
          const resumeResult = await runtime.resume({ tabId, sessionId, cwd });
          if (resumeResult?.success === false) {
            throw new Error(resumeResult.error || runtime.label + ' resume failed before rewind');
          }
          console.warn('[Restore:Rewind] Resume requested before native rewind:', runtime.label, JSON.stringify(resumeResult || {}));
        } else {
          emitHistoryRewindLog('start', undefined, runtime.label + ' Rewind: waiting for prompt...');
        }

        presence = await runtime.getPresence(tabId).catch(() => null);
        if (presence?.status === 'busy' || (presence?.status === 'starting' && !resumedForRewind)) {
          throw new Error(blockedMessage(presence?.status));
        }
        if (presence?.status === 'active' && presence?.inputReady) {
          readyWait.cancel();
          await waitStartupDefaultsIfNeeded();
          return;
        }

        await readyWait.promise;
        if (!isThisRewindActive()) throw new Error('rewind_cancelled');

        presence = await runtime.getPresence(tabId).catch(() => null);
        console.warn('[Restore:Rewind] Presence after resume wait:', runtime.label, describePresence(presence));
        if (isBlockedStatus(presence?.status)) {
          throw new Error(blockedMessage(presence?.status));
        }
        if (presence?.status !== 'active' || !presence?.inputReady) {
          throw new Error(runtime.label + ' session is not ready for rewind');
        }
        await waitStartupDefaultsIfNeeded();
      } catch (err) {
        readyWait.cancel();
        throw err;
      }
    };

    // Phase 2: Execute rewind in TUI + paste compact
    if (!isThisRewindActive()) return;
    if (!setThisRewindPhase('rewinding', 'Rewinding terminal history')) return;

    let codexWriterChanged = false;
    try {
      if (isCodex) {
        preparedCodex = await revalidatePreparedCodexRewindRuntime({
          tabId,
          prepared: preparedCodex!,
          cwd,
          targetIndex,
          sourceTargetUuid: entry.uuid,
          sourceEndUuid: mode === 'ai' ? sourceEndUuid : null,
          targetFullText: entry.content.trim(),
          rewindableCount: rewindableEntries.length,
        });
      } else {
        await ensureNonCodexAgentReadyForRewind();
      }
      if (!isThisRewindActive()) return;
      if (!useRewindOperationStore.getState().markRuntimeStarted(tabId, rewindOpId)) return;
      const rewindResult = await ipcRenderer.invoke(historyMenuChannel, {
        tabId,
        opId: rewindOpId,
        targetIndex,
        targetText: targetPrefix,
        targetMenuText: targetPrefix,
        targetFullText: entry.content.trim(),
        targetUuid: preparedCodex?.targetUuid || entry.uuid,
        writerSessionId: preparedCodex?.writerSessionId || null,
        writerAuthorization: preparedCodex?.writerAuthorization || null,
        writerLaunchId: preparedCodex?.writerLaunchId || null,
        rewindableCount: rewindableEntries.length,
        skipDuplicates,
        pasteAfter: compactText || undefined
      });
      if (rewindResult?.cancelled) {
        finishCancelled();
        return;
      }
      if (!isThisRewindActive()) return;
      console.warn('[Restore:Rewind] Rewind result:', rewindResult.success ? 'OK' : 'FAIL',
        'pressCount:', rewindResult.pressCount,
        'compactPasted:', !!compactText);
      if (!rewindResult.success) {
        const rewindFailureMessage = String(rewindResult.error || rewindResult.message || 'Rewind failed');
        console.error('[Restore:Rewind] Rewind failed:', rewindFailureMessage);
        emitHistoryRewindLog('failed', rewindFailureMessage);
        showRewindFailureFeedback(rewindFailureMessage);
        clearThisRewindState();
        return;
      }
      if (!setThisRewindPhase('committing', 'Rewind applied; saving the resulting session')) return;
      let completedSessionId: string | null | undefined;
      if (isCodex) {
        const currentSessionId = useWorkspaceStore.getState().getCodexSessionId(tabId);
        const committed = requireCommittedCodexRewind(rewindResult, currentSessionId);
        codexWriterChanged = committed.writerChanged;
        if (committed.writerChanged) {
          const adopted = await useWorkspaceStore.getState().setCodexSessionId(
            tabId,
            committed.activeSessionId,
            'detected',
          );
          if (!adopted) {
            throw new Error('Новая ветка Codex сохранена, но вкладка не смогла на неё переключиться');
          }
        }
        if (!isThisRewindActive()) return;
        completedSessionId = committed.activeSessionId;
      }

      if (!useRewindOperationStore.getState().complete(tabId, rewindOpId, completedSessionId)) return;

      // Auto-scroll to bottom after rewind
      const term = terminalRegistry.get(tabId);
      if (term) {
        let scrollDebounce: ReturnType<typeof setTimeout> | null = null;
        let cleaned = false;

        const doCleanup = () => {
          if (cleaned) return;
          cleaned = true;
          scrollSub.dispose();
          if (scrollDebounce) clearTimeout(scrollDebounce);
          term.scrollToBottom();
        };

        const scrollSub = term.onScroll(() => {
          if (cleaned) return;
          if (scrollDebounce) clearTimeout(scrollDebounce);
          scrollDebounce = setTimeout(doCleanup, 200);
        });

        setTimeout(doCleanup, 5000);
        term.scrollToBottom();
      }

      // Success flash
      if (isCodex && mode === 'native') {
        const targetDraft = typeof rewindResult.historyDraftText === 'string' && rewindResult.historyDraftText.trim()
          ? rewindResult.historyDraftText.trim()
          : entry.content.trim();
        if (targetDraft) setHistoryPromptDraft(tabId, targetDraft);
        if (rewindResult.historyDraftWarning) {
          useUIStore.getState().showToast(
            'Rewind выполнен: проверь картинку',
            'warning',
            7000,
            true,
            undefined,
            undefined,
            undefined,
            tabId,
            undefined,
            String(rewindResult.historyDraftWarning)
          );
        }
      }
      emitHistoryRewindLog(
        'done',
        undefined,
        mode === 'ai' ? 'Gemini Rewind: text inserted and submitted.' : undefined,
        {
          persisted: isCodex
            ? codexWriterChanged
            : mode === 'ai' || isGemini,
          historyInputDraft: mode === 'native' && rewindResult.historyInputDraft === true,
          historyDraftText: typeof rewindResult.historyDraftText === 'string' ? rewindResult.historyDraftText : undefined,
          historyDraftImages: Array.isArray(rewindResult.historyDraftImages) ? rewindResult.historyDraftImages : undefined,
          historyDraftWarning: typeof rewindResult.historyDraftWarning === 'string' ? rewindResult.historyDraftWarning : undefined,
          writerGeneration: typeof rewindResult.handoffGeneration === 'string'
            ? rewindResult.handoffGeneration
            : undefined,
        }
      );
      setTimeout(() => clearThisRewindState(), 1200);

    } catch (rewindErr) {
      if (!isThisRewindActive()) return;
      if ((rewindErr as any)?.message === 'rewind_cancelled') {
        finishCancelled();
        return;
      }
      const rewindErrorMessage = String((rewindErr as any)?.message || rewindErr);
      console.error('[Restore:Rewind] Rewind IPC failed:', rewindErr);
      if (isRewindBusyGuardMessage(rewindErrorMessage)) {
        emitHistoryAgentError(tabId, rewindErrorMessage);
      } else {
        emitHistoryRewindLog('failed', rewindErrorMessage);
      }
      showRewindFailureFeedback(rewindErrorMessage);
      clearThisRewindState();
    } finally {
      rewindGeminiAbortControllers.delete(rewindOperationKey);
    }
  };

  const getRewindRequestState = (entry: TimelineEntry) => {
    const hasTarget = !!getRewindTargetContext(entry);
    const starting = rewindAgentStatus === 'starting';
    const codexProofBlocked = isCodex && historyActionSnapshot?.canNativeRewind !== true;
    const runtimeBlocked = isTabAiBusy || isTurnBusy || lifecycleBlocksHistoryAction || codexProofBlocked;
    const canStart = !!sessionId && !rewindState && !runtimeBlocked && hasTarget && !readOnly;
    const reason = !sessionId
      ? 'Rewind недоступен: у вкладки ещё нет сохранённой сессии'
      : readOnly
        ? 'Rewind недоступен в режиме предпросмотра'
        : rewindState
          ? 'Rewind уже выполняется'
          : runtimeBlocked
            ? (historyActionSnapshot?.historyActionReason === 'runtime-identity-unknown'
              ? 'Проверяю текущую Codex-сессию'
              : 'Дождись завершения текущей отправки, загрузки или ответа перед Rewind')
            : !hasTarget
              ? 'Этот prompt находится за недоступной границей Rewind'
              : null;
    return { canStart, hasTarget, runtimeBlocked, reason };
  };

  const requestRewind = (
    entry: TimelineEntry,
    mode: RewindOperationMode = 'native',
    source: 'timeline-menu' | 'history-message' = 'timeline-menu',
  ) => {
    const availability = getRewindRequestState(entry);
    console.warn(
      '[Restore:Rewind] request source=' + source +
      ' mode=' + mode +
      ' canStart=' + availability.canStart +
      ' agentStatus=' + (rewindAgentStatus || 'unknown') +
      ' session=' + (sessionId ? sessionId.slice(0, 8) : 'none') +
      ' entry=' + entry.uuid.slice(0, 8),
    );
    if (!availability.canStart) {
      useUIStore.getState().showToast(
        availability.reason || 'Rewind недоступен',
        'warning',
        2600,
        false,
        undefined,
        undefined,
        undefined,
        tabId,
      );
      return false;
    }
    setContextMenu(null);
    void handleRewind(entry, mode);
    return true;
  };

  // Violet Rewind from a SINGLE point. Same operation as the selection Rewind —
  // history is rewritten and the removed span becomes one summary — so it must
  // run through the same code path and open the same review window. The only
  // difference is where the boundaries come from: one click means "from this
  // entry to the end of the conversation", which is exactly the span the old
  // `AI` button already consumed (it copied entry.uuid → last entry) before
  // pasting the summary blindly into the composer with no window at all.
  //
  // `openEmptyWindow` skips Gemini entirely: the window opens with empty text
  // for the user to write the summary themselves — the same third zone the
  // selection menu has.
  const requestHistoryRewrite = useCallback((
    entry: TimelineEntry,
    options?: { additionalPrompt?: string; openEmptyWindow?: boolean },
  ) => {
    if (rejectBlockedHistoryMutation(historyRewriteUiBlocked)) return false;
    if (!supportsEditRangeActions || !sessionId) return false;
    const startIndex = entries.findIndex((candidate) => candidate.uuid === entry.uuid);
    if (startIndex < 0 || entries.length === 0) return false;
    const endIndex = entries.length - 1;
    const range = { startIndex, endIndex };
    const startUuid = entry.uuid;
    const endUuid = entries[endIndex].uuid;
    console.warn('[Restore:Rewind] history-rewrite request source=timeline-menu'
      + ' scope=single-point'
      + ' empty=' + (options?.openEmptyWindow ? '1' : '0')
      + ' prompt=' + (options?.additionalPrompt ? options.additionalPrompt.length : 0)
      + ' range=[' + startIndex + ',' + endIndex + ']'
      + ' session=' + (sessionId ? sessionId.slice(0, 8) : 'none')
      + ' entry=' + entry.uuid.slice(0, 8));
    setContextMenu(null);
    if (options?.openEmptyWindow) {
      void openEditRangeWithoutSummary(range, startUuid, endUuid);
      return true;
    }
    void executeRangeAction('edit', range, startUuid, endUuid, options?.additionalPrompt);
    return true;
  }, [entries, historyRewriteUiBlocked, rejectBlockedHistoryMutation, sessionId, supportsEditRangeActions]);

  const requestRewindRef = useRef(requestRewind);
  requestRewindRef.current = requestRewind;
  useEffect(() => {
    const onHistoryRewindRequest = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        uuid?: string;
        mode?: RewindOperationMode;
      }>).detail;
      if (!detail || detail.tabId !== tabId || !detail.uuid || readOnly) return;
      const target = entries.find((entry) => entry.uuid === detail.uuid);
      if (!target) {
        useUIStore.getState().showToast(
          'Rewind недоступен: prompt не найден в текущей Timeline',
          'error',
          3000,
          false,
          undefined,
          undefined,
          undefined,
          tabId,
        );
        return;
      }
      requestRewindRef.current(target, detail.mode || 'native', 'history-message');
    };
    window.addEventListener('history-panel:request-rewind', onHistoryRewindRequest);
    return () => window.removeEventListener('history-panel:request-rewind', onHistoryRewindRequest);
  }, [entries, readOnly, tabId]);

  // ════════════════════════════════════════════════════════════
  // SECTION: NOTES UI — handleAddNote / handleSaveNote / moveNote / handleEditNote / handleDeleteNote + note strip hover; also handleCopySingleEntry
  // ════════════════════════════════════════════════════════════

  // Copy a single entry: prompt + all assistant responses up to next user/compact.
  // For compact entry — backend embeds compactSummary from the next isCompactSummary user.
  const handleCopySingleEntry = async (entry: TimelineEntry) => {
    if (!sessionId) return;
    setContextMenu(null);
    const channel = isCodex ? 'codex:copy-range' : isGemini ? 'gemini:copy-range' : 'claude:copy-range';
    try {
      const result = await ipcRenderer.invoke(channel, {
        sessionId,
        cwd,
        startUuid: entry.uuid,
        endUuid: entry.uuid,
        ...copyFlags,
      });
      if (result.success && result.content) {
        clipboard.writeText(result.content);
        useUIStore.getState().showToast('Скопировано', 'success', 1500);
      } else {
        useUIStore.getState().showToast(
          'Не удалось скопировать: ' + (result.error || 'unknown'),
          'error', 3000
        );
      }
    } catch (err: any) {
      console.error('[Timeline] Single copy failed:', err);
      useUIStore.getState().showToast('Ошибка копирования', 'error', 3000);
    }
  };

  // Claude has a narrower legacy action than range deletion: remove only the
  // human prompt while preserving the assistant response. Keep that capability
  // on the primary half of the single-entry delete control.
  const handleDeleteClaudeUserEntry = async (entry: TimelineEntry) => {
    if (!sessionId || isGemini || isCodex) return;
    if (rejectBlockedHistoryMutation(historyDeleteUiBlocked)) return;
    setContextMenu(null);
    setDeleteEntryConfirmMode(false);
    try {
      const result = await ipcRenderer.invoke('claude:delete-user-entry', {
        sessionId,
        cwd,
        uuid: entry.uuid,
      });
      if (!result.success) {
        useUIStore.getState().showToast(
          'Не удалось удалить: ' + (result.error || 'unknown'),
          'error', 4000
        );
        return;
      }
      useUIStore.getState().showToast('Запрос удалён, ответ Claude сохранён', 'success', 1800);
      loadTimeline('delete-user-entry');
    } catch (err: any) {
      console.error('[Timeline] Delete Claude user entry failed:', err);
      useUIStore.getState().showToast(
        'Ошибка удаления: ' + (err?.message || String(err)),
        'error', 4000
      );
    }
  };

  const handleRefreshTimelineAction = async (entry: TimelineEntry) => {
    if (!summaryToolType || !sessionId || getOrchestrationTag(entry) || !isEligibleTabTitleEntry(entry) || refreshingActionUuid) return;
    const eligibleEntries = entries.filter((candidate) => candidate.uuid && isEligibleTabTitleEntry(candidate));
    const targetIndex = eligibleEntries.findIndex((candidate) => candidate.uuid === entry.uuid);
    if (targetIndex < 0) return;
    if (isTabAiBusy && targetIndex === eligibleEntries.length - 1) {
      showToast('Ответ ещё не завершён', 'warning');
      return;
    }

    setContextMenu(null);
    setRefreshingActionUuid(entry.uuid);
    try {
      const channel = isCodex ? 'codex:copy-range' : 'claude:copy-range';
      const response = await ipcRenderer.invoke(channel, {
        sessionId,
        cwd,
        startUuid: entry.uuid,
        endUuid: entry.uuid,
        assistantOnly: true,
        maxChars: 8000,
      });
      if (!response?.success || !response.assistantText) {
        showToast(response?.error || 'Для этой итерации нет завершённого ответа', 'warning');
        return;
      }

      const previousUserMessages = eligibleEntries
        .slice(Math.max(0, targetIndex - Math.max(1, promptSummaryPreviousUserCount)), targetIndex)
        .map((candidate) => String(candidate.content || ''));
      const promptConfig = usePromptsStore.getState().getPromptById(TIMELINE_GROUPING_PROMPT_ID);
      const actionLabel = await generateTimelineActionLabelFromPrompt(
        String(entry.content || ''),
        String(response.assistantText),
        promptConfig,
        {
          previousUserMessages,
          usageMetadata: {
            tabId,
            toolType: summaryToolType,
            sessionId,
            entryUuid: entry.uuid,
            iterationIndex: targetIndex + 1,
          },
        }
      );
      if (!actionLabel) {
        showToast('Не удалось обновить действие', 'error');
        return;
      }

      const sourceHash = timelineSummarySourceHash(JSON.stringify({
        version: 1,
        content: String(entry.content || ''),
        previousUserMessages,
        promptId: promptConfig?.id || TIMELINE_GROUPING_PROMPT_ID,
        promptContent: promptConfig?.content || '',
        model: promptConfig?.model || 'gemini-3.1-flash-lite',
        thinkingLevel: promptConfig?.thinkingLevel || 'LOW',
      }));
      const saved = await saveTimelineActionOverride({
        toolType: summaryToolType,
        sessionId,
        entryUuid: entry.uuid,
        actionLabel,
        sourceHash,
        model: promptConfig?.model || 'gemini-3.1-flash-lite',
        promptId: promptConfig?.id || TIMELINE_GROUPING_PROMPT_ID,
        thinkingLevel: promptConfig?.thinkingLevel || 'LOW',
      });
      showToast(saved ? 'Действие обновлено' : 'Не удалось сохранить действие', saved ? 'success' : 'error');
    } catch (error: any) {
      console.error('[TimelineActionRefresh] failed:', error);
      showToast('Не удалось обновить действие', 'error');
    } finally {
      setRefreshingActionUuid(null);
    }
  };

  const handleAddNote = (entry: TimelineEntry) => {
    setContextMenu(null);
    setNoteEditText(notes[entry.uuid] || '');
    setNoteEditPosition(notePositions[entry.uuid] || 'before');
    setIsNoteEditing(true);
    const idx = entries.findIndex(e => e.uuid === entry.uuid);
    setActiveNoteIndex(idx);
    // Deactivate entry tooltip
    setActiveTooltipIndex(null);
    setTimeout(() => noteTextareaRef.current?.focus(), 50);
  };

  const handleEditNote = (entry: TimelineEntry) => {
    setNoteEditText(notes[entry.uuid] || '');
    setNoteEditPosition(notePositions[entry.uuid] || 'before');
    setIsNoteEditing(true);
    setTimeout(() => noteTextareaRef.current?.focus(), 50);
  };

  const handleSaveNote = async (entry: TimelineEntry) => {
    const text = noteEditText.trim();
    if (!text) {
      // Empty note = delete
      await handleDeleteNote(entry);
      return;
    }
    await ipcRenderer.invoke('timeline:save-note', {
      entryUuid: entry.uuid,
      sessionId,
      tabId,
      content: text,
      position: noteEditPosition,
    });
    setNotes(prev => ({ ...prev, [entry.uuid]: text }));
    setNotePositions(prev => ({ ...prev, [entry.uuid]: noteEditPosition }));
    setIsNoteEditing(false);
  };

  // Move note one visual position up or down on the timeline.
  // direction=-1 → move up (visually closer to top of timeline).
  // direction=+1 → move down. Flips before↔after / re-anchors to neighbour as needed.
  // Skips entries that already have a note (avoids overwriting via UNIQUE(entry_uuid, session_id)).
  const moveNote = async (entry: TimelineEntry, direction: -1 | 1) => {
    const text = (noteEditText.trim() || notes[entry.uuid] || '').trim();
    if (!text) return;
    const currentPos = notePositions[entry.uuid] || 'before';
    if (currentPos === 'dot') return; // dot notes don't move
    const currentIdx = entries.findIndex(e => e.uuid === entry.uuid);
    if (currentIdx < 0) return;

    // Compute next anchor + position
    let nextAnchorUuid: string | null = null;
    let nextPosition: 'before' | 'after' = currentPos;

    if (direction === -1) {
      // Moving up
      if (currentPos === 'after') {
        // "after X" → "before X" (visually flips above the dot)
        nextAnchorUuid = entry.uuid;
        nextPosition = 'before';
      } else {
        // "before X" → "after X-1", or X-2, ... (skip entries that already have a note)
        for (let i = currentIdx - 1; i >= 0; i--) {
          const cand = entries[i];
          if (cand.uuid === entry.uuid) continue;
          if (notes[cand.uuid]) continue;
          nextAnchorUuid = cand.uuid;
          nextPosition = 'after';
          break;
        }
      }
    } else {
      // Moving down
      if (currentPos === 'before') {
        nextAnchorUuid = entry.uuid;
        nextPosition = 'after';
      } else {
        for (let i = currentIdx + 1; i < entries.length; i++) {
          const cand = entries[i];
          if (cand.uuid === entry.uuid) continue;
          if (notes[cand.uuid]) continue;
          nextAnchorUuid = cand.uuid;
          nextPosition = 'before';
          break;
        }
      }
    }

    if (!nextAnchorUuid) return; // can't move further in this direction

    // If anchor doesn't change (just position flip on same entry), do a single save.
    // Otherwise: delete old, save under new anchor.
    if (nextAnchorUuid === entry.uuid) {
      await ipcRenderer.invoke('timeline:save-note', {
        entryUuid: entry.uuid, sessionId, tabId, content: text, position: nextPosition,
      });
      setNotePositions(prev => ({ ...prev, [entry.uuid]: nextPosition }));
      // Keep notes[uuid] in sync if user was actively editing
      if (noteEditText.trim()) setNotes(prev => ({ ...prev, [entry.uuid]: text }));
    } else {
      await ipcRenderer.invoke('timeline:delete-note', { entryUuid: entry.uuid, sessionId });
      await ipcRenderer.invoke('timeline:save-note', {
        entryUuid: nextAnchorUuid, sessionId, tabId, content: text, position: nextPosition,
      });
      setNotes(prev => {
        const next = { ...prev };
        delete next[entry.uuid];
        next[nextAnchorUuid!] = text;
        return next;
      });
      setNotePositions(prev => {
        const next = { ...prev };
        delete next[entry.uuid];
        next[nextAnchorUuid!] = nextPosition;
        return next;
      });
      // Update active index so tooltip follows the note to its new anchor
      const newIdx = entries.findIndex(e => e.uuid === nextAnchorUuid);
      if (newIdx >= 0) setActiveNoteIndex(newIdx);
    }
    // Stay in edit mode so user can continue moving without re-opening
    setNoteEditPosition(nextPosition);
  };

  const handleDeleteNote = async (entry: TimelineEntry) => {
    await ipcRenderer.invoke('timeline:delete-note', {
      entryUuid: entry.uuid,
      sessionId,
    });
    setNotes(prev => {
      const next = { ...prev };
      delete next[entry.uuid];
      return next;
    });
    setIsNoteEditing(false);
    setActiveNoteIndex(null);
  };

  const handleNoteStripEnter = (index: number) => {
    setHoveredNoteIndex(index);
    if (isCmdHeldRef.current && !isNoteEditing) {
      setActiveNoteIndex(index);
      setActiveTooltipIndex(null); // hide entry tooltip
    }
  };

  const handleNoteStripLeave = (e: React.MouseEvent) => {
    setHoveredNoteIndex(null);
    if (isNoteEditing) return;

    // Direct DOM check: if we moved into the note tooltip wrapper, keep open
    if (noteTooltipRef.current && e.relatedTarget instanceof Node && noteTooltipRef.current.contains(e.relatedTarget)) {
      return;
    }

    const segmentRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    const wentLeft = mouseX <= segmentRect.left + 5;

    if (wentLeft) {
      // Check if mouse Y is within note tooltip wrapper bounds
      if (noteTooltipRef.current) {
        const wrapperRect = noteTooltipRef.current.getBoundingClientRect();
        if (mouseY < wrapperRect.top || mouseY > wrapperRect.bottom) {
          setActiveNoteIndex(null);
        }
        // else: mouse heading toward tooltip — keep open
      }
    } else {
      setActiveNoteIndex(null);
    }
  };

  const handleMouseLeaveNoteTooltip = () => {
    if (!isNoteEditing) {
      setActiveNoteIndex(null);
    }
  };

  // Stable bridge for the memoized segment rows: one object identity for the
  // component's lifetime, fields refreshed to this render's closures. Rows
  // receive `api` as a never-changing prop and dispatch through it at event
  // time — memo stays effective, events stay fresh.
  const rowApiRef = useRef<TimelineRowApi | null>(null);
  if (!rowApiRef.current) {
    rowApiRef.current = {} as TimelineRowApi;
  }
  const rowApi = rowApiRef.current;
  rowApi.handleMouseEnterSegment = handleMouseEnterSegment;
  rowApi.handleMouseLeaveSegment = handleMouseLeaveSegment;
  rowApi.handleEntryClick = handleEntryClick;
  rowApi.handleEntryDoubleClick = handleEntryDoubleClick;
  rowApi.handleRightClick = handleRightClick;
  rowApi.handleNoteStripEnter = handleNoteStripEnter;
  rowApi.handleNoteStripLeave = handleNoteStripLeave;
  rowApi.flashStripFailed = flashStripFailed;
  rowApi.expandGroup = (groupId, groupKind) => {
    if (groupKind === 'orchestration' && !isExpandedLayout) {
      setTimelineTreeMode(tabId, true);
    }
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.add(groupId);
      return next;
    });
  };
  rowApi.collapseGroup = (groupId) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.delete(groupId);
      return next;
    });
  };
  rowApi.setSegmentRef = (index, el) => { segmentRefs.current[index] = el; };
  rowApi.onForkMarkerEnter = (index) => {
    setHoveredForkMarkerIndex(index);
    if (isCmdHeldRef.current) {
      setActiveForkMarkerIndex(index);
      setActiveTooltipIndex(null);
    }
  };
  rowApi.onForkMarkerLeave = (e, index) => {
    setHoveredForkMarkerIndex(null);
    if (activeForkMarkerIndex !== index) return;
    // Same pattern as notes: check if mouse went left toward tooltip
    if (forkTooltipRef.current && e.relatedTarget instanceof Node && forkTooltipRef.current.contains(e.relatedTarget)) {
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    const wentLeft = mouseX <= rect.left + 5;
    if (wentLeft && forkTooltipRef.current) {
      const wrapperRect = forkTooltipRef.current.getBoundingClientRect();
      if (mouseY < wrapperRect.top || mouseY > wrapperRect.bottom) {
        setActiveForkMarkerIndex(null);
      }
    } else if (!wentLeft) {
      setActiveForkMarkerIndex(null);
    }
  };

  if (!sessionId) return null;

  // ════════════════════════════════════════════════════════════
  // SECTION: RENDER GEOMETRY — derive current tooltip/note/fork-tooltip positions from segmentRefs before JSX
  // ════════════════════════════════════════════════════════════

  const currentActiveEntry = activeTooltipIndex !== null ? entries[activeTooltipIndex] : null;
  const currentActiveEntryIndex = activeTooltipIndex ?? -1;
  const currentActiveEntryIsCompactSummary = !!currentActiveEntry?.isCompactSummary;
  const currentActiveEntryDisplaysAsCompact = !!currentActiveEntry
    && (currentActiveEntry.type === 'compact' || currentActiveEntryIsCompactSummary);
  const currentActiveCompactBoundaryEntry = currentActiveEntryIsCompactSummary
    && currentActiveEntryIndex > 0
    && entries[currentActiveEntryIndex - 1]?.type === 'compact'
    ? entries[currentActiveEntryIndex - 1]
    : currentActiveEntry;
  const currentActiveGroupInfo = activeTooltipIndex !== null
    ? groupMap.get(activeTooltipIndex)
    : undefined;
  const currentActiveGroupExpanded = !!(
    currentActiveGroupInfo?.groupId
    && isTimelineGroupExpanded(isExpandedLayout, expandedGroups.has(currentActiveGroupInfo.groupId))
  );
  const currentActivePresentationEntries = currentActiveEntry
    ? currentActiveGroupInfo?.isGroupHeader && !currentActiveGroupExpanded
      ? entries.slice(
          currentActiveGroupInfo.startIndex,
          currentActiveGroupInfo.startIndex + currentActiveGroupInfo.groupSize,
        )
      : [currentActiveEntry]
    : [];
  const currentActiveDocs = collectTimelineDocs(currentActivePresentationEntries);
  const currentActiveDocsKey = currentActiveGroupInfo?.isGroupHeader && !currentActiveGroupExpanded
    ? `timeline-group:${currentActiveGroupInfo.groupId}`
    : currentActiveEntry?.uuid || 'timeline-entry';

  const renderAttachedDocsActivity = (files: string[], queries: string[], expansionKey: string) => (
    <>
      {files.length > 0 && (() => {
        const open = expandedDocsEdit.has(expansionKey);
        return (
          <div className={`pb-1.5 mb-1.5 border-b ${DOCS_TIMELINE_COLORS.edited.borderClass} shrink-0`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpandedDocsEdit(prev => {
                  const next = new Set(prev);
                  if (next.has(expansionKey)) next.delete(expansionKey); else next.add(expansionKey);
                  return next;
                });
              }}
              className={`w-full text-left flex items-center gap-1.5 ${DOCS_TIMELINE_COLORS.edited.hoverClass} rounded px-0.5 py-0.5 cursor-pointer`}
              style={{ color: DOCS_TIMELINE_COLORS.edited.tooltip }}
            >
              <Pencil size={10} className="shrink-0" style={{ color: DOCS_TIMELINE_COLORS.edited.visible }} />
              <span className="leading-snug font-mono text-[10px] flex-1 font-medium">
                Docs updated ({files.length})
              </span>
            </button>
            {open && (
              <div className="mt-1 ml-4 leading-snug font-mono text-[10px]" style={{ color: DOCS_TIMELINE_COLORS.edited.tooltipMuted }}>
                {files.map((file, index) => (
                  <div key={`${file}:${index}`} className="break-all" style={{ opacity: 0.85 }}>{file}</div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
      {queries.length > 0 && (() => {
        const open = expandedDocsSearch.has(expansionKey);
        return (
          <div className={`pb-1.5 mb-1.5 border-b ${DOCS_TIMELINE_COLORS.search.borderClass} shrink-0`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpandedDocsSearch(prev => {
                  const next = new Set(prev);
                  if (next.has(expansionKey)) next.delete(expansionKey); else next.add(expansionKey);
                  return next;
                });
              }}
              className={`w-full text-left flex items-start gap-1.5 ${DOCS_TIMELINE_COLORS.search.hoverClass} rounded px-0.5 py-0.5 cursor-pointer`}
              style={{ color: DOCS_TIMELINE_COLORS.search.tooltip }}
            >
              <Search size={10} className="shrink-0 mt-0.5" style={{ color: DOCS_TIMELINE_COLORS.search.visible }} />
              <span className="leading-snug font-mono text-[10px] flex-1 font-medium">
                Docs search ({queries.length})
              </span>
            </button>
            {open && (
              <div className="mt-1 ml-4 leading-snug font-mono text-[10px]" style={{ color: DOCS_TIMELINE_COLORS.search.tooltipMuted }}>
                {queries.map((query, index) => (
                  <div key={`${query}:${index}`} className="break-words" style={{ opacity: 0.85 }}>«{query}»</div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
    </>
  );

  const getCodexUsageTotal = (entry: TimelineEntry): number | null => {
    const u = entry.codexUsage;
    if (!u) return null;
    return Math.max(0, u.inputUncached)
      + Math.max(0, u.inputCached)
      + Math.max(0, u.outputAnswer)
      + Math.max(0, u.outputReasoning);
  };

  const hasCodexBreakdown = (entry: TimelineEntry): boolean => {
    return isCodex && !!(entry.codexUsage || entry.codexLimits);
  };

  const canShowSingleEntryBreakdown = (entry: TimelineEntry): boolean => {
    return supportsClaudeTimelineActions || hasCodexBreakdown(entry);
  };

  const singleEntryTokenCount = (entry: TimelineEntry): number => {
    if (isCodex) {
      const codexTotal = getCodexUsageTotal(entry);
      if (codexTotal !== null) return codexTotal;
    }
    if (singleTokenEstimate && singleTokenUuid === entry.uuid) {
      return singleTokenEstimate.total;
    }
    return Math.ceil(entry.content.length / 3.5);
  };

  const formatCodexReset = (iso: string | null): string => {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const ms = t - Date.now();
    if (ms <= 0) return 'now';
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  };

  const renderSingleTokenChip = (entry: TimelineEntry) => {
    const interactive = canShowSingleEntryBreakdown(entry);
    return (
      <span
        className="flex items-center gap-1 ml-2 text-[10px]"
        onMouseEnter={(e) => {
          if (!interactive) return;
          setSingleChipEl(e.currentTarget);
          setSingleTokenUuid(entry.uuid);
          setSingleBreakdownOpen(true);
        }}
        style={{
          color: '#e8a955',
          cursor: interactive ? 'help' : 'default',
          textDecoration: interactive ? 'underline dotted rgba(232,169,85,0.4)' : 'none',
          textUnderlineOffset: '2px',
        }}
      >
        <Zap size={10} />
        <span>{formatTokenCount(singleEntryTokenCount(entry))}</span>
      </span>
    );
  };

  // Codex usage stays out of the main entry tooltip: it is secondary detail behind
  // the small token chip, matching Claude's JSONL/API breakdown popover.
  const renderCodexBreakdownBody = (entry: TimelineEntry) => {
    const u = entry.codexUsage;
    const lim = entry.codexLimits;
    const inputTotal = u ? u.inputUncached + u.inputCached : 0;
    const total = getCodexUsageTotal(entry);
    const TabBtn = ({ mode, children }: { mode: 'jsonl' | 'api'; children: React.ReactNode }) => (
      <button
        onClick={(e) => { e.stopPropagation(); setBreakdownMode(mode); }}
        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors cursor-pointer"
        style={{
          color: breakdownMode === mode ? '#e8a955' : 'rgba(255,255,255,0.4)',
          backgroundColor: breakdownMode === mode ? 'rgba(232,169,85,0.08)' : 'transparent',
        }}
      >{children}</button>
    );
    const Row = ({ label, value, dim }: { label: string; value: string; dim?: boolean }) => (
      <div className="flex items-center justify-between text-[11px]">
        <span style={{ color: dim ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.6)' }}>{label}</span>
        <span className="font-mono" style={{ color: dim ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.8)' }}>{value}</span>
      </div>
    );
    const limitRows = lim && (lim.fiveHourPct != null || lim.weeklyPct != null) ? (
      <div className="mt-1.5 pt-1 border-t border-white/10 flex flex-col gap-0.5">
        {lim.fiveHourPct != null && (
          <Row
            label="5-hour limit"
            value={`${Math.round(lim.fiveHourPct)}%${lim.fiveHourResetsAt ? ` · ${formatCodexReset(lim.fiveHourResetsAt)}` : ''}`}
            dim
          />
        )}
        {lim.weeklyPct != null && (
          <Row
            label="Weekly limit"
            value={`${Math.round(lim.weeklyPct)}%${lim.weeklyResetsAt ? ` · ${formatCodexReset(lim.weeklyResetsAt)}` : ''}`}
            dim
          />
        )}
      </div>
    ) : null;

    return (
      <>
        <div className="flex items-center gap-0.5 mb-1.5">
          <TabBtn mode="jsonl">JSONL</TabBtn>
          <TabBtn mode="api">API</TabBtn>
        </div>
        {u ? (
          breakdownMode === 'jsonl' ? (
            <>
              <div className="flex flex-col gap-0.5">
                <Row label="Input" value={formatTokenCount(inputTotal)} />
                {u.inputCached > 0 && <Row label="↳ cached" value={formatTokenCount(u.inputCached)} dim />}
                <Row label="Codex · answer" value={formatTokenCount(u.outputAnswer)} />
                {u.outputReasoning > 0 && <Row label="Codex · reasoning" value={formatTokenCount(u.outputReasoning)} dim />}
              </div>
              <div className="mt-1.5 pt-1 border-t border-white/10 flex items-center justify-between text-[11px]">
                <span className="text-white/50">В JSONL</span>
                <span className="font-mono font-semibold" style={{ color: '#e8a955' }}>{formatTokenCount(total || 0)}</span>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-0.5">
              <Row label="Input billed" value={formatTokenCount(u.inputUncached)} />
              {u.inputCached > 0 && <Row label="↳ cached" value={formatTokenCount(u.inputCached)} dim />}
              <Row label="Input (total)" value={formatTokenCount(inputTotal)} dim />
              <Row label="Output" value={formatTokenCount(u.outputAnswer)} />
              {u.outputReasoning > 0 && <Row label="↳ reasoning" value={formatTokenCount(u.outputReasoning)} dim />}
            </div>
          )
        ) : (
          <div className="text-[11px] text-white/40">No token usage sample</div>
        )}
        {limitRows}
      </>
    );
  };

  // Shared body renderer for the JSONL/API breakdown popovers. Same shape in both range
  // and single-entry mode — only the estimate object varies. Top row is a JSONL/API
  // toggle; below it either the per-category JSONL weights or the two API numbers.
  const renderBreakdownBody = (
    est: TokenBreakdown,
    rows: Array<{ key: string; label: string; value: number }>,
  ) => {
    const TabBtn = ({ mode, children }: { mode: 'jsonl' | 'api'; children: React.ReactNode }) => (
      <button
        onClick={(e) => { e.stopPropagation(); setBreakdownMode(mode); }}
        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors cursor-pointer"
        style={{
          color: breakdownMode === mode ? '#e8a955' : 'rgba(255,255,255,0.4)',
          backgroundColor: breakdownMode === mode ? 'rgba(232,169,85,0.08)' : 'transparent',
        }}
      >{children}</button>
    );
    return (
      <>
        <div className="flex items-center gap-0.5 mb-1.5">
          <TabBtn mode="jsonl">JSONL</TabBtn>
          <TabBtn mode="api">API</TabBtn>
        </div>
        {breakdownMode === 'jsonl' ? (
          <>
            {rows.length === 0 ? (
              <div className="text-[11px] text-white/40">Нет данных</div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {rows.map(row => (
                  <div key={row.key} className="flex items-center justify-between text-[11px]">
                    <span className="text-white/60">{row.label}</span>
                    <span className="font-mono text-white/80">{formatTokenCount(row.value)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-1.5 pt-1 border-t border-white/10 flex items-center justify-between text-[11px]">
              <span className="text-white/50">В JSONL</span>
              <span className="font-mono font-semibold" style={{ color: '#e8a955' }}>{formatTokenCount(est.total)}</span>
            </div>
          </>
        ) : (
          // API-mode: разделяем input на три статьи. Cache touches только
          // input (Claude никогда не кэширует output), поэтому Output остаётся
          // одной строкой. Sum (Uncached + Cache create + Cache read) =
          // apiInputTokens — это и есть «полный prompt size как если бы
          // кэша не было». Юзеру в одну строку, какая часть была billed как
          // свежий промпт, какая попала под cache_creation (1.25×), какая —
          // под cache_read (0.1×).
          (() => {
            const uncached = est.apiInputUncached ?? 0;
            const cacheCreate = est.apiInputCacheCreate ?? 0;
            const cacheRead = est.apiInputCacheRead ?? 0;
            const cachedTotal = cacheCreate + cacheRead;
            const hasCacheData = uncached + cachedTotal > 0;
            // Fallback: если backend не вернул разбивку (старый main) —
            // показываем одну строку как раньше.
            if (!hasCacheData && est.apiInputTokens > 0) {
              return (
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-white/60">Input</span>
                    <span className="font-mono text-white/80">{formatTokenCount(est.apiInputTokens)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-white/60">Output</span>
                    <span className="font-mono text-white/80">{formatTokenCount(est.apiOutputTokens)}</span>
                  </div>
                </div>
              );
            }
            return (
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-white/60" title="usage.input_tokens — свежий промпт, полная цена">Input billed</span>
                  <span className="font-mono text-white/80">{formatTokenCount(uncached)}</span>
                </div>
                <div
                  className="flex items-center justify-between text-[11px]"
                  title="cache_creation_input_tokens (1.25×) + cache_read_input_tokens (0.1×)"
                >
                  <span className="text-white/40">↳ cached</span>
                  <span className="font-mono text-white/60">{formatTokenCount(cachedTotal)}</span>
                </div>
                <div className="flex items-center justify-between text-[11px] mt-0.5 pt-0.5 border-t border-white/5">
                  <span className="text-white/50">Input (total)</span>
                  <span className="font-mono text-white/80">{formatTokenCount(uncached + cachedTotal)}</span>
                </div>
                <div className="flex items-center justify-between text-[11px] mt-1">
                  <span className="text-white/60">Output</span>
                  <span className="font-mono text-white/80">{formatTokenCount(est.apiOutputTokens)}</span>
                </div>
              </div>
            );
          })()
        )}
      </>
    );
  };

  // Compute tooltip wrapper position — uses measured height for precision
  const tooltipPos = activeTooltipIndex !== null ? (() => {
    const eCenterY = getElementCenterY(activeTooltipIndex);
    const approxH = isExpanded ? 400 : 200;
    // Expanded: use fixed 60vh (matches maxHeight) — avoids measurement-based jumps during resize
    // Collapsed: use measured height for precise positioning
    const h = isExpanded
      ? Math.round(window.innerHeight * 0.6)
      : (tooltipMeasuredH > 0 ? tooltipMeasuredH : approxH);

    // Determine alignment based on estimate (stable — doesn't flicker with measurement)
    const idealTop = eCenterY - approxH / 2;
    let vAlign: 'flex-start' | 'center' | 'flex-end' = 'center';
    if (idealTop < 40) {
      vAlign = 'flex-start';
    } else if (idealTop + approxH > window.innerHeight - 10) {
      vAlign = 'flex-end';
    }

    // Calculate position based on actual measured height
    let clampedTop: number;
    if (vAlign === 'flex-start') {
      clampedTop = 40;
    } else if (vAlign === 'flex-end') {
      clampedTop = Math.max(40, window.innerHeight - h - 10);
    } else {
      clampedTop = eCenterY - h / 2;
    }

    // Wrapper spans from tooltip to entry (bridge fills the gap)
    const wTop = Math.min(clampedTop, eCenterY - 20);
    const wBottom = Math.min(
      Math.max(clampedTop + h, eCenterY + 20),
      window.innerHeight // never extend below viewport
    );
    return { clampedTop, wTop, wH: wBottom - wTop, offset: clampedTop - wTop, vAlign };
  })() : null;

  // Note tooltip position (same logic, simpler — smaller tooltip)
  const activeNoteEntry = activeNoteIndex !== null ? entries[activeNoteIndex] : null;
  // Fork marker tooltip position (same pattern as notes)
  const activeForkMarker = activeForkMarkerIndex !== null ? forkMarkers.find(m => {
    if (m.hidden) return false; // hidden markers don't show tooltip
    const snapshot = normalizeForkMarkerEntryUuids(m.entry_uuids);
    if (snapshot.length === 0) return false;
    const snap = new Set(snapshot);
    const e = entries[activeForkMarkerIndex];
    if (!e || !snap.has(e.uuid)) return false;
    const next = entries[activeForkMarkerIndex + 1];
    return activeForkMarkerIndex === entries.length - 1 || (next && !snap.has(next.uuid));
  }) : null;

  const forkTooltipPos = activeForkMarkerIndex !== null ? (() => {
    // Position at the fork STRIP level (between entry N and entry N+1), not at entry N's dot
    const el = segmentRefs.current[activeForkMarkerIndex];
    const nextEl = segmentRefs.current[activeForkMarkerIndex + 1];
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    let eCenterY: number;
    if (nextEl) {
      const nextRect = nextEl.getBoundingClientRect();
      eCenterY = (rect.bottom + nextRect.top) / 2; // midpoint = strip center
    } else {
      eCenterY = rect.bottom + 10; // last entry — strip is below
    }
    const h = 60;
    let clampedTop = Math.max(40, Math.min(eCenterY - h / 2, window.innerHeight - h - 10));
    const wTop = Math.min(clampedTop, eCenterY - 20);
    const wBottom = Math.min(Math.max(clampedTop + h, eCenterY + 20), window.innerHeight);
    return { clampedTop, wTop, wH: wBottom - wTop, offset: clampedTop - wTop };
  })() : null;

  const noteTooltipPos = activeNoteIndex !== null ? (() => {
    const eCenterY = getElementCenterY(activeNoteIndex);
    const h = isNoteEditing ? 230 : 120;
    let clampedTop = Math.max(40, Math.min(eCenterY - h / 2, window.innerHeight - h - 10));
    const wTop = Math.min(clampedTop, eCenterY - 20);
    const wBottom = Math.min(Math.max(clampedTop + h, eCenterY + 20), window.innerHeight);
    return { clampedTop, wTop, wH: wBottom - wTop, offset: clampedTop - wTop };
  })() : null;

  const activeSemanticGroup = activeSemanticGroupId
    ? semanticGroups.find((group) => group.id === activeSemanticGroupId) || null
    : null;
  const semanticGroupTooltipPos = activeSemanticGroup ? (() => {
    const element = semanticGroupHeaderRefs.current.get(activeSemanticGroup.id);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const height = 72;
    return {
      top: Math.max(40, Math.min(rect.top + rect.height / 2 - height / 2, window.innerHeight - height - 10)),
    };
  })() : null;

  const renderSemanticGroupHeader = (group: TimelineSemanticGroup, expanded: boolean) => (
    <div
      key={`semantic-header:${group.id}`}
      ref={(element) => {
        if (element) semanticGroupHeaderRefs.current.set(group.id, element);
        else semanticGroupHeaderRefs.current.delete(group.id);
      }}
      className="relative w-full flex items-center select-none"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 6,
        flex: '0 0 auto',
        minHeight: 30,
        padding: '5px 6px 5px 2px',
        gap: 4,
        alignItems: 'flex-start',
        cursor: 'pointer',
        borderTop: '1px solid rgba(192,132,252,0.18)',
        borderBottom: '1px solid rgba(192,132,252,0.12)',
        background: hoveredSemanticGroupId === group.id
          ? 'linear-gradient(90deg, rgba(217,70,239,0.18), rgba(139,92,246,0.11)), #18131d'
          : 'linear-gradient(90deg, rgba(217,70,239,0.11), rgba(139,92,246,0.07)), #18131d',
      }}
      title={isCmdHeld ? undefined : '⌘ + hover — описание группы'}
      onClick={(event) => {
        event.stopPropagation();
        setExpandedSemanticGroups((previous) => {
          const next = new Set(previous);
          if (next.has(group.id)) next.delete(group.id);
          else next.add(group.id);
          return next;
        });
      }}
      onMouseEnter={() => {
        setHoveredSemanticGroupId(group.id);
        if (isCmdHeldRef.current) {
          setActiveSemanticGroupId(group.id);
          setActiveTooltipIndex(null);
        }
      }}
      onMouseLeave={() => {
        setHoveredSemanticGroupId(null);
        if (!isCmdHeldRef.current && !isLockedTooltipRef.current) setActiveSemanticGroupId(null);
      }}
    >
      <ChevronDown
        size={12}
        style={{
          color: '#d8b4fe',
          flexShrink: 0,
          marginTop: 1,
          transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          transition: 'transform 120ms ease-out',
        }}
      />
      <span
        className="min-w-0 flex-1"
        style={{
          color: '#f5d0fe',
          fontSize: 11,
          fontWeight: 700,
          lineHeight: 1.25,
          overflow: 'visible',
          whiteSpace: 'normal',
          overflowWrap: 'anywhere',
        }}
      >
        {group.title}
      </span>
      <span style={{ color: 'rgba(216,180,254,0.7)', fontSize: 9, fontFamily: 'monospace', flexShrink: 0, marginTop: 2 }}>
        {group.memberUuids.length}
      </span>
    </div>
  );

  const contextMenuTop = contextMenu ? (() => {
    const estimatedH = selectionStartId ? 44 : 260;
    const h = contextMenuMeasuredH > 0 ? contextMenuMeasuredH : estimatedH;
    const index = entries.findIndex(e => e.uuid === contextMenu.entry.uuid);
    return getEntryAnchoredPopupTop(index, h, estimatedH, contextMenu.anchorY ?? contextMenu.y + estimatedH / 2);
  })() : 0;

  // ════════════════════════════════════════════════════════════
  // SECTION: JSX RENDER — Timeline container, scroll layer, segment loop, overlays, portals
  // ════════════════════════════════════════════════════════════

  return (
    <>
      {/* ──── OUTER SLOT — unpinned expanded mode reserves only the 32px rail and
            overlays left; pinned mode reserves the full expanded width. ──── */}
      <div
        onTransitionEnd={handlePinnedSlotTransitionEnd}
        style={{
          width: slideIn ? (pinned ? `${effectiveWidth}px` : '32px') : '0px',
          height: '100%',
          flexShrink: 0,
          position: 'relative',
          transition: widthTransitionEnabled ? 'width 50ms ease-out' : 'none',
        }}
      >
      {/* ──── CONTAINER (Timeline outer wrapper, absolute-anchored right) ──── */}
      <div
        ref={containerRef}
        data-timeline
        className="relative flex flex-col group"
        style={{
          width: slideIn ? `${effectiveWidth}px` : '0px',
          backgroundColor: '#1a1a1a',
          backdropFilter: 'blur(8px)',
          borderLeft: 'none',
          height: '100%',
          // History and Timeline can now be open at the same time (they no
          // longer close each other). Both overlay from the right edge when
          // unpinned, so the expanded rail must sit ABOVE the History overlay
          // (z-index 101) instead of being half-covered by it. Pinned mode is
          // normal flex layout and keeps the ordinary level.
          zIndex: isExpandedLayout && !pinned ? 110 : 40,
          visibility: isVisible ? 'inherit' : 'hidden',
          overflow: slideIn ? 'visible' : 'hidden',
          // Expanded layout overlays content from the right unless StatusBar pin
          // asks Timeline to participate in normal flex layout.
          position: isExpandedLayout && !pinned ? 'absolute' : 'static',
          top: isExpandedLayout && !pinned ? 0 : undefined,
          right: isExpandedLayout && !pinned ? 0 : undefined,
          // Font-size root for em-based descendants (chip + preview text).
          fontSize: `${timelineFontSize}px`,
          transition: widthTransitionEnabled ? 'width 50ms ease-out' : 'none',
        }}
      >
        {/* Drag handle for width — only when expanded layout is on.
            In collapsed (32px) mode no resize gesture, it'd just confuse.
            Width persists in localStorage via setTimelineWidth (clamped [32, 600]). */}
        {slideIn && isExpandedLayout && (
          <div
            data-timeline-resize-handle
            onPointerDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startW = timelineWidth;
              const pointerId = e.pointerId;
              (e.currentTarget as HTMLElement).setPointerCapture(pointerId);
              const prevCursor = document.body.style.cursor;
              const prevSelect = document.body.style.userSelect;
              document.body.style.cursor = 'ew-resize';
              document.body.style.userSelect = 'none';
              // rAF-coalesced: pointermove fires 60-120/s and every store
              // write re-renders the whole expanded timeline (hundreds of
              // rows reflow). One write per frame is all a human can see.
              let dragRaf = 0;
              let pendingWidth = startW;
              const onMove = (ev: PointerEvent) => {
                pendingWidth = startW + (startX - ev.clientX); // dragging left grows width
                if (dragRaf) return;
                dragRaf = requestAnimationFrame(() => {
                  dragRaf = 0;
                  setTimelineWidth(pendingWidth);
                });
              };
              const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                if (dragRaf) cancelAnimationFrame(dragRaf);
                setTimelineWidth(pendingWidth);
                document.body.style.cursor = prevCursor;
                document.body.style.userSelect = prevSelect;
              };
              window.addEventListener('pointermove', onMove);
              window.addEventListener('pointerup', onUp);
            }}
            style={{
              position: 'absolute',
              left: '-2px',
              top: 0,
              bottom: 0,
              width: '6px',
              cursor: 'ew-resize',
              zIndex: 45,
              // Subtle hover hint — slight bg on hover so user discovers the handle.
              background: 'transparent',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(129, 140, 248, 0.15)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          />
        )}
        {/* Central Axis Line (compact mode only) */}
        {!treeMode && (
          <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-white/10 -translate-x-1/2 pointer-events-none" />
        )}

        {/* Tree mode toggle removed — now controlled from InfoPanel sidebar */}

        {/* ──── SCROLL LAYER (scrollRef — vertical scroll) ──── */}
        <div
          ref={scrollRef}
          className="scrollbar-hide"
          style={{
            position: 'absolute' as const,
            top: 0,
            bottom: 0,
            right: 0,
            width: '100%',
            opacity: isVisible ? 1 : 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* ──── INNER-RELATIVE WRAPPER (innerWrapperRef — hosts segments + scroll-following overlays) ──── */}
          {/* Inner relative wrapper so absolute overlays (selection, rewind) scroll with content */}
          <div ref={innerWrapperRef} className="relative flex flex-col flex-1">
          {/* Plan mode marker at the very beginning (first entry is from a child session — chain started before visible entries) */}
          {entries.length > 0 && entries[0].sessionId && sessionBoundaries.length > 0 &&
            sessionBoundaries.some(b => b.childSessionId === entries[0].sessionId) &&
            !forkMarkers.some(m => !m.entry_uuids || m.entry_uuids.length === 0) && (  /* any fork marker (even hidden) suppresses this */
            <Tooltip content="Plan mode - context was cleared here">
            <div
              className="flex-shrink-0 w-full flex items-center justify-center"
              style={{ height: '8px' }}
            >
              <div
                style={{
                  width: visibleEntryIndices.has(0) ? '10px' : '12px',
                  height: visibleEntryIndices.has(0) ? '3px' : '2px',
                  borderRadius: '1px',
                  backgroundColor: visibleEntryIndices.has(0) ? '#5eada3' : '#48968c',
                  boxShadow: visibleEntryIndices.has(0) ? '0 0 6px rgba(72, 150, 140, 0.25)' : 'none',
                  transition: 'background-color 0.2s, box-shadow 0.2s',
                }}
              />
            </div>
            </Tooltip>
          )}
          {/* Fork marker at the very beginning (empty snapshot = fork before any entries) */}
          {forkMarkers.some(m => !m.hidden && (!m.entry_uuids || m.entry_uuids.length === 0)) && entries.length > 0 && (
            <Tooltip content="Fork point - this session was forked from here">
            <div
              className="flex-shrink-0 w-full flex items-center justify-center"
              style={{ height: '8px' }}
            >
              <div
                style={{
                  width: visibleEntryIndices.has(0) ? '10px' : '12px',
                  height: visibleEntryIndices.has(0) ? '3px' : '2px',
                  borderRadius: '1px',
                  backgroundColor: visibleEntryIndices.has(0) ? '#60a5fa' : '#3b82f6',
                  boxShadow: visibleEntryIndices.has(0) ? '0 0 6px rgba(59, 130, 246, 0.25)' : 'none',
                  transition: 'background-color 0.2s, box-shadow 0.2s',
                }}
              />
            </div>
            </Tooltip>
          )}
          {/* ──── SEGMENT LOOP (entries.map → per-entry dot, note strips, fork stripes, plan-mode boundaries) ──── */}
          {entries.map((entry, index) => {
            // Progressive expand: while the budget has not yet covered this
            // row, render a cheap fixed-height stub instead of the full
            // preview row. Only rows ABOVE the visible tail stub out (the
            // expand jump lands at the bottom), and identity/refs stay
            // canonical so visibility tracking and uuid jumps keep working.
            if (
              isExpandedLayout
              && expandedRenderBudget < entries.length
              && index < entries.length - expandedRenderBudget
            ) {
              return (
                <div
                  key={entry.uuid}
                  ref={el => segmentRefs.current[index] = el}
                  data-timeline-expand-stub
                  style={{ flex: '0 0 auto', minHeight: '22px' }}
                />
              );
            }
            const groupInfo = groupMap.get(index);
            const isGroupExpanded = !!(
              groupInfo?.groupId
              && isTimelineGroupExpanded(isExpandedLayout, expandedGroups.has(groupInfo.groupId))
            );
            const semanticMembership = semanticGroupByUuid.get(entry.uuid);
            const semanticGroup = semanticMembership?.group;
            const codexCompactCluster = codexCompactClusters.get(index);
            const isSemanticGroupStart = semanticMembership?.memberIndex === 0;
            const semanticGroupForcedOpen = !!semanticGroup && semanticGroupForcedOpenIds.has(semanticGroup.id);
            const isSemanticGroupExpanded = !!semanticGroup && (
              expandedSemanticGroups.has(semanticGroup.id) || semanticGroupForcedOpen
            );

            // Collapsed semantic groups own a synthetic header, never a raw
            // prompt. Keep invisible raw refs so index/UUID addressing remains
            // canonical while no prompt masquerades as the group toggle.
            if (isExpandedLayout && semanticGroup && !isSemanticGroupExpanded) {
              const hiddenEntry = <div key={`semantic-hidden:${entry.uuid}`} ref={el => segmentRefs.current[index] = el} style={{ display: 'none' }} />;
              return isSemanticGroupStart
                ? <React.Fragment key={entry.uuid}>{renderSemanticGroupHeader(semanticGroup, false)}{hiddenEntry}</React.Fragment>
                : <React.Fragment key={entry.uuid}>{hiddenEntry}</React.Fragment>;
            }

            // Phase 2: Hide collapsed group children (but NOT the header)
            if (groupInfo?.isGroupChild && !groupInfo?.isGroupHeader && !isGroupExpanded) {
              return <div key={entry.uuid} ref={el => segmentRefs.current[index] = el} style={{ display: 'none' }} />;
            }

            if (codexCompactCluster && !codexCompactCluster.isHead) {
              return <div key={entry.uuid} ref={el => segmentRefs.current[index] = el} style={{ display: 'none' }} />;
            }

            const isLastEntry = index === entries.length - 1;
            if (hiddenCompactBoundaryIndices.has(index)) {
              return <div key={entry.uuid} ref={el => segmentRefs.current[index] = el} style={{ display: 'none' }} />;
            }

            // Fork marker at this position — only the SINGLE last snapshot
            // UUID renders the blue stripe.
            const markerHitIdx = forkMarkerIndexByLastSnapIndex.get(index) ?? -1;
            const forkMarkerAny = markerHitIdx >= 0 ? forkMarkers[markerHitIdx] : null;
            const forkMarker = forkMarkerAny && !forkMarkerAny.hidden ? forkMarkerAny : null;

            const isPlanModeBoundary = (() => {
              if (isLastEntry || forkMarkerAny) return false; // ANY fork marker (even hidden) suppresses boundary
              const nextEntry = entries[index + 1];
              if (!nextEntry || !entry.sessionId || !nextEntry.sessionId) return false;
              if (entry.sessionId === nextEntry.sessionId) return false;
              // Suppress inherited session boundaries from parent chains in
              // forked sessions: a boundary whose BOTH sides live in a fork
              // snapshot came from the parent chain.
              for (const snap of forkSnapshotSets) {
                if (snap.has(entry.uuid) && snap.has(nextEntry.uuid)) return false;
              }
              return true;
            })();

            const isGroupCollapsed = !!(groupInfo?.isGroupHeader && !isGroupExpanded);
            const isInViewport = isGroupCollapsed
              ? Array.from({ length: groupInfo!.groupSize }, (_, offset) => index + offset).some(idx => visibleEntryIndices.has(idx))
              : visibleEntryIndices.has(index);
            const isOldHistory = !isCodex && lastBoundaryIndex >= 0 && index <= lastBoundaryIndex;
            const groupPresentation = isGroupCollapsed && groupInfo
              ? collapsedGroupPresentation.get(groupInfo.groupId)
              : undefined;
            const isEditingThis = activeNoteIndex === index && isNoteEditing;
            const summaryKey = summaryToolType && sessionId ? timelineSummaryKey(summaryToolType, sessionId, entry.uuid) : '';
            const summaryEligible = !!summaryKey && !getOrchestrationTag(entry) && isEligibleTabTitleEntry(entry);
            const semanticActionMeta = semanticActionByUuid.get(entry.uuid);

            return (
              <React.Fragment key={entry.uuid}>
                {isExpandedLayout && semanticGroup && isSemanticGroupStart && renderSemanticGroupHeader(semanticGroup, true)}
                <TimelineSegmentRow
                  entry={entry}
                  index={index}
                  api={rowApi}
                  groupInfo={groupInfo}
                  groupPresentation={groupPresentation}
                  compactClusterCount={codexCompactCluster?.count || 1}
                  hasSemanticMembership={!!semanticMembership}
                  metaPromptTitle={semanticMetaPromptByUuid.get(entry.uuid)?.title || null}
                  semanticActionText={semanticActionMeta?.description || null}
                  semanticActionManual={!!semanticActionMeta?.manual}
                  summaryText={summaryEligible ? (promptSummaries[summaryKey]?.summary?.trim() || '') : ''}
                  summaryLoading={summaryEligible && promptSummaryLoadingKeys.has(summaryKey)}
                  isGroupExpanded={isGroupExpanded}
                  active={isSelected(entry, index)}
                  forkMarkerVisible={!!forkMarker && !isOldHistory}
                  isPlanModeBoundary={isPlanModeBoundary && !isOldHistory}
                  isInViewport={isInViewport}
                  isResponseOnly={isGroupCollapsed ? false : responseOnlyIndices.has(index)}
                  isUnreachable={unreachableIndices.has(index)}
                  dotClickState={clickedState?.index === index ? clickedState.status : null}
                  isHovered={hoveredIndex === index || activeTooltipIndex === index}
                  noteHovered={hoveredNoteIndex === index || activeNoteIndex === index}
                  hasNote={!!notes[entry.uuid] || isEditingThis}
                  notePos={isEditingThis ? noteEditPosition : (notePositions[entry.uuid] || 'before')}
                  isRewindMarked={rewindMarkers.has(entry.uuid)}
                  isOldHistory={isOldHistory}
                  isChainBreakZone={claudeMemoryBoundaryIndex >= 0 && index <= claudeMemoryBoundaryIndex}
                  isLastBoundary={index === lastBoundaryIndex}
                  failedFlashKind={failedStripFlash?.index === index ? failedStripFlash.kind : null}
                  isForkActive={activeForkMarkerIndex === index}
                  isCmdHeld={isCmdHeld}
                  isExpandedLayout={isExpandedLayout}
                  treeMode={treeMode}
                  isCodex={isCodex}
                  isSdkTab={isSdkTab}
                  historyTargetVisible={historyTargetVisible}
                  timelineFontSize={timelineFontSize}
                  timelineSummaryFontSize={timelineSummaryFontSize}
                  timelineLineClamp={timelineLineClamp}
                  intrinsicPreviewFontSize={intrinsicPreviewFontSize}
                />
              </React.Fragment>
            );
          })}
        </div>

        {/* ──── INNER-WRAPPER OVERLAYS (rangeActionMenu indicator, selection preview, copy/delete/rewind/edit-range pulses with StatusLabelPortal) ──── */}
        {/* Selected Range Indicator (static, when action menu is open). During
            delete confirmation it expands to the beginning only for the explicit
            prefix action or Claude's cross-boundary safety rule. */}
        {isVisible && rangeActionMenu && (() => {
          const deleteExtendsToStart = deleteConfirmMode && (
            deleteRangeScope === 'through-start' ||
            (!isCodex && rangeActionMenu.crossesBoundary)
          );
          const effStart = deleteExtendsToStart
            ? 0
            : rangeActionMenu.range.startIndex;
          const rect = getOverlayRect(effStart, rangeActionMenu.range.endIndex);
          const isExtended = effStart !== rangeActionMenu.range.startIndex;
          return rect && (
            <div
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: rect.top,
                height: rect.height,
                backgroundColor: isExtended ? 'rgba(239, 68, 68, 0.10)' : 'rgba(59, 130, 246, 0.15)',
                borderTop: '1px solid ' + (isExtended ? 'rgba(239, 68, 68, 0.4)' : 'rgba(59, 130, 246, 0.4)'),
                borderBottom: '1px solid ' + (isExtended ? 'rgba(239, 68, 68, 0.4)' : 'rgba(59, 130, 246, 0.4)'),
                boxShadow: isExtended ? '0 0 8px rgba(239, 68, 68, 0.18)' : '0 0 8px rgba(59, 130, 246, 0.2)',
                transition: 'background-color 0.18s, border-color 0.18s, box-shadow 0.18s',
              }}
            />
          );
        })()}

        {/* Selection Range Indicator (hover preview during selection) */}
        {isVisible && selectionStartId && !rangeActionMenu && hoveredIndex !== null && (() => {
          const startIdx = entries.findIndex(e => e.uuid === selectionStartId);
          const rect = getOverlayRect(Math.min(startIdx, hoveredIndex), Math.max(startIdx, hoveredIndex));
          return rect && (
            <div
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: rect.top,
                height: rect.height,
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                borderTop: '1px solid rgba(59, 130, 246, 0.3)',
                borderBottom: '1px solid rgba(59, 130, 246, 0.3)',
              }}
            />
          );
        })()}

        {/* Loading Range Indicator (blinking blue while IPC runs) */}
        {isVisible && copyingRange && (() => {
          const rect = getOverlayRect(copyingRange.startIndex, copyingRange.endIndex);
          if (!rect || !innerWrapperRef.current) return null;
          const wrapperRect = innerWrapperRef.current.getBoundingClientRect();
          const fixedTop = wrapperRect.top + rect.top + 10;
          const rightOffset = window.innerWidth - wrapperRect.right + 12;

          return (
            <>
              <div
                className="absolute left-0 right-0 pointer-events-none animate-glow-blue"
                style={{
                  top: rect.top,
                  height: rect.height,
                  borderTop: '1px solid rgba(59, 130, 246, 0.8)',
                  borderBottom: '1px solid rgba(59, 130, 246, 0.8)',
                  boxShadow: '0 0 20px rgba(59, 130, 246, 0.5)',
                  zIndex: 50,
                }}
              />
              <StatusLabelPortal
                label="COPYING..."
                top={fixedTop}
                rightOffset={rightOffset}
                color="#3b82f6"
              />
            </>
          );
        })()}

        {/* Deleting Range Indicator (blinking red while delete IPC runs) */}
        {isVisible && deletingRange && (() => {
          const rect = getOverlayRect(deletingRange.startIndex, deletingRange.endIndex);
          if (!rect || !innerWrapperRef.current) return null;
          const wrapperRect = innerWrapperRef.current.getBoundingClientRect();
          const fixedTop = wrapperRect.top + rect.top + 10;
          const rightOffset = window.innerWidth - wrapperRect.right + 12;

          return (
            <>
              <div
                className="absolute left-0 right-0 pointer-events-none animate-glow-red"
                style={{
                  top: rect.top,
                  height: rect.height,
                  borderTop: '1px solid rgba(239, 68, 68, 0.85)',
                  borderBottom: '1px solid rgba(239, 68, 68, 0.85)',
                  boxShadow: '0 0 20px rgba(239, 68, 68, 0.55)',
                  zIndex: 50,
                }}
              />
              <StatusLabelPortal
                label="DELETING..."
                top={fixedTop}
                rightOffset={rightOffset}
                color="#ef4444"
              />
            </>
          );
        })()}

        {/* Copied Range Animation (green success flash) */}
        {isVisible && copiedRange && (() => {
          const rect = getOverlayRect(copiedRange.startIndex, copiedRange.endIndex);
          if (!rect || !innerWrapperRef.current) return null;
          const wrapperRect = innerWrapperRef.current.getBoundingClientRect();
          const fixedTop = wrapperRect.top + rect.top + 10;
          const rightOffset = window.innerWidth - wrapperRect.right + 12;

          return (
            <>
              <div
                className="absolute left-0 right-0 pointer-events-none"
                style={{
                  top: rect.top,
                  height: rect.height,
                  backgroundColor: 'rgba(34, 197, 94, 0.6)',
                  borderTop: '1px solid rgba(34, 197, 94, 1)',
                  borderBottom: '1px solid rgba(34, 197, 94, 1)',
                  boxShadow: '0 0 30px rgba(34, 197, 94, 0.6)',
                  zIndex: 50,
                }}
              />
              <StatusLabelPortal
                label="DONE"
                top={fixedTop}
                rightOffset={rightOffset}
                color="#22c55e"
              />
            </>
          );
        })()}

        {/* Rewind Progress Indicator */}
        {isVisible && rewindState && entries.length > 0 && (() => {
          const targetUuidIndex = entries.findIndex((candidate) => candidate.uuid === rewindState.targetUuid);
          const targetIndex = targetUuidIndex >= 0
            ? targetUuidIndex
            : Math.min(Math.max(rewindState.targetIndex, 0), entries.length - 1);
          const endIdx = rewindState.phase === 'compacting' ? entries.length - 1 : targetIndex;
          const rect = getOverlayRect(targetIndex, endIdx);
          if (!rect || !innerWrapperRef.current) return null;
          const phase = rewindState.phase;
          const label = phase === 'done'
            ? 'DONE'
            : phase === 'preparing'
            ? 'PREPARING...'
            : phase === 'compacting'
            ? 'COMPACTING...'
            : phase === 'cancelling'
            ? 'CANCELLING...'
            : phase === 'committing'
            ? 'FINISHING...'
            : phase === 'pasting'
            ? 'PASTING...'
            : 'REWINDING...';
          const blinkClass = phase === 'compacting' || phase === 'preparing' || phase === 'cancelling'
            ? 'animate-glow-yellow'
            : phase === 'done'
            ? ''
            : 'animate-glow-purple';
          const staticBg = phase === 'done' ? 'rgba(34, 197, 94, 0.4)' : '';
          const color = phase === 'done'
            ? '#22c55e'
            : phase === 'compacting' || phase === 'preparing' || phase === 'cancelling'
            ? '#f59e0b'
            : '#a855f7';
          const canCancel = isRewindOperationCancellable(rewindState);
          
          const wrapperRect = innerWrapperRef.current.getBoundingClientRect();
          const fixedTop = wrapperRect.top + rect.top + 10;
          const rightOffset = window.innerWidth - wrapperRect.right + 12;

          return (
            <>
              <div
                className={`absolute left-0 right-0 ${canCancel ? 'cursor-pointer' : 'pointer-events-none'} ${blinkClass}`}
                style={{
                  top: rect.top,
                  height: rect.height,
                  backgroundColor: staticBg,
                  borderTop: `2px solid ${color}`,
                  borderBottom: `2px solid ${color}`,
                  boxShadow: `0 0 20px ${color}80`,
                  zIndex: 50,
                }}
                onContextMenu={canCancel ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setRewindLoadingMenu({ x: 0, y: e.clientY });
                } : undefined}
              />
              <StatusLabelPortal
                label={label}
                top={fixedTop}
                rightOffset={rightOffset}
                color={color}
              />
            </>
          );
        })()}

        {/* Edit Range Overlay */}
        {isVisible && editRangeState && (() => {
          let rect: { top: number; height: number } | null = null;

          if (editRangeState.compactUuid && (editRangeState.phase === 'applying' || editRangeState.phase === 'done')) {
            // After apply: highlight only the compact entry
            const compactIdx = entries.findIndex(e => e.uuid === editRangeState.compactUuid);
            if (compactIdx !== -1) rect = getOverlayRect(compactIdx, compactIdx);
          } else {
            // Before apply: highlight the selected range
            rect = getOverlayRect(editRangeState.range.startIndex, editRangeState.range.endIndex);
          }

          if (!rect || !innerWrapperRef.current) return null;

          const isLoading = editRangeState.phase === 'loading';
          const isApplying = editRangeState.phase === 'applying';
          const isDone = editRangeState.phase === 'done';
          const isReady = editRangeState.phase === 'ready';

          const color = isDone ? '#22c55e'
            : isReady ? '#22c55e'
            : isApplying ? '#a855f7'
            : '#ec4899';

          const blinkClass = isLoading ? 'animate-glow-yellow' : isApplying ? 'animate-glow-purple' : '';
          const label = isApplying ? 'APPLYING...' : isLoading ? 'LOADING...' : isDone ? 'READY' : '';

          const wrapperRect = innerWrapperRef.current.getBoundingClientRect();
          const fixedTop = wrapperRect.top + rect.top + 10;
          const rightOffset = window.innerWidth - wrapperRect.right + 12;

          return (
            <>
              <div
                className={`absolute left-0 right-0 ${isLoading || isDone ? 'cursor-pointer' : 'pointer-events-none'} ${blinkClass}`}
                style={{
                  top: rect.top,
                  height: rect.height,
                  backgroundColor: isDone || isReady ? 'rgba(34, 197, 94, 0.15)' : '',
                  borderTop: `2px solid ${color}`,
                  borderBottom: `2px solid ${color}`,
                  boxShadow: `0 0 15px ${color}80`,
                  zIndex: 50,
                }}
                onMouseEnter={isDone ? () => {
                  editRangeDoneHovered.current = true;
                  if (editRangeDoneTimer.current) { clearTimeout(editRangeDoneTimer.current); editRangeDoneTimer.current = null; }
                } : undefined}
                onMouseLeave={isDone ? () => {
                  editRangeDoneHovered.current = false;
                  setEditRangeState(null); // instant close on leave
                } : undefined}
                onClick={isDone ? () => setEditRangeState(null) : undefined}
                onContextMenu={isLoading ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  // y from cursor (popup follows vertical click point), x ignored (right-anchored).
                  setEditRangeLoadingMenu({ x: 0, y: e.clientY });
                } : undefined}
              />
              {label && (
                <StatusLabelPortal
                  label={label}
                  top={fixedTop}
                  rightOffset={rightOffset}
                  color={color}
                />
              )}
            </>
          );
        })()}

          </div>{/* end inner relative wrapper */}

        {/* ──── EDIT-RANGE PANEL PORTAL (EditRangePanel — Gemini compact display + apply/cancel) ──── */}
        {/* Edit Range Panel (portal) — visible during ready, applying, done */}
        {editRangeState && (editRangeState.phase === 'ready' || editRangeState.phase === 'applying' || editRangeState.phase === 'done') && (() => {
          // After apply, anchor to the compact entry by UUID; before — use range
          let anchorTop: number;
          let anchorHeight: number;

          if (editRangeState.compactUuid && (editRangeState.phase === 'applying' || editRangeState.phase === 'done')) {
            // Find compact entry in current entries
            const compactIdx = entries.findIndex(e => e.uuid === editRangeState.compactUuid);
            const compactEl = compactIdx !== -1 ? segmentRefs.current[compactIdx] : null;
            if (compactEl) {
              const r = compactEl.getBoundingClientRect();
              anchorTop = r.top;
              anchorHeight = r.height;
            } else {
              // Compact not in timeline yet (refresh pending) — use container center
              const cr = containerRef.current?.getBoundingClientRect();
              anchorTop = cr ? cr.top + cr.height / 2 - 20 : 200;
              anchorHeight = 40;
            }
          } else {
            // Pre-apply: use original range
            const startEl = segmentRefs.current[editRangeState.range.startIndex];
            const endEl = segmentRefs.current[editRangeState.range.endIndex];
            if (!startEl || !endEl) {
              const cr = containerRef.current?.getBoundingClientRect();
              anchorTop = cr ? cr.top + cr.height / 2 - 20 : 200;
              anchorHeight = 40;
            } else {
              const startRect = startEl.getBoundingClientRect();
              const endRect = endEl.getBoundingClientRect();
              anchorTop = startRect.top;
              anchorHeight = endRect.bottom - startRect.top;
            }
          }

          if (!containerRef.current) return null;
          const containerRect = containerRef.current.getBoundingClientRect();
          const rightOffset = window.innerWidth - containerRect.left + 8;
          const panelEl = (
            <EditRangePanel
              sourceContent={editRangeState.sourceContent}
              initialCompact={editRangeState.compactText}
              anchorTop={anchorTop}
              anchorHeight={anchorHeight}
              rightOffset={rightOffset}
              autoEditInitial={editRangeState.autoEditInitial}
              onApply={async (compactText, onProgress) => {
                console.warn('[EditRange] Applying, compact length:', compactText.length);
                setEditRangeState(prev => prev ? { ...prev, phase: 'applying' } : null);
                onProgress?.('stopping');

                const range = editRangeState!.range;
                const startUuid = entries[range.startIndex].uuid;
                const endUuid = entries[range.endIndex].uuid;

                if (isCodex) {
                  const mutationSessionId = await stopCodexForHistoryMutation('Edit Range');

                  onProgress?.('editing');
                  console.warn('[CodexEditRange] Creating edited local rollout fork...');
                  const result = await ipcRenderer.invoke('codex:edit-range', {
                    sessionId: mutationSessionId, cwd, startUuid, endUuid, compactText,
                  });

                  if (!result.success) {
                    throw new Error(result.error);
                  }

                  console.warn('[CodexEditRange] New session:', result.newSessionId?.slice(0, 8), 'replacementUuid:', result.replacementUuid);
                  const doneState = editRangeState
                    ? { ...editRangeState, phase: 'done' as const, compactUuid: result.replacementUuid || result.compactUuid }
                    : null;
                  if (doneState && result.newSessionId) {
                    _savedEditRangeMap.set(result.newSessionId, doneState);
                    if (_savedEditRangeMap.size > SAVED_MAP_MAX) {
                      const first = _savedEditRangeMap.keys().next().value;
                      if (first) _savedEditRangeMap.delete(first);
                    }
                  }

                  if (result.newSessionId) {
                    onProgress?.('restarting');
                    await adoptAndRestartCodexHistory(result.newSessionId, 'editRange');
                  }

                  setEditRangeState(doneState);
                  useUIStore.getState().showToast('Codex Edit Range создан', 'success', 1500);
                  return { removedCount: result.removedCount, removedUsers: result.removedUsers };
                }

                // Step 1: Exit Claude only when a real Claude process is still running.
                let waitForPromptReadyBeforeRestart = false;
                let promptReadyWait: { promise: Promise<boolean>; cancel: () => void } | null = null;
                const createShellPromptReadyWait = (timeoutMs = 15000) => {
                  let cleanup = () => {};
                  const promise = new Promise<boolean>((resolve) => {
                    let settled = false;
                    const finish = (ready: boolean) => {
                      if (settled) return;
                      settled = true;
                      cleanup();
                      resolve(ready);
                    };
                    const timeout = setTimeout(() => {
                      console.warn('[EditRange] prompt-ready timeout while waiting for shell prompt');
                      finish(false);
                    }, timeoutMs);
                    const handler = (_e: any, readyTabId: string) => {
                      if (readyTabId !== tabId) return;
                      console.warn('[EditRange] prompt-ready captured');
                      finish(true);
                    };
                    cleanup = () => {
                      clearTimeout(timeout);
                      ipcRenderer.removeListener('terminal:prompt-ready', handler);
                    };
                    ipcRenderer.on('terminal:prompt-ready', handler);
                  });
                  return {
                    promise,
                    cancel: cleanup,
                  };
                };
                const cmdState = await ipcRenderer.invoke('terminal:getCommandState', {
                  tabId,
                  caller: 'Timeline.claudeEditRange',
                  expectedProcess: 'claude',
                  allowProcessTreeLookup: true,
                  ignoreBridgeAlive: true,
                });
                console.warn('[EditRange] commandState:', JSON.stringify(cmdState));

                if (cmdState?.isRunning) {
                  waitForPromptReadyBeforeRestart = true;
                  // Arm before Ctrl+C: OSC 133 A can arrive between command-finished
                  // detection and JSONL edit, before the old post-edit listener existed.
                  promptReadyWait = createShellPromptReadyWait();
                  console.warn('[EditRange] Sending Ctrl+C #1, waiting for DangerZone...');
                  ipcRenderer.send('terminal:input', tabId, '\x03');

                  // Wait for "again to exit" detection (deterministic, no blind timeout)
                  await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => {
                      console.warn('[EditRange] DangerZone timeout, aborting edit-range before Ctrl+C #2');
                      ipcRenderer.removeListener('claude:ctrlc-danger-zone', handler);
                      reject(new Error('Claude danger-zone did not appear before edit-range stop'));
                    }, 3000);
                    const handler = (_e: any, data: { tabId: string; active: boolean }) => {
                      if (data.tabId === tabId && data.active) {
                        clearTimeout(timeout);
                        ipcRenderer.removeListener('claude:ctrlc-danger-zone', handler);
                        console.warn('[EditRange] DangerZone detected, sending Ctrl+C #2');
                        resolve();
                      }
                    };
                    ipcRenderer.on('claude:ctrlc-danger-zone', handler);
                  });

                  ipcRenderer.send('terminal:input', tabId, '\x03');

                  // Wait for isRunning=false (OSC 133 D = command finished)
                  let commandFinished = false;
                  for (let i = 0; i < 30; i++) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                    const state = await ipcRenderer.invoke('terminal:getCommandState', {
                      tabId,
                      caller: 'Timeline.claudeEditRange.exitPoll',
                      expectedProcess: 'claude',
                      allowProcessTreeLookup: true,
                      ignoreBridgeAlive: true,
                    });
                    if (!state?.isRunning) {
                      commandFinished = true;
                      console.warn('[EditRange] Command finished (OSC 133 D)');
                      break;
                    }
                    if (i === 29) console.warn('[EditRange] Exit timeout');
                  }
                  if (!commandFinished) {
                    throw new Error('Claude did not stop before edit-range');
                  }
                  await new Promise(resolve => setTimeout(resolve, 300));
                } else {
                  console.warn('[EditRange] Claude already stopped; skipping Ctrl+C exit');
                }

                // Step 2: Edit JSONL
                onProgress?.('editing');
                console.warn('[EditRange] Editing JSONL...');
                const result = await ipcRenderer.invoke('claude:edit-range', {
                  sessionId, cwd, startUuid, endUuid, compactText,
                });

                if (!result.success) {
                  throw new Error(result.error);
                }

                console.warn('[EditRange] Removed', result.removedCount, 'compactUuid:', result.compactUuid);

                // Save compactUuid so overlay can anchor to it after timeline refresh
                setEditRangeState(prev => prev ? { ...prev, compactUuid: result.compactUuid } : null);

                // Step 3: Wait for a fresh shell prompt only after we actually stopped Claude.
                if (waitForPromptReadyBeforeRestart) {
                  console.warn('[EditRange] Waiting for prompt-ready...');
                  const promptReadySeen = promptReadyWait ? await promptReadyWait.promise : false;
                  promptReadyWait = null;
                  if (!promptReadySeen) {
                    const state = await ipcRenderer.invoke('terminal:getCommandState', {
                      tabId,
                      caller: 'Timeline.claudeEditRange.promptReadyFallback',
                      expectedProcess: 'claude',
                      allowProcessTreeLookup: true,
                      ignoreBridgeAlive: true,
                    });
                    if (state?.isRunning) {
                      throw new Error('Shell prompt did not become ready before Claude restart');
                    }
                    console.warn('[EditRange] prompt-ready was not observed, but Claude is stopped; continuing restart');
                  }
                } else {
                  console.warn('[EditRange] Claude was already stopped; skipping prompt-ready wait');
                }

                onProgress?.('restarting');
                console.warn('[EditRange] Restarting Claude with session:', sessionId?.slice(0, 8));
                const launchResult = await ipcRenderer.invoke('claude:run-command', {
                  tabId,
                  command: 'claude-c',
                  sessionId,
                });
                if (launchResult?.success === false || launchResult?.accepted === false) {
                  throw new Error(launchResult?.error || launchResult?.reason || 'Claude restart rejected');
                }

                // Wait for Claude to start (isRunning = true = command running = sidebar green)
                for (let i = 0; i < 30; i++) {
                  await new Promise(resolve => setTimeout(resolve, 300));
                  const state = await ipcRenderer.invoke('terminal:getCommandState', {
                    tabId,
                    caller: 'Timeline.claudeEditRange.startPoll',
                    expectedProcess: 'claude',
                    allowProcessTreeLookup: true,
                    ignoreBridgeAlive: true,
                  });
                  if (state?.isRunning) {
                    console.warn('[EditRange] Claude running (sidebar green)');
                    break;
                  }
                  if (i === 29) console.warn('[EditRange] Claude start timeout');
                }

                // Show toast on success
                useUIStore.getState().showToast('Rewind завершён', 'success', 1500);
                setEditRangeState(prev => prev ? { ...prev, phase: 'done' } : null);

                return { removedCount: result.removedCount, removedUsers: result.removedUsers };
              }}
              onApplyError={(error) => {
                const message = error instanceof Error ? error.message : String(error || 'unknown error');
                setEditRangeState(prev => {
                  if (!prev) return null;
                  if (prev.compactUuid) return { ...prev, phase: 'done' as const };
                  return { ...prev, phase: 'ready' as const };
                });
                useUIStore.getState().showToast('Edit Range failed: ' + message, 'error', 5000);
              }}
              onClose={() => setEditRangeState(null)}
            />
          );
          // Wrap panel with hover handlers for done phase auto-dismiss
          if (editRangeState.phase === 'done') {
            return (
              <div
                onMouseEnter={() => {
                  editRangeDoneHovered.current = true;
                  if (editRangeDoneTimer.current) { clearTimeout(editRangeDoneTimer.current); editRangeDoneTimer.current = null; }
                }}
                onMouseLeave={() => {
                  editRangeDoneHovered.current = false;
                  setEditRangeState(null);
                }}
              >
                {panelEl}
              </div>
            );
          }
          return panelEl;
        })()}

        {isVisible && activeSemanticGroup && semanticGroupTooltipPos && (
          <TooltipPortal>
            <div
              data-cmd-hover-popover
              className="fixed flex flex-col gap-2"
              style={{
                top: semanticGroupTooltipPos.top,
                right: popupRightPx,
                width: Math.min(Math.max(timelineTooltipWidth, 260), 420),
                zIndex: 9999,
                padding: '10px 12px',
                borderRadius: '8px 0 0 8px',
                border: '1px solid rgba(192,132,252,0.24)',
                background: 'rgba(22,18,28,0.98)',
                boxShadow: '0 12px 34px rgba(0,0,0,0.48)',
              }}
              onMouseEnter={() => setActiveSemanticGroupId(activeSemanticGroup.id)}
              onMouseLeave={() => {
                if (!isCmdHeldRef.current && !isLockedTooltipRef.current) setActiveSemanticGroupId(null);
              }}
            >
              <div className="text-[11px] leading-snug" style={{ color: 'rgba(255,255,255,0.72)', whiteSpace: 'pre-wrap' }}>
                {activeSemanticGroup.description}
              </div>
            </div>
          </TooltipPortal>
        )}

        {/* ──── TOOLTIP PORTAL (entry tooltip + CSS hover-bridge to Timeline strip) ──── */}
        {/* Tooltip Portal with CSS Bridge */}
        {isVisible && activeTooltipIndex !== null && currentActiveEntry && tooltipPos && (
          <TooltipPortal>
            {/* Outer wrapper — explicit height ensures bridge connects tooltip to entry.
                In debug mode, the wrapper itself is tinted red so the user can SEE the
                hover-corridor (the wrapper IS the bridge here — it sits between the
                visible tooltip content and the Timeline strip on the right). */}
            <div
              ref={tooltipRef}
              data-cmd-hover-popover
              onMouseEnter={() => { isMouseInTooltipRef.current = true; }}
              onMouseLeave={() => {
                // §2.7 (сценарии-багов-design): while the single-entry breakdown popover
                // is open, the global 'mousemove' keep-alive (the singleBreakdownOpen
                // effect ~670) owns ALL closing for this gesture — it hit-tests
                // chip+popover+parent every frame. onMouseLeave fires a few ms earlier and
                // (during flip-up / JSONL↔API re-measure) reads a transiently stale popover
                // rect, killing the PARENT while the child survives — the exact intermittent
                // close the user hit. So do NOT decide visibility here in that state: make
                // MouseLeave a no-op and let the continuous geometric guard close both.
                if (singleBreakdownOpen) {
                  return;
                }
                if (!isResizingTooltipRef.current && !freezeCmdPopups && !isLockedTooltip) {
                  isMouseInTooltipRef.current = false;
                  handleMouseLeaveTooltipArea();
                }
              }}
              style={{
                position: 'fixed',
                right: `${popupRightPx}px`,
                top: `${tooltipPos.wTop}px`,
                height: `${tooltipPos.wH}px`,
                zIndex: 10010,
                display: 'flex',
                flexDirection: 'row',
                backgroundColor: debugHoverBridges ? 'rgba(239, 68, 68, 0.30)' : undefined,
                outline: debugHoverBridges ? '1px dashed rgba(239, 68, 68, 0.8)' : undefined,
                alignItems: tooltipPos.vAlign,
              }}
            >
              {/* Visible tooltip content */}
              <div
                ref={tooltipContentRef}
                tabIndex={-1}
                style={{
                  marginTop: tooltipPos.vAlign === 'flex-start' ? `${tooltipPos.offset}px` : undefined,
                  outline: 'none',
                  backgroundColor: 'rgba(25, 25, 25, 0.98)',
                  backdropFilter: 'blur(12px)',
                  border: isLockedTooltip ? '1px solid #fff' : '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '6px 0 0 6px',
                  padding: '10px 14px',
                  fontSize: '12px',
                  color: 'white',
                  width: `${timelineTooltipWidth}px`,
                  maxHeight: isExpanded ? '78vh' : '260px',
                  boxShadow: '-8px 8px 30px rgba(255,255,255,0.08), -2px 2px 8px rgba(255,255,255,0.05)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                {/* Resize handle — left edge (inside bounds to avoid tooltip close) */}
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: 0,
                    width: 6,
                    cursor: 'ew-resize',
                    zIndex: 1,
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    isResizingTooltipRef.current = true;
                    const startX = e.clientX;
                    const startW = timelineTooltipWidth;
                    const onMove = (ev: MouseEvent) => {
                      const delta = startX - ev.clientX;
                      setTimelineTooltipWidth(startW + delta);
                    };
                    const onUp = (ev: MouseEvent) => {
                      document.removeEventListener('mousemove', onMove);
                      document.removeEventListener('mouseup', onUp);
                      isResizingTooltipRef.current = false;
                      isMouseInTooltipRef.current = true;
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                  }}
                />
                {currentActiveEntryDisplaysAsCompact ? (() => {
                  const cached = currentActiveEntry.type === 'compact'
                    ? compactSummaryCache[currentActiveEntry.uuid]
                    : undefined;
                  const compactText = currentActiveEntryIsCompactSummary
                    ? currentActiveEntry.content
                    : (currentActiveEntry.compactSummary || cached || '');
                  const isLoadingCompact = currentActiveEntry.type === 'compact'
                    && !currentActiveEntry.compactSummary
                    && cached === undefined;
                  const displayText = compactText || (isLoadingCompact ? 'Загружаю compact summary...' : 'Compact summary не найден');
                  const canCopyCompact = !!compactText;
                  const compactPreTokens = currentActiveCompactBoundaryEntry?.preTokens || currentActiveEntry.preTokens;
                  return (
                    <>
                      <div className="flex items-center gap-2 shrink-0">
                        <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#f59e0b', flexShrink: 0 }} />
                        <span className="text-amber-400 font-medium text-[11px]">
                          History Compacted ({compactPreTokens ? `${Math.round(compactPreTokens / 1000)}k` : '?'} tokens)
                        </span>
                      </div>
                      <div
                        className="text-white/70 leading-snug font-mono text-[11px] scrollbar-thin"
                        style={{
                          maxHeight: isExpanded ? 'calc(78vh - 80px)' : '160px',
                          overflowY: 'auto',
                          overflowX: 'hidden',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {displayText}
                      </div>
                      <div className="flex items-center mt-0 pt-1 border-t border-white/5 shrink-0">
                        <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                        <div className="flex-1" />
                        <button
                          disabled={!canCopyCompact}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!canCopyCompact) return;
                            clipboard.writeText(compactText);
                            setTooltipCopied(true);
                            setTimeout(() => setTooltipCopied(false), 1200);
                          }}
                          className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-[10px] transition-colors disabled:opacity-40 disabled:cursor-default cursor-pointer"
                          style={{ color: tooltipCopied ? '#4ade80' : 'rgba(255,255,255,0.6)' }}
                        >
                          {tooltipCopied ? <Check size={12} /> : <Copy size={12} />}
                          {tooltipCopied ? 'Скопировано' : isLoadingCompact ? 'Загрузка' : 'Копировать'}
                        </button>
                        {(displayText.length > 200 || isExpanded) && (
                          <Tooltip content={isExpanded ? "Свернуть" : "Развернуть полностью"}>
                          <button
                            onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                            className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors cursor-pointer shrink-0 ml-1"
                          >
                            {isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                          </button>
                          </Tooltip>
                        )}
                      </div>
                    </>
                  );
                })() : currentActiveEntry.type === 'continued' ? (
                  <>
                    <span className="text-amber-400 font-medium shrink-0">Context Overflow Recovery</span>
                    <div className="text-white/70 leading-snug font-mono text-[11px] scrollbar-thin" style={{ maxHeight: isExpanded ? 'calc(78vh - 80px)' : '160px', overflowY: 'auto', overflowX: 'hidden', whiteSpace: 'pre-wrap' }}>
                      {currentActiveEntry.content}
                    </div>
                    <div className="flex items-center mt-0 pt-1 border-t border-white/5 shrink-0">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      <div className="flex-1" />
                      {(currentActiveEntry.content.length > 200 || isExpanded) && (
                        <Tooltip content={isExpanded ? "Свернуть" : "Развернуть полностью"}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                          className="px-1 py-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors cursor-pointer shrink-0"
                        >
                          {isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                        </button>
                        </Tooltip>
                      )}
                    </div>
                  </>
                ) : currentActiveEntry.type === 'docs_edit' ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: DOCS_TIMELINE_COLORS.edited.visible, flexShrink: 0 }} />
                      <span style={{ color: DOCS_TIMELINE_COLORS.edited.visible }} className="font-medium text-[11px]">Docs Updated</span>
                    </div>
                    <div className="text-white/70 leading-snug font-mono text-[11px]" style={{ whiteSpace: 'pre-wrap' }}>
                      {(currentActiveEntry.docsEdited || [currentActiveEntry.content]).map((f: string, i: number) => (
                        <div key={i} className="flex items-center gap-1.5 py-0.5">
                          <Pencil size={10} className="shrink-0" style={{ color: DOCS_TIMELINE_COLORS.edited.tooltipMuted }} />
                          <span>{f}</span>
                        </div>
                      ))}
                    </div>
                    <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                  </>
                ) : currentActiveEntry.type === 'docs_search' ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: DOCS_TIMELINE_COLORS.search.visible, flexShrink: 0 }} />
                      <span style={{ color: DOCS_TIMELINE_COLORS.search.visible }} className="font-medium text-[11px]">Docs Search</span>
                    </div>
                    <div className="text-white/70 leading-snug font-mono text-[11px]" style={{ whiteSpace: 'pre-wrap' }}>
                      {(currentActiveEntry.docsSearchQueries || [currentActiveEntry.content]).map((q: string, i: number) => (
                        <div key={i} className="flex items-center gap-1.5 py-0.5">
                          <Search size={10} className="shrink-0" style={{ color: DOCS_TIMELINE_COLORS.search.tooltipMuted }} />
                          <span>{q}</span>
                        </div>
                      ))}
                    </div>
                    <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                  </>
                ) : getOrchestrationTag(currentActiveEntry) ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div style={{ width: '7px', height: '7px', borderRadius: '2px', backgroundColor: '#a855f7', transform: 'rotate(45deg)', flexShrink: 0 }} />
                      <span style={{ color: '#c084fc' }} className="font-medium text-[11px]">
                        {getOrchestrationTag(currentActiveEntry)?.phase === 'request'
                          ? 'Terminal MCP request'
                          : getOrchestrationTag(currentActiveEntry)?.phase === 'failure'
                            ? 'Terminal MCP failure'
                            : 'Terminal MCP result'}
                      </span>
                    </div>
                    {(() => {
                      const gi = groupMap.get(activeTooltipIndex!);
                      if (gi?.isGroupHeader && !isTimelineGroupExpanded(isExpandedLayout, expandedGroups.has(gi.groupId))) {
                        return <span className="text-[10px] text-white/40">{gi.groupSize} calls</span>;
                      }
                      return null;
                    })()}
                    {renderAttachedDocsActivity(
                      currentActiveDocs.edited,
                      currentActiveDocs.searched,
                      currentActiveDocsKey,
                    )}
                    <div className="text-white/70 leading-snug font-mono text-[11px] scrollbar-thin" style={{ maxHeight: isExpanded ? 'calc(78vh - 80px)' : '160px', overflowY: 'auto', overflowX: 'hidden', whiteSpace: 'pre-wrap' }}>
                      {currentActiveEntry.content}
                    </div>
                    <div className="flex items-center gap-2 mt-0 pt-1 border-t border-white/5 shrink-0">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      <span className="text-[9px] text-white/25 font-mono truncate">{getOrchestrationTag(currentActiveEntry)?.runId}</span>
                    </div>
                  </>
                ) : (currentActiveEntry.isSubAgent || currentActiveEntry.isSubAgentTimeout) ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: currentActiveEntry.isSubAgentTimeout ? '#ef4444' : '#818cf8', flexShrink: 0 }} />
                      <span style={{ color: currentActiveEntry.isSubAgentTimeout ? '#ef4444' : '#818cf8' }} className="font-medium text-[11px]">
                        {currentActiveEntry.isSubAgentTimeout ? 'Timeout' : (currentActiveEntry.subAgentName || 'Claude Sub-Agent')}
                      </span>
                    </div>
                    {(() => {
                      const gi = groupMap.get(activeTooltipIndex!);
                      if (gi?.isGroupHeader && !isTimelineGroupExpanded(isExpandedLayout, expandedGroups.has(gi.groupId))) {
                        return (
                          <span className="text-[10px] text-white/40">
                            {gi.groupSize} agents{gi.hasTimeout ? ' (with timeout)' : ''}
                          </span>
                        );
                      }
                      return null;
                    })()}
                    <div className="text-white/70 leading-snug font-mono text-[11px] scrollbar-thin" style={{ maxHeight: isExpanded ? 'calc(78vh - 80px)' : '160px', overflowY: 'auto', overflowX: 'hidden', whiteSpace: 'pre-wrap' }}>
                      {currentActiveEntry.content}
                    </div>
                    <div className="flex items-center mt-0 pt-1 border-t border-white/5 shrink-0">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      {renderSingleTokenChip(currentActiveEntry)}
                      <div className="flex-1" />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          clipboard.writeText(currentActiveEntry.content);
                          setTooltipCopied(true);
                          setTimeout(() => setTooltipCopied(false), 1200);
                        }}
                        className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-[10px] transition-colors cursor-pointer"
                        style={{ color: tooltipCopied ? '#4ade80' : 'rgba(255,255,255,0.6)' }}
                      >
                        {tooltipCopied ? <Check size={12} /> : <Copy size={12} />}
                        {tooltipCopied ? 'Скопировано' : 'Copy'}
                      </button>
                      {(currentActiveEntry.content.length > 200 || isExpanded) && (
                        <Tooltip content={isExpanded ? "Свернуть" : "Развернуть полностью"}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                          className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors cursor-pointer shrink-0 ml-1"
                        >
                          {isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                        </button>
                        </Tooltip>
                      )}
                    </div>
                  </>
                ) : currentActiveEntry.isPlan ? (
                  <>
                    <span style={{ color: '#48968c' }} className="font-medium shrink-0">Plan Mode (auto-submitted)</span>
                    <div className="text-white/70 leading-snug font-mono text-[11px] scrollbar-thin" style={{ maxHeight: isExpanded ? 'calc(78vh - 80px)' : '160px', overflowY: 'auto', overflowX: 'hidden', whiteSpace: 'pre-wrap' }}>
                      {currentActiveEntry.content}
                    </div>
                    <div className="flex items-center mt-0 pt-1 border-t border-white/5 shrink-0">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      {renderSingleTokenChip(currentActiveEntry)}
                      <div className="flex-1" />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          clipboard.writeText(currentActiveEntry.content);
                          setTooltipCopied(true);
                          setTimeout(() => setTooltipCopied(false), 1200);
                        }}
                        className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-[10px] transition-colors cursor-pointer"
                        style={{ color: tooltipCopied ? '#4ade80' : 'rgba(255,255,255,0.6)' }}
                      >
                        {tooltipCopied ? <Check size={12} /> : <Copy size={12} />}
                        {tooltipCopied ? 'Скопировано' : 'Копировать'}
                      </button>
                      {(currentActiveEntry.content.length > 200 || isExpanded) && (
                        <Tooltip content={isExpanded ? "Свернуть" : "Развернуть полностью"}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                          className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors cursor-pointer shrink-0 ml-1"
                        >
                          {isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                        </button>
                        </Tooltip>
                      )}
                    </div>
                    {(() => {
                      const md = describeModel(currentActiveEntry.responseModel);
                      if (!md) return null;
                      return (
                        <Tooltip content={'Provider: ' + md.provider + ' · Model: ' + currentActiveEntry.responseModel + (currentActiveEntry.responseHasThinking ? ' · thinking' : '')}>
                        <div className="flex items-center mt-0 text-[10px] shrink-0">
                          <span style={{ color: md.color }}>{md.provider} · {md.short}</span>
                          {currentActiveEntry.responseHasThinking && <span className="ml-1.5" style={{ color: '#b4b9f9' }}>· think</span>}
                        </div>
                        </Tooltip>
                      );
                    })()}
                  </>
                ) : (
                  <>
                    {/* Inline note preview when note is on dot */}
                    {notes[currentActiveEntry.uuid] && (notePositions[currentActiveEntry.uuid] || 'before') === 'dot' && (
                      <div className="flex items-start gap-1.5 pb-1.5 mb-1.5 border-b border-purple-500/15 shrink-0">
                        <StickyNote size={10} className="shrink-0 mt-0.5" style={{ color: '#0891b2' }} />
                        <div className="text-purple-300/80 leading-snug font-mono text-[10px] line-clamp-2 flex-1" style={{ whiteSpace: 'pre-wrap' }}>
                          {notes[currentActiveEntry.uuid]}
                        </div>
                        <Tooltip content="Редактировать заметку">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAddNote(currentActiveEntry);
                          }}
                          className="p-0.5 rounded hover:bg-purple-500/20 text-purple-400/60 hover:text-purple-300 transition-colors cursor-pointer shrink-0"
                        >
                          <Pencil size={10} />
                        </button>
                        </Tooltip>
                      </div>
                    )}
                    {renderAttachedDocsActivity(
                      currentActiveDocs.edited,
                      currentActiveDocs.searched,
                      currentActiveDocsKey,
                    )}
                    <div className="text-white/90 leading-snug font-mono scrollbar-thin" style={{ maxHeight: isExpanded ? 'calc(78vh - 80px)' : '160px', overflowY: 'auto', overflowX: 'hidden', whiteSpace: 'pre-wrap' }}>
                      {currentActiveEntry.content}
                    </div>
                    <div className="flex items-center mt-0 pt-1 border-t border-white/5 shrink-0">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      {renderSingleTokenChip(currentActiveEntry)}
                      <div className="flex-1" />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          clipboard.writeText(currentActiveEntry.content);
                          setTooltipCopied(true);
                          setTimeout(() => setTooltipCopied(false), 1200);
                        }}
                        className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-[10px] transition-colors cursor-pointer"
                        style={{ color: tooltipCopied ? '#4ade80' : 'rgba(255,255,255,0.6)' }}
                      >
                        {tooltipCopied ? <Check size={12} /> : <Copy size={12} />}
                        {tooltipCopied ? 'Скопировано' : 'Копировать'}
                      </button>
                      {(currentActiveEntry.content.length > 200 || isExpanded) && (
                        <Tooltip content={isExpanded ? "Свернуть" : "Развернуть полностью"}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                          className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors cursor-pointer shrink-0 ml-1"
                        >
                          {isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                        </button>
                        </Tooltip>
                      )}
                    </div>
                    {(() => {
                      const md = describeModel(currentActiveEntry.responseModel);
                      if (!md) return null;
                      return (
                        <Tooltip content={'Provider: ' + md.provider + ' · Model: ' + currentActiveEntry.responseModel + (currentActiveEntry.responseHasThinking ? ' · thinking' : '')}>
                        <div className="flex items-center mt-0 text-[10px] shrink-0">
                          <span style={{ color: md.color }}>{md.provider} · {md.short}</span>
                          {currentActiveEntry.responseHasThinking && <span className="ml-1.5" style={{ color: '#b4b9f9' }}>· think</span>}
                        </div>
                        </Tooltip>
                      );
                    })()}
                  </>
                )}
              </div>
              {/* CSS Bridge removed — Timeline now docks against the popup at popupRightPx=0,
                  so the wrapper itself IS contiguous with the strip. An extra 8px child
                  here was creating a visible gap between tooltip-content and Timeline. */}
            </div>
          </TooltipPortal>
        )}

        {/* ──── EDIT-RANGE LOADING MENU PORTAL (right-click on pink loading overlay → Interrupt/Cancel) ──── */}
        {/* Edit Range Loading Context Menu (right-click on pink overlay) */}
        {editRangeLoadingMenu && editRangeState?.phase === 'loading' && (
          <TooltipPortal>
            <div
              ref={editRangeLoadingMenuRef}
              onMouseLeave={() => setEditRangeLoadingMenu(null)}
              style={{
                position: 'fixed',
                // Right-anchor: same formula as note tooltip / context menu / range action menu.
                right: `${popupRightPx}px`,
                top: editRangeLoadingMenu.y,
                backgroundColor: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '4px',
                zIndex: 10001,
                minWidth: '140px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
              }}
            >
              <button
                className="w-full text-left px-3 py-2 text-xs text-amber-400 hover:bg-amber-600/20 rounded transition-colors cursor-pointer flex items-center gap-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditRangeLoadingMenu(null);
                  // Abort fetch and open panel with empty text
                  if (editRangeAbortRef.current) editRangeAbortRef.current.abort();
                  setEditRangeState(prev => prev ? { ...prev, phase: 'ready', compactText: '' } : null);
                }}
              >
                <Scissors size={12} />
                Прервать
              </button>
              <button
                className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-600/20 rounded transition-colors cursor-pointer flex items-center gap-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditRangeLoadingMenu(null);
                  if (editRangeAbortRef.current) editRangeAbortRef.current.abort();
                  setEditRangeState(null);
                }}
              >
                <X size={12} />
                Отмена
              </button>
            </div>
          </TooltipPortal>
        )}

        {/* ──── REWIND LOADING MENU PORTAL (right-click on Rewind overlay → Cancel) ──── */}
        {rewindLoadingMenu && rewindState && isRewindOperationCancellable(rewindState) && (
          <TooltipPortal>
            <div
              ref={rewindLoadingMenuRef}
              onMouseLeave={() => setRewindLoadingMenu(null)}
              style={{
                position: 'fixed',
                right: `${popupRightPx}px`,
                top: rewindLoadingMenu.y,
                backgroundColor: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '4px',
                zIndex: 10001,
                minWidth: '140px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
              }}
            >
              <button
                className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-600/20 rounded transition-colors cursor-pointer flex items-center gap-2"
                onClick={(e) => {
                  e.stopPropagation();
                  cancelActiveRewind();
                }}
              >
                <X size={12} />
                Отмена
              </button>
            </div>
          </TooltipPortal>
        )}

        {/* ──── CONTEXT MENU PORTAL (right-click on dot → Copy/Note/Rewind/cancel-selection) ──── */}
        {/* Context Menu */}
        {isVisible && contextMenu && (
          <TooltipPortal>
            <div
              ref={contextMenuRef}
              data-timeline-context-menu
              style={{
                position: 'fixed',
                // Right edge of menu pinned to left edge of Timeline (-8px overlap, matches note tooltip).
                // Same anchor regardless of where cursor clicked inside the 32px-wide dot.
                right: `${popupRightPx}px`,
                top: contextMenuTop,
                backgroundColor: '#1a1a1a',
                border: `1px solid ${singlePostPromptEntryUuid ? '#8b5cf6' : '#333'}`,
                borderRadius: '4px',
                padding: '4px',
                zIndex: 10001,
                minWidth: singlePostPromptEntryUuid ? '320px' : '160px',
                maxWidth: singlePostPromptEntryUuid ? '400px' : undefined,
                maxHeight: 'calc(100vh - 40px)',
                overflowY: 'auto',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
              }}
            >
              {singlePostPromptEntryUuid ? (() => {
                // Instruction step of the violet single-point Rewind. Mirrors the
                // selection version: ⌘+Enter sends, Esc returns to the menu.
                const targetEntry = entries.find((candidate) => candidate.uuid === singlePostPromptEntryUuid);
                const submitWithPrompt = () => {
                  const prompt = postPromptText.trim();
                  if (!prompt || !targetEntry) return;
                  setSinglePostPromptEntryUuid(null);
                  setPostPromptText('');
                  requestHistoryRewrite(targetEntry, { additionalPrompt: prompt });
                };
                return (
                  <div className="p-1" data-testid="timeline-rewind-rewrite-prompt-editor">
                    <textarea
                      ref={postPromptRef}
                      value={postPromptText}
                      onChange={(e) => setPostPromptText(e.target.value)}
                      placeholder="Дополнительная инструкция для Gemini..."
                      className="w-full bg-[#252525] border border-[#444] rounded px-2 py-1.5 text-[11px] text-white/90 font-mono resize-none focus:outline-none focus:border-violet-500/50 placeholder:text-[#555]"
                      style={{ minHeight: '28px', maxHeight: '110px', lineHeight: '1.4' }}
                      rows={1}
                      onInput={(e) => {
                        const el = e.currentTarget;
                        el.style.height = 'auto';
                        el.style.height = Math.min(el.scrollHeight, 110) + 'px';
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.metaKey && postPromptText.trim()) {
                          e.preventDefault();
                          submitWithPrompt();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setSinglePostPromptEntryUuid(null);
                          setPostPromptText('');
                        }
                      }}
                    />
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[9px] text-[#555]">⌘+Enter • Esc отмена</span>
                      <button
                        className="p-1 rounded transition-colors cursor-pointer"
                        style={{
                          color: postPromptText.trim() ? '#a78bfa' : '#555',
                          backgroundColor: postPromptText.trim() ? 'rgba(139, 92, 246, 0.12)' : 'transparent',
                        }}
                        disabled={!postPromptText.trim()}
                        onClick={(e) => {
                          e.stopPropagation();
                          submitWithPrompt();
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                      </button>
                    </div>
                  </div>
                );
              })() : !selectionStartId ? (
                <>
                  {/* "Копировать" — все entries с копируемым контентом:
                      user (промпт + ответы), compact/isCompactSummary (summary),
                      standalone continued (Context Overflow Recovery bridge text). */}
                  {(contextMenu.entry.type === 'user' || contextMenu.entry.type === 'compact' || contextMenu.entry.type === 'continued') && (
                    <>
                      <button
                        className="w-full text-left px-3 py-2 text-xs text-white hover:bg-blue-600/80 rounded transition-colors cursor-pointer flex items-center gap-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopySingleEntry(contextMenu.entry);
                        }}
                      >
                        <Copy size={12} />
                        {contextMenu.entry.type === 'compact' || contextMenu.entry.isCompactSummary
                          ? 'Копировать compact'
                          : contextMenu.entry.type === 'continued'
                            ? 'Копировать continued'
                            : 'Копировать'}
                      </button>
                      <div className="border-t border-white/10 my-1" />
                    </>
                  )}
                  {summaryToolType && contextMenu.entry.type === 'user' && !contextMenu.entry.isCompactSummary && isEligibleTabTitleEntry(contextMenu.entry) && (
                    <>
                      <button
                        className="w-full text-left px-3 py-2 text-xs text-sky-300 hover:bg-sky-600/20 rounded transition-colors cursor-pointer flex items-center gap-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRefreshTimelineAction(contextMenu.entry);
                        }}
                      >
                        <RefreshCw size={12} className={refreshingActionUuid === contextMenu.entry.uuid ? 'animate-spin' : ''} />
                        Обновить название
                      </button>
                      <div className="border-t border-white/10 my-1" />
                    </>
                  )}
                  {/* Note action carries the note's OWN colour (#0891b2 — the
                      same cyan-blue as the note strip and dot on the timeline),
                      not the violet that now means "rewind by rewriting
                      history". One colour must not stand for two different
                      kinds of action in the same menu. */}
                  <button
                    className="w-full text-left px-3 py-2 text-xs rounded transition-colors cursor-pointer flex items-center gap-2"
                    style={{ color: '#22d3ee' }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(8, 145, 178, 0.2)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddNote(contextMenu.entry);
                    }}
                  >
                    <StickyNote size={12} />
                    {notes[contextMenu.entry.uuid] ? 'Редактировать заметку' : 'Добавить заметку'}
                  </button>
                  {supportsDeleteRangeActions && (contextMenu.entry.type === 'user' || contextMenu.entry.type === 'compact') && (
                    <>
                      <div className="border-t border-white/10 my-1" />
                      {!deleteEntryConfirmMode || historyDeleteUiBlocked ? (
                        <div
                          className="flex rounded overflow-hidden"
                          data-testid="timeline-delete-split-single"
                          aria-disabled={historyDeleteUiBlocked}
                          title={historyDeleteUiBlocked ? historyMutationBlockedMessage : undefined}
                        >
                          <button
                            disabled={historyDeleteUiBlocked}
                            className={`flex-1 text-left px-3 py-2 text-xs transition-colors flex items-center gap-2 ${historyDeleteUiBlocked
                              ? 'text-red-400/35 cursor-not-allowed'
                              : 'text-red-400 hover:bg-red-600/20 cursor-pointer'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteEntryScope('selection');
                              setDeleteEntryConfirmMode(true);
                            }}
                          >
                            <Trash2 size={12} />
                            {!isCodex && contextMenu.entry.type === 'user' && !contextMenu.entry.isCompactSummary
                              ? 'Удалить запрос'
                              : 'Удалить запись'}
                          </button>
                          <Tooltip content={historyDeleteUiBlocked ? historyMutationBlockedMessage : 'Удалить всё выше, включая выбранное'}>
                            <button
                              type="button"
                              disabled={historyDeleteUiBlocked}
                              aria-label="Удалить всё выше, включая выбранное"
                              data-testid="timeline-delete-through-start-single"
                              className={`px-2 py-2 transition-colors border-l border-white/10 flex items-center justify-center ${historyDeleteUiBlocked
                                ? 'text-red-400/25 cursor-not-allowed'
                                : 'text-red-400/70 hover:bg-red-600/30 hover:text-red-300 cursor-pointer'}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteEntryScope('through-start');
                                setDeleteEntryConfirmMode(true);
                              }}
                            >
                              <ArrowUpToLine size={12} />
                            </button>
                          </Tooltip>
                        </div>
                      ) : (() => {
                        const entryIndex = entries.findIndex((entry) => entry.uuid === contextMenu.entry.uuid);
                        if (entryIndex < 0) return null;
                        const crossesClaudeBoundary = !isCodex && (
                          contextMenu.entry.type === 'compact' ||
                          contextMenu.entry.type === 'continued' ||
                          !!contextMenu.entry.isCompactSummary
                        );
                        const deleteSingleClaudePrompt = !isCodex &&
                          contextMenu.entry.type === 'user' &&
                          !contextMenu.entry.isCompactSummary &&
                          deleteEntryScope === 'selection';
                        const deleteThroughStart = deleteEntryScope === 'through-start' || crossesClaudeBoundary;
                        const deleteRange = {
                          startIndex: deleteThroughStart ? 0 : entryIndex,
                          endIndex: entryIndex,
                        };
                        const startUuid = entries[deleteRange.startIndex]?.uuid;
                        const count = deleteRange.endIndex - deleteRange.startIndex + 1;
                        return (
                          <div className="p-2 flex flex-col gap-2" data-testid="timeline-delete-confirm-single">
                            <div className="text-[11px] text-red-300 leading-snug">
                              {deleteSingleClaudePrompt
                                ? <>Удалить только выбранный запрос? <span className="text-red-400/70">Ответ Claude сохранится.</span></>
                                : crossesClaudeBoundary && deleteEntryScope === 'selection'
                                ? <>Это граница истории Claude. Удалить <span className="font-semibold">{count}</span> записей от начала до неё?</>
                                : deleteThroughStart
                                  ? <>Удалить <span className="font-semibold">{count}</span> записей от начала до выбранной?</>
                                  : <>Удалить выбранную запись?</>}
                              {!deleteSingleClaudePrompt && <>{' '}<span className="text-red-400/70">Действие необратимо.</span></>}
                            </div>
                            <div className="flex gap-1.5">
                              <button
                                className="flex-1 px-3 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/5 rounded transition-colors cursor-pointer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteEntryConfirmMode(false);
                                }}
                              >
                                Отмена
                              </button>
                              <button
                                data-testid="timeline-delete-confirm-submit-single"
                                className="flex-1 px-3 py-1.5 text-xs text-white bg-red-600/80 hover:bg-red-600 rounded transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (deleteSingleClaudePrompt) {
                                    void handleDeleteClaudeUserEntry(contextMenu.entry);
                                  } else if (startUuid) {
                                    void executeDeleteRange(deleteRange, startUuid, contextMenu.entry.uuid);
                                  }
                                }}
                              >
                                <Trash2 size={12} />
                                Удалить
                              </button>
                            </div>
                          </div>
                        );
                      })()}
                    </>
                  )}
                  {/* Two DIFFERENT rewinds, separated by kind and by colour.
                      Amber = native: the app drives the agent's own /rewind, the
                      transcript on disk is untouched. Violet = rewrite: the span
                      is removed from the history file and replaced by one
                      summary. They used to sit in one amber split control where
                      the right zone silently ran Gemini and pasted the result
                      with no review window — the same operation as the selection
                      Rewind, but with a different colour, name and behaviour. */}
                  {(() => {
                    const rewindAvailability = getRewindRequestState(contextMenu.entry);
                    const canStartRewind = rewindAvailability.canStart;
                    const rewindBusyTitle = rewindAvailability.reason || undefined;
                    const nativeAgentSuffix = isCodex ? 'Codex' : isGemini ? 'Gemini' : 'Claude';
                    const nativeLabel = rewindState
                      ? (rewindState.phase === 'preparing'
                        ? 'Preparing...'
                        : rewindState.phase === 'compacting'
                        ? 'Gemini...'
                        : rewindState.phase === 'cancelling'
                        ? 'Cancelling...'
                        : rewindState.phase === 'committing'
                        ? 'Finishing...'
                        : rewindState.phase === 'rewinding'
                        ? 'Rewind...'
                        : rewindState.phase === 'done'
                        ? 'Done'
                        : 'Paste...')
                      : 'Rewind (' + nativeAgentSuffix + ')';
                    // Rewriting history needs a user entry it can actually cut
                    // at; boundary rows are handled by the delete flow above.
                    const canRewriteHistory = supportsEditRangeActions
                      && !historyRewriteUiBlocked
                      && !!sessionId
                      && contextMenu.entry.type === 'user'
                      && !contextMenu.entry.isCompactSummary;
                    return (
                      <>
                        <div className="border-t border-white/10 my-1" />
                        <Tooltip content={rewindBusyTitle || ('Нативный откат внутри ' + nativeAgentSuffix + ' — история на диске не меняется')}>
                          <button
                            data-testid="timeline-rewind-native-single"
                            className={`w-full text-left px-3 py-2 text-xs rounded transition-colors flex items-center gap-2 ${canStartRewind ? 'text-amber-400 hover:bg-amber-600/20 cursor-pointer' : 'text-white/20 cursor-not-allowed'}`}
                            disabled={!canStartRewind}
                            title={rewindBusyTitle}
                            onClick={(e) => {
                              e.stopPropagation();
                              requestRewind(contextMenu.entry, 'native', 'timeline-menu');
                            }}
                          >
                            <Repeat2 size={12} />
                            {nativeLabel}
                          </button>
                        </Tooltip>
                        {canRewriteHistory && (
                          // Same three zones as the selection Rewind: summary +
                          // window, own instruction first, empty window.
                          <div className="flex rounded overflow-hidden" data-testid="timeline-rewind-rewrite-single">
                            <Tooltip content="Откат переписыванием истории: диапазон до конца заменится одной сводкой">
                              <button
                                className="flex-1 text-left px-3 py-2 text-xs text-violet-400 hover:bg-violet-600/20 transition-colors cursor-pointer flex items-center gap-2"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestHistoryRewrite(contextMenu.entry);
                                }}
                              >
                                <Repeat2 size={12} />
                                Rewind
                              </button>
                            </Tooltip>
                            <Tooltip content="Добавить инструкцию к промпту">
                              <button
                                data-testid="timeline-rewind-rewrite-prompt-single"
                                className="px-2 py-2 text-xs text-violet-400/60 hover:bg-violet-600/30 hover:text-violet-300 transition-colors cursor-pointer border-l border-white/10"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSinglePostPromptEntryUuid(contextMenu.entry.uuid);
                                  setPostPromptText('');
                                  setTimeout(() => postPromptRef.current?.focus(), 50);
                                }}
                              >
                                ▶
                              </button>
                            </Tooltip>
                            <Tooltip content="Открыть пустой чат (без Gemini)">
                              <button
                                data-testid="timeline-rewind-rewrite-empty-single"
                                className="px-2 py-2 text-xs text-violet-400/60 hover:bg-violet-600/30 hover:text-violet-300 transition-colors cursor-pointer border-l border-white/10 flex items-center justify-center"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestHistoryRewrite(contextMenu.entry, { openEmptyWindow: true });
                                }}
                              >
                                <Pencil size={11} />
                              </button>
                            </Tooltip>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </>
              ) : (
                <button
                  className="w-full text-left px-3 py-2 text-xs text-amber-400 hover:bg-red-600/20 rounded transition-colors cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    selectionStartIdRef.current = null;
                    setSelectionStartId(null);
                    setRangeActionMenu(null);
                    setContextMenu(null);
                  }}
                >
                  Отменить выделение
                </button>
              )}
            </div>
            <HoverBridgeDebug menuRef={contextMenuRef} containerRef={containerRef} />
          </TooltipPortal>
        )}

        {/* ──── RANGE ACTION MENU PORTAL (Copy/Edit/Delete after range selection; inline delete-confirm + post-prompt textarea) ──── */}
        {/* Range Action Menu — appears after selecting range (double-click start + click end) */}
        {isVisible && rangeActionMenu && (
          <TooltipPortal>
            <div
              ref={rangeActionMenuRef}
              onMouseLeave={(e) => {
                // Don't close while user is hovering the breakdown popover — it lives
                // outside this div in a sibling portal, so MouseLeave fires when cursor
                // crosses the gap. Geometric hit-test against the popover rect keeps
                // the menu alive as long as the cursor is within either node.
                if (breakdownOpen && breakdownPopoverRef.current) {
                  const r = breakdownPopoverRef.current.getBoundingClientRect();
                  if (e.clientX >= r.left && e.clientX <= r.right &&
                      e.clientY >= r.top && e.clientY <= r.bottom) {
                    return;
                  }
                }
                if (!postPromptMode && !deleteConfirmMode) {
                  setRangeActionMenu(null);
                  selectionStartIdRef.current = null;
                  setSelectionStartId(null);
                }
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                // Right-anchor: same formula as note tooltip / context menu — popup hugs Timeline's
                // left edge regardless of where range selection ended. Previous left-based math
                // (containerRect.left - POPUP_W - 12) drifted when Timeline was at the right edge
                // of a wide viewport, putting the popup mid-terminal.
                right: `${popupRightPx}px`,
                top: rangeActionMenu.y,
                backgroundColor: '#1a1a1a',
                border: `1px solid ${deleteConfirmMode ? '#ef4444' : postPromptMode ? '#ec4899' : '#333'}`,
                borderRadius: '6px',
                padding: '4px',
                zIndex: 10020,
                minWidth: deleteConfirmMode ? '260px' : postPromptMode ? '320px' : '180px',
                maxWidth: postPromptMode ? '400px' : undefined,
                boxShadow: deleteConfirmMode
                  ? '0 4px 20px rgba(239, 68, 68, 0.18)'
                  : postPromptMode
                    ? '0 4px 20px rgba(236, 72, 153, 0.15)'
                    : '0 4px 16px rgba(0,0,0,0.6)',
                transition: 'min-width 0.15s, border-color 0.15s, box-shadow 0.15s',
              }}
            >
              {deleteConfirmMode ? (() => {
                const crossesClaudeBoundary = !isCodex && rangeActionMenu.crossesBoundary;
                const deleteThroughStart = deleteRangeScope === 'through-start' || crossesClaudeBoundary;
                const effRange = deleteThroughStart
                  ? { startIndex: 0, endIndex: rangeActionMenu.range.endIndex }
                  : rangeActionMenu.range;
                const effStartUuid = deleteThroughStart
                  ? entries[0].uuid
                  : rangeActionMenu.startUuid;
                const effCount = effRange.endIndex - effRange.startIndex + 1;
                return (
                <div className="p-2 flex flex-col gap-2" data-testid="timeline-delete-confirm-range">
                  <div className="text-[11px] text-red-300 leading-snug">
                    {crossesClaudeBoundary && deleteRangeScope === 'selection'
                      ? <>В выделении граница истории Claude.<br/>Удалить <span className="font-semibold">{effCount}</span> записей от начала до выбранной?</>
                      : deleteThroughStart
                        ? <>Удалить <span className="font-semibold">{effCount}</span> записей от начала до выбранной?</>
                        : <>Удалить <span className="font-semibold">{effCount}</span> выбранных записей?</>}
                    {' '}<span className="text-red-400/70">Действие необратимо.</span>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      className="flex-1 px-3 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/5 rounded transition-colors cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteConfirmMode(false);
                      }}
                    >
                      Отмена
                    </button>
                    <button
                      data-testid="timeline-delete-confirm-submit-range"
                      className="flex-1 px-3 py-1.5 text-xs text-white bg-red-600/80 hover:bg-red-600 rounded transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                      onClick={(e) => {
                        e.stopPropagation();
                        void executeDeleteRange(effRange, effStartUuid, rangeActionMenu.endUuid);
                      }}
                    >
                      <Trash2 size={12} />
                      Удалить
                    </button>
                  </div>
                </div>
                );
              })() : !postPromptMode ? (
                <>
                  {/* Token summary for selected range. ↑ = max upper bound from backend
                      estimate (all toggles ON); fall back to legacy heuristic for Gemini
                      or while estimate is loading. Hover ↑ chip → breakdown popover. */}
                  {(() => {
                    const { startIndex, endIndex } = rangeActionMenu.range;
                    let upFallback = 0, downFallback = 0;
                    for (let i = startIndex; i <= endIndex && i < entries.length; i++) {
                      upFallback += Math.ceil(entries[i].content.length / 3.5);
                      downFallback += (entries[i].responseTokens || 0);
                    }
                    const upTotal = tokenEstimate?.total ?? upFallback;
                    const downTotal = tokenEstimate?.downTotal ?? downFallback;
                    const haveBreakdown = supportsClaudeTimelineActions && tokenEstimate != null;
                    return (upTotal > 0) ? (
                      <div
                        ref={tokenChipRef}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] border-b border-white/5"
                        onMouseEnter={() => { if (haveBreakdown) setBreakdownOpen(true); }}
                        style={{
                          color: '#e8a955',
                          cursor: haveBreakdown ? 'help' : 'default',
                          textDecoration: haveBreakdown ? 'underline dotted rgba(232,169,85,0.4)' : 'none',
                          textUnderlineOffset: '2px',
                        }}
                      >
                        <Zap size={10} />
                        <span>{formatTokenCount(upTotal)}</span>
                      </div>
                    ) : null;
                  })()}
                  <button
                    className="w-full text-left px-3 py-2 text-xs text-white hover:bg-blue-600/80 rounded transition-colors cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      executeRangeAction('copy', rangeActionMenu.range, rangeActionMenu.startUuid, rangeActionMenu.endUuid);
                    }}
                  >
                    Копировать ({rangeActionMenu.range.endIndex - rangeActionMenu.range.startIndex + 1})
                  </button>
                  {supportsEditRangeActions && !historyRewriteUiBlocked && (
                    // Same action as the single-point violet Rewind — history is
                    // rewritten and the removed range is replaced by one summary.
                    // Only the boundaries differ (selection instead of one click),
                    // so it must not carry a different name: "Редактировать" read
                    // as a fourth, unrelated operation.
                    <div className="flex rounded overflow-hidden" data-testid="timeline-rewind-split-range">
                      <button
                        className="flex-1 text-left px-3 py-2 text-xs text-violet-400 hover:bg-violet-600/20 transition-colors cursor-pointer flex items-center gap-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          executeRangeAction('edit', rangeActionMenu.range, rangeActionMenu.startUuid, rangeActionMenu.endUuid);
                        }}
                      >
                        <Repeat2 size={12} />
                        Rewind
                      </button>
                      <Tooltip content="Добавить инструкцию к промпту">
                      <button
                        className="px-2 py-2 text-xs text-violet-400/60 hover:bg-violet-600/30 hover:text-violet-300 transition-colors cursor-pointer border-l border-white/10"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPostPromptMode(true);
                          setPostPromptText('');
                          setTimeout(() => postPromptRef.current?.focus(), 50);
                        }}
                      >
                        ▶
                      </button>
                      </Tooltip>
                      <Tooltip content="Открыть пустой чат (без Gemini)">
                      <button
                        className="px-2 py-2 text-xs text-violet-400/60 hover:bg-violet-600/30 hover:text-violet-300 transition-colors cursor-pointer border-l border-white/10 flex items-center justify-center"
                        onClick={(e) => {
                          e.stopPropagation();
                          const { range, startUuid, endUuid } = rangeActionMenu;
                          void openEditRangeWithoutSummary(range, startUuid, endUuid);
                        }}
                      >
                        <Pencil size={11} />
                      </button>
                      </Tooltip>
                    </div>
                  )}
                  {supportsDeleteRangeActions && (
                    <div
                      className="flex rounded overflow-hidden"
                      data-testid="timeline-delete-split-range"
                      aria-disabled={historyDeleteUiBlocked}
                      title={historyDeleteUiBlocked ? historyMutationBlockedMessage : undefined}
                    >
                      <button
                        disabled={historyDeleteUiBlocked}
                        className={`flex-1 text-left px-3 py-2 text-xs transition-colors flex items-center gap-2 ${historyDeleteUiBlocked
                          ? 'text-red-400/35 cursor-not-allowed'
                          : 'text-red-400 hover:bg-red-600/20 cursor-pointer'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteRangeScope('selection');
                          setDeleteConfirmMode(true);
                        }}
                      >
                        <Trash2 size={12} />
                        Удалить выбранное ({rangeActionMenu.range.endIndex - rangeActionMenu.range.startIndex + 1})
                      </button>
                      <Tooltip content={historyDeleteUiBlocked ? historyMutationBlockedMessage : 'Удалить всё выше, включая выбранное'}>
                        <button
                          type="button"
                          disabled={historyDeleteUiBlocked}
                          aria-label="Удалить всё выше, включая выбранное"
                          data-testid="timeline-delete-through-start-range"
                          className={`px-2 py-2 transition-colors border-l border-white/10 flex items-center justify-center ${historyDeleteUiBlocked
                            ? 'text-red-400/25 cursor-not-allowed'
                            : 'text-red-400/70 hover:bg-red-600/30 hover:text-red-300 cursor-pointer'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteRangeScope('through-start');
                            setDeleteConfirmMode(true);
                          }}
                        >
                          <ArrowUpToLine size={12} />
                        </button>
                      </Tooltip>
                    </div>
                  )}
                </>
              ) : (
                <div className="p-1">
                  <textarea
                    ref={postPromptRef}
                    value={postPromptText}
                    onChange={(e) => setPostPromptText(e.target.value)}
                    placeholder="Дополнительная инструкция для Gemini..."
                    className="w-full bg-[#252525] border border-[#444] rounded px-2 py-1.5 text-[11px] text-white/90 font-mono resize-none focus:outline-none focus:border-pink-500/50 placeholder:text-[#555]"
                    style={{ minHeight: '28px', maxHeight: '110px', lineHeight: '1.4' }}
                    rows={1}
                    onInput={(e) => {
                      const el = e.currentTarget;
                      el.style.height = 'auto';
                      el.style.height = Math.min(el.scrollHeight, 110) + 'px';
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.metaKey && postPromptText.trim()) {
                        e.preventDefault();
                        const prompt = postPromptText.trim();
                        setPostPromptMode(false);
                        setPostPromptText('');
                        executeRangeAction('edit', rangeActionMenu.range, rangeActionMenu.startUuid, rangeActionMenu.endUuid, prompt);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setPostPromptMode(false);
                        setPostPromptText('');
                      }
                    }}
                  />
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[9px] text-[#555]">⌘+Enter • Esc отмена</span>
                    <button
                      className="p-1 rounded transition-colors cursor-pointer"
                      style={{
                        color: postPromptText.trim() ? '#ec4899' : '#555',
                        backgroundColor: postPromptText.trim() ? 'rgba(236, 72, 153, 0.1)' : 'transparent',
                      }}
                      disabled={!postPromptText.trim()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!postPromptText.trim()) return;
                        const prompt = postPromptText.trim();
                        setPostPromptMode(false);
                        setPostPromptText('');
                        executeRangeAction('edit', rangeActionMenu.range, rangeActionMenu.startUuid, rangeActionMenu.endUuid, prompt);
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </TooltipPortal>
        )}

        {/* ──── RANGE TOKEN BREAKDOWN POPOVER (hover ↑ chip in rangeActionMenu) ──── */}
        {/* Hovers below (or flipped above) the action menu's ↑ chip, shows per-category
            token estimate for the selected range. Same styling as note tooltip: same
            border-radius, same background, same border. Left edge stays glued to the
            action menu (right-anchored via popupRightPx) so the popover hangs visually
            from it. Flip-up logic from useLayoutEffect above kicks in near viewport bottom. */}
        {isVisible && rangeActionMenu && breakdownOpen && tokenEstimate && (() => {
          const chipEl = tokenChipRef.current;
          if (!chipEl) return null;
          const chipRect = chipEl.getBoundingClientRect();
          // Anchor to action menu's right edge (same as the menu itself).
          // Bottom-anchored: top: chip.bottom, then padding inside creates the visual gap.
          // Same Invisible Bridge pattern as fact-clipboard-tools.md::CSS-bridge — if we
          // shift the popover by `+4` instead, a 4px dead-zone opens between chip and popover
          // and onMouseLeave from the chip closes the popover before cursor reaches it.
          const top = breakdownFlipUp
            ? chipRect.top
            : chipRect.bottom;
          const transform = breakdownFlipUp ? 'translateY(-100%)' : 'none';
          const paddingTop = breakdownFlipUp ? 0 : 4;
          const paddingBottom = breakdownFlipUp ? 4 : 0;

          // Build category rows. Skip categories with zero tokens — cleaner UI than
          // showing 9 rows where 6 are empty.
          const rows: Array<{ key: string; label: string; value: number }> = [
            { key: 'user', label: 'User', value: tokenEstimate.categories.user },
            { key: 'claudeText', label: 'Claude · answer', value: tokenEstimate.categories.claudeText },
            { key: 'claudeThinking', label: 'Claude · thinking', value: tokenEstimate.categories.claudeThinking },
            { key: 'read', label: 'Read', value: tokenEstimate.categories.read },
            { key: 'edit', label: 'Edit · Write', value: tokenEstimate.categories.edit },
            { key: 'bash', label: 'Bash · shell', value: tokenEstimate.categories.bash },
            { key: 'tools', label: 'MCP · web · прочее', value: tokenEstimate.categories.tools },
            { key: 'subagentResult', label: 'Субагент · result', value: tokenEstimate.categories.subagentResult },
            { key: 'subagentHistory', label: 'Субагент · history', value: tokenEstimate.categories.subagentHistory },
            { key: 'compact', label: 'Compact summary', value: tokenEstimate.categories.compact },
          ].filter(r => r.value > 0);

          return (
            <TooltipPortal>
              <div
                ref={breakdownPopoverRef}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'fixed',
                  right: `${popupRightPx}px`,
                  top,
                  transform,
                  paddingTop,
                  paddingBottom,
                  zIndex: 10025,
                  pointerEvents: 'auto',
                }}
              >
                <div
                  style={{
                    backgroundColor: '#1a1a1a',
                    border: '1px solid #333',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    minWidth: '180px',
                    maxWidth: '260px',
                    // minHeight стабилизирует popover при switch JSONL→API.
                    // Без неё API-mode (3-4 строки) короче JSONL (10 строк) → попап
                    // схлопывается, нижний край уползает выше курсора, mouseleave
                    // выстреливает и popover закрывается до того как юзер успел
                    // нажать. Юзер: «когда я тыкаю на вторую вкладку, у меня
                    // меняется размер, и мгновенно это окно закрывается».
                    minHeight: '180px',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                  }}
                >
                  {renderBreakdownBody(tokenEstimate, rows)}
                </div>
              </div>
            </TooltipPortal>
          );
        })()}

        {/* ──── SINGLE-ENTRY TOKEN BREAKDOWN POPOVER (hover ↑ chip in Cmd+hover tooltip) ──── */}
        {/* Same content shape as the range popover, but anchored to the chip inside the
            Cmd+hover entry tooltip (not the range action menu). Positioned via the chip's
            getBoundingClientRect() since the chip lives in a sibling portal — flips up
            near viewport bottom. Stays open while cursor is over chip OR popover. */}
        {isVisible && singleBreakdownOpen && singleChipEl && (() => {
          const codexEntry = singleTokenUuid
            ? entries.find(e => e.uuid === singleTokenUuid && hasCodexBreakdown(e))
            : null;
          if (!singleTokenEstimate && !codexEntry) return null;
          const chipRect = singleChipEl.getBoundingClientRect();
          const top = singleBreakdownFlipUp ? chipRect.top : chipRect.bottom;
          const transform = singleBreakdownFlipUp ? 'translateY(-100%)' : 'none';
          const paddingTop = singleBreakdownFlipUp ? 0 : 4;
          const paddingBottom = singleBreakdownFlipUp ? 4 : 0;

          const rows: Array<{ key: string; label: string; value: number }> = singleTokenEstimate ? [
            { key: 'user', label: 'User', value: singleTokenEstimate.categories.user },
            { key: 'claudeText', label: 'Claude · answer', value: singleTokenEstimate.categories.claudeText },
            { key: 'claudeThinking', label: 'Claude · thinking', value: singleTokenEstimate.categories.claudeThinking },
            { key: 'read', label: 'Read', value: singleTokenEstimate.categories.read },
            { key: 'edit', label: 'Edit · Write', value: singleTokenEstimate.categories.edit },
            { key: 'bash', label: 'Bash · shell', value: singleTokenEstimate.categories.bash },
            { key: 'tools', label: 'MCP · web · прочее', value: singleTokenEstimate.categories.tools },
            { key: 'subagentResult', label: 'Субагент · result', value: singleTokenEstimate.categories.subagentResult },
            { key: 'subagentHistory', label: 'Субагент · history', value: singleTokenEstimate.categories.subagentHistory },
            { key: 'compact', label: 'Compact summary', value: singleTokenEstimate.categories.compact },
          ].filter(r => r.value > 0) : [];

          // Anchor: left edge of the chip itself (entry tooltip lives next to Timeline,
          // so we lean against its left side too; no popupRightPx because chip is not
          // inside the range-action menu).
          return (
            <TooltipPortal>
              <div
                ref={singleBreakdownPopoverRef}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'fixed',
                  left: chipRect.left,
                  top,
                  transform,
                  paddingTop,
                  paddingBottom,
                  zIndex: 10025,
                  pointerEvents: 'auto',
                }}
              >
                <div
                  style={{
                    backgroundColor: '#1a1a1a',
                    border: '1px solid #333',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    minWidth: '180px',
                    maxWidth: '260px',
                    minHeight: '180px',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                  }}
                >
                  {codexEntry ? renderCodexBreakdownBody(codexEntry) : renderBreakdownBody(singleTokenEstimate!, rows)}
                </div>
              </div>
            </TooltipPortal>
          );
        })()}

        {/* ──── FORK-MARKER TOOLTIP PORTAL (blue fork stripe → source session + delete-marker button) ──── */}
        {/* Fork Marker Tooltip Portal */}
        {isVisible && activeForkMarkerIndex !== null && activeForkMarker && forkTooltipPos && (
          <TooltipPortal>
            <div
              ref={forkTooltipRef}
              data-cmd-hover-popover
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={() => { isMouseInForkTooltipRef.current = true; }}
              onMouseLeave={() => {
                if (freezeCmdPopups || isLockedTooltip) return;
                isMouseInForkTooltipRef.current = false;
                setActiveForkMarkerIndex(null);
                setHoveredForkMarkerIndex(null);
              }}
              style={{
                position: 'fixed',
                right: `${popupRightPx}px`,
                top: `${forkTooltipPos.wTop}px`,
                height: `${forkTooltipPos.wH}px`,
                zIndex: 10002,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: debugHoverBridges ? 'rgba(239, 68, 68, 0.30)' : undefined,
                outline: debugHoverBridges ? '1px dashed rgba(239, 68, 68, 0.8)' : undefined,
              }}
            >
              <div
                style={{
                  marginTop: `${forkTooltipPos.offset}px`,
                  outline: 'none',
                  backgroundColor: 'rgba(25, 25, 25, 0.98)',
                  backdropFilter: 'blur(12px)',
                  border: isLockedTooltip ? '1px solid #fff' : '1px solid rgba(59, 130, 246, 0.3)',
                  borderRadius: '6px 0 0 6px',
                  padding: '8px 12px',
                  fontSize: '12px',
                  color: 'white',
                  minWidth: '180px',
                  boxShadow: '-8px 8px 30px rgba(59,130,246,0.12), -2px 2px 8px rgba(59,130,246,0.08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                }}
              >
                <div className="text-[10px] text-blue-300/80">
                  Fork от <span className="text-blue-200 font-mono">{activeForkMarker.source_session_id?.slice(0, 8)}</span>
                </div>
                <button
                  className="text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded px-1.5 py-0.5 transition-colors self-start"
                  onClick={async (e) => {
                    e.stopPropagation();
                    await ipcRenderer.invoke('timeline:delete-fork-marker', {
                      sourceSessionId: activeForkMarker.source_session_id,
                      forkSessionId: activeForkMarker.fork_session_id,
                    });
                    setForkMarkers(prev => prev.map(m =>
                      m.source_session_id === activeForkMarker.source_session_id &&
                      m.fork_session_id === activeForkMarker.fork_session_id
                        ? { ...m, hidden: true }
                        : m
                    ));
                    setActiveForkMarkerIndex(null);
                    setHoveredForkMarkerIndex(null);
                  }}
                >
                  Удалить маркер
                </button>
              </div>
            </div>
          </TooltipPortal>
        )}

        {/* ──── NOTE TOOLTIP PORTAL (purple note tooltip with edit/move/delete + position selector) ──── */}
        {/* Note Tooltip Portal */}
        {isVisible && activeNoteIndex !== null && activeNoteEntry && noteTooltipPos && (
          <TooltipPortal>
            <div
              ref={noteTooltipRef}
              data-cmd-hover-popover
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={() => { isMouseInNoteTooltipRef.current = true; }}
              onMouseLeave={(e) => { if (freezeCmdPopups || isLockedTooltip) return; isMouseInNoteTooltipRef.current = false; handleMouseLeaveNoteTooltip(); }}
              style={{
                position: 'fixed',
                right: `${popupRightPx}px`,
                top: `${noteTooltipPos.wTop}px`,
                height: `${noteTooltipPos.wH}px`,
                zIndex: 10002,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: debugHoverBridges ? 'rgba(239, 68, 68, 0.30)' : undefined,
                outline: debugHoverBridges ? '1px dashed rgba(239, 68, 68, 0.8)' : undefined,
              }}
            >
              <div
                style={{
                  marginTop: `${noteTooltipPos.offset}px`,
                  outline: 'none',
                  backgroundColor: 'rgba(25, 25, 25, 0.98)',
                  backdropFilter: 'blur(12px)',
                  border: isLockedTooltip ? '1px solid #fff' : '1px solid rgba(34, 211, 238, 0.3)',
                  borderRadius: '6px 0 0 6px',
                  padding: '10px 14px',
                  fontSize: '12px',
                  color: 'white',
                  minWidth: '220px',
                  maxWidth: '300px',
                  boxShadow: '-8px 8px 30px rgba(168,85,247,0.12), -2px 2px 8px rgba(168,85,247,0.08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                {isNoteEditing ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-purple-400 font-medium text-[11px]">Заметка</span>
                      {(() => {
                        const hasExisting = !!notes[activeNoteEntry.uuid];
                        const savedPos = notePositions[activeNoteEntry.uuid] || 'before';
                        // For existing notes that aren't on the dot → show ↑/↓ arrows that reposition the note
                        if (hasExisting && savedPos !== 'dot') {
                          const idx = entries.findIndex(e => e.uuid === activeNoteEntry.uuid);
                          // Compute whether arrows are enabled (mirrors moveNote search logic)
                          const canUp = (() => {
                            if (savedPos === 'after') return true;
                            for (let i = idx - 1; i >= 0; i--) {
                              if (entries[i].uuid !== activeNoteEntry.uuid && !notes[entries[i].uuid]) return true;
                            }
                            return false;
                          })();
                          const canDown = (() => {
                            if (savedPos === 'before') return true;
                            for (let i = idx + 1; i < entries.length; i++) {
                              if (entries[i].uuid !== activeNoteEntry.uuid && !notes[entries[i].uuid]) return true;
                            }
                            return false;
                          })();
                          return (
                            <div className="flex items-center gap-0.5 bg-white/5 rounded p-0.5">
                              <Tooltip content="Переместить выше">
                              <button
                                onClick={(e) => { e.stopPropagation(); if (canUp) moveNote(activeNoteEntry, -1); }}
                                disabled={!canUp}
                                className="p-1 rounded transition-colors cursor-pointer disabled:cursor-not-allowed"
                                style={{
                                  color: canUp ? '#67e8f9' : 'rgba(255,255,255,0.15)',
                                }}
                              >
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M7 11V3M3.5 6.5L7 3l3.5 3.5"/>
                                </svg>
                              </button>
                              </Tooltip>
                              <Tooltip content="Переместить ниже">
                              <button
                                onClick={(e) => { e.stopPropagation(); if (canDown) moveNote(activeNoteEntry, 1); }}
                                disabled={!canDown}
                                className="p-1 rounded transition-colors cursor-pointer disabled:cursor-not-allowed"
                                style={{
                                  color: canDown ? '#67e8f9' : 'rgba(255,255,255,0.15)',
                                }}
                              >
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M7 3v8M3.5 7.5L7 11l3.5-3.5"/>
                                </svg>
                              </button>
                              </Tooltip>
                            </div>
                          );
                        }
                        // New note OR existing dot-note → keep 3-button position selector
                        return (
                          <div className="flex items-center gap-0.5 bg-white/5 rounded p-0.5">
                            {([
                              { value: 'before' as const, title: 'До точки', icon: (
                                <svg width="14" height="14" viewBox="0 0 14 14">
                                  <rect x="4" y="2" width="6" height="2" rx="0.5" fill="currentColor" />
                                  <circle cx="7" cy="9" r="2.5" fill="currentColor" opacity="0.4" />
                                </svg>
                              )},
                              { value: 'dot' as const, title: 'На точке', icon: (
                                <svg width="14" height="14" viewBox="0 0 14 14">
                                  <circle cx="7" cy="7" r="3" fill="currentColor" />
                                </svg>
                              )},
                              { value: 'after' as const, title: 'После точки', icon: (
                                <svg width="14" height="14" viewBox="0 0 14 14">
                                  <circle cx="7" cy="5" r="2.5" fill="currentColor" opacity="0.4" />
                                  <rect x="4" y="10" width="6" height="2" rx="0.5" fill="currentColor" />
                                </svg>
                              )},
                            ]).map(opt => (
                              <Tooltip key={opt.value} content={opt.title}>
                              <button
                                onClick={(e) => { e.stopPropagation(); setNoteEditPosition(opt.value); }}
                                className="p-1 rounded transition-colors cursor-pointer"
                                style={{
                                  color: noteEditPosition === opt.value ? '#67e8f9' : 'rgba(255,255,255,0.3)',
                                  backgroundColor: noteEditPosition === opt.value ? 'rgba(34, 211, 238, 0.15)' : 'transparent',
                                }}
                              >
                                {opt.icon}
                              </button>
                              </Tooltip>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                    <textarea
                      ref={noteTextareaRef}
                      value={noteEditText}
                      onChange={(e) => setNoteEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.metaKey) {
                          e.preventDefault();
                          handleSaveNote(activeNoteEntry);
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          if (notes[activeNoteEntry.uuid]) {
                            // Had existing note — cancel edit
                            setIsNoteEditing(false);
                          } else {
                            // Was creating new — close
                            setIsNoteEditing(false);
                            setActiveNoteIndex(null);
                          }
                        }
                      }}
                      className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/90 font-mono resize-none focus:outline-none focus:border-purple-500/50"
                      style={{ minHeight: '60px', maxHeight: '120px' }}
                      placeholder="Введите заметку... (⌘+Enter сохранить)"
                    />
                    <div className="flex justify-between items-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (notes[activeNoteEntry.uuid]) {
                            setIsNoteEditing(false);
                          } else {
                            setIsNoteEditing(false);
                            setActiveNoteIndex(null);
                          }
                        }}
                        className="px-2 py-1 rounded text-[10px] text-white/40 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                      >
                        Отмена
                      </button>
                      <div className="flex gap-1">
                        {notes[activeNoteEntry.uuid] && (
                          <Tooltip content="Удалить заметку">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteNote(activeNoteEntry); }}
                            className="p-1 rounded hover:bg-red-600/20 text-red-400/60 hover:text-red-400 transition-colors cursor-pointer"
                          >
                            <Trash2 size={12} />
                          </button>
                          </Tooltip>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); handleSaveNote(activeNoteEntry); }}
                          className="px-2 py-1 rounded bg-purple-600/30 hover:bg-purple-600/50 text-[10px] text-purple-300 hover:text-white transition-colors cursor-pointer"
                        >
                          Сохранить
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    {/* When note is on dot — show original entry content too */}
                    {(notePositions[activeNoteEntry.uuid] || 'before') === 'dot' && (
                      <div className="text-white/50 leading-snug font-mono text-[11px] line-clamp-2 pb-1 mb-1 border-b border-white/5" style={{ whiteSpace: 'pre-wrap' }}>
                        {truncateText(activeNoteEntry.content, 120)}
                      </div>
                    )}
                    <div className="flex justify-between items-start gap-2">
                      <div className="text-white/80 leading-snug font-mono text-[11px] flex-1" style={{ whiteSpace: 'pre-wrap' }}>
                        {notes[activeNoteEntry.uuid]}
                      </div>
                      <Tooltip content="Редактировать">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEditNote(activeNoteEntry); }}
                        className="p-1.5 rounded hover:bg-white/10 text-purple-400/60 hover:text-purple-300 transition-colors cursor-pointer shrink-0"
                      >
                        <Pencil size={12} />
                      </button>
                      </Tooltip>
                    </div>
                    <div className="flex justify-between items-center pt-1 border-t border-white/5">
                      <span className="text-[10px] text-purple-400/40">Заметка</span>
                      <Tooltip content="Удалить">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteNote(activeNoteEntry); }}
                        className="p-1 rounded hover:bg-red-600/20 text-white/30 hover:text-red-400 transition-colors cursor-pointer"
                      >
                        <Trash2 size={12} />
                      </button>
                      </Tooltip>
                    </div>
                  </>
                )}
              </div>
              {/* CSS Bridge */}
              <div style={{ width: '8px', alignSelf: 'stretch' }} />
            </div>
          </TooltipPortal>
        )}

        {/* ──── INITIAL LOAD (background refreshes keep the existing rows visible) ──── */}
        {isVisible && isLoading && entries.length === 0 && (
          <div
            className="absolute inset-0 z-[70] flex items-center justify-center bg-[#1a1a1a]/90 pointer-events-none"
            role="status"
            aria-live="polite"
            aria-label="Loading timeline"
          >
            <div className={`flex items-center justify-center text-white/65 ${isExpandedLayout ? 'gap-2 px-3 py-2' : ''}`}>
              <RefreshCw size={isExpandedLayout ? 16 : 14} className="animate-spin shrink-0" />
              {isExpandedLayout && (
                <span className="text-[11px] font-medium whitespace-nowrap">Loading timeline…</span>
              )}
            </div>
          </div>
        )}

        {/* ──── SCROLL-TO-BOTTOM ARROW (purple chevron; visibility toggled via ref to avoid re-render) ──── */}
        {/* Scroll-to-bottom arrow — always mounted, visibility toggled via ref (no re-render on scroll) */}
        {isVisible && (
          <ControlHint label="Прокрутить Timeline вниз">
            <button
              type="button"
              ref={arrowRef}
              className="absolute cursor-pointer z-50 flex items-center justify-center"
              onClick={() => {
                if (historyTargetVisible) {
                  // History panel is open — scroll history to bottom instead of timeline
                  window.dispatchEvent(new CustomEvent('history-panel:scroll-to-bottom', { detail: { tabId } }));
                }
                jumpTimelineToBottomAfterLayout();
              }}
              style={{
                display: 'none',
                left: 0,
                right: 0,
                bottom: 0,
                width: '100%',
                height: '26px',
                borderRadius: 0,
                backgroundColor: '#323237',
                border: 'none',
                borderTop: '1px solid rgba(167, 139, 250, 0.3)',
                boxShadow: '0 -2px 8px rgba(0, 0, 0, 0.45)',
                padding: 0,
                appearance: 'none',
                transition: 'none',
              }}
            >
              <ChevronDown size={16} color="#a78bfa" strokeWidth={2.5} />
            </button>
          </ControlHint>
        )}

        {/* ──── CUSTOM SCROLLBAR THUMB (thumbRef — position/height updated via ref by scroll listener) ──── */}
        {/* Custom scroll indicator — always mounted, position updated via ref (no re-render on scroll) */}
        {isVisible && (
          <div
            ref={thumbRef}
            className="absolute pointer-events-none"
            style={{
              display: 'none',
              right: '0px',
              width: '3px',
              backgroundColor: 'rgba(255, 255, 255, 0.4)',
              borderRadius: '1.5px',
              zIndex: 55,
            }}
          />
        )}
      </div>
      </div>
    </>
  );
}

// Parent owner handoff is deferred so History can own the urgent tab-switch
// paint. Memoization is essential here: while the old owner is hidden by the
// lightweight Workspace boundary, identical props must not make this
// hundreds-of-rows component render just to disappear one frame later.
export default React.memo(Timeline);
