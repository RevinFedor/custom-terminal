import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Copy, Minimize2, Pencil, Search, Trash2, StickyNote, ChevronDown, Check, Scissors, X, Zap } from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { usePromptsStore } from '../../store/usePromptsStore';
import EditRangePanel from './EditRangePanel';
import HoverBridgeDebug from '../HoverBridgeDebug';

const { ipcRenderer, clipboard } = window.require('electron');

// ════════════════════════════════════════════════════════════
// SECTION: HELPERS — module-level pure functions, types, module state
// ════════════════════════════════════════════════════════════

// True when an entry is NOT a regular user prompt — currently 'compact', 'continued',
// 'docs_edit', 'docs_search'. Used widely to skip non-user entries in nav/copy/visibility.
// If a new attribute-style entry type is ever added, update this ONE place.
function isAttributeEntry(entry: { type?: string }): boolean {
  return entry.type === 'compact' || entry.type === 'continued'
    || entry.type === 'docs_edit' || entry.type === 'docs_search';
}

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
  toolType?: 'claude' | 'gemini'; // Which AI tool this timeline is for
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

// ════════════════════════════════════════════════════════════
// SECTION: COMPONENT SETUP — props, UIStore subscriptions, state, ref declarations
// ════════════════════════════════════════════════════════════
function Timeline({ tabId, sessionId, cwd, isActive = true, isVisible = true, isOpen = true, toolType = 'claude' }: TimelineProps) {
  const isGemini = toolType === 'gemini';

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
  const [forkMarkers, setForkMarkers] = useState<ForkMarker[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [activeTooltipIndex, setActiveTooltipIndex] = useState<number | null>(null);
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
  const [copyingRange, setCopyingRange] = useState<{ startIndex: number, endIndex: number } | null>(null);
  const [copiedRange, setCopiedRange] = useState<{ startIndex: number, endIndex: number } | null>(null);
  const [visibleEntryIndices, setVisibleEntryIndices] = useState<Set<number>>(new Set());
  const [responseOnlyIndices, setResponseOnlyIndices] = useState<Set<number>>(new Set());
  const [unreachableIndices, setUnreachableIndices] = useState<Set<number>>(new Set());
  // Index of the last compact/plan-mode boundary — entries at or before this are "old history"
  const [lastBoundaryIndex, setLastBoundaryIndex] = useState(-1);
  const [clickedState, setClickedState] = useState<{ index: number; status: 'loading' | 'failed' } | null>(null);
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
    crossesBoundary: boolean;  // range hit a compact or plan-mode boundary → auto-extended to start
  } | null>(null);
  const [postPromptMode, setPostPromptMode] = useState(false);
  const [postPromptText, setPostPromptText] = useState('');
  const postPromptRef = useRef<HTMLTextAreaElement>(null);
  // Inline confirm for "Удалить историю" inside rangeActionMenu (no side panel)
  const [deleteConfirmMode, setDeleteConfirmMode] = useState(false);
  // Animation state while delete IPC is running (red overlay over the range)
  const [deletingRange, setDeletingRange] = useState<{ startIndex: number; endIndex: number } | null>(null);
  // effect: rangeActionMenu closes → reset deleteConfirmMode (prevents next popup opening in confirm state)
  useEffect(() => {
    if (!rangeActionMenu) setDeleteConfirmMode(false);
  }, [rangeActionMenu]);

  // Ref to context-menu root so we can measure its rect for the hover-bridge test.
  const contextMenuRef = useRef<HTMLDivElement>(null);

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
  const [rewindPostPromptMode, setRewindPostPromptMode] = useState(false);
  const [rewindPostPromptText, setRewindPostPromptText] = useState('');
  const rewindPostPromptRef = useRef<HTMLTextAreaElement>(null);

  // Phase 2: Collapsible groups
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Phase 3: Tree view (per-tab, persisted in UIStore)
  const treeMode = useUIStore(state => state.timelineTreeModeTabs[tabId] ?? false);
  const setTimelineTreeMode = useUIStore(state => state.setTimelineTreeMode);

  const notesPanelWidth = useUIStore(state => state.notesPanelWidth);
  const timelineTooltipWidth = useUIStore(state => state.timelineTooltipWidth);
  const setTimelineTooltipWidth = useUIStore(state => state.setTimelineTooltipWidth);
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
  const copyIncludeSubagentResult = useUIStore(state => state.copyIncludeSubagentResult);
  const copyIncludeSubagentHistory = useUIStore(state => state.copyIncludeSubagentHistory);
  const debugHoverBridges = useUIStore(state => state.debugHoverBridges);

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
    includeSubagentResult: copyIncludeSubagentResult,
    includeSubagentHistory: copyIncludeSubagentHistory,
  };
  const setHistoryScrollToUuid = useUIStore(state => state.setHistoryScrollToUuid);
  const isHistoryOpen = useUIStore(state => state.historyPanelOpenTabs[tabId] ?? false);
  const setHistoryPanelOpen = useUIStore(state => state.setHistoryPanelOpen);
  const historyVisibleUuids = useUIStore(state => state.historyVisibleUuids[tabId]);
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
      // 8px overlap so popup border kisses Timeline left edge — matches old hardcoded `- 8`.
      const next = Math.max(0, Math.round(window.innerWidth - rect.left + 8));
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

  // effect: isCmdHeld/hoveredIndex/isExpanded → setActiveTooltipIndex (CMD+hover opens; release closes unless expanded/cursor-in-tooltip/resizing)
  useEffect(() => {
    if (isCmdHeld && hoveredIndex !== null) {
      setActiveTooltipIndex(hoveredIndex);
    } else if (!isCmdHeld && !isExpanded && !isMouseInTooltipRef.current && !isResizingTooltipRef.current) {
      setActiveTooltipIndex(null);
    }
  }, [isCmdHeld, hoveredIndex, isExpanded]);

  // effect: isCmdHeld/hoveredNoteIndex/isNoteEditing/activeNoteIndex → setActiveNoteIndex (CMD+hover opens note tooltip + hides entry tooltip; release closes unless editing/cursor-in-tooltip)
  useEffect(() => {
    if (isCmdHeld && hoveredNoteIndex !== null) {
      setActiveNoteIndex(hoveredNoteIndex);
      setActiveTooltipIndex(null); // hide entry tooltip
    } else if (!isCmdHeld && !isNoteEditing && activeNoteIndex !== null && !isMouseInNoteTooltipRef.current) {
      setActiveNoteIndex(null);
    }
  }, [isCmdHeld, hoveredNoteIndex, isNoteEditing, activeNoteIndex]);

  // Fork marker tooltip: sync with CMD key — same pattern as notes
  const [hoveredForkMarkerIndex, setHoveredForkMarkerIndex] = useState<number | null>(null);
  const [activeForkMarkerIndex, setActiveForkMarkerIndex] = useState<number | null>(null);
  // effect: isCmdHeld/hoveredForkMarkerIndex/activeForkMarkerIndex → setActiveForkMarkerIndex (CMD+hover opens fork tooltip + hides entry tooltip; release closes unless cursor-in-tooltip)
  useEffect(() => {
    if (isCmdHeld && hoveredForkMarkerIndex !== null) {
      setActiveForkMarkerIndex(hoveredForkMarkerIndex);
      setActiveTooltipIndex(null); // hide entry tooltip
    } else if (!isCmdHeld && activeForkMarkerIndex !== null && !isMouseInForkTooltipRef.current) {
      setActiveForkMarkerIndex(null);
    }
  }, [isCmdHeld, hoveredForkMarkerIndex, activeForkMarkerIndex]);

  // ════════════════════════════════════════════════════════════
  // SECTION: TIMELINE DATA LOAD — loadTimeline IPC, 2s poll, session-switch cleanup, _savedEditRangeMap save/restore
  // ════════════════════════════════════════════════════════════

  // Load timeline and fork markers when sessionId changes
  const loadTimeline = useCallback(async () => {
    if (!sessionId) {
      setEntries([]);
      setForkMarkers([]);
      setExpandedGroups(new Set());
      setTimelineTreeMode(tabId, false);
      return;
    }

    setIsLoading(true);
    try {
      if (isGemini) {
        // Gemini: single IPC call, no fork markers or session chains
        const timelineResult = await ipcRenderer.invoke('gemini:get-timeline', { sessionId, cwd });
        if (timelineResult.success) {
          setEntries(timelineResult.entries);
          setSessionBoundaries([]);
          setForkMarkers([]);
        }
      } else {
        // Claude: load timeline entries and fork markers in parallel
        const [timelineResult, markersResult] = await Promise.all([
          ipcRenderer.invoke('claude:get-timeline', { sessionId, cwd }),
          ipcRenderer.invoke('claude:get-fork-markers', { sessionId })
        ]);

        if (timelineResult.success) {
          setEntries(timelineResult.entries);
          setSessionBoundaries(timelineResult.sessionBoundaries || []);

          // Detect session ID change (e.g., after "Clear Context" in plan mode)
          // Guard: prevent A→B→A→B feedback loop (circular session_links from dual-PID Bridge)
          if (timelineResult.latestSessionId && timelineResult.latestSessionId !== sessionId) {
            if (chainResolvedRef.current === timelineResult.latestSessionId) {
              // We already resolved TO this session, and now it wants to go back — cycle detected
              console.warn('[Timeline:ChainResolve] BLOCKED cycle:', sessionId.substring(0, 8), '→', timelineResult.latestSessionId.substring(0, 8), '(already resolved from there)');
            } else {
              console.warn('[Timeline:ChainResolve] OVERWRITE session for tab', tabId, ':', sessionId.substring(0, 8), '→', timelineResult.latestSessionId.substring(0, 8), '(Timeline resolved chain)');
              chainResolvedRef.current = sessionId; // remember WHERE we resolved FROM
              useWorkspaceStore.getState().setClaudeSessionId(tabId, timelineResult.latestSessionId);
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
      const notesResult = await ipcRenderer.invoke('timeline:get-notes', { sessionId });
      if (notesResult.success) {
        setNotes(notesResult.notes || {});
        setNotePositions(notesResult.positions || {});
      }
      // Load rewind markers (pink dots)
      const markersResult = await ipcRenderer.invoke('timeline:get-rewind-markers', { sessionId });
      if (markersResult.success && markersResult.markers?.length) {
        setRewindMarkers(new Set(markersResult.markers));
      }
    } catch (error) {
      console.error('[Timeline] Error loading timeline:', error);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, cwd, tabId, isGemini]);

  // effect: loadTimeline callback identity changes (sessionId/cwd/tabId/isGemini) → trigger initial timeline load
  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  // Tab switch: save editRangeState (ready/done only), reset everything else.
  // What's saved: editRangeState when phase=ready or done (user has Gemini response in panel).
  // What's NOT saved: loading (fetch aborted), applying (runs in background), all other overlays.
  // Why not save loading: abort → re-fetch created infinite loops and "plan mode" errors
  //   from stale entries. User re-selects range instead.
  const prevSessionForCleanup = useRef<string | null>(null);
  // Always-current sessionId ref — closures in async fetchEditRangeCompact capture stale prop
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
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

  // Auto-scroll timeline to bottom on initial load (when sessionId changes)
  // This ensures the user sees the latest (reachable) entries, not old red ones at the top
  const prevSessionRef = useRef<string | null>(null);
  // effect: sessionId changes + entries loaded → scrollRef.scrollTo bottom (so user sees latest reachable entries on session-switch / initial mount)
  useEffect(() => {
    if (sessionId && sessionId !== prevSessionRef.current && entries.length > 0) {
      prevSessionRef.current = sessionId;
      const el = scrollRef.current;
      console.warn(`[Timeline:AutoScroll] sessionId=${sessionId.substring(0,8)} entries=${entries.length} scrollRef=${!!el} scrollHeight=${el?.scrollHeight} clientHeight=${el?.clientHeight} scrollTop=${el?.scrollTop}`);
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
          console.warn(`[Timeline:AutoScroll] DONE scrollTo=${scrollRef.current.scrollHeight} newScrollTop=${scrollRef.current.scrollTop}`);
        }
      });
    }
  }, [sessionId, entries.length]);

  // effect: sessionId/loadTimeline/isVisible + document.visibilitychange → 2s setInterval(loadTimeline) (paused while tab hidden; PERF: avoids IPC round-trips in background — Timeline:PollPaused/Resumed logs)
  useEffect(() => {
    if (!sessionId || !isVisible) return;

    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval) return;
      interval = setInterval(loadTimeline, 2000);
    };
    const stop = (reason: string) => {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
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
        loadTimeline(); // refresh immediately so user sees fresh data on return
        start();
      } else {
        stop('visibility-hidden');
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (interval) clearInterval(interval);
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
        loadTimeline();
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
    if (isGemini || entries.length === 0) return;
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
  }, [entries, tabId, isGemini]);

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

    // History panel open — UUID-based visibility, no unreachable zone
    if (isHistoryOpen) {
      setUnreachableIndices(prev => prev.size === 0 ? prev : new Set());
      setResponseOnlyIndices(prev => prev.size === 0 ? prev : new Set());

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
    // Gemini exception: compact does NOT clear the terminal buffer — history stays visible.
    // Only Claude uses compact as a boundary. Plan-mode is Claude-only too.
    let lastBoundaryIdx = -1;
    if (!isGemini) {
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

      if (isGemini) {
        // Gemini: single-pass anchored buffer scan
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
              console.warn(`[Timeline:GeminiDiag] MISS entry#${sd.entryIndex} type=${entries[sd.entryIndex].type} searchLines=${JSON.stringify(sd.searchLines)}`);
            }
          });
          const found = rows.filter(r => r >= 0).length;
          const missed = rows.filter(r => r < 0).length;
          if (missed > 0) {
            console.warn(`[Timeline:GeminiDiag] positions: ${found} found, ${missed} missed, total=${searchData.length}, lastBoundaryIdx=${lastBoundaryIdx}`);
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

      if (isGemini && newUnreachable.size > 0) {
        console.warn(`[Timeline:GeminiDiag] unreachable=[${[...newUnreachable].join(',')}] terminal=${canDetermineReachability} lastBoundaryIdx=${lastBoundaryIdx} entries=${entries.length}`);
        [...newUnreachable].forEach(idx => {
          const e = entries[idx];
          console.warn(`[Timeline:GeminiDiag]   #${idx} type=${e.type} isPlan=${e.isPlan} content=${JSON.stringify(e.content?.substring(0, 60))}`);
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
  }, [tabId, entries, isVisible, isGemini, isHistoryOpen, historyVisibleUuids]);

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

        // Auto-extend to the very beginning of Timeline when the range hits a boundary
        // (compact entry or different sessionIds — Plan Mode/Clear Context). Editing
        // across boundaries is not supported (different JSONL files), so for Delete we
        // always operate on a contiguous prefix instead of trying to splice across files.
        const sliced = entries.slice(range.startIndex, range.endIndex + 1);
        const hasCompactInRange = sliced.some(en => en.type === 'compact');
        const sids = new Set(sliced.map(en => en.sessionId).filter(Boolean));
        const crossesBoundary = hasCompactInRange || sids.size > 1;
        if (crossesBoundary) range.startIndex = 0;

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
    const clickIsOldHistory = lastBoundaryIndex >= 0 && index <= lastBoundaryIndex;

    // Cmd+Click (macOS) / Ctrl+Click (other) → принудительно открыть History Panel и
    // проскроллить к этой записи. Обычный клик скроллит в терминале. Mental model
    // пользователя: «обычный клик → видеть промпт в терминале; Cmd+клик → видеть его
    // в полной истории». Если панель уже открыта — поведение совпадает с обычным
    // кликом при isHistoryOpen (scroll-in-history), Cmd просто гарантирует открытие.
    if (e && (e.metaKey || e.ctrlKey)) {
      if (!isHistoryOpen) setHistoryPanelOpen(tabId, true);
      setHistoryScrollToUuid(entry.uuid);
      return;
    }

    // If history panel is open — scroll to entry in history only, skip terminal scroll
    // This includes compact/continued entries which have no terminal position but DO exist in history panel
    if (isHistoryOpen) {
      setHistoryScrollToUuid(entry.uuid);
      return;
    }

    // Old history entries are not in terminal buffer — ignore click
    if (clickIsOldHistory) return;

    // Compact/continued/docs_edit/docs_search entries have no terminal position — skip terminal scroll
    if (isAttributeEntry(entry)) return;

    // SDK tabs: no xterm buffer — dispatch event for React chat scroll
    const sdkTab = (() => { const s = useWorkspaceStore.getState(); for (const [,ws] of s.openProjects) { const t = ws.tabs.get(tabId); if (t) return t.tabType === 'claude-sdk'; } return false; })();
    if (sdkTab) {
      window.dispatchEvent(new CustomEvent('claude-sdk:scroll-to-entry', { detail: { tabId, uuid: entry.uuid, content: entry.content } }));
      setClickedState({ index, status: 'loading' });
      setTimeout(() => setClickedState(null), 300);
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

      if (isGemini) {
        // Gemini: buffer-text search with multi-line matching.
        // Gemini CLI (Ink TUI) doesn't use ❯/⏵ prompt markers,
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
      // Check: range must not cross plan mode boundaries or contain compact entries
      const rangeEntries = entries.slice(range.startIndex, range.endIndex + 1);
      const hasCompact = rangeEntries.some(e => e.type === 'compact');
      const sessionIds = new Set(rangeEntries.map(e => e.sessionId).filter(Boolean));
      const crossesPlanMode = sessionIds.size > 1;
      if (hasCompact || crossesPlanMode) {
        useUIStore.getState().showToast(
          hasCompact
            ? 'Нельзя редактировать диапазон с compact boundary'
            : 'Нельзя редактировать через план мод — только текущий сегмент',
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
      const result = await ipcRenderer.invoke('claude:copy-range', {
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
    if (isGemini) return; // Gemini не поддерживается этим путём — JSON-формат другой

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
        ws.setClaudeSessionId(tabId, '');
      } else {
        loadTimeline();
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
    const channel = isGemini ? 'gemini:copy-range' : 'claude:copy-range';
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
      {/* ──── CONTAINER (Timeline outer wrapper, 32px wide, slide-animated) ──── */}
      <div
        ref={containerRef}
        data-timeline
        className="relative flex flex-col group"
        style={{
          width: slideIn ? '32px' : '0px',
          backgroundColor: 'rgba(0, 0, 0, 0.2)',
          backdropFilter: 'blur(4px)',
          borderLeft: slideIn ? '1px solid rgba(255, 255, 255, 0.05)' : 'none',
          height: '100%',
          zIndex: 40,
          visibility: isVisible ? 'inherit' : 'hidden',
          overflow: slideIn ? 'visible' : 'hidden',
          transition: 'width 50ms ease-out',
        }}
      >
        {/* Central Axis Line (compact mode only) */}
        {!treeMode && (
          <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-white/10 -translate-x-1/2 pointer-events-none" />
        )}

        {/* Tree mode toggle removed — now controlled from InfoPanel sidebar */}

        {/* ──── SCROLL LAYER (scrollRef — vertical scroll, expands to 160px in tree mode) ──── */}
        {/* Segmented Hit-boxes — in tree mode, expands LEFT as absolute overlay */}
        <div
          ref={scrollRef}
          className="scrollbar-hide"
          style={{
            position: 'absolute' as const,
            top: 0,
            bottom: 0,
            right: 0,
            width: treeMode ? '160px' : '100%',
            opacity: isVisible ? 1 : 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            ...(treeMode ? {
              backgroundColor: 'rgba(0, 0, 0, 0.88)',
              backdropFilter: 'blur(8px)',
              borderLeft: '1px solid rgba(129, 140, 248, 0.15)',
              zIndex: 50,
            } : {}),
          }}
        >
          {/* ──── TREE-MODE CHROME (left axis line, only when treeMode true) ──── */}
          {/* Tree mode: left axis line */}
          {treeMode && (
            <div className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: '4px', backgroundColor: 'rgba(255, 255, 255, 0.08)' }} />
          )}
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
            const isOldHistory = lastBoundaryIndex >= 0 && index <= lastBoundaryIndex;

            if (isCompacted) {
              dotColor = isHovered ? '#fbbf24' : '#a67c1a';
              dotGlow = isHovered ? '0 0 10px rgba(251, 191, 36, 0.5)' : 'none';
            } else if (isContinued) {
              dotColor = isHovered ? '#f59e0b' : '#a67c1a';
              dotGlow = isHovered ? '0 0 10px rgba(245, 158, 11, 0.5)' : 'none';
            } else if (isDocsEdit) {
              dotColor = isHovered ? '#4ade80' : (isPromptVisible ? '#3cc46e' : '#2a8a4e');
              dotGlow = isHovered ? '0 0 10px rgba(74, 222, 128, 0.5)' : (isPromptVisible ? '0 0 6px rgba(74, 222, 128, 0.2)' : 'none');
            } else if (isDocsSearch) {
              dotColor = isHovered ? '#bef264' : (isPromptVisible ? '#8cb82a' : '#6a8f1e');
              dotGlow = isHovered ? '0 0 10px rgba(190, 242, 100, 0.5)' : (isPromptVisible ? '0 0 6px rgba(190, 242, 100, 0.2)' : 'none');
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
              dotColor = isHovered ? '#4ade80' : (isPromptVisible ? '#3cc46e' : '#2a8a4e');
              dotGlow = isHovered ? '0 0 10px rgba(74, 222, 128, 0.5)' : (isPromptVisible ? '0 0 6px rgba(74, 222, 128, 0.25)' : 'none');
            } else if (entry.docsSearchQueries && entry.docsSearchQueries.length > 0) {
              // User turn that triggered docs_search but no edits — lime tone
              dotColor = isHovered ? '#bef264' : (isPromptVisible ? '#8cb82a' : '#6a8f1e');
              dotGlow = isHovered ? '0 0 10px rgba(190, 242, 100, 0.5)' : (isPromptVisible ? '0 0 6px rgba(190, 242, 100, 0.25)' : 'none');
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
                    flex: `1 0 ${treeMode ? '22px' : (showAsChild ? '14px' : '20px')}`,
                    minHeight: treeMode ? '22px' : (showAsChild ? '14px' : '20px'),
                    justifyContent: treeMode ? 'flex-start' : 'center',
                    paddingLeft: treeMode
                      ? (showAsChild ? '20px' : entryIsSubAgent ? '10px' : '4px')
                      : (showAsChild ? '4px' : undefined),
                    backgroundColor: active
                      ? 'rgba(59, 130, 246, 0.15)'
                      : (isOldHistory && !isGroupMeta && !isCompacted ? 'rgba(239, 68, 68, 0.06)' : 'transparent'),
                    cursor: (isContinued || isDocsEdit || isDocsSearch || isOldHistory) ? 'default' : 'pointer',
                  }}
                >
                  {/* Tree mode: vertical connector lines */}
                  {treeMode && entryIsSubAgent && !showAsChild && (
                    <div className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: '8px', backgroundColor: 'rgba(129, 140, 248, 0.15)' }} />
                  )}
                  {treeMode && showAsChild && (
                    <div className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: '14px', backgroundColor: 'rgba(129, 140, 248, 0.1)' }} />
                  )}

                  {/* Dot */}
                  {/* Dot: hollow ring if not in buffer (current segment), filled otherwise */}
                  {/* pointer-events: auto so ПКМ на сам кружок ловится отдельно от полосы —
                      это позволяет показывать "Копировать compact" только когда клик был
                      именно по кружку (а не по сегменту-полоске). */}
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

                  {/* Phase 3: Tree mode label */}
                  {treeMode && !isExpandedHeader && (
                    <span
                      className="ml-1 truncate pointer-events-none select-none flex-1 min-w-0"
                      style={{
                        fontSize: '9px',
                        lineHeight: '1.2',
                        color: entryIsTimeout
                          ? 'rgba(239, 68, 68, 0.5)'
                          : entryIsSubAgent
                            ? 'rgba(129, 140, 248, 0.5)'
                            : isDocsEdit
                              ? 'rgba(74, 222, 128, 0.5)'
                              : isDocsSearch
                                ? 'rgba(190, 242, 100, 0.5)'
                                : 'rgba(255, 255, 255, 0.4)',
                      }}
                    >
                      {isGroupCollapsed
                        ? <>{groupInfo!.agentName} <span style={{ color: 'rgba(129, 140, 248, 0.9)' }}>×{groupInfo!.groupSize}</span></>
                        : entryIsTimeout
                          ? 'timeout'
                          : entryIsSubAgent
                            ? (entry.subAgentName || 'Claude')
                            : isDocsEdit
                              ? truncateText(entry.content, 60)
                              : isDocsSearch
                                ? truncateText(entry.content, 60)
                                : isCompacted
                                ? 'compact'
                                : truncateText(entry.content, 60)
                      }
                    </span>
                  )}

                  {/* Loading spinner */}
                  {dotClickState === 'loading' && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div
                        className="w-2 h-2 rounded-full bg-blue-400 animate-glow-blue shadow-[0_0_8px_rgba(96,165,250,0.6)]"
                      />
                    </div>
                  )}
                  {/* Failed X */}
                  {dotClickState === 'failed' && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.7 }}>
                        <line x1="2" y1="2" x2="8" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                        <line x1="8" y1="2" x2="2" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </div>
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
                {/* Last boundary separator — full-width unified line between old history and current dialog */}
                {index === lastBoundaryIndex && (
                  <Tooltip content="Current session starts below">
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center"
                    style={{ height: '8px' }}
                  >
                    <div
                      style={{
                        width: '100%',
                        height: '1px',
                        backgroundColor: 'rgba(255, 255, 255, 0.2)',
                      }}
                    />
                  </div>
                  </Tooltip>
                )}
                {/* Fork marker (only outside old history zone — inside it's redundant) */}
                {forkMarker && !isOldHistory && (
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center"
                    style={{ height: '8px', cursor: isCmdHeld ? 'pointer' : 'default', padding: '6px 0', boxSizing: 'content-box' }}
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
                  </div>
                )}
                {/* Plan mode marker (only outside old history zone) */}
                {isPlanModeBoundary && !isOldHistory && (
                  <Tooltip content="Plan mode - context was cleared here">
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center"
                    style={{ height: '8px' }}
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
                  </div>
                  </Tooltip>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* ──── INNER-WRAPPER OVERLAYS (rangeActionMenu indicator, selection preview, copy/delete/rewind/edit-range pulses with StatusLabelPortal) ──── */}
        {/* Selected Range Indicator (static, when action menu is open) */}
        {isVisible && rangeActionMenu && (() => {
          const rect = getOverlayRect(rangeActionMenu.range.startIndex, rangeActionMenu.range.endIndex);
          return rect && (
            <div
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: rect.top,
                height: rect.height,
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                borderTop: '1px solid rgba(59, 130, 246, 0.4)',
                borderBottom: '1px solid rgba(59, 130, 246, 0.4)',
                boxShadow: '0 0 8px rgba(59, 130, 246, 0.2)',
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
              onMouseEnter={() => { isMouseInTooltipRef.current = true; }}
              onMouseLeave={(e) => { if (!isResizingTooltipRef.current) { isMouseInTooltipRef.current = false; handleMouseLeaveTooltipArea(); } }}
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
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '6px 0 0 6px',
                  padding: '10px 14px',
                  fontSize: '12px',
                  color: 'white',
                  width: `${timelineTooltipWidth}px`,
                  maxHeight: isExpanded ? '60vh' : '200px',
                  boxShadow: '-8px 8px 30px rgba(255,255,255,0.08), -2px 2px 8px rgba(255,255,255,0.05)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
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
                {currentActiveEntry.type === 'compact' ? (
                  <span className="text-amber-400 font-medium">History Compacted ({currentActiveEntry.preTokens ? `${Math.round(currentActiveEntry.preTokens/1000)}k` : '?'} tokens)</span>
                ) : currentActiveEntry.type === 'continued' ? (
                  <>
                    <span className="text-amber-400 font-medium shrink-0">Context Overflow Recovery</span>
                    <div className="text-white/70 leading-snug font-mono text-[11px] scrollbar-thin" style={{ maxHeight: isExpanded ? 'calc(60vh - 80px)' : '120px', overflowY: 'auto', overflowX: 'hidden', whiteSpace: 'pre-wrap' }}>
                      {currentActiveEntry.content}
                    </div>
                    <div className="flex items-center mt-1 pt-2 border-t border-white/5 shrink-0">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      <div className="flex-1" />
                      {(currentActiveEntry.content.length > 200 || isExpanded) && (
                        <Tooltip content={isExpanded ? "Свернуть" : "Развернуть полностью"}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                          className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors cursor-pointer shrink-0"
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
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#4ade80', flexShrink: 0 }} />
                      <span style={{ color: '#4ade80' }} className="font-medium text-[11px]">Docs Updated</span>
                    </div>
                    <div className="text-white/70 leading-snug font-mono text-[11px]" style={{ whiteSpace: 'pre-wrap' }}>
                      {(currentActiveEntry.docsEdited || [currentActiveEntry.content]).map((f: string, i: number) => (
                        <div key={i} className="flex items-center gap-1.5 py-0.5">
                          <Pencil size={10} className="shrink-0" style={{ color: 'rgba(74, 222, 128, 0.5)' }} />
                          <span>{f}</span>
                        </div>
                      ))}
                    </div>
                    <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                  </>
                ) : currentActiveEntry.type === 'docs_search' ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#bef264', flexShrink: 0 }} />
                      <span style={{ color: '#bef264' }} className="font-medium text-[11px]">Docs Search</span>
                    </div>
                    <div className="text-white/70 leading-snug font-mono text-[11px]" style={{ whiteSpace: 'pre-wrap' }}>
                      {(currentActiveEntry.docsSearchQueries || [currentActiveEntry.content]).map((q: string, i: number) => (
                        <div key={i} className="flex items-center gap-1.5 py-0.5">
                          <Search size={10} className="shrink-0" style={{ color: 'rgba(190, 242, 100, 0.5)' }} />
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
                    <div className="text-white/70 leading-snug font-mono text-[11px] scrollbar-thin" style={{ maxHeight: isExpanded ? 'calc(60vh - 80px)' : '120px', overflowY: 'auto', overflowX: 'hidden', whiteSpace: 'pre-wrap' }}>
                      {currentActiveEntry.content}
                    </div>
                    <div className="flex items-center mt-1 pt-2 border-t border-white/5 shrink-0">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      {isCmdHeld && (
                        <span className="flex items-center gap-1 ml-2 text-[10px]" style={{ color: '#e8a955' }}>
                          <Zap size={10} />
                          <span>↑{formatTokenCount(Math.ceil(currentActiveEntry.content.length / 3.5))}</span>
                          {currentActiveEntry.responseTokens && <span>↓{formatTokenCount(currentActiveEntry.responseTokens)}</span>}
                        </span>
                      )}
                      <div className="flex-1" />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          clipboard.writeText(currentActiveEntry.content);
                          setTooltipCopied(true);
                          setTimeout(() => setTooltipCopied(false), 1200);
                        }}
                        className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-[10px] transition-colors cursor-pointer"
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
                    <div className="text-white/70 leading-snug font-mono text-[11px] scrollbar-thin" style={{ maxHeight: isExpanded ? 'calc(60vh - 80px)' : '120px', overflowY: 'auto', overflowX: 'hidden', whiteSpace: 'pre-wrap' }}>
                      {currentActiveEntry.content}
                    </div>
                    <div className="flex items-center mt-1 pt-2 border-t border-white/5 shrink-0">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      {isCmdHeld && (
                        <span className="flex items-center gap-1 ml-2 text-[10px]" style={{ color: '#e8a955' }}>
                          <Zap size={10} />
                          <span>↑{formatTokenCount(Math.ceil(currentActiveEntry.content.length / 3.5))}</span>
                          {currentActiveEntry.responseTokens && <span>↓{formatTokenCount(currentActiveEntry.responseTokens)}</span>}
                        </span>
                      )}
                      <div className="flex-1" />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          clipboard.writeText(currentActiveEntry.content);
                          setTooltipCopied(true);
                          setTimeout(() => setTooltipCopied(false), 1200);
                        }}
                        className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-[10px] transition-colors cursor-pointer"
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
                        <div className="flex items-center mt-0.5 text-[10px] shrink-0">
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
                        <div className="pb-1.5 mb-1.5 border-b border-green-500/15 shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedDocsEdit(prev => {
                                const next = new Set(prev);
                                if (next.has(uuid)) next.delete(uuid); else next.add(uuid);
                                return next;
                              });
                            }}
                            className="w-full text-left flex items-center gap-1.5 hover:bg-green-500/5 rounded px-0.5 py-0.5 cursor-pointer"
                            style={{ color: 'rgba(74, 222, 128, 0.9)' }}
                          >
                            <Pencil size={10} className="shrink-0" style={{ color: '#4ade80' }} />
                            <span className="leading-snug font-mono text-[10px] flex-1 font-medium">
                              Docs updated ({files.length})
                            </span>
                          </button>
                          {open && (
                            <div className="mt-1 ml-4 leading-snug font-mono text-[10px]" style={{ color: 'rgba(74, 222, 128, 0.85)' }}>
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
                        <div className="pb-1.5 mb-1.5 border-b border-lime-500/15 shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedDocsSearch(prev => {
                                const next = new Set(prev);
                                if (next.has(uuid)) next.delete(uuid); else next.add(uuid);
                                return next;
                              });
                            }}
                            className="w-full text-left flex items-start gap-1.5 hover:bg-lime-500/5 rounded px-0.5 py-0.5 cursor-pointer"
                            style={{ color: 'rgba(190, 242, 100, 0.9)' }}
                          >
                            <Search size={10} className="shrink-0 mt-0.5" style={{ color: '#bef264' }} />
                            <span className="leading-snug font-mono text-[10px] flex-1">
                              <span className="font-medium">Docs search ({queries.length})</span>
                            </span>
                          </button>
                          {open && (
                            <div className="mt-1 ml-4 leading-snug font-mono text-[10px]" style={{ color: 'rgba(190, 242, 100, 0.85)' }}>
                              {queries.map((q: string, i: number) => (
                                <div key={i} className="break-words" style={{ opacity: 0.85 }}>«{q}»</div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    <div className="text-white/90 leading-snug font-mono scrollbar-thin" style={{ maxHeight: isExpanded ? 'calc(60vh - 80px)' : '120px', overflowY: 'auto', overflowX: 'hidden', whiteSpace: 'pre-wrap' }}>
                      {currentActiveEntry.content}
                    </div>
                    <div className="flex items-center mt-1 pt-2 border-t border-white/5 shrink-0">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      {isCmdHeld && (
                        <span className="flex items-center gap-1 ml-2 text-[10px]" style={{ color: '#e8a955' }}>
                          <Zap size={10} />
                          <span>↑{formatTokenCount(Math.ceil(currentActiveEntry.content.length / 3.5))}</span>
                          {currentActiveEntry.responseTokens && <span>↓{formatTokenCount(currentActiveEntry.responseTokens)}</span>}
                        </span>
                      )}
                      <div className="flex-1" />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          clipboard.writeText(currentActiveEntry.content);
                          setTooltipCopied(true);
                          setTimeout(() => setTooltipCopied(false), 1200);
                        }}
                        className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-[10px] transition-colors cursor-pointer"
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
                        <div className="flex items-center mt-0.5 text-[10px] shrink-0">
                          <span style={{ color: md.color }}>{md.provider} · {md.short}</span>
                          {currentActiveEntry.responseHasThinking && <span className="ml-1.5" style={{ color: '#b4b9f9' }}>· think</span>}
                        </div>
                        </Tooltip>
                      );
                    })()}
                  </>
                )}
              </div>
              {/* CSS Bridge — stretches full wrapper height, connects tooltip to entry */}
              <div
                style={{
                  width: '8px',
                  alignSelf: 'stretch',
                  // background: 'rgba(255,0,0,0.15)', // Uncomment for debug
                }}
              />
            </div>
          </TooltipPortal>
        )}

        {/* ──── EDIT-RANGE LOADING MENU PORTAL (right-click on pink loading overlay → Interrupt/Cancel) ──── */}
        {/* Edit Range Loading Context Menu (right-click on pink overlay) */}
        {editRangeLoadingMenu && editRangeState?.phase === 'loading' && (
          <TooltipPortal>
            <div
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
                  {/* Rewind — Claude & Gemini */}
                  <div className="border-t border-white/10 my-1" />
                  {!rewindPostPromptMode ? (
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
                  )}
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
              onMouseLeave={() => {
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
              {deleteConfirmMode ? (
                <div className="p-2 flex flex-col gap-2">
                  <div className="text-[11px] text-red-300 leading-snug">
                    {rangeActionMenu.crossesBoundary ? (
                      <>Удалить <span className="font-semibold">{rangeActionMenu.range.endIndex - rangeActionMenu.range.startIndex + 1}</span> записей до самого начала?<br/>
                      <span className="text-[10px] text-red-400/70">Действие необратимо.</span></>
                    ) : (
                      <>Удалить <span className="font-semibold">{rangeActionMenu.range.endIndex - rangeActionMenu.range.startIndex + 1}</span> записей? <span className="text-red-400/70">Действие необратимо.</span></>
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
                        executeDeleteRange(rangeActionMenu.range, rangeActionMenu.startUuid, rangeActionMenu.endUuid);
                      }}
                    >
                      <Trash2 size={12} />
                      Удалить
                    </button>
                  </div>
                </div>
              ) : !postPromptMode ? (
                <>
                  {/* Token summary for selected range */}
                  {(() => {
                    const { startIndex, endIndex } = rangeActionMenu.range;
                    let upTotal = 0, downTotal = 0;
                    for (let i = startIndex; i <= endIndex && i < entries.length; i++) {
                      upTotal += Math.ceil(entries[i].content.length / 3.5);
                      downTotal += (entries[i].responseTokens || 0);
                    }
                    return (upTotal > 0 || downTotal > 0) ? (
                      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] border-b border-white/5" style={{ color: '#e8a955' }}>
                        <Zap size={10} />
                        <span>↑{formatTokenCount(upTotal)}</span>
                        {downTotal > 0 && <span>↓{formatTokenCount(downTotal)}</span>}
                      </div>
                    ) : null;
                  })()}
                  {rangeActionMenu.crossesBoundary && (
                    <div className="px-3 py-1.5 text-[10px] text-red-300/80 border-b border-red-500/20 bg-red-500/5">
                      В выделении граница (compact / Plan Mode) — удаление сотрёт всю историю до начала.
                    </div>
                  )}
                  {!rangeActionMenu.crossesBoundary && (
                    <button
                      className="w-full text-left px-3 py-2 text-xs text-white hover:bg-blue-600/80 rounded transition-colors cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        executeRangeAction('copy', rangeActionMenu.range, rangeActionMenu.startUuid, rangeActionMenu.endUuid);
                      }}
                    >
                      Копировать ({rangeActionMenu.range.endIndex - rangeActionMenu.range.startIndex + 1})
                    </button>
                  )}
                  {!isGemini && !rangeActionMenu.crossesBoundary && (
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
                          // Validate same as edit mode
                          const rangeEntries = entries.slice(range.startIndex, range.endIndex + 1);
                          const hasCompact = rangeEntries.some(en => en.type === 'compact');
                          const sessionIds = new Set(rangeEntries.map(en => en.sessionId).filter(Boolean));
                          if (hasCompact || sessionIds.size > 1) {
                            useUIStore.getState().showToast(
                              hasCompact
                                ? 'Нельзя редактировать диапазон с compact boundary'
                                : 'Нельзя редактировать через план мод — только текущий сегмент',
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
                  {!isGemini && (
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

        {/* ──── FORK-MARKER TOOLTIP PORTAL (blue fork stripe → source session + delete-marker button) ──── */}
        {/* Fork Marker Tooltip Portal */}
        {isVisible && activeForkMarkerIndex !== null && activeForkMarker && forkTooltipPos && (
          <TooltipPortal>
            <div
              ref={forkTooltipRef}
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={() => { isMouseInForkTooltipRef.current = true; }}
              onMouseLeave={() => {
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
                  border: '1px solid rgba(59, 130, 246, 0.3)',
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
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={() => { isMouseInNoteTooltipRef.current = true; }}
              onMouseLeave={(e) => { isMouseInNoteTooltipRef.current = false; handleMouseLeaveNoteTooltip(); }}
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
                  border: '1px solid rgba(168, 85, 247, 0.3)',
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
    </>
  );
}

export default Timeline;
