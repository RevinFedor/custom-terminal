import React, { useState, useEffect, useRef } from 'react';
import { MarkdownEditor } from '@anthropic/markdown-editor';
import '@anthropic/markdown-editor/styles.css';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';
import { useUIStore } from '../../../store/useUIStore';
import { usePromptsStore } from '../../../store/usePromptsStore';
import { RotateCcw, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import ActionsPanel from './ActionsPanel';

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

type AIMode = 'claude' | 'gemini';

export default function InfoPanel({ activeTabId, project }: InfoPanelProps) {
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [geminiSessionId, setGeminiSessionId] = useState<string | null>(null);
  const [activeCommandType, setActiveCommandType] = useState<string | null>(null);
  const [aiMode, setAiMode] = useState<AIMode>('claude');
  const [showTooltip, setShowTooltip] = useState(false);
  const [historyTurns, setHistoryTurns] = useState<HistoryTurn[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [claudeExpanded, setClaudeExpanded] = useState(false);
  const [claudeExtraPrompt, setClaudeExtraPrompt] = useState('');
  const [claudeDefaultPrompt, setClaudeDefaultPrompt] = useState('');
  const [tabNotes, setTabNotes] = useState('');
  const [sessionCopied, setSessionCopied] = useState(false);
  const [isGeneratingDesc, setIsGeneratingDesc] = useState(false);
  const [thinkFlash, setThinkFlash] = useState<string | null>(null);
  const bridgeCacheRef = useRef<Map<string, { model: string; contextPct: number }>>(new Map());
  const cached = activeTabId ? bridgeCacheRef.current.get(activeTabId) : undefined;
  const [claudeModel, setClaudeModel] = useState<string | null>(cached?.model ?? null);
  const [contextPct, setContextPct] = useState(cached?.contextPct ?? 0);
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  const [showSessionInput, setShowSessionInput] = useState(false);
  const [manualSessionId, setManualSessionId] = useState('');
  const sessionInputRef = useRef<HTMLInputElement>(null);
  const { showToast, claudeDefaultPromptEnabled } = useUIStore();
  const { getPromptById } = usePromptsStore();
  const wordWrap = useUIStore((s) => s.wordWrap);
  const tabNotesFontSize = useUIStore((s) => s.tabNotesFontSize);
  const tabNotesPaddingX = useUIStore((s) => s.tabNotesPaddingX);
  const tabNotesPaddingY = useUIStore((s) => s.tabNotesPaddingY);
  const { setTabCommandType, closeTab, setTabNotes: setTabNotesStore, getTabNotes } = useWorkspaceStore();
  const claudeTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (activeTabId) setTabNotes(getTabNotes(activeTabId));
    else setTabNotes('');
  }, [activeTabId, getTabNotes]);

  useEffect(() => {
    ipcRenderer.invoke('app:getState', 'claudeDefaultPrompt').then((value: string | null) => {
      setClaudeDefaultPrompt(value || '');
    });
  }, []);

  useEffect(() => {
    setShowSessionInput(false);
    setManualSessionId('');
    const c = activeTabId ? bridgeCacheRef.current.get(activeTabId) : undefined;
    setClaudeModel(c?.model ?? null);
    setContextPct(c?.contextPct ?? 0);
  }, [activeTabId]);

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

  useEffect(() => {
    const checkSession = () => {
      if (!activeTabId) {
        setClaudeSessionId(null);
        setGeminiSessionId(null);
        setActiveCommandType(null);
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
          return;
        }
      }
      setClaudeSessionId(null);
      setGeminiSessionId(null);
      setActiveCommandType(null);
    };
    checkSession();
    const interval = setInterval(checkSession, 500);
    return () => clearInterval(interval);
  }, [activeTabId]);

  const hasClaudeSession = !!claudeSessionId;
  const hasGeminiSession = !!geminiSessionId;
  const hasAnySession = hasClaudeSession || hasGeminiSession;
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
        sessionId: targetSessionId, cwd: tabCwd, includeCode: false, fromStart: true
      });
      if (!exportResult.success) throw new Error(exportResult.error || 'Export failed');
      const descPrompt = getPromptById('description');
      const descContent = descPrompt?.content || 'Describe this session in 1-2 sentences.';
      const descModel = descPrompt?.model || 'gemini-3-flash-preview';
      const descThinking = descPrompt?.thinkingLevel || 'NONE';
      const fullPrompt = descContent + exportResult.content;
      const apiKey = process.env.GEMINI_API_KEY || 'REDACTED_GEMINI_KEY';
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

  const handleApplyManualSession = () => {
    if (!activeTabId || !manualSessionId.trim()) return;
    const uuidMatch = manualSessionId.trim().match(UUID_EXTRACT_REGEX);
    if (!uuidMatch) { showToast('Invalid UUID format', 'warning'); return; }
    const newId = uuidMatch[0];
    if (newId === sessionId) {
      showToast('Already current session', 'warning');
      setShowSessionInput(false);
      setManualSessionId('');
      return;
    }
    useWorkspaceStore.getState().setClaudeSessionId(activeTabId, newId);
    showToast('Session set: ' + newId.substring(0, 8) + '...', 'success');
    setShowSessionInput(false);
    setManualSessionId('');
  };

  return (
    <div className="h-full flex flex-col p-3">
      {/* Upper sections — scrollable independently */}
      <div className="overflow-y-auto min-h-0 shrink">
      <div className="mb-4">
        <div className="text-[11px] uppercase text-[#888] mb-2">AI Session</div>
        {hasAnySession ? (
          <div className={`rounded p-2 ${currentSessionType === 'claude' ? 'bg-[#2a3a2a] border border-[#3a5a3a]' : 'bg-[#1a2a3a] border border-[#2a4a6a]'}`}>
            <div className="flex items-center gap-2 mb-1">
              <span
                className="cursor-pointer flex-shrink-0 leading-none"
                style={{ color: sessionCopied ? '#4ade80' : '#888', fontSize: '14px' }}
                onClick={() => {
                  if (sessionId) {
                    navigator.clipboard.writeText(sessionId);
                    setSessionCopied(true);
                    setTimeout(() => setSessionCopied(false), 1000);
                  }
                }}
                title="Copy session ID"
              >
                {sessionCopied ? '✓' : '⎘'}
              </span>
              <span className={`text-xs font-medium ${currentSessionType === 'claude' ? 'text-[#DA7756]' : 'text-[#4E86F8]'}`}>
                {currentSessionType === 'claude' ? 'Claude' : 'Gemini'}
              </span>
              {hasClaudeSession && activeTabId && !isCommandRunning && (
                <button
                  className="text-[10px] px-2 py-0.5 rounded cursor-pointer bg-[#DA7756]/15 text-[#DA7756] hover:bg-[#DA7756]/25"
                  onClick={() => {
                    if (activeTabId) {
                      setTabCommandType(activeTabId, 'claude');
                      ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude-c', sessionId: claudeSessionId });
                    }
                  }}
                  title="Продолжить сессию (claude --resume)"
                >
                  Продолжить
                </button>
              )}
              <div className="flex-1" />
              {activeTabId && (
                <button
                  className={`text-[10px] px-1.5 py-0.5 rounded cursor-pointer ${
                    showSessionInput ? 'text-[#aaa] bg-[#ffffff10]' : 'text-[#444] hover:text-[#aaa] hover:bg-[#ffffff08]'
                  }`}
                  onClick={() => {
                    setShowSessionInput(!showSessionInput);
                    setManualSessionId('');
                    if (!showSessionInput) setTimeout(() => sessionInputRef.current?.focus(), 50);
                  }}
                  title="Replace session ID"
                >
                  ✎
                </button>
              )}
            </div>
            <code className="text-[10px] text-[#aaa] break-all block">{sessionId}</code>

            {showSessionInput && (
              <div className="mt-2" style={{ animation: 'fadeIn 0.15s ease-out' }}>
                <input
                  ref={sessionInputRef}
                  type="text"
                  value={manualSessionId}
                  onChange={(e) => setManualSessionId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); handleApplyManualSession(); }
                    else if (e.key === 'Escape') { setShowSessionInput(false); setManualSessionId(''); }
                  }}
                  placeholder="Paste session UUID..."
                  className="w-full px-2 py-1 bg-[#1a1a1a] border border-[#444] rounded text-[10px] text-[#aaa] font-mono focus:outline-none focus:border-[#DA7756] placeholder:text-[#555]"
                />
                <div className="flex gap-2 mt-1.5">
                  <button className="flex-1 text-[10px] px-2 py-1 rounded bg-[#DA7756]/20 text-[#DA7756] hover:bg-[#DA7756]/30 cursor-pointer disabled:opacity-40" onClick={handleApplyManualSession} disabled={!manualSessionId.trim()}>Replace</button>
                  <button className="flex-1 text-[10px] px-2 py-1 rounded bg-[#333] text-[#888] hover:bg-[#444] cursor-pointer" onClick={() => { setShowSessionInput(false); setManualSessionId(''); }}>Отмена</button>
                </div>
              </div>
            )}

            <button
              className="mt-2 w-full text-[10px] px-2 py-1 rounded text-[#888] hover:text-white bg-[#333] hover:bg-[#444] cursor-pointer"
              onClick={async () => {
                if (!sessionId || !activeTabId || !currentSessionType) return;
                const state = useWorkspaceStore.getState();
                for (const [projectId, workspace] of state.openProjects) {
                  const tab = workspace.tabs.get(activeTabId);
                  if (tab) {
                    const currentCwd = tab.cwd || project?.path || '';
                    await state.createTabAfterCurrent(projectId, undefined, currentCwd, {
                      pendingAction: { type: currentSessionType === 'claude' ? 'claude-fork' : 'gemini-fork', sessionId: sessionId }
                    });
                    showToast(`Fork ${currentSessionType === 'claude' ? 'Claude' : 'Gemini'} → новая вкладка`, 'success');
                    break;
                  }
                }
              }}
              title="Fork session to new tab"
            >
              ⑂ Fork в новую вкладку
            </button>
          </div>
        ) : (activeCommandType === 'claude' || activeCommandType === 'gemini') ? (
          <div className="bg-[#2a2a2a] border border-[#3a3a3a] rounded p-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span>
                <span className="text-yellow-500/80 text-xs">Ожидание сессии...</span>
              </div>
              <button className="text-[10px] text-[#666] hover:text-[#aaa] cursor-pointer" onClick={() => { if (activeTabId) { setTabCommandType(activeTabId, 'generic'); setActiveCommandType(null); } }} title="Отменить ожидание">✕</button>
            </div>
          </div>
        ) : (
          <div className="bg-[#2a2a2a] border border-[#3a3a3a] rounded p-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#666]"></span>
                <span className="text-[#888] text-xs">Нет активной сессии</span>
              </div>
              {activeTabId && (
                <button className={`text-[10px] cursor-pointer ${showSessionInput ? 'text-[#aaa]' : 'text-[#555] hover:text-[#aaa]'}`} onClick={() => { setShowSessionInput(!showSessionInput); setManualSessionId(''); if (!showSessionInput) setTimeout(() => sessionInputRef.current?.focus(), 50); }}>Set ID</button>
              )}
            </div>
            {showSessionInput && activeTabId && (
              <div className="mt-2" style={{ animation: 'fadeIn 0.15s ease-out' }}>
                <input
                  ref={sessionInputRef} type="text" value={manualSessionId} onChange={(e) => setManualSessionId(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleApplyManualSession(); } else if (e.key === 'Escape') { setShowSessionInput(false); setManualSessionId(''); } }}
                  placeholder="Paste session UUID..."
                  className="w-full px-2 py-1 bg-[#1a1a1a] border border-[#444] rounded text-[10px] text-[#aaa] font-mono focus:outline-none focus:border-[#DA7756] placeholder:text-[#555]"
                />
                <button className="mt-1.5 w-full text-[10px] px-2 py-1 rounded bg-[#DA7756]/20 text-[#DA7756] hover:bg-[#DA7756]/30 cursor-pointer disabled:opacity-40" onClick={handleApplyManualSession} disabled={!manualSessionId.trim()}>Set session</button>
              </div>
            )}
          </div>
        )}
      </div>

      {hasClaudeSession && activeTabId && (
        <div className="mb-4">
          <div className="text-[11px] uppercase text-[#888] mb-2">Контроль</div>
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[#666] w-12 flex-shrink-0">Model</span>
              <div className="flex gap-1 flex-1">
                {(['sonnet', 'opus', 'haiku'] as const).map((model) => {
                  const isActive = claudeModel?.toLowerCase().includes(model);
                  return (
                    <button
                      key={model}
                      className={`flex-1 text-[10px] px-1.5 py-1 rounded cursor-pointer ${isActive ? 'bg-[#DA7756] text-white font-medium' : 'bg-[#2d2d2d] text-[#888] hover:text-white hover:bg-[#3d3d3d]'}`}
                      onClick={() => ipcRenderer.send('claude:send-command', activeTabId, '/model ' + model)}
                      title={'Switch to ' + model}
                    >
                      {model}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[#666] w-12 flex-shrink-0">Think</span>
              <button
                className={`flex-1 text-[10px] px-1.5 py-1 rounded cursor-pointer bg-[#2d2d2d] ${thinkFlash ? 'text-[#b4b9f9]' : 'text-[#888] hover:text-white hover:bg-[#3d3d3d]'}`}
                onClick={async () => {
                  const result = await ipcRenderer.invoke('claude:toggle-thinking', activeTabId);
                  if (result.success) { setThinkFlash(result.thinking ? 'think on' : 'think off'); setTimeout(() => setThinkFlash(null), 3000); }
                }}
                title="Toggle thinking mode (meta+t)"
              >
                {thinkFlash || 'toggle'}
              </button>
            </div>
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

      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1">
            <span className="text-[11px] uppercase text-[#888]">Команды</span>
            <div className="relative">
              <span className="text-[10px] text-[#555] cursor-help hover:text-[#888]" onMouseEnter={() => setShowTooltip(true)} onMouseLeave={() => setShowTooltip(false)}>?</span>
              {showTooltip && (
                <div className="absolute left-0 top-4 z-50 p-2 bg-[#1a1a1a] border border-[#333] rounded text-[10px] text-[#aaa] shadow-lg whitespace-nowrap">
                  <div className="mb-1"><b style={{color:'#DA7756'}}>-c</b> — продолжить сессию по ID этого таба</div>
                  <div><b style={{color:'#4E86F8'}}>-f</b> — создать ФОРК (копию) с новым ID</div>
                </div>
              )}
            </div>
          </div>
          {hasAnySession ? (
            <span className="text-[9px] font-medium px-2 h-4 rounded-full flex items-center" style={{ backgroundColor: currentSessionType === 'claude' ? '#DA7756' : '#4E86F8', color: 'white' }}>{currentSessionType === 'claude' ? 'Claude' : 'Gemini'}</span>
          ) : (
            <div className="flex items-center h-4 bg-[#1a1a1a] rounded-full p-0.5">
              <button onClick={() => setAiMode('claude')} className={`px-2 h-3 rounded-full text-[9px] font-medium leading-none flex items-center ${aiMode === 'claude' ? 'bg-[#DA7756] text-white' : 'text-[#666] hover:text-[#999]'}`}>Claude</button>
              <button onClick={() => setAiMode('gemini')} className={`px-2 h-3 rounded-full text-[9px] font-medium leading-none flex items-center ${aiMode === 'gemini' ? 'bg-[#4E86F8] text-white' : 'text-[#666] hover:text-[#999]'}`}>Gemini</button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          {(hasAnySession ? currentSessionType === 'claude' : aiMode === 'claude') ? (
            <>
              {!hasAnySession && (
                <div className="rounded p-2 bg-[#2d2d2d]">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setClaudeExpanded(!claudeExpanded); if (!claudeExpanded) setTimeout(() => claudeTextareaRef.current?.focus(), 50); }} className="p-0.5 rounded text-[#666] hover:text-[#DA7756] hover:bg-[#333]">{claudeExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
                      <code className="text-xs hover:underline cursor-pointer" style={{ color: '#DA7756' }} onClick={() => { if (!activeTabId) { showToast('Нет активного таба', 'error'); return; } const effectiveDefault = claudeDefaultPromptEnabled ? claudeDefaultPrompt : ''; const finalPrompt = [effectiveDefault, claudeExtraPrompt].filter(Boolean).join('\n\n'); setTabCommandType(activeTabId, 'claude'); ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude', prompt: finalPrompt || undefined }); setClaudeExpanded(false); setClaudeExtraPrompt(''); }}>claude</code>
                    </div>
                    <div className="flex items-center gap-2">
                      {claudeDefaultPrompt && claudeDefaultPromptEnabled && (
                        <div className="relative group">
                          <span className="text-[9px] px-1.5 py-0.5 bg-[#DA7756]/20 text-[#DA7756] rounded cursor-default">Default</span>
                          <div className="absolute right-0 top-full mt-1 z-50 hidden group-hover:block"><div className="p-2 bg-[#1a1a1a] border border-[#444] rounded shadow-lg max-w-[200px] text-[10px] text-[#888] font-mono whitespace-pre-wrap">{claudeDefaultPrompt}</div></div>
                        </div>
                      )}
                      <span className="text-[10px] text-green-400">готово</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-[#666] mt-1">{claudeDefaultPrompt && claudeDefaultPromptEnabled ? 'С промптом' : 'Новая сессия'}</p>
                  {claudeExpanded && (
                    <div className="mt-2 pt-2 border-t border-[#333]">
                      <textarea ref={claudeTextareaRef} value={claudeExtraPrompt} onChange={(e) => setClaudeExtraPrompt(e.target.value)} placeholder="Дополнительный текст..." className="w-full min-h-[40px] p-2 bg-[#1a1a1a] border border-[#333] rounded text-[11px] text-[#888] font-mono resize-none focus:outline-none focus:border-[#DA7756] placeholder:text-[#555]" onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); if (!activeTabId) return; const effectiveDefault = claudeDefaultPromptEnabled ? claudeDefaultPrompt : ''; const finalPrompt = [effectiveDefault, claudeExtraPrompt].filter(Boolean).join('\n\n'); setTabCommandType(activeTabId, 'claude'); ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude', prompt: finalPrompt || undefined }); setClaudeExpanded(false); setClaudeExtraPrompt(''); } }} />
                    </div>
                  )}
                </div>
              )}
              {!hasAnySession && (
                <div className="bg-[#2d2d2d] rounded p-2">
                  <div className="flex items-center justify-between">
                    <code
                      className="text-xs cursor-pointer hover:underline" style={{ color: '#DA7756' }}
                      onClick={async () => {
                        if (!activeTabId) { showToast('Нет активного таба', 'error'); return; }
                        try {
                          const clipboardText = await navigator.clipboard.readText();
                          const match = clipboardText.match(UUID_EXTRACT_REGEX);
                          if (match) { const extractedUuid = match[0]; setTabCommandType(activeTabId, 'claude'); ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude-f', forkSessionId: extractedUuid }); }
                          else showToast('В буфере нет UUID', 'warning');
                        } catch (err) { showToast('Не удалось прочитать буфер', 'error'); }
                      }}
                      title="Fork по UUID из буфера"
                    >claude-f</code>
                    <span className="text-[10px] text-[#666]">clipboard</span>
                  </div>
                  <p className="text-[10px] text-[#666] mt-1">Fork из буфера</p>
                </div>
              )}
            </>
          ) : (
            <>
              {!hasAnySession && (
                <div className="rounded p-2 bg-[#2d2d2d]">
                  <div className="flex items-center justify-between">
                    <code className="text-xs hover:underline cursor-pointer" style={{ color: '#4E86F8' }} onClick={() => { if (!activeTabId) { showToast('Нет активного таба', 'error'); return; } setTabCommandType(activeTabId, 'gemini'); ipcRenderer.send('gemini:spawn-with-watcher', { tabId: activeTabId, cwd: getCurrentCwd() }); }} title="Новая Gemini сессия">gemini</code>
                    <span className="text-[10px] text-green-400">готово</span>
                  </div>
                  <p className="text-[10px] text-[#666] mt-1">Новая сессия</p>
                </div>
              )}
              <div className={`rounded p-2 ${hasGeminiSession ? 'bg-[#2d2d2d]' : 'bg-[#252525] opacity-60'}`}>
                <div className="flex items-center justify-between">
                  <code className={`text-xs hover:underline ${hasGeminiSession ? 'cursor-pointer' : 'cursor-not-allowed'}`} style={{ color: hasGeminiSession ? '#4E86F8' : '#666' }} onClick={() => { if (!hasGeminiSession) { showToast('Нет Gemini сессии', 'warning'); return; } if (activeTabId) { setTabCommandType(activeTabId, 'gemini'); ipcRenderer.send('gemini:run-command', { tabId: activeTabId, command: 'gemini-c', sessionId: geminiSessionId }); } }} title={hasGeminiSession ? 'Продолжить' : 'Нет сессии'}>gemini-c</code>
                  <span className={`text-[10px] ${hasGeminiSession ? 'text-green-400' : 'text-[#666]'}`}>{hasGeminiSession ? 'готово' : '—'}</span>
                </div>
                <p className="text-[10px] text-[#666] mt-1">Продолжить</p>
              </div>
              <div className={`rounded p-2 ${hasGeminiSession ? 'bg-[#2d2d2d]' : 'bg-[#252525] opacity-60'}`}>
                <div className="flex items-center justify-between">
                  <code
                    className={`text-xs hover:underline ${hasGeminiSession ? 'cursor-pointer' : 'cursor-not-allowed'}`} style={{ color: hasGeminiSession ? '#4E86F8' : '#666' }}
                    onClick={async () => {
                      if (!hasGeminiSession || !geminiSessionId) { showToast('Нет Gemini сессии для fork', 'warning'); return; }
                      if (!activeTabId) { showToast('Нет активного таба', 'error'); return; }
                      const state = useWorkspaceStore.getState();
                      for (const [projectId, workspace] of state.openProjects) {
                        const tab = workspace.tabs.get(activeTabId);
                        if (tab) {
                          const currentCwd = tab.cwd || project?.path || '';
                          await state.createTabAfterCurrent(projectId, undefined, currentCwd, { pendingAction: { type: 'gemini-fork', sessionId: geminiSessionId } });
                          showToast('Fork Gemini → новая вкладка', 'success'); break;
                        }
                      }
                    }}
                    title={hasGeminiSession ? 'Fork в новую вкладку' : 'Нет сессии'}
                  >gemini-f</code>
                  <span className={`text-[10px] ${hasGeminiSession ? 'text-green-400' : 'text-[#666]'}`}>{hasGeminiSession ? 'готово' : '—'}</span>
                </div>
                <p className="text-[10px] text-[#666] mt-1">Fork → новая вкладка</p>
              </div>
            </>
          )}
        </div>
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
                  <div className="flex-1 min-w-0"><p className="text-[10px] text-[#aaa] truncate" title={turn.preview}>{turn.preview}</p><p className="text-[9px] text-[#555]">{new Date(turn.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</p></div>
                  {idx < historyTurns.length - 1 && (
                    <button onClick={(e) => { e.stopPropagation(); handleRollback(turn.turnNumber); }} disabled={isRollingBack} className="opacity-0 group-hover:opacity-100 p-1 rounded text-[#666] hover:text-[#4E86F8] hover:bg-[#333] disabled:opacity-50" title={`Откатить до сообщения ${turn.turnNumber}`}><RotateCcw size={12} /></button>
                  )}
                  {idx === historyTurns.length - 1 && <span className="text-[9px] text-green-500">текущее</span>}
                </div>
              ))}
            </div>
          )}
          {!historyExpanded && <p className="text-[10px] text-[#555] italic">Кликните чтобы показать историю</p>}
        </div>
      )}

      <div className="mb-3"><ActionsPanel activeTabId={activeTabId} embedded /></div>
      </div>

      <div className="flex-1 flex flex-col min-h-0 border-t border-border-main pt-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] uppercase text-[#888]">Заметки вкладки</span>
          {activeTabId && (
            <button className={`text-[10px] px-1.5 py-0.5 rounded cursor-pointer ${isGeneratingDesc ? 'text-[#f59e0b] bg-[#f59e0b]/10 animate-pulse' : 'text-[#666] hover:text-[#f59e0b] hover:bg-[#f59e0b]/10'}`} onClick={handleGenerateDescription} disabled={isGeneratingDesc} title="Generate AI description">{isGeneratingDesc ? '...' : '\u2726'}</button>
          )}
        </div>
        {activeTabId ? (
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0 }}>
              <MarkdownEditor content={tabNotes} onChange={(newContent: string) => { setTabNotes(newContent); if (activeTabId) setTabNotesStore(activeTabId, newContent); }} fontSize={tabNotesFontSize} contentPaddingX={tabNotesPaddingX} contentPaddingY={tabNotesPaddingY} wordWrap={wordWrap} showLineNumbers={false} compact foldStateKey={`tab-notes:${activeTabId}`} />
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: '11px', fontStyle: 'italic' }}>Выберите вкладку...</div>
        )}
      </div>
    </div>
  );
}
