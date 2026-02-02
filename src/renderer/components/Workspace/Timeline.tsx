import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { terminalRegistry } from '../../utils/terminalRegistry';

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
const truncateText = (text: string | unknown, maxLength: number = 80): string => {
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
  const [selectionStartId, setSelectionStartId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, entry: TimelineEntry } | null>(null);
  const [viewport, setViewport] = useState({ top: 0, bottom: 0, total: 1 });
  
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
        // Show success visual feedback? 
        console.log('[Timeline] Range copied to clipboard');
      }
    } catch (error) {
      console.error('[Timeline] Range copy failed:', error);
    } finally {
      setSelectionStartId(null);
      setContextMenu(null);
    }
  };

  // Check if an index is within the current selection range
  const isSelected = (entry: TimelineEntry, index: number) => {
    if (!selectionStartId) return false;
    const startIndex = entries.findIndex(e => e.uuid === selectionStartId);
    if (startIndex === -1) return false;
    
    const min = Math.min(startIndex, hoveredIndex ?? startIndex);
    const max = Math.max(startIndex, hoveredIndex ?? startIndex);
    
    // During hover, we highlight the potential range
    const currentIndex = entries.findIndex(e => e.uuid === entry.uuid);
    return currentIndex >= min && currentIndex <= max;
  };

  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  if (!sessionId) return null;

  return (
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

      {/* Viewport Indicator (Floating window showing terminal scroll) */}
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
              className="relative flex-1 min-h-[4px] w-full flex items-center justify-center cursor-pointer transition-colors"
              style={{
                backgroundColor: active ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
              }}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              onClick={() => handleEntryClick(entry)}
              onContextMenu={(e) => handleRightClick(e, entry)}
            >
              {/* Visual Indicator (Dot or Line) */}
              <div
                className="transition-all duration-200"
                style={{
                  width: isCompacted ? '12px' : (hoveredIndex === index ? '8px' : '4px'),
                  height: isCompacted ? '2px' : (hoveredIndex === index ? '8px' : '4px'),
                  borderRadius: isCompacted ? '1px' : '50%',
                  backgroundColor: isCompacted 
                    ? '#f59e0b' 
                    : (active ? '#3b82f6' : (hoveredIndex === index ? 'white' : 'rgba(255,255,255,0.3)')),
                  boxShadow: hoveredIndex === index ? '0 0 8px rgba(255,255,255,0.4)' : 'none',
                }}
              />

              {/* Tooltip */}
              {hoveredIndex === index && (
                <TooltipPortal>
                  <div
                    style={{
                      position: 'fixed',
                      right: '340px',
                      top: `${getElementCenterY(index)}px`,
                      transform: 'translateY(-50%)',
                      backgroundColor: 'rgba(20, 20, 20, 0.95)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '4px',
                      padding: '8px 12px',
                      fontSize: '12px',
                      color: 'white',
                      maxWidth: '300px',
                      zIndex: 10000,
                      boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
                      pointerEvents: 'none'
                    }}
                  >
                    {isCompacted ? (
                      <span className="text-amber-400 font-medium">History Compacted ({entry.preTokens ? `${Math.round(entry.preTokens/1000)}k` : '?'} tokens)</span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <span className="text-white/90 leading-snug">{truncateText(entry.content)}</span>
                        <span className="text-[10px] text-white/40">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                      </div>
                    )}
                  </div>
                </TooltipPortal>
              )}
            </div>
          );
        })}
      </div>

      {/* Selection Range Indicator (Floating Overlay) */}
      {selectionStartId && hoveredIndex !== null && (
        <div className="absolute left-0 right-0 pointer-events-none bg-blue-500/10 border-y border-blue-500/30"
          style={{
            top: `${Math.min(entries.findIndex(e => e.uuid === selectionStartId), hoveredIndex) / entries.length * 100}%`,
            height: `${Math.abs(entries.findIndex(e => e.uuid === selectionStartId) - hoveredIndex + 1) / entries.length * 100}%`,
          }}
        />
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
                className="w-full text-left px-3 py-2 text-xs text-white hover:bg-blue-600 rounded transition-colors"
                onClick={() => startRangeSelection(contextMenu.entry)}
              >
                Начать копирование
              </button>
            ) : (
              <button
                className="w-full text-left px-3 py-2 text-xs text-white hover:bg-green-600 rounded transition-colors"
                onClick={() => finishRangeSelection(contextMenu.entry)}
              >
                Копировать до этой точки
              </button>
            )}
            <button
              className="w-full text-left px-3 py-2 text-xs text-white/60 hover:bg-white/5 rounded transition-colors"
              onClick={() => {
                const searchText = contextMenu.entry.content.split('\n')[0].slice(0, 40).trim();
                if (searchText) navigator.clipboard.writeText(contextMenu.entry.content);
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
  );
}

export default Timeline;
