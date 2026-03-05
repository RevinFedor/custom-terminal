import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Copy, Minimize2 } from 'lucide-react';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { usePromptsStore } from '../../store/usePromptsStore';

const { ipcRenderer, clipboard } = window.require('electron');

// Portal for tooltip to escape overflow:hidden
const TooltipPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return createPortal(children, document.body);
};

interface TimelineEntry {
  uuid: string;
  type: 'user' | 'compact' | 'continued';
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

// Check if a needle string appears as an isolated line in buffer text (not as a substring
// of AI response text). Uses the same strictness logic as terminalRegistry.lineContains:
// - isStrictShort (< 5 chars, e.g. "да"): trimmed line must equal needle, or have only
//   non-alphanumeric prefix (prompt chars).
// - isIsolatedShort (< 30 chars, e.g. "continue"): needle must be near start of trimmed
//   line, line must not be much longer than needle.
// - Regular (>= 30 chars): simple includes() is fine since long text is unique enough.
function geminiLineMatch(bufferLines: string[], needle: string, isStrictShort: boolean, isIsolatedShort: boolean): boolean {
  const nonAlphaRe = /[a-zA-Z0-9\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/;

  for (const hay of bufferLines) {
    if (isStrictShort) {
      const trimmed = hay.trim();
      if (trimmed === needle) return true;
      if (trimmed.length > needle.length + 4) continue;
      const pos = trimmed.indexOf(needle);
      if (pos < 0) continue;
      if (pos === 0) return true;
      const prefix = trimmed.slice(0, pos);
      if (!nonAlphaRe.test(prefix)) return true;
    } else if (isIsolatedShort) {
      const trimmed = hay.trim();
      if (trimmed.length > needle.length + 25) continue;
      const pos = trimmed.indexOf(needle);
      if (pos < 0) continue;
      if (pos === 0) return true;
      const prefix = trimmed.slice(0, pos);
      if (!nonAlphaRe.test(prefix)) return true;
    } else {
      if (hay.includes(needle)) return true;
    }
  }
  return false;
}

// Check if search lines (from getSearchLines) match anywhere in buffer text.
// Used for Gemini viewport visibility and buffer reachability checks.
// Only checks the FIRST search line with strict line-level matching — this is
// sufficient for visibility/reachability (we don't need multi-line precision here,
// just need to avoid false substring matches in AI responses).
function matchesInGeminiBuffer(bufferText: string, searchLines: string[]): boolean {
  if (searchLines.length === 0) return false;

  const firstLine = searchLines[0];
  const isStrictShort = searchLines.length === 1 && firstLine.length < 5;
  const isIsolatedShort = searchLines.length === 1 && firstLine.length < 30;

  const bufferLines = bufferText.split('\n');
  return geminiLineMatch(bufferLines, firstLine, isStrictShort, isIsolatedShort);
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

function Timeline({ tabId, sessionId, cwd, isActive = true, isVisible = true, toolType = 'claude' }: TimelineProps) {
  const isGemini = toolType === 'gemini';
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
  const [clickedState, setClickedState] = useState<{ index: number; status: 'loading' | 'failed' } | null>(null);
  const [rewindState, setRewindState] = useState<{ index: number; phase: 'compacting' | 'rewinding' | 'pasting' | 'done' } | null>(null);

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
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Custom scroll indicator state (overlays the Resizer bar)
  const [scrollThumb, setScrollThumb] = useState<{ top: number; height: number } | null>(null);

  // CMD key state for tooltip activation
  const [isCmdHeld, setIsCmdHeld] = useState(false);
  const isCmdHeldRef = useRef(false);
  const chainResolvedRef = useRef<string | null>(null); // prevents A→B→A→B feedback loop

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
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateThumb = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight <= clientHeight) {
        setScrollThumb(null); // no scroll needed
        return;
      }
      const ratio = clientHeight / scrollHeight;
      const thumbH = Math.max(ratio * clientHeight, 20); // min 20px
      const maxScroll = scrollHeight - clientHeight;
      const thumbTop = (scrollTop / maxScroll) * (clientHeight - thumbH);
      setScrollThumb({ top: thumbTop, height: thumbH });
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
  useEffect(() => {
    if (isCmdHeld && hoveredIndex !== null) {
      setActiveTooltipIndex(hoveredIndex);
    } else if (!isCmdHeld && !isExpanded) {
      setActiveTooltipIndex(null);
    }
  }, [isCmdHeld, hoveredIndex, isExpanded]);

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
          const markers = markersResult.markers || [];
          console.log('[Timeline] Fork markers for session', sessionId, ':', markers.length, markers.length > 0 ? JSON.stringify(markers.map((m: ForkMarker) => m.source_session_id)) : '(empty)');
          setForkMarkers(markers);
        }
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

  // Bind timeline entries to prompt boundary markers (OSC 7777 from main.js).
  // Entry N (user message) maps to prompt boundary N (the prompt shown after response N,
  // where the next message will be typed). Sequence 0 = after first response.
  // Entries without markers will fall back to SearchAddon navigation.
  useEffect(() => {
    if (isGemini || entries.length === 0) return;
    const boundaryCount = terminalRegistry.getPromptBoundaryCount(tabId);
    if (boundaryCount === 0) return;

    // User-type entries only (skip compact, continued)
    let promptSeq = 0;
    for (const entry of entries) {
      if (entry.type === 'compact' || entry.type === 'continued') continue;
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
          if (entry.type === 'compact' || entry.type === 'continued') return;
          const lines = getSearchLines(entry.content);
          if (lines.length > 0) {
            searchData.push({ searchLines: lines, entryIndex: index });
          }
        });
        if (searchData.length > 0) {
          const rows = terminalRegistry.buildPositionIndex(tabId, searchData);
          searchData.forEach((sd, i) => { pos[sd.entryIndex] = rows[i]; });
        }
      } else {
        // Claude: read marker positions (O(1) per entry)
        entries.forEach((entry, index) => {
          if (index <= lastBoundaryIdx) return;
          if (entry.type === 'compact' || entry.type === 'continued') return;
          const row = terminalRegistry.getMarkerRow(tabId, entry.uuid);
          if (row >= 0) pos[index] = row;
        });
        // First entry after boundary usually has no marker (typed at initial prompt).
        // Treat it as position 0 so its range covers the start of the buffer.
        // But ONLY if other entries have markers (= Claude content is in the buffer).
        // Without this guard, an empty terminal (Claude not running) would make
        // the first entry falsely reachable at pos=0.
        const firstRealIdx = entries.findIndex((e, i) =>
          i > lastBoundaryIdx && e.type !== 'compact' && e.type !== 'continued'
        );
        if (firstRealIdx >= 0 && pos[firstRealIdx] < 0) {
          const hasOtherMarkers = pos.some((p, i) => i > firstRealIdx && p >= 0);
          if (hasOtherMarkers) {
            pos[firstRealIdx] = 0;
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

    // Buffer reachability — does the entry's text exist somewhere in the buffer?
    // Uses text-based search (not positions) for robustness: anchored position search
    // can miss entries due to false positive cascading, but text search is independent per entry.
    const checkReachability = () => {
      // Also recompute positions for visibility
      positions = computePositions();

      const newUnreachable = new Set<number>();

      if (isGemini) {
        // Gemini: text-based reachability (search full buffer independently per entry)
        const fullText = terminalRegistry.getFullBufferText(tabId);
        if (!fullText) {
          setUnreachableIndices(prev => prev.size === 0 ? prev : new Set());
          return;
        }
        entries.forEach((entry, index) => {
          if (entry.type === 'compact' || entry.type === 'continued' || entry.isPlan) return;
          if (index <= lastBoundaryIdx) {
            newUnreachable.add(index);
            return;
          }
          const lines = getSearchLines(entry.content);
          if (lines.length > 0 && !matchesInGeminiBuffer(fullText, lines)) {
            newUnreachable.add(index);
          }
        });
      } else {
        // Claude: marker-based reachability (markers auto-dispose when scrollback trimmed)
        entries.forEach((entry, index) => {
          if (entry.type === 'compact' || entry.type === 'continued' || entry.isPlan) return;
          if (index <= lastBoundaryIdx) {
            newUnreachable.add(index);
            return;
          }
          if (positions[index] < 0) {
            newUnreachable.add(index);
          }
        });
      }

      // Inherit unreachable for compact/continued/plan entries from next regular entry
      entries.forEach((entry, index) => {
        if (entry.type !== 'compact' && entry.type !== 'continued' && !entry.isPlan) return;
        if (index <= lastBoundaryIdx) {
          newUnreachable.add(index);
          return;
        }
        for (let j = index + 1; j < entries.length; j++) {
          const next = entries[j];
          if (next.type === 'compact' || next.type === 'continued' || next.isPlan) continue;
          if (newUnreachable.has(j)) newUnreachable.add(index);
          break;
        }
      });

      setUnreachableIndices(prev => {
        if (prev.size === newUnreachable.size && [...prev].every(i => newUnreachable.has(i))) return prev;
        return newUnreachable;
      });

      // Re-check visibility with updated positions
      checkVisibility();
    };

    // Run both on mount / entries change
    checkVisibility();
    checkReachability();

    // On viewport change (scroll + buffer writes via onWriteParsed):
    // - checkVisibility: 100ms debounce (just reads cached positions + viewport state)
    // - checkReachability: 500ms debounce (recomputes positions from buffer)
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

  const handleEntryClick = (entry: TimelineEntry) => {
    // Если режим копирования активен — реагируем сразу (без задержки)
    if (selectionStartIdRef.current) {
      if (selectionStartIdRef.current === entry.uuid) {
        // Клик по той же точке → отменить выделение
        selectionStartIdRef.current = null;
        setSelectionStartId(null);
      } else {
        // Клик по другой точке → копировать
        finishRangeSelection(entry);
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

    // If history panel is open — scroll to entry in history only, skip terminal scroll
    // This includes compact/continued entries which have no terminal position but DO exist in history panel
    if (isHistoryOpen) {
      setHistoryScrollToUuid(entry.uuid);
      return;
    }

    // Compact/continued entries have no terminal position — skip terminal scroll
    if (entry.type === 'compact' || entry.type === 'continued') return;

    // History panel NOT open — scroll in terminal only
    // Instant visual feedback — loader appears immediately
    setClickedState({ index, status: 'loading' });

    // ALWAYS DIAGNOSE CLICK (Temporary Debug)
    // if (unreachableIndices.has(index)) {
         console.warn(`[Timeline] Clicking entry #${index}. Diagnosing...`);
         const fullText = terminalRegistry.getFullBufferText(tabId);
         if (isGemini) {
           const lines = getSearchLines(entry.content);
           if (fullText && lines.length > 0) {
             const found = matchesInGeminiBuffer(fullText, lines);
             if (found) console.log(`[Timeline] Diagnosis: Entry IS reachable (found=${found}). Red status might be stale.`);
             else console.log(`[Timeline] Diagnosis: Entry UNREACHABLE (found=${found}).`);
           } else {
             console.log(`[Timeline] Diagnosis failed: fullText=${!!fullText}, lines=${lines.length}`);
           }
         } else {
           const key = getEntryKey(entry);
           if (fullText && key) {
               const found = matchesAtUserPrompt(fullText, key, true); // Force debug logs
               if (found) console.log(`[Timeline] Diagnosis: Entry IS reachable (found=${found}). Red status might be stale.`);
               else console.log(`[Timeline] Diagnosis: Entry UNREACHABLE (found=${found}).`);
           } else {
               console.log(`[Timeline] Diagnosis failed: fullText=${!!fullText}, key=${!!key}`);
           }
         }
    // }

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
    const menuHeight = selectionStartIdRef.current ? 40 : 112;

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

  const finishRangeSelection = async (endEntry: TimelineEntry) => {
    const startId = selectionStartIdRef.current;
    if (!startId || !sessionId) return;

    const startIndex = entries.findIndex(e => e.uuid === startId);
    const endIndex = entries.findIndex(e => e.uuid === endEntry.uuid);
    const range = {
      startIndex: Math.min(startIndex, endIndex),
      endIndex: Math.max(startIndex, endIndex),
    };

    // Clear selection, show blinking blue (loading state)
    selectionStartIdRef.current = null;
    setSelectionStartId(null);
    setContextMenu(null);
    setCopyingRange(range);

    try {
      const result = await ipcRenderer.invoke('claude:copy-range', {
        sessionId,
        cwd,
        startUuid: startId,
        endUuid: endEntry.uuid,
        includeEditing: copyIncludeEditing,
        includeReading: copyIncludeReading,
      });

      // Loading done — hide blinking blue
      setCopyingRange(null);

      if (result.success) {
        clipboard.writeText(result.content);

        // Show green success flash
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
      // Cancel range selection if clicking outside timeline
      if (selectionStartIdRef.current && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        selectionStartIdRef.current = null;
        setSelectionStartId(null);
      }
    };
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, [isExpanded]);

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

  return (
    <>
      <div
        ref={containerRef}
        data-timeline
        className="relative flex flex-col group"
        style={{
          width: '24px',
          backgroundColor: 'rgba(0, 0, 0, 0.2)',
          backdropFilter: 'blur(4px)',
          borderLeft: '1px solid rgba(255, 255, 255, 0.05)',
          height: '100%',
          zIndex: 40,
          visibility: isVisible ? 'inherit' : 'hidden',
          overflow: 'visible',
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
          className="h-full scrollbar-hide"
          style={{
            opacity: isVisible ? 1 : 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            ...(treeMode ? {
              position: 'absolute' as const,
              top: 0,
              bottom: 0,
              right: 0,
              width: '160px',
              backgroundColor: 'rgba(0, 0, 0, 0.88)',
              backdropFilter: 'blur(8px)',
              borderLeft: '1px solid rgba(129, 140, 248, 0.15)',
              zIndex: 50,
            } : {
              width: '100%',
            }),
          }}
        >
          {/* Tree mode: left axis line */}
          {treeMode && (
            <div className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: '4px', backgroundColor: 'rgba(255, 255, 255, 0.08)' }} />
          )}
          {/* Plan mode marker at the very beginning (first entry is from a child session — chain started before visible entries) */}
          {entries.length > 0 && entries[0].sessionId && sessionBoundaries.length > 0 &&
            sessionBoundaries.some(b => b.childSessionId === entries[0].sessionId) &&
            !forkMarkers.some(m => !m.entry_uuids || m.entry_uuids.length === 0) && (
            <div
              className="flex-shrink-0 w-full flex items-center justify-center"
              style={{ height: '8px', backgroundColor: unreachableIndices.has(0) ? 'rgba(239, 68, 68, 0.06)' : 'transparent' }}
              title="Plan mode - context was cleared here"
            >
              <div
                style={{
                  width: visibleEntryIndices.has(0) ? '10px' : '12px',
                  height: visibleEntryIndices.has(0) ? '3px' : '2px',
                  borderRadius: '1px',
                  backgroundColor: visibleEntryIndices.has(0) ? '#5eada3' : '#48968c',
                  boxShadow: visibleEntryIndices.has(0) ? '0 0 6px rgba(72, 150, 140, 0.25)' : 'none',
                  transition: 'all 0.2s',
                }}
              />
            </div>
          )}
          {/* Fork marker at the very beginning (empty snapshot = fork before any entries) */}
          {forkMarkers.some(m => !m.entry_uuids || m.entry_uuids.length === 0) && entries.length > 0 && (
            <div
              className="flex-shrink-0 w-full flex items-center justify-center"
              style={{ height: '8px', backgroundColor: unreachableIndices.has(0) ? 'rgba(239, 68, 68, 0.06)' : 'transparent' }}
              title="Fork point - this session was forked from here"
            >
              <div
                style={{
                  width: visibleEntryIndices.has(0) ? '10px' : '12px',
                  height: visibleEntryIndices.has(0) ? '3px' : '2px',
                  borderRadius: '1px',
                  backgroundColor: visibleEntryIndices.has(0) ? '#60a5fa' : '#3b82f6',
                  boxShadow: visibleEntryIndices.has(0) ? '0 0 6px rgba(59, 130, 246, 0.25)' : 'none',
                  transition: 'all 0.2s',
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
            const dotClickState = clickedState?.index === index ? clickedState.status : null;

            // Entry type flags
            const entryIsSubAgent = !!(entry.isSubAgent || entry.isSubAgentTimeout);
            const entryIsTimeout = !!entry.isSubAgentTimeout;
            const isHovered = hoveredIndex === index || activeTooltipIndex === index;

            // ── Dot color ──
            let dotColor: string;
            let dotGlow: string;

            if (isCompacted) {
              dotColor = isInViewport ? '#fbbf24' : '#f59e0b';
              dotGlow = isHovered ? '0 0 8px rgba(245, 158, 11, 0.4)' : (isInViewport ? '0 0 6px rgba(245, 158, 11, 0.25)' : 'none');
            } else if (isContinued) {
              dotColor = '#f59e0b';
              dotGlow = isHovered ? '0 0 8px rgba(245, 158, 11, 0.4)' : 'none';
            } else if (isPlan) {
              dotColor = isHovered ? '#5eada3' : '#48968c';
              dotGlow = isHovered ? '0 0 8px rgba(72, 150, 140, 0.4)' : 'none';
            } else if (active) {
              dotColor = '#3b82f6';
              dotGlow = 'none';
            } else if (isHovered) {
              if (entryIsTimeout) { dotColor = '#ef4444'; dotGlow = '0 0 8px rgba(239, 68, 68, 0.4)'; }
              else if (entryIsSubAgent) { dotColor = '#818cf8'; dotGlow = '0 0 8px rgba(129, 140, 248, 0.4)'; }
              else { dotColor = 'white'; dotGlow = '0 0 8px rgba(255,255,255,0.4)'; }
            } else if (entryIsTimeout) {
              dotColor = isInViewport ? 'rgba(239, 68, 68, 0.7)' : 'rgba(239, 68, 68, 0.35)';
              dotGlow = isInViewport ? '0 0 6px rgba(239, 68, 68, 0.25)' : 'none';
            } else if (entryIsSubAgent) {
              dotColor = isInViewport ? (isResponseOnly ? 'rgba(129, 140, 248, 0.35)' : 'rgba(129, 140, 248, 0.8)') : 'rgba(129, 140, 248, 0.3)';
              dotGlow = isInViewport ? (isResponseOnly ? 'none' : '0 0 6px rgba(129, 140, 248, 0.25)') : 'none';
            } else {
              dotColor = isInViewport ? (isResponseOnly ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.75)') : 'rgba(255,255,255,0.3)';
              dotGlow = isInViewport ? (isResponseOnly ? 'none' : '0 0 6px rgba(255,255,255,0.25)') : 'none';
            }

            // ── Dot size ──
            const dotWidth = isCompacted
              ? (isInViewport ? '10px' : '12px')
              : showAsChild
                ? (isHovered ? '6px' : (isInViewport ? '8px' : '3px'))
                : (isHovered ? '8px' : (isInViewport ? '10px' : '4px'));
            const dotHeight = isCompacted
              ? (isInViewport ? '3px' : '2px')
              : showAsChild
                ? (isHovered ? '6px' : (isInViewport ? '2px' : '3px'))
                : (isHovered ? '8px' : (isInViewport ? '3px' : '4px'));
            const dotRadius = (isCompacted || (isInViewport && !isHovered)) ? '1px' : '50%';

            // Expanded group header: render toggle bar THEN the entry as child
            const isExpandedHeader = !!(groupInfo?.isGroupHeader && isGroupExpanded);

            return (
              <React.Fragment key={entry.uuid}>
                {/* Phase 2: Expanded group toggle bar (separate from entry) */}
                {isExpandedHeader && (
                  <div
                    className="relative w-full flex items-center justify-center"
                    style={{
                      flex: '0 0 auto',
                      minHeight: '10px',
                      cursor: 'pointer',
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
                    {/* Collapse indicator: small horizontal line */}
                    <div style={{
                      width: '8px',
                      height: '2px',
                      borderRadius: '1px',
                      backgroundColor: 'rgba(129, 140, 248, 0.5)',
                    }} />
                    {treeMode && (
                      <span className="ml-1 truncate pointer-events-none select-none" style={{
                        fontSize: '8px',
                        color: 'rgba(129, 140, 248, 0.4)',
                      }}>
                        ▾ {groupInfo!.agentName} ×{groupInfo!.groupSize}
                      </span>
                    )}
                  </div>
                )}
                <div
                  ref={el => segmentRefs.current[index] = el}
                  data-segment
                  className="relative w-full flex items-center transition-colors"
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
                      handleEntryClick(entry);
                    }
                  }}
                  onDoubleClick={() => handleEntryDoubleClick(entry)}
                  onContextMenu={(e) => handleRightClick(e, entry)}
                  style={{
                    flex: '0 0 auto',
                    minHeight: treeMode ? '18px' : (showAsChild ? '5px' : '12px'),
                    justifyContent: treeMode ? 'flex-start' : 'center',
                    paddingLeft: treeMode
                      ? (showAsChild ? '20px' : entryIsSubAgent ? '10px' : '4px')
                      : (showAsChild ? '4px' : undefined),
                    backgroundColor: active
                      ? 'rgba(59, 130, 246, 0.15)'
                      : (isUnreachable ? 'rgba(239, 68, 68, 0.06)' : 'transparent'),
                    cursor: isContinued ? 'default' : 'pointer',
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
                  <div
                    className="transition-all duration-200 pointer-events-none shrink-0"
                    style={{
                      width: dotWidth,
                      height: dotHeight,
                      borderRadius: dotRadius,
                      backgroundColor: dotColor,
                      boxShadow: dotGlow,
                    }}
                  />

                  {/* Phase 2: Group count badge (collapsed only) */}
                  {groupInfo?.isGroupHeader && !isGroupExpanded && !treeMode && (
                    <div
                      className="absolute pointer-events-none"
                      style={{
                        right: '2px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: '7px',
                        lineHeight: '1',
                        color: 'rgba(129, 140, 248, 0.7)',
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
                            : 'rgba(255, 255, 255, 0.4)',
                      }}
                    >
                      {isGroupCollapsed
                        ? `${groupInfo!.agentName} ×${groupInfo!.groupSize}`
                        : entryIsTimeout
                          ? 'timeout'
                          : entryIsSubAgent
                            ? (entry.subAgentName || 'Claude')
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
                {/* Fork marker */}
                {forkMarker && (
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center"
                    style={{ height: '8px', backgroundColor: isUnreachable ? 'rgba(239, 68, 68, 0.06)' : 'transparent' }}
                    title="Fork point - this session was forked from here"
                  >
                    <div
                      style={{
                        width: isInViewport ? '10px' : '12px',
                        height: isInViewport ? '3px' : '2px',
                        borderRadius: '1px',
                        backgroundColor: isInViewport ? '#60a5fa' : '#3b82f6',
                        boxShadow: isInViewport ? '0 0 6px rgba(59, 130, 246, 0.25)' : 'none',
                        transition: 'all 0.2s',
                      }}
                    />
                  </div>
                )}
                {/* Plan mode marker */}
                {isPlanModeBoundary && (
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center"
                    style={{ height: '8px', backgroundColor: isUnreachable ? 'rgba(239, 68, 68, 0.06)' : 'transparent' }}
                    title="Plan mode - context was cleared here"
                  >
                    <div
                      style={{
                        width: isInViewport ? '10px' : '12px',
                        height: isInViewport ? '3px' : '2px',
                        borderRadius: '1px',
                        backgroundColor: isInViewport ? '#5eada3' : '#48968c',
                        boxShadow: isInViewport ? '0 0 6px rgba(72, 150, 140, 0.25)' : 'none',
                        transition: 'all 0.2s',
                      }}
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Selection Range Indicator (active selection) */}
        {isVisible && selectionStartId && hoveredIndex !== null && (
          <div
            className="absolute left-0 right-0 pointer-events-none"
            style={{
              top: `${Math.min(entries.findIndex(e => e.uuid === selectionStartId), hoveredIndex) / entries.length * 100}%`,
              height: `${Math.abs(entries.findIndex(e => e.uuid === selectionStartId) - hoveredIndex + 1) / entries.length * 100}%`,
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              borderTop: '1px solid rgba(59, 130, 246, 0.3)',
              borderBottom: '1px solid rgba(59, 130, 246, 0.3)',
            }}
          />
        )}

        {/* Loading Range Indicator (blinking blue while IPC runs) */}
        {isVisible && copyingRange && (
          <div
            className="absolute left-0 right-0 pointer-events-none animate-pulse"
            style={{
              top: `${copyingRange.startIndex / entries.length * 100}%`,
              height: `${(copyingRange.endIndex - copyingRange.startIndex + 1) / entries.length * 100}%`,
              backgroundColor: 'rgba(59, 130, 246, 0.15)',
              borderTop: '1px solid rgba(59, 130, 246, 0.5)',
              borderBottom: '1px solid rgba(59, 130, 246, 0.5)',
              boxShadow: '0 0 12px rgba(59, 130, 246, 0.3)',
            }}
          />
        )}

        {/* Copied Range Animation (green success flash) */}
        {isVisible && copiedRange && (
          <div
            className="absolute left-0 right-0 pointer-events-none"
            style={{
              top: `${copiedRange.startIndex / entries.length * 100}%`,
              height: `${(copiedRange.endIndex - copiedRange.startIndex + 1) / entries.length * 100}%`,
              backgroundColor: 'rgba(34, 197, 94, 0.25)',
              borderTop: '1px solid rgba(34, 197, 94, 0.6)',
              borderBottom: '1px solid rgba(34, 197, 94, 0.6)',
              boxShadow: '0 0 20px rgba(34, 197, 94, 0.4)',
            }}
          />
        )}

        {/* Rewind Progress Indicator */}
        {isVisible && rewindState && entries.length > 0 && (
          <div
            className="absolute left-0 right-0 pointer-events-none animate-pulse"
            style={{
              top: `${rewindState.index / entries.length * 100}%`,
              height: rewindState.phase === 'compacting'
                ? `${(entries.length - rewindState.index) / entries.length * 100}%`
                : `${Math.max(1, 100 / entries.length)}%`,
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
        )}

        {/* Tooltip Portal with CSS Bridge */}
        {isVisible && activeTooltipIndex !== null && currentActiveEntry && tooltipPos && (
          <TooltipPortal>
            {/* Outer wrapper — explicit height ensures bridge connects tooltip to entry */}
            <div
              ref={tooltipRef}
              onMouseLeave={handleMouseLeaveTooltipArea}
              style={{
                position: 'fixed',
                right: `${notesPanelWidth + (treeMode ? 160 : 24) - 8}px`,
                top: `${tooltipPos.wTop}px`,
                height: `${tooltipPos.wH}px`,
                zIndex: 10000,
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
                      if (gi?.isGroupHeader) {
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
                  {/* Range copy — Claude only */}
                  {!isGemini && (
                    <button
                      className="w-full text-left px-3 py-2 text-xs text-white hover:bg-blue-600 rounded transition-colors cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); startRangeSelection(contextMenu.entry); }}
                    >
                      Начать копирование
                    </button>
                  )}
                  <button
                    className="w-full text-left px-3 py-2 text-xs text-white/60 hover:bg-white/5 rounded transition-colors cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      clipboard.writeText(contextMenu.entry.content);
                      setContextMenu(null);
                    }}
                  >
                    Копировать текст сообщения
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
                    setContextMenu(null);
                  }}
                >
                  Отменить копирование
                </button>
              )}
            </div>
          </TooltipPortal>
        )}

        {/* Loading */}
        {isVisible && isLoading && entries.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
            <div className="w-1 h-1 bg-white animate-ping rounded-full" />
          </div>
        )}

        {/* Custom scroll indicator — right edge of Timeline strip (compact) or tree overlay */}
        {isVisible && scrollThumb && (
          <div
            className="absolute pointer-events-none"
            style={{
              right: '0px',
              width: '3px',
              top: scrollThumb.top,
              height: scrollThumb.height,
              backgroundColor: 'rgba(255, 255, 255, 0.4)',
              borderRadius: '1.5px',
              transition: 'top 0.05s ease-out',
              zIndex: 55,
            }}
          />
        )}
      </div>
    </>
  );
}

export default Timeline;
