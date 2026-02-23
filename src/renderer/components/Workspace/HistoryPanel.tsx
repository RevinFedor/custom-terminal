import React, { useEffect, useState, useRef, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronDown, ChevronRight } from 'lucide-react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useUIStore } from '../../store/useUIStore';
import MarkdownRenderer from '../Research/MarkdownRenderer';

const { ipcRenderer } = window.require('electron');

interface FullHistoryEntry {
  uuid: string;
  role: 'user' | 'assistant' | 'compact' | 'fork' | 'plan-mode' | 'continued';
  timestamp: string;
  content: string;
  thinking?: string;
  actions?: string[];
  sessionId: string;
}

interface HistoryPanelProps {
  tabId: string;
  sessionId: string;
  cwd: string;
  width: number;
  notesPanelWidth: number;
}

// Thinking block — collapsible
const ThinkingBlock = memo(({ text }: { text: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        marginTop: 6,
        borderLeft: '2px solid #444',
        paddingLeft: 8,
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          color: '#777',
          cursor: 'pointer',
          fontSize: 11,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: 0,
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        thinking
      </button>
      {open && (
        <div style={{ fontSize: 12, color: '#888', fontStyle: 'italic', marginTop: 4, whiteSpace: 'pre-wrap' }}>
          {text}
        </div>
      )}
    </div>
  );
});

// Single history entry renderer
const HistoryEntry = memo(({ entry }: { entry: FullHistoryEntry }) => {
  if (entry.role === 'compact') {
    return (
      <div style={{
        textAlign: 'center',
        padding: '8px 0',
        color: '#666',
        fontSize: 11,
        letterSpacing: 2,
      }}>
        {'═══ COMPACTED ═══'}
      </div>
    );
  }

  if (entry.role === 'fork') {
    return (
      <div style={{
        textAlign: 'center',
        padding: '8px 0',
        color: '#5b9cf5',
        fontSize: 11,
        letterSpacing: 1,
      }}>
        {'FORK'}
      </div>
    );
  }

  if (entry.role === 'plan-mode') {
    return (
      <div style={{
        textAlign: 'center',
        padding: '8px 0',
        color: '#4ade80',
        fontSize: 11,
        letterSpacing: 1,
      }}>
        {'CLEAR CONTEXT'}
      </div>
    );
  }

  if (entry.role === 'continued') {
    return (
      <div style={{
        padding: '8px 12px',
        margin: '4px 0',
        backgroundColor: 'rgba(100, 100, 255, 0.06)',
        borderRadius: 6,
        fontSize: 12,
        color: '#8888cc',
        fontStyle: 'italic',
      }}>
        Session continued from previous conversation...
      </div>
    );
  }

  if (entry.role === 'user') {
    return (
      <div style={{
        padding: '8px 12px',
        margin: '4px 0',
        backgroundColor: 'rgba(255, 255, 255, 0.04)',
        borderRadius: 6,
        borderLeft: '3px solid rgba(255, 255, 255, 0.2)',
      }}>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>
          USER
          {entry.timestamp && (
            <span style={{ marginLeft: 8 }}>
              {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: '#e0e0e0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {entry.content}
        </div>
      </div>
    );
  }

  // Assistant
  return (
    <div style={{
      padding: '8px 12px',
      margin: '4px 0',
    }}>
      <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>
        CLAUDE
        {entry.timestamp && (
          <span style={{ marginLeft: 8 }}>
            {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      {entry.content && (
        <div style={{ fontSize: 13 }}>
          <MarkdownRenderer content={entry.content} />
        </div>
      )}

      {entry.thinking && <ThinkingBlock text={entry.thinking} />}

      {entry.actions && entry.actions.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {entry.actions.map((action, i) => (
            <span
              key={i}
              style={{
                fontSize: 11,
                color: '#999',
                backgroundColor: 'rgba(255,255,255,0.04)',
                padding: '2px 6px',
                borderRadius: 4,
                wordBreak: 'break-all',
              }}
            >
              {action}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

function HistoryPanel({ tabId, sessionId, cwd, width, notesPanelWidth }: HistoryPanelProps) {
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  const setHistoryPanelWidth = useUIStore((s) => s.setHistoryPanelWidth);

  const entriesRef = useRef<FullHistoryEntry[]>([]);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const isResizing = useRef(false);
  const prevSessionIdRef = useRef(sessionId);
  const isAtBottomRef = useRef(true);
  const isInitialLoadRef = useRef(true);

  // Load full history
  const loadHistory = useCallback(async (isRefresh = false) => {
    if (!sessionId) return;
    try {
      const result = await ipcRenderer.invoke('claude:get-full-history', { sessionId, cwd });
      if (result.success) {
        const newEntries = result.entries || [];
        const prevLen = entriesRef.current.length;
        // Only update if count changed (incremental check)
        if (!isRefresh || newEntries.length !== prevLen) {
          entriesRef.current = newEntries;
          setVersion((v) => v + 1);

          // Auto-scroll to bottom ONLY on initial load OR when new entries arrive AND user is at bottom
          const hasNewEntries = newEntries.length > prevLen;
          if (isInitialLoadRef.current || (hasNewEntries && isAtBottomRef.current)) {
            isInitialLoadRef.current = false;
            setTimeout(() => {
              virtuosoRef.current?.scrollToIndex({
                index: newEntries.length - 1,
                behavior: isRefresh ? 'smooth' : 'auto',
              });
            }, 50);
          }
        }
      }
    } catch (e) {
      console.warn('[HistoryPanel] Load error:', e);
    } finally {
      if (!isRefresh) setLoading(false);
    }
  }, [sessionId, cwd]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    entriesRef.current = [];
    isInitialLoadRef.current = true;
    setVersion((v) => v + 1);
    loadHistory(false);
    prevSessionIdRef.current = sessionId;
  }, [sessionId]);

  // Incremental refresh every 3s
  useEffect(() => {
    const interval = setInterval(() => {
      loadHistory(true);
    }, 3000);
    return () => clearInterval(interval);
  }, [loadHistory]);

  // Resize handle
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const rightEdge = document.body.clientWidth - notesPanelWidth;
      const newWidth = rightEdge - e.clientX;
      if (newWidth >= 280 && newWidth <= 700) {
        setHistoryPanelWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [notesPanelWidth, setHistoryPanelWidth]);

  // Double-click resize handle to close
  const handleResizeDoubleClick = useCallback(() => {
    setHistoryPanelOpen(false);
  }, [setHistoryPanelOpen]);

  const entries = entriesRef.current;

  const panel = (
    <div
      style={{
        position: 'fixed',
        top: 30,
        bottom: 0,
        right: notesPanelWidth,
        width: width,
        backgroundColor: '#1a1a1a',
        borderLeft: '1px solid #333',
        zIndex: 9000,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Resize handle (left edge) */}
      <div
        onMouseDown={handleResizeMouseDown}
        onDoubleClick={handleResizeDoubleClick}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          cursor: 'col-resize',
          zIndex: 10,
          backgroundColor: 'transparent',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#5b9cf5'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'; }}
      />

      {/* Header */}
      <div
        style={{
          height: 30,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid #333',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, color: '#999', fontWeight: 500 }}>History</span>
        <button
          onClick={() => setHistoryPanelOpen(false)}
          style={{
            background: 'none',
            border: 'none',
            color: '#666',
            cursor: 'pointer',
            padding: 2,
            display: 'flex',
            alignItems: 'center',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#666'; }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666', fontSize: 13 }}>
            Loading...
          </div>
        ) : entries.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#555', fontSize: 13 }}>
            No history entries
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={entries}
            totalCount={entries.length}
            itemContent={(index, entry) => (
              <HistoryEntry entry={entry} />
            )}
            style={{ height: '100%' }}
            atBottomStateChange={(atBottom) => {
              isAtBottomRef.current = atBottom;
            }}
            atBottomThreshold={100}
          />
        )}
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}

export default memo(HistoryPanel);
