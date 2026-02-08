import React, { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Copy, Minimize2 } from 'lucide-react';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { useUIStore } from '../../store/useUIStore';

const { ipcRenderer } = window.require('electron');

// Portal for tooltip to escape overflow:hidden
const TooltipPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return createPortal(children, document.body);
};

interface TimelineEntry {
  uuid: string;
  type: 'user' | 'compact';
  timestamp: string;
  content: string;
  isCompactSummary?: boolean;
  preTokens?: number;
}

interface TimelineProps {
  tabId: string;
  sessionId: string | null;
  cwd: string;
  isActive?: boolean; // Claude is currently running
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

function Timeline({ tabId, sessionId, cwd, isActive = true }: TimelineProps) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [forkMarkers, setForkMarkers] = useState<ForkMarker[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [activeTooltipIndex, setActiveTooltipIndex] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectionStartId, setSelectionStartId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, entry: TimelineEntry } | null>(null);
  const [viewport, setViewport] = useState({ top: 0, bottom: 0, total: 1 });
  
  const notesPanelWidth = useUIStore(state => state.notesPanelWidth);
  const containerRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);

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
  }, [sessionId, cwd]);

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  // Subscribe to terminal viewport changes for scroll-sync
  useEffect(() => {
    terminalRegistry.onViewportChange(tabId, (state) => {
      setViewport(state);
    });
    return () => terminalRegistry.offViewportChange(tabId);
  }, [tabId]);

  // Refresh timeline periodically (faster when command is running for Escape detection)
  useEffect(() => {
    if (!sessionId) return;
    // Refresh every 2 seconds to catch Escape/Undo changes quickly
    const interval = setInterval(loadTimeline, 2000);
    return () => clearInterval(interval);
  }, [sessionId, loadTimeline]);

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

  const handleMouseEnterSegment = (index: number) => {
    setHoveredIndex(index);
    setActiveTooltipIndex(index);
  };

  const handleMouseLeaveSegment = (e: React.MouseEvent) => {
    setHoveredIndex(null);

    // Get segment bounds to determine direction
    const segmentRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = e.clientX;

    // If mouse went LEFT (towards tooltip) - keep open
    // If mouse went RIGHT (towards sidebar) - close
    const wentLeft = mouseX < segmentRect.left;

    if (!wentLeft && !isExpanded) {
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

  const handleEntryClick = useCallback((entry: TimelineEntry) => {
    if (entry.type === 'compact') return;
    const searchText = entry.content.split('\n')[0].slice(0, 40).trim();
    if (searchText) {
      terminalRegistry.searchAndScroll(tabId, searchText);
    }
  }, [tabId]);

  const handleRightClick = (e: React.MouseEvent, entry: TimelineEntry) => {
    e.preventDefault();
    setContextMenu({ x: e.pageX, y: e.pageY, entry });
  };

  const startRangeSelection = (entry: TimelineEntry) => {
    setSelectionStartId(entry.uuid);
    setContextMenu(null);
  };

  const finishRangeSelection = async (endEntry: TimelineEntry) => {
    if (!selectionStartId || !sessionId) return;
    
    try {
      const result = await ipcRenderer.invoke('claude:copy-range', {
        sessionId,
        cwd,
        startUuid: selectionStartId,
        endUuid: endEntry.uuid
      });
      
      if (result.success) {
        await navigator.clipboard.writeText(result.content);
      }
    } catch (error) {
      console.error('[Timeline] Range copy failed:', error);
    } finally {
      setSelectionStartId(null);
      setContextMenu(null);
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
    const handleClickOutside = () => {
      setContextMenu(null);
      // Close expanded tooltip on outside click
      if (isExpanded) {
        setIsExpanded(false);
        setActiveTooltipIndex(null);
      }
    };
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, [isExpanded]);

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
        className="relative flex flex-col group transition-all duration-300"
        style={{
          width: '24px',
          backgroundColor: isActive ? 'rgba(0, 0, 0, 0.2)' : 'rgba(40, 40, 40, 0.4)',
          backdropFilter: 'blur(4px)',
          borderLeft: `1px solid rgba(255, 255, 255, ${isActive ? 0.05 : 0.03})`,
          height: '100%',
          zIndex: 40,
          opacity: isActive ? 1 : 0.6,
        }}
      >
        {/* Central Axis Line */}
        <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-white/10 -translate-x-1/2 pointer-events-none" />

        {/* Viewport Indicator */}
        <div 
          className="absolute left-0 right-0 bg-blue-500/10 border-y border-blue-500/40 pointer-events-none z-0 transition-all duration-75"
          style={{
            top: `${(viewport.top / viewport.total) * 100}%`,
            height: `${((viewport.bottom - viewport.top) / viewport.total) * 100}%`,
            minHeight: '2px'
          }}
        />

        {/* Segmented Hit-boxes */}
        <div className="flex flex-col h-full w-full">
          {/* Fork marker at the very beginning (empty snapshot = fork before any entries) */}
          {forkMarkers.some(m => !m.entry_uuids || m.entry_uuids.length === 0) && entries.length > 0 && (
            <div
              className="flex-shrink-0 w-full flex items-center justify-center"
              style={{ height: '8px' }}
              title="Fork point - this session was forked from here"
            >
              <div
                style={{
                  width: '12px',
                  height: '2px',
                  borderRadius: '1px',
                  backgroundColor: '#3b82f6',
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

            return (
              <React.Fragment key={entry.uuid}>
                <div
                  ref={el => segmentRefs.current[index] = el}
                  data-segment
                  className="relative flex-1 min-h-[4px] w-full flex items-center justify-center cursor-pointer transition-colors"
                  style={{
                    backgroundColor: active ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                  }}
                  onMouseEnter={() => handleMouseEnterSegment(index)}
                  onMouseLeave={(e) => handleMouseLeaveSegment(e)}
                  onClick={() => handleEntryClick(entry)}
                  onContextMenu={(e) => handleRightClick(e, entry)}
                >
                  {/* Visual Indicator: Dot (normal) or Line (compact) */}
                  <div
                    className="transition-all duration-200"
                    style={{
                      width: isCompacted ? '12px' : (hoveredIndex === index || activeTooltipIndex === index ? '8px' : '4px'),
                      height: isCompacted ? '2px' : (hoveredIndex === index || activeTooltipIndex === index ? '8px' : '4px'),
                      borderRadius: isCompacted ? '1px' : '50%',
                      backgroundColor: isCompacted
                        ? '#f59e0b'  // Orange for compact
                        : (active ? '#3b82f6' : (hoveredIndex === index || activeTooltipIndex === index ? 'white' : 'rgba(255,255,255,0.3)')),
                      boxShadow: (hoveredIndex === index || activeTooltipIndex === index) ? '0 0 8px rgba(255,255,255,0.4)' : 'none',
                    }}
                  />
                </div>
                {/* Fork marker - appears AFTER the entry at position (entry_count - 1) */}
                {forkMarker && (
                  <div
                    className="flex-shrink-0 w-full flex items-center justify-center"
                    style={{ height: '8px' }}
                    title="Fork point - this session was forked from here"
                  >
                    <div
                      style={{
                        width: '12px',
                        height: '2px',
                        borderRadius: '1px',
                        backgroundColor: '#3b82f6',  // Blue for fork
                      }}
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Selection Range Indicator */}
        {selectionStartId && hoveredIndex !== null && (
          <div className="absolute left-0 right-0 pointer-events-none bg-blue-500/10 border-y border-blue-500/30"
            style={{
              top: `${Math.min(entries.findIndex(e => e.uuid === selectionStartId), hoveredIndex) / entries.length * 100}%`,
              height: `${Math.abs(entries.findIndex(e => e.uuid === selectionStartId) - hoveredIndex + 1) / entries.length * 100}%`,
            }}
          />
        )}

        {/* Tooltip Portal with CSS Bridge */}
        {activeTooltipIndex !== null && currentActiveEntry && tooltipPos && (
          <TooltipPortal>
            {/* Outer wrapper — explicit height ensures bridge connects tooltip to entry */}
            <div
              ref={tooltipRef}
              onMouseLeave={handleMouseLeaveTooltipArea}
              style={{
                position: 'fixed',
                right: `${notesPanelWidth + 24}px`,
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
                  borderRadius: '6px',
                  padding: '10px 14px',
                  fontSize: '12px',
                  color: 'white',
                  minWidth: '240px',
                  maxWidth: '320px',
                  maxHeight: isExpanded ? '60vh' : '200px',
                  boxShadow: '0 15px 35px rgba(0,0,0,0.6)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  transition: 'max-height 0.2s ease-in-out',
                  overflow: 'hidden'
                }}
              >
                {currentActiveEntry.type === 'compact' ? (
                  <span className="text-amber-400 font-medium">History Compacted ({currentActiveEntry.preTokens ? `${Math.round(currentActiveEntry.preTokens/1000)}k` : '?'} tokens)</span>
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
                        onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(currentActiveEntry.content); }}
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
                  width: '50px',
                  alignSelf: 'stretch',
                  // background: 'rgba(255,0,0,0.15)', // Uncomment for debug
                }}
              />
            </div>
          </TooltipPortal>
        )}

        {/* Context Menu */}
        {contextMenu && (
          <TooltipPortal>
            <div
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
                <button
                  className="w-full text-left px-3 py-2 text-xs text-white hover:bg-blue-600 rounded transition-colors cursor-pointer"
                  onClick={() => startRangeSelection(contextMenu.entry)}
                >
                  Начать копирование
                </button>
              ) : (
                <button
                  className="w-full text-left px-3 py-2 text-xs text-white hover:bg-green-600 rounded transition-colors cursor-pointer"
                  onClick={() => finishRangeSelection(contextMenu.entry)}
                >
                  Копировать до этой точки
                </button>
              )}
              <button
                className="w-full text-left px-3 py-2 text-xs text-white/60 hover:bg-white/5 rounded transition-colors cursor-pointer"
                onClick={() => {
                  navigator.clipboard.writeText(contextMenu.entry.content);
                  setContextMenu(null);
                }}
              >
                Копировать текст сообщения
              </button>
            </div>
          </TooltipPortal>
        )}

        {/* Loading */}
        {isLoading && entries.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
            <div className="w-1 h-1 bg-white animate-ping rounded-full" />
          </div>
        )}
      </div>
    </>
  );
}

export default Timeline;
