import React, { useEffect, useMemo } from 'react';
import { useWorkspaceStore, type BgTask } from '../../../store/useWorkspaceStore';
import { Terminal as TerminalIcon, Bot } from 'lucide-react';

// Per-tab selector. Subscribes only to bgTasks (granular) — avoids whole-tab
// re-renders on every assistant chunk.
function useBgTasks(tabId: string): BgTask[] {
  return useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.bgTasks || EMPTY;
    }
    return EMPTY;
  });
}
const EMPTY: BgTask[] = [];

function StatusDot() {
  return (
    <span
      className="inline-block w-[6px] h-[6px] rounded-full shrink-0"
      style={{
        background: '#d97706',
        animation: 'sdk-bg-task-pulse 1.4s ease-in-out infinite',
        boxShadow: '0 0 4px rgba(217, 119, 6, 0.4)',
      }}
    />
  );
}

function formatElapsed(task: BgTask): string {
  const ms = Math.max(0, Date.now() - task.startedAt);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
}

interface BackgroundTasksBarProps {
  tabId: string;
  expandedTaskId: string | null;
  onSelect: (taskId: string | null) => void;
}

export function BackgroundTasksBar({ tabId, expandedTaskId, onSelect }: BackgroundTasksBarProps) {
  const allTasks = useBgTasks(tabId);
  // Bar surfaces ONLY running tasks. Completed/failed/stopped fall back into
  // chat history (the inline Agent/Bash tool-cards in the main thread are the
  // record). Once a task transitions out of 'running', its chip disappears.
  const tasks = useMemo(() => allTasks.filter(t => t.status === 'running'), [allTasks]);

  // Auto-close detail-pane if the currently expanded task is no longer in the
  // running list (it finished while user was looking at it).
  useEffect(() => {
    if (!expandedTaskId) return;
    if (!tasks.some(t => t.taskId === expandedTaskId)) onSelect(null);
  }, [tasks, expandedTaskId, onSelect]);

  // 1s tick keeps elapsed live. No tick when nothing is running.
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (tasks.length === 0) return;
    const h = window.setInterval(() => force(), 1000);
    return () => window.clearInterval(h);
  }, [tasks.length]);

  // Arrow-nav while expanded — Left/Right cycle through running chips.
  useEffect(() => {
    if (!expandedTaskId || tasks.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target && (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      if (e.target && (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const idx = tasks.findIndex(t => t.taskId === expandedTaskId);
      if (idx < 0) return;
      const next = e.key === 'ArrowLeft'
        ? (idx - 1 + tasks.length) % tasks.length
        : (idx + 1) % tasks.length;
      onSelect(tasks[next].taskId);
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expandedTaskId, tasks, onSelect]);

  // Sort by start time so order stays stable (newest first feels right for
  // "what did I just launch"). No completed/finished interleaving anymore.
  const sorted = useMemo(() => [...tasks].sort((a, b) => b.startedAt - a.startedAt), [tasks]);

  if (sorted.length === 0) return null;

  return (
    <div
      className="flex items-stretch overflow-x-auto shrink-0"
      style={{ borderTop: '1px solid #2a2a2a', background: '#141414' }}
    >
      {sorted.map((t, i) => {
        const expanded = t.taskId === expandedTaskId;
        const Icon = t.kind === 'bash' ? TerminalIcon : Bot;
        return (
          <React.Fragment key={t.taskId}>
            {i > 0 && (
              <span
                aria-hidden
                className="self-stretch shrink-0"
                style={{ width: 1, background: '#2a2a2a', margin: '4px 0' }}
              />
            )}
            <button
              type="button"
              onClick={() => onSelect(expanded ? null : t.taskId)}
              onMouseDown={(e) => e.preventDefault()}
              className="group inline-flex items-center gap-1.5 px-2.5 py-1 text-[0.85em] font-mono shrink-0 cursor-pointer transition-colors"
              style={{
                background: expanded ? 'rgba(217, 119, 6, 0.10)' : 'transparent',
                color: '#bdbdbd',
                minHeight: 22,
              }}
              onMouseEnter={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
              onMouseLeave={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              title={t.description || t.summary || t.name}
            >
              <StatusDot />
              <Icon size={11} style={{ color: '#d97706' }} />
              <span className="truncate max-w-[200px]">{t.name}</span>
              {t.lastToolName && (
                <span className="text-[0.85em] text-[#888] truncate max-w-[120px]">· {t.lastToolName}</span>
              )}
              <span className="text-[0.85em] text-[#666] tabular-nums">{formatElapsed(t)}</span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
