import React, { useEffect, useState, useRef, useCallback, useMemo, memo, startTransition } from 'react';
import { X, ChevronDown, ChevronRight, Search, ArrowUp, ArrowDown } from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useUIStore } from '../../store/useUIStore';
import Tooltip from '../UI/Tooltip';
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

// Thinking block — blue collapsible, collapsed by default
const ThinkingBlock = memo(({ text }: { text: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        marginTop: 8,
        borderLeft: '3px solid #60a5fa',
        paddingLeft: 8,
        backgroundColor: 'rgba(96, 165, 250, 0.06)',
        borderRadius: '0 4px 4px 0',
        padding: '4px 8px 4px 8px',
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          color: '#60a5fa',
          cursor: 'pointer',
          fontSize: 11,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: 0,
          fontWeight: 500,
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Thinking
      </button>
      {open && (
        <div style={{
          fontSize: 12, color: '#b0c4de', marginTop: 6, whiteSpace: 'pre-wrap',
          lineHeight: 1.5, maxHeight: 400, overflowY: 'auto',
        }}>
          <MarkdownRenderer content={text} />
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
          {entry.uuid && (
            <span style={{ marginLeft: 8, opacity: 0.5, fontFamily: 'monospace', fontSize: 9 }}>
              {entry.uuid.slice(0, 8)}
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
        {entry.uuid && (
          <span style={{ marginLeft: 8, opacity: 0.5, fontFamily: 'monospace', fontSize: 9 }}>
            {entry.uuid.slice(0, 8)}
          </span>
        )}
      </div>

      {entry.thinking && <ThinkingBlock text={entry.thinking} />}

      {entry.content && (
        <div style={{ fontSize: 13 }}>
          <MarkdownRenderer content={entry.content} />
        </div>
      )}

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


function HistoryPanel({ tabId, sessionId, cwd, width, notesPanelWidth, isOpen, toolType = 'claude' }: HistoryPanelProps) {
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  const setHistoryPanelWidth = useUIStore((s) => s.setHistoryPanelWidth);
  const historyScrollToUuid = useUIStore((s) => s.historyScrollToUuid);
  const setHistoryScrollToUuid = useUIStore((s) => s.setHistoryScrollToUuid);
  const setHistoryVisibleUuids = useUIStore((s) => s.setHistoryVisibleUuids);
  const setHistoryScrollPosition = useUIStore((s) => s.setHistoryScrollPosition);
  const closePanel = useCallback(() => setHistoryPanelOpen(tabId, false), [tabId, setHistoryPanelOpen]);

  // Save scroll position + clean up CSS highlights on unmount.
  // Virtuoso owns scrolling — the scrollTop we save belongs to the inner
  // scroller element (via scrollerRef), not scrollRef.
  useEffect(() => {
    return () => {
      const el = virtuosoScrollerRef.current;
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
  // Last entry uuid Claude's own backtrace reaches before stopping at the first
  // orphan. Any entry at index <= boundary is part of the chain-break zone:
  // visible in HistoryPanel through recovery, but unreachable by Claude's
  // own backtrace. Red tint marks it across all view modes (HistoryPanel
  // included) so the user sees what Claude actually has in RAM vs what we
  // recovered via physical-predecessor fallback. Compact is irrelevant —
  // orphans appear with or without compacts (rebuild / Stop / Esc / SSE).
  const [claudeMemoryBoundaryUuid, setClaudeMemoryBoundaryUuid] = useState<string | null>(null);
  const claudeMemoryBoundaryIndex = useMemo(() => {
    if (!claudeMemoryBoundaryUuid) return -1;
    return entries.findIndex(e => e.uuid === claudeMemoryBoundaryUuid);
  }, [entries, claudeMemoryBoundaryUuid]);
  const scrollArrowRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const isResizing = useRef(false);
  const isAtBottomRef = useRef(true);
  const prevVisibleUuidsRef = useRef('');
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Virtuoso's actual scroller element (filled via `scrollerRef` callback).
  // Used by Cmd+F CSS Highlight API to walk text nodes of the currently
  // mounted item range. Virtuoso unmounts off-screen items, so highlights
  // re-apply on every range change via the same effect (matchPositions deps).
  const virtuosoScrollerRef = useRef<HTMLElement | null>(null);
  // Visible index range from Virtuoso. Drives the visible-uuid set without
  // an IntersectionObserver (cheaper, exact: no threshold guessing).
  const visibleRangeRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  // Latest entries length — let stable callbacks (scrollToBottom) read it
  // without depending on `entries` (which would invalidate downstream effects
  // on every refresh).
  const lengthRef = useRef(0);

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
      const match = matchPositions[0];
      virtuosoRef.current?.scrollToIndex({ index: match.entryIdx, align: 'center', behavior: 'smooth' });
    }
  }, [searchQuery]);

  // Navigate to current match entry
  const scrollToMatch = useCallback((idx: number) => {
    if (idx < 0 || idx >= matchPositions.length) return;
    const match = matchPositions[idx];
    virtuosoRef.current?.scrollToIndex({ index: match.entryIdx, align: 'center', behavior: 'smooth' });
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
    if (!CSS_HL || !virtuosoScrollerRef.current) {
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
      const walker = document.createTreeWalker(virtuosoScrollerRef.current!, NodeFilter.SHOW_TEXT);
      // Track which data-uuid entry we're inside + occurrence index per entry
      const entryOccurrences = new Map<string, number>();

      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const text = node.textContent?.toLowerCase();
        if (!text) continue;

        // Find which entry this node belongs to
        let entryUuid = '';
        let parent = node.parentElement;
        while (parent && parent !== virtuosoScrollerRef.current) {
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

  // Scroll to bottom helper — Virtuoso scrollToIndex(last) is more reliable
  // than scrollTo(scrollHeight) on virtualized lists where final scrollHeight
  // isn't known until items are measured. `followOutput` on Virtuoso handles
  // sticky-bottom on incremental refresh automatically; we call this only
  // from the explicit FAB / history-panel:scroll-to-bottom event.
  // Reads the latest length via ref so consumer effects don't need to depend
  // on `entries` (the callback identity stays stable).
  const scrollToBottom = useCallback((smooth = false) => {
    const handle = virtuosoRef.current;
    const len = lengthRef.current;
    if (handle && len > 0) {
      handle.scrollToIndex({ index: len - 1, align: 'end', behavior: smooth ? 'smooth' : 'auto' });
    }
  }, []);

  // Load full history
  const loadHistory = useCallback(async (isRefresh = false) => {
    if (!sessionId) return;
    try {
      const ipcChannel = toolType === 'gemini' ? 'gemini:get-full-history' : 'claude:get-full-history';
      const result = await ipcRenderer.invoke(ipcChannel, { sessionId, cwd });
      if (result.success) {
        const newEntries: FullHistoryEntry[] = result.entries || [];
        setClaudeMemoryBoundaryUuid(result.claudeMemoryBoundaryUuid || null);

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

  // Restore saved scroll position after initial load completes.
  // Virtuoso owns the scroller, so we write into `virtuosoScrollerRef.current.scrollTop`
  // after the scroller element has been attached. `initialScrollTop` would be
  // cleaner but it requires the scroller to be mounted on first render — our
  // session/loading flow rebuilds the list, so a write-once useEffect is more
  // robust. Retry once: Virtuoso may re-measure items after first paint.
  useEffect(() => {
    if (loading || initialLoadDoneRef.current) return;
    initialLoadDoneRef.current = true;
    const savedPos = useUIStore.getState().historyScrollPositions[tabId];
    if (savedPos && savedPos > 0) {
      requestAnimationFrame(() => {
        const el = virtuosoScrollerRef.current;
        if (el) {
          el.scrollTop = savedPos;
          requestAnimationFrame(() => { if (el) el.scrollTop = savedPos; });
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
      if (detail?.tabId === tabId) scrollToBottom(true);
    };
    window.addEventListener('history-panel:scroll-to-bottom', handler);
    return () => window.removeEventListener('history-panel:scroll-to-bottom', handler);
  }, [tabId, scrollToBottom]);

  // Scroll to entry when Timeline click sets historyScrollToUuid.
  //
  // Race: Cmd+click on Timeline opens the panel AND sets uuid in the same tick.
  // The panel mounts → loadHistory async → entries=[] for ~200-500ms.
  // Effect runs immediately with entries=[] → must NOT drop the uuid (otherwise
  // the click is lost forever). Only clear uuid once we've actually scrolled.
  //
  // Target lookup uses the entry index (we have entries[] here) — Virtuoso's
  // scrollToIndex handles the off-screen case; DOM querySelector wouldn't
  // find a virtualized item that isn't mounted yet.
  const [flashUuid, setFlashUuid] = useState<string | null>(null);

  useEffect(() => {
    if (!historyScrollToUuid) return;
    if (loading || entries.length === 0) return; // wait for entries; uuid stays in store
    let cancelled = false;
    const targetUuid = historyScrollToUuid;
    const idx = entries.findIndex((e) => e.uuid === targetUuid);
    if (idx < 0) {
      // entry doesn't exist in this session — clear uuid so we don't loop
      setHistoryScrollToUuid(null);
      window.dispatchEvent(
        new CustomEvent('history-panel:scrolled-to', { detail: { tabId, uuid: targetUuid, found: false } }),
      );
      return;
    }
    const handle = virtuosoRef.current;
    if (handle) {
      handle.scrollToIndex({ index: idx, align: 'center', behavior: 'auto' });
    }
    // Flash + emit done-event after layout settles
    const t = setTimeout(() => {
      if (cancelled) return;
      setFlashUuid(targetUuid);
      window.dispatchEvent(
        new CustomEvent('history-panel:scrolled-to', { detail: { tabId, uuid: targetUuid, found: true } }),
      );
      setTimeout(() => { if (!cancelled) setFlashUuid(null); }, 500);
    }, 120);
    setHistoryScrollToUuid(null);
    return () => { cancelled = true; clearTimeout(t); };
  }, [historyScrollToUuid, loading, entries, tabId, setHistoryScrollToUuid]);

  // Native scroll handler — runs on the Virtuoso scroller element via a
  // direct addEventListener (Virtuoso doesn't pass an onScroll prop through
  // to the scroller). Computes scroll direction, at-bottom flag, debounced
  // position save; the at-bottom signal is also reported by Virtuoso via
  // `atBottomStateChange`, but we keep the scrollTop-derived signal because
  // it updates synchronously on every wheel tick (needed for the FAB toggle).
  const lastScrollTopRef = useRef(0);
  const scrollDirectionRef = useRef<'down' | 'up'>('down');
  const handleScroll = useCallback(() => {
    const el = virtuosoScrollerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    isAtBottomRef.current = distFromBottom < 150;
    if (scrollArrowRef.current) {
      scrollArrowRef.current.style.display = distFromBottom > 150 ? '' : 'none';
    }
    scrollDirectionRef.current = el.scrollTop >= lastScrollTopRef.current ? 'down' : 'up';
    lastScrollTopRef.current = el.scrollTop;
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

  // Track visible entries for Timeline viewport indicator (UUID-based, no text search).
  //
  // Prev impl used IntersectionObserver on `[data-uuid]` children of scrollRef.
  // With Virtuoso, off-screen children are unmounted — IntersectionObserver
  // would see only the small mounted window and the inferred "visible" set
  // would be inflated. Instead Virtuoso reports `rangeChanged({startIndex,
  // endIndex})` on every scroll/resize; we recompute the visible UUID set
  // from that index range directly. Cheaper than IO, exact.
  const recomputeVisibleUuids = useCallback(() => {
    const all = entriesRef.current;
    if (all.length === 0) {
      setHistoryVisibleUuids(tabId, []);
      return;
    }
    const { start, end } = visibleRangeRef.current;
    const clampedStart = Math.max(0, Math.min(start, all.length - 1));
    const clampedEnd = Math.max(clampedStart, Math.min(end, all.length - 1));
    const visibleSet = new Set<string>();
    for (let i = clampedStart; i <= clampedEnd; i++) {
      const e = all[i];
      if (e?.uuid) visibleSet.add(e.uuid);
    }
    const resolvedSet = new Set<string>();
    for (const uuid of visibleSet) {
      resolvedSet.add(uuid);
      const parentUser = assistantToUserMap.get(uuid);
      if (parentUser) resolvedSet.add(parentUser);
    }
    // Single-turn highlight: if multiple user entries are directly visible,
    // keep only one based on scroll direction (matches the IO impl).
    const directlyVisibleUsers: string[] = [];
    for (const e of all) {
      if (e.role === 'user' && visibleSet.has(e.uuid)) directlyVisibleUsers.push(e.uuid);
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
  }, [tabId, setHistoryVisibleUuids, assistantToUserMap]);

  // Reset prev key + cleanup on session change
  useEffect(() => {
    prevVisibleUuidsRef.current = '';
    return () => {
      setHistoryVisibleUuids(tabId, []);
    };
  }, [tabId, setHistoryVisibleUuids]);

  // Recompute when entries change (incremental refresh adds rows → bottom range may shift)
  useEffect(() => {
    lengthRef.current = entries.length;
    recomputeVisibleUuids();
  }, [entries, recomputeVisibleUuids]);

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
        <Tooltip content="Search (Cmd+F)">
        <button
          onClick={openSearch}
          style={{
            background: 'none', border: 'none', color: searchOpen ? '#e0e0e0' : '#666',
            cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = searchOpen ? '#e0e0e0' : '#666'; }}
        >
          <Search size={13} />
        </button>
        </Tooltip>
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
            <Tooltip content="Previous (Shift+Enter)">
            <button onClick={goPrevMatch} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', padding: 1, display: 'flex' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#888'; }}
            ><ArrowUp size={14} /></button>
            </Tooltip>
            <Tooltip content="Next (Enter)">
            <button onClick={goNextMatch} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', padding: 1, display: 'flex' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#888'; }}
            ><ArrowDown size={14} /></button>
            </Tooltip>
            <span style={{ fontSize: 11, color: '#666', flexShrink: 0, minWidth: 35, textAlign: 'right' }}>
              {matchPositions.length > 0 ? `${currentMatchIdx + 1}/${matchPositions.length}` : searchQuery.length >= 2 ? '0' : ''}
            </span>
            <Tooltip content="Close search (Esc)">
            <button onClick={closeSearch} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', padding: 1, display: 'flex', flexShrink: 0 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#666'; }}
            ><X size={13} /></button>
            </Tooltip>
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
          <Virtuoso
            ref={virtuosoRef}
            data={entries}
            // Stable row key from JSONL uuid — DOM nodes survive incremental
            // refreshes that re-emit the same entry with a new array reference,
            // and Cmd+F highlight Ranges don't tear when an entry scrolls back
            // into view.
            computeItemKey={(_idx, item) => item.uuid}
            // Mount the scroller against our handleScroll so the per-scroll
            // FAB toggle / position-save stays identical to pre-virtuoso behavior.
            scrollerRef={(el) => {
              const prev = virtuosoScrollerRef.current;
              if (prev && prev !== el) prev.removeEventListener('scroll', handleScroll);
              virtuosoScrollerRef.current = el as HTMLElement | null;
              if (el) (el as HTMLElement).addEventListener('scroll', handleScroll, { passive: true });
            }}
            rangeChanged={(range) => {
              visibleRangeRef.current = { start: range.startIndex, end: range.endIndex };
              recomputeVisibleUuids();
            }}
            // Pre-render a vertical buffer on either side so flash highlights
            // and Cmd+F treeWalker include the immediate neighborhood (Virtuoso
            // would otherwise unmount items just past the viewport).
            increaseViewportBy={{ top: 600, bottom: 600 }}
            // Start at the tail by default — matches the prior behavior where
            // long sessions opened at the most-recent message.
            initialTopMostItemIndex={entries.length > 0 ? entries.length - 1 : 0}
            followOutput={() => (isAtBottomRef.current ? 'auto' : false)}
            style={{ height: '100%' }}
            itemContent={(_idx, entry) => {
              // Red tint for the chain-break zone: every entry at or before
              // the boundary uuid is unreachable by Claude's own backtrace
              // (live Claude would truncate to entries AFTER the boundary on
              // next resume). Independent of compact — orphans appear with
              // or without compact (rebuild / Stop / Esc / SSE crash).
              const isChainBreakZone =
                claudeMemoryBoundaryIndex >= 0 && _idx <= claudeMemoryBoundaryIndex;
              return (
                <div
                  data-uuid={entry.uuid}
                  style={{
                    paddingTop: 4,
                    paddingBottom: 4,
                    backgroundColor: isChainBreakZone ? 'rgba(239, 68, 68, 0.06)' : undefined,
                    ...(flashUuid === entry.uuid ? { animation: 'hp-flash 500ms ease-in-out' } : undefined),
                  }}
                >
                  <HistoryEntry entry={entry} toolType={toolType} />
                </div>
              );
            }}
          />
        )}
        {/* Scroll-to-bottom arrow — visibility toggled via ref in handleScroll */}
        <Tooltip content="Scroll to bottom">
        <div
          ref={scrollArrowRef}
          className="flex items-center justify-center"
          onClick={() => scrollToBottom(false)}
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
        >
          <ChevronDown size={16} color="#a78bfa" strokeWidth={2.5} />
        </div>
        </Tooltip>
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
