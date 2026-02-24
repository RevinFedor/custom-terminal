import React, { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
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
  sessionId?: string;
  isPlan?: boolean;
}

interface SessionBoundary {
  childSessionId: string;
  parentSessionId: string;
}

interface TimelineProps {
  tabId: string;
  sessionId: string | null;
  cwd: string;
  isActive?: boolean; // Claude is currently running
  isVisible?: boolean; // New prop to control visibility from parent
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

function Timeline({ tabId, sessionId, cwd, isActive = true, isVisible = true }: TimelineProps) {
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
  const [unreachableIndices, setUnreachableIndices] = useState<Set<number>>(new Set());
  const [clickedState, setClickedState] = useState<{ index: number; status: 'loading' | 'failed' } | null>(null);
  const [rewindState, setRewindState] = useState<{ index: number; phase: 'compacting' | 'rewinding' | 'pasting' | 'done' } | null>(null);

  const notesPanelWidth = useUIStore(state => state.notesPanelWidth);
  const copyIncludeEditing = useUIStore(state => state.copyIncludeEditing);
  const copyIncludeReading = useUIStore(state => state.copyIncludeReading);
  const setHistoryScrollToUuid = useUIStore(state => state.setHistoryScrollToUuid);
  const isHistoryOpen = useUIStore(state => state.historyPanelOpenTabs[tabId] ?? false);
  const historyVisibleUuids = useUIStore(state => state.historyVisibleUuids[tabId]);
  const containerRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);

  // CMD key state for tooltip activation
  const [isCmdHeld, setIsCmdHeld] = useState(false);
  const isCmdHeldRef = useRef(false);

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
      return;
    }

    setIsLoading(true);
    try {
      // Load timeline entries and fork markers in parallel
      const [timelineResult, markersResult] = await Promise.all([
        ipcRenderer.invoke('claude:get-timeline', { sessionId, cwd }),
        ipcRenderer.invoke('claude:get-fork-markers', { sessionId })
      ]);

      if (timelineResult.success) {
        setEntries(timelineResult.entries);
        setSessionBoundaries(timelineResult.sessionBoundaries || []);

        // Detect session ID change (e.g., after "Clear Context" in plan mode)
        // If the timeline resolved a newer session, update our store
        if (timelineResult.latestSessionId && timelineResult.latestSessionId !== sessionId) {
          console.log('[Timeline] Session chain detected! Updating sessionId:', sessionId, '→', timelineResult.latestSessionId);
          useWorkspaceStore.getState().setClaudeSessionId(tabId, timelineResult.latestSessionId);
        }

      }
      if (markersResult.success) {
        const markers = markersResult.markers || [];
        console.log('[Timeline] Fork markers for session', sessionId, ':', markers.length, markers.length > 0 ? JSON.stringify(markers.map((m: ForkMarker) => m.source_session_id)) : '(empty)');
        setForkMarkers(markers);
      }
    } catch (error) {
      console.error('[Timeline] Error loading timeline:', error);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, cwd, tabId]);

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  // Refresh timeline periodically (faster when command is running for Escape detection)
  useEffect(() => {
    if (!sessionId) return;
    // Refresh every 2 seconds to catch Escape/Undo changes quickly
    const interval = setInterval(loadTimeline, 2000);
    return () => clearInterval(interval);
  }, [sessionId, loadTimeline]);

  // Extract first line of content, max 80 chars — the only part that reliably
  // matches 1:1 in the terminal buffer
  const getEntryKey = useCallback((entry: TimelineEntry): string | null => {
    if (entry.type === 'compact') return null;
    const text = entry.content.split('\n')[0].slice(0, 80).trim();
    return text || null;
  }, []);

  // Check if key exists at a user prompt position in buffer text.
  const matchesAtUserPrompt = useCallback((bufferText: string, key: string, debug = false): boolean => {
    let searchFrom = 0;
    while (true) {
      const pos = bufferText.indexOf(key, searchFrom);
      if (pos === -1) {
        return false;
      }
      
      // Find start of the line containing this match
      const lineStart = bufferText.lastIndexOf('\n', pos - 1) + 1;
      
      // Check first few chars of the line for prompt markers OR valid indent
      // Increased to 50 chars to handle very long indents
      const lineHead = bufferText.slice(lineStart, Math.min(lineStart + 50, pos));
      
      // 1. Strict prompt check (standard case)
      const hasPrompt = lineHead.includes('\u276F') || lineHead.includes('\u23F5') || lineHead.includes('>');
      
      // 2. Relaxed check for pasted text/code/lists (indentation or bullets)
      // If the prefix is just whitespace, stars, dashes, or dots, assume it's a valid user entry
      // that was pasted or formatted without a visible prompt on the same line.
      const isValidIndent = /^[\s*·\-\.]*$/.test(lineHead);

      if (hasPrompt || isValidIndent) return true;
      
      if (debug) {
          // Keep debug log only if explicitly requested by checkReachability diagnosis
          console.log(`[Timeline:Reachability] Key found at ${pos} but invalid prefix: "${lineHead.replace(/\n/g, '\\n')}"`);
      }
      
      // Try next occurrence
      searchFrom = pos + 1;
    }
  }, []);

  // Viewport visibility + buffer reachability tracking
  useEffect(() => {
    if (!isVisible || entries.length === 0) {
      setVisibleEntryIndices(prev => prev.size === 0 ? prev : new Set());
      setUnreachableIndices(prev => prev.size === 0 ? prev : new Set());
      return;
    }

    // History panel open — UUID-based visibility, no unreachable zone
    if (isHistoryOpen) {
      setUnreachableIndices(prev => prev.size === 0 ? prev : new Set());

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

    // Viewport visibility — which entries are currently on screen
    const checkVisibility = () => {
      const visibleText = terminalRegistry.getVisibleText(tabId);
      if (!visibleText) {
        setVisibleEntryIndices(prev => prev.size === 0 ? prev : new Set());
        return;
      }

      const newVisible = new Set<number>();
      entries.forEach((entry, index) => {
        const key = getEntryKey(entry);
        if (key && matchesAtUserPrompt(visibleText, key)) {
          newVisible.add(index);
        }
      });

      setVisibleEntryIndices(prev => {
        if (prev.size === newVisible.size && [...prev].every(i => newVisible.has(i))) return prev;
        return newVisible;
      });
    };

    // Buffer reachability — which entries exist anywhere in the scrollback
    const checkReachability = () => {
      const fullText = terminalRegistry.getFullBufferText(tabId);
      if (!fullText) {
        setUnreachableIndices(prev => prev.size === 0 ? prev : new Set());
        return;
      }

      const newUnreachable = new Set<number>();
      entries.forEach((entry, index) => {
        if (entry.type === 'compact' || entry.type === 'continued' || entry.isPlan) return;
        const key = getEntryKey(entry);
        if (key) {
             const isReachable = matchesAtUserPrompt(fullText, key, false);
             if (!isReachable) {
                 newUnreachable.add(index);
             }
        }
      });

      // Inherit unreachable for compact/continued/plan entries from next regular entry
      entries.forEach((entry, index) => {
        if (entry.type !== 'compact' && entry.type !== 'continued' && !entry.isPlan) return;
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
    };

    // Run both on mount / entries change
    checkVisibility();
    checkReachability();

    // On viewport change (scroll + buffer writes via onWriteParsed):
    // - checkVisibility: 100ms debounce (lightweight, viewport text only)
    // - checkReachability: 500ms debounce (heavier, full buffer scan)
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
  }, [tabId, entries, isVisible, getEntryKey, matchesAtUserPrompt, isHistoryOpen, historyVisibleUuids]);

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

    if (entry.type === 'compact' || entry.type === 'continued') return;

    const index = entries.findIndex(e => e.uuid === entry.uuid);

    // If history panel is open — scroll to entry in history only, skip terminal scroll
    if (isHistoryOpen) {
      setHistoryScrollToUuid(entry.uuid);
      return;
    }

    // History panel NOT open — scroll in terminal only
    // Instant visual feedback — loader appears immediately
    setClickedState({ index, status: 'loading' });

    // ALWAYS DIAGNOSE CLICK (Temporary Debug)
    // if (unreachableIndices.has(index)) {
         console.warn(`[Timeline] Clicking entry #${index}. Diagnosing...`);
         const fullText = terminalRegistry.getFullBufferText(tabId);
         const key = getEntryKey(entry);
         if (fullText && key) {
             const found = matchesAtUserPrompt(fullText, key, true); // Force debug logs
             if (found) console.log(`[Timeline] Diagnosis: Entry IS reachable (found=${found}). Red status might be stale.`);
             else console.log(`[Timeline] Diagnosis: Entry UNREACHABLE (found=${found}).`);
         } else {
             console.log(`[Timeline] Diagnosis failed: fullText=${!!fullText}, key=${!!key}`);
         }
    // }

    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      // Plan entries: Claude TUI renders plan in a box with "Plan to implement" header,
      // the actual JSONL content is NOT in the terminal buffer
      const searchText = entry.isPlan
        ? 'Plan to implement'
        : entry.content.split('\n')[0].slice(0, 80).trim();
      if (searchText) {
        // Count earlier entries with the same search key (duplicate handling).
        // Only count same-type entries: isValidMatch in terminal only passes for
        // user prompts (preceded by ❯/⏵/>), so assistant entries with same text
        // would inflate the count but never match in the buffer.
        let occurrenceIndex = 0;
        for (let i = 0; i < index; i++) {
          const e = entries[i];
          if (e.type !== entry.type) continue;
          const eKey = e.isPlan
            ? 'Plan to implement'
            : e.content.split('\n')[0].slice(0, 80).trim();
          if (eKey === searchText) occurrenceIndex++;
        }

        const found = terminalRegistry.searchAndScrollToNth(tabId, searchText, occurrenceIndex, !!entry.isPlan);
        if (found) {
          setTimeout(() => setClickedState(null), 300);
        } else {
          setClickedState({ index, status: 'failed' });
          setTimeout(() => setClickedState(null), 1200);
        }
      } else {
        setClickedState(null);
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

    // Calculate targetIndex: position in user-only list for TUI menu navigation
    const userEntries = entries.filter(e => e.type === 'user');
    const targetIndex = userEntries.findIndex(e => e.uuid === entry.uuid);
    if (targetIndex === -1) return;

    // Count duplicate prefixes AFTER the target (we navigate UP from bottom,
    // so we encounter newer duplicates first and need to skip them)
    const targetPrefix = entry.content.trim().substring(0, 40);
    let skipDuplicates = 0;
    for (let i = targetIndex + 1; i < userEntries.length; i++) {
      const ePrefix = userEntries[i].content.trim().substring(0, 40);
      if (ePrefix === targetPrefix) skipDuplicates++;
    }

    console.warn('[Restore:Rewind] Starting rewind to entry', targetIndex, '/', userEntries.length, '- uuid:', entry.uuid, 'skipDuplicates:', skipDuplicates);

    // Phase 1: Compact entries being lost (from next entry to end)
    let compactText = '';
    // Always compact from clicked entry to end — copy-range expands to include
    // Claude's response after each user message. Even for the last entry,
    // Claude's response is included and will be compacted.
    setRewindState({ index: entryIndex, phase: 'compacting' });

    try {
      const rangeResult = await ipcRenderer.invoke('claude:copy-range', {
        sessionId,
        cwd,
        startUuid: entry.uuid,
        endUuid: entries[entries.length - 1].uuid
      });

      if (rangeResult.success && rangeResult.content) {
        console.warn('[Restore:Rewind] Range copied, length:', rangeResult.content.length);

        // Compact via Gemini using rewind prompt
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

    // Phase 2: Execute rewind in TUI + paste compact (all in main process via writeToPtySafe + \r)
    setRewindState({ index: entryIndex, phase: 'rewinding' });

    try {
      const rewindResult = await ipcRenderer.invoke('claude:open-history-menu', {
        tabId,
        targetIndex,
        targetText: entry.content.trim().substring(0, 40),
        skipDuplicates,
        pasteAfter: compactText || undefined
      });
      console.warn('[Restore:Rewind] Rewind result:', rewindResult.success ? 'OK' : 'FAIL',
        'cursor:', rewindResult.cursorIndex, 'target:', rewindResult.targetIndex,
        'compactPasted:', !!compactText);

      // Auto-scroll to bottom after rewind (Claude TUI re-renders cause scroll jumps)
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

        // Listen for scroll events — each resets the debounce
        const scrollSub = term.onScroll(() => {
          if (cleaned) return;
          if (scrollDebounce) clearTimeout(scrollDebounce);
          scrollDebounce = setTimeout(doCleanup, 200);
        });

        // Safety: cleanup after 5s even if no scroll events
        setTimeout(doCleanup, 5000);

        // Immediate scroll
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
        }}
      >
        {/* Central Axis Line */}
        <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-white/10 -translate-x-1/2 pointer-events-none" />

        {/* Segmented Hit-boxes */}
        <div className="flex flex-col h-full w-full" style={{ opacity: isVisible ? 1 : 0 }}>
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
            const active = isSelected(entry, index);
            const isCompacted = entry.type === 'compact';
            const isLastEntry = index === entries.length - 1;
            // Check if fork marker should appear AFTER this entry
            // Fork marker shows after the LAST entry that exists in the fork snapshot
            // This handles Escape/Undo correctly - marker stays with inherited entries
            const forkMarker = forkMarkers.find(m => {
              if (!m.entry_uuids || m.entry_uuids.length === 0) return false;
              const snapshotUuids = new Set(m.entry_uuids);

              // This entry must be in snapshot (inherited)
              if (!snapshotUuids.has(entry.uuid)) return false;

              // Check if NEXT entry is NOT in snapshot (new) or this is last entry
              if (isLastEntry) return true;
              const nextEntry = entries[index + 1];
              return nextEntry && !snapshotUuids.has(nextEntry.uuid);
            });

            // Check for plan mode boundary: sessionId changed and no fork marker at this position
            // Fork boundaries are already handled by forkMarker; any other sessionId change = plan mode
            const isPlanModeBoundary = (() => {
              if (isLastEntry || forkMarker) return false;
              const nextEntry = entries[index + 1];
              if (!nextEntry || !entry.sessionId || !nextEntry.sessionId) return false;
              return entry.sessionId !== nextEntry.sessionId;
            })();

            const isInViewport = visibleEntryIndices.has(index);
            const isUnreachable = unreachableIndices.has(index);
            const isContinued = entry.type === 'continued';
            const isPlan = !!entry.isPlan;
            const dotClickState = clickedState?.index === index ? clickedState.status : null;

            return (
              <React.Fragment key={entry.uuid}>
                <div
                  ref={el => segmentRefs.current[index] = el}
                  data-segment
                  className="relative flex-1 min-h-[4px] w-full flex items-center justify-center transition-colors"
                  onMouseEnter={() => handleMouseEnterSegment(index)}
                  onMouseLeave={(e) => handleMouseLeaveSegment(e)}
                  onClick={() => handleEntryClick(entry)}
                  onDoubleClick={() => handleEntryDoubleClick(entry)}
                  onContextMenu={(e) => handleRightClick(e, entry)}
                  style={{
                    backgroundColor: active
                      ? 'rgba(59, 130, 246, 0.15)'
                      : (isUnreachable ? 'rgba(239, 68, 68, 0.06)' : 'transparent'),
                    cursor: isContinued ? 'default' : 'pointer',
                  }}
                >
                  {/* Visual Indicator: Dot (normal), Line (compact), or Dot (continued=orange) */}
                  <div
                    className="transition-all duration-200 pointer-events-none"
                    style={{
                      width: isCompacted ? (isInViewport ? '10px' : '12px') : (hoveredIndex === index || activeTooltipIndex === index ? '8px' : (isInViewport ? '10px' : '4px')),
                      height: isCompacted ? (isInViewport ? '3px' : '2px') : (hoveredIndex === index || activeTooltipIndex === index ? '8px' : (isInViewport ? '3px' : '4px')),
                      borderRadius: (isCompacted || (isInViewport && hoveredIndex !== index && activeTooltipIndex !== index)) ? '1px' : '50%',
                      backgroundColor: isCompacted
                        ? (isInViewport ? '#fbbf24' : '#f59e0b')
                        : isContinued
                          ? '#f59e0b'
                          : isPlan
                            ? '#48968c'
                            : (active ? '#3b82f6' : (hoveredIndex === index || activeTooltipIndex === index ? 'white' : (isInViewport ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)'))),
                      boxShadow: (hoveredIndex === index || activeTooltipIndex === index)
                        ? (isContinued ? '0 0 8px rgba(245, 158, 11, 0.4)' : isPlan ? '0 0 8px rgba(72, 150, 140, 0.4)' : '0 0 8px rgba(255,255,255,0.4)')
                        : (isInViewport ? (isCompacted ? '0 0 6px rgba(245, 158, 11, 0.25)' : '0 0 6px rgba(255,255,255,0.25)') : 'none'),
                    }}
                  />
                  {/* Loading spinner — instant feedback on click */}
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
                  {/* Failed X — search text not found in terminal buffer */}
                  {dotClickState === 'failed' && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.7 }}>
                        <line x1="2" y1="2" x2="8" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                        <line x1="8" y1="2" x2="2" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </div>
                  )}
                </div>
                {/* Fork marker - appears AFTER the entry at position (entry_count - 1) */}
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
                {/* Plan mode marker - appears where session context was cleared */}
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
                right: `${notesPanelWidth + 24 - 8}px`,
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
                  <button
                    className="w-full text-left px-3 py-2 text-xs text-white hover:bg-blue-600 rounded transition-colors cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); startRangeSelection(contextMenu.entry); }}
                  >
                    Начать копирование
                  </button>
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
      </div>
    </>
  );
}

export default Timeline;
