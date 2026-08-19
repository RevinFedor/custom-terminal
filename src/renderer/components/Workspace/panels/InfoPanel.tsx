import React, { useState, useEffect, useRef } from 'react';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';
import { useUIStore } from '../../../store/useUIStore';
import { generateAITitle } from '../../../utils/generateAITitle';
import { usePromptsStore } from '../../../store/usePromptsStore';
import { RotateCcw, Clock, ChevronDown, ChevronRight, ChevronLeft } from 'lucide-react';
import CopySessionButton, { ClaudeSparkle } from '../CopySessionButton';
import SessionActionChip from '../SessionActionChip';
import { terminalRegistry } from '../../../utils/terminalRegistry';

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
  // Источник правды: useWorkspaceStore.tabs[id].notes. Раньше тут жил
  // useState-mirror + useEffect(setTabNotes(liveTabNotes), [liveTabNotes]) —
  // одно-кадровый лаг между слайдаутом и InfoPanel плюс stale-чтение
  // mirror'а в handleGenerateDescription могло затирать concurrent правки
  // (см. fix-codemirror-controlled-editor.md и fact-notes.md).
  // Теперь читаем напрямую через reactive selector ниже (liveTabNotes).
  const [sessionCopied, setSessionCopied] = useState(false);
  const [isGeneratingDesc, setIsGeneratingDesc] = useState(false);
  // Hover state шапки «Заметки вкладки» — теперь весь header-блок hover-able и кликабелен,
  // не только сама кнопка Open. Этот флаг управляет визуальным состоянием Open-чипа.
  const [notesHeaderHover, setNotesHeaderHover] = useState(false);
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  const [isControlBusyLocal, setIsControlBusy] = useState(false);
  // isPasteBusy mirrors main's safePasteAndSubmit lifecycle (claude:paste-busy
  // IPC event). When ANY caller (queue runner, MCP, /effort auto-inject, this
  // panel) is mid-paste on the active tab, every control button is disabled.
  // Belt-and-braces on top of the server-side mutex in safePasteAndSubmit:
  // the mutex serializes concurrent writes correctly, but a disabled button
  // gives the user immediate feedback that nothing will happen mid-stream.
  const [isPasteBusy, setIsPasteBusy] = useState(false);
  // Derived busy: local "I'm sending this very click" OR main "someone else is
  // mid-paste right now". Every existing isControlBusy check below picks up
  // both sources automatically.
  const isControlBusy = isControlBusyLocal || isPasteBusy;
  // Return focus to the Claude/Gemini terminal after a control button click.
  // Without this, focus stays on the button — Enter would re-trigger it
  // instead of submitting to the underlying terminal.
  const focusActiveTerminal = (tabId: string | null) => {
    if (!tabId) return;
    requestAnimationFrame(() => terminalRegistry.get(tabId)?.focus());
  };
  const [sessionInputMode, setSessionInputMode] = useState<'claude' | 'gemini' | null>(null);
  const [manualSessionId, setManualSessionId] = useState('');
  const sessionInputRef = useRef<HTMLInputElement>(null);
  const [validationResult, setValidationResult] = useState<{ claude?: { status: string; fullId?: string; preview?: string }; gemini?: { status: string; fullId?: string; preview?: string } } | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const validationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { showToast, claudeDefaultPromptEnabled } = useUIStore();
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
  const tabNotesFontSize = useUIStore((s) => s.notesSidebarFontSize);
  const tabNotesPaddingX = useUIStore((s) => s.notesEditorPaddingX);
  const tabNotesPaddingY = useUIStore((s) => s.notesEditorPaddingY);
  const { setTabCommandType, closeTab, setTabNotes: setTabNotesStore } = useWorkspaceStore();
  const claudeTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Reactive subscription to the live tab.notes. Slide-out + sidebar editor
  // тоже подписаны на это же поле через свои селекторы — все рендерят одну
  // правду, без локальных копий.
  const tabNotes = useWorkspaceStore((s) => {
    if (!activeTabId) return '';
    for (const [, workspace] of s.openProjects) {
      const tab = workspace.tabs.get(activeTabId);
      if (tab) return tab.notes || '';
    }
    return '';
  });

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
    // SDK tabs don't fire terminal:command-* (no PTY). They emit busy state via
    // claude:busy-state (forwarded from claude-sdk:busy-state in main). Subscribe
    // here so SessionActionChip can flip Continue→Stop while the SDK is streaming.
    //
    // CRITICAL: for PTY-backed Claude tabs the truth source is terminal:command-*
    // (the PTY is alive == process is running). claude:busy-state mirrors the
    // spinner-detector / Stop-hook, which flips false in between thinking phases.
    // Wiring `setIsCommandRunning(busy)` for PTY tabs caused the chip to flip to
    // "Continue" between phases — the user sees an idle chip while Claude is
    // still running. So we gate `claude:busy-state` to SDK tabs only.
    const handleBusyState = (_: any, data: { tabId: string; busy: boolean }) => {
      if (data.tabId !== activeTabId) return;
      if (!isSDKTab) return; // PTY tabs derive isCommandRunning from terminal:command-*
      setIsCommandRunning(data.busy);
    };
    const handlePasteBusy = (_: any, data: { tabId: string; busy: boolean }) => {
      if (data.tabId !== activeTabId) return;
      setIsPasteBusy(data.busy);
    };
    ipcRenderer.on('terminal:command-started', handleStarted);
    ipcRenderer.on('terminal:command-finished', handleFinished);
    ipcRenderer.on('claude:busy-state', handleBusyState);
    ipcRenderer.on('claude:paste-busy', handlePasteBusy);
    ipcRenderer.invoke('terminal:getCommandState', {
      tabId: activeTabId,
      caller: 'InfoPanel.activeTabSync',
      expectedProcess: 'codex',
      allowProcessTreeLookup: activeCommandType === 'codex',
    }).then((state: any) => {
      setIsCommandRunning(state?.isRunning || false);
    });
    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleFinished);
      ipcRenderer.removeListener('claude:busy-state', handleBusyState);
      ipcRenderer.removeListener('claude:paste-busy', handlePasteBusy);
      // Tab switch resets paste-busy view; main keeps emitting for the right
      // tabId, the new tab will receive its own state on the next event.
      setIsPasteBusy(false);
    };
  }, [activeTabId, isSDKTab, activeCommandType]);

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
      // Читаем актуальный tab.notes ИЗ STORE на момент завершения await —
      // не из reactive selector (его значение зафризилось в closure на момент
      // клика). Если за время Gemini-запроса слайдаут дописал текст —
      // мы его сохраним, не затрём.
      let currentNotes = '';
      for (const [, workspace] of useWorkspaceStore.getState().openProjects) {
        const tab = workspace.tabs.get(activeTabId);
        if (tab) { currentNotes = tab.notes || ''; break; }
      }
      const lines = currentNotes.split('\n');
      const markedLine = DESC_MARKER + descriptionText;
      if (lines.length > 0 && lines[0].startsWith(DESC_MARKER)) lines[0] = markedLine;
      else lines.unshift(markedLine);
      const newNotes = lines.join('\n');
      setTabNotesStore(activeTabId, newNotes);
      showToast('Description generated', 'success');
    } catch (e: any) { showToast(e.message || 'Failed to generate description', 'error'); }
    finally { setIsGeneratingDesc(false); }
  };

  const handleApplyManualSession = async (mode: 'claude' | 'gemini') => {
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
      showToast(`Gemini session set: ${newId.substring(0, 8)}...`, 'success');
      setSessionInputMode(null);
      setManualSessionId('');
      setValidationResult(null);
      return;
    }

    // Claude: update store + restart PTY process with --resume <newId>.
    // Without restart only the sidebar/Timeline reflect the new session; the running
    // Claude CLI inside the terminal keeps talking to the old session.
    //
    // Cwd-mismatch: `claude --resume <uuid>` rebuilds the project slug from process.cwd()
    // and looks up `~/.claude/projects/<slug>/<uuid>.jsonl`. If the tab's shell sits in
    // a different project than where the session originated, the CLI errors with
    // "No conversation found". Resolve the JSONL's recorded cwd via main and `cd` into
    // it as part of the same command line; the renderer never needs to care which
    // project owns which session.
    console.warn('[InfoPanel:ManualSet] MANUAL session set for tab', activeTabId, ':', newId.substring(0, 8));
    useWorkspaceStore.getState().setClaudeSessionId(activeTabId, newId, 'userManual');
    setSessionInputMode(null);
    setManualSessionId('');
    setValidationResult(null);

    let sessionCwd: string | null = null;
    try {
      const r = await ipcRenderer.invoke('claude:resolve-session-cwd', { sessionId: newId });
      if (r?.success && r.sessionCwd) sessionCwd = r.sessionCwd;
    } catch (e) {
      console.warn('[InfoPanel:ManualSet] resolve-session-cwd failed:', e);
    }

    const runResume = async () => {
      setTabCommandType(activeTabId, 'claude');
      return await ipcRenderer.invoke('claude:run-command', {
        tabId: activeTabId,
        command: 'claude-c',
        sessionId: newId,
        cdTo: sessionCwd || undefined,
      });
    };

    // ALWAYS try to stop first, regardless of the renderer's `isCommandRunning` flag.
    // That flag is a polled snapshot of the store and can lag behind reality — Claude
    // may be running while UI still believes it isn't. If we trust the stale flag and
    // skip the stop, the resume command lands inside Claude's prompt composer instead
    // of the shell, garbling input. The authoritative source is the main process via
    // PS lookup: `terminal:stop-ai-process` returns success=false with
    // `error: 'no AI process found'` when nothing is running, which is the legitimate
    // "no-op" branch — handle it silently and proceed straight to launch.
    try {
      showToast(`Restarting Claude → ${newId.substring(0, 8)}...`, 'info');
      const stopRes = await ipcRenderer.invoke('terminal:stop-ai-process', activeTabId);
      const isNoProcess = !stopRes?.success && /no AI process/i.test(stopRes?.error || '');
      if (!stopRes?.success && !isNoProcess) {
        console.warn('[InfoPanel:ManualSet] stop failed:', stopRes?.error);
        showToast('Stop failed: ' + (stopRes?.error || 'unknown'), 'error');
        return;
      }
      if (stopRes?.success) {
        // SIGTERM acknowledged; let the shell prompt redraw before sending resume.
        await new Promise((r) => setTimeout(r, 150));
      }
      const launchResult = await runResume();
      if (launchResult?.success === false || launchResult?.accepted === false) {
        showToast('Resume failed: ' + (launchResult?.error || launchResult?.reason || 'launch rejected'), 'error');
        return;
      }
      showToast(`Claude resumed: ${newId.substring(0, 8)}...`, 'success');
    } catch (e: any) {
      console.error('[InfoPanel:ManualSet] restart error:', e);
      showToast('Restart error: ' + (e?.message || 'unknown'), 'error');
    }
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
        {hasAnySession ? (
          <></>
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
                    onClick={async () => {
                      if (!activeTabId) { showToast('Нет активного таба', 'error'); return; }
                      const effectiveDefault = claudeDefaultPromptEnabled ? claudeDefaultPrompt : '';
                      const finalPrompt = [effectiveDefault, claudeExtraPrompt].filter(Boolean).join('\n\n');
                      setTabCommandType(activeTabId, 'claude');
                      useWorkspaceStore.getState().markAiLaunchAutoTitle(activeTabId, 'claude');
                      const launchResult = await ipcRenderer.invoke('claude:run-command', { tabId: activeTabId, command: 'claude', prompt: finalPrompt || undefined })
                        .catch((error: any) => ({ success: false, accepted: false, error: error?.message || String(error) }));
                      if (launchResult?.success === false || launchResult?.accepted === false) {
                        showToast('Claude не запущен: ' + (launchResult?.error || launchResult?.reason || 'launch rejected'), 'error');
                      }
                    }}
                  >claude</code>
                  {/* `sdk` — spawns a NEW SDK tab named claude-NN (mirrors the
                      `claude` button next to it). The previous behaviour of
                      converting the *current* generic tab in-place is preserved
                      via Cmd/Ctrl+click as an escape hatch. */}
                  <code
                    className="text-xs cursor-pointer hover:underline px-1.5 py-0.5 bg-[#1a1a1a] border-l border-[#333]"
                    style={{ color: '#FFB382' }}
                    title="Создать новый Claude SDK таб (Cmd/Ctrl+click — конвертировать текущий)"
                    onClick={async (e) => {
                      if (!activeTabId) { showToast('Нет активного таба', 'error'); return; }
                      const state = useWorkspaceStore.getState();
                      if (e.metaKey || e.ctrlKey) {
                        state.convertToSDKTab(activeTabId);
                        return;
                      }
                      for (const [projectId, workspace] of state.openProjects) {
                        if (workspace.tabs.has(activeTabId)) {
                          await state.createSDKTab(projectId);
                          break;
                        }
                      }
                    }}
                  >sdk</code>
                  {/* `sdk-f` — fork CURRENT claude session into a fresh SDK tab.
                      Only meaningful when the active tab has a Claude session;
                      otherwise the button stays muted and is a no-op. */}
                  <code
                    className="text-xs px-1.5 py-0.5 bg-[#1a1a1a] border-l border-[#333]"
                    style={{
                      color: hasClaudeSession ? '#FFB382' : '#555',
                      cursor: hasClaudeSession ? 'pointer' : 'default',
                      textDecoration: 'none',
                    }}
                    title={hasClaudeSession ? 'Форкнуть текущую Claude-сессию в новый SDK-таб' : 'Нет активной Claude-сессии для форка'}
                    onMouseEnter={(e) => { if (hasClaudeSession) (e.currentTarget as HTMLElement).style.textDecoration = 'underline'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = 'none'; }}
                    onClick={async () => {
                      if (!hasClaudeSession || !sessionId || !activeTabId) return;
                      const state = useWorkspaceStore.getState();
                      for (const [projectId, workspace] of state.openProjects) {
                        const tab = workspace.tabs.get(activeTabId);
                        if (!tab) continue;
                        const currentCwd = tab.cwd || project?.path || '';
                        const forkResult = await ipcRenderer.invoke('claude:fork-session-file', {
                          sourceSessionId: sessionId, cwd: currentCwd, skipChainResolve: true,
                        });
                        if (!forkResult.success) {
                          showToast('Fork failed: ' + forkResult.error, 'error');
                          return;
                        }
                        const sdkTabId = await state.createSDKTab(projectId);
                        state.updateSDKState(sdkTabId, { claudeSessionId: forkResult.newSessionId });
                        showToast('SDK fork ← ' + sessionId.slice(0, 8), 'success');
                        break;
                      }
                    }}
                  >sdk-f</code>
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
                      if (match) {
                        setTabCommandType(activeTabId, 'claude');
                        useWorkspaceStore.getState().markAiForkAutoTitle(activeTabId, 'claude', match[0]);
                        const launchResult = await ipcRenderer.invoke('claude:run-command', { tabId: activeTabId, command: 'claude-f', forkSessionId: match[0] });
                        if (launchResult?.success === false || launchResult?.accepted === false) {
                          showToast('Claude fork не запущен: ' + (launchResult?.error || launchResult?.reason || 'launch rejected'), 'error');
                        }
                      }
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

      {/* Заметки вкладки — раньше тут был fixed-250px inline editor.
          Удалён: заметки теперь живут только в TabNotesSlideout (открывается
          по Cmd+E или по клику кнопки заметок в активной вкладке TabSidebar).
          NotesPanel sidebar тоже удалён из Workspace.tsx — правая колонка
          проекта больше не существует. */}
    </div>
  );
}
