import React, { useEffect, useMemo, useRef } from 'react';
import { useWorkspaceStore, type BgTask } from '../../../store/useWorkspaceStore';
import { Terminal as TerminalIcon, Bot, Workflow as WorkflowIcon } from 'lucide-react';

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
      className="inline-block w-[6px] h-[6px] rounded-full shrink-0 noted-infinite-animation"
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
  // Bar surfaces ONLY running tasks (incl. workflows — a workflow is a one-line
  // chip here, and expands into WorkflowPanel only when selected). Completed/
  // failed/stopped fall back into chat history. Once a task leaves 'running'
  // its chip disappears.
  const tasks = useMemo(
    () => allTasks.filter(t => t.status === 'running'),
    [allTasks],
  );

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

  // Sort by start time (newest first). Workflows and standalone tasks share the
  // strip; the workflow chip carries a `workflow` prefix so it's recognisable.
  const sorted = useMemo(() => [...tasks].sort((a, b) => b.startedAt - a.startedAt), [tasks]);

  // Keyboard: ArrowDown FROM the composer textarea jumps focus to the FIRST
  // chip (so the user can ↓ off the input straight onto a running task);
  // Enter on a focused chip expands it. Uses e.code so it's layout-independent.
  // Only when NOT already expanded — once expanded, WorkflowPanel/TaskDetailPane
  // own the keyboard. Refs to the chip buttons let us focus the first one.
  const firstChipRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (expandedTaskId || sorted.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'ArrowDown') return;
      const el = e.target as HTMLElement | null;
      // Only hijack ArrowDown when the caret is at the END of the composer
      // textarea (so normal down-arrow within multi-line text still works).
      if (el && el.tagName === 'TEXTAREA') {
        const ta = el as HTMLTextAreaElement;
        const atEnd = ta.selectionStart === ta.value.length && ta.selectionStart === ta.selectionEnd;
        if (!atEnd) return;
        firstChipRef.current?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expandedTaskId, sorted.length]);

  if (sorted.length === 0) return null;

  return (
    <div
      className="flex items-stretch overflow-x-auto shrink-0"
      style={{ borderTop: '1px solid #2a2a2a', background: '#141414' }}
    >
      {sorted.map((t, i) => {
        const expanded = t.taskId === expandedTaskId;
        const isWorkflow = t.kind === 'workflow';
        const Icon = isWorkflow ? WorkflowIcon : t.kind === 'bash' ? TerminalIcon : Bot;
        const accent = isWorkflow ? '#a78bfa' : '#d97706';
        const agentCount = isWorkflow ? (t.agents?.length || 0) : 0;
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
              ref={i === 0 ? firstChipRef : undefined}
              onClick={() => onSelect(expanded ? null : t.taskId)}
              onMouseDown={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                // Layout-independent (e.code): Enter/Space expand; arrows move
                // focus between chips; Escape returns focus implicitly (blur).
                if (e.code === 'Enter' || e.code === 'Space') {
                  onSelect(expanded ? null : t.taskId); e.preventDefault();
                } else if (e.code === 'ArrowRight' || e.code === 'ArrowDown') {
                  const next = (e.currentTarget.parentElement?.parentElement
                    ?.querySelectorAll('button')[i + 1]) as HTMLButtonElement | undefined;
                  next?.focus(); e.preventDefault();
                } else if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
                  const btns = e.currentTarget.parentElement?.parentElement?.querySelectorAll('button');
                  const prev = btns && i > 0 ? (btns[i - 1] as HTMLButtonElement) : undefined;
                  prev?.focus(); e.preventDefault();
                }
              }}
              className="group inline-flex items-center gap-1.5 px-2.5 py-1 text-[0.85em] font-mono shrink-0 cursor-pointer transition-colors outline-none focus:ring-1 focus:ring-inset"
              style={{
                background: expanded ? (isWorkflow ? 'rgba(167,139,250,0.12)' : 'rgba(217, 119, 6, 0.10)') : 'transparent',
                color: '#bdbdbd',
                minHeight: 22,
                ['--tw-ring-color' as any]: accent,
              }}
              onMouseEnter={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
              onMouseLeave={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              title={t.description || t.summary || t.name}
            >
              <StatusDot />
              <Icon size={11} style={{ color: accent }} />
              {isWorkflow && (
                <span className="uppercase tracking-wider text-[0.8em] font-semibold" style={{ color: accent }}>workflow</span>
              )}
              <span className="truncate max-w-[200px]">{t.name}</span>
              {isWorkflow && agentCount > 0 && (
                <span className="text-[0.85em] text-[#888]">· {agentCount} agent{agentCount === 1 ? '' : 's'}</span>
              )}
              {!isWorkflow && t.lastToolName && (
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
