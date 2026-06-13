import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Copy, Minimize2, Pencil, Search, Trash2, StickyNote, ChevronDown, Check, Scissors, X, Zap } from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore, type PendingAutoTabTitle } from '../../store/useWorkspaceStore';
import { TAB_TITLE_PROMPT_ID, usePromptsStore } from '../../store/usePromptsStore';
import { generateTabTitleFromPrompt, isEligibleTabTitleEntry, trimTabTitlePrompt } from '../../utils/generateTabTitle';
import { timelineSummaryKey, useTimelineSummaryStore, type TimelineSummaryTool } from '../../store/useTimelineSummaryStore';
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

// True when an entry is NOT a regular user prompt — currently 'compact', 'continued',
// 'docs_edit', 'docs_search'. Used widely to skip non-user entries in nav/copy/visibility.
// If a new attribute-style entry type is ever added, update this ONE place.
function isAttributeEntry(entry: { type?: string }): boolean {
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

// Portal for tooltip to escape overflow:hidden
const TooltipPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return createPortal(children, document.body);
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
  responseTokens?: number;
  responseModel?: string;          // last assistant.message.model for this turn (e.g. 'deepseek-v4-flash', 'claude-opus-4-7')
  responseHasThinking?: boolean;   // any assistant content block of type 'thinking' in this turn
  sourceLine?: number;
}

interface GroupInfo {
  isGroupHeader: boolean;
  isGroupChild: boolean;
  groupId: string;
  groupSize: number;
  agentName: string;
  hasTimeout: boolean;
  startIndex: number; // first entry index in the group
}

interface SessionBoundary {
  childSessionId: string;
  parentSessionId: string;
}

interface TimelineProps {
  tabId: string;
  sessionId: string | null;
  cwd: string;
  isActive?: boolean; // Claude/Gemini is currently running
  isVisible?: boolean; // New prop to control visibility from parent
  isOpen?: boolean; // CMD+] toggle — controls slide in/out
  toolType?: 'claude' | 'gemini' | 'codex'; // Which AI tool this timeline is for
  pinned?: boolean; // When true, expanded Timeline reserves layout width instead of overlaying terminal
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
    cursor = close + 1;
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
    return entries.find((entry, index) => index > boundaryIndex && isEligibleTabTitleEntry(entry));
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
        && isEligibleTabTitleEntry(entry);
    });
  }
  if (forkedFromId || pending.sourceSessionId) return undefined;

  const startedAt = codexSessionMeta?.timestamp ? Date.parse(codexSessionMeta.timestamp) : NaN;
  if (!Number.isFinite(startedAt)) return undefined;
  return entries.find((entry) => {
    const entryAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    return Number.isFinite(entryAt) && entryAt >= startedAt + 1000 && isEligibleTabTitleEntry(entry);
  });
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

// Build grouping map: consecutive sub-agent entries with same taskId/name → collapsed group
function computeGroups(entries: TimelineEntry[]): Map<number, GroupInfo> {
  const groups = new Map<number, GroupInfo>();
  let i = 0;
  let groupCounter = 0;

  while (i < entries.length) {
    const entry = entries[i];
    if (!entry.isSubAgent && !entry.isSubAgentTimeout) {
      i++;
      continue;
    }

    const startIdx = i;
    let j = i + 1;

    // Group ALL consecutive sub-agent entries together (one orchestration round)
    while (j < entries.length && (entries[j].isSubAgent || entries[j].isSubAgentTimeout)) {
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
    const agentName = agentNames.size === 1 ? [...agentNames][0] : (agentNames.size > 1 ? `${agentNames.size} agents` : 'Claude');

    if (size > 1) {
      // First entry is BOTH header and first child
      groups.set(startIdx, {
        isGroupHeader: true,
        isGroupChild: true,
        groupId,
        groupSize: size,
        agentName,
        hasTimeout,
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
let _timelinePollSeq = 0;
const _autoTabTitleAttempted = new Set<string>();

function perfAbsNow(): number {
  return performance.timeOrigin + performance.now();
}

// ════════════════════════════════════════════════════════════
// SECTION: COMPONENT SETUP — props, UIStore subscriptions, state, ref declarations
// ════════════════════════════════════════════════════════════
function Timeline({ tabId, sessionId, cwd, isActive = true, isVisible = true, isOpen = true, toolType = 'claude', pinned = false }: TimelineProps) {
  const isGemini = toolType === 'gemini';
  const isCodex = toolType === 'codex';
  const usesTextSearchAnchors = isGemini || isCodex;
  const supportsClaudeTimelineActions = !isGemini && !isCodex;
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
  const promptSummaryAutoEnabled = promptSummaryGlobalAuto || promptSummaryTabAuto;
  const promptSummaryAutoSince = (() => {
    const candidates = [
      promptSummaryGlobalAuto ? promptSummaryGlobalAutoSince : 0,
      promptSummaryTabAuto ? promptSummaryTabAutoSince : 0,
    ].filter((n) => Number.isFinite(n) && n > 0);
    return candidates.length ? Math.min(...candidates) : 0;
  })();

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

  const [entries, setEntries] = useState<TimelineEntry[]>([]);
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
  const [isExpanded, setIsExpanded] = useState(false);
  const [tooltipCopied, setTooltipCopied] = useState(false);
  // Per-entry collapsed/expanded state for docs blocks in tooltip. Key = entry uuid.
  // Default collapsed (compact one-liner) — click on the line to expand and see full paths/queries.
  const [expandedDocsEdit, setExpandedDocsEdit] = useState<Set<string>>(new Set());
  const [expandedDocsSearch, setExpandedDocsSearch] = useState<Set<string>>(new Set());
  const [selectionStartId, setSelectionStartId] = useState<string | null>(null);
  const selectionStartIdRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, entry: TimelineEntry, source?: 'dot' | 'segment' } | null>(null);
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
  // Cleared by 'history-panel:scrolled-to' event (success) or the safety timeout (4s).
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
  const [rewindState, setRewindState] = useState<{ index: number; phase: 'compacting' | 'rewinding' | 'pasting' | 'done' } | null>(null);

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
  // Range action menu — appears after second click to choose Copy / Edit / Delete
  const [rangeActionMenu, setRangeActionMenu] = useState<{
    x: number; y: number;
    range: { startIndex: number; endIndex: number };
    startUuid: string; endUuid: string;
    crossesBoundary: boolean;  // range hit a compact or plan-mode boundary; popup keeps visual range and only Delete confirm auto-extends to 0
  } | null>(null);
  const [postPromptMode, setPostPromptMode] = useState(false);
  const [postPromptText, setPostPromptText] = useState('');
  const postPromptRef = useRef<HTMLTextAreaElement>(null);
  // Inline confirm for "Удалить историю" inside rangeActionMenu (no side panel)
  const [deleteConfirmMode, setDeleteConfirmMode] = useState(false);
  // Animation state while delete IPC is running (red overlay over the range)
  const [deletingRange, setDeletingRange] = useState<{ startIndex: number; endIndex: number } | null>(null);
  // Inline confirm for "Удалить запрос" inside contextMenu (single user-entry delete)
  const [deleteEntryConfirmMode, setDeleteEntryConfirmMode] = useState(false);
  // effect: contextMenu closes → reset entry-delete confirm (prevents reopening in confirm state)
  useEffect(() => {
    if (!contextMenu) setDeleteEntryConfirmMode(false);
  }, [contextMenu]);
  // effect: rangeActionMenu closes → reset deleteConfirmMode (prevents next popup opening in confirm state)
  useEffect(() => {
    if (!rangeActionMenu) setDeleteConfirmMode(false);
  }, [rangeActionMenu]);

  // Ref to context-menu root so we can measure its rect for the hover-bridge test.
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // Refs to the other two fixed popups so we can re-clamp them post-mount when
  // the cursor was near the bottom of the screen (otherwise their bottom edge
  // slips below the viewport — same issue we fixed for contextMenu).
  const editRangeLoadingMenuRef = useRef<HTMLDivElement>(null);
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

  // Re-clamp the context menu top using the menu's REAL post-render height.
  // The initial position (setContextMenu in openContextMenu) uses a hardcoded
  // `menuHeight` guess (40 or 90 px). That's wrong when the menu has more rows
  // — e.g. note-editor open, or selection-mode buttons, etc — and the bottom
  // edge then slips below the viewport. After mount we measure the real rect
  // and shift `top` up if needed.
  useLayoutEffect(() => {
    if (!contextMenu) return;
    const el = contextMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 10;
    let desired = contextMenu.y;
    if (r.top + r.height > window.innerHeight - margin) {
      desired = window.innerHeight - r.height - margin;
    }
    if (desired < margin) desired = margin;
    if (desired !== contextMenu.y) {
      setContextMenu({ ...contextMenu, y: desired });
    }
    // contextMenu.y intentionally not a dep — would loop.
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
  }, [singleBreakdownOpen, singleTokenEstimate, singleChipEl, breakdownMode]);

  const [rewindPostPromptMode, setRewindPostPromptMode] = useState(false);
  const [rewindPostPromptText, setRewindPostPromptText] = useState('');
  const rewindPostPromptRef = useRef<HTMLTextAreaElement>(null);

  // Phase 2: Collapsible groups
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Phase 3: Tree view (per-tab, persisted in UIStore)
  const treeMode = useUIStore(state => state.timelineTreeModeTabs[tabId] ?? false);
  const setTimelineTreeMode = useUIStore(state => state.setTimelineTreeMode);
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
  const isExpandedLayout = treeMode;
  const effectiveWidth = treeMode ? timelineWidth : 32;
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
  const isHistoryOpen = useUIStore(state => state.historyPanelOpenTabs[tabId] ?? false);
  const setHistoryPanelOpen = useUIStore(state => state.setHistoryPanelOpen);
  const historyVisibleUuids = useUIStore(state => state.historyVisibleUuids[tabId]);
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
  const arrowRef = useRef<HTMLDivElement>(null);

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

  // Index of the chain-break boundary (= youngest entry of pre-orphan tail).
  // Resolved here from uuid → index for downstream useMemos.
  const claudeMemoryBoundaryIndex = useMemo(() => {
    if (!claudeMemoryBoundaryUuid) return -1;
    return entries.findIndex(e => e.uuid === claudeMemoryBoundaryUuid);
  }, [entries, claudeMemoryBoundaryUuid]);
  // Precompute fork snapshot UUID Sets for suppressing inherited plan mode boundaries
  const forkSnapshotSets = useMemo(() =>
    forkMarkers.filter(m => m.entry_uuids && m.entry_uuids.length > 0).map(m => new Set(m.entry_uuids)),
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
      const snap = m.entry_uuids;
      if (!snap || snap.length === 0) { arr.push(-1); continue; }
      const set = new Set(snap);
      let lastIdx = -1;
      for (let i = 0; i < entries.length; i++) {
        if (set.has(entries[i].uuid)) lastIdx = i;
      }
      arr.push(lastIdx);
    }
    return arr;
  }, [forkMarkers, entries]);
  // Count visible nodes (entries minus hidden group children)
  const hasSubAgentGroups = useMemo(() => {
    for (const [, g] of groupMap) {
      if (g.isGroupHeader) return true;
    }
    return false;
  }, [groupMap]);

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

  // effect: activeTooltipIndex changes → reset isExpanded + tooltipCopied (each new tooltip starts collapsed/un-copied)
  useEffect(() => {
    setIsExpanded(false);
    setTooltipCopied(false);
  }, [activeTooltipIndex]);

  useEffect(() => {
    setCompactSummaryCache({});
  }, [sessionId]);

  // Compact summaries are intentionally not carried by get-timeline: Codex
  // replacement_history can be 100k+ chars and Timeline polls every 2s. Fetch
  // the full-history payload only when the compact entry tooltip is actually opened.
  useEffect(() => {
    if (!sessionId || isGemini || activeTooltipIndex === null) return;
    const entry = entries[activeTooltipIndex];
    if (!entry || entry.type !== 'compact') return;
    if (entry.compactSummary) return;
    if (Object.prototype.hasOwnProperty.call(compactSummaryCache, entry.uuid)) return;

    let cancelled = false;
    const channel = isCodex ? 'codex:get-full-history' : 'claude:get-full-history';
    (async () => {
      try {
        const result = await ipcRenderer.invoke(channel, { sessionId, cwd });
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
  }, [isVisible, isHistoryOpen, treeMode, notesPanelWidth]);

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
  useEffect(() => { activeNoteIndexRef.current = activeNoteIndex; }, [activeNoteIndex]);
  useEffect(() => { activeForkMarkerIndexRef.current = activeForkMarkerIndex; }, [activeForkMarkerIndex]);

  // effect: HistoryPanel scrolled-to → clear dot spinner (Cmd+click / open-panel click path).
  useEffect(() => {
    const onScrolledTo = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tabId?: string; uuid?: string; found?: boolean } | undefined;
      if (!detail || detail.tabId !== tabId) return;
      const pending = pendingHistoryScrollRef.current;
      if (!pending || pending.uuid !== detail.uuid) return;
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

  // Load timeline and fork markers when sessionId changes
  const loadTimeline = useCallback(async (reason = 'unknown') => {
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
      setEntries([]);
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

    setIsLoading(true);
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
        if (timelineResult.success) {
          setEntries(timelineResult.entries);
          setSessionBoundaries([]);
          setForkMarkers([]);
          setCodexSessionMeta(null);
          setClaudeMemoryBoundaryUuid(null);
        }
      } else if (isCodex) {
        const timelineResult = await ipcRenderer.invoke('codex:get-timeline', { sessionId, cwd, ...callerContext });
        if (timelineResult.success) {
          setEntries(timelineResult.entries);
          setSessionBoundaries([]);
          setForkMarkers([]);
          setCodexSessionMeta(timelineResult.sessionMeta || null);
          setClaudeMemoryBoundaryUuid(null);
        }
      } else {
        // Claude: load timeline entries and fork markers in parallel
        const [timelineResult, markersResult] = await Promise.all([
          ipcRenderer.invoke('claude:get-timeline', {
            sessionId,
            cwd,
            ...callerContext,
          }),
          ipcRenderer.invoke('claude:get-fork-markers', { sessionId, ...callerContext })
        ]);

        if (timelineResult.success) {
          setEntries(timelineResult.entries);
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
          const all = markersResult.markers || [];
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
      if (notesResult.success) {
        setNotes(notesResult.notes || {});
        setNotePositions(notesResult.positions || {});
      }
      // Load rewind markers (pink dots)
      const markersResult = await ipcRenderer.invoke('timeline:get-rewind-markers', { sessionId, ...callerContext });
      if (markersResult.success && markersResult.markers?.length) {
        setRewindMarkers(new Set(markersResult.markers));
      }
    } catch (error) {
      console.error('[Timeline] Error loading timeline:', error);
    } finally {
      setIsLoading(false);
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
  }, [sessionId, cwd, tabId, isGemini, isCodex]);

  // effect: loadTimeline callback identity changes (sessionId/cwd/tabId/isGemini) → trigger initial timeline load
  useEffect(() => {
    loadTimeline('effect');
  }, [loadTimeline]);

  useEffect(() => {
    if (!summaryToolType || !sessionId) return;
    void loadPromptSummaries(summaryToolType, sessionId);
  }, [summaryToolType, sessionId, loadPromptSummaries]);

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
    for (const entry of entries) {
      if (!entry.uuid || !isEligibleTabTitleEntry(entry)) continue;
      const entryAt = Date.parse(entry.timestamp || '');
      if (promptSummaryAutoSince > 0 && (!Number.isFinite(entryAt) || entryAt < promptSummaryAutoSince - 1000)) continue;
      void generatePromptSummary({
        tabId,
        toolType: summaryToolType,
        sessionId,
        entry,
      });
    }
  }, [entries, promptSummaryAutoEnabled, promptSummaryAutoSince, promptSummaryLoadedSessionKeys, summaryToolType, sessionId, tabId, generatePromptSummary]);

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
        setRewindState(null);
        setCopyingRange(null);
        setCopiedRange(null);
        setSelectionStartId(null);
        selectionStartIdRef.current = null;
        setContextMenu(null);
        setClickedState(null);
        setActiveTooltipIndex(null);
        setHoveredIndex(null);
        setPostPromptMode(false);
        setRewindPostPromptMode(false);
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
  // post-load commit). The 2s poll also changes `entries`, but it always lands AFTER
  // the pending flag was cleared → it never scrolls → manual scroll-up is preserved
  // (see fact-timeline.md::Auto-Scroll при продолжении сессии — "не sticky-scroll").
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

  // effect: first non-empty `entries` commit after arming → jump scroll to bottom (double-rAF survives content-visibility:auto height correction), then disarm so poll updates don't fight manual scroll
  useEffect(() => {
    if (!pendingBottomRef.current || entries.length === 0) return;
    pendingBottomRef.current = false;
    const jump = () => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    requestAnimationFrame(() => { jump(); requestAnimationFrame(jump); });
  }, [entries]);

  // Auto-generate a tab title once the first real user prompt is materialized
  // in the transcript. Uses Timeline entries instead of raw terminal input so
  // service commands and metadata do not become tab names.
  useEffect(() => {
    if (!sessionId || entries.length === 0) return;
    if (toolType !== 'claude' && toolType !== 'codex') return;

    const store = useWorkspaceStore.getState();
    const pendingAutoTitle = store.getPendingAutoTabTitle(tabId, toolType, sessionId);
    if (!pendingAutoTitle) return;

    const attemptKey = `${toolType}:${sessionId}`;
    if (_autoTabTitleAttempted.has(attemptKey)) {
      store.consumePendingAutoTabTitle(tabId, toolType, sessionId);
      return;
    }

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
    if (!store.consumePendingAutoTabTitle(tabId, toolType, sessionId)) {
      console.warn(
        '[Timeline:AutoTabTitle]' +
        ' skip=consume-false' +
        ' tab=' + tabId.slice(-8) +
        ' tool=' + toolType +
        ' session=' + sessionId.slice(0, 8)
      );
      return;
    }

    _autoTabTitleAttempted.add(attemptKey);
    const titleToolType = toolType;
    const titleSessionId = sessionId;
    const titleTabId = tabId;
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
        useWorkspaceStore.getState().autoRenameTab(titleTabId, title, {
          toolType: titleToolType,
          sessionId: titleSessionId,
        });
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
        useWorkspaceStore.getState().setTabTitleNaming(titleTabId, false);
      }
    })();
  }, [entries, sessionId, tabId, toolType, forkMarkers, forkMarkerLastSnapIndex, codexSessionMeta]);

  // effect: sessionId/loadTimeline/isVisible + document.visibilitychange → 2s setInterval(loadTimeline) (paused while tab hidden; PERF: avoids IPC round-trips in background — Timeline:PollPaused/Resumed logs)
  useEffect(() => {
    if (!sessionId || !isVisible) {
      console.warn(
        '[Timeline:PollInactive]' +
        ' inst=' + timelineInstanceIdRef.current +
        ' tab=' + tabId.slice(-8) +
        ' session=' + (sessionId ? sessionId.substring(0, 8) : 'none') +
        ' reason=' + (!sessionId ? 'no-session' : 'isVisible-false') +
        ' visible=' + isVisible +
        ' doc=' + document.visibilityState +
        ' abs=' + perfAbsNow().toFixed(1)
      );
      return;
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    let intervalId: number | null = null;
    const start = () => {
      if (interval) return;
      intervalId = ++_timelinePollSeq;
      console.warn(
        '[Timeline:PollStart]' +
        ' inst=' + timelineInstanceIdRef.current +
        ' interval=' + intervalId +
        ' tab=' + tabId.slice(-8) +
        ' session=' + sessionId.substring(0, 8) +
        ' visible=' + isVisibleRef.current +
        ' doc=' + document.visibilityState +
        ' abs=' + perfAbsNow().toFixed(1)
      );
      interval = setInterval(() => {
        console.warn(
          '[Timeline:PollTick]' +
          ' inst=' + timelineInstanceIdRef.current +
          ' interval=' + (intervalId ?? 'none') +
          ' tab=' + tabId.slice(-8) +
          ' session=' + sessionId.substring(0, 8) +
          ' visible=' + isVisibleRef.current +
          ' doc=' + document.visibilityState +
          ' abs=' + perfAbsNow().toFixed(1)
        );
        loadTimeline('poll');
      }, 2000);
    };
    const stop = (reason: string) => {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
      console.warn(
        '[Timeline:PollStop]' +
        ' inst=' + timelineInstanceIdRef.current +
        ' interval=' + (intervalId ?? 'none') +
        ' tab=' + tabId.slice(-8) +
        ' session=' + sessionId.substring(0, 8) +
        ' reason=' + reason +
        ' visible=' + isVisibleRef.current +
        ' doc=' + document.visibilityState +
        ' abs=' + perfAbsNow().toFixed(1)
      );
      console.warn(`[Timeline:PollPaused] sessionId=${sessionId.substring(0,8)} reason=${reason}`);
    };

    if (document.visibilityState === 'visible') {
      start();
    } else {
      console.warn(`[Timeline:PollPaused] sessionId=${sessionId.substring(0,8)} reason=hidden-on-mount`);
    }

    const onVis = () => {
      if (document.visibilityState === 'visible') {
        console.warn(`[Timeline:PollResumed] sessionId=${sessionId.substring(0,8)}`);
        loadTimeline('visibility-resume'); // refresh immediately so user sees fresh data on return
        start();
      } else {
        stop('visibility-hidden');
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      stop('effect-cleanup');
    };
  }, [sessionId, loadTimeline, isVisible]);

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
    if (isHistoryOpen || isSdkTab) {
      setUnreachableIndices(prev => prev.size === 0 ? prev : new Set());
      setResponseOnlyIndices(prev => prev.size === 0 ? prev : new Set());
      // Pre-compact entries are reachable elsewhere (full history is rendered);
      // clear the boundary so `clickIsOldHistory` doesn't gate clicks.
      setLastBoundaryIndex(-1);

      const uuidSet = historyVisibleUuids ? new Set(historyVisibleUuids) : new Set<string>();
      const newVisible = new Set<number>();
      entries.forEach((entry, index) => {
        if (uuidSet.has(entry.uuid)) newVisible.add(index);
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
          lastBoundaryIdx = i;
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

      // Inherit unreachable for compact/continued/plan/docs_edit/docs_search entries from next regular entry
      entries.forEach((entry, index) => {
        if (entry.type !== 'compact' && entry.type !== 'continued' && entry.type !== 'docs_edit' && entry.type !== 'docs_search' && !entry.isPlan) return;
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
  }, [tabId, entries, isVisible, isGemini, isCodex, usesTextSearchAnchors, isHistoryOpen, isSdkTab, historyVisibleUuids, toolType]);

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

  // ════════════════════════════════════════════════════════════
  // SECTION: CLICK DISPATCH — single/double/right-click + range-selection start; routes to terminal scroll, history-panel scroll, or range action menu
  // ════════════════════════════════════════════════════════════

  const handleEntryClick = (entry: TimelineEntry, e?: React.MouseEvent) => {
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
        const crossesBoundary = sliced.some(en => en.type === 'compact' || en.type === 'continued');

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

    // Cmd+Click (macOS) / Ctrl+Click (other) → принудительно открыть History Panel и
    // проскроллить к этой записи. Обычный клик скроллит в терминале. Mental model
    // пользователя: «обычный клик → видеть промпт в терминале; Cmd+клик → видеть его
    // в полной истории». Если панель уже открыта — поведение совпадает с обычным
    // кликом при isHistoryOpen (scroll-in-history), Cmd просто гарантирует открытие.
    if (e && (e.metaKey || e.ctrlKey)) {
      if (!isHistoryOpen) setHistoryPanelOpen(tabId, true);
      setHistoryScrollToUuid(entry.uuid);
      // Spinner on dot — HistoryPanel emits 'history-panel:scrolled-to' when done.
      // Safety: clear after 4s in case the panel never mounts (no session).
      setClickedState({ index, status: 'loading' });
      pendingHistoryScrollRef.current = { uuid: entry.uuid, index };
      if (historyClickTimeoutRef.current) clearTimeout(historyClickTimeoutRef.current);
      historyClickTimeoutRef.current = setTimeout(() => {
        pendingHistoryScrollRef.current = null;
        setClickedState((s) => (s?.index === index ? null : s));
      }, 4000);
      return;
    }

    // If history panel is open — scroll to entry in history only, skip terminal scroll
    // This includes compact/continued entries which have no terminal position but DO exist in history panel
    if (isHistoryOpen) {
      setHistoryScrollToUuid(entry.uuid);
      setClickedState({ index, status: 'loading' });
      pendingHistoryScrollRef.current = { uuid: entry.uuid, index };
      if (historyClickTimeoutRef.current) clearTimeout(historyClickTimeoutRef.current);
      historyClickTimeoutRef.current = setTimeout(() => {
        pendingHistoryScrollRef.current = null;
        setClickedState((s) => (s?.index === index ? null : s));
      }, 4000);
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
            if (prevEntry.type === 'compact') continue;
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

    // Position: anchor popup's RIGHT edge to Timeline's LEFT edge (mirrors note tooltip).
    // X is no longer derived from cursor — vertical position follows the dot, horizontal is
    // pinned. Without this popup drifted into the centre of the screen when user clicked the
    // right half of the 32px-wide dot. We store x=0 and rely on `right:` CSS at render time
    // (see context-menu Portal); y is centred on the clicked dot.
    const menuHeight = selectionStartIdRef.current ? 40 : 90;
    const targetEl = segmentRefs.current[entries.findIndex(en => en.uuid === entry.uuid)];
    const targetRect = targetEl?.getBoundingClientRect();
    let y = targetRect ? targetRect.top + targetRect.height / 2 - menuHeight / 2 : e.pageY - menuHeight / 2;

    // Clamp to viewport top/bottom
    if (y + menuHeight > window.innerHeight - 10) y = window.innerHeight - menuHeight - 10;
    if (y < 10) y = 10;

    // x stays 0 — render layer reads `right` from notesPanelWidth + timeline width.
    setContextMenu({ x: 0, y, entry });
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

  const executeRangeAction = async (mode: 'copy' | 'edit', range: { startIndex: number; endIndex: number }, startUuid: string, endUuid: string, additionalPrompt?: string) => {
    if (!sessionId) return;

    // Clear selection
    selectionStartIdRef.current = null;
    setSelectionStartId(null);
    setRangeActionMenu(null);
    setPostPromptMode(false);

    if (mode === 'edit') {
      // Edit-range works inside a single JSONL — block only cross-file bridges
      // (compact_boundary / Context Overflow continued). SessionId variance within one
      // file is fine (claude --resume layering, see crossesBoundary detector above).
      const rangeEntries = entries.slice(range.startIndex, range.endIndex + 1);
      const hasCompact = rangeEntries.some(e => e.type === 'compact');
      const hasContinued = rangeEntries.some(e => e.type === 'continued');
      if (hasCompact || hasContinued) {
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
        const result = await ipcRenderer.invoke('claude:copy-range', {
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

  // Удаление диапазона без вставки compact-entry. Используется кнопкой "Удалить историю".
  // Если выделение пересекало границу (compact / Clear Context), range.startIndex = 0.
  // При пустом файле бэкенд удалит JSONL полностью и вернёт fileDeleted=true → таб
  // освобождается (claudeSessionId сбрасывается).
  const executeDeleteRange = async (range: { startIndex: number; endIndex: number }, startUuid: string, endUuid: string) => {
    if (!sessionId) return;
    if (!supportsClaudeTimelineActions) return; // Gemini/Codex не поддерживаются этим путём — JSON-формат другой

    // Очистка selection и popup
    selectionStartIdRef.current = null;
    setSelectionStartId(null);
    setRangeActionMenu(null);
    setDeleteConfirmMode(false);
    setDeletingRange(range);

    try {
      const result = await ipcRenderer.invoke('claude:delete-range', {
        sessionId,
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
      useUIStore.getState().showToast(
        `Удалено ${removedHuman} сообщений (${removedTotal} записей)`,
        'success', 2500
      );

      if (result.fileDeleted) {
        // Файл стёрт — освобождаем таб от сессии. Кнопка "Продолжить" запустит claude
        // как новую сессию (без --resume), а Timeline опустеет на следующем рефреше.
        const ws = useWorkspaceStore.getState();
        ws.setClaudeSessionId(tabId, '', 'timelineChain');
      } else {
        loadTimeline('delete-range');
      }
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
      setContextMenu(null);
      // Close expanded tooltip on outside click (skip if resize just ended)
      if (isExpanded && !isResizingTooltipRef.current) {
        // Skip if click target is inside tooltip (resize handle click → drag → mouseup → click)
        if (tooltipContentRef.current?.contains(e.target as Node)) return;
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
      if (selectionStartIdRef.current && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        selectionStartIdRef.current = null;
        setSelectionStartId(null);
      }
    };
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, [isExpanded, isNoteEditing, deleteConfirmMode, postPromptMode]);

  // ════════════════════════════════════════════════════════════
  // SECTION: REWIND PIPELINE — handleRewind (Gemini-compact via API → TUI menu + paste → scroll stabilization)
  // ════════════════════════════════════════════════════════════

  const handleRewind = async (entry: TimelineEntry, additionalPrompt?: string) => {
    setContextMenu(null);
    setRewindPostPromptMode(false);
    if (!sessionId) return;
    if (isCodex) return;

    const entryIndex = entries.findIndex(e => e.uuid === entry.uuid);
    if (entryIndex === -1) return;

    // Find the last compact/plan-mode boundary — Rewind TUI only shows entries after it.
    // Gemini doesn't have compact/plan-mode, so all entries are rewindable.
    let lastBoundaryIdx = -1;
    if (!isGemini) {
      for (let i = 0; i < entryIndex; i++) {
        const e = entries[i];
        if (e.type === 'compact' || e.isPlan) {
          lastBoundaryIdx = i;
        }
      }
    }

    // Filter to rewindable user entries only (after last boundary)
    const rewindableEntries = entries
      .filter((e, i) => e.type === 'user' && i > lastBoundaryIdx);
    const targetIndex = rewindableEntries.findIndex(e => e.uuid === entry.uuid);
    if (targetIndex === -1) {
      console.warn('[Restore:Rewind] Target is before compact/plan-mode boundary, cannot rewind');
      return;
    }

    // Count duplicate prefixes AFTER the target within rewindable range.
    // Use first 40 chars (TUI menu shows ~50 char prefix).
    const targetPrefix = entry.content.trim().substring(0, 40);
    let skipDuplicates = 0;
    for (let i = targetIndex + 1; i < rewindableEntries.length; i++) {
      const ePrefix = rewindableEntries[i].content.trim().substring(0, 40);
      if (ePrefix === targetPrefix) skipDuplicates++;
    }

    console.warn('[Restore:Rewind] Starting rewind to entry', targetIndex, '/', rewindableEntries.length,
      '- uuid:', entry.uuid, 'skipDuplicates:', skipDuplicates, 'boundaryIdx:', lastBoundaryIdx,
      'tool:', isGemini ? 'gemini' : 'claude');

    // IPC channel names based on tool type
    const copyRangeChannel = isGemini ? 'gemini:copy-range' : 'claude:copy-range';
    const historyMenuChannel = isGemini ? 'gemini:open-history-menu' : 'claude:open-history-menu';

    // Phase 1: Compact entries being lost (from clicked entry to end)
    let compactText = '';
    setRewindState({ index: entryIndex, phase: 'compacting' });

    try {
      const rangeResult = await ipcRenderer.invoke(copyRangeChannel, {
        sessionId,
        cwd,
        startUuid: entry.uuid,
        endUuid: entries[entries.length - 1].uuid
      });

      if (rangeResult.success && rangeResult.content) {
        console.warn('[Restore:Rewind] Range copied, length:', rangeResult.content.length);

        // Compact via Gemini API using rewind prompt
        const { getPromptById, rewindPromptId } = usePromptsStore.getState();
        const promptConfig = getPromptById(rewindPromptId);

        if (promptConfig) {
          // Load attached file contents
          let fileContentsBlock = '';
          const fpaths = promptConfig.filePaths || [];
          if (fpaths.length > 0) {
            const filesResult = await ipcRenderer.invoke('ai-prompts:read-files', fpaths);
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
            const response = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
              }
            );

            const data = await response.json();
            if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
              compactText = data.candidates[0].content.parts[0].text;
              console.warn('[Restore:Rewind] Compact ready, length:', compactText.length);
            } else {
              console.error('[Restore:Rewind] Gemini returned empty/blocked response');
            }
          } catch (geminiErr) {
            console.error('[Restore:Rewind] Gemini compact failed:', geminiErr);
          }
        } else {
          console.warn('[Restore:Rewind] No rewind prompt configured, skipping compact');
        }
      }
    } catch (rangeErr) {
      console.error('[Restore:Rewind] Copy range failed:', rangeErr);
    }

    // Phase 2: Execute rewind in TUI + paste compact
    setRewindState({ index: entryIndex, phase: 'rewinding' });

    try {
      const rewindResult = await ipcRenderer.invoke(historyMenuChannel, {
        tabId,
        targetIndex,
        targetText: entry.content.trim().substring(0, 40),
        skipDuplicates,
        pasteAfter: compactText || undefined
      });
      console.warn('[Restore:Rewind] Rewind result:', rewindResult.success ? 'OK' : 'FAIL',
        'pressCount:', rewindResult.pressCount,
        'compactPasted:', !!compactText);

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
      setRewindState({ index: entryIndex, phase: 'done' });
      setTimeout(() => setRewindState(null), 1200);

    } catch (rewindErr) {
      console.error('[Restore:Rewind] Rewind IPC failed:', rewindErr);
      setRewindState(null);
    }
  };

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

  // Delete a single user-prompt entry (irreversible). Keeps assistant response.
  // Disabled for Gemini (JSON format), for non-user entries, and for the very first
  // entry of the session (no parentUuid → would orphan its children).
  const handleDeleteUserEntry = async (entry: TimelineEntry) => {
    if (!sessionId || isGemini) return;
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
      useUIStore.getState().showToast('Запрос удалён', 'success', 1800);
      loadTimeline('delete-user-entry');
    } catch (err: any) {
      console.error('[Timeline] Delete user entry failed:', err);
      useUIStore.getState().showToast(
        'Ошибка удаления: ' + (err?.message || String(err)),
        'error', 4000
      );
    }
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

  if (!sessionId) return null;

  // ════════════════════════════════════════════════════════════
  // SECTION: RENDER GEOMETRY — derive current tooltip/note/fork-tooltip positions from segmentRefs before JSX
  // ════════════════════════════════════════════════════════════

  const currentActiveEntry = activeTooltipIndex !== null ? entries[activeTooltipIndex] : null;

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
    if (!m.entry_uuids || m.entry_uuids.length === 0) return false;
    const snap = new Set(m.entry_uuids);
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

  // ════════════════════════════════════════════════════════════
  // SECTION: JSX RENDER — Timeline container, scroll layer, segment loop, overlays, portals
  // ════════════════════════════════════════════════════════════

  return (
    <>
      {/* ──── OUTER SLOT — unpinned expanded mode reserves only the 32px rail and
            overlays left; pinned mode reserves the full expanded width. ──── */}
      <div
        style={{
          width: slideIn ? (pinned ? `${effectiveWidth}px` : '32px') : '0px',
          height: '100%',
          flexShrink: 0,
          position: 'relative',
          transition: 'width 50ms ease-out',
        }}
      >
      {/* ──── CONTAINER (Timeline outer wrapper, absolute-anchored right) ──── */}
      <div
        ref={containerRef}
        data-timeline
        className="relative flex flex-col group"
        style={{
          width: slideIn ? `${effectiveWidth}px` : '0px',
          backgroundColor: isExpandedLayout ? 'rgba(0, 0, 0, 0.85)' : 'rgba(0, 0, 0, 0.2)',
          backdropFilter: 'blur(8px)',
          borderLeft: slideIn ? '1px solid rgba(255, 255, 255, 0.05)' : 'none',
          height: '100%',
          zIndex: 40,
          visibility: isVisible ? 'inherit' : 'hidden',
          overflow: slideIn ? 'visible' : 'hidden',
          // Expanded layout overlays content from the right unless StatusBar pin
          // asks Timeline to participate in normal flex layout.
          position: isExpandedLayout && !pinned ? 'absolute' : 'static',
          top: isExpandedLayout && !pinned ? 0 : undefined,
          right: isExpandedLayout && !pinned ? 0 : undefined,
          // Font-size root for em-based descendants (chip + preview text).
          fontSize: `${timelineFontSize}px`,
          transition: 'width 50ms ease-out',
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
              const onMove = (ev: PointerEvent) => {
                const delta = startX - ev.clientX; // dragging left grows width
                setTimelineWidth(startW + delta);
              };
              const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
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
            const groupInfo = groupMap.get(index);

            // Phase 2: Hide collapsed group children (but NOT the header)
            if (groupInfo?.isGroupChild && !groupInfo?.isGroupHeader && !expandedGroups.has(groupInfo.groupId)) {
              // Still need ref for visibility system — render invisible placeholder
              return <div key={entry.uuid} ref={el => segmentRefs.current[index] = el} style={{ display: 'none' }} />;
            }

            const active = isSelected(entry, index);
            const isCompacted = entry.type === 'compact';
            const isLastEntry = index === entries.length - 1;
            // Fork marker at this position — only the SINGLE last snapshot UUID renders
            // the blue stripe (forkMarkerLastSnapIndex). Previously this used edge
            // detection (entry ∈ snap, next ∉ snap), which fired on every gap when the
            // parent's active branch was modified after the fork (rewind / edit-range /
            // delete-range punch holes through the snapshot) → many false stripes.
            const markerHitIdx = forkMarkerLastSnapIndex.findIndex(idx => idx === index);
            const forkMarkerAny = markerHitIdx >= 0 ? forkMarkers[markerHitIdx] : null;
            // Only non-hidden markers render the blue stripe
            const forkMarker = forkMarkerAny && !forkMarkerAny.hidden ? forkMarkerAny : null;

            const isPlanModeBoundary = (() => {
              if (isLastEntry || forkMarkerAny) return false; // ANY fork marker (even hidden) suppresses boundary
              const nextEntry = entries[index + 1];
              if (!nextEntry || !entry.sessionId || !nextEntry.sessionId) return false;
              if (entry.sessionId === nextEntry.sessionId) return false;
              // Suppress inherited session boundaries from parent chains in forked sessions.
              // If BOTH entries are in a fork snapshot, this boundary is from the parent chain —
              // not a plan mode transition in the current session.
              for (const snap of forkSnapshotSets) {
                if (snap.has(entry.uuid) && snap.has(nextEntry.uuid)) return false;
              }
              return true;
            })();

            // Phase 2: Group state
            const isGroupExpanded = !!(groupInfo?.groupId && expandedGroups.has(groupInfo.groupId));
            const isGroupCollapsed = !!(groupInfo?.isGroupHeader && !isGroupExpanded);
            const isGroupChild = !!(groupInfo?.isGroupChild && isGroupExpanded);
            // When collapsed, header entry is the visible toggle (not a child)
            // When expanded, header entry renders as a child too
            const showAsChild = isGroupChild && !(groupInfo?.isGroupHeader && !isGroupExpanded);
            const isInViewport = isGroupCollapsed
              ? Array.from({ length: groupInfo!.groupSize }, (_, offset) => index + offset).some(idx => visibleEntryIndices.has(idx))
              : visibleEntryIndices.has(index);
            const isResponseOnly = isGroupCollapsed ? false : responseOnlyIndices.has(index);
            const isUnreachable = unreachableIndices.has(index);
            const isContinued = entry.type === 'continued';
            const isPlan = !!entry.isPlan;
            const isDocsEdit = entry.type === 'docs_edit';
            const isDocsSearch = entry.type === 'docs_search';
            const dotClickState = clickedState?.index === index ? clickedState.status : null;

            // Entry type flags
            const entryIsSubAgent = !!(entry.isSubAgent || entry.isSubAgentTimeout);
            const entryIsTimeout = !!entry.isSubAgentTimeout;
            const isHovered = hoveredIndex === index || activeTooltipIndex === index;

            // ── Dot color ──
            let dotColor: string;
            let dotGlow: string;

            // isInViewport && !isResponseOnly = prompt visible in viewport (bright)
            // isResponseOnly = response visible but prompt above viewport (same as normal)
            const isPromptVisible = isInViewport && !isResponseOnly;
            // Old history = before last compact/plan boundary (not part of current dialog)
            const isOldHistory = !isCodex && lastBoundaryIndex >= 0 && index <= lastBoundaryIndex;
            // Chain-break zone: entries that are visually rendered but invisible
            // to Claude's own backtrace because a phantom parentUuid breaks the
            // chain somewhere along the way. claudeMemoryBoundaryIndex marks
            // the youngest entry of the pre-orphan tail — anything older than
            // it (including the boundary itself) cannot be reached by live
            // Claude. Compact is unrelated: orphans can appear with or without
            // a compact in the session (rebuild/Stop/Esc/SSE crash all produce
            // them).
            const isChainBreakZone =
              claudeMemoryBoundaryIndex >= 0 &&
              index <= claudeMemoryBoundaryIndex;

            if (isCompacted) {
              dotColor = isHovered ? '#fbbf24' : '#a67c1a';
              dotGlow = isHovered ? '0 0 10px rgba(251, 191, 36, 0.5)' : 'none';
            } else if (isContinued) {
              dotColor = isHovered ? '#f59e0b' : '#a67c1a';
              dotGlow = isHovered ? '0 0 10px rgba(245, 158, 11, 0.5)' : 'none';
            } else if (isDocsEdit) {
              dotColor = isHovered ? DOCS_TIMELINE_COLORS.edited.hover : (isPromptVisible ? DOCS_TIMELINE_COLORS.edited.visible : DOCS_TIMELINE_COLORS.edited.dim);
              dotGlow = isHovered ? `0 0 10px rgba(${DOCS_TIMELINE_COLORS.edited.glow}, 0.5)` : (isPromptVisible ? `0 0 6px rgba(${DOCS_TIMELINE_COLORS.edited.glow}, 0.22)` : 'none');
            } else if (isDocsSearch) {
              dotColor = isHovered ? DOCS_TIMELINE_COLORS.search.hover : (isPromptVisible ? DOCS_TIMELINE_COLORS.search.visible : DOCS_TIMELINE_COLORS.search.dim);
              dotGlow = isHovered ? `0 0 10px rgba(${DOCS_TIMELINE_COLORS.search.glow}, 0.5)` : (isPromptVisible ? `0 0 6px rgba(${DOCS_TIMELINE_COLORS.search.glow}, 0.22)` : 'none');
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
            } else if (entry.docsEdited && entry.docsEdited.length > 0) {
              // User turn that resulted in docs/CLAUDE.md edits — colour the user dot green
              // instead of emitting a separate docs_edit dot. Edit takes precedence over search:
              // editing is a "stronger" signal (file actually changed) than reading.
              dotColor = isHovered ? DOCS_TIMELINE_COLORS.edited.hover : (isPromptVisible ? DOCS_TIMELINE_COLORS.edited.visible : DOCS_TIMELINE_COLORS.edited.dim);
              dotGlow = isHovered ? `0 0 10px rgba(${DOCS_TIMELINE_COLORS.edited.glow}, 0.5)` : (isPromptVisible ? `0 0 6px rgba(${DOCS_TIMELINE_COLORS.edited.glow}, 0.25)` : 'none');
            } else if (entry.docsSearchQueries && entry.docsSearchQueries.length > 0) {
              // User turn that triggered docs_search but no edits — lighter green tone.
              dotColor = isHovered ? DOCS_TIMELINE_COLORS.search.hover : (isPromptVisible ? DOCS_TIMELINE_COLORS.search.visible : DOCS_TIMELINE_COLORS.search.dim);
              dotGlow = isHovered ? `0 0 10px rgba(${DOCS_TIMELINE_COLORS.search.glow}, 0.5)` : (isPromptVisible ? `0 0 6px rgba(${DOCS_TIMELINE_COLORS.search.glow}, 0.25)` : 'none');
            } else {
              dotColor = isHovered ? '#fff' : (isPromptVisible ? '#ccc' : '#999');
              dotGlow = isHovered ? '0 0 10px rgba(255, 255, 255, 0.5)' : (isPromptVisible ? '0 0 6px rgba(255, 255, 255, 0.15)' : 'none');
            }

            // ── Dot size ──
            const dotWidth = isCompacted
              ? (isInViewport ? '12px' : '14px')
              : showAsChild
                ? (isHovered ? '8px' : (isInViewport ? '8px' : '4px'))
                : (isHovered ? '10px' : (isInViewport ? '10px' : '5px'));
            const dotHeight = isCompacted
              ? (isInViewport ? '4px' : '3px')
              : showAsChild
                ? (isHovered ? '8px' : (isInViewport ? '3px' : '4px'))
                : (isHovered ? '10px' : (isInViewport ? '3px' : '5px'));
            const dotRadius = (isCompacted || (isInViewport && !isHovered)) ? '1px' : '50%';

            // Expanded group header: render toggle bar THEN the entry as child
            const isExpandedHeader = !!(groupInfo?.isGroupHeader && isGroupExpanded);
            // Group headers (×N meta markers) — always bright, never dimmed
            const isGroupMeta = isGroupCollapsed || isExpandedHeader;
            if (isGroupMeta) {
              dotColor = isHovered ? '#818cf8' : '#7c86f0';
              dotGlow = isHovered ? '0 0 10px rgba(129, 140, 248, 0.5)' : '0 0 6px rgba(129, 140, 248, 0.2)';
            }

            // Note position — use editing position when actively editing this entry
            const isEditingThis = activeNoteIndex === index && isNoteEditing;
            const hasNote = !!notes[entry.uuid] || isEditingThis;
            const notePos = isEditingThis ? noteEditPosition : (notePositions[entry.uuid] || 'before');
            // Note on dot: override color to purple
            if (hasNote && notePos === 'dot') {
              dotColor = isHovered ? '#c084fc' : '#9333ea';
              dotGlow = isHovered ? '0 0 10px rgba(168, 85, 247, 0.5)' : '0 0 6px rgba(168, 85, 247, 0.25)';
            }
            // Rewind marker: override color to pink
            if (rewindMarkers.has(entry.uuid)) {
              dotColor = isHovered ? '#f472b6' : '#ec4899';
              dotGlow = isHovered ? '0 0 10px rgba(236, 72, 153, 0.5)' : '0 0 6px rgba(236, 72, 153, 0.25)';
            }

            return (
              <React.Fragment key={entry.uuid}>
                {/* Phase 2: Expanded group toggle bar (collapse control) */}
                {isExpandedHeader && (
                  <div
                    className="relative w-full flex items-center"
                    style={{
                      flex: '0 0 auto',
                      height: '14px',
                      cursor: 'pointer',
                      justifyContent: 'center',
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedGroups(prev => {
                        const next = new Set(prev);
                        next.delete(groupInfo!.groupId);
                        return next;
                      });
                    }}
                  >
                    {/* Left line */}
                    <div style={{
                      flex: 1,
                      height: '1px',
                      backgroundColor: 'rgba(129, 140, 248, 0.2)',
                      marginRight: '3px',
                    }} />
                    {/* Badge */}
                    <span className="pointer-events-none select-none shrink-0" style={{
                      fontSize: '9px',
                      lineHeight: '1',
                      color: 'rgba(129, 140, 248, 0.9)',
                      fontFamily: 'monospace',
                      fontWeight: 600,
                    }}>
                      ×{groupInfo!.groupSize}
                    </span>
                    {/* Right line */}
                    <div style={{
                      flex: 1,
                      height: '1px',
                      backgroundColor: 'rgba(129, 140, 248, 0.2)',
                      marginLeft: '3px',
                    }} />
                  </div>
                )}
                {/* Note indicator strip — before dot */}
                {hasNote && notePos === 'before' && (() => {
                  const noteHovered = hoveredNoteIndex === index || activeNoteIndex === index;
                  return (
                    <div
                      className="flex-shrink-0 w-full flex items-center justify-center"
                      style={{ height: '6px', cursor: 'pointer' }}
                      onMouseEnter={() => handleNoteStripEnter(index)}
                      onMouseLeave={handleNoteStripLeave}
                    >
                      <div
                        style={{
                          width: noteHovered ? '18px' : '14px',
                          height: noteHovered ? '3px' : '2px',
                          borderRadius: '1px',
                          backgroundColor: noteHovered ? '#c084fc' : '#9333ea',
                          boxShadow: noteHovered ? '0 0 8px rgba(168, 85, 247, 0.5)' : 'none',
                          transition: 'background-color 0.2s, box-shadow 0.2s',
                        }}
                      />
                    </div>
                  );
                })()}
                <div
                  ref={el => segmentRefs.current[index] = el}
                  data-segment
                  {...(isUnreachable ? { 'data-unreachable': '' } : {})}
                  className="relative w-full flex items-center"
                  onMouseEnter={() => handleMouseEnterSegment(index)}
                  onMouseLeave={(e) => handleMouseLeaveSegment(e)}
                  onClick={(e) => {
                    // Phase 2: Click on collapsed group header toggles expansion
                    if (groupInfo?.isGroupHeader && !isGroupExpanded) {
                      e.stopPropagation();
                      setExpandedGroups(prev => {
                        const next = new Set(prev);
                        next.add(groupInfo.groupId);
                        return next;
                      });
                    } else {
                      handleEntryClick(entry, e);
                    }
                  }}
                  onDoubleClick={() => handleEntryDoubleClick(entry)}
                  onContextMenu={(e) => handleRightClick(e, entry)}
                  style={{
                    // expanded: height auto-fits content (no overlap with neighbours).
                    // dots-only/tree: original flex-grow distribution.
                    flex: isExpandedLayout
                      ? '0 0 auto'
                      : `1 0 ${treeMode ? '22px' : (showAsChild ? '14px' : '20px')}`,
                    minHeight: isExpandedLayout
                      ? undefined
                      : (treeMode ? '22px' : (showAsChild ? '14px' : '20px')),
                    alignItems: isExpandedLayout ? 'flex-start' : undefined,
                    justifyContent: isExpandedLayout ? 'flex-start' : (treeMode ? 'flex-start' : 'center'),
                    paddingLeft: isExpandedLayout
                      ? '6px'
                      : (treeMode
                          ? (showAsChild ? '20px' : entryIsSubAgent ? '10px' : '4px')
                          : (showAsChild ? '4px' : undefined)),
                    paddingRight: isExpandedLayout ? '8px' : undefined,
                    paddingTop: isExpandedLayout ? '6px' : undefined,
                    paddingBottom: isExpandedLayout ? '6px' : undefined,
                    gap: isExpandedLayout ? '6px' : undefined,
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
                        // Red zones:
                        // - chain-break zone (entries unreachable by Claude's
                        //   own backtrace due to phantom parentUuid) — shown
                        //   in ALL views including HistoryPanel/SDK, because
                        //   even though the renderer can display them via
                        //   recovery, live Claude cannot see them.
                        // - pre-compact old-history — Claude-only. Suppressed
                        //   when HistoryPanel open OR SDK tab (those render
                        //   full chat themselves so it'd be redundant).
                        : (isChainBreakZone && !isGroupMeta && !isCompacted)
                          ? 'rgba(239, 68, 68, 0.06)'
                          : (isOldHistory && !isGroupMeta && !isHistoryOpen && !isSdkTab
                              ? 'rgba(239, 68, 68, 0.06)'
                              : 'transparent'),
                    cursor: (isContinued || isDocsEdit || isDocsSearch || (isOldHistory && !isHistoryOpen && !isSdkTab)) ? 'default' : 'pointer',
                  } as React.CSSProperties}
                >
                  {/* Dot */}
                  {/* Dot: hollow ring if not in buffer (current segment), filled otherwise */}
                  {/* pointer-events: auto so ПКМ на сам кружок ловится отдельно от полосы —
                      это позволяет показывать "Копировать compact" только когда клик был
                      именно по кружку (а не по сегменту-полоске). */}
                  {isExpandedLayout ? (
                    /* Dot lives in a narrow gutter vertically centred in the entry.
                       No size growth on hover — row bg changes instead so text doesn't shift. */
                    (() => {
                      const expW = isCompacted ? '8px' : (showAsChild ? '6px' : '8px');
                      const expH = isCompacted ? '3px' : (showAsChild ? '6px' : '8px');
                      const expR = isCompacted ? '1px' : '50%';
                      return (
                        <div
                          className="flex items-center justify-center shrink-0"
                          style={{ width: '14px', alignSelf: 'stretch' }}
                        >
                          <div
                            className="pointer-events-none shrink-0"
                            style={{
                              width: expW,
                              height: expH,
                              borderRadius: expR,
                              backgroundColor: isUnreachable && !isCompacted ? 'transparent' : dotColor,
                              border: isUnreachable && !isCompacted ? `1px solid ${rewindMarkers.has(entry.uuid) ? '#ec4899' : hasNote && notePos === 'dot' ? '#9333ea' : dotColor}` : 'none',
                              boxShadow: dotGlow,
                              boxSizing: 'border-box',
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
                        width: dotWidth,
                        height: dotHeight,
                        borderRadius: dotRadius,
                        backgroundColor: isUnreachable && !isHovered && !isCompacted ? 'transparent' : dotColor,
                        border: isUnreachable && !isHovered && !isCompacted ? `1px solid ${rewindMarkers.has(entry.uuid) ? '#ec4899' : hasNote && notePos === 'dot' ? '#9333ea' : dotColor}` : 'none',
                        boxShadow: dotGlow,
                        boxSizing: 'border-box',
                        pointerEvents: 'auto',
                        transition: 'width 0.15s, height 0.15s, border-radius 0.15s, background-color 0.2s, box-shadow 0.2s',
                      }}
                    />
                  )}

                  {/* Expanded layout: N-line preview text only (type is conveyed by dot color) */}
                  {isExpandedLayout && !isExpandedHeader && (() => {
                    let previewText = (isCompacted ? 'Conversation compacted' : (entry.content || '')).trim();
                    let previewColor = 'rgba(255, 255, 255, 0.85)';
                    let previewStyle: React.CSSProperties = {};
                    let isSummaryPreview = false;
                    if (!isCompacted && summaryToolType && sessionId && isEligibleTabTitleEntry(entry)) {
                      const key = timelineSummaryKey(summaryToolType, sessionId, entry.uuid);
                      const row = promptSummaries[key];
                      if (row?.summary) {
                        previewText = row.summary.trim();
                        isSummaryPreview = true;
                      } else if (promptSummaryLoadingKeys.has(key)) {
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
                    }
                    if (!previewText) return null;
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
                        title={!isCompacted && previewText !== (entry.content || '').trim() ? (entry.content || '') : undefined}
                      >
                        {isSummaryPreview ? renderSingleStarHighlights(previewText) : previewText}
                      </div>
                    );
                  })()}

                  {/* Phase 2: Group count badge (collapsed only) */}
                  {groupInfo?.isGroupHeader && !isGroupExpanded && !treeMode && (
                    <div
                      className="absolute pointer-events-none"
                      style={{
                        right: '5px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: '9px',
                        lineHeight: '1',
                        color: 'rgba(129, 140, 248, 0.9)',
                        fontWeight: 600,
                        fontFamily: 'monospace',
                      }}
                    >
                      ×{groupInfo.groupSize}
                    </div>
                  )}

                  {/* Loading indicator — mirrors the resting-state Viewport-Dash
                      shape (10×3 white strip) so the click→scroll transition is
                      a pure intensity pulse, not a shape change. Anchored over
                      the dot column (left 6px / width 14px in expanded mode;
                      full-inset otherwise). The dash sits visually on top of
                      the dot/strip beneath via z-index implicit ordering. */}
                  {dotClickState === 'loading' && (
                    isExpandedLayout ? (
                      <div
                        className="absolute top-0 bottom-0 flex items-center justify-center pointer-events-none"
                        style={{ left: 6, width: 14 }}
                      >
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
                      <div
                        className="absolute top-0 bottom-0 flex items-center justify-center pointer-events-none"
                        style={{ left: 6, width: 14 }}
                      >
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
                {hasNote && notePos === 'after' && (() => {
                  const noteHovered = hoveredNoteIndex === index || activeNoteIndex === index;
                  return (
                    <div
                      className="flex-shrink-0 w-full flex items-center justify-center"
                      style={{ height: '6px', cursor: 'pointer' }}
                      onMouseEnter={() => handleNoteStripEnter(index)}
                      onMouseLeave={handleNoteStripLeave}
                    >
                      <div
                        style={{
                          width: noteHovered ? '18px' : '14px',
                          height: noteHovered ? '3px' : '2px',
                          borderRadius: '1px',
                          backgroundColor: noteHovered ? '#c084fc' : '#9333ea',
                          boxShadow: noteHovered ? '0 0 8px rgba(168, 85, 247, 0.5)' : 'none',
                          transition: 'background-color 0.2s, box-shadow 0.2s',
                        }}
                      />
                    </div>
                  );
                })()}
                {/* Last boundary separator — full-width unified line between old history and current dialog.
                    Visually marks "session starts below"; not navigable. Click → red X flash. */}
                {index === lastBoundaryIndex && (
                  <Tooltip content="Current session starts below">
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center relative"
                    style={{ height: '8px', cursor: 'default' }}
                    onClick={(e) => { e.stopPropagation(); flashStripFailed(index, 'boundary'); }}
                  >
                    <div
                      style={{
                        width: '100%',
                        height: '1px',
                        backgroundColor: 'rgba(255, 255, 255, 0.2)',
                      }}
                    />
                    {failedStripFlash?.index === index && failedStripFlash.kind === 'boundary' && (
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
                {/* Fork marker (only outside old history zone — inside it's redundant).
                    Not a navigable entry — left-click shows red X. Cmd+hover still opens
                    the fork tooltip (see onMouseEnter below); Cmd+click does the same X flash. */}
                {forkMarker && !isOldHistory && (
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center relative"
                    style={{ height: '8px', cursor: isCmdHeld ? 'pointer' : 'default', padding: '6px 0', boxSizing: 'content-box' }}
                    onClick={(e) => { e.stopPropagation(); flashStripFailed(index, 'fork'); }}
                    onMouseEnter={() => {
                      setHoveredForkMarkerIndex(index);
                      if (isCmdHeldRef.current) {
                        setActiveForkMarkerIndex(index);
                        setActiveTooltipIndex(null);
                      }
                    }}
                    onMouseLeave={(e) => {
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
                    }}
                  >
                    <div
                      style={{
                        width: activeForkMarkerIndex === index ? '14px' : isInViewport ? '10px' : '12px',
                        height: activeForkMarkerIndex === index ? '4px' : isInViewport ? '3px' : '2px',
                        borderRadius: '1px',
                        backgroundColor: activeForkMarkerIndex === index ? '#93c5fd' : isInViewport ? '#60a5fa' : '#3b82f6',
                        boxShadow: activeForkMarkerIndex === index ? '0 0 8px rgba(59, 130, 246, 0.5)' : isInViewport ? '0 0 6px rgba(59, 130, 246, 0.25)' : 'none',
                        transition: 'all 0.2s',
                      }}
                    />
                    {failedStripFlash?.index === index && failedStripFlash.kind === 'fork' && (
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.85 }}>
                          <line x1="2" y1="2" x2="8" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                          <line x1="8" y1="2" x2="2" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </div>
                    )}
                  </div>
                )}
                {/* Plan mode marker (only outside old history zone) — not navigable, click → X. */}
                {isPlanModeBoundary && !isOldHistory && (
                  <Tooltip content="Plan mode - context was cleared here">
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center relative"
                    style={{ height: '8px', cursor: 'default' }}
                    onClick={(e) => { e.stopPropagation(); flashStripFailed(index, 'plan'); }}
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
                    {failedStripFlash?.index === index && failedStripFlash.kind === 'plan' && (
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
          })}
        </div>

        {/* ──── INNER-WRAPPER OVERLAYS (rangeActionMenu indicator, selection preview, copy/delete/rewind/edit-range pulses with StatusLabelPortal) ──── */}
        {/* Selected Range Indicator (static, when action menu is open).
            In deleteConfirmMode + crossesBoundary the overlay extends to index 0 to
            visualise what will actually be deleted — the popup text says «N записей до
            самого начала», the highlight must match. Copy/Edit modes keep the visual
            range the user actually selected. */}
        {isVisible && rangeActionMenu && (() => {
          const effStart = (deleteConfirmMode && rangeActionMenu.crossesBoundary)
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
          const endIdx = rewindState.phase === 'compacting' ? entries.length - 1 : rewindState.index;
          const rect = getOverlayRect(rewindState.index, endIdx);
          if (!rect || !innerWrapperRef.current) return null;
          const phase = rewindState.phase;
          const label = phase === 'done' ? 'DONE' : phase === 'compacting' ? 'COMPACTING...' : 'REWINDING...';
          const blinkClass = phase === 'compacting' ? 'animate-glow-yellow' : phase === 'done' ? '' : 'animate-glow-purple';
          const staticBg = phase === 'done' ? 'rgba(34, 197, 94, 0.4)' : '';
          const color = phase === 'done' ? '#22c55e' : phase === 'compacting' ? '#f59e0b' : '#a855f7';
          
          const wrapperRect = innerWrapperRef.current.getBoundingClientRect();
          const fixedTop = wrapperRect.top + rect.top + 10;
          const rightOffset = window.innerWidth - wrapperRect.right + 12;

          return (
            <>
              <div
                className={`absolute left-0 right-0 pointer-events-none ${blinkClass}`}
                style={{
                  top: rect.top,
                  height: rect.height,
                  backgroundColor: staticBg,
                  borderTop: `2px solid ${color}`,
                  borderBottom: `2px solid ${color}`,
                  boxShadow: `0 0 20px ${color}80`,
                  zIndex: 50,
                }}
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
              onApply={async (compactText) => {
                console.warn('[EditRange] Applying, compact length:', compactText.length);
                setEditRangeState(prev => prev ? { ...prev, phase: 'applying' } : null);

                const range = editRangeState!.range;
                const startUuid = entries[range.startIndex].uuid;
                const endUuid = entries[range.endIndex].uuid;

                // Step 1: Exit Claude if command is running (same check as sidebar green border)
                const cmdState = await ipcRenderer.invoke('terminal:getCommandState', tabId);
                console.warn('[EditRange] commandState:', JSON.stringify(cmdState));

                if (cmdState?.isRunning) {
                  console.warn('[EditRange] Sending Ctrl+C #1, waiting for DangerZone...');
                  ipcRenderer.send('terminal:input', tabId, '\x03');

                  // Wait for "again to exit" detection (deterministic, no blind timeout)
                  await new Promise<void>((resolve) => {
                    const timeout = setTimeout(() => {
                      console.warn('[EditRange] DangerZone timeout, sending Ctrl+C #2 anyway');
                      ipcRenderer.removeListener('claude:ctrlc-danger-zone', handler);
                      resolve();
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
                  for (let i = 0; i < 30; i++) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                    const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);
                    if (!state?.isRunning) {
                      console.warn('[EditRange] Command finished (OSC 133 D)');
                      break;
                    }
                    if (i === 29) console.warn('[EditRange] Exit timeout');
                  }
                  await new Promise(resolve => setTimeout(resolve, 300));
                }

                // Step 2: Edit JSONL
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

                // Step 3: Wait for shell prompt (OSC 133 A) then restart Claude
                console.warn('[EditRange] Waiting for prompt-ready...');
                await new Promise<void>((resolve) => {
                  const timeout = setTimeout(() => {
                    console.warn('[EditRange] prompt-ready timeout, proceeding anyway');
                    ipcRenderer.removeListener('terminal:prompt-ready', handler);
                    resolve();
                  }, 5000);
                  const handler = (_e: any, readyTabId: string) => {
                    if (readyTabId === tabId) {
                      clearTimeout(timeout);
                      ipcRenderer.removeListener('terminal:prompt-ready', handler);
                      resolve();
                    }
                  };
                  ipcRenderer.on('terminal:prompt-ready', handler);
                });

                console.warn('[EditRange] Restarting Claude with session:', sessionId?.slice(0, 8));
                ipcRenderer.send('claude:run-command', {
                  tabId,
                  command: 'claude-c',
                  sessionId,
                });

                // Wait for Claude to start (isRunning = true = command running = sidebar green)
                for (let i = 0; i < 30; i++) {
                  await new Promise(resolve => setTimeout(resolve, 300));
                  const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);
                  if (state?.isRunning) {
                    console.warn('[EditRange] Claude running (sidebar green)');
                    break;
                  }
                  if (i === 29) console.warn('[EditRange] Claude start timeout');
                }

                // Show toast on success
                useUIStore.getState().showToast('Rewind завершён', 'success', 1500);

                return { removedCount: result.removedCount, removedUsers: result.removedUsers };
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
                {currentActiveEntry.type === 'compact' ? (() => {
                  const cached = compactSummaryCache[currentActiveEntry.uuid];
                  const compactText = currentActiveEntry.compactSummary || cached || '';
                  const isLoadingCompact = !currentActiveEntry.compactSummary && cached === undefined;
                  const displayText = compactText || (isLoadingCompact ? 'Загружаю compact summary...' : 'Compact summary не найден');
                  const canCopyCompact = !!compactText;
                  return (
                    <>
                      <div className="flex items-center gap-2 shrink-0">
                        <div style={{ width: '12px', height: '3px', borderRadius: '1px', backgroundColor: '#f59e0b', flexShrink: 0 }} />
                        <span className="text-amber-400 font-medium text-[11px]">
                          History Compacted ({currentActiveEntry.preTokens ? `${Math.round(currentActiveEntry.preTokens / 1000)}k` : '?'} tokens)
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
                      if (gi?.isGroupHeader && !expandedGroups.has(gi.groupId)) {
                        return (
                          <span className="text-[10px] text-white/40">
                            ×{gi.groupSize} agents{gi.hasTimeout ? ' (with timeout)' : ''}
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
                      <span
                        className="flex items-center gap-1 ml-2 text-[10px]"
                        onMouseEnter={(e) => {
                          if (!supportsClaudeTimelineActions) return;
                          setSingleChipEl(e.currentTarget);
                          setSingleTokenUuid(currentActiveEntry.uuid);
                          setSingleBreakdownOpen(true);
                        }}
                        style={{
                          color: '#e8a955',
                          cursor: supportsClaudeTimelineActions ? 'help' : 'default',
                          textDecoration: supportsClaudeTimelineActions ? 'underline dotted rgba(232,169,85,0.4)' : 'none',
                          textUnderlineOffset: '2px',
                        }}
                      >
                        <Zap size={10} />
                        <span>{formatTokenCount(singleTokenEstimate && singleTokenUuid === currentActiveEntry.uuid ? singleTokenEstimate.total : Math.ceil(currentActiveEntry.content.length / 3.5))}</span>
                      </span>
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
                      <span
                        className="flex items-center gap-1 ml-2 text-[10px]"
                        onMouseEnter={(e) => {
                          if (!supportsClaudeTimelineActions) return;
                          setSingleChipEl(e.currentTarget);
                          setSingleTokenUuid(currentActiveEntry.uuid);
                          setSingleBreakdownOpen(true);
                        }}
                        style={{
                          color: '#e8a955',
                          cursor: supportsClaudeTimelineActions ? 'help' : 'default',
                          textDecoration: supportsClaudeTimelineActions ? 'underline dotted rgba(232,169,85,0.4)' : 'none',
                          textUnderlineOffset: '2px',
                        }}
                      >
                        <Zap size={10} />
                        <span>{formatTokenCount(singleTokenEstimate && singleTokenUuid === currentActiveEntry.uuid ? singleTokenEstimate.total : Math.ceil(currentActiveEntry.content.length / 3.5))}</span>
                      </span>
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
                        <StickyNote size={10} className="shrink-0 mt-0.5" style={{ color: '#9333ea' }} />
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
                    {/* Docs-edit / docs-search inline preview — attached to user-entry that triggered them.
                        Previously rendered as separate green dots on timeline; consolidated here so each
                        prompt has at most one dot, with docs-info surfaced on hover.
                        Default: compact one-liner "Docs updated (N) — basename, basename, …".
                        Click on the line: expand to show full paths / full queries on separate rows.
                        Keeps tooltip body short so prompt text below is visible without scrolling. */}
                    {currentActiveEntry.docsEdited && currentActiveEntry.docsEdited.length > 0 && (() => {
                      const uuid = currentActiveEntry.uuid;
                      const open = expandedDocsEdit.has(uuid);
                      const files = currentActiveEntry.docsEdited;
                      return (
                        <div className={`pb-1.5 mb-1.5 border-b ${DOCS_TIMELINE_COLORS.edited.borderClass} shrink-0`}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedDocsEdit(prev => {
                                const next = new Set(prev);
                                if (next.has(uuid)) next.delete(uuid); else next.add(uuid);
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
                              {files.map((f: string, i: number) => (
                                <div key={i} className="break-all" style={{ opacity: 0.85 }}>{f}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    {currentActiveEntry.docsSearchQueries && currentActiveEntry.docsSearchQueries.length > 0 && (() => {
                      const uuid = currentActiveEntry.uuid;
                      const open = expandedDocsSearch.has(uuid);
                      const queries = currentActiveEntry.docsSearchQueries;
                      return (
                        <div className={`pb-1.5 mb-1.5 border-b ${DOCS_TIMELINE_COLORS.search.borderClass} shrink-0`}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedDocsSearch(prev => {
                                const next = new Set(prev);
                                if (next.has(uuid)) next.delete(uuid); else next.add(uuid);
                                return next;
                              });
                            }}
                            className={`w-full text-left flex items-start gap-1.5 ${DOCS_TIMELINE_COLORS.search.hoverClass} rounded px-0.5 py-0.5 cursor-pointer`}
                            style={{ color: DOCS_TIMELINE_COLORS.search.tooltip }}
                          >
                            <Search size={10} className="shrink-0 mt-0.5" style={{ color: DOCS_TIMELINE_COLORS.search.visible }} />
                            <span className="leading-snug font-mono text-[10px] flex-1">
                              <span className="font-medium">Docs search ({queries.length})</span>
                            </span>
                          </button>
                          {open && (
                            <div className="mt-1 ml-4 leading-snug font-mono text-[10px]" style={{ color: DOCS_TIMELINE_COLORS.search.tooltipMuted }}>
                              {queries.map((q: string, i: number) => (
                                <div key={i} className="break-words" style={{ opacity: 0.85 }}>«{q}»</div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    <div className="text-white/90 leading-snug font-mono scrollbar-thin" style={{ maxHeight: isExpanded ? 'calc(78vh - 80px)' : '160px', overflowY: 'auto', overflowX: 'hidden', whiteSpace: 'pre-wrap' }}>
                      {currentActiveEntry.content}
                    </div>
                    <div className="flex items-center mt-0 pt-1 border-t border-white/5 shrink-0">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      <span
                        className="flex items-center gap-1 ml-2 text-[10px]"
                        onMouseEnter={(e) => {
                          if (!supportsClaudeTimelineActions) return;
                          setSingleChipEl(e.currentTarget);
                          setSingleTokenUuid(currentActiveEntry.uuid);
                          setSingleBreakdownOpen(true);
                        }}
                        style={{
                          color: '#e8a955',
                          cursor: supportsClaudeTimelineActions ? 'help' : 'default',
                          textDecoration: supportsClaudeTimelineActions ? 'underline dotted rgba(232,169,85,0.4)' : 'none',
                          textUnderlineOffset: '2px',
                        }}
                      >
                        <Zap size={10} />
                        <span>{formatTokenCount(singleTokenEstimate && singleTokenUuid === currentActiveEntry.uuid ? singleTokenEstimate.total : Math.ceil(currentActiveEntry.content.length / 3.5))}</span>
                      </span>
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
                top: contextMenu.y,
                backgroundColor: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '4px',
                zIndex: 10001,
                minWidth: '160px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
              }}
            >
              {!selectionStartId ? (
                <>
                  {/* "Копировать" — все entries с копируемым контентом:
                      user (промпт + ответы), compact (summary), continued (Context Overflow Recovery — содержит bridge text).
                      Цвета дотов: compact=янтарь #fbbf24, continued=янтарь #f59e0b — оба оранжевые. */}
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
                        {contextMenu.entry.type === 'compact'
                          ? 'Копировать compact'
                          : contextMenu.entry.type === 'continued'
                            ? 'Копировать continued'
                            : 'Копировать'}
                      </button>
                      <div className="border-t border-white/10 my-1" />
                    </>
                  )}
                  <button
                    className="w-full text-left px-3 py-2 text-xs text-purple-400 hover:bg-purple-600/20 rounded transition-colors cursor-pointer flex items-center gap-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddNote(contextMenu.entry);
                    }}
                  >
                    <StickyNote size={12} />
                    {notes[contextMenu.entry.uuid] ? 'Редактировать заметку' : 'Добавить заметку'}
                  </button>
                  {/* Удалить запрос — только для Claude user-entries (не compact/continued).
                      Двухшаговый inline-confirm: первый клик переключает кнопку в красное
                      «Точно удалить?», второй — вызывает claude:delete-user-entry. */}
                  {supportsClaudeTimelineActions && contextMenu.entry.type === 'user' && !contextMenu.entry.isCompactSummary && (
                    <>
                      <div className="border-t border-white/10 my-1" />
                      {!deleteEntryConfirmMode ? (
                        <button
                          className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-600/20 rounded transition-colors cursor-pointer flex items-center gap-2"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteEntryConfirmMode(true);
                          }}
                        >
                          <Trash2 size={12} />
                          Удалить user-mess
                        </button>
                      ) : (
                        <button
                          className="w-full text-left px-3 py-2 text-xs text-white rounded transition-colors cursor-pointer flex items-center gap-2"
                          style={{ backgroundColor: 'rgba(239, 68, 68, 0.8)' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteUserEntry(contextMenu.entry);
                          }}
                        >
                          <Trash2 size={12} />
                          Точно удалить?
                        </button>
                      )}
                    </>
                  )}
                  {/* Rewind — Claude & Gemini */}
                  {!isCodex && <div className="border-t border-white/10 my-1" />}
                  {!isCodex && (!rewindPostPromptMode ? (
                    <div className="flex rounded overflow-hidden">
                      <button
                        className={`flex-1 text-left px-3 py-2 text-xs rounded-l transition-colors ${isActive && !rewindState ? 'text-amber-400 hover:bg-amber-600/20 cursor-pointer' : 'text-white/20 cursor-not-allowed'}`}
                        disabled={!isActive || !!rewindState}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isActive && !rewindState) handleRewind(contextMenu.entry);
                        }}
                      >
                        {rewindState ? (rewindState.phase === 'compacting' ? 'Компакт...' : rewindState.phase === 'rewinding' ? 'Откат...' : 'Вставка...') : 'Откатиться'}
                      </button>
                      {isActive && !rewindState && (
                        <Tooltip content="Откатиться с инструкцией">
                        <button
                          className="px-2 py-2 text-xs text-amber-400/60 hover:bg-amber-600/30 hover:text-amber-300 transition-colors cursor-pointer border-l border-white/10"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRewindPostPromptMode(true);
                            setRewindPostPromptText('');
                            setTimeout(() => rewindPostPromptRef.current?.focus(), 50);
                          }}
                        >
                          ▶
                        </button>
                        </Tooltip>
                      )}
                    </div>
                  ) : (
                    <div className="p-1">
                      <textarea
                        ref={rewindPostPromptRef}
                        value={rewindPostPromptText}
                        onChange={(e) => setRewindPostPromptText(e.target.value)}
                        placeholder="Инструкция для Gemini при откате..."
                        className="w-full bg-[#252525] border border-[#444] rounded px-2 py-1.5 text-[11px] text-white/90 font-mono resize-none focus:outline-none focus:border-amber-500/50 placeholder:text-[#555]"
                        style={{ minHeight: '28px', maxHeight: '110px', lineHeight: '1.4' }}
                        rows={1}
                        onInput={(e) => {
                          const el = e.currentTarget;
                          el.style.height = 'auto';
                          el.style.height = Math.min(el.scrollHeight, 110) + 'px';
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && e.metaKey && rewindPostPromptText.trim()) {
                            e.preventDefault();
                            const prompt = rewindPostPromptText.trim();
                            setRewindPostPromptMode(false);
                            setRewindPostPromptText('');
                            handleRewind(contextMenu.entry, prompt);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setRewindPostPromptMode(false);
                            setRewindPostPromptText('');
                          }
                        }}
                      />
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[9px] text-[#555]">⌘+Enter • Esc отмена</span>
                        <button
                          className="p-1 rounded transition-colors cursor-pointer"
                          style={{
                            color: rewindPostPromptText.trim() ? '#f59e0b' : '#555',
                            backgroundColor: rewindPostPromptText.trim() ? 'rgba(245, 158, 11, 0.1)' : 'transparent',
                          }}
                          disabled={!rewindPostPromptText.trim()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!rewindPostPromptText.trim()) return;
                            const prompt = rewindPostPromptText.trim();
                            setRewindPostPromptMode(false);
                            setRewindPostPromptText('');
                            handleRewind(contextMenu.entry, prompt);
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                        </button>
                      </div>
                    </div>
                  ))}
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
                // For Delete: extend range to 0 when it crosses a boundary (compact / Plan
                // Mode / Clear Context). Splicing across JSONL boundary would corrupt the
                // parentUuid chain — for delete we always cut a contiguous prefix.
                // For Copy/Edit this extension is NOT applied — the user keeps the visual
                // range they actually selected.
                const effRange = rangeActionMenu.crossesBoundary
                  ? { startIndex: 0, endIndex: rangeActionMenu.range.endIndex }
                  : rangeActionMenu.range;
                const effStartUuid = rangeActionMenu.crossesBoundary
                  ? entries[0].uuid
                  : rangeActionMenu.startUuid;
                const effCount = effRange.endIndex - effRange.startIndex + 1;
                return (
                <div className="p-2 flex flex-col gap-2">
                  <div className="text-[11px] text-red-300 leading-snug">
                    {rangeActionMenu.crossesBoundary ? (
                      <>В выделении мост между файлами (compact / Context Overflow).<br/>
                      Удалить <span className="font-semibold">{effCount}</span> записей до самого начала? <span className="text-red-400/70">Действие необратимо.</span></>
                    ) : (
                      <>Удалить <span className="font-semibold">{effCount}</span> записей? <span className="text-red-400/70">Действие необратимо.</span></>
                    )}
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
                      className="flex-1 px-3 py-1.5 text-xs text-white bg-red-600/80 hover:bg-red-600 rounded transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                      onClick={(e) => {
                        e.stopPropagation();
                        executeDeleteRange(effRange, effStartUuid, rangeActionMenu.endUuid);
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
                  {supportsClaudeTimelineActions && (
                    <div className="flex rounded overflow-hidden">
                      <button
                        className="flex-1 text-left px-3 py-2 text-xs text-pink-400 hover:bg-pink-600/20 transition-colors cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          executeRangeAction('edit', rangeActionMenu.range, rangeActionMenu.startUuid, rangeActionMenu.endUuid);
                        }}
                      >
                        Редактировать
                      </button>
                      <Tooltip content="Добавить инструкцию к промпту">
                      <button
                        className="px-2 py-2 text-xs text-pink-400/60 hover:bg-pink-600/30 hover:text-pink-300 transition-colors cursor-pointer border-l border-white/10"
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
                        className="px-2 py-2 text-xs text-pink-400/60 hover:bg-pink-600/30 hover:text-pink-300 transition-colors cursor-pointer border-l border-white/10 flex items-center justify-center"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const { range, startUuid, endUuid } = rangeActionMenu;
                          // Validate same as edit mode (cross-file bridges only)
                          const rangeEntries = entries.slice(range.startIndex, range.endIndex + 1);
                          const hasCompact = rangeEntries.some(en => en.type === 'compact');
                          const hasContinued = rangeEntries.some(en => en.type === 'continued');
                          if (hasCompact || hasContinued) {
                            useUIStore.getState().showToast(
                              hasCompact
                                ? 'Нельзя редактировать диапазон с compact boundary'
                                : 'Нельзя редактировать через Context Overflow recovery — только текущий сегмент',
                              'error', 3000
                            );
                            return;
                          }
                          // Clear selection (mirror executeRangeAction)
                          selectionStartIdRef.current = null;
                          setSelectionStartId(null);
                          setRangeActionMenu(null);
                          setPostPromptMode(false);
                          // Open panel immediately with empty compactText — user types own prompt
                          if (!sessionId) return;
                          try {
                            const result = await ipcRenderer.invoke('claude:copy-range', {
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
                        }}
                      >
                        <Pencil size={11} />
                      </button>
                      </Tooltip>
                    </div>
                  )}
                  {supportsClaudeTimelineActions && (
                    <button
                      className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-600/20 rounded transition-colors cursor-pointer flex items-center gap-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteConfirmMode(true);
                      }}
                    >
                      <Trash2 size={12} />
                      Удалить историю ({rangeActionMenu.range.endIndex - rangeActionMenu.range.startIndex + 1})
                    </button>
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
        {isVisible && singleBreakdownOpen && singleTokenEstimate && singleChipEl && (() => {
          const chipRect = singleChipEl.getBoundingClientRect();
          const top = singleBreakdownFlipUp ? chipRect.top : chipRect.bottom;
          const transform = singleBreakdownFlipUp ? 'translateY(-100%)' : 'none';
          const paddingTop = singleBreakdownFlipUp ? 0 : 4;
          const paddingBottom = singleBreakdownFlipUp ? 4 : 0;

          const rows: Array<{ key: string; label: string; value: number }> = [
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
          ].filter(r => r.value > 0);

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
                  {renderBreakdownBody(singleTokenEstimate, rows)}
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
                  border: isLockedTooltip ? '1px solid #fff' : '1px solid rgba(168, 85, 247, 0.3)',
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
                                  color: canUp ? '#c084fc' : 'rgba(255,255,255,0.15)',
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
                                  color: canDown ? '#c084fc' : 'rgba(255,255,255,0.15)',
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
                                  color: noteEditPosition === opt.value ? '#c084fc' : 'rgba(255,255,255,0.3)',
                                  backgroundColor: noteEditPosition === opt.value ? 'rgba(168, 85, 247, 0.15)' : 'transparent',
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

        {/* ──── LOADING PLACEHOLDER (centred ping while initial load empty) ──── */}
        {/* Loading */}
        {isVisible && isLoading && entries.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
            <div className="w-1 h-1 bg-white animate-ping rounded-full" />
          </div>
        )}

        {/* ──── SCROLL-TO-BOTTOM ARROW (purple chevron; visibility toggled via ref to avoid re-render) ──── */}
        {/* Scroll-to-bottom arrow — always mounted, visibility toggled via ref (no re-render on scroll) */}
        {isVisible && (
          <Tooltip content="Scroll to bottom">
          <div
            ref={arrowRef}
            className="absolute left-1/2 -translate-x-1/2 cursor-pointer z-50 flex items-center justify-center"
            onClick={() => {
              if (isHistoryOpen) {
                // History panel is open — scroll history to bottom instead of timeline
                window.dispatchEvent(new CustomEvent('history-panel:scroll-to-bottom', { detail: { tabId } }));
              }
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
            }}
            style={{
              display: 'none',
              bottom: '9px',
              width: '24px',
              height: '24px',
              borderRadius: '6px',
              backgroundColor: '#323237',
              border: '1px solid rgba(167, 139, 250, 0.3)',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
            }}
          >
            <ChevronDown size={16} color="#a78bfa" strokeWidth={2.5} />
          </div>
          </Tooltip>
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

export default Timeline;
