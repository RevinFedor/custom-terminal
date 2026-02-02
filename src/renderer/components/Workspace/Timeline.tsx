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
const truncateText = (text: string | unknown, maxLength: number = 60): string => {
  // Handle non-string content (arrays, objects)
  if (typeof text !== 'string') {
    if (Array.isArray(text)) {
      // Claude content can be array of objects with type/text
      const firstText = text.find((item: any) => item.type === 'text' && item.text);
      if (firstText) {
        return truncateText(firstText.text, maxLength);
      }
      return '[Complex content]';
    }
    return '[Non-text content]';
  }

  // Remove newlines and extra whitespace
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return clean.slice(0, maxLength) + '…';
};

function Timeline({ tabId, sessionId, cwd }: TimelineProps) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
      } else {
        console.warn('[Timeline] Failed to load:', result.error);
        setEntries([]);
      }
    } catch (error) {
      console.error('[Timeline] Error loading timeline:', error);
      setEntries([]);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, cwd]);

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  // Refresh timeline periodically when session is active
  useEffect(() => {
    if (!sessionId) return;

    const interval = setInterval(() => {
      loadTimeline();
    }, 5000); // Refresh every 5 seconds

    return () => clearInterval(interval);
  }, [sessionId, loadTimeline]);

  // Handle click on entry - search in terminal
  const handleEntryClick = useCallback((entry: TimelineEntry) => {
    if (entry.type === 'compact') {
      return;
    }

    // Get first line, first ~40 chars for search
    const searchText = entry.content
      .split('\n')[0]
      .slice(0, 40)
      .trim();

    if (!searchText) {
      return;
    }

    terminalRegistry.searchAndScroll(tabId, searchText);
  }, [tabId]);

  // Don't render if no session
  if (!sessionId) {
    console.log('[Timeline] NOT rendering - no sessionId');
    return null;
  }

  console.log('[Timeline] RENDERING with sessionId:', sessionId, 'entries:', entries.length);

  return (
    <div
      ref={containerRef}
      className="relative flex flex-col items-center"
      data-testid="timeline-container"
      style={{
        width: '16px',
        backgroundColor: 'rgba(255, 255, 255, 0.03)',
        borderLeft: '1px solid rgba(255, 255, 255, 0.06)',
        height: '100%',
        overflowY: 'auto',
        overflowX: 'visible',
        // Hide scrollbar but keep functionality
        scrollbarWidth: 'none', // Firefox
        msOverflowStyle: 'none', // IE/Edge
      }}
    >
      {/* Hide scrollbar for Chrome/Safari */}
      <style>{`
        .timeline-scroll::-webkit-scrollbar {
          display: none;
        }
      `}</style>

      {/* Timeline line */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '8px',
          bottom: '8px',
          width: '1px',
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
          transform: 'translateX(-50%)',
          pointerEvents: 'none'
        }}
      />

      {/* Entries - scrollable container */}
      <div
        className="timeline-scroll flex flex-col items-center gap-3 relative z-10"
        style={{
          paddingTop: '8px',
          paddingBottom: '8px',
          width: '100%',
          overflowY: 'auto',
          overflowX: 'visible',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
      >
        {entries.map((entry, index) => (
          <div
            key={entry.uuid}
            className="relative"
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex(null)}
            onClick={() => handleEntryClick(entry)}
            style={{ cursor: entry.type === 'user' ? 'pointer' : 'default' }}
          >
            {/* Dot or Compact marker */}
            {entry.type === 'compact' ? (
              // Compact boundary - horizontal line
              <div
                style={{
                  width: '10px',
                  height: '3px',
                  backgroundColor: '#f59e0b', // amber
                  borderRadius: '2px'
                }}
              />
            ) : entry.isCompactSummary ? (
              // Compact summary - half-filled dot
              <div
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: 'transparent',
                  border: '2px solid rgba(245, 158, 11, 0.7)',
                }}
              />
            ) : (
              // Regular user message - dot
              <div
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: hoveredIndex === index
                    ? 'rgba(255, 255, 255, 0.9)'
                    : 'rgba(255, 255, 255, 0.5)',
                  transition: 'background-color 0.15s ease'
                }}
              />
            )}

            {/* Tooltip on hover - using fixed position to escape overflow:hidden */}
            {hoveredIndex === index && (
              <TooltipPortal>
                <div
                  style={{
                    position: 'fixed',
                    right: '320px', // Approximate position (sidebar width + timeline width + margin)
                    top: `${(containerRef.current?.getBoundingClientRect().top || 0) + index * 20 + 12}px`,
                    backgroundColor: 'rgba(30, 30, 30, 0.95)',
                    backdropFilter: 'blur(8px)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    fontSize: '11px',
                    color: 'rgba(255, 255, 255, 0.85)',
                    whiteSpace: 'nowrap',
                    maxWidth: '280px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    zIndex: 9999,
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                    pointerEvents: 'none'
                  }}
                >
                  {entry.type === 'compact' ? (
                    <span style={{ color: '#f59e0b' }}>
                      Compacted ({entry.preTokens ? `${Math.round(entry.preTokens / 1000)}K tokens` : 'unknown'})
                    </span>
                  ) : entry.isCompactSummary ? (
                    <span style={{ color: '#f59e0b', fontStyle: 'italic' }}>
                      [Summary after compact]
                    </span>
                  ) : (
                    truncateText(entry.content)
                  )}
                </div>
              </TooltipPortal>
            )}
          </div>
        ))}
      </div>

      {/* Loading indicator */}
      {isLoading && entries.length === 0 && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '4px',
            height: '4px',
            borderRadius: '50%',
            backgroundColor: 'rgba(255, 255, 255, 0.3)',
            animation: 'pulse 1s infinite'
          }}
        />
      )}
    </div>
  );
}

export default Timeline;
