import React, { useState, useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';
import { useUIStore } from '../../../store/useUIStore';
import { Maximize2, RotateCcw, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import { log } from '../../../utils/logger';

const { ipcRenderer } = window.require('electron');

interface HistoryTurn {
  turnNumber: number;
  preview: string;
  timestamp: string;
  file: string;
}

// UUID v4 regex pattern
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// Helper to extract notes string from potentially nested object
const extractNotes = (notes: any): string => {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (typeof notes === 'object' && notes.global) return notes.global;
  return '';
};

export default function InfoPanel({ activeTabId, project }: InfoPanelProps) {
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [geminiSessionId, setGeminiSessionId] = useState<string | null>(null);
  const [aiMode, setAiMode] = useState<AIMode>('claude');
  const [notes, setNotes] = useState(extractNotes(project?.notes));
  const [showTooltip, setShowTooltip] = useState(false);
  const [historyTurns, setHistoryTurns] = useState<HistoryTurn[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  // Claude expandable command state
  const [claudeExpanded, setClaudeExpanded] = useState(false);
  const [claudeExtraPrompt, setClaudeExtraPrompt] = useState('');
  const [claudeDefaultPrompt, setClaudeDefaultPrompt] = useState('');
  // Actions export state
  const [actionsExpanded, setActionsExpanded] = useState(false);
  const [exportSessionInput, setExportSessionInput] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const { showToast, openNotesEditor } = useUIStore();
  const { setTabCommandType, closeTab } = useWorkspaceStore();
  const notesTextareaRef = useRef<HTMLTextAreaElement>(null);
  const claudeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const exportTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync notes with project
  useEffect(() => {
    setNotes(extractNotes(project?.notes));
  }, [project?.notes]);

  // Load Claude default prompt from settings
  useEffect(() => {
    ipcRenderer.invoke('app:getState', 'claudeDefaultPrompt').then((value: string | null) => {
      setClaudeDefaultPrompt(value || '');
    });
  }, []);

  // Save notes on blur
  const saveNotesImmediately = async () => {
    if (project?.path && notes !== extractNotes(project?.notes)) {
      await ipcRenderer.invoke('project:save-note', { dirPath: project.path, content: notes });
    }
  };

  // Poll for session ID changes (every 500ms)
  useEffect(() => {
    const checkSession = () => {
      if (!activeTabId) {
        setClaudeSessionId(null);
        setGeminiSessionId(null);
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
          return;
        }
      }
      setClaudeSessionId(null);
      setGeminiSessionId(null);
    };

    checkSession();
    const interval = setInterval(checkSession, 500);
    return () => clearInterval(interval);
  }, [activeTabId]);

  const hasClaudeSession = !!claudeSessionId;
  const hasGeminiSession = !!geminiSessionId;
  // Only ONE session per tab allowed
  const hasAnySession = hasClaudeSession || hasGeminiSession;
  const currentSessionType = hasClaudeSession ? 'claude' : hasGeminiSession ? 'gemini' : null;
  const sessionId = currentSessionType === 'claude' ? claudeSessionId : geminiSessionId;

  // Start/stop Gemini history watcher and load history
  useEffect(() => {
    if (!geminiSessionId || !activeTabId) {
      setHistoryTurns([]);
      return;
    }

    const cwd = getCurrentCwd();
    log.gemini('Starting history watcher for session:', geminiSessionId, 'cwd:', cwd);

    // Start the watcher
    ipcRenderer.send('gemini:start-history-watcher', { sessionId: geminiSessionId, cwd });

    // Load existing history
    const loadHistory = async () => {
      const result = await ipcRenderer.invoke('gemini:get-timemachine', { sessionId: geminiSessionId, cwd });
      if (result.success) {
        setHistoryTurns(result.turns);
      }
    };
    loadHistory();

    // Listen for history updates
    const handleHistoryUpdate = (_: any, { sessionId: updatedSessionId, turnCount }: { sessionId: string; turnCount: number }) => {
      if (updatedSessionId === geminiSessionId) {
        log.gemini('History updated, reloading...', turnCount);
        loadHistory();
      }
    };
    ipcRenderer.on('gemini:history-updated', handleHistoryUpdate);

    return () => {
      ipcRenderer.send('gemini:stop-history-watcher', { sessionId: geminiSessionId });
      ipcRenderer.removeListener('gemini:history-updated', handleHistoryUpdate);
    };
  }, [geminiSessionId, activeTabId]);

  // Rollback to a specific turn
  const handleRollback = async (turnNumber: number) => {
    if (!geminiSessionId || !activeTabId || isRollingBack) return;

    const cwd = getCurrentCwd();
    setIsRollingBack(true);

    try {
      log.gemini('Rolling back to turn:', turnNumber);
      const result = await ipcRenderer.invoke('gemini:rollback', {
        sessionId: geminiSessionId,
        turnNumber,
        cwd,
        tabId: activeTabId
      });

      if (result.success) {
        showToast(`Откат до сообщения ${turnNumber}`, 'success');

        // Create new tab with resume command
        const state = useWorkspaceStore.getState();
        for (const [projectId, workspace] of state.openProjects) {
          const tab = workspace.tabs.get(activeTabId);
          if (tab) {
            // Close current tab and create new one with resume
            await closeTab(projectId, activeTabId);
            await state.createTabAfterCurrent(projectId, undefined, cwd, {
              pendingAction: {
                type: 'gemini-continue',
                sessionId: geminiSessionId
              },
              geminiSessionId: geminiSessionId  // Set immediately to avoid UI flicker
            });
            break;
          }
        }
      } else {
        showToast(`Ошибка отката: ${result.error}`, 'error');
      }
    } catch (e: any) {
      showToast(`Ошибка: ${e.message}`, 'error');
    } finally {
      setIsRollingBack(false);
    }
  };

  // Get current cwd for commands
  const getCurrentCwd = () => {
    if (!activeTabId) return project?.path || '';
    const state = useWorkspaceStore.getState();
    for (const [, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(activeTabId);
      if (tab) return tab.cwd || project?.path || '';
    }
    return project?.path || '';
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto">
      {/* Session Status - shows active session regardless of toggle */}
      <div className="mb-4">
        <div className="text-[11px] uppercase text-[#888] mb-2">AI Session</div>
        {hasAnySession ? (
          <div className={`rounded p-2 ${currentSessionType === 'claude' ? 'bg-[#2a3a2a] border border-[#3a5a3a]' : 'bg-[#1a2a3a] border border-[#2a4a6a]'}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              <span className={`text-xs font-medium ${currentSessionType === 'claude' ? 'text-[#DA7756]' : 'text-[#4E86F8]'}`}>
                {currentSessionType === 'claude' ? 'Claude' : 'Gemini'}
              </span>
            </div>
            <code className="text-[10px] text-[#aaa] break-all block">{sessionId}</code>
            {/* Fork session to new tab button */}
            <button
              className="mt-2 w-full text-[10px] px-2 py-1 rounded transition-colors text-[#888] hover:text-white bg-[#333] hover:bg-[#444] cursor-pointer"
              onClick={async () => {
                if (!sessionId || !activeTabId || !currentSessionType) return;

                const state = useWorkspaceStore.getState();
                for (const [projectId, workspace] of state.openProjects) {
                  const tab = workspace.tabs.get(activeTabId);
                  if (tab) {
                    const currentCwd = tab.cwd || project?.path || '';
                    await state.createTabAfterCurrent(projectId, undefined, currentCwd, {
                      pendingAction: {
                        type: currentSessionType === 'claude' ? 'claude-fork' : 'gemini-fork',
                        sessionId: sessionId
                      }
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
        ) : (
          <div className="bg-[#2a2a2a] border border-[#3a3a3a] rounded p-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#666]"></span>
              <span className="text-[#888] text-xs">Нет активной сессии</span>
            </div>
          </div>
        )}
      </div>

      {/* Commands with Toggle */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1">
            <span className="text-[11px] uppercase text-[#888]">Команды</span>
            <div className="relative">
              <span
                className="text-[10px] text-[#555] cursor-help hover:text-[#888]"
                onMouseEnter={() => setShowTooltip(true)}
                onMouseLeave={() => setShowTooltip(false)}
              >?</span>
              {showTooltip && (
                <div className="absolute left-0 top-4 z-50 p-2 bg-[#1a1a1a] border border-[#333] rounded text-[10px] text-[#aaa] shadow-lg whitespace-nowrap">
                  <div className="mb-1"><b style={{color:'#DA7756'}}>-c</b> — продолжить сессию по ID этого таба</div>
                  <div><b style={{color:'#4E86F8'}}>-f</b> — создать ФОРК (копию) с новым ID</div>
                </div>
              )}
            </div>
          </div>
          {/* Mini Toggle - only show when no session active */}
          {hasAnySession ? (
            // Show active AI label
            <span
              className="text-[9px] font-medium px-2 h-4 rounded-full flex items-center"
              style={{
                backgroundColor: currentSessionType === 'claude' ? '#DA7756' : '#4E86F8',
                color: 'white'
              }}
            >
              {currentSessionType === 'claude' ? 'Claude' : 'Gemini'}
            </span>
          ) : (
            // Show toggle when no session
            <div className="flex items-center h-4 bg-[#1a1a1a] rounded-full p-0.5">
              <button
                onClick={() => setAiMode('claude')}
                className={`px-2 h-3 rounded-full text-[9px] font-medium transition-all leading-none flex items-center ${
                  aiMode === 'claude'
                    ? 'bg-[#DA7756] text-white'
                    : 'text-[#666] hover:text-[#999]'
                }`}
              >
                Claude
              </button>
              <button
                onClick={() => setAiMode('gemini')}
                className={`px-2 h-3 rounded-full text-[9px] font-medium transition-all leading-none flex items-center ${
                  aiMode === 'gemini'
                    ? 'bg-[#4E86F8] text-white'
                    : 'text-[#666] hover:text-[#999]'
                }`}
              >
                Gemini
              </button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          {/* When session active - show commands for that AI; otherwise use toggle state */}
          {(hasAnySession ? currentSessionType === 'claude' : aiMode === 'claude') ? (
            <>
              {/* claude - new session (expandable) */}
              <div className={`rounded p-2 ${hasAnySession ? 'bg-[#252525] opacity-60' : 'bg-[#2d2d2d]'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    {/* Expand/Collapse button */}
                    {!hasAnySession && (
                      <button
                        onClick={() => {
                          setClaudeExpanded(!claudeExpanded);
                          if (!claudeExpanded) {
                            setTimeout(() => claudeTextareaRef.current?.focus(), 50);
                          }
                        }}
                        className="p-0.5 rounded text-[#666] hover:text-[#DA7756] hover:bg-[#333] transition-colors"
                      >
                        {claudeExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                    )}
                    <code
                      className={`text-xs transition-colors hover:underline ${hasAnySession ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                      style={{ color: hasAnySession ? '#666' : '#DA7756' }}
                      onClick={() => {
                        if (!activeTabId) {
                          showToast('Нет активного таба', 'error');
                          return;
                        }
                        if (hasAnySession) {
                          showToast(`Уже есть ${currentSessionType} сессия`, 'warning');
                          return;
                        }
                        const finalPrompt = [claudeDefaultPrompt, claudeExtraPrompt].filter(Boolean).join('\n\n');
                        setTabCommandType(activeTabId, 'claude');
                        ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude', prompt: finalPrompt || undefined });
                        setClaudeExpanded(false);
                        setClaudeExtraPrompt('');
                      }}
                    >
                      claude
                    </code>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Default prompt badge with hover tooltip */}
                    {claudeDefaultPrompt && !hasAnySession && (
                      <div className="relative group">
                        <span className="text-[9px] px-1.5 py-0.5 bg-[#DA7756]/20 text-[#DA7756] rounded cursor-default">
                          Default
                        </span>
                        {/* Instant hover tooltip */}
                        <div className="absolute right-0 top-full mt-1 z-50 hidden group-hover:block">
                          <div className="p-2 bg-[#1a1a1a] border border-[#444] rounded shadow-lg max-w-[200px] text-[10px] text-[#888] font-mono whitespace-pre-wrap">
                            {claudeDefaultPrompt}
                          </div>
                        </div>
                      </div>
                    )}
                    <span className={`text-[10px] ${hasAnySession ? 'text-red-400' : 'text-green-400'}`}>
                      {hasAnySession ? (currentSessionType === 'claude' ? 'активна' : 'занято') : 'готово'}
                    </span>
                  </div>
                </div>
                <p className="text-[10px] text-[#666] mt-1">
                  {claudeDefaultPrompt ? 'С промптом' : 'Новая сессия'}
                </p>

                {/* Expanded area with textarea */}
                {claudeExpanded && !hasAnySession && (
                  <div className="mt-2 pt-2 border-t border-[#333]">
                    <textarea
                      ref={claudeTextareaRef}
                      value={claudeExtraPrompt}
                      onChange={(e) => setClaudeExtraPrompt(e.target.value)}
                      placeholder="Дополнительный текст..."
                      className="w-full min-h-[40px] p-2 bg-[#1a1a1a] border border-[#333] rounded text-[11px] text-[#888] font-mono resize-none focus:outline-none focus:border-[#DA7756] placeholder:text-[#555]"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.metaKey) {
                          e.preventDefault();
                          if (!activeTabId) return;
                          const finalPrompt = [claudeDefaultPrompt, claudeExtraPrompt].filter(Boolean).join('\n\n');
                          setTabCommandType(activeTabId, 'claude');
                          ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude', prompt: finalPrompt || undefined });
                          setClaudeExpanded(false);
                          setClaudeExtraPrompt('');
                        }
                      }}
                    />
                  </div>
                )}
              </div>

              {/* claude-c - continue */}
              <div className={`rounded p-2 ${hasClaudeSession ? 'bg-[#2d2d2d]' : 'bg-[#252525] opacity-60'}`}>
                <div className="flex items-center justify-between">
                  <code
                    className={`text-xs transition-colors hover:underline ${hasClaudeSession ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                    style={{ color: hasClaudeSession ? '#DA7756' : '#666' }}
                    onClick={() => {
                      if (!hasClaudeSession) {
                        showToast('Нет Claude сессии', 'warning');
                        return;
                      }
                      if (activeTabId) {
                        setTabCommandType(activeTabId, 'claude');
                        ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude-c', sessionId: claudeSessionId });
                      }
                    }}
                    title={hasClaudeSession ? 'Продолжить' : 'Нет сессии'}
                  >
                    claude-c
                  </code>
                  <span className={`text-[10px] ${hasClaudeSession ? 'text-green-400' : 'text-[#666]'}`}>
                    {hasClaudeSession ? 'готово' : '—'}
                  </span>
                </div>
                <p className="text-[10px] text-[#666] mt-1">Продолжить</p>
              </div>

              {/* claude-f - fork from clipboard */}
              <div className="bg-[#2d2d2d] rounded p-2">
                <div className="flex items-center justify-between">
                  <code
                    className="text-xs cursor-pointer hover:underline transition-colors"
                    style={{ color: '#DA7756' }}
                    onClick={async () => {
                      if (!activeTabId) {
                        showToast('Нет активного таба', 'error');
                        return;
                      }
                      if (hasAnySession) {
                        showToast(`Уже есть ${currentSessionType} сессия. Откройте новый таб.`, 'warning');
                        return;
                      }
                      try {
                        const clipboardText = await navigator.clipboard.readText();
                        const trimmed = clipboardText.trim();
                        if (UUID_REGEX.test(trimmed)) {
                          setTabCommandType(activeTabId, 'claude');
                          ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude-f', forkSessionId: trimmed });
                        } else {
                          showToast('В буфере нет UUID', 'warning');
                        }
                      } catch (err) {
                        showToast('Не удалось прочитать буфер', 'error');
                      }
                    }}
                    title="Fork по UUID из буфера"
                  >
                    claude-f
                  </code>
                  <span className="text-[10px] text-[#666]">clipboard</span>
                </div>
                <p className="text-[10px] text-[#666] mt-1">Fork из буфера</p>
              </div>
            </>
          ) : (
            <>
              {/* gemini - new session */}
              <div className={`rounded p-2 ${hasAnySession ? 'bg-[#252525] opacity-60' : 'bg-[#2d2d2d]'}`}>
                <div className="flex items-center justify-between">
                  <code
                    className={`text-xs transition-colors hover:underline ${hasAnySession ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    style={{ color: hasAnySession ? '#666' : '#4E86F8' }}
                    onClick={() => {
                      if (!activeTabId) {
                        showToast('Нет активного таба', 'error');
                        return;
                      }
                      if (hasAnySession) {
                        showToast(`Уже есть ${currentSessionType} сессия`, 'warning');
                        return;
                      }
                      log.gemini('Starting new Gemini session from InfoPanel');
                      log.gemini('TabId:', activeTabId, 'CWD:', getCurrentCwd());
                      setTabCommandType(activeTabId, 'gemini');
                      ipcRenderer.send('gemini:spawn-with-watcher', { tabId: activeTabId, cwd: getCurrentCwd() });
                    }}
                    title={hasAnySession ? 'Сессия уже есть' : 'Новая Gemini сессия'}
                  >
                    gemini
                  </code>
                  <span className={`text-[10px] ${hasAnySession ? 'text-red-400' : 'text-green-400'}`}>
                    {hasAnySession ? (currentSessionType === 'gemini' ? 'активна' : 'занято') : 'готово'}
                  </span>
                </div>
                <p className="text-[10px] text-[#666] mt-1">Новая сессия</p>
              </div>

              {/* gemini-c - continue */}
              <div className={`rounded p-2 ${hasGeminiSession ? 'bg-[#2d2d2d]' : 'bg-[#252525] opacity-60'}`}>
                <div className="flex items-center justify-between">
                  <code
                    className={`text-xs transition-colors hover:underline ${hasGeminiSession ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                    style={{ color: hasGeminiSession ? '#4E86F8' : '#666' }}
                    onClick={() => {
                      if (!hasGeminiSession) {
                        showToast('Нет Gemini сессии', 'warning');
                        return;
                      }
                      if (activeTabId) {
                        log.gemini('Continuing Gemini session:', geminiSessionId);
                        setTabCommandType(activeTabId, 'gemini');
                        ipcRenderer.send('gemini:run-command', { tabId: activeTabId, command: 'gemini-c', sessionId: geminiSessionId });
                      }
                    }}
                    title={hasGeminiSession ? 'Продолжить' : 'Нет сессии'}
                  >
                    gemini-c
                  </code>
                  <span className={`text-[10px] ${hasGeminiSession ? 'text-green-400' : 'text-[#666]'}`}>
                    {hasGeminiSession ? 'готово' : '—'}
                  </span>
                </div>
                <p className="text-[10px] text-[#666] mt-1">Продолжить</p>
              </div>

              {/* gemini-f - fork to new tab */}
              <div className={`rounded p-2 ${hasGeminiSession ? 'bg-[#2d2d2d]' : 'bg-[#252525] opacity-60'}`}>
                <div className="flex items-center justify-between">
                  <code
                    className={`text-xs transition-colors hover:underline ${hasGeminiSession ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                    style={{ color: hasGeminiSession ? '#4E86F8' : '#666' }}
                    onClick={async () => {
                      if (!hasGeminiSession || !geminiSessionId) {
                        showToast('Нет Gemini сессии для fork', 'warning');
                        return;
                      }
                      if (!activeTabId) {
                        showToast('Нет активного таба', 'error');
                        return;
                      }

                      log.gemini('Forking Gemini session:', geminiSessionId);
                      const state = useWorkspaceStore.getState();
                      for (const [projectId, workspace] of state.openProjects) {
                        const tab = workspace.tabs.get(activeTabId);
                        if (tab) {
                          const currentCwd = tab.cwd || project?.path || '';
                          await state.createTabAfterCurrent(projectId, undefined, currentCwd, {
                            pendingAction: {
                              type: 'gemini-fork',
                              sessionId: geminiSessionId
                            }
                          });
                          showToast('Fork Gemini → новая вкладка', 'success');
                          break;
                        }
                      }
                    }}
                    title={hasGeminiSession ? 'Fork в новую вкладку' : 'Нет сессии'}
                  >
                    gemini-f
                  </code>
                  <span className={`text-[10px] ${hasGeminiSession ? 'text-green-400' : 'text-[#666]'}`}>
                    {hasGeminiSession ? 'готово' : '—'}
                  </span>
                </div>
                <p className="text-[10px] text-[#666] mt-1">Fork → новая вкладка</p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Gemini Time Machine */}
      {hasGeminiSession && historyTurns.length > 0 && (
        <div className="mb-4">
          <div
            className="flex items-center justify-between mb-2 cursor-pointer"
            onClick={() => setHistoryExpanded(!historyExpanded)}
          >
            <div className="flex items-center gap-1">
              <Clock size={12} className="text-[#4E86F8]" />
              <span className="text-[11px] uppercase text-[#888]">Time Machine</span>
              <span className="text-[10px] text-[#4E86F8]">({historyTurns.length})</span>
            </div>
            <span className="text-[10px] text-[#666]">{historyExpanded ? '▼' : '▶'}</span>
          </div>

          {historyExpanded && (
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {historyTurns.map((turn, idx) => (
                <div
                  key={turn.file}
                  className={`group flex items-start gap-2 p-2 rounded transition-colors ${
                    idx === historyTurns.length - 1
                      ? 'bg-[#1a2a3a] border border-[#2a4a6a]'
                      : 'bg-[#252525] hover:bg-[#2d2d2d]'
                  }`}
                >
                  <span className="text-[10px] text-[#4E86F8] font-mono w-4 flex-shrink-0">
                    {turn.turnNumber}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-[#aaa] truncate" title={turn.preview}>
                      {turn.preview}
                    </p>
                    <p className="text-[9px] text-[#555]">
                      {new Date(turn.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  {idx < historyTurns.length - 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRollback(turn.turnNumber);
                      }}
                      disabled={isRollingBack}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded text-[#666] hover:text-[#4E86F8] hover:bg-[#333] transition-all disabled:opacity-50"
                      title={`Откатить до сообщения ${turn.turnNumber}`}
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                  {idx === historyTurns.length - 1 && (
                    <span className="text-[9px] text-green-500">текущее</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {!historyExpanded && (
            <p className="text-[10px] text-[#555] italic">
              Кликните чтобы показать историю
            </p>
          )}
        </div>
      )}

      {/* Actions - Claude Export */}
      {hasClaudeSession && (
        <div className="mb-4">
          <div
            className="flex items-center justify-between mb-2 cursor-pointer"
            onClick={() => {
              setActionsExpanded(!actionsExpanded);
              if (!actionsExpanded) {
                // Pre-fill with current session ID
                setExportSessionInput(claudeSessionId || '');
                setTimeout(() => exportTextareaRef.current?.focus(), 50);
              }
            }}
          >
            <div className="flex items-center gap-1">
              <span className="text-[11px] uppercase text-[#888]">Actions</span>
            </div>
            <span className="text-[10px] text-[#666]">{actionsExpanded ? '▼' : '▶'}</span>
          </div>

          {actionsExpanded && (
            <div className="space-y-2">
              {/* Copy Session button */}
              <div className="bg-[#2d2d2d] rounded p-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-[#aaa]">Copy Session (без кода)</span>
                  <button
                    onClick={async () => {
                      const targetSessionId = exportSessionInput.trim() || claudeSessionId;
                      if (!targetSessionId) {
                        showToast('Нет session ID', 'warning');
                        return;
                      }

                      setIsExporting(true);
                      try {
                        const cwd = getCurrentCwd();
                        const result = await ipcRenderer.invoke('claude:export-clean-session', {
                          sessionId: targetSessionId,
                          cwd
                        });

                        if (result.success) {
                          await navigator.clipboard.writeText(result.content);
                          showToast(`Скопировано ${Math.round(result.content.length / 1024)}KB`, 'success');
                        } else {
                          showToast(`Ошибка: ${result.error}`, 'error');
                        }
                      } catch (e: any) {
                        showToast(`Ошибка: ${e.message}`, 'error');
                      } finally {
                        setIsExporting(false);
                      }
                    }}
                    disabled={isExporting}
                    className="text-[10px] px-2 py-1 rounded transition-colors bg-[#DA7756]/20 text-[#DA7756] hover:bg-[#DA7756]/30 disabled:opacity-50 cursor-pointer"
                  >
                    {isExporting ? 'Экспорт...' : 'Copy'}
                  </button>
                </div>
                <textarea
                  ref={exportTextareaRef}
                  value={exportSessionInput}
                  onChange={(e) => setExportSessionInput(e.target.value)}
                  placeholder={claudeSessionId || 'Session ID...'}
                  className="w-full min-h-[32px] p-2 bg-[#1a1a1a] border border-[#333] rounded text-[10px] text-[#888] font-mono resize-none focus:outline-none focus:border-[#DA7756] placeholder:text-[#555]"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.metaKey) {
                      e.preventDefault();
                      // Trigger export
                      const btn = e.currentTarget.parentElement?.querySelector('button');
                      btn?.click();
                    }
                  }}
                />
                <p className="text-[9px] text-[#555] mt-1">
                  Оставьте пустым для текущей сессии
                </p>
              </div>
            </div>
          )}

          {!actionsExpanded && (
            <p className="text-[10px] text-[#555] italic">
              Кликните чтобы показать
            </p>
          )}
        </div>
      )}

      {/* Project Notes */}
      <div className="flex-1 flex flex-col min-h-0 border-t border-border-main pt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] uppercase text-[#888]">Заметки проекта</div>
          <button
            onClick={() => project?.id && openNotesEditor(project.id)}
            className="p-1 rounded text-[#666] hover:text-white hover:bg-white/10 transition-colors"
            title="Развернуть редактор (⌘E)"
          >
            <Maximize2 size={12} />
          </button>
        </div>
        <textarea
          ref={notesTextareaRef}
          className="flex-1 min-h-[80px] bg-transparent border border-transparent rounded p-2 text-[11px] text-[#aaa] resize-none focus:outline-none focus:border-accent focus:bg-[#2a2a2a] transition-all duration-200 placeholder:text-[#555] placeholder:italic"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            saveNotesImmediately();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault();
              notesTextareaRef.current?.blur();
            }
          }}
          placeholder="Добавьте заметки по проекту..."
        />
      </div>
    </div>
  );
}
