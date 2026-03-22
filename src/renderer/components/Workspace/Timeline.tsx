import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Copy, Minimize2, Pencil, Trash2, StickyNote, ChevronDown } from 'lucide-react';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { usePromptsStore } from '../../store/usePromptsStore';
import EditRangePanel from './EditRangePanel';

const { ipcRenderer, clipboard } = window.require('electron');

// Portal for tooltip to escape overflow:hidden
const TooltipPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return createPortal(children, document.body);
};

interface TimelineEntry {
  uuid: string;
  type: 'user' | 'compact' | 'continued' | 'docs_edit';
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

function Timeline({ tabId, sessionId, cwd, isActive = true, isVisible = true, isOpen = true, toolType = 'claude' }: TimelineProps) {
  const isGemini = toolType === 'gemini';

  // Slide animation (matches HistoryPanel pattern)
  const [slideIn, setSlideIn] = useState(isOpen);
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
  const [selectionStartId, setSelectionStartId] = useState<string | null>(null);
  const selectionStartIdRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, entry: TimelineEntry } | null>(null);
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
  const [editRangeState, setEditRangeState] = useState<{
    range: { startIndex: number; endIndex: number };
    phase: 'loading' | 'ready' | 'applying' | 'done';
    sourceContent: string;
    compactText: string;
    compactUuid?: string; // UUID of the inserted compact entry (after apply)
  } | null>(null);
  // Range action menu — appears after second click to choose Copy or Edit
  const [rangeActionMenu, setRangeActionMenu] = useState<{
    x: number; y: number;
    range: { startIndex: number; endIndex: number };
    startUuid: string; endUuid: string;
  } | null>(null);

  // Phase 2: Collapsible groups
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Phase 3: Tree view (per-tab, persisted in UIStore)
  const treeMode = useUIStore(state => state.timelineTreeModeTabs[tabId] ?? false);
  const setTimelineTreeMode = useUIStore(state => state.setTimelineTreeMode);

  const notesPanelWidth = useUIStore(state => state.notesPanelWidth);
  const copyIncludeEditing = useUIStore(state => state.copyIncludeEditing);
  const copyIncludeReading = useUIStore(state => state.copyIncludeReading);
  const setHistoryScrollToUuid = useUIStore(state => state.setHistoryScrollToUuid);
  const isHistoryOpen = useUIStore(state => state.historyPanelOpenTabs[tabId] ?? false);
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

  // Timeline notes state
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notePositions, setNotePositions] = useState<Record<string, 'dot' | 'before' | 'after'>>({});
  const [activeNoteIndex, setActiveNoteIndex] = useState<number | null>(null);
  const [isNoteEditing, setIsNoteEditing] = useState(false);
  const [noteEditText, setNoteEditText] = useState('');
  const [noteEditPosition, setNoteEditPosition] = useState<'dot' | 'before' | 'after'>('before');
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);
  const noteTooltipRef = useRef<HTMLDivElement>(null);
  const [hoveredNoteIndex, setHoveredNoteIndex] = useState<number | null>(null);

  // Lock timeline scroll when edit range panel is open
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !editRangeState) return;
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener('wheel', prevent, { passive: false });
    el.addEventListener('touchmove', prevent, { passive: false });
    return () => {
      el.removeEventListener('wheel', prevent);
      el.removeEventListener('touchmove', prevent);
    };
  }, [!!editRangeState]);

  // Compute group map for sub-agent entries (Phase 2)
  const groupMap = useMemo(() => computeGroups(entries), [entries]);
  // Count visible nodes (entries minus hidden group children)
  const hasSubAgentGroups = useMemo(() => {
    for (const [, g] of groupMap) {
      if (g.isGroupHeader) return true;
    }
    return false;
  }, [groupMap]);

  // Custom scroll indicator: track scroll position on the scrollable div
  // Custom scroll indicator: direct DOM updates (no React re-render on scroll)
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

  // Adjust segmentRefs length
  useEffect(() => {
    segmentRefs.current = segmentRefs.current.slice(0, entries.length);
  }, [entries]);

  const getElementCenterY = (index: number) => {
    const el = segmentRefs.current[index];
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return rect.top + rect.height / 2;
  };

  // Reset expansion when tooltip target changes
  useEffect(() => {
    setIsExpanded(false);
  }, [activeTooltipIndex]);

  // CMD key tracking — tooltip only appears when CMD is held
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

  // Sync tooltip with CMD key state: show when CMD pressed during hover, hide when released
  // Do NOT close if cursor is inside the tooltip (user is interacting with buttons)
  useEffect(() => {
    if (isCmdHeld && hoveredIndex !== null) {
      setActiveTooltipIndex(hoveredIndex);
    } else if (!isCmdHeld && !isExpanded && !isMouseInTooltipRef.current) {
      setActiveTooltipIndex(null);
    }
  }, [isCmdHeld, hoveredIndex, isExpanded]);

  // Note tooltip: sync with CMD key — open when CMD pressed while hovering strip, close when released
  useEffect(() => {
    if (isCmdHeld && hoveredNoteIndex !== null) {
      setActiveNoteIndex(hoveredNoteIndex);
      setActiveTooltipIndex(null); // hide entry tooltip
    } else if (!isCmdHeld && !isNoteEditing && activeNoteIndex !== null && !isMouseInNoteTooltipRef.current) {
      setActiveNoteIndex(null);
    }
  }, [isCmdHeld, hoveredNoteIndex, isNoteEditing, activeNoteIndex]);

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
          // Keep: source === sessionId (forks FROM me)
          // Keep: ONE marker where forked_to === sessionId with most entry_uuids (direct parent fork point)
          // Hide: other inherited markers where forked_to === sessionId
          const all = markersResult.markers || [];
          const fromMe = all.filter((m: ForkMarker) => m.source_session_id === sessionId);
          // Find the direct parent marker (largest snapshot = most recent fork)
          const toMe = all.filter((m: ForkMarker) => m.fork_session_id === sessionId);
          let directParent: ForkMarker | null = null;
          for (const m of toMe) {
            if (!directParent || (m.entry_uuids?.length || 0) > (directParent.entry_uuids?.length || 0)) {
              directParent = m;
            }
          }
          const markers = directParent ? [...fromMe, directParent] : fromMe;
          setForkMarkers(markers);
        }
      }
      // Load notes for this session (works for both Claude and Gemini)
      const notesResult = await ipcRenderer.invoke('timeline:get-notes', { sessionId });
      if (notesResult.success) {
        setNotes(notesResult.notes || {});
        setNotePositions(notesResult.positions || {});
      }
    } catch (error) {
      console.error('[Timeline] Error loading timeline:', error);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, cwd, tabId, isGemini]);

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  // Auto-scroll timeline to bottom on initial load (when sessionId changes)
  // This ensures the user sees the latest (reachable) entries, not old red ones at the top
  const prevSessionRef = useRef<string | null>(null);
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

  // Refresh timeline periodically (only when visible)
  useEffect(() => {
    if (!sessionId || !isVisible) return;
    // Refresh every 2 seconds to catch Escape/Undo changes quickly
    const interval = setInterval(loadTimeline, 2000);
    return () => clearInterval(interval);
  }, [sessionId, loadTimeline, isVisible]);

  // Listen for manual refresh requests from InfoPanel
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

  // Listen for scroll-to-bottom requests (e.g., when "Continue" is pressed)
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

  // Bind timeline entries to prompt boundary markers (OSC 7777 from main.js).
  // Entry N (user message) maps to prompt boundary N (the prompt shown after response N,
  // where the next message will be typed). Sequence 0 = after first response.
  // Entries without markers will fall back to SearchAddon navigation.
  useEffect(() => {
    if (isGemini || entries.length === 0) return;
    const boundaryCount = terminalRegistry.getPromptBoundaryCount(tabId);
    if (boundaryCount === 0) return;

    // User-type entries only (skip compact, continued, docs_edit)
    let promptSeq = 0;
    for (const entry of entries) {
      if (entry.type === 'compact' || entry.type === 'continued' || entry.type === 'docs_edit') continue;
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

  // Viewport visibility + buffer reachability tracking
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
          if (entry.type === 'compact' || entry.type === 'continued' || entry.type === 'docs_edit') return;
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

        // Collect indices of "real" entries (non-compact, non-continued, non-docs_edit) after lastBoundaryIdx
        const realIndices: number[] = [];
        entries.forEach((entry, index) => {
          if (index <= lastBoundaryIdx) return;
          if (entry.type === 'compact' || entry.type === 'continued' || entry.type === 'docs_edit') return;
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
        if (entry.type === 'compact' || entry.type === 'continued' || entry.type === 'docs_edit' || entry.isPlan) return;
        if (index <= lastBoundaryIdx) {
          newUnreachable.add(index);
          return;
        }
        if (canDetermineReachability && positions[index] < 0) {
          newUnreachable.add(index);
        }
      });

      // Inherit unreachable for compact/continued/plan/docs_edit entries from next regular entry
      entries.forEach((entry, index) => {
        if (entry.type !== 'compact' && entry.type !== 'continued' && entry.type !== 'docs_edit' && !entry.isPlan) return;
        if (index <= lastBoundaryIdx) {
          newUnreachable.add(index);
          return;
        }
        for (let j = index + 1; j < entries.length; j++) {
          const next = entries[j];
          if (next.type === 'compact' || next.type === 'continued' || next.type === 'docs_edit' || next.isPlan) continue;
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
  const isMouseInNoteTooltipRef = useRef(false);
  const tooltipMeasuredRef = useRef(0);
  const [tooltipMeasuredH, setTooltipMeasuredH] = useState(0);

  // Measure actual tooltip height (before paint) to size wrapper precisely
  useLayoutEffect(() => {
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
  }, [activeTooltipIndex, isExpanded]);

  // Dismiss tooltip on any mousedown outside tooltip content
  // Handles: dead zone clicks, scrollbar grabs, clicks elsewhere
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
        // else: mouse is at tooltip height — keep open so user can reach it
      }
    } else if (!wentLeft && !isExpanded) {
      setActiveTooltipIndex(null);
    }
  };

  // Simple hover close - CSS bridge handles the gap, no complex JS needed
  const handleMouseLeaveTooltipArea = () => {
    if (!isExpanded) {
      setHoveredIndex(null);
      setActiveTooltipIndex(null);
    }
  };

  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const justSetRangeMenuRef = useRef(false);

  const handleEntryClick = (entry: TimelineEntry, e?: React.MouseEvent) => {
    // Если режим выделения активен — показываем меню выбора действия
    if (selectionStartIdRef.current) {
      if (selectionStartIdRef.current === entry.uuid) {
        // Клик по той же точке → отменить выделение
        selectionStartIdRef.current = null;
        setSelectionStartId(null);
      } else {
        // Клик по другой точке → показать popup "Копировать / Редактировать"
        const startId = selectionStartIdRef.current;
        const startIndex = entries.findIndex(e => e.uuid === startId);
        const endIndex = entries.findIndex(e => e.uuid === entry.uuid);
        const range = {
          startIndex: Math.min(startIndex, endIndex),
          endIndex: Math.max(startIndex, endIndex),
        };

        // Get click position from the entry's DOM element
        const el = segmentRefs.current[Math.max(startIndex, endIndex)];
        const containerRect = containerRef.current?.getBoundingClientRect();
        let x = containerRect ? containerRect.left - 170 : 100;
        let y = el ? el.getBoundingClientRect().top : 100;

        // Clamp to viewport
        if (x < 10) x = 10;
        if (y + 80 > window.innerHeight) y = window.innerHeight - 90;

        // Prevent handleClickOutside from immediately clearing the menu
        justSetRangeMenuRef.current = true;
        if (e) e.stopPropagation();

        setRangeActionMenu({
          x, y, range,
          startUuid: entries[range.startIndex].uuid,
          endUuid: entries[range.endIndex].uuid,
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

    // If history panel is open — scroll to entry in history only, skip terminal scroll
    // This includes compact/continued entries which have no terminal position but DO exist in history panel
    if (isHistoryOpen) {
      setHistoryScrollToUuid(entry.uuid);
      return;
    }

    // Old history entries are not in terminal buffer — ignore click
    if (clickIsOldHistory) return;

    // Compact/continued/docs_edit entries have no terminal position — skip terminal scroll
    if (entry.type === 'compact' || entry.type === 'continued' || entry.type === 'docs_edit') return;

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

  const handleRightClick = (e: React.MouseEvent, entry: TimelineEntry) => {
    e.preventDefault();

    // Context menu dimensions (approximate)
    const menuWidth = 160;
    const menuHeight = selectionStartIdRef.current ? 40 : 90;

    // Position: right-center of cursor
    let x = e.pageX + 4;
    let y = e.pageY - menuHeight / 2;

    // Check right boundary
    if (x + menuWidth > window.innerWidth) {
      x = e.pageX - menuWidth - 8;
    }

    // Check bottom boundary
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 10;
    }

    // Check top boundary
    if (y < 10) {
      y = 10;
    }

    setContextMenu({ x, y, entry });
  };

  const startRangeSelection = (entry: TimelineEntry) => {
    selectionStartIdRef.current = entry.uuid;
    setSelectionStartId(entry.uuid);
    setContextMenu(null);
  };

  const executeRangeAction = async (mode: 'copy' | 'edit', range: { startIndex: number; endIndex: number }, startUuid: string, endUuid: string) => {
    if (!sessionId) return;

    // Clear selection
    selectionStartIdRef.current = null;
    setSelectionStartId(null);
    setRangeActionMenu(null);

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
          includeEditing: copyIncludeEditing,
          includeReading: copyIncludeReading,
        });

        if (!result.success) {
          setEditRangeState(null);
          return;
        }

        const sourceContent = result.content;

        // Send to Gemini API with rewind prompt
        const { getPromptById, rewindPromptId } = usePromptsStore.getState();
        const promptConfig = getPromptById(rewindPromptId);

        if (!promptConfig) {
          console.warn('[EditRange] No rewind prompt configured');
          setEditRangeState(null);
          return;
        }

        const apiKey = process.env.GEMINI_API_KEY || 'REDACTED_GEMINI_KEY';
        const model = promptConfig.model;
        const fullPrompt = promptConfig.content + sourceContent;

        const requestBody: any = {
          contents: [{ parts: [{ text: fullPrompt }] }],
        };

        if (model.includes('gemini-3') && promptConfig.thinkingLevel !== 'NONE') {
          requestBody.generationConfig = {
            thinkingConfig: { thinkingLevel: promptConfig.thinkingLevel }
          };
        }

        console.warn('[EditRange] Sending to Gemini, model:', model);
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
          }
        );

        const data = await response.json();
        const compactText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        if (!compactText) {
          console.error('[EditRange] Gemini returned empty response');
          setEditRangeState(null);
          return;
        }

        console.warn('[EditRange] Compact ready, length:', compactText.length);
        setEditRangeState({ range, phase: 'ready', sourceContent, compactText });

      } catch (err: any) {
        console.error('[EditRange] Failed:', err);
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
        includeEditing: copyIncludeEditing,
        includeReading: copyIncludeReading,
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

  const isSelected = (entry: TimelineEntry, index: number) => {
    if (!selectionStartId) return false;
    const startIndex = entries.findIndex(e => e.uuid === selectionStartId);
    if (startIndex === -1) return false;
    
    const min = Math.min(startIndex, hoveredIndex ?? activeTooltipIndex ?? startIndex);
    const max = Math.max(startIndex, hoveredIndex ?? activeTooltipIndex ?? startIndex);
    
    const currentIndex = entries.findIndex(e => e.uuid === entry.uuid);
    return currentIndex >= min && currentIndex <= max;
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      setContextMenu(null);
      // Close expanded tooltip on outside click
      if (isExpanded) {
        setIsExpanded(false);
        setActiveTooltipIndex(null);
      }
      // Close note editing on outside click
      if (isNoteEditing) {
        setIsNoteEditing(false);
        setActiveNoteIndex(null);
      }
      // Close range action menu on outside click (skip if just opened)
      if (justSetRangeMenuRef.current) {
        justSetRangeMenuRef.current = false;
      } else {
        setRangeActionMenu(null);
      }
      // Cancel range selection if clicking outside timeline
      if (selectionStartIdRef.current && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        selectionStartIdRef.current = null;
        setSelectionStartId(null);
      }
    };
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, [isExpanded, isNoteEditing]);

  const handleRewind = async (entry: TimelineEntry) => {
    setContextMenu(null);
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
          const apiKey = (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) || 'REDACTED_GEMINI_KEY';
          const model = promptConfig.model;
          const fullPrompt = promptConfig.content + rangeResult.content;

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

  // ── Note handlers ──

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

  const currentActiveEntry = activeTooltipIndex !== null ? entries[activeTooltipIndex] : null;

  // Compute tooltip wrapper position — uses measured height for precision
  const tooltipPos = activeTooltipIndex !== null ? (() => {
    const eCenterY = getElementCenterY(activeTooltipIndex);
    const approxH = isExpanded ? 400 : 200;
    // Use measured height when available, fallback to estimate
    const h = tooltipMeasuredH > 0 ? tooltipMeasuredH : approxH;

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
  const noteTooltipPos = activeNoteIndex !== null ? (() => {
    const eCenterY = getElementCenterY(activeNoteIndex);
    const h = isNoteEditing ? 230 : 120;
    let clampedTop = Math.max(40, Math.min(eCenterY - h / 2, window.innerHeight - h - 10));
    const wTop = Math.min(clampedTop, eCenterY - 20);
    const wBottom = Math.min(Math.max(clampedTop + h, eCenterY + 20), window.innerHeight);
    return { clampedTop, wTop, wH: wBottom - wTop, offset: clampedTop - wTop };
  })() : null;

  return (
    <>
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
          {/* Tree mode: left axis line */}
          {treeMode && (
            <div className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: '4px', backgroundColor: 'rgba(255, 255, 255, 0.08)' }} />
          )}
          {/* Inner relative wrapper so absolute overlays (selection, rewind) scroll with content */}
          <div ref={innerWrapperRef} className="relative flex flex-col flex-1">
          {/* Plan mode marker at the very beginning (first entry is from a child session — chain started before visible entries) */}
          {entries.length > 0 && entries[0].sessionId && sessionBoundaries.length > 0 &&
            sessionBoundaries.some(b => b.childSessionId === entries[0].sessionId) &&
            !forkMarkers.some(m => !m.entry_uuids || m.entry_uuids.length === 0) && (
            <div
              className="flex-shrink-0 w-full flex items-center justify-center"
              style={{ height: '8px' }}
              title="Plan mode - context was cleared here"
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
          )}
          {/* Fork marker at the very beginning (empty snapshot = fork before any entries) */}
          {forkMarkers.some(m => !m.entry_uuids || m.entry_uuids.length === 0) && entries.length > 0 && (
            <div
              className="flex-shrink-0 w-full flex items-center justify-center"
              style={{ height: '8px' }}
              title="Fork point - this session was forked from here"
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
          )}
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
            const forkMarker = forkMarkers.find(m => {
              if (!m.entry_uuids || m.entry_uuids.length === 0) return false;
              const snapshotUuids = new Set(m.entry_uuids);
              if (!snapshotUuids.has(entry.uuid)) return false;
              if (isLastEntry) return true;
              const nextEntry = entries[index + 1];
              return nextEntry && !snapshotUuids.has(nextEntry.uuid);
            });

            const isPlanModeBoundary = (() => {
              if (isLastEntry || forkMarker) return false;
              const nextEntry = entries[index + 1];
              if (!nextEntry || !entry.sessionId || !nextEntry.sessionId) return false;
              return entry.sessionId !== nextEntry.sessionId;
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
                    cursor: (isContinued || isDocsEdit || isOldHistory) ? 'default' : 'pointer',
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
                  <div
                    className="pointer-events-none shrink-0"
                    style={{
                      width: dotWidth,
                      height: dotHeight,
                      borderRadius: dotRadius,
                      backgroundColor: isUnreachable && !isHovered && !isCompacted ? 'transparent' : dotColor,
                      border: isUnreachable && !isHovered && !isCompacted ? `1px solid ${hasNote && notePos === 'dot' ? '#9333ea' : '#666'}` : 'none',
                      boxShadow: dotGlow,
                      boxSizing: 'border-box',
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
                        className="animate-spin"
                        style={{
                          width: '14px',
                          height: '14px',
                          borderRadius: '50%',
                          border: '1.5px solid transparent',
                          borderTopColor: 'rgba(255, 255, 255, 0.6)',
                          borderRightColor: 'rgba(255, 255, 255, 0.2)',
                        }}
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
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center"
                    style={{ height: '8px' }}
                    title="Current session starts below"
                  >
                    <div
                      style={{
                        width: '100%',
                        height: '1px',
                        backgroundColor: 'rgba(255, 255, 255, 0.2)',
                      }}
                    />
                  </div>
                )}
                {/* Fork marker (only outside old history zone — inside it's redundant) */}
                {forkMarker && !isOldHistory && (
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center"
                    style={{ height: '8px' }}
                    title="Fork point - this session was forked from here"
                  >
                    <div
                      style={{
                        width: isInViewport ? '10px' : '12px',
                        height: isInViewport ? '3px' : '2px',
                        borderRadius: '1px',
                        backgroundColor: isInViewport ? '#60a5fa' : '#3b82f6',
                        boxShadow: isInViewport ? '0 0 6px rgba(59, 130, 246, 0.25)' : 'none',
                        transition: 'background-color 0.2s, box-shadow 0.2s',
                      }}
                    />
                  </div>
                )}
                {/* Plan mode marker (only outside old history zone) */}
                {isPlanModeBoundary && !isOldHistory && (
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center"
                    style={{ height: '8px' }}
                    title="Plan mode - context was cleared here"
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
                )}
              </React.Fragment>
            );
          })}
        </div>

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
          return rect && (
            <div
              className="absolute left-0 right-0 pointer-events-none animate-pulse"
              style={{
                top: rect.top,
                height: rect.height,
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                borderTop: '1px solid rgba(59, 130, 246, 0.5)',
                borderBottom: '1px solid rgba(59, 130, 246, 0.5)',
                boxShadow: '0 0 12px rgba(59, 130, 246, 0.3)',
              }}
            />
          );
        })()}

        {/* Copied Range Animation (green success flash) */}
        {isVisible && copiedRange && (() => {
          const rect = getOverlayRect(copiedRange.startIndex, copiedRange.endIndex);
          return rect && (
            <div
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: rect.top,
                height: rect.height,
                backgroundColor: 'rgba(34, 197, 94, 0.25)',
                borderTop: '1px solid rgba(34, 197, 94, 0.6)',
                borderBottom: '1px solid rgba(34, 197, 94, 0.6)',
                boxShadow: '0 0 20px rgba(34, 197, 94, 0.4)',
              }}
            />
          );
        })()}

        {/* Rewind Progress Indicator */}
        {isVisible && rewindState && entries.length > 0 && (() => {
          const endIdx = rewindState.phase === 'compacting' ? entries.length - 1 : rewindState.index;
          const rect = getOverlayRect(rewindState.index, endIdx);
          return rect && (
            <div
              className="absolute left-0 right-0 pointer-events-none animate-pulse"
              style={{
                top: rect.top,
                height: rect.height,
                backgroundColor: rewindState.phase === 'done'
                  ? 'rgba(34, 197, 94, 0.25)'
                  : rewindState.phase === 'compacting'
                    ? 'rgba(245, 158, 11, 0.15)'
                    : 'rgba(168, 85, 247, 0.15)',
                borderTop: `1px solid ${rewindState.phase === 'done' ? 'rgba(34, 197, 94, 0.6)' : rewindState.phase === 'compacting' ? 'rgba(245, 158, 11, 0.5)' : 'rgba(168, 85, 247, 0.5)'}`,
                borderBottom: `1px solid ${rewindState.phase === 'done' ? 'rgba(34, 197, 94, 0.6)' : rewindState.phase === 'compacting' ? 'rgba(245, 158, 11, 0.5)' : 'rgba(168, 85, 247, 0.5)'}`,
                boxShadow: `0 0 12px ${rewindState.phase === 'done' ? 'rgba(34, 197, 94, 0.4)' : rewindState.phase === 'compacting' ? 'rgba(245, 158, 11, 0.3)' : 'rgba(168, 85, 247, 0.3)'}`,
              }}
            />
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

          const isLoading = editRangeState.phase === 'loading';
          const isApplying = editRangeState.phase === 'applying';
          const isDone = editRangeState.phase === 'done';
          const isReady = editRangeState.phase === 'ready';

          const color = isDone ? 'rgba(34, 197, 94'
            : isReady ? 'rgba(34, 197, 94'
            : isApplying ? 'rgba(168, 85, 247'
            : 'rgba(236, 72, 153';

          return rect && (
            <div
              className={`absolute left-0 right-0 pointer-events-none ${isLoading || isApplying ? 'animate-pulse' : ''}`}
              style={{
                top: rect.top,
                height: rect.height,
                backgroundColor: `${color}, ${isDone ? 0.25 : 0.15})`,
                borderTop: `1px solid ${color}, 0.5)`,
                borderBottom: `1px solid ${color}, 0.5)`,
                boxShadow: `0 0 12px ${color}, 0.3)`,
              }}
            />
          );
        })()}

          </div>{/* end inner relative wrapper */}

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
          return (
            <EditRangePanel
              sourceContent={editRangeState.sourceContent}
              initialCompact={editRangeState.compactText}
              anchorTop={anchorTop}
              anchorHeight={anchorHeight}
              rightOffset={rightOffset}
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

                return { removedCount: result.removedCount, removedUsers: result.removedUsers };
              }}
              onClose={() => setEditRangeState(null)}
            />
          );
        })()}

        {/* Tooltip Portal with CSS Bridge */}
        {isVisible && activeTooltipIndex !== null && currentActiveEntry && tooltipPos && (
          <TooltipPortal>
            {/* Outer wrapper — explicit height ensures bridge connects tooltip to entry */}
            <div
              ref={tooltipRef}
              onMouseEnter={() => { isMouseInTooltipRef.current = true; }}
              onMouseLeave={(e) => { isMouseInTooltipRef.current = false; handleMouseLeaveTooltipArea(); }}
              style={{
                position: 'fixed',
                right: `${notesPanelWidth + (treeMode ? 160 : 32) - 8}px`,
                top: `${tooltipPos.wTop}px`,
                height: `${tooltipPos.wH}px`,
                zIndex: 10010,
                display: 'flex',
                flexDirection: 'row',
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
                  minWidth: '240px',
                  maxWidth: '320px',
                  maxHeight: isExpanded ? '60vh' : '200px',
                  boxShadow: '-8px 8px 30px rgba(255,255,255,0.08), -2px 2px 8px rgba(255,255,255,0.05)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  transition: 'max-height 0.2s ease-in-out',
                  overflow: 'hidden'
                }}
              >
                {currentActiveEntry.type === 'compact' ? (
                  <span className="text-amber-400 font-medium">History Compacted ({currentActiveEntry.preTokens ? `${Math.round(currentActiveEntry.preTokens/1000)}k` : '?'} tokens)</span>
                ) : currentActiveEntry.type === 'continued' ? (
                  <>
                    <span className="text-amber-400 font-medium">Context Overflow Recovery</span>
                    <div
                      className={`text-white/70 leading-snug font-mono text-[11px] ${isExpanded ? 'overflow-y-auto' : 'line-clamp-4'}`}
                      style={{ whiteSpace: 'pre-wrap' }}
                    >
                      {isExpanded ? currentActiveEntry.content : truncateText(currentActiveEntry.content, 200)}
                    </div>
                    {(currentActiveEntry.content.length > 200 || isExpanded) && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                        className="p-1.5 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors cursor-pointer shrink-0 self-end"
                        title={isExpanded ? "Свернуть" : "Развернуть полностью"}
                      >
                        {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                      </button>
                    )}
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
                    <div
                      className={`text-white/70 leading-snug font-mono text-[11px] ${isExpanded ? 'overflow-y-auto' : 'line-clamp-4'}`}
                      style={{ whiteSpace: 'pre-wrap' }}
                    >
                      {isExpanded ? currentActiveEntry.content : truncateText(currentActiveEntry.content, 200)}
                    </div>
                    <div className="flex justify-between items-center mt-1 pt-2 border-t border-white/5">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); clipboard.writeText(currentActiveEntry.content); }}
                        className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-[10px] text-white/60 hover:text-white transition-colors cursor-pointer"
                      >
                        <Copy size={12} />
                        Copy
                      </button>
                    </div>
                  </>
                ) : currentActiveEntry.isPlan ? (
                  <>
                    <span style={{ color: '#48968c' }} className="font-medium">Plan Mode (auto-submitted)</span>
                    <div
                      className={`text-white/70 leading-snug font-mono text-[11px] ${isExpanded ? 'overflow-y-auto' : 'line-clamp-4'}`}
                      style={{ whiteSpace: 'pre-wrap' }}
                    >
                      {isExpanded ? currentActiveEntry.content : truncateText(currentActiveEntry.content, 200)}
                    </div>
                    <div className="flex justify-between items-center mt-1 pt-2 border-t border-white/5">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      <div className="flex items-center gap-1">
                        {(currentActiveEntry.content.length > 200 || isExpanded) && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                            className="p-1.5 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors cursor-pointer shrink-0"
                            title={isExpanded ? "Свернуть" : "Развернуть полностью"}
                          >
                            {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); clipboard.writeText(currentActiveEntry.content); }}
                          className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-[10px] text-white/60 hover:text-white transition-colors cursor-pointer"
                        >
                          <Copy size={12} />
                          Копировать
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Inline note preview when note is on dot */}
                    {notes[currentActiveEntry.uuid] && (notePositions[currentActiveEntry.uuid] || 'before') === 'dot' && (
                      <div className="flex items-start gap-1.5 pb-1.5 mb-1.5 border-b border-purple-500/15">
                        <StickyNote size={10} className="shrink-0 mt-0.5" style={{ color: '#9333ea' }} />
                        <div className="text-purple-300/80 leading-snug font-mono text-[10px] line-clamp-2" style={{ whiteSpace: 'pre-wrap' }}>
                          {notes[currentActiveEntry.uuid]}
                        </div>
                      </div>
                    )}
                    <div className="flex justify-between items-start gap-4">
                      <div
                        className={`text-white/90 leading-snug flex-1 font-mono ${isExpanded ? 'overflow-y-auto' : 'line-clamp-6'}`}
                        style={{ whiteSpace: 'pre-wrap' }}
                      >
                        {isExpanded ? currentActiveEntry.content : truncateText(currentActiveEntry.content, 200)}
                      </div>
                      {/* Show expand button only if content is truncated */}
                      {(currentActiveEntry.content.length > 200 || isExpanded) && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                          className="p-1.5 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors cursor-pointer shrink-0"
                          title={isExpanded ? "Свернуть" : "Развернуть полностью"}
                        >
                          {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                        </button>
                      )}
                    </div>
                    <div className="flex justify-between items-center mt-1 pt-2 border-t border-white/5">
                      <span className="text-[10px] text-white/30">{new Date(currentActiveEntry.timestamp).toLocaleTimeString()}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); clipboard.writeText(currentActiveEntry.content); }}
                        className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-[10px] text-white/60 hover:text-white transition-colors cursor-pointer"
                      >
                        <Copy size={12} />
                        Копировать
                      </button>
                    </div>
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

        {/* Context Menu */}
        {isVisible && contextMenu && (
          <TooltipPortal>
            <div
              onMouseLeave={() => setContextMenu(null)}
              style={{
                position: 'fixed',
                left: contextMenu.x,
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
                  <button
                    className={`w-full text-left px-3 py-2 text-xs rounded transition-colors ${isActive && !rewindState ? 'text-amber-400 hover:bg-amber-600/20 cursor-pointer' : 'text-white/20 cursor-not-allowed'}`}
                    disabled={!isActive || !!rewindState}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isActive && !rewindState) handleRewind(contextMenu.entry);
                    }}
                  >
                    {rewindState ? (rewindState.phase === 'compacting' ? 'Компакт...' : rewindState.phase === 'rewinding' ? 'Откат...' : 'Вставка...') : 'Откатиться'}
                  </button>
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
          </TooltipPortal>
        )}

        {/* Range Action Menu — appears after selecting range (double-click start + click end) */}
        {isVisible && rangeActionMenu && (
          <TooltipPortal>
            <div
              onMouseLeave={() => {
                setRangeActionMenu(null);
                selectionStartIdRef.current = null;
                setSelectionStartId(null);
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: rangeActionMenu.x,
                top: rangeActionMenu.y,
                backgroundColor: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: '6px',
                padding: '4px',
                zIndex: 10001,
                minWidth: '170px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
              }}
            >
              <button
                className="w-full text-left px-3 py-2 text-xs text-white hover:bg-blue-600/80 rounded transition-colors cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  executeRangeAction('copy', rangeActionMenu.range, rangeActionMenu.startUuid, rangeActionMenu.endUuid);
                }}
              >
                Копировать ({rangeActionMenu.range.endIndex - rangeActionMenu.range.startIndex + 1})
              </button>
              {!isGemini && (
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
                  <button
                    className="px-2 py-2 text-xs text-pink-400/60 hover:bg-pink-600/30 hover:text-pink-300 transition-colors cursor-pointer border-l border-white/10"
                    title="Открыть панель (тест)"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      // Instant open with stub content — skip Gemini API
                      const { range, startUuid, endUuid } = rangeActionMenu;
                      selectionStartIdRef.current = null;
                      setSelectionStartId(null);
                      setRangeActionMenu(null);
                      setEditRangeState({
                        range,
                        phase: 'ready',
                        sourceContent: `[Test source — ${range.endIndex - range.startIndex + 1} entries from ${startUuid.slice(0,8)} to ${endUuid.slice(0,8)}]`,
                        compactText: '## Тестовая сводка\n\n1. Пункт один\n2. Пункт два\n3. Пункт три\n\nФайлы: `src/main.js`, `src/renderer/App.tsx`\n\nСтатус: всё работает.',
                      });
                    }}
                  >
                    ▶
                  </button>
                </div>
              )}
            </div>
          </TooltipPortal>
        )}

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
                right: `${notesPanelWidth + (treeMode ? 160 : 32) - 8}px`,
                top: `${noteTooltipPos.wTop}px`,
                height: `${noteTooltipPos.wH}px`,
                zIndex: 10002,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
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
                      {/* Position selector */}
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
                          <button
                            key={opt.value}
                            onClick={(e) => { e.stopPropagation(); setNoteEditPosition(opt.value); }}
                            title={opt.title}
                            className="p-1 rounded transition-colors cursor-pointer"
                            style={{
                              color: noteEditPosition === opt.value ? '#c084fc' : 'rgba(255,255,255,0.3)',
                              backgroundColor: noteEditPosition === opt.value ? 'rgba(168, 85, 247, 0.15)' : 'transparent',
                            }}
                          >
                            {opt.icon}
                          </button>
                        ))}
                      </div>
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
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteNote(activeNoteEntry); }}
                            className="p-1 rounded hover:bg-red-600/20 text-red-400/60 hover:text-red-400 transition-colors cursor-pointer"
                            title="Удалить заметку"
                          >
                            <Trash2 size={12} />
                          </button>
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
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEditNote(activeNoteEntry); }}
                        className="p-1.5 rounded hover:bg-white/10 text-purple-400/60 hover:text-purple-300 transition-colors cursor-pointer shrink-0"
                        title="Редактировать"
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                    <div className="flex justify-between items-center pt-1 border-t border-white/5">
                      <span className="text-[10px] text-purple-400/40">Заметка</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteNote(activeNoteEntry); }}
                        className="p-1 rounded hover:bg-red-600/20 text-white/30 hover:text-red-400 transition-colors cursor-pointer"
                        title="Удалить"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </>
                )}
              </div>
              {/* CSS Bridge */}
              <div style={{ width: '8px', alignSelf: 'stretch' }} />
            </div>
          </TooltipPortal>
        )}

        {/* Loading */}
        {isVisible && isLoading && entries.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
            <div className="w-1 h-1 bg-white animate-ping rounded-full" />
          </div>
        )}

        {/* Scroll-to-bottom arrow — always mounted, visibility toggled via ref (no re-render on scroll) */}
        {isVisible && (
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
            title="Scroll to bottom"
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
        )}

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
