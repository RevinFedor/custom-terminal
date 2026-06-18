import React, { useEffect, useState, useRef, useCallback, useMemo, memo, startTransition } from 'react';
import { X, ChevronDown, ChevronRight, Search, ArrowUp, ArrowDown, Send, Square, RotateCcw, Power, AlertTriangle } from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { HISTORY_PANEL_DEFAULT_WIDTH, useUIStore } from '../../store/useUIStore';
import Tooltip from '../UI/Tooltip';
import {
  getHistoryAgentRuntime,
  type AgentDraftGrabResult,
  type AgentHistoryTool,
  type AgentPendingQuestion,
  type AgentPtyStatus,
  type AgentQuestion,
} from '../../utils/historyAgentRuntimes';
// Shared conversation blocks — same renderer as the SDK tab. The JSONL history
// window now draws tool-calls / diff / thinking / markdown through this package
// so its style matches the rest of the app. Subagents (Task) are intentionally
// left on the legacy SubAgentBlock path ("субагентов пока не трогаем").
import { ToolCallPart as CBToolCallPart, ThinkBlock as CBThinkBlock, Markdown as CBMarkdown } from '@noted/claude-blocks';

const { ipcRenderer } = window.require('electron');

let historyRendererLogSeq = 0;
const historyRendererBoot = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
const historyDiag = (msg: string) => {
  const line = '[HistoryHandoff] ' + msg;
  console.warn(line);
  try {
    ipcRenderer.send('log:renderer', {
      msg: line,
      seq: ++historyRendererLogSeq,
      boot: historyRendererBoot,
      emitAbs: performance.timeOrigin + performance.now(),
      emitIso: new Date().toISOString(),
    });
  } catch {
    // best-effort diagnostics only
  }
};

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
// Raw tool carrier emitted by the main-process parser for every non-Task
// tool_use — full name+input+result, rendered via the package ToolCallPart.
interface RawAction {
  tool: '__raw__';
  rawTool: { toolName: string; args: Record<string, any>; result?: string; isError?: boolean };
}
type Action = string | FileAction | TaskAction | RawAction;

const isRawAction = (a: Action): a is RawAction =>
  typeof a === 'object' && a !== null && 'tool' in a && (a as any).tool === '__raw__';
const isFileAction = (a: Action): a is FileAction =>
  typeof a === 'object' && a !== null && 'tool' in a && (a as any).tool !== 'Task' && (a as any).tool !== '__raw__';
const isTaskAction = (a: Action): a is TaskAction =>
  typeof a === 'object' && a !== null && 'tool' in a && (a as any).tool === 'Task';

interface FullHistoryEntry {
  uuid: string;
  role: 'user' | 'assistant' | 'compact' | 'fork' | 'plan-mode' | 'continued' | 'queued' | 'rewind';
  timestamp: string;
  content: string;
  queueStatus?: 'sending' | 'queued' | 'sent' | 'cancelled' | 'failed';
  handoffId?: string;
  statusReason?: string;
  statusChangedAt?: number;
  rewindStatus?: 'rewinding' | 'done' | 'failed';
  optimisticAt?: number;
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
  toolType?: 'claude' | 'gemini' | 'codex';
  enableClaudePtyControls?: boolean;
  embedded?: boolean;
}

interface RewindPreviewState {
  opId: string;
  targetUuid: string;
  targetText: string;
  startedAt: number;
}

interface PromptHandoffMeta {
  text: string;
  submittedAt: number;
}

interface SuppressedPrompt {
  handoffId: string;
  text: string;
  since: number;
  until: number;
  expiresAt: number;
  reason: string;
}

const LOCAL_PROMPT_PREFIX = 'local-prompt-';
const LOCAL_REWIND_PREFIX = 'local-rewind-';
const LOCAL_PROMPT_FAILURE_TTL_MS = 15000;
const LOCAL_PROMPT_SENT_TTL_MS = 12000;
const REWIND_BUSY_GUARD_RE = /\bis busy; wait for the current turn before rewind\b/i;

const normalizeHistoryPromptText = (text: string) => String(text || '')
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/\[200~/g, '').replace(/~\]/g, '').trim();

const promptPreview = (text: string, max = 80) =>
  normalizeHistoryPromptText(text).replace(/\s+/g, ' ').slice(0, max);

const createPromptHandoffId = () =>
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

const isRewindBusyGuardMessage = (message: string) =>
  REWIND_BUSY_GUARD_RE.test(message);

const entryMatchesSuppressedPrompt = (entry: FullHistoryEntry, suppressed: SuppressedPrompt) => {
  if (isLocalPromptEntry(entry)) return false;
  if (entry.role !== 'user' && entry.role !== 'queued') return false;
  if (normalizeHistoryPromptText(entry.content) !== suppressed.text) return false;
  const entryAt = Date.parse(entry.timestamp || '');
  return !Number.isFinite(entryAt) || (entryAt >= suppressed.since && entryAt <= suppressed.until);
};

const filterSuppressedPromptEntries = (
  entries: FullHistoryEntry[],
  suppressions: Iterable<SuppressedPrompt>,
) => {
  const active = Array.from(suppressions);
  if (active.length === 0) return { entries, hidden: 0 };
  const filtered = entries.filter((entry) =>
    !active.some((suppressed) => entryMatchesSuppressedPrompt(entry, suppressed))
  );
  return { entries: filtered, hidden: entries.length - filtered.length };
};

const isLocalPromptEntry = (entry: FullHistoryEntry) =>
  entry.role === 'queued' && entry.uuid.startsWith(LOCAL_PROMPT_PREFIX);

const isLocalRewindEntry = (entry: FullHistoryEntry) =>
  entry.role === 'rewind' && entry.uuid.startsWith(LOCAL_REWIND_PREFIX);

const serverHasPromptEntry = (serverEntries: FullHistoryEntry[], localEntry: FullHistoryEntry) => {
  const normalized = normalizeHistoryPromptText(localEntry.content);
  const localAt = localEntry.optimisticAt || Date.parse(localEntry.timestamp) || Date.now();
  return serverEntries.some((entry) => {
    if (entry.role !== 'user' && entry.role !== 'queued') return false;
    if (normalizeHistoryPromptText(entry.content) !== normalized) return false;
    const entryAt = Date.parse(entry.timestamp || '');
    return !Number.isFinite(entryAt) || entryAt >= localAt - 5000;
  });
};

const mergeServerAndLocalEntries = (serverEntries: FullHistoryEntry[], currentEntries: FullHistoryEntry[]) => {
  const now = Date.now();
  const locals = currentEntries.filter((entry) =>
    (isLocalPromptEntry(entry) &&
      !serverHasPromptEntry(serverEntries, entry) &&
      (() => {
        const ageMs = now - (entry.statusChangedAt || entry.optimisticAt || Date.parse(entry.timestamp || '') || now);
        if (entry.queueStatus === 'cancelled' || entry.queueStatus === 'failed') {
          return ageMs < LOCAL_PROMPT_FAILURE_TTL_MS;
        }
        if (entry.queueStatus === 'sent') {
          return ageMs < LOCAL_PROMPT_SENT_TTL_MS;
        }
        return true;
      })()) ||
    isLocalRewindEntry(entry)
  );
  return locals.length > 0 ? [...serverEntries, ...locals] : serverEntries;
};

const entryClockMs = (entry: FullHistoryEntry) => {
  if (entry.optimisticAt && Number.isFinite(entry.optimisticAt)) return entry.optimisticAt;
  const parsed = Date.parse(entry.timestamp || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const shouldCarryAfterRewindTarget = (entry: FullHistoryEntry, preview: RewindPreviewState) => {
  if (isLocalRewindEntry(entry) && entry.uuid.includes(preview.opId)) return true;
  if (isLocalPromptEntry(entry)) return true;
  return entryClockMs(entry) >= preview.startedAt - 1000;
};

const buildRewindPreviewEntries = (rawEntries: FullHistoryEntry[], preview: RewindPreviewState | null) => {
  if (!preview) return { entries: rawEntries, hiddenCount: 0 };
  const targetIndex = rawEntries.findIndex((entry) => entry.uuid === preview.targetUuid);
  if (targetIndex < 0) return { entries: rawEntries, hiddenCount: 0 };

  // Native rewind moves the selected user prompt into the History input and
  // clears Claude's terminal composer. Until that draft is submitted again,
  // the target user row is not part of the previewed active history; the local
  // rewind marker represents it.
  const entries = rawEntries.slice(0, targetIndex);
  let hiddenCount = 1;
  for (let i = targetIndex + 1; i < rawEntries.length; i++) {
    const entry = rawEntries[i];
    if (shouldCarryAfterRewindTarget(entry, preview)) entries.push(entry);
    else hiddenCount++;
  }
  return { entries, hiddenCount };
};

const serverHistoryMaterializedRewindBranch = (serverEntries: FullHistoryEntry[], preview: RewindPreviewState) => {
  const targetIndex = serverEntries.findIndex((entry) => entry.uuid === preview.targetUuid);
  if (targetIndex < 0) return false;
  const afterTarget = serverEntries.slice(targetIndex + 1);
  const hasOldFuture = afterTarget.some((entry) => entryClockMs(entry) < preview.startedAt - 1000);
  const hasNewUser = afterTarget.some((entry) => entry.role === 'user' && entryClockMs(entry) >= preview.startedAt - 1000);
  return hasNewUser && !hasOldFuture;
};

// Thinking + markdown now render via @noted/claude-blocks (CBThinkBlock /
// CBMarkdown) — the local ThinkingBlock and the MarkdownRenderer import were
// removed. SubAgentBlock (Task) keeps its own inline rendering below.

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
  const [hovered, setHovered] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  const hasSummary = !!entry.compactSummary;
  const visible = open || (hovered && altHeld);
  const tokensLabel = entry.preTokens ? `${Math.round(entry.preTokens / 1000)}k tokens` : null;

  useEffect(() => {
    if (!hasSummary) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(false);
    };
    const onBlur = () => setAltHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [hasSummary]);

  return (
    <div style={{ padding: '4px 0' }}>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 6, cursor: hasSummary ? 'pointer' : 'default',
        }}
        onClick={hasSummary ? () => setOpen(!open) : undefined}
      >
        <div style={{ flex: 1, height: 1, backgroundColor: '#f59e0b', opacity: 0.3 }} />
        {hasSummary && (
          visible ? <ChevronDown size={10} style={{ color: '#f59e0b', flexShrink: 0 }} />
                  : <ChevronRight size={10} style={{ color: '#f59e0b', flexShrink: 0 }} />
        )}
        <span style={{ color: '#f59e0b', fontSize: 11, letterSpacing: 1, flexShrink: 0, opacity: 0.8 }}>
          COMPACTED{tokensLabel ? ` (${tokensLabel})` : ''}
        </span>
        <div style={{ flex: 1, height: 1, backgroundColor: '#f59e0b', opacity: 0.3 }} />
      </div>
      {visible && entry.compactSummary && (
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
const HistoryEntry = memo(({ entry, toolType }: { entry: FullHistoryEntry; toolType?: 'claude' | 'gemini' | 'codex' }) => {
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

  if (entry.role === 'queued') {
    const status = entry.queueStatus || 'queued';
    const sending = status === 'sending';
    const queued = status === 'queued';
    const sent = status === 'sent';
    const cancelled = status === 'cancelled';
    const failed = status === 'failed';
    const label = sending ? 'SENDING' : queued ? 'QUEUED' : sent ? 'SENT' : cancelled ? 'CANCELLED BEFORE JSONL' : 'SEND FAILED';
    const accent = failed ? '#ef4444' : '#71717a';
    const textColor = failed ? '#fca5a5' : '#a1a1aa';
    return (
      <div style={{
        padding: '8px 12px',
        backgroundColor: failed ? 'rgba(239, 68, 68, 0.08)' : 'rgba(113, 113, 122, 0.08)',
        borderRadius: 6,
        borderLeft: '3px solid ' + accent,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          color: textColor,
          marginBottom: 4,
          fontWeight: 700,
          letterSpacing: 0.6,
        }}>
          {(sending || queued || sent) && <HistorySpinner size={10} />}
          <span>{label}</span>
          {entry.timestamp && (
            <span style={{ marginLeft: 2, color: '#666', fontWeight: 500, letterSpacing: 0 }}>
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

  if (entry.role === 'rewind') {
    const status = entry.rewindStatus || 'rewinding';
    const active = status === 'rewinding';
    const failed = status === 'failed';
    const label = failed ? 'REWIND FAILED' : active ? 'REWINDING' : 'I REWOUND';
    return (
      <div style={{
        padding: '8px 12px',
        backgroundColor: failed ? 'rgba(239, 68, 68, 0.08)' : 'rgba(217, 119, 6, 0.08)',
        borderRadius: 6,
        borderLeft: '3px solid ' + (failed ? 'rgba(239, 68, 68, 0.75)' : 'rgba(217, 119, 6, 0.75)'),
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          color: failed ? '#fca5a5' : '#fbbf24',
          marginBottom: 4,
          fontWeight: 700,
          letterSpacing: 0.6,
        }}>
          {active && <HistorySpinner size={10} />}
          <span>{label}</span>
          {entry.timestamp && (
            <span style={{ marginLeft: 2, color: '#666', fontWeight: 500, letterSpacing: 0 }}>
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
        {toolType === 'gemini' ? 'GEMINI' : toolType === 'codex' ? 'CODEX' : 'CLAUDE'}
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

      {entry.thinking && <CBThinkBlock text={entry.thinking} />}

      {entry.content && (
        <div style={{ fontSize: 13 }}>
          <CBMarkdown text={entry.content} />
        </div>
      )}

      {entry.actions && entry.actions.length > 0 && (() => {
        // Render actions IN ORDER (a turn interleaves Bash → Edit → Task). Raw
        // tool actions go through the package card; Task keeps SubAgentBlock;
        // legacy string/FileAction shapes (e.g. Gemini, or older cached data)
        // fall back to the old inline renderers so nothing regresses.
        return (
          <>
            {entry.actions!.map((a, i) => {
              if (isRawAction(a)) {
                const toolName = String(a.rawTool.toolName || '');
                const toolResult = a.rawTool.result;
                const historyResult = toolResult == null && toolName.toLowerCase().includes('mcp')
                  ? ''
                  : toolResult;
                return (
                  <CBToolCallPart
                    key={'raw' + i}
                    toolName={toolName}
                    args={a.rawTool.args || {}}
                    result={historyResult}
                    isError={a.rawTool.isError}
                  />
                );
              }
              if (isTaskAction(a)) return <SubAgentBlock key={'task' + i} action={a} />;
              if (isFileAction(a)) {
                return a.tool === 'Read'
                  ? <ReadActionBlock key={'rd' + i} filePath={a.filePath} />
                  : <FileActionBlock key={'ew' + i} action={a} />;
              }
              // string fallback (Gemini / legacy)
              return (
                <div key={'s' + i} style={{ marginTop: 6 }}>
                  <span style={{
                    fontSize: 11, color: '#999',
                    backgroundColor: 'rgba(255,255,255,0.04)',
                    padding: '2px 6px', borderRadius: 4, wordBreak: 'break-all',
                  }}>
                    {a as string}
                  </span>
                </div>
              );
            })}
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
}
.hp-agent-prompt::placeholder {
  color: #666;
  opacity: 1;
}
.hp-agent-prompt[data-status="inactive"]::placeholder,
.hp-agent-prompt[data-status="starting"]::placeholder {
  color: #555;
}`;
  document.head.appendChild(style);
}

const AGENT_STATUS_META: Record<AgentPtyStatus, { label: string; color: string }> = {
  active: { label: 'READY', color: '#4ade80' },
  busy: { label: 'BUSY', color: '#d97706' },
  inactive: { label: 'STOPPED', color: '#777' },
  starting: { label: 'STARTING', color: '#60a5fa' },
};

const historyControlButtonBase: React.CSSProperties = {
  height: 26,
  borderRadius: 5,
  border: '1px solid #343434',
  backgroundColor: '#242424',
  color: '#cfcfcf',
  padding: '0 8px',
  fontSize: 11,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
};

const QUESTION_PURPLE = '#a78bfa';
const QUESTION_PURPLE_BG = 'rgba(147, 51, 234, 0.18)';
const QUESTION_PURPLE_BORDER = 'rgba(168, 85, 247, 0.9)';

const DRAFT_GRAB_ERROR_MESSAGES: Record<string, string> = {
  no_terminal: 'No terminal for this tab',
  no_claude_session: 'No Claude session running in this tab',
  no_claude_pid: 'No Claude process found in this tab',
  claude_busy: 'Claude is busy - wait for the response to finish',
  already_in_progress: 'Draft grab already in progress',
  wrong_editor: 'Restart Claude in this tab - editor helper is not wired',
  stale_pid: 'Claude was restarted in shell - close and reopen this tab',
  editor_not_wired: 'Helper never reported back',
  tab_cleared: 'Tab was closed before grab finished',
  timeout: 'Draft grab timed out',
};

const draftGrabErrorText = (result: AgentDraftGrabResult | null | undefined) => {
  const code = result?.error || 'unknown';
  return DRAFT_GRAB_ERROR_MESSAGES[code] || ('Draft grab failed: ' + code);
};

const prependPromptText = (base: string, addition: string) => {
  const left = addition.trim();
  const right = base.trimStart();
  if (!left) return right;
  if (!right) return left;
  return left + '\n\n' + right;
};

const prependPromptTextOnce = (base: string, addition: string) => {
  const left = addition.trim();
  const right = base.trim();
  if (!left) return base;
  if (
    right === left ||
    right.startsWith(left + '\n\n') ||
    right.endsWith('\n\n' + left) ||
    right.includes('\n\n' + left + '\n\n')
  ) {
    return base;
  }
  return prependPromptText(base, left);
};

function HistorySpinner({ size = 14, flexShrink = 0 }: { size?: number; flexShrink?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{
        animation: 'spinner-rotate 0.85s linear infinite',
        transformOrigin: '50% 50%',
        willChange: 'transform',
        flexShrink,
        display: 'block',
      }}
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
    </svg>
  );
}

const getDraftNoticeMeta = (message: string) => {
  if (/terminal input is empty/i.test(message)) {
    return {
      label: 'Terminal input empty',
      tone: 'info' as const,
    };
  }
  if (/prompt was not returned/i.test(message)) {
    return {
      label: 'Cancel confirmed',
      tone: 'info' as const,
    };
  }
  if (/interrupted prompt/i.test(message)) {
    return {
      label: 'Prompt restored',
      tone: 'warning' as const,
    };
  }
  if (/image placeholder/i.test(message)) {
    return {
      label: 'Draft moved · images',
      tone: 'warning' as const,
    };
  }
  return {
    label: 'Send stopped · draft moved',
    tone: 'warning' as const,
  };
};

function HistoryThinkingChip({ label, text = 'THINKING' }: { label: string; text?: string }) {
  const tooltip =
    text === 'UPDATING' ? label + ' history is updating'
    : text === 'REWINDING' ? label + ' rewind is running'
    : label + ' turn is running';
  const tone =
    text === 'REWINDING'
      ? {
          border: 'rgba(168, 85, 247, 0.42)',
          bg: 'rgba(168, 85, 247, 0.14)',
          text: '#c4b5fd',
          dot: '#a78bfa',
          dotClass: 'animate-glow-purple',
        }
      : {
          border: 'rgba(217, 119, 6, 0.38)',
          bg: 'rgba(217, 119, 6, 0.12)',
          text: '#fbbf24',
          dot: '#d97706',
          dotClass: 'animate-glow-yellow',
        };
  return (
    <Tooltip content={tooltip}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          height: 22,
          padding: '0 8px',
          borderRadius: 5,
          border: '1px solid ' + tone.border,
          backgroundColor: tone.bg,
          color: tone.text,
          fontSize: 10,
          fontWeight: 750,
          letterSpacing: 0,
          flexShrink: 0,
        }}
      >
        <span
          className={tone.dotClass}
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            backgroundColor: tone.dot,
            flexShrink: 0,
          }}
        />
        <span>{text}</span>
      </div>
    </Tooltip>
  );
}

const QUESTION_NAV_KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  enter: '\r',
  space: ' ',
} as const;

type QuestionTerminalCursor = {
  questionIndex: number;
  optionIndex: number;
  submit: boolean;
};

const sleepQuestionNav = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ClaudeHistoryQuestionCard({
  tabId,
  pending,
  answering,
  error,
  onAnswer,
  onStop,
}: {
  tabId: string;
  pending: AgentPendingQuestion;
  answering: boolean;
  error: string | null;
  onAnswer: (answers: Record<string, string>) => void;
  onStop: () => void;
}) {
  const questions = pending.questions || [];
  const terminalDriven = pending.source === 'pty';
  const multiQuestion = questions.length > 1;
  const [selection, setSelection] = useState<Record<number, string[]>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [optionIndex, setOptionIndex] = useState(0);
  const [terminalSubmitReady, setTerminalSubmitReady] = useState(false);
  const [terminalBusyTarget, setTerminalBusyTarget] = useState<string | null>(null);
  const [choiceControlHover, setChoiceControlHover] = useState<string | null>(null);
  const terminalBusyRef = useRef(false);
  const terminalBusyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalCursorRef = useRef<QuestionTerminalCursor>({ questionIndex: 0, optionIndex: 0, submit: false });
  const questionSignature = useMemo(
    () => questions.map((q) => q?.question || '').join('||'),
    [questions],
  );

  useEffect(() => {
    setSelection({});
    setQuestionIndex(0);
    setOptionIndex(0);
    setTerminalSubmitReady(false);
    setTerminalBusyTarget(null);
    setChoiceControlHover(null);
    terminalBusyRef.current = false;
    terminalCursorRef.current = { questionIndex: 0, optionIndex: 0, submit: false };
    if (terminalBusyTimerRef.current) {
      clearTimeout(terminalBusyTimerRef.current);
      terminalBusyTimerRef.current = null;
    }
  }, [pending.source, pending.toolUseID, questionSignature]);

  useEffect(() => {
    return () => {
      if (terminalBusyTimerRef.current) clearTimeout(terminalBusyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (questionIndex >= questions.length && questions.length > 0) setQuestionIndex(questions.length - 1);
  }, [questionIndex, questions.length]);

  const currentQuestion: AgentQuestion | null = questions.length > 0
    ? questions[Math.min(questionIndex, questions.length - 1)]
    : null;
  const currentOptions = currentQuestion?.options || [];
  const currentSelection = selection[questionIndex] || [];
  const isMultiSelect = !!currentQuestion?.multiSelect;

  const buildAnswers = useCallback((snapshot: Record<number, string[]>) => {
    const out: Record<string, string> = {};
    questions.forEach((q, i) => {
      const selected = snapshot[i];
      if (q?.question && selected && selected.length) out[q.question] = selected.join(', ');
    });
    return out;
  }, [questions]);

  const allAnswered = questions.length > 0 && questions.every((_q, i) => (selection[i]?.length || 0) > 0);
  const controlsBusy = answering || !!terminalBusyTarget;

  const writeTerminalKey = useCallback(async (seq: string, gap = 72) => {
    ipcRenderer.send('terminal:input', tabId, seq);
    await sleepQuestionNav(gap);
  }, [tabId]);

  const clearTerminalBusyLater = useCallback((target: string, delayMs = 140) => {
    if (terminalBusyTimerRef.current) clearTimeout(terminalBusyTimerRef.current);
    terminalBusyTimerRef.current = setTimeout(() => {
      terminalBusyTimerRef.current = null;
      terminalBusyRef.current = false;
      setTerminalBusyTarget((current) => current === target ? null : current);
    }, delayMs);
  }, []);

  const runTerminalQuestionAction = useCallback(async (
    target: string,
    action: () => Promise<void>,
    settleMs = 140,
  ) => {
    if (!terminalDriven || terminalBusyRef.current || answering) return;
    terminalBusyRef.current = true;
    if (terminalBusyTimerRef.current) {
      clearTimeout(terminalBusyTimerRef.current);
      terminalBusyTimerRef.current = null;
    }
    setTerminalBusyTarget(target);
    try {
      await action();
    } catch (e: any) {
      console.warn('[ClaudeHistoryQuestion] terminal-nav failed tab=' + tabId.slice(-12) + ': ' + String(e?.message || e));
    } finally {
      clearTerminalBusyLater(target, settleMs);
    }
  }, [answering, clearTerminalBusyLater, tabId, terminalDriven]);

  const navigateTerminalTo = useCallback(async (
    targetQuestionIndex: number,
    targetOptionIndex = 0,
    targetSubmit = false,
  ) => {
    const lastQuestionIndex = Math.max(0, questions.length - 1);
    const clampedQuestion = Math.max(0, Math.min(targetQuestionIndex, lastQuestionIndex));
    const clampedOption = Math.max(0, targetOptionIndex);
    const current = terminalCursorRef.current;
    const currentTab = current.submit ? questions.length : current.questionIndex;
    const targetTab = targetSubmit ? questions.length : clampedQuestion;
    const tabDelta = targetTab - currentTab;

    for (let i = 0; i < Math.abs(tabDelta); i++) {
      await writeTerminalKey(tabDelta > 0 ? QUESTION_NAV_KEY.right : QUESTION_NAV_KEY.left, 82);
    }

    if (targetSubmit) {
      terminalCursorRef.current = { questionIndex: lastQuestionIndex, optionIndex: 0, submit: true };
      return;
    }

    const optionBase = tabDelta === 0 && !current.submit ? current.optionIndex : 0;
    const optionDelta = clampedOption - optionBase;
    for (let i = 0; i < Math.abs(optionDelta); i++) {
      await writeTerminalKey(optionDelta > 0 ? QUESTION_NAV_KEY.down : QUESTION_NAV_KEY.up, 72);
    }
    terminalCursorRef.current = { questionIndex: clampedQuestion, optionIndex: clampedOption, submit: false };
  }, [questions.length, writeTerminalKey]);

  const focusQuestion = useCallback((index: number) => {
    const nextIndex = Math.max(0, Math.min(index, Math.max(0, questions.length - 1)));
    if (!terminalDriven) {
      setQuestionIndex(nextIndex);
      setOptionIndex(0);
      return;
    }
    runTerminalQuestionAction('question:' + nextIndex, async () => {
      await navigateTerminalTo(nextIndex, 0, false);
      setQuestionIndex(nextIndex);
      setOptionIndex(0);
      setTerminalSubmitReady(false);
    });
  }, [navigateTerminalTo, questions.length, runTerminalQuestionAction, terminalDriven]);

  const focusOption = useCallback((index: number) => {
    if (controlsBusy || !currentQuestion) return;
    const maxIndex = Math.max(0, (currentQuestion.options || []).length - 1);
    const nextIndex = Math.max(0, Math.min(index, maxIndex));
    if (!terminalDriven) {
      setOptionIndex(nextIndex);
      return;
    }
    const target = 'option-focus:' + questionIndex + ':' + nextIndex;
    runTerminalQuestionAction(target, async () => {
      await navigateTerminalTo(questionIndex, nextIndex, false);
      setOptionIndex(nextIndex);
      setTerminalSubmitReady(false);
    }, 110);
  }, [controlsBusy, currentQuestion, navigateTerminalTo, questionIndex, runTerminalQuestionAction, terminalDriven]);

  const commitOption = useCallback((label: string, index: number) => {
    if (controlsBusy || !currentQuestion) return;
    setOptionIndex(index);
    if (terminalDriven) {
      const target = 'option:' + questionIndex + ':' + index;
      runTerminalQuestionAction(target, async () => {
        await navigateTerminalTo(questionIndex, index, false);
        setOptionIndex(index);
        if (isMultiSelect) {
          await writeTerminalKey(QUESTION_NAV_KEY.space, 90);
          setSelection((prev) => {
            const current = prev[questionIndex] || [];
            const next = current.includes(label)
              ? current.filter((item) => item !== label)
              : [...current, label];
            return { ...prev, [questionIndex]: next };
          });
          setTerminalSubmitReady(false);
          return;
        }

        const nextSelection = { ...selection, [questionIndex]: [label] };
        setSelection(nextSelection);
        await writeTerminalKey(QUESTION_NAV_KEY.enter, 115);

        if (multiQuestion) {
          if (questionIndex < questions.length - 1) {
            const nextQuestionIndex = questionIndex + 1;
            terminalCursorRef.current = { questionIndex: nextQuestionIndex, optionIndex: 0, submit: false };
            setQuestionIndex(nextQuestionIndex);
            setOptionIndex(0);
            setTerminalSubmitReady(false);
          } else {
            terminalCursorRef.current = { questionIndex, optionIndex: index, submit: true };
            setTerminalSubmitReady(true);
          }
        }
      }, multiQuestion || isMultiSelect ? 150 : 850);
      return;
    }

    if (isMultiSelect) {
      setSelection((prev) => {
        const current = prev[questionIndex] || [];
        const next = current.includes(label)
          ? current.filter((item) => item !== label)
          : [...current, label];
        return { ...prev, [questionIndex]: next };
      });
      return;
    }

    const nextSelection = { ...selection, [questionIndex]: [label] };
    setSelection(nextSelection);
    if (!multiQuestion) {
      onAnswer(buildAnswers(nextSelection));
    } else if (questionIndex < questions.length - 1) {
      setQuestionIndex(questionIndex + 1);
      setOptionIndex(0);
    }
  }, [
    buildAnswers,
    controlsBusy,
    currentQuestion,
    isMultiSelect,
    multiQuestion,
    navigateTerminalTo,
    onAnswer,
    questionIndex,
    questions.length,
    runTerminalQuestionAction,
    selection,
    terminalDriven,
    writeTerminalKey,
  ]);

  const submit = useCallback(() => {
    if (controlsBusy || !allAnswered) return;
    if (terminalDriven) {
      runTerminalQuestionAction('submit', async () => {
        await navigateTerminalTo(Math.max(0, questions.length - 1), 0, true);
        await writeTerminalKey(QUESTION_NAV_KEY.enter, 110);
        setTerminalSubmitReady(false);
      }, 850);
      return;
    }
    onAnswer(buildAnswers(selection));
  }, [
    allAnswered,
    buildAnswers,
    controlsBusy,
    navigateTerminalTo,
    onAnswer,
    questions.length,
    runTerminalQuestionAction,
    selection,
    terminalDriven,
    writeTerminalKey,
  ]);

  const headerLabel = questions.length > 0
    ? (terminalSubmitReady ? 'SUBMIT' : 'QUESTION' + (multiQuestion ? ' ' + (questionIndex + 1) + '/' + questions.length : ''))
    : 'QUESTION';

  return (
    <div
      style={{
        border: '1px solid rgba(168, 85, 247, 0.32)',
        backgroundColor: '#101010',
        borderRadius: 6,
        padding: 10,
        animation: 'noted-fade-in 0.16s ease-out',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, minWidth: 0 }}>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.4,
          color: QUESTION_PURPLE,
          padding: '2px 7px',
          borderRadius: 999,
          backgroundColor: QUESTION_PURPLE_BG,
          border: '1px solid ' + QUESTION_PURPLE_BORDER,
          flexShrink: 0,
        }}>
          {headerLabel}
        </span>
        {currentQuestion?.header && (
          <span style={{ color: '#999', fontSize: 11, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentQuestion.header}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {(answering || terminalBusyTarget) && (
          <span style={{ color: QUESTION_PURPLE, flexShrink: 0 }}>
            <HistorySpinner size={13} />
          </span>
        )}
      </div>

      {multiQuestion && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
          {questions.map((q, i) => {
            const answered = (selection[i]?.length || 0) > 0;
            const active = i === questionIndex;
            const chipBusy = terminalBusyTarget === 'question:' + i;
            return (
              <button
                key={i}
                type="button"
                onClick={() => focusQuestion(i)}
                disabled={controlsBusy}
                style={{
                  borderRadius: 5,
                  border: '1px solid ' + (active ? QUESTION_PURPLE_BORDER : 'transparent'),
                  backgroundColor: active ? QUESTION_PURPLE_BG : 'transparent',
                  color: active ? '#f3e8ff' : '#8f8f96',
                  padding: '3px 7px',
                  fontSize: 10,
                  cursor: controlsBusy ? 'default' : 'pointer',
                  maxWidth: 120,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                title={q.question}
              >
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    height: 12,
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {chipBusy ? (
                    <HistorySpinner size={10} />
                  ) : answered ? (
                    <span style={{
                      width: 9,
                      height: 9,
                      borderRadius: 999,
                      backgroundColor: QUESTION_PURPLE,
                      boxShadow: '0 0 0 2px rgba(168, 85, 247, 0.18)',
                    }} />
                  ) : null}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.header || 'Q' + (i + 1)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {currentQuestion ? (
        <>
          <div style={{ color: '#f4f4f5', fontSize: 13, fontWeight: 600, lineHeight: 1.35, marginBottom: 8, wordBreak: 'break-word' }}>
            {currentQuestion.question}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {currentOptions.map((option, index) => {
              const checked = currentSelection.includes(option.label);
              const focused = index === optionIndex && !terminalSubmitReady;
              const optionBusy = terminalBusyTarget === 'option:' + questionIndex + ':' + index;
              const optionFocusBusy = terminalBusyTarget === 'option-focus:' + questionIndex + ':' + index;
              const controlKey = questionIndex + ':' + index;
              const controlHover = choiceControlHover === controlKey;
              return (
                <div
                  key={option.label + ':' + index}
                  role="button"
                  tabIndex={0}
                  onClick={() => focusOption(index)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    focusOption(index);
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    borderRadius: 5,
                    border: '1px solid ' + (focused ? QUESTION_PURPLE_BORDER : '#303030'),
                    backgroundColor: focused ? 'rgba(168, 85, 247, 0.16)' : '#181818',
                    color: '#e5e5e5',
                    cursor: controlsBusy ? 'default' : 'pointer',
                    padding: '8px 9px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <button
                      type="button"
                      aria-label={(checked ? 'Deselect ' : 'Select ') + option.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        commitOption(option.label, index);
                      }}
                      onMouseEnter={() => setChoiceControlHover(controlKey)}
                      onMouseLeave={() => setChoiceControlHover((current) => current === controlKey ? null : current)}
                      disabled={controlsBusy}
                      style={{
                        width: 24,
                        height: 24,
                        margin: '-5px -2px -5px -3px',
                        padding: 0,
                        border: '1px solid ' + (controlHover && !controlsBusy ? QUESTION_PURPLE_BORDER : 'transparent'),
                        borderRadius: isMultiSelect ? 6 : 999,
                        backgroundColor: controlHover && !controlsBusy ? 'rgba(168, 85, 247, 0.14)' : 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: QUESTION_PURPLE,
                        cursor: controlsBusy ? 'default' : 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      <span style={{
                        width: 10,
                        height: 10,
                        borderRadius: isMultiSelect ? 2 : 999,
                        border: '1px solid ' + (checked ? QUESTION_PURPLE : '#666'),
                        backgroundColor: checked ? QUESTION_PURPLE : 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                        {optionBusy && <HistorySpinner size={10} />}
                      </span>
                    </button>
                    <span style={{
                      width: 12,
                      height: 12,
                      flexShrink: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: QUESTION_PURPLE,
                      marginLeft: -6,
                    }}>
                      {optionFocusBusy && <HistorySpinner size={10} />}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: checked ? 600 : 500, overflowWrap: 'anywhere', minWidth: 0 }}>
                      {option.label}
                    </span>
                  </span>
                  {option.description && (
                    <span style={{ color: '#999', fontSize: 11, lineHeight: 1.35, paddingLeft: 18 }}>
                      {option.description}
                    </span>
                  )}
                  {option.preview && (
                    <pre style={{
                      margin: '3px 0 0 18px',
                      padding: '6px 8px',
                      borderRadius: 4,
                      backgroundColor: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: '#bbb',
                      fontSize: 11,
                      lineHeight: 1.35,
                      maxHeight: 120,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {option.preview}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div style={{ color: '#bbb', fontSize: 12, lineHeight: 1.35 }}>
          Claude asked a question in the terminal. The structured payload is empty, so answer manually.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <button
          type="button"
          onClick={onStop}
          disabled={controlsBusy}
          style={{
            ...historyControlButtonBase,
            height: 28,
            cursor: controlsBusy ? 'default' : 'pointer',
            color: '#aaa',
          }}
        >
          Respond manually
        </button>
        <div style={{ flex: 1 }} />
        {(isMultiSelect || multiQuestion) && (
          <button
            type="button"
            onClick={submit}
            disabled={controlsBusy || !allAnswered}
            style={{
              ...historyControlButtonBase,
              height: 28,
              borderColor: allAnswered && !controlsBusy ? QUESTION_PURPLE_BORDER : '#343434',
              backgroundColor: allAnswered && !controlsBusy ? QUESTION_PURPLE : '#242424',
              color: allAnswered && !controlsBusy ? '#121212' : '#666',
              cursor: allAnswered && !controlsBusy ? 'pointer' : 'default',
              fontWeight: 700,
              gap: 6,
            }}
          >
            {terminalBusyTarget === 'submit' && <HistorySpinner size={12} />}
            Submit{multiQuestion ? ' ' + Object.keys(selection).filter((key) => (selection[Number(key)]?.length || 0) > 0).length + '/' + questions.length : ''}
          </button>
        )}
      </div>
      {error && (
        <div style={{ marginTop: 7, color: '#fca5a5', fontSize: 11, wordBreak: 'break-word' }}>
          {error}
        </div>
      )}
    </div>
  );
}

function AgentHistoryControls({
  tabId,
  sessionId,
  cwd,
  toolType,
  onHistoryRefresh,
  onPromptSubmitted,
  onPromptStatusChange,
  rewindLocked,
}: {
  tabId: string;
  sessionId: string;
  cwd: string;
  toolType: AgentHistoryTool;
  onHistoryRefresh: () => void | Promise<boolean | void>;
  onPromptSubmitted: (
    text: string,
    queueStatus: 'sending' | 'queued' | 'sent',
    meta: { handoffId: string; statusAtSend: AgentPtyStatus; submittedAt: number }
  ) => void;
  onPromptStatusChange: (handoffId: string, queueStatus: 'queued' | 'sent' | 'cancelled' | 'failed', reason: string) => void;
  rewindLocked: boolean;
}) {
  const runtime = useMemo(() => getHistoryAgentRuntime(toolType), [toolType]);
  const [status, setStatus] = useState<AgentPtyStatus>('inactive');
  const prompt = useUIStore(useCallback((s) => s.historyPromptDrafts[tabId] || '', [tabId]));
  const setHistoryPromptDraft = useUIStore((s) => s.setHistoryPromptDraft);
  const setPrompt = useCallback((next: string | ((prev: string) => string)) => {
    const current = useUIStore.getState().historyPromptDrafts[tabId] || '';
    const value = typeof next === 'function' ? next(current) : next;
    setHistoryPromptDraft(tabId, value);
  }, [setHistoryPromptDraft, tabId]);
  const [busyAction, setBusyAction] = useState<'resume' | 'send' | 'interrupt' | 'stop' | 'grab' | null>(null);
  const [isPasteBusy, setIsPasteBusy] = useState(false);
  const [historyUpdating, setHistoryUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftWarning, setDraftWarning] = useState<string | null>(null);
  const [interruptAwaiting, setInterruptAwaiting] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<AgentPendingQuestion | null>(null);
  const [answeringQuestion, setAnsweringQuestion] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const tabIdRef = useRef(tabId);
  const statusRef = useRef<AgentPtyStatus>('inactive');
  const actionInFlightRef = useRef(false);
  const actionSeqRef = useRef(0);
  const historyUpdateSeqRef = useRef(0);
  const pasteBusyRef = useRef(false);
  const pendingQuestionRef = useRef<AgentPendingQuestion | null>(null);
  const answeringQuestionRef = useRef(false);
  const midstreamPromptRecoveryRef = useRef<{ text: string; at: number; handoffId: string; statusAtSend: AgentPtyStatus } | null>(null);
  const interruptRecoveryInFlightRef = useRef(false);
  const interruptAwaitRef = useRef<{ tabId: string; seq: number; at: number } | null>(null);
  const emptyDraftNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearEmptyDraftNoticeTimer = useCallback(() => {
    if (emptyDraftNoticeTimerRef.current) {
      clearTimeout(emptyDraftNoticeTimerRef.current);
      emptyDraftNoticeTimerRef.current = null;
    }
  }, []);

  const showEmptyDraftNotice = useCallback((message: string) => {
    clearEmptyDraftNoticeTimer();
    setDraftWarning(message);
    emptyDraftNoticeTimerRef.current = setTimeout(() => {
      emptyDraftNoticeTimerRef.current = null;
      setDraftWarning((current) => current === message ? null : current);
    }, 1100);
  }, [clearEmptyDraftNoticeTimer]);

  const setStatusFrom = useCallback((next: AgentPtyStatus, reason: string) => {
    const prev = statusRef.current;
    statusRef.current = next;
    if (prev !== next) {
      console.log('[' + runtime.logPrefix + '] status tab=' + tabId.slice(-12) + ' ' + prev + ' -> ' + next + ' reason=' + reason);
    }
    setStatus(next);
  }, [runtime.logPrefix, tabId]);

  const setPendingQuestionFrom = useCallback((next: AgentPendingQuestion | null, reason: string) => {
    pendingQuestionRef.current = next;
    setPendingQuestion(next);
    console.log('[ClaudeHistoryQuestion] pending tab=' + tabId.slice(-12) + ' reason=' + reason + ' source=' + (next?.source || 'none') + ' qs=' + (next?.questions?.length || 0));
  }, [tabId]);

  const isNonAuthoritativeBusyEvent = useCallback((data: { reason?: string }) => {
    return runtime.toolType === 'claude' && data.reason === 'spinner';
  }, [runtime.toolType]);

  const refreshPendingQuestion = useCallback(async (reason: string) => {
    if (!tabId || !runtime.getPendingQuestion) return null;
    const requestTabId = tabId;
    try {
      const pending = await runtime.getPendingQuestion(tabId);
      if (tabIdRef.current !== requestTabId) return null;
      setPendingQuestionFrom(pending, reason);
      if (pending && (pending.questions?.length || 0) === 0) {
        console.warn('[ClaudeHistoryQuestion] empty-payload tab=' + tabId.slice(-12) + ' reason=' + reason);
      }
      return pending;
    } catch (e: any) {
      if (tabIdRef.current !== requestTabId) return null;
      const message = String(e?.message || e);
      console.warn('[ClaudeHistoryQuestion] pending refresh failed tab=' + tabId.slice(-12) + ': ' + message);
      setQuestionError(message);
      return null;
    }
  }, [runtime, setPendingQuestionFrom, tabId]);

  const refreshPresence = useCallback(async () => {
    if (!tabId) return;
    const requestTabId = tabId;
    try {
      const presence = await runtime.getPresence(tabId);
      if (tabIdRef.current !== requestTabId) return;
      setStatusFrom(presence.status, 'presence');
      if (presence.awaiting) {
        refreshPendingQuestion('presence-awaiting');
      } else if (pendingQuestionRef.current) {
        setPendingQuestionFrom(null, 'presence-not-awaiting');
      }
    } catch (e: any) {
      if (tabIdRef.current !== requestTabId) return;
      console.warn('[' + runtime.logPrefix + '] presence failed tab=' + tabId.slice(-12) + ': ' + String(e?.message || e));
      setStatusFrom('inactive', 'presence-error');
    }
  }, [refreshPendingQuestion, runtime, setPendingQuestionFrom, setStatusFrom, tabId]);

  const refreshHistoryWithUpdating = useCallback((reason: string) => {
    const seq = ++historyUpdateSeqRef.current;
    setHistoryUpdating(true);
    historyDiag('REFRESH_REQUEST tab=' + tabId.slice(-12) + ' reason=' + reason);
    Promise.resolve(onHistoryRefresh())
      .catch((e: any) => {
        console.warn('[' + runtime.logPrefix + '] history refresh failed tab=' + tabId.slice(-12) + ' reason=' + reason + ': ' + String(e?.message || e));
      })
      .finally(() => {
        if (historyUpdateSeqRef.current === seq && tabIdRef.current === tabId) {
          setHistoryUpdating(false);
        }
      });
  }, [onHistoryRefresh, runtime.logPrefix, tabId]);

  useEffect(() => {
    tabIdRef.current = tabId;
    actionSeqRef.current += 1;
    actionInFlightRef.current = false;
    pasteBusyRef.current = false;
    pendingQuestionRef.current = null;
    answeringQuestionRef.current = false;
    midstreamPromptRecoveryRef.current = null;
    interruptRecoveryInFlightRef.current = false;
    interruptAwaitRef.current = null;
    setBusyAction(null);
    setIsPasteBusy(false);
    setHistoryUpdating(false);
    setError(null);
    setDraftWarning(null);
    setInterruptAwaiting(false);
    setPendingQuestion(null);
    setAnsweringQuestion(false);
    setQuestionError(null);
    setStatusFrom('inactive', 'tab-bind');
    refreshPresence();
    return () => {
      clearEmptyDraftNoticeTimer();
    };
  }, [clearEmptyDraftNoticeTimer, refreshPresence, setStatusFrom, tabId]);

  useEffect(() => {
    const handleAgentError = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as { tabId?: string; message?: string; error?: string };
      if (detail.tabId !== tabId) return;
      const message = String(detail.message || detail.error || '').trim();
      if (!message) return;
      setError(message);
      setDraftWarning(null);
    };
    window.addEventListener('history-panel:agent-error', handleAgentError);
    return () => window.removeEventListener('history-panel:agent-error', handleAgentError);
  }, [tabId]);

  useEffect(() => {
    const handleTuiReady = (_: any, data: { tabId?: string }) => {
      if (data?.tabId !== tabId) return;
      console.log('[' + runtime.logPrefix + '] ready-event tab=' + tabId.slice(-12));
      refreshPresence();
    };
    const handleStarted = (_: any, data: { tabId?: string }) => {
      if (data?.tabId !== tabId) return;
      const current = statusRef.current;
      const next = current === 'active' || current === 'busy' ? current : 'starting';
      setStatusFrom(next, 'command-started');
    };
    const handleBusy = (_: any, data: { tabId?: string; busy?: boolean; reason?: string }) => {
      if (data?.tabId !== tabId) return;
      if (isNonAuthoritativeBusyEvent(data)) {
        refreshPresence();
        return;
      }
      if (data.busy) setStatusFrom('busy', 'busy-state');
      else {
        if (pendingQuestionRef.current) setPendingQuestionFrom(null, 'busy-false');
        refreshHistoryWithUpdating('busy-false:' + (data.reason || 'unknown'));
        refreshPresence();
      }
    };
    const handleFinished = (_: any, data: { tabId?: string }) => {
      if (data?.tabId !== tabId) return;
      pasteBusyRef.current = false;
      setIsPasteBusy(false);
      refreshHistoryWithUpdating('command-finished');
      refreshPresence();
    };
    const handleAwaitingInput = (_: any, data: { tabId?: string; awaiting?: boolean }) => {
      if (data?.tabId !== tabId) return;
      console.log('[ClaudeHistoryQuestion] awaiting-event tab=' + tabId.slice(-12) + ' awaiting=' + !!data.awaiting);
      if (data.awaiting) {
        refreshPendingQuestion('awaiting-event');
      } else {
        setPendingQuestionFrom(null, 'awaiting-cleared');
        setQuestionError(null);
      }
    };
    const handlePasteBusy = (_: any, data: { tabId?: string; busy?: boolean }) => {
      if (data?.tabId !== tabId) return;
      pasteBusyRef.current = !!data.busy;
      setIsPasteBusy(!!data.busy);
      console.log('[' + runtime.logPrefix + '] paste-busy tab=' + tabId.slice(-12) + ' busy=' + !!data.busy);
    };

    if (runtime.readyEvent) ipcRenderer.on(runtime.readyEvent, handleTuiReady);
    ipcRenderer.on(runtime.busyEvent, handleBusy);
    if (runtime.awaitingEvent) ipcRenderer.on(runtime.awaitingEvent, handleAwaitingInput);
    if (runtime.pasteBusyEvent) ipcRenderer.on(runtime.pasteBusyEvent, handlePasteBusy);
    ipcRenderer.on('terminal:command-started', handleStarted);
    ipcRenderer.on('terminal:command-finished', handleFinished);
    return () => {
      if (runtime.readyEvent) ipcRenderer.removeListener(runtime.readyEvent, handleTuiReady);
      ipcRenderer.removeListener(runtime.busyEvent, handleBusy);
      if (runtime.awaitingEvent) ipcRenderer.removeListener(runtime.awaitingEvent, handleAwaitingInput);
      if (runtime.pasteBusyEvent) ipcRenderer.removeListener(runtime.pasteBusyEvent, handlePasteBusy);
      ipcRenderer.removeListener('terminal:command-started', handleStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleFinished);
    };
  }, [refreshPendingQuestion, runtime, setPendingQuestionFrom, tabId, refreshPresence, setStatusFrom, isNonAuthoritativeBusyEvent, refreshHistoryWithUpdating]);

  const readTerminalDraft = useCallback(async (reason: string) => {
    const requestTabId = tabId;
    const visualState = runtime.inspectDraft?.(tabId);
    if (visualState) {
      console.log('[' + runtime.logPrefix + ':draft] preflight tab=' + tabId.slice(-12) + ' reason=' + reason + ' hasDraft=' + visualState.hasDraft + ' source=' + visualState.source);
      if (visualState.hasDraft === false) {
        return { stale: false, text: '', images: 0 };
      }
      if (visualState.hasDraft === null) {
        throw new Error(runtime.label + ' terminal draft state is unknown; send stopped before touching terminal input.');
      }
    }
    console.log('[' + runtime.logPrefix + ':draft] grab-request tab=' + tabId.slice(-12) + ' reason=' + reason);
    const result = await runtime.grabDraft(tabId);
    if (tabIdRef.current !== requestTabId) return { stale: true, text: '', images: 0 };
    if (!result?.success) {
      const message = draftGrabErrorText(result);
      console.warn('[' + runtime.logPrefix + ':draft] grab-failed tab=' + tabId.slice(-12) + ' reason=' + reason + ' error=' + (result?.error || 'unknown'));
      throw new Error(message);
    }
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    const images = Number(result.images || 0);
    console.log('[' + runtime.logPrefix + ':draft] grab-ok tab=' + tabId.slice(-12) + ' reason=' + reason + ' chars=' + text.length + ' images=' + images);
    return { stale: false, text, images };
  }, [runtime, tabId]);

  useEffect(() => {
    if (!runtime.supportsInterruptRecovery) return;
    const finishInterruptAwait = (finishReason: string) => {
      const waiting = interruptAwaitRef.current;
      if (!waiting || waiting.tabId !== tabIdRef.current) return;
      const ageMs = Date.now() - waiting.at;
      console.log('[' + runtime.logPrefix + ':draft] interrupt-await done tab=' + tabId.slice(-12) + ' reason=' + finishReason + ' ageMs=' + ageMs);
      interruptAwaitRef.current = null;
      setInterruptAwaiting(false);
      if (actionSeqRef.current === waiting.seq) {
        actionInFlightRef.current = false;
        setBusyAction((current) => current === 'interrupt' ? null : current);
      }
      refreshPresence();
    };
    const handleInterruptRecovery = (_: any, data: { tabId?: string; busy?: boolean; reason?: string }) => {
      if (data?.tabId !== tabId || data.busy) return;
      if (isNonAuthoritativeBusyEvent(data)) return;
      console.log('[' + runtime.logPrefix + ':draft] interrupt-event tab=' + tabId.slice(-12) + ' reason=' + (data.reason || '-') + ' hasPending=' + !!midstreamPromptRecoveryRef.current);
      historyDiag('INTERRUPT_EVENT tab=' + tabId.slice(-12) +
        ' reason=' + (data.reason || '-') +
        ' hasPending=' + !!midstreamPromptRecoveryRef.current +
        ' pending=' + (midstreamPromptRecoveryRef.current?.handoffId || '-'));
      const recoveryReasons = runtime.interruptRecoveryReasons || ['interrupt'];
      if (!recoveryReasons.includes(data.reason || '')) {
        midstreamPromptRecoveryRef.current = null;
        finishInterruptAwait('busy-false:' + (data.reason || 'unknown'));
        return;
      }
      const pending = midstreamPromptRecoveryRef.current;
      if (!pending) {
        console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery skip tab=' + tabId.slice(-12) + ' reason=no-midstream-send');
        finishInterruptAwait('confirmed-no-prompt');
        return;
      }
      if (interruptRecoveryInFlightRef.current) {
        console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery skip tab=' + tabId.slice(-12) + ' reason=inflight');
        return;
      }
      const ageMs = Date.now() - pending.at;
      if (ageMs > 120000) {
        console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery skip tab=' + tabId.slice(-12) + ' reason=stale ageMs=' + ageMs);
        midstreamPromptRecoveryRef.current = null;
        finishInterruptAwait('stale-pending-prompt');
        return;
      }

      const requestTabId = tabId;
      interruptRecoveryInFlightRef.current = true;
      console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery start tab=' + tabId.slice(-12) + ' ageMs=' + ageMs + ' sentChars=' + pending.text.length);
      historyDiag('INTERRUPT_RECOVERY_START tab=' + tabId.slice(-12) +
        ' handoff=' + pending.handoffId +
        ' ageMs=' + ageMs +
        ' statusAtSend=' + pending.statusAtSend +
        ' chars=' + pending.text.length +
        ' preview="' + promptPreview(pending.text) + '"');
      (async () => {
        const delays = [0, 160, 420, 900];
        for (let attempt = 0; attempt < delays.length; attempt++) {
          const delay = delays[attempt];
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          if (tabIdRef.current !== requestTabId) return;
          console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery probe tab=' + tabId.slice(-12) + ' attempt=' + (attempt + 1) + ' delayMs=' + delay);
          try {
            const draft = await readTerminalDraft('interrupt-recovery-' + (attempt + 1));
            if (draft.stale || tabIdRef.current !== requestTabId) return;
            if (!draft.text) {
              console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery empty tab=' + tabId.slice(-12) + ' attempt=' + (attempt + 1));
              continue;
            }
            setPrompt((prev) => prependPromptTextOnce(prev, draft.text));
            setDraftWarning(runtime.label + ' returned an interrupted prompt; pulled it back from terminal input.');
            console.log('[' + runtime.logPrefix + ':draft] interrupt-recovery restored tab=' + tabId.slice(-12) + ' source=terminal attempt=' + (attempt + 1) + ' chars=' + draft.text.length + ' images=' + draft.images);
            onPromptStatusChange(pending.handoffId, 'cancelled', 'interrupt-restored-terminal-draft');
            historyDiag('INTERRUPT_RECOVERY_RESTORED tab=' + tabId.slice(-12) +
              ' handoff=' + pending.handoffId +
              ' attempt=' + (attempt + 1) +
              ' chars=' + draft.text.length +
              ' images=' + draft.images);
            requestAnimationFrame(() => promptTextareaRef.current?.focus());
            return;
          } catch (e: any) {
            console.warn('[' + runtime.logPrefix + ':draft] interrupt-recovery probe-failed tab=' + tabId.slice(-12) + ' attempt=' + (attempt + 1) + ': ' + String(e?.message || e));
          }
        }
        if (tabIdRef.current !== requestTabId) return;
        showEmptyDraftNotice(runtime.label + ' cancellation confirmed; prompt was not returned by terminal input.');
        onPromptStatusChange(pending.handoffId, 'cancelled', 'interrupt-no-terminal-draft');
        console.warn('[' + runtime.logPrefix + ':draft] interrupt-recovery not-restored tab=' + tabId.slice(-12) + ' reason=no-terminal-draft probes=' + delays.length + ' sentChars=' + pending.text.length);
        historyDiag('INTERRUPT_RECOVERY_NOT_RESTORED tab=' + tabId.slice(-12) +
          ' handoff=' + pending.handoffId +
          ' reason=no-terminal-draft probes=' + delays.length +
          ' sentChars=' + pending.text.length);
      })()
        .catch((e: any) => {
          console.warn('[' + runtime.logPrefix + ':draft] interrupt-recovery failed tab=' + tabId.slice(-12) + ': ' + String(e?.message || e));
        })
        .finally(() => {
          if (tabIdRef.current === requestTabId) {
            midstreamPromptRecoveryRef.current = null;
            interruptRecoveryInFlightRef.current = false;
            finishInterruptAwait('recovery-complete');
          }
        });
    };

    ipcRenderer.on(runtime.busyEvent, handleInterruptRecovery);
    return () => {
      ipcRenderer.removeListener(runtime.busyEvent, handleInterruptRecovery);
    };
  }, [isNonAuthoritativeBusyEvent, onPromptStatusChange, readTerminalDraft, refreshPresence, runtime, showEmptyDraftNotice, tabId]);

  useEffect(() => {
    if (!interruptAwaiting || status === 'busy') return;
    const waiting = interruptAwaitRef.current;
    if (!waiting || waiting.tabId !== tabIdRef.current) return;
    const timer = setTimeout(() => {
      const current = interruptAwaitRef.current;
      if (!current || current.tabId !== tabIdRef.current || statusRef.current === 'busy') return;
      const ageMs = Date.now() - current.at;
      console.log('[' + runtime.logPrefix + ':draft] interrupt-await clear tab=' + tabId.slice(-12) + ' reason=non-busy-status status=' + statusRef.current + ' ageMs=' + ageMs);
      historyDiag('INTERRUPT_AWAIT_CLEAR tab=' + tabId.slice(-12) +
        ' reason=non-busy-status' +
        ' status=' + statusRef.current +
        ' ageMs=' + ageMs);
      interruptAwaitRef.current = null;
      setInterruptAwaiting(false);
      if (actionSeqRef.current === current.seq) {
        actionInFlightRef.current = false;
        setBusyAction((active) => active === 'interrupt' ? null : active);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [interruptAwaiting, runtime.logPrefix, status, tabId]);

  const pullTerminalDraft = useCallback(async () => {
    if (actionInFlightRef.current) {
      console.log('[' + runtime.logPrefix + ':draft] drop-pull tab=' + tabId.slice(-12) + ' reason=inflight');
      return;
    }
    if (statusRef.current !== 'active') {
      setError(runtime.label + ' is not ready (' + statusRef.current + ')');
      return;
    }
    if (pendingQuestionRef.current) {
      setError(runtime.label + ' is waiting for a question answer');
      return;
    }

    const actionTabId = tabId;
    const actionSeq = ++actionSeqRef.current;
    actionInFlightRef.current = true;
    setBusyAction('grab');
    setError(null);
    setDraftWarning(null);
    try {
      const draft = await readTerminalDraft('manual-pull');
      if (draft.stale || tabIdRef.current !== actionTabId) return;
      if (!draft.text) {
        showEmptyDraftNotice(runtime.label + ' terminal input is empty');
        return;
      }
      setPrompt((prev) => prependPromptText(prev, draft.text));
      if (draft.images > 0) {
        setDraftWarning('Pulled text contains ' + draft.images + ' image placeholder' + (draft.images === 1 ? '' : 's') + '; images are not attached in this History input.');
      }
      requestAnimationFrame(() => promptTextareaRef.current?.focus());
    } catch (e: any) {
      if (tabIdRef.current === actionTabId) setError(String(e?.message || e));
      refreshPresence();
    } finally {
      if (actionSeqRef.current === actionSeq) {
        actionInFlightRef.current = false;
        if (tabIdRef.current === actionTabId) setBusyAction(null);
      }
    }
  }, [readTerminalDraft, refreshPresence, runtime.label, showEmptyDraftNotice, tabId]);

  const runAction = useCallback(async (kind: 'resume' | 'send' | 'interrupt' | 'stop') => {
    if (actionInFlightRef.current) {
      console.log('[' + runtime.logPrefix + '] drop-action tab=' + tabId.slice(-12) + ' kind=' + kind + ' reason=inflight');
      historyDiag('DROP_ACTION tab=' + tabId.slice(-12) + ' kind=' + kind + ' reason=inflight busyAction=' + (busyAction || 'none'));
      return;
    }
    if (kind === 'send' && pasteBusyRef.current) {
      console.log('[' + runtime.logPrefix + '] drop-action tab=' + tabId.slice(-12) + ' kind=send reason=paste-busy');
      return;
    }
    const actionTabId = tabId;
    const actionSeq = ++actionSeqRef.current;
    let sendHandoffId: string | null = null;
    let clearedPromptText: string | null = null;
    actionInFlightRef.current = true;
    setBusyAction(kind);
    setError(null);
    try {
      if (kind === 'resume') {
        setStatusFrom('starting', 'resume-click');
        const result = await runtime.resume({ tabId, sessionId, cwd });
        if (!result.success) throw new Error(result.error || 'Resume failed');
        if (tabIdRef.current !== actionTabId) return;
        if (result.alreadyRunning && result.status) setStatusFrom(result.status, 'resume-already-running');
      } else if (kind === 'send') {
        let text = prompt.trim();
        if (!text) return;
        if (pendingQuestionRef.current) throw new Error(runtime.label + ' is waiting for a question answer');
        const statusAtSend = statusRef.current;
        const acceptsBusyPrompt = statusAtSend === 'busy' && runtime.allowSendWhileBusy;
        if (statusAtSend !== 'active' && !acceptsBusyPrompt) throw new Error(runtime.label + ' is not ready (' + statusAtSend + ')');
        if (statusAtSend === 'active') {
          const terminalDraft = await readTerminalDraft('send-preflight');
          if (terminalDraft.stale || tabIdRef.current !== actionTabId) return;
          if (terminalDraft.text) {
            text = prependPromptText(text, terminalDraft.text);
            setPrompt(text);
            setDraftWarning('Terminal draft found — send stopped, text moved to top.');
            console.log('[' + runtime.logPrefix + ':draft] send-preflight blocked tab=' + tabId.slice(-12) + ' chars=' + terminalDraft.text.length + ' images=' + terminalDraft.images);
            requestAnimationFrame(() => promptTextareaRef.current?.focus());
            if (terminalDraft.images > 0) {
              setDraftWarning('Terminal draft found — send stopped, text moved to top. Review image placeholders.');
            }
            return;
          }
        } else {
          console.log('[' + runtime.logPrefix + ':draft] send-preflight skipped tab=' + tabId.slice(-12) + ' reason=busy-midstream');
        }
        const handoffId = createPromptHandoffId();
        const submittedAt = Date.now();
        sendHandoffId = handoffId;
        historyDiag('SEND_CLICK tab=' + tabId.slice(-12) +
          ' handoff=' + handoffId +
          ' statusAtSend=' + statusAtSend +
          ' chars=' + text.length +
          ' pasteBusy=' + pasteBusyRef.current +
          ' preview="' + promptPreview(text) + '"');
        onPromptSubmitted(text, 'sending', { handoffId, statusAtSend, submittedAt });
        setPrompt('');
        setDraftWarning(null);
        clearedPromptText = text;
        const result = await runtime.sendPrompt(tabId, text, {
          handoffId,
          source: 'history-panel',
          statusAtSend,
        });
        historyDiag('SEND_RESULT tab=' + tabId.slice(-12) +
          ' handoff=' + handoffId +
          ' success=' + (result?.success !== false) +
          ' submitted=' + !!result?.submitted +
          ' chunks=' + (result?.chunksTotal ?? 'na') +
          ' error=' + (result?.error || '-'));
        if (result?.success === false) throw new Error(result?.error || 'Send failed');
        if (tabIdRef.current !== actionTabId) return;
        onPromptStatusChange(handoffId, statusAtSend === 'busy' ? 'queued' : 'sent', 'send-result');
        midstreamPromptRecoveryRef.current = { text, at: Date.now(), handoffId, statusAtSend };
        console.log('[' + runtime.logPrefix + ':draft] send tracked tab=' + tabId.slice(-12) + ' handoff=' + handoffId + ' statusAtSend=' + statusAtSend + ' chars=' + text.length);
        if (runtime.optimisticBusyOnSend) {
          setStatusFrom('busy', 'send-click');
        } else {
          setStatusFrom('busy', 'send-confirmed');
          if (statusAtSend !== 'active') refreshPresence();
        }
        refreshHistoryWithUpdating('send-result');
      } else if (kind === 'interrupt') {
        const statusAtInterrupt = statusRef.current;
        const pending = midstreamPromptRecoveryRef.current;
        historyDiag('INTERRUPT_CLICK tab=' + tabId.slice(-12) +
          ' status=' + statusAtInterrupt +
          ' pending=' + (pending?.handoffId || '-') +
          ' pendingAgeMs=' + (pending ? Date.now() - pending.at : 0) +
          ' busyAction=' + (busyAction || 'none'));
        const result = runtime.interruptTurn(tabId);
        historyDiag('INTERRUPT_RESULT tab=' + tabId.slice(-12) +
          ' success=' + !!result.success +
          ' interrupted=' + !!result.interrupted +
          ' pending=' + (pending?.handoffId || '-') +
          ' error=' + (result.error || '-'));
        if (!result.success) throw new Error(result.error || 'Stop failed');
        if (result.interrupted && tabIdRef.current === actionTabId) {
          if (statusAtInterrupt === 'busy') {
            interruptAwaitRef.current = { tabId: actionTabId, seq: actionSeq, at: Date.now() };
            setInterruptAwaiting(true);
            setDraftWarning(null);
            console.log('[' + runtime.logPrefix + ':draft] interrupt-await start tab=' + tabId.slice(-12) + ' status=' + statusAtInterrupt);
            setTimeout(() => {
              if (tabIdRef.current === actionTabId && interruptAwaitRef.current?.seq === actionSeq) {
                refreshPresence();
              }
            }, 700);
          } else if (runtime.optimisticActiveOnInterrupt) {
            setStatusFrom('active', 'interrupt-click');
          } else {
            refreshPresence();
          }
        }
      } else if (kind === 'stop') {
        const result = await runtime.stopProcess(tabId);
        if (result?.success === false) throw new Error(result?.error || 'Stop failed');
        if (tabIdRef.current !== actionTabId) return;
        pasteBusyRef.current = false;
        setIsPasteBusy(false);
        setStatusFrom('inactive', 'stop-process-click');
      }
    } catch (e: any) {
      if (kind === 'send' && sendHandoffId && tabIdRef.current === actionTabId) {
        onPromptStatusChange(sendHandoffId, 'failed', 'send-error');
        const restorePrompt = clearedPromptText;
        if (restorePrompt) {
          setPrompt((current) => current.trim() ? current : restorePrompt);
        }
      }
      if (tabIdRef.current === actionTabId) setError(String(e?.message || e));
      refreshPresence();
    } finally {
      const keepInterruptAwait =
        kind === 'interrupt' &&
        tabIdRef.current === actionTabId &&
        interruptAwaitRef.current?.seq === actionSeq;
      if (actionSeqRef.current === actionSeq && !keepInterruptAwait) {
        actionInFlightRef.current = false;
        if (tabIdRef.current === actionTabId) setBusyAction(null);
      }
    }
  }, [busyAction, cwd, onPromptStatusChange, onPromptSubmitted, prompt, readTerminalDraft, refreshHistoryWithUpdating, refreshPresence, runtime, sessionId, setStatusFrom, tabId]);

  const answerPendingQuestion = useCallback(async (answers: Record<string, string>, stop = false) => {
    if (!runtime.answerQuestion) return;
    if (answeringQuestionRef.current) {
      console.log('[ClaudeHistoryQuestion] drop-answer tab=' + tabId.slice(-12) + ' reason=inflight stop=' + stop);
      return;
    }
    let pending = pendingQuestionRef.current;
    if (!pending) {
      pending = await refreshPendingQuestion('answer-missing-pending');
    }
    if (!pending) {
      setQuestionError('No pending question');
      console.warn('[ClaudeHistoryQuestion] no-pending tab=' + tabId.slice(-12) + ' stop=' + stop);
      return;
    }

    const actionTabId = tabId;
    answeringQuestionRef.current = true;
    setAnsweringQuestion(true);
    setQuestionError(null);
    console.log('[ClaudeHistoryQuestion] answer-start tab=' + tabId.slice(-12) + ' source=' + pending.source + ' stop=' + stop + ' answers=' + Object.keys(answers || {}).length);
    try {
      const result = await runtime.answerQuestion({ tabId, pendingQuestion: pending, answers, stop });
      if (result?.success === false) throw new Error(result?.error || result?.reason || 'Question answer failed');
      if (tabIdRef.current !== actionTabId) return;
      setPendingQuestionFrom(null, stop ? 'respond-manually' : 'answered');
      if (!stop) setStatusFrom('busy', 'question-answered');
      refreshHistoryWithUpdating('question-answer');
    } catch (e: any) {
      if (tabIdRef.current === actionTabId) {
        const message = String(e?.message || e);
        setQuestionError(message);
        console.warn('[ClaudeHistoryQuestion] answer-failed tab=' + tabId.slice(-12) + ': ' + message);
        refreshPendingQuestion('answer-error');
      }
    } finally {
      if (tabIdRef.current === actionTabId) setAnsweringQuestion(false);
      answeringQuestionRef.current = false;
    }
  }, [refreshHistoryWithUpdating, refreshPendingQuestion, runtime, setPendingQuestionFrom, setStatusFrom, tabId]);

  const meta = AGENT_STATUS_META[status];
  const isTurnBusy = status === 'busy';
  const controlsLocked = !!busyAction || isPasteBusy || answeringQuestion || rewindLocked;
  const isCancellingTurn = busyAction === 'interrupt' || interruptAwaiting;
  const showThinkingChip = isTurnBusy && !isCancellingTurn && !pendingQuestion;
  const showRewindingChip = rewindLocked && !pendingQuestion;
  const showUpdatingChip = historyUpdating && !isTurnBusy && !isCancellingTurn && !pendingQuestion && !rewindLocked;
  const canAcceptPrompt = status === 'active' || (status === 'busy' && runtime.allowSendWhileBusy);
  const canSend = canAcceptPrompt && prompt.trim().length > 0 && !pendingQuestion && !controlsLocked;
  const canGrabDraft = status === 'active' && !pendingQuestion && !controlsLocked;
  const canInterruptTurn = isTurnBusy && !controlsLocked;
  const canResume = status === 'inactive' && !!sessionId && !busyAction;
  const canStopProcess = (status === 'active' || status === 'busy' || status === 'starting') && !busyAction;
  const draftNoticeMeta = draftWarning ? getDraftNoticeMeta(draftWarning) : null;
  const promptIdleBorder = isCancellingTurn || rewindLocked ? 'rgba(217, 119, 6, 0.65)' : '#333';

  return (
    <div
      style={{
        flexShrink: 0,
        borderTop: '1px solid #333',
        backgroundColor: '#151515',
        padding: '8px 10px 10px 12px',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            color: '#888',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              backgroundColor: meta.color,
              boxShadow: status === 'busy' ? '0 0 8px rgba(217, 119, 6, 0.8)' : undefined,
              flexShrink: 0,
            }}
          />
          <span>{meta.label}</span>
        </div>
        {draftWarning && !error && draftNoticeMeta && (
          <Tooltip content={draftWarning}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                minWidth: 0,
                maxWidth: 260,
                height: 20,
                padding: '0 7px',
                borderRadius: 5,
                border: '1px solid ' + (draftNoticeMeta.tone === 'info' ? 'rgba(113, 113, 122, 0.55)' : 'rgba(251, 191, 36, 0.45)'),
                backgroundColor: draftNoticeMeta.tone === 'info' ? 'rgba(82, 82, 91, 0.18)' : 'rgba(217, 119, 6, 0.16)',
                color: draftNoticeMeta.tone === 'info' ? '#d4d4d8' : '#fbbf24',
                fontSize: 10,
                fontWeight: 650,
                letterSpacing: 0,
                flexShrink: 1,
              }}
            >
              {draftNoticeMeta.tone !== 'info' && <AlertTriangle size={12} style={{ flexShrink: 0 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {draftNoticeMeta.label}
              </span>
            </div>
          </Tooltip>
        )}
        {isCancellingTurn && !draftWarning && !error && (
          <Tooltip content={'Waiting for ' + runtime.label + ' stop record and restored prompt'}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: 20,
                padding: '0 7px',
                borderRadius: 5,
                border: '1px solid rgba(217, 119, 6, 0.5)',
                backgroundColor: 'rgba(217, 119, 6, 0.14)',
                color: '#fbbf24',
                fontSize: 10,
                fontWeight: 650,
                letterSpacing: 0,
                flexShrink: 0,
              }}
            >
              <HistorySpinner size={11} />
              <span>Stopping</span>
            </div>
          </Tooltip>
        )}
        <div style={{ flex: 1 }} />
        {status === 'inactive' && (
          <Tooltip content={'Resume ' + runtime.label + ' session'}>
            <button
              aria-label={'Resume ' + runtime.label + ' session'}
              onClick={() => runAction('resume')}
              disabled={!canResume}
              style={{
                ...historyControlButtonBase,
                cursor: canResume ? 'pointer' : 'default',
                color: canResume ? '#1a1a1a' : '#777',
                backgroundColor: canResume ? '#DA7756' : '#242424',
                borderColor: canResume ? '#DA7756' : '#343434',
              }}
            >
              <RotateCcw size={13} />
              {busyAction === 'resume' ? 'RESUMING' : 'Resume'}
            </button>
          </Tooltip>
        )}
        {status !== 'inactive' && (
          <Tooltip content={'Stop ' + runtime.label + ' process'}>
            <button
              aria-label={'Stop ' + runtime.label + ' process'}
              onClick={() => runAction('stop')}
              disabled={!canStopProcess}
              style={{
                ...historyControlButtonBase,
                width: 28,
                padding: 0,
                cursor: canStopProcess ? 'pointer' : 'default',
                color: canStopProcess ? '#fca5a5' : '#666',
              }}
            >
              <Power size={13} />
            </button>
          </Tooltip>
        )}
      </div>

      {pendingQuestion ? (
        <ClaudeHistoryQuestionCard
          key={(pendingQuestion.source || 'unknown') + ':' + (pendingQuestion.toolUseID || 'none') + ':' + (pendingQuestion.questions?.length || 0)}
          tabId={tabId}
          pending={pendingQuestion}
          answering={answeringQuestion}
          error={questionError}
          onAnswer={(answers) => answerPendingQuestion(answers, false)}
          onStop={() => answerPendingQuestion({}, true)}
        />
      ) : (
        <>
          {(showRewindingChip || showThinkingChip || showUpdatingChip) && (
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <HistoryThinkingChip
                label={runtime.label}
                text={showRewindingChip ? 'REWINDING' : showUpdatingChip ? 'UPDATING' : 'THINKING'}
              />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
            <textarea
              ref={promptTextareaRef}
              className="hp-agent-prompt"
              data-status={status}
              value={prompt}
              onChange={(e) => {
                if (isCancellingTurn || rewindLocked) return;
                setPrompt(e.target.value);
                if (draftWarning) setDraftWarning(null);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  if (canSend) runAction('send');
                }
              }}
              placeholder={rewindLocked ? 'Rewinding... input is locked' : isCancellingTurn ? 'Stopping... waiting for restored prompt' : status === 'inactive' ? 'Resume ' + runtime.label + ' to send' : status === 'starting' ? 'Waiting for prompt...' : 'Send a prompt...'}
              readOnly={isCancellingTurn || rewindLocked}
              rows={3}
              style={{
                flex: 1,
                minWidth: 0,
                resize: 'vertical',
                maxHeight: 120,
                minHeight: 56,
                backgroundColor: isCancellingTurn || rewindLocked ? '#130f0a' : '#0f0f0f',
                border: '1px solid ' + promptIdleBorder,
                borderRadius: 5,
                color: isCancellingTurn || rewindLocked ? '#c7c7c7' : '#e5e5e5',
                outline: 'none',
                padding: '7px 8px',
                fontSize: 12,
                lineHeight: 1.35,
                fontFamily: 'inherit',
              }}
              onFocus={(e) => { (e.currentTarget as HTMLTextAreaElement).style.borderColor = isCancellingTurn ? '#d97706' : '#DA7756'; }}
              onBlur={(e) => { (e.currentTarget as HTMLTextAreaElement).style.borderColor = promptIdleBorder; }}
            />
            <Tooltip content={canGrabDraft ? 'Pull terminal draft' : runtime.label + ' must be ready to pull draft'}>
              <button
                aria-label={'Pull ' + runtime.label + ' terminal draft'}
                onClick={pullTerminalDraft}
                disabled={!canGrabDraft}
                style={{
                  width: 34,
                  height: 42,
                  borderRadius: 5,
                  border: '1px solid ' + (canGrabDraft ? '#3f3f46' : '#343434'),
                  backgroundColor: canGrabDraft ? '#202020' : '#242424',
                  color: canGrabDraft ? '#a78bfa' : '#666',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: canGrabDraft ? 'pointer' : 'default',
                  flexShrink: 0,
                }}
              >
                {busyAction === 'grab' ? (
                  <HistorySpinner size={14} />
                ) : (
                  <ArrowDown size={14} />
                )}
              </button>
            </Tooltip>
            <Tooltip content={isCancellingTurn ? 'Waiting for cancellation to finish' : isPasteBusy ? runtime.label + ' paste is in progress' : isTurnBusy ? runtime.label + ' is busy' : 'Send prompt'}>
              <button
                aria-label={'Send ' + runtime.label + ' prompt'}
                onClick={() => runAction('send')}
                disabled={!canSend}
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 5,
                  border: '1px solid ' + (canSend ? '#DA7756' : '#343434'),
                  backgroundColor: canSend ? '#DA7756' : '#242424',
                  color: canSend ? '#1a1a1a' : '#666',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: canSend ? 'pointer' : 'default',
                  flexShrink: 0,
                }}
              >
                {busyAction === 'send' ? (
                  <HistorySpinner size={14} />
                ) : (
                  <Send size={14} />
                )}
              </button>
            </Tooltip>
            {isTurnBusy && (
              <Tooltip content={isCancellingTurn ? 'Waiting for cancellation record' : 'Stop current turn'}>
                <button
                  aria-label={'Stop current ' + runtime.label + ' turn'}
                  onClick={() => runAction('interrupt')}
                  disabled={!canInterruptTurn}
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 5,
                    border: '1px solid ' + (canInterruptTurn ? '#7f1d1d' : '#343434'),
                    backgroundColor: canInterruptTurn ? '#2a1515' : '#242424',
                    color: canInterruptTurn ? '#fca5a5' : '#666',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: canInterruptTurn ? 'pointer' : 'default',
                    flexShrink: 0,
                  }}
                >
                  {isCancellingTurn ? (
                    <HistorySpinner size={14} />
                  ) : (
                    <Square size={14} fill="currentColor" />
                  )}
                </button>
              </Tooltip>
            )}
          </div>
        </>
      )}
      {error && (
        <div style={{ marginTop: 6, color: '#fca5a5', fontSize: 11, wordBreak: 'break-word' }}>
          {error}
        </div>
      )}
    </div>
  );
}


function HistoryPanel({ tabId, sessionId, cwd, width, notesPanelWidth, isOpen, toolType = 'claude', enableClaudePtyControls = false, embedded = false }: HistoryPanelProps) {
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  const setHistoryPanelWidth = useUIStore((s) => s.setHistoryPanelWidth);
  const historyScrollToUuid = useUIStore((s) => s.historyScrollToUuid);
  const setHistoryScrollToUuid = useUIStore((s) => s.setHistoryScrollToUuid);
  const setHistoryVisibleUuids = useUIStore((s) => s.setHistoryVisibleUuids);
  const setHistoryScrollPosition = useUIStore((s) => s.setHistoryScrollPosition);
  const setHistoryPromptDraft = useUIStore((s) => s.setHistoryPromptDraft);
  const closePanel = useCallback(() => setHistoryPanelOpen(tabId, false), [tabId, setHistoryPanelOpen]);
  const resetPanelWidth = useCallback(() => setHistoryPanelWidth(HISTORY_PANEL_DEFAULT_WIDTH), [setHistoryPanelWidth]);
  const panelRef = useRef<HTMLDivElement>(null);
  const [rewindLock, setRewindLock] = useState<{ opId: string; targetText: string } | null>(null);
  const [rewindPreview, setRewindPreview] = useState<RewindPreviewState | null>(null);
  const lastServerEntriesRef = useRef<FullHistoryEntry[]>([]);

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
  const promptHandoffMetaRef = useRef<Map<string, PromptHandoffMeta>>(new Map());
  const suppressedPromptsRef = useRef<Map<string, SuppressedPrompt>>(new Map());
  const localPromptCleanupTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const rewindPreviewResult = useMemo(
    () => buildRewindPreviewEntries(entries, rewindPreview),
    [entries, rewindPreview],
  );
  const displayEntries = rewindPreviewResult.entries;
  const rewindPreviewHiddenCount = rewindPreviewResult.hiddenCount;
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
    return displayEntries.findIndex(e => e.uuid === claudeMemoryBoundaryUuid);
  }, [displayEntries, claudeMemoryBoundaryUuid]);
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
    for (let i = 0; i < displayEntries.length; i++) {
      const text = (displayEntries[i].content || '').toLowerCase();
      let idx = text.indexOf(q);
      while (idx !== -1) {
        positions.push({ entryIdx: i, entryUuid: displayEntries[i].uuid, offset: idx });
        idx = text.indexOf(q, idx + 1);
      }
    }
    return positions;
  }, [displayEntries, searchQuery]);

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
  }, [searchQuery, matchPositions, currentMatchIdx, displayEntries]);

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

  const clearLocalPromptCleanupTimer = useCallback((handoffId: string) => {
    const timer = localPromptCleanupTimersRef.current.get(handoffId);
    if (!timer) return;
    clearTimeout(timer);
    localPromptCleanupTimersRef.current.delete(handoffId);
  }, []);

  const armLocalPromptSentCleanup = useCallback((handoffId: string) => {
    if (!handoffId) return;
    clearLocalPromptCleanupTimer(handoffId);
    const timer = setTimeout(() => {
      localPromptCleanupTimersRef.current.delete(handoffId);
      const now = Date.now();
      setEntries(prev => prev.filter(entry => {
        if (!isLocalPromptEntry(entry) || entry.handoffId !== handoffId || entry.queueStatus !== 'sent') return true;
        const ageMs = now - (entry.statusChangedAt || entry.optimisticAt || Date.parse(entry.timestamp || '') || now);
        if (ageMs < LOCAL_PROMPT_SENT_TTL_MS) return true;
        historyDiag('LOCAL_EXPIRE_SENT tab=' + tabId.slice(-12) +
          ' handoff=' + handoffId +
          ' ageMs=' + ageMs +
          ' preview="' + promptPreview(entry.content) + '"');
        promptHandoffMetaRef.current.delete(handoffId);
        return false;
      }));
    }, LOCAL_PROMPT_SENT_TTL_MS + 250);
    localPromptCleanupTimersRef.current.set(handoffId, timer);
  }, [clearLocalPromptCleanupTimer, tabId]);

  const appendLocalPromptEntry = useCallback((
    text: string,
    queueStatus: 'sending' | 'queued' | 'sent',
    meta: { handoffId: string; statusAtSend: AgentPtyStatus; submittedAt: number }
  ) => {
    const cleanContent = normalizeHistoryPromptText(text);
    if (!cleanContent) return;
    const now = Date.now();
    const handoffId = meta.handoffId || createPromptHandoffId();
    const entry: FullHistoryEntry = {
      uuid: LOCAL_PROMPT_PREFIX + tabId + '-' + handoffId,
      role: 'queued',
      queueStatus,
      handoffId,
      statusReason: queueStatus === 'sending' ? 'send-start' : 'send-result',
      timestamp: new Date(now).toISOString(),
      content: cleanContent,
      sessionId,
      optimisticAt: now,
      statusChangedAt: now,
    };
    promptHandoffMetaRef.current.set(handoffId, { text: cleanContent, submittedAt: meta.submittedAt });
    historyDiag('LOCAL_APPEND tab=' + tabId.slice(-12) +
      ' handoff=' + handoffId +
      ' queueStatus=' + queueStatus +
      ' statusAtSend=' + meta.statusAtSend +
      ' chars=' + cleanContent.length +
      ' submittedLagMs=' + (now - meta.submittedAt) +
      ' preview="' + promptPreview(cleanContent) + '"');
    setEntries(prev => {
      return [...prev, entry];
    });
    if (isAtBottomRef.current) {
      setTimeout(() => scrollToBottom(true), 30);
    }
    if (queueStatus === 'sent') armLocalPromptSentCleanup(handoffId);
  }, [armLocalPromptSentCleanup, scrollToBottom, sessionId, tabId]);

  const updateLocalPromptEntry = useCallback((
    handoffId: string,
    queueStatus: 'queued' | 'sent' | 'cancelled' | 'failed',
    reason: string
  ) => {
    if (!handoffId) return;
    const changedAt = Date.now();
    const handoffMeta = promptHandoffMetaRef.current.get(handoffId) || null;
    clearLocalPromptCleanupTimer(handoffId);
    let suppression: SuppressedPrompt | null = null;
    if ((queueStatus === 'cancelled' || queueStatus === 'failed') && handoffMeta?.text) {
      suppression = {
        handoffId,
        text: handoffMeta.text,
        since: handoffMeta.submittedAt - 5000,
        until: changedAt + 10000,
        expiresAt: changedAt + 5 * 60 * 1000,
        reason,
      };
      suppressedPromptsRef.current.set(handoffId, suppression);
      historyDiag('SUPPRESS_ARMED tab=' + tabId.slice(-12) +
        ' handoff=' + handoffId +
        ' reason=' + reason +
        ' since=' + suppression.since +
        ' until=' + suppression.until +
        ' expiresAt=' + suppression.expiresAt +
        ' preview="' + promptPreview(handoffMeta.text) + '"');
    }
    setEntries(prev => prev.map(entry => {
      if (!isLocalPromptEntry(entry) || entry.handoffId !== handoffId) return entry;
      historyDiag('LOCAL_STATUS tab=' + tabId.slice(-12) +
        ' handoff=' + handoffId +
        ' queueStatus=' + queueStatus +
        ' reason=' + reason +
        ' prev=' + (entry.queueStatus || 'queued') +
        ' ageMs=' + (changedAt - (entry.optimisticAt || changedAt)));
      return {
        ...entry,
        queueStatus,
        statusReason: reason,
        statusChangedAt: changedAt,
      };
    }).filter(entry => !suppression || !entryMatchesSuppressedPrompt(entry, suppression)));
    if (queueStatus === 'sent') armLocalPromptSentCleanup(handoffId);
  }, [armLocalPromptSentCleanup, clearLocalPromptCleanupTimer, tabId]);

  const upsertLocalRewindEntry = useCallback((detail: {
    tabId?: string;
    opId?: string;
    status?: 'start' | 'done' | 'failed';
    targetUuid?: string;
    targetText?: string;
    mode?: 'native' | 'ai';
    toolType?: string;
    persisted?: boolean;
    historyInputDraft?: boolean;
    error?: string;
    message?: string;
  }) => {
    if (detail.tabId !== tabId) return;
    const opId = detail.opId || String(Date.now());
    const status = detail.status || 'start';
    const targetText = normalizeHistoryPromptText(detail.targetText || '');
    const now = Date.now();
    const uuid = LOCAL_REWIND_PREFIX + tabId + '-' + opId;
    const detailMessage = String(detail.error || detail.message || '');
    if (status === 'failed' && isRewindBusyGuardMessage(detailMessage)) {
      setRewindLock(null);
      setEntries(prev => prev.filter(entry => entry.uuid !== uuid));
      window.dispatchEvent(new CustomEvent('history-panel:agent-error', {
        detail: { tabId, message: detailMessage }
      }));
      return;
    }
    const rewindStatus: FullHistoryEntry['rewindStatus'] =
      status === 'failed' ? 'failed' : status === 'done' ? 'done' : 'rewinding';
    const content = detail.message
      ? detail.message
      : status === 'failed'
      ? (detail.error ? 'Failed: ' + detail.error : 'Rewind failed')
      : targetText
        ? 'Target: ' + targetText
        : 'Native /rewind';

    setRewindLock(status === 'start' ? { opId, targetText } : null);
    const removeLocalRewindEntry = () => {
      setEntries(prev => prev.filter(entry => entry.uuid !== uuid));
    };
    const isDurableRewind =
      status === 'done' && (
        detail.persisted === true ||
        detail.mode === 'ai' ||
        detail.toolType === 'codex' ||
        detail.toolType === 'gemini'
      );
    if (isDurableRewind) {
      setRewindPreview(null);
      if (targetText && detail.historyInputDraft === true) {
        setHistoryPromptDraft(tabId, targetText);
      }
      removeLocalRewindEntry();
      return;
    }
    if (status === 'done' && detail.mode === 'native' && detail.targetUuid && targetText && (detail.toolType || toolType) === 'claude') {
      setRewindPreview({ opId, targetUuid: detail.targetUuid, targetText, startedAt: now });
      setHistoryPromptDraft(tabId, targetText);
    }
    if (status !== 'failed') {
      removeLocalRewindEntry();
      return;
    }
    setEntries(prev => {
      const idx = prev.findIndex(entry => entry.uuid === uuid);
      const nextEntry: FullHistoryEntry = {
        uuid,
        role: 'rewind',
        rewindStatus,
        timestamp: new Date(now).toISOString(),
        content,
        sessionId,
        optimisticAt: now,
      };
      if (idx < 0) return [...prev, nextEntry];
      const next = [...prev];
      next[idx] = { ...next[idx], ...nextEntry };
      return next;
    });
    if (isAtBottomRef.current) {
      setTimeout(() => scrollToBottom(true), 30);
    }
  }, [scrollToBottom, sessionId, setHistoryPromptDraft, tabId, toolType]);

  useEffect(() => {
    setRewindLock(null);
    setRewindPreview(null);
  }, [tabId, sessionId]);

  useEffect(() => {
    const clearPreview = (_event: any, data: { tabId?: string }) => {
      if (data?.tabId === tabId) setRewindPreview(null);
    };
    ipcRenderer.on('terminal:command-finished', clearPreview);
    ipcRenderer.on('terminal:command-started', clearPreview);
    return () => {
      ipcRenderer.removeListener('terminal:command-finished', clearPreview);
      ipcRenderer.removeListener('terminal:command-started', clearPreview);
    };
  }, [tabId]);

  // Load full history
  const loadHistory = useCallback(async (isRefresh = false) => {
    if (!sessionId) return false;
    try {
      const ipcChannel = toolType === 'gemini' ? 'gemini:get-full-history' : toolType === 'codex' ? 'codex:get-full-history' : 'claude:get-full-history';
      const result = await ipcRenderer.invoke(ipcChannel, { sessionId, cwd });
      if (result.success) {
        const now = Date.now();
        for (const [handoffId, suppressed] of suppressedPromptsRef.current) {
          if ((suppressed.expiresAt || suppressed.until) < now) {
            suppressedPromptsRef.current.delete(handoffId);
            promptHandoffMetaRef.current.delete(handoffId);
            historyDiag('SUPPRESS_EXPIRED tab=' + tabId.slice(-12) +
              ' handoff=' + handoffId +
              ' reason=' + suppressed.reason);
          }
        }
        const rawServerEntries: FullHistoryEntry[] = result.entries || [];
        const suppressedResult = filterSuppressedPromptEntries(rawServerEntries, suppressedPromptsRef.current.values());
        const serverEntries = suppressedResult.entries;
        lastServerEntriesRef.current = serverEntries;
        if (suppressedResult.hidden > 0) {
          historyDiag('SUPPRESS_FILTERED tab=' + tabId.slice(-12) +
            ' hidden=' + suppressedResult.hidden +
            ' serverRaw=' + rawServerEntries.length +
            ' server=' + serverEntries.length);
        }
        setClaudeMemoryBoundaryUuid(result.claudeMemoryBoundaryUuid || null);
        setRewindPreview((current) =>
          current && serverHistoryMaterializedRewindBranch(serverEntries, current) ? null : current
        );

        if (!isRefresh) {
          const newEntries = serverEntries;
          console.warn(`[HP] initial load: ${newEntries.length} entries`);
          // startTransition: React 19 yields to browser between chunks,
          // keeping spinner animation smooth during heavy DOM renders
          startTransition(() => {
            setEntries(newEntries);
            setLoading(false);
          });
          // Starts at the top by default (no scrollToBottom on initial load)
        } else {
          // Refresh: update when count OR stable row state changed. Queue-operation
          // rows can flip QUEUED → SENT without changing entries.length.
          setEntries(prev => {
            const localBefore = prev.filter(isLocalPromptEntry);
            if (localBefore.length > 0) {
              const localSummary = localBefore.map((entry) => {
                const matched = serverHasPromptEntry(serverEntries, entry);
                const ageMs = Date.now() - (entry.optimisticAt || Date.parse(entry.timestamp || '') || Date.now());
                return (entry.handoffId || entry.uuid.slice(-8)) + ':' + (entry.queueStatus || 'queued') + ':matched=' + matched + ':age=' + ageMs;
              }).join(',');
              historyDiag('REFRESH_LOCALS tab=' + tabId.slice(-12) +
                ' server=' + serverEntries.length +
                ' locals=' + localBefore.length +
                ' [' + localSummary + ']');
            }
            const newEntries = mergeServerAndLocalEntries(serverEntries, prev);
            const sameEntries =
              newEntries.length === prev.length &&
              newEntries.every((entry, idx) => {
                const old = prev[idx];
                return old &&
                  old.uuid === entry.uuid &&
                  old.role === entry.role &&
                  old.queueStatus === entry.queueStatus &&
                  old.timestamp === entry.timestamp &&
                  old.content === entry.content;
              });
            if (sameEntries) return prev;
            console.warn(`[HP] refresh: ${prev.length} → ${newEntries.length}`);
            if (isAtBottomRef.current && newEntries.length > prev.length) {
              setTimeout(() => scrollToBottom(true), 100);
            }
            return newEntries;
          });
        }
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[HistoryPanel] Load error:', e);
      if (!isRefresh) setLoading(false);
      return false;
    }
  }, [sessionId, cwd, scrollToBottom, tabId, toolType]);

  const waitForDurableRewindHistory = useCallback(async (detail: {
    targetUuid?: string;
    opId?: string;
    toolType?: string;
  }) => {
    const targetUuid = detail.targetUuid || '';
    for (let attempt = 0; attempt < 6; attempt++) {
      const ok = await loadHistory(true);
      const serverEntries = lastServerEntriesRef.current || [];
      const targetStillVisible = !!targetUuid && serverEntries.some((entry) => entry.uuid === targetUuid);
      historyDiag('REWIND_REFRESH tab=' + tabId.slice(-12) +
        ' op=' + (detail.opId || '-') +
        ' attempt=' + (attempt + 1) +
        ' ok=' + ok +
        ' targetStillVisible=' + targetStillVisible +
        ' server=' + serverEntries.length);
      if (!targetStillVisible) return true;
      await new Promise((resolve) => setTimeout(resolve, attempt < 2 ? 140 : 320));
    }
    return false;
  }, [loadHistory, tabId]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as {
        tabId?: string;
        opId?: string;
        status?: 'start' | 'done' | 'failed';
        targetUuid?: string;
        targetText?: string;
        mode?: 'native' | 'ai';
        toolType?: string;
        persisted?: boolean;
        historyInputDraft?: boolean;
        error?: string;
        message?: string;
      };
      if (detail.tabId !== tabId) return;
      const durableDone = detail.status === 'done' && (
        detail.persisted === true ||
        detail.mode === 'ai' ||
        detail.toolType === 'codex' ||
        detail.toolType === 'gemini'
      );
      if (!durableDone) {
        upsertLocalRewindEntry(detail);
        return;
      }
      upsertLocalRewindEntry({
        ...detail,
        status: 'start',
        message: 'Updating history...',
      });
      waitForDurableRewindHistory(detail)
        .catch((e: any) => {
          console.warn('[HistoryPanel] rewind refresh wait failed tab=' + tabId.slice(-12) + ': ' + String(e?.message || e));
        })
        .finally(() => {
          upsertLocalRewindEntry(detail);
        });
    };
    window.addEventListener('history-panel:rewind-log', handler);
    return () => window.removeEventListener('history-panel:rewind-log', handler);
  }, [tabId, upsertLocalRewindEntry, waitForDurableRewindHistory]);

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
    setRewindPreview(null);
    for (const timer of localPromptCleanupTimersRef.current.values()) clearTimeout(timer);
    localPromptCleanupTimersRef.current.clear();
    promptHandoffMetaRef.current.clear();
    suppressedPromptsRef.current.clear();
    loadHistory(false);
  }, [sessionId, toolType]);

  useEffect(() => {
    return () => {
      for (const timer of localPromptCleanupTimersRef.current.values()) clearTimeout(timer);
      localPromptCleanupTimersRef.current.clear();
    };
  }, []);

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

  // Generation guard for the scroll-to-uuid convergence loop below: a newer
  // Cmd+click supersedes an in-flight loop, and unmount stops it (so it can't
  // setState on an unmounted component). NOT driven by the effect's cleanup —
  // the loop must survive the re-render caused by clearing historyScrollToUuid.
  const scrollGenRef = useRef(0);
  const scrollMountedRef = useRef(true);
  useEffect(() => () => { scrollMountedRef.current = false; scrollGenRef.current++; }, []);

  useEffect(() => {
    if (!historyScrollToUuid) return;
    if (loading || displayEntries.length === 0) return; // wait for entries; uuid stays in store
    const targetUuid = historyScrollToUuid;
    const idx = displayEntries.findIndex((e) => e.uuid === targetUuid);
    // Consume the store key immediately. The convergence loop is driven by the
    // ref-generation guard, NOT by this effect's cleanup, so clearing the key
    // (which re-runs the effect → early-return above) does not abort the loop.
    setHistoryScrollToUuid(null);
    if (idx < 0) {
      // entry doesn't exist in this session — acknowledge so the dot spinner clears
      window.dispatchEvent(
        new CustomEvent('history-panel:scrolled-to', { detail: { tabId, uuid: targetUuid, found: false } }),
      );
      return;
    }

    // Variable-height virtualization race. When the panel was just opened
    // (closed→open — the Cmd+click path), Virtuoso mounts at the tail
    // (initialTopMostItemIndex = last) and a single scrollToIndex fired in the
    // same tick lands on an ESTIMATED offset — the rows above the target aren't
    // measured yet, so the farther the target the larger the error (user:
    // «на длинных дистанциях скроллится не к тому юзерпромпту»). When the panel
    // was already open the rows are measured and one call is accurate.
    // Fix: re-issue scrollToIndex across frames until the target row's real DOM
    // rect stops moving (Virtuoso has honored the scroll AND finished measuring),
    // then flash + emit the done-event. Stability — not a fixed delay — is the
    // signal, so it self-adapts to short vs long distances.
    const myGen = ++scrollGenRef.current;
    let attempts = 0;
    let stable = 0;
    let lastTop: number | null = null;
    const MAX_ATTEMPTS = 40; // ~40 × 40ms ≈ 1.6s ceiling

    const finish = () => {
      if (!scrollMountedRef.current || scrollGenRef.current !== myGen) return;
      setFlashUuid(targetUuid);
      window.dispatchEvent(
        new CustomEvent('history-panel:scrolled-to', { detail: { tabId, uuid: targetUuid, found: true } }),
      );
      setTimeout(() => {
        if (scrollMountedRef.current && scrollGenRef.current === myGen) setFlashUuid(null);
      }, 600);
    };

    const step = () => {
      if (!scrollMountedRef.current || scrollGenRef.current !== myGen) return; // superseded / unmounted
      virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'auto' });
      attempts++;
      const scroller = virtuosoScrollerRef.current;
      const node = scroller?.querySelector(`[data-uuid="${CSS.escape(targetUuid)}"]`) as HTMLElement | null;
      if (node && scroller) {
        // Offset of the row relative to the scroller's own viewport — immune to
        // the panel's slide-in transform (both translate together), so this only
        // moves when the INTERNAL scroll position is still settling.
        const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        if (lastTop !== null && Math.abs(top - lastTop) < 1) stable++; else stable = 0;
        lastTop = top;
        // Mounted + position unchanged for 2 consecutive frames, after at least
        // a few scrollToIndex calls → Virtuoso has settled on the target row.
        if (stable >= 2 && attempts >= 3) { finish(); return; }
      }
      if (attempts >= MAX_ATTEMPTS) { finish(); return; }
      setTimeout(step, 40);
    };
    setTimeout(step, 0);
  }, [historyScrollToUuid, loading, displayEntries, tabId, setHistoryScrollToUuid]);

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
  const entriesRef = useRef(displayEntries);
  entriesRef.current = displayEntries;

  // Build mapping: assistant/non-user UUID → preceding user UUID
  // So when an assistant response is visible, the parent user dot stays highlighted in Timeline.
  const assistantToUserMap = React.useMemo(() => {
    const map = new Map<string, string>();
    let lastUserUuid: string | null = null;
    for (const e of displayEntries) {
      if (e.role === 'user') {
        lastUserUuid = e.uuid;
      } else if (lastUserUuid) {
        map.set(e.uuid, lastUserUuid);
      }
    }
    return map;
  }, [displayEntries]);

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
    lengthRef.current = displayEntries.length;
    recomputeVisibleUuids();
  }, [displayEntries, recomputeVisibleUuids]);

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
      const rightEdge = panelRef.current?.getBoundingClientRect().right ?? (document.body.clientWidth - notesPanelWidth);
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
      ref={panelRef}
      style={{
        position: embedded ? 'relative' : 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
        width: embedded ? (slideIn ? width : 0) : width,
        height: '100%',
        flexShrink: 0,
        overflow: 'hidden',
        backgroundColor: '#1a1a1a',
        borderLeft: embedded && !slideIn ? 'none' : '1px solid #333',
        zIndex: 101,
        display: 'flex',
        flexDirection: 'column',
        transform: embedded ? 'none' : (slideIn ? 'translateX(0)' : 'translateX(100%)'),
        transition: embedded ? 'width 50ms ease-out' : 'transform 50ms ease-out',
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
        {!searchOpen && rewindPreview && (
          <Tooltip content="Preview after native rewind. JSONL is not changed until you submit the restored prompt. Restarting Claude or reopening History shows the full transcript again.">
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                minWidth: 0,
                maxWidth: 240,
                height: 20,
                padding: '0 7px',
                borderRadius: 5,
                border: '1px solid rgba(217, 119, 6, 0.42)',
                backgroundColor: 'rgba(217, 119, 6, 0.13)',
                color: '#fbbf24',
                fontSize: 10,
                fontWeight: 750,
                letterSpacing: 0.2,
                flexShrink: 1,
              }}
            >
              <span style={{ whiteSpace: 'nowrap' }}>REWIND PREVIEW</span>
              <span style={{ color: '#a1a1aa', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {rewindPreviewHiddenCount > 0 ? rewindPreviewHiddenCount + ' hidden' : 'unsaved'}
              </span>
            </div>
          </Tooltip>
        )}
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
          aria-label="Reset History panel width"
          onClick={resetPanelWidth}
          style={{
            background: 'none',
            border: 'none',
            color: width === HISTORY_PANEL_DEFAULT_WIDTH ? '#444' : '#666',
            cursor: 'pointer',
            padding: 2,
            width: 22,
            height: 22,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = width === HISTORY_PANEL_DEFAULT_WIDTH ? '#444' : '#666'; }}
        >
          <RotateCcw size={15} />
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: '50%',
              transform: 'translateY(-48%)',
              textAlign: 'center',
              fontSize: 7,
              fontWeight: 800,
              lineHeight: 1,
              pointerEvents: 'none',
            }}
          >
            W
          </span>
        </button>
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
            <HistorySpinner size={16} />
            Loading...
          </div>
        ) : displayEntries.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#555', fontSize: 13 }}>
            No history entries
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={displayEntries}
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
            initialTopMostItemIndex={displayEntries.length > 0 ? displayEntries.length - 1 : 0}
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

      {enableClaudePtyControls && (toolType === 'claude' || toolType === 'codex') && (
        <AgentHistoryControls
          tabId={tabId}
          sessionId={sessionId}
          cwd={cwd}
          toolType={toolType as AgentHistoryTool}
          onHistoryRefresh={() => loadHistory(true)}
          onPromptSubmitted={appendLocalPromptEntry}
          onPromptStatusChange={updateLocalPromptEntry}
          rewindLocked={!!rewindLock}
        />
      )}
    </div>
  );

  if (embedded) return panel;

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
