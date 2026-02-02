import React, { useEffect, useState, useCallback, useRef } from 'react';
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

function Timeline({ tabId, sessionId, cwd }: TimelineProps) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
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

  // Load timeline when sessionId changes
  const loadTimeline = useCallback(async () => {
    if (!sessionId) {
      setEntries([]);
      return;
    }

    setIsLoading(true);
    try {
      const result = await ipcRenderer.invoke('claude:get-timeline', { sessionId, cwd });
      if (result.success) {
        setEntries(result.entries);
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

  // Refresh timeline periodically
  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(loadTimeline, 5000);
    return () => clearInterval(interval);
  }, [sessionId, loadTimeline]);

  // Hover logic using global mousemove (relatedTarget unreliable with portals)
  const tooltipRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null); // Container for all segments

  const handleMouseEnterSegment = (index: number) => {
    setHoveredIndex(index);
    setActiveTooltipIndex(index);
  };

  // Global mousemove listener - checks if mouse is over segment or tooltip
  useEffect(() => {
    if (activeTooltipIndex === null || isExpanded) return;

    const checkHover = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const isOverSegment = target?.closest?.('[data-segment]');
      const isOverTooltip = tooltipRef.current?.contains(target);

      if (!isOverSegment && !isOverTooltip) {
        setHoveredIndex(null);
        setActiveTooltipIndex(null);
      }
    };

    document.addEventListener('mousemove', checkHover);
    return () => document.removeEventListener('mousemove', checkHover);
  }, [activeTooltipIndex, isExpanded]);

  const handleMouseEnterTooltip = () => {
    // Keep hover state active
    if (activeTooltipIndex !== null) {
      setHoveredIndex(activeTooltipIndex);
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
        console.log('[Timeline] Range copied to clipboard');
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

  return (
    <>
      <div
        ref={containerRef}
        className="relative flex flex-col group transition-all duration-300"
        style={{
          width: '24px',
          backgroundColor: 'rgba(0, 0, 0, 0.2)',
          backdropFilter: 'blur(4px)',
          borderLeft: '1px solid rgba(255, 255, 255, 0.05)',
          height: '100%',
          zIndex: 40,
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
          {entries.map((entry, index) => {
            const active = isSelected(entry, index);
            const isCompacted = entry.type === 'compact';
            
            return (
              <div
                key={entry.uuid}
                ref={el => segmentRefs.current[index] = el}
                data-segment
                className="relative flex-1 min-h-[4px] w-full flex items-center justify-center cursor-pointer transition-colors"
                style={{
                  backgroundColor: active ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                }}
                onMouseEnter={() => handleMouseEnterSegment(index)}
                onClick={() => handleEntryClick(entry)}
                onContextMenu={(e) => handleRightClick(e, entry)}
              >
                {/* Visual Indicator (Dot or Line) */}
                <div
                  className="transition-all duration-200"
                  style={{
                    width: isCompacted ? '12px' : (hoveredIndex === index || activeTooltipIndex === index ? '8px' : '4px'),
                    height: isCompacted ? '2px' : (hoveredIndex === index || activeTooltipIndex === index ? '8px' : '4px'),
                    borderRadius: isCompacted ? '1px' : '50%',
                    backgroundColor: isCompacted 
                      ? '#f59e0b' 
                      : (active ? '#3b82f6' : (hoveredIndex === index || activeTooltipIndex === index ? 'white' : 'rgba(255,255,255,0.3)')),
                    boxShadow: (hoveredIndex === index || activeTooltipIndex === index) ? '0 0 8px rgba(255,255,255,0.4)' : 'none',
                  }}
                />
              </div>
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

        {/* Tooltip Portal */}
        {activeTooltipIndex !== null && currentActiveEntry && (
          <TooltipPortal>
            <div
              ref={tooltipRef}
              tabIndex={-1}
              onMouseEnter={handleMouseEnterTooltip}
              style={{
                position: 'fixed',
                right: `${notesPanelWidth + 32}px`,
                top: `clamp(50px, ${getElementCenterY(activeTooltipIndex)}px, calc(100vh - 150px))`,
                transform: 'translateY(-50%)',
                outline: 'none',
                zIndex: 10000,
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
                      <button
                        onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                        className="p-1.5 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors cursor-pointer shrink-0"
                        title={isExpanded ? "Свернуть" : "Развернуть полностью"}
                      >
                        {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                      </button>
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
