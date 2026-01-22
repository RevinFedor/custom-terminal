import React, { useState, useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';
import { useUIStore } from '../../../store/useUIStore';

const { ipcRenderer } = window.require('electron');

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

// Helper to extract notes string from potentially nested object
const extractNotes = (notes: any): string => {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  // If notes is object like {global: string, sessions: ...}, use global
  if (typeof notes === 'object' && notes.global) return notes.global;
  return '';
};

export default function InfoPanel({ activeTabId, project }: InfoPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [notes, setNotes] = useState(extractNotes(project?.notes));
  const { showToast } = useUIStore();
  const notesTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync notes with project
  useEffect(() => {
    setNotes(extractNotes(project?.notes));
  }, [project?.notes]);

  // Save notes on blur
  const saveNotesImmediately = async () => {
    if (project?.path && notes !== extractNotes(project?.notes)) {
      await ipcRenderer.invoke('project:save-note', { dirPath: project.path, content: notes });
    }
  };

  // Poll for session ID changes (every 500ms)
  // This avoids store subscription that causes terminal re-render issues
  useEffect(() => {
    const checkSession = () => {
      if (!activeTabId) {
        setSessionId(null);
        return;
      }

      const state = useWorkspaceStore.getState();
      for (const [, workspace] of state.openProjects) {
        const tab = workspace.tabs.get(activeTabId);
        if (tab) {
          const newId = tab.claudeSessionId || null;
          setSessionId(prev => prev !== newId ? newId : prev);
          return;
        }
      }
      setSessionId(null);
    };

    checkSession(); // Initial check
    const interval = setInterval(checkSession, 500);
    return () => clearInterval(interval);
  }, [activeTabId]);

  const hasSession = !!sessionId;

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto">
      {/* Claude Session Status */}
      <div className="mb-4">
        <div className="text-[11px] uppercase text-[#888] mb-2">Claude Session</div>
        {hasSession ? (
          <div className="bg-[#2a3a2a] border border-[#3a5a3a] rounded p-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              <span className="text-green-400 text-xs font-medium">Active</span>
            </div>
            <code className="text-[11px] text-[#aaa] break-all">{sessionId}</code>
            {/* Fork session to new tab button */}
            <button
              className="mt-2 w-full text-[10px] px-2 py-1 rounded transition-colors text-[#888] hover:text-white bg-[#333] hover:bg-[#444] cursor-pointer"
              onClick={async () => {
                if (!sessionId || !activeTabId) return;

                // Get current tab's cwd
                const state = useWorkspaceStore.getState();
                let currentCwd = project?.path || '';
                for (const [projectId, workspace] of state.openProjects) {
                  const tab = workspace.tabs.get(activeTabId);
                  if (tab) {
                    currentCwd = tab.cwd || currentCwd;
                    // Create new tab after current with fork command
                    await state.createTabAfterCurrent(projectId, undefined, currentCwd, {
                      pendingCommand: `claude-f ${sessionId}`
                    });
                    showToast('Создана вкладка с fork сессии', 'success');
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
          <div className="bg-[#3a3a2a] border border-[#5a5a3a] rounded p-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-yellow-500"></span>
              <span className="text-yellow-400 text-xs font-medium">No session</span>
            </div>
            <p className="text-[11px] text-[#888] mt-1">
              Type <code className="text-accent">claude</code> to start
            </p>
          </div>
        )}
      </div>

      {/* Available Commands */}
      <div className="mb-4">
        <div className="text-[11px] uppercase text-[#888] mb-2">Команды</div>
        <div className="space-y-2">
          {/* claude */}
          <div className={`rounded p-2 ${hasSession ? 'bg-[#252525] opacity-60' : 'bg-[#2d2d2d]'}`}>
            <div className="flex items-center justify-between">
              <code className={`text-xs ${hasSession ? 'text-[#666]' : 'text-accent'}`}>claude</code>
              <div className="flex items-center gap-2">
                <button
                  className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                    hasSession
                      ? 'text-[#555] bg-[#2a2a2a] cursor-not-allowed'
                      : 'text-[#888] hover:text-white bg-[#333] hover:bg-[#444] cursor-pointer'
                  }`}
                  disabled={hasSession}
                  onClick={() => {
                    if (!activeTabId) {
                      showToast('Нет активного таба', 'error');
                      return;
                    }
                    if (hasSession) {
                      showToast('Сессия уже есть. Используйте claude-c', 'warning');
                      return;
                    }
                    ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude' });
                  }}
                  title={hasSession ? 'Сессия уже есть' : 'Start new Claude session'}
                >
                  ⑂
                </button>
                <span className={`text-[10px] ${hasSession ? 'text-red-400' : 'text-green-400'}`}>
                  {hasSession ? 'есть сессия' : 'нет сессии'}
                </span>
              </div>
            </div>
            <p className="text-[10px] text-[#888] mt-1">Новая сессия</p>
          </div>

          {/* claude-c */}
          <div className={`rounded p-2 ${hasSession ? 'bg-[#2d2d2d]' : 'bg-[#252525] opacity-60'}`}>
            <div className="flex items-center justify-between">
              <code className={`text-xs ${hasSession ? 'text-accent' : 'text-[#666]'}`}>claude-c</code>
              <div className="flex items-center gap-2">
                <button
                  className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                    hasSession
                      ? 'text-[#888] hover:text-white bg-[#333] hover:bg-[#444] cursor-pointer'
                      : 'text-[#555] bg-[#2a2a2a] cursor-not-allowed'
                  }`}
                  disabled={!hasSession}
                  onClick={() => {
                    if (hasSession && activeTabId) {
                      ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude-c', sessionId });
                    }
                  }}
                  title={hasSession ? 'Continue session' : 'No session'}
                >
                  ⑂
                </button>
                <span className={`text-[10px] ${hasSession ? 'text-green-400' : 'text-red-400'}`}>
                  {hasSession ? 'готово' : 'нет сессии'}
                </span>
              </div>
            </div>
            <p className="text-[10px] text-[#888] mt-1">Продолжить активную сессию</p>
          </div>

          {/* claude-f <ID> */}
          <div className="bg-[#2d2d2d] rounded p-2">
            <div className="flex items-center justify-between">
              <code className="text-accent text-xs">claude-f &lt;ID&gt;</code>
              <div className="flex items-center gap-2">
                <button
                  className="text-[10px] px-1.5 py-0.5 rounded transition-colors text-[#888] hover:text-white bg-[#333] hover:bg-[#444] cursor-pointer"
                  onClick={async () => {
                    if (!activeTabId) {
                      showToast('Нет активного таба', 'error');
                      return;
                    }
                    try {
                      const clipboardText = await navigator.clipboard.readText();
                      const trimmed = clipboardText.trim();
                      if (UUID_REGEX.test(trimmed)) {
                        ipcRenderer.send('claude:run-command', { tabId: activeTabId, command: 'claude-f', forkSessionId: trimmed });
                      } else {
                        showToast('В буфере нет UUID. Скопируйте ID сессии.', 'warning');
                      }
                    } catch (err) {
                      showToast('Не удалось прочитать буфер обмена', 'error');
                    }
                  }}
                  title="Fork session from clipboard UUID"
                >
                  ⑂
                </button>
                <span className="text-green-400 text-[10px]">всегда</span>
              </div>
            </div>
            <p className="text-[10px] text-[#888] mt-1">Форк сессии по UUID</p>
          </div>
        </div>
      </div>

      {/* Project Notes - always editable */}
      <div className="flex-1 flex flex-col min-h-0 border-t border-border-main pt-3">
        <div className="text-[11px] uppercase text-[#888] mb-2">Заметки проекта</div>
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
