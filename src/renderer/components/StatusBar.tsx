import React, { useRef, useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { History, Pin, Settings } from 'lucide-react';
import { useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import type { CodexModelOption } from '../constants/codexSettings';
import {
  CODEX_EFFORT_LEVELS,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL_OPTIONS,
  mergeCodexModelOptions,
} from '../constants/codexSettings';
import { usePromptsStore } from '../store/usePromptsStore';
import { useCmdKey } from '../hooks/useCmdHoverPopover';
import { CUSTOM_ICONS } from '../assets/icons/registry';

const { ipcRenderer } = window.require('electron');
const CODEX_ICON_URL = new URL('../assets/icons/codex-color.svg', import.meta.url).href;

// VSCode-style status bar pinned to the bottom of the app.
// Currently hosts development toggles, a default-effort selector,
// an invalid-paths counter for AI prompt attachments, and a settings cog.
// Will grow to include git/branch/lints/etc.
// Right side is reserved for less-frequent toggles (debug, defaults).
interface StatusBarProps {
  onOpenSettings?: () => void;
}

export default function StatusBar({ onOpenSettings }: StatusBarProps) {
  const debugHoverBridges = useUIStore((s) => s.debugHoverBridges);
  const setDebugHoverBridges = useUIStore((s) => s.setDebugHoverBridges);
  const streamerMode = useUIStore((s) => s.streamerMode);
  const setStreamerMode = useUIStore((s) => s.setStreamerMode);
  const freezeCmdPopups = useUIStore((s) => s.freezeCmdPopups);
  const setFreezeCmdPopups = useUIStore((s) => s.setFreezeCmdPopups);
  const historyPinned = useUIStore((s) => s.historyPinned);
  const setHistoryPinned = useUIStore((s) => s.setHistoryPinned);
  const timelinePinned = useUIStore((s) => s.timelinePinned);
  const setTimelinePinned = useUIStore((s) => s.setTimelinePinned);
  const freePortsBeforeStart = useUIStore((s) => s.freePortsBeforeStart);
  const setFreePortsBeforeStart = useUIStore((s) => s.setFreePortsBeforeStart);
  const defaultClaudeEffort = useUIStore((s) => s.defaultClaudeEffort);
  const setDefaultClaudeEffort = useUIStore((s) => s.setDefaultClaudeEffort);
  const defaultClaudeModel = useUIStore((s) => s.defaultClaudeModel);
  const setDefaultClaudeModel = useUIStore((s) => s.setDefaultClaudeModel);
  const claudeCodeSettings = useUIStore((s) => s.claudeCodeSettings);
  const defaultCodexModel = useUIStore((s) => s.defaultCodexModel);
  const setDefaultCodexModel = useUIStore((s) => s.setDefaultCodexModel);
  const defaultCodexEffort = useUIStore((s) => s.defaultCodexEffort);
  const setDefaultCodexEffort = useUIStore((s) => s.setDefaultCodexEffort);
  const codexSettings = useUIStore((s) => s.codexSettings);
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>(DEFAULT_CODEX_MODEL_OPTIONS);

  useEffect(() => {
    let cancelled = false;
    ipcRenderer.invoke('codex:list-models').then((res: any) => {
      if (cancelled) return;
      setCodexModels(mergeCodexModelOptions(res?.models, codexSettings.models));
    }).catch(() => {
      if (!cancelled) setCodexModels(mergeCodexModelOptions(DEFAULT_CODEX_MODEL_OPTIONS, codexSettings.models));
    });
    return () => { cancelled = true; };
  }, [codexSettings.models]);

  const activeCodexModel = codexModels.find((m) => m.id === defaultCodexModel) || codexModels[0];
  const codexEfforts = activeCodexModel?.efforts?.length ? activeCodexModel.efforts : [...CODEX_EFFORT_LEVELS];
  const setDefaultCodexModelWithEffort = (model: string) => {
    setDefaultCodexModel(model);
    if (model === 'none' || defaultCodexEffort === 'none') return;
    const nextModel = codexModels.find((m) => m.id === model);
    const efforts = nextModel?.efforts?.length ? nextModel.efforts : [...CODEX_EFFORT_LEVELS];
    if (efforts.includes(defaultCodexEffort)) return;
    const fallback = (nextModel?.defaultEffort && efforts.includes(nextModel.defaultEffort))
      ? nextModel.defaultEffort
      : (efforts.includes(DEFAULT_CODEX_EFFORT) ? DEFAULT_CODEX_EFFORT : efforts[0]);
    if (fallback) setDefaultCodexEffort(fallback);
  };

  return (
    <div
      className="flex items-center justify-between select-none border-t border-[#222] bg-[#1a1a1a]"
      style={{
        height: 24,
        flexShrink: 0,
        color: '#888',
        paddingLeft: 6,
        paddingRight: 6,
        fontSize: 12,
      }}
    >
      <div className="flex items-center gap-3">
        <McpActivityChip />
        <StatusToggle
          label="stream"
          title="Скрыть публичный remote-control URL/IP в интерфейсе на время стрима."
          active={streamerMode}
          onClick={() => setStreamerMode(!streamerMode)}
          activeColor="#38bdf8"
        />
        <WebServerChip hidden={streamerMode} />
      </div>
      <div className="flex items-center gap-2">
        <EngineDefaultsSelector
          engine="Claude"
          accent="#DA7756"
          icon={CUSTOM_ICONS.claude}
          modelValue={defaultClaudeModel}
          modelOptions={claudeCodeSettings.models}
          effortValue={defaultClaudeEffort}
          effortOptions={claudeCodeSettings.efforts}
          onModelChange={setDefaultClaudeModel}
          onEffortChange={setDefaultClaudeEffort}
        />
        <EngineDefaultsSelector
          engine="Codex"
          accent="#7A9DFF"
          icon={<img src={CODEX_ICON_URL} alt="" style={{ width: '100%', height: '100%', display: 'block' }} />}
          modelValue={defaultCodexModel}
          modelOptions={codexModels}
          effortValue={defaultCodexEffort}
          effortOptions={codexEfforts}
          onModelChange={setDefaultCodexModelWithEffort}
          onEffortChange={setDefaultCodexEffort}
        />
        <StatusToggle
          label="kill dev-ports"
          title="Если ВКЛ — перед каждым запуском npm-скрипта / restart / stop сначала убиваются занятые порты проекта (vite/backend), считанные из vite.config / .env / NestJS main.ts. Защита от 'address in use' после крашей."
          active={freePortsBeforeStart}
          onClick={() => setFreePortsBeforeStart(!freePortsBeforeStart)}
          activeColor="#4ade80"
        />
        <StatusToggle
          label="bridges"
          title="Подсвечивать невидимые «hover-мосты» между триггером и popup'ом красным цветом."
          active={debugHoverBridges}
          onClick={() => setDebugHoverBridges(!debugHoverBridges)}
          activeColor="#ef4444"
        />
        <InvalidPathsChip onOpenSettings={onOpenSettings} />
        <HistoryTimelinePinToggle
          historyPinned={historyPinned}
          timelinePinned={timelinePinned}
          onToggleHistory={() => setHistoryPinned(!historyPinned)}
          onToggleTimeline={() => setTimelinePinned(!timelinePinned)}
        />
        <StatusToggle
          label="freeze tooltips"
          title="ВКЛ: Cmd-tooltip / note / fork popup'ы НЕ закрываются при уходе курсора и отпускании Cmd — для инспекции их DOM в devtools."
          active={freezeCmdPopups}
          onClick={() => setFreezeCmdPopups(!freezeCmdPopups)}
          activeColor="#fbbf24"
        />
        <SettingsButton onClick={onOpenSettings} />
      </div>
    </div>
  );
}

type McpActivitySource = {
  server?: string;
  mode?: string;
  projectId?: string;
  tabId?: string;
  cwd?: string;
};

type McpActivityEvent = {
  id: string;
  at: number;
  action: string;
  status: string;
  tabId?: string;
  targetProjectId?: string;
  targetCwd?: string;
  targetName?: string;
  engine?: string;
  mode?: string;
  sessionId?: string | null;
  commandPreview?: string;
  promptChars?: number;
  stepCount?: number;
  error?: string;
  sourceMeta?: McpActivitySource | null;
};

const MCP_ACTIVE_STATUSES = new Set(['running', 'creating', 'sending', 'pasting']);

function McpActivityChip() {
  const [events, setEvents] = useState<McpActivityEvent[]>([]);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onActivity = (_: unknown, raw: McpActivityEvent) => {
      if (!raw?.id || !raw.action) return;
      const next: McpActivityEvent = { ...raw, at: raw.at || Date.now() };
      setEvents(prev => {
        const existing = prev.find(e => e.id === next.id);
        const merged = existing ? { ...existing, ...next } : next;
        const rest = prev.filter(e => e.id !== next.id);
        return [merged, ...rest].slice(0, 20);
      });
    };
    ipcRenderer.on('terminal:mcp-activity', onActivity);
    return () => ipcRenderer.removeListener('terminal:mcp-activity', onActivity);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return;
      if (popupRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const latest = events[0];
  const hasActive = events.some(e => MCP_ACTIVE_STATUSES.has(e.status));
  const dotColor = hasActive ? '#f59e0b' : latest ? statusColor(latest.status) : '#444';
  const chipTitle = latest
    ? `${actionLabel(latest.action)}: ${latest.status}`
    : 'Нет управляющих terminal MCP вызовов в этой сессии UI';

  return (
    <>
      <button
        ref={chipRef}
        onClick={() => setOpen(v => !v)}
        title={chipTitle}
        className="inline-flex items-center gap-1 cursor-pointer hover:bg-white/5 rounded"
        style={{ padding: '1px 6px', height: 18 }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: dotColor,
            boxShadow: hasActive ? '0 0 7px rgba(245, 158, 11, 0.7)' : 'none',
            transition: 'background-color 0.15s, box-shadow 0.15s',
          }}
        />
        <span style={{ color: latest ? '#ddd' : '#666' }}>MCP</span>
        {latest && (
          <span style={{ color: hasActive ? '#fbbf24' : '#777', maxWidth: 86, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {actionLabel(latest.action)}
          </span>
        )}
      </button>
      {open && chipRef.current && createPortal(
        <McpActivityPopup
          chipRect={chipRef.current.getBoundingClientRect()}
          popupRef={popupRef}
          events={events}
          onFocusTarget={(event) => { focusMcpTarget(event); setOpen(false); }}
        />,
        document.body
      )}
    </>
  );
}

function McpActivityPopup({ chipRect, popupRef, events, onFocusTarget }: {
  chipRect: DOMRect;
  popupRef: React.RefObject<HTMLDivElement | null>;
  events: McpActivityEvent[];
  onFocusTarget: (event: McpActivityEvent) => void;
}) {
  return (
    <div
      ref={popupRef}
      style={{
        position: 'fixed',
        left: Math.max(6, Math.min(chipRect.left, window.innerWidth - 430)),
        bottom: window.innerHeight - chipRect.top + 4,
        zIndex: 10010,
      }}
    >
      <div
        className="bg-[#1a1a1a] border border-[#444] rounded shadow-2xl"
        style={{ width: 420, maxHeight: 360, overflow: 'hidden', boxShadow: '0 -8px 24px rgba(0,0,0,0.5)' }}
      >
        <div className="flex items-center justify-between border-b border-[#333]" style={{ padding: '8px 10px' }}>
          <span style={{ color: '#ddd', fontWeight: 700, fontSize: 11, letterSpacing: 0.4 }}>TERMINAL MCP</span>
          <span style={{ color: '#666', fontSize: 11 }}>{events.length ? `${events.length} events` : 'idle'}</span>
        </div>
        {events.length === 0 ? (
          <div style={{ padding: 12, color: '#777', fontSize: 12 }}>
            Управляющих вызовов пока не было. Пассивные чтения истории и списка вкладок здесь не показываются.
          </div>
        ) : (
          <div style={{ maxHeight: 310, overflowY: 'auto', padding: 6 }}>
            {events.map(event => {
              const canFocus = !!(event.tabId || event.targetProjectId || event.targetCwd);
              return (
                <button
                  key={event.id}
                  onClick={() => canFocus && onFocusTarget(event)}
                  disabled={!canFocus}
                  className="w-full text-left rounded"
                  style={{
                    border: 'none',
                    outline: 'none',
                    padding: '7px 8px',
                    marginBottom: 4,
                    background: MCP_ACTIVE_STATUSES.has(event.status) ? 'rgba(245, 158, 11, 0.12)' : 'rgba(255,255,255,0.03)',
                    color: canFocus ? '#ddd' : '#888',
                    cursor: canFocus ? 'pointer' : 'default',
                  }}
                >
                  <div className="flex items-center justify-between" style={{ gap: 8 }}>
                    <span style={{ color: statusColor(event.status), fontWeight: 700, fontSize: 12 }}>
                      {actionLabel(event.action)} · {event.status}
                    </span>
                    <span style={{ color: '#666', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>{timeLabel(event.at)}</span>
                  </div>
                  <div style={{ color: '#999', fontSize: 11, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {targetLabel(event)}
                  </div>
                  <div style={{ color: '#666', fontSize: 11, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    from {sourceLabel(event.sourceMeta)}
                    {event.engine ? ` · ${event.engine}` : ''}
                    {event.mode ? `/${event.mode}` : ''}
                    {typeof event.promptChars === 'number' ? ` · ${event.promptChars} chars` : ''}
                    {typeof event.stepCount === 'number' ? ` · ${event.stepCount} steps` : ''}
                    {event.commandPreview ? ` · ${event.commandPreview}` : ''}
                  </div>
                  {event.error && (
                    <div style={{ color: '#ef4444', fontSize: 11, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {event.error}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

async function focusMcpTarget(event: McpActivityEvent) {
  const store = useWorkspaceStore.getState();
  let projectId = event.targetProjectId || '';

  if (!projectId && event.tabId) {
    for (const [pid, ws] of store.openProjects) {
      if (ws.tabs.has(event.tabId)) {
        projectId = pid;
        break;
      }
    }
  }

  if (!projectId && event.targetCwd) {
    let bestLen = -1;
    for (const [pid, ws] of store.openProjects) {
      const projectPath = ws.projectPath;
      if (!projectPath || projectPath.startsWith('__unset__')) continue;
      if (event.targetCwd === projectPath || event.targetCwd.startsWith(projectPath + '/')) {
        if (projectPath.length > bestLen) {
          bestLen = projectPath.length;
          projectId = pid;
        }
      }
    }
  }

  if (!projectId) return;
  const latest = useWorkspaceStore.getState();
  if (!latest.openProjects.has(projectId) && event.targetCwd) {
    await Promise.resolve((latest.openProject as any)(projectId, event.targetCwd, { background: false }));
  } else {
    latest.showWorkspace(projectId);
  }
  const after = useWorkspaceStore.getState();
  after.setProjectView(projectId, 'terminal');
  if (event.tabId) after.switchTab(projectId, event.tabId);
}

function actionLabel(action: string): string {
  switch (action) {
    case 'create_tab': return 'create';
    case 'run_command': return 'run';
    case 'restart_process': return 'restart';
    case 'kill_process': return 'kill';
    case 'send_prompt': return 'prompt';
    case 'start_ai': return 'start AI';
    case 'stop_ai': return 'stop AI';
    case 'run_chain': return 'chain';
    default: return action.replace(/^terminal:/, '');
  }
}

function statusColor(status: string): string {
  if (MCP_ACTIVE_STATUSES.has(status)) return '#f59e0b';
  if (status === 'error' || status === 'not_stopped' || status === 'completed_with_errors') return '#ef4444';
  if (status === 'sent' || status === 'started' || status === 'stopped' || status === 'completed' || status === 'killed' || status === 'restarted' || status === 'pasted' || status === 'requested') return '#22c55e';
  return '#888';
}

function targetLabel(event: McpActivityEvent): string {
  const target = event.targetName || event.tabId || event.targetProjectId || event.targetCwd || 'unknown target';
  const project = event.targetProjectId ? `project ${shortId(event.targetProjectId)}` : '';
  const tab = event.tabId ? `tab ${shortId(event.tabId)}` : '';
  return [target, project, tab].filter(Boolean).join(' · ');
}

function sourceLabel(source?: McpActivitySource | null): string {
  if (!source) return 'unknown';
  const mode = source.mode || 'unknown';
  const tab = source.tabId ? ` tab ${shortId(source.tabId)}` : '';
  const project = source.projectId ? ` project ${shortId(source.projectId)}` : '';
  const cwd = source.cwd ? ` ${source.cwd}` : '';
  return `${source.server || 'terminal'}:${mode}${project}${tab}${cwd}`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Counter of broken file paths attached to AI prompts (+ doc-prompt file, if it's used).
// Subscribes to usePromptsStore so it recomputes on save/delete; rechecks disk via
// `ai-prompts:check-paths` IPC with a 300ms debounce. Click → opens Settings (caller
// can route to the AI tab; we just open the modal for now).
function InvalidPathsChip({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const prompts = usePromptsStore((s) => s.prompts);
  const isLoaded = usePromptsStore((s) => s.isLoaded);
  const docPrompt = useUIStore((s) => s.docPrompt);
  const [missing, setMissing] = useState<string[]>([]);

  // Flat list of every absolute path we care about (prompts × filePaths + docPrompt.filePath
  // if useFile is on). useMemo with JSON serialization gives a stable string dependency for
  // useEffect — Zustand returns new array references on every set, but the actual content
  // changes rarely. This avoids re-running the check on unrelated store mutations.
  const allPathsKey = useMemo(() => {
    const paths: string[] = [];
    for (const p of prompts) {
      if (Array.isArray(p.filePaths)) {
        for (const fp of p.filePaths) if (typeof fp === 'string' && fp.trim()) paths.push(fp);
      }
    }
    if (docPrompt?.useFile && docPrompt.filePath?.trim()) paths.push(docPrompt.filePath);
    return JSON.stringify(paths);
  }, [prompts, docPrompt]);

  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    const paths: string[] = JSON.parse(allPathsKey);
    if (paths.length === 0) { setMissing([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await ipcRenderer.invoke('ai-prompts:check-paths', paths);
        if (!cancelled && res?.success) setMissing(res.missing || []);
      } catch (e) {
        if (!cancelled) setMissing([]);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [allPathsKey, isLoaded]);

  if (missing.length === 0) return null;

  return (
    <button
      onClick={onOpenSettings}
      className="inline-flex items-center cursor-pointer rounded"
      style={{
        gap: 4,
        padding: '0 8px',
        height: 20,
        backgroundColor: 'rgba(218, 119, 86, 0.12)',
        color: '#DA7756',
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 600,
        border: 'none',
        outline: 'none',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(218, 119, 86, 0.22)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(218, 119, 86, 0.12)'; }}
    >
      <span style={{ fontSize: 13, lineHeight: 1 }}>!</span>
      <span style={{ fontSize: 12 }}>{missing.length}</span>
    </button>
  );
}

function SettingsButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Settings"
      className="inline-flex items-center justify-center cursor-pointer rounded"
      style={{
        width: 22,
        height: 20,
        padding: 0,
        background: 'transparent',
        color: '#bbb',
        border: 'none',
        outline: 'none',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#bbb'; (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
    >
      <Settings size={14} strokeWidth={1.75} />
    </button>
  );
}

const effortLabel = (level: string): string => {
  if (level === 'minimal') return 'min';
  if (level === 'medium') return 'med';
  if (level === 'xhigh') return 'xhi';
  if (level === 'ultracode') return 'ultra';
  return level;
};

const modelLabel = (model: string, options: Array<{ id: string; label?: string }>): string => {
  if (model === 'none') return 'none';
  const found = options.find((m) => m.id === model);
  return found?.label || model;
};

type ModelOptionLike = { id: string; label?: string };

function withNoneOption<T extends { id: string; label?: string }>(
  value: string,
  options: T[]
): ModelOptionLike[] {
  const seen = new Set<string>();
  const result: ModelOptionLike[] = [];
  const push = (option: ModelOptionLike) => {
    if (!option.id || seen.has(option.id)) return;
    seen.add(option.id);
    result.push(option);
  };
  push({ id: 'none', label: 'none' });
  options.forEach((option) => push({ id: option.id, label: option.label }));
  if (value && !seen.has(value)) push({ id: value, label: value });
  return result;
}

function withNoneLevel(value: string, options: string[]): string[] {
  const levels = ['none', ...options.filter(Boolean)];
  return levels.includes(value) ? levels : [...levels, value];
}

function EngineDefaultsSelector({
  engine,
  accent,
  icon,
  modelValue,
  modelOptions,
  effortValue,
  effortOptions,
  onModelChange,
  onEffortChange,
}: {
  engine: string;
  accent: string;
  icon: React.ReactNode;
  modelValue: string;
  modelOptions: ModelOptionLike[];
  effortValue: string;
  effortOptions: string[];
  onModelChange: (v: string) => void;
  onEffortChange: (v: string) => void;
}) {
  const [clicked, setClicked] = useState(false);
  const [chipHover, setChipHover] = useState(false);
  const [popupHover, setPopupHover] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const isCmdPressed = useCmdKey();
  const open = clicked || (isCmdPressed && chipHover) || popupHover;
  const shortModel = modelLabel(modelValue, modelOptions);
  const shortEffort = effortLabel(effortValue);

  useEffect(() => {
    if (!clicked) return;
    const onDown = (e: MouseEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return;
      if (popupRef.current?.contains(e.target as Node)) return;
      setClicked(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [clicked]);

  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => {
      const c = chipRef.current?.getBoundingClientRect();
      const p = popupRef.current?.getBoundingClientRect();
      if (!c || !p) return;
      const { clientX: x, clientY: y } = e;
      const inC = x >= c.left && x <= c.right && y >= c.top && y <= c.bottom;
      const inP = x >= p.left && x <= p.right && y >= p.top && y <= p.bottom;
      const inBridge =
        x >= Math.min(p.left, c.left) - 8 &&
        x <= Math.max(p.right, c.right) + 8 &&
        y >= p.bottom &&
        y <= c.top;
      setChipHover(inC);
      setPopupHover(inP || inBridge);
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [open]);

  return (
    <>
      <button
        ref={chipRef}
        onClick={() => setClicked(!clicked)}
        onMouseEnter={() => setChipHover(true)}
        onMouseLeave={() => setChipHover(false)}
        title={`${engine} defaults: model ${shortModel}, effort ${shortEffort}`}
        className="inline-flex items-center cursor-pointer rounded"
        style={{
          gap: 5,
          padding: '1px 7px',
          height: 20,
          maxWidth: 190,
          border: `1px solid ${open ? accent + '66' : 'rgba(255,255,255,0.08)'}`,
          background: open ? `${accent}16` : 'rgba(255,255,255,0.025)',
          color: '#ddd',
          outline: 'none',
        }}
      >
        <span style={{ width: 14, height: 14, color: accent, display: 'inline-flex', flexShrink: 0 }}>
          {icon}
        </span>
        <span style={{ color: '#ddd', fontWeight: 700, fontSize: 11 }}>{engine}</span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            minWidth: 0,
            overflow: 'hidden',
            fontSize: 11,
          }}
        >
          <span
            style={{
              color: modelValue === 'none' ? '#666' : '#cfcfcf',
              maxWidth: 86,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {shortModel}
          </span>
          <span style={{ color: '#555' }}>/</span>
          <span style={{ color: effortValue === 'none' ? '#666' : accent, fontWeight: 650 }}>
            {shortEffort}
          </span>
        </span>
        <Settings size={11} strokeWidth={1.8} style={{ color: '#777', flexShrink: 0 }} />
      </button>
      {open && chipRef.current && createPortal(
        <EngineDefaultsPopup
          chipRect={chipRef.current.getBoundingClientRect()}
          popupRef={popupRef}
          engine={engine}
          accent={accent}
          icon={icon}
          modelValue={modelValue}
          modelOptions={modelOptions}
          effortValue={effortValue}
          effortOptions={effortOptions}
          onModelSelect={(v) => { onModelChange(v); setClicked(false); setPopupHover(false); }}
          onEffortSelect={(v) => { onEffortChange(v); setClicked(false); setPopupHover(false); }}
          onPopupEnter={() => setPopupHover(true)}
          onPopupLeave={() => setPopupHover(false)}
        />,
        document.body
      )}
    </>
  );
}

function EngineDefaultsPopup({
  chipRect,
  popupRef,
  engine,
  accent,
  icon,
  modelValue,
  modelOptions,
  effortValue,
  effortOptions,
  onModelSelect,
  onEffortSelect,
  onPopupEnter,
  onPopupLeave,
}: {
  chipRect: DOMRect;
  popupRef: React.RefObject<HTMLDivElement | null>;
  engine: string;
  accent: string;
  icon: React.ReactNode;
  modelValue: string;
  modelOptions: ModelOptionLike[];
  effortValue: string;
  effortOptions: string[];
  onModelSelect: (v: string) => void;
  onEffortSelect: (v: string) => void;
  onPopupEnter?: () => void;
  onPopupLeave?: () => void;
}) {
  const models = useMemo(() => withNoneOption(modelValue, modelOptions), [modelValue, modelOptions]);
  const levels = useMemo(() => withNoneLevel(effortValue, effortOptions), [effortValue, effortOptions]);
  const maxWidth = Math.max(300, Math.min(560, window.innerWidth - 12));

  return (
    <div
      ref={popupRef}
      onMouseEnter={onPopupEnter}
      onMouseLeave={onPopupLeave}
      style={{
        position: 'fixed',
        right: Math.max(6, window.innerWidth - chipRect.right),
        bottom: window.innerHeight - chipRect.top + 4,
        paddingBottom: 4,
        zIndex: 10010,
      }}
    >
      <div
        className="bg-[#1a1a1a] border border-[#444] rounded shadow-2xl"
        style={{
          width: 'max-content',
          maxWidth,
          padding: 8,
          boxShadow: '0 -8px 24px rgba(0,0,0,0.5)',
        }}
      >
        <div className="flex items-center justify-between" style={{ gap: 12, marginBottom: 7 }}>
          <div className="flex items-center" style={{ gap: 6 }}>
            <span style={{ width: 16, height: 16, color: accent, display: 'inline-flex', flexShrink: 0 }}>
              {icon}
            </span>
            <span style={{ color: '#e5e5e5', fontSize: 12, fontWeight: 750 }}>{engine} defaults</span>
          </div>
          <span style={{ color: '#666', fontSize: 10 }}>future launches</span>
        </div>

        <EngineOptionRow
          label="Model"
          accent={accent}
          value={modelValue}
          options={models}
          getLabel={(option) => option.label || option.id}
          getKey={(option) => option.id}
          onSelect={(option) => onModelSelect(option.id === modelValue ? 'none' : option.id)}
        />
        <EngineOptionRow
          label="Effort"
          accent={accent}
          value={effortValue}
          options={levels}
          getLabel={effortLabel}
          getKey={(level) => level}
          onSelect={(level) => onEffortSelect(level === effortValue ? 'none' : level)}
        />
      </div>
    </div>
  );
}

function EngineOptionRow<T>({
  label,
  accent,
  value,
  options,
  getLabel,
  getKey,
  onSelect,
}: {
  label: string;
  accent: string;
  value: string;
  options: T[];
  getLabel: (option: T) => string;
  getKey: (option: T) => string;
  onSelect: (option: T) => void;
}) {
  return (
    <div className="flex items-start" style={{ gap: 8, marginTop: 5 }}>
      <span style={{ width: 42, color: '#666', fontSize: 10, paddingTop: 5 }}>{label}</span>
      <div
        className="flex gap-1"
        style={{
          flexWrap: 'wrap',
          maxWidth: 492,
          maxHeight: label === 'Model' ? 132 : 72,
          overflowY: 'auto',
          paddingRight: 1,
        }}
      >
        {options.map((option) => {
          const key = getKey(option);
          const isActive = value === key;
          return (
            <button
              key={key}
              onClick={() => onSelect(option)}
              className="text-[10px] px-1.5 py-1 rounded cursor-pointer"
              style={{
                minWidth: label === 'Model' ? 44 : 32,
                maxWidth: 150,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                background: isActive ? `${accent}33` : '#2d2d2d',
                color: isActive ? '#fff' : '#888',
                border: isActive ? `1px solid ${accent}88` : '1px solid transparent',
                fontWeight: isActive ? 650 : 500,
              }}
              onMouseEnter={(e) => {
                if (isActive) return;
                e.currentTarget.style.background = '#3d3d3d';
                e.currentTarget.style.color = '#fff';
              }}
              onMouseLeave={(e) => {
                if (isActive) return;
                e.currentTarget.style.background = '#2d2d2d';
                e.currentTarget.style.color = '#888';
              }}
              title={key}
            >
              {getLabel(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Mobile-web access chip. Pulls live info from main (web-server.js) on mount,
// shows the LAN URL as a clickable pill: click → opens in default OS browser
// (so you can scan the address visually then scribe it onto your phone).
// Right-click → copy full URL with token to clipboard.
function WebServerChip({ hidden = false }: { hidden?: boolean }) {
  const [info, setInfo] = useState<{ running: boolean; lanIp?: string; port?: number; token?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { ipcRenderer } = window.require('electron');
        const data = await ipcRenderer.invoke('web:get-info');
        if (!cancelled) setInfo(data);
      } catch {
        if (!cancelled) setInfo({ running: false });
      }
    };
    load();
    // Re-poll occasionally so a late server start gets picked up without reload
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!info) return null;
  if (hidden) return null;
  if (!info.running) {
    return <span style={{ color: '#666', fontSize: 11 }}>web: off</span>;
  }

  // Prod (7878) → публичный домен через VPS-туннель; dev (7979 и любой другой) → локальный IP:port
  const isProd = info.port === 7878;
  const PUBLIC_HOST = 'remote-control.f9922.tech:8443';
  const fullUrl = isProd
    ? `https://${PUBLIC_HOST}/?token=${info.token}`
    : `http://${info.lanIp}:${info.port}/?token=${info.token}`;
  const shortUrl = isProd ? PUBLIC_HOST : `local:${info.port}`;

  const handleClick = () => {
    try {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.invoke('web:open-in-browser');
    } catch {}
  };
  const handleRightClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      const { clipboard } = window.require('electron');
      clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <button
      onClick={handleClick}
      onContextMenu={handleRightClick}
      className="inline-flex items-center gap-1 cursor-pointer hover:bg-white/5 rounded"
      style={{ padding: '1px 6px', height: 18 }}
    >
      <span
        style={{
          width: 8, height: 8, borderRadius: 4,
          backgroundColor: '#FFB382',
          boxShadow: '0 0 6px rgba(255, 178, 130, 0.5)',
        }}
      />
      <span style={{ color: copied ? '#a6e3a1' : '#ddd' }}>
        {copied ? 'copied!' : shortUrl}
      </span>
    </button>
  );
}

function StatusToggle({ label, title, active, onClick, activeColor = '#22c55e' }: {
  label: string;
  title?: string;
  active: boolean;
  onClick: () => void;
  activeColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1 cursor-pointer hover:bg-white/5 rounded"
      style={{ padding: '1px 6px', height: 18 }}
    >
      <span
        style={{
          width: 8, height: 8, borderRadius: 4,
          backgroundColor: active ? activeColor : '#444',
          boxShadow: active ? `0 0 6px ${activeColor}` : 'none',
          transition: 'background-color 0.15s, box-shadow 0.15s',
        }}
      />
      <span style={{ color: active ? '#ddd' : '#666' }}>{label}</span>
    </button>
  );
}

function HistoryTimelinePinToggle({
  historyPinned,
  timelinePinned,
  onToggleHistory,
  onToggleTimeline,
}: {
  historyPinned: boolean;
  timelinePinned: boolean;
  onToggleHistory: () => void;
  onToggleTimeline: () => void;
}) {
  return (
    <div
      data-history-timeline-pin-toggle
      className="inline-flex items-center rounded overflow-hidden"
      style={{ height: 20, border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <SplitIconButton
        title="History pin (Cmd+\\): когда история открыта, держать её обычной колонкой, а не overlay поверх терминала."
        active={historyPinned}
        activeColor="#a78bfa"
        side="left"
        onClick={onToggleHistory}
      >
        <History size={13} strokeWidth={1.9} />
      </SplitIconButton>
      <SplitIconButton
        title="Timeline pin (Cmd+]): когда таймлайн раскрыт, держать его обычной колонкой, а не overlay поверх терминала."
        active={timelinePinned}
        activeColor="#38bdf8"
        side="right"
        onClick={onToggleTimeline}
      >
        <Pin size={13} strokeWidth={1.9} />
      </SplitIconButton>
    </div>
  );
}

function SplitIconButton({ title, active, activeColor, side, onClick, children }: {
  title: string;
  active: boolean;
  activeColor: string;
  side: 'left' | 'right';
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className="inline-flex items-center justify-center cursor-pointer"
      style={{
        width: 22,
        height: 18,
        padding: 0,
        border: 'none',
        borderLeft: side === 'right' ? '1px solid rgba(255,255,255,0.08)' : 'none',
        outline: 'none',
        background: active ? `${activeColor}22` : 'transparent',
        color: active ? activeColor : '#666',
        boxShadow: active ? `0 0 8px ${activeColor}55 inset` : 'none',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = active ? activeColor : '#ddd';
        e.currentTarget.style.background = active ? `${activeColor}2e` : 'rgba(255,255,255,0.08)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = active ? activeColor : '#666';
        e.currentTarget.style.background = active ? `${activeColor}22` : 'transparent';
      }}
    >
      {children}
    </button>
  );
}
