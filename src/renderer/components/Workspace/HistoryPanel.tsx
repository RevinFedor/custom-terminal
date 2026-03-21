import React, { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo, memo, startTransition } from 'react';
import { X, ChevronDown, ChevronRight, Search, ArrowUp, ArrowDown } from 'lucide-react';
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
interface TaskAction {
  tool: 'Task';
  description: string;
  toolUseId?: string;
  result?: string;
  history?: Array<{ type: string; content?: string; tools?: string[] }>;
}
type Action = string | FileAction | TaskAction;

const isFileAction = (a: Action): a is FileAction =>
  typeof a === 'object' && a !== null && 'tool' in a && (a as any).tool !== 'Task';
const isTaskAction = (a: Action): a is TaskAction =>
  typeof a === 'object' && a !== null && 'tool' in a && (a as any).tool === 'Task';

interface FullHistoryEntry {
  uuid: string;
  role: 'user' | 'assistant' | 'compact' | 'fork' | 'plan-mode' | 'continued';
  timestamp: string;
  content: string;
  thinking?: string;
  actions?: Action[];
  sessionId: string;
  compactSummary?: string;
  preTokens?: number;
}

interface HistoryPanelProps {
  tabId: string;
  sessionId: string;
  cwd: string;
  width: number;
  notesPanelWidth: number;
  isOpen: boolean;
  toolType?: 'claude' | 'gemini';
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

// Sub-agent (Task) — blue border, collapsible result and history
const SubAgentBlock = memo(({ action }: { action: TaskAction }) => {
  const [showResult, setShowResult] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div style={{ marginTop: 4, borderLeft: '3px solid #60a5fa', paddingLeft: 8 }}>
      <span style={{ fontSize: 11, color: '#60a5fa' }}>
        {'\u{1F9F5}'} {action.description || 'Task agent'}
      </span>

      {action.result && (
        <div style={{ marginTop: 2 }}>
          <button
            onClick={() => setShowResult(!showResult)}
            style={{
              background: 'none', border: 'none', color: '#60a5fa',
              cursor: 'pointer', fontSize: 10, display: 'flex',
              alignItems: 'center', gap: 3, padding: 0, opacity: 0.8,
            }}
          >
            {showResult ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Результат
          </button>
          {showResult && (
            <div style={{
              marginTop: 2, fontSize: 11, color: '#bbb',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              maxHeight: 300, overflowY: 'auto',
              backgroundColor: 'rgba(96, 165, 250, 0.05)',
              padding: '4px 6px', borderRadius: 4,
            }}>
              {action.result}
            </div>
          )}
        </div>
      )}

      {action.history && action.history.length > 0 && (
        <div style={{ marginTop: 2 }}>
          <button
            onClick={() => setShowHistory(!showHistory)}
            style={{
              background: 'none', border: 'none', color: '#4ade80',
              cursor: 'pointer', fontSize: 10, display: 'flex',
              alignItems: 'center', gap: 3, padding: 0, opacity: 0.8,
            }}
          >
            {showHistory ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            История ({action.history.length} turns)
          </button>
          {showHistory && (
            <div style={{
              marginTop: 2, fontSize: 11, maxHeight: 400, overflowY: 'auto',
              display: 'flex', flexDirection: 'column', gap: 2,
            }}>
              {action.history.map((turn, i) => (
                <div key={i} style={{
                  padding: '2px 4px', borderRadius: 3,
                  backgroundColor: turn.type === 'user'
                    ? 'rgba(255,255,255,0.03)' : 'transparent',
                }}>
                  <span style={{ color: turn.type === 'user' ? '#888' : '#60a5fa', fontSize: 10 }}>
                    {turn.type === 'user' ? '\u{1F464}' : '\u{1F916}'}
                  </span>{' '}
                  {turn.content && (
                    <span style={{ color: '#aaa', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {turn.content.length > 300 ? turn.content.substring(0, 300) + '...' : turn.content}
                    </span>
                  )}
                  {turn.tools && turn.tools.map((t, j) => (
                    <div key={j} style={{ color: '#777', fontSize: 10, paddingLeft: 14 }}>{t}</div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// Compact block — expandable with summary
const CompactBlock = memo(({ entry }: { entry: FullHistoryEntry }) => {
  const [open, setOpen] = useState(false);
  const hasSummary = !!entry.compactSummary;
  const tokensLabel = entry.preTokens ? `${Math.round(entry.preTokens / 1000)}k tokens` : null;
  return (
    <div style={{ padding: '4px 0' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 6, cursor: hasSummary ? 'pointer' : 'default',
        }}
        onClick={hasSummary ? () => setOpen(!open) : undefined}
      >
        <div style={{ flex: 1, height: 1, backgroundColor: '#f59e0b', opacity: 0.3 }} />
        {hasSummary && (
          open ? <ChevronDown size={10} style={{ color: '#f59e0b', flexShrink: 0 }} />
               : <ChevronRight size={10} style={{ color: '#f59e0b', flexShrink: 0 }} />
        )}
        <span style={{ color: '#f59e0b', fontSize: 11, letterSpacing: 1, flexShrink: 0, opacity: 0.8 }}>
          COMPACTED{tokensLabel ? ` (${tokensLabel})` : ''}
        </span>
        <div style={{ flex: 1, height: 1, backgroundColor: '#f59e0b', opacity: 0.3 }} />
      </div>
      {open && entry.compactSummary && (
        <div style={{
          marginTop: 6, padding: '8px 12px',
          backgroundColor: 'rgba(245, 158, 11, 0.04)',
          borderLeft: '2px solid rgba(245, 158, 11, 0.3)',
          borderRadius: 4,
          fontSize: 12, color: '#999',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: 300, overflowY: 'auto',
        }}>
          {entry.compactSummary}
        </div>
      )}
    </div>
  );
});

// Single history entry renderer
const HistoryEntry = memo(({ entry, toolType }: { entry: FullHistoryEntry; toolType?: 'claude' | 'gemini' }) => {
  if (entry.role === 'compact') {
    return <CompactBlock entry={entry} />;
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
        {toolType === 'gemini' ? 'GEMINI' : 'CLAUDE'}
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
        const taskActions: TaskAction[] = [];
        const otherActions: string[] = [];
        for (const a of entry.actions) {
          if (isTaskAction(a)) {
            taskActions.push(a);
          } else if (isFileAction(a)) {
            if (a.tool === 'Read') readActions.push(a);
            else editWriteActions.push(a);
          } else if (typeof a === 'string') {
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
            {taskActions.map((action, i) => (
              <SubAgentBlock key={'task' + i} action={action} />
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

// Flash highlight + search highlight keyframes (injected once)
if (!document.getElementById('hp-flash-style')) {
  const style = document.createElement('style');
  style.id = 'hp-flash-style';
  style.textContent = `@keyframes hp-flash {
  0%   { background-color: transparent; }
  20%  { background-color: rgba(91, 156, 245, 0.2); }
  100% { background-color: transparent; }
}
::highlight(hp-search) {
  background-color: rgba(234, 179, 8, 0.35);
  color: inherit;
}
::highlight(hp-search-current) {
  background-color: rgba(234, 179, 8, 0.8);
  color: #000;
}`;
  document.head.appendChild(style);
}

// content-visibility style for off-screen rendering skip (browser-native virtualization)
const entryWrapperStyle: React.CSSProperties = {
  paddingTop: 4,
  paddingBottom: 4,
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 100px',
};

function HistoryPanel({ tabId, sessionId, cwd, width, notesPanelWidth, isOpen, toolType = 'claude' }: HistoryPanelProps) {
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  const setHistoryPanelWidth = useUIStore((s) => s.setHistoryPanelWidth);
  const historyScrollToUuid = useUIStore((s) => s.historyScrollToUuid);
  const setHistoryScrollToUuid = useUIStore((s) => s.setHistoryScrollToUuid);
  const setHistoryVisibleUuids = useUIStore((s) => s.setHistoryVisibleUuids);
  const setHistoryScrollPosition = useUIStore((s) => s.setHistoryScrollPosition);
  const closePanel = useCallback(() => setHistoryPanelOpen(tabId, false), [tabId, setHistoryPanelOpen]);

  // Save scroll position + clean up CSS highlights on unmount
  useEffect(() => {
    return () => {
      const el = scrollRef.current;
      if (el) setHistoryScrollPosition(tabId, el.scrollTop);
      if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
      const CSS_HL = (CSS as any).highlights;
      CSS_HL?.delete('hp-search');
      CSS_HL?.delete('hp-search-current');
    };
  }, [tabId, setHistoryScrollPosition]);

  // Slide animation state
  const [slideIn, setSlideIn] = useState(false);
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setSlideIn(true));
      });
    } else {
      setSlideIn(false);
    }
  }, [isOpen]);

  const [entries, setEntries] = useState<FullHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollArrowRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const isAtBottomRef = useRef(true);
  const prevVisibleUuidsRef = useRef('');
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ========== SEARCH ==========
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Build flat list of match positions: { entryIdx, entryUuid, offset }
  const matchPositions = useMemo(() => {
    if (!searchQuery || searchQuery.length < 2) return [];
    const q = searchQuery.toLowerCase();
    const positions: Array<{ entryIdx: number; entryUuid: string; offset: number }> = [];
    for (let i = 0; i < entries.length; i++) {
      const text = (entries[i].content || '').toLowerCase();
      let idx = text.indexOf(q);
      while (idx !== -1) {
        positions.push({ entryIdx: i, entryUuid: entries[i].uuid, offset: idx });
        idx = text.indexOf(q, idx + 1);
      }
    }
    return positions;
  }, [entries, searchQuery]);

  // Reset current match when query changes and scroll to first match
  useEffect(() => {
    if (matchPositions.length > 0) {
      setCurrentMatchIdx(0);
      // Scroll to first match
      const match = matchPositions[0];
      const el = scrollRef.current;
      if (el) {
        const entryEl = el.querySelector(`[data-uuid="${match.entryUuid}"]`) as HTMLElement;
        if (entryEl) entryEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }, [searchQuery]);

  // Navigate to current match entry
  const scrollToMatch = useCallback((idx: number) => {
    if (idx < 0 || idx >= matchPositions.length) return;
    const match = matchPositions[idx];
    const el = scrollRef.current;
    if (!el) return;
    const entryEl = el.querySelector(`[data-uuid="${match.entryUuid}"]`) as HTMLElement;
    if (entryEl) {
      entryEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [matchPositions]);

  const goNextMatch = useCallback(() => {
    if (matchPositions.length === 0) return;
    const next = (currentMatchIdx + 1) % matchPositions.length;
    setCurrentMatchIdx(next);
    scrollToMatch(next);
  }, [currentMatchIdx, matchPositions.length, scrollToMatch]);

  const goPrevMatch = useCallback(() => {
    if (matchPositions.length === 0) return;
    const prev = (currentMatchIdx - 1 + matchPositions.length) % matchPositions.length;
    setCurrentMatchIdx(prev);
    scrollToMatch(prev);
  }, [currentMatchIdx, matchPositions.length, scrollToMatch]);

  // CSS Highlight API — apply highlights after render
  useEffect(() => {
    const CSS_HL = (CSS as any).highlights;
    if (!CSS_HL || !scrollRef.current) {
      CSS_HL?.delete('hp-search');
      CSS_HL?.delete('hp-search-current');
      return;
    }
    if (!searchQuery || searchQuery.length < 2 || matchPositions.length === 0) {
      CSS_HL.delete('hp-search');
      CSS_HL.delete('hp-search-current');
      return;
    }

    // Debounce DOM traversal slightly
    const timer = setTimeout(() => {
      const q = searchQuery.toLowerCase();
      const qLen = searchQuery.length;
      const allRanges: Range[] = [];
      const currentRanges: Range[] = [];
      const currentMatch = matchPositions[currentMatchIdx];

      // Walk all text nodes in scroll container
      const walker = document.createTreeWalker(scrollRef.current!, NodeFilter.SHOW_TEXT);
      // Track which data-uuid entry we're inside + occurrence index per entry
      const entryOccurrences = new Map<string, number>();

      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const text = node.textContent?.toLowerCase();
        if (!text) continue;

        // Find which entry this node belongs to
        let entryUuid = '';
        let parent = node.parentElement;
        while (parent && parent !== scrollRef.current) {
          if (parent.dataset?.uuid) { entryUuid = parent.dataset.uuid; break; }
          parent = parent.parentElement;
        }

        let idx = text.indexOf(q);
        while (idx !== -1) {
          try {
            const range = new Range();
            range.setStart(node, idx);
            range.setEnd(node, idx + qLen);
            allRanges.push(range);

            // Check if this is the current match
            if (currentMatch && entryUuid === currentMatch.entryUuid) {
              const occ = entryOccurrences.get(entryUuid) || 0;
              // Find how many matches exist for this entry before currentMatchIdx
              const entryMatches = matchPositions.filter(m => m.entryUuid === entryUuid);
              const localIdx = entryMatches.findIndex(m => m === currentMatch);
              if (occ === localIdx) {
                currentRanges.push(range);
              }
              entryOccurrences.set(entryUuid, occ + 1);
            }
          } catch {}
          idx = text.indexOf(q, idx + 1);
        }
      }

      if (allRanges.length > 0) {
        CSS_HL.set('hp-search', new (window as any).Highlight(...allRanges));
      } else {
        CSS_HL.delete('hp-search');
      }
      if (currentRanges.length > 0) {
        CSS_HL.set('hp-search-current', new (window as any).Highlight(...currentRanges));
      } else {
        CSS_HL.delete('hp-search-current');
      }
    }, 50);

    return () => {
      clearTimeout(timer);
      CSS_HL?.delete('hp-search');
      CSS_HL?.delete('hp-search-current');
    };
  }, [searchQuery, matchPositions, currentMatchIdx, entries]);

  // Ctrl+F handler — scoped to history panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.metaKey && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape' && searchOpen) {
        e.stopPropagation();
        setSearchOpen(false);
        setSearchQuery('');
        setCurrentMatchIdx(0);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true); // capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, searchOpen]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setCurrentMatchIdx(0);
  }, []);

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
      const ipcChannel = toolType === 'gemini' ? 'gemini:get-full-history' : 'claude:get-full-history';
      const result = await ipcRenderer.invoke(ipcChannel, { sessionId, cwd });
      if (result.success) {
        const newEntries: FullHistoryEntry[] = result.entries || [];

        if (!isRefresh) {
          console.warn(`[HP] initial load: ${newEntries.length} entries`);
          // startTransition: React 19 yields to browser between chunks,
          // keeping spinner animation smooth during heavy DOM renders
          startTransition(() => {
            setEntries(newEntries);
            setLoading(false);
          });
          // Starts at the top by default (no scrollToBottom on initial load)
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
  }, [sessionId, cwd, scrollToBottom, toolType]);

  // Broadcast loading state to InfoPanel button
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('history-panel:loading', { detail: { tabId, loading } }));
  }, [loading, tabId]);

  // Initial load on mount / session change / tool type switch
  const initialLoadDoneRef = useRef(false);
  useEffect(() => {
    initialLoadDoneRef.current = false;
    setLoading(true);
    setEntries([]);
    loadHistory(false);
  }, [sessionId, toolType]);

  // Restore saved scroll position after initial load completes
  useEffect(() => {
    if (loading || initialLoadDoneRef.current) return;
    initialLoadDoneRef.current = true;
    const savedPos = useUIStore.getState().historyScrollPositions[tabId];
    if (savedPos && savedPos > 0) {
      // Wait for DOM to render entries, then restore scroll
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) {
          el.scrollTop = savedPos;
          // contentVisibility:auto may cause layout shifts — retry once
          requestAnimationFrame(() => {
            if (el) el.scrollTop = savedPos;
          });
        }
      });
    }
  }, [loading, tabId]);

  // Incremental refresh every 3s
  useEffect(() => {
    const interval = setInterval(() => loadHistory(true), 3000);
    return () => clearInterval(interval);
  }, [loadHistory]);

  // Listen for scroll-to-bottom from Timeline arrow button
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tabId === tabId) {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      }
    };
    window.addEventListener('history-panel:scroll-to-bottom', handler);
    return () => window.removeEventListener('history-panel:scroll-to-bottom', handler);
  }, [tabId]);

  // Scroll to entry when Timeline click sets historyScrollToUuid
  // Uses instant scroll + retry: contentVisibility:auto causes layout shifts on first scroll,
  // so we scroll twice to land accurately regardless of session length.
  // Adds ~10% top offset so the entry isn't flush against the edge, plus a flash highlight.
  const [flashUuid, setFlashUuid] = useState<string | null>(null);

  useEffect(() => {
    if (!historyScrollToUuid || loading || entries.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    let cancelled = false;
    const target = el.querySelector(`[data-uuid="${historyScrollToUuid}"]`) as HTMLElement | null;
    if (target) {
      const scrollWithOffset = () => {
        const targetRect = target.getBoundingClientRect();
        const containerRect = el.getBoundingClientRect();
        const offset = targetRect.top - containerRect.top + el.scrollTop;
        const topPadding = el.clientHeight * 0.1;
        el.scrollTop = Math.max(0, offset - topPadding);
      };
      scrollWithOffset();
      // Retry after layout recalculation (contentVisibility: auto re-measures nearby elements)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled) return;
          scrollWithOffset();
          // Flash highlight AFTER scroll has settled
          setTimeout(() => {
            if (cancelled) return;
            setFlashUuid(historyScrollToUuid);
            setTimeout(() => { if (!cancelled) setFlashUuid(null); }, 500);
          }, 80);
        });
      });
    }
    setHistoryScrollToUuid(null);
    return () => { cancelled = true; };
  }, [historyScrollToUuid, loading, entries]);

  // Native scroll handler — at-bottom detection + scroll direction tracking + position save
  const lastScrollTopRef = useRef(0);
  const scrollDirectionRef = useRef<'down' | 'up'>('down');
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    isAtBottomRef.current = distFromBottom < 150;
    // Toggle scroll-to-bottom arrow
    if (scrollArrowRef.current) {
      scrollArrowRef.current.style.display = distFromBottom > 150 ? '' : 'none';
    }
    scrollDirectionRef.current = el.scrollTop >= lastScrollTopRef.current ? 'down' : 'up';
    lastScrollTopRef.current = el.scrollTop;
    // Debounced save of scroll position per-tab
    if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
    scrollSaveTimerRef.current = setTimeout(() => {
      setHistoryScrollPosition(tabId, el.scrollTop);
    }, 150);
  }, [tabId, setHistoryScrollPosition]);

  // Keep entries ref fresh for observer closure (avoids stale data if entries update with same length)
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // Build mapping: assistant/non-user UUID → preceding user UUID
  // So when an assistant response is visible, the parent user dot stays highlighted in Timeline.
  const assistantToUserMap = React.useMemo(() => {
    const map = new Map<string, string>();
    let lastUserUuid: string | null = null;
    for (const e of entries) {
      if (e.role === 'user') {
        lastUserUuid = e.uuid;
      } else if (lastUserUuid) {
        map.set(e.uuid, lastUserUuid);
      }
    }
    return map;
  }, [entries]);

  // Track visible entries for Timeline viewport indicator (UUID-based, no text search)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || entries.length === 0) {
      setHistoryVisibleUuids(tabId, []);
      return;
    }

    const visibleSet = new Set<string>();
    prevVisibleUuidsRef.current = '';

    const observer = new IntersectionObserver(
      (observed) => {
        for (const oe of observed) {
          const uuid = (oe.target as HTMLElement).dataset.uuid;
          if (!uuid) continue;
          if (oe.isIntersecting) visibleSet.add(uuid);
          else visibleSet.delete(uuid);
        }
        // Resolve assistant UUIDs to their parent user UUIDs for Timeline
        const resolvedSet = new Set<string>();
        for (const uuid of visibleSet) {
          resolvedSet.add(uuid);
          const parentUser = assistantToUserMap.get(uuid);
          if (parentUser) resolvedSet.add(parentUser);
        }
        // Single-turn highlight: if multiple user entries are directly visible (>10%),
        // keep only one based on scroll direction:
        //   scrolling DOWN → keep last (bottom-most, the "next" turn)
        //   scrolling UP   → keep first (top-most, the "previous" turn)
        const directlyVisibleUsers: string[] = [];
        for (const e of entriesRef.current) {
          if (e.role === 'user' && visibleSet.has(e.uuid)) {
            directlyVisibleUsers.push(e.uuid);
          }
        }
        if (directlyVisibleUsers.length > 1) {
          const keepIdx = scrollDirectionRef.current === 'down'
            ? directlyVisibleUsers.length - 1
            : 0;
          for (let j = 0; j < directlyVisibleUsers.length; j++) {
            if (j !== keepIdx) resolvedSet.delete(directlyVisibleUsers[j]);
          }
        }
        const key = [...resolvedSet].sort().join(',');
        if (key !== prevVisibleUuidsRef.current) {
          prevVisibleUuidsRef.current = key;
          setHistoryVisibleUuids(tabId, [...resolvedSet]);
        }
      },
      { root: el, threshold: 0.1 }
    );

    el.querySelectorAll('[data-uuid]').forEach(child => observer.observe(child));

    return () => {
      observer.disconnect();
      setHistoryVisibleUuids(tabId, []);
    };
  }, [tabId, entries.length, setHistoryVisibleUuids, assistantToUserMap]);

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
      if (newWidth >= 280) {
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
        transform: slideIn ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 50ms ease-out',
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
          display: 'flex', alignItems: 'center', height: 30,
          padding: '0 8px 0 12px', borderBottom: '1px solid #333', flexShrink: 0, gap: 6,
        }}
      >
        <span style={{ fontSize: 12, color: '#999', fontWeight: 500, flexShrink: 0 }}>History</span>
        <button
          onClick={openSearch}
          title="Search (Cmd+F)"
          style={{
            background: 'none', border: 'none', color: searchOpen ? '#e0e0e0' : '#666',
            cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = searchOpen ? '#e0e0e0' : '#666'; }}
        >
          <Search size={13} />
        </button>
        {searchOpen && (
          <>
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); goNextMatch(); }
                if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); goPrevMatch(); }
                if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
                // Only stop propagation for keys the input handles — let modifiers (Meta, Shift, etc.) through
                if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation();
              }}
              placeholder="Search..."
              style={{
                flex: 1, minWidth: 0, height: 20, fontSize: 12,
                backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: 3,
                color: '#e0e0e0', padding: '0 6px', outline: 'none',
              }}
              onFocus={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = '#5b9cf5'; }}
              onBlur={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = '#444'; }}
            />
            <button onClick={goPrevMatch} title="Previous (Shift+Enter)" style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', padding: 1, display: 'flex' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#888'; }}
            ><ArrowUp size={14} /></button>
            <button onClick={goNextMatch} title="Next (Enter)" style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', padding: 1, display: 'flex' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#888'; }}
            ><ArrowDown size={14} /></button>
            <span style={{ fontSize: 11, color: '#666', flexShrink: 0, minWidth: 35, textAlign: 'right' }}>
              {matchPositions.length > 0 ? `${currentMatchIdx + 1}/${matchPositions.length}` : searchQuery.length >= 2 ? '0' : ''}
            </span>
            <button onClick={closeSearch} title="Close search (Esc)" style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', padding: 1, display: 'flex', flexShrink: 0 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#666'; }}
            ><X size={13} /></button>
          </>
        )}
        {!searchOpen && <div style={{ flex: 1 }} />}
        <button
          onClick={closePanel}
          style={{
            background: 'none', border: 'none', color: '#666',
            cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#666'; }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#818cf8', fontSize: 13, gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" style={{ animation: 'spinner-rotate 1s linear infinite', willChange: 'transform' }}>
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
            </svg>
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
              <div
                key={entry.uuid}
                data-uuid={entry.uuid}
                style={{
                  ...entryWrapperStyle,
                  ...(flashUuid === entry.uuid ? { animation: 'hp-flash 500ms ease-in-out' } : undefined),
                }}
              >
                <HistoryEntry entry={entry} toolType={toolType} />
              </div>
            ))}
          </div>
        )}
        {/* Scroll-to-bottom arrow — visibility toggled via ref in handleScroll */}
        <div
          ref={scrollArrowRef}
          className="flex items-center justify-center"
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            // Instant jump — smooth scroll can't reach the end on very long lists
            el.scrollTop = el.scrollHeight;
          }}
          style={{
            display: 'none',
            position: 'absolute',
            bottom: 12,
            right: 12,
            width: 28,
            height: 28,
            borderRadius: 6,
            backgroundColor: '#323237',
            border: '1px solid rgba(167, 139, 250, 0.3)',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
            cursor: 'pointer',
            zIndex: 10,
          }}
          title="Scroll to bottom"
        >
          <ChevronDown size={16} color="#a78bfa" strokeWidth={2.5} />
        </div>
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
          opacity: slideIn ? 1 : 0,
          transition: 'opacity 50ms ease-out',
          zIndex: 100,
        }}
      />
      {panel}
    </>
  );
}

export default memo(HistoryPanel);
