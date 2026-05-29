import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore, type BgTask, type WorkflowAgent } from '../../../store/useWorkspaceStore';
import { CheckCircle2, Circle, Loader2, XCircle, X as XIcon } from 'lucide-react';

// ============================================================================
// WorkflowPanel — renders a dynamic workflow (SDK 0.3.156 local_workflow) the
// way Claude Code's /workflows TUI does: a phase-grouped agents column + a
// per-agent detail pane + a bottom hotkey legend.
//
// GROUND TRUTH (captured from a real run, the .d.ts does NOT declare this):
// the whole tree lives in task_progress.workflow_progress[], already parsed and
// merged onto the single workflow BgTask as `phases` + `agents` (see store +
// ClaudeSDKTab handleMessage). This component is a pure view over those arrays.
//
// Hotkeys are layout-independent (e.code, not e.key) so they work on RU/EN/any
// keyboard while a workflow is open: x = stop selected agent, esc = close.
// There is intentionally NO arrow-nav between agents (removed per request) —
// selection is by click.
// ============================================================================

const PANE_HEIGHT = 320;

function useWorkflowTask(tabId: string, taskId: string): BgTask | null {
  return useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      const bt = t?.bgTasks?.find(b => b.taskId === taskId);
      if (bt) return bt;
    }
    return null;
  });
}

function fmtElapsed(startedAt: number, endedAt?: number): string {
  const ms = Math.max(0, (endedAt || Date.now()) - startedAt);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
}

function fmtTokens(n?: number): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function StatusGlyph({ state }: { state: WorkflowAgent['state'] }) {
  if (state === 'done') return <CheckCircle2 size={13} style={{ color: '#4ade80' }} />;
  if (state === 'error') return <XCircle size={13} style={{ color: '#ef4444' }} />;
  if (state === 'progress') return <Loader2 size={13} className="animate-spin" style={{ color: '#d97706' }} />;
  return <Circle size={13} style={{ color: '#888' }} />; // 'start' / queued
}

function modelLabel(raw?: string): string {
  if (!raw) return '';
  const s = raw.toLowerCase();
  const family = s.includes('opus') ? 'Opus' : s.includes('sonnet') ? 'Sonnet' : s.includes('haiku') ? 'Haiku' : '';
  if (!family) return raw;
  const v = s.match(/-(\d+)[-.](\d+)/);
  const ver = v ? `${v[1]}.${v[2]}` : '';
  const is1M = /\[1m\]/.test(s) || (family === 'Opus' && ver !== '' && ver !== '4.5' && ver !== '4.6' && ver !== '4.7');
  return `${family}${ver ? ' ' + ver : ''}${is1M ? ' (1M context)' : ''}`;
}

interface WorkflowPanelProps {
  tabId: string;
  taskId: string;
  onStopTask: (taskId: string) => void;
  onClose: () => void;
}

export function WorkflowPanel({ tabId, taskId, onStopTask, onClose }: WorkflowPanelProps) {
  const workflow = useWorkflowTask(tabId, taskId);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const agents = workflow?.agents || [];
  const phases = workflow?.phases || [];
  const anyRunning = workflow?.status === 'running' && agents.some(a => a.state === 'progress' || a.state === 'start');

  // 1s tick for live elapsed.
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!anyRunning) return;
    const h = window.setInterval(() => force(), 1000);
    return () => window.clearInterval(h);
  }, [anyRunning]);

  // Default selection = first running agent, else first.
  useEffect(() => {
    if (selectedIndex != null && agents.some(a => a.index === selectedIndex)) return;
    const running = agents.find(a => a.state === 'progress');
    setSelectedIndex((running || agents[0])?.index ?? null);
  }, [agents, selectedIndex]);

  // Hotkeys — LAYOUT INDEPENDENT via e.code. Works on RU/EN/any layout:
  //   KeyX → stop the selected agent (only if it's still running)
  //   Escape → close the panel
  // No arrow-nav between agents (removed per request). Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) {
        // still allow Escape to close even from a focused field
        if (e.code !== 'Escape') return;
      }
      if (e.code === 'Escape') { onClose(); e.preventDefault(); return; }
      if (e.code === 'KeyX') {
        const sel = agents.find(a => a.index === selectedIndex);
        // stopTask wants the agentId; fall back to the workflow taskId if the
        // agent hasn't been assigned one yet (stops the whole workflow).
        if (sel && (sel.state === 'progress' || sel.state === 'start')) {
          onStopTask(sel.agentId || taskId);
          e.preventDefault();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [agents, selectedIndex, onStopTask, onClose, taskId]);

  // Keep selected row in view.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = listRef.current?.querySelector(`[data-agent-index="${selectedIndex}"]`) as HTMLElement | null;
    node?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Group agents by phase (phaseIndex). Agents without a phase fall under a
  // synthetic "—" bucket so nothing is dropped.
  const grouped = useMemo(() => {
    const byPhase = new Map<number, WorkflowAgent[]>();
    for (const a of agents) {
      const k = a.phaseIndex ?? 0;
      if (!byPhase.has(k)) byPhase.set(k, []);
      byPhase.get(k)!.push(a);
    }
    const orderedPhaseIndices = [...byPhase.keys()].sort((x, y) => x - y);
    return orderedPhaseIndices.map(pi => ({
      phaseIndex: pi,
      title: phases.find(p => p.index === pi)?.title || (pi === 0 ? '' : `Phase ${pi}`),
      agents: byPhase.get(pi)!,
    }));
  }, [agents, phases]);

  if (!workflow) return null;

  const selected = agents.find(a => a.index === selectedIndex) || null;
  const doneCount = agents.filter(a => a.state === 'done').length;

  return (
    <div
      className="flex flex-col shrink-0"
      style={{ height: PANE_HEIGHT, borderTop: '1px solid #2a2a2a', background: '#141414' }}
    >
      {/* Workflow header */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 shrink-0"
        style={{ borderBottom: '1px solid #2a2a2a', background: '#1a1a1a' }}
      >
        <span className="text-[0.7em] font-mono font-semibold uppercase tracking-wider" style={{ color: '#a78bfa' }}>
          Workflow
        </span>
        <span className="text-[0.92em] font-mono font-semibold truncate" style={{ color: '#e8e8e8' }}>
          {workflow.workflowName || workflow.name}
        </span>
        <span className="text-[0.8em] font-mono text-[#888] shrink-0">
          · {agents.length} agent{agents.length === 1 ? '' : 's'}
        </span>
        <span className="text-[0.8em] font-mono text-[#666] tabular-nums shrink-0">
          · {fmtElapsed(workflow.startedAt, workflow.endedAt)}
        </span>
        <span className="flex-1" />
        <span className="text-[0.77em] font-mono text-[#666] tabular-nums shrink-0">
          {doneCount}/{agents.length}
        </span>
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

      {/* Body: phase-grouped agents column | detail */}
      <div className="flex-1 min-h-0 flex">
        <div
          ref={listRef}
          className="w-[240px] shrink-0 overflow-y-auto py-1"
          style={{ borderRight: '1px solid #2a2a2a' }}
        >
          {agents.length === 0 && (
            <div className="px-3 py-2 text-[0.8em] font-mono text-[#666] italic">
              {workflow.status === 'running' ? 'starting…' : 'no agents'}
            </div>
          )}
          {grouped.map(group => (
            <div key={group.phaseIndex} className="mb-1">
              {group.title && (
                <div className="px-3 pt-1.5 pb-0.5 text-[0.7em] font-mono uppercase tracking-wider text-[#777]">
                  {group.phaseIndex}. {group.title}
                </div>
              )}
              {group.agents.map(a => {
                const sel = a.index === selectedIndex;
                return (
                  <button
                    key={a.index}
                    data-agent-index={a.index}
                    type="button"
                    onClick={() => setSelectedIndex(a.index)}
                    onMouseDown={(e) => e.preventDefault()}
                    className="group w-full flex items-center gap-2 pl-3 pr-2 py-1 text-left font-mono text-[0.85em] cursor-pointer transition-colors"
                    style={{
                      background: sel ? 'rgba(167,139,250,0.10)' : 'transparent',
                      color: sel ? '#e8e8e8' : '#bdbdbd',
                    }}
                    onMouseEnter={(e) => { if (!sel) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
                    onMouseLeave={(e) => { if (!sel) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <span className="w-2 shrink-0" style={{ color: '#a78bfa' }}>{sel ? '❯' : ''}</span>
                    <StatusGlyph state={a.state} />
                    <span className="truncate flex-1">{a.label}</span>
                    {typeof a.tokens === 'number' && a.tokens > 0 && (
                      <span className="text-[0.85em] text-[#666] tabular-nums shrink-0">{fmtTokens(a.tokens)}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Detail */}
        <div className="flex-1 min-w-0 overflow-y-auto px-4 py-2 font-mono text-[0.85em]" style={{ color: '#bdbdbd' }}>
          {!selected ? (
            <div className="h-full flex items-center justify-center text-[#666] italic">
              {agents.length === 0 ? 'Waiting for agents…' : 'Select an agent'}
            </div>
          ) : (
            <AgentDetail agent={selected} />
          )}
        </div>
      </div>

      {/* Bottom hotkey legend — layout-independent keys */}
      <div
        className="flex items-center gap-3 px-3 py-1 shrink-0 text-[0.75em] font-mono italic"
        style={{ borderTop: '1px solid #2a2a2a', background: '#161616', color: '#777' }}
      >
        <Legend k="x" label="stop" />
        <Legend k="esc" label="back" />
      </div>
    </div>
  );
}

function Legend({ k, label }: { k: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className="px-1 rounded text-[0.95em] not-italic" style={{ background: '#2a2a2a', color: '#bdbdbd' }}>{k}</kbd>
      <span>{label}</span>
    </span>
  );
}

// ----------------------------------------------------------------------------
// AgentDetail — right pane: Status / model / tokens / tool calls, Prompt
// (collapsible), Result. All from the workflow_progress agent record.
// ----------------------------------------------------------------------------
function AgentDetail({ agent }: { agent: WorkflowAgent }) {
  const statusText = agent.state === 'progress' ? 'Running'
    : agent.state === 'done' ? 'Done'
    : agent.state === 'error' ? 'Error'
    : 'Queued';
  const statusColor = agent.state === 'progress' ? '#d97706'
    : agent.state === 'done' ? '#4ade80'
    : agent.state === 'error' ? '#ef4444'
    : '#888';

  const ml = modelLabel(agent.model);
  const promptLines = (agent.promptPreview || '').split('\n');
  const [promptOpen, setPromptOpen] = useState(false);
  const previewLines = promptOpen ? promptLines : promptLines.slice(0, 3);
  const hiddenCount = promptLines.length - previewLines.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <StatusGlyph state={agent.state} />
        <span className="text-[1.05em] font-semibold" style={{ color: '#e8e8e8' }}>{agent.label}</span>
        {agent.phaseTitle && <span className="text-[#666]">· {agent.phaseTitle}</span>}
      </div>

      <div className="flex items-center gap-2 flex-wrap" style={{ color: statusColor }}>
        <span className="font-semibold">{statusText}</span>
        {ml && <span className="text-[#888]">· {ml}</span>}
        <span className="text-[#888] tabular-nums">· {fmtTokens(agent.tokens)} tok</span>
        {typeof agent.toolCalls === 'number' && (
          <span className="text-[#888] tabular-nums">· {agent.toolCalls} tool call{agent.toolCalls === 1 ? '' : 's'}</span>
        )}
        {agent.lastToolName && agent.state === 'progress' && (
          <span className="text-[#888]">→ {agent.lastToolName}{agent.lastToolSummary ? `(${agent.lastToolSummary})` : ''}</span>
        )}
      </div>

      {promptLines.length > 0 && promptLines[0] && (
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-semibold text-[#999]">Prompt</span>
            <span className="text-[#666]">· {promptLines.length} line{promptLines.length === 1 ? '' : 's'}</span>
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setPromptOpen(o => !o)}
                onMouseDown={(e) => e.preventDefault()}
                className="text-[#a78bfa] hover:underline cursor-pointer not-italic"
              >
                {promptOpen ? 'collapse' : 'expand'}
              </button>
            )}
          </div>
          <pre className="whitespace-pre-wrap break-words text-[#9a9a9a] leading-snug" style={{ margin: 0 }}>
            {previewLines.join('\n')}
            {!promptOpen && hiddenCount > 0 && <span className="text-[#666]">{`\n… ${hiddenCount} more lines`}</span>}
          </pre>
        </div>
      )}

      <div>
        <div className="font-semibold text-[#999] mb-0.5">Outcome</div>
        <div className="text-[#9a9a9a] whitespace-pre-wrap break-words">
          {agent.resultPreview
            ? agent.resultPreview
            : agent.state === 'done' ? 'Done.'
            : agent.state === 'error' ? 'Failed.'
            : 'Still running…'}
        </div>
      </div>
    </div>
  );
}
