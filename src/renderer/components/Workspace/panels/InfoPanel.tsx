import React, { useState, useEffect, useRef } from 'react';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';
import { useUIStore } from '../../../store/useUIStore';
import { generateAITitle } from '../../../utils/generateAITitle';
import { usePromptsStore } from '../../../store/usePromptsStore';
import { RotateCcw, Clock, ChevronDown, ChevronRight, ChevronLeft, ScrollText, GitBranch, User as UserIcon } from 'lucide-react';
import ActionsPanel from './ActionsPanel';
import CopySessionButton, { ClaudeSparkle } from '../CopySessionButton';
import { DeepSeekIcon, ZenIcon } from '../../icons/ProviderIcons';
import { terminalRegistry } from '../../../utils/terminalRegistry';
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_EFFORT_TOGGLE_OFF,
  DEEPSEEK_EFFORT_LEVELS,
} from '../../../constants/claudeLevels';

const { ipcRenderer } = window.require('electron');

// Marker prefix for auto-generated descriptions (first line of tab notes)
const DESC_MARKER = '\u2726 '; // ✦ character

interface HistoryTurn {
  turnNumber: number;
  preview: string;
  timestamp: string;
  file: string;
}

// UUID v4 regex pattern (without anchors to extract from text)
const UUID_EXTRACT_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Two-tier provider→model catalog for Контроль panel.
// Provider toggle (inside КОНТРОЛЬ header, right side) selects backend; Model row
// lists that provider's models. `cmd` = true means clicking the model sends
// `/model <name>` to the live Claude TUI (only meaningful for anthropic — Claude
// doesn't know about Zen/DeepSeek models).
//
// `tint` — official brand color used when the provider is active. Inactive state
// uses neutral grey so non-selected providers recede visually; active one pops
// in its brand color.
//
// `Icon` — inline SVG glyph rendered before the label inside the pill (~11px).
type ProviderId = 'anthropic' | 'zen' | 'deepseek';
type ProviderEntry = {
  id: ProviderId;
  label: string;
  title: string;
  tint: string;
  Icon: React.FC<{ size?: number; color?: string }>;
  models: { id: string; label: string; cmd?: boolean }[];
};
const PROVIDER_CATALOG: ProviderEntry[] = [
  {
    id: 'anthropic',
    label: 'Claude',
    title: 'Anthropic subscription (direct)',
    tint: '#DA7756',
    Icon: ClaudeSparkle,
    models: [
      { id: 'default', label: 'default', cmd: true },
      { id: 'sonnet', label: 'sonnet', cmd: true },
      { id: 'opus', label: 'opus', cmd: true },
      { id: 'haiku', label: 'haiku', cmd: true },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    title: 'DeepSeek (Anthropic-compatible at /anthropic)',
    tint: '#4D6BFE',
    Icon: DeepSeekIcon,
    models: [
      { id: 'deepseek-v4-flash', label: 'V4F' },
      { id: 'deepseek-v4-pro[1m]', label: 'V4P' },
    ],
  },
  {
    id: 'zen',
    label: 'Zen',
    title: 'OpenCode Zen (Anthropic-compatible)',
    tint: '#a78bfa',
    Icon: ZenIcon,
    models: [
      { id: 'minimax-m2.5', label: 'MM2.5' },
      { id: 'minimax-m2.7', label: 'MM2.7' },
    ],
  },
];

interface Project {
  id: string;
  path: string;
  name: string;
  notes?: string;
}

interface InfoPanelProps {
  activeTabId: string | null;
  project?: Project;
}


// Fixed-width tri-state chip that replaces the "Claude/Gemini · continue" pair.
// Idle:                 shows "Claude" / "Gemini" (the tab's AI label)
// Hover, no process:    shows "Continue"  → resume session
// Hover, process alive: shows "Stop"      → send Ctrl+C
// Click: invokes Continue/Stop. The default label is also clickable — copies
// the session ID (preserves old behaviour where clicking "Claude" copied the UUID).
// The session ID tooltip floats above the chip on hover.
function SessionActionChip({
  sessionType, sessionId, isCommandRunning, hasAnySession,
  onContinue, onStop, onCopyId,
}: {
  sessionType: 'claude' | 'gemini' | null;
  sessionId: string | null;
  isCommandRunning: boolean;
  hasAnySession: boolean;
  onContinue: () => void;
  onStop: () => void;
  onCopyId: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  const accent = sessionType === 'claude' ? '#DA7756' : '#4E86F8';
  // Brighter accent for the hover state — pops against the dark hover bg.
  const accentBright = sessionType === 'claude' ? '#FF9466' : '#7BA3FF';
  const defaultLabel = sessionType === 'claude' ? 'Claude' : 'Gemini';
  // Когда сессия неактивна (есть sessionId, но процесс не запущен) — `Continue` показывается
  // ВСЕГДА, без hover'а. Юзер хочет видеть affordance «можно продолжить» сразу, а не
  // обнаруживать её через hover. Hover в этом случае добавляет только выделение фона.
  // Если сессия активна — лейбл `Claude/Gemini`, на hover'е → `Stop` (destructive, красный).
  const sessionIdle = hasAnySession && !isCommandRunning;
  const showStopOnHover = hover && isCommandRunning;
  const label = sessionIdle ? 'Continue' : (showStopOnHover ? 'Stop' : defaultLabel);
  // Continue: brighter accent на idle всегда; brighter на hover тоже (одинаково, чтобы
  // не было микро-«моргания» цвета при hover). Stop: красный текст на hover.
  const color = showStopOnHover ? '#ef4444' : (sessionIdle ? accentBright : accent);

  const handleClick = () => {
    if (!hasAnySession) { onCopyId(); return; }
    if (isCommandRunning) onStop();
    else onContinue();
  };

  // Background: idle Continue получает «приподнятый» dark bg всегда — это сигнализирует
  // о доступности действия даже без курсора. Stop при hover'е (=activeCmd + hover) даёт
  // красный wash как предупреждение о destructive-действии.
  const baseBg = 'rgba(0,0,0,0.55)';
  const idleBg = sessionIdle ? baseBg : 'transparent';
  const bg = showStopOnHover ? 'rgba(239, 68, 68, 0.18)' : (hover && !sessionIdle ? baseBg : idleBg);
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={handleClick}
      className="text-xs font-medium cursor-pointer relative inline-flex items-center justify-center"
      style={{
        color,
        width: 64,
        height: 18,
        backgroundColor: bg,
        transition: 'background-color 0.12s, color 0.12s',
        userSelect: 'none',
      }}
    >
      {label}
    </span>
  );
}

export default function InfoPanel({ activeTabId, project }: InfoPanelProps) {
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [geminiSessionId, setGeminiSessionId] = useState<string | null>(null);
  const [activeCommandType, setActiveCommandType] = useState<string | null>(null);
  const [isSDKTab, setIsSDKTab] = useState(false);
  // aiMode removed — start buttons now show both claude & gemini inline
  // КОМАНДЫ section starts collapsed — its contents (fork-from-clipboard codes) are
  // rarely needed and only confused users when permanently visible. Click the header
  // to toggle.
  const [commandsExpanded, setCommandsExpanded] = useState(false);
  const [historyTurns, setHistoryTurns] = useState<HistoryTurn[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [claudeExpanded, setClaudeExpanded] = useState(false);
  const [claudeExtraPrompt, setClaudeExtraPrompt] = useState('');
  const [claudeDefaultPrompt, setClaudeDefaultPrompt] = useState('');
  // Local mirror exists ONLY so the textarea has a controlled value. Real source
  // of truth lives in useWorkspaceStore.tabs[id].notes — slide-out + sidebar
  // editor both write there. The selector below keeps this mirror reactive.
  const [tabNotes, setTabNotes] = useState('');
  const [sessionCopied, setSessionCopied] = useState(false);
  const [isGeneratingDesc, setIsGeneratingDesc] = useState(false);
  // Hover state шапки «Заметки вкладки» — теперь весь header-блок hover-able и кликабелен,
  // не только сама кнопка Open. Этот флаг управляет визуальным состоянием Open-чипа.
  const [notesHeaderHover, setNotesHeaderHover] = useState(false);
  const [thinkFlash, setThinkFlash] = useState<string | null>(null);
  const [effortLevel, setEffortLevel] = useState<Record<string, string>>({});
  // Think active state per tab. undefined → treated as ON (default at Claude startup
  // due to alwaysThinkingEnabled in settings.json). Cleared on OSC 133 D so a fresh
  // Claude run begins with implicit-ON again.
  const [thinkActive, setThinkActive] = useState<Record<string, boolean>>({});

  // Return focus to the Claude/Gemini terminal after a control button (Model/Effort/Think)
  // is clicked. Without this the focus stays on the button — Enter triggers it again
  // instead of submitting the input.
  const focusActiveTerminal = (tabId: string | null) => {
    if (!tabId) return;
    // Wait one tick so React doesn't immediately re-render and steal focus back.
    requestAnimationFrame(() => terminalRegistry.get(tabId)?.focus());
  };
  const bridgeCacheRef = useRef<Map<string, { model: string; contextPct: number }>>(new Map());
  const cached = activeTabId ? bridgeCacheRef.current.get(activeTabId) : undefined;
  const [claudeModel, setClaudeModel] = useState<string | null>(cached?.model ?? null);
  const [contextPct, setContextPct] = useState(cached?.contextPct ?? 0);
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  const [isControlBusy, setIsControlBusy] = useState(false);
  const [providerState, setProviderState] = useState<{ type: string; model?: string }>({ type: 'anthropic' });
  // Remembers last-selected model per provider so switching back restores prior choice.
  // Anthropic entry is null because its current model is read from live bridge data (claudeModel) — not stored locally.
  const providerMemoryRef = useRef<Record<string, string | null>>({ anthropic: null, zen: 'minimax-m2.7', deepseek: 'deepseek-v4-flash' });
  const [sessionInputMode, setSessionInputMode] = useState<'claude' | 'gemini' | null>(null);
  const [manualSessionId, setManualSessionId] = useState('');
  const sessionInputRef = useRef<HTMLInputElement>(null);
  const [validationResult, setValidationResult] = useState<{ claude?: { status: string; fullId?: string; preview?: string }; gemini?: { status: string; fullId?: string; preview?: string } } | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const validationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { showToast, claudeDefaultPromptEnabled } = useUIStore();
  // Live copy-flags — reactive so the markers row updates when user toggles in the popup.
  const includeUser = useUIStore((s) => s.copyIncludeUser);
  const includeClaude = useUIStore((s) => s.copyIncludeClaude);
  const includeText = useUIStore((s) => s.copyIncludeText);
  const includeThinking = useUIStore((s) => s.copyIncludeThinking);
  const includeReading = useUIStore((s) => s.copyIncludeReading);
  const includeEditing = useUIStore((s) => s.copyIncludeEditing);
  const includeBash = useUIStore((s) => s.copyIncludeBash);
  const includeTools = useUIStore((s) => s.copyIncludeTools);
  const includeSubagentResult = useUIStore((s) => s.copyIncludeSubagentResult);
  const includeSubagentHistory = useUIStore((s) => s.copyIncludeSubagentHistory);
  const setCopyIncludeUser = useUIStore((s) => s.setCopyIncludeUser);
  const setCopyIncludeClaude = useUIStore((s) => s.setCopyIncludeClaude);
  const setCopyIncludeText = useUIStore((s) => s.setCopyIncludeText);
  const setCopyIncludeThinking = useUIStore((s) => s.setCopyIncludeThinking);
  const setCopyIncludeReading = useUIStore((s) => s.setCopyIncludeReading);
  const setCopyIncludeEditing = useUIStore((s) => s.setCopyIncludeEditing);
  const setCopyIncludeBash = useUIStore((s) => s.setCopyIncludeBash);
  const setCopyIncludeTools = useUIStore((s) => s.setCopyIncludeTools);
  const setCopyIncludeSubagentResult = useUIStore((s) => s.setCopyIncludeSubagentResult);
  const setCopyIncludeSubagentHistory = useUIStore((s) => s.setCopyIncludeSubagentHistory);
  const fromStart = useUIStore((s) => s.copyFromStart);
  const setCopyFromStart = useUIStore((s) => s.setCopyFromStart);
  // Sub-pill preferred mode — what the right-half displays when subagents are OFF.
  // Lets the right-half stay clickable independently of the left ("sub-") toggle,
  // so user can pre-select "full" before turning subagents on. When subagents are
  // ON, the displayed label is derived from real flags, not this state.
  const [subPreferred, setSubPreferred] = useState<'result' | 'full'>('result');
  const historyPanelOpenTabs = useUIStore((s) => s.historyPanelOpenTabs);
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  const isHistoryOpen = activeTabId ? (historyPanelOpenTabs[activeTabId] ?? false) : false;
  const timelineTreeModeTabs = useUIStore((s) => s.timelineTreeModeTabs);
  const setTimelineTreeMode = useUIStore((s) => s.setTimelineTreeMode);
  const isTreeMode = activeTabId ? (timelineTreeModeTabs[activeTabId] ?? false) : false;
  const [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId, loading } = (e as CustomEvent).detail;
      if (tabId === activeTabId) setHistoryLoading(loading);
    };
    window.addEventListener('history-panel:loading', handler);
    return () => window.removeEventListener('history-panel:loading', handler);
  }, [activeTabId]);
  // Reset when history closes
  useEffect(() => {
    if (!isHistoryOpen) setHistoryLoading(false);
  }, [isHistoryOpen]);
  const { getPromptById } = usePromptsStore();
  const wordWrap = useUIStore((s) => s.wordWrap);
  const tabNotesFontSize = useUIStore((s) => s.tabNotesFontSize);
  const tabNotesPaddingX = useUIStore((s) => s.tabNotesPaddingX);
  const tabNotesPaddingY = useUIStore((s) => s.tabNotesPaddingY);
  const { setTabCommandType, closeTab, setTabNotes: setTabNotesStore } = useWorkspaceStore();
  const claudeTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Reactive subscription to the live tab.notes — fires when slide-out (or any
  // other consumer) writes via setTabNotesStore. Keeps our local mirror in sync.
  const liveTabNotes = useWorkspaceStore((s) => {
    if (!activeTabId) return '';
    for (const [, workspace] of s.openProjects) {
      const tab = workspace.tabs.get(activeTabId);
      if (tab) return tab.notes || '';
    }
    return '';
  });
  useEffect(() => {
    setTabNotes(liveTabNotes);
  }, [liveTabNotes]);

  useEffect(() => {
    ipcRenderer.invoke('app:getState', 'claudeDefaultPrompt').then((value: string | null) => {
      setClaudeDefaultPrompt(value || '');
    });
  }, []);

  useEffect(() => {
    setSessionInputMode(null);
    setManualSessionId('');
    setValidationResult(null);
    setIsValidating(false);
    const c = activeTabId ? bridgeCacheRef.current.get(activeTabId) : undefined;
    setClaudeModel(c?.model ?? null);
    setContextPct(c?.contextPct ?? 0);
  }, [activeTabId]);

  // Debounced session ID validation
  useEffect(() => {
    if (validationTimerRef.current) { clearTimeout(validationTimerRef.current); validationTimerRef.current = null; }
    const trimmed = manualSessionId.trim();
    if (!trimmed || !activeTabId || trimmed.length < 8) {
      setValidationResult(null);
      setIsValidating(false);
      return;
    }
    setIsValidating(true);
    validationTimerRef.current = setTimeout(async () => {
      try {
        const result = await ipcRenderer.invoke('session:validate-id', { input: trimmed, mode: 'auto', tabId: activeTabId });
        setValidationResult(result);
      } catch (e) { setValidationResult(null); }
      finally { setIsValidating(false); }
    }, 300);
    return () => { if (validationTimerRef.current) clearTimeout(validationTimerRef.current); };
  }, [manualSessionId, activeTabId]);

  useEffect(() => {
    if (!activeTabId) { setIsCommandRunning(false); return; }
    const handleStarted = (_: any, data: { tabId: string }) => {
      if (data.tabId === activeTabId) setIsCommandRunning(true);
    };
    const handleFinished = (_: any, data: { tabId: string }) => {
      if (data.tabId === activeTabId) setIsCommandRunning(false);
    };
    ipcRenderer.on('terminal:command-started', handleStarted);
    ipcRenderer.on('terminal:command-finished', handleFinished);
    ipcRenderer.invoke('terminal:getCommandState', activeTabId).then((state: any) => {
      setIsCommandRunning(state?.isRunning || false);
    });
    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleFinished);
    };
  }, [activeTabId]);

  // Reset Anthropic effort when shell exit fires for any tab (listens for OSC 133 D event).
  // Anthropic effort is Claude TUI state — Claude CLI loses it on exit, but local effortLevel map
  // kept the stale value, suggesting an effort that no longer applies. Guard `data.tabId in prev`
  // skips re-render for tabs that never had effort set (bash/zsh tabs, sub-agents that didn't get effort).
  // DeepSeek effort lives in main process providerStates and is intentionally NOT reset — it's a
  // per-tab UI config, persists across Claude exits and only clears when the tab itself closes.
  useEffect(() => {
    const handleAnyFinished = (_: any, data: { tabId: string }) => {
      setEffortLevel(prev => {
        if (!(data.tabId in prev)) return prev;
        const next = { ...prev };
        delete next[data.tabId];
        return next;
      });
      // Same reset semantics for Think — Claude restart re-applies alwaysThinkingEnabled
      // from settings.json (default ON), so any local toggle from the previous run is moot.
      setThinkActive(prev => {
        if (!(data.tabId in prev)) return prev;
        const next = { ...prev };
        delete next[data.tabId];
        return next;
      });
    };
    ipcRenderer.on('terminal:command-finished', handleAnyFinished);
    return () => { ipcRenderer.removeListener('terminal:command-finished', handleAnyFinished); };
  }, []);

  // Sync local effortLevel UI state with auto-injected /effort at Claude startup.
  // Terminal.tsx fires claude:send-command with /effort <defaultClaudeEffort> on
  // claude:process-started — but that only updates the PTY process, not this local
  // Map. Without this listener the Effort pills would show the default as active even
  // though Claude is actually running at 'max'.
  useEffect(() => {
    const handleProcessStarted = (_: any, data: { tabId: string; sessionId: string; claudePid: number }) => {
      const eff = useUIStore.getState().defaultClaudeEffort;
      if (!eff || eff === 'none') return;
      setEffortLevel(prev => ({ ...prev, [data.tabId]: eff }));
    };
    ipcRenderer.on('claude:process-started', handleProcessStarted);
    return () => { ipcRenderer.removeListener('claude:process-started', handleProcessStarted); };
  }, []);

  useEffect(() => {
    const handler = (_: any, data: { tabId: string; model: string; contextPct: number }) => {
      bridgeCacheRef.current.set(data.tabId, { model: data.model, contextPct: data.contextPct });
      if (data.tabId === activeTabId) {
        setClaudeModel(data.model);
        setContextPct(data.contextPct);
      }
    };
    ipcRenderer.on('claude:bridge-update', handler);
    return () => { ipcRenderer.removeListener('claude:bridge-update', handler); };
  }, [activeTabId]);

  // Provider state is per-tab. Reload when activeTabId changes; only apply broadcast updates targeting this tab.
  useEffect(() => {
    if (!activeTabId) { setProviderState({ type: 'anthropic' }); return; }
    ipcRenderer.invoke('provider:get-status', { tabId: activeTabId }).then((s: any) => setProviderState(s));
    const handler = (_: any, payload: { tabId: string; state: { type: string; model?: string } }) => {
      if (payload?.tabId === activeTabId) setProviderState(payload.state);
    };
    ipcRenderer.on('provider:state-changed', handler);
    return () => { ipcRenderer.removeListener('provider:state-changed', handler); };
  }, [activeTabId]);

  useEffect(() => {
    const checkSession = () => {
      if (!activeTabId) {
        setClaudeSessionId(null);
        setGeminiSessionId(null);
        setActiveCommandType(null);
        setIsSDKTab(false);
        return;
      }
      const state = useWorkspaceStore.getState();
      for (const [, workspace] of state.openProjects) {
        const tab = workspace.tabs.get(activeTabId);
        if (tab) {
          const newClaudeId = tab.claudeSessionId || null;
          const newGeminiId = tab.geminiSessionId || null;
          setClaudeSessionId(prev => prev !== newClaudeId ? newClaudeId : prev);
          setGeminiSessionId(prev => prev !== newGeminiId ? newGeminiId : prev);
          setActiveCommandType(tab.commandType || null);
          setIsSDKTab(tab.tabType === 'claude-sdk');
          return;
        }
      }
      console.warn('[InfoPanel:Poll] Tab NOT FOUND in any project: tabId=' + activeTabId + ' → sessions nulled');
      setClaudeSessionId(null);
      setGeminiSessionId(null);
      setActiveCommandType(null);
      setIsSDKTab(false);
    };
    checkSession();
    const interval = setInterval(checkSession, 500);
    return () => clearInterval(interval);
  }, [activeTabId]);

  const hasClaudeSession = !!claudeSessionId;
  const hasGeminiSession = !!geminiSessionId;
  const hasAnySession = hasClaudeSession || hasGeminiSession;

  // Track hasAnySession transitions for debugging
  const prevHasAnySessionRef = useRef(hasAnySession);
  useEffect(() => {
    if (prevHasAnySessionRef.current !== hasAnySession) {
      console.warn('[InfoPanel:State] hasAnySession: ' + prevHasAnySessionRef.current + ' → ' + hasAnySession + ' | tabId=' + (activeTabId || 'null') + ' claude=' + (claudeSessionId ? claudeSessionId.substring(0, 8) : 'null') + ' gemini=' + (geminiSessionId ? geminiSessionId.substring(0, 8) : 'null') + ' cmdType=' + activeCommandType);
      prevHasAnySessionRef.current = hasAnySession;
    }
  });
  const currentSessionType = hasClaudeSession ? 'claude' : hasGeminiSession ? 'gemini' : null;
  const sessionId = currentSessionType === 'claude' ? claudeSessionId : geminiSessionId;

  useEffect(() => {
    if (!geminiSessionId || !activeTabId) { setHistoryTurns([]); return; }
    const cwd = getCurrentCwd();
    ipcRenderer.send('gemini:start-history-watcher', { sessionId: geminiSessionId, cwd });
    const loadHistory = async () => {
      const result = await ipcRenderer.invoke('gemini:get-timemachine', { sessionId: geminiSessionId, cwd });
      if (result.success) setHistoryTurns(result.turns);
    };
    loadHistory();
    const handleHistoryUpdate = (_: any, { sessionId: updatedSessionId }: { sessionId: string }) => {
      if (updatedSessionId === geminiSessionId) loadHistory();
    };
    ipcRenderer.on('gemini:history-updated', handleHistoryUpdate);
    return () => {
      ipcRenderer.send('gemini:stop-history-watcher', { sessionId: geminiSessionId });
      ipcRenderer.removeListener('gemini:history-updated', handleHistoryUpdate);
    };
  }, [geminiSessionId, activeTabId]);

  const handleRollback = async (turnNumber: number) => {
    if (!geminiSessionId || !activeTabId || isRollingBack) return;
    const cwd = getCurrentCwd();
    setIsRollingBack(true);
    try {
      const result = await ipcRenderer.invoke('gemini:rollback', {
        sessionId: geminiSessionId, turnNumber, cwd, tabId: activeTabId
      });
      if (result.success) {
        showToast(`Откат до сообщения ${turnNumber}`, 'success');
        const state = useWorkspaceStore.getState();
        for (const [projectId, workspace] of state.openProjects) {
          const tab = workspace.tabs.get(activeTabId);
          if (tab) {
            await closeTab(projectId, activeTabId);
            await state.createTabAfterCurrent(projectId, undefined, cwd, {
              pendingAction: { type: 'gemini-continue', sessionId: geminiSessionId },
              geminiSessionId: geminiSessionId
            });
            break;
          }
        }
      } else showToast(`Ошибка отката: ${result.error}`, 'error');
    } catch (e: any) { showToast(`Ошибка: ${e.message}`, 'error'); }
    finally { setIsRollingBack(false); }
  };

  const getCurrentCwd = () => {
    if (!activeTabId) return project?.path || '';
    const state = useWorkspaceStore.getState();
    for (const [, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(activeTabId);
      if (tab) return tab.cwd || project?.path || '';
    }
    return project?.path || '';
  };

  const handleGenerateDescription = async () => {
    if (!activeTabId || isGeneratingDesc) return;
    const state = useWorkspaceStore.getState();
    let targetSessionId = '';
    let tabCwd = '';
    for (const [, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(activeTabId);
      if (tab) {
        targetSessionId = tab.claudeSessionId || '';
        tabCwd = tab.cwd || project?.path || '';
        break;
      }
    }
    if (!targetSessionId) { showToast('No Claude session to describe', 'warning'); return; }
    setIsGeneratingDesc(true);
    try {
      const exportResult = await ipcRenderer.invoke('claude:export-clean-session', {
        sessionId: targetSessionId, cwd: tabCwd, includeEditing: false, includeReading: false, fromStart: true
      });
      if (!exportResult.success) throw new Error(exportResult.error || 'Export failed');
      const descPrompt = getPromptById('description');
      const descContent = descPrompt?.content || 'Describe this session in 1-2 sentences.';
      const descModel = descPrompt?.model || 'gemini-3-flash-preview';
      const descThinking = descPrompt?.thinkingLevel || 'NONE';
      const fullPrompt = descContent + exportResult.content;
      const apiKey = process.env.GEMINI_API_KEY;
      const requestBody: any = {
        contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
        systemInstruction: { parts: [{ text: '1-2 предложения. Без маркдауна.' }] }
      };
      if (descModel.includes('gemini-3') && descThinking !== 'NONE') {
        requestBody.generationConfig = { thinkingConfig: { thinkingLevel: descThinking } };
      }
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${descModel}:generateContent?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody)
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || 'API Error');
      const descriptionText = data.candidates[0].content.parts[0].text.replace(/\n/g, ' ').trim();
      const lines = tabNotes.split('\n');
      const markedLine = DESC_MARKER + descriptionText;
      if (lines.length > 0 && lines[0].startsWith(DESC_MARKER)) lines[0] = markedLine;
      else lines.unshift(markedLine);
      const newNotes = lines.join('\n');
      setTabNotes(newNotes);
      setTabNotesStore(activeTabId, newNotes);
      showToast('Description generated', 'success');
    } catch (e: any) { showToast(e.message || 'Failed to generate description', 'error'); }
    finally { setIsGeneratingDesc(false); }
  };

  const handleApplyManualSession = (mode: 'claude' | 'gemini') => {
    if (!activeTabId || !validationResult) return;
    const result = mode === 'claude' ? validationResult.claude : validationResult.gemini;
    if (!result || result.status !== 'found' || !result.fullId) {
      showToast('Session not found', 'warning');
      return;
    }
    const newId = result.fullId;
    const targetId = mode === 'gemini' ? geminiSessionId : claudeSessionId;
    if (newId === targetId) {
      showToast('Already current session', 'warning');
      setSessionInputMode(null);
      setManualSessionId('');
      setValidationResult(null);
      return;
    }
    if (mode === 'gemini') {
      useWorkspaceStore.getState().setGeminiSessionId(activeTabId, newId);
    } else {
      console.warn('[InfoPanel:ManualSet] MANUAL session set for tab', activeTabId, ':', newId.substring(0, 8));
      useWorkspaceStore.getState().setClaudeSessionId(activeTabId, newId);
    }
    showToast(`${mode === 'gemini' ? 'Gemini' : 'Claude'} session set: ${newId.substring(0, 8)}...`, 'success');
    setSessionInputMode(null);
    setManualSessionId('');
    setValidationResult(null);
  };

  const getInputBorderClass = () => {
    if (isValidating) return 'border-yellow-500/50';
    if (!validationResult) return 'border-[#444]';
    const cf = validationResult.claude?.status === 'found';
    const gf = validationResult.gemini?.status === 'found';
    if (cf || gf) return 'border-green-500/70';
    return 'border-red-500/50';
  };

  const renderValidationStatus = () => {
    if (isValidating) return <span className="text-[9px] text-yellow-500/70 mt-0.5 block">Checking...</span>;
    if (!validationResult) return null;
    const parts: React.ReactNode[] = [];
    if (validationResult.claude?.status === 'found') {
      parts.push(<span key="c" className="text-green-400">C: {validationResult.claude.fullId?.substring(0, 8)}</span>);
    } else if (validationResult.claude?.status === 'not-found') {
      parts.push(<span key="c" className="text-red-400/60">C: not found</span>);
    }
    if (validationResult.gemini?.status === 'found') {
      parts.push(<span key="g" className="text-green-400">G: {validationResult.gemini.fullId?.substring(0, 8)}</span>);
    } else if (validationResult.gemini?.status === 'not-found') {
      parts.push(<span key="g" className="text-red-400/60">G: not found</span>);
    }
    if (parts.length === 0) return null;
    return <div className="flex gap-2 text-[9px] mt-0.5">{parts}</div>;
  };

  const renderSessionInput = () => (
    <div className="mt-2" style={{ animation: 'fadeIn 0.15s ease-out' }}>
      <input
        ref={sessionInputRef}
        type="text"
        value={manualSessionId}
        onChange={(e) => setManualSessionId(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setSessionInputMode(null); setManualSessionId(''); setValidationResult(null); }
        }}
        placeholder="UUID or 8-char short ID..."
        className={`w-full px-2 py-1 bg-[#1a1a1a] border ${getInputBorderClass()} rounded text-[10px] text-[#aaa] font-mono focus:outline-none placeholder:text-[#555] transition-colors`}
      />
      {renderValidationStatus()}
      <div className="flex gap-1 mt-1.5">
        <button
          className="flex-1 text-[10px] px-2 py-1 rounded-l cursor-pointer disabled:opacity-40 bg-[#DA7756]/20 text-[#DA7756] hover:bg-[#DA7756]/30"
          onClick={() => handleApplyManualSession('claude')}
          disabled={!validationResult?.claude || validationResult.claude.status !== 'found'}
        >C</button>
        <button
          className="flex-1 text-[10px] px-2 py-1 rounded-r cursor-pointer disabled:opacity-40 bg-[#4E86F8]/20 text-[#4E86F8] hover:bg-[#4E86F8]/30"
          onClick={() => handleApplyManualSession('gemini')}
          disabled={!validationResult?.gemini || validationResult.gemini.status !== 'found'}
        >G</button>
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col p-3">
      {/* Upper sections — scrollable independently */}
      <div className="overflow-y-auto min-h-0 shrink">
      {/* mb-2 (8px) — leaves room before the standalone divider rule.
          Total gap to PROVIDER = mb-2 (8) + rule (0) + provider mt-2 (8) = 16px,
          with the line sitting exactly at the midpoint. No padding stacking. */}
      <div className="mb-2">
        <div className="flex items-center mb-2" style={{ gap: 6 }}>
          {/* Tree mode toggle — for any AI session with timeline.
              Idle color = бывший hover (#888) для лучшей видимости. Hover теперь даёт
              белый текст + лёгкий тинт фона. Активное состояние — индиго, как раньше. */}
          {hasAnySession && activeTabId && (
            <button
              onClick={() => {
                const next = !isTreeMode;
                console.warn('[InfoPanel:Click] TreeMode toggle: tabId=' + activeTabId!.substring(activeTabId!.length - 8) + ' ' + isTreeMode + ' → ' + next + ' hasAnySession=' + hasAnySession);
                if (next) setHistoryPanelOpen(activeTabId, false); // mutual exclusion
                setTimelineTreeMode(activeTabId, next);
              }}
              className="cursor-pointer rounded transition-colors"
              style={{
                background: 'transparent',
                border: 'none',
                padding: '2px 4px',
                color: isTreeMode ? '#a5b4fc' : '#aaa',
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.color = isTreeMode ? '#c7d2fe' : '#fff';
                el.style.background = isTreeMode ? 'rgba(129,140,248,0.15)' : 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.color = isTreeMode ? '#a5b4fc' : '#aaa';
                el.style.background = 'transparent';
              }}
            >
              <GitBranch size={12} />
            </button>
          )}
          {/* AI Session button — тот же яркий-by-default паттерн. */}
          {hasAnySession && activeTabId ? (
            <button
              onClick={() => {
                const next = !isHistoryOpen;
                console.warn('[InfoPanel:Click] History toggle: tabId=' + activeTabId!.substring(activeTabId!.length - 8) + ' ' + isHistoryOpen + ' → ' + next + ' hasAnySession=' + hasAnySession);
                if (next) setTimelineTreeMode(activeTabId, false); // mutual exclusion
                setHistoryPanelOpen(activeTabId, next);
              }}
              className="flex items-center cursor-pointer rounded transition-colors"
              style={{
                gap: 5,
                background: 'transparent',
                border: 'none',
                padding: '2px 4px',
                color: isHistoryOpen ? '#a5b4fc' : '#aaa',
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.color = isHistoryOpen ? '#c7d2fe' : '#fff';
                el.style.background = isHistoryOpen ? 'rgba(129,140,248,0.15)' : 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.color = isHistoryOpen ? '#a5b4fc' : '#aaa';
                el.style.background = 'transparent';
              }}
            >
              {isHistoryOpen && historyLoading ? (
                <svg width="12" height="12" viewBox="0 0 16 16" style={{ animation: 'spinner-rotate 1s linear infinite', willChange: 'transform', flexShrink: 0 }}>
                  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
                </svg>
              ) : (
                <ScrollText size={12} />
              )}
              <span className="text-[11px] uppercase">AI Session</span>
            </button>
          ) : (
            <div className="flex items-center text-[#888]" style={{ gap: 5 }}>
              <ScrollText size={12} />
              <span className="text-[11px] uppercase">AI Session</span>
            </div>
          )}
        </div>
        {hasAnySession ? (
          <>
          <div className={`rounded p-2 ${currentSessionType === 'claude' ? 'bg-[#2a3a2a] border border-[#3a5a3a]' : 'bg-[#1a2a3a] border border-[#2a4a6a]'}`}>
            <div className="flex items-center gap-1.5">
              {/* Triplet: ⎘ — Claude — ↻. All three share a permanent dark bg
                  (rgba(0,0,0,0.55)); they sit flush via gap-0 and segmented
                  rounding (left / none / right). Hover swaps text colour only —
                  no bg change, no layout shift. */}
              <div className="inline-flex items-center" style={{ gap: 0 }}>
                <span
                  className="cursor-pointer flex-shrink-0 inline-flex items-center justify-center"
                  style={{
                    color: sessionCopied ? '#4ade80' : '#888',
                    fontSize: 13,
                    lineHeight: 1,
                    width: 22,
                    height: 18,
                    backgroundColor: 'rgba(0,0,0,0.55)',
                    borderTopLeftRadius: 4,
                    borderBottomLeftRadius: 4,
                    transition: 'color 0.12s',
                    userSelect: 'none',
                  }}
                  onMouseEnter={(e) => {
                    if (sessionCopied) return;
                    (e.currentTarget as HTMLSpanElement).style.color = '#ddd';
                  }}
                  onMouseLeave={(e) => {
                    if (sessionCopied) return;
                    (e.currentTarget as HTMLSpanElement).style.color = '#888';
                  }}
                  onClick={() => {
                    if (sessionId) {
                      navigator.clipboard.writeText(sessionId);
                      setSessionCopied(true);
                      setTimeout(() => setSessionCopied(false), 1000);
                    }
                  }}
                >
                  {sessionCopied ? '✓' : '⎘'}
                </span>
                <SessionActionChip
                  sessionType={currentSessionType}
                  sessionId={sessionId}
                  isCommandRunning={isCommandRunning}
                  hasAnySession={hasAnySession}
                  onContinue={() => {
                    if (!activeTabId) return;
                    if (currentSessionType === 'claude') {
                      setTabCommandType(activeTabId, 'claude');
                      terminalRegistry.get(activeTabId)?.scrollToBottom();
                      window.dispatchEvent(new CustomEvent('timeline:scroll-to-bottom', { detail: { tabId: activeTabId } }));
                      ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude-c', sessionId: claudeSessionId });
                    } else if (currentSessionType === 'gemini') {
                      setTabCommandType(activeTabId, 'gemini');
                      terminalRegistry.get(activeTabId)?.scrollToBottom();
                      window.dispatchEvent(new CustomEvent('timeline:scroll-to-bottom', { detail: { tabId: activeTabId } }));
                      ipcRenderer.send('gemini:run-command', { tabId: activeTabId, command: 'gemini-c', sessionId: geminiSessionId });
                    }
                  }}
                  onStop={async () => {
                    if (!activeTabId) return;
                    try {
                      const res = await ipcRenderer.invoke('terminal:stop-ai-process', activeTabId);
                      if (!res?.success) console.warn('[SessionStop] failed:', res?.error);
                    } catch (e: any) { console.error('[SessionStop] error', e); }
                  }}
                  onCopyId={() => {
                    if (sessionId) {
                      navigator.clipboard.writeText(sessionId);
                      setSessionCopied(true);
                      setTimeout(() => setSessionCopied(false), 1000);
                    }
                  }}
                />
                {activeTabId && (
                  <button
                    className="flex-shrink-0 inline-flex items-center justify-center cursor-pointer"
                    style={{
                      color: '#888',
                      fontSize: 13,
                      lineHeight: 1,
                      width: 22,
                      height: 18,
                      padding: 0,
                      background: 'rgba(0,0,0,0.55)',
                      border: 'none',
                      borderTopRightRadius: 4,
                      borderBottomRightRadius: 4,
                      transition: 'color 0.12s',
                      userSelect: 'none',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#ddd'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#888'; }}
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('timeline:force-refresh', { detail: { tabId: activeTabId } }));
                    }}
                  >↻</button>
                )}
              </div>
              <div className="flex-1" />
              {isSDKTab && activeTabId && (
                <button
                  className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer text-[#444] hover:text-[#aaa] hover:bg-[#ffffff08]"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('claude-sdk:reload', { detail: { tabId: activeTabId } }));
                  }}
                >⟳</button>
              )}
              {/* «Заменить сессию» (✎ Replace) — функционал пока не работает корректно, кнопка временно убрана. */}
              <button
                className="text-[10px] px-1.5 py-0.5 rounded text-[#999] hover:text-white cursor-pointer leading-none flex items-center gap-0.5 transition-colors"
                style={{
                  backgroundColor: 'transparent',
                  border: '1px solid rgba(255,255,255,0.10)',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.06)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                onClick={async () => {
                  if (!sessionId || !activeTabId || !currentSessionType) return;
                  const state = useWorkspaceStore.getState();
                  for (const [projectId, workspace] of state.openProjects) {
                    const tab = workspace.tabs.get(activeTabId);
                    if (tab) {
                      const currentCwd = tab.cwd || project?.path || '';
                      const forkName = tab.name ? `${tab.name}_fork` : undefined;
                      await state.createTabAfterCurrent(projectId, forkName, currentCwd, {
                        pendingAction: { type: currentSessionType === 'claude' ? 'claude-fork' : 'gemini-fork', sessionId: sessionId },
                        nameSetManually: !!forkName,
                      });
                      showToast(`Fork ${currentSessionType === 'claude' ? 'Claude' : 'Gemini'} → ${forkName || 'новая вкладка'}`, 'success');
                      break;
                    }
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!activeTabId || !sessionId) return;
                  if (isSDKTab) return;
                  const { convertToSDKTab } = useWorkspaceStore.getState();
                  convertToSDKTab(activeTabId);
                  showToast('Converted to SDK tab', 'success');
                }}
              >⑂→<span style={{ fontSize: '11px' }}>▭</span></button>
              {currentSessionType === 'claude' && sessionId && (
                <button
                  className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer leading-none transition-colors"
                  style={{
                    color: '#DA7756',
                    backgroundColor: 'transparent',
                    border: '1px solid rgba(218,119,86,0.30)',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(218,119,86,0.15)'; (e.currentTarget as HTMLButtonElement).style.color = '#FF9466'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = '#DA7756'; }}
                  onClick={async () => {
                    if (!sessionId || !activeTabId) return;
                    const state = useWorkspaceStore.getState();
                    for (const [projectId, workspace] of state.openProjects) {
                      const tab = workspace.tabs.get(activeTabId);
                      if (tab) {
                        const currentCwd = tab.cwd || project?.path || '';
                        const forkResult = await ipcRenderer.invoke('claude:fork-session-file', { sourceSessionId: sessionId, cwd: currentCwd, skipChainResolve: true });
                        if (!forkResult.success) { showToast('Fork failed: ' + forkResult.error, 'error'); return; }
                        const sdkTabId = await state.createSDKTab(projectId);
                        state.updateSDKState(sdkTabId, { claudeSessionId: forkResult.newSessionId });
                        showToast('SDK fork ← ' + sessionId.slice(0, 8), 'success');
                        break;
                      }
                    }
                  }}
                >⑂→SDK</button>
              )}
            </div>

            {sessionInputMode && renderSessionInput()}
          </div>
          <div className="mt-1.5 flex justify-between items-center gap-2">
            <CopySessionButton activeTabId={activeTabId} sessionType={currentSessionType} />
            {currentSessionType === 'claude' && activeTabId && (() => {
              // Shared copy step. `clear` flag chains a separate IPC to wipe Claude's input.
              const handleCopyPrompt = async (clearAfter: boolean) => {
                try {
                  const res = await ipcRenderer.invoke('claude:copy-input', activeTabId);
                  if (res?.success && typeof res.text === 'string') {
                    const t = res.text;
                    if (!t.trim()) { showToast('Claude input is empty', 'warning'); return; }
                    const { clipboard } = window.require('electron');
                    const annotated = res.images > 0 ? t + `\n\n[note: ${res.images} image(s) not copied]` : t;
                    clipboard.writeText(annotated);
                    const oneLine = t.replace(/\s+/g, ' ').trim();
                    const preview = oneLine.length > 20 ? oneLine.slice(0, 20) + '…' : oneLine;
                    const verb = clearAfter ? 'Copied + cleared' : 'Copied';
                    showToast(`${verb}: "${preview}"${res.images ? ` · ${res.images} 📎` : ''}`, 'success', 1800);
                    if (clearAfter) {
                      // Refocus terminal so Ink's render loop is hot — otherwise the alt-screen
                      // "Save and close editor..." flash plays back when the user later focuses.
                      focusActiveTerminal(activeTabId);
                      ipcRenderer.invoke('claude:clear-input', activeTabId).catch(() => {});
                    }
                  } else {
                    const code = res?.error || 'timeout';
                    const msgs: Record<string, string> = {
                      no_claude_session: 'No Claude session',
                      claude_busy: 'Claude is busy — wait for response',
                      wrong_editor: 'Restart Claude in this tab (editor not wired)',
                      editor_not_wired: 'Helper not reachable',
                    };
                    showToast(msgs[code] || `Copy failed: ${code}`, 'error');
                  }
                } catch (e: any) {
                  showToast(`Copy failed: ${e?.message || e}`, 'error');
                }
              };
              // Split-pill — neutral light palette (white-ish text, subtle dark bg).
              // Claude-orange was too loud next to CopySessionButton; this is a quieter
              // utility action — visually recedes until hover.
              return (
                <div
                  className="inline-flex items-stretch rounded select-none overflow-hidden"
                  style={{
                    height: 26,
                    border: '1px solid rgba(255,255,255,0.12)',
                    backgroundColor: 'rgba(255,255,255,0.03)',
                    color: '#bbb',
                    fontSize: 11,
                  }}
                >
                  {/* Left half: ⎘ prompt (copy only) */}
                  <button
                    onClick={() => handleCopyPrompt(false)}
                    className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-[rgba(255,255,255,0.06)] hover:text-white transition-colors"
                    style={{ padding: '0 10px', background: 'transparent', border: 'none', color: 'inherit' }}
                  >
                    <span style={{ fontSize: 13, lineHeight: 1 }}>⎘</span>
                    <span>prompt</span>
                  </button>
                  {/* Divider — matches outer border tone */}
                  <span style={{ width: 1, alignSelf: 'center', height: '70%', backgroundColor: 'rgba(255,255,255,0.12)' }} />
                  {/* Right half: + clear (copy + wipe input) */}
                  <button
                    onClick={() => handleCopyPrompt(true)}
                    className="inline-flex items-center gap-1 cursor-pointer hover:bg-[rgba(255,255,255,0.06)] hover:text-white transition-colors"
                    style={{ padding: '0 10px', background: 'transparent', border: 'none', color: 'inherit' }}
                  >
                    <span style={{ fontSize: 13, lineHeight: 1 }}>+</span>
                    <span>clear</span>
                  </button>
                </div>
              );
            })()}
          </div>
          {/* Markers row — sits in the gap before the next section. Replaces the unreadable
              corner-dots that used to live on the 📋 icon. Each chip reflects a copyInclude*
              flag: enabled = orange (Claude brand), disabled = dim grey. Clicking toggles —
              bidirectional with the popup, so users see what's in the clipboard at a glance
              and can flip flags without opening settings. */}
          {currentSessionType === 'claude' && (() => {
            const ON = '#DA7756';
            const OFF = '#555';
            const ChipText = ({ active, children, onClick, title, italic = false }:
              { active: boolean; children: React.ReactNode; onClick: () => void; title: string; italic?: boolean }) => (
              <button
                onClick={onClick}
                className="cursor-pointer hover:opacity-80 transition-opacity"
                style={{
                  background: 'transparent', border: 'none', padding: 0,
                  color: active ? ON : OFF,
                  fontSize: 9.5,
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  fontStyle: italic ? 'italic' : 'normal',
                  lineHeight: 1.2,
                  letterSpacing: '-0.01em',
                }}
              >{children}</button>
            );
            const dot = <span style={{ color: '#333', fontSize: 10, lineHeight: 1.2 }}>·</span>;
            return (
              <div
                className="mt-1.5 flex items-center flex-wrap select-none"
                style={{
                  gap: '2px 4px',
                  // Reserve space for up to 2 wrapped rows so toggling chips (e.g. enabling
                  // subagents, switching fork mode) cannot shift КОНТРОЛЬ below.
                  minHeight: 26,
                  alignContent: 'flex-start',
                }}
              >
                {/* User chip — Lucide icon, tinted same way as Claude's sparkle. Emoji
                    👤 had its own Apple-blue colour and broke the orange/grey palette. */}
                <button
                  onClick={() => setCopyIncludeUser(!includeUser)}
                  className="cursor-pointer hover:opacity-80 transition-opacity inline-flex items-center"
                  style={{ background: 'transparent', border: 'none', padding: 0, lineHeight: 1, color: includeUser ? ON : OFF }}
                >
                  <UserIcon size={11} strokeWidth={2} />
                </button>
                {dot}
                {/* Claude chip — brand sparkle, tinted */}
                <button
                  onClick={() => setCopyIncludeClaude(!includeClaude)}
                  className="cursor-pointer hover:opacity-80 transition-opacity inline-flex items-center"
                  style={{ background: 'transparent', border: 'none', padding: 0, lineHeight: 1 }}
                >
                  <ClaudeSparkle size={11} color={includeClaude ? ON : OFF} />
                </button>
                {dot}
                {/* Sub-chips — clicking turns parent (includeClaude) on automatically if
                    it was off. Without this, sub-chips appear disabled and clicks do
                    nothing — surprising behaviour when user wants e.g. "only thinking". */}
                <ChipText
                  italic
                  active={includeClaude && includeText}
                  onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeText(!(includeClaude && includeText)); }}
                  title="«text» — финальные ответы Claude"
                >text</ChipText>
                {dot}
                <ChipText
                  italic
                  active={includeClaude && includeThinking}
                  onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeThinking(!(includeClaude && includeThinking)); }}
                  title="«thinking» — extended thinking blocks"
                >thinking</ChipText>
                {dot}
                <ChipText
                  active={includeClaude && includeReading}
                  onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeReading(!(includeClaude && includeReading)); }}
                  title="read_file — Read tool"
                >read</ChipText>
                {dot}
                <ChipText
                  active={includeClaude && includeEditing}
                  onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeEditing(!(includeClaude && includeEditing)); }}
                  title="edit, write"
                >edit</ChipText>
                {dot}
                <ChipText
                  active={includeClaude && includeBash}
                  onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeBash(!(includeClaude && includeBash)); }}
                  title="bash, monitor, grep, glob — shell-команды"
                >bash</ChipText>
                {dot}
                <ChipText
                  active={includeClaude && includeTools}
                  onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeTools(!(includeClaude && includeTools)); }}
                  title="mcp__*, web_search"
                >mcp</ChipText>
                {/* Fork chip — always rendered to reserve space. Blue when fromStart=false
                    (copy starts at the fork point, not session start); grey otherwise.
                    Click toggles. Lives left of the sub-chip. */}
                {dot}
                <button
                  onClick={() => setCopyFromStart(!fromStart)}
                  className="cursor-pointer hover:opacity-80 transition-opacity inline-flex items-center"
                  style={{
                    background: 'transparent', border: 'none', padding: 0,
                    color: !fromStart ? '#3b82f6' : OFF,
                    fontSize: 9.5,
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                    lineHeight: 1.2,
                    gap: 3,
                  }}
                >
                  <span style={{ fontSize: 10, lineHeight: 1 }}>⑂</span>
                  <span>fork</span>
                </button>
                {/* Subagent split-pill — always rendered (reserves height so toggling
                    sub-flags doesn't push КОНТРОЛЬ down).
                    Left half "sub-": click toggles whole subagent off / on (defaults to result).
                                       hover greys the whole pill (preview of "click → off").
                    Right half "result" | "full": click switches between result-only and full-history.
                                       hover swaps the label so user sees what click would change to.
                    State logic: off (both false) | result (result=true) | full (history=true, result=false). */}
                {dot}
                {(() => {
                  const subOn = includeSubagentResult || includeSubagentHistory;
                  const isFull = includeSubagentHistory;
                  // Each half is independent. Left ("sub-") toggles ON/OFF in the
                  // preferred mode. Right ("result"/"full") swaps the mode — even when
                  // subagents are OFF: it changes the preferred future-mode without
                  // turning anything on (deterministic — click does only one thing).
                  // When ON, displayed label tracks the real flag; when OFF, it tracks
                  // subPreferred so the user can pre-select before flipping the left half.
                  const sideColor = subOn ? ON : OFF;
                  const rightLabel = subOn ? (isFull ? 'full' : 'result') : subPreferred;
                  return (
                    <span
                      className="inline-flex items-center select-none"
                      style={{
                        fontSize: 9.5,
                        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                        lineHeight: 1.2,
                      }}
                    >
                      <button
                        onClick={() => {
                          if (subOn) {
                            // Turn both off — preferred mode is remembered for next time.
                            setCopyIncludeSubagentResult(false);
                            setCopyIncludeSubagentHistory(false);
                          } else {
                            // Turn ON in whichever mode the right-half currently shows.
                            if (subPreferred === 'full') {
                              setCopyIncludeSubagentHistory(true);
                              setCopyIncludeSubagentResult(false);
                            } else {
                              setCopyIncludeSubagentResult(true);
                              setCopyIncludeSubagentHistory(false);
                            }
                          }
                        }}
                        className="cursor-pointer hover:opacity-80 transition-opacity"
                        style={{
                          background: 'transparent', border: 'none', padding: 0,
                          color: sideColor,
                          fontSize: 9.5,
                          fontFamily: 'inherit',
                          lineHeight: 1.2,
                        }}
                      >sub-</button>
                      <button
                        onClick={() => {
                          // Deterministic: this half ONLY swaps mode. Never turns
                          // subagents on/off — that's the left half's job.
                          if (!subOn) {
                            // Swap the displayed (preferred) mode; flags stay false.
                            setSubPreferred(subPreferred === 'result' ? 'full' : 'result');
                          } else if (isFull) {
                            setCopyIncludeSubagentHistory(false);
                            setCopyIncludeSubagentResult(true);
                            setSubPreferred('result');
                          } else {
                            setCopyIncludeSubagentResult(false);
                            setCopyIncludeSubagentHistory(true);
                            setSubPreferred('full');
                          }
                        }}
                        className="cursor-pointer hover:opacity-80 transition-opacity"
                        style={{
                          background: 'transparent', border: 'none', padding: 0,
                          color: sideColor,
                          fontSize: 9.5,
                          fontFamily: 'inherit',
                          lineHeight: 1.2,
                        }}
                      >{rightLabel}</button>
                    </span>
                  );
                })()}
              </div>
            );
          })()}
          </>
        ) : (activeCommandType === 'claude' || activeCommandType === 'gemini') ? (
          <div className="bg-[#2a2a2a] border border-[#3a3a3a] rounded p-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-600 animate-glow-yellow shadow-[0_0_8px_rgba(217,119,6,0.4)]"></span>
                <span className="text-white/70 font-bold text-[10px] tracking-widest uppercase">WAITING FOR SESSION...</span>
              </div>
              <button className="text-[10px] text-[#666] hover:text-[#aaa] cursor-pointer" onClick={() => { if (activeTabId) { setTabCommandType(activeTabId, 'generic'); setActiveCommandType(null); } }}>✕</button>
            </div>
          </div>
        ) : (
          <div className="bg-[#2a2a2a] border border-[#3a3a3a] rounded p-2">
            {/* No-session state — same chip triplet as the КОМАНДЫ row below, kept
                visually consistent. The "Нет активной сессии" text label was redundant
                with the grey dot — removed. Chips sit left so they fall in the natural
                scan path; clicking spawns the corresponding session into this tab. */}
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#666] flex-shrink-0" />
              {activeTabId && (
                <div className="flex">
                  <code
                    className="text-xs cursor-pointer hover:underline px-1.5 py-0.5 bg-[#1a1a1a] rounded-l"
                    style={{ color: '#DA7756' }}
                    onClick={() => {
                      if (!activeTabId) { showToast('Нет активного таба', 'error'); return; }
                      const effectiveDefault = claudeDefaultPromptEnabled ? claudeDefaultPrompt : '';
                      const finalPrompt = [effectiveDefault, claudeExtraPrompt].filter(Boolean).join('\n\n');
                      setTabCommandType(activeTabId, 'claude');
                      ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude', prompt: finalPrompt || undefined });
                    }}
                  >claude</code>
                  <code
                    className="text-xs cursor-pointer hover:underline px-1.5 py-0.5 bg-[#1a1a1a] border-l border-[#333]"
                    style={{ color: '#DA7756' }}
                    onClick={() => {
                      if (!activeTabId) { showToast('Нет активного таба', 'error'); return; }
                      const { convertToSDKTab } = useWorkspaceStore.getState();
                      convertToSDKTab(activeTabId);
                    }}
                  >sdk</code>
                  <code
                    className="text-xs cursor-pointer hover:underline px-1.5 py-0.5 bg-[#1a1a1a] rounded-r border-l border-[#333]"
                    style={{ color: '#4E86F8' }}
                    onClick={() => {
                      if (!activeTabId) { showToast('Нет активного таба', 'error'); return; }
                      setTabCommandType(activeTabId, 'gemini');
                      ipcRenderer.send('gemini:spawn-with-watcher', { tabId: activeTabId, cwd: getCurrentCwd(), yesMode: true });
                    }}
                  >gemini</code>
                </div>
              )}
              {/* Default-prompt sticker — replaces the old "Default" pill + "С промптом"
                  caption. Visible only when a default prompt is configured AND enabled.
                  Sparkle icon hints "this Claude run is seeded with a stored prompt";
                  Cmd-hover surfaces the full prompt text via Tooltip. */}
              {claudeDefaultPrompt && claudeDefaultPromptEnabled && (
                <span
                  className="inline-flex items-center justify-center rounded select-none"
                  style={{
                    color: '#DA7756',
                    width: 18,
                    height: 18,
                    backgroundColor: 'rgba(218,119,86,0.12)',
                    cursor: 'help',
                    lineHeight: 1,
                  }}
                >
                  <ClaudeSparkle size={11} color="#DA7756" />
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {(hasClaudeSession || isSDKTab) && (
        // Standalone divider — zero-height <hr> with border-top, sits between sections.
        // mb-2 above + this rule (0px) + mt-2 below on PROVIDER = 16px total, line in the middle.
        <hr className="border-0 border-t border-[#2a2a2a] my-0" />
      )}
      {(hasClaudeSession || isSDKTab) && activeTabId && (
        // mt-2 (8px) = bottom half of the 16px gap to the AI SESSION block above.
        // No internal padding — the divider <hr> handles spacing externally.
        <div className="mb-4 mt-2">
          {/* Header row: "PROVIDER" label left, provider pills right (PTY tabs only).
              Pills carry brand icon + brand color when active. Layout collapses the
              old standalone "Provider" row inside Контроль into the header itself —
              one row, denser, brand-tinted instead of generic blue. */}
          <div className="flex items-center justify-between mb-2 gap-2">
            <span className="text-[11px] uppercase text-[#888]">PROVIDER</span>
            {!isSDKTab && (
              <div className="flex items-center gap-1">
                {PROVIDER_CATALOG.map((p) => {
                  const isActive = providerState.type === p.id;
                  const onClick = async () => {
                    if (isControlBusy || isActive) return;
                    setIsControlBusy(true);
                    try {
                      if (p.id === 'anthropic') {
                        const result = await ipcRenderer.invoke('provider:switch', { tabId: activeTabId, type: 'anthropic' });
                        setProviderState(result);
                      } else {
                        const remembered = providerMemoryRef.current[p.id] || PROVIDER_CATALOG.find(c => c.id === p.id)?.models[0]?.id;
                        const result = await ipcRenderer.invoke('provider:switch', { tabId: activeTabId, type: p.id, model: remembered });
                        setProviderState(result);
                      }
                    } finally { setIsControlBusy(false); }
                  };
                  return (
                    <button
                      key={p.id}
                      onClick={onClick}
                      disabled={isControlBusy}
                      className={`inline-flex items-center gap-1 rounded ${isControlBusy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                      style={{
                        height: 18,
                        padding: '0 6px',
                        fontSize: 10,
                        fontWeight: isActive ? 500 : 400,
                        color: isActive ? p.tint : '#888',
                        backgroundColor: isActive ? `${p.tint}1F` : 'transparent',
                        border: `1px solid ${isActive ? `${p.tint}66` : 'rgba(255,255,255,0.08)'}`,
                        transition: 'background-color 0.12s, color 0.12s, border-color 0.12s',
                      }}
                    >
                      <p.Icon size={11} color={isActive ? p.tint : '#888'} />
                      <span>{p.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="space-y-2">
            {/* SDK tab: keep legacy single Model row (no provider switching) */}
            {isSDKTab && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[#666] w-12 flex-shrink-0">Model</span>
              <div className="flex gap-1 flex-1">
                {(['default', 'sonnet', 'opus', 'haiku'] as const).map((model) => {
                  const state = useWorkspaceStore.getState();
                  let sdkModel = 'default';
                  for (const [, ws] of state.openProjects) { const t = ws.tabs.get(activeTabId); if (t) { sdkModel = t.sdkModel || 'default'; break; } }
                  const isActive = sdkModel === model;
                  return (
                    <button
                      key={model}
                      className={`flex-1 text-[10px] px-1.5 py-1 rounded cursor-pointer ${isActive ? 'bg-[#DA7756] text-white font-medium' : 'bg-[#2d2d2d] text-[#888] hover:text-white hover:bg-[#3d3d3d]'}`}
                      onClick={() => {
                        const { updateSDKState } = useWorkspaceStore.getState();
                        updateSDKState(activeTabId, { sdkModel: model });
                        setThinkFlash(model); setTimeout(() => setThinkFlash(null), 1500);
                      }}
                    >{model}</button>
                  );
                })}
              </div>
            </div>
            )}

            {/* PTY tab: two-tier Provider → Model selector */}
            {!isSDKTab && (() => {
              const activeProvider = PROVIDER_CATALOG.find(p => p.id === providerState.type) || PROVIDER_CATALOG[0];
              const lm = claudeModel?.toLowerCase() || '';
              const isModelActive = (mid: string): boolean => {
                if (activeProvider.id === 'anthropic') {
                  // Anthropic model active state derives from live bridge data, not local state
                  return mid === 'default' ? lm.includes('1m context')
                    : mid === 'opus' ? (lm.includes('opus') && !lm.includes('1m context'))
                    : lm.includes(mid);
                }
                return providerState.model === mid;
              };
              // switchProvider was inlined into the PROVIDER header pills above —
              // each pill builds its own onClick with the right `p` in closure.
              const switchModel = async (mid: string, isCmd: boolean) => {
                if (isControlBusy) return;
                if (activeProvider.id === 'anthropic' && isCmd) {
                  // Anthropic: send /model command into live Claude TUI
                  setIsControlBusy(true);
                  try { await ipcRenderer.invoke('claude:send-command', activeTabId, '/model ' + mid); }
                  finally { setIsControlBusy(false); focusActiveTerminal(activeTabId); }
                } else if (activeProvider.id !== 'anthropic') {
                  // Zen/DeepSeek: update proxy model field and remember choice
                  setIsControlBusy(true);
                  providerMemoryRef.current[activeProvider.id] = mid;
                  try {
                    const result = await ipcRenderer.invoke('provider:switch', { tabId: activeTabId, type: activeProvider.id, model: mid });
                    setProviderState(result);
                  } finally { setIsControlBusy(false); focusActiveTerminal(activeTabId); }
                }
              };
              return (
                <>
                  {/* Provider row moved into PROVIDER header above. switchProvider closure
                      kept (still used? no — header has its own inline onClick). Below is
                      Model row only. */}
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-[#666] w-12 flex-shrink-0">Model</span>
                    <div className="flex gap-1 flex-1">
                      {activeProvider.models.map((m) => {
                        const isActive = isModelActive(m.id);
                        return (
                          <button
                            key={m.id}
                            className={`flex-1 text-[10px] px-1.5 py-1 rounded ${isControlBusy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${isActive ? 'bg-[#DA7756] text-white font-medium' : 'bg-[#2d2d2d] text-[#888] hover:text-white hover:bg-[#3d3d3d]'}`}
                            disabled={isControlBusy}
                            onClick={() => switchModel(m.id, !!m.cmd)}
                          >{m.label}</button>
                        );
                      })}
                    </div>
                  </div>
                </>
              );
            })()}
            {/* Effort and Think apply to Anthropic (via Claude TUI /effort and meta+t) AND DeepSeek (via proxy body injection).
                Zen has no documented analog → dim only for Zen.
                DeepSeek special: API rejects thinking.disabled + output_config.effort together, so we merge Think into Effort
                row as a single 4-state selector: [off][low][medium][high]. The separate Think row is hidden for DeepSeek. */}
            {(() => {
              const isAnthropic = isSDKTab || providerState.type === 'anthropic';
              const isDeepSeek = !isSDKTab && providerState.type === 'deepseek';
              const supportsKnobs = isAnthropic || isDeepSeek;
              const dimClass = supportsKnobs ? '' : 'opacity-40 pointer-events-none';
              const titleSuffix = supportsKnobs ? '' : ' (not supported by ' + providerState.type + ')';
              // DeepSeek levels: 'off' means thinking disabled. low/medium/high enable thinking with corresponding effort.
              // Anthropic: canonical list from constants/claudeLevels.ts (low/medium/high/xhigh/max as of May 2026).
              const effortLevels = isDeepSeek ? DEEPSEEK_EFFORT_LEVELS : CLAUDE_EFFORT_LEVELS;
              // Effort active-state: for DeepSeek derived from providerState.effort (server-confirmed); for Anthropic read local tab map.
              const dsEffort = (providerState as { effort?: string }).effort || 'medium';
              return (
              <>
                <div className={`flex items-center gap-1 ${dimClass}`}>
                  <span className="text-[10px] text-[#666] w-12 flex-shrink-0">Effort</span>
                  <div className="flex gap-1 flex-1">
                    {effortLevels.map((level) => {
                      let isActive: boolean;
                      if (isSDKTab) {
                        const state = useWorkspaceStore.getState();
                        let sdkEffort = 'high';
                        for (const [, ws] of state.openProjects) { const t = ws.tabs.get(activeTabId); if (t) { sdkEffort = t.sdkEffort || 'high'; break; } }
                        isActive = sdkEffort === level;
                      } else if (isDeepSeek) {
                        isActive = dsEffort === level;
                      } else {
                        const currentEffort = activeTabId ? effortLevel[activeTabId] : undefined;
                        isActive = currentEffort === level;
                      }
                      return (
                        <button
                          key={level}
                          className={`flex-1 text-[10px] px-1.5 py-1 rounded cursor-pointer ${isActive ? 'bg-[#DA7756]/20 text-white font-medium' : 'bg-[#2d2d2d] text-[#888] hover:text-white hover:bg-[#3d3d3d]'}`}
                          onClick={async () => {
                            // Toggle-off: clicking the currently active level deselects.
                            // For Anthropic this means the lowest level ('low') — Claude no longer
                            // supports 'auto' since May 2026. For DeepSeek the explicit 'off' state.
                            const targetLevel = isActive
                              ? (isDeepSeek ? 'off' : CLAUDE_EFFORT_TOGGLE_OFF)
                              : level;
                            if (isSDKTab) {
                              const { updateSDKState } = useWorkspaceStore.getState();
                              updateSDKState(activeTabId, { sdkEffort: targetLevel });
                              setEffortLevel(prev => ({ ...prev, [activeTabId]: targetLevel }));
                              focusActiveTerminal(activeTabId);
                            } else if (isDeepSeek) {
                              if (isControlBusy) return;
                              setIsControlBusy(true);
                              try {
                                const result = await ipcRenderer.invoke('provider:set-options', { tabId: activeTabId, effort: targetLevel });
                                setProviderState(result);
                              } finally { setIsControlBusy(false); focusActiveTerminal(activeTabId); }
                            } else {
                              if (isControlBusy) return;
                              setIsControlBusy(true);
                              if (activeTabId) setEffortLevel(prev => ({ ...prev, [activeTabId]: targetLevel }));
                              try { await ipcRenderer.invoke('claude:send-command', activeTabId, '/effort ' + targetLevel); }
                              finally { setIsControlBusy(false); focusActiveTerminal(activeTabId); }
                            }
                          }}
                        >
                          {level === 'medium' ? 'med' : level === 'xhigh' ? 'xhi' : level}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {/* DeepSeek: Think is folded into Effort row (off ↔ low/medium/high). Hide separate row. */}
                {!isDeepSeek && (() => {
                  // Think active-state: undefined ⇒ ON (Claude starts with alwaysThinkingEnabled by default).
                  // First click flips to OFF. Reset back to undefined on Claude exit (OSC 133 D handler above).
                  let isThinkActive: boolean;
                  if (isSDKTab) {
                    const state = useWorkspaceStore.getState();
                    let sdkThinking = true;
                    for (const [, ws] of state.openProjects) { const t = ws.tabs.get(activeTabId); if (t) { sdkThinking = t.sdkThinking !== false; break; } }
                    isThinkActive = sdkThinking;
                  } else {
                    isThinkActive = activeTabId ? (thinkActive[activeTabId] ?? true) : true;
                  }
                  return (
                <div className={`flex items-center gap-1 ${dimClass}`}>
                  <span className="text-[10px] text-[#666] w-12 flex-shrink-0">Think</span>
                  <div className="flex gap-1 flex-1">
                    <button
                      className={`flex-1 text-[10px] px-1.5 py-1 rounded ${isControlBusy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${isThinkActive ? 'bg-[#DA7756]/20 text-white font-medium' : 'bg-[#2d2d2d] text-[#888] hover:text-white hover:bg-[#3d3d3d]'}`}
                      disabled={isControlBusy}
                      onClick={async () => {
                        if (isSDKTab) {
                          const state = useWorkspaceStore.getState();
                          let currentThinking = true;
                          for (const [, ws] of state.openProjects) { const t = ws.tabs.get(activeTabId); if (t) { currentThinking = t.sdkThinking !== false; break; } }
                          const { updateSDKState } = useWorkspaceStore.getState();
                          updateSDKState(activeTabId, { sdkThinking: !currentThinking });
                          focusActiveTerminal(activeTabId);
                        } else {
                          if (isControlBusy) return;
                          setIsControlBusy(true);
                          const next = !isThinkActive;
                          if (activeTabId) setThinkActive(prev => ({ ...prev, [activeTabId]: next }));
                          try {
                            const result = await ipcRenderer.invoke('claude:toggle-thinking', activeTabId);
                            if (result?.success && typeof result.thinking === 'boolean' && activeTabId) {
                              setThinkActive(prev => ({ ...prev, [activeTabId]: result.thinking }));
                            }
                          } finally { setIsControlBusy(false); focusActiveTerminal(activeTabId); }
                        }
                      }}
                    >
                      Think
                    </button>
                    <button
                      className={`flex-1 text-[10px] px-1.5 py-1 rounded ${isControlBusy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} bg-[#2d2d2d] text-[#888] hover:text-white hover:bg-[#3d3d3d]`}
                      disabled={isControlBusy}
                      onClick={async () => {
                        if (isSDKTab) {
                          // SDK tab has no /compact analog; ignore.
                          focusActiveTerminal(activeTabId);
                          return;
                        }
                        if (isControlBusy) return;
                        setIsControlBusy(true);
                        try { await ipcRenderer.invoke('claude:send-command', activeTabId, '/compact'); }
                        finally { setIsControlBusy(false); focusActiveTerminal(activeTabId); }
                      }}
                    >
                      Compact
                    </button>
                  </div>
                </div>
                  );
                })()}
              </>
              );
            })()}
            {contextPct > 0 && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-[#666] w-12 flex-shrink-0">Ctx</span>
                <div className="flex-1 h-1.5 bg-[#2d2d2d] rounded overflow-hidden">
                  <div className="h-full rounded" style={{ width: contextPct + '%', backgroundColor: contextPct > 80 ? '#ef4444' : contextPct > 50 ? '#f59e0b' : '#4ade80' }} />
                </div>
                <span className={`text-[10px] ${contextPct > 80 ? 'text-red-400' : contextPct > 50 ? 'text-yellow-400' : 'text-[#666]'}`}>{contextPct}%</span>
              </div>
            )}
          </div>
        </div>
      )}

      {hasGeminiSession && activeTabId && (
        <div className="mb-4">
          {/* Gemini section doesn't have provider switching (no proxy paths) —
              just renames Контроль → PROVIDER for consistency with Claude section above. */}
          <div className="text-[11px] uppercase text-[#888] mb-2">PROVIDER</div>
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[#666] w-12 flex-shrink-0">Model</span>
              <div className="flex gap-1 flex-1">
                {(['pro', 'flash'] as const).map((model) => (
                  <button
                    key={model}
                    className="flex-1 text-[10px] px-1.5 py-1 rounded cursor-pointer bg-[#2d2d2d] text-[#888] hover:text-white hover:bg-[#3d3d3d]"
                    onClick={() => {
                      ipcRenderer.send('gemini:send-command', activeTabId, '/model set ' + model);
                    }}
                  >
                    {model}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Clipboard-fork card — always visible (when no session yet). Sits between
          AI SESSION and КОМАНДЫ; provides quick claude-f / sdk-f / gemini-f buttons
          that pull a UUID from the clipboard. Not part of the collapsible КОМАНДЫ
          section because it's the most-used path to spawn a forked session. */}
      {!hasAnySession && (
        <div className="mb-3">
          <div className="bg-[#2d2d2d] rounded p-2">
            <div className="flex items-center justify-between">
              <div className="flex">
                <code
                  className="text-xs cursor-pointer hover:underline px-1.5 py-0.5 bg-[#1a1a1a] rounded-l"
                  style={{ color: '#DA7756' }}
                  onClick={async () => {
                    if (!activeTabId) { showToast('Нет активного таба', 'error'); return; }
                    try {
                      const clipboardText = await navigator.clipboard.readText();
                      const match = clipboardText.match(UUID_EXTRACT_REGEX);
                      if (match) { setTabCommandType(activeTabId, 'claude'); ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude-f', forkSessionId: match[0] }); }
                      else showToast('В буфере нет UUID', 'warning');
                    } catch (err) { showToast('Не удалось прочитать буфер', 'error'); }
                  }}
                  onContextMenu={async (e) => {
                    e.preventDefault();
                    if (!activeTabId) { showToast('Нет активного таба', 'error'); return; }
                    try {
                      const clipboardText = await navigator.clipboard.readText();
                      const match = clipboardText.match(UUID_EXTRACT_REGEX);
                      const targetSessionId = match ? match[0] : null;
                      if (!targetSessionId) { showToast('В буфере нет UUID', 'warning'); return; }
                      const state = useWorkspaceStore.getState();
                      for (const [projectId, workspace] of state.openProjects) {
                        const tab = workspace.tabs.get(activeTabId);
                        if (tab) {
                          const currentCwd = tab.cwd || project?.path || '';
                          const forkResult = await ipcRenderer.invoke('claude:fork-session-file', { sourceSessionId: targetSessionId, cwd: currentCwd, skipChainResolve: true });
                          if (!forkResult.success) { showToast('Fork failed: ' + forkResult.error, 'error'); return; }
                          const sdkTabId = await state.createSDKTab(projectId);
                          console.warn('[InfoPanel:SDK-Fork] created sdkTabId=' + sdkTabId + ' forked ' + targetSessionId.slice(0, 8) + ' → ' + forkResult.newSessionId.slice(0, 8));
                          state.updateSDKState(sdkTabId, { claudeSessionId: forkResult.newSessionId });
                          showToast('SDK fork ← ' + targetSessionId.slice(0, 8), 'success');
                          break;
                        }
                      }
                    } catch (err) { showToast('Ошибка: ' + (err as Error).message, 'error'); }
                  }}
                >claude-f</code>
                <code
                  className="text-xs cursor-pointer hover:underline px-1.5 py-0.5 bg-[#1a1a1a] border-l border-[#333]"
                  style={{ color: '#DA7756' }}
                  onClick={async () => {
                    if (!activeTabId) { showToast('Нет активного таба', 'error'); return; }
                    try {
                      const clipboardText = await navigator.clipboard.readText();
                      const match = clipboardText.match(UUID_EXTRACT_REGEX);
                      const targetSessionId = match ? match[0] : null;
                      if (!targetSessionId) { showToast('В буфере нет UUID', 'warning'); return; }
                      const state = useWorkspaceStore.getState();
                      for (const [projectId, workspace] of state.openProjects) {
                        const tab = workspace.tabs.get(activeTabId);
                        if (tab) {
                          const currentCwd = tab.cwd || project?.path || '';
                          const forkResult = await ipcRenderer.invoke('claude:fork-session-file', { sourceSessionId: targetSessionId, cwd: currentCwd, skipChainResolve: true });
                          if (!forkResult.success) { showToast('Fork failed: ' + forkResult.error, 'error'); return; }
                          const sdkTabId = await state.createSDKTab(projectId);
                          state.updateSDKState(sdkTabId, { claudeSessionId: forkResult.newSessionId });
                          showToast('SDK fork ← ' + targetSessionId.slice(0, 8), 'success');
                          break;
                        }
                      }
                    } catch (err) { showToast('Ошибка: ' + (err as Error).message, 'error'); }
                  }}
                >sdk-f</code>
                <code
                  className="text-xs cursor-pointer hover:underline px-1.5 py-0.5 bg-[#1a1a1a] rounded-r border-l border-[#333]"
                  style={{ color: '#4E86F8' }}
                  onClick={async () => {
                    if (!activeTabId) { showToast('Нет активного таба', 'error'); return; }
                    try {
                      const clipboardText = await navigator.clipboard.readText();
                      const match = clipboardText.match(UUID_EXTRACT_REGEX);
                      if (match) {
                        const state = useWorkspaceStore.getState();
                        for (const [projectId, workspace] of state.openProjects) {
                          const tab = workspace.tabs.get(activeTabId);
                          if (tab) {
                            const currentCwd = tab.cwd || project?.path || '';
                            await state.createTabAfterCurrent(projectId, undefined, currentCwd, { pendingAction: { type: 'gemini-fork', sessionId: match[0] } });
                            showToast('Fork Gemini → новая вкладка', 'success');
                            break;
                          }
                        }
                      } else showToast('В буфере нет UUID', 'warning');
                    } catch (err) { showToast('Не удалось прочитать буфер', 'error'); }
                  }}
                >gemini-f</code>
              </div>
              <span className="text-[10px] text-[#666]">clipboard</span>
            </div>
            <p className="text-[10px] text-[#666] mt-1">Fork из буфера</p>
          </div>
        </div>
      )}

      {/* КОМАНДЫ — collapsible. Holds the Update Docs / Update API → Haiku pipeline
          (rendered by ActionsPanel). Default collapsed since these are rare actions. */}
      <div className="mb-4">
        <button
          type="button"
          onClick={() => setCommandsExpanded((v) => !v)}
          className="flex items-center w-full text-left cursor-pointer mb-2 select-none"
          style={{ background: 'transparent', border: 'none', padding: 0, color: '#888' }}
        >
          {commandsExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <span className="text-[11px] uppercase ml-1">Команды</span>
        </button>
        {commandsExpanded && (
          <ActionsPanel activeTabId={activeTabId} embedded />
        )}
      </div>

      {hasGeminiSession && historyTurns.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2 cursor-pointer" onClick={() => setHistoryExpanded(!historyExpanded)}>
            <div className="flex items-center gap-1"><Clock size={12} className="text-[#4E86F8]" /><span className="text-[11px] uppercase text-[#888]">Time Machine</span><span className="text-[10px] text-[#4E86F8]">({historyTurns.length})</span></div>
            <span className="text-[10px] text-[#666]">{historyExpanded ? '▼' : '▶'}</span>
          </div>
          {historyExpanded && (
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {historyTurns.map((turn, idx) => (
                <div key={turn.file} className={`group flex items-start gap-2 p-2 rounded ${idx === historyTurns.length - 1 ? 'bg-[#1a2a3a] border border-[#2a4a6a]' : 'bg-[#252525] hover:bg-[#2d2d2d]'}`}>
                  <span className="text-[10px] text-[#4E86F8] font-mono w-4 flex-shrink-0">{turn.turnNumber}</span>
                  <div className="flex-1 min-w-0"><p className="text-[10px] text-[#aaa] truncate">{turn.preview}</p><p className="text-[9px] text-[#555]">{new Date(turn.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</p></div>
                  {idx < historyTurns.length - 1 && (
                    <button onClick={(e) => { e.stopPropagation(); handleRollback(turn.turnNumber); }} disabled={isRollingBack} className="opacity-0 group-hover:opacity-100 p-1 rounded text-[#666] hover:text-[#4E86F8] hover:bg-[#333] disabled:opacity-50"><RotateCcw size={12} /></button>
                  )}
                  {idx === historyTurns.length - 1 && <span className="text-[9px] text-green-500">текущее</span>}
                </div>
              ))}
            </div>
          )}
          {!historyExpanded && <p className="text-[10px] text-[#555] italic">Кликните чтобы показать историю</p>}
        </div>
      )}

      </div>

      {/* Заметки вкладки — fixed 250px panel pinned to the bottom. Height bounded
          so it never eats the upper sections; scroll inside the editor handles
          longer notes. min-h-0 + h-[250px] avoid flexbox content-min-size bugs. */}
      <div className="flex flex-col h-[250px] flex-shrink-0 border-t border-border-main pt-3 mt-auto">
        {/* Весь header-блок кликабельный: hover/click на любой свободной области (label, spacer)
            триггерит то же что и сама кнопка Open. ✦ (generate description) — отдельная кнопка
            со своим click handler'ом, `e.stopPropagation()` не пропускает её клик в контейнер.
            Открытие slideout'а — `setNotesPanelOpen(tabId, !isOpen)` через useUIStore. */}
        <div
          className={`flex items-center gap-2 mb-2 ${activeTabId ? 'cursor-pointer' : ''}`}
          data-tab-notes-open-trigger
          onMouseEnter={() => activeTabId && setNotesHeaderHover(true)}
          onMouseLeave={() => activeTabId && setNotesHeaderHover(false)}
          onClick={(e) => {
            if (!activeTabId) return;
            const target = e.target as HTMLElement;
            if (target.closest('[data-notes-header-interactive]')) return;
            const isOpen = useUIStore.getState().notesPanelOpenTabs[activeTabId] ?? false;
            useUIStore.getState().setNotesPanelOpen(activeTabId, !isOpen);
          }}
        >
          {/* "← Open" — визуальный индикатор: цвет привязан к hover-state контейнера,
              click обрабатывает контейнер. Permanent purple-tinted bg сохранён для
              визуальной связи со slideout'ом. */}
          {activeTabId && (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors pointer-events-none"
              style={{
                backgroundColor: notesHeaderHover ? '#2a2a3e' : '#1e1e2e',
                color: notesHeaderHover ? '#c7d2fe' : '#a5b4fc',
                border: '1px solid rgba(99,102,241,0.25)',
              }}
            >
              <ChevronLeft size={11} />
              <span>Open</span>
            </span>
          )}
          <span className="text-[11px] uppercase text-[#888]">Заметки вкладки</span>
          {activeTabId && (
            <button
              data-notes-header-interactive
              className={`text-[10px] px-1.5 py-0.5 rounded cursor-pointer ${isGeneratingDesc ? 'text-white bg-amber-600 animate-glow-yellow font-bold' : 'text-[#666] hover:text-[#f59e0b] hover:bg-[#f59e0b]/10'}`}
              onClick={(e) => { e.stopPropagation(); handleGenerateDescription(); }}
              disabled={isGeneratingDesc}
            >{isGeneratingDesc ? 'GENERATING...' : '\u2726'}</button>
          )}
          <div className="flex-1" />
        </div>
        {activeTabId ? (
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0 }}>
              <MarkdownEditor content={tabNotes} onChange={(newContent: string) => { console.warn('[InfoPanel:notes:onChange]', { tabId: activeTabId?.slice(-12), newLen: newContent.length }); setTabNotes(newContent); if (activeTabId) setTabNotesStore(activeTabId, newContent); }} onGenerateTitle={generateAITitle} fontSize={tabNotesFontSize} contentPaddingX={tabNotesPaddingX} contentPaddingY={tabNotesPaddingY} wordWrap={wordWrap} showLineNumbers={false} compact foldStateKey={`tab-notes:${activeTabId}`} />
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: '11px', fontStyle: 'italic' }}>Выберите вкладку...</div>
        )}
      </div>
    </div>
  );
}
