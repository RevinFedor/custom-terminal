import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore, type BgTask } from '../../../store/useWorkspaceStore';
import {
  useExternalStoreRuntime,
  ThreadPrimitive,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { AssistantProviderBase } from '@assistant-ui/core/react';
import { X as XIcon, Loader2 } from 'lucide-react';
import { parseSubagentMessages, type SDKChatMessage } from './sdkHistoryParser';
import { convertMessage, UserMsg, AssistantMsg, SystemMsg, UserMsgActionsContext } from './ClaudeSDKTab';

const { ipcRenderer } = window.require('electron');

const PANE_HEIGHT = 300;

function useBgTaskById(tabId: string, taskId: string | null): BgTask | null {
  return useWorkspaceStore((s) => {
    if (!taskId) return null;
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (!t || !t.bgTasks) continue;
      return t.bgTasks.find(x => x.taskId === taskId) || null;
    }
    return null;
  });
}

// Re-render every second while task is running — keeps elapsed timer fresh.
function useTickWhileRunning(running: boolean) {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!running) return;
    const h = window.setInterval(() => force(), 1000);
    return () => window.clearInterval(h);
  }, [running]);
}

// ----------------------------------------------------------------------------
// BashDetail — live-tail the output_file via IPC. Polls every 600ms while
// status==='running', stops once terminal. Read-only, monospace, autoscroll.
// ----------------------------------------------------------------------------
function BashDetail({ task }: { task: BgTask }) {
  const [content, setContent] = useState('');
  const [missing, setMissing] = useState(false);
  const offsetRef = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true); // whether to autoscroll on new data

  // Fresh poll on task change.
  useEffect(() => {
    offsetRef.current = 0;
    setContent('');
    setMissing(false);
  }, [task.taskId, task.outputFile]);

  // Poll loop. While running → 600ms; one final fetch after terminal status.
  useEffect(() => {
    const path = task.outputFile;
    if (!path) return; // no output file yet (waiting for task_notification)
    let cancelled = false;

    const pull = async () => {
      try {
        const res = await ipcRenderer.invoke('claude-sdk:read-background-output', { path, offset: offsetRef.current });
        if (cancelled) return;
        if (res?.missing) { setMissing(true); return; }
        if (!res?.success) return;
        if (typeof res.size === 'number') offsetRef.current = res.size;
        if (res.content) {
          setContent(prev => prev + res.content);
        }
      } catch {}
    };

    pull(); // immediate
    if (task.status === 'running') {
      const h = window.setInterval(pull, 600);
      return () => { cancelled = true; window.clearInterval(h); };
    }
    return () => { cancelled = true; };
  }, [task.outputFile, task.status]);

  // Sticky autoscroll: follow bottom if user hasn't manually scrolled up.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stickyRef.current) el.scrollTop = el.scrollHeight;
  }, [content]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    stickyRef.current = atBottom;
  };

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="h-full w-full overflow-y-auto font-mono text-[0.92em] whitespace-pre-wrap break-all px-3 py-2"
      style={{ background: '#0f0f0f', color: '#d4d4d4', lineHeight: 1.45 }}
    >
      {missing && <span className="text-[#888] italic">Output file not found.</span>}
      {!missing && !content && (
        <span className="text-[#888] italic inline-flex items-center gap-2">
          {task.status === 'running' && <Loader2 size={12} className="animate-spin" />}
          {task.status === 'running' ? 'Waiting for first output…' : '(empty output)'}
        </span>
      )}
      {content}
    </div>
  );
}

// ----------------------------------------------------------------------------
// AgentDetail — read-only mini-thread. Loads subagent JSONL via SDK helper,
// converts to SDKChatMessage[], renders inside a SECOND assistant-ui runtime
// instance (no composer, no slash popup) using the same UserMsg/AssistantMsg
// components as the main thread. Polls every 1.5s while running to capture
// new chunks; stops once terminal.
// ----------------------------------------------------------------------------
function AgentDetail({ task, parentSessionId, cwd }: { task: BgTask; parentSessionId: string | null; cwd: string }) {
  const [messages, setMessages] = useState<SDKChatMessage[]>([]);
  const [loading, setLoading] = useState(true);

  const agentId = task.agentSessionId || task.taskId;

  useEffect(() => {
    let cancelled = false;
    let interval: number | null = null;

    const load = async () => {
      if (!parentSessionId || !agentId) { setLoading(false); return; }
      try {
        const res = await ipcRenderer.invoke('claude-sdk:get-subagent-messages', {
          sessionId: parentSessionId,
          agentId,
          cwd,
        });
        if (cancelled) return;
        if (res?.success) {
          const raw = res.messages || [];
          const parsed = parseSubagentMessages(raw);
          console.warn('[BgProbeR:SubAgentLoad] agentId=' + agentId?.slice(0,8) + ' rawCount=' + raw.length + ' parsedCount=' + parsed.length + ' rawTypes=' + raw.map((m: any) => m.type + (m.subagent_type ? '@'+m.subagent_type : '')).slice(0, 10).join(',') + ' firstRaw=' + JSON.stringify(raw[0]).slice(0, 300));
          setMessages(parsed);
        }
      } catch {}
      finally { if (!cancelled) setLoading(false); }
    };

    load();
    if (task.status === 'running') {
      interval = window.setInterval(load, 1500);
    }
    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [parentSessionId, agentId, cwd, task.status]);

  // Show the parent's prompt as the opening user-bubble if (a) we have it in
  // task.initialPrompt and (b) subagent JSONL didn't already contribute one.
  // Cases where this matters: JSONL flush lag (pane opened during run, before
  // subagent flushed first record); reload after restart where task started
  // long ago but agentId got dropped.
  const messagesWithPrompt = useMemo(() => {
    if (!task.initialPrompt) return messages;
    const firstUser = messages.find(m => m.role === 'user');
    if (firstUser && firstUser.text.trim() === task.initialPrompt.trim()) return messages;
    if (firstUser) return messages; // some user message already there — don't double up
    return [{
      id: 'subagent-prompt-' + task.taskId,
      role: 'user' as const,
      text: task.initialPrompt,
      toolCalls: [],
      thinking: null,
      timestamp: task.startedAt,
    }, ...messages];
  }, [messages, task.initialPrompt, task.taskId, task.startedAt]);

  const auiMessages = useMemo<ThreadMessageLike[]>(
    () => messagesWithPrompt.map(convertMessage),
    [messagesWithPrompt],
  );

  const runtime = useExternalStoreRuntime({
    messages: auiMessages,
    setMessages: () => {}, // read-only
    isRunning: task.status === 'running',
    onNew: async () => {}, // read-only, never invoked
    convertMessage: (m: ThreadMessageLike) => m,
  });

  // No-op actions for read-only UserMsg (no Edit/Repeat buttons).
  const noopActions = useMemo(() => ({
    onRepeat: () => {},
    onEdit: () => {},
    isPersistedMsgId: () => false,
  }), []);

  if (loading && messages.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[0.85em] text-[#888] gap-2">
        <Loader2 size={14} className="animate-spin" />
        Loading transcript…
      </div>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[0.85em] text-[#888]">
        {task.status === 'running'
          ? 'Agent has not emitted any messages yet.'
          : (task.finalSummary || 'No transcript captured.')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-2">
      <AssistantProviderBase runtime={runtime}>
        <UserMsgActionsContext.Provider value={noopActions as any}>
          <ThreadPrimitive.Root className="flex flex-col">
            <ThreadPrimitive.Messages
              components={{
                UserMessage: UserMsg as any,
                AssistantMessage: AssistantMsg as any,
                SystemMessage: SystemMsg as any,
              }}
            />
          </ThreadPrimitive.Root>
        </UserMsgActionsContext.Provider>
      </AssistantProviderBase>
    </div>
  );
}

// ----------------------------------------------------------------------------
// TaskDetailPane — outer shell. Header (icon + name + status + elapsed +
// close), 300px content area dispatched by kind.
// ----------------------------------------------------------------------------
interface TaskDetailPaneProps {
  tabId: string;
  taskId: string;
  parentSessionId: string | null;
  cwd: string;
  onClose: () => void;
}

export function TaskDetailPane({ tabId, taskId, parentSessionId, cwd, onClose }: TaskDetailPaneProps) {
  const task = useBgTaskById(tabId, taskId);
  useTickWhileRunning(task?.status === 'running');

  // Escape closes — but only when our pane has the user's "intent" (i.e. not
  // focused inside a textarea elsewhere). Capture phase ensures we beat any
  // unrelated handlers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!task) return null;

  const elapsed = (() => {
    const end = task.endedAt || Date.now();
    const ms = Math.max(0, end - task.startedAt);
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  })();

  const statusLabel = task.status === 'running' ? 'RUNNING'
                    : task.status === 'completed' ? 'DONE'
                    : task.status === 'failed' ? 'FAILED'
                    : 'STOPPED';
  const statusColor = task.status === 'running' ? '#d97706'
                    : task.status === 'completed' ? '#4ade80'
                    : task.status === 'failed' ? '#ef4444'
                    : '#888';

  return (
    <div
      className="flex flex-col shrink-0"
      style={{
        height: PANE_HEIGHT,
        borderTop: '1px solid #2a2a2a',
        background: '#141414',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 shrink-0"
        style={{ borderBottom: '1px solid #2a2a2a', background: '#1a1a1a' }}
      >
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[0.77em] font-mono font-semibold uppercase tracking-wider"
          style={{ color: statusColor, background: `${statusColor}1a`, border: `1px solid ${statusColor}44` }}
        >
          {statusLabel}
        </span>
        <span className="text-[0.85em] font-mono text-[#bdbdbd] uppercase tracking-wide">
          {task.kind === 'bash' ? 'BASH' : 'AGENT'}
        </span>
        <span className="text-[0.92em] text-[#e0e0e0] font-mono truncate flex-1 min-w-0">
          {task.name}
        </span>
        {task.lastToolName && task.status === 'running' && (
          <span className="text-[0.77em] text-[#888] font-mono shrink-0">→ {task.lastToolName}</span>
        )}
        <span className="text-[0.77em] text-[#666] font-mono tabular-nums shrink-0">{elapsed}</span>
        <button
          type="button"
          onClick={onClose}
          onMouseDown={(e) => e.preventDefault()}
          className="ml-1 inline-flex items-center justify-center w-5 h-5 rounded hover:bg-[#2a2a2a] text-[#888] hover:text-[#e0e0e0] transition-colors cursor-pointer"
          title="Close (Esc)"
        >
          <XIcon size={12} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {task.kind === 'bash'
          ? <BashDetail task={task} />
          : <AgentDetail task={task} parentSessionId={parentSessionId} cwd={cwd} />}
      </div>
    </div>
  );
}
