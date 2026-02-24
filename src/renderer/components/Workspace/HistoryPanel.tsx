import React, { useEffect, useState, useRef, useCallback, memo } from 'react';
import { X, ChevronDown, ChevronRight } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import MarkdownRenderer from '../Research/MarkdownRenderer';

const { ipcRenderer } = window.require('electron');

interface FileAction {
  tool: 'Edit' | 'Write' | 'Read';
  filePath: string;
  oldString?: string;
  newString?: string;
  content?: string;
}
type Action = string | FileAction;

const isFileAction = (a: Action): a is FileAction => typeof a === 'object' && a !== null && 'tool' in a;

interface FullHistoryEntry {
  uuid: string;
  role: 'user' | 'assistant' | 'compact' | 'fork' | 'plan-mode' | 'continued';
  timestamp: string;
  content: string;
  thinking?: string;
  actions?: Action[];
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

// Short path: last 2 segments
const shortPath = (p: string) => {
  const parts = p.split('/');
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p;
};

// Edit/Write — purple border, collapsible, no emoji
const FileActionBlock = memo(({ action }: { action: FileAction }) => {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: 4, borderLeft: '3px solid #c084fc', paddingLeft: 8 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none', border: 'none', color: '#c084fc',
          cursor: 'pointer', fontSize: 11, display: 'flex',
          alignItems: 'center', gap: 4, padding: 0,
        }}
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {shortPath(action.filePath)}
      </button>
      {open && action.tool === 'Edit' && (
        <div style={{
          marginTop: 2, fontSize: 11, fontFamily: 'monospace',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5,
        }}>
          {action.oldString && action.oldString.split('\n').map((line, i) => (
            <div key={'o' + i} style={{ color: '#fca5a5', backgroundColor: 'rgba(239,68,68,0.07)' }}>
              {'\u2212 '}{line}
            </div>
          ))}
          {action.newString && action.newString.split('\n').map((line, i) => (
            <div key={'n' + i} style={{ color: '#86efac', backgroundColor: 'rgba(34,197,94,0.07)' }}>
              {'+ '}{line}
            </div>
          ))}
        </div>
      )}
      {open && action.tool === 'Write' && action.content && (
        <div style={{
          marginTop: 2, fontSize: 11, fontFamily: 'monospace',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#999', lineHeight: 1.5,
          maxHeight: 200, overflowY: 'auto',
        }}>
          {action.content}
        </div>
      )}
    </div>
  );
});

// Read — orange border, not collapsible, no emoji
const ReadActionBlock = ({ filePath }: { filePath: string }) => (
  <div style={{ marginTop: 4, borderLeft: '3px solid #f59e0b', paddingLeft: 8 }}>
    <span style={{ fontSize: 11, color: '#f59e0b' }}>{shortPath(filePath)}</span>
  </div>
);

// Single history entry renderer
const HistoryEntry = memo(({ entry }: { entry: FullHistoryEntry }) => {
  if (entry.role === 'compact') {
    return (
      <div style={{ textAlign: 'center', padding: '8px 0', color: '#666', fontSize: 11, letterSpacing: 2 }}>
        {'═══ COMPACTED ═══'}
      </div>
    );
  }

  if (entry.role === 'fork') {
    return (
      <div style={{ textAlign: 'center', padding: '8px 0', color: '#5b9cf5', fontSize: 11, letterSpacing: 1 }}>
        {'FORK'}
      </div>
    );
  }

  if (entry.role === 'plan-mode') {
    return (
      <div style={{ textAlign: 'center', padding: '8px 0', color: '#4ade80', fontSize: 11, letterSpacing: 1 }}>
        {'CLEAR CONTEXT'}
      </div>
    );
  }

  if (entry.role === 'continued') {
    return (
      <div style={{
        padding: '8px 12px',
        backgroundColor: 'rgba(100, 100, 255, 0.06)', borderRadius: 6,
        fontSize: 12, color: '#8888cc', fontStyle: 'italic',
      }}>
        Session continued from previous conversation...
      </div>
    );
  }

  if (entry.role === 'user') {
    return (
      <div style={{
        padding: '8px 12px',
        backgroundColor: 'rgba(255, 255, 255, 0.04)', borderRadius: 6,
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
    <div style={{ padding: '8px 12px' }}>
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

      {entry.actions && entry.actions.length > 0 && (() => {
        const editWriteActions: FileAction[] = [];
        const readActions: FileAction[] = [];
        const otherActions: string[] = [];
        for (const a of entry.actions) {
          if (isFileAction(a)) {
            if (a.tool === 'Read') readActions.push(a);
            else editWriteActions.push(a);
          } else {
            otherActions.push(a);
          }
        }
        return (
          <>
            {editWriteActions.map((action, i) => (
              <FileActionBlock key={'ew' + i} action={action} />
            ))}
            {readActions.map((action, i) => (
              <ReadActionBlock key={'rd' + i} filePath={action.filePath} />
            ))}
            {otherActions.length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {otherActions.map((action, i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: 11, color: '#999',
                      backgroundColor: 'rgba(255,255,255,0.04)',
                      padding: '2px 6px', borderRadius: 4, wordBreak: 'break-all',
                    }}
                  >
                    {action}
                  </span>
                ))}
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
});

// content-visibility style for off-screen rendering skip (browser-native virtualization)
const entryWrapperStyle: React.CSSProperties = {
  paddingTop: 4,
  paddingBottom: 4,
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 100px',
};

function HistoryPanel({ tabId, sessionId, cwd, width, notesPanelWidth }: HistoryPanelProps) {
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  const setHistoryPanelWidth = useUIStore((s) => s.setHistoryPanelWidth);
  const historyScrollToUuid = useUIStore((s) => s.historyScrollToUuid);
  const setHistoryScrollToUuid = useUIStore((s) => s.setHistoryScrollToUuid);
  const closePanel = useCallback(() => setHistoryPanelOpen(tabId, false), [tabId, setHistoryPanelOpen]);

  const [entries, setEntries] = useState<FullHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const isAtBottomRef = useRef(true);

  // Scroll to bottom helper
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' as ScrollBehavior });
  }, []);

  // Load full history
  const loadHistory = useCallback(async (isRefresh = false) => {
    if (!sessionId) return;
    try {
      const result = await ipcRenderer.invoke('claude:get-full-history', { sessionId, cwd });
      if (result.success) {
        const newEntries: FullHistoryEntry[] = result.entries || [];

        if (!isRefresh) {
          console.warn(`[HP] initial load: ${newEntries.length} entries`);
          setEntries(newEntries);
          setLoading(false);
          // Scroll to bottom after DOM renders
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              scrollToBottom();
            });
          });
        } else {
          // Refresh: only update if count changed
          setEntries(prev => {
            if (newEntries.length === prev.length) return prev;
            console.warn(`[HP] refresh: ${prev.length} → ${newEntries.length}`);
            if (isAtBottomRef.current && newEntries.length > prev.length) {
              setTimeout(() => scrollToBottom(true), 100);
            }
            return newEntries;
          });
        }
      }
    } catch (e) {
      console.warn('[HistoryPanel] Load error:', e);
      if (!isRefresh) setLoading(false);
    }
  }, [sessionId, cwd, scrollToBottom]);

  // Initial load on mount / session change
  useEffect(() => {
    setLoading(true);
    setEntries([]);
    loadHistory(false);
  }, [sessionId]);

  // Incremental refresh every 3s
  useEffect(() => {
    const interval = setInterval(() => loadHistory(true), 3000);
    return () => clearInterval(interval);
  }, [loadHistory]);

  // Scroll to entry when Timeline click sets historyScrollToUuid
  useEffect(() => {
    if (!historyScrollToUuid || loading || entries.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector(`[data-uuid="${historyScrollToUuid}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setHistoryScrollToUuid(null);
  }, [historyScrollToUuid, loading, entries]);

  // Native scroll handler — at-bottom detection
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    isAtBottomRef.current = distFromBottom < 150;
  }, []);

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

  const handleResizeDoubleClick = useCallback(() => {
    closePanel();
  }, [closePanel]);

  const panel = (
    <div
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
        width: width,
        backgroundColor: '#1a1a1a',
        borderLeft: '1px solid #333',
        zIndex: 101,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Resize handle (left edge) */}
      <div
        onMouseDown={handleResizeMouseDown}
        onDoubleClick={handleResizeDoubleClick}
        style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 4,
          cursor: 'col-resize', zIndex: 10, backgroundColor: 'transparent',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#5b9cf5'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'; }}
      />

      {/* Header */}
      <div
        style={{
          height: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 12px', borderBottom: '1px solid #333', flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, color: '#999', fontWeight: 500 }}>History</span>
        <button
          onClick={closePanel}
          style={{
            background: 'none', border: 'none', color: '#666',
            cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center',
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
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            style={{ height: '100%', overflowY: 'auto' }}
          >
            {entries.map((entry) => (
              <div key={entry.uuid} data-uuid={entry.uuid} style={entryWrapperStyle}>
                <HistoryEntry entry={entry} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Backdrop overlay — covers terminal area only, click to close */}
      <div
        onClick={closePanel}
        style={{
          position: 'absolute',
          top: 0, left: 0, bottom: 0,
          right: width,
          backgroundColor: 'rgba(0, 0, 0, 0.3)',
          zIndex: 100,
        }}
      />
      {panel}
    </>
  );
}

export default memo(HistoryPanel);
